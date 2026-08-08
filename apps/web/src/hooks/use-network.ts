import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import type { ServerAllocation } from '@platter/shared';
import { api } from '@/lib/api-client.js';

/**
 * Friendly addressing. Every shape here is defined only in `routes/network.ts`, not
 * `@platter/shared` — mirrored below for the reason documented at the top of `use-mods.ts`.
 * `ServerAllocation` is the one exception; it already lives in `@platter/shared`.
 */

export interface SrvRecordInfo {
  service: string;
  protocol: 'tcp' | 'udp';
  target: string;
  port: number;
}

export interface ServerAddress {
  serverId: string;
  hostname: string;
  zone: string;
  fqdn: string;
  ip: string;
  port: number;
  protocol: 'tcp' | 'udp';
  mdnsAvailable: boolean;
  srv: SrvRecordInfo | null;
  /** The shortest thing a player can actually type. */
  connectString: string;
  allocations: ServerAllocation[];
}

export interface ReachabilityResult {
  host: string;
  port: number;
  protocol: 'tcp' | 'udp';
  listening: boolean | null;
  connected: boolean;
  reachability: 'unreachable' | 'lan' | 'unknown';
  detail: string;
  latencyMs: number;
  checkedAt: string;
}

export interface ZoneRecordLine {
  name: string;
  line: string;
}

export interface WildcardARecord extends ZoneRecordLine {
  target: string;
  ttl: number;
}

export interface ZoneSrvRecord extends ZoneRecordLine {
  service: string;
  protocol: 'tcp' | 'udp';
  priority: number;
  weight: number;
  port: number;
  target: string;
  ttl: number;
}

export interface ZoneRecords {
  zone: string;
  publicIp: string | null;
  wildcardA: WildcardARecord;
  srvRecords: ZoneSrvRecord[];
  zoneFileText: string;
}

const networkKeys = {
  address: (serverId: string) => ['servers', serverId, 'network'] as const,
  allocations: (serverId: string) => ['servers', serverId, 'network', 'allocations'] as const,
  zone: () => ['network', 'zone'] as const,
};

export function useServerAddress(serverId: string): UseQueryResult<ServerAddress> {
  return useQuery({
    queryKey: networkKeys.address(serverId),
    queryFn: () => api.get<ServerAddress>(`/servers/${serverId}/network`),
  });
}

export function useServerAllocations(serverId: string): UseQueryResult<{ data: ServerAllocation[] }> {
  return useQuery({
    queryKey: networkKeys.allocations(serverId),
    queryFn: () => api.get<{ data: ServerAllocation[] }>(`/servers/${serverId}/network/allocations`),
  });
}

export interface ChangeAllocationPortInput {
  portName: string;
  hostPort: number;
}

export interface ChangeAllocationPortResult {
  allocation: ServerAllocation;
  requiresRestart: boolean;
}

/** Not optimistic — a port can already be taken elsewhere on the node, which only the API
 *  can actually check. */
export function useChangeAllocationPort(
  serverId: string,
): UseMutationResult<ChangeAllocationPortResult, Error, ChangeAllocationPortInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ portName, hostPort }: ChangeAllocationPortInput) =>
      api.patch<ChangeAllocationPortResult>(`/servers/${serverId}/network/allocations/${portName}`, {
        hostPort,
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: networkKeys.allocations(serverId) });
      void queryClient.invalidateQueries({ queryKey: networkKeys.address(serverId) });
    },
  });
}

/**
 * "Test connection" is a manual action, not a background poll — `enabled: false` so the
 * hook only fires when the screen calls `refetch()`.
 */
export function useReachabilityCheck(serverId: string, portName?: string): UseQueryResult<ReachabilityResult> {
  return useQuery({
    queryKey: ['servers', serverId, 'network', 'reachability', portName ?? null] as const,
    queryFn: () => api.get<ReachabilityResult>(`/servers/${serverId}/network/reachability`, { query: { portName } }),
    enabled: false,
    staleTime: 0,
  });
}

// ---------------------------------------------------------------------------
// Zone-wide DNS (admin)
// ---------------------------------------------------------------------------

export function useZoneRecords(): UseQueryResult<ZoneRecords> {
  return useQuery({
    queryKey: networkKeys.zone(),
    queryFn: () => api.get<ZoneRecords>('/network/zone'),
  });
}

export interface UpdateZoneInput {
  zone?: string;
  publicIp?: string | null;
}

export function useUpdateZone(): UseMutationResult<ZoneRecords, Error, UpdateZoneInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateZoneInput) => api.put<ZoneRecords>('/network/zone', body),
    onSuccess: (zone) => queryClient.setQueryData(networkKeys.zone(), zone),
  });
}
