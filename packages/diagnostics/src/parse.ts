import type { LogBlock, LogLevel, LogSource, ParsedLine, RawLogLine } from './types';

/**
 * Turning container output back into structure.
 *
 * A Minecraft container emits at least five unrelated line formats on one stream, because at
 * least five programs write to it: the image's bash entrypoint, itzg's `mc-image-helper`, the
 * autopause daemon, log4j inside the server, and the JVM itself when it dies badly. They share
 * no prefix and no timestamp convention. Matching a rule against unparsed text works right up
 * until a mod reconfigures log4j and every regex anchored on `[Server thread/` stops firing.
 *
 * So: parse once, into a shape rules can key off, and treat "I did not recognise this" as a
 * first-class answer (`source: 'unknown'`) rather than a parse failure.
 */

/* -------------------------------------------------------------------------- */
/* Line formats                                                                */
/* -------------------------------------------------------------------------- */

/**
 * itzg's `logError`/`logWarning` colour their output with `tput` when stdout is a terminal, and
 * Docker gives the container a TTY often enough that this is the normal case, not the edge one.
 * Colour codes land in the middle of the strings the rules match, so they come off first.
 */
const ANSI_RE = /\u001B\[[0-9;?]*[ -\/]*[@-~]/g;

/**
 * Docker prepends an RFC3339 timestamp when logs are read with `timestamps: true`.
 * `@platter/core` already strips it into `LogLine.timestamp`, but a caller reading logs another
 * way may not have, and a stray timestamp would defeat every anchored pattern below.
 */
const DOCKER_TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/;

/**
 * The standard log4j console layout: `[21:04:11] [Server thread/INFO]: message`, optionally with
 * a logger and marker in between — `[21:04:11] [main/ERROR] [net.minecraft.Foo/CORE]: message`,
 * which is how Forge and NeoForge print. The date form appears when `LOG_TIMESTAMP` is on.
 */
const MC_BRACKETED_RE =
  /^\[(?<time>\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?|\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\] \[(?<thread>[^\]]+?)\/(?<level>[A-Z]+)\](?: \[(?<logger>[^\]/]*)(?:\/(?<marker>[^\]]*))?\])?: ?(?<message>[\s\S]*)$/;

/** Paper and its forks: `[21:04:11 INFO]: message`. No thread, which is why it needs its own case. */
const MC_PAPER_RE = /^\[(?<time>\d{2}:\d{2}:\d{2})\s+(?<level>[A-Z]+)\]: ?(?<message>[\s\S]*)$/;

/** Pre-1.7 Bukkit: `21:04:11 [INFO] message`. Still turns up on legacy servers. */
const MC_LEGACY_RE = /^(?<time>\d{2}:\d{2}:\d{2}) \[(?<level>[A-Z]+)\] ?(?<message>[\s\S]*)$/;

/**
 * The image entrypoint. `log()` writes `[init] msg`; `logError()` wraps the message so it comes
 * out as `[init] [ERROR] msg`; `LOG_TIMESTAMP=true` inserts an RFC3339 stamp after the tag.
 */
const INIT_RE =
  /^\[init\](?: (?<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}))?(?: \[(?<level>ERROR|WARN|WARNING|INFO|DEBUG|TRACE)\])? ?(?<message>[\s\S]*)$/;

/** `mc-image-helper` does mod/modpack/properties work and logs `[mc-image-helper] 01:52:04.511 ERROR : msg`. */
const HELPER_RE =
  /^\[mc-image-helper\] (?<time>\d{2}:\d{2}:\d{2}\.\d{1,3}) (?<level>[A-Z]+)\s*: ?(?<message>[\s\S]*)$/;

/** The autopause/autostop state machines: `[Autopause loop] msg` or `[<iso>] [Autopause] msg`. */
const AUTO_RE = /^(?:\[(?<ts>[^\]]*)\] )?\[(?:Autopause|Autostop)(?: loop)?\] (?<message>[\s\S]*)$/;

/**
 * Lines the JVM writes itself, outside any logging framework. These have no timestamp and no
 * thread, so without this list they would all land in `unknown` and stack-trace grouping would
 * have no head to attach to.
 */
const JVM_HEAD_RE =
  /^(?:Exception in thread "[^"]*" |Error: |Terminating due to |Fatal error|A fatal error has been detected|OpenJDK |Java HotSpot|Picked up |WARNING: |#(?: |$)|\[\d+\.\d+s\]\[)/;

const TRACE_FRAME_RE = /^\s+at\s+\S/;
const CAUSED_BY_RE = /^\s*Caused by: \S/;
const SUPPRESSED_RE = /^\s*Suppressed: \S/;
const ELLIPSIS_RE = /^\s*\.\.\. \d+ more\s*$/;

const LEVELS: Readonly<Record<string, LogLevel>> = {
  TRACE: 'trace',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  WARNING: 'warn',
  ERROR: 'error',
  SEVERE: 'error',
  FATAL: 'fatal',
};

function toLevel(raw: string | undefined): LogLevel | undefined {
  return raw === undefined ? undefined : LEVELS[raw.toUpperCase()];
}

/** Build a `ParsedLine`, dropping undefined optionals so `exactOptionalPropertyTypes` stays viable. */
function build(
  base: Pick<ParsedLine, 'raw' | 'seq' | 'stream' | 'message' | 'source'>,
  extra: {
    timestamp?: number | null | undefined;
    time?: string | undefined;
    thread?: string | undefined;
    level?: LogLevel | undefined;
    logger?: string | undefined;
    marker?: string | undefined;
  }
): ParsedLine {
  const line: ParsedLine = { ...base };
  if (extra.timestamp !== undefined && extra.timestamp !== null) {
    line.timestamp = extra.timestamp;
  }
  if (extra.time !== undefined && extra.time !== '') {
    line.time = extra.time;
  }
  if (extra.thread !== undefined && extra.thread !== '') {
    line.thread = extra.thread;
  }
  if (extra.level !== undefined) {
    line.level = extra.level;
  }
  if (extra.logger !== undefined && extra.logger !== '') {
    line.logger = extra.logger;
  }
  if (extra.marker !== undefined && extra.marker !== '') {
    line.marker = extra.marker;
  }
  return line;
}

/**
 * Parse one line.
 *
 * Order matters: the `[init]` and `[mc-image-helper]` tags are checked before the log4j shapes
 * because an entrypoint message can legitimately contain a bracketed timestamp of its own.
 */
export function parseLine(input: RawLogLine): ParsedLine {
  const stripped = input.text.replace(ANSI_RE, '').replace(DOCKER_TS_RE, '');
  // Only the right-hand side is trimmed: leading whitespace is the signal that a line continues
  // a stack trace, and trimming it would destroy the grouping information.
  const raw = stripped.replace(/\s+$/, '');
  const common = { raw, seq: input.seq, stream: input.stream };

  const init = INIT_RE.exec(raw);
  if (init?.groups) {
    return build(
      { ...common, message: init.groups.message ?? '', source: 'entrypoint' },
      {
        timestamp: input.timestamp,
        time: init.groups.ts,
        level: toLevel(init.groups.level),
      }
    );
  }

  const helper = HELPER_RE.exec(raw);
  if (helper?.groups) {
    return build(
      { ...common, message: helper.groups.message ?? '', source: 'entrypoint' },
      {
        timestamp: input.timestamp,
        time: helper.groups.time,
        level: toLevel(helper.groups.level),
        logger: 'mc-image-helper',
      }
    );
  }

  const auto = AUTO_RE.exec(raw);
  if (auto?.groups) {
    return build(
      { ...common, message: auto.groups.message ?? '', source: 'entrypoint' },
      { timestamp: input.timestamp, time: auto.groups.ts, logger: 'autopause' }
    );
  }

  const bracketed = MC_BRACKETED_RE.exec(raw);
  if (bracketed?.groups) {
    return build(
      { ...common, message: bracketed.groups.message ?? '', source: 'minecraft' },
      {
        timestamp: input.timestamp,
        time: bracketed.groups.time,
        thread: bracketed.groups.thread,
        level: toLevel(bracketed.groups.level),
        logger: bracketed.groups.logger,
        marker: bracketed.groups.marker,
      }
    );
  }

  const paper = MC_PAPER_RE.exec(raw);
  if (paper?.groups) {
    return build(
      { ...common, message: paper.groups.message ?? '', source: 'minecraft' },
      {
        timestamp: input.timestamp,
        time: paper.groups.time,
        level: toLevel(paper.groups.level),
      }
    );
  }

  const legacy = MC_LEGACY_RE.exec(raw);
  if (legacy?.groups) {
    return build(
      { ...common, message: legacy.groups.message ?? '', source: 'minecraft' },
      {
        timestamp: input.timestamp,
        time: legacy.groups.time,
        level: toLevel(legacy.groups.level),
      }
    );
  }

  const source: LogSource = isJvmLine(raw) ? 'jvm' : 'unknown';
  return build({ ...common, message: raw, source }, { timestamp: input.timestamp });
}

function isJvmLine(raw: string): boolean {
  return (
    JVM_HEAD_RE.test(raw) ||
    TRACE_FRAME_RE.test(raw) ||
    CAUSED_BY_RE.test(raw) ||
    SUPPRESSED_RE.test(raw) ||
    ELLIPSIS_RE.test(raw)
  );
}

export function parseLines(lines: readonly RawLogLine[]): ParsedLine[] {
  return lines.map(parseLine);
}

/* -------------------------------------------------------------------------- */
/* Stack-trace grouping                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A single log record can be hundreds of lines long and only one of them carries a prefix.
 *
 * log4j writes a multi-line message — a stack trace, Forge's dependency table, Fabric's
 * resolution report — by prefixing the first line and emitting the rest raw. Docker sees those
 * raw lines as ordinary output. So a `Caused by:` naming the real culprit arrives as an
 * unprefixed line forty entries after the header, and any rule that reads one line at a time
 * cannot see the two together.
 *
 * `groupTraces` reassembles them. A line continues the block before it when it is indented, or
 * is one of the three shapes the JVM uses to structure a trace.
 */

/** Bounds the cost of a runaway trace. A 20 000-frame stack tells you nothing the first 400 did not. */
const MAX_BLOCK_LINES = 400;

/** Bounds the string every rule regex runs over, per block. */
const MAX_BLOCK_CHARS = 64_000;

function isContinuation(line: ParsedLine): boolean {
  // A recognised log record always starts its own block, whatever it looks like inside.
  if (line.source === 'entrypoint' || line.source === 'minecraft') {
    return false;
  }
  if (line.raw === '') {
    return false;
  }
  return (
    /^\s/.test(line.raw) ||
    CAUSED_BY_RE.test(line.raw) ||
    SUPPRESSED_RE.test(line.raw) ||
    ELLIPSIS_RE.test(line.raw)
  );
}

/**
 * The entrypoint has no multi-line message support, so it prints a paragraph as several
 * `logError` calls — the EULA notice is four, the invalid-`TYPE` notice is four. Those belong
 * together as one piece of evidence, so consecutive `[init]` lines at the same level join up.
 * Restricted to warnings and errors: gluing runs of INFO would swallow the whole install log.
 */
function continuesEntrypointRun(line: ParsedLine, head: ParsedLine, previous: ParsedLine): boolean {
  return (
    line.source === 'entrypoint' &&
    head.source === 'entrypoint' &&
    line.level === head.level &&
    (line.level === 'error' || line.level === 'warn') &&
    line.seq === previous.seq + 1
  );
}

export function groupTraces(lines: readonly ParsedLine[]): LogBlock[] {
  const blocks: LogBlock[] = [];
  let current: ParsedLine[] = [];
  let truncated = false;

  const flush = (): void => {
    if (current.length === 0) {
      return;
    }
    blocks.push(toBlock(current, truncated));
    current = [];
    truncated = false;
  };

  for (const line of lines) {
    const head = current[0];
    const previous = current[current.length - 1];

    if (head === undefined || previous === undefined) {
      current = [line];
      continue;
    }

    const joins = isContinuation(line) || continuesEntrypointRun(line, head, previous);
    if (!joins) {
      flush();
      current = [line];
      continue;
    }

    if (current.length >= MAX_BLOCK_LINES) {
      truncated = true;
      continue;
    }
    current.push(line);
  }
  flush();

  return blocks;
}

function toBlock(lines: readonly ParsedLine[], truncated: boolean): LogBlock {
  const head = lines[0];
  if (head === undefined) {
    throw new Error('toBlock called with no lines');
  }
  const last = lines[lines.length - 1] ?? head;

  let text = '';
  let clipped = truncated;
  for (const line of lines) {
    // The head's parsed message drops its prefix; continuations keep their raw form, because the
    // indentation of `at ...` frames is load-bearing for the mod-attribution patterns.
    const piece = line === head ? line.message : line.raw;
    if (text.length + piece.length + 1 > MAX_BLOCK_CHARS) {
      clipped = true;
      break;
    }
    text = text.length === 0 ? piece : `${text}\n${piece}`;
  }

  // Metadata is spread in conditionally so an absent thread stays absent, rather than becoming an
  // explicit `"thread": undefined` in the JSON a model eventually reads.
  return {
    lines,
    head,
    text,
    firstSeq: head.seq,
    lastSeq: last.seq,
    source: head.source,
    hasStackTrace: lines.some((l) => TRACE_FRAME_RE.test(l.raw)),
    truncated: clipped,
    ...(head.level === undefined ? {} : { level: head.level }),
    ...(head.thread === undefined ? {} : { thread: head.thread }),
    ...(head.logger === undefined ? {} : { logger: head.logger }),
  };
}

/** Parse and group in one call. This is what `diagnose()` uses. */
export function toBlocks(lines: readonly RawLogLine[]): LogBlock[] {
  return groupTraces(parseLines(lines));
}
