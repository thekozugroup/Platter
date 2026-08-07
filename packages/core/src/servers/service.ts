import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { schedules, servers } from '@platter/db';
import {
  containerName,
  fail,
  rconPassword as generateRconPassword,
  LABELS,
  LOADER_FAMILY,
  LOADER_LABELS,
  logger,
  type MinecraftLoader,
  ok,
  paths,
  type ResourceLimits,
  type RestartPolicy,
  type Result,
  type ServerSettings,
  serverSettingsSchema,
  slugify,
  TIMEOUTS,
  TRANSITIONAL_STATUSES,
  ulid,
} from '@platter/shared';
import { eq } from 'drizzle-orm';
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
import { availableLoaders, getVersionIndex } from '../minecraft/catalog';
import { buildContainerEnv } from '../minecraft/env';
import { selectImage } from '../minecraft/manifest';
import { findFreePorts, isPortConflict, releaseServerPorts, reservePorts } from '../ports';
import { closeRcon, rconCommand } from '../rcon';
import { getServer, hydrate, type Server, setStatus, updateServer } from './repository';

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

  /*
   * Reject a loader/version pair that has no builds, here rather than only in the picker.
   *
   * `availableLoaders` was previously consulted by the new-server page alone, so every other
   * entry point — the MCP `create_server` flow, a direct API call, a restored config — could ask
   * for Folia on 1.12.2 and get a container that fails minutes in on a download 404. A rule that
   * one caller enforces is a rule the other callers do not have.
   */
  const index = await getVersionIndex(ctx.db);
  const loaders = availableLoaders(input.gameVersion, index);
  if (!loaders.includes(input.loader)) {
    return fail(
      'invalid_input',
      `${LOADER_LABELS[input.loader]} has no builds for Minecraft ${input.gameVersion}. ` +
        `Available for that version: ${loaders.map((l) => LOADER_LABELS[l]).join(', ')}.`,
      { details: { loader: input.loader, gameVersion: input.gameVersion, available: loaders } }
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

  /* --- Ports and row ----------------------------------------------------- */
  //
  // These commit together. `port_allocations.server_id` has a foreign key to `servers.id`, so
  // the ledger rows cannot exist before the server row — and the server row cannot exist before
  // the ports, because it stores them. One transaction resolves the circularity, and it also
  // makes the whole reservation atomic: a crash mid-create leaves neither a phantom server nor
  // a leaked port.
  //
  // Probing is async and better-sqlite3 transactions must be synchronous, so candidates are
  // found first and only then committed. If another process wins a port in that window the
  // UNIQUE constraint rejects the commit and we retry with fresh candidates.
  const range = {
    start: ctx.env.PLATTER_PORT_RANGE_START,
    end: ctx.env.PLATTER_PORT_RANGE_END,
  };
  const image = selectImage(input.loader, input.gameVersion, ctx.env.PLATTER_MINECRAFT_IMAGE_REPO);
  const password = generateRconPassword();

  let gamePort = 0;
  let rconPort = 0;
  let committed = false;
  const attempted = new Set<number>();

  for (let attempt = 0; attempt < 3 && !committed; attempt++) {
    const ports = await findFreePorts(ctx.db, {
      range,
      count: 2,
      exclude: [...attempted],
    });
    if (!ports.ok) {
      return ports;
    }
    [gamePort = 0, rconPort = 0] = ports.value;

    try {
      ctx.db.$sqlite.transaction(() => {
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
            port: gamePort,
            rconPort,
            rconPassword: password,
            memoryMiB,
            cpus: Math.round(cpus * 1000),
            pidsLimit,
            restartPolicy: input.restartPolicy ?? 'unless-stopped',
            settings,
            dataDir,
          })
          .run();

        reservePorts(ctx.db, id, [
          { port: gamePort, purpose: 'game' },
          { port: rconPort, purpose: 'rcon' },
        ]);
      })();
      committed = true;
    } catch (cause) {
      if (!isPortConflict(cause)) {
        return fail('internal', `Could not create the server record: ${String(cause)}`, { cause });
      }
      log.debug('lost a port race, retrying', { gamePort, rconPort });
      attempted.add(gamePort);
      attempted.add(rconPort);
    }
  }

  if (!committed) {
    return fail(
      'port_unavailable',
      'Could not reserve ports — another process kept taking them. Try again.'
    );
  }

  rollback.push(() => {
    // Deleting the server cascades to its port allocations.
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
  rollback.push(() =>
    rm(paths.serverRoot(ctx.env.PLATTER_DATA_DIR, id), { recursive: true, force: true })
  );

  /* --- Image ------------------------------------------------------------- */
  input.onProgress?.({ phase: 'pulling', detail: image.image });
  setStatus(ctx.db, id, 'installing', `Pulling ${image.image}`);

  const pulled = await ensureImage(ctx.docker, image.image, {
    allowCustom: ctx.env.PLATTER_ALLOW_CUSTOM_IMAGES,
    allowedRepos: [ctx.env.PLATTER_MINECRAFT_IMAGE_REPO, ctx.env.PLATTER_BACKUP_IMAGE_REPO],
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
    gamePort,
    rconPort,
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
    ctx.db
      .select({ slug: servers.slug })
      .from(servers)
      .all()
      .map((row) => row.slug)
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

  // Retire the server's schedules and rebuild the cron table. Without this the nightly backup
  // job stays live for the lifetime of the process, and — for a soft delete, where the rows do
  // not cascade — keeps writing archives every night for a server the user believes is gone.
  ctx.db.delete(schedules).where(eq(schedules.serverId, serverId)).run();
  const { syncSchedules } = await import('../supervisor');
  syncSchedules(ctx);

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
 * Reduce a user- or AI-supplied command to exactly one console command, or refuse.
 *
 * A newline is a command separator: the stdin fallback writes the string followed by `\n`, and
 * Minecraft's console reads one command per line. So `"list\nop mallory\nstop"` is three
 * commands wearing one command's clothes — and every gate upstream inspects only the first
 * token. The MCP layer's confirmation prompt sees `list`, decides it is read-only, and never
 * asks the human; the activity feed records one entry; three commands run.
 *
 * Rejecting rather than truncating, because a caller that sent a newline either meant something
 * Platter is not going to do or has a bug, and silently running the first third of their input
 * is not a kindness. The check lives in core rather than in the MCP tool because the web action
 * shares this path — a validation that only one caller performs is a validation.
 *
 * Other control characters go too: `\r` is a line terminator to some consoles, and NUL and the
 * escape byte are how you forge convincing lines in a log the operator later reads for evidence.
 */
export function normaliseCommand(command: string): Result<string> {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
  if (/[\u0000-\u001f\u007f]/.test(command.replace(/^\s+|\s+$/g, ''))) {
    return fail(
      'invalid_input',
      'A console command must be a single line. Send one command per call — Minecraft reads ' +
        'each line as its own command, so a newline here would run commands nobody approved.'
    );
  }
  const trimmed = command.trim().replace(/^\//, '').trim();
  if (trimmed.length === 0) {
    return fail('invalid_input', 'Command is empty.');
  }
  return ok(trimmed);
}

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

  const normalised = normaliseCommand(command);
  if (!normalised.ok) {
    return normalised;
  }
  const trimmed = normalised.value;

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
  const live = await applyLiveSettings(server, patch);

  return ok({
    settings: parsed.data,
    restartRequired: changedKeys.some((key) => !live.has(key)) && server.status === 'running',
  });
}

/** Settings that can be changed on a running server over RCON. */
async function applyLiveSettings(
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

  const image = selectImage(
    server.loader,
    server.gameVersion,
    ctx.env.PLATTER_MINECRAFT_IMAGE_REPO
  );
  const pulled = await ensureImage(ctx.docker, image.image, {
    allowCustom: ctx.env.PLATTER_ALLOW_CUSTOM_IMAGES,
    allowedRepos: [ctx.env.PLATTER_MINECRAFT_IMAGE_REPO, ctx.env.PLATTER_BACKUP_IMAGE_REPO],
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
