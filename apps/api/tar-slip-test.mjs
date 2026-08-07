import { create, list, extract } from 'tar';
import path from 'node:path';
import fs from 'node:fs/promises';

// Build a malicious archive: entries that try to escape via absolute path and via '..'
await fs.rm('/tmp/tartest/evilsrc', { recursive: true, force: true });
await fs.mkdir('/tmp/tartest/evilsrc/nested', { recursive: true });
await fs.writeFile('/tmp/tartest/evilsrc/nested/evil.txt', 'pwned');

// Create archive with preservePaths so headers keep a path like '../evil.txt'
await create({ gzip: false, cwd: '/tmp/tartest/evilsrc', file: '/tmp/tartest/evil.tar', preservePaths: true, portable: true }, ['nested/evil.txt']);

// Now rewrite it: actually let's just directly create with a path containing '..' by using absolute prefix trick:
// simplest: create archive from a dir structure that itself is named '..' -- not simple either.
// Instead let's use pack.add with explicit path override via 'sync' pack? Try alternate: use tar's Pack class directly.
import { Pack } from 'tar';
const pack = new Pack({ cwd: '/tmp/tartest/evilsrc', preservePaths: true, portable: true });
const chunks = [];
pack.on('data', (c) => chunks.push(c));
const done = new Promise((resolve) => pack.on('end', resolve));
pack.write('../../../etc/passwd-fake'); // this depends on internal API; may not work directly
pack.end();
await done;
await fs.writeFile('/tmp/tartest/evil2.tar', Buffer.concat(chunks));

console.log('--- list evil2 ---');
try {
  await list({ file: '/tmp/tartest/evil2.tar', onReadEntry: (e) => console.log('entry', e.path, e.type) });
} catch (e) { console.log('list error', e.message); }

const destDir = '/tmp/tartest/evildest';
await fs.rm(destDir, { recursive: true, force: true });
await fs.mkdir(destDir, { recursive: true });
try {
  await extract({ file: '/tmp/tartest/evil2.tar', cwd: destDir, onwarn: (code, msg) => console.log('WARN', code, msg) });
} catch (e) { console.log('extract error', e.message); }
console.log('dest contents:', await fs.readdir(destDir, { recursive: true }).catch(() => []));
console.log('did escape happen?', await fs.stat('/tmp/etc-passwd-fake').then(() => true, () => false));
