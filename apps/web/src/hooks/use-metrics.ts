import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { api } from '@/lib/api-client.js';

/**
 * Time series for the monitoring charts. `MetricName`/`Resolution`/the range presets are
 * defined only in `apps/api/src/services/timeseries.ts` and `routes/metrics.ts`, not
 * `@platter/shared` — mirrored here for the reason documented at the top of `use-mods.ts`.
 */

export const METRIC_NAMES = ['cpu', 'memory', 'disk', 'networkRx', 'networkTx', 'players', 'tps'] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

export const METRIC_RESOLUTIONS = ['raw', '1m', '5m'] as const;
export type MetricResolution = (typeof METRIC_RESOLUTIONS)[number];

export const METRIC_RANGES = ['1h', '6h', '24h', '7d', '30d'] as const;
export type MetricRange = (typeof METRIC_RANGES)[number];

export interface MetricPoint {
  timestamp: string;
  avg: number;
  min: number;
  max: number;
  samples: number;
}

export interface MetricSeries {
  serverId: string;
  metric: MetricName;
  resolution: MetricResolution;
  from: string;
  to: string;
  points: MetricPoint[];
}

export interface UseMetricSeriesOptions {
  range?: MetricRange;
  from?: string;
  to?: string;
  /** Omit to let the API pick a resolution that fits the requested window. */
  resolution?: MetricResolution;
  refetchInterval?: number | false;
}

export function useMetricSeries(
  serverId: string,
  metric: MetricName,
  options: UseMetricSeriesOptions = {},
): UseQueryResult<MetricSeries> {
  const { range = '1h', from, to, resolution, refetchInterval = false } = options;
  return useQuery({
    queryKey: ['servers', serverId, 'metrics', metric, { range, from, to, resolution }] as const,
    queryFn: () =>
      api.get<MetricSeries>(`/servers/${serverId}/metrics/${metric}`, {
        query: { range, from, to, resolution },
      }),
    refetchInterval,
  });
}
