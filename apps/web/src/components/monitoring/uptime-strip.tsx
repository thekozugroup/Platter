import { formatDuration } from '@platter/shared';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * A compact history of when this server was up.
 *
 * Platter has no uptime table, and inventing one would be worse than not having it. What it
 * does have is the sample record: `services/metrics.ts` samples CPU and memory **only while a
 * server's status is `running`**, so a bucket with samples in it is a bucket the server was
 * up for. A bucket without samples is genuinely ambiguous — the server was stopped, or
 * Platter itself was not running — and this component says exactly that rather than picking
 * the flattering interpretation. Three states, named honestly: running, crashed, no samples.
 *
 * Colour is not the signal. A crashed segment is taller than the others and an unrecorded one
 * is drawn hollow, so the strip is still readable in greyscale; the legend spells all three
 * out in words, and the summary line above repeats the whole thing as a sentence.
 */

export type UptimeState = 'running' | 'crashed' | 'unknown';

export interface UptimeBucket {
  start: number;
  end: number;
  state: UptimeState;
}

export interface BuildUptimeOptions {
  /** Sample timestamps in ms, in any order. One per recorded bucket. */
  timestamps: readonly number[];
  from: number;
  to: number;
  /** How many segments to draw. Fewer on a phone; the caller decides. */
  segments?: number;
  /** From `server.lastCrashAt`. Marks the segment it falls in. */
  crashedAt?: number | null;
}

export function buildUptimeBuckets({
  timestamps,
  from,
  to,
  segments = 48,
  crashedAt = null,
}: BuildUptimeOptions): UptimeBucket[] {
  const span = to - from;
  if (!Number.isFinite(span) || span <= 0 || segments <= 0) return [];

  const width = span / segments;
  const buckets: UptimeBucket[] = Array.from({ length: segments }, (_, index) => ({
    start: from + index * width,
    end: from + (index + 1) * width,
    state: 'unknown' as UptimeState,
  }));

  for (const at of timestamps) {
    if (!Number.isFinite(at) || at < from || at > to) continue;
    const index = Math.min(segments - 1, Math.floor((at - from) / width));
    const bucket = buckets[index];
    if (bucket) bucket.state = 'running';
  }

  if (crashedAt !== null && crashedAt >= from && crashedAt <= to) {
    const index = Math.min(segments - 1, Math.floor((crashedAt - from) / width));
    const bucket = buckets[index];
    // A crash outranks "running": the samples either side of it are true, but the crash is
    // the thing anyone reading this strip is looking for.
    if (bucket) bucket.state = 'crashed';
  }

  return buckets;
}

const STATE_WORD: Record<UptimeState, string> = {
  running: 'Running',
  crashed: 'Crashed',
  unknown: 'No samples',
};

const STATE_FILL: Record<UptimeState, string> = {
  running: 'bg-success-dot',
  crashed: 'bg-danger-dot',
  // Hollow rather than merely paler: the shape differs, so greyscale still separates it.
  unknown: 'border border-separator-strong bg-transparent',
};

/** Crashed segments are taller. That height difference is the non-colour signal. */
const STATE_HEIGHT: Record<UptimeState, string> = {
  running: 'h-4',
  crashed: 'h-7',
  unknown: 'h-4',
};

export interface UptimeStripProps {
  buckets: readonly UptimeBucket[];
  /** How the window reads in words, e.g. "the last 6 hours". */
  rangeLabel: string;
  isLoading?: boolean;
  className?: string;
}

export function UptimeStrip({
  buckets,
  rangeLabel,
  isLoading = false,
  className,
}: UptimeStripProps) {
  if (isLoading) {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        <Skeleton className="h-5 w-56 rounded-sm" />
        <Skeleton className="h-7 w-full rounded-sm" />
      </div>
    );
  }

  if (buckets.length === 0) {
    return (
      <p className={cn('text-subhead text-label-secondary', className)}>
        There is no availability history for {rangeLabel} yet.
      </p>
    );
  }

  const running = buckets.filter((bucket) => bucket.state === 'running').length;
  const crashes = buckets.filter((bucket) => bucket.state === 'crashed').length;
  const unknown = buckets.length - running - crashes;
  const bucketSeconds = (buckets[0] ? buckets[0].end - buckets[0].start : 0) / 1000;

  const summary =
    `Up for about ${formatDuration(running * bucketSeconds)} of ${rangeLabel}.` +
    (crashes > 0 ? ` ${crashes === 1 ? 'One crash' : `${crashes} crashes`} recorded.` : '') +
    (unknown > 0
      ? ` No samples for about ${formatDuration(unknown * bucketSeconds)} — the server was stopped, or Platter was not running either.`
      : '');

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <p className="text-subhead text-label-secondary">{summary}</p>

      {/*
        One image with one label, rather than 48 focusable slivers. The sentence above is
        the accessible content; the strip is the picture of it.
      */}
      <div
        aria-label={summary}
        className="flex h-7 w-full items-center gap-px overflow-hidden"
        role="img"
      >
        {buckets.map((bucket) => (
          <span
            className={cn(
              'min-w-0 flex-1 rounded-[1px]',
              STATE_FILL[bucket.state],
              STATE_HEIGHT[bucket.state],
            )}
            key={bucket.start}
            title={`${STATE_WORD[bucket.state]} · ${new Date(bucket.start).toLocaleString(
              undefined,
              {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              },
            )}`}
          />
        ))}
      </div>

      <ul className="flex flex-wrap gap-x-5 gap-y-1">
        {(['running', 'crashed', 'unknown'] as const).map((state) => (
          <li className="flex items-center gap-2 text-caption text-label-tertiary" key={state}>
            <span
              aria-hidden
              className={cn('size-2.5 shrink-0 rounded-[1px]', STATE_FILL[state])}
            />
            {STATE_WORD[state]}
          </li>
        ))}
      </ul>
    </div>
  );
}
