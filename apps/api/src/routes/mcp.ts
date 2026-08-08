import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server as McpServerInstance } from '@modelcontextprotocol/sdk/server/index.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { PlatterError } from '@platter/shared';
import { unauthenticated } from '../lib/errors.js';
import { extractApiKey, resolveApiKeyPrincipal, type McpPrincipal } from '../mcp/auth.js';
import { createMcpServer } from '../mcp/server.js';

/**
 * MCP over Streamable HTTP.
 *
 * Register this plugin under the prefix that should own the endpoint — `/mcp` from `app.ts`
 * for a bare path, or from `routes/index.ts` for `${API_PREFIX}/mcp`. It claims three methods
 * on its own root: POST for JSON-RPC (and the SSE response stream), GET for the
 * server-initiated notification stream, DELETE to end a session.
 *
 * Authentication is a Platter API key on **every** request, not just the handshake. Two
 * consequences that matter:
 *
 * - A JWT is refused. Browser session tokens are minted for a person sitting in front of the
 *   UI; an agent surface is not that. An API key is a credential the operator created
 *   deliberately, can scope, and can revoke without signing themselves out.
 * - A session is pinned to the key that opened it. Session ids travel in a header and end up
 *   in client logs, so a leaked one must be useless on its own: presenting a different key
 *   against someone else's session is refused rather than honoured.
 *
 * The transport writes directly to the raw response — SSE has to, since Fastify's reply
 * lifecycle assumes one buffered body — so every request that reaches it is hijacked. Every
 * rejection happens *before* the hijack, so refusals still render the standard Platter error
 * envelope through the normal error handler.
 */

/** Concurrent sessions per process. Each holds an MCP server, a transport and open streams. */
const MAX_SESSIONS = 32;

/** A session nothing has touched for this long is abandoned; its client will reinitialise. */
const SESSION_IDLE_MS = 30 * 60_000;

const SWEEP_INTERVAL_MS = 60_000;

const SESSION_HEADER = 'mcp-session-id';

interface McpSession {
  /** Empty until the transport has minted one, which happens during the initialize request. */
  id: string;
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServerInstance;
  /** The key that opened the session. A different key may not drive it. */
  readonly apiKeyId: string;
  lastSeenAt: number;
  /** Latched by `destroySession`; closing a server closes its transport, which calls back in. */
  closing: boolean;
}

function headerValue(request: FastifyRequest, name: string): string | null {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function resolvePrincipal(request: FastifyRequest): Promise<McpPrincipal> {
  const token = extractApiKey(request.headers);
  if (token === null) {
    throw unauthenticated(
      'MCP requires a Platter API key. Send it as X-API-Key, or as Authorization: Bearer plt_….',
    );
  }
  return resolveApiKeyPrincipal(token, {
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  });
}

const mcpRoutes: FastifyPluginAsync = async (app) => {
  const sessions = new Map<string, McpSession>();
  /** Sessions that have been built but whose initialize has not landed yet. */
  let opening = 0;

  async function destroySession(session: McpSession, reason: string): Promise<void> {
    if (session.closing) return;
    session.closing = true;
    if (session.id.length > 0) sessions.delete(session.id);
    app.log.info({ sessionId: session.id, reason }, 'mcp session closed');
    // Closing the server closes the transport it owns, which ends every open SSE stream.
    await session.server.close().catch((error: unknown) => {
      app.log.warn({ err: error, sessionId: session.id }, 'failed to close an MCP session');
    });
  }

  /**
   * Sessions are held open by clients that may never come back — a crashed agent, a closed
   * laptop lid. Without this sweep the map is a slow leak in a process that runs for months.
   */
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const session of [...sessions.values()]) {
      if (session.lastSeenAt < cutoff) void destroySession(session, 'idle');
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  app.addHook('onClose', async () => {
    clearInterval(sweeper);
    await Promise.all([...sessions.values()].map((session) => destroySession(session, 'shutdown')));
  });

  /**
   * Builds a server and transport for a client that has not initialised yet.
   *
   * Registration happens in `onsessioninitialized` rather than after `handleRequest` returns:
   * on an SSE response `handleRequest` only resolves once the stream has ended, and a client
   * that sends its first `tools/call` promptly would find no session by then.
   */
  async function createSession(principal: McpPrincipal): Promise<McpSession> {
    if (sessions.size + opening >= MAX_SESSIONS) {
      throw new PlatterError(
        'service_unavailable',
        `Platter is already serving ${MAX_SESSIONS} MCP sessions. Close one, or try again shortly.`,
        { retryable: true },
      );
    }

    const server = createMcpServer({ principal, logger: app.log });
    // A box rather than a bare binding: the transport's callbacks need to reach the session,
    // and the session cannot be built until the transport exists.
    const held: { session?: McpSession } = {};

    // Stateful mode: the transport mints the id, returns it on the initialize response and
    // validates it on every later request. Stateless mode would mean rebuilding and
    // re-authorising a server per JSON-RPC message, and would give up server-initiated streams.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        const current = held.session;
        if (!current) return;
        current.id = sessionId;
        current.lastSeenAt = Date.now();
        sessions.set(sessionId, current);
        app.log.info({ sessionId, apiKeyId: principal.apiKeyId }, 'mcp session opened');
      },
      onsessionclosed: (sessionId) => {
        const existing = sessions.get(sessionId);
        if (existing) void destroySession(existing, 'client ended the session');
      },
    });

    const session: McpSession = {
      id: '',
      transport,
      server,
      apiKeyId: principal.apiKeyId,
      lastSeenAt: Date.now(),
      closing: false,
    };
    held.session = session;

    // Set before `connect`, which is fine and deliberate: the SDK's `Protocol.connect` chains
    // whatever handler it finds rather than replacing it. Without this, a transport that dies
    // on its own — a client that vanishes mid-stream — would leave the session in the map
    // until the idle sweep noticed, half an hour later.
    transport.onclose = (): void => {
      void destroySession(session, 'transport closed');
    };

    await server.connect(transport);
    return session;
  }

  /**
   * Hands the request to the transport.
   *
   * `reply.hijack()` first: from here Fastify writes nothing to this response, which is what
   * lets the transport hold it open as an event stream. It also means anything thrown after
   * this point cannot be rendered by the error handler, so the raw socket is closed by hand.
   */
  async function handOff(
    request: FastifyRequest,
    reply: FastifyReply,
    session: McpSession,
    body: unknown,
  ): Promise<void> {
    session.lastSeenAt = Date.now();
    // Set on the raw response because hijacking discards anything staged on `reply`.
    reply.raw.setHeader('X-Content-Type-Options', 'nosniff');
    reply.hijack();

    try {
      await session.transport.handleRequest(request.raw, reply.raw, body);
    } catch (error) {
      app.log.error({ err: error, sessionId: session.id }, 'mcp transport failed');
      if (!reply.raw.headersSent) reply.raw.writeHead(500, { 'content-type': 'application/json' });
      if (!reply.raw.writableEnded) {
        reply.raw.end(
          JSON.stringify({ error: { code: 'internal_error', message: 'MCP transport failure.' } }),
        );
      }
    }
  }

  /**
   * Resolves the session named by `Mcp-Session-Id`, or null when the header is absent.
   *
   * A header naming a session we do not hold is a 404 rather than a silent new session: the
   * client's state is stale, and the MCP spec has it reinitialise on exactly that answer.
   */
  function existingSession(request: FastifyRequest, principal: McpPrincipal): McpSession | null {
    const sessionId = headerValue(request, SESSION_HEADER);
    if (sessionId === null) return null;

    const session = sessions.get(sessionId);
    if (!session) {
      throw new PlatterError(
        'not_found',
        'That MCP session is not open. Send an initialize request to start a new one.',
      );
    }
    if (session.apiKeyId !== principal.apiKeyId) {
      app.log.warn(
        { sessionId, apiKeyId: principal.apiKeyId },
        'mcp session presented with a different API key',
      );
      throw new PlatterError('forbidden', 'That MCP session belongs to a different API key.');
    }
    return session;
  }

  app.post('/', { schema: { hide: true } }, async (request, reply) => {
    const principal = await resolvePrincipal(request);

    const session = existingSession(request, principal);
    if (session) {
      await handOff(request, reply, session, request.body);
      return reply;
    }

    // No session id: the only message that may legally start one is an initialize request.
    if (!isInitializeRequest(request.body)) {
      throw new PlatterError(
        'bad_request',
        'Missing Mcp-Session-Id. Send an initialize request first, then use the session id it returns.',
      );
    }

    // Held until the handshake resolves rather than just until the session object exists: a
    // burst of simultaneous initializes would otherwise all see spare capacity. Counting one
    // session twice for the length of a handshake errs towards refusing, which is the safe
    // direction for a cap that exists to bound memory.
    opening += 1;
    try {
      const created = await createSession(principal);
      await handOff(request, reply, created, request.body);
      // The transport rejected the handshake, so `onsessioninitialized` never fired and
      // nothing is tracking this server. Left alone it would hold a connected transport
      // for the life of the process.
      if (created.id.length === 0) await destroySession(created, 'initialize failed');
    } finally {
      opening -= 1;
    }
    return reply;
  });

  // The standalone stream the server pushes notifications down. Requires a session: there is
  // nothing to notify about before one exists.
  app.get('/', { schema: { hide: true } }, async (request, reply) => {
    const principal = await resolvePrincipal(request);
    const session = existingSession(request, principal);
    if (!session) {
      throw new PlatterError(
        'bad_request',
        'Missing Mcp-Session-Id. Open a session with an initialize request before opening a stream.',
      );
    }
    await handOff(request, reply, session, undefined);
    return reply;
  });

  app.delete('/', { schema: { hide: true } }, async (request, reply) => {
    const principal = await resolvePrincipal(request);
    const session = existingSession(request, principal);
    if (!session) throw new PlatterError('bad_request', 'Missing Mcp-Session-Id.');

    // The transport answers the DELETE and then fires `onsessionclosed`, which is what
    // removes the session — doing it here as well would double-close it.
    await handOff(request, reply, session, undefined);
    return reply;
  });
};

export default mcpRoutes;
