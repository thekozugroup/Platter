import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Blueprint, BlueprintCategory, BlueprintSummary } from '@platter/shared';
import { api } from '@/lib/api-client.js';
import { queryKeys } from '@/lib/query.js';

/**
 * The blueprint catalogue. Read-only — blueprints ship with the build — so there is
 * nothing here but two queries.
 */

export interface BlueprintListParams {
  category?: BlueprintCategory;
  search?: string;
  feature?: 'console' | 'rcon' | 'mods' | 'worldUpload' | 'playerList';
}

export function useBlueprints(
  params: BlueprintListParams = {},
): UseQueryResult<{ data: BlueprintSummary[] }> {
  const hasFilters = Object.keys(params).length > 0;
  return useQuery({
    // A dozen entries that ship with the binary — one cache entry per filter combination is
    // cheap, and `queryKeys.blueprints.all` still names the unfiltered case for anything
    // that wants to invalidate every blueprint query at once.
    queryKey: hasFilters ? [...queryKeys.blueprints.all, params] : queryKeys.blueprints.all,
    queryFn: () =>
      api.get<{ data: BlueprintSummary[] }>('/blueprints', {
        query: params as Record<string, string | undefined>,
      }),
    // The catalogue does not change while the server is running.
    staleTime: 10 * 60_000,
  });
}

export function useBlueprint(key: string | undefined): UseQueryResult<Blueprint> {
  return useQuery({
    queryKey: queryKeys.blueprints.detail(key ?? ''),
    queryFn: () => api.get<Blueprint>(`/blueprints/${key}`),
    enabled: Boolean(key),
    staleTime: 10 * 60_000,
  });
}
