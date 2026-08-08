import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { TEMPLATE_DB_ENV } from './global-setup.js';

/**
 * Per-test-file environment, applied before the file itself is imported.
 *
 * This runs first precisely because `config.ts` snapshots `process.env` at module load:
 * anything set after the first `import '../config.js'` anywhere in the graph is ignored.
 * Files that predate this harness set the same variables at their own top level and simply
 * win — the values are equivalent, and overriding them here would break their isolation.
 *
 * Two properties matter and are non-negotiable:
 *  - **A private database per file.** Test files run in separate processes; sharing one
 *    SQLite file would make row counts depend on execution order.
 *  - **The mock driver.** Nothing in the suite may reach a real Docker socket. A test that
 *    silently talked to the developer's daemon would pass locally and destroy CI.
 */

const workdir = mkdtempSync(path.join(tmpdir(), 'platter-test-'));
const databasePath = path.join(workdir, 'test.db');

const template = process.env[TEMPLATE_DB_ENV];
if (template && existsSync(template)) {
  copyFileSync(template, databasePath);
}

mkdirSync(path.join(workdir, 'data'), { recursive: true });

process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] ??= `file:${databasePath}`;
process.env['DATA_DIR'] ??= path.join(workdir, 'data');
process.env['BACKUP_DIR'] ??= path.join(workdir, 'data', 'backups');
// Long enough to satisfy the production-length check, so no test depends on the
// randomly generated development fallback.
process.env['JWT_SECRET'] ??= 'test-secret-that-is-long-enough-to-pass';
process.env['DEFAULT_NODE_DRIVER'] = 'mock';
// Off by default: the collector would otherwise open a metrics database and a driver
// connection for suites that never look at either.
process.env['METRICS_ENABLED'] ??= 'false';

/** Exposed for `helpers.ts`, which needs the same paths without recomputing them. */
export const testPaths = { workdir, databasePath };

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});
