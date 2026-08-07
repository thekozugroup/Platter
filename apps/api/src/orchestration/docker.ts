import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import Docker from 'dockerode';
import { PlatterError } from '@platter/shared';
import { withTimeout } from '../lib/async.js';
import { DRIVER_LABELS, containerNameFor } from './driver.js';
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
 * The real driver: dockerode over a unix socket or a tcp endpoint.
 *
 * Two things here are easy to get subtly wrong and expensive to debug in production —
 * demultiplexing the log stream (see `LogDecoder`) and computing usage from Docker's
 * cumulative counters (see `readUsage`). Both are commented where the reasoning is not
 * obvious from the code.
 */

const MIB = 1024 * 1024;
const NANO = 1e9;
/** Docker refuses anything below 0.01 CPU, so a smaller request is clamped, not rejected. */
const MIN_NANO_CPUS = 1e7;
const HEALTH_TIMEOUT_MS = 5000;
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const DEFAULT_PIDS_LIMIT = 512;

/** Socket-level failures that mean "the node is down", not "the request was bad". */
const UNREACHABLE_CODES = new Set([
  'ENOENT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'EACCES',
  'EAI_AGAIN',
]);

export interface DockerDriverOptions {
  nodeId: string;
  /** `/var/run/docker.sock`, `unix:///var/run/docker.sock` or `tcp://host:2375`. */
  endpoint: string;
}

interface DockerFailure {
  statusCode?: number;
  code?: string;
  message?: string;
}

function failure(error: unknown): DockerFailure {
  return typeof error === 'object' && error !== null ? (error as DockerFailure) : {};
}

function statusOf(error: unknown): number | null {
  const status = failure(error).statusCode;
  return typeof status === 'number' ? status : null;
}

/** `tcp://` is Docker's spelling of "plain http on the daemon port". */
export function parseDockerEndpoint(endpoint: string): Docker.DockerOptions {
  const trimmed = endpoint.trim();
  if (trimmed.startsWith('unix://')) return { socketPath: trimmed.slice('unix://'.length) };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return { socketPath: trimmed };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new PlatterError('bad_request', 'That node endpoint is not a valid address.');
  }
  const protocol = url.protocol === 'https:' ? 'https' : 'http';
  const port = url.port === '' ? (protocol === 'https' ? 2376 : 2375) : Number(url.port);
  return { host: url.hostname, port, protocol };
}

// ---------------------------------------------------------------------------
// Log framing
// ---------------------------------------------------------------------------

const FRAME_HEADER_BYTES = 8;

/**
 * Turns Docker's log wire format into whole lines.
 *
 * Without a TTY the stream is multiplexed: each payload is preceded by an 8-byte header
 * whose first byte is the stream (1 = stdout, 2 = stderr) and whose last four bytes are
 * the payload length, big-endian. Chunk boundaries fall wherever TCP decides, so a header
 * — or a payload — routinely arrives split across two reads; everything is therefore
 * buffered until a full frame is present rather than parsed per chunk.
 *
 * Lines are then split here rather than downstream because a single frame can hold many
 * lines or half of one, and the partial tail has to survive until the rest arrives.
 */
class LogDecoder {
  private buffer = Buffer.alloc(0);
  private readonly partial = new Map<'stdout' | 'stderr', string>();

  constructor(private readonly raw: boolean) {}

  push(chunk: Buffer): DriverLogLine[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const lines: DriverLogLine[] = [];

    if (this.raw) {
      // A TTY container has no framing at all; everything is stdout.
      const text = this.buffer.toString('utf8');
      this.buffer = Buffer.alloc(0);
      this.split('stdout', text, lines);
      return lines;
    }

    for (;;) {
      if (this.buffer.length < FRAME_HEADER_BYTES) break;
      const length = this.buffer.readUInt32BE(4);
      if (this.buffer.length < FRAME_HEADER_BYTES + length) break;

      const type = this.buffer.readUInt8(0);
      const payload = this.buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length);
      this.buffer = this.buffer.subarray(FRAME_HEADER_BYTES + length);
      this.split(type === 2 ? 'stderr' : 'stdout', payload.toString('utf8'), lines);
    }

    return lines;
  }

  /** Emits whatever is left when the stream ends, so a last line without `\n` is not lost. */
  flush(): DriverLogLine[] {
    const lines: DriverLogLine[] = [];
    for (const [stream, text] of this.partial) {
      if (text.length > 0) lines.push(decorate(stream, text));
    }
    this.partial.clear();
    this.buffer = Buffer.alloc(0);
    return lines;
  }

  private split(stream: 'stdout' | 'stderr', text: string, out: DriverLogLine[]): void {
    const combined = (this.partial.get(stream) ?? '') + text;
    const parts = combined.split('\n');
    this.partial.set(stream, parts.pop() ?? '');
    for (const part of parts) out.push(decorate(stream, part));
  }
}

/**
 * Splits Docker's `timestamps: true` prefix off the line. The prefix is RFC3339 with
 * nanoseconds, which `Date` truncates to milliseconds — close enough for a console, and
 * far better than stamping every replayed line with the time it was read.
 */
function decorate(stream: 'stdout' | 'stderr', line: string): DriverLogLine {
  const content = line.replace(/\r$/, '');
  const space = content.indexOf(' ');
  if (space > 0) {
    const parsed = Date.parse(content.slice(0, space));
    if (!Number.isNaN(parsed)) {
      return { stream, content: content.slice(space + 1), timestamp: new Date(parsed) };
    }
  }
  return { stream, content, timestamp: new Date() };
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function numberAt(source: unknown, key: string): number | null {
  if (typeof source !== 'object' || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Docker reports CPU as monotonic nanosecond counters, so a percentage only exists
 * between two samples. `stats?stream=false` normally carries `precpu_stats` from the
 * previous read, but the very first sample after a container starts has it zeroed —
 * reporting the ratio against zero would show a several-thousand-percent spike on every
 * console open, so that case is 0 instead.
 */
function cpuPercentFrom(stats: Docker.ContainerStats): number {
  const cpuDelta =
    (numberAt(stats.cpu_stats.cpu_usage, 'total_usage') ?? 0) -
    (numberAt(stats.precpu_stats?.cpu_usage, 'total_usage') ?? 0);
  const previousSystem = numberAt(stats.precpu_stats, 'system_cpu_usage') ?? 0;
  const systemDelta = (numberAt(stats.cpu_stats, 'system_cpu_usage') ?? 0) - previousSystem;
  if (previousSystem === 0 || systemDelta <= 0 || cpuDelta <= 0) return 0;

  const percpu = (stats.cpu_stats.cpu_usage as { percpu_usage?: number[] }).percpu_usage;
  const onlineCpus = numberAt(stats.cpu_stats, 'online_cpus') ?? percpu?.length ?? 1;
  return Number(((cpuDelta / systemDelta) * onlineCpus * 100).toFixed(2));
}

/**
 * Page cache counts toward `memory_stats.usage`, and a game server that has read its
 * world off disk will show as pinned at its limit if it is not subtracted. cgroup v2
 * names it `inactive_file`; v1 reports `total_inactive_file` (and `cache` on older
 * kernels), so all three are tried in the order Docker's own CLI uses.
 */
function memoryBytesFrom(stats: Docker.ContainerStats): number {
  const usage = numberAt(stats.memory_stats, 'usage') ?? 0;
  const detail: unknown = stats.memory_stats.stats;
  const cache =
    numberAt(detail, 'total_inactive_file') ??
    numberAt(detail, 'inactive_file') ??
    numberAt(detail, 'cache') ??
    0;
  return Math.max(0, usage - cache);
}

function blkioBytesFrom(stats: Docker.ContainerStats, operation: 'read' | 'write'): number {
  const entries = stats.blkio_stats?.io_service_bytes_recursive;
  if (!Array.isArray(entries)) return 0;
  let total = 0;
  for (const entry of entries) {
    if (typeof entry?.op === 'string' && entry.op.toLowerCase() === operation) {
      total += typeof entry.value === 'number' ? entry.value : 0;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export class DockerDriver implements OrchestrationDriver {
  readonly kind = 'docker' as const;
  readonly nodeId: string;

  private readonly docker: Docker;
  private readonly local: boolean;
  /** serverId -> container id. Saves a list call per operation; refreshed on any 404. */
  private readonly idCache = new Map<string, string>();

  constructor(options: DockerDriverOptions) {
    const connection = parseDockerEndpoint(options.endpoint);
    this.nodeId = options.nodeId;
    this.docker = new Docker(connection);
    this.local = connection.socketPath !== undefined;
  }

  async health(): Promise<DriverHealth> {
    try {
      const version = await withTimeout(
        this.docker.version(),
        HEALTH_TIMEOUT_MS,
        'The node did not answer in time.',
      );
      const info: unknown = await withTimeout(
        this.docker.info(),
        HEALTH_TIMEOUT_MS,
        'The node did not answer in time.',
      );
      const memoryBytes = numberAt(info, 'MemTotal');
      return {
        reachable: true,
        version: version.Version,
        cpuCores: numberAt(info, 'NCPU'),
        memoryTotalMb: memoryBytes === null ? null : Math.round(memoryBytes / MIB),
        containersRunning: numberAt(info, 'ContainersRunning'),
        error: null,
      };
    } catch (error) {
      // Contractually total: an unreachable node is a value the poller stores, not an
      // exception that stops it polling the rest.
      return {
        reachable: false,
        version: null,
        cpuCores: null,
        memoryTotalMb: null,
        containersRunning: null,
        error: this.wrap(error, 'health').message,
      };
    }
  }

  async pullImage(image: string, onProgress?: (progress: PullProgress) => void): Promise<void> {
    let stream: NodeJS.ReadableStream;
    try {
      // No registry auth is configured anywhere in Platter, so this is public images only.
      stream = await this.docker.pull(image);
    } catch (error) {
      throw this.wrap(error, 'pull');
    }

    const layers = new Map<string, { current: number; total: number }>();
    let buffered = '';
    let failed: string | null = null;

    const handle = (raw: string): void => {
      if (raw.trim().length === 0) return;
      let event: unknown;
      try {
        event = JSON.parse(raw);
      } catch {
        return;
      }
      const errorText = typeof event === 'object' && event !== null
        ? (event as { error?: unknown }).error
        : undefined;
      if (typeof errorText === 'string') {
        failed = errorText;
        return;
      }
      if (!onProgress) return;

      const status = typeof event === 'object' && event !== null
        ? (event as { status?: unknown }).status
        : undefined;
      const id = typeof event === 'object' && event !== null
        ? (event as { id?: unknown }).id
        : undefined;
      const detail = typeof event === 'object' && event !== null
        ? (event as { progressDetail?: unknown }).progressDetail
        : undefined;

      const current = numberAt(detail, 'current');
      const total = numberAt(detail, 'total');
      if (typeof id === 'string' && current !== null && total !== null && total > 0) {
        layers.set(id, { current, total });
      }

      let done = 0;
      let size = 0;
      for (const layer of layers.values()) {
        done += layer.current;
        size += layer.total;
      }
      onProgress({
        status: typeof status === 'string' ? status : 'Pulling',
        progress: size > 0 ? Math.min(1, done / size) : null,
      });
    };

    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        buffered += chunk.toString('utf8');
        const parts = buffered.split('\n');
        buffered = parts.pop() ?? '';
        for (const part of parts) handle(part);
      }
      handle(buffered);
    } catch (error) {
      throw this.wrap(error, 'pull');
    }

    if (failed !== null) {
      throw new PlatterError('driver_error', `The image could not be pulled: ${failed}`, {
        retryable: true,
      });
    }
  }

  async create(spec: ContainerSpec): Promise<string> {
    try {
      const container = await this.docker.createContainer(this.createOptions(spec));
      this.idCache.set(spec.serverId, container.id);
      return container.id;
    } catch (error) {
      if (statusOf(error) === 409) {
        throw new PlatterError('conflict', 'A container for this server already exists.');
      }
      throw this.wrap(error, 'create');
    }
  }

  async recreate(spec: ContainerSpec): Promise<string> {
    // The data volume is a host bind mount, so removing the container cannot touch it —
    // that is what makes create-or-replace safe for a limits or image change.
    await this.remove(spec.serverId);
    return this.create(spec);
  }

  async start(serverId: string): Promise<void> {
    const started = await this.withContainer(serverId, 'start', async (container) => {
      try {
        await container.start();
      } catch (error) {
        // 304 is Docker's "already running", which is success for an idempotent start.
        if (statusOf(error) !== 304) throw error;
      }
      return true;
    });
    if (started === null) throw new PlatterError('not_found', 'That container no longer exists.');
  }

  async stop(serverId: string, options: { signal: string; timeoutSeconds: number }): Promise<void> {
    await this.withContainer(serverId, 'stop', async (container) => {
      try {
        await container.stop({ signal: options.signal, t: Math.max(0, options.timeoutSeconds) });
      } catch (error) {
        if (statusOf(error) !== 304) throw error;
      }
    });
  }

  async kill(serverId: string): Promise<void> {
    await this.withContainer(serverId, 'kill', async (container) => {
      try {
        await container.kill();
      } catch (error) {
        // 409 here means "not running", which the interface defines as success.
        if (statusOf(error) !== 409) throw error;
      }
    });
  }

  async remove(serverId: string, options: { removeVolume?: boolean } = {}): Promise<void> {
    await this.withContainer(serverId, 'remove', async (container) => {
      await container.remove({ force: true, v: options.removeVolume === true });
    });
    this.idCache.delete(serverId);
  }

  async inspect(serverId: string): Promise<ContainerState> {
    const info = await this.withContainer(serverId, 'inspect', async (container) =>
      container.inspect(),
    );
    if (!info) {
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

    const zeroTime = '0001-01-01T00:00:00Z';
    return {
      exists: true,
      id: info.Id,
      running: info.State.Running,
      state: info.State.Status,
      // Docker keeps the last exit code forever; it is only meaningful once stopped.
      exitCode: info.State.Running ? null : info.State.ExitCode,
      startedAt: info.State.StartedAt === zeroTime ? null : info.State.StartedAt,
      finishedAt: info.State.FinishedAt === zeroTime ? null : info.State.FinishedAt,
      restarting: info.State.Restarting,
      oomKilled: info.State.OOMKilled,
    };
  }

  async usage(serverId: string): Promise<ContainerUsage | null> {
    const stats = await this.withContainer(serverId, 'stats', async (container) =>
      container.stats({ stream: false }),
    );
    if (!stats) return null;
    // A stopped container still answers, with everything zeroed. `null` is the honest
    // answer for "not running" and keeps the caller from charting a flat line.
    if ((numberAt(stats.memory_stats, 'limit') ?? 0) === 0) return null;

    let rx = 0;
    let tx = 0;
    for (const network of Object.values(stats.networks ?? {})) {
      rx += numberAt(network, 'rx_bytes') ?? 0;
      tx += numberAt(network, 'tx_bytes') ?? 0;
    }

    return {
      cpuPercent: cpuPercentFrom(stats),
      memoryBytes: memoryBytesFrom(stats),
      memoryLimitBytes: numberAt(stats.memory_stats, 'limit') ?? 0,
      networkRxBytes: rx,
      networkTxBytes: tx,
      blockReadBytes: blkioBytesFrom(stats, 'read'),
      blockWriteBytes: blkioBytesFrom(stats, 'write'),
      pids: numberAt(stats.pids_stats, 'current') ?? 0,
      sampledAt: new Date(),
    };
  }

  streamLogs(serverId: string, options: LogStreamOptions = {}): AsyncIterable<DriverLogLine> {
    return this.iterateLogs(serverId, options);
  }

  async writeStdin(serverId: string, line: string): Promise<void> {
    const written = await this.withContainer(serverId, 'attach', async (container) => {
      const stream = await container.attach({
        stream: true,
        stdin: true,
        // Without hijack the daemon answers with an http response body instead of handing
        // over the raw connection, and nothing typed ever reaches the process.
        hijack: true,
      });
      try {
        const payload = line.endsWith('\n') ? line : `${line}\n`;
        await new Promise<void>((resolve, reject) => {
          stream.write(payload, (error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      } finally {
        // Detaching does not close the container's stdin because `StdinOnce` is false;
        // holding the connection open instead would leak one socket per command.
        stream.end();
      }
      return true;
    });
    if (written === null) throw new PlatterError('not_found', 'That container no longer exists.');
  }

  async exec(
    serverId: string,
    command: string[],
    options: { timeoutMs?: number } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const result = await this.withContainer(serverId, 'exec', async (container) => {
      const handle = await container.exec({
        Cmd: command,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
      });
      const stream = await handle.start({ hijack: true, stdin: false });
      const decoder = new LogDecoder(false);
      const stdout: string[] = [];
      const stderr: string[] = [];

      const collect = async (): Promise<void> => {
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          for (const entry of decoder.push(chunk)) {
            (entry.stream === 'stderr' ? stderr : stdout).push(entry.content);
          }
        }
        for (const entry of decoder.flush()) {
          (entry.stream === 'stderr' ? stderr : stdout).push(entry.content);
        }
      };

      try {
        await withTimeout(
          collect(),
          options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
          'The command took too long to finish.',
        );
      } finally {
        stream.destroy();
      }

      const info = await handle.inspect();
      return {
        exitCode: info.ExitCode ?? 0,
        stdout: stdout.join('\n'),
        stderr: stderr.join('\n'),
      };
    });

    if (!result) throw new PlatterError('not_found', 'That container no longer exists.');
    return result;
  }

  async diskUsage(serverId: string): Promise<number> {
    const info = await this.withContainer(serverId, 'inspect', async (container) =>
      container.inspect(),
    );
    if (!info) throw new PlatterError('not_found', 'That container no longer exists.');

    const bind = info.Mounts.find((mount) => mount.Type === 'bind');
    if (this.local && bind) {
      // Walking the host directory beats `du` in the container: the image is not
      // guaranteed to ship coreutils, and a busy game server should not fork for a number
      // shown on a dashboard.
      const size = await directorySize(bind.Source);
      if (size !== null) return size;
    }

    const target = bind?.Destination ?? '/data';
    const result = await this.exec(serverId, ['du', '-sb', target], { timeoutMs: 60_000 });
    const bytes = Number.parseInt(result.stdout.trim().split(/\s+/)[0] ?? '', 10);
    if (Number.isNaN(bytes)) {
      throw new PlatterError('driver_error', 'The node could not measure that disk usage.');
    }
    return bytes;
  }

  async archivePath(serverId: string, target: string): Promise<Readable> {
    const stream = await this.withContainer(serverId, 'archive', async (container) =>
      container.getArchive({ path: target }),
    );
    if (!stream) throw new PlatterError('not_found', 'That container no longer exists.');
    return stream instanceof Readable ? stream : Readable.from(stream);
  }

  async listOrphans(): Promise<Array<{ serverId: string; containerId: string }>> {
    try {
      const containers = await this.docker.listContainers({
        all: true,
        filters: {
          label: [`${DRIVER_LABELS.managed}=true`, `${DRIVER_LABELS.nodeId}=${this.nodeId}`],
        },
      });
      // The driver has no view of the database, so this is every container it manages;
      // `reconcile()` subtracts the ones Platter still has a server row for.
      const found: Array<{ serverId: string; containerId: string }> = [];
      for (const container of containers) {
        const serverId = container.Labels[DRIVER_LABELS.serverId];
        if (serverId) found.push({ serverId, containerId: container.Id });
      }
      return found;
    } catch (error) {
      throw this.wrap(error, 'list');
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private createOptions(spec: ContainerSpec): Docker.ContainerCreateOptions {
    const exposed: Record<string, Record<string, never>> = {};
    const bindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
    for (const port of spec.ports) {
      const key = `${port.containerPort}/${port.protocol}`;
      exposed[key] = {};
      const existing = bindings[key] ?? [];
      existing.push({ HostIp: port.hostIp, HostPort: String(port.hostPort) });
      bindings[key] = existing;
    }

    const memory = Math.max(0, Math.round(spec.limits.memoryMb)) * MIB;
    const cpuCores = spec.limits.cpuCores;

    return {
      name: containerNameFor(spec.serverId, slugify(spec.name)),
      Image: spec.image,
      Cmd: spec.command && spec.command.length > 0 ? spec.command : undefined,
      Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
      Labels: {
        ...spec.labels,
        [DRIVER_LABELS.managed]: 'true',
        [DRIVER_LABELS.serverId]: spec.serverId,
        [DRIVER_LABELS.serverName]: spec.name,
        [DRIVER_LABELS.nodeId]: this.nodeId,
      },
      Tty: false,
      OpenStdin: spec.interactive,
      AttachStdin: spec.interactive,
      // Deliberately false: `StdinOnce` closes the container's stdin the first time a
      // client detaches, which would make the second console command disappear into a
      // closed pipe. Each `writeStdin` attaches and detaches.
      StdinOnce: false,
      ExposedPorts: exposed,
      WorkingDir: spec.dataPath,
      HostConfig: {
        Binds: [`${spec.dataHostPath}:${spec.dataPath}`],
        PortBindings: bindings,
        Memory: memory,
        // Docker's `MemorySwap` is memory *plus* swap, not swap on its own: passing the
        // swap allowance alone would silently shrink the memory limit. -1 is unlimited,
        // and equal-to-memory is how you disable swap entirely.
        MemorySwap:
          spec.limits.swapMb < 0 ? -1 : memory + Math.max(0, Math.round(spec.limits.swapMb)) * MIB,
        NanoCpus: cpuCores > 0 ? Math.max(MIN_NANO_CPUS, Math.round(cpuCores * NANO)) : 0,
        BlkioWeight: clamp(spec.limits.ioWeight, 10, 1000),
        PidsLimit: spec.limits.pidsLimit > 0 ? spec.limits.pidsLimit : DEFAULT_PIDS_LIMIT,
        // Platter supervises restarts itself, with a crash-loop cutoff. Docker's own
        // policy would fight that and hide crashes from the audit trail.
        RestartPolicy: { Name: 'no' },
        LogConfig: { Type: 'json-file', Config: { 'max-size': '16m', 'max-file': '3' } },
      },
    };
  }

  private async resolveId(serverId: string, refresh = false): Promise<string | null> {
    if (!refresh) {
      const cached = this.idCache.get(serverId);
      if (cached) return cached;
    }
    try {
      const containers = await this.docker.listContainers({
        all: true,
        filters: {
          label: [`${DRIVER_LABELS.serverId}=${serverId}`, `${DRIVER_LABELS.nodeId}=${this.nodeId}`],
        },
      });
      const found = containers[0];
      if (!found) {
        this.idCache.delete(serverId);
        return null;
      }
      this.idCache.set(serverId, found.Id);
      return found.Id;
    } catch (error) {
      throw this.wrap(error, 'lookup');
    }
  }

  /** Resolves the container and runs `fn`, or answers null when it does not exist. */
  private async withContainer<T>(
    serverId: string,
    action: string,
    fn: (container: Docker.Container) => Promise<T>,
  ): Promise<T | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const id = await this.resolveId(serverId, attempt === 1);
      if (!id) return null;
      try {
        return await fn(this.docker.getContainer(id));
      } catch (error) {
        if (statusOf(error) !== 404) throw this.wrap(error, action);
        // A cached id outlives its container whenever something else recreated it; one
        // forced re-resolve separates "stale cache" from "really gone".
        this.idCache.delete(serverId);
      }
    }
    return null;
  }

  private async *iterateLogs(
    serverId: string,
    options: LogStreamOptions,
  ): AsyncGenerator<DriverLogLine> {
    const id = await this.resolveId(serverId);
    if (!id) throw new PlatterError('not_found', 'That container no longer exists.');
    const container = this.docker.getContainer(id);

    let raw = false;
    try {
      const info = await container.inspect();
      // An adopted container may have been created with a TTY, in which case there is no
      // frame header to strip and stripping one would eat eight bytes of real output.
      raw = info.Config.Tty === true;
    } catch (error) {
      throw this.wrap(error, 'inspect');
    }

    let stream: NodeJS.ReadableStream;
    try {
      stream = await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        timestamps: true,
        tail: options.tail ?? 100,
        ...(options.since ? { since: Math.floor(options.since.getTime() / 1000) } : {}),
      });
    } catch (error) {
      throw this.wrap(error, 'logs');
    }

    const readable = stream instanceof Readable ? stream : Readable.from(stream);
    const decoder = new LogDecoder(raw);
    // Destroying the socket is the whole point of the abort path: a console tab that
    // closes without it leaves a follow stream open on the daemon forever, and enough of
    // those exhaust its connection limit.
    const onAbort = (): void => {
      readable.destroy();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      if (options.signal?.aborted) return;
      for await (const chunk of readable as AsyncIterable<Buffer>) {
        for (const line of decoder.push(chunk)) {
          yield line;
          if (options.signal?.aborted) return;
        }
      }
      for (const line of decoder.flush()) yield line;
    } catch (error) {
      if (options.signal?.aborted) return;
      throw this.wrap(error, 'logs');
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      readable.destroy();
    }
  }

  /**
   * Every failure crossing this boundary is a `PlatterError`. Dockerode's own errors
   * carry daemon internals in their message, so only the shape of the failure is
   * translated and the original is kept as `cause` for the log.
   */
  private wrap(error: unknown, action: string): PlatterError {
    if (error instanceof PlatterError) return error;

    const { code } = failure(error);
    if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) {
      return new PlatterError('node_unreachable', 'The host node is not responding.', {
        cause: error,
        retryable: true,
      });
    }

    const status = statusOf(error);
    if (status === 404) {
      return new PlatterError('not_found', 'That container no longer exists.', { cause: error });
    }
    if (status === 409) {
      return new PlatterError('conflict', 'The container runtime refused: it conflicts with something that already exists.', {
        cause: error,
      });
    }
    return new PlatterError('driver_error', `The container runtime rejected the ${action} request.`, {
      cause: error,
      retryable: true,
    });
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Math.round(value)));
}

/** Container names accept `[a-zA-Z0-9][a-zA-Z0-9_.-]*` and nothing else. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return slug.length > 0 ? slug : 'server';
}

async function directorySize(root: string): Promise<number | null> {
  const queue: string[] = [root];
  let total = 0;
  try {
    while (queue.length > 0) {
      const current = queue.pop();
      if (current === undefined) break;
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) queue.push(full);
        else if (entry.isFile()) total += (await stat(full)).size;
      }
    }
    return total;
  } catch {
    // A remote daemon's bind source does not exist locally; the caller falls back to exec.
    return null;
  }
}
