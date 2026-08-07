import { describe, expect, it } from 'vitest';
import {
  baselineForWorkload,
  formatMiB,
  MAX_RECOMMENDED_MiB,
  recommendHeadroom,
  recommendMemory,
} from './memory';
import type { InstalledMod, MatchContext } from './types';

/**
 * The memory recommendation is the one number in this package that a user acts on directly, so
 * it gets its own tests. The property that matters most is that it is a *function* — "try 4 GB"
 * is the advice every panel gives, and it is a no-op for the many servers already at 4 GB.
 */

function ctx(
  server: Partial<MatchContext['server']> = {},
  mods: InstalledMod[] = []
): MatchContext {
  return { blocks: [], server, mods };
}

describe('recommendMemory', () => {
  it('always moves upward', () => {
    for (const current of [512, 1024, 2048, 3072, 4096, 6144, 8192, 12_288]) {
      const rec = recommendMemory(ctx({ memoryMiB: current, loader: 'vanilla' }));
      expect(rec.memoryMiB).toBeGreaterThan(current);
    }
  });

  it('steps by a proportion rather than a constant', () => {
    // +1 GB is a doubling on a small server and a rounding error on a large one.
    const small = recommendMemory(ctx({ memoryMiB: 1024, loader: 'vanilla' }));
    const large = recommendMemory(ctx({ memoryMiB: 8192, loader: 'vanilla' }));
    expect(large.memoryMiB - 8192).toBeGreaterThan(small.memoryMiB - 1024);
  });

  it('lands on a round number', () => {
    for (const current of [700, 1300, 2900, 5100]) {
      expect(recommendMemory(ctx({ memoryMiB: current })).memoryMiB % 512).toBe(0);
    }
  });

  it('scales its floor with the mod count', () => {
    const mods = (n: number): InstalledMod[] =>
      Array.from({ length: n }, (_, i) => ({ id: `mod${i}` }));
    const vanilla = baselineForWorkload(ctx({ loader: 'vanilla' }));
    const light = baselineForWorkload(ctx({ loader: 'fabric' }, mods(10)));
    const heavy = baselineForWorkload(ctx({ loader: 'fabric' }, mods(80)));
    const huge = baselineForWorkload(ctx({ loader: 'fabric' }, mods(200)));

    expect(vanilla).toBeLessThan(light);
    expect(light).toBeLessThan(heavy);
    expect(heavy).toBeLessThan(huge);
  });

  it('lifts a badly undersized modded server straight to its baseline', () => {
    const mods = Array.from({ length: 120 }, (_, i) => ({ id: `mod${i}` }));
    const rec = recommendMemory(ctx({ memoryMiB: 1024, loader: 'forge' }, mods));
    expect(rec.memoryMiB).toBe(6144);
    expect(rec.baselineDriven).toBe(true);
  });

  it('refuses to recommend beyond the point where memory is the problem', () => {
    const rec = recommendMemory(ctx({ memoryMiB: 30_000, loader: 'forge' }));
    expect(rec.memoryMiB).toBe(MAX_RECOMMENDED_MiB);
    expect(rec.atCeiling).toBe(true);
  });

  it('works with no current limit known', () => {
    const rec = recommendMemory(ctx({ loader: 'paper' }));
    expect(rec.memoryMiB).toBeGreaterThan(0);
    expect(rec.currentMiB).toBeUndefined();
  });
});

describe('recommendHeadroom', () => {
  it('bumps more gently than a heap failure does', () => {
    const heap = recommendMemory(ctx({ memoryMiB: 8192, loader: 'vanilla' }));
    const headroom = recommendHeadroom(ctx({ memoryMiB: 8192, loader: 'vanilla' }));
    expect(headroom.memoryMiB).toBeLessThan(heap.memoryMiB);
    expect(headroom.memoryMiB).toBeGreaterThan(8192);
  });
});

describe('formatMiB', () => {
  it('reads the way a person would say it', () => {
    expect(formatMiB(512)).toBe('512 MB');
    expect(formatMiB(4096)).toBe('4 GB');
    expect(formatMiB(6144)).toBe('6 GB');
    expect(formatMiB(2560)).toBe('2.5 GB');
  });
});
