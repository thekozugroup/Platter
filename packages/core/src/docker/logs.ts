import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { attempt, fail, ok, type Result } from '@platter/shared';
import type Docker from 'dockerode';

/**
 * Container log streaming.
 *
 * Docker multiplexes stdout and stderr over one connection with an 8-byte header per frame
 * (stream type, three reserved bytes, then a big-endian length). dockerode exposes
 * `modem.demuxStream`, but it writes into two `Writable`s and gives you no line framing — and
 * frames split mid-line constantly, so naive per-chunk handling produces log lines chopped at
 * arbitrary byte offsets. That looks like corruption in the console and, worse, breaks the
 * diagnosis engine's regexes.
 *
 * This module therefore does its own demux and its own line assembly, keeping a partial-line
 * buffer across chunks.
 */

export interface LogLine {
  /** Monotonic within a stream. Lets the browser resume without duplicates. */
  seq: number;
  stream: 'stdout' | 'stderr';
  /** Docker's timestamp, when requested. Epoch milliseconds. */
  timestamp: number | undefined;
  text: string;
}

const HEADER_SIZE = 8;

/**
 * Split a Docker multiplexed stream into whole lines.
 *
 * Returned as an async generator so back-pressure works: if the browser stops reading the SSE
 * response, the generator stops being pulled, the socket's read buffer fills, and Docker slows
 * down. Push-based designs here end up buffering an unbounded crash loop in memory.
 */
export async function* demuxLines(
  source: Readable,
  options: { withTimestamps?: boolean; startSeq?: number } = {}
): AsyncGenerator<LogLine> {
  let seq = options.startSeq ?? 0;
  let buffer = Buffer.alloc(0);
  // Partial line carried across frames, per stream.
  const partial: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  /*
   * A UTF-8 character can straddle a frame boundary — Docker splits by bytes, not codepoints.
   * Decoding each frame independently turns a multi-byte character into replacement glyphs, so
   * a MOTD with an accent or a player name with a non-Latin script arrives corrupted. A
   * StringDecoder per stream holds the incomplete trailing bytes until the rest arrives.
   */
  const decoder: Record<'stdout' | 'stderr', StringDecoder> = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  };

  for await (const chunk of source) {
    buffer = Buffer.concat([buffer, chunk as Buffer]);

    while (buffer.length >= HEADER_SIZE) {
      const streamType = buffer.readUInt8(0);
      const payloadLength = buffer.readUInt32BE(4);

      if (buffer.length < HEADER_SIZE + payloadLength) {
        break; // Wait for the rest of this frame.
      }

      const payloadBytes = buffer.subarray(HEADER_SIZE, HEADER_SIZE + payloadLength);
      buffer = buffer.subarray(HEADER_SIZE + payloadLength);

      // Docker uses 1 for stdout and 2 for stderr. Anything else (0 = stdin echo) is ignored.
      const stream: 'stdout' | 'stderr' = streamType === 2 ? 'stderr' : 'stdout';

      const combined = partial[stream] + decoder[stream].write(payloadBytes);
      const parts = combined.split('\n');
      // The trailing element is either an incomplete line or an empty string; carry it forward.
      partial[stream] = parts.pop() ?? '';

      for (const raw of parts) {
        const line = raw.replace(/\r$/, '');
        yield toLogLine(line, stream, seq++, options.withTimestamps ?? false);
      }
    }
  }

  // Flush whatever was left when the stream ended — usually the final line of a crash.
  for (const stream of ['stdout', 'stderr'] as const) {
    const tail = partial[stream] + decoder[stream].end();
    if (tail.length > 0) {
      yield toLogLine(tail.replace(/\r$/, ''), stream, seq++, options.withTimestamps ?? false);
    }
  }
}

const TIMESTAMP_RE = /^(?<ts>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s(?<rest>[\s\S]*)$/;

function toLogLine(
  raw: string,
  stream: 'stdout' | 'stderr',
  seq: number,
  withTimestamps: boolean
): LogLine {
  if (!withTimestamps) {
    return { seq, stream, timestamp: undefined, text: raw };
  }
  const match = TIMESTAMP_RE.exec(raw);
  if (!match?.groups) {
    return { seq, stream, timestamp: undefined, text: raw };
  }
  return {
    seq,
    stream,
    timestamp: Date.parse(match.groups.ts ?? ''),
    text: match.groups.rest ?? '',
  };
}

/** Duck-typed rather than `instanceof`: the stream may come from another realm. */
function isReadable(value: unknown): value is Readable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { pipe?: unknown }).pipe === 'function' &&
    typeof (value as { on?: unknown }).on === 'function'
  );
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  // docker-modem hands back a string when the response decodes as text, and `null` for an empty
  // log. Neither is an error — a container that has printed nothing has no lines.
  return Buffer.from(typeof value === 'string' ? value : '', 'utf8');
}

export interface LogStreamOptions {
  /** Keep the connection open and yield new lines as they arrive. */
  follow?: boolean;
  /** Number of historical lines to replay first. */
  tail?: number;
  /** Only lines after this epoch-seconds instant. */
  since?: number;
  withTimestamps?: boolean;
  startSeq?: number;
  /** Abort the underlying HTTP request. Always pass one for `follow: true`. */
  signal?: AbortSignal;
}

/**
 * Open a log stream.
 *
 * The caller owns cleanup: when following, pass an `AbortSignal` and abort it, or the socket
 * stays open and Docker keeps a goroutine alive for it. A leaked follow per page load is how
 * these UIs end up with hundreds of idle connections after a day.
 */
export async function streamLogs(
  docker: Docker,
  containerId: string,
  options: LogStreamOptions = {}
): Promise<Result<AsyncGenerator<LogLine>>> {
  const follow = options.follow ?? false;

  const opened = await attempt(async () => {
    const raw = await docker.getContainer(containerId).logs({
      follow,
      stdout: true,
      stderr: true,
      tail: options.tail ?? 500,
      timestamps: options.withTimestamps ?? true,
      ...(options.since === undefined ? {} : { since: options.since }),
      // dockerode's types model `follow` as a literal, so the union has to be widened here.
    } as never);

    /*
     * dockerode returns two different things from the same call.
     *
     * `Container.logs` passes `isStream: opts.follow || false` to docker-modem, so `follow: true`
     * resolves with a `Readable` and `follow: false` resolves with the *whole response buffered*
     * — a Buffer, not a stream. Casting both to `Readable` type-checks and then fails at runtime
     * in a way that reads like a Docker problem: `for await` over a Buffer iterates it byte by
     * byte as numbers, and the first `Buffer.concat` throws `The "list[1]" argument must be an
     * instance of Buffer … Received type number`.
     *
     * That took out every non-follow reader: the MCP `get_logs` tool, `diagnose_server`, and the
     * supervisor's ready-line check — which rejected inside a `Promise.all`, aborting each
     * reconcile tick before orphan adoption and RCON reaping ran.
     */
    const stream = isReadable(raw) ? raw : Readable.from([toBuffer(raw)]);

    if (options.signal) {
      const onAbort = () => stream.destroy();
      options.signal.addEventListener('abort', onAbort, { once: true });
      stream.once('close', () => options.signal?.removeEventListener('abort', onAbort));
    }

    return stream;
  });

  if (!opened.ok) {
    const status = (opened.error.cause as { statusCode?: number } | undefined)?.statusCode;
    if (status === 404) {
      return fail('container_not_found', `No container with id ${containerId}.`, {
        details: { containerId },
      });
    }
    return opened as Result<never>;
  }

  const generator = demuxLines(opened.value, {
    withTimestamps: options.withTimestamps ?? true,
    ...(options.startSeq === undefined ? {} : { startSeq: options.startSeq }),
  });
  return ok(generator);
}

/** Collect the last `tail` lines. Used by the diagnosis engine and for crash snapshots. */
export async function readLogTail(
  docker: Docker,
  containerId: string,
  tail = 500
): Promise<Result<LogLine[]>> {
  const stream = await streamLogs(docker, containerId, {
    follow: false,
    tail,
    withTimestamps: true,
  });
  if (!stream.ok) {
    return stream;
  }
  const lines: LogLine[] = [];
  for await (const line of stream.value) {
    lines.push(line);
  }
  return ok(lines);
}
