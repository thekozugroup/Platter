import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';

/**
 * Whether a newer Platter has been published.
 *
 * A self-hosted panel that never mentions its own updates leaves every operator to notice on
 * their own, which in practice means running whatever they installed until something breaks.
 * Security fixes are the ones that matter, and they are exactly the ones nobody hears about.
 *
 * Checking only. Platter does not replace its own container: it would have to stop itself
 * mid-request to do it, and a failure halfway leaves no interface to diagnose from. The
 * honest thing is to say a version exists and give the two commands that apply it.
 *
 * The call is to GitHub's public release endpoint, unauthenticated, and it is skippable —
 * some people run this deliberately offline, and an update check is not worth a surprise
 * outbound connection. `configureHttpProxy` has already installed the dispatcher, so this
 * works on a host whose only egress is a proxy.
 */

const RELEASE_URL = 'https://api.github.com/repos/thekozugroup/Platter/releases/latest';

/** Long enough that a restart loop cannot hammer the API, short enough to matter. */
const CACHE_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;

export const updateStatusSchema = z.object({
  current: z.string(),
  /** Null when the check is off, has not run, or could not reach the registry. */
  latest: z.string().nullable(),
  updateAvailable: z.boolean(),
  releaseUrl: z.string().nullable(),
  publishedAt: z.string().nullable(),
  checkedAt: z.string().nullable(),
  /** Why there is no answer, for the one line the UI shows instead of a version. */
  unavailable: z.string().nullable(),
});
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

const releaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.string(),
  published_at: z.string().nullable().default(null),
  draft: z.boolean().default(false),
  prerelease: z.boolean().default(false),
});

interface CacheEntry {
  status: UpdateStatus;
  at: number;
}

let cache: CacheEntry | null = null;

/** Exposed for tests, which must not inherit a previous case's answer. */
export function resetUpdateCache(): void {
  cache = null;
}

/**
 * Compares two dotted versions numerically.
 *
 * String comparison gets this wrong in the one case it matters: "0.10.0" sorts before
 * "0.9.0", so the release that fixes something would look older than what is installed.
 * Anything after the numbers (`-rc.1`) marks a prerelease and loses to the plain version.
 */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (value: string): { parts: number[]; pre: boolean } => {
    const cleaned = value.trim().replace(/^v/i, '');
    const [core = '', ...rest] = cleaned.split('-');
    return {
      parts: core.split('.').map((part) => Number.parseInt(part, 10) || 0),
      pre: rest.length > 0,
    };
  };

  const a = parse(candidate);
  const b = parse(current);
  const length = Math.max(a.parts.length, b.parts.length);

  for (let index = 0; index < length; index += 1) {
    const left = a.parts[index] ?? 0;
    const right = b.parts[index] ?? 0;
    if (left !== right) return left > right;
  }
  // Same numbers: a prerelease is older than the release it leads to, never newer.
  return b.pre && !a.pre;
}

export interface UpdateCheckOptions {
  currentVersion: string;
  enabled: boolean;
  fetchImpl?: typeof fetch;
  log?: FastifyBaseLogger;
}

function offline(current: string, reason: string): UpdateStatus {
  return {
    current,
    latest: null,
    updateAvailable: false,
    releaseUrl: null,
    publishedAt: null,
    checkedAt: null,
    unavailable: reason,
  };
}

export async function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateStatus> {
  const { currentVersion, enabled, fetchImpl = fetch, log } = options;

  if (!enabled) return offline(currentVersion, 'Update checks are turned off.');

  if (cache && Date.now() - cache.at < CACHE_MS && cache.status.current === currentVersion) {
    return cache.status;
  }

  try {
    const response = await fetchImpl(RELEASE_URL, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `Platter/${currentVersion}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    // A repository with no published release answers 404, which is not a failure worth
    // alarming anyone about — it is the normal state before the first tag.
    if (response.status === 404) {
      const status = offline(currentVersion, 'No release has been published yet.');
      cache = { status, at: Date.now() };
      return status;
    }
    if (!response.ok)
      return offline(currentVersion, `The release feed answered ${response.status}.`);

    const parsed = releaseSchema.safeParse(await response.json());
    if (!parsed.success) return offline(currentVersion, 'The release feed could not be read.');
    if (parsed.data.draft) return offline(currentVersion, 'No release has been published yet.');

    const latest = parsed.data.tag_name.replace(/^v/i, '');
    const status: UpdateStatus = {
      current: currentVersion,
      latest,
      updateAvailable: isNewer(latest, currentVersion),
      releaseUrl: parsed.data.html_url,
      publishedAt: parsed.data.published_at,
      checkedAt: new Date().toISOString(),
      unavailable: null,
    };
    cache = { status, at: Date.now() };
    return status;
  } catch (error) {
    // Never fatal: not knowing whether an update exists must not take a settings page down.
    log?.debug({ err: error }, 'update check failed');
    return offline(currentVersion, 'Could not reach the release feed.');
  }
}
