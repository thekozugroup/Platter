import { badRequest } from '../lib/errors.js';

/**
 * Reading and writing the player roster of a Minecraft server.
 *
 * Two sources, deliberately:
 *
 * - **RCON**, for anything live or mutating. `list`, `kick`, `ban`, `whitelist add` — the
 *   commands an operator would type at the console.
 * - **The JSON files the server writes** (`ops.json`, `whitelist.json`,
 *   `banned-players.json`, `usercache.json`), for reads when RCON is off. The server keeps
 *   them authoritative because it reloads them on every `/reload`, so parsing them is not
 *   a shortcut around the game — it is reading the same file the admin plugin ecosystem
 *   has read for a decade.
 *
 * The output parsing below carries the weight. Mojang has changed the wording of `list`
 * three times, Spigot changed it again, and none of those versions announce themselves, so
 * every known phrasing is matched rather than assumed.
 */

/**
 * Mojang's own rule: 3–16 characters of `[A-Za-z0-9_]`. Names shorter than three exist on
 * a handful of legacy accounts, so the floor here is one — the server is the authority on
 * whether a name resolves, and this only has to keep a command injection out of the socket.
 */
const NAME_PATTERN = /^[A-Za-z0-9_]{1,16}$/;

export function isValidPlayerName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/**
 * A player name goes into an RCON command line. Anything with a space, a newline or a
 * quote in it would change which command runs, so the shape is enforced at the boundary
 * rather than escaped — there is no legal Minecraft name that needs escaping.
 */
export function assertPlayerName(name: string): string {
  const trimmed = name.trim();
  if (!isValidPlayerName(trimmed)) {
    throw badRequest(
      'That is not a Minecraft username. Names are 1–16 letters, digits or underscores.',
    );
  }
  return trimmed;
}

/** Reasons are free text that reaches the same command line, so newlines are refused. */
export function assertReason(reason: string | null | undefined, limit = 200): string | null {
  if (reason === null || reason === undefined) return null;
  const trimmed = reason.trim();
  if (trimmed.length === 0) return null;
  if (/[\r\n]/.test(trimmed)) throw badRequest('A reason cannot span multiple lines.');
  return trimmed.slice(0, limit);
}

/** Dotted quad or a bare IPv6 form. Bans take an address, not a hostname. */
const IP_PATTERN = /^(?:(?:\d{1,3}\.){3}\d{1,3}|(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4})$/;

export function assertIpAddress(ip: string): string {
  const trimmed = ip.trim();
  if (!IP_PATTERN.test(trimmed)) throw badRequest('That is not an IP address.');
  return trimmed;
}

// ---------------------------------------------------------------------------
// Console output
// ---------------------------------------------------------------------------

/**
 * Section-sign colour codes. Spigot and most plugins colour their command output, and the
 * codes sit *inside* the numbers and names we are about to parse.
 */
const FORMATTING = /§[0-9a-fk-orA-FK-OR]/g;

export function stripFormatting(text: string): string {
  return text.replace(FORMATTING, '');
}

export interface PlayerListResult {
  online: number;
  max: number;
  players: string[];
}

/**
 * Every wording of the `list` header that has shipped.
 *
 * - `There are 3 of a max of 20 players online:` — vanilla 1.13 and later.
 * - `There are 3/20 players online:` — vanilla 1.7 through 1.12.
 * - `There are 3 out of maximum 20 players online.` — Spigot and its forks.
 * - `There are 3 of a max 20 players online:` — a 1.13-era vanilla wording without "of".
 */
const LIST_HEADERS: readonly RegExp[] = [
  /there are (\d+) of a max(?:imum)? (?:of )?(\d+) players? online/i,
  /there are (\d+) out of maximum (\d+) players? online/i,
  /there are (\d+)\s*\/\s*(\d+) players? online/i,
  /(\d+)\s*\/\s*(\d+) players? online/i,
];

/**
 * A name may come back decorated — `Alice (a1b2c3d4)` from a plugin that appends the UUID,
 * or `[Admin] Bob` from one that prefixes the rank. Both bracket styles are removed before
 * the name is taken, because otherwise the rank *is* the first word that looks like a
 * username and the roster fills up with players called "Admin".
 */
function cleanName(candidate: string): string | null {
  const undecorated = candidate.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '');
  const match = /[A-Za-z0-9_]{1,16}/.exec(undecorated.trim());
  if (!match) return null;
  return isValidPlayerName(match[0]) ? match[0] : null;
}

function namesFrom(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const part of text.split(',')) {
    const name = cleanName(part);
    if (name === null || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * Parses `list` output into counts and names, or null when the text is not a `list` reply
 * at all — which is what a vanilla server returns for a command it does not have, and what
 * a proxy returns for anything.
 *
 * The names may be on the header line after the colon (1.13+) or on the lines that follow
 * it (1.7–1.12, Spigot), so both are collected. The count comes from the header and is
 * trusted over `players.length`: the server truncates long name lists, and reporting 40
 * players when 40 are online but only 30 fit is more honest than reporting 30.
 */
export function parseListOutput(output: string): PlayerListResult | null {
  const text = stripFormatting(output);
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    for (const header of LIST_HEADERS) {
      const match = header.exec(line);
      if (!match) continue;

      const online = Number.parseInt(match[1] ?? '', 10);
      const max = Number.parseInt(match[2] ?? '', 10);
      const colon = line.indexOf(':', match.index);
      const tail = colon === -1 ? '' : line.slice(colon + 1);
      const rest = lines.slice(index + 1).join(',');

      return {
        online: Number.isInteger(online) ? online : 0,
        max: Number.isInteger(max) ? max : 0,
        players: namesFrom(`${tail},${rest}`),
      };
    }
  }
  return null;
}

/**
 * `whitelist list` output.
 *
 * Vanilla says `There are 3 whitelisted players: Alice, Bob`; older builds say
 * `whitelisted player(s)`; Bukkit says `White-listed players: Alice, Bob`. An empty
 * whitelist is `There are no whitelisted players`, which must parse to `[]` rather than to
 * null — "nobody is whitelisted" is an answer, not a failure.
 */
export function parseWhitelistOutput(output: string): string[] | null {
  const text = stripFormatting(output);
  if (/there are no whitelisted players/i.test(text)) return [];
  if (!/whitelist(ed)?[- ]?(list|players?)/i.test(text) && !/white-?listed/i.test(text)) {
    return null;
  }
  const colon = text.indexOf(':');
  return namesFrom(colon === -1 ? text.replace(/^[^A-Za-z0-9_]*/, '') : text.slice(colon + 1));
}

export interface BanEntry {
  /** A player name for `banlist players`, an address for `banlist ips`. */
  target: string;
  source: string | null;
  reason: string | null;
}

/**
 * `banlist players` / `banlist ips`.
 *
 * Each entry reads `Alice was banned by Server: Banned by an operator.` The name and the
 * reason are split on the first colon *after* the "banned by" clause, because a reason
 * routinely contains one.
 */
export function parseBanlistOutput(output: string): BanEntry[] {
  const text = stripFormatting(output);
  if (/there are no bans/i.test(text)) return [];

  const entries: BanEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\S+) was banned by ([^:]+)(?::\s*(.*))?$/i.exec(line.trim());
    if (!match) continue;
    const target = match[1];
    if (target === undefined) continue;
    entries.push({
      target,
      source: match[2]?.trim() ?? null,
      reason: match[3]?.trim() ? match[3].trim() : null,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// The server's own JSON files
// ---------------------------------------------------------------------------

export interface RosterFileEntry {
  name: string;
  uuid: string | null;
  /** Operator level from `ops.json`; null everywhere else. */
  level: number | null;
  reason: string | null;
  source: string | null;
  createdAt: string | null;
  expiresAt: string | null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Parses any of the server's roster files into one shape.
 *
 * `nameKey` differs per file — `banned-ips.json` keys the address as `ip` — and everything
 * else is optional, because the fields have come and gone across versions. A file that is
 * mid-write (the server truncates and rewrites it) parses as empty rather than throwing.
 */
export function parseRosterJson(text: string, nameKey: 'name' | 'ip' = 'name'): RosterFileEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const entries: RosterFileEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const name = stringField(record, nameKey);
    if (name === null) continue;

    const level = record['level'];
    entries.push({
      name,
      uuid: stringField(record, 'uuid'),
      level: typeof level === 'number' && Number.isInteger(level) ? level : null,
      reason: stringField(record, 'reason'),
      source: stringField(record, 'source'),
      createdAt: stringField(record, 'created'),
      expiresAt: stringField(record, 'expires'),
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Log-derived join and leave
// ---------------------------------------------------------------------------

export type PlayerEventKind = 'join' | 'leave';

export interface PlayerEvent {
  kind: PlayerEventKind;
  name: string;
}

export interface CompiledPlayerSignals {
  join: readonly RegExp[];
  leave: readonly RegExp[];
}

/** `<Alice> …`, with or without the `[Not Secure]` marker newer clients prefix. */
const CHAT_LINE = /<[A-Za-z0-9_]{1,16}>/;

/**
 * Blueprint patterns are authored data, so an unparseable one is an operator mistake and
 * not a reason to lose player tracking on every other pattern in the list.
 */
export function compilePlayerSignals(signals: {
  playerJoin: readonly string[];
  playerLeave: readonly string[];
}): CompiledPlayerSignals {
  const compile = (sources: readonly string[]): RegExp[] => {
    const compiled: RegExp[] = [];
    for (const source of sources) {
      try {
        compiled.push(new RegExp(source));
      } catch {
        // Reported by the blueprint loader at boot; silently skipped here.
      }
    }
    return compiled;
  };
  return { join: compile(signals.playerJoin), leave: compile(signals.playerLeave) };
}

/**
 * Matches one console line against the blueprint's player patterns.
 *
 * Every blueprint's join/leave patterns capture the player name as group 1 — that is a
 * contract with `blueprints/`, noted there too. A pattern that matches but captures
 * nothing usable produces no event rather than a player called `undefined`.
 *
 * Leave is checked first: `Alice left the game` also contains nothing that matches join,
 * but a modded server logging `Alice joined the game (was: left)` would match both, and
 * mistaking a departure for an arrival leaves a session open forever.
 */
export function matchPlayerEvent(line: string, signals: CompiledPlayerSignals): PlayerEvent | null {
  const text = stripFormatting(line);

  // Chat is echoed to the console, so `<Alice> anyone joined the game?` matches the join
  // pattern exactly as a real join does. The angle brackets are the one thing that
  // separates them: no server-generated join or leave line contains them.
  if (CHAT_LINE.test(text)) return null;

  for (const pattern of signals.leave) {
    const name = cleanName(pattern.exec(text)?.[1] ?? '');
    if (name !== null) return { kind: 'leave', name };
  }
  for (const pattern of signals.join) {
    const name = cleanName(pattern.exec(text)?.[1] ?? '');
    if (name !== null) return { kind: 'join', name };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * The command strings Platter sends.
 *
 * Centralised so every caller sends the same thing and so the arguments are validated in
 * exactly one place — these end up on a console line where a stray newline would be a
 * second, unaudited command.
 */
export const playerCommands = {
  list: (): string => 'list',
  kick: (name: string, reason: string | null): string =>
    reason === null ? `kick ${name}` : `kick ${name} ${reason}`,
  ban: (name: string, reason: string | null): string =>
    reason === null ? `ban ${name}` : `ban ${name} ${reason}`,
  pardon: (name: string): string => `pardon ${name}`,
  banIp: (ip: string, reason: string | null): string =>
    reason === null ? `ban-ip ${ip}` : `ban-ip ${ip} ${reason}`,
  pardonIp: (ip: string): string => `pardon-ip ${ip}`,
  banlistPlayers: (): string => 'banlist players',
  banlistIps: (): string => 'banlist ips',
  op: (name: string): string => `op ${name}`,
  deop: (name: string): string => `deop ${name}`,
  whitelistList: (): string => 'whitelist list',
  whitelistAdd: (name: string): string => `whitelist add ${name}`,
  whitelistRemove: (name: string): string => `whitelist remove ${name}`,
  whitelistOn: (): string => 'whitelist on',
  whitelistOff: (): string => 'whitelist off',
  whitelistReload: (): string => 'whitelist reload',
  say: (message: string): string => `say ${message}`,
} as const;

/**
 * Whether a command's output reads as a refusal.
 *
 * Minecraft answers over RCON with a sentence and no status code, so "did it work" has to
 * come from the text. Only the unambiguous failures are matched — a command whose output
 * we do not recognise is reported as having run, because it did.
 */
export function looksLikeFailure(output: string): boolean {
  const text = stripFormatting(output).trim();
  if (text.length === 0) return false;
  return (
    /^unknown or incomplete command/i.test(text) ||
    /^incorrect argument for command/i.test(text) ||
    /^expected /i.test(text) ||
    /that player does not exist/i.test(text) ||
    /no player was found/i.test(text) ||
    /^unknown command/i.test(text)
  );
}

/** True when the server does not implement the command at all (vanilla asked for `/tps`). */
export function isUnknownCommand(output: string): boolean {
  const text = stripFormatting(output).trim();
  return /^unknown or incomplete command/i.test(text) || /^unknown command/i.test(text);
}
