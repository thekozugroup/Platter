import { and, desc, eq, isNull } from 'drizzle-orm';
import type { PlatterDatabase, ServerRow } from '@platter/db';
import { parseJson, servers } from '@platter/db';
import {
  type MinecraftLoader,
  type ServerSettings,
  type ServerStatus,
  logger,
  serverSettingsSchema,
} from '@platter/shared';

const log = logger.child('servers');

/**
 * The server row, with its JSON columns decoded.
 *
 * Settings are parsed leniently: a blob written by an older Platter that no longer matches the
 * schema falls back to defaults and logs, rather than throwing. A dashboard that will not render
 * because one server has a stale settings field is worse than a server showing default values
 * until someone re-saves it.
 */
export interface Server extends Omit<ServerRow, 'settings' | 'loader' | 'status' | 'cpus'> {
  loader: MinecraftLoader;
  status: ServerStatus;
  settings: ServerSettings;
  /** Fractional CPUs. Stored as millicores in the database to keep the column an integer. */
  cpus: number;
}

export function hydrate(row: ServerRow): Server {
  const settings = parseJson(serverSettingsSchema, row.settings, serverSettingsSchema.parse({}), (issues) =>
    log.warn('server settings did not match the schema; using defaults', {
      serverId: row.id,
      issues,
    })
  );

  return {
    ...row,
    loader: row.loader as MinecraftLoader,
    status: row.status as ServerStatus,
    settings,
    cpus: row.cpus / 1000,
  };
}

export function listServers(db: PlatterDatabase, options: { includeDeleted?: boolean } = {}): Server[] {
  const rows = db
    .select()
    .from(servers)
    .where(options.includeDeleted === true ? undefined : isNull(servers.deletedAt))
    .orderBy(desc(servers.id))
    .all();
  return rows.map(hydrate);
}

export function getServer(db: PlatterDatabase, id: string): Server | undefined {
  const row = db.select().from(servers).where(eq(servers.id, id)).get();
  return row ? hydrate(row) : undefined;
}

export function getServerBySlug(db: PlatterDatabase, slug: string): Server | undefined {
  const row = db
    .select()
    .from(servers)
    .where(and(eq(servers.slug, slug), isNull(servers.deletedAt)))
    .get();
  return row ? hydrate(row) : undefined;
}

/**
 * Resolve a user-supplied reference to a server.
 *
 * MCP clients and CLI users refer to servers by name far more naturally than by ULID, so every
 * entry point accepts an id, a slug, or a display name. Ambiguity is resolved in that order,
 * which means a slug can never shadow an id.
 */
export function resolveServer(db: PlatterDatabase, reference: string): Server | undefined {
  const byId = getServer(db, reference);
  if (byId) {
    return byId;
  }
  const bySlug = getServerBySlug(db, reference);
  if (bySlug) {
    return bySlug;
  }
  const normalized = reference.trim().toLowerCase();
  return listServers(db).find((server) => server.name.toLowerCase() === normalized);
}

export function updateServer(
  db: PlatterDatabase,
  id: string,
  patch: Partial<Omit<ServerRow, 'id' | 'createdAt'>>
): void {
  db.update(servers)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(servers.id, id))
    .run();
}

export function setStatus(
  db: PlatterDatabase,
  id: string,
  status: ServerStatus,
  message?: string | null
): void {
  const patch: Partial<ServerRow> = { status, statusMessage: message ?? null, updatedAt: Date.now() };
  if (status === 'running') {
    patch.startedAt = Date.now();
  }
  if (status === 'stopped' || status === 'crashed') {
    patch.stoppedAt = Date.now();
  }
  db.update(servers).set(patch).where(eq(servers.id, id)).run();
}

export function setSettings(db: PlatterDatabase, id: string, settings: ServerSettings): void {
  db.update(servers)
    .set({ settings, updatedAt: Date.now() })
    .where(eq(servers.id, id))
    .run();
}

/** Servers Platter expects to be running. Used by the reconciler at startup. */
export function listExpectedRunning(db: PlatterDatabase): Server[] {
  return listServers(db).filter(
    (server) => server.status === 'running' || server.status === 'starting' || server.status === 'unhealthy'
  );
}
