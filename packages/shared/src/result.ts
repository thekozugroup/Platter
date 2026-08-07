/**
 * A tiny Result type.
 *
 * `packages/core` deals with a world that fails constantly and predictably: Docker is down, a
 * port is taken, a mod does not exist for this loader. Those are outcomes, not exceptions, and
 * modelling them as values keeps the call sites honest — you cannot forget to handle a `Result`
 * the way you can forget a `try`.
 *
 * Genuine programmer error (a null that should never be null, an unreachable branch) still
 * throws. If you find yourself wrapping a bug in an `err()`, it belongs in a throw.
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E = PlatterError> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

/** Unwrap or throw. Use at the edges (route handlers, CLI) where a throw becomes a 500. */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) {
    return r.value;
  }
  throw r.error instanceof Error ? r.error : new Error(String(r.error));
}

export function mapResult<T, U, E>(r: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return r.ok ? ok(fn(r.value)) : r;
}

/**
 * The error codes Platter uses. Keeping them enumerated (rather than free-form strings) means
 * the UI can map a failure to a useful message and the MCP server can tell a model whether
 * retrying is worthwhile.
 */
export const ERROR_CODES = [
  'docker_unavailable',
  'docker_permission_denied',
  'container_not_found',
  'container_conflict',
  'image_pull_failed',
  'not_found',
  'already_exists',
  'invalid_input',
  'invalid_state',
  'port_unavailable',
  'insufficient_resources',
  'rcon_unavailable',
  'rcon_auth_failed',
  'timeout',
  'path_escape',
  'upstream_error',
  'rate_limited',
  'unauthorized',
  'not_supported',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Whether a caller has any reason to try the same call again. */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'docker_unavailable',
  'image_pull_failed',
  'rcon_unavailable',
  'timeout',
  'upstream_error',
  'rate_limited',
]);

export class PlatterError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PlatterError';
    this.code = code;
    this.details = Object.freeze({ ...options.details });
    this.retryable = RETRYABLE.has(code);
  }

  /** Shape sent over HTTP and returned to MCP clients. */
  toJSON(): { code: ErrorCode; message: string; retryable: boolean; details?: Record<string, unknown> } {
    const base = { code: this.code, message: this.message, retryable: this.retryable };
    return Object.keys(this.details).length > 0 ? { ...base, details: { ...this.details } } : base;
  }
}

export const fail = (
  code: ErrorCode,
  message: string,
  options?: { details?: Record<string, unknown>; cause?: unknown }
): Err<PlatterError> => err(new PlatterError(code, message, options));

/** Normalise anything thrown into a PlatterError so callers get a consistent shape. */
export function toPlatterError(cause: unknown, fallbackCode: ErrorCode = 'internal'): PlatterError {
  if (cause instanceof PlatterError) {
    return cause;
  }
  if (cause instanceof Error) {
    return new PlatterError(fallbackCode, cause.message, { cause });
  }
  return new PlatterError(fallbackCode, String(cause), { cause });
}

/** Run a promise, converting a throw into an `Err`. */
export async function attempt<T>(
  fn: () => Promise<T>,
  fallbackCode: ErrorCode = 'internal'
): Promise<Result<T, PlatterError>> {
  try {
    return ok(await fn());
  } catch (cause) {
    return err(toPlatterError(cause, fallbackCode));
  }
}
