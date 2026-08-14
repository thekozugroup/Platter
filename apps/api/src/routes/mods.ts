import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { RateLimitOptions } from '@fastify/rate-limit';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { forbidden } from '../lib/errors.js';
import { requireServer } from '../plugins/auth.js';
import {
  MOD_SOURCES,
  aggregateModSearchResultSchema,
  availableModSources,
  modDetailSchema,
  modSourceSchema,
  modVersionSchema,
  type ModDetail,
} from '../mods/registry.js';
import {
  ICON_CACHE_CONTROL,
  ICON_MAX_URL_LENGTH,
  ICON_ROUTE_PATH,
  assertProxyableIconUrl,
  fetchModIcon,
  proxiedIconUrl,
  verifyIconSignature,
} from '../mods/icon-proxy.js';
import { installedModSchema } from '../mods/resolve.js';
import { recordAuditFromRequest } from '../services/audit.js';
import {
  checkModUpdates,
  getServerMod,
  listInstalledMods,
  listServerModVersions,
  removeInstalledMod,
  searchServerMods,
} from '../services/mods.js';

/**
 * The mod browser for one server.
 *
 * There is no install endpoint here, and that is a design constraint rather than an omission:
 * installation is reachable only by approving a proposal, so an API key with `ai.use` can
 * suggest a mod and cannot land one. See `routes/proposals.ts` and docs/ARCHITECTURE.md §4.
 *
 * Every read below fans out to a third-party API, so these routes carry their own, much
 * tighter, rate limit than the global one — a client polling search at the global budget would
 * spend Platter's entire Modrinth allowance on one user.
 */

/** Upstream-bound reads. Comfortable for a person typing; useless for a scraper. */
const UPSTREAM_RATE_LIMIT: RateLimitOptions = { max: 40, timeWindow: '1 minute' };

/** The update check is one upstream request per installed mod, so it gets its own budget. */
const UPDATE_CHECK_RATE_LIMIT: RateLimitOptions = { max: 6, timeWindow: '1 minute' };

/**
 * Icons are counted in tiles, not in searches: one grid is twenty-odd requests and opening a
 * detail sheet adds a gallery, so the budget above would be spent by a single screen. It stays
 * a budget rather than being unlimited because each request is still an upstream fetch — and
 * only the *first* view costs anything, since the responses are immutable and cache for a year.
 */
const ICON_RATE_LIMIT: RateLimitOptions = { max: 240, timeWindow: '1 minute' };

/**
 * Deliberately looser than an id's real shape (mirrors `routes/files.ts`): a malformed id must
 * reach `requireServerAccess` and come back as the same 404 a missing one does.
 */
const serverIdParamSchema = z.object({ serverId: z.string().min(1).max(64) });

const projectParamSchema = serverIdParamSchema.extend({
  source: modSourceSchema,
  /** A Modrinth slug or id, or a CurseForge numeric id. */
  project: z.string().min(1).max(128),
});

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  source: modSourceSchema.optional(),
  category: z.string().trim().min(1).max(48).optional(),
  /** Overrides the server's own version; `any` drops the constraint for a wider look. */
  gameVersion: z.string().trim().min(1).max(32).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(5000).default(0),
});

const modDetailResponseSchema = z.object({
  mod: modDetailSchema,
  compatibleVersions: z.array(modVersionSchema),
  installed: installedModSchema.nullable(),
  target: z.enum(['mods', 'plugins']).nullable(),
  incompatibleReason: z.string().nullable(),
});

const installedResponseSchema = z.object({
  data: z.array(installedModSchema),
  /** Which sources this deployment can reach, so the UI hides CurseForge when unconfigured. */
  sources: z.array(modSourceSchema),
});

const updatesResponseSchema = z.object({
  data: z.array(
    z.object({
      installed: installedModSchema,
      latest: modVersionSchema,
      prerelease: z.boolean(),
    }),
  ),
});

/**
 * An AbortSignal that fires when the client hangs up.
 *
 * Checked against `writableEnded` so a normally-completed response does not abort work that
 * has already finished. Passed all the way down to `fetch`, so a closed tab stops costing
 * upstream requests instead of running the search to completion for nobody.
 */
export function clientAbortSignal(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.once('close', () => {
    if (!reply.raw.writableEnded) controller.abort();
  });
  return controller.signal;
}

// ---------------------------------------------------------------------------------------
// Artwork
// ---------------------------------------------------------------------------------------

/**
 * Registry artwork is rewritten to a same-origin proxy path on the way out.
 *
 * This happens here, at the response boundary, rather than in the client: `img-src` is pinned
 * to `'self'`, so a raw `cdn.modrinth.com` URL in a payload is a tile the browser refuses to
 * paint. Rewriting server-side means every consumer — the grid, the detail sheet, the approval
 * screen — gets a URL that works, with nothing to remember. See `mods/icon-proxy.ts` for why
 * proxying beats widening the policy.
 *
 * A URL that cannot be proxied becomes null, which is the same signal a mod with no artwork
 * sends, and the client draws its monogram.
 */
export function withProxiedIcon<T extends { iconUrl: string | null }>(
  serverId: string,
  value: T,
): T {
  return { ...value, iconUrl: proxiedIconUrl(serverId, value.iconUrl) };
}

/**
 * Gallery screenshots are the same CDN and the same CSP problem as the icon.
 *
 * Unlike `iconUrl`, a gallery entry's `url` is non-nullable and doubles as the "open full size"
 * link, so an unproxyable one is left exactly as it was rather than dropped — no better, but no
 * worse than before.
 */
export function withProxiedArtwork(serverId: string, mod: ModDetail): ModDetail {
  return {
    ...withProxiedIcon(serverId, mod),
    gallery: mod.gallery.map((image) => {
      const proxied = proxiedIconUrl(serverId, image.url);
      return proxied === null ? image : { ...image, url: proxied };
    }),
  };
}

const iconQuerySchema = z.object({
  /** The upstream CDN URL. Refused unless it is on the allowlist in `icon-proxy.ts`. */
  url: z.string().min(1).max(ICON_MAX_URL_LENGTH),
  /** HMAC over `(serverId, url)`. Proof that Platter minted this link for an authorised view. */
  sig: z.string().min(1).max(128),
});

const modRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/',
    {
      preHandler: app.requireServerAccess('server.view'),
      config: { rateLimit: UPSTREAM_RATE_LIMIT },
      schema: {
        tags: ['mods'],
        summary: 'Search mods that this server could load',
        params: serverIdParamSchema,
        querystring: searchQuerySchema,
        response: { 200: aggregateModSearchResultSchema },
      },
    },
    async (request, reply) => {
      const server = requireServer(request);
      const { q, source, category, gameVersion, limit, offset } = request.query;
      const results = await searchServerMods(
        server,
        {
          query: q ?? null,
          categories: category === undefined ? [] : [category],
          sources: source === undefined ? MOD_SOURCES : [source],
          // `any` is the explicit escape hatch for "show me everything, I will judge".
          ...(gameVersion === undefined
            ? {}
            : { gameVersion: gameVersion === 'any' ? null : gameVersion }),
          limit,
          offset,
          signal: clientAbortSignal(reply),
        },
        request.log,
      );
      return {
        ...results,
        hits: results.hits.map((hit) => withProxiedIcon(server.id, hit)),
      };
    },
  );

  app.get(
    '/installed',
    {
      preHandler: app.requireServerAccess('server.view'),
      schema: {
        tags: ['mods'],
        summary: 'List the mods Platter installed on this server',
        params: serverIdParamSchema,
        response: { 200: installedResponseSchema },
      },
    },
    // No artwork rewrite here: `installedModSchema` carries no `iconUrl` at all — the
    // installed list is drawn from Platter's own manifest and renders monograms.
    async (request) => ({
      data: await listInstalledMods(requireServer(request)),
      sources: availableModSources(),
    }),
  );

  app.get(
    '/updates',
    {
      preHandler: app.requireServerAccess('server.view'),
      config: { rateLimit: UPDATE_CHECK_RATE_LIMIT },
      schema: {
        tags: ['mods'],
        summary: 'Check installed mods for newer compatible versions',
        params: serverIdParamSchema,
        response: { 200: updatesResponseSchema },
      },
    },
    async (request, reply) => ({
      data: await checkModUpdates(requireServer(request), clientAbortSignal(reply), request.log),
    }),
  );

  /**
   * Streams one registry image back from Platter's own origin.
   *
   * **Why there is no `requireServerAccess` here.** A browser `<img>` cannot attach an
   * `Authorization` header or an `X-API-Key`, so header authentication is not available to the
   * only caller this endpoint has. The `sig` parameter is the authenticator instead: it is an
   * HMAC over `(serverId, url)` keyed off `JWT_SECRET`, and it is minted *only* by the handlers
   * above, every one of which ran behind `requireServerAccess('server.view')`. A caller holding
   * a working link therefore holds proof that an authorised view produced it, and no one else
   * can forge one. It is a narrower grant than a bearer token would be: a token would unlock
   * every allowlisted URL, a signature unlocks exactly the one it was cut for.
   *
   * Registered before `/:source/:project` for readability; find-my-way prefers the static
   * segment regardless, and the two differ in arity anyway.
   */
  app.get(
    ICON_ROUTE_PATH,
    {
      config: { rateLimit: ICON_RATE_LIMIT },
      schema: {
        tags: ['mods'],
        summary: 'Proxy a mod’s icon or gallery image from the registry CDN',
        description:
          "Same-origin delivery for registry artwork, so `img-src` can stay `'self'`. The URL is " +
          'signed by Platter when it serves mod data; it is not meant to be constructed by hand.',
        security: [],
        params: serverIdParamSchema,
        querystring: iconQuerySchema,
      },
    },
    async (request, reply) => {
      const { serverId } = request.params;
      const { url, sig } = request.query;

      // Signature first, and before the URL is even parsed: an unsigned caller learns nothing
      // about which hosts are allowlisted or what this endpoint would have done.
      if (!verifyIconSignature(serverId, url, sig)) {
        throw forbidden('That image link is not valid.');
      }

      // Re-validated rather than trusted. The signature proves Platter minted the link, not
      // that the allowlist is the same one that was in force when it did.
      const target = assertProxyableIconUrl(url);
      const icon = await fetchModIcon(target, { signal: clientAbortSignal(reply) });

      return (
        reply
          .header('content-type', icon.contentType)
          .header('content-length', icon.body.byteLength)
          .header('cache-control', ICON_CACHE_CONTROL)
          // Belt and braces on top of the content-type allowlist: never let a browser sniff
          // these bytes into something executable.
          .header('x-content-type-options', 'nosniff')
          .header('content-security-policy', "default-src 'none'; sandbox")
          .header('cross-origin-resource-policy', 'same-origin')
          .send(icon.body)
      );
    },
  );

  app.get(
    '/:source/:project',
    {
      preHandler: app.requireServerAccess('server.view'),
      config: { rateLimit: UPSTREAM_RATE_LIMIT },
      schema: {
        tags: ['mods'],
        summary: 'Everything about one mod, including whether this server can load it',
        params: projectParamSchema,
        response: { 200: modDetailResponseSchema },
      },
    },
    async (request, reply) => {
      const server = requireServer(request);
      const detail = await getServerMod(
        server,
        request.params.source,
        request.params.project,
        clientAbortSignal(reply),
        request.log,
      );
      return { ...detail, mod: withProxiedArtwork(server.id, detail.mod) };
    },
  );

  app.get(
    '/:source/:project/versions',
    {
      preHandler: app.requireServerAccess('server.view'),
      config: { rateLimit: UPSTREAM_RATE_LIMIT },
      schema: {
        tags: ['mods'],
        summary: 'List a mod’s versions, filtered to this server’s loader and game version',
        params: projectParamSchema,
        response: { 200: z.object({ data: z.array(modVersionSchema) }) },
      },
    },
    async (request, reply) => ({
      data: await listServerModVersions(
        requireServer(request),
        request.params.source,
        request.params.project,
        clientAbortSignal(reply),
        request.log,
      ),
    }),
  );

  app.delete(
    '/:source/:project',
    {
      // Deleting a jar is a file deletion, and that is the permission that governs it. A
      // reviewer who may not delete files may not uninstall a mod either.
      preHandler: app.requireServerAccess('files.delete'),
      schema: {
        tags: ['mods'],
        summary: 'Uninstall a mod and delete its file',
        params: projectParamSchema,
        response: { 200: installedModSchema },
      },
    },
    async (request) => {
      const server = requireServer(request);
      const removed = await removeInstalledMod(
        server,
        request.params.source,
        request.params.project,
      );
      await recordAuditFromRequest(request, {
        action: 'file.deleted',
        targetType: 'server',
        targetId: server.id,
        targetName: server.name,
        metadata: {
          kind: 'mod',
          paths: [`${removed.target}/${removed.filename}`],
          source: removed.source,
          projectId: removed.projectId,
          mod: removed.title,
        },
      });
      return removed;
    },
  );
};

export default modRoutes;
