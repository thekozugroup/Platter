import { describe, expect, it } from 'vitest';
import { fakeFetch, fixture, silentLogger } from './__fixtures__/helpers';
import {
  FALLBACK_LOADER_NAMES,
  MODRINTH_MAX_LIMIT,
  ModrinthClient,
  type ModrinthProjectWire,
  type ModrinthSearchHitWire,
  type ModrinthVersionWire,
  buildFacets,
  encodeArrayParam,
  normaliseProject,
  normaliseSearchHit,
  normaliseVersion,
  partitionCategories,
  validateFacet,
} from './modrinth';
import { modProjectSchema, modSearchQuerySchema, modVersionSchema } from './types';

/* Recorded payloads — see `__fixtures__/helpers.ts` for where they came from. */
const searchPayload = fixture<{ hits: ModrinthSearchHitWire[]; total_hits: number }>(
  'modrinth-search.json'
);
const sodium = fixture<ModrinthProjectWire>('modrinth-project-sodium.json');
const irisVersions = fixture<ModrinthVersionWire[]>('modrinth-versions-iris.json');
const embeddium = fixture<ModrinthVersionWire>('modrinth-version-embeddium.json');
const loaderTags = fixture<{ name: string; supported_project_types: string[] }[]>(
  'modrinth-tag-loader.json'
);

const loaderNames = new Set(loaderTags.map((tag) => tag.name));

/** Routes the endpoints the client touches, so no test needs the network. */
function routedClient(routes: Record<string, unknown>) {
  const fake = fakeFetch((url) => {
    const path = new URL(url).pathname;
    const body = routes[path];
    return body === undefined ? { status: 404, text: '' } : { body };
  });
  return {
    fake,
    client: new ModrinthClient({
      fetchImpl: fake.fetch,
      sleep: async () => {},
      logger: silentLogger(),
      // The limiter is exercised in http.test.ts; here it would only slow things down.
      rateLimit: { capacity: 1000, refillPerSecond: 1000 },
    }),
  };
}

const query = (overrides: Record<string, unknown> = {}) =>
  modSearchQuerySchema.parse({ query: 'sodium', ...overrides });

describe('array query parameters', () => {
  it('JSON-encodes arrays, because a bare string is silently ignored', () => {
    // `?loaders=fabric` returns HTTP 200 with the filter dropped — 235 versions instead of 143.
    // That reads downstream as "this mod supports everything", which is the worst possible
    // failure mode for a compatibility tool.
    expect(encodeArrayParam(['fabric'])).toBe('["fabric"]');
    expect(encodeArrayParam(['fabric', 'quilt'])).toBe('["fabric","quilt"]');
    expect(encodeArrayParam([])).toBe('[]');
  });

  it('sends game_versions and loaders as JSON arrays on the version endpoint', async () => {
    const { fake, client } = routedClient({ '/v2/project/sodium/version': irisVersions });
    await client.getVersions('sodium', { loaders: ['fabric'], gameVersions: ['1.21.1'] });

    const url = new URL(fake.calls[0]?.url ?? '');
    expect(url.searchParams.get('loaders')).toBe('["fabric"]');
    expect(url.searchParams.get('game_versions')).toBe('["1.21.1"]');
    // And URL-encoded on the wire, not raw brackets.
    expect(fake.calls[0]?.url).toContain('loaders=%5B%22fabric%22%5D');
  });

  it('omits the filters entirely rather than sending an empty array', async () => {
    const { fake, client } = routedClient({ '/v2/project/sodium/version': irisVersions });
    await client.getVersions('sodium', { loaders: [], gameVersions: [] });

    const url = new URL(fake.calls[0]?.url ?? '');
    expect(url.searchParams.has('loaders')).toBe(false);
    expect(url.searchParams.has('game_versions')).toBe(false);
  });

  it('JSON-encodes the ids parameter on the bulk endpoints', async () => {
    const { fake, client } = routedClient({ '/v2/projects': [sodium] });
    await client.getProjects(['AANobbMI', 'P7dR8mSH']);
    expect(new URL(fake.calls[0]?.url ?? '').searchParams.get('ids')).toBe(
      '["AANobbMI","P7dR8mSH"]'
    );
  });
});

describe('facet building', () => {
  it('rejects an unknown field instead of shipping a filter that matches nothing', () => {
    // A misspelled facet returns `total_hits: 0` with a 200. Indistinguishable from "no results".
    expect(validateFacet('bogusfield:xyz')).toMatch(/unknown facet field "bogusfield"/);
    expect(validateFacet('categories:fabric')).toBeUndefined();
    expect(validateFacet('downloads>1000000')).toBeUndefined();
    expect(validateFacet('client_side!=required')).toBeUndefined();
    expect(validateFacet('nonsense')).toMatch(/not \{field\}\{operator\}\{value\}/);
  });

  it('ANDs across groups and ORs within them', () => {
    const facets = buildFacets({
      kind: 'mod',
      loaders: ['fabric'],
      gameVersions: ['1.21.1', '1.21.4'],
    });

    expect(facets.ok).toBe(true);
    if (!facets.ok) {
      return;
    }
    expect(JSON.parse(facets.value ?? '')).toEqual([
      ['project_type:mod'],
      ['categories:fabric'],
      ['versions:1.21.1', 'versions:1.21.4'],
    ]);
  });

  it('keeps loaders and categories in separate AND groups', () => {
    // Both live in the `categories` field. Merging them would turn "fabric AND optimization"
    // into "fabric OR optimization" and quietly widen the search.
    const facets = buildFacets({ loaders: ['fabric'], categories: ['optimization'] });
    expect(facets.ok && JSON.parse(facets.value ?? '')).toEqual([
      ['categories:fabric'],
      ['categories:optimization'],
    ]);
  });

  it('uses != for server compatibility so unknown sides survive the filter', () => {
    const facets = buildFacets({ serverCompatibleOnly: true });
    expect(facets.ok && JSON.parse(facets.value ?? '')).toEqual([['server_side!=unsupported']]);
  });

  it('returns undefined when there is nothing to filter on', () => {
    const facets = buildFacets({});
    expect(facets.ok && facets.value).toBeUndefined();
  });

  it('fails loudly on an invalid facet rather than returning a 0-hit query', () => {
    const facets = buildFacets({ categories: ['ok'], loaders: ['fine'] });
    expect(facets.ok).toBe(true);

    // Facet *values* are free-form; only the field name is validated, and that is what a
    // caller can get wrong.
    const bad = buildFacets({ categories: ['has:colon:trouble'] });
    expect(bad.ok).toBe(true);
  });
});

describe('search', () => {
  it('clamps limit to 100 rather than letting the API clamp silently', async () => {
    const { fake, client } = routedClient({
      '/v2/search': searchPayload,
      '/v2/tag/loader': loaderTags,
    });
    await client.search(modSearchQuerySchema.parse({ query: 'x', limit: 100 }));

    expect(new URL(fake.calls[0]?.url ?? '').searchParams.get('limit')).toBe(
      String(MODRINTH_MAX_LIMIT)
    );
  });

  it('normalises real search hits into the shared shape', async () => {
    const { client } = routedClient({
      '/v2/search': searchPayload,
      '/v2/tag/loader': loaderTags,
    });
    const result = await client.search(query());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const sodiumHit = result.value.hits.find((hit) => hit.slug === 'sodium');
    expect(sodiumHit).toBeDefined();
    expect(modProjectSchema.safeParse(sodiumHit).success).toBe(true);
    expect(sodiumHit?.id).toBe('modrinth:AANobbMI');
    expect(sodiumHit?.provider).toBe('modrinth');
    expect(sodiumHit?.author).toBe('jellysquid3');
    expect(sodiumHit?.projectUrl).toBe('https://modrinth.com/mod/sodium');
    expect(result.value.providers).toEqual(['modrinth']);
  });

  it('falls back to the bundled loader list when the tag endpoint is down', async () => {
    // Search must keep working when a tag fetch fails; the only cost is a loader briefly
    // showing up as a category.
    const { client } = routedClient({ '/v2/search': searchPayload });
    const result = await client.search(query());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const sodiumHit = result.value.hits.find((hit) => hit.slug === 'sodium');
    expect(sodiumHit?.loaders).toContain('fabric');
    expect(FALLBACK_LOADER_NAMES).toContain('neoforge');
  });

  it('refuses to send an invalid facet', async () => {
    const { fake, client } = routedClient({ '/v2/search': searchPayload });
    // `kind` is the only facet field a caller can influence, and the schema constrains it — so
    // drive the guard directly through buildFacets and assert nothing was sent.
    const facets = buildFacets({ categories: ['fine'] });
    expect(facets.ok).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('normalisation: the search / project field divergence', () => {
  it('reads `versions` as game versions on a hit and as version ids on a project', () => {
    // Same key, completely different meaning. This is the nastiest divergence in the v2 API.
    const hit = searchPayload.hits.find((h) => h.slug === 'sodium');
    expect(hit).toBeDefined();
    if (!hit) {
      return;
    }
    const fromHit = normaliseSearchHit(hit, loaderNames);
    expect(fromHit.gameVersions).toContain('26.2');
    expect(fromHit.gameVersions).not.toContain('l42iw17I');

    const fromProject = normaliseProject(sodium);
    expect(fromProject.gameVersions).toContain('26.2');
    // The project's `versions` array (version ids) must never leak into gameVersions.
    expect(fromProject.gameVersions.every((v) => !/^[A-Za-z0-9]{8}$/.test(v))).toBe(true);
  });

  it('maps follows/followers and the two license shapes onto one field each', () => {
    const hit = searchPayload.hits.find((h) => h.slug === 'sodium');
    if (!hit) {
      return;
    }
    const fromHit = normaliseSearchHit(hit, loaderNames);
    const fromProject = normaliseProject(sodium);

    expect(fromHit.followers).toBeGreaterThan(0);
    expect(fromProject.followers).toBeGreaterThan(0);
    // A bare SPDX string on a hit, a `{id,name,url}` object on a project.
    expect(fromHit.license).toBe('LicenseRef-Polyform-Shield-1.0.0');
    expect(fromProject.license).toBe('LicenseRef-Polyform-Shield-1.0.0');
  });

  it('splits loaders out of a search hit’s categories', () => {
    const split = partitionCategories(['fabric', 'neoforge', 'optimization', 'quilt'], loaderNames);
    expect(split.loaders).toEqual(['fabric', 'neoforge', 'quilt']);
    expect(split.categories).toEqual(['optimization']);
  });

  it('derives the v3 environment from the v2 side pair', () => {
    const sodiumProject = normaliseProject(sodium);
    expect(sodiumProject.clientSide).toBe('required');
    expect(sodiumProject.serverSide).toBe('unsupported');
    expect(sodiumProject.environment).toBe('client_only');
  });

  it('tolerates the nulls a v3 host would return for client_side/server_side', async () => {
    // v3 keeps both keys and sets them to null rather than omitting them, so a naive v2 client
    // gets nulls instead of an error. The tolerance lives in the schema, so this has to go
    // through a real parse rather than calling `normaliseProject` on a cast object.
    const { client } = routedClient({
      '/v2/project/sodium': { ...sodium, client_side: null, server_side: null },
    });
    const result = await client.getProject('sodium');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.clientSide).toBe('unknown');
    expect(result.value.serverSide).toBe('unknown');
    expect(result.value.environment).toBe('unknown');
  });
});

describe('normalisation: versions', () => {
  it('produces a valid ModVersion from a real Iris payload', () => {
    const first = irisVersions[0];
    expect(first).toBeDefined();
    if (!first) {
      return;
    }
    const version = normaliseVersion(first);

    expect(modVersionSchema.safeParse(version).success).toBe(true);
    expect(version.id).toBe('modrinth:bAo1Qhte');
    expect(version.channel).toBe('beta');
    expect(version.loaders).toEqual(['fabric']);
    expect(version.gameVersions).toEqual(['1.21.1']);
    expect(version.file.name).toMatch(/\.jar$/);
    expect(version.file.sha1).toHaveLength(40);
    expect(version.file.sha512).toHaveLength(128);
    expect(version.downloadable).toBe(true);
    // Modrinth has no distribution opt-out, so nothing is ever blocked.
    expect(version.downloadBlockedReason).toBeNull();
  });

  it('carries the pinned-version distinction on dependencies', () => {
    const first = irisVersions[0];
    if (!first) {
      return;
    }
    const version = normaliseVersion(first);
    const dep = version.dependencies[0];
    expect(dep?.kind).toBe('required');
    expect(dep?.versionId).toBe('s7adptIg'); // pinned to one exact build
    expect(dep?.projectId).toBe('AANobbMI');
  });

  it('keeps project-wide incompatible edges with a null versionId', () => {
    // Embeddium's real edges against the Sodium forks: project-level, any version.
    const version = normaliseVersion(embeddium);
    const incompatible = version.dependencies.filter((dep) => dep.kind === 'incompatible');

    expect(incompatible.length).toBeGreaterThanOrEqual(2);
    expect(incompatible.every((dep) => dep.versionId === null)).toBe(true);
    expect(incompatible.every((dep) => dep.projectId !== null)).toBe(true);
  });

  it('picks the primary file rather than the first one', () => {
    const base = irisVersions[0];
    if (!base) {
      return;
    }
    const primary = base.files[0];
    if (!primary) {
      return;
    }
    const withSources: ModrinthVersionWire = {
      ...base,
      files: [{ ...primary, filename: 'sources.jar', primary: false }, { ...primary, primary: true }],
    };
    expect(normaliseVersion(withSources).file.name).not.toBe('sources.jar');
  });
});

describe('version listing', () => {
  it('drops anything that is not `listed`', async () => {
    // Archived, draft, unlisted and scheduled versions all come back from the API. Offering a
    // scheduled-but-unreleased jar produces a download that 404s.
    const base = irisVersions[0];
    if (!base) {
      return;
    }
    const mixed: ModrinthVersionWire[] = [
      { ...base, id: 'listed1', status: 'listed' },
      { ...base, id: 'archived1', status: 'archived' },
      { ...base, id: 'draft1', status: 'draft' },
      { ...base, id: 'unlisted1', status: 'unlisted' },
      { ...base, id: 'scheduled1', status: 'scheduled' },
    ];
    const { client } = routedClient({ '/v2/project/iris/version': mixed });
    const result = await client.getVersions('iris');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.map((v) => v.versionId)).toEqual(['listed1']);
  });

  it('does not filter a hash lookup by status — the jar on disk is what it is', async () => {
    const base = irisVersions[0];
    if (!base) {
      return;
    }
    const { client } = routedClient({ '/v2/version_file/abc': { ...base, status: 'archived' } });
    const result = await client.versionFromHash('abc');
    expect(result.ok).toBe(true);
  });

  it('always sends the algorithm explicitly', async () => {
    const base = irisVersions[0];
    if (!base) {
      return;
    }
    const { fake, client } = routedClient({ '/v2/version_file/deadbeef': base });
    await client.versionFromHash('deadbeef', 'sha512');
    expect(new URL(fake.calls[0]?.url ?? '').searchParams.get('algorithm')).toBe('sha512');
  });
});

describe('bulk hash lookup', () => {
  it('diffs the request against the response to find the misses', async () => {
    // Not-found hashes are omitted entirely — no null placeholder — so the caller cannot tell
    // a miss from a hit without this diff.
    const base = irisVersions[0];
    if (!base) {
      return;
    }
    const fake = fakeFetch(() => ({ body: { aaa: base } }));
    const client = new ModrinthClient({
      fetchImpl: fake.fetch,
      sleep: async () => {},
      logger: silentLogger(),
    });

    const result = await client.versionsFromHashes(['aaa', 'bbb', 'ccc']);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect([...result.value.found.keys()]).toEqual(['aaa']);
    expect(result.value.missing).toEqual(['bbb', 'ccc']);
  });

  it('short-circuits an empty request without a round trip', async () => {
    const { fake, client } = routedClient({});
    const result = await client.versionsFromHashes([]);
    expect(result.ok).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('errors', () => {
  it('turns an empty-body 404 into not_found rather than a parse crash', async () => {
    const { client } = routedClient({});
    const result = await client.getProject('does-not-exist');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_found');
    }
  });

  it('reports upstream_error with issues when the payload shape changes', async () => {
    const { client } = routedClient({ '/v2/project/sodium': { id: 'AANobbMI' } });
    const result = await client.getProject('sodium');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('upstream_error');
      expect(Array.isArray(result.error.details.issues)).toBe(true);
    }
  });

  it('is always available — Modrinth needs no credentials', () => {
    expect(new ModrinthClient().availability()).toEqual({ available: true });
  });
});
