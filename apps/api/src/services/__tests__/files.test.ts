import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { create as tarCreate } from 'tar';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * `services/files.ts` never touches Prisma, so these tests never need a database — just a
 * `DATA_DIR` pointed at a scratch directory before `config.ts` (pulled in transitively via
 * `serverDataDir`) parses the environment.
 */

const workdir = await mkdtemp(path.join(tmpdir(), 'platter-files-'));

process.env['NODE_ENV'] = 'test';
process.env['DATA_DIR'] = path.join(workdir, 'data');
process.env['DATABASE_URL'] = `file:${path.join(workdir, 'unused.db')}`;
process.env['JWT_SECRET'] = 'test-secret-that-is-long-enough-to-pass';

const { serverDataDir } = await import('../lifecycle.js');
const files = await import('../files.js');

const SERVER_ID = 'srv_test';

function root(): string {
  return serverDataDir(SERVER_ID);
}

beforeEach(async () => {
  await rm(root(), { recursive: true, force: true });
  await mkdir(root(), { recursive: true });
});

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe('path safety', () => {
  it('rejects a literal .. traversal even without the schema layer in front of it', async () => {
    await writeFile(path.join(path.dirname(root()), 'escape.txt'), 'nope');
    await expect(files.readServerFile(SERVER_ID, '../escape.txt')).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('rejects an absolute path rather than silently reinterpreting it as relative', async () => {
    await expect(files.readServerFile(SERVER_ID, '/etc/passwd')).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('rejects reading through a symlink whose target escapes the server directory', async () => {
    const secret = path.join(workdir, 'secret.txt');
    await writeFile(secret, 'top secret');
    await symlink(secret, path.join(root(), 'link.txt'));

    await expect(files.readServerFile(SERVER_ID, 'link.txt')).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('lists an escaping symlink as a symlink, but still refuses to enter it', async () => {
    const outsideDir = path.join(workdir, 'outside-dir');
    await mkdir(outsideDir, { recursive: true });
    await symlink(outsideDir, path.join(root(), 'escape'), 'dir');

    const listing = await files.listServerFiles(SERVER_ID, '');
    expect(listing.entries.find((entry) => entry.name === 'escape')?.type).toBe('symlink');

    await expect(files.listServerFiles(SERVER_ID, 'escape')).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('follows a symlink that stays inside the server directory', async () => {
    await mkdir(path.join(root(), 'real'), { recursive: true });
    await writeFile(path.join(root(), 'real', 'target.txt'), 'inside');
    await symlink(path.join(root(), 'real', 'target.txt'), path.join(root(), 'alias.txt'));

    const result = await files.readServerFile(SERVER_ID, 'alias.txt');
    expect(result.content).toBe('inside');
  });

  it('rejects a zip-slip archive instead of writing outside the extraction folder', async () => {
    const staging = await mkdtemp(path.join(workdir, 'zipslip-'));
    const inner = path.join(staging, 'inner');
    await mkdir(inner, { recursive: true });
    await writeFile(path.join(staging, 'evil.txt'), 'pwned');

    // `preservePaths: true` is what makes this archive hostile: without it, tar itself
    // would already have sanitised the `..` out of the entry on the way in.
    const pack = tarCreate({ gzip: true, cwd: inner, preservePaths: true }, ['../evil.txt']);
    const archivePath = path.join(root(), 'evil.tar.gz');
    await pipeline(pack, createWriteStream(archivePath));

    await expect(files.extractServerArchive(SERVER_ID, 'evil.tar.gz', 'dest')).rejects.toMatchObject({
      code: 'bad_request',
    });
    // The entry's real target — one level above the extraction folder, i.e. the server
    // root itself — never received the file the archive tried to plant there.
    expect(await readdir(root())).not.toContain('evil.txt');
  });
});

describe('atomic write', () => {
  it('survives an interrupted write: the previous file is left completely intact', async () => {
    await files.writeServerFile(SERVER_ID, 'config.txt', 'ORIGINAL-CONTENT');

    const failing = new Readable({
      read() {
        this.push('partial-new-data');
        this.destroy(new Error('simulated crash mid-write'));
      },
    });

    await expect(
      files.writeServerFileStream(SERVER_ID, 'config.txt', failing),
    ).rejects.toThrow();

    const after = await files.readServerFile(SERVER_ID, 'config.txt');
    expect(after.content).toBe('ORIGINAL-CONTENT');

    const remaining = await readdir(root());
    expect(remaining.every((name) => !name.startsWith('.platter-tmp-'))).toBe(true);
  });

  it('rejects an upload stream that reports itself truncated, and cleans up after itself', async () => {
    const stream = Readable.from(['some bytes']) as Readable & { truncated?: boolean };
    stream.truncated = true;

    await expect(files.writeServerFileStream(SERVER_ID, 'upload.bin', stream)).rejects.toMatchObject({
      code: 'payload_too_large',
    });

    const remaining = await readdir(root());
    expect(remaining).not.toContain('upload.bin');
    expect(remaining.every((name) => !name.startsWith('.platter-tmp-'))).toBe(true);
  });
});

describe('listing and metadata', () => {
  it('flags a text file editable and a binary-extension file not', async () => {
    await writeFile(path.join(root(), 'notes.txt'), 'hello world');
    await writeFile(path.join(root(), 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));

    const listing = await files.listServerFiles(SERVER_ID, '');
    const text = listing.entries.find((entry) => entry.name === 'notes.txt');
    const image = listing.entries.find((entry) => entry.name === 'image.png');

    expect(text?.editable).toBe(true);
    expect(image?.editable).toBe(false);
    expect(image?.mimeType).toBe('image/png');
  });

  it('sniffs a mislabelled binary file rather than trusting its extension', async () => {
    await writeFile(path.join(root(), 'fake.txt'), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    const listing = await files.listServerFiles(SERVER_ID, '');
    expect(listing.entries.find((entry) => entry.name === 'fake.txt')?.editable).toBe(false);
  });

  it('caps a read at the byte limit and flags it as truncated', async () => {
    const big = 'A'.repeat(8 * 1024 * 1024 + 100);
    await files.writeServerFile(SERVER_ID, 'huge.log', big);

    const result = await files.readServerFile(SERVER_ID, 'huge.log');
    expect(result.truncated).toBe(true);
    expect(result.content).toHaveLength(8 * 1024 * 1024);
  });
});

describe('mutations', () => {
  it('creates a directory and refuses to recreate it', async () => {
    const entry = await files.createServerDirectory(SERVER_ID, 'plugins');
    expect(entry.type).toBe('directory');
    await expect(files.createServerDirectory(SERVER_ID, 'plugins')).rejects.toMatchObject({
      code: 'already_exists',
    });
  });

  it('renames a file', async () => {
    await files.writeServerFile(SERVER_ID, 'a.txt', 'hi');
    const entry = await files.renameServerPath(SERVER_ID, 'a.txt', 'b.txt');
    expect(entry.path).toBe('b.txt');
    await expect(files.readServerFile(SERVER_ID, 'a.txt')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('copies a file without disturbing the original', async () => {
    await files.writeServerFile(SERVER_ID, 'a.txt', 'hi');
    await files.copyServerPath(SERVER_ID, 'a.txt', 'copy.txt');
    expect((await files.readServerFile(SERVER_ID, 'a.txt')).content).toBe('hi');
    expect((await files.readServerFile(SERVER_ID, 'copy.txt')).content).toBe('hi');
  });

  it('refuses to delete the server root', async () => {
    await expect(files.deleteServerPaths(SERVER_ID, [''])).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('deletes files and is idempotent about ones already gone', async () => {
    await files.writeServerFile(SERVER_ID, 'a.txt', 'hi');
    const result = await files.deleteServerPaths(SERVER_ID, ['a.txt', 'never-existed.txt']);
    expect(result.deleted).toEqual(['a.txt']);
  });
});

describe('compress / extract', () => {
  it('round-trips a folder through a .tar.gz archive', async () => {
    await mkdir(path.join(root(), 'world'), { recursive: true });
    await writeFile(path.join(root(), 'world', 'level.dat'), 'level-data');

    const archive = await files.compressServerPaths(SERVER_ID, ['world'], 'backup.tar.gz');
    expect(archive.name).toBe('backup.tar.gz');

    await files.deleteServerPaths(SERVER_ID, ['world']);
    await files.extractServerArchive(SERVER_ID, 'backup.tar.gz', 'restored');

    const restored = await files.readServerFile(SERVER_ID, 'restored/world/level.dat');
    expect(restored.content).toBe('level-data');
  });

  it('defaults the archive name next to the files being compressed', async () => {
    await mkdir(path.join(root(), 'sub'), { recursive: true });
    await writeFile(path.join(root(), 'sub', 'a.txt'), 'a');

    const archive = await files.compressServerPaths(SERVER_ID, ['sub/a.txt']);
    expect(archive.path.startsWith('sub/archive-')).toBe(true);
  });

  it('writes nothing at all when a later entry escapes the destination', async () => {
    const staging = await mkdtemp(path.join(workdir, 'partial-'));
    const inner = path.join(staging, 'inner');
    await mkdir(inner, { recursive: true });
    await writeFile(path.join(inner, 'harmless.txt'), 'written before the hostile entry');
    await writeFile(path.join(staging, 'evil.txt'), 'pwned');

    // Order matters: the good member is streamed — and, before the fix, extracted — before
    // tar ever reaches the one that makes it refuse the archive.
    const pack = tarCreate({ gzip: true, cwd: inner, preservePaths: true }, [
      'harmless.txt',
      '../evil.txt',
    ]);
    const archivePath = path.join(root(), 'mixed.tar.gz');
    await pipeline(pack, createWriteStream(archivePath));

    await expect(files.extractServerArchive(SERVER_ID, 'mixed.tar.gz', 'dest')).rejects.toMatchObject({
      code: 'bad_request',
    });

    // "Fails the whole extraction rather than writing anything past it" has to mean the
    // entries before it too, or a refused archive still leaves its payload on disk.
    expect(await readdir(path.join(root(), 'dest'))).toEqual([]);
    expect(await readdir(root())).not.toContain('evil.txt');
  });

  it('leaves no staging directory behind after a successful extract', async () => {
    await mkdir(path.join(root(), 'world'), { recursive: true });
    await writeFile(path.join(root(), 'world', 'level.dat'), 'level-data');
    await files.compressServerPaths(SERVER_ID, ['world'], 'clean.tar.gz');

    await files.extractServerArchive(SERVER_ID, 'clean.tar.gz', 'out');
    const remaining = await readdir(root());
    expect(remaining.every((name) => !name.startsWith('.platter-extract-'))).toBe(true);
  });
});

describe('symlinks are objects, not the things they point at', () => {
  it('deletes the link and leaves its target alone', async () => {
    await mkdir(path.join(root(), 'realdir'), { recursive: true });
    await writeFile(path.join(root(), 'realdir', 'keep.txt'), 'the world folder');
    await symlink(path.join(root(), 'realdir'), path.join(root(), 'link'), 'dir');

    const result = await files.deleteServerPaths(SERVER_ID, ['link']);
    expect(result.deleted).toEqual(['link']);

    // Deleting what the file list showed as a shortcut must not take the folder with it.
    expect(await readdir(root())).toContain('realdir');
    expect(await readdir(path.join(root(), 'realdir'))).toEqual(['keep.txt']);
    expect(await readdir(root())).not.toContain('link');
  });

  it('deletes a link whose target is outside the sandbox, without touching the target', async () => {
    const outside = path.join(workdir, 'outside-target');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'secret.txt'), 'not ours to delete');
    await symlink(outside, path.join(root(), 'escape'), 'dir');

    await files.deleteServerPaths(SERVER_ID, ['escape']);
    expect(await readdir(root())).not.toContain('escape');
    expect(await readdir(outside)).toEqual(['secret.txt']);
  });

  it('renames the link rather than moving its target', async () => {
    await mkdir(path.join(root(), 'realdir'), { recursive: true });
    await writeFile(path.join(root(), 'realdir', 'keep.txt'), 'the world folder');
    await symlink(path.join(root(), 'realdir'), path.join(root(), 'link'), 'dir');

    await files.renameServerPath(SERVER_ID, 'link', 'moved');

    const entries = await readdir(root());
    expect(entries).toContain('realdir');
    expect(entries).toContain('moved');
    expect(entries).not.toContain('link');
    expect(await readdir(path.join(root(), 'realdir'))).toEqual(['keep.txt']);
  });
});
