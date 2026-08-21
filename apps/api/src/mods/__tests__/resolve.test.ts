import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatterError } from '@platter/shared';
import { createModrinthProvider } from '../modrinth.js';
import type { ModDetail, ModSource, ModVersion } from '../registry.js';
import {
  acceptedLoaders,
  chooseCompatibleVersion,
  installTargetFor,
  resolveModInstall,
  type InstalledMod,
  type ModLookup,
  type ModServerContext,
} from '../resolve.js';

/**
 * No live network anywhere in this file: the Modrinth client is driven by an injected `fetch`
 * over real-shaped payloads, resolution runs against a hand-built dependency graph, and the
 * installer downloads from a stubbed `fetch` into a temporary directory.
 */

const workdir = await mkdtemp(path.join(tmpdir(), 'platter-mods-'));

process.env['NODE_ENV'] = 'test';
process.env['DATA_DIR'] = path.join(workdir, 'data');
process.env['JWT_SECRET'] = 'test-secret-that-is-long-enough-to-pass';

// Imported after DATA_DIR is set: `config` reads the environment once, at module load, and
// the installer resolves every path against it.
const { installModFile, readModManifest, recordInstalledMod, MAX_MOD_FILE_BYTES } =
  await import('../install.js');
const { serverDataDir } = await import('../../services/lifecycle.js');

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function detail(overrides: Partial<ModDetail> & { projectId: string; title: string }): ModDetail {
  return {
    source: 'modrinth',
    slug: overrides.projectId,
    summary: '',
    author: 'someone',
    iconUrl: null,
    downloads: 0,
    follows: 0,
    categories: [],
    loaders: [],
    gameVersions: [],
    clientSide: 'optional',
    serverSide: 'required',
    license: 'MIT',
    projectType: 'mod',
    updatedAt: null,
    url: `https://modrinth.com/mod/${overrides.projectId}`,
    description: '',
    descriptionFormat: 'markdown',
    gallery: [],
    licenseUrl: null,
    sourceUrl: null,
    issuesUrl: null,
    wikiUrl: null,
    discordUrl: null,
    donationUrls: [],
    ...overrides,
  };
}

interface VersionOptions {
  projectId: string;
  versionId: string;
  gameVersions?: string[];
  loaders?: string[];
  channel?: ModVersion['channel'];
  publishedAt?: string;
  requires?: Array<{ projectId: string; versionId?: string | null }>;
  incompatibleWith?: string[];
  url?: string;
  sha512?: string | null;
}

function version(options: VersionOptions): ModVersion {
  return {
    source: 'modrinth',
    projectId: options.projectId,
    versionId: options.versionId,
    name: options.versionId,
    versionNumber: options.versionId,
    channel: options.channel ?? 'release',
    gameVersions: options.gameVersions ?? ['1.21.4'],
    loaders: options.loaders ?? ['fabric'],
    publishedAt: options.publishedAt ?? '2026-01-01T00:00:00Z',
    downloads: 10,
    dependencies: [
      ...(options.requires ?? []).map((entry) => ({
        source: 'modrinth' as ModSource,
        projectId: entry.projectId,
        versionId: entry.versionId ?? null,
        kind: 'required' as const,
        fileName: null,
      })),
      ...(options.incompatibleWith ?? []).map((projectId) => ({
        source: 'modrinth' as ModSource,
        projectId,
        versionId: null,
        kind: 'incompatible' as const,
        fileName: null,
      })),
    ],
    file: {
      filename: `${options.projectId}-${options.versionId}.jar`,
      url:
        options.url ??
        `https://cdn.modrinth.com/data/${options.projectId}/${options.versionId}.jar`,
      sizeBytes: 1024,
      sha512: options.sha512 === undefined ? 'a'.repeat(128) : options.sha512,
      sha1: null,
    },
    changelog: null,
  };
}

function context(overrides: Partial<ModServerContext> = {}): ModServerContext {
  return {
    serverId: 'srv_test',
    serverName: 'Test',
    blueprintKey: 'minecraft-java',
    serverType: 'FABRIC',
    gameVersion: '1.21.4',
    loaders: acceptedLoaders('FABRIC'),
    target: 'mods',
    installed: [],
    ...overrides,
  };
}

/** A lookup backed by in-memory maps; every resolution test declares its own graph. */
function lookupFor(
  projects: readonly ModDetail[],
  versions: readonly ModVersion[],
): ModLookup & { calls: string[] } {
  const calls: string[] = [];
  const byProject = new Map(projects.map((entry) => [entry.projectId, entry] as const));
  return {
    calls,
    async getProject(_source, ref) {
      calls.push(`project:${ref}`);
      const found = byProject.get(ref);
      if (!found) throw new PlatterError('not_found', 'no such project');
      return found;
    },
    async listVersions(_source, ref) {
      calls.push(`versions:${ref}`);
      return versions.filter((entry) => entry.projectId === ref);
    },
    async getVersion(_source, versionRef) {
      calls.push(`version:${versionRef}`);
      const found = versions.find((entry) => entry.versionId === versionRef);
      if (!found) throw new PlatterError('not_found', 'no such version');
      return found;
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '250' },
  });
}

// ---------------------------------------------------------------------------
// Modrinth client
// ---------------------------------------------------------------------------

describe('modrinth client', () => {
  const searchPayload = {
    hits: [
      {
        project_id: 'AANobbMI',
        project_type: 'mod',
        slug: 'sodium',
        title: 'Sodium',
        description: 'The fastest and most compatible rendering optimisation mod.',
        author: 'jellysquid3',
        categories: ['fabric', 'optimization'],
        display_categories: ['optimization'],
        versions: ['1.21.4', '1.21.1'],
        downloads: 42_000_000,
        follows: 12_345,
        icon_url: 'https://cdn.modrinth.com/data/AANobbMI/icon.png',
        date_modified: '2026-02-01T10:00:00Z',
        license: 'LGPL-3.0-only',
        client_side: 'required',
        server_side: 'unsupported',
        // A field this build has never heard of must not break the parse.
        color: 8_703_084,
      },
    ],
    offset: 0,
    limit: 20,
    total_hits: 1,
  };

  it('parses a real-shaped search response and sends the documented facets', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(searchPayload));
    const provider = createModrinthProvider({ fetch: fetchImpl });

    const result = await provider.search({
      query: 'sodium',
      gameVersion: '1.21.4',
      loaders: ['fabric'],
      categories: [],
      projectType: 'mod',
      serverSideOnly: true,
      limit: 20,
      offset: 0,
    });

    const url = new URL(fetchImpl.mock.calls[0]?.[0] ?? '');
    expect(JSON.parse(url.searchParams.get('facets') ?? '[]')).toEqual([
      ['categories:fabric'],
      ['versions:1.21.4'],
      ['project_type:mod'],
      ['server_side:required', 'server_side:optional'],
    ]);

    const hit = result.hits[0];
    expect(result.total).toBe(1);
    expect(hit?.projectId).toBe('AANobbMI');
    expect(hit?.title).toBe('Sodium');
    expect(hit?.author).toBe('jellysquid3');
    expect(hit?.license).toBe('LGPL-3.0-only');
    expect(hit?.serverSide).toBe('unsupported');
    // `display_categories` wins so loader tags do not leak into the category chips.
    expect(hit?.categories).toEqual(['optimization']);
    expect(hit?.url).toBe('https://modrinth.com/mod/sodium');
  });

  it('asks Modrinth for plugins on a Paper server, not mods', async () => {
    /*
     * Regression. `project_type` used to be rewritten from `plugin` to `mod`, on the belief
     * that Modrinth had no plugin type. It does, and Bukkit-family projects carry it — so the
     * request ANDed `project_type:mod` with `categories:paper|spigot|bukkit` and matched
     * nothing at all. Every search on the most widely run server types returned zero, browse
     * included, while the same project still resolved by name. Verified against the live API:
     * the corrected facets return 12,506 results where the old ones returned 0.
     */
    const fetchImpl = vi.fn(async () => jsonResponse(searchPayload));
    const provider = createModrinthProvider({ fetch: fetchImpl });

    await provider.search({
      query: 'worldedit',
      gameVersion: '1.21.4',
      loaders: ['paper', 'spigot', 'bukkit'],
      categories: [],
      projectType: 'plugin',
      serverSideOnly: true,
      limit: 20,
      offset: 0,
    });

    const url = new URL(fetchImpl.mock.calls[0]?.[0] ?? '');
    const facets = JSON.parse(url.searchParams.get('facets') ?? '[]') as string[][];
    expect(facets).toContainEqual(['project_type:plugin']);
    expect(facets).not.toContainEqual(['project_type:mod']);
  });

  it('asks for both types on a hybrid server, which loads both', async () => {
    // Mohist, Arclight, Magma, Ketting and Crucible run Forge mods *and* Bukkit plugins. The
    // loader list is what says so, so neither type may be guessed away.
    const fetchImpl = vi.fn(async () => jsonResponse(searchPayload));
    const provider = createModrinthProvider({ fetch: fetchImpl });

    await provider.search({
      query: null,
      gameVersion: '1.20.1',
      loaders: ['forge', 'paper', 'spigot', 'bukkit'],
      categories: [],
      projectType: 'plugin',
      serverSideOnly: true,
      limit: 20,
      offset: 0,
    });

    const url = new URL(fetchImpl.mock.calls[0]?.[0] ?? '');
    const facets = JSON.parse(url.searchParams.get('facets') ?? '[]') as string[][];
    const typeFacet = facets.find((group) => group[0]?.startsWith('project_type:')) ?? [];
    expect([...typeFacet].sort()).toEqual(['project_type:mod', 'project_type:plugin']);
  });

  it('sends a descriptive User-Agent', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(searchPayload));
    await createModrinthProvider({ fetch: fetchImpl }).search({
      query: null,
      gameVersion: null,
      loaders: [],
      categories: [],
      projectType: null,
      serverSideOnly: false,
      limit: 5,
      offset: 0,
    });

    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['user-agent']).toMatch(/^Platter\/\d/);
  });

  it('carries the full detail an approval decision needs', async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.includes('/members')) {
        return jsonResponse([
          { role: 'Owner', user: { username: 'jellysquid3', name: 'JellySquid' } },
        ]);
      }
      return jsonResponse({
        id: 'AANobbMI',
        slug: 'sodium',
        project_type: 'mod',
        title: 'Sodium',
        description: 'Rendering optimisation.',
        body: '# Sodium\n\nA long body.',
        categories: ['optimization'],
        additional_categories: ['utility'],
        game_versions: ['1.21.4'],
        loaders: ['fabric'],
        downloads: 42,
        followers: 7,
        icon_url: 'https://cdn.modrinth.com/data/AANobbMI/icon.png',
        issues_url: 'https://github.com/CaffeineMC/sodium/issues',
        source_url: 'https://github.com/CaffeineMC/sodium',
        updated: '2026-02-01T10:00:00Z',
        client_side: 'required',
        server_side: 'unsupported',
        license: {
          id: 'LGPL-3.0-only',
          name: 'LGPL-3.0-only',
          url: 'https://example.test/licence',
        },
        donation_urls: [{ platform: 'GitHub Sponsors', url: 'https://github.com/sponsors/x' }],
        gallery: [
          {
            url: 'https://cdn.modrinth.com/data/AANobbMI/gallery/1.png',
            featured: true,
            title: 'Before',
          },
        ],
      });
    });

    const mod = await createModrinthProvider({ fetch: fetchImpl }).getProject('sodium');

    expect(mod.description).toContain('A long body.');
    expect(mod.gallery[0]?.url).toContain('gallery/1.png');
    expect(mod.author).toBe('JellySquid');
    expect(mod.issuesUrl).toContain('/issues');
    expect(mod.licenseUrl).toBe('https://example.test/licence');
    expect(mod.donationUrls).toHaveLength(1);
    expect(mod.categories).toEqual(['optimization', 'utility']);
  });

  it('reports a 404 as not_found and a 500 as retryable', async () => {
    const missing = createModrinthProvider({
      fetch: async () => new Response('', { status: 404 }),
    });
    await expect(missing.getProject('nope')).rejects.toMatchObject({ code: 'not_found' });

    const broken = createModrinthProvider({ fetch: async () => new Response('', { status: 503 }) });
    await expect(broken.getProject('nope')).rejects.toMatchObject({
      code: 'service_unavailable',
      retryable: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Loader matrix
// ---------------------------------------------------------------------------

describe('install target', () => {
  it('routes a Fabric mod to mods/ and a Paper plugin to plugins/', () => {
    expect(installTargetFor('FABRIC', ['fabric'])).toBe('mods');
    expect(installTargetFor('PAPER', ['paper'])).toBe('plugins');
    expect(installTargetFor('PAPER', ['bukkit', 'spigot'])).toBe('plugins');
  });

  it('refuses a Fabric mod on a Paper server rather than dropping it in plugins/', () => {
    // The failure this whole module exists to prevent: Paper starts, logs nothing, ignores it.
    expect(installTargetFor('PAPER', ['fabric'])).toBeNull();
    expect(installTargetFor('FABRIC', ['paper'])).toBeNull();
  });

  it('sends each half of a hybrid to the right directory', () => {
    expect(installTargetFor('MOHIST', ['forge'])).toBe('mods');
    expect(installTargetFor('MOHIST', ['paper'])).toBe('plugins');
  });

  it('accepts Fabric mods on Quilt but not Forge mods on NeoForge', () => {
    expect(installTargetFor('QUILT', ['fabric'])).toBe('mods');
    expect(installTargetFor('NEOFORGE', ['forge'])).toBeNull();
  });

  it('has no target at all for a server that loads neither', () => {
    expect(installTargetFor('VANILLA', ['fabric'])).toBeNull();
    expect(acceptedLoaders('VANILLA')).toEqual([]);
  });

  it('falls back to the type default when the provider tagged no loader', () => {
    // CurseForge does not tag Bukkit plugin files with a loader.
    expect(installTargetFor('PAPER', [])).toBe('plugins');
  });
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe('resolveModInstall', () => {
  it('follows a transitive chain and names who pulled each mod in', async () => {
    const lookup = lookupFor(
      [
        detail({ projectId: 'root', title: 'Root' }),
        detail({ projectId: 'mid', title: 'Mid' }),
        detail({ projectId: 'leaf', title: 'Leaf' }),
      ],
      [
        version({ projectId: 'root', versionId: 'r1', requires: [{ projectId: 'mid' }] }),
        version({ projectId: 'mid', versionId: 'm1', requires: [{ projectId: 'leaf' }] }),
        version({ projectId: 'leaf', versionId: 'l1' }),
      ],
    );

    const resolution = await resolveModInstall({
      context: context(),
      root: {
        detail: detail({ projectId: 'root', title: 'Root' }),
        version: version({ projectId: 'root', versionId: 'r1', requires: [{ projectId: 'mid' }] }),
      },
      lookup,
    });

    expect(resolution.installable).toBe(true);
    expect(resolution.install.map((entry) => entry.projectId)).toEqual(['root', 'mid', 'leaf']);
    expect(resolution.install[0]?.reason).toBe('requested');
    expect(resolution.install[2]?.reason).toBe('dependency');
    expect(resolution.install[2]?.requiredBy).toEqual(['mid']);
  });

  it('ignores optional and embedded dependencies', async () => {
    const root = version({ projectId: 'root', versionId: 'r1' });
    root.dependencies = [
      {
        source: 'modrinth',
        projectId: 'optional-lib',
        versionId: null,
        kind: 'optional',
        fileName: null,
      },
      {
        source: 'modrinth',
        projectId: 'shaded-lib',
        versionId: null,
        kind: 'embedded',
        fileName: null,
      },
    ];
    const lookup = lookupFor([detail({ projectId: 'root', title: 'Root' })], [root]);

    const resolution = await resolveModInstall({
      context: context(),
      root: { detail: detail({ projectId: 'root', title: 'Root' }), version: root },
      lookup,
    });

    expect(resolution.install).toHaveLength(1);
    expect(lookup.calls).not.toContain('project:optional-lib');
  });

  it('reports a version conflict naming both requesters', async () => {
    const rootVersion = version({
      projectId: 'root',
      versionId: 'r1',
      requires: [{ projectId: 'lib', versionId: 'lib-1' }, { projectId: 'other' }],
    });
    const lookup = lookupFor(
      [
        detail({ projectId: 'root', title: 'Root' }),
        detail({ projectId: 'other', title: 'Other' }),
        detail({ projectId: 'lib', title: 'Shared Library' }),
      ],
      [
        rootVersion,
        version({
          projectId: 'other',
          versionId: 'o1',
          requires: [{ projectId: 'lib', versionId: 'lib-2' }],
        }),
        version({ projectId: 'lib', versionId: 'lib-1' }),
        version({ projectId: 'lib', versionId: 'lib-2' }),
      ],
    );

    const resolution = await resolveModInstall({
      context: context(),
      root: { detail: detail({ projectId: 'root', title: 'Root' }), version: rootVersion },
      lookup,
    });

    const clash = resolution.problems.find((problem) => problem.kind === 'version_conflict');
    expect(clash?.severity).toBe('error');
    expect(clash?.message).toContain('lib-1');
    expect(clash?.message).toContain('lib-2');
    expect(resolution.installable).toBe(false);
  });

  it('detects a cycle, reports it, and still terminates', async () => {
    const a = version({ projectId: 'a', versionId: 'a1', requires: [{ projectId: 'b' }] });
    const b = version({ projectId: 'b', versionId: 'b1', requires: [{ projectId: 'a' }] });
    const lookup = lookupFor(
      [detail({ projectId: 'a', title: 'Alpha' }), detail({ projectId: 'b', title: 'Beta' })],
      [a, b],
    );

    const resolution = await resolveModInstall({
      context: context(),
      root: { detail: detail({ projectId: 'a', title: 'Alpha' }), version: a },
      lookup,
    });

    const cycle = resolution.problems.find((problem) => problem.kind === 'dependency_cycle');
    expect(cycle).toBeDefined();
    // A cycle is legal in practice: both ends install exactly once and it does not block.
    expect(cycle?.severity).toBe('warning');
    expect(resolution.install.map((entry) => entry.projectId).sort()).toEqual(['a', 'b']);
    expect(resolution.installable).toBe(true);
  });

  it('says which constraint failed when nothing is compatible', async () => {
    const lookup = lookupFor(
      [detail({ projectId: 'root', title: 'Sodium' })],
      [
        version({ projectId: 'root', versionId: 'old', gameVersions: ['1.20.1'] }),
        version({
          projectId: 'root',
          versionId: 'neo',
          gameVersions: ['1.21.4'],
          loaders: ['neoforge'],
        }),
      ],
    );

    const resolution = await resolveModInstall({
      context: context(),
      root: {
        detail: detail({ projectId: 'root', title: 'Sodium' }),
        version: version({
          projectId: 'root',
          versionId: 'neo',
          gameVersions: ['1.21.4'],
          loaders: ['neoforge'],
        }),
      },
      lookup,
    });

    const failure = resolution.problems.find((problem) => problem.kind === 'wrong_loader');
    expect(failure?.message).toContain('neoforge');
    expect(failure?.message).toContain('fabric');
    expect(resolution.installable).toBe(false);
  });

  it('names the unsupported game version when the loader is right', async () => {
    const only = version({
      projectId: 'root',
      versionId: 'old',
      gameVersions: ['1.20.1', '1.19.4'],
    });
    const lookup = lookupFor([detail({ projectId: 'root', title: 'Carpet' })], [only]);

    const resolution = await resolveModInstall({
      context: context(),
      root: { detail: detail({ projectId: 'root', title: 'Carpet' }), version: only },
      lookup,
    });

    const failure = resolution.problems.find((problem) => problem.kind === 'no_compatible_version');
    expect(failure?.message).toContain('1.21.4');
    expect(failure?.message).toContain('1.20.1');
  });

  it('turns an installed mod into an update rather than a second install', async () => {
    const installed: InstalledMod = {
      source: 'modrinth',
      projectId: 'lib',
      versionId: 'lib-0',
      slug: 'lib',
      title: 'Shared Library',
      versionNumber: 'lib-0',
      filename: 'lib-lib-0.jar',
      target: 'mods',
      sizeBytes: 10,
      sha512: null,
      sha1: null,
      gameVersions: ['1.21.4'],
      loaders: ['fabric'],
      publishedAt: null,
      installedAt: '2026-01-01T00:00:00Z',
      installedById: null,
      installedByName: null,
      proposalId: null,
    };
    const rootVersion = version({
      projectId: 'root',
      versionId: 'r1',
      requires: [{ projectId: 'lib' }],
    });
    const lookup = lookupFor(
      [
        detail({ projectId: 'root', title: 'Root' }),
        detail({ projectId: 'lib', title: 'Shared Library' }),
      ],
      [rootVersion, version({ projectId: 'lib', versionId: 'lib-1' })],
    );

    const resolution = await resolveModInstall({
      context: context({ installed: [installed] }),
      root: { detail: detail({ projectId: 'root', title: 'Root' }), version: rootVersion },
      lookup,
    });

    const update = resolution.install.find((entry) => entry.projectId === 'lib');
    expect(update?.reason).toBe('update');
    expect(update?.replacesVersionId).toBe('lib-0');
  });

  it('flags an installed mod the server can no longer load', async () => {
    const stale: InstalledMod = {
      source: 'modrinth',
      projectId: 'forge-only',
      versionId: 'f1',
      slug: 'forge-only',
      title: 'Forge Only',
      versionNumber: 'f1',
      filename: 'forge-only.jar',
      target: 'mods',
      sizeBytes: 10,
      sha512: null,
      sha1: null,
      gameVersions: ['1.21.4'],
      loaders: ['forge'],
      publishedAt: null,
      installedAt: '2026-01-01T00:00:00Z',
      installedById: null,
      installedByName: null,
      proposalId: null,
    };
    const rootVersion = version({ projectId: 'root', versionId: 'r1' });
    const lookup = lookupFor([detail({ projectId: 'root', title: 'Root' })], [rootVersion]);

    const resolution = await resolveModInstall({
      context: context({ installed: [stale] }),
      root: { detail: detail({ projectId: 'root', title: 'Root' }), version: rootVersion },
      lookup,
    });

    const problem = resolution.problems.find((entry) => entry.kind === 'incompatible_installed');
    expect(problem?.severity).toBe('warning');
    expect(problem?.message).toContain('forge');
  });

  it('blocks a mod that declares it cannot run beside an installed one', async () => {
    const clash: InstalledMod = {
      source: 'modrinth',
      projectId: 'rival',
      versionId: 'v1',
      slug: 'rival',
      title: 'Rival',
      versionNumber: 'v1',
      filename: 'rival.jar',
      target: 'mods',
      sizeBytes: 10,
      sha512: null,
      sha1: null,
      gameVersions: ['1.21.4'],
      loaders: ['fabric'],
      publishedAt: null,
      installedAt: '2026-01-01T00:00:00Z',
      installedById: null,
      installedByName: null,
      proposalId: null,
    };
    const rootVersion = version({
      projectId: 'root',
      versionId: 'r1',
      incompatibleWith: ['rival'],
    });
    const lookup = lookupFor([detail({ projectId: 'root', title: 'Root' })], [rootVersion]);

    const resolution = await resolveModInstall({
      context: context({ installed: [clash] }),
      root: { detail: detail({ projectId: 'root', title: 'Root' }), version: rootVersion },
      lookup,
    });

    expect(resolution.problems.some((entry) => entry.kind === 'incompatible_with_installed')).toBe(
      true,
    );
    expect(resolution.installable).toBe(false);
  });

  it('warns instead of silently skipping the check on a moving Minecraft version', async () => {
    const rootVersion = version({ projectId: 'root', versionId: 'r1', gameVersions: ['1.16.5'] });
    const lookup = lookupFor([detail({ projectId: 'root', title: 'Root' })], [rootVersion]);

    const resolution = await resolveModInstall({
      context: context({ gameVersion: null }),
      root: { detail: detail({ projectId: 'root', title: 'Root' }), version: rootVersion },
      lookup,
    });

    expect(resolution.problems.some((entry) => entry.kind === 'unknown_game_version')).toBe(true);
    expect(resolution.installable).toBe(true);
  });

  it('prefers a stable release and says so when only a beta fits', async () => {
    const versions = [
      version({
        projectId: 'root',
        versionId: 'beta',
        channel: 'beta',
        publishedAt: '2026-03-01T00:00:00Z',
      }),
      version({
        projectId: 'root',
        versionId: 'stable',
        channel: 'release',
        publishedAt: '2026-02-01T00:00:00Z',
      }),
    ];
    expect(chooseCompatibleVersion(context(), versions).version?.versionId).toBe('stable');

    const onlyBeta = [versions[0]!];
    const choice = chooseCompatibleVersion(context(), onlyBeta);
    expect(choice.version?.versionId).toBe('beta');
    expect(choice.prerelease).toBe(true);
  });

  it('refuses a version whose author disabled third-party downloads', async () => {
    const blocked = version({ projectId: 'root', versionId: 'r1', url: '' });
    const lookup = lookupFor([detail({ projectId: 'root', title: 'Root' })], [blocked]);

    const resolution = await resolveModInstall({
      context: context(),
      root: { detail: detail({ projectId: 'root', title: 'Root' }), version: blocked },
      lookup,
    });

    // A version that cannot be fetched is not a candidate, and the message says what to do
    // about it rather than reporting a generic incompatibility.
    expect(resolution.installable).toBe(false);
    const refusal = resolution.problems.find((entry) => entry.kind === 'no_download');
    expect(refusal?.message).toContain('upload the jar');
  });
});

// ---------------------------------------------------------------------------
// Installer
// ---------------------------------------------------------------------------

describe('installModFile', () => {
  const SERVER_ID = 'srv_install';
  const payload = Buffer.from('PK\x03\x04 pretend this is a jar');
  const goodSha512 = createHash('sha512').update(payload).digest('hex');

  function fileFor(overrides: Partial<Parameters<typeof installModFile>[0]['file']> = {}) {
    return {
      filename: 'sodium-0.6.0.jar',
      url: 'https://cdn.modrinth.com/data/AANobbMI/versions/x/sodium-0.6.0.jar',
      sizeBytes: payload.byteLength,
      sha512: goodSha512,
      sha1: null,
      ...overrides,
    };
  }

  const serveBytes = vi.fn(async () => new Response(payload, { status: 200 }));

  beforeEach(async () => {
    serveBytes.mockClear();
    await rm(serverDataDir(SERVER_ID), { recursive: true, force: true });
  });

  it('verifies the published SHA-512 and renames into place', async () => {
    const result = await installModFile({
      serverId: SERVER_ID,
      target: 'mods',
      source: 'modrinth',
      file: fileFor(),
      fetch: serveBytes,
    });

    expect(result.relativePath).toBe('mods/sodium-0.6.0.jar');
    expect(result.sha512).toBe(goodSha512);
    expect((await stat(result.absolutePath)).size).toBe(payload.byteLength);
  });

  it('REJECTS a download whose hash does not match and leaves nothing behind', async () => {
    await expect(
      installModFile({
        serverId: SERVER_ID,
        target: 'mods',
        source: 'modrinth',
        file: fileFor({ sha512: 'b'.repeat(128) }),
        fetch: serveBytes,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    // Neither the final file nor the staging file may survive a failed verification.
    const entries = await readdir(path.join(serverDataDir(SERVER_ID), 'mods'));
    expect(entries).toEqual([]);
  });

  it('refuses a download from a host that is not the source’s own CDN', async () => {
    await expect(
      installModFile({
        serverId: SERVER_ID,
        target: 'mods',
        source: 'modrinth',
        file: fileFor({ url: 'https://evil.test/sodium-0.6.0.jar' }),
        fetch: serveBytes,
      }),
    ).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(serveBytes).not.toHaveBeenCalled();
  });

  it('refuses plain HTTP', async () => {
    await expect(
      installModFile({
        serverId: SERVER_ID,
        target: 'mods',
        source: 'modrinth',
        file: fileFor({ url: 'http://cdn.modrinth.com/x.jar' }),
        fetch: serveBytes,
      }),
    ).rejects.toMatchObject({ code: 'service_unavailable' });
  });

  it('refuses a file the provider published no checksum for', async () => {
    await expect(
      installModFile({
        serverId: SERVER_ID,
        target: 'mods',
        source: 'curseforge',
        file: {
          filename: 'thing.jar',
          url: 'https://edge.forgecdn.net/files/1/2/thing.jar',
          sizeBytes: 10,
          sha512: null,
          sha1: null,
        },
        fetch: serveBytes,
      }),
    ).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(serveBytes).not.toHaveBeenCalled();
  });

  it('verifies the SHA-1 CurseForge publishes when there is no SHA-512', async () => {
    const sha1 = createHash('sha1').update(payload).digest('hex');
    const result = await installModFile({
      serverId: SERVER_ID,
      target: 'plugins',
      source: 'curseforge',
      file: {
        filename: 'plugin.jar',
        url: 'https://mediafilez.forgecdn.net/files/1/2/plugin.jar',
        sizeBytes: payload.byteLength,
        sha512: null,
        sha1,
      },
      fetch: serveBytes,
    });
    expect(result.relativePath).toBe('plugins/plugin.jar');
  });

  it('rejects a traversal in the provider-supplied filename', async () => {
    await expect(
      installModFile({
        serverId: SERVER_ID,
        target: 'mods',
        source: 'modrinth',
        file: fileFor({ filename: '../../etc/evil.jar' }),
        fetch: serveBytes,
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('refuses a file larger than the download limit before fetching it', async () => {
    await expect(
      installModFile({
        serverId: SERVER_ID,
        target: 'mods',
        source: 'modrinth',
        file: fileFor({ sizeBytes: MAX_MOD_FILE_BYTES + 1 }),
        fetch: serveBytes,
      }),
    ).rejects.toMatchObject({ code: 'payload_too_large' });
    expect(serveBytes).not.toHaveBeenCalled();
  });
});

describe('mod manifest', () => {
  const SERVER_ID = 'srv_manifest';

  function record(projectId: string, versionId: string): InstalledMod {
    return {
      source: 'modrinth',
      projectId,
      versionId,
      slug: projectId,
      title: projectId,
      versionNumber: versionId,
      filename: `${projectId}-${versionId}.jar`,
      target: 'mods',
      sizeBytes: 1,
      sha512: null,
      sha1: null,
      gameVersions: ['1.21.4'],
      loaders: ['fabric'],
      publishedAt: null,
      installedAt: new Date().toISOString(),
      installedById: null,
      installedByName: null,
      proposalId: null,
    };
  }

  it('is empty for a server that has never installed anything', async () => {
    expect(await readModManifest('srv_never')).toEqual([]);
  });

  it('keeps exactly one row per project across an update', async () => {
    await recordInstalledMod(SERVER_ID, record('lib', 'v1'));
    await recordInstalledMod(SERVER_ID, record('other', 'v1'));
    await recordInstalledMod(SERVER_ID, record('lib', 'v2'));

    const manifest = await readModManifest(SERVER_ID);
    expect(manifest).toHaveLength(2);
    expect(manifest.find((entry) => entry.projectId === 'lib')?.versionId).toBe('v2');
  });

  it('serialises concurrent writes instead of losing one', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        recordInstalledMod('srv_race', record(`mod-${index}`, 'v1')),
      ),
    );
    expect(await readModManifest('srv_race')).toHaveLength(8);
  });
});
