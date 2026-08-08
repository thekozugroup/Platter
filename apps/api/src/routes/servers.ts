import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  consoleCommandRequestSchema,
  createServerRequestSchema,
  listServersQuerySchema,
  paginatedSchema,
  powerRequestSchema,
  serverSchema,
  serverStatsSchema,
  serverSubuserSchema,
  serverSummarySchema,
  updateServerRequestSchema,
  upsertSubuserRequestSchema,
  type PowerAction,
  type ServerPermission,
} from '@platter/shared';
import { forbidden, unauthenticated } from '../lib/errors.js';
import { requireServer, type AuthenticatedUser } from '../plugins/auth.js';
import { recordAuditFromRequest } from '../services/audit.js';
import {
  deleteServer,
  performPowerAction,
  reinstallServer,
  sendCommand,
} from '../services/lifecycle.js';
import {
  addSubuser,
  assertSendableCommand,
  createServer,
  getServerStats,
  listServers,
  listSubusers,
  loadServerDto,
  removeSubuser,
  serverPermissionsFor,
  updateServer,
  updateSubuser,
} from '../services/servers.js';

/**
 * The core server surface: the list, one server, its power state and its collaborators.
 *
 * Two rules keep this file thin. Authorisation is always a `requireServerAccess`
 * preHandler, never an `if` in a handler — so a route that forgets one fails closed at
 * `requireServer` instead of serving unauthorised data. And no handler touches Prisma or a
 * driver directly: `services/servers.ts` owns the row-to-wire mapping and
 * `services/lifecycle.ts` owns every status transition, because a status written from here
 * would never reach the console socket.
 */

/**
 * Deliberately looser than an id's real shape (mirrors `fileRoutes`): this exists only so
 * `request.params.serverId` is typed. A malformed id has to reach `requireServerAccess`
 * and come back as the same 404 a well-formed but missing one does, rather than a 422 that
 * tells a prober the difference.
 */
const serverIdParamSchema = z.object({ serverId: z.string().min(1).max(64) });
const subuserParamSchema = serverIdParamSchema.extend({ subuserId: z.string().min(1).max(64) });

const deletedResponseSchema = z.object({ id: z.string(), deleted: z.literal(true) });
const commandResponseSchema = z.object({ accepted: z.literal(true) });

/**
 * A power action maps onto its own permission, so a collaborator can be trusted to restart
 * a server without being able to stop it for good. `kill` is an escalation of `stop` — it
 * is what you reach for when a graceful stop wedged — so it rides on the same grant rather
 * than inventing a `power.kill` the shared vocabulary does not have.
 */
const POWER_PERMISSIONS: Record<PowerAction, ServerPermission> = {
  start: 'power.start',
  stop: 'power.stop',
  restart: 'power.restart',
  kill: 'power.stop',
};

function actor(request: { auth: { user: AuthenticatedUser } | null }): AuthenticatedUser {
  // Every route here runs behind `authenticate` or `requireServerAccess`, both of which
  // populate `auth`. Throwing beats a non-null assertion: if a route is ever added without
  // one, this fails loudly instead of attributing the action to nobody.
  if (!request.auth) throw unauthenticated();
  return request.auth.user;
}

const serverRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['servers'],
        summary: 'List servers visible to the caller',
        querystring: listServersQuerySchema,
        response: { 200: paginatedSchema(serverSummarySchema) },
      },
    },
    async (request) => listServers(request.query, actor(request)),
  );

  app.post(
    '/',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['servers'],
        summary: 'Create a server',
        body: createServerRequestSchema,
        response: { 201: serverSchema },
      },
    },
    async (request, reply) => {
      const created = await createServer(request.body, actor(request), request.log);
      await recordAuditFromRequest(request, {
        action: 'server.created',
        targetType: 'server',
        targetId: created.id,
        targetName: created.name,
        metadata: { blueprintKey: created.blueprintKey, nodeId: created.nodeId },
      });
      return reply.code(201).send(created);
    },
  );

  app.get(
    '/:serverId',
    {
      preHandler: app.requireServerAccess('server.view'),
      schema: {
        tags: ['servers'],
        summary: 'Get one server',
        params: serverIdParamSchema,
        response: { 200: serverSchema },
      },
    },
    async (request) => loadServerDto(requireServer(request).id, request.log),
  );

  app.patch(
    '/:serverId',
    {
      preHandler: app.requireServerAccess('server.update'),
      schema: {
        tags: ['servers'],
        summary: 'Update a server',
        params: serverIdParamSchema,
        body: updateServerRequestSchema,
        response: { 200: serverSchema },
      },
    },
    async (request) => {
      const server = requireServer(request);
      const updated = await updateServer(server, request.body, request.log);
      await recordAuditFromRequest(request, {
        action: 'server.updated',
        targetType: 'server',
        targetId: server.id,
        targetName: updated.name,
        // The changed keys, not the values: a variable can hold an RCON password, and the
        // audit log is readable by every admin.
        metadata: { fields: Object.keys(request.body) },
      });
      return updated;
    },
  );

  app.delete(
    '/:serverId',
    {
      preHandler: app.requireServerAccess('server.delete'),
      schema: {
        tags: ['servers'],
        summary: 'Delete a server, its container and its data',
        params: serverIdParamSchema,
        response: { 200: deletedResponseSchema },
      },
    },
    async (request) => {
      const server = requireServer(request);
      // Audited before the row is gone: afterwards there is no name left to record, and a
      // delete that fails mid-way is exactly the one an operator will come looking for.
      await recordAuditFromRequest(request, {
        action: 'server.deleted',
        targetType: 'server',
        targetId: server.id,
        targetName: server.name,
      });
      await deleteServer(server.id, actor(request).id);
      return { id: server.id, deleted: true as const };
    },
  );

  app.post(
    '/:serverId/reinstall',
    {
      preHandler: app.requireServerAccess('server.update'),
      schema: {
        tags: ['servers'],
        summary: 'Re-run the blueprint install over the existing data directory',
        params: serverIdParamSchema,
        response: { 200: serverSchema },
      },
    },
    async (request) => {
      const server = requireServer(request);
      await reinstallServer(server.id, actor(request).id);
      await recordAuditFromRequest(request, {
        action: 'server.reinstalled',
        targetType: 'server',
        targetId: server.id,
        targetName: server.name,
      });
      return loadServerDto(server.id, request.log);
    },
  );

  // -------------------------------------------------------------------------
  // Power
  // -------------------------------------------------------------------------

  /**
   * One route for all four actions rather than four routes, because the legality of an
   * action depends on the *current* status (`ALLOWED_POWER_ACTIONS`), which only the
   * lifecycle can check without a race. The permission, though, is per action — so it is
   * checked here, after the body is parsed, instead of in a preHandler that would have to
   * guess which grant to demand before knowing what was asked for.
   */
  app.post(
    '/:serverId/power',
    {
      preHandler: app.requireServerAccess('server.view'),
      schema: {
        tags: ['servers'],
        summary: 'Start, stop, restart or kill a server',
        params: serverIdParamSchema,
        body: powerRequestSchema,
        response: { 200: serverSchema },
      },
    },
    async (request) => {
      const server = requireServer(request);
      const { action, force } = request.body;
      const user = actor(request);

      // Re-checked against the action's own grant: `server.view` in the preHandler only
      // got us far enough to read the body and learn which action was asked for.
      const granted = await serverPermissionsFor(server, user, request.log);
      const needed = POWER_PERMISSIONS[action];
      if (!granted?.has(needed)) {
        throw forbidden(`You do not have permission to ${action} this server.`);
      }

      await performPowerAction(server.id, action, user.id, { force });
      await recordAuditFromRequest(request, {
        action: 'server.power',
        targetType: 'server',
        targetId: server.id,
        targetName: server.name,
        metadata: { action, force },
      });
      return loadServerDto(server.id, request.log);
    },
  );

  app.get(
    '/:serverId/stats',
    {
      preHandler: app.requireServerAccess('server.view'),
      schema: {
        tags: ['servers'],
        summary: 'Point-in-time resource usage',
        params: serverIdParamSchema,
        response: { 200: serverStatsSchema },
      },
    },
    async (request) => getServerStats(requireServer(request)),
  );

  /**
   * The REST fallback for the console socket, for API keys and any client that cannot hold
   * a websocket open. The reply says the command was accepted, not what the game answered:
   * stdin is one-way, and the output arrives on the console stream like every other line.
   */
  app.post(
    '/:serverId/command',
    {
      preHandler: app.requireServerAccess('console.write'),
      schema: {
        tags: ['servers'],
        summary: 'Send one console command',
        params: serverIdParamSchema,
        body: consoleCommandRequestSchema,
        response: { 202: commandResponseSchema },
      },
    },
    async (request, reply) => {
      const server = requireServer(request);
      assertSendableCommand(server, request.body.command);
      await sendCommand(server.id, request.body.command, actor(request).id);
      await recordAuditFromRequest(request, {
        action: 'server.command',
        targetType: 'server',
        targetId: server.id,
        targetName: server.name,
        metadata: { command: request.body.command },
      });
      return reply.code(202).send({ accepted: true as const });
    },
  );

  // -------------------------------------------------------------------------
  // Subusers
  // -------------------------------------------------------------------------

  app.get(
    '/:serverId/subusers',
    {
      preHandler: app.requireServerAccess('server.update'),
      schema: {
        tags: ['servers'],
        summary: 'List collaborators',
        params: serverIdParamSchema,
        response: { 200: z.array(serverSubuserSchema) },
      },
    },
    async (request) => listSubusers(requireServer(request).id, request.log),
  );

  app.post(
    '/:serverId/subusers',
    {
      preHandler: app.requireServerAccess('server.update'),
      schema: {
        tags: ['servers'],
        summary: 'Invite a collaborator',
        params: serverIdParamSchema,
        body: upsertSubuserRequestSchema,
        response: { 201: serverSubuserSchema },
      },
    },
    async (request, reply) => {
      const server = requireServer(request);
      const subuser = await addSubuser(
        server,
        request.body.email,
        request.body.permissions,
        request.log,
      );
      await recordAuditFromRequest(request, {
        action: 'server.subuser_added',
        targetType: 'server',
        targetId: server.id,
        targetName: server.name,
        metadata: { email: subuser.email, permissions: subuser.permissions },
      });
      return reply.code(201).send(subuser);
    },
  );

  app.patch(
    '/:serverId/subusers/:subuserId',
    {
      preHandler: app.requireServerAccess('server.update'),
      schema: {
        tags: ['servers'],
        summary: "Change a collaborator's permissions",
        params: subuserParamSchema,
        body: upsertSubuserRequestSchema.pick({ permissions: true }),
        response: { 200: serverSubuserSchema },
      },
    },
    async (request) => {
      const server = requireServer(request);
      const subuser = await updateSubuser(
        server.id,
        request.params.subuserId,
        request.body.permissions,
        request.log,
      );
      await recordAuditFromRequest(request, {
        action: 'server.subuser_updated',
        targetType: 'server',
        targetId: server.id,
        targetName: server.name,
        metadata: { email: subuser.email, permissions: subuser.permissions },
      });
      return subuser;
    },
  );

  app.delete(
    '/:serverId/subusers/:subuserId',
    {
      preHandler: app.requireServerAccess('server.update'),
      schema: {
        tags: ['servers'],
        summary: 'Remove a collaborator',
        params: subuserParamSchema,
        response: { 200: deletedResponseSchema },
      },
    },
    async (request) => {
      const server = requireServer(request);
      const removed = await removeSubuser(server.id, request.params.subuserId);
      await recordAuditFromRequest(request, {
        action: 'server.subuser_removed',
        targetType: 'server',
        targetId: server.id,
        targetName: server.name,
        metadata: { email: removed.email },
      });
      return { id: request.params.subuserId, deleted: true as const };
    },
  );
};

export default serverRoutes;
