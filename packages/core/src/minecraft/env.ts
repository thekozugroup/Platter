import {
  type MinecraftLoader,
  type ServerSettings,
  heapForContainer,
} from '@platter/shared';
import { LOADER_TYPE, LOADER_VERSION_ENV } from './manifest.js';

export interface BuildEnvInput {
  loader: MinecraftLoader;
  gameVersion: string;
  loaderVersion?: string | null | undefined;
  settings: ServerSettings;
  memoryMiB: number;
  rconPassword: string;
  /** Set when the server was created from a Modrinth modpack. */
  modrinthModpack?: { projectId: string; versionId?: string | undefined } | undefined;
  /** Set when the server was created from a CurseForge modpack. Requires an API key. */
  curseforgeModpack?: { fileId: string } | undefined;
  curseforgeApiKey?: string | undefined;
  timezone?: string | undefined;
}

/**
 * Build the container environment for `itzg/minecraft-server`.
 *
 * Two rules run through this whole function:
 *
 * 1. **Never send `VERSION=LATEST`.** The image's own docs note that with `LATEST` "an upgrade
 *    can be performed by simply restarting the container" — which for a managed platform means
 *    an unrelated restart can silently migrate somebody's world to a new Minecraft version and
 *    strand their mods. Platter resolves `LATEST` to a concrete version at creation time and
 *    pins it forever after.
 *
 * 2. **An unset variable is not the same as an empty one.** The image treats an empty string as
 *    "clear this server property" and an absent variable as "leave it alone". Optional settings
 *    are therefore omitted rather than stringified, which is why this builds a map with
 *    conditional writes instead of one big object literal.
 */
export function buildContainerEnv(input: BuildEnvInput): Record<string, string> {
  const { settings } = input;
  const env: Record<string, string> = {};

  const set = (key: string, value: string | number | boolean | undefined | null): void => {
    if (value === undefined || value === null) {
      return;
    }
    env[key] = typeof value === 'boolean' ? String(value).toUpperCase() : String(value);
  };

  /* --- Identity ---------------------------------------------------------- */
  set('EULA', 'TRUE');
  set('TYPE', LOADER_TYPE[input.loader]);
  set('VERSION', input.gameVersion);
  set('TZ', input.timezone ?? 'UTC');

  const loaderVersionKey = LOADER_VERSION_ENV[input.loader];
  if (loaderVersionKey && input.loaderVersion) {
    set(loaderVersionKey, input.loaderVersion);
  }

  /* --- Memory ------------------------------------------------------------ */
  // The container limit is not the heap. The JVM also needs metaspace, code cache, GC
  // structures and — for Minecraft especially — Netty's off-heap direct buffers, which scale
  // with player count. Handing the whole limit to -Xmx gets the container OOM-killed by the
  // kernel, which leaves no Java stack trace and reads to the user as "it just died".
  const heapMiB = heapForContainer(input.memoryMiB);
  set('INIT_MEMORY', `${Math.min(heapMiB, Math.max(512, Math.round(heapMiB / 2)))}M`);
  set('MAX_MEMORY', `${heapMiB}M`);
  // Aikar's G1GC tuning. Worth it above ~2 GiB; below that the region sizing it assumes does
  // not hold and the defaults do better.
  set('USE_AIKAR_FLAGS', heapMiB >= 2048);

  /* --- RCON -------------------------------------------------------------- */
  set('ENABLE_RCON', true);
  set('RCON_PASSWORD', input.rconPassword);
  set('RCON_PORT', 25_575);
  // Keep RCON traffic out of the in-game chat; Platter's own audit log is the record.
  set('BROADCAST_RCON_TO_OPS', false);

  /* --- Shutdown ---------------------------------------------------------- */
  // Minecraft flushes chunks on shutdown. Cutting that short is the most reliable way to
  // corrupt a world, so the in-container stop budget is generous and the Docker stop timeout
  // (set in the container spec) is deliberately larger still.
  set('STOP_DURATION', 90);
  set('STOP_SERVER_ANNOUNCE_DELAY', 10);

  /* --- Logging ----------------------------------------------------------- */
  // Timestamps come from Docker's log driver; asking the JVM for them too produces doubled
  // timestamps in the console view.
  set('LOG_TIMESTAMP', false);
  // No TTY is attached, so colour codes would just be noise in the stored log buffer.
  set('CONSOLE', true);
  set('GUI', false);

  /* --- server.properties ------------------------------------------------- */
  set('MOTD', settings.motd);
  set('DIFFICULTY', settings.difficulty);
  set('MODE', settings.gameMode);
  set('MAX_PLAYERS', settings.maxPlayers);
  set('ONLINE_MODE', settings.onlineMode);
  set('PVP', settings.pvp);
  set('ALLOW_FLIGHT', settings.allowFlight);
  set('HARDCORE', settings.hardcore);
  set('ENABLE_COMMAND_BLOCK', settings.enableCommandBlock);
  set('SPAWN_PROTECTION', settings.spawnProtection);
  set('VIEW_DISTANCE', settings.viewDistance);
  set('SIMULATION_DISTANCE', settings.simulationDistance);
  set('LEVEL', settings.levelName);
  set('ENFORCE_SECURE_PROFILE', settings.enforceSecureProfile);

  if (settings.levelSeed) {
    // Negative seeds must survive shell interpolation intact.
    set('SEED', settings.levelSeed);
  }
  if (settings.levelType) {
    set('LEVEL_TYPE', settings.levelType);
  }

  if (settings.whitelistEnabled) {
    set('ENABLE_WHITELIST', true);
    set('ENFORCE_WHITELIST', true);
    if (settings.whitelist.length > 0) {
      set('WHITELIST', settings.whitelist.join(','));
    }
  }
  if (settings.ops.length > 0) {
    set('OPS', settings.ops.join(','));
  }

  if (Object.keys(settings.extraProperties).length > 0) {
    set(
      'CUSTOM_SERVER_PROPERTIES',
      Object.entries(settings.extraProperties)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')
    );
  }

  /* --- Modpacks ---------------------------------------------------------- */
  if (input.modrinthModpack) {
    set('MODPACK_PLATFORM', 'MODRINTH');
    set('MODRINTH_MODPACK', input.modrinthModpack.projectId);
    if (input.modrinthModpack.versionId) {
      set('MODRINTH_VERSION', input.modrinthModpack.versionId);
    }
    // The image warns against setting both; the modpack decides the loader and version.
    delete env.TYPE;
    delete env.VERSION;
  }

  if (input.curseforgeModpack && input.curseforgeApiKey) {
    set('MODPACK_PLATFORM', 'AUTO_CURSEFORGE');
    set('CF_FILE_ID', input.curseforgeModpack.fileId);
    set('CF_API_KEY', input.curseforgeApiKey);
    delete env.TYPE;
    delete env.VERSION;
  }

  /* --- Escape hatch ------------------------------------------------------ */
  // Applied last so a user override beats Platter's opinion. Deliberately excludes the
  // variables that would let a pack execute shell on the host's behalf.
  for (const [key, value] of Object.entries(settings.extraEnv)) {
    if (BLOCKED_ENV.has(key.toUpperCase())) {
      continue;
    }
    env[key] = value;
  }

  return env;
}

/**
 * Variables Platter refuses to pass through from user-supplied config.
 *
 * The `LOAD_ENV_FROM_*` family lets a *downloaded artefact* define container environment
 * variables, and the image sources that file with bash — "any shell syntax it contains will be
 * evaluated". Worse, those values override the ones Platter sets, so a hostile pack could
 * rewrite `RCON_PASSWORD` or `UID`. That is arbitrary code execution by design; it stays off.
 *
 * The rest are variables Platter owns because correctness depends on them.
 */
const BLOCKED_ENV = new Set([
  'LOAD_ENV_FROM_GENERIC_PACK',
  'LOAD_ENV_FROM_FILE',
  'LOAD_ENV_FROM_ARCHIVE',
  'LOAD_ENV_FROM_ARCHIVE_ENTRY',
  'UID',
  'GID',
  'SKIP_SUDO',
  'SKIP_CHOWN_DATA',
  'RCON_PASSWORD',
  'RCON_PASSWORD_FILE',
  'ENABLE_RCON',
  'RCON_PORT',
  'EULA',
  'SERVER_PORT',
  'DISABLE_HEALTHCHECK',
]);

export { BLOCKED_ENV };
