import {
  LOADER_ACCEPTS,
  LOADER_FAMILY,
  LOADER_LABELS,
  type LoaderFamily,
  type MinecraftLoader,
  type ModProvider,
  type VersionIndex,
  compareVersionsFallback,
} from '@platter/shared';
import {
  type DependencyRef,
  type ModProject,
  type ModVersion,
  normaliseLoaderName,
  qualifiedId,
  serverSideOf,
} from './types';

/**
 * The compatibility engine.
 *
 * Pure and synchronous by design. Everything it needs is passed in — the candidate version, its
 * project, the target server, what is already installed, and the version index. No network, no
 * clock, no database. That is not tidiness for its own sake: this function decides whether we
 * are about to hand somebody a jar that will crash their server, and a decision procedure you
 * cannot exhaustively test is a decision procedure you cannot trust.
 *
 * The governing principle is **never guess a blocker**. A false "incompatible" hides a working
 * mod and the user has no way to argue with it; a false "compatible" produces a crash log they
 * can read. So declared metadata produces blockers, inference produces warnings, and absent
 * metadata produces `unknown` rather than either. The one place we infer at all — CurseForge
 * has no client/server field, so a shader pack looks exactly like a server mod — is marked
 * `heuristic: true` on the finding and can only ever be a warning.
 */

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

export interface TargetServer {
  loader: MinecraftLoader;
  /** Exact Minecraft version, e.g. `1.20.1`, `1.21.11`, `26.2`. Never a range. */
  gameVersion: string;
  /** Derived from `loader` when omitted. Present so callers can override for hybrid loaders. */
  loaderFamily?: LoaderFamily;
}

/**
 * A mod already on the server.
 *
 * `dependencies` is the *installed* version's dependency list, and carrying it is what makes
 * conflict detection symmetric. Embeddium declares `incompatible` against Sodium; Sodium
 * declares nothing. Checking only the candidate's edges misses every conflict where the
 * already-installed mod is the one with an opinion — which, in the real graph, is most of them.
 */
export interface InstalledMod {
  provider: ModProvider;
  projectId: string;
  slug?: string | null;
  title?: string | null;
  versionId?: string | null;
  dependencies?: readonly DependencyRef[];
}

export interface CompatInput {
  server: TargetServer;
  project: ModProject;
  version: ModVersion;
  installed?: readonly InstalledMod[];
  /**
   * Built from `/v2/tag/game_version`. Optional so the engine still works before the tag cache
   * is warm, but the fallback comparator is explicitly best-effort — see `compareGameVersions`.
   */
  versionIndex?: VersionIndex;
}

/* -------------------------------------------------------------------------- */
/* Outputs                                                                     */
/* -------------------------------------------------------------------------- */

export type Verdict = 'compatible' | 'compatible_with_warnings' | 'incompatible' | 'unknown';

export interface Finding {
  /**
   * Stable across releases. The UI maps it to help text, the MCP server hands it to a model,
   * and `mod_installs.compat_snapshot` stores it — so renaming one is a breaking change.
   */
  code: string;
  title: string;
  detail: string;
  /** The raw values the rule fired on, so a surprising verdict can be argued with. */
  evidence?: Record<string, unknown>;
  /** What the user (or an agent) can do about it. Absent when there is nothing to do. */
  fix?: string;
  /** True when the finding came from a name/category guess rather than declared metadata. */
  heuristic?: boolean;
}

export interface ConflictRef {
  reason:
    | 'declared_incompatible'
    | 'already_installed'
    | 'duplicate_cross_provider'
    | 'singleton_role';
  provider: ModProvider;
  projectId: string;
  title: string | null;
  /** Set for `singleton_role`: the role both mods claim. */
  role?: string;
}

export interface CompatReport {
  verdict: Verdict;
  /** 0–100. A *ranking* aid for picking between candidates. The verdict is the decision. */
  score: number;
  blockers: Finding[];
  warnings: Finding[];
  notes: Finding[];
  /** Resolvable refs the caller can feed straight into `resolveDependencyGraph`. */
  missingDependencies: DependencyRef[];
  conflicts: ConflictRef[];
}

type Severity = 'blocker' | 'warning' | 'note' | 'unknown';
interface Graded extends Finding {
  severity: Severity;
}

/**
 * Penalties are deliberately coarse. The score exists so a UI can rank ten candidate versions;
 * it is not a probability and pretending otherwise by tuning the weights would be false
 * precision. `unknown` costs more than a warning because "we could not tell" should lose to
 * "we checked and it is imperfect".
 */
const PENALTY: Readonly<Record<Severity, number>> = {
  blocker: 50,
  unknown: 20,
  warning: 12,
  note: 2,
};

/* -------------------------------------------------------------------------- */
/* Loader knowledge                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The exact version where NeoForge and Forge stop being interchangeable.
 *
 * NeoForge forked from Forge during 1.20.1 and, for that version only, kept the
 * `net.minecraftforge` package namespace and ABI — so a Forge 1.20.1 jar loads on NeoForge
 * 1.20.1 unchanged, and launchers have relied on that since the fork. From 1.20.2 NeoForge
 * repackaged everything to `net.neoforged` and rewrote large parts of the API; a mod built for
 * one loader fails on the other with `NoClassDefFoundError` at load time.
 *
 * This is a hard boundary at a single version, not a range, which is why it is a string equality
 * check and not a comparison. `1.20.1` is the only Minecraft version where the bridge exists.
 */
export const NEOFORGE_FORGE_BRIDGE_VERSION = '1.20.1';

/**
 * What *kind* of thing a loader tag names. Used to explain a mismatch, not to decide one —
 * the decision is `LOADER_ACCEPTS`, which lives in `@platter/shared` next to the loader enum.
 *
 * The proxy entries matter: a Velocity plugin is not a Paper plugin, and the two are close
 * enough in the user's mind that "wrong loader" is an unsatisfying error message.
 */
const LOADER_KIND: Readonly<Record<string, 'mod' | 'plugin' | 'proxy' | 'client' | 'universal'>> = {
  fabric: 'mod',
  quilt: 'mod',
  forge: 'mod',
  neoforge: 'mod',
  liteloader: 'mod',
  rift: 'mod',
  modloader: 'mod',
  babric: 'mod',
  'bta-babric': 'mod',
  'legacy-fabric': 'mod',
  ornithe: 'mod',
  nilloader: 'mod',
  'java-agent': 'mod',
  bukkit: 'plugin',
  spigot: 'plugin',
  paper: 'plugin',
  purpur: 'plugin',
  folia: 'plugin',
  sponge: 'plugin',
  bungeecord: 'proxy',
  velocity: 'proxy',
  waterfall: 'proxy',
  geyser: 'proxy',
  iris: 'client',
  optifine: 'client',
  canvas: 'client',
  datapack: 'universal',
  minecraft: 'universal',
  vanilla: 'universal',
};

const KIND_LABEL: Readonly<Record<string, string>> = {
  mod: 'a mod loader',
  plugin: 'a plugin platform',
  proxy: 'a proxy',
  client: 'a client-side loader',
  universal: 'loader-agnostic content',
};

/**
 * Roles where two mods doing the same job is a problem rather than a bonus.
 *
 * Kept short on purpose. Every entry is a claim about the real world that can go stale, and a
 * warning on a pairing that actually works is a warning users learn to ignore. These two are the
 * ones that reliably break: two mods cannot both replace the chunk renderer, and two shader
 * loaders cannot both own the render pipeline.
 *
 * Matched on slug and title tokens because neither provider exposes anything like a "provides"
 * capability — this is the least-bad available signal, and the findings say so.
 */
export const SINGLETON_ROLES: readonly {
  id: string;
  label: string;
  detail: string;
  members: readonly string[];
}[] = [
  {
    id: 'renderer',
    label: 'rendering engine replacement',
    detail:
      'Both mods replace the chunk renderer. Running two is not additive — they patch the same rendering code and the second one to load usually crashes or renders nothing.',
    members: ['sodium', 'embeddium', 'rubidium', 'canvas', 'vulkanmod', 'optifine', 'optifabric'],
  },
  {
    id: 'shader-loader',
    label: 'shader loader',
    detail:
      'Both mods load shader packs and take ownership of the render pipeline. Only one can win.',
    members: ['iris', 'oculus', 'optifine'],
  },
];

/**
 * Names that suggest client-only content, used **only** when the provider gave us no side
 * metadata at all — in practice, only for CurseForge, which has no client/server field.
 *
 * Every finding produced here is `heuristic: true` and can only be a warning. A minimap mod that
 * happens to have a server component is a real thing; blocking it on the strength of its name
 * would be exactly the false negative this engine is built to avoid.
 */
const CLIENT_ONLY_HINTS: readonly { label: string; pattern: RegExp }[] = [
  { label: 'shaders', pattern: /\bshaders?\b|\bshaderpack/i },
  { label: 'minimap', pattern: /\bmini-?map\b|\bworld ?map\b/i },
  { label: 'HUD/overlay', pattern: /\bhud\b|\boverlay\b|\bcrosshair\b|\bhotbar\b/i },
  { label: 'resource pack', pattern: /\bresource ?pack\b|\btexture ?pack\b/i },
  // `\bzoom` rather than `\bzoom\b` — Zoomify is the canonical client-side zoom mod and a
  // trailing word boundary misses it.
  { label: 'camera/zoom', pattern: /\bzoom|\bfreecam\b|\bfirst-?person\b/i },
  { label: 'explicitly client-side', pattern: /\bclient[- ]?side\b|\bclient only\b/i },
];

/* -------------------------------------------------------------------------- */
/* Version comparison                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Compare two Minecraft versions. Ascending, `Array#sort` semantics.
 *
 * Uses the index when it knows *both* versions and the string parser otherwise. That blend is
 * the point: `VersionIndex.compare` deliberately sorts unknown versions oldest so a stale index
 * degrades into a stable order, which is right for sorting a list but wrong for answering "is
 * the mod's newest supported version above or below the server's". A version the index has
 * never heard of is usually a *brand new* one, so treating it as ancient would produce
 * confidently backwards advice.
 */
export function compareGameVersions(a: string, b: string, index?: VersionIndex): number {
  if (index?.has(a) && index.has(b)) {
    return index.compare(a, b);
  }
  return compareVersionsFallback(a, b);
}

/* -------------------------------------------------------------------------- */
/* The engine                                                                  */
/* -------------------------------------------------------------------------- */

export function checkCompatibility(input: CompatInput): CompatReport {
  const installed = input.installed ?? [];
  const findings: Graded[] = [];
  const missingDependencies: DependencyRef[] = [];
  const conflicts: ConflictRef[] = [];

  checkContentKind(input, findings);
  checkLoader(input, findings);
  checkGameVersion(input, findings);
  checkServerSide(input, findings);
  checkDependencies(input, installed, findings, missingDependencies, conflicts);
  checkInstalledSet(input, installed, findings, conflicts);
  checkAvailability(input, findings);

  const blockers = findings.filter((f) => f.severity === 'blocker');
  const warnings = findings.filter((f) => f.severity === 'warning');
  const unknowns = findings.filter((f) => f.severity === 'unknown');
  const notes = findings.filter((f) => f.severity === 'note');

  const penalty = findings.reduce((total, finding) => total + PENALTY[finding.severity], 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));

  let verdict: Verdict;
  if (blockers.length > 0) {
    verdict = 'incompatible';
  } else if (unknowns.length > 0) {
    // Not "probably fine". Something load-bearing was undeclared and we refuse to pretend.
    verdict = 'unknown';
  } else if (warnings.length > 0) {
    verdict = 'compatible_with_warnings';
  } else {
    verdict = 'compatible';
  }

  return {
    verdict,
    score,
    blockers: blockers.map(strip),
    warnings: warnings.map(strip),
    // `unknown` findings live in `notes` so nothing is lost, while the verdict carries the
    // distinction. Splitting them into a fourth array would make every consumer handle it.
    notes: [...unknowns, ...notes].map(strip),
    missingDependencies,
    conflicts,
  };
}

const strip = ({ severity, ...finding }: Graded): Finding => finding;

/* -------------------------------------------------------------------------- */
/* Rule: content kind                                                          */
/* -------------------------------------------------------------------------- */

function checkContentKind({ project, server }: CompatInput, findings: Graded[]): void {
  if (project.kind === 'modpack') {
    findings.push({
      severity: 'blocker',
      code: 'modpack_not_installable',
      title: 'This is a modpack, not a mod',
      detail:
        'A modpack defines an entire server — its loader, its Minecraft version and its whole mod list. It cannot be added to a server that already exists.',
      fix: 'Create a new server from this modpack instead of installing it into this one.',
      evidence: { kind: project.kind },
    });
    return;
  }

  if (project.kind === 'resourcepack' || project.kind === 'shader') {
    findings.push({
      severity: 'blocker',
      code: 'client_side_content',
      title: `${project.kind === 'shader' ? 'Shader packs' : 'Resource packs'} run on the client`,
      detail:
        'This is loaded by the Minecraft client, not the server. Dropping it into the server has no effect at all.',
      fix:
        project.kind === 'resourcepack'
          ? 'Set it as the server resource pack (the `resource-pack` server property) so clients download it on join, or install it in your own client.'
          : 'Install it in your Minecraft client alongside a shader loader such as Iris.',
      evidence: { kind: project.kind },
    });
    return;
  }

  if (project.kind === 'datapack') {
    findings.push({
      severity: 'note',
      code: 'datapack_content',
      title: 'Data pack',
      detail:
        'Data packs are loader-agnostic: they load on any server, including vanilla, and go into the world folder rather than mods/ or plugins/.',
      evidence: { loader: server.loader },
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Rule: loader                                                                */
/* -------------------------------------------------------------------------- */

function checkLoader(input: CompatInput, findings: Graded[]): void {
  const { server, project, version } = input;

  // Data packs bypass the loader question entirely — that is what makes them data packs.
  if (project.kind === 'datapack') {
    return;
  }

  const declared = version.loaders.map(normaliseLoaderName);
  if (declared.length === 0) {
    findings.push({
      severity: 'unknown',
      code: 'loader_undeclared',
      title: 'This file does not say which loader it is for',
      detail:
        'No loader is declared on this file. CurseForge omits the tag on loader-agnostic jars and on a lot of older uploads, so this may be fine — but we cannot confirm it.',
      fix: `Check the file's page before installing, or pick a version that explicitly lists ${LOADER_LABELS[server.loader]}.`,
      evidence: { serverLoader: server.loader },
    });
    return;
  }

  const accepted = new Set(LOADER_ACCEPTS[server.loader]);
  if (declared.some((loader) => accepted.has(loader))) {
    // Worth saying out loud when it worked through inheritance rather than an exact match:
    // "I installed a Fabric mod on Quilt and it worked" should not look like luck.
    const exact = declared.includes(server.loader);
    if (!exact) {
      const via = declared.find((loader) => accepted.has(loader));
      findings.push({
        severity: 'note',
        code: 'loader_accepted_by_inheritance',
        title: `${LOADER_LABELS[server.loader]} runs ${via} content`,
        detail: `This file targets ${via}. ${LOADER_LABELS[server.loader]} loads ${via} content unchanged, so no ${LOADER_LABELS[server.loader]}-specific build is needed.`,
        evidence: { declared, accepted: [...accepted] },
      });
    }
    return;
  }

  const bridge = neoForgeBridge(server, declared);
  if (bridge) {
    findings.push(bridge);
    return;
  }

  findings.push(loaderMismatch(server, declared, project));
}

/**
 * The 1.20.1 NeoForge/Forge special case, both directions.
 *
 * Forward (Forge mod on a NeoForge 1.20.1 server) is safe and is a note: NeoForge 1.20.1 is a
 * fork of Forge 1.20.1 that kept the package namespace, and this is the documented reason mod
 * authors did not need to republish.
 *
 * Reverse (NeoForge mod on a Forge 1.20.1 server) is a *warning*, not a note. NeoForge added
 * APIs during 1.20.1 that Forge never had, so a mod compiled against them fails at class load.
 * Most 1.20.1 NeoForge mods do run on Forge; "most" is not something to assert silently.
 */
function neoForgeBridge(server: TargetServer, declared: readonly string[]): Graded | undefined {
  if (server.gameVersion !== NEOFORGE_FORGE_BRIDGE_VERSION) {
    return undefined;
  }

  if (server.loader === 'neoforge' && declared.includes('forge')) {
    return {
      severity: 'note',
      code: 'loader_neoforge_accepts_forge_1_20_1',
      title: 'Forge 1.20.1 mods run on NeoForge 1.20.1',
      detail:
        'NeoForge forked from Forge during 1.20.1 and kept the net.minecraftforge package namespace for that version, so Forge 1.20.1 files load unchanged. This stops at 1.20.2, where NeoForge repackaged to net.neoforged and the two became incompatible.',
      evidence: { declared, gameVersion: server.gameVersion },
    };
  }

  if (server.loader === 'forge' && declared.includes('neoforge')) {
    return {
      severity: 'warning',
      code: 'loader_forge_accepts_neoforge_1_20_1',
      title: 'NeoForge 1.20.1 file on a Forge 1.20.1 server',
      detail:
        'At 1.20.1 the two loaders share an ABI, so this will usually work. It is not guaranteed: NeoForge added APIs during 1.20.1 that Forge does not have, and a mod that uses one fails at class load with NoClassDefFoundError.',
      fix: 'Prefer a file that lists Forge explicitly if the project publishes one.',
      evidence: { declared, gameVersion: server.gameVersion },
    };
  }

  return undefined;
}

function loaderMismatch(
  server: TargetServer,
  declared: readonly string[],
  project: ModProject
): Graded {
  const serverFamily = server.loaderFamily ?? LOADER_FAMILY[server.loader];
  const declaredKinds = [...new Set(declared.map((loader) => LOADER_KIND[loader] ?? 'unknown'))];
  const primary = declaredKinds[0] ?? 'unknown';

  if (serverFamily === 'vanilla') {
    return {
      severity: 'blocker',
      code: 'vanilla_server_cannot_load_content',
      title: 'A vanilla server cannot load mods or plugins',
      detail:
        'This server runs the unmodified Minecraft server jar. It has no mod loader and no plugin API, so nothing in mods/ or plugins/ is ever read.',
      fix: `Recreate the server on ${primary === 'plugin' ? 'Paper' : 'Fabric or NeoForge'}, or use a data pack instead.`,
      evidence: { declared, serverLoader: server.loader },
    };
  }

  // A mod on a plugin platform, or a plugin on a mod loader. Different runtime, different API,
  // no bridge — this is the mismatch worth explaining properly, because it is the one people
  // hit constantly ("why won't EssentialsX work on my Fabric server?").
  const declaredFamilies = declared.map((loader) => LOADER_KIND[loader]);
  const familyMatches = declaredFamilies.some(
    (kind) => (kind === 'mod' && serverFamily === 'mod') || (kind === 'plugin' && serverFamily === 'plugin')
  );

  if (!familyMatches) {
    return {
      severity: 'blocker',
      code: 'loader_family_mismatch',
      title: `${project.title} is not built for ${LOADER_LABELS[server.loader]}`,
      detail: `This file targets ${listOf(declared)} — ${KIND_LABEL[primary] ?? 'a different platform'} — while your server runs ${LOADER_LABELS[server.loader]}, ${serverFamily === 'plugin' ? 'a plugin platform' : 'a mod loader'}. These are different runtimes with different APIs; there is no shim that makes one load the other.`,
      fix:
        serverFamily === 'plugin'
          ? 'Look for a Bukkit/Spigot/Paper plugin that does the same job.'
          : 'Look for a Fabric/NeoForge mod that does the same job.',
      evidence: { declared, serverLoader: server.loader, serverFamily },
    };
  }

  // Same family, wrong member: a Fabric mod on NeoForge, a Sponge plugin on Paper.
  return {
    severity: 'blocker',
    code: 'loader_not_accepted',
    title: `No ${LOADER_LABELS[server.loader]} build`,
    detail: `This file is published for ${listOf(declared)}. ${LOADER_LABELS[server.loader]} does not load ${listOf(declared)} content${server.loader === 'forge' || server.loader === 'neoforge' ? ' — Forge and NeoForge diverged after 1.20.1 and are not interchangeable' : ''}.`,
    fix: `Check whether the project publishes a ${LOADER_LABELS[server.loader]} build of this version.`,
    evidence: { declared, accepted: LOADER_ACCEPTS[server.loader], serverLoader: server.loader },
  };
}

/* -------------------------------------------------------------------------- */
/* Rule: game version                                                          */
/* -------------------------------------------------------------------------- */

function checkGameVersion(input: CompatInput, findings: Graded[]): void {
  const { server, version, versionIndex } = input;
  const supported = version.gameVersions;

  if (supported.length === 0) {
    findings.push({
      severity: 'unknown',
      code: 'game_version_undeclared',
      title: 'This file does not say which Minecraft versions it supports',
      detail:
        'No Minecraft version is declared on this file, so we cannot tell whether it matches your server.',
      fix: `Check the file's page before installing.`,
      evidence: { serverGameVersion: server.gameVersion },
    });
    return;
  }

  if (supported.includes(server.gameVersion)) {
    return;
  }

  // Everything below is only about *explaining* the mismatch well. The mismatch itself was
  // decided by exact membership, never by parsing or comparing version strings.
  const sorted = [...supported].sort((a, b) => compareGameVersions(a, b, versionIndex));
  const newest = sorted.at(-1);
  const oldest = sorted[0];
  const anyNewer = sorted.some((v) => compareGameVersions(v, server.gameVersion, versionIndex) > 0);
  const anyOlder = sorted.some((v) => compareGameVersions(v, server.gameVersion, versionIndex) < 0);

  let detail: string;
  let fix: string;
  if (!anyNewer && newest) {
    detail = `This file supports up to Minecraft ${newest}. Your server runs ${server.gameVersion}, which is newer.`;
    fix = 'Wait for the project to update, or pick a build for your version if one exists.';
  } else if (!anyOlder && oldest) {
    detail = `This file needs Minecraft ${oldest} or later. Your server runs ${server.gameVersion}.`;
    fix = `Install an older build of this project that supports ${server.gameVersion}.`;
  } else {
    detail = `This file supports ${listOf(sorted)} but not ${server.gameVersion}.`;
    fix = `Pick a build that lists ${server.gameVersion}.`;
  }

  findings.push({
    severity: 'blocker',
    code: 'game_version_mismatch',
    title: `Not built for Minecraft ${server.gameVersion}`,
    detail,
    fix,
    evidence: { supported: sorted, serverGameVersion: server.gameVersion },
  });

  // A version the index has never heard of is almost always one released since the tag cache
  // was last refreshed. Say so, because it changes how much the ordering above is worth.
  if (versionIndex && !versionIndex.has(server.gameVersion)) {
    findings.push({
      severity: 'note',
      code: 'game_version_unknown_to_index',
      title: `Minecraft ${server.gameVersion} is not in our version list`,
      detail:
        'Our Minecraft version list does not contain your server version, so version ordering above is a best guess. Refreshing the mod catalogue will fix it.',
      evidence: { serverGameVersion: server.gameVersion, indexSize: versionIndex.size },
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Rule: which side it runs on                                                 */
/* -------------------------------------------------------------------------- */

function checkServerSide(input: CompatInput, findings: Graded[]): void {
  const { project, version } = input;
  const side = serverSideOf(project.environment);

  if (side === 'unsupported') {
    findings.push({
      severity: 'blocker',
      code: 'client_only_mod',
      title: `${project.title} is a client-side mod`,
      detail:
        'The author marked this as unsupported on the server. It hooks into rendering, input or the client UI — none of which exist in a server process. Installing it either does nothing or crashes the server at startup.',
      fix: 'Install it in your Minecraft client instead. Nothing needs to change on the server.',
      evidence: { environment: project.environment, serverSide: project.serverSide },
    });
    return;
  }

  if (side !== 'unknown') {
    return;
  }

  // No declared side. CurseForge never has one, so this is where most of its projects land.
  // A `Server` tag on the file itself is real evidence and settles it.
  if (version.environmentTags.includes('server')) {
    findings.push({
      severity: 'note',
      code: 'server_side_from_file_tags',
      title: 'Server support inferred from the file tags',
      detail:
        'This provider publishes no client/server field, but the file is tagged for the server environment.',
      evidence: { environmentTags: version.environmentTags },
    });
    return;
  }

  const hint = clientOnlyHint(project);
  if (hint) {
    findings.push({
      severity: 'warning',
      heuristic: true,
      code: 'client_only_suspected',
      title: 'This looks like a client-side mod',
      detail: `${project.title} matches a ${hint} pattern, and this provider publishes no client/server metadata for us to check against. Client-side mods do nothing on a server and some crash it at startup. This is a guess from the name and categories, not a declaration by the author.`,
      fix: `Confirm on the project page that it supports servers before installing.`,
      evidence: {
        hint,
        title: project.title,
        categories: project.categories,
        environmentTags: version.environmentTags,
      },
    });
    return;
  }

  findings.push({
    severity: 'note',
    code: 'server_side_unknown',
    title: 'No client/server metadata',
    detail:
      'This provider does not publish whether the mod runs on the server. Nothing suggests it is client-only, but we could not verify it either.',
    evidence: { environment: project.environment },
  });
}

/** The first matching hint label, or `undefined`. Title, summary and categories are all read. */
function clientOnlyHint(project: ModProject): string | undefined {
  const haystack = [project.title, project.summary ?? '', ...project.categories].join(' ');
  return CLIENT_ONLY_HINTS.find((hint) => hint.pattern.test(haystack))?.label;
}

/* -------------------------------------------------------------------------- */
/* Rule: declared dependency edges                                             */
/* -------------------------------------------------------------------------- */

/** Key an installed mod or a dependency ref by provider + upstream id. */
export const dependencyKey = (provider: ModProvider, projectId: string): string =>
  qualifiedId(provider, projectId);

function checkDependencies(
  input: CompatInput,
  installed: readonly InstalledMod[],
  findings: Graded[],
  missingDependencies: DependencyRef[],
  conflicts: ConflictRef[]
): void {
  const { version } = input;
  const byKey = new Map(installed.map((mod) => [dependencyKey(mod.provider, mod.projectId), mod]));
  let optionalCount = 0;

  for (const dep of version.dependencies) {
    if (dep.kind === 'tool') {
      // A build tool, not a runtime requirement. Nothing to install.
      continue;
    }

    if (dep.kind === 'optional') {
      optionalCount += 1;
      continue;
    }

    if (dep.kind === 'embedded') {
      findings.push({
        severity: 'note',
        code: 'dependency_embedded',
        title: 'Bundled dependency',
        detail:
          'This file already contains the dependency. Installing it separately usually causes a duplicate-mod error, so we will not add it.',
        evidence: { dependency: dep },
      });
      continue;
    }

    // A ref with only a filename points at something outside the provider — a bundled jar or
    // an external download. There is no id to resolve, so it can never be automated.
    if (!dep.projectId && !dep.versionId) {
      const label = dep.fileName ?? 'an unnamed file';
      if (dep.kind === 'required') {
        findings.push({
          severity: 'blocker',
          code: 'dependency_unresolvable',
          title: `Requires ${label}, which we cannot fetch`,
          detail: `This file requires ${label}, which is not hosted on the provider and has no id we can look up.`,
          fix: `Download ${label} yourself and place it alongside this mod.`,
          evidence: { dependency: dep },
        });
      }
      continue;
    }

    const key = dependencyKey(dep.provider, dep.projectId ?? '');
    const present = dep.projectId ? byKey.get(key) : undefined;

    if (dep.kind === 'incompatible') {
      if (present) {
        findings.push({
          severity: 'blocker',
          code: 'dependency_incompatible',
          title: `Conflicts with ${present.title ?? present.slug ?? key}`,
          detail: `${input.project.title} declares ${present.title ?? key} as incompatible. Running both is not a degraded experience, it is a crash or silent corruption — the author flagged it deliberately.`,
          fix: `Remove ${present.title ?? present.slug ?? key} first, or install neither.`,
          evidence: { dependency: dep, installed: key },
        });
        conflicts.push({
          reason: 'declared_incompatible',
          provider: present.provider,
          projectId: present.projectId,
          title: present.title ?? null,
        });
      } else {
        findings.push({
          severity: 'note',
          code: 'dependency_incompatible_absent',
          title: 'Declares an incompatibility you are not affected by',
          detail:
            'This file is incompatible with another project that is not installed here. Worth knowing before you add that one later.',
          evidence: { dependency: dep },
        });
      }
      continue;
    }

    // kind === 'required'
    if (!present) {
      findings.push({
        severity: 'blocker',
        code: 'dependency_missing',
        title: 'A required dependency is missing',
        detail: `This file requires ${dep.projectId ?? dep.versionId} and it is not installed. Without it the server fails at startup with a missing-dependency error rather than starting without the feature.`,
        fix: 'Platter can add it automatically along with this mod.',
        evidence: { dependency: dep },
      });
      missingDependencies.push(dep);
    }
  }

  if (optionalCount > 0) {
    findings.push({
      severity: 'note',
      code: 'dependency_optional_available',
      title: `${optionalCount} optional ${optionalCount === 1 ? 'dependency' : 'dependencies'}`,
      detail:
        'This file works without them, but they unlock extra features. They are not installed automatically.',
      evidence: { optionalCount },
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Rule: what is already installed                                             */
/* -------------------------------------------------------------------------- */

function checkInstalledSet(
  input: CompatInput,
  installed: readonly InstalledMod[],
  findings: Graded[],
  conflicts: ConflictRef[]
): void {
  const { project, version } = input;

  for (const mod of installed) {
    /* Exact duplicate ------------------------------------------------------ */
    if (mod.provider === project.provider && mod.projectId === project.projectId) {
      findings.push({
        severity: 'blocker',
        code: 'already_installed',
        title: `${project.title} is already installed`,
        detail:
          mod.versionId && mod.versionId !== version.versionId
            ? 'A different version of this project is already on the server. Two copies of the same mod in mods/ is a startup crash, not an upgrade.'
            : 'This exact version is already installed.',
        fix: 'Update the existing install instead of adding a second copy.',
        evidence: { installedVersionId: mod.versionId ?? null, candidateVersionId: version.versionId },
      });
      conflicts.push({
        reason: 'already_installed',
        provider: mod.provider,
        projectId: mod.projectId,
        title: mod.title ?? null,
      });
      continue;
    }

    /* Same project from the other provider --------------------------------- */
    // Warning rather than a blocker: slug and title collisions across providers are real but
    // not certain, and two genuinely different mods occasionally share a name.
    if (isProbablySameProject(project, mod)) {
      findings.push({
        severity: 'warning',
        code: 'duplicate_cross_provider',
        title: `${project.title} may already be installed from ${mod.provider}`,
        detail:
          'A mod with the same name is installed from the other provider. Cross-posted projects are the same jar under two ids, and installing both puts two copies in mods/.',
        fix: 'Check the installed mod before adding this one.',
        evidence: { installed: dependencyKey(mod.provider, mod.projectId), slug: mod.slug ?? null },
      });
      conflicts.push({
        reason: 'duplicate_cross_provider',
        provider: mod.provider,
        projectId: mod.projectId,
        title: mod.title ?? null,
      });
      continue;
    }

    /* Reverse incompatibility --------------------------------------------- */
    // The installed mod is the one with the opinion. Embeddium declares `incompatible` against
    // Sodium forks; Sodium declares nothing. Only checking the candidate's edges misses this.
    for (const dep of mod.dependencies ?? []) {
      if (dep.kind !== 'incompatible') {
        continue;
      }
      const matchesProject = dep.provider === project.provider && dep.projectId === project.projectId;
      const matchesVersion = dep.provider === project.provider && dep.versionId === version.versionId;
      if (!matchesProject && !matchesVersion) {
        continue;
      }
      findings.push({
        severity: 'blocker',
        code: 'installed_declares_incompatible',
        title: `${mod.title ?? mod.slug ?? mod.projectId} is incompatible with this`,
        detail: `An already-installed mod declares ${project.title} as incompatible. The conflict is recorded on the installed side, which is why it is not visible on this project's page.`,
        fix: `Remove ${mod.title ?? mod.slug ?? mod.projectId} first, or pick a different mod.`,
        evidence: { installed: dependencyKey(mod.provider, mod.projectId), dependency: dep },
      });
      conflicts.push({
        reason: 'declared_incompatible',
        provider: mod.provider,
        projectId: mod.projectId,
        title: mod.title ?? null,
      });
    }
  }

  checkSingletonRoles(project, installed, findings, conflicts);
}

/** Slug match, or an exact case-insensitive title match. Both are strong but not conclusive. */
function isProbablySameProject(project: ModProject, mod: InstalledMod): boolean {
  if (mod.provider === project.provider) {
    return false;
  }
  if (project.slug && mod.slug && project.slug.toLowerCase() === mod.slug.toLowerCase()) {
    return true;
  }
  return Boolean(mod.title && mod.title.trim().toLowerCase() === project.title.trim().toLowerCase());
}

function checkSingletonRoles(
  project: ModProject,
  installed: readonly InstalledMod[],
  findings: Graded[],
  conflicts: ConflictRef[]
): void {
  const role = roleOf(project.slug, project.title);
  if (!role) {
    return;
  }
  for (const mod of installed) {
    if (mod.provider === project.provider && mod.projectId === project.projectId) {
      continue;
    }
    if (roleOf(mod.slug, mod.title)?.id !== role.id) {
      continue;
    }
    findings.push({
      severity: 'warning',
      heuristic: true,
      code: 'singleton_role_conflict',
      title: `Two mods are acting as the ${role.label}`,
      detail: `${role.detail} ${mod.title ?? mod.slug ?? mod.projectId} is already installed. Identified by name, since neither provider publishes what a mod replaces.`,
      fix: `Keep one of ${project.title} or ${mod.title ?? mod.slug ?? mod.projectId}.`,
      evidence: { role: role.id, installed: dependencyKey(mod.provider, mod.projectId) },
    });
    conflicts.push({
      reason: 'singleton_role',
      provider: mod.provider,
      projectId: mod.projectId,
      title: mod.title ?? null,
      role: role.id,
    });
  }
}

function roleOf(
  slug: string | null | undefined,
  title: string | null | undefined
): (typeof SINGLETON_ROLES)[number] | undefined {
  const tokens = `${slug ?? ''} ${title ?? ''}`.toLowerCase();
  return SINGLETON_ROLES.find((role) =>
    role.members.some((member) => new RegExp(`\\b${member}\\b`).test(tokens))
  );
}

/* -------------------------------------------------------------------------- */
/* Rule: can we actually get the file                                          */
/* -------------------------------------------------------------------------- */

function checkAvailability({ project, version }: CompatInput, findings: Graded[]): void {
  if (!version.downloadable) {
    findings.push({
      severity: 'blocker',
      code: 'not_downloadable',
      title: 'This file cannot be downloaded automatically',
      detail:
        version.downloadBlockedReason ??
        'The provider did not give us a download URL for this file.',
      fix: project.projectUrl
        ? `Download it from ${project.projectUrl} and add it as a manual upload.`
        : 'Download it from the project page and add it as a manual upload.',
      evidence: { versionId: version.versionId, fileName: version.file.name },
    });
  }

  if (version.channel === 'alpha') {
    findings.push({
      severity: 'warning',
      code: 'prerelease_alpha',
      title: 'Alpha build',
      detail:
        'The author published this as an alpha. Alphas are expected to have bugs, and on a server that can mean world corruption rather than a crash you can restart out of.',
      fix: 'Back up the world first, or wait for a release build.',
      evidence: { channel: version.channel, versionNumber: version.versionNumber },
    });
  } else if (version.channel === 'beta') {
    findings.push({
      severity: 'warning',
      code: 'prerelease_beta',
      title: 'Beta build',
      detail:
        'The author published this as a beta. Note that many well-known projects ship beta as their normal channel, so this is not automatically a reason to avoid it.',
      evidence: { channel: version.channel, versionNumber: version.versionNumber },
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Dependency graph                                                            */
/* -------------------------------------------------------------------------- */

export interface DependencyResolution {
  project: ModProject;
  version: ModVersion;
}

/**
 * How the walker turns a dependency ref into something installable.
 *
 * An interface rather than a concrete client because the two providers resolve differently:
 * Modrinth refs may pin an exact version id, while CurseForge refs carry a bare mod id and *no*
 * version constraint at all, so picking a build is a search. `ModRegistry` implements this.
 */
export interface DependencyResolver {
  resolve(
    ref: DependencyRef,
    server: TargetServer
  ): Promise<import('@platter/shared').Result<DependencyResolution>>;
}

export interface DependencyPlanNode extends DependencyResolution {
  depth: number;
  /** Qualified id of the node that pulled this one in. `null` for the root. */
  requiredBy: string | null;
}

export interface UnresolvedDependency {
  ref: DependencyRef;
  /** Qualified id of the node that needed it. */
  requiredBy: string;
  reason: string;
}

export interface DependencyPlan {
  /** Breadth-first, root first. Installing in this order satisfies every edge as it goes. */
  nodes: DependencyPlanNode[];
  unresolved: UnresolvedDependency[];
  /** True when a cap stopped the walk before the graph was exhausted. */
  truncated: boolean;
}

export interface ResolveGraphInput {
  root: DependencyResolution;
  server: TargetServer;
  resolver: DependencyResolver;
  /** Already on the server. Their subtrees are assumed satisfied and are not walked. */
  installed?: readonly InstalledMod[];
  /** Edges from the root. 6 is far beyond any real mod graph. */
  maxDepth?: number;
  /** Total nodes including the root. A safety valve, not a tuning knob. */
  maxNodes?: number;
}

/**
 * Walk `required` dependencies breadth-first and flatten them into an install plan.
 *
 * Breadth-first rather than depth-first so the plan reads in the order a human would install
 * things: the mod they asked for, then its direct requirements, then theirs.
 *
 * Three properties this has to hold, all of which the real graph will test:
 *
 *   - **Cycle-safe.** A ⇒ B ⇒ A happens, usually through a library that depends on its own API
 *     shim. The visited set is keyed on `provider:projectId` and is populated *before* the
 *     resolve, so a cycle terminates and a failed resolve is not retried down every other path.
 *   - **Deduped.** Fabric API is required by nearly everything; a fifty-mod pack must not fetch
 *     it fifty times or list it fifty times in the plan.
 *   - **Bounded.** Depth and node caps, both reported through `truncated`. Silently returning a
 *     partial plan would produce an install that is missing dependencies with no indication why.
 *
 * Failures are collected, never thrown: one unreachable dependency should not discard the ten
 * that resolved. The caller decides whether an incomplete plan is worth applying.
 */
export async function resolveDependencyGraph(input: ResolveGraphInput): Promise<DependencyPlan> {
  const maxDepth = input.maxDepth ?? 6;
  const maxNodes = input.maxNodes ?? 100;

  const rootKey = dependencyKey(input.root.project.provider, input.root.project.projectId);
  const satisfied = new Set(
    (input.installed ?? []).map((mod) => dependencyKey(mod.provider, mod.projectId))
  );
  const visited = new Set<string>([rootKey]);

  const rootNode: DependencyPlanNode = { ...input.root, depth: 0, requiredBy: null };
  const nodes: DependencyPlanNode[] = [rootNode];
  const unresolved: UnresolvedDependency[] = [];
  let truncated = false;

  const queue: DependencyPlanNode[] = [rootNode];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    const currentKey = dependencyKey(current.project.provider, current.project.projectId);
    const required = current.version.dependencies.filter((dep) => dep.kind === 'required');
    if (required.length === 0) {
      continue;
    }

    if (current.depth >= maxDepth) {
      // Only truncated if there was actually something left to expand — a leaf at max depth is
      // a complete answer, not a curtailed one.
      const pending = required.filter(
        (dep) => dep.projectId && !visited.has(dependencyKey(dep.provider, dep.projectId))
      );
      if (pending.length > 0) {
        truncated = true;
      }
      continue;
    }

    for (const dep of required) {
      if (!dep.projectId && !dep.versionId) {
        // Filename-only: an external artefact with nothing to look up. Reported, not resolved.
        unresolved.push({
          ref: dep,
          requiredBy: currentKey,
          reason: `${dep.fileName ?? 'This dependency'} is not hosted on ${dep.provider} and cannot be fetched automatically`,
        });
        continue;
      }

      const key = dependencyKey(dep.provider, dep.projectId ?? dep.versionId ?? '');
      if (satisfied.has(key) || visited.has(key)) {
        continue;
      }
      visited.add(key);

      if (nodes.length >= maxNodes) {
        truncated = true;
        break;
      }

      const resolved = await input.resolver.resolve(dep, input.server);
      if (!resolved.ok) {
        unresolved.push({ ref: dep, requiredBy: currentKey, reason: resolved.error.message });
        continue;
      }

      const node: DependencyPlanNode = {
        ...resolved.value,
        depth: current.depth + 1,
        requiredBy: currentKey,
      };
      nodes.push(node);
      queue.push(node);
    }

    if (truncated && nodes.length >= maxNodes) {
      break;
    }
  }

  return { nodes, unresolved, truncated };
}

/* -------------------------------------------------------------------------- */
/* Formatting helpers                                                          */
/* -------------------------------------------------------------------------- */

/** `a`, `a and b`, `a, b and c`. Findings are read by humans; commas everywhere read badly. */
function listOf(values: readonly string[]): string {
  if (values.length === 0) {
    return 'nothing';
  }
  if (values.length === 1) {
    return values[0] ?? '';
  }
  return `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`;
}
