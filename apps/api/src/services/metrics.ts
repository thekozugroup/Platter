import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { FastifyInstance } from 'fastify';
import { SERVER_STATUSES } from '@platter/shared';
import { prisma } from '../db.js';

/**
 * Prometheus metrics for `GET /system/metrics`.
 *
 * One dedicated registry rather than prom-client's global `register`: importing this
 * module twice (the app and a test, say) must not silently double-register a metric and
 * crash the second import.
 */
export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry, prefix: 'platter_process_' });

export const httpRequestDuration = new Histogram({
  name: 'platter_http_request_duration_seconds',
  help: 'HTTP request duration in seconds, by method, route and status code.',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

/** Refreshed from the database at scrape time; see `refreshServerStatusGauge`. */
export const serversByStatusGauge = new Gauge({
  name: 'platter_servers_by_status',
  help: 'Number of servers currently in each lifecycle status.',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

/** Incremented by the orchestration drivers around each call to Docker (or the mock). */
export const driverOperationDuration = new Histogram({
  name: 'platter_driver_operation_duration_seconds',
  help: 'Orchestration driver call duration in seconds, by driver kind, operation and outcome.',
  labelNames: ['driver', 'operation', 'result'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [metricsRegistry],
});

/** Incremented/decremented by the console socket plugin as connections open and close. */
export const websocketConnectionsGauge = new Gauge({
  name: 'platter_websocket_connections',
  help: 'Currently open websocket connections, by purpose.',
  labelNames: ['type'] as const,
  registers: [metricsRegistry],
});

/** Incremented by the schedule dispatcher each time a schedule fires. */
export const schedulerRunsTotal = new Counter({
  name: 'platter_scheduler_runs_total',
  help: 'Schedules executed, by action and outcome.',
  labelNames: ['action', 'result'] as const,
  registers: [metricsRegistry],
});

/**
 * Recomputes the status gauge from the database.
 *
 * Called at scrape time rather than on a timer: Prometheus already owns the sampling
 * interval, and a gauge nobody scrapes between updates has no reason to be kept warm by a
 * background loop. Every known status is set explicitly (including to zero) so a status
 * that has emptied out does not linger at its last nonzero value forever.
 */
export async function refreshServerStatusGauge(): Promise<void> {
  const rows = await prisma.server.groupBy({ by: ['status'], _count: { _all: true } });
  const counts = new Map(rows.map((row) => [row.status, row._count._all]));
  for (const status of SERVER_STATUSES) {
    serversByStatusGauge.set({ status }, counts.get(status) ?? 0);
  }
}

/**
 * Registers the request-duration histogram as an `onResponse` hook.
 *
 * Must be called on the root app instance *before* routes are registered: Fastify
 * resolves each route's hook chain from the encapsulation context that exists at the
 * moment the route is declared, so a hook added afterwards would silently miss every
 * route already defined by then.
 */
export function recordHttpMetrics(app: FastifyInstance): void {
  app.addHook('onResponse', (request, reply, done) => {
    httpRequestDuration.observe(
      {
        method: request.method,
        // A fixed label for anything that never matched a route — the alternative is the
        // raw request path, which turns every scanner probing random URLs into a new
        // Prometheus time series.
        route: request.routeOptions.url ?? 'unmatched',
        status_code: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
    done();
  });
}
