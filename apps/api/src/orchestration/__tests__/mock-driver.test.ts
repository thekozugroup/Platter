import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, PlatterError } from '@platter/shared';
import { LogDecoder, parseDockerEndpoint } from '../docker.js';
import type { ContainerSpec, DriverLogLine, LogStreamOptions } from '../driver.js';
import { getLogHub, resetLogHubs, type LogHub } from '../log-buffer.js';
import { MockDriver, isMockDriver } from '../mock.js';

const SERVER_ID = 'srv_01TESTSERVER0000000000000';

function specFor(dataHostPath: string, overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    serverId: SERVER_ID,
    name: 'Survival SMP',
    image: 'itzg/minecraft-server:latest',
    command: null,
    env: { EULA: 'TRUE' },
    dataHostPath,
    dataPath: '/data',
    ports: [{ hostIp: '0.0.0.0', hostPort: 25565, containerPort: 25565, protocol: 'tcp' }],
    limits: { memoryMb: 2048, swapMb: 0, cpuCores: 2, ioWeight: 500, pidsLimit: 512 },
    labels: { 'platter.managed': 'true' },
    interactive: true,
    ...overrides,
  };
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function collect(
  driver: MockDriver,
  options: LogStreamOptions = {},
): Promise<DriverLogLine[]> {
  const lines: DriverLogLine[] = [];
  for await (const line of driver.streamLogs(SERVER_ID, options)) lines.push(line);
  return lines;
}

describe('MockDriver', () => {
  let dataDir: string;
  let driver: MockDriver;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'platter-mock-'));
    driver = new MockDriver({ nodeId: 'nod_01TESTNODE00000000000000', autoTick: false });
  });

  afterEach(async () => {
    driver.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('reports an absent container rather than throwing', async () => {
    const state = await driver.inspect(SERVER_ID);
    expect(state).toMatchObject({ exists: false, running: false, id: null });
  });

  it('refuses a second container for the same server', async () => {
    await driver.create(specFor(dataDir));
    await expect(driver.create(specFor(dataDir))).rejects.toMatchObject({ code: 'conflict' });
  });

  it('replaces the container on recreate', async () => {
    const first = await driver.create(specFor(dataDir));
    const second = await driver.recreate(specFor(dataDir));
    expect(second).not.toBe(first);
    expect((await driver.inspect(SERVER_ID)).id).toBe(second);
  });

  it('boots, reports usage while running, and stops cleanly', async () => {
    await driver.create(specFor(dataDir));
    expect(await driver.usage(SERVER_ID)).toBeNull();

    await driver.start(SERVER_ID);
    const started = await driver.inspect(SERVER_ID);
    expect(started).toMatchObject({ exists: true, running: true, state: 'running' });

    driver.advance(4000);
    const usage = await driver.usage(SERVER_ID);
    expect(usage).not.toBeNull();
    expect(usage?.memoryLimitBytes).toBe(2048 * 1024 * 1024);
    expect(usage?.cpuPercent).toBeGreaterThan(0);
    expect(usage?.memoryBytes).toBeLessThan(usage?.memoryLimitBytes ?? 0);

    await driver.stop(SERVER_ID, { signal: 'SIGTERM', timeoutSeconds: 30 });
    const stopped = await driver.inspect(SERVER_ID);
    expect(stopped).toMatchObject({ running: false, exitCode: 0, state: 'exited' });
    expect(await driver.usage(SERVER_ID)).toBeNull();
  });

  it('escalates to a kill when the stop timeout is shorter than the shutdown', async () => {
    const slow = new MockDriver({ nodeId: 'nod_x', autoTick: false, stopDelayMs: 10_000 });
    await slow.create(specFor(dataDir));
    await slow.start(SERVER_ID);
    await slow.stop(SERVER_ID, { signal: 'SIGTERM', timeoutSeconds: 1 });
    expect((await slow.inspect(SERVER_ID)).exitCode).toBe(137);
    slow.dispose();
  });

  it('treats start, kill and remove as idempotent', async () => {
    await driver.create(specFor(dataDir));
    await driver.start(SERVER_ID);
    await driver.start(SERVER_ID);
    await driver.kill(SERVER_ID);
    await driver.kill(SERVER_ID);
    expect((await driver.inspect(SERVER_ID)).exitCode).toBe(137);

    await driver.remove(SERVER_ID);
    await driver.remove(SERVER_ID);
    expect((await driver.inspect(SERVER_ID)).exists).toBe(false);
  });

  it('fails on demand so error paths can be tested', async () => {
    await driver.create(specFor(dataDir));
    driver.failNext('start');
    await expect(driver.start(SERVER_ID)).rejects.toBeInstanceOf(PlatterError);
    // Only the next call: the queued failure is consumed, not sticky.
    await driver.start(SERVER_ID);
    expect((await driver.inspect(SERVER_ID)).running).toBe(true);
  });

  it('streams boot output and ends the stream when the container exits', async () => {
    await driver.create(specFor(dataDir));
    await driver.start(SERVER_ID);

    const collected = collect(driver);
    driver.advance(5000);
    await driver.kill(SERVER_ID);

    const lines = await collected;
    expect(lines.map((line) => line.content)).toContain('[Server thread/INFO]: Starting server');
    expect(lines.some((line) => /Done \(/.test(line.content))).toBe(true);
  });

  it('ends a stream on abort without ending the container', async () => {
    await driver.create(specFor(dataDir));
    await driver.start(SERVER_ID);

    const controller = new AbortController();
    const collected = collect(driver, { signal: controller.signal });
    driver.advance(1000);
    controller.abort();

    await expect(collected).resolves.toBeInstanceOf(Array);
    expect((await driver.inspect(SERVER_ID)).running).toBe(true);
  });

  it('accepts stdin only for an interactive, running container', async () => {
    await driver.create(specFor(dataDir, { interactive: false }));
    await driver.start(SERVER_ID);
    await expect(driver.writeStdin(SERVER_ID, 'stop')).rejects.toMatchObject({ code: 'conflict' });

    await driver.recreate(specFor(dataDir));
    await expect(driver.writeStdin(SERVER_ID, 'stop')).rejects.toMatchObject({ code: 'conflict' });
    await driver.start(SERVER_ID);
    await driver.writeStdin(SERVER_ID, 'say hello');
    expect(driver.stdinWrites).toEqual([{ serverId: SERVER_ID, line: 'say hello' }]);
  });

  it('runs exec through a registered handler', async () => {
    await driver.create(specFor(dataDir));
    await driver.start(SERVER_ID);
    driver.onExec((command) => ({ exitCode: 0, stdout: command.join(' '), stderr: '' }));
    await expect(driver.exec(SERVER_ID, ['ls', '-la'])).resolves.toEqual({
      exitCode: 0,
      stdout: 'ls -la',
      stderr: '',
    });
  });

  it('measures and archives the real data directory', async () => {
    await writeFile(path.join(dataDir, 'server.properties'), 'motd=hello\n', 'utf8');
    await driver.create(specFor(dataDir));

    expect(await driver.diskUsage(SERVER_ID)).toBe(11);

    const archive = await driver.archivePath(SERVER_ID, '/data');
    const chunks: Buffer[] = [];
    for await (const chunk of archive) chunks.push(Buffer.from(chunk));
    const tar = Buffer.concat(chunks);
    // A real tar: the ustar magic sits at offset 257 of the first header block.
    expect(tar.subarray(257, 262).toString('ascii')).toBe('ustar');
  });

  it('reports its health and its managed containers', async () => {
    await driver.create(specFor(dataDir));
    await driver.start(SERVER_ID);
    await expect(driver.health()).resolves.toMatchObject({ reachable: true, containersRunning: 1 });

    driver.setReachable(false);
    const down = await driver.health();
    expect(down.reachable).toBe(false);
    expect(down.error).not.toBeNull();

    await expect(driver.listOrphans()).resolves.toEqual([
      { serverId: SERVER_ID, containerId: expect.any(String) },
    ]);
  });

  it('narrows through isMockDriver', () => {
    expect(isMockDriver(driver)).toBe(true);
  });
});

/** Counts driver streams so fan-out can be asserted rather than assumed. */
class CountingDriver extends MockDriver {
  openedStreams = 0;

  override streamLogs(serverId: string, options: LogStreamOptions = {}): AsyncIterable<DriverLogLine> {
    this.openedStreams += 1;
    return super.streamLogs(serverId, options);
  }
}

describe('LogHub', () => {
  let dataDir: string;
  let driver: CountingDriver;
  let hub: LogHub;

  beforeEach(async () => {
    resetLogHubs();
    dataDir = await mkdtemp(path.join(tmpdir(), 'platter-hub-'));
    driver = new CountingDriver({ nodeId: 'nod_01TESTNODE00000000000000', autoTick: false });
    hub = getLogHub(SERVER_ID);
  });

  afterEach(async () => {
    resetLogHubs();
    driver.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('returns the same hub for a server and drops it on demand', () => {
    expect(getLogHub(SERVER_ID)).toBe(hub);
    resetLogHubs();
    expect(getLogHub(SERVER_ID)).not.toBe(hub);
  });

  it('keeps a bounded ring with monotonic sequence numbers', () => {
    for (let index = 0; index < LIMITS.consoleScrollback + 100; index += 1) {
      hub.append({ stream: 'stdout', content: `line ${index}` });
    }
    const backlog = hub.backlog(10_000);
    expect(backlog).toHaveLength(LIMITS.consoleScrollback);
    expect(backlog[0]?.seq).toBe(101);
    expect(backlog.at(-1)?.seq).toBe(LIMITS.consoleScrollback + 100);
    expect(backlog.at(-1)?.content).toBe(`line ${LIMITS.consoleScrollback + 99}`);
  });

  it('truncates a line past the console limit', () => {
    const line = hub.append({ stream: 'stdout', content: 'x'.repeat(LIMITS.maxConsoleLineLength + 50) });
    expect(line.content).toHaveLength(LIMITS.maxConsoleLineLength + 1);
    expect(line.content.endsWith('…')).toBe(true);
  });

  it('fans one driver stream out to every subscriber and tears it down with the last', async () => {
    await driver.create(specFor(dataDir));
    await driver.start(SERVER_ID);

    const first: string[] = [];
    const second: string[] = [];
    const readyLines: string[] = [];

    const unsubscribeFirst = hub.subscribe((event) => {
      if (event.type === 'line') first.push(event.line.content);
      if (event.type === 'ready') readyLines.push(event.line.content);
    });
    const unsubscribeSecond = hub.subscribe((event) => {
      if (event.type === 'line') second.push(event.line.content);
    });

    hub.attach({ driver, signals: { ready: ['Done \\('], crash: ['\\bFATAL\\b'], playerJoin: [], playerLeave: [] } });
    // A second attach must join the existing stream, not open another one.
    hub.attach({ driver });

    driver.advance(5000);
    await waitUntil(() => readyLines.length > 0, 'the ready signal');

    expect(driver.openedStreams).toBe(1);
    expect(hub.subscriberCount).toBe(2);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(1);

    unsubscribeFirst();
    expect(hub.attached).toBe(true);

    unsubscribeSecond();
    // The last subscriber leaving is what releases the driver stream.
    expect(hub.attached).toBe(false);
    expect(hub.subscriberCount).toBe(0);
  });

  it('emits ready once and crash on every match, ignoring its own system lines', () => {
    const events: string[] = [];
    hub.subscribe((event) => {
      if (event.type !== 'line') events.push(event.type);
    });
    hub.attach({
      driver,
      signals: { ready: ['Done'], crash: ['Crashed'], playerJoin: [], playerLeave: [] },
    });

    hub.append({ stream: 'stdout', content: 'Done (1.2s)!' });
    hub.append({ stream: 'stdout', content: 'Done again' });
    hub.append({ stream: 'stderr', content: 'Crashed hard' });
    hub.append({ stream: 'stderr', content: 'Crashed again' });
    hub.system('Crashed — this is our own annotation');
    hub.emitStatus('crashed', 1);

    expect(events).toEqual(['ready', 'crash', 'crash', 'status']);
  });

  it('survives a listener that throws', () => {
    const seen: number[] = [];
    hub.subscribe(() => {
      throw new Error('bad listener');
    });
    hub.subscribe((event) => {
      if (event.type === 'line') seen.push(event.line.seq);
    });
    hub.append({ stream: 'stdout', content: 'still delivered' });
    expect(seen).toEqual([1]);
  });
});

/**
 * The frame decoder is the one part of the Docker driver that can be tested without a
 * daemon, and it is also the part most likely to be wrong: everything below is a chunk
 * boundary that a real stream will eventually produce.
 */
describe('LogDecoder', () => {
  const STAMP = '2024-05-06T07:08:09.123456789Z';

  function frame(type: 1 | 2, payload: string | Buffer): Buffer {
    const body = Buffer.from(payload);
    const header = Buffer.alloc(8);
    header.writeUInt8(type, 0);
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
  }

  it('demultiplexes stdout and stderr and strips the timestamp', () => {
    const decoder = new LogDecoder(false);
    const lines = decoder.push(
      Buffer.concat([frame(1, `${STAMP} hello\n`), frame(2, `${STAMP} boom\n`)]),
    );
    expect(lines).toEqual([
      { stream: 'stdout', content: 'hello', timestamp: new Date(Date.parse(STAMP)) },
      { stream: 'stderr', content: 'boom', timestamp: new Date(Date.parse(STAMP)) },
    ]);
  });

  it('buffers a header split across two reads', () => {
    const decoder = new LogDecoder(false);
    const whole = frame(1, `${STAMP} split header\n`);
    expect(decoder.push(whole.subarray(0, 5))).toEqual([]);
    expect(decoder.push(whole.subarray(5)).map((line) => line.content)).toEqual(['split header']);
  });

  it('buffers a payload split across two reads', () => {
    const decoder = new LogDecoder(false);
    const whole = frame(1, `${STAMP} split payload\n`);
    expect(decoder.push(whole.subarray(0, 12))).toEqual([]);
    expect(decoder.push(whole.subarray(12)).map((line) => line.content)).toEqual(['split payload']);
  });

  it('emits every line in a frame that carries several', () => {
    const decoder = new LogDecoder(false);
    const payload = `${STAMP} one\n${STAMP} two\n${STAMP} three\n`;
    expect(decoder.push(frame(1, payload)).map((line) => line.content)).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  it('holds a partial line until the rest arrives, and flushes what is left', () => {
    const decoder = new LogDecoder(false);
    expect(decoder.push(frame(1, `${STAMP} half`))).toEqual([]);
    expect(decoder.push(frame(1, ' a line\n')).map((line) => line.content)).toEqual(['half a line']);

    expect(decoder.push(frame(1, `${STAMP} no newline`))).toEqual([]);
    expect(decoder.flush().map((line) => line.content)).toEqual(['no newline']);
  });

  it('keeps a multi-byte character whole across a frame boundary', () => {
    const decoder = new LogDecoder(false);
    const cafe = Buffer.from('café', 'utf8');
    expect(decoder.push(frame(1, Buffer.concat([Buffer.from(`${STAMP} `), cafe.subarray(0, 4)])))).toEqual([]);
    const lines = decoder.push(frame(1, Buffer.concat([cafe.subarray(4), Buffer.from('\n')])));
    expect(lines.map((line) => line.content)).toEqual(['café']);
  });

  it('treats a TTY stream as unframed stdout', () => {
    const decoder = new LogDecoder(true);
    const lines = decoder.push(Buffer.from(`${STAMP} tty line\r\n`));
    expect(lines).toEqual([
      { stream: 'stdout', content: 'tty line', timestamp: new Date(Date.parse(STAMP)) },
    ]);
  });

  it('keeps a line that carries no timestamp', () => {
    const decoder = new LogDecoder(false);
    const lines = decoder.push(frame(1, 'unstamped output\n'));
    expect(lines[0]?.content).toBe('unstamped output');
  });
});

describe('parseDockerEndpoint', () => {
  it('reads socket paths, unix urls and tcp endpoints', () => {
    expect(parseDockerEndpoint('/var/run/docker.sock')).toEqual({
      socketPath: '/var/run/docker.sock',
    });
    expect(parseDockerEndpoint('unix:///run/docker.sock')).toEqual({
      socketPath: '/run/docker.sock',
    });
    expect(parseDockerEndpoint('tcp://10.0.0.4:2375')).toEqual({
      host: '10.0.0.4',
      port: 2375,
      protocol: 'http',
    });
    expect(parseDockerEndpoint('https://node.internal')).toEqual({
      host: 'node.internal',
      port: 2376,
      protocol: 'https',
    });
  });
});
