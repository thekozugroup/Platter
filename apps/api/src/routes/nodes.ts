import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createNodeRequestSchema,
  idSchema,
  nodeCapacitySchema,
  nodeSchema,
  okSchema,
  updateNodeRequestSchema,
} from '@platter/shared';
import { recordAuditFromRequest } from '../services/audit.js';
import {
  createNode,
  deleteNode,
  getNodeCapacity,
  getNodeDto,
  listNodes,
  testNode,
  updateNode,
} from '../services/nodes.js';

const nodeParamsSchema = z.object({ nodeId: idSchema });

/** Renderable even when the node could not be reached at all. */
const nodeTestResultSchema = z.object({
  reachable: z.boolean(),
  version: z.string().nullable(),
  cpuCores: z.number().nullable(),
  memoryTotalMb: z.number().int().nullable(),
  containersRunning: z.number().int().nullable(),
  error: z.string().nullable(),
});

/**
 * Node admin: CRUD over the hosts Platter can place servers on, plus the two read-only
 * endpoints the admin dashboard needs — a live capacity snapshot and a connectivity probe.
 * Every route is admin-only; there is no per-server-style delegation for infrastructure.
 */
const nodeRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/',
    {
      preHandler: fastify.requireRole('admin'),
      schema: {
        tags: ['nodes'],
        summary: 'List nodes',
        response: { 200: z.array(nodeSchema) },
      },
    },
    async () => listNodes(),
  );

  app.post(
    '/',
    {
      preHandler: fastify.requireRole('admin'),
      schema: {
        tags: ['nodes'],
        summary: 'Add a node',
        description:
          'Capacity left unset is probed from the driver where possible, falling back to ' +
          'a conservative default; the node is created either way, reachable or not.',
        body: createNodeRequestSchema,
        response: { 201: nodeSchema },
      },
    },
    async (request, reply) => {
      const node = await createNode(request.body, request.log);

      await recordAuditFromRequest(request, {
        action: 'node.created',
        targetType: 'node',
        targetId: node.id,
        targetName: node.name,
        metadata: { driver: node.driver, endpoint: node.endpoint },
      });

      return reply.status(201).send(node);
    },
  );

  app.get(
    '/:nodeId',
    {
      preHandler: fastify.requireRole('admin'),
      schema: {
        tags: ['nodes'],
        summary: 'Fetch one node',
        params: nodeParamsSchema,
        response: { 200: nodeSchema },
      },
    },
    async (request) => getNodeDto(request.params.nodeId),
  );

  app.patch(
    '/:nodeId',
    {
      preHandler: fastify.requireRole('admin'),
      schema: {
        tags: ['nodes'],
        summary: 'Update a node',
        description:
          'Narrowing the port range is refused if a server still holds a port outside the ' +
          'new bounds. Changing the driver or endpoint resets the health status to `unknown` ' +
          'until the next probe.',
        params: nodeParamsSchema,
        body: updateNodeRequestSchema,
        response: { 200: nodeSchema },
      },
    },
    async (request) => {
      const node = await updateNode(request.params.nodeId, request.body, request.log);

      await recordAuditFromRequest(request, {
        action: 'node.updated',
        targetType: 'node',
        targetId: node.id,
        targetName: node.name,
        metadata: { fields: Object.keys(request.body) },
      });

      return node;
    },
  );

  app.delete(
    '/:nodeId',
    {
      preHandler: fastify.requireRole('admin'),
      schema: {
        tags: ['nodes'],
        summary: 'Remove a node',
        description: 'Refused while any server is placed on it.',
        params: nodeParamsSchema,
        response: { 200: okSchema },
      },
    },
    async (request) => {
      const { name } = await deleteNode(request.params.nodeId);

      await recordAuditFromRequest(request, {
        action: 'node.deleted',
        targetType: 'node',
        targetId: request.params.nodeId,
        targetName: name,
      });

      return { ok: true as const };
    },
  );

  app.get(
    '/:nodeId/capacity',
    {
      preHandler: fastify.requireRole('admin'),
      schema: {
        tags: ['nodes'],
        summary: 'Live capacity snapshot',
        params: nodeParamsSchema,
        response: { 200: nodeCapacitySchema },
      },
    },
    async (request) => getNodeCapacity(request.params.nodeId),
  );

  app.post(
    '/:nodeId/test',
    {
      preHandler: fastify.requireRole('admin'),
      schema: {
        tags: ['nodes'],
        summary: 'Probe the node driver',
        description: 'Also refreshes the stored health status and version, like a manual poll tick.',
        params: nodeParamsSchema,
        response: { 200: nodeTestResultSchema },
      },
    },
    async (request) => testNode(request.params.nodeId, request.log),
  );
};

export default nodeRoutes;
