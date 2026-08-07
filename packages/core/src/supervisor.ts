import { Cron } from 'croner';
import { and, eq } from 'drizzle-orm';
import { schedules } from '@platter/db';
import { type ServerStatus, logger } from '@platter/shared';
import type { Context } from './context';
import { inspectContainer, listManaged } from './docker/guard';
import { readLogTail } from './docker/logs';
import { EVENT, emitEvent } from './events';
import { READY_PATTERN } from './minecraft/manifest';
import { reapIdleRcon } from './rcon';
import { getServer, listServers, setStatus, updateServer } from './servers/repository';
import { restartServer, startServer, stopServer } from './servers/service';
import { createBackup, pruneBackups } from './backups/create';

const log = logger.child('supervisor');

/**
 * The background loop.
 *
 * Two jobs, both of which exist because the database records *intent* and Docker records
 * *reality*, and they drift:
 *
 *   - **Reconciliation.** Platter was closed while a server crashed; a container was removed
 *     with `docker rm`; the machine rebooted and Docker restarted containers on its own. On
 *     every tick the supervisor believes Docker and corrects the row. Without this, the
 *     dashboard confidently shows "Running" next to a container that has been dead for hours.
 *
 *   - **Schedules.** Backups and restarts, driven by cron expressions.
 *
 * There is exactly one supervisor per process, guarded on `globalThis` because Next.js reloads
 * modules in development and a second copy would double every scheduled backup.
 */

const GLOBAL_KEY = Symbol.for('platter.supervisor');

interface SupervisorState {
  timer: NodeJS.Timeout | undefined;
  jobs: Map<string, Cron>;
  running: boolean;
  /** Servers seen in `starting`, with the time we first saw them, for the startup budget. */
  startingSince: Map<string, number>;
}

interface GlobalWithSupervisor {
  [GLOBAL_KEY]?: SupervisorState;
}

function state(): SupervisorState {
  const container = globalThis as GlobalWithSupervisor;
  container[GLOBAL_KEY] ??= {
    timer: undefined,
    jobs: new Map(),
    running: false,
    startingSince: new Map(),
  };
  return container[GLOBAL_KEY];
}

export function startSupervisor(ctx: Context): void {
  const supervisor = state();
  if (supervisor.running) {
    return;
  }
  supervisor.running = true;

  const intervalMs = ctx.env.PLATTER_POLL_INTERVAL_SECONDS * 1000;

  // One immediate pass so a restarted Platter shows accurate state straight away rather than
  // after the first interval.
  void reconcileAll(ctx).catch((error) => log.error('initial reconcile failed', { error: String(error) }));
  syncSchedules(ctx);

  supervisor.timer = setInterval(() => {
    void (async () => {
      try {
        await reconcileAll(ctx);
        await reapIdleRcon();
      } catch (error) {
        log.error('reconcile tick failed', { error: String(error) });
      }
    })();
  }, intervalMs);

  // Unref so the timer never keeps a CLI process alive on its own.
  supervisor.timer.unref?.();
  log.info('supervisor started', { intervalSeconds: ctx.env.PLATTER_POLL_INTERVAL_SECONDS });
}

export function stopSupervisor(): void {
  const supervisor = state();
  if (supervisor.timer) {
    clearInterval(supervisor.timer);
    supervisor.timer = undefined;
  }
  for (const job of supervisor.jobs.values()) {
    job.stop();
  }
  supervisor.jobs.clear();
  supervisor.running = false;
}

/* -------------------------------------------------------------------------- */
/* Reconciliation                                                              */
/* -------------------------------------------------------------------------- */

export async function reconcileAll(ctx: Context): Promise<void> {
  const servers = listServers(ctx.db);
  await Promise.all(servers.map((server) => reconcileServer(ctx, server.id)));
  await adoptOrphans(ctx);
}

/**
 * Map one server's container reality onto its row.
 *
 * The interesting cases are the transitions, not the steady states — going from `running` to a
 * dead container is a crash and should say so, while going from `stopping` to the same dead
 * container is a successful stop. Comparing against the previous status is what tells them
 * apart, which is why this reads the row before deciding.
 */
export async function reconcileServer(ctx: Context, serverId: string): Promise<void> {
  const server = getServer(ctx.db, serverId);
  if (!server || server.deletedAt !== null) {
    return;
  }
  // Never fight an operation that is actively in progress.
  if (server.status === 'deleting' || server.status === 'creating') {
    return;
  }
  if (!server.containerId) {
    if (server.status !== 'stopped' && server.status !== 'error') {
      setStatus(ctx.db, serverId, 'stopped', 'No container exists for this server.');
    }
    return;
  }

  const inspected = await inspectContainer(ctx.docker, server.containerId);

  if (!inspected.ok) {
    if (inspected.error.code === 'container_not_found') {
      // Someone removed it outside Platter.
      updateServer(ctx.db, serverId, { containerId: null });
      setStatus(ctx.db, serverId, 'stopped', 'The container was removed outside Platter.');
      emitEvent(ctx.db, {
        serverId,
        type: EVENT.serverStopped,
        level: 'warn',
        message: `${server.name}'s container no longer exists.`,
        actor: 'system',
      });
    }
    return;
  }

  const container = inspected.value;
  const next = deriveStatus(container.state, container.health, server.status);

  if (next === server.status) {
    // Even without a status change, a server stuck in `starting` past its budget needs saying.
    if (next === 'starting') {
      await checkStartupBudget(ctx, serverId, server.name);
    }
    return;
  }

  // `starting` → `running` is confirmed by the log line as well as the health check, because
  // the health check runs on a 30s interval and users notice the lag.
  if (server.status === 'starting' && next !== 'running' && container.state === 'running') {
    const ready = await sawReadyLine(ctx, server.containerId);
    if (ready) {
      promote(ctx, serverId, server.name, 'running');
      return;
    }
    await checkStartupBudget(ctx, serverId, server.name);
    return;
  }

  applyTransition(ctx, serverId, server.name, server.status, next, container.exitCode);
}

function deriveStatus(
  containerState: string,
  health: 'starting' | 'healthy' | 'unhealthy' | 'none',
  previous: ServerStatus
): ServerStatus {
  if (containerState === 'running') {
    if (health === 'healthy') {
      return 'running';
    }
    if (health === 'unhealthy') {
      // A server that never became healthy is still starting; one that was healthy and stopped
      // being healthy has actually gone wrong. Same Docker signal, different meaning.
      return previous === 'running' || previous === 'unhealthy' ? 'unhealthy' : 'starting';
    }
    // `starting` (within the health check's start period) or an image with no health check.
    return health === 'none' && previous === 'running' ? 'running' : 'starting';
  }

  if (containerState === 'restarting') {
    return 'starting';
  }
  if (containerState === 'removing' || containerState === 'dead') {
    return 'error';
  }
  // created | exited | paused
  return previous === 'stopping' || previous === 'stopped' ? 'stopped' : 'crashed';
}

function applyTransition(
  ctx: Context,
  serverId: string,
  name: string,
  previous: ServerStatus,
  next: ServerStatus,
  exitCode: number | undefined
): void {
  switch (next) {
    case 'running':
      promote(ctx, serverId, name, 'running');
      if (previous === 'unhealthy') {
        emitEvent(ctx.db, {
          serverId,
          type: EVENT.serverRecovered,
          message: `${name} recovered and is healthy again`,
          actor: 'system',
        });
      }
      break;

    case 'unhealthy':
      setStatus(ctx.db, serverId, 'unhealthy', 'Failing its health check — it may be hung or out of memory.');
      emitEvent(ctx.db, {
        serverId,
        type: EVENT.serverUnhealthy,
        level: 'warn',
        message: `${name} stopped responding to health checks`,
        actor: 'system',
      });
      break;

    case 'crashed': {
      // Exit 137 is SIGKILL, which for a container with a memory limit almost always means the
      // kernel OOM killer. Saying so beats "exited with code 137".
      const reason =
        exitCode === 137
          ? 'Killed — the server most likely ran out of memory. Try raising its memory limit.'
          : exitCode === 143
            ? 'Stopped by a shutdown signal.'
            : `Exited with code ${exitCode ?? 'unknown'}.`;
      updateServer(ctx.db, serverId, { lastExitCode: exitCode ?? null });
      setStatus(ctx.db, serverId, 'crashed', reason);
      emitEvent(ctx.db, {
        serverId,
        type: EVENT.serverCrashed,
        level: 'error',
        message: `${name} crashed. ${reason}`,
        actor: 'system',
        data: { exitCode },
      });
      break;
    }

    case 'stopped':
      setStatus(ctx.db, serverId, 'stopped');
      break;

    default:
      setStatus(ctx.db, serverId, next);
      break;
  }
}

function promote(ctx: Context, serverId: string, name: string, status: ServerStatus): void {
  state().startingSince.delete(serverId);
  setStatus(ctx.db, serverId, status);
  emitEvent(ctx.db, {
    serverId,
    type: EVENT.serverStarted,
    message: `${name} is running`,
    actor: 'system',
  });
}

async function sawReadyLine(ctx: Context, containerId: string): Promise<boolean> {
  const tail = await readLogTail(ctx.docker, containerId, 40);
  return tail.ok && tail.value.some((line) => READY_PATTERN.test(line.text));
}

/**
 * Flag servers that have been starting for too long.
 *
 * "Server stuck installing" is a perennial top support topic for Pterodactyl precisely because
 * nothing ever tells the user it is stuck — it just sits there. A budget turns silence into a
 * diagnosable event.
 */
async function checkStartupBudget(ctx: Context, serverId: string, name: string): Promise<void> {
  const supervisor = state();
  const since = supervisor.startingSince.get(serverId);
  if (since === undefined) {
    supervisor.startingSince.set(serverId, Date.now());
    return;
  }
  const elapsed = Date.now() - since;
  if (elapsed < 900_000) {
    return;
  }
  supervisor.startingSince.delete(serverId);
  setStatus(
    ctx.db,
    serverId,
    'unhealthy',
    `Still starting after ${Math.round(elapsed / 60_000)} minutes. Check the console for errors.`
  );
  emitEvent(ctx.db, {
    serverId,
    type: EVENT.serverUnhealthy,
    level: 'warn',
    message: `${name} has been starting for ${Math.round(elapsed / 60_000)} minutes — something is wrong.`,
    actor: 'system',
  });
}

/**
 * Notice containers Platter owns but has no row for.
 *
 * Happens when the database is restored from an older backup, or when a create crashed between
 * the container being made and the row being written. Left alone they are invisible orphans
 * holding ports; logging them at least makes the situation discoverable.
 */
async function adoptOrphans(ctx: Context): Promise<void> {
  const containers = await listManaged(ctx.docker);
  if (!containers.ok) {
    return;
  }
  const known = new Set(listServers(ctx.db, { includeDeleted: true }).map((server) => server.id));
  for (const container of containers.value) {
    if (container.serverId && !known.has(container.serverId)) {
      log.warn('found a Platter container with no matching server row', {
        container: container.name,
        serverId: container.serverId,
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Schedules                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Rebuild the cron jobs from the database.
 *
 * Called at startup and whenever a schedule changes. Jobs are keyed by schedule id and replaced
 * wholesale rather than diffed — the set is small, and a diffing bug here means either a
 * duplicated backup or one that silently stops running.
 */
export function syncSchedules(ctx: Context): void {
  const supervisor = state();
  const rows = ctx.db.select().from(schedules).where(eq(schedules.enabled, true)).all();
  const wanted = new Set(rows.map((row) => row.id));

  for (const [id, job] of supervisor.jobs) {
    if (!wanted.has(id)) {
      job.stop();
      supervisor.jobs.delete(id);
    }
  }

  for (const row of rows) {
    supervisor.jobs.get(row.id)?.stop();
    try {
      const job = new Cron(
        row.cron,
        { timezone: row.timezone, protect: true, name: row.id },
        () => void runSchedule(ctx, row.id)
      );
      supervisor.jobs.set(row.id, job);
      ctx.db
        .update(schedules)
        .set({ nextRunAt: job.nextRun()?.getTime() ?? null })
        .where(eq(schedules.id, row.id))
        .run();
    } catch (error) {
      log.error('invalid cron expression', { scheduleId: row.id, cron: row.cron, error: String(error) });
      ctx.db
        .update(schedules)
        .set({ enabled: false, lastStatus: 'error', lastMessage: `Invalid cron: ${row.cron}` })
        .where(eq(schedules.id, row.id))
        .run();
    }
  }
}

async function runSchedule(ctx: Context, scheduleId: string): Promise<void> {
  const row = ctx.db.select().from(schedules).where(eq(schedules.id, scheduleId)).get();
  if (!row || !row.enabled) {
    return;
  }

  const finish = (status: 'ok' | 'error', message?: string): void => {
    ctx.db
      .update(schedules)
      .set({
        lastRunAt: Date.now(),
        lastStatus: status,
        lastMessage: message ?? null,
        nextRunAt: state().jobs.get(scheduleId)?.nextRun()?.getTime() ?? null,
      })
      .where(eq(schedules.id, scheduleId))
      .run();

    emitEvent(ctx.db, {
      serverId: row.serverId,
      type: status === 'ok' ? EVENT.scheduleRan : EVENT.scheduleFailed,
      level: status === 'ok' ? 'info' : 'error',
      message: status === 'ok' ? `Ran schedule "${row.name}"` : `Schedule "${row.name}" failed: ${message}`,
      actor: 'schedule',
      data: { scheduleId, action: row.action },
    });
  };

  try {
    switch (row.action) {
      case 'backup': {
        const result = await createBackup(ctx, {
          serverId: row.serverId,
          trigger: 'schedule',
          actor: 'schedule',
          label: row.name,
        });
        if (!result.ok) {
          finish('error', result.error.message);
          return;
        }
        await pruneBackups(ctx, row.serverId);
        break;
      }
      case 'restart': {
        const result = await restartServer(ctx, row.serverId, { actor: 'schedule' });
        if (!result.ok) {
          finish('error', result.error.message);
          return;
        }
        break;
      }
      case 'stop': {
        const result = await stopServer(ctx, row.serverId, { actor: 'schedule' });
        if (!result.ok) {
          finish('error', result.error.message);
          return;
        }
        break;
      }
      case 'start': {
        const result = await startServer(ctx, row.serverId, { actor: 'schedule' });
        if (!result.ok) {
          finish('error', result.error.message);
          return;
        }
        break;
      }
      case 'prune_backups': {
        await pruneBackups(ctx, row.serverId);
        break;
      }
      case 'command': {
        const payload = row.payload as { command?: string } | null;
        if (!payload?.command) {
          finish('error', 'No command configured.');
          return;
        }
        const { sendCommand } = await import('./servers/service');
        const result = await sendCommand(ctx, row.serverId, payload.command, { actor: 'schedule' });
        if (!result.ok) {
          finish('error', result.error.message);
          return;
        }
        break;
      }
      default:
        finish('error', `Unknown action "${row.action}".`);
        return;
    }
    finish('ok');
  } catch (error) {
    finish('error', error instanceof Error ? error.message : String(error));
  }
}

/** Ensure a server has its default nightly backup schedule. */
export function ensureDefaultSchedules(ctx: Context, serverId: string): void {
  const server = getServer(ctx.db, serverId);
  if (!server?.autoBackup || !server.backupCron) {
    return;
  }
  const existing = ctx.db
    .select()
    .from(schedules)
    .where(and(eq(schedules.serverId, serverId), eq(schedules.action, 'backup')))
    .get();
  if (existing) {
    return;
  }
  ctx.db
    .insert(schedules)
    .values({
      id: `${serverId}-backup`,
      serverId,
      name: 'Nightly backup',
      action: 'backup',
      cron: server.backupCron,
      enabled: true,
    })
    .run();
  syncSchedules(ctx);
}
