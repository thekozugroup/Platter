import type React from 'react';
import { useId } from 'react';
import { WarningDiamond } from 'pixelarticons/react/WarningDiamond.js';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * A reading against its ceiling — memory used out of memory allocated, disk out of disk.
 *
 * Three things here are not decoration:
 *
 * - **`role="meter"`.** A progress bar means "this task is N% done and will finish"; a meter
 *   means "this value sits at N within a known range". Memory usage is a meter, and screen
 *   readers say something quite different for each. `aria-valuetext` carries the formatted
 *   figures because "3865468928" is not a reading anyone can use.
 * - **The warning is never only a colour.** Around one in twenty-five readers cannot separate
 *   the amber bar from the neutral one, so crossing the threshold also moves a visible tick
 *   mark behind the bar, adds a glyph, and changes the words. Take the colour away entirely
 *   and the meter still says what it means.
 * - **The fill scales rather than resizing.** Animating `width` lays the page out again on
 *   every tick; `transform: scaleX()` is composited. The label beside it is tabular, so the
 *   digits do not shuffle as they change.
 */

export interface LiveMeterProps {
  label: string;
  /** Current reading, in whatever unit `limit` and `format` agree on. */
  value: number;
  /** The ceiling. `null` means no ceiling is configured — a meter would be meaningless. */
  limit: number | null;
  format: (value: number) => string;
  /** Fraction of the limit at which to start warning. */
  warnAt?: number;
  /** Fraction of the limit at which this is a problem now. */
  criticalAt?: number;
  /** What the ceiling is, and what happens on hitting it. One sentence. */
  description?: React.ReactNode;
  /** Shown instead of a reading, with the reason, when no value can be taken. */
  unavailable?: string | undefined;
  isLoading?: boolean;
  className?: string;
}

type MeterLevel = 'normal' | 'warning' | 'critical';

const FILL_TONE: Record<MeterLevel, string> = {
  normal: 'bg-label-secondary',
  warning: 'bg-warning-dot',
  critical: 'bg-danger-dot',
};

const TEXT_TONE: Record<MeterLevel, string> = {
  normal: 'text-label',
  warning: 'text-warning',
  critical: 'text-danger',
};

const LEVEL_WORD: Record<MeterLevel, string> = {
  normal: 'Comfortable',
  warning: 'Getting close to the limit',
  critical: 'At the limit',
};

export function meterLevel(fraction: number, warnAt: number, criticalAt: number): MeterLevel {
  if (fraction >= criticalAt) return 'critical';
  if (fraction >= warnAt) return 'warning';
  return 'normal';
}

export function LiveMeter({
  label,
  value,
  limit,
  format,
  warnAt = 0.8,
  criticalAt = 0.95,
  description,
  unavailable,
  isLoading = false,
  className,
}: LiveMeterProps) {
  const labelId = useId();

  if (isLoading) {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        <Skeleton className="h-5 w-32 rounded-sm" />
        <Skeleton className="h-2.5 w-full rounded-pill" />
        <Skeleton className="h-4 w-48 rounded-sm" />
      </div>
    );
  }

  if (unavailable) {
    return (
      <div className={cn('flex flex-col gap-2', className)}>
        <p className="text-subhead font-medium text-label" id={labelId}>
          {label}
        </p>
        <p className="text-caption text-label-secondary">{unavailable}</p>
      </div>
    );
  }

  // No ceiling means no meter. A bar with an invented maximum would be a guess drawn as a
  // fact, so this falls back to the reading and says the limit is not set.
  if (limit === null || !Number.isFinite(limit) || limit <= 0) {
    return (
      <div className={cn('flex flex-col gap-2', className)}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-subhead font-medium text-label" id={labelId}>
            {label}
          </p>
          <p className="font-mono text-subhead font-medium text-label tabular">{format(value)}</p>
        </div>
        <p className="text-caption text-label-secondary">No limit is set for this reading.</p>
        {description ? <p className="text-caption text-label-tertiary">{description}</p> : null}
      </div>
    );
  }

  const fraction = Math.max(0, Math.min(value / limit, 1));
  const rawFraction = value / limit;
  const level = meterLevel(rawFraction, warnAt, criticalAt);
  const percentLabel = `${Math.round(rawFraction * 100)}%`;
  const valueText = `${format(value)} of ${format(limit)} — ${percentLabel}`;

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="flex items-center gap-1.5 text-subhead font-medium text-label" id={labelId}>
          {level === 'normal' ? null : (
            <WarningDiamond aria-hidden className={cn('size-4 shrink-0', TEXT_TONE[level])} />
          )}
          {label}
        </p>
        <p className={cn('font-mono text-subhead font-medium tabular', TEXT_TONE[level])}>
          {format(value)}
          <span className="text-label-tertiary"> / {format(limit)}</span>
        </p>
      </div>

      <div
        aria-labelledby={labelId}
        aria-valuemax={limit}
        aria-valuemin={0}
        aria-valuenow={value}
        aria-valuetext={valueText}
        className="relative h-2.5 w-full overflow-hidden rounded-pill bg-fill-secondary"
        role="meter"
      >
        {/*
          The threshold tick. Visible whether or not the bar has reached it, so "past the
          line" is legible in greyscale — the non-colour half of the warning signal.
        */}
        <span
          aria-hidden
          className="absolute inset-y-0 z-1 w-px bg-label-quaternary"
          style={{ left: `${warnAt * 100}%` }}
        />
        <span
          aria-hidden
          className={cn(
            'block h-full w-full origin-left rounded-pill',
            'transition-transform duration-[var(--pl-duration-normal)] ease-standard',
            'motion-reduce:transition-none',
            FILL_TONE[level],
          )}
          style={{ transform: `scaleX(${fraction})` }}
        />
      </div>

      <p
        className={cn(
          'text-caption',
          level === 'normal' ? 'text-label-secondary' : TEXT_TONE[level],
        )}
      >
        {LEVEL_WORD[level]} — {percentLabel} used.
      </p>
      {description ? <p className="text-caption text-label-tertiary">{description}</p> : null}
    </div>
  );
}
