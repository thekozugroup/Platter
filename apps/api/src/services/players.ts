import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Node as NodeRow, Server as ServerRow } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { PlatterError, type Blueprint } from '@platter/shared';
import { prisma } from '../db.js';
import { notFound } from '../lib/errors.js';
import { getLogHub } from '../orchestration/log-buffer.js';
import { getDriverForNode } from '../orchestration/registry.js';
import {
  readMinecraftHealth,
  type HealthUnavailableReason,
  type MinecraftHealth,
} from '../minecraft/health.js';
import {
  assertIpAddress,
  assertPlayerName,
  assertReason,
  compilePlayerSignals,
  looksLikeFailure,
  matchPlayerEvent,
  parseBanlistOutput,
  parseListOutput,
  parseRosterJson,
  parseWhitelistOutput,
  playerCommands,
  type BanEntry,
  type CompiledPlayerSignals,
  type RosterFileEntry,
} from '../minecraft/players.js';
import { readServerProperties } from '../minecraft/properties.js';
import { tryQueryFull } from '../minecraft/query.js';
import {
  closeAllRcon,
  closeRcon,
  rconCommand,
  rconError,
  rconFailureOf,
  type RconEndpoint,
  type RconFailure,
} from '../minecraft/rcon.js';
import { getBlueprint } from './blueprints.js';
import { serverDataDir } from '../lib/paths.js';

/**
 * Who is on a server, who has been, and the administration commands that change that.
 *
 * Two independent sources feed this, because either one can be switched off:
 *
 * - **RCON** answers "who is online right now" exactly, and is the only way to kick, ban,
 *   op or edit the whitelist without attaching to the container.
 * - **The console log** yields joins and leaves from the blueprint's patterns. It works
 *   with RCON disabled, it works on games that have no RCON at all, and it is what makes
 *   playtime and "first seen" possible — RCON can only ever answer about *now*.
 *
 * Sessions are persisted, so a Platter restart does not reset every player's history.
 */

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * The roster lives in `Setting`, one JSON row per server.
 *
 * There is no player table in `prisma/schema.prisma`. This is a deliberate stand-in and
 * not a good long-term home — a real `PlayerSession` model would make "who was on at 9pm
 * last Tuesday" a query rather than an impossibility — but it is durable, it is portable
 * to Postgres unchanged, and it needs no schema change to ship. Flagged in the handover.
 */
const SETTING_PREFIX = 'players.';

/**
 * A busy public server sees thousands of unique names a year, and this is one row. The cap
 * keeps the blob a few tens of kilobytes; the least recently seen player is dropped first,
 * and anyone currently online is never dropped.
 */
const MAX_TRACKED_PLAYERS = 500;

/**
 * Joins arrive in bursts when a server opens. Writing the row per event would be dozens of
 * writes in a second for information nobody reads in real time.
 */
const FLUSH_DEBOUNCE_MS = 2_000;

/** How often the tracker set is reconciled against which servers are actually running. */
const DEFAULT_SYNC_INTERVAL_MS = 15_000;
const MIN_SYNC_INTERVAL_MS = 1_000;

/** The player list is polled by a UI; a slow query must not hold the request open. */
const QUERY_TIMEOUT_MS = 1_500;

interface StoredPlayer {
  name: string;
  /** Epoch milliseconds. Stored as numbers so the blob stays compact and cheap to parse. */
  firstSeen: number;
  lastSeen: number;
  sessions: number;
  /** Closed sessions only; a session in progress is added at read time. */
  playtimeMs: number;
  /** Set while the player is online, so a mid-session restart does not lose the time. */
  onlineSince: number | null;
}

type Roster = Map<string, StoredPlayer>;

function settingKey(serverId: string): string {
  return `${SETTING_PREFIX}${serverId}`;
}

function toStoredPlayer(value: unknown): StoredPlayer | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const name = record['name'];
  if (typeof name !== 'string' || name.length === 0) return null;

  const number = (key: string, fallback: number): number => {
    const raw = record[key];
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : fallback;
  };
  const onlineSince = record['onlineSince'];

  return {
    name,
    firstSeen: number('firstSeen', 0),
    lastSeen: number('lastSeen', 0),
    sessions: Math.trunc(number('sessions', 0)),
    playtimeMs: number('playtimeMs', 0),
    onlineSince:
      typeof onlineSince === 'number' && Number.isFinite(onlineSince) ? onlineSince : null,
  };
}

async function loadRoster(serverId: string): Promise<Roster> {
  const row = await prisma.setting.findUnique({ where: { key: settingKey(serverId) } });
  const roster: Roster = new Map();
  if (!row) return roster;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    // A corrupted blob costs history, not availability. Losing the row is better than
    // failing every player request until someone edits the database by hand.
    return roster;
  }
  if (!Array.isArray(parsed)) return roster;

  for (const item of parsed) {
    const player = toStoredPlayer(item);
    if (player) roster.set(player.name.toLowerCase(), player);
  }
  return roster;
}

/** Drops the least recently seen players once the cap is passed. Online players stay. */
function trim(roster: Roster): void {
  if (roster.size <= MAX_TRACKED_PLAYERS) return;
  const candidates = [...roster.entries()]
    .filter(([, player]) => player.onlineSince === null)
    .sort((left, right) => left[1].lastSeen - right[1].lastSeen);

  for (const [key] of candidates.slice(0, roster.size - MAX_TRACKED_PLAYERS)) {
    roster.delete(key);
  }
}

async function saveRoster(serverId: string, roster: Roster): Promise<void> {
  trim(roster);
  const value = JSON.stringify([...roster.values()]);
  await prisma.setting.upsert({
    where: { key: settingKey(serverId) },
    create: { key: settingKey(serverId), value },
    update: { value },
  });
}

// ---------------------------------------------------------------------------
// Session bookkeeping
// ---------------------------------------------------------------------------

function openSession(roster: Roster, name: string, now: number): boolean {
  const key = name.toLowerCase();
  const existing = roster.get(key);
  if (existing) {
    existing.lastSeen = now;
    // Already open: a duplicate join line (a reconnect the log recorded twice, or a
    // reconciliation catching up) must not restart the clock and lose the elapsed time.
    if (existing.onlineSince !== null) return false;
    existing.onlineSince = now;
    existing.sessions += 1;
    return true;
  }

  roster.set(key, {
    name,
    firstSeen: now,
    lastSeen: now,
    sessions: 1,
    playtimeMs: 0,
    onlineSince: now,
  });
  return true;
}

function closeSession(roster: Roster, name: string, now: number): boolean {
  const player = roster.get(name.toLowerCase());
  if (!player) return false;
  player.lastSeen = now;
  if (player.onlineSince === null) return false;
  // Guarded against a clock that moved backwards (NTP, a suspended host): a negative
  // duration would silently subtract from a real total.
  player.playtimeMs += Math.max(0, now - player.onlineSince);
  player.onlineSince = null;
  return true;
}

function closeAllSessions(roster: Roster, now: number): boolean {
  let changed = false;
  for (const player of roster.values()) {
    if (player.onlineSince === null) continue;
    player.playtimeMs += Math.max(0, now - player.onlineSince);
    player.onlineSince = null;
    player.lastSeen = now;
    changed = true;
  }
  return changed;
}

/**
 * Makes the roster agree with an online list from RCON or query.
 *
 * This is what repairs the log-derived view. A join line lost to a log rotation, or a
 * player who connected while Platter was restarting, shows up here and gets a session
 * opened; a leave line that never arrived gets one closed.
 *
 * `complete` is not decoration. Both sources truncate long name lists — Minecraft's `list`
 * caps its output and the query protocol caps its packet — and a truncated list looks
 * exactly like everyone else having left. Closing sessions is only safe when the source
 * reported as many names as it reported players, so a partial list only ever *adds*.
 */
function reconcileOnline(
  roster: Roster,
  online: readonly string[],
  now: number,
  complete: boolean,
): boolean {
  const present = new Set(online.map((name) => name.toLowerCase()));
  let changed = false;

  for (const name of online) {
    if (openSession(roster, name, now)) changed = true;
    else {
      const player = roster.get(name.toLowerCase());
      if (player) player.lastSeen = now;
    }
  }
  if (!complete) return changed;

  for (const [key, player] of roster) {
    if (player.onlineSince === null || present.has(key)) continue;
    if (closeSession(roster, player.name, now)) changed = true;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Server context
// ---------------------------------------------------------------------------

interface ServerContext {
  server: ServerRow;
  node: NodeRow;
  blueprint: Blueprint | null;
  allocations: Array<{ portName: string | null; hostIp: string; hostPort: number; protocol: string }>;
  variables: Record<string, string>;
}

function parseVariables(raw: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') values[key] = value;
  }
  return values;
}

async function loadContext(serverId: string): Promise<ServerContext> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    include: { node: true, allocations: true },
  });
  if (!server) throw notFound('server');

  let blueprint: Blueprint | null = null;
  try {
    blueprint = getBlueprint(server.blueprintKey);
  } catch {
    // A server whose blueprint file was removed still has a history worth showing.
    blueprint = null;
  }

  return {
    server,
    node: server.node,
    blueprint,
    allocations: server.allocations,
    variables: parseVariables(server.variables),
  };
}

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const FALSY = new Set(['false', '0', 'no', 'off']);

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalised = value.trim().toLowerCase();
  if (TRUTHY.has(normalised)) return true;
  if (FALSY.has(normalised)) return false;
  return fallback;
}

/**
 * The address this process reaches a published container port on.
 *
 * An allocation binds `0.0.0.0`, which is not an address anything can dial, so the node's
 * `publicHost` stands in — it is the operator's declaration of how this node is reached,
 * and it is already the address handed to players. A node whose allocations bind a
 * specific interface uses that instead.
 */
function hostFor(node: NodeRow, hostIp: string): string {
  return hostIp === '0.0.0.0' || hostIp === '::' || hostIp.length === 0 ? node.publicHost : hostIp;
}

/**
 * Minecraft: Java Edition only.
 *
 * `kick`, `ban`, `op` and `whitelist` are Minecraft's vocabulary. Several other blueprints
 * speak RCON, but they speak it with their own commands, and sending Minecraft's at them
 * would produce confident nonsense. Log-derived history below is game-agnostic and does
 * apply to all of them.
 */
function supportsPlayerAdministration(blueprint: Blueprint | null): boolean {
  return blueprint !== null && blueprint.features.rcon && blueprint.game === 'Minecraft';
}

type RconResolution =
  | { ok: true; endpoint: RconEndpoint }
  | { ok: false; reason: RconFailure; message: string };

/**
 * Works out where RCON is and what its password is.
 *
 * The password may come from the operator's `RCON_PASSWORD` variable or, when they left it
 * blank, from the `rcon.password` line the image generated into `server.properties`. Both
 * are checked, because the second is the default configuration — without it, RCON would be
 * unavailable on every server nobody explicitly configured.
 */
async function resolveRcon(context: ServerContext): Promise<RconResolution> {
  const { server, node, blueprint, variables } = context;
  const name = server.name;

  if (!supportsPlayerAdministration(blueprint)) {
    return {
      ok: false,
      reason: 'not_supported',
      message: `${name} does not speak Minecraft's remote console.`,
    };
  }
  if (server.suspended || server.status !== 'running') {
    return { ok: false, reason: 'offline', message: `${name} is not running.` };
  }
  if (!flag(variables['ENABLE_RCON'], true)) {
    return {
      ok: false,
      reason: 'not_enabled',
      message: `RCON is turned off on ${name}. Turn on "Enable RCON" in its settings and restart it.`,
    };
  }

  const allocation = context.allocations.find((row) => row.portName === 'rcon');
  if (!allocation) {
    return {
      ok: false,
      reason: 'not_enabled',
      message: `${name} has no RCON port. Reinstall it to pick one up.`,
    };
  }

  const configured = variables['RCON_PASSWORD']?.trim() ?? '';
  let password = configured;
  if (password.length === 0) {
    // The image generates one when the variable is blank and writes it here.
    const properties = await readServerProperties(server.id);
    password = properties?.get('rcon.password')?.trim() ?? '';
  }
  if (password.length === 0) {
    return {
      ok: false,
      reason: 'no_password',
      message: `Platter does not know ${name}'s RCON password yet. It appears after the first successful start, or you can set one in the server's settings.`,
    };
  }

  return {
    ok: true,
    endpoint: { host: hostFor(node, allocation.hostIp), port: allocation.hostPort, password },
  };
}

// ---------------------------------------------------------------------------
// Running commands
// ---------------------------------------------------------------------------

export interface PlayerCommandOptions {
  logger?: FastifyBaseLogger;
}

async function runRcon(
  context: ServerContext,
  command: string,
  options: PlayerCommandOptions = {},
): Promise<string> {
  const resolution = await resolveRcon(context);
  if (!resolution.ok) throw rconError(resolution.reason, resolution.message);

  return rconCommand(resolution.endpoint, command, {
    key: context.server.id,
    label: context.server.name,
    ...(options.logger ? { logger: options.logger } : {}),
  });
}

/**
 * Runs one console command over RCON.
 *
 * Exported for the scheduler and the console, which both need "send this to the game" with
 * a real answer rather than the write-to-stdin path that returns nothing.
 */
export async function sendRconCommand(
  serverId: string,
  command: string,
  options: PlayerCommandOptions = {},
): Promise<string> {
  if (/[\r\n]/.test(command)) {
    throw new PlatterError('bad_request', 'A console command cannot span multiple lines.');
  }
  return runRcon(await loadContext(serverId), command, options);
}

/** Whether RCON is usable right now, and why not when it is not. */
export async function rconStatus(
  serverId: string,
): Promise<{ available: boolean; reason: RconFailure | null; message: string | null }> {
  const resolution = await resolveRcon(await loadContext(serverId));
  return resolution.ok
    ? { available: true, reason: null, message: null }
    : { available: false, reason: resolution.reason, message: resolution.message };
}

// ---------------------------------------------------------------------------
// The server's roster files
// ---------------------------------------------------------------------------

async function readRosterFile(
  serverId: string,
  file: string,
  nameKey: 'name' | 'ip' = 'name',
): Promise<RosterFileEntry[]> {
  try {
    return parseRosterJson(await readFile(path.join(serverDataDir(serverId), file), 'utf8'), nameKey);
  } catch {
    // Missing before the first boot, and briefly unreadable while the server rewrites it.
    // Either way the roster degrades to "no flags" rather than failing the request.
    return [];
  }
}

interface RosterFlags {
  ops: Map<string, RosterFileEntry>;
  whitelist: Set<string>;
  bans: Map<string, RosterFileEntry>;
}

async function readRosterFlags(serverId: string): Promise<RosterFlags> {
  const [ops, whitelist, bans] = await Promise.all([
    readRosterFile(serverId, 'ops.json'),
    readRosterFile(serverId, 'whitelist.json'),
    readRosterFile(serverId, 'banned-players.json'),
  ]);

  return {
    ops: new Map(ops.map((entry) => [entry.name.toLowerCase(), entry])),
    whitelist: new Set(whitelist.map((entry) => entry.name.toLowerCase())),
    bans: new Map(bans.map((entry) => [entry.name.toLowerCase(), entry])),
  };
}

// ---------------------------------------------------------------------------
// The merged view
// ---------------------------------------------------------------------------

export interface PlayerRecord {
  name: string;
  online: boolean;
  /** Includes the session in progress, so it advances while a player is on. */
  playtimeMs: number;
  sessions: number;
  firstSeen: string | null;
  lastSeen: string | null;
  onlineSince: string | null;
  op: boolean;
  operatorLevel: number | null;
  whitelisted: boolean;
  banned: boolean;
  banReason: string | null;
}

export interface PlayerRoster {
  /** Where the online set came from. `logs` means nothing live could be reached. */
  source: 'rcon' | 'query' | 'logs';
  onlineCount: number;
  maxPlayers: number | null;
  /** Why the live sources were not used. Null when `source` is `rcon` or `query`. */
  unavailable: RconFailure | null;
  unavailableMessage: string | null;
  whitelistEnabled: boolean | null;
  players: PlayerRecord[];
}

function toRecord(player: StoredPlayer, flags: RosterFlags, now: number): PlayerRecord {
  const key = player.name.toLowerCase();
  const op = flags.ops.get(key);
  const ban = flags.bans.get(key);
  const live = player.onlineSince === null ? 0 : Math.max(0, now - player.onlineSince);

  return {
    name: player.name,
    online: player.onlineSince !== null,
    playtimeMs: player.playtimeMs + live,
    sessions: player.sessions,
    firstSeen: player.firstSeen > 0 ? new Date(player.firstSeen).toISOString() : null,
    lastSeen: player.lastSeen > 0 ? new Date(player.lastSeen).toISOString() : null,
    onlineSince: player.onlineSince === null ? null : new Date(player.onlineSince).toISOString(),
    op: op !== undefined,
    operatorLevel: op?.level ?? null,
    whitelisted: flags.whitelist.has(key),
    banned: ban !== undefined,
    banReason: ban?.reason ?? null,
  };
}

interface LiveOnline {
  source: 'rcon' | 'query' | 'logs';
  names: string[] | null;
  onlineCount: number | null;
  maxPlayers: number | null;
  /** Whether `names` holds everyone, or only as many as the server was willing to print. */
  complete: boolean;
  unavailable: RconFailure | null;
  unavailableMessage: string | null;
}

/**
 * Asks the server who is online, preferring RCON and falling back to the query protocol.
 *
 * Query is worth the second attempt: it is the source that survives `enable-rcon=false`,
 * which is a configuration plenty of operators choose deliberately. When neither answers,
 * the log-derived set stands on its own and the caller is told which it got.
 */
async function readOnline(context: ServerContext): Promise<LiveOnline> {
  const empty: LiveOnline = {
    source: 'logs',
    names: null,
    onlineCount: null,
    maxPlayers: null,
    complete: false,
    unavailable: null,
    unavailableMessage: null,
  };

  if (context.server.suspended || context.server.status !== 'running') {
    return { ...empty, unavailable: 'offline', unavailableMessage: 'This server is not running.' };
  }

  const resolution = await resolveRcon(context);
  if (resolution.ok) {
    try {
      const parsed = parseListOutput(
        await rconCommand(resolution.endpoint, playerCommands.list(), {
          key: context.server.id,
          label: context.server.name,
        }),
      );
      if (parsed) {
        return {
          source: 'rcon',
          names: parsed.players,
          onlineCount: parsed.online,
          maxPlayers: parsed.max,
          complete: parsed.players.length >= parsed.online,
          unavailable: null,
          unavailableMessage: null,
        };
      }
    } catch (error) {
      const reason = rconFailureOf(error);
      if (reason === null) throw error;
      empty.unavailable = reason;
      empty.unavailableMessage = error instanceof PlatterError ? error.message : null;
    }
  } else {
    empty.unavailable = resolution.reason;
    empty.unavailableMessage = resolution.message;
  }

  const queryPort = context.allocations.find((row) => row.portName === 'query');
  if (queryPort && flag(context.variables['ENABLE_QUERY'], true)) {
    const outcome = await tryQueryFull({
      host: hostFor(context.node, queryPort.hostIp),
      port: queryPort.hostPort,
      timeoutMs: QUERY_TIMEOUT_MS,
    });
    if (outcome.ok) {
      return {
        source: 'query',
        names: outcome.stat.players,
        onlineCount: outcome.stat.onlinePlayers,
        maxPlayers: outcome.stat.maxPlayers,
        complete: outcome.stat.players.length >= outcome.stat.onlinePlayers,
        unavailable: null,
        unavailableMessage: null,
      };
    }
  }

  return empty;
}

/**
 * The whole roster: who is on now, and everyone the server has ever seen.
 *
 * History comes back even when the server is off — that is the point of persisting it —
 * so this endpoint never fails just because nothing is running.
 */
export async function getPlayerRoster(serverId: string): Promise<PlayerRoster> {
  const context = await loadContext(serverId);
  const tracker = trackers.get(serverId);
  const roster = tracker?.roster ?? (await loadRoster(serverId));
  const now = Date.now();

  const [live, flags] = await Promise.all([readOnline(context), readRosterFlags(serverId)]);

  let changed = false;
  if (live.names !== null) changed = reconcileOnline(roster, live.names, now, live.complete);
  else if (context.server.suspended || context.server.status !== 'running') {
    // The server is down, so nobody is on it whatever the last log line said.
    changed = closeAllSessions(roster, now);
  }
  if (changed) await persist(serverId, roster, tracker);

  const players = [...roster.values()]
    .map((player) => toRecord(player, flags, now))
    .sort(
      (left, right) =>
        Number(right.online) - Number(left.online) ||
        (right.lastSeen ?? '').localeCompare(left.lastSeen ?? '') ||
        left.name.localeCompare(right.name),
    );

  const onlineFromRoster = players.filter((player) => player.online).length;
  const properties = await readServerProperties(serverId).catch(() => null);

  return {
    source: live.source,
    onlineCount: live.onlineCount ?? onlineFromRoster,
    maxPlayers: live.maxPlayers ?? properties?.getNumber('max-players') ?? null,
    unavailable: live.unavailable,
    unavailableMessage: live.unavailableMessage,
    whitelistEnabled: properties?.getBoolean('white-list') ?? null,
    players,
  };
}

/**
 * Just the counts, for the dashboard grid and the stats frame.
 *
 * Returns null rather than zero when nothing could be reached: "nobody is playing" and
 * "we could not ask" look identical as a number and are very different to an operator.
 */
export async function getPlayerCount(
  serverId: string,
): Promise<{ online: number; max: number | null } | null> {
  const context = await loadContext(serverId);
  const live = await readOnline(context);
  if (live.onlineCount === null) return null;
  return { online: live.onlineCount, max: live.maxPlayers };
}

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------

/** Raised when the game answered but refused. The text is the server's own words. */
function refused(command: string, output: string): PlatterError {
  return new PlatterError('bad_request', output.trim() || `${command} was refused.`);
}

async function runAdminCommand(
  serverId: string,
  command: string,
  options: PlayerCommandOptions = {},
): Promise<string> {
  const context = await loadContext(serverId);
  const output = await runRcon(context, command, options);
  if (looksLikeFailure(output)) throw refused(command, output);
  return output.trim();
}

export async function kickPlayer(
  serverId: string,
  name: string,
  reason: string | null = null,
  options: PlayerCommandOptions = {},
): Promise<string> {
  return runAdminCommand(
    serverId,
    playerCommands.kick(assertPlayerName(name), assertReason(reason)),
    options,
  );
}

export async function banPlayer(
  serverId: string,
  name: string,
  reason: string | null = null,
  options: PlayerCommandOptions = {},
): Promise<string> {
  return runAdminCommand(
    serverId,
    playerCommands.ban(assertPlayerName(name), assertReason(reason)),
    options,
  );
}

export async function pardonPlayer(
  serverId: string,
  name: string,
  options: PlayerCommandOptions = {},
): Promise<string> {
  return runAdminCommand(serverId, playerCommands.pardon(assertPlayerName(name)), options);
}

export async function banIp(
  serverId: string,
  ip: string,
  reason: string | null = null,
  options: PlayerCommandOptions = {},
): Promise<string> {
  return runAdminCommand(
    serverId,
    playerCommands.banIp(assertIpAddress(ip), assertReason(reason)),
    options,
  );
}

export async function pardonIp(
  serverId: string,
  ip: string,
  options: PlayerCommandOptions = {},
): Promise<string> {
  return runAdminCommand(serverId, playerCommands.pardonIp(assertIpAddress(ip)), options);
}

export async function setOperator(
  serverId: string,
  name: string,
  op: boolean,
  options: PlayerCommandOptions = {},
): Promise<string> {
  const player = assertPlayerName(name);
  return runAdminCommand(
    serverId,
    op ? playerCommands.op(player) : playerCommands.deop(player),
    options,
  );
}

export async function setWhitelisted(
  serverId: string,
  name: string,
  whitelisted: boolean,
  options: PlayerCommandOptions = {},
): Promise<string> {
  const player = assertPlayerName(name);
  return runAdminCommand(
    serverId,
    whitelisted ? playerCommands.whitelistAdd(player) : playerCommands.whitelistRemove(player),
    options,
  );
}

export async function setWhitelistEnabled(
  serverId: string,
  enabled: boolean,
  options: PlayerCommandOptions = {},
): Promise<string> {
  return runAdminCommand(
    serverId,
    enabled ? playerCommands.whitelistOn() : playerCommands.whitelistOff(),
    options,
  );
}

export interface WhitelistView {
  enabled: boolean | null;
  names: string[];
  /** True when the names came from the running server rather than from `whitelist.json`. */
  live: boolean;
}

/**
 * The whitelist, from the server when it is up and from `whitelist.json` when it is not.
 *
 * The file is what the server loads at boot, so reading it offline is not a guess — it is
 * the same list the server will use on its next start.
 */
export async function getWhitelist(serverId: string): Promise<WhitelistView> {
  const properties = await readServerProperties(serverId).catch(() => null);
  const enabled = properties?.getBoolean('white-list') ?? null;

  try {
    const parsed = parseWhitelistOutput(
      await runRcon(await loadContext(serverId), playerCommands.whitelistList()),
    );
    if (parsed) return { enabled, names: parsed, live: true };
  } catch (error) {
    if (rconFailureOf(error) === null) throw error;
  }

  const file = await readRosterFile(serverId, 'whitelist.json');
  return { enabled, names: file.map((entry) => entry.name), live: false };
}

export interface BanView {
  players: BanEntry[];
  ips: BanEntry[];
  live: boolean;
}

export async function getBans(serverId: string): Promise<BanView> {
  try {
    const context = await loadContext(serverId);
    const [players, ips] = await Promise.all([
      runRcon(context, playerCommands.banlistPlayers()),
      runRcon(context, playerCommands.banlistIps()),
    ]);
    return { players: parseBanlistOutput(players), ips: parseBanlistOutput(ips), live: true };
  } catch (error) {
    if (rconFailureOf(error) === null) throw error;
  }

  const [players, ips] = await Promise.all([
    readRosterFile(serverId, 'banned-players.json'),
    readRosterFile(serverId, 'banned-ips.json', 'ip'),
  ]);
  const toEntry = (entry: RosterFileEntry): BanEntry => ({
    target: entry.name,
    source: entry.source,
    reason: entry.reason,
  });
  return { players: players.map(toEntry), ips: ips.map(toEntry), live: false };
}

const HEALTH_REASONS: Record<RconFailure, HealthUnavailableReason> = {
  not_supported: 'unsupported',
  // Fixable from the settings page, which is the whole reason these are not `offline`.
  not_enabled: 'unconfigured',
  no_password: 'unconfigured',
  offline: 'offline',
  // The server is up and configured; the channel itself did not answer.
  timeout: 'unreadable',
  unreachable: 'unreadable',
  auth_failed: 'unreadable',
  protocol_error: 'unreadable',
};

/** Tick health, or an honest "this server does not report it". */
export async function getServerHealth(serverId: string): Promise<MinecraftHealth> {
  const context = await loadContext(serverId);
  const resolution = await resolveRcon(context);
  if (!resolution.ok) {
    // `resolveRcon` already distinguishes "this game has no RCON" from "RCON is off on this
    // server" from "the server is not up". Collapsing the middle case into `offline` is what
    // made a running server tell the operator to start it.
    return { tps: null, mspt: null, unavailable: HEALTH_REASONS[resolution.reason] };
  }
  return readMinecraftHealth((command) =>
    rconCommand(resolution.endpoint, command, {
      key: context.server.id,
      label: context.server.name,
    }),
  );
}

// ---------------------------------------------------------------------------
// Log-derived tracking
// ---------------------------------------------------------------------------

interface Tracker {
  serverId: string;
  roster: Roster;
  signals: CompiledPlayerSignals;
  unsubscribe: () => void;
  flushTimer: NodeJS.Timeout | null;
  dirty: boolean;
}

const trackers = new Map<string, Tracker>();
let syncTimer: NodeJS.Timeout | null = null;
let syncing = false;
let trackerLogger: FastifyBaseLogger | undefined;

async function persist(serverId: string, roster: Roster, tracker: Tracker | undefined): Promise<void> {
  if (tracker) {
    markDirty(tracker);
    return;
  }
  await saveRoster(serverId, roster);
}

function markDirty(tracker: Tracker): void {
  tracker.dirty = true;
  if (tracker.flushTimer) return;
  tracker.flushTimer = setTimeout(() => {
    tracker.flushTimer = null;
    void flush(tracker);
  }, FLUSH_DEBOUNCE_MS);
  // Unref'd: pending player history must never be the reason the process will not exit.
  tracker.flushTimer.unref();
}

async function flush(tracker: Tracker): Promise<void> {
  if (!tracker.dirty) return;
  tracker.dirty = false;
  try {
    await saveRoster(tracker.serverId, tracker.roster);
  } catch (error) {
    tracker.dirty = true;
    trackerLogger?.warn({ err: error, serverId: tracker.serverId }, 'could not save player history');
  }
}

/**
 * Starts watching one server's console for joins and leaves.
 *
 * The subscription is what keeps the log stream open. `LogHub` reference-counts its driver
 * stream and tears it down when the last watcher leaves, so without a listener here the
 * console output only exists while somebody has the console page open — and player history
 * would have holes shaped like "nobody was looking".
 */
async function startTracker(
  server: ServerRow & { node: NodeRow },
  blueprint: Blueprint,
): Promise<void> {
  if (trackers.has(server.id)) return;

  const roster = await loadRoster(server.id);
  const signals = compilePlayerSignals(blueprint.signals);
  const hub = getLogHub(server.id);

  const tracker: Tracker = {
    serverId: server.id,
    roster,
    signals,
    unsubscribe: () => undefined,
    flushTimer: null,
    dirty: false,
  };

  tracker.unsubscribe = hub.subscribe((event) => {
    if (event.type === 'status') {
      // The container went down; every open session ends with it.
      if (event.status !== 'running' && event.status !== 'starting') {
        if (closeAllSessions(roster, Date.now())) markDirty(tracker);
      }
      return;
    }
    if (event.type !== 'line') return;

    const match = matchPlayerEvent(event.line.content, signals);
    if (!match) return;
    const now = Date.now();
    const changed =
      match.kind === 'join'
        ? openSession(roster, match.name, now)
        : closeSession(roster, match.name, now);
    if (changed) markDirty(tracker);
  });

  trackers.set(server.id, tracker);

  // `attach` is idempotent, so this joins the stream lifecycle already opened for the boot
  // watcher rather than opening a second one.
  hub.attach({ driver: getDriverForNode(server.node), signals: blueprint.signals, tail: 0 });
}

async function stopTracker(serverId: string, closeSessions: boolean): Promise<void> {
  const tracker = trackers.get(serverId);
  if (!tracker) return;
  trackers.delete(serverId);

  tracker.unsubscribe();
  if (tracker.flushTimer) {
    clearTimeout(tracker.flushTimer);
    tracker.flushTimer = null;
  }
  if (closeSessions && closeAllSessions(tracker.roster, Date.now())) tracker.dirty = true;
  await flush(tracker);
  // The pooled RCON socket belongs to a server that is no longer running.
  closeRcon(serverId);
}

/**
 * Brings the tracker set in line with which servers are actually running.
 *
 * Driven by a poll rather than by lifecycle callbacks so it is self-healing: a server that
 * came up during a Platter restart, or one whose status changed without this module being
 * told, is picked up on the next pass instead of being invisible until it restarts.
 */
export async function syncPlayerTrackers(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    const rows = await prisma.server.findMany({
      where: { status: { in: ['running', 'starting'] }, suspended: false },
      include: { node: true },
    });

    const wanted = new Set<string>();
    for (const row of rows) {
      let blueprint: Blueprint;
      try {
        blueprint = getBlueprint(row.blueprintKey);
      } catch {
        continue;
      }
      // A blueprint with no join patterns has nothing to derive, and holding its log
      // stream open would be pure cost on the daemon.
      if (blueprint.signals.playerJoin.length === 0) continue;

      wanted.add(row.id);
      try {
        await startTracker(row, blueprint);
      } catch (error) {
        trackerLogger?.warn(
          { err: error, serverId: row.id },
          'could not start player tracking for this server',
        );
      }
    }

    for (const serverId of [...trackers.keys()]) {
      if (wanted.has(serverId)) continue;
      await stopTracker(serverId, true);
    }
  } finally {
    syncing = false;
  }
}

export interface PlayerTrackingOptions {
  intervalMs?: number;
  logger?: FastifyBaseLogger;
}

export function startPlayerTracking(options: PlayerTrackingOptions = {}): void {
  stopPlayerTracking();
  trackerLogger = options.logger;

  const interval = Math.max(MIN_SYNC_INTERVAL_MS, options.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS);
  syncTimer = setInterval(() => {
    void syncPlayerTrackers().catch((error: unknown) => {
      trackerLogger?.warn({ err: error }, 'player tracking sync failed');
    });
  }, interval);
  syncTimer.unref();

  void syncPlayerTrackers().catch((error: unknown) => {
    trackerLogger?.warn({ err: error }, 'player tracking sync failed');
  });
}

/**
 * Stops every tracker without closing sessions.
 *
 * Shutdown is not a departure: the players are still on the server, which keeps running as
 * a container. Their `onlineSince` stays set and the next start picks the session back up
 * where it left off.
 */
export function stopPlayerTracking(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  // Not awaited: this runs from a Fastify `onClose` hook and from tests, and the only work
  // outstanding is a debounced write of history that is already in the roster map.
  for (const serverId of [...trackers.keys()]) {
    void stopTracker(serverId, false);
  }
}

/** Called when a server is deleted: its history has nothing left to describe. */
export async function forgetPlayerHistory(serverId: string): Promise<void> {
  await stopTracker(serverId, false);
  await prisma.setting.deleteMany({ where: { key: settingKey(serverId) } });
}

/** Test hook. Drops every tracker and pooled socket without touching stored history. */
export function resetPlayerState(): void {
  stopPlayerTracking();
  closeAllRcon();
  trackerLogger = undefined;
}
