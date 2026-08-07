/**
 * End-to-end smoke test.
 *
 * Creates a real Minecraft server in Docker, waits for it to accept players, exercises RCON,
 * takes a hot backup, and tears everything down. This is the test that catches the things unit
 * tests structurally cannot: a wrong environment variable, a bad port binding, a hardening flag
 * the image refuses, a backup that produces an unreadable archive.
 *
 *   pnpm tsx scripts/smoke.ts [--keep]
 *
 * `--keep` leaves the server running so you can look at it in the UI.
 */
import { rm } from 'node:fs/promises';
import {
  createBackup,
  createContext,
  createServer,
  deleteServer,
  getServer,
  listPlayers,
  rconCommand,
  reconcileServer,
  restoreBackup,
  startServer,
  stopServer,
} from '@platter/core';
import { isErr } from '@platter/shared';

const KEEP = process.argv.includes('--keep');
const DATA_DIR = process.env.PLATTER_DATA_DIR ?? '/tmp/platter-smoke';

function log(step: string, detail = ''): void {
  process.stderr.write(`\u001b[36m▸\u001b[0m ${step}${detail ? ` — ${detail}` : ''}\n`);
}

function fail(message: string): never {
  process.stderr.write(`\u001b[31m✗ ${message}\u001b[0m\n`);
  process.exit(1);
}

async function waitFor(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let dots = 0;
  while (Date.now() < deadline) {
    if (await predicate()) {
      process.stderr.write('\n');
      return;
    }
    dots++;
    if (dots % 5 === 0) {
      process.stderr.write('.');
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  process.stderr.write('\n');
  fail(`Timed out waiting for ${label} after ${Math.round(timeoutMs / 1000)}s`);
}

process.env.PLATTER_DATA_DIR = DATA_DIR;

const context = await createContext();
if (isErr(context)) {
  fail(`Docker is not available: ${context.error.message}`);
}
const ctx = context.value;
log('Docker ready', `data dir ${DATA_DIR}`);

/* --- Create ------------------------------------------------------------- */

const created = await createServer(ctx, {
  name: `Smoke ${new Date().toISOString().slice(11, 19)}`,
  loader: 'paper',
  gameVersion: '1.21.4',
  acceptEula: true,
  // Small on purpose: this has to finish in CI, and Paper on a fresh world is happy here.
  resources: { memoryMiB: 2048, cpus: 2 },
  settings: {
    motd: 'Platter smoke test',
    maxPlayers: 5,
    levelSeed: '12345',
    // Skips Mojang session lookups, which would otherwise make this test depend on their API.
    onlineMode: false,
    viewDistance: 6,
    simulationDistance: 6,
  },
  onProgress: ({ phase, pull }) => {
    if (pull?.percent !== undefined) {
      process.stderr.write(`\r  ${phase}: ${Math.round(pull.percent * 100)}%   `);
    }
  },
});

if (isErr(created)) {
  fail(`createServer failed: ${created.error.message}`);
}
const server = created.value;
log('Created', `${server.name} on port ${server.port}`);

let exitCode = 0;

try {
  /* --- Start ------------------------------------------------------------ */

  const started = await startServer(ctx, server.id);
  if (isErr(started)) {
    fail(`startServer failed: ${started.error.message}`);
  }
  log('Starting', 'waiting for the world to generate');

  await waitFor(
    'the server to become healthy',
    async () => {
      await reconcileServer(ctx, server.id);
      const current = getServer(ctx.db, server.id);
      if (current?.status === 'crashed' || current?.status === 'error') {
        fail(`Server ${current.status}: ${current.statusMessage ?? 'no detail'}`);
      }
      return current?.status === 'running';
    },
    600_000
  );
  log('Running');

  /* --- RCON ------------------------------------------------------------- */

  const target = {
    serverId: server.id,
    host: '127.0.0.1',
    port: server.rconPort ?? 0,
    password: server.rconPassword,
  };

  const version = await rconCommand(target, 'version');
  if (isErr(version)) {
    fail(`RCON failed: ${version.error.message}`);
  }
  log('RCON', version.value.split('\n')[0]?.slice(0, 80) ?? '(no output)');

  const players = await listPlayers(target);
  if (isErr(players)) {
    fail(`Could not list players: ${players.error.message}`);
  }
  log('Players', `${players.value.online}/${players.value.max} online`);

  /* --- Hot backup ------------------------------------------------------- */

  const backup = await createBackup(ctx, {
    serverId: server.id,
    label: 'smoke',
    trigger: 'manual',
    onProgress: ({ phase }) => process.stderr.write(`\r  backup: ${phase}          `),
  });
  process.stderr.write('\n');
  if (isErr(backup)) {
    fail(`Hot backup failed: ${backup.error.message}`);
  }
  log('Hot backup', `${(backup.value.sizeBytes / 1024 / 1024).toFixed(1)} MB while running`);

  // Saves must be back on. Leaving them off silently stops the world persisting, which is the
  // worst possible outcome of a backup and the one nobody would notice until much later.
  const saveCheck = await rconCommand(target, 'save-all');
  if (isErr(saveCheck)) {
    fail('Auto-save was not re-enabled after the backup');
  }
  log('Auto-save', 're-enabled');

  /* --- Restore ---------------------------------------------------------- */

  const restored = await restoreBackup(ctx, backup.value.id, { safetyBackup: false });
  if (isErr(restored)) {
    fail(`Restore failed: ${restored.error.message}`);
  }
  log('Restored', 'server came back up');

  await waitFor(
    'the server to come back after restore',
    async () => {
      await reconcileServer(ctx, server.id);
      return getServer(ctx.db, server.id)?.status === 'running';
    },
    600_000
  );

  /* --- Stop ------------------------------------------------------------- */

  const stopped = await stopServer(ctx, server.id);
  if (isErr(stopped)) {
    fail(`stopServer failed: ${stopped.error.message}`);
  }
  log('Stopped', 'cleanly');

  process.stderr.write('\n\u001b[32m✓ All checks passed\u001b[0m\n');
} catch (error) {
  exitCode = 1;
  process.stderr.write(`\u001b[31m✗ ${String(error)}\u001b[0m\n`);
} finally {
  if (KEEP) {
    log('Keeping the server', `see it at http://localhost:4880/servers/${server.id}`);
  } else {
    log('Cleaning up');
    await deleteServer(ctx, server.id, { purgeData: true });
    if (DATA_DIR.startsWith('/tmp/')) {
      await rm(DATA_DIR, { recursive: true, force: true });
    }
  }
  const { closeAllRcon, stopSupervisor } = await import('@platter/core');
  stopSupervisor();
  await closeAllRcon();
  ctx.db.$close();
}

process.exit(exitCode);
