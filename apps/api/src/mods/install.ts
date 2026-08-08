import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PlatterError } from '@platter/shared';
import { internal } from '../lib/errors.js';
import { serverDataDir } from '../lib/paths.js';
import { installedModSchema, type InstalledMod, type ModInstallTarget } from './resolve.js';
import type { ModFile, ModSource } from './registry.js';

/**
 * Downloading and recording a mod.
 *
 * A mod jar is arbitrary code the game server will execute with the container's full
 * privileges, so the download path is written as a supply-chain boundary rather than as a
 * file copy:
 *
 * - the URL must be HTTPS and must belong to the source's own CDN, so a compromised or
 *   spoofed API response cannot redirect the download at an attacker's host;
 * - the body is hashed while it streams and the digest is compared against the one the
 *   provider published **before** the file is moved into the server's directory — an
 *   unverified jar never exists at a path the game will scan;
 * - the transfer is capped, so a hostile Content-Length (or none at all) cannot fill the
 *   node's disk.
 *
 * The staging file lives in the destination directory so the final step is a rename on the
 * same filesystem, which is atomic: the game never sees a half-written jar.
 */

/** Generous for a single mod, far below anything that threatens a node's disk. */
export const MAX_MOD_FILE_BYTES = 256 * 1024 * 1024;

/**
 * Where each source is allowed to serve files from.
 *
 * This is the control that makes the rest meaningful. Without it the installer downloads
 * whatever host the API response names, and the API response is exactly the thing an attacker
 * with a foothold upstream — or on the network path — would forge.
 */
const ALLOWED_DOWNLOAD_HOSTS: Record<ModSource, readonly string[]> = {
  modrinth: ['cdn.modrinth.com'],
  curseforge: ['edge.forgecdn.net', 'mediafilez.forgecdn.net', 'media.forgecdn.net'],
};

/** Manifest lives beside the jars so a backup restore rolls both back together. */
const MANIFEST_DIR = '.platter';
const MANIFEST_FILE = 'mods.json';
const MANIFEST_VERSION = 1;

/** A server with more mods than this is not a case Platter's approval flow is for. */
export const MAX_TRACKED_MODS = 512;

const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_FILENAME_LENGTH = 200;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Returns the file name to write, or throws if it is not a plain jar name.
 *
 * The name comes from a third-party API and is used to build a path, so it is checked rather
 * than sanitised: quietly rewriting `../../etc/cron.d/x` into something safe would hide the
 * fact that a provider handed us a traversal. Surrounding whitespace is the one thing that is
 * trimmed, and the trimmed name is what callers must use — validating one string and writing
 * a different one is how these checks get bypassed.
 */
export function safeModFilename(filename: string): string {
  const trimmed = filename.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_FILENAME_LENGTH) {
    throw new PlatterError('bad_request', 'That mod file has an unusable name.');
  }
  if (trimmed !== path.basename(trimmed) || trimmed.startsWith('.')) {
    throw new PlatterError('bad_request', 'That mod file name is not a plain file name.');
  }
  // eslint-disable-next-line no-control-regex -- the point is to reject control characters
  if (/[\u0000-\u001f\u007f/\\]/.test(trimmed)) {
    throw new PlatterError(
      'bad_request',
      'That mod file name contains characters Platter will not write.',
    );
  }
  if (!trimmed.toLowerCase().endsWith('.jar')) {
    throw new PlatterError(
      'bad_request',
      'Platter only installs .jar files into mods and plugins.',
    );
  }
  return trimmed;
}

export function modDirectory(serverId: string, target: ModInstallTarget): string {
  return path.join(serverDataDir(serverId), target);
}

function manifestDirectory(serverId: string): string {
  return path.join(serverDataDir(serverId), MANIFEST_DIR);
}

function manifestPath(serverId: string): string {
  return path.join(manifestDirectory(serverId), MANIFEST_FILE);
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

function assertAllowedUrl(source: ModSource, rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PlatterError('service_unavailable', 'That mod has no usable download link.', {
      retryable: false,
    });
  }
  if (url.protocol !== 'https:') {
    throw new PlatterError('service_unavailable', 'Platter only downloads mods over HTTPS.', {
      retryable: false,
    });
  }
  if (!ALLOWED_DOWNLOAD_HOSTS[source].includes(url.hostname.toLowerCase())) {
    // Deliberately loud: this is a security event, not a transient failure.
    throw new PlatterError(
      'service_unavailable',
      `${source} pointed the download at ${url.hostname}, which is not one of its file hosts. Platter refused it.`,
      { retryable: false },
    );
  }
  return url;
}

function hexEquals(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export interface DownloadedMod {
  /** The validated name actually written, which may differ from the provider's by whitespace. */
  filename: string;
  absolutePath: string;
  /** Path relative to the server's data volume, e.g. `mods/sodium-0.6.0.jar`. */
  relativePath: string;
  sizeBytes: number;
  sha512: string;
  sha1: string;
}

export interface InstallFileRequest {
  serverId: string;
  target: ModInstallTarget;
  source: ModSource;
  file: ModFile;
  signal?: AbortSignal;
  /** Injected by tests; production uses global fetch. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Streams a mod file into place, verifying the published checksum before it lands.
 *
 * Returns the digests it computed so the caller can record them: a later integrity check, or
 * an update that needs to know whether the file on disk is still the one Platter installed,
 * has something to compare against.
 */
export async function installModFile(request: InstallFileRequest): Promise<DownloadedMod> {
  const { serverId, target, source, file } = request;
  const fetchImpl = request.fetch ?? ((input, init) => fetch(input, init));

  const filename = safeModFilename(file.filename);

  if (file.sha512 === null && file.sha1 === null) {
    // Nothing to verify against means nothing to trust. Refusing is the only honest option:
    // installing it would make every guarantee above decorative.
    throw new PlatterError(
      'service_unavailable',
      `${source} did not publish a checksum for ${filename}, so Platter cannot verify it.`,
      { retryable: false },
    );
  }
  if (file.sizeBytes > MAX_MOD_FILE_BYTES) {
    throw new PlatterError(
      'payload_too_large',
      `${filename} is larger than the ${Math.round(MAX_MOD_FILE_BYTES / 1024 / 1024)} MB Platter will download.`,
    );
  }

  const url = assertAllowedUrl(source, file.url);
  const directory = modDirectory(serverId, target);
  await mkdir(directory, { recursive: true });

  const finalPath = path.join(directory, filename);
  // Same directory, therefore same filesystem, therefore the rename below is atomic. The
  // leading dot keeps a partial download out of the game's own scan of the directory.
  const stagingPath = path.join(directory, `.${filename}.${process.pid}.${Date.now()}.part`);

  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), { method: 'GET', redirect: 'follow', signal });
  } catch (error) {
    if (request.signal?.aborted) throw error;
    throw new PlatterError('service_unavailable', `Could not download ${filename}.`, {
      retryable: true,
      cause: error,
    });
  }

  if (!response.ok || !response.body) {
    throw new PlatterError(
      'service_unavailable',
      `Downloading ${filename} failed (${response.status}).`,
      { retryable: response.status >= 500 },
    );
  }

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_MOD_FILE_BYTES) {
    throw new PlatterError('payload_too_large', `${filename} is too large to install.`);
  }

  const sha512 = createHash('sha512');
  const sha1 = createHash('sha1');
  let bytes = 0;

  const reader = response.body.getReader();
  const handle = await open(stagingPath, 'wx');
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      bytes += value.byteLength;
      if (bytes > MAX_MOD_FILE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new PlatterError(
          'payload_too_large',
          `${filename} exceeded the ${Math.round(MAX_MOD_FILE_BYTES / 1024 / 1024)} MB download limit.`,
        );
      }
      sha512.update(value);
      sha1.update(value);
      // Awaited per chunk, which is what applies backpressure: without it a fast CDN buffers
      // the whole file in memory while the disk catches up.
      await handle.write(value);
    }

    const digest512 = sha512.digest('hex');
    const digest1 = sha1.digest('hex');

    // The gate. Everything above this line is a temporary file; nothing below runs unless the
    // bytes we received are the bytes the provider published.
    const expected = file.sha512 ?? file.sha1;
    const actual = file.sha512 === null ? digest1 : digest512;
    const algorithm = file.sha512 === null ? 'SHA-1' : 'SHA-512';
    if (expected === null || !hexEquals(expected, actual)) {
      throw new PlatterError(
        'conflict',
        `${filename} did not match the ${algorithm} checksum ${source} published. It was not installed.`,
      );
    }

    await handle.close();
    await rename(stagingPath, finalPath);
    return {
      filename,
      absolutePath: finalPath,
      relativePath: `${target}/${filename}`,
      sizeBytes: bytes,
      sha512: digest512,
      sha1: digest1,
    };
  } catch (error) {
    // `close` is idempotent enough for this: a second close throws, which must not mask the
    // real error, and the staging file is removed either way.
    await handle.close().catch(() => undefined);
    await rm(stagingPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Removes an installed jar. A file that is already gone is a success, not a 404. */
export async function removeModFile(
  serverId: string,
  target: ModInstallTarget,
  filename: string,
): Promise<void> {
  await rm(path.join(modDirectory(serverId, target), safeModFilename(filename)), { force: true });
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * Serialised per server so two approvals landing at once cannot read-modify-write over each
 * other. In-process only, which is all Platter needs — the API is a single process, and the
 * manifest is only ever written from here.
 */
const manifestLocks = new Map<string, Promise<unknown>>();

function withManifestLock<T>(serverId: string, work: () => Promise<T>): Promise<T> {
  const previous = manifestLocks.get(serverId) ?? Promise.resolve();
  // `then(work, work)` rather than `then(work)`: a failed predecessor must release the queue,
  // not poison every write that comes after it.
  const result = previous.then(work, work);
  const tail = result.catch(() => undefined);
  manifestLocks.set(serverId, tail);
  // Dropped once this is the last entry in the chain, so the map cannot grow with every
  // server the process ever touches.
  void tail.then(() => {
    if (manifestLocks.get(serverId) === tail) manifestLocks.delete(serverId);
  });
  return result;
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Reads the manifest.
 *
 * Entries are validated one at a time and bad ones are dropped rather than failing the read.
 * The file sits inside the server's data volume, which the operator can edit through the file
 * manager and a restore can replace wholesale — a hand-mangled row must cost one forgotten
 * mod, not the entire mods page.
 */
export async function readModManifest(serverId: string): Promise<InstalledMod[]> {
  let raw: string;
  try {
    raw = await readFile(manifestPath(serverId), 'utf8');
  } catch (error) {
    if (isEnoent(error)) return [];
    throw internal('Could not read the mod manifest for this server.', error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const entries =
    typeof parsed === 'object' &&
    parsed !== null &&
    Array.isArray((parsed as { mods?: unknown }).mods)
      ? (parsed as { mods: unknown[] }).mods
      : [];

  const mods: InstalledMod[] = [];
  for (const entry of entries) {
    const result = installedModSchema.safeParse(entry);
    if (result.success) mods.push(result.data);
    if (mods.length >= MAX_TRACKED_MODS) break;
  }
  return mods;
}

async function writeModManifest(serverId: string, mods: readonly InstalledMod[]): Promise<void> {
  await mkdir(manifestDirectory(serverId), { recursive: true });
  const target = manifestPath(serverId);
  const staging = `${target}.${process.pid}.tmp`;
  const body = JSON.stringify(
    { version: MANIFEST_VERSION, mods: mods.slice(0, MAX_TRACKED_MODS) },
    null,
    2,
  );

  await writeFile(staging, body, 'utf8');
  try {
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined);
    throw internal('Could not write the mod manifest for this server.', error);
  }
}

/**
 * Records an install, replacing any earlier record for the same project.
 *
 * Keyed by project rather than by file so an update leaves exactly one row: two rows for one
 * mod would make "is there an update?" ambiguous, and ambiguity there is how a server ends up
 * with two versions of the same jar in `mods/` and refuses to boot.
 */
export function recordInstalledMod(
  serverId: string,
  record: InstalledMod,
): Promise<InstalledMod[]> {
  return withManifestLock(serverId, async () => {
    const existing = await readModManifest(serverId);
    const next = existing.filter(
      (mod) => !(mod.source === record.source && mod.projectId === record.projectId),
    );
    if (next.length >= MAX_TRACKED_MODS) {
      throw new PlatterError(
        'conflict',
        `This server already tracks ${MAX_TRACKED_MODS} mods, which is Platter's limit.`,
      );
    }
    next.push(record);
    await writeModManifest(serverId, next);
    return next;
  });
}

/** Drops a record and returns it, or null when nothing was tracked for that project. */
export function forgetInstalledMod(
  serverId: string,
  source: ModSource,
  projectId: string,
): Promise<InstalledMod | null> {
  return withManifestLock(serverId, async () => {
    const existing = await readModManifest(serverId);
    const removed =
      existing.find((mod) => mod.source === source && mod.projectId === projectId) ?? null;
    if (!removed) return null;
    await writeModManifest(
      serverId,
      existing.filter((mod) => mod !== removed),
    );
    return removed;
  });
}
