import { createServer } from 'node:net';
import { and, eq, isNull } from 'drizzle-orm';
import type { PlatterDatabase } from '@platter/db';
import { portAllocations } from '@platter/db';
import { type Result, fail, ok } from '@platter/shared';

/**
 * Port allocation.
 *
 * Three sources of truth have to agree here and none of them is sufficient alone:
 *
 *   - The **ledger** (`port_allocations`) knows what Platter has promised, including ports for
 *     servers that are currently stopped or that failed to create. Scanning `docker ps` misses
 *     both.
 *   - The **kernel** knows what is actually bound, including by processes Platter has never
 *     heard of — the user's own Minecraft server, a dev server, another panel.
 *   - The **unique index** on `port_allocations.port` is what makes two concurrent creates
 *     safe. Check-then-insert races; the constraint does not.
 *
 * So: pick a candidate from the ledger's free set, probe the kernel, insert, and let the
 * constraint arbitrate ties.
 */

export interface PortRange {
  start: number;
  end: number;
}

export type PortPurpose = 'game' | 'rcon' | 'query' | 'custom';

/**
 * Is this port actually bindable right now?
 *
 * Binds to 0.0.0.0 rather than 127.0.0.1 deliberately: a service bound only to another
 * interface would be invisible to a loopback probe, and Platter would then hand the port to a
 * container whose `docker start` fails minutes later with an opaque "port is already
 * allocated". Failing here instead gives a much better error at a much better time.
 */
export function isPortFree(port: number, host = '0.0.0.0'): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const probe = createServer();
    // Without this, a port in TIME_WAIT from a just-removed container reads as busy for
    // minutes, and rapid create/delete/create cycles fail for no visible reason.
    probe.once('error', () => resolvePromise(false));
    probe.once('listening', () => {
      probe.close(() => resolvePromise(true));
    });
    probe.listen({ port, host, exclusive: true });
  });
}

export interface AllocateOptions {
  serverId: string;
  purpose: PortPurpose;
  range: PortRange;
  protocol?: 'tcp' | 'udp';
  /** Try this port first. Used when re-creating a container for an existing server. */
  preferred?: number | undefined;
  /** Probe host. Defaults to 0.0.0.0. */
  probeHost?: string;
}

export async function allocatePort(
  db: PlatterDatabase,
  options: AllocateOptions
): Promise<Result<number>> {
  const { serverId, purpose, range, protocol = 'tcp', probeHost = '0.0.0.0' } = options;

  const taken = new Set(
    db
      .select({ port: portAllocations.port })
      .from(portAllocations)
      .all()
      .map((row) => row.port)
  );

  const candidates: number[] = [];
  if (options.preferred !== undefined && !taken.has(options.preferred)) {
    candidates.push(options.preferred);
  }
  for (let port = range.start; port <= range.end; port++) {
    if (!taken.has(port) && port !== options.preferred) {
      candidates.push(port);
    }
  }

  if (candidates.length === 0) {
    return fail(
      'port_unavailable',
      `No free ports left in the range ${range.start}-${range.end}. ` +
        'Widen PLATTER_PORT_RANGE_START/END or delete an unused server.',
      { details: { range } }
    );
  }

  for (const port of candidates) {
    if (!(await isPortFree(port, probeHost))) {
      continue;
    }
    try {
      db.insert(portAllocations)
        .values({ port, serverId, purpose, protocol })
        .run();
      return ok(port);
    } catch (cause) {
      // UNIQUE violation: another process won the race for this port. Try the next one.
      if (String(cause).includes('UNIQUE')) {
        continue;
      }
      return fail('internal', `Could not record port allocation for ${port}.`, { cause });
    }
  }

  return fail(
    'port_unavailable',
    `Every port in ${range.start}-${range.end} is either allocated or already bound on the host.`,
    { details: { range, checked: candidates.length } }
  );
}

/** Release a single port. */
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
 * Drop ledger rows whose server no longer exists.
 *
 * A crash between "allocate port" and "insert server" leaves an orphan that would otherwise
 * leak a port permanently. Run at startup, where a brief inconsistency window is harmless.
 */
export function reclaimOrphanedPorts(db: PlatterDatabase): number {
  const result = db
    .delete(portAllocations)
    .where(and(isNull(portAllocations.serverId)))
    .run();
  return result.changes;
}
