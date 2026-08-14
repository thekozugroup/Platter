import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { api } from '@/lib/api-client.js';

/**
 * Player administration for one server. Every shape here is defined only in
 * `routes/players.ts`, not `@platter/shared` — hand-mirrored below for the same reason
 * documented at the top of `use-mods.ts`.
 *
 * Every mutation is a console command under the hood (`op`, `ban`, `whitelist add`, …) and
 * can fail for reasons that have nothing to do with this client — the server is offline,
 * RCON has no password yet. None of them are optimistic: the guide's rule against faking a
 * power action applies here just as much, since these are the same kind of "ask the live
 * game server to do something" call.
 */

export interface PlayerRecord {
  name: string;
  online: boolean;
  playtimeMs: number;
  sessions: number;
  firstSeen: string | null;
  lastSeen: string | null;
  onlineSince: string | null;
  op: boolean;
  operatorLevel: number | null;
  whitelisted: boolean;
  banned: boolean;
  banReason: string | null;
}

export type RosterUnavailableReason =
  | 'not_supported'
  | 'not_enabled'
  | 'no_password'
  | 'offline'
  | 'unreachable'
  | 'timeout'
  | 'auth_failed'
  | 'protocol_error';

export interface PlayerRoster {
  source: 'rcon' | 'query' | 'logs';
  onlineCount: number;
  maxPlayers: number | null;
  unavailable: RosterUnavailableReason | null;
  unavailableMessage: string | null;
  whitelistEnabled: boolean | null;
  players: PlayerRecord[];
}

export interface ServerHealthWindow {
  average: number;
  peak: number;
}

/**
 * Why there is no tick rate. `offline` is the API's catch-all: it reports it for a stopped
 * server *and* for a running one whose RCON it could not use, so a screen must weigh it
 * against the live status rather than repeat it verbatim.
 */
export type HealthUnavailableReason = 'unsupported' | 'unreadable' | 'unconfigured' | 'offline';

export interface ServerHealth {
  tps: {
    oneMinute: number;
    fiveMinutes: number;
    fifteenMinutes: number;
    estimated: boolean;
  } | null;
  mspt: {
    fiveSeconds: ServerHealthWindow;
    oneMinute: ServerHealthWindow;
    fiveMinutes: ServerHealthWindow;
  } | null;
  unavailable: HealthUnavailableReason | null;
}

export interface WhitelistState {
  enabled: boolean | null;
  names: string[];
  live: boolean;
}

export interface BanEntry {
  target: string;
  source: string | null;
  reason: string | null;
}

export interface BansState {
  players: BanEntry[];
  ips: BanEntry[];
  live: boolean;
}

export interface CommandResult {
  ok: true;
  output: string;
}

const playersKeys = {
  roster: (serverId: string) => ['servers', serverId, 'players'] as const,
  health: (serverId: string) => ['servers', serverId, 'players', 'health'] as const,
  whitelist: (serverId: string) => ['servers', serverId, 'players', 'whitelist'] as const,
  bans: (serverId: string) => ['servers', serverId, 'players', 'bans'] as const,
};

export interface UsePollingOptions {
  refetchInterval?: number | false;
}

/** Who is online now, and everyone this server has ever seen. Polls by default — "who's
 *  playing" is exactly the kind of thing that goes stale the moment nobody is watching it. */
export function usePlayerRoster(
  serverId: string,
  options: UsePollingOptions = {},
): UseQueryResult<PlayerRoster> {
  return useQuery({
    queryKey: playersKeys.roster(serverId),
    queryFn: () => api.get<PlayerRoster>(`/servers/${serverId}/players`),
    refetchInterval: options.refetchInterval ?? 10_000,
  });
}

export function useServerHealth(
  serverId: string,
  options: UsePollingOptions = {},
): UseQueryResult<ServerHealth> {
  return useQuery({
    queryKey: playersKeys.health(serverId),
    queryFn: () => api.get<ServerHealth>(`/servers/${serverId}/players/health`),
    refetchInterval: options.refetchInterval ?? 10_000,
  });
}

export function useWhitelist(serverId: string): UseQueryResult<WhitelistState> {
  return useQuery({
    queryKey: playersKeys.whitelist(serverId),
    queryFn: () => api.get<WhitelistState>(`/servers/${serverId}/players/whitelist`),
  });
}

export function useSetWhitelistEnabled(
  serverId: string,
): UseMutationResult<CommandResult, Error, boolean> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api.put<CommandResult>(`/servers/${serverId}/players/whitelist`, { enabled }),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: playersKeys.whitelist(serverId) }),
  });
}

export function useAddToWhitelist(
  serverId: string,
): UseMutationResult<CommandResult, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.post<CommandResult>(`/servers/${serverId}/players/whitelist`, { name }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: playersKeys.whitelist(serverId) });
      void queryClient.invalidateQueries({ queryKey: playersKeys.roster(serverId) });
    },
  });
}

export function useRemoveFromWhitelist(
  serverId: string,
): UseMutationResult<CommandResult, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.delete<CommandResult>(
        `/servers/${serverId}/players/whitelist/${encodeURIComponent(name)}`,
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: playersKeys.whitelist(serverId) });
      void queryClient.invalidateQueries({ queryKey: playersKeys.roster(serverId) });
    },
  });
}

export function useBans(serverId: string): UseQueryResult<BansState> {
  return useQuery({
    queryKey: playersKeys.bans(serverId),
    queryFn: () => api.get<BansState>(`/servers/${serverId}/players/bans`),
  });
}

export interface BanIpInput {
  ip: string;
  reason?: string;
}

export function useBanIp(serverId: string): UseMutationResult<CommandResult, Error, BanIpInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ip, reason }: BanIpInput) =>
      api.post<CommandResult>(`/servers/${serverId}/players/bans/ip`, {
        ip,
        reason,
      }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: playersKeys.bans(serverId) }),
  });
}

export function usePardonIp(serverId: string): UseMutationResult<CommandResult, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ip: string) =>
      api.delete<CommandResult>(`/servers/${serverId}/players/bans/ip/${encodeURIComponent(ip)}`),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: playersKeys.bans(serverId) }),
  });
}

export interface PlayerActionInput {
  name: string;
  reason?: string;
}

export function useKickPlayer(
  serverId: string,
): UseMutationResult<CommandResult, Error, PlayerActionInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, reason }: PlayerActionInput) =>
      api.post<CommandResult>(`/servers/${serverId}/players/${encodeURIComponent(name)}/kick`, {
        reason,
      }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: playersKeys.roster(serverId) }),
  });
}

export function useBanPlayer(
  serverId: string,
): UseMutationResult<CommandResult, Error, PlayerActionInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, reason }: PlayerActionInput) =>
      api.post<CommandResult>(`/servers/${serverId}/players/${encodeURIComponent(name)}/ban`, {
        reason,
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: playersKeys.roster(serverId) });
      void queryClient.invalidateQueries({ queryKey: playersKeys.bans(serverId) });
    },
  });
}

export function usePardonPlayer(serverId: string): UseMutationResult<CommandResult, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.post<CommandResult>(`/servers/${serverId}/players/${encodeURIComponent(name)}/pardon`),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: playersKeys.roster(serverId) });
      void queryClient.invalidateQueries({ queryKey: playersKeys.bans(serverId) });
    },
  });
}

export interface SetOperatorInput {
  name: string;
  op: boolean;
}

export function useSetOperator(
  serverId: string,
): UseMutationResult<CommandResult, Error, SetOperatorInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, op }: SetOperatorInput) =>
      api.put<CommandResult>(`/servers/${serverId}/players/${encodeURIComponent(name)}/op`, { op }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: playersKeys.roster(serverId) }),
  });
}
