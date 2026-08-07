import { type Result, fail, ok } from '@platter/shared';
import { describe, expect, it } from 'vitest';
import { gameVersionIndex, makeProject, makeVersion, silentLogger } from './__fixtures__/helpers';
import { type TargetServer, resolveDependencyGraph } from './compat';
import { ModRegistry, acceptedLoaders } from './registry';
import type {
  ModProject,
  ModSearchResult,
  ModVersion,
  ProviderAvailability,
  ProviderClient,
  ResolvedModSearchQuery,
  VersionFilter,
} from './types';

const index = gameVersionIndex();
const fabricServer: TargetServer = { loader: 'fabric', gameVersion: '1.21.1' };

interface StubOptions {
  provider: 'modrinth' | 'curseforge';
  availability?: ProviderAvailability;
  hits?: ModProject[];
  totalHits?: number;
  versions?: ModVersion[];
  searchError?: string;
}

/** A provider client with no HTTP underneath it — the registry is what is under test here. */
function stub(options: StubOptions): ProviderClient & { versionCalls: VersionFilter[] } {
  const versionCalls: VersionFilter[] = [];
  return {
    provider: options.provider,
    versionCalls,
    availability: () => options.availability ?? { available: true },
    async search(_query: ResolvedModSearchQuery): Promise<Result<ModSearchResult>> {
      if (options.searchError) {
        return fail('upstream_error', options.searchError);
      }
      return ok({
        hits: options.hits ?? [],
        offset: 0,
        limit: 20,
        totalHits: options.totalHits ?? (options.hits ?? []).length,
        providers: [options.provider],
        degraded: [],
      });
    },
    async getProject(idOrSlug: string): Promise<Result<ModProject>> {
      const found = (options.hits ?? []).find(
        (hit) => hit.projectId === idOrSlug || hit.slug === idOrSlug
      );
      return found ? ok(found) : fail('not_found', `no ${idOrSlug} on ${options.provider}`);
    },
    async getVersions(_id: string, filter: VersionFilter = {}): Promise<Result<ModVersion[]>> {
      versionCalls.push(filter);
      const all = options.versions ?? [];
      // Mimic real server-side filtering so the two-pass fallback is genuinely exercised.
      if (!filter.loaders?.length && !filter.gameVersions?.length) {
        return ok(all);
      }
      return ok(
        all.filter(
          (version) =>
            (!filter.loaders?.length ||
              version.loaders.some((loader) => filter.loaders?.includes(loader))) &&
            (!filter.gameVersions?.length ||
              version.gameVersions.some((game) => filter.gameVersions?.includes(game)))
        )
      );
    },
    async getVersion(versionId: string): Promise<Result<ModVersion>> {
      const found = (options.versions ?? []).find((version) => version.versionId === versionId);
      return found ? ok(found) : fail('not_found', `no version ${versionId}`);
    },
  };
}

const registry = (providers: ProviderClient[]) =>
  new ModRegistry({ providers, versionIndex: index, logger: silentLogger() });

describe('provider fan-out', () => {
  it('merges results from both providers', async () => {
    const reg = registry([
      stub({ provider: 'modrinth', hits: [makeProject({ slug: 'sodium', title: 'Sodium' })] }),
      stub({
        provider: 'curseforge',
        hits: [
          makeProject({
            provider: 'curseforge',
            id: 'curseforge:1',
            projectId: '1',
            slug: 'jei',
            title: 'JEI',
          }),
        ],
      }),
    ]);

    const result = await reg.search({ query: 'x' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.hits.map((hit) => hit.slug)).toEqual(['sodium', 'jei']);
    expect(result.value.providers).toEqual(['modrinth', 'curseforge']);
    expect(result.value.degraded).toEqual([]);
  });

  it('skips a provider that is not available at all', async () => {
    const reg = registry([
      stub({ provider: 'modrinth', hits: [makeProject()] }),
      stub({
        provider: 'curseforge',
        availability: { available: false, reason: 'no key' },
        hits: [makeProject({ provider: 'curseforge', slug: 'other', title: 'Other' })],
      }),
    ]);

    const result = await reg.search({ query: 'x' });
    expect(result.ok && result.value.providers).toEqual(['modrinth']);
    // Not "degraded" — an unconfigured provider is a settled state, not a failure.
    expect(result.ok && result.value.degraded).toEqual([]);
  });

  it('returns what it has and records the failure when one provider errors', async () => {
    const reg = registry([
      stub({ provider: 'modrinth', hits: [makeProject({ slug: 'sodium' })] }),
      stub({ provider: 'curseforge', searchError: 'CurseForge rate limited us' }),
    ]);

    const result = await reg.search({ query: 'x' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.hits).toHaveLength(1);
    expect(result.value.degraded).toEqual([
      { provider: 'curseforge', reason: 'CurseForge rate limited us' },
    ]);
  });

  it('fails only when nothing answered', async () => {
    const reg = registry([
      stub({ provider: 'modrinth', searchError: 'down' }),
      stub({ provider: 'curseforge', searchError: 'down' }),
    ]);
    const result = await reg.search({ query: 'x' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('upstream_error');
    }
  });

  it('fails clearly when every provider is unconfigured', async () => {
    const reg = registry([
      stub({ provider: 'curseforge', availability: { available: false, reason: 'no key' } }),
    ]);
    const result = await reg.search({ query: 'x' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_supported');
    }
  });

  it('honours an explicit provider restriction', async () => {
    const reg = registry([
      stub({ provider: 'modrinth', hits: [makeProject({ slug: 'a' })] }),
      stub({
        provider: 'curseforge',
        hits: [makeProject({ provider: 'curseforge', slug: 'b', title: 'B' })],
      }),
    ]);

    const result = await reg.search({ query: 'x', providers: ['curseforge'] });
    expect(result.ok && result.value.providers).toEqual(['curseforge']);
  });

  it('rejects an invalid query rather than sending it', async () => {
    const reg = registry([stub({ provider: 'modrinth' })]);
    const result = await reg.search({ limit: 5000 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_input');
    }
  });
});

describe('cross-post dedupe', () => {
  it('drops the same slug published to both platforms, keeping the preferred provider', async () => {
    const reg = registry([
      stub({ provider: 'modrinth', hits: [makeProject({ slug: 'jei', title: 'Just Enough Items' })] }),
      stub({
        provider: 'curseforge',
        hits: [
          makeProject({
            provider: 'curseforge',
            id: 'curseforge:238222',
            projectId: '238222',
            slug: 'jei',
            title: 'Just Enough Items',
          }),
        ],
      }),
    ]);

    const result = await reg.search({ query: 'jei' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.hits).toHaveLength(1);
    // Modrinth is listed first in the registry, so it wins — it permits redistribution and
    // publishes real client/server metadata.
    expect(result.value.hits[0]?.provider).toBe('modrinth');
  });

  it('dedupes on title when the slugs differ', async () => {
    const reg = registry([
      stub({ provider: 'modrinth', hits: [makeProject({ slug: 'sodium', title: 'Sodium' })] }),
      stub({
        provider: 'curseforge',
        hits: [
          makeProject({
            provider: 'curseforge',
            id: 'curseforge:9',
            projectId: '9',
            slug: 'sodium-forge',
            title: '  sodium  ',
          }),
        ],
      }),
    ]);

    const result = await reg.search({ query: 'sodium' });
    expect(result.ok && result.value.hits).toHaveLength(1);
  });

  it('interleaves rather than concatenating, so neither ranking is buried', async () => {
    const mr = ['m1', 'm2', 'm3'].map((slug) => makeProject({ slug, title: slug }));
    const cf = ['c1', 'c2'].map((slug) =>
      makeProject({ provider: 'curseforge', id: `curseforge:${slug}`, projectId: slug, slug, title: slug })
    );
    const reg = registry([
      stub({ provider: 'modrinth', hits: mr }),
      stub({ provider: 'curseforge', hits: cf }),
    ]);

    const result = await reg.search({ query: 'x' });
    expect(result.ok && result.value.hits.map((hit) => hit.slug)).toEqual([
      'm1',
      'c1',
      'm2',
      'c2',
      'm3',
    ]);
  });

  it('applies a numeric sort after the merge, where it is comparable across providers', async () => {
    const reg = registry([
      stub({ provider: 'modrinth', hits: [makeProject({ slug: 'small', downloads: 10 })] }),
      stub({
        provider: 'curseforge',
        hits: [
          makeProject({
            provider: 'curseforge',
            id: 'curseforge:2',
            projectId: '2',
            slug: 'big',
            title: 'Big',
            downloads: 9_000_000,
          }),
        ],
      }),
    ]);

    const result = await reg.search({ query: 'x', sort: 'downloads' });
    expect(result.ok && result.value.hits.map((hit) => hit.slug)).toEqual(['big', 'small']);
  });
});

describe('acceptedLoaders', () => {
  it('expands static inheritance from LOADER_ACCEPTS', () => {
    expect(acceptedLoaders({ loader: 'quilt', gameVersion: '1.21.1' })).toEqual(['quilt', 'fabric']);
    expect(acceptedLoaders({ loader: 'purpur', gameVersion: '1.21.1' })).toEqual([
      'purpur',
      'paper',
      'spigot',
      'bukkit',
    ]);
  });

  it('adds the version-dependent 1.20.1 Forge/NeoForge bridge', () => {
    // Without this the server would never even *fetch* the Forge builds compat.ts would approve.
    expect(acceptedLoaders({ loader: 'neoforge', gameVersion: '1.20.1' })).toContain('forge');
    expect(acceptedLoaders({ loader: 'forge', gameVersion: '1.20.1' })).toContain('neoforge');
    expect(acceptedLoaders({ loader: 'neoforge', gameVersion: '1.20.2' })).toEqual(['neoforge']);
    expect(acceptedLoaders({ loader: 'forge', gameVersion: '1.21.1' })).toEqual(['forge']);
  });
});

describe('resolveForServer', () => {
  const project = makeProject({ slug: 'test-mod', projectId: 'AANobbMI' });

  it('asks the provider to filter by the accepted loaders and game version', async () => {
    const client = stub({
      provider: 'modrinth',
      hits: [project],
      versions: [makeVersion()],
    });
    const result = await registry([client]).resolveForServer('test-mod', {
      loader: 'quilt',
      gameVersion: '1.21.1',
    });

    expect(result.ok).toBe(true);
    expect(client.versionCalls[0]).toEqual({
      loaders: ['quilt', 'fabric'],
      gameVersions: ['1.21.1'],
    });
  });

  it('picks the best-scoring version and lists the rest as alternatives', async () => {
    const client = stub({
      provider: 'modrinth',
      hits: [project],
      versions: [
        makeVersion({ versionId: 'beta', channel: 'beta', publishedAt: '2026-06-01T00:00:00Z' }),
        makeVersion({ versionId: 'release', channel: 'release', publishedAt: '2026-05-01T00:00:00Z' }),
      ],
    });
    const result = await registry([client]).resolveForServer('test-mod', fabricServer);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The release wins on score despite being older — the beta carries a warning penalty.
    expect(result.value.version.versionId).toBe('release');
    expect(result.value.report.verdict).toBe('compatible');
    expect(result.value.alternatives.map((alt) => alt.version.versionId)).toEqual(['beta']);
  });

  it('falls back to an unfiltered fetch so it can explain *why* nothing matches', async () => {
    // "No compatible version" and "no versions at all" are different answers, and the user
    // deserves the one that names the versions this mod does support.
    const client = stub({
      provider: 'modrinth',
      hits: [project],
      versions: [makeVersion({ gameVersions: ['1.20.1'], loaders: ['forge'] })],
    });
    const result = await registry([client]).resolveForServer('test-mod', fabricServer);

    expect(client.versionCalls).toHaveLength(2);
    expect(client.versionCalls[1]).toEqual({ limit: 40 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_found');
      // Names the target it does not work on, and carries every blocker code so the UI can
      // explain the mismatch rather than saying "not found".
      expect(result.error.message).toContain('Fabric 1.21.1');
      expect(result.error.details.blockers).toEqual(
        expect.arrayContaining(['loader_not_accepted', 'game_version_mismatch'])
      );
    }
  });

  it('returns the incompatible candidate and its report when asked to', async () => {
    const client = stub({
      provider: 'modrinth',
      hits: [project],
      versions: [makeVersion({ gameVersions: ['1.20.1'], loaders: ['forge'] })],
    });
    const result = await registry([client]).resolveForServer('test-mod', fabricServer, {
      includeIncompatible: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.report.verdict).toBe('incompatible');
    expect(result.value.report.blockers.map((f) => f.code)).toContain('loader_family_mismatch');
  });

  it('passes the installed set into the compatibility check', async () => {
    const client = stub({ provider: 'modrinth', hits: [project], versions: [makeVersion()] });
    const result = await registry([client]).resolveForServer('test-mod', fabricServer, {
      installed: [{ provider: 'modrinth', projectId: 'AANobbMI', title: 'Test Mod' }],
      includeIncompatible: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.report.blockers.map((f) => f.code)).toContain('already_installed');
  });

  it('resolves a provider-qualified reference directly', async () => {
    const modrinth = stub({ provider: 'modrinth', hits: [project], versions: [makeVersion()] });
    const cf = stub({ provider: 'curseforge' });
    const result = await registry([modrinth, cf]).resolveForServer(
      'modrinth:AANobbMI',
      fabricServer
    );

    expect(result.ok).toBe(true);
    expect(cf.versionCalls).toHaveLength(0);
  });

  it('tries each provider for a bare slug', async () => {
    const modrinth = stub({ provider: 'modrinth' });
    const cf = stub({
      provider: 'curseforge',
      hits: [makeProject({ provider: 'curseforge', id: 'curseforge:5', projectId: '5', slug: 'x' })],
      versions: [makeVersion({ provider: 'curseforge' })],
    });
    const result = await registry([modrinth, cf]).resolveForServer('x', fabricServer);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.project.provider).toBe('curseforge');
  });

  it('reports a reference no provider knows', async () => {
    const result = await registry([stub({ provider: 'modrinth' })]).resolveForServer(
      'nope',
      fabricServer
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_found');
    }
  });
});

describe('the registry as a DependencyResolver', () => {
  it('walks a real dependency chain end to end', async () => {
    const api = makeProject({ id: 'modrinth:api', projectId: 'api', slug: 'fabric-api', title: 'Fabric API' });
    const root = makeProject({ id: 'modrinth:root', projectId: 'root', slug: 'root', title: 'Root' });
    const rootVersion = makeVersion({
      projectId: 'root',
      versionId: 'root-1',
      dependencies: [
        { provider: 'modrinth', projectId: 'api', versionId: null, fileName: null, kind: 'required' },
      ],
    });
    const apiVersion = makeVersion({ projectId: 'api', versionId: 'api-1' });

    const client = stub({ provider: 'modrinth', hits: [root, api], versions: [] });
    // Route getVersions per project so each resolves to its own build.
    client.getVersions = async (id: string) =>
      ok(id === 'api' ? [apiVersion] : [rootVersion]);

    const reg = registry([client]);
    const plan = await resolveDependencyGraph({
      root: { project: root, version: rootVersion },
      server: fabricServer,
      resolver: reg,
    });

    expect(plan.nodes.map((node) => node.project.projectId)).toEqual(['root', 'api']);
    expect(plan.unresolved).toEqual([]);
    expect(plan.truncated).toBe(false);
  });

  it('honours a version-pinned dependency verbatim', async () => {
    // The author named that exact build; substituting a different one second-guesses a
    // constraint whose reason we cannot see.
    const project = makeProject({ projectId: 'AANobbMI' });
    const pinned = makeVersion({ versionId: 's7adptIg' });
    const client = stub({ provider: 'modrinth', hits: [project], versions: [pinned] });
    const reg = registry([client]);

    const result = await reg.resolve(
      {
        provider: 'modrinth',
        projectId: 'AANobbMI',
        versionId: 's7adptIg',
        fileName: null,
        kind: 'required',
      },
      fabricServer
    );

    expect(result.ok && result.value.version.versionId).toBe('s7adptIg');
    // Went straight to the version — no compatibility-driven build selection.
    expect(client.versionCalls).toHaveLength(0);
  });

  it('reports an unconfigured provider instead of silently dropping the edge', async () => {
    const reg = registry([stub({ provider: 'modrinth' })]);
    const result = await reg.resolve(
      { provider: 'curseforge', projectId: '1', versionId: null, fileName: null, kind: 'required' },
      fabricServer
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_supported');
    }
  });
});
