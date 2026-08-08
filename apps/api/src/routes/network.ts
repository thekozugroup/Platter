import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { idSchema, isoDateSchema, portSchema, serverAllocationSchema } from '@platter/shared';
import { recordAuditFromRequest } from '../services/audit.js';
import {
  changeServerPort,
  checkServerReachability,
  getServerAddress,
  getZoneRecords,
  listServerAllocations,
  updateZoneSettings,
} from '../services/network.js';

/**
 * Friendly addressing over HTTP: a server's own address (mounted under it, like files or
 * backups) plus the zone-wide DNS records for a real domain (mounted separately, since a
 * zone spans every server and is infrastructure an operator configures, not a per-server
 * setting — the same reasoning `routes/nodes.ts` gives for being admin-only).
 *
 * Registered with no prefix, like `routes/console.ts`: this file owns both full paths
 * itself so `routes/index.ts` only ever needs the one line.
 */

const serverIdParamSchema = z.object({ serverId: z.string().min(1).max(64) });
const portParamSchema = serverIdParamSchema.extend({ portName: z.string().min(1).max(32) });

const srvInfoSchema = z
  .object({
    service: z.string(),
    protocol: z.enum(['tcp', 'udp']),
    target: z.string(),
    port: portSchema,
  })
  .nullable();

const addressResponseSchema = z.object({
  serverId: idSchema,
  hostname: z.string(),
  zone: z.string(),
  fqdn: z.string(),
  ip: z.string(),
  port: portSchema,
  protocol: z.enum(['tcp', 'udp']),
  mdnsAvailable: z.boolean(),
  srv: srvInfoSchema,
  connectString: z.string(),
  allocations: z.array(serverAllocationSchema),
});

const allocationsResponseSchema = z.object({ data: z.array(serverAllocationSchema) });

const changePortRequestSchema = z.object({ hostPort: portSchema });
const changePortResponseSchema = z.object({
  allocation: serverAllocationSchema,
  requiresRestart: z.boolean(),
});

const reachabilityQuerySchema = z.object({ portName: z.string().min(1).max(32).optional() });
const reachabilityResponseSchema = z.object({
  host: z.string(),
  port: portSchema,
  protocol: z.enum(['tcp', 'udp']),
  listening: z.boolean().nullable(),
  connected: z.boolean(),
  reachability: z.enum(['unreachable', 'lan', 'unknown']),
  detail: z.string(),
  latencyMs: z.number().int(),
  checkedAt: isoDateSchema,
});

const zoneRecordLineSchema = z.object({ name: z.string(), line: z.string() });
const wildcardARecordSchema = zoneRecordLineSchema.extend({ target: z.string(), ttl: z.number().int() });
const zoneSrvRecordSchema = zoneRecordLineSchema.extend({
  service: z.string(),
  protocol: z.enum(['tcp', 'udp']),
  priority: z.number().int(),
  weight: z.number().int(),
  port: portSchema,
  target: z.string(),
  ttl: z.number().int(),
});

const zoneResponseSchema = z.object({
  zone: z.string(),
  publicIp: z.string().nullable(),
  wildcardA: wildcardARecordSchema,
  srvRecords: z.array(zoneSrvRecordSchema),
  zoneFileText: z.string(),
});

const updateZoneRequestSchema = z
  .object({
    zone: z.string().min(1).max(253).optional(),
    publicIp: z.string().min(1).max(64).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update');

// ---------------------------------------------------------------------------
// Per-server address
// ---------------------------------------------------------------------------

const serverNetworkRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/',
    {
      preHandler: app.requireServerAccess('server.view'),
      schema: {
        tags: ['network'],
        summary: "This server's friendly address",
        description:
          'Includes the shortest thing a player can actually type: the bare hostname when ' +
          'an SRV record covers the port, host:port otherwise, and a raw ip:port as the ' +
          'last resort if the hostname cannot be resolved at all right now.',
        params: serverIdParamSchema,
        response: { 200: addressResponseSchema },
      },
    },
    async (request) => getServerAddress(request.params.serverId),
  );

  app.get(
    '/allocations',
    {
      preHandler: app.requireServerAccess('server.view'),
      schema: {
        tags: ['network'],
        summary: "This server's port allocations",
        params: serverIdParamSchema,
        response: { 200: allocationsResponseSchema },
      },
    },
    async (request) => ({ data: await listServerAllocations(request.params.serverId) }),
  );

  app.patch(
    '/allocations/:portName',
    {
      preHandler: app.requireServerAccess('settings.write'),
      schema: {
        tags: ['network'],
        summary: 'Change the host port for one allocation',
        description:
          'Checked against every other allocation on the node and, for a local node, ' +
          "against the OS itself. Takes effect on the server's next start — a container " +
          'already running keeps its current port mapping until then.',
        params: portParamSchema,
        body: changePortRequestSchema,
        response: { 200: changePortResponseSchema },
      },
    },
    async (request) => {
      const result = await changeServerPort(
        request.params.serverId,
        request.params.portName,
        request.body.hostPort,
      );
      await recordAuditFromRequest(request, {
        action: 'server.updated',
        targetType: 'server',
        targetId: request.params.serverId,
        metadata: { portName: request.params.portName, hostPort: request.body.hostPort },
      });
      return result;
    },
  );

  app.get(
    '/reachability',
    {
      preHandler: app.requireServerAccess('server.view'),
      schema: {
        tags: ['network'],
        summary: 'Check whether a port actually answers right now',
        description:
          'Answers honestly rather than optimistically: the strongest result this can ever ' +
          'report is "reachable on the LAN" — confirming the internet can reach a port needs ' +
          'a vantage point outside this network, which Platter does not have.',
        params: serverIdParamSchema,
        querystring: reachabilityQuerySchema,
        response: { 200: reachabilityResponseSchema },
      },
    },
    async (request) => checkServerReachability(request.params.serverId, request.query.portName),
  );
};

// ---------------------------------------------------------------------------
// Zone-wide DNS records
// ---------------------------------------------------------------------------

const zoneRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        tags: ['network'],
        summary: 'DNS records for a real domain',
        description:
          'Only useful once the zone is changed away from the default: `platter.local` ' +
          'resolves on its own over mDNS and needs nothing added to a DNS provider.',
        response: { 200: zoneResponseSchema },
      },
    },
    async () => getZoneRecords(),
  );

  app.put(
    '/',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        tags: ['network'],
        summary: 'Configure the zone (and optionally the public IP the wildcard record points at)',
        body: updateZoneRequestSchema,
        response: { 200: zoneResponseSchema },
      },
    },
    async (request) => {
      await updateZoneSettings(request.body);
      await recordAuditFromRequest(request, {
        action: 'settings.updated',
        targetType: 'system',
        metadata: { ...request.body },
      });
      return getZoneRecords();
    },
  );
};

const networkRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(serverNetworkRoutes, { prefix: '/servers/:serverId/network' });
  await fastify.register(zoneRoutes, { prefix: '/network/zone' });
};

export default networkRoutes;
