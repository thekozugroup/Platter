import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { connectDatabase, disconnectDatabase } from '../db.js';
import { unauthenticated } from '../lib/errors.js';
import { resolveApiKeyPrincipal } from './auth.js';
import { createMcpServer } from './server.js';

/**
 * The stdio transport, for a client that launches Platter's MCP server as a child process.
 *
 * The single constraint that shapes this file: **stdout is the protocol**. One stray line on
 * it corrupts the JSON-RPC stream and the client sees a parse error rather than a log
 * message, so `buildLoggerOptions()` — which pretty-prints to stdout in development — must
 * not be used here. Diagnostics go to stderr, which every MCP client forwards to its own
 * log and nothing tries to parse.
 *
 * A locally launched client has no HTTP request to carry credentials, so the API key comes
 * from the environment. It is still an ordinary Platter API key resolved through the ordinary
 * path: launching the server locally grants no authority that an HTTP caller would not have.
 */

export const API_KEY_ENV = 'PLATTER_API_KEY';

/**
 * A `FastifyBaseLogger` that writes to stderr and nothing else.
 *
 * Written out rather than borrowing pino because pino is not a direct dependency of this
 * package, and because the default destination — stdout — is the one place this process may
 * never write.
 */
export function stderrLogger(level = 'info'): FastifyBaseLogger {
  const emit =
    (severity: string) =>
    (...args: unknown[]): void => {
      const parts = args.map((arg) => (typeof arg === 'string' ? arg : safeStringify(arg)));
      process.stderr.write(`[platter-mcp] ${severity} ${parts.join(' ')}\n`);
    };

  const logger: FastifyBaseLogger = {
    level,
    fatal: emit('fatal'),
    error: emit('error'),
    warn: emit('warn'),
    info: emit('info'),
    debug: emit('debug'),
    trace: emit('trace'),
    silent: () => {},
    child: () => logger,
  };
  return logger;
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // A circular object in a log line must not take the process down with it.
    return '[unserializable]';
  }
}

export interface StdioServerOptions {
  /** Defaults to `process.env.PLATTER_API_KEY`. */
  apiKey?: string;
  /** Defaults to a stderr-only logger; anything passed here must not write to stdout. */
  logger?: FastifyBaseLogger;
  /** Defaults to `process.stdin`. Overridable so the transport can be driven without a process. */
  stdin?: Readable;
  /** Defaults to `process.stdout`. */
  stdout?: Writable;
}

export interface StdioServerHandle {
  readonly server: Server;
  readonly transport: StdioServerTransport;
  /** Resolves when the client disconnects or `close` is called. */
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

/**
 * Resolves the credential, connects the database, and starts serving on stdin/stdout.
 *
 * The caller owns process lifetime: wire SIGINT/SIGTERM to `close()`, and `await closed` to
 * exit when the client goes away.
 */
export async function runStdioMcpServer(
  options: StdioServerOptions = {},
): Promise<StdioServerHandle> {
  const logger = options.logger ?? stderrLogger();
  const apiKey = options.apiKey ?? process.env[API_KEY_ENV];
  if (apiKey === undefined || apiKey.length === 0) {
    throw unauthenticated(
      `Set ${API_KEY_ENV} to a Platter API key. Create one under Settings → API keys.`,
    );
  }

  await connectDatabase();

  let principal;
  try {
    principal = await resolveApiKeyPrincipal(apiKey, { userAgent: 'platter-mcp-stdio' });
  } catch (error) {
    // The connection opened above is ours to close; a bad key must not leak a pool.
    await disconnectDatabase().catch(() => {});
    throw error;
  }

  // A stdio process holds one key for its whole life and has no way to re-present it, so
  // there is nothing to re-read: the constant is the honest answer here.
  const server = createMcpServer({ principal: () => principal, logger });
  const transport = new StdioServerTransport(options.stdin, options.stdout);

  let settle: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    settle = resolve;
  });

  let shuttingDown = false;
  const close = async (): Promise<void> => {
    if (shuttingDown) return closed;
    shuttingDown = true;
    // Closing the server closes the transport it owns; the database goes last so an
    // in-flight tool call can still finish its query.
    await server.close().catch((error: unknown) => {
      logger.error(error, 'failed to close the MCP server');
    });
    await disconnectDatabase().catch((error: unknown) => {
      logger.error(error, 'failed to disconnect the database');
    });
    settle?.();
    return undefined;
  };

  server.onclose = (): void => {
    void close();
  };

  await server.connect(transport);
  logger.info(
    `serving MCP over stdio as ${principal.user.username} (key ${principal.apiKeyPrefix})`,
  );

  return { server, transport, closed, close };
}
