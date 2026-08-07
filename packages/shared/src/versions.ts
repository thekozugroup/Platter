/**
 * Minecraft version handling.
 *
 * Minecraft versions are not semver and never were, and as of the calendar-versioning switch
 * they are not even consistently `1.x.y`. A single list can contain:
 *
 *   1.7.10  1.12.2  1.16.5  1.20.1  1.21.11        classic releases
 *   26.1  26.1.1  26.2                              calendar releases
 *   26.2-rc-1  26.3-snapshot-7  1.21-pre1  22w13a   pre-releases and snapshots
 *
 * Any comparator that parses these into numbers will mis-sort something. The only reliable
 * ordering is the one Modrinth publishes at `/v2/tag/game_version`, which is returned
 * newest-first and is authoritative.
 *
 * So: `VersionIndex` wraps that list and answers ordering questions by *position*. Parsing is
 * used only for the fallback path when the index is unavailable (offline, first run before the
 * tag cache is warm), and the fallback is explicitly best-effort.
 */

export type VersionChannel = 'release' | 'snapshot' | 'alpha' | 'beta';

export interface GameVersionEntry {
  version: string;
  versionType: VersionChannel;
  /** ISO date the version was published. */
  date: string;
  /** Modrinth marks headline releases; drives the "stable versions only" picker. */
  major: boolean;
}

export class VersionIndex {
  /** version → position, 0 = newest. */
  private readonly order: ReadonlyMap<string, number>;
  private readonly entries: readonly GameVersionEntry[];

  /** @param newestFirst exactly as returned by `/v2/tag/game_version`. */
  constructor(newestFirst: readonly GameVersionEntry[]) {
    this.entries = newestFirst;
    const order = new Map<string, number>();
    newestFirst.forEach((entry, i) => order.set(entry.version, i));
    this.order = order;
  }

  has(version: string): boolean {
    return this.order.has(version);
  }

  get(version: string): GameVersionEntry | undefined {
    const i = this.order.get(version);
    return i === undefined ? undefined : this.entries[i];
  }

  /**
   * Negative when `a` is older than `b`, matching `Array#sort` ascending semantics.
   * Unknown versions sort oldest, then alphabetically among themselves, so a stale index
   * degrades into a stable order rather than a random one.
   */
  compare(a: string, b: string): number {
    const ia = this.order.get(a);
    const ib = this.order.get(b);
    if (ia === undefined && ib === undefined) {
      return a.localeCompare(b);
    }
    if (ia === undefined) {
      return -1;
    }
    if (ib === undefined) {
      return 1;
    }
    // The index is newest-first, so a *smaller* position means a *newer* version.
    return ib - ia;
  }

  /** Ascending (oldest first). */
  sort(versions: readonly string[]): string[] {
    return [...versions].sort((a, b) => this.compare(a, b));
  }

  /** The newest version in the list, by index position. */
  newest(versions: readonly string[]): string | undefined {
    return this.sort(versions).at(-1);
  }

  /** Stable releases only, newest first — what the version picker should show by default. */
  releases(options: { majorOnly?: boolean } = {}): GameVersionEntry[] {
    return this.entries.filter(
      (e) => e.versionType === 'release' && (options.majorOnly !== true || e.major)
    );
  }

  latestRelease(): string | undefined {
    return this.entries.find((e) => e.versionType === 'release')?.version;
  }

  isRelease(version: string): boolean {
    return this.get(version)?.versionType === 'release';
  }

  /**
   * Inclusive range between two versions, in index order. Used to answer "does this mod's
   * declared support span cover my server's version" without parsing anything.
   */
  between(a: string, b: string): string[] {
    const ia = this.order.get(a);
    const ib = this.order.get(b);
    if (ia === undefined || ib === undefined) {
      return [];
    }
    const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia];
    return this.entries.slice(lo, hi + 1).map((e) => e.version);
  }

  get size(): number {
    return this.entries.length;
  }

  toJSON(): readonly GameVersionEntry[] {
    return this.entries;
  }
}

/* -------------------------------------------------------------------------- */
/* Fallback parsing — used only when no index is available                     */
/* -------------------------------------------------------------------------- */

const SNAPSHOT_RE = /^(?<year>\d{2})w(?<week>\d{2})(?<rev>[a-z])$/;
const PRE_RE = /-(?:pre|rc|snapshot)-?(?<n>\d+)$/i;

export interface ParsedVersion {
  /** Numeric components, e.g. [1, 21, 4] or [26, 2]. */
  parts: number[];
  /** Pre-release ordinal; undefined for full releases. Lower sorts earlier. */
  pre?: number;
  /** True for `22w13a`-style weekly snapshots, which have no meaningful numeric ordering. */
  snapshot: boolean;
  raw: string;
}

export function parseVersion(raw: string): ParsedVersion {
  const snapshot = SNAPSHOT_RE.exec(raw);
  if (snapshot?.groups) {
    // Encode as [year, week] so weeklies at least sort among themselves.
    return {
      parts: [Number(snapshot.groups.year), Number(snapshot.groups.week)],
      snapshot: true,
      raw,
    };
  }

  const preMatch = PRE_RE.exec(raw);
  const base = preMatch ? raw.slice(0, preMatch.index) : raw;
  const parts = base
    .split('.')
    .map((segment) => Number.parseInt(segment, 10))
    .filter((n) => Number.isFinite(n));

  return preMatch?.groups
    ? { parts, pre: Number(preMatch.groups.n), snapshot: false, raw }
    : { parts, snapshot: false, raw };
}

/**
 * Best-effort comparison without an index. Ascending.
 *
 * Deliberately conservative: weekly snapshots are incomparable with releases, so they sort
 * before everything rather than pretending to interleave.
 */
export function compareVersionsFallback(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);

  if (pa.snapshot !== pb.snapshot) {
    return pa.snapshot ? -1 : 1;
  }

  const len = Math.max(pa.parts.length, pb.parts.length);
  for (let i = 0; i < len; i++) {
    const na = pa.parts[i] ?? 0;
    const nb = pb.parts[i] ?? 0;
    if (na !== nb) {
      return na - nb;
    }
  }

  // Same numeric base: a pre-release precedes the final release.
  const preA = pa.pre ?? Number.POSITIVE_INFINITY;
  const preB = pb.pre ?? Number.POSITIVE_INFINITY;
  if (preA !== preB) {
    return preA - preB;
  }
  return a.localeCompare(b);
}

/**
 * Minimum Java major version for a Minecraft version.
 *
 * The classic `1.x` line has documented floors. Calendar versions (`26.x` and later) are all
 * well past the 1.20.5 cutover, so they require Java 21+ — treating an unrecognised
 * two-digit-major version as "modern" is the correct default and fails safe, because running a
 * new server on an old JDK produces `UnsupportedClassVersionError` while the reverse mostly
 * works.
 */
export function requiredJavaVersion(mcVersion: string): number {
  const parsed = parseVersion(mcVersion);
  const [major = 0, minor = 0, patch = 0] = parsed.parts;

  // Calendar versioning: major is the two-digit year (26 = 2026), always modern.
  if (major >= 2 && major !== 1) {
    return 21;
  }

  if (major === 1) {
    if (minor > 20 || (minor === 20 && patch >= 5)) {
      return 21;
    }
    if (minor >= 18) {
      return 17;
    }
    if (minor === 17) {
      return 17; // 1.17 requires 16; itzg ships no java16 tag and 17 runs it correctly.
    }
    if (minor >= 12) {
      return 8;
    }
    return 8;
  }

  // Weekly snapshots and anything unparseable: assume current.
  return 21;
}

/** Whether a version string looks like a snapshot/pre-release rather than a stable build. */
export function isPrerelease(version: string): boolean {
  return SNAPSHOT_RE.test(version) || PRE_RE.test(version);
}
