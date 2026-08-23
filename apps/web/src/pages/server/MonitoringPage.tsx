import { useMemo, useState } from 'react';
import {
  formatBytes,
  formatCpu,
  formatDuration,
  formatPercent,
  formatRelativeTime,
} from '@platter/shared';
import { Clock } from 'pixelarticons/react/Clock.js';
import { Cpu } from 'pixelarticons/react/Cpu.js';
import { Database } from 'pixelarticons/react/Database.js';
import { MemoryStick } from 'pixelarticons/react/MemoryStick.js';
import { SpeedFast } from 'pixelarticons/react/SpeedFast.js';
import { Users } from 'pixelarticons/react/Users.js';
import { PageBody } from '@/components/layout/page-header';
import { LiveMeter } from '@/components/monitoring/live-meter';
import {
  RANGE_MS,
  ResourceChart,
  describeRange,
  type ChartMetric,
  type ChartRange,
} from '@/components/monitoring/resource-chart';
import { StatTile, describeDelta } from '@/components/monitoring/stat-tile';
import { UptimeStrip, buildUptimeBuckets } from '@/components/monitoring/uptime-strip';
import { useMetricSeries, type MetricSeries } from '@/hooks/use-metrics.js';
import {
  useServerHealth,
  type HealthUnavailableReason,
  type ServerHealth,
} from '@/hooks/use-players.js';
import { SECTION_HEADING, useServerScope } from '@/pages/server/ServerLayout';

/**
 * Monitoring: what this server is doing now, and what it has been doing.
 *
 * The page is built around one promise from the design contract — **a chart is never the only
 * representation of its data**. Every reading appears as a number with a unit and a sentence
 * of context before it appears as a shape, so the page is fully usable by a screen reader, in
 * greyscale, and by someone who simply wants to know whether the memory is about to run out.
 *
 * There is no `PageHeader` and no status pill: `ServerLayout` owns the server's name, status,
 * power controls and tabs, and repeating any of that here would read as a bug. Live usage
 * comes from that layout's console socket rather than a poll on `/stats`, so opening this tab
 * costs no extra connection and never shows numbers a few seconds adrift from the header's.
 */

const MB = 1024 * 1024;

const NOT_REPORTING_TPS =
  'This server is not reporting a tick rate. Turn RCON on in Settings and restart it.';
const NOT_RUNNING = 'Available once the server is running.';

const HEALTH_UNAVAILABLE: Record<HealthUnavailableReason, string> = {
  unsupported: 'This game does not report a tick rate.',
  unreadable: 'The server did not answer the tick query.',
  unconfigured: NOT_REPORTING_TPS,
  offline: NOT_RUNNING,
};

/**
 * Why the tile is empty, in a sentence that cannot contradict the status pill above it.
 *
 * The API collapses every RCON problem it cannot name into `offline`, so taking that reason
 * at face value tells a server that is visibly running to start itself. The live status is
 * the tiebreak: if it is up, the problem is RCON, not power.
 */
function tickRateUnavailable(health: ServerHealth | undefined, isRunning: boolean): string {
  const reason = health?.unavailable;
  if (reason && reason !== 'offline') return HEALTH_UNAVAILABLE[reason] ?? NOT_REPORTING_TPS;
  return isRunning ? NOT_REPORTING_TPS : NOT_RUNNING;
}

/** Sample values out of a series response, oldest first, for a sparkline. */
function historyOf(response: MetricSeries | undefined): number[] {
  return (response?.points ?? []).map((point) => point.avg);
}

function latestOf(response: MetricSeries | undefined): number | null {
  const points = response?.points ?? [];
  const last = points[points.length - 1];
  return last ? last.avg : null;
}

export function MonitoringPage() {
  const { server, status, console: consoleState } = useServerScope();
  const serverId = server.id;
  const [metric, setMetric] = useState<ChartMetric>('cpu');
  const [range, setRange] = useState<ChartRange>('6h');

  const isRunning = status === 'running';
  // Live usage arrives on the layout's console socket. Polling `/stats` alongside it would
  // be a second source of the same numbers, drifting a few seconds apart.
  const stats = consoleState.stats;

  const health = useServerHealth(serverId, { refetchInterval: isRunning ? 15_000 : false });

  // The sparklines all read the last hour, which is what "recently" means on this page.
  const refetchInterval = isRunning ? 30_000 : (false as const);
  const cpuHour = useMetricSeries(serverId, 'cpu', { range: '1h', refetchInterval });
  const memoryHour = useMetricSeries(serverId, 'memory', { range: '1h', refetchInterval });
  const diskHour = useMetricSeries(serverId, 'disk', { range: '1h', refetchInterval });
  const playersHour = useMetricSeries(serverId, 'players', { range: '1h', refetchInterval });

  /*
   * The availability strip reads the CPU series over the selected range. CPU is only sampled
   * while a server is `running`, so the presence of a sample is a genuine record that it was
   * up — and the absence of one is genuinely ambiguous, which `UptimeStrip` says out loud.
   * When the chart is already showing CPU at this range the two share a cache entry.
   */
  const cpuRange = useMetricSeries(serverId, 'cpu', { range, refetchInterval });

  const uptimeBuckets = useMemo(() => {
    const to = cpuRange.data ? Date.parse(cpuRange.data.to) : Date.now();
    const from = cpuRange.data ? Date.parse(cpuRange.data.from) : to - RANGE_MS[range];
    return buildUptimeBuckets({
      timestamps: (cpuRange.data?.points ?? []).map((point) => Date.parse(point.timestamp)),
      from,
      to,
      segments: 48,
      crashedAt: server.lastCrashAt ? Date.parse(server.lastCrashAt) : null,
    });
  }, [cpuRange.data, range, server.lastCrashAt]);

  const limits = server.limits;
  const memoryLimitBytes = stats?.memoryLimitBytes ?? limits.memoryMb * MB;
  const diskLimitBytes = limits.diskMb * MB;
  const diskBytes = stats?.diskBytes ?? latestOf(diskHour.data);
  const diskPending = diskHour.isPending && stats === null;

  const offlineNote = isRunning
    ? null
    : 'Live readings are taken only while the server is running. Everything below comes from earlier samples.';

  return (
    <PageBody>
      <div className="flex flex-col gap-12 lg:gap-16">
        {/* ---------------------------------------------------------------- Right now */}
        <section aria-labelledby="monitoring-now" className="flex flex-col gap-5">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className={SECTION_HEADING} id="monitoring-now">
              Right now
            </h2>
            <p aria-live="polite" className="text-caption text-label-tertiary" role="status">
              {stats
                ? `Sampled ${formatRelativeTime(stats.sampledAt)}`
                : isRunning
                  ? 'Waiting for the first sample'
                  : 'Not being sampled'}
            </p>
          </div>

          {offlineNote ? (
            <p className="rounded-md border border-separator-strong bg-bg-sunken px-4 py-3 text-subhead text-label-secondary">
              {offlineNote}
            </p>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <StatTile
              detail={`${formatCpu(limits.cpuCores)} allocated. ${describeDelta(historyOf(cpuHour.data), (value) => formatPercent(value))}`}
              history={historyOf(cpuHour.data)}
              icon={<Cpu />}
              label="CPU"
              {...(stats ? {} : { unavailable: 'Nothing is running to measure.' })}
              value={stats ? formatPercent(stats.cpuPercent) : null}
            />

            <StatTile
              detail={
                stats
                  ? `${Math.round((stats.memoryBytes / memoryLimitBytes) * 100)}% of the ${formatBytes(memoryLimitBytes)} allocated to this server.`
                  : `${formatBytes(memoryLimitBytes)} is allocated to this server.`
              }
              history={historyOf(memoryHour.data)}
              icon={<MemoryStick />}
              label="Memory"
              {...(stats ? {} : { unavailable: 'Nothing is running to measure.' })}
              value={stats ? formatBytes(stats.memoryBytes) : null}
            />

            <StatTile
              detail={
                diskBytes === null
                  ? `${formatBytes(diskLimitBytes)} is allowed for this server.`
                  : `${Math.round((diskBytes / diskLimitBytes) * 100)}% of the ${formatBytes(diskLimitBytes)} this server may use.`
              }
              history={historyOf(diskHour.data)}
              icon={<Database />}
              isLoading={diskPending}
              label="Disk"
              {...(diskBytes === null
                ? {
                    unavailable:
                      'Disk has not been measured yet. Platter walks the data directory every few minutes.',
                  }
                : {})}
              value={diskBytes === null ? null : formatBytes(diskBytes)}
            />

            <StatTile
              detail={
                stats?.playersMax
                  ? `Out of ${stats.playersMax} slots.`
                  : 'Players connected to the server.'
              }
              history={historyOf(playersHour.data)}
              icon={<Users />}
              label="Players"
              {...(stats?.playersOnline === null || stats?.playersOnline === undefined
                ? {
                    unavailable: isRunning
                      ? 'This server is not reporting a player count. Turn RCON on in Settings to read it.'
                      : NOT_RUNNING,
                  }
                : {})}
              value={
                stats?.playersOnline === null || stats?.playersOnline === undefined
                  ? null
                  : String(stats.playersOnline)
              }
            />

            <StatTile
              detail={
                health.data?.tps
                  ? `20 is a healthy tick rate.${health.data.tps.estimated ? ' Estimated from the console rather than read directly.' : ''}`
                  : 'Ticks the server manages per second.'
              }
              icon={<SpeedFast />}
              isLoading={isRunning && health.isPending}
              label="Ticks per second"
              tone={health.data?.tps && health.data.tps.oneMinute < 15 ? 'warning' : 'default'}
              {...(health.data?.tps
                ? {}
                : { unavailable: tickRateUnavailable(health.data, isRunning) })}
              value={health.data?.tps ? health.data.tps.oneMinute.toFixed(1) : null}
            />

            <StatTile
              detail="Since the container last started."
              icon={<Clock />}
              label="Uptime"
              {...(stats ? {} : { unavailable: 'The server is not running.' })}
              value={stats ? formatDuration(stats.uptimeSeconds) : null}
            />
          </div>
        </section>

        {/* ------------------------------------------------------------------- History */}
        <section aria-labelledby="monitoring-history" className="flex flex-col gap-5">
          <h2 className={SECTION_HEADING} id="monitoring-history">
            History
          </h2>
          <ResourceChart
            {...(server.startedAt === null
              ? {
                  emptyHint:
                    'This server has not started yet. History begins the first time it runs.',
                }
              : {})}
            live={isRunning}
            metric={metric}
            onMetricChange={setMetric}
            onRangeChange={setRange}
            range={range}
            serverId={serverId}
          />
        </section>

        {/* -------------------------------------------------------------------- Limits */}
        <section aria-labelledby="monitoring-limits" className="flex flex-col gap-5">
          <h2 className={SECTION_HEADING} id="monitoring-limits">
            Limits
          </h2>
          <div className="grid gap-8 rounded-md border border-separator-strong bg-surface p-6 sm:grid-cols-2">
            <LiveMeter
              description="The kernel kills the container if it goes past this. Raise it in Settings."
              format={(value) => formatBytes(value)}
              label="Memory"
              limit={memoryLimitBytes}
              {...(stats ? {} : { unavailable: 'Measured only while the server is running.' })}
              value={stats?.memoryBytes ?? 0}
            />
            <LiveMeter
              description="Backups and world data share this allowance."
              format={(value) => formatBytes(value)}
              isLoading={diskPending}
              label="Disk"
              limit={diskLimitBytes}
              {...(diskBytes === null ? { unavailable: 'Not measured yet.' } : {})}
              value={diskBytes ?? 0}
            />
          </div>
        </section>

        {/* -------------------------------------------------------------- Availability */}
        <section aria-labelledby="monitoring-uptime" className="flex flex-col gap-5">
          <h2 className={SECTION_HEADING} id="monitoring-uptime">
            Availability
          </h2>
          <UptimeStrip
            buckets={uptimeBuckets}
            isLoading={cpuRange.isPending}
            rangeLabel={describeRange(range)}
          />
          <p className="text-caption text-label-tertiary">
            Follows the range selected above. Platter records a sample only while a server is
            running, so this is a record of what it saw rather than a claim about what it did not.
          </p>
        </section>
      </div>
    </PageBody>
  );
}
