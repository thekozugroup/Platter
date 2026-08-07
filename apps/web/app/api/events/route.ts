import { listEvents, onEvent, onServerEvent } from '@platter/core';
import type { NextRequest } from 'next/server';
import { getContext } from '@/lib/server';

export const dynamic = 'force-dynamic';
// Node runtime: the event bus is an in-process EventEmitter that the Edge runtime cannot reach.
export const runtime = 'nodejs';

/**
 * Server-sent events for the activity stream.
 *
 * SSE rather than WebSockets: the traffic is entirely one-directional, it survives proxies that
 * mangle upgrades, and `EventSource` reconnects on its own. A WebSocket here would be more
 * machinery for strictly less reliability.
 *
 * Three details that are easy to get wrong and painful to debug:
 *   - `X-Accel-Buffering: no`, or a proxy in front of Platter buffers the stream and the UI sits
 *     frozen until the response finally flushes.
 *   - A heartbeat comment every 25s, or an idle connection gets reaped by an intermediary and
 *     the client silently stops receiving updates while believing it is connected.
 *   - The unsubscribe MUST run on `cancel`. Without it every closed tab leaks an emitter
 *     listener, and after a day of use the process is holding hundreds.
 */
export function GET(request: NextRequest) {
  const serverId = request.nextUrl.searchParams.get('serverId') ?? undefined;
  const lastEventId = request.headers.get('last-event-id') ?? undefined;

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const ctx = await getContext();

      const send = (event: string, data: unknown, id?: string): void => {
        try {
          const payload =
            (id ? `id: ${id}\n` : '') + `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          // The client went away mid-write. `cancel` handles cleanup.
        }
      };

      // Replay anything the client missed while reconnecting, oldest first so the ordering
      // matches a continuous stream. ULIDs sort chronologically, which is what makes this work.
      if (lastEventId) {
        const missed = listEvents(ctx.db, {
          ...(serverId ? { serverId } : {}),
          limit: 100,
        }).filter((event) => event.id > lastEventId);
        for (const event of missed.reverse()) {
          send('platter-event', event, event.id);
        }
      }

      send('ready', { at: Date.now() });

      const listener = (event: Parameters<Parameters<typeof onEvent>[0]>[0]) => {
        send('platter-event', event, event.id);
      };
      unsubscribe = serverId ? onServerEvent(serverId, listener) : onEvent(listener);

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
        } catch {
          // Closed; cleanup happens in `cancel`.
        }
      }, 25_000);
    },

    cancel() {
      unsubscribe?.();
      if (heartbeat) {
        clearInterval(heartbeat);
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
