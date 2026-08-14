import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { API_PREFIX, WS_PATH } from '@platter/shared';
import { config } from '../config.js';

/**
 * Serves the built web client from the same origin as the API.
 *
 * This is what makes Platter one container rather than two. Same origin also means the
 * refresh cookie is first-party and there is no CORS policy to get wrong — the two failure
 * modes a split deployment reliably produces.
 *
 * The 404 half lives in the error handler rather than here: Fastify allows exactly one
 * not-found handler per encapsulation context, and that plugin already owns the root one.
 * This module supplies the predicate and the sender it calls.
 */

/** Paths that belong to the server and must never resolve to the app shell. */
const RESERVED_PREFIXES = [API_PREFIX, '/ws', '/docs'] as const;

let appShellAvailable = false;

/**
 * Whether this request should fall through to the client-side router.
 *
 * A missing `/api` path stays a JSON 404 so a client gets a parseable error rather than
 * HTML it will try to parse as JSON; a non-GET never resolves to a page; and a request that
 * does not accept HTML is a fetch, not a navigation.
 */
export function wantsAppShell(request: FastifyRequest): boolean {
  if (!appShellAvailable) return false;
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;

  const pathname = (request.url.split('?')[0] ?? request.url) || '/';
  if (
    RESERVED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
  ) {
    return false;
  }
  // WS_PATH is parameterised (`/ws/servers/:serverId/console`); its literal head is covered
  // by the `/ws` prefix above. Asserting that here keeps the two from drifting apart.
  if (!WS_PATH.startsWith('/ws')) return false;

  return request.headers.accept?.includes('text/html') ?? false;
}

/**
 * Sends the app shell. Only call when `wantsAppShell` returned true.
 *
 * `cacheControl: false` is load-bearing, not tidiness. Without it `sendFile` applies the
 * registration's own `maxAge: '1y', immutable: true` and overwrites the header set here — so
 * the shell went out as `public, max-age=31536000, immutable`, pinning every browser that
 * ever loaded the panel to that day's asset hashes. The next upgrade then serves a cached
 * shell pointing at files that no longer exist: a blank page that only a hard refresh clears,
 * for exactly the users who visit most often.
 *
 * Setting the header before `sendFile` reads as correct and is not, which is why the
 * behaviour is asserted in a test rather than trusted to this comment.
 */
export function sendAppShell(reply: FastifyReply): FastifyReply {
  return reply
    .code(200)
    .type('text/html; charset=utf-8')
    .header('cache-control', 'no-cache')
    .sendFile('index.html', { cacheControl: false });
}

async function spaPlugin(app: FastifyInstance): Promise<void> {
  const root = config.webRoot;
  if (root === null) {
    app.log.debug('WEB_ROOT is unset; serving the API only (development uses Vite)');
    return;
  }

  try {
    await access(path.join(root, 'index.html'), constants.R_OK);
  } catch {
    // A misconfigured WEB_ROOT must not take the API down with it: the panel stays fully
    // usable over HTTP, and the warning names the exact path that was wrong.
    app.log.warn({ webRoot: root }, 'WEB_ROOT has no readable index.html; serving API only');
    return;
  }

  await app.register(fastifyStatic, {
    root,
    // Unknown paths are the client router's, and the error handler routes them there.
    wildcard: false,
    /*
     * `index: false` so this handler serves only real files — never the app shell. Every
     * copy of index.html then leaves through `sendAppShell`, which is the single place its
     * headers are decided.
     *
     * That matters because Vite emits content-hashed asset filenames, which are safe to
     * cache forever, while index.html is the file that points at the current hashes. A
     * cached shell after an upgrade requests assets that no longer exist, and presents as a
     * blank page only a hard refresh clears.
     */
    index: false,
    maxAge: '1y',
    immutable: true,
  });

  appShellAvailable = true;
  app.log.info({ webRoot: root }, 'serving the web client');
}

export default Object.assign(spaPlugin, {
  // The same marker `fastify-plugin` sets, which is not a dependency here (the error handler
  // does this too). Without it, `sendFile` and the static routes would be confined to this
  // plugin's own encapsulation context and the root 404 handler could not reach them.
  [Symbol.for('skip-override')]: true,
});
