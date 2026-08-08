import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModVersion } from '../registry.js';

/**
 * The approval gate, end to end.
 *
 * The database is a real SQLite file with the shipped schema and the installer really writes
 * files; only the Modrinth provider is replaced, by a mutable in-memory graph. Mutating that
 * graph between `propose` and `approve` is exactly the attack the gate exists to catch, and it
 * is what most of these tests do.
 */

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workdir = await mkdtemp(path.join(tmpdir(), 'platter-proposals-'));

process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] = `file:${path.join(workdir, 'test.db')}`;
process.env['DATA_DIR'] = path.join(workdir, 'data');
process.env['JWT_SECRET'] = 'test-secret-that-is-long-enough-to-pass';
// CurseForge must stay unconfigured here: the point is that everything works without it.
delete process.env['CURSEFORGE_API_KEY'];

execFileSync(path.join(apiRoot, 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
  cwd: apiRoot,
  env: process.env,
  stdio: 'ignore',
});

/** The provider's answers, mutable so a test can move upstream under a pending proposal. */
const graph = vi.hoisted(() => ({
  projects: new Map<string, unknown>(),
  versions: new Map<string, unknown>(),
}));

vi.mock('../modrinth.js', () => ({
  createModrinthProvider: () => ({
    source: 'modrinth',
    search: async () => ({ hits: [], total: 0, offset: 0, limit: 20 }),
    getProject: async (ref: string) => {
      const found = graph.projects.get(ref);
      if (!found) throw new Error(`no project ${ref}`);
      return found;
    },
    listVersions: async (ref: string) =>
      [...graph.versions.values()].filter((entry) => (entry as ModVersion).projectId === ref),
    getVersion: async (versionRef: string) => {
      const found = graph.versions.get(versionRef);
      if (!found) throw new Error(`no version ${versionRef}`);
      return found;
    },
  }),
}));

const { prisma } = await import('../../db.js');
const { resetModProviders } = await import('../registry.js');
const { readModManifest } = await import('../install.js');
const proposals = await import('../../services/proposals.js');

const NODE_ID = 'nod_test';
const OWNER_ID = 'usr_test';
const SERVER_ID = 'srv_test';

const JAR = Buffer.from('PK\x03\x04 pretend jar bytes');
const JAR_SHA512 = createHash('sha512').update(JAR).digest('hex');

const REVIEWER = { reviewerId: OWNER_ID, reviewerName: 'Ada' };

function detail(
  projectId: string,
  title: string,
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    source: 'modrinth',
    projectId,
    slug: projectId,
    title,
    summary: `${title} does a thing.`,
    author: 'someone',
    iconUrl: `https://cdn.modrinth.com/data/${projectId}/icon.png`,
    downloads: 1000,
    follows: 10,
    categories: ['utility'],
    loaders: ['fabric'],
    gameVersions: ['1.21.4'],
    clientSide: 'optional',
    serverSide: 'required',
    license: 'MIT',
    projectType: 'mod',
    updatedAt: '2026-02-01T00:00:00Z',
    url: `https://modrinth.com/mod/${projectId}`,
    description: `# ${title}\n\nThe full body a reviewer reads.`,
    descriptionFormat: 'markdown',
    gallery: [
      {
        url: `https://cdn.modrinth.com/data/${projectId}/gallery/1.png`,
        title: 'Shot',
        description: null,
        featured: true,
      },
    ],
    licenseUrl: 'https://example.test/mit',
    sourceUrl: `https://github.com/example/${projectId}`,
    issuesUrl: `https://github.com/example/${projectId}/issues`,
    wikiUrl: null,
    discordUrl: null,
    donationUrls: [],
    ...overrides,
  };
}

function version(
  projectId: string,
  versionId: string,
  overrides: Partial<ModVersion> = {},
): ModVersion {
  return {
    source: 'modrinth',
    projectId,
    versionId,
    name: versionId,
    versionNumber: versionId,
    channel: 'release',
    gameVersions: ['1.21.4'],
    loaders: ['fabric'],
    publishedAt: '2026-02-01T00:00:00Z',
    downloads: 100,
    dependencies: [],
    file: {
      filename: `${projectId}-${versionId}.jar`,
      url: `https://cdn.modrinth.com/data/${projectId}/versions/${versionId}/${projectId}.jar`,
      sizeBytes: JAR.byteLength,
      sha512: JAR_SHA512,
      sha1: null,
    },
    changelog: 'Fixed things.',
    ...overrides,
  };
}

function seedGraph(): void {
  graph.projects.clear();
  graph.versions.clear();
  graph.projects.set('carpet', detail('carpet', 'Carpet'));
  graph.projects.set('fabric-api', detail('fabric-api', 'Fabric API'));
  graph.versions.set(
    'carpet-1',
    version('carpet', 'carpet-1', {
      dependencies: [
        {
          source: 'modrinth',
          projectId: 'fabric-api',
          versionId: null,
          kind: 'required',
          fileName: null,
        },
      ],
    }),
  );
  graph.versions.set('fapi-1', version('fabric-api', 'fapi-1'));
}

async function seedServer(): Promise<void> {
  await prisma.setting.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.server.deleteMany({});
  await prisma.node.deleteMany({});
  await prisma.user.deleteMany({});

  await prisma.user.create({
    data: {
      id: OWNER_ID,
      email: 'ada@example.test',
      username: 'ada',
      displayName: 'Ada',
      passwordHash: 'x',
      role: 'owner',
    },
  });
  await prisma.node.create({
    data: {
      id: NODE_ID,
      name: 'local',
      driver: 'mock',
      endpoint: '/var/run/docker.sock',
      publicHost: '127.0.0.1',
      portRangeStart: 25000,
      portRangeEnd: 25999,
      memoryTotalMb: 8192,
      diskTotalMb: 102_400,
      cpuCores: 4,
    },
  });
  await prisma.server.create({
    data: {
      id: SERVER_ID,
      name: 'Test Server',
      blueprintKey: 'minecraft-java',
      nodeId: NODE_ID,
      ownerId: OWNER_ID,
      status: 'offline',
      memoryMb: 4096,
      diskMb: 10_240,
      cpuCores: 2,
      variables: JSON.stringify({ EULA: 'true', TYPE: 'FABRIC', VERSION: '1.21.4' }),
    },
  });
}

async function server(): Promise<Awaited<ReturnType<typeof prisma.server.findUniqueOrThrow>>> {
  return prisma.server.findUniqueOrThrow({ where: { id: SERVER_ID } });
}

const serveJar = vi.fn(async () => new Response(JAR, { status: 200 }));

beforeEach(async () => {
  seedGraph();
  resetModProviders();
  serveJar.mockClear();
  vi.stubGlobal('fetch', serveJar);
  await rm(path.join(workdir, 'data', 'servers'), { recursive: true, force: true });
  await seedServer();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma.$disconnect();
  await rm(workdir, { recursive: true, force: true });
});

function propose(rationale = 'Adds the admin commands the operator asked for.') {
  return server().then((row) =>
    proposals.propose({
      server: row,
      source: 'modrinth',
      projectRef: 'carpet',
      rationale,
      proposedById: null,
      proposedByName: 'Assistant',
    }),
  );
}

describe('propose', () => {
  it('snapshots the full detail and version the reviewer will be shown', async () => {
    const proposal = await propose();

    expect(proposal.status).toBe('pending');
    expect(proposal.proposedByName).toBe('Assistant');
    // Everything the approval screen renders has to be in the record, not fetched later.
    expect(proposal.snapshot.detail.description).toContain('The full body a reviewer reads.');
    expect(proposal.snapshot.detail.gallery).toHaveLength(1);
    expect(proposal.snapshot.detail.license).toBe('MIT');
    expect(proposal.snapshot.detail.issuesUrl).toContain('/issues');
    expect(proposal.snapshot.version.file.sha512).toBe(JAR_SHA512);
    expect(proposal.snapshot.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resolves the dependency chain into the snapshot', async () => {
    const proposal = await propose();
    expect(proposal.snapshot.resolution.install.map((entry) => entry.projectId)).toEqual([
      'carpet',
      'fabric-api',
    ]);
    expect(proposal.snapshot.resolution.installable).toBe(true);
  });

  it('installs nothing', async () => {
    await propose();
    expect(serveJar).not.toHaveBeenCalled();
    expect(await readModManifest(SERVER_ID)).toEqual([]);
  });

  it('refuses a second pending proposal for the same mod', async () => {
    await propose();
    await expect(propose()).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses to auto-select when the mod has no version this server can load', async () => {
    // Paper cannot load a Fabric mod, and there is nothing to snapshot for a reviewer.
    await prisma.server.update({
      where: { id: SERVER_ID },
      data: { variables: JSON.stringify({ EULA: 'true', TYPE: 'PAPER', VERSION: '1.21.4' }) },
    });

    await expect(propose()).rejects.toMatchObject({
      code: 'conflict',
      // The refusal names the constraint that failed, never a bare "no compatible version".
      message: expect.stringContaining('paper, spigot, bukkit'),
    });
  });

  it('stores a pinned version that does not fit, so the reviewer sees why', async () => {
    await prisma.server.update({
      where: { id: SERVER_ID },
      data: { variables: JSON.stringify({ EULA: 'true', TYPE: 'PAPER', VERSION: '1.21.4' }) },
    });

    const proposal = await proposals.propose({
      server: await server(),
      source: 'modrinth',
      projectRef: 'carpet',
      versionRef: 'carpet-1',
      rationale: 'Someone asked for this specific build.',
      proposedById: null,
      proposedByName: 'Assistant',
    });

    expect(proposal.status).toBe('pending');
    expect(proposal.snapshot.resolution.installable).toBe(false);
    expect(proposal.snapshot.resolution.problems.some((entry) => entry.severity === 'error')).toBe(
      true,
    );
  });
});

describe('approve', () => {
  it('installs when nothing has changed, and records what landed', async () => {
    const proposal = await propose();
    const outcome = await proposals.approve(await server(), proposal.id, REVIEWER);

    expect(outcome.status).toBe('installed');
    expect(outcome.changes).toEqual([]);
    expect(outcome.installed.map((entry) => entry.projectId)).toEqual(['carpet', 'fabric-api']);

    const manifest = await readModManifest(SERVER_ID);
    expect(manifest).toHaveLength(2);
    expect(manifest[0]?.sha512).toBe(JAR_SHA512);
    expect(manifest[0]?.installedByName).toBe('Ada');
    expect(manifest[0]?.proposalId).toBe(proposal.id);
    expect(manifest[0]?.target).toBe('mods');

    expect((await proposals.getProposal(SERVER_ID, proposal.id)).status).toBe('approved');
  });

  it('audits the approval and every file it wrote', async () => {
    const proposal = await propose();
    await proposals.approve(await server(), proposal.id, REVIEWER);

    const entries = await prisma.auditLog.findMany({ orderBy: { id: 'asc' } });
    const applied = entries.find((entry) => entry.action === 'ai.fix_applied');
    expect(applied?.actorName).toBe('Ada');
    expect(JSON.parse(applied?.metadata ?? '{}')).toMatchObject({
      kind: 'mod_proposal',
      proposalId: proposal.id,
      mod: 'Carpet',
    });
    expect(entries.filter((entry) => entry.action === 'file.written')).toHaveLength(2);
  });

  it('refuses to install when the published checksum moved, and installs nothing', async () => {
    const proposal = await propose();

    // The file behind the same version id is now different bytes. This is the attack.
    graph.versions.set(
      'carpet-1',
      version('carpet', 'carpet-1', {
        dependencies: [
          {
            source: 'modrinth',
            projectId: 'fabric-api',
            versionId: null,
            kind: 'required',
            fileName: null,
          },
        ],
        file: {
          filename: 'carpet-carpet-1.jar',
          url: 'https://cdn.modrinth.com/data/carpet/versions/carpet-1/carpet.jar',
          sizeBytes: JAR.byteLength,
          sha512: 'f'.repeat(128),
          sha1: null,
        },
      }),
    );

    const outcome = await proposals.approve(await server(), proposal.id, REVIEWER);

    expect(outcome.status).toBe('changed');
    expect(outcome.installed).toEqual([]);
    expect(serveJar).not.toHaveBeenCalled();
    expect(outcome.changes.find((change) => change.field === 'sha512')?.material).toBe(true);
    expect(await readModManifest(SERVER_ID)).toEqual([]);
    // Still pending — a drift is not a rejection, it is a question for the reviewer.
    expect((await proposals.getProposal(SERVER_ID, proposal.id)).status).toBe('pending');
    expect((await proposals.getProposal(SERVER_ID, proposal.id)).driftDetectedAt).not.toBeNull();
  });

  it('flags a dependency set that changed since the proposal was raised', async () => {
    const proposal = await propose();

    graph.projects.set('sneaky', detail('sneaky', 'Sneaky Extra'));
    graph.versions.set('sneaky-1', version('sneaky', 'sneaky-1'));
    graph.versions.set(
      'carpet-1',
      version('carpet', 'carpet-1', {
        dependencies: [
          {
            source: 'modrinth',
            projectId: 'fabric-api',
            versionId: null,
            kind: 'required',
            fileName: null,
          },
          {
            source: 'modrinth',
            projectId: 'sneaky',
            versionId: null,
            kind: 'required',
            fileName: null,
          },
        ],
      }),
    );

    const outcome = await proposals.approve(await server(), proposal.id, REVIEWER);

    expect(outcome.status).toBe('changed');
    const change = outcome.changes.find((entry) => entry.field === 'requires');
    expect(change?.material).toBe(true);
    expect(change?.after).toContain('sneaky');
    // The new dependency is visible in the re-resolved plan, so the reviewer sees the whole
    // thing that would land — not just that something moved.
    expect(outcome.resolution.install.map((entry) => entry.projectId)).toContain('sneaky');
    expect(await readModManifest(SERVER_ID)).toEqual([]);
  });

  it('installs the changed version once the reviewer acknowledges the new digest', async () => {
    const proposal = await propose();
    graph.versions.set('carpet-1', version('carpet', 'carpet-1'));

    const first = await proposals.approve(await server(), proposal.id, REVIEWER);
    expect(first.status).toBe('changed');

    const second = await proposals.approve(await server(), proposal.id, {
      ...REVIEWER,
      acknowledgedDigest: first.digest,
    });
    expect(second.status).toBe('installed');
    expect(await readModManifest(SERVER_ID)).toHaveLength(1);
  });

  it('rejects a stale acknowledgement rather than treating it as consent', async () => {
    const proposal = await propose();
    graph.versions.set('carpet-1', version('carpet', 'carpet-1'));

    const outcome = await proposals.approve(await server(), proposal.id, {
      ...REVIEWER,
      acknowledgedDigest: proposal.snapshot.digest,
    });
    expect(outcome.status).toBe('changed');
    expect(await readModManifest(SERVER_ID)).toEqual([]);
  });

  it('reports a plan that no longer resolves against the server', async () => {
    const proposal = await propose();
    // The operator switched the server to Paper while the proposal sat in the queue.
    await prisma.server.update({
      where: { id: SERVER_ID },
      data: { variables: JSON.stringify({ EULA: 'true', TYPE: 'PAPER', VERSION: '1.21.4' }) },
    });

    const outcome = await proposals.approve(await server(), proposal.id, REVIEWER);
    expect(outcome.status).toBe('blocked');
    expect(outcome.installed).toEqual([]);
    expect(outcome.resolution.problems.some((entry) => entry.severity === 'error')).toBe(true);
  });

  it('refuses to approve a proposal twice', async () => {
    const proposal = await propose();
    await proposals.approve(await server(), proposal.id, REVIEWER);
    await expect(proposals.approve(await server(), proposal.id, REVIEWER)).rejects.toMatchObject({
      code: 'invalid_state',
    });
  });

  it('records the failure on the proposal when the download does not verify', async () => {
    const proposal = await propose();
    vi.stubGlobal(
      'fetch',
      async () => new Response(Buffer.from('different bytes'), { status: 200 }),
    );

    await expect(proposals.approve(await server(), proposal.id, REVIEWER)).rejects.toMatchObject({
      code: 'conflict',
    });

    const stored = await proposals.getProposal(SERVER_ID, proposal.id);
    expect(stored.status).toBe('failed');
    expect(stored.error).toContain('checksum');
  });
});

describe('reject and list', () => {
  it('records the reviewer and the note', async () => {
    const proposal = await propose();
    const rejected = await proposals.reject(
      await server(),
      proposal.id,
      'We already run Carpet.',
      REVIEWER,
    );

    expect(rejected.status).toBe('rejected');
    expect(rejected.reviewedByName).toBe('Ada');
    expect(rejected.reviewNote).toBe('We already run Carpet.');
    expect(await readModManifest(SERVER_ID)).toEqual([]);
  });

  it('will not reject something already reviewed', async () => {
    const proposal = await propose();
    await proposals.reject(await server(), proposal.id, null, REVIEWER);
    await expect(
      proposals.reject(await server(), proposal.id, null, REVIEWER),
    ).rejects.toMatchObject({
      code: 'invalid_state',
    });
  });

  it('lists newest first and filters by status', async () => {
    const first = await propose();
    await proposals.reject(await server(), first.id, null, REVIEWER);
    const second = await propose('A second suggestion.');

    const all = await proposals.listProposals(SERVER_ID);
    expect(all.map((entry) => entry.id)).toEqual([second.id, first.id]);
    expect((await proposals.listProposals(SERVER_ID, 'pending')).map((entry) => entry.id)).toEqual([
      second.id,
    ]);
  });

  it('scopes proposals to their server and purges with it', async () => {
    await propose();
    expect(await proposals.listProposals('srv_other')).toEqual([]);
    expect(await proposals.purgeServerProposals(SERVER_ID)).toBe(1);
    expect(await proposals.listProposals(SERVER_ID)).toEqual([]);
  });

  it('404s on an unknown proposal id', async () => {
    await expect(proposals.getProposal(SERVER_ID, 'mpr_nope')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
