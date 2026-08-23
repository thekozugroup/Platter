import { useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { formatBytes, formatRelativeTime } from '@platter/shared';
import { ExternalLink } from 'pixelarticons/react/ExternalLink.js';
import { ModIcon, formatDownloads } from '@/components/mods/mod-card';
import {
  ADDED_BY_HAND,
  CANCELLED_NOTE,
  InstallPlan,
  ProblemList,
  summarisePlan,
} from '@/components/mods/mod-install-plan';
import { ModDescription, safeHref } from '@/components/mods/mod-markdown';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/common/error-state';
import type {
  ApprovalOutcome,
  InstalledMod,
  ModDependency,
  ModDetail,
  ModProposal,
  ModSide,
  ModSource,
  ModVersion,
  ProposalChange,
} from '@/hooks';
import { useApproveProposal, useCreateProposal, useMod, useRejectProposal } from '@/hooks';
import { api, errorMessage } from '@/lib/api-client.js';
import { cn } from '@/lib/utils';

/**
 * Everything about one mod, in a sheet — and the button that puts it on the server.
 *
 * **This is the human path, and it is not a review queue.** Somebody who searched for a mod and
 * opened it has already decided; asking them to write a justification and submit a request to
 * themselves was the defect this panel was rebuilt to remove. The primary action is *Add to
 * server*, it installs, and the panel says what happened. The review workflow still exists and
 * still matters — it is in `proposal-review.tsx`, pointed at the person who did *not* choose the
 * mod, because an agent suggested it.
 *
 * Two properties survive from the old flow because they were never about the queue:
 *
 * 1. **Nothing is written without the plan being true.** Adding still goes through
 *    propose → resolve → re-check → install (`routes/proposals.ts`), so the checksum is verified
 *    against what was shown and the dependency walk is the server's, not a guess made here.
 *    There is no install endpoint to shortcut it with, by design.
 * 2. **A surprise stops and asks.** When the plan pulls in other mods, overwrites something, or
 *    raises any problem at all, the add pauses and says so in plain words *before* anything is
 *    downloaded. When it is one file and nothing else, pausing to say "one file will be added"
 *    is ceremony, and the add just happens.
 *
 * `ModDetailBody` is exported so the review screen renders exactly the same listing from its
 * stored snapshot — the two must never show a different amount of information about one project.
 */

// ---------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------

function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col gap-3 border-t border-separator pt-5', className)}>
      <h4 className="font-sans text-subhead font-semibold text-label">{title}</h4>
      {children}
    </section>
  );
}

/**
 * A capped list of pills.
 *
 * A long-lived mod declares every Minecraft version it has ever supported — Lithium lists
 * sixty-one — and sixty-one pills is a wall that pushes the thing you came to read off the
 * screen. The cap is a real control rather than a truncation: pressing it shows the rest.
 */
function Chips({
  values,
  empty,
  cap = 12,
}: {
  values: readonly string[];
  empty: string;
  cap?: number;
}) {
  const [expanded, setExpanded] = useState(false);

  if (values.length === 0) {
    return <p className="text-caption text-label-tertiary">{empty}</p>;
  }

  const shown = expanded ? values : values.slice(0, cap);
  const hidden = values.length - shown.length;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {shown.map((value) => (
        <span
          className="rounded-pill border border-pill-border bg-pill px-2 py-0.5 text-caption font-medium text-label-secondary"
          key={value}
        >
          {value}
        </span>
      ))}
      {hidden > 0 ? (
        <Button
          className="h-11 rounded-button px-3 text-caption font-medium"
          onClick={() => setExpanded(true)}
          variant="ghost"
        >
          and {hidden} more
        </Button>
      ) : null}
    </div>
  );
}

function OutboundLink({ href, children }: { href: string; children: React.ReactNode }) {
  const safe = safeHref(href);
  if (safe === null) return null;
  return (
    <a
      className="inline-flex h-11 items-center gap-1.5 text-subhead text-label-secondary underline underline-offset-2 hover:text-label"
      href={safe}
      rel="noreferrer noopener"
      target="_blank"
    >
      {children}
      <ExternalLink aria-hidden className="size-3.5" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

const CHANNEL_STYLE = {
  release: 'border-pill-border bg-pill text-label-secondary',
  beta: 'border-warning/25 bg-warning-subtle text-warning',
  alpha: 'border-danger/25 bg-danger-subtle text-danger',
} as const;

/** The channel names are the registry's. What they mean for you is not. */
const CHANNEL_LABEL = {
  release: 'Finished',
  beta: 'Test build',
  alpha: 'Early build',
} as const;

const CHANNEL_HINT = {
  release: 'The author considers this one done.',
  beta: 'The author expects bugs in this one.',
  alpha: 'Unstable. Crashes and world data loss are possible.',
} as const;

export function ReleaseChannelBadge({ channel }: { channel: ModVersion['channel'] }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-pill border px-2 py-0.5 text-caption-2 font-medium',
        CHANNEL_STYLE[channel],
      )}
      title={CHANNEL_HINT[channel]}
    >
      {CHANNEL_LABEL[channel]}
    </span>
  );
}

/**
 * What a version drags in with it, without the vocabulary.
 *
 * Registries name a dependency by file where they can and by opaque id where they cannot —
 * `P7dR8mSH` is Fabric API on Modrinth, and printing that at somebody is worse than saying
 * nothing. The project titles are not in this payload, so an unnamed entry is described rather
 * than identified, and the honest count is still visible.
 */
export function ModDependencyList({
  dependencies,
  className,
}: {
  dependencies: readonly ModDependency[];
  className?: string;
}) {
  const needs = dependencies.filter((entry) => entry.kind === 'required');
  const clashes = dependencies.filter((entry) => entry.kind === 'incompatible');
  if (needs.length === 0 && clashes.length === 0) return null;

  /*
   * Modrinth names a dependency by file where it can and by opaque id where it cannot, and in
   * practice it usually cannot — so this list is mostly ids. Repeating "a mod this listing does
   * not name" once per entry reads like a stutter; the count carries the same information and
   * the plan panel names them properly anyway, because the resolver looked them up.
   */
  const describe = (entries: readonly ModDependency[]): string => {
    const named = entries.map((entry) => entry.fileName).filter((name): name is string => !!name);
    const unnamed = entries.length - named.length;
    const parts = [...named];
    if (unnamed > 0) {
      parts.push(
        named.length === 0 && unnamed === 1
          ? 'one this listing does not name'
          : `${unnamed} this listing does not name`,
      );
    }
    return parts.join(', ');
  };

  return (
    <p className={cn('text-caption text-label-tertiary', className)}>
      {needs.length > 0 ? (
        <>
          Also needs {needs.length === 1 ? '' : `${needs.length} other mods: `}
          {describe(needs)}. Platter works out which and adds them with it.
        </>
      ) : null}
      {needs.length > 0 && clashes.length > 0 ? ' ' : null}
      {clashes.length > 0 ? <>Will not run alongside {describe(clashes)}.</> : null}
    </p>
  );
}

const VERSION_PAGE = 5;

export function ModVersionList({
  versions,
  highlightVersionId,
  installedVersionId,
}: {
  versions: readonly ModVersion[];
  highlightVersionId?: string | null;
  installedVersionId?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);

  if (versions.length === 0) {
    return (
      <p className="text-subhead text-label-tertiary">
        No build of this project matches this server’s Minecraft version and mod format.
      </p>
    );
  }

  const shown = expanded ? versions : versions.slice(0, VERSION_PAGE);
  const hidden = versions.length - shown.length;

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {shown.map((version) => {
          const isHighlighted = version.versionId === highlightVersionId;
          const isInstalled = version.versionId === installedVersionId;
          return (
            <li
              className={cn(
                'flex flex-col gap-2 rounded-sm border p-3',
                isHighlighted
                  ? 'border-separator-strong bg-bg-sunken'
                  : 'border-separator bg-surface',
              )}
              key={version.versionId}
            >
              <div className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-footnote font-medium text-label">
                  {version.versionNumber}
                </code>
                <ReleaseChannelBadge channel={version.channel} />
                {isHighlighted ? (
                  <span className="rounded-pill border border-pill-border bg-pill px-2 py-0.5 text-caption-2 font-medium text-label">
                    The one suggested
                  </span>
                ) : null}
                {isInstalled ? (
                  <span className="rounded-pill border border-pill-border bg-pill px-2 py-0.5 text-caption-2 font-medium text-label-secondary">
                    On this server
                  </span>
                ) : null}
                {version.publishedAt !== null ? (
                  <time
                    className="text-caption text-label-tertiary"
                    dateTime={version.publishedAt}
                    title={new Date(version.publishedAt).toLocaleString()}
                  >
                    {formatRelativeTime(version.publishedAt)}
                  </time>
                ) : null}
              </div>

              <p className="text-caption text-label-tertiary">
                <span className="tabular">{formatBytes(version.file.sizeBytes)}</span>
                {version.gameVersions.length > 0 ? (
                  <>
                    <span aria-hidden> · </span>
                    Minecraft {version.gameVersions.slice(0, 4).join(', ')}
                    {version.gameVersions.length > 4
                      ? ` +${version.gameVersions.length - 4}`
                      : null}
                  </>
                ) : null}
              </p>

              <ModDependencyList dependencies={version.dependencies} />
            </li>
          );
        })}
      </ul>

      {hidden > 0 ? (
        <Button
          className="h-11 w-full rounded-button text-subhead font-medium"
          onClick={() => setExpanded(true)}
          variant="outline"
        >
          Show {hidden} older {hidden === 1 ? 'version' : 'versions'}
        </Button>
      ) : null}
    </div>
  );
}

function ModGallery({ mod }: { mod: ModDetail }) {
  if (mod.gallery.length === 0) return null;

  return (
    <Section title="Screenshots">
      {/* Content imagery keeps square corners — the rounded/square contrast is the system. */}
      <ul className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2">
        {mod.gallery.map((image) => {
          const href = safeHref(image.url);
          if (href === null) return null;
          return (
            <li className="w-64 shrink-0 snap-start" key={image.url}>
              <a
                className="flex flex-col gap-1.5"
                href={href}
                rel="noreferrer noopener"
                target="_blank"
              >
                <img
                  alt={image.title ?? `Screenshot of ${mod.title}`}
                  className="h-36 w-full bg-fill-tertiary object-cover"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  src={href}
                />
                <span className="text-caption text-label-tertiary">
                  {image.title ?? 'Open full size'}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/**
 * "Server side: required · Client side: optional" was two registry field names and four enum
 * values. What a person actually needs from those four values is one sentence each, and the
 * client one — *does everybody joining need to install this too?* — is the single most useful
 * fact about a Minecraft mod and was the least readable thing on the panel.
 */
const SERVER_SIDE_SENTENCE: Record<ModSide, string> = {
  required: 'Has to be installed on the server.',
  optional: 'Works on the server, and works without it.',
  unsupported: 'Has no effect on the server.',
  unknown: 'The author does not say whether it belongs on a server.',
};

const CLIENT_SIDE_SENTENCE: Record<ModSide, string> = {
  required: 'Everyone joining has to install it too, or they cannot connect.',
  optional: 'Players can install it as well, but nobody has to.',
  unsupported: 'Players need nothing — it all happens on the server.',
  unknown: 'The author does not say whether players need it.',
};

// ---------------------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------------------

export interface ModDetailBodyProps {
  mod: ModDetail;
  /** Versions this server can run. Empty is meaningful — it explains `incompatibleReason`. */
  versions?: readonly ModVersion[];
  /** Pinned open at the top of the version list, for the one version an agent suggested. */
  highlightVersionId?: string | null;
  installed?: InstalledMod | null;
  incompatibleReason?: string | null;
  /** Set when this is a stored snapshot rather than a live read, so the panel can say so. */
  capturedAt?: string | null;
  className?: string;
}

/**
 * The mod, rendered in full. Shared by the browser's sheet and the suggestion screen so the
 * two can never show a different amount of information about the same project.
 */
export function ModDetailBody({
  mod,
  versions = [],
  highlightVersionId,
  installed,
  incompatibleReason,
  capturedAt,
  className,
}: ModDetailBodyProps) {
  const sourceName = mod.source === 'modrinth' ? 'Modrinth' : 'CurseForge';

  return (
    <div className={cn('flex flex-col gap-5', className)}>
      <div className="flex items-start gap-4">
        <ModIcon iconUrl={mod.iconUrl} size="lg" title={mod.title} />
        <dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-4 gap-y-2">
          <div className="min-w-0">
            <dt className="text-caption text-label-tertiary">Made by</dt>
            <dd className="truncate text-subhead text-label">{mod.author ?? 'Not published'}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-caption text-label-tertiary">Downloads</dt>
            <dd
              className="tabular text-subhead text-label"
              title={`${mod.downloads.toLocaleString()} downloads`}
            >
              {formatDownloads(mod.downloads)}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-caption text-label-tertiary">Licence</dt>
            <dd className="truncate text-subhead text-label">{mod.license ?? 'Not published'}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-caption text-label-tertiary">Found on</dt>
            <dd className="truncate text-subhead text-label">{sourceName}</dd>
          </div>
        </dl>
      </div>

      {capturedAt ? (
        <p className="text-caption text-label-tertiary">
          This is what the listing said{' '}
          <time dateTime={capturedAt} title={new Date(capturedAt).toLocaleString()}>
            {formatRelativeTime(capturedAt)}
          </time>
          , when it was suggested — not a fresh read.
        </p>
      ) : null}

      {incompatibleReason ? (
        <Alert variant="warning">
          <AlertTitle className="font-sans">This server can’t run it</AlertTitle>
          <AlertDescription>{incompatibleReason}</AlertDescription>
        </Alert>
      ) : null}

      {installed ? (
        <Alert>
          <AlertTitle className="font-sans">Already on this server</AlertTitle>
          {/* One `<span>`, not four children: `AlertDescription` is a flex column, so an
              interleaved `<code>` and `<time>` would each become their own row. */}
          <AlertDescription>
            <span>
              Version <code className="font-mono">{installed.versionNumber}</code> was added{' '}
              <time
                dateTime={installed.installedAt}
                title={new Date(installed.installedAt).toLocaleString()}
              >
                {formatRelativeTime(installed.installedAt)}
              </time>
              .
            </span>
          </AlertDescription>
        </Alert>
      ) : null}

      <Section className="border-t-0 pt-0" title="About">
        <ModDescription format={mod.descriptionFormat} text={mod.description || mod.summary} />
      </Section>

      <ModGallery mod={mod} />

      <Section title="Where it runs">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-caption text-label-tertiary">Made for</span>
            <Chips empty="The project does not say." values={mod.loaders} />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-caption text-label-tertiary">Minecraft versions</span>
            <Chips empty="The project does not say." values={mod.gameVersions} />
          </div>
          <p className="text-caption text-label-tertiary">
            {SERVER_SIDE_SENTENCE[mod.serverSide]} {CLIENT_SIDE_SENTENCE[mod.clientSide]}
          </p>
        </div>
      </Section>

      <Section title={versions.length === 1 ? 'The version' : 'Versions that fit this server'}>
        <ModVersionList
          highlightVersionId={highlightVersionId ?? null}
          installedVersionId={installed?.versionId ?? null}
          versions={versions}
        />
      </Section>

      <Section title="Links">
        <div className="flex flex-col">
          <OutboundLink href={mod.url}>Open it on {sourceName}</OutboundLink>
          {mod.sourceUrl ? <OutboundLink href={mod.sourceUrl}>Source code</OutboundLink> : null}
          {mod.issuesUrl ? <OutboundLink href={mod.issuesUrl}>Bug reports</OutboundLink> : null}
          {mod.wikiUrl ? <OutboundLink href={mod.wikiUrl}>Wiki</OutboundLink> : null}
          {mod.licenseUrl ? <OutboundLink href={mod.licenseUrl}>Licence text</OutboundLink> : null}
          {mod.discordUrl ? <OutboundLink href={mod.discordUrl}>Discord</OutboundLink> : null}
        </div>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Adding
// ---------------------------------------------------------------------------------------

/** Registry field names, in the words somebody running a server would use. */
const CHANGED_FIELD_PHRASE: Record<string, string> = {
  sha512: 'the file’s fingerprint',
  sha1: 'the file’s fingerprint',
  url: 'where it downloads from',
  filename: 'the file name',
  sizeBytes: 'the file size',
  versionId: 'the version',
  versionNumber: 'the version',
  loaders: 'which servers it runs on',
  gameVersions: 'which Minecraft versions it supports',
  requires: 'what else it needs',
  projectId: 'which project it is',
  slug: 'which project it is',
  title: 'its name',
  author: 'who made it',
  license: 'its licence',
  serverSide: 'whether it belongs on a server',
  summary: 'its summary',
  description: 'its description',
};

function describeChanges(changes: readonly ProposalChange[]): string {
  const phrases = [
    ...new Set(
      changes
        .filter((change) => change.material)
        .map((change) => CHANGED_FIELD_PHRASE[change.field] ?? change.field),
    ),
  ];
  if (phrases.length === 0) return 'The listing changed.';
  if (phrases.length === 1) return `What changed: ${phrases[0]}.`;
  return `What changed: ${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}.`;
}

type AddState =
  | { step: 'idle' }
  /** The plan is being worked out upstream. Nothing has been downloaded. */
  | { step: 'checking' }
  /** The plan holds a surprise, so it is on screen and waiting for a person. */
  | { step: 'confirm'; proposal: ModProposal }
  | { step: 'adding'; proposal: ModProposal }
  | { step: 'done'; outcome: ApprovalOutcome }
  /** Re-checking upstream refused: the listing moved, or the plan no longer fits. */
  | { step: 'stopped'; proposal: ModProposal; outcome: ApprovalOutcome };

export interface AddToServerProps {
  serverId: string;
  serverName: string;
  /** Drives the restart sentence: a stopped server needs starting, not restarting. */
  serverRunning?: boolean;
  source: ModSource;
  project: string;
  detail: ModDetail;
  versions: readonly ModVersion[];
  installed: InstalledMod | null;
  onAdded?: () => void;
}

export function AddToServer({
  serverId,
  serverName,
  serverRunning = false,
  source,
  project,
  detail,
  versions,
  installed,
  onAdded,
}: AddToServerProps) {
  const [versionId, setVersionId] = useState('');
  const [state, setState] = useState<AddState>({ step: 'idle' });
  const hintId = useId();

  /*
   * Pressing "Add to server" replaces the button with whatever comes next, which for a
   * keyboard or screen-reader user means the thing they were on has just ceased to exist and
   * focus falls to the body. So each answer takes focus itself: `role="status"` announces it,
   * `tabIndex={-1}` makes it focusable without putting it in the tab order, and the controls
   * that follow are then the next thing Tab reaches. DESIGN §10.
   */
  const panel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (state.step === 'confirm' || state.step === 'done' || state.step === 'stopped') {
      panel.current?.focus();
    }
  }, [state.step]);

  const propose = useCreateProposal(serverId);
  const approve = useApproveProposal(serverId);
  const reject = useRejectProposal(serverId);
  const queryClient = useQueryClient();

  /*
   * Working out the plan means asking the API to resolve it, and the API records that ask.
   * So a plan the person then walks away from would sit in this server's suggestion list
   * looking like something an agent proposed — the exact confusion this rework exists to
   * remove. Whatever is staged when this panel goes away gets closed on the way out.
   */
  const staged = useRef<string | null>(null);
  useEffect(
    () => () => {
      const id = staged.current;
      if (id === null) return;
      staged.current = null;
      void api
        .post(`/servers/${serverId}/proposals/${id}/reject`, { note: CANCELLED_NOTE })
        .catch(() => undefined)
        .finally(() => {
          void queryClient.invalidateQueries({ queryKey: ['servers', serverId, 'proposals'] });
        });
    },
    [queryClient, serverId],
  );

  const install = (proposal: ModProposal, acknowledgedDigest: string | null): void => {
    staged.current = null;
    setState({ step: 'adding', proposal });
    approve.mutate(
      { proposalId: proposal.id, acknowledgedDigest, title: proposal.title },
      {
        onSuccess: (outcome) => {
          if (outcome.status === 'installed') {
            setState({ step: 'done', outcome });
            onAdded?.();
          } else {
            // Re-check refused. The record is still open, so it is still cancellable.
            staged.current = proposal.id;
            setState({ step: 'stopped', proposal, outcome });
          }
        },
        onError: () => {
          /*
           * The failure itself is reported by the mutation's own toast, which outlives this
           * panel — that is the whole reason it lives there. What has to happen *here* is that
           * the record does not strand: a refused permission leaves it open and untouched, and
           * an open record nobody can see is worse than a visible one. Putting it back on the
           * staging ref means leaving this panel closes it.
           */
          staged.current = proposal.id;
          setState({ step: 'idle' });
        },
      },
    );
  };

  const begin = (): void => {
    setState({ step: 'checking' });
    propose.mutate(
      {
        source,
        project,
        rationale: ADDED_BY_HAND,
        ...(versionId === '' ? {} : { version: versionId }),
      },
      {
        onSuccess: (proposal) => {
          staged.current = proposal.id;
          if (summarisePlan(proposal.snapshot.resolution).worthAPause) {
            setState({ step: 'confirm', proposal });
          } else {
            install(proposal, null);
          }
        },
        onError: () => setState({ step: 'idle' }),
      },
    );
  };

  const cancel = (proposalId: string): void => {
    staged.current = null;
    setState({ step: 'idle' });
    reject.mutate({ proposalId, note: CANCELLED_NOTE });
  };

  // ---- Done -------------------------------------------------------------------------

  if (state.step === 'done') {
    const files = state.outcome.installed;
    return (
      <Alert ref={panel} role="status" tabIndex={-1} variant="success">
        <AlertTitle className="font-sans">Added to {serverName}</AlertTitle>
        <AlertDescription className="flex flex-col gap-1">
          <span>
            {files.length === 1
              ? `${files[0]?.title ?? detail.title} ${files[0]?.versionNumber ?? ''} is on the server.`
              : `${files.length} mods are on the server: ${files.map((file) => file.title).join(', ')}.`}
          </span>
          <span>
            {serverRunning
              ? `Restart ${serverName} and it will load.`
              : `It loads the next time you start ${serverName}.`}
          </span>
        </AlertDescription>
      </Alert>
    );
  }

  // ---- Stopped by the re-check ------------------------------------------------------

  if (state.step === 'stopped') {
    const changed = state.outcome.status === 'changed';
    return (
      <div className="flex flex-col gap-3 outline-none" ref={panel} role="alert" tabIndex={-1}>
        <Alert variant={changed ? 'warning' : 'destructive'}>
          <AlertTitle className="font-sans">
            {changed ? 'The download has changed' : 'Nothing was added'}
          </AlertTitle>
          <AlertDescription>
            {changed
              ? `${detail.title} on ${detail.source === 'modrinth' ? 'Modrinth' : 'CurseForge'} is not the same file it was a moment ago, so Platter stopped rather than fetch something you did not look at. ${describeChanges(state.outcome.changes)}`
              : 'The plan no longer works on this server. Nothing was downloaded and nothing was written.'}
          </AlertDescription>
        </Alert>

        <ProblemList problems={state.outcome.resolution.problems} />

        <div className="flex flex-wrap gap-3">
          {changed ? (
            <Button
              className="h-11 rounded-button px-5 text-subhead font-medium"
              isLoading={approve.isPending}
              onClick={() => install(state.proposal, state.outcome.digest)}
              size="lg"
            >
              Add the new one anyway
            </Button>
          ) : null}
          <Button
            className="h-11 rounded-button px-5 text-subhead font-medium"
            onClick={() => cancel(state.proposal.id)}
            variant="outline"
          >
            {changed ? 'Leave it' : 'Close'}
          </Button>
        </div>
      </div>
    );
  }

  // ---- The plan, when it holds a surprise --------------------------------------------

  if (state.step === 'confirm' || state.step === 'adding') {
    const { proposal } = state;
    const plan = summarisePlan(proposal.snapshot.resolution);
    const blocked = plan.errors.length > 0 || !proposal.snapshot.resolution.installable;

    return (
      <div className="flex flex-col gap-4 outline-none" ref={panel} role="status" tabIndex={-1}>
        <div className="flex flex-col gap-1">
          <h4 className="font-sans text-subhead font-semibold text-label">
            Before it goes on {serverName}
          </h4>
          <p className="text-caption text-label-tertiary">Nothing has been downloaded yet.</p>
        </div>

        <InstallPlan resolution={proposal.snapshot.resolution} title={detail.title} />

        <div className="flex flex-wrap gap-3">
          <Button
            className="h-11 rounded-button px-5 text-subhead font-medium"
            disabled={blocked}
            isLoading={state.step === 'adding'}
            onClick={() => install(proposal, null)}
            size="lg"
          >
            {plan.fileCount > 1 ? `Add all ${plan.fileCount}` : 'Add it'}
          </Button>
          <Button
            className="h-11 rounded-button px-5 text-subhead font-medium"
            disabled={state.step === 'adding'}
            onClick={() => cancel(proposal.id)}
            variant="outline"
          >
            Cancel
          </Button>
        </div>

        {blocked ? (
          <p className="text-caption text-label-tertiary">
            This one cannot go on as things stand. Clearing the problem above is the only way
            forward.
          </p>
        ) : (
          <p className="text-caption text-label-tertiary">
            {serverRunning
              ? `${serverName} keeps running; it picks the change up on the next restart.`
              : `${serverName} loads it the next time you start it.`}
          </p>
        )}
      </div>
    );
  }

  // ---- Resting ------------------------------------------------------------------------

  const busy = state.step === 'checking';
  /*
   * "Newest one that works here" is a choice, not an absence of one — `compatibleVersions`
   * arrives newest first (`services/mods.ts`), so the empty select value resolves to the first
   * entry. Treating it as unknown is what would make an available update look unavailable.
   */
  const chosenVersionId = versionId === '' ? (versions[0]?.versionId ?? null) : versionId;
  const alreadyHere = installed !== null && chosenVersionId === installed.versionId;

  return (
    <div className="flex flex-col gap-3">
      {versions.length > 1 ? (
        <Field>
          <FieldLabel>Which version</FieldLabel>
          <NativeSelect
            className="w-full [&>select]:h-11"
            name="version"
            onChange={(event) => setVersionId(event.target.value)}
            value={versionId}
          >
            <NativeSelectOption value="">
              Newest one that works here (recommended)
            </NativeSelectOption>
            {versions.map((version) => (
              <NativeSelectOption key={version.versionId} value={version.versionId}>
                {version.versionNumber}
                {version.channel === 'release' ? '' : ` — ${CHANNEL_LABEL[version.channel]}`}
                {version.versionId === installed?.versionId ? ' — already here' : ''}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      ) : null}

      <p className="text-caption text-label-tertiary" id={hintId}>
        {alreadyHere
          ? `This version is already on ${serverName}. Pick a different one to change it.`
          : installed === null
            ? `Downloads it to ${serverName} and checks the file before saving it. The server picks it up on its next restart.`
            : `Replaces the copy already on ${serverName}. The server picks it up on its next restart.`}
      </p>

      <Button
        aria-describedby={hintId}
        className="h-11 rounded-button px-5 text-subhead font-medium"
        disabled={alreadyHere}
        isLoading={busy}
        onClick={begin}
        size="lg"
      >
        {installed === null
          ? `Add to ${serverName}`
          : alreadyHere
            ? `Already on ${serverName}`
            : 'Swap in this version'}
      </Button>

      <p aria-live="polite" className="text-caption text-danger" role="status">
        {propose.isError ? errorMessage(propose.error) : null}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------------------

export interface ModDetailSheetProps {
  serverId: string;
  serverName: string;
  serverRunning?: boolean;
  /** Null closes the sheet. Changing it swaps which mod is shown. */
  target: { source: ModSource; project: string; title: string } | null;
  onClose: () => void;
  /** Hides the add control for somebody who may only look. */
  canAdd?: boolean;
  /** Fires once a mod is actually on disk, so the page can show the installed list. */
  onAdded?: () => void;
}

export function ModDetailSheet({
  serverId,
  serverName,
  serverRunning,
  target,
  onClose,
  canAdd = true,
  onAdded,
}: ModDetailSheetProps) {
  return (
    <Sheet
      onOpenChange={(details) => {
        if (!details.open) onClose();
      }}
      open={target !== null}
    >
      {/* No aria-label: Ark points the content's aria-labelledby at SheetTitle already. */}
      <SheetContent className="max-w-xl lg:max-w-2xl">
        {target ? (
          <SheetInner
            canAdd={canAdd}
            project={target.project}
            serverId={serverId}
            serverName={serverName}
            source={target.source}
            title={target.title}
            {...(serverRunning === undefined ? {} : { serverRunning })}
            {...(onAdded ? { onAdded } : {})}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/**
 * Split out so the query only runs while the sheet is open — `Sheet` lazy-mounts and unmounts
 * its content, so nothing here fetches a project the reader never asked to see.
 */
function SheetInner({
  serverId,
  serverName,
  serverRunning,
  source,
  project,
  title,
  canAdd,
  onAdded,
}: {
  serverId: string;
  serverName: string;
  serverRunning?: boolean;
  source: ModSource;
  project: string;
  title: string;
  canAdd: boolean;
  onAdded?: () => void;
}) {
  const query = useMod(serverId, source, project);
  const detail = query.data;

  return (
    <>
      <SheetHeader>
        {/* font-sans: SheetTitle defaults to `font-heading`, which this theme maps to the
            pixel display face — unreadable at 20px. */}
        <SheetTitle className="font-sans text-title-3 font-semibold">{title}</SheetTitle>
        <SheetDescription>
          {detail
            ? detail.mod.summary
            : query.isError
              ? 'This project could not be loaded.'
              : 'Loading the full listing.'}
        </SheetDescription>
      </SheetHeader>

      <SheetBody>
        {/* Error first: a failed query also has no data, and a skeleton that never
            resolves is the worst of the three states to be left in. */}
        {query.isError ? (
          <ErrorState
            error={query.error}
            isRetrying={query.isFetching}
            onRetry={() => void query.refetch()}
            recovery="The registry is outside Platter, so restarting it will not help. Try again in a minute."
            title="Couldn’t load this mod"
            variant="inline"
          />
        ) : detail === undefined ? (
          <div className="flex flex-col gap-4">
            <span className="sr-only" role="status">
              Loading {title}.
            </span>
            <div className="flex gap-4">
              <Skeleton className="size-16 rounded-xs" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-28" />
              </div>
            </div>
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-24 w-full rounded-sm" />
          </div>
        ) : (
          <ModDetailBody
            incompatibleReason={detail.incompatibleReason}
            installed={detail.installed}
            mod={detail.mod}
            versions={detail.compatibleVersions}
          />
        )}
      </SheetBody>

      {detail && canAdd ? (
        <SheetFooter className="flex-col items-stretch gap-0 sm:flex-col sm:justify-start">
          {detail.incompatibleReason === null ? (
            <AddToServer
              detail={detail.mod}
              installed={detail.installed}
              project={project}
              serverId={serverId}
              serverName={serverName}
              source={source}
              versions={detail.compatibleVersions}
              {...(serverRunning === undefined ? {} : { serverRunning })}
              {...(onAdded ? { onAdded } : {})}
            />
          ) : (
            <p className="text-caption text-label-tertiary">
              There is nothing to add here — {detail.incompatibleReason.toLowerCase()}
            </p>
          )}
        </SheetFooter>
      ) : null}
    </>
  );
}
