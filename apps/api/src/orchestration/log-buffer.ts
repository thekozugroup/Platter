import { LIMITS } from '@platter/shared';
import type { BlueprintSignals, LogLine, ServerStatus } from '@platter/shared';
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

    void this.pump(options.driver, controller.signal, options.tail ?? CAPACITY).finally(() => {
      // A later attach may already own the hub; only the current stream may clear it.
      if (this.streamGeneration === generation) this.controller = null;
    });
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
  ): Promise<void> {
    try {
      for await (const line of driver.streamLogs(this.serverId, { tail, signal })) {
        if (signal.aborted) break;
        this.append({ stream: line.stream, content: line.content, timestamp: line.timestamp });
      }
    } catch (error) {
      // An aborted stream is how every detach ends; only a real failure is worth showing.
      if (!signal.aborted) {
        this.system(`Console stream ended: ${error instanceof Error ? error.message : 'unknown error'}`);
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
