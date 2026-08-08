import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { probeAddress } from '../probe.js';

/**
 * Not in the file-ownership list alongside `hostname.test.ts`/`zone.test.ts`, but the
 * task's own "Tests" section explicitly asks for "probe reports a closed port as closed"
 * and this only exercises a file this handover owns (`probe.ts`), so it lives here rather
 * than going unwritten.
 */

/** An unused port, found the only way that is not a guess: by asking the kernel for one. */
async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('no port assigned')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

describe('probeAddress', () => {
  it('reports a closed TCP port as unreachable', async () => {
    const port = await freePort();

    const result = await probeAddress({
      host: '127.0.0.1',
      port,
      protocol: 'tcp',
      isLocalNode: false,
      timeoutMs: 500,
    });

    expect(result.connected).toBe(false);
    expect(result.reachability).toBe('unreachable');
  });

  it('reports a listening TCP port as reachable on the LAN', async () => {
    const server = createServer((socket) => socket.end());
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });

    try {
      const result = await probeAddress({
        host: '127.0.0.1',
        port,
        protocol: 'tcp',
        isLocalNode: false,
        timeoutMs: 500,
      });
      expect(result.connected).toBe(true);
      expect(result.reachability).toBe('lan');
    } finally {
      server.close();
    }
  });

  it('reports both the local bind result and a real connect for a local node', async () => {
    const server = createServer((socket) => socket.end());
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '0.0.0.0', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });

    try {
      const result = await probeAddress({
        host: '127.0.0.1',
        port,
        protocol: 'tcp',
        isLocalNode: true,
        timeoutMs: 500,
      });
      // Being bound is not by itself the answer — `reachability` only reaches `lan` once
      // the actual connect test (below) also succeeds, not from the bind test alone.
      expect(result.listening).toBe(true);
      expect(result.connected).toBe(true);
      expect(result.reachability).toBe('lan');
    } finally {
      server.close();
    }
  });

  it('reports a free port as not listening when the node is local', async () => {
    const port = await freePort();

    const result = await probeAddress({
      host: '127.0.0.1',
      port,
      protocol: 'tcp',
      isLocalNode: true,
      timeoutMs: 500,
    });

    expect(result.listening).toBe(false);
    expect(result.connected).toBe(false);
    expect(result.reachability).toBe('unreachable');
  });
});
