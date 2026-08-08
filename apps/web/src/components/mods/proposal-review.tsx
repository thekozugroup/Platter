import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { formatBytes, formatRelativeTime } from '@platter/shared';
import { Robot } from 'pixelarticons/react/Robot.js';
import { Shield } from 'pixelarticons/react/Shield.js';
import { WarningDiamond } from 'pixelarticons/react/WarningDiamond.js';
import { ModDetailBody } from '@/components/mods/mod-detail-sheet';
import { ModIcon, modSurface } from '@/components/mods/mod-card';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorState } from '@/components/common/error-state';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import type {
  ApprovalOutcome,
  ModProposal,
  PlannedInstall,
  ProposalChange,
  Resolution,
  ResolutionProblem,
} from '@/hooks';
import {
  useApproveProposal,
  useCreateProposal,
  useProposals,
  useRejectProposal,
} from '@/hooks';
import { errorMessage } from '@/lib/api-client.js';
import { cn } from '@/lib/utils';

/**
 * The human-approval gate for a mod an agent suggested.
 *
 * Everything here serves one property: **a person decides, on complete information, and knows
 * that nothing has happened yet.** That shapes three decisions worth defending.
 *
 * 1. **The whole mod, not a summary.** The panel renders `ModDetailBody` — the same component
 *    the browser's detail sheet uses — against the *snapshot* stored on the proposal. A
 *    reviewer who has to open Modrinth to judge whether a project is real is a reviewer who
 *    will stop bothering, and that is how a security gate quietly stops working.
 *
 * 2. **Drift is the headline, not a footnote.** Approval re-reads the registry and refuses to
 *    install anything whose checksum, download URL, filename, dependency set, loaders or game
 *    versions have moved since the proposal was raised (`services/proposals.ts`). Approving
 *    something different from what was reviewed is the exact failure this feature exists to
 *    prevent, so a `changed` outcome takes over the top of the panel and the field-level diff
 *    is spelled out before a second approval is offered.
 *
 * 3. **No primary action.** Approve and Reject are the same size, the same weight, and neither
 *    is focused first. The rest of the product has one near-black primary per view; this screen
 *    deliberately has none, because the interface has no opinion about which way this should go.
 */

// ---------------------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------------------

/** The pending review queue for one server. Cheap enough to sit in the header. */
export function usePendingProposals(serverId: string): ModProposal[] {
  const query = useProposals(serverId, 'pending');
  return query.data?.data ?? [];
}

export interface PendingProposalsBadgeProps {
  serverId: string;
  className?: string;
}

/**
 * A count of what is waiting, linking to the queue.
 *
 * Exported for the server header (`pages/server/ServerLayout.tsx`) so a proposal is visible
 * from every tab rather than only from the one screen that lists them. It renders nothing when
 * the queue is empty, so it is safe to mount unconditionally.
 */
export function PendingProposalsBadge({ serverId, className }: PendingProposalsBadgeProps) {
  const pending = usePendingProposals(serverId);
  if (pending.length === 0) return null;

  return (
    <Link
      className={cn(
        'inline-flex h-11 items-center gap-2 rounded-pill border border-warning/25 bg-warning-subtle px-3',
        'text-caption font-medium text-warning transition-colors duration-150 ease-standard',
        'hover:bg-warning/15',
        className,
      )}
      to={`/servers/${serverId}/mods`}
    >
      <Shield aria-hidden className="size-3.5" />
      {pending.length} {pending.length === 1 ? 'mod waits' : 'mods wait'} for review
    </Link>
  );
}

// ---------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------

const REASON_LABEL: Record<PlannedInstall['reason'], string> = {
  requested: 'The proposed mod',
  dependency: 'Pulled in as a dependency',
  update: 'Replaces the installed version',
};

/**
 * Project ids, resolved to the names on the cards above them.
 *
 * `requiredBy` carries registry ids (`resolve.ts` fills it from the graph's keys), so an
 * unresolved list reads "Required by AAAA1111" — or, against real Modrinth data, "Required by
 * P7dR8mSH". Every id in it is also a node in this same resolution, which means the plan the
 * reviewer is looking at already contains the title for each one.
 */
function titleIndex(resolution: Resolution): Map<string, string> {
  const index = new Map<string, string>();
  for (const entry of [...resolution.install, ...resolution.satisfied]) {
    index.set(entry.projectId, entry.title);
    index.set(`${entry.source}:${entry.projectId}`, entry.title);
  }
  return index;
}

function PlannedRow({ entry, names }: { entry: PlannedInstall; names: Map<string, string> }) {
  return (
    <li className="flex items-start gap-3 border-t border-separator py-3 first:border-t-0 first:pt-0">
      <ModIcon iconUrl={entry.iconUrl} size="sm" title={entry.title} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-sans text-subhead font-semibold text-label">{entry.title}</span>
          <code className="font-mono text-caption text-label-secondary">
            {entry.version.versionNumber}
          </code>
          <span className="text-caption text-label-tertiary">{REASON_LABEL[entry.reason]}</span>
        </p>
        <p className="mt-0.5 text-caption text-label-secondary">
          Written to{' '}
          <code className="font-mono text-label">
            {entry.target}/{entry.version.file.filename}
          </code>
          <span aria-hidden> · </span>
          <span className="tabular">{formatBytes(entry.version.file.sizeBytes)}</span>
        </p>
        {entry.requiredBy.length > 0 ? (
          <p className="mt-0.5 text-caption text-label-tertiary">
            Required by {entry.requiredBy.map((id) => names.get(id) ?? id).join(', ')}
          </p>
        ) : null}
        {entry.replacesVersionId !== null ? (
          <p className="mt-0.5 text-caption text-label-tertiary">
            Replaces the jar currently on disk.
          </p>
        ) : null}
      </div>
    </li>
  );
}

function ProblemList({ problems }: { problems: readonly ResolutionProblem[] }) {
  if (problems.length === 0) return null;

  return (
    <ul className="flex flex-col gap-2">
      {problems.map((problem, index) => (
        <li
          className={cn(
            'rounded-sm border px-3 py-2 text-caption',
            problem.severity === 'error'
              ? 'border-danger/25 bg-danger-subtle text-danger'
              : 'border-warning/25 bg-warning-subtle text-warning',
          )}
          key={`${problem.kind}-${problem.projectId ?? index}`}
        >
          <span className="font-medium">
            {problem.severity === 'error' ? 'Blocks the install' : 'Worth knowing'} —{' '}
            {problem.title}.
          </span>{' '}
          {problem.message}
        </li>
      ))}
    </ul>
  );
}

/** Exactly what pressing Approve writes to disk. Nothing here has happened yet. */
function PlannedChanges({ resolution }: { resolution: Resolution }) {
  const names = titleIndex(resolution);

  return (
    <section className="flex flex-col gap-3">
      <h4 className="font-sans text-subhead font-semibold text-label">
        What approving would install
      </h4>

      {resolution.install.length === 0 ? (
        <p className="text-subhead text-label-tertiary">
          Nothing would be written — every file this plan needs is already on disk.
        </p>
      ) : (
        <ul className={cn(modSurface, 'flex flex-col px-4 py-3')}>
          {resolution.install.map((entry) => (
            <PlannedRow entry={entry} key={`${entry.source}:${entry.projectId}`} names={names} />
          ))}
        </ul>
      )}

      {resolution.satisfied.length > 0 ? (
        <p className="text-caption text-label-tertiary">
          Already at the resolved version, so untouched:{' '}
          {resolution.satisfied.map((entry) => entry.title).join(', ')}.
        </p>
      ) : null}

      <ProblemList problems={resolution.problems} />
    </section>
  );
}

/** Registry field names, in the words a reviewer thinks in. */
const CHANGE_FIELD_LABEL: Record<string, string> = {
  projectId: 'Project id',
  slug: 'Slug',
  title: 'Name',
  serverSide: 'Server-side support',
  license: 'Licence',
  versionId: 'Version id',
  versionNumber: 'Version number',
  filename: 'File name',
  url: 'Download URL',
  sizeBytes: 'File size',
  sha512: 'SHA-512 checksum',
  sha1: 'SHA-1 checksum',
  loaders: 'Loaders',
  gameVersions: 'Minecraft versions',
  requires: 'Required dependencies',
  summary: 'Summary',
  description: 'Description',
  author: 'Author',
};

function ChangeTable({ changes }: { changes: readonly ProposalChange[] }) {
  if (changes.length === 0) return null;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-lg border-collapse text-caption">
        <caption className="sr-only">
          Fields that differ between the reviewed snapshot and the registry now
        </caption>
        <thead>
          <tr className="border-b border-separator-strong text-start">
            <th className="py-2 pe-3 text-start font-medium text-label-tertiary" scope="col">
              Field
            </th>
            <th className="py-2 pe-3 text-start font-medium text-label-tertiary" scope="col">
              You reviewed
            </th>
            <th className="py-2 text-start font-medium text-label-tertiary" scope="col">
              It is now
            </th>
          </tr>
        </thead>
        <tbody>
          {changes.map((change) => (
            <tr className="border-b border-separator align-top" key={change.field}>
              <th className="py-2 pe-3 text-start font-medium text-label" scope="row">
                {CHANGE_FIELD_LABEL[change.field] ?? change.field}
                {change.material ? null : (
                  <span className="block font-normal text-caption-2 text-label-tertiary">
                    Does not change what runs
                  </span>
                )}
              </th>
              <td className="py-2 pe-3">
                <code className="break-all font-mono text-caption text-label-secondary">
                  {change.before || '—'}
                </code>
              </td>
              <td className="py-2">
                <code
                  className={cn(
                    'break-all font-mono text-caption',
                    change.material ? 'text-danger' : 'text-label-secondary',
                  )}
                >
                  {change.after || '—'}
                </code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------------------

const MAX_NOTE = 1000;

export interface ProposalReviewProps {
  serverId: string;
  proposal: ModProposal;
  /** Called after a decision lands, so a list can move on to the next proposal. */
  onReviewed?: (proposal: ModProposal) => void;
  className?: string;
}

export function ProposalReview({
  serverId,
  proposal,
  onReviewed,
  className,
}: ProposalReviewProps) {
  const [confirming, setConfirming] = useState<'approve' | 'reject' | null>(null);
  const [note, setNote] = useState('');
  const [outcome, setOutcome] = useState<ApprovalOutcome | null>(null);

  /*
   * `useApproveProposal` declares 409 an expected status, so the `changed` and `blocked`
   * outcomes arrive here as ordinary results carrying the diff and the new digest — which
   * is what this screen exists to show. Only a real failure lands in `error`.
   */
  const approve = useApproveProposal(serverId);
  const submitApproval = (acknowledgedDigest: string | null) =>
    approve.mutate(
      { proposalId: proposal.id, acknowledgedDigest, title: proposal.title },
      {
        onSuccess: (result) => {
          setOutcome(result);
          setConfirming(null);
          if (result.status === 'installed') onReviewed?.(result.proposal);
        },
      },
    );

  const reject = useRejectProposal(serverId);
  const repropose = useCreateProposal(serverId);

  // The live re-resolution wins over the snapshot once an attempt has been made: after a
  // `blocked` or `changed` answer, the stored plan is no longer what would happen.
  const resolution = outcome?.resolution ?? proposal.snapshot.resolution;
  const drifted = outcome?.status === 'changed';
  const driftSuspected = proposal.driftDetectedAt !== null && outcome === null;
  const materialChanges = useMemo(
    () => (outcome?.changes ?? []).filter((change) => change.material),
    [outcome],
  );

  const decided = proposal.status !== 'pending' || outcome?.status === 'installed';
  const blockedReason = resolution.installable
    ? null
    : 'The plan does not resolve against this server as it is now. The problems above have to be fixed first.';
  const busy = approve.isPending || reject.isPending;

  return (
    <article className={cn('flex flex-col gap-6', className)}>
      <Standing
        installed={outcome?.status === 'installed' ? outcome : null}
        proposal={proposal}
      />

      {drifted && outcome ? (
        <DriftPanel
          changes={outcome.changes}
          materialCount={materialChanges.length}
          onAcknowledge={() => submitApproval(outcome.digest)}
          pending={approve.isPending}
        />
      ) : null}

      {/*
        A *retryable* install failure leaves the proposal pending with the reason recorded on
        it (`services/proposals.ts`), so without this the second visit to this screen shows a
        proposal that looks untouched and gives no hint that a download already fell over.
      */}
      {proposal.status === 'pending' && proposal.error !== null && outcome === null ? (
        <Alert variant="destructive">
          <AlertTitle className="font-sans">The last attempt did not finish</AlertTitle>
          <AlertDescription>
            {proposal.error} Nothing was installed and this proposal is still open, so approving
            tries again.
          </AlertDescription>
        </Alert>
      ) : null}

      {driftSuspected ? (
        <Alert variant="warning">
          <WarningDiamond aria-hidden />
          <AlertTitle className="font-sans">
            This listing changed once since it was proposed
          </AlertTitle>
          <AlertDescription>
            An earlier approval attempt found the registry no longer matched the snapshot below,
            and stopped. Approving re-checks it and will show you the difference before anything
            is downloaded.
          </AlertDescription>
        </Alert>
      ) : null}

      {outcome?.status === 'blocked' ? (
        <Alert variant="destructive">
          <AlertTitle className="font-sans">Nothing was installed</AlertTitle>
          <AlertDescription>
            The plan no longer resolves against this server. Every problem is listed under
            “What approving would install”.
          </AlertDescription>
        </Alert>
      ) : null}

      <Proposer proposal={proposal} />

      <PlannedChanges resolution={resolution} />

      <section className="flex flex-col gap-3 border-t border-separator pt-5">
        <h4 className="font-sans text-subhead font-semibold text-label">
          The mod, as it was when this was proposed
        </h4>
        <ModDetailBody
          capturedAt={proposal.proposedAt}
          highlightVersionId={proposal.snapshot.version.versionId}
          mod={proposal.snapshot.detail}
          versions={[proposal.snapshot.version]}
        />
      </section>

      {decided ? null : (
        <Decision
          blockedReason={blockedReason}
          busy={busy}
          onApprove={() => setConfirming('approve')}
          onReject={() => setConfirming('reject')}
        />
      )}

      {/*
        A failed proposal is terminal — the API refuses to approve or reject one — so the only
        way forward is a fresh proposal. Offering it here means the error names a next step
        instead of leaving a dead card on the screen.
      */}
      {proposal.status === 'failed' ? (
        <div className="flex flex-col gap-2 border-t border-separator pt-5">
          <Button
            className="h-11 w-fit rounded-button px-5 text-subhead font-medium"
            isLoading={repropose.isPending}
            onClick={() =>
              repropose.mutate({
                source: proposal.source,
                project: proposal.slug,
                rationale: proposal.rationale,
              })
            }
            variant="outline"
          >
            Propose it again
          </Button>
          <p className="text-caption text-label-tertiary">
            Puts a fresh proposal in the queue for the newest version this server can load, with
            the same reason attached. It installs nothing on its own.
          </p>
        </div>
      ) : null}

      <p aria-live="polite" className="text-caption text-danger" role="status">
        {approve.isError ? errorMessage(approve.error) : null}
        {reject.isError ? errorMessage(reject.error) : null}
        {repropose.isError ? errorMessage(repropose.error) : null}
      </p>

      {/* Approve: the last chance to read what will be written, restated in one place. */}
      <AlertDialog
        onOpenChange={(details) => {
          if (!details.open) setConfirming(null);
        }}
        open={confirming === 'approve'}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-sans text-title-3 font-semibold">
              Install {proposal.title} {proposal.versionNumber}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This downloads and writes executable code to the server.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogBody>
            <ul className="flex flex-col gap-2">
              {resolution.install.map((entry) => (
                <li className="text-subhead text-label-secondary" key={entry.projectId}>
                  <code className="font-mono text-label">
                    {entry.target}/{entry.version.file.filename}
                  </code>{' '}
                  <span className="tabular">({formatBytes(entry.version.file.sizeBytes)})</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-caption text-label-tertiary">
              Platter re-reads the registry first and refuses to install anything that has
              changed since you reviewed it. The server picks the mod up on its next restart.
            </p>
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11 rounded-button px-5 text-subhead font-medium">
              Go back
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-11 rounded-button px-5 text-subhead font-medium"
              isLoading={approve.isPending}
              onClick={() => submitApproval(null)}
            >
              Approve and install
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reject: the note is optional and is the only field. */}
      <AlertDialog
        onOpenChange={(details) => {
          if (!details.open) setConfirming(null);
        }}
        open={confirming === 'reject'}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-sans text-title-3 font-semibold">
              Reject {proposal.title}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Nothing is installed and nothing is deleted. The proposal closes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogBody>
            <Field>
              <FieldLabel>Note (optional)</FieldLabel>
              <Textarea
                maxLength={MAX_NOTE}
                name="note"
                onChange={(event) => setNote(event.target.value)}
                placeholder="Why not, so the same thing is not proposed again."
                rows={3}
                value={note}
              />
              <FieldDescription>
                Stored on the proposal and readable by whoever raised it.
              </FieldDescription>
            </Field>
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11 rounded-button px-5 text-subhead font-medium">
              Go back
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-11 rounded-button px-5 text-subhead font-medium"
              isLoading={reject.isPending}
              onClick={() =>
                reject.mutate(
                  {
                    proposalId: proposal.id,
                    ...(note.trim() === '' ? {} : { note: note.trim() }),
                  },
                  {
                    onSuccess: (updated) => {
                      setConfirming(null);
                      onReviewed?.(updated);
                    },
                  },
                )
              }
              variant="destructive"
            >
              Reject proposal
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </article>
  );
}

// ---------------------------------------------------------------------------------------

/**
 * The standing statement at the top of the panel.
 *
 * While a proposal is pending this says, unambiguously and before anything else, that nothing
 * has been installed. Every other state replaces it with what actually happened.
 */
function Standing({
  proposal,
  installed,
}: {
  proposal: ModProposal;
  installed: ApprovalOutcome | null;
}) {
  if (installed) {
    return (
      <Alert variant="success">
        <AlertTitle className="font-sans">Installed</AlertTitle>
        <AlertDescription>
          {installed.installed.length === 1
            ? '1 file was'
            : `${installed.installed.length} files were`}{' '}
          written:{' '}
          {installed.installed
            .map((record) => `${record.target}/${record.filename}`)
            .join(', ')}
          . Restart the server to load it.
        </AlertDescription>
      </Alert>
    );
  }

  if (proposal.status === 'approved') {
    return (
      <Alert variant="success">
        <AlertTitle className="font-sans">Approved</AlertTitle>
        <AlertDescription>
          {proposal.reviewedByName ?? 'A reviewer'} approved this{' '}
          {proposal.reviewedAt === null ? '' : formatRelativeTime(proposal.reviewedAt)}. The
          files are on disk.
        </AlertDescription>
      </Alert>
    );
  }

  if (proposal.status === 'rejected') {
    return (
      <Alert>
        <AlertTitle className="font-sans">Rejected</AlertTitle>
        <AlertDescription>
          {proposal.reviewedByName ?? 'A reviewer'} rejected this{' '}
          {proposal.reviewedAt === null ? '' : formatRelativeTime(proposal.reviewedAt)}. Nothing
          was installed.
          {proposal.reviewNote === null ? null : (
            <span className="block text-label-secondary">“{proposal.reviewNote}”</span>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  if (proposal.status === 'failed') {
    return (
      <Alert variant="destructive">
        <AlertTitle className="font-sans">The install failed</AlertTitle>
        <AlertDescription>
          {proposal.error ?? 'The download or the write did not complete.'} Nothing usable was
          left on the server, and this proposal cannot be approved again.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="info">
      <Shield aria-hidden />
      <AlertTitle className="font-sans">Nothing has been installed</AlertTitle>
      <AlertDescription>
        This is a suggestion waiting for a person. No file has been downloaded, nothing has been
        written to the server, and the server has not been touched. That only happens when you
        press Approve.
      </AlertDescription>
    </Alert>
  );
}

function Proposer({ proposal }: { proposal: ModProposal }) {
  const name = proposal.proposedByName;

  return (
    <section className="flex flex-col gap-3">
      <h4 className="font-sans text-subhead font-semibold text-label">Who suggested this</h4>
      <div className={cn(modSurface, 'flex items-start gap-3 p-4')}>
        <span
          aria-hidden
          className="flex size-11 shrink-0 items-center justify-center rounded-xs bg-fill-secondary text-label-secondary"
        >
          <Robot className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-subhead font-medium text-label">
            {name ?? 'An API key with the ai.use permission'}
          </p>
          <p className="mt-0.5 text-caption text-label-tertiary">
            {name === null
              ? 'No account is attached — this came from a machine credential over MCP.'
              : 'Proposed over MCP or from this panel.'}
            {' · '}
            <time
              dateTime={proposal.proposedAt}
              title={new Date(proposal.proposedAt).toLocaleString()}
            >
              {formatRelativeTime(proposal.proposedAt)}
            </time>
          </p>
          <blockquote className="mt-3 border-s-2 border-separator-strong ps-3 text-subhead leading-normal text-label-secondary">
            {proposal.rationale}
          </blockquote>
        </div>
      </div>
    </section>
  );
}

function DriftPanel({
  changes,
  materialCount,
  onAcknowledge,
  pending,
}: {
  changes: readonly ProposalChange[];
  materialCount: number;
  onAcknowledge: () => void;
  pending: boolean;
}) {
  return (
    <section
      aria-live="assertive"
      className="flex flex-col gap-4 rounded-md border-2 border-danger/40 bg-danger-subtle p-5"
      role="alert"
    >
      <div className="flex items-start gap-3">
        <WarningDiamond aria-hidden className="mt-0.5 size-5 shrink-0 text-danger" />
        <div className="min-w-0">
          <h4 className="font-sans text-title-3 font-semibold text-danger">
            This is not what you reviewed
          </h4>
          <p className="mt-1 text-subhead leading-normal text-label-secondary">
            {materialCount === 0
              ? 'The listing changed since this proposal was raised. Nothing was installed.'
              : `${materialCount} ${materialCount === 1 ? 'field that decides what code runs has' : 'fields that decide what code runs have'} changed since this proposal was raised. Nothing was installed.`}{' '}
            Read the difference below before deciding again.
          </p>
        </div>
      </div>

      <ChangeTable changes={changes} />

      <div className="flex flex-col gap-2">
        <Button
          className="h-11 self-start rounded-button px-5 text-subhead font-medium"
          isLoading={pending}
          onClick={onAcknowledge}
          variant="destructive"
        >
          I have read the changes — install the new version
        </Button>
        <p className="text-caption text-label-secondary">
          Leaving this page installs nothing. The proposal stays open, and rejecting it is still
          the other option.
        </p>
      </div>
    </section>
  );
}

/**
 * The decision. Two controls, identical in size and weight, neither focused first — the screen
 * has no primary action on purpose.
 */
function Decision({
  onApprove,
  onReject,
  blockedReason,
  busy,
}: {
  onApprove: () => void;
  onReject: () => void;
  blockedReason: string | null;
  busy: boolean;
}) {
  const reasonId = 'proposal-approve-blocked';

  return (
    <div className="flex flex-col gap-2 border-t border-separator pt-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <Button
          {...(blockedReason ? { 'aria-describedby': reasonId } : {})}
          className="h-11 rounded-button px-5 text-subhead font-medium"
          disabled={blockedReason !== null || busy}
          onClick={onApprove}
          variant="outline"
        >
          Approve and install
        </Button>
        <Button
          className="h-11 rounded-button px-5 text-subhead font-medium"
          disabled={busy}
          onClick={onReject}
          variant="outline"
        >
          Reject
        </Button>
      </div>
      {blockedReason ? (
        <p className="text-caption text-label-tertiary" id={reasonId}>
          {blockedReason}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------------------

export interface ProposalQueueProps {
  serverId: string;
  className?: string;
}

/** A failure stops being news eventually; until then it is the loudest thing on this screen. */
const FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FAILED_SHOWN = 3;

function recentFailures(proposals: readonly ModProposal[], now: number): ModProposal[] {
  return proposals
    .filter((entry) => {
      const at = entry.reviewedAt === null ? null : Date.parse(entry.reviewedAt);
      return at === null || Number.isNaN(at) ? true : now - at < FAILED_WINDOW_MS;
    })
    .sort((left, right) => (right.reviewedAt ?? '').localeCompare(left.reviewedAt ?? ''))
    .slice(0, MAX_FAILED_SHOWN);
}

/**
 * The review queue: everything waiting on a person, with the selected one opened in full.
 *
 * A proposal is never summarised down to a row and then approved from that row — selecting one
 * opens the whole panel, because the decision is only meaningful on complete information.
 *
 * **Recent failures are part of the queue, not a separate history.** An approval whose download
 * or write fell over moves the proposal from `pending` to `failed`, which used to take the card
 * off this screen mid-request: the reviewer pressed "Approve and install", the panel vanished,
 * and what replaced it was "Nothing waiting for review" — the exact impression DESIGN §9
 * forbids. A failed proposal now stays visible, carrying the reason the API recorded, until it
 * is a week old.
 */
export function ProposalQueue({ serverId, className }: ProposalQueueProps) {
  const query = useProposals(serverId, 'pending');
  const failedQuery = useProposals(serverId, 'failed');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const pending = query.data?.data ?? [];
  const failed = useMemo(
    () => recentFailures(failedQuery.data?.data ?? [], Date.now()),
    [failedQuery.data],
  );
  const proposals = [...pending, ...failed];
  const selected = proposals.find((entry) => entry.id === selectedId) ?? proposals[0] ?? null;

  // Both halves, or neither: resolving the pending list first and rendering "Nothing waiting
  // for review" while the failures are still in flight is the flash this screen must not have.
  if (query.isPending || failedQuery.isPending) {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        <span className="sr-only" role="status">
          Loading the review queue.
        </span>
        <Skeleton className="h-32 rounded-md" />
      </div>
    );
  }

  if (query.isError || failedQuery.isError) {
    const failing = query.isError ? query : failedQuery;
    return (
      <ErrorState
        className={className}
        error={failing.error}
        isRetrying={failing.isFetching}
        onRetry={() => {
          void query.refetch();
          void failedQuery.refetch();
        }}
        title="Couldn’t read the review queue"
        variant="inline"
      />
    );
  }

  if (proposals.length === 0) {
    return (
      <EmptyState
        className={className}
        description="When an agent suggests a mod over MCP it lands here first. It shows you the whole listing — description, author, licence, downloads, dependencies — and installs nothing until you approve it."
        icon={<Shield />}
        size="sm"
        title="Nothing waiting for review"
      />
    );
  }

  return (
    <div className={cn('flex flex-col gap-5', className)}>
      {proposals.length > 1 ? (
        <nav aria-label="Pending proposals">
          <ul className="flex flex-wrap gap-2">
            {proposals.map((entry) => {
              const active = entry.id === selected?.id;
              return (
                <li key={entry.id}>
                  <Button
                    aria-current={active ? 'true' : undefined}
                    className={cn(
                      'h-11 rounded-button px-4 text-subhead font-medium',
                      active && 'border-separator-strong bg-surface-hover',
                    )}
                    onClick={() => setSelectedId(entry.id)}
                    variant="outline"
                  >
                    {entry.title}
                    {entry.status === 'failed' ? (
                      <span className="text-label-tertiary"> · install failed</span>
                    ) : null}
                  </Button>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}

      {selected ? (
        <ProposalReview
          key={selected.id}
          onReviewed={() => setSelectedId(null)}
          proposal={selected}
          serverId={serverId}
        />
      ) : null}
    </div>
  );
}
