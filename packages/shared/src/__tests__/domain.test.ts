import { describe, expect, it } from 'vitest';
import {
  ALLOWED_POWER_ACTIONS,
  POWER_ACTIONS,
  SERVER_STATUSES,
  canPerformPowerAction,
  isLocked,
  isTransitional,
  roleAtLeast,
  DEFAULT_SUBUSER_PERMISSIONS,
  isApiKeyScope,
} from '../domain.js';
import {
  formatBytes,
  formatCount,
  formatCpu,
  formatDuration,
  formatPercent,
  hueFromString,
  initials,
  slugify,
  truncate,
} from '../format.js';

/**
 * The transition table is consulted by the API, the scheduler, the MCP tools and the UI's
 * power controls. If it disagrees with itself, an operator sees an enabled button that
 * returns 409 — so these tests assert the invariants rather than a snapshot of the values.
 */
describe('server lifecycle', () => {
  it('defines an entry for every status', () => {
    for (const status of SERVER_STATUSES) {
      expect(ALLOWED_POWER_ACTIONS[status]).toBeDefined();
    }
  });

  it('never allows an action outside the known vocabulary', () => {
    for (const status of SERVER_STATUSES) {
      for (const action of ALLOWED_POWER_ACTIONS[status]) {
        expect(POWER_ACTIONS).toContain(action);
      }
    }
  });

  it('permits no power action while locked', () => {
    for (const status of SERVER_STATUSES) {
      if (!isLocked(status)) continue;
      // `installing` is the one exception: a stuck install must be interruptible, or a bad
      // image download leaves the server unrecoverable without database surgery.
      const expected = status === 'installing' ? ['kill'] : [];
      expect([...ALLOWED_POWER_ACTIONS[status]]).toEqual(expected);
    }
  });

  it('offers start only from a stopped state, and stop only from a live one', () => {
    expect(canPerformPowerAction('offline', 'start')).toBe(true);
    expect(canPerformPowerAction('crashed', 'start')).toBe(true);
    expect(canPerformPowerAction('running', 'start')).toBe(false);
    expect(canPerformPowerAction('running', 'stop')).toBe(true);
    expect(canPerformPowerAction('offline', 'stop')).toBe(false);
  });

  it('can always kill something that is mid-transition', () => {
    for (const status of ['starting', 'stopping', 'restarting', 'installing'] as const) {
      expect(canPerformPowerAction(status, 'kill')).toBe(true);
    }
  });

  it('marks exactly the in-flight statuses as transitional', () => {
    expect(isTransitional('starting')).toBe(true);
    expect(isTransitional('running')).toBe(false);
    expect(isTransitional('crashed')).toBe(false);
  });
});

describe('roles and scopes', () => {
  it('ranks roles so an owner outranks an admin outranks a member', () => {
    expect(roleAtLeast('owner', 'admin')).toBe(true);
    expect(roleAtLeast('admin', 'owner')).toBe(false);
    expect(roleAtLeast('member', 'member')).toBe(true);
    expect(roleAtLeast('member', 'admin')).toBe(false);
  });

  it('keeps destructive permissions out of the default collaborator grant', () => {
    for (const permission of ['server.delete', 'backups.delete', 'files.delete'] as const) {
      expect(DEFAULT_SUBUSER_PERMISSIONS).not.toContain(permission);
    }
  });

  it('rejects anything that is not a real scope', () => {
    expect(isApiKeyScope('server.view')).toBe(true);
    expect(isApiKeyScope('server.create')).toBe(true);
    expect(isApiKeyScope('server.everything')).toBe(false);
    expect(isApiKeyScope(null)).toBe(false);
  });
});

describe('formatting', () => {
  it('scales byte counts and never renders a negative or NaN size', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 ** 3 * 1.5)).toBe('1.5 GB');
  });

  it('caps durations at two units so nobody reads seconds off a four-day uptime', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(90)).toBe('1m 30s');
    expect(formatDuration(3661)).toBe('1h 1m');
    expect(formatDuration(90000)).toBe('1d 1h');
  });

  it('describes cpu limits in cores, with zero meaning unlimited', () => {
    expect(formatCpu(0)).toBe('Unlimited');
    expect(formatCpu(0.5)).toBe('0.5 cores');
    expect(formatCpu(1)).toBe('1 core');
    expect(formatCpu(4)).toBe('4 cores');
  });

  it('clamps percentages and drops the decimal once past 100', () => {
    expect(formatPercent(12.34)).toBe('12.3%');
    expect(formatPercent(-5)).toBe('0.0%');
    expect(formatPercent(140)).toBe('140%');
  });

  it('produces container-safe slugs and never an empty one', () => {
    expect(slugify('Survival SMP')).toBe('survival-smp');
    expect(slugify('  ✨ Café Server!! ')).toBe('cafe-server');
    expect(slugify('***')).toBe('server');
  });

  it('truncates on a word boundary where one is close enough', () => {
    expect(truncate('short', 20)).toBe('short');
    expect(truncate('the quick brown fox jumps', 16)).toBe('the quick brown…');
  });

  it('derives stable initials and hues', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('platter')).toBe('PL');
    expect(initials('   ')).toBe('?');
    expect(hueFromString('survival')).toBe(hueFromString('survival'));
    expect(hueFromString('survival')).toBeGreaterThanOrEqual(0);
    expect(hueFromString('survival')).toBeLessThan(360);
  });

  it('pluralises counts', () => {
    expect(formatCount(1, 'server')).toBe('1 server');
    expect(formatCount(0, 'server')).toBe('0 servers');
    expect(formatCount(3, 'backup')).toBe('3 backups');
  });
});
