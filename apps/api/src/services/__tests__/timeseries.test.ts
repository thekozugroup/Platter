import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * The timeseries store, against its real SQLite file (not the Prisma one — see the
 * module-level comment in `timeseries.ts` for why this table does not live there).
 *
 * There is no `prisma db push` here on purpose: this module never touches the Prisma
 * database, so the only setup this suite needs is an isolated `DATA_DIR`.
 */

const workdir = await mkdtemp(path.join(tmpdir(), 'platter-timeseries-'));
process.env['NODE_ENV'] = 'test';
process.env['DATA_DIR'] = path.join(workdir, 'data');

const { recordSample, flushSamples, querySeries, mergeBuckets, isMetricName, isResolution } =
  await import('../timeseries.js');

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

const BASE_MS = Date.UTC(2030, 0, 1, 0, 0, 0);
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

describe('recordSample / flushSamples / querySeries', () => {
  it('averages, bounds and counts a single raw bucket correctly', async () => {
    const serverId = 'srv_basic';
    recordSample(serverId, 'cpu', 10, new Date(BASE_MS));
    recordSample(serverId, 'cpu', 20, new Date(BASE_MS + 3000));
    recordSample(serverId, 'cpu', 30, new Date(BASE_MS + 6000));
    await flushSamples();

    const points = await querySeries(
      serverId,
      'cpu',
      new Date(BASE_MS - 1000),
      new Date(BASE_MS + 60_000),
      'raw',
    );
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ avg: 20, min: 10, max: 30, samples: 3 });
    expect(points[0]?.timestamp).toBe(new Date(BASE_MS).toISOString());
  });

  it('merges samples that land in an already-flushed bucket instead of overwriting it', async () => {
    const serverId = 'srv_accumulate';
    recordSample(serverId, 'memory', 10, new Date(BASE_MS));
    await flushSamples();
    // Same 10s raw bucket as above, delivered in a second flush cycle.
    recordSample(serverId, 'memory', 20, new Date(BASE_MS + 5000));
    await flushSamples();

    const points = await querySeries(
      serverId,
      'memory',
      new Date(BASE_MS),
      new Date(BASE_MS + 9999),
      'raw',
    );
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ avg: 15, min: 10, max: 20, samples: 2 });
  });

  it('excludes samples outside the requested [from, to] window', async () => {
    const serverId = 'srv_range';
    recordSample(serverId, 'networkRx', 1, new Date(BASE_MS));
    recordSample(serverId, 'networkRx', 2, new Date(BASE_MS + 10_000));
    recordSample(serverId, 'networkRx', 3, new Date(BASE_MS + 20_000));
    await flushSamples();

    const points = await querySeries(
      serverId,
      'networkRx',
      new Date(BASE_MS + 5000),
      new Date(BASE_MS + 15_000),
      'raw',
    );
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ avg: 2, samples: 1 });
  });

  it('answers an empty series for a window with no data, not an error', async () => {
    const points = await querySeries(
      'srv_missing',
      'cpu',
      new Date(BASE_MS),
      new Date(BASE_MS + 1000),
      'raw',
    );
    expect(points).toEqual([]);
  });

  it('keeps two servers and two metrics from contaminating each other', async () => {
    recordSample('srv_iso_a', 'cpu', 100, new Date(BASE_MS));
    recordSample('srv_iso_b', 'cpu', 5, new Date(BASE_MS));
    recordSample('srv_iso_a', 'memory', 999, new Date(BASE_MS));
    await flushSamples();

    const a = await querySeries(
      'srv_iso_a',
      'cpu',
      new Date(BASE_MS),
      new Date(BASE_MS + 1000),
      'raw',
    );
    const b = await querySeries(
      'srv_iso_b',
      'cpu',
      new Date(BASE_MS),
      new Date(BASE_MS + 1000),
      'raw',
    );
    expect(a[0]).toMatchObject({ avg: 100 });
    expect(b[0]).toMatchObject({ avg: 5 });
  });

  it('drops non-finite readings instead of letting them corrupt an aggregate', async () => {
    const serverId = 'srv_nan_guard';
    recordSample(serverId, 'cpu', Number.NaN, new Date(BASE_MS));
    recordSample(serverId, 'cpu', Number.POSITIVE_INFINITY, new Date(BASE_MS));
    recordSample(serverId, 'cpu', 42, new Date(BASE_MS));
    await flushSamples();

    const points = await querySeries(
      serverId,
      'cpu',
      new Date(BASE_MS),
      new Date(BASE_MS + 1000),
      'raw',
    );
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ avg: 42, samples: 1 });
  });

  it('treats an inverted range as empty rather than querying backwards', async () => {
    const points = await querySeries(
      'srv_basic',
      'cpu',
      new Date(BASE_MS + 1000),
      new Date(BASE_MS),
      'raw',
    );
    expect(points).toEqual([]);
  });
});

describe('mergeBuckets', () => {
  it('preserves a correctly weighted average across uneven sample counts', () => {
    const merged = mergeBuckets(
      { sum: 10, count: 1, min: 10, max: 10 },
      { sum: 100, count: 9, min: 5, max: 20 },
    );
    expect(merged).toEqual({ sum: 110, count: 10, min: 5, max: 20 });
    expect(merged.sum / merged.count).toBe(11);
  });

  it('is commutative', () => {
    const left = { sum: 30, count: 3, min: 1, max: 50 };
    const right = { sum: 4, count: 2, min: -5, max: 2 };
    expect(mergeBuckets(left, right)).toEqual(mergeBuckets(right, left));
  });
});

describe('type guards', () => {
  it('recognises the closed metric and resolution vocabularies', () => {
    expect(isMetricName('cpu')).toBe(true);
    expect(isMetricName('players')).toBe(true);
    expect(isMetricName('bogus')).toBe(false);
    expect(isResolution('5m')).toBe(true);
    expect(isResolution('1h')).toBe(false);
  });
});

describe('pruneOldSamples', () => {
  // `pruneOldSamples` sweeps every server's rows for the tier it is rolling up — that is
  // the correct behaviour for the real maintenance job, but it means these assertions
  // would see contamination from the other describe block's raw rows if they shared a
  // database. A freshly reset module registry plus its own `DATA_DIR` gives this block an
  // empty database that only it ever writes to.
  it('rolls raw into 1-minute buckets, then into 5-minute buckets, then expires them', async () => {
    vi.resetModules();
    const isolatedDir = await mkdtemp(path.join(tmpdir(), 'platter-timeseries-rollup-'));
    process.env['DATA_DIR'] = isolatedDir;
    const { recordSample, flushSamples, querySeries, pruneOldSamples, closeTimeseriesDb } =
      await import('../timeseries.js');

    const serverId = 'srv_rollup';

    // Six raw buckets inside the same minute; two of them get two samples each, so the
    // rollup has to add sample counts correctly, not just average of averages.
    recordSample(serverId, 'cpu', 10, new Date(BASE_MS));
    recordSample(serverId, 'cpu', 20, new Date(BASE_MS + 3000)); // same raw bucket as above
    recordSample(serverId, 'cpu', 30, new Date(BASE_MS + 10_000));
    recordSample(serverId, 'cpu', 40, new Date(BASE_MS + 20_000));
    recordSample(serverId, 'cpu', 60, new Date(BASE_MS + 25_000)); // same raw bucket as above
    recordSample(serverId, 'cpu', 50, new Date(BASE_MS + 30_000));
    recordSample(serverId, 'cpu', 70, new Date(BASE_MS + 40_000));
    recordSample(serverId, 'cpu', 90, new Date(BASE_MS + 50_000));
    await flushSamples();

    const totalSum = 10 + 20 + 30 + 40 + 60 + 50 + 70 + 90;
    const totalCount = 8;
    const expectedAvg = totalSum / totalCount;

    const rawBefore = await querySeries(
      serverId,
      'cpu',
      new Date(BASE_MS - 1),
      new Date(BASE_MS + 60_000),
      'raw',
    );
    expect(rawBefore).toHaveLength(6);

    // Cutoff for the raw tier is `now - 3h`; push `now` just past that relative to the
    // youngest raw bucket (50s after BASE_MS) so every raw row qualifies, while staying
    // far short of the 1-minute tier's own 48h retention so the rollup this produces is
    // not immediately swept into the 5-minute tier by the same call.
    const now1 = new Date(BASE_MS + 3 * HOUR_MS + 60_000);
    const prune1 = await pruneOldSamples(now1);
    expect(prune1).toEqual({ rolledToMinute: 6, rolledToFiveMinute: 0, deleted: 0 });

    const rawAfter = await querySeries(
      serverId,
      'cpu',
      new Date(BASE_MS - 1),
      new Date(BASE_MS + 60_000),
      'raw',
    );
    expect(rawAfter).toEqual([]);

    const minutePoints = await querySeries(
      serverId,
      'cpu',
      new Date(BASE_MS - 1),
      new Date(BASE_MS + 60_000),
      '1m',
    );
    expect(minutePoints).toHaveLength(1);
    expect(minutePoints[0]).toMatchObject({
      avg: expectedAvg,
      min: 10,
      max: 90,
      samples: totalCount,
    });
    expect(minutePoints[0]?.timestamp).toBe(new Date(BASE_MS).toISOString());

    // Now cross the 1-minute tier's 48h retention, but stay well short of the 5-minute
    // tier's 14-day retention so the row this creates survives long enough to inspect.
    const now2 = new Date(now1.getTime() + 49 * HOUR_MS);
    const prune2 = await pruneOldSamples(now2);
    expect(prune2).toEqual({ rolledToMinute: 0, rolledToFiveMinute: 1, deleted: 0 });

    const minuteAfter = await querySeries(
      serverId,
      'cpu',
      new Date(BASE_MS - 1),
      new Date(BASE_MS + 60_000),
      '1m',
    );
    expect(minuteAfter).toEqual([]);

    const fiveMinutePoints = await querySeries(
      serverId,
      'cpu',
      new Date(BASE_MS - 1),
      new Date(BASE_MS + 5 * 60_000),
      '5m',
    );
    expect(fiveMinutePoints).toHaveLength(1);
    expect(fiveMinutePoints[0]).toMatchObject({
      avg: expectedAvg,
      min: 10,
      max: 90,
      samples: totalCount,
    });

    // Finally, cross the 5-minute tier's 14-day retention: the last row is deleted outright.
    const now3 = new Date(BASE_MS + 14 * DAY_MS + HOUR_MS);
    const prune3 = await pruneOldSamples(now3);
    expect(prune3).toEqual({ rolledToMinute: 0, rolledToFiveMinute: 0, deleted: 1 });

    const fiveMinuteAfter = await querySeries(
      serverId,
      'cpu',
      new Date(BASE_MS - 1),
      new Date(BASE_MS + 5 * 60_000),
      '5m',
    );
    expect(fiveMinuteAfter).toEqual([]);

    // With nothing left anywhere for this server, running the sweep again is a no-op.
    const prune4 = await pruneOldSamples(now3);
    expect(prune4).toEqual({ rolledToMinute: 0, rolledToFiveMinute: 0, deleted: 0 });

    closeTimeseriesDb();
    await rm(isolatedDir, { recursive: true, force: true });
  });
});
