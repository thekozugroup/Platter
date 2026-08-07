import { type Logger, logger as rootLogger, type Result, fail, ok } from '@platter/shared';
import type { z } from 'zod';

/**
 * The fetch layer both provider clients sit on.
 *
 * Everything here exists because of something a real API did to us:
 *
 *   - **Every response is parsed with Zod.** Modrinth's `Mod.rating` vanished from the wire
 *     while remaining in the docs; CurseForge types `downloadUrl` as non-nullable and returns
 *     null. A cast would have propagated both silently into the compatibility engine. A parse
 *     failure returns `upstream_error` carrying the issue list, which is how we find out that a
 *     third party changed shape — ideally from a log line rather than a bug report.
 *   - **429 is honoured, not guessed at.** Modrinth publishes `x-ratelimit-reset` (seconds to
 *     window reset) and both may send `Retry-After`. Backing off by our own schedule when the
 *     server told us the exact number is how a client gets IP-banned.
 *   - **A token bucket sits in front of the socket.** Modrinth allows 300 req/min per IP.
 *     Resolving one dependency graph can issue dozens of calls, and the retry loop cannot save
 *     you from a burst you should never have sent.
 *   - **404 bodies are empty.** Modrinth returns a zero-length 404 body, CurseForge a
 *     zero-length 403. `response.json()` throws on both, so the body is read as text first.
 */

/**
 * Sent on every request. Modrinth's docs ask for
 * `github_username/project_name/version (contact)` and explicitly reserve the right to block
 * generic agents; enforcement is soft today and there is no reason to be on the wrong side of
 * it when it hardens.
 *
 * Hardcoded rather than read from package.json: an ESM JSON import needs import attributes and
 * a bundler that agrees about them, and this string is not worth that.
 */
export const PLATTER_VERSION = '0.1.0';
export const USER_AGENT = `thekozugroup/platter/${PLATTER_VERSION} (+https://github.com/thekozugroup/Platter)`;

/* -------------------------------------------------------------------------- */
/* Token bucket                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Classic token bucket: `capacity` tokens, refilled continuously at `refillPerSecond`.
 *
 * Continuous refill rather than a fixed window because a window resets all at once, which
 * encourages exactly the burst it is meant to prevent — 300 requests fired in the first second
 * of every minute is technically within a 300/min limit and is still the traffic shape that
 * gets a client blocked.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  /** Milliseconds until a token is available; 0 when one is free right now. */
  private refill(): void {
    const at = this.now();
    const elapsedSeconds = Math.max(0, at - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefill = at;
  }

  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** How long to wait before `tryTake()` would succeed. */
  delayMs(): number {
    this.refill();
    if (this.tokens >= 1) {
      return 0;
    }
    return Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
  }

  get available(): number {
    this.refill();
    return this.tokens;
  }
}

/* -------------------------------------------------------------------------- */
/* TTL cache                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * In-memory, URL-keyed, GET-only.
 *
 * Deliberately stores the *raw parsed JSON*, not the Zod output. Zod produces fresh mutable
 * objects; handing the same instance to two callers means one of them can corrupt the other's
 * data. Re-running the schema on a cache hit costs microseconds and removes that whole class of
 * bug.
 *
 * Note for CurseForge specifically: their third-party terms read as forbidding persisting API
 * data at all. A short-lived in-process cache that only exists to avoid hammering them is the
 * conservative reading, and it is why `curseforge.ts` configures a much shorter TTL than
 * Modrinth does rather than reusing the default.
 */
export class TtlCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(
    private readonly maxEntries = 500,
    private readonly now: () => number = Date.now
  ) {}

  get(key: string): { hit: true; value: unknown } | { hit: false } {
    const entry = this.entries.get(key);
    if (!entry) {
      return { hit: false };
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return { hit: false };
    }
    // Refresh insertion order so the hot keys survive eviction.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { hit: true, value: entry.value };
  }

  set(key: string, value: unknown, ttlMs: number): void {
    if (ttlMs <= 0) {
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  /** Overrides the client default. 0 disables caching for this call. */
  ttlMs?: number;
  signal?: AbortSignal;
}

export interface HttpClientOptions {
  baseUrl: string;
  /** Merged into every request. Auth headers belong here. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Attempts *after* the first. 0 disables retrying. */
  maxRetries?: number;
  baseBackoffMs?: number;
  /** Refuse to sleep longer than this; return `rate_limited` instead of hanging a request. */
  maxBackoffMs?: number;
  rateLimit?: { capacity: number; refillPerSecond: number };
  defaultTtlMs?: number;
  maxCacheEntries?: number;
  /** Injected in tests. Everything below this line exists so the suite needs no network. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Statuses worth trying again. 408 and 425 are included; every other 4xx is our fault. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly defaultTtlMs: number;
  private readonly bucket: TokenBucket | undefined;
  private readonly cache: TtlCache;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: Logger;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.headers = {
      'user-agent': USER_AGENT,
      accept: 'application/json',
      ...options.headers,
    };
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseBackoffMs = options.baseBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.defaultTtlMs = options.defaultTtlMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.cache = new TtlCache(options.maxCacheEntries ?? 500, this.now);
    this.bucket = options.rateLimit
      ? new TokenBucket(options.rateLimit.capacity, options.rateLimit.refillPerSecond, this.now)
      : undefined;
    this.log = options.logger ?? rootLogger.child('mods:http');
  }

  /** Absolute URL for a path plus query. Exposed because the clients build cache keys from it. */
  url(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  clearCache(): void {
    this.cache.clear();
  }

  async getJson<S extends z.ZodType>(
    path: string,
    schema: S,
    options: RequestOptions = {}
  ): Promise<Result<z.infer<S>>> {
    const url = this.url(path, options.query);
    const ttlMs = options.ttlMs ?? this.defaultTtlMs;

    const cached = this.cache.get(url);
    if (cached.hit) {
      return this.parse(schema, cached.value, url);
    }

    const body = await this.request(url, { method: 'GET' }, options);
    if (!body.ok) {
      return body;
    }
    const parsed = this.parse(schema, body.value, url);
    if (parsed.ok) {
      this.cache.set(url, body.value, ttlMs);
    }
    return parsed;
  }

  /**
   * POSTs are never cached. Both APIs use POST for bulk *reads* (`/v2/version_files`,
   * `/v1/mods`), so caching them would be defensible — but the request body would have to be
   * part of the key, and a stale bulk read is far more confusing to debug than a duplicate one.
   */
  async postJson<S extends z.ZodType>(
    path: string,
    payload: unknown,
    schema: S,
    options: RequestOptions = {}
  ): Promise<Result<z.infer<S>>> {
    const url = this.url(path, options.query);
    const body = await this.request(
      url,
      {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json' },
      },
      options
    );
    return body.ok ? this.parse(schema, body.value, url) : body;
  }

  private parse<S extends z.ZodType>(
    schema: S,
    value: unknown,
    url: string
  ): Result<z.infer<S>> {
    const result = schema.safeParse(value);
    if (result.success) {
      return ok(result.data as z.infer<S>);
    }
    // The issue list is the whole point: it names the field that moved.
    const issues = result.error.issues.slice(0, 8).map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    }));
    this.log.error('upstream response did not match schema', { url, issues });
    return fail('upstream_error', `Unexpected response shape from ${url}`, {
      details: { url, issues, issueCount: result.error.issues.length },
    });
  }

  /** Fetch + retry + rate limit. Returns the decoded JSON body, unvalidated. */
  private async request(
    url: string,
    init: RequestInit,
    options: RequestOptions
  ): Promise<Result<unknown>> {
    let lastError: { code: 'upstream_error' | 'rate_limited' | 'timeout'; message: string } = {
      code: 'upstream_error',
      message: `No response from ${url}`,
    };

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const waited = await this.awaitToken(options.signal);
      if (!waited.ok) {
        return waited;
      }

      const response = await this.send(url, init, options);
      if (!response.ok) {
        // Transport-level failure (DNS, reset, abort). Retry unless the caller aborted.
        if (options.signal?.aborted || attempt === this.maxRetries) {
          return response;
        }
        lastError = { code: 'upstream_error', message: response.error.message };
        await this.sleep(this.backoffMs(attempt));
        continue;
      }

      const res = response.value;
      if (res.ok) {
        return this.decode(res, url);
      }

      if (!RETRYABLE_STATUS.has(res.status) || attempt === this.maxRetries) {
        return await this.statusError(res, url);
      }

      const delay = this.retryDelayMs(res, attempt);
      if (delay > this.maxBackoffMs) {
        // The server told us to wait longer than any request should block for. Surfacing
        // `rate_limited` lets the caller decide (queue it, tell the user, give up) instead of
        // silently holding a connection open for minutes.
        return fail(
          'rate_limited',
          `${url} asked us to wait ${Math.round(delay / 1000)}s, which exceeds the request budget`,
          { details: { url, status: res.status, retryAfterMs: delay } }
        );
      }
      this.log.warn('retrying upstream request', { url, status: res.status, attempt, delay });
      lastError = {
        code: res.status === 429 ? 'rate_limited' : 'upstream_error',
        message: `${url} responded ${res.status}`,
      };
      await this.sleep(delay);
    }

    return fail(lastError.code, lastError.message, { details: { url } });
  }

  private async awaitToken(signal: AbortSignal | undefined): Promise<Result<true>> {
    if (!this.bucket) {
      return ok(true);
    }
    // Bounded: a bucket that never refills is a programming error, not a runtime condition.
    for (let i = 0; i < 1000; i++) {
      if (this.bucket.tryTake()) {
        return ok(true);
      }
      if (signal?.aborted) {
        return fail('timeout', 'Request aborted while waiting for a rate-limit token');
      }
      await this.sleep(Math.min(this.bucket.delayMs(), 1000));
    }
    return fail('rate_limited', 'Local rate limiter did not release a token');
  }

  private async send(
    url: string,
    init: RequestInit,
    options: RequestOptions
  ): Promise<Result<Response>> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        headers: { ...this.headers, ...(init.headers as Record<string, string>), ...options.headers },
        signal,
      });
      return ok(response);
    } catch (cause) {
      const aborted = cause instanceof Error && cause.name === 'TimeoutError';
      return fail(
        aborted ? 'timeout' : 'upstream_error',
        aborted ? `${url} timed out after ${this.timeoutMs}ms` : `Request to ${url} failed`,
        { cause, details: { url } }
      );
    }
  }

  /**
   * Read as text, then JSON.parse.
   *
   * `Response#json()` throws a SyntaxError on an empty body, and empty bodies are the *normal*
   * error shape for both APIs — Modrinth 404s and CurseForge 403s carry zero bytes. Going via
   * text lets an empty 200 (which CurseForge does return) be distinguished from malformed JSON.
   */
  private async decode(response: Response, url: string): Promise<Result<unknown>> {
    const text = await response.text();
    if (text.trim().length === 0) {
      return fail('upstream_error', `${url} returned an empty body with status ${response.status}`, {
        details: { url, status: response.status },
      });
    }
    try {
      return ok(JSON.parse(text) as unknown);
    } catch (cause) {
      return fail('upstream_error', `${url} returned a body that is not JSON`, {
        cause,
        details: { url, status: response.status, preview: text.slice(0, 200) },
      });
    }
  }

  private async statusError(response: Response, url: string): Promise<Result<never>> {
    const text = await response.text().catch(() => '');
    const details = {
      url,
      status: response.status,
      ...(text.length > 0 ? { body: text.slice(0, 400) } : {}),
    };

    if (response.status === 404) {
      return fail('not_found', `${url} returned 404`, { details });
    }
    if (response.status === 401 || response.status === 403) {
      return fail('unauthorized', `${url} rejected our credentials (${response.status})`, {
        details,
      });
    }
    if (response.status === 429) {
      return fail('rate_limited', `${url} rate limited us`, { details });
    }
    if (response.status === 408) {
      return fail('timeout', `${url} timed out upstream`, { details });
    }
    return fail('upstream_error', `${url} returned ${response.status}`, { details });
  }

  /**
   * Backoff for the next attempt.
   *
   * Prefer what the server said. `Retry-After` is either a delta in seconds or an HTTP date;
   * Modrinth's `x-ratelimit-reset` is seconds until the window resets and is present on *every*
   * response, so it is only consulted on a 429 — using it otherwise would serialise every
   * request behind the window.
   */
  private retryDelayMs(response: Response, attempt: number): number {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.round(seconds * 1000);
      }
      const at = Date.parse(retryAfter);
      if (Number.isFinite(at)) {
        return Math.max(0, at - this.now());
      }
    }

    if (response.status === 429) {
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      if (Number.isFinite(reset) && reset > 0) {
        return Math.round(reset * 1000);
      }
    }

    return this.backoffMs(attempt);
  }

  /**
   * Exponential with full jitter (`random(0, base * 2^n)`).
   *
   * Full jitter rather than a fixed multiplier because every Platter instance that hit the same
   * 429 would otherwise retry in lockstep and recreate the burst that caused it.
   */
  private backoffMs(attempt: number): number {
    const ceiling = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** attempt);
    return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
  }
}
