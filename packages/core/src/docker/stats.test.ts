import { describe, expect, it } from 'vitest';
import { computeStats } from './stats';

/**
 * Docker's /stats returns cumulative counters, and the obvious reading of them is wrong in a way
 * that looks plausible: dividing lifetime CPU by lifetime system time gives a lifetime average,
 * so a server that was busy an hour ago reads as busy forever. These tests pin the delta maths
 * and the page-cache subtraction, both of which are easy to "simplify" back into being wrong.
 */

const raw = (overrides: Partial<Parameters<typeof computeStats>[0]> = {}) =>
  ({
    cpu_stats: {
      cpu_usage: { total_usage: 2_000_000_000 },
      system_cpu_usage: 100_000_000_000,
      online_cpus: 4,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 1_000_000_000 },
      system_cpu_usage: 90_000_000_000,
    },
    memory_stats: {
      usage: 2 * 1024 ** 3,
      limit: 4 * 1024 ** 3,
      stats: { inactive_file: 1024 ** 3 },
    },
    networks: { eth0: { rx_bytes: 1000, tx_bytes: 2000 } },
    blkio_stats: {
      io_service_bytes_recursive: [
        { op: 'Read', value: 500 },
        { op: 'Write', value: 700 },
      ],
    },
    pids_stats: { current: 42 },
    ...overrides,
  }) as Parameters<typeof computeStats>[0];

describe('computeStats', () => {
  it('computes CPU from the delta against the precpu snapshot', () => {
    // 1e9 container ns over 1e10 system ns across 4 cores = 10% × 4 = 40%.
    expect(computeStats(raw()).cpuPercent).toBeCloseTo(40, 1);
  });

  it('reports 0% for the first sample, which has no baseline', () => {
    // Reporting NaN or a huge spike here is what makes a freshly started server look pegged.
    const stats = computeStats(
      raw({
        precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
      })
    );
    expect(stats.cpuPercent).toBe(0);
  });

  it('never reports negative CPU when counters go backwards', () => {
    const stats = computeStats(
      raw({
        cpu_stats: { cpu_usage: { total_usage: 1 }, system_cpu_usage: 1, online_cpus: 4 },
        precpu_stats: { cpu_usage: { total_usage: 500 }, system_cpu_usage: 500 },
      })
    );
    expect(stats.cpuPercent).toBe(0);
  });

  it('falls back to the percpu array length when online_cpus is missing', () => {
    const stats = computeStats(
      raw({
        cpu_stats: {
          cpu_usage: { total_usage: 2_000_000_000, percpu_usage: [1, 2] },
          system_cpu_usage: 100_000_000_000,
        },
      })
    );
    expect(stats.cpuPercent).toBeCloseTo(20, 1);
  });

  it('subtracts the page cache from memory usage', () => {
    // A Minecraft server reading chunk files easily holds a gigabyte of reclaimable page cache.
    // Counting it makes every server look near its limit — this is what `docker stats` does too.
    const stats = computeStats(raw());
    expect(stats.memoryUsedBytes).toBe(1024 ** 3);
    expect(stats.memoryPercent).toBeCloseTo(25, 1);
  });

  it('accepts the alternative cgroup field names', () => {
    expect(
      computeStats(
        raw({
          memory_stats: { usage: 2 * 1024 ** 3, limit: 4 * 1024 ** 3, stats: { total_inactive_file: 1024 ** 3 } },
        })
      ).memoryUsedBytes
    ).toBe(1024 ** 3);

    expect(
      computeStats(
        raw({ memory_stats: { usage: 2 * 1024 ** 3, limit: 4 * 1024 ** 3, stats: { cache: 1024 ** 3 } } })
      ).memoryUsedBytes
    ).toBe(1024 ** 3);
  });

  it('never reports negative memory', () => {
    const stats = computeStats(
      raw({ memory_stats: { usage: 100, limit: 1000, stats: { inactive_file: 500 } } })
    );
    expect(stats.memoryUsedBytes).toBe(0);
  });

  it('handles a missing memory limit without dividing by zero', () => {
    const stats = computeStats(raw({ memory_stats: { usage: 1000, stats: {} } }));
    expect(stats.memoryPercent).toBe(0);
  });

  it('sums network counters across interfaces', () => {
    const stats = computeStats(
      raw({ networks: { eth0: { rx_bytes: 10, tx_bytes: 20 }, eth1: { rx_bytes: 5, tx_bytes: 7 } } })
    );
    expect(stats.networkRxBytes).toBe(15);
    expect(stats.networkTxBytes).toBe(27);
  });

  it('splits block IO by operation, case-insensitively', () => {
    const stats = computeStats(
      raw({
        blkio_stats: {
          io_service_bytes_recursive: [
            { op: 'read', value: 100 },
            { op: 'READ', value: 50 },
            { op: 'Write', value: 200 },
            { op: 'Sync', value: 999 },
          ],
        },
      })
    );
    expect(stats.blockReadBytes).toBe(150);
    expect(stats.blockWriteBytes).toBe(200);
  });

  it('survives an entirely empty payload', () => {
    // Docker returns near-empty stats for a container that is starting or has just exited.
    const stats = computeStats({
      cpu_stats: { cpu_usage: { total_usage: 0 } },
      precpu_stats: { cpu_usage: { total_usage: 0 } },
      memory_stats: {},
    });
    expect(stats.cpuPercent).toBe(0);
    expect(stats.memoryUsedBytes).toBe(0);
    expect(stats.pids).toBe(0);
    expect(stats.networkRxBytes).toBe(0);
  });
});
