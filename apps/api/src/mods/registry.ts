import { z } from 'zod';
import { PlatterError } from '@platter/shared';
import { createCurseForgeProvider } from './curseforge.js';
import { createModrinthProvider } from './modrinth.js';

/**
 * The provider-neutral mod vocabulary, and the registry that hands out providers.
 *
 * Everything above this file — resolution, the installer, proposals, the routes — speaks only
 * these shapes. Modrinth and CurseForge disagree about almost every field name, about how a
 * loader is spelled, about whether a checksum is SHA-512 or SHA-1, and about whether a project
 * even has a stable slug; normalising that once here is what keeps `resolve.ts` free of
 * `if (source === 'curseforge')`.
 *
 * These are zod schemas rather than bare interfaces because they are used in three places that
 * all need a runtime check: HTTP responses, the JSON snapshot a proposal stores, and the JSON
 * manifest the installer keeps on the server volume. A hand-written interface would have let
 * a stored record from an older build deserialise into something with missing fields.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const MOD_SOURCES = ['modrinth', 'curseforge'] as const;
export const modSourceSchema = z.enum(MOD_SOURCES);
export type ModSource = (typeof MOD_SOURCES)[number];

/**
 * Whether a mod has to be present on a given side. `unknown` is a real answer, not a
 * placeholder: CurseForge does not publish this at all, and pretending it said "optional"
 * would let a client-only shader be proposed for a server.
 */
export const MOD_SIDES = ['required', 'optional', 'unsupported', 'unknown'] as const;
export const modSideSchema = z.enum(MOD_SIDES);
export type ModSide = (typeof MOD_SIDES)[number];

export const MOD_PROJECT_TYPES = [
  'mod',
  'plugin',
  'modpack',
  'resourcepack',
  'shader',
  'datapack',
  'world',
  'other',
] as const;
export const modProjectTypeSchema = z.enum(MOD_PROJECT_TYPES);
export type ModProjectType = (typeof MOD_PROJECT_TYPES)[number];

export const MOD_RELEASE_CHANNELS = ['release', 'beta', 'alpha'] as const;
export const modReleaseChannelSchema = z.enum(MOD_RELEASE_CHANNELS);
export type ModReleaseChannel = (typeof MOD_RELEASE_CHANNELS)[number];

/** Mirrors Modrinth's `dependency_type`; CurseForge's numeric relation types map onto it. */
export const MOD_DEPENDENCY_KINDS = ['required', 'optional', 'incompatible', 'embedded'] as const;
export const modDependencyKindSchema = z.enum(MOD_DEPENDENCY_KINDS);
export type ModDependencyKind = (typeof MOD_DEPENDENCY_KINDS)[number];

export const modGalleryImageSchema = z.object({
  url: z.string(),
  title: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  featured: z.boolean().default(false),
});
export type ModGalleryImage = z.infer<typeof modGalleryImageSchema>;

/**
 * The downloadable artifact.
 *
 * Both hashes are nullable because only Modrinth publishes SHA-512; CurseForge publishes
 * SHA-1 (and sometimes nothing at all, for files whose author opted out of third-party
 * distribution). `install.ts` refuses a file with neither, which is the whole point of
 * carrying them this far.
 */
export const modFileSchema = z.object({
  filename: z.string(),
  /** Empty when the author disabled third-party downloads — the installer refuses those. */
  url: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha512: z.string().nullable().default(null),
  sha1: z.string().nullable().default(null),
});
export type ModFile = z.infer<typeof modFileSchema>;

export const modDependencySchema = z.object({
  source: modSourceSchema,
  /** Null on the rare Modrinth dependency that names only a version. */
  projectId: z.string().nullable().default(null),
  /** Non-null pins an exact version; two disagreeing pins are a conflict, not a choice. */
  versionId: z.string().nullable().default(null),
  kind: modDependencyKindSchema,
  fileName: z.string().nullable().default(null),
});
export type ModDependency = z.infer<typeof modDependencySchema>;

export const modSummarySchema = z.object({
  source: modSourceSchema,
  projectId: z.string(),
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  author: z.string().nullable().default(null),
  iconUrl: z.string().nullable().default(null),
  downloads: z.number().int().nonnegative().default(0),
  follows: z.number().int().nonnegative().default(0),
  categories: z.array(z.string()).default([]),
  loaders: z.array(z.string()).default([]),
  gameVersions: z.array(z.string()).default([]),
  clientSide: modSideSchema.default('unknown'),
  serverSide: modSideSchema.default('unknown'),
  license: z.string().nullable().default(null),
  projectType: modProjectTypeSchema.default('mod'),
  updatedAt: z.string().nullable().default(null),
  /** The provider's own page. The approval UI links out to it for a second opinion. */
  url: z.string(),
});
export type ModSummary = z.infer<typeof modSummarySchema>;

/**
 * Everything a human needs to approve a mod without leaving Platter.
 *
 * The long tail here — gallery, licence URL, issue tracker, source — is not decoration. The
 * approval screen is the only place a reviewer gets to judge whether an agent's suggestion is
 * a real, maintained project or a two-download typosquat, and sending them to a third-party
 * site to find out defeats the point of the gate.
 */
export const modDetailSchema = modSummarySchema.extend({
  /** The full body, as the provider publishes it: Markdown on Modrinth, HTML on CurseForge. */
  description: z.string().default(''),
  descriptionFormat: z.enum(['markdown', 'html', 'text']).default('text'),
  gallery: z.array(modGalleryImageSchema).default([]),
  licenseUrl: z.string().nullable().default(null),
  sourceUrl: z.string().nullable().default(null),
  issuesUrl: z.string().nullable().default(null),
  wikiUrl: z.string().nullable().default(null),
  discordUrl: z.string().nullable().default(null),
  donationUrls: z.array(z.object({ platform: z.string(), url: z.string() })).default([]),
});
export type ModDetail = z.infer<typeof modDetailSchema>;

export const modVersionSchema = z.object({
  source: modSourceSchema,
  projectId: z.string(),
  versionId: z.string(),
  name: z.string(),
  versionNumber: z.string(),
  channel: modReleaseChannelSchema.default('release'),
  gameVersions: z.array(z.string()).default([]),
  loaders: z.array(z.string()).default([]),
  publishedAt: z.string().nullable().default(null),
  downloads: z.number().int().nonnegative().default(0),
  dependencies: z.array(modDependencySchema).default([]),
  file: modFileSchema,
  changelog: z.string().nullable().default(null),
});
export type ModVersion = z.infer<typeof modVersionSchema>;

export const modSearchResultSchema = z.object({
  hits: z.array(modSummarySchema),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});
export type ModSearchResult = z.infer<typeof modSearchResultSchema>;

/** Per-source outcome, so a UI can say "CurseForge is down" instead of quietly showing less. */
export const modSearchSourceStatusSchema = z.object({
  source: modSourceSchema,
  total: z.number().int().nonnegative(),
  error: z.string().nullable().default(null),
});

export const aggregateModSearchResultSchema = modSearchResultSchema.extend({
  sources: z.array(modSearchSourceStatusSchema).default([]),
});
export type AggregateModSearchResult = z.infer<typeof aggregateModSearchResultSchema>;

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

export interface ModSearchQuery {
  query: string | null;
  /** A concrete Minecraft version. Null when the server tracks a moving alias. */
  gameVersion: string | null;
  /** Acceptable loaders, most specific first. Empty means "do not filter on loader". */
  loaders: readonly string[];
  categories: readonly string[];
  projectType: ModProjectType | null;
  /** Restricts to projects that run server-side. Ignored by providers that cannot express it. */
  serverSideOnly: boolean;
  limit: number;
  offset: number;
}

export interface ModVersionFilter {
  gameVersion?: string | null;
  loaders?: readonly string[];
  /** Upper bound on versions returned. Providers page internally; this caps the total. */
  limit?: number;
}

/**
 * What a source has to be able to answer.
 *
 * Deliberately small. Anything a provider cannot do — CurseForge cannot filter by server-side,
 * Modrinth has no numeric project ids — is absorbed inside the implementation rather than
 * leaking a capability flag into every caller.
 */
export interface ModProvider {
  readonly source: ModSource;
  search(query: ModSearchQuery, signal?: AbortSignal): Promise<ModSearchResult>;
  /** `ref` is an id or a slug; providers accept whichever they support. */
  getProject(ref: string, signal?: AbortSignal): Promise<ModDetail>;
  listVersions(ref: string, filter: ModVersionFilter, signal?: AbortSignal): Promise<ModVersion[]>;
  /** `projectRef` is required by CurseForge, whose file ids are only unique within a project. */
  getVersion(
    versionRef: string,
    projectRef: string | null,
    signal?: AbortSignal,
  ): Promise<ModVersion>;
}

// ---------------------------------------------------------------------------
// Clamping — nothing an upstream returns crosses this line unbounded
// ---------------------------------------------------------------------------

/**
 * A Modrinth body is arbitrary user-authored Markdown and some are hundreds of kilobytes. It
 * is snapshotted into every proposal and rendered in the approval UI, so it is truncated
 * here — once, at the only place upstream data enters — rather than at each of those.
 */
const MAX_DESCRIPTION_CHARS = 64 * 1024;
const MAX_GALLERY_IMAGES = 20;
const MAX_CHANGELOG_CHARS = 32 * 1024;
const MAX_DEPENDENCIES = 64;
const MAX_LIST_ENTRIES = 256;

const TRUNCATION_NOTE = '\n\n…truncated by Platter.';

function clampText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max) + TRUNCATION_NOTE;
}

function clampList<T>(values: T[], max: number): T[] {
  return values.length <= max ? values : values.slice(0, max);
}

function clampDetail(detail: ModDetail): ModDetail {
  return {
    ...detail,
    description: clampText(detail.description, MAX_DESCRIPTION_CHARS),
    gallery: clampList(detail.gallery, MAX_GALLERY_IMAGES),
    categories: clampList(detail.categories, MAX_LIST_ENTRIES),
    gameVersions: clampList(detail.gameVersions, MAX_LIST_ENTRIES),
    loaders: clampList(detail.loaders, MAX_LIST_ENTRIES),
  };
}

function clampVersion(version: ModVersion): ModVersion {
  return {
    ...version,
    changelog:
      version.changelog === null ? null : clampText(version.changelog, MAX_CHANGELOG_CHARS),
    dependencies: clampList(version.dependencies, MAX_DEPENDENCIES),
    gameVersions: clampList(version.gameVersions, MAX_LIST_ENTRIES),
    loaders: clampList(version.loaders, MAX_LIST_ENTRIES),
  };
}

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

/**
 * Bounded LRU with a TTL.
 *
 * Both bounds matter. The TTL exists because a proposal's whole security story is that
 * approval re-reads live state — caching a project for an hour would quietly turn that
 * re-read into a replay of the snapshot. The entry cap exists because this process runs for
 * months and the key space is "every mod on Modrinth".
 */
class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert so Map iteration order is least-recently-used first.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Short enough that "approve re-reads live state" stays true; long enough to survive a page. */
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 500;

/**
 * Wraps a provider so that everything leaving it is clamped and cached.
 *
 * Search is deliberately not cached: it is keyed by free text, so the hit rate is poor and the
 * key space is unbounded — exactly the shape that turns a cache into a memory leak.
 */
interface HardenedProvider {
  provider: ModProvider;
  /** Drops every cached answer, so the next read goes to the network. */
  invalidate: () => void;
}

function harden(provider: ModProvider): HardenedProvider {
  const projects = new TtlCache<ModDetail>(CACHE_MAX_ENTRIES, CACHE_TTL_MS);
  const versions = new TtlCache<ModVersion>(CACHE_MAX_ENTRIES, CACHE_TTL_MS);

  const hardened: ModProvider = {
    source: provider.source,

    async search(query, signal) {
      const result = await provider.search(query, signal);
      return {
        ...result,
        hits: result.hits.map((hit) => ({
          ...hit,
          categories: clampList(hit.categories, MAX_LIST_ENTRIES),
        })),
      };
    },

    async getProject(ref, signal) {
      const cached = projects.get(ref);
      if (cached) return cached;
      const detail = clampDetail(await provider.getProject(ref, signal));
      projects.set(ref, detail);
      // Slug and id both reach this method; caching under both saves the second lookup.
      if (detail.projectId !== ref) projects.set(detail.projectId, detail);
      return detail;
    },

    async listVersions(ref, filter, signal) {
      // Not cached: the filter is part of the key and callers vary it per server, and a stale
      // "newest compatible version" is the one answer this module must never give.
      const list = await provider.listVersions(ref, filter, signal);
      return list.map(clampVersion);
    },

    async getVersion(versionRef, projectRef, signal) {
      const key = `${projectRef ?? ''}/${versionRef}`;
      const cached = versions.get(key);
      if (cached) return cached;
      const version = clampVersion(await provider.getVersion(versionRef, projectRef, signal));
      versions.set(key, version);
      return version;
    },
  };

  return {
    provider: hardened,
    invalidate: () => {
      projects.clear();
      versions.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

let providers: Map<ModSource, HardenedProvider> | null = null;

function load(): Map<ModSource, HardenedProvider> {
  const loaded = new Map<ModSource, HardenedProvider>();
  loaded.set('modrinth', harden(createModrinthProvider()));

  // CurseForge needs an API key. Without one the source simply is not offered: no error, no
  // half-working entry in the picker, and search still works because Modrinth needs no key.
  const curseforge = createCurseForgeProvider();
  if (curseforge) loaded.set('curseforge', harden(curseforge));

  return loaded;
}

function all(): Map<ModSource, HardenedProvider> {
  providers ??= load();
  return providers;
}

export function availableModSources(): ModSource[] {
  return [...all().keys()];
}

export function isModSourceAvailable(source: ModSource): boolean {
  return all().has(source);
}

/**
 * `not_implemented` rather than `not_found`: the source is a real thing this build knows
 * about, it just is not configured here, and the message says so.
 */
export function getModProvider(source: ModSource): ModProvider {
  const entry = all().get(source);
  if (!entry) {
    throw new PlatterError(
      'not_implemented',
      source === 'curseforge'
        ? 'CurseForge is not configured. Set CURSEFORGE_API_KEY to enable it.'
        : `The ${source} mod source is not available.`,
    );
  }
  return entry.provider;
}

/**
 * Forces the next read to go upstream.
 *
 * Approving a proposal has to compare the snapshot against *live* state; served from the
 * 60-second cache it would compare the snapshot against a copy of itself and never notice a
 * change. Called there, and nowhere else — the cache is worth having for browsing.
 */
export function invalidateModCaches(source?: ModSource): void {
  for (const [key, entry] of all()) {
    if (source === undefined || key === source) entry.invalidate();
  }
}

/** Drops cached providers and their caches. Tests re-read the environment through this. */
export function resetModProviders(): void {
  providers = null;
}

function describeSourceError(error: unknown): string {
  return error instanceof PlatterError ? error.message : 'That source could not be reached.';
}

/**
 * Searches every configured source and merges the hits.
 *
 * `offset` is applied per source and the merged page is sorted by downloads, so paging is an
 * approximation once more than one source is configured — the alternative is fetching every
 * page from every source to sort globally, which is a lot of upstream traffic to make page
 * three of a browse UI exactly right.
 *
 * One source failing degrades to the others and is reported in `sources`; only a total
 * failure throws, because "no results" and "everything is down" must not look the same.
 */
export async function searchAllSources(
  query: ModSearchQuery,
  sources: readonly ModSource[] = availableModSources(),
  signal?: AbortSignal,
): Promise<AggregateModSearchResult> {
  const targets = sources.filter((source) => isModSourceAvailable(source));
  if (targets.length === 0) {
    // Naming the requested sources matters: "curseforge is not configured" is actionable,
    // "no mod source is configured" sends an operator looking for a problem that is not there.
    throw new PlatterError(
      'not_implemented',
      sources.length > 0
        ? `None of the requested mod sources are configured (${sources.join(', ')}).`
        : 'No mod source is configured.',
    );
  }

  const settled = await Promise.all(
    targets.map(async (source) => {
      try {
        return { source, result: await getModProvider(source).search(query, signal), error: null };
      } catch (error) {
        return { source, result: null, error };
      }
    }),
  );

  const failures = settled.filter((entry) => entry.result === null);
  if (failures.length === targets.length) {
    const first = failures[0];
    throw first?.error instanceof PlatterError
      ? first.error
      : new PlatterError('service_unavailable', 'No mod source could be reached.', {
          retryable: true,
        });
  }

  const hits = settled
    .flatMap((entry) => entry.result?.hits ?? [])
    .sort((left, right) => right.downloads - left.downloads)
    .slice(0, query.limit);

  return {
    hits,
    total: settled.reduce((sum, entry) => sum + (entry.result?.total ?? 0), 0),
    offset: query.offset,
    limit: query.limit,
    sources: settled.map((entry) => ({
      source: entry.source,
      total: entry.result?.total ?? 0,
      error: entry.error === null ? null : describeSourceError(entry.error),
    })),
  };
}
