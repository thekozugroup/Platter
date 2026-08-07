import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Route-level tests for the server surface.
 *
 * They run against a real SQLite file and the real Fastify stack — schemas, auth,
 * per-server permissions and the error envelope all execute — with only the three
 * services that reach outside the process replaced: the lifecycle (containers), the
 * allocator (races we drive deliberately) and the blueprint store (files on disk).
 */

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workspace = mkdtempSync(path.join(tmpdir(), 'platter-servers-test-'));

// Set before anything imports `config`, which freezes the environment on first load.
process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] = `file:${path.join(workspace, 'test.db')}`;
process.env['DATA_DIR'] = path.join(workspace, 'data');
process.env['BACKUP_DIR'] = path.join(workspace, 'backups');
process.env['JWT_SECRET'] = 'servers-route-test-secret-0123456789abcdef';

const BLUEPRINT_KEY = 'test-game';

vi.mock('../../services/lifecycle.js', () => ({
  installServer: vi.fn(async () => {}),
  startServer: vi.fn(async () => {}),
  stopServer: vi.fn(async () => {}),
  restartServer: vi.fn(async () => {}),
  killServer: vi.fn(async () => {}),
  performPowerAction: vi.fn(async () => {}),
  sendCommand: vi.fn(async () => {}),
  deleteServer: vi.fn(async () => {}),
  reinstallServer: vi.fn(async () => {}),
  setStatus: vi.fn(async () => {}),
  reconcile: vi.fn(async () => {}),
  runCrashSupervisorPass: vi.fn(async () => {}),
  startCrashSupervisor: vi.fn(() => {}),
  stopCrashSupervisor: vi.fn(() => {}),
  setBlueprintResolver: vi.fn(() => {}),
}));

vi.mock('../../services/allocations.js', () => ({
  allocatePorts: vi.fn(),
  releasePorts: vi.fn(),
  listAllocations: vi.fn(async () => []),
  serverAllocations: vi.fn(async () => []),
  toPortBindings: vi.fn(() => []),
}));

vi.mock('../../services/blueprints.js', async () => {
  const { blueprintSchema, PlatterError } = await import('@platter/shared');
  const blueprint = blueprintSchema.parse({
    key: BLUEPRINT_KEY,
    name: 'Test Game',
    game: 'Test Game',
    image: 'example/test-game:1',
    icon: { monogram: 'TG', hue: 210 },
    minMemoryMb: 1024,
    recommendedMemoryMb: 2048,
    minDiskMb: 2048,
    ports: [{ name: 'game', label: 'Game', containerPort: 25565, protocol: 'tcp', primary: true }],
    variables: [
      { key: 'MAX_PLAYERS', label: 'Max players', type: 'number', default: 20, min: 1, max: 100 },
      { key: 'MOTD', label: 'Message of the day', type: 'string', default: 'A Platter server' },
      {
        key: 'DIFFICULTY',
        label: 'Difficulty',
        type: 'enum',
        default: 'easy',
        options: [
          { value: 'easy', label: 'Easy' },
          { value: 'hard', label: 'Hard' },
        ],
      },
    ],
    stop: {},
  });

  return {
    getBlueprint: vi.fn(async (key: string) => {
      if (key !== blueprint.key) throw new PlatterError('not_found', 'That blueprint does not exist.');
      return blueprint;
    }),
    listBlueprints: vi.fn(async () => [blueprint]),
  };
});

const { buildApp } = await import('../../app.js');
const { prisma } = await import('../../db.js');
const { newId } = await import('../../lib/ids.js');
const { AUTH_USER_SELECT, toAuthenticatedUser } = await import('../../plugins/auth.js');
const { allocatePorts, releasePorts } = await import('../../services/allocations.js');
const { installServer, performPowerAction } = await import('../../services/lifecycle.js');

type Principal = { id: string; token: string };

let app: FastifyInstance;
let nodeId: string;
let ownerUser: Principal;
let memberA: Principal;
let memberB: Principal;

/** Bumped per reservation so concurrent rows never collide on the node's unique index. */
let nextHostPort = 26000;

async function createUser(role: 'owner' | 'admin' | 'member', name: string): Promise<Principal> {
  const row = await prisma.user.create({
    data: {
      id: newId('usr'),
      email: `${name}@example.test`,
      username: name,
      displayName: name,
      passwordHash: 'not-used-by-these-tests',
      role,
    },
    select: AUTH_USER_SELECT,
  });
  return { id: row.id, token: app.issueAccessToken(toAuthenticatedUser(row)) };
}

function auth(principal: Principal): Record<string, string> {
  return { authorization: `Bearer ${principal.token}` };
}

const validBody = {
  name: 'Survival SMP',
  blueprintKey: BLUEPRINT_KEY,
  variables: { MAX_PLAYERS: '30', DIFFICULTY: 'hard' },
};

async function seedServer(ownerId: string, status = 'offline'): Promise<string> {
  const id = newId('srv');
  await prisma.server.create({
    data: {
      id,
      name: 'Seeded',
      blueprintKey: BLUEPRINT_KEY,
      nodeId,
      ownerId,
      status,
      memoryMb: 2048,
      diskMb: 4096,
      cpuCores: 0,
      variables: '{}',
    },
  });
  return id;
}

beforeAll(async () => {
  execFileSync(
    path.join(apiRoot, 'node_modules/.bin/prisma'),
    ['db', 'push', '--schema', path.join(apiRoot, 'prisma/schema.prisma'), '--skip-generate', '--accept-data-loss'],
    { env: process.env, stdio: 'ignore' },
  );

  app = await buildApp({ logger: false });
  await app.ready();

  const node = await prisma.node.create({
    data: {
      id: newId('nod'),
      name: 'test-node',
      // The in-memory driver: no daemon, same code paths as Docker.
      driver: 'mock',
      endpoint: 'mock',
      publicHost: 'play.example.test',
      portRangeStart: 26000,
      portRangeEnd: 26999,
      memoryTotalMb: 16384,
      diskTotalMb: 262144,
      cpuCores: 8,
    },
  });
  nodeId = node.id;

  ownerUser = await createUser('owner', 'root');
  memberA = await createUser('member', 'ana');
  memberB = await createUser('member', 'ben');
}, 60_000);

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  rmSync(workspace, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  await prisma.serverSubuser.deleteMany();
  await prisma.allocation.deleteMany();
  await prisma.server.deleteMany();

  vi.mocked(allocatePorts).mockImplementation(async (targetNodeId, requested, blueprintPorts) => {
    const reserved = [];
    for (const port of blueprintPorts) {
      const hostPort = requested[port.name] ?? nextHostPort++;
      const row = await prisma.allocation.create({
        data: {
          id: newId('alc'),
          nodeId: targetNodeId,
          hostIp: '0.0.0.0',
          hostPort,
          protocol: port.protocol,
          serverId: null,
          portName: port.name,
          primary: port.primary,
        },
      });
      reserved.push({
        id: row.id,
        nodeId: row.nodeId,
        hostIp: row.hostIp,
        hostPort: row.hostPort,
        protocol: port.protocol,
        serverId: null,
        portName: row.portName,
        primary: row.primary,
      });
    }
    return reserved;
  });

  vi.mocked(releasePorts).mockImplementation(async (serverId: string) => {
    const released = await prisma.allocation.updateMany({
      where: { serverId },
      data: { serverId: null },
    });
    return released.count;
  });
});

describe('POST /servers', () => {
  it('creates a server, claims its ports and starts the install', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: auth(memberA),
      payload: validBody,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe('provisioning');
    expect(body.ownerId).toBe(memberA.id);
    // Blueprint defaults fill in what the request left out, and values are normalised.
    expect(body.variables).toEqual({ MAX_PLAYERS: '30', MOTD: 'A Platter server', DIFFICULTY: 'hard' });
    expect(body.limits.memoryMb).toBe(2048);
    expect(body.allocations).toHaveLength(1);
    expect(body.allocations[0]).toMatchObject({ name: 'game', containerPort: 25565, primary: true });

    const claimed = await prisma.allocation.findMany({ where: { serverId: body.id } });
    expect(claimed).toHaveLength(1);
    expect(vi.mocked(installServer)).toHaveBeenCalledWith(body.id);
  });

  it('rejects variables that violate the blueprint schema, field by field', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: auth(memberA),
      payload: { ...validBody, variables: { MAX_PLAYERS: '900', DIFFICULTY: 'nightmare' } },
    });

    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details['variables.MAX_PLAYERS']).toBeDefined();
    expect(body.error.details['variables.DIFFICULTY']).toBeDefined();
    expect(await prisma.server.count()).toBe(0);
  });

  it('names the blueprint minimum when the requested memory is below it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: auth(memberA),
      payload: { ...validBody, limits: { memoryMb: 512 } },
    });

    expect(response.statusCode).toBe(422);
    const details = response.json().error.details['limits.memoryMb'];
    expect(details?.[0]).toContain('1.0 GB');
  });

  it('rejects an unknown blueprint as a bad field rather than a missing page', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: auth(memberA),
      payload: { ...validBody, blueprintKey: 'no-such-game' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.blueprintKey).toBeDefined();
  });

  it('refuses a node that cannot fit the server', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: auth(memberA),
      payload: { ...validBody, limits: { memoryMb: 1_048_576 } },
    });

    expect(response.statusCode).toBe(507);
    expect(response.json().error.code).toBe('insufficient_resources');
  });

  it('rolls the row back when the ports cannot be claimed', async () => {
    // A port the allocator handed us that another provision took first: the guarded claim
    // matches nothing, which is exactly the race the two-phase allocation exists to catch.
    vi.mocked(allocatePorts).mockResolvedValueOnce([
      {
        id: newId('alc'),
        nodeId,
        hostIp: '0.0.0.0',
        hostPort: 26999,
        protocol: 'tcp',
        serverId: null,
        portName: 'game',
        primary: true,
      },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: auth(memberA),
      payload: validBody,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('no_allocation_available');
    // Nothing half-created: no row, no install, and the ports were handed back.
    expect(await prisma.server.count()).toBe(0);
    expect(vi.mocked(releasePorts)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(installServer)).not.toHaveBeenCalled();
  });
});

describe('server visibility', () => {
  it('hides another member\'s server behind a 404 rather than a 403', async () => {
    const serverId = await seedServer(memberA.id);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}`,
      headers: auth(memberB),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('not_found');
  });

  it('scopes the list to owned and shared servers', async () => {
    const owned = await seedServer(memberA.id);
    const shared = await seedServer(ownerUser.id);
    await prisma.serverSubuser.create({
      data: {
        id: newId('sub'),
        serverId: shared,
        userId: memberA.id,
        permissions: JSON.stringify(['server.view', 'console.read']),
      },
    });

    const mine = await app.inject({ method: 'GET', url: '/api/v1/servers', headers: auth(memberA) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().data.map((server: { id: string }) => server.id).sort()).toEqual(
      [owned, shared].sort(),
    );
    expect(mine.json().meta.total).toBe(2);

    const theirs = await app.inject({ method: 'GET', url: '/api/v1/servers', headers: auth(memberB) });
    expect(theirs.json().data).toHaveLength(0);

    // An owner sees every server without needing a grant on any of them.
    const all = await app.inject({ method: 'GET', url: '/api/v1/servers', headers: auth(ownerUser) });
    expect(all.json().meta.total).toBe(2);
  });

  it('refuses an action the subuser was not granted', async () => {
    const serverId = await seedServer(ownerUser.id);
    await prisma.serverSubuser.create({
      data: {
        id: newId('sub'),
        serverId,
        userId: memberB.id,
        permissions: JSON.stringify(['server.view', 'console.read']),
      },
    });

    const view = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}`,
      headers: auth(memberB),
    });
    expect(view.statusCode).toBe(200);

    const power = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/power`,
      headers: auth(memberB),
      payload: { action: 'start' },
    });
    expect(power.statusCode).toBe(403);
    expect(power.json().error.code).toBe('forbidden');
    expect(vi.mocked(performPowerAction)).not.toHaveBeenCalled();
  });
});

describe('POST /servers/:serverId/power', () => {
  it('accepts a legal action and reports the status it is heading for', async () => {
    const serverId = await seedServer(memberA.id, 'offline');

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/power`,
      headers: auth(memberA),
      payload: { action: 'start' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: 'starting' });
    expect(vi.mocked(performPowerAction)).toHaveBeenCalledWith(serverId, 'start', memberA.id, {
      force: false,
    });
  });

  it('refuses a transition the status table forbids', async () => {
    const serverId = await seedServer(memberA.id, 'offline');

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/power`,
      headers: auth(memberA),
      payload: { action: 'stop' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('invalid_state');
    expect(vi.mocked(performPowerAction)).not.toHaveBeenCalled();
  });

  it('treats a suspended server as locked whatever its stored status says', async () => {
    const serverId = await seedServer(ownerUser.id, 'running');
    await prisma.server.update({ where: { id: serverId }, data: { suspended: true } });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/power`,
      headers: auth(ownerUser),
      payload: { action: 'restart' },
    });

    expect(response.statusCode).toBe(409);
    expect(vi.mocked(performPowerAction)).not.toHaveBeenCalled();
  });
});

describe('subusers', () => {
  it('lets the owner grant access and refuses everyone else', async () => {
    const serverId = await seedServer(memberA.id);

    const granted = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/subusers`,
      headers: auth(memberA),
      payload: { email: 'ben@example.test', permissions: ['console.read', 'server.view'] },
    });
    expect(granted.statusCode).toBe(201);
    expect(granted.json().userId).toBe(memberB.id);

    // The grantee now has access to the server but not to who else does.
    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/subusers`,
      headers: auth(memberB),
    });
    expect(listed.statusCode).toBe(403);
  });

  it('reports an unknown email as a bad field on the form', async () => {
    const serverId = await seedServer(memberA.id);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/subusers`,
      headers: auth(memberA),
      payload: { email: 'nobody@example.test', permissions: ['server.view'] },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.email).toBeDefined();
  });
});

/**
 * Over a real listener rather than `inject`: the socket is mounted at the root while its
 * plugin is registered under the API prefix, and only a genuine HTTP upgrade proves that
 * the path a browser uses actually reaches the handler.
 */
describe('console socket', () => {
  let origin: string;

  beforeAll(async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('the test server has no port');
    origin = `ws://127.0.0.1:${address.port}`;
  });

  function open(serverId: string): Promise<WebSocket> {
    const socket = new WebSocket(`${origin}/ws/servers/${serverId}/console`);
    return new Promise((resolve, reject) => {
      socket.addEventListener('open', () => {
        resolve(socket);
      });
      socket.addEventListener('error', () => {
        reject(new Error('the console socket refused to open'));
      });
    });
  }

  /** Skips frames the test is not asking about — a live server also sends log lines. */
  function nextMessage(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const onMessage = (event: MessageEvent): void => {
        const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (frame.type !== type) return;
        socket.removeEventListener('message', onMessage);
        resolve(frame);
      };
      socket.addEventListener('message', onMessage);
      socket.addEventListener(
        'close',
        (event) => {
          reject(new Error(`socket closed with ${event.code} while waiting for ${type}`));
        },
        { once: true },
      );
    });
  }

  function nextClose(socket: WebSocket): Promise<number> {
    return new Promise((resolve) => {
      socket.addEventListener('close', (event) => {
        resolve(event.code);
      });
    });
  }

  it('is reachable at the path the client uses and answers ready after auth', async () => {
    const serverId = await seedServer(memberA.id, 'offline');
    const socket = await open(serverId);
    const ready = nextMessage(socket, 'ready');
    socket.send(JSON.stringify({ type: 'auth', token: memberA.token }));

    expect(await ready).toMatchObject({ type: 'ready', serverId, status: 'offline', canWrite: true });
    socket.close();
  });

  it('closes on a token it cannot verify', async () => {
    const serverId = await seedServer(memberA.id, 'offline');
    const socket = await open(serverId);
    const closed = nextClose(socket);
    socket.send(JSON.stringify({ type: 'auth', token: 'not-a-token' }));

    expect(await closed).toBe(4401);
  });

  it('hides a server the principal has no relationship with', async () => {
    const serverId = await seedServer(memberA.id, 'offline');
    const socket = await open(serverId);
    const closed = nextClose(socket);
    socket.send(JSON.stringify({ type: 'auth', token: memberB.token }));

    expect(await closed).toBe(4404);
  });

  it('refuses console input from a read-only grant without closing the socket', async () => {
    const serverId = await seedServer(ownerUser.id, 'running');
    await prisma.serverSubuser.create({
      data: {
        id: newId('sub'),
        serverId,
        userId: memberB.id,
        permissions: JSON.stringify(['server.view', 'console.read']),
      },
    });

    const socket = await open(serverId);
    const ready = nextMessage(socket, 'ready');
    socket.send(JSON.stringify({ type: 'auth', token: memberB.token }));
    expect(await ready).toMatchObject({ type: 'ready', canWrite: false });

    const refused = nextMessage(socket, 'error');
    socket.send(JSON.stringify({ type: 'command', command: 'say hello' }));
    expect(await refused).toMatchObject({ type: 'error', code: 'forbidden' });
    socket.close();
  });

  it('answers a ping and drops a socket that never authenticates', async () => {
    const serverId = await seedServer(memberA.id, 'offline');
    const socket = await open(serverId);

    const pong = nextMessage(socket, 'pong');
    socket.send(JSON.stringify({ type: 'ping' }));
    expect(await pong).toEqual({ type: 'pong' });

    expect(await nextClose(socket)).toBe(4408);
  }, 15_000);
});
