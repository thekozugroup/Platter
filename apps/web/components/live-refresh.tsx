'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

/**
 * Keeps server-rendered pages current.
 *
 * The alternative designs both have real costs: polling wastes work and still lags, and holding
 * a parallel client-side copy of every server's state means two sources of truth that drift.
 * Instead this listens to Platter's event stream and calls `router.refresh()`, so the server
 * components stay the single source of truth and simply re-render when something happens.
 *
 * Refreshes are coalesced. A server starting emits several events within a second or two, and
 * one refresh per event would re-render the tree four times for no visible benefit.
 */
export function LiveRefresh({ serverId }: { serverId?: string }) {
  const router = useRouter();
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const url = serverId ? `/api/events?serverId=${encodeURIComponent(serverId)}` : '/api/events';
    let source: EventSource | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    // Backs off on repeated failures so a stopped server does not produce a reconnect storm.
    let attempt = 0;

    const schedule = () => {
      if (pending.current) {
        return;
      }
      pending.current = setTimeout(() => {
        pending.current = undefined;
        router.refresh();
      }, 300);
    };

    const connect = () => {
      if (closed) {
        return;
      }
      source = new EventSource(url);

      source.addEventListener('open', () => {
        attempt = 0;
      });

      source.addEventListener('platter-event', schedule);

      source.addEventListener('error', () => {
        source?.close();
        if (closed) {
          return;
        }
        attempt = Math.min(attempt + 1, 6);
        reconnect = setTimeout(connect, Math.min(30_000, 500 * 2 ** attempt));
      });
    };

    connect();

    return () => {
      closed = true;
      source?.close();
      if (reconnect) {
        clearTimeout(reconnect);
      }
      if (pending.current) {
        clearTimeout(pending.current);
        pending.current = undefined;
      }
    };
  }, [router, serverId]);

  return null;
}
