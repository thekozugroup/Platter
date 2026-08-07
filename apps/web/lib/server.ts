import 'server-only';
import { type Context, createContext } from '@platter/core';
import { type PlatterError, isErr } from '@platter/shared';

/**
 * The request-side accessor for Platter's runtime context.
 *
 * `createContext` is idempotent — the database handle is a process singleton and the Docker
 * client is cheap — so this memoises the promise rather than the value. Memoising the promise
 * matters: two server components rendering concurrently on a cold start would otherwise both
 * run migrations.
 */
let pending: Promise<Context> | undefined;
let lastError: PlatterError | undefined;

export async function getContext(): Promise<Context> {
  if (!pending) {
    pending = createContext().then((result) => {
      if (isErr(result)) {
        lastError = result.error;
        pending = undefined; // Allow a retry once Docker comes back.
        throw result.error;
      }
      lastError = undefined;
      return result.value;
    });
  }
  return pending;
}

/**
 * Context, or the reason there isn't one.
 *
 * Pages use this instead of `getContext` so that a stopped Docker daemon renders an explanation
 * with a fix rather than an error boundary. "Docker isn't running" is a completely normal state
 * for a local app and deserves a real answer, not a stack trace.
 */
export async function tryGetContext(): Promise<
  { ok: true; context: Context } | { ok: false; error: PlatterError }
> {
  try {
    return { ok: true, context: await getContext() };
  } catch (error) {
    const platterError = (lastError ?? error) as PlatterError;
    return { ok: false, error: platterError };
  }
}
