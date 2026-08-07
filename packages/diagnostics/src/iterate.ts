import { formatMiB } from './memory';
import {
  CONFIDENCE_RANK,
  type Diagnosis,
  type Finding,
  type Fix,
  type FixAction,
  type FixActionType,
  SEVERITY_RANK,
  type Severity,
} from './types';

/**
 * Turning a diagnosis into a plan.
 *
 * A crashed server usually produces several findings, and their fixes are not independent. Left
 * unordered they contradict each other: one rule wants 6 GB and another wants 8, one wants a mod
 * deleted while another wants the Java version changed — which would have made that mod work
 * fine. Applying both is worse than applying either.
 *
 * So `planFixes` does three things and refuses to do a fourth. It removes fixes that a better
 * fix makes pointless, it collapses conflicting settings to a single value, and it orders what
 * is left so the cheap and reversible go first. It does not decide *whether* to apply anything —
 * that is a person's decision, and `explainPlan` exists to give them what they need to make it.
 */

export interface PlannedFix {
  readonly fix: Fix;
  /** The finding this came from, so approval UI can show the reasoning next to the action. */
  readonly ruleId: string;
  readonly findingTitle: string;
  readonly severity: Severity;
  /** 1-based position in the plan. */
  readonly order: number;
}

export interface SkippedFix {
  readonly fix: Fix;
  readonly ruleId: string;
  /** Why it was dropped, in words a person can read. */
  readonly reason: string;
}

export interface FixPlan {
  readonly steps: readonly PlannedFix[];
  readonly skipped: readonly SkippedFix[];
  /** True when any step would change the server. A plan of pure advice needs no approval. */
  readonly requiresApproval: boolean;
  /** True when any step destroys data that cannot be recovered by undoing it. */
  readonly destructive: boolean;
}

/**
 * How disruptive each kind of change is, lowest first.
 *
 * Ordering by this rather than by severity is deliberate: if a cheap reversible change might fix
 * the problem, it should be tried before one that deletes a mod or rolls a world back, even when
 * the destructive fix addresses a more severe finding.
 */
const ACTION_COST: Readonly<Record<FixActionType, number>> = {
  accept_eula: 0,
  retry_start: 1,
  repair_permissions: 2,
  reallocate_port: 2,
  change_java_version: 3,
  set_memory: 3,
  set_setting: 4,
  set_loader_version: 5,
  free_disk_space: 5,
  install_mod: 6,
  update_mod: 7,
  remove_mod: 8,
  restore_backup: 9,
};

/** Changes that cannot simply be undone by applying the opposite change. */
const DESTRUCTIVE: ReadonlySet<FixActionType> = new Set<FixActionType>([
  'remove_mod',
  'restore_backup',
  'free_disk_space',
]);

function cost(fix: Fix): number {
  return fix.action === undefined ? 10 : (ACTION_COST[fix.action.type] ?? 10);
}

/** Two actions are the same step if they would make the same change. */
function actionKey(action: FixAction): string {
  switch (action.type) {
    case 'set_memory':
      return `set_memory:${action.memoryMiB}`;
    case 'change_java_version':
      return `change_java_version:${action.java}`;
    case 'remove_mod':
      return `remove_mod:${action.match}`;
    case 'update_mod':
      return `update_mod:${action.match}`;
    case 'install_mod':
      return `install_mod:${action.ref.id}`;
    case 'set_setting':
      return `set_setting:${action.key}`;
    case 'set_loader_version':
      return `set_loader_version:${action.loader}`;
    case 'restore_backup':
      return `restore_backup:${action.backupId ?? 'latest'}`;
    default:
      return action.type;
  }
}

interface Candidate {
  readonly fix: Fix;
  readonly finding: Finding;
}

/**
 * Build an ordered, non-conflicting plan.
 *
 * The passes run in this order because each depends on the last: supersession needs to know
 * every action type present, conflict resolution needs the survivors, and ordering needs the
 * final set.
 */
export function planFixes(diagnosis: Diagnosis): FixPlan {
  const candidates: Candidate[] = [];
  for (const finding of diagnosis.findings) {
    for (const fix of finding.fixes) {
      candidates.push({ fix, finding });
    }
  }

  const skipped: SkippedFix[] = [];
  const presentActions = new Set<FixActionType>();
  for (const { fix } of candidates) {
    if (fix.action !== undefined) {
      presentActions.add(fix.action.type);
    }
  }

  // Pass 1 — supersession. A fix that declared what beats it steps aside when that appears.
  const afterSupersession = candidates.filter(({ fix, finding }) => {
    const beatenBy = (fix.supersededBy ?? []).find((type) => presentActions.has(type));
    if (beatenBy === undefined) {
      return true;
    }
    skipped.push({
      fix,
      ruleId: finding.ruleId,
      reason: `Not needed once ${describeActionType(beatenBy)} is applied.`,
    });
    return false;
  });

  // Pass 2 — conflicts. Memory is the one setting several rules all want to change at once, and
  // the highest recommendation subsumes the rest: a server that needs 8 GB also satisfies the
  // rule that asked for 6.
  const memoryFixes = afterSupersession.filter((c) => c.fix.action?.type === 'set_memory');
  let keptMemory: Candidate | undefined;
  for (const candidate of memoryFixes) {
    const action = candidate.fix.action;
    if (action?.type !== 'set_memory') {
      continue;
    }
    const kept = keptMemory?.fix.action;
    if (kept?.type !== 'set_memory' || action.memoryMiB > kept.memoryMiB) {
      keptMemory = candidate;
    }
  }

  // Pass 3 — identical actions proposed by two different rules collapse to one step.
  const seen = new Set<string>();
  const steps: Candidate[] = [];

  for (const candidate of afterSupersession) {
    const action = candidate.fix.action;

    if (action?.type === 'set_memory' && candidate !== keptMemory) {
      const winner = keptMemory?.fix.action;
      skipped.push({
        fix: candidate.fix,
        ruleId: candidate.finding.ruleId,
        reason:
          winner?.type === 'set_memory'
            ? `Superseded by the larger increase to ${formatMiB(winner.memoryMiB)}.`
            : 'Superseded by another memory change.',
      });
      continue;
    }

    if (action !== undefined) {
      const key = actionKey(action);
      if (seen.has(key)) {
        skipped.push({
          fix: candidate.fix,
          ruleId: candidate.finding.ruleId,
          reason: 'Already covered by an identical step.',
        });
        continue;
      }
      seen.add(key);
    }

    steps.push(candidate);
  }

  steps.sort(compareCandidates);

  const planned: PlannedFix[] = steps.map((c, i) => ({
    fix: c.fix,
    ruleId: c.finding.ruleId,
    findingTitle: c.finding.title,
    severity: c.finding.severity,
    order: i + 1,
  }));

  return {
    steps: planned,
    skipped,
    requiresApproval: planned.some((s) => s.fix.kind === 'automatic'),
    destructive: planned.some(
      (s) => s.fix.action !== undefined && DESTRUCTIVE.has(s.fix.action.type)
    ),
  };
}

/**
 * Order: worst problem first, then cheapest change, then most confident.
 *
 * Severity leads because a plan that fixes a warning before a crash reads as though nobody
 * looked at it. Within one severity, cost leads confidence — trying the reversible thing first
 * costs a restart, and being wrong about a destructive change costs a world.
 */
function compareCandidates(a: Candidate, b: Candidate): number {
  const bySeverity = SEVERITY_RANK[b.finding.severity] - SEVERITY_RANK[a.finding.severity];
  if (bySeverity !== 0) {
    return bySeverity;
  }
  const byCost = cost(a.fix) - cost(b.fix);
  if (byCost !== 0) {
    return byCost;
  }
  const byConfidence = CONFIDENCE_RANK[b.fix.confidence] - CONFIDENCE_RANK[a.fix.confidence];
  if (byConfidence !== 0) {
    return byConfidence;
  }
  // Automatic before manual, so the approval list is contiguous.
  if (a.fix.kind !== b.fix.kind) {
    return a.fix.kind === 'automatic' ? -1 : 1;
  }
  return a.fix.id.localeCompare(b.fix.id);
}

function describeActionType(type: FixActionType): string {
  switch (type) {
    case 'change_java_version':
      return 'the Java version change';
    case 'set_memory':
      return 'the memory increase';
    case 'restore_backup':
      return 'the backup restore';
    case 'reallocate_port':
      return 'the port change';
    case 'install_mod':
      return 'the missing mod install';
    case 'update_mod':
      return 'the mod update';
    case 'remove_mod':
      return 'the mod removal';
    case 'repair_permissions':
      return 'the permissions repair';
    case 'accept_eula':
      return 'accepting the licence';
    case 'free_disk_space':
      return 'freeing disk space';
    case 'retry_start':
      return 'retrying the start';
    case 'set_loader_version':
      return 'the loader version change';
    case 'set_setting':
      return 'the settings change';
    default:
      return 'another fix';
  }
}

/**
 * Prose a model can relay to a person deciding whether to approve.
 *
 * Written to be read aloud. It says what will happen, in order, and separates the changes
 * Platter can make from the ones a human has to — because "I will do these four things and you
 * need to do these two" is the answer someone actually needs, and a list of fix ids is not.
 */
export function explainPlan(plan: FixPlan): string {
  if (plan.steps.length === 0) {
    return 'There is nothing to do — no fixes were suggested.';
  }

  const automatic = plan.steps.filter((s) => s.fix.kind === 'automatic');
  const manual = plan.steps.filter((s) => s.fix.kind === 'manual');
  const paragraphs: string[] = [];

  if (automatic.length > 0) {
    const lead =
      automatic.length === 1
        ? 'Platter can make one change for you:'
        : `Platter can make ${automatic.length} changes for you, in this order:`;
    const body = automatic
      .map((s, i) => `${i + 1}. ${s.fix.title}. ${s.fix.detail}${confidenceNote(s.fix)}`)
      .join('\n');
    paragraphs.push(`${lead}\n${body}`);
  }

  if (manual.length > 0) {
    const lead =
      manual.length === 1
        ? 'One thing needs you rather than Platter:'
        : `${manual.length} things need you rather than Platter:`;
    const body = manual.map((s, i) => `${i + 1}. ${s.fix.title}. ${s.fix.detail}`).join('\n');
    paragraphs.push(`${lead}\n${body}`);
  }

  if (plan.destructive) {
    paragraphs.push(
      'One or more of these cannot be undone by simply reversing it — removing a mod or ' +
        'restoring a backup changes what is on disk. Platter takes a snapshot before it starts, ' +
        'so there is always a way back, but it is worth reading those steps carefully.'
    );
  }

  if (plan.skipped.length > 0) {
    const reasons = plan.skipped.map((s) => `${s.fix.title} — ${s.reason}`).join('\n');
    paragraphs.push(
      `Some suggestions were left out because other steps make them unnecessary:\n${reasons}`
    );
  }

  return paragraphs.join('\n\n');
}

function confidenceNote(fix: Fix): string {
  switch (fix.confidence) {
    case 'high':
      return '';
    case 'medium':
      return ' This is likely but not certain to help.';
    default:
      return ' This is a guess — try it only if the earlier steps did not work.';
  }
}
