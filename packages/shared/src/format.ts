/**
 * Formatting helpers shared by the API (log lines, audit sentences) and the web client.
 * Keeping them here means a byte count reads the same in a toast and in a log file.
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** Human byte count. Uses 1024 steps, one decimal above KB — `1.4 GB`, `812 MB`. */
export function formatBytes(bytes: number, fractionDigits?: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const digits = fractionDigits ?? (exponent === 0 ? 0 : value < 10 ? 1 : 0);
  return `${value.toFixed(digits)} ${BYTE_UNITS[exponent]}`;
}

/** Memory is stored in MB but displayed in whatever unit reads best. */
export function formatMegabytes(mb: number): string {
  return formatBytes(mb * 1024 * 1024);
}

/** Compact duration: `4d 3h`, `12m 04s`, `0s`. Two units at most — precision nobody reads is noise. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0s';
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
}

/** `just now`, `4 minutes ago`, `3 days ago`. Falls back to a date past a week. */
export function formatRelativeTime(input: string | number | Date, now: Date = new Date()): string {
  const then = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(then.getTime())) return '—';

  const deltaSeconds = Math.round((then.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(deltaSeconds);
  if (abs < 45) return 'just now';

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const divisions: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, 'second'],
    [3600, 'minute'],
    [86400, 'hour'],
    [604800, 'day'],
  ];

  for (const [limit, unit] of divisions) {
    if (abs < limit) {
      const perUnit = unit === 'second' ? 1 : unit === 'minute' ? 60 : unit === 'hour' ? 3600 : 86400;
      return formatter.format(Math.round(deltaSeconds / perUnit), unit);
    }
  }

  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** `12.4%` — CPU percentages are noisy, so one decimal is the ceiling. */
export function formatPercent(value: number, fractionDigits = 1): string {
  if (!Number.isFinite(value)) return '0%';
  const clamped = Math.max(0, value);
  return `${clamped.toFixed(clamped >= 100 ? 0 : fractionDigits)}%`;
}

/** CPU limits read as cores: `unlimited`, `0.5 cores`, `4 cores`. */
export function formatCpu(cores: number): string {
  if (cores <= 0) return 'Unlimited';
  if (cores < 1) return `${cores.toFixed(1)} cores`;
  return `${cores % 1 === 0 ? cores : cores.toFixed(1)} core${cores === 1 ? '' : 's'}`;
}

/** `play.example.com:25565`. IPv6 hosts get bracketed. */
export function formatAddress(host: string, port: number): string {
  const needsBrackets = host.includes(':') && !host.startsWith('[');
  return `${needsBrackets ? `[${host}]` : host}:${port}`;
}

/**
 * Turn a server name into a container-safe slug.
 * Docker names allow `[a-zA-Z0-9][a-zA-Z0-9_.-]*`, so anything else collapses to a dash.
 */
export function slugify(input: string, fallback = 'server'): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : fallback;
}

/** Truncate on a word boundary where possible, with a real ellipsis. */
export function truncate(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  const cut = input.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Initials for an avatar: `Ada Lovelace` -> `AL`, `platter` -> `PL`. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] ?? '').slice(0, 2).toUpperCase();
  return `${(parts[0] ?? '')[0] ?? ''}${(parts[parts.length - 1] ?? '')[0] ?? ''}`.toUpperCase();
}

/**
 * Deterministic hue from a string, used for avatars and blueprint icons so the same
 * name always gets the same colour without storing one.
 */
export function hueFromString(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

/** Pluralise without an i18n dependency: `formatCount(1, 'server')` -> `1 server`. */
export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}
