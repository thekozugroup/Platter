import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { create as tarCreate, extract as tarExtract } from 'tar';
import type { Backup as BackupRow } from '@prisma/client';
import {
  BACKUP_STATUSES,
  type Backup,
  type BackupStatus,
} from '@platter/shared';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { conflict, internal, invalidState, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { getLogHub } from '../orchestration/log-buffer.js';
import { recordAudit } from './audit.js';
import { serverDataDir } from '../lib/paths.js';
import { stopServer } from './lifecycle.js';

/**
 * Backups: a streamed `.tar.gz` of a server's data directory, hashed as it is written so
 * a restore can verify the archive before touching anything live.
 *
 * `createBackup` returns as soon as the row exists — the archive itself is built by
 * `runBackup` in the background, because a multi-gigabyte world can take minutes and an
 * HTTP request has no business blocking on it. The caller polls (or watches the audit
 * feed) for the status to move from `pending`/`running` to `completed`/`failed`.
 */

/** Automatic backups beyond this many (per server, oldest first) are rotated away. Manual
 * backups are exempt — an operator who asked for one by hand did not ask for it to expire. */
const MAX_AUTOMATIC_BACKUPS_PER_SERVER = 10;

/** Servers currently being backed up, in this process. The authoritative guard against
 * two backups of the same server running at once — the DB row exists before this is set,
 * but nothing else reads or writes the archive until this is held. */
const backupsInFlight = new Set<string>();

function backupArchivePath(serverId: string, backupId: string): string {
  return path.join(config.backupDir, serverId, `${backupId}.tar.gz`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

// ---------------------------------------------------------------------------
// A deliberately minimal glob, for the `ignore` list
// ---------------------------------------------------------------------------

function escapeRegExpChar(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function globToRegExp(pattern: string): RegExp {
  const chars = Array.from(pattern);
  let out = '';
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] ?? '';
    if (ch === '*' && chars[i + 1] === '*') {
      out += '.*';
      i += 1;
    } else if (ch === '*') {
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += escapeRegExpChar(ch);
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * `*`, `**` and `?` only, matched against the basename unless the pattern itself contains
 * a `/`. Enough for what operators actually type (`*.log`, `cache/**`) without pulling in
 * a globbing dependency for four characters.
 */
function compileIgnoreMatcher(patterns: readonly string[]): (entryPath: string) => boolean {
  const compiled = patterns
    .filter((pattern) => pattern.trim().length > 0)
    .map((pattern) => ({ regex: globToRegExp(pattern), basenameOnly: !pattern.includes('/') }));
  if (compiled.length === 0) return () => false;

  return (entryPath: string): boolean => {
    const normalised = entryPath.replace(/^\.\/+/, '');
    const basename = normalised.slice(normalised.lastIndexOf('/') + 1);
    return compiled.some(({ regex, basenameOnly }) => regex.test(basenameOnly ? basename : normalised));
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateBackupOptions {
  name?: string | null;
  ignore?: readonly string[];
  locked?: boolean;
  automatic?: boolean;
  actorId?: string | null;
}

function defaultBackupName(): string {
  return `Backup ${new Date().toISOString()}`;
}

export async function createBackup(serverId: string, options: CreateBackupOptions = {}): Promise<BackupRow> {
  // Checked and set with no `await` between them, which is what makes this atomic: two
  // concurrent calls both awaiting the lookups below would otherwise both see the guard
  // clear and both start a backup. Nothing here is a lock in any other sense — it lives in
  // this process only — but that is also all "one backup per server at a time" needs to be.
  if (backupsInFlight.has(serverId)) {
    throw conflict('A backup is already running for this server.');
  }
  backupsInFlight.add(serverId);

  try {
    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw notFound('server');

    try {
      await stat(serverDataDir(serverId));
    } catch {
      throw notFound('server data directory');
    }

    // A `pending`/`running` row with nobody in this process actually writing to it means a
    // previous process died mid-backup. Failing it here — rather than refusing every future
    // backup for this server forever — is what makes that self-healing.
    const stuck = await prisma.backup.findFirst({ where: { serverId, status: { in: ['pending', 'running'] } } });
    if (stuck) {
      await prisma.backup.update({
        where: { id: stuck.id },
        data: { status: 'failed', error: 'Interrupted by a restart.', completedAt: new Date() },
      });
    }

    const row = await prisma.backup.create({
      data: {
        id: newId('bak'),
        serverId,
        name: options.name?.trim() || defaultBackupName(),
        status: 'pending',
        automatic: options.automatic ?? false,
        locked: options.locked ?? false,
        createdById: options.actorId ?? null,
      },
    });

    await recordAudit({
      action: 'backup.created',
      targetType: 'backup',
      actorId: options.actorId ?? null,
      targetId: row.id,
      targetName: row.name,
      metadata: { serverId, automatic: row.automatic },
    });

    // Not awaited: the caller gets the `pending` row back now, and the archive is built
    // in the background. `backupsInFlight` is only cleared once that finishes.
    void runBackup(row, options.ignore ?? []).finally(() => backupsInFlight.delete(serverId));
    return row;
  } catch (error) {
    backupsInFlight.delete(serverId);
    throw error;
  }
}

async function runBackup(row: BackupRow, ignore: readonly string[]): Promise<void> {
  await prisma.backup.update({ where: { id: row.id }, data: { status: 'running' } }).catch(() => undefined);

  const dataDir = serverDataDir(row.serverId);
  const archivePath = backupArchivePath(row.serverId, row.id);
  await mkdir(path.dirname(archivePath), { recursive: true });
  const temp = `${archivePath}.part`;

  try {
    const { sizeBytes, checksum } = await writeArchive(dataDir, temp, ignore);
    await rename(temp, archivePath);
    await prisma.backup.update({
      where: { id: row.id },
      data: { status: 'completed', sizeBytes: BigInt(sizeBytes), checksum, completedAt: new Date() },
    });
    if (row.automatic) await enforceRetention(row.serverId);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    await prisma.backup
      .update({
        where: { id: row.id },
        data: { status: 'failed', error: messageOf(error), completedAt: new Date() },
      })
      .catch((updateError: unknown) => {
        process.stderr.write(`failed to record a failed backup: ${String(updateError)}\n`);
      });
  }
}

/** Never buffers the archive: the tar stream is hashed and written a chunk at a time, so a
 * multi-gigabyte world costs a bounded amount of memory, not one buffer the size of it. */
async function writeArchive(
  sourceDir: string,
  destPath: string,
  ignore: readonly string[],
): Promise<{ sizeBytes: number; checksum: string }> {
  const isIgnored = compileIgnoreMatcher(ignore);
  const pack = tarCreate(
    { gzip: true, cwd: sourceDir, portable: true, filter: (entryPath) => !isIgnored(entryPath) },
    ['.'],
  );

  const hash = createHash('sha256');
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  await pipeline(pack, counter, createWriteStream(destPath));
  return { sizeBytes: bytes, checksum: hash.digest('hex') };
}

async function enforceRetention(serverId: string): Promise<void> {
  const eligible = await prisma.backup.findMany({
    where: { serverId, automatic: true, locked: false, status: { in: ['completed', 'failed'] } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });
  const excess = eligible.length - MAX_AUTOMATIC_BACKUPS_PER_SERVER;
  if (excess <= 0) return;

  for (const old of eligible.slice(0, excess)) {
    await rm(backupArchivePath(serverId, old.id), { force: true }).catch(() => undefined);
    await prisma.backup.delete({ where: { id: old.id } }).catch((error: unknown) => {
      process.stderr.write(`failed to rotate an old backup: ${String(error)}\n`);
    });
    // Routine housekeeping, not a human decision — recorded as system-initiated, same as
    // a schedule firing.
    await recordAudit({
      action: 'backup.deleted',
      targetType: 'backup',
      actorId: null,
      targetId: old.id,
      targetName: old.name,
      metadata: { serverId, reason: 'retention' },
    });
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function listBackups(serverId: string): Promise<BackupRow[]> {
  return prisma.backup.findMany({ where: { serverId }, orderBy: { createdAt: 'desc' } });
}

export async function getBackup(id: string): Promise<BackupRow> {
  const row = await prisma.backup.findUnique({ where: { id } });
  if (!row) throw notFound('backup');
  return row;
}

export interface BackupDownload {
  absolutePath: string;
  filename: string;
  sizeBytes: number;
}

export async function getBackupDownload(serverId: string, id: string): Promise<BackupDownload> {
  const row = await getBackup(id);
  if (row.serverId !== serverId) throw notFound('backup');
  if (row.status !== 'completed') throw notFound('backup archive');

  const archivePath = backupArchivePath(row.serverId, row.id);
  const info = await stat(archivePath).catch(() => null);
  if (!info) throw notFound('backup archive');

  return {
    absolutePath: archivePath,
    filename: `${row.name.replace(/[^\w.-]+/g, '_')}.tar.gz`,
    sizeBytes: info.size,
  };
}

function toBackupStatus(value: string): BackupStatus {
  // A row this build does not recognise is reported as failed rather than mislabelled as
  // whichever status happens to be first in the union.
  return (BACKUP_STATUSES as readonly string[]).includes(value) ? (value as BackupStatus) : 'failed';
}

/** BigInt -> number at the wire boundary. Safe for anything short of an exabyte world. */
export function toBackupWire(row: BackupRow): Backup {
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    status: toBackupStatus(row.status),
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    checksum: row.checksum,
    automatic: row.automatic,
    locked: row.locked,
    error: row.error,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Lock / delete
// ---------------------------------------------------------------------------

export async function setBackupLocked(id: string, locked: boolean): Promise<BackupRow> {
  const row = await prisma.backup.findUnique({ where: { id } });
  if (!row) throw notFound('backup');
  return prisma.backup.update({ where: { id }, data: { locked } });
}

export async function deleteBackup(id: string, actorId: string | null = null): Promise<void> {
  const row = await prisma.backup.findUnique({ where: { id } });
  if (!row) throw notFound('backup');
  if (row.locked) throw conflict('This backup is locked. Unlock it before deleting.');
  if (row.status === 'pending' || row.status === 'running' || row.status === 'restoring') {
    throw invalidState('This backup is busy and cannot be deleted right now.');
  }

  await rm(backupArchivePath(row.serverId, row.id), { force: true });
  await prisma.backup.delete({ where: { id } });
  await recordAudit({
    action: 'backup.deleted',
    targetType: 'backup',
    actorId,
    targetId: id,
    targetName: row.name,
    metadata: { serverId: row.serverId },
  });
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export interface RestoreOptions {
  /** Wipe the existing data directory before extracting. Off by default: merge is the
   * safer surprise — nothing already on disk disappears unless the archive replaces it. */
  truncate?: boolean;
  actorId?: string | null;
}

export interface RestoreResult {
  /** True if the server was running and this call stopped it to perform the restore. */
  stoppedServer: boolean;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function emptyDirectory(dir: string): Promise<void> {
  const entries = await readdir(dir);
  await Promise.all(entries.map((entry) => rm(path.join(dir, entry), { recursive: true, force: true })));
}

const RESTORE_STOPS: readonly string[] = ['starting', 'running', 'restarting'];
const RESTORE_READY: readonly string[] = ['offline', 'crashed', 'install_failed'];

async function performRestore(row: BackupRow, options: RestoreOptions): Promise<RestoreResult> {
  if (row.checksum === null) {
    throw internal('That backup has no recorded checksum and cannot be safely restored.');
  }

  // Verified before a single byte of the live world is touched: a corrupted or tampered
  // archive is caught right here, never partway through overwriting something real.
  const actual = await hashFile(backupArchivePath(row.serverId, row.id));
  if (actual !== row.checksum) {
    throw conflict('That backup archive failed its checksum check and will not be restored.');
  }

  const server = await prisma.server.findUnique({ where: { id: row.serverId } });
  if (!server) throw notFound('server');

  if (server.suspended) {
    throw invalidState(`${server.name} is suspended, so this backup cannot be restored right now.`);
  }

  let stoppedServer = false;
  if (RESTORE_STOPS.includes(server.status)) {
    getLogHub(row.serverId).system(`Stopping ${server.name} to restore backup "${row.name}"…`);
    await stopServer(row.serverId, options.actorId ?? null);
    stoppedServer = true;
  } else if (!RESTORE_READY.includes(server.status)) {
    throw invalidState(`${server.name} is busy, so this backup cannot be restored right now.`);
  }

  const dataDir = serverDataDir(row.serverId);
  await mkdir(dataDir, { recursive: true });
  if (options.truncate) await emptyDirectory(dataDir);

  try {
    await pipeline(
      createReadStream(backupArchivePath(row.serverId, row.id)),
      tarExtract({ cwd: dataDir, strict: true }),
    );
  } catch (error) {
    throw internal('Could not extract that backup onto the server.', error);
  }

  getLogHub(row.serverId).system(
    `Restored from backup "${row.name}"${options.truncate ? ' (existing files were removed first)' : ''}.`,
  );

  return { stoppedServer };
}

export async function restoreBackup(backupId: string, options: RestoreOptions = {}): Promise<RestoreResult> {
  // Claims the row atomically: only a `completed` backup can move to `restoring`, so two
  // concurrent restores of the same backup — or a restore racing its own deletion — see
  // exactly one winner.
  const claimed = await prisma.backup.updateMany({
    where: { id: backupId, status: 'completed' },
    data: { status: 'restoring' },
  });
  if (claimed.count === 0) {
    const existing = await prisma.backup.findUnique({ where: { id: backupId } });
    if (!existing) throw notFound('backup');
    throw invalidState('That backup is not ready to be restored.');
  }

  const row = await prisma.backup.findUniqueOrThrow({ where: { id: backupId } });
  try {
    const result = await performRestore(row, options);
    await recordAudit({
      action: 'backup.restored',
      targetType: 'backup',
      actorId: options.actorId ?? null,
      targetId: row.id,
      targetName: row.name,
      metadata: { serverId: row.serverId, truncate: options.truncate ?? false, stoppedServer: result.stoppedServer },
    });
    return result;
  } finally {
    // `restoring` is a transient busy-state on the row, not a statement about the
    // archive: whether the restore succeeded or failed, the backup itself is still the
    // same valid archive it was before, so it always goes back to `completed`.
    await prisma.backup.update({ where: { id: backupId }, data: { status: 'completed' } }).catch(() => undefined);
  }
}
