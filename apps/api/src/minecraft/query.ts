import { createSocket, type Socket } from 'node:dgram';
import { randomInt } from 'node:crypto';

/**
 * The Minecraft query protocol (GameSpy4 over UDP).
 *
 * This is the same read-only protocol every server-list website speaks: player counts, the
 * MOTD, the map name and — in the full response — the names of everyone online. It is worth
 * having alongside RCON because it needs no password and stays available on servers where
 * the operator has deliberately turned RCON off.
 *
 * A server with `enable-query=false` does not refuse the packet, it ignores it. There is
 * nothing to detect and nothing to wait for, so every call here is bounded by a short
 * timeout and answers "unavailable" rather than hanging a request behind it.
 */

const MAGIC = Buffer.from([0xfe, 0xfd]);

const PACKET_HANDSHAKE = 0x09;
const PACKET_STAT = 0x00;

const DEFAULT_TIMEOUT_MS = 2_000;
/** Two datagrams (handshake, then stat) each get the timeout; this bounds the pair. */
const MAX_TOTAL_TIMEOUT_MS = 8_000;

/**
 * A full stat response is a few kilobytes on a busy server. Anything far past that is not
 * a Minecraft server answering, and it arrives from whatever is listening on that port.
 */
const MAX_DATAGRAM_BYTES = 64 * 1024;

export interface QueryBasicStat {
  motd: string;
  gameType: string;
  map: string;
  onlinePlayers: number;
  maxPlayers: number;
  hostPort: number;
  hostIp: string;
}

export interface QueryFullStat extends QueryBasicStat {
  /** Everything the server reported, so a caller can read a key this build does not know. */
  raw: Record<string, string>;
  version: string;
  /** The `plugins` field, verbatim: `Paper on 1.21.1: EssentialsX 2.20.1; Vault 1.7.3`. */
  plugins: string;
  gameId: string;
  /** Truncated by the server itself at around 100 names — it is not an exhaustive list. */
  players: string[];
}

export type QueryFailure = 'timeout' | 'unreachable' | 'malformed';

export type QueryOutcome<T> = { ok: true; stat: T } | { ok: false; reason: QueryFailure };

export interface QueryOptions {
  host: string;
  port: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

class QueryError extends Error {
  readonly reason: QueryFailure;
  constructor(reason: QueryFailure, message: string) {
    super(message);
    this.name = 'QueryError';
    this.reason = reason;
  }
}

/**
 * Session ids must survive a round trip through servers that mask them: only the low four
 * bits of each byte are guaranteed to come back, so the id is generated inside that space
 * rather than masked afterwards.
 */
function newSessionId(): number {
  return randomInt(0, 0x0f0f0f0f) & 0x0f0f0f0f;
}

function handshakeRequest(sessionId: number): Buffer {
  const packet = Buffer.alloc(7);
  MAGIC.copy(packet, 0);
  packet.writeUInt8(PACKET_HANDSHAKE, 2);
  packet.writeInt32BE(sessionId, 3);
  return packet;
}

/**
 * The four trailing NUL bytes are what asks for a full stat rather than a basic one. They
 * are padding in the specification and a mode switch in every implementation.
 */
function statRequest(sessionId: number, token: number, full: boolean): Buffer {
  const packet = Buffer.alloc(full ? 15 : 11);
  MAGIC.copy(packet, 0);
  packet.writeUInt8(PACKET_STAT, 2);
  packet.writeInt32BE(sessionId, 3);
  packet.writeInt32BE(token, 7);
  return packet;
}

/** Reads a NUL-terminated string, returning it and the offset just past the terminator. */
function readCString(buffer: Buffer, offset: number): { value: string; next: number } {
  const end = buffer.indexOf(0, offset);
  if (end === -1) {
    return { value: buffer.toString('utf8', offset), next: buffer.length };
  }
  return { value: buffer.toString('utf8', offset, end), next: end + 1 };
}

/**
 * One request, one response, one socket.
 *
 * The socket is closed in every path — a leaked UDP handle keeps the event loop alive and
 * a daemon that polls player counts every few seconds would accumulate them quickly.
 */
function exchange(options: QueryOptions, request: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const socket: Socket = createSocket('udp4');
    let settled = false;

    const settle = (error: Error | null, response?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      socket.removeAllListeners();
      try {
        socket.close();
      } catch {
        // Already closed, or never bound. Nothing to release.
      }
      if (error) reject(error);
      else if (response) resolve(response);
    };

    const onAbort = (): void => {
      settle(new QueryError('timeout', 'The query was cancelled.'));
    };

    const timer = setTimeout(() => {
      settle(new QueryError('timeout', `${options.host} did not answer a query in time.`));
    }, timeoutMs);
    timer.unref();

    if (options.signal?.aborted) {
      settle(new QueryError('timeout', 'The query was cancelled.'));
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    socket.on('error', (error) => {
      settle(new QueryError('unreachable', `Could not query ${options.host}: ${error.message}`));
    });
    socket.on('message', (message) => {
      if (message.length > MAX_DATAGRAM_BYTES) {
        settle(new QueryError('malformed', 'The query response was larger than expected.'));
        return;
      }
      settle(null, message);
    });

    socket.send(request, options.port, options.host, (error) => {
      if (error) {
        settle(new QueryError('unreachable', `Could not query ${options.host}: ${error.message}`));
      }
    });
  });
}

/**
 * The challenge token, as a signed 32-bit integer.
 *
 * The server sends it as decimal *text*, not as a number, which is the one detail naive
 * implementations get wrong: it has to be parsed and re-encoded big-endian.
 */
function parseHandshake(response: Buffer): number {
  if (response.length < 5 || response.readUInt8(0) !== PACKET_HANDSHAKE) {
    throw new QueryError('malformed', 'The server did not answer the query handshake.');
  }
  const { value } = readCString(response, 5);
  const token = Number.parseInt(value.trim(), 10);
  if (!Number.isInteger(token)) {
    throw new QueryError('malformed', 'The query handshake returned an unreadable token.');
  }
  return token | 0;
}

function parseBasic(response: Buffer): QueryBasicStat {
  if (response.length < 5 || response.readUInt8(0) !== PACKET_STAT) {
    throw new QueryError('malformed', 'The server did not answer the query.');
  }
  let offset = 5;
  const fields: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const read = readCString(response, offset);
    fields.push(read.value);
    offset = read.next;
  }

  // The trailing host port is little-endian here and big-endian nowhere else in this
  // protocol. It is a quirk of the original GameSpy encoding, not a mistake.
  const hostPort = offset + 2 <= response.length ? response.readUInt16LE(offset) : 0;
  const hostIp = offset + 2 <= response.length ? readCString(response, offset + 2).value : '';

  return {
    motd: fields[0] ?? '',
    gameType: fields[1] ?? '',
    map: fields[2] ?? '',
    onlinePlayers: toCount(fields[3]),
    maxPlayers: toCount(fields[4]),
    hostPort,
    hostIp,
  };
}

function toCount(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Full stat: eleven bytes of padding, then NUL-separated key/value pairs until an empty
 * key, then ten more bytes of padding, then NUL-terminated player names until an empty one.
 *
 * The padding sections are constant strings (`splitnum`, `player_`) that no implementation
 * varies, so they are skipped by length rather than matched — matching them would reject
 * servers that pad slightly differently while carrying a perfectly readable payload.
 */
function parseFull(response: Buffer): QueryFullStat {
  if (response.length < 16 || response.readUInt8(0) !== PACKET_STAT) {
    throw new QueryError('malformed', 'The server did not answer the full query.');
  }

  let offset = 5 + 11;
  const raw: Record<string, string> = {};
  for (;;) {
    if (offset >= response.length) {
      throw new QueryError('malformed', 'The full query response ended mid-section.');
    }
    const key = readCString(response, offset);
    offset = key.next;
    if (key.value === '') break;
    const value = readCString(response, offset);
    offset = value.next;
    raw[key.value] = value.value;
  }

  offset += 10;
  const players: string[] = [];
  while (offset < response.length) {
    const player = readCString(response, offset);
    offset = player.next;
    if (player.value === '') break;
    players.push(player.value);
  }

  return {
    motd: raw['hostname'] ?? '',
    gameType: raw['gametype'] ?? '',
    gameId: raw['game_id'] ?? '',
    version: raw['version'] ?? '',
    plugins: raw['plugins'] ?? '',
    map: raw['map'] ?? '',
    onlinePlayers: toCount(raw['numplayers']),
    maxPlayers: toCount(raw['maxplayers']),
    hostPort: toCount(raw['hostport']),
    hostIp: raw['hostip'] ?? '',
    players,
    raw,
  };
}

function timeoutFor(options: QueryOptions): number {
  const requested = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(100, requested), MAX_TOTAL_TIMEOUT_MS / 2);
}

/** Player counts and the MOTD. One round trip after the handshake. */
export async function queryBasicStat(options: QueryOptions): Promise<QueryBasicStat> {
  const timeoutMs = timeoutFor(options);
  const sessionId = newSessionId();
  const token = parseHandshake(await exchange(options, handshakeRequest(sessionId), timeoutMs));
  return parseBasic(await exchange(options, statRequest(sessionId, token, false), timeoutMs));
}

/** Everything basic stat returns, plus the version, the plugin list and player names. */
export async function queryFullStat(options: QueryOptions): Promise<QueryFullStat> {
  const timeoutMs = timeoutFor(options);
  const sessionId = newSessionId();
  const token = parseHandshake(await exchange(options, handshakeRequest(sessionId), timeoutMs));
  return parseFull(await exchange(options, statRequest(sessionId, token, true), timeoutMs));
}

function outcomeOf(error: unknown): { ok: false; reason: QueryFailure } {
  return { ok: false, reason: error instanceof QueryError ? error.reason : 'unreachable' };
}

/**
 * The form callers should reach for.
 *
 * `enable-query=false` is a normal, common configuration, not an error worth an exception
 * and a stack trace on every poll — so silence comes back as a value.
 */
export async function tryQueryFull(options: QueryOptions): Promise<QueryOutcome<QueryFullStat>> {
  try {
    return { ok: true, stat: await queryFullStat(options) };
  } catch (error) {
    return outcomeOf(error);
  }
}

export async function tryQueryBasic(options: QueryOptions): Promise<QueryOutcome<QueryBasicStat>> {
  try {
    return { ok: true, stat: await queryBasicStat(options) };
  } catch (error) {
    return outcomeOf(error);
  }
}

export { QueryError };
