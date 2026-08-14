import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { type z } from 'zod';
import {
  type upsertSubuserRequestSchema,
  type PowerAction,
  type Server,
  type ServerPermission,
  type ServerStats,
  type ServerSubuser,
  type UpdateServerRequest,
} from '@platter/shared';
import { api } from '@/lib/api-client.js';
import { queryKeys } from '@/lib/query.js';

/**
 * Everything about one server: detail, power, reinstall, delete, subusers.
 *
 * Optimism is applied only to the two fields that are pure metadata flips with no way to
 * fail short of a network error — a rename and the autostart/autorestart booleans. Power,
 * delete and reinstall all take real, observable time on the node and are never faked: the
 * mutation stays pending until the API actually answers.
 */

// `upsertSubuserRequestSchema` has no exported named type in `@platter/shared`; inferring
// from the schema itself (rather than hand-typing the shape) keeps this from drifting.
type UpsertSubuserRequest = z.infer<typeof upsertSubuserRequestSchema>;

export function useServer(serverId: string | undefined): UseQueryResult<Server> {
  return useQuery({
    queryKey: queryKeys.servers.detail(serverId ?? ''),
    queryFn: () => api.get<Server>(`/servers/${serverId}`),
    enabled: Boolean(serverId),
  });
}

export interface UseServerStatsOptions {
  /** Off by default — most screens get live stats from `useConsole`'s socket instead. */
  refetchInterval?: number | false;
  enabled?: boolean;
}

export function useServerStats(
  serverId: string | undefined,
  options: UseServerStatsOptions = {},
): UseQueryResult<ServerStats> {
  return useQuery({
    queryKey: queryKeys.servers.stats(serverId ?? ''),
    queryFn: () => api.get<ServerStats>(`/servers/${serverId}/stats`),
    enabled: Boolean(serverId) && (options.enabled ?? true),
    refetchInterval: options.refetchInterval ?? false,
  });
}

interface RenameContext {
  previous: Server | undefined;
}

/** Optimistic: a name is pure metadata, and a failed rename rolls back instantly. */
export function useRenameServer(
  serverId: string,
): UseMutationResult<Server, Error, string, RenameContext> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.patch<Server>(`/servers/${serverId}`, { name }),
    onMutate: async (name) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.servers.detail(serverId) });
      const previous = queryClient.getQueryData<Server>(queryKeys.servers.detail(serverId));
      if (previous) {
        queryClient.setQueryData<Server>(queryKeys.servers.detail(serverId), { ...previous, name });
      }
      return { previous };
    },
    onError: (_error, _name, context) => {
      if (context?.previous)
        queryClient.setQueryData(queryKeys.servers.detail(serverId), context.previous);
    },
    onSuccess: (server) => queryClient.setQueryData(queryKeys.servers.detail(serverId), server),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers.detail(serverId) });
      // The list view shows the name too.
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers.all });
    },
  });
}

interface BooleanFlagContext {
  previous: Server | undefined;
}

function useServerBooleanFlag(
  serverId: string,
  field: 'autoStart' | 'autoRestart',
): UseMutationResult<Server, Error, boolean, BooleanFlagContext> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (value: boolean) => api.patch<Server>(`/servers/${serverId}`, { [field]: value }),
    onMutate: async (value) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.servers.detail(serverId) });
      const previous = queryClient.getQueryData<Server>(queryKeys.servers.detail(serverId));
      if (previous) {
        queryClient.setQueryData<Server>(queryKeys.servers.detail(serverId), {
          ...previous,
          [field]: value,
        });
      }
      return { previous };
    },
    onError: (_error, _value, context) => {
      if (context?.previous)
        queryClient.setQueryData(queryKeys.servers.detail(serverId), context.previous);
    },
    onSuccess: (server) => queryClient.setQueryData(queryKeys.servers.detail(serverId), server),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers.detail(serverId) }),
  });
}

/** Optimistic: toggling autostart is a pure DB flag with no way to half-fail. */
export function useSetAutoStart(serverId: string) {
  return useServerBooleanFlag(serverId, 'autoStart');
}

/** Optimistic, for the same reason as `useSetAutoStart`. */
export function useSetAutoRestart(serverId: string) {
  return useServerBooleanFlag(serverId, 'autoRestart');
}

/** Everything else that can change (description, limits, variables) — not optimistic,
 *  because a limits change can fail with `insufficient_resources` and there is nothing
 *  honest to show in the meantime. */
export function useUpdateServer(
  serverId: string,
): UseMutationResult<Server, Error, UpdateServerRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateServerRequest) => api.patch<Server>(`/servers/${serverId}`, body),
    onSuccess: (server) => queryClient.setQueryData(queryKeys.servers.detail(serverId), server),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers.detail(serverId) }),
  });
}

export function useDeleteServer(): UseMutationResult<{ id: string; deleted: true }, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (serverId: string) =>
      api.delete<{ id: string; deleted: true }>(`/servers/${serverId}`),
    onSuccess: (result) => {
      queryClient.removeQueries({ queryKey: queryKeys.servers.detail(result.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers.all });
    },
  });
}

export function useReinstallServer(serverId: string): UseMutationResult<Server, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<Server>(`/servers/${serverId}/reinstall`),
    onSuccess: (server) => queryClient.setQueryData(queryKeys.servers.detail(serverId), server),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers.detail(serverId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers.all });
    },
  });
}

export interface PowerActionInput {
  action: PowerAction;
  /** Skip the graceful stop and go straight to the signal. */
  force?: boolean;
}

/**
 * Never optimistic. A server takes real seconds to start or stop, and pretending the status
 * flipped the instant the button was pressed is a lie the console and the status pill would
 * immediately contradict.
 */
export function usePowerAction(
  serverId: string,
): UseMutationResult<Server, Error, PowerActionInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, force = false }: PowerActionInput) =>
      api.post<Server>(`/servers/${serverId}/power`, { action, force }),
    onSuccess: (server) => queryClient.setQueryData(queryKeys.servers.detail(serverId), server),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers.detail(serverId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers.stats(serverId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers.all });
    },
  });
}

/** The REST fallback for sending one console command outside the websocket. */
export function useSendCommand(
  serverId: string,
): UseMutationResult<{ accepted: true }, Error, string> {
  return useMutation({
    mutationFn: (command: string) =>
      api.post<{ accepted: true }>(`/servers/${serverId}/command`, { command }),
  });
}

// ---------------------------------------------------------------------------
// Subusers
// ---------------------------------------------------------------------------

export function useSubusers(serverId: string | undefined): UseQueryResult<ServerSubuser[]> {
  return useQuery({
    queryKey: queryKeys.servers.subusers(serverId ?? ''),
    queryFn: () => api.get<ServerSubuser[]>(`/servers/${serverId}/subusers`),
    enabled: Boolean(serverId),
  });
}

export function useAddSubuser(
  serverId: string,
): UseMutationResult<ServerSubuser, Error, UpsertSubuserRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpsertSubuserRequest) =>
      api.post<ServerSubuser>(`/servers/${serverId}/subusers`, body),
    onSuccess: (subuser) => {
      queryClient.setQueryData<ServerSubuser[]>(queryKeys.servers.subusers(serverId), (previous) =>
        previous ? [...previous, subuser] : [subuser],
      );
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers.subusers(serverId) }),
  });
}

export interface UpdateSubuserInput {
  subuserId: string;
  permissions: ServerPermission[];
}

interface SubusersContext {
  previous: ServerSubuser[] | undefined;
}

/** Optimistic: a permission set on an existing collaborator is a pure DB field, freely
 *  re-editable if the request fails. */
export function useUpdateSubuserPermissions(
  serverId: string,
): UseMutationResult<ServerSubuser, Error, UpdateSubuserInput, SubusersContext> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ subuserId, permissions }: UpdateSubuserInput) =>
      api.patch<ServerSubuser>(`/servers/${serverId}/subusers/${subuserId}`, { permissions }),
    onMutate: async ({ subuserId, permissions }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.servers.subusers(serverId) });
      const previous = queryClient.getQueryData<ServerSubuser[]>(
        queryKeys.servers.subusers(serverId),
      );
      queryClient.setQueryData<ServerSubuser[]>(queryKeys.servers.subusers(serverId), (current) =>
        current?.map((subuser) =>
          subuser.id === subuserId ? { ...subuser, permissions } : subuser,
        ),
      );
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous)
        queryClient.setQueryData(queryKeys.servers.subusers(serverId), context.previous);
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers.subusers(serverId) }),
  });
}

export function useRemoveSubuser(
  serverId: string,
): UseMutationResult<{ id: string; deleted: true }, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (subuserId: string) =>
      api.delete<{ id: string; deleted: true }>(`/servers/${serverId}/subusers/${subuserId}`),
    onSuccess: (result) => {
      queryClient.setQueryData<ServerSubuser[]>(queryKeys.servers.subusers(serverId), (previous) =>
        previous?.filter((subuser) => subuser.id !== result.id),
      );
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers.subusers(serverId) }),
  });
}
