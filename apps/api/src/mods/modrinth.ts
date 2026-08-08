import { z } from 'zod';
import { PlatterError } from '@platter/shared';
import { retry } from '../lib/async.js';
import type {
  ModDependency,
  ModDetail,
  ModFile,
  ModProvider,
  ModSearchQuery,
  ModSearchResult,
  ModSummary,
  ModVersion,
  ModVersionFilter,
} from './registry.js';

/**
 * Modrinth, API v2. No key required.
 *
 * Two things the docs are emphatic about and which are implemented here rather than left to
 * chance: send a User-Agent that identifies the application and a way to contact its authors,
 * and stay inside the published rate limit. An anonymous client that discovers the limit by
 * being 429'd has already degraded the service for everyone else behind the same address, so
 * this client tracks the `X-Ratelimit-*` headers and pauses itself before it is told to.
 */

const DEFAULT_BASE_URL = 'https://api.modrinth.com/v2';

/**
 * Read straight from the environment because `config.ts` belongs to another module and has no
 * key for this. `PLATTER_CONTACT` is the useful half: Modrinth asks for a way to reach the
 * operator of a busy client, and an install that sets it gets a warning instead of a block.
 */
function defaultUserAgent(): string {
  const contact = process.env['PLATTER_CONTACT']?.trim();
  const base = 'Platter/0.1.0 (+https://github.com/platter-panel/platter)';
  return contact && contact.length > 0 ? `${base} (${contact})` : base;
}

const REQUEST_TIMEOUT_MS = 15_000;

/** Requests left in the window below which the client waits for the reset rather than racing it. */
const RATE_LIMIT_RESERVE = 5;

/** A window is a minute; never sleep longer than one, whatever the header claims. */
const MAX_RATE_LIMIT_WAIT_MS = 65_000;

const MAX_SEARCH_LIMIT = 100;
const MAX_VERSIONS = 200;

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/**
 * Only the fields Platter actually uses are declared, and enums fall back rather than throw:
 * Modrinth adding a `version_type` this build has never heard of must not take mod search
 * down. Unknown keys are dropped by zod, so a new field is free.
 */
const sideSchema = z.enum(['required', 'optional', 'unsupported', 'unknown']).catch('unknown');

const projectTypeSchema = z
  .enum(['mod', 'modpack', 'resourcepack', 'shader', 'datapack', 'plugin'])
  .catch('mod');

const searchHitSchema = z.object({
  project_id: z.string(),
  project_type: projectTypeSchema.default('mod'),
  slug: z.string(),
  title: z.string(),
  description: z.string().default(''),
  author: z.string().nullish(),
  categories: z.array(z.string()).default([]),
  display_categories: z.array(z.string()).default([]),
  versions: z.array(z.string()).default([]),
  downloads: z.number().default(0),
  follows: z.number().default(0),
  icon_url: z.string().nullish(),
  date_modified: z.string().nullish(),
  license: z.string().nullish(),
  client_side: sideSchema.default('unknown'),
  server_side: sideSchema.default('unknown'),
});

const searchResponseSchema = z.object({
  hits: z.array(searchHitSchema).default([]),
  offset: z.number().default(0),
  limit: z.number().default(0),
  total_hits: z.number().default(0),
});

const projectSchema = z.object({
  id: z.string(),
  slug: z.string(),
  project_type: projectTypeSchema.default('mod'),
  title: z.string(),
  description: z.string().default(''),
  body: z.string().default(''),
  categories: z.array(z.string()).default([]),
  additional_categories: z.array(z.string()).default([]),
  game_versions: z.array(z.string()).default([]),
  loaders: z.array(z.string()).default([]),
  downloads: z.number().default(0),
  followers: z.number().default(0),
  icon_url: z.string().nullish(),
  issues_url: z.string().nullish(),
  source_url: z.string().nullish(),
  wiki_url: z.string().nullish(),
  discord_url: z.string().nullish(),
  updated: z.string().nullish(),
  client_side: sideSchema.default('unknown'),
  server_side: sideSchema.default('unknown'),
  license: z
    .object({ id: z.string().nullish(), name: z.string().nullish(), url: z.string().nullish() })
    .nullish(),
  donation_urls: z
    .array(z.object({ platform: z.string().nullish(), url: z.string().nullish() }))
    .default([]),
  gallery: z
    .array(
      z.object({
        url: z.string(),
        featured: z.boolean().default(false),
        title: z.string().nullish(),
        description: z.string().nullish(),
      }),
    )
    .default([]),
});

const memberSchema = z.object({
  role: z.string().default(''),
  user: z.object({ username: z.string().default(''), name: z.string().nullish() }),
});

const versionSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  name: z.string().default(''),
  version_number: z.string().default(''),
  changelog: z.string().nullish(),
  date_published: z.string().nullish(),
  downloads: z.number().default(0),
  version_type: z.enum(['release', 'beta', 'alpha']).catch('release').default('release'),
  game_versions: z.array(z.string()).default([]),
  loaders: z.array(z.string()).default([]),
  files: z
    .array(
      z.object({
        filename: z.string(),
        url: z.string(),
        size: z.number().default(0),
        primary: z.boolean().default(false),
        hashes: z.object({ sha512: z.string().nullish(), sha1: z.string().nullish() }).default({}),
      }),
    )
    .default([]),
  dependencies: z
    .array(
      z.object({
        project_id: z.string().nullish(),
        version_id: z.string().nullish(),
        file_name: z.string().nullish(),
        dependency_type: z
          .enum(['required', 'optional', 'incompatible', 'embedded'])
          .catch('optional')
          .default('optional'),
      }),
    )
    .default([]),
});

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function nullish(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
}

function projectUrl(slug: string, projectType: string): string {
  // Modrinth routes plugins, datapacks and mods all under /mod in practice; the others have
  // their own segment. Getting this wrong only costs a redirect, never a broken link.
  const segment =
    projectType === 'modpack' || projectType === 'resourcepack' || projectType === 'shader'
      ? projectType
      : 'mod';
  return `https://modrinth.com/${segment}/${slug}`;
}

function toSummary(hit: z.infer<typeof searchHitSchema>): ModSummary {
  return {
    source: 'modrinth',
    projectId: hit.project_id,
    slug: hit.slug,
    title: hit.title,
    summary: hit.description,
    author: nullish(hit.author),
    iconUrl: nullish(hit.icon_url),
    downloads: Math.max(0, Math.trunc(hit.downloads)),
    follows: Math.max(0, Math.trunc(hit.follows)),
    // `display_categories` is the human-facing subset; the raw list also carries loader tags,
    // which are already reported separately and would read as nonsense in a category chip.
    categories: hit.display_categories.length > 0 ? hit.display_categories : hit.categories,
    loaders: [],
    gameVersions: hit.versions,
    clientSide: hit.client_side,
    serverSide: hit.server_side,
    license: nullish(hit.license),
    projectType: hit.project_type,
    updatedAt: nullish(hit.date_modified),
    url: projectUrl(hit.slug, hit.project_type),
  };
}

function toDetail(project: z.infer<typeof projectSchema>, author: string | null): ModDetail {
  const license = project.license ?? null;
  return {
    source: 'modrinth',
    projectId: project.id,
    slug: project.slug,
    title: project.title,
    summary: project.description,
    author,
    iconUrl: nullish(project.icon_url),
    downloads: Math.max(0, Math.trunc(project.downloads)),
    follows: Math.max(0, Math.trunc(project.followers)),
    categories: [...project.categories, ...project.additional_categories],
    loaders: project.loaders,
    gameVersions: project.game_versions,
    clientSide: project.client_side,
    serverSide: project.server_side,
    license: nullish(license?.name) ?? nullish(license?.id),
    projectType: project.project_type,
    updatedAt: nullish(project.updated),
    url: projectUrl(project.slug, project.project_type),
    description: project.body,
    descriptionFormat: 'markdown',
    gallery: project.gallery.map((image) => ({
      url: image.url,
      title: nullish(image.title),
      description: nullish(image.description),
      featured: image.featured,
    })),
    licenseUrl: nullish(license?.url),
    sourceUrl: nullish(project.source_url),
    issuesUrl: nullish(project.issues_url),
    wikiUrl: nullish(project.wiki_url),
    discordUrl: nullish(project.discord_url),
    donationUrls: project.donation_urls.flatMap((entry) => {
      const url = nullish(entry.url);
      return url === null ? [] : [{ platform: nullish(entry.platform) ?? 'Donate', url }];
    }),
  };
}

/**
 * Picks the artifact to install.
 *
 * `primary` is Modrinth's own answer and is right almost always; the fallbacks exist for the
 * handful of versions that never set it, where a `.jar` beats the sources zip sitting next
 * to it.
 */
function pickFile(files: z.infer<typeof versionSchema>['files']): ModFile | null {
  const candidate =
    files.find((file) => file.primary) ??
    files.find((file) => file.filename.toLowerCase().endsWith('.jar')) ??
    files[0];
  if (!candidate) return null;
  return {
    filename: candidate.filename,
    url: candidate.url,
    sizeBytes: Math.max(0, Math.trunc(candidate.size)),
    sha512: nullish(candidate.hashes.sha512),
    sha1: nullish(candidate.hashes.sha1),
  };
}

function toDependency(raw: z.infer<typeof versionSchema>['dependencies'][number]): ModDependency {
  return {
    source: 'modrinth',
    projectId: nullish(raw.project_id),
    versionId: nullish(raw.version_id),
    kind: raw.dependency_type,
    fileName: nullish(raw.file_name),
  };
}

function toVersion(raw: z.infer<typeof versionSchema>): ModVersion | null {
  const file = pickFile(raw.files);
  // A version with no downloadable file cannot be installed and cannot be reasoned about, so
  // it is dropped rather than offered and then failing at the last step.
  if (!file) return null;
  return {
    source: 'modrinth',
    projectId: raw.project_id,
    versionId: raw.id,
    name: raw.name.length > 0 ? raw.name : raw.version_number,
    versionNumber: raw.version_number,
    channel: raw.version_type,
    gameVersions: raw.game_versions,
    loaders: raw.loaders,
    publishedAt: nullish(raw.date_published),
    downloads: Math.max(0, Math.trunc(raw.downloads)),
    dependencies: raw.dependencies.map(toDependency),
    file,
    changelog: nullish(raw.changelog),
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ModrinthOptions {
  /** Injected by tests. Nothing here reaches the network when this is supplied. */
  fetch?: FetchLike;
  baseUrl?: string;
  userAgent?: string;
}

function upstreamError(status: number, body: string): PlatterError {
  if (status === 404) return new PlatterError('not_found', 'Modrinth does not have that project.');
  if (status === 410)
    return new PlatterError('not_found', 'That project was removed from Modrinth.');
  if (status === 429) {
    return new PlatterError(
      'rate_limited',
      'Modrinth is rate limiting Platter. Try again shortly.',
    );
  }
  if (status === 400 || status === 422) {
    return new PlatterError('bad_request', 'Modrinth rejected that query.');
  }
  if (status >= 500) {
    return new PlatterError('service_unavailable', 'Modrinth is not responding.', {
      retryable: true,
    });
  }
  // Anything else is ours to log and theirs to explain; the body is not shown to a client.
  return new PlatterError('service_unavailable', 'Modrinth returned an unexpected response.', {
    retryable: false,
    cause: new Error(`modrinth ${status}: ${body.slice(0, 200)}`),
  });
}

class ModrinthClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly userAgent: string;

  /** Mirrors the server's view of the window so we can stop before it does. */
  private remaining = Number.POSITIVE_INFINITY;
  private resetAt = 0;
  /** Serialises the pre-flight wait so a burst of parallel calls sleeps once, not each. */
  private gate: Promise<void> = Promise.resolve();

  constructor(options: ModrinthOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.userAgent = options.userAgent ?? defaultUserAgent();
  }

  private noteHeaders(response: Response): void {
    const remaining = Number(response.headers.get('x-ratelimit-remaining'));
    if (Number.isFinite(remaining)) this.remaining = remaining;

    const reset = Number(response.headers.get('x-ratelimit-reset'));
    // Documented as seconds until the window rolls over, not an absolute timestamp.
    if (Number.isFinite(reset) && reset >= 0) {
      this.resetAt = Date.now() + Math.min(reset * 1000, MAX_RATE_LIMIT_WAIT_MS);
    }
  }

  /**
   * Holds the next request until the window rolls over, once the budget is nearly spent.
   *
   * Chained through `this.gate` so ten concurrent dependency lookups share one sleep instead
   * of each waiting the full window in parallel and then all firing at the same instant.
   */
  private async awaitBudget(signal: AbortSignal): Promise<void> {
    const wait = this.gate.then(async () => {
      const delayMs = this.resetAt - Date.now();
      if (signal.aborted || this.remaining > RATE_LIMIT_RESERVE || delayMs <= 0) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(finish, Math.min(delayMs, MAX_RATE_LIMIT_WAIT_MS));
        function finish(): void {
          clearTimeout(timer);
          signal.removeEventListener('abort', finish);
          resolve();
        }
        signal.addEventListener('abort', finish, { once: true });
      });
      // Optimistic: the next response will correct it. Without this, every queued caller sees
      // the same exhausted budget and sleeps in turn.
      this.remaining = Number.POSITIVE_INFINITY;
    });
    this.gate = wait.catch(() => undefined);
    await wait;
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
        await this.awaitBudget(combined);
        combined.throwIfAborted();

        let response: Response;
        try {
          response = await this.fetchImpl(url, {
            method: 'GET',
            headers: { accept: 'application/json', 'user-agent': this.userAgent },
            signal: combined,
          });
        } catch (error) {
          // The caller's own abort must not be laundered into a retryable upstream failure.
          if (signal?.aborted) throw error;
          throw new PlatterError('service_unavailable', 'Modrinth could not be reached.', {
            retryable: true,
            cause: error,
          });
        }

        this.noteHeaders(response);
        if (!response.ok)
          throw upstreamError(response.status, await response.text().catch(() => ''));
        return (await response.json()) as unknown;
      },
      { attempts: 3, baseMs: 400, maxMs: 4000, ...(signal ? { signal } : {}) },
    );

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      // Their contract changed, not ours. Not retryable — the next attempt returns the same
      // shape — and never `internal_error`, which would point an operator at Platter's logs.
      throw new PlatterError(
        'service_unavailable',
        'Modrinth returned data Platter could not read.',
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
 * Modrinth's facet grammar: the outer array is ANDed, each inner array is ORed. So
 * `[["categories:fabric","categories:quilt"],["versions:1.21"]]` reads "fabric or quilt, and
 * 1.21" — which is exactly the shape a server's accepted-loader list needs.
 */
function buildFacets(query: ModSearchQuery): string[][] {
  const facets: string[][] = [];
  if (query.loaders.length > 0) {
    facets.push(query.loaders.map((loader) => `categories:${loader}`));
  }
  if (query.gameVersion) facets.push([`versions:${query.gameVersion}`]);
  if (query.categories.length > 0) {
    facets.push(query.categories.map((category) => `categories:${category}`));
  }
  if (query.projectType) {
    // Modrinth has no `plugin` project type — a Bukkit plugin is a `mod` carrying a
    // bukkit-family loader tag, which the loader facet above already selects.
    const type = query.projectType === 'plugin' ? 'mod' : query.projectType;
    facets.push([`project_type:${type}`]);
  }
  if (query.serverSideOnly) {
    facets.push(['server_side:required', 'server_side:optional']);
  }
  return facets;
}

export function createModrinthProvider(options: ModrinthOptions = {}): ModProvider {
  const client = new ModrinthClient(options);

  /**
   * The project endpoint returns a team id, not an author. The approval UI needs a name, so
   * the owning member is fetched alongside it — and a failure there degrades to `null` rather
   * than failing the whole lookup, because "who wrote it" is not worth a 502.
   */
  async function fetchAuthor(ref: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const members = await client.get(
        `/project/${encodeURIComponent(ref)}/members`,
        null,
        z.array(memberSchema),
        signal,
      );
      const owner = members.find((member) => member.role.toLowerCase() === 'owner') ?? members[0];
      if (!owner) return null;
      return nullish(owner.user.name) ?? nullish(owner.user.username);
    } catch {
      return null;
    }
  }

  async function versionsFor(
    ref: string,
    filter: ModVersionFilter,
    signal?: AbortSignal,
  ): Promise<ModVersion[]> {
    const params = new URLSearchParams();
    if (filter.loaders && filter.loaders.length > 0) {
      params.set('loaders', JSON.stringify([...filter.loaders]));
    }
    if (filter.gameVersion) params.set('game_versions', JSON.stringify([filter.gameVersion]));

    const raw = await client.get(
      `/project/${encodeURIComponent(ref)}/version`,
      params,
      z.array(versionSchema),
      signal,
    );

    const limit = Math.min(filter.limit ?? MAX_VERSIONS, MAX_VERSIONS);
    const versions: ModVersion[] = [];
    for (const entry of raw) {
      const version = toVersion(entry);
      if (version) versions.push(version);
      if (versions.length >= limit) break;
    }
    return versions;
  }

  return {
    source: 'modrinth',

    async search(query, signal): Promise<ModSearchResult> {
      const params = new URLSearchParams();
      if (query.query) params.set('query', query.query);
      const facets = buildFacets(query);
      if (facets.length > 0) params.set('facets', JSON.stringify(facets));
      params.set('limit', String(Math.min(query.limit, MAX_SEARCH_LIMIT)));
      params.set('offset', String(query.offset));

      const response = await client.get('/search', params, searchResponseSchema, signal);
      return {
        hits: response.hits.map(toSummary),
        total: Math.max(0, Math.trunc(response.total_hits)),
        offset: query.offset,
        limit: query.limit,
      };
    },

    async getProject(ref, signal): Promise<ModDetail> {
      const [project, author] = await Promise.all([
        client.get(`/project/${encodeURIComponent(ref)}`, null, projectSchema, signal),
        fetchAuthor(ref, signal),
      ]);
      return toDetail(project, author);
    },

    listVersions: versionsFor,

    async getVersion(versionRef, _projectRef, signal): Promise<ModVersion> {
      const raw = await client.get(
        `/version/${encodeURIComponent(versionRef)}`,
        null,
        versionSchema,
        signal,
      );
      const version = toVersion(raw);
      if (!version) {
        throw new PlatterError('not_found', 'That Modrinth version has no downloadable file.');
      }
      return version;
    },
  };
}
