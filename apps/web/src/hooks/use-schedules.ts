import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { type z } from 'zod';
import {
  type updateScheduleRequestSchema,
  type CreateScheduleRequest,
  type Schedule,
} from '@platter/shared';
import { api } from '@/lib/api-client.js';
import { queryKeys } from '@/lib/query.js';

/** `updateScheduleRequestSchema` has no exported named type; inferred rather than hand-typed. */
type UpdateScheduleRequest = z.infer<typeof updateScheduleRequestSchema>;

export function useSchedules(serverId: string): UseQueryResult<{ data: Schedule[] }> {
  return useQuery({
    queryKey: queryKeys.schedules.all(serverId),
    queryFn: () => api.get<{ data: Schedule[] }>(`/servers/${serverId}/schedules`),
  });
}

/** Not optimistic — `nextRunAt` is computed server-side from the cron and timezone, and
 *  guessing it client-side would just be wrong for anything but the simplest expression. */
export function useCreateSchedule(serverId: string): UseMutationResult<Schedule, Error, CreateScheduleRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateScheduleRequest) => api.post<Schedule>(`/servers/${serverId}/schedules`, body),
    onSuccess: (schedule) => {
      queryClient.setQueryData<{ data: Schedule[] }>(queryKeys.schedules.all(serverId), (previous) => ({
        data: previous ? [schedule, ...previous.data] : [schedule],
      }));
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.schedules.all(serverId) }),
  });
}

export interface UpdateScheduleInput {
  scheduleId: string;
  patch: UpdateScheduleRequest;
}

/** Not optimistic for the general case — changing the cron or action also moves
 *  `nextRunAt`, which this client cannot recompute correctly (see `computeNextRun` on the
 *  API side, which understands real cron semantics and timezones). */
export function useUpdateSchedule(serverId: string): UseMutationResult<Schedule, Error, UpdateScheduleInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ scheduleId, patch }: UpdateScheduleInput) =>
      api.patch<Schedule>(`/servers/${serverId}/schedules/${scheduleId}`, patch),
    onSuccess: (schedule) => {
      queryClient.setQueryData<{ data: Schedule[] }>(queryKeys.schedules.all(serverId), (previous) =>
        previous
          ? { data: previous.data.map((row) => (row.id === schedule.id ? schedule : row)) }
          : previous,
      );
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.schedules.all(serverId) }),
  });
}

interface ToggleContext {
  previous: { data: Schedule[] } | undefined;
}

export interface ToggleScheduleInput {
  scheduleId: string;
  enabled: boolean;
}

/**
 * Optimistic, unlike the general update above: flipping `enabled` off always recomputes
 * `nextRunAt` to `null` and flipping it on recomputes it from the schedule's *existing*
 * cron — a value already sitting in cache — so the client can predict it exactly rather
 * than guess.
 */
export function useToggleSchedule(
  serverId: string,
): UseMutationResult<Schedule, Error, ToggleScheduleInput, ToggleContext> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ scheduleId, enabled }: ToggleScheduleInput) =>
      api.patch<Schedule>(`/servers/${serverId}/schedules/${scheduleId}`, { enabled }),
    onMutate: async ({ scheduleId, enabled }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.schedules.all(serverId) });
      const previous = queryClient.getQueryData<{ data: Schedule[] }>(queryKeys.schedules.all(serverId));
      queryClient.setQueryData<{ data: Schedule[] }>(queryKeys.schedules.all(serverId), (current) =>
        current
          ? {
              data: current.data.map((row) =>
                row.id === scheduleId
                  ? { ...row, enabled, nextRunAt: enabled ? row.nextRunAt : null }
                  : row,
              ),
            }
          : current,
      );
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(queryKeys.schedules.all(serverId), context.previous);
    },
    onSuccess: (schedule) => {
      queryClient.setQueryData<{ data: Schedule[] }>(queryKeys.schedules.all(serverId), (current) =>
        current ? { data: current.data.map((row) => (row.id === schedule.id ? schedule : row)) } : current,
      );
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.schedules.all(serverId) }),
  });
}

export function useDeleteSchedule(serverId: string): UseMutationResult<{ ok: true }, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scheduleId: string) => api.delete<{ ok: true }>(`/servers/${serverId}/schedules/${scheduleId}`),
    onSuccess: (_result, scheduleId) => {
      queryClient.setQueryData<{ data: Schedule[] }>(queryKeys.schedules.all(serverId), (current) =>
        current ? { data: current.data.filter((row) => row.id !== scheduleId) } : current,
      );
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.schedules.all(serverId) }),
  });
}

/** Fires a schedule immediately; does not move its `nextRunAt`. Not optimistic — the run
 *  itself (and whether it succeeds) happens after this call returns. */
export function useRunScheduleNow(serverId: string): UseMutationResult<{ ok: true }, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scheduleId: string) => api.post<{ ok: true }>(`/servers/${serverId}/schedules/${scheduleId}/run`),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.schedules.all(serverId) }),
  });
}
