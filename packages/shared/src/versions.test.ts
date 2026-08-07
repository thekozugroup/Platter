import { describe, expect, it } from 'vitest';
import {
  type GameVersionEntry,
  VersionIndex,
  compareVersionsFallback,
  isPrerelease,
  parseVersion,
  requiredJavaVersion,
} from './versions';

/**
 * Minecraft versions are the sharpest edge in this codebase.
 *
 * A single list now contains `1.7.10`, `1.21.11`, `26.1`, `26.2-rc-1` and `22w13a`, and any
 * comparator over those strings gets at least one pair wrong. The index-based ordering is the
 * only correct answer; the parser exists solely as a cold-start fallback and its limits are
 * asserted here rather than left as folklore.
 */

/** Shaped exactly like Modrinth's /v2/tag/game_version — newest first. */
const TAGS: GameVersionEntry[] = [
  { version: '26.2', versionType: 'release', date: '2026-07-01T00:00:00Z', major: true },
  { version: '26.2-rc-1', versionType: 'snapshot', date: '2026-06-20T00:00:00Z', major: false },
  { version: '26.1.1', versionType: 'release', date: '2026-05-02T00:00:00Z', major: false },
  { version: '26.1', versionType: 'release', date: '2026-04-01T00:00:00Z', major: true },
  { version: '1.21.11', versionType: 'release', date: '2026-01-15T00:00:00Z', major: false },
  { version: '1.21.4', versionType: 'release', date: '2024-12-03T00:00:00Z', major: false },
  { version: '1.20.1', versionType: 'release', date: '2023-06-12T00:00:00Z', major: true },
  { version: '22w13a', versionType: 'snapshot', date: '2022-03-31T00:00:00Z', major: false },
  { version: '1.16.5', versionType: 'release', date: '2021-01-14T00:00:00Z', major: true },
];

const index = new VersionIndex(TAGS);

describe('VersionIndex', () => {
  it('orders calendar versions above the classic 1.x line', () => {
    // The pair every naive comparator gets wrong: 26.1 is newer than 1.21.11, but "1" < "2"
    // only by accident and 1 < 26 numerically says the opposite of what a semver parse implies.
    expect(index.compare('1.21.11', '26.1')).toBeLessThan(0);
    expect(index.compare('26.1', '1.21.11')).toBeGreaterThan(0);
  });

  it('sorts a mixed list oldest-first', () => {
    expect(index.sort(['26.1', '1.16.5', '1.21.4', '26.2'])).toEqual([
      '1.16.5',
      '1.21.4',
      '26.1',
      '26.2',
    ]);
  });

  it('picks the newest from a set', () => {
    expect(index.newest(['1.20.1', '26.1', '1.21.4'])).toBe('26.1');
  });

  it('orders a release above its own release candidate', () => {
    expect(index.compare('26.2-rc-1', '26.2')).toBeLessThan(0);
  });

  it('sorts unknown versions oldest, stably', () => {
    // A stale index must degrade into a predictable order, not a random one.
    const sorted = index.sort(['26.1', 'zzz-unknown', '1.21.4', 'aaa-unknown']);
    expect(sorted.slice(-2)).toEqual(['1.21.4', '26.1']);
    expect(sorted.slice(0, 2)).toEqual(['aaa-unknown', 'zzz-unknown']);
  });

  it('reports the latest stable release, skipping snapshots', () => {
    expect(index.latestRelease()).toBe('26.2');
  });

  it('filters to major releases for the version picker', () => {
    expect(index.releases({ majorOnly: true }).map((entry) => entry.version)).toEqual([
      '26.2',
      '26.1',
      '1.20.1',
      '1.16.5',
    ]);
  });

  it('excludes snapshots from releases()', () => {
    expect(index.releases().map((e) => e.version)).not.toContain('26.2-rc-1');
    expect(index.releases().map((e) => e.version)).not.toContain('22w13a');
  });

  it('returns an inclusive range in index order', () => {
    expect(index.between('1.21.4', '26.1')).toEqual(['26.1', '1.21.11', '1.21.4']);
  });

  it('returns nothing for a range with an unknown endpoint', () => {
    expect(index.between('1.21.4', 'nope')).toEqual([]);
  });

  it('is symmetric and reflexive', () => {
    expect(index.compare('26.1', '26.1')).toBe(0);
    expect(Math.sign(index.compare('26.1', '1.20.1'))).toBe(
      -Math.sign(index.compare('1.20.1', '26.1'))
    );
  });
});

describe('requiredJavaVersion', () => {
  it('maps the classic line to its documented floors', () => {
    expect(requiredJavaVersion('1.12.2')).toBe(8);
    expect(requiredJavaVersion('1.16.5')).toBe(8);
    expect(requiredJavaVersion('1.17')).toBe(17);
    expect(requiredJavaVersion('1.18.2')).toBe(17);
    expect(requiredJavaVersion('1.20.4')).toBe(17);
  });

  it('moves to Java 21 at the 1.20.5 cutover', () => {
    // The exact boundary. 1.20.4 is Java 17; 1.20.5 is Java 21, and getting it wrong produces
    // "class file version 65.0" — the most-asked support question across every panel.
    expect(requiredJavaVersion('1.20.4')).toBe(17);
    expect(requiredJavaVersion('1.20.5')).toBe(21);
    expect(requiredJavaVersion('1.21.4')).toBe(21);
    expect(requiredJavaVersion('1.21.11')).toBe(21);
  });

  it('treats calendar versions as modern', () => {
    expect(requiredJavaVersion('26.1')).toBe(21);
    expect(requiredJavaVersion('26.2')).toBe(21);
  });

  it('fails safe on anything it cannot parse', () => {
    // Running a new server on an old JDK throws UnsupportedClassVersionError; the reverse mostly
    // works. Assuming "modern" is the safe direction.
    expect(requiredJavaVersion('22w13a')).toBe(21);
    expect(requiredJavaVersion('nonsense')).toBe(21);
  });
});

describe('parseVersion', () => {
  it('splits numeric components', () => {
    expect(parseVersion('1.21.4').parts).toEqual([1, 21, 4]);
    expect(parseVersion('26.1').parts).toEqual([26, 1]);
  });

  it('recognises weekly snapshots', () => {
    const parsed = parseVersion('22w13a');
    expect(parsed.snapshot).toBe(true);
    expect(parsed.parts).toEqual([22, 13]);
  });

  it('extracts a pre-release ordinal', () => {
    expect(parseVersion('26.2-rc-1').pre).toBe(1);
    expect(parseVersion('1.21-pre3').pre).toBe(3);
    expect(parseVersion('1.21.4').pre).toBeUndefined();
  });
});

describe('compareVersionsFallback', () => {
  it('orders within the classic line', () => {
    expect(compareVersionsFallback('1.20.1', '1.21.4')).toBeLessThan(0);
    expect(compareVersionsFallback('1.21.11', '1.21.4')).toBeGreaterThan(0);
  });

  it('places a pre-release before its release', () => {
    expect(compareVersionsFallback('26.2-rc-1', '26.2')).toBeLessThan(0);
  });

  it('sorts weekly snapshots before everything, rather than pretending to interleave', () => {
    expect(compareVersionsFallback('22w13a', '1.16.5')).toBeLessThan(0);
    expect(compareVersionsFallback('22w13a', '22w14a')).toBeLessThan(0);
  });

  it('gets the calendar-versus-classic case WRONG, which is why the index exists', () => {
    // Documented, not aspirational. 26.1 really is newer than 1.21.11, and the fallback says
    // the opposite because 26 > 1 is the only signal available without the index. Anything
    // load-bearing must use VersionIndex.
    expect(compareVersionsFallback('1.21.11', '26.1')).toBeLessThan(0);
    expect(index.compare('1.21.11', '26.1')).toBeLessThan(0);
    // Both agree here by luck; the disagreement shows up against a 1.x major above 26.
    expect(compareVersionsFallback('27.1', '1.30.0')).toBeGreaterThan(0);
  });
});

describe('isPrerelease', () => {
  it('recognises snapshots and pre-releases', () => {
    expect(isPrerelease('22w13a')).toBe(true);
    expect(isPrerelease('26.2-rc-1')).toBe(true);
    expect(isPrerelease('1.21-pre1')).toBe(true);
  });

  it('leaves stable releases alone', () => {
    expect(isPrerelease('1.21.4')).toBe(false);
    expect(isPrerelease('26.1')).toBe(false);
  });
});
