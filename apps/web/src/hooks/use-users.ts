import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { type z } from 'zod';
import {
  type createUserRequestSchema,
  type updateUserRequestSchema,
  type Paginated,
  type User,
  type UserRole,
} from '@platter/shared';
import { api } from '@/lib/api-client.js';
import { queryKeys } from '@/lib/query.js';

/** Neither request schema exports a named type in `@platter/shared`; inferred rather than
 *  hand-typed so this can never drift from what the API actually validates. */
type CreateUserRequest = z.infer<typeof createUserRequestSchema>;
type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

/** `listUsersQuerySchema` lives only in `routes/users.ts`, not `@platter/shared`. */
export interface UserListParams {
  page?: number;
  perPage?: number;
  search?: string;
  role?: UserRole;
  suspended?: boolean;
}

function usersListKey(params: UserListParams) {
  return [...queryKeys.users.all, 'list', params] as const;
}

export function useUsers(params: UserListParams = {}): UseQueryResult<Paginated<User>> {
  return useQuery({
    queryKey: usersListKey(params),
    queryFn: () =>
      api.get<Paginated<User>>('/users', {
        query: params as Record<string, string | number | boolean | undefined>,
      }),
  });
}

export function useUser(userId: string | undefined): UseQueryResult<User> {
  return useQuery({
    queryKey: queryKeys.users.detail(userId ?? ''),
    queryFn: () => api.get<User>(`/users/${userId}`),
    enabled: Boolean(userId),
  });
}

export function useCreateUser(): UseMutationResult<User, Error, CreateUserRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateUserRequest) => api.post<User>('/users', body),
    onSuccess: (user) => queryClient.setQueryData(queryKeys.users.detail(user.id), user),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.users.all }),
  });
}

export interface UpdateUserInput {
  userId: string;
  patch: UpdateUserRequest;
}

/**
 * Not optimistic. `suspended: true` cascades to every server the account owns, and a
 * password change revokes every session and API key it holds — both are consequential
 * enough that the admin should wait for the real confirmation.
 */
export function useUpdateUser(): UseMutationResult<User, Error, UpdateUserInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, patch }: UpdateUserInput) => api.patch<User>(`/users/${userId}`, patch),
    onSuccess: (user) => queryClient.setQueryData(queryKeys.users.detail(user.id), user),
    onSettled: (_user, _error, { userId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.detail(userId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
    },
  });
}

export interface DeleteUserInput {
  userId: string;
  /** Reassign the target's servers here instead of refusing the delete. */
  transferTo?: string;
}

export function useDeleteUser(): UseMutationResult<{ ok: true }, Error, DeleteUserInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, transferTo }: DeleteUserInput) =>
      api.delete<{ ok: true }>(`/users/${userId}`, { query: { transferTo } }),
    onSuccess: (_result, { userId }) =>
      queryClient.removeQueries({ queryKey: queryKeys.users.detail(userId) }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.users.all }),
  });
}
