import { describe, expect, it, beforeEach } from 'vitest';
import { checkForUpdate, isNewer, resetUpdateCache } from '../updates.js';

/**
 * Version comparison, and the failure modes of asking a third party a question.
 *
 * `isNewer` is the part that can be quietly wrong for months: string comparison puts 0.10.0
 * before 0.9.0, so the release that fixes something looks older than what is installed and
 * nobody is ever told. It is worth pinning by example.
 */

beforeEach(() => {
  resetUpdateCache();
});

describe('isNewer', () => {
  it('compares numerically, not as text', () => {
    // The case that motivates the whole function.
    expect(isNewer('0.10.0', '0.9.0')).toBe(true);
    expect(isNewer('0.9.0', '0.10.0')).toBe(false);
    expect(isNewer('1.2.10', '1.2.9')).toBe(true);
  });

  it('ignores a leading v, because tags carry one and package.json does not', () => {
    expect(isNewer('v0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('v0.1.0', '0.1.0')).toBe(false);
  });

  it('treats an equal version as nothing to do', () => {
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
  });

  it('does not offer a prerelease as an upgrade over the release it leads to', () => {
    expect(isNewer('0.2.0-rc.1', '0.2.0')).toBe(false);
    // But it is newer than the version before it.
    expect(isNewer('0.2.0-rc.1', '0.1.0')).toBe(true);
    // And the finished release is an upgrade from the candidate.
    expect(isNewer('0.2.0', '0.2.0-rc.1')).toBe(true);
  });

  it('handles versions of different length', () => {
    expect(isNewer('1.1', '1.0.9')).toBe(true);
    expect(isNewer('1.0', '1.0.0')).toBe(false);
  });
});

describe('checkForUpdate', () => {
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('reports an available update', async () => {
    const status = await checkForUpdate({
      currentVersion: '0.1.0',
      enabled: true,
      fetchImpl: async () =>
        ok({
          tag_name: 'v0.2.0',
          html_url: 'https://example.invalid/r',
          published_at: '2026-01-01T00:00:00Z',
        }),
    });

    expect(status.latest).toBe('0.2.0');
    expect(status.updateAvailable).toBe(true);
    expect(status.unavailable).toBeNull();
  });

  it('says nothing is available when the release matches', async () => {
    const status = await checkForUpdate({
      currentVersion: '0.2.0',
      enabled: true,
      fetchImpl: async () => ok({ tag_name: 'v0.2.0', html_url: 'https://example.invalid/r' }),
    });

    expect(status.updateAvailable).toBe(false);
    expect(status.latest).toBe('0.2.0');
  });

  it('makes no request at all when checks are off', async () => {
    let called = false;
    const status = await checkForUpdate({
      currentVersion: '0.1.0',
      enabled: false,
      fetchImpl: async () => {
        called = true;
        return ok({});
      },
    });

    // The setting exists so an offline install stays offline; calling anyway would defeat it.
    expect(called).toBe(false);
    expect(status.unavailable).toContain('turned off');
  });

  it('treats "no release yet" as normal rather than an error', async () => {
    const status = await checkForUpdate({
      currentVersion: '0.1.0',
      enabled: true,
      fetchImpl: async () => new Response('{}', { status: 404 }),
    });

    expect(status.updateAvailable).toBe(false);
    expect(status.unavailable).toContain('No release');
  });

  it('degrades quietly when the network fails', async () => {
    // Not knowing whether an update exists must never take the settings page down.
    const status = await checkForUpdate({
      currentVersion: '0.1.0',
      enabled: true,
      fetchImpl: async () => {
        throw new Error('ENOTFOUND');
      },
    });

    expect(status.latest).toBeNull();
    expect(status.updateAvailable).toBe(false);
    expect(status.unavailable).toContain('Could not reach');
  });
});
