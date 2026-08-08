import { disconnectDatabase } from '../db.js';
import { runStdioMcpServer, stderrLogger, API_KEY_ENV } from './stdio.js';

/**
 * The stdio entry point: `node dist/mcp/cli.js`, or `tsx src/mcp/cli.ts` in development.
 *
 * This is what an MCP client (Claude Desktop, an agent runtime) spawns. It speaks JSON-RPC
 * over stdin/stdout and nothing else may be written there — a stray `console.log` would be
 * parsed as a protocol frame and kill the session — so every diagnostic goes to stderr via
 * `stderrLogger`.
 *
 * It talks to the database directly rather than over HTTP, so it needs no running API
 * process; `PLATTER_API_KEY` is still required, because the key is what decides which
 * servers this session may touch.
 */

const logger = stderrLogger();

let handle: Awaited<ReturnType<typeof runStdioMcpServer>>;
try {
  handle = await runStdioMcpServer({ logger });
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n` +
      `Set ${API_KEY_ENV} to a Platter API key and try again.\n`,
  );
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
}

let closing = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  // A second signal must not race the first one's teardown.
  if (closing) return;
  closing = true;
  logger.info({ signal }, 'mcp stdio server shutting down');
  try {
    await handle.close();
  } finally {
    await disconnectDatabase().catch(() => undefined);
    process.exit(0);
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

// The client closing the pipe is the ordinary way this ends, and it arrives as the
// transport resolving rather than as a signal.
await handle.closed;
if (!closing) {
  await disconnectDatabase().catch(() => undefined);
  process.exit(0);
}
