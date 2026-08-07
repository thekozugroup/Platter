import { realpath } from 'node:fs/promises';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { fail, ok, type Result } from '@platter/shared';

/**
 * Path containment.
 *
 * Path traversal is the recurring vulnerability class in every game-server panel: it has shown
 * up in file managers, in backup restore, and in any parameter that eventually becomes a path.
 * Pterodactyl's CVE-2025-49132 was an unauthenticated 10.0 because two GET parameters reached a
 * file read unchecked.
 *
 * The defence has two halves, and skipping either one is what makes these bugs recur:
 *
 *   1. Normalise and check *before* touching the filesystem, so an obviously-hostile path never
 *      reaches an `open()` at all.
 *   2. Resolve symlinks and check *again*, because `mods/evil` can be a symlink to `/etc` and
 *      step 1 cannot see that. A server owner can create symlinks inside their own data
 *      directory — via a mod, via the file manager, via an uploaded archive — so this is a
 *      realistic path, not a theoretical one.
 *
 * Everything in Platter that turns user input into a path goes through `resolveWithin`.
 */

export interface ResolvedPath {
  /** Absolute path on the host, symlinks resolved where the target exists. */
  absolute: string;
  /** Path relative to the root, always using forward slashes. */
  relative: string;
}

/** Reject the obvious cases before any filesystem call. */
function isSyntacticallySafe(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Resolve `userPath` inside `root`, refusing anything that escapes.
 *
 * `userPath` is treated as relative to `root` even when it starts with `/` — a leading slash in
 * a file-manager request means "the root of my server's data", not the host's root.
 */
export async function resolveWithin(
  root: string,
  userPath: string,
  options: { mustExist?: boolean } = {}
): Promise<Result<ResolvedPath>> {
  if (userPath.includes('\0')) {
    return fail('invalid_input', 'Path contains a null byte.');
  }

  const rootAbs = resolve(root);
  const cleaned = normalize(userPath).replace(/^([/\\])+/, '');
  const candidate = resolve(rootAbs, cleaned);

  // Step 1: syntactic containment.
  if (candidate !== rootAbs && !isSyntacticallySafe(rootAbs, candidate)) {
    return fail('path_escape', `Path "${userPath}" resolves outside the server's data directory.`, {
      details: { root: rootAbs, userPath },
    });
  }

  // Step 2: symlink-aware containment. `realpath` throws for paths that do not exist yet, which
  // is fine and expected for writes — in that case the syntactic check above stands, and the
  // deepest existing ancestor is checked instead so a symlinked *parent* is still caught.
  const realRoot = await realpath(rootAbs).catch(() => rootAbs);
  const realCandidate = await realpath(candidate).catch(() => null);

  if (realCandidate === null) {
    if (options.mustExist === true) {
      return fail('not_found', `Path "${userPath}" does not exist.`, { details: { userPath } });
    }
    const ancestor = await deepestExistingAncestor(candidate, rootAbs);
    if (ancestor && !isContained(realRoot, ancestor)) {
      return fail(
        'path_escape',
        `Path "${userPath}" is inside a symlink that leaves the server's data directory.`,
        { details: { root: rootAbs, userPath } }
      );
    }
  } else if (!isContained(realRoot, realCandidate)) {
    return fail(
      'path_escape',
      `Path "${userPath}" resolves through a symlink to outside the server's data directory.`,
      { details: { root: rootAbs, userPath, resolved: realCandidate } }
    );
  }

  const absolute = realCandidate ?? candidate;
  return ok({
    absolute,
    relative: relative(rootAbs, absolute).split(sep).join('/'),
  });
}

/**
 * Containment for a path that is already absolute and means it.
 *
 * The distinction from `isWithin` is the leading slash. `isWithin` strips it, because in the file
 * manager `/world/level.dat` means "level.dat under *this server's* data root" — a UI convention,
 * and the right one there. Applied to a symlink target read out of an archive, that convention is
 * a hole you can drive through: `isWithin(dest, '/etc/passwd')` re-roots the path to
 * `<dest>/etc/passwd`, decides it is contained, and returns true for the one input the check
 * exists to catch. An archive whose first entry symlinks `cfg` → `~/.ssh` and whose second writes
 * `cfg/authorized_keys` then extracts straight through the guard.
 *
 * So: no re-rooting, no stripping. The path is taken literally and asked whether it is at or
 * below the root. Syntactic only — the symlink-resolved check is `resolveWithin`'s job.
 */
export function isContained(root: string, candidate: string): boolean {
  if (candidate.includes('\0') || !isAbsolute(candidate)) {
    return false;
  }
  const rootAbs = resolve(root);
  const absolute = resolve(candidate);
  if (absolute === rootAbs) {
    return true;
  }
  const rel = relative(rootAbs, absolute);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Walk up until we find a path that exists, then return its real (symlink-resolved) location. */
async function deepestExistingAncestor(start: string, stopAt: string): Promise<string | null> {
  let current = start;
  // Bounded so a pathological input cannot spin here.
  for (let i = 0; i < 64; i++) {
    const parent = resolve(current, '..');
    if (parent === current) {
      return null;
    }
    const real = await realpath(parent).catch(() => null);
    if (real !== null) {
      return real;
    }
    if (parent === stopAt) {
      return null;
    }
    current = parent;
  }
  return null;
}

/**
 * Synchronous, syntax-only containment check.
 *
 * For the hot paths that run per log line or per archive entry, where an `await realpath` per
 * call would dominate. Archive extraction uses this to reject `../` entries cheaply, then does
 * the full async check once on the destination root.
 */
export function isWithin(root: string, userPath: string): boolean {
  if (userPath.includes('\0')) {
    return false;
  }
  const rootAbs = resolve(root);
  const candidate = resolve(rootAbs, normalize(userPath).replace(/^([/\\])+/, ''));
  return candidate === rootAbs || isSyntacticallySafe(rootAbs, candidate);
}

/**
 * Names that must never be writable through the file manager or an extracted archive.
 *
 * `eula.txt` and `server.properties` are managed by Platter and regenerated on every start, so
 * editing them by hand silently loses work. The dotfiles are the image's own install-state
 * caches; corrupting them produces confusing reinstall loops.
 */
export const PROTECTED_PATHS: ReadonlySet<string> = new Set([
  'eula.txt',
  '.mc-health.env',
  '.paused',
  '.skip-pause',
  '.skip-stop',
]);

export function isProtected(relativePath: string): boolean {
  const normalized = relativePath.replace(/^\/+/, '');
  return PROTECTED_PATHS.has(normalized);
}
