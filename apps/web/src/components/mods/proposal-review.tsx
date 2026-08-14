import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { formatBytes, formatRelativeTime } from '@platter/shared';
import { Robot } from 'pixelarticons/react/Robot.js';
import { Shield } from 'pixelarticons/react/Shield.js';
import { WarningDiamond } from 'pixelarticons/react/WarningDiamond.js';
import { ModDetailBody } from '@/components/mods/mod-detail-sheet';
import { InstallPlan, isSelfRaised, summarisePlan } from '@/components/mods/mod-install-plan';
import { modSurface } from '@/components/mods/mod-card';
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
import type { ApprovalOutcome, ModProposal, ProposalChange } from '@/hooks';
import { useApproveProposal, useCreateProposal, useProposals, useRejectProposal } from '@/hooks';
import { errorMessage } from '@/lib/api-client.js';
import { cn } from '@/lib/utils';

/**
 * A mod somebody else picked, and the person who gets to decide.
 *
 * This is the *other* half of the mod flow, and the distinction is the whole design. When a
 * person searches for a mod and opens it, they have already decided, and the sheet in
 * `mod-detail-sheet.tsx` simply adds it. This screen is for the case where they did not
 * choose: an agent connected over MCP proposed one. So the reader here is being *asked*, and
 * every line is written to that — who suggested it, in their words, what it would do to this
 * server, the whole listing so the project can be judged, and then Add or Dismiss.
 *
 * It reads as "someone suggested this for you", never as a form to fill in. There is no field
 * to complete, no justification to write, nothing to submit. The only inputs are two buttons
 * and an optional note when dismissing.
 *
 * Three properties it must keep:
 *
 * 1. **Nothing has happened yet, said before anything else.** An agent that appears to have
 *    already acted is the failure mode DESIGN §9 names outright.
 * 2. **The whole mod, not a summary.** The panel renders `ModDetailBody` — the same component
 *    the browser uses — against the snapshot stored on the proposal. Somebody who has to open
 *    Modrinth to judge whether a project is real is somebody who will stop bothering, and that
 *    is how a safety gate quietly stops working.
 * 3. **A changed download stops the add.** Approval re-reads the registry and refuses anything
 *    whose checksum, download URL, filename, dependencies, loaders or game versions have moved
 *    since the suggestion was made (`services/proposals.ts`). Getting something other than what
 *    you read is the exact failure this exists to prevent, so that outcome takes over the top
 *    of the panel and spells out the difference before offering the choice again.
 */

// ---------------------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------------------

/** Pending suggestions for one server. Cheap enough to sit in the header. */
export function usePendingProposals(serverId: string): ModProposal[] {
  const query = useProposals(serverId, 'pending');
  return (query.data?.data ?? []).filter((entry) => !isSelfRaised(entry));
}

export interface ProposalQueueState {
  /** Pending suggestions first, then installs that fell over recently. */
  proposals: ModProposal[];
  isPending: boolean;
  isError: boolean;
}

/**
 * The queue's contents, shared with whatever lays the page out.
 *
 * `ModsPage` needs to know whether anything is waiting *before* it decides what comes first on
 * the screen, and re-fetching to find out would be silly. Both callers read the same two
 * queries through react-query, so this costs one request either way.
 */
export function useProposalQueue(serverId: string): ProposalQueueState {
  const pendingQuery = useProposals(serverId, 'pending');
  const failedQuery = useProposals(serverId, 'failed');

  const proposals = useMemo(
    () => [
      // A mod somebody is adding by hand is not a suggestion, even though it briefly shares a
      // table with them — see `isSelfRaised`.
      ...(pendingQuery.data?.data ?? []).filter((entry) => !isSelfRaised(entry)),
      ...recentFailures(failedQuery.data?.data ?? [], Date.now()),
    ],
    [pendingQuery.data, failedQuery.data],
  );

  return {
    proposals,
    // Both halves, or neither: resolving the pending list first and rendering "nothing here"
    // while the failures are still in flight is the flash this screen must not have.
    isPending: pendingQuery.isPending || failedQuery.isPending,
    isError: pendingQuery.isError || failedQuery.isError,
  };
}

export interface PendingProposalsBadgeProps {
  serverId: string;
  className?: string;
}

/**
 * A count of what is waiting, linking to the queue.
 *
 * Exported for the server header (`pages/server/ServerLayout.tsx`) so a suggestion is visible
 * from every tab rather than only from the one screen that lists them. It renders nothing when
 * nothing is waiting, so it is safe to mount unconditionally.
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
      {pending.length} {pending.length === 1 ? 'mod suggested' : 'mods suggested'} for you
    </Link>
  );
}

// ---------------------------------------------------------------------------------------
// The changed-listing diff
// ---------------------------------------------------------------------------------------

/**
 * Registry field names, in the words somebody running a server would use.
 *
 * The raw name is kept in the row's `title`, because on this one screen the technical name is
 * occasionally the thing being checked — but it is not what leads.
 */
const CHANGE_FIELD_LABEL: Record<string, string> = {
  projectId: 'Which project it is',
  slug: 'Which project it is',
  title: 'Its name',
  serverSide: 'Whether it belongs on a server',
  license: 'Its licence',
  versionId: 'The version',
  versionNumber: 'The version number',
  filename: 'The file name',
  url: 'Where it downloads from',
  sizeBytes: 'The file size',
  sha512: 'The file’s fingerprint',
  sha1: 'The file’s fingerprint',
  loaders: 'Which servers it runs on',
  gameVersions: 'Which Minecraft versions it supports',
  requires: 'What else it needs',
  summary: 'Its summary',
  description: 'Its description',
  author: 'Who made it',
};

function ChangeTable({ changes }: { changes: readonly ProposalChange[] }) {
  if (changes.length === 0) return null;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-lg border-collapse text-caption">
        <caption className="sr-only">
          What is different between the listing you were shown and the listing now
        </caption>
        <thead>
          <tr className="border-b border-separator-strong text-start">
            <th className="py-2 pe-3 text-start font-medium text-label-tertiary" scope="col">
              What
            </th>
            <th className="py-2 pe-3 text-start font-medium text-label-tertiary" scope="col">
              You were shown
            </th>
            <th className="py-2 text-start font-medium text-label-tertiary" scope="col">
              It is now
            </th>
          </tr>
        </thead>
        <tbody>
          {changes.map((change) => (
            <tr className="border-b border-separator align-top" key={change.field}>
              <th
                className="py-2 pe-3 text-start font-medium text-label"
                scope="row"
                title={change.field}
              >
                {CHANGE_FIELD_LABEL[change.field] ?? change.field}
                {change.material ? null : (
                  <span className="block text-caption-2 font-normal text-label-tertiary">
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
  /** Used in the sentences, so they name the server rather than say "this server". */
  serverName?: string;
  proposal: ModProposal;
  /** Called after a decision lands, so a list can move on to the next suggestion. */
  onReviewed?: (proposal: ModProposal) => void;
  className?: string;
}

export function ProposalReview({
  serverId,
  serverName = 'this server',
  proposal,
  onReviewed,
  className,
}: ProposalReviewProps) {
  const [confirming, setConfirming] = useState<'add' | 'dismiss' | null>(null);
  const [note, setNote] = useState('');
  const [outcome, setOutcome] = useState<ApprovalOutcome | null>(null);

  /*
   * `useApproveProposal` declares 409 an expected status, so the `changed` and `blocked`
   * outcomes arrive here as ordinary results carrying the difference and the new digest —
   * which is what this screen exists to show. Only a real failure lands in `error`.
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

  // The live re-check wins over the stored plan once an attempt has been made: after a
  // `blocked` or `changed` answer, what was stored is no longer what would happen.
  const resolution = outcome?.resolution ?? proposal.snapshot.resolution;
  const plan = summarisePlan(resolution);
  const drifted = outcome?.status === 'changed';
  const driftSuspected = proposal.driftDetectedAt !== null && outcome === null;
  const materialChanges = useMemo(
    () => (outcome?.changes ?? []).filter((change) => change.material),
    [outcome],
  );

  const decided = proposal.status !== 'pending' || outcome?.status === 'installed';
  const blockedReason = resolution.installable
    ? null
    : `This no longer works on ${serverName} as it is now. The problems above have to be sorted first.`;
  const busy = approve.isPending || reject.isPending;

  return (
    <article className={cn('flex flex-col gap-6', className)}>
      <Standing
        installed={outcome?.status === 'installed' ? outcome : null}
        proposal={proposal}
        serverName={serverName}
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
        A *retryable* failure leaves the suggestion open with the reason recorded on it
        (`services/proposals.ts`), so without this the second visit to this screen shows
        something that looks untouched and gives no hint that a download already fell over.
      */}
      {proposal.status === 'pending' && proposal.error !== null && outcome === null ? (
        <Alert variant="destructive">
          <AlertTitle className="font-sans">The last attempt did not finish</AlertTitle>
          <AlertDescription>
            {proposal.error} Nothing was added, and this suggestion is still open — trying again
            starts over.
          </AlertDescription>
        </Alert>
      ) : null}

      {driftSuspected ? (
        <Alert variant="warning">
          <WarningDiamond aria-hidden />
          <AlertTitle className="font-sans">
            This listing changed once since it was suggested
          </AlertTitle>
          <AlertDescription>
            An earlier attempt found the registry no longer matched what is shown below, and
            stopped. Trying again re-checks it and shows you the difference before anything is
            downloaded.
          </AlertDescription>
        </Alert>
      ) : null}

      {outcome?.status === 'blocked' ? (
        <Alert variant="destructive">
          <AlertTitle className="font-sans">Nothing was added</AlertTitle>
          <AlertDescription>
            It no longer works on {serverName}. Every reason is listed under “What this would do”.
          </AlertDescription>
        </Alert>
      ) : null}

      <Proposer proposal={proposal} serverName={serverName} />

      <section className="flex flex-col gap-3">
        <h4 className="font-sans text-subhead font-semibold text-label">What this would do</h4>
        <InstallPlan resolution={resolution} showFiles title={proposal.title} />
      </section>

      <section className="flex flex-col gap-3 border-t border-separator pt-5">
        <h4 className="font-sans text-subhead font-semibold text-label">
          The mod, as it was when this was suggested
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
          fileCount={plan.fileCount}
          onAdd={() => setConfirming('add')}
          onDismiss={() => setConfirming('dismiss')}
        />
      )}

      {/*
        A failed install is terminal — the API refuses to approve or reject one — so the only
        way forward is a fresh suggestion. Offering it here means the error names a next step
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
            Try it again
          </Button>
          <p className="text-caption text-label-tertiary">
            Puts it back on this list for the newest version {serverName} can run, with the same
            reason attached. It adds nothing on its own.
          </p>
        </div>
      ) : null}

      <p aria-live="polite" className="text-caption text-danger" role="status">
        {approve.isError ? errorMessage(approve.error) : null}
        {reject.isError ? errorMessage(reject.error) : null}
        {repropose.isError ? errorMessage(repropose.error) : null}
      </p>

      {/* Add: the last chance to read what goes on the server, restated in one place. */}
      <AlertDialog
        onOpenChange={(details) => {
          if (!details.open) setConfirming(null);
        }}
        open={confirming === 'add'}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-sans text-title-3 font-semibold">
              Add {proposal.title} {proposal.versionNumber} to {serverName}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {resolution.install.length === 1
                ? 'This downloads one file and puts it on the server.'
                : `This downloads ${resolution.install.length} files and puts them on the server.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogBody>
            <ul className="flex flex-col gap-2">
              {resolution.install.map((entry) => (
                <li className="text-subhead text-label-secondary" key={entry.projectId}>
                  <span className="text-label">{entry.title}</span>{' '}
                  <code className="font-mono text-caption">{entry.version.versionNumber}</code>{' '}
                  <span className="tabular text-caption">
                    ({formatBytes(entry.version.file.sizeBytes)})
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-caption text-label-tertiary">
              Platter checks each download against what you just read and refuses anything that has
              changed. {serverName} picks it up on its next restart.
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
              Add to server
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Dismiss: the note is optional and is the only field on this screen. */}
      <AlertDialog
        onOpenChange={(details) => {
          if (!details.open) setConfirming(null);
        }}
        open={confirming === 'dismiss'}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-sans text-title-3 font-semibold">
              Dismiss {proposal.title}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Nothing is added and nothing is deleted. The suggestion goes away.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogBody>
            <Field>
              <FieldLabel>Why not? (optional)</FieldLabel>
              <Textarea
                maxLength={MAX_NOTE}
                name="note"
                onChange={(event) => setNote(event.target.value)}
                placeholder="So the same thing is not suggested again."
                rows={3}
                value={note}
              />
              <FieldDescription>
                Kept with the suggestion, and readable by whoever made it.
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
              Dismiss it
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
 * While a suggestion is open this says, unambiguously and before anything else, that nothing
 * has been added. Every other state replaces it with what actually happened.
 */
function Standing({
  proposal,
  installed,
  serverName,
}: {
  proposal: ModProposal;
  installed: ApprovalOutcome | null;
  serverName: string;
}) {
  if (installed) {
    return (
      <Alert variant="success">
        <AlertTitle className="font-sans">Added to {serverName}</AlertTitle>
        <AlertDescription>
          {installed.installed.length === 1
            ? `${installed.installed[0]?.title ?? proposal.title} is on the server.`
            : `${installed.installed.length} mods are on the server: ${installed.installed
                .map((record) => record.title)
                .join(', ')}.`}{' '}
          Restart {serverName} and it will load.
        </AlertDescription>
      </Alert>
    );
  }

  if (proposal.status === 'approved') {
    return (
      <Alert variant="success">
        <AlertTitle className="font-sans">Added</AlertTitle>
        <AlertDescription>
          {proposal.reviewedByName ?? 'Somebody'} added this{' '}
          {proposal.reviewedAt === null ? '' : formatRelativeTime(proposal.reviewedAt)}. It is on
          the server.
        </AlertDescription>
      </Alert>
    );
  }

  if (proposal.status === 'rejected') {
    return (
      <Alert>
        <AlertTitle className="font-sans">Dismissed</AlertTitle>
        <AlertDescription>
          {proposal.reviewedByName ?? 'Somebody'} dismissed this{' '}
          {proposal.reviewedAt === null ? '' : formatRelativeTime(proposal.reviewedAt)}. Nothing was
          added.
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
        <AlertTitle className="font-sans">Adding it failed</AlertTitle>
        <AlertDescription>
          {proposal.error ?? 'The download did not finish.'} Nothing usable was left on the server,
          and this one cannot be tried again as it is.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="info">
      <Shield aria-hidden />
      <AlertTitle className="font-sans">Nothing has been added</AlertTitle>
      <AlertDescription>
        This is a suggestion waiting on you. No file has been downloaded, nothing has been written
        to {serverName}, and the server has not been touched. That only happens if you add it.
      </AlertDescription>
    </Alert>
  );
}

function Proposer({ proposal, serverName }: { proposal: ModProposal; serverName: string }) {
  const name = proposal.proposedByName;

  return (
    <section className="flex flex-col gap-3">
      <h4 className="font-sans text-subhead font-semibold text-label">
        {name === null
          ? `An assistant suggested this for ${serverName}`
          : `${name} suggested this for ${serverName}`}
      </h4>
      <div className={cn(modSurface, 'flex items-start gap-3 p-4')}>
        <span
          aria-hidden
          className="flex size-11 shrink-0 items-center justify-center rounded-xs bg-fill-secondary text-label-secondary"
        >
          <Robot className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-subhead font-medium text-label">
            {name ?? 'An assistant connected to this server'}
          </p>
          <p className="mt-0.5 text-caption text-label-tertiary">
            {/*
              Everything that reaches this list arrived through `POST /proposals` from
              something other than this browser's own add button (`isSelfRaised` filters those
              out), which in practice means an assistant over MCP. The name, when there is one,
              is whose account the assistant was connected with — worth saying, because it is
              also whose permissions it was limited to.
            */}
            {name === null
              ? 'Came in over MCP with no account attached — a machine credential.'
              : 'Came in over MCP. Nothing it sends can install anything on its own.'}
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
            This is not what you were shown
          </h4>
          <p className="mt-1 text-subhead leading-normal text-label-secondary">
            {materialCount === 0
              ? 'The listing changed since this was suggested. Nothing was added.'
              : `${materialCount} ${materialCount === 1 ? 'thing that decides what code runs has' : 'things that decide what code runs have'} changed since this was suggested. Nothing was added.`}{' '}
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
          I have read the changes — add the new one
        </Button>
        <p className="text-caption text-label-secondary">
          Leaving this page adds nothing. The suggestion stays open, and dismissing it is still the
          other option.
        </p>
      </div>
    </section>
  );
}

/**
 * The decision. Two controls, identical in size and weight, neither focused first — this screen
 * has no primary action on purpose, because the interface has no opinion about which way it
 * should go.
 */
function Decision({
  onAdd,
  onDismiss,
  blockedReason,
  busy,
  fileCount,
}: {
  onAdd: () => void;
  onDismiss: () => void;
  blockedReason: string | null;
  busy: boolean;
  fileCount: number;
}) {
  const reasonId = 'proposal-add-blocked';

  return (
    <div className="flex flex-col gap-2 border-t border-separator pt-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <Button
          {...(blockedReason ? { 'aria-describedby': reasonId } : {})}
          className="h-11 rounded-button px-5 text-subhead font-medium"
          disabled={blockedReason !== null || busy}
          onClick={onAdd}
          variant="outline"
        >
          {fileCount > 1 ? `Add all ${fileCount} to server` : 'Add to server'}
        </Button>
        <Button
          className="h-11 rounded-button px-5 text-subhead font-medium"
          disabled={busy}
          onClick={onDismiss}
          variant="outline"
        >
          Dismiss
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
  serverName?: string;
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
 * Everything waiting on a person, with the selected one opened in full.
 *
 * A suggestion is never summarised down to a row and then added from that row — selecting one
 * opens the whole panel, because the decision is only meaningful on complete information.
 *
 * **Recent failures live here too, not in a separate history.** An add whose download or write
 * fell over moves the record from `pending` to `failed`, which used to take the card off this
 * screen mid-request: you pressed the button, the panel vanished, and what replaced it was
 * "nothing here" — the exact impression DESIGN §9 forbids. A failed one now stays visible,
 * carrying the reason the API recorded, until it is a week old.
 */
export function ProposalQueue({ serverId, serverName, className }: ProposalQueueProps) {
  const { proposals, isPending, isError } = useProposalQueue(serverId);
  const pendingQuery = useProposals(serverId, 'pending');
  const failedQuery = useProposals(serverId, 'failed');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = proposals.find((entry) => entry.id === selectedId) ?? proposals[0] ?? null;

  if (isPending) {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        <span className="sr-only" role="status">
          Looking for suggestions.
        </span>
        <Skeleton className="h-32 rounded-md" />
      </div>
    );
  }

  if (isError) {
    const failing = pendingQuery.isError ? pendingQuery : failedQuery;
    return (
      <ErrorState
        className={className}
        error={failing.error}
        isRetrying={failing.isFetching}
        onRetry={() => {
          void pendingQuery.refetch();
          void failedQuery.refetch();
        }}
        title="Couldn’t check for suggestions"
        variant="inline"
      />
    );
  }

  if (proposals.length === 0) {
    return (
      <EmptyState
        className={className}
        description="Connect Claude, or any assistant that speaks MCP, and it can suggest mods for this server. They land here with the whole listing — what it does, who made it, its licence, how many people use it — and go on the server only if you say so."
        icon={<Shield />}
        size="sm"
        title="No suggestions right now"
      />
    );
  }

  return (
    <div className={cn('flex flex-col gap-5', className)}>
      {proposals.length > 1 ? (
        <nav aria-label="Suggested mods">
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
                      <span className="text-label-tertiary"> · didn’t finish</span>
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
          {...(serverName === undefined ? {} : { serverName })}
        />
      ) : null}
    </div>
  );
}
