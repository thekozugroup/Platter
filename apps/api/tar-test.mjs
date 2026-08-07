import { create, list, extract } from 'tar';
import path from 'node:path';
import fs from 'node:fs/promises';

const src = '/tmp/tartest/src';
const archive = '/tmp/tartest/out.tar.gz';

await create({ gzip: true, cwd: src, file: archive, filter: (p, stat) => {
  console.log('filter saw path:', JSON.stringify(p), stat.isDirectory() ? 'dir' : 'file');
  return !p.endsWith('.log');
}}, ['.']);

console.log('--- listing ---');
await list({ file: archive, onReadEntry: (e) => console.log('entry:', e.path, e.type) });

console.log('--- extract test (zip slip) ---');
// build a malicious tar manually is hard; instead test 'preservePaths' default with a path containing ..
const destDir = '/tmp/tartest/dest';
await fs.rm(destDir, { recursive: true, force: true });
await fs.mkdir(destDir, { recursive: true });
await extract({ file: archive, cwd: destDir });
console.log(await fs.readdir(destDir, { recursive: true }));
