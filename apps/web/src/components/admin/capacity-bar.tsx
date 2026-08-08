import type React from 'react';
import { useId } from 'react';
import { WarningDiamond } from 'pixelarticons/react/WarningDiamond.js';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * Node capacity, drawn as three different numbers rather than one percentage.
 *
 * - **Used** is what the driver reports containers are consuming right now.
 * - **Allocated** is what Platter has promised to servers, whether or not they are running —
 *   this is the figure that actually blocks a new server from being placed on this node.
 * - **Free** is what remains of the node's total once allocation is subtracted.
 *
 * Conflating any two of those is how an admin either double-books a node or leaves it idle
 * while believing it is full, so the bar never reduces them to a single fill. `role="meter"`
 * speaks to allocation against the total — the actionable reading — and `aria-valuetext`
 * spells out all three figures, because a screen reader cannot infer "free" from a percentage.
 * The figures are repeated in plain text above the bar and in a labelled legend below it, so a
 * sighted reader never has to interpret an unlabelled shape either.
 *
 * The warning and full thresholds get a second signal beyond colour: a tick mark at the warn
 * threshold that is visible whether or not the bar has reached it, a glyph, and a change of
 * words — the same idiom `components/monitoring/live-meter.tsx` uses, so a meter reads the
 * same way everywhere in Platter.
 */

export type CapacityLevel = 'normal' | 'warning' | 'critical';

export function capacityLevel(fraction: number, warnAt: number, criticalAt: number): CapacityLevel {
  if (fraction >= criticalAt) return 'critical';
  if (fraction >= warnAt) return 'warning';
  return 'normal';
}

const FILL_TONE: Record<CapacityLevel, string> = {
  normal: 'bg-label-secondary',
  warning: 'bg-warning-dot',
  critical: 'bg-danger-dot',
};

const TEXT_TONE: Record<CapacityLevel, string> = {
  normal: 'text-label',
  warning: 'text-warning',
  critical: 'text-danger',
};

const LEVEL_WORD: Record<CapacityLevel, string> = {
  normal: 'Comfortable',
  warning: 'Filling up',
  critical: 'Full',
};

export interface CapacityBarProps {
  label: string;
  /** What the driver reports is actually in use right now. */
  used: number;
  /** What Platter has promised to servers, running or not. Governs whether a new server fits. */
  allocated: number;
  /** The node's total capacity for this resource. */
  total: number;
  format: (value: number) => string;
  /** Fraction of `total` at which allocation starts being worth a look. */
  warnAt?: number;
  /** Fraction of `total` at which a new server will not fit. */
  criticalAt?: number;
  description?: React.ReactNode;
  /** Shown instead of a reading, with the reason, when no figure can be read. */
  unavailable?: string | undefined;
  isLoading?: boolean;
  className?: string;
}

export function CapacityBar({
  label,
  used,
  allocated,
  total,
  format,
  warnAt = 0.8,
  criticalAt = 0.95,
  description,
  unavailable,
  isLoading = false,
  className,
}: CapacityBarProps) {
  const labelId = useId();

  if (isLoading) {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        <Skeleton className="h-5 w-32 rounded-sm" />
        <Skeleton className="h-2.5 w-full rounded-pill" />
        <Skeleton className="h-4 w-56 rounded-sm" />
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

  // No total means nothing to measure against — a bar with an invented ceiling would be a
  // guess drawn as a fact.
  if (!Number.isFinite(total) || total <= 0) {
    return (
      <div className={cn('flex flex-col gap-2', className)}>
        <p className="text-subhead font-medium text-label" id={labelId}>
          {label}
        </p>
        <p className="text-caption text-label-secondary">
          Platter has not detected a capacity figure for this yet.
        </p>
        {description ? <p className="text-caption text-label-tertiary">{description}</p> : null}
      </div>
    );
  }

  const safeUsed = Math.max(0, used);
  // Allocation should always cover current use; a stale or racy reading must not draw a
  // "used" segment that overruns the paler "allocated" segment behind it.
  const safeAllocated = Math.max(safeUsed, allocated, 0);
  const usedFraction = Math.max(0, Math.min(safeUsed / total, 1));
  const allocatedFraction = Math.max(0, Math.min(safeAllocated / total, 1));
  const freeAmount = Math.max(0, total - safeAllocated);

  const rawFraction = safeAllocated / total;
  const level = capacityLevel(rawFraction, warnAt, criticalAt);
  const percentLabel = `${Math.round(allocatedFraction * 100)}%`;
  const valueText =
    `${format(safeUsed)} used, ${format(safeAllocated)} allocated, ${format(freeAmount)} free ` +
    `of ${format(total)} — ${percentLabel} allocated`;

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {/*
        Label and figures stack, always — they do not share a line even when they would fit.
        Three of these sit side by side on a node card, and "3.5 GB used · 9.5 GB allocated ·
        6.5 GB free" is long enough to wrap where "0 B used · 16 GB allocated · 236 GB free"
        is not. Inline, that pushed one bar 26px below its neighbours and the row read as a
        mistake. A fixed two-line header keeps every bar, caption and legend on one baseline
        regardless of how the numbers format.
      */}
      <div className="flex flex-col gap-0.5">
        <p className="flex items-center gap-1.5 text-subhead font-medium text-label" id={labelId}>
          {level === 'normal' ? null : (
            <WarningDiamond aria-hidden className={cn('size-4 shrink-0', TEXT_TONE[level])} />
          )}
          {label}
        </p>
        <p className="tabular font-mono text-caption text-label-secondary">
          {format(safeUsed)} used · {format(safeAllocated)} allocated · {format(freeAmount)} free
        </p>
      </div>

      <div
        aria-labelledby={labelId}
        aria-valuemax={total}
        aria-valuemin={0}
        aria-valuenow={Math.round(safeAllocated)}
        aria-valuetext={valueText}
        className="relative h-2.5 w-full overflow-hidden rounded-pill bg-fill-secondary"
        role="meter"
      >
        {/* The threshold tick: visible whether or not the bar has reached it, so "past the
            line" is legible in greyscale — the non-colour half of the warning signal. */}
        <span
          aria-hidden
          className="absolute inset-y-0 z-10 w-px bg-label-quaternary"
          style={{ left: `${warnAt * 100}%` }}
        />
        {/* Allocated (including used): the paler layer, laid down first. */}
        <span
          aria-hidden
          className={cn(
            'absolute inset-0 origin-left rounded-pill opacity-40',
            'transition-transform duration-[var(--pl-duration-normal)] ease-standard',
            'motion-reduce:transition-none',
            FILL_TONE[level],
          )}
          style={{ transform: `scaleX(${allocatedFraction})` }}
        />
        {/* Used: solid, painted over the allocated layer. Two opacities of the same shape
            read as one bar with a seam, not as two competing colours. */}
        <span
          aria-hidden
          className={cn(
            'absolute inset-0 origin-left rounded-pill',
            'transition-transform duration-[var(--pl-duration-normal)] ease-standard',
            'motion-reduce:transition-none',
            FILL_TONE[level],
          )}
          style={{ transform: `scaleX(${usedFraction})` }}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p
          className={cn(
            'text-caption',
            level === 'normal' ? 'text-label-secondary' : TEXT_TONE[level],
          )}
        >
          {LEVEL_WORD[level]} — {percentLabel} allocated.
        </p>
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          <li className="flex items-center gap-1.5 text-caption text-label-tertiary">
            <span aria-hidden className={cn('size-2 rounded-full', FILL_TONE[level])} />
            Used
          </li>
          <li className="flex items-center gap-1.5 text-caption text-label-tertiary">
            <span aria-hidden className={cn('size-2 rounded-full opacity-40', FILL_TONE[level])} />
            Allocated
          </li>
          <li className="flex items-center gap-1.5 text-caption text-label-tertiary">
            <span aria-hidden className="size-2 rounded-full border border-separator-strong" />
            Free
          </li>
        </ul>
      </div>

      {description ? <p className="text-caption text-label-tertiary">{description}</p> : null}
    </div>
  );
}
