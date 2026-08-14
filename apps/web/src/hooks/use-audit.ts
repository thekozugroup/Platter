import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import type {
  InfiniteData,
  UseInfiniteQueryResult,
  UseMutationResult,
} from '@tanstack/react-query';
import { type z } from 'zod';
import { type listAuditQuerySchema, type AuditEntry, type Paginated } from '@platter/shared';
import { api } from '@/lib/api-client.js';
import { queryKeys } from '@/lib/query.js';
import { fetchAuthenticatedBlob, saveBlob } from './use-files.js';

/** `listAuditQuerySchema` has no exported named type; inferred rather than hand-typed. */
type AuditQuery = z.infer<typeof listAuditQuerySchema>;
export type AuditFilters = Omit<AuditQuery, 'page' | 'perPage'>;

/** The audit feed: potentially very large, so it loads a page at a time. */
export function useAuditLog(
  filters: AuditFilters = {},
): UseInfiniteQueryResult<InfiniteData<Paginated<AuditEntry>>> {
  return useInfiniteQuery({
    queryKey: queryKeys.audit.list(filters),
    queryFn: ({ pageParam }) =>
      api.get<Paginated<AuditEntry>>('/audit', {
        query: { ...filters, page: pageParam, perPage: 50 },
      }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.meta.page < lastPage.meta.totalPages ? lastPage.meta.page + 1 : undefined,
  });
}

/** The streamed NDJSON export. See `fetchAuthenticatedBlob` in `use-files.ts` for why this
 *  is a fetch-then-save mutation rather than a plain `<a href>`. */
export function useExportAuditLog(
  filters: AuditFilters = {},
): UseMutationResult<void, Error, void> {
  return useMutation({
    mutationFn: async () => {
      const { blob, filename } = await fetchAuthenticatedBlob(
        '/audit/export',
        filters,
        'platter-audit-log.ndjson',
      );
      saveBlob(blob, filename);
    },
  });
}
