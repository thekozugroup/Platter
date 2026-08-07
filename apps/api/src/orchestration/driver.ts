import type { Readable } from 'node:stream';
import type { ServerStatus } from '@platter/shared';

/**
 * The contract between Platter and whatever actually runs containers.
 *
 * Everything above this line (routes, services, the scheduler) is written against this
 * interface only, which is what makes the in-memory `MockDriver` a complete stand-in for
 * Docker in tests — no daemon, no sockets, same code paths.
 *
 * Implementations must be **idempotent** wherever it is cheap to be: starting a running
 * container succeeds, removing a missing one succeeds. Reconciliation loops call these
 * methods repeatedly and should not have to special-case "already done".
 */

export interface ContainerSpec {
  /** Platter server id; becomes the container name suffix and a label. */
  serverId: string;
  /** Human name, used for the container name so `docker ps` is readable. */
  name: string;
  image: string;
  /** Overrides the image ENTRYPOINT/CMD when non-empty. */
  command: string[] | null;
  env: Record<string, string>;
  /** Host path mounted at `dataPath`. Created by the caller before this runs. */
  dataHostPath: string;
  dataPath: string;
  ports: PortBinding[];
  limits: ContainerLimits;
  /** Applied as container labels so orphans can be found after a Platter restart. */
  labels: Record<string, string>;
  /** Keep stdin open — required for console input on games without RCON. */
  interactive: boolean;
}

export interface PortBinding {
  hostIp: string;
  hostPort: number;
  containerPort: number;
  protocol: 'tcp' | 'udp';
}

export interface ContainerLimits {
  memoryMb: number;
  /** -1 means unlimited swap, 0 disables it. */
  swapMb: number;
  /** Whole cores as a float; 0 means unlimited. */
  cpuCores: number;
  ioWeight: number;
  /** Hard cap on the number of processes, to contain fork bombs from modded servers. */
  pidsLimit: number;
}

/** Raw runtime state, before Platter maps it onto a `ServerStatus`. */
export interface ContainerState {
  exists: boolean;
  id: string | null;
  running: boolean;
  /** Docker's own status word: `created`, `running`, `exited`, `paused`, … */
  state: string;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** True when the runtime restarted it under its own restart policy. */
  restarting: boolean;
  /** OOM kill is worth surfacing distinctly — it means "give it more memory". */
  oomKilled: boolean;
}

export interface ContainerUsage {
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
  sampledAt: Date;
}

export interface DriverHealth {
  reachable: boolean;
  version: string | null;
  /** Total physical resources on the host, used for capacity display and placement. */
  cpuCores: number | null;
  memoryTotalMb: number | null;
  containersRunning: number | null;
  error: string | null;
}

export interface LogStreamOptions {
  /** Number of historical lines to replay before switching to live output. */
  tail?: number;
  /** Emit only lines after this timestamp. */
  since?: Date;
  /** Aborts the stream; always provide one so sockets clean up on disconnect. */
  signal?: AbortSignal;
}

/** One demultiplexed line of container output. */
export interface DriverLogLine {
  stream: 'stdout' | 'stderr';
  content: string;
  timestamp: Date;
}

export interface PullProgress {
  status: string;
  /** 0–1 when the runtime reports byte counts, null for indeterminate steps. */
  progress: number | null;
}

/**
 * A single host's container runtime.
 *
 * Methods throw `PlatterError` with `driver_error` or `node_unreachable` on failure;
 * they never return partial success.
 */
export interface OrchestrationDriver {
  readonly kind: 'docker' | 'mock';
  readonly nodeId: string;

  /** Probe the runtime. Never throws — an unreachable node is a value, not an exception. */
  health(): Promise<DriverHealth>;

  /** Pull the image, reporting progress. Resolves once the image is locally available. */
  pullImage(image: string, onProgress?: (progress: PullProgress) => void): Promise<void>;

  /** Create the container. Fails with `conflict` if one already exists for this server. */
  create(spec: ContainerSpec): Promise<string>;

  /** Create-or-replace: used when limits, ports or the image change. Preserves the volume. */
  recreate(spec: ContainerSpec): Promise<string>;

  start(serverId: string): Promise<void>;

  /**
   * Graceful stop. Sends `signal` and escalates to SIGKILL after `timeoutSeconds`.
   * Resolves when the container has actually exited.
   */
  stop(serverId: string, options: { signal: string; timeoutSeconds: number }): Promise<void>;

  /** Immediate SIGKILL. Resolves even if the container was already stopped. */
  kill(serverId: string): Promise<void>;

  /** Remove the container. The data volume is untouched unless `removeVolume` is set. */
  remove(serverId: string, options?: { removeVolume?: boolean }): Promise<void>;

  inspect(serverId: string): Promise<ContainerState>;

  /** Point-in-time usage. Returns null when the container is not running. */
  usage(serverId: string): Promise<ContainerUsage | null>;

  /**
   * Live log stream. The returned iterator ends when the container exits or the
   * abort signal fires.
   */
  streamLogs(serverId: string, options?: LogStreamOptions): AsyncIterable<DriverLogLine>;

  /** Write a line to the container's stdin. Requires `interactive` on the spec. */
  writeStdin(serverId: string, line: string): Promise<void>;

  /**
   * Run a command inside the container and collect its output. Used by install steps
   * and by RCON-less player counts. Never exposed directly to end users.
   */
  exec(
    serverId: string,
    command: string[],
    options?: { timeoutMs?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;

  /** Byte size of the server's data directory, for quota display and enforcement. */
  diskUsage(serverId: string): Promise<number>;

  /** Stream a tar archive of a path inside the container, for backups and downloads. */
  archivePath(serverId: string, path: string): Promise<Readable>;

  /** Containers this driver manages that Platter no longer has a server record for. */
  listOrphans(): Promise<Array<{ serverId: string; containerId: string }>>;
}

/**
 * Map raw runtime state onto Platter's lifecycle vocabulary.
 *
 * The current status matters: an exited container is `offline` if we asked it to stop and
 * `crashed` if it went down on its own, and only the caller knows which it was.
 */
export function deriveStatus(state: ContainerState, expected: ServerStatus): ServerStatus {
  if (!state.exists) {
    return expected === 'deleting' || expected === 'provisioning' ? expected : 'offline';
  }
  if (state.restarting) return 'restarting';
  if (state.running) {
    // A container can be up before the game inside it has finished booting; only the
    // log watcher's ready-signal promotes `starting` to `running`.
    return expected === 'starting' || expected === 'installing' ? expected : 'running';
  }
  if (expected === 'stopping' || expected === 'offline' || expected === 'suspended') {
    return expected === 'stopping' ? 'offline' : expected;
  }
  if (state.oomKilled) return 'crashed';
  return state.exitCode !== null && state.exitCode !== 0 ? 'crashed' : 'offline';
}

/** Container name Platter uses on every driver, so orphan sweeps are runtime-agnostic. */
export function containerNameFor(serverId: string, slug: string): string {
  return `platter-${slug}-${serverId.replace(/^srv_/, '').slice(0, 12)}`;
}

/** Label key namespace. Anything Platter creates carries `platter.managed=true`. */
export const DRIVER_LABELS = {
  managed: 'platter.managed',
  serverId: 'platter.server.id',
  serverName: 'platter.server.name',
  blueprint: 'platter.blueprint.key',
  nodeId: 'platter.node.id',
} as const;
