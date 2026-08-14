import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Serving the built client from the API — the thing that makes Platter one container.
 *
 * The claim was previously asserted only by a shell step in CI, which curled `GET /` and
 * grepped for the root div. That proves the shell is served and nothing about *how*, which
 * is where the bug was: `sendFile` applies the static registration's `maxAge: '1y',
 * immutable: true` over the `no-cache` header `sendAppShell` sets, so the shell went out as
 * cacheable for a year. Content-hashed assets are meant to be immutable; the file that names
 * which hashes are current is the one file that must never be.
 *
 * That fails in a way no smoke test catches — the first load is perfect. It only appears on
 * the *next* deploy, as a blank page, for whoever visited before it.
 *
 * WEB_ROOT is set here at module scope because `config.ts` snapshots the environment when it
 * is first imported, which the dynamic imports below defer until after this runs.
 */

const webRoot = mkdtempSync(path.join(tmpdir(), 'platter-webroot-'));

mkdirSync(path.join(webRoot, 'assets'), { recursive: true });
writeFileSync(
  path.join(webRoot, 'index.html'),
  '<!doctype html><html><body><div id="root"></div>' +
    '<script type="module" src="/assets/index-abc123.js"></script></body></html>',
);
writeFileSync(path.join(webRoot, 'assets', 'index-abc123.js'), 'export default 1;\n');

process.env['WEB_ROOT'] = webRoot;

const { buildTestApp, closeTestHarness } = await import('../../test/helpers.js');

let app: FastifyInstance;

const HTML = { accept: 'text/html,application/xhtml+xml' };

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeTestHarness();
  rmSync(webRoot, { recursive: true, force: true });
});

describe('the app shell', () => {
  it('is served at the root', async () => {
    const response = await app.inject({ method: 'GET', url: '/', headers: HTML });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<div id="root">');
  });

  it('is never cached, or an upgrade blanks the page for returning visitors', async () => {
    const response = await app.inject({ method: 'GET', url: '/', headers: HTML });

    const cacheControl = String(response.headers['cache-control'] ?? '');
    expect(cacheControl).toContain('no-cache');
    expect(cacheControl).not.toContain('immutable');
    expect(cacheControl).not.toContain('max-age=31536000');
  });

  it('answers a client-router deep link, which is the point of the fallback', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/servers/srv_whatever/console',
      headers: HTML,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<div id="root">');
    expect(String(response.headers['cache-control'] ?? '')).toContain('no-cache');
  });
});

describe('what must not become the app shell', () => {
  it('keeps an unknown API path a JSON 404', async () => {
    // Returning HTML here would make every client's `response.json()` throw a parse error
    // instead of surfacing the actual 404.
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/definitely-not-a-route',
      headers: HTML,
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
  });

  it('ignores a request that does not accept HTML, because that is a fetch', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/some/page',
      headers: { accept: 'application/json' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('never resolves a non-GET to a page', async () => {
    const response = await app.inject({ method: 'POST', url: '/some/page', headers: HTML });

    expect(response.statusCode).not.toBe(200);
  });
});

describe('hashed assets', () => {
  it('are cached hard, which is what makes a no-cache shell affordable', async () => {
    const response = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });

    expect(response.statusCode).toBe(200);
    const cacheControl = String(response.headers['cache-control'] ?? '');
    expect(cacheControl).toContain('immutable');
    expect(cacheControl).toContain('max-age=31536000');
  });
});
