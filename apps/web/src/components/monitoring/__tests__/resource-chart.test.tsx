import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveMeter, meterLevel } from '@/components/monitoring/live-meter';
import {
  GAP_FACTOR,
  RESOLUTION_BUCKET_MS,
  ResourceChart,
  buildSeries,
  type SeriesInput,
  type MetricSeries,
} from '@/components/monitoring/resource-chart';
import { describeDelta } from '@/components/monitoring/stat-tile';
import { buildUptimeBuckets } from '@/components/monitoring/uptime-strip';
import { createQueryClient } from '@/lib/query.js';

/**
 * The monitoring surface, tested for the promises that regress silently.
 *
 * The three data shapes a naive chart gets wrong — nothing recorded, a hole where the server
 * was off, and a lone sample — are the bulk of this file, because each of them produces a
 * chart that *looks* fine while telling the operator something untrue.
 */

const BASE = Date.parse('2026-08-01T12:00:00.000Z');
const MINUTE = RESOLUTION_BUCKET_MS['1m'];

function series(
  values: ReadonlyArray<[offsetMs: number, value: number]>,
  overrides: Partial<MetricSeries> = {},
): MetricSeries {
  return {
    serverId: 'srv_1',
    metric: 'cpu',
    resolution: '1m',
    from: new Date(BASE).toISOString(),
    to: new Date(BASE + 60 * MINUTE).toISOString(),
    points: values.map(([offset, value]) => ({
      timestamp: new Date(BASE + offset).toISOString(),
      avg: value,
      min: value,
      max: value,
      samples: 6,
    })),
    ...overrides,
  };
}

function inputs(response: MetricSeries | undefined): SeriesInput[] {
  return [{ key: 'cpu', response }];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderChart(response: MetricSeries) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/metrics/')) return json(response);
      return json({ error: { code: 'not_found', message: 'no' } }, 404);
    }),
  );

  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ResourceChart
        metric="cpu"
        onMetricChange={() => undefined}
        onRangeChange={() => undefined}
        range="1h"
        serverId="srv_1"
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------

describe('buildSeries', () => {
  it('reports nothing rather than inventing a baseline when no samples exist', () => {
    const built = buildSeries(inputs(series([])));

    expect(built.rows).toEqual([]);
    expect(built.pointCount).toBe(0);
    expect(built.gapCount).toBe(0);
    expect(built.stats.cpu).toBeNull();
  });

  it('survives the query not having answered yet', () => {
    const built = buildSeries(inputs(undefined));
    expect(built.pointCount).toBe(0);
  });

  it('keeps a single sample as a single row, so it can be drawn as a dot', () => {
    const built = buildSeries(inputs(series([[0, 42]])));

    expect(built.rows).toHaveLength(1);
    expect(built.pointCount).toBe(1);
    expect(built.gapCount).toBe(0);
    expect(built.stats.cpu).toEqual({ min: 42, max: 42, avg: 42, latest: 42 });
  });

  it('does not break a line for consecutive buckets', () => {
    const built = buildSeries(
      inputs(
        series([
          [0, 10],
          [MINUTE, 20],
          [2 * MINUTE, 30],
        ]),
      ),
    );

    expect(built.gapCount).toBe(0);
    expect(built.rows).toHaveLength(3);
    expect(built.rows.every((row) => row.cpu !== null)).toBe(true);
  });

  it('breaks the line across a hole instead of interpolating history that never happened', () => {
    const built = buildSeries(
      inputs(
        series([
          [0, 10],
          [MINUTE, 12],
          // Twenty minutes with nothing recorded: the server was off, or Platter was.
          [21 * MINUTE, 80],
          [22 * MINUTE, 82],
        ]),
      ),
    );

    expect(built.gapCount).toBe(1);
    // Four real samples plus one all-null row, which is what makes recharts lift the pen.
    expect(built.rows).toHaveLength(5);
    expect(built.pointCount).toBe(4);

    const blank = built.rows.filter((row) => row.cpu === null);
    expect(blank).toHaveLength(1);
    const marker = blank[0];
    expect(marker?.t).toBeGreaterThan(BASE + MINUTE);
    expect(marker?.t).toBeLessThan(BASE + 21 * MINUTE);
  });

  it('tolerates one missed bucket without claiming an outage', () => {
    const built = buildSeries(
      inputs(
        series([
          [0, 10],
          // A single skipped bucket is a slow tick, not a gap.
          [2 * MINUTE, 12],
        ]),
      ),
    );

    expect(GAP_FACTOR).toBeGreaterThan(2);
    expect(built.gapCount).toBe(0);
  });

  it('summarises the window in figures the readout can print', () => {
    const built = buildSeries(
      inputs(
        series([
          [0, 10],
          [MINUTE, 30],
          [2 * MINUTE, 20],
        ]),
      ),
    );

    expect(built.stats.cpu).toEqual({ min: 10, max: 30, avg: 20, latest: 20 });
  });
});

describe('buildSeries in rate mode', () => {
  it('differentiates a cumulative counter into a per-second rate', () => {
    const built = buildSeries(
      [
        {
          key: 'rx',
          response: series([
            [0, 0],
            [MINUTE, 60_000],
            [2 * MINUTE, 120_000],
          ]),
        },
      ],
      'rate',
    );

    // The first sample has nothing to differentiate against, so it is not a data point.
    expect(built.pointCount).toBe(2);
    expect(built.rows.map((row) => row.rx)).toEqual([1000, 1000]);
  });

  it('treats a counter that went backwards as a container restart, not a negative spike', () => {
    const built = buildSeries(
      [
        {
          key: 'rx',
          response: series([
            [0, 500_000],
            [MINUTE, 560_000],
            // Restart: the counter starts again from nothing.
            [2 * MINUTE, 0],
            [3 * MINUTE, 30_000],
          ]),
        },
      ],
      'rate',
    );

    const values = built.rows.map((row) => row.rx);
    expect(values).not.toContain(0);
    expect(values.some((value) => typeof value === 'number' && value < 0)).toBe(false);
    expect(built.rows.some((row) => row.rx === null)).toBe(true);
  });

  it('does not turn a gap into one enormous burst of throughput', () => {
    const built = buildSeries(
      [
        {
          key: 'rx',
          response: series([
            [0, 0],
            // An hour later the counter is much higher, but nothing was recorded between.
            [60 * MINUTE, 3_600_000],
          ]),
        },
      ],
      'rate',
    );

    expect(built.pointCount).toBe(0);
  });
});

describe('buildUptimeBuckets', () => {
  const from = BASE;
  const to = BASE + 8 * MINUTE;

  it('marks a bucket as running only where a sample was actually recorded', () => {
    const buckets = buildUptimeBuckets({
      timestamps: [from + 30_000, from + 90_000],
      from,
      to,
      segments: 8,
    });

    expect(buckets).toHaveLength(8);
    expect(buckets[0]?.state).toBe('running');
    expect(buckets[1]?.state).toBe('running');
    // No sample is genuinely ambiguous, and is named as such rather than as downtime.
    expect(buckets[7]?.state).toBe('unknown');
  });

  it('lets a crash outrank the samples around it', () => {
    const buckets = buildUptimeBuckets({
      timestamps: [from + 30_000],
      from,
      to,
      segments: 8,
      crashedAt: from + 30_000,
    });

    expect(buckets[0]?.state).toBe('crashed');
  });

  it('returns nothing for a window with no width, rather than dividing by zero', () => {
    expect(buildUptimeBuckets({ timestamps: [], from, to: from })).toEqual([]);
  });
});

describe('describeDelta', () => {
  it('says there is no comparison rather than showing a confident zero', () => {
    expect(describeDelta(undefined, (value) => `${value}`)).toMatch(/no earlier reading/i);
    expect(describeDelta([5], (value) => `${value}`)).toMatch(/no earlier reading/i);
  });

  it('calls a small wobble steady instead of a trend', () => {
    expect(describeDelta([100, 100.5], (value) => `${value}`)).toMatch(/steady/i);
  });

  it('names the direction and the size of a real change', () => {
    expect(describeDelta([10, 40], (value) => `${value}`)).toMatch(/^Up 30/);
    expect(describeDelta([40, 10], (value) => `${value}`)).toMatch(/^Down 30/);
  });
});

describe('meterLevel', () => {
  it('escalates at the thresholds it was given', () => {
    expect(meterLevel(0.4, 0.8, 0.95)).toBe('normal');
    expect(meterLevel(0.85, 0.8, 0.95)).toBe('warning');
    expect(meterLevel(0.99, 0.8, 0.95)).toBe('critical');
  });
});

describe('LiveMeter', () => {
  it('is a meter, and reads out the figures rather than the raw number', () => {
    render(
      <LiveMeter format={(value) => `${value} MB`} label="Memory" limit={4096} value={2048} />,
    );

    const meter = screen.getByRole('meter', { name: 'Memory' });
    expect(meter).toHaveAttribute('aria-valuenow', '2048');
    expect(meter).toHaveAttribute('aria-valuemax', '4096');
    expect(meter).toHaveAttribute('aria-valuetext', '2048 MB of 4096 MB — 50%');
  });

  it('warns in words, not only in colour', () => {
    render(
      <LiveMeter format={(value) => `${value} MB`} label="Memory" limit={4096} value={4000} />,
    );

    expect(screen.getByText(/at the limit/i)).toBeInTheDocument();
  });

  it('refuses to draw a bar against a limit that does not exist', () => {
    render(<LiveMeter format={(value) => `${value} MB`} label="Disk" limit={null} value={900} />);

    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.getByText(/no limit is set/i)).toBeInTheDocument();
  });
});

describe('ResourceChart', () => {
  it('prints the current value and the window summary as text beside the chart', async () => {
    renderChart(
      series([
        [0, 10],
        [MINUTE, 30],
        [2 * MINUTE, 20],
      ]),
    );

    // The chart is never the only representation of its data.
    expect(await screen.findByText('20.0%')).toBeInTheDocument();
    expect(
      await screen.findByText(/Low 10\.0% · Average 20\.0% · Peak 30\.0%/),
    ).toBeInTheDocument();
  });

  it('says a break is missing history rather than leaving it unexplained', async () => {
    renderChart(
      series([
        [0, 10],
        [MINUTE, 12],
        [21 * MINUTE, 80],
      ]),
    );

    expect(await screen.findByText(/The line breaks once/)).toBeInTheDocument();
    expect(screen.getByText(/was not running/)).toBeInTheDocument();
  });

  it('explains an empty window instead of drawing an empty axis', async () => {
    renderChart(series([]));

    expect(
      await screen.findByText(/Nothing recorded for CPU in the last hour/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/samples a server only while it is running/i)).toBeInTheDocument();
  });

  it('offers every range as a real 44px control', async () => {
    renderChart(series([[0, 10]]));

    for (const label of ['1h', '6h', '24h', '7d']) {
      expect(await screen.findByRole('radio', { name: label })).toBeInTheDocument();
    }
    // One sample cannot be a line, and the readout says so rather than showing a blank chart.
    expect(await screen.findByText(/not enough history to draw a line/i)).toBeInTheDocument();
  });
});
