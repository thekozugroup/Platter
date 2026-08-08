import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { API_PREFIX } from '@platter/shared';
import {
  authHeaders,
  buildTestApp,
  closeTestHarness,
  createTestUser,
  ensureTestNode,
  resetDatabase,
  type TestUser,
} from '../helpers.js';

/**
 * The wiring test: does the assembled application actually work?
 *
 * Every other suite tests one module against its own fixtures. This one proves the parts
 * are connected — that the routes are registered under the prefixes the client expects,
 * that `requireServerAccess` is on the routes that need it, and that a create really does
 * reach the driver. It is the test that would have caught `routes/servers.ts` being an
 * empty placeholder while `services/servers.ts` was complete.
 */

let app: FastifyInstance;
let owner: TestUser;
let nodeId: string;

const BASE = API_PREFIX;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeTestHarness();
});

afterEach(async () => {
  await resetDatabase();
});

async function setupOwner(): Promise<void> {
  nodeId = await ensureTestNode();
  owner = await createTestUser('owner');
}

/** The minimum a Paper server needs: the EULA, which has no default by design. */
function paperBody(name = 'Test Paper') {
  return {
    name,
    blueprintKey: 'minecraft-java',
    nodeId,
    variables: { EULA: 'true', TYPE: 'PAPER', VERSION: '1.21.4' },
    limits: { memoryMb: 2048 },
    startOnCreate: false,
  };
}

describe('route registration', () => {
  it('mounts every module the client depends on', () => {
    const table = app.printRoutes({ commonPrefix: false });
    for (const path of [
      `${BASE}/servers`,
      `${BASE}/blueprints`,
      `${BASE}/system/health`,
      `${BASE}/mcp`,
      `${BASE}/network/zone`,
      '/ws/servers/:serverId/console',
    ]) {
      expect(table, `${path} is not registered`).toContain(path);
    }
  });

  it('serves the console websocket outside the API prefix', () => {
    // The browser client hardcodes `/ws/...` against the origin. Mounting it under the
    // REST prefix compiles, registers and is completely unreachable.
    const table = app.printRoutes({ commonPrefix: false });
    expect(table).toContain('/ws/servers/:serverId/console');
    expect(table).not.toContain(`${BASE}/ws/servers`);
  });
});

describe('authentication', () => {
  beforeAll(setupOwner);

  it('refuses an unauthenticated list', async () => {
    const response = await app.inject({ method: 'GET', url: `${BASE}/servers` });
    expect(response.statusCode).toBe(401);
  });

  it('accepts a bearer token', async () => {
    const user = await createTestUser('owner');
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/servers`,
      headers: authHeaders(user),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: [], meta: { total: 0 } });
  });

  it('logs in with the real password hash', async () => {
    const user = await createTestUser('owner');
    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/auth/login`,
      payload: { email: user.email, password: user.password },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().accessToken).toEqual(expect.any(String));
  });
});

describe('blueprints', () => {
  it('lists the catalogue and resolves Minecraft server types', async () => {
    const user = await createTestUser('owner');
    const list = await app.inject({
      method: 'GET',
      url: `${BASE}/blueprints`,
      headers: authHeaders(user),
    });
    expect(list.statusCode).toBe(200);
    const keys = list.json().data.map((entry: { key: string }) => entry.key);
    expect(keys).toContain('minecraft-java');

    const detail = await app.inject({
      method: 'GET',
      url: `${BASE}/blueprints/minecraft-java`,
      headers: authHeaders(user),
    });
    expect(detail.statusCode).toBe(200);
    const type = detail.json().variables.find((v: { key: string }) => v.key === 'TYPE');
    const options = type.options.map((o: { value: string }) => o.value);
    expect(options).toEqual(expect.arrayContaining(['PAPER', 'VANILLA', 'FABRIC', 'FORGE']));
  });
});

describe('server lifecycle over HTTP', () => {
  beforeAll(setupOwner);

  it('creates, starts, commands and deletes a server', async () => {
    nodeId = await ensureTestNode();
    const user = await createTestUser('owner');

    const created = await app.inject({
      method: 'POST',
      url: `${BASE}/servers`,
      headers: authHeaders(user),
      payload: paperBody(),
    });
    expect(created.statusCode).toBe(201);
    const server = created.json();
    expect(server.status).toBe('provisioning');
    // Ports come from the allocator, not from the request.
    expect(server.allocations.length).toBeGreaterThan(0);
    expect(server.allocations.some((a: { primary: boolean }) => a.primary)).toBe(true);

    // Install, then start, through the same lifecycle the routes use.
    const lifecycle = await import('../../services/lifecycle.js');
    await lifecycle.installServer(server.id);
    await lifecycle.startServer(server.id);

    const afterStart = await app.inject({
      method: 'GET',
      url: `${BASE}/servers/${server.id}`,
      headers: authHeaders(user),
    });
    expect(afterStart.statusCode).toBe(200);
    expect(['starting', 'running']).toContain(afterStart.json().status);

    const stats = await app.inject({
      method: 'GET',
      url: `${BASE}/servers/${server.id}/stats`,
      headers: authHeaders(user),
    });
    expect(stats.statusCode).toBe(200);
    expect(stats.json().serverId).toBe(server.id);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `${BASE}/servers/${server.id}`,
      headers: authHeaders(user),
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ id: server.id, deleted: true });

    const gone = await app.inject({
      method: 'GET',
      url: `${BASE}/servers/${server.id}`,
      headers: authHeaders(user),
    });
    expect(gone.statusCode).toBe(404);
  });

  it('rejects a power action the current status forbids', async () => {
    nodeId = await ensureTestNode();
    const user = await createTestUser('owner');
    const created = await app.inject({
      method: 'POST',
      url: `${BASE}/servers`,
      headers: authHeaders(user),
      payload: paperBody('Never Installed'),
    });
    const server = created.json();

    // `provisioning` permits nothing at all — see ALLOWED_POWER_ACTIONS.
    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/servers/${server.id}/power`,
      headers: authHeaders(user),
      payload: { action: 'start' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('invalid_state');
  });

  it('validates the blueprint variables it was given', async () => {
    nodeId = await ensureTestNode();
    const user = await createTestUser('owner');
    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/servers`,
      headers: authHeaders(user),
      // EULA is required and has no default; a server without it could never boot.
      payload: { ...paperBody('No EULA'), variables: { TYPE: 'PAPER' } },
    });
    expect(response.statusCode).toBe(422);
    expect(Object.keys(response.json().error.details)).toContain('variables.EULA');
  });
});

describe('per-server authorisation', () => {
  it('hides another member’s server behind a 404, not a 403', async () => {
    nodeId = await ensureTestNode();
    const alice = await createTestUser('member');
    const bob = await createTestUser('member');

    const created = await app.inject({
      method: 'POST',
      url: `${BASE}/servers`,
      headers: authHeaders(alice),
      payload: paperBody("Alice's"),
    });
    expect(created.statusCode).toBe(201);
    const server = created.json();

    const peek = await app.inject({
      method: 'GET',
      url: `${BASE}/servers/${server.id}`,
      headers: authHeaders(bob),
    });
    // A 403 would confirm the id exists. This is the whole reason for the rule.
    expect(peek.statusCode).toBe(404);

    const list = await app.inject({
      method: 'GET',
      url: `${BASE}/servers`,
      headers: authHeaders(bob),
    });
    expect(list.json().meta.total).toBe(0);
  });

  it('enforces the power action’s own permission, not just server.view', async () => {
    nodeId = await ensureTestNode();
    const alice = await createTestUser('member');
    const bob = await createTestUser('member');

    const created = await app.inject({
      method: 'POST',
      url: `${BASE}/servers`,
      headers: authHeaders(alice),
      payload: paperBody('Shared'),
    });
    const server = created.json();

    // Bob may look, but holds no power grant at all.
    const invited = await app.inject({
      method: 'POST',
      url: `${BASE}/servers/${server.id}/subusers`,
      headers: authHeaders(alice),
      payload: { email: bob.email, permissions: ['server.view'] },
    });
    expect(invited.statusCode).toBe(201);

    const visible = await app.inject({
      method: 'GET',
      url: `${BASE}/servers/${server.id}`,
      headers: authHeaders(bob),
    });
    expect(visible.statusCode).toBe(200);

    const power = await app.inject({
      method: 'POST',
      url: `${BASE}/servers/${server.id}/power`,
      headers: authHeaders(bob),
      payload: { action: 'start' },
    });
    expect(power.statusCode).toBe(403);
  });
});

describe('system', () => {
  it('answers health without credentials', async () => {
    const response = await app.inject({ method: 'GET', url: `${BASE}/system/health` });
    expect(response.statusCode).toBe(200);
  });

  it('requires admin for the Prometheus endpoint', async () => {
    const member = await createTestUser('member');
    const denied = await app.inject({
      method: 'GET',
      url: `${BASE}/system/metrics`,
      headers: authHeaders(member),
    });
    expect(denied.statusCode).toBe(403);

    const admin = await createTestUser('admin');
    const allowed = await app.inject({
      method: 'GET',
      url: `${BASE}/system/metrics`,
      headers: authHeaders(admin),
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body).toContain('platter_');
  });
});
