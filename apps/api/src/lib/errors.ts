import { PlatterError } from '@platter/shared';
import type { ErrorCode } from '@platter/shared';
import type { z } from 'zod';

/**
 * Constructors for the failures routes actually raise. They exist so a handler never has
 * to remember which `ErrorCode` goes with which situation, and so the copy that reaches a
 * user is written once rather than at forty call sites.
 */

/**
 * Deliberately says nothing about *why* it is missing. `not_found` is also the answer when
 * a caller may not see a resource, so the message must read the same in both cases.
 */
export function notFound(what: string): PlatterError {
  return new PlatterError('not_found', `That ${what} does not exist.`);
}

export function badRequest(message: string, details?: Record<string, string[]>): PlatterError {
  return new PlatterError('bad_request', message, details ? { details } : {});
}

export function forbidden(message = "You don't have access to this."): PlatterError {
  return new PlatterError('forbidden', message);
}

export function unauthenticated(message = 'Please sign in to continue.'): PlatterError {
  return new PlatterError('unauthenticated', message);
}

export function invalidCredentials(
  message = 'That email or password is incorrect.',
  details?: Record<string, string[]>,
): PlatterError {
  return new PlatterError('invalid_credentials', message, details ? { details } : {});
}

export function tokenExpired(message = 'Your session expired. Sign in again.'): PlatterError {
  return new PlatterError('token_expired', message);
}

export function alreadyExists(what: string): PlatterError {
  return new PlatterError('already_exists', `That ${what} is already taken.`);
}

export function conflict(message: string): PlatterError {
  return new PlatterError('conflict', message);
}

/** The resource exists but is in a state that forbids the action (installing, suspended, …). */
export function invalidState(message: string): PlatterError {
  return new PlatterError('invalid_state', message);
}

export function validationFailed(details: Record<string, string[]>): PlatterError {
  return new PlatterError('validation_failed', 'Some fields need attention.', { details });
}

/** Wraps an unexpected failure so the cause is logged but never serialised to a client. */
export function internal(message: string, cause?: unknown): PlatterError {
  return new PlatterError('internal_error', message, { cause });
}

/** Narrows away null/undefined at a route boundary, raising the 404 the caller expects. */
export function orNotFound<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw notFound(what);
  return value;
}

// ---------------------------------------------------------------------------
// Foreign error translation
// ---------------------------------------------------------------------------

/**
 * Matched structurally rather than with `instanceof`. pnpm can resolve more than one copy
 * of `@prisma/client` in a workspace, and a prototype mismatch there would silently turn
 * every unique-constraint violation into a 500.
 */
export interface PrismaKnownError {
  name: string;
  code: string;
  message: string;
  meta?: Record<string, unknown>;
}

export function isPrismaKnownError(error: unknown): error is PrismaKnownError {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === 'PrismaClientKnownRequestError' &&
    typeof candidate.code === 'string' &&
    candidate.code.startsWith('P')
  );
}

const PRISMA_CODES: Record<string, ErrorCode> = {
  // Unique constraint failed.
  P2002: 'already_exists',
  // Foreign key constraint failed — the row points at something that is gone.
  P2003: 'conflict',
  // Value too long for the column.
  P2000: 'bad_request',
  // A required relation would be violated by the delete (our Restrict rules).
  P2014: 'conflict',
  // Record required by the operation was not found.
  P2025: 'not_found',
};

/**
 * Prisma messages name tables and columns. They are useful in a log and dangerous in a
 * response, so only the code crosses the boundary — the message is written by us.
 */
const PRISMA_MESSAGES: Record<string, string> = {
  P2002: 'That already exists.',
  P2003: 'Something this depends on no longer exists.',
  P2000: 'One of those values is too long.',
  P2014: 'Something still depends on this. Remove it first.',
  P2025: 'We could not find that.',
};

export function fromPrismaError(error: PrismaKnownError): PlatterError {
  const code = PRISMA_CODES[error.code] ?? 'internal_error';
  const message = PRISMA_MESSAGES[error.code] ?? 'Something went wrong on our end.';
  return new PlatterError(code, message, { cause: error });
}

/** Field-level detail keyed by dotted path, the shape `ApiErrorBody.details` promises. */
export function zodDetails(error: z.ZodError<unknown>): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.map((part) => String(part)).join('.') : '_';
    const existing = details[key];
    if (existing) existing.push(issue.message);
    else details[key] = [issue.message];
  }
  return details;
}

/**
 * Last-resort translation for anything that reaches the error handler. Unknown errors
 * stay `internal_error` on purpose: an error we did not anticipate is not one whose
 * message we can vouch for.
 */
export function toPlatterError(error: unknown): PlatterError {
  if (error instanceof PlatterError) return error;
  if (isPrismaKnownError(error)) return fromPrismaError(error);
  return internal('Something went wrong on our end.', error);
}

export { PlatterError };
