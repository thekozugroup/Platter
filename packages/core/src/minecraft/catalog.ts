import { eq } from 'drizzle-orm';
import type { PlatterDatabase } from '@platter/db';
import { settings as settingsTable } from '@platter/db';
import {
  type GameVersionEntry,
  type MinecraftLoader,
  type Result,
  VersionIndex,
  attempt,
  fail,
  logger,
  ok,
} from '@platter/shared';

const log = logger.child('catalog');

/**
 * The Minecraft version catalogue.
 *
 * Platter needs an authoritative, *ordered* list of Minecraft versions in two places: the
 * version picker when creating a server, and the compatibility engine when deciding whether a
 * mod supports a server's version.
 *
 * Modrinth's `/v2/tag/game_version` is that list. It is returned newest-first and is the only
 * reliable ordering available — Minecraft moved to calendar versioning (`26.1`, `26.2`) and no
 * comparator over the version strings sorts `1.21.11` and `26.1` correctly. Deriving order from
 * this array's *positions* sidesteps the problem entirely.
 *
 * Cached in the settings table rather than in memory: the picker must work on a fresh page load
 * without a network round trip, and it must work at all when the machine is offline, which is a
 * completely ordinary state for a local-first tool.
 */

const CACHE_KEY = 'minecraft.versions';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TAG_URL = 'https://api.modrinth.com/v2/tag/game_version';

const USER_AGENT = 'thekozugroup/platter (+https://github.com/thekozugroup/Platter)';

interface CachedVersions {
  fetchedAt: number;
  entries: GameVersionEntry[];
}

interface RawTag {
  version: string;
  version_type: string;
  date: string;
  major: boolean;
}

/**
 * Versions Platter falls back to when it has never successfully fetched the list and the
 * network is unavailable. Deliberately short and clearly stale-able: better a working picker
 * with a few well-known versions than an empty one that looks broken.
 */
const FALLBACK: GameVersionEntry[] = [
  { version: '1.21.4', versionType: 'release', date: '2024-12-03T00:00:00Z', major: false },
  { version: '1.21.1', versionType: 'release', date: '2024-08-08T00:00:00Z', major: false },
  { version: '1.20.6', versionType: 'release', date: '2024-04-29T00:00:00Z', major: false },
  { version: '1.20.4', versionType: 'release', date: '2023-12-07T00:00:00Z', major: false },
  { version: '1.20.1', versionType: 'release', date: '2023-06-12T00:00:00Z', major: true },
  { version: '1.19.2', versionType: 'release', date: '2022-08-05T00:00:00Z', major: false },
  { version: '1.18.2', versionType: 'release', date: '2022-02-28T00:00:00Z', major: false },
  { version: '1.16.5', versionType: 'release', date: '2021-01-14T00:00:00Z', major: true },
  { version: '1.12.2', versionType: 'release', date: '2017-09-18T00:00:00Z', major: true },
];

function readCache(db: PlatterDatabase): CachedVersions | undefined {
  const row = db.select().from(settingsTable).where(eq(settingsTable.key, CACHE_KEY)).get();
  if (!row) {
    return undefined;
  }
  const value = row.value as CachedVersions | null;
  return value && Array.isArray(value.entries) && value.entries.length > 0 ? value : undefined;
}

function writeCache(db: PlatterDatabase, value: CachedVersions): void {
  db.insert(settingsTable)
    .values({ key: CACHE_KEY, value, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: settingsTable.key,
      set: { value, updatedAt: Date.now() },
    })
    .run();
}

async function fetchVersions(): Promise<Result<GameVersionEntry[]>> {
  const response = await attempt(
    () =>
      fetch(TAG_URL, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      }),
    'upstream_error'
  );
  if (!response.ok) {
    return response;
  }
  if (!response.value.ok) {
    return fail('upstream_error', `Modrinth returned ${response.value.status} for the version list.`);
  }

  const parsed = await attempt(() => response.value.json() as Promise<RawTag[]>, 'upstream_error');
  if (!parsed.ok) {
    return parsed;
  }
  if (!Array.isArray(parsed.value) || parsed.value.length === 0) {
    return fail('upstream_error', 'Modrinth returned an empty version list.');
  }

  return ok(
    parsed.value.map((tag) => ({
      version: tag.version,
      versionType:
        tag.version_type === 'release' ||
        tag.version_type === 'snapshot' ||
        tag.version_type === 'alpha' ||
        tag.version_type === 'beta'
          ? tag.version_type
          : 'release',
      date: tag.date,
      major: tag.major === true,
    }))
  );
}

/**
 * The version index, refreshing the cache when it is stale.
 *
 * Never fails: a stale cache is used when the refresh fails, and the built-in fallback is used
 * when there is no cache at all. Creating a server must not depend on Modrinth being reachable.
 */
export async function getVersionIndex(
  db: PlatterDatabase,
  options: { forceRefresh?: boolean } = {}
): Promise<VersionIndex> {
  const cached = readCache(db);
  const fresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS;

  if (fresh && options.forceRefresh !== true) {
    return new VersionIndex(cached.entries);
  }

  const fetched = await fetchVersions();
  if (fetched.ok) {
    writeCache(db, { fetchedAt: Date.now(), entries: fetched.value });
    return new VersionIndex(fetched.value);
  }

  if (cached) {
    log.warn('using a stale version list; could not reach Modrinth', {
      error: fetched.error.message,
      ageHours: Math.round((Date.now() - cached.fetchedAt) / 3_600_000),
    });
    return new VersionIndex(cached.entries);
  }

  log.warn('using the built-in version list; Modrinth is unreachable and there is no cache', {
    error: fetched.error.message,
  });
  return new VersionIndex(FALLBACK);
}

/* -------------------------------------------------------------------------- */
/* Loader availability                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Which loaders are worth offering for a given Minecraft version.
 *
 * These are hard historical facts, not preferences, and getting them wrong means a server that
 * fails minutes into creation with a download 404 rather than at the point the user chose:
 *
 *   - **NeoForge** forked from Forge during 1.20.1 and has no builds before it.
 *   - **Folia** is Paper's regionised-threading fork and only exists from 1.19.4.
 *   - **Quilt** started at 1.18.2.
 *   - **Fabric** has builds from 1.14 onward.
 *   - **Purpur** starts at 1.14.4.
 */
export function availableLoaders(gameVersion: string, index: VersionIndex): MinecraftLoader[] {
  const atLeast = (floor: string): boolean =>
    index.has(gameVersion) && index.has(floor) ? index.compare(gameVersion, floor) >= 0 : true;

  const loaders: MinecraftLoader[] = ['vanilla'];

  if (atLeast('1.8')) {
    loaders.push('spigot');
  }
  if (atLeast('1.8.8')) {
    loaders.push('paper');
  }
  if (atLeast('1.14.4')) {
    loaders.push('purpur');
  }
  if (atLeast('1.19.4')) {
    loaders.push('folia');
  }
  if (atLeast('1.14')) {
    loaders.push('fabric');
  }
  if (atLeast('1.18.2')) {
    loaders.push('quilt');
  }
  loaders.push('forge');
  if (atLeast('1.20.1')) {
    loaders.push('neoforge');
  }

  return loaders;
}

/** A short explanation of what each loader is for, shown next to the choice. */
export const LOADER_BLURB: Readonly<Record<MinecraftLoader, string>> = {
  vanilla: 'Exactly what Mojang ships. No plugins or mods.',
  paper: 'Fast, plugin-capable, and the usual choice for a survival server with friends.',
  purpur: 'Paper plus a large set of gameplay tweaks you can turn on and off.',
  spigot: 'Older plugin platform. Prefer Paper unless a plugin specifically needs Spigot.',
  folia: 'Paper with regionised multithreading. Only worth it for hundreds of players.',
  fabric: 'Lightweight mod loader. The best-supported option for performance mods.',
  forge: 'The long-established mod loader. Most big modpacks target it.',
  neoforge: 'The actively developed continuation of Forge, from 1.20.1 onward.',
  quilt: 'A Fabric fork. Runs Fabric mods, with a few extra loader features.',
};
