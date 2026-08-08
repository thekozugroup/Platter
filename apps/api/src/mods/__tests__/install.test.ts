import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The download boundary.
 *
 * `services/files.ts`-style setup: nothing here touches Prisma, so the environment just
 * needs a scratch `DATA_DIR` before `config.ts` is pulled in transitively.
 */

const workdir = await mkdtemp(path.join(tmpdir(), 'platter-install-'));

process.env['NODE_ENV'] = 'test';
process.env['DATA_DIR'] = path.join(workdir, 'data');
process.env['DATABASE_URL'] = `file:${path.join(workdir, 'unused.db')}`;
process.env['JWT_SECRET'] = 'test-secret-that-is-long-enough-to-pass';

const { installModFile } = await import('../install.js');
import type { ModFile } from '../registry.js';

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

const BODY = 'jar-bytes';
const SHA512 = createHash('sha512').update(BODY).digest('hex');

function modFile(url: string): ModFile {
  return {
    filename: 'example-1.0.0.jar',
    url,
    sizeBytes: BODY.length,
    sha512: SHA512,
    sha1: null,
  };
}

function okResponse(): Response {
  return new Response(BODY, { status: 200 });
}

function redirectTo(location: string): Response {
  // `Response.redirect` refuses a relative URL, so the header is set by hand — which is
  // also what a real CDN sends.
  return new Response(null, { status: 302, headers: { location } });
}

/**
 * A fetch that behaves like the platform's: it chases redirects itself unless the caller
 * asked for `manual`.
 *
 * Without this the test would pass against the old code by accident — a stub that hands a
 * 302 straight back makes `redirect: 'follow'` look like it refused something.
 */
function fakeFetch(
  route: (url: string) => Response,
  seen: string[],
): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    let url = input;
    for (let hop = 0; hop < 10; hop += 1) {
      seen.push(url);
      const response = route(url);
      if (init?.redirect === 'manual' || response.status !== 302) return response;
      url = new URL(response.headers.get('location') ?? '', url).toString();
    }
    throw new Error('too many redirects');
  };
}

describe('mod download redirects', () => {
  it('refuses a redirect that leaves the source\'s own file hosts', async () => {
    const seen: string[] = [];
    const fetchImpl = fakeFetch(
      (url) =>
        url.startsWith('https://cdn.modrinth.com/')
          ? redirectTo('https://attacker.example/payload.jar')
          : okResponse(),
      seen,
    );

    await expect(
      installModFile({
        serverId: 'srv_redirect',
        target: 'mods',
        source: 'modrinth',
        file: modFile('https://cdn.modrinth.com/data/AAAA/versions/1/example-1.0.0.jar'),
        fetch: fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'service_unavailable' });

    // The allowlist has to hold for the whole transfer, not just its first request: with
    // `redirect: 'follow'` the attacker's host was fetched and only the checksum stopped it.
    expect(seen).toEqual(['https://cdn.modrinth.com/data/AAAA/versions/1/example-1.0.0.jar']);
  });

  it('follows a redirect that stays on an allowed host', async () => {
    const seen: string[] = [];
    const fetchImpl = fakeFetch(
      (url) => (url.endsWith('/final.jar') ? okResponse() : redirectTo('/data/AAAA/final.jar')),
      seen,
    );

    const installed = await installModFile({
      serverId: 'srv_redirect_ok',
      target: 'mods',
      source: 'modrinth',
      file: modFile('https://cdn.modrinth.com/data/AAAA/versions/1/example-1.0.0.jar'),
      fetch: fetchImpl,
    });

    expect(seen[1]).toBe('https://cdn.modrinth.com/data/AAAA/final.jar');
    expect(installed.sha512).toBe(SHA512);
  });

  it('gives up rather than chasing a redirect loop', async () => {
    const seen: string[] = [];
    const fetchImpl = fakeFetch(() => redirectTo('https://cdn.modrinth.com/loop.jar'), seen);

    await expect(
      installModFile({
        serverId: 'srv_redirect_loop',
        target: 'mods',
        source: 'modrinth',
        file: modFile('https://cdn.modrinth.com/data/AAAA/versions/1/example-1.0.0.jar'),
        fetch: fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(seen.length).toBeLessThanOrEqual(6);
  });
});
