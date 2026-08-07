import type Docker from 'dockerode';
import { type Result, attempt, ok } from '@platter/shared';

/**
 * Container resource statistics.
 *
 * Docker's `/stats` endpoint returns cumulative counters, not rates, and the naive
 * `cpu_usage.total_usage / system_cpu_usage` reading is wrong in a way that looks plausible —
 * it reports lifetime average rather than current load, so a server that was busy an hour ago
 * shows as busy forever. The correct calculation deltas both counters against the `precpu`
 * snapshot in the same payload, which is why `stream: false` still returns two sets of numbers.
 */

export interface ContainerStats {
  /** Percentage of one core, so 250 means two and a half cores' worth. */
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  networkRxBytes: number;
  networkTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
  at: number;
}

interface RawStats {
  cpu_stats: {
    cpu_usage: { total_usage: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats: {
    cpu_usage: { total_usage: number };
    system_cpu_usage?: number;
  };
  memory_stats: {
    usage?: number;
    limit?: number;
    stats?: Record<string, number>;
  };
  networks?: Record<string, { rx_bytes: number; tx_bytes: number }>;
  blkio_stats?: { io_service_bytes_recursive?: { op: string; value: number }[] | null };
  pids_stats?: { current?: number };
}

export function computeStats(raw: RawStats): ContainerStats {
  const cpuDelta = raw.cpu_stats.cpu_usage.total_usage - raw.precpu_stats.cpu_usage.total_usage;
  const systemDelta = (raw.cpu_stats.system_cpu_usage ?? 0) - (raw.precpu_stats.system_cpu_usage ?? 0);
  const cores = raw.cpu_stats.online_cpus ?? raw.cpu_stats.cpu_usage.percpu_usage?.length ?? 1;

  // The first sample after a container starts has no `precpu` baseline, so both deltas are
  // zero or negative. Reporting 0 there is honest; reporting NaN or a huge spike is not.
  const cpuPercent =
    systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * cores * 100 : 0;

  // `memory_stats.usage` includes the page cache, which for a Minecraft server reading chunk
  // files is easily a gigabyte of memory that is not actually in use and is instantly
  // reclaimable. Subtracting it is what `docker stats` itself does, and without it every server
  // appears to sit near its memory limit.
  const rawUsage = raw.memory_stats.usage ?? 0;
  const cache =
    raw.memory_stats.stats?.inactive_file ??
    raw.memory_stats.stats?.total_inactive_file ??
    raw.memory_stats.stats?.cache ??
    0;
  const memoryUsedBytes = Math.max(0, rawUsage - cache);
  const memoryLimitBytes = raw.memory_stats.limit ?? 0;

  let networkRxBytes = 0;
  let networkTxBytes = 0;
  for (const iface of Object.values(raw.networks ?? {})) {
    networkRxBytes += iface.rx_bytes;
    networkTxBytes += iface.tx_bytes;
  }

  let blockReadBytes = 0;
  let blockWriteBytes = 0;
  for (const entry of raw.blkio_stats?.io_service_bytes_recursive ?? []) {
    if (entry.op.toLowerCase() === 'read') {
      blockReadBytes += entry.value;
    } else if (entry.op.toLowerCase() === 'write') {
      blockWriteBytes += entry.value;
    }
  }

  return {
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    memoryUsedBytes,
    memoryLimitBytes,
    memoryPercent:
      memoryLimitBytes > 0 ? Math.round((memoryUsedBytes / memoryLimitBytes) * 1000) / 10 : 0,
    networkRxBytes,
    networkTxBytes,
    blockReadBytes,
    blockWriteBytes,
    pids: raw.pids_stats?.current ?? 0,
    at: Date.now(),
  };
}

export async function readStats(
  docker: Docker,
  containerId: string
): Promise<Result<ContainerStats>> {
  const raw = await attempt(async () => {
    const result = await docker.getContainer(containerId).stats({ stream: false });
    return result as unknown as RawStats;
  });
  return raw.ok ? ok(computeStats(raw.value)) : raw;
}
