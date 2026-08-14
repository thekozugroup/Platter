import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { BLUEPRINT_CATEGORIES, blueprintSchema, blueprintSummarySchema } from '@platter/shared';
import { getBlueprint, listBlueprintSummaries } from '../services/blueprints.js';

/**
 * The blueprint catalogue over HTTP.
 *
 * Read-only by design: blueprints ship with the build, so there is no create or update here
 * and no admin surface to protect. Authentication is still required — the catalogue names the
 * exact images and versions this deployment runs, which is not something to hand to anonymous
 * callers.
 *
 * `authenticate` rather than a scope, deliberately and on the record: the catalogue is
 * identical on every Platter of the same version and says nothing about *this* install — no
 * server, no node, no address. A scope here would also have to be invented (there is no
 * `blueprints.read` in the vocabulary), and the MCP `list_blueprints` tool is open to any
 * key for the same reason, so restricting one surface and not the other would be the worst
 * of both.
 */

const listQuerySchema = z.object({
  category: z.enum(BLUEPRINT_CATEGORIES).optional(),
  /** Matched against key, name, game and summary. */
  search: z.string().trim().min(1).max(80).optional(),
  feature: z.enum(['console', 'rcon', 'mods', 'worldUpload', 'playerList']).optional(),
});

/**
 * Not paginated. The catalogue is a dozen entries that ship with the binary, and a picker
 * that has to fetch page two of twelve games would be a worse experience for no benefit.
 */
const listResponseSchema = z.object({ data: z.array(blueprintSummarySchema) });

const blueprintRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['blueprints'],
        summary: 'List the available game blueprints',
        querystring: listQuerySchema,
        response: { 200: listResponseSchema },
      },
    },
    async (request) => {
      const { category, search, feature } = request.query;
      return { data: listBlueprintSummaries({ category, search, feature }) };
    },
  );

  app.get(
    '/:key',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['blueprints'],
        summary: 'Get one blueprint, with its variables and file templates',
        // Deliberately looser than the blueprint key regex: an unknown-but-well-formed key and
        // a malformed one should both come back as the same 404 from `getBlueprint`.
        params: z.object({ key: z.string().min(1).max(64) }),
        response: { 200: blueprintSchema },
      },
    },
    async (request) => getBlueprint(request.params.key),
  );
};

export default blueprintRoutes;
