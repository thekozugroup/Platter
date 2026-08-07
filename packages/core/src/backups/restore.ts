import { createReadStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { backups } from '@platter/db';
import { fail, LIVE_STATUSES, logger, ok, paths, type Result, ulid } from '@platter/shared';
import { eq } from 'drizzle-orm';
import * as tar from 'tar-fs';
import type { Context } from '../context';
import { EVENT, emitEvent } from '../events';
import { lockKey, withLock } from '../locks';
import { isContained, isWithin } from '../paths';
import { getServer } from '../servers/repository';
import { startServer, stopServer } from '../servers/service';
import { runBackup } from './create';

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
  // Same lock as backups: a restore that swaps the data directory while a backup is reading it
  // would archive a half-swapped tree. The safety backup taken inside runs on this same chain,
  // which is why the lock is re-entrant by queuing rather than by flag.
  return withLock(lockKey.backup(backup.serverId), () => runRestore(ctx, backupId, options));
}

async function runRestore(
  ctx: Context,
  backupId: string,
  options: RestoreOptions
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

  /*
   * "Running" is not the only state in which the JVM is alive.
   *
   * `unhealthy`, `starting` and `installing` all mean the container is up and holding open file
   * descriptors on region files. Restoring under any of them renames the data directory out from
   * under a live process — which on Linux succeeds silently, leaves the JVM writing into the
   * directory about to be deleted, and destroys the world. `unhealthy` in particular is a state
   * ordinary servers reach on their own, so this is a reachable path, not a corner case.
   */
  const wasLive = LIVE_STATUSES.has(server.status);

  /* --- Safety net -------------------------------------------------------- */
  if (options.safetyBackup !== false) {
    options.onProgress?.({ phase: 'backing up current state' });
    // `runBackup`, not `createBackup`: this already holds the per-server backup lock.
    const safety = await runBackup(ctx, {
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
  if (wasLive) {
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

    if (wasLive) {
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
 * Where a link entry in an archive would actually point once extracted.
 *
 * `linkname` is interpreted by the kernel relative to the *directory holding the link*, not
 * relative to the extraction root — so a link at `mods/cfg` with target `../../etc` lands two
 * levels above `mods/`, not two above the destination. Resolving it against the wrong base makes
 * the guard both too strict on innocent archives and too loose on hostile ones.
 *
 * An absolute target is refused outright rather than resolved: nothing Platter produces contains
 * one, and there is no absolute target that is meaningful after the tree has been moved to a
 * different machine and a different data directory.
 */
export function resolveLinkTarget(
  destination: string,
  entryName: string,
  linkname: string
): string | null {
  if (linkname.includes('\0') || isAbsolute(linkname)) {
    return null;
  }
  return resolve(destination, dirname(entryName), linkname);
}

/**
 * Extract the archive, refusing any entry that would write outside the destination.
 *
 * A tar archive can contain `../../etc/cron.d/x`, an absolute path, or a symlink whose target
 * escapes — this is the classic "Zip Slip" family and it applies equally to tar. Platter's own
 * archives are safe, but a user can upload one ("here's my world download", "here's my export
 * from the other panel"), and treating a file on disk as trusted because we usually wrote it is
 * exactly the assumption these bugs live in.
 *
 * The two checks use two different containment functions on purpose. Entry *names* are relative
 * to the destination and tar-fs strips their leading slashes, so `isWithin`'s re-rooting matches
 * what lands on disk. Link *targets* are literal paths, so they need `isContained`, which does
 * not re-root — `isWithin('/data', '/etc/passwd')` is true, and a symlink guard that returns true
 * for `/etc/passwd` is not a guard.
 */
async function extract(archivePath: string, destination: string): Promise<void> {
  await pipeline(
    createReadStream(archivePath),
    createGunzip(),
    tar.extract(destination, {
      // tar-fs hands `ignore` the already-joined absolute path, so this is the literal
      // destination-relative check, not the entry-name one below.
      ignore: (name) => !isContained(destination, name),
      map: (header) => {
        if (!isWithin(destination, header.name)) {
          throw new Error(`Archive entry "${header.name}" escapes the destination directory.`);
        }
        if (
          (header.type === 'symlink' || header.type === 'link') &&
          header.linkname !== undefined
        ) {
          const target = resolveLinkTarget(destination, header.name, header.linkname);
          if (target === null || !isContained(destination, target)) {
            throw new Error(
              `Archive entry "${header.name}" links to "${header.linkname}", outside the destination.`
            );
          }
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
