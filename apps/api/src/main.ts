import { buildApp } from './app.js';
import { config } from './config.js';
import { connectDatabase, disconnectDatabase } from './db.js';

/**
 * How long a shutdown may take before we stop being polite. Long enough for in-flight
 * requests and a container stop to finish, short enough that an orchestrator's own kill
 * timer does not beat us to it.
 */
const SHUTDOWN_TIMEOUT_MS = 20_000;

const app = await buildApp();

try {
  // Before listening: a process that cannot reach its database should fail to start, not
  // accept traffic and 500 every request.
  await connectDatabase();
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.fatal({ err: error }, 'failed to start');
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
}

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  // A second Ctrl-C should not restart the sequence and race the first one.
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');

  // Not unref'd: this timer is the whole point — if close() wedges on a stuck stream we
  // want the process to die anyway, and an unref'd timer would let it exit silently first.
  const guard = setTimeout(() => {
    app.log.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    // Stops accepting connections, drains in-flight requests, then runs onClose hooks —
    // which is where the console plugin closes its websockets and the scheduler stops.
    await app.close();
    await disconnectDatabase();
    clearTimeout(guard);
    app.log.info('shutdown complete');
    process.exit(0);
  } catch (error) {
    clearTimeout(guard);
    app.log.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

// An unhandled rejection means some path skipped its error handling. Log it with the real
// reason and keep serving: killing a control plane over one bad promise is the worse
// failure mode for the servers it is supervising.
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'unhandled promise rejection');
});

process.on('uncaughtException', (error) => {
  // Unlike a rejection, the stack that threw is gone and process state is unknown, so the
  // only safe move is to log and let the supervisor restart us.
  app.log.fatal({ err: error }, 'uncaught exception');
  void shutdown('SIGTERM');
});
