import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PlatterError, type BlueprintPort } from '@platter/shared';

/**
 * Allocation is the one part of provisioning with a genuine concurrency requirement, so
 * these run against a real SQLite database rather than a stubbed client: the unique
 * constraint the allocator leans on only exists there, and a fake would test the mock.
 */

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workdir = await mkdtemp(path.join(tmpdir(), 'platter-allocations-'));

process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] = `file:${path.join(workdir, 'test.db')}`;
process.env['DATA_DIR'] = path.join(workdir, 'data');
process.env['DEFAULT_NODE_DRIVER'] = 'mock';
process.env['JWT_SECRET'] = 'test-secret-that-is-long-enough-to-pass';

// The schema is pushed rather than hand-written here so these tests cannot drift from
// prisma/schema.prisma — the unique constraint under test is the one the app ships.
execFileSync(path.join(apiRoot, 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
  cwd: apiRoot,
  env: process.env,
  stdio: 'ignore',
});

// Imported after the environment is set: `config` reads it once, at module load.
const { prisma } = await import('../../db.js');
const { allocatePorts, listAllocations, releasePorts } = await import('../allocations.js');

const NODE_ID = 'nod_test';
const OWNER_ID = 'usr_test';

const GAME: BlueprintPort = {
  name: 'game',
  label: 'Game',
  containerPort: 25565,
  protocol: 'tcp',
  primary: true,
};
const QUERY: BlueprintPort = {
  name: 'query',
  label: 'Query',
  containerPort: 25565,
  protocol: 'udp',
  primary: false,
};

/** An unused port, found the only way that is not a guess: by asking the kernel for one. */
async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('no port assigned')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function listenOn(port: number): Promise<NetServer> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  return server;
}

async function close(server: NetServer): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function setRange(start: number, end: number): Promise<void> {
  await prisma.node.update({
    where: { id: NODE_ID },
    data: { portRangeStart: start, portRangeEnd: end },
  });
}

async function createServerRow(id: string): Promise<void> {
  await prisma.server.create({
    data: {
      id,
      name: id,
      blueprintKey: 'minecraft-java',
      nodeId: NODE_ID,
      ownerId: OWNER_ID,
      memoryMb: 1024,
      diskMb: 1024,
      cpuCores: 0,
    },
  });
}

beforeAll(async () => {
  await prisma.user.create({
    data: {
      id: OWNER_ID,
      email: 'owner@example.com',
      username: 'owner',
      displayName: 'Owner',
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
      // A local socket path: the allocator only bind-probes nodes that share this
      // machine's network stack, and these tests depend on that probe running.
      endpoint: '/var/run/docker.sock',
      publicHost: '127.0.0.1',
      portRangeStart: 25000,
      portRangeEnd: 25001,
      memoryTotalMb: 16384,
      diskTotalMb: 512000,
      cpuCores: 8,
    },
  });
});

afterEach(async () => {
  await prisma.allocation.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
  await rm(workdir, { recursive: true, force: true });
});

describe('allocatePorts', () => {
  it('reserves one host port per blueprint port and marks the primary', async () => {
    const base = await freePort();
    await setRange(base, base + 10);

    const rows = await allocatePorts(NODE_ID, {}, [GAME, QUERY]);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.portName)).toEqual(['game', 'query']);
    expect(rows[0]?.primary).toBe(true);
    expect(rows[1]?.primary).toBe(false);
    expect(rows[0]?.protocol).toBe('tcp');
    expect(rows[1]?.protocol).toBe('udp');
    // Distinct numbers, so the two mappings are readable in `docker ps`.
    expect(rows[0]?.hostPort).not.toBe(rows[1]?.hostPort);
    // Unowned until the caller claims them.
    expect(rows.every((row) => row.serverId === null)).toBe(true);
  });

  it('honours an explicit port', async () => {
    const base = await freePort();
    await setRange(base, base + 10);

    const rows = await allocatePorts(NODE_ID, { game: base + 5 }, [GAME]);
    expect(rows[0]?.hostPort).toBe(base + 5);
  });

  it('skips a port that is owned by another server', async () => {
    const base = await freePort();
    await setRange(base, base + 1);
    await createServerRow('srv_taken');
    await prisma.allocation.create({
      data: {
        id: 'alc_taken',
        nodeId: NODE_ID,
        hostIp: '0.0.0.0',
        hostPort: base,
        protocol: 'tcp',
        serverId: 'srv_taken',
      },
    });

    const rows = await allocatePorts(NODE_ID, {}, [GAME]);
    expect(rows[0]?.hostPort).toBe(base + 1);
  });

  it('reuses a detached row instead of leaving it stranded', async () => {
    const base = await freePort();
    await setRange(base, base + 1);
    await prisma.allocation.create({
      data: {
        id: 'alc_free',
        nodeId: NODE_ID,
        hostIp: '0.0.0.0',
        hostPort: base,
        protocol: 'tcp',
        serverId: null,
        portName: 'stale',
      },
    });

    const rows = await allocatePorts(NODE_ID, {}, [GAME]);
    expect(rows[0]?.id).toBe('alc_free');
    expect(rows[0]?.portName).toBe('game');
    // No second row for the same port: the unique key would have refused it anyway.
    expect(await prisma.allocation.count()).toBe(1);
  });

  it('retries past insert conflicts when provisions race', async () => {
    const base = await freePort();
    const wanted = 6;
    await setRange(base, base + wanted * 2);

    // Every one of these scans the table before any of them writes, so they all believe
    // the same port is free. Only the unique constraint separates them.
    const results = await Promise.all(
      Array.from({ length: wanted }, async () => allocatePorts(NODE_ID, {}, [GAME])),
    );

    const ports = results.map((rows) => rows[0]?.hostPort);
    expect(new Set(ports).size).toBe(wanted);
    expect(await prisma.allocation.count()).toBe(wanted);
  });

  it('detects a port that something outside Platter is already listening on', async () => {
    const base = await freePort();
    await setRange(base, base + 1);
    const squatter = await listenOn(base);

    try {
      // Auto-allocation walks past it rather than handing out a port that cannot bind.
      const rows = await allocatePorts(NODE_ID, {}, [GAME]);
      expect(rows[0]?.hostPort).toBe(base + 1);
      await prisma.allocation.deleteMany();

      // Asked for by name, it is a refusal that names the field.
      const rejected = await allocatePorts(NODE_ID, { game: base }, [GAME]).catch(
        (error: unknown) => error,
      );
      expect(rejected).toBeInstanceOf(PlatterError);
      expect((rejected as PlatterError).code).toBe('no_allocation_available');
      expect((rejected as PlatterError).details?.['ports.game']).toBeDefined();
    } finally {
      await close(squatter);
    }
  });

  it('throws no_allocation_available when the range is exhausted', async () => {
    const base = await freePort();
    await setRange(base, base);
    await allocatePorts(NODE_ID, {}, [GAME]);
    await prisma.allocation.updateMany({ data: { serverId: null } });

    // One port, two needed: the second has nowhere to go.
    const failure = await allocatePorts(NODE_ID, {}, [GAME, QUERY]).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PlatterError);
    expect((failure as PlatterError).code).toBe('no_allocation_available');
  });

  it('leaves no reservation behind when part of the request fails', async () => {
    const base = await freePort();
    await setRange(base, base);

    await allocatePorts(NODE_ID, {}, [GAME, QUERY]).catch(() => undefined);

    const rows = await prisma.allocation.findMany();
    expect(rows.every((row) => row.portName === null && !row.primary)).toBe(true);
  });
});

describe('releasePorts', () => {
  it('returns a server ports to the free pool', async () => {
    const base = await freePort();
    await setRange(base, base + 4);
    await createServerRow('srv_owner');

    const rows = await allocatePorts(NODE_ID, {}, [GAME, QUERY]);
    await prisma.allocation.updateMany({
      where: { id: { in: rows.map((row) => row.id) } },
      data: { serverId: 'srv_owner' },
    });

    expect(await releasePorts('srv_owner')).toBe(2);

    const after = await listAllocations(NODE_ID);
    expect(after).toHaveLength(2);
    expect(after.every((row) => row.serverId === null && row.portName === null)).toBe(true);
    // And they can be handed out again.
    const reused = await allocatePorts(NODE_ID, {}, [GAME]);
    expect(rows.map((row) => row.id)).toContain(reused[0]?.id);
  });
});

describe('listAllocations', () => {
  it('lists a node allocations in port order', async () => {
    const base = await freePort();
    await setRange(base, base + 4);
    await allocatePorts(NODE_ID, {}, [GAME, QUERY]);

    const rows = await listAllocations(NODE_ID);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.hostPort).toBeLessThan(rows[1]?.hostPort ?? 0);
  });
});
