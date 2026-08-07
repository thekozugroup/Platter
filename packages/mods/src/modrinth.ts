import {
  fail,
  type GameVersionEntry,
  type Logger,
  type ModKind,
  type ModProvider,
  ok,
  type Result,
  logger as rootLogger,
  VersionIndex,
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
  type ResolvedModSearchQuery,
  type VersionFilter,
} from './types';

/**
 * Modrinth API v2.
 *
 * The API is pleasant to use and unusually willing to fail silently, which is a bad combination.
 * Four of its behaviours will hand you an HTTP 200 containing the wrong answer, and all four are
 * guarded here rather than at call sites:
 *
 *   1. Array query params must be JSON-encoded. `?loaders=fabric` is *ignored* — same 200, all
 *      235 versions. `?loaders=["fabric"]` returns the right 143. See `encodeArrayParam`.
 *   2. A misspelled facet field returns `total_hits: 0`, not a 400. See `buildFacets`.
 *   3. `limit` clamps at 100 and echoes the clamped value without complaining.
 *   4. Project-level `game_versions`/`loaders` are the union across every version ever
 *      published. Sodium claims 1.16.3 through 26.2 and three loaders; no single jar supports
 *      that. Resolving compatibility from a project object is the number one source of false
 *      positives, so `ModProject` carries them for display and `compat.ts` only ever reads
 *      `ModVersion`.
 *
 * Plus one shape trap: search hits and project objects use different names for the same data,
 * and `versions` means *game versions* on a hit but *version ids* on a project. Both are
 * normalised into `ModProject` here so nothing downstream has to remember which one it holds.
 */

export const MODRINTH_BASE_URL = 'https://api.modrinth.com';
/** Documented and confirmed from live `x-ratelimit-limit` headers: 300 requests/minute per IP. */
export const MODRINTH_RATE_LIMIT = { capacity: 300, refillPerSecond: 5 } as const;
/** The API clamps here silently, so we clamp loudly. */
export const MODRINTH_MAX_LIMIT = 100;

/* -------------------------------------------------------------------------- */
/* Query encoding                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The single most important line in this file.
 *
 * Modrinth's array parameters are JSON documents, not repeated keys and not comma-separated
 * lists. Passing a bare string produces a 200 with the filter silently dropped, which reads as
 * "this mod supports every loader" — exactly the wrong failure mode for a compatibility tool.
 */
export const encodeArrayParam = (values: readonly string[]): string => JSON.stringify(values);

/**
 * Facet fields the search index actually knows about.
 *
 * Enumerated because an unknown field is not an error: `[["bogusfield:xyz"]]` returns
 * `total_hits: 0` with a 200. A filter that quietly matches nothing looks identical to "there
 * are no results", and it can survive a release.
 *
 * `loaders` is undocumented in v2 (it is a v3-index passthrough) but verified working and
 * returning counts identical to `categories`. It is listed so a caller who wants it is not
 * rejected, but `buildFacets` emits `categories:` because that is the documented spelling.
 */
export const MODRINTH_FACET_FIELDS: ReadonlySet<string> = new Set([
  'project_type',
  'all_project_types',
  'categories',
  'loaders',
  'versions',
  'client_side',
  'server_side',
  'open_source',
  'title',
  'author',
  'follows',
  'project_id',
  'license',
  'downloads',
  'created_timestamp',
  'modified_timestamp',
  'color',
]);

const FACET_RE = /^([a-z_]+)(!=|>=|<=|>|<|:)(.+)$/;

/** `undefined` when valid, otherwise the reason. */
export function validateFacet(facet: string): string | undefined {
  const match = FACET_RE.exec(facet);
  if (!match) {
    return `"${facet}" is not {field}{operator}{value}`;
  }
  const field = match[1] ?? '';
  return MODRINTH_FACET_FIELDS.has(field) ? undefined : `unknown facet field "${field}"`;
}

/**
 * `ModKind` → Modrinth `project_type`.
 *
 * Modrinth also publishes `minecraft_java_server`, which is server software rather than
 * content, and Platter has no `ModKind` for it — it is a thing you *are*, not a thing you
 * install.
 */
const PROJECT_TYPE_BY_KIND: Readonly<Record<ModKind, string>> = {
  mod: 'mod',
  plugin: 'plugin',
  datapack: 'datapack',
  resourcepack: 'resourcepack',
  shader: 'shader',
  modpack: 'modpack',
};

const KIND_BY_PROJECT_TYPE: Readonly<Record<string, ModKind>> = {
  mod: 'mod',
  plugin: 'plugin',
  datapack: 'datapack',
  resourcepack: 'resourcepack',
  shader: 'shader',
  modpack: 'modpack',
};

/**
 * Build the `facets` parameter: outer array is AND, inner arrays are OR.
 *
 * Returns a `Result` because an invalid facet must not reach the wire — see the 0-hits trap
 * above. Loaders and categories both live in the `categories` field but go into *separate* AND
 * groups, so "fabric AND optimization" means what it says rather than "fabric OR optimization".
 */
export function buildFacets(query: {
  kind?: ModKind;
  loaders?: readonly string[];
  gameVersions?: readonly string[];
  categories?: readonly string[];
  serverCompatibleOnly?: boolean;
}): Result<string | undefined> {
  const groups: string[][] = [];

  if (query.kind) {
    groups.push([`project_type:${PROJECT_TYPE_BY_KIND[query.kind]}`]);
  }
  if (query.loaders?.length) {
    groups.push(query.loaders.map((loader) => `categories:${normaliseLoaderName(loader)}`));
  }
  if (query.gameVersions?.length) {
    groups.push(query.gameVersions.map((version) => `versions:${version}`));
  }
  if (query.categories?.length) {
    groups.push(query.categories.map((category) => `categories:${category}`));
  }
  if (query.serverCompatibleOnly) {
    // `!=` rather than `:optional OR :required` — server_side may also be `unknown`, and an
    // unknown side should stay in the results with a warning rather than disappear.
    groups.push(['server_side!=unsupported']);
  }

  if (groups.length === 0) {
    return ok(undefined);
  }

  for (const group of groups) {
    for (const facet of group) {
      const problem = validateFacet(facet);
      if (problem) {
        return fail('invalid_input', `Refusing to send an invalid Modrinth facet: ${problem}`, {
          details: { facet },
        });
      }
    }
  }

  return ok(JSON.stringify(groups));
}

/* -------------------------------------------------------------------------- */
/* Wire schemas                                                                */
/* -------------------------------------------------------------------------- */

/**
 * v3 replaces `client_side`/`server_side` with a single `environment` and returns **null** for
 * both legacy fields rather than omitting them. A v2 client aimed at a v3 host therefore gets
 * nulls, not an error — so these two fields tolerate null explicitly instead of relying on
 * `.default()`, which only fires for `undefined`.
 */
const sideSchema = z
  .enum(['required', 'optional', 'unsupported', 'unknown'])
  .nullish()
  .transform((value) => value ?? 'unknown');

const searchHitSchema = z.object({
  project_id: z.string(),
  project_type: z.string(),
  slug: z.string().nullish(),
  author: z.string().nullish(),
  title: z.string(),
  description: z.string().nullish(),
  /** Real categories *and* loader names, mixed together. Partitioned during normalisation. */
  categories: z.array(z.string()).default([]),
  /** GAME versions. On a project object this same key means version ids. */
  versions: z.array(z.string()).default([]),
  downloads: z.number().default(0),
  /** `followers` on a project object. */
  follows: z.number().default(0),
  icon_url: z.string().nullish(),
  /** `published` on a project object. */
  date_created: z.string().nullish(),
  date_modified: z.string().nullish(),
  latest_version: z.string().nullish(),
  /** A bare SPDX string here; an object on a project object. */
  license: z.string().nullish(),
  client_side: sideSchema,
  server_side: sideSchema,
});

const searchResponseSchema = z.object({
  hits: z.array(searchHitSchema),
  offset: z.number(),
  limit: z.number(),
  total_hits: z.number(),
});

const projectSchema = z.object({
  id: z.string(),
  slug: z.string().nullish(),
  project_type: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  body: z.string().nullish(),
  client_side: sideSchema,
  server_side: sideSchema,
  downloads: z.number().default(0),
  followers: z.number().default(0),
  categories: z.array(z.string()).default([]),
  additional_categories: z.array(z.string()).default([]),
  /** Historical union across all versions. Never a compatibility answer. */
  game_versions: z.array(z.string()).default([]),
  /** Historical union across all versions. Never a compatibility answer. */
  loaders: z.array(z.string()).default([]),
  icon_url: z.string().nullish(),
  /** `name` is frequently the empty string; the SPDX id in `.id` is what is usable. */
  license: z.object({ id: z.string(), name: z.string().nullish() }).nullish(),
});

const versionFileSchema = z.object({
  hashes: z.object({ sha1: z.string().nullish(), sha512: z.string().nullish() }).default({}),
  url: z.string(),
  filename: z.string(),
  primary: z.boolean().default(false),
  size: z.number().default(0),
});

const versionDependencySchema = z.object({
  version_id: z.string().nullish(),
  project_id: z.string().nullish(),
  file_name: z.string().nullish(),
  dependency_type: z.enum(['required', 'optional', 'incompatible', 'embedded']),
});

const versionSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  name: z.string().nullish(),
  version_number: z.string().nullish(),
  date_published: z.string().nullish(),
  version_type: z.enum(['release', 'beta', 'alpha']),
  /** `listed | archived | draft | unlisted | scheduled | unknown` — only `listed` is curatable. */
  status: z.string().default('listed'),
  game_versions: z.array(z.string()).default([]),
  loaders: z.array(z.string()).default([]),
  files: z.array(versionFileSchema).default([]),
  dependencies: z.array(versionDependencySchema).default([]),
});

const loaderTagSchema = z.object({
  name: z.string(),
  supported_project_types: z.array(z.string()).default([]),
});

const gameVersionTagSchema = z.object({
  version: z.string(),
  version_type: z.enum(['release', 'snapshot', 'alpha', 'beta']),
  date: z.string(),
  major: z.boolean(),
});

const categoryTagSchema = z.object({
  name: z.string(),
  project_type: z.string(),
  header: z.string().default(''),
});

const licenseTagSchema = z.object({ short: z.string(), name: z.string() });

export type ModrinthVersionWire = z.infer<typeof versionSchema>;
export type ModrinthProjectWire = z.infer<typeof projectSchema>;
export type ModrinthSearchHitWire = z.infer<typeof searchHitSchema>;

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Loader names as of the live `/v2/tag/loader` response.
 *
 * Used only to split loaders out of a search hit's `categories` array when the tag endpoint is
 * unreachable. Being one release stale here is harmless — a new loader shows up as a category
 * in the UI until the tag cache warms, which is cosmetic. Being *unable to search offline* is
 * not harmless, which is why there is a fallback at all.
 */
export const FALLBACK_LOADER_NAMES: readonly string[] = [
  'babric',
  'bta-babric',
  'bukkit',
  'bungeecord',
  'canvas',
  'datapack',
  'fabric',
  'folia',
  'forge',
  'geyser',
  'iris',
  'java-agent',
  'legacy-fabric',
  'liteloader',
  'minecraft',
  'modloader',
  'neoforge',
  'nilloader',
  'optifine',
  'ornithe',
  'paper',
  'purpur',
  'quilt',
  'rift',
  'spigot',
  'sponge',
  'vanilla',
  'velocity',
  'waterfall',
];

const kindFromProjectType = (projectType: string): ModKind =>
  KIND_BY_PROJECT_TYPE[projectType] ?? 'mod';

/** Modrinth has no `url` field; the web route is derived from the project type and slug. */
const webUrl = (projectType: string, slugOrId: string): string =>
  `https://modrinth.com/${projectType}/${slugOrId}`;

/**
 * Split a search hit's `categories` into real categories and loader names.
 *
 * Modrinth folds loaders into `categories` in the search index (Sodium's hit reads
 * `["fabric","neoforge","optimization","quilt"]`), so showing that array as-is puts "fabric" in
 * a category filter next to "optimization". `/v2/tag/category` deliberately excludes loaders,
 * which is what makes this separable at all.
 */
export function partitionCategories(
  categories: readonly string[],
  loaderNames: ReadonlySet<string>
): { categories: string[]; loaders: string[] } {
  const out: { categories: string[]; loaders: string[] } = { categories: [], loaders: [] };
  for (const entry of categories) {
    if (loaderNames.has(normaliseLoaderName(entry))) {
      out.loaders.push(normaliseLoaderName(entry));
    } else {
      out.categories.push(entry);
    }
  }
  return out;
}

export function normaliseSearchHit(
  hit: ModrinthSearchHitWire,
  loaderNames: ReadonlySet<string>
): ModProject {
  const split = partitionCategories(hit.categories, loaderNames);
  return {
    id: qualifiedId('modrinth', hit.project_id),
    provider: 'modrinth',
    projectId: hit.project_id,
    slug: hit.slug ?? null,
    title: hit.title,
    summary: hit.description ?? null,
    // Search returns only the short blurb; the full body needs a project fetch.
    description: null,
    author: hit.author ?? null,
    iconUrl: hit.icon_url ?? null,
    projectUrl: webUrl(hit.project_type, hit.slug ?? hit.project_id),
    license: hit.license ?? null,
    downloads: Math.max(0, Math.trunc(hit.downloads)),
    followers: Math.max(0, Math.trunc(hit.follows)),
    kind: kindFromProjectType(hit.project_type),
    clientSide: hit.client_side,
    serverSide: hit.server_side,
    environment: deriveEnvironment(hit.client_side, hit.server_side),
    categories: split.categories,
    loaders: split.loaders,
    // `versions` on a *hit* is game versions. On a *project* it is version ids. Same key.
    gameVersions: hit.versions,
  };
}

export function normaliseProject(project: ModrinthProjectWire): ModProject {
  return {
    id: qualifiedId('modrinth', project.id),
    provider: 'modrinth',
    projectId: project.id,
    slug: project.slug ?? null,
    title: project.title,
    summary: project.description ?? null,
    description: project.body ?? null,
    // A project object has `team` and `organization` but no author name — only search hits
    // carry one. Left null rather than filled with an id the UI would render as gibberish.
    author: null,
    iconUrl: project.icon_url ?? null,
    projectUrl: webUrl(project.project_type, project.slug ?? project.id),
    license: project.license?.id ?? null,
    downloads: Math.max(0, Math.trunc(project.downloads)),
    followers: Math.max(0, Math.trunc(project.followers)),
    kind: kindFromProjectType(project.project_type),
    clientSide: project.client_side,
    serverSide: project.server_side,
    environment: deriveEnvironment(project.client_side, project.server_side),
    // Primary categories drive search ranking, additional ones are secondary; the UI wants both
    // and the distinction is not worth a second field.
    categories: [...project.categories, ...project.additional_categories],
    loaders: project.loaders.map(normaliseLoaderName),
    gameVersions: project.game_versions,
  };
}

const DEPENDENCY_KINDS = {
  required: 'required',
  optional: 'optional',
  incompatible: 'incompatible',
  embedded: 'embedded',
} as const;

export function normaliseVersion(version: ModrinthVersionWire): ModVersion {
  // `primary` marks the jar to install; the rest are sources/javadoc/signatures. Older versions
  // occasionally flag none, in which case the first file is the only sensible guess.
  const file = version.files.find((f) => f.primary) ?? version.files[0];
  const dependencies: DependencyRef[] = version.dependencies.map((dep) => ({
    provider: 'modrinth' as ModProvider,
    projectId: dep.project_id ?? null,
    versionId: dep.version_id ?? null,
    fileName: dep.file_name ?? null,
    kind: DEPENDENCY_KINDS[dep.dependency_type],
  }));

  return {
    id: qualifiedId('modrinth', version.id),
    provider: 'modrinth',
    versionId: version.id,
    projectId: version.project_id,
    versionNumber: version.version_number ?? null,
    name: version.name ?? null,
    channel: version.version_type,
    gameVersions: version.game_versions,
    loaders: version.loaders.map(normaliseLoaderName),
    dependencies,
    file: {
      name: file?.filename ?? '',
      url: file?.url ?? null,
      size: file?.size ?? null,
      sha1: file?.hashes.sha1 ?? null,
      sha512: file?.hashes.sha512 ?? null,
    },
    // Modrinth has no distribution opt-out; every listed file is fetchable. The only way to be
    // undownloadable here is to have no file at all, which happens on malformed drafts.
    downloadable: file !== undefined,
    downloadBlockedReason: file === undefined ? 'This version has no downloadable file' : null,
    environmentTags: [],
    publishedAt: version.date_published ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

export interface ModrinthClientOptions extends Partial<Omit<HttpClientOptions, 'baseUrl'>> {
  baseUrl?: string;
  /** PAT, sent verbatim in `Authorization` — Modrinth does *not* use a `Bearer` prefix. */
  token?: string;
}

/** Tags barely move; projects move daily; searches are throwaway. */
const TTL = {
  tag: 12 * 60 * 60 * 1000,
  project: 10 * 60 * 1000,
  version: 5 * 60 * 1000,
  search: 60 * 1000,
} as const;

export class ModrinthClient implements ProviderClient {
  readonly provider: ModProvider = 'modrinth';
  private readonly http: HttpClient;
  private readonly log: Logger;
  private loaderNameCache: ReadonlySet<string> | undefined;

  constructor(options: ModrinthClientOptions = {}) {
    const { baseUrl, token, headers, logger, ...rest } = options;
    this.log = logger ?? rootLogger.child('mods:modrinth');
    this.http = new HttpClient({
      ...rest,
      baseUrl: baseUrl ?? MODRINTH_BASE_URL,
      rateLimit: rest.rateLimit ?? MODRINTH_RATE_LIMIT,
      defaultTtlMs: rest.defaultTtlMs ?? TTL.project,
      logger: this.log,
      headers: { ...headers, ...(token ? { authorization: token } : {}) },
    });
  }

  /** Modrinth is fully usable anonymously; a token only raises write scope, not read limits. */
  availability(): ProviderAvailability {
    return { available: true };
  }

  /* --- Tags ------------------------------------------------------------- */

  /**
   * Loader tags carry a full inline SVG each (~1–2 KB), so this is a genuinely expensive call
   * for the two fields we want. Cached for twelve hours and memoised on the instance.
   */
  async getLoaders(): Promise<Result<{ name: string; supportedProjectTypes: string[] }[]>> {
    const response = await this.http.getJson('/v2/tag/loader', z.array(loaderTagSchema), {
      ttlMs: TTL.tag,
    });
    if (!response.ok) {
      return response;
    }
    return ok(
      response.value.map((tag) => ({
        name: normaliseLoaderName(tag.name),
        supportedProjectTypes: tag.supported_project_types,
      }))
    );
  }

  /**
   * The canonical Minecraft version ordering, newest-first.
   *
   * This is the only reliable ordering that exists. Minecraft moved to calendar versioning
   * (`1.21.11` is followed by `26.1`), so every string comparator and every semver parser
   * mis-sorts the current release list. `VersionIndex` answers by position instead.
   */
  async getGameVersions(): Promise<Result<GameVersionEntry[]>> {
    const response = await this.http.getJson(
      '/v2/tag/game_version',
      z.array(gameVersionTagSchema),
      {
        ttlMs: TTL.tag,
      }
    );
    if (!response.ok) {
      return response;
    }
    return ok(
      response.value.map((tag) => ({
        version: tag.version,
        versionType: tag.version_type,
        date: tag.date,
        major: tag.major,
      }))
    );
  }

  async getVersionIndex(): Promise<Result<VersionIndex>> {
    const entries = await this.getGameVersions();
    return entries.ok ? ok(new VersionIndex(entries.value)) : entries;
  }

  async getCategories(): Promise<Result<{ name: string; projectType: string; header: string }[]>> {
    const response = await this.http.getJson('/v2/tag/category', z.array(categoryTagSchema), {
      ttlMs: TTL.tag,
    });
    if (!response.ok) {
      return response;
    }
    return ok(
      response.value.map((tag) => ({
        name: tag.name,
        projectType: tag.project_type,
        header: tag.header,
      }))
    );
  }

  async getSideTypes(): Promise<Result<string[]>> {
    return this.http.getJson('/v2/tag/side_type', z.array(z.string()), { ttlMs: TTL.tag });
  }

  async getLicenses(): Promise<Result<{ short: string; name: string }[]>> {
    return this.http.getJson('/v2/tag/license', z.array(licenseTagSchema), { ttlMs: TTL.tag });
  }

  /** Loader names for `partitionCategories`, falling back to the baked-in list when offline. */
  private async loaderNames(): Promise<ReadonlySet<string>> {
    if (this.loaderNameCache) {
      return this.loaderNameCache;
    }
    const tags = await this.getLoaders();
    if (tags.ok) {
      this.loaderNameCache = new Set(tags.value.map((tag) => tag.name));
      return this.loaderNameCache;
    }
    this.log.warn('loader tags unavailable, using the bundled list to partition categories', {
      reason: tags.error.message,
    });
    return new Set(FALLBACK_LOADER_NAMES);
  }

  /* --- Search ------------------------------------------------------------ */

  async search(query: ResolvedModSearchQuery): Promise<Result<ModSearchResult>> {
    const facets = buildFacets(query);
    if (!facets.ok) {
      return facets;
    }

    const limit = Math.min(query.limit, MODRINTH_MAX_LIMIT);
    const response = await this.http.getJson('/v2/search', searchResponseSchema, {
      ttlMs: TTL.search,
      query: {
        query: query.query || undefined,
        facets: facets.value,
        index: query.sort,
        offset: query.offset,
        limit,
      },
    });
    if (!response.ok) {
      return response;
    }

    const loaderNames = await this.loaderNames();
    return ok({
      hits: response.value.hits.map((hit) => normaliseSearchHit(hit, loaderNames)),
      offset: response.value.offset,
      limit: response.value.limit,
      totalHits: response.value.total_hits,
      providers: ['modrinth'],
      degraded: [],
    });
  }

  /* --- Projects ---------------------------------------------------------- */

  /** Accepts a base62 id or a slug interchangeably. */
  async getProject(idOrSlug: string): Promise<Result<ModProject>> {
    const response = await this.http.getJson(
      `/v2/project/${encodeURIComponent(idOrSlug)}`,
      projectSchema,
      { ttlMs: TTL.project }
    );
    return response.ok ? ok(normaliseProject(response.value)) : response;
  }

  /**
   * Bulk fetch. The intended relief valve for the 300/min budget — one call instead of N, and
   * the difference between a dependency graph resolving in a second and in a minute.
   */
  async getProjects(ids: readonly string[]): Promise<Result<ModProject[]>> {
    if (ids.length === 0) {
      return ok([]);
    }
    const response = await this.http.getJson('/v2/projects', z.array(projectSchema), {
      ttlMs: TTL.project,
      query: { ids: encodeArrayParam([...ids]) },
    });
    return response.ok ? ok(response.value.map(normaliseProject)) : response;
  }

  /**
   * Every project + version this project depends on, in one call.
   *
   * Worth preferring over walking `dependencies[]` by hand: it collapses N round trips into
   * one, and it returns full objects, so the graph walk needs no follow-up fetches.
   */
  async getProjectDependencies(
    idOrSlug: string
  ): Promise<Result<{ projects: ModProject[]; versions: ModVersion[] }>> {
    const response = await this.http.getJson(
      `/v2/project/${encodeURIComponent(idOrSlug)}/dependencies`,
      z.object({
        projects: z.array(projectSchema).default([]),
        versions: z.array(versionSchema).default([]),
      }),
      { ttlMs: TTL.project }
    );
    if (!response.ok) {
      return response;
    }
    return ok({
      projects: response.value.projects.map(normaliseProject),
      versions: response.value.versions.filter(isListed).map(normaliseVersion),
    });
  }

  /* --- Versions ---------------------------------------------------------- */

  /**
   * Versions of one project, newest first.
   *
   * Both filters go through `encodeArrayParam`; passing a plain string here would return the
   * project's entire history with a 200 and no indication anything was ignored.
   *
   * Results are filtered to `status === 'listed'`. Archived, draft, unlisted and scheduled
   * versions all come back from the API, and offering a user a scheduled-but-unreleased jar
   * produces a download that 404s.
   */
  async getVersions(idOrSlug: string, filter: VersionFilter = {}): Promise<Result<ModVersion[]>> {
    const response = await this.http.getJson(
      `/v2/project/${encodeURIComponent(idOrSlug)}/version`,
      z.array(versionSchema),
      {
        ttlMs: TTL.version,
        query: {
          loaders: filter.loaders?.length ? encodeArrayParam([...filter.loaders]) : undefined,
          game_versions: filter.gameVersions?.length
            ? encodeArrayParam([...filter.gameVersions])
            : undefined,
        },
      }
    );
    if (!response.ok) {
      return response;
    }
    const listed = response.value.filter(isListed).map(normaliseVersion);
    return ok(filter.limit === undefined ? listed : listed.slice(0, filter.limit));
  }

  async getVersion(versionId: string): Promise<Result<ModVersion>> {
    const response = await this.http.getJson(
      `/v2/version/${encodeURIComponent(versionId)}`,
      versionSchema,
      { ttlMs: TTL.version }
    );
    return response.ok ? ok(normaliseVersion(response.value)) : response;
  }

  async getVersionsBulk(ids: readonly string[]): Promise<Result<ModVersion[]>> {
    if (ids.length === 0) {
      return ok([]);
    }
    const response = await this.http.getJson('/v2/versions', z.array(versionSchema), {
      ttlMs: TTL.version,
      query: { ids: encodeArrayParam([...ids]) },
    });
    return response.ok ? ok(response.value.map(normaliseVersion)) : response;
  }

  /* --- Hash lookup ------------------------------------------------------- */

  /**
   * Identify a jar already on disk.
   *
   * Not filtered by `status`: this answers "what *is* this file", and a file that has since
   * been archived or unlisted is still exactly what it is. Filtering here would report a jar
   * the user is currently running as unknown.
   *
   * `algorithm` is always sent explicitly. The server appears to length-detect sha512 without
   * it, but that is undocumented behaviour to build on.
   */
  async versionFromHash(
    hash: string,
    algorithm: 'sha1' | 'sha512' = 'sha1'
  ): Promise<Result<ModVersion>> {
    const response = await this.http.getJson(
      `/v2/version_file/${encodeURIComponent(hash)}`,
      versionSchema,
      { ttlMs: TTL.version, query: { algorithm } }
    );
    return response.ok ? ok(normaliseVersion(response.value)) : response;
  }

  /**
   * Bulk hash lookup — the right way to scan an existing `mods/` folder.
   *
   * The response is a map keyed by the queried hash and **omits misses entirely**; there is no
   * null placeholder. Diffing the request against the response keys is the only way to learn
   * which jars are not on Modrinth, so that diff is done here rather than left to callers.
   */
  async versionsFromHashes(
    hashes: readonly string[],
    algorithm: 'sha1' | 'sha512' = 'sha1'
  ): Promise<Result<{ found: Map<string, ModVersion>; missing: string[] }>> {
    if (hashes.length === 0) {
      return ok({ found: new Map(), missing: [] });
    }
    const response = await this.http.postJson(
      '/v2/version_files',
      { hashes: [...hashes], algorithm },
      z.record(z.string(), versionSchema)
    );
    if (!response.ok) {
      return response;
    }
    const found = new Map<string, ModVersion>();
    for (const [hash, version] of Object.entries(response.value)) {
      found.set(hash, normaliseVersion(version));
    }
    return ok({ found, missing: hashes.filter((hash) => !found.has(hash)) });
  }
}

/** Archived/draft/unlisted/scheduled versions are still returned by the API. Curate them out. */
const isListed = (version: ModrinthVersionWire): boolean => version.status === 'listed';
