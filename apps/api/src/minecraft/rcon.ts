import { Socket } from 'node:net';
import { PlatterError } from '@platter/shared';
import type { FastifyBaseLogger } from 'fastify';

/**
 * A Source RCON client.
 *
 * RCON is the remote console protocol Valve shipped with the Source engine and that
 * Minecraft, Rust, Project Zomboid and most other dedicated servers implement verbatim. It
 * is administration, not gameplay: everything Platter sends over it is a command an
 * operator could type at the server console. See docs/ARCHITECTURE.md §1.
 *
 * The wire format is little-endian and length-prefixed:
 *
 *   int32 length     bytes that follow, excluding this field
 *   int32 id         echoed by the server, which is the only way to correlate a response
 *   int32 type       3 = auth, 2 = auth response / command, 0 = response value
 *   bytes body       the command or its output
 *   byte  0          terminates the body
 *   byte  0          terminates the packet
 */

export const RCON_TYPE = {
  auth: 3,
  /** Doubles as SERVERDATA_AUTH_RESPONSE on the way back — the protocol reuses the number. */
  command: 2,
  response: 0,
  /**
   * Not in the protocol. Any type a server does not implement will do; this one is used
   * for the end-of-response sentinel described on `command` below.
   */
  sentinel: 100,
} as const;

/** Header is length + id + type; the body is followed by two NUL bytes. */
const HEADER_BYTES = 12;
const TERMINATOR_BYTES = 2;
const MIN_PAYLOAD_BYTES = 10;

/**
 * Source caps a single response packet at 4096 bytes and every implementation follows it,
 * so anything claiming much more is a desynchronised stream rather than a large reply —
 * and a length field read from a socket is attacker-influenced input in the general case.
 */
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_BUFFERED_BYTES = 256 * 1024;
/** A `list` on a 500-player server is a few kilobytes; a megabyte is already pathological. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

export interface RconPacket {
  id: number;
  type: number;
  body: string;
}

/**
 * Why RCON could not be used. Callers switch on this to decide between "fix your
 * configuration" and "try again in a moment", so the two families are kept distinct.
 */
export type RconFailure =
  | 'not_supported'
  | 'not_enabled'
  | 'no_password'
  | 'offline'
  | 'unreachable'
  | 'timeout'
  | 'auth_failed'
  | 'protocol_error';

/** Transport failures are worth retrying; a misconfiguration is not. */
const RETRYABLE_FAILURES: readonly RconFailure[] = ['unreachable', 'timeout'];

export function rconError(reason: RconFailure, message: string, cause?: unknown): PlatterError {
  return new PlatterError(
    RETRYABLE_FAILURES.includes(reason) ? 'service_unavailable' : 'invalid_state',
    message,
    // Surfaced in `details` so a client can offer the right recovery — the code alone
    // cannot distinguish "turn RCON on" from "the password is wrong".
    { details: { rcon: [reason] }, cause },
  );
}

/** The reason from a `PlatterError` this module raised, or null for anything else. */
export function rconFailureOf(error: unknown): RconFailure | null {
  if (!(error instanceof PlatterError)) return null;
  const reason = error.details?.['rcon']?.[0];
  return typeof reason === 'string' ? (reason as RconFailure) : null;
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/**
 * Bodies are encoded as UTF-8.
 *
 * The Source specification says ASCII and Minecraft historically used the JVM's default
 * charset, which in every container image Platter runs is UTF-8. Player names are ASCII
 * either way; this only matters for output carrying section signs or accented MOTDs, where
 * UTF-8 is what the servers actually emit.
 */
export function encodeRconPacket(packet: RconPacket): Buffer {
  const body = Buffer.from(packet.body, 'utf8');
  if (body.length + MIN_PAYLOAD_BYTES > MAX_PAYLOAD_BYTES) {
    throw rconError('protocol_error', 'That command is too long to send over RCON.');
  }

  const payloadLength = 4 + 4 + body.length + TERMINATOR_BYTES;
  const buffer = Buffer.alloc(4 + payloadLength);
  buffer.writeInt32LE(payloadLength, 0);
  buffer.writeInt32LE(packet.id, 4);
  buffer.writeInt32LE(packet.type, 8);
  body.copy(buffer, HEADER_BYTES);
  // The two trailing NULs are already zero from `alloc`; written for nothing but clarity
  // about where the frame ends.
  buffer.writeUInt8(0, HEADER_BYTES + body.length);
  buffer.writeUInt8(0, HEADER_BYTES + body.length + 1);
  return buffer;
}

/**
 * Incremental frame decoder.
 *
 * TCP gives no message boundaries: one `data` event can carry half a packet or six of
 * them, so the leftover has to survive between chunks. Kept as a class rather than a
 * closure so the multi-packet case can be tested by feeding it deliberately split input.
 */
export class RconPacketReader {
  // Annotated rather than inferred: `Buffer.alloc` widens to `Buffer<ArrayBuffer>`, which
  // `Buffer.concat`'s `Buffer<ArrayBufferLike>` result is not assignable to.
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): RconPacket[] {
    if (this.buffer.length + chunk.length > MAX_BUFFERED_BYTES) {
      this.buffer = Buffer.alloc(0);
      throw rconError('protocol_error', 'The RCON server sent more data than Platter will buffer.');
    }
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    const packets: RconPacket[] = [];
    for (;;) {
      if (this.buffer.length < 4) break;
      const payloadLength = this.buffer.readInt32LE(0);
      if (payloadLength < MIN_PAYLOAD_BYTES || payloadLength > MAX_PAYLOAD_BYTES) {
        this.buffer = Buffer.alloc(0);
        throw rconError('protocol_error', 'The RCON server sent a frame Platter cannot read.');
      }

      const total = 4 + payloadLength;
      if (this.buffer.length < total) break;

      packets.push({
        id: this.buffer.readInt32LE(4),
        type: this.buffer.readInt32LE(8),
        // `payloadLength - MIN_PAYLOAD_BYTES` is the body; the last two bytes are the
        // terminators, which are not part of it.
        body: this.buffer.toString('utf8', HEADER_BYTES, total - TERMINATOR_BYTES),
      });
      this.buffer = this.buffer.subarray(total);
    }
    return packets;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }

  get buffered(): number {
    return this.buffer.length;
  }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export interface RconEndpoint {
  host: string;
  port: number;
  password: string;
}

export interface RconConnectionOptions {
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  logger?: FastifyBaseLogger;
  /** Names the connection in logs. Never the endpoint, which carries the password. */
  label?: string;
}

interface PendingCommand {
  commandId: number;
  sentinelId: number;
  chunks: string[];
  bytes: number;
  resolve: (body: string) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

/**
 * One authenticated socket to one server.
 *
 * Commands are serialised. RCON ids would technically allow several in flight, but the
 * game servers execute them on the main thread one at a time anyway, and a single
 * outstanding request is what makes the sentinel below unambiguous.
 */
export class RconConnection {
  private readonly endpoint: RconEndpoint;
  private readonly connectTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly logger: FastifyBaseLogger | undefined;
  private readonly label: string;

  private socket: Socket | null = null;
  private readonly reader = new RconPacketReader();
  private pending: PendingCommand | null = null;
  /** Set only between writing the auth packet and resolving it; see `authenticate`. */
  private authHandler: ((packet: RconPacket) => void) | null = null;
  private authReject: ((error: unknown) => void) | null = null;
  /** Serialises callers; each command chains onto the previous one's settlement. */
  private tail: Promise<unknown> = Promise.resolve();
  private connecting: Promise<void> | null = null;
  private authed = false;
  private disposed = false;
  /** Wraps at 2^30 so an id stays a positive int32 in a daemon that runs for months. */
  private nextId = 1;

  lastUsedAt = Date.now();

  constructor(endpoint: RconEndpoint, options: RconConnectionOptions = {}) {
    this.endpoint = endpoint;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.logger = options.logger;
    this.label = options.label ?? `${endpoint.host}:${endpoint.port}`;
  }

  get connected(): boolean {
    return this.socket !== null && this.authed;
  }

  /**
   * Runs one command and returns its full output.
   *
   * **The multi-packet problem.** A response longer than 4096 bytes is split across
   * several packets, and nothing in the protocol says how many are coming: the last packet
   * of a long reply is indistinguishable from the only packet of a short one. `list` on a
   * busy server and `whitelist list` both cross that line routinely, and a naive client
   * silently returns the first 4 KB.
   *
   * The fix every serious implementation uses: immediately after the command, send a
   * second packet with a type the server does not implement and a *different* id. RCON
   * answers requests in order, so the reply to that dummy — Minecraft says
   * "Unknown request 64", Source returns an empty value — can only arrive after the last
   * packet of the real response. Its id is the sentinel. Everything tagged with the
   * command's id that arrives before it is the answer, concatenated in order.
   *
   * Keying on the id (rather than counting packets) is also what makes a timed-out command
   * safe: its late packets carry an id nothing is waiting for and are dropped, instead of
   * being mistaken for the next command's output.
   */
  async command(line: string): Promise<string> {
    const run = this.tail.then(
      () => this.execute(line),
      () => this.execute(line),
    );
    // The chain must not reject, or every later command inherits the failure.
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async execute(line: string): Promise<string> {
    if (this.disposed) throw rconError('offline', 'This RCON connection has been closed.');
    await this.ensureConnected();

    const socket = this.socket;
    if (!socket) throw rconError('unreachable', `RCON to ${this.label} is not connected.`);

    const commandId = this.takeId();
    const sentinelId = this.takeId();

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending;
        this.pending = null;
        if (!pending) return;
        // Partial output is kept rather than discarded: a server that ignores the sentinel
        // packet entirely (some heavily modded builds do) would otherwise fail every
        // command, and the id keying above means what we have is genuinely this command's.
        if (pending.chunks.length > 0) {
          this.logger?.warn(
            { rcon: this.label, bytes: pending.bytes },
            'RCON response ended without its sentinel; returning what arrived',
          );
          resolve(pending.chunks.join(''));
          return;
        }
        reject(rconError('timeout', `${this.label} did not answer an RCON command in time.`));
      }, this.commandTimeoutMs);
      timer.unref();

      this.pending = { commandId, sentinelId, chunks: [], bytes: 0, resolve, reject, timer };
      this.lastUsedAt = Date.now();

      try {
        socket.write(encodeRconPacket({ id: commandId, type: RCON_TYPE.command, body: line }));
        socket.write(encodeRconPacket({ id: sentinelId, type: RCON_TYPE.sentinel, body: '' }));
      } catch (error) {
        clearTimeout(timer);
        this.pending = null;
        reject(rconError('unreachable', `Could not write to RCON on ${this.label}.`, error));
      }
    }).finally(() => {
      const pending = this.pending;
      if (pending && pending.commandId === commandId) {
        clearTimeout(pending.timer);
        this.pending = null;
      }
    });
  }

  /** Ids stay positive and small so a wrap can never collide with the -1 auth sentinel. */
  private takeId(): number {
    const id = this.nextId;
    this.nextId = id >= 0x3fff_ffff ? 1 : id + 1;
    return id;
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    // A second caller arriving mid-handshake joins it instead of opening a rival socket.
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    await this.connecting;
  }

  private async connect(): Promise<void> {
    this.teardown();
    const socket = new Socket();
    // Nagle would hold the two-byte sentinel packet back waiting for more to send, adding
    // up to 40ms to every command for no benefit on a control channel.
    socket.setNoDelay(true);

    await new Promise<void>((resolve, reject) => {
      const settle = (error?: unknown): void => {
        clearTimeout(timer);
        socket.removeListener('connect', onConnect);
        socket.removeListener('error', onError);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onConnect = (): void => {
        settle();
      };
      const onError = (error: Error): void => {
        socket.destroy();
        settle(rconError('unreachable', `Could not reach RCON on ${this.label}.`, error));
      };
      const timer = setTimeout(() => {
        socket.destroy();
        settle(rconError('timeout', `RCON on ${this.label} did not accept a connection in time.`));
      }, this.connectTimeoutMs);
      timer.unref();

      socket.once('connect', onConnect);
      socket.once('error', onError);
      socket.connect({ host: this.endpoint.host, port: this.endpoint.port });
    });

    this.socket = socket;
    this.reader.reset();
    socket.on('data', (chunk: Buffer) => {
      this.onData(chunk);
    });
    socket.on('error', (error: Error) => {
      this.fail(rconError('unreachable', `The RCON connection to ${this.label} failed.`, error));
    });
    socket.on('close', () => {
      this.fail(rconError('unreachable', `The RCON connection to ${this.label} closed.`));
    });

    try {
      await this.authenticate(socket);
    } catch (error) {
      // A socket that failed to authenticate is not reusable, and leaving it attached
      // would keep the game server counting it as an open RCON session.
      this.teardown();
      throw error;
    }
    this.authed = true;
  }

  /**
   * The password is written to the socket and never anywhere else — not into an error
   * message, not into a log line, not into the connection's label. An operator reading a
   * debug log must not come away holding their own server's RCON credentials.
   */
  private async authenticate(socket: Socket): Promise<void> {
    const id = this.takeId();

    await new Promise<void>((resolve, reject) => {
      const settle = (error?: unknown): void => {
        clearTimeout(timer);
        this.authHandler = null;
        this.authReject = null;
        if (error === undefined) resolve();
        else reject(error);
      };

      const timer = setTimeout(() => {
        settle(rconError('timeout', `RCON on ${this.label} did not answer the handshake.`));
      }, this.connectTimeoutMs);
      timer.unref();

      // So a socket that dies mid-handshake fails immediately instead of waiting out the
      // full connect timeout.
      this.authReject = settle;

      this.authHandler = (packet: RconPacket): void => {
        // Source sends an empty SERVERDATA_RESPONSE_VALUE before the real answer. Only the
        // auth-response type decides the outcome.
        if (packet.type !== RCON_TYPE.command) return;
        if (packet.id === -1) {
          settle(
            rconError(
              'auth_failed',
              `${this.label} rejected the RCON password. Check the server's RCON password setting.`,
            ),
          );
          return;
        }
        if (packet.id === id) settle();
      };

      try {
        socket.write(
          encodeRconPacket({ id, type: RCON_TYPE.auth, body: this.endpoint.password }),
        );
      } catch (error) {
        settle(rconError('unreachable', `Could not write to RCON on ${this.label}.`, error));
      }
    });
  }

  private onData(chunk: Buffer): void {
    let packets: RconPacket[];
    try {
      packets = this.reader.push(chunk);
    } catch (error) {
      this.fail(error);
      return;
    }

    for (const packet of packets) {
      if (this.authHandler) {
        this.authHandler(packet);
        continue;
      }

      const pending = this.pending;
      // A packet for a command that already timed out, or for one that was cancelled by a
      // reconnect. Dropping it is the whole point of correlating on the id.
      if (!pending) continue;

      if (packet.id === pending.sentinelId) {
        clearTimeout(pending.timer);
        this.pending = null;
        pending.resolve(pending.chunks.join(''));
        continue;
      }
      if (packet.id !== pending.commandId) continue;

      if (pending.bytes + packet.body.length > MAX_RESPONSE_BYTES) {
        clearTimeout(pending.timer);
        this.pending = null;
        pending.reject(
          rconError('protocol_error', `${this.label} returned more output than Platter will read.`),
        );
        continue;
      }
      pending.chunks.push(packet.body);
      pending.bytes += packet.body.length;
    }
  }

  /** Fails whatever is in flight and drops the socket, so the next command reconnects. */
  private fail(error: unknown): void {
    const pending = this.pending;
    const authReject = this.authReject;
    this.pending = null;
    this.authHandler = null;
    this.authReject = null;
    this.authed = false;
    this.teardown();

    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    if (authReject) authReject(error);
  }

  private teardown(): void {
    const socket = this.socket;
    this.socket = null;
    this.authed = false;
    this.reader.reset();
    if (!socket) return;
    socket.removeAllListeners();
    socket.destroy();
  }

  /** Idempotent. Anything in flight is rejected rather than left hanging forever. */
  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    const pending = this.pending;
    this.pending = null;
    this.authHandler = null;
    this.authReject = null;
    this.teardown();
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(rconError('offline', 'The RCON connection was closed.'));
    }
  }
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

/**
 * One connection per server, reused.
 *
 * Every RCON handshake is a TCP connect plus an authentication round trip, and the console
 * page, the player list and the stats sampler all want to talk to the same server seconds
 * apart. Reconnecting for each would triple the latency of every action and leave the game
 * server logging a connection storm.
 */

const IDLE_TIMEOUT_MS = 5 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
const MAX_POOLED_CONNECTIONS = 64;

/** Backoff after a failed connect, so a UI polling a down server does not hammer it. */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** A wrong password will not fix itself; retrying it every second only fills the log. */
const AUTH_FAILURE_COOLDOWN_MS = 60_000;

interface PoolEntry {
  connection: RconConnection;
  /** Everything about the endpoint that makes it a *different* endpoint. */
  fingerprint: string;
  failures: number;
  /** Epoch ms before which a new connect attempt is refused outright. */
  blockedUntil: number;
  lastError: PlatterError | null;
}

const pool = new Map<string, PoolEntry>();
let sweeper: NodeJS.Timeout | null = null;

function fingerprintOf(endpoint: RconEndpoint): string {
  // The password is part of the identity — changing it must retire the connection — but it
  // is never rendered anywhere, so its length stands in for it. A same-length replacement
  // is caught by the auth failure that follows.
  return `${endpoint.host}:${endpoint.port}:${endpoint.password.length}`;
}

function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS;
    for (const [key, entry] of pool) {
      if (entry.connection.lastUsedAt > cutoff) continue;
      entry.connection.close();
      pool.delete(key);
    }
    if (pool.size === 0) stopSweeper();
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();
}

function stopSweeper(): void {
  if (!sweeper) return;
  clearInterval(sweeper);
  sweeper = null;
}

function evictOldest(): void {
  let oldestKey: string | null = null;
  let oldest = Number.POSITIVE_INFINITY;
  for (const [key, entry] of pool) {
    if (entry.connection.lastUsedAt < oldest) {
      oldest = entry.connection.lastUsedAt;
      oldestKey = key;
    }
  }
  if (oldestKey === null) return;
  pool.get(oldestKey)?.connection.close();
  pool.delete(oldestKey);
}

function backoffFor(failures: number, reason: RconFailure): number {
  if (reason === 'auth_failed') return AUTH_FAILURE_COOLDOWN_MS;
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
  // Full jitter, for the same reason `lib/async.ts` uses it: a node coming back should not
  // be met by every server's poller at the same instant.
  return Math.round(Math.random() * ceiling);
}

export interface RconCommandOptions extends RconConnectionOptions {
  /** Pool key. The server id, so one server keeps one connection across endpoint reads. */
  key: string;
}

/**
 * Runs a command against a pooled connection, opening or replacing it as needed.
 *
 * A connection that has just failed is not retried until its backoff expires; the caller
 * gets the original failure straight away instead of waiting out another connect timeout.
 */
export async function rconCommand(
  endpoint: RconEndpoint,
  line: string,
  options: RconCommandOptions,
): Promise<string> {
  const fingerprint = fingerprintOf(endpoint);
  let entry = pool.get(options.key);

  if (entry && entry.fingerprint !== fingerprint) {
    // The port or the password changed. The old socket is authenticated against something
    // that no longer exists, so it is retired rather than reused.
    entry.connection.close();
    pool.delete(options.key);
    entry = undefined;
  }

  if (entry && !entry.connection.connected && entry.blockedUntil > Date.now() && entry.lastError) {
    throw entry.lastError;
  }

  if (!entry) {
    if (pool.size >= MAX_POOLED_CONNECTIONS) evictOldest();
    entry = {
      connection: new RconConnection(endpoint, options),
      fingerprint,
      failures: 0,
      blockedUntil: 0,
      lastError: null,
    };
    pool.set(options.key, entry);
    startSweeper();
  }

  try {
    const output = await entry.connection.command(line);
    entry.failures = 0;
    entry.blockedUntil = 0;
    entry.lastError = null;
    return output;
  } catch (error) {
    const reason = rconFailureOf(error);
    if (reason !== null && error instanceof PlatterError) {
      entry.failures += 1;
      entry.blockedUntil = Date.now() + backoffFor(entry.failures, reason);
      entry.lastError = error;
      // An unusable connection is dropped so the next attempt starts from a clean socket
      // rather than inheriting half-read framing.
      if (reason !== 'timeout') {
        entry.connection.close();
        entry.connection = new RconConnection(endpoint, options);
      }
    }
    throw error;
  }
}

/** Called when a server stops or is deleted; without it the pool holds a dead socket. */
export function closeRcon(key: string): void {
  const entry = pool.get(key);
  if (!entry) return;
  entry.connection.close();
  pool.delete(key);
  if (pool.size === 0) stopSweeper();
}

/** Shutdown, and the reset every test needs so pooled state does not cross files. */
export function closeAllRcon(): void {
  for (const entry of pool.values()) entry.connection.close();
  pool.clear();
  stopSweeper();
}

export function pooledRconCount(): number {
  return pool.size;
}
