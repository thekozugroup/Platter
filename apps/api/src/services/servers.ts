import type { Allocation, Node as NodeRow, Prisma } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import {
  PlatterError,
  SERVER_PERMISSIONS,
  SERVER_STATUSES,
  formatAddress,
  formatMegabytes,
  roleAtLeast,
  type Blueprint,
  type BlueprintVariable,
  type CreateServerRequest,
  type ListServersQuery,
  type Paginated,
  type ResourceLimits,
  type Server,
  type ServerAllocation,
  type ServerPermission,
  type ServerStats,
  type ServerStatus,
  type ServerSubuser,
  type ServerSummary,
  type UpdateServerRequest,
  type UserRole,
} from '@platter/shared';
import { prisma } from '../db.js';
import { alreadyExists, badRequest, conflict, notFound, validationFailed } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { getDriver } from '../orchestration/registry.js';
import { allocatePorts, releasePorts } from './allocations.js';
import { getBlueprint } from './blueprints.js';
import { installServer } from './lifecycle.js';
import { getPlayerCount } from './players.js';
import type { AuthenticatedUser, ServerRecord } from '../plugins/auth.js';

/**
 * Everything between the `Server` row and the shapes `@platter/shared` puts on the wire.
 *
 * Three columns are JSON-in-TEXT because SQLite has no JSON type (`variables`, subuser
 * `permissions`) and one closed set is stored as a string (`status`). All of them are
 * parsed defensively on the way out: a row a human edited with `sqlite3`, or one written
 * by a newer build, degrades to something renderable instead of failing the whole page.
 */

/** Variable values become container environment variables, so they are bounded here. */
const MAX_VARIABLE_VALUE_LENGTH = 2048;

const ALL_SERVER_PERMISSIONS: ReadonlySet<ServerPermission> = new Set(SERVER_PERMISSIONS);

function isServerPermission(value: unknown): value is ServerPermission {
  return typeof value === 'string' && (SERVER_PERMISSIONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Row -> wire
// ---------------------------------------------------------------------------

function isServerStatus(value: string): value is ServerStatus {
  return (SERVER_STATUSES as readonly string[]).includes(value);
}

/**
 * The status a client should see.
 *
 * `suspended` is a column, not a status, so that suspending a running server does not
 * lose the fact that it was running. It wins over the stored status on the wire because
 * every permission and power-action table keys off the status alone.
 */
export function presentStatus(row: { status: string; suspended: boolean }): ServerStatus {
  if (row.suspended) return 'suspended';
  // An unrecognised status means the row outran this build. `offline` is the honest
  // fallback: it renders, and the only action it permits is a start, which reconciles.
  return isServerStatus(row.status) ? row.status : 'offline';
}

function parseVariables(raw: string, serverId: string, log?: FastifyBaseLogger): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log?.error({ serverId }, 'server variables column is not valid JSON');
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    // Non-string values would become `[object Object]` in the container environment.
    if (typeof value === 'string') values[key] = value;
  }
  return values;
}

/**
 * Unknown permission strings are dropped rather than kept. A grant this build cannot
 * interpret must never be treated as "allow" — that is how a downgrade becomes a
 * privilege escalation.
 */
export function parseServerPermissions(
  raw: string,
  serverId: string,
  log?: FastifyBaseLogger,
): ServerPermission[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log?.error({ serverId }, 'subuser permissions column is not valid JSON');
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const permissions = new Set<ServerPermission>();
  for (const value of parsed) {
    if (isServerPermission(value)) permissions.add(value);
  }
  return [...permissions];
}

/**
 * What this principal may do on this server, or null when they have no relationship to
 * it at all — the caller turns null into a 404, never a 403, so probing an id it cannot
 * see tells an attacker nothing.
 */
export async function serverPermissionsFor(
  server: { id: string; ownerId: string },
  user: { id: string; role: UserRole },
  log?: FastifyBaseLogger,
): Promise<ReadonlySet<ServerPermission> | null> {
  if (roleAtLeast(user.role, 'admin') || server.ownerId === user.id) return ALL_SERVER_PERMISSIONS;

  const subuser = await prisma.serverSubuser.findUnique({
    where: { serverId_userId: { serverId: server.id, userId: user.id } },
    select: { permissions: true },
  });
  if (!subuser) return null;
  return new Set(parseServerPermissions(subuser.permissions, server.id, log));
}

function toLimits(row: ServerRecord): ResourceLimits {
  return {
    memoryMb: row.memoryMb,
    diskMb: row.diskMb,
    cpuCores: row.cpuCores,
    swapMb: row.swapMb,
    ioWeight: row.ioWeight,
  };
}

/**
 * Allocations store the host side only; the container port belongs to the blueprint's
 * port definition, matched by name. A blueprint that has been removed from disk leaves us
 * without one, and the host port is the least wrong answer — it keeps the row renderable
 * so the operator can see what to clean up.
 */
function toAllocations(rows: readonly Allocation[], blueprint: Blueprint | null): ServerAllocation[] {
  const containerPorts = new Map(blueprint?.ports.map((port) => [port.name, port.containerPort]) ?? []);
  return rows
    .map((row) => ({
      name: row.portName ?? 'game',
      hostIp: row.hostIp,
      hostPort: row.hostPort,
      containerPort: containerPorts.get(row.portName ?? '') ?? row.hostPort,
      protocol: row.protocol === 'udp' ? ('udp' as const) : ('tcp' as const),
      primary: row.primary,
    }))
    .sort((left, right) => Number(right.primary) - Number(left.primary) || left.hostPort - right.hostPort);
}

export interface ServerWithAllocations extends ServerRecord {
  allocations: Allocation[];
}

export function toServerDto(
  row: ServerWithAllocations,
  blueprint: Blueprint | null,
  log?: FastifyBaseLogger,
): Server {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    blueprintKey: row.blueprintKey,
    nodeId: row.nodeId,
    ownerId: row.ownerId,
    status: presentStatus(row),
    containerId: row.containerId,
    limits: toLimits(row),
    allocations: toAllocations(row.allocations, blueprint),
    variables: parseVariables(row.variables, row.id, log),
    autoStart: row.autoStart,
    autoRestart: row.autoRestart,
    lastExitCode: row.lastExitCode,
    lastCrashAt: row.lastCrashAt?.toISOString() ?? null,
    installedAt: row.installedAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface SummaryRow extends ServerRecord {
  node: { publicHost: string };
  allocations: Allocation[];
}

function toServerSummary(row: SummaryRow): ServerSummary {
  const primary = row.allocations.find((allocation) => allocation.primary) ?? row.allocations[0];
  return {
    id: row.id,
    name: row.name,
    blueprintKey: row.blueprintKey,
    status: presentStatus(row),
    nodeId: row.nodeId,
    primaryAddress: primary ? formatAddress(row.node.publicHost, primary.hostPort) : null,
    memoryMb: row.memoryMb,
    cpuCores: row.cpuCores,
    // Player counts need a live query against the game; the grid must stay cheap enough
    // to poll, so they are filled in by the console socket's stats frames instead.
    playersOnline: null,
    playersMax: null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * `getBlueprint` throws for an unknown key, which is right for creation and wrong for
 * rendering: a server whose blueprint file was deleted must still be listable and
 * deletable.
 */
async function findBlueprint(key: string, log?: FastifyBaseLogger): Promise<Blueprint | null> {
  try {
    return await getBlueprint(key);
  } catch (error) {
    if (error instanceof PlatterError && error.code === 'not_found') {
      log?.warn({ blueprintKey: key }, 'server references a blueprint that is no longer installed');
      return null;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function loadServerDto(serverId: string, log?: FastifyBaseLogger): Promise<Server> {
  const row = await prisma.server.findUnique({
    where: { id: serverId },
    include: { allocations: true },
  });
  if (!row) throw notFound('server');
  return toServerDto(row, await findBlueprint(row.blueprintKey, log), log);
}

/**
 * Members see the servers they own plus the ones they have been invited to; admins and
 * owners see everything. The scope is a `where` clause rather than a post-filter so the
 * page count is correct — filtering after pagination silently returns short pages.
 */
export async function listServers(
  query: ListServersQuery,
  user: Pick<AuthenticatedUser, 'id' | 'role'>,
): Promise<Paginated<ServerSummary>> {
  const scope: Prisma.ServerWhereInput = roleAtLeast(user.role, 'admin')
    ? {}
    : { OR: [{ ownerId: user.id }, { subusers: { some: { userId: user.id } } }] };

  const filters: Prisma.ServerWhereInput[] = [scope];
  if (query.status) filters.push({ status: query.status });
  if (query.blueprintKey) filters.push({ blueprintKey: query.blueprintKey });
  if (query.nodeId) filters.push({ nodeId: query.nodeId });
  if (query.search) {
    const search = query.search.trim();
    if (search.length > 0) {
      // SQLite's LIKE is already case-insensitive for ASCII, and Prisma's `mode` option
      // is not supported on this provider — so no `mode: 'insensitive'` here.
      filters.push({
        OR: [{ name: { contains: search } }, { blueprintKey: { contains: search } }, { id: search }],
      });
    }
  }

  const where: Prisma.ServerWhereInput = { AND: filters };
  const orderBy: Prisma.ServerOrderByWithRelationInput =
    query.sort === 'name'
      ? { name: query.order }
      : query.sort === 'status'
        ? { status: query.order }
        : { createdAt: query.order };

  const [total, rows] = await Promise.all([
    prisma.server.count({ where }),
    prisma.server.findMany({
      where,
      orderBy,
      skip: (query.page - 1) * query.perPage,
      take: query.perPage,
      include: {
        node: { select: { publicHost: true } },
        allocations: { orderBy: [{ primary: 'desc' }, { hostPort: 'asc' }] },
      },
    }),
  ]);

  return {
    data: rows.map(toServerSummary),
    meta: {
      page: query.page,
      perPage: query.perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.perPage)),
    },
  };
}

// ---------------------------------------------------------------------------
// Variable validation
// ---------------------------------------------------------------------------

class FieldErrors {
  readonly #details: Record<string, string[]> = {};

  add(path: string, message: string): void {
    const existing = this.#details[path];
    if (existing) existing.push(message);
    else this.#details[path] = [message];
  }

  get empty(): boolean {
    return Object.keys(this.#details).length === 0;
  }

  throwIfAny(): void {
    if (!this.empty) throw validationFailed(this.#details);
  }
}

const TRUTHY = ['true', '1', 'yes', 'on'];
const FALSY = ['false', '0', 'no', 'off'];

function compilePattern(
  variable: BlueprintVariable,
  blueprintKey: string,
  log?: FastifyBaseLogger,
): RegExp | null {
  if (variable.pattern === null) return null;
  try {
    // Blueprint files are operator-supplied, so their patterns are trusted exactly as
    // much as the image reference in the same file. Inputs are length-capped above.
    return new RegExp(variable.pattern);
  } catch {
    log?.error(
      { blueprintKey, variable: variable.key },
      'blueprint variable pattern is not a valid regular expression; skipping the check',
    );
    return null;
  }
}

function validateOne(
  variable: BlueprintVariable,
  raw: string,
  blueprintKey: string,
  errors: FieldErrors,
  log?: FastifyBaseLogger,
): string | null {
  const path = `variables.${variable.key}`;

  if (raw.length > MAX_VARIABLE_VALUE_LENGTH) {
    errors.add(path, `Keep this under ${MAX_VARIABLE_VALUE_LENGTH} characters.`);
    return null;
  }

  switch (variable.type) {
    case 'number': {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        errors.add(path, `${variable.label} must be a number.`);
        return null;
      }
      if (variable.min !== null && parsed < variable.min) {
        errors.add(path, `${variable.label} cannot be below ${variable.min}.`);
        return null;
      }
      if (variable.max !== null && parsed > variable.max) {
        errors.add(path, `${variable.label} cannot be above ${variable.max}.`);
        return null;
      }
      // Normalised so `007` and `7` produce the same container environment.
      return String(parsed);
    }
    case 'boolean': {
      const normalised = raw.trim().toLowerCase();
      if (TRUTHY.includes(normalised)) return 'true';
      if (FALSY.includes(normalised)) return 'false';
      errors.add(path, `${variable.label} must be true or false.`);
      return null;
    }
    case 'enum': {
      if (variable.options.some((option) => option.value === raw)) return raw;
      errors.add(path, `Choose one of the offered options for ${variable.label}.`);
      return null;
    }
    case 'string':
    case 'password': {
      // For text, `min`/`max` bound the length — there is nothing else to compare.
      if (variable.min !== null && raw.length < variable.min) {
        errors.add(path, `${variable.label} needs at least ${variable.min} characters.`);
        return null;
      }
      if (variable.max !== null && raw.length > variable.max) {
        errors.add(path, `${variable.label} cannot be longer than ${variable.max} characters.`);
        return null;
      }
      const pattern = compilePattern(variable, blueprintKey, log);
      if (pattern && !pattern.test(raw)) {
        errors.add(path, `${variable.label} is not in the expected format.`);
        return null;
      }
      return raw;
    }
  }
}

/**
 * Resolves the values that will be written to the row.
 *
 * Only keys the blueprint declares survive: an unknown key in the request is dropped
 * rather than rejected, because it is either a stale form or an attempt to inject an
 * environment variable the blueprint never intended to expose.
 */
export function resolveVariables(
  blueprint: Blueprint,
  provided: Record<string, string>,
  log?: FastifyBaseLogger,
): Record<string, string> {
  const errors = new FieldErrors();
  const values: Record<string, string> = {};

  for (const variable of blueprint.variables) {
    // Hidden variables are the blueprint's own; a request cannot set them.
    const supplied = variable.hidden ? undefined : provided[variable.key];
    const fallback = variable.default === null ? undefined : String(variable.default);
    const raw = supplied !== undefined && supplied !== '' ? supplied : fallback;

    if (raw === undefined || raw === '') {
      if (variable.required) errors.add(`variables.${variable.key}`, `${variable.label} is required.`);
      continue;
    }

    const value = validateOne(variable, raw, blueprint.key, errors, log);
    if (value !== null) values[variable.key] = value;
  }

  errors.throwIfAny();
  return values;
}

// ---------------------------------------------------------------------------
// Limits and placement
// ---------------------------------------------------------------------------

function resolveLimits(blueprint: Blueprint, requested: Partial<ResourceLimits> | undefined): ResourceLimits {
  return {
    memoryMb: requested?.memoryMb ?? blueprint.recommendedMemoryMb,
    // The blueprint declares what the game needs on disk; there is no second, larger
    // "recommended" figure to fall back on.
    diskMb: requested?.diskMb ?? blueprint.minDiskMb,
    // 0 is "no quota", which is the right default for a self-hosted box: capping CPU on
    // a machine with spare cores only makes the game stutter.
    cpuCores: requested?.cpuCores ?? 0,
    swapMb: requested?.swapMb ?? 0,
    ioWeight: requested?.ioWeight ?? 500,
  };
}

/** Field-level so the create form can highlight the input, and it names the minimum. */
function assertMeetsBlueprintMinimums(blueprint: Blueprint, limits: ResourceLimits): void {
  const errors = new FieldErrors();
  if (limits.memoryMb < blueprint.minMemoryMb) {
    errors.add(
      'limits.memoryMb',
      `${blueprint.name} needs at least ${formatMegabytes(blueprint.minMemoryMb)} of memory.`,
    );
  }
  if (limits.diskMb < blueprint.minDiskMb) {
    errors.add(
      'limits.diskMb',
      `${blueprint.name} needs at least ${formatMegabytes(blueprint.minDiskMb)} of disk.`,
    );
  }
  errors.throwIfAny();
}

interface NodeUsage {
  memoryMb: number;
  diskMb: number;
}

async function usageOfNode(nodeId: string, excludeServerId?: string): Promise<NodeUsage> {
  const totals = await prisma.server.aggregate({
    where: excludeServerId ? { nodeId, id: { not: excludeServerId } } : { nodeId },
    _sum: { memoryMb: true, diskMb: true },
  });
  return { memoryMb: totals._sum.memoryMb ?? 0, diskMb: totals._sum.diskMb ?? 0 };
}

function capacityOf(node: NodeRow): NodeUsage {
  // Overcommit applies to memory only. Disk is not reclaimable the way idle RAM is —
  // overselling it means a game server dies mid-write instead of swapping.
  return {
    memoryMb: Math.floor(node.memoryTotalMb * node.overcommitRatio),
    diskMb: node.diskTotalMb,
  };
}

function assertFits(node: NodeRow, used: NodeUsage, limits: ResourceLimits): void {
  const capacity = capacityOf(node);
  if (used.memoryMb + limits.memoryMb > capacity.memoryMb) {
    throw new PlatterError(
      'insufficient_resources',
      `${node.name} has ${formatMegabytes(Math.max(0, capacity.memoryMb - used.memoryMb))} of memory left, and this server needs ${formatMegabytes(limits.memoryMb)}.`,
    );
  }
  if (used.diskMb + limits.diskMb > capacity.diskMb) {
    throw new PlatterError(
      'insufficient_resources',
      `${node.name} has ${formatMegabytes(Math.max(0, capacity.diskMb - used.diskMb))} of disk left, and this server needs ${formatMegabytes(limits.diskMb)}.`,
    );
  }
}

/**
 * Placement: the caller's node if they named one, otherwise the node with the most free
 * memory. Greedy rather than clever on purpose — a self-hosted panel usually has one
 * node, and "most free memory" is the heuristic an operator would apply by hand.
 */
async function selectNode(nodeId: string | undefined, limits: ResourceLimits): Promise<NodeRow> {
  if (nodeId !== undefined) {
    const node = await prisma.node.findUnique({ where: { id: nodeId } });
    if (!node) throw validationFailed({ nodeId: ['That node does not exist.'] });
    assertFits(node, await usageOfNode(node.id), limits);
    return node;
  }

  const nodes = await prisma.node.findMany({ where: { status: { not: 'offline' } } });
  if (nodes.length === 0) {
    throw new PlatterError('service_unavailable', 'No node is available to run servers yet.');
  }

  const candidates = await Promise.all(
    nodes.map(async (node) => {
      const used = await usageOfNode(node.id);
      return { node, used, freeMemoryMb: capacityOf(node).memoryMb - used.memoryMb };
    }),
  );
  candidates.sort((left, right) => right.freeMemoryMb - left.freeMemoryMb);

  const best = candidates[0];
  // Non-null by construction: `nodes` is non-empty, so `candidates` is too.
  if (!best) throw new PlatterError('service_unavailable', 'No node is available to run servers yet.');
  assertFits(best.node, best.used, limits);
  return best.node;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * Runs the install without holding the response open. Failures land on the server's
 * status through the lifecycle service, so the only thing left to do here is make sure a
 * rejected promise is never unhandled.
 */
function startInstall(serverId: string, log: FastifyBaseLogger): void {
  void Promise.resolve()
    .then(() => installServer(serverId))
    .catch((error: unknown) => {
      log.error({ err: error, serverId }, 'install could not be started');
    });
}

/**
 * Undoes a partially created server. Each step is independently guarded: a rollback that
 * throws would replace the real failure with its own, and the operator would be told the
 * wrong thing about why their server was not created.
 */
async function rollbackCreate(serverId: string, log: FastifyBaseLogger): Promise<void> {
  try {
    await releasePorts(serverId);
  } catch (error) {
    log.error({ err: error, serverId }, 'could not release ports while rolling back a create');
  }
  try {
    await prisma.server.delete({ where: { id: serverId } });
  } catch (error) {
    log.error({ err: error, serverId }, 'could not remove the server row while rolling back a create');
  }
}

/**
 * Takes ownership of the ports the allocator handed us.
 *
 * The guard on `serverId: null` is what makes two simultaneous creates safe: the
 * allocator can hand the same free row to both, and exactly one `updateMany` claims it.
 * The loser sees a short count and rolls back rather than sharing a port.
 */
async function claimAllocations(serverId: string, allocationIds: readonly string[]): Promise<void> {
  if (allocationIds.length === 0) return;
  const claimed = await prisma.allocation.updateMany({
    where: { id: { in: [...allocationIds] }, serverId: null },
    data: { serverId },
  });
  if (claimed.count !== allocationIds.length) {
    throw new PlatterError(
      'no_allocation_available',
      'Another server claimed those ports first. Try again.',
      { retryable: true },
    );
  }
}

export async function createServer(
  input: CreateServerRequest,
  owner: Pick<AuthenticatedUser, 'id' | 'role'>,
  log: FastifyBaseLogger,
): Promise<Server> {
  let blueprint: Blueprint;
  try {
    blueprint = await getBlueprint(input.blueprintKey);
  } catch (error) {
    // A missing blueprint is a bad field on a form, not a missing page.
    if (error instanceof PlatterError && error.code === 'not_found') {
      throw validationFailed({ blueprintKey: ['No blueprint with that key is installed.'] });
    }
    throw error;
  }

  const limits = resolveLimits(blueprint, input.limits);
  assertMeetsBlueprintMinimums(blueprint, limits);
  const variables = resolveVariables(blueprint, input.variables, log);
  const node = await selectNode(input.nodeId, limits);

  const allocations = await allocatePorts(node.id, input.ports, blueprint.ports);

  const serverId = newId('srv');
  await prisma.server.create({
    data: {
      id: serverId,
      name: input.name,
      description: input.description,
      blueprintKey: blueprint.key,
      nodeId: node.id,
      ownerId: owner.id,
      status: 'provisioning',
      memoryMb: limits.memoryMb,
      diskMb: limits.diskMb,
      cpuCores: limits.cpuCores,
      swapMb: limits.swapMb,
      ioWeight: limits.ioWeight,
      variables: JSON.stringify(variables),
      autoStart: input.autoStart,
      autoRestart: input.autoRestart,
    },
  });

  // Everything from here on has a created row behind it, so every failure has to undo it.
  try {
    await claimAllocations(
      serverId,
      allocations.map((allocation) => allocation.id),
    );

    const created = await prisma.server.findUnique({
      where: { id: serverId },
      include: { allocations: true },
    });
    if (!created) throw notFound('server');

    const dto = toServerDto(created, blueprint, log);
    if (input.startOnCreate) startInstall(serverId, log);
    return dto;
  } catch (error) {
    await rollbackCreate(serverId, log);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateServer(
  server: ServerRecord,
  input: UpdateServerRequest,
  log: FastifyBaseLogger,
): Promise<Server> {
  const blueprint = await findBlueprint(server.blueprintKey, log);

  const data: Prisma.ServerUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.autoStart !== undefined) data.autoStart = input.autoStart;
  if (input.autoRestart !== undefined) data.autoRestart = input.autoRestart;

  if (input.limits) {
    const limits: ResourceLimits = { ...toLimits(server), ...input.limits };
    if (blueprint) {
      assertMeetsBlueprintMinimums(blueprint, limits);
      const node = await prisma.node.findUnique({ where: { id: server.nodeId } });
      // Capacity is re-checked against every *other* server on the node, so raising this
      // one's memory cannot be validated against its own old figure.
      if (node) assertFits(node, await usageOfNode(node.id, server.id), limits);
    }
    data.memoryMb = limits.memoryMb;
    data.diskMb = limits.diskMb;
    data.cpuCores = limits.cpuCores;
    data.swapMb = limits.swapMb;
    data.ioWeight = limits.ioWeight;
  }

  if (input.variables) {
    if (!blueprint) {
      throw conflict('That blueprint is no longer installed, so its settings cannot be changed.');
    }
    // Merged with what is stored: a form that only submits the fields it rendered must
    // not silently clear the variables it did not.
    const merged = { ...parseVariables(server.variables, server.id, log), ...input.variables };
    data.variables = JSON.stringify(resolveVariables(blueprint, merged, log));
  }

  const updated = await prisma.server.update({
    where: { id: server.id },
    data,
    include: { allocations: true },
  });
  // New limits and variables reach the container when it is next created; the lifecycle
  // service recreates from the row on start, so nothing is applied behind the operator.
  return toServerDto(updated, blueprint, log);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export async function getServerStats(server: ServerRecord): Promise<ServerStats> {
  const status = presentStatus(server);
  const driver = await getDriver(server.nodeId);

  const [usage, diskBytes, players] = await Promise.all([
    driver.usage(server.id),
    // A server that has never installed has no data directory yet. That is a zero, not a
    // failure of the whole stats call.
    driver.diskUsage(server.id).catch(() => 0),
    // One live query (RCON, else the game's query port) against one server. Affordable
    // here in a way it is not in the list endpoint. A failure means "we could not ask",
    // which stays null rather than being reported as an empty server.
    status === 'running' ? getPlayerCount(server.id).catch(() => null) : Promise.resolve(null),
  ]);

  const startedAt = server.startedAt;
  const uptimeSeconds =
    status === 'running' && startedAt
      ? Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000))
      : 0;

  return {
    serverId: server.id,
    status,
    cpuPercent: usage?.cpuPercent ?? 0,
    memoryBytes: usage?.memoryBytes ?? 0,
    memoryLimitBytes: usage?.memoryLimitBytes ?? server.memoryMb * 1024 * 1024,
    diskBytes,
    networkRxBytes: usage?.networkRxBytes ?? 0,
    networkTxBytes: usage?.networkTxBytes ?? 0,
    uptimeSeconds,
    playersOnline: players?.online ?? null,
    playersMax: players?.max ?? null,
    sampledAt: (usage?.sampledAt ?? new Date()).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Console input
// ---------------------------------------------------------------------------

/**
 * Console input is written to the container's stdin, where a newline ends the command —
 * so a value containing one is two commands, and the second was never authorised or
 * audited. Rejected rather than trimmed for exactly that reason.
 */
export function assertSendableCommand(server: ServerRecord, command: string): void {
  if (/[\r\n]/.test(command)) throw badRequest('A console command cannot span multiple lines.');
  if (command.trim().length === 0) throw badRequest('Enter a command to send.');

  const status = presentStatus(server);
  if (status !== 'running') {
    throw new PlatterError('invalid_state', `${server.name} is ${status}, so it cannot take a command.`);
  }
}

// ---------------------------------------------------------------------------
// Subusers
// ---------------------------------------------------------------------------

const SUBUSER_INCLUDE = {
  user: {
    select: { id: true, email: true, username: true, displayName: true, avatarColor: true },
  },
} as const;

interface SubuserRowWithUser {
  id: string;
  permissions: string;
  createdAt: Date;
  serverId: string;
  user: { id: string; email: string; username: string; displayName: string; avatarColor: string };
}

function toSubuser(row: SubuserRowWithUser, log?: FastifyBaseLogger): ServerSubuser {
  return {
    id: row.id,
    userId: row.user.id,
    email: row.user.email,
    username: row.user.username,
    displayName: row.user.displayName,
    avatarColor: row.user.avatarColor,
    permissions: parseServerPermissions(row.permissions, row.serverId, log),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listSubusers(serverId: string, log?: FastifyBaseLogger): Promise<ServerSubuser[]> {
  const rows = await prisma.serverSubuser.findMany({
    where: { serverId },
    include: SUBUSER_INCLUDE,
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row) => toSubuser(row, log));
}

/** De-duplicated and ordered like `SERVER_PERMISSIONS`, so stored grants compare equal. */
function normalisePermissions(permissions: readonly ServerPermission[]): ServerPermission[] {
  const granted = new Set(permissions);
  return SERVER_PERMISSIONS.filter((permission) => granted.has(permission));
}

export async function addSubuser(
  server: ServerRecord,
  email: string,
  permissions: readonly ServerPermission[],
  log?: FastifyBaseLogger,
): Promise<ServerSubuser> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, suspended: true } });
  if (!user) throw validationFailed({ email: ['No Platter account uses that email.'] });
  if (user.suspended) throw validationFailed({ email: ['That account is suspended.'] });
  if (user.id === server.ownerId) {
    throw badRequest('The owner already has full access to this server.');
  }

  const existing = await prisma.serverSubuser.findUnique({
    where: { serverId_userId: { serverId: server.id, userId: user.id } },
    select: { id: true },
  });
  if (existing) throw alreadyExists('collaborator');

  const row = await prisma.serverSubuser.create({
    data: {
      id: newId('sub'),
      serverId: server.id,
      userId: user.id,
      permissions: JSON.stringify(normalisePermissions(permissions)),
    },
    include: SUBUSER_INCLUDE,
  });
  return toSubuser(row, log);
}

export async function updateSubuser(
  serverId: string,
  subuserId: string,
  permissions: readonly ServerPermission[],
  log?: FastifyBaseLogger,
): Promise<ServerSubuser> {
  // Scoped by serverId as well as id: a subuser id from another server must not resolve.
  const existing = await prisma.serverSubuser.findFirst({
    where: { id: subuserId, serverId },
    select: { id: true },
  });
  if (!existing) throw notFound('collaborator');

  const row = await prisma.serverSubuser.update({
    where: { id: existing.id },
    data: { permissions: JSON.stringify(normalisePermissions(permissions)) },
    include: SUBUSER_INCLUDE,
  });
  return toSubuser(row, log);
}

export async function removeSubuser(
  serverId: string,
  subuserId: string,
): Promise<{ userId: string; email: string }> {
  const existing = await prisma.serverSubuser.findFirst({
    where: { id: subuserId, serverId },
    include: SUBUSER_INCLUDE,
  });
  if (!existing) throw notFound('collaborator');

  await prisma.serverSubuser.delete({ where: { id: existing.id } });
  return { userId: existing.user.id, email: existing.user.email };
}
