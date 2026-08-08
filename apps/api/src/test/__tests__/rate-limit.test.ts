import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { API_PREFIX } from '@platter/shared';
import { rateLimitKey } from '../../plugins/security.js';
import { buildTestApp, closeTestHarness, resetDatabase } from '../helpers.js';

/**
 * The rate limiter's bucket key.
 *
 * The regression this file exists for: the key used to be derived from the *unverified*
 * `X-API-Key` header, so a client that sent a different junk value on every request got a
 * fresh, empty bucket every time. That is not a small leak — the same limiter carries the
 * login budget (`AUTH_RATE_LIMIT`), the key-minting budget (`SENSITIVE_RATE_LIMIT`) and the
 * global flood ceiling, on a service that holds the Docker socket.
 */

let app: FastifyInstance;

beforeAll(async () => {
  await resetDatabase();
  // A dedicated instance: the limiter's store is per-app, and sharing one with another
  // suite would make this file's counts depend on what ran before it.
  app = await buildTestApp();
});

afterEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await app.close();
  await closeTestHarness();
});

function request(index: number): Promise<{ statusCode: number }> {
  return app.inject({
    method: 'POST',
    url: `${API_PREFIX}/auth/login`,
    // A different unverified key on every attempt: the exact bypass.
    headers: { 'x-api-key': `plt_bogus${index}.${'a'.repeat(32)}` },
    payload: { email: 'nobody@example.test', password: 'not-the-password' },
  });
}

describe('rate limit bucket key', () => {
  it('is not derived from any header the client controls', () => {
    const headerless = rateLimitKey({ ip: '203.0.113.9', headers: {} } as never);
    const forged = rateLimitKey({
      ip: '203.0.113.9',
      headers: { 'x-api-key': 'plt_forged.aaaaaaaa' },
    } as never);
    expect(forged).toBe(headerless);
    expect(headerless).toContain('203.0.113.9');
  });

  it('throttles login attempts that rotate the X-API-Key header', async () => {
    const codes: number[] = [];
    // AUTH_RATE_LIMIT is 10/minute. Fifteen attempts from one address must not all be
    // served just because each carried a different made-up key.
    for (let index = 0; index < 15; index += 1) {
      const response = await request(index);
      codes.push(response.statusCode);
    }

    expect(codes.filter((code) => code === 429).length).toBeGreaterThan(0);
    // The first ten are the budget; everything after it is refused.
    expect(codes.slice(10).every((code) => code === 429)).toBe(true);
  });
});
