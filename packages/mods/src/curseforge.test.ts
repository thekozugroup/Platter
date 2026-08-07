import { describe, expect, it } from 'vitest';
import { fakeFetch, fixture, silentLogger } from './__fixtures__/helpers';
import {
  CLASS_ID,
  CURSEFORGE_MAX_RESULT_WINDOW,
  CurseForgeClient,
  type CurseForgeFileWire,
  type CurseForgeModWire,
  MOD_LOADER_TYPE,
  RELATION_TYPE_TO_KIND,
  checkPageBounds,
  downloadState,
  environmentTagsOf,
  gameVersionsOf,
  loadersOf,
  modLoaderTypeFor,
  normaliseFile,
  normaliseMod,
} from './curseforge';
import { modProjectSchema, modSearchQuerySchema, modVersionSchema } from './types';

const searchPayload = fixture<{ data: CurseForgeModWire[]; pagination: unknown }>(
  'curseforge-search.json'
);
const jeiFiles = fixture<{ data: CurseForgeFileWire[] }>('curseforge-files-jei.json');
const modMenuFiles = fixture<{ data: CurseForgeFileWire[] }>('curseforge-files-modmenu.json');
const blockedFile = fixture<{ data: CurseForgeFileWire }>('curseforge-file-blocked.json');
const jeiMod = fixture<{ data: CurseForgeModWire }>('curseforge-mod-jei.json');
const blockedMod = fixture<{ data: CurseForgeModWire }>('curseforge-mod-blocked.json');

const firstJeiFile = jeiFiles.data[0];
const firstModMenuFile = modMenuFiles.data[0];

/** `null` means "no key configured" — not `undefined`, which would trip the default parameter. */
function routedClient(routes: Record<string, unknown>, apiKey: string | null = 'test-key') {
  const fake = fakeFetch((url) => {
    const body = routes[new URL(url).pathname];
    return body === undefined ? { status: 404, text: '' } : { body };
  });
  return {
    fake,
    client: new CurseForgeClient({
      apiKey: apiKey ?? undefined,
      fetchImpl: fake.fetch,
      sleep: async () => {},
      logger: silentLogger(),
      rateLimit: { capacity: 1000, refillPerSecond: 1000 },
    }),
  };
}

describe('availability', () => {
  it('reports itself unavailable without a key instead of throwing', () => {
    // Most self-hosters will never have a key — it needs human review. That is a normal
    // configuration state the UI branches on, not an error the user has to interpret.
    const client = new CurseForgeClient();
    const availability = client.availability();

    expect(availability.available).toBe(false);
    if (availability.available) {
      return;
    }
    expect(availability.reason).toContain('CURSEFORGE_API_KEY');
  });

  it('treats a blank key as no key', () => {
    expect(new CurseForgeClient({ apiKey: '   ' }).availability().available).toBe(false);
  });

  it('fails every call with not_supported, without touching the network', async () => {
    const { fake, client } = routedClient({}, null);

    for (const result of [
      await client.getMod(238222),
      await client.getModFiles(238222),
      await client.search(modSearchQuerySchema.parse({ query: 'jei' })),
      await client.getDownloadUrl(238222, 1),
      await client.getCategories(),
      await client.getGameVersions(),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('not_supported');
      }
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('sends x-api-key when configured', async () => {
    const { fake, client } = routedClient({ '/v1/mods/238222': jeiMod });
    await client.getMod(238222);
    expect((fake.calls[0]?.init?.headers as Record<string, string>)['x-api-key']).toBe('test-key');
  });
});

describe('loaders are pseudo-versions, not a field', () => {
  it('reads loaders out of gameVersionTypeId 68441', () => {
    expect(firstModMenuFile).toBeDefined();
    if (!firstModMenuFile) {
      return;
    }
    expect(loadersOf(firstModMenuFile)).toEqual(['fabric', 'quilt']);
  });

  it('never mistakes a loader or environment tag for a Minecraft version', () => {
    if (!firstJeiFile) {
      return;
    }
    // The raw array reads ["Client", "1.20.1", "Forge", "Server"].
    expect(firstJeiFile.gameVersions).toContain('Forge');
    expect(firstJeiFile.gameVersions).toContain('Server');

    expect(gameVersionsOf(firstJeiFile)).toEqual(['1.20.1']);
    expect(loadersOf(firstJeiFile)).toEqual(['forge']);
    expect(environmentTagsOf(firstJeiFile)).toEqual(['client', 'server']);
  });

  it('returns an empty loader list for a loader-agnostic file rather than guessing', () => {
    // A file with no 68441 entry at all — old universal jars, data packs, resource packs.
    const agnostic = jeiMod.data.latestFiles.find((file) => loadersOf(file).length === 0);
    expect(agnostic).toBeDefined();
    if (!agnostic) {
      return;
    }
    expect(normaliseFile(agnostic).loaders).toEqual([]);
  });
});

describe('the downloadUrl: null problem', () => {
  it('detects an opted-out file even though every other signal says it is fine', () => {
    const file = blockedFile.data;
    // Confirmed on the real payload: still available, still Approved, hashes still populated.
    expect(file.isAvailable).toBe(true);
    expect(file.fileStatus).toBe(4);
    expect(file.hashes.length).toBeGreaterThan(0);
    expect(file.downloadUrl).toBeNull();

    const state = downloadState(file, blockedMod.data);
    expect(state.downloadable).toBe(false);
    expect(state.reason).toMatch(/disabled third-party downloads/);
  });

  it('surfaces it as downloadable: false with a reason, and no URL', () => {
    const version = normaliseFile(blockedFile.data, blockedMod.data);
    expect(modVersionSchema.safeParse(version).success).toBe(true);
    expect(version.downloadable).toBe(false);
    expect(version.file.url).toBeNull();
    expect(version.downloadBlockedReason).toMatch(/add it manually/);
    // Metadata survives — the file can still be verified once a human places it.
    expect(version.file.sha1).toHaveLength(40);
    expect(version.file.size).toBe(153_423_732);
  });

  it('treats a per-file null as authoritative even when the mod flag reads true', () => {
    const file: CurseForgeFileWire = { ...blockedFile.data, downloadUrl: null };
    expect(downloadState(file, { allowModDistribution: true, links: null }).downloadable).toBe(
      false
    );
  });

  it('honours the mod-level flag even when a URL is present', () => {
    if (!firstJeiFile) {
      return;
    }
    expect(
      downloadState(firstJeiFile, { allowModDistribution: false, links: null }).downloadable
    ).toBe(false);
  });

  it('returns not_supported for the empty-string 200 the download-url endpoint sends', async () => {
    // HTTP 200 with {"data": ""} — not a 403, not null. Checking only the status code hands you
    // an empty string to download.
    const { client } = routedClient({ '/v1/mods/436653/files/4075706/download-url': { data: '' } });
    const result = await client.getDownloadUrl(436653, 4075706);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_supported');
      expect(result.error.details.reason).toBe('distribution_disabled');
    }
  });

  it('returns the URL when distribution is allowed', async () => {
    const { client } = routedClient({
      '/v1/mods/238222/files/8576376/download-url': { data: 'https://edge.forgecdn.net/x.jar' },
    });
    const result = await client.getDownloadUrl(238222, 8576376);
    expect(result.ok && result.value).toBe('https://edge.forgecdn.net/x.jar');
  });

  it('rejects a file whose status means malware or deletion', () => {
    if (!firstJeiFile) {
      return;
    }
    for (const fileStatus of [5, 6, 7]) {
      expect(downloadState({ ...firstJeiFile, fileStatus }).downloadable).toBe(false);
    }
    for (const fileStatus of [4, 10]) {
      expect(downloadState({ ...firstJeiFile, fileStatus }).downloadable).toBe(true);
    }
  });
});

describe('normalisation into the shared shape', () => {
  it('produces a valid ModVersion from a real JEI file', () => {
    if (!firstJeiFile) {
      return;
    }
    const version = normaliseFile(firstJeiFile);

    expect(modVersionSchema.safeParse(version).success).toBe(true);
    expect(version.provider).toBe('curseforge');
    expect(version.versionId).toBe('8576376');
    expect(version.projectId).toBe('238222');
    // releaseType 2 — many major projects ship Beta as their normal channel.
    expect(version.channel).toBe('beta');
    expect(version.gameVersions).toEqual(['1.20.1']);
    expect(version.loaders).toEqual(['forge']);
    expect(version.file.sha1).toBe('8bebffd49fa43bee948825a50180f5ad37ce8c77');
    // fileLength (compressed), never fileSizeOnDisk (extracted, and frequently null).
    expect(version.file.size).toBe(1_657_261);
    // CurseForge publishes SHA-1 and MD5 only.
    expect(version.file.sha512).toBeNull();
  });

  it('produces a valid ModProject from a real mod', () => {
    const project = normaliseMod(jeiMod.data);

    expect(modProjectSchema.safeParse(project).success).toBe(true);
    expect(project.id).toBe('curseforge:238222');
    expect(project.kind).toBe('mod');
    expect(project.projectUrl).toContain('curseforge.com');
    expect(project.author).toBeTruthy();
    // No client/server metadata exists anywhere in this API. `unknown` is the honest answer,
    // and it is what makes `compat.ts` fall back to a heuristic *warning*.
    expect(project.clientSide).toBe('unknown');
    expect(project.serverSide).toBe('unknown');
    expect(project.environment).toBe('unknown');
    // No follower concept upstream.
    expect(project.followers).toBe(0);
  });

  it('maps classIds onto content kinds', () => {
    expect(normaliseMod({ ...jeiMod.data, classId: CLASS_ID.bukkitPlugins }).kind).toBe('plugin');
    expect(normaliseMod({ ...jeiMod.data, classId: CLASS_ID.shaders }).kind).toBe('shader');
    expect(normaliseMod({ ...jeiMod.data, classId: CLASS_ID.dataPacks }).kind).toBe('datapack');
    expect(normaliseMod({ ...jeiMod.data, classId: CLASS_ID.modpacks }).kind).toBe('modpack');
    expect(normaliseMod({ ...jeiMod.data, classId: CLASS_ID.resourcePacks }).kind).toBe(
      'resourcepack'
    );
    // Worlds/Customization/Addons have no distinct kind and install like mods.
    expect(normaliseMod({ ...jeiMod.data, classId: CLASS_ID.worlds }).kind).toBe('mod');
  });

  it('dedupes the duplicate dependency entries CurseForge really sends', () => {
    // Mod Menu lists Fabric API (306612) twice on the same file.
    if (!firstModMenuFile) {
      return;
    }
    expect(firstModMenuFile.dependencies.filter((d) => d.modId === 306612)).toHaveLength(2);

    const version = normaliseFile(firstModMenuFile);
    expect(version.dependencies.filter((d) => d.projectId === '306612')).toHaveLength(1);
    expect(version.dependencies).toHaveLength(2);
  });

  it('carries no version constraint on dependencies, because there is none', () => {
    if (!firstModMenuFile) {
      return;
    }
    const version = normaliseFile(firstModMenuFile);
    // Just a modId. Which build satisfies it is entirely our problem to resolve.
    expect(version.dependencies.every((dep) => dep.versionId === null)).toBe(true);
    expect(version.dependencies.every((dep) => dep.kind === 'required')).toBe(true);
  });

  it('maps every relationType to a dependency kind', () => {
    expect(RELATION_TYPE_TO_KIND).toEqual({
      1: 'embedded',
      2: 'optional',
      3: 'required',
      4: 'tool',
      5: 'incompatible',
      6: 'embedded',
    });
  });

  it('maps loader names to ModLoaderType, defaulting to Any', () => {
    expect(modLoaderTypeFor('Forge')).toBe(MOD_LOADER_TYPE.forge);
    expect(modLoaderTypeFor('fabric')).toBe(MOD_LOADER_TYPE.fabric);
    expect(modLoaderTypeFor('NeoForge')).toBe(MOD_LOADER_TYPE.neoforge);
    expect(modLoaderTypeFor('quilt')).toBe(MOD_LOADER_TYPE.quilt);
    // Babric, LegacyFabric, Ornithe and friends have no enum value.
    expect(modLoaderTypeFor('babric')).toBe(MOD_LOADER_TYPE.any);
  });
});

describe('pagination bounds', () => {
  it('enforces index + pageSize <= 10000', () => {
    expect(checkPageBounds(0, 50).ok).toBe(true);
    expect(checkPageBounds(9950, 50).ok).toBe(true);

    const past = checkPageBounds(9990, 50);
    expect(past.ok).toBe(false);
    if (!past.ok) {
      expect(past.error.code).toBe('invalid_input');
      expect(past.error.message).toContain(String(CURSEFORGE_MAX_RESULT_WINDOW));
    }
  });

  it('clamps pageSize to 50 rather than sending a value the API ignores', () => {
    const bounds = checkPageBounds(0, 500);
    expect(bounds.ok && bounds.value.pageSize).toBe(50);
  });

  it('rejects a negative index', () => {
    expect(checkPageBounds(-1, 10).ok).toBe(false);
  });
});

describe('search', () => {
  it('only sends modLoaderType alongside a gameVersion', async () => {
    // `modLoaderType` alone does not 400 — it silently returns unfiltered results. That is the
    // single most common CurseForge integration bug.
    const { fake, client } = routedClient({ '/v1/mods/search': searchPayload });
    await client.search(modSearchQuerySchema.parse({ query: 'jei', loaders: ['fabric'] }));

    const withoutVersion = new URL(fake.calls[0]?.url ?? '');
    expect(withoutVersion.searchParams.has('modLoaderType')).toBe(false);

    await client.search(
      modSearchQuerySchema.parse({ query: 'jei', loaders: ['fabric'], gameVersions: ['1.21.1'] })
    );
    const withVersion = new URL(fake.calls[1]?.url ?? '');
    expect(withVersion.searchParams.get('modLoaderType')).toBe(String(MOD_LOADER_TYPE.fabric));
    expect(withVersion.searchParams.get('gameVersion')).toBe('1.21.1');
  });

  it('scopes every search to Minecraft and the right class', async () => {
    const { fake, client } = routedClient({ '/v1/mods/search': searchPayload });
    await client.search(modSearchQuerySchema.parse({ query: 'x', kind: 'plugin' }));

    const url = new URL(fake.calls[0]?.url ?? '');
    expect(url.searchParams.get('gameId')).toBe('432');
    expect(url.searchParams.get('classId')).toBe(String(CLASS_ID.bukkitPlugins));
  });

  it('normalises search hits', async () => {
    const { client } = routedClient({ '/v1/mods/search': searchPayload });
    const result = await client.search(modSearchQuerySchema.parse({ query: 'jei' }));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.providers).toEqual(['curseforge']);
    expect(result.value.hits.every((hit) => modProjectSchema.safeParse(hit).success)).toBe(true);
    expect(result.value.hits[0]?.provider).toBe('curseforge');
  });
});

describe('file listing', () => {
  it('filters client-side on the loader tags, which are authoritative', async () => {
    const { client } = routedClient({ '/v1/mods/238222/files': jeiFiles });
    const forge = await client.getModFiles(238222, { loaders: ['forge'] });
    expect(forge.ok && forge.value.length).toBeGreaterThan(0);

    const fabric = await client.getModFiles(238222, { loaders: ['fabric'] });
    expect(fabric.ok && fabric.value).toEqual([]);
  });

  it('keeps loader-agnostic files rather than filtering them out', async () => {
    if (!firstJeiFile) {
      return;
    }
    const agnostic: CurseForgeFileWire = { ...firstJeiFile, sortableGameVersions: [] };
    const { client } = routedClient({ '/v1/mods/238222/files': { ...jeiFiles, data: [agnostic] } });
    const result = await client.getModFiles(238222, { loaders: ['fabric'] });

    // Kept, because "no loader tag" means unknown — `compat.ts` grades it, we do not drop it.
    expect(result.ok && result.value).toHaveLength(1);
    expect(result.ok && result.value[0]?.loaders).toEqual([]);
  });

  it('resolves a slug to a mod id before fetching', async () => {
    const { fake, client } = routedClient({
      '/v1/mods/search': { ...searchPayload, data: [jeiMod.data] },
      '/v1/mods/238222/files': jeiFiles,
    });
    const result = await client.getVersions('jei');

    expect(result.ok).toBe(true);
    expect(new URL(fake.calls[0]?.url ?? '').searchParams.get('slug')).toBe('jei');
    expect(fake.calls[1]?.url).toContain('/v1/mods/238222/files');
  });

  it('reports a slug that matches nothing as not_found', async () => {
    const { client } = routedClient({ '/v1/mods/search': { ...searchPayload, data: [] } });
    const result = await client.getProject('no-such-mod');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_found');
    }
  });
});
