import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  realpath as fsRealpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { create as tarCreate, extract as tarExtract } from 'tar';
import type { z } from 'zod';
import {
  LIMITS,
  PlatterError,
  type readFileResponseSchema,
  type FileEntry,
  type ListFilesResponse,
} from '@platter/shared';
import { serverDataDir } from '../lib/paths.js';
import { alreadyExists, badRequest, conflict, internal, notFound } from '../lib/errors.js';

// Not exported by `packages/shared` alongside its schema (unlike `ListFilesResponse`) — the
// response shape is still the schema's, just inferred locally rather than left `unknown`.
type ReadFileResponse = z.infer<typeof readFileResponseSchema>;

/**
 * The server's file manager.
 *
 * Every path here starts as a client-supplied string. `serverPathSchema` (packages/shared)
 * already rejects a literal `..` segment and embedded NUL bytes, but that is a lexical
 * check on the string a client typed — it says nothing about what is actually on disk. A
 * symlink planted inside the volume (an uploaded mod, a careless plugin, or the game itself
 * writing one) can point anywhere, and every fs call below would happily follow it out of
 * the sandbox. So every operation resolves through `resolveServerPath`, which canonicalises
 * the path with `fs.realpath` and re-checks containment *after* symlinks are resolved, not
 * just on the string before. That check — not the schema — is the actual boundary.
 */

// ---------------------------------------------------------------------------
// Safe path resolution
// ---------------------------------------------------------------------------

interface ResolvedServerPath {
  /** Absolute, symlink-resolved path. Every fs call below uses this, never the raw input. */
  absolute: string;
  /** Normalised, `/`-separated path relative to the server root. `''` is the root itself. */
  relative: string;
  /** Whether `absolute` exists right now. A concurrent writer can still invalidate this. */
  exists: boolean;
  /** Path segments beyond the deepest existing ancestor. Empty when `exists` is true. */
  missing: string[];
  isRoot: boolean;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * Walks up from `target` until it finds something that exists, then canonicalises that
 * ancestor. The segments below it are returned untouched: they do not exist, so there is
 * nothing for them to dereference, and treating them literally is what lets `mkdir` and
 * `writeFile` target a path that is not there yet.
 */
async function realpathDeepestExisting(
  target: string,
): Promise<{ real: string; missing: string[] }> {
  let current = target;
  const missing: string[] = [];
  for (;;) {
    try {
      const real = await fsRealpath(current);
      return { real, missing };
    } catch (error) {
      if (!isEnoent(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the filesystem root without resolving anything real. Only possible if
        // the server root itself is unreadable, which `resolveServerPath` checks first.
        throw internal('Could not resolve a path against the server data directory.');
      }
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function resolveServerPath(serverId: string, relPath: string): Promise<ResolvedServerPath> {
  const root = serverDataDir(serverId);
  let realRoot: string;
  try {
    realRoot = await fsRealpath(root);
  } catch (error) {
    if (isEnoent(error)) throw notFound('server data directory');
    throw internal('Could not resolve the server data directory.', error);
  }

  // `serverPathSchema` does not forbid a leading slash, and `path.resolve(root, '/etc/passwd')`
  // would discard `root` entirely and hand back `/etc/passwd` verbatim — rejected outright
  // rather than reinterpreted as "relative to the root", so an absolute-looking path gets
  // a clear refusal instead of a confusing 404 for a file that only looks like it exists.
  if (relPath.startsWith('/')) {
    throw badRequest('That path is outside the server directory.');
  }
  const lexical = path.resolve(path.join(root, relPath));

  const { real, missing } = await realpathDeepestExisting(lexical);
  const candidate = missing.length === 0 ? real : path.join(real, ...missing);

  // The check that actually matters: a symlink anywhere on the path — including the final
  // component itself — that resolves outside the server directory is treated exactly like
  // `../../etc/passwd` typed by hand, because on disk that is precisely what it is.
  if (candidate !== realRoot && !candidate.startsWith(realRoot + path.sep)) {
    throw badRequest('That path is outside the server directory.');
  }

  return {
    absolute: candidate,
    relative: path.relative(realRoot, candidate).split(path.sep).join('/'),
    exists: missing.length === 0,
    missing,
    isRoot: candidate === realRoot,
  };
}

/**
 * The final component *without* dereferencing it, when that component is a symlink.
 *
 * `resolveServerPath` deliberately canonicalises everything, which is right for reading and
 * writing — the bytes really do live at the target. It is wrong for deleting and renaming: a
 * link is its own object, and `rm` on the realpath destroys whatever it points at. A user
 * who deletes what the file list showed as a shortcut would lose the world folder behind it.
 *
 * The parent chain is still resolved and containment-checked, so this narrows what is
 * dereferenced to exactly one component and gives up no part of the sandbox. Returns null
 * when the entry is not a link, and the caller falls back to the ordinary resolved path.
 */
async function resolveLinkItself(
  serverId: string,
  relPath: string,
): Promise<{ absolute: string; relative: string } | null> {
  if (relPath.startsWith('/')) return null;
  const root = serverDataDir(serverId);
  try {
    const realRoot = await fsRealpath(root);
    const lexical = path.resolve(path.join(realRoot, relPath));
    if (lexical === realRoot) return null;

    const realParent = await fsRealpath(path.dirname(lexical));
    if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) return null;

    const absolute = path.join(realParent, path.basename(lexical));
    const st = await lstat(absolute);
    if (!st.isSymbolicLink()) return null;
    return { absolute, relative: path.relative(realRoot, absolute).split(path.sep).join('/') };
  } catch {
    // Nothing there, or a parent that does not resolve. Both are the ordinary path's problem.
    return null;
  }
}

/** Maps common fs failures onto the error the client actually needs to hear. */
function translateFsError(error: unknown, fallback: string): PlatterError {
  if (error instanceof PlatterError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return notFound('file or folder');
  if (code === 'ENOTDIR') return badRequest('A parent of that path is a file, not a folder.');
  if (code === 'EEXIST') return alreadyExists('file or folder');
  if (code === 'ENOTEMPTY') return conflict('That folder is not empty.');
  if (code === 'EISDIR') return badRequest('That path is a folder, not a file.');
  if (code === 'ENOSPC')
    return new PlatterError('internal_error', 'The node is out of disk space.');
  return internal(fallback, error);
}

// ---------------------------------------------------------------------------
// Entry metadata: mime sniffing, binary detection, the editable decision
// ---------------------------------------------------------------------------

const TEXT_EXTENSIONS: Record<string, string> = {
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.yml': 'application/yaml',
  '.yaml': 'application/yaml',
  '.toml': 'application/toml',
  '.ini': 'text/plain',
  '.properties': 'text/plain',
  '.cfg': 'text/plain',
  '.conf': 'text/plain',
  '.env': 'text/plain',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.sh': 'text/x-shellscript',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.html': 'text/html',
  '.css': 'text/css',
  '.sql': 'application/sql',
  '.py': 'text/x-python',
};

const BINARY_EXTENSIONS: Record<string, string> = {
  '.jar': 'application/java-archive',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.zst': 'application/zstd',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.db': 'application/x-sqlite3',
  '.class': 'application/java-vm',
  // Minecraft region/schematic/NBT formats. Editing these byte-for-byte is not a text
  // editor's job — they are surfaced as downloadable, not editable.
  '.mca': 'application/octet-stream',
  '.mcr': 'application/octet-stream',
  '.dat': 'application/octet-stream',
  '.nbt': 'application/octet-stream',
  '.schem': 'application/octet-stream',
};

const MAX_SNIFF_BYTES = 512;

/** Reads a small prefix rather than the whole file — a listing must stay cheap. */
async function sniffIsBinary(absolutePath: string): Promise<boolean> {
  const handle = await open(absolutePath, 'r');
  try {
    const buffer = Buffer.alloc(MAX_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_SNIFF_BYTES, 0);
    if (bytesRead === 0) return false;
    const slice = buffer.subarray(0, bytesRead);
    if (slice.includes(0)) return true; // a NUL byte is the classic tell
    let control = 0;
    for (const byte of slice) {
      // Tab/LF/CR (9, 10, 13) are ordinary text; everything else below 0x20 is not.
      if (byte < 7 || (byte > 13 && byte < 32)) control += 1;
    }
    return control / slice.length > 0.3;
  } finally {
    await handle.close();
  }
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index).toLowerCase();
}

function mimeTypeOf(name: string, type: FileEntry['type']): string | null {
  if (type !== 'file') return null;
  const ext = extensionOf(name);
  return TEXT_EXTENSIONS[ext] ?? BINARY_EXTENSIONS[ext] ?? null;
}

async function toFileEntry(absolutePath: string, relativePath: string): Promise<FileEntry> {
  const st = await lstat(absolutePath);
  const name = path.basename(absolutePath);
  const type: FileEntry['type'] = st.isSymbolicLink()
    ? 'symlink'
    : st.isDirectory()
      ? 'directory'
      : 'file';

  const ext = extensionOf(name);
  const knownBinary = Object.hasOwn(BINARY_EXTENSIONS, ext);

  // Sniffing is skipped whenever the answer is already known cheaply: a directory or
  // symlink is never editable, an oversized file is never editable, and a file whose
  // extension already says "binary" does not need its bytes read to confirm that. Every
  // other file — including a `.txt` that turns out to be garbage — gets a real look.
  const editable =
    type === 'file' &&
    st.size <= LIMITS.maxFileEditBytes &&
    !knownBinary &&
    !(await sniffIsBinary(absolutePath));

  return {
    name,
    path: relativePath,
    type,
    sizeBytes: st.size,
    mode: (st.mode & 0o7777).toString(8).padStart(4, '0'),
    modifiedAt: st.mtime.toISOString(),
    mimeType: mimeTypeOf(name, type),
    editable,
  };
}

function buildEntry(resolved: ResolvedServerPath): Promise<FileEntry> {
  return toFileEntry(resolved.absolute, resolved.relative);
}

function posixJoin(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

function parentOf(relative: string): string | null {
  if (relative === '') return null;
  const index = relative.lastIndexOf('/');
  return index < 0 ? '' : relative.slice(0, index);
}

function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.type === 'directory' && b.type !== 'directory') return -1;
  if (a.type !== 'directory' && b.type === 'directory') return 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

// ---------------------------------------------------------------------------
// Listing and reading
// ---------------------------------------------------------------------------

export async function listServerFiles(
  serverId: string,
  relPath: string,
): Promise<ListFilesResponse> {
  const resolved = await resolveServerPath(serverId, relPath);
  if (!resolved.exists) throw notFound('folder');
  const stat = await lstat(resolved.absolute);
  if (!stat.isDirectory()) throw badRequest('That path is not a folder.');

  const names = await readdir(resolved.absolute);
  const entries = await Promise.all(
    names.map((name) =>
      toFileEntry(path.join(resolved.absolute, name), posixJoin(resolved.relative, name)),
    ),
  );
  entries.sort(compareEntries);

  return { path: resolved.relative, parent: parentOf(resolved.relative), entries };
}

/** Read is capped independently of the write cap: a log a human wants to *view* is
 * routinely bigger than one Platter will let them save back through the editor. */
const MAX_READ_BYTES = 8 * 1024 * 1024;

export async function readServerFile(serverId: string, relPath: string): Promise<ReadFileResponse> {
  const resolved = await resolveServerPath(serverId, relPath);
  if (!resolved.exists) throw notFound('file');
  const stat = await lstat(resolved.absolute);
  if (!stat.isFile()) throw badRequest('That is not a regular file.');

  const handle = await open(resolved.absolute, 'r');
  try {
    const toRead = Math.min(stat.size, MAX_READ_BYTES);
    const buffer = Buffer.alloc(toRead);
    if (toRead > 0) await handle.read(buffer, 0, toRead, 0);
    return {
      path: resolved.relative,
      content: buffer.toString('utf8'),
      sizeBytes: stat.size,
      truncated: stat.size > MAX_READ_BYTES,
      mimeType: mimeTypeOf(path.basename(resolved.absolute), 'file'),
    };
  } finally {
    await handle.close();
  }
}

/** For the download route: raw handle on the file plus enough metadata for the headers. */
export interface DownloadableFile {
  absolutePath: string;
  name: string;
  sizeBytes: number;
  mimeType: string | null;
}

export async function getServerFileForDownload(
  serverId: string,
  relPath: string,
): Promise<DownloadableFile> {
  const resolved = await resolveServerPath(serverId, relPath);
  if (!resolved.exists) throw notFound('file');
  const stat = await lstat(resolved.absolute);
  if (!stat.isFile()) throw badRequest('That is not a regular file.');
  const name = path.basename(resolved.absolute);
  return {
    absolutePath: resolved.absolute,
    name,
    sizeBytes: stat.size,
    mimeType: mimeTypeOf(name, 'file'),
  };
}

// ---------------------------------------------------------------------------
// Writing — atomic so a crash mid-save never truncates a config file
// ---------------------------------------------------------------------------

async function atomicWrite(
  targetAbsolute: string,
  write: (tempPath: string) => Promise<void>,
): Promise<void> {
  const dir = path.dirname(targetAbsolute);
  const temp = path.join(dir, `.platter-tmp-${randomUUID()}`);
  try {
    await write(temp);
    // Same directory, so this is a single filesystem rename: the old content or the new
    // content is what's on disk at every instant, never a half-written file.
    await rename(temp, targetAbsolute);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw translateFsError(error, 'Could not save that file.');
  }
}

async function assertWritableFileTarget(resolved: ResolvedServerPath): Promise<void> {
  if (resolved.isRoot) throw badRequest('The server root cannot be written to as a file.');
  if (resolved.exists) {
    const stat = await lstat(resolved.absolute);
    if (!stat.isFile()) throw conflict('That path is a folder, not a file.');
  } else if (resolved.missing.length > 1) {
    throw notFound('folder');
  }
}

export async function writeServerFile(
  serverId: string,
  relPath: string,
  content: string,
): Promise<FileEntry> {
  const resolved = await resolveServerPath(serverId, relPath);
  await assertWritableFileTarget(resolved);
  await atomicWrite(resolved.absolute, (temp) => writeFile(temp, content, 'utf8'));
  return buildEntry(resolved);
}

/**
 * The multipart upload path. `stream.truncated` is set by `@fastify/busboy` once the part
 * exceeds the configured `fileSize` limit — checked after the pipe finishes, per its own
 * docs, since it is only reliable once the stream has ended.
 */
export async function writeServerFileStream(
  serverId: string,
  relPath: string,
  stream: Readable & { truncated?: boolean },
): Promise<FileEntry> {
  const resolved = await resolveServerPath(serverId, relPath);
  await assertWritableFileTarget(resolved);

  await atomicWrite(resolved.absolute, async (temp) => {
    await pipeline(stream, createWriteStream(temp));
    if (stream.truncated) {
      throw new PlatterError('payload_too_large', 'That file is larger than the upload limit.');
    }
  });
  return buildEntry(resolved);
}

// ---------------------------------------------------------------------------
// Directories, rename, copy, delete
// ---------------------------------------------------------------------------

export async function createServerDirectory(serverId: string, relPath: string): Promise<FileEntry> {
  const resolved = await resolveServerPath(serverId, relPath);
  // The root always exists, so this also catches an attempt to "create" it.
  if (resolved.exists) throw alreadyExists('file or folder');
  if (resolved.missing.length > 1) throw notFound('parent folder');

  try {
    await mkdir(resolved.absolute);
  } catch (error) {
    throw translateFsError(error, 'Could not create that folder.');
  }
  return buildEntry(resolved);
}

export async function renameServerPath(
  serverId: string,
  from: string,
  to: string,
): Promise<FileEntry> {
  // Same rule as delete: renaming a shortcut moves the shortcut, not what it points at.
  const link = await resolveLinkItself(serverId, from);
  const source = link ?? (await resolveSourceForRename(serverId, from));

  const dst = await resolveServerPath(serverId, to);
  if (dst.isRoot) throw badRequest('Cannot rename onto the server root.');
  if (dst.exists) throw alreadyExists('file or folder');
  if (dst.missing.length > 1) throw notFound('destination folder');

  try {
    await rename(source.absolute, dst.absolute);
  } catch (error) {
    throw translateFsError(error, 'Could not rename that.');
  }
  return buildEntry(dst);
}

async function resolveSourceForRename(
  serverId: string,
  from: string,
): Promise<{ absolute: string; relative: string }> {
  const src = await resolveServerPath(serverId, from);
  if (src.isRoot) throw badRequest('The server root cannot be renamed.');
  if (!src.exists) throw notFound('file or folder');
  return src;
}

export async function copyServerPath(
  serverId: string,
  from: string,
  to: string,
): Promise<FileEntry> {
  const src = await resolveServerPath(serverId, from);
  if (!src.exists) throw notFound('file or folder');

  const dst = await resolveServerPath(serverId, to);
  if (dst.isRoot) throw badRequest('Cannot copy onto the server root.');
  if (dst.exists) throw alreadyExists('file or folder');
  if (dst.missing.length > 1) throw notFound('destination folder');

  try {
    // `dereference: false` (the default) copies a symlink as a symlink rather than
    // resolving it. If that symlink escapes the sandbox, the escape is caught the next
    // time anything here tries to *access* it — exactly as it would be for one uploaded
    // directly — so copying does not need to special-case it.
    await cp(src.absolute, dst.absolute, { recursive: true, errorOnExist: true });
  } catch (error) {
    throw translateFsError(error, 'Could not copy that.');
  }
  return buildEntry(dst);
}

export async function deleteServerPaths(
  serverId: string,
  relPaths: readonly string[],
): Promise<{ deleted: string[] }> {
  const deleted: string[] = [];
  for (const relPath of relPaths) {
    // A link is unlinked, never followed — see `resolveLinkItself`. This also makes a link
    // pointing outside the sandbox removable, which resolving it never could.
    const link = await resolveLinkItself(serverId, relPath);
    if (link) {
      try {
        await rm(link.absolute, { force: true });
      } catch (error) {
        throw translateFsError(error, `Could not delete ${link.relative}.`);
      }
      deleted.push(link.relative);
      continue;
    }

    const resolved = await resolveServerPath(serverId, relPath);
    if (resolved.isRoot) throw badRequest('The server root cannot be deleted.');
    if (!resolved.exists) continue; // already gone: deleting is idempotent, not an error
    try {
      await rm(resolved.absolute, { recursive: true });
    } catch (error) {
      throw translateFsError(error, `Could not delete ${resolved.relative}.`);
    }
    deleted.push(resolved.relative);
  }
  return { deleted };
}

// ---------------------------------------------------------------------------
// Compress / extract
// ---------------------------------------------------------------------------

function defaultArchiveName(firstRelative: string): string {
  const dir = parentOf(firstRelative) ?? '';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return posixJoin(dir, `archive-${stamp}.tar.gz`);
}

export async function compressServerPaths(
  serverId: string,
  relPaths: readonly string[],
  destination?: string,
): Promise<FileEntry> {
  const root = serverDataDir(serverId);
  const sources = await Promise.all(
    relPaths.map((relPath) => resolveServerPath(serverId, relPath)),
  );
  for (const source of sources) {
    if (!source.exists) throw notFound('file or folder');
  }

  const firstRelative = sources[0]?.relative ?? '';
  const dst = await resolveServerPath(serverId, destination ?? defaultArchiveName(firstRelative));
  if (dst.isRoot) throw badRequest('Cannot write the archive onto the server root.');
  if (dst.exists) throw alreadyExists('file or folder');
  if (dst.missing.length > 1) throw notFound('destination folder');

  const temp = `${dst.absolute}.part`;
  try {
    const entries = sources.map((source) => source.relative);
    const pack = tarCreate({ gzip: true, cwd: root, portable: true }, entries);
    await pipeline(pack, createWriteStream(temp));
    await rename(temp, dst.absolute);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw translateFsError(error, 'Could not create that archive.');
  }
  return buildEntry(dst);
}

export interface ExtractOptions {
  /**
   * Ceiling on the *uncompressed* bytes an archive may unpack to. The caller passes the
   * server's own disk allowance, so an extraction can never outgrow the thing it belongs to.
   */
  maxTotalBytes?: number;
}

/**
 * Absolute fallback when a caller does not name a budget, so no code path is uncapped.
 * Matches the upload ceiling: an archive that arrived through the file manager cannot have
 * been larger than this to begin with.
 */
const DEFAULT_EXTRACT_LIMIT_BYTES = LIMITS.maxUploadBytes;

/** Thrown from the entry filter to tear the read stream down mid-archive. */
class ArchiveTooLarge extends Error {}

function tooLargeError(maxTotalBytes: number): PlatterError {
  return new PlatterError(
    'payload_too_large',
    `That archive unpacks to more than ${Math.round(maxTotalBytes / 1024 / 1024)} MB, which is more than this server is allowed to use. Nothing was extracted.`,
  );
}

export async function extractServerArchive(
  serverId: string,
  relPath: string,
  destinationRelPath: string,
  options: ExtractOptions = {},
): Promise<FileEntry> {
  const maxTotalBytes = Math.max(1, options.maxTotalBytes ?? DEFAULT_EXTRACT_LIMIT_BYTES);
  const archive = await resolveServerPath(serverId, relPath);
  if (!archive.exists) throw notFound('archive');
  const archiveStat = await lstat(archive.absolute);
  if (!archiveStat.isFile()) throw badRequest('That is not an archive file.');

  const dest = await resolveServerPath(serverId, destinationRelPath);
  if (!dest.exists) {
    if (dest.missing.length > 1) throw notFound('destination folder');
    try {
      await mkdir(dest.absolute);
    } catch (error) {
      throw translateFsError(error, 'Could not create the extraction folder.');
    }
  } else {
    const destStat = await lstat(dest.absolute);
    if (!destStat.isDirectory()) throw conflict('The destination is not a folder.');
  }

  // Staged inside the server root, never straight into the destination.
  //
  // `strict: true` turns every warning the parser would otherwise swallow into a thrown
  // error — including the ones tar raises for an entry that contains `..`, is absolute, or
  // would resolve through a symlink out of `cwd`. That is the zip-slip defence, and it
  // holds. But tar streams, so it raises that error partway through: by the time a hostile
  // member is rejected, every member before it is already on disk. Extracting somewhere
  // disposable and only merging on success is what makes the refusal mean "nothing was
  // written" rather than "we stopped halfway".
  const staging = path.join(serverDataDir(serverId), `.platter-extract-${randomUUID()}`);
  try {
    await mkdir(staging, { recursive: true });

    // The size cap.
    //
    // node-tar aborts a gzip member past a 1000:1 ratio, which bounds *amplification* but
    // not the absolute figure: a 100 MB upload sitting just under that ratio still unpacks
    // to ~100 GB and fills the node's disk for every server co-located on it. The budget is
    // checked against each member's declared size *before* the member is written — a tar
    // reader cannot read more bytes for an entry than its header claims — so the run total
    // is exact and nothing over budget ever reaches the disk. Destroying the source is what
    // stops us decompressing the rest of a bomb we have already refused.
    const source = createReadStream(archive.absolute);
    let extracted = 0;
    let tooLarge = false;
    const withinBudget = (_entryPath: string, entry: { size?: number }): boolean => {
      if (tooLarge) return false;
      extracted += entry.size ?? 0;
      if (extracted <= maxTotalBytes) return true;
      tooLarge = true;
      source.destroy(new ArchiveTooLarge());
      return false;
    };

    try {
      await pipeline(source, tarExtract({ cwd: staging, strict: true, filter: withinBudget }));
    } catch (error) {
      if (tooLarge || error instanceof ArchiveTooLarge) throw tooLargeError(maxTotalBytes);
      throw badRequest(
        'That archive could not be extracted. It may be corrupt, or contain paths that escape the destination.',
      );
    }
    // An overflow on the very last member leaves the pipeline resolving normally: the
    // stream ended before the destroy landed. The flag is what decides, not the throw.
    if (tooLarge) throw tooLargeError(maxTotalBytes);

    // `force` so an archive may overwrite files that are already there, which is what
    // extracting over an existing folder has always meant here.
    for (const name of await readdir(staging)) {
      await cp(path.join(staging, name), path.join(dest.absolute, name), {
        recursive: true,
        force: true,
      });
    }
  } catch (error) {
    throw translateFsError(error, 'Could not extract that archive.');
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
  return buildEntry(dest);
}
