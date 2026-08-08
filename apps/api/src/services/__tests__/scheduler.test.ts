import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatterError, blueprintSchema, type Blueprint } from '@platter/shared';
import type * as Blueprints from '../blueprints.js';

/**
 * The cron dispatcher, end to end against the mock driver plus a real SQLite database —
 * the conditional-update claim the overlap guard relies on only exists there, and a fake
 * would just be testing the fake.
 */

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workdir = await mkdtemp(path.join(tmpdir(), 'platter-scheduler-'));
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

/** Only the lookup is faked — everything a schedule actually drives (start/stop/command,
 * env rendering) is the real `services/lifecycle.ts`. */
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
const lifecycle = await import('../lifecycle.js');
const scheduler = await import('../scheduler.js');

const NODE_ID = 'nod_test';
const OWNER_ID = 'usr_test';
const SERVER_ID = 'srv_test';
const BLUEPRINT_KEY = 'test-game';

/** No ready pattern, so a `start` resolves straight to `running` — the boot watcher has
 * nothing to wait for and promotes it immediately. */
const BLUEPRINT: Blueprint = blueprintSchema.parse({
  key: BLUEPRINT_KEY,
  name: 'Test Game',
  game: 'Test',
  image: 'example/test:1',
  icon: { monogram: 'TG', hue: 200 },
  minMemoryMb: 512,
  recommendedMemoryMb: 1024,
  minDiskMb: 512,
  ports: [{ name: 'game', label: 'Game', containerPort: 25565, protocol: 'tcp', primary: true }],
  stop: { strategy: 'signal', signal: 'SIGTERM', timeoutSeconds: 5 },
});
catalogue.set(BLUEPRINT_KEY, BLUEPRINT);

interface SeedServerOptions {
  id?: string;
  status?: string;
}

async function seedServer(options: SeedServerOptions = {}): Promise<string> {
  const id = options.id ?? SERVER_ID;
  await prisma.server.create({
    data: {
      id,
      name: 'Test Server',
      blueprintKey: BLUEPRINT_KEY,
      nodeId: NODE_ID,
      ownerId: OWNER_ID,
      status: options.status ?? 'provisioning',
      memoryMb: 1024,
      diskMb: 2048,
      cpuCores: 0,
      autoStart: false,
      autoRestart: true,
    },
  });
  await prisma.allocation.create({
    data: {
      id: `alc_${id}`,
      nodeId: NODE_ID,
      hostIp: '0.0.0.0',
      hostPort: 25000,
      protocol: 'tcp',
      serverId: id,
      portName: 'game',
      primary: true,
    },
  });
  return id;
}

interface SeedScheduleOptions {
  id?: string;
  serverId?: string;
  name?: string;
  cron?: string;
  timezone?: string;
  action?: string;
  payload?: string | null;
  enabled?: boolean;
  onlyWhenOnline?: boolean;
  nextRunAt?: Date | null;
}

let scheduleCounter = 0;

function seedSchedule(options: SeedScheduleOptions = {}) {
  scheduleCounter += 1;
  return prisma.schedule.create({
    data: {
      id: options.id ?? `sch_test_${scheduleCounter}`,
      serverId: options.serverId ?? SERVER_ID,
      name: options.name ?? 'Test schedule',
      cron: options.cron ?? '0 3 * * *',
      timezone: options.timezone ?? 'UTC',
      action: options.action ?? 'command',
      payload: options.payload ?? 'say hi',
      enabled: options.enabled ?? true,
      onlyWhenOnline: options.onlyWhenOnline ?? true,
      nextRunAt: options.nextRunAt === undefined ? null : options.nextRunAt,
    },
  });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('condition was never met');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForLastRun(id: string, timeoutMs = 3000): Promise<void> {
  await waitFor(async () => {
    const row = await prisma.schedule.findUnique({ where: { id } });
    return row?.lastRunAt !== null && row?.lastRunAt !== undefined;
  }, timeoutMs);
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
  await prisma.schedule.deleteMany();
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
  scheduler.resetSchedulerState();
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

describe('computeNextRun', () => {
  it('returns the next occurrence strictly after `from`, not `from` itself', () => {
    const from = new Date('2026-01-01T03:00:00Z');
    const next = scheduler.computeNextRun('0 3 * * *', 'UTC', from);
    expect(next.toISOString()).toBe('2026-01-02T03:00:00.000Z');
  });

  it('is timezone-aware: the same wall-clock cron fires at a different UTC instant', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    // 09:00 in Tokyo (UTC+9, no DST) is 00:00 UTC.
    const next = scheduler.computeNextRun('0 9 * * *', 'Asia/Tokyo', from);
    // `from` is already exactly 09:00 JST, and `next()` is exclusive, so the next
    // occurrence is the following day's 09:00 JST.
    expect(next.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  it('skips the wall-clock hour a spring-forward transition removes', () => {
    // America/New_York has no 2:00 AM on 2026-03-08 (its spring-forward day): the clock
    // jumps straight from 1:59:59 EST to 3:00:00 EDT. Asking from earlier that same day
    // must land on that real instant (07:00 UTC = 3:00 EDT), not on a "2am" that never
    // happens.
    const from = new Date('2026-03-08T00:00:00Z');
    const next = scheduler.computeNextRun('0 2 * * *', 'America/New_York', from);
    expect(next.toISOString()).toBe('2026-03-08T07:00:00.000Z');
  });

  it('fires once, not twice, on the wall-clock hour a fall-back transition repeats', () => {
    // 1:00 AM occurs twice on America/New_York's fall-back day (once in EDT, once after
    // the clocks repeat it in EST). Asking from between those two repeats must land on
    // tomorrow, not today's second occurrence.
    const betweenTheTwoOneAms = new Date('2026-11-01T05:30:00Z');
    const next = scheduler.computeNextRun('0 1 * * *', 'America/New_York', betweenTheTwoOneAms);
    expect(next.toISOString()).toBe('2026-11-02T06:00:00.000Z');
  });

  it('rejects a cron expression it cannot parse', () => {
    expect(() => scheduler.computeNextRun('not a cron', 'UTC')).toThrow(PlatterError);
  });

  it('rejects an unrecognised timezone', () => {
    expect(() => scheduler.computeNextRun('0 3 * * *', 'Mars/Colony')).toThrow(PlatterError);
  });
});

describe('recomputeNextRun', () => {
  it('computes and persists nextRunAt for an enabled schedule', async () => {
    await seedServer();
    const row = await seedSchedule({ cron: '0 0 * * *', timezone: 'UTC' });

    const next = await scheduler.recomputeNextRun(row.id);

    const updated = await prisma.schedule.findUnique({ where: { id: row.id } });
    expect(updated?.nextRunAt?.getTime()).toBe(next?.getTime());
  });

  it('clears nextRunAt for a disabled schedule instead of computing one', async () => {
    await seedServer();
    const row = await seedSchedule({ enabled: false, nextRunAt: new Date() });

    const next = await scheduler.recomputeNextRun(row.id);

    expect(next).toBeNull();
    expect((await prisma.schedule.findUnique({ where: { id: row.id } }))?.nextRunAt).toBeNull();
  });

  it('throws not_found for an id that does not exist', async () => {
    await expect(scheduler.recomputeNextRun('sch_missing')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('startScheduler: missed-run catch-up', () => {
  it('fast-forwards an overdue schedule instead of running it', async () => {
    await seedServer({ status: 'offline' });
    const overdue = new Date(Date.now() - 60_000);
    const row = await seedSchedule({ cron: '0 0 1 1 *', timezone: 'UTC', nextRunAt: overdue });

    await scheduler.startScheduler({ intervalMs: 20 });
    // Long enough for the startup catch-up and at least one heartbeat to have happened.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const updated = await prisma.schedule.findUnique({ where: { id: row.id } });
    expect(updated?.lastRunAt).toBeNull();
    expect(updated?.nextRunAt).not.toBeNull();
    expect(updated?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('automatic dispatch', () => {
  it('starts a due server through the tick loop and advances nextRunAt past it', async () => {
    await seedServer({ status: 'provisioning' });
    await lifecycle.installServer(SERVER_ID);
    expect((await prisma.server.findUnique({ where: { id: SERVER_ID } }))?.status).toBe('offline');

    const dueAt = new Date(Date.now() + 30);
    const row = await seedSchedule({
      action: 'start',
      payload: null,
      cron: '0 0 * * *',
      timezone: 'UTC',
      nextRunAt: dueAt,
    });

    await scheduler.startScheduler({ intervalMs: 20 });
    await waitForLastRun(row.id);

    const updated = await prisma.schedule.findUnique({ where: { id: row.id } });
    expect(updated?.lastRunStatus).toBe('success');
    expect(updated?.nextRunAt?.getTime()).toBeGreaterThan(dueAt.getTime());

    expect((await prisma.server.findUnique({ where: { id: SERVER_ID } }))?.status).toBe('running');
  });

  it('disables a schedule whose cron can no longer be parsed, without stopping the loop', async () => {
    await seedServer({ status: 'offline' });
    const row = await seedSchedule({
      cron: 'not a cron',
      nextRunAt: new Date(Date.now() - 1000),
    });

    await scheduler.startScheduler({ intervalMs: 20 });
    await waitFor(async () => {
      const updated = await prisma.schedule.findUnique({ where: { id: row.id } });
      return updated?.enabled === false;
    });

    const updated = await prisma.schedule.findUnique({ where: { id: row.id } });
    expect(updated?.enabled).toBe(false);
    expect(updated?.nextRunAt).toBeNull();
    expect(updated?.lastRunStatus).toBe('failed');
  });
});

describe('runScheduleNow', () => {
  it('throws not_found for an unknown schedule', async () => {
    await expect(scheduler.runScheduleNow('sch_missing')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('skips a command against an offline server rather than attempting it', async () => {
    await seedServer({ status: 'offline' });
    const row = await seedSchedule({ action: 'command', payload: 'say hi', onlyWhenOnline: true });

    await scheduler.runScheduleNow(row.id);
    await waitForLastRun(row.id);

    const updated = await prisma.schedule.findUnique({ where: { id: row.id } });
    expect(updated?.lastRunStatus).toBe('skipped');
    expect(updated?.lastRunError).toMatch(/offline/i);
  });

  it('does not move nextRunAt for a manual run', async () => {
    await seedServer({ status: 'offline' });
    const originalNext = new Date(Date.now() + 3_600_000);
    const row = await seedSchedule({ nextRunAt: originalNext });

    await scheduler.runScheduleNow(row.id);
    await waitForLastRun(row.id);

    const updated = await prisma.schedule.findUnique({ where: { id: row.id } });
    expect(updated?.nextRunAt?.getTime()).toBe(originalNext.getTime());
  });

  it('refuses to run a schedule that is already running', async () => {
    await seedServer({ status: 'offline' });
    const row = await seedSchedule({ action: 'command', payload: 'say hi' });

    await scheduler.runScheduleNow(row.id);
    await expect(scheduler.runScheduleNow(row.id)).rejects.toMatchObject({ code: 'conflict' });

    // Drains the first run so it cannot touch the database after the test (and the next
    // test's table cleanup) has moved on.
    await waitForLastRun(row.id);
  });
});
