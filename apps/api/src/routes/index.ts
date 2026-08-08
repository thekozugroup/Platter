import type { FastifyPluginAsync } from 'fastify';
import aiRoutes from './ai.js';
import auditRoutes from './audit.js';
import authRoutes from './auth.js';
import backupRoutes from './backups.js';
import blueprintRoutes from './blueprints.js';
import consoleRoutes from './console.js';
import fileRoutes from './files.js';
import mcpRoutes from './mcp.js';
import metricsRoutes from './metrics.js';
import modRoutes from './mods.js';
import networkRoutes from './network.js';
import nodeRoutes from './nodes.js';
import playerRoutes from './players.js';
import proposalRoutes from './proposals.js';
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
  await app.register(playerRoutes, { prefix: '/servers/:serverId/players' });
  await app.register(modRoutes, { prefix: '/servers/:serverId/mods' });
  await app.register(proposalRoutes, { prefix: '/servers/:serverId/proposals' });
  await app.register(metricsRoutes, { prefix: '/servers/:serverId/metrics' });
  await app.register(blueprintRoutes, { prefix: '/blueprints' });
  await app.register(nodeRoutes, { prefix: '/nodes' });
  await app.register(userRoutes, { prefix: '/users' });
  await app.register(auditRoutes, { prefix: '/audit' });
  await app.register(systemRoutes, { prefix: '/system' });
  await app.register(aiRoutes, { prefix: '/ai' });
  // The MCP transport is not REST and carries its own JSON-RPC envelope; it lives under
  // the API prefix so a single base URL and API key cover both surfaces.
  await app.register(mcpRoutes, { prefix: '/mcp' });
  // No prefix: these two mount their own paths. The console owns the websocket upgrade
  // path, fixed by the shared WS_PATH constant; network spans both `/servers/:serverId`
  // and the node-wide `/network/zone`, so it cannot sit under a single prefix.
  await app.register(consoleRoutes);
  await app.register(networkRoutes);
};

export default routes;
