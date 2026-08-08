import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { api } from '@/lib/api-client.js';
import type { InstalledMod, ModDetail, ModSource, ModVersion } from './use-mods.js';

/**
 * The mod review queue. `apps/api/src/services/proposals.ts` and `mods/resolve.ts` define
 * these shapes as zod schemas internal to the API package, not `@platter/shared` — see the
 * note at the top of `use-mods.ts` for why they are hand-mirrored here instead of imported.
 *
 * This is the only path from a proposal to an installed file: an agent (or a person) can
 * propose with `ai.use`, but approving requires `files.write`. Nothing here ever calls the
 * install endpoint directly, because there isn't one — see `routes/mods.ts`.
 */

export const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'failed'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export type ResolutionProblemKind =
  | 'no_compatible_version'
  | 'version_conflict'
  | 'incompatible_with_installed'
  | 'incompatible_installed'
  | 'dependency_cycle'
  | 'wrong_loader'
  | 'no_download'
  | 'unknown_game_version'
  | 'prerelease_selected'
  | 'modpack_managed'
  | 'graph_too_large'
  | 'lookup_failed';

export interface ResolutionProblem {
  kind: ResolutionProblemKind;
  severity: 'error' | 'warning';
  source: ModSource | null;
  projectId: string | null;
  title: string;
  message: string;
}

export interface PlannedInstall {
  source: ModSource;
  projectId: string;
  slug: string;
  title: string;
  iconUrl: string | null;
  target: 'mods' | 'plugins';
  version: ModVersion;
  reason: 'requested' | 'dependency' | 'update';
  requiredBy: string[];
  replacesVersionId: string | null;
}

export interface Resolution {
  install: PlannedInstall[];
  satisfied: PlannedInstall[];
  problems: ResolutionProblem[];
  installable: boolean;
}

export interface ProposalChange {
  field: string;
  before: string;
  after: string;
  /** Only `material` changes block an approval. */
  material: boolean;
}

export interface ModProposal {
  id: string;
  serverId: string;
  status: ProposalStatus;
  source: ModSource;
  projectId: string;
  slug: string;
  title: string;
  versionId: string;
  versionNumber: string;
  rationale: string;
  proposedById: string | null;
  proposedByName: string | null;
  proposedAt: string;
  reviewedById: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  snapshot: { detail: ModDetail; version: ModVersion; resolution: Resolution; digest: string };
  driftDetectedAt: string | null;
  installedVersionId: string | null;
  error: string | null;
}

export interface ApprovalOutcome {
  status: 'installed' | 'changed' | 'blocked';
  proposal: ModProposal;
  installed: InstalledMod[];
  resolution: Resolution;
  changes: ProposalChange[];
  digest: string;
}

const proposalsKeys = {
  all: (serverId: string) => ['servers', serverId, 'proposals'] as const,
  list: (serverId: string, status?: ProposalStatus) =>
    ['servers', serverId, 'proposals', 'list', status ?? null] as const,
  detail: (serverId: string, id: string) => ['servers', serverId, 'proposals', id] as const,
};

export function useProposals(
  serverId: string,
  status?: ProposalStatus,
): UseQueryResult<{ data: ModProposal[] }> {
  return useQuery({
    queryKey: proposalsKeys.list(serverId, status),
    queryFn: () => api.get<{ data: ModProposal[] }>(`/servers/${serverId}/proposals`, { query: { status } }),
  });
}

export function useProposal(serverId: string, id: string | undefined): UseQueryResult<ModProposal> {
  return useQuery({
    queryKey: proposalsKeys.detail(serverId, id ?? ''),
    queryFn: () => api.get<ModProposal>(`/servers/${serverId}/proposals/${id}`),
    enabled: Boolean(id),
  });
}

export interface CreateProposalInput {
  source: ModSource;
  project: string;
  /** Omit to let Platter pick the newest version this server can load. */
  version?: string | null;
  rationale: string;
}

export function useCreateProposal(serverId: string): UseMutationResult<ModProposal, Error, CreateProposalInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProposalInput) => api.post<ModProposal>(`/servers/${serverId}/proposals`, body),
    onSuccess: (proposal) => {
      queryClient.setQueryData(proposalsKeys.detail(serverId, proposal.id), proposal);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: proposalsKeys.all(serverId) }),
  });
}

export interface ApproveProposalInput {
  proposalId: string;
  /**
   * The digest the reviewer was just shown, confirming "I read the new diff" after a
   * `changed` outcome. Explicitly `null` on a first attempt — the API's schema is
   * `nullish`, and sending the key with `null` says "acknowledging nothing" out loud
   * rather than leaving the server to infer it from an absent field.
   */
  acknowledgedDigest: string | null;
}

/**
 * Approving installs executable code onto the server's disk — never optimistic.
 *
 * All three outcomes share one body shape (see `routes/proposals.ts`): `installed` is 200,
 * while `changed` and `blocked` are 409 carrying the diff and the new digest. That 409 body
 * is the whole feature — it is what the reviewer reads before approving again, and passing
 * its `digest` back as `acknowledgedDigest` is how they say "I read the diff". So 409 is
 * declared expected and the outcome is switched on `status`, never on the HTTP code.
 */
export function useApproveProposal(
  serverId: string,
): UseMutationResult<ApprovalOutcome, Error, ApproveProposalInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ proposalId, acknowledgedDigest }: ApproveProposalInput) =>
      api.post<ApprovalOutcome>(
        `/servers/${serverId}/proposals/${proposalId}/approve`,
        { acknowledgedDigest },
        { expect: [409] },
      ),
    onSuccess: (outcome) => {
      queryClient.setQueryData(proposalsKeys.detail(serverId, outcome.proposal.id), outcome.proposal);
      if (outcome.status === 'installed') {
        void queryClient.invalidateQueries({ queryKey: ['servers', serverId, 'mods', 'installed'] });
      }
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: proposalsKeys.all(serverId) }),
  });
}

export interface RejectProposalInput {
  proposalId: string;
  note?: string;
}

export function useRejectProposal(serverId: string): UseMutationResult<ModProposal, Error, RejectProposalInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ proposalId, note }: RejectProposalInput) =>
      api.post<ModProposal>(`/servers/${serverId}/proposals/${proposalId}/reject`, { note }),
    onSuccess: (proposal) => queryClient.setQueryData(proposalsKeys.detail(serverId, proposal.id), proposal),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: proposalsKeys.all(serverId) }),
  });
}
