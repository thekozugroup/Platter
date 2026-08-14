import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_PREFIX } from '@platter/shared';
import { prisma } from '../../db.js';
import { newId } from '../../lib/ids.js';
import { generateApiKey } from '../../plugins/auth.js';
import {
  apiKeyHeaders,
  authHeaders,
  buildTestApp,
  closeTestHarness,
  createTestUser,
  ensureTestNode,
  resetDatabase,
  type TestUser,
} from '../helpers.js';

/**
 * Authorisation regressions, driven through the real HTTP surface.
 *
 * Each case here corresponds to a hole that was open: an API key's scopes were enforced on
 * MCP and ignored by REST, no endpoint could mint a scoped key in the first place, and a
 * read-only collaborator was handed the server's RCON password in the same JSON as its RCON
 * port. They are written against `app.inject` rather than the services because the services
 * were never the problem — the gap was between the credential and the route.
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

beforeEach(async () => {
  nodeId = await ensureTestNode();
});

afterEach(async () => {
  await resetDatabase();
});

/** Mints a key directly, so a test can pin the scopes without going through the route. */
async function issueKey(userId: string, scopes: readonly string[]): Promise<string> {
  const { token, prefix, tokenHash } = generateApiKey();
  await prisma.apiKey.create({
    data: {
      id: newId('key'),
      userId,
      name: 'test key',
      prefix,
      tokenHash,
      scopes: JSON.stringify(scopes),
    },
  });
  return token;
}

async function createServer(owner: TestUser): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `${BASE}/servers`,
    headers: authHeaders(owner),
    payload: {
      name: 'Scoped Server',
      blueprintKey: 'minecraft-java',
      nodeId,
      variables: {
        EULA: 'true',
        TYPE: 'PAPER',
        VERSION: '1.21.4',
        RCON_PASSWORD: 'SUPERSECRET-RCON',
      },
      limits: { memoryMb: 2048 },
      startOnCreate: false,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

describe('API key scopes on REST', () => {
  /**
   * The audit log is installation-wide for an admin, so scoping it to `server.view` meant an
   * agent key handed out to read one server's status could read every action every user had
   * ever taken — including which servers exist and who owns them. It needs a scope of its own,
   * and an under-scoped key must not be rescued by the operator's role.
   */
  it('refuses the audit log to a key without the audit scope', async () => {
    const admin = await createTestUser('admin');
    const token = await issueKey(admin.id, ['server.view']);

    for (const url of [`${BASE}/audit`, `${BASE}/audit/export`]) {
      const response = await app.inject({ method: 'GET', url, headers: apiKeyHeaders(token) });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('forbidden');
    }

    const scoped = await issueKey(admin.id, ['audit.read']);
    const allowed = await app.inject({
      method: 'GET',
      url: `${BASE}/audit`,
      headers: apiKeyHeaders(scoped),
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('refuses a write with a key scoped only for reads', async () => {
    const owner = await createTestUser('owner');
    const serverId = await createServer(owner);
    const token = await issueKey(owner.id, ['server.view']);

    // The same key over MCP was always refused. This is the REST half of that check.
    const write = await app.inject({
      method: 'PATCH',
      url: `${BASE}/servers/${serverId}`,
      headers: apiKeyHeaders(token),
      payload: { description: 'changed by an under-scoped key' },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.code).toBe('forbidden');

    const files = await app.inject({
      method: 'PUT',
      url: `${BASE}/servers/${serverId}/files/content`,
      headers: apiKeyHeaders(token),
      payload: { path: 'SCOPE_BYPASS.txt', content: 'should never be written' },
    });
    expect(files.statusCode).toBe(403);

    const power = await app.inject({
      method: 'POST',
      url: `${BASE}/servers/${serverId}/power`,
      headers: apiKeyHeaders(token),
      payload: { action: 'start' },
    });
    expect(power.statusCode).toBe(403);
  });

  it('still allows what the key is scoped for', async () => {
    const owner = await createTestUser('owner');
    const serverId = await createServer(owner);
    const token = await issueKey(owner.id, ['server.view']);

    const read = await app.inject({
      method: 'GET',
      url: `${BASE}/servers/${serverId}`,
      headers: apiKeyHeaders(token),
    });
    expect(read.statusCode).toBe(200);
  });

  it('leaves an unscoped key with everything its owner can do', async () => {
    const owner = await createTestUser('owner');
    const serverId = await createServer(owner);
    const token = await issueKey(owner.id, []);

    const write = await app.inject({
      method: 'PATCH',
      url: `${BASE}/servers/${serverId}`,
      headers: apiKeyHeaders(token),
      payload: { description: 'allowed' },
    });
    expect(write.statusCode).toBe(200);
  });

  it('refuses admin routes to any scoped key — no scope expresses them', async () => {
    const owner = await createTestUser('owner');
    const token = await issueKey(owner.id, ['server.view', 'server.create']);

    const nodes = await app.inject({
      method: 'GET',
      url: `${BASE}/nodes`,
      headers: apiKeyHeaders(token),
    });
    expect(nodes.statusCode).toBe(403);
  });

  it('treats an unparseable scopes column as a grant of nothing', async () => {
    const owner = await createTestUser('owner');
    const serverId = await createServer(owner);
    const { token, prefix, tokenHash } = generateApiKey();
    await prisma.apiKey.create({
      data: {
        id: newId('key'),
        userId: owner.id,
        name: 'corrupt',
        prefix,
        tokenHash,
        scopes: 'not json',
      },
    });

    const read = await app.inject({
      method: 'GET',
      url: `${BASE}/servers/${serverId}`,
      headers: apiKeyHeaders(token),
    });
    expect(read.statusCode).toBe(403);
  });
});

describe('minting a scoped key', () => {
  it('persists the scopes the request asked for', async () => {
    const owner = await createTestUser('owner');
    const created = await app.inject({
      method: 'POST',
      url: `${BASE}/auth/keys`,
      headers: authHeaders(owner),
      payload: { name: 'read only', scopes: ['server.view'] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().scopes).toEqual(['server.view']);

    const row = await prisma.apiKey.findUnique({ where: { id: created.json().id as string } });
    expect(row?.scopes).toBe(JSON.stringify(['server.view']));

    // And the minted token is actually restricted, not merely labelled.
    const serverId = await createServer(owner);
    const write = await app.inject({
      method: 'PATCH',
      url: `${BASE}/servers/${serverId}`,
      headers: apiKeyHeaders(created.json().token as string),
      payload: { description: 'nope' },
    });
    expect(write.statusCode).toBe(403);
  });

  it('keeps an unrestricted key unrestricted when no scopes are named', async () => {
    const owner = await createTestUser('owner');
    const created = await app.inject({
      method: 'POST',
      url: `${BASE}/auth/keys`,
      headers: authHeaders(owner),
      payload: { name: 'full access' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().scopes).toEqual([]);
  });

  it('rejects a scope that is not in the vocabulary', async () => {
    const owner = await createTestUser('owner');
    const created = await app.inject({
      method: 'POST',
      url: `${BASE}/auth/keys`,
      headers: authHeaders(owner),
      payload: { name: 'bogus', scopes: ['server.everything'] },
    });
    expect(created.statusCode).toBe(422);
  });
});

describe('secret blueprint variables', () => {
  it('never sends a password-typed variable to a read-only collaborator', async () => {
    const owner = await createTestUser('owner');
    const serverId = await createServer(owner);

    const collaborator = await createTestUser('member');
    await prisma.serverSubuser.create({
      data: {
        id: newId('sub'),
        serverId,
        userId: collaborator.id,
        permissions: JSON.stringify(['server.view']),
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/servers/${serverId}`,
      headers: authHeaders(collaborator),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // The RCON port is in the same payload, so the password reaching it is a direct route
    // to `op <self>` past every permission this account was given.
    expect(body.variables.RCON_PASSWORD).toBe('[redacted]');
    expect(JSON.stringify(body)).not.toContain('SUPERSECRET-RCON');
    expect(body.redactedVariables).toContain('RCON_PASSWORD');
  });

  it('still redacts when the blueprint that declared the secret is gone', async () => {
    const owner = await createTestUser('owner');
    const serverId = await createServer(owner);

    // An operator removing a blueprint file, or an upgrade dropping one, used to turn the
    // whole variable map back into cleartext: the "which variables are secret" question was
    // answered from the blueprint, and a missing blueprint answered "none of them".
    await prisma.server.update({
      where: { id: serverId },
      data: { blueprintKey: 'blueprint-that-was-removed' },
    });

    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/servers/${serverId}`,
      headers: authHeaders(owner),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().variables.RCON_PASSWORD).toBe('[redacted]');
    expect(JSON.stringify(response.json())).not.toContain('SUPERSECRET-RCON');
  });

  it('does not let the redaction placeholder overwrite the real secret', async () => {
    const owner = await createTestUser('owner');
    const serverId = await createServer(owner);

    // Exactly what a settings form that round-trips its whole variable map submits.
    const update = await app.inject({
      method: 'PATCH',
      url: `${BASE}/servers/${serverId}`,
      headers: authHeaders(owner),
      payload: { variables: { RCON_PASSWORD: '[redacted]', MOTD: 'Hello' } },
    });
    expect(update.statusCode).toBe(200);

    const row = await prisma.server.findUnique({ where: { id: serverId } });
    expect(JSON.parse(row?.variables ?? '{}').RCON_PASSWORD).toBe('SUPERSECRET-RCON');
  });

  it('still accepts a genuinely new secret', async () => {
    const owner = await createTestUser('owner');
    const serverId = await createServer(owner);

    const update = await app.inject({
      method: 'PATCH',
      url: `${BASE}/servers/${serverId}`,
      headers: authHeaders(owner),
      payload: { variables: { RCON_PASSWORD: 'a-new-password' } },
    });
    expect(update.statusCode).toBe(200);

    const row = await prisma.server.findUnique({ where: { id: serverId } });
    expect(JSON.parse(row?.variables ?? '{}').RCON_PASSWORD).toBe('a-new-password');
  });
});

describe('admin port binding', () => {
  it('keeps RCON on loopback and the game port on every interface', async () => {
    const owner = await createTestUser('owner');
    const serverId = await createServer(owner);

    const allocations = await prisma.allocation.findMany({ where: { serverId } });
    const rcon = allocations.find((row) => row.portName === 'rcon');
    const game = allocations.find((row) => row.portName === 'game');

    // RCON is plaintext and a successful auth is arbitrary console execution, so the
    // default must not be "reachable from the whole network".
    expect(rcon?.hostIp).toBe('127.0.0.1');
    expect(game?.hostIp).toBe('0.0.0.0');
  });
});

// =======================================================================================
// Round-three findings. Each of these passed a permission check at the HTTP boundary and
// then reached something that checked nothing — which is the shape all three share.
// =======================================================================================

/** A collaborator on `serverId` holding exactly `permissions`. */
async function addCollaborator(
  serverId: string,
  permissions: readonly string[],
): Promise<TestUser> {
  const user = await createTestUser('member');
  await prisma.serverSubuser.create({
    data: {
      id: newId('sub'),
      serverId,
      userId: user.id,
      permissions: JSON.stringify(permissions),
    },
  });
  return user;
}

describe('a schedule costs what its action costs', () => {
  /**
   * `schedules.write` gated create *and* "run now", and the dispatcher in
   * `services/scheduler.ts` executes with no principal at all — so a collaborator who was
   * refused `POST /command` could store the identical command as a schedule and fire it
   * synchronously. `op <self>` on a Minecraft server is full in-game admin.
   */
  it('refuses a command schedule to a collaborator who may not use the console', async () => {
    const owner = await createTestUser('owner');
    const serverId = await createServer(owner);
    const member = await addCollaborator(serverId, [
      'server.view',
      'schedules.read',
      'schedules.write',
    ]);

    const direct = await app.inject({
      method: 'POST',
      url: `${BASE}/servers/${serverId}/command`,
      headers: authHeaders(member),
      payload: { command: 'op member' },
    });
    expect(direct.statusCode).toBe(403);

    const scheduled = await app.inject({
      method: 'POST',
      url: `${BASE}/servers/${serverId}/schedules`,
      headers: authHeaders(member),
      payload: {
        name: 'escalate',
        cron: '0 4 * * *',
        timezone: 'UTC',
        action: 'command',
        payload: 'op member',
      },
    });
    expect(scheduled.statusCode).toBe(403);
    expect(await prisma.schedule.count({ where: { serverId } })).toBe(0);
  });

  it('refuses a stop schedule and a backup schedule on the same grounds', async () => {
    const owner = await createTestUser('owner');
    const serverId = await createServer(owner);
    const member = await addCollaborator(serverId, [
      'server.view',
      'schedules.read',
      'schedules.write',
    ]);

    for (const action of ['stop', 'restart', 'start', 'backup'] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `${BASE}/servers/${serverId}/schedules`,
        headers: authHeaders(member),
        payload: { name: action, cron: '0 4 * * *', timezone: 'UTC', action },
      });
      expect(response.statusCode, `${action} should need its own permission`).toBe(403);
    }
  });

  it('allows the schedule once the matching permission is held', async () => {
    const owner = await createTestUser('owner');
    const serverId = await createServer(owner);
    const member = await addCollaborator(serverId, [
      'server.view',
      'schedules.read',
      'schedules.write',
      'power.stop',
    ]);

    const allowed = await app.inject({
      method: 'POST',
      url: `${BASE}/servers/${serverId}/schedules`,
      headers: authHeaders(member),
      payload: { name: 'nightly stop', cron: '0 4 * * *', timezone: 'UTC', action: 'stop' },
    });
    expect(allowed.statusCode).toBe(201);

    // …and only that one. The grant is per action, not per surface.
    const refused = await app.inject({
      method: 'POST',
      url: `${BASE}/servers/${serverId}/schedules`,
      headers: authHeaders(member),
      payload: { name: 'nightly backup', cron: '0 5 * * *', timezone: 'UTC', action: 'backup' },
    });
    expect(refused.statusCode).toBe(403);
  });

  it('re-checks on "run now", which is the synchronous version of the same escalation', async () => {
    const owner = await createTestUser('owner');
    const serverId = await createServer(owner);
    const member = await addCollaborator(serverId, [
      'server.view',
      'schedules.read',
      'schedules.write',
    ]);

    // Created by the owner, who may do anything — so the collaborator does not need to be
    // able to create it in order to try to fire it.
    const created = await app.inject({
      method: 'POST',
      url: `${BASE}/servers/${serverId}/schedules`,
      headers: authHeaders(owner),
      payload: {
        name: 'ops',
        cron: '0 4 * * *',
        timezone: 'UTC',
        action: 'command',
        payload: 'op member',
      },
    });
    expect(created.statusCode).toBe(201);
    const scheduleId = created.json().id as string;

    const run = await app.inject({
      method: 'POST',
      url: `${BASE}/servers/${serverId}/schedules/${scheduleId}/run`,
      headers: authHeaders(member),
    });
    expect(run.statusCode).toBe(403);
  });

  it('re-checks on the PATCH that would re-point a schedule at a stronger action', async () => {
    const owner = await createTestUser('owner');
    const serverId = await createServer(owner);
    const member = await addCollaborator(serverId, [
      'server.view',
      'schedules.read',
      'schedules.write',
      'power.stop',
    ]);

    const created = await app.inject({
      method: 'POST',
      url: `${BASE}/servers/${serverId}/schedules`,
      headers: authHeaders(member),
      payload: { name: 'stop', cron: '0 4 * * *', timezone: 'UTC', action: 'stop' },
    });
    expect(created.statusCode).toBe(201);

    const repointed = await app.inject({
      method: 'PATCH',
      url: `${BASE}/servers/${serverId}/schedules/${created.json().id as string}`,
      headers: authHeaders(member),
      payload: { action: 'command', payload: 'op member' },
    });
    expect(repointed.statusCode).toBe(403);

    const row = await prisma.schedule.findUnique({ where: { id: created.json().id as string } });
    expect(row?.action).toBe('stop');
  });

  it('refuses a key that lacks the action scope even when the account holds the permission', async () => {
    const owner = await createTestUser('owner');
    const serverId = await createServer(owner);
    // The owner may do anything; the credential may not.
    const token = await issueKey(owner.id, ['server.view', 'schedules.read', 'schedules.write']);

    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/servers/${serverId}/schedules`,
      headers: apiKeyHeaders(token),
      payload: {
        name: 'via key',
        cron: '0 4 * * *',
        timezone: 'UTC',
        action: 'command',
        payload: 'op agent',
      },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('who may rewrite a server access list', () => {
  /**
   * `server.update` was meant to be "change the memory limit". Because the four subuser
   * routes hung off it, it was also "grant yourself `server.delete`" — the collaborator
   * simply PATCHed their own row.
   */
  it('refuses a collaborator with server.update, including on their own row', async () => {
    const owner = await createTestUser('owner');
    const serverId = await createServer(owner);
    const member = await addCollaborator(serverId, ['server.view', 'server.update']);

    const row = await prisma.serverSubuser.findFirstOrThrow({
      where: { serverId, userId: member.id },
    });

    const selfEscalate = await app.inject({
      method: 'PATCH',
      url: `${BASE}/servers/${serverId}/subusers/${row.id}`,
      headers: authHeaders(member),
      payload: { permissions: ['server.view', 'server.update', 'server.delete', 'power.stop'] },
    });
    expect(selfEscalate.statusCode).toBe(403);

    const stored = await prisma.serverSubuser.findUniqueOrThrow({ where: { id: row.id } });
    expect(JSON.parse(stored.permissions)).toEqual(['server.view', 'server.update']);
  });

  it('refuses the list, the invite and the removal to the same collaborator', async () => {
    const owner = await createTestUser('owner');
    const serverId = await createServer(owner);
    const member = await addCollaborator(serverId, ['server.view', 'server.update']);
    const row = await prisma.serverSubuser.findFirstOrThrow({
      where: { serverId, userId: member.id },
    });

    const list = await app.inject({
      method: 'GET',
      url: `${BASE}/servers/${serverId}/subusers`,
      headers: authHeaders(member),
    });
    expect(list.statusCode).toBe(403);

    const invite = await app.inject({
      method: 'POST',
      url: `${BASE}/servers/${serverId}/subusers`,
      headers: authHeaders(member),
      payload: { email: 'nobody@example.test', permissions: ['server.view'] },
    });
    expect(invite.statusCode).toBe(403);

    const remove = await app.inject({
      method: 'DELETE',
      url: `${BASE}/servers/${serverId}/subusers/${row.id}`,
      headers: authHeaders(member),
    });
    expect(remove.statusCode).toBe(403);
    expect(await prisma.serverSubuser.count({ where: { serverId } })).toBe(1);
  });

  it('still lets the owner and an admin manage collaborators', async () => {
    const owner = await createTestUser('owner');
    const serverId = await createServer(owner);
    const guest = await createTestUser('member');

    const invited = await app.inject({
      method: 'POST',
      url: `${BASE}/servers/${serverId}/subusers`,
      headers: authHeaders(owner),
      payload: { email: guest.email, permissions: ['server.view'] },
    });
    expect(invited.statusCode).toBe(201);

    const admin = await createTestUser('admin');
    const listed = await app.inject({
      method: 'GET',
      url: `${BASE}/servers/${serverId}/subusers`,
      headers: authHeaders(admin),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(1);
  });

  it('refuses a scoped key: no scope names "may rewrite who can reach this server"', async () => {
    const owner = await createTestUser('owner');
    const serverId = await createServer(owner);
    const token = await issueKey(owner.id, ['server.view', 'server.update']);

    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/servers/${serverId}/subusers`,
      headers: apiKeyHeaders(token),
    });
    expect(response.statusCode).toBe(403);
  });

  it('answers 404, not 403, to someone with no relationship to the server', async () => {
    const owner = await createTestUser('owner');
    const serverId = await createServer(owner);
    const stranger = await createTestUser('member');

    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/servers/${serverId}/subusers`,
      headers: authHeaders(stranger),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('the account surface refuses a restricted key', () => {
  /**
   * `requireInteractiveSession` covered `/password`, `/totp/*` and key creation, but it was
   * applied handler by handler and `PATCH /me` was missed. Login is by email, so a
   * `server.view`-only key could lock the owner out of their own installation.
   */
  it('will not let a read-only key change the account email', async () => {
    const owner = await createTestUser('owner');
    const token = await issueKey(owner.id, ['server.view']);

    const response = await app.inject({
      method: 'PATCH',
      url: `${BASE}/auth/me`,
      headers: apiKeyHeaders(token),
      payload: { email: 'attacker@evil.test' },
    });
    expect(response.statusCode).toBe(403);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(row.email).toBe(owner.email);
  });

  it('will not let a read-only key change the display name, read /me, or enumerate keys', async () => {
    const owner = await createTestUser('owner');
    const token = await issueKey(owner.id, ['server.view']);

    for (const [method, url, payload] of [
      ['PATCH', `${BASE}/auth/me`, { displayName: 'pwned-by-readonly-key' }],
      ['GET', `${BASE}/auth/me`, undefined],
      ['GET', `${BASE}/auth/keys`, undefined],
      ['POST', `${BASE}/auth/keys`, { name: 'a key minted by a key' }],
      ['POST', `${BASE}/auth/totp/setup`, undefined],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: apiKeyHeaders(token),
        ...(payload ? { payload } : {}),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('still lets an unrestricted key read the profile, and a session do everything', async () => {
    const owner = await createTestUser('owner');
    const unrestricted = await issueKey(owner.id, []);

    const viaKey = await app.inject({
      method: 'GET',
      url: `${BASE}/auth/me`,
      headers: apiKeyHeaders(unrestricted),
    });
    expect(viaKey.statusCode).toBe(200);

    const viaSession = await app.inject({
      method: 'PATCH',
      url: `${BASE}/auth/me`,
      headers: authHeaders(owner),
      payload: { displayName: 'Renamed By Their Own Session' },
    });
    expect(viaSession.statusCode).toBe(200);
    expect(viaSession.json().displayName).toBe('Renamed By Their Own Session');
  });

  it('keeps credential changes on a password session even for an unrestricted key', async () => {
    const owner = await createTestUser('owner');
    const unrestricted = await issueKey(owner.id, []);

    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/auth/password`,
      headers: apiKeyHeaders(unrestricted),
      payload: { currentPassword: owner.password, newPassword: 'Another-password-1!' },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('what the audit log is allowed to remember', () => {
  it('does not store a console command verbatim', async () => {
    const owner = await createTestUser('owner');
    const serverId = await createServer(owner);

    // The server is `provisioning`, so the command is refused — but the route records the
    // audit entry only on success, so drive the redaction through the service the route
    // uses instead of depending on a running container.
    const { redactCommand } = await import('../../lib/redact.js');
    expect(redactCommand('rcon-password hunter2')).toBe('rcon-password [redacted]');
    expect(redactCommand('luckperms user bob setpassword hunter2')).toBe(
      'luckperms user bob setpassword [redacted]',
    );
    expect(redactCommand('login --password=hunter2')).toBe('login --password=[redacted]');
    expect(redactCommand('env RCON_PASSWORD=hunter2')).toBe('env RCON_PASSWORD=[redacted]');
    // The verb and its ordinary arguments survive: an operator reading the log still needs
    // to know that someone ran `op` and on whom.
    expect(redactCommand('op steve')).toBe('op steve');
    expect(redactCommand('say  hello   world')).toBe('say  hello   world');

    expect(serverId).toBeTruthy();
  });
});
