import { EventEmitter } from 'node:events';
import { desc, eq, and, lt } from 'drizzle-orm';
import type { PlatterDatabase } from '@platter/db';
import { events as eventsTable } from '@platter/db';
import { type Actor, type EventLevel, ulid } from '@platter/shared';

/**
 * The event stream.
 *
 * One append-only table backs both the user-facing activity feed and the audit log. Splitting
 * them means every action has to remember to write twice, and in every codebase that does this
 * the two drift within a month. Filtering one stream by level and actor gives both views, and
 * keeps the audit trail complete by construction rather than by discipline.
 *
 * The in-process emitter on top is what drives live updates in the UI without polling.
 */

export interface PlatterEvent {
  id: string;
  serverId: string | null;
  type: string;
  level: EventLevel;
  message: string;
  actor: Actor;
  data: Record<string, unknown> | null;
  createdAt: number;
}

export interface EmitEventInput {
  serverId?: string | null;
  type: string;
  message: string;
  level?: EventLevel;
  actor?: Actor;
  data?: Record<string, unknown>;
}

type Listener = (event: PlatterEvent) => void;

class EventBus extends EventEmitter {
  constructor() {
    super();
    // Every open SSE connection and every internal watcher adds a listener. The default cap of
    // 10 would start printing leak warnings with a handful of browser tabs open.
    this.setMaxListeners(200);
  }
}

const bus = new EventBus();

/**
 * Record an event and publish it.
 *
 * Deliberately synchronous on the write: callers use this on paths where losing the record
 * would break the audit trail, and better-sqlite3 writes are fast enough that queuing them
 * would add risk for no measurable gain.
 */
export function emitEvent(db: PlatterDatabase, input: EmitEventInput): PlatterEvent {
  const event: PlatterEvent = {
    id: ulid(),
    serverId: input.serverId ?? null,
    type: input.type,
    level: input.level ?? 'info',
    message: input.message,
    actor: input.actor ?? 'system',
    data: input.data ?? null,
    createdAt: Date.now(),
  };

  db.insert(eventsTable)
    .values({
      id: event.id,
      serverId: event.serverId,
      type: event.type,
      level: event.level,
      message: event.message,
      actor: event.actor,
      data: event.data,
      createdAt: event.createdAt,
    })
    .run();

  bus.emit('event', event);
  if (event.serverId) {
    bus.emit(`server:${event.serverId}`, event);
  }
  return event;
}

/** Subscribe to every event. Returns an unsubscribe function. */
export function onEvent(listener: Listener): () => void {
  bus.on('event', listener);
  return () => bus.off('event', listener);
}

/** Subscribe to one server's events. */
export function onServerEvent(serverId: string, listener: Listener): () => void {
  const channel = `server:${serverId}`;
  bus.on(channel, listener);
  return () => bus.off(channel, listener);
}

export interface ListEventsOptions {
  serverId?: string;
  limit?: number;
  /** Return events strictly older than this id. ULIDs sort chronologically, so this paginates. */
  before?: string;
}

export function listEvents(db: PlatterDatabase, options: ListEventsOptions = {}): PlatterEvent[] {
  const conditions = [];
  if (options.serverId) {
    conditions.push(eq(eventsTable.serverId, options.serverId));
  }
  if (options.before) {
    conditions.push(lt(eventsTable.id, options.before));
  }

  const rows = db
    .select()
    .from(eventsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(eventsTable.id))
    .limit(Math.min(options.limit ?? 50, 500))
    .all();

  return rows.map((row) => ({
    id: row.id,
    serverId: row.serverId,
    type: row.type,
    level: row.level as EventLevel,
    message: row.message,
    actor: row.actor as Actor,
    data: (row.data as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt,
  }));
}

/**
 * Trim the event log.
 *
 * Unbounded growth is fine for months and then suddenly is not — a server in a restart loop can
 * write thousands of rows an hour. Retention is generous because the audit trail is the whole
 * point, but it is not infinite.
 */
export function pruneEvents(db: PlatterDatabase, olderThanMs: number): number {
  const cutoff = Date.now() - olderThanMs;
  return db.delete(eventsTable).where(lt(eventsTable.createdAt, cutoff)).run().changes;
}

/** Event type constants, so a typo cannot silently create a new event type. */
export const EVENT = {
  serverCreated: 'server.created',
  serverStarting: 'server.starting',
  serverStarted: 'server.started',
  serverStopping: 'server.stopping',
  serverStopped: 'server.stopped',
  serverCrashed: 'server.crashed',
  serverUnhealthy: 'server.unhealthy',
  serverRecovered: 'server.recovered',
  serverDeleted: 'server.deleted',
  serverSettingsChanged: 'server.settings_changed',
  serverCommand: 'server.command',
  imagePullStarted: 'image.pull_started',
  imagePullFinished: 'image.pull_finished',
  modInstalled: 'mod.installed',
  modRemoved: 'mod.removed',
  modUpdated: 'mod.updated',
  modInstallFailed: 'mod.install_failed',
  backupStarted: 'backup.started',
  backupCompleted: 'backup.completed',
  backupFailed: 'backup.failed',
  backupRestored: 'backup.restored',
  backupPruned: 'backup.pruned',
  scheduleRan: 'schedule.ran',
  scheduleFailed: 'schedule.failed',
  diagnosisCreated: 'diagnosis.created',
  proposalCreated: 'ai.proposal.created',
  proposalAccepted: 'ai.proposal.accepted',
  proposalRejected: 'ai.proposal.rejected',
  proposalApplied: 'ai.proposal.applied',
  proposalFailed: 'ai.proposal.failed',
} as const;

export type EventType = (typeof EVENT)[keyof typeof EVENT];
