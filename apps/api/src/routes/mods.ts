import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { RateLimitOptions } from '@fastify/rate-limit';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireServer } from '../plugins/auth.js';
import {
  MOD_SOURCES,
  aggregateModSearchResultSchema,
  availableModSources,
  modDetailSchema,
  modSourceSchema,
  modVersionSchema,
} from '../mods/registry.js';
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
      return searchServerMods(
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
    async (request, reply) =>
      getServerMod(
        requireServer(request),
        request.params.source,
        request.params.project,
        clientAbortSignal(reply),
        request.log,
      ),
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
