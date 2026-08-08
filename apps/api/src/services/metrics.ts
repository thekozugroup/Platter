import type { Node as NodeRow } from '@prisma/client';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { prisma } from '../db.js';
import { getDriverForNode } from '../orchestration/registry.js';
import { getPlayerCount, getServerHealth } from './players.js';
import { recordSample } from './timeseries.js';

/**
 * Two distinct jobs that both live here because both are "how healthy is Platter itself":
 *
 * 1. A Prometheus registry (`GET /system/metrics`, wired up by `routes/system.ts`) — the
 *    operational picture for whoever runs the box: request latency, driver health, how many
 *    servers are in which state.
 * 2. The collector that samples every running container's resource usage on an interval and
 *    feeds it into `services/timeseries.ts` — the data the per-server monitoring charts read.
 *
 * The distinction from `timeseries.ts` is producer vs. storage: this file decides *what* to
 * sample and *when*; that one decides how it is kept and rolled up.
 */

// ---------------------------------------------------------------------------
// Prometheus
// ---------------------------------------------------------------------------

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

export const httpRequestDuration = new Histogram({
  name: 'platter_http_request_duration_seconds',
  help: 'HTTP request duration in seconds, by method, route and status code.',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

/**
 * Observes every request's duration. Must be registered at the Fastify root, not inside
 * one of the nested route plugins — an `onResponse` hook only sees traffic through the
 * encapsulation context it was added in, and this needs all of it. `buildApp` is where
 * that registration belongs; see the project report for this gap.
 */
export const httpMetricsPlugin: FastifyPluginAsync = async (app) => {
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    httpRequestDuration.observe(
      { method: request.method, route, status_code: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });
};
Object.assign(httpMetricsPlugin, {
  [Symbol.for('skip-override')]: true,
});

/**
 * Refreshed on scrape rather than pushed on every status change: a gauge's `collect`
 * callback runs (and, being async-capable, is awaited) each time the registry is read, so
 * this needs no call site anywhere else in the app to stay accurate.
 */
export const serversByStatus = new Gauge({
  name: 'platter_servers_by_status',
  help: 'Number of servers currently in each lifecycle status.',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
  async collect() {
    const rows = await prisma.server.groupBy({ by: ['status'], _count: { _all: true } });
    this.reset();
    for (const row of rows) this.set({ status: row.status }, row._count._all);
  },
});

export const driverOperationDuration = new Histogram({
  name: 'platter_driver_operation_duration_seconds',
  help: 'Duration of orchestration driver operations, by driver kind, operation and outcome.',
  labelNames: ['driver', 'operation', 'outcome'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [metricsRegistry],
});

/**
 * Called by `orchestration/registry.ts`, which wraps every driver it hands out — one place
 * rather than one call per method, so a driver method added later is measured for free.
 */
export function observeDriverOperation(
  driver: 'docker' | 'mock',
  operation: string,
  seconds: number,
  outcome: 'ok' | 'error' = 'ok',
): void {
  driverOperationDuration.observe({ driver, operation, outcome }, seconds);
}

/** Incremented and decremented by `routes/console.ts` as sockets open and close. */
export const websocketConnections = new Gauge({
  name: 'platter_websocket_connections',
  help: 'Currently open console websocket connections.',
  registers: [metricsRegistry],
});

/** Incremented by `services/scheduler.ts` each time a schedule fires. */
export const schedulerRuns = new Counter({
  name: 'platter_scheduler_runs_total',
  help: 'Schedule executions, by action and outcome.',
  labelNames: ['action', 'outcome'] as const,
  registers: [metricsRegistry],
});

/** What `GET /system/metrics` sends back, verbatim. */
export async function renderMetrics(): Promise<{ contentType: string; body: string }> {
  return { contentType: metricsRegistry.contentType, body: await metricsRegistry.metrics() };
}

// ---------------------------------------------------------------------------
// Usage collector — feeds services/timeseries.ts
// ---------------------------------------------------------------------------

export interface MetricsCollectorOptions {
  /** How often running containers are sampled for CPU/memory/network. */
  intervalMs?: number;
  /** Disk usage means walking a directory (or `exec`-ing `du`), so it runs far less often. */
  diskIntervalMs?: number;
  /** Player count and tick rate cost a live round-trip into the game, so slower again. */
  gameIntervalMs?: number;
  logger?: FastifyBaseLogger;
}

const DEFAULT_COLLECT_INTERVAL_MS = 10_000;
const DEFAULT_DISK_INTERVAL_MS = 60_000;
const DEFAULT_GAME_INTERVAL_MS = 60_000;
const MIN_COLLECT_INTERVAL_MS = 1000;

/** Statuses whose container is expected to still exist, so a disk sample is worth trying. */
const HAS_DATA_DIR_STATUSES: readonly string[] = [
  'installing',
  'install_failed',
  'offline',
  'starting',
  'running',
  'stopping',
  'restarting',
  'crashed',
  'suspended',
];

let collectTimer: NodeJS.Timeout | null = null;
let diskTimer: NodeJS.Timeout | null = null;
let gameTimer: NodeJS.Timeout | null = null;
let collectingUsage = false;
let collectingDisk = false;
let collectingGame = false;
let collectorLogger: FastifyBaseLogger | null = null;

type ServerWithNode = { id: string; node: NodeRow };

/**
 * CPU, memory and network are cheap to read (one call into the driver, already-computed
 * counters) and change fast enough to be worth a chart's fine resolution, so they run on
 * the short interval.
 */
async function collectUsageOnce(): Promise<void> {
  if (collectingUsage) return;
  collectingUsage = true;
  try {
    const servers: ServerWithNode[] = await prisma.server.findMany({
      where: { status: 'running' },
      select: { id: true, node: true },
    });

    await Promise.all(
      servers.map(async (server) => {
        try {
          const driver = getDriverForNode(server.node);
          const usage = await driver.usage(server.id);
          if (!usage) return;
          recordSample(server.id, 'cpu', usage.cpuPercent, usage.sampledAt);
          recordSample(server.id, 'memory', usage.memoryBytes, usage.sampledAt);
          // Cumulative counters, not deltas — a chart wanting throughput diffs consecutive
          // points itself, the same way it would read a Prometheus counter.
          recordSample(server.id, 'networkRx', usage.networkRxBytes, usage.sampledAt);
          recordSample(server.id, 'networkTx', usage.networkTxBytes, usage.sampledAt);
        } catch (error) {
          collectorLogger?.warn(
            { err: error, serverId: server.id },
            'failed to sample container usage',
          );
        }
      }),
    );
  } catch (error) {
    collectorLogger?.error({ err: error }, 'usage collection pass failed');
  } finally {
    collectingUsage = false;
  }
}

/** Disk usage on a slower cadence: it applies to any server with a data directory, running
 * or not, and walking one is orders of magnitude more expensive than reading a counter. */
async function collectDiskOnce(): Promise<void> {
  if (collectingDisk) return;
  collectingDisk = true;
  try {
    const servers: ServerWithNode[] = await prisma.server.findMany({
      where: { status: { in: [...HAS_DATA_DIR_STATUSES] } },
      select: { id: true, node: true },
    });

    await Promise.all(
      servers.map(async (server) => {
        try {
          const driver = getDriverForNode(server.node);
          const bytes = await driver.diskUsage(server.id);
          recordSample(server.id, 'disk', bytes, new Date());
        } catch (error) {
          collectorLogger?.warn({ err: error, serverId: server.id }, 'failed to sample disk usage');
        }
      }),
    );
  } catch (error) {
    collectorLogger?.error({ err: error }, 'disk collection pass failed');
  } finally {
    collectingDisk = false;
  }
}

/**
 * Player count and tick rate: the two series the charts offer that no container counter can
 * answer. Both need a live query into the game (RCON, else the game's query port), which is
 * why they are on their own slow timer rather than folded into the usage pass — a
 * round-trip per running server every ten seconds would be a poll the game can feel.
 *
 * A server that cannot answer records nothing rather than a zero: "nobody is playing" and
 * "we could not ask" are the same number and very different facts.
 */
async function collectGameOnce(): Promise<void> {
  if (collectingGame) return;
  collectingGame = true;
  try {
    const servers = await prisma.server.findMany({
      where: { status: 'running', suspended: false },
      select: { id: true },
    });

    await Promise.all(
      servers.map(async (server) => {
        const at = new Date();
        const [players, health] = await Promise.all([
          getPlayerCount(server.id).catch(() => null),
          getServerHealth(server.id).catch(() => null),
        ]);
        if (players) recordSample(server.id, 'players', players.online, at);
        // The one-minute figure is the one an operator reads; the longer windows are a
        // smoothing of it and would flatten exactly the dip a chart exists to show.
        if (health?.tps) recordSample(server.id, 'tps', health.tps.oneMinute, at);
      }),
    );
  } catch (error) {
    collectorLogger?.error({ err: error }, 'game metric collection pass failed');
  } finally {
    collectingGame = false;
  }
}

/** Called once from the app's boot sequence, alongside health polling and the crash supervisor. */
export function startMetricsCollection(options: MetricsCollectorOptions = {}): void {
  if (collectTimer || diskTimer || gameTimer) return;
  collectorLogger = options.logger ?? null;

  const intervalMs = Math.max(
    MIN_COLLECT_INTERVAL_MS,
    options.intervalMs ?? DEFAULT_COLLECT_INTERVAL_MS,
  );
  collectTimer = setInterval(() => {
    void collectUsageOnce();
  }, intervalMs);
  collectTimer.unref();

  const diskIntervalMs = Math.max(
    MIN_COLLECT_INTERVAL_MS,
    options.diskIntervalMs ?? DEFAULT_DISK_INTERVAL_MS,
  );
  diskTimer = setInterval(() => {
    void collectDiskOnce();
  }, diskIntervalMs);
  diskTimer.unref();

  const gameIntervalMs = Math.max(
    MIN_COLLECT_INTERVAL_MS,
    options.gameIntervalMs ?? DEFAULT_GAME_INTERVAL_MS,
  );
  gameTimer = setInterval(() => {
    void collectGameOnce();
  }, gameIntervalMs);
  gameTimer.unref();

  void collectUsageOnce();
  void collectDiskOnce();
  void collectGameOnce();
}

export function stopMetricsCollection(): void {
  if (collectTimer) {
    clearInterval(collectTimer);
    collectTimer = null;
  }
  if (diskTimer) {
    clearInterval(diskTimer);
    diskTimer = null;
  }
  if (gameTimer) {
    clearInterval(gameTimer);
    gameTimer = null;
  }
}
