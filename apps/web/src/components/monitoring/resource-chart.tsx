import { useId, useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { formatBytes, formatPercent } from '@platter/shared';
import { ErrorState } from '@/components/common/error-state';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import {
  SegmentGroup,
  SegmentGroupItem,
  SegmentGroupItemText,
} from '@/components/ui/segment-group';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useMetricSeries,
  type MetricName,
  type MetricResolution,
  type MetricSeries,
} from '@/hooks/use-metrics.js';
import { cn } from '@/lib/utils';

/**
 * The history chart.
 *
 * `GET /servers/:id/metrics/:metric` returns bucketed samples — one row per bucket, and
 * **no row at all** for a bucket nothing was recorded in. Three cases fall out of that, and
 * a naive line chart gets all three wrong:
 *
 * 1. **No data yet.** A server created ten seconds ago has an empty array. That is a state
 *    to explain, not an axis with nothing on it.
 * 2. **Gaps.** CPU, memory and network are only sampled while a server is `running`
 *    (`services/metrics.ts` selects on that), and nothing is sampled while Platter itself is
 *    down. Drawing a straight line across the hole invents history that never happened, so a
 *    gap gets an explicit `null` row and the line breaks there.
 * 3. **One point.** A single sample draws a zero-length line — visually, nothing. Below
 *    three points the marks are drawn as dots so the reading is actually visible.
 *
 * Network is two cumulative counters rather than a rate, exactly like a Prometheus counter,
 * so `mode: 'rate'` differentiates them. A counter that goes *backwards* means the container
 * restarted and the counter reset; that is a break, not a negative throughput spike.
 *
 * The chart is never the only representation. `ResourceChart` prints the current value, the
 * window's low/average/peak and the gap count as text above it — for screen readers, and
 * because a number is what people came for.
 */

// ---------------------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------------------

/*
 * The response shapes and the fetching live in `hooks/use-metrics.ts`, which mirrors
 * `apps/api/src/routes/metrics.ts` (nothing here is in `@platter/shared` — the route
 * declares its schema inline). Re-declaring them here would give the same endpoint two
 * cache keys and two definitions of the same object, which is how a screen ends up showing
 * data a mutation on another screen has already invalidated.
 */
export type { MetricName, MetricPoint, MetricSeries } from '@/hooks/use-metrics.js';

/** Bucket width per tier, from `services/timeseries.ts`. Gap detection needs it. */
export const RESOLUTION_BUCKET_MS: Record<MetricResolution, number> = {
  raw: 10_000,
  '1m': 60_000,
  '5m': 300_000,
};

/**
 * How many missed buckets count as a gap. One missed sample is a slow tick; two in a row
 * means the server stopped being sampled, and the line has to break rather than guess.
 */
export const GAP_FACTOR = 2.5;

/**
 * The ranges this chart offers. A subset of the API's, which also accepts `30d` — at the
 * five-minute tier that is 8,640 points, more than a 360px-wide chart can say anything with.
 */
export const CHART_RANGES = ['1h', '6h', '24h', '7d'] as const;
export type ChartRange = (typeof CHART_RANGES)[number];

export const RANGE_MS: Record<ChartRange, number> = {
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 24 * 3_600_000,
  '7d': 7 * 86_400_000,
};

/** Short enough for a segmented control at 360px. */
export const RANGE_SHORT_LABELS: Record<ChartRange, string> = {
  '1h': '1h',
  '6h': '6h',
  '24h': '24h',
  '7d': '7d',
};

export function describeRange(range: ChartRange): string {
  switch (range) {
    case '1h':
      return 'the last hour';
    case '6h':
      return 'the last 6 hours';
    case '24h':
      return 'the last 24 hours';
    case '7d':
      return 'the last 7 days';
  }
}

// ---------------------------------------------------------------------------------------
// Building rows
// ---------------------------------------------------------------------------------------

export type ChartMetric = 'cpu' | 'memory' | 'disk' | 'network' | 'players' | 'tps';

export interface ChartRow {
  t: number;
  [seriesKey: string]: number | null;
}

export interface SeriesStats {
  min: number;
  max: number;
  avg: number;
  latest: number;
}

export interface BuiltSeries {
  rows: ChartRow[];
  /** Real samples plotted, excluding the synthetic rows inserted to break a line. */
  pointCount: number;
  /** Breaks inserted because samples are missing. Surfaced in words, not just drawn. */
  gapCount: number;
  bucketMs: number;
  /** Per series key; `null` when that key has no usable sample in the window. */
  stats: Record<string, SeriesStats | null>;
}

export interface SeriesInput {
  key: string;
  response: MetricSeries | undefined;
}

function emptyRow(t: number, keys: readonly string[]): ChartRow {
  const row: ChartRow = { t };
  for (const key of keys) row[key] = null;
  return row;
}

/**
 * Turns one or more API responses into rows recharts can plot, with gaps broken and
 * counters differentiated. Pure and exported so the awkward parts are unit-testable
 * without mounting a chart.
 */
export function buildSeries(
  inputs: readonly SeriesInput[],
  mode: 'value' | 'rate' = 'value',
): BuiltSeries {
  const keys = inputs.map((input) => input.key);
  const resolution = inputs.find((input) => input.response)?.response?.resolution ?? 'raw';
  const bucketMs = RESOLUTION_BUCKET_MS[resolution];
  const gapThreshold = bucketMs * GAP_FACTOR;

  // `null` is meaningful here and distinct from "absent": it is an explicit break, which
  // recharts renders by lifting the pen rather than joining the two sides.
  const perKey = new Map<string, Map<number, number | null>>();

  for (const { key, response } of inputs) {
    const values = new Map<number, number | null>();
    const points = response?.points ?? [];

    if (mode === 'rate') {
      for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1];
        const current = points[index];
        if (!previous || !current) continue;

        const start = Date.parse(previous.timestamp);
        const end = Date.parse(current.timestamp);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

        const deltaMs = end - start;
        // Across a gap the counter kept climbing while nothing was recorded, so the
        // difference is not this bucket's throughput — it is an hour of traffic drawn as
        // one spike. Break instead.
        //
        // A counter that went *backwards* means the container restarted and the counter
        // reset. That is a discontinuity worth seeing, not a negative rate.
        if (deltaMs <= 0 || deltaMs > gapThreshold || current.avg < previous.avg) {
          values.set(end, null);
          continue;
        }

        values.set(end, ((current.avg - previous.avg) / deltaMs) * 1000);
      }
    } else {
      for (const point of points) {
        const at = Date.parse(point.timestamp);
        if (Number.isFinite(at)) values.set(at, point.avg);
      }
    }

    perKey.set(key, values);
  }

  const stamps = [...new Set([...perKey.values()].flatMap((values) => [...values.keys()]))].sort(
    (a, b) => a - b,
  );

  const rows: ChartRow[] = [];
  let previous: number | null = null;

  for (const at of stamps) {
    if (previous !== null && at - previous > gapThreshold) {
      // One all-null row inside the hole. recharts breaks a line on a null, so this is what
      // stops the chart claiming the server was busy while it was switched off.
      rows.push(emptyRow(previous + Math.min(bucketMs, (at - previous) / 2), keys));
    }

    const row: ChartRow = { t: at };
    for (const key of keys) {
      const value = perKey.get(key)?.get(at);
      row[key] = value === undefined ? null : value;
    }
    rows.push(row);
    previous = at;
  }

  const stats: Record<string, SeriesStats | null> = {};
  for (const key of keys) {
    const values = [...(perKey.get(key)?.values() ?? [])].filter(
      (value): value is number => value !== null,
    );
    if (values.length === 0) {
      stats[key] = null;
      continue;
    }
    const total = values.reduce((sum, value) => sum + value, 0);
    stats[key] = {
      min: Math.min(...values),
      max: Math.max(...values),
      avg: total / values.length,
      latest: values[values.length - 1] ?? 0,
    };
  }

  // A row with nothing in it is a break, whether this function inserted it or a counter
  // reset produced it. That count is what the readout turns into a sentence.
  const gapCount = rows.filter((row) => keys.every((key) => row[key] === null)).length;
  const pointCount = rows.filter((row) => keys.some((key) => row[key] !== null)).length;

  return { rows, pointCount, gapCount, bucketMs, stats };
}

// ---------------------------------------------------------------------------------------
// Metric vocabulary
// ---------------------------------------------------------------------------------------

interface SeriesDefinition {
  key: string;
  metric: MetricName;
  label: string;
  color: string;
}

interface MetricDefinition {
  label: string;
  /** What the axis actually measures, said plainly. */
  caption: string;
  mode: 'value' | 'rate';
  series: readonly SeriesDefinition[];
  format: (value: number) => string;
  /** Axis ticks: shorter, because an axis label has no room for a sentence. */
  tick: (value: number) => string;
  domain?: [number, number];
}

const bytesPerSecond = (value: number): string => `${formatBytes(value)}/s`;

export const CHART_METRICS: Record<ChartMetric, MetricDefinition> = {
  cpu: {
    label: 'CPU',
    caption: 'Share of the allocated cores in use.',
    mode: 'value',
    series: [{ key: 'cpu', metric: 'cpu', label: 'CPU', color: 'var(--chart-1)' }],
    format: (value) => formatPercent(value),
    tick: (value) => `${Math.round(value)}%`,
  },
  memory: {
    label: 'Memory',
    caption: 'Resident memory used by the container.',
    mode: 'value',
    series: [{ key: 'memory', metric: 'memory', label: 'Memory', color: 'var(--chart-3)' }],
    format: (value) => formatBytes(value),
    tick: (value) => formatBytes(value, 0),
  },
  disk: {
    label: 'Disk',
    caption: 'Size of the server’s data directory.',
    mode: 'value',
    series: [{ key: 'disk', metric: 'disk', label: 'Disk', color: 'var(--chart-2)' }],
    format: (value) => formatBytes(value),
    tick: (value) => formatBytes(value, 0),
  },
  network: {
    label: 'Network',
    caption: 'Throughput, differentiated from the container’s cumulative byte counters.',
    mode: 'rate',
    series: [
      { key: 'rx', metric: 'networkRx', label: 'Received', color: 'var(--chart-5)' },
      { key: 'tx', metric: 'networkTx', label: 'Sent', color: 'var(--chart-4)' },
    ],
    format: bytesPerSecond,
    tick: (value) => `${formatBytes(value, 0)}/s`,
  },
  players: {
    label: 'Players',
    caption: 'Players connected at each sample.',
    mode: 'value',
    series: [{ key: 'players', metric: 'players', label: 'Players', color: 'var(--chart-1)' }],
    format: (value) => (value === 1 ? '1 player' : `${Math.round(value)} players`),
    tick: (value) => String(Math.round(value)),
  },
  tps: {
    label: 'Ticks',
    caption: 'Server ticks per second. 20 is a healthy Minecraft server.',
    mode: 'value',
    series: [{ key: 'tps', metric: 'tps', label: 'TPS', color: 'var(--chart-3)' }],
    format: (value) => `${value.toFixed(1)} TPS`,
    tick: (value) => value.toFixed(0),
    domain: [0, 20],
  },
};

export const CHART_METRIC_ORDER: readonly ChartMetric[] = [
  'cpu',
  'memory',
  'network',
  'players',
  'disk',
  'tps',
];

// ---------------------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------------------

/** Axis ticks: time of day inside a day, a date beyond it. */
export function formatAxisTick(at: number, range: ChartRange): string {
  const date = new Date(at);
  if (range === '7d') {
    return date.toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric' });
  }
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Tooltip and screen-reader stamps: unambiguous, never relative. */
export function formatStamp(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------------------

export interface ResourceChartProps {
  serverId: string;
  metric: ChartMetric;
  onMetricChange: (metric: ChartMetric) => void;
  range: ChartRange;
  onRangeChange: (range: ChartRange) => void;
  /** Poll for new samples. Pass `true` only while the server is actually running. */
  live?: boolean;
  /**
   * Extra sentence for the empty state, when the page knows *why* there is nothing —
   * "this server has never started", for instance.
   */
  emptyHint?: string;
  className?: string;
}

export function ResourceChart({
  serverId,
  metric,
  onMetricChange,
  range,
  onRangeChange,
  live = false,
  emptyHint,
  className,
}: ResourceChartProps) {
  const gradientId = useId().replace(/:/g, '');
  const definition = CHART_METRICS[metric];
  const isNetwork = metric === 'network';

  const refetchInterval = live ? 30_000 : (false as const);
  const primaryName: MetricName = isNetwork ? 'networkRx' : metric;
  /*
   * Two hooks, unconditionally — a conditional hook is not an option. When the metric has
   * only one series both calls carry the same query key, so react-query serves them from a
   * single request rather than firing a second one nobody reads.
   */
  const primary = useMetricSeries(serverId, primaryName, { range, refetchInterval });
  const secondary = useMetricSeries(serverId, isNetwork ? 'networkTx' : primaryName, {
    range,
    refetchInterval,
  });

  const built = useMemo(() => {
    const inputs: SeriesInput[] = isNetwork
      ? [
          { key: 'rx', response: primary.data },
          { key: 'tx', response: secondary.data },
        ]
      : [{ key: definition.series[0]?.key ?? metric, response: primary.data }];
    return buildSeries(inputs, definition.mode);
  }, [isNetwork, primary.data, secondary.data, definition.series, definition.mode, metric]);

  const config: ChartConfig = useMemo(() => {
    const entries: ChartConfig = {};
    for (const series of definition.series) {
      entries[series.key] = { label: series.label, color: series.color };
    }
    return entries;
  }, [definition.series]);

  const windowFrom = primary.data ? Date.parse(primary.data.from) : Date.now() - RANGE_MS[range];
  const windowTo = primary.data ? Date.parse(primary.data.to) : Date.now();

  const isPending = primary.isPending || (isNetwork && secondary.isPending);
  const error = primary.error ?? (isNetwork ? secondary.error : null);
  const showDots = built.pointCount > 0 && built.pointCount < 3;

  return (
    <section className={cn('flex flex-col gap-5', className)}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-sans text-title-3 font-semibold text-label">
            {definition.label} over time
          </h3>

          <div className="flex flex-wrap items-center gap-2">
            <SegmentGroup
              aria-label="Time range"
              className="rounded-md"
              onValueChange={({ value }) => onRangeChange(value as ChartRange)}
              value={range}
            >
              {CHART_RANGES.map((option) => (
                <SegmentGroupItem
                  className="flex h-11 min-w-11 items-center justify-center rounded-md px-3 text-subhead"
                  key={option}
                  value={option}
                >
                  <SegmentGroupItemText>{RANGE_SHORT_LABELS[option]}</SegmentGroupItemText>
                </SegmentGroupItem>
              ))}
            </SegmentGroup>
          </div>
        </div>

        <SegmentGroup
          aria-label="Metric"
          className="flex-wrap rounded-md"
          onValueChange={({ value }) => onMetricChange(value as ChartMetric)}
          value={metric}
        >
          {CHART_METRIC_ORDER.map((option) => (
            <SegmentGroupItem
              className="flex h-11 items-center justify-center rounded-md px-3.5 text-subhead"
              key={option}
              value={option}
            >
              <SegmentGroupItemText>{CHART_METRICS[option].label}</SegmentGroupItemText>
            </SegmentGroupItem>
          ))}
        </SegmentGroup>
      </div>

      {/*
        The written record of the same data. This is deliberately above the chart rather
        than tucked under it: it is the part that survives a screen reader, a printout and
        a colour-blind reader, and it is what most people actually wanted.
      */}
      <ChartReadout built={built} definition={definition} isPending={isPending} range={range} />

      {isPending ? (
        <Skeleton className="h-56 w-full rounded-md sm:h-72" />
      ) : error ? (
        <ErrorState
          error={error}
          onRetry={() => {
            void primary.refetch();
            if (isNetwork) void secondary.refetch();
          }}
          title={`Couldn’t load ${definition.label.toLowerCase()} history`}
          variant="inline"
        />
      ) : built.pointCount === 0 ? (
        <EmptyChart hint={emptyHint} label={definition.label} range={range} />
      ) : (
        <ChartContainer
          className="aspect-auto h-56 w-full sm:h-72"
          config={config}
          id={`metric-${gradientId}`}
        >
          <AreaChart
            accessibilityLayer
            data={built.rows}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          >
            <defs>
              {definition.series.map((series) => (
                <linearGradient
                  id={`fill-${gradientId}-${series.key}`}
                  key={series.key}
                  x1="0"
                  x2="0"
                  y1="0"
                  y2="1"
                >
                  <stop offset="0%" stopColor={series.color} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={series.color} stopOpacity={0.02} />
                </linearGradient>
              ))}
            </defs>

            <CartesianGrid vertical={false} />

            <XAxis
              axisLine={false}
              dataKey="t"
              domain={[windowFrom, windowTo]}
              // 64px between ticks drops the axis to three labels on a 360px screen and
              // grows it on a desktop, without a media query or a hard-coded count.
              minTickGap={64}
              scale="time"
              tickFormatter={(value: number) => formatAxisTick(value, range)}
              tickLine={false}
              tickMargin={10}
              type="number"
            />
            <YAxis
              axisLine={false}
              domain={definition.domain ?? [0, 'auto']}
              tickCount={4}
              tickFormatter={(value: number) => definition.tick(value)}
              tickLine={false}
              width={56}
            />

            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value, name, item) => (
                    <span className="flex w-full items-center gap-2">
                      <span
                        aria-hidden
                        className="size-2.5 shrink-0 rounded-[2px]"
                        style={{ backgroundColor: item.color }}
                      />
                      <span className="flex-1 text-muted-foreground">{name}</span>
                      <span className="font-mono font-medium text-foreground tabular">
                        {typeof value === 'number' ? definition.format(value) : 'No sample'}
                      </span>
                    </span>
                  )}
                  labelFormatter={(_label, payload) => {
                    const at = readRowStamp(payload);
                    return at === null ? '' : formatStamp(at);
                  }}
                />
              }
              cursor={{ strokeDasharray: '3 3' }}
            />

            {definition.series.map((series) => (
              <Area
                connectNulls={false}
                dataKey={series.key}
                dot={showDots ? { r: 3 } : false}
                fill={`url(#fill-${gradientId}-${series.key})`}
                isAnimationActive={false}
                key={series.key}
                name={series.label}
                stroke={series.color}
                strokeWidth={1.75}
                type="monotone"
              />
            ))}
          </AreaChart>
        </ChartContainer>
      )}

      <p className="text-caption text-label-tertiary">{definition.caption}</p>
    </section>
  );
}

/** The tooltip payload is loosely typed by recharts; read `t` back without an `any`. */
function readRowStamp(payload: unknown): number | null {
  if (!Array.isArray(payload)) return null;
  const first: unknown = payload[0];
  if (typeof first !== 'object' || first === null || !('payload' in first)) return null;
  const row: unknown = (first as { payload: unknown }).payload;
  if (typeof row !== 'object' || row === null || !('t' in row)) return null;
  const at = Number((row as { t: unknown }).t);
  return Number.isFinite(at) ? at : null;
}

// ---------------------------------------------------------------------------------------

interface ChartReadoutProps {
  built: BuiltSeries;
  definition: MetricDefinition;
  range: ChartRange;
  isPending: boolean;
}

/** Current, low, average and peak in words and numerals, beside every chart. */
function ChartReadout({ built, definition, range, isPending }: ChartReadoutProps) {
  if (isPending) {
    return <Skeleton className="h-16 w-full max-w-md rounded-md" />;
  }

  const present = definition.series.filter((series) => built.stats[series.key]);
  if (present.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-wrap gap-x-8 gap-y-4">
        {present.map((series) => {
          const stats = built.stats[series.key];
          if (!stats) return null;
          return (
            <div className="min-w-0" key={series.key}>
              <dt className="flex items-center gap-2 text-caption text-label-tertiary">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: series.color }}
                />
                {definition.series.length > 1 ? `${series.label} now` : 'Now'}
              </dt>
              <dd className="mt-1 font-mono text-title-3 font-semibold text-label tabular">
                {definition.format(stats.latest)}
              </dd>
              <dd className="mt-1 text-caption text-label-secondary tabular">
                Low {definition.format(stats.min)} · Average {definition.format(stats.avg)} · Peak{' '}
                {definition.format(stats.max)}
              </dd>
            </div>
          );
        })}
      </dl>

      <p className="text-caption text-label-tertiary">
        {built.pointCount === 1
          ? `One sample in ${describeRange(range)}. There is not enough history to draw a line yet.`
          : `${built.pointCount.toLocaleString()} samples over ${describeRange(range)}.`}
        {built.gapCount > 0
          ? ` The line breaks ${built.gapCount === 1 ? 'once' : `${built.gapCount} times`}: nothing was recorded there, because the server was not running or Platter was not either.`
          : null}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------

function EmptyChart({
  label,
  range,
  hint,
}: {
  label: string;
  range: ChartRange;
  hint?: string | undefined;
}) {
  return (
    <div className="flex h-56 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-separator-strong px-6 text-center sm:h-72">
      <p className="font-sans text-title-3 font-semibold text-label">
        Nothing recorded for {label} in {describeRange(range)}
      </p>
      <p className="max-w-prose text-balance text-subhead text-label-secondary">
        {hint ??
          'Platter samples a server only while it is running. Start it, or widen the range to reach further back.'}
      </p>
    </div>
  );
}
