import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { closeAllRcon, createContext } from '@platter/core';
import { isErr, logger, paths, token as randomToken } from '@platter/shared';
import { createMcpServer } from './server';

const log = logger.child('mcp');

/**
 * Platter's MCP server.
 *
 * Two transports, for two genuinely different situations:
 *
 *   **stdio** (default) — the client spawns this process and owns its lifetime. This is how
 *   Claude Code, Claude Desktop and Cursor connect, and it needs no ports, no tokens and no
 *   configuration beyond a command. It inherits the trust of whatever spawned it.
 *
 *   **HTTP** (`--http`) — a long-lived server, for clients that connect over the network or for
 *   sharing one Platter with several tools. This one is authenticated, always, and refuses to
 *   listen on a non-loopback address without an explicitly configured token.
 *
 * Nothing may be written to stdout in stdio mode: that stream is the JSON-RPC channel, and one
 * stray `console.log` corrupts the session in a way that is genuinely miserable to debug. Every
 * log in this codebase goes to stderr for exactly this reason.
 */

const args = new Set(process.argv.slice(2));
const useHttp = args.has('--http');

const context = await createContext();
if (isErr(context)) {
  log.error('could not start', { code: context.error.code, message: context.error.message });
  process.stderr.write(
    `\nPlatter's MCP server could not start: ${context.error.message}\n` +
      'Docker needs to be running before Platter can manage servers.\n'
  );
  process.exit(1);
}

const ctx = context.value;

if (useHttp) {
  await startHttp();
} else {
  await startStdio();
}

/* -------------------------------------------------------------------------- */
/* stdio                                                                       */
/* -------------------------------------------------------------------------- */

async function startStdio(): Promise<void> {
  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('MCP server ready on stdio');

  const shutdown = async () => {
    await server.close().catch(() => undefined);
    await closeAllRcon();
    ctx.db.$close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

/* -------------------------------------------------------------------------- */
/* Streamable HTTP                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Sessions are required, not optional.
 *
 * The stateless mode of the Streamable HTTP transport cannot make server-to-client requests,
 * and elicitation is a server-to-client request. Since every destructive tool depends on
 * elicitation, a stateless Platter MCP server would be one that can read but never act — so
 * this always runs stateful.
 */
async function startHttp(): Promise<void> {
  const credential = resolveHttpToken();
  const bearer = credential.token;

  /**
   * Live sessions.
   *
   * Bounded, and evicted on idle. A client that sends `initialize` and then drops the TCP
   * connection without a `DELETE` leaves both the transport and a full `McpServer` — every tool
   * registered — resident forever. That does not need an attacker; one buggy reconnect loop is
   * enough to walk the process into an OOM, which takes the supervisor's scheduled backups down
   * with it.
   */
  const transports = new Map<
    string,
    { transport: StreamableHTTPServerTransport; lastSeen: number }
  >();
  const MAX_SESSIONS = 64;
  const SESSION_IDLE_MS = 30 * 60_000;

  const closeSession = (id: string): void => {
    const entry = transports.get(id);
    if (!entry) {
      return;
    }
    transports.delete(id);
    void entry.transport.close().catch(() => undefined);
  };

  const reapSessions = (now = Date.now()): void => {
    for (const [id, entry] of transports) {
      if (now - entry.lastSeen > SESSION_IDLE_MS) {
        log.info('session idle, closing', { sessionId: id });
        closeSession(id);
      }
    }
  };
  // `unref` so an idle reaper never keeps the process alive on its own.
  setInterval(() => reapSessions(), 60_000).unref();

  const http = createHttpServer((req, res) => {
    void handle(req, res).catch((error) => {
      log.error('request failed', { error: String(error) });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'internal error' }));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url !== '/mcp') {
      res.writeHead(404).end('Not found');
      return;
    }

    if (!authorised(req.headers.authorization, bearer)) {
      // The WWW-Authenticate header tells a well-behaved client what is expected rather than
      // leaving it to guess from a bare 401.
      res
        .writeHead(401, { 'WWW-Authenticate': 'Bearer realm="platter"' })
        .end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;

    if (existing) {
      existing.lastSeen = Date.now();
      await existing.transport.handleRequest(req, res);
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(400).end('Missing or unknown session');
      return;
    }

    const body = await readJson(req);
    if (!isInitializeRequest(body)) {
      res.writeHead(400).end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32_000, message: 'Bad Request: no valid session id' },
          id: null,
        })
      );
      return;
    }

    reapSessions();
    if (transports.size >= MAX_SESSIONS) {
      res
        .writeHead(503, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'too many open MCP sessions' }));
      log.warn('refused a session: cap reached', { open: transports.size });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Belt and braces behind the bearer token: a page the user visits cannot read a
      // cross-origin response, but it can re-point its own short-TTL domain at this address and
      // become same-origin. The token already stops that here; there is no reason to rely on it
      // being the only thing that does.
      enableDnsRebindingProtection: true,
      allowedHosts: [
        `${ctx.env.PLATTER_MCP_HOST}:${ctx.env.PLATTER_MCP_PORT}`,
        `127.0.0.1:${ctx.env.PLATTER_MCP_PORT}`,
        `localhost:${ctx.env.PLATTER_MCP_PORT}`,
      ],
      onsessioninitialized: (id: string) => {
        transports.set(id, { transport, lastSeen: Date.now() });
        log.info('session opened', { sessionId: id });
      },
      onsessionclosed: (id: string) => {
        transports.delete(id);
        log.info('session closed', { sessionId: id });
      },
    });

    // One McpServer per session. The tools close over `ctx`, which is shared, but the elicitation
    // channel is per-connection and sharing a server across sessions would route a confirmation
    // prompt to whichever client happened to connect first.
    const server = createMcpServer(ctx);
    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
      }
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const host = ctx.env.PLATTER_MCP_HOST;
  const port = ctx.env.PLATTER_MCP_PORT;

  await new Promise<void>((resolvePromise) => http.listen(port, host, resolvePromise));
  log.info('MCP server ready over HTTP', { url: `http://${host}:${port}/mcp` });
  /*
   * Print the token exactly once — on the run that generated it — and print the *path* on every
   * run after that.
   *
   * A control-plane credential written to stderr on every restart ends up in the systemd journal
   * and in `docker logs`, where every log-shipping agent and everyone in the `docker` group can
   * read it, and in any support bundle or terminal screenshot the user later shares. The token
   * file is mode 0600 for exactly that reason; printing the value would undo it.
   */
  const configExample = (token: string): string =>
    JSON.stringify(
      {
        mcpServers: {
          platter: {
            type: 'http',
            url: `http://${host}:${port}/mcp`,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      },
      null,
      2
    );

  process.stderr.write(
    `\nPlatter MCP server listening on http://${host}:${port}/mcp\n` +
      (credential.source === 'generated'
        ? `\nGenerated a bearer token and saved it to ${credential.file}\n` +
          'This is the only time it will be printed:\n\n' +
          `${bearer}\n\n` +
          `Add to your client config:\n${configExample(bearer)}\n`
        : credential.source === 'file'
          ? `\nBearer token: read it from ${credential.file}\n\n` +
            `Add to your client config:\n${configExample('<the token from that file>')}\n`
          : "\nBearer token: the value of PLATTER_MCP_TOKEN in this process's environment.\n\n" +
            `Add to your client config:\n${configExample('<PLATTER_MCP_TOKEN>')}\n`)
  );

  const shutdown = async () => {
    for (const entry of transports.values()) {
      await entry.transport.close().catch(() => undefined);
    }
    http.close();
    await closeAllRcon();
    ctx.db.$close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

/**
 * The HTTP bearer token.
 *
 * Generated and persisted on first run rather than required up front, because a local tool that
 * refuses to start until you invent a secret is a local tool people give up on. The file is the
 * source of truth across restarts so a client config does not break every time Platter starts.
 */
function resolveHttpToken(): { token: string; source: 'env' | 'file' | 'generated'; file: string } {
  const file = paths.mcpToken(ctx.env.PLATTER_DATA_DIR);

  if (ctx.env.PLATTER_MCP_TOKEN) {
    return { token: ctx.env.PLATTER_MCP_TOKEN, source: 'env', file };
  }

  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 16) {
      return { token: existing, source: 'file', file };
    }
  } catch {
    // No token yet.
  }

  const generated = randomToken(32);
  mkdirSync(ctx.env.PLATTER_DATA_DIR, { recursive: true });
  // 0600: the token grants full control of every server on this machine.
  writeFileSync(file, `${generated}\n`, { mode: 0o600 });
  log.info('generated an MCP bearer token', { file });
  return { token: generated, source: 'generated', file };
}

/** Constant-time comparison, so the token cannot be recovered by timing the 401. */
function authorised(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) {
    return false;
  }
  const provided = Buffer.from(header.slice(7).trim());
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // A JSON-RPC message has no business being larger than this, and an unbounded read is a
      // trivial memory-exhaustion vector on a listening socket.
      if (size > 4 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}
