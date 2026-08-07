import { formatMiB, recommendHeadroom, recommendMemory } from '../memory';
import type { Fix, Match, MatchContext, Rule } from '../types';
import { candidateBlocks, detailNumber, detailString, match } from './helpers';

/**
 * Running out of memory, which happens in two completely different ways that look identical
 * from the outside.
 *
 * If the *heap* fills up, the JVM notices and writes `OutOfMemoryError` before dying. If the
 * *container* exceeds its limit, the Linux kernel kills the process instantly and nothing is
 * written at all — the log simply stops mid-line and the exit code is 137. Same symptom, opposite
 * causes: the first means the heap is too small for the workload, the second usually means the
 * heap was set so close to the container limit that there was no room left for everything the
 * JVM allocates outside it.
 *
 * Telling a user to raise their heap when the kernel killed them for having too *large* a heap
 * makes the problem worse, so these are separate rules with separate explanations.
 */

/**
 * Every flavour of `OutOfMemoryError`, captured with its message.
 *
 * They are not interchangeable. "Java heap space" means the object heap filled; "Metaspace"
 * means class metadata did, which lives outside the heap and is not fixed by a bigger `-Xmx`;
 * "unable to create native thread" is usually a thread or process limit rather than memory at
 * all. Same exception, three different fixes.
 */
const OOM_RE = /java\.lang\.OutOfMemoryError(?:: (?<flavour>[^\r\n]{0,120}))?/;

/** Written by `-XX:+ExitOnOutOfMemoryError`, which the JVM may emit instead of a stack trace. */
const OOM_TERMINATING_RE = /Terminating due to java\.lang\.OutOfMemoryError/;

type OomKind = 'heap' | 'metaspace' | 'gc-overhead' | 'native-thread' | 'direct-buffer' | 'other';

/**
 * The memory recommendation, computed at match time.
 *
 * It belongs here rather than in `fixes()` because it depends on the server's current limit and
 * mod count — context a `Match` does not carry. Doing it once, during matching, keeps `fixes()`
 * a pure function of the match, which is what makes the rule catalogue testable in isolation.
 */
function sizing(ctx: MatchContext, headroomOnly: boolean): Record<string, number> {
  const rec = headroomOnly ? recommendHeadroom(ctx) : recommendMemory(ctx);
  return {
    recommendedMiB: rec.memoryMiB,
    ...(rec.currentMiB === undefined ? {} : { currentMiB: rec.currentMiB }),
  };
}

function classifyOom(flavour: string): OomKind {
  const f = flavour.toLowerCase();
  if (f.includes('metaspace') || f.includes('compressed class space')) {
    return 'metaspace';
  }
  if (f.includes('gc overhead limit')) {
    return 'gc-overhead';
  }
  if (f.includes('native thread') || f.includes('process/resource limits')) {
    return 'native-thread';
  }
  if (f.includes('direct buffer')) {
    return 'direct-buffer';
  }
  if (f.includes('heap space')) {
    return 'heap';
  }
  return 'other';
}

export const javaOutOfMemory: Rule = {
  id: 'memory.out-of-memory',
  title: 'The server ran out of memory',
  severity: 'critical',
  category: 'memory',
  hints: ['outofmemoryerror'],
  // The kernel-kill rule is about the *absence* of this evidence, so it must not fire alongside.
  supersedes: ['memory.container-killed'],

  match(ctx: MatchContext): Match | null {
    for (const block of candidateBlocks(ctx.blocks)) {
      const found = OOM_RE.exec(block.text);
      if (found) {
        const flavour = found.groups?.flavour?.trim() ?? '';
        const kind = classifyOom(flavour);
        // Metaspace and native-thread failures are outside the heap, so the smaller
        // headroom-shaped bump is the right one; a filled heap wants the half-again step.
        const outsideHeap =
          kind === 'metaspace' || kind === 'native-thread' || kind === 'direct-buffer';
        return match([block], 'high', {
          kind,
          flavour,
          ...sizing(ctx, outsideHeap),
        });
      }
      if (OOM_TERMINATING_RE.test(block.text)) {
        return match([block], 'high', { kind: 'heap', flavour: '', ...sizing(ctx, false) });
      }
    }
    return null;
  },

  explain(m: Match): string {
    const kind = detailString(m, 'kind', 'heap');
    switch (kind) {
      case 'metaspace':
        return (
          'The server ran out of room for the *descriptions* of its code rather than for game ' +
          'data. This area sits outside the main memory pool, so it is governed by the ' +
          "container's overall limit rather than by the heap size. It is almost always caused by " +
          'loading a lot of mods, and it happens during startup rather than during play.'
        );
      case 'gc-overhead':
        return (
          'The server spent nearly all of its time clearing out memory and almost none running ' +
          'the game, so Java stopped it. This is what running out of memory looks like just ' +
          'before it becomes fatal: there is technically some memory left, but not enough to make ' +
          'progress. Treat it exactly like running out.'
        );
      case 'native-thread':
        return (
          'The server could not start a new background task. Despite the name, this is usually ' +
          'not about game memory — it means the container hit its limit on how many tasks it may ' +
          'run at once, or ran out of the memory reserved outside the main pool. A mod creating ' +
          'threads without cleaning them up is the usual cause.'
        );
      case 'direct-buffer':
        return (
          'The server ran out of the memory it uses for network traffic, which sits outside the ' +
          'main game memory pool. This grows with the number of connected players, and is capped ' +
          "by the container's overall limit rather than by the heap size."
        );
      default:
        return (
          'The server needed more memory than it was allowed to use and had to stop. Everything ' +
          'that was already saved is safe, but anything since the last save may be lost. If this ' +
          'happens repeatedly at the same point, the world or a mod is asking for more than the ' +
          'current limit can provide.'
        );
    }
  },

  fixes(m: Match): Fix[] {
    const kind = detailString(m, 'kind', 'heap');
    const rec = detailNumber(m, 'recommendedMiB', 0);
    const current = detailNumber(m, 'currentMiB', 0);
    const fixes: Fix[] = [];

    if (rec > 0) {
      fixes.push({
        id: `set-memory-${rec}`,
        title:
          current > 0
            ? `Raise the memory limit from ${formatMiB(current)} to ${formatMiB(rec)}`
            : `Set the memory limit to ${formatMiB(rec)}`,
        detail:
          `Restarts the server with a higher ceiling. Platter keeps part of it in reserve for ` +
          `Java's own overheads rather than handing the whole amount to the game, which is what ` +
          `stops a raise from turning into a different crash. Make sure the host has it to spare.`,
        kind: 'automatic',
        action: { type: 'set_memory', memoryMiB: rec },
        confidence: kind === 'native-thread' ? 'low' : 'high',
      });
    }

    if (kind === 'native-thread') {
      fixes.push({
        id: 'investigate-thread-leak',
        title: 'Look for a mod creating runaway background tasks',
        detail:
          'Raising memory rarely fixes this on its own. Restart, watch which mod is active in the ' +
          'log just before the failure, and check whether it has a newer release.',
        kind: 'manual',
        confidence: 'medium',
      });
    }

    if (kind === 'gc-overhead' || kind === 'heap') {
      fixes.push({
        id: 'reduce-view-distance',
        title: 'Reduce the view distance',
        detail:
          'Each step of view distance costs memory across every connected player. Dropping from ' +
          '10 to 8 is unnoticeable in play and frees a surprising amount.',
        kind: 'automatic',
        action: { type: 'set_setting', key: 'VIEW_DISTANCE', value: '8' },
        confidence: 'medium',
        supersededBy: ['set_memory'],
      });
    }

    return fixes;
  },
};

/* -------------------------------------------------------------------------- */
/* Killed from outside                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Exit 137 is SIGKILL, and it has two unrelated causes: the kernel's out-of-memory killer, and
 * Docker losing patience during a graceful stop. Only the first belongs to this rule.
 */
const EXIT_SIGKILL = 137;

/** Vanilla's own shutdown sequence. Its presence means a stop was in progress, not an OOM kill. */
const SHUTDOWN_RE = /Stopping (?:the )?server|Saving worlds|Saving players|Stopping server/;

export const containerKilled: Rule = {
  id: 'memory.container-killed',
  title: 'The container was killed for using too much memory',
  severity: 'critical',
  category: 'memory',

  match(ctx: MatchContext): Match | null {
    if (ctx.exitCode !== EXIT_SIGKILL) {
      return null;
    }
    // A stop that was already under way is the grace-period case, handled by `world.killed-during-save`.
    const stopping = ctx.blocks.some((b) => SHUTDOWN_RE.test(b.text));
    if (stopping && ctx.oomKilled !== true) {
      return null;
    }
    // Docker's own flag is decisive when the caller supplied it; otherwise the absence of a Java
    // OutOfMemoryError alongside a hard kill is what points at the kernel.
    const confidence = ctx.oomKilled === true ? 'high' : 'medium';
    const tail = ctx.blocks[ctx.blocks.length - 1];
    return match(tail === undefined ? [] : [tail], confidence, {
      exitCode: EXIT_SIGKILL,
      oomKilled: ctx.oomKilled === true,
      ...sizing(ctx, true),
    });
  },

  explain(m: Match): string {
    const certain = m.details.oomKilled === true;
    const lead = certain
      ? 'The host stopped this server because it used more memory than it was allowed.'
      : 'The server was stopped abruptly from outside, which on this platform almost always ' +
        'means it used more memory than it was allowed.';
    return (
      `${lead} There is no error in the log because the shutdown was immediate — the server was ` +
      `not asked to stop, it was ended. The usual cause is the game being given almost the whole ` +
      `container limit, leaving nothing for the parts of Java that live outside the game's own ` +
      `memory pool: mod class data, network buffers and background tasks.`
    );
  },

  fixes(m: Match): Fix[] {
    const rec = detailNumber(m, 'recommendedMiB', 0);
    const current = detailNumber(m, 'currentMiB', 0);
    const fixes: Fix[] = [];
    if (rec > 0) {
      fixes.push({
        id: `set-memory-${rec}`,
        title:
          current > 0
            ? `Raise the memory limit from ${formatMiB(current)} to ${formatMiB(rec)}`
            : `Set the memory limit to ${formatMiB(rec)}`,
        detail:
          'Gives the container enough headroom above the game itself. Platter reserves part of ' +
          'the limit for Java rather than allocating all of it to the game, which is what ' +
          'prevents this particular kill.',
        kind: 'automatic',
        action: { type: 'set_memory', memoryMiB: rec },
        confidence: 'high',
      });
    }
    fixes.push({
      id: 'check-host-memory',
      title: 'Check the host has memory to spare',
      detail:
        'If the machine itself is short of memory, raising this limit moves the problem to ' +
        'another server rather than solving it. Confirm there is genuine headroom first.',
      kind: 'manual',
      confidence: 'medium',
    });
    return fixes;
  },
};

/* -------------------------------------------------------------------------- */
/* Killed mid-save                                                             */
/* -------------------------------------------------------------------------- */

export const killedDuringSave: Rule = {
  id: 'world.killed-during-save',
  title: 'The server was killed before it finished saving',
  severity: 'error',
  category: 'world',

  match(ctx: MatchContext): Match | null {
    if (ctx.exitCode !== EXIT_SIGKILL || ctx.oomKilled === true) {
      return null;
    }
    const stopping = ctx.blocks.filter((b) => SHUTDOWN_RE.test(b.text));
    const last = stopping[stopping.length - 1];
    if (last === undefined) {
      return null;
    }
    return match([last], 'medium', { exitCode: EXIT_SIGKILL });
  },

  explain(): string {
    return (
      'A shutdown began but did not finish in time, so the server was forcibly ended part-way ' +
      'through writing the world to disk. Minecraft saves chunks in batches, and interrupting ' +
      'that is the most reliable way to damage a world. Nothing may be wrong — but check the ' +
      'area players were last in, and give the next shutdown longer.'
    );
  },

  fixes(): Fix[] {
    return [
      {
        id: 'increase-stop-grace',
        title: 'Allow more time for shutdown',
        detail:
          'Raises the time the server is given to finish saving before it is forced to stop. ' +
          'Costs nothing on a healthy server, because a clean shutdown still ends as soon as it ' +
          'is done.',
        kind: 'automatic',
        action: { type: 'set_setting', key: 'STOP_DURATION', value: '120' },
        confidence: 'high',
      },
      {
        id: 'verify-world',
        title: 'Check the world loaded correctly',
        detail:
          'Start the server and visit the last area anyone was in. If chunks are missing or the ' +
          'server fails to load the world, restore the most recent backup.',
        kind: 'manual',
        confidence: 'medium',
      },
    ];
  },
};
