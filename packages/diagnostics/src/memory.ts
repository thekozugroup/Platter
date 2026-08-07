import { LOADER_FAMILY } from '@platter/shared';
import type { MatchContext } from './types';

/**
 * How much memory to suggest, and why it is computed rather than looked up.
 *
 * "Try 4 GB" is the standard advice on every panel and forum, and it is wrong about half the
 * time: wrong for a vanilla server with three players, wrong for a 200-mod pack that needs
 * eight. A constant also cannot be applied twice — a server already at 4 GB that runs out of
 * memory is told to set 4 GB again, and Platter would be proposing a no-op fix.
 *
 * So the recommendation is a function of where the server is now and what it is running. It
 * always moves upward, and it always lands on a round number an operator can reason about.
 */

/** Round up to a step a human recognises, so the UI never offers 5 291 MiB. */
const STEP_MiB = 512;

/** Past this, memory is not the problem — something is leaking, and more RAM only delays it. */
export const MAX_RECOMMENDED_MiB = 16_384;

/** Below this nothing modern starts at all, whatever the workload. */
const FLOOR_MiB = 1024;

function roundUp(mib: number): number {
  return Math.ceil(mib / STEP_MiB) * STEP_MiB;
}

/**
 * What this workload needs at minimum, ignoring the current setting.
 *
 * The mod count is the dominant term by a wide margin: mods cost memory at load time
 * (class metadata, registries, recipe tables) before a single chunk is generated, which is why
 * a big pack can exhaust a heap that a vanilla server would never touch.
 */
export function baselineForWorkload(ctx: MatchContext): number {
  const family = ctx.server.loader === undefined ? 'vanilla' : LOADER_FAMILY[ctx.server.loader];
  const modCount = ctx.mods.length;

  if (family === 'mod') {
    if (modCount >= 150) {
      return 8192;
    }
    if (modCount >= 50) {
      return 6144;
    }
    return 4096;
  }
  if (family === 'plugin') {
    return modCount >= 25 ? 4096 : 2048;
  }
  return 2048;
}

export interface MemoryRecommendation {
  readonly memoryMiB: number;
  /** The current ceiling, when Platter knows it. */
  readonly currentMiB?: number;
  /** True when the workload baseline drove the number rather than the step up. */
  readonly baselineDriven: boolean;
  /** True when the recommendation is already at the ceiling this engine will suggest. */
  readonly atCeiling: boolean;
}

/**
 * The next sensible ceiling for a server that has run out of memory.
 *
 * Half again as much, floored by what the workload needs anyway, rounded to 512 MiB. Growing by
 * a proportion rather than a constant matters at both ends: +1 GB is a rounding error on a 12 GB
 * server and a doubling on a 1 GB one.
 */
export function recommendMemory(ctx: MatchContext): MemoryRecommendation {
  const current = ctx.server.memoryMiB;
  const baseline = baselineForWorkload(ctx);
  const stepped = current === undefined ? baseline : roundUp(current * 1.5);
  const target = Math.min(MAX_RECOMMENDED_MiB, Math.max(FLOOR_MiB, baseline, stepped));

  return {
    memoryMiB: target,
    ...(current === undefined ? {} : { currentMiB: current }),
    baselineDriven: target === baseline && baseline >= stepped,
    atCeiling: target >= MAX_RECOMMENDED_MiB,
  };
}

/**
 * The smaller bump for a container that was killed from outside rather than by its own heap.
 *
 * When the kernel OOM-kills the container, the heap was probably fine — what overflowed was
 * everything the JVM allocates *outside* it: metaspace, code cache, GC structures, thread
 * stacks, and Netty's direct buffers, which grow per connected player. itzg's own guidance is to
 * budget an extra 25% over the heap for exactly this, so that is what we add, rather than the
 * half-again step used when the heap itself filled up.
 */
export function recommendHeadroom(ctx: MatchContext): MemoryRecommendation {
  const current = ctx.server.memoryMiB;
  const baseline = baselineForWorkload(ctx);
  const stepped = current === undefined ? baseline : roundUp(current * 1.25);
  const target = Math.min(MAX_RECOMMENDED_MiB, Math.max(FLOOR_MiB, baseline, stepped));

  return {
    memoryMiB: target,
    ...(current === undefined ? {} : { currentMiB: current }),
    baselineDriven: target === baseline && baseline >= stepped,
    atCeiling: target >= MAX_RECOMMENDED_MiB,
  };
}

/** `4096` → `4 GB`, `6144` → `6 GB`, `2560` → `2.5 GB`. For prose, not for config. */
export function formatMiB(mib: number): string {
  if (mib < 1024) {
    return `${mib} MB`;
  }
  const gb = mib / 1024;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}
