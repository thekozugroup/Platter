import type { ErrorCode } from '@platter/shared';
import { ApiError, NetworkError, errorMessage } from '@/lib/api-client.js';
import { StateActionButton } from '@/components/common/empty-state';
import { cn } from '@/lib/utils';

/**
 * The error state.
 *
 * Three things, in this order: what happened, why it happened, what to do next. The request
 * id comes last and in monospace, because the only person who needs it is the one reading
 * the server log alongside it.
 *
 * Retry is offered only when retrying could plausibly work. A retry button on a 403 is a
 * lie, and pressing it three times before reading the message is what people actually do.
 */

/** What to do about it. Keyed by code so copy can change without changing behaviour. */
const RECOVERY: Partial<Record<ErrorCode, string>> = {
  unauthenticated: 'Sign in again to continue.',
  invalid_credentials: 'Check the email and password, then try again.',
  token_expired: 'Your session ended. Sign in again.',
  forbidden: 'Ask an administrator to grant you access, or switch to an account that has it.',
  not_found: 'It may have been deleted. Go back and reload the list.',
  conflict: 'Reload to pick up the current state, then try again.',
  already_exists: 'Pick a different name.',
  invalid_state: 'Wait for the current operation to finish, then try again.',
  rate_limited: 'Wait about a minute before trying again.',
  payload_too_large: 'Split the upload, or use a smaller file.',
  node_unreachable: 'Check that the node is up and its Docker socket is reachable.',
  driver_error: "Check the node's Docker daemon logs for the underlying error.",
  insufficient_resources: 'Free memory or disk on the node, or lower this server’s limits.',
  no_allocation_available: "Widen the node's port range, or free a port from another server.",
  ai_unavailable: 'Set an AI provider key in admin settings to turn these features on.',
  ai_rate_limited: 'Wait a moment and send it again.',
  validation_failed: 'Correct the highlighted fields and submit again.',
  internal_error: 'If it keeps happening, check the API logs with the request id below.',
  service_unavailable: 'The API is restarting or overloaded. Try again shortly.',
  not_implemented: 'This part of Platter is not built yet.',
};

/** A short, blameless headline. Never "Oops". */
const HEADLINE: Partial<Record<ErrorCode, string>> = {
  unauthenticated: 'You are signed out',
  invalid_credentials: 'That did not sign you in',
  token_expired: 'Your session expired',
  forbidden: 'You do not have access',
  not_found: 'Not found',
  conflict: 'That conflicts with something else',
  already_exists: 'That already exists',
  invalid_state: 'Not available right now',
  rate_limited: 'Too many requests',
  node_unreachable: 'The node is not responding',
  driver_error: 'Docker returned an error',
  insufficient_resources: 'The node is out of room',
  no_allocation_available: 'No free ports left',
  validation_failed: 'Some fields need attention',
  internal_error: 'Something broke on the server',
  service_unavailable: 'Temporarily unavailable',
};

export interface ErrorStateProps {
  error: unknown;
  /** Overrides the derived headline when the screen knows better. */
  title?: string;
  onRetry?: () => void;
  isRetrying?: boolean;
  /** `page` fills the content region; `inline` sits inside a card or panel. */
  variant?: 'page' | 'inline';
  className?: string;
}

export function ErrorState({
  error,
  title,
  onRetry,
  isRetrying = false,
  variant = 'page',
  className,
}: ErrorStateProps) {
  const apiError = error instanceof ApiError ? error : null;
  const isNetwork = error instanceof NetworkError;

  function deriveHeadline(): string {
    if (title) return title;
    if (isNetwork) return "Can't reach Platter";
    if (apiError) return HEADLINE[apiError.code] ?? 'That did not work';
    return 'That did not work';
  }
  const headline = deriveHeadline();

  const detail = errorMessage(error);
  const recovery = isNetwork
    ? 'Check your connection, then retry. If the API is on another machine, check it is still running.'
    : apiError
      ? RECOVERY[apiError.code]
      : undefined;

  const retryable = isNetwork || (apiError?.retryable ?? false);
  const showRetry = Boolean(onRetry) && retryable;

  return (
    <section
      className={cn(
        'flex flex-col items-center justify-center gap-3 text-center',
        variant === 'page' ? 'px-6 py-16 sm:py-24' : 'px-4 py-10',
        className,
      )}
      // Errors that replace content mid-flight have to be announced, not just drawn.
      aria-live="polite"
      role="alert"
    >
      <h2
        className={cn(
          'text-label',
          variant === 'page' ? 'text-title-2' : 'font-sans text-title-3 font-semibold',
        )}
      >
        {headline}
      </h2>

      <p className="max-w-prose text-balance text-body text-label-secondary">{detail}</p>
      {recovery ? (
        <p className="max-w-prose text-balance text-subhead text-label-tertiary">{recovery}</p>
      ) : null}

      {showRetry && onRetry ? (
        <div className="mt-2">
          <StateActionButton
            action={{ label: 'Try again', onClick: onRetry, isLoading: isRetrying }}
            variant="secondary"
          />
        </div>
      ) : null}

      {apiError?.requestId ? (
        <p className="mt-2 font-mono text-caption text-label-quaternary">
          Request {apiError.requestId}
        </p>
      ) : null}
    </section>
  );
}
