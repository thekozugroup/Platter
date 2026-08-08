import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Allocation, Node as NodeRow, Prisma, Server as ServerRow } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import {
  DEFAULT_STOP_TIMEOUT_SECONDS,
  LIMITS,
  PlatterError,
  SERVER_STATUSES,
  canPerformPowerAction,
  type Blueprint,
  type LogLine,
  type PowerAction,
  type ServerAllocation,
  type ServerStatus,
} from '@platter/shared';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { sleep } from '../lib/async.js';
import { serverDataDir } from '../lib/paths.js';
import { badRequest, conflict, internal, invalidState, notFound } from '../lib/errors.js';
import { DRIVER_LABELS, deriveStatus } from '../orchestration/driver.js';
import type {
  ContainerSpec,
  ContainerState,
  OrchestrationDriver,
  PortBinding,
} from '../orchestration/driver.js';
import { dropLogHub, getLogHub } from '../orchestration/log-buffer.js';
import { getDriver, getDriverForNode } from '../orchestration/registry.js';
import { reconcileBindAddresses, releasePorts } from './allocations.js';
import { buildEnvironment, getBlueprint, renderFileTemplates } from './blueprints.js';
import { advertiseServer, withdrawServer } from './network.js';
import { forgetPlayerHistory } from './players.js';
import { purgeServerProposals } from './proposals.js';

// Re-exported because callers have always imported it from here; it now lives in a leaf
// module so this file can depend on the services that clean up after a delete.
export { serverDataDir };

/**
 * The server state machine: everything that moves a `Server` row between statuses.
 *
 * Three rules hold this together, and breaking any one of them is how a control plane
 * starts lying about what is running:
 *
 * 1. **`setStatus` is the only writer.** Every transition goes through it, so every
 *    transition reaches the console socket. A status written straight to the row is a
 *    status the UI never hears about.
 * 2. **Every action is guarded by `ALLOWED_POWER_ACTIONS`**, the same table the client
 *    uses to enable its buttons — so the API and the UI can never disagree about whether
 *    an action was legal.
 * 3. **One operation per server at a time.** Provisioning, a scheduled restart and the
 *    crash supervisor all act on the same container; without serialising them, "stop" and
 *    "auto-restart" interleave and the server ends up in whichever state finished last.
 */

/** Containment for fork bombs in modded servers; matches the Docker driver's own default. */
const DEFAULT_PIDS_LIMIT = 512;

/**
 * How long a boot may go without printing the blueprint's ready line before we call it
 * running anyway. A game that is up but silent is still up, and leaving it `starting`
 * forever would disable every action the UI offers.
 */
const BOOT_TIMEOUT_MS = 5 * 60_000;

/** Crash-loop cutoff: this many crashes inside the window stops the automatic restarts. */
const CRASH_LIMIT = 3;
const CRASH_WINDOW_MS = 60_000;
const RESTART_BASE_MS = 5_000;
const RESTART_MAX_MS = 60_000;

const SUPERVISOR_INTERVAL_MS = 10_000;
const MIN_INTERVAL_MS = 1000;

/** How often a graceful stop checks whether the game has finished saving. */
const EXIT_POLL_INTERVAL_MS = 250;

/** Crash bookkeeping is per server and in memory; it cannot be allowed to grow forever. */
const MAX_CRASH_RECORDS = 500;

/** Statuses that mean "this was meant to be up when we last looked". */
const WAS_ACTIVE: readonly string[] = ['starting', 'running', 'restarting'];

/** Human words for a status, so an error reads as a sentence and still names the state. */
const STATUS_WORDS: Record<ServerStatus, string> = {
  provisioning: 'still being provisioned',
  installing: 'installing',
  install_failed: 'stuck on a failed install',
  offline: 'offline',
  starting: 'starting',
  running: 'running',
  stopping: 'stopping',
  restarting: 'restarting',
  crashed: 'crashed',
  suspended: 'suspended',
  deleting: 'being deleted',
};

const ACTION_VERBS: Record<PowerAction, string> = {
  start: 'started',
  stop: 'stopped',
  restart: 'restarted',
  kill: 'killed',
};

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let logger: FastifyBaseLogger | null = null;

/** In-flight operations, keyed by server. Also the "is this server busy" answer. */
const operations = new Map<string, Promise<void>>();

/** Cancels the run watcher armed by the last start. */
const runWatchers = new Map<string, () => void>();

interface CrashRecord {
  /** Crash times inside the rolling window, oldest first. */
  crashes: number[];
  attempts: number;
  /** When the next automatic restart becomes due; null when none is pending. */
  nextAttemptAt: number | null;
  /** Latched by the crash loop cutoff. Only a human action clears it. */
  cutoff: boolean;
  touchedAt: number;
}

const crashRecords = new Map<string, CrashRecord>();

/**
 * Installs that were killed while running. The shared table allows `kill` during an
 * install, and honouring that means the install has to notice: a pull and an image
 * extraction are not interruptible, so the check happens between steps instead.
 */
const cancelledInstalls = new Set<string>();

/**
 * Servers whose in-flight operation a kill has superseded.
 *
 * `killServer` deliberately runs outside the lock, so a restart it interrupts is still
 * sitting between its stop and its start. Without this the restart's second half brings the
 * container straight back up and the most emphatic thing a user can press loses to the
 * operation it is documented to interrupt. An entry is consumed by the operation it
 * cancels, and cleared by the next one to start, so it cannot leak forward.
 */
const cancelledOperations = new Set<string>();

let supervisor: NodeJS.Timeout | null = null;
let supervising = false;

function report(level: 'warn' | 'error', context: Record<string, unknown>, message: string): void {
  if (logger) {
    logger[level](context, message);
    return;
  }
  // Before `buildApp` hands over its logger there is still somewhere to say it, and an
  // Error serialises to `{}` through JSON without this.
  const detail = JSON.stringify(context, (_key, value: unknown) =>
    value instanceof Error ? value.message : value,
  );
  process.stderr.write(`${message}: ${detail}\n`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * Runs `fn` after whatever is already queued for this server.
 *
 * The chain is built from the map's current tail rather than by awaiting it first: two
 * callers arriving in the same tick would otherwise both see an idle server and run
 * together, which is exactly the race this exists to prevent.
 */
async function withServerLock<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
  const previous = operations.get(serverId) ?? Promise.resolve();
  // `fn` runs whether the predecessor resolved or rejected: one failed stop must not
  // wedge every later operation on that server.
  const run = previous.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  operations.set(serverId, tail);

  try {
    return await run;
  } finally {
    // Only the last link clears the entry; a queued caller behind us still needs it.
    if (operations.get(serverId) === tail) operations.delete(serverId);
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

interface LoadedServer {
  server: ServerRow;
  node: NodeRow;
  allocations: Allocation[];
  driver: OrchestrationDriver;
}

async function loadServer(serverId: string): Promise<LoadedServer> {
  const row = await prisma.server.findUnique({
    where: { id: serverId },
    include: { node: true, allocations: true },
  });
  if (!row) throw notFound('server');
  const { node, allocations, ...server } = row;
  return { server, node, allocations, driver: getDriverForNode(node) };
}

async function requireServerRow(serverId: string): Promise<ServerRow> {
  const row = await prisma.server.findUnique({ where: { id: serverId } });
  if (!row) throw notFound('server');
  return row;
}

/**
 * The stored status, ignoring suspension.
 *
 * An unrecognised value means the row outran this build; `offline` is the honest fallback,
 * because the only action it allows is a start, which reconciles.
 */
function storedStatus(row: Pick<ServerRow, 'status'>): ServerStatus {
  return (SERVER_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as ServerStatus)
    : 'offline';
}

/**
 * The status a decision should be made against.
 *
 * Deliberately a copy of `presentStatus` in `services/servers.ts` rather than an import:
 * that module imports this one, and a cycle between the state machine and the module that
 * renders it is not worth the four saved lines.
 */
function statusOf(row: Pick<ServerRow, 'status' | 'suspended'>): ServerStatus {
  return row.suspended ? 'suspended' : storedStatus(row);
}

async function loadBlueprint(server: ServerRow): Promise<Blueprint> {
  try {
    return await getBlueprint(server.blueprintKey);
  } catch (error) {
    if (error instanceof PlatterError && error.code === 'not_found') {
      throw conflict(
        `The ${server.blueprintKey} blueprint is no longer installed, so ${server.name} cannot be rebuilt.`,
      );
    }
    throw error;
  }
}

/** Stopping and deleting must keep working after a blueprint file has been removed. */
async function loadBlueprintOrNull(server: ServerRow): Promise<Blueprint | null> {
  try {
    return await getBlueprint(server.blueprintKey);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The container spec
// ---------------------------------------------------------------------------


function parseVariables(server: ServerRow): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(server.variables);
  } catch {
    report('warn', { serverId: server.id }, 'server variables column is not valid JSON');
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') values[key] = value;
  }
  return values;
}

/**
 * The container's environment.
 *
 * The blueprint service owns the composition — declared variables, hidden values it sets
 * itself, and the per-game hook that sizes things against the container's limits. Only
 * Platter's own identity is added here, because it is the one thing no blueprint can know.
 */
function buildEnv(
  server: ServerRow,
  blueprint: Blueprint,
  allocations: readonly ServerAllocation[],
): Record<string, string> {
  const env = buildEnvironment(blueprint, parseVariables(server), {
    id: server.id,
    name: server.name,
    limits: { memoryMb: server.memoryMb, cpuCores: server.cpuCores },
    allocations,
  });

  env['PLATTER_SERVER_ID'] = server.id;
  env['PLATTER_SERVER_NAME'] = server.name;
  return env;
}

function resolveInDataDir(dataDir: string, relative: string): string {
  const resolved = path.resolve(dataDir, relative);
  const prefix = path.resolve(dataDir) + path.sep;
  if (!resolved.startsWith(prefix)) {
    throw badRequest(`That blueprint writes ${relative}, which is outside the server directory.`);
  }
  return resolved;
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  );
}

/**
 * Writes the blueprint's rendered files into the data directory.
 *
 * `overwrite` is the blueprint author saying "this file is mine, re-render it every boot".
 * Without it a rendered file is a starting point that belongs to the operator from then
 * on, and silently replacing their edits on a restart would be the worst kind of surprise.
 * `force` is reinstall: the operator asked for the blueprint's version back.
 */
async function writeBlueprintFiles(
  dataDir: string,
  blueprint: Blueprint,
  values: Record<string, string>,
  options: { force?: boolean } = {},
): Promise<void> {
  for (const file of renderFileTemplates(blueprint, values)) {
    const target = resolveInDataDir(dataDir, file.path);
    if (!file.overwrite && options.force !== true && (await exists(target))) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
  }
}

/**
 * Allocation rows joined to the blueprint's port definitions. This is the shape the wire
 * uses and the shape blueprint hooks read, so the join happens once, here.
 */
function toServerAllocations(
  blueprint: Blueprint,
  allocations: readonly Allocation[],
): ServerAllocation[] {
  const declared = new Map(blueprint.ports.map((port) => [port.name, port]));
  return allocations.map((allocation) => {
    const port = allocation.portName === null ? undefined : declared.get(allocation.portName);
    return {
      name: allocation.portName ?? 'game',
      hostIp: allocation.hostIp,
      hostPort: allocation.hostPort,
      // A port the blueprint no longer declares is published straight through. It is the
      // only mapping that cannot be wrong, and it keeps an old server reachable after a
      // blueprint edit rather than silently unpublishing it.
      containerPort: port?.containerPort ?? allocation.hostPort,
      protocol: allocation.protocol === 'udp' ? 'udp' : 'tcp',
      primary: allocation.primary,
    };
  });
}

function toPortBindings(allocations: readonly ServerAllocation[]): PortBinding[] {
  return allocations.map((allocation) => ({
    hostIp: allocation.hostIp,
    hostPort: allocation.hostPort,
    containerPort: allocation.containerPort,
    protocol: allocation.protocol,
  }));
}

function buildSpec(
  loaded: LoadedServer,
  blueprint: Blueprint,
  allocations: readonly ServerAllocation[],
  env: Record<string, string>,
): ContainerSpec {
  const { server, node } = loaded;
  return {
    serverId: server.id,
    name: server.name,
    image: blueprint.image,
    command: blueprint.command,
    env,
    dataHostPath: serverDataDir(server.id),
    dataPath: blueprint.dataPath,
    ports: toPortBindings(allocations),
    limits: {
      memoryMb: server.memoryMb,
      swapMb: server.swapMb,
      cpuCores: server.cpuCores,
      ioWeight: server.ioWeight,
      pidsLimit: DEFAULT_PIDS_LIMIT,
    },
    // Set here as well as in the driver so every runtime — including the mock — can find
    // Platter's containers by label after a restart.
    labels: {
      [DRIVER_LABELS.managed]: 'true',
      [DRIVER_LABELS.serverId]: server.id,
      [DRIVER_LABELS.serverName]: server.name,
      [DRIVER_LABELS.blueprint]: blueprint.key,
      [DRIVER_LABELS.nodeId]: node.id,
    },
    interactive: blueprint.features.console,
  };
}

// ---------------------------------------------------------------------------
// The single status writer
// ---------------------------------------------------------------------------

export interface StatusUpdate {
  /** Recorded alongside the status; null clears it after a container is removed. */
  containerId?: string | null;
  exitCode?: number | null;
  startedAt?: Date | null;
  installedAt?: Date | null;
  crashedAt?: Date | null;
  /** A line in Platter's own voice, written to the console before the status frame. */
  message?: string;
}

/**
 * The only place a server's status is written.
 *
 * Everything watching a server — the console socket, the dashboard, the AI assistant —
 * learns about transitions through the log hub, so a write that bypassed this would be
 * invisible until the next poll.
 */
export async function setStatus(
  serverId: string,
  status: ServerStatus,
  update: StatusUpdate = {},
): Promise<void> {
  const data: Prisma.ServerUpdateManyMutationInput = { status };
  if (update.containerId !== undefined) data.containerId = update.containerId;
  if (update.exitCode !== undefined) data.lastExitCode = update.exitCode;
  if (update.startedAt !== undefined) data.startedAt = update.startedAt;
  if (update.installedAt !== undefined) data.installedAt = update.installedAt;
  if (update.crashedAt !== undefined) data.lastCrashAt = update.crashedAt;

  // updateMany rather than update: the supervisor can be mid-write when a delete lands,
  // and a P2025 thrown out of a timer callback is not a useful way to learn that.
  const written = await prisma.server.updateMany({ where: { id: serverId }, data });
  if (written.count === 0) return;

  const hub = getLogHub(serverId);
  if (update.message !== undefined) hub.system(update.message);
  hub.emitStatus(status, update.exitCode ?? null);

  // The run watcher exists to see a server through being up. Releasing it here is what
  // closes the driver's log stream for a server that is now stopped — the hub detaches at
  // zero listeners — so a stopped server holds nothing open on the daemon.
  if (status !== 'starting' && status !== 'running' && status !== 'restarting') {
    cancelRunWatcher(serverId);
  }

  // Discovery follows the same single writer as everything else, so there is exactly one
  // place where "is this server up" and "is its name being answered on the LAN" can
  // disagree. Advertising is deliberately not awaited: it is best-effort (it swallows its
  // own errors) and a start must not wait on a multicast socket.
  if (status === 'running') {
    void advertiseServer(serverId, logger ?? undefined);
  } else if (status !== 'starting' && status !== 'restarting') {
    withdrawServer(serverId, logger ?? undefined);
  }
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function assertAllowed(server: ServerRow, action: PowerAction): void {
  const status = statusOf(server);
  if (canPerformPowerAction(status, action)) return;
  throw invalidState(
    `${server.name} is ${STATUS_WORDS[status]}, so it cannot be ${ACTION_VERBS[action]} right now.`,
  );
}

async function actorLabel(actorId: string | null): Promise<string | null> {
  if (actorId === null) return null;
  const row = await prisma.user.findUnique({
    where: { id: actorId },
    select: { displayName: true },
  });
  return row?.displayName ?? null;
}

function withActor(message: string, who: string | null): string {
  return who === null ? message : `${message} (requested by ${who})`;
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * Prepares everything a server needs to run: the image, the data directory, the rendered
 * config files and the container itself.
 *
 * Idempotent and resumable. Every step tolerates having already happened, because the
 * interesting failure is not "the pull failed" — it is Platter being restarted halfway
 * through, leaving a data directory but no container. Re-running gets to the same end
 * state from wherever it stopped.
 */
export async function installServer(serverId: string): Promise<void> {
  await withServerLock(serverId, async () => {
    await runInstall(serverId, { force: false });
  });
}

/**
 * Re-runs the install over the existing data directory: the blueprint's files are restored
 * to their rendered form and the container is rebuilt. World data is deliberately kept —
 * "reinstall" is how an operator fixes a broken config, not how they wipe a save.
 */
export async function reinstallServer(serverId: string, actorId: string | null = null): Promise<void> {
  await withServerLock(serverId, async () => {
    const server = await requireServerRow(serverId);
    const status = statusOf(server);
    if (status === 'suspended' || status === 'deleting' || status === 'provisioning') {
      throw invalidState(`${server.name} is ${STATUS_WORDS[status]}, so it cannot be reinstalled.`);
    }

    const who = await actorLabel(actorId);
    getLogHub(serverId).system(withActor(`Reinstalling ${server.name}…`, who));

    if (WAS_ACTIVE.includes(server.status)) {
      cancelRunWatcher(serverId);
      await setStatus(serverId, 'stopping', { message: `Stopping ${server.name} for the reinstall…` });
      const exitCode = await stopInternal(serverId, {});
      await setStatus(serverId, 'offline', { exitCode, startedAt: null });
    }

    clearCrashRecord(serverId);
    await runInstall(serverId, { force: true });
  });
}

interface InstallOptions {
  /** Re-render the blueprint's files over the operator's edits. Reinstall, not first boot. */
  force: boolean;
  /** Boot afterwards regardless of `autoStart` — a human asked for this install by name. */
  startWhenDone?: boolean;
}

async function runInstall(serverId: string, options: InstallOptions): Promise<void> {
  const loaded = await loadServer(serverId);
  const { server, driver } = loaded;
  if (server.suspended) {
    throw invalidState(`${server.name} is suspended, so it cannot be installed.`);
  }

  const blueprint = await loadBlueprint(server);
  const hub = getLogHub(serverId);

  const assertNotCancelled = (): void => {
    if (!cancelledInstalls.has(serverId)) return;
    throw invalidState(`The install of ${server.name} was stopped.`);
  };

  cancelledInstalls.delete(serverId);
  cancelledOperations.delete(serverId);
  try {
    await setStatus(serverId, 'installing', { message: `Installing ${blueprint.name}…` });

    let announced = -1;
    await driver.pullImage(blueprint.image, (progress) => {
      // One line per quarter: a pull emits thousands of progress events and the console is
      // a bounded ring buffer that a human has to read.
      const percent = progress.progress === null ? null : Math.floor(progress.progress * 100);
      if (percent === null || percent < announced + 25) return;
      announced = percent;
      hub.system(`Pulling ${blueprint.image} — ${percent}%`);
    });
    assertNotCancelled();

    const dataDir = serverDataDir(serverId);
    await mkdir(dataDir, { recursive: true });
    const bound = await reconcileBindAddresses(loaded.node, blueprint.ports, loaded.allocations);
    const allocations = toServerAllocations(blueprint, bound);
    const env = buildEnv(server, blueprint, allocations);
    await writeBlueprintFiles(dataDir, blueprint, env, { force: options.force });
    assertNotCancelled();

    // recreate, not create: a container left behind by an interrupted install is replaced
    // rather than colliding with it. The data directory is a bind mount, so nothing the
    // install produced is lost by rebuilding the container around it.
    const containerId = await driver.recreate(buildSpec(loaded, blueprint, allocations, env));

    await setStatus(serverId, 'offline', {
      containerId,
      installedAt: new Date(),
      exitCode: null,
      startedAt: null,
      message: `${blueprint.name} is installed.`,
    });
  } catch (error) {
    await setStatus(serverId, 'install_failed', { message: `Install failed: ${messageOf(error)}` });
    throw error;
  } finally {
    cancelledInstalls.delete(serverId);
  }

  // The same check the restart makes: a kill during the install has already put the server
  // where the operator asked for it, and auto-start would immediately contradict them.
  if ((server.autoStart || options.startWhenDone === true) && !cancelledOperations.delete(serverId)) {
    await startInternal(serverId, `Starting ${server.name}…`);
  }
}

// ---------------------------------------------------------------------------
// Power
// ---------------------------------------------------------------------------

export interface StopOptions {
  /** Skip the blueprint's graceful stop command and go straight to the signal. */
  force?: boolean;
  /** Overrides the blueprint's grace period before the runtime escalates to SIGKILL. */
  timeoutSeconds?: number;
}

export async function startServer(serverId: string, actorId: string | null = null): Promise<void> {
  await withServerLock(serverId, async () => {
    const server = await requireServerRow(serverId);
    assertAllowed(server, 'start');
    // A human pressing start owns the outcome from here: any restart the supervisor was
    // still counting down to is cancelled, and the crash loop cutoff is lifted.
    clearCrashRecord(serverId);
    const who = await actorLabel(actorId);

    if (statusOf(server) === 'provisioning') {
      // Created with `startOnCreate: false`: there is no image, no data directory and no
      // container yet, so "start" means "install, then boot". `startWhenDone` rather than
      // the row's `autoStart`, because the person pressing start has just said so.
      getLogHub(serverId).system(withActor(`Setting ${server.name} up…`, who));
      await runInstall(serverId, { force: false, startWhenDone: true });
      return;
    }

    await startInternal(serverId, withActor(`Starting ${server.name}…`, who));
  });
}

/**
 * The unguarded start. Callers hold the lock and have already decided this is legal.
 *
 * The container is rebuilt from the row every time. That is what makes an edited memory
 * limit or a changed variable take effect on the next boot rather than the next reinstall,
 * and it means a container someone removed by hand simply comes back.
 */
async function startInternal(serverId: string, message: string): Promise<void> {
  const loaded = await loadServer(serverId);
  const { server, driver } = loaded;

  if (server.installedAt === null) {
    throw invalidState(`${server.name} has not finished installing yet.`);
  }

  const blueprint = await loadBlueprint(server);
  const dataDir = serverDataDir(serverId);
  await mkdir(dataDir, { recursive: true });

  // Re-bound here, not only at provision time: a blueprint that has since marked a port
  // loopback-only must take effect on the next boot of servers that already exist.
  const bound = await reconcileBindAddresses(loaded.node, blueprint.ports, loaded.allocations);
  const allocations = toServerAllocations(blueprint, bound);
  const env = buildEnv(server, blueprint, allocations);
  await writeBlueprintFiles(dataDir, blueprint, env);

  const containerId = await driver.recreate(buildSpec(loaded, blueprint, allocations, env));
  await setStatus(serverId, 'starting', {
    containerId,
    startedAt: new Date(),
    exitCode: null,
    message,
  });

  try {
    await driver.start(serverId);
  } catch (error) {
    await setStatus(serverId, 'offline', {
      startedAt: null,
      message: `${server.name} could not be started: ${messageOf(error)}`,
    });
    throw error;
  }

  if (cancelledOperations.delete(serverId)) {
    // Killed while this start was in flight. `killServer` runs outside the lock precisely so
    // it can interrupt us, and it wrote `offline` — but the container it killed did not
    // exist yet, and `driver.start` has since brought one up. Leaving it there is how the
    // panel ends up reporting a stopped server that players are still connected to, with
    // nothing to correct it: the supervisor only looks at rows that claim to be live.
    try {
      await driver.kill(serverId);
    } catch (error) {
      if (!(error instanceof PlatterError && error.code === 'not_found')) {
        report('warn', { err: error, serverId }, 'could not stop a container a kill superseded');
      }
    }
    const state = await driver.inspect(serverId);
    await setStatus(serverId, 'offline', {
      exitCode: state.exitCode,
      startedAt: null,
      message: `${server.name} was killed while it was starting.`,
    });
    return;
  }

  await armRunWatcher(serverId, blueprint, driver);
}

/**
 * Watches a server for as long as it is meant to be up.
 *
 * Two signals, one subscription. `ready` ends the boot: a container being up is not the
 * same as a game being playable — a Minecraft server spends a minute generating chunks
 * before it accepts a connection — so `starting` is held until the log says otherwise, with
 * a timeout for images whose output we do not know.
 *
 * `crash` is why the subscription outlives the boot rather than ending at `ready`.
 * `checkLiveness` only ever notices a container that has *exited*; a server that logs a
 * fatal error and then hangs — a world that failed to load, an unaccepted EULA — would
 * otherwise sit at `running` forever with nobody able to play on it. Staying subscribed
 * also keeps the driver's log stream open while the server runs, which is what makes that
 * detection work when no console is open: the hub tears the stream down at zero listeners,
 * and the boot watcher used to be the only one.
 *
 * Released by `setStatus` the moment the server is no longer running or starting, so a
 * stopped server costs nothing.
 */
async function armRunWatcher(
  serverId: string,
  blueprint: Blueprint,
  driver: OrchestrationDriver,
): Promise<void> {
  cancelRunWatcher(serverId);

  const hub = getLogHub(serverId);
  // Each boot gets its own stream: the hub latches "ready seen" per attach, and the
  // previous stream belonged to the container this start just replaced.
  hub.detach();

  let timer: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;
  let booted = false;

  const cleanup = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }
    runWatchers.delete(serverId);
  };

  const finishBoot = async (reason: 'ready' | 'timeout'): Promise<void> => {
    if (booted) return;
    booted = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    await promote(serverId, reason);
  };

  const finishBootDetached = (reason: 'ready' | 'timeout'): void => {
    void finishBoot(reason).catch((error: unknown) => {
      report('warn', { err: error, serverId }, 'could not promote a server to running');
    });
  };

  unsubscribe = hub.subscribe((event) => {
    if (event.type === 'ready') finishBootDetached('ready');
    else if (event.type === 'crash') {
      void onCrashSignal(serverId, event.line).catch((error: unknown) => {
        report('warn', { err: error, serverId }, 'could not record a log-detected crash');
      });
    }
  });
  runWatchers.set(serverId, cleanup);

  if (blueprint.signals.ready.length === 0) {
    // Nothing to wait for. A blueprint with no ready pattern cannot tell us when the game
    // finished booting, and being slightly early beats being `starting` forever. Awaited so
    // `startServer` resolves with the status the caller is about to read.
    hub.attach({ driver, signals: blueprint.signals });
    await finishBoot('ready');
    return;
  }

  timer = setTimeout(() => {
    finishBootDetached('timeout');
  }, BOOT_TIMEOUT_MS);
  // A boot that nobody is waiting for must not hold the process open at shutdown.
  timer.unref();

  hub.attach({ driver, signals: blueprint.signals });
}

function cancelRunWatcher(serverId: string): void {
  const cancel = runWatchers.get(serverId);
  if (cancel) cancel();
}

/**
 * A blueprint's crash pattern matched on a server that is meant to be up.
 *
 * Taken under the lock and re-read, because the line can land while a stop is already in
 * flight — that exit is expected, and calling it a crash would trigger an automatic restart
 * of a server somebody just turned off. The container is brought down rather than left
 * hanging: the process is not coming back on its own, and the restart path `recordCrash`
 * arms can only work from a stopped container. A pattern that turns out to be too eager is
 * bounded by the same crash-loop cutoff every other crash goes through.
 */
async function onCrashSignal(serverId: string, line: LogLine): Promise<void> {
  await withServerLock(serverId, async () => {
    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server || server.suspended) return;
    if (server.status !== 'starting' && server.status !== 'running') return;

    cancelRunWatcher(serverId);
    getLogHub(serverId).system(`${server.name} reported a fatal error: ${line.content}`);

    const { driver } = await loadServer(serverId);
    try {
      await driver.kill(serverId);
    } catch (error) {
      // Already gone is the outcome we wanted; the inspect below reports what happened.
      if (!(error instanceof PlatterError && error.code === 'not_found')) {
        report('warn', { err: error, serverId }, 'could not stop a server that logged a crash');
      }
    }
    await recordCrash(server, await driver.inspect(serverId), Date.now());
  });
}

async function promote(serverId: string, reason: 'ready' | 'timeout'): Promise<void> {
  const row = await prisma.server.findUnique({
    where: { id: serverId },
    select: { name: true, status: true },
  });
  // Only a server still waiting on its boot may be promoted. A stop that landed first owns
  // the status now, and overwriting it would resurrect a server the operator turned off.
  if (!row || row.status !== 'starting') return;

  await setStatus(serverId, 'running', {
    message:
      reason === 'ready'
        ? `${row.name} is ready.`
        : `${row.name} has not printed a ready line; treating it as running.`,
  });
}

export async function stopServer(
  serverId: string,
  actorId: string | null = null,
  options: StopOptions = {},
): Promise<void> {
  await withServerLock(serverId, async () => {
    const server = await requireServerRow(serverId);
    assertAllowed(server, 'stop');

    const who = await actorLabel(actorId);
    // A deliberate stop is not a crash and never has an automatic restart behind it.
    clearCrashRecord(serverId);
    cancelRunWatcher(serverId);

    await setStatus(serverId, 'stopping', { message: withActor(`Stopping ${server.name}…`, who) });
    const exitCode = await stopInternal(serverId, options);
    await setStatus(serverId, 'offline', {
      exitCode,
      startedAt: null,
      message: `${server.name} stopped.`,
    });
  });
}

/**
 * Kill deliberately does not queue behind the server's other operations: it is the escape
 * hatch for an install or a stop that has wedged, and a kill that waits for the thing it
 * is meant to interrupt is not a kill.
 */
export async function killServer(serverId: string, actorId: string | null = null): Promise<void> {
  const server = await requireServerRow(serverId);
  assertAllowed(server, 'kill');

  const who = await actorLabel(actorId);
  clearCrashRecord(serverId);
  cancelRunWatcher(serverId);

  // An operation is in flight exactly when the lock we are skipping is held. Telling it it
  // has been superseded is the only way a kill can win against a restart that is already
  // past its stop and about to start the container again.
  if (operations.has(serverId)) cancelledOperations.add(serverId);

  const wasInstalling = statusOf(server) === 'installing';
  // The install is running under the lock we deliberately did not take, so it is told to
  // stop rather than interrupted: it checks between steps and fails itself.
  if (wasInstalling) cancelledInstalls.add(serverId);
  await setStatus(serverId, 'stopping', { message: withActor(`Killing ${server.name}…`, who) });

  const { driver } = await loadServer(serverId);
  try {
    await driver.kill(serverId);
  } catch (error) {
    // Nothing to kill is the outcome we wanted; anything else is a real driver failure.
    if (!(error instanceof PlatterError && error.code === 'not_found')) throw error;
  }

  const state = await driver.inspect(serverId);
  await setStatus(serverId, wasInstalling ? 'install_failed' : 'offline', {
    exitCode: state.exitCode,
    startedAt: null,
    message: wasInstalling
      ? `The install of ${server.name} was stopped.`
      : `${server.name} was killed.`,
  });
}

export async function restartServer(
  serverId: string,
  actorId: string | null = null,
  options: StopOptions = {},
): Promise<void> {
  await withServerLock(serverId, async () => {
    const server = await requireServerRow(serverId);
    assertAllowed(server, 'restart');

    const who = await actorLabel(actorId);
    clearCrashRecord(serverId);
    cancelRunWatcher(serverId);
    cancelledOperations.delete(serverId);

    await setStatus(serverId, 'restarting', {
      message: withActor(`Restarting ${server.name}…`, who),
    });
    const exitCode = await stopInternal(serverId, options);
    if (cancelledOperations.delete(serverId)) {
      // Killed mid-restart. The kill already wrote the status it wanted; starting the
      // container back up here would undo the most emphatic thing a user can press.
      getLogHub(serverId).system(`The restart of ${server.name} was stopped.`);
      return;
    }
    // Kept at `restarting` while the exit code is recorded: a client that saw `offline`
    // here would flash a stopped server in the middle of a restart it asked for.
    await setStatus(serverId, 'restarting', { exitCode, startedAt: null });
    await startInternal(serverId, `Starting ${server.name}…`);
  });
}

/**
 * The entry point routes, the scheduler and MCP all use. The action is validated against
 * the shared table, so every caller gets the same answer about what is legal.
 */
export async function performPowerAction(
  serverId: string,
  action: PowerAction,
  actorId: string | null = null,
  options: StopOptions = {},
): Promise<void> {
  switch (action) {
    case 'start':
      return startServer(serverId, actorId);
    case 'stop':
      return stopServer(serverId, actorId, options);
    case 'restart':
      return restartServer(serverId, actorId, options);
    case 'kill':
      return killServer(serverId, actorId);
  }
}

interface ExitResult {
  exited: boolean;
  exitCode: number | null;
}

async function waitForExit(
  driver: OrchestrationDriver,
  serverId: string,
  timeoutMs: number,
): Promise<ExitResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await driver.inspect(serverId);
    if (!state.exists) return { exited: true, exitCode: null };
    if (!state.running) return { exited: true, exitCode: state.exitCode };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { exited: false, exitCode: null };
    await sleep(Math.min(EXIT_POLL_INTERVAL_MS, remaining));
  }
}

/** Brings the container down. The caller owns the status writes around it. */
async function stopInternal(serverId: string, options: StopOptions): Promise<number | null> {
  const { server, driver } = await loadServer(serverId);
  const blueprint = await loadBlueprintOrNull(server);

  const timeoutSeconds =
    options.timeoutSeconds ?? blueprint?.stop.timeoutSeconds ?? DEFAULT_STOP_TIMEOUT_SECONDS;
  const signal = blueprint?.stop.signal ?? 'SIGTERM';

  const state = await driver.inspect(serverId);
  if (!state.exists) return null;
  if (!state.running) return state.exitCode;

  const command =
    blueprint !== null && blueprint.stop.strategy === 'command' && blueprint.features.console
      ? blueprint.stop.command
      : null;

  if (command !== null && options.force !== true) {
    // Games that only save on their own `stop` command lose the last minutes of a world to
    // a signal, so the console gets the first, time-boxed chance. The signal is still the
    // backstop below, and the runtime escalates it to SIGKILL on its own timer.
    try {
      await driver.writeStdin(serverId, command);
      const result = await waitForExit(driver, serverId, timeoutSeconds * 1000);
      if (result.exited) return result.exitCode;
    } catch (error) {
      report(
        'warn',
        { err: error, serverId },
        'the blueprint stop command failed; falling back to a signal',
      );
    }
  }

  await driver.stop(serverId, { signal, timeoutSeconds });
  const after = await driver.inspect(serverId);
  return after.exitCode;
}

// ---------------------------------------------------------------------------
// Console input
// ---------------------------------------------------------------------------

export async function sendCommand(
  serverId: string,
  command: string,
  actorId: string | null = null,
): Promise<void> {
  const { server, driver } = await loadServer(serverId);

  // stdin is line-oriented: a newline inside the value is a second command that nobody
  // authorised and nothing audited. Rejected rather than trimmed for that reason.
  if (/[\r\n]/.test(command)) throw badRequest('A console command cannot span multiple lines.');
  const trimmed = command.trim();
  if (trimmed.length === 0) throw badRequest('Enter a command to send.');
  if (trimmed.length > LIMITS.maxConsoleLineLength) {
    throw badRequest(`Keep a command under ${LIMITS.maxConsoleLineLength} characters.`);
  }

  const status = statusOf(server);
  if (status !== 'running') {
    throw invalidState(`${server.name} is ${STATUS_WORDS[status]}, so it cannot take a command.`);
  }

  await driver.writeStdin(serverId, trimmed);
  const who = await actorLabel(actorId);
  // Echoed so the console shows what was sent even though the game only echoes its reply.
  getLogHub(serverId).system(who === null ? `> ${trimmed}` : `> ${trimmed} (${who})`);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

async function removeDataDir(serverId: string): Promise<void> {
  const dir = path.resolve(serverDataDir(serverId));
  const root = path.resolve(config.serversDir) + path.sep;
  // The path is derived, not user input — but this is a recursive delete, and the cost of
  // being wrong once is the whole data directory.
  if (!dir.startsWith(root)) {
    throw internal('refusing to delete a path outside the server data root');
  }
  await rm(dir, { recursive: true, force: true });
}

export async function deleteServer(serverId: string, actorId: string | null = null): Promise<void> {
  await withServerLock(serverId, async () => {
    const { server, driver } = await loadServer(serverId);
    const who = await actorLabel(actorId);

    cancelRunWatcher(serverId);
    clearCrashRecord(serverId);
    await setStatus(serverId, 'deleting', { message: withActor(`Deleting ${server.name}…`, who) });

    try {
      await driver.remove(serverId, { removeVolume: true });
    } catch (error) {
      // Deliberately fatal. Dropping the row now would leave a container running with
      // nothing in Platter pointing at it, and no way to find it from the UI. The row
      // stays at `deleting`, and the delete can simply be retried.
      if (!(error instanceof PlatterError && error.code === 'not_found')) throw error;
    }

    await removeDataDir(serverId);
    // Ports go back to the free pool before the row goes, so a failure here cannot strand
    // an allocation pointing at a server that no longer exists.
    await releasePorts(serverId);

    // Player history and mod proposals live in `Setting` rows keyed by server id, which
    // no foreign key reaches — without this they survive the server forever and the id is
    // never reused, so nothing would ever collect them.
    await forgetPlayerHistory(serverId);
    await purgeServerProposals(serverId);

    await prisma.server.delete({ where: { id: serverId } });
    dropLogHub(serverId);
    withdrawServer(serverId, logger ?? undefined);
  });
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  checked: number;
  /** Rows whose status did not match the runtime and were corrected. */
  corrected: number;
  /** Servers brought back up because they were meant to be running. */
  started: number;
  /** Installs that were interrupted and have been resumed. */
  resumed: number;
  /** Containers Platter manages but has no row for. Flagged, never destroyed. */
  orphans: Array<{ nodeId: string; serverId: string; containerId: string }>;
  unreachableNodes: string[];
}

/**
 * Brings the database back in line with reality, once, at boot.
 *
 * Platter is not always running when the things it supervises change: a server can crash,
 * be killed by the host's OOM reaper, or be removed with `docker rm` while the panel is
 * down. Trusting the stored status after a restart is how a dashboard ends up showing
 * three running servers on a machine with none.
 */
export async function reconcile(options: { logger?: FastifyBaseLogger } = {}): Promise<ReconcileResult> {
  if (options.logger) logger = options.logger;

  const result: ReconcileResult = {
    checked: 0,
    corrected: 0,
    started: 0,
    resumed: 0,
    orphans: [],
    unreachableNodes: [],
  };

  const nodes = await prisma.node.findMany();
  for (const node of nodes) {
    const driver = getDriverForNode(node);
    const health = await driver.health();
    if (!health.reachable) {
      // Statuses are left exactly as they are. An unreachable node tells us nothing about
      // its containers, and marking its servers offline would be a guess presented as fact.
      result.unreachableNodes.push(node.id);
      report('warn', { nodeId: node.id, reason: health.error }, 'skipping reconcile for an unreachable node');
      continue;
    }

    const servers = await prisma.server.findMany({ where: { nodeId: node.id } });
    for (const server of servers) {
      result.checked += 1;
      try {
        await reconcileServer(server, driver, result);
      } catch (error) {
        report('error', { err: error, serverId: server.id }, 'could not reconcile a server');
      }
    }

    try {
      const known = new Set(servers.map((server) => server.id));
      for (const orphan of await driver.listOrphans()) {
        if (!known.has(orphan.serverId)) {
          result.orphans.push({ nodeId: node.id, ...orphan });
        }
      }
    } catch (error) {
      report('warn', { err: error, nodeId: node.id }, 'could not list containers on a node');
    }
  }

  if (result.orphans.length > 0) {
    // Left running on purpose: a container Platter cannot explain is far more likely to be
    // a database restored from an old backup than something safe to destroy.
    report('warn', { orphans: result.orphans }, 'containers found with no server record');
  }
  return result;
}

async function reconcileServer(
  server: ServerRow,
  driver: OrchestrationDriver,
  result: ReconcileResult,
): Promise<void> {
  if (statusOf(server) === 'installing') {
    // An install is resumable by construction, and resuming beats leaving a server that
    // will never finish one.
    //
    // Deliberately not awaited. `main.ts` waits for reconcile before it binds the HTTP
    // port, and an install resumes by pulling an image: a restart in the middle of a first
    // install would otherwise leave the panel refusing connections — to the operator and to
    // every health check — for as long as a multi-gigabyte pull takes. Reconciling statuses
    // is the part that has to finish before traffic arrives; the pull is not.
    result.resumed += 1;
    void installServer(server.id).catch((error: unknown) => {
      report('error', { err: error, serverId: server.id }, 'could not resume an interrupted install');
    });
    return;
  }

  const state = await driver.inspect(server.id);
  const containerId = state.exists ? state.id : null;

  if (server.suspended) {
    // The stored status is what a server returns to when the suspension is lifted, so it
    // is not ours to overwrite. Only the container id is worth refreshing.
    if (containerId !== server.containerId) {
      await setStatus(server.id, storedStatus(server), { containerId });
    }
    return;
  }

  let derived = deriveStatus(state, statusOf(server));
  // `starting` means "waiting for a ready line", and the watcher that was waiting died
  // with the previous process. A container that is still up has had its chance to boot.
  if (derived === 'starting' && state.running) derived = 'running';

  const statusChanged = derived !== server.status;
  if (statusChanged || containerId !== server.containerId) {
    if (statusChanged) result.corrected += 1;
    await setStatus(server.id, derived, {
      containerId,
      ...(derived === 'crashed' ? { exitCode: state.exitCode, crashedAt: new Date() } : {}),
      ...(state.running ? {} : { startedAt: null }),
      ...(statusChanged
        ? { message: `Reconciled after a restart: ${server.name} is ${STATUS_WORDS[derived]}.` }
        : {}),
    });
  }

  if (server.autoStart && derived === 'offline' && WAS_ACTIVE.includes(server.status)) {
    // It was meant to be up when we lost sight of it, and it is not. A server the operator
    // stopped is stored as `offline` and is never touched by this.
    result.started += 1;
    await startServer(server.id);
  }
}

// ---------------------------------------------------------------------------
// Crash supervision
// ---------------------------------------------------------------------------

function crashRecordFor(serverId: string, now: number): CrashRecord {
  const existing = crashRecords.get(serverId);
  if (existing) {
    existing.touchedAt = now;
    return existing;
  }
  const record: CrashRecord = {
    crashes: [],
    attempts: 0,
    nextAttemptAt: null,
    cutoff: false,
    touchedAt: now,
  };
  crashRecords.set(serverId, record);
  return record;
}

function clearCrashRecord(serverId: string): void {
  crashRecords.delete(serverId);
}

function pruneCrashRecords(now: number): void {
  for (const [serverId, record] of crashRecords) {
    const idle =
      record.nextAttemptAt === null &&
      !record.cutoff &&
      record.crashes.every((at) => now - at >= CRASH_WINDOW_MS);
    if (idle) crashRecords.delete(serverId);
  }

  // A cutoff record survives until a human acts on that server, so the map also needs a
  // hard ceiling: in a daemon that runs for months, "usually small" is not a bound.
  if (crashRecords.size <= MAX_CRASH_RECORDS) return;
  const oldestFirst = [...crashRecords.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt);
  for (const [serverId] of oldestFirst.slice(0, crashRecords.size - MAX_CRASH_RECORDS)) {
    crashRecords.delete(serverId);
  }
}

async function recordCrash(server: ServerRow, state: ContainerState, now: number): Promise<void> {
  const record = crashRecordFor(server.id, now);
  record.crashes = record.crashes.filter((at) => now - at < CRASH_WINDOW_MS);
  record.crashes.push(now);

  await setStatus(server.id, 'crashed', {
    exitCode: state.exitCode,
    crashedAt: new Date(now),
    startedAt: null,
    message: state.oomKilled
      ? `${server.name} ran out of memory and was killed. Give it more memory before starting it again.`
      : `${server.name} exited unexpectedly (exit code ${state.exitCode ?? 'unknown'}).`,
  });

  if (!server.autoRestart) {
    record.nextAttemptAt = null;
    return;
  }

  if (record.crashes.length >= CRASH_LIMIT) {
    // The cutoff. A server that dies immediately on every boot — a corrupt world, a bad
    // mod, a memory limit it cannot start under — is not going to be fixed by a fourth
    // attempt, and a restart loop hides the original error behind its own noise.
    record.cutoff = true;
    record.nextAttemptAt = null;
    getLogHub(server.id).system(
      `${server.name} has crashed ${record.crashes.length} times in under a minute. Automatic restarts are off until you start it yourself.`,
    );
    return;
  }

  record.attempts += 1;
  const waitMs = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** (record.attempts - 1));
  record.nextAttemptAt = now + waitMs;
  getLogHub(server.id).system(`Restarting ${server.name} in ${Math.round(waitMs / 1000)}s.`);
}

/** Statuses `checkLiveness` is entitled to act on. Anything else belongs to someone else. */
const LIVENESS_STATUSES: readonly string[] = ['starting', 'running', 'restarting', 'stopping'];

/**
 * Decides whether a container that is no longer up exited on purpose.
 *
 * Everything here reads the row it re-fetches under the lock, never the one `superviseOnce`
 * scanned. That row is a snapshot taken before this pass began working through the list
 * sequentially, and a stop that *completed* in the meantime leaves it still saying
 * `running` — which made a deliberate shutdown look like a crash, wrote a crash record, and
 * had the next pass start the server back up under a user who had just turned it off. The
 * caller's `operations.has` guard does not cover that case: it only sees a stop still in
 * flight, not one that has already finished.
 *
 * The lock is taken with no `await` between the check above it and the call, so an idle
 * server never queues behind anything; a server that is busy is left for the next pass
 * rather than blocking supervision of every server after it.
 */
async function checkLiveness(server: ServerRow, now: number): Promise<void> {
  if (operations.has(server.id)) return;
  await withServerLock(server.id, async () => {
    const fresh = await prisma.server.findUnique({ where: { id: server.id } });
    if (!fresh || fresh.suspended) return;
    if (!LIVENESS_STATUSES.includes(fresh.status)) return;

    const driver = await getDriver(fresh.nodeId);
    const state = await driver.inspect(fresh.id);
    if (state.running || state.restarting) return;

    // A stop or a restart already asked for this exit; it is not a crash.
    const expected = fresh.status === 'stopping' || fresh.status === 'restarting';

    if (!state.exists) {
      await setStatus(fresh.id, 'offline', {
        containerId: null,
        startedAt: null,
        ...(expected ? {} : { message: `The container for ${fresh.name} is gone.` }),
      });
      return;
    }

    if (expected) {
      await setStatus(fresh.id, 'offline', { exitCode: state.exitCode, startedAt: null });
      return;
    }

    await recordCrash(fresh, state, now);
  });
}

async function maybeRestart(server: ServerRow, now: number): Promise<void> {
  const record = crashRecords.get(server.id);
  if (!record || record.cutoff || record.nextAttemptAt === null || record.nextAttemptAt > now) return;

  record.nextAttemptAt = null;
  record.touchedAt = now;

  await withServerLock(server.id, async () => {
    const fresh = await prisma.server.findUnique({ where: { id: server.id } });
    // Re-read under the lock. Between the scan and here a human may have started, stopped
    // or deleted this server, and an automatic restart must never override that.
    if (!fresh || fresh.suspended || fresh.status !== 'crashed' || !fresh.autoRestart) return;
    await startInternal(server.id, `Restarting ${fresh.name} after a crash…`);
  });
}

/**
 * One supervision pass.
 *
 * `now` is a parameter rather than a call to `Date.now()` inside so the backoff and the
 * crash window are testable without waiting a real minute for them.
 */
export async function superviseOnce(now: number = Date.now()): Promise<void> {
  if (supervising) return;
  supervising = true;
  try {
    const servers = await prisma.server.findMany({
      where: {
        suspended: false,
        status: { in: ['starting', 'running', 'restarting', 'stopping', 'crashed'] },
      },
    });

    for (const server of servers) {
      // A server with an operation in flight owns its own status. The supervisor repairs
      // drift; it does not compete with the thing that is currently deciding.
      if (operations.has(server.id)) continue;
      try {
        if (server.status === 'crashed') await maybeRestart(server, now);
        else await checkLiveness(server, now);
      } catch (error) {
        report('warn', { err: error, serverId: server.id }, 'crash supervision failed for a server');
      }
    }

    pruneCrashRecords(now);
  } catch (error) {
    // Called from a timer: a rejection here has nowhere to go but an unhandled rejection.
    report('error', { err: error }, 'crash supervision pass failed');
  } finally {
    supervising = false;
  }
}

export interface SupervisorOptions {
  intervalMs?: number;
  logger?: FastifyBaseLogger;
}

export function startCrashSupervisor(options: SupervisorOptions = {}): void {
  if (supervisor) return;
  if (options.logger) logger = options.logger;

  const intervalMs = Math.max(MIN_INTERVAL_MS, options.intervalMs ?? SUPERVISOR_INTERVAL_MS);
  supervisor = setInterval(() => {
    void superviseOnce();
  }, intervalMs);
  // Supervision must never be the reason a shutting-down process stays alive.
  supervisor.unref();
}

export function stopCrashSupervisor(): void {
  if (!supervisor) return;
  clearInterval(supervisor);
  supervisor = null;
}

/** Drops every timer, watcher and counter this module owns. Shutdown, and tests. */
export function resetLifecycleState(): void {
  stopCrashSupervisor();
  for (const cancel of [...runWatchers.values()]) cancel();
  runWatchers.clear();
  crashRecords.clear();
  cancelledInstalls.clear();
  cancelledOperations.clear();
  operations.clear();
  logger = null;
}
