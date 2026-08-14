import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { type z } from 'zod';
import {
  type restoreBackupRequestSchema,
  type Backup,
  type CreateBackupRequest,
} from '@platter/shared';
import { api } from '@/lib/api-client.js';
import { queryKeys } from '@/lib/query.js';
import { fetchAuthenticatedBlob, saveBlob } from './use-files.js';

/** `restoreBackupRequestSchema` has no exported named type; inferred rather than hand-typed. */
type RestoreBackupRequest = z.infer<typeof restoreBackupRequestSchema>;

export function useBackups(serverId: string): UseQueryResult<{ data: Backup[] }> {
  return useQuery({
    queryKey: queryKeys.backups.all(serverId),
    queryFn: () => api.get<{ data: Backup[] }>(`/servers/${serverId}/backups`),
  });
}

/** Not optimistic — the archive builds in the background and starts life as `pending`;
 *  there is nothing to predict, only the real row the API just created. */
export function useCreateBackup(
  serverId: string,
): UseMutationResult<Backup, Error, CreateBackupRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateBackupRequest) =>
      api.post<Backup>(`/servers/${serverId}/backups`, body),
    onSuccess: (backup) => {
      queryClient.setQueryData<{ data: Backup[] }>(queryKeys.backups.all(serverId), (previous) => ({
        data: previous ? [backup, ...previous.data] : [backup],
      }));
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.backups.all(serverId) }),
  });
}

interface LockContext {
  previous: { data: Backup[] } | undefined;
}

export interface LockBackupInput {
  backupId: string;
  locked: boolean;
}

/** Optimistic — matches the guide's own example: locking is a pure metadata flag with an
 *  instant, obvious rollback. */
export function useLockBackup(
  serverId: string,
): UseMutationResult<Backup, Error, LockBackupInput, LockContext> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ backupId, locked }: LockBackupInput) =>
      api.patch<Backup>(`/servers/${serverId}/backups/${backupId}`, { locked }),
    onMutate: async ({ backupId, locked }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.backups.all(serverId) });
      const previous = queryClient.getQueryData<{ data: Backup[] }>(
        queryKeys.backups.all(serverId),
      );
      queryClient.setQueryData<{ data: Backup[] }>(queryKeys.backups.all(serverId), (current) =>
        current
          ? {
              data: current.data.map((backup) =>
                backup.id === backupId ? { ...backup, locked } : backup,
              ),
            }
          : current,
      );
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous)
        queryClient.setQueryData(queryKeys.backups.all(serverId), context.previous);
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.backups.all(serverId) }),
  });
}

/** Not optimistic — a locked or in-flight backup can refuse deletion server-side. */
export function useDeleteBackup(serverId: string): UseMutationResult<{ ok: true }, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (backupId: string) =>
      api.delete<{ ok: true }>(`/servers/${serverId}/backups/${backupId}`),
    onSuccess: (_result, backupId) => {
      queryClient.setQueryData<{ data: Backup[] }>(queryKeys.backups.all(serverId), (current) =>
        current ? { data: current.data.filter((backup) => backup.id !== backupId) } : current,
      );
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.backups.all(serverId) }),
  });
}

export interface RestoreBackupResult {
  ok: true;
  stoppedServer: boolean;
}

/** Never optimistic: restoring stops the server, overwrites its data volume and can take a
 *  while — exactly the class of action the guide says never to fake. */
export function useRestoreBackup(
  serverId: string,
): UseMutationResult<
  RestoreBackupResult,
  Error,
  { backupId: string; truncate?: RestoreBackupRequest['truncate'] }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ backupId, truncate = false }) =>
      api.post<RestoreBackupResult>(`/servers/${serverId}/backups/${backupId}/restore`, {
        truncate,
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers.detail(serverId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.backups.all(serverId) });
    },
  });
}

/** See `fetchAuthenticatedBlob` in `use-files.ts` for why this is not a plain URL. */
export function useDownloadBackup(serverId: string): UseMutationResult<void, Error, string> {
  return useMutation({
    mutationFn: async (backupId: string) => {
      const { blob, filename } = await fetchAuthenticatedBlob(
        `/servers/${serverId}/backups/${backupId}/download`,
        undefined,
        `${backupId}.tar.gz`,
      );
      saveBlob(blob, filename);
    },
  });
}
