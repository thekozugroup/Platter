import type React from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The empty state.
 *
 * An empty list is the best teaching moment the interface gets, so this is deliberately not
 * a shrug and a dash: it says what the thing is, what will happen when you make one, and
 * offers the action. Never "No data".
 */

export interface StateAction {
  label: string;
  /** Renders an anchor, so the action can be opened in a new tab. Wins over `onClick`. */
  to?: string;
  onClick?: () => void;
  isLoading?: boolean;
  /**
   * Disables the action AND explains why, in visible text under the button. A disabled
   * control with no reason attached is the most common dead end in an ops tool.
   */
  disabledReason?: string;
}

export interface StateActionButtonProps {
  action: StateAction;
  variant?: 'primary' | 'secondary';
  className?: string;
}

/** Shared by `EmptyState` and `ErrorState` so the two never drift apart. */
export function StateActionButton({
  action,
  variant = 'primary',
  className,
}: StateActionButtonProps) {
  const shared = cn(
    'h-11 rounded-button px-5 text-subhead font-medium',
    className,
  );
  const disabled = Boolean(action.disabledReason);
  const reasonId = disabled ? `state-action-${action.label.replace(/\W+/g, '-')}` : undefined;

  if (action.to && !disabled && !action.isLoading) {
    return (
      <Button
        asChild
        className={shared}
        size="lg"
        variant={variant === 'primary' ? 'default' : 'outline'}
      >
        <Link to={action.to}>{action.label}</Link>
      </Button>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <Button
        {...(reasonId ? { 'aria-describedby': reasonId } : {})}
        className={shared}
        disabled={disabled}
        isLoading={action.isLoading ?? false}
        onClick={action.onClick ?? (() => undefined)}
        size="lg"
        variant={variant === 'primary' ? 'default' : 'outline'}
      >
        {action.label}
      </Button>
      {action.disabledReason ? (
        <p className="max-w-xs text-center text-caption text-label-tertiary" id={reasonId}>
          {action.disabledReason}
        </p>
      ) : null}
    </div>
  );
}

export interface EmptyStateProps {
  /** A pixelarticons glyph. Optional — a good headline usually carries more than an icon. */
  icon?: React.ReactNode;
  title: string;
  /** One or two sentences. Say what this list holds and what making one does. */
  description: React.ReactNode;
  action?: StateAction;
  secondaryAction?: StateAction;
  /** Anything extra — a short list of what happens next, a doc link. */
  children?: React.ReactNode;
  /** `sm` sits inside a card; `md` fills a page. */
  size?: 'sm' | 'md';
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  children,
  size = 'md',
  className,
}: EmptyStateProps) {
  return (
    <section
      className={cn(
        'flex flex-col items-center justify-center text-center',
        size === 'md' ? 'gap-4 px-6 py-16 sm:py-24' : 'gap-3 px-4 py-10',
        className,
      )}
    >
      {icon ? (
        <span
          aria-hidden
          className={cn(
            'flex items-center justify-center rounded-md bg-fill-tertiary text-label-tertiary',
            size === 'md' ? 'size-12 [&_svg]:size-6' : 'size-10 [&_svg]:size-5',
          )}
        >
          {icon}
        </span>
      ) : null}

      {/*
        h2, not a styled div: an empty state is a real section of the page. At 20px the
        pixel display face stops being legible, so the compact size drops back to bold sans.
      */}
      <h2
        className={cn(
          'text-label',
          size === 'md' ? 'text-title-2' : 'font-sans text-title-3 font-semibold',
        )}
      >
        {title}
      </h2>

      <p
        className={cn(
          'max-w-prose text-balance text-label-secondary',
          size === 'md' ? 'text-body' : 'text-subhead',
        )}
      >
        {description}
      </p>

      {children}

      {action || secondaryAction ? (
        <div className="mt-2 flex flex-wrap items-start justify-center gap-3">
          {action ? <StateActionButton action={action} /> : null}
          {secondaryAction ? (
            <StateActionButton action={secondaryAction} variant="secondary" />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
