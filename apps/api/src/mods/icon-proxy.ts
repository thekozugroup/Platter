import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { API_PREFIX, PlatterError } from '@platter/shared';
import { config } from '../config.js';

/**
 * Same-origin delivery of registry artwork.
 *
 * Mod icons and gallery screenshots live on Modrinth's and CurseForge's CDNs, and the panel's
 * own Content-Security-Policy pins `img-src` to `'self'`. Rather than widening the policy to
 * name two third-party CDNs, the image is fetched here and streamed back from Platter's own
 * origin. Three reasons that is the better trade for a self-hosted panel:
 *
 *  1. **No third-party beacon.** An `<img src="https://cdn.modrinth.com/data/AANobbMI/…">` is a
 *     request the operator's browser makes directly to Modrinth, carrying an IP and a Referer,
 *     one per mod on screen. That hands a third party a running log of which mods this
 *     deployment's admins are looking at. Proxying means the browser only ever talks to Platter.
 *  2. **It works behind an egress proxy.** `lib/http-proxy.ts` exists because a self-hosted box
 *     frequently reaches the internet only through `HTTPS_PROXY`, and Node's `fetch` ignores
 *     that variable unless the dispatcher is installed. The *server* is configured for that
 *     network; the operator's browser is not. Fetching server-side is the only path that works
 *     on a host with no direct browser egress — which is exactly the deployment Platter targets.
 *  3. **The CSP stays tight.** `img-src 'self'` is a real control. Widening it to two CDN
 *     wildcards to render an icon spends a security boundary on decoration, and every future
 *     registry would widen it again.
 *
 * ### Why the URL carries a signature instead of a bearer token
 *
 * Platter authenticates with an `Authorization` header or `X-API-Key`. A browser `<img>` tag
 * can send neither — there is no hook to attach a header to an image load. So the authorisation
 * has to travel in the URL, and it does: every proxy URL is HMAC-signed with a key derived from
 * `JWT_SECRET`, and the signature is minted **only** inside handlers that have already passed
 * `requireServerAccess('server.view')`. Holding a working URL is therefore proof that an
 * authorised session produced it, and an unauthenticated caller cannot forge one. This is
 * tighter than accepting a bearer token here would be: a token would let any authenticated
 * caller pull any allowlisted URL, whereas a signature only unlocks the one URL it was cut for.
 *
 * The signature deliberately carries **no expiry**. An expiring URL would change on every
 * response, so the browser would miss its cache on every page load and re-fetch every icon —
 * defeating the immutable caching these content-addressed assets are perfect for. Rotating
 * `JWT_SECRET` invalidates every outstanding URL, which is the only revocation that matters
 * for a public CDN image.
 */

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * The only hosts this proxy will fetch from.
 *
 * Exact hostnames, compared against a Set — no wildcards and no suffix matching, because
 * `endsWith('.forgecdn.net')` is one typo away from matching `evil-forgecdn.net` and suffix
 * rules are how allowlists quietly stop being allowlists. A proxy that fetches whatever URL a
 * caller hands it is a textbook SSRF: the attacker's target is not the CDN, it is
 * `http://169.254.169.254/` or an admin panel bound to loopback on the same box.
 *
 * An operator running against a Modrinth *mirror* will see icons fall back to the monogram
 * `ModIcon` draws rather than an error, because minting refuses a non-allowlisted host up front.
 * That is the intended degradation: a broken tile is worse than a plain one.
 */
export const ICON_ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  // Modrinth project icons and gallery images.
  'cdn.modrinth.com',
  'cdn-raw.modrinth.com',
  // CurseForge `logo.url` and gallery images.
  'media.forgecdn.net',
  'mediafilez.forgecdn.net',
  'edge.forgecdn.net',
]);

/**
 * Content types this proxy will pass through.
 *
 * `image/svg+xml` is deliberately absent. An SVG is an active document: served from Platter's
 * own origin it becomes a same-origin page that can carry script, so proxying attacker-authored
 * SVG would convert "a mod author uploaded an icon" into stored XSS against the panel. Neither
 * registry needs it — Modrinth transcodes icons to WebP/PNG — and an unrecognised type falls
 * back to the monogram.
 */
const ALLOWED_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

/**
 * Hard ceiling on an upstream body. Icons are a few kilobytes and gallery screenshots a few
 * hundred; anything past this is not artwork. The body is read through a counter and the
 * connection cancelled the moment it is exceeded, so an upstream that lies about
 * `Content-Length` — or omits it — still cannot make Platter buffer without bound.
 */
export const ICON_MAX_BYTES = 6 * 1024 * 1024;

/** Whole-request budget, redirects included. A CDN that hangs must not pin a connection open. */
export const ICON_TIMEOUT_MS = 10_000;

/** CDNs occasionally 302 between edges. Each hop is re-validated against the allowlist. */
const MAX_REDIRECTS = 3;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * A year, immutable. Modrinth filenames embed a content hash and CurseForge media paths are
 * versioned, so the bytes behind one of these URLs never change.
 *
 * `private` rather than `public`: the response is an authorised one, and while the image itself
 * is public, which icons a panel requests is exactly the browsing history reason (1) above is
 * about. Keeping it out of shared caches costs nothing — the browser cache is the one that
 * matters here.
 */
export const ICON_CACHE_CONTROL = 'private, max-age=31536000, immutable';

/** Query-parameter bound. Real registry URLs are ~90 characters. */
export const ICON_MAX_URL_LENGTH = 2048;

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * Every failure below is a 4xx/5xx *with a code*, and never an unhandled throw. The client
 * renders `<img onError>` into a monogram, so the only thing a broken upstream should cost is
 * one tile's artwork — never a 500 in the operator's logs for a CDN having a bad minute.
 */
function iconNotFound(): PlatterError {
  return new PlatterError('not_found', 'That image is not available.');
}

function iconUnavailable(): PlatterError {
  return new PlatterError('service_unavailable', 'That image could not be fetched right now.');
}

function iconRejected(reason: string): PlatterError {
  return new PlatterError('bad_request', reason);
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/** Lowercases, drops a fully-qualified trailing dot, and unwraps IPv6 brackets. */
function normaliseHost(hostname: string): string {
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.') && host.length > 1) host = host.slice(0, -1);
  return host;
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  const [a = 0, b = 0] = octets;
  if (a === 0) return true; // "this network"
  if (a === 10) return true;
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const value = address.toLowerCase();
  if (value === '::' || value === '::1') return true;
  // IPv4-mapped (`::ffff:127.0.0.1`) is a loopback request wearing a v6 costume.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped?.[1] !== undefined) return isPrivateIpv4(mapped[1]);
  if (value.startsWith('fc') || value.startsWith('fd')) return true; // unique-local
  if (/^fe[89ab]/.test(value)) return true; // link-local
  return false;
}

/**
 * True for a loopback, private, link-local or otherwise non-routable address literal.
 *
 * Strictly speaking the allowlist already refuses these — no IP literal is a member. This is
 * kept as a separate, separately-tested gate because the allowlist is the kind of thing that
 * grows a mirror entry one day, and the day it does, this is the check that still stops
 * `http://127.0.0.1:8080/` and `http://169.254.169.254/latest/meta-data/`.
 */
export function isPrivateAddressLiteral(hostname: string): boolean {
  const host = normaliseHost(hostname);
  const version = isIP(host);
  if (version === 4) return isPrivateIpv4(host);
  if (version === 6) return isPrivateIpv6(host);
  return false;
}

/**
 * Parses `raw` and refuses it unless it is an http(s) URL on an allowlisted CDN host.
 *
 * Throws rather than returning null so no caller can forget to check the result.
 */
export function assertProxyableIconUrl(raw: string): URL {
  if (raw.length > ICON_MAX_URL_LENGTH) throw iconRejected('That image URL is too long.');

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw iconRejected('That is not a valid image URL.');
  }

  // Blocks `file:`, `data:`, `gopher:`, `ftp:` and every other scheme whose only use here
  // would be reading something off the Platter host.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw iconRejected('Only http and https image URLs can be fetched.');
  }
  // `https://allowed.host@evil.test/` parses with hostname `evil.test`; refusing userinfo
  // outright removes the class of confusion rather than relying on having parsed it right.
  if (url.username !== '' || url.password !== '') {
    throw iconRejected('Image URLs may not carry credentials.');
  }

  const host = normaliseHost(url.hostname);
  if (isPrivateAddressLiteral(host)) {
    throw iconRejected('That image URL points at a private address.');
  }
  if (!ICON_ALLOWED_HOSTS.has(host)) {
    throw iconRejected('That image host is not one Platter fetches from.');
  }

  return url;
}

/** Non-throwing form, for deciding whether a URL is worth minting a proxy link for. */
export function isProxyableIconUrl(raw: string): boolean {
  try {
    assertProxyableIconUrl(raw);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Domain separation: the icon key is derived from `JWT_SECRET` rather than being it, so a
 * signature here can never be confused with — or used to probe — a session token.
 */
const SIGNING_LABEL = 'platter:mod-icon:v1';

let signingKey: Buffer | null = null;

function iconSigningKey(): Buffer {
  signingKey ??= createHmac('sha256', config.jwtSecret).update(SIGNING_LABEL).digest();
  return signingKey;
}

/** Binds the upstream URL to one server, so a link is scoped to the context that minted it. */
export function signIconUrl(serverId: string, upstream: string): string {
  return createHmac('sha256', iconSigningKey())
    .update(`${SIGNING_LABEL}\n${serverId}\n${upstream}`)
    .digest('base64url');
}

export function verifyIconSignature(
  serverId: string,
  upstream: string,
  presented: string,
): boolean {
  const expected = Buffer.from(signIconUrl(serverId, upstream), 'utf8');
  const actual = Buffer.from(presented, 'utf8');
  // Length is not secret (the digest is fixed-width) and timingSafeEqual throws on a mismatch.
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

/** The path the route below is mounted at, relative to the mods prefix. */
export const ICON_ROUTE_PATH = '/icon';

/**
 * Rewrites one upstream image URL into a same-origin, signed proxy path.
 *
 * Returns null — rather than a link that would 400 — for anything not proxyable, so the client
 * renders its monogram immediately instead of firing a request that can only fail.
 */
export function proxiedIconUrl(serverId: string, upstream: string | null): string | null {
  if (upstream === null || upstream.length === 0) return null;
  if (!isProxyableIconUrl(upstream)) return null;

  const query = new URLSearchParams({ url: upstream, sig: signIconUrl(serverId, upstream) });
  return `${API_PREFIX}/servers/${encodeURIComponent(serverId)}/mods${ICON_ROUTE_PATH}?${query.toString()}`;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * Same identification Modrinth asks of any client. Kept local rather than imported from
 * `modrinth.ts` because this proxy also serves CurseForge media and must not depend on either
 * provider module.
 */
function iconUserAgent(): string {
  const contact = process.env['PLATTER_CONTACT']?.trim();
  const base = 'Platter/0.1.0 (+https://github.com/platter-panel/platter)';
  return contact !== undefined && contact.length > 0 ? `${base} (${contact})` : base;
}

export interface FetchedIcon {
  contentType: string;
  body: Buffer;
}

export interface FetchIconOptions {
  /** Aborts the fetch when the client hangs up. Combined with this module's own timeout. */
  signal?: AbortSignal;
  /**
   * Injected so the suite can drive every branch — redirect, wrong content-type, oversized
   * body — without a live network, the same way the registry providers take theirs.
   */
  fetch?: typeof globalThis.fetch;
}

/** `image/webp; charset=utf-8` -> `image/webp`. */
function baseContentType(header: string | null): string | null {
  if (header === null) return null;
  const value = header.split(';')[0]?.trim().toLowerCase();
  return value !== undefined && value.length > 0 ? value : null;
}

/**
 * Reads a body with a hard ceiling.
 *
 * Deliberately buffered rather than piped straight to the reply. Piping an upstream stream to a
 * client means Platter has no idea how much it is about to relay and no point at which it can
 * stop, so a CDN serving a multi-gigabyte body — compromised, misconfigured, or just a wrong
 * URL — becomes memory and bandwidth Platter spends on someone else's behalf. Counting on the
 * way through, and cancelling upstream the moment the cap is passed, bounds it at
 * `ICON_MAX_BYTES` regardless of what the response claims.
 */
async function readCapped(response: Response): Promise<Buffer> {
  const body = response.body;
  if (body === null) throw iconUnavailable();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > ICON_MAX_BYTES) {
        await reader.cancel();
        throw new PlatterError('payload_too_large', 'That image is larger than Platter proxies.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

/**
 * Fetches one allowlisted image.
 *
 * Goes through the global `undici` dispatcher, which `lib/http-proxy.ts` replaces at startup —
 * so on a host with `HTTPS_PROXY` set, this call follows the same egress path as mod search.
 *
 * `target` must already have come from `assertProxyableIconUrl`.
 */
export async function fetchModIcon(
  target: URL,
  options: FetchIconOptions = {},
): Promise<FetchedIcon> {
  const { signal, fetch: fetchImpl = globalThis.fetch } = options;
  const timeout = AbortSignal.timeout(ICON_TIMEOUT_MS);
  const composite = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

  let current = target;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      response = await fetchImpl(current, {
        method: 'GET',
        // Manual, so a redirect is a decision this code makes rather than one undici makes
        // for it. `redirect: 'follow'` would happily chase a CDN's open redirect off the
        // allowlist and onto a private address — the SSRF the allowlist exists to stop.
        redirect: 'manual',
        signal: composite,
        headers: { accept: 'image/*', 'user-agent': iconUserAgent() },
      });
    } catch {
      // Timeout, DNS failure, connection reset, client hang-up. None is a Platter bug.
      throw iconUnavailable();
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (location === null || location.length === 0) throw iconUnavailable();

      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw iconUnavailable();
      }
      // Re-validated in full: a hop to a foreign host, another scheme, or a private literal
      // is refused exactly as the original URL would have been.
      if (!isProxyableIconUrl(next.toString())) throw iconUnavailable();
      current = next;
      continue;
    }

    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel();
      throw iconNotFound();
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw iconUnavailable();
    }

    // The allowlist says where the bytes came from; this says what they are. Without it a
    // compromised or sloppy CDN path could return HTML or a script and have Platter serve it
    // from its own origin.
    const contentType = baseContentType(response.headers.get('content-type'));
    if (contentType === null || !ALLOWED_IMAGE_TYPES.has(contentType)) {
      await response.body?.cancel();
      throw iconRejected('That URL did not return an image Platter can display.');
    }

    // Cheap pre-check; `readCapped` is the one that actually enforces the bound.
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > ICON_MAX_BYTES) {
      await response.body?.cancel();
      throw new PlatterError('payload_too_large', 'That image is larger than Platter proxies.');
    }

    return { contentType, body: await readCapped(response) };
  }

  throw iconUnavailable();
}
