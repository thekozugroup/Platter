import websocketPlugin, { type WebSocket } from '@fastify/websocket';
import type { FastifyBaseLogger, FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  WS_CLOSE,
  WS_PATH,
  clientMessageSchema,
  idSchema,
  type LogLine,
  type ServerMessage,
  type ServerStats,
  type ServerStatus,
} from '@platter/shared';
import { prisma } from '../db.js';
import { toPlatterError } from '../lib/errors.js';
import { verifySocketToken, type AuthContext, type ServerRecord } from '../plugins/auth.js';
import {
  acquireConsoleSlot,
  attachServerConsole,
  closeConsoleHub,
  type ConsoleAttachment,
} from '../services/console-hub.js';
import { sendCommand } from '../services/lifecycle.js';
import { presentStatus, serverPermissionsFor } from '../services/servers.js';

/**
 * The console socket.
 *
 * A browser cannot set headers on a WebSocket, so the credential arrives in the first
 * frame instead of in `Authorization` — and never in the query string, which would put an
 * access token into every proxy log and the user's history. Until that frame lands the
 * connection is anonymous, holds no server, and is on a five-second fuse.
 */

/** Long enough for a slow phone, short enough that a port scanner gains nothing. */
const AUTH_TIMEOUT_MS = 5_000;

/**
 * Protocol-level ping. The web client's own liveness timeout is 60s, so pinging every 25s
 * proves a healthy socket twice inside that window.
 */
const HEARTBEAT_INTERVAL_MS = 25_000;

/** Console input, not a scripting endpoint: five lines in ten seconds is a fast typist. */
const COMMAND_BURST = 5;
const COMMAND_WINDOW_MS = 10_000;

/** Frames carry a bounded command as JSON, so anything larger is not ours. */
const MAX_FRAME_BYTES = 16 * 1024;

/** The first path segment of `WS_PATH`, used to recognise our own upgrade requests. */
const WS_ROOT = WS_PATH.slice(0, WS_PATH.indexOf('/', 1));

const connections = new Set<ConsoleConnection>();

type RawFrame = Buffer | ArrayBuffer | Buffer[];

function frameToText(data: RawFrame): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

class ConsoleConnection {
  readonly #app: FastifyInstance;
  readonly #socket: WebSocket;
  readonly #serverId: string;
  readonly #log: FastifyBaseLogger;

  #auth: AuthContext | null = null;
  #server: ServerRecord | null = null;
  #canWrite = false;
  #authenticating = false;

  #attachment: ConsoleAttachment | null = null;
  #releaseSlot: (() => void) | null = null;

  #authTimer: NodeJS.Timeout | null = null;
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #awaitingPong = false;

  #commandTimes: number[] = [];
  #closed = false;

  constructor(app: FastifyInstance, socket: WebSocket, request: FastifyRequest, serverId: string) {
    this.#app = app;
    this.#socket = socket;
    this.#serverId = serverId;
    this.#log = request.log.child({ serverId });
  }

  start(): void {
    this.#socket.on('message', (data: RawFrame) => {
      this.#onFrame(data);
    });
    // `close` fires for every ending — clean close, protocol error, terminate — which is
    // why it is the single place teardown is driven from.
    this.#socket.on('close', () => {
      this.#dispose();
    });
    this.#socket.on('error', (error: Error) => {
      this.#log.debug({ err: error }, 'console socket errored');
      this.#dispose();
    });
    this.#socket.on('pong', () => {
      this.#awaitingPong = false;
    });

    this.#authTimer = setTimeout(() => {
      this.#closeWith(WS_CLOSE.authTimeout, 'no auth frame');
    }, AUTH_TIMEOUT_MS);
    this.#authTimer.unref();
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  #onFrame(data: RawFrame): void {
    const text = frameToText(data);
    if (text.length > MAX_FRAME_BYTES) {
      this.#sendError('payload_too_large', 'That frame is too large.');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.#sendError('bad_request', 'Frames must be JSON.');
      return;
    }

    const message = clientMessageSchema.safeParse(parsed);
    if (!message.success) {
      this.#sendError('validation_failed', 'That frame is not part of the console protocol.');
      return;
    }

    switch (message.data.type) {
      case 'auth': {
        // Re-authenticating on a live socket is not part of the protocol, and honouring it
        // would let a second principal inherit an attachment made for the first.
        if (this.#auth || this.#authenticating) return;
        this.#authenticating = true;
        void this.#authenticate(message.data.token);
        return;
      }
      case 'ping': {
        this.#send({ type: 'pong' });
        return;
      }
      case 'backlog': {
        const attachment = this.#requireAttachment();
        if (!attachment) return;
        this.#send({ type: 'logs', lines: attachment.backlog(message.data.lines) });
        return;
      }
      case 'command': {
        if (!this.#requireAttachment()) return;
        this.#onCommand(message.data.command);
        return;
      }
    }
  }

  /** Anything but `auth` and `ping` before authentication is a client that lost the plot. */
  #requireAttachment(): ConsoleAttachment | null {
    if (!this.#auth) {
      this.#closeWith(WS_CLOSE.unauthorized, 'auth frame required first');
      return null;
    }
    return this.#attachment;
  }

  async #authenticate(token: string): Promise<void> {
    let auth: AuthContext;
    try {
      auth = await verifySocketToken(this.#app, token);
    } catch (error) {
      this.#log.debug({ err: error }, 'console socket presented a token we could not verify');
      this.#closeWith(WS_CLOSE.unauthorized, 'invalid token');
      return;
    }
    if (this.#closed) return;

    const server = await prisma.server.findUnique({ where: { id: this.#serverId } });
    if (this.#closed) return;
    // `gone` covers both "deleted" and "you have no relationship with it", for the same
    // reason the REST routes answer 404 in both cases: a distinct code here would confirm
    // that a server id exists.
    if (!server) {
      this.#closeWith(WS_CLOSE.gone, 'no such server');
      return;
    }

    const permissions = await serverPermissionsFor(server, auth.user, this.#log);
    if (this.#closed) return;
    if (!permissions) {
      this.#closeWith(WS_CLOSE.gone, 'no such server');
      return;
    }
    if (!permissions.has('console.read')) {
      this.#closeWith(WS_CLOSE.forbidden, 'console access denied');
      return;
    }

    const release = acquireConsoleSlot(auth.user.id);
    if (!release) {
      this.#closeWith(WS_CLOSE.tooManyConnections, 'too many consoles open');
      return;
    }
    this.#releaseSlot = release;

    if (this.#authTimer) clearTimeout(this.#authTimer);
    this.#authTimer = null;

    this.#auth = auth;
    this.#server = server;
    this.#canWrite = permissions.has('console.write');
    this.#authenticating = false;

    this.#send({
      type: 'ready',
      serverId: server.id,
      status: presentStatus(server),
      canWrite: this.#canWrite,
    });
    this.#startHeartbeat();

    // Attaching and sending the scrollback happen without an await between them, so no
    // line can slip into the gap: everything after the snapshot arrives as a `log` frame.
    const attachment = attachServerConsole(
      server,
      {
        onLog: (line) => {
          this.#onLine(line);
        },
        onStatus: (status, exitCode) => {
          this.#onStatus(status, exitCode);
        },
        onStats: (stats) => {
          this.#onStats(stats);
        },
        onGone: () => {
          this.#closeWith(WS_CLOSE.gone, 'server deleted');
        },
      },
      this.#log,
    );
    this.#attachment = attachment;
    if (attachment.initialBacklog.length > 0) {
      this.#send({ type: 'logs', lines: attachment.initialBacklog });
    }
  }

  #onCommand(command: string): void {
    const server = this.#server;
    const auth = this.#auth;
    if (!server || !auth) return;

    if (!this.#canWrite) {
      this.#sendError('forbidden', 'You can read this console but not send to it.');
      return;
    }
    if (!this.#allowCommand()) {
      this.#sendError('rate_limited', 'Too many commands. Give it a second.');
      return;
    }

    // The lifecycle service is the authority on whether a server can take input, and it
    // writes the audit entry — duplicating either here would let the two disagree.
    void sendCommand(this.#serverId, command, auth.user.id).catch((error: unknown) => {
      const platterError = toPlatterError(error);
      if (platterError.status >= 500) this.#log.warn({ err: error }, 'console command failed');
      this.#sendError(platterError.code, platterError.message);
    });
  }

  /** Sliding window rather than a fixed one, so a burst cannot straddle a reset. */
  #allowCommand(): boolean {
    const now = Date.now();
    this.#commandTimes = this.#commandTimes.filter((at) => now - at < COMMAND_WINDOW_MS);
    if (this.#commandTimes.length >= COMMAND_BURST) return false;
    this.#commandTimes.push(now);
    return true;
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  #onLine(line: LogLine): void {
    this.#send({ type: 'log', line });
  }

  #onStatus(status: ServerStatus, exitCode: number | null): void {
    this.#send({ type: 'status', status, exitCode });
  }

  #onStats(stats: ServerStats): void {
    this.#send({ type: 'stats', stats });
  }

  /**
   * Typed as `ServerMessage`, which is the compile-time form of "only shapes
   * `serverMessageSchema` accepts" — re-parsing every log line on the way out would cost
   * more than it could ever catch.
   */
  #send(message: ServerMessage): void {
    if (this.#closed || this.#socket.readyState !== this.#socket.OPEN) return;
    this.#socket.send(JSON.stringify(message));
  }

  #sendError(code: string, message: string): void {
    this.#send({ type: 'error', code, message });
  }

  // -------------------------------------------------------------------------
  // Liveness and teardown
  // -------------------------------------------------------------------------

  /**
   * Half-open sockets are the classic leak here: the peer vanishes without a FIN, the
   * `close` event never fires, and the log subscription — plus the driver stream it keeps
   * open — lives forever. One unanswered ping is enough evidence to terminate.
   */
  #startHeartbeat(): void {
    if (this.#heartbeatTimer) return;
    this.#heartbeatTimer = setInterval(() => {
      if (this.#awaitingPong) {
        this.#log.debug('console socket missed a heartbeat; terminating');
        this.#dispose();
        this.#socket.terminate();
        return;
      }
      this.#awaitingPong = true;
      this.#socket.ping();
    }, HEARTBEAT_INTERVAL_MS);
    this.#heartbeatTimer.unref();
  }

  #closeWith(code: number, reason: string): void {
    // Teardown first: `close` is asynchronous, and nothing should be delivered to a socket
    // we have already decided to end.
    const wasOpen = this.#socket.readyState === this.#socket.OPEN;
    this.#dispose();
    if (wasOpen) this.#socket.close(code, reason);
  }

  /** Idempotent — it runs from the close handler, the error handler and every close path. */
  #dispose(): void {
    if (this.#closed) return;
    this.#closed = true;

    if (this.#authTimer) clearTimeout(this.#authTimer);
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#authTimer = null;
    this.#heartbeatTimer = null;

    // Detaching is what lets the shared channel drop its log subscription and its timer
    // once the last watcher leaves — and the log hub close its driver stream after that.
    this.#attachment?.detach();
    this.#attachment = null;

    this.#releaseSlot?.();
    this.#releaseSlot = null;

    connections.delete(this);
  }

  shutdown(): void {
    this.#closeWith(WS_CLOSE.shuttingDown, 'server shutting down');
  }
}

const consoleRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * The console lives at the root (`/ws/...`) because that is what `WS_PATH` promises and
   * what the dev proxy forwards, but this plugin is mounted under the API prefix and
   * Fastify offers no way to escape an inherited prefix. Rewriting the upgrade request is
   * the smallest honest fix: the route is declared once, and the public path stays put.
   * Derived from `fastify.prefix`, so mounting this at the root makes it a no-op.
   */
  const mountPrefix = fastify.prefix;
  const rewriteUpgradeUrl = (request: { url?: string | undefined }): void => {
    if (request.url?.startsWith(`${WS_ROOT}/`)) request.url = `${mountPrefix}${request.url}`;
  };
  if (mountPrefix.length > 0) {
    // Added before the websocket plugin so it runs first: Node fires upgrade listeners in
    // registration order, and the plugin's listener is the one that does the routing.
    fastify.server.on('upgrade', rewriteUpgradeUrl);
  }

  // Registered before the plugin so it runs before the plugin's own `preClose`, which
  // closes every client with a bare 1005. Ours gets there first with `shuttingDown`, which
  // is what tells a client to reconnect with backoff instead of giving up.
  fastify.addHook('preClose', async () => {
    for (const connection of [...connections]) connection.shutdown();
    connections.clear();
    closeConsoleHub();
    if (mountPrefix.length > 0) fastify.server.removeListener('upgrade', rewriteUpgradeUrl);
  });

  await fastify.register(websocketPlugin, { options: { maxPayload: MAX_FRAME_BYTES } });

  fastify.get<{ Params: { serverId: string } }>(WS_PATH, { websocket: true }, (socket, request) => {
    const serverId = idSchema.safeParse(request.params.serverId);
    if (!serverId.success) {
      socket.close(WS_CLOSE.gone, 'no such server');
      return;
    }

    const connection = new ConsoleConnection(fastify, socket, request, serverId.data);
    connections.add(connection);
    connection.start();
  });
};

export default consoleRoutes;
