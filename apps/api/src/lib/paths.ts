import path from 'node:path';
import { config } from '../config.js';

/**
 * Where a server's data volume lives on the host. Shared by files, backups, mods and the
 * Minecraft config readers.
 *
 * This lives in a dependency-free leaf module rather than in `services/lifecycle.ts`
 * because almost everything needs the path and nothing else lifecycle exports. Keeping it
 * here is what lets lifecycle import the services that clean up after a deleted server
 * (players, proposals, mDNS) without a cycle back through this one function.
 */
export function serverDataDir(serverId: string): string {
  return path.join(config.serversDir, serverId);
}

/**
 * Where a server's backup archives live.
 *
 * Here rather than in `services/backups.ts` for the same reason as above: `deleteServer`
 * has to remove this directory, and `services/backups.ts` imports `services/lifecycle.ts`,
 * so reaching back the other way for one `path.join` would be a cycle. Leaving it out is
 * what made every deleted server's archives immortal — the `Backup` rows cascade away, so
 * nothing in the product could ever find or reclaim the files again.
 */
export function serverBackupDir(serverId: string): string {
  return path.join(config.backupDir, serverId);
}
