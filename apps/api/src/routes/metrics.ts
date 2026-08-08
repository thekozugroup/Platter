import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { idSchema, isoDateSchema } from '@platter/shared';
import { requireServer } from '../plugins/auth.js';
import { METRIC_NAMES, RESOLUTIONS, querySeries, type Resolution } from '../services/timeseries.js';

/**
 * Per-server monitoring charts. Mounted at `/servers/:serverId/metrics` — see
 * `routes/index.ts` for the prefix, which is not this file's to register (see the project
 * report: nobody has wired this module in yet).
 *
 * One metric per request rather than a bundle: "network" is two independent counters
 * (`networkRx`/`networkTx`) a client fetches separately and plots together if it wants a
 * combined chart, the same way it would read two Prometheus series.
 */

const RANGE_PRESETS = {
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 24 * 3_600_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
} as const;
type RangePreset = keyof typeof RANGE_PRESETS;

const metricsQuerySchema = z.object({
  /** Convenience shorthand for "now minus this". Ignored if `from`/`to` are both given. */
  range: z.enum(['1h', '6h', '24h', '7d', '30d']).default('1h'),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  /** Omit to let the endpoint pick a resolution that fits the requested window. */
  resolution: z.enum(RESOLUTIONS).optional(),
});

function resolveWindow(query: { range: RangePreset; from?: string; to?: string }): {
  from: Date;
  to: Date;
} {
  if (query.from !== undefined && query.to !== undefined) {
    return { from: new Date(query.from), to: new Date(query.to) };
  }
  const to = Date.now();
  return { from: new Date(to - RANGE_PRESETS[query.range]), to: new Date(to) };
}

/** Full resolution is only kept for a few hours (see `timeseries.ts`'s retention constants),
 * so a window wider than that would silently come back empty at `raw` — pick a tier the
 * data actually survives at instead of making every caller know the retention schedule. */
function pickResolution(spanMs: number): Resolution {
  if (spanMs <= 3 * 3_600_000) return 'raw';
  if (spanMs <= 2 * 86_400_000) return '1m';
  return '5m';
}

const seriesPointSchema = z.object({
  timestamp: isoDateSchema,
  avg: z.number(),
  min: z.number(),
  max: z.number(),
  samples: z.number().int(),
});

const seriesResponseSchema = z.object({
  serverId: idSchema,
  metric: z.enum(METRIC_NAMES),
  resolution: z.enum(RESOLUTIONS),
  from: isoDateSchema,
  to: isoDateSchema,
  points: z.array(seriesPointSchema),
});

const metricsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/:metric',
    {
      preHandler: app.requireServerAccess('server.view'),
      schema: {
        tags: ['metrics'],
        summary: 'Resource-usage history for one server, ready for a chart',
        description:
          '`players` and `tps` come back empty for blueprints that expose no way to read them ' +
          '(see the blueprints package) rather than erroring — an empty series is "no data yet", not a failure.',
        params: z.object({ metric: z.enum(METRIC_NAMES) }),
        querystring: metricsQuerySchema,
        response: { 200: seriesResponseSchema },
      },
    },
    async (request) => {
      const server = requireServer(request);
      const { from, to } = resolveWindow(request.query);
      const resolution =
        request.query.resolution ?? pickResolution(Math.max(0, to.getTime() - from.getTime()));
      const points = await querySeries(server.id, request.params.metric, from, to, resolution);

      return {
        serverId: server.id,
        metric: request.params.metric,
        resolution,
        from: from.toISOString(),
        to: to.toISOString(),
        points,
      };
    },
  );
};

export default metricsRoutes;
