import {
  type DependencyKind,
  dependencyKindSchema,
  type ModKind,
  type ModProvider,
  type ModSide,
  modKindSchema,
  modProviderSchema,
  modSideSchema,
} from '@platter/shared';
import { z } from 'zod';

/**
 * The provider-neutral model.
 *
 * Modrinth and CurseForge disagree about almost everything: field names, id types, how a loader
 * is encoded, whether "versions" means game versions or version ids. Every one of those
 * disagreements is normalised here, at the client boundary, so that `compat.ts` — the file that
 * actually decides whether something will run — never has to ask which provider it came from.
 *
 * Two shapes in here are load-bearing and deserve the explanation up front:
 *
 *   1. `ModEnvironment` models Modrinth **v3** semantics, not v2's `client_side`/`server_side`
 *      pair, even though v2 is what we currently talk to. See `deriveEnvironment` below.
 *   2. `ModProject.loaders` / `.gameVersions` are the *historical union* across every version a
 *      project ever published. They are for display and search only. Resolving compatibility
 *      from them is the single most common way to ship a false positive, and the field comments
 *      say so at every layer.
 */

/* -------------------------------------------------------------------------- */
/* Environment (side) compatibility                                            */
/* -------------------------------------------------------------------------- */

/**
 * Where a mod can run.
 *
 * These are Modrinth v3's `environment` values, harvested from live projects. v2 expresses the
 * same idea as two independent 4-valued enums (`client_side` × `server_side` = 16 combinations,
 * most meaningless), and that encoding genuinely cannot represent some real cases: "works on
 * either side, but is better with both" collapses to `optional`/`optional`, which is
 * indistinguishable from "either one alone is fine".
 *
 * So the internal model is v3-shaped and v2 is derived from it. Going the other way — storing
 * the v2 pair and synthesising v3 later — silently discards the distinction, and we would have
 * to re-fetch every project to recover it when v3 ships.
 */
export const MOD_ENVIRONMENTS = [
  'client_and_server',
  'client_only',
  'client_only_server_optional',
  'client_or_server',
  'client_or_server_prefers_both',
  'server_only',
  'server_only_client_optional',
  'unknown',
] as const;

export const modEnvironmentSchema = z.enum(MOD_ENVIRONMENTS);
export type ModEnvironment = z.infer<typeof modEnvironmentSchema>;

/**
 * Collapse a v2 `client_side`/`server_side` pair into the v3 enum.
 *
 * The table is written out rather than computed because two of the rows are judgement calls and
 * a reader deserves to see them:
 *
 *   - `optional` + `unsupported` → `client_only`. The server cannot load it at all, so whatever
 *     "optional" meant on the client, the client is the only place it runs.
 *   - `unsupported` + `unsupported` → `unknown`, not "runs nowhere". Authors leave both at the
 *     default far more often than they publish a mod that runs on neither side, and treating
 *     sloppy metadata as a hard "this cannot work" would block real, working mods.
 *
 * Anything involving `unknown` stays `unknown`: a guess here becomes a blocker in `compat.ts`,
 * and a wrong blocker is worse than an honest "we don't know".
 */
export function deriveEnvironment(clientSide: ModSide, serverSide: ModSide): ModEnvironment {
  if (clientSide === 'unknown' || serverSide === 'unknown') {
    return 'unknown';
  }
  if (clientSide === 'required') {
    if (serverSide === 'required') {
      return 'client_and_server';
    }
    return serverSide === 'optional' ? 'client_only_server_optional' : 'client_only';
  }
  if (clientSide === 'optional') {
    if (serverSide === 'required') {
      return 'server_only_client_optional';
    }
    return serverSide === 'optional' ? 'client_or_server' : 'client_only';
  }
  // clientSide === 'unsupported'
  if (serverSide === 'required' || serverSide === 'optional') {
    return 'server_only';
  }
  return 'unknown';
}

/**
 * The inverse, for writing v2-shaped rows (`mod_projects.client_side` / `.server_side`).
 *
 * Lossy on purpose, and only in one place: `client_or_server_prefers_both` becomes
 * `optional`/`optional`, which is exactly the distinction v2 cannot hold. That round-trip loss
 * is the argument for storing the environment as the source of truth.
 */
export function environmentToSides(environment: ModEnvironment): {
  clientSide: ModSide;
  serverSide: ModSide;
} {
  switch (environment) {
    case 'client_and_server':
      return { clientSide: 'required', serverSide: 'required' };
    case 'client_only':
      return { clientSide: 'required', serverSide: 'unsupported' };
    case 'client_only_server_optional':
      return { clientSide: 'required', serverSide: 'optional' };
    case 'client_or_server':
      return { clientSide: 'optional', serverSide: 'optional' };
    case 'client_or_server_prefers_both':
      return { clientSide: 'optional', serverSide: 'optional' };
    case 'server_only':
      return { clientSide: 'unsupported', serverSide: 'required' };
    case 'server_only_client_optional':
      return { clientSide: 'optional', serverSide: 'required' };
    default:
      return { clientSide: 'unknown', serverSide: 'unknown' };
  }
}

/** How the *server* is affected. This is the only question a server manager actually asks. */
export function serverSideOf(environment: ModEnvironment): ModSide {
  return environmentToSides(environment).serverSide;
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Ids are provider-qualified (`modrinth:AANobbMI`, `curseforge:238222`).
 *
 * CurseForge mod ids are integers and Modrinth's are base62 strings, so an unqualified id is
 * ambiguous the moment both providers are enabled — and `mod_projects` has a composite unique
 * index on `(provider, project_id)` precisely because of that. Qualifying at the boundary means
 * a single string is enough to key caches, dedupe sets and dependency graphs.
 */
export function qualifiedId(provider: ModProvider, id: string | number): string {
  return `${provider}:${id}`;
}

export function parseQualifiedId(value: string): { provider: ModProvider; id: string } | undefined {
  const separator = value.indexOf(':');
  if (separator <= 0) {
    return undefined;
  }
  const provider = modProviderSchema.safeParse(value.slice(0, separator));
  const id = value.slice(separator + 1);
  return provider.success && id.length > 0 ? { provider: provider.data, id } : undefined;
}

/* -------------------------------------------------------------------------- */
/* Projects                                                                    */
/* -------------------------------------------------------------------------- */

export const modProjectSchema = z.object({
  /** `${provider}:${projectId}`. Stable across providers; safe as a Map key. */
  id: z.string().min(1),
  provider: modProviderSchema,
  /** Upstream id, verbatim. CurseForge's numeric id is stringified, never parsed back. */
  projectId: z.string().min(1),
  slug: z.string().nullable(),
  title: z.string(),
  /** Short blurb. Modrinth `description`, CurseForge `summary`. */
  summary: z.string().nullable(),
  /** Long form. Modrinth `body` (markdown), CurseForge `/description` (HTML). May be absent. */
  description: z.string().nullable(),
  author: z.string().nullable(),
  iconUrl: z.string().nullable(),
  projectUrl: z.string().nullable(),
  /** SPDX id where one exists; `LicenseRef-*` and CurseForge's free text otherwise. */
  license: z.string().nullable(),
  downloads: z.number().int().nonnegative(),
  /** Modrinth `follows`/`followers`; CurseForge has no equivalent, so 0. */
  followers: z.number().int().nonnegative(),
  kind: modKindSchema,

  /** v2-shaped sides, derived from `environment`. Written straight to `mod_projects`. */
  clientSide: modSideSchema,
  serverSide: modSideSchema,
  /** The authoritative side model — see `deriveEnvironment`. */
  environment: modEnvironmentSchema,

  /** True categories only. Loader names are partitioned out during normalisation. */
  categories: z.array(z.string()),
  /**
   * HISTORICAL UNION across every published version. Display and search only.
   * Compatibility is resolved from `ModVersion`, never from here.
   */
  loaders: z.array(z.string()),
  /** HISTORICAL UNION. Same warning as `loaders`. */
  gameVersions: z.array(z.string()),
});

export type ModProject = z.infer<typeof modProjectSchema>;

/* -------------------------------------------------------------------------- */
/* Versions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A dependency edge.
 *
 * All three identifying fields are independently optional, and the combination is semantic:
 *
 *   - `versionId` set          → pinned to one exact upstream version.
 *   - `projectId` only         → any version of that project satisfies it.
 *   - `fileName` only          → an external/bundled artefact the API cannot resolve. Opaque;
 *                                the user has to place it themselves.
 *
 * CurseForge only ever produces the middle case: its dependency records carry a `modId` and
 * nothing else — no file id, no version range. Resolving "which file of that mod fits this
 * server" is our problem, which is why `resolveDependencyGraph` takes a resolver rather than a
 * lookup table.
 */
export const dependencyRefSchema = z.object({
  provider: modProviderSchema,
  projectId: z.string().nullable(),
  versionId: z.string().nullable(),
  fileName: z.string().nullable(),
  kind: dependencyKindSchema,
});

export type DependencyRef = z.infer<typeof dependencyRefSchema>;

export const modFileSchema = z.object({
  name: z.string(),
  /**
   * Null when the file exists but cannot be fetched — in practice always a CurseForge author
   * who disabled third-party distribution. See `ModVersion.downloadable`.
   */
  url: z.string().nullable(),
  /** Bytes. CurseForge's `fileLength` (compressed download size), never `fileSizeOnDisk`. */
  size: z.number().int().nonnegative().nullable(),
  sha1: z.string().nullable(),
  /** Modrinth only; CurseForge publishes SHA-1 and MD5 and nothing stronger. */
  sha512: z.string().nullable(),
});

export type ModFile = z.infer<typeof modFileSchema>;

export const releaseChannelSchema = z.enum(['release', 'beta', 'alpha']);
export type ReleaseChannel = z.infer<typeof releaseChannelSchema>;

export const modVersionSchema = z.object({
  /** `${provider}:${versionId}`. */
  id: z.string().min(1),
  provider: modProviderSchema,
  versionId: z.string().min(1),
  /** The owning project's upstream id — *not* qualified, to match `mod_versions`. */
  projectId: z.string().min(1),
  versionNumber: z.string().nullable(),
  name: z.string().nullable(),
  channel: releaseChannelSchema,

  /** Real Minecraft versions this file declares. Authoritative for compatibility. */
  gameVersions: z.array(z.string()),
  /** Real loaders this file declares. Authoritative for compatibility. */
  loaders: z.array(z.string()),
  dependencies: z.array(dependencyRefSchema),
  file: modFileSchema,

  /**
   * False when the artefact cannot be fetched programmatically. Recorded rather than inferred
   * from a null URL so the UI can say *why* — "the author disabled third-party downloads" is a
   * different conversation from "the download failed".
   */
  downloadable: z.boolean(),
  downloadBlockedReason: z.string().nullable(),

  /**
   * Environment hints CurseForge smuggles into a file's version tags (`Client` / `Server`,
   * `gameVersionTypeId: 75208`). Empty for Modrinth, which has a real field for this. Used only
   * as positive evidence — a `server` tag suppresses the name-based client-only heuristic.
   */
  environmentTags: z.array(z.enum(['client', 'server'])),

  /** ISO 8601. `mod_versions.published_at` stores `Date.parse()` of this. */
  publishedAt: z.string().nullable(),
});

export type ModVersion = z.infer<typeof modVersionSchema>;

/* -------------------------------------------------------------------------- */
/* Search                                                                      */
/* -------------------------------------------------------------------------- */

export const modSortSchema = z.enum(['relevance', 'downloads', 'follows', 'newest', 'updated']);
export type ModSort = z.infer<typeof modSortSchema>;

export const modSearchQuerySchema = z.object({
  query: z.string().optional(),
  kind: modKindSchema.default('mod'),
  /** Loader names to filter on, e.g. `['fabric']`. Provider-specific encoding is internal. */
  loaders: z.array(z.string()).default([]),
  gameVersions: z.array(z.string()).default([]),
  categories: z.array(z.string()).default([]),
  sort: modSortSchema.default('relevance'),
  /** Modrinth clamps at 100 without saying so; the clients clamp explicitly instead. */
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
  /** Drop anything whose server side is `unsupported`. */
  serverCompatibleOnly: z.boolean().default(false),
  /** Restrict the fan-out. Empty means "every enabled provider". */
  providers: z.array(modProviderSchema).default([]),
});

export type ModSearchQuery = z.input<typeof modSearchQuerySchema>;
export type ResolvedModSearchQuery = z.infer<typeof modSearchQuerySchema>;

export const modSearchResultSchema = z.object({
  hits: z.array(modProjectSchema),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  /**
   * Best-effort. Modrinth is exact; CurseForge clamps its own `totalCount` and cannot be
   * paginated past 10,000 results anyway, so treat this as "are there more" only.
   */
  totalHits: z.number().int().nonnegative(),
  /** Providers that actually answered. A missing provider is a degraded result, not an error. */
  providers: z.array(modProviderSchema),
  /** Providers that were asked and failed, with the reason. Surfaced, never swallowed. */
  degraded: z.array(z.object({ provider: modProviderSchema, reason: z.string() })).default([]),
});

export type ModSearchResult = z.infer<typeof modSearchResultSchema>;

/* -------------------------------------------------------------------------- */
/* Provider availability                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Why a provider is or is not usable.
 *
 * CurseForge needs a reviewed API key that most self-hosters will never have. That is a normal
 * configuration state, not a failure, so it is a value the UI can branch on rather than an
 * exception thrown from the first call.
 */
export type ProviderAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

/* -------------------------------------------------------------------------- */
/* Filters shared by both clients                                              */
/* -------------------------------------------------------------------------- */

export interface VersionFilter {
  loaders?: readonly string[];
  gameVersions?: readonly string[];
  /** Cap on how many versions to return. Providers page differently; both honour this. */
  limit?: number;
}

/** The read surface both provider clients implement, and all `ModRegistry` depends on. */
export interface ProviderClient {
  readonly provider: ModProvider;
  availability(): ProviderAvailability;
  search(query: ResolvedModSearchQuery): Promise<import('@platter/shared').Result<ModSearchResult>>;
  getProject(idOrSlug: string): Promise<import('@platter/shared').Result<ModProject>>;
  getVersions(
    idOrSlug: string,
    filter?: VersionFilter
  ): Promise<import('@platter/shared').Result<ModVersion[]>>;
  getVersion(versionId: string): Promise<import('@platter/shared').Result<ModVersion>>;
}

/* -------------------------------------------------------------------------- */
/* Small helpers used by both clients                                          */
/* -------------------------------------------------------------------------- */

/** Both providers hand back loader names in mixed case ("Fabric", "NeoForge"). */
export const normaliseLoaderName = (name: string): string => name.trim().toLowerCase();

export type { DependencyKind, ModKind, ModProvider, ModSide };
