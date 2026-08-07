import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Identifiers                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Server ids are ULIDs: sortable by creation time, URL-safe, and short enough to read aloud.
 * The slug is what shows up in container names and on disk, so it is constrained hard.
 */
export const serverIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'must be a ULID');

export const slugSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits and single hyphens only');

export const serverNameSchema = z.string().trim().min(1).max(64);

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The lifecycle a server moves through. This is Platter's view, which is deliberately richer
 * than Docker's — Docker only knows created/running/exited, and cannot tell you the difference
 * between "the JVM is up but the world is still generating" and "players can join right now".
 *
 *   creating   row exists, container does not yet
 *   installing container exists and is downloading the server jar / mods / modpack
 *   starting   process is up, not yet accepting players
 *   running    healthy and accepting connections
 *   stopping   graceful shutdown in progress
 *   stopped    container exists, exited cleanly
 *   crashed    container exited non-zero, or died while we expected it to be running
 *   unhealthy  running but failing its health check (hung, OOM-thrashing, deadlocked)
 *   deleting   teardown in progress
 *   error      Platter could not reach a known state; see statusMessage
 */
export const SERVER_STATUSES = [
  'creating',
  'installing',
  'starting',
  'running',
  'stopping',
  'stopped',
  'crashed',
  'unhealthy',
  'deleting',
  'error',
] as const;

export const serverStatusSchema = z.enum(SERVER_STATUSES);
export type ServerStatus = z.infer<typeof serverStatusSchema>;

/** States where the container is expected to exist and be running. */
export const LIVE_STATUSES: ReadonlySet<ServerStatus> = new Set<ServerStatus>([
  'installing',
  'starting',
  'running',
  'unhealthy',
]);

/** States where a lifecycle operation is already in flight — reject new ones. */
export const TRANSITIONAL_STATUSES: ReadonlySet<ServerStatus> = new Set<ServerStatus>([
  'creating',
  'installing',
  'starting',
  'stopping',
  'deleting',
]);

/* -------------------------------------------------------------------------- */
/* Games and runtimes                                                          */
/* -------------------------------------------------------------------------- */

export const GAMES = ['minecraft'] as const;
export const gameSchema = z.enum(GAMES);
export type Game = z.infer<typeof gameSchema>;

/**
 * Minecraft server flavours. `itzg/minecraft-server` calls this TYPE.
 *
 * Two families that behave very differently:
 *   - *plugin* platforms (spigot/paper/purpur/folia) run Bukkit plugins, never mods
 *   - *mod* loaders (fabric/forge/neoforge/quilt) run mods, never Bukkit plugins
 * The compatibility engine leans on this distinction constantly, so it is encoded in
 * `LOADER_FAMILY` below rather than rediscovered at each call site.
 */
export const MINECRAFT_LOADERS = [
  'vanilla',
  'paper',
  'purpur',
  'spigot',
  'folia',
  'fabric',
  'forge',
  'neoforge',
  'quilt',
] as const;

export const minecraftLoaderSchema = z.enum(MINECRAFT_LOADERS);
export type MinecraftLoader = z.infer<typeof minecraftLoaderSchema>;

export type LoaderFamily = 'vanilla' | 'plugin' | 'mod';

export const LOADER_FAMILY: Readonly<Record<MinecraftLoader, LoaderFamily>> = {
  vanilla: 'vanilla',
  paper: 'plugin',
  purpur: 'plugin',
  spigot: 'plugin',
  folia: 'plugin',
  fabric: 'mod',
  forge: 'mod',
  neoforge: 'mod',
  quilt: 'mod',
};

/** Human labels, used in the UI and in MCP tool output. */
export const LOADER_LABELS: Readonly<Record<MinecraftLoader, string>> = {
  vanilla: 'Vanilla',
  paper: 'Paper',
  purpur: 'Purpur',
  spigot: 'Spigot',
  folia: 'Folia',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  quilt: 'Quilt',
};

/**
 * Which loaders' content a server can actually load.
 *
 * Purpur is a Paper fork and Folia is a Paper fork, so both accept anything published for
 * "paper" or the older "spigot"/"bukkit" targets. Quilt is deliberately Fabric-compatible and
 * loads Fabric mods unchanged. NeoForge forked from Forge at 1.20.1 and is *not* binary
 * compatible after that point, so it does not inherit Forge — the version-aware check in
 * `packages/mods` handles the 1.20.1 special case rather than baking it in here.
 */
export const LOADER_ACCEPTS: Readonly<Record<MinecraftLoader, readonly string[]>> = {
  vanilla: [],
  paper: ['paper', 'spigot', 'bukkit'],
  purpur: ['purpur', 'paper', 'spigot', 'bukkit'],
  spigot: ['spigot', 'bukkit'],
  folia: ['folia', 'paper', 'spigot', 'bukkit'],
  fabric: ['fabric'],
  quilt: ['quilt', 'fabric'],
  forge: ['forge'],
  neoforge: ['neoforge'],
};

/* -------------------------------------------------------------------------- */
/* Server configuration                                                        */
/* -------------------------------------------------------------------------- */

export const difficultySchema = z.enum(['peaceful', 'easy', 'normal', 'hard']);
export const gameModeSchema = z.enum(['survival', 'creative', 'adventure', 'spectator']);

/**
 * The knobs Platter surfaces. Everything here maps to a `server.properties` key or an itzg env
 * var; anything not modelled can still be set via `extraEnv` / `extraProperties`, which are
 * passed through untouched.
 */
export const serverSettingsSchema = z.object({
  motd: z.string().max(128).default('A Platter server'),
  difficulty: difficultySchema.default('normal'),
  gameMode: gameModeSchema.default('survival'),
  maxPlayers: z.number().int().min(1).max(1000).default(20),
  onlineMode: z.boolean().default(true),
  pvp: z.boolean().default(true),
  allowFlight: z.boolean().default(false),
  hardcore: z.boolean().default(false),
  enableCommandBlock: z.boolean().default(false),
  spawnProtection: z.number().int().min(0).max(256).default(16),
  viewDistance: z.number().int().min(3).max(32).default(10),
  simulationDistance: z.number().int().min(3).max(32).default(10),
  levelName: z.string().min(1).max(64).default('world'),
  levelSeed: z.string().max(128).optional(),
  levelType: z.string().max(64).optional(),
  whitelistEnabled: z.boolean().default(false),
  whitelist: z.array(z.string().min(1).max(32)).default([]),
  ops: z.array(z.string().min(1).max(32)).default([]),
  enforceSecureProfile: z.boolean().default(true),
  /**
   * Passed straight into the container. Escape hatch for anything Platter does not model.
   *
   * Keys are constrained to the conventional shape because the container API is `KEY=VALUE`
   * strings split on the *first* `=`. An unconstrained key of `LOAD_ENV_FROM_FILE=/data/x.env`
   * is not on the denylist as written, but Docker parses it as exactly the variable the denylist
   * exists to block — with the trailing `=` swallowed into the value. Constraining the key makes
   * the denylist check the same string Docker will.
   */
  extraEnv: z
    .record(
      z
        .string()
        .regex(
          /^[A-Za-z_][A-Za-z0-9_]*$/,
          'Environment variable names may contain only letters, digits and underscores.'
        ),
      z.string().refine((value) => !value.includes('\u0000'), 'Value contains a NUL byte.')
    )
    .default({}),
  /**
   * Merged into server.properties after Platter's own mapping. Wins on conflict.
   *
   * Newlines are rejected in both key and value: the whole map is joined with `\n` into one
   * environment variable, so a value containing a newline injects arbitrary further properties.
   * `motd=hi\nrcon.password=hunter2` is the one that matters — it desynchronises the game's RCON
   * password from the one in Platter's database, which breaks Platter's own control channel and
   * leaves the RCON port answering to a password somebody else chose.
   */
  extraProperties: z
    .record(
      z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Invalid server.properties key.'),
      z.string().refine(
        // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point.
        (value) => !/[\r\n\u0000]/.test(value),
        'server.properties values must be a single line.'
      )
    )
    .default({}),
});

export type ServerSettings = z.infer<typeof serverSettingsSchema>;

/**
 * Resource limits. These are not optional — an unbounded container is how a modded server
 * takes down the machine Platter is running on.
 */
export const resourceLimitsSchema = z.object({
  /** JVM + container memory ceiling, MiB. The JVM heap is derived from this, not equal to it. */
  memoryMiB: z.number().int().min(512).max(262_144).default(4096),
  /** Fractional CPUs. 2 means "up to two cores' worth". */
  cpus: z.number().min(0.25).max(128).default(2),
  /** Guards against fork bombs and thread leaks in badly behaved mods. */
  pidsLimit: z.number().int().min(64).max(16_384).default(512),
});

export type ResourceLimits = z.infer<typeof resourceLimitsSchema>;

export const restartPolicySchema = z.enum(['no', 'on-failure', 'always', 'unless-stopped']);
export type RestartPolicy = z.infer<typeof restartPolicySchema>;

/* -------------------------------------------------------------------------- */
/* Mods                                                                        */
/* -------------------------------------------------------------------------- */

export const modProviderSchema = z.enum(['modrinth', 'curseforge', 'manual']);
export type ModProvider = z.infer<typeof modProviderSchema>;

/** Where a file ends up inside /data. Plugins and mods are not interchangeable. */
export const modKindSchema = z.enum([
  'mod',
  'plugin',
  'datapack',
  'resourcepack',
  'shader',
  'modpack',
]);
export type ModKind = z.infer<typeof modKindSchema>;

export const modSideSchema = z.enum(['required', 'optional', 'unsupported', 'unknown']);
export type ModSide = z.infer<typeof modSideSchema>;

export const modInstallStatusSchema = z.enum([
  'proposed',
  'pending',
  'downloading',
  'installed',
  'failed',
  'disabled',
  'removed',
]);
export type ModInstallStatus = z.infer<typeof modInstallStatusSchema>;

export const dependencyKindSchema = z.enum([
  'required',
  'optional',
  'incompatible',
  'embedded',
  'tool',
]);
export type DependencyKind = z.infer<typeof dependencyKindSchema>;

/* -------------------------------------------------------------------------- */
/* Events / audit                                                              */
/* -------------------------------------------------------------------------- */

export const eventLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type EventLevel = z.infer<typeof eventLevelSchema>;

/** Who caused a thing to happen. AI actions are always attributable. */
export const actorSchema = z.enum(['user', 'ai', 'system', 'schedule']);
export type Actor = z.infer<typeof actorSchema>;

/* -------------------------------------------------------------------------- */
/* Backups                                                                     */
/* -------------------------------------------------------------------------- */

export const backupStatusSchema = z.enum(['pending', 'running', 'complete', 'failed', 'restoring']);
export type BackupStatus = z.infer<typeof backupStatusSchema>;

export const backupTriggerSchema = z.enum(['manual', 'schedule', 'pre-change', 'pre-restore']);
export type BackupTrigger = z.infer<typeof backupTriggerSchema>;
