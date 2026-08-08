import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import type { Allocation, Node as NodeRow } from '@prisma/client';
import { LIMITS, PlatterError, type BlueprintPort } from '@platter/shared';
import { prisma } from '../db.js';
import { isPrismaKnownError, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { parseDockerEndpoint } from '../orchestration/docker.js';

/**
 * Host port allocation.
 *
 * Two servers being provisioned at the same moment is the case that matters here. The
 * obvious implementation — pick a port that is not in the table, then insert it — has a
 * window between the read and the write in which both provisions choose the same number,
 * and the failure only surfaces later as a container that will not start. So the table's
 * unique constraint on `(nodeId, hostIp, hostPort, protocol)` is the arbiter: we insert
 * optimistically, and a unique violation is a normal, expected outcome that moves us to
 * the next candidate rather than an error.
 *
 * Rows are handed back with `serverId` still null. The caller claims them with a
 * conditional update (see `claimAllocations` in `services/servers.ts`), which closes the
 * second race: two provisions can be handed the same recycled free row, and exactly one
 * of them wins the claim.
 */

/**
 * Allocations bind on every interface. A node has no host-IP column, and the schema
 * default matches — the value is written explicitly so the unique key we rely on is
 * never affected by a default changing.
 */
const HOST_IP = '0.0.0.0';

/** A bind probe that has not answered in this long is treated as "not available". */
const BIND_PROBE_TIMEOUT_MS = 1000;

/**
 * How long a handed-out row is hidden from the free pool.
 *
 * An allocation that has been reserved but not yet claimed is indistinguishable in the
 * table from one that a deleted server left behind — `serverId` is null on both. Without
 * this, a provision that starts while another is mid-flight adopts the row that one is
 * about to claim, and one of the two creates fails for no reason a user can act on.
 *
 * It is a latency hint, not a lock: it lives in this process only, and correctness still
 * rests on the unique constraint plus the caller's conditional claim.
 */
const RESERVATION_TTL_MS = 30_000;
const MAX_RESERVATIONS = 10_000;

type Protocol = 'tcp' | 'udp';

/** allocation id -> when this process stops hiding it. */
const reservations = new Map<string, number>();

function pruneReservations(now: number): void {
  for (const [id, expiresAt] of reservations) {
    if (expiresAt <= now) reservations.delete(id);
  }
  if (reservations.size <= MAX_RESERVATIONS) return;
  // Nothing should ever get here — entries expire in half a minute — but an unbounded map
  // in a process that runs for months is a bug waiting for an unusual day.
  const oldestFirst = [...reservations.entries()].sort((left, right) => left[1] - right[1]);
  for (const [id] of oldestFirst.slice(0, reservations.size - MAX_RESERVATIONS)) {
    reservations.delete(id);
  }
}

function protocolOf(port: BlueprintPort): Protocol {
  return port.protocol === 'udp' ? 'udp' : 'tcp';
}

// ---------------------------------------------------------------------------
// Bind probing
// ---------------------------------------------------------------------------

/**
 * Only a node whose runtime is reachable over a local socket shares a network stack with
 * this process. Probing a port for a node across a `tcp://` endpoint would test the API
 * host's ports and reject perfectly good ports on the real host, so it is skipped there
 * and the runtime reports the collision at container start instead.
 */
function isLocalNode(node: NodeRow): boolean {
  try {
    return parseDockerEndpoint(node.endpoint).socketPath !== undefined;
  } catch {
    // An endpoint we cannot parse is not one we can claim is local.
    return false;
  }
}

/**
 * Resolves once, and always releases the handle.
 *
 * `settle` is idempotent because a failed probe can produce both an `error` event and a
 * close callback, and the second one must not resolve a promise that already answered.
 */
function probeTcp(hostPort: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    let settled = false;
    const settle = (free: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      server.removeAllListeners();
      // close() on a server that never bound throws ERR_SERVER_NOT_RUNNING.
      server.close(() => undefined);
      resolve(free);
    };

    const guard = setTimeout(() => {
      settle(false);
    }, BIND_PROBE_TIMEOUT_MS);
    guard.unref();

    server.once('error', () => {
      settle(false);
    });
    server.once('listening', () => {
      settle(true);
    });
    // `exclusive` keeps the probe from being satisfied by a handle shared with a cluster
    // primary, which would make an occupied port look free.
    server.listen({ host: HOST_IP, port: hostPort, exclusive: true });
  });
}

function probeUdp(hostPort: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // `reuseAddr` deliberately off: with it on, the bind succeeds even though something
    // else already holds the port, which is the opposite of what this asks.
    const socket = createSocket({ type: 'udp4', reuseAddr: false });
    let settled = false;
    const settle = (free: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      socket.removeAllListeners();
      try {
        socket.close();
      } catch {
        // Never bound; there is nothing to close.
      }
      resolve(free);
    };

    const guard = setTimeout(() => {
      settle(false);
    }, BIND_PROBE_TIMEOUT_MS);
    guard.unref();

    socket.once('error', () => {
      settle(false);
    });
    socket.bind({ address: HOST_IP, port: hostPort, exclusive: true }, () => {
      settle(true);
    });
  });
}

/**
 * Whether the host will actually let a container bind this port.
 *
 * The database only knows about ports Platter handed out. Anything else on the box — a
 * system service, a container someone started by hand, an SSH tunnel — is invisible to it,
 * and finding out at `docker start` produces an opaque runtime error instead of a sentence
 * about a port being in use.
 */
async function isBindable(hostPort: number, protocol: Protocol): Promise<boolean> {
  return protocol === 'udp' ? probeUdp(hostPort) : probeTcp(hostPort);
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

interface ClaimRequest {
  nodeId: string;
  hostPort: number;
  protocol: Protocol;
  portName: string;
  primary: boolean;
  /** A detached row for this exact port that existed before this call began, if any. */
  reusableId: string | undefined;
}

/**
 * Takes one port, or answers null if someone else got there first.
 *
 * Recycling is deliberately limited to rows that were already in the free pool when this
 * call started. A row that appeared *during* the call belongs to a provision that is
 * running right now and has not claimed it yet — it looks identical (`serverId` is null on
 * both) and treating it as free would hand every concurrent create the same port, which
 * they would then fight over at claim time.
 *
 * So the insert is attempted blind, and `P2002` is not an error: it is the constraint
 * telling us that number is spoken for, and the caller moves to the next candidate.
 */
async function claim(request: ClaimRequest): Promise<Allocation | null> {
  if (request.reusableId !== undefined) {
    const existing = await prisma.allocation.findUnique({ where: { id: request.reusableId } });
    if (existing && existing.serverId === null) {
      // Guarded on `serverId: null` so a row claimed while we were deciding is not
      // relabelled out from under the server that now owns it.
      const updated = await prisma.allocation.updateMany({
        where: { id: existing.id, serverId: null },
        data: { portName: request.portName, primary: request.primary },
      });
      if (updated.count === 0) return null;
      reservations.set(existing.id, Date.now() + RESERVATION_TTL_MS);
      return { ...existing, portName: request.portName, primary: request.primary };
    }
    if (existing) return null;
    // The row was deleted since the scan; fall through and insert a fresh one.
  }

  // Reserved before the insert, not after: the id is ours to choose, and a provision whose
  // scan lands between our write and our bookkeeping would otherwise see an unreserved
  // free row and adopt it.
  const id = newId('alc');
  reservations.set(id, Date.now() + RESERVATION_TTL_MS);
  try {
    return await prisma.allocation.create({
      data: {
        id,
        nodeId: request.nodeId,
        hostIp: HOST_IP,
        hostPort: request.hostPort,
        protocol: request.protocol,
        portName: request.portName,
        primary: request.primary,
        serverId: null,
      },
    });
  } catch (error) {
    reservations.delete(id);
    // P2002 is the design working: the constraint, not a read, decides who got the port.
    if (isPrismaKnownError(error) && error.code === 'P2002') return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

function exhausted(node: NodeRow): PlatterError {
  return new PlatterError(
    'no_allocation_available',
    `${node.name} has no free ports left between ${node.portRangeStart} and ${node.portRangeEnd}.`,
  );
}

/**
 * Field-scoped so the create form can highlight the port that is the problem, while the
 * code stays `no_allocation_available` — the client switches on that to offer "pick
 * another port" rather than a generic validation banner.
 */
function portRejected(portName: string, message: string): PlatterError {
  return new PlatterError('no_allocation_available', message, {
    details: { [`ports.${portName}`]: [message] },
  });
}

function unavailable(portName: string, hostPort: number): PlatterError {
  return portRejected(portName, `Port ${hostPort} is already in use on that node.`);
}

/**
 * Reserves one host port per blueprint port.
 *
 * `requested` is the operator's explicit choice, keyed by blueprint port name; anything it
 * does not name is taken from the node's range. An explicit port is honoured even outside
 * that range — the range governs what Platter picks on its own, not what a human is
 * allowed to ask for — but it must still be unprivileged and actually bindable.
 *
 * The returned rows are not yet owned: the caller claims them, and releases them if the
 * rest of the create fails.
 */
export async function allocatePorts(
  nodeId: string,
  requested: Record<string, number>,
  blueprintPorts: readonly BlueprintPort[],
): Promise<Allocation[]> {
  const node = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!node) throw notFound('node');
  if (blueprintPorts.length === 0) return [];

  const now = Date.now();
  pruneReservations(now);

  const rows = await prisma.allocation.findMany({
    where: { nodeId },
    select: { id: true, hostPort: true, protocol: true, serverId: true },
  });

  // Port numbers this provision may not use. Tracked without regard to protocol:
  // tcp/25000 and udp/25000 could legally coexist, but handing one server's number to
  // another server's other protocol makes `docker ps` unreadable and confuses every
  // operator who ever has to debug it.
  const blocked = new Set<number>();
  // Rows genuinely in the free pool — recyclable, because nothing else is mid-claim on them.
  const reusable = new Map<string, string>();
  for (const row of rows) {
    if (row.serverId !== null || reservations.has(row.id)) {
      blocked.add(row.hostPort);
      continue;
    }
    reusable.set(`${row.protocol}/${row.hostPort}`, row.id);
  }

  const primaryName = (blueprintPorts.find((port) => port.primary) ?? blueprintPorts[0])?.name;
  const assigned = new Set<number>();
  const claimed: Allocation[] = [];

  try {
    for (const blueprintPort of blueprintPorts) {
      const protocol = protocolOf(blueprintPort);
      const primary = blueprintPort.name === primaryName;
      const explicit = requested[blueprintPort.name];

      if (explicit !== undefined) {
        if (explicit < LIMITS.minPort || explicit > LIMITS.maxPort) {
          throw portRejected(
            blueprintPort.name,
            `Choose a port between ${LIMITS.minPort} and ${LIMITS.maxPort}.`,
          );
        }
        if (blocked.has(explicit) || assigned.has(explicit)) {
          throw unavailable(blueprintPort.name, explicit);
        }
        if (isLocalNode(node) && !(await isBindable(explicit, protocol))) {
          throw unavailable(blueprintPort.name, explicit);
        }

        const row = await claim({
          nodeId,
          hostPort: explicit,
          protocol,
          portName: blueprintPort.name,
          primary,
          reusableId: reusable.get(`${protocol}/${explicit}`),
        });
        if (!row) throw unavailable(blueprintPort.name, explicit);

        assigned.add(explicit);
        claimed.push(row);
        continue;
      }

      const row = await allocateFromRange(node, {
        protocol,
        portName: blueprintPort.name,
        primary,
        skip: (candidate) => blocked.has(candidate) || assigned.has(candidate),
        reusable,
      });
      assigned.add(row.hostPort);
      claimed.push(row);
    }

    return claimed;
  } catch (error) {
    // Rows reserved before the failure are already unowned, but they still carry this
    // server's port name. Clearing it keeps the free pool from advertising reservations
    // for a server that was never created.
    await detach(claimed.map((row) => row.id));
    throw error;
  }
}

interface RangePick {
  protocol: Protocol;
  portName: string;
  primary: boolean;
  skip: (hostPort: number) => boolean;
  /** `protocol/port` -> id of a free row that predates this call. */
  reusable: Map<string, string>;
}

async function allocateFromRange(node: NodeRow, pick: RangePick): Promise<Allocation> {
  const start = Math.max(LIMITS.minPort, node.portRangeStart);
  const end = Math.min(LIMITS.maxPort, node.portRangeEnd);
  const local = isLocalNode(node);

  for (let candidate = start; candidate <= end; candidate += 1) {
    if (pick.skip(candidate)) continue;
    if (local && !(await isBindable(candidate, pick.protocol))) continue;

    const row = await claim({
      nodeId: node.id,
      hostPort: candidate,
      protocol: pick.protocol,
      portName: pick.portName,
      primary: pick.primary,
      reusableId: pick.reusable.get(`${pick.protocol}/${candidate}`),
    });
    // null means another provision took this number while we were probing it. That is the
    // expected outcome under concurrency, not a failure: try the next one.
    if (row) return row;
  }

  throw exhausted(node);
}

async function detach(allocationIds: readonly string[]): Promise<void> {
  if (allocationIds.length === 0) return;
  // Released immediately rather than left to expire: these ports are free again right now,
  // and the operator retrying a failed create should get the same numbers back.
  for (const id of allocationIds) reservations.delete(id);
  await prisma.allocation.updateMany({
    where: { id: { in: [...allocationIds] }, serverId: null },
    data: { portName: null, primary: false },
  });
}

/**
 * Returns a deleted server's ports to the free pool.
 *
 * The rows are detached rather than deleted, as the schema intends: the port keeps its
 * identity on the node, and reuse becomes an explicit, visible act instead of a new row
 * that happens to carry the same number.
 */
export async function releasePorts(serverId: string): Promise<number> {
  const rows = await prisma.allocation.findMany({ where: { serverId }, select: { id: true } });
  const result = await prisma.allocation.updateMany({
    where: { serverId },
    data: { serverId: null, portName: null, primary: false },
  });
  // A released port is free now, not in thirty seconds: an operator who deletes a server
  // to free up 25565 and immediately recreates it expects that number back.
  for (const row of rows) reservations.delete(row.id);
  return result.count;
}

/** Every allocation on a node, free and owned, in port order. */
export async function listAllocations(nodeId: string): Promise<Allocation[]> {
  return prisma.allocation.findMany({
    where: { nodeId },
    orderBy: [{ hostPort: 'asc' }, { protocol: 'asc' }],
  });
}
