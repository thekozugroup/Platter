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
import { prisma } from '../../db.js';
import { modProposalSchema } from '../../services/proposals.js';

/**
 * Every response that carries a proposal must carry proxied artwork.
 *
 * The content security policy is `img-src 'self'`, so a raw registry CDN URL does not render
 * a broken image — it renders nothing, silently, with only a console entry to say why. That
 * is indistinguishable from a mod that has no icon, which is why it survived review: the
 * approval screen looked plausible while every icon on it was blank.
 *
 * The list handler was the path that was missed. The others were wrapped and it was not, and
 * nothing failed, because no test asserted the shape of what these routes return. This one
 * walks all five paths rather than the one that broke, since the next handler added here will
 * be just as easy to forget.
 */

let app: FastifyInstance;
let nodeId: string;

const BASE = API_PREFIX;

/** An allowlisted host, so `proxiedIconUrl` is expected to rewrite rather than drop it. */
const UPSTREAM_ICON = 'https://cdn.modrinth.com/data/P7dR8mSH/icon.png';
const UPSTREAM_DEP_ICON = 'https://cdn.modrinth.com/data/AANobbMI/icon.png';
const UPSTREAM_GALLERY = 'https://cdn.modrinth.com/data/P7dR8mSH/images/shot.png';

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

async function createServer(user: { accessToken: string }): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `${BASE}/servers`,
    headers: authHeaders(user),
    payload: {
      name: 'Icons',
      blueprintKey: 'minecraft-java',
      nodeId,
      variables: { EULA: 'true', TYPE: 'FABRIC', VERSION: '1.21.1' },
      limits: { memoryMb: 2048 },
      startOnCreate: false,
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().id as string;
}

function version(projectId: string, versionId: string) {
  return {
    source: 'modrinth',
    projectId,
    versionId,
    name: versionId,
    versionNumber: '1.0.0',
    gameVersions: ['1.21.1'],
    loaders: ['fabric'],
    file: { filename: `${projectId}.jar`, url: 'https://cdn.modrinth.com/x.jar', sizeBytes: 10 },
  };
}

function plannedInstall(projectId: string, iconUrl: string, reason: 'requested' | 'dependency') {
  return {
    source: 'modrinth',
    projectId,
    slug: projectId.toLowerCase(),
    title: projectId,
    iconUrl,
    target: 'mods',
    version: version(projectId, `ver_${projectId}`),
    reason,
  };
}

/**
 * Written straight to storage rather than produced by `propose`, which would need the whole
 * registry mocked. The claim under test is what the routes do to a proposal on the way out,
 * not how one is built — `src/mods/__tests__/proposals.test.ts` owns that.
 */
async function seedProposal(serverId: string, id = 'prp_test'): Promise<string> {
  const proposal = modProposalSchema.parse({
    id,
    serverId,
    status: 'pending',
    source: 'modrinth',
    projectId: 'P7dR8mSH',
    slug: 'fabric-api',
    title: 'Fabric API',
    versionId: 'ver_P7dR8mSH',
    versionNumber: '1.0.0',
    rationale: 'Every Fabric mod on this server needs it.',
    proposedAt: new Date().toISOString(),
    snapshot: {
      detail: {
        source: 'modrinth',
        projectId: 'P7dR8mSH',
        slug: 'fabric-api',
        title: 'Fabric API',
        summary: 'Core hooks Fabric mods build on.',
        iconUrl: UPSTREAM_ICON,
        url: 'https://modrinth.com/mod/fabric-api',
        gallery: [{ url: UPSTREAM_GALLERY, featured: true }],
      },
      version: version('P7dR8mSH', 'ver_P7dR8mSH'),
      resolution: {
        install: [plannedInstall('P7dR8mSH', UPSTREAM_ICON, 'requested')],
        satisfied: [plannedInstall('AANobbMI', UPSTREAM_DEP_ICON, 'dependency')],
        installable: true,
      },
      digest: 'sha256:seeded',
    },
  });

  await prisma.setting.create({
    data: { key: `mods.proposal.${serverId}.${id}`, value: JSON.stringify(proposal) },
  });

  return id;
}

/** Asserts the shape a browser under `img-src 'self'` can actually load. */
function expectProxied(value: unknown, what: string): void {
  expect(typeof value, `${what} is missing`).toBe('string');
  const url = value as string;
  expect(url, `${what} still points at a CDN`).not.toContain('cdn.modrinth.com/data');
  expect(url, `${what} is not a same-origin proxy link`).toMatch(
    new RegExp(`^${BASE}/servers/[^/]+/mods/icon\\?`),
  );
  expect(url, `${what} is unsigned`).toContain('sig=');
}

function expectProposalProxied(body: unknown): void {
  const proposal = modProposalSchema.parse(body);
  expectProxied(proposal.snapshot.detail.iconUrl, 'the mod icon');
  for (const entry of proposal.snapshot.resolution.install) {
    expectProxied(entry.iconUrl, `the icon for ${entry.title}, which would be installed`);
  }
  for (const entry of proposal.snapshot.resolution.satisfied) {
    expectProxied(entry.iconUrl, `the icon for ${entry.title}, already satisfied`);
  }
}

describe('proposal artwork is same-origin on every response path', () => {
  it('proxies icons in the list, which is the screen a reviewer opens first', async () => {
    const user = await createTestUser('owner');
    const serverId = await createServer(user);
    await seedProposal(serverId);

    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/servers/${serverId}/proposals`,
      headers: authHeaders(user),
    });

    expect(response.statusCode, response.body).toBe(200);
    const [proposal] = response.json().data as unknown[];
    expect(proposal, 'the seeded proposal was not returned').toBeDefined();
    expectProposalProxied(proposal);
  });

  it('proxies icons when a single proposal is fetched', async () => {
    const user = await createTestUser('owner');
    const serverId = await createServer(user);
    const id = await seedProposal(serverId);

    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/servers/${serverId}/proposals/${id}`,
      headers: authHeaders(user),
    });

    expect(response.statusCode, response.body).toBe(200);
    expectProposalProxied(response.json());
  });

  it('proxies icons on the proposal a rejection returns', async () => {
    const user = await createTestUser('owner');
    const serverId = await createServer(user);
    const id = await seedProposal(serverId);

    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/servers/${serverId}/proposals/${id}/reject`,
      headers: authHeaders(user),
      payload: { note: 'Not this one.' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expectProposalProxied(response.json());
  });

  it('leaves an icon the proxy will not sign as null rather than a dead link', async () => {
    // A host off the allowlist cannot be signed. Emitting it anyway would put a URL the
    // proxy refuses in front of the browser; null lets the UI fall back to its placeholder.
    const user = await createTestUser('owner');
    const serverId = await createServer(user);

    const proposal = modProposalSchema.parse({
      id: 'prp_foreign',
      serverId,
      status: 'pending',
      source: 'modrinth',
      projectId: 'P7dR8mSH',
      slug: 'fabric-api',
      title: 'Fabric API',
      versionId: 'ver_P7dR8mSH',
      versionNumber: '1.0.0',
      rationale: 'Testing a host the proxy will not sign.',
      proposedAt: new Date().toISOString(),
      snapshot: {
        detail: {
          source: 'modrinth',
          projectId: 'P7dR8mSH',
          slug: 'fabric-api',
          title: 'Fabric API',
          summary: 'Core hooks Fabric mods build on.',
          iconUrl: 'https://icons.example.invalid/evil.png',
          url: 'https://modrinth.com/mod/fabric-api',
        },
        version: version('P7dR8mSH', 'ver_P7dR8mSH'),
        resolution: { install: [], satisfied: [], installable: true },
        digest: 'sha256:seeded',
      },
    });
    await prisma.setting.create({
      data: {
        key: `mods.proposal.${serverId}.prp_foreign`,
        value: JSON.stringify(proposal),
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/servers/${serverId}/proposals/prp_foreign`,
      headers: authHeaders(user),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().snapshot.detail.iconUrl).toBeNull();
  });
});
