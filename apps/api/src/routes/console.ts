import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket } from '@fastify/websocket';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  PlatterError,
  WS_CLOSE,
  WS_PATH,
  clientMessageSchema,
  roleAtLeast,
  type Blueprint,
  type ServerMessage,
  type ServerStatus,
} from '@platter/shared';
import { prisma } from '../db.js';
import { getLogHub } from '../orchestration/log-buffer.js';
import { getDriverForNode } from '../orchestration/registry.js';
import { parseServerPermissions, presentStatus, getServerStats } from '../services/servers.js';
import { recordAudit } from '../services/audit.js';
import { getBlueprint } from '../services/blueprints.js';
import { sendCommand } from '../services/lifecycle.js';
import { websocketConnections } from '../services/metrics.js';
import type { AuthContext } from '../plugins/auth.js';

/**
 * The console socket: one connection per open console, carrying scrollback, live output,
 * status transitions and periodic stats.
 *
 * The design decision that matters is that this owns no state about the server. Everything
 * it sends comes from the server's `LogHub`, which is also what the lifecycle writes
 * through — so a status frame and the log line announcing it can never disagree, and N
 * open consoles still cost exactly one `docker logs` stream.
 *
 * Authentication happens in the first frame rather than the URL. A `?token=` would be
 * written verbatim into every proxy access log and the browser's history; the socket is
 * already open by then, so a close code can say precisely what was wrong.
 */

/** How long a socket may stay unauthenticated before it is closed. */
const AUTH_TIMEOUT_MS = 10_000;

/** Stats are a poll against the driver, so this is a compromise between a live-looking
 * graph and a container inspection every second for every open tab. */
const STATS_INTERVAL_MS = 5_000;

/**
 * Per-principal cap. Each socket holds a hub subscription and a stats timer, and a client
 * with a reconnect bug would otherwise accumulate them until the process dies.
 */
const MAX_SOCKETS_PER_USER = 8;

/** Frames a client may send before authenticating (just the one). */
const MAX_FRAME_BYTES = 8 * 1024;

const openSockets = new Map<string, number>();

function countSocket(userId: string, delta: 1 | -1): number {
  const next = (openSockets.get(userId) ?? 0) + delta;
  if (next <= 0) openSockets.delete(userId);
  else openSockets.set(userId, next);
  websocketConnections.set([...openSockets.values()].reduce((total, n) => total + n, 0));
  return next;
}

interface ConsoleAccess {
  status: ServerStatus;
  canWrite: boolean;
}

/**
 * Resolves what this principal may do with this server's console.
 *
 * Returns null for "no relationship at all", which the caller turns into `gone` rather
 * than `forbidden` — the same reasoning as `requireServerAccess`: a distinct code would
 * confirm that a server with that id exists.
 */
async function resolveAccess(
  serverId: string,
  auth: AuthContext,
  log: FastifyRequest['log'],
): Promise<ConsoleAccess | null> {
  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) return null;

  const status = presentStatus(server);
  if (roleAtLeast(auth.user.role, 'admin') || server.ownerId === auth.user.id) {
    return { status, canWrite: true };
  }

  const subuser = await prisma.serverSubuser.findUnique({
    where: { serverId_userId: { serverId, userId: auth.user.id } },
    select: { permissions: true },
  });
  if (!subuser) return null;

  const granted = parseServerPermissions(subuser.permissions, serverId, log);
  if (!granted.includes('console.read')) return null;
  return { status, canWrite: granted.includes('console.write') };
}

const consoleRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(fastifyWebsocket, {
    options: { maxPayload: MAX_FRAME_BYTES },
  });

  fastify.get(WS_PATH, { websocket: true, schema: { hide: true } }, (socket, request) => {
    // Not `async`: @fastify/websocket's handler is synchronous, and an async body's
    // rejection would have nowhere to go once the socket is already open.
    void runConsole(socket, request);
  });

  async function runConsole(socket: WebSocket, request: FastifyRequest): Promise<void> {
    const { serverId } = request.params as { serverId?: string };
    const log = request.log;

    let authed: AuthContext | null = null;
    let canWrite = false;
    let unsubscribe: (() => void) | null = null;
    let statsTimer: NodeJS.Timeout | null = null;
    let closed = false;

    const send = (message: ServerMessage): void => {
      // readyState is checked rather than caught: writing to a closing socket throws
      // asynchronously in ws, which would surface as an unhandled rejection.
      if (closed || socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify(message));
    };

    /** Every exit path funnels through here, so no listener or timer outlives the socket. */
    const shutdown = (code?: number, reason?: string): void => {
      if (closed) return;
      closed = true;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (statsTimer) {
        clearInterval(statsTimer);
        statsTimer = null;
      }
      if (authed) countSocket(authed.user.id, -1);
      if (code !== undefined) socket.close(code, reason);
    };

    const authTimer = setTimeout(() => {
      if (!authed) shutdown(WS_CLOSE.authTimeout, 'authentication timed out');
    }, AUTH_TIMEOUT_MS);
    authTimer.unref();

    socket.on('close', () => {
      clearTimeout(authTimer);
      shutdown();
    });
    socket.on('error', (error: Error) => {
      log.debug({ err: error, serverId }, 'console socket errored');
      clearTimeout(authTimer);
      shutdown();
    });

    // ---------------------------------------------------------------------
    // Frames
    // ---------------------------------------------------------------------

    const handleAuth = async (token: string): Promise<void> => {
      if (authed) return; // a second auth frame is a no-op, not a re-key

      let context: AuthContext;
      try {
        context = await fastify.verifySocketToken(token);
      } catch {
        shutdown(WS_CLOSE.unauthorized, 'invalid token');
        return;
      }

      if (typeof serverId !== 'string' || serverId.length === 0) {
        shutdown(WS_CLOSE.gone, 'no such server');
        return;
      }

      const access = await resolveAccess(serverId, context, log);
      if (!access) {
        shutdown(WS_CLOSE.gone, 'no such server');
        return;
      }

      if ((openSockets.get(context.user.id) ?? 0) >= MAX_SOCKETS_PER_USER) {
        shutdown(WS_CLOSE.tooManyConnections, 'too many open consoles');
        return;
      }

      authed = context;
      canWrite = access.canWrite;
      countSocket(context.user.id, 1);
      clearTimeout(authTimer);

      send({ type: 'ready', serverId, status: access.status, canWrite: access.canWrite });

      const hub = getLogHub(serverId);
      send({ type: 'logs', lines: hub.backlog(200) });

      unsubscribe = hub.subscribe((event) => {
        if (event.type === 'line') send({ type: 'log', line: event.line });
        else if (event.type === 'status') {
          send({ type: 'status', status: event.status, exitCode: event.exitCode });
        }
        // `ready` and `crash` already arrived as ordinary lines; the lifecycle turns them
        // into the status frames a client actually renders.
      });

      // Opening a console is a reason to have a live stream even when the lifecycle did
      // not start one — a server that was already running when Platter booted has a hub
      // with no producer until someone looks at it. `attach` is idempotent and reference
      // counted, so this joins the existing stream when there is one.
      await attachStream(serverId, hub, log);

      statsTimer = setInterval(() => {
        void pushStats(serverId, send, log);
      }, STATS_INTERVAL_MS);
      statsTimer.unref();
      void pushStats(serverId, send, log);
    };

    const handleCommand = async (command: string): Promise<void> => {
      if (!authed || typeof serverId !== 'string') return;
      if (!canWrite) {
        send({ type: 'error', code: 'forbidden', message: 'You cannot type in this console.' });
        return;
      }

      try {
        await sendCommand(serverId, command, authed.user.id);
        await recordAudit({
          action: 'server.command',
          actorId: authed.user.id,
          actorName: authed.user.displayName,
          targetType: 'server',
          targetId: serverId,
          metadata: { command, via: 'websocket' },
          logger: log,
        });
      } catch (error) {
        // Non-fatal by design: a command sent to a stopped server is a mistake to report,
        // not a reason to drop a console the operator is reading.
        const platter = error instanceof PlatterError ? error : null;
        send({
          type: 'error',
          code: platter?.code ?? 'internal_error',
          message: platter?.message ?? 'That command could not be sent.',
        });
        if (!platter) log.error({ err: error, serverId }, 'console command failed');
      }
    };

    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      void (async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          send({ type: 'error', code: 'bad_request', message: 'That frame was not valid JSON.' });
          return;
        }

        const result = clientMessageSchema.safeParse(parsed);
        if (!result.success) {
          send({
            type: 'error',
            code: 'validation_failed',
            message: 'That frame was not understood.',
          });
          return;
        }
        const message = result.data;

        // Everything except `auth` requires an authenticated socket. Silently ignoring
        // them keeps an unauthenticated peer from probing which servers exist.
        if (message.type !== 'auth' && !authed) return;

        switch (message.type) {
          case 'auth':
            await handleAuth(message.token);
            return;
          case 'command':
            await handleCommand(message.command);
            return;
          case 'backlog':
            if (typeof serverId === 'string') {
              send({ type: 'logs', lines: getLogHub(serverId).backlog(message.lines) });
            }
            return;
          case 'ping':
            send({ type: 'pong' });
            return;
        }
      })();
    });
  }

  /**
   * Closes every open console when Platter shuts down, with the code that tells the client
   * to reconnect with backoff rather than treat it as a permanent failure.
   */
  fastify.addHook('onClose', async () => {
    for (const client of fastify.websocketServer.clients) {
      client.close(WS_CLOSE.shuttingDown, 'server shutting down');
    }
    openSockets.clear();
    websocketConnections.set(0);
  });
};

/** Best effort: a console that cannot open a log stream still shows scrollback, status
 * frames and Platter's own system lines. */
async function attachStream(
  serverId: string,
  hub: ReturnType<typeof getLogHub>,
  log: FastifyRequest['log'],
): Promise<void> {
  if (hub.attached) return;
  try {
    const server = await prisma.server.findUnique({
      where: { id: serverId },
      include: { node: true },
    });
    if (!server) return;
    const blueprint = await getBlueprintOrNull(server.blueprintKey);
    hub.attach({ driver: getDriverForNode(server.node), signals: blueprint?.signals });
  } catch (error) {
    log.warn({ err: error, serverId }, 'could not open a console log stream');
  }
}

/** A server whose blueprint file was removed still has a console worth reading; it just
 * loses the ready/crash pattern matching. */
async function getBlueprintOrNull(key: string): Promise<Blueprint | null> {
  try {
    return await getBlueprint(key);
  } catch {
    return null;
  }
}

async function pushStats(
  serverId: string,
  send: (message: ServerMessage) => void,
  log: FastifyRequest['log'],
): Promise<void> {
  try {
    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server) return;
    send({ type: 'stats', stats: await getServerStats(server) });
  } catch (error) {
    // A stats poll that fails is not worth a frame — the next tick will try again.
    log.debug({ err: error, serverId }, 'console stats poll failed');
  }
}

export default consoleRoutes;
