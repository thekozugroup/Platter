import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { servers } from '@platter/db';
import {
  LABELS,
  LOADER_FAMILY,
  type MinecraftLoader,
  type ResourceLimits,
  type RestartPolicy,
  type ServerSettings,
  TIMEOUTS,
  TRANSITIONAL_STATUSES,
  type Result,
  containerName,
  fail,
  logger,
  ok,
  paths,
  rconPassword as generateRconPassword,
  serverSettingsSchema,
  slugify,
  ulid,
} from '@platter/shared';
import type { Context } from '../context';
import {
  createContainer,
  removeContainer,
  restartContainer,
  startContainer,
  stopContainer,
  writeToStdin,
} from '../docker/containers';
import { findByServerId, inspectContainer } from '../docker/guard';
import { ensureImage, type PullProgress } from '../docker/images';
import { EVENT, emitEvent } from '../events';
import { buildContainerEnv } from '../minecraft/env';
import { selectImage } from '../minecraft/manifest';
import { allocatePort, releaseServerPorts } from '../ports';
import { closeRcon, rconCommand } from '../rcon';
import { getServer, hydrate, setStatus, type Server, updateServer } from './repository';

const log = logger.child('servers');

export interface CreateServerInput {
  name: string;
  loader: MinecraftLoader;
  gameVersion: string;
  loaderVersion?: string | undefined;
  settings?: Partial<ServerSettings>;
  resources?: Partial<ResourceLimits>;
  restartPolicy?: RestartPolicy;
  /** The user must have accepted Mojang's EULA. Platter refuses to proceed otherwise. */
  acceptEula: boolean;
  actor?: 'user' | 'ai';
  onProgress?: (progress: { phase: string; detail?: string; pull?: PullProgress }) => void;
}

/**
 * Create a server.
 *
 * Ordered so that the cheap, reversible steps happen first and the expensive, side-effecting
 * ones happen last. If anything fails partway, `rollback` undoes exactly what succeeded — the
 * "server stuck installing" state that is a perennial top support topic for Pterodactyl is
 * almost always a create path with no rollback.
 */
export async function createServer(
  ctx: Context,
  input: CreateServerInput
): Promise<Result<Server>> {
  if (!input.acceptEula) {
    return fail(
      'invalid_input',
      'Minecraft servers require accepting the Mojang EULA ' +
        '(https://aka.ms/MinecraftEULA). Pass acceptEula: true to confirm.'
    );
  }

  const settings = serverSettingsSchema.parse(input.settings ?? {});
  const memoryMiB = input.resources?.memoryMiB ?? 4096;
  const cpus = input.resources?.cpus ?? 2;
  const pidsLimit = input.resources?.pidsLimit ?? 512;

  const id = ulid();
  const slug = uniqueSlug(ctx, input.name);
  const dataDir = paths.serverData(ctx.env.PLATTER_DATA_DIR, id);
  const rollback: (() => Promise<void> | void)[] = [];

  const abort = async (error: Result<never>): Promise<Result<never>> => {
    for (const undo of rollback.reverse()) {
      try {
        await undo();
      } catch (cause) {
        log.warn('rollback step failed', { serverId: id, error: String(cause) });
      }
    }
    return error;
  };

  /* --- Ports ------------------------------------------------------------- */
  const range = {
    start: ctx.env.PLATTER_PORT_RANGE_START,
    end: ctx.env.PLATTER_PORT_RANGE_END,
  };
  const gamePort = await allocatePort(ctx.db, { serverId: id, purpose: 'game', range });
  if (!gamePort.ok) {
    return gamePort;
  }
  rollback.push(() => releaseServerPorts(ctx.db, id));

  const rconPort = await allocatePort(ctx.db, { serverId: id, purpose: 'rcon', range });
  if (!rconPort.ok) {
    return abort(rconPort);
  }

  /* --- Row --------------------------------------------------------------- */
  const image = selectImage(input.loader, input.gameVersion);
  const password = generateRconPassword();

  ctx.db
    .insert(servers)
    .values({
      id,
      name: input.name.trim(),
      slug,
      game: 'minecraft',
      loader: input.loader,
      gameVersion: input.gameVersion,
      loaderVersion: input.loaderVersion ?? null,
      image: image.image,
      status: 'creating',
      port: gamePort.value,
      rconPort: rconPort.value,
      rconPassword: password,
      memoryMiB,
      cpus: Math.round(cpus * 1000),
      pidsLimit,
      restartPolicy: input.restartPolicy ?? 'unless-stopped',
      settings,
      dataDir,
    })
    .run();
  rollback.push(() => {
    ctx.db.delete(servers).where(eq(servers.id, id)).run();
  });

  emitEvent(ctx.db, {
    serverId: id,
    type: EVENT.serverCreated,
    message: `Created ${input.name} (${input.loader} ${input.gameVersion})`,
    actor: input.actor ?? 'user',
    data: { loader: input.loader, gameVersion: input.gameVersion, javaVersion: image.javaVersion },
  });

  /* --- Filesystem -------------------------------------------------------- */
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(paths.serverBackups(ctx.env.PLATTER_DATA_DIR, id), { recursive: true });
  rollback.push(() => rm(paths.serverRoot(ctx.env.PLATTER_DATA_DIR, id), { recursive: true, force: true }));

  /* --- Image ------------------------------------------------------------- */
  input.onProgress?.({ phase: 'pulling', detail: image.image });
  setStatus(ctx.db, id, 'installing', `Pulling ${image.image}`);

  const pulled = await ensureImage(ctx.docker, image.image, {
    allowCustom: ctx.env.PLATTER_ALLOW_CUSTOM_IMAGES,
    ...(input.onProgress
      ? { onProgress: (pull: PullProgress) => input.onProgress?.({ phase: 'pulling', pull }) }
      : {}),
  });
  if (!pulled.ok) {
    setStatus(ctx.db, id, 'error', pulled.error.message);
    return abort(pulled);
  }

  /* --- Container --------------------------------------------------------- */
  input.onProgress?.({ phase: 'creating container' });

  const env = buildContainerEnv({
    loader: input.loader,
    gameVersion: input.gameVersion,
    loaderVersion: input.loaderVersion,
    settings,
    memoryMiB,
    rconPassword: password,
  });

  const created = await createContainer(ctx.docker, {
    name: containerName(slug, id),
    image: image.image,
    env,
    labels: {
      [LABELS.serverId]: id,
      [LABELS.serverSlug]: slug,
      [LABELS.game]: 'minecraft',
      [LABELS.loader]: input.loader,
      [LABELS.gameVersion]: input.gameVersion,
      [LABELS.createdAt]: new Date().toISOString(),
      [LABELS.revision]: '1',
    },
    dataDir,
    network: ctx.env.PLATTER_DOCKER_NETWORK,
    gamePort: gamePort.value,
    rconPort: rconPort.value,
    bindAddress: ctx.env.PLATTER_BIND_ADDRESS,
    memoryMiB,
    cpus,
    pidsLimit,
    restartPolicy: input.restartPolicy ?? 'unless-stopped',
  });

  if (!created.ok) {
    setStatus(ctx.db, id, 'error', created.error.message);
    return abort(created);
  }

  updateServer(ctx.db, id, { containerId: created.value, status: 'stopped' });

  const server = getServer(ctx.db, id);
  if (!server) {
    return abort(fail('internal', 'Server row vanished immediately after creation.'));
  }
  return ok(server);
}

/** Ensure the slug is unique, since it appears in the container name and on disk. */
function uniqueSlug(ctx: Context, name: string): string {
  const base = slugify(name);
  const taken = new Set(
    ctx.db.select({ slug: servers.slug }).from(servers).all().map((row) => row.slug)
  );
  if (!taken.has(base)) {
    return base;
  }
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`.slice(0, 32).replace(/-+$/, '');
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  return `${base}-${ulid().slice(-6).toLowerCase()}`;
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

function guardTransition(server: Server): Result<void> {
  if (TRANSITIONAL_STATUSES.has(server.status)) {
    return fail(
      'invalid_state',
      `${server.name} is currently ${server.status}. Wait for that to finish first.`,
      { details: { serverId: server.id, status: server.status } }
    );
  }
  return ok(undefined);
}

export async function startServer(
  ctx: Context,
  serverId: string,
  options: { actor?: 'user' | 'ai' | 'schedule' } = {}
): Promise<Result<void>> {
  const server = getServer(ctx.db, serverId);
  if (!server) {
    return fail('not_found', `No server with id ${serverId}.`);
  }
  if (server.status === 'running') {
    return ok(undefined);
  }
  const guard = guardTransition(server);
  if (!guard.ok) {
    return guard;
  }
  if (!server.containerId) {
    return fail('invalid_state', `${server.name} has no container. Recreate it.`);
  }

  setStatus(ctx.db, serverId, 'starting');
  emitEvent(ctx.db, {
    serverId,
    type: EVENT.serverStarting,
    message: `Starting ${server.name}`,
    actor: options.actor ?? 'user',
  });

  const started = await startContainer(ctx.docker, server.containerId);
  if (!started.ok) {
    setStatus(ctx.db, serverId, 'error', started.error.message);
    emitEvent(ctx.db, {
      serverId,
      type: EVENT.serverCrashed,
      level: 'error',
      message: `Could not start ${server.name}: ${started.error.message}`,
      actor: 'system',
    });
    return started;
  }

  // The supervisor promotes `starting` to `running` once the health check passes. Doing it here
  // would report "running" while the world is still generating, and the first thing a user does
  // with that status is try to connect — and fail.
  return ok(undefined);
}

export async function stopServer(
  ctx: Context,
  serverId: string,
  options: { actor?: 'user' | 'ai' | 'schedule'; timeoutMs?: number } = {}
): Promise<Result<void>> {
  const server = getServer(ctx.db, serverId);
  if (!server) {
    return fail('not_found', `No server with id ${serverId}.`);
  }
  if (server.status === 'stopped') {
    return ok(undefined);
  }
  if (!server.containerId) {
    setStatus(ctx.db, serverId, 'stopped');
    return ok(undefined);
  }

  setStatus(ctx.db, serverId, 'stopping');
  emitEvent(ctx.db, {
    serverId,
    type: EVENT.serverStopping,
    message: `Stopping ${server.name}`,
    actor: options.actor ?? 'user',
  });

  // Give players a heads-up when anyone is online. Best effort: a server that is already
  // wedged will not answer RCON, and that must not block the stop.
  await rconCommand(
    { serverId, host: '127.0.0.1', port: server.rconPort ?? 0, password: server.rconPassword },
    'say Server shutting down in 10 seconds'
  ).catch(() => undefined);

  await closeRcon(serverId);

  const stopped = await stopContainer(
    ctx.docker,
    server.containerId,
    options.timeoutMs ?? TIMEOUTS.gracefulStop
  );
  if (!stopped.ok) {
    setStatus(ctx.db, serverId, 'error', stopped.error.message);
    return stopped;
  }

  setStatus(ctx.db, serverId, 'stopped');
  emitEvent(ctx.db, {
    serverId,
    type: EVENT.serverStopped,
    message: `Stopped ${server.name}`,
    actor: options.actor ?? 'user',
  });
  return ok(undefined);
}

export async function restartServer(
  ctx: Context,
  serverId: string,
  options: { actor?: 'user' | 'ai' | 'schedule' } = {}
): Promise<Result<void>> {
  const server = getServer(ctx.db, serverId);
  if (!server) {
    return fail('not_found', `No server with id ${serverId}.`);
  }
  if (!server.containerId) {
    return fail('invalid_state', `${server.name} has no container.`);
  }

  setStatus(ctx.db, serverId, 'starting');
  await closeRcon(serverId);

  const restarted = await restartContainer(ctx.docker, server.containerId);
  if (!restarted.ok) {
    setStatus(ctx.db, serverId, 'error', restarted.error.message);
    return restarted;
  }

  emitEvent(ctx.db, {
    serverId,
    type: EVENT.serverStarting,
    message: `Restarting ${server.name}`,
    actor: options.actor ?? 'user',
  });
  return ok(undefined);
}

export interface DeleteServerOptions {
  /** Also delete world data and backups. Without this, only the container is removed. */
  purgeData?: boolean;
  actor?: 'user' | 'ai';
}

export async function deleteServer(
  ctx: Context,
  serverId: string,
  options: DeleteServerOptions = {}
): Promise<Result<void>> {
  const server = getServer(ctx.db, serverId);
  if (!server) {
    return fail('not_found', `No server with id ${serverId}.`);
  }

  setStatus(ctx.db, serverId, 'deleting');
  await closeRcon(serverId);

  if (server.containerId) {
    const stopped = await stopContainer(ctx.docker, server.containerId);
    if (!stopped.ok && stopped.error.code !== 'container_not_found') {
      log.warn('graceful stop failed during delete; forcing', {
        serverId,
        error: stopped.error.message,
      });
    }
    const removed = await removeContainer(ctx.docker, server.containerId, { force: true });
    if (!removed.ok && removed.error.code !== 'container_not_found') {
      setStatus(ctx.db, serverId, 'error', removed.error.message);
      return removed;
    }
  }

  releaseServerPorts(ctx.db, serverId);

  if (options.purgeData) {
    // Only ever removes a path Platter itself built from PLATTER_DATA_DIR plus the server's
    // ULID — never a path derived from user input.
    await rm(paths.serverRoot(ctx.env.PLATTER_DATA_DIR, serverId), {
      recursive: true,
      force: true,
    });
    ctx.db.delete(servers).where(eq(servers.id, serverId)).run();
  } else {
    updateServer(ctx.db, serverId, {
      deletedAt: Date.now(),
      containerId: null,
      status: 'stopped',
    });
  }

  emitEvent(ctx.db, {
    serverId: options.purgeData ? null : serverId,
    type: EVENT.serverDeleted,
    message: `Deleted ${server.name}${options.purgeData ? ' and its data' : ''}`,
    actor: options.actor ?? 'user',
    data: { purgeData: options.purgeData ?? false, name: server.name },
  });

  return ok(undefined);
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Run a console command.
 *
 * RCON first, because it gives structured request/response. Falling back to stdin covers the
 * window during startup before the RCON listener binds, and the case where a mod has broken
 * RCON — but stdin gives no response text, so the caller is told that explicitly rather than
 * receiving an empty string that looks like a successful no-op.
 */
export async function sendCommand(
  ctx: Context,
  serverId: string,
  command: string,
  options: { actor?: 'user' | 'ai' | 'schedule' } = {}
): Promise<Result<{ response: string; channel: 'rcon' | 'stdin' }>> {
  const server = getServer(ctx.db, serverId);
  if (!server) {
    return fail('not_found', `No server with id ${serverId}.`);
  }
  if (!server.containerId) {
    return fail('invalid_state', `${server.name} has no container.`);
  }

  const trimmed = command.trim().replace(/^\//, '');
  if (trimmed.length === 0) {
    return fail('invalid_input', 'Command is empty.');
  }

  emitEvent(ctx.db, {
    serverId,
    type: EVENT.serverCommand,
    message: `Ran /${trimmed}`,
    actor: options.actor ?? 'user',
    data: { command: trimmed },
  });

  if (server.rconPort) {
    const viaRcon = await rconCommand(
      { serverId, host: '127.0.0.1', port: server.rconPort, password: server.rconPassword },
      trimmed
    );
    if (viaRcon.ok) {
      return ok({ response: viaRcon.value, channel: 'rcon' });
    }
    log.debug('RCON unavailable, falling back to stdin', { serverId, error: viaRcon.error.code });
  }

  const viaStdin = await writeToStdin(ctx.docker, server.containerId, trimmed);
  if (!viaStdin.ok) {
    return viaStdin;
  }
  return ok({
    response: 'Command sent to the console. RCON was unavailable, so there is no response text.',
    channel: 'stdin',
  });
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

export interface UpdateSettingsResult {
  settings: ServerSettings;
  /** True when the change only takes effect after a restart. */
  restartRequired: boolean;
}

/**
 * Update a server's settings.
 *
 * Most settings map to `server.properties`, which the image regenerates from environment
 * variables on start — so applying them means recreating the container, and Platter is explicit
 * that a restart is needed rather than silently pretending the change took. The exceptions are
 * the handful reachable over RCON, which are applied immediately.
 */
export async function updateSettings(
  ctx: Context,
  serverId: string,
  patch: Partial<ServerSettings>,
  options: { actor?: 'user' | 'ai' } = {}
): Promise<Result<UpdateSettingsResult>> {
  const server = getServer(ctx.db, serverId);
  if (!server) {
    return fail('not_found', `No server with id ${serverId}.`);
  }

  const parsed = serverSettingsSchema.safeParse({ ...server.settings, ...patch });
  if (!parsed.success) {
    return fail('invalid_input', 'Settings are not valid.', {
      details: { issues: parsed.error.issues },
    });
  }

  ctx.db
    .update(servers)
    .set({ settings: parsed.data, updatedAt: Date.now() })
    .where(eq(servers.id, serverId))
    .run();

  const changedKeys = Object.keys(patch);
  emitEvent(ctx.db, {
    serverId,
    type: EVENT.serverSettingsChanged,
    message: `Updated ${changedKeys.join(', ')}`,
    actor: options.actor ?? 'user',
    data: { keys: changedKeys },
  });

  // Applied live where the game supports it, so common tweaks do not require a restart.
  const live = await applyLiveSettings(ctx, server, patch);

  return ok({
    settings: parsed.data,
    restartRequired: changedKeys.some((key) => !live.has(key)) && server.status === 'running',
  });
}

/** Settings that can be changed on a running server over RCON. */
async function applyLiveSettings(
  ctx: Context,
  server: Server,
  patch: Partial<ServerSettings>
): Promise<Set<string>> {
  const applied = new Set<string>();
  if (server.status !== 'running' || !server.rconPort) {
    return applied;
  }
  const target = {
    serverId: server.id,
    host: '127.0.0.1',
    port: server.rconPort,
    password: server.rconPassword,
  };

  if (patch.difficulty) {
    const result = await rconCommand(target, `difficulty ${patch.difficulty}`);
    if (result.ok) {
      applied.add('difficulty');
    }
  }
  if (patch.gameMode) {
    const result = await rconCommand(target, `defaultgamemode ${patch.gameMode}`);
    if (result.ok) {
      applied.add('gameMode');
    }
  }
  if (patch.whitelistEnabled !== undefined) {
    const result = await rconCommand(target, `whitelist ${patch.whitelistEnabled ? 'on' : 'off'}`);
    if (result.ok) {
      applied.add('whitelistEnabled');
    }
  }
  return applied;
}

/* -------------------------------------------------------------------------- */
/* Container recreation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Rebuild the container from the current row.
 *
 * Needed after any change that lives in the container spec — memory, CPU, environment-mapped
 * settings, a Minecraft version bump. The data directory is untouched, so the world survives.
 * Ports are reused where they are still free, so anyone with the address in their launcher does
 * not have to be told a new one.
 */
export async function recreateContainer(
  ctx: Context,
  serverId: string,
  options: { start?: boolean } = {}
): Promise<Result<string>> {
  const server = getServer(ctx.db, serverId);
  if (!server) {
    return fail('not_found', `No server with id ${serverId}.`);
  }

  const wasRunning = server.status === 'running';
  if (server.containerId) {
    const stopped = await stopServer(ctx, serverId);
    if (!stopped.ok && stopped.error.code !== 'container_not_found') {
      return stopped;
    }
    const removed = await removeContainer(ctx.docker, server.containerId, { force: true });
    if (!removed.ok && removed.error.code !== 'container_not_found') {
      return removed;
    }
  }

  const image = selectImage(server.loader, server.gameVersion);
  const pulled = await ensureImage(ctx.docker, image.image, {
    allowCustom: ctx.env.PLATTER_ALLOW_CUSTOM_IMAGES,
  });
  if (!pulled.ok) {
    return pulled;
  }

  const env = buildContainerEnv({
    loader: server.loader,
    gameVersion: server.gameVersion,
    loaderVersion: server.loaderVersion,
    settings: server.settings,
    memoryMiB: server.memoryMiB,
    rconPassword: server.rconPassword,
  });

  const created = await createContainer(ctx.docker, {
    name: containerName(server.slug, server.id),
    image: image.image,
    env,
    labels: {
      [LABELS.serverId]: server.id,
      [LABELS.serverSlug]: server.slug,
      [LABELS.game]: server.game,
      [LABELS.loader]: server.loader,
      [LABELS.gameVersion]: server.gameVersion,
      [LABELS.createdAt]: new Date().toISOString(),
      [LABELS.revision]: '1',
    },
    dataDir: server.dataDir,
    network: ctx.env.PLATTER_DOCKER_NETWORK,
    gamePort: server.port,
    rconPort: server.rconPort ?? undefined,
    bindAddress: ctx.env.PLATTER_BIND_ADDRESS,
    memoryMiB: server.memoryMiB,
    cpus: server.cpus,
    pidsLimit: server.pidsLimit,
    restartPolicy: server.restartPolicy as RestartPolicy,
  });

  if (!created.ok) {
    setStatus(ctx.db, serverId, 'error', created.error.message);
    return created;
  }

  updateServer(ctx.db, serverId, {
    containerId: created.value,
    image: image.image,
    status: 'stopped',
    statusMessage: null,
  });

  if (options.start ?? wasRunning) {
    const started = await startServer(ctx, serverId);
    if (!started.ok) {
      return started;
    }
  }

  return ok(created.value);
}

/* -------------------------------------------------------------------------- */
/* Read model                                                                  */
/* -------------------------------------------------------------------------- */

export interface ServerRuntime {
  server: Server;
  containerState: string | undefined;
  health: 'starting' | 'healthy' | 'unhealthy' | 'none' | undefined;
  exitCode: number | undefined;
  contentDirectory: 'mods' | 'plugins' | null;
}

export async function describeServer(
  ctx: Context,
  serverId: string
): Promise<Result<ServerRuntime>> {
  const server = getServer(ctx.db, serverId);
  if (!server) {
    return fail('not_found', `No server with id ${serverId}.`);
  }

  const family = LOADER_FAMILY[server.loader];
  const contentDirectory = family === 'mod' ? 'mods' : family === 'plugin' ? 'plugins' : null;

  if (!server.containerId) {
    return ok({
      server,
      containerState: undefined,
      health: undefined,
      exitCode: undefined,
      contentDirectory,
    });
  }

  const container = await inspectContainer(ctx.docker, server.containerId);
  if (!container.ok) {
    return ok({
      server,
      containerState: undefined,
      health: undefined,
      exitCode: undefined,
      contentDirectory,
    });
  }

  return ok({
    server,
    containerState: container.value.state,
    health: container.value.health,
    exitCode: container.value.exitCode,
    contentDirectory,
  });
}

/** Locate a server's container even when the stored id is stale. */
export async function findContainer(ctx: Context, serverId: string) {
  const server = getServer(ctx.db, serverId);
  if (!server) {
    return undefined;
  }
  if (server.containerId) {
    const direct = await inspectContainer(ctx.docker, server.containerId);
    if (direct.ok) {
      return direct.value;
    }
  }
  const byLabel = await findByServerId(ctx.docker, serverId);
  return byLabel.ok ? byLabel.value : undefined;
}

export { hydrate };
