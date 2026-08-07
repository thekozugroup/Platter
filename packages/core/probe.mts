import Docker from 'dockerode';
import { readLogTail, streamLogs } from './src/docker/logs';
import { readStats } from './src/docker/stats';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const id = process.argv[2]!;

const t0 = Date.now();
const tail = await readLogTail(docker, id, 10);
console.log('readLogTail ok=', tail.ok, 'ms=', Date.now() - t0);
if (tail.ok) for (const l of tail.value.slice(-3)) console.log(JSON.stringify(l));

const s = await readStats(docker, id);
console.log('stats ok=', s.ok, s.ok ? JSON.stringify(s.value) : (s as any).error.message);

// follow with abort: does the socket close?
const ac = new AbortController();
const st = await streamLogs(docker, id, { follow: true, tail: 2, signal: ac.signal });
console.log('follow ok=', st.ok);
if (st.ok) {
  let n = 0;
  const it = st.value;
  const to = setTimeout(() => ac.abort(), 1500);
  try {
    for await (const l of it) { n++; if (n > 200) break; }
  } catch (e) { console.log('follow generator threw:', String(e)); }
  clearTimeout(to);
  console.log('follow lines', n);
}
// pre-aborted signal
const ac2 = new AbortController();
ac2.abort();
const st2 = await streamLogs(docker, id, { follow: true, tail: 1, signal: ac2.signal });
console.log('pre-aborted stream ok=', st2.ok);
setTimeout(() => { console.log('handles', (process as any)._getActiveHandles?.().length); process.exit(0); }, 2000);
