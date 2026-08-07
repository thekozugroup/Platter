import { list, extract } from 'tar';
import fs from 'node:fs/promises';

function buildTarSymlink(name, linkname) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'ascii');
  header.write('000644\0', 100, 7, 'ascii');
  header.write('000000\0', 108, 7, 'ascii');
  header.write('000000\0', 116, 7, 'ascii');
  header.write('00000000000\0', 124, 12, 'ascii'); // size 0 for symlink
  const mtimeOctal = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0';
  header.write(mtimeOctal, 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii');
  header.write('2', 156, 1, 'ascii'); // typeflag '2' = symlink
  header.write(linkname, 157, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of header) sum += b;
  const checksumStr = sum.toString(8).padStart(6, '0') + '\0 ';
  header.write(checksumStr, 148, 8, 'ascii');
  const endBlocks = Buffer.alloc(1024);
  return Buffer.concat([header, endBlocks]);
}

const t = buildTarSymlink('escape-link', '../../../etc');
await fs.writeFile('/tmp/tartest/symlink.tar', t);
await list({ file: '/tmp/tartest/symlink.tar', onReadEntry: (e) => console.log('entry', JSON.stringify(e.path), e.type, 'linkpath=', JSON.stringify(e.linkpath)) });

const destDir = '/tmp/tartest/symdest';
await fs.rm(destDir, { recursive: true, force: true });
await fs.mkdir(destDir, { recursive: true });
await extract({ file: '/tmp/tartest/symlink.tar', cwd: destDir, onwarn: (c,m) => console.log('WARN', c, m) });
console.log('dest:', await fs.readdir(destDir));
try {
  const target = await fs.readlink(`${destDir}/escape-link`);
  console.log('symlink target:', target);
} catch (e) { console.log('no symlink created:', e.message); }
