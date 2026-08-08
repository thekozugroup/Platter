import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createNodeRequestSchema,
  idSchema,
  isoDateSchema,
  nodeCapacitySchema,
  nodeSchema,
  okSchema,
  updateNodeRequestSchema,
} from '@platter/shared';
import { recordAuditFromRequest } from '../services/audit.js';
import {
  createNode,
  deleteNode,
  getNode,
  getNodeCapacity,
  listNodes,
  testNode,
  updateNode,
} from '../services/nodes.js';

/** Node CRUD, capacity and the connection test. Admin-only: nodes are infrastructure, not
 * something a member or an unauthenticated caller ever needs to see or touch. */

const testResultSchema = z.object({
  reachable: z.boolean(),
  driverVersion: z.string().nullable(),
  cpuCores: z.number().nullable(),
  memoryTotalMb: z.number().int().nullable(),
  containersRunning: z.number().int().nullable(),
  error: z.string().nullable(),
  latencyMs: z.number().int(),
  testedAt: isoDateSchema,
});

const nodeRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        tags: ['nodes'],
        summary: 'List nodes',
        description:
          'Not paginated — a self-hosted install typically has one node, rarely more than a handful.',
        response: { 200: z.object({ data: z.array(nodeSchema) }) },
      },
    },
    async () => ({ data: await listNodes() }),
  );

  app.get(
    '/:id',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        tags: ['nodes'],
        summary: 'Get one node',
        params: z.object({ id: idSchema }),
        response: { 200: nodeSchema },
      },
    },
    async (request) => getNode(request.params.id),
  );

  app.get(
    '/:id/capacity',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        tags: ['nodes'],
        summary: 'Live capacity: allocated (from the database) vs. used (from the driver)',
        params: z.object({ id: idSchema }),
        response: { 200: nodeCapacitySchema },
      },
    },
    async (request) => getNodeCapacity(request.params.id),
  );

  app.post(
    '/:id/test',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        tags: ['nodes'],
        summary: 'Probe the node right now',
        description:
          'Always resolves — an unreachable node is `{ reachable: false, error: "..." }`, not a ' +
          "4xx or 5xx. Also refreshes the node's stored status, the same as a background health poll.",
        params: z.object({ id: idSchema }),
        response: { 200: testResultSchema },
      },
    },
    async (request) => {
      const result = await testNode(request.params.id);
      return { ...result, testedAt: new Date().toISOString() };
    },
  );

  app.post(
    '/',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        tags: ['nodes'],
        summary: 'Add a node',
        description:
          'Capacity fields are optional: Platter probes the driver (and, for a local socket, ' +
          'the filesystem) for whatever is omitted, and only asks the operator to supply a ' +
          'number it genuinely could not detect.',
        body: createNodeRequestSchema,
        response: { 201: nodeSchema },
      },
    },
    async (request, reply) => {
      const created = await createNode(request.body);
      await recordAuditFromRequest(request, {
        action: 'node.created',
        targetType: 'node',
        targetId: created.id,
        targetName: created.name,
        metadata: { driver: created.driver, endpoint: created.endpoint },
      });
      return reply.status(201).send(created);
    },
  );

  app.patch(
    '/:id',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        tags: ['nodes'],
        summary: 'Update a node',
        params: z.object({ id: idSchema }),
        body: updateNodeRequestSchema,
        response: { 200: nodeSchema },
      },
    },
    async (request) => {
      const updated = await updateNode(request.params.id, request.body);
      await recordAuditFromRequest(request, {
        action: 'node.updated',
        targetType: 'node',
        targetId: updated.id,
        targetName: updated.name,
        metadata: { fields: Object.keys(request.body) },
      });
      return updated;
    },
  );

  app.delete(
    '/:id',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        tags: ['nodes'],
        summary: 'Remove a node',
        description: 'Refused with `conflict` while any server still lives on it.',
        params: z.object({ id: idSchema }),
        response: { 200: okSchema },
      },
    },
    async (request) => {
      const node = await getNode(request.params.id);
      await deleteNode(request.params.id);
      await recordAuditFromRequest(request, {
        action: 'node.deleted',
        targetType: 'node',
        targetId: node.id,
        targetName: node.name,
      });
      return { ok: true as const };
    },
  );
};

export default nodeRoutes;
