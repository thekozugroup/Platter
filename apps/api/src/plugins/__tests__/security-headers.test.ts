import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestHarness } from '../../test/helpers.js';

/**
 * The response headers a browser actually enforces.
 *
 * These went untested because every check that mattered used curl, which ignores CSP
 * entirely — so a directive that breaks every browser looked fine from the terminal, and
 * fine again from `localhost`, which browsers exempt as a trusted origin.
 */

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeTestHarness();
});

async function csp(): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/system/health',
    headers: { accept: 'text/html' },
  });
  return String(response.headers['content-security-policy'] ?? '');
}

describe('content security policy', () => {
  it('never asks the browser to upgrade requests to https', async () => {
    /*
     * Regression, and the worst kind: the app rendered as a blank white page for everyone
     * except the person testing it.
     *
     * Platter speaks plain HTTP. With `upgrade-insecure-requests`, a browser on
     * `http://<host>:8080` re-requests every asset over https, where nothing is listening,
     * and all 34 fail with ERR_SSL_PROTOCOL_ERROR leaving `#root` empty. It came from
     * helmet's defaults rather than from anything written here, which is why reading the
     * directive list did not reveal it.
     */
    expect(await csp()).not.toContain('upgrade-insecure-requests');
  });

  it('still confines the app to its own origin', async () => {
    // The removal above must not be mistaken for relaxing the policy.
    const value = await csp();
    expect(value).toContain("default-src 'self'");
    expect(value).toContain("object-src 'none'");
    expect(value).toContain("frame-ancestors 'none'");
  });

  it("keeps img-src at 'self', which is what the icon proxy exists to satisfy", async () => {
    const value = await csp();
    expect(value).toContain("img-src 'self' data: blob:");
    expect(value).not.toContain('cdn.modrinth.com');
  });
});
