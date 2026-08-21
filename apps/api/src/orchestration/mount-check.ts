import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';

/**
 * Proves that Platter and the Docker daemon mean the same directory by the same path.
 *
 * Platter asks the daemon to bind-mount each server's data directory into its game
 * container. The daemon resolves bind sources on the *host*, so a path that exists only
 * inside Platter's own container names a different directory to each side. When Platter ran
 * with a named volume that is exactly what happened, and nothing anywhere reported it: mods,
 * `server.properties`, `eula.txt` and backups were written into Platter's volume while the
 * game server read an empty directory the daemon created at the host root. Servers booted,
 * the panel looked healthy, and every file-facing feature was quietly operating on a phantom
 * copy — including backups, which produced archives with no world in them.
 *
 * A comment cannot hold this invariant, and neither can a unit test: it is a property of how
 * this particular container was started. So it is measured, once, against the real daemon.
 */

/**
 * The last result, so provisioning can refuse rather than write into a phantom directory.
 * Module state because it describes the process's own container, which cannot change while
 * the process lives.
 */
let lastCheck: MountCheck | null = null;

export function recordMountCheck(result: MountCheck): void {
  lastCheck = result;
}

/**
 * Null until the check has run. Callers treat null as "not yet known" rather than "fine":
 * a check that has not run is not a check that passed.
 */
export function getMountCheck(): MountCheck | null {
  return lastCheck;
}

/** Reset for tests, which build many apps in one process. */
export function resetMountCheck(): void {
  lastCheck = null;
}

export type MountCheck =
  | { ok: true; skipped: false }
  | { ok: true; skipped: true; reason: string }
  | { ok: false; skipped: false; reason: string; remedy: string };

/** Where the sentinel lives. Inside the data dir, because that is the claim under test. */
function probeDir(): string {
  return path.join(config.dataDir, '.platter', 'mount-probe');
}

/**
 * Writes a sentinel, then asks the daemon to show it back through a bind mount of the same
 * path. Equality of bytes is the whole assertion — not that the path parses, or exists, or
 * looks plausible.
 */
export async function verifyDataMount(
  docker: {
    createContainer: (options: unknown) => Promise<{
      start: () => Promise<unknown>;
      wait: () => Promise<{ StatusCode: number }>;
      remove: (options?: unknown) => Promise<unknown>;
    }>;
  },
  image: string,
  log?: FastifyBaseLogger,
): Promise<MountCheck> {
  // Not an entity id: `newId` takes a closed set of entity prefixes, and this is a nonce.
  const token = randomUUID();
  const dir = probeDir();
  const file = path.join(dir, token);

  await mkdir(dir, { recursive: true });
  await writeFile(file, token, 'utf8');

  try {
    /*
     * `Entrypoint: []` is not optional. Platter's own image has an entrypoint that applies
     * database migrations, so leaving it in place would run a migration inside a throwaway
     * container and report its failure as a mount failure — a wrong diagnosis for the most
     * confusing bug in the product.
     */
    const container = await docker.createContainer({
      Image: image,
      Entrypoint: [],
      Cmd: ['test', '-f', file],
      HostConfig: {
        Binds: [`${config.dataDir}:${config.dataDir}:ro`],
        AutoRemove: false,
        NetworkMode: 'none',
      },
      Labels: { 'sh.platter.probe': 'mount' },
    });

    try {
      await container.start();
      const { StatusCode } = await container.wait();
      if (StatusCode === 0) return { ok: true, skipped: false };

      return {
        ok: false,
        skipped: false,
        reason:
          `The Docker daemon does not see ${config.dataDir} as the directory Platter writes ` +
          `to. A file written there was not visible through a bind mount of the same path.`,
        remedy:
          `Platter's data directory must be a host directory mounted at the same absolute ` +
          `path inside the container, so that PLATTER_DATA_DIR means one directory to both ` +
          `Platter and the daemon. Set PLATTER_DATA_DIR in .env and mount it as ` +
          `"\${PLATTER_DATA_DIR}:\${PLATTER_DATA_DIR}". A named volume cannot satisfy this.`,
      };
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  } catch (error) {
    /*
     * An unreachable daemon is not a failed mount. Saying so would turn every socket
     * permission problem into a misleading story about paths, so this reports honestly that
     * the check could not run and lets the driver's own errors speak.
     */
    log?.warn({ err: error }, 'could not run the data mount check');
    return {
      ok: true,
      skipped: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
}
