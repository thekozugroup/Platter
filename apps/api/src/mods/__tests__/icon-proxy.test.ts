import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { API_PREFIX, PlatterError } from '@platter/shared';
import {
  ICON_CACHE_CONTROL,
  ICON_MAX_BYTES,
  assertProxyableIconUrl,
  fetchModIcon,
  isPrivateAddressLiteral,
  isProxyableIconUrl,
  proxiedIconUrl,
  signIconUrl,
  verifyIconSignature,
} from '../icon-proxy.js';
import {
  authHeaders,
  buildTestApp,
  closeTestHarness,
  createTestUser,
  ensureTestNode,
  resetDatabase,
  type TestUser,
} from '../../test/helpers.js';

/**
 * The mod icon proxy.
 *
 * The defect this exists for: `plugins/security.ts` pins `img-src` to `'self'`, and every mod
 * icon is served from `cdn.modrinth.com`, so the entire mod browser rendered as blank tiles in
 * the shipped app. The fix fetches the image server-side and serves it same-origin — which
 * turns a rendering bug into a request Platter makes on a caller's behalf, and that is a
 * server-side request forgery hole unless the target is constrained. Most of this file is
 * about the constraint, not the rendering.
 *
 * No live network: `fetchModIcon` takes its `fetch`, exactly as the registry providers do.
 */

// A real Modrinth icon URL, in the shape the API actually returns (content-addressed).
const MODRINTH_ICON =
  'https://cdn.modrinth.com/data/AANobbMI/295862f4724dc3f78df3447ad6072b2dcd3ef0c9_96.webp';

const SERVER_ID = 'srv_01JQTESTTESTTESTTESTTESTTE';

/** A one-pixel WebP is still a WebP; the bytes only have to be distinguishable. */
const IMAGE_BYTES = Buffer.from('RIFF....WEBPVP8 fake-but-distinctive-payload', 'utf8');

function imageResponse(
  body: Buffer = IMAGE_BYTES,
  contentType = 'image/webp',
  headers: Record<string, string> = {},
): Response {
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: { 'content-type': contentType, ...headers },
  });
}

/** Asserts a rejection carries a Platter error code rather than escaping as a 500. */
async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(PlatterError);
  await promise.catch((error: unknown) => {
    expect((error as PlatterError).code).toBe(code);
  });
}

// ---------------------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------------------

describe('assertProxyableIconUrl', () => {
  it('accepts the registry CDNs the mod browser actually links to', () => {
    expect(assertProxyableIconUrl(MODRINTH_ICON).hostname).toBe('cdn.modrinth.com');
    expect(
      assertProxyableIconUrl('https://media.forgecdn.net/avatars/1042/54/638.png').hostname,
    ).toBe('media.forgecdn.net');
  });

  it('rejects a foreign host', async () => {
    for (const url of [
      'https://evil.test/icon.png',
      'https://example.com/cdn.modrinth.com/icon.png',
      // Suffix confusion: the reason the allowlist is a Set of exact hosts and not `endsWith`.
      'https://cdn.modrinth.com.evil.test/icon.png',
      'https://evilcdn.modrinth.com/icon.png',
      'https://notmedia.forgecdn.net/icon.png',
    ]) {
      expect(() => assertProxyableIconUrl(url)).toThrow(PlatterError);
      expect(isProxyableIconUrl(url)).toBe(false);
    }
  });

  it('rejects a private or loopback address literal', () => {
    for (const host of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.4.1',
      '192.168.1.1',
      // The one that matters on a cloud host: the instance metadata service.
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1',
      '[::1]',
      '[fd00::1]',
      '[fe80::1]',
      '[::ffff:127.0.0.1]',
    ]) {
      const url = `http://${host}/icon.png`;
      expect(() => assertProxyableIconUrl(url)).toThrow(PlatterError);
      expect(isProxyableIconUrl(url)).toBe(false);
    }
  });

  it('flags private literals independently of the allowlist', () => {
    expect(isPrivateAddressLiteral('169.254.169.254')).toBe(true);
    expect(isPrivateAddressLiteral('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateAddressLiteral('8.8.8.8')).toBe(false);
    expect(isPrivateAddressLiteral('cdn.modrinth.com')).toBe(false);
  });

  it('rejects non-http(s) schemes', () => {
    for (const url of [
      'file:///etc/passwd',
      'data:image/png;base64,AAAA',
      'ftp://cdn.modrinth.com/icon.png',
      'gopher://cdn.modrinth.com/',
    ]) {
      expect(() => assertProxyableIconUrl(url)).toThrow(PlatterError);
    }
  });

  it('rejects userinfo, which is how an allowlisted host gets faked', () => {
    // Parses with hostname `evil.test`; a human reading the URL sees the CDN first.
    expect(() => assertProxyableIconUrl('https://cdn.modrinth.com@evil.test/icon.png')).toThrow(
      PlatterError,
    );
  });

  it('normalises a trailing dot and case, which resolve to the same host', () => {
    expect(isProxyableIconUrl('https://CDN.Modrinth.COM./data/x/icon.png')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------------------

describe('signed proxy links', () => {
  it('mints a same-origin path and verifies its own signature', () => {
    const minted = proxiedIconUrl(SERVER_ID, MODRINTH_ICON);
    expect(minted).not.toBeNull();
    expect(minted?.startsWith(`${API_PREFIX}/servers/${SERVER_ID}/mods/icon?`)).toBe(true);

    const query = new URLSearchParams(minted?.split('?')[1] ?? '');
    expect(query.get('url')).toBe(MODRINTH_ICON);
    expect(verifyIconSignature(SERVER_ID, MODRINTH_ICON, query.get('sig') ?? '')).toBe(true);
  });

  it('is stable, so an immutable cache entry survives the next page load', () => {
    // A timestamped signature would change the URL on every response and miss the cache
    // every time — which is the whole benefit of proxying content-addressed assets.
    expect(proxiedIconUrl(SERVER_ID, MODRINTH_ICON)).toBe(proxiedIconUrl(SERVER_ID, MODRINTH_ICON));
  });

  it('binds the signature to the server and the exact URL', () => {
    const sig = signIconUrl(SERVER_ID, MODRINTH_ICON);
    expect(verifyIconSignature('srv_other', MODRINTH_ICON, sig)).toBe(false);
    expect(
      verifyIconSignature(SERVER_ID, 'https://cdn.modrinth.com/data/AANobbMI/other.webp', sig),
    ).toBe(false);
    expect(verifyIconSignature(SERVER_ID, MODRINTH_ICON, '')).toBe(false);
    expect(verifyIconSignature(SERVER_ID, MODRINTH_ICON, `${sig}x`)).toBe(false);
  });

  it('returns null rather than a link that could only fail', () => {
    // The client reads null as "no artwork" and draws its monogram immediately.
    expect(proxiedIconUrl(SERVER_ID, null)).toBeNull();
    expect(proxiedIconUrl(SERVER_ID, '')).toBeNull();
    expect(proxiedIconUrl(SERVER_ID, 'https://evil.test/icon.png')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------------------

describe('fetchModIcon', () => {
  it('streams an allowlisted image through', async () => {
    const fetchImpl = vi.fn(async () => imageResponse());
    const icon = await fetchModIcon(assertProxyableIconUrl(MODRINTH_ICON), { fetch: fetchImpl });

    expect(icon.contentType).toBe('image/webp');
    expect(icon.body.equals(IMAGE_BYTES)).toBe(true);

    const [target, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(target)).toBe(MODRINTH_ICON);
    // Redirects are this module's decision, not undici's — see the allowlist test below.
    expect((init as RequestInit | undefined)?.redirect).toBe('manual');
    const headers = (init as RequestInit | undefined)?.headers as Record<string, string>;
    expect(headers['user-agent']).toContain('Platter/');
  });

  it('rejects a non-image content type', async () => {
    for (const contentType of [
      'text/html',
      'application/json',
      'application/octet-stream',
      // Active content served from Platter's own origin would be stored XSS.
      'image/svg+xml',
    ]) {
      const fetchImpl = vi.fn(async () => imageResponse(IMAGE_BYTES, contentType));
      await expectCode(
        fetchModIcon(assertProxyableIconUrl(MODRINTH_ICON), { fetch: fetchImpl }),
        'bad_request',
      );
    }
  });

  it('rejects a response with no content type at all', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(new Uint8Array(IMAGE_BYTES), { status: 200, headers: {} }),
    );
    await expectCode(
      fetchModIcon(assertProxyableIconUrl(MODRINTH_ICON), { fetch: fetchImpl }),
      'bad_request',
    );
  });

  it('caps the body even when the upstream declares nothing', async () => {
    // No content-length: the counter in the read loop is what has to stop this, not a header.
    const oversized = Buffer.alloc(ICON_MAX_BYTES + 1024, 0x41);
    const fetchImpl = vi.fn(async () => imageResponse(oversized));
    await expectCode(
      fetchModIcon(assertProxyableIconUrl(MODRINTH_ICON), { fetch: fetchImpl }),
      'payload_too_large',
    );
  });

  it('refuses an oversized body up front when content-length admits it', async () => {
    const fetchImpl = vi.fn(async () =>
      imageResponse(IMAGE_BYTES, 'image/png', {
        'content-length': String(ICON_MAX_BYTES + 1),
      }),
    );
    await expectCode(
      fetchModIcon(assertProxyableIconUrl(MODRINTH_ICON), { fetch: fetchImpl }),
      'payload_too_large',
    );
  });

  it('follows a redirect that stays on the allowlist', async () => {
    const fetchImpl = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn-raw.modrinth.com/data/AANobbMI/icon.png' },
        }),
      )
      .mockResolvedValueOnce(imageResponse(IMAGE_BYTES, 'image/png'));

    const icon = await fetchModIcon(assertProxyableIconUrl(MODRINTH_ICON), { fetch: fetchImpl });
    expect(icon.contentType).toBe('image/png');
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(
      'https://cdn-raw.modrinth.com/data/AANobbMI/icon.png',
    );
  });

  it('refuses a redirect off the allowlist', async () => {
    // The SSRF the allowlist exists to stop: an open redirect on a CDN is otherwise a free
    // pivot to loopback or the metadata service, and `redirect: 'follow'` would take it.
    for (const location of [
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:8080/admin',
      'https://evil.test/icon.png',
      'file:///etc/passwd',
    ]) {
      const fetchImpl = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }))
        .mockResolvedValueOnce(imageResponse());

      await expectCode(
        fetchModIcon(assertProxyableIconUrl(MODRINTH_ICON), { fetch: fetchImpl }),
        'service_unavailable',
      );
      // Never dialled the redirect target.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('reports a missing upstream image as 404, never as a 500', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    await expectCode(
      fetchModIcon(assertProxyableIconUrl(MODRINTH_ICON), { fetch: fetchImpl }),
      'not_found',
    );
  });

  it('reports an upstream failure or a transport error as unavailable, never as a 500', async () => {
    const failing = vi.fn(async () => new Response(null, { status: 503 }));
    await expectCode(
      fetchModIcon(assertProxyableIconUrl(MODRINTH_ICON), { fetch: failing }),
      'service_unavailable',
    );

    const throwing = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    await expectCode(
      fetchModIcon(assertProxyableIconUrl(MODRINTH_ICON), { fetch: throwing }),
      'service_unavailable',
    );
  });
});

// ---------------------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------------------

let app: FastifyInstance;
let nodeId: string;
let owner: TestUser;
let serverId: string;

beforeAll(async () => {
  await resetDatabase();
  app = await buildTestApp();
  nodeId = await ensureTestNode();
  owner = await createTestUser('owner');
  serverId = await createFabricServer();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await app.close();
  await closeTestHarness();
});

async function createFabricServer(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `${API_PREFIX}/servers`,
    headers: authHeaders(owner),
    payload: {
      name: 'Icon Server',
      blueprintKey: 'minecraft-java',
      nodeId,
      variables: { EULA: 'true', TYPE: 'FABRIC', VERSION: '1.21.1' },
      startOnCreate: false,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

function iconRequest(query: Record<string, string>): Promise<{
  statusCode: number;
  headers: Record<string, unknown>;
  rawPayload: Buffer;
  json: () => { error: { code: string } };
}> {
  const search = new URLSearchParams(query).toString();
  return app.inject({
    method: 'GET',
    url: `${API_PREFIX}/servers/${serverId}/mods/icon?${search}`,
  }) as never;
}

describe('GET /servers/:serverId/mods/icon', () => {
  it('serves a signed Modrinth icon same-origin, cached immutably', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => imageResponse()),
    );

    const minted = proxiedIconUrl(serverId, MODRINTH_ICON) ?? '';
    const response = await app.inject({ method: 'GET', url: minted });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/webp');
    expect(response.headers['cache-control']).toBe(ICON_CACHE_CONTROL);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.rawPayload.equals(IMAGE_BYTES)).toBe(true);
  });

  it('refuses an unsigned or tampered link', async () => {
    const signature = signIconUrl(serverId, MODRINTH_ICON);

    const unsigned = await iconRequest({ url: MODRINTH_ICON, sig: 'not-a-signature' });
    expect(unsigned.statusCode).toBe(403);
    expect(unsigned.json().error.code).toBe('forbidden');

    // The whole point: a signature for one URL must not unlock a different one. Without
    // this, the endpoint is an open proxy for anything on the allowlist and — via a
    // swapped host — the SSRF the allowlist was meant to prevent.
    const swapped = await iconRequest({ url: 'https://evil.test/icon.png', sig: signature });
    expect(swapped.statusCode).toBe(403);
  });

  it('re-validates the URL even when the signature is genuine', async () => {
    const spy = vi.fn(async () => imageResponse());
    vi.stubGlobal('fetch', spy);

    // `proxiedIconUrl` would never mint these, so they are signed by hand — this is the
    // case where the signing key has leaked, or the allowlist shrank after a link was cut.
    // The route must not treat "Platter signed it" as "the target is safe".
    for (const hostile of [
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:8080/admin',
      'file:///etc/passwd',
    ]) {
      const response = await iconRequest({ url: hostile, sig: signIconUrl(serverId, hostile) });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('bad_request');
    }

    expect(spy).not.toHaveBeenCalled();
  });

  it('answers a broken upstream with a clean status the client can fall back on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    const response = await app.inject({
      method: 'GET',
      url: proxiedIconUrl(serverId, MODRINTH_ICON) ?? '',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('not_found');
  });
});
