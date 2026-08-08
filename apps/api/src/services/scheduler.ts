import { CronExpressionParser } from 'cron-parser';
import type { Schedule as ScheduleRow } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { PlatterError, SCHEDULE_ACTIONS, type ScheduleAction } from '@platter/shared';
import { prisma } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { createBackup } from './backups.js';
import { recordAudit } from './audit.js';
import { restartServer, sendCommand, startServer, stopServer } from './lifecycle.js';

/**
 * The cron dispatcher.
 *
 * One timer for the whole process, always re-armed for whichever enabled schedule is due
 * soonest — not one `setTimeout` per schedule, which would be as many live timers as rows
 * in the table. The wake is capped at `HEARTBEAT_MS` even when nothing is due sooner, so a
 * schedule created or edited while the loop is asleep is still noticed within half a
 * minute without routes having to reach into this module to say so.
 */

const HEARTBEAT_MS = 30_000;
/** Comfortably under `setTimeout`'s ~24.8 day (2^31 ms) ceiling. */
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;
/** One tick cannot be made to run an unbounded backlog just because Platter was down. */
const MAX_DUE_PER_TICK = 50;

let logger: FastifyBaseLogger | null = null;
let started = false;
let heartbeatMs = HEARTBEAT_MS;
let timer: NodeJS.Timeout | null = null;

/** Schedule ids currently executing in this process — the overlap guard. A manual "run
 * now" and the automatic tick both check and hold this before running anything. */
const running = new Set<string>();

function report(level: 'warn' | 'error', context: Record<string, unknown>, message: string): void {
  if (logger) {
    logger[level](context, message);
    return;
  }
  // Before `startScheduler` is given a logger, or in a test with none, there is still
  // somewhere to say it.
  const detail = JSON.stringify(context, (_key, value: unknown) =>
    value instanceof Error ? value.message : value,
  );
  process.stderr.write(`${message}: ${detail}\n`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

// ---------------------------------------------------------------------------
// The pure part — no database, fully unit-testable
// ---------------------------------------------------------------------------

function assertValidTimezone(timezone: string): void {
  try {
    // Constructed only to let it validate the zone name; a bad one throws a RangeError.
    Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw badRequest(`"${timezone}" is not a recognised timezone.`);
  }
}

/**
 * The next fire time strictly after `from`, in `timezone`.
 *
 * `cron-parser` handles DST itself (it walks real wall-clock time in the given zone, not
 * UTC-plus-an-offset), so a schedule set for `0 2 * * *` in a zone that skips 02:00 on a
 * spring-forward day lands on the next time that hour actually occurs, and a fall-back
 * day's repeated hour fires once, not twice — this function just has to trust that rather
 * than reimplement it.
 */
export function computeNextRun(cron: string, timezone: string, from: Date = new Date()): Date {
  assertValidTimezone(timezone);
  try {
    const interval = CronExpressionParser.parse(cron, { currentDate: from, tz: timezone });
    return interval.next().toDate();
  } catch (error) {
    throw badRequest(`That schedule could not be understood: ${messageOf(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Persistence glue
// ---------------------------------------------------------------------------

/**
 * Recomputes and persists one schedule's `nextRunAt` from its own cron/timezone, as of
 * now. Used both for the startup catch-up below and by routes when re-enabling a schedule
 * whose `nextRunAt` went to `null` while it was off.
 */
export async function recomputeNextRun(id: string): Promise<Date | null> {
  const row = await prisma.schedule.findUnique({ where: { id } });
  if (!row) throw notFound('schedule');
  const nextRunAt = row.enabled ? computeNextRun(row.cron, row.timezone, new Date()) : null;
  await prisma.schedule.update({ where: { id }, data: { nextRunAt } });
  return nextRunAt;
}

function isScheduleAction(value: string): value is ScheduleAction {
  return (SCHEDULE_ACTIONS as readonly string[]).includes(value);
}

interface ExecuteOutcome {
  status: 'success' | 'failed' | 'skipped';
  error: string | null;
}

async function executeAction(row: ScheduleRow): Promise<ExecuteOutcome> {
  if (!isScheduleAction(row.action)) {
    return { status: 'failed', error: `Unknown schedule action "${row.action}".` };
  }

  const server = await prisma.server.findUnique({
    where: { id: row.serverId },
    select: { status: true, suspended: true },
  });
  if (!server) return { status: 'failed', error: 'The server no longer exists.' };

  // `onlyWhenOnline` skips rather than waking a stopped server: the alternative — quietly
  // starting it just to run an unrelated action — is a surprise no schedule should spring
  // on an operator. `start` is exempt, since refusing to run *because the server is off*
  // would defeat the one action whose entire purpose is turning it on.
  const isOnline = !server.suspended && server.status === 'running';
  if (row.action !== 'start' && row.onlyWhenOnline && !isOnline) {
    return { status: 'skipped', error: 'The server was offline.' };
  }

  try {
    switch (row.action) {
      case 'start':
        await startServer(row.serverId);
        break;
      case 'stop':
        await stopServer(row.serverId);
        break;
      case 'restart':
        await restartServer(row.serverId);
        break;
      case 'command':
        if (!row.payload) return { status: 'failed', error: 'This schedule has no command configured.' };
        await sendCommand(row.serverId, row.payload);
        break;
      case 'backup':
        await createBackup(row.serverId, { automatic: true });
        break;
    }
    return { status: 'success', error: null };
  } catch (error) {
    // A state mismatch (already running, already stopped, an install in progress) is the
    // ordinary outcome of a cron-driven action landing on a server a human already acted
    // on — not a failure worth alarming anyone about.
    if (error instanceof PlatterError && error.code === 'invalid_state') {
      return { status: 'skipped', error: error.message };
    }
    return { status: 'failed', error: messageOf(error) };
  }
}

async function runOnce(row: ScheduleRow, actorId: string | null): Promise<void> {
  const outcome = await executeAction(row);
  await prisma.schedule
    .update({
      where: { id: row.id },
      data: { lastRunAt: new Date(), lastRunStatus: outcome.status, lastRunError: outcome.error },
    })
    .catch((error: unknown) => {
      report('error', { err: error, scheduleId: row.id }, 'could not record a schedule run');
    });

  await recordAudit({
    action: 'schedule.executed',
    targetType: 'schedule',
    actorId,
    targetId: row.id,
    targetName: row.name,
    metadata: { action: row.action, status: outcome.status, serverId: row.serverId },
    logger: logger ?? undefined,
  });
}

/** Triggered by a human, right now — used by the `/schedules/:id/run` route. Does not
 * touch `nextRunAt`: a one-off run must not disturb the schedule's own timing. */
export async function runScheduleNow(id: string, actorId: string | null = null): Promise<void> {
  const row = await prisma.schedule.findUnique({ where: { id } });
  if (!row) throw notFound('schedule');
  if (running.has(id)) throw conflict('This schedule is already running.');

  running.add(id);
  // Not awaited: a manual run can take as long as a backup does, and the caller — an HTTP
  // request — must not block on it. The outcome lands in `lastRunAt`/`lastRunStatus` for a
  // subsequent GET to see.
  void runOnce(row, actorId)
    .catch((error: unknown) => {
      report('error', { err: error, scheduleId: id }, 'a manually triggered schedule run failed');
    })
    .finally(() => running.delete(id));
}

/**
 * The automatic path: claims the row by advancing `nextRunAt` conditionally on the value
 * this tick read, then runs it. The conditional update is what makes "one schedule never
 * runs twice concurrently" true even for a run slow enough to still be going at the next
 * tick — a second tick's update matches zero rows and backs off instead of starting a
 * second one.
 */
async function claimAndRun(row: ScheduleRow): Promise<void> {
  if (running.has(row.id)) return; // a manual run already has it

  let nextRunAt: Date;
  try {
    nextRunAt = computeNextRun(row.cron, row.timezone, new Date());
  } catch (error) {
    // A cron/timezone that no longer parses (tzdata dropped a zone, say) is disabled
    // rather than retried every tick forever with nobody watching.
    await prisma.schedule
      .update({
        where: { id: row.id },
        data: {
          enabled: false,
          nextRunAt: null,
          lastRunAt: new Date(),
          lastRunStatus: 'failed',
          lastRunError: messageOf(error),
        },
      })
      .catch(() => undefined);
    return;
  }

  const claimed = await prisma.schedule.updateMany({
    where: { id: row.id, nextRunAt: row.nextRunAt },
    data: { nextRunAt },
  });
  if (claimed.count === 0) return;

  running.add(row.id);
  try {
    await runOnce(row, null);
  } finally {
    running.delete(row.id);
  }
}

async function runDueSchedules(): Promise<void> {
  const due = await prisma.schedule.findMany({
    where: { enabled: true, nextRunAt: { lte: new Date() } },
    orderBy: { nextRunAt: 'asc' },
    take: MAX_DUE_PER_TICK,
  });
  for (const row of due) {
    void claimAndRun(row).catch((error: unknown) => {
      report('error', { err: error, scheduleId: row.id }, 'a scheduled run failed to start');
    });
  }
}

async function armTimer(): Promise<void> {
  if (!started) return;
  let delay = heartbeatMs;
  try {
    const next = await prisma.schedule.findFirst({
      where: { enabled: true, nextRunAt: { not: null } },
      orderBy: { nextRunAt: 'asc' },
      select: { nextRunAt: true },
    });
    if (next?.nextRunAt) {
      delay = Math.min(heartbeatMs, Math.max(0, next.nextRunAt.getTime() - Date.now()));
    }
  } catch (error) {
    report('warn', { err: error }, 'could not plan the next scheduler wake; using the heartbeat');
  }

  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void tick(), Math.min(delay, MAX_TIMER_MS));
  // A sleeping scheduler must not be the reason the process cannot exit.
  timer.unref();
}

async function tick(): Promise<void> {
  timer = null;
  if (!started) return;
  try {
    await runDueSchedules();
  } catch (error) {
    // Whatever just went wrong, the loop itself must survive it — a throwing task, or a
    // failed query, is a bad run, not a dead scheduler.
    report('error', { err: error }, 'a scheduler tick failed');
  }
  await armTimer();
}

export interface StartSchedulerOptions {
  /** Overrides the heartbeat (default 30s) — tests use a short one so they don't wait. */
  intervalMs?: number;
  logger?: FastifyBaseLogger;
}

export async function startScheduler(options: StartSchedulerOptions = {}): Promise<void> {
  if (started) return;
  started = true;
  logger = options.logger ?? null;
  heartbeatMs = Math.max(1, options.intervalMs ?? HEARTBEAT_MS);

  // Missed runs while Platter was down are skipped, not stampeded: an overdue schedule is
  // fast-forwarded to its next future occurrence here, once, instead of being fired the
  // moment the loop starts — a daily schedule after a week of downtime gets one run
  // scheduled for tomorrow, not seven queued back to back today.
  const overdue = await prisma.schedule.findMany({
    where: { enabled: true, nextRunAt: { lte: new Date() } },
    select: { id: true },
  });
  for (const row of overdue) {
    await recomputeNextRun(row.id).catch((error: unknown) => {
      report('warn', { err: error, scheduleId: row.id }, 'could not fast-forward an overdue schedule');
    });
  }

  await armTimer();
}

export function stopScheduler(): void {
  started = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Test-only: clears everything `stopScheduler` leaves behind (the overlap guard, the
 * logger, the heartbeat override) so one test file's runs cannot bleed into the next. */
export function resetSchedulerState(): void {
  stopScheduler();
  running.clear();
  logger = null;
  heartbeatMs = HEARTBEAT_MS;
}
