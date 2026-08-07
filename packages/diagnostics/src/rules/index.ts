import type { Category, Rule, Severity } from '../types';
import { eulaNotAccepted, invalidServerType } from './config';
import { javaTooNewForLegacyForge, javaTooNewForMixin, javaTooOld } from './java';
import { containerKilled, javaOutOfMemory, killedDuringSave } from './memory';
import {
  clientOnlyMod,
  duplicateMod,
  fabricMissingDependency,
  forgeMissingDependency,
  mixinApplyFailure,
} from './mods';
import {
  dataNotWritable,
  diskFull,
  downloadFailed,
  portInUse,
  serverPaused,
  watchdogTimeout,
  worldCorruption,
} from './system';

/**
 * Everything Platter knows how to diagnose.
 *
 * The order here is the order rules are evaluated, and it is not arbitrary: cheap
 * context-only checks and unambiguous single-string matches come before the rules that walk
 * stack traces. It is not a priority order — `diagnose()` sorts findings by severity and
 * confidence afterwards — but a crash-looping server re-runs this on every restart, so the
 * cheap answers should be reachable without paying for the expensive ones.
 *
 * This array is exported as-is so the UI can render "what Platter knows how to diagnose"
 * without a second, drifting copy of the list.
 */
export const RULES: readonly Rule[] = [
  // Configuration the container rejects before Java starts.
  eulaNotAccepted,
  invalidServerType,

  // Java version mismatches — the most common startup failure of all.
  javaTooOld,
  javaTooNewForMixin,
  javaTooNewForLegacyForge,

  // Memory, in its three distinct shapes.
  javaOutOfMemory,
  containerKilled,
  killedDuringSave,

  // Host-level problems that stop the server before it can log anything itself.
  downloadFailed,
  dataNotWritable,
  diskFull,
  portInUse,

  // Mods.
  fabricMissingDependency,
  forgeMissingDependency,
  duplicateMod,
  clientOnlyMod,
  mixinApplyFailure,

  // World integrity and liveness.
  worldCorruption,
  watchdogTimeout,

  // Informational: prevents a false "everything is fine".
  serverPaused,
];

/** Lookup by id, for callers resolving a stored finding back to its rule. */
export const RULES_BY_ID: ReadonlyMap<string, Rule> = new Map(RULES.map((r) => [r.id, r]));

/** A rule's public description, without its matching internals. For the UI catalogue. */
export interface RuleSummary {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  readonly category: Category;
}

export function ruleCatalogue(): RuleSummary[] {
  return RULES.map((r) => ({
    id: r.id,
    title: r.title,
    severity: r.severity,
    category: r.category,
  }));
}

export {
  clientOnlyMod,
  containerKilled,
  dataNotWritable,
  diskFull,
  downloadFailed,
  duplicateMod,
  eulaNotAccepted,
  fabricMissingDependency,
  forgeMissingDependency,
  invalidServerType,
  javaOutOfMemory,
  javaTooNewForLegacyForge,
  javaTooNewForMixin,
  javaTooOld,
  killedDuringSave,
  mixinApplyFailure,
  portInUse,
  serverPaused,
  watchdogTimeout,
  worldCorruption,
};
