import { z } from 'zod';
import { PlatterError } from '@platter/shared';
import { retry } from '../lib/async.js';
import type {
  ModDependency,
  ModDetail,
  ModProjectType,
  ModProvider,
  ModSearchQuery,
  ModSearchResult,
  ModSummary,
  ModVersion,
  ModVersionFilter,
} from './registry.js';

/**
 * CurseForge Core API v1.
 *
 * Unlike Modrinth this needs an API key, and Platter is expected to run without one. That
 * shapes the whole module: `createCurseForgeProvider` returns `null` when no key is
 * configured, the registry then never lists the source, and nothing anywhere else has to
 * branch on it. There is no code path that half-enables CurseForge and fails later.
 *
 * Read from the environment directly rather than through `config.ts`, which has no key for
 * this and is owned elsewhere. The value is never logged and never crosses a response.
 */

const DEFAULT_BASE_URL = 'https://api.curseforge.com/v1';

/** Minecraft. CurseForge is a multi-game catalogue and every query has to say which. */
const MINECRAFT_GAME_ID = 432;

/** CurseForge's own taxonomy ids. A class is the top-level kind of thing a project is. */
const CLASS_IDS: Record<ModProjectType, number | null> = {
  mod: 6,
  plugin: 5,
  modpack: 4471,
  resourcepack: 12,
  shader: 6552,
  datapack: 6945,
  world: 17,
  other: null,
};

const PROJECT_TYPE_BY_CLASS = new Map<number, ModProjectType>(
  Object.entries(CLASS_IDS).flatMap(([type, id]) =>
    id === null ? [] : [[id, type as ModProjectType] as const],
  ),
);

/** `modLoaderType` on search and file queries. Bukkit-family plugins have no code here. */
const MOD_LOADER_TYPES: Record<string, number> = {
  forge: 1,
  liteloader: 3,
  fabric: 4,
  quilt: 5,
  neoforge: 6,
};

/**
 * A CurseForge file mixes loader names and game versions into one `gameVersions` array, so the
 * two have to be told apart by name. Anything unrecognised that starts with a digit is treated
 * as a game version; everything else is dropped rather than guessed at.
 */
const LOADER_LABELS = new Set([
  'forge',
  'neoforge',
  'fabric',
  'quilt',
  'liteloader',
  'rift',
  'cauldron',
  'bukkit',
  'spigot',
  'paper',
  'purpur',
  'folia',
  'sponge',
]);

/** CurseForge `relationType`. 4 (Tool) and 6 (Include) have no install meaning for a server. */
const DEPENDENCY_KINDS: Record<number, ModDependency['kind'] | undefined> = {
  1: 'embedded',
  2: 'optional',
  3: 'required',
  5: 'incompatible',
};

/** `hashes[].algo`: 1 is SHA-1, 2 is MD5. MD5 is not a checksum worth verifying against. */
const HASH_ALGO_SHA1 = 1;

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAGE_SIZE = 50;
const MAX_VERSIONS = 200;
const SLUG_CACHE_MAX = 200;

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

const fileSchema = z.object({
  id: z.number(),
  modId: z.number(),
  displayName: z.string().default(''),
  fileName: z.string().default(''),
  releaseType: z.number().default(1),
  fileDate: z.string().nullish(),
  fileLength: z.number().default(0),
  downloadCount: z.number().default(0),
  /** Null when the author disabled third-party distribution. The installer refuses those. */
  downloadUrl: z.string().nullish(),
  gameVersions: z.array(z.string()).default([]),
  hashes: z.array(z.object({ value: z.string(), algo: z.number() })).default([]),
  dependencies: z
    .array(z.object({ modId: z.number(), relationType: z.number().default(0) }))
    .default([]),
});

const modSchema = z.object({
  id: z.number(),
  name: z.string().default(''),
  slug: z.string().default(''),
  summary: z.string().default(''),
  classId: z.number().nullish(),
  downloadCount: z.number().default(0),
  thumbsUpCount: z.number().default(0),
  dateModified: z.string().nullish(),
  allowModDistribution: z.boolean().nullish(),
  links: z
    .object({
      websiteUrl: z.string().nullish(),
      wikiUrl: z.string().nullish(),
      issuesUrl: z.string().nullish(),
      sourceUrl: z.string().nullish(),
    })
    .nullish(),
  logo: z.object({ url: z.string().nullish() }).nullish(),
  screenshots: z
    .array(
      z.object({
        url: z.string(),
        title: z.string().nullish(),
        description: z.string().nullish(),
      }),
    )
    .default([]),
  authors: z.array(z.object({ name: z.string().default('') })).default([]),
  categories: z.array(z.object({ name: z.string().default('') })).default([]),
  latestFiles: z.array(fileSchema).default([]),
});

const searchResponseSchema = z.object({
  data: z.array(modSchema).default([]),
  pagination: z
    .object({ index: z.number().default(0), totalCount: z.number().default(0) })
    .default({ index: 0, totalCount: 0 }),
});

const modResponseSchema = z.object({ data: modSchema });
const filesResponseSchema = z.object({ data: z.array(fileSchema).default([]) });
const fileResponseSchema = z.object({ data: fileSchema });
const descriptionResponseSchema = z.object({ data: z.string().default('') });

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function nullish(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
}

function projectTypeOf(classId: number | null | undefined): ModProjectType {
  return classId === null || classId === undefined
    ? 'mod'
    : (PROJECT_TYPE_BY_CLASS.get(classId) ?? 'other');
}

function splitGameVersions(values: readonly string[]): {
  gameVersions: string[];
  loaders: string[];
} {
  const gameVersions: string[] = [];
  const loaders: string[] = [];
  for (const value of values) {
    const normalised = value.trim().toLowerCase();
    if (LOADER_LABELS.has(normalised)) loaders.push(normalised);
    else if (/^\d/.test(normalised)) gameVersions.push(value.trim());
  }
  return { gameVersions, loaders };
}

function toSummary(mod: z.infer<typeof modSchema>): ModSummary {
  const versions = new Set<string>();
  const loaders = new Set<string>();
  for (const file of mod.latestFiles) {
    const split = splitGameVersions(file.gameVersions);
    for (const version of split.gameVersions) versions.add(version);
    for (const loader of split.loaders) loaders.add(loader);
  }

  return {
    source: 'curseforge',
    projectId: String(mod.id),
    slug: mod.slug,
    title: mod.name,
    summary: mod.summary,
    author: nullish(mod.authors[0]?.name),
    iconUrl: nullish(mod.logo?.url),
    downloads: Math.max(0, Math.trunc(mod.downloadCount)),
    // CurseForge has no follow count; thumbs-up is the nearest published signal of regard.
    follows: Math.max(0, Math.trunc(mod.thumbsUpCount)),
    categories: mod.categories.map((category) => category.name).filter((name) => name.length > 0),
    loaders: [...loaders],
    gameVersions: [...versions],
    // CurseForge publishes neither side requirement nor a licence identifier on the Core API.
    // Reporting them as unknown is the honest answer; inventing one would be worse.
    clientSide: 'unknown',
    serverSide: 'unknown',
    license: null,
    projectType: projectTypeOf(mod.classId),
    updatedAt: nullish(mod.dateModified),
    url:
      nullish(mod.links?.websiteUrl) ?? `https://www.curseforge.com/minecraft/mc-mods/${mod.slug}`,
  };
}

function toDetail(mod: z.infer<typeof modSchema>, description: string): ModDetail {
  return {
    ...toSummary(mod),
    description,
    // The description endpoint returns rendered HTML, not Markdown. The client has to know
    // which, or it either escapes real markup or renders raw tags as text.
    descriptionFormat: 'html',
    gallery: mod.screenshots.map((shot) => ({
      url: shot.url,
      title: nullish(shot.title),
      description: nullish(shot.description),
      featured: false,
    })),
    licenseUrl: null,
    sourceUrl: nullish(mod.links?.sourceUrl),
    issuesUrl: nullish(mod.links?.issuesUrl),
    wikiUrl: nullish(mod.links?.wikiUrl),
    discordUrl: null,
    donationUrls: [],
  };
}

function toVersion(file: z.infer<typeof fileSchema>, allowDistribution: boolean): ModVersion {
  const { gameVersions, loaders } = splitGameVersions(file.gameVersions);
  const sha1 = file.hashes.find((hash) => hash.algo === HASH_ALGO_SHA1)?.value;
  // `releaseType`: 1 Release, 2 Beta, 3 Alpha. Anything else is treated as a release, which
  // is the conservative reading — it will still be judged against the server's constraints.
  const channel = file.releaseType === 2 ? 'beta' : file.releaseType === 3 ? 'alpha' : 'release';

  return {
    source: 'curseforge',
    projectId: String(file.modId),
    versionId: String(file.id),
    name: file.displayName.length > 0 ? file.displayName : file.fileName,
    versionNumber: file.displayName.length > 0 ? file.displayName : file.fileName,
    channel,
    gameVersions,
    loaders,
    publishedAt: nullish(file.fileDate),
    downloads: Math.max(0, Math.trunc(file.downloadCount)),
    dependencies: file.dependencies.flatMap((dependency): ModDependency[] => {
      const kind = DEPENDENCY_KINDS[dependency.relationType];
      if (!kind) return [];
      return [
        {
          source: 'curseforge',
          projectId: String(dependency.modId),
          // CurseForge dependencies name a project, never a file, so nothing is ever pinned.
          versionId: null,
          kind,
          fileName: null,
        },
      ];
    }),
    file: {
      filename: file.fileName,
      // Empty rather than a guessed CDN path: an author who opted out of third-party
      // distribution has said no, and fabricating a URL would route around that.
      url: allowDistribution ? (nullish(file.downloadUrl) ?? '') : '',
      sizeBytes: Math.max(0, Math.trunc(file.fileLength)),
      sha512: null,
      sha1: nullish(sha1),
    },
    changelog: null,
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CurseForgeOptions {
  /** Injected by tests. Nothing here reaches the network when this is supplied. */
  fetch?: FetchLike;
  baseUrl?: string;
  /** Overrides `CURSEFORGE_API_KEY`; a blank key still disables the source. */
  apiKey?: string;
}

function upstreamError(status: number): PlatterError {
  if (status === 404)
    return new PlatterError('not_found', 'CurseForge does not have that project.');
  if (status === 401 || status === 403) {
    // Deliberately vague about the key itself: this message reaches a client.
    return new PlatterError('service_unavailable', 'CurseForge rejected Platter’s credentials.', {
      retryable: false,
    });
  }
  if (status === 429) {
    return new PlatterError(
      'rate_limited',
      'CurseForge is rate limiting Platter. Try again shortly.',
    );
  }
  if (status === 400 || status === 422) {
    return new PlatterError('bad_request', 'CurseForge rejected that query.');
  }
  if (status >= 500) {
    return new PlatterError('service_unavailable', 'CurseForge is not responding.', {
      retryable: true,
    });
  }
  return new PlatterError('service_unavailable', 'CurseForge returned an unexpected response.', {
    retryable: false,
  });
}

class CurseForgeClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(apiKey: string, options: CurseForgeOptions) {
    this.apiKey = apiKey;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  async get<T>(
    path: string,
    params: URLSearchParams | null,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const query = params && [...params.keys()].length > 0 ? `?${params.toString()}` : '';
    const url = `${this.baseUrl}${path}${query}`;

    const body = await retry(
      async () => {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

        let response: Response;
        try {
          response = await this.fetchImpl(url, {
            method: 'GET',
            headers: { accept: 'application/json', 'x-api-key': this.apiKey },
            signal: combined,
          });
        } catch (error) {
          if (signal?.aborted) throw error;
          throw new PlatterError('service_unavailable', 'CurseForge could not be reached.', {
            retryable: true,
            cause: error,
          });
        }

        if (!response.ok) throw upstreamError(response.status);
        return (await response.json()) as unknown;
      },
      { attempts: 3, baseMs: 400, maxMs: 4000, ...(signal ? { signal } : {}) },
    );

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new PlatterError(
        'service_unavailable',
        'CurseForge returned data Platter could not read.',
        {
          retryable: false,
          cause: parsed.error,
        },
      );
    }
    return parsed.data;
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Picks the loader filter CurseForge understands.
 *
 * `modLoaderType` is a single value, so an accepted-loader list has to be narrowed to one.
 * The list arrives most-specific-first, so the first entry CurseForge knows about is the
 * right choice; a Bukkit-family server matches nothing here and is left unfiltered, which is
 * correct — CurseForge separates plugins by class, not by loader.
 */
function loaderTypeFor(loaders: readonly string[]): number | null {
  for (const loader of loaders) {
    const type = MOD_LOADER_TYPES[loader];
    if (type !== undefined) return type;
  }
  return null;
}

export function createCurseForgeProvider(options: CurseForgeOptions = {}): ModProvider | null {
  const apiKey = (options.apiKey ?? process.env['CURSEFORGE_API_KEY'] ?? '').trim();
  if (apiKey.length === 0) return null;

  const client = new CurseForgeClient(apiKey, options);

  /** Bounded because slugs come from user input; oldest entry is dropped on overflow. */
  const slugToId = new Map<string, string>();

  function rememberSlug(slug: string, id: string): void {
    if (slug.length === 0) return;
    if (slugToId.size >= SLUG_CACHE_MAX) {
      const oldest = slugToId.keys().next();
      if (oldest.done !== true) slugToId.delete(oldest.value);
    }
    slugToId.set(slug, id);
  }

  /** CurseForge addresses everything by numeric id, so a slug has to be looked up first. */
  async function resolveModId(ref: string, signal?: AbortSignal): Promise<string> {
    if (/^\d+$/.test(ref)) return ref;

    const cached = slugToId.get(ref);
    if (cached) return cached;

    const params = new URLSearchParams({
      gameId: String(MINECRAFT_GAME_ID),
      slug: ref,
      pageSize: '1',
    });
    const response = await client.get('/mods/search', params, searchResponseSchema, signal);
    const first = response.data[0];
    if (!first) throw new PlatterError('not_found', 'CurseForge does not have that project.');

    const id = String(first.id);
    rememberSlug(ref, id);
    return id;
  }

  async function fetchMod(ref: string, signal?: AbortSignal): Promise<z.infer<typeof modSchema>> {
    const id = await resolveModId(ref, signal);
    const response = await client.get(
      `/mods/${encodeURIComponent(id)}`,
      null,
      modResponseSchema,
      signal,
    );
    rememberSlug(response.data.slug, String(response.data.id));
    return response.data;
  }

  return {
    source: 'curseforge',

    async search(query: ModSearchQuery, signal): Promise<ModSearchResult> {
      const params = new URLSearchParams({
        gameId: String(MINECRAFT_GAME_ID),
        index: String(query.offset),
        pageSize: String(Math.min(query.limit, MAX_PAGE_SIZE)),
        sortField: '2', // Popularity — the closest analogue to Modrinth's relevance default.
        sortOrder: 'desc',
      });
      if (query.query) params.set('searchFilter', query.query);
      if (query.gameVersion) params.set('gameVersion', query.gameVersion);

      const classId = query.projectType === null ? null : CLASS_IDS[query.projectType];
      if (classId !== null && classId !== undefined) params.set('classId', String(classId));

      const loaderType = loaderTypeFor(query.loaders);
      if (loaderType !== null) params.set('modLoaderType', String(loaderType));

      const response = await client.get('/mods/search', params, searchResponseSchema, signal);
      for (const mod of response.data) rememberSlug(mod.slug, String(mod.id));

      return {
        hits: response.data.map(toSummary),
        total: Math.max(0, Math.trunc(response.pagination.totalCount)),
        offset: query.offset,
        limit: query.limit,
      };
    },

    async getProject(ref, signal): Promise<ModDetail> {
      const mod = await fetchMod(ref, signal);
      // The body lives behind its own endpoint. Losing it would gut the approval screen, but
      // it is not worth failing the lookup for — an empty body still renders.
      const description = await client
        .get(`/mods/${mod.id}/description`, null, descriptionResponseSchema, signal)
        .then((response) => response.data)
        .catch(() => '');
      return toDetail(mod, description);
    },

    async listVersions(ref, filter: ModVersionFilter, signal): Promise<ModVersion[]> {
      const mod = await fetchMod(ref, signal);
      const params = new URLSearchParams({
        index: '0',
        pageSize: String(Math.min(filter.limit ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE)),
      });
      if (filter.gameVersion) params.set('gameVersion', filter.gameVersion);

      const loaderType = loaderTypeFor(filter.loaders ?? []);
      if (loaderType !== null) params.set('modLoaderType', String(loaderType));

      const response = await client.get(
        `/mods/${mod.id}/files`,
        params,
        filesResponseSchema,
        signal,
      );
      const allow = mod.allowModDistribution !== false;
      const limit = Math.min(filter.limit ?? MAX_VERSIONS, MAX_VERSIONS);
      return response.data.slice(0, limit).map((file) => toVersion(file, allow));
    },

    async getVersion(versionRef, projectRef, signal): Promise<ModVersion> {
      if (projectRef === null) {
        // File ids are only unique within a project, so this is not something to guess at.
        throw new PlatterError('bad_request', 'A CurseForge file needs its project id.');
      }
      const mod = await fetchMod(projectRef, signal);
      const response = await client.get(
        `/mods/${mod.id}/files/${encodeURIComponent(versionRef)}`,
        null,
        fileResponseSchema,
        signal,
      );
      return toVersion(response.data, mod.allowModDistribution !== false);
    },
  };
}
