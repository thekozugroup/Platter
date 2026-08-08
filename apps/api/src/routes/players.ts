import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { recordAuditFromRequest } from '../services/audit.js';
import {
  banIp,
  banPlayer,
  getBans,
  getPlayerRoster,
  getServerHealth,
  getWhitelist,
  kickPlayer,
  pardonIp,
  pardonPlayer,
  setOperator,
  setWhitelistEnabled,
  setWhitelisted,
} from '../services/players.js';
import { requireServer } from '../plugins/auth.js';

/**
 * Player administration over HTTP.
 *
 * Two permissions carry this whole surface:
 *
 * - Reads use `server.view`. Who is playing is not privileged information to anyone who
 *   can already see the server.
 * - Every mutation uses `console.write`, because that is literally what it is: each one
 *   sends a console command the holder of that grant could type by hand. Inventing a
 *   narrower permission would be a fiction — `op` is reachable from the console either
 *   way, and a permission that does not actually restrict anything is worse than none.
 *
 * The read endpoints never fail because a server is off. RCON being unavailable is an
 * ordinary state — the server is stopped, the operator turned it off, the image has not
 * generated a password yet — so it comes back as a field on a 200 alongside the history
 * Platter already has, not as an error. Mutations do fail, with the reason and a sentence
 * saying what to do about it.
 */

const serverIdParamSchema = z.object({ serverId: z.string().min(1).max(64) });

/** Deliberately loose: the service is the authority on what a Minecraft name may be, and
 * a malformed name should produce its sentence rather than a schema error. */
const playerParamSchema = serverIdParamSchema.extend({ name: z.string().min(1).max(32) });
const ipParamSchema = serverIdParamSchema.extend({ ip: z.string().min(2).max(45) });

const reasonSchema = z.string().trim().max(200).optional();

const playerRecordSchema = z.object({
  name: z.string(),
  online: z.boolean(),
  playtimeMs: z.number(),
  sessions: z.number().int(),
  firstSeen: z.string().nullable(),
  lastSeen: z.string().nullable(),
  onlineSince: z.string().nullable(),
  op: z.boolean(),
  operatorLevel: z.number().int().nullable(),
  whitelisted: z.boolean(),
  banned: z.boolean(),
  banReason: z.string().nullable(),
});

const rosterResponseSchema = z.object({
  /** `logs` means the live sources were unreachable and this is derived from the console. */
  source: z.enum(['rcon', 'query', 'logs']),
  onlineCount: z.number().int(),
  maxPlayers: z.number().int().nullable(),
  unavailable: z
    .enum([
      'not_supported',
      'not_enabled',
      'no_password',
      'offline',
      'unreachable',
      'timeout',
      'auth_failed',
      'protocol_error',
    ])
    .nullable(),
  unavailableMessage: z.string().nullable(),
  whitelistEnabled: z.boolean().nullable(),
  players: z.array(playerRecordSchema),
});

const commandResponseSchema = z.object({
  ok: z.literal(true),
  /** The server's own reply, so the UI can show what actually happened. */
  output: z.string(),
});

const banEntrySchema = z.object({
  target: z.string(),
  source: z.string().nullable(),
  reason: z.string().nullable(),
});

const whitelistResponseSchema = z.object({
  enabled: z.boolean().nullable(),
  names: z.array(z.string()),
  live: z.boolean(),
});

const bansResponseSchema = z.object({
  players: z.array(banEntrySchema),
  ips: z.array(banEntrySchema),
  live: z.boolean(),
});

const msptWindowSchema = z.object({ average: z.number(), peak: z.number() });

const healthResponseSchema = z.object({
  tps: z
    .object({
      oneMinute: z.number(),
      fiveMinutes: z.number(),
      fifteenMinutes: z.number(),
      estimated: z.boolean(),
    })
    .nullable(),
  mspt: z
    .object({
      fiveSeconds: msptWindowSchema,
      oneMinute: msptWindowSchema,
      fiveMinutes: msptWindowSchema,
    })
    .nullable(),
  unavailable: z.enum(['unsupported', 'unconfigured', 'unreadable', 'offline']).nullable(),
});

/**
 * Every mutation here is a console command, so it is recorded as one. The metadata names
 * the player and the reason, which is what makes an audit entry answer "who banned them".
 */
async function audit(
  request: FastifyRequest,
  command: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const server = requireServer(request);
  await recordAuditFromRequest(request, {
    action: 'server.command',
    targetType: 'server',
    targetId: server.id,
    targetName: server.name,
    metadata: { command, ...metadata },
  });
}

const playerRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/',
    {
      preHandler: app.requireServerAccess('server.view'),
      schema: {
        tags: ['players'],
        summary: 'Who is online now, and everyone this server has ever seen',
        params: serverIdParamSchema,
        response: { 200: rosterResponseSchema },
      },
    },
    async (request) => getPlayerRoster(request.params.serverId),
  );

  app.get(
    '/health',
    {
      preHandler: app.requireServerAccess('server.view'),
      schema: {
        tags: ['players'],
        summary: 'Tick health (TPS and MSPT) where the server reports it',
        params: serverIdParamSchema,
        response: { 200: healthResponseSchema },
      },
    },
    async (request) => getServerHealth(request.params.serverId),
  );

  // -------------------------------------------------------------------------
  // Whitelist
  // -------------------------------------------------------------------------

  app.get(
    '/whitelist',
    {
      preHandler: app.requireServerAccess('server.view'),
      schema: {
        tags: ['players'],
        summary: 'The whitelist, from the running server or from whitelist.json',
        params: serverIdParamSchema,
        response: { 200: whitelistResponseSchema },
      },
    },
    async (request) => getWhitelist(request.params.serverId),
  );

  app.put(
    '/whitelist',
    {
      preHandler: app.requireServerAccess('console.write'),
      schema: {
        tags: ['players'],
        summary: 'Turn the whitelist on or off',
        params: serverIdParamSchema,
        body: z.object({ enabled: z.boolean() }),
        response: { 200: commandResponseSchema },
      },
    },
    async (request) => {
      const { enabled } = request.body;
      const output = await setWhitelistEnabled(request.params.serverId, enabled, {
        logger: request.log,
      });
      await audit(request, enabled ? 'whitelist on' : 'whitelist off', { enabled });
      return { ok: true as const, output };
    },
  );

  app.post(
    '/whitelist',
    {
      preHandler: app.requireServerAccess('console.write'),
      schema: {
        tags: ['players'],
        summary: 'Add a player to the whitelist',
        params: serverIdParamSchema,
        body: z.object({ name: z.string().min(1).max(32) }),
        response: { 200: commandResponseSchema },
      },
    },
    async (request) => {
      const { name } = request.body;
      const output = await setWhitelisted(request.params.serverId, name, true, {
        logger: request.log,
      });
      await audit(request, 'whitelist add', { player: name });
      return { ok: true as const, output };
    },
  );

  app.delete(
    '/whitelist/:name',
    {
      preHandler: app.requireServerAccess('console.write'),
      schema: {
        tags: ['players'],
        summary: 'Remove a player from the whitelist',
        params: playerParamSchema,
        response: { 200: commandResponseSchema },
      },
    },
    async (request) => {
      const { serverId, name } = request.params;
      const output = await setWhitelisted(serverId, name, false, { logger: request.log });
      await audit(request, 'whitelist remove', { player: name });
      return { ok: true as const, output };
    },
  );

  // -------------------------------------------------------------------------
  // Bans
  // -------------------------------------------------------------------------

  app.get(
    '/bans',
    {
      preHandler: app.requireServerAccess('server.view'),
      schema: {
        tags: ['players'],
        summary: 'Banned players and banned addresses',
        params: serverIdParamSchema,
        response: { 200: bansResponseSchema },
      },
    },
    async (request) => getBans(request.params.serverId),
  );

  app.post(
    '/bans/ip',
    {
      preHandler: app.requireServerAccess('console.write'),
      schema: {
        tags: ['players'],
        summary: 'Ban an IP address',
        params: serverIdParamSchema,
        body: z.object({ ip: z.string().min(2).max(45), reason: reasonSchema }),
        response: { 200: commandResponseSchema },
      },
    },
    async (request) => {
      const { ip, reason } = request.body;
      const output = await banIp(request.params.serverId, ip, reason ?? null, {
        logger: request.log,
      });
      await audit(request, 'ban-ip', { ip, reason: reason ?? null });
      return { ok: true as const, output };
    },
  );

  app.delete(
    '/bans/ip/:ip',
    {
      preHandler: app.requireServerAccess('console.write'),
      schema: {
        tags: ['players'],
        summary: 'Lift an IP ban',
        params: ipParamSchema,
        response: { 200: commandResponseSchema },
      },
    },
    async (request) => {
      const { serverId, ip } = request.params;
      const output = await pardonIp(serverId, ip, { logger: request.log });
      await audit(request, 'pardon-ip', { ip });
      return { ok: true as const, output };
    },
  );

  // -------------------------------------------------------------------------
  // One player
  // -------------------------------------------------------------------------

  app.post(
    '/:name/kick',
    {
      preHandler: app.requireServerAccess('console.write'),
      schema: {
        tags: ['players'],
        summary: 'Kick a player',
        params: playerParamSchema,
        body: z.object({ reason: reasonSchema }).default({}),
        response: { 200: commandResponseSchema },
      },
    },
    async (request) => {
      const { serverId, name } = request.params;
      const reason = request.body?.reason ?? null;
      const output = await kickPlayer(serverId, name, reason, { logger: request.log });
      await audit(request, 'kick', { player: name, reason });
      return { ok: true as const, output };
    },
  );

  app.post(
    '/:name/ban',
    {
      preHandler: app.requireServerAccess('console.write'),
      schema: {
        tags: ['players'],
        summary: 'Ban a player',
        params: playerParamSchema,
        body: z.object({ reason: reasonSchema }).default({}),
        response: { 200: commandResponseSchema },
      },
    },
    async (request) => {
      const { serverId, name } = request.params;
      const reason = request.body?.reason ?? null;
      const output = await banPlayer(serverId, name, reason, { logger: request.log });
      await audit(request, 'ban', { player: name, reason });
      return { ok: true as const, output };
    },
  );

  app.post(
    '/:name/pardon',
    {
      preHandler: app.requireServerAccess('console.write'),
      schema: {
        tags: ['players'],
        summary: 'Lift a player ban',
        params: playerParamSchema,
        response: { 200: commandResponseSchema },
      },
    },
    async (request) => {
      const { serverId, name } = request.params;
      const output = await pardonPlayer(serverId, name, { logger: request.log });
      await audit(request, 'pardon', { player: name });
      return { ok: true as const, output };
    },
  );

  app.put(
    '/:name/op',
    {
      preHandler: app.requireServerAccess('console.write'),
      schema: {
        tags: ['players'],
        summary: 'Grant or revoke operator status',
        params: playerParamSchema,
        body: z.object({ op: z.boolean() }),
        response: { 200: commandResponseSchema },
      },
    },
    async (request) => {
      const { serverId, name } = request.params;
      const { op } = request.body;
      const output = await setOperator(serverId, name, op, { logger: request.log });
      await audit(request, op ? 'op' : 'deop', { player: name });
      return { ok: true as const, output };
    },
  );
};

export default playerRoutes;
