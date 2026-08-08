import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseInfiniteQueryResult, UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import type { CreateServerRequest, Paginated, Server, ServerStatus, ServerSummary } from '@platter/shared';
import { api } from '@/lib/api-client.js';
import { queryKeys } from '@/lib/query.js';

/**
 * The server list and server creation.
 *
 * Everything about *one* server (detail, power, subusers, stats) lives in `use-server.ts`;
 * this file is only the collection view. The sidebar's own 10s poll (`useSidebarServers` in
 * `components/layout/sidebar.tsx`) is a separate, narrower query and is deliberately not
 * touched here — duplicating it would mean two independent pollers disagreeing after a mutation.
 */

export interface ServerListParams {
  search?: string;
  status?: ServerStatus;
  blueprintKey?: string;
  nodeId?: string;
  sort?: 'name' | 'createdAt' | 'status';
  order?: 'asc' | 'desc';
  perPage?: number;
}

/** One page, for contexts that just need "the current page" (e.g. a quick lookup). */
export function useServers(
  params: ServerListParams & { page?: number } = {},
): UseQueryResult<Paginated<ServerSummary>> {
  return useQuery({
    queryKey: queryKeys.servers.list(params as Record<string, unknown>),
    queryFn: () =>
      api.get<Paginated<ServerSummary>>('/servers', {
        query: params as Record<string, string | number | boolean | undefined>,
      }),
  });
}

/** The dashboard/servers grid: loads more pages on demand instead of one big page. */
export function useInfiniteServers(
  params: ServerListParams = {},
): UseInfiniteQueryResult<Paginated<ServerSummary>> {
  return useInfiniteQuery({
    // `infinite` distinguishes this cache entry from `useServers`' single-page one — the two
    // hold different shapes (`Paginated<T>` vs. pages of it) and must never share a key.
    queryKey: [...queryKeys.servers.list(params as Record<string, unknown>), 'infinite'],
    queryFn: ({ pageParam }) =>
      api.get<Paginated<ServerSummary>>('/servers', {
        query: { ...params, page: pageParam, perPage: params.perPage ?? 25 } as Record<
          string,
          string | number | boolean | undefined
        >,
      }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.meta.page < lastPage.meta.totalPages ? lastPage.meta.page + 1 : undefined,
  });
}

export function useCreateServer(): UseMutationResult<Server, Error, CreateServerRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateServerRequest) => api.post<Server>('/servers', body),
    onSuccess: (server) => {
      queryClient.setQueryData(queryKeys.servers.detail(server.id), server);
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers.all });
    },
  });
}
