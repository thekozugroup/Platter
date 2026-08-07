/**
 * Platter's diagnosis engine.
 *
 * Give it a window of container log and whatever Platter knows about the server, get back an
 * explanation a person can act on and a set of fixes a machine can apply. It is a pure function
 * — no I/O, no clock, no network — which is what lets the MCP server call it on a log window it
 * already holds, and lets every rule be pinned to a real log excerpt in the test suite.
 *
 * Typical use:
 *
 *     const diagnosis = diagnose({ lines, server, exitCode });
 *     if (!diagnosis.healthy) {
 *       const plan = planFixes(diagnosis);
 *       await askForApproval(explainPlan(plan), plan.steps);
 *     }
 */

export { diagnose } from './diagnose';
export type { FixPlan, PlannedFix, SkippedFix } from './iterate';
export { explainPlan, planFixes } from './iterate';
export type { MemoryRecommendation } from './memory';
export {
  baselineForWorkload,
  formatMiB,
  MAX_RECOMMENDED_MiB,
  recommendHeadroom,
  recommendMemory,
} from './memory';

export { groupTraces, parseLine, parseLines, toBlocks } from './parse';
export type { RuleSummary } from './rules';

/** The full catalogue, so the UI can render what Platter knows how to diagnose. */
export { RULES, RULES_BY_ID, ruleCatalogue } from './rules';
export {
  AVAILABLE_JAVA_VERSIONS,
  javaVersionForClassFile,
  snapToAvailableJava,
} from './rules/java';
export type {
  Category,
  Confidence,
  DiagnoseInput,
  Diagnosis,
  Evidence,
  Finding,
  Fix,
  FixAction,
  FixActionType,
  HealthStatus,
  InstalledMod,
  LogBlock,
  LogLevel,
  LogSource,
  Match,
  MatchContext,
  MatchDetail,
  ModReference,
  ParsedLine,
  RawLogLine,
  Rule,
  ServerFacts,
  Severity,
} from './types';
export {
  CATEGORIES,
  CONFIDENCE_RANK,
  CONFIDENCES,
  modIdentity,
  SEVERITIES,
  SEVERITY_RANK,
} from './types';
