import { useEffect } from 'react';
import { formatBytes, formatDuration, formatPercent } from '@platter/shared';
import { ConsoleInput } from '@/components/console/console-input';
import { ConsoleView } from '@/components/console/console-view';
import { PageBody } from '@/components/layout/page-header';
import { toast } from '@/components/ui/toast';
import { useServerScope } from './ServerLayout';
import { cn } from '@/lib/utils';

/**
 * The console tab.
 *
 * It owns no connection of its own — the socket lives in `ServerLayout` so every tab shares
 * one — which leaves this screen responsible for exactly three things: showing the output,
 * saying honestly what the connection is doing, and taking a command.
 */

const CONNECTION_COPY: Record<
  string,
  { label: string; detail: string; tone: 'quiet' | 'warning' | 'danger' }
> = {
  connecting: {
    label: 'Connecting',
    detail: 'Opening the console socket.',
    tone: 'quiet',
  },
  authenticating: {
    label: 'Authenticating',
    detail: 'Proving who you are before any output is sent.',
    tone: 'quiet',
  },
  open: {
    label: 'Live',
    detail: 'Output is streaming as the server writes it.',
    tone: 'quiet',
  },
  reconnecting: {
    label: 'Reconnecting',
    detail:
      'The socket dropped. Retrying with a widening backoff — lines written meanwhile are backfilled.',
    tone: 'warning',
  },
  closed: {
    label: 'Disconnected',
    detail: 'The console is closed. Reload the page to open it again.',
    tone: 'danger',
  },
};

export function ConsolePage() {
  const { server, console: live, status } = useServerScope();
  const { notice, dismissNotice } = live;

  /*
   * Socket-level problems ("too many open consoles", "the console did not respond") are not
   * page state — they are events, and they are as relevant on the Files tab as here. A toast
   * says them once and gets out of the way, rather than pinning a banner that survives the
   * condition that caused it.
   */
  useEffect(() => {
    if (!notice) return;
    toast.create({ title: 'Console', description: notice, type: 'warning' });
    dismissNotice();
  }, [notice, dismissNotice]);

  const connection = CONNECTION_COPY[live.connectionState] ?? CONNECTION_COPY.closed;
  const stats = live.stats;

  return (
    <PageBody className="flex min-h-0 flex-1 flex-col gap-4" fullWidth>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <p
          aria-live="polite"
          className="flex items-center gap-2 text-caption text-label-tertiary"
          role="status"
        >
          <span
            aria-hidden
            className={cn(
              'size-2 rounded-full',
              connection?.tone === 'danger'
                ? 'bg-danger-dot'
                : connection?.tone === 'warning'
                  ? 'bg-warning-dot status-pulse'
                  : live.connectionState === 'open'
                    ? 'bg-success-dot status-pulse'
                    : 'bg-neutral-status',
            )}
          />
          <span className="font-medium text-label-secondary">{connection?.label}</span>
          <span className="hidden sm:inline">{connection?.detail}</span>
        </p>

        {/*
          The live numbers, paired in text with the console rather than left to a chart on
          another tab. Tabular figures so a ticking percentage does not jitter the row.
        */}
        {stats ? (
          <dl className="tabular flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-caption text-label-tertiary">
            <div className="flex gap-1.5">
              <dt>CPU</dt>
              <dd className="text-label-secondary">{formatPercent(stats.cpuPercent)}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Memory</dt>
              <dd className="text-label-secondary">
                {formatBytes(stats.memoryBytes)}
                {stats.memoryLimitBytes > 0 ? ` / ${formatBytes(stats.memoryLimitBytes)}` : null}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Uptime</dt>
              <dd className="text-label-secondary">{formatDuration(stats.uptimeSeconds)}</dd>
            </div>
            {stats.playersOnline !== null ? (
              <div className="flex gap-1.5">
                <dt>Players</dt>
                <dd className="text-label-secondary">
                  {stats.playersOnline}
                  {stats.playersMax !== null ? ` / ${stats.playersMax}` : null}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </div>

      <ConsoleView
        className="h-[clamp(20rem,56vh,44rem)]"
        connectionState={live.connectionState}
        lines={live.lines}
        onClear={live.clear}
        serverName={server.name}
      />

      <ConsoleInput
        canWrite={live.canWrite}
        connectionState={live.connectionState}
        onSubmit={live.sendCommand}
        serverId={server.id}
        serverName={server.name}
        serverStatus={status}
      />
    </PageBody>
  );
}
