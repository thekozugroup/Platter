import type { Server as ServerRecord } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { PlatterError, type Blueprint } from '@platter/shared';
import { minecraftModTarget, parseMinecraftVersion } from '../blueprints/index.js';
import { internal, notFound } from '../lib/errors.js';
import {
  forgetInstalledMod,
  installModFile,
  readModManifest,
  recordInstalledMod,
  removeModFile,
} from '../mods/install.js';
import {
  getModProvider,
  searchAllSources,
  type AggregateModSearchResult,
  type ModDetail,
  type ModSearchQuery,
  type ModSource,
  type ModVersion,
} from '../mods/registry.js';
import {
  acceptedLoaders,
  assertServerAcceptsMods,
  chooseCompatibleVersion,
  explainIncompatibility,
  installTargetFor,
  modKey,
  resolveModInstall,
  type InstalledMod,
  type ModServerContext,
  type Resolution,
} from '../mods/resolve.js';
import { getBlueprint } from './blueprints.js';

/**
 * Mods, from the server's point of view.
 *
 * This module is where a `Server` row becomes the compatibility context the resolver needs —
 * which Minecraft version, which loader, what is already installed — and where a resolved plan
 * becomes files on disk. It is deliberately the *only* thing that calls the installer, and the
 * only exported path to it is `applyResolution`, which `services/proposals.ts` reaches after a
 * human approval. There is no `installMod(serverId, slug)` here, because that function is
 * precisely the one an agent must not be able to call. See docs/ARCHITECTURE.md §4.
 */

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

function parseVariables(server: ServerRecord, log?: FastifyBaseLogger): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(server.variables);
  } catch {
    log?.error({ serverId: server.id }, 'server variables column is not valid JSON');
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') values[key] = value;
  }
  return values;
}

/** Stored value, falling back to the blueprint's own default — the same precedence a boot uses. */
function variableValue(
  blueprint: Blueprint,
  values: Readonly<Record<string, string>>,
  key: string,
): string {
  const stored = values[key];
  if (stored !== undefined && stored.length > 0) return stored;
  const declared = blueprint.variables.find((variable) => variable.key === key);
  return declared?.default === null || declared?.default === undefined
    ? ''
    : String(declared.default);
}

/**
 * Refuses the games that have no mod story rather than offering a broken one.
 *
 * `features.mods` is the blueprint's own answer, and today only Minecraft: Java sets it. The
 * message names the game so the operator is not left wondering whether they missed a setting.
 */
function requireModCapableBlueprint(server: ServerRecord): Blueprint {
  const blueprint = getBlueprint(server.blueprintKey);
  if (!blueprint.features.mods) {
    throw new PlatterError(
      'invalid_state',
      `Platter's mod browser does not support ${blueprint.game} yet. Add mods through the file manager instead.`,
    );
  }
  return blueprint;
}

/**
 * Builds the compatibility context for a server.
 *
 * The one subtle decision is `gameVersion`. A server pinned to `LATEST` or `SNAPSHOT` has no
 * knowable version, and the honest answer is null — the resolver then skips the game-version
 * constraint and says out loud that it did, rather than silently approving a 1.16 mod for a
 * server that is actually running 1.21.
 */
export async function buildModContext(
  server: ServerRecord,
  log?: FastifyBaseLogger,
): Promise<ModServerContext> {
  const blueprint = requireModCapableBlueprint(server);
  const values = parseVariables(server, log);

  const serverType = variableValue(blueprint, values, 'TYPE').trim().toUpperCase();
  assertServerAcceptsMods(serverType);

  const target = minecraftModTarget(serverType);
  if (target === null) throw internal(`Server type ${serverType} has no install target`);

  const rawVersion = variableValue(blueprint, values, 'VERSION').trim();
  const parsed = parseMinecraftVersion(rawVersion);
  const gameVersion = parsed !== null && parsed.channel !== 'alias' ? parsed.raw : null;

  return {
    serverId: server.id,
    serverName: server.name,
    blueprintKey: server.blueprintKey,
    serverType,
    gameVersion,
    loaders: acceptedLoaders(serverType),
    target,
    installed: await readModManifest(server.id),
  };
}

// ---------------------------------------------------------------------------
// Browsing
// ---------------------------------------------------------------------------

export interface ServerModSearchOptions {
  query?: string | null;
  categories?: readonly string[];
  sources?: readonly ModSource[];
  /** Overrides the server's own Minecraft version; `null` drops the constraint entirely. */
  gameVersion?: string | null;
  limit: number;
  offset: number;
  signal?: AbortSignal;
}

/**
 * Searches every configured source, pre-filtered to what this server could actually load.
 *
 * The loader facet is the server's accepted list, not its single type, so a Paper server finds
 * Bukkit and Spigot plugins too. `serverSideOnly` keeps client-only mods — shaders, HUD
 * tweaks — out of a list where every entry implies "install this on the server".
 */
export async function searchServerMods(
  server: ServerRecord,
  options: ServerModSearchOptions,
  log?: FastifyBaseLogger,
): Promise<AggregateModSearchResult> {
  const context = await buildModContext(server, log);
  const query: ModSearchQuery = {
    query: options.query ?? null,
    gameVersion: options.gameVersion === undefined ? context.gameVersion : options.gameVersion,
    loaders: context.loaders,
    categories: options.categories ?? [],
    projectType: context.target === 'plugins' ? 'plugin' : 'mod',
    serverSideOnly: true,
    limit: options.limit,
    offset: options.offset,
  };
  return searchAllSources(query, options.sources, options.signal);
}

export interface ServerModDetail {
  mod: ModDetail;
  /** Versions this server could load, newest first. */
  compatibleVersions: ModVersion[];
  /** The record for this project if it is already installed. */
  installed: InstalledMod | null;
  /** Where its artifact would land, or null when this server cannot load it at all. */
  target: 'mods' | 'plugins' | null;
  /** Set when nothing is compatible, and says which constraint failed. */
  incompatibleReason: string | null;
}

export async function getServerMod(
  server: ServerRecord,
  source: ModSource,
  ref: string,
  signal?: AbortSignal,
  log?: FastifyBaseLogger,
): Promise<ServerModDetail> {
  const context = await buildModContext(server, log);
  const provider = getModProvider(source);

  const mod = await provider.getProject(ref, signal);
  const versions = await provider.listVersions(
    mod.projectId,
    { gameVersion: context.gameVersion, loaders: context.loaders },
    signal,
  );

  const compatible = versions.filter(
    (version) => chooseCompatibleVersion(context, [version]).version !== null,
  );
  // The target is read from the version Platter would actually pick, not from whichever the
  // provider happened to list first.
  const best = chooseCompatibleVersion(context, compatible).version;

  return {
    mod,
    compatibleVersions: compatible,
    installed:
      context.installed.find(
        (entry) => entry.source === source && entry.projectId === mod.projectId,
      ) ?? null,
    target: best ? installTargetFor(context.serverType, best.loaders) : null,
    incompatibleReason:
      compatible.length > 0 ? null : explainIncompatibility(mod.title, context, versions, mod.url),
  };
}

export async function listServerModVersions(
  server: ServerRecord,
  source: ModSource,
  ref: string,
  signal?: AbortSignal,
  log?: FastifyBaseLogger,
): Promise<ModVersion[]> {
  const context = await buildModContext(server, log);
  return getModProvider(source).listVersions(
    ref,
    { gameVersion: context.gameVersion, loaders: context.loaders },
    signal,
  );
}

export function listInstalledMods(server: ServerRecord): Promise<InstalledMod[]> {
  return readModManifest(server.id);
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

export interface ModUpdate {
  installed: InstalledMod;
  latest: ModVersion;
  /** True when the only newer compatible build is a beta or alpha. */
  prerelease: boolean;
}

/** One upstream request per installed mod, so the fan-out is capped in both directions. */
const UPDATE_CHECK_CONCURRENCY = 4;
const MAX_UPDATE_CHECKS = 60;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Which installed mods have a newer compatible version.
 *
 * A mod whose source is no longer configured, or whose project has been taken down, is skipped
 * rather than failing the whole check: one dead project must not hide updates for the rest.
 */
export async function checkModUpdates(
  server: ServerRecord,
  signal?: AbortSignal,
  log?: FastifyBaseLogger,
): Promise<ModUpdate[]> {
  const context = await buildModContext(server, log);
  const candidates = context.installed.slice(0, MAX_UPDATE_CHECKS);

  const found = await mapWithConcurrency(candidates, UPDATE_CHECK_CONCURRENCY, async (mod) => {
    try {
      const versions = await getModProvider(mod.source).listVersions(
        mod.projectId,
        { gameVersion: context.gameVersion, loaders: context.loaders },
        signal,
      );
      const choice = chooseCompatibleVersion(context, versions);
      if (!choice.version || choice.version.versionId === mod.versionId) return null;
      return {
        installed: mod,
        latest: choice.version,
        prerelease: choice.prerelease,
      } satisfies ModUpdate;
    } catch (error) {
      log?.warn(
        { err: error, serverId: server.id, projectId: mod.projectId },
        'mod update check failed',
      );
      return null;
    }
  });

  return found.filter((entry): entry is ModUpdate => entry !== null);
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface ModPlan {
  context: ModServerContext;
  detail: ModDetail;
  version: ModVersion;
  resolution: Resolution;
}

/**
 * Resolves a specific mod (and optionally a specific version) against a server.
 *
 * Produces a plan and never touches the filesystem, which is what lets both `propose` and
 * `approve` call it — the first to snapshot what a human will be shown, the second to check
 * that the answer has not changed since.
 */
export async function planModInstall(
  server: ServerRecord,
  source: ModSource,
  projectRef: string,
  versionRef: string | null,
  signal?: AbortSignal,
  log?: FastifyBaseLogger,
): Promise<ModPlan> {
  const context = await buildModContext(server, log);
  const provider = getModProvider(source);
  const detail = await provider.getProject(projectRef, signal);

  let version: ModVersion;
  if (versionRef !== null) {
    version = await provider.getVersion(versionRef, detail.projectId, signal);
  } else {
    const versions = await provider.listVersions(
      detail.projectId,
      { gameVersion: context.gameVersion, loaders: context.loaders },
      signal,
    );
    const choice = chooseCompatibleVersion(context, versions);
    if (!choice.version) {
      throw new PlatterError(
        'conflict',
        explainIncompatibility(detail.title, context, versions, detail.url),
      );
    }
    version = choice.version;
  }

  const resolution = await resolveModInstall({
    context,
    root: { detail, version },
    ...(signal ? { signal } : {}),
  });

  return { context, detail, version, resolution };
}

// ---------------------------------------------------------------------------
// Applying — reachable only from an approved proposal
// ---------------------------------------------------------------------------

export interface ApplyOptions {
  actorId: string | null;
  actorName: string | null;
  proposalId: string | null;
  signal?: AbortSignal;
}

/**
 * Downloads and records every entry in a resolved plan.
 *
 * Each mod is recorded the moment its file lands, so a failure part-way through leaves a
 * manifest that describes exactly what is on disk. The alternative — recording everything at
 * the end — would leave orphan jars the update check could never see.
 *
 * The superseded file is deleted only after the replacement is verified and renamed into
 * place, so an interrupted update leaves the old, working mod behind rather than nothing.
 */
export async function applyResolution(
  server: ServerRecord,
  resolution: Resolution,
  options: ApplyOptions,
): Promise<InstalledMod[]> {
  if (!resolution.installable) {
    throw new PlatterError('conflict', 'That plan has unresolved problems and was not installed.');
  }

  const previous = new Map(
    (await readModManifest(server.id)).map(
      (mod) => [modKey(mod.source, mod.projectId), mod] as const,
    ),
  );
  const installed: InstalledMod[] = [];

  for (const planned of resolution.install) {
    const downloaded = await installModFile({
      serverId: server.id,
      target: planned.target,
      source: planned.source,
      file: planned.version.file,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const record: InstalledMod = {
      source: planned.source,
      projectId: planned.projectId,
      versionId: planned.version.versionId,
      slug: planned.slug,
      title: planned.title,
      versionNumber: planned.version.versionNumber,
      filename: downloaded.filename,
      target: planned.target,
      sizeBytes: downloaded.sizeBytes,
      sha512: downloaded.sha512,
      sha1: downloaded.sha1,
      gameVersions: planned.version.gameVersions,
      loaders: planned.version.loaders,
      publishedAt: planned.version.publishedAt,
      installedAt: new Date().toISOString(),
      installedById: options.actorId,
      installedByName: options.actorName,
      proposalId: options.proposalId,
    };
    await recordInstalledMod(server.id, record);
    installed.push(record);

    const superseded = previous.get(modKey(planned.source, planned.projectId));
    if (superseded && superseded.filename !== record.filename) {
      await removeModFile(server.id, superseded.target, superseded.filename);
    }
  }

  return installed;
}

/**
 * Removes an installed mod's file and its manifest row.
 *
 * `ref` may be the project id or the slug: the id is what the manifest stores, but the slug is
 * what a person reads off the mod's page, and answering 404 to the one they can actually see
 * would be a poor joke.
 */
export async function removeInstalledMod(
  server: ServerRecord,
  source: ModSource,
  ref: string,
): Promise<InstalledMod> {
  const manifest = await readModManifest(server.id);
  const match = manifest.find(
    (mod) => mod.source === source && (mod.projectId === ref || mod.slug === ref),
  );
  if (!match) throw notFound('installed mod');

  const removed = await forgetInstalledMod(server.id, source, match.projectId);
  if (!removed) throw notFound('installed mod');
  await removeModFile(server.id, removed.target, removed.filename);
  return removed;
}
