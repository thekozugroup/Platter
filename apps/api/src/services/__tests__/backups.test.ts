import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatterError, blueprintSchema, type Blueprint } from '@platter/shared';
import type * as Blueprints from '../blueprints.js';

/**
 * Backups, against the real filesystem and the mock driver.
 *
 * Three round-three findings live here, and they are all the same shape — a claim made
 * about one thing standing in for a claim about another:
 *
 *  - the `ignore` glob compiled to a backtracking regular expression, so an attacker-chosen
 *    pattern halted the whole process;
 *  - deleting a server dropped its `Backup` rows by cascade and left the archives on disk
 *    with nothing able to find them again;
 *  - a restore claimed the *backup* row and nothing on the *server*, so a start was free to
 *    boot the game onto a directory being emptied and repopulated underneath it.
 */

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workdir = await mkdtemp(path.join(tmpdir(), 'platter-backups-'));
const dataDir = path.join(workdir, 'data');
const backupDir = path.join(workdir, 'backups');

process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] = `file:${path.join(workdir, 'test.db')}`;
process.env['DATA_DIR'] = dataDir;
process.env['BACKUP_DIR'] = backupDir;
process.env['DEFAULT_NODE_DRIVER'] = 'mock';
process.env['JWT_SECRET'] = 'test-secret-that-is-long-enough-to-pass';

execFileSync(path.join(apiRoot, 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
  cwd: apiRoot,
  env: process.env,
  stdio: 'ignore',
});

const catalogue = vi.hoisted(() => new Map<string, unknown>());

vi.mock('../blueprints.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Blueprints>();
  return {
    ...actual,
    getBlueprint: (key: string): unknown => catalogue.get(key) ?? actual.getBlueprint(key),
  };
});

const { prisma } = await import('../../db.js');
const { resetDrivers } = await import('../../orchestration/registry.js');
const { resetLogHubs } = await import('../../orchestration/log-buffer.js');
const { serverBackupDir, serverDataDir } = await import('../../lib/paths.js');
const backups = await import('../backups.js');
const lifecycle = await import('../lifecycle.js');

const NODE_ID = 'nod_test';
const OWNER_ID = 'usr_test';
const SERVER_ID = 'srv_test';

const BLUEPRINT: Blueprint = blueprintSchema.parse({
  key: 'test-game',
  name: 'Test Game',
  game: 'Test',
  image: 'example/test:1',
  icon: { monogram: 'TG', hue: 200 },
  minMemoryMb: 512,
  recommendedMemoryMb: 1024,
  minDiskMb: 512,
  ports: [{ name: 'game', label: 'Game', containerPort: 25565, protocol: 'tcp', primary: true }],
  variables: [],
  files: [],
  stop: { strategy: 'signal', signal: 'SIGTERM', timeoutSeconds: 5 },
});
catalogue.set(BLUEPRINT.key, BLUEPRINT);

async function seedServer(status = 'offline'): Promise<string> {
  await prisma.node.upsert({
    where: { id: NODE_ID },
    update: {},
    create: {
      id: NODE_ID,
      name: 'test',
      driver: 'mock',
      endpoint: 'mock://local',
      publicHost: '127.0.0.1',
      portRangeStart: 25000,
      portRangeEnd: 25999,
      memoryTotalMb: 65_536,
      diskTotalMb: 1_048_576,
      cpuCores: 8,
    },
  });
  await prisma.user.upsert({
    where: { id: OWNER_ID },
    update: {},
    create: {
      id: OWNER_ID,
      email: 'owner@example.test',
      username: 'owner',
      displayName: 'Owner',
      passwordHash: 'x',
      role: 'owner',
      avatarColor: '#000000',
    },
  });
  await prisma.server.create({
    data: {
      id: SERVER_ID,
      name: 'Test Server',
      blueprintKey: BLUEPRINT.key,
      nodeId: NODE_ID,
      ownerId: OWNER_ID,
      status,
      memoryMb: 1024,
      diskMb: 2048,
      cpuCores: 0,
      variables: '{}',
      autoStart: false,
      autoRestart: false,
      installedAt: new Date(),
    },
  });
  await prisma.allocation.create({
    data: {
      id: `alc_${SERVER_ID}`,
      nodeId: NODE_ID,
      hostIp: '0.0.0.0',
      hostPort: 25000,
      protocol: 'tcp',
      serverId: SERVER_ID,
      portName: 'game',
      primary: true,
    },
  });

  const dir = serverDataDir(SERVER_ID);
  await mkdir(path.join(dir, 'world'), { recursive: true });
  await writeFile(path.join(dir, 'world', 'level.dat'), 'a world');
  await writeFile(path.join(dir, 'server.log'), 'a log');
  return SERVER_ID;
}

/** Polls until the row leaves `pending`/`running`; the archive is built off-request. */
async function settle(backupId: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await prisma.backup.findUnique({ where: { id: backupId } });
    if (row && row.status !== 'pending' && row.status !== 'running') return row.status;
    if (Date.now() > deadline) throw new Error(`backup ${backupId} never settled`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(async () => {
  resetDrivers();
  resetLogHubs();
});

afterEach(async () => {
  for (const table of ['backup', 'allocation', 'server', 'user', 'node'] as const) {
    await (prisma[table] as { deleteMany: () => Promise<unknown> }).deleteMany();
  }
  // Every test reuses `SERVER_ID`, so the directories have to go too or one test's archives
  // are counted by the next one's assertions.
  await rm(dataDir, { recursive: true, force: true });
  await rm(backupDir, { recursive: true, force: true });
});

/** A promise the test resolves by hand, for holding a lock open at a chosen moment. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

const tick = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// =======================================================================================

describe('the ignore glob', () => {
  const match = (pattern: string, subject: string): boolean =>
    backups.compileIgnoreMatcher([pattern])(subject);

  it('still matches what a minimal glob is supposed to match', () => {
    expect(match('*.log', 'server.log')).toBe(true);
    expect(match('*.log', 'logs/server.log')).toBe(true); // basename-only: no `/` in the pattern
    expect(match('*.log', 'server.txt')).toBe(false);
    expect(match('cache/**', 'cache/a/b/c.tmp')).toBe(true);
    expect(match('cache/**', 'other/a.tmp')).toBe(false);
    expect(match('cache/*', 'cache/a/b')).toBe(false); // a single star does not cross `/`
    expect(match('level.?at', 'level.dat')).toBe(true);
    expect(match('level.?at', 'level.at')).toBe(false);
    expect(match('a+b.txt', 'a+b.txt')).toBe(true); // regex metacharacters stay literal
    expect(match('a+b.txt', 'aab.txt')).toBe(false);
    expect(match('', 'anything')).toBe(false);
  });

  it('ignores nothing when the list is empty, and everything named in it when it is not', () => {
    expect(backups.compileIgnoreMatcher([])('server.log')).toBe(false);
    const matcher = backups.compileIgnoreMatcher(['*.log', 'cache/**']);
    expect(matcher('./server.log')).toBe(true);
    expect(matcher('./cache/x')).toBe(true);
    expect(matcher('./world/level.dat')).toBe(false);
  });

  /**
   * The finding. `**` compiled to `.*`, so `**a**a**a…` became `^.*a.*a.*a…$` — measured at
   * roughly 7x per added repetition, and the schema allows 50 patterns of 200 characters.
   * The match runs synchronously inside tar's `filter`, so the whole event loop stopped:
   * HTTP, every console socket, the scheduler and the crash supervisor with it.
   *
   * The budget is deliberately loose. On the old compiler this exact input does not finish
   * in any amount of time anyone would wait for; a linear matcher does it in under a
   * millisecond, so anything in this range separates them without being flaky.
   */
  it('cannot be made to backtrack by a pattern of any legal length', () => {
    const pattern = `${'**a'.repeat(66)}/z`; // 199 characters, inside the 200-char cap
    expect(pattern.length).toBeLessThanOrEqual(200);
    const subject = `${'a'.repeat(200)}.dat`;
    const matcher = backups.compileIgnoreMatcher([pattern]);

    const started = process.hrtime.bigint();
    expect(matcher(subject)).toBe(false);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(250);
  });

  it('stays linear against the full 50-pattern list', () => {
    const patterns = Array.from({ length: 50 }, () => `${'**a'.repeat(66)}/z`);
    const matcher = backups.compileIgnoreMatcher(patterns);
    const started = process.hrtime.bigint();
    for (let i = 0; i < 20; i += 1) matcher(`${'a'.repeat(200)}.dat`);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(1000);
  });
});

// =======================================================================================

describe('creating a backup', () => {
  it('writes an archive and honours the ignore list', async () => {
    await seedServer();
    const row = await backups.createBackup(SERVER_ID, { ignore: ['*.log'] });
    expect(await settle(row.id)).toBe('completed');

    const completed = await prisma.backup.findUniqueOrThrow({ where: { id: row.id } });
    expect(completed.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(completed.sizeBytes)).toBeGreaterThan(0);
    expect(await readdir(serverBackupDir(SERVER_ID))).toEqual([`${row.id}.tar.gz`]);
  });

  /**
   * Retention only ever rotated *automatic* backups, so `backups.create` was an unbounded
   * write primitive against the node's disk. This is not retention — it deletes nothing —
   * it is the point at which Platter refuses and asks the operator to choose.
   */
  it('refuses past the per-server ceiling instead of filling the disk', async () => {
    await seedServer();
    const rows = await prisma.backup.createMany({
      data: Array.from({ length: 50 }, (_, index) => ({
        id: `bak_ceiling_${String(index).padStart(3, '0')}`,
        serverId: SERVER_ID,
        name: `manual ${index}`,
        status: 'completed',
        automatic: false,
        locked: false,
      })),
    });
    expect(rows.count).toBe(50);

    const error = await backups
      .createBackup(SERVER_ID)
      .then(() => null)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PlatterError);
    expect((error as PlatterError).code).toBe('conflict');
    expect(await prisma.backup.count({ where: { serverId: SERVER_ID } })).toBe(50);
  });
});

// =======================================================================================

describe('deleting a server', () => {
  /**
   * `Backup` rows cascade off the server's foreign key, so the database forgets the
   * archives exist. Nothing in the product could then find or reclaim them: unbounded disk
   * growth, and a retention failure — an archive holds the world and the rendered blueprint
   * files, which for Minecraft means `server.properties` with the RCON password in the clear.
   */
  it('takes the backup archives with it', async () => {
    await seedServer();
    const row = await backups.createBackup(SERVER_ID);
    expect(await settle(row.id)).toBe('completed');
    expect(await readdir(serverBackupDir(SERVER_ID))).toHaveLength(1);

    await lifecycle.deleteServer(SERVER_ID);

    await expect(readdir(serverBackupDir(SERVER_ID))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(serverDataDir(SERVER_ID))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await prisma.backup.count()).toBe(0);
  });

  it('still deletes cleanly for a server that never had a backup', async () => {
    await seedServer();
    await expect(lifecycle.deleteServer(SERVER_ID)).resolves.toBeUndefined();
    expect(await prisma.server.count()).toBe(0);
  });
});

// =======================================================================================

describe('restoring a backup', () => {
  it('puts the archived files back', async () => {
    await seedServer();
    const row = await backups.createBackup(SERVER_ID);
    expect(await settle(row.id)).toBe('completed');

    await writeFile(path.join(serverDataDir(SERVER_ID), 'world', 'level.dat'), 'corrupted');
    await backups.restoreBackup(row.id, { truncate: true });

    const restored = await readdir(path.join(serverDataDir(SERVER_ID), 'world'));
    expect(restored).toContain('level.dat');
  });

  /**
   * The finding: `restoreBackup` claimed the *backup* row atomically and took nothing at all
   * on the *server*, while `offline: ['start']` makes a concurrent start perfectly legal.
   * On a real world — minutes of extraction rather than milliseconds — a scheduled start,
   * the crash supervisor's auto-restart or a second operator boots the game onto a directory
   * that has just been emptied and is still being repopulated.
   *
   * Driven from the lock's own side rather than by racing two calls: holding the server lock
   * is exactly what a start, a restart or the crash supervisor does, and it is the only way
   * to pin the window deterministically. Before the fix the restore ignored the lock entirely
   * and emptied the directory while it was held, which is what the middle assertion catches.
   */
  it('waits for the server lock before it touches the data directory', async () => {
    await seedServer();
    const row = await backups.createBackup(SERVER_ID);
    expect(await settle(row.id)).toBe('completed');

    const held = gate();
    const holder = lifecycle.withServerLock(SERVER_ID, () => held.promise);

    let settled = false;
    const restore = backups.restoreBackup(row.id, { truncate: true }).then((result) => {
      settled = true;
      return result;
    });
    await tick();

    // The lock is still held, so the restore may not have finished — and nothing may have
    // been removed yet either. Without the lock both of these are already false by now.
    expect(settled).toBe(false);
    expect(await readdir(serverDataDir(SERVER_ID))).toEqual(
      expect.arrayContaining(['server.log', 'world']),
    );

    held.open();
    await holder;
    await expect(restore).resolves.toMatchObject({ stoppedServer: false });
    expect(await readdir(path.join(serverDataDir(SERVER_ID), 'world'))).toContain('level.dat');
  });

  it('makes a backup wait for the same lock, so it cannot archive a half-restored world', async () => {
    await seedServer();

    const held = gate();
    const holder = lifecycle.withServerLock(SERVER_ID, () => held.promise);

    const row = await backups.createBackup(SERVER_ID);
    await tick();

    // The row exists and is `running`, but the lock has stopped tar before it read a byte.
    const midway = await prisma.backup.findUniqueOrThrow({ where: { id: row.id } });
    expect(midway.status).toBe('running');
    expect(await readdir(serverBackupDir(SERVER_ID)).catch(() => [])).toEqual([]);

    held.open();
    await holder;
    expect(await settle(row.id)).toBe('completed');
    expect(await readdir(serverBackupDir(SERVER_ID))).toEqual([`${row.id}.tar.gz`]);
  });
});
