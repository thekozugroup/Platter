import 'server-only';
import { closeAllRcon, createContext, startSupervisor, stopSupervisor } from '@platter/core';
import { logger } from '@platter/shared';

const log = logger.child('web');

/**
 * Start Platter's background work.
 *
 * Docker being unavailable is deliberately non-fatal. The UI should still load and explain that
 * Docker is not running, with the command to fix it — a local tool that refuses to start because
 * a dependency is down gives the user nothing to act on.
 */
export async function bootstrap(): Promise<void> {
  const context = await createContext();

  if (!context.ok) {
    log.error('Platter started without Docker', {
      code: context.error.code,
      message: context.error.message,
    });
    return;
  }

  startSupervisor(context.value);

  // Stopping cleanly matters more here than in most web apps: an abrupt exit leaves RCON
  // sockets open against running game servers and skips the WAL checkpoint on the database.
  const shutdown = (signal: string): void => {
    log.info(`received ${signal}, shutting down`);
    stopSupervisor();
    void closeAllRcon().finally(() => process.exit(0));
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
