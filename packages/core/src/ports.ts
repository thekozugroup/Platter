import { createServer } from 'node:net';
import type { PlatterDatabase } from '@platter/db';
import { portAllocations } from '@platter/db';
import { fail, ok, type Result } from '@platter/shared';
import { eq, isNull } from 'drizzle-orm';

/**
 * Port allocation.
 *
 * Three sources of truth have to agree and none is sufficient alone:
 *
 *   - The **ledger** (`port_allocations`) knows what Platter has promised, including ports held
 *     by servers that are stopped or that failed to create. Scanning `docker ps` misses both.
 *   - The **kernel** knows what is actually bound, including by processes Platter has never
 *     heard of — the user's own server, a dev process, another panel.
 *   - The **unique index** on `port_allocations.port` is what makes two concurrent creates safe.
 *     Check-then-insert races; a constraint does not.
 *
 * The split between `findFreePorts` and `reservePorts` exists because those two facts are
 * gathered in incompatible ways. Probing the kernel is asynchronous; writing the ledger has to
 * happen inside the same synchronous transaction that inserts the server row, because
 * `port_allocations.server_id` has a foreign key to it. So: probe first, commit second.
 */

export interface PortRange {
  start: number;
  end: number;
}

export type PortPurpose = 'game' | 'rcon' | 'query' | 'custom';

/**
 * Is this port actually bindable right now?
 *
 * Binds to 0.0.0.0 rather than loopback deliberately: a service bound only to another interface
 * is invisible to a loopback probe, and Platter would hand the port to a container whose
 * `docker start` then fails minutes later with an opaque "port is already allocated". Failing
 * here gives a much better error at a much better time.
 */
export function isPortFree(port: number, host = '0.0.0.0'): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const probe = createServer();
    probe.once('error', () => resolvePromise(false));
    probe.once('listening', () => {
      probe.close(() => resolvePromise(true));
    });
    probe.listen({ port, host, exclusive: true });
  });
}

export interface FindPortsOptions {
  range: PortRange;
  /** How many distinct ports are needed. */
  count: number;
  /** Try these first — used when re-creating a container for an existing server. */
  preferred?: readonly number[];
  probeHost?: string;
  /** Ports to treat as taken beyond the ledger, e.g. ones reserved earlier in the same flow. */
  exclude?: readonly number[];
}

/**
 * Find `count` ports that are free in both the ledger and the kernel.
 *
 * Returns candidates only — nothing is written. The caller commits them with `reservePorts`
 * inside the transaction that creates the server.
 */
export async function findFreePorts(
  db: PlatterDatabase,
  options: FindPortsOptions
): Promise<Result<number[]>> {
  const { range, count, probeHost = '0.0.0.0' } = options;

  const taken = new Set<number>([
    ...db
      .select({ port: portAllocations.port })
      .from(portAllocations)
      .all()
      .map((row) => row.port),
    ...(options.exclude ?? []),
  ]);

  const candidates: number[] = [];
  for (const port of options.preferred ?? []) {
    if (!taken.has(port) && port >= 1 && port <= 65_535) {
      candidates.push(port);
      taken.add(port);
    }
  }
  for (let port = range.start; port <= range.end; port++) {
    if (!taken.has(port)) {
      candidates.push(port);
    }
  }

  if (candidates.length < count) {
    return fail(
      'port_unavailable',
      `Only ${candidates.length} unallocated port${candidates.length === 1 ? '' : 's'} left in ` +
        `${range.start}-${range.end}, but ${count} are needed. Widen PLATTER_PORT_RANGE_START/END ` +
        'or delete an unused server.',
      { details: { range, needed: count, available: candidates.length } }
    );
  }

  const found: number[] = [];
  for (const port of candidates) {
    if (await isPortFree(port, probeHost)) {
      found.push(port);
      if (found.length === count) {
        return ok(found);
      }
    }
  }

  return fail(
    'port_unavailable',
    `Every port in ${range.start}-${range.end} is either allocated to another server or already ` +
      'bound on this machine.',
    { details: { range, needed: count, found: found.length } }
  );
}

export interface PortReservation {
  port: number;
  purpose: PortPurpose;
  protocol?: 'tcp' | 'udp';
}

/**
 * Write port reservations. Synchronous, so it can run inside a better-sqlite3 transaction
 * alongside the server insert.
 *
 * Throws on a UNIQUE violation — that means another process won the race for a port between the
 * probe and the commit, and the caller should retry with fresh candidates rather than proceed.
 */
export function reservePorts(
  db: PlatterDatabase,
  serverId: string,
  reservations: readonly PortReservation[]
): void {
  for (const reservation of reservations) {
    db.insert(portAllocations)
      .values({
        port: reservation.port,
        serverId,
        purpose: reservation.purpose,
        protocol: reservation.protocol ?? 'tcp',
      })
      .run();
  }
}

/** True when an error from `reservePorts` was a lost race rather than a real fault. */
export function isPortConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE') || message.includes('SQLITE_CONSTRAINT_PRIMARYKEY');
}

export function releasePort(db: PlatterDatabase, port: number): void {
  db.delete(portAllocations).where(eq(portAllocations.port, port)).run();
}

/** Release everything a server holds. Called during teardown. */
export function releaseServerPorts(db: PlatterDatabase, serverId: string): void {
  db.delete(portAllocations).where(eq(portAllocations.serverId, serverId)).run();
}

export function listServerPorts(db: PlatterDatabase, serverId: string) {
  return db.select().from(portAllocations).where(eq(portAllocations.serverId, serverId)).all();
}

/**
 * Drop ledger rows with no owning server.
 *
 * The foreign key cascades on delete, so this only catches rows written with a null server id by
 * an older version or an interrupted migration. Run at startup, where a brief inconsistency
 * window is harmless.
 */
export function reclaimOrphanedPorts(db: PlatterDatabase): number {
  return db.delete(portAllocations).where(isNull(portAllocations.serverId)).run().changes;
}
