import type React from 'react';
import { useId } from 'react';
import { Area, AreaChart } from 'recharts';
import { ChartContainer, type ChartConfig } from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * One reading, at a glance.
 *
 * The rule this component exists to enforce: **never a bare number with no context.** A tile
 * that says "62%" is a quiz. A tile that says "62% — steady, peaked at 71% in the last hour"
 * is an answer. `detail` is therefore required, and the sparkline is decoration on top of
 * that sentence rather than a substitute for it.
 *
 * The sparkline is `aria-hidden` on purpose. It carries nothing the value and the detail line
 * do not already say, and announcing a twenty-point path to a screen reader is noise.
 */

export type StatTone = 'default' | 'warning' | 'danger';

/** Which of `--chart-1..5` the sparkline draws in. All five are low-chroma by design. */
export type StatSeriesColor = 1 | 2 | 3 | 4 | 5;

export interface StatTileProps {
  label: string;
  /** Already formatted, with its unit. `null` when there is no reading to show. */
  value: string | null;
  /**
   * Plain-language context under the value: a direction, a peak, a comparison, a limit.
   * Required — a number on its own is the thing this component is designed to prevent.
   */
  detail: React.ReactNode;
  /** Said instead of the value when the reading cannot be taken, with the reason. */
  unavailable?: string | undefined;
  icon?: React.ReactNode;
  /** Oldest first. Two or more points draw a sparkline; fewer draw nothing. */
  history?: readonly number[] | undefined;
  series?: StatSeriesColor;
  tone?: StatTone;
  isLoading?: boolean;
  className?: string;
}

const TONE_VALUE: Record<StatTone, string> = {
  default: 'text-label',
  warning: 'text-warning',
  danger: 'text-danger',
};

const SPARK_CONFIG: Record<StatSeriesColor, ChartConfig> = {
  1: { value: { label: 'Recent', color: 'var(--chart-1)' } },
  2: { value: { label: 'Recent', color: 'var(--chart-2)' } },
  3: { value: { label: 'Recent', color: 'var(--chart-3)' } },
  4: { value: { label: 'Recent', color: 'var(--chart-4)' } },
  5: { value: { label: 'Recent', color: 'var(--chart-5)' } },
};

export function StatTile({
  label,
  value,
  detail,
  unavailable,
  icon,
  history,
  series = 1,
  tone = 'default',
  isLoading = false,
  className,
}: StatTileProps) {
  const gradientId = useId().replace(/:/g, '');
  const rows = (history ?? []).map((point, index) => ({ index, value: point }));
  const showSpark = !isLoading && !unavailable && rows.length >= 2;

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-md border border-separator-strong bg-surface p-5',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        {icon ? (
          <span aria-hidden className="text-label-tertiary [&_svg]:size-4">
            {icon}
          </span>
        ) : null}
        <h4 className="text-subhead font-medium text-label-secondary">{label}</h4>
      </div>

      {isLoading ? (
        <>
          <Skeleton className="h-9 w-24 rounded-sm" />
          <Skeleton className="h-4 w-40 rounded-sm" />
        </>
      ) : unavailable ? (
        <>
          <p className="text-title-3 font-semibold text-label-tertiary">—</p>
          <p className="text-caption text-label-secondary">{unavailable}</p>
        </>
      ) : (
        <>
          {/*
            Tabular numerals: these tick in place every few seconds, and proportional digits
            make the whole row jitter on each update.
          */}
          <p
            className={cn(
              'font-mono text-title-1 font-semibold leading-none tabular',
              TONE_VALUE[tone],
            )}
          >
            {value ?? '—'}
          </p>
          <p className="text-caption text-label-secondary">{detail}</p>
        </>
      )}

      {showSpark ? (
        <ChartContainer
          aria-hidden
          className="mt-1 aspect-auto h-10 w-full"
          config={SPARK_CONFIG[series]}
          id={`spark-${gradientId}`}
        >
          <AreaChart data={rows} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={`spark-fill-${gradientId}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="var(--color-value)" stopOpacity={0.28} />
                <stop offset="100%" stopColor="var(--color-value)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <Area
              connectNulls={false}
              dataKey="value"
              dot={false}
              fill={`url(#spark-fill-${gradientId})`}
              isAnimationActive={false}
              stroke="var(--color-value)"
              strokeWidth={1.5}
              type="monotone"
            />
          </AreaChart>
        </ChartContainer>
      ) : null}
    </div>
  );
}

/**
 * The sentence under a value: which way it moved and by how much, in words.
 *
 * Deliberately blunt about "no earlier reading" rather than showing a confident 0% change,
 * which is what a naive delta does on a server that started a minute ago.
 */
export function describeDelta(
  history: readonly number[] | undefined,
  format: (value: number) => string,
): string {
  if (!history || history.length < 2) return 'No earlier reading to compare with yet.';

  const latest = history[history.length - 1];
  const earliest = history[0];
  if (latest === undefined || earliest === undefined) {
    return 'No earlier reading to compare with yet.';
  }

  const change = latest - earliest;
  const magnitude = Math.abs(change);
  const scale = Math.max(Math.abs(earliest), 1e-9);

  // Under 2% of where it started is noise, not a trend, and calling it a rise is a lie.
  if (magnitude / scale < 0.02) return `Steady, peaked at ${format(Math.max(...history))}.`;

  return `${change > 0 ? 'Up' : 'Down'} ${format(magnitude)} since the start of this window.`;
}
