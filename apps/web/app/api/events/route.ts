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
          const payload = `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          // The client went away mid-write. `cancel` handles cleanup.
        }
      };

      /*
       * Replay what the client missed, oldest first, bounded by *its* position rather than by
       * "the newest N". A laptop that slept for two hours through a crash loop can be hundreds
       * of events behind; handing it the newest hundred would leave a permanent hole in the
       * activity feed that nothing ever reconciles.
       *
       * The replay is still capped — an unbounded catch-up would block the stream — but when it
       * truncates it says so, so the client can refetch rather than quietly showing a gap.
       */
      if (lastEventId) {
        const CAP = 500;
        const missed = listEvents(ctx.db, {
          ...(serverId ? { serverId } : {}),
          after: lastEventId,
          limit: CAP,
        });
        for (const event of missed) {
          send('platter-event', event, event.id);
        }
        if (missed.length === CAP) {
          send('truncated', { after: lastEventId, replayed: CAP });
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
