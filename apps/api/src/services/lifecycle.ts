import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Node, Server } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import {
  LIMITS,
  PlatterError,
  SERVER_STATUSES,
  blueprintSchema,
  canPerformPowerAction,
} from '@platter/shared';
import type { Blueprint, PowerAction, ServerStatus } from '@platter/shared';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { badRequest, invalidState, notFound, toPlatterError } from '../lib/errors.js';
import { DRIVER_LABELS, deriveStatus } from '../orchestration/driver.js';
import type { ContainerSpec, ContainerState, OrchestrationDriver } from '../orchestration/driver.js';
import { dropLogHub, getLogHub } from '../orchestration/log-buffer.js';
import { driverForNode } from '../orchestration/registry.js';
import { releasePorts, serverAllocations, toPortBindings } from './allocations.js';
import { recordAudit } from './audit.js';
import type { AllocationRecord } from './allocations.js';

/**
 * The server state machine: the only place `Server.status` is written, and the only place
 * that decides what a power action means for a particular blueprint.
 *
 * Every transition is checked against the shared `ALLOWED_POWER_ACTIONS` table before it
 * reaches a driver, so the UI, the scheduler and the AI assistant all get the same answer
 * to "can I start this right now" — and the orchestrator can never be driven into a state
 * the rest of the product has no vocabulary for.
 */

export type LifecycleLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;

/** Container processes a modded game server may fork before we call it a fork bomb. */
const PIDS_LIMIT = 512;
/** How long a `starting` server may go without its ready line before we believe it anyway. */
const READY_TIMEOUT_MS = 10 * 60_000;
const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 3;
const RESTART_BASE_MS = 5_000;
const RESTART_MAX_MS = 5 * 60_000;
const SUPERVISOR_INTERVAL_MS = 5_000;
const CONSOLE_TAIL_LINES = 200;

// ---------------------------------------------------------------------------
// Blueprints
// ---------------------------------------------------------------------------

export type BlueprintResolver = (key: string) => Promise<Blueprint | null>;

const BLUEPRINT_DIRECTORIES = [
  path.join(config.dataDir, 'blueprints'),
  fileURLToPath(new URL('../../blueprints/', import.meta.url)),
];

/**
 * Blueprints are files, so the fallback reader is a file reader. The blueprint service
 * replaces it at boot with the catalogue it has already parsed and cached; keeping the
 * seam here means lifecycle never has to know where that catalogue lives.
 */
async function readBlueprintFromDisk(key: string): Promise<Blueprint | null> {
  // The key reaches a path join, so it is matched against the same slug rule the schema
  // enforces rather than sanitised after the fact.
  if (!/^[a-z][a-z0-9-]*$/.test(key)) return null;

  for (const directory of BLUEPRINT_DIRECTORIES) {
    const raw = await readFile(path.join(directory, `${key}.json`), 'utf8').catch(() => null);
    if (raw === null) continue;
    try {
      const parsed = blueprintSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      throw new PlatterError('internal_error', `The blueprint "${key}" on disk is not valid.`);
    } catch (error) {
      if (error instanceof PlatterError) throw error;
      throw new PlatterError('internal_error', `The blueprint "${key}" on disk is not valid JSON.`, {
        cause: error,
      });
    }
  }
  return null;
}

let resolveBlueprint: BlueprintResolver = readBlueprintFromDisk;

export function setBlueprintResolver(resolver: BlueprintResolver): void {
  resolveBlueprint = resolver;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface ServerContext {
  server: Server;
  node: Node;
  blueprint: Blueprint;
  driver: OrchestrationDriver;
  allocations: AllocationRecord[];
}

const STATUS_VALUES: readonly string[] = SERVER_STATUSES;

/** A row holding a status this build has never heard of is treated as stopped, not fatal. */
function statusOf(server: Pick<Server, 'status'>): ServerStatus {
  return STATUS_VALUES.includes(server.status) ? (server.status as ServerStatus) : 'offline';
}

function dataDirectoryFor(serverId: string): string {
  return path.join(config.serversDir, serverId);
}

async function loadServer(serverId: string): Promise<Server & { node: Node }> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    include: { node: true },
  });
  if (!server) throw notFound('server');
  return server;
}

async function loadContext(serverId: string): Promise<ServerContext> {
  const server = await loadServer(serverId);
  const blueprint = await resolveBlueprint(server.blueprintKey);
  if (!blueprint) {
    throw new PlatterError(
      'not_found',
      `The blueprint "${server.blueprintKey}" is not installed on this Platter.`,
    );
  }
  return {
    server,
    node: server.node,
    blueprint,
    driver: driverForNode(server.node),
    allocations: await serverAllocations(serverId),
  };
}

function parseVariables(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') values[key] = value;
      else if (typeof value === 'number' || typeof value === 'boolean') values[key] = String(value);
    }
    return values;
  } catch {
    return {};
  }
}

function envKeyFor(portName: string): string {
  return portName.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
}

/**
 * The environment the container sees: blueprint variables first, then the handful of
 * values Platter owns.
 *
 * `SERVER_PORT` is the *container* port — the one the game must bind to inside its
 * namespace. The host port players type is exposed separately as `PUBLIC_PORT_*`, because
 * a blueprint that advertises its address (Source query, RCON banners) needs the outside
 * number and binding to it would fail.
 */
function buildEnv(
  blueprint: Blueprint,
  server: Server,
  allocations: readonly AllocationRecord[],
  publicHost: string,
): Record<string, string> {
  const provided = parseVariables(server.variables);
  const env: Record<string, string> = {};

  for (const variable of blueprint.variables) {
    const value = provided[variable.key] ?? (variable.default === null ? undefined : String(variable.default));
    if (value !== undefined) env[variable.key] = value;
  }

  const byName = new Map(allocations.filter((a) => a.portName !== null).map((a) => [a.portName, a]));
  for (const port of blueprint.ports) {
    const allocation = byName.get(port.name);
    env[`PORT_${envKeyFor(port.name)}`] = String(port.containerPort);
    if (allocation) env[`PUBLIC_PORT_${envKeyFor(port.name)}`] = String(allocation.hostPort);
  }

  const primaryPort = blueprint.ports.find((port) => port.primary) ?? blueprint.ports[0];
  env.SERVER_ID = server.id;
  env.SERVER_NAME = server.name;
  env.SERVER_MEMORY = String(server.memoryMb);
  env.SERVER_IP = '0.0.0.0';
  if (primaryPort) env.SERVER_PORT = String(primaryPort.containerPort);
  env.SERVER_PUBLIC_HOST = publicHost;
  return env;
}

/** stdin stays open for console input, and for blueprints that stop by being told to. */
function needsStdin(blueprint: Blueprint): boolean {
  return blueprint.features.console || blueprint.stop.strategy === 'command';
}

function buildSpec(ctx: ServerContext): ContainerSpec {
  return {
    serverId: ctx.server.id,
    name: ctx.server.name,
    image: ctx.blueprint.image,
    command: ctx.blueprint.command,
    env: buildEnv(ctx.blueprint, ctx.server, ctx.allocations, ctx.node.publicHost),
    dataHostPath: dataDirectoryFor(ctx.server.id),
    dataPath: ctx.blueprint.dataPath,
    ports: toPortBindings(ctx.allocations, ctx.blueprint.ports),
    limits: {
      memoryMb: ctx.server.memoryMb,
      swapMb: ctx.server.swapMb,
      cpuCores: ctx.server.cpuCores,
      ioWeight: ctx.server.ioWeight,
      pidsLimit: PIDS_LIMIT,
    },
    labels: {
      [DRIVER_LABELS.managed]: 'true',
      [DRIVER_LABELS.serverId]: ctx.server.id,
      [DRIVER_LABELS.serverName]: ctx.server.name,
      [DRIVER_LABELS.blueprint]: ctx.blueprint.key,
      [DRIVER_LABELS.nodeId]: ctx.node.id,
    },
    interactive: needsStdin(ctx.blueprint),
  };
}

/** Keeps a blueprint's file paths inside the server's own directory. */
function resolveInsideData(dataHostPath: string, relative: string): string {
  const resolved = path.resolve(dataHostPath, relative);
  if (resolved !== dataHostPath && !resolved.startsWith(dataHostPath + path.sep)) {
    throw badRequest(`The blueprint tries to write outside the server directory: ${relative}`);
  }
  return resolved;
}

/**
 * `{{VAR}}` substitution. An unknown placeholder is left as written: blanking it produces
 * a config file that looks valid and silently is not, which is far harder to diagnose than
 * a literal `{{FOO}}` in a properties file.
 */
function renderTemplate(template: string, env: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (match, key: string) => env[key] ?? match);
}

async function renderBlueprintFiles(ctx: ServerContext, env: Record<string, string>): Promise<void> {
  const root = dataDirectoryFor(ctx.server.id);
  for (const file of ctx.blueprint.files) {
    const target = resolveInsideData(root, file.path);
    if (!file.overwrite) {
      const exists = await stat(target).then(
        () => true,
        () => false,
      );
      // Not overwriting is how a blueprint ships a default the operator is then free to
      // edit; re-rendering it on every boot would silently undo their changes.
      if (exists) continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, renderTemplate(file.template, env), 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface StatusUpdate {
  exitCode?: number | null;
  containerId?: string | null;
  installedAt?: Date | null;
  startedAt?: Date | null;
  crashedAt?: Date | null;
  /** Appended to the console as a Platter annotation alongside the transition. */
  message?: string;
}

/**
 * The single writer for `Server.status`.
 *
 * Everything that changes a status goes through here so that the database row, the
 * console socket and the crash supervisor can never disagree about what a server is
 * doing — a status written directly would be invisible to every open console.
 */
export async function setStatus(
  serverId: string,
  status: ServerStatus,
  extra: StatusUpdate = {},
): Promise<void> {
  await prisma.server.update({
    where: { id: serverId },
    data: {
      status,
      ...(extra.exitCode !== undefined ? { lastExitCode: extra.exitCode } : {}),
      ...(extra.containerId !== undefined ? { containerId: extra.containerId } : {}),
      ...(extra.installedAt !== undefined ? { installedAt: extra.installedAt } : {}),
      ...(extra.startedAt !== undefined ? { startedAt: extra.startedAt } : {}),
      ...(extra.crashedAt !== undefined ? { lastCrashAt: extra.crashedAt } : {}),
    },
  });

  const hub = getLogHub(serverId);
  if (extra.message) hub.system(extra.message);
  hub.emitStatus(status, extra.exitCode ?? null);
}

// ---------------------------------------------------------------------------
// Supervision
// ---------------------------------------------------------------------------

interface BootWatch {
  unsubscribe: () => void;
  readyTimer: NodeJS.Timeout;
}

/** Live console subscriptions this module holds — one per server it is supervising. */
const watches = new Map<string, BootWatch>();
/**
 * Servers whose exit was asked for. The supervisor reads this so a user pressing stop is
 * never mistaken for a crash and auto-restarted out from under them.
 */
const intentional = new Set<string>();
const crashHistory = new Map<string, number[]>();
const restartTimers = new Map<string, NodeJS.Timeout>();

let supervisorTimer: NodeJS.Timeout | null = null;
let supervisorRunning = false;
let supervisorLogger: LifecycleLogger | null = null;

function releaseWatch(serverId: string): void {
  const watch = watches.get(serverId);
  if (!watch) return;
  watches.delete(serverId);
  clearTimeout(watch.readyTimer);
  // Dropping the subscription is what lets the hub tear the driver stream down once the
  // last console viewer has also gone.
  watch.unsubscribe();
}

/**
 * Opens the console stream for a run and watches it for the blueprint's signals.
 *
 * Holding a subscription for the whole run is deliberate: it is Platter's own claim on the
 * stream, so ready detection keeps working when nobody has the console page open.
 */
function superviseRun(ctx: ServerContext): void {
  releaseWatch(ctx.server.id);

  const serverId = ctx.server.id;
  const hub = getLogHub(serverId);
  hub.attach({ driver: ctx.driver, signals: ctx.blueprint.signals, tail: CONSOLE_TAIL_LINES });

  const unsubscribe = hub.subscribe((event) => {
    if (event.type === 'ready') {
      void promoteToRunning(serverId);
    } else if (event.type === 'crash') {
      hub.system(`Crash signal matched: ${event.line.content}`);
    }
  });

  const readyTimer = setTimeout(() => {
    void promoteToRunning(serverId, 'No ready signal seen; assuming the server is up.');
  }, READY_TIMEOUT_MS);
  readyTimer.unref();

  watches.set(serverId, { unsubscribe, readyTimer });

  // A blueprint with no ready pattern has nothing to wait for, and leaving it `starting`
  // would block every action the UI gates on `running`.
  if (ctx.blueprint.signals.ready.length === 0) void promoteToRunning(serverId);
}

async function promoteToRunning(serverId: string, message?: string): Promise<void> {
  try {
    const server = await prisma.server.findUnique({
      where: { id: serverId },
      select: { status: true },
    });
    // Only ever promotes a boot in progress: a ready line replayed into a stopped server's
    // console must not resurrect it.
    if (!server || statusOf(server) !== 'starting') return;
    const watch = watches.get(serverId);
    if (watch) clearTimeout(watch.readyTimer);
    await setStatus(serverId, 'running', { startedAt: new Date(), ...(message ? { message } : {}) });
  } catch (error) {
    supervisorLogger?.warn({ err: error, serverId }, 'could not promote server to running');
  }
}

function cancelRestart(serverId: string): void {
  const timer = restartTimers.get(serverId);
  if (!timer) return;
  clearTimeout(timer);
  restartTimers.delete(serverId);
}

// ---------------------------------------------------------------------------
// Power actions
// ---------------------------------------------------------------------------

function assertAllowed(server: Server, action: PowerAction): void {
  const status = statusOf(server);
  if (!canPerformPowerAction(status, action)) {
    throw invalidState(
      `This server is ${status.replace(/_/g, ' ')}; ${action} is not available right now.`,
    );
  }
}

async function auditPower(
  ctx: ServerContext,
  action: string,
  actorId: string | null,
): Promise<void> {
  await recordAudit({
    action: 'server.power',
    targetType: 'server',
    targetId: ctx.server.id,
    targetName: ctx.server.name,
    actorId,
    metadata: { action },
  });
}

/** Starts the container. Assumes the caller has already checked the transition. */
async function runStart(ctx: ServerContext): Promise<void> {
  const state = await ctx.driver.inspect(ctx.server.id);
  if (!state.exists) {
    // Self-heal: an operator pruning containers should cost a recreate, not a reinstall.
    const containerId = await ctx.driver.recreate(buildSpec(ctx));
    await prisma.server.update({ where: { id: ctx.server.id }, data: { containerId } });
  }
  await ctx.driver.start(ctx.server.id);
  superviseRun(ctx);
}

/** Stops the container, preferring the blueprint's own shutdown command. */
async function runStop(ctx: ServerContext, force: boolean): Promise<void> {
  const stop = ctx.blueprint.stop;

  if (!force && stop.strategy === 'command' && stop.command && needsStdin(ctx.blueprint)) {
    // Best effort: a server that has already wedged cannot read its stdin, and the signal
    // below is the escalation that exists for exactly that case.
    await ctx.driver.writeStdin(ctx.server.id, stop.command).catch(() => undefined);
  }

  await ctx.driver.stop(ctx.server.id, {
    signal: stop.signal,
    timeoutSeconds: force ? 0 : stop.timeoutSeconds,
  });

  releaseWatch(ctx.server.id);
  // The container has exited, so its log stream is finished. Detaching explicitly means a
  // restart cannot race the old stream's teardown and end up with no console at all.
  getLogHub(ctx.server.id).detach();
}

export async function startServer(serverId: string, actorId: string | null = null): Promise<void> {
  const ctx = await loadContext(serverId);
  assertAllowed(ctx.server, 'start');
  if (ctx.server.installedAt === null) {
    throw invalidState('This server has not finished installing yet.');
  }

  cancelRestart(serverId);
  await setStatus(serverId, 'starting', { message: 'Starting server', exitCode: null });
  try {
    await runStart(ctx);
  } catch (error) {
    const platter = toPlatterError(error);
    await setStatus(serverId, 'offline', { message: `Could not start: ${platter.message}` });
    throw platter;
  }
  await auditPower(ctx, 'start', actorId);
}

export async function stopServer(
  serverId: string,
  actorId: string | null = null,
  options: { force?: boolean } = {},
): Promise<void> {
  const ctx = await loadContext(serverId);
  assertAllowed(ctx.server, 'stop');

  cancelRestart(serverId);
  crashHistory.delete(serverId);
  intentional.add(serverId);
  try {
    await setStatus(serverId, 'stopping', { message: 'Stopping server' });
    await runStop(ctx, options.force === true);
    const state = await ctx.driver.inspect(serverId);
    await setStatus(serverId, 'offline', { exitCode: state.exitCode, message: 'Server stopped' });
  } catch (error) {
    const platter = toPlatterError(error);
    // The container is in whatever state the driver left it in; the supervisor's next
    // pass reconciles the truth rather than this handler guessing at it.
    await setStatus(serverId, 'crashed', { message: `Could not stop cleanly: ${platter.message}` });
    throw platter;
  } finally {
    intentional.delete(serverId);
  }
  await auditPower(ctx, 'stop', actorId);
}

export async function killServer(serverId: string, actorId: string | null = null): Promise<void> {
  const ctx = await loadContext(serverId);
  assertAllowed(ctx.server, 'kill');

  cancelRestart(serverId);
  crashHistory.delete(serverId);
  intentional.add(serverId);
  try {
    await setStatus(serverId, 'stopping', { message: 'Killing server' });
    await ctx.driver.kill(serverId);
    releaseWatch(serverId);
    getLogHub(serverId).detach();
    const state = await ctx.driver.inspect(serverId);
    await setStatus(serverId, 'offline', { exitCode: state.exitCode, message: 'Server killed' });
  } finally {
    intentional.delete(serverId);
  }
  await auditPower(ctx, 'kill', actorId);
}

export async function restartServer(serverId: string, actorId: string | null = null): Promise<void> {
  const ctx = await loadContext(serverId);
  assertAllowed(ctx.server, 'restart');

  cancelRestart(serverId);
  crashHistory.delete(serverId);
  intentional.add(serverId);
  try {
    await setStatus(serverId, 'restarting', { message: 'Restarting server' });
    await runStop(ctx, false);
    await setStatus(serverId, 'starting', { exitCode: null });
    await runStart(ctx);
  } catch (error) {
    const platter = toPlatterError(error);
    await setStatus(serverId, 'crashed', { message: `Restart failed: ${platter.message}` });
    throw platter;
  } finally {
    intentional.delete(serverId);
  }
  await auditPower(ctx, 'restart', actorId);
}

export async function performPowerAction(
  serverId: string,
  action: PowerAction,
  actorId: string | null = null,
  options: { force?: boolean } = {},
): Promise<void> {
  switch (action) {
    case 'start':
      return startServer(serverId, actorId);
    case 'stop':
      return stopServer(serverId, actorId, options);
    case 'restart':
      return restartServer(serverId, actorId);
    case 'kill':
      return killServer(serverId, actorId);
  }
}

export async function sendCommand(
  serverId: string,
  command: string,
  actorId: string | null = null,
): Promise<void> {
  const ctx = await loadContext(serverId);
  const status = statusOf(ctx.server);
  if (status !== 'running' && status !== 'starting') {
    throw invalidState(`This server is ${status.replace(/_/g, ' ')}; it cannot accept commands.`);
  }
  if (!ctx.blueprint.features.console) {
    throw invalidState('This game does not accept console commands.');
  }

  // One line per command: a newline in the middle would let a single "command" queue
  // several, which is not what the caller was authorised to send.
  const line = command.replace(/[\r\n]+/g, ' ').trim();
  if (line.length === 0) throw badRequest('That command is empty.');
  if (line.length > LIMITS.maxConsoleLineLength) {
    throw badRequest(`Commands are limited to ${LIMITS.maxConsoleLineLength} characters.`);
  }

  await ctx.driver.writeStdin(serverId, line);
  getLogHub(serverId).system(`> ${line}`);
  await recordAudit({
    action: 'server.command',
    targetType: 'server',
    targetId: serverId,
    targetName: ctx.server.name,
    actorId,
    metadata: { command: line.slice(0, 200) },
  });
}

// ---------------------------------------------------------------------------
// Install / delete
// ---------------------------------------------------------------------------

const INSTALLABLE: readonly ServerStatus[] = ['provisioning', 'installing', 'install_failed'];

/**
 * Pulls the image, lays out the data directory and creates the container.
 *
 * Safe to run again after a crash mid-install: every step is either idempotent or
 * replaces what the previous attempt left behind, and `installing` is an accepted entry
 * status precisely so an interrupted install can be resumed rather than unwound.
 */
export async function installServer(serverId: string): Promise<void> {
  const ctx = await loadContext(serverId);
  const status = statusOf(ctx.server);
  if (!INSTALLABLE.includes(status)) {
    throw invalidState(`This server is ${status.replace(/_/g, ' ')}; it cannot be installed now.`);
  }

  const hub = getLogHub(serverId);
  await setStatus(serverId, 'installing', { message: `Installing ${ctx.blueprint.name}` });

  try {
    await mkdir(dataDirectoryFor(serverId), { recursive: true });

    let reported = -1;
    await ctx.driver.pullImage(ctx.blueprint.image, (progress) => {
      const percent = progress.progress === null ? -1 : Math.floor(progress.progress * 100);
      // Throttled to ten lines: a layered image emits thousands of progress events and
      // every one of them would land in the scrollback ring.
      if (percent < 0 || percent < reported + 10) return;
      reported = percent;
      hub.system(`Pulling ${ctx.blueprint.image}: ${percent}%`);
    });

    const env = buildEnv(ctx.blueprint, ctx.server, ctx.allocations, ctx.node.publicHost);
    await renderBlueprintFiles(ctx, env);

    const containerId = await ctx.driver.recreate(buildSpec(ctx));
    await setStatus(serverId, 'offline', {
      containerId,
      installedAt: new Date(),
      message: 'Install complete',
    });
  } catch (error) {
    const platter = toPlatterError(error);
    await setStatus(serverId, 'install_failed', { message: `Install failed: ${platter.message}` });
    throw platter;
  }
}

export async function reinstallServer(serverId: string, actorId: string | null = null): Promise<void> {
  const ctx = await loadContext(serverId);
  const status = statusOf(ctx.server);
  if (status === 'provisioning' || status === 'installing' || status === 'deleting') {
    throw invalidState(`This server is ${status.replace(/_/g, ' ')}; wait for that to finish first.`);
  }
  if (ctx.server.suspended) throw invalidState('This server is suspended.');

  if (status === 'running' || status === 'starting' || status === 'restarting') {
    intentional.add(serverId);
    try {
      await setStatus(serverId, 'stopping', { message: 'Stopping for reinstall' });
      await runStop(ctx, false);
    } finally {
      intentional.delete(serverId);
    }
  }

  cancelRestart(serverId);
  crashHistory.delete(serverId);
  // Files the operator owns are left alone; a reinstall replaces the container and any
  // blueprint file marked `overwrite`, which is what "reinstall" means here.
  await setStatus(serverId, 'provisioning', { message: 'Reinstalling' });
  await installServer(serverId);
  await recordAudit({
    action: 'server.reinstalled',
    targetType: 'server',
    targetId: serverId,
    targetName: ctx.server.name,
    actorId,
  });
}

async function removeDataDirectory(serverId: string): Promise<void> {
  const target = dataDirectoryFor(serverId);
  const root = path.resolve(config.serversDir);
  // Belt and braces before a recursive delete: the id comes from the database, but a
  // `rm -rf` is not the place to assume that will always be true.
  if (!path.resolve(target).startsWith(root + path.sep)) {
    throw new PlatterError('internal_error', 'Refusing to delete outside the server directory.');
  }
  await rm(target, { recursive: true, force: true });
}

export async function deleteServer(serverId: string, actorId: string | null = null): Promise<void> {
  const server = await loadServer(serverId);
  const previous = statusOf(server);

  cancelRestart(serverId);
  releaseWatch(serverId);
  intentional.add(serverId);
  try {
    await setStatus(serverId, 'deleting', { message: 'Deleting server' });
    // Removing the container first: if the node is unreachable we must not delete the row,
    // or the container keeps running with nothing left that knows how to stop it.
    await driverForNode(server.node).remove(serverId, { removeVolume: true });
  } catch (error) {
    await setStatus(serverId, previous, { message: 'Delete failed; the node did not answer.' });
    intentional.delete(serverId);
    throw toPlatterError(error);
  }

  try {
    await releasePorts(serverId);
    await removeDataDirectory(serverId);
    await prisma.server.delete({ where: { id: serverId } });
  } finally {
    intentional.delete(serverId);
  }

  crashHistory.delete(serverId);
  dropLogHub(serverId);
  await recordAudit({
    action: 'server.deleted',
    targetType: 'server',
    targetId: serverId,
    targetName: server.name,
    actorId,
    metadata: { nodeId: server.nodeId, blueprintKey: server.blueprintKey },
  });
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Boot-time drift repair.
 *
 * Platter is not the only thing that can change a container: it may have been down while
 * a server crashed, an operator may have run `docker stop`, and an install may have been
 * interrupted mid-flight. Every server is compared against what its node actually reports
 * and the database is corrected — never the other way round.
 */
export async function reconcile(logger?: LifecycleLogger): Promise<void> {
  const servers = await prisma.server.findMany({ include: { node: true } });
  const known = new Set(servers.map((server) => server.id));

  for (const server of servers) {
    const expected = statusOf(server);
    if (expected === 'deleting') {
      logger?.warn({ serverId: server.id }, 'server was mid-delete at shutdown; leaving it marked');
      continue;
    }

    let driver: OrchestrationDriver;
    try {
      driver = driverForNode(server.node);
    } catch (error) {
      logger?.warn({ serverId: server.id, err: error }, 'no usable driver for server');
      continue;
    }

    let state: ContainerState;
    try {
      state = await driver.inspect(server.id);
    } catch (error) {
      // An unreachable node tells us nothing about the container, and guessing would
      // either resurrect a dead server or bury a live one.
      logger?.warn({ serverId: server.id, err: error }, 'could not inspect server during reconcile');
      continue;
    }

    if (expected === 'installing') {
      await setStatus(server.id, 'install_failed', {
        message: 'The install was interrupted by a restart. Reinstall to try again.',
      });
      continue;
    }

    const derived = deriveStatus(state, expected);
    if (derived !== expected) {
      const crashed = derived === 'crashed';
      await setStatus(server.id, derived, {
        exitCode: state.exitCode,
        ...(crashed ? { crashedAt: new Date() } : {}),
        message: crashed
          ? `Server exited while Platter was down (code ${state.exitCode ?? 'unknown'}).`
          : `Status corrected to ${derived} on startup.`,
      });
    }

    if (state.running) {
      const ctx = await loadContext(server.id).catch((error: unknown) => {
        logger?.warn({ serverId: server.id, err: error }, 'cannot supervise server after restart');
        return null;
      });
      // Re-adopting the console stream is what makes the ready signal work for a server
      // that was already up before this process existed.
      if (ctx) superviseRun(ctx);
      continue;
    }

    if (server.autoStart && server.installedAt !== null && !server.suspended && derived === 'offline') {
      await startServer(server.id, null).catch((error: unknown) => {
        logger?.warn({ serverId: server.id, err: error }, 'auto-start failed during reconcile');
      });
    }
  }

  const nodes = await prisma.node.findMany({ select: { id: true, driver: true, endpoint: true } });
  for (const node of nodes) {
    try {
      const orphans = await driverForNode(node).listOrphans();
      for (const orphan of orphans) {
        if (known.has(orphan.serverId)) continue;
        // Flagged, never removed: a container Platter cannot account for may still be
        // somebody's game, and destroying it is not a decision to make automatically.
        logger?.warn(
          { nodeId: node.id, serverId: orphan.serverId, containerId: orphan.containerId },
          'orphaned container has no server record',
        );
      }
    } catch (error) {
      logger?.warn({ nodeId: node.id, err: error }, 'could not list containers for orphan sweep');
    }
  }
}

// ---------------------------------------------------------------------------
// Crash supervision
// ---------------------------------------------------------------------------

const WATCHED_STATUSES: readonly ServerStatus[] = ['starting', 'running', 'restarting', 'stopping'];

function recordCrash(serverId: string): number {
  const now = Date.now();
  const history = (crashHistory.get(serverId) ?? []).filter((at) => now - at < CRASH_WINDOW_MS);
  history.push(now);
  crashHistory.set(serverId, history);
  return history.length;
}

function scheduleRestart(serverId: string, attempt: number): number {
  const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** (attempt - 1));
  cancelRestart(serverId);
  const timer = setTimeout(() => {
    restartTimers.delete(serverId);
    void startServer(serverId, null).catch((error: unknown) => {
      supervisorLogger?.warn({ serverId, err: error }, 'auto-restart failed');
    });
  }, delay);
  timer.unref();
  restartTimers.set(serverId, timer);
  return delay;
}

async function handleExit(
  server: Server & { node: Node },
  exitCode: number | null,
  oomKilled: boolean,
): Promise<void> {
  const serverId = server.id;
  const clean = exitCode === 0 && !oomKilled;

  if (clean) {
    await setStatus(serverId, 'offline', { exitCode, message: 'Server exited.' });
    crashHistory.delete(serverId);
    return;
  }

  const reason = oomKilled ? 'out of memory' : `exit code ${exitCode ?? 'unknown'}`;
  await setStatus(serverId, 'crashed', {
    exitCode,
    crashedAt: new Date(),
    message: `Server crashed (${reason}).`,
  });

  if (!server.autoRestart || server.suspended) return;

  const crashes = recordCrash(serverId);
  if (crashes >= CRASH_LIMIT) {
    // Restarting a server that cannot stay up for a minute just burns the node. Stopping
    // leaves it `crashed`, which is the state the UI offers crash triage from.
    getLogHub(serverId).system(
      `Crashed ${crashes} times in under a minute — automatic restarts stopped.`,
    );
    supervisorLogger?.warn({ serverId, crashes }, 'crash loop detected; auto-restart disabled');
    return;
  }

  const delay = scheduleRestart(serverId, crashes);
  getLogHub(serverId).system(`Restarting automatically in ${Math.round(delay / 1000)}s.`);
}

/** One supervisor pass. Exported so tests drive it directly instead of racing a timer. */
export async function runCrashSupervisorPass(): Promise<void> {
  const servers = await prisma.server.findMany({
    where: { status: { in: [...WATCHED_STATUSES] } },
    include: { node: true },
  });

  for (const server of servers) {
    if (intentional.has(server.id)) continue;

    let state: ContainerState;
    try {
      state = await driverForNode(server.node).inspect(server.id);
    } catch (error) {
      supervisorLogger?.debug({ serverId: server.id, err: error }, 'supervisor could not inspect');
      continue;
    }
    if (state.running || state.restarting) continue;

    const expected = statusOf(server);
    if (expected === 'stopping') {
      // A stop whose caller went away (a request aborted, the process restarted).
      await setStatus(server.id, 'offline', { exitCode: state.exitCode, message: 'Server stopped' });
      releaseWatch(server.id);
      continue;
    }
    if (!state.exists) {
      await setStatus(server.id, 'offline', { message: 'The container no longer exists.' });
      releaseWatch(server.id);
      continue;
    }

    releaseWatch(server.id);
    await handleExit(server, state.exitCode, state.oomKilled);
  }
}

export interface CrashSupervisorOptions {
  intervalMs?: number;
  logger?: LifecycleLogger;
}

export function startCrashSupervisor(options: CrashSupervisorOptions = {}): void {
  if (supervisorTimer) return;
  supervisorLogger = options.logger ?? null;
  const interval = Math.max(250, options.intervalMs ?? SUPERVISOR_INTERVAL_MS);

  supervisorTimer = setInterval(() => {
    // Passes must not overlap: a slow node would otherwise have two of them racing to
    // decide whether the same container crashed.
    if (supervisorRunning) return;
    supervisorRunning = true;
    void runCrashSupervisorPass()
      .catch((error: unknown) => {
        supervisorLogger?.warn({ err: error }, 'crash supervisor pass failed');
      })
      .finally(() => {
        supervisorRunning = false;
      });
  }, interval);
  supervisorTimer.unref();
}

/** Also releases every console stream this module holds, so shutdown can complete. */
export function stopCrashSupervisor(): void {
  if (supervisorTimer) {
    clearInterval(supervisorTimer);
    supervisorTimer = null;
  }
  for (const timer of restartTimers.values()) clearTimeout(timer);
  restartTimers.clear();
  for (const serverId of [...watches.keys()]) releaseWatch(serverId);
  crashHistory.clear();
  intentional.clear();
  supervisorLogger = null;
}
