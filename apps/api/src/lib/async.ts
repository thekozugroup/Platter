import { setTimeout as delay } from 'node:timers/promises';
import { PlatterError } from '@platter/shared';

/** Rejects with an `AbortError` if the signal fires, and always clears its timer. */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await delay(ms, undefined, signal ? { signal } : undefined);
}

export interface RetryOptions {
  /** Total tries, not extra tries: `attempts: 3` means at most three calls. */
  attempts?: number;
  /** Delay before the second try; each subsequent wait doubles it. */
  baseMs?: number;
  /** Ceiling for a single backoff wait, so a long retry chain stays responsive. */
  maxMs?: number;
  signal?: AbortSignal;
  /** Defaults to `PlatterError.retryable`, falling back to "retry anything unknown". */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Fired before each wait — wire it to a logger to make flaky drivers visible. */
  onRetry?: (error: unknown, attempt: number, waitMs: number) => void;
}

function defaultShouldRetry(error: unknown): boolean {
  return error instanceof PlatterError ? error.retryable : true;
}

/**
 * Exponential backoff with full jitter.
 *
 * Jitter is not decoration: a node coming back after an outage is hit by every server's
 * reconciler at once, and synchronised backoff turns that into a thundering herd that
 * knocks it over again.
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseMs = options.baseMs ?? 200;
  const maxMs = options.maxMs ?? 10_000;
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetry(error, attempt)) throw error;

      const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const waitMs = Math.round(Math.random() * ceiling);
      options.onRetry?.(error, attempt, waitMs);
      await sleep(waitMs, options.signal);
    }
  }

  // Unreachable: the loop either returns or throws. Kept so the function is total.
  throw lastError;
}

/**
 * Caps how long a promise may take.
 *
 * This cannot cancel the underlying work — nothing in JavaScript can — so pass an
 * AbortSignal to the operation itself wherever one is offered and use this as the
 * backstop. Reported as `service_unavailable` because a timeout is a temporary condition
 * the caller may retry, never an opaque 500.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  const controller = new AbortController();
  const timeout = delay(ms, 'timeout' as const, { signal: controller.signal });

  try {
    const result = await Promise.race([promise, timeout]);
    if (result === 'timeout') {
      throw new PlatterError('service_unavailable', message, { retryable: true });
    }
    return result as T;
  } finally {
    // Aborting the sleep both clears the timer and settles its promise, so a slow
    // operation that eventually resolves does not leave the event loop pinned open.
    controller.abort();
  }
}

/**
 * A promise whose settlement is controlled from elsewhere — the shape you need when a
 * request waits on an event that arrives on a socket or a container stream.
 */
export class Deferred<T> {
  readonly promise: Promise<T>;
  private resolveFn!: (value: T | PromiseLike<T>) => void;
  private rejectFn!: (reason: unknown) => void;
  private done = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
  }

  get settled(): boolean {
    return this.done;
  }

  /** Idempotent: a late second settlement from a racing listener is ignored, not an error. */
  resolve(value: T | PromiseLike<T>): void {
    if (this.done) return;
    this.done = true;
    this.resolveFn(value);
  }

  reject(reason: unknown): void {
    if (this.done) return;
    this.done = true;
    this.rejectFn(reason);
  }
}
