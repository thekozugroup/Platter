import type { BlueprintDefinition, EnvironmentHook } from './index.js';

/**
 * Minecraft: Java Edition, on `itzg/minecraft-server`.
 *
 * That image is the whole reason Platter does not ship a Minecraft installer: it already
 * resolves every server flavour, every mod loader and every modpack platform from a single
 * `TYPE` variable. Platter's job here is to turn that one free-text variable into a guided
 * choice, and to carry the companion variables each flavour actually reads.
 *
 * Everything below is administration — an operator could set the same environment on
 * `docker run` and get the same server. See docs/ARCHITECTURE.md §1.
 */

// ---------------------------------------------------------------------------
// Server types
// ---------------------------------------------------------------------------

/**
 * How a type takes third-party code.
 *
 * `mods` and `plugins` are different directories with different, incompatible artifacts, and
 * installing a Bukkit plugin into `mods/` produces a server that starts and silently ignores
 * it. The mod installer keys off `minecraftModTarget` rather than guessing from the version.
 */
export type MinecraftModTarget = 'mods' | 'plugins' | null;

export const MINECRAFT_TYPE_FAMILIES = [
  'vanilla',
  'plugins',
  'mods',
  'hybrid',
  'modpack',
  'utility',
  'custom',
] as const;
export type MinecraftTypeFamily = (typeof MINECRAFT_TYPE_FAMILIES)[number];

const FAMILY_LABELS: Record<MinecraftTypeFamily, string> = {
  vanilla: 'Vanilla',
  plugins: 'Plugins (Bukkit API)',
  mods: 'Mod loader',
  hybrid: 'Mods + plugins',
  modpack: 'Modpack platform',
  utility: 'Utility',
  custom: 'Custom',
};

export interface MinecraftServerTypeInfo {
  /** The literal value of the image's `TYPE` variable. */
  readonly type: string;
  readonly label: string;
  readonly family: MinecraftTypeFamily;
  /** Directory the mod installer should write into, or null when the type takes neither. */
  readonly modTarget: MinecraftModTarget;
  /** Some types accept both; `modTarget` names the primary, these two name what works. */
  readonly acceptsMods: boolean;
  readonly acceptsPlugins: boolean;
  /** Whether the flavour implements the vanilla RCON protocol. */
  readonly rcon: boolean;
  /** Whether it answers the GameSpy4 query protocol used for player counts. */
  readonly query: boolean;
  /** Variables that only mean something for this type, surfaced conditionally by the UI. */
  readonly variables: readonly string[];
  readonly note: string;
}

function entry(info: MinecraftServerTypeInfo): MinecraftServerTypeInfo {
  return info;
}

/**
 * Verified against the `TYPE` dispatch in the image's `scripts/start-configuration`, not
 * against the prose docs — the prose lags the script.
 *
 * Deliberately absent, and why:
 * - `GLOWSTONE` — the image no longer has a branch for it; the upstream project is dead.
 * - `SERVER` — never a `TYPE` value. An operator-supplied jar is `TYPE=CUSTOM` plus
 *   `CUSTOM_SERVER`, which is what the Custom entry below does.
 * - `CURSEFORGE` — the legacy path that needs a hand-downloaded server zip on the volume.
 *   `AUTO_CURSEFORGE` resolves the same packs from a slug, so exposing both would only offer
 *   operators a way to pick the broken one.
 */
export const MINECRAFT_SERVER_TYPES: readonly MinecraftServerTypeInfo[] = [
  entry({
    type: 'VANILLA',
    label: 'Vanilla',
    family: 'vanilla',
    modTarget: null,
    acceptsMods: false,
    acceptsPlugins: false,
    rcon: true,
    query: true,
    variables: [],
    note: "Mojang's own server jar. No mods, no plugins, exactly what the client ships against.",
  }),

  // --- Bukkit-API servers: plugins/, no mods ---
  entry({
    type: 'PAPER',
    label: 'Paper',
    family: 'plugins',
    modTarget: 'plugins',
    acceptsMods: false,
    acceptsPlugins: true,
    rcon: true,
    query: true,
    variables: ['PAPER_CHANNEL', 'PAPER_BUILD'],
    note: 'The usual choice: large performance gains over vanilla and the widest plugin support.',
  }),
  entry({
    type: 'PURPUR',
    label: 'Purpur',
    family: 'plugins',
    modTarget: 'plugins',
    acceptsMods: false,
    acceptsPlugins: true,
    rcon: true,
    query: true,
    variables: ['PURPUR_BUILD'],
    note: 'Paper plus several hundred extra gameplay toggles. Drop-in for Paper plugins.',
  }),
  entry({
    type: 'SPIGOT',
    label: 'Spigot',
    family: 'plugins',
    modTarget: 'plugins',
    acceptsMods: false,
    acceptsPlugins: true,
    rcon: true,
    query: true,
    variables: [],
    note: 'Built from source on first boot, so the first start is slow. Paper supersedes it.',
  }),
  entry({
    type: 'BUKKIT',
    label: 'CraftBukkit',
    family: 'plugins',
    modTarget: 'plugins',
    acceptsMods: false,
    acceptsPlugins: true,
    rcon: true,
    query: true,
    variables: [],
    note: 'The original plugin server. Kept for old plugins; slower than Paper in every way.',
  }),
  entry({
    type: 'FOLIA',
    label: 'Folia',
    family: 'plugins',
    modTarget: 'plugins',
    acceptsMods: false,
    acceptsPlugins: true,
    rcon: true,
    query: true,
    variables: [],
    note: 'Regionised multithreading for very large player counts. Most plugins need a Folia build.',
  }),
  entry({
    type: 'PUFFERFISH',
    label: 'Pufferfish',
    family: 'plugins',
    modTarget: 'plugins',
    acceptsMods: false,
    acceptsPlugins: true,
    rcon: true,
    query: true,
    variables: [],
    note: 'Paper fork tuned for large servers, with more aggressive entity and mob optimisations.',
  }),
  entry({
    type: 'LEAF',
    label: 'Leaf',
    family: 'plugins',
    modTarget: 'plugins',
    acceptsMods: false,
    acceptsPlugins: true,
    rcon: true,
    query: true,
    variables: [],
    note: 'Paper fork focused on throughput. Some optimisations change vanilla behaviour slightly.',
  }),

  // --- Mod loaders: mods/, no plugins ---
  entry({
    type: 'FABRIC',
    label: 'Fabric',
    family: 'mods',
    modTarget: 'mods',
    acceptsMods: true,
    acceptsPlugins: false,
    rcon: true,
    query: true,
    variables: ['FABRIC_LOADER_VERSION', 'FABRIC_LAUNCHER_VERSION'],
    note: 'Lightweight loader that updates to new Minecraft versions quickly.',
  }),
  entry({
    type: 'FORGE',
    label: 'Forge',
    family: 'mods',
    modTarget: 'mods',
    acceptsMods: true,
    acceptsPlugins: false,
    rcon: true,
    query: true,
    variables: ['FORGE_VERSION'],
    note: 'The oldest loader and the one most large modpacks target.',
  }),
  entry({
    type: 'NEOFORGE',
    label: 'NeoForge',
    family: 'mods',
    modTarget: 'mods',
    acceptsMods: true,
    acceptsPlugins: false,
    rcon: true,
    query: true,
    variables: ['NEOFORGE_VERSION'],
    note: 'The community fork of Forge; the default for Forge-style mods on 1.20.2 and later.',
  }),
  entry({
    type: 'QUILT',
    label: 'Quilt',
    family: 'mods',
    modTarget: 'mods',
    acceptsMods: true,
    acceptsPlugins: false,
    rcon: true,
    query: true,
    variables: ['QUILT_LOADER_VERSION', 'QUILT_INSTALLER_VERSION'],
    note: 'Fabric fork. Runs most Fabric mods, but a few refuse to load.',
  }),
  entry({
    type: 'SPONGEVANILLA',
    label: 'SpongeVanilla',
    family: 'mods',
    // Sponge API 8+ loads its plugins as mods, out of `mods/`. It is not a Bukkit server and
    // Bukkit jars in `plugins/` will not load.
    modTarget: 'mods',
    acceptsMods: true,
    acceptsPlugins: false,
    rcon: true,
    query: true,
    variables: ['SPONGEVERSION'],
    note: 'Sponge plugin platform on the vanilla server. Sponge plugins live in mods/.',
  }),

  // --- Hybrids: Forge/Fabric mods AND Bukkit plugins ---
  entry({
    type: 'MOHIST',
    label: 'Mohist',
    family: 'hybrid',
    modTarget: 'mods',
    acceptsMods: true,
    acceptsPlugins: true,
    rcon: true,
    query: true,
    variables: [],
    note: 'Forge mods plus Bukkit plugins. Hybrids trade stability for that; expect odd bugs.',
  }),
  entry({
    type: 'MAGMA_MAINTAINED',
    label: 'Magma Maintained',
    family: 'hybrid',
    modTarget: 'mods',
    acceptsMods: true,
    acceptsPlugins: true,
    rcon: true,
    query: true,
    variables: [],
    note: 'The maintained continuation of Magma. Prefer this over MAGMA on current versions.',
  }),
  entry({
    type: 'MAGMA',
    label: 'Magma (legacy)',
    family: 'hybrid',
    modTarget: 'mods',
    acceptsMods: true,
    acceptsPlugins: true,
    rcon: true,
    query: true,
    variables: [],
    note: 'Original Magma, no longer developed. Only for pinning an old version you already run.',
  }),
  entry({
    type: 'ARCLIGHT',
    label: 'Arclight',
    family: 'hybrid',
    modTarget: 'mods',
    acceptsMods: true,
    acceptsPlugins: true,
    rcon: true,
    query: true,
    variables: [],
    note: 'Bukkit API implemented on top of Forge, Fabric or NeoForge.',
  }),
  entry({
    type: 'KETTING',
    label: 'Ketting',
    family: 'hybrid',
    modTarget: 'mods',
    acceptsMods: true,
    acceptsPlugins: true,
    rcon: true,
    query: true,
    variables: [],
    note: 'Forge plus Bukkit for recent Minecraft versions.',
  }),
  entry({
    type: 'CRUCIBLE',
    label: 'Crucible',
    family: 'hybrid',
    modTarget: 'mods',
    acceptsMods: true,
    acceptsPlugins: true,
    rcon: true,
    query: true,
    variables: [],
    note: 'Thermos successor for 1.7.10 modpacks that also want Bukkit plugins.',
  }),
  entry({
    type: 'BANNER',
    label: 'Banner',
    family: 'hybrid',
    modTarget: 'mods',
    acceptsMods: true,
    acceptsPlugins: true,
    rcon: true,
    query: true,
    variables: [],
    note: 'Fabric mods plus Bukkit plugins.',
  }),
  entry({
    type: 'YOUER',
    label: 'Youer',
    family: 'hybrid',
    modTarget: 'mods',
    acceptsMods: true,
    acceptsPlugins: true,
    rcon: true,
    query: true,
    variables: [],
    note: "Mohist team's newer hybrid, targeting current Minecraft versions.",
  }),

  // --- Modpack platforms: the pack chooses the loader, so mods/ is the target ---
  entry({
    type: 'AUTO_CURSEFORGE',
    label: 'CurseForge modpack',
    family: 'modpack',
    modTarget: 'mods',
    acceptsMods: true,
    acceptsPlugins: false,
    rcon: true,
    query: true,
    variables: ['CF_SLUG', 'CF_FILE_ID', 'CF_PAGE_URL', 'CF_API_KEY', 'CF_FILENAME_MATCHER'],
    note: 'Installs a CurseForge pack from its slug and keeps it in sync across restarts.',
  }),
  entry({
    type: 'MODRINTH',
    label: 'Modrinth modpack',
    family: 'modpack',
    modTarget: 'mods',
    acceptsMods: true,
    acceptsPlugins: false,
    rcon: true,
    query: true,
    variables: ['MODRINTH_MODPACK', 'MODRINTH_VERSION', 'MODRINTH_LOADER'],
    note: 'Installs a Modrinth pack from its project slug or URL.',
  }),
  entry({
    type: 'FTBA',
    label: 'Feed the Beast modpack',
    family: 'modpack',
    modTarget: 'mods',
    acceptsMods: true,
    acceptsPlugins: false,
    rcon: true,
    query: true,
    variables: ['FTB_MODPACK_ID', 'FTB_MODPACK_VERSION_ID'],
    note: 'Installs an FTB pack by numeric id from the FTB API.',
  }),

  // --- Utility servers ---
  entry({
    type: 'LIMBO',
    label: 'Limbo',
    family: 'utility',
    modTarget: null,
    acceptsMods: false,
    acceptsPlugins: false,
    // Limbo is a few thousand lines that speak just enough protocol to hold a player in a
    // void room. It implements neither RCON nor query, and asking it for a player count
    // over either would hang rather than fail.
    rcon: false,
    query: false,
    variables: [],
    note: 'A holding server that keeps players connected while the real server restarts.',
  }),
  entry({
    type: 'NANOLIMBO',
    label: 'NanoLimbo',
    family: 'utility',
    modTarget: null,
    acceptsMods: false,
    acceptsPlugins: false,
    rcon: false,
    query: false,
    variables: [],
    note: 'Smaller, faster limbo implementation. Same purpose, lower footprint.',
  }),

  // --- Operator-supplied jar ---
  entry({
    type: 'CUSTOM',
    label: 'Custom server jar',
    family: 'custom',
    // Unknowable: the jar could be anything. The mod installer must refuse rather than guess.
    modTarget: null,
    acceptsMods: false,
    acceptsPlugins: false,
    rcon: true,
    query: true,
    variables: ['CUSTOM_SERVER', 'CUSTOM_JAR_EXEC'],
    note: 'Runs a jar you point at by URL or by path on the volume. You own what it does.',
  }),
];

const TYPES_BY_NAME: ReadonlyMap<string, MinecraftServerTypeInfo> = new Map(
  MINECRAFT_SERVER_TYPES.map((info) => [info.type, info]),
);

/** Lookup by the raw `TYPE` value. Case-insensitive, because the image upper-cases it too. */
export function minecraftServerType(type: string): MinecraftServerTypeInfo | null {
  return TYPES_BY_NAME.get(type.trim().toUpperCase()) ?? null;
}

/**
 * Where third-party code for this server type belongs, or null when it takes neither.
 *
 * The mod installer calls this before writing a single byte: `plugins/` on a Bukkit server,
 * `mods/` on a loader, and a refusal for vanilla, limbo or a custom jar.
 */
export function minecraftModTarget(type: string): MinecraftModTarget {
  return minecraftServerType(type)?.modTarget ?? null;
}

/** Hybrids answer true to both of these; that is the point of them. */
export function minecraftAcceptsMods(type: string): boolean {
  return minecraftServerType(type)?.acceptsMods ?? false;
}

export function minecraftAcceptsPlugins(type: string): boolean {
  return minecraftServerType(type)?.acceptsPlugins ?? false;
}

/** Unknown types answer false: never open an RCON socket on a guess. */
export function minecraftSupportsRcon(type: string): boolean {
  return minecraftServerType(type)?.rcon ?? false;
}

export function minecraftSupportsQuery(type: string): boolean {
  return minecraftServerType(type)?.query ?? false;
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** Where a version sits relative to the numbered releases. */
export type MinecraftVersionChannel = 'release' | 'snapshot' | 'alias';

export interface ParsedMinecraftVersion {
  raw: string;
  channel: MinecraftVersionChannel;
  /** `1.20.2` -> [1, 20, 2]; a snapshot's [year, week, revision]; an alias's rank. */
  parts: readonly number[];
  /** 0 experimental, 1 pre-release, 2 release candidate, 3 final. */
  stage: number;
  stageNumber: number;
}

const RELEASE_PATTERN = /^(\d+(?:\.\d+)*)(?:[-_ ]?(pre(?:-?release)?|rc|exp)[-_ ]?(\d+))?$/i;
const SNAPSHOT_PATTERN = /^(\d{2})w(\d{2})([a-z])$/i;

const STAGE_RANK: Record<string, number> = { exp: 0, pre: 1, 'pre-release': 1, prerelease: 1, rc: 2 };
const FINAL_STAGE = 3;

const CHANNEL_RANK: Record<MinecraftVersionChannel, number> = {
  release: 0,
  snapshot: 1,
  alias: 2,
};

/** The moving targets the image accepts in `VERSION`, ranked above every concrete build. */
const ALIAS_RANK: Record<string, number> = { SNAPSHOT: 1, LATEST: 2 };

/**
 * Parses the version spellings Mojang and the image actually use: `1.20.2`, `1.20`,
 * `1.20.5-pre3`, `1.19-rc1`, the weekly snapshot `24w14a`, and the `LATEST`/`SNAPSHOT`
 * aliases. Returns null for anything else rather than inventing an ordering for it.
 */
export function parseMinecraftVersion(value: string): ParsedMinecraftVersion | null {
  const raw = value.trim();
  if (raw.length === 0) return null;

  const aliasRank = ALIAS_RANK[raw.toUpperCase()];
  if (aliasRank !== undefined) {
    return { raw, channel: 'alias', parts: [aliasRank], stage: FINAL_STAGE, stageNumber: 0 };
  }

  const snapshot = SNAPSHOT_PATTERN.exec(raw);
  if (snapshot) {
    const [, year, week, revision] = snapshot;
    if (year === undefined || week === undefined || revision === undefined) return null;
    return {
      raw,
      channel: 'snapshot',
      parts: [Number(year), Number(week), revision.toLowerCase().charCodeAt(0)],
      stage: FINAL_STAGE,
      stageNumber: 0,
    };
  }

  const release = RELEASE_PATTERN.exec(raw);
  if (!release) return null;
  const [, numbers, qualifier, qualifierNumber] = release;
  if (numbers === undefined) return null;

  const parts = numbers.split('.').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;

  const stage = qualifier === undefined ? FINAL_STAGE : (STAGE_RANK[qualifier.toLowerCase()] ?? 0);
  return {
    raw,
    channel: 'release',
    parts,
    stage,
    stageNumber: qualifierNumber === undefined ? 0 : Number(qualifierNumber),
  };
}

function comparePartLists(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    // A missing segment is zero, so `1.20` and `1.20.0` are the same version and `1.20.2`
    // is above both.
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Orders two Minecraft versions. Negative when `a` is older, positive when newer, 0 when equal.
 *
 * Segment-wise numeric comparison, because the obvious string compare gets it exactly
 * backwards where it matters most: `'1.9' > '1.10'` lexically, but 1.9 is two years older.
 * Mod compatibility checks run through here, and that inversion would happily install a 1.9
 * mod onto a 1.10 server.
 *
 * Snapshots sort above every numbered release and among themselves by week, and the moving
 * aliases sort above snapshots. Neither is strictly true of the real release timeline — a
 * snapshot is only newer than the release it follows — but it is a total order, it is
 * documented, and it errs towards "this is newer than your pinned release", which is the
 * safe direction for a compatibility gate.
 */
export function compareMinecraftVersions(a: string, b: string): number {
  const left = parseMinecraftVersion(a);
  const right = parseMinecraftVersion(b);

  if (!left || !right) {
    // Unparseable values still need a total order or callers' sorts become unstable.
    if (left) return 1;
    if (right) return -1;
    return a === b ? 0 : a < b ? -1 : 1;
  }

  if (left.channel !== right.channel) {
    return CHANNEL_RANK[left.channel] - CHANNEL_RANK[right.channel];
  }

  const byParts = comparePartLists(left.parts, right.parts);
  if (byParts !== 0) return byParts;
  if (left.stage !== right.stage) return left.stage - right.stage;
  if (left.stageNumber !== right.stageNumber) return left.stageNumber - right.stageNumber;
  return 0;
}

/** `true` when `version` is `minimum` or newer. The shape most compatibility checks want. */
export function minecraftVersionAtLeast(version: string, minimum: string): boolean {
  return compareMinecraftVersions(version, minimum) >= 0;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * How much of the container limit is kept away from the Java heap.
 *
 * `-Xmx` bounds the heap and nothing else. Metaspace, code cache, thread stacks, GC
 * structures and the direct byte buffers Netty uses for every connection all live outside
 * it, and on a modded server they are easily half a gigabyte. Set the heap to the container
 * limit and the process grows past the cgroup ceiling with a heap that still looks healthy —
 * the kernel then kills it with no Java exception, no crash report and nothing in the log
 * except the container exiting. Reserving a slice up front is the whole fix.
 */
const NON_HEAP_RESERVE_RATIO = 0.2;
const MIN_NON_HEAP_RESERVE_MB = 512;
const MAX_NON_HEAP_RESERVE_MB = 2048;
const MIN_HEAP_MB = 512;

export function jvmHeapMb(containerMemoryMb: number): number {
  const proportional = Math.ceil(containerMemoryMb * NON_HEAP_RESERVE_RATIO);
  const reserve = Math.min(MAX_NON_HEAP_RESERVE_MB, Math.max(MIN_NON_HEAP_RESERVE_MB, proportional));
  return Math.max(MIN_HEAP_MB, containerMemoryMb - reserve);
}

/** Any of these being set means the operator has taken the sizing decision themselves. */
const MEMORY_OVERRIDES = ['MEMORY', 'INIT_MEMORY', 'MAX_MEMORY'] as const;

/**
 * Derives the heap from the container limit unless the operator has said otherwise.
 *
 * Initial and maximum heap are set to the same value on purpose: a growing heap costs a
 * full-heap resize pause mid-tick, and Aikar's flags — which this blueprint enables by
 * default — are tuned for a fixed heap.
 */
export const minecraftJavaEnvironment: EnvironmentHook = ({ values, server }): Record<string, string> => {
  if (MEMORY_OVERRIDES.some((key) => (values[key] ?? '').length > 0)) return {};
  const heap = `${jvmHeapMb(server.limits.memoryMb)}M`;
  return { INIT_MEMORY: heap, MAX_MEMORY: heap };
};

// ---------------------------------------------------------------------------
// Blueprint
// ---------------------------------------------------------------------------

const TYPE_OPTIONS = MINECRAFT_SERVER_TYPES.map((info) => ({
  value: info.type,
  label: `${info.label} — ${FAMILY_LABELS[info.family]}`,
}));

/** `1.20.4`, `1.20`, `1.20.5-pre3`, `24w14a`, `LATEST`, `SNAPSHOT`. */
const VERSION_PATTERN = '^(?:LATEST|SNAPSHOT|\\d+(?:\\.\\d+){0,2}(?:-(?:pre|rc)\\d+)?|\\d{2}w\\d{2}[a-z])$';

export const minecraftJavaBlueprint: BlueprintDefinition = {
  key: 'minecraft-java',
  name: 'Minecraft: Java Edition',
  game: 'Minecraft',
  summary: 'Vanilla, Paper, Fabric, Forge, NeoForge, hybrids and modpacks — one blueprint.',
  description: [
    'Minecraft: Java Edition on the itzg/minecraft-server image, which resolves the server jar',
    'for you from the type you pick. Vanilla is the game as Mojang ships it. Paper and its forks',
    'run Bukkit plugins and are what most public servers use. Fabric, Forge, NeoForge and Quilt',
    'run mods, which every player must also install on their client. The hybrids run both, at',
    'some cost in stability. The modpack types install a whole CurseForge, Modrinth or FTB pack',
    'and keep it in sync on every restart.',
    '',
    'Memory is the setting that matters. Vanilla is happy in 2 GB; a 200-mod pack will use 8 GB',
    'and want more. Platter sizes the Java heap below the container limit automatically, because',
    'a heap sized at the limit gets the whole server killed by the kernel with nothing in the log.',
  ].join(' '),
  category: 'sandbox',
  // Pinned to a dated image release, never `latest`: the game version is chosen per server by
  // VERSION, so tracking the image's moving tag would only ever import someone else's breakage.
  image: 'itzg/minecraft-server:2026.8.0-java21',
  icon: { monogram: 'MC', hue: 122 },
  minMemoryMb: 1024,
  recommendedMemoryMb: 4096,
  minDiskMb: 8192,
  ports: [
    { name: 'game', label: 'Game', containerPort: 25565, protocol: 'tcp', primary: true },
    { name: 'query', label: 'Query', containerPort: 25565, protocol: 'udp' },
    { name: 'rcon', label: 'RCON', containerPort: 25575, protocol: 'tcp', bindLocal: true },
  ],
  variables: [
    {
      key: 'EULA',
      label: 'I accept the Minecraft EULA',
      description:
        'Mojang requires every server operator to accept the Minecraft End User Licence Agreement at https://aka.ms/MinecraftEULA. The server will not start until you do.',
      type: 'boolean',
      // No default on purpose. A default of false would let a server be created that can never
      // boot; a default of true would accept a licence on someone else's behalf.
      default: null,
      required: true,
    },
    {
      key: 'TYPE',
      label: 'Server type',
      description:
        'Which server software to run. Plugin servers take Bukkit plugins, mod loaders take mods, hybrids take both, and modpack types install a published pack.',
      type: 'enum',
      default: 'PAPER',
      required: true,
      options: TYPE_OPTIONS,
    },
    {
      key: 'VERSION',
      label: 'Minecraft version',
      description:
        'A version such as 1.21.4, or LATEST to track the newest release. Modpack types override this with whatever the pack targets.',
      type: 'string',
      default: 'LATEST',
      pattern: VERSION_PATTERN,
    },
    {
      key: 'MOTD',
      label: 'Server description',
      description: 'The line players see under the server name in their multiplayer list.',
      type: 'string',
      default: 'A Platter server',
      max: 200,
    },
    {
      key: 'DIFFICULTY',
      label: 'Difficulty',
      type: 'enum',
      default: 'normal',
      options: [
        { value: 'peaceful', label: 'Peaceful — no hostile mobs' },
        { value: 'easy', label: 'Easy' },
        { value: 'normal', label: 'Normal' },
        { value: 'hard', label: 'Hard' },
      ],
    },
    {
      key: 'MODE',
      label: 'Game mode',
      type: 'enum',
      default: 'survival',
      options: [
        { value: 'survival', label: 'Survival' },
        { value: 'creative', label: 'Creative' },
        { value: 'adventure', label: 'Adventure' },
        { value: 'spectator', label: 'Spectator' },
      ],
    },
    {
      key: 'MAX_PLAYERS',
      label: 'Player slots',
      type: 'number',
      default: 20,
      min: 1,
      max: 1000,
    },
    {
      key: 'LEVEL',
      label: 'World name',
      description: 'The folder the world is saved into. Changing it starts a new world.',
      type: 'string',
      default: 'world',
      max: 64,
      pattern: '^[A-Za-z0-9 _.-]+$',
    },
    {
      key: 'SEED',
      label: 'World seed',
      description: 'Leave empty for a random world. Only used the first time the world generates.',
      type: 'string',
      default: '',
      max: 128,
    },
    {
      key: 'LEVEL_TYPE',
      label: 'World type',
      type: 'enum',
      default: 'minecraft:normal',
      options: [
        { value: 'minecraft:normal', label: 'Normal' },
        { value: 'minecraft:flat', label: 'Superflat' },
        { value: 'minecraft:large_biomes', label: 'Large biomes' },
        { value: 'minecraft:amplified', label: 'Amplified' },
        { value: 'minecraft:single_biome_surface', label: 'Single biome' },
      ],
    },
    {
      key: 'OPS',
      label: 'Operators',
      description: 'Comma-separated usernames given full server commands.',
      type: 'string',
      default: '',
      max: 1000,
    },
    {
      key: 'ENABLE_WHITELIST',
      label: 'Whitelist only',
      description: 'When on, only the players listed below can connect.',
      type: 'boolean',
      default: false,
    },
    {
      key: 'WHITELIST',
      label: 'Whitelisted players',
      description: 'Comma-separated usernames. Only has an effect when the whitelist is on.',
      type: 'string',
      default: '',
      max: 4000,
    },
    {
      key: 'ONLINE_MODE',
      label: 'Verify accounts with Mojang',
      description:
        'Turn this off only on a private network. With it off, anyone can connect using any username.',
      type: 'boolean',
      default: true,
    },
    { key: 'PVP', label: 'Player versus player', type: 'boolean', default: true },
    { key: 'HARDCORE', label: 'Hardcore', type: 'boolean', default: false },
    {
      key: 'VIEW_DISTANCE',
      label: 'View distance',
      description: 'Chunks sent to each player. The single biggest lever on CPU and bandwidth.',
      type: 'number',
      default: 10,
      min: 2,
      max: 32,
    },
    {
      key: 'SIMULATION_DISTANCE',
      label: 'Simulation distance',
      description: 'Chunks that keep ticking. Lower this before lowering view distance.',
      type: 'number',
      default: 10,
      min: 2,
      max: 32,
      advanced: true,
    },
    {
      key: 'SPAWN_PROTECTION',
      label: 'Spawn protection radius',
      type: 'number',
      default: 16,
      min: 0,
      max: 1000,
      advanced: true,
    },
    { key: 'ALLOW_NETHER', label: 'Allow the Nether', type: 'boolean', default: true, advanced: true },
    { key: 'ALLOW_FLIGHT', label: 'Allow flight', type: 'boolean', default: false, advanced: true },
    {
      key: 'ENABLE_COMMAND_BLOCK',
      label: 'Enable command blocks',
      type: 'boolean',
      default: false,
      advanced: true,
    },

    // --- Type-specific ---
    {
      key: 'PAPER_CHANNEL',
      label: 'Paper channel',
      description: 'Paper, Purpur and Folia only. `experimental` is required for unreleased versions.',
      type: 'enum',
      default: 'default',
      options: [
        { value: 'default', label: 'Stable builds' },
        { value: 'experimental', label: 'Experimental builds' },
      ],
      advanced: true,
    },
    {
      key: 'PAPER_BUILD',
      label: 'Paper build number',
      description: 'Paper only. Pin a specific build instead of the newest for the version.',
      type: 'string',
      default: '',
      max: 16,
      pattern: '^\\d*$',
      advanced: true,
    },
    {
      key: 'FABRIC_LOADER_VERSION',
      label: 'Fabric loader version',
      description: 'Fabric only. Empty means the newest loader for the Minecraft version.',
      type: 'string',
      default: '',
      max: 32,
      advanced: true,
    },
    {
      key: 'FABRIC_LAUNCHER_VERSION',
      label: 'Fabric launcher version',
      description: 'Fabric only. Pins the installer that produces the server launcher jar.',
      type: 'string',
      default: '',
      max: 32,
      advanced: true,
    },
    {
      key: 'FORGE_VERSION',
      label: 'Forge version',
      description: 'Forge only. Empty means the recommended build for the Minecraft version.',
      type: 'string',
      default: '',
      max: 32,
      advanced: true,
    },
    {
      key: 'NEOFORGE_VERSION',
      label: 'NeoForge version',
      description: 'NeoForge only. Empty means the newest build for the Minecraft version.',
      type: 'string',
      default: '',
      max: 32,
      advanced: true,
    },
    {
      key: 'QUILT_LOADER_VERSION',
      label: 'Quilt loader version',
      type: 'string',
      default: '',
      max: 32,
      advanced: true,
    },
    {
      key: 'QUILT_INSTALLER_VERSION',
      label: 'Quilt installer version',
      type: 'string',
      default: '',
      max: 32,
      advanced: true,
    },
    {
      key: 'SPONGEVERSION',
      label: 'SpongeVanilla version',
      type: 'string',
      default: '',
      max: 32,
      advanced: true,
    },
    {
      key: 'CF_SLUG',
      label: 'CurseForge pack slug',
      description:
        'CurseForge modpack type. The slug from the pack URL, e.g. `all-the-mods-10`. Give this or the page URL.',
      type: 'string',
      default: '',
      max: 128,
      pattern: '^[a-z0-9-]*$',
      advanced: true,
    },
    {
      key: 'CF_FILE_ID',
      label: 'CurseForge file id',
      description: 'CurseForge modpack type. Pins one pack release; empty tracks the newest.',
      type: 'string',
      default: '',
      max: 16,
      pattern: '^\\d*$',
      advanced: true,
    },
    {
      key: 'CF_PAGE_URL',
      label: 'CurseForge pack URL',
      description: 'CurseForge modpack type. A full pack or file page URL, as an alternative to the slug.',
      type: 'string',
      default: '',
      max: 400,
      advanced: true,
    },
    {
      key: 'CF_API_KEY',
      label: 'CurseForge API key',
      description: 'Optional. The image ships a key; supply your own only if you have been rate limited.',
      type: 'password',
      default: '',
      max: 256,
      advanced: true,
    },
    {
      key: 'MODRINTH_MODPACK',
      label: 'Modrinth pack',
      description: 'Modrinth modpack type. A project slug, project id or a full modrinth.com URL.',
      type: 'string',
      default: '',
      max: 400,
      advanced: true,
    },
    {
      key: 'MODRINTH_VERSION',
      label: 'Modrinth pack version',
      description: 'Modrinth modpack type. A version number or id; empty tracks the newest release.',
      type: 'string',
      default: '',
      max: 64,
      advanced: true,
    },
    {
      key: 'MODRINTH_LOADER',
      label: 'Modrinth loader',
      description: 'Modrinth modpack type. Only needed when a pack publishes builds for several loaders.',
      type: 'enum',
      default: '',
      options: [
        { value: '', label: 'Whatever the pack targets' },
        { value: 'fabric', label: 'Fabric' },
        { value: 'forge', label: 'Forge' },
        { value: 'neoforge', label: 'NeoForge' },
        { value: 'quilt', label: 'Quilt' },
      ],
      advanced: true,
    },
    {
      key: 'FTB_MODPACK_ID',
      label: 'FTB modpack id',
      description: 'Feed the Beast type. The numeric pack id from the FTB app or website.',
      type: 'string',
      default: '',
      max: 16,
      pattern: '^\\d*$',
      advanced: true,
    },
    {
      key: 'FTB_MODPACK_VERSION_ID',
      label: 'FTB pack version id',
      description: 'Feed the Beast type. Empty installs the newest version of the pack.',
      type: 'string',
      default: '',
      max: 16,
      pattern: '^\\d*$',
      advanced: true,
    },
    {
      key: 'CUSTOM_SERVER',
      label: 'Custom server jar',
      description:
        'Custom type. A URL to download the jar from, or a path to one already on the volume.',
      type: 'string',
      default: '',
      max: 400,
      advanced: true,
    },
    {
      key: 'CUSTOM_JAR_EXEC',
      label: 'Custom jar arguments',
      description: 'Custom type. Extra arguments passed after `-jar`, if the jar needs them.',
      type: 'string',
      default: '',
      max: 400,
      advanced: true,
    },

    // --- Runtime ---
    {
      key: 'MEMORY',
      label: 'Java heap override',
      description:
        'Leave empty. Platter sizes the heap from the container memory limit, keeping enough outside the heap that the kernel does not kill the server. Set this (e.g. 6G) only to override that.',
      type: 'string',
      default: '',
      max: 16,
      pattern: '^(?:\\d+[KMGkmg]?)?$',
      advanced: true,
    },
    {
      key: 'USE_AIKAR_FLAGS',
      label: "Use Aikar's JVM flags",
      description: 'G1GC tuning that measurably reduces tick lag on most servers. Leave on.',
      type: 'boolean',
      default: true,
      advanced: true,
    },
    {
      key: 'JVM_OPTS',
      label: 'Extra JVM options',
      type: 'string',
      default: '',
      max: 1000,
      advanced: true,
    },
    {
      key: 'ENABLE_RCON',
      label: 'Enable RCON',
      description: 'Required for the console, scheduled commands and the player list.',
      type: 'boolean',
      default: true,
      advanced: true,
    },
    {
      key: 'RCON_PASSWORD',
      label: 'RCON password',
      description: 'Leave empty to have the image generate one. The RCON port is never published.',
      type: 'password',
      default: '',
      max: 128,
      advanced: true,
    },
    {
      key: 'ENABLE_QUERY',
      label: 'Enable the query protocol',
      description: 'Lets server-list sites and Platter read the player count without RCON.',
      type: 'boolean',
      default: true,
      advanced: true,
    },
    {
      key: 'STOP_SERVER_ANNOUNCE_DELAY',
      label: 'Shutdown warning (seconds)',
      description: 'Announce the shutdown in chat and wait this long before saving and stopping.',
      type: 'number',
      default: 0,
      min: 0,
      max: 300,
      advanced: true,
    },
    {
      key: 'OVERRIDE_SERVER_PROPERTIES',
      label: 'Rewrite server.properties on boot',
      description:
        'On: the settings above win on every start. Off: edits made in the file editor survive, and the settings above stop taking effect.',
      type: 'boolean',
      default: true,
      advanced: true,
    },
    { key: 'TZ', label: 'Timezone', type: 'string', default: 'UTC', max: 64, advanced: true },

    // --- Fixed by the blueprint: these have to agree with `ports` above ---
    { key: 'SERVER_PORT', label: 'Server port', type: 'number', default: 25565, hidden: true },
    { key: 'QUERY_PORT', label: 'Query port', type: 'number', default: 25565, hidden: true },
    { key: 'RCON_PORT', label: 'RCON port', type: 'number', default: 25575, hidden: true },
    // Without this the image reformats every log line and the console loses its timestamps.
    { key: 'ENABLE_ROLLING_LOGS', label: 'Rolling log files', type: 'boolean', default: false, hidden: true },
  ],
  signals: {
    // Vanilla prints `[Server thread/INFO]: Done (5.123s)! For help, type "help"`; Paper's
    // prefix differs, so match only the part they share.
    ready: ['Done \\([\\d.,]+s\\)! For help', 'RCON running on [\\d.]+:\\d+'],
    crash: [
      'You need to agree to the EULA in order to run the server',
      '\\[init\\] ERROR:',
      'Exception in server tick loop',
      'Failed to start the minecraft server',
      'java\\.lang\\.OutOfMemoryError',
      'Encountered an unexpected exception',
      'Failed to bind to port',
    ],
    // Group 1 is the player name in all four patterns; the players service relies on that.
    playerJoin: [
      '\\b([A-Za-z0-9_]{2,16}) joined the game',
      '\\b([A-Za-z0-9_]{2,16})\\[/[\\d.:a-fA-F\\[\\]]+\\] logged in with entity id',
    ],
    playerLeave: ['\\b([A-Za-z0-9_]{2,16}) left the game'],
  },
  stop: {
    // The image's PID 1 would translate SIGTERM into the same console command, but Platter
    // sends `stop` itself so the save starts immediately and the shutdown does not depend on
    // which entrypoint the image happens to ship. A killed Minecraft server loses every
    // chunk modified since the last autosave.
    strategy: 'command',
    command: 'stop',
    signal: 'SIGTERM',
    // Large modded worlds genuinely take a minute or more to flush.
    timeoutSeconds: 120,
  },
  // `save-all flush` blocks until the chunks are on disk, so the archive that follows sees
  // a consistent world rather than one mid-write.
  saveCommands: { flush: ['save-off', 'save-all flush'], resume: ['save-on'] },
  dataPath: '/data',
  features: { console: true, rcon: true, mods: true, worldUpload: true, playerList: true },
  docsUrl: 'https://docker-minecraft-server.readthedocs.io/en/latest/',
};
