import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatterError, blueprintSchema, type Blueprint } from '@platter/shared';
// Type-only, so these are erased: the modules themselves are imported after the
// environment is configured, further down.
import type { MockDriver } from '../../orchestration/mock.js';
import type * as Blueprints from '../blueprints.js';

/**
 * The state machine, end to end, against `MockDriver`.
 *
 * These are not unit tests around a stub: the driver simulates real container state, the
 * database is a real SQLite file with the shipped schema, and the log hub is the same one
 * the console socket uses. The only thing that is faked is the blueprint catalogue, which
 * belongs to another module.
 */

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workdir = await mkdtemp(path.join(tmpdir(), 'platter-lifecycle-'));
const dataDir = path.join(workdir, 'data');

process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] = `file:${path.join(workdir, 'test.db')}`;
process.env['DATA_DIR'] = dataDir;
process.env['DEFAULT_NODE_DRIVER'] = 'mock';
process.env['JWT_SECRET'] = 'test-secret-that-is-long-enough-to-pass';

execFileSync(path.join(apiRoot, 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
  cwd: apiRoot,
  env: process.env,
  stdio: 'ignore',
});

const catalogue = vi.hoisted(() => new Map<string, unknown>());

/**
 * Only the lookup is replaced. Environment composition and template rendering stay the
 * real implementations, because they are exactly the parts of an install worth testing.
 */
vi.mock('../blueprints.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Blueprints>();
  return {
    ...actual,
    getBlueprint: (key: string): unknown => catalogue.get(key) ?? actual.getBlueprint(key),
  };
});

// Imported after the environment is set: `config` reads it once, at module load.
const { prisma } = await import('../../db.js');
const { getDriver, resetDrivers } = await import('../../orchestration/registry.js');
const { getLogHub, resetLogHubs } = await import('../../orchestration/log-buffer.js');
const { isMockDriver } = await import('../../orchestration/mock.js');
const lifecycle = await import('../lifecycle.js');

const NODE_ID = 'nod_test';
const OWNER_ID = 'usr_test';
const SERVER_ID = 'srv_test';

/**
 * Two blueprints: one that cannot say when it is ready (so a start resolves straight to
 * `running`), and one that can (so the boot watcher has something to wait for).
 */
function makeBlueprint(overrides: Record<string, unknown> = {}): Blueprint {
  return blueprintSchema.parse({
    key: 'test-game',
    name: 'Test Game',
    game: 'Test',
    image: 'example/test:1',
    icon: { monogram: 'TG', hue: 200 },
    minMemoryMb: 512,
    recommendedMemoryMb: 1024,
    minDiskMb: 512,
    ports: [{ name: 'game', label: 'Game', containerPort: 25565, protocol: 'tcp', primary: true }],
    variables: [
      { key: 'MOTD', label: 'Message of the day', type: 'string', default: 'Hello' },
      { key: 'MAX_PLAYERS', label: 'Player slots', type: 'number', default: 20 },
      { key: 'RCON_PASSWORD', label: 'RCON password', type: 'password' },
    ],
    files: [
      {
        path: 'server.properties',
        template: 'motd={{MOTD}}\nmax-players={{MAX_PLAYERS}}\nrcon.password={{RCON_PASSWORD}}\n',
        format: 'properties',
      },
    ],
    stop: { strategy: 'signal', signal: 'SIGTERM', timeoutSeconds: 5 },
    ...overrides,
  });
}

const INSTANT = makeBlueprint();
const WATCHED = makeBlueprint({
  key: 'watched-game',
  // The line MockDriver prints once its simulated boot finishes.
  signals: { ready: ['Done \\('], crash: [], playerJoin: [], playerLeave: [] },
});
/** Declares a crash pattern, so the run watcher has something fatal to react to. */
const CRASHY = makeBlueprint({
  key: 'crashy-game',
  signals: { ready: [], crash: ['FATAL'], playerJoin: [], playerLeave: [] },
});
/**
 * Stops with a console command the mock does not honour, so `stopInternal` sits in its
 * exit poll for the full timeout. That is the window a kill has to land in.
 */
const SLOW_STOP = makeBlueprint({
  key: 'slow-stop-game',
  stop: { strategy: 'command', command: 'wind-down', signal: 'SIGTERM', timeoutSeconds: 3 },
});

catalogue.set(INSTANT.key, INSTANT);
catalogue.set(WATCHED.key, WATCHED);
catalogue.set(CRASHY.key, CRASHY);
catalogue.set(SLOW_STOP.key, SLOW_STOP);

interface SeedOptions {
  blueprintKey?: string;
  autoStart?: boolean;
  autoRestart?: boolean;
  status?: string;
  id?: string;
  /** Distinct per server: the allocation table is unique on (node, ip, port, protocol). */
  hostPort?: number;
}

async function seed(options: SeedOptions = {}): Promise<string> {
  const id = options.id ?? SERVER_ID;
  await prisma.server.create({
    data: {
      id,
      name: 'Test Server',
      blueprintKey: options.blueprintKey ?? INSTANT.key,
      nodeId: NODE_ID,
      ownerId: OWNER_ID,
      status: options.status ?? 'provisioning',
      memoryMb: 1024,
      diskMb: 2048,
      cpuCores: 0,
      variables: JSON.stringify({ MOTD: 'A test server' }),
      autoStart: options.autoStart ?? false,
      autoRestart: options.autoRestart ?? true,
    },
  });
  await prisma.allocation.create({
    data: {
      id: `alc_${id}`,
      nodeId: NODE_ID,
      hostIp: '0.0.0.0',
      hostPort: options.hostPort ?? 25000,
      protocol: 'tcp',
      serverId: id,
      portName: 'game',
      primary: true,
    },
  });
  return id;
}

async function statusOf(serverId = SERVER_ID): Promise<string> {
  const row = await prisma.server.findUnique({ where: { id: serverId } });
  return row?.status ?? 'gone';
}

async function driverFor(): Promise<MockDriver> {
  const driver = await getDriver(NODE_ID);
  if (!isMockDriver(driver)) throw new Error('expected the mock driver');
  return driver;
}

async function waitForStatus(expected: string, serverId = SERVER_ID, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await statusOf(serverId)) === expected) return;
    if (Date.now() > deadline) {
      throw new Error(`status stayed at ${await statusOf(serverId)}, expected ${expected}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function caught(promise: Promise<unknown>): Promise<PlatterError> {
  const error = await promise.then(() => null).catch((reason: unknown) => reason);
  if (!(error instanceof PlatterError)) throw new Error(`expected a PlatterError, got ${String(error)}`);
  return error;
}

beforeAll(async () => {
  await prisma.user.create({
    data: {
      id: OWNER_ID,
      email: 'owner@example.com',
      username: 'owner',
      displayName: 'Ada',
      passwordHash: 'x',
    },
  });
});

beforeEach(async () => {
  await prisma.allocation.deleteMany();
  await prisma.server.deleteMany();
  await prisma.node.deleteMany();
  await prisma.node.create({
    data: {
      id: NODE_ID,
      name: 'local',
      driver: 'mock',
      endpoint: '/var/run/docker.sock',
      publicHost: '127.0.0.1',
      portRangeStart: 25000,
      portRangeEnd: 25100,
      memoryTotalMb: 16384,
      diskTotalMb: 512000,
      cpuCores: 8,
    },
  });
});

afterEach(async () => {
  lifecycle.resetLifecycleState();
  resetLogHubs();
  resetDrivers();
  await rm(path.join(dataDir, 'servers'), { recursive: true, force: true });
});

afterAll(async () => {
  await prisma.$disconnect();
  await rm(workdir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('installServer', () => {
  it('pulls, renders the blueprint files and leaves the server offline', async () => {
    await seed();
    await lifecycle.installServer(SERVER_ID);

    const row = await prisma.server.findUnique({ where: { id: SERVER_ID } });
    expect(row?.status).toBe('offline');
    expect(row?.installedAt).not.toBeNull();
    expect(row?.containerId).toBeTruthy();

    const rendered = await readFile(
      path.join(dataDir, 'servers', SERVER_ID, 'server.properties'),
      'utf8',
    );
    expect(rendered).toContain('motd=A test server');
    // A variable the operator did not set falls back to the blueprint's default…
    expect(rendered).toContain('max-players=20');
    // …and one with no value and no default renders empty rather than as a placeholder.
    expect(rendered).toContain('rcon.password=\n');
  });

  it('starts the server afterwards when autoStart is on', async () => {
    await seed({ autoStart: true });
    await lifecycle.installServer(SERVER_ID);
    expect(await statusOf()).toBe('running');
  });

  it('is idempotent, and resumes an install that was interrupted', async () => {
    await seed();
    await lifecycle.installServer(SERVER_ID);
    const first = await prisma.server.findUnique({ where: { id: SERVER_ID } });

    // What a crash mid-install leaves behind: the row says installing, the container is
    // gone, the data directory is not.
    const driver = await driverFor();
    await driver.remove(SERVER_ID);
    await prisma.server.update({ where: { id: SERVER_ID }, data: { status: 'installing' } });

    await lifecycle.installServer(SERVER_ID);

    const second = await prisma.server.findUnique({ where: { id: SERVER_ID } });
    expect(second?.status).toBe('offline');
    expect(second?.containerId).toBeTruthy();
    expect(second?.containerId).not.toBe(first?.containerId);
    expect((await driver.inspect(SERVER_ID)).exists).toBe(true);
  });

  it('records a failed install instead of throwing it away', async () => {
    await seed();
    const driver = await driverFor();
    driver.failNext('pullImage', new PlatterError('driver_error', 'registry unreachable'));

    const error = await caught(lifecycle.installServer(SERVER_ID));
    expect(error.code).toBe('driver_error');
    expect(await statusOf()).toBe('install_failed');
  });
});

describe('power actions', () => {
  beforeEach(async () => {
    await seed();
    await lifecycle.installServer(SERVER_ID);
  });

  it('runs the full start, command, stop cycle', async () => {
    await lifecycle.startServer(SERVER_ID, OWNER_ID);
    expect(await statusOf()).toBe('running');

    const driver = await driverFor();
    await lifecycle.sendCommand(SERVER_ID, 'say hello', OWNER_ID);
    expect(driver.stdinWrites).toEqual([{ serverId: SERVER_ID, line: 'say hello' }]);

    await lifecycle.stopServer(SERVER_ID, OWNER_ID);
    const row = await prisma.server.findUnique({ where: { id: SERVER_ID } });
    expect(row?.status).toBe('offline');
    expect(row?.lastExitCode).toBe(0);
    expect(row?.startedAt).toBeNull();
    expect((await driver.inspect(SERVER_ID)).running).toBe(false);
  });

  it('rejects an action the shared table does not allow, naming the status', async () => {
    // Offline: stop, restart and kill are all illegal.
    for (const action of ['stop', 'restart', 'kill'] as const) {
      const error = await caught(lifecycle.performPowerAction(SERVER_ID, action, OWNER_ID));
      expect(error.code).toBe('invalid_state');
      expect(error.message).toContain('offline');
    }

    await lifecycle.startServer(SERVER_ID, OWNER_ID);

    const error = await caught(lifecycle.performPowerAction(SERVER_ID, 'start', OWNER_ID));
    expect(error.code).toBe('invalid_state');
    expect(error.message).toContain('running');
  });

  it('refuses console input unless the server is running', async () => {
    const error = await caught(lifecycle.sendCommand(SERVER_ID, 'say hello', OWNER_ID));
    expect(error.code).toBe('invalid_state');

    await lifecycle.startServer(SERVER_ID, OWNER_ID);
    const multiline = await caught(lifecycle.sendCommand(SERVER_ID, 'say hi\nop someone', OWNER_ID));
    expect(multiline.code).toBe('bad_request');
  });

  it('restarts a running server', async () => {
    await lifecycle.startServer(SERVER_ID, OWNER_ID);
    await lifecycle.restartServer(SERVER_ID, OWNER_ID);
    expect(await statusOf()).toBe('running');
    expect((await (await driverFor()).inspect(SERVER_ID)).running).toBe(true);
  });

  it('kills a running server without waiting for a graceful stop', async () => {
    await lifecycle.startServer(SERVER_ID, OWNER_ID);
    await lifecycle.killServer(SERVER_ID, OWNER_ID);

    const row = await prisma.server.findUnique({ where: { id: SERVER_ID } });
    expect(row?.status).toBe('offline');
    expect(row?.lastExitCode).toBe(137);
  });
});

describe('a server created without starting it', () => {
  it('installs and boots on the first start, rather than being stuck forever', async () => {
    // `startOnCreate: false` leaves the row at `provisioning` with no image, no data
    // directory and no container. Start is the only way out of it — reinstall refuses the
    // status outright — so without this the row is unrecoverable and only delete works.
    await seed({ status: 'provisioning' });

    await lifecycle.startServer(SERVER_ID, OWNER_ID);

    const row = await prisma.server.findUnique({ where: { id: SERVER_ID } });
    expect(row?.status).toBe('running');
    expect(row?.installedAt).not.toBeNull();
  });
});

describe('boot signals', () => {
  it('holds a server at starting until the blueprint ready line appears', async () => {
    await seed({ blueprintKey: WATCHED.key });
    await lifecycle.installServer(SERVER_ID);
    await lifecycle.startServer(SERVER_ID, OWNER_ID);

    expect(await statusOf()).toBe('starting');

    const driver = await driverFor();
    driver.advance(5000);
    await waitForStatus('running');
  });
});

describe('kill versus an operation already in flight', () => {
  it('does not let an interrupted restart bring the container back up', async () => {
    await seed({ blueprintKey: SLOW_STOP.key });
    await lifecycle.installServer(SERVER_ID);
    await lifecycle.startServer(SERVER_ID, OWNER_ID);
    expect(await statusOf()).toBe('running');

    // Not awaited: the restart is deliberately left sitting between its stop and its start,
    // which is the only moment the bug is reachable.
    const restarting = lifecycle.restartServer(SERVER_ID, OWNER_ID);
    await waitForStatus('restarting');

    await lifecycle.killServer(SERVER_ID, OWNER_ID);
    await restarting;

    // The most emphatic thing a user can press must not lose to the operation it is
    // documented to interrupt.
    expect(await statusOf()).toBe('offline');
    expect((await (await driverFor()).inspect(SERVER_ID)).running).toBe(false);
  });

  it('does not report a container as offline while it is still running', async () => {
    await seed();
    await lifecycle.installServer(SERVER_ID);

    // The kill has to land *during* `driver.start`: the container does not exist yet when
    // the kill runs, so the kill has nothing to stop, and the start brings one up behind
    // it. `killServer` deliberately runs outside the lock, so nothing else notices.
    const driver = await driverFor();
    const realStart = driver.start.bind(driver);
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = false;
    driver.start = async (id: string): Promise<void> => {
      if (!gated) {
        gated = true;
        await gate;
      }
      await realStart(id);
    };

    const starting = lifecycle.startServer(SERVER_ID, OWNER_ID);
    await waitForStatus('starting');
    await lifecycle.killServer(SERVER_ID, OWNER_ID);
    release?.();
    await starting;

    // The row and the runtime have to agree. An operator reading `offline` for a container
    // that is still serving players has no way to find out, and nothing corrects it: the
    // supervisor only inspects rows that claim to be live.
    expect(await statusOf()).toBe('offline');
    expect((await driverFor()).runningCount).toBe(0);
    expect((await (await driverFor()).inspect(SERVER_ID)).running).toBe(false);
  });

  it('leaves an ordinary restart alone', async () => {
    await seed({ blueprintKey: SLOW_STOP.key });
    await lifecycle.installServer(SERVER_ID);
    await lifecycle.startServer(SERVER_ID, OWNER_ID);

    await lifecycle.restartServer(SERVER_ID, OWNER_ID);
    expect(await statusOf()).toBe('running');
  });
});

describe('log-detected crashes', () => {
  it('marks a server crashed when the blueprint crash pattern appears', async () => {
    await seed({ blueprintKey: CRASHY.key });
    await lifecycle.installServer(SERVER_ID);
    await lifecycle.startServer(SERVER_ID, OWNER_ID);
    expect(await statusOf()).toBe('running');

    // A fatal line from a process that has not exited: `checkLiveness` only ever notices a
    // container that is already gone, so without a consumer for this signal the server sits
    // at `running` forever with nobody able to play on it.
    getLogHub(SERVER_ID).append({ stream: 'stdout', content: '[main/FATAL]: Failed to load world' });

    await waitForStatus('crashed');
    expect((await (await driverFor()).inspect(SERVER_ID)).running).toBe(false);
  });

  it('ignores a crash pattern on a server that is already stopped', async () => {
    await seed({ blueprintKey: CRASHY.key });
    await lifecycle.installServer(SERVER_ID);
    expect(await statusOf()).toBe('offline');

    getLogHub(SERVER_ID).append({ stream: 'stdout', content: '[main/FATAL]: shutting down' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await statusOf()).toBe('offline');
  });

  it('keeps the log stream open past the ready line, with no console attached', async () => {
    await seed({ blueprintKey: WATCHED.key });
    await lifecycle.installServer(SERVER_ID);
    await lifecycle.startServer(SERVER_ID, OWNER_ID);
    (await driverFor()).advance(5000);
    await waitForStatus('running');

    // The boot watcher used to be the only subscriber and left at `ready`, which took the
    // driver stream down with it — so nothing was reading the log a crash pattern is in.
    expect(getLogHub(SERVER_ID).attached).toBe(true);

    await lifecycle.stopServer(SERVER_ID, OWNER_ID);
    expect(getLogHub(SERVER_ID).attached).toBe(false);
  });
});

describe('crash supervision', () => {
  beforeEach(async () => {
    await seed();
    await lifecycle.installServer(SERVER_ID);
    await lifecycle.startServer(SERVER_ID, OWNER_ID);
  });

  it('marks an unexpected exit as crashed and restarts it after a backoff', async () => {
    const driver = await driverFor();
    const now = Date.now();

    driver.crash(SERVER_ID, { exitCode: 1 });
    await lifecycle.superviseOnce(now);

    const crashed = await prisma.server.findUnique({ where: { id: SERVER_ID } });
    expect(crashed?.status).toBe('crashed');
    expect(crashed?.lastExitCode).toBe(1);
    expect(crashed?.lastCrashAt).not.toBeNull();

    // Too early: the backoff has not elapsed.
    await lifecycle.superviseOnce(now + 1000);
    expect(await statusOf()).toBe('crashed');

    await lifecycle.superviseOnce(now + 10_000);
    expect(await statusOf()).toBe('running');
  });

  it('stops retrying after three crashes inside a minute', async () => {
    const driver = await driverFor();
    let now = Date.now();

    for (let crash = 1; crash <= 3; crash += 1) {
      driver.crash(SERVER_ID, { exitCode: 1 });
      await lifecycle.superviseOnce(now);
      expect(await statusOf()).toBe('crashed');
      if (crash < 3) {
        now += 10_000;
        await lifecycle.superviseOnce(now);
        expect(await statusOf()).toBe('running');
        now += 1000;
      }
    }

    // The cutoff has latched: no later tick brings it back, however long we wait.
    await lifecycle.superviseOnce(now + 60_000);
    await lifecycle.superviseOnce(now + 600_000);
    expect(await statusOf()).toBe('crashed');
    expect((await driverFor()).runningCount).toBe(0);
  });

  it('never restarts a server the operator stopped', async () => {
    await lifecycle.stopServer(SERVER_ID, OWNER_ID);
    expect(await statusOf()).toBe('offline');

    await lifecycle.superviseOnce(Date.now());
    await lifecycle.superviseOnce(Date.now() + 60_000);
    expect(await statusOf()).toBe('offline');
    expect((await driverFor()).runningCount).toBe(0);
  });

  it('treats an exit during a stop as the stop finishing, not a crash', async () => {
    // What a process killed mid-stop leaves behind.
    const driver = await driverFor();
    await prisma.server.update({ where: { id: SERVER_ID }, data: { status: 'stopping' } });
    driver.crash(SERVER_ID, { exitCode: 137 });

    await lifecycle.superviseOnce(Date.now());

    const row = await prisma.server.findUnique({ where: { id: SERVER_ID } });
    expect(row?.status).toBe('offline');
    expect(row?.lastCrashAt).toBeNull();
  });

  it('does not call a stop that completed mid-pass a crash', async () => {
    // Two servers, so the pass has somewhere to be while the stop lands. The rows the pass
    // works from were read before it started; the second one still says `running` long
    // after the operator's stop finished, and deciding "crash or expected exit" from that
    // snapshot turned a deliberate shutdown into a crash — with an automatic restart of a
    // server somebody had just turned off.
    const other = await seed({ id: 'srv_other', hostPort: 25001 });
    await lifecycle.installServer(other);
    await lifecycle.startServer(other, OWNER_ID);

    const driver = await driverFor();
    const realInspect = driver.inspect.bind(driver);
    let stopped = false;
    driver.inspect = async (id: string) => {
      if (!stopped) {
        stopped = true;
        await lifecycle.stopServer(other, OWNER_ID);
      }
      return realInspect(id);
    };

    driver.crash(SERVER_ID, { exitCode: 1 });
    await lifecycle.superviseOnce(Date.now());
    driver.inspect = realInspect;

    const row = await prisma.server.findUnique({ where: { id: other } });
    expect(row?.status).toBe('offline');
    expect(row?.lastCrashAt).toBeNull();

    // And the next pass leaves it alone rather than starting it back up.
    await lifecycle.superviseOnce(Date.now() + 60_000);
    expect(await statusOf(other)).toBe('offline');
  });

  it('leaves a crashed server alone when autoRestart is off', async () => {
    await prisma.server.update({ where: { id: SERVER_ID }, data: { autoRestart: false } });
    const driver = await driverFor();
    const now = Date.now();

    driver.crash(SERVER_ID, { exitCode: 1 });
    await lifecycle.superviseOnce(now);
    await lifecycle.superviseOnce(now + 600_000);

    expect(await statusOf()).toBe('crashed');
  });
});

describe('reconcile', () => {
  it('corrects a stored status that the runtime disagrees with', async () => {
    await seed();
    await lifecycle.installServer(SERVER_ID);
    await lifecycle.startServer(SERVER_ID, OWNER_ID);

    // The container died while Platter was not running.
    const driver = await driverFor();
    driver.crash(SERVER_ID, { exitCode: 1 });

    const result = await lifecycle.reconcile();
    expect(result.checked).toBe(1);
    expect(result.corrected).toBe(1);
    expect(await statusOf()).toBe('crashed');
  });

  it('brings back a server that was running and has autoStart on', async () => {
    await seed({ autoStart: true });
    // autoStart also means "come up as soon as the install finishes".
    await lifecycle.installServer(SERVER_ID);
    expect(await statusOf()).toBe('running');

    // A clean exit while we were down: nothing crashed, but it was meant to be up.
    const driver = await driverFor();
    await driver.stop(SERVER_ID, { signal: 'SIGTERM', timeoutSeconds: 30 });

    const result = await lifecycle.reconcile();
    expect(result.started).toBe(1);
    expect(await statusOf()).toBe('running');
  });

  it('flags a managed container with no server record instead of destroying it', async () => {
    await seed();
    await lifecycle.installServer(SERVER_ID);

    const driver = await driverFor();
    await driver.create({
      serverId: 'srv_ghost',
      name: 'ghost',
      image: 'example/test:1',
      command: null,
      env: {},
      dataHostPath: path.join(dataDir, 'servers', 'srv_ghost'),
      dataPath: '/data',
      ports: [],
      limits: { memoryMb: 512, swapMb: 0, cpuCores: 0, ioWeight: 500, pidsLimit: 512 },
      labels: { 'platter.managed': 'true' },
      interactive: true,
    });

    const result = await lifecycle.reconcile();
    expect(result.orphans).toEqual([
      { nodeId: NODE_ID, serverId: 'srv_ghost', containerId: expect.any(String) },
    ]);
    // Flagged, not removed.
    expect((await driver.inspect('srv_ghost')).exists).toBe(true);
  });

  it('leaves a suspended server stored status alone', async () => {
    await seed();
    await lifecycle.installServer(SERVER_ID);
    await lifecycle.startServer(SERVER_ID, OWNER_ID);

    const driver = await driverFor();
    await driver.remove(SERVER_ID);
    await prisma.server.update({ where: { id: SERVER_ID }, data: { suspended: true } });

    const result = await lifecycle.reconcile();
    expect(result.corrected).toBe(0);
    // The stored status is the state it returns to when the suspension is lifted.
    expect(await statusOf()).toBe('running');
    expect((await prisma.server.findUnique({ where: { id: SERVER_ID } }))?.containerId).toBeNull();
  });

  it('leaves an unreachable node alone rather than guessing', async () => {
    await seed({ status: 'running' });
    const driver = await driverFor();
    driver.setReachable(false);

    const result = await lifecycle.reconcile();
    expect(result.unreachableNodes).toEqual([NODE_ID]);
    expect(await statusOf()).toBe('running');
  });
});

describe('deleteServer', () => {
  it('removes the container, the data and the row, and frees the ports', async () => {
    await seed();
    await lifecycle.installServer(SERVER_ID);
    await lifecycle.startServer(SERVER_ID, OWNER_ID);

    const driver = await driverFor();
    await lifecycle.deleteServer(SERVER_ID, OWNER_ID);

    expect(await prisma.server.findUnique({ where: { id: SERVER_ID } })).toBeNull();
    expect((await driver.inspect(SERVER_ID)).exists).toBe(false);

    const allocation = await prisma.allocation.findUnique({ where: { id: `alc_${SERVER_ID}` } });
    expect(allocation?.serverId).toBeNull();
    expect(allocation?.portName).toBeNull();

    await expect(stat(path.join(dataDir, 'servers', SERVER_ID))).rejects.toThrow();
  });
});

describe('setStatus', () => {
  it('is the single writer, and tells everyone watching', async () => {
    await seed();
    const seen: string[] = [];
    const hub = getLogHub(SERVER_ID);
    const unsubscribe = hub.subscribe((event) => {
      if (event.type === 'status') seen.push(event.status);
    });

    try {
      await lifecycle.setStatus(SERVER_ID, 'installing', { message: 'Installing…' });
      await lifecycle.setStatus(SERVER_ID, 'crashed', { exitCode: 9 });
    } finally {
      unsubscribe();
    }

    expect(seen).toEqual(['installing', 'crashed']);
    const row = await prisma.server.findUnique({ where: { id: SERVER_ID } });
    expect(row?.status).toBe('crashed');
    expect(row?.lastExitCode).toBe(9);
    expect(hub.backlog().some((line) => line.content === 'Installing…')).toBe(true);
  });
});
