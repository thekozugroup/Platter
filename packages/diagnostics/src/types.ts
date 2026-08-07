import type { MinecraftLoader } from '@platter/shared';

/**
 * The vocabulary the diagnosis engine speaks.
 *
 * Everything here is plain data. Nothing in this package holds a socket, reads a file or closes
 * over a callback, because a diagnosis has to survive three trips it would not otherwise:
 * into SQLite as an audit record, across the MCP boundary to a model, and back out to a human
 * who has to approve a fix before Platter touches their server. A `Fix` that carried a
 * `() => Promise<void>` could do none of those.
 */

/* -------------------------------------------------------------------------- */
/* Input                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One raw container log line.
 *
 * Structurally identical to `LogLine` in `@platter/core`'s `docker/logs`, and deliberately
 * re-declared rather than imported: core calls *into* this package when a container dies, so
 * importing core from here would close a dependency cycle. Structural typing means a
 * `LogLine[]` is accepted at the call site with no adapter and no cast.
 */
export interface RawLogLine {
  seq: number;
  stream: 'stdout' | 'stderr';
  /**
   * Docker's timestamp, epoch milliseconds.
   *
   * `null` is accepted alongside `undefined` because callers that hydrate a log window from
   * SQLite get `null` back for a missing column, and making every one of them normalise before
   * calling in would be a needless trap.
   */
  timestamp?: number | null | undefined;
  text: string;
}

/* -------------------------------------------------------------------------- */
/* Parsed log model                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Who emitted a line.
 *
 * This matters more than it looks. `[init]` lines come from the image's shell entrypoint and
 * are gone by the time the JVM starts; `minecraft` lines come from log4j and can be reformatted
 * by a mod; `jvm` lines (stack frames, `Exception in thread`, hs_err preamble) have no
 * timestamp at all. A rule that assumes one shape misses the other two.
 */
export type LogSource = 'minecraft' | 'entrypoint' | 'jvm' | 'unknown';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface ParsedLine {
  /** The original text, ANSI stripped. Kept so evidence can be shown exactly as logged. */
  raw: string;
  seq: number;
  stream: 'stdout' | 'stderr';
  /** Docker's timestamp, epoch milliseconds. */
  timestamp?: number;
  /** The wall clock the server itself printed, e.g. `21:04:11`. Not the same as `timestamp`. */
  time?: string;
  thread?: string;
  level?: LogLevel;
  logger?: string;
  /** The log4j marker, e.g. `CORE` in `[net.minecraftforge.fml.Foo/CORE]`. */
  marker?: string;
  /** The line with its prefix removed. For an unrecognised line, the whole line. */
  message: string;
  source: LogSource;
}

/**
 * A log record and everything that continues it.
 *
 * A Java failure is never one line. `NoClassDefFoundError` on line 1 tells you nothing; the
 * `Caused by:` forty lines down names the mod, and the `at somemod@1.2.3/...` frame in between
 * is the only place the mod id appears at all. Rules therefore match against `text` — the whole
 * block — and never against a single line.
 */
export interface LogBlock {
  readonly lines: readonly ParsedLine[];
  readonly head: ParsedLine;
  /** Every line's message, newline-joined. This is what rules run their regexes over. */
  readonly text: string;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly level?: LogLevel;
  readonly source: LogSource;
  readonly thread?: string;
  readonly logger?: string;
  /** True when at least one line is a Java stack frame. Used to reject prose that quotes an error. */
  readonly hasStackTrace: boolean;
  /** True when the block was cut off by the size cap; evidence is incomplete. */
  readonly truncated: boolean;
}

/* -------------------------------------------------------------------------- */
/* Rule vocabulary                                                             */
/* -------------------------------------------------------------------------- */

export const SEVERITIES = ['critical', 'error', 'warning', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  'java',
  'memory',
  'mods',
  'config',
  'network',
  'world',
  'startup',
  'permissions',
  'disk',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

/** Ordering weights. Higher sorts first. */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 3,
  error: 2,
  warning: 1,
  info: 0,
};

export const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = {
  high: 2,
  medium: 1,
  low: 0,
};

/* -------------------------------------------------------------------------- */
/* Fixes                                                                       */
/* -------------------------------------------------------------------------- */

/** How a mod is named to the installer. Ids come straight out of the log, verbatim. */
export interface ModReference {
  /** The id as the loader printed it — `fabric-api`, `jei`, `create`. */
  readonly id: string;
  /** Human name when the loader gave one, e.g. `Fabric API`. */
  readonly name?: string;
  /**
   * The range the loader asked for, verbatim: `[47.2.0,)` from Forge, `version 0.83.0 or later`
   * from Fabric. Deliberately not normalised — the two loaders use incompatible grammars and
   * guessing at a common one is how you install the wrong file.
   */
  readonly versionRange?: string;
  readonly provider?: 'modrinth' | 'curseforge';
}

/**
 * A machine-applicable fix, described rather than performed.
 *
 * Each variant names something `@platter/core` already knows how to do. The engine never
 * executes one: `diagnose()` proposes, `planFixes()` orders, a human (or a model relaying to a
 * human) approves, and only then does core act. Keeping these serialisable is what makes that
 * approval step possible at all — you cannot render a closure for review.
 */
export type FixAction =
  | { readonly type: 'accept_eula' }
  /** Container memory ceiling. The heap is derived from it by `heapForContainer()` in shared. */
  | { readonly type: 'set_memory'; readonly memoryMiB: number }
  | { readonly type: 'change_java_version'; readonly java: number }
  /** `match` is a mod id or a filename fragment — whatever the log actually gave us. */
  | { readonly type: 'remove_mod'; readonly match: string }
  | { readonly type: 'install_mod'; readonly ref: ModReference }
  | { readonly type: 'update_mod'; readonly match: string; readonly ref?: ModReference }
  /** An itzg env var or a `server.properties` key. */
  | { readonly type: 'set_setting'; readonly key: string; readonly value: string }
  | { readonly type: 'set_loader_version'; readonly loader: string; readonly version: string }
  | { readonly type: 'restore_backup'; readonly backupId?: string }
  | { readonly type: 'reallocate_port' }
  | { readonly type: 'repair_permissions' }
  | { readonly type: 'free_disk_space'; readonly neededMiB?: number }
  | { readonly type: 'retry_start' };

export type FixActionType = FixAction['type'];

export interface Fix {
  /** Stable within a finding, so the UI can remember what the user already declined. */
  readonly id: string;
  readonly title: string;
  /** One or two sentences. Says what will change and what it costs. */
  readonly detail: string;
  /** `automatic` means Platter can carry it out; `manual` means a human has to. */
  readonly kind: 'automatic' | 'manual';
  readonly action?: FixAction;
  readonly confidence: Confidence;
  /**
   * Action types that make this fix pointless.
   *
   * A mod that only crashes because the JVM is wrong does not need removing — it needs the
   * right JVM. Rather than teaching the planner about every such pair, the guessing fix
   * declares what beats it and `planFixes()` honours that.
   */
  readonly supersededBy?: readonly FixActionType[];
}

/* -------------------------------------------------------------------------- */
/* Matching                                                                    */
/* -------------------------------------------------------------------------- */

/** Values a rule can pull out of a log and hand to `explain()`/`fixes()`. Serialisable on purpose. */
export type MatchDetail = string | number | boolean | readonly string[];

export interface Match {
  /** The blocks that justify the finding. Shown to the user as evidence. */
  readonly blocks: readonly LogBlock[];
  /** Whatever the rule parsed out — mod ids, version ranges, class file versions. */
  readonly details: Readonly<Record<string, MatchDetail>>;
  readonly confidence: Confidence;
}

export type HealthStatus = 'healthy' | 'unhealthy' | 'starting' | 'none';

/**
 * What Platter knows about the server independently of its logs.
 *
 * `exitCode` and `health` are accepted here as well as at the top level of `DiagnoseInput`,
 * because both readings are defensible — they are facts about the container, which is a fact
 * about the server — and callers split on it. `diagnose()` takes whichever is present.
 */
export interface ServerFacts {
  readonly loader?: MinecraftLoader;
  readonly gameVersion?: string;
  /** Java major version the container actually runs, e.g. 21. */
  readonly javaVersion?: number;
  /** Container memory ceiling in MiB — not the heap. */
  readonly memoryMiB?: number;
  /** Whether `ENABLE_AUTOPAUSE` is on. Changes what a watchdog timeout means. */
  readonly autopauseEnabled?: boolean;
  /** Platter's lifecycle status, e.g. `crashed`. Free-form here to avoid a cycle on core. */
  readonly status?: string;
  readonly exitCode?: number | null;
  readonly health?: HealthStatus;
}

/**
 * A mod or plugin Platter believes is installed.
 *
 * Every field is optional because callers hold different subsets: the mod service knows the
 * Modrinth slug, a directory scan knows only a filename, and a modpack install knows the
 * display name. `modIdentity()` picks the most specific one available rather than forcing the
 * caller to invent an id it does not have.
 */
export interface InstalledMod {
  readonly id?: string;
  readonly slug?: string;
  readonly name?: string;
  readonly version?: string;
  readonly fileName?: string;
  readonly provider?: 'modrinth' | 'curseforge' | 'manual';
}

/** The best available name for a mod, for matching against ids the loader printed. */
export function modIdentity(mod: InstalledMod): string {
  return mod.id ?? mod.slug ?? mod.name ?? mod.fileName ?? '';
}

export interface MatchContext {
  readonly blocks: readonly LogBlock[];
  readonly server: ServerFacts;
  /** The container's exit code, when it has exited. 137 is overloaded — see the memory rules. */
  readonly exitCode?: number;
  readonly health?: HealthStatus;
  /**
   * `docker inspect -f '{{.State.OOMKilled}}'`. The only way to tell a kernel OOM kill from a
   * shutdown that outran its grace period, since both exit 137.
   */
  readonly oomKilled?: boolean;
  /** Whether `/data/.paused` exists. A paused server passes its healthcheck. */
  readonly paused?: boolean;
  readonly mods: readonly InstalledMod[];
}

export interface Rule {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  readonly category: Category;
  /**
   * Cheap literal substrings, lowercased. If none occur anywhere in the window, `match()` is
   * skipped entirely. A crash-looping server can produce tens of thousands of lines and this
   * runs on every crash, so the common case — a rule that has nothing to say — must cost one
   * `includes()` rather than a full scan.
   *
   * Omit for rules that key off context (exit code, pause state) rather than log text.
   */
  readonly hints?: readonly string[];
  /** Rules whose findings are symptoms of this one, and should be dropped when this fires. */
  readonly supersedes?: readonly string[];
  match(ctx: MatchContext): Match | null;
  /** Plain English. No class names, no acronyms, no "simply". */
  explain(m: Match): string;
  fixes(m: Match): Fix[];
}

/* -------------------------------------------------------------------------- */
/* Output                                                                      */
/* -------------------------------------------------------------------------- */

export interface Evidence {
  /** The log lines, exactly as they appeared. */
  readonly lines: readonly string[];
  readonly firstSeq: number;
  readonly lastSeq: number;
}

export interface Finding {
  readonly ruleId: string;
  readonly title: string;
  readonly severity: Severity;
  readonly category: Category;
  readonly explanation: string;
  readonly confidence: Confidence;
  readonly evidence: Evidence;
  readonly fixes: readonly Fix[];
}

export interface Diagnosis {
  /** One sentence a human can act on. Never empty. */
  readonly summary: string;
  readonly findings: readonly Finding[];
  /** False when anything of `error` severity or worse fired. Warnings alone stay healthy. */
  readonly healthy: boolean;
  readonly analysedLines: number;
  /** Sequence range examined, so a caller can widen the window and re-run. */
  readonly window: { readonly from: number; readonly to: number };
}

export interface DiagnoseInput {
  readonly lines: readonly RawLogLine[];
  readonly server?: ServerFacts;
  /** Overridden by `server.exitCode` when both are given. `null` means "has not exited". */
  readonly exitCode?: number | null;
  readonly health?: HealthStatus;
  /**
   * `docker inspect -f '{{.State.OOMKilled}}'`. Optional, but supplying it is what lets the
   * engine tell a kernel OOM kill apart from a shutdown that outran its grace period.
   */
  readonly oomKilled?: boolean;
  /** Whether `/data/.paused` exists. */
  readonly paused?: boolean;
  readonly mods?: readonly InstalledMod[];
  /** Alias for `mods`. Both names are in use across Platter; either is accepted. */
  readonly installed?: readonly InstalledMod[];
}
