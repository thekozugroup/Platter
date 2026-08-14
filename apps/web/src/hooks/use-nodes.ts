import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { type z } from 'zod';
import {
  type updateNodeRequestSchema,
  type CreateNodeRequest,
  type Node,
  type NodeCapacity,
} from '@platter/shared';
import { api } from '@/lib/api-client.js';
import { queryKeys } from '@/lib/query.js';

/** `updateNodeRequestSchema` has no exported named type; inferred rather than hand-typed. */
type UpdateNodeRequest = z.infer<typeof updateNodeRequestSchema>;

/** Shape of `POST /nodes/:id/test`. Defined only in `routes/nodes.ts`, not `@platter/shared`
 *  — this is the minimal mirror this client needs. */
export interface TestNodeResult {
  reachable: boolean;
  driverVersion: string | null;
  cpuCores: number | null;
  memoryTotalMb: number | null;
  containersRunning: number | null;
  error: string | null;
  latencyMs: number;
  testedAt: string;
}

export function useNodes(): UseQueryResult<{ data: Node[] }> {
  return useQuery({
    queryKey: queryKeys.nodes.all,
    queryFn: () => api.get<{ data: Node[] }>('/nodes'),
  });
}

export function useNode(nodeId: string | undefined): UseQueryResult<Node> {
  return useQuery({
    queryKey: queryKeys.nodes.detail(nodeId ?? ''),
    queryFn: () => api.get<Node>(`/nodes/${nodeId}`),
    enabled: Boolean(nodeId),
  });
}

export function useNodeCapacity(
  nodeId: string | undefined,
  options: { refetchInterval?: number | false } = {},
): UseQueryResult<NodeCapacity> {
  return useQuery({
    queryKey: queryKeys.nodes.capacity(nodeId ?? ''),
    queryFn: () => api.get<NodeCapacity>(`/nodes/${nodeId}/capacity`),
    enabled: Boolean(nodeId),
    refetchInterval: options.refetchInterval ?? 15_000,
  });
}

/** Always resolves — an unreachable node comes back as `{ reachable: false, error }`, not a
 *  thrown error — and it refreshes the node's stored status, so both node queries are
 *  invalidated on success. */
export function useTestNode(nodeId: string): UseMutationResult<TestNodeResult, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<TestNodeResult>(`/nodes/${nodeId}/test`),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.nodes.detail(nodeId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.nodes.capacity(nodeId) });
    },
  });
}

export function useCreateNode(): UseMutationResult<Node, Error, CreateNodeRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateNodeRequest) => api.post<Node>('/nodes', body),
    onSuccess: (node) => queryClient.setQueryData(queryKeys.nodes.detail(node.id), node),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.nodes.all }),
  });
}

export interface UpdateNodeInput {
  nodeId: string;
  patch: UpdateNodeRequest;
}

/** Not optimistic — a node's endpoint or port range is infrastructure, and a bad edit is
 *  exactly the kind of mistake an operator needs the real error for, not a hopeful preview. */
export function useUpdateNode(): UseMutationResult<Node, Error, UpdateNodeInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, patch }: UpdateNodeInput) => api.patch<Node>(`/nodes/${nodeId}`, patch),
    onSuccess: (node) => queryClient.setQueryData(queryKeys.nodes.detail(node.id), node),
    onSettled: (_node, _error, { nodeId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.nodes.detail(nodeId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.nodes.all });
    },
  });
}

/** Refused server-side (`conflict`) while any server still lives on the node. */
export function useDeleteNode(): UseMutationResult<{ ok: true }, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (nodeId: string) => api.delete<{ ok: true }>(`/nodes/${nodeId}`),
    onSuccess: (_result, nodeId) =>
      queryClient.removeQueries({ queryKey: queryKeys.nodes.detail(nodeId) }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.nodes.all }),
  });
}
