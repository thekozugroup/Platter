import type { FastifyBaseLogger, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  POWER_ACTION_TARGET_STATUS,
  SERVER_PERMISSIONS,
  SERVER_STATUSES,
  canPerformPowerAction,
  consoleCommandRequestSchema,
  createServerRequestSchema,
  idSchema,
  listServersQuerySchema,
  okSchema,
  paginatedSchema,
  powerRequestSchema,
  roleAtLeast,
  serverSchema,
  serverStatsSchema,
  serverSubuserSchema,
  serverSummarySchema,
  updateServerRequestSchema,
  upsertSubuserRequestSchema,
  type PowerAction,
  type ServerPermission,
} from '@platter/shared';
import { forbidden, invalidState, notFound, unauthenticated } from '../lib/errors.js';
import { requireServer, type AuthContext, type ServerRecord } from '../plugins/auth.js';
import { recordAuditFromRequest } from '../services/audit.js';
import {
  addSubuser,
  createServer,
  getServerStats,
  listServers,
  listSubusers,
  loadServerDto,
  presentStatus,
  removeSubuser,
  serverPermissionsFor,
  updateServer,
  updateSubuser,
} from '../services/servers.js';
import {
  deleteServer,
  performPowerAction,
  reinstallServer,
  sendCommand,
} from '../services/lifecycle.js';

const serverParamsSchema = z.object({ serverId: idSchema });
const subuserParamsSchema = z.object({ serverId: idSchema, subuserId: idSchema });

/**
 * Power and reinstall are accepted, not completed: draining a world or pulling an image
 * takes longer than any sensible HTTP timeout. The body carries the status the server is
 * transitioning *to*, which is what the UI shows while it waits for the console socket to
 * report the real one.
 */
const acceptedStatusSchema = z.object({ status: z.enum(SERVER_STATUSES) });

/** The email on an existing grant cannot change, so only the permissions are settable. */
const updateSubuserRequestSchema = z.object({
  permissions: z.array(z.enum(SERVER_PERMISSIONS)).min(1),
});

/** `kill` is a harder stop rather than a separate capability, so it shares the permission. */
const POWER_PERMISSION: Record<PowerAction, ServerPermission> = {
  start: 'power.start',
  stop: 'power.stop',
  restart: 'power.restart',
  kill: 'power.stop',
};

function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthenticated();
  return request.auth;
}

/**
 * The per-action check that `requireServerAccess` cannot make.
 *
 * A route's preHandler is fixed at registration time, but which permission a power
 * request needs depends on its body. The preHandler still runs — it proves the principal
 * can see the server at all — and this narrows it to the specific action.
 */
async function assertPermission(
  request: FastifyRequest,
  server: ServerRecord,
  permission: ServerPermission,
): Promise<void> {
  const { user } = requireAuth(request);
  const permissions = await serverPermissionsFor(server, user, request.log);
  // Null means the relationship vanished between the preHandler and here — answered as a
  // 404 for the same reason the preHandler would have.
  if (!permissions) throw notFound('server');
  if (!permissions.has(permission)) {
    throw forbidden('You do not have permission to do that on this server.');
  }
}

/**
 * Managing collaborators is an owner's decision, not a delegable one. Without this a
 * subuser holding `settings.write` could grant themselves every other permission, which
 * turns one over-generous invite into full control of the server.
 */
function assertServerOwner(request: FastifyRequest, server: ServerRecord): void {
  const { user } = requireAuth(request);
  if (roleAtLeast(user.role, 'admin') || server.ownerId === user.id) return;
  throw forbidden('Only the server owner can manage who has access.');
}

/**
 * Starts asynchronous work and guarantees its rejection is handled. The lifecycle service
 * records failures on the server's status; all that is left here is to make sure a
 * rejected promise never escapes as an unhandled one.
 */
function detach(
  run: () => Promise<unknown>,
  log: FastifyBaseLogger,
  message: string,
  context: Record<string, unknown>,
): void {
  void Promise.resolve()
    .then(run)
    .catch((error: unknown) => {
      log.error({ err: error, ...context }, message);
    });
}

const serverRoutes: FastifyPluginAsync = async (fastify) => {
  // The typed handle exists only so route schemas infer; decorators stay on `fastify`,
  // which is the instance they were declared against.
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // -------------------------------------------------------------------------
  // Collection
  // -------------------------------------------------------------------------

  app.get(
    '/',
    {
      preHandler: fastify.authenticate,
      schema: {
        tags: ['servers'],
        summary: 'List servers visible to the caller',
        querystring: listServersQuerySchema,
        response: { 200: paginatedSchema(serverSummarySchema) },
      },
    },
    async (request) => {
      const { user } = requireAuth(request);
      return listServers(request.query, user);
    },
  );

  app.post(
    '/',
    {
      preHandler: fastify.authenticate,
      schema: {
        tags: ['servers'],
        summary: 'Create a server from a blueprint',
        body: createServerRequestSchema,
        response: { 201: serverSchema },
      },
    },
    async (request, reply) => {
      const { user } = requireAuth(request);
      const server = await createServer(request.body, user, request.log);

      await recordAuditFromRequest(request, {
        action: 'server.created',
        targetType: 'server',
        targetId: server.id,
        targetName: server.name,
        metadata: {
          blueprintKey: server.blueprintKey,
          nodeId: server.nodeId,
          memoryMb: server.limits.memoryMb,
        },
      });

      return reply.status(201).send(server);
    },
  );

  // -------------------------------------------------------------------------
  // One server
  // -------------------------------------------------------------------------

  app.get(
    '/:serverId',
    {
      preHandler: fastify.requireServerAccess('server.view'),
      schema: {
        tags: ['servers'],
        summary: 'Fetch one server',
        params: serverParamsSchema,
        response: { 200: serverSchema },
      },
    },
    async (request) => loadServerDto(requireServer(request).id, request.log),
  );

  app.patch(
    '/:serverId',
    {
      preHandler: fastify.requireServerAccess('server.update'),
      schema: {
        tags: ['servers'],
        summary: 'Update a server',
        params: serverParamsSchema,
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
        // The keys, never the values: a variable can hold an RCON password.
        metadata: { fields: Object.keys(request.body) },
      });

      return updated;
    },
  );

  app.delete(
    '/:serverId',
    {
      preHandler: fastify.requireServerAccess('server.delete'),
      schema: {
        tags: ['servers'],
        summary: 'Delete a server, its container and its volume',
        params: serverParamsSchema,
        response: { 200: okSchema },
      },
    },
    async (request) => {
      const server = requireServer(request);
      const { user } = requireAuth(request);
      // Awaited rather than accepted: the client's next action is almost always to look at
      // a list that must no longer contain this server. The lifecycle service removes the
      // container before the row, writes the audit entry, and refuses if the node is
      // unreachable — so a 200 here really does mean the server is gone.
      await deleteServer(server.id, user.id);
      return { ok: true } as const;
    },
  );

  // -------------------------------------------------------------------------
  // Runtime
  // -------------------------------------------------------------------------

  app.post(
    '/:serverId/power',
    {
      // The specific permission depends on the action, which is only known once the body
      // has been validated; `server.view` is the gate that proves access to the server.
      preHandler: fastify.requireServerAccess('server.view'),
      schema: {
        tags: ['servers'],
        summary: 'Start, stop, restart or kill a server',
        params: serverParamsSchema,
        body: powerRequestSchema,
        response: { 202: acceptedStatusSchema },
      },
    },
    async (request, reply) => {
      const server = requireServer(request);
      const { action, force } = request.body;
      await assertPermission(request, server, POWER_PERMISSION[action]);

      const status = presentStatus(server);
      if (!canPerformPowerAction(status, action)) {
        throw invalidState(`${server.name} is ${status}, so it cannot be told to ${action}.`);
      }

      const { user } = requireAuth(request);
      // The lifecycle service writes both the transition and its `server.power` audit
      // entry; a second entry from here would double-count every start in the feed.
      detach(
        () => performPowerAction(server.id, action, user.id, { force }),
        request.log,
        'power action failed',
        { serverId: server.id, action },
      );

      return reply.status(202).send({ status: POWER_ACTION_TARGET_STATUS[action] });
    },
  );

  app.post(
    '/:serverId/command',
    {
      preHandler: fastify.requireServerAccess('console.write'),
      schema: {
        tags: ['servers'],
        summary: 'Send one line to the server console',
        params: serverParamsSchema,
        body: consoleCommandRequestSchema,
        response: { 202: okSchema },
      },
    },
    async (request, reply) => {
      const server = requireServer(request);
      const { user } = requireAuth(request);
      // Awaited: writing to stdin is a local operation, and the caller wants to know it
      // landed. The lifecycle service enforces the status rule, collapses the line and
      // writes the `server.command` audit entry.
      await sendCommand(server.id, request.body.command, user.id);
      return reply.status(202).send({ ok: true } as const);
    },
  );

  app.post(
    '/:serverId/reinstall',
    {
      preHandler: fastify.requireServerAccess('server.update'),
      schema: {
        tags: ['servers'],
        summary: 'Re-run the blueprint install over the existing volume',
        params: serverParamsSchema,
        response: { 202: acceptedStatusSchema },
      },
    },
    async (request, reply) => {
      const server = requireServer(request);
      const { user } = requireAuth(request);
      const status = presentStatus(server);
      // Checked here as well as inside the lifecycle service: rejecting up front is a 409
      // the caller can act on, where the same refusal inside the detached call would only
      // reach a log. The two lists agree deliberately.
      if (status === 'provisioning' || status === 'installing' || status === 'deleting') {
        throw invalidState(`${server.name} is ${status}; wait for that to finish first.`);
      }
      if (status === 'suspended') throw invalidState(`${server.name} is suspended.`);

      // The install pulls an image and lays out a volume, so it is accepted rather than
      // completed. The lifecycle service writes the `server.reinstalled` audit entry.
      detach(() => reinstallServer(server.id, user.id), request.log, 'reinstall failed', {
        serverId: server.id,
      });

      return reply.status(202).send({ status: 'installing' } as const);
    },
  );

  app.get(
    '/:serverId/stats',
    {
      preHandler: fastify.requireServerAccess('server.view'),
      schema: {
        tags: ['servers'],
        summary: 'Point-in-time resource usage',
        params: serverParamsSchema,
        response: { 200: serverStatsSchema },
      },
    },
    async (request) => getServerStats(requireServer(request)),
  );

  // -------------------------------------------------------------------------
  // Collaborators
  // -------------------------------------------------------------------------

  app.get(
    '/:serverId/subusers',
    {
      preHandler: fastify.requireServerAccess('settings.read'),
      schema: {
        tags: ['servers'],
        summary: 'List the accounts with access to this server',
        params: serverParamsSchema,
        response: { 200: z.array(serverSubuserSchema) },
      },
    },
    async (request) => {
      const server = requireServer(request);
      assertServerOwner(request, server);
      return listSubusers(server.id, request.log);
    },
  );

  app.post(
    '/:serverId/subusers',
    {
      preHandler: fastify.requireServerAccess('settings.write'),
      schema: {
        tags: ['servers'],
        summary: 'Give an existing account access to this server',
        params: serverParamsSchema,
        body: upsertSubuserRequestSchema,
        response: { 201: serverSubuserSchema },
      },
    },
    async (request, reply) => {
      const server = requireServer(request);
      assertServerOwner(request, server);

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
        metadata: { userId: subuser.userId, permissions: subuser.permissions },
      });

      return reply.status(201).send(subuser);
    },
  );

  app.patch(
    '/:serverId/subusers/:subuserId',
    {
      preHandler: fastify.requireServerAccess('settings.write'),
      schema: {
        tags: ['servers'],
        summary: "Change a collaborator's permissions",
        params: subuserParamsSchema,
        body: updateSubuserRequestSchema,
        response: { 200: serverSubuserSchema },
      },
    },
    async (request) => {
      const server = requireServer(request);
      assertServerOwner(request, server);

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
        metadata: { userId: subuser.userId, permissions: subuser.permissions },
      });

      return subuser;
    },
  );

  app.delete(
    '/:serverId/subusers/:subuserId',
    {
      preHandler: fastify.requireServerAccess('settings.write'),
      schema: {
        tags: ['servers'],
        summary: 'Remove a collaborator',
        params: subuserParamsSchema,
        response: { 200: okSchema },
      },
    },
    async (request) => {
      const server = requireServer(request);
      assertServerOwner(request, server);

      const removed = await removeSubuser(server.id, request.params.subuserId);

      await recordAuditFromRequest(request, {
        action: 'server.subuser_removed',
        targetType: 'server',
        targetId: server.id,
        targetName: server.name,
        metadata: { userId: removed.userId, email: removed.email },
      });

      return { ok: true } as const;
    },
  );
};

export default serverRoutes;
