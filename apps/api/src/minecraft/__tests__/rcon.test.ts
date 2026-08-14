import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { PlatterError } from '@platter/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RCON_TYPE,
  RconConnection,
  RconPacketReader,
  closeAllRcon,
  encodeRconPacket,
  pooledRconCount,
  rconCommand,
  rconFailureOf,
} from '../rcon.js';

/**
 * The multi-packet case is the whole reason this client exists rather than a fifty-line
 * one, so it is tested against a real socket speaking the real framing — not against a
 * stub that hands back a string. The fake server below builds its packets with its own
 * encoder so a bug in `encodeRconPacket` cannot cancel itself out.
 */

/** Deliberately independent of the module under test. */
function frame(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf8');
  const buffer = Buffer.alloc(14 + payload.length);
  buffer.writeInt32LE(10 + payload.length, 0);
  buffer.writeInt32LE(id, 4);
  buffer.writeInt32LE(type, 8);
  payload.copy(buffer, 12);
  return buffer;
}

interface FakeRconOptions {
  password: string;
  respond?: (command: string) => string;
  /** Bytes per response packet. Source caps at 4096; smaller keeps the tests fast. */
  chunkBytes?: number;
  /** Skip the sentinel reply, the way a few modded builds do. */
  ignoreSentinel?: boolean;
}

interface FakeRcon {
  port: number;
  connections: number;
  commands: string[];
  close: () => Promise<void>;
}

async function startFakeRcon(options: FakeRconOptions): Promise<FakeRcon> {
  const chunkBytes = options.chunkBytes ?? 64;
  const state: FakeRcon = {
    port: 0,
    connections: 0,
    commands: [],
    close: async () => undefined,
  };

  const sockets = new Set<Socket>();
  const server: NetServer = createServer((socket) => {
    state.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);

    let authed = false;
    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 4) return;
        const length = buffer.readInt32LE(0);
        if (buffer.length < 4 + length) return;

        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const body = buffer.toString('utf8', 12, 4 + length - 2);
        buffer = buffer.subarray(4 + length);

        if (type === RCON_TYPE.auth) {
          // Source's own sequence: an empty response value, then the verdict.
          socket.write(frame(id, RCON_TYPE.response, ''));
          authed = body === options.password;
          socket.write(frame(authed ? id : -1, RCON_TYPE.command, ''));
          continue;
        }
        if (!authed) continue;

        if (type === RCON_TYPE.command) {
          state.commands.push(body);
          const output = options.respond?.(body) ?? '';
          if (output.length === 0) {
            socket.write(frame(id, RCON_TYPE.response, ''));
            continue;
          }
          for (let offset = 0; offset < output.length; offset += chunkBytes) {
            socket.write(frame(id, RCON_TYPE.response, output.slice(offset, offset + chunkBytes)));
          }
          continue;
        }

        // Anything else is the sentinel. Minecraft answers "Unknown request <hex>".
        if (!options.ignoreSentinel) {
          socket.write(frame(id, RCON_TYPE.response, `Unknown request ${type.toString(16)}`));
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');
  state.port = address.port;
  state.close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return state;
}

const servers: FakeRcon[] = [];

async function fakeRcon(options: FakeRconOptions): Promise<FakeRcon> {
  const server = await startFakeRcon(options);
  servers.push(server);
  return server;
}

afterEach(async () => {
  closeAllRcon();
  while (servers.length > 0) await servers.pop()?.close();
});

describe('packet framing', () => {
  it('round-trips a packet', () => {
    const encoded = encodeRconPacket({ id: 7, type: RCON_TYPE.command, body: 'whitelist list' });
    const [packet] = new RconPacketReader().push(encoded);

    expect(packet).toEqual({ id: 7, type: RCON_TYPE.command, body: 'whitelist list' });
    // 4 length + 4 id + 4 type + body + 2 terminators.
    expect(encoded).toHaveLength(14 + 'whitelist list'.length);
    expect(encoded.readInt32LE(0)).toBe(10 + 'whitelist list'.length);
  });

  it('round-trips an empty body', () => {
    const [packet] = new RconPacketReader().push(
      encodeRconPacket({ id: -1, type: RCON_TYPE.response, body: '' }),
    );
    expect(packet).toEqual({ id: -1, type: RCON_TYPE.response, body: '' });
  });

  it('round-trips multi-byte UTF-8', () => {
    const body = '§aAlice ✦ joined';
    const [packet] = new RconPacketReader().push(
      encodeRconPacket({ id: 3, type: RCON_TYPE.response, body }),
    );
    expect(packet?.body).toBe(body);
  });

  it('reassembles a packet split across chunk boundaries', () => {
    const reader = new RconPacketReader();
    const encoded = encodeRconPacket({ id: 1, type: RCON_TYPE.response, body: 'hello world' });

    // Split inside the header, then inside the body: both are real TCP outcomes.
    expect(reader.push(encoded.subarray(0, 6))).toHaveLength(0);
    expect(reader.push(encoded.subarray(6, 15))).toHaveLength(0);
    expect(reader.push(encoded.subarray(15))).toEqual([
      { id: 1, type: RCON_TYPE.response, body: 'hello world' },
    ]);
    expect(reader.buffered).toBe(0);
  });

  it('reads several packets out of one chunk and keeps the remainder', () => {
    const reader = new RconPacketReader();
    const first = encodeRconPacket({ id: 1, type: RCON_TYPE.response, body: 'one' });
    const second = encodeRconPacket({ id: 2, type: RCON_TYPE.response, body: 'two' });
    const third = encodeRconPacket({ id: 3, type: RCON_TYPE.response, body: 'three' });

    const packets = reader.push(Buffer.concat([first, second, third.subarray(0, 5)]));
    expect(packets.map((packet) => packet.body)).toEqual(['one', 'two']);
    expect(reader.buffered).toBe(5);
    expect(reader.push(third.subarray(5)).map((packet) => packet.body)).toEqual(['three']);
  });

  it('refuses a frame whose declared length is impossible', () => {
    const reader = new RconPacketReader();
    const bogus = Buffer.alloc(16);
    bogus.writeInt32LE(4, 0);
    expect(() => reader.push(bogus)).toThrow(PlatterError);
  });
});

describe('commands', () => {
  it('reassembles a response split across several packets', async () => {
    // 40 lines of a name list: comfortably past one packet at the chunk size above, which
    // is the case a naive client silently truncates.
    const expected = Array.from({ length: 40 }, (_, index) => `Player${index}`).join(', ');
    const server = await fakeRcon({ password: 'secret', respond: () => expected });

    const output = await rconCommand(
      { host: '127.0.0.1', port: server.port, password: 'secret' },
      'list',
      { key: 'srv_multi' },
    );

    expect(output).toBe(expected);
    expect(output.length).toBeGreaterThan(64);
    expect(server.commands).toEqual(['list']);
  });

  it("keeps one command's packets out of the next command's answer", async () => {
    const server = await fakeRcon({
      password: 'secret',
      respond: (command) => `echo:${command}`,
      chunkBytes: 4,
    });
    const endpoint = { host: '127.0.0.1', port: server.port, password: 'secret' };

    const outputs = await Promise.all([
      rconCommand(endpoint, 'first', { key: 'srv_seq' }),
      rconCommand(endpoint, 'second', { key: 'srv_seq' }),
      rconCommand(endpoint, 'third', { key: 'srv_seq' }),
    ]);

    expect(outputs).toEqual(['echo:first', 'echo:second', 'echo:third']);
    expect(server.commands).toEqual(['first', 'second', 'third']);
  });

  it('returns what arrived when the server never answers the sentinel', async () => {
    const server = await fakeRcon({
      password: 'secret',
      respond: () => 'partial output',
      ignoreSentinel: true,
    });

    const output = await rconCommand(
      { host: '127.0.0.1', port: server.port, password: 'secret' },
      'list',
      { key: 'srv_nosentinel', commandTimeoutMs: 200 },
    );
    expect(output).toBe('partial output');
  });

  it('reuses one connection across commands and closes it on demand', async () => {
    const server = await fakeRcon({ password: 'secret', respond: () => 'ok' });
    const endpoint = { host: '127.0.0.1', port: server.port, password: 'secret' };

    await rconCommand(endpoint, 'one', { key: 'srv_pool' });
    await rconCommand(endpoint, 'two', { key: 'srv_pool' });

    expect(server.connections).toBe(1);
    expect(pooledRconCount()).toBe(1);

    closeAllRcon();
    expect(pooledRconCount()).toBe(0);
  });
});

describe('failures', () => {
  it('distinguishes a rejected password from an unreachable host', async () => {
    const server = await fakeRcon({ password: 'secret' });

    const authFailure = await rconCommand(
      { host: '127.0.0.1', port: server.port, password: 'wrong' },
      'list',
      { key: 'srv_auth' },
    ).catch((error: unknown) => error);

    expect(authFailure).toBeInstanceOf(PlatterError);
    expect(rconFailureOf(authFailure)).toBe('auth_failed');
    // A misconfiguration, not a hiccup: nothing should retry it on a timer.
    expect((authFailure as PlatterError).retryable).toBe(false);

    await server.close();
    servers.length = 0;

    const unreachable = await rconCommand(
      { host: '127.0.0.1', port: server.port, password: 'secret' },
      'list',
      { key: 'srv_down' },
    ).catch((error: unknown) => error);

    expect(rconFailureOf(unreachable)).toBe('unreachable');
    expect((unreachable as PlatterError).retryable).toBe(true);
  });

  it('never puts the password in the error a caller sees', async () => {
    const server = await fakeRcon({ password: 'secret' });
    const password = 'hunter2-should-never-appear';

    const error = await rconCommand({ host: '127.0.0.1', port: server.port, password }, 'list', {
      key: 'srv_redact',
      label: 'Survival',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatterError);
    expect(JSON.stringify((error as PlatterError).toBody())).not.toContain(password);
    expect((error as PlatterError).message).toContain('Survival');
  });

  it('times out rather than hanging when nothing answers', async () => {
    // A listening socket that never replies is exactly what a wedged server looks like.
    const accepted = new Set<Socket>();
    const silent = createServer((socket) => {
      accepted.add(socket);
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const address = silent.address();
    if (address === null || typeof address === 'string') throw new Error('no port assigned');

    const connection = new RconConnection(
      { host: '127.0.0.1', port: address.port, password: 'secret' },
      { connectTimeoutMs: 150, commandTimeoutMs: 150 },
    );
    const error = await connection.command('list').catch((caught: unknown) => caught);

    expect(rconFailureOf(error)).toBe('timeout');
    connection.close();
    // A server socket nobody ever read from stays paused and never notices the peer went
    // away, so `close()` would wait for it forever.
    for (const socket of accepted) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  });
});
