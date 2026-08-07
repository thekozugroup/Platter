import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import * as tar from 'tar-fs';
import { backups, modInstalls } from '@platter/db';
import {
  type BackupTrigger,
  type Result,
  fail,
  logger,
  ok,
  paths,
  ulid,
} from '@platter/shared';
import type { Context } from '../context';
import { EVENT, emitEvent } from '../events';
import { resumeSaves, suspendSaves } from '../rcon';
import { lockKey, withLock } from '../locks';
import { getServer } from '../servers/repository';

const log = logger.child('backups');

/**
 * Hot backups.
 *
 * This is the thing Platter does that the other panels do not. PufferPanel requires the server
 * to be off and its restore deletes every file; Crafty warns in its own documentation that
 * compressing a live world "can lead to unintended side effects such as chunk corruption"; both
 * are right, because copying region files while the server is writing them produces torn
 * chunks.
 *
 * The fix is well known and nobody implements it:
 *
 *   save-off          stop the auto-save thread
 *   save-all flush    force every dirty chunk to disk AND WAIT for it
 *   → archive         the on-disk world is now internally consistent
 *   save-on           resume
 *
 * The `flush` argument is load-bearing. Plain `save-all` returns before the write completes, so
 * the archive still catches a half-written region file — which is exactly the corruption people
 * blame on compression.
 *
 * While saves are off the server keeps running and players keep playing; chunk changes
 * accumulate in memory and land on the next save. The only cost is a slightly larger write
 * afterwards.
 */

export interface CreateBackupInput {
  serverId: string;
  label?: string | undefined;
  trigger?: BackupTrigger;
  actor?: 'user' | 'ai' | 'schedule' | 'system';
  /** Paths inside /data to exclude, in addition to the defaults. */
  exclude?: string[];
  onProgress?: (progress: { phase: string; bytes?: number }) => void;
}

/**
 * Never archived.
 *
 * Logs are the biggest thing in a server directory and the least useful in a restore — a
 * crash-looping server can write gigabytes of them. `latest.log` is kept because it is what a
 * diagnosis needs. The dotfiles are the image's install-state caches: restoring a stale one
 * sends the container into a confusing reinstall loop.
 */
const DEFAULT_EXCLUDES = [
  'crash-reports/',
  '.tmp/',
  'cache/',
  'libraries/',
  'versions/',
  '.paper.env',
  '.purpur.env',
  '.quilt.env',
  '.run-forge.env',
  '.run-neoforge.env',
  '.install-vanilla.env',
  '.mc-health.env',
];

/**
 * Kept even though its directory is otherwise excluded — a diagnosis needs the current log.
 *
 * This is why `logs/` is not excluded wholesale: tar-fs prunes recursion at a skipped directory,
 * so anything inside a directory you exclude is unreachable no matter what else you say. The
 * directory is walked and its *entries* are filtered instead.
 */
const ALWAYS_INCLUDE = new Set(['logs/latest.log']);

/** Directories whose contents are dropped but which must still be descended into. */
const PRUNE_CONTENTS_OF = ['logs'];

/**
 * Build the tar-fs `ignore` predicate.
 *
 * tar-fs v3 calls this with an **absolute host path**, not a path relative to the archive root
 * — it does `ignore(join(cwd, next, entry))`. Comparing that against relative patterns silently
 * matches nothing, which is a failure with no symptom: every backup simply contains everything,
 * and you only notice when a nightly archive of a crash-looping server is several gigabytes of
 * logs. Relativising first is the whole fix.
 */
function makeFilter(sourceDir: string, excludes: string[]): (name: string) => boolean {
  const all = [...DEFAULT_EXCLUDES, ...excludes];

  return (name: string) => {
    // Absolute from tar-fs; tolerate a relative path too so the predicate is unit-testable.
    const rel = (isAbsolute(name) ? relative(sourceDir, name) : name)
      .split(sep)
      .join('/')
      .replace(/^\/+/, '');

    if (rel === '' || rel.startsWith('..')) {
      return false;
    }
    if (ALWAYS_INCLUDE.has(rel)) {
      return false; // tar-fs `ignore` returns true to SKIP.
    }
    // Descend into these so their kept entries are reachable, but drop everything else in them.
    if (PRUNE_CONTENTS_OF.includes(rel)) {
      return false;
    }
    if (PRUNE_CONTENTS_OF.some((dir) => rel.startsWith(`${dir}/`))) {
      return true;
    }

    return all.some((pattern) =>
      pattern.endsWith('/')
        ? rel === pattern.slice(0, -1) || rel.startsWith(pattern)
        : rel === pattern
    );
  };
}

export { makeFilter as __makeFilterForTests };

export async function createBackup(
  ctx: Context,
  input: CreateBackupInput
): Promise<Result<{ id: string; path: string; sizeBytes: number }>> {
  // Serialised per server. `save-off`/`save-on` are global switches on the Minecraft server, so
  // two overlapping backups let the first one's `save-on` land in the middle of the second one's
  // archive — producing exactly the torn chunks this whole sequence exists to prevent, in a file
  // that still checksums cleanly. Reachable today from the UI, the MCP tool and the scheduler.
  return withLock(lockKey.backup(input.serverId), () => runBackup(ctx, input));
}

/**
 * The backup itself, without taking the lock.
 *
 * Exported because `restoreBackup` holds the same lock while taking its safety copy, and calling
 * the locked entry point from inside would queue behind a lock the caller already owns — a
 * deadlock that would present as a restore hanging forever with no error. Anything else should
 * call `createBackup`.
 */
export async function runBackup(
  ctx: Context,
  input: CreateBackupInput
): Promise<Result<{ id: string; path: string; sizeBytes: number }>> {
  const server = getServer(ctx.db, input.serverId);
  if (!server) {
    return fail('not_found', `No server with id ${input.serverId}.`);
  }

  const id = ulid();
  const dir = paths.serverBackups(ctx.env.PLATTER_DATA_DIR, server.id);
  await mkdir(dir, { recursive: true });

  const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${id.slice(-8)}.tar.gz`;
  const archivePath = join(dir, fileName);
  const isHot = server.status === 'running' && server.rconPort !== null;

  // Record what was installed at capture time. Without it, "restore this backup" cannot tell
  // the user that it will also roll back four mod installs.
  const manifest = {
    server: {
      name: server.name,
      loader: server.loader,
      gameVersion: server.gameVersion,
      loaderVersion: server.loaderVersion,
      image: server.image,
    },
    mods: ctx.db
      .select({
        name: modInstalls.displayName,
        provider: modInstalls.provider,
        slug: modInstalls.projectSlug,
        version: modInstalls.versionLabel,
        file: modInstalls.filePath,
      })
      .from(modInstalls)
      .where(and(eq(modInstalls.serverId, server.id), eq(modInstalls.status, 'installed')))
      .all(),
    capturedAt: Date.now(),
  };

  ctx.db
    .insert(backups)
    .values({
      id,
      serverId: server.id,
      label: input.label ?? null,
      path: archivePath,
      status: 'running',
      trigger: input.trigger ?? 'manual',
      hotBackup: isHot,
      manifest,
    })
    .run();

  emitEvent(ctx.db, {
    serverId: server.id,
    type: EVENT.backupStarted,
    message: `Backing up ${server.name}${isHot ? ' (live)' : ''}`,
    actor: input.actor ?? 'user',
    data: { backupId: id, hot: isHot },
  });

  const rconTarget = {
    serverId: server.id,
    host: '127.0.0.1',
    port: server.rconPort ?? 0,
    password: server.rconPassword,
  };

  let savesSuspended = false;
  try {
    if (isHot) {
      input.onProgress?.({ phase: 'flushing world to disk' });
      const suspended = await suspendSaves(rconTarget);
      if (suspended.ok) {
        savesSuspended = true;
      } else {
        // A server that will not answer RCON cannot be snapshotted consistently. Say so rather
        // than producing an archive that might contain torn chunks.
        await failBackup(ctx, id, server.id, suspended.error.message, input.actor);
        return fail(
          'rcon_unavailable',
          `Could not flush ${server.name}'s world before backing up: ${suspended.error.message}. ` +
            'Stop the server and try again for a guaranteed-consistent backup.',
          { details: { serverId: server.id } }
        );
      }
    }

    input.onProgress?.({ phase: 'archiving' });
    const sizeBytes = await archive(
      server.dataDir,
      archivePath,
      makeFilter(server.dataDir, input.exclude ?? []),
      input.onProgress
    );

    if (savesSuspended) {
      const resumed = await resumeSaves(rconTarget);
      savesSuspended = false;
      if (!resumed.ok) {
        // The archive is fine, but auto-save is still off — that is a data-loss risk, so it is
        // an error-level event even though the backup itself succeeded.
        log.error('could not re-enable auto-save after backup', { serverId: server.id });
        emitEvent(ctx.db, {
          serverId: server.id,
          type: EVENT.backupCompleted,
          level: 'error',
          message:
            'Backup finished but auto-save could not be re-enabled. Restart the server to be safe.',
          actor: 'system',
        });
      }
    }

    input.onProgress?.({ phase: 'checksumming' });
    const sha256 = await checksum(archivePath);

    ctx.db
      .update(backups)
      .set({ status: 'complete', sizeBytes, sha256, completedAt: Date.now() })
      .where(eq(backups.id, id))
      .run();

    emitEvent(ctx.db, {
      serverId: server.id,
      type: EVENT.backupCompleted,
      message: `Backed up ${server.name} (${formatBytes(sizeBytes)})`,
      actor: input.actor ?? 'user',
      data: { backupId: id, sizeBytes, hot: isHot },
    });

    return ok({ id, path: archivePath, sizeBytes });
  } catch (cause) {
    // The failure path must re-enable saves. Leaving them off means the world silently stops
    // persisting until the next restart, which turns a failed backup into lost play time.
    if (savesSuspended) {
      await resumeSaves(rconTarget).catch(() => undefined);
    }
    await rm(archivePath, { force: true });
    const message = cause instanceof Error ? cause.message : String(cause);
    await failBackup(ctx, id, server.id, message, input.actor);
    return fail('internal', `Backup failed: ${message}`, { details: { serverId: server.id }, cause });
  }
}

async function failBackup(
  ctx: Context,
  backupId: string,
  serverId: string,
  message: string,
  actor: CreateBackupInput['actor']
): Promise<void> {
  ctx.db
    .update(backups)
    .set({ status: 'failed', statusMessage: message, completedAt: Date.now() })
    .where(eq(backups.id, backupId))
    .run();
  emitEvent(ctx.db, {
    serverId,
    type: EVENT.backupFailed,
    level: 'error',
    message: `Backup failed: ${message}`,
    actor: actor ?? 'system',
    data: { backupId },
  });
}

function archive(
  sourceDir: string,
  destination: string,
  ignore: (name: string) => boolean,
  onProgress?: CreateBackupInput['onProgress']
): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    let bytes = 0;
    const out = createWriteStream(destination);
    out.on('drain', () => onProgress?.({ phase: 'archiving', bytes }));

    const pack = tar.pack(sourceDir, {
      ignore,
      // Follow no symlinks: a symlink inside the data directory pointing at /etc would
      // otherwise be dereferenced straight into the archive.
      dereference: false,
    });

    const gzip = createGzip({ level: 6 });
    gzip.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });

    pipeline(pack, gzip, out).then(() => resolvePromise(bytes), reject);
  });
}

async function checksum(path: string): Promise<string> {
  const hash = createHash('sha256');
  // Streamed rather than read whole: a backup archive is routinely gigabytes.
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

/* -------------------------------------------------------------------------- */
/* Retention                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Delete backups beyond the retention window.
 *
 * Keeps the newest `keep` complete backups regardless of age — a server nobody has touched in
 * three months should still have its last backup, not zero.
 */
export async function pruneBackups(
  ctx: Context,
  serverId: string,
  options: { keep?: number; maxAgeDays?: number } = {}
): Promise<Result<number>> {
  const server = getServer(ctx.db, serverId);
  if (!server) {
    return fail('not_found', `No server with id ${serverId}.`);
  }

  const keep = options.keep ?? server.backupRetention;
  const rows = ctx.db
    .select()
    .from(backups)
    .where(and(eq(backups.serverId, serverId), eq(backups.status, 'complete')))
    .orderBy(desc(backups.createdAt))
    .all();

  const survivors = new Set(rows.slice(0, keep).map((row) => row.id));
  const cutoff =
    options.maxAgeDays === undefined ? 0 : Date.now() - options.maxAgeDays * 86_400_000;

  let removed = 0;
  for (const row of rows) {
    if (survivors.has(row.id)) {
      continue;
    }
    if (cutoff > 0 && row.createdAt >= cutoff) {
      continue;
    }
    await rm(row.path, { force: true });
    ctx.db.delete(backups).where(eq(backups.id, row.id)).run();
    removed++;
  }

  // Failed backups leave no useful artefact; clear their rows after a day so the list stays
  // readable, but not instantly — a user should get a chance to see why it failed.
  ctx.db
    .delete(backups)
    .where(
      and(
        eq(backups.serverId, serverId),
        eq(backups.status, 'failed'),
        lt(backups.createdAt, Date.now() - 86_400_000)
      )
    )
    .run();

  if (removed > 0) {
    emitEvent(ctx.db, {
      serverId,
      type: EVENT.backupPruned,
      message: `Removed ${removed} old backup${removed === 1 ? '' : 's'}`,
      actor: 'system',
      data: { removed, keep },
    });
  }

  return ok(removed);
}

/**
 * Resolve backups left in a non-terminal state by a restart.
 *
 * A row is inserted as `running` before the archive starts, so a Platter that is stopped or
 * OOM-killed mid-backup leaves it that way forever: `pruneBackups` only ever considers
 * `complete` rows, so the half-written archive is invisible to retention and accumulates. A row
 * stuck in `restoring` is worse — `restoreBackup` refuses anything that is not `complete`, so
 * that backup is permanently unusable with no way to retry it.
 *
 * Called once at startup, where nothing can legitimately be in flight yet.
 */
export async function sweepInterruptedBackups(ctx: Context): Promise<number> {
  const stuck = ctx.db
    .select()
    .from(backups)
    .where(or(eq(backups.status, 'running'), eq(backups.status, 'restoring')))
    .all();

  for (const row of stuck) {
    if (row.status === 'running') {
      // The archive is incomplete by definition; nothing can use it.
      await rm(row.path, { force: true });
      ctx.db
        .update(backups)
        .set({
          status: 'failed',
          statusMessage: 'Interrupted by a Platter restart.',
          completedAt: Date.now(),
        })
        .where(eq(backups.id, row.id))
        .run();
    } else {
      // A `restoring` row's archive is intact — only the restore was cut short. Returning it to
      // `complete` makes it retryable, which is what the user wants.
      ctx.db.update(backups).set({ status: 'complete' }).where(eq(backups.id, row.id)).run();
    }
  }

  if (stuck.length > 0) {
    log.warn('resolved backups interrupted by a restart', { count: stuck.length });
  }
  return stuck.length;
}

export function listBackups(ctx: Context, serverId: string) {
  return ctx.db
    .select()
    .from(backups)
    .where(eq(backups.serverId, serverId))
    .orderBy(desc(backups.createdAt))
    .all();
}

export async function backupExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
