import { createHash } from 'node:crypto';
import type { Server as ServerRecord } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { monotonicFactory } from 'ulid';
import { z } from 'zod';
import { PlatterError } from '@platter/shared';
import { prisma } from '../db.js';
import { conflict, notFound } from '../lib/errors.js';
import {
  invalidateModCaches,
  modDetailSchema,
  modSourceSchema,
  modVersionSchema,
  type ModDetail,
  type ModSource,
  type ModVersion,
} from '../mods/registry.js';
import { resolutionSchema, type InstalledMod, type Resolution } from '../mods/resolve.js';
import { recordAudit } from './audit.js';
import { applyResolution, planModInstall } from './mods.js';

/**
 * The human-approval gate.
 *
 * This is the property the whole agent story rests on: **an agent can propose a mod, it cannot
 * install one.** `propose` writes a record and nothing else. Installation is reachable only
 * through `approve`, which requires a reviewer, and `services/mods.ts#applyResolution` is the
 * single call that touches the disk. See docs/ARCHITECTURE.md §4.
 *
 * Two rules make the gate mean something rather than merely exist:
 *
 * 1. **A proposal snapshots what the reviewer will be shown.** The full project detail, the
 *    chosen version and the resolved dependency plan are stored at proposal time. If the
 *    approval screen re-fetched from upstream, an attacker who could influence the registry
 *    between proposal and approval would decide what the human reads.
 * 2. **Approval re-reads live state and refuses to install anything that has moved.** The
 *    snapshot is what was *shown*; it is not what gets installed. Approval fetches the project
 *    and version again with the cache bypassed, diffs the fields that decide what code runs —
 *    checksums, download URL, filename, dependency set, loaders, game versions — and, if any
 *    of them changed, returns the diff instead of installing. The reviewer has to approve
 *    again against the new digest, which is the only way they can consent to the new bytes.
 *
 * A proposal record is also its own audit trail. The shared `AUDIT_ACTIONS` vocabulary has no
 * verb for proposing or rejecting a mod, and borrowing one would put a false sentence in the
 * activity feed (`describeAudit` renders `ai.provision_proposed` as "asked the assistant to
 * design a server"). So the record carries proposer and reviewer by id *and* by display name,
 * with timestamps, and only the two transitions that have honest verbs — the install itself
 * and the applied suggestion — reach `AuditLog`.
 */

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Proposals live in the `Setting` key/value table.
 *
 * `prisma/schema.prisma` has no `ModProposal` model and is owned elsewhere, so this is the
 * only durable store available. The key embeds the server id — `mods.proposal.<serverId>.<id>`
 * — which turns "list this server's proposals" into an indexed prefix scan on the primary key
 * rather than a full-table read. The cost of the workaround is that the rows do not cascade
 * when a server is deleted, which is what `purgeServerProposals` is for.
 */
const KEY_PREFIX = 'mods.proposal.';

function serverPrefix(serverId: string): string {
  return `${KEY_PREFIX}${serverId}.`;
}

function proposalKey(serverId: string, id: string): string {
  return `${serverPrefix(serverId)}${id}`;
}

/** `lib/ids.ts` has no prefix for proposals and is owned elsewhere; the shape still matches. */
const nextUlid = monotonicFactory();

function newProposalId(): string {
  return `mpr_${nextUlid()}`;
}

/** Enough history to review; bounded because a daemon that runs for months must be. */
const MAX_PROPOSALS_PER_SERVER = 200;

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'failed'] as const;
export const proposalStatusSchema = z.enum(PROPOSAL_STATUSES);
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const proposalChangeSchema = z.object({
  field: z.string(),
  before: z.string(),
  after: z.string(),
  /**
   * `true` when the change alters what code would be executed or where it comes from. Only
   * material changes block an approval; a download counter ticking up does not.
   */
  material: z.boolean(),
});
export type ProposalChange = z.infer<typeof proposalChangeSchema>;

export const modProposalSchema = z.object({
  id: z.string(),
  serverId: z.string(),
  status: proposalStatusSchema,
  source: modSourceSchema,
  projectId: z.string(),
  slug: z.string(),
  title: z.string(),
  versionId: z.string(),
  versionNumber: z.string(),
  /** Why the proposer thinks this belongs on this server. Shown first on the review screen. */
  rationale: z.string(),
  proposedById: z.string().nullable().default(null),
  proposedByName: z.string().nullable().default(null),
  proposedAt: z.string(),
  reviewedById: z.string().nullable().default(null),
  reviewedByName: z.string().nullable().default(null),
  reviewedAt: z.string().nullable().default(null),
  reviewNote: z.string().nullable().default(null),
  /** Exactly what the reviewer is shown, frozen at proposal time. */
  snapshot: z.object({
    detail: modDetailSchema,
    version: modVersionSchema,
    resolution: resolutionSchema,
    /** Digest over the fields that decide what runs. Approval compares against a live one. */
    digest: z.string(),
  }),
  /** Set the first time an approval attempt saw upstream differ from the snapshot. */
  driftDetectedAt: z.string().nullable().default(null),
  installedVersionId: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});
export type ModProposal = z.infer<typeof modProposalSchema>;

// ---------------------------------------------------------------------------
// Material digest
// ---------------------------------------------------------------------------

/**
 * The fields that decide what code the server will execute, and where it came from.
 *
 * Kept deliberately narrow and explicit. A wider net (download counts, descriptions) would
 * make the drift check fire constantly and train reviewers to click through it, which is
 * exactly how a security gate stops working.
 */
interface MaterialFacts {
  projectId: string;
  slug: string;
  title: string;
  serverSide: string;
  license: string;
  versionId: string;
  versionNumber: string;
  filename: string;
  url: string;
  sizeBytes: number;
  sha512: string;
  sha1: string;
  loaders: string[];
  gameVersions: string[];
  /** Required dependencies only; optional ones are never installed, so they cannot surprise. */
  requires: string[];
}

function materialFacts(detail: ModDetail, version: ModVersion): MaterialFacts {
  return {
    projectId: detail.projectId,
    slug: detail.slug,
    title: detail.title,
    serverSide: detail.serverSide,
    license: detail.license ?? '',
    versionId: version.versionId,
    versionNumber: version.versionNumber,
    filename: version.file.filename,
    url: version.file.url,
    sizeBytes: version.file.sizeBytes,
    sha512: version.file.sha512 ?? '',
    sha1: version.file.sha1 ?? '',
    loaders: [...version.loaders].sort(),
    gameVersions: [...version.gameVersions].sort(),
    requires: version.dependencies
      .filter((dependency) => dependency.kind === 'required')
      .map(
        (dependency) =>
          `${dependency.source}:${dependency.projectId ?? '?'}@${dependency.versionId ?? '*'}`,
      )
      .sort(),
  };
}

/** Stable because the key order is the interface's, not an object literal's iteration order. */
export function materialDigest(detail: ModDetail, version: ModVersion): string {
  const facts = materialFacts(detail, version);
  const canonical = JSON.stringify(
    Object.keys(facts)
      .sort()
      .map((key) => [key, facts[key as keyof MaterialFacts]]),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

function describe(value: unknown): string {
  return Array.isArray(value) ? value.join(', ') : String(value);
}

function diffMaterial(before: MaterialFacts, after: MaterialFacts): ProposalChange[] {
  const changes: ProposalChange[] = [];
  for (const key of Object.keys(before) as Array<keyof MaterialFacts>) {
    const left = describe(before[key]);
    const right = describe(after[key]);
    if (left !== right) changes.push({ field: key, before: left, after: right, material: true });
  }
  return changes;
}

/**
 * Body changes are reported but do not block.
 *
 * A rewritten description is worth a reviewer's attention — it is what a takeover looks like
 * from the outside — but it changes nothing about the bytes that will be executed, and the
 * bodies are long enough that diffing them inline would drown the material changes.
 */
function diffPresentation(before: ModDetail, after: ModDetail): ProposalChange[] {
  const changes: ProposalChange[] = [];
  if (before.summary !== after.summary) {
    changes.push({
      field: 'summary',
      before: before.summary,
      after: after.summary,
      material: false,
    });
  }
  if (before.description !== after.description) {
    changes.push({
      field: 'description',
      before: `${before.description.length} characters`,
      after: `${after.description.length} characters`,
      material: false,
    });
  }
  if (before.author !== after.author) {
    changes.push({
      field: 'author',
      before: before.author ?? 'unknown',
      after: after.author ?? 'unknown',
      material: false,
    });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function parseRow(value: string, log?: FastifyBaseLogger): ModProposal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const result = modProposalSchema.safeParse(parsed);
  if (result.success) return result.data;
  // A row this build cannot represent is skipped rather than rendered wrong — the same rule
  // `services/audit.ts` applies to an action it does not recognise.
  log?.warn('a stored mod proposal could not be parsed');
  return null;
}

export async function listProposals(
  serverId: string,
  status?: ProposalStatus,
  log?: FastifyBaseLogger,
): Promise<ModProposal[]> {
  const rows = await prisma.setting.findMany({
    where: { key: { startsWith: serverPrefix(serverId) } },
    take: MAX_PROPOSALS_PER_SERVER,
  });

  const proposals: ModProposal[] = [];
  for (const row of rows) {
    const proposal = parseRow(row.value, log);
    if (proposal && (status === undefined || proposal.status === status)) proposals.push(proposal);
  }
  // Ids are monotonic ULIDs, so this is creation order without a second field to sort on.
  return proposals.sort((left, right) => right.id.localeCompare(left.id));
}

export async function getProposal(
  serverId: string,
  id: string,
  log?: FastifyBaseLogger,
): Promise<ModProposal> {
  const row = await prisma.setting.findUnique({ where: { key: proposalKey(serverId, id) } });
  if (!row) throw notFound('proposal');
  const proposal = parseRow(row.value, log);
  if (!proposal) throw notFound('proposal');
  return proposal;
}

async function save(proposal: ModProposal): Promise<ModProposal> {
  const key = proposalKey(proposal.serverId, proposal.id);
  const value = JSON.stringify(proposal);
  await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  return proposal;
}

/** Called when a server is deleted; the `Setting` table has no cascade to do it for us. */
export async function purgeServerProposals(serverId: string): Promise<number> {
  const result = await prisma.setting.deleteMany({
    where: { key: { startsWith: serverPrefix(serverId) } },
  });
  return result.count;
}

// ---------------------------------------------------------------------------
// Propose
// ---------------------------------------------------------------------------

/**
 * Changelogs are dropped from the dependency plan before it is stored: a resolution may carry
 * sixty versions, each with a 32 KiB changelog, and the reviewer reads the root mod's.
 */
function trimResolution(resolution: Resolution): Resolution {
  const trim = (entry: Resolution['install'][number]): Resolution['install'][number] => ({
    ...entry,
    version: {
      ...entry.version,
      changelog: entry.reason === 'requested' ? entry.version.changelog : null,
    },
  });
  return {
    ...resolution,
    install: resolution.install.map(trim),
    satisfied: resolution.satisfied.map(trim),
  };
}

export interface ProposeInput {
  server: ServerRecord;
  source: ModSource;
  /** Project id or slug. */
  projectRef: string;
  /** Null asks Platter to choose the newest compatible version. */
  versionRef?: string | null;
  rationale: string;
  proposedById: string | null;
  proposedByName: string | null;
  signal?: AbortSignal;
  log?: FastifyBaseLogger;
}

/**
 * Records a proposal. Installs nothing, downloads nothing, and never can.
 *
 * A blocked plan is still stored when the proposer pinned a version: "this needs Fabric and
 * you run Paper" is exactly the answer a reviewer should see. Auto-selection is different — if
 * no version fits there is nothing to show, so `planModInstall` refuses with the constraint
 * that failed rather than filing an empty proposal.
 */
export async function propose(input: ProposeInput): Promise<ModProposal> {
  const { server } = input;

  const plan = await planModInstall(
    server,
    input.source,
    input.projectRef,
    input.versionRef ?? null,
    input.signal,
    input.log,
  );

  const existing = await listProposals(server.id, undefined, input.log);
  const duplicate = existing.find(
    (proposal) =>
      proposal.status === 'pending' &&
      proposal.source === input.source &&
      proposal.projectId === plan.detail.projectId,
  );
  if (duplicate) {
    throw conflict(
      `${plan.detail.title} already has a proposal waiting for review. Review that one first.`,
    );
  }

  await prune(server.id, existing);

  const now = new Date().toISOString();
  return save({
    id: newProposalId(),
    serverId: server.id,
    status: 'pending',
    source: input.source,
    projectId: plan.detail.projectId,
    slug: plan.detail.slug,
    title: plan.detail.title,
    versionId: plan.version.versionId,
    versionNumber: plan.version.versionNumber,
    rationale: input.rationale,
    proposedById: input.proposedById,
    proposedByName: input.proposedByName,
    proposedAt: now,
    reviewedById: null,
    reviewedByName: null,
    reviewedAt: null,
    reviewNote: null,
    snapshot: {
      detail: plan.detail,
      version: plan.version,
      resolution: trimResolution(plan.resolution),
      digest: materialDigest(plan.detail, plan.version),
    },
    driftDetectedAt: null,
    installedVersionId: null,
    error: null,
  });
}

/** Oldest reviewed proposals are dropped first; a pending one is never discarded silently. */
async function prune(serverId: string, existing: readonly ModProposal[]): Promise<void> {
  if (existing.length < MAX_PROPOSALS_PER_SERVER) return;

  const disposable = existing
    .filter((proposal) => proposal.status !== 'pending')
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, existing.length - MAX_PROPOSALS_PER_SERVER + 1);

  if (disposable.length === 0) {
    throw conflict(
      `This server already has ${MAX_PROPOSALS_PER_SERVER} proposals awaiting review. Review some before adding more.`,
    );
  }
  await prisma.setting.deleteMany({
    where: { key: { in: disposable.map((proposal) => proposalKey(serverId, proposal.id)) } },
  });
}

// ---------------------------------------------------------------------------
// Approve
// ---------------------------------------------------------------------------

export interface ReviewerContext {
  reviewerId: string | null;
  reviewerName: string | null;
  ip?: string | null;
  userAgent?: string | null;
  log?: FastifyBaseLogger;
}

export interface ApproveOptions extends ReviewerContext {
  /**
   * The digest the reviewer actually saw. A proposal whose upstream has moved can only be
   * approved by passing the *new* digest back, which is the reviewer stating that they read
   * the diff. Without it the approval is refused, not silently retargeted.
   */
  acknowledgedDigest?: string | null;
  signal?: AbortSignal;
}

export type ApprovalOutcome =
  | {
      status: 'installed';
      proposal: ModProposal;
      installed: InstalledMod[];
      resolution: Resolution;
      changes: ProposalChange[];
      digest: string;
    }
  | {
      /** Upstream differs from the snapshot. Nothing was installed. */
      status: 'changed';
      proposal: ModProposal;
      installed: [];
      resolution: Resolution;
      changes: ProposalChange[];
      digest: string;
    }
  | {
      /** The plan no longer resolves against this server. Nothing was installed. */
      status: 'blocked';
      proposal: ModProposal;
      installed: [];
      resolution: Resolution;
      changes: ProposalChange[];
      digest: string;
    };

/**
 * Approves a proposal, re-resolving against current state first.
 *
 * The order matters and is the whole point:
 *
 * 1. drop the provider cache, so step 2 cannot be served a copy of the snapshot;
 * 2. re-read the project and the version from the source;
 * 3. diff them against the snapshot the reviewer was shown;
 * 4. re-resolve dependencies against the server *as it is now* — mods may have been installed
 *    or removed since the proposal was raised;
 * 5. only then install.
 *
 * Any material difference at step 3, or any error-severity problem at step 4, stops the flow
 * and returns what changed. Nothing is installed on a "changed" or "blocked" outcome.
 */
export async function approve(
  server: ServerRecord,
  id: string,
  options: ApproveOptions,
): Promise<ApprovalOutcome> {
  const proposal = await getProposal(server.id, id, options.log);
  if (proposal.status !== 'pending') {
    throw new PlatterError('invalid_state', `That proposal was already ${proposal.status}.`);
  }

  invalidateModCaches(proposal.source);

  const plan = await planModInstall(
    server,
    proposal.source,
    proposal.projectId,
    proposal.versionId,
    options.signal,
    options.log,
  );

  const changes = [
    ...diffMaterial(
      materialFacts(proposal.snapshot.detail, proposal.snapshot.version),
      materialFacts(plan.detail, plan.version),
    ),
    ...diffPresentation(proposal.snapshot.detail, plan.detail),
  ];
  const digest = materialDigest(plan.detail, plan.version);
  const drifted = digest !== proposal.snapshot.digest;

  if (drifted && options.acknowledgedDigest !== digest) {
    const flagged = await save({
      ...proposal,
      driftDetectedAt: proposal.driftDetectedAt ?? new Date().toISOString(),
    });
    return {
      status: 'changed',
      proposal: flagged,
      installed: [],
      resolution: plan.resolution,
      changes,
      digest,
    };
  }

  if (!plan.resolution.installable) {
    return {
      status: 'blocked',
      proposal,
      installed: [],
      resolution: plan.resolution,
      changes,
      digest,
    };
  }

  let installed: InstalledMod[];
  try {
    installed = await applyResolution(server, plan.resolution, {
      actorId: options.reviewerId,
      actorName: options.reviewerName,
      proposalId: proposal.id,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    // The failure is recorded on the proposal so a reviewer sees why, rather than finding a
    // proposal that is still pending with no explanation. A *retryable* failure — the CDN was
    // down, the node was busy — leaves it pending, because burning a proposal over a network
    // blip would force the whole review round again.
    const retryable = error instanceof PlatterError && error.retryable;
    await save({
      ...proposal,
      status: retryable ? 'pending' : 'failed',
      ...(retryable
        ? {}
        : {
            reviewedById: options.reviewerId,
            reviewedByName: options.reviewerName,
            reviewedAt: new Date().toISOString(),
          }),
      error: error instanceof PlatterError ? error.message : 'The install failed.',
    });
    throw error;
  }

  const approved = await save({
    ...proposal,
    status: 'approved',
    reviewedById: options.reviewerId,
    reviewedByName: options.reviewerName,
    reviewedAt: new Date().toISOString(),
    installedVersionId: plan.version.versionId,
    error: null,
  });

  await recordAudit({
    // The closest true verb the shared vocabulary offers: a human applied a change that the
    // AI layer proposed. There is no `mod.*` action to use instead.
    action: 'ai.fix_applied',
    targetType: 'server',
    targetId: server.id,
    targetName: server.name,
    actorId: options.reviewerId,
    actorName: options.reviewerName,
    metadata: {
      kind: 'mod_proposal',
      proposalId: proposal.id,
      source: proposal.source,
      projectId: proposal.projectId,
      mod: proposal.title,
      version: plan.version.versionNumber,
      dependencies: installed.length - 1,
      acknowledgedDrift: drifted,
    },
    ip: options.ip ?? null,
    userAgent: options.userAgent ?? null,
    ...(options.log ? { logger: options.log } : {}),
  });

  for (const record of installed) {
    await recordAudit({
      action: 'file.written',
      targetType: 'server',
      targetId: server.id,
      targetName: server.name,
      actorId: options.reviewerId,
      actorName: options.reviewerName,
      metadata: {
        kind: 'mod',
        path: `${record.target}/${record.filename}`,
        source: record.source,
        projectId: record.projectId,
        versionId: record.versionId,
        sha512: record.sha512,
        proposalId: proposal.id,
      },
      ip: options.ip ?? null,
      userAgent: options.userAgent ?? null,
      ...(options.log ? { logger: options.log } : {}),
    });
  }

  return {
    status: 'installed',
    proposal: approved,
    installed,
    resolution: plan.resolution,
    changes,
    digest,
  };
}

// ---------------------------------------------------------------------------
// Reject
// ---------------------------------------------------------------------------

const MAX_REVIEW_NOTE = 1000;

export async function reject(
  server: ServerRecord,
  id: string,
  note: string | null,
  options: ReviewerContext,
): Promise<ModProposal> {
  const proposal = await getProposal(server.id, id, options.log);
  if (proposal.status !== 'pending') {
    throw new PlatterError('invalid_state', `That proposal was already ${proposal.status}.`);
  }

  return save({
    ...proposal,
    status: 'rejected',
    reviewedById: options.reviewerId,
    reviewedByName: options.reviewerName,
    reviewedAt: new Date().toISOString(),
    reviewNote: note === null ? null : note.slice(0, MAX_REVIEW_NOTE),
  });
}
