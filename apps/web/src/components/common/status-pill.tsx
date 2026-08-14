import type React from 'react';
import type { ServerStatus } from '@platter/shared';
import { isTransitional } from '@platter/shared';
import { cn } from '@/lib/utils';

/**
 * The status capsule: a light grey pill holding a coloured dot and a word.
 *
 * Colour is never the signal on its own. Around one in twenty-five people using this cannot
 * separate the green dot from the red one, so the word is always present, `running` breathes
 * and `crashed` carries a filled ring. Take any two of those three away and the component is
 * broken, not merely plainer.
 */

export type StatusTone = 'success' | 'warning' | 'danger' | 'neutral';

export const SERVER_STATUS_LABELS: Record<ServerStatus, string> = {
  provisioning: 'Provisioning',
  installing: 'Installing',
  install_failed: 'Install failed',
  offline: 'Offline',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  restarting: 'Restarting',
  crashed: 'Crashed',
  suspended: 'Suspended',
  deleting: 'Deleting',
};

const SERVER_STATUS_TONES: Record<ServerStatus, StatusTone> = {
  provisioning: 'warning',
  installing: 'warning',
  install_failed: 'danger',
  offline: 'neutral',
  starting: 'warning',
  running: 'success',
  stopping: 'warning',
  restarting: 'warning',
  crashed: 'danger',
  suspended: 'neutral',
  deleting: 'warning',
};

/** One-line explanation of what the server is actually doing, for tooltips and captions. */
export const SERVER_STATUS_HINTS: Record<ServerStatus, string> = {
  provisioning: 'Creating the container and its volume.',
  installing: "Running the blueprint's install script.",
  install_failed: 'The install script exited non-zero. Reinstall to try again.',
  offline: 'The container exists but is not running.',
  starting: 'Booting. It is up once the blueprint sees its ready line.',
  running: 'Up and accepting players.',
  stopping: 'Shutting down gracefully.',
  restarting: 'Stopping, then starting again.',
  crashed: 'The process exited unexpectedly.',
  suspended: 'An administrator suspended this server.',
  deleting: 'Removing the container and its volume.',
};

export function serverStatusTone(status: ServerStatus): StatusTone {
  return SERVER_STATUS_TONES[status];
}

const DOT_TONE: Record<StatusTone, string> = {
  success: 'bg-success-dot',
  warning: 'bg-warning-dot',
  danger: 'bg-danger-dot',
  neutral: 'bg-neutral-status',
};

/**
 * The word stays near-black in every tone. Painting it the status colour turns the label
 * into a *second* colour channel when its whole job is to be the redundant one — and the
 * muted greens and ambers this system uses are 3.3:1 on the pill, under AA for text. The
 * dot carries the colour; the ring and the pulse carry the rest.
 */
const LABEL_TONE = 'text-label';

export interface StatusCapsuleProps {
  tone: StatusTone;
  /** The word. Always present — colour is never the only signal. */
  children: React.ReactNode;
  /** `sm` for table rows and dense cards; `md` for a page header. */
  size?: 'sm' | 'md';
  /** Breathes, for a healthy live thing. `running`, `online`, an active account. */
  pulse?: boolean;
  /**
   * A ring around the dot. The non-colour half of a bad or in-between signal: it survives
   * greyscale and colour blindness, where a hue swap does not.
   */
  ring?: 'danger' | 'warning' | undefined;
  title?: string | undefined;
  className?: string;
  role?: 'status';
  'aria-live'?: 'polite';
  /** Lets a caller's own vocabulary be asserted on, and styled, without a second class. */
  'data-status'?: string;
}

/**
 * The capsule itself, without the server-status vocabulary.
 *
 * It exists because three screens had already hand-rolled this shape — node health, account
 * active/suspended, server status — and each copy had to rediscover that **the word stays
 * `text-label`**. Two of them did not: painting the label `text-success` measured 3.31:1 on
 * the pill, and `text-warning` 3.77:1, both under AA at 12–13px. A status vocabulary that is
 * not `ServerStatus` is a fine reason to reach for this; it is not a reason to redraw the
 * pill.
 */
export function StatusCapsule({
  tone,
  children,
  size = 'sm',
  pulse = false,
  ring,
  title,
  className,
  ...live
}: StatusCapsuleProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill',
        'border border-pill-border bg-pill font-medium',
        size === 'sm' ? 'h-6 px-2 text-caption' : 'h-7 px-2.5 text-footnote',
        LABEL_TONE,
        className,
      )}
      {...(title ? { title } : {})}
      {...live}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-2 shrink-0 rounded-full',
          DOT_TONE[tone],
          pulse && 'status-pulse',
          ring === 'danger' && 'ring-2 ring-danger/30',
          ring === 'warning' && 'ring-2 ring-warning/25',
        )}
      />
      {children}
    </span>
  );
}

export interface StatusDotProps {
  status: ServerStatus;
  /** Renders the label for assistive tech only. Set false when a visible word sits next to it. */
  labelled?: boolean;
  className?: string;
}

/**
 * The bare dot, for dense rows where the word would not fit. It still carries its label —
 * just visually hidden — so the sidebar is readable with a screen reader.
 */
export function StatusDot({ status, labelled = true, className }: StatusDotProps) {
  const tone = serverStatusTone(status);
  const label = SERVER_STATUS_LABELS[status];

  return (
    <span className={cn('relative inline-flex shrink-0 items-center justify-center', className)}>
      <span
        aria-hidden="true"
        className={cn(
          'size-2 rounded-full',
          DOT_TONE[tone],
          status === 'running' && 'status-pulse',
          // A ring rather than a second colour: it survives greyscale and colour blindness.
          status === 'crashed' && 'ring-2 ring-danger/30',
          isTransitional(status) && status !== 'running' && 'ring-2 ring-warning/25',
        )}
      />
      {labelled ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}

export interface StatusPillProps {
  status: ServerStatus;
  /** `sm` for table rows and dense cards; `md` for a page header. */
  size?: 'sm' | 'md';
  /**
   * Announce the status when it changes in place. Use on a page that is watching one server
   * boot; leave off in a list, where twelve live regions would talk over each other.
   */
  live?: boolean;
  /** Override the word. Only for genuinely different vocabulary, never for shorthand. */
  label?: string;
  className?: string;
}

export function StatusPill({
  status,
  size = 'sm',
  live = false,
  label,
  className,
}: StatusPillProps) {
  const text = label ?? SERVER_STATUS_LABELS[status];

  return (
    <StatusCapsule
      className={className}
      data-status={status}
      pulse={status === 'running'}
      ring={
        status === 'crashed'
          ? 'danger'
          : isTransitional(status) && status !== 'running'
            ? 'warning'
            : undefined
      }
      size={size}
      title={SERVER_STATUS_HINTS[status]}
      tone={serverStatusTone(status)}
      {...(live ? { role: 'status' as const, 'aria-live': 'polite' as const } : {})}
    >
      {text}
    </StatusCapsule>
  );
}
