import { z } from 'zod';
import { NODE_DRIVERS, NODE_STATUSES } from '../domain.js';
import { idSchema, isoDateSchema, portSchema } from './common.js';

/**
 * A node is a host that can run containers. v1 ships with the local Docker socket
 * configured as a node, but the shape is already remote-ready so a second box is a
 * config change rather than a refactor.
 */
export const nodeSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(64),
  description: z.string().max(300).default(''),
  driver: z.enum(NODE_DRIVERS),
  status: z.enum(NODE_STATUSES),
  /** Docker endpoint: a unix socket path or a tcp:// URL. */
  endpoint: z.string(),
  /** Address operators use to reach game servers on this node. */
  publicHost: z.string(),
  /** Inclusive port range Platter may auto-allocate from. */
  portRangeStart: portSchema,
  portRangeEnd: portSchema,
  memoryTotalMb: z.number().int(),
  memoryAllocatedMb: z.number().int(),
  diskTotalMb: z.number().int(),
  diskAllocatedMb: z.number().int(),
  cpuCores: z.number(),
  /** Allocate beyond physical capacity by this factor; 1 means no overcommit. */
  overcommitRatio: z.number().min(1).max(10).default(1),
  serverCount: z.number().int(),
  /** Populated by the health poller; null before the first successful probe. */
  driverVersion: z.string().nullable(),
  lastSeenAt: isoDateSchema.nullable(),
  createdAt: isoDateSchema,
});
export type Node = z.infer<typeof nodeSchema>;

const nodeInputSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(300).default(''),
  driver: z.enum(NODE_DRIVERS).default('docker'),
  endpoint: z.string().min(1).default('/var/run/docker.sock'),
  publicHost: z.string().min(1).default('127.0.0.1'),
  portRangeStart: portSchema.default(25000),
  portRangeEnd: portSchema.default(25999),
  memoryTotalMb: z.number().int().min(512).optional(),
  diskTotalMb: z.number().int().min(1024).optional(),
  cpuCores: z.number().min(0.1).optional(),
  overcommitRatio: z.number().min(1).max(10).default(1),
});

export const createNodeRequestSchema = nodeInputSchema.refine(
  (node) => node.portRangeEnd >= node.portRangeStart,
  { message: 'Port range end must be at or above the start', path: ['portRangeEnd'] },
);
export type CreateNodeRequest = z.infer<typeof createNodeRequestSchema>;

export const updateNodeRequestSchema = nodeInputSchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update');

/** Live capacity snapshot used by the admin dashboard and the placement algorithm. */
export const nodeCapacitySchema = z.object({
  nodeId: idSchema,
  status: z.enum(NODE_STATUSES),
  memoryTotalMb: z.number().int(),
  memoryAllocatedMb: z.number().int(),
  memoryUsedMb: z.number().int(),
  diskTotalMb: z.number().int(),
  diskAllocatedMb: z.number().int(),
  diskUsedMb: z.number().int(),
  cpuCores: z.number(),
  cpuPercent: z.number(),
  portsTotal: z.number().int(),
  portsUsed: z.number().int(),
  containersRunning: z.number().int(),
  sampledAt: isoDateSchema,
});
export type NodeCapacity = z.infer<typeof nodeCapacitySchema>;
