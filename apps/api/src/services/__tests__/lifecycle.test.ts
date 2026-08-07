import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Blueprint } from '@platter/shared';
import type * as DbModule from '../../db.js';
import type * as LogBufferModule from '../../orchestration/log-buffer.js';
import type * as MockModule from '../../orchestration/mock.js';
import type { MockDriver } from '../../orchestration/mock.js';
import type * as RegistryModule from '../../orchestration/registry.js';
import type * as AllocationsModule from '../allocations.js';
import type * as LifecycleModule from '../lifecycle.js';

/**
 * These run against a real SQLite database and the in-memory driver, which is the whole
 * point of `MockDriver`: every line of lifecycle code under test here is the same line
 * that runs against Docker in production.
 *
 * The environment is set before the first dynamic import because `config.ts` freezes
 * itself at import time — a static import at the top of this file would capture the
 * developer's own data directory instead of a throwaway one.
 */

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const NODE_ID = 'nod_01TESTNODE00000000000000';
const OWNER_ID = 'usr_01TESTOWNER00000000000000';
const SERVER_ID = 'srv_01TESTSERVER0000000000000';

let lifecycle: typeof LifecycleModule;
let allocations: typeof AllocationsModule;
let registry: typeof RegistryModule;
let logBuffer: typeof LogBufferModule;
let db: typeof DbModule;
let mock: typeof MockModule;
let workspace: string;

const blueprint: Blueprint = {
  key: 'test-game',
  name: 'Test Game',
  game: 'Test',
  summary: '',
  description: '',
  category: 'sandbox',
  image: 'platter/test-game:1',
  icon: { monogram: 'TG', hue: 210 },
  minMemoryMb: 512,
  recommendedMemoryMb: 1024,
  minDiskMb: 512,
  ports: [{ name: 'game', label: 'Game', containerPort: 25565, protocol: 'tcp', primary: true }],
  variables: [
    {
      key: 'MOTD',
      label: 'Message of the day',
      description: '',
      type: 'string',
      default: 'A Platter server',
      required: false,
      options: [],
      min: null,
      max: null,
      pattern: null,
      hidden: false,
      advanced: false,
    },
  ],
  files: [
    {
      path: 'server.properties',
      template: 'motd={{MOTD}}\nserver-port={{SERVER_PORT}}\n',
      format: 'properties',
      overwrite: false,
    },
  ],
  signals: { ready: ['Done \\('], crash: ['\\bFATAL\\b'], playerJoin: [], playerLeave: [] },
  command: null,
  stop: { strategy: 'command', command: 'stop', signal: 'SIGTERM', timeoutSeconds: 30 },
  dataPath: '/data',
  features: { console: true, rcon: false, mods: false, worldUpload: true, playerList: false },
  docsUrl: null,
};

async function waitFor(predicate: () => Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function statusOf(serverId = SERVER_ID): Promise<string> {
  const server = await db.prisma.server.findUnique({ where: { id: serverId } });
  return server?.status ?? 'gone';
}

async function driver(): Promise<MockDriver> {
  const resolved = await registry.getDriver(NODE_ID);
  if (!mock.isMockDriver(resolved)) throw new Error('expected the mock driver');
  return resolved;
}

/** Runs the boot far enough for the blueprint's ready pattern to appear. */
async function bootToRunning(serverId = SERVER_ID): Promise<void> {
  (await driver()).advance(5000);
  await waitFor(async () => (await statusOf(serverId)) === 'running', 'the server to report running');
}

async function seedServer(overrides: Record<string, unknown> = {}): Promise<void> {
  await db.prisma.server.create({
    data: {
      id: SERVER_ID,
      name: 'Survival SMP',
      blueprintKey: blueprint.key,
      nodeId: NODE_ID,
      ownerId: OWNER_ID,
      status: 'provisioning',
      memoryMb: 1024,
      diskMb: 5120,
      cpuCores: 2,
      ...overrides,
    },
  });
}

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'platter-lifecycle-'));
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = `file:${path.join(workspace, 'platter.db')}`;
  process.env.DATA_DIR = path.join(workspace, 'data');
  process.env.BACKUP_DIR = path.join(workspace, 'backups');
  process.env.JWT_SECRET = 'lifecycle-tests-need-a-long-enough-secret';

  await execFileAsync(
    path.join(API_ROOT, 'node_modules/.bin/prisma'),
    ['db', 'push', '--schema=prisma/schema.prisma', '--skip-generate', '--accept-data-loss'],
    { cwd: API_ROOT, env: process.env },
  );

  db = await import('../../db.js');
  mock = await import('../../orchestration/mock.js');
  registry = await import('../../orchestration/registry.js');
  logBuffer = await import('../../orchestration/log-buffer.js');
  allocations = await import('../allocations.js');
  lifecycle = await import('../lifecycle.js');

  lifecycle.setBlueprintResolver(async (key) => (key === blueprint.key ? blueprint : null));
}, 60_000);

afterAll(async () => {
  await db.prisma.$disconnect();
  await rm(workspace, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.prisma.allocation.deleteMany();
  await db.prisma.server.deleteMany();
  await db.prisma.node.deleteMany();
  await db.prisma.user.deleteMany();
  await db.prisma.auditLog.deleteMany();
  registry.resetDrivers();
  logBuffer.resetLogHubs();

  await db.prisma.user.create({
    data: {
      id: OWNER_ID,
      email: 'owner@example.com',
      username: 'owner',
      displayName: 'Owner',
      passwordHash: 'not-a-real-hash',
      role: 'owner',
    },
  });
  await db.prisma.node.create({
    data: {
      id: NODE_ID,
      name: 'local',
      driver: 'mock',
      endpoint: 'mock://local',
      publicHost: '127.0.0.1',
      portRangeStart: 25565,
      portRangeEnd: 25570,
      memoryTotalMb: 16_384,
      diskTotalMb: 512_000,
      cpuCores: 8,
    },
  });
});

afterEach(() => {
  lifecycle.stopCrashSupervisor();
  logBuffer.resetLogHubs();
  registry.resetDrivers();
});

describe('install and run', () => {
  it('installs, renders blueprint files and leaves the server offline', async () => {
    await seedServer();
    await lifecycle.installServer(SERVER_ID);

    const server = await db.prisma.server.findUniqueOrThrow({ where: { id: SERVER_ID } });
    expect(server.status).toBe('offline');
    expect(server.installedAt).not.toBeNull();
    expect(server.containerId).not.toBeNull();

    const rendered = await readFile(
      path.join(workspace, 'data', 'servers', SERVER_ID, 'server.properties'),
      'utf8',
    );
    expect(rendered).toContain('motd=A Platter server');
    expect(rendered).toContain('server-port=25565');

    expect((await (await driver()).inspect(SERVER_ID)).exists).toBe(true);
  });

  it('is resumable: a second install over an interrupted one succeeds', async () => {
    await seedServer({ status: 'installing' });
    await lifecycle.installServer(SERVER_ID);
    expect(await statusOf()).toBe('offline');
  });

  it('marks the server install_failed when the image cannot be pulled', async () => {
    await seedServer();
    (await driver()).failNext('pullImage');
    await expect(lifecycle.installServer(SERVER_ID)).rejects.toMatchObject({ code: 'driver_error' });
    expect(await statusOf()).toBe('install_failed');
    expect(logBuffer.getLogHub(SERVER_ID).backlog().some((line) => line.content.includes('Install failed'))).toBe(true);
  });

  it('runs the full power cycle and stops with the blueprint command', async () => {
    await seedServer();
    await lifecycle.installServer(SERVER_ID);

    await lifecycle.startServer(SERVER_ID, OWNER_ID);
    expect(await statusOf()).toBe('starting');
    await bootToRunning();

    const running = await driver();
    expect((await running.inspect(SERVER_ID)).running).toBe(true);

    await lifecycle.sendCommand(SERVER_ID, 'say hello', OWNER_ID);
    expect(running.stdinWrites.at(-1)).toEqual({ serverId: SERVER_ID, line: 'say hello' });

    await lifecycle.stopServer(SERVER_ID, OWNER_ID);
    expect(await statusOf()).toBe('offline');
    // `stop.strategy` is `command`, so the graceful path talks to stdin before signalling.
    expect(running.stdinWrites.map((write) => write.line)).toContain('stop');

    const audits = await db.prisma.auditLog.findMany({ where: { action: 'server.power' } });
    expect(audits).toHaveLength(2);
  });

  it('recreates a container that vanished underneath us', async () => {
    await seedServer();
    await lifecycle.installServer(SERVER_ID);
    await (await driver()).remove(SERVER_ID);

    await lifecycle.startServer(SERVER_ID, OWNER_ID);
    expect((await (await driver()).inspect(SERVER_ID)).running).toBe(true);
  });

  it('deletes the container, the ports and the data directory', async () => {
    await seedServer();
    const reserved = await allocations.allocatePorts(NODE_ID, {}, blueprint.ports);
    await allocations.claimAllocations(SERVER_ID, reserved);
    await lifecycle.installServer(SERVER_ID);

    await lifecycle.deleteServer(SERVER_ID, OWNER_ID);

    expect(await db.prisma.server.findUnique({ where: { id: SERVER_ID } })).toBeNull();
    expect(await db.prisma.allocation.count({ where: { serverId: SERVER_ID } })).toBe(0);
    expect(await db.prisma.allocation.count()).toBe(1);
    await expect(stat(path.join(workspace, 'data', 'servers', SERVER_ID))).rejects.toThrow();
    expect((await (await driver()).inspect(SERVER_ID)).exists).toBe(false);
  });
});

describe('transition guards', () => {
  it('refuses a start while the server is still provisioning', async () => {
    await seedServer();
    await expect(lifecycle.startServer(SERVER_ID, OWNER_ID)).rejects.toMatchObject({
      code: 'invalid_state',
    });
  });

  it('names the current status when it refuses', async () => {
    await seedServer({ status: 'install_failed', installedAt: new Date() });
    await expect(lifecycle.startServer(SERVER_ID, OWNER_ID)).rejects.toThrow(/install failed/);
  });

  it('refuses a stop on a server that is already offline', async () => {
    await seedServer({ status: 'offline', installedAt: new Date() });
    await expect(lifecycle.stopServer(SERVER_ID, OWNER_ID)).rejects.toMatchObject({
      code: 'invalid_state',
    });
  });

  it('refuses every power action on a suspended server', async () => {
    await seedServer({ status: 'suspended', installedAt: new Date() });
    for (const action of ['start', 'stop', 'restart', 'kill'] as const) {
      await expect(lifecycle.performPowerAction(SERVER_ID, action, OWNER_ID)).rejects.toMatchObject({
        code: 'invalid_state',
      });
    }
  });

  it('refuses console commands unless the server is up', async () => {
    await seedServer({ status: 'offline', installedAt: new Date() });
    await expect(lifecycle.sendCommand(SERVER_ID, 'stop', OWNER_ID)).rejects.toMatchObject({
      code: 'invalid_state',
    });
  });
});

describe('crash supervision', () => {
  async function installAndRun(): Promise<void> {
    await seedServer();
    await lifecycle.installServer(SERVER_ID);
    await lifecycle.startServer(SERVER_ID, OWNER_ID);
    await bootToRunning();
  }

  it('marks an unexpected exit as crashed and schedules a restart', async () => {
    await installAndRun();
    (await driver()).crash(SERVER_ID, { exitCode: 1 });

    await lifecycle.runCrashSupervisorPass();

    const server = await db.prisma.server.findUniqueOrThrow({ where: { id: SERVER_ID } });
    expect(server.status).toBe('crashed');
    expect(server.lastExitCode).toBe(1);
    expect(server.lastCrashAt).not.toBeNull();
    expect(
      logBuffer.getLogHub(SERVER_ID).backlog().some((line) => line.content.includes('Restarting automatically')),
    ).toBe(true);
  });

  it('gives up after three crashes inside the window', async () => {
    await installAndRun();

    for (let crash = 0; crash < 3; crash += 1) {
      (await driver()).crash(SERVER_ID, { exitCode: 1 });
      await lifecycle.runCrashSupervisorPass();
      expect(await statusOf()).toBe('crashed');
      if (crash < 2) {
        // Stand in for the scheduled restart, without waiting out its backoff.
        await lifecycle.startServer(SERVER_ID, null);
        await bootToRunning();
      }
    }

    const console = logBuffer.getLogHub(SERVER_ID).backlog();
    expect(console.some((line) => line.content.includes('automatic restarts stopped'))).toBe(true);
    expect(await statusOf()).toBe('crashed');
  });

  it('does not fight a user-initiated stop', async () => {
    await installAndRun();
    await lifecycle.stopServer(SERVER_ID, OWNER_ID);

    await lifecycle.runCrashSupervisorPass();

    expect(await statusOf()).toBe('offline');
    const console = logBuffer.getLogHub(SERVER_ID).backlog();
    expect(console.some((line) => line.content.includes('crashed'))).toBe(false);
  });

  it('leaves a server alone when auto-restart is off', async () => {
    await seedServer({ autoRestart: false });
    await lifecycle.installServer(SERVER_ID);
    await lifecycle.startServer(SERVER_ID, OWNER_ID);
    await bootToRunning();

    (await driver()).crash(SERVER_ID, { exitCode: 9 });
    await lifecycle.runCrashSupervisorPass();

    expect(await statusOf()).toBe('crashed');
    expect(
      logBuffer.getLogHub(SERVER_ID).backlog().some((line) => line.content.includes('Restarting automatically')),
    ).toBe(false);
  });
});

describe('reconcile', () => {
  it('corrects a status that drifted while Platter was down', async () => {
    await seedServer({ status: 'running', installedAt: new Date(), autoStart: false });
    await lifecycle.reconcile();
    expect(await statusOf()).toBe('offline');
  });

  it('fails an install that a restart interrupted', async () => {
    await seedServer({ status: 'installing' });
    await lifecycle.reconcile();
    expect(await statusOf()).toBe('install_failed');
  });

  it('starts an auto-start server that is offline', async () => {
    await seedServer();
    await lifecycle.installServer(SERVER_ID);
    await lifecycle.reconcile();
    expect(['starting', 'running']).toContain(await statusOf());
  });
});

describe('port allocation', () => {
  const ports = blueprint.ports;

  it('prefers the container port and then walks the range', async () => {
    await seedServer();
    const first = await allocations.allocatePorts(NODE_ID, {}, ports);
    expect(first[0]?.hostPort).toBe(25565);
    await allocations.claimAllocations(SERVER_ID, first);

    const other = 'srv_01TESTSERVER0000000000001';
    await seedServerWithId(other);
    const second = await allocations.allocatePorts(NODE_ID, {}, ports);
    expect(second[0]?.hostPort).not.toBe(25565);
    await allocations.claimAllocations(other, second);
    expect(await allocations.listAllocations(NODE_ID)).toHaveLength(2);
  });

  it('lets exactly one of two racing claims win the same reservation', async () => {
    await db.prisma.node.update({
      where: { id: NODE_ID },
      data: { portRangeStart: 25565, portRangeEnd: 25565 },
    });
    await seedServer();
    const other = 'srv_01TESTSERVER0000000000001';
    await seedServerWithId(other);

    // Both reservations legitimately return the same free row — that is what the claim
    // step exists to arbitrate.
    const [mine, theirs] = await Promise.all([
      allocations.allocatePorts(NODE_ID, {}, ports),
      allocations.allocatePorts(NODE_ID, {}, ports),
    ]);
    expect(mine[0]?.id).toBe(theirs[0]?.id);

    await allocations.claimAllocations(SERVER_ID, mine);
    await expect(allocations.claimAllocations(other, theirs)).rejects.toMatchObject({
      code: 'no_allocation_available',
    });
  });

  it('reports an exhausted range instead of handing out a duplicate', async () => {
    await db.prisma.node.update({
      where: { id: NODE_ID },
      data: { portRangeStart: 25565, portRangeEnd: 25565 },
    });
    await seedServer();
    const claimed = await allocations.allocatePorts(NODE_ID, {}, ports);
    await allocations.claimAllocations(SERVER_ID, claimed);

    await expect(allocations.allocatePorts(NODE_ID, {}, ports)).rejects.toMatchObject({
      code: 'no_allocation_available',
    });
  });

  it('honours an explicit port and rejects one already taken', async () => {
    await seedServer();
    const claimed = await allocations.allocatePorts(NODE_ID, { game: 25570 }, ports);
    expect(claimed[0]?.hostPort).toBe(25570);
    await allocations.claimAllocations(SERVER_ID, claimed);

    await expect(allocations.allocatePorts(NODE_ID, { game: 25570 }, ports)).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(allocations.allocatePorts(NODE_ID, { game: 80 }, ports)).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(allocations.allocatePorts(NODE_ID, { nope: 25566 }, ports)).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('returns released ports to the pool', async () => {
    await seedServer();
    const claimed = await allocations.allocatePorts(NODE_ID, {}, ports);
    await allocations.claimAllocations(SERVER_ID, claimed);
    expect(await allocations.releasePorts(SERVER_ID)).toBe(1);

    const again = await allocations.allocatePorts(NODE_ID, {}, ports);
    expect(again[0]?.hostPort).toBe(25565);
    expect(await allocations.listAllocations(NODE_ID)).toHaveLength(1);
  });
});

async function seedServerWithId(serverId: string): Promise<void> {
  await db.prisma.server.create({
    data: {
      id: serverId,
      name: 'Second server',
      blueprintKey: blueprint.key,
      nodeId: NODE_ID,
      ownerId: OWNER_ID,
      status: 'provisioning',
      memoryMb: 1024,
      diskMb: 5120,
      cpuCores: 2,
    },
  });
}
