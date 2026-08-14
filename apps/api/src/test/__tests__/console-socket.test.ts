import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WS_CLOSE } from '@platter/shared';
import { prisma } from '../../db.js';
import {
  buildTestApp,
  closeTestHarness,
  createTestUser,
  ensureTestNode,
  resetDatabase,
} from '../helpers.js';

/**
 * The console handshake, over a real socket.
 *
 * The regression: `handleAuth` awaits three times — token verification, access resolution,
 * the log stream — and never re-checked whether the peer had gone in the meantime. `close`
 * runs `shutdown`, which releases what has been taken *so far*; the handshake then resumed
 * and took more. The per-user connection counter was incremented after `shutdown` had
 * already declined to decrement it, so a handful of flaky handshakes locked the user out of
 * every console in the installation with `4429 too many open consoles`.
 */

let app: FastifyInstance;
let baseUrl: string;
let token: string;
let serverId: string;

beforeAll(async () => {
  await resetDatabase();
  app = await buildTestApp();
  // A real port: `app.inject` cannot upgrade a connection.
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('expected a TCP address');
  baseUrl = `ws://127.0.0.1:${address.port}`;

  const nodeId = await ensureTestNode();
  const owner = await createTestUser('owner');
  token = owner.accessToken;
  serverId = 'srv_console_test';
  await prisma.server.create({
    data: {
      id: serverId,
      name: 'Console Test',
      blueprintKey: 'minecraft-java',
      nodeId,
      ownerId: owner.id,
      status: 'offline',
      memoryMb: 1024,
      diskMb: 2048,
      cpuCores: 0,
    },
  });
});

afterAll(async () => {
  await app.close();
  await resetDatabase();
  await closeTestHarness();
});

function open(): WebSocket {
  return new WebSocket(`${baseUrl}/ws/servers/${serverId}/console`);
}

/** Sends the auth frame and drops the socket in the same tick — an aborted handshake. */
async function abortedHandshake(): Promise<void> {
  const socket = open();
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('socket errored')), { once: true });
  });
  socket.send(JSON.stringify({ type: 'auth', token }));
  socket.close();
  await new Promise<void>((resolve) => {
    socket.addEventListener('close', () => resolve(), { once: true });
  });
}

describe('console socket handshake', () => {
  it('does not burn a connection slot when the peer goes away mid-handshake', async () => {
    // Comfortably past MAX_SOCKETS_PER_USER (8): not every abort lands inside an await,
    // so the count is deliberately generous rather than exactly eight.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await abortedHandshake();
    }

    const socket = open();
    const outcome = await new Promise<{ ready: boolean; code: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no answer from the console socket')), 5000);
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'auth', token })));
      socket.addEventListener('message', (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as { type: string };
        if (message.type !== 'ready') return;
        clearTimeout(timer);
        resolve({ ready: true, code: 0 });
        socket.close();
      });
      socket.addEventListener('close', (event: CloseEvent) => {
        clearTimeout(timer);
        resolve({ ready: false, code: event.code });
      });
    });

    expect(outcome.code).not.toBe(WS_CLOSE.tooManyConnections);
    expect(outcome.ready).toBe(true);
  });
});
