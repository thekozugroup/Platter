import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  InfiniteData,
  UseInfiniteQueryResult,
  UseMutationResult,
  UseQueryResult,
} from '@tanstack/react-query';
import { api } from '@/lib/api-client.js';

/**
 * The mod browser for one server.
 *
 * `apps/api/src/mods/registry.ts` and `mods/resolve.ts` define these shapes as zod schemas,
 * but they are internal to the API package and are not re-exported through
 * `@platter/shared` — this web app has no dependency on the API package to import them
 * from. The interfaces below are hand-mirrored from those schemas (last checked against
 * `registry.ts`'s `modSummarySchema`/`modDetailSchema`/`modVersionSchema` and
 * `resolve.ts`'s `installedModSchema`); if a field is added there, it has to be added here
 * too. Moving them into `@platter/shared` would remove that seam entirely.
 *
 * There is deliberately no install endpoint here — installing is reachable only by
 * approving a proposal (`use-proposals.ts`), never directly from a search result.
 */

export type ModSource = 'modrinth' | 'curseforge';
export type ModSide = 'required' | 'optional' | 'unsupported' | 'unknown';
export type ModProjectType =
  'mod' | 'plugin' | 'modpack' | 'resourcepack' | 'shader' | 'datapack' | 'world' | 'other';
export type ModReleaseChannel = 'release' | 'beta' | 'alpha';
export type ModDependencyKind = 'required' | 'optional' | 'incompatible' | 'embedded';

export interface ModFile {
  filename: string;
  url: string;
  sizeBytes: number;
  sha512: string | null;
  sha1: string | null;
}

export interface ModDependency {
  source: ModSource;
  projectId: string | null;
  versionId: string | null;
  kind: ModDependencyKind;
  fileName: string | null;
}

export interface ModSummary {
  source: ModSource;
  projectId: string;
  slug: string;
  title: string;
  summary: string;
  author: string | null;
  iconUrl: string | null;
  downloads: number;
  follows: number;
  categories: string[];
  loaders: string[];
  gameVersions: string[];
  clientSide: ModSide;
  serverSide: ModSide;
  license: string | null;
  projectType: ModProjectType;
  updatedAt: string | null;
  url: string;
}

export interface ModGalleryImage {
  url: string;
  title: string | null;
  description: string | null;
  featured: boolean;
}

export interface ModDetail extends ModSummary {
  description: string;
  descriptionFormat: 'markdown' | 'html' | 'text';
  gallery: ModGalleryImage[];
  licenseUrl: string | null;
  sourceUrl: string | null;
  issuesUrl: string | null;
  wikiUrl: string | null;
  discordUrl: string | null;
  donationUrls: Array<{ platform: string; url: string }>;
}

export interface ModVersion {
  source: ModSource;
  projectId: string;
  versionId: string;
  name: string;
  versionNumber: string;
  channel: ModReleaseChannel;
  gameVersions: string[];
  loaders: string[];
  publishedAt: string | null;
  downloads: number;
  dependencies: ModDependency[];
  file: ModFile;
  changelog: string | null;
}

export interface InstalledMod {
  source: ModSource;
  projectId: string;
  versionId: string;
  slug: string;
  title: string;
  versionNumber: string;
  filename: string;
  target: 'mods' | 'plugins';
  sizeBytes: number;
  sha512: string | null;
  sha1: string | null;
  gameVersions: string[];
  loaders: string[];
  publishedAt: string | null;
  installedAt: string;
  installedById: string | null;
  installedByName: string | null;
  proposalId: string | null;
}

export interface AggregateModSearchResult {
  hits: ModSummary[];
  total: number;
  offset: number;
  limit: number;
  sources: Array<{ source: ModSource; total: number; error: string | null }>;
}

const modsKeys = {
  search: (serverId: string, query: ModSearchParams) =>
    ['servers', serverId, 'mods', 'search', query] as const,
  installed: (serverId: string) => ['servers', serverId, 'mods', 'installed'] as const,
  updates: (serverId: string) => ['servers', serverId, 'mods', 'updates'] as const,
  detail: (serverId: string, source: ModSource, project: string) =>
    ['servers', serverId, 'mods', source, project] as const,
  versions: (serverId: string, source: ModSource, project: string) =>
    ['servers', serverId, 'mods', source, project, 'versions'] as const,
};

export interface ModSearchParams {
  q?: string;
  source?: ModSource;
  category?: string;
  /** `'any'` drops the server's own game-version constraint. */
  gameVersion?: string;
  limit?: number;
}

const SEARCH_PAGE_SIZE = 20;

/**
 * Mod search fans out to a third-party API with its own tight rate limit (40/min — see
 * `routes/mods.ts`), so results are treated as good for a while and never refetched just
 * because the window regained focus.
 */
export function useModSearch(
  serverId: string,
  params: ModSearchParams = {},
): UseInfiniteQueryResult<InfiniteData<AggregateModSearchResult>> {
  return useInfiniteQuery({
    queryKey: modsKeys.search(serverId, params),
    queryFn: ({ pageParam }) =>
      api.get<AggregateModSearchResult>(`/servers/${serverId}/mods`, {
        query: { ...params, limit: params.limit ?? SEARCH_PAGE_SIZE, offset: pageParam },
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) =>
      lastPage.offset + lastPage.hits.length < lastPage.total
        ? lastPage.offset + lastPage.hits.length
        : undefined,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useInstalledMods(
  serverId: string,
): UseQueryResult<{ data: InstalledMod[]; sources: ModSource[] }> {
  return useQuery({
    queryKey: modsKeys.installed(serverId),
    queryFn: () =>
      api.get<{ data: InstalledMod[]; sources: ModSource[] }>(
        `/servers/${serverId}/mods/installed`,
      ),
  });
}

export interface ModUpdateCandidate {
  installed: InstalledMod;
  latest: ModVersion;
  prerelease: boolean;
}

/** One upstream request per installed mod (see `routes/mods.ts`'s 6/min budget for this
 *  route) — never polled, only fetched when the operator asks. */
export function useModUpdates(serverId: string): UseQueryResult<{ data: ModUpdateCandidate[] }> {
  return useQuery({
    queryKey: modsKeys.updates(serverId),
    queryFn: () => api.get<{ data: ModUpdateCandidate[] }>(`/servers/${serverId}/mods/updates`),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    enabled: false,
  });
}

export interface ModDetailResponse {
  mod: ModDetail;
  compatibleVersions: ModVersion[];
  installed: InstalledMod | null;
  target: 'mods' | 'plugins' | null;
  incompatibleReason: string | null;
}

export function useMod(
  serverId: string,
  source: ModSource | undefined,
  project: string | undefined,
): UseQueryResult<ModDetailResponse> {
  return useQuery({
    queryKey: modsKeys.detail(serverId, source ?? 'modrinth', project ?? ''),
    queryFn: () => api.get<ModDetailResponse>(`/servers/${serverId}/mods/${source}/${project}`),
    enabled: Boolean(source) && Boolean(project),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useModVersions(
  serverId: string,
  source: ModSource | undefined,
  project: string | undefined,
): UseQueryResult<{ data: ModVersion[] }> {
  return useQuery({
    queryKey: modsKeys.versions(serverId, source ?? 'modrinth', project ?? ''),
    queryFn: () =>
      api.get<{ data: ModVersion[] }>(`/servers/${serverId}/mods/${source}/${project}/versions`),
    enabled: Boolean(source) && Boolean(project),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

/** Uninstalling deletes a real file from the server's disk — not optimistic. */
export function useUninstallMod(
  serverId: string,
): UseMutationResult<InstalledMod, Error, { source: ModSource; project: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ source, project }: { source: ModSource; project: string }) =>
      api.delete<InstalledMod>(`/servers/${serverId}/mods/${source}/${project}`),
    onSuccess: (removed) => {
      queryClient.setQueryData<{ data: InstalledMod[]; sources: ModSource[] }>(
        modsKeys.installed(serverId),
        (previous) =>
          previous
            ? {
                ...previous,
                data: previous.data.filter((mod) => mod.projectId !== removed.projectId),
              }
            : previous,
      );
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: modsKeys.installed(serverId) }),
  });
}
