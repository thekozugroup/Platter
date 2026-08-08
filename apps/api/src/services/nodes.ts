import { statfs } from 'node:fs/promises';
import type { Node as NodeRow } from '@prisma/client';
import {
  NODE_DRIVERS,
  NODE_STATUSES,
  type CreateNodeRequest,
  type Node,
  type NodeCapacity,
  type NodeDriver,
  type NodeStatus,
} from '@platter/shared';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { alreadyExists, badRequest, conflict, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { DockerDriver, parseDockerEndpoint } from '../orchestration/docker.js';
import type { DriverHealth } from '../orchestration/driver.js';
import { MockDriver, isMockDriver } from '../orchestration/mock.js';
import { getDriverForNode } from '../orchestration/registry.js';
import { listAllocations } from './allocations.js';

/**
 * Node CRUD, capacity, and the driver probe behind "test connection". Nodes are few — a
 * self-hosted install typically has one — so nothing here is paginated, matching how
 * `routes/blueprints.ts` treats its own small, whole-catalogue lists.
 */

const MIB = 1024 * 1024;

function isNodeDriver(value: string): value is NodeDriver {
  return (NODE_DRIVERS as readonly string[]).includes(value);
}

function isNodeStatus(value: string): value is NodeStatus {
  return (NODE_STATUSES as readonly string[]).includes(value);
}

function toNodeDto(
  row: NodeRow,
  serverCount: number,
  memoryAllocatedMb: number,
  diskAllocatedMb: number,
): Node {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    driver: isNodeDriver(row.driver) ? row.driver : 'docker',
    status: isNodeStatus(row.status) ? row.status : 'unknown',
    endpoint: row.endpoint,
    publicHost: row.publicHost,
    portRangeStart: row.portRangeStart,
    portRangeEnd: row.portRangeEnd,
    memoryTotalMb: row.memoryTotalMb,
    memoryAllocatedMb,
    diskTotalMb: row.diskTotalMb,
    diskAllocatedMb,
    cpuCores: row.cpuCores,
    overcommitRatio: row.overcommitRatio,
    serverCount,
    driverVersion: row.driverVersion,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function aggregateServers(
  nodeId: string,
): Promise<{ count: number; memoryMb: number; diskMb: number }> {
  const totals = await prisma.server.aggregate({
    where: { nodeId },
    _count: { _all: true },
    _sum: { memoryMb: true, diskMb: true },
  });
  return {
    count: totals._count._all,
    memoryMb: totals._sum.memoryMb ?? 0,
    diskMb: totals._sum.diskMb ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Host probing — used when a node is created without explicit capacity numbers
// ---------------------------------------------------------------------------

function isLocalEndpoint(endpoint: string): boolean {
  try {
    return parseDockerEndpoint(endpoint).socketPath !== undefined;
  } catch {
    // An endpoint this build cannot parse is not one it can claim is local.
    return false;
  }
}

/** `config.defaultNodeDriver === 'mock'` overrides everything, the same rule `registry.ts`
 * applies once the node has a row — repeated here because this runs *before* one exists. */
function effectiveDriverKind(driver: NodeDriver): 'docker' | 'mock' {
  if (config.defaultNodeDriver === 'mock') return 'mock';
  return driver === 'mock' ? 'mock' : 'docker';
}

/** A one-shot probe against an endpoint that has no row yet, purely to read its capacity. */
async function probeHealth(endpoint: string, driver: NodeDriver): Promise<DriverHealth> {
  const probe =
    effectiveDriverKind(driver) === 'mock'
      ? new MockDriver({ nodeId: 'probe' })
      : new DockerDriver({ nodeId: 'probe', endpoint });
  try {
    return await probe.health();
  } finally {
    if (isMockDriver(probe)) probe.dispose();
  }
}

/** The only disk signal available without a new driver method: the filesystem backing
 * Platter's own data directory, which is where local containers are bind-mounted from. */
async function detectLocalDiskTotalMb(): Promise<number | null> {
  try {
    const stats = await statfs(config.dataDir);
    return Math.round((stats.blocks * stats.bsize) / MIB);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export async function listNodes(): Promise<Node[]> {
  const nodes = await prisma.node.findMany({ orderBy: { createdAt: 'asc' } });
  if (nodes.length === 0) return [];

  const totals = await prisma.server.groupBy({
    by: ['nodeId'],
    _count: { _all: true },
    _sum: { memoryMb: true, diskMb: true },
  });
  const totalsByNode = new Map(totals.map((row) => [row.nodeId, row]));

  return nodes.map((node) => {
    const row = totalsByNode.get(node.id);
    return toNodeDto(node, row?._count._all ?? 0, row?._sum.memoryMb ?? 0, row?._sum.diskMb ?? 0);
  });
}

export async function getNode(id: string): Promise<Node> {
  const node = await prisma.node.findUnique({ where: { id } });
  if (!node) throw notFound('node');
  const totals = await aggregateServers(id);
  return toNodeDto(node, totals.count, totals.memoryMb, totals.diskMb);
}

// ---------------------------------------------------------------------------
// Create / update / delete
// ---------------------------------------------------------------------------

export async function createNode(input: CreateNodeRequest): Promise<Node> {
  if (await prisma.node.findUnique({ where: { name: input.name }, select: { id: true } })) {
    throw alreadyExists('name');
  }

  let memoryTotalMb = input.memoryTotalMb;
  let cpuCores = input.cpuCores;
  if (memoryTotalMb === undefined || cpuCores === undefined) {
    const health = await probeHealth(input.endpoint, input.driver);
    memoryTotalMb ??= health.memoryTotalMb ?? undefined;
    cpuCores ??= health.cpuCores ?? undefined;
  }

  let diskTotalMb = input.diskTotalMb;
  if (diskTotalMb === undefined && isLocalEndpoint(input.endpoint)) {
    diskTotalMb = (await detectLocalDiskTotalMb()) ?? undefined;
  }

  // Narrows all three to `number` below: TypeScript's control-flow analysis sees the throw
  // as unconditional whenever any of them is still `undefined`.
  if (memoryTotalMb === undefined || diskTotalMb === undefined || cpuCores === undefined) {
    const missing = [
      memoryTotalMb === undefined ? 'memoryTotalMb' : null,
      diskTotalMb === undefined ? 'diskTotalMb' : null,
      cpuCores === undefined ? 'cpuCores' : null,
    ].filter((field): field is string => field !== null);

    throw badRequest(
      `Platter could not detect this node's resources automatically. Provide ${missing.join(', ')} explicitly.`,
      Object.fromEntries(missing.map((field) => [field, ['Could not be detected automatically.']])),
    );
  }

  const created = await prisma.node.create({
    data: {
      id: newId('nod'),
      name: input.name,
      description: input.description,
      driver: input.driver,
      endpoint: input.endpoint,
      publicHost: input.publicHost,
      portRangeStart: input.portRangeStart,
      portRangeEnd: input.portRangeEnd,
      memoryTotalMb,
      diskTotalMb,
      cpuCores,
      overcommitRatio: input.overcommitRatio,
      status: 'unknown',
    },
  });

  return toNodeDto(created, 0, 0, 0);
}

export interface UpdateNodeInput {
  name?: string;
  description?: string;
  driver?: NodeDriver;
  endpoint?: string;
  publicHost?: string;
  portRangeStart?: number;
  portRangeEnd?: number;
  memoryTotalMb?: number;
  diskTotalMb?: number;
  cpuCores?: number;
  overcommitRatio?: number;
}

export async function updateNode(id: string, input: UpdateNodeInput): Promise<Node> {
  const node = await prisma.node.findUnique({ where: { id } });
  if (!node) throw notFound('node');

  if (input.name !== undefined && input.name !== node.name) {
    if (await prisma.node.findUnique({ where: { name: input.name }, select: { id: true } })) {
      throw alreadyExists('name');
    }
  }

  const nextStart = input.portRangeStart ?? node.portRangeStart;
  const nextEnd = input.portRangeEnd ?? node.portRangeEnd;
  if (nextEnd < nextStart) {
    throw badRequest('Port range end must be at or above the start.', {
      portRangeEnd: ['Must be at or above the start.'],
    });
  }

  const updated = await prisma.node.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.driver !== undefined ? { driver: input.driver } : {}),
      ...(input.endpoint !== undefined ? { endpoint: input.endpoint } : {}),
      ...(input.publicHost !== undefined ? { publicHost: input.publicHost } : {}),
      ...(input.portRangeStart !== undefined ? { portRangeStart: input.portRangeStart } : {}),
      ...(input.portRangeEnd !== undefined ? { portRangeEnd: input.portRangeEnd } : {}),
      ...(input.memoryTotalMb !== undefined ? { memoryTotalMb: input.memoryTotalMb } : {}),
      ...(input.diskTotalMb !== undefined ? { diskTotalMb: input.diskTotalMb } : {}),
      ...(input.cpuCores !== undefined ? { cpuCores: input.cpuCores } : {}),
      ...(input.overcommitRatio !== undefined ? { overcommitRatio: input.overcommitRatio } : {}),
    },
  });

  const totals = await aggregateServers(id);
  return toNodeDto(updated, totals.count, totals.memoryMb, totals.diskMb);
}

export async function deleteNode(id: string): Promise<void> {
  const node = await prisma.node.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!node) throw notFound('node');

  const serverCount = await prisma.server.count({ where: { nodeId: id } });
  if (serverCount > 0) {
    throw conflict(
      `${node.name} has ${serverCount} ${serverCount === 1 ? 'server' : 'servers'} on it. Move or delete them first.`,
    );
  }

  // Allocations cascade at the database level (`onDelete: Cascade` in schema.prisma); with
  // no servers left on the node, none of them can still carry a `serverId`.
  await prisma.node.delete({ where: { id } });
}

/**
 * First-boot convenience: an operator who has never touched `/nodes` still gets a working
 * server catalogue, because there is already a node pointing at the Docker socket Platter
 * itself was started next to. Detected once, at creation — see `updateNode` for correcting
 * it by hand, and the note on `getNodeCapacity` for why it is not re-detected on a timer.
 */
export async function ensureDefaultNode(): Promise<NodeRow> {
  const existing = await prisma.node.findFirst({ orderBy: { createdAt: 'asc' } });
  if (existing) return existing;

  const health = await probeHealth(config.dockerSocket, config.defaultNodeDriver);
  const diskTotalMb = (await detectLocalDiskTotalMb()) ?? 10_240;

  return prisma.node.create({
    data: {
      id: newId('nod'),
      name: 'Local',
      description: 'The container runtime Platter itself was started next to.',
      driver: config.defaultNodeDriver,
      endpoint: config.dockerSocket,
      publicHost: config.publicHost,
      portRangeStart: config.portRangeStart,
      portRangeEnd: config.portRangeEnd,
      // Conservative placeholders if the daemon could not be reached at boot — an operator
      // can correct them with `PATCH /nodes/:id` once Docker is up.
      memoryTotalMb: health.memoryTotalMb ?? 2048,
      diskTotalMb,
      cpuCores: health.cpuCores ?? 2,
      overcommitRatio: 1,
      status: health.reachable ? 'online' : 'unknown',
      driverVersion: health.version,
      lastSeenAt: health.reachable ? new Date() : null,
    },
  });
}

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

/**
 * Allocated figures come from the database (the sum of what every server on the node has
 * reserved); used figures come from the driver (what is actually running right now). The
 * two answer different questions — "how much has been promised" vs. "how much is spent" —
 * and a node can be fully allocated while using very little, which is exactly the gap an
 * operator deciding whether to add a server needs to see.
 */
export async function getNodeCapacity(nodeId: string): Promise<NodeCapacity> {
  const node = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!node) throw notFound('node');

  const [allocated, allocations] = await Promise.all([
    aggregateServers(nodeId),
    listAllocations(nodeId),
  ]);

  const runningServers = await prisma.server.findMany({
    where: { nodeId, status: 'running' },
    select: { id: true },
  });
  // Disk applies to anything that has ever installed, running or not; a stopped server
  // still occupies its world save.
  const installedServers = await prisma.server.findMany({
    where: { nodeId, status: { notIn: ['provisioning', 'deleting'] } },
    select: { id: true },
  });

  const driver = getDriverForNode(node);
  const [health, usages, diskUsages] = await Promise.all([
    driver.health(),
    Promise.all(
      runningServers.map(async (server) => {
        try {
          return await driver.usage(server.id);
        } catch {
          return null;
        }
      }),
    ),
    Promise.all(
      installedServers.map(async (server) => {
        try {
          return await driver.diskUsage(server.id);
        } catch {
          return 0;
        }
      }),
    ),
  ]);

  const memoryUsedBytes = usages.reduce((sum, usage) => sum + (usage?.memoryBytes ?? 0), 0);
  // Docker's per-container CPU percent is already scaled to "percent of one host core", so
  // summing it across containers and dividing by the node's core count turns it into
  // "percent of this node's total capacity" — the number a capacity gauge needs.
  const cpuPercentSum = usages.reduce((sum, usage) => sum + (usage?.cpuPercent ?? 0), 0);
  const diskUsedBytes = diskUsages.reduce((sum, bytes) => sum + bytes, 0);

  return {
    nodeId: node.id,
    status: isNodeStatus(node.status) ? node.status : 'unknown',
    memoryTotalMb: node.memoryTotalMb,
    memoryAllocatedMb: allocated.memoryMb,
    memoryUsedMb: Math.round(memoryUsedBytes / MIB),
    diskTotalMb: node.diskTotalMb,
    diskAllocatedMb: allocated.diskMb,
    diskUsedMb: Math.round(diskUsedBytes / MIB),
    cpuCores: node.cpuCores,
    cpuPercent: node.cpuCores > 0 ? cpuPercentSum / node.cpuCores : 0,
    portsTotal: Math.max(0, node.portRangeEnd - node.portRangeStart + 1),
    portsUsed: allocations.filter((allocation) => allocation.serverId !== null).length,
    // Host-wide, not Platter-scoped: `DriverHealth.containersRunning` comes straight from
    // the daemon and counts every container on it, including ones Platter did not create.
    containersRunning: health.containersRunning ?? 0,
    sampledAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

export interface NodeTestResult {
  reachable: boolean;
  driverVersion: string | null;
  cpuCores: number | null;
  memoryTotalMb: number | null;
  containersRunning: number | null;
  error: string | null;
  latencyMs: number;
}

/**
 * Probes the node right now, on demand, and — since an operator asking for this wants the
 * dashboard to reflect what they just saw, not wait for the next 30s poll — writes the
 * same status update `orchestration/registry.ts`'s background poller would.
 */
export async function testNode(nodeId: string): Promise<NodeTestResult> {
  const node = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!node) throw notFound('node');

  const driver = getDriverForNode(node);
  const startedAt = Date.now();
  const health = await driver.health();
  const latencyMs = Date.now() - startedAt;

  const status: NodeStatus = !health.reachable
    ? 'offline'
    : health.error === null
      ? 'online'
      : 'degraded';
  await prisma.node.updateMany({
    where: { id: nodeId },
    data: {
      status,
      ...(health.version !== null ? { driverVersion: health.version } : {}),
      ...(health.reachable ? { lastSeenAt: new Date() } : {}),
    },
  });

  return {
    reachable: health.reachable,
    driverVersion: health.version,
    cpuCores: health.cpuCores,
    memoryTotalMb: health.memoryTotalMb,
    containersRunning: health.containersRunning,
    error: health.error,
    latencyMs,
  };
}
