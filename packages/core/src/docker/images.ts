import { attempt, BACKUP_IMAGE, fail, MINECRAFT_IMAGE, ok, type Result } from '@platter/shared';
import type Docker from 'dockerode';

/**
 * Image pulling.
 *
 * Pulling a Minecraft image is the longest single step in creating a server — a few hundred
 * megabytes on a cold host — and it is the step most likely to be interrupted. So it reports
 * progress, and the progress is *aggregated across layers* rather than reported per layer:
 * Docker emits one progress record per layer per tick, and forwarding those raw produces a
 * jittering mess where the number goes backwards as new layers appear.
 */

export interface PullProgress {
  /** 0-1 across all layers, or undefined before Docker reports any totals. */
  percent: number | undefined;
  downloadedBytes: number;
  totalBytes: number;
  /** Human-readable current phase, e.g. 'Downloading', 'Extracting'. */
  phase: string;
  layers: number;
}

interface PullEvent {
  id?: string;
  status?: string;
  progressDetail?: { current?: number; total?: number };
  error?: string;
  errorDetail?: { message?: string };
}

/**
 * Images Platter will run without `PLATTER_ALLOW_CUSTOM_IMAGES`.
 *
 * A control panel that will run an arbitrary image on request is a remote code execution
 * primitive wearing a friendly hat: `-v /:/host` in a custom image spec owns the machine. The
 * allowlist is the difference between "Platter runs game servers" and "Platter runs anything".
 */
const DEFAULT_ALLOWED_REPOS: readonly string[] = [MINECRAFT_IMAGE, BACKUP_IMAGE];

/**
 * Strip the tag and digest from an image reference, leaving the repository.
 *
 * Splitting on the first `:` is wrong, because a registry host may carry a port:
 * `registry.internal:5000/itzg/minecraft-server:java21` would yield `registry.internal`, which
 * matches no allowlist entry. That is the documented air-gapped-mirror configuration, so the
 * operator's only way forward was `PLATTER_ALLOW_CUSTOM_IMAGES=1` — turning the guard off
 * entirely because of a parsing bug.
 *
 * A `:` is a tag separator only if it comes after the last `/`; anywhere earlier it is a port.
 */
export function imageRepository(image: string): string {
  const withoutDigest = image.split('@')[0] ?? '';
  const lastSlash = withoutDigest.lastIndexOf('/');
  const tagColon = withoutDigest.indexOf(':', lastSlash + 1);
  return tagColon === -1 ? withoutDigest : withoutDigest.slice(0, tagColon);
}

export function isAllowedImage(
  image: string,
  allowCustom: boolean,
  extraRepos: readonly string[] = []
): boolean {
  if (allowCustom) {
    return true;
  }
  const repo = imageRepository(image);
  return DEFAULT_ALLOWED_REPOS.includes(repo) || extraRepos.includes(repo);
}

export async function imageExists(docker: Docker, image: string): Promise<boolean> {
  try {
    await docker.getImage(image).inspect();
    return true;
  } catch {
    return false;
  }
}

export async function pullImage(
  docker: Docker,
  image: string,
  options: {
    onProgress?: (progress: PullProgress) => void;
    signal?: AbortSignal;
    allowCustom?: boolean;
    /** Repositories configured as trusted mirrors, from the environment. */
    allowedRepos?: readonly string[];
  } = {}
): Promise<Result<void>> {
  if (!isAllowedImage(image, options.allowCustom ?? false, options.allowedRepos ?? [])) {
    return fail(
      'not_supported',
      `Image "${image}" is not in Platter's allowlist. ` +
        'Set PLATTER_ALLOW_CUSTOM_IMAGES=1 to run arbitrary images (see SECURITY.md).',
      { details: { image } }
    );
  }

  const started = await attempt(
    () => docker.pull(image) as Promise<NodeJS.ReadableStream>,
    'image_pull_failed'
  );
  if (!started.ok) {
    return started;
  }

  const stream = started.value;
  // Per-layer byte counters, keyed by layer id. Summed on every tick so the aggregate is
  // monotonic even as Docker discovers new layers.
  const downloaded = new Map<string, number>();
  const totals = new Map<string, number>();
  let phase = 'Preparing';

  return new Promise<Result<void>>((resolvePromise) => {
    const onAbort = () => {
      (stream as unknown as { destroy?: () => void }).destroy?.();
      resolvePromise(fail('timeout', `Pull of ${image} was cancelled.`, { details: { image } }));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    docker.modem.followProgress(
      stream,
      (error: Error | null) => {
        options.signal?.removeEventListener('abort', onAbort);
        if (error) {
          resolvePromise(
            fail('image_pull_failed', `Could not pull ${image}: ${error.message}`, {
              details: { image },
              cause: error,
            })
          );
          return;
        }
        resolvePromise(ok(undefined));
      },
      (event: PullEvent) => {
        if (event.error) {
          return; // Surfaced through the completion callback.
        }
        if (event.status) {
          phase = event.status;
        }
        if (event.id && event.progressDetail) {
          const { current, total } = event.progressDetail;
          if (typeof current === 'number') {
            downloaded.set(event.id, current);
          }
          if (typeof total === 'number' && total > 0) {
            totals.set(event.id, total);
          }
        }

        if (!options.onProgress) {
          return;
        }
        const downloadedBytes = sum(downloaded.values());
        const totalBytes = sum(totals.values());
        options.onProgress({
          percent: totalBytes > 0 ? Math.min(1, downloadedBytes / totalBytes) : undefined,
          downloadedBytes,
          totalBytes,
          phase,
          layers: totals.size,
        });
      }
    );
  });
}

/** Pull only if the image is not already present. */
export async function ensureImage(
  docker: Docker,
  image: string,
  options: Parameters<typeof pullImage>[2] = {}
): Promise<Result<void>> {
  if (await imageExists(docker, image)) {
    return ok(undefined);
  }
  return pullImage(docker, image, options);
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}
