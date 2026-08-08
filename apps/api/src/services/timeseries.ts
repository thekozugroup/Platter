import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';

/**
 * Resource-usage history: the storage engine behind the monitoring charts.
 *
 * This deliberately does **not** live in the Prisma-managed database, and that is worth
 * explaining because it looks like an odd choice. `prisma/schema.prisma` has no model for
 * a metric sample — adding one is outside this file's remit — and a table created by hand
 * inside that same SQLite file is not actually free: `prisma db push` diffs the live schema
 * against the `.prisma` file and, on finding a table it does not recognise, refuses to run
 * without `--accept-data-loss`. That would break every future `db push` against a
 * deployment that has ever recorded a sample, or (worse) get scripted past in a deploy
 * pipeline and silently drop months of history. A metric sample also has none of the
 * relational shape Prisma buys elsewhere — no foreign keys, no per-row identity anyone
 * looks up, a write volume orders of magnitude above everything else in the app, and rows
 * that are *meant* to expire on a timer. So it gets its own SQLite file via the `node:sqlite`
 * built-in (no new dependency, same engine) instead of borrowing the primary one.
 *
 * Everything here writes through an in-memory buffer that is flushed on an interval —
 * one upsert per sample per server would be a write for every tick of every running
 * server — and a maintenance sweep rolls old, fine-grained rows into coarser ones before
 * deleting them, so the table stays bounded no matter how long the process runs.
 */

export const METRIC_NAMES = [
  'cpu',
  'memory',
  'disk',
  'networkRx',
  'networkTx',
  'players',
  'tps',
] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

export function isMetricName(value: string): value is MetricName {
  return (METRIC_NAMES as readonly string[]).includes(value);
}

export const RESOLUTIONS = ['raw', '1m', '5m'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export function isResolution(value: string): value is Resolution {
  return (RESOLUTIONS as readonly string[]).includes(value);
}

/** One chart-ready point. `avg` is what a line chart plots; `min`/`max` are there for a band. */
export interface SeriesPoint {
  timestamp: string;
  avg: number;
  min: number;
  max: number;
  samples: number;
}

export interface PruneResult {
  rolledToMinute: number;
  rolledToFiveMinute: number;
  deleted: number;
}

export interface TimeseriesMaintenanceOptions {
  flushIntervalMs?: number;
  pruneIntervalMs?: number;
  logger?: FastifyBaseLogger;
}

// ---------------------------------------------------------------------------
// Resolution tiers
// ---------------------------------------------------------------------------

const RAW_BUCKET_MS = 10_000;
const MINUTE_BUCKET_MS = 60_000;
const FIVE_MINUTE_BUCKET_MS = 5 * 60_000;

const BUCKET_MS: Record<Resolution, number> = {
  raw: RAW_BUCKET_MS,
  '1m': MINUTE_BUCKET_MS,
  '5m': FIVE_MINUTE_BUCKET_MS,
};

/**
 * How long each tier survives before it is rolled into the next one (or, for the coarsest
 * tier, deleted outright). Sized so total disk use stays in the low tens of MB even with a
 * few dozen servers sampled continuously on every metric — a self-hosted box should not
 * notice this file. Tune by editing these constants; nothing else assumes these values.
 */
const RAW_RETENTION_MS = 3 * 60 * 60_000; // 3h of full resolution
const MINUTE_RETENTION_MS = 2 * 24 * 60 * 60_000; // 48h of 1-minute rollups
const FIVE_MINUTE_RETENTION_MS = 14 * 24 * 60 * 60_000; // 14d of 5-minute rollups

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS samples (
  server_id    TEXT NOT NULL,
  metric       TEXT NOT NULL,
  resolution   TEXT NOT NULL,
  bucket_ms    INTEGER NOT NULL,
  sum_value    REAL NOT NULL,
  sample_count INTEGER NOT NULL,
  min_value    REAL NOT NULL,
  max_value    REAL NOT NULL,
  PRIMARY KEY (server_id, metric, resolution, bucket_ms)
) STRICT
`;

let db: DatabaseSync | null = null;
const statementCache = new Map<string, StatementSync>();

function open(): DatabaseSync {
  if (db) return db;
  // `config.dataDir` is normally created by `db.ts` before the app ever gets here, but
  // this module has no ordering dependency on that, so it ensures its own directory.
  mkdirSync(config.dataDir, { recursive: true });
  const instance = new DatabaseSync(path.join(config.dataDir, 'metrics.db'));
  // WAL so the frequent small writes from the flush timer never block a concurrent read
  // (a chart open while a sample lands); NORMAL sync because nothing here is the record
  // of truth — worst case on an unclean shutdown is losing the last unflushed buffer.
  instance.exec('PRAGMA journal_mode = WAL');
  instance.exec('PRAGMA synchronous = NORMAL');
  instance.exec(SCHEMA_SQL);
  db = instance;
  return instance;
}

function stmt(sql: string): StatementSync {
  const database = open();
  const cached = statementCache.get(sql);
  if (cached) return cached;
  const prepared = database.prepare(sql);
  statementCache.set(sql, prepared);
  return prepared;
}

/** Releases the file handle. A live process never needs this; tests use it between cases. */
export function closeTimeseriesDb(): void {
  statementCache.clear();
  if (db) {
    db.close();
    db = null;
  }
}

// ---------------------------------------------------------------------------
// Write buffer
// ---------------------------------------------------------------------------

interface BufferEntry {
  serverId: string;
  metric: MetricName;
  bucketMs: number;
  sum: number;
  count: number;
  min: number;
  max: number;
}

const buffer = new Map<string, BufferEntry>();
/** Defensive cap. The flush timer should drain this long before it matters; a process that
 * runs for months must not grow this map without bound if flushing ever falls behind. */
const MAX_BUFFER_ENTRIES = 5000;

/** NUL separator: it cannot appear in a server id or a metric name, so the composite
 * key is unambiguous. Written as an escape so this file stays valid UTF-8 text. */
const KEY_SEP = '\u0000';

function bufferKey(serverId: string, metric: string, bucketMs: number): string {
  return `${serverId}${KEY_SEP}${metric}${KEY_SEP}${bucketMs}`;
}

/**
 * Buffers one reading. Synchronous and allocation-light on purpose — this is meant to be
 * called from a sampling loop for every running server on every tick, and it must never be
 * the thing that makes that loop slow. Nothing reaches disk until the next flush.
 */
export function recordSample(
  serverId: string,
  metric: MetricName,
  value: number,
  at: Date = new Date(),
): void {
  // A bad driver read (NaN, an unset counter) must not corrupt an aggregate that many
  // future averages are computed from.
  if (!Number.isFinite(value)) return;

  const bucketMs = Math.floor(at.getTime() / RAW_BUCKET_MS) * RAW_BUCKET_MS;
  const key = bufferKey(serverId, metric, bucketMs);
  const existing = buffer.get(key);
  if (existing) {
    existing.sum += value;
    existing.count += 1;
    if (value < existing.min) existing.min = value;
    if (value > existing.max) existing.max = value;
    return;
  }

  if (buffer.size >= MAX_BUFFER_ENTRIES) {
    const oldestKey = buffer.keys().next().value;
    if (oldestKey !== undefined) buffer.delete(oldestKey);
  }
  buffer.set(key, { serverId, metric, bucketMs, sum: value, count: 1, min: value, max: value });
}

const UPSERT_SQL = `
  INSERT INTO samples (server_id, metric, resolution, bucket_ms, sum_value, sample_count, min_value, max_value)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(server_id, metric, resolution, bucket_ms) DO UPDATE SET
    sum_value = sum_value + excluded.sum_value,
    sample_count = sample_count + excluded.sample_count,
    min_value = MIN(min_value, excluded.min_value),
    max_value = MAX(max_value, excluded.max_value)
`;

/**
 * Drains the buffer into the raw tier, one upsert per distinct (server, metric, bucket).
 * A bucket already on disk — the previous flush already wrote it, and this tick's samples
 * landed in the same 10s window — is accumulated into, never overwritten.
 */
export async function flushSamples(): Promise<void> {
  if (buffer.size === 0) return;
  const entries = [...buffer.values()];
  buffer.clear();

  const database = open();
  const upsert = stmt(UPSERT_SQL);
  database.exec('BEGIN');
  try {
    for (const entry of entries) {
      upsert.run(
        entry.serverId,
        entry.metric,
        'raw',
        entry.bucketMs,
        entry.sum,
        entry.count,
        entry.min,
        entry.max,
      );
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    // A transient write failure must not lose the samples — put them back so the next
    // flush retries, merging with anything recorded in the meantime.
    for (const entry of entries) {
      const key = bufferKey(entry.serverId, entry.metric, entry.bucketMs);
      const existing = buffer.get(key);
      if (existing) {
        existing.sum += entry.sum;
        existing.count += entry.count;
        existing.min = Math.min(existing.min, entry.min);
        existing.max = Math.max(existing.max, entry.max);
      } else {
        buffer.set(key, entry);
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Rollup and retention
// ---------------------------------------------------------------------------

export interface Bucket {
  sum: number;
  count: number;
  min: number;
  max: number;
}

/**
 * Combines two partial aggregates the way a running average must: sums and counts add, and
 * the extremes take the wider bound. `avg = sum / count` is always derived at read time —
 * an average is never re-averaged, which is the mistake that silently corrupts a rollup
 * when buckets being merged represent different sample counts.
 */
export function mergeBuckets(a: Bucket, b: Bucket): Bucket {
  return {
    sum: a.sum + b.sum,
    count: a.count + b.count,
    min: Math.min(a.min, b.min),
    max: Math.max(a.max, b.max),
  };
}

interface StoredRow {
  serverId: string;
  metric: string;
  bucketMs: number;
  sum: number;
  count: number;
  min: number;
  max: number;
}

function selectOlderThan(resolution: Resolution, cutoffMs: number): StoredRow[] {
  const rows = stmt(
    `SELECT server_id, metric, bucket_ms, sum_value, sample_count, min_value, max_value
     FROM samples WHERE resolution = ? AND bucket_ms < ?`,
  ).all(resolution, cutoffMs);

  return rows.map((row) => ({
    serverId: String(row['server_id']),
    metric: String(row['metric']),
    bucketMs: Number(row['bucket_ms']),
    sum: Number(row['sum_value']),
    count: Number(row['sample_count']),
    min: Number(row['min_value']),
    max: Number(row['max_value']),
  }));
}

const DELETE_SQL = `DELETE FROM samples WHERE resolution = ? AND bucket_ms < ?`;

/**
 * Rolls every row of `from` older than `cutoffMs` into `into`, then deletes the rows it
 * just consumed. Grouping happens in application code rather than in a single SQL
 * statement: the aggregation math (`mergeBuckets`) is the part worth being able to unit
 * test in isolation, and this keeps it out of a string.
 */
function rollupTier(from: Resolution, into: Resolution, cutoffMs: number): number {
  const rows = selectOlderThan(from, cutoffMs);
  if (rows.length === 0) return 0;

  const targetBucketMs = BUCKET_MS[into];
  const grouped = new Map<string, StoredRow>();
  for (const row of rows) {
    const bucketMs = Math.floor(row.bucketMs / targetBucketMs) * targetBucketMs;
    const key = bufferKey(row.serverId, row.metric, bucketMs);
    const existing = grouped.get(key);
    if (existing) {
      const merged = mergeBuckets(existing, row);
      existing.sum = merged.sum;
      existing.count = merged.count;
      existing.min = merged.min;
      existing.max = merged.max;
    } else {
      grouped.set(key, { ...row, bucketMs });
    }
  }

  const database = open();
  const upsert = stmt(UPSERT_SQL);
  const del = stmt(DELETE_SQL);
  database.exec('BEGIN');
  try {
    for (const group of grouped.values()) {
      upsert.run(
        group.serverId,
        group.metric,
        into,
        group.bucketMs,
        group.sum,
        group.count,
        group.min,
        group.max,
      );
    }
    del.run(from, cutoffMs);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return rows.length;
}

/**
 * The maintenance sweep: rolls raw into 1-minute buckets, 1-minute into 5-minute buckets,
 * then deletes 5-minute data past its own retention. Idempotent — running it twice in a
 * row does nothing the second time, because each rollup consumes (deletes) what it reads.
 */
export async function pruneOldSamples(now: Date = new Date()): Promise<PruneResult> {
  const nowMs = now.getTime();
  const rolledToMinute = rollupTier('raw', '1m', nowMs - RAW_RETENTION_MS);
  const rolledToFiveMinute = rollupTier('1m', '5m', nowMs - MINUTE_RETENTION_MS);
  const result = stmt(`DELETE FROM samples WHERE resolution = '5m' AND bucket_ms < ?`).run(
    nowMs - FIVE_MINUTE_RETENTION_MS,
  );
  return { rolledToMinute, rolledToFiveMinute, deleted: Number(result.changes) };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Points for one server, one metric, one resolution, ready to hand a chart. `from`/`to`
 * are inclusive bucket-start bounds in wall-clock time. Buffered-but-not-yet-flushed
 * samples are not included — the most recent point can lag real time by up to one flush
 * interval, which a monitoring chart can absorb far more easily than a query that blocks
 * on a write.
 */
export async function querySeries(
  serverId: string,
  metric: MetricName,
  from: Date,
  to: Date,
  resolution: Resolution,
): Promise<SeriesPoint[]> {
  if (from.getTime() > to.getTime()) return [];

  const rows = stmt(
    `SELECT bucket_ms, sum_value, sample_count, min_value, max_value
     FROM samples
     WHERE server_id = ? AND metric = ? AND resolution = ? AND bucket_ms >= ? AND bucket_ms <= ?
     ORDER BY bucket_ms ASC`,
  ).all(serverId, metric, resolution, from.getTime(), to.getTime());

  return rows.map((row) => {
    const count = Number(row['sample_count']);
    const sum = Number(row['sum_value']);
    return {
      timestamp: new Date(Number(row['bucket_ms'])).toISOString(),
      avg: count > 0 ? sum / count : 0,
      min: Number(row['min_value']),
      max: Number(row['max_value']),
      samples: count,
    };
  });
}

// ---------------------------------------------------------------------------
// Maintenance timers
// ---------------------------------------------------------------------------

const DEFAULT_FLUSH_INTERVAL_MS = 10_000;
const DEFAULT_PRUNE_INTERVAL_MS = 5 * 60_000;
const MIN_INTERVAL_MS = 1000;

let flushTimer: NodeJS.Timeout | null = null;
let pruneTimer: NodeJS.Timeout | null = null;
let maintenanceLogger: FastifyBaseLogger | null = null;

/** Called once from the app's boot sequence, alongside the other `start*Polling` hooks. */
export function startTimeseriesMaintenance(options: TimeseriesMaintenanceOptions = {}): void {
  if (flushTimer || pruneTimer) return;
  maintenanceLogger = options.logger ?? null;

  const flushIntervalMs = Math.max(
    MIN_INTERVAL_MS,
    options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
  );
  flushTimer = setInterval(() => {
    flushSamples().catch((error: unknown) => {
      maintenanceLogger?.error({ err: error }, 'failed to flush metric samples');
    });
  }, flushIntervalMs);
  flushTimer.unref();

  const pruneIntervalMs = Math.max(
    MIN_INTERVAL_MS,
    options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS,
  );
  pruneTimer = setInterval(() => {
    pruneOldSamples().catch((error: unknown) => {
      maintenanceLogger?.error({ err: error }, 'failed to roll up metric samples');
    });
  }, pruneIntervalMs);
  pruneTimer.unref();
}

export function stopTimeseriesMaintenance(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

/** Test hygiene, mirroring `resetLifecycleState`/`resetDrivers`: stop timers, drop whatever
 * is buffered, and close the file so the next call starts from a clean slate. */
export function resetTimeseriesState(): void {
  stopTimeseriesMaintenance();
  buffer.clear();
  closeTimeseriesDb();
}
