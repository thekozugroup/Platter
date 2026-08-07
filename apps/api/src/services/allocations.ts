import type { Allocation } from '@prisma/client';
import { LIMITS, PlatterError } from '@platter/shared';
import type { BlueprintPort } from '@platter/shared';
import { prisma } from '../db.js';
import { badRequest, isPrismaKnownError, notFound, toPlatterError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { PortBinding } from '../orchestration/driver.js';

/**
 * Host port allocation.
 *
 * Two servers provisioning at the same instant will race for the same free port, and no
 * amount of "find a gap, then insert it" makes that safe — between the read and the write
 * the other transaction has already taken it. So the unique index on
 * `(nodeId, hostIp, hostPort, protocol)` is the arbiter: reserving a port is an INSERT,
 * taking ownership of one is an UPDATE that only matches while `serverId` is still null,
 * and losing either means trying the next candidate. The scan below decides what to
 * *try*; it is never trusted to decide what is free.
 *
 * Allocation is two-phase because a server row has to exist before anything can point at
 * it: `allocatePorts` reserves detached rows and hands back their ids, and
 * `claimAllocations` binds them to the server once it has been created.
 */

/** Bind on every interface: the node's `publicHost` is what players are handed. */
const DEFAULT_HOST_IP = '0.0.0.0';
/** Enough attempts that consecutive losses mean a full range rather than bad luck. */
const MAX_CLAIM_ATTEMPTS = 64;

export type Protocol = 'tcp' | 'udp';

export interface AllocationRecord {
  id: string;
  nodeId: string;
  hostIp: string;
  hostPort: number;
  protocol: Protocol;
  serverId: string | null;
  portName: string | null;
  primary: boolean;
}

function toProtocol(value: string): Protocol {
  return value === 'udp' ? 'udp' : 'tcp';
}

function toRecord(row: Allocation): AllocationRecord {
  return {
    id: row.id,
    nodeId: row.nodeId,
    hostIp: row.hostIp,
    hostPort: row.hostPort,
    protocol: toProtocol(row.protocol),
    serverId: row.serverId,
    portName: row.portName,
    primary: row.primary,
  };
}

/**
 * Reserves one exact port, or answers null if someone else holds it.
 *
 * The INSERT is the fast path. A unique violation means the row exists, which is not the
 * same as it being taken — a detached allocation left behind by a deleted server is free —
 * so the fallback relabels that row for the role we need, conditional on it still being
 * unowned.
 */
async function reserve(
  nodeId: string,
  hostPort: number,
  port: BlueprintPort,
): Promise<AllocationRecord | null> {
  const protocol = port.protocol;
  try {
    const created = await prisma.allocation.create({
      data: {
        id: newId('alc'),
        nodeId,
        hostIp: DEFAULT_HOST_IP,
        hostPort,
        protocol,
        serverId: null,
        portName: port.name,
        primary: port.primary,
      },
    });
    return toRecord(created);
  } catch (error) {
    if (!isPrismaKnownError(error) || error.code !== 'P2002') throw toPlatterError(error);
  }

  const existing = await prisma.allocation.findUnique({
    where: {
      nodeId_hostIp_hostPort_protocol: { nodeId, hostIp: DEFAULT_HOST_IP, hostPort, protocol },
    },
  });
  if (!existing || existing.serverId !== null) return null;

  const relabelled = await prisma.allocation.updateMany({
    where: { id: existing.id, serverId: null },
    data: { portName: port.name, primary: port.primary },
  });
  if (relabelled.count === 0) return null;
  return { ...toRecord(existing), portName: port.name, primary: port.primary };
}

/**
 * Candidate host ports, best first: the container's own port (so the address a player
 * types matches the one in the blueprint's docs), then ports already in the table but
 * unowned, then everything else from a random offset — starting at the low end would make
 * every concurrent provision collide on the same first port.
 */
function candidatePorts(
  containerPort: number,
  rangeStart: number,
  rangeEnd: number,
  reusable: readonly number[],
  blocked: ReadonlySet<number>,
): number[] {
  const size = rangeEnd - rangeStart + 1;
  const ordered: number[] = [];
  const seen = new Set<number>();

  const offer = (port: number): void => {
    if (port < rangeStart || port > rangeEnd || seen.has(port) || blocked.has(port)) return;
    seen.add(port);
    ordered.push(port);
  };

  offer(containerPort);
  for (const port of reusable) offer(port);

  const start = Math.floor(Math.random() * size);
  for (let step = 0; step < size; step += 1) {
    offer(rangeStart + ((start + step) % size));
  }
  return ordered;
}

/**
 * Reserves a host port for every port the blueprint declares.
 *
 * The returned rows are detached on purpose — nothing owns them until `claimAllocations`
 * binds them to a server, which is the point at which two racing provisions are separated.
 * A caller that abandons a reservation should release it; one that is abandoned by a crash
 * is picked up again by the next allocation that needs that port.
 */
export async function allocatePorts(
  nodeId: string,
  requested: Record<string, number>,
  blueprintPorts: readonly BlueprintPort[],
): Promise<AllocationRecord[]> {
  const node = await prisma.node.findUnique({
    where: { id: nodeId },
    select: { portRangeStart: true, portRangeEnd: true },
  });
  if (!node) throw notFound('node');

  const names = new Set(blueprintPorts.map((port) => port.name));
  for (const name of Object.keys(requested)) {
    if (!names.has(name)) throw badRequest(`This blueprint has no port called "${name}".`);
  }

  const onNode = await prisma.allocation.findMany({
    where: { nodeId },
    select: { hostPort: true, protocol: true, serverId: true, portName: true },
  });

  const reserved: AllocationRecord[] = [];
  /** Ports handed out inside this call: the table cannot tell them apart from free ones. */
  const usedHere = new Set<number>();

  try {
    for (const port of blueprintPorts) {
      const explicit = requested[port.name];
      if (explicit !== undefined) {
        if (explicit < node.portRangeStart || explicit > node.portRangeEnd) {
          throw badRequest(
            `Port ${explicit} is outside this node's range (${node.portRangeStart}–${node.portRangeEnd}).`,
          );
        }
        if (usedHere.has(explicit)) {
          throw badRequest(`Port ${explicit} was requested for two different ports.`);
        }
        const exact = await reserve(nodeId, explicit, port);
        if (!exact) {
          throw new PlatterError('conflict', `Port ${explicit} is already in use on this node.`);
        }
        usedHere.add(explicit);
        reserved.push(exact);
        continue;
      }

      const blocked = new Set(usedHere);
      const reusable: number[] = [];
      for (const row of onNode) {
        if (toProtocol(row.protocol) !== port.protocol) continue;
        if (row.serverId !== null) blocked.add(row.hostPort);
        // A detached row already labelled for this role is the cheapest one to take: no
        // relabel, so nothing about it changes between the reservation and the claim.
        else if (row.portName === port.name) reusable.unshift(row.hostPort);
        else reusable.push(row.hostPort);
      }

      const candidates = candidatePorts(
        port.containerPort,
        Math.max(node.portRangeStart, LIMITS.minPort),
        Math.min(node.portRangeEnd, LIMITS.maxPort),
        reusable,
        blocked,
      );

      let allocated: AllocationRecord | null = null;
      for (const candidate of candidates.slice(0, MAX_CLAIM_ATTEMPTS)) {
        allocated = await reserve(nodeId, candidate, port);
        if (allocated) break;
      }
      if (!allocated) {
        throw new PlatterError(
          'no_allocation_available',
          `No free ${port.protocol} ports left on this node.`,
        );
      }
      usedHere.add(allocated.hostPort);
      reserved.push(allocated);
    }
  } catch (error) {
    // All or nothing. A half-reserved set is worse than none: the rows look free to the
    // next allocator but carry the wrong port names until something relabels them.
    await releaseAllocations(reserved.map((record) => record.id));
    throw toPlatterError(error);
  }

  return reserved;
}

/**
 * Binds reserved ports to a server, all or nothing.
 *
 * `serverId: null` in the where clause is the whole mechanism: two creates handed the same
 * free row both reach this point, and exactly one UPDATE matches. The loser releases what
 * it did get and retries rather than sharing a port.
 */
export async function claimAllocations(
  serverId: string,
  records: readonly AllocationRecord[],
): Promise<AllocationRecord[]> {
  const claimed: AllocationRecord[] = [];
  try {
    for (const record of records) {
      const result = await prisma.allocation.updateMany({
        where: { id: record.id, serverId: null },
        data: { serverId, portName: record.portName, primary: record.primary },
      });
      if (result.count === 0) {
        throw new PlatterError(
          'no_allocation_available',
          'Another server claimed those ports first. Try again.',
          { retryable: true },
        );
      }
      claimed.push({ ...record, serverId });
    }
    return claimed;
  } catch (error) {
    await releaseAllocations(claimed.map((record) => record.id));
    throw toPlatterError(error);
  }
}

/** Detaches specific allocations. Failure here is logged nowhere on purpose: see below. */
async function releaseAllocations(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  // Swallowed because this only ever runs while another error is on its way up, and
  // replacing that error with this one would hide the reason the caller actually failed.
  await prisma.allocation
    .updateMany({
      where: { id: { in: [...ids] } },
      data: { serverId: null, portName: null, primary: false },
    })
    .catch(() => undefined);
}

/** Detaches a server's ports so they return to the pool. Returns how many were freed. */
export async function releasePorts(serverId: string): Promise<number> {
  const result = await prisma.allocation.updateMany({
    where: { serverId },
    data: { serverId: null, portName: null, primary: false },
  });
  return result.count;
}

export async function listAllocations(nodeId: string): Promise<AllocationRecord[]> {
  const rows = await prisma.allocation.findMany({
    where: { nodeId },
    orderBy: [{ hostPort: 'asc' }, { protocol: 'asc' }],
  });
  return rows.map(toRecord);
}

export async function serverAllocations(serverId: string): Promise<AllocationRecord[]> {
  const rows = await prisma.allocation.findMany({
    where: { serverId },
    orderBy: [{ primary: 'desc' }, { hostPort: 'asc' }],
  });
  return rows.map(toRecord);
}

/**
 * Joins allocations back to their blueprint ports. `portName` is the only link between
 * the two — the table stores no container port, because the blueprint may change it.
 */
export function toPortBindings(
  allocations: readonly AllocationRecord[],
  blueprintPorts: readonly BlueprintPort[],
): PortBinding[] {
  const byName = new Map(blueprintPorts.map((port) => [port.name, port]));
  const bindings: PortBinding[] = [];
  for (const allocation of allocations) {
    const port = allocation.portName === null ? undefined : byName.get(allocation.portName);
    // An allocation whose port the blueprint no longer declares is not published: binding
    // it would need a container port we can only guess at.
    if (!port) continue;
    bindings.push({
      hostIp: allocation.hostIp,
      hostPort: allocation.hostPort,
      containerPort: port.containerPort,
      protocol: port.protocol,
    });
  }
  return bindings;
}
