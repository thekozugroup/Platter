import { LIMITS } from '@platter/shared';
import type { BlueprintSignals, LogLine, ServerStatus } from '@platter/shared';
import { sleep } from '../lib/async.js';
import type { OrchestrationDriver } from './driver.js';

/**
 * The in-memory console for one server: a bounded scrollback ring plus a fan-out point
 * for everyone watching it.
 *
 * The fan-out is the reason this exists. A console page, a second browser tab and the
 * crash supervisor all want the same output, but the driver stream is expensive — every
 * open `docker logs --follow` holds a connection to the daemon and a reader on the
 * container's log driver. So exactly one driver stream exists per server no matter how
 * many watchers there are, and it is torn down by reference counting the moment the last
 * one leaves.
 */

const CAPACITY = LIMITS.consoleScrollback;
const MAX_LINE = LIMITS.maxConsoleLineLength;

/**
 * How long to wait before reopening a stream that ended by itself, and how many times.
 *
 * A follow stream is not supposed to end while the container runs, but it does: the daemon
 * restarts, the container is recreated under Platter, the log file rotates. When it did,
 * nothing reopened it — the hub kept its subscribers, kept reporting `attached: false`,
 * and never produced another line. The server was still running and still writing; Platter
 * had simply stopped listening, with nothing on screen to say so.
 *
 * Bounded, because the other reason a stream ends immediately is that the container is
 * gone, and retrying that forever is a loop against the daemon.
 */
const REOPEN_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const;

export type LogStream = LogLine['stream'];

/**
 * Everything a watcher can be told about a server, as one union rather than an event
 * emitter: a console socket has to handle all of these anyway, and a single callback
 * cannot silently miss one the way a forgotten `.on()` can.
 */
export type LogHubEvent =
  | { type: 'line'; line: LogLine }
  | { type: 'status'; status: ServerStatus; exitCode: number | null }
  /** The blueprint's ready pattern matched — the game finished booting. */
  | { type: 'ready'; line: LogLine }
  /** The blueprint's crash pattern matched. Not the same as the container exiting. */
  | { type: 'crash'; line: LogLine };

export type LogHubListener = (event: LogHubEvent) => void;

export interface AppendInput {
  stream: LogStream;
  content: string;
  timestamp?: Date;
}

export interface AttachOptions {
  driver: OrchestrationDriver;
  /** Ready/crash patterns from the server's blueprint. */
  signals?: BlueprintSignals;
  /** Historical lines to replay from the runtime when the stream opens. */
  tail?: number;
}

/**
 * Blueprint patterns are authored data, so a broken regex is an operator mistake rather
 * than a reason to fail the boot. Bad sources are dropped and the rest still apply.
 */
function compilePatterns(sources: readonly string[]): RegExp[] {
  const compiled: RegExp[] = [];
  for (const source of sources) {
    try {
      // No flags: the pattern is matched exactly as the blueprint author wrote it, and a
      // `g` flag would make `.test()` stateful across lines.
      compiled.push(new RegExp(source));
    } catch {
      process.stderr.write(`ignoring unparsable blueprint log pattern: ${source}\n`);
    }
  }
  return compiled;
}

export class LogHub {
  readonly serverId: string;

  private readonly ring: Array<LogLine | undefined>;
  private readonly listeners = new Set<LogHubListener>();

  /** Monotonic across attaches, so a client can detect a gap after a reconnect. */
  private nextSeq = 1;
  private stored = 0;

  private controller: AbortController | null = null;
  private streamGeneration = 0;
  /**
   * The newest line's timestamp, so a reattach can ask for what happened *since* rather
   * than replaying a tail the ring already holds.
   */
  private lastAt: Date | null = null;
  /** Whether a historical read has already filled this ring. See `hydrate`. */
  private hydrated = false;
  /** The last stream failure, reported once by `run` rather than once per attempt. */
  private lastError: string | null = null;
  private readyPatterns: RegExp[] = [];
  private crashPatterns: RegExp[] = [];
  /** Latched per attach: a boot emits its ready line once, not once per matching line. */
  private readySeen = false;

  constructor(serverId: string) {
    this.serverId = serverId;
    this.ring = new Array<LogLine | undefined>(CAPACITY);
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  get attached(): boolean {
    return this.controller !== null;
  }

  /** Returns its own unsubscribe so a caller cannot lose the reference it must release. */
  subscribe(listener: LogHubListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.unsubscribe(listener);
    };
  }

  unsubscribe(listener: LogHubListener): void {
    if (!this.listeners.delete(listener)) return;
    // The stream exists to feed watchers. With none left it is pure cost on the daemon.
    if (this.listeners.size === 0) this.detach();
  }

  append(input: AppendInput): LogLine {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    if (this.stored < CAPACITY) this.stored += 1;

    const raw = input.content.replace(/\r$/, '');
    const line: LogLine = {
      seq,
      stream: input.stream,
      content: raw.length > MAX_LINE ? `${raw.slice(0, MAX_LINE)}…` : raw,
      timestamp: (input.timestamp ?? new Date()).toISOString(),
    };

    this.ring[(seq - 1) % CAPACITY] = line;
    if (input.timestamp) this.lastAt = input.timestamp;
    this.emit({ type: 'line', line });
    this.matchSignals(line);
    return line;
  }

  /** Platter's own annotation in the console — "Pulling image", "Server marked crashed". */
  system(content: string): LogLine {
    return this.append({ stream: 'system', content });
  }

  emitStatus(status: ServerStatus, exitCode: number | null = null): void {
    this.emit({ type: 'status', status, exitCode });
  }

  /** Oldest first, capped at what the ring still holds. */
  // `limit: number` is explicit because `LIMITS` is a const assertion: inferring the
  // parameter from the default would type it as the literal 500 and reject every other
  // number a caller asks for.
  backlog(limit: number = CAPACITY): LogLine[] {
    const wanted = Math.max(0, Math.min(Math.trunc(limit), this.stored));
    const lines: LogLine[] = [];
    for (let seq = this.nextSeq - wanted; seq < this.nextSeq; seq += 1) {
      const line = this.ring[(seq - 1) % CAPACITY];
      if (line) lines.push(line);
    }
    return lines;
  }

  /** True once a historical read has filled this ring, or once one is provably unnecessary. */
  get hasHistory(): boolean {
    return this.hydrated;
  }

  /**
   * Reads the container's existing output once, and puts it in front of whatever the ring
   * already holds.
   *
   * This exists because attaching and having history are different needs, and conflating
   * them cost the console everything it was for. The player tracker attaches on boot with
   * `tail: 0` — it must, or replaying a join line would reopen a session for somebody who
   * left hours ago — and `attach` is idempotent, so a console opening afterwards found a
   * stream already running and asked for nothing. On a server that had been quiet since
   * Platter restarted, the pane showed "Waiting for output. Nothing has been logged yet."
   * about a server with a full log file.
   *
   * A one-shot read rather than a second follow stream: two follow streams on one container
   * is what the reference counting exists to prevent, and this one has to end by itself.
   *
   * Lines already in the ring are dropped by timestamp so the overlap between "the last 500
   * lines" and "what arrived since the stream opened" is not printed twice.
   */
  async hydrate(driver: OrchestrationDriver, limit: number = CAPACITY): Promise<void> {
    if (this.hydrated) return;
    // Marked before the await: two consoles opening at once must not both read the history.
    this.hydrated = true;

    const existing = this.backlog(CAPACITY);
    const earliest = existing[0] ? Date.parse(existing[0].timestamp) : Number.POSITIVE_INFINITY;
    const seen = new Set(existing.map((line) => `${line.timestamp}\u0000${line.content}`));

    const history: LogLine[] = [];
    try {
      for await (const line of driver.streamLogs(this.serverId, { tail: limit, follow: false })) {
        const timestamp = (line.timestamp ?? new Date()).toISOString();
        // Anything at or after the ring's own start is already accounted for.
        if (Date.parse(timestamp) >= earliest) continue;
        if (seen.has(`${timestamp}\u0000${line.content}`)) continue;
        history.push({ seq: 0, stream: line.stream, content: line.content, timestamp });
      }
    } catch {
      // A container that cannot be read still has whatever the ring holds. The console
      // route says so in the one place a person will look; this is not that place.
      this.hydrated = existing.length > 0;
      return;
    }
    if (history.length === 0) return;

    this.rewrite([...history, ...existing]);
  }

  /**
   * Replaces the ring's contents, renumbering from one.
   *
   * Only `hydrate` calls this, and only before a console has been sent its first backlog —
   * the sequence numbers a client holds must never be renumbered underneath it.
   */
  private rewrite(lines: readonly LogLine[]): void {
    const kept = lines.slice(-CAPACITY);
    this.ring.fill(undefined);
    this.nextSeq = 1;
    this.stored = 0;
    for (const line of kept) {
      const seq = this.nextSeq;
      this.nextSeq += 1;
      this.stored = Math.min(this.stored + 1, CAPACITY);
      this.ring[(seq - 1) % CAPACITY] = { ...line, seq };
    }
    const newest = kept[kept.length - 1];
    if (newest) this.lastAt = new Date(newest.timestamp);
  }

  /**
   * Opens the single driver stream. Idempotent: a second caller joins the existing one,
   * which is what makes "attach on every start, and on every console open" safe.
   */
  attach(options: AttachOptions): void {
    if (this.controller) return;

    this.readyPatterns = compilePatterns(options.signals?.ready ?? []);
    this.crashPatterns = compilePatterns(options.signals?.crash ?? []);
    this.readySeen = false;

    const controller = new AbortController();
    this.controller = controller;
    this.streamGeneration += 1;
    const generation = this.streamGeneration;

    // A ring with content already covers everything up to `lastAt`, so the stream asks for
    // what came after it instead of replaying a tail. Without this every reopen printed the
    // scrollback a second time underneath itself.
    const resume = this.lastAt;
    void this.run(options.driver, controller, generation, options.tail ?? CAPACITY, resume);
  }

  /**
   * Keeps one stream alive for as long as anybody is watching.
   *
   * A follow stream is not supposed to end while the container runs, and it does anyway:
   * the daemon restarts, the container is recreated under Platter, the log file rotates.
   * Nothing reopened it. The hub kept its subscribers and never produced another line, so
   * the server went on running and writing while Platter quietly stopped listening.
   *
   * The retry lives here rather than in `pump` so a reopen resumes from the newest line the
   * hub holds. Replaying a tail instead would print the scrollback underneath itself once
   * per reconnection.
   */
  private async run(
    driver: OrchestrationDriver,
    controller: AbortController,
    generation: number,
    tail: number,
    resume: Date | null,
  ): Promise<void> {
    let since = resume;

    for (let attempt = 0; ; attempt += 1) {
      this.lastError = null;
      await this.pump(driver, controller.signal, tail, since);

      // Aborted, superseded by a later attach, or nobody left to tell: all three mean stop.
      if (controller.signal.aborted) break;
      // A later attach already owns the hub; it must not have its controller cleared below.
      if (this.streamGeneration !== generation) return;
      if (this.listeners.size === 0) break;

      const wait = REOPEN_DELAYS_MS[attempt];
      if (wait === undefined) {
        this.system(
          this.lastError === null
            ? 'Live output stopped and could not be reopened. Reload the page to try again.'
            : `Live output stopped: ${this.lastError}. Reload the page to try again.`,
        );
        break;
      }

      // Resume from the newest line rather than the tail, so nothing is printed twice.
      since = this.lastAt;
      try {
        await sleep(wait, controller.signal);
      } catch {
        break;
      }
    }

    if (this.streamGeneration === generation) this.controller = null;
  }

  /** Aborts the driver stream. Safe to call when nothing is attached. */
  detach(): void {
    const controller = this.controller;
    if (!controller) return;
    this.controller = null;
    controller.abort();
  }

  private async pump(
    driver: OrchestrationDriver,
    signal: AbortSignal,
    tail: number,
    since: Date | null,
  ): Promise<void> {
    try {
      const options = since ? { since, signal } : { tail, signal };
      for await (const line of driver.streamLogs(this.serverId, options)) {
        if (signal.aborted) break;
        this.append({ stream: line.stream, content: line.content, timestamp: line.timestamp });
      }
    } catch (error) {
      // An aborted stream is how every detach ends, and a stream that ends on its own is
      // about to be reopened. `run` decides whether this is worth a line in the console —
      // saying it here would print the same sentence once per attempt.
      if (!signal.aborted) {
        this.lastError = error instanceof Error ? error.message : 'unknown error';
      }
    }
  }

  private matchSignals(line: LogLine): void {
    // System lines are Platter's own words. Scanning them would let "server crashed" in a
    // status annotation re-trigger the crash signal that produced it.
    if (line.stream === 'system') return;

    if (!this.readySeen && this.readyPatterns.some((pattern) => pattern.test(line.content))) {
      this.readySeen = true;
      this.emit({ type: 'ready', line });
    }
    if (this.crashPatterns.some((pattern) => pattern.test(line.content))) {
      this.emit({ type: 'crash', line });
    }
  }

  private emit(event: LogHubEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        // One broken watcher must not cost every other watcher the rest of the console.
        process.stderr.write(`log hub listener failed for ${this.serverId}: ${String(error)}\n`);
      }
    }
  }
}

const hubs = new Map<string, LogHub>();

export function getLogHub(serverId: string): LogHub {
  const existing = hubs.get(serverId);
  if (existing) return existing;
  const hub = new LogHub(serverId);
  hubs.set(serverId, hub);
  return hub;
}

/** Called when a server is deleted; without it the map is a slow leak. */
export function dropLogHub(serverId: string): void {
  const hub = hubs.get(serverId);
  if (!hub) return;
  hub.detach();
  hubs.delete(serverId);
}

export function resetLogHubs(): void {
  for (const hub of hubs.values()) hub.detach();
  hubs.clear();
}
