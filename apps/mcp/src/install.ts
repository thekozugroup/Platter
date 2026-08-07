import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import {
  type Context,
  EVENT,
  type Server,
  contentDirectory,
  createBackup,
  emitEvent,
  resolveWithin,
} from '@platter/core';
import { modInstalls } from '@platter/db';
import type { ModProject, ModVersion } from '@platter/mods';
import { type Result, fail, logger, ok, paths, ulid } from '@platter/shared';

const log = logger.child('mcp:install');

export interface InstallCandidate {
  project: ModProject;
  version: ModVersion;
}

export interface InstallOutcome {
  installed: { name: string; file: string; sizeBytes: number }[];
  skipped: { name: string; reason: string }[];
  requiresRestart: boolean;
}

/**
 * Download and install mod files.
 *
 * Three things this does that a naive implementation would not, each of which corresponds to a
 * real way people lose data or end up with a broken server:
 *
 *   1. **Backs up first.** A mod install is the most common cause of a server that will not
 *      boot, and the fix is almost always "put it back how it was". Taking the backup before
 *      touching anything makes that a one-click operation instead of an archaeology exercise.
 *
 *   2. **Verifies hashes.** Providers publish sha1 and sha512 for every file. A truncated
 *      download produces a jar that fails to load with a stack trace pointing at the mod rather
 *      than at the download, and people spend an evening on it.
 *
 *   3. **Writes through a content-addressed cache.** The same Fabric API jar is required by
 *      nearly every mod; caching by hash means installing it on a second server is a copy, not
 *      a download, and a re-install after a failed attempt is instant.
 */
export async function installMods(
  ctx: Context,
  server: Server,
  candidates: readonly InstallCandidate[],
  options: { proposalId?: string } = {}
): Promise<Result<InstallOutcome>> {
  const directory = contentDirectory(server.loader);
  if (!directory) {
    return fail(
      'not_supported',
      `${server.name} runs vanilla Minecraft, which has nowhere to put mods or plugins.`
    );
  }

  if (!ctx.env.PLATTER_DISABLE_AUTO_BACKUP) {
    const backup = await createBackup(ctx, {
      serverId: server.id,
      label: `Before installing ${candidates.map((c) => c.project.title).join(', ')}`.slice(0, 120),
      trigger: 'pre-change',
      actor: 'ai',
    });
    if (!backup.ok) {
      return fail(
        'internal',
        `Could not back up ${server.name} before installing: ${backup.error.message}. ` +
          'Nothing was installed.'
      );
    }
  }

  const targetDir = join(server.dataDir, directory);
  await mkdir(targetDir, { recursive: true });
  const cacheDir = paths.modCache(ctx.env.PLATTER_DATA_DIR);
  await mkdir(cacheDir, { recursive: true });

  const installed: InstallOutcome['installed'] = [];
  const skipped: InstallOutcome['skipped'] = [];

  for (const candidate of candidates) {
    const { project, version } = candidate;
    const file = version.file;

    if (!version.downloadable || !file?.url) {
      skipped.push({
        name: project.title,
        reason:
          version.downloadBlockedReason ??
          'The author has disabled third-party downloads, so Platter cannot fetch this file. ' +
            'Download it manually and drop it into the server\'s folder.',
      });
      continue;
    }

    const fileName = sanitiseFileName(file.name ?? `${project.slug ?? project.projectId}.jar`);
    // The mod file name comes from a third party, so it is resolved through the same containment
    // check as any other user-supplied path before it becomes somewhere to write.
    const destination = await resolveWithin(targetDir, fileName);
    if (!destination.ok) {
      skipped.push({ name: project.title, reason: `Unsafe file name "${file.name}".` });
      continue;
    }

    const download = await fetchToCache(cacheDir, file.url, {
      sha1: file.sha1 ?? undefined,
      sha512: file.sha512 ?? undefined,
      expectedSize: file.size ?? undefined,
    });
    if (!download.ok) {
      skipped.push({ name: project.title, reason: download.error.message });
      continue;
    }

    await copyFile(download.value.path, destination.value.absolute);
    const written = await stat(destination.value.absolute);

    ctx.db
      .insert(modInstalls)
      .values({
        id: ulid(),
        serverId: server.id,
        provider: project.provider,
        projectSlug: project.slug ?? project.projectId,
        displayName: project.title,
        versionLabel: version.versionNumber ?? null,
        kind: project.kind,
        filePath: `${directory}/${fileName}`,
        fileSize: written.size,
        sha1: file.sha1 ?? null,
        status: 'installed',
        installedBy: 'ai',
        proposalId: options.proposalId ?? null,
      })
      .onConflictDoUpdate({
        target: [modInstalls.serverId, modInstalls.provider, modInstalls.projectSlug],
        set: {
          displayName: project.title,
          versionLabel: version.versionNumber ?? null,
          filePath: `${directory}/${fileName}`,
          fileSize: written.size,
          sha1: file.sha1 ?? null,
          status: 'installed',
          removedAt: null,
          updatedAt: Date.now(),
        },
      })
      .run();

    installed.push({ name: project.title, file: fileName, sizeBytes: written.size });

    emitEvent(ctx.db, {
      serverId: server.id,
      type: EVENT.modInstalled,
      message: `Installed ${project.title} ${version.versionNumber ?? ''}`.trim(),
      actor: 'ai',
      data: { provider: project.provider, projectId: project.projectId, file: fileName },
    });
  }

  if (installed.length === 0 && skipped.length > 0) {
    return fail(
      'upstream_error',
      `Nothing could be installed. ${skipped.map((s) => `${s.name}: ${s.reason}`).join(' ')}`
    );
  }

  return ok({ installed, skipped, requiresRestart: true });
}

export interface RemoveOutcome {
  removed: string[];
  requiresRestart: boolean;
}

export async function removeMods(
  ctx: Context,
  server: Server,
  rows: readonly { id: string; displayName: string; filePath: string | null }[]
): Promise<Result<RemoveOutcome>> {
  if (!ctx.env.PLATTER_DISABLE_AUTO_BACKUP) {
    const backup = await createBackup(ctx, {
      serverId: server.id,
      label: `Before removing ${rows.map((r) => r.displayName).join(', ')}`.slice(0, 120),
      trigger: 'pre-change',
      actor: 'ai',
    });
    if (!backup.ok) {
      return fail('internal', `Could not back up before removing: ${backup.error.message}.`);
    }
  }

  const removed: string[] = [];
  for (const row of rows) {
    if (row.filePath) {
      const resolved = await resolveWithin(server.dataDir, row.filePath);
      if (resolved.ok) {
        await rm(resolved.value.absolute, { force: true });
      } else {
        log.warn('refusing to remove a file outside the data directory', {
          serverId: server.id,
          filePath: row.filePath,
        });
      }
    }
    ctx.db
      .update(modInstalls)
      .set({ status: 'removed', removedAt: Date.now(), updatedAt: Date.now() })
      .where(eq(modInstalls.id, row.id))
      .run();

    removed.push(row.displayName);
    emitEvent(ctx.db, {
      serverId: server.id,
      type: EVENT.modRemoved,
      message: `Removed ${row.displayName}`,
      actor: 'ai',
      data: { installId: row.id },
    });
  }

  return ok({ removed, requiresRestart: true });
}

/* -------------------------------------------------------------------------- */
/* Download                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Fetch a file into the content-addressed cache, verifying it.
 *
 * Keyed on the strongest hash the provider gave us. A cache hit skips the network entirely,
 * which is what makes installing Fabric API on a fifth server instant.
 */
async function fetchToCache(
  cacheDir: string,
  url: string,
  expected: { sha1?: string | undefined; sha512?: string | undefined; expectedSize?: number | undefined }
): Promise<Result<{ path: string; fromCache: boolean }>> {
  const key = expected.sha512 ?? expected.sha1;
  const cachePath = key ? join(cacheDir, `${key}.bin`) : undefined;

  if (cachePath) {
    const hit = await stat(cachePath).catch(() => null);
    if (hit?.isFile()) {
      return ok({ path: cachePath, fromCache: true });
    }
  }

  const temporary = join(cacheDir, `download-${ulid()}.part`);

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'thekozugroup/platter (+https://github.com/thekozugroup/Platter)' },
      signal: AbortSignal.timeout(300_000),
      redirect: 'follow',
    });

    if (!response.ok || !response.body) {
      return fail('upstream_error', `Download failed with HTTP ${response.status} for ${url}.`);
    }

    const sha1 = createHash('sha1');
    const sha512 = createHash('sha512');
    let bytes = 0;

    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    source.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      sha1.update(chunk);
      sha512.update(chunk);
    });

    await pipeline(source, createWriteStream(temporary));

    // Verification happens before the file is ever named something a server would load, so a
    // corrupt download can never end up in mods/.
    if (expected.expectedSize !== undefined && bytes !== expected.expectedSize) {
      await rm(temporary, { force: true });
      return fail(
        'upstream_error',
        `Download was ${bytes} bytes but the provider said ${expected.expectedSize}. Refusing to install it.`
      );
    }
    if (expected.sha512 && sha512.digest('hex') !== expected.sha512) {
      await rm(temporary, { force: true });
      return fail('upstream_error', 'Downloaded file failed its SHA-512 check. Refusing to install it.');
    }
    if (expected.sha1 && sha1.digest('hex') !== expected.sha1) {
      await rm(temporary, { force: true });
      return fail('upstream_error', 'Downloaded file failed its SHA-1 check. Refusing to install it.');
    }

    const finalPath = cachePath ?? join(cacheDir, `${ulid()}.bin`);
    await copyFile(temporary, finalPath);
    await rm(temporary, { force: true });
    return ok({ path: finalPath, fromCache: false });
  } catch (cause) {
    await rm(temporary, { force: true });
    return fail('upstream_error', `Could not download ${url}: ${String(cause)}`, { cause });
  }
}

/**
 * Reduce a provider-supplied file name to a safe basename.
 *
 * Mod file names come from a third party and land on disk, so directory components and control
 * characters are stripped before the name is used at all — the containment check that follows
 * is the second line of defence, not the first.
 */
function sanitiseFileName(name: string): string {
  const base = basename(name).replace(/[\u0000-\u001f\u007f/\\]/g, '').trim();
  const safe = base.length > 0 ? base : 'mod.jar';
  return safe.length > 180 ? safe.slice(-180) : safe;
}
