/**
 * Stable, machine-readable error codes.
 *
 * The web client switches on `code` (never on the message) so copy can change without
 * breaking behaviour, and so the UI can offer the right recovery action for each failure.
 */
export const ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'unauthenticated',
  'invalid_credentials',
  'token_expired',
  'forbidden',
  'not_found',
  'conflict',
  'already_exists',
  'invalid_state',
  'rate_limited',
  'payload_too_large',
  'unsupported_media_type',
  'node_unreachable',
  'driver_error',
  'insufficient_resources',
  'no_allocation_available',
  'ai_unavailable',
  'ai_rate_limited',
  'internal_error',
  'not_implemented',
  'service_unavailable',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthenticated: 401,
  invalid_credentials: 401,
  token_expired: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  already_exists: 409,
  invalid_state: 409,
  rate_limited: 429,
  payload_too_large: 413,
  unsupported_media_type: 415,
  node_unreachable: 502,
  driver_error: 502,
  insufficient_resources: 507,
  no_allocation_available: 409,
  ai_unavailable: 503,
  ai_rate_limited: 429,
  internal_error: 500,
  not_implemented: 501,
  service_unavailable: 503,
};

/** The single error envelope every non-2xx API response uses. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Field-level detail for `validation_failed`, keyed by dotted path. */
    details?: Record<string, string[]>;
    /** Correlates a user-visible failure with a server log line. */
    requestId?: string;
  };
}

/**
 * Error thrown across the API. Carries an `ErrorCode` so the HTTP layer never has to
 * guess a status, and so the client gets a stable discriminant.
 */
export class PlatterError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, string[]>;
  /** Set for errors that are worth retrying (driver hiccups, upstream timeouts). */
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, string[]>; cause?: unknown; retryable?: boolean } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'PlatterError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    if (options.details) this.details = options.details;
    this.retryable = options.retryable ?? RETRYABLE_CODES.includes(code);
  }

  toBody(requestId?: string): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
  }
}

const RETRYABLE_CODES: readonly ErrorCode[] = [
  'node_unreachable',
  'driver_error',
  'rate_limited',
  'ai_rate_limited',
  'service_unavailable',
];

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const err = (value as { error: unknown }).error;
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'string' &&
    typeof (err as { message?: unknown }).message === 'string'
  );
}

/** Copy shown to a human when only a code is available. Keep these calm and actionable. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  bad_request: 'That request could not be understood.',
  validation_failed: 'Some fields need attention.',
  unauthenticated: 'Please sign in to continue.',
  invalid_credentials: 'That email or password is incorrect.',
  token_expired: 'Your session expired. Sign in again.',
  forbidden: "You don't have access to this.",
  not_found: 'We could not find that.',
  conflict: 'That conflicts with something that already exists.',
  already_exists: 'That already exists.',
  invalid_state: "This server is busy — that action isn't available right now.",
  rate_limited: 'Too many requests. Give it a moment.',
  payload_too_large: 'That file is too large.',
  unsupported_media_type: "That file type isn't supported.",
  node_unreachable: 'The host node is not responding.',
  driver_error: 'The container runtime returned an error.',
  insufficient_resources: 'The node does not have enough resources left.',
  no_allocation_available: 'No free ports left on this node.',
  ai_unavailable: 'AI features are not configured.',
  ai_rate_limited: 'The AI provider is rate limiting us. Try again shortly.',
  internal_error: 'Something went wrong on our end.',
  not_implemented: 'That is not supported yet.',
  service_unavailable: 'Temporarily unavailable. Try again shortly.',
};
