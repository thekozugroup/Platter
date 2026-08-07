/**
 * Per-key serialisation.
 *
 * Platter reaches the same server from several directions at once — the UI, the MCP server, and
 * the cron scheduler all call the same functions — and some of those operations are not safe to
 * interleave. The one that bites hardest is backups: `save-off` and `save-on` are global switches
 * on the Minecraft server, not per-caller, so two overlapping backups produce
 *
 *   A: save-off ─────────── archive ─────────── save-on
 *   B:        save-off ──────────── archive ──────────── save-on
 *                                   ↑ auto-save resumes here, mid-archive
 *
 * and B's archive contains exactly the torn chunks the hot-backup sequence exists to prevent —
 * while still being marked complete with a valid checksum. Nobody finds out until they restore it.
 *
 * The lock is in-process, which is the right scope: Platter is a single-process application, and
 * a second instance pointed at the same data directory has larger problems than this. It is not
 * a substitute for the database constraints that guard genuinely concurrent writes.
 */

/**
 * Keys currently held, each mapped to a promise that settles when the holder finishes.
 *
 * Bounded by the number of servers, so it is left to grow rather than swept — an entry is a few
 * bytes and the alternative is a cleanup path that races with the next acquirer.
 */
const held = new Map<string, Promise<unknown>>();

/**
 * Run `fn` with exclusive access to `key`, queuing behind anything already running.
 *
 * The stored continuation swallows rejections so one failure cannot wedge the key forever, while
 * the returned promise still rejects for the caller.
 */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = held.get(key) ?? Promise.resolve();
  // `.then(fn, fn)` rather than `.then(fn)`: the next operation must run whether the previous one
  // succeeded or threw.
  const next = previous.then(fn, fn);
  held.set(
    key,
    next.catch(() => undefined)
  );
  return next;
}

/** Whether anything is currently holding this key. */
export function isLocked(key: string): boolean {
  return held.has(key);
}

/**
 * Run `fn` only if the key is free, rather than queuing.
 *
 * Returns `undefined` when it is already held, so a caller can report "already in progress"
 * instead of silently waiting several minutes behind a large backup. Used where queuing would be
 * indistinguishable from the app having hung.
 */
export async function withLockOrSkip<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (held.has(key)) {
    return undefined;
  }
  return withLock(key, fn);
}

/** Test seam. Never call this from application code. */
export function clearLocks(): void {
  held.clear();
}

/** Namespaced key helpers, so two subsystems cannot collide on a bare server id. */
export const lockKey = {
  backup: (serverId: string) => `backup:${serverId}`,
  lifecycle: (serverId: string) => `lifecycle:${serverId}`,
  mods: (serverId: string) => `mods:${serverId}`,
} as const;
