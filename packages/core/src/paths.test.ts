import { describe, expect, it } from 'vitest';
import { isContained, isProtected, isWithin } from './paths';

const ROOT = '/data/servers/01H';

describe('isWithin', () => {
  it('accepts paths under the root, with or without a leading slash', () => {
    expect(isWithin(ROOT, 'world/level.dat')).toBe(true);
    // Leading slash means "relative to this server's root" — a file-manager convention.
    expect(isWithin(ROOT, '/world/level.dat')).toBe(true);
    expect(isWithin(ROOT, '')).toBe(true);
  });

  it('rejects traversal and NUL', () => {
    expect(isWithin(ROOT, '../../etc/passwd')).toBe(false);
    expect(isWithin(ROOT, 'world/../../../etc/passwd')).toBe(false);
    expect(isWithin(ROOT, 'world/\0.dat')).toBe(false);
  });

  it('does not treat a sibling with a shared prefix as contained', () => {
    expect(isWithin(ROOT, '../01H-other/level.dat')).toBe(false);
  });
});

describe('isContained', () => {
  it('accepts absolute paths at or below the root', () => {
    expect(isContained(ROOT, `${ROOT}/world/level.dat`)).toBe(true);
    expect(isContained(ROOT, ROOT)).toBe(true);
  });

  it('rejects an absolute path outside the root — the case isWithin gets wrong', () => {
    // `isWithin` strips the leading slash and re-roots, so it says true here. That difference is
    // the entire reason this function exists: a symlink target of `/etc/passwd` means
    // `/etc/passwd`, not `<root>/etc/passwd`.
    expect(isWithin(ROOT, '/etc/passwd')).toBe(true);
    expect(isContained(ROOT, '/etc/passwd')).toBe(false);
    expect(isContained(ROOT, '/home/user/.ssh')).toBe(false);
  });

  it('rejects relative input, which it cannot judge', () => {
    expect(isContained(ROOT, 'world/level.dat')).toBe(false);
  });

  it('rejects traversal that resolves out, and NUL', () => {
    expect(isContained(ROOT, `${ROOT}/../01H-other`)).toBe(false);
    expect(isContained(ROOT, `${ROOT}/world/\0`)).toBe(false);
  });

  it('does not treat a sibling with a shared prefix as contained', () => {
    expect(isContained(ROOT, `${ROOT}-other/level.dat`)).toBe(false);
  });
});

describe('isProtected', () => {
  it('matches with or without a leading slash', () => {
    expect(isProtected('eula.txt')).toBe(true);
    expect(isProtected('/eula.txt')).toBe(true);
    expect(isProtected('world/level.dat')).toBe(false);
  });
});
