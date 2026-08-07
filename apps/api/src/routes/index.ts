import type { FastifyPluginAsync } from 'fastify';
import aiRoutes from './ai.js';
import auditRoutes from './audit.js';
import authRoutes from './auth.js';
import backupRoutes from './backups.js';
import blueprintRoutes from './blueprints.js';
import consoleRoutes from './console.js';
import fileRoutes from './files.js';
import nodeRoutes from './nodes.js';
import scheduleRoutes from './schedules.js';
import serverRoutes from './servers.js';
import systemRoutes from './system.js';
import userRoutes from './users.js';

/**
 * The whole HTTP surface, mounted under `API_PREFIX` by `buildApp`.
 *
 * Each module owns one prefix and nothing outside it. The nested prefixes carry
 * `:serverId`, which is what lets `requireServerAccess` resolve the server from params
 * without every handler re-reading it.
 */
const routes: FastifyPluginAsync = async (app) => {
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(serverRoutes, { prefix: '/servers' });
  await app.register(fileRoutes, { prefix: '/servers/:serverId/files' });
  await app.register(backupRoutes, { prefix: '/servers/:serverId/backups' });
  await app.register(scheduleRoutes, { prefix: '/servers/:serverId/schedules' });
  await app.register(blueprintRoutes, { prefix: '/blueprints' });
  await app.register(nodeRoutes, { prefix: '/nodes' });
  await app.register(userRoutes, { prefix: '/users' });
  await app.register(auditRoutes, { prefix: '/audit' });
  await app.register(systemRoutes, { prefix: '/system' });
  await app.register(aiRoutes, { prefix: '/ai' });
  // No prefix: the console owns the websocket upgrade path, which is fixed by the shared
  // WS_PATH constant rather than mounted under one of the REST prefixes.
  await app.register(consoleRoutes);
};

export default routes;
