import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { api } from '@/lib/api-client.js';
import { queryKeys } from '@/lib/query.js';

/**
 * Runtime settings and readiness. `GET /system/info` (version, `needsSetup`, feature
 * flags) already has a home in `lib/auth.tsx`'s `useSystemInfo` — it is read before login
 * even exists, so it lives with the auth bootstrap rather than here.
 */

export interface SystemSettings {
  siteName: string;
  motd: string;
  updateChecks: boolean;
}

export interface UpdateStatus {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  publishedAt: string | null;
  checkedAt: string | null;
  unavailable: string | null;
}

/**
 * The answer is cached for hours on the server, so this is cheap to mount and there is no
 * reason to refetch it on focus — a version does not change while someone reads the page.
 */
export function useUpdateStatus(): UseQueryResult<UpdateStatus> {
  return useQuery({
    queryKey: queryKeys.system.updates(),
    queryFn: () => api.get<UpdateStatus>('/system/updates'),
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useSystemSettings(): UseQueryResult<SystemSettings> {
  return useQuery({
    queryKey: queryKeys.system.settings(),
    queryFn: () => api.get<SystemSettings>('/system/settings'),
  });
}

export function useUpdateSystemSettings(): UseMutationResult<
  SystemSettings,
  Error,
  Partial<SystemSettings>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<SystemSettings>) =>
      api.patch<SystemSettings>('/system/settings', patch),
    onSuccess: (settings) => queryClient.setQueryData(queryKeys.system.settings(), settings),
  });
}

export interface ReadinessCheck {
  ok: boolean;
  error: string | null;
}

export interface SystemReadiness {
  ok: boolean;
  checks: { database: ReadinessCheck; nodes: ReadinessCheck };
}

/**
 * `GET /system/ready` answers 200 when healthy and 503 with the *same* body when not — the
 * 503 carries the per-check breakdown that says which dependency is actually down. So 503
 * is declared an expected status and its body read normally; `ok: false` is the signal, not
 * the HTTP code. A genuine failure (the API unreachable, a proxy answering) still throws.
 */
export function useSystemReadiness(): UseQueryResult<SystemReadiness> {
  return useQuery({
    queryKey: queryKeys.system.health(),
    queryFn: () => api.get<SystemReadiness>('/system/ready', { expect: [503] }),
    refetchInterval: 30_000,
  });
}
