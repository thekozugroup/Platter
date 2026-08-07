import { createReadStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { eq } from 'drizzle-orm';
import * as tar from 'tar-fs';
import { backups } from '@platter/db';
import { type Result, fail, logger, ok, paths, ulid } from '@platter/shared';
import type { Context } from '../context.js';
import { EVENT, emitEvent } from '../events.js';
import { isWithin } from '../paths.js';
import { getServer } from '../servers/repository.js';
import { startServer, stopServer } from '../servers/service.js';
import { createBackup } from './create.js';

const log = logger.child('backups');

export interface RestoreOptions {
  /**
   * Take a safety backup of the current state first. On by default, and turning it off is a
   * deliberate act — PufferPanel's restore "deletes all files" with no undo, and that is the
   * single most-complained-about behaviour in any of these panels.
   */
  safetyBackup?: boolean;
  actor?: 'user' | 'ai';
  onProgress?: (progress: { phase: string }) => void;
}

/**
 * Restore a backup.
 *
 * Extraction goes to a sibling staging directory and only swaps in at the end. The obvious
 * implementation — wipe the data directory, then extract — has a failure mode that destroys the
 * world: if extraction dies halfway (disk full, corrupt archive, process killed), the old data
 * is already gone and the new data is incomplete. Staging means a failed restore leaves the
 * original untouched.
 */
export async function restoreBackup(
  ctx: Context,
  backupId: string,
  options: RestoreOptions = {}
): Promise<Result<void>> {
  const backup = ctx.db.select().from(backups).where(eq(backups.id, backupId)).get();
  if (!backup) {
    return fail('not_found', `No backup with id ${backupId}.`);
  }
  if (backup.status !== 'complete') {
    return fail('invalid_state', `Backup ${backupId} is ${backup.status} and cannot be restored.`);
  }

  const server = getServer(ctx.db, backup.serverId);
  if (!server) {
    return fail('not_found', `Backup ${backupId} belongs to a server that no longer exists.`);
  }

  const wasRunning = server.status === 'running';

  /* --- Safety net -------------------------------------------------------- */
  if (options.safetyBackup !== false) {
    options.onProgress?.({ phase: 'backing up current state' });
    const safety = await createBackup(ctx, {
      serverId: server.id,
      label: `Before restoring ${new Date(backup.createdAt).toISOString()}`,
      trigger: 'pre-restore',
      actor: 'system',
    });
    if (!safety.ok) {
      return fail(
        'internal',
        `Could not take a safety backup before restoring: ${safety.error.message}. ` +
          'Pass safetyBackup: false to restore anyway.',
        { details: { serverId: server.id } }
      );
    }
  }

  /* --- Stop -------------------------------------------------------------- */
  // Restoring into a running server means the JVM holds open file handles on region files it is
  // about to have replaced underneath it. There is no safe version of that.
  if (wasRunning) {
    options.onProgress?.({ phase: 'stopping server' });
    const stopped = await stopServer(ctx, server.id, { actor: options.actor ?? 'user' });
    if (!stopped.ok) {
      return stopped;
    }
  }

  ctx.db.update(backups).set({ status: 'restoring' }).where(eq(backups.id, backupId)).run();

  const staging = join(paths.tmp(ctx.env.PLATTER_DATA_DIR), `restore-${ulid()}`);
  const retired = `${server.dataDir}.old-${Date.now()}`;

  try {
    options.onProgress?.({ phase: 'extracting' });
    await mkdir(staging, { recursive: true });
    await extract(backup.path, staging);

    options.onProgress?.({ phase: 'swapping in' });
    // Two renames on the same filesystem: near-atomic, and the old data survives until the new
    // data is definitely in place.
    await rename(server.dataDir, retired);
    try {
      await rename(staging, server.dataDir);
    } catch (cause) {
      // Put the original back before surfacing anything.
      await rename(retired, server.dataDir).catch(() => undefined);
      throw cause;
    }
    await rm(retired, { recursive: true, force: true });

    ctx.db.update(backups).set({ status: 'complete' }).where(eq(backups.id, backupId)).run();
    emitEvent(ctx.db, {
      serverId: server.id,
      type: EVENT.backupRestored,
      message: `Restored ${server.name} from ${new Date(backup.createdAt).toLocaleString()}`,
      actor: options.actor ?? 'user',
      data: { backupId, hot: backup.hotBackup },
    });

    if (wasRunning) {
      options.onProgress?.({ phase: 'starting server' });
      const started = await startServer(ctx, server.id, { actor: options.actor ?? 'user' });
      if (!started.ok) {
        return started;
      }
    }

    return ok(undefined);
  } catch (cause) {
    await rm(staging, { recursive: true, force: true });
    ctx.db.update(backups).set({ status: 'complete' }).where(eq(backups.id, backupId)).run();
    const message = cause instanceof Error ? cause.message : String(cause);
    log.error('restore failed', { serverId: server.id, backupId, error: message });
    emitEvent(ctx.db, {
      serverId: server.id,
      type: EVENT.backupFailed,
      level: 'error',
      message: `Restore failed: ${message}. The server's data was left untouched.`,
      actor: options.actor ?? 'user',
      data: { backupId },
    });
    return fail('internal', `Restore failed: ${message}`, { cause });
  }
}

/**
 * Extract the archive, refusing any entry that would write outside the destination.
 *
 * A tar archive can contain `../../etc/cron.d/x`, an absolute path, or a symlink whose target
 * escapes — this is the classic "Zip Slip" family and it applies equally to tar. Platter's own
 * archives are safe, but a user can upload one, and treating a file on disk as trusted because
 * we usually wrote it is exactly the assumption these bugs live in.
 */
async function extract(archivePath: string, destination: string): Promise<void> {
  await pipeline(
    createReadStream(archivePath),
    createGunzip(),
    tar.extract(destination, {
      // tar-fs strips leading slashes itself, but `..` segments and symlink targets still need
      // checking, and a hard link's target is a path too.
      ignore: (name) => !isWithin(destination, name),
      map: (header) => {
        if (!isWithin(destination, header.name)) {
          throw new Error(`Archive entry "${header.name}" escapes the destination directory.`);
        }
        if (
          (header.type === 'symlink' || header.type === 'link') &&
          header.linkname !== undefined &&
          !isWithin(destination, header.linkname)
        ) {
          throw new Error(
            `Archive entry "${header.name}" links to "${header.linkname}", outside the destination.`
          );
        }
        return header;
      },
    })
  );
}

/** Delete a backup archive and its row. */
export async function deleteBackup(ctx: Context, backupId: string): Promise<Result<void>> {
  const backup = ctx.db.select().from(backups).where(eq(backups.id, backupId)).get();
  if (!backup) {
    return ok(undefined);
  }
  await rm(backup.path, { force: true });
  ctx.db.delete(backups).where(eq(backups.id, backupId)).run();
  return ok(undefined);
}
