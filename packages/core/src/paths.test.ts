import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isProtected, isWithin, resolveWithin } from './paths';

/**
 * Path containment is the recurring vulnerability class in every game-server panel — file
 * managers, backup restore, and any parameter that becomes a path. Pterodactyl's CVE-2025-49132
 * was an unauthenticated 10.0 because two GET parameters reached a file read unchecked.
 *
 * These tests cover both halves of the defence: the syntactic check, and the symlink-aware one
 * that catches what the syntactic check structurally cannot.
 */

let root: string;
let outside: string;

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'platter-paths-'));
  root = join(base, 'data');
  outside = join(base, 'secrets');
  await mkdir(join(root, 'mods'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'private.txt'), 'do not read me');
  await writeFile(join(root, 'mods', 'real.jar'), 'jar');
});

afterAll(() => {
  root = '';
  outside = '';
});

describe('resolveWithin', () => {
  it('accepts an ordinary relative path', async () => {
    const result = await resolveWithin(root, 'mods/real.jar');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.relative).toBe('mods/real.jar');
    }
  });

  it('treats a leading slash as relative to the server root', async () => {
    // In a file manager, "/mods" means the root of *my server*, not the host's root.
    const result = await resolveWithin(root, '/mods/real.jar');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.relative).toBe('mods/real.jar');
    }
  });

  it('rejects traversal out of the root', async () => {
    const result = await resolveWithin(root, '../secrets/private.txt');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('path_escape');
    }
  });

  it('rejects deeply nested traversal', async () => {
    const result = await resolveWithin(root, 'mods/../../secrets/private.txt');
    expect(result.ok).toBe(false);
  });

  it('rejects an absolute path pointing elsewhere', async () => {
    // Normalised into the root rather than honoured, so this resolves to a non-existent path
    // inside the root — which is contained, and therefore allowed for a write.
    const result = await resolveWithin(root, '/etc/passwd');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.absolute.startsWith(root)).toBe(true);
    }
  });

  it('rejects a null byte', async () => {
    const result = await resolveWithin(root, 'mods/real.jar\u0000.txt');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_input');
    }
  });

  it('rejects a path that reaches outside through a symlink', async () => {
    // The case the syntactic check cannot see. A server owner can create this via the file
    // manager, an uploaded archive, or a mod — so it is a realistic path, not a theoretical one.
    await symlink(outside, join(root, 'escape'), 'dir').catch(() => undefined);
    const result = await resolveWithin(root, 'escape/private.txt');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('path_escape');
    }
  });

  it('rejects a write beneath a symlinked parent that escapes', async () => {
    // The file does not exist yet, so realpath fails on it and the deepest existing ancestor is
    // checked instead. Without that, a write through a symlinked directory would be allowed.
    await symlink(outside, join(root, 'escape2'), 'dir').catch(() => undefined);
    const result = await resolveWithin(root, 'escape2/new-file.txt');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('path_escape');
    }
  });

  it('allows a not-yet-existing path inside the root', async () => {
    const result = await resolveWithin(root, 'mods/new-mod.jar');
    expect(result.ok).toBe(true);
  });

  it('honours mustExist when asked', async () => {
    const result = await resolveWithin(root, 'mods/missing.jar', { mustExist: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_found');
    }
  });

  it('normalises separators in the returned relative path', async () => {
    const result = await resolveWithin(root, 'mods//./real.jar');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.relative).toBe('mods/real.jar');
    }
  });
});

describe('isWithin', () => {
  it('accepts contained paths', () => {
    expect(isWithin('/srv/data', 'mods/x.jar')).toBe(true);
    expect(isWithin('/srv/data', '/mods/x.jar')).toBe(true);
  });

  it('rejects traversal and null bytes', () => {
    expect(isWithin('/srv/data', '../x')).toBe(false);
    expect(isWithin('/srv/data', 'a/../../x')).toBe(false);
    expect(isWithin('/srv/data', 'x\u0000')).toBe(false);
  });

  it('rejects the classic archive-escape entry', () => {
    // Tar and zip archives both carry these; Platter's own archives are safe, but a user can
    // upload one and "we usually wrote it" is not a security property.
    expect(isWithin('/srv/data', '../../etc/cron.d/evil')).toBe(false);
  });
});

describe('isProtected', () => {
  it('protects files Platter regenerates', () => {
    expect(isProtected('eula.txt')).toBe(true);
    expect(isProtected('/eula.txt')).toBe(true);
    expect(isProtected('.mc-health.env')).toBe(true);
  });

  it('leaves ordinary content alone', () => {
    expect(isProtected('mods/sodium.jar')).toBe(false);
    expect(isProtected('world/level.dat')).toBe(false);
  });
});
