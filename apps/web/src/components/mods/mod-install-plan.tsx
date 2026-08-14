import { useState } from 'react';
import { formatBytes } from '@platter/shared';
import { ModIcon, modSurface } from '@/components/mods/mod-card';
import { Button } from '@/components/ui/button';
import type { PlannedInstall, Resolution, ResolutionProblem } from '@/hooks';
import { cn } from '@/lib/utils';

/**
 * What adding a mod actually does, said in the words someone running a server for friends
 * would use.
 *
 * The API answers with a dependency resolution: a graph walk, a list of planned artifacts,
 * a set of typed problems. All of that is true and none of it is what a person needs read at
 * them. This module is the translation layer — *"Adds 2 more mods it needs"*, not *"2
 * transitive dependencies resolved"* — and it is deliberately the only place the vocabulary
 * is chosen, so the browser's add flow and the agent-suggestion review can never describe the
 * same plan in two different registers.
 *
 * The exact filenames are still available, because a security gate that hides what it writes
 * is not a gate. They are one click away rather than in your face (`showFiles`), and the
 * review screen opens with them shown.
 */

// ---------------------------------------------------------------------------------------
// Telling the two flows apart
// ---------------------------------------------------------------------------------------

/**
 * The sentence stored on a record that a person raised by pressing "Add to server".
 *
 * There is no endpoint that installs a mod directly — the only path to a file on disk is a
 * proposal that gets approved (`apps/api/src/routes/proposals.ts`), and that is a deliberate
 * structural constraint, not an oversight to route around. So the browser's add walks the same
 * road: it asks the API to work the plan out, shows it, and then approves it. Which means a
 * by-hand add briefly *is* a record in the same table an agent's suggestion lands in.
 *
 * This string is how the two are told apart on the way back out. "Suggested for you" must not
 * list something you are in the middle of adding yourself — that is precisely the confusion
 * this whole rework exists to remove — so `isSelfRaised` filters those out of the suggestion
 * list while they are in flight. Anything that has actually gone wrong keeps its place: a
 * record carrying an `error` is news whoever raised it, and stays visible.
 *
 * It is also a true sentence in its own right, because it is what the audit trail will show a
 * year from now.
 */
export const ADDED_BY_HAND = 'Chosen and added by hand from the mod browser.';

/** Left on a record when somebody reads the plan and decides against it. */
export const CANCELLED_NOTE = 'Cancelled in the mod browser. Nothing was added.';

export function isSelfRaised(proposal: { rationale: string; error: string | null }): boolean {
  return proposal.rationale === ADDED_BY_HAND && proposal.error === null;
}

// ---------------------------------------------------------------------------------------
// Reading a resolution
// ---------------------------------------------------------------------------------------

export interface PlanSummary {
  /** The mod the person actually asked for, when the plan still contains it. */
  requested: PlannedInstall | null;
  /** Everything else that has to go on for the requested mod to work. */
  extras: PlannedInstall[];
  /** Entries that overwrite something already on this server. */
  replacements: PlannedInstall[];
  /** Already at the right version, so nothing is written for them. */
  untouched: PlannedInstall[];
  errors: ResolutionProblem[];
  warnings: ResolutionProblem[];
  /** Total files that would be written. */
  fileCount: number;
  /**
   * True when a person should read something before pressing the button — extra mods, an
   * overwrite, or any problem at all. False means "one file, no surprises", and the add flow
   * is allowed to just get on with it.
   */
  worthAPause: boolean;
}

export function summarisePlan(resolution: Resolution): PlanSummary {
  const requested = resolution.install.find((entry) => entry.reason === 'requested') ?? null;
  const extras = resolution.install.filter((entry) => entry.reason !== 'requested');
  const replacements = resolution.install.filter((entry) => entry.replacesVersionId !== null);
  const errors = resolution.problems.filter((problem) => problem.severity === 'error');
  const warnings = resolution.problems.filter((problem) => problem.severity !== 'error');

  return {
    requested,
    extras,
    replacements,
    untouched: [...resolution.satisfied],
    errors,
    warnings,
    fileCount: resolution.install.length,
    worthAPause:
      extras.length > 0 ||
      replacements.length > 0 ||
      resolution.problems.length > 0 ||
      !resolution.installable,
  };
}

/** `A`, `A and B`, `A, B and C` — an English list, not `join(', ')`. */
export function nameList(titles: readonly string[]): string {
  if (titles.length === 0) return '';
  if (titles.length === 1) return titles[0] ?? '';
  return `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`;
}

/**
 * The registry's problem vocabulary, in a sentence a person can act on.
 *
 * Keyed loosely rather than by the mirrored union: `apps/api/src/mods/resolve.ts` publishes
 * `already_installed`, which the hand-mirrored `ResolutionProblemKind` in `hooks/use-proposals.ts`
 * does not carry. An unknown kind falls back to the API's own message, which is written for a
 * human already — so a new kind degrades to slightly more technical prose, never to a blank.
 */
const PROBLEM_HEADLINE: Record<string, string> = {
  no_compatible_version: 'No version of this fits this server',
  wrong_loader: 'Built for a different kind of server',
  version_conflict: 'Two mods want different versions of the same thing',
  incompatible_with_installed: 'It clashes with a mod already on this server',
  incompatible_installed: 'Something already on this server does not fit it',
  dependency_cycle: 'These mods need each other in a circle',
  no_download: 'The author does not allow automatic downloads',
  unknown_game_version: 'This server has no fixed Minecraft version',
  prerelease_selected: 'Only a test build fits',
  modpack_managed: 'This server runs a modpack that manages its own mods',
  graph_too_large: 'It needs too many other mods to add in one go',
  lookup_failed: 'The registry did not answer',
  already_installed: 'It is already here',
};

export function problemHeadline(problem: ResolutionProblem): string | null {
  return PROBLEM_HEADLINE[problem.kind] ?? null;
}

// ---------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------

export function ProblemList({
  problems,
  className,
}: {
  problems: readonly ResolutionProblem[];
  className?: string;
}) {
  if (problems.length === 0) return null;

  return (
    <ul className={cn('flex flex-col gap-2', className)}>
      {problems.map((problem, index) => {
        const headline = problemHeadline(problem);
        return (
          <li
            className={cn(
              'rounded-sm border px-3 py-2 text-caption leading-normal',
              problem.severity === 'error'
                ? 'border-danger/25 bg-danger-subtle text-danger'
                : 'border-warning/25 bg-warning-subtle text-warning',
            )}
            key={`${problem.kind}-${problem.projectId ?? index}`}
          >
            <span className="font-medium">{headline ?? problem.title}.</span>{' '}
            <span>{problem.message}</span>
          </li>
        );
      })}
    </ul>
  );
}

function FileRow({ entry }: { entry: PlannedInstall }) {
  return (
    <li className="flex items-start gap-3 border-t border-separator py-3 first:border-t-0 first:pt-0">
      <ModIcon iconUrl={entry.iconUrl} size="sm" title={entry.title} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-sans text-subhead font-semibold text-label">{entry.title}</span>
          <code className="font-mono text-caption text-label-secondary">
            {entry.version.versionNumber}
          </code>
          {entry.reason === 'requested' ? null : (
            <span className="text-caption text-label-tertiary">
              {entry.reason === 'update' ? 'a newer copy of one you have' : 'needed by the above'}
            </span>
          )}
        </p>
        <p className="mt-0.5 text-caption text-label-secondary">
          Saved as{' '}
          <code className="font-mono text-label">
            {entry.target}/{entry.version.file.filename}
          </code>
          <span aria-hidden> · </span>
          <span className="tabular">{formatBytes(entry.version.file.sizeBytes)}</span>
        </p>
        {entry.replacesVersionId === null ? null : (
          <p className="mt-0.5 text-caption text-label-tertiary">
            Overwrites the copy already on this server.
          </p>
        )}
      </div>
    </li>
  );
}

export interface InstallPlanProps {
  resolution: Resolution;
  /** The project this plan was built for, so the sentences can name it. */
  title: string;
  /** Start with the filenames on screen. The review gate does; the add flow does not. */
  showFiles?: boolean;
  className?: string;
}

/**
 * The plan, in plain language, with the exact files a click away.
 *
 * Nothing here has happened yet, in either of the two flows that render it. The wording says
 * "adds" and "replaces" in the present tense of *what this button does*, never in the past
 * tense of what it did.
 */
export function InstallPlan({ resolution, title, showFiles = false, className }: InstallPlanProps) {
  const [filesOpen, setFilesOpen] = useState(showFiles);
  const plan = summarisePlan(resolution);
  const extraNames = nameList(plan.extras.map((entry) => entry.title));
  const untouchedNames = nameList(plan.untouched.map((entry) => entry.title));

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <ul className="flex flex-col gap-1.5 text-subhead text-label-secondary">
        {plan.requested === null && plan.fileCount === 0 ? (
          <li>Nothing to download — {title} and everything it needs are already on this server.</li>
        ) : null}

        {plan.requested === null ? null : (
          <li>
            <span className="font-medium text-label">Adds {plan.requested.title}</span>{' '}
            <code className="font-mono text-caption">{plan.requested.version.versionNumber}</code>.
          </li>
        )}

        {plan.extras.length > 0 ? (
          <li>
            <span className="font-medium text-label">
              Adds {plan.extras.length} more {plan.extras.length === 1 ? 'mod' : 'mods'} it needs
            </span>{' '}
            — {extraNames}.
          </li>
        ) : null}

        {plan.replacements.length > 0 ? (
          <li>
            <span className="font-medium text-label">
              Replaces the {plan.replacements.length === 1 ? 'version' : 'versions'} you have
            </span>{' '}
            of {nameList(plan.replacements.map((entry) => entry.title))}.
          </li>
        ) : null}

        {plan.untouched.length > 0 ? (
          <li className="text-label-tertiary">
            Already up to date, so left alone: {untouchedNames}.
          </li>
        ) : null}
      </ul>

      <ProblemList problems={[...plan.errors, ...plan.warnings]} />

      {plan.fileCount > 0 ? (
        <div className="flex flex-col gap-2">
          <Button
            aria-expanded={filesOpen}
            className="h-11 w-fit rounded-button px-4 text-subhead font-medium"
            onClick={() => setFilesOpen((open) => !open)}
            variant="ghost"
          >
            {filesOpen
              ? 'Hide the exact files'
              : `Show the exact ${plan.fileCount === 1 ? 'file' : `${plan.fileCount} files`}`}
          </Button>
          {filesOpen ? (
            <ul className={cn(modSurface, 'flex flex-col px-4 py-3')}>
              {resolution.install.map((entry) => (
                <FileRow entry={entry} key={`${entry.source}:${entry.projectId}`} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
