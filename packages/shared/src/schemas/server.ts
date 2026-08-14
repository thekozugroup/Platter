import { z } from 'zod';
import { LIMITS, POWER_ACTIONS, SERVER_PERMISSIONS, SERVER_STATUSES } from '../domain.js';
import { idSchema, isoDateSchema, patchShape, portSchema } from './common.js';

export const serverNameSchema = z
  .string()
  .trim()
  .min(LIMITS.serverNameMin, 'Give your server a name')
  .max(LIMITS.serverNameMax);

export const resourceLimitsSchema = z.object({
  memoryMb: z.number().int().min(LIMITS.minMemoryMb).max(LIMITS.maxMemoryMb),
  diskMb: z.number().int().min(LIMITS.minDiskMb).max(LIMITS.maxDiskMb),
  /** Whole cores as a float. 0 means unlimited. */
  cpuCores: z.number().min(LIMITS.minCpuCores).max(LIMITS.maxCpuCores),
  /** Swap in MB; 0 disables swap, -1 leaves it unbounded. */
  swapMb: z.number().int().min(-1).default(0),
  /** Block IO weight (10–1000), Docker's relative disk priority. */
  ioWeight: z.number().int().min(10).max(1000).default(500),
});
export type ResourceLimits = z.infer<typeof resourceLimitsSchema>;

export const serverAllocationSchema = z.object({
  name: z.string(),
  hostIp: z.string(),
  hostPort: portSchema,
  containerPort: portSchema,
  protocol: z.enum(['tcp', 'udp']),
  primary: z.boolean(),
});
export type ServerAllocation = z.infer<typeof serverAllocationSchema>;

export const serverSchema = z.object({
  id: idSchema,
  name: serverNameSchema,
  description: z.string().max(500).default(''),
  blueprintKey: z.string(),
  nodeId: idSchema,
  ownerId: idSchema,
  status: z.enum(SERVER_STATUSES),
  /** Present once the container exists; null while provisioning or after a hard reset. */
  containerId: z.string().nullable(),
  limits: resourceLimitsSchema,
  allocations: z.array(serverAllocationSchema),
  /**
   * The address a player types. Built from the server's hostname where that resolves, and
   * never from an allocation's `hostIp` — that is a bind address (`0.0.0.0`), which is not
   * a thing anyone can connect to.
   */
  connectString: z.string().nullable(),
  variables: z.record(z.string(), z.string()),
  /** Keys whose value came back as `[redacted]`. Password-typed variables are never sent. */
  redactedVariables: z.array(z.string()),
  autoStart: z.boolean(),
  /** Restart automatically after an unexpected exit, up to a backoff cap. */
  autoRestart: z.boolean(),
  /** Populated when the last exit was unexpected — drives the crash banner and AI triage. */
  lastExitCode: z.number().int().nullable(),
  lastCrashAt: isoDateSchema.nullable(),
  installedAt: isoDateSchema.nullable(),
  startedAt: isoDateSchema.nullable(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type Server = z.infer<typeof serverSchema>;

/** What the dashboard grid needs — cheap to compute, safe to poll. */
export const serverSummarySchema = z.object({
  id: idSchema,
  name: z.string(),
  blueprintKey: z.string(),
  status: z.enum(SERVER_STATUSES),
  nodeId: idSchema,
  /** The address a player types — same rule as `serverSchema.connectString`. */
  primaryAddress: z.string().nullable(),
  memoryMb: z.number().int(),
  cpuCores: z.number(),
  playersOnline: z.number().int().nullable(),
  playersMax: z.number().int().nullable(),
  updatedAt: isoDateSchema,
});
export type ServerSummary = z.infer<typeof serverSummarySchema>;

export const createServerRequestSchema = z.object({
  name: serverNameSchema,
  description: z.string().max(500).default(''),
  blueprintKey: z.string().min(1),
  nodeId: idSchema.optional(),
  limits: resourceLimitsSchema.partial().optional(),
  variables: z.record(z.string(), z.string()).default({}),
  /** Explicit host ports; omitted entries are auto-allocated from the node's pool. */
  ports: z.record(z.string(), portSchema).default({}),
  autoStart: z.boolean().default(true),
  autoRestart: z.boolean().default(true),
  /** Start installing immediately instead of leaving the server in `provisioning`. */
  startOnCreate: z.boolean().default(true),
});
export type CreateServerRequest = z.infer<typeof createServerRequestSchema>;

export const updateServerRequestSchema = z
  .object({
    name: serverNameSchema.optional(),
    description: z.string().max(500).optional(),
    /**
     * `patchShape`, not `.partial()`: editing only `memoryMb` must not silently reset
     * `swapMb` and `ioWeight` to their create-time defaults.
     */
    limits: z.object(patchShape(resourceLimitsSchema)).optional(),
    variables: z.record(z.string(), z.string()).optional(),
    autoStart: z.boolean().optional(),
    autoRestart: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update');
export type UpdateServerRequest = z.infer<typeof updateServerRequestSchema>;

export const powerRequestSchema = z.object({
  action: z.enum(POWER_ACTIONS),
  /** Skip the graceful stop command and go straight to the signal. */
  force: z.boolean().default(false),
});
export type PowerRequest = z.infer<typeof powerRequestSchema>;

export const consoleCommandRequestSchema = z.object({
  command: z.string().min(1).max(LIMITS.maxConsoleLineLength),
});

/** Point-in-time resource usage, streamed over the console socket and polled by the grid. */
export const serverStatsSchema = z.object({
  serverId: idSchema,
  status: z.enum(SERVER_STATUSES),
  cpuPercent: z.number(),
  memoryBytes: z.number(),
  memoryLimitBytes: z.number(),
  diskBytes: z.number(),
  networkRxBytes: z.number(),
  networkTxBytes: z.number(),
  uptimeSeconds: z.number().int(),
  playersOnline: z.number().int().nullable(),
  playersMax: z.number().int().nullable(),
  sampledAt: isoDateSchema,
});
export type ServerStats = z.infer<typeof serverStatsSchema>;

export const listServersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().max(120).optional(),
  status: z.enum(SERVER_STATUSES).optional(),
  blueprintKey: z.string().optional(),
  nodeId: idSchema.optional(),
  sort: z.enum(['name', 'createdAt', 'status']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type ListServersQuery = z.infer<typeof listServersQuerySchema>;

// ---------------------------------------------------------------------------
// Subusers
// ---------------------------------------------------------------------------

export const serverSubuserSchema = z.object({
  id: idSchema,
  userId: idSchema,
  email: z.string(),
  username: z.string(),
  displayName: z.string(),
  avatarColor: z.string(),
  permissions: z.array(z.enum(SERVER_PERMISSIONS)),
  createdAt: isoDateSchema,
});
export type ServerSubuser = z.infer<typeof serverSubuserSchema>;

export const upsertSubuserRequestSchema = z.object({
  email: z.string().email(),
  permissions: z.array(z.enum(SERVER_PERMISSIONS)).min(1),
});
