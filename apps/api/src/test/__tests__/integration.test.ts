import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_PREFIX } from '@platter/shared';
import {
  authHeaders,
  buildTestApp,
  closeTestHarness,
  createTestUser,
  ensureTestNode,
  resetDatabase,
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
let nodeId: string;

const BASE = API_PREFIX;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeTestHarness();
});

/**
 * The node is recreated per test rather than once, because `resetDatabase` truncates it
 * along with everything else — a `beforeAll` node would silently vanish after the first
 * test in the file and every later create would fail on a missing node.
 */
beforeEach(async () => {
  nodeId = await ensureTestNode();
});

afterEach(async () => {
  await resetDatabase();
});

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

/**
 * Polls the real endpoint until the server reaches a status. The mock driver emits its
 * boot lines on a wall-clock timer, so the transition to `running` is genuinely
 * asynchronous — exactly as it is against Docker.
 */
async function waitForStatus(
  user: { accessToken: string },
  serverId: string,
  wanted: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen = 'unknown';
  while (Date.now() < deadline) {
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/servers/${serverId}`,
      headers: authHeaders(user),
    });
    seen = response.json().status;
    if (seen === wanted) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server stayed at "${seen}" instead of reaching "${wanted}"`);
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
  it('creates, starts, commands and deletes a server', async () => {
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

    // Install through the same lifecycle the routes use. `autoStart` defaults to true, so
    // a successful install starts the server itself — asking for a start on top of that is
    // an `invalid_state`, which is the behaviour, not a bug.
    const lifecycle = await import('../../services/lifecycle.js');
    await lifecycle.installServer(server.id);
    await waitForStatus(user, server.id, 'running');

    // A command only reaches the container once the game is up.
    const command = await app.inject({
      method: 'POST',
      url: `${BASE}/servers/${server.id}/command`,
      headers: authHeaders(user),
      payload: { command: 'say hello' },
    });
    expect(command.statusCode).toBe(202);
    expect(command.json()).toEqual({ accepted: true });

    const stats = await app.inject({
      method: 'GET',
      url: `${BASE}/servers/${server.id}/stats`,
      headers: authHeaders(user),
    });
    expect(stats.statusCode).toBe(200);
    expect(stats.json().serverId).toBe(server.id);

    // Regression: minecraft-java stops with `stop` on stdin and a 120s timeout, and
    // `stopInternal` polls `inspect` until the container exits. A driver that recorded the
    // command without acting on it made every graceful stop block for the whole timeout —
    // the request simply never came back. This must complete in seconds, not minutes.
    const stopStarted = Date.now();
    const stopped = await app.inject({
      method: 'POST',
      url: `${BASE}/servers/${server.id}/power`,
      headers: authHeaders(user),
      payload: { action: 'stop' },
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().status).toBe('offline');
    expect(stopped.json().lastExitCode).toBe(0);
    expect(Date.now() - stopStarted).toBeLessThan(15_000);

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
    const user = await createTestUser('owner');
    const created = await app.inject({
      method: 'POST',
      url: `${BASE}/servers`,
      headers: authHeaders(user),
      payload: paperBody('Never Installed'),
    });
    const server = created.json();

    // `provisioning` permits only `start`, which installs — see ALLOWED_POWER_ACTIONS.
    for (const action of ['stop', 'restart', 'kill'] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `${BASE}/servers/${server.id}/power`,
        headers: authHeaders(user),
        payload: { action },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('invalid_state');
    }
  });

  it('installs and boots a server created with startOnCreate off', async () => {
    const user = await createTestUser('owner');
    const created = await app.inject({
      method: 'POST',
      url: `${BASE}/servers`,
      headers: authHeaders(user),
      payload: paperBody('Set Up Later'),
    });
    const server = created.json();
    expect(server.status).toBe('provisioning');

    // Without this, `provisioning` is a dead end reachable straight from the create
    // endpoint: reinstall refuses the status outright and nothing else can install it.
    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/servers/${server.id}/power`,
      headers: authHeaders(user),
      payload: { action: 'start' },
    });
    expect(response.statusCode).toBe(200);
    expect(['starting', 'running']).toContain(response.json().status);
  });

  it('validates the blueprint variables it was given', async () => {
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

describe('the address a player is shown', () => {
  it('is the connect string on the card, the detail and the network tab alike', async () => {
    const user = await createTestUser('owner');
    const created = await app.inject({
      method: 'POST',
      url: `${BASE}/servers`,
      headers: authHeaders(user),
      payload: paperBody('Creative Build'),
    });
    const serverId = created.json().id as string;

    // A real (non-`.local`) zone is the operator's own DNS, so the hostname is presented as
    // live — which is what makes the friendly form the answer rather than the IP fallback.
    const zoned = await app.inject({
      method: 'PUT',
      url: `${BASE}/network/zone`,
      headers: authHeaders(user),
      payload: { zone: 'games.example.com' },
    });
    expect(zoned.statusCode).toBe(200);

    const network = await app.inject({
      method: 'GET',
      url: `${BASE}/servers/${serverId}/network`,
      headers: authHeaders(user),
    });
    const expected = network.json().connectString as string;
    expect(expected).toContain('creative-build.games.example.com');

    const detail = await app.inject({
      method: 'GET',
      url: `${BASE}/servers/${serverId}`,
      headers: authHeaders(user),
    });
    expect(detail.json().connectString).toBe(expected);

    const list = await app.inject({
      method: 'GET',
      url: `${BASE}/servers`,
      headers: authHeaders(user),
    });
    expect(list.json().data[0].primaryAddress).toBe(expected);
  });

  it('never puts a bind address where a connect address belongs', async () => {
    const user = await createTestUser('owner');
    const created = await app.inject({
      method: 'POST',
      url: `${BASE}/servers`,
      headers: authHeaders(user),
      payload: paperBody('Bind Check'),
    });
    const serverId = created.json().id as string;

    const detail = await app.inject({
      method: 'GET',
      url: `${BASE}/servers/${serverId}`,
      headers: authHeaders(user),
    });
    const list = await app.inject({
      method: 'GET',
      url: `${BASE}/servers`,
      headers: authHeaders(user),
    });

    // `0.0.0.0` is a listen address. Handing it to someone under a "copy this" button is
    // worse than showing nothing, because it looks like it should work.
    expect(detail.json().connectString).not.toContain('0.0.0.0');
    expect(list.json().data[0].primaryAddress).not.toContain('0.0.0.0');
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

describe('error envelopes', () => {
  /**
   * Regression: `routes/proposals.ts` declares `409: approvalOutcomeSchema` and
   * `/system/ready` declares `503: readinessSchema`. Fastify serialises a reply against
   * `schema.response[statusCode]`, so before `sendError` bypassed that, every PlatterError
   * mapping to one of those codes was validated against the route's *success* shape,
   * failed, and came back as a 500 "internal error" with the real cause discarded.
   */
  it('returns a real error envelope on a route that declares a body for that status', async () => {
    const user = await createTestUser('owner');
    const created = await app.inject({
      method: 'POST',
      url: `${BASE}/servers`,
      headers: authHeaders(user),
      payload: paperBody('Proposal Host'),
    });
    const server = created.json();

    // No such proposal -> notFound (404) through the same handler.
    const missing = await app.inject({
      method: 'POST',
      url: `${BASE}/servers/${server.id}/proposals/mpr_does_not_exist/approve`,
      headers: authHeaders(user),
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');
    expect(missing.json().error.message).not.toBe('Something went wrong on our side.');
  });

  it('keeps /system/ready readable even though it declares a 503 body', async () => {
    const response = await app.inject({ method: 'GET', url: `${BASE}/system/ready` });
    // Either the readiness report (200) or a proper envelope — never a serialisation 500.
    expect([200, 503]).toContain(response.statusCode);
    expect(response.statusCode).not.toBe(500);
  });

  it('answers an unknown route with the standard envelope', async () => {
    const response = await app.inject({ method: 'GET', url: `${BASE}/nope` });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({ code: 'not_found' });
  });
});
