import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { demuxLines } from './logs';

/**
 * Docker multiplexes stdout and stderr over one connection with an 8-byte header per frame, and
 * frames split mid-line constantly. Handling a chunk at a time — the obvious implementation —
 * produces log lines chopped at arbitrary byte offsets, which looks like corruption in the
 * console and quietly breaks every regex the diagnosis engine relies on.
 */

/** Build a Docker multiplexed frame. */
function frame(stream: 1 | 2, payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt8(stream, 0);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

async function collect(chunks: Buffer[], options?: Parameters<typeof demuxLines>[1]) {
  const source = Readable.from(chunks);
  const out = [];
  for await (const line of demuxLines(source, options)) {
    out.push(line);
  }
  return out;
}

describe('demuxLines', () => {
  it('splits a frame into lines', async () => {
    const lines = await collect([frame(1, 'one\ntwo\nthree\n')]);
    expect(lines.map((l) => l.text)).toEqual(['one', 'two', 'three']);
  });

  it('tags stderr separately from stdout', async () => {
    const lines = await collect([frame(1, 'out\n'), frame(2, 'err\n')]);
    expect(lines.map((l) => [l.stream, l.text])).toEqual([
      ['stdout', 'out'],
      ['stderr', 'err'],
    ]);
  });

  it('reassembles a line split across two frames', async () => {
    // The case that matters. Docker will happily end a frame mid-word.
    const lines = await collect([frame(1, 'hello wo'), frame(1, 'rld\n')]);
    expect(lines.map((l) => l.text)).toEqual(['hello world']);
  });

  it('reassembles a frame split across two chunks', async () => {
    const full = frame(1, 'split across chunks\n');
    const lines = await collect([full.subarray(0, 5), full.subarray(5)]);
    expect(lines.map((l) => l.text)).toEqual(['split across chunks']);
  });

  it('handles a header split across chunks', async () => {
    const full = frame(1, 'header split\n');
    const lines = await collect([full.subarray(0, 3), full.subarray(3, 9), full.subarray(9)]);
    expect(lines.map((l) => l.text)).toEqual(['header split']);
  });

  it('keeps stdout and stderr partials separate', async () => {
    // Interleaving frames from both streams must not splice one stream's partial line onto the
    // other's — which is exactly what a single shared buffer would do.
    const lines = await collect([
      frame(1, 'out-par'),
      frame(2, 'err-par'),
      frame(1, 'tial\n'),
      frame(2, 'tial\n'),
    ]);
    expect(lines.map((l) => [l.stream, l.text])).toEqual([
      ['stdout', 'out-partial'],
      ['stderr', 'err-partial'],
    ]);
  });

  it('flushes a trailing line with no newline', async () => {
    // The final line of a crash usually arrives without one.
    const lines = await collect([frame(1, 'no trailing newline')]);
    expect(lines.map((l) => l.text)).toEqual(['no trailing newline']);
  });

  it('strips carriage returns', async () => {
    const lines = await collect([frame(1, 'windows\r\nstyle\r\n')]);
    expect(lines.map((l) => l.text)).toEqual(['windows', 'style']);
  });

  it('assigns monotonically increasing sequence numbers', async () => {
    const lines = await collect([frame(1, 'a\nb\n'), frame(2, 'c\n')]);
    expect(lines.map((l) => l.seq)).toEqual([0, 1, 2]);
  });

  it('continues numbering from a supplied start', async () => {
    // Lets a reconnecting browser resume without renumbering everything it already has.
    const lines = await collect([frame(1, 'a\nb\n')], { startSeq: 100 });
    expect(lines.map((l) => l.seq)).toEqual([100, 101]);
  });

  it('parses Docker timestamps out of the payload', async () => {
    const lines = await collect(
      [frame(1, '2026-08-07T17:37:41.123456789Z [17:37:41 INFO]: Done\n')],
      { withTimestamps: true }
    );
    expect(lines[0]?.text).toBe('[17:37:41 INFO]: Done');
    expect(lines[0]?.timestamp).toBe(Date.parse('2026-08-07T17:37:41.123Z'));
  });

  it('leaves the line intact when it has no timestamp to strip', async () => {
    const lines = await collect([frame(1, 'no timestamp here\n')], { withTimestamps: true });
    expect(lines[0]?.text).toBe('no timestamp here');
    expect(lines[0]?.timestamp).toBeUndefined();
  });

  it('ignores frames from stream 0', async () => {
    // Stream 0 is stdin echo, which is not server output.
    const lines = await collect([frame(1, 'real\n')]);
    expect(lines).toHaveLength(1);
  });

  it('handles an empty stream', async () => {
    expect(await collect([])).toEqual([]);
  });

  it('handles a truncated final frame without hanging', async () => {
    // A connection dropped mid-frame must not leave the generator waiting forever.
    const full = frame(1, 'complete\n');
    const partial = frame(1, 'this will be cut off');
    const lines = await collect([full, partial.subarray(0, 12)]);
    expect(lines.map((l) => l.text)).toEqual(['complete']);
  });

  it('preserves multi-byte characters split across frames', async () => {
    // A UTF-8 sequence can straddle a frame boundary; naive per-frame decoding mangles it.
    const text = 'MOTD: héllo wörld ✦\n';
    const encoded = Buffer.from(text, 'utf8');
    const lines = await collect([
      Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, encoded.length]), encoded]),
    ]);
    expect(lines[0]?.text).toBe('MOTD: héllo wörld ✦');
  });
});
