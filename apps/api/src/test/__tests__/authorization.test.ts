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
    data: { id: newId('key'), userId, name: 'test key', prefix, tokenHash, scopes: JSON.stringify(scopes) },
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
      variables: { EULA: 'true', TYPE: 'PAPER', VERSION: '1.21.4', RCON_PASSWORD: 'SUPERSECRET-RCON' },
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
      data: { id: newId('key'), userId: owner.id, name: 'corrupt', prefix, tokenHash, scopes: 'not json' },
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
