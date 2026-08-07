import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { PlatterDatabase } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Where the generated migration SQL lives.
 *
 * Resolved relative to this module rather than `process.cwd()`, because Platter's migrations
 * run from three different working directories — the Next.js server, the MCP server, and the
 * CLI — and a cwd-relative path works in exactly one of them.
 */
export const MIGRATIONS_DIR = resolve(here, '../drizzle');

/**
 * Bring the database up to date.
 *
 * Called automatically at startup rather than left to a separate `db:migrate` step. A local
 * app that asks you to run a migration command before it will start is a local app that people
 * file bugs against on first run.
 */
export function applyMigrations(db: PlatterDatabase, migrationsFolder = MIGRATIONS_DIR): void {
  if (!existsSync(migrationsFolder)) {
    throw new Error(
      `Migrations folder not found at ${migrationsFolder}. ` +
        'Run `pnpm --filter @platter/db generate` to create it.'
    );
  }
  migrate(db, { migrationsFolder });
}

/* Allow `tsx src/migrate.ts` for a manual run. */
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { createDatabase } = await import('./client.js');
  const { paths } = await import('@platter/shared');
  const { loadEnv } = await import('@platter/shared/env');
  const env = loadEnv();
  const db = createDatabase({ path: paths.db(env.PLATTER_DATA_DIR) });
  applyMigrations(db);
  db.$close();
  process.stderr.write(`Migrations applied to ${paths.db(env.PLATTER_DATA_DIR)}\n`);
}
