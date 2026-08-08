import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds the SQLite schema exactly once for the whole run.
 *
 * `prisma db push` costs well over a second, and every test file that touches the database
 * needs a database of its own (they run in separate processes and must not see each
 * other's rows). Paying that per file is minutes of wall clock; instead this produces one
 * template file that `setup.ts` copies, which is a few milliseconds.
 */

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Where `setup.ts` looks for the template. Deterministic rather than passed through
 * Vitest's `provide`, because it also has to be readable from a forked worker. */
export const TEMPLATE_DB_ENV = 'PLATTER_TEST_TEMPLATE_DB';

let workdir: string | null = null;

export async function setup(): Promise<void> {
  workdir = mkdtempSync(path.join(tmpdir(), 'platter-schema-'));
  const templatePath = path.join(workdir, 'template.db');

  execFileSync(path.join(apiRoot, 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: `file:${templatePath}` },
    stdio: 'ignore',
  });

  // Read back by every worker process, which inherits this env at fork time.
  process.env[TEMPLATE_DB_ENV] = templatePath;
}

export async function teardown(): Promise<void> {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
}
