import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fakeFetch, headersOf, recordingSleep, silentLogger } from './__fixtures__/helpers';
import { HttpClient, TokenBucket, TtlCache, USER_AGENT } from './http';

const schema = z.object({ hello: z.string() });

const client = (overrides: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}): HttpClient =>
  new HttpClient({
    baseUrl: 'https://example.test',
    // No jitter surprises and no real waiting anywhere in this file.
    sleep: async () => {},
    logger: silentLogger(),
    ...overrides,
  });

describe('TokenBucket', () => {
  it('hands out its capacity then refuses until time passes', () => {
    let now = 0;
    const bucket = new TokenBucket(3, 1, () => now);

    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
    expect(bucket.delayMs()).toBe(1000);

    now += 2000;
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
  });

  it('refills continuously rather than in a burst at the window edge', () => {
    let now = 0;
    const bucket = new TokenBucket(300, 5, () => now);
    for (let i = 0; i < 300; i++) {
      bucket.tryTake();
    }
    expect(bucket.tryTake()).toBe(false);

    now += 400; // 0.4s at 5/s = 2 tokens
    expect(bucket.available).toBeCloseTo(2, 5);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
  });

  it('never exceeds capacity however long it idles', () => {
    let now = 0;
    const bucket = new TokenBucket(10, 5, () => now);
    now += 1_000_000;
    expect(bucket.available).toBe(10);
  });
});

describe('TtlCache', () => {
  it('expires entries', () => {
    let now = 0;
    const cache = new TtlCache(10, () => now);
    cache.set('a', 1, 100);
    expect(cache.get('a')).toEqual({ hit: true, value: 1 });
    now = 101;
    expect(cache.get('a')).toEqual({ hit: false });
    expect(cache.size).toBe(0);
  });

  it('evicts the coldest key first', () => {
    const cache = new TtlCache(2);
    cache.set('a', 1, 1000);
    cache.set('b', 2, 1000);
    cache.get('a'); // touching `a` makes `b` the coldest
    cache.set('c', 3, 1000);

    expect(cache.get('a').hit).toBe(true);
    expect(cache.get('b').hit).toBe(false);
    expect(cache.get('c').hit).toBe(true);
  });

  it('treats a zero TTL as "do not cache"', () => {
    const cache = new TtlCache();
    cache.set('a', 1, 0);
    expect(cache.get('a').hit).toBe(false);
  });
});

describe('HttpClient', () => {
  it('sends a descriptive User-Agent on every request', async () => {
    const fake = fakeFetch(() => ({ body: { hello: 'world' } }));
    await client({ fetchImpl: fake.fetch }).getJson('/thing', schema);

    const headers = headersOf(fake.calls[0]);
    expect(headers['user-agent']).toBe(USER_AGENT);
    expect(headers['user-agent']).toMatch(/^thekozugroup\/platter\/\d+\.\d+\.\d+ \(\+https:/);
  });

  it('merges client headers, so auth is set once at construction', async () => {
    const fake = fakeFetch(() => ({ body: { hello: 'world' } }));
    await client({ fetchImpl: fake.fetch, headers: { 'x-api-key': 'secret' } }).getJson(
      '/thing',
      schema
    );
    expect(headersOf(fake.calls[0])['x-api-key']).toBe('secret');
  });

  it('builds query strings and skips undefined values', async () => {
    const fake = fakeFetch(() => ({ body: { hello: 'world' } }));
    await client({ fetchImpl: fake.fetch }).getJson('/thing', schema, {
      query: { a: 1, b: 'two', c: undefined, d: null, e: false },
    });
    const url = new URL(fake.calls[0]?.url ?? '');
    expect(url.searchParams.get('a')).toBe('1');
    expect(url.searchParams.get('b')).toBe('two');
    expect(url.searchParams.has('c')).toBe(false);
    expect(url.searchParams.has('d')).toBe(false);
    expect(url.searchParams.get('e')).toBe('false');
  });

  it('returns upstream_error with the Zod issues when the shape changes', async () => {
    // The whole point of parsing rather than casting: a field that moved shows up here.
    const fake = fakeFetch(() => ({ body: { hello: 42 } }));
    const result = await client({ fetchImpl: fake.fetch }).getJson('/thing', schema);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe('upstream_error');
    expect(result.error.details.issues).toEqual([
      expect.objectContaining({ path: 'hello', code: 'invalid_type' }),
    ]);
  });

  it('does not cache a response that failed to parse', async () => {
    let calls = 0;
    const fake = fakeFetch(() => {
      calls += 1;
      return { body: { hello: 42 } };
    });
    const http = client({ fetchImpl: fake.fetch });
    await http.getJson('/thing', schema, { ttlMs: 60_000 });
    await http.getJson('/thing', schema, { ttlMs: 60_000 });
    expect(calls).toBe(2);
  });

  it('serves a cached GET without a second request, keyed on the full URL', async () => {
    let calls = 0;
    const fake = fakeFetch(() => {
      calls += 1;
      return { body: { hello: 'world' } };
    });
    const http = client({ fetchImpl: fake.fetch });

    await http.getJson('/thing', schema, { ttlMs: 60_000, query: { a: 1 } });
    await http.getJson('/thing', schema, { ttlMs: 60_000, query: { a: 1 } });
    expect(calls).toBe(1);

    await http.getJson('/thing', schema, { ttlMs: 60_000, query: { a: 2 } });
    expect(calls).toBe(2);
  });

  it('hands each cache hit a fresh object, so one caller cannot corrupt another', async () => {
    const fake = fakeFetch(() => ({ body: { hello: 'world' } }));
    const http = client({ fetchImpl: fake.fetch });
    const first = await http.getJson('/thing', schema, { ttlMs: 60_000 });
    const second = await http.getJson('/thing', schema, { ttlMs: 60_000 });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(first.value).toEqual(second.value);
    expect(first.value).not.toBe(second.value);
  });

  it('never caches POSTs', async () => {
    let calls = 0;
    const fake = fakeFetch(() => {
      calls += 1;
      return { body: { hello: 'world' } };
    });
    const http = client({ fetchImpl: fake.fetch });
    await http.postJson('/bulk', { ids: [1] }, schema);
    await http.postJson('/bulk', { ids: [1] }, schema);
    expect(calls).toBe(2);
  });

  it('maps an empty-body 404 to not_found instead of a JSON parse crash', async () => {
    // Modrinth's 404s carry zero bytes; `Response#json()` throws SyntaxError on them.
    const fake = fakeFetch(() => ({ status: 404, text: '' }));
    const result = await client({ fetchImpl: fake.fetch }).getJson('/missing', schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_found');
    }
  });

  it('maps an empty-body 403 to unauthorized', async () => {
    // CurseForge returns exactly this for both a missing and an invalid key.
    const fake = fakeFetch(() => ({ status: 403, text: '' }));
    const result = await client({ fetchImpl: fake.fetch }).getJson('/thing', schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
    }
  });

  it('does not retry a 404', async () => {
    const fake = fakeFetch(() => ({ status: 404, text: '' }));
    await client({ fetchImpl: fake.fetch, maxRetries: 3 }).getJson('/missing', schema);
    expect(fake.calls).toHaveLength(1);
  });

  it('retries a 500 and succeeds', async () => {
    const fake = fakeFetch((_url, _init, index) =>
      index === 0 ? { status: 500, body: { error: 'boom' } } : { body: { hello: 'world' } }
    );
    const result = await client({ fetchImpl: fake.fetch }).getJson('/thing', schema);

    expect(fake.calls).toHaveLength(2);
    expect(result.ok && result.value).toEqual({ hello: 'world' });
  });

  it('waits exactly as long as Retry-After says, in seconds', async () => {
    const timer = recordingSleep();
    const fake = fakeFetch((_url, _init, index) =>
      index === 0
        ? { status: 429, text: 'slow down', headers: { 'retry-after': '7' } }
        : { body: { hello: 'world' } }
    );
    await client({ fetchImpl: fake.fetch, sleep: timer.sleep }).getJson('/thing', schema);

    expect(timer.waits).toEqual([7000]);
  });

  it('understands an HTTP-date Retry-After', async () => {
    const now = Date.parse('2026-08-07T12:00:00Z');
    const timer = recordingSleep();
    const fake = fakeFetch((_url, _init, index) =>
      index === 0
        ? { status: 503, headers: { 'retry-after': new Date(now + 4500).toUTCString() }, text: 'x' }
        : { body: { hello: 'world' } }
    );
    await client({ fetchImpl: fake.fetch, sleep: timer.sleep, now: () => now }).getJson(
      '/thing',
      schema
    );

    // The header has second precision, so 4500ms rounds down to 4000.
    expect(timer.waits[0]).toBe(4000);
  });

  it('falls back to x-ratelimit-reset on a 429 with no Retry-After', async () => {
    const timer = recordingSleep();
    const fake = fakeFetch((_url, _init, index) =>
      index === 0
        ? { status: 429, headers: { 'x-ratelimit-reset': '23' }, text: 'rate limited' }
        : { body: { hello: 'world' } }
    );
    await client({ fetchImpl: fake.fetch, sleep: timer.sleep }).getJson('/thing', schema);
    expect(timer.waits).toEqual([23_000]);
  });

  it('ignores x-ratelimit-reset on a non-429, where it just describes the window', async () => {
    // Modrinth sends this header on *every* response. Honouring it on a 500 would serialise
    // every request behind the rate-limit window for no reason.
    const timer = recordingSleep();
    const fake = fakeFetch((_url, _init, index) =>
      index === 0
        ? { status: 500, headers: { 'x-ratelimit-reset': '55' }, text: 'boom' }
        : { body: { hello: 'world' } }
    );
    await client({
      fetchImpl: fake.fetch,
      sleep: timer.sleep,
      baseBackoffMs: 100,
    }).getJson('/thing', schema);

    expect(timer.waits[0]).toBeLessThan(1000);
  });

  it('refuses to block longer than the budget and returns rate_limited instead', async () => {
    const timer = recordingSleep();
    const fake = fakeFetch(() => ({
      status: 429,
      headers: { 'retry-after': '3600' },
      text: 'come back later',
    }));
    const result = await client({
      fetchImpl: fake.fetch,
      sleep: timer.sleep,
      maxBackoffMs: 30_000,
    }).getJson('/thing', schema);

    expect(timer.waits).toEqual([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('rate_limited');
      expect(result.error.retryable).toBe(true);
      expect(result.error.details.retryAfterMs).toBe(3_600_000);
    }
  });

  it('gives up after maxRetries and reports the last status', async () => {
    const fake = fakeFetch(() => ({ status: 503, text: 'down' }));
    const result = await client({ fetchImpl: fake.fetch, maxRetries: 2 }).getJson('/thing', schema);

    expect(fake.calls).toHaveLength(3);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('upstream_error');
    }
  });

  it('backs off exponentially with jitter, and stays under the ceiling', async () => {
    const timer = recordingSleep();
    const fake = fakeFetch(() => ({ status: 500, text: 'boom' }));
    await client({
      fetchImpl: fake.fetch,
      sleep: timer.sleep,
      maxRetries: 3,
      baseBackoffMs: 1000,
    }).getJson('/thing', schema);

    expect(timer.waits).toHaveLength(3);
    // Full jitter: random(ceiling/2, ceiling) where ceiling = base * 2^attempt.
    expect(timer.waits[0]).toBeGreaterThanOrEqual(500);
    expect(timer.waits[0]).toBeLessThanOrEqual(1000);
    expect(timer.waits[2]).toBeGreaterThanOrEqual(2000);
    expect(timer.waits[2]).toBeLessThanOrEqual(4000);
  });

  it('waits for a rate-limit token before sending the next request', async () => {
    // The fake sleep advances the same virtual clock the bucket refills against, so the wait is
    // real from the limiter's point of view without costing the suite a second.
    const timer = recordingSleep();
    const fake = fakeFetch(() => ({ body: { hello: 'world' } }));
    const http = client({
      fetchImpl: fake.fetch,
      sleep: timer.sleep,
      now: timer.now,
      rateLimit: { capacity: 1, refillPerSecond: 1 },
    });

    await http.getJson('/a', schema);
    expect(timer.waits).toEqual([]);

    await http.getJson('/b', schema);
    expect(fake.calls).toHaveLength(2);
    // One token per second and the bucket was empty, so it had to wait about a full second.
    expect(timer.waits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1000);
  });

  it('gives up rather than spinning when the limiter can never release a token', async () => {
    const fake = fakeFetch(() => ({ body: { hello: 'world' } }));
    const http = client({
      fetchImpl: fake.fetch,
      // A frozen clock means no refill, ever. This must terminate, not hang.
      now: () => 0,
      rateLimit: { capacity: 1, refillPerSecond: 1 },
    });

    expect((await http.getJson('/a', schema)).ok).toBe(true);
    const second = await http.getJson('/b', schema);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('rate_limited');
    }
  });

  it('surfaces a body that is not JSON rather than throwing', async () => {
    const fake = fakeFetch(() => ({ text: '<html>maintenance</html>' }));
    const result = await client({ fetchImpl: fake.fetch }).getJson('/thing', schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('upstream_error');
      expect(result.error.message).toMatch(/not JSON/);
    }
  });
});
