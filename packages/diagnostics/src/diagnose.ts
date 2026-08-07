import { toBlocks } from './parse';
import { RULES } from './rules';
import {
  CONFIDENCE_RANK,
  type DiagnoseInput,
  type Diagnosis,
  type Evidence,
  type Finding,
  type LogBlock,
  type Match,
  type MatchContext,
  type Rule,
  SEVERITY_RANK,
} from './types';

/**
 * The engine.
 *
 * Two constraints shape it. First, this runs on every crash, and a crash-looping server
 * generates log faster than anything else Platter does — so the whole thing is one pass over the
 * lines, one pass to build blocks, and then a cheap literal-substring gate before any rule's
 * regexes are allowed near the text. Second, the output is read by a model that will relay it to
 * a human who has to decide whether to let Platter change their server. That means findings have
 * to carry their evidence, and the summary has to be a sentence rather than a count.
 */

/** How many log lines are shown as evidence per finding. Enough to see the cause, not the whole trace. */
const EVIDENCE_LINES = 12;

/**
 * Build the lowercased haystack the `hints` gate tests against.
 *
 * One allocation for the whole window, reused by every rule. Bounded because the gate is an
 * optimisation: past a certain size the scan costs more than it saves, and a rule whose evidence
 * is beyond the cap will still be found by the rules that do not use hints at all.
 */
const MAX_HAYSTACK_CHARS = 2_000_000;

function buildHaystack(blocks: readonly LogBlock[]): string {
  let out = '';
  for (const block of blocks) {
    if (out.length >= MAX_HAYSTACK_CHARS) {
      break;
    }
    out += `${block.text.toLowerCase()}\n`;
  }
  return out;
}

/** Skip a rule outright when none of its hints occur anywhere in the window. */
function mayMatch(rule: Rule, haystack: string): boolean {
  if (rule.hints === undefined || rule.hints.length === 0) {
    return true;
  }
  return rule.hints.some((hint) => haystack.includes(hint));
}

function toEvidence(m: Match): Evidence {
  const lines: string[] = [];
  let firstSeq = Number.POSITIVE_INFINITY;
  let lastSeq = Number.NEGATIVE_INFINITY;

  for (const block of m.blocks) {
    firstSeq = Math.min(firstSeq, block.firstSeq);
    lastSeq = Math.max(lastSeq, block.lastSeq);
    for (const line of block.lines) {
      if (lines.length < EVIDENCE_LINES) {
        lines.push(line.raw);
      }
    }
  }

  return {
    lines,
    firstSeq: Number.isFinite(firstSeq) ? firstSeq : 0,
    lastSeq: Number.isFinite(lastSeq) ? lastSeq : 0,
  };
}

/**
 * Normalise the two accepted input shapes into one context.
 *
 * `exitCode` and `health` are read from `server` first because a caller that bothered to nest
 * them there is describing the container it just inspected, which is the more specific claim.
 */
function toContext(input: DiagnoseInput, blocks: readonly LogBlock[]): MatchContext {
  const server = input.server ?? {};
  const rawExit = server.exitCode ?? input.exitCode;
  const health = server.health ?? input.health;
  const mods = input.mods ?? input.installed ?? [];

  return {
    blocks,
    server,
    ...(rawExit === undefined || rawExit === null ? {} : { exitCode: rawExit }),
    ...(health === undefined ? {} : { health }),
    ...(input.oomKilled === undefined ? {} : { oomKilled: input.oomKilled }),
    ...(input.paused === undefined ? {} : { paused: input.paused }),
    mods,
  };
}

/**
 * Order findings the way a person would want to read them.
 *
 * Severity first, then how sure we are, then position in the log — earliest last. That last tie
 * break is deliberate and slightly counter-intuitive: within one severity, the *first* error is
 * usually the cause and everything after it is fallout, so it sorts to the top.
 */
function compareFindings(a: Finding, b: Finding): number {
  const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (bySeverity !== 0) {
    return bySeverity;
  }
  const byConfidence = CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence];
  if (byConfidence !== 0) {
    return byConfidence;
  }
  return a.evidence.firstSeq - b.evidence.firstSeq;
}

/**
 * One sentence somebody can act on.
 *
 * Never a count ("3 issues found") — a count tells you nothing you cannot see, and it is what
 * every other panel does. The top finding's title plus its leading fix is the shortest thing
 * that is actually useful.
 */
function buildSummary(findings: readonly Finding[], analysedLines: number): string {
  const top = findings[0];
  if (top === undefined) {
    return analysedLines === 0
      ? 'There were no logs to look at, so nothing could be checked.'
      : `Nothing wrong found in the last ${analysedLines} lines of log.`;
  }

  const blocking = findings.filter((f) => f.severity === 'critical' || f.severity === 'error');
  const fix = top.fixes[0];
  const remedy = fix === undefined ? '' : ` Suggested fix: ${lowerFirst(fix.title)}.`;

  if (blocking.length > 1) {
    return `${top.title}.${remedy} ${blocking.length - 1} other problem${
      blocking.length === 2 ? '' : 's'
    } may also need attention.`;
  }
  if (top.severity === 'info') {
    return `${top.title}.${remedy}`;
  }
  return `${top.title}.${remedy}`;
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0]?.toLowerCase() + text.slice(1);
}

/**
 * Run every rule over a window of log.
 *
 * Pure: no I/O, no clock, no randomness. The same lines and the same facts always produce the
 * same diagnosis, which is what lets the MCP server hand a model a log window it already has and
 * lets the test suite pin behaviour to real log excerpts.
 */
export function diagnose(input: DiagnoseInput): Diagnosis {
  const blocks = toBlocks(input.lines);
  const ctx = toContext(input, blocks);
  const haystack = buildHaystack(blocks);

  const matched: { rule: Rule; match: Match }[] = [];
  for (const rule of RULES) {
    if (!mayMatch(rule, haystack)) {
      continue;
    }
    const found = rule.match(ctx);
    if (found !== null) {
      matched.push({ rule, match: found });
    }
  }

  // A rule that explains another rule's finding removes it. This is how "the JVM is wrong" stops
  // Platter also reporting "this mod failed to patch the game" — true, but a symptom, and acting
  // on it would mean deleting a mod that was never broken.
  const superseded = new Set<string>();
  for (const { rule } of matched) {
    for (const id of rule.supersedes ?? []) {
      superseded.add(id);
    }
  }

  const findings: Finding[] = matched
    .filter(({ rule }) => !superseded.has(rule.id))
    .map(({ rule, match }) => ({
      ruleId: rule.id,
      title: rule.title,
      severity: rule.severity,
      category: rule.category,
      explanation: rule.explain(match),
      confidence: match.confidence,
      evidence: toEvidence(match),
      fixes: rule.fixes(match),
    }))
    .sort(compareFindings);

  const first = input.lines[0];
  const last = input.lines[input.lines.length - 1];

  return {
    summary: buildSummary(findings, input.lines.length),
    findings,
    healthy: !findings.some((f) => f.severity === 'critical' || f.severity === 'error'),
    analysedLines: input.lines.length,
    window: { from: first?.seq ?? 0, to: last?.seq ?? 0 },
  };
}
