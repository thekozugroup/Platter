import { getServer, streamLogs } from '@platter/core';
import type { NextRequest } from 'next/server';
import { getContext } from '@/lib/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Live container logs over SSE.
 *
 * The `AbortSignal` wiring is the important part. Docker holds a goroutine open for every
 * followed log stream, so a leaked follow per page load compounds: leave a browser tab cycling
 * through servers for an afternoon and the daemon is holding hundreds of them. `request.signal`
 * fires when the client disconnects, which tears down both the Docker request and this stream.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const tail = Number(request.nextUrl.searchParams.get('tail') ?? '400');

  const ctx = await getContext();
  const server = getServer(ctx.db, id);

  if (!server) {
    return new Response('Server not found', { status: 404 });
  }
  if (!server.containerId) {
    return new Response('Server has no container', { status: 409 });
  }

  const controllerAbort = new AbortController();
  // Next surfaces client disconnects on the request signal; chain them so one abort tears down
  // the Docker stream too.
  request.signal.addEventListener('abort', () => controllerAbort.abort(), { once: true });

  const opened = await streamLogs(ctx.docker, server.containerId, {
    follow: true,
    tail: Number.isFinite(tail) ? Math.min(Math.max(tail, 1), 5000) : 400,
    withTimestamps: true,
    signal: controllerAbort.signal,
  });

  if (!opened.ok) {
    return new Response(opened.error.message, { status: 502 });
  }

  const encoder = new TextEncoder();
  const lines = opened.value;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const line of lines) {
          if (controllerAbort.signal.aborted) {
            break;
          }
          controller.enqueue(
            encoder.encode(`event: line\ndata: ${JSON.stringify(line)}\n\n`)
          );
        }
      } catch {
        // The container stopped or the client vanished. Either way the stream is over.
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
    cancel() {
      controllerAbort.abort();
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
