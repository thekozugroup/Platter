/**
 * Labels Platter stamps on every Docker resource it owns.
 *
 * These are load-bearing, not decorative. `packages/core/src/docker/guard.ts` refuses to stop,
 * remove or otherwise mutate any container or volume that does not carry `platter.managed`,
 * which is what stops a bug in Platter from reaping the user's unrelated containers.
 */
export const LABELS = {
  managed: 'platter.managed',
  serverId: 'platter.server.id',
  serverSlug: 'platter.server.slug',
  game: 'platter.game',
  loader: 'platter.loader',
  gameVersion: 'platter.game.version',
  createdAt: 'platter.created_at',
  /** Schema version of the container's configuration, for future migrations. */
  revision: 'platter.revision',
} as const;

export const MANAGED_LABEL_VALUE = 'true';

/** Docker label selector for "everything Platter owns". */
export const MANAGED_FILTER = `${LABELS.managed}=${MANAGED_LABEL_VALUE}`;

/* -------------------------------------------------------------------------- */
/* Container naming                                                            */
/* -------------------------------------------------------------------------- */

export const CONTAINER_PREFIX = 'platter';

/**
 * `platter-<slug>-<short id>`.
 *
 * The slug alone is not enough — two servers may be renamed into a collision, and Docker names
 * are a global namespace. The 8-character ULID tail makes the name unique while keeping
 * `docker ps` readable, which matters the first time someone debugs this outside the UI.
 */
export const containerName = (slug: string, serverId: string): string =>
  `${CONTAINER_PREFIX}-${slug}-${serverId.slice(-8).toLowerCase()}`;

export const backupContainerName = (slug: string, serverId: string): string =>
  `${containerName(slug, serverId)}-backup`;

/* -------------------------------------------------------------------------- */
/* Host layout                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Everything lives under PLATTER_DATA_DIR:
 *
 *   platter.db              SQLite database (WAL mode)
 *   mcp-token               generated bearer token for the MCP HTTP transport
 *   servers/<id>/data       bind-mounted to /data in the container
 *   servers/<id>/backups    tar.zst archives for that server
 *   cache/mods              content-addressed downloaded mod jars, shared across servers
 *   tmp                     staging area for downloads and restores
 *
 * Bind mounts rather than named volumes: someone should be able to open their world folder in a
 * file browser, drop a datapack in, and copy a backup off the machine without learning
 * `docker volume inspect`. That is worth more than the marginal portability of named volumes.
 */
export const paths = {
  db: (root: string) => `${root}/platter.db`,
  mcpToken: (root: string) => `${root}/mcp-token`,
  servers: (root: string) => `${root}/servers`,
  serverRoot: (root: string, serverId: string) => `${root}/servers/${serverId}`,
  serverData: (root: string, serverId: string) => `${root}/servers/${serverId}/data`,
  serverBackups: (root: string, serverId: string) => `${root}/servers/${serverId}/backups`,
  modCache: (root: string) => `${root}/cache/mods`,
  tmp: (root: string) => `${root}/tmp`,
} as const;

/** Path inside the container that the server's data directory is mounted at. */
export const CONTAINER_DATA_DIR = '/data';

/** Sub-paths within /data, per the itzg image's layout. */
export const CONTAINER_PATHS = {
  mods: '/data/mods',
  plugins: '/data/plugins',
  config: '/data/config',
  world: '/data/world',
  logs: '/data/logs',
  crashReports: '/data/crash-reports',
  serverProperties: '/data/server.properties',
  eula: '/data/eula.txt',
  whitelist: '/data/whitelist.json',
  ops: '/data/ops.json',
} as const;

/* -------------------------------------------------------------------------- */
/* Networking                                                                  */
/* -------------------------------------------------------------------------- */

/** Ports inside the container. Host ports are allocated dynamically. */
export const CONTAINER_PORTS = {
  game: 25_565,
  rcon: 25_575,
  /** Some setups expose a separate query port; itzg maps it to the game port by default. */
  query: 25_565,
} as const;

/* -------------------------------------------------------------------------- */
/* Timing                                                                      */
/* -------------------------------------------------------------------------- */

export const TIMEOUTS = {
  /** Docker API calls that should be instant. */
  dockerFast: 10_000,
  /** Image pulls. Modded images and modpack installs are genuinely slow. */
  imagePull: 900_000,
  /**
   * Grace period for `docker stop`. Minecraft flushes chunks on shutdown; killing it early is
   * the single most reliable way to corrupt a world, so this is generous on purpose.
   */
  gracefulStop: 120_000,
  rconConnect: 5000,
  rconCommand: 15_000,
  /** How long a server may sit in `starting` before Platter calls it stuck. */
  startupBudget: 900_000,
  statusPing: 3000,
} as const;

/* -------------------------------------------------------------------------- */
/* Minecraft                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Java version Platter uses when it cannot determine the Minecraft version.
 * See `requiredJavaVersion()` in `./versions.ts` for the per-version rules — the mapping lives
 * there because calendar versioning makes it a function, not a table.
 */
export const DEFAULT_JAVA_VERSION = 25;

/**
 * Image tag per Java major version.
 *
 * Every entry is a tag itzg actually publishes — including `java16`, which the image's own docs
 * describe as being there for Paper 1.16.5 specifically, and `java25`, which is what `latest`
 * points at because it tracks whatever the newest Minecraft requires.
 */
export const JAVA_IMAGE_TAGS: Readonly<Record<number, string>> = {
  8: 'java8',
  11: 'java11',
  16: 'java16',
  17: 'java17',
  21: 'java21',
  25: 'java25',
};

export const MINECRAFT_IMAGE = 'itzg/minecraft-server';
export const BACKUP_IMAGE = 'itzg/mc-backup';

/**
 * Heap sizing. The container limit is not the heap: the JVM also needs metaspace, code cache,
 * GC structures, direct buffers and thread stacks, and Netty in particular allocates off-heap
 * per connection. Handing the whole limit to -Xmx is how a container gets OOM-killed by the
 * kernel with nothing useful in the log.
 */
export const HEAP_HEADROOM_RATIO = 0.8;
export const HEAP_HEADROOM_MIN_MiB = 512;
export const HEAP_HEADROOM_MAX_MiB = 2048;

export function heapForContainer(memoryMiB: number): number {
  const headroom = Math.min(
    HEAP_HEADROOM_MAX_MiB,
    Math.max(HEAP_HEADROOM_MIN_MiB, Math.round(memoryMiB * (1 - HEAP_HEADROOM_RATIO)))
  );
  return Math.max(512, memoryMiB - headroom);
}
