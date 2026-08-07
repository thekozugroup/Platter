import {
  type DependencyKind,
  fail,
  type Logger,
  type ModKind,
  type ModProvider,
  ok,
  type Result,
  logger as rootLogger,
} from '@platter/shared';
import { z } from 'zod';
import { HttpClient, type HttpClientOptions } from './http';
import {
  type DependencyRef,
  deriveEnvironment,
  type ModProject,
  type ModSearchResult,
  type ModVersion,
  normaliseLoaderName,
  type ProviderAvailability,
  type ProviderClient,
  qualifiedId,
  type ReleaseChannel,
  type ResolvedModSearchQuery,
  type VersionFilter,
} from './types';

/**
 * CurseForge Eternal ("CurseForge for Studios") API v1.
 *
 * Three things make this client structurally different from the Modrinth one:
 *
 * **It is optional.** The key is not self-serve — third-party services apply through a reviewed
 * form and wait for a human. Most people running Platter will never have one, so a missing key
 * is a normal configuration state, reported as `availability(): { available: false }` and used
 * by the UI to hide CurseForge entirely. It is never an exception, and never a failure the user
 * has to interpret.
 *
 * **Authors can forbid third-party downloads.** A project-level toggle strips `downloadUrl` from
 * every file while leaving the mod in search, `isAvailable: true`, `fileStatus: 4` and the
 * hashes fully populated. Nothing but the URL changes. There *are* documented ways around it —
 * the CDN path is derivable from the file id, and the website's own API leaks a hardcoded key —
 * and this client implements neither. That toggle is the author-consent mechanism Overwolf
 * reviews key applications against; routing around it is a terms violation that risks the key
 * for every Platter user. The mod surfaces as `downloadable: false` with a reason and a link,
 * which is what Prism, MultiMC and the CurseForge client itself do.
 *
 * **Loaders are not a field.** A `File` has no `modLoader`; loaders are smuggled into
 * `sortableGameVersions` as pseudo-versions tagged `gameVersionTypeId: 68441`, alongside
 * `Client`/`Server` environment tags at `75208`. Reading `gameVersions[]` naively hands you
 * `"Forge"` and `"Server"` as if they were Minecraft versions.
 */

export const CURSEFORGE_BASE_URL = 'https://api.curseforge.com';
/** Minecraft. Every call needs it and it is never anything else here. */
export const MINECRAFT_GAME_ID = 432;

/**
 * Pseudo `gameVersionTypeId`s. These are not Minecraft versions.
 *
 * Derived by aggregating `sortableGameVersions` across ~100 live mods; they are not in the docs
 * and there is no endpoint that labels them as special.
 */
export const LOADER_VERSION_TYPE_ID = 68_441;
export const ENVIRONMENT_VERSION_TYPE_ID = 75_208;

/** `ModLoaderType`. Seven values — `Any` and the two dead ones are easy to forget. */
export const MOD_LOADER_TYPE = {
  any: 0,
  forge: 1,
  cauldron: 2,
  liteloader: 3,
  fabric: 4,
  quilt: 5,
  neoforge: 6,
} as const;

/** Minecraft class ids, verified against `/v1/categories?gameId=432&classesOnly=true`. */
export const CLASS_ID = {
  bukkitPlugins: 5,
  mods: 6,
  resourcePacks: 12,
  worlds: 17,
  modpacks: 4471,
  customization: 4546,
  addons: 4559,
  shaders: 6552,
  dataPacks: 6945,
} as const;

const CLASS_ID_BY_KIND: Readonly<Record<ModKind, number>> = {
  mod: CLASS_ID.mods,
  plugin: CLASS_ID.bukkitPlugins,
  resourcepack: CLASS_ID.resourcePacks,
  modpack: CLASS_ID.modpacks,
  shader: CLASS_ID.shaders,
  datapack: CLASS_ID.dataPacks,
};

/**
 * Class order for a slug whose class the caller did not state.
 *
 * `slug` is unique *within* a class, not across them: "worldedit" is a real project name under
 * both Mods and Bukkit Plugins, and a slug search that is not scoped to a class returns every one
 * of them in whatever order the relevance ranking felt like. Taking the first row would let the
 * same ref resolve to a different project between two runs, which turns a wrong install into an
 * unreproducible one — so the order is written down instead of inherited from the API.
 *
 * Mods first because that is what the overwhelming majority of refs mean; modpacks last because
 * installing an entire pack in place of one mod is the most expensive way to be wrong. A caller
 * that already knows the class passes its `ModKind` and never reaches this.
 */
const SLUG_CLASS_PRECEDENCE: readonly number[] = [
  CLASS_ID.mods,
  CLASS_ID.bukkitPlugins,
  CLASS_ID.dataPacks,
  CLASS_ID.shaders,
  CLASS_ID.resourcePacks,
  CLASS_ID.modpacks,
];

const KIND_BY_CLASS_ID: Readonly<Record<number, ModKind>> = {
  [CLASS_ID.bukkitPlugins]: 'plugin',
  [CLASS_ID.mods]: 'mod',
  [CLASS_ID.resourcePacks]: 'resourcepack',
  [CLASS_ID.modpacks]: 'modpack',
  [CLASS_ID.shaders]: 'shader',
  [CLASS_ID.dataPacks]: 'datapack',
  // Customization (4546), Addons (4559) and Worlds (17) have no distinct Platter kind; they
  // install into the same places mods do and fall through to 'mod' below.
};

/**
 * `FileRelationType` → `DependencyKind`.
 *
 * `Include` (6) means the file bundles the other project, which is what `embedded` means to us:
 * do not fetch it separately. `Incompatible` (5) exists but authors rarely populate it, so
 * conflict detection cannot lean on CurseForge the way it can on Modrinth.
 */
export const RELATION_TYPE_TO_KIND: Readonly<Record<number, DependencyKind>> = {
  1: 'embedded', // EmbeddedLibrary
  2: 'optional', // OptionalDependency
  3: 'required', // RequiredDependency
  4: 'tool', // Tool
  5: 'incompatible', // Incompatible
  6: 'embedded', // Include
};

const CHANNEL_BY_RELEASE_TYPE: Readonly<Record<number, ReleaseChannel>> = {
  1: 'release',
  2: 'beta',
  3: 'alpha',
};

/**
 * `FileStatus` values that mean "this file is a real, published artefact".
 *
 * 4 = Approved is what you see essentially always; 10 = Released appears occasionally. Note that
 * Approved does **not** imply downloadable — the distribution toggle is orthogonal.
 */
const INSTALLABLE_FILE_STATUS = new Set([4, 10]);
/** Rejected, MalwareDetected, Deleted. Never offer these. */
const REJECTED_FILE_STATUS = new Set([5, 6, 7]);

/** Both endpoints that paginate enforce `index + pageSize <= 10000`, and `pageSize <= 50`. */
export const CURSEFORGE_MAX_PAGE_SIZE = 50;
export const CURSEFORGE_MAX_RESULT_WINDOW = 10_000;

export function checkPageBounds(
  index: number,
  pageSize: number
): Result<{ index: number; pageSize: number }> {
  const clamped = Math.min(Math.max(1, pageSize), CURSEFORGE_MAX_PAGE_SIZE);
  if (index < 0) {
    return fail('invalid_input', 'CurseForge pagination index cannot be negative');
  }
  if (index + clamped > CURSEFORGE_MAX_RESULT_WINDOW) {
    // There is no cursor and no `since` parameter, so deep pagination genuinely cannot be done;
    // the caller has to partition the query space (by category, version, sort order) instead.
    return fail(
      'invalid_input',
      `CurseForge cannot page past result ${CURSEFORGE_MAX_RESULT_WINDOW} (asked for ${index + clamped}). Narrow the query instead.`,
      { details: { index, pageSize: clamped } }
    );
  }
  return ok({ index, pageSize: clamped });
}

/* -------------------------------------------------------------------------- */
/* Wire schemas                                                                */
/* -------------------------------------------------------------------------- */

const linksSchema = z.object({
  websiteUrl: z.string().nullish(),
  wikiUrl: z.string().nullish(),
  issuesUrl: z.string().nullish(),
  sourceUrl: z.string().nullish(),
});

const categorySchema = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string().nullish(),
  classId: z.number().nullish(),
  parentCategoryId: z.number().nullish(),
  isClass: z.boolean().nullish(),
});

const sortableGameVersionSchema = z.object({
  gameVersionName: z.string(),
  /** `"0"` for pseudo-versions (loaders, Client/Server). A real version is zero-padded digits. */
  gameVersionPadded: z.string().default('0'),
  /** Empty string for pseudo-versions. */
  gameVersion: z.string().default(''),
  gameVersionTypeId: z.number().nullish(),
});

const fileSchema = z.object({
  id: z.number(),
  modId: z.number(),
  isAvailable: z.boolean().default(true),
  displayName: z.string().default(''),
  fileName: z.string().default(''),
  releaseType: z.number().default(1),
  fileStatus: z.number().default(4),
  hashes: z.array(z.object({ value: z.string(), algo: z.number() })).default([]),
  fileDate: z.string().nullish(),
  /** Compressed download size; matches the CDN's content-length. */
  fileLength: z.number().nullish(),
  /**
   * The OpenAPI schema types this `string`, non-nullable. It is null whenever the author
   * disabled third-party distribution. Strongly-typed clients that trusted the schema are the
   * single most common CurseForge integration crash.
   */
  downloadUrl: z.string().nullish(),
  gameVersions: z.array(z.string()).default([]),
  sortableGameVersions: z.array(sortableGameVersionSchema).default([]),
  dependencies: z.array(z.object({ modId: z.number(), relationType: z.number() })).default([]),
});

const modSchema = z.object({
  id: z.number(),
  gameId: z.number(),
  name: z.string(),
  slug: z.string().nullish(),
  links: linksSchema.nullish(),
  summary: z.string().nullish(),
  status: z.number().nullish(),
  downloadCount: z.number().default(0),
  classId: z.number().nullish(),
  categories: z.array(categorySchema).default([]),
  authors: z.array(z.object({ id: z.number(), name: z.string() })).default([]),
  logo: z.object({ url: z.string().nullish(), thumbnailUrl: z.string().nullish() }).nullish(),
  latestFiles: z.array(fileSchema).default([]),
  latestFilesIndexes: z
    .array(
      z.object({
        gameVersion: z.string(),
        fileId: z.number(),
        modLoader: z.number().nullish(),
        releaseType: z.number().nullish(),
      })
    )
    .default([]),
  dateModified: z.string().nullish(),
  /** `boolean | null` — null is real, so `=== false` is the only safe test. */
  allowModDistribution: z.boolean().nullish(),
  isAvailable: z.boolean().nullish(),
});

const paginationSchema = z.object({
  index: z.number(),
  pageSize: z.number(),
  resultCount: z.number(),
  totalCount: z.number(),
});

const envelope = <S extends z.ZodType>(data: S) => z.object({ data });
const pagedEnvelope = <S extends z.ZodType>(data: S) =>
  z.object({ data, pagination: paginationSchema });

export type CurseForgeModWire = z.infer<typeof modSchema>;
export type CurseForgeFileWire = z.infer<typeof fileSchema>;

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

/** Real Minecraft versions only — pseudo-versions carry `gameVersionPadded: "0"`. */
export function gameVersionsOf(file: CurseForgeFileWire): string[] {
  return file.sortableGameVersions
    .filter(
      (entry) =>
        entry.gameVersionTypeId !== LOADER_VERSION_TYPE_ID &&
        entry.gameVersionTypeId !== ENVIRONMENT_VERSION_TYPE_ID &&
        entry.gameVersion.length > 0 &&
        entry.gameVersionPadded !== '0'
    )
    .map((entry) => entry.gameVersion);
}

/**
 * Loaders, read out of the pseudo-versions.
 *
 * A file with no `68441` entry at all is loader-agnostic — resource packs, data packs and a lot
 * of older universal jars. That is returned as an empty array rather than guessed at, and
 * `compat.ts` treats an empty loader list as "unknown", not "compatible with everything".
 */
export function loadersOf(file: CurseForgeFileWire): string[] {
  return file.sortableGameVersions
    .filter((entry) => entry.gameVersionTypeId === LOADER_VERSION_TYPE_ID)
    .map((entry) => normaliseLoaderName(entry.gameVersionName));
}

/** `Client` / `Server` tags. Positive evidence only — most authors never set them. */
export function environmentTagsOf(file: CurseForgeFileWire): ('client' | 'server')[] {
  const tags: ('client' | 'server')[] = [];
  for (const entry of file.sortableGameVersions) {
    if (entry.gameVersionTypeId !== ENVIRONMENT_VERSION_TYPE_ID) {
      continue;
    }
    const name = entry.gameVersionName.toLowerCase();
    if (name === 'client' && !tags.includes('client')) {
      tags.push('client');
    }
    if (name === 'server' && !tags.includes('server')) {
      tags.push('server');
    }
  }
  return tags;
}

/**
 * Whether the artefact can actually be fetched, and why not.
 *
 * Checks the per-file URL *and* the project flag. `allowModDistribution` is nullable and
 * per-file nulls have been observed under projects whose mod-level flag reads `true`, so the
 * file's own URL is the authoritative signal and the flag is the corroborating one.
 */
export function downloadState(
  file: CurseForgeFileWire,
  mod?: Pick<CurseForgeModWire, 'allowModDistribution' | 'links'> | undefined
): { downloadable: boolean; reason: string | null } {
  if (REJECTED_FILE_STATUS.has(file.fileStatus)) {
    return {
      downloadable: false,
      reason: `CurseForge marked this file unusable (status ${file.fileStatus})`,
    };
  }
  if (!INSTALLABLE_FILE_STATUS.has(file.fileStatus)) {
    return {
      downloadable: false,
      reason: `This file is not published yet (status ${file.fileStatus})`,
    };
  }
  if (file.isAvailable === false) {
    return { downloadable: false, reason: 'CurseForge reports this file as unavailable' };
  }
  if (!file.downloadUrl || file.downloadUrl.length === 0 || mod?.allowModDistribution === false) {
    // Deliberately actionable: this is not a network error and retrying will never fix it.
    return {
      downloadable: false,
      reason:
        'The author has disabled third-party downloads for this project. Download the file from CurseForge and add it manually.',
    };
  }
  return { downloadable: true, reason: null };
}

const hashByAlgo = (file: CurseForgeFileWire, algo: number): string | null =>
  file.hashes.find((hash) => hash.algo === algo)?.value ?? null;

export function normaliseFile(
  file: CurseForgeFileWire,
  mod?: CurseForgeModWire | undefined
): ModVersion {
  // Duplicate `(modId, relationType)` pairs are common in real payloads — Mod Menu lists Fabric
  // API twice on the same file. Dedupe or the dependency walk fetches it twice.
  const seen = new Set<string>();
  const dependencies: DependencyRef[] = [];
  for (const dep of file.dependencies) {
    const kind = RELATION_TYPE_TO_KIND[dep.relationType];
    if (!kind) {
      continue;
    }
    const key = `${dep.modId}:${kind}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    dependencies.push({
      provider: 'curseforge',
      projectId: String(dep.modId),
      // CurseForge dependency records carry no file id and no version range whatsoever. Which
      // build satisfies the requirement is entirely our problem to resolve.
      versionId: null,
      fileName: null,
      kind,
    });
  }

  const state = downloadState(file, mod);
  return {
    id: qualifiedId('curseforge', file.id),
    provider: 'curseforge',
    versionId: String(file.id),
    projectId: String(file.modId),
    versionNumber: file.displayName || null,
    name: file.displayName || file.fileName || null,
    channel: CHANNEL_BY_RELEASE_TYPE[file.releaseType] ?? 'release',
    gameVersions: gameVersionsOf(file),
    loaders: loadersOf(file),
    dependencies,
    file: {
      name: file.fileName,
      url: state.downloadable ? (file.downloadUrl ?? null) : null,
      // `fileLength`, never `fileSizeOnDisk` — the latter is the *extracted* size and is null
      // as often as not. Download verification compares against this number.
      size: file.fileLength ?? null,
      sha1: hashByAlgo(file, 1),
      // CurseForge publishes SHA-1 and MD5 only. MD5 has nowhere useful to go in our model and
      // is not worth carrying for integrity checking.
      sha512: null,
    },
    downloadable: state.downloadable,
    downloadBlockedReason: state.reason,
    environmentTags: environmentTagsOf(file),
    publishedAt: file.fileDate ?? null,
  };
}

export function normaliseMod(mod: CurseForgeModWire): ModProject {
  const kind = KIND_BY_CLASS_ID[mod.classId ?? -1] ?? 'mod';
  // The union of loaders across the newest files. Display only, exactly like Modrinth's — and
  // narrower than Modrinth's, since it only covers the latest files rather than all history.
  const loaders = new Set<string>();
  const gameVersions = new Set<string>();
  for (const file of mod.latestFiles) {
    for (const loader of loadersOf(file)) {
      loaders.add(loader);
    }
    for (const version of gameVersionsOf(file)) {
      gameVersions.add(version);
    }
  }
  for (const index of mod.latestFilesIndexes) {
    gameVersions.add(index.gameVersion);
  }

  return {
    id: qualifiedId('curseforge', mod.id),
    provider: 'curseforge',
    projectId: String(mod.id),
    slug: mod.slug ?? null,
    title: mod.name,
    summary: mod.summary ?? null,
    description: null,
    author: mod.authors[0]?.name ?? null,
    iconUrl: mod.logo?.thumbnailUrl ?? mod.logo?.url ?? null,
    projectUrl: mod.links?.websiteUrl ?? null,
    // CurseForge exposes licences only through the HTML description, not as a field.
    license: null,
    downloads: Math.max(0, Math.trunc(mod.downloadCount)),
    // No follower concept in the API. 0 rather than null so sorting never has to special-case.
    followers: 0,
    kind,
    // CurseForge has no client/server metadata at all. `unknown` is the honest answer, and
    // `compat.ts` degrades to a *heuristic warning* rather than a silent blocker because of it.
    clientSide: 'unknown',
    serverSide: 'unknown',
    environment: deriveEnvironment('unknown', 'unknown'),
    categories: mod.categories.filter((c) => c.isClass !== true).map((c) => c.name),
    loaders: [...loaders],
    gameVersions: [...gameVersions],
  };
}

/**
 * The one project a bare slug refers to, out of everything the search returned for it.
 *
 * Ranked rather than filtered, because the fallbacks matter: an entry whose `slug` came back null
 * (the field is nullable and empties do turn up on older projects) still sorts in behind the
 * exact matches instead of being discarded, and a class outside `SLUG_CLASS_PRECEDENCE` — Worlds,
 * Customization, Addons — sorts last rather than out. Losing a real project to a strict filter is
 * a `not_found` on something that exists, which is the failure this whole function is here to
 * stop. Ties break on the lower project id: the older project is the one that has been answering
 * to that name the longest, and it is stable across ranking changes upstream.
 */
export function chooseSlugMatch<
  T extends { id: number; slug?: string | null | undefined; classId?: number | null | undefined },
>(candidates: readonly T[], slug: string): T | undefined {
  const wanted = slug.trim().toLowerCase();
  const classRank = (candidate: T): number => {
    const index = SLUG_CLASS_PRECEDENCE.indexOf(candidate.classId ?? -1);
    return index === -1 ? SLUG_CLASS_PRECEDENCE.length : index;
  };
  const slugRank = (candidate: T): number =>
    (candidate.slug ?? '').trim().toLowerCase() === wanted ? 0 : 1;

  return [...candidates].sort(
    (a, b) => slugRank(a) - slugRank(b) || classRank(a) - classRank(b) || a.id - b.id
  )[0];
}

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

export interface CurseForgeClientOptions extends Partial<Omit<HttpClientOptions, 'baseUrl'>> {
  baseUrl?: string;
  /** Absent means the whole provider is off. Read from `CURSEFORGE_API_KEY` by the caller. */
  apiKey?: string | undefined;
}

/**
 * Short TTLs on purpose.
 *
 * The third-party terms read as forbidding persisting API data at all. A brief in-process cache
 * that exists purely to avoid re-asking the same question inside one user action is the
 * conservative reading of that; a durable index of their catalogue is not, and would also put
 * Platter on the wrong side of the "competes with the Platform" clause.
 */
const TTL = {
  catalogue: 60 * 60 * 1000,
  mod: 2 * 60 * 1000,
  file: 2 * 60 * 1000,
  search: 30 * 1000,
} as const;

const SORT_FIELD: Readonly<Record<string, number | undefined>> = {
  relevance: undefined,
  downloads: 6, // TotalDownloads
  follows: 2, // Popularity
  newest: 11, // ReleasedDate
  updated: 3, // LastUpdated
};

export class CurseForgeClient implements ProviderClient {
  readonly provider: ModProvider = 'curseforge';
  private readonly http: HttpClient;
  private readonly log: Logger;
  private readonly apiKey: string | undefined;

  constructor(options: CurseForgeClientOptions = {}) {
    const { baseUrl, apiKey, headers, logger, ...rest } = options;
    this.apiKey = apiKey && apiKey.trim().length > 0 ? apiKey.trim() : undefined;
    this.log = logger ?? rootLogger.child('mods:curseforge');
    this.http = new HttpClient({
      ...rest,
      baseUrl: baseUrl ?? CURSEFORGE_BASE_URL,
      defaultTtlMs: rest.defaultTtlMs ?? TTL.mod,
      // No published rate limit, no `x-ratelimit-*` headers, and community reports say the
      // cooldown after a 429 is measured in hours rather than seconds. So: keep the tap barely
      // open and lean on the bulk endpoints. A backoff tuned for a per-second bucket cannot
      // rescue you here — the real limit is "sustained abuse gets the key revoked".
      rateLimit: rest.rateLimit ?? { capacity: 8, refillPerSecond: 2 },
      maxRetries: rest.maxRetries ?? 2,
      logger: this.log,
      headers: { ...headers, ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}) },
    });
  }

  availability(): ProviderAvailability {
    return this.apiKey
      ? { available: true }
      : {
          available: false,
          reason:
            'CURSEFORGE_API_KEY is not set. CurseForge requires a reviewed third-party API key; Platter hides CurseForge until one is configured.',
        };
  }

  /**
   * Guard every call. Returns an `Err` when the provider is off.
   *
   * Missing and invalid keys both produce a 403 with a zero-length body, which is unhelpfully
   * indistinguishable — so the "no key" case is caught here, before the request, where we can
   * say something true about it.
   */
  private unavailable(): Result<never> | undefined {
    const availability = this.availability();
    return availability.available
      ? undefined
      : fail('not_supported', availability.reason, { details: { provider: 'curseforge' } });
  }

  /* --- Catalogue --------------------------------------------------------- */

  async getClasses(): Promise<Result<{ id: number; name: string; slug: string | null }[]>> {
    const off = this.unavailable();
    if (off) {
      return off;
    }
    const response = await this.http.getJson('/v1/categories', envelope(z.array(categorySchema)), {
      ttlMs: TTL.catalogue,
      query: { gameId: MINECRAFT_GAME_ID, classesOnly: true },
    });
    return response.ok
      ? ok(response.value.data.map((c) => ({ id: c.id, name: c.name, slug: c.slug ?? null })))
      : response;
  }

  async getCategories(
    classId: number = CLASS_ID.mods
  ): Promise<
    Result<{ id: number; name: string; slug: string | null; parentCategoryId: number | null }[]>
  > {
    const off = this.unavailable();
    if (off) {
      return off;
    }
    const response = await this.http.getJson('/v1/categories', envelope(z.array(categorySchema)), {
      ttlMs: TTL.catalogue,
      query: { gameId: MINECRAFT_GAME_ID, classId },
    });
    return response.ok
      ? ok(
          response.value.data.map((c) => ({
            id: c.id,
            name: c.name,
            slug: c.slug ?? null,
            parentCategoryId: c.parentCategoryId ?? null,
          }))
        )
      : response;
  }

  /**
   * Game versions, grouped by `gameVersionTypeId`.
   *
   * The two pseudo-types (68441 Mod Loader, 75208 Environment) are filtered out — they are not
   * Minecraft versions and a version picker containing "Forge" and "Client" is a bug report.
   */
  async getGameVersions(): Promise<Result<{ typeId: number; versions: string[] }[]>> {
    const off = this.unavailable();
    if (off) {
      return off;
    }
    const response = await this.http.getJson(
      `/v1/games/${MINECRAFT_GAME_ID}/versions`,
      envelope(z.array(z.object({ type: z.number(), versions: z.array(z.string()) }))),
      { ttlMs: TTL.catalogue }
    );
    return response.ok
      ? ok(
          response.value.data
            .filter(
              (group) =>
                group.type !== LOADER_VERSION_TYPE_ID && group.type !== ENVIRONMENT_VERSION_TYPE_ID
            )
            .map((group) => ({ typeId: group.type, versions: group.versions }))
        )
      : response;
  }

  /* --- Search ------------------------------------------------------------ */

  async search(query: ResolvedModSearchQuery): Promise<Result<ModSearchResult>> {
    const off = this.unavailable();
    if (off) {
      return off;
    }
    const bounds = checkPageBounds(query.offset, query.limit);
    if (!bounds.ok) {
      return bounds;
    }

    const gameVersion = query.gameVersions[0];
    const loader = query.loaders[0];
    // `modLoaderType` is inert unless `gameVersion` is also present — it does not 400, it just
    // returns unfiltered results. Sending it alone is the classic CurseForge integration bug,
    // so it is only sent as a pair.
    if (loader && !gameVersion) {
      this.log.debug(
        'dropping CurseForge loader filter: it requires a game version to take effect',
        {
          loader,
        }
      );
    }
    if (query.gameVersions.length > 1 || query.loaders.length > 1) {
      // Search takes one of each; the plural forms exist but cap at 4/5 and override the
      // singular ones in ways that interact badly with the coupling above. Results are
      // candidates regardless — real compatibility is decided per file in `compat.ts`.
      this.log.debug('CurseForge search filters on one game version and one loader; narrowing', {
        gameVersions: query.gameVersions,
        loaders: query.loaders,
      });
    }

    const response = await this.http.getJson('/v1/mods/search', pagedEnvelope(z.array(modSchema)), {
      ttlMs: TTL.search,
      query: {
        gameId: MINECRAFT_GAME_ID,
        classId: CLASS_ID_BY_KIND[query.kind],
        searchFilter: query.query || undefined,
        gameVersion,
        modLoaderType: gameVersion && loader ? modLoaderTypeFor(loader) : undefined,
        sortField: SORT_FIELD[query.sort],
        sortOrder: 'desc',
        index: bounds.value.index,
        pageSize: bounds.value.pageSize,
      },
    });
    if (!response.ok) {
      return response;
    }

    return ok({
      hits: response.value.data.map(normaliseMod),
      offset: response.value.pagination.index,
      limit: response.value.pagination.pageSize,
      // Clamped and approximate upstream. Good for "is there another page", nothing else.
      totalHits: response.value.pagination.totalCount,
      providers: ['curseforge'],
      degraded: [],
    });
  }

  /* --- Mods -------------------------------------------------------------- */

  /**
   * `idOrSlug` accepts either, so callers can stay provider-agnostic. A slug costs one extra
   * search call; `classId` + `slug` is documented to yield a unique result.
   *
   * `classId` is sent only when `kind` says which class to look in. Defaulting it to Mods is the
   * obvious-looking move — the uniqueness guarantee is stated in terms of the pair — but a slug
   * filed under any other class then comes back as `data: []`, so every plugin, shader, data pack
   * and modpack becomes unreachable by slug and only numeric ids work. An unscoped slug search
   * costs exactly the same one request and finds all of them; the ambiguity it introduces is
   * resolved by `chooseSlugMatch` rather than by the order the API happened to answer in.
   */
  private async resolveModId(idOrSlug: string, kind?: ModKind): Promise<Result<number>> {
    if (/^\d+$/.test(idOrSlug)) {
      return ok(Number(idOrSlug));
    }
    const classId = kind === undefined ? undefined : CLASS_ID_BY_KIND[kind];
    const response = await this.http.getJson('/v1/mods/search', pagedEnvelope(z.array(modSchema)), {
      ttlMs: TTL.mod,
      query: {
        gameId: MINECRAFT_GAME_ID,
        classId,
        slug: idOrSlug,
        // A pinned class really is unique, so one row is all there is to fetch. Unpinned, the
        // cross-class duplicates have to be on the page or there is nothing to choose between.
        pageSize: classId === undefined ? CURSEFORGE_MAX_PAGE_SIZE : 1,
      },
    });
    if (!response.ok) {
      return response;
    }
    const hit = chooseSlugMatch(response.value.data, idOrSlug);
    return hit
      ? ok(hit.id)
      : fail('not_found', `No CurseForge project with slug "${idOrSlug}"`, {
          details: { slug: idOrSlug, ...(kind === undefined ? {} : { kind }) },
        });
  }

  /**
   * `kind` is a hint, not a filter: it narrows a slug lookup to one class and is ignored for a
   * numeric id. Pass it when the caller already knows what it asked for — a hit that came back
   * from `search`, or a ref typed by a user who picked a content type — and leave it off when it
   * would only be a guess, because a wrong class is a `not_found` on a project that exists.
   */
  async getProject(idOrSlug: string, kind?: ModKind): Promise<Result<ModProject>> {
    const off = this.unavailable();
    if (off) {
      return off;
    }
    const id = await this.resolveModId(idOrSlug, kind);
    if (!id.ok) {
      return id;
    }
    return this.getMod(id.value);
  }

  async getMod(modId: number): Promise<Result<ModProject>> {
    const off = this.unavailable();
    if (off) {
      return off;
    }
    const response = await this.http.getJson(`/v1/mods/${modId}`, envelope(modSchema), {
      ttlMs: TTL.mod,
    });
    return response.ok ? ok(normaliseMod(response.value.data)) : response;
  }

  /** Bulk hydrate. All ids must belong to the same game, which for us is always Minecraft. */
  async getMods(modIds: readonly number[]): Promise<Result<ModProject[]>> {
    const off = this.unavailable();
    if (off) {
      return off;
    }
    if (modIds.length === 0) {
      return ok([]);
    }
    const response = await this.http.postJson(
      '/v1/mods',
      { modIds: [...modIds] },
      envelope(z.array(modSchema))
    );
    return response.ok ? ok(response.value.data.map(normaliseMod)) : response;
  }

  /* --- Files ------------------------------------------------------------- */

  /** `kind` is the same slug-scoping hint as `getProject`'s, and is ignored for a numeric id. */
  async getVersions(
    idOrSlug: string,
    filter: VersionFilter = {},
    kind?: ModKind
  ): Promise<Result<ModVersion[]>> {
    const off = this.unavailable();
    if (off) {
      return off;
    }
    const id = await this.resolveModId(idOrSlug, kind);
    return id.ok ? this.getModFiles(id.value, filter) : id;
  }

  /**
   * Files for one mod, paged to exhaustion or to `filter.limit`.
   *
   * `/files` only accepts the *singular* `gameVersion` and `modLoaderType` — there are no plural
   * forms here at all. Anything beyond the first entry of each filter is applied client-side
   * against the file's own pseudo-version tags, which is authoritative anyway.
   *
   * The paging is not an optimisation, it is the difference between a correct answer and a
   * plausible one. `pageSize` is hard-capped at 50 upstream, and a single page of a mature mod is
   * only its 50 newest builds: JEI alone has 166 files for Forge 1.20.1. Stopping there means the
   * client-side loader filter narrows an already-truncated list, and "use an older build instead"
   * can never reach past the 50th newest — which is exactly where the build that still works on
   * an older server tends to live. `filter.limit` is documented as a cap both providers honour,
   * so it caps the walk instead of silently becoming its size.
   */
  async getModFiles(modId: number, filter: VersionFilter = {}): Promise<Result<ModVersion[]>> {
    const off = this.unavailable();
    if (off) {
      return off;
    }
    // Also the clamp: a limit under 50 asks for one short page rather than a full one we discard.
    const bounds = checkPageBounds(0, filter.limit ?? CURSEFORGE_MAX_PAGE_SIZE);
    if (!bounds.ok) {
      return bounds;
    }
    const pageSize = bounds.value.pageSize;
    const limit = filter.limit ?? Number.POSITIVE_INFINITY;
    const wanted = new Set((filter.loaders ?? []).map(normaliseLoaderName));

    const collected: ModVersion[] = [];
    for (let index = 0; ; index += pageSize) {
      const page = checkPageBounds(index, pageSize);
      if (!page.ok) {
        // Past `index + pageSize <= 10000`. There is no cursor to continue with, so the honest
        // move is to return the 10,000 files we did read rather than fail a call that mostly
        // succeeded — no Minecraft project has ever come close to that many files anyway.
        this.log.warn('stopping CurseForge file paging at the result window', { modId, index });
        break;
      }
      const response = await this.http.getJson(
        `/v1/mods/${modId}/files`,
        pagedEnvelope(z.array(fileSchema)),
        {
          ttlMs: TTL.file,
          query: {
            gameVersion: filter.gameVersions?.[0],
            modLoaderType: filter.loaders?.[0] ? modLoaderTypeFor(filter.loaders[0]) : undefined,
            index: page.value.index,
            pageSize: page.value.pageSize,
          },
        }
      );
      if (!response.ok) {
        return response;
      }

      for (const file of response.value.data) {
        if (REJECTED_FILE_STATUS.has(file.fileStatus)) {
          continue;
        }
        const version = normaliseFile(file);
        // An empty loader list means loader-agnostic (data packs, universal jars); keeping those
        // is correct, and `compat.ts` grades them as unknown rather than compatible.
        const matches =
          wanted.size === 0 ||
          version.loaders.length === 0 ||
          version.loaders.some((loader) => wanted.has(loader));
        if (matches) {
          collected.push(version);
        }
      }

      // The limit is counted after filtering, so a page mostly full of other loaders' builds
      // does not end the walk early with three files to show for it.
      if (collected.length >= limit) {
        break;
      }
      // `resultCount` is this page's size; a short page is the last one. `data.length` is checked
      // too because an empty page with a lying count would otherwise loop until the window bound.
      if (response.value.data.length === 0 || response.value.pagination.resultCount < pageSize) {
        break;
      }
    }

    return ok(filter.limit === undefined ? collected : collected.slice(0, filter.limit));
  }

  async getModFile(modId: number, fileId: number): Promise<Result<ModVersion>> {
    const off = this.unavailable();
    if (off) {
      return off;
    }
    const response = await this.http.getJson(
      `/v1/mods/${modId}/files/${fileId}`,
      envelope(fileSchema),
      { ttlMs: TTL.file }
    );
    return response.ok ? ok(normaliseFile(response.value.data)) : response;
  }

  /**
   * `getVersion` needs a `modId` CurseForge does not encode in the file id, so the qualified
   * form `"<modId>:<fileId>"` is accepted. Bare file ids go through the bulk endpoint, which is
   * the only route that resolves a file without knowing its mod.
   */
  async getVersion(versionId: string): Promise<Result<ModVersion>> {
    const off = this.unavailable();
    if (off) {
      return off;
    }
    const [left, right] = versionId.split(':');
    if (left && right && /^\d+$/.test(left) && /^\d+$/.test(right)) {
      return this.getModFile(Number(left), Number(right));
    }
    if (!/^\d+$/.test(versionId)) {
      return fail('invalid_input', `"${versionId}" is not a CurseForge file id`);
    }
    const files = await this.getFiles([Number(versionId)]);
    if (!files.ok) {
      return files;
    }
    const file = files.value[0];
    return file ? ok(file) : fail('not_found', `No CurseForge file ${versionId}`);
  }

  /** Bulk file fetch across mods. Undocumented but real, and the cheapest way to hydrate. */
  async getFiles(fileIds: readonly number[]): Promise<Result<ModVersion[]>> {
    const off = this.unavailable();
    if (off) {
      return off;
    }
    if (fileIds.length === 0) {
      return ok([]);
    }
    const response = await this.http.postJson(
      '/v1/mods/files',
      { fileIds: [...fileIds] },
      z.object({ data: z.array(fileSchema) })
    );
    return response.ok ? ok(response.value.data.map((file) => normaliseFile(file))) : response;
  }

  /**
   * The signed download URL for a file.
   *
   * For a distribution-disabled file this endpoint returns **HTTP 200 with `{"data": ""}`** —
   * not a 403, not null, not an error. Checking only the status code hands you an empty string
   * to download, which is exactly the "undetermined behaviour" that made blocked mods so hard
   * to diagnose in other launchers. The empty string is treated as the opt-out signal it is.
   */
  async getDownloadUrl(modId: number, fileId: number): Promise<Result<string>> {
    const off = this.unavailable();
    if (off) {
      return off;
    }
    const response = await this.http.getJson(
      `/v1/mods/${modId}/files/${fileId}/download-url`,
      envelope(z.string().nullish()),
      { ttlMs: 0 }
    );
    if (!response.ok) {
      return response;
    }
    const url = response.value.data ?? '';
    if (url.length === 0) {
      return fail(
        'not_supported',
        'The author has disabled third-party downloads for this project. Download the file from CurseForge and add it manually.',
        { details: { modId, fileId, reason: 'distribution_disabled' } }
      );
    }
    return ok(url);
  }
}

/** Loader name → `ModLoaderType`. Anything we do not know maps to `Any` rather than guessing. */
export function modLoaderTypeFor(loader: string): number {
  const key = normaliseLoaderName(loader) as keyof typeof MOD_LOADER_TYPE;
  return MOD_LOADER_TYPE[key] ?? MOD_LOADER_TYPE.any;
}
