import type { Node as NodeRow, Prisma } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import {
  NODE_DRIVERS,
  NODE_STATUSES,
  formatCount,
  type CreateNodeRequest,
  type Node,
  type NodeCapacity,
  type NodeDriver,
  type NodeStatus,
  type UpdateNodeRequest,
} from '@platter/shared';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { alreadyExists, conflict, notFound, validationFailed } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { DriverHealth } from '../orchestration/driver.js';
import { driverForNode, invalidateDriver } from '../orchestration/registry.js';

/**
 * Node CRUD, capacity accounting and the connectivity probe behind `POST /nodes/:id/test`.
 *
 * A node row and its live capacity are deliberately different shapes: the row (and the
 * `Node` DTO built from it) carries *reserved* memory/disk — the sum of what servers on it
 * have been configured to use, checked at placement time in `services/servers.ts` — while
 * `NodeCapacity` additionally reports what the driver says is actually in use right now.
 * The two can and do disagree (a server can be configured for 2 GB and idle at 200 MB).
 */

/** Applied when a node is created without explicit capacity and the driver cannot be probed. */
const DEFAULT_MEMORY_TOTAL_MB = 2048;
const DEFAULT_DISK_TOTAL_MB = 10_240;
const DEFAULT_CPU_CORES = 1;

function isNodeDriver(value: string): value is NodeDriver {
  return (NODE_DRIVERS as readonly string[]).includes(value);
}

function isNodeStatus(value: string): value is NodeStatus {
  return (NODE_STATUSES as readonly string[]).includes(value);
}

/** Best-effort probe. A node is allowed to exist before its host is reachable. */
async function probeHealth(
  id: string,
  driver: NodeDriver,
  endpoint: string,
  log?: FastifyBaseLogger,
): Promise<DriverHealth> {
  try {
    return await driverForNode({ id, driver, endpoint }).health();
  } catch (error) {
    log?.warn({ err: error, nodeId: id }, 'could not build a driver to probe this node');
    return {
      reachable: false,
      version: null,
      cpuCores: null,
      memoryTotalMb: null,
      containersRunning: null,
      error: error instanceof Error ? error.message : 'Could not reach the node.',
    };
  }
}

function statusFromHealth(health: DriverHealth): NodeStatus {
  if (!health.reachable) return 'offline';
  return health.error === null ? 'online' : 'degraded';
}

// ---------------------------------------------------------------------------
// Row -> wire
// ---------------------------------------------------------------------------

interface NodeUsageTotals {
  serverCount: number;
  memoryAllocatedMb: number;
  diskAllocatedMb: number;
}

const EMPTY_TOTALS: NodeUsageTotals = { serverCount: 0, memoryAllocatedMb: 0, diskAllocatedMb: 0 };

async function usageTotalsFor(nodeIds: readonly string[]): Promise<Map<string, NodeUsageTotals>> {
  if (nodeIds.length === 0) return new Map();
  const rows = await prisma.server.groupBy({
    by: ['nodeId'],
    where: { nodeId: { in: [...nodeIds] } },
    _count: { _all: true },
    _sum: { memoryMb: true, diskMb: true },
  });
  return new Map(
    rows.map((row) => [
      row.nodeId,
      {
        serverCount: row._count._all,
        memoryAllocatedMb: row._sum.memoryMb ?? 0,
        diskAllocatedMb: row._sum.diskMb ?? 0,
      },
    ]),
  );
}

function toNodeDto(row: NodeRow, totals: NodeUsageTotals): Node {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    // An unrecognised driver or status means the row outran this build; both fall back to
    // the most conservative reading rather than crashing the listing.
    driver: isNodeDriver(row.driver) ? row.driver : 'docker',
    status: isNodeStatus(row.status) ? row.status : 'unknown',
    endpoint: row.endpoint,
    publicHost: row.publicHost,
    portRangeStart: row.portRangeStart,
    portRangeEnd: row.portRangeEnd,
    memoryTotalMb: row.memoryTotalMb,
    memoryAllocatedMb: totals.memoryAllocatedMb,
    diskTotalMb: row.diskTotalMb,
    diskAllocatedMb: totals.diskAllocatedMb,
    cpuCores: row.cpuCores,
    overcommitRatio: row.overcommitRatio,
    serverCount: totals.serverCount,
    driverVersion: row.driverVersion,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listNodes(): Promise<Node[]> {
  const rows = await prisma.node.findMany({ orderBy: { createdAt: 'asc' } });
  const totals = await usageTotalsFor(rows.map((row) => row.id));
  return rows.map((row) => toNodeDto(row, totals.get(row.id) ?? EMPTY_TOTALS));
}

export async function getNodeDto(nodeId: string): Promise<Node> {
  const row = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!row) throw notFound('node');
  const totals = await usageTotalsFor([nodeId]);
  return toNodeDto(row, totals.get(nodeId) ?? EMPTY_TOTALS);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export async function createNode(input: CreateNodeRequest, log?: FastifyBaseLogger): Promise<Node> {
  const clash = await prisma.node.findUnique({ where: { name: input.name }, select: { id: true } });
  if (clash) throw alreadyExists('node name');

  // Minted before the row exists so the probe below and the persisted node share one id —
  // the driver cache then already holds the right entry once the row is created.
  const id = newId('nod');
  const health = await probeHealth(id, input.driver, input.endpoint, log);

  const row = await prisma.node.create({
    data: {
      id,
      name: input.name,
      description: input.description,
      driver: input.driver,
      endpoint: input.endpoint,
      publicHost: input.publicHost,
      portRangeStart: input.portRangeStart,
      portRangeEnd: input.portRangeEnd,
      memoryTotalMb: input.memoryTotalMb ?? health.memoryTotalMb ?? DEFAULT_MEMORY_TOTAL_MB,
      diskTotalMb: input.diskTotalMb ?? DEFAULT_DISK_TOTAL_MB,
      cpuCores: input.cpuCores ?? health.cpuCores ?? DEFAULT_CPU_CORES,
      overcommitRatio: input.overcommitRatio,
      status: statusFromHealth(health),
      driverVersion: health.version,
      lastSeenAt: health.reachable ? new Date() : null,
    },
  });

  return toNodeDto(row, EMPTY_TOTALS);
}

/** Refuses a range change that would leave a claimed port outside the new bounds. */
async function assertPortRangeCovers(nodeId: string, start: number, end: number): Promise<void> {
  const outOfRange = await prisma.allocation.count({
    where: { nodeId, serverId: { not: null }, OR: [{ hostPort: { lt: start } }, { hostPort: { gt: end } }] },
  });
  if (outOfRange > 0) {
    throw conflict(
      `${formatCount(outOfRange, 'active port allocation')} would fall outside ${start}–${end}. ` +
        'Free those ports or choose a range that still covers them.',
    );
  }
}

export async function updateNode(
  nodeId: string,
  input: UpdateNodeRequest,
  log?: FastifyBaseLogger,
): Promise<Node> {
  const existing = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!existing) throw notFound('node');

  if (input.name !== undefined && input.name !== existing.name) {
    const clash = await prisma.node.findUnique({ where: { name: input.name }, select: { id: true } });
    if (clash) throw alreadyExists('node name');
  }

  const nextStart = input.portRangeStart ?? existing.portRangeStart;
  const nextEnd = input.portRangeEnd ?? existing.portRangeEnd;
  if (nextEnd < nextStart) {
    throw validationFailed({ portRangeEnd: ['Port range end must be at or above the start.'] });
  }
  if (input.portRangeStart !== undefined || input.portRangeEnd !== undefined) {
    await assertPortRangeCovers(nodeId, nextStart, nextEnd);
  }

  // A changed driver or endpoint points at a different daemon, so the old health reading
  // no longer means anything until the next probe confirms the new one.
  const connectionChanged =
    (input.driver !== undefined && input.driver !== existing.driver) ||
    (input.endpoint !== undefined && input.endpoint !== existing.endpoint);

  const data: Prisma.NodeUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.driver !== undefined) data.driver = input.driver;
  if (input.endpoint !== undefined) data.endpoint = input.endpoint;
  if (input.publicHost !== undefined) data.publicHost = input.publicHost;
  if (input.portRangeStart !== undefined) data.portRangeStart = input.portRangeStart;
  if (input.portRangeEnd !== undefined) data.portRangeEnd = input.portRangeEnd;
  if (input.memoryTotalMb !== undefined) data.memoryTotalMb = input.memoryTotalMb;
  if (input.diskTotalMb !== undefined) data.diskTotalMb = input.diskTotalMb;
  if (input.cpuCores !== undefined) data.cpuCores = input.cpuCores;
  if (input.overcommitRatio !== undefined) data.overcommitRatio = input.overcommitRatio;
  if (connectionChanged) {
    data.status = 'unknown';
    data.driverVersion = null;
  }

  const updated = await prisma.node.update({ where: { id: nodeId }, data });
  if (connectionChanged) invalidateDriver(nodeId);
  log?.debug({ nodeId, connectionChanged }, 'node updated');

  const totals = await usageTotalsFor([nodeId]);
  return toNodeDto(updated, totals.get(nodeId) ?? EMPTY_TOTALS);
}

export async function deleteNode(nodeId: string): Promise<{ name: string }> {
  const existing = await prisma.node.findUnique({ where: { id: nodeId }, select: { id: true, name: true } });
  if (!existing) throw notFound('node');

  const serverCount = await prisma.server.count({ where: { nodeId } });
  if (serverCount > 0) {
    throw conflict(`${formatCount(serverCount, 'server')} still run on this node. Move or delete them first.`);
  }

  // Allocations cascade on the node row (schema.prisma: onDelete: Cascade), so no orphaned
  // port reservations survive the delete.
  await prisma.node.delete({ where: { id: nodeId } });
  invalidateDriver(nodeId);
  return { name: existing.name };
}

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

export async function getNodeCapacity(nodeId: string): Promise<NodeCapacity> {
  const node = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!node) throw notFound('node');

  const [totals, portsUsed, runningServers] = await Promise.all([
    usageTotalsFor([nodeId]).then((map) => map.get(nodeId) ?? EMPTY_TOTALS),
    prisma.allocation.count({ where: { nodeId, serverId: { not: null } } }),
    prisma.server.findMany({ where: { nodeId, status: 'running' }, select: { id: true } }),
  ]);

  const driver = driverForNode(node);
  let containersRunning = runningServers.length;
  let memoryUsedMb = 0;
  let cpuPercent = 0;
  let diskUsedMb = 0;

  try {
    const health = await driver.health();
    if (health.reachable && health.containersRunning !== null) containersRunning = health.containersRunning;
  } catch {
    // Falls back to the row count above — a capacity snapshot should still render for an
    // unreachable node, just without the live half of the numbers.
  }

  // Per-container usage, not a host-wide figure: the driver interface has no single call
  // for "everything this daemon is running", and a self-hosted box rarely has enough
  // containers for one `docker stats` per server to matter.
  const usages = await Promise.all(
    runningServers.map(async (server) => {
      try {
        const [usage, diskBytes] = await Promise.all([
          driver.usage(server.id),
          driver.diskUsage(server.id).catch(() => 0),
        ]);
        return { usage, diskBytes };
      } catch {
        return { usage: null, diskBytes: 0 };
      }
    }),
  );
  for (const { usage, diskBytes } of usages) {
    if (usage) {
      memoryUsedMb += usage.memoryBytes / (1024 * 1024);
      cpuPercent += usage.cpuPercent;
    }
    diskUsedMb += diskBytes / (1024 * 1024);
  }

  return {
    nodeId: node.id,
    status: isNodeStatus(node.status) ? node.status : 'unknown',
    memoryTotalMb: node.memoryTotalMb,
    memoryAllocatedMb: totals.memoryAllocatedMb,
    memoryUsedMb: Math.round(memoryUsedMb),
    diskTotalMb: node.diskTotalMb,
    diskAllocatedMb: totals.diskAllocatedMb,
    diskUsedMb: Math.round(diskUsedMb),
    cpuCores: node.cpuCores,
    cpuPercent,
    portsTotal: node.portRangeEnd - node.portRangeStart + 1,
    portsUsed,
    containersRunning,
    sampledAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Connectivity test
// ---------------------------------------------------------------------------

export interface NodeTestResult {
  reachable: boolean;
  version: string | null;
  cpuCores: number | null;
  memoryTotalMb: number | null;
  containersRunning: number | null;
  error: string | null;
}

/** Manual probe for the "Test connection" button. Also refreshes the row, like a poll tick. */
export async function testNode(nodeId: string, log?: FastifyBaseLogger): Promise<NodeTestResult> {
  const node = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!node) throw notFound('node');

  const health = await probeHealth(node.id, isNodeDriver(node.driver) ? node.driver : 'docker', node.endpoint, log);

  await prisma.node
    .update({
      where: { id: nodeId },
      data: {
        status: statusFromHealth(health),
        driverVersion: health.version,
        ...(health.reachable ? { lastSeenAt: new Date() } : {}),
      },
    })
    .catch((error: unknown) => {
      log?.warn({ err: error, nodeId }, 'could not store the result of a manual node test');
    });

  return {
    reachable: health.reachable,
    version: health.version,
    cpuCores: health.cpuCores,
    memoryTotalMb: health.memoryTotalMb,
    containersRunning: health.containersRunning,
    error: health.error,
  };
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Creates the local node the first time Platter boots with an empty node table, so a fresh
 * install can create a server without a trip to the node admin screen first. A no-op on
 * every later boot, and never overwrites a node an operator has already configured or
 * removed on purpose.
 */
export async function ensureDefaultNode(log?: FastifyBaseLogger): Promise<void> {
  const count = await prisma.node.count();
  if (count > 0) return;

  const id = newId('nod');
  const health = await probeHealth(id, config.defaultNodeDriver, config.dockerSocket, log);

  await prisma.node.create({
    data: {
      id,
      name: 'Local',
      description: 'Auto-provisioned on first boot from the local Docker socket.',
      driver: config.defaultNodeDriver,
      endpoint: config.dockerSocket,
      publicHost: config.publicHost,
      portRangeStart: config.portRangeStart,
      portRangeEnd: config.portRangeEnd,
      memoryTotalMb: health.memoryTotalMb ?? DEFAULT_MEMORY_TOTAL_MB,
      diskTotalMb: DEFAULT_DISK_TOTAL_MB,
      cpuCores: health.cpuCores ?? DEFAULT_CPU_CORES,
      status: statusFromHealth(health),
      driverVersion: health.version,
      lastSeenAt: health.reachable ? new Date() : null,
    },
  });
  log?.info({ nodeId: id, reachable: health.reachable }, 'auto-provisioned the local node');
}
