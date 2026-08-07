import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * The drizzle instance plus a couple of escape hatches. Written as an explicit interface rather
 * than inferred from `createDatabase`, because inferring it leaks `better-sqlite3`'s internal
 * namespace into the declaration output and TypeScript then refuses to name it.
 */
export type PlatterDatabase = DrizzleDb & {
  /** Raw handle, for pragmas, VACUUM and the migrator. */
  readonly $sqlite: SqliteDatabase;
  /** Checkpoint the WAL and close. */
  readonly $close: () => void;
};

export interface DatabaseOptions {
  /** Filesystem path, or ':memory:' for tests. */
  path: string;
  /** Log every statement. Noisy; debugging only. */
  debug?: boolean;
  /** Skip PRAGMA tuning. Only for in-memory test databases. */
  raw?: boolean;
}

/**
 * Open the SQLite database with the pragmas Platter needs.
 *
 * The defaults matter more than they look:
 *
 *   journal_mode = WAL     The web app reads while the supervisor writes status updates every
 *                          few seconds. Without WAL, a reader blocks the writer and the UI
 *                          intermittently 500s under perfectly normal load.
 *   busy_timeout = 5000    WAL still serialises writers. 5s of patience turns a rare
 *                          SQLITE_BUSY into a slightly slow request instead of an error.
 *   foreign_keys = ON      SQLite ignores foreign keys unless you ask. The schema's ON DELETE
 *                          CASCADE rules are load-bearing for server teardown.
 *   synchronous = NORMAL   Safe under WAL (a crash can lose the last commit, not corrupt the
 *                          file). FULL costs an fsync per transaction and we write frequently.
 */
export function createDatabase(options: DatabaseOptions): PlatterDatabase {
  const { path, debug = false, raw = false } = options;

  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const sqlite = new Database(path);

  if (!raw) {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('busy_timeout = 5000');
    sqlite.pragma('synchronous = NORMAL');
    sqlite.pragma('temp_store = MEMORY');
    // 64 MiB page cache. The whole database is small; keeping it hot removes disk from the
    // read path entirely.
    sqlite.pragma('cache_size = -64000');
  }
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema, logger: debug });

  return Object.assign(db, {
    /** Escape hatch for pragmas, VACUUM and the migrator. */
    $sqlite: sqlite,
    $close: () => {
      // A WAL checkpoint on close keeps the -wal file from growing without bound across
      // restarts, and leaves a single self-contained .db file for backups.
      try {
        sqlite.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // Checkpointing is best-effort; a locked database still closes cleanly.
      }
      sqlite.close();
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Process-wide singleton                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Next.js reloads modules on every edit in development, which would otherwise open a new SQLite
 * handle per reload until the process runs out of file descriptors. Stashing the instance on
 * `globalThis` survives module reloading; the production path is unaffected.
 */
const GLOBAL_KEY = Symbol.for('platter.db');

interface GlobalWithDb {
  [GLOBAL_KEY]?: PlatterDatabase;
}

export function getDatabase(options: DatabaseOptions): PlatterDatabase {
  const container = globalThis as GlobalWithDb;
  const existing = container[GLOBAL_KEY];
  if (existing) {
    return existing;
  }
  const db = createDatabase(options);
  container[GLOBAL_KEY] = db;
  return db;
}

export function closeDatabase(): void {
  const container = globalThis as GlobalWithDb;
  container[GLOBAL_KEY]?.$close();
  container[GLOBAL_KEY] = undefined;
}
