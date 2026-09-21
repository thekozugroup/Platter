import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { getModProvider, isModSourceAvailable, type ModSource } from '../mods/registry.js';

/**
 * Which published modpack a server runs, and the pack's own artwork.
 *
 * A modpack server is not really "a Minecraft server" to the person running it — it is
 * *All the Mods 10*, or *Cobblemon*. Wearing the generic Minecraft mark made every pack on
 * the dashboard look like every other one, which is the same failure the two-letter
 * monograms had before the game marks replaced them: a list of tiles that cannot be told
 * apart is a list you have to read the labels of.
 *
 * The pack's identity is already in the server's own variables, because the container image
 * needs it to install the pack at all. So nothing new has to be stored: the variables say
 * which pack, and the registry says what it looks like.
 */

/** A pack this server is configured to run. `ref` is whatever its registry accepts. */
export interface ModpackRef {
  source: ModSource | 'ftb';
  /** Slug, project id or numeric pack id, depending on the source. */
  ref: string;
}

export interface ModpackArtwork extends ModpackRef {
  title: string;
  /** Upstream URL. The route proxies and signs it — never hand this to a browser. */
  iconUrl: string | null;
}

/**
 * Turns a Modrinth project URL into the slug the API wants.
 *
 * The blueprint's own help text says this field accepts "a project slug, project id or a
 * full modrinth.com URL", and people paste the URL, because that is what is in their
 * address bar when they decide on a pack.
 */
function modrinthRef(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  if (!value.includes('/')) return value;

  // `https://modrinth.com/modpack/cobblemon-fabric?foo=1` → `cobblemon-fabric`
  const match = /modrinth\.com\/(?:modpack|mod|project)\/([A-Za-z0-9!@$()`.+,_"~-]+)/.exec(value);
  return match?.[1] ?? null;
}

/** `https://www.curseforge.com/minecraft/modpacks/all-the-mods-10` → `all-the-mods-10` */
function curseforgeRef(slug: string, pageUrl: string): string | null {
  const direct = slug.trim();
  if (direct.length > 0) return direct;

  const url = pageUrl.trim();
  if (url.length === 0) return null;
  const match = /curseforge\.com\/minecraft\/modpacks\/([A-Za-z0-9._-]+)/.exec(url);
  return match?.[1] ?? null;
}

/**
 * Reads the pack out of a server's variables, or null when it does not run one.
 *
 * Pure and keyed on `TYPE`, which is what the container image itself dispatches on: a
 * server carrying a stale `MODRINTH_MODPACK` from a type it no longer runs is not a
 * Modrinth pack server, and treating it as one would put the wrong artwork on it.
 */
export function detectModpack(variables: Readonly<Record<string, string>>): ModpackRef | null {
  const type = (variables['TYPE'] ?? '').trim().toUpperCase();

  if (type === 'MODRINTH') {
    const ref = modrinthRef(variables['MODRINTH_MODPACK'] ?? '');
    return ref ? { source: 'modrinth', ref } : null;
  }
  if (type === 'AUTO_CURSEFORGE') {
    const ref = curseforgeRef(variables['CF_SLUG'] ?? '', variables['CF_PAGE_URL'] ?? '');
    return ref ? { source: 'curseforge', ref } : null;
  }
  if (type === 'FTBA') {
    const ref = (variables['FTB_MODPACK_ID'] ?? '').trim();
    return /^\d+$/.test(ref) ? { source: 'ftb', ref } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const FTB_BASE = 'https://api.feed-the-beast.com/v1/modpacks/public/modpack';
const TIMEOUT_MS = 8000;

/**
 * Feed the Beast publishes several crops per pack; `square` is the one that belongs in a
 * tile. The rest of the payload is large and none of it is needed here.
 */
const ftbPackSchema = z.object({
  name: z.string().default(''),
  art: z.array(z.object({ type: z.string().default(''), url: z.string().default('') })).default([]),
});

/**
 * Resolved packs, and the ones that could not be resolved.
 *
 * Negative entries are cached deliberately and for less time. A pack slug that does not
 * exist — a typo, or a pack that was taken down — would otherwise be looked up again on
 * every render of every screen that shows the server, which is a request to somebody
 * else's API for an answer that has not changed.
 */
const CACHE_MS = 12 * 60 * 60 * 1000;
const NEGATIVE_CACHE_MS = 10 * 60 * 1000;

interface CacheEntry {
  value: ModpackArtwork | null;
  at: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(pack: ModpackRef): string {
  return `${pack.source}:${pack.ref}`;
}

/** Exposed for tests, which must not inherit another case's answer. */
export function resetModpackCache(): void {
  cache.clear();
}

async function resolveFtb(ref: string, signal: AbortSignal): Promise<ModpackArtwork | null> {
  const response = await fetch(`${FTB_BASE}/${encodeURIComponent(ref)}`, {
    headers: { accept: 'application/json' },
    signal,
  });
  if (!response.ok) return null;

  const parsed = ftbPackSchema.safeParse(await response.json());
  if (!parsed.success) return null;

  const square = parsed.data.art.find((art) => art.type === 'square') ?? parsed.data.art[0];
  const title = parsed.data.name.trim();
  if (title.length === 0) return null;

  return {
    source: 'ftb',
    ref,
    title,
    iconUrl: square && square.url.length > 0 ? square.url : null,
  };
}

async function resolveRegistry(
  source: ModSource,
  ref: string,
  signal: AbortSignal,
): Promise<ModpackArtwork | null> {
  if (!isModSourceAvailable(source)) return null;
  const project = await getModProvider(source).getProject(ref, signal);
  return { source, ref, title: project.title, iconUrl: project.iconUrl };
}

/**
 * The pack's title and artwork, or null when it cannot be resolved.
 *
 * Never throws. A registry that is down, a pack that was removed, a CurseForge install with
 * no API key — all of them land on the game mark, which is a correct picture of the server
 * rather than an error the operator can do nothing about.
 */
export async function resolveModpack(
  pack: ModpackRef,
  log?: FastifyBaseLogger,
): Promise<ModpackArtwork | null> {
  const key = cacheKey(pack);
  const hit = cache.get(key);
  if (hit) {
    const ttl = hit.value === null ? NEGATIVE_CACHE_MS : CACHE_MS;
    if (Date.now() - hit.at < ttl) return hit.value;
  }

  let value: ModpackArtwork | null = null;
  try {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    value =
      pack.source === 'ftb'
        ? await resolveFtb(pack.ref, signal)
        : await resolveRegistry(pack.source, pack.ref, signal);
  } catch (error) {
    log?.debug({ err: error, pack: key }, 'could not resolve modpack artwork');
    value = null;
  }

  cache.set(key, { value, at: Date.now() });
  return value;
}
