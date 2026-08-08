import { z } from 'zod';
import { PlatterError } from '@platter/shared';
import {
  MINECRAFT_SERVER_TYPES,
  compareMinecraftVersions,
  minecraftServerType,
} from '../blueprints/index.js';
import {
  getModProvider,
  modSourceSchema,
  modVersionSchema,
  type ModDetail,
  type ModSource,
  type ModVersion,
  type ModVersionFilter,
} from './registry.js';

/**
 * Compatibility resolution.
 *
 * Everything here is administration in the sense docs/ARCHITECTURE.md §1 means it: a matrix of
 * which loader accepts which artifact, and a walk over the dependency graph the providers
 * publish. No part of it knows what a mod does — only where its jar belongs and whether the
 * server can load it.
 *
 * The rule this file exists to enforce: a Fabric mod dropped into a Paper server's `plugins/`
 * directory produces a server that starts, logs nothing, and silently ignores it. That failure
 * is invisible from the panel, so it is caught here, before a byte is downloaded.
 */

// ---------------------------------------------------------------------------
// The loader matrix
// ---------------------------------------------------------------------------

/** Loaders whose artifacts belong in `plugins/`. */
const PLUGIN_LOADERS = new Set(['bukkit', 'spigot', 'paper', 'purpur', 'folia']);

/** Loaders whose artifacts belong in `mods/`. */
const MOD_LOADERS = new Set([
  'fabric',
  'forge',
  'neoforge',
  'quilt',
  'sponge',
  'liteloader',
  'rift',
  'modloader',
]);

/**
 * What each server type will actually load, most specific first.
 *
 * The order is load-bearing twice over: CurseForge takes a single `modLoaderType`, so the
 * first recognised entry wins there, and the search facets present the list to the operator
 * in this order. Supersets are spelled out rather than derived — Paper runs Spigot and Bukkit
 * plugins, Quilt runs Fabric mods — because the relation is not transitive in either
 * direction and a derived hierarchy would eventually claim something untrue.
 *
 * NeoForge deliberately does not list `forge`. The two were interchangeable on 1.20.1 and have
 * diverged since; accepting Forge jars on a NeoForge server would be right for one Minecraft
 * version and wrong for every later one, and the failure mode is a crash on boot.
 */
const LOADERS_BY_TYPE: Record<string, readonly string[]> = {
  PAPER: ['paper', 'spigot', 'bukkit'],
  PURPUR: ['purpur', 'paper', 'spigot', 'bukkit'],
  PUFFERFISH: ['paper', 'spigot', 'bukkit'],
  LEAF: ['paper', 'spigot', 'bukkit'],
  SPIGOT: ['spigot', 'bukkit'],
  BUKKIT: ['bukkit'],
  // Folia reworked the server threading model; a plugin has to opt in to be safe on it, and
  // one that has not will corrupt regions rather than fail loudly.
  FOLIA: ['folia'],

  FABRIC: ['fabric'],
  FORGE: ['forge'],
  NEOFORGE: ['neoforge'],
  QUILT: ['quilt', 'fabric'],
  SPONGEVANILLA: ['sponge'],

  MOHIST: ['forge', 'paper', 'spigot', 'bukkit'],
  MAGMA_MAINTAINED: ['forge', 'spigot', 'bukkit'],
  MAGMA: ['forge', 'spigot', 'bukkit'],
  ARCLIGHT: ['forge', 'neoforge', 'fabric', 'paper', 'spigot', 'bukkit'],
  KETTING: ['forge', 'spigot', 'bukkit'],
  CRUCIBLE: ['forge', 'spigot', 'bukkit'],
  BANNER: ['fabric', 'paper', 'spigot', 'bukkit'],
  YOUER: ['neoforge', 'forge', 'paper', 'spigot', 'bukkit'],

  // Modpack types: the pack picks the loader and Platter cannot know it from the row, so all
  // four are offered and `modpack_managed` warns that the pack sync may remove what we add.
  AUTO_CURSEFORGE: ['forge', 'neoforge', 'fabric', 'quilt'],
  MODRINTH: ['forge', 'neoforge', 'fabric', 'quilt'],
  FTBA: ['forge', 'neoforge'],
};

const MODPACK_TYPES = new Set(['AUTO_CURSEFORGE', 'MODRINTH', 'FTBA']);

/**
 * The loaders a server type will load, or an empty list for the types that load neither mods
 * nor plugins (vanilla, the limbo servers, an operator-supplied jar).
 */
export function acceptedLoaders(serverType: string): readonly string[] {
  const info = minecraftServerType(serverType);
  if (!info || info.modTarget === null) return [];
  return LOADERS_BY_TYPE[info.type] ?? [];
}

export type ModInstallTarget = 'mods' | 'plugins';

/**
 * Which directory a version's artifact belongs in, or null when this server cannot load it.
 *
 * A version that declares no loader at all is not treated as incompatible: CurseForge does not
 * tag Bukkit plugin files with a loader, and refusing those would make the whole CurseForge
 * plugin catalogue unusable. It falls back to the server type's primary target, which is the
 * same answer an operator dragging the jar in by hand would reach.
 */
export function installTargetFor(
  serverType: string,
  versionLoaders: readonly string[],
): ModInstallTarget | null {
  const info = minecraftServerType(serverType);
  if (!info || info.modTarget === null) return null;

  const accepted = new Set(acceptedLoaders(serverType));
  const matched = versionLoaders
    .map((loader) => loader.toLowerCase())
    .filter((loader) => accepted.has(loader));

  if (matched.length === 0) return versionLoaders.length === 0 ? info.modTarget : null;
  if (info.acceptsMods && matched.some((loader) => MOD_LOADERS.has(loader))) return 'mods';
  if (info.acceptsPlugins && matched.some((loader) => PLUGIN_LOADERS.has(loader))) return 'plugins';
  return null;
}

/** Every type Platter can install into, for the error message when a server cannot. */
const INSTALLABLE_TYPE_LABELS = MINECRAFT_SERVER_TYPES.filter((info) => info.modTarget !== null)
  .slice(0, 6)
  .map((info) => info.label)
  .join(', ');

// ---------------------------------------------------------------------------
// Installed state
// ---------------------------------------------------------------------------

/**
 * One row of the on-disk manifest.
 *
 * Carries enough to detect an update without a second lookup (project, version, published
 * date), enough to verify the file is still the one we put there (hash, size), and enough to
 * attribute it (who approved which proposal). `target` is stored rather than recomputed
 * because the server's `TYPE` can change after the fact, and the file is still where we left it.
 */
export const installedModSchema = z.object({
  source: modSourceSchema,
  projectId: z.string(),
  versionId: z.string(),
  slug: z.string(),
  title: z.string(),
  versionNumber: z.string(),
  filename: z.string(),
  target: z.enum(['mods', 'plugins']),
  sizeBytes: z.number().int().nonnegative(),
  sha512: z.string().nullable().default(null),
  sha1: z.string().nullable().default(null),
  gameVersions: z.array(z.string()).default([]),
  loaders: z.array(z.string()).default([]),
  publishedAt: z.string().nullable().default(null),
  installedAt: z.string(),
  installedById: z.string().nullable().default(null),
  installedByName: z.string().nullable().default(null),
  proposalId: z.string().nullable().default(null),
});
export type InstalledMod = z.infer<typeof installedModSchema>;

export function modKey(source: ModSource, projectId: string): string {
  return `${source}:${projectId}`;
}

// ---------------------------------------------------------------------------
// Server context
// ---------------------------------------------------------------------------

export interface ModServerContext {
  serverId: string;
  serverName: string;
  blueprintKey: string;
  /** The `TYPE` variable: PAPER, FABRIC, … */
  serverType: string;
  /**
   * A concrete Minecraft version, or null when the server tracks `LATEST`/`SNAPSHOT`. Null
   * disables the game-version constraint entirely and raises `unknown_game_version`, because
   * silently matching everything would be indistinguishable from a real compatibility check.
   */
  gameVersion: string | null;
  loaders: readonly string[];
  /** The type's primary directory; a per-version answer still comes from `installTargetFor`. */
  target: ModInstallTarget;
  installed: readonly InstalledMod[];
}

// ---------------------------------------------------------------------------
// Resolution output
// ---------------------------------------------------------------------------

export const RESOLUTION_PROBLEM_KINDS = [
  'no_compatible_version',
  'version_conflict',
  'incompatible_with_installed',
  'incompatible_installed',
  'dependency_cycle',
  'wrong_loader',
  'no_download',
  'unknown_game_version',
  'prerelease_selected',
  'modpack_managed',
  'graph_too_large',
  'lookup_failed',
  'already_installed',
] as const;
export type ResolutionProblemKind = (typeof RESOLUTION_PROBLEM_KINDS)[number];

export const resolutionProblemSchema = z.object({
  kind: z.enum(RESOLUTION_PROBLEM_KINDS),
  /** `error` blocks the install; `warning` is shown to the reviewer and does not. */
  severity: z.enum(['error', 'warning']),
  source: modSourceSchema.nullable().default(null),
  projectId: z.string().nullable().default(null),
  title: z.string(),
  /** Written for a human, and always says which constraint failed. */
  message: z.string(),
});
export type ResolutionProblem = z.infer<typeof resolutionProblemSchema>;

export const plannedInstallSchema = z.object({
  source: modSourceSchema,
  projectId: z.string(),
  slug: z.string(),
  title: z.string(),
  iconUrl: z.string().nullable().default(null),
  target: z.enum(['mods', 'plugins']),
  version: modVersionSchema,
  reason: z.enum(['requested', 'dependency', 'update']),
  /** Project ids that pulled this in. Empty for the requested mod itself. */
  requiredBy: z.array(z.string()).default([]),
  /** The installed version this replaces, when `reason` is `update`. */
  replacesVersionId: z.string().nullable().default(null),
});
export type PlannedInstall = z.infer<typeof plannedInstallSchema>;

export const resolutionSchema = z.object({
  install: z.array(plannedInstallSchema).default([]),
  /** Already present at exactly the resolved version — nothing to do. */
  satisfied: z.array(plannedInstallSchema).default([]),
  problems: z.array(resolutionProblemSchema).default([]),
  /** False when at least one problem has `error` severity. */
  installable: z.boolean(),
});
export type Resolution = z.infer<typeof resolutionSchema>;

// ---------------------------------------------------------------------------
// Lookup indirection
// ---------------------------------------------------------------------------

/**
 * The provider calls resolution makes, behind an interface.
 *
 * Not for elegance: it is what lets the resolver be tested against a hand-built dependency
 * graph — a chain, a conflict, a cycle — with no network and no HTTP mock.
 */
export interface ModLookup {
  getProject(source: ModSource, ref: string, signal?: AbortSignal): Promise<ModDetail>;
  listVersions(
    source: ModSource,
    ref: string,
    filter: ModVersionFilter,
    signal?: AbortSignal,
  ): Promise<ModVersion[]>;
  getVersion(
    source: ModSource,
    versionRef: string,
    projectRef: string | null,
    signal?: AbortSignal,
  ): Promise<ModVersion>;
}

/** The real lookup, backed by the configured providers. */
export const registryLookup: ModLookup = {
  getProject: (source, ref, signal) => getModProvider(source).getProject(ref, signal),
  listVersions: (source, ref, filter, signal) =>
    getModProvider(source).listVersions(ref, filter, signal),
  getVersion: (source, versionRef, projectRef, signal) =>
    getModProvider(source).getVersion(versionRef, projectRef, signal),
};

// ---------------------------------------------------------------------------
// Version selection
// ---------------------------------------------------------------------------

interface SelectionConstraints {
  gameVersion: string | null;
  accepted: ReadonlySet<string>;
  serverType: string;
}

interface CandidateVerdict {
  ok: boolean;
  failedGameVersion: boolean;
  failedLoader: boolean;
  failedDownload: boolean;
}

function judge(version: ModVersion, constraints: SelectionConstraints): CandidateVerdict {
  // An empty loader list means the provider did not tag one, not that nothing loads it.
  const loaders = version.loaders.map((loader) => loader.toLowerCase());
  const failedLoader =
    loaders.length > 0 &&
    (!loaders.some((loader) => constraints.accepted.has(loader)) ||
      installTargetFor(constraints.serverType, version.loaders) === null);

  const failedGameVersion =
    constraints.gameVersion !== null &&
    version.gameVersions.length > 0 &&
    !version.gameVersions.includes(constraints.gameVersion);

  const failedDownload = version.file.url.length === 0;

  return {
    ok: !failedLoader && !failedGameVersion && !failedDownload,
    failedGameVersion,
    failedLoader,
    failedDownload,
  };
}

function newestFirst(a: ModVersion, b: ModVersion): number {
  const left = a.publishedAt === null ? 0 : Date.parse(a.publishedAt);
  const right = b.publishedAt === null ? 0 : Date.parse(b.publishedAt);
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return right - left;
  // Falls back to the version id, which is monotonic on both providers, so the order is total
  // even when a provider omits or malforms the publish date.
  return b.versionId.localeCompare(a.versionId);
}

const MAX_LISTED_VERSIONS = 12;

function distinct(values: readonly string[], max: number): string[] {
  return [...new Set(values)].slice(0, max);
}

/**
 * Explains a failed selection in terms of the constraint that failed.
 *
 * "No compatible version" with no reason is the most frustrating answer a mod installer can
 * give, so this counts each failure mode separately and names what the candidates *did*
 * support. The operator can then act: pin a different Minecraft version, switch server type,
 * or pick another mod.
 */
interface FailureExplanation {
  kind: ResolutionProblemKind;
  message: string;
}

function explainFailure(
  title: string,
  candidates: readonly ModVersion[],
  constraints: SelectionConstraints,
  projectUrl: string,
): FailureExplanation {
  if (candidates.length === 0) {
    return {
      kind: 'no_compatible_version',
      message: `${title} has no published versions Platter can see.`,
    };
  }

  let gameVersionFailures = 0;
  let loaderFailures = 0;
  let downloadFailures = 0;
  const seenGameVersions: string[] = [];
  const seenLoaders: string[] = [];

  for (const candidate of candidates) {
    const verdict = judge(candidate, constraints);
    if (verdict.failedGameVersion) gameVersionFailures += 1;
    if (verdict.failedLoader) loaderFailures += 1;
    if (verdict.failedDownload) downloadFailures += 1;
    seenGameVersions.push(...candidate.gameVersions);
    seenLoaders.push(...candidate.loaders.map((loader) => loader.toLowerCase()));
  }

  // Distribution refusals lead when they are the whole story: the fix is not "pick another
  // version", it is "download it yourself", and burying that in a list of counts hides it.
  if (downloadFailures === candidates.length) {
    return {
      kind: 'no_download',
      message: `${title} does not allow third-party downloads, so Platter cannot install it. Download it from ${projectUrl} and upload the jar through the file manager.`,
    };
  }

  const parts: string[] = [];
  if (gameVersionFailures > 0 && constraints.gameVersion !== null) {
    const supported = distinct(seenGameVersions, MAX_LISTED_VERSIONS)
      .sort(compareMinecraftVersions)
      .reverse();
    parts.push(
      `${gameVersionFailures} of ${candidates.length} do not support Minecraft ${constraints.gameVersion}` +
        (supported.length > 0 ? ` (they support ${supported.join(', ')})` : ''),
    );
  }
  if (loaderFailures > 0) {
    const offered = distinct(seenLoaders, MAX_LISTED_VERSIONS);
    parts.push(
      `${loaderFailures} target a different loader` +
        (offered.length > 0 ? ` (${offered.join(', ')})` : '') +
        `; this server accepts ${[...constraints.accepted].join(', ') || 'none'}`,
    );
  }
  if (downloadFailures > 0) {
    parts.push(`${downloadFailures} cannot be downloaded by third-party tools`);
  }

  return {
    kind:
      loaderFailures > 0 && gameVersionFailures === 0 ? 'wrong_loader' : 'no_compatible_version',
    message:
      parts.length === 0
        ? `No version of ${title} satisfies this server's constraints.`
        : `${title} has no compatible version: ${parts.join('; ')}.`,
  };
}

export interface VersionSelection {
  version: ModVersion | null;
  /** True when only a beta/alpha build was compatible. */
  prerelease: boolean;
}

/**
 * Newest compatible version, preferring a stable channel.
 *
 * A beta is only chosen when nothing stable fits, and the caller raises `prerelease_selected`
 * when that happens — installing an alpha because it happened to be newest, without saying so,
 * is exactly the kind of surprise the approval gate exists to prevent.
 */
function selectVersion(
  candidates: readonly ModVersion[],
  constraints: SelectionConstraints,
): VersionSelection {
  const compatible = candidates
    .filter((candidate) => judge(candidate, constraints).ok)
    .sort(newestFirst);
  const stable = compatible.find((candidate) => candidate.channel === 'release');
  if (stable) return { version: stable, prerelease: false };
  const fallback = compatible[0];
  return fallback ? { version: fallback, prerelease: true } : { version: null, prerelease: false };
}

/**
 * The public form of the selection above: newest compatible version for a server, or null.
 *
 * Used by the update check, which needs the same compatibility rules as an install — an
 * "update available" badge for a version the server cannot load is worse than none.
 */
export function chooseCompatibleVersion(
  context: ModServerContext,
  versions: readonly ModVersion[],
): VersionSelection {
  return selectVersion(versions, {
    gameVersion: context.gameVersion,
    accepted: new Set(context.loaders.map((loader) => loader.toLowerCase())),
    serverType: context.serverType,
  });
}

/** Why nothing in `versions` fits, phrased for a human. */
export function explainIncompatibility(
  title: string,
  context: ModServerContext,
  versions: readonly ModVersion[],
  projectUrl: string,
): string {
  return explainFailure(
    title,
    versions,
    {
      gameVersion: context.gameVersion,
      accepted: new Set(context.loaders.map((loader) => loader.toLowerCase())),
      serverType: context.serverType,
    },
    projectUrl,
  ).message;
}

// ---------------------------------------------------------------------------
// Graph walk
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on how many projects one resolution may touch.
 *
 * A dependency graph is third-party data. A pathological or malicious one — a fan-out of
 * thousands, or a chain built to be deep — must cost a bounded number of upstream calls, not
 * however many the graph asks for.
 */
const MAX_GRAPH_NODES = 64;

interface WalkTask {
  source: ModSource;
  projectId: string;
  /** Non-null pins an exact version, which the resolver must honour or explain. */
  pinnedVersionId: string | null;
  requiredBy: readonly string[];
  path: readonly string[];
}

export interface ResolveRequest {
  context: ModServerContext;
  /** The mod the human or agent actually chose. */
  root: { detail: ModDetail; version: ModVersion };
  lookup?: ModLookup;
  signal?: AbortSignal;
}

function problem(
  kind: ResolutionProblemKind,
  severity: 'error' | 'warning',
  title: string,
  message: string,
  source: ModSource | null = null,
  projectId: string | null = null,
): ResolutionProblem {
  return { kind, severity, source, projectId, title, message };
}

/**
 * Walks the dependency graph and produces the plan.
 *
 * Only `required` dependencies are followed. `optional` is the author saying "this works
 * better with X", which is a suggestion for a human, not an instruction to download more
 * arbitrary code; `embedded` is already inside the jar and installing it separately produces
 * a duplicate-class crash.
 */
export async function resolveModInstall(request: ResolveRequest): Promise<Resolution> {
  const { context, root, signal } = request;
  const lookup = request.lookup ?? registryLookup;

  const accepted = new Set(context.loaders.map((loader) => loader.toLowerCase()));
  const constraints: SelectionConstraints = {
    gameVersion: context.gameVersion,
    accepted,
    serverType: context.serverType,
  };

  const problems: ResolutionProblem[] = [];
  const planned = new Map<string, PlannedInstall>();
  /** Which version each project is pinned to, and by whom, so a clash names both requesters. */
  const pins = new Map<string, { versionId: string; by: string }>();
  const installedByKey = new Map(
    context.installed.map((mod) => [modKey(mod.source, mod.projectId), mod] as const),
  );

  if (context.gameVersion === null) {
    problems.push(
      problem(
        'unknown_game_version',
        'warning',
        context.serverName,
        'This server tracks a moving Minecraft version, so game-version compatibility cannot be checked. Pin VERSION to a release to have Platter verify it.',
      ),
    );
  }

  if (MODPACK_TYPES.has(context.serverType.toUpperCase())) {
    problems.push(
      problem(
        'modpack_managed',
        'warning',
        context.serverName,
        'This server installs a managed modpack. The image re-syncs the pack on every start and may remove mods Platter adds.',
      ),
    );
  }

  const queue: WalkTask[] = [
    {
      source: root.version.source,
      projectId: root.version.projectId,
      pinnedVersionId: root.version.versionId,
      requiredBy: [],
      path: [],
    },
  ];
  /** Detail is looked up once per project; the root's is already in hand. */
  const details = new Map<string, ModDetail>([
    [modKey(root.detail.source, root.detail.projectId), root.detail],
  ]);
  let nodes = 0;

  while (queue.length > 0) {
    const task = queue.shift();
    if (!task) break;
    signal?.throwIfAborted();

    const key = modKey(task.source, task.projectId);

    // Already on the current path: a cycle. Reported once and not followed — dependency
    // cycles are legal in practice (two mods that require each other) and both ends still
    // get installed, but the walk must not chase them.
    if (task.path.includes(key)) {
      problems.push(
        problem(
          'dependency_cycle',
          'warning',
          details.get(key)?.title ?? task.projectId,
          `Circular dependency: ${[...task.path, key].map((entry) => entry.split(':')[1] ?? entry).join(' → ')}. Both ends are installed once.`,
          task.source,
          task.projectId,
        ),
      );
      continue;
    }

    const existing = planned.get(key);
    if (existing) {
      const pin = pins.get(key);
      if (task.pinnedVersionId !== null && pin && pin.versionId !== task.pinnedVersionId) {
        problems.push(
          problem(
            'version_conflict',
            'error',
            existing.title,
            `${existing.title} is required at two different versions: ${pin.versionId} (by ${pin.by}) and ${task.pinnedVersionId} (by ${task.requiredBy.join(', ') || 'the requested mod'}). Pick one before installing.`,
            task.source,
            task.projectId,
          ),
        );
      }
      existing.requiredBy = distinct([...existing.requiredBy, ...task.requiredBy], MAX_GRAPH_NODES);
      continue;
    }

    nodes += 1;
    if (nodes > MAX_GRAPH_NODES) {
      problems.push(
        problem(
          'graph_too_large',
          'error',
          root.detail.title,
          `${root.detail.title} pulls in more than ${MAX_GRAPH_NODES} dependencies, which Platter will not resolve automatically. Install it by hand if you are sure.`,
          root.detail.source,
          root.detail.projectId,
        ),
      );
      break;
    }

    let detail = details.get(key);
    let candidates: ModVersion[];
    try {
      detail ??= await lookup.getProject(task.source, task.projectId, signal);
      details.set(key, detail);

      if (task.pinnedVersionId !== null) {
        candidates = [
          await lookup.getVersion(task.source, task.pinnedVersionId, task.projectId, signal),
        ];
      } else {
        candidates = await lookup.listVersions(
          task.source,
          task.projectId,
          {
            gameVersion: context.gameVersion,
            loaders: context.loaders,
            limit: MAX_LISTED_VERSIONS * 4,
          },
          signal,
        );
        // Providers treat the filter as a hint at best; nothing below trusts it.
      }
    } catch (error) {
      if (error instanceof PlatterError && error.code !== 'not_found') throw error;
      problems.push(
        problem(
          'lookup_failed',
          'error',
          detail?.title ?? task.projectId,
          `A dependency (${detail?.title ?? task.projectId}) could not be looked up on ${task.source}.`,
          task.source,
          task.projectId,
        ),
      );
      continue;
    }

    const selection = selectVersion(candidates, constraints);
    if (!selection.version) {
      const explanation = explainFailure(detail.title, candidates, constraints, detail.url);
      problems.push(
        problem(
          explanation.kind,
          'error',
          detail.title,
          explanation.message,
          task.source,
          task.projectId,
        ),
      );
      continue;
    }

    const chosen = selection.version;
    const target = installTargetFor(context.serverType, chosen.loaders) ?? context.target;

    if (selection.prerelease) {
      problems.push(
        problem(
          'prerelease_selected',
          'warning',
          detail.title,
          `Only a ${chosen.channel} build of ${detail.title} is compatible with this server (${chosen.versionNumber}).`,
          task.source,
          task.projectId,
        ),
      );
    }

    const installed = installedByKey.get(key);
    planned.set(key, {
      source: task.source,
      projectId: task.projectId,
      slug: detail.slug,
      title: detail.title,
      iconUrl: detail.iconUrl,
      target,
      version: chosen,
      reason: task.path.length === 0 ? 'requested' : installed ? 'update' : 'dependency',
      requiredBy: [...task.requiredBy],
      replacesVersionId: installed ? installed.versionId : null,
    });
    pins.set(key, { versionId: chosen.versionId, by: detail.title });

    const nextPath = [...task.path, key];
    for (const dependency of chosen.dependencies) {
      if (dependency.kind === 'incompatible') {
        const clashKey =
          dependency.projectId === null ? null : modKey(task.source, dependency.projectId);
        const clash =
          clashKey === null ? undefined : (installedByKey.get(clashKey) ?? planned.get(clashKey));
        if (clash) {
          problems.push(
            problem(
              'incompatible_with_installed',
              'error',
              detail.title,
              `${detail.title} declares it cannot run alongside ${clash.title}. Remove ${clash.title} first.`,
              task.source,
              task.projectId,
            ),
          );
        }
        continue;
      }
      // `optional` is a suggestion for a human and `embedded` is already inside the jar.
      if (dependency.kind !== 'required' || dependency.projectId === null) continue;

      queue.push({
        source: dependency.source,
        projectId: dependency.projectId,
        pinnedVersionId: dependency.versionId,
        requiredBy: [task.projectId],
        path: nextPath,
      });
    }
  }

  // Installed mods that no longer fit the server itself. Reported, never auto-removed: the
  // operator may have upgraded Minecraft deliberately and be mid-migration.
  for (const mod of context.installed) {
    if (planned.has(modKey(mod.source, mod.projectId))) continue;
    const loaders = mod.loaders.map((loader) => loader.toLowerCase());
    const loaderMismatch = loaders.length > 0 && !loaders.some((loader) => accepted.has(loader));
    const versionMismatch =
      context.gameVersion !== null &&
      mod.gameVersions.length > 0 &&
      !mod.gameVersions.includes(context.gameVersion);

    if (!loaderMismatch && !versionMismatch) continue;
    problems.push(
      problem(
        'incompatible_installed',
        'warning',
        mod.title,
        loaderMismatch
          ? `${mod.title} is already installed but targets ${loaders.join(', ')}, which this server does not load.`
          : `${mod.title} is already installed but targets Minecraft ${mod.gameVersions.join(', ')}, not ${context.gameVersion ?? 'this version'}.`,
        mod.source,
        mod.projectId,
      ),
    );
  }

  const install: PlannedInstall[] = [];
  const satisfied: PlannedInstall[] = [];
  for (const entry of planned.values()) {
    const installed = installedByKey.get(modKey(entry.source, entry.projectId));
    if (installed && installed.versionId === entry.version.versionId) satisfied.push(entry);
    else install.push(entry);
  }

  // An empty plan is not an error, but it is not installable either, and "blocked with no
  // reason given" is the worst possible thing to show a reviewer.
  if (install.length === 0 && satisfied.length > 0) {
    problems.push(
      problem(
        'already_installed',
        'warning',
        root.detail.title,
        `${root.detail.title} and everything it needs are already installed at these versions.`,
        root.detail.source,
        root.detail.projectId,
      ),
    );
  }

  return {
    install,
    satisfied,
    problems,
    installable: install.length > 0 && !problems.some((entry) => entry.severity === 'error'),
  };
}

/**
 * Refuses a server that cannot load third-party code at all, with a message that says what to
 * change. Called before any provider request, so browsing mods on a vanilla server costs
 * nothing upstream.
 */
export function assertServerAcceptsMods(serverType: string): void {
  const info = minecraftServerType(serverType);
  if (!info) {
    throw new PlatterError(
      'invalid_state',
      `Platter does not recognise the server type "${serverType}".`,
    );
  }
  if (info.modTarget === null) {
    throw new PlatterError(
      'invalid_state',
      `${info.label} loads neither mods nor plugins. Change the server type to one that does (${INSTALLABLE_TYPE_LABELS}) and reinstall first.`,
    );
  }
}
