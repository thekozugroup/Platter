/**
 * Boots an API for one end-to-end run, on its own throwaway database.
 *
 * Playwright's `webServer` can only run a command, and the API needs three things done in
 * order before it can serve: a database file that exists, migrations applied to it, and a
 * data directory to put server volumes in. Doing that inline in the config would mean
 * `pnpm test:e2e` writes into whatever `DATABASE_URL` the developer's `.env` happens to name
 * — which on a machine running Platter for real is the real install. So the run gets a
 * fresh directory under the system temp dir, and nothing outside it is touched.
 *
 * The database is migrated but **not seeded**: it has no owner. That is deliberate — the
 * first-run journey is only a journey on an install that has never been set up, and the
 * `first-run` project creates the owner every other spec then signs in as. See the comment
 * on `projects` in `playwright.config.ts`.
 *
 * `DEFAULT_NODE_DRIVER=mock` is the point of the whole arrangement: the API really creates
 * servers, really walks them through `installing → starting → running`, and really streams
 * their console — against `apps/api/src/orchestration/mock.ts` instead of a Docker daemon.
 * Nothing in the suite stubs a Platter response.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, '../../../api');

const port = process.env.E2E_API_PORT ?? '8791';
const modrinthPort = process.env.E2E_MODRINTH_PORT ?? '8793';

const RUN_PREFIX = 'platter-e2e-';
const OWNER_FILE = 'owner.pid';

/**
 * Removes run directories whose launcher is no longer alive.
 *
 * Playwright stops a `webServer` by killing its process *group*, and an impatient stop is a
 * SIGKILL — which no exit handler survives. So the on-exit sweep below is the fast path, not
 * the guarantee; this is the guarantee. Each directory records the pid that owns it, and a
 * directory whose owner is gone can only be from a run that is over.
 *
 * Checking liveness rather than age is what makes this safe to run while another suite is
 * mid-flight: two runs on one machine never delete each other's database.
 */
function isAlive(pid) {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to somebody else — alive, and not ours to delete.
    return error.code === 'EPERM';
  }
}

function sweepFinishedRuns() {
  let entries;
  try {
    entries = readdirSync(tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(RUN_PREFIX)) continue;
    const dir = path.join(tmpdir(), entry.name);

    let owner = 0;
    try {
      owner = Number(readFileSync(path.join(dir, OWNER_FILE), 'utf8').trim());
    } catch {
      // No owner recorded — from a build of this script that did not write one, or a
      // directory that never got that far. Nothing can be using it.
    }
    if (Number.isFinite(owner) && owner > 0 && isAlive(owner)) continue;

    rmSync(dir, { recursive: true, force: true });
  }
}

sweepFinishedRuns();

const runDir = mkdtempSync(path.join(tmpdir(), RUN_PREFIX));
writeFileSync(path.join(runDir, OWNER_FILE), String(process.pid));
const databaseUrl = `file:${path.join(runDir, 'platter.db')}`;

const env = {
  ...process.env,
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  PORT: port,
  DATABASE_URL: databaseUrl,
  DATA_DIR: path.join(runDir, 'data'),
  BACKUP_DIR: path.join(runDir, 'backups'),
  DEFAULT_NODE_DRIVER: 'mock',
  // Long enough to satisfy the config's minimum; this process is thrown away with the run.
  JWT_SECRET: 'platter-e2e-signing-key-not-a-secret-0123456789',
  // The address a player would type. It must not be a bind address — one of the things the
  // lifecycle spec asserts is that Platter never shows `0.0.0.0` as somewhere to connect.
  PUBLIC_HOST: '127.0.0.1',
  // Away from 25000–25999 so a run cannot collide with a Platter instance on this machine.
  PORT_RANGE_START: '27100',
  PORT_RANGE_END: '27399',
  // The global flood ceiling, not the auth budget (`AUTH_RATE_LIMIT` is a constant in
  // `plugins/security.ts`). Raised because a suite drives the UI far faster than a person
  // and would otherwise fail on a limiter that is not what it is testing.
  RATE_LIMIT_MAX: '100000',
  // The mod-proposal journey talks to a fake registry on loopback, so the run needs no
  // network. See `modrinth-stub.mjs`.
  MODRINTH_BASE_URL: `http://127.0.0.1:${modrinthPort}/v2`,
  /*
   * `error`, not `warn`. Every unauthenticated page load logs "You are not signed in" at
   * warn — that is the silent refresh doing its job — and at one stack trace apiece it
   * buries the actual test output. Raise it with E2E_API_LOG_LEVEL when debugging a run.
   */
  LOG_LEVEL: process.env.E2E_API_LOG_LEVEL ?? 'error',
};

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: apiDir, env, stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`)),
    );
  });
}

const prisma = path.join(apiDir, 'node_modules/.bin/prisma');
const tsx = path.join(apiDir, 'node_modules/.bin/tsx');

let api = null;
let cleaningUp = false;

function cleanup() {
  if (cleaningUp) return;
  cleaningUp = true;
  api?.kill('SIGTERM');
  try {
    rmSync(runDir, { recursive: true, force: true });
  } catch {
    // A leftover temp directory is not worth failing a run over.
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    cleanup();
    process.exit(0);
  });
}
process.on('exit', cleanup);

process.stdout.write(`e2e api: database ${databaseUrl}\n`);
await run(prisma, ['migrate', 'deploy']);

api = spawn(tsx, ['src/main.ts'], { cwd: apiDir, env, stdio: 'inherit' });
api.on('exit', (code) => {
  cleanup();
  process.exit(code ?? 1);
});
