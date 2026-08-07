import type { Confidence, LogBlock, Match, MatchDetail, ModReference } from '../types';

/**
 * The parts every rule would otherwise reinvent.
 *
 * Two of these carry most of the weight. `attributeMod` is how a finding stops being "a mod
 * crashed" and becomes "Create crashed" — the difference between a diagnosis a user can act on
 * and one they cannot. `looksLikePlayerText` is the false-positive guard: chat and command
 * echoes are logged at INFO on the server thread and contain arbitrary attacker-chosen text, so
 * without it a player can type `java.lang.OutOfMemoryError` and make Platter tell the owner to
 * buy more RAM.
 */

/* -------------------------------------------------------------------------- */
/* Reading what a rule parsed                                                  */
/* -------------------------------------------------------------------------- */

export function detailString(m: Match, key: string, fallback = ''): string {
  const value = m.details[key];
  return typeof value === 'string' ? value : fallback;
}

export function detailNumber(m: Match, key: string, fallback: number): number {
  const value = m.details[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function detailBool(m: Match, key: string): boolean {
  return m.details[key] === true;
}

export function detailList(m: Match, key: string): readonly string[] {
  const value = m.details[key];
  return Array.isArray(value) ? (value as readonly string[]) : [];
}

/** Drop undefined entries so a `Match` stays clean JSON. */
export function details(
  entries: Readonly<Record<string, MatchDetail | undefined>>
): Readonly<Record<string, MatchDetail>> {
  const out: Record<string, MatchDetail> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export function match(
  blocks: readonly LogBlock[],
  confidence: Confidence,
  entries: Readonly<Record<string, MatchDetail | undefined>> = {}
): Match {
  return { blocks, confidence, details: details(entries) };
}

/* -------------------------------------------------------------------------- */
/* False-positive guards                                                       */
/* -------------------------------------------------------------------------- */

/** `<Steve> ...`, `[Steve: Set own game mode to ...]`, `Steve issued server command: /...`. */
const PLAYER_TEXT_RE = /^(?:<[^>]{1,32}>|\[[^\]]{1,48}: )|issued server command:|\bsaid:/;

/**
 * Whether a block is player-authored text rather than a program's own output.
 *
 * Chat, command echoes and sign text all reach the log at INFO on the server thread, and their
 * content is chosen by whoever is connected. Any rule matching a substring — which is all of
 * them — has to exclude these or it hands users a way to fake a diagnosis.
 */
export function looksLikePlayerText(block: LogBlock): boolean {
  if (block.source !== 'minecraft') {
    return false;
  }
  if (block.level !== undefined && block.level !== 'info') {
    return false;
  }
  return PLAYER_TEXT_RE.test(block.head.message);
}

/** Blocks worth running an error rule against: excludes chat and anything below WARN. */
export function candidateBlocks(blocks: readonly LogBlock[]): LogBlock[] {
  return blocks.filter((b) => !looksLikePlayerText(b));
}

/* -------------------------------------------------------------------------- */
/* Mod attribution                                                             */
/* -------------------------------------------------------------------------- */

/**
 * ModLauncher rewrites stack frames to carry the owning module, which on Forge and NeoForge
 * means the mod id and version are printed in every frame:
 *
 *     at TRANSFORMER/create@0.5.1/com.simibubi.create.Foo.bar(Foo.java:42)
 *
 * That is by far the most reliable attribution signal available — better than guessing from a
 * package name, which mods routinely shade or relocate.
 */
const MODLAUNCHER_FRAME_RE =
  /^\s+at\s+(?:[A-Za-z-]+\/)?(?<id>[a-z][a-z0-9_-]{1,63})@(?<version>[^/\s]+)\//gm;

/** Mixin configs are conventionally named after their mod: `create.mixins.json`, `mixins.jei.json`. */
const MIXIN_CONFIG_RE = /(?:^|[\s[('"])(?<config>[A-Za-z0-9_.-]+\.mixins?\.json)/;

/** Packages that belong to the platform rather than to any mod. */
const PLATFORM_PREFIXES = [
  'java.',
  'javax.',
  'jdk.',
  'sun.',
  'com.sun.',
  'net.minecraft.',
  'net.minecraftforge.',
  'net.neoforged.',
  'net.fabricmc.',
  'org.quiltmc.',
  'cpw.mods.',
  'org.spongepowered.',
  'org.bukkit.',
  'org.spigotmc.',
  'io.papermc.',
  'com.mojang.',
  'io.netty.',
  'it.unimi.dsi.',
  'org.apache.',
  'org.slf4j.',
  'ch.qos.',
];

const PLAIN_FRAME_RE = /^\s+at\s+(?<fqcn>[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)+)\./gm;

/** Ids that name the loader or the game, not a mod. Fixing these means changing versions, not files. */
export const PLATFORM_IDS: ReadonlySet<string> = new Set([
  'minecraft',
  'forge',
  'neoforge',
  'fabric',
  'fabricloader',
  'fabric-api',
  'fabric-loader',
  'quilt_loader',
  'quiltloader',
  'java',
  'mcp',
  'fml',
]);

export interface ModAttribution {
  readonly modId?: string;
  readonly modVersion?: string;
  /** Where the id came from, so `explain()` can be honest about how sure it is. */
  readonly via: 'frame' | 'mixin-config' | 'package' | 'none';
  readonly confidence: Confidence;
}

/**
 * Work out which mod a stack trace belongs to.
 *
 * Tried in descending order of reliability: an explicit ModLauncher module, then a mixin config
 * filename, then the first stack frame in a package nobody on the platform owns. The last is a
 * guess and says so, because acting on it means deleting a user's mod.
 */
export function attributeMod(block: LogBlock): ModAttribution {
  MODLAUNCHER_FRAME_RE.lastIndex = 0;
  for (const m of block.text.matchAll(MODLAUNCHER_FRAME_RE)) {
    const id = m.groups?.id;
    if (id !== undefined && !PLATFORM_IDS.has(id)) {
      return {
        modId: id,
        ...(m.groups?.version === undefined ? {} : { modVersion: m.groups.version }),
        via: 'frame',
        confidence: 'high',
      };
    }
  }

  const config = MIXIN_CONFIG_RE.exec(block.text)?.groups?.config;
  if (config !== undefined) {
    const id = modIdFromMixinConfig(config);
    if (id !== undefined) {
      return { modId: id, via: 'mixin-config', confidence: 'medium' };
    }
  }

  PLAIN_FRAME_RE.lastIndex = 0;
  for (const m of block.text.matchAll(PLAIN_FRAME_RE)) {
    const fqcn = m.groups?.fqcn;
    if (fqcn !== undefined && !PLATFORM_PREFIXES.some((p) => fqcn.startsWith(p))) {
      return { modId: guessIdFromPackage(fqcn), via: 'package', confidence: 'low' };
    }
  }

  return { via: 'none', confidence: 'low' };
}

/** `create.mixins.json` and `mixins.create.json` both mean `create`. */
export function modIdFromMixinConfig(config: string): string | undefined {
  const base = config.replace(/\.mixins?\.json$/, '').replace(/^mixins?\./, '');
  const id = base.split('.').pop();
  return id !== undefined && id.length > 1 && !PLATFORM_IDS.has(id) ? id : undefined;
}

/**
 * `com.simibubi.create.foundation.Foo` → `create`.
 *
 * Deliberately crude. It exists to give a human something to search for, never to drive an
 * automatic removal — every caller pairs it with `confidence: 'low'`.
 */
function guessIdFromPackage(fqcn: string): string {
  const parts = fqcn.split('.');
  const meaningful = parts
    .slice(0, -1)
    .filter((p) => !['com', 'net', 'org', 'io', 'me'].includes(p));
  return meaningful[meaningful.length - 1] ?? parts[0] ?? 'unknown';
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

export function listPhrase(items: readonly string[], conjunction = 'and'): string {
  if (items.length === 0) {
    return '';
  }
  if (items.length === 1) {
    return items[0] ?? '';
  }
  const head = items.slice(0, -1).join(', ');
  return `${head} ${conjunction} ${items[items.length - 1]}`;
}

export function modRef(id: string, name?: string, versionRange?: string): ModReference {
  return {
    id,
    ...(name === undefined || name === id ? {} : { name }),
    ...(versionRange === undefined ? {} : { versionRange }),
  };
}

/** Ids are printed by loaders in a known shape; anything else is a parse slip, not a mod. */
export function isPlausibleModId(id: string): boolean {
  return /^[a-z][a-z0-9_-]{1,63}$/.test(id);
}
