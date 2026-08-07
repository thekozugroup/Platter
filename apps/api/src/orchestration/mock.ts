import { randomBytes } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { create as createTar } from 'tar';
import { PlatterError } from '@platter/shared';
import { Deferred } from '../lib/async.js';
import { DRIVER_LABELS } from './driver.js';
import type {
  ContainerSpec,
  ContainerState,
  ContainerUsage,
  DriverHealth,
  DriverLogLine,
  LogStreamOptions,
  OrchestrationDriver,
  PullProgress,
} from './driver.js';

/**
 * A complete container runtime that never leaves the process.
 *
 * This is not a stub. CI, every service test and the `mock` node driver in a laptop
 * install run against it, so it has to behave like Docker where behaviour is observable:
 * real state transitions, output that arrives over time, stop timeouts that escalate to a
 * kill, and failures that can be provoked on demand. Anything it gets wrong is a bug the
 * test suite will never catch in the real driver.
 *
 * Time is virtual. `advance()` moves it in tick-sized steps so a test can watch a four
 * second boot without waiting four seconds, and every timestamp it produces is derived
 * from that clock rather than the wall.
 */

export type MockFailableMethod =
  | 'pullImage'
  | 'create'
  | 'recreate'
  | 'start'
  | 'stop'
  | 'kill'
  | 'remove'
  | 'inspect'
  | 'usage'
  | 'streamLogs'
  | 'writeStdin'
  | 'exec'
  | 'diskUsage'
  | 'archivePath'
  | 'listOrphans';

export interface MockDriverOptions {
  nodeId: string;
  /** Virtual milliseconds per simulated step. */
  tickMs?: number;
  /** Drive the clock from a real (unref'd) timer. Tests pass `false` and call `advance`. */
  autoTick?: boolean;
  /** How long after `start` the ready line appears. */
  readyDelayMs?: number;
  /** How long a graceful stop takes. Longer than the stop timeout means a SIGKILL exit. */
  stopDelayMs?: number;
  /** Overridden by blueprints whose ready pattern is stricter than the default line. */
  readyLine?: string;
}

export type ExecHandler = (
  command: readonly string[],
) => { exitCode: number; stdout: string; stderr: string };

interface MockContainer {
  id: string;
  spec: ContainerSpec;
  createdAtMs: number;
  running: boolean;
  state: string;
  exitCode: number | null;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  oomKilled: boolean;
  restarting: boolean;
  /** Virtual milliseconds since the current start. */
  uptimeMs: number;
  /** Boot lines already emitted for the current start. */
  bootStep: number;
  ready: boolean;
  nextHeartbeatMs: number;
  /** Decorrelates the fake usage walk so two servers never move in lockstep. */
  seed: number;
  history: DriverLogLine[];
  watchers: Set<(line: DriverLogLine | null) => void>;
}

const MIB = 1024 * 1024;
const HISTORY_LIMIT = 2000;
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Ordered fractions of `readyDelayMs` at which each boot line lands. */
const BOOT_SCRIPT: ReadonlyArray<{ at: number; content: string }> = [
  { at: 0, content: '[Server thread/INFO]: Starting server' },
  { at: 0.25, content: '[Server thread/INFO]: Loading properties' },
  { at: 0.5, content: '[Server thread/INFO]: Preparing level "world"' },
  { at: 0.8, content: '[Server thread/INFO]: Preparing spawn area: 82%' },
];

const DEFAULT_READY_LINE = '[Server thread/INFO]: Done (1.284s)! Server started, for help, type "help"';

export class MockDriver implements OrchestrationDriver {
  readonly kind = 'mock' as const;
  readonly nodeId: string;

  /** Every line written through `writeStdin`, so tests can assert what was sent. */
  readonly stdinWrites: Array<{ serverId: string; line: string }> = [];

  private readonly containers = new Map<string, MockContainer>();
  private readonly images = new Set<string>();
  private readonly failures = new Map<MockFailableMethod, PlatterError[]>();
  private readonly tickMs: number;
  private readonly autoTick: boolean;
  private readonly readyDelayMs: number;
  private readonly stopDelayMs: number;
  private readonly readyLine: string;

  private clockMs = Date.now();
  private ticker: NodeJS.Timeout | null = null;
  private reachable = true;
  private execHandler: ExecHandler | null = null;

  constructor(options: MockDriverOptions) {
    this.nodeId = options.nodeId;
    this.tickMs = options.tickMs ?? 1000;
    this.autoTick = options.autoTick ?? true;
    this.readyDelayMs = options.readyDelayMs ?? 4000;
    this.stopDelayMs = options.stopDelayMs ?? 2000;
    this.readyLine = options.readyLine ?? DEFAULT_READY_LINE;
  }

  // -------------------------------------------------------------------------
  // Test controls
  // -------------------------------------------------------------------------

  /** The next call to `method` throws instead of running. Queued, so it can be stacked. */
  failNext(method: MockFailableMethod, error?: PlatterError): void {
    const queue = this.failures.get(method) ?? [];
    queue.push(error ?? new PlatterError('driver_error', `Simulated ${method} failure.`));
    this.failures.set(method, queue);
  }

  /** Moves the virtual clock, emitting anything that was due along the way. */
  advance(ms: number): void {
    let remaining = Math.max(0, ms);
    while (remaining > 0) {
      const step = Math.min(this.tickMs, remaining);
      this.step(step);
      remaining -= step;
    }
  }

  /** Simulates an unexpected exit: the case the crash supervisor exists for. */
  crash(serverId: string, options: { exitCode?: number; message?: string; oom?: boolean } = {}): void {
    const container = this.containers.get(serverId);
    if (!container || !container.running) return;
    this.emit(container, 'stderr', options.message ?? '[Server thread/ERROR]: Encountered an unexpected exception');
    this.finish(container, options.exitCode ?? 1, options.oom ?? false);
  }

  setReachable(reachable: boolean): void {
    this.reachable = reachable;
  }

  onExec(handler: ExecHandler | null): void {
    this.execHandler = handler;
  }

  get now(): Date {
    return new Date(this.clockMs);
  }

  get runningCount(): number {
    let count = 0;
    for (const container of this.containers.values()) if (container.running) count += 1;
    return count;
  }

  /** Releases the auto-tick timer. Tests and shutdown call it; leaving it is a leak. */
  dispose(): void {
    this.stopTicker();
    for (const container of this.containers.values()) {
      for (const watcher of container.watchers) watcher(null);
      container.watchers.clear();
    }
  }

  // -------------------------------------------------------------------------
  // Driver surface
  // -------------------------------------------------------------------------

  async health(): Promise<DriverHealth> {
    await Promise.resolve();
    if (!this.reachable) {
      return {
        reachable: false,
        version: null,
        cpuCores: null,
        memoryTotalMb: null,
        containersRunning: null,
        error: 'Mock node marked unreachable.',
      };
    }
    return {
      reachable: true,
      version: 'mock-1.0',
      cpuCores: 8,
      memoryTotalMb: 16_384,
      containersRunning: this.runningCount,
      error: null,
    };
  }

  async pullImage(image: string, onProgress?: (progress: PullProgress) => void): Promise<void> {
    this.check('pullImage');
    for (let step = 1; step <= 4; step += 1) {
      onProgress?.({ status: `Downloading ${image}`, progress: step / 4 });
      await Promise.resolve();
    }
    onProgress?.({ status: `Pulled ${image}`, progress: 1 });
    this.images.add(image);
  }

  async create(spec: ContainerSpec): Promise<string> {
    this.check('create');
    await Promise.resolve();
    if (this.containers.has(spec.serverId)) {
      throw new PlatterError('conflict', 'A container for this server already exists.');
    }
    return this.insert(spec).id;
  }

  async recreate(spec: ContainerSpec): Promise<string> {
    this.check('recreate');
    await Promise.resolve();
    const existing = this.containers.get(spec.serverId);
    if (existing) {
      if (existing.running) this.finish(existing, 137, false);
      for (const watcher of existing.watchers) watcher(null);
      existing.watchers.clear();
      this.containers.delete(spec.serverId);
    }
    return this.insert(spec).id;
  }

  async start(serverId: string): Promise<void> {
    this.check('start');
    await Promise.resolve();
    const container = this.require(serverId);
    if (container.running) return;

    container.running = true;
    container.state = 'running';
    container.startedAtMs = this.clockMs;
    container.finishedAtMs = null;
    container.exitCode = null;
    container.oomKilled = false;
    container.uptimeMs = 0;
    container.bootStep = 0;
    container.ready = false;
    container.nextHeartbeatMs = this.readyDelayMs + HEARTBEAT_INTERVAL_MS;
    this.startTicker();
    // The first boot line lands with the start, exactly as a real entrypoint's does.
    this.emitBootLines(container);
  }

  async stop(serverId: string, options: { signal: string; timeoutSeconds: number }): Promise<void> {
    this.check('stop');
    await Promise.resolve();
    const container = this.require(serverId);
    if (!container.running) return;

    const timeoutMs = Math.max(0, options.timeoutSeconds) * 1000;
    const escalated = this.stopDelayMs > timeoutMs;
    this.emit(container, 'stdout', `[Server thread/INFO]: Received ${options.signal}, stopping the server`);
    // The clock moves on the container, not globally: `stop` resolves once the container
    // has exited, and a test that has not advanced time should not see other servers age.
    container.uptimeMs += Math.min(this.stopDelayMs, timeoutMs);
    if (escalated) {
      this.emit(container, 'stderr', '[Server thread/WARN]: Shutdown timed out, killing');
    } else {
      this.emit(container, 'stdout', '[Server thread/INFO]: Saving worlds');
    }
    this.finish(container, escalated ? 137 : 0, false);
  }

  async kill(serverId: string): Promise<void> {
    this.check('kill');
    await Promise.resolve();
    const container = this.require(serverId);
    if (!container.running) return;
    this.finish(container, 137, false);
  }

  async remove(serverId: string, options: { removeVolume?: boolean } = {}): Promise<void> {
    this.check('remove');
    await Promise.resolve();
    const container = this.containers.get(serverId);
    if (!container) return;
    if (container.running) this.finish(container, 137, false);
    for (const watcher of container.watchers) watcher(null);
    container.watchers.clear();
    this.containers.delete(serverId);
    // `removeVolume` is honoured by the caller: the mock's data lives in the same host
    // directory the real driver bind-mounts, and deleting it is lifecycle's job.
    void options.removeVolume;
  }

  async inspect(serverId: string): Promise<ContainerState> {
    this.check('inspect');
    await Promise.resolve();
    const container = this.containers.get(serverId);
    if (!container) {
      return {
        exists: false,
        id: null,
        running: false,
        state: 'absent',
        exitCode: null,
        startedAt: null,
        finishedAt: null,
        restarting: false,
        oomKilled: false,
      };
    }
    return {
      exists: true,
      id: container.id,
      running: container.running,
      state: container.state,
      exitCode: container.exitCode,
      startedAt: container.startedAtMs === null ? null : new Date(container.startedAtMs).toISOString(),
      finishedAt: container.finishedAtMs === null ? null : new Date(container.finishedAtMs).toISOString(),
      restarting: container.restarting,
      oomKilled: container.oomKilled,
    };
  }

  async usage(serverId: string): Promise<ContainerUsage | null> {
    this.check('usage');
    await Promise.resolve();
    const container = this.require(serverId);
    if (!container.running) return null;

    const limitBytes = container.spec.limits.memoryMb * MIB;
    const phase = container.uptimeMs / 1000 + container.seed;
    const wave = (divisor: number): number => Math.sin(phase / divisor);
    const cpuPercent = Math.max(0, 22 + 14 * wave(7) + 6 * wave(1.7));
    const memoryFraction = 0.34 + 0.12 * wave(11) + 0.04 * wave(2.3);

    return {
      cpuPercent: Number(cpuPercent.toFixed(2)),
      memoryBytes: Math.round(limitBytes * memoryFraction),
      memoryLimitBytes: limitBytes,
      networkRxBytes: Math.round(container.uptimeMs * 12.5),
      networkTxBytes: Math.round(container.uptimeMs * 7.5),
      blockReadBytes: Math.round(container.uptimeMs * 3),
      blockWriteBytes: Math.round(container.uptimeMs * 5),
      pids: 24 + (container.seed % 8),
      sampledAt: this.now,
    };
  }

  streamLogs(serverId: string, options: LogStreamOptions = {}): AsyncIterable<DriverLogLine> {
    this.check('streamLogs');
    const container = this.require(serverId);
    return this.iterateLogs(container, options);
  }

  async writeStdin(serverId: string, line: string): Promise<void> {
    this.check('writeStdin');
    await Promise.resolve();
    const container = this.require(serverId);
    if (!container.spec.interactive) {
      throw new PlatterError('conflict', 'This container was created without an open stdin.');
    }
    if (!container.running) {
      throw new PlatterError('conflict', 'The container is not running.');
    }
    this.stdinWrites.push({ serverId, line });
  }

  async exec(
    serverId: string,
    command: string[],
    options: { timeoutMs?: number } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.check('exec');
    await Promise.resolve();
    const container = this.require(serverId);
    if (!container.running) throw new PlatterError('conflict', 'The container is not running.');
    void options.timeoutMs;
    return this.execHandler?.(command) ?? { exitCode: 0, stdout: '', stderr: '' };
  }

  async diskUsage(serverId: string): Promise<number> {
    this.check('diskUsage');
    const container = this.require(serverId);
    return directorySize(container.spec.dataHostPath);
  }

  async archivePath(serverId: string, target: string): Promise<Readable> {
    this.check('archivePath');
    const container = this.require(serverId);
    // The mock's data directory is a real one — lifecycle created it and rendered the
    // blueprint's files into it — so this produces a genuine tar, not a fixture.
    const root = resolveInside(container.spec.dataHostPath, container.spec.dataPath, target);
    const info = await stat(root).catch(() => null);
    if (!info) throw new PlatterError('not_found', 'That path does not exist on the server.');
    const pack = createTar({ cwd: info.isDirectory() ? root : path.dirname(root), portable: true }, [
      info.isDirectory() ? '.' : path.basename(root),
    ]);
    return Readable.from(pack);
  }

  async listOrphans(): Promise<Array<{ serverId: string; containerId: string }>> {
    this.check('listOrphans');
    await Promise.resolve();
    return [...this.containers.values()]
      .filter((container) => container.spec.labels[DRIVER_LABELS.managed] !== 'false')
      .map((container) => ({ serverId: container.spec.serverId, containerId: container.id }));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private check(method: MockFailableMethod): void {
    const queue = this.failures.get(method);
    const error = queue?.shift();
    if (queue && queue.length === 0) this.failures.delete(method);
    if (error) throw error;
  }

  private require(serverId: string): MockContainer {
    const container = this.containers.get(serverId);
    if (!container) throw new PlatterError('not_found', 'That container does not exist.');
    return container;
  }

  private insert(spec: ContainerSpec): MockContainer {
    const container: MockContainer = {
      id: randomBytes(32).toString('hex'),
      spec,
      createdAtMs: this.clockMs,
      running: false,
      state: 'created',
      exitCode: null,
      startedAtMs: null,
      finishedAtMs: null,
      oomKilled: false,
      restarting: false,
      uptimeMs: 0,
      bootStep: 0,
      ready: false,
      nextHeartbeatMs: Number.POSITIVE_INFINITY,
      seed: spec.serverId.length + spec.limits.memoryMb,
      history: [],
      watchers: new Set(),
    };
    this.containers.set(spec.serverId, container);
    this.images.add(spec.image);
    return container;
  }

  private finish(container: MockContainer, exitCode: number, oomKilled: boolean): void {
    container.running = false;
    container.state = 'exited';
    container.exitCode = exitCode;
    container.oomKilled = oomKilled;
    container.finishedAtMs = this.clockMs;
    container.ready = false;
    // Ending every watcher is what makes `for await` over a log stream terminate on exit.
    for (const watcher of container.watchers) watcher(null);
    container.watchers.clear();
    if (this.runningCount === 0) this.stopTicker();
  }

  private emit(container: MockContainer, stream: 'stdout' | 'stderr', content: string): void {
    const line: DriverLogLine = { stream, content, timestamp: this.now };
    container.history.push(line);
    if (container.history.length > HISTORY_LIMIT) container.history.shift();
    for (const watcher of container.watchers) watcher(line);
  }

  private emitBootLines(container: MockContainer): void {
    while (container.bootStep < BOOT_SCRIPT.length) {
      const step = BOOT_SCRIPT[container.bootStep];
      if (!step || step.at * this.readyDelayMs > container.uptimeMs) break;
      container.bootStep += 1;
      this.emit(container, 'stdout', step.content);
    }
    if (!container.ready && container.uptimeMs >= this.readyDelayMs) {
      container.ready = true;
      this.emit(container, 'stdout', this.readyLine);
    }
  }

  private step(ms: number): void {
    this.clockMs += ms;
    for (const container of this.containers.values()) {
      if (!container.running) continue;
      container.uptimeMs += ms;
      this.emitBootLines(container);
      while (container.uptimeMs >= container.nextHeartbeatMs) {
        container.nextHeartbeatMs += HEARTBEAT_INTERVAL_MS;
        this.emit(container, 'stdout', '[Server thread/INFO]: Autosaving world');
      }
    }
  }

  private startTicker(): void {
    if (!this.autoTick || this.ticker) return;
    this.ticker = setInterval(() => {
      this.step(this.tickMs);
    }, this.tickMs);
    // Never a reason to hold the process open: this timer only produces fake log lines.
    this.ticker.unref();
  }

  private stopTicker(): void {
    if (!this.ticker) return;
    clearInterval(this.ticker);
    this.ticker = null;
  }

  private async *iterateLogs(
    container: MockContainer,
    options: LogStreamOptions,
  ): AsyncGenerator<DriverLogLine> {
    const since = options.since?.getTime() ?? 0;
    const tail = options.tail ?? container.history.length;
    const replay = container.history
      .filter((line) => line.timestamp.getTime() >= since)
      .slice(-Math.max(0, tail));

    const pending: DriverLogLine[] = [...replay];
    let ended = !container.running;
    let waiter: Deferred<void> | null = null;

    const wake = (): void => {
      const current = waiter;
      waiter = null;
      current?.resolve();
    };
    const watcher = (line: DriverLogLine | null): void => {
      if (line === null) ended = true;
      else pending.push(line);
      wake();
    };
    const onAbort = (): void => {
      ended = true;
      wake();
    };

    if (!ended) container.watchers.add(watcher);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      if (options.signal?.aborted) return;
      for (;;) {
        while (pending.length > 0) {
          const line = pending.shift();
          if (line) yield line;
          if (options.signal?.aborted) return;
        }
        if (ended) return;
        waiter = new Deferred<void>();
        await waiter.promise;
      }
    } finally {
      container.watchers.delete(watcher);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}

export function isMockDriver(driver: OrchestrationDriver): driver is MockDriver {
  return driver instanceof MockDriver;
}

/** Keeps a blueprint-declared archive path from reaching outside the data volume. */
function resolveInside(hostRoot: string, containerRoot: string, target: string): string {
  const relative = path.posix.isAbsolute(target)
    ? path.posix.relative(containerRoot, target)
    : target;
  const resolved = path.resolve(hostRoot, relative);
  const prefix = path.resolve(hostRoot) + path.sep;
  if (resolved !== path.resolve(hostRoot) && !resolved.startsWith(prefix)) {
    throw new PlatterError('bad_request', 'That path is outside the server directory.');
  }
  return resolved;
}

async function directorySize(root: string): Promise<number> {
  let total = 0;
  const queue: string[] = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile()) {
        const info = await stat(full).catch(() => null);
        if (info) total += info.size;
      }
    }
  }
  return total;
}
