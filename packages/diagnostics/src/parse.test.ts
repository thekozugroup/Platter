import { describe, expect, it } from 'vitest';
import { groupTraces, parseLine, parseLines, toBlocks } from './parse';
import { loadFixture, toLines } from './rules/fixtures';
import type { RawLogLine } from './types';

const line = (text: string, seq = 0): RawLogLine => ({ seq, stream: 'stdout', text });

describe('parseLine', () => {
  it('parses the standard log4j console layout', () => {
    const parsed = parseLine(
      line('[21:04:11] [Server thread/INFO]: Done (8.221s)! For help, type "help"')
    );
    expect(parsed.source).toBe('minecraft');
    expect(parsed.time).toBe('21:04:11');
    expect(parsed.thread).toBe('Server thread');
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('Done (8.221s)! For help, type "help"');
  });

  it('parses the Forge layout with a logger and marker', () => {
    const parsed = parseLine(
      line(
        '[21:04:11] [main/ERROR] [net.minecraftforge.fml.loading.RuntimeDistCleaner/DISTXFORM]: nope'
      )
    );
    expect(parsed.thread).toBe('main');
    expect(parsed.level).toBe('error');
    expect(parsed.logger).toBe('net.minecraftforge.fml.loading.RuntimeDistCleaner');
    expect(parsed.marker).toBe('DISTXFORM');
    expect(parsed.message).toBe('nope');
  });

  it('parses a logger with an empty marker', () => {
    const parsed = parseLine(line('[21:04:11] [main/ERROR] [net.minecraft.Foo/]: broke'));
    expect(parsed.logger).toBe('net.minecraft.Foo');
    expect(parsed.marker).toBeUndefined();
    expect(parsed.message).toBe('broke');
  });

  it("parses Paper's thread-less layout", () => {
    const parsed = parseLine(line('[21:04:11 INFO]: Loading Paper 1.21.4-497'));
    expect(parsed.source).toBe('minecraft');
    expect(parsed.level).toBe('info');
    expect(parsed.thread).toBeUndefined();
    expect(parsed.message).toBe('Loading Paper 1.21.4-497');
  });

  it('parses the entrypoint tag and its error level', () => {
    const plain = parseLine(line('[init] Starting the Minecraft server...'));
    expect(plain.source).toBe('entrypoint');
    expect(plain.level).toBeUndefined();
    expect(plain.message).toBe('Starting the Minecraft server...');

    const error = parseLine(line('[init] [ERROR] Please accept the Minecraft EULA at'));
    expect(error.source).toBe('entrypoint');
    expect(error.level).toBe('error');
    expect(error.message).toBe('Please accept the Minecraft EULA at');
  });

  it('parses mc-image-helper output', () => {
    const parsed = parseLine(
      line("[mc-image-helper] 01:52:04.560 ERROR : 'install-neoforge' command failed.")
    );
    expect(parsed.source).toBe('entrypoint');
    expect(parsed.logger).toBe('mc-image-helper');
    expect(parsed.level).toBe('error');
    expect(parsed.message).toBe("'install-neoforge' command failed.");
  });

  it('parses the autopause daemon', () => {
    const parsed = parseLine(
      line('[Autopause loop] All clients disconnected - pausing in 3600 seconds')
    );
    expect(parsed.source).toBe('entrypoint');
    expect(parsed.message).toBe('All clients disconnected - pausing in 3600 seconds');
  });

  it('classifies bare JVM output', () => {
    expect(parseLine(line('Exception in thread "main" java.lang.Error: x')).source).toBe('jvm');
    expect(parseLine(line('\tat com.example.Foo.bar(Foo.java:1)')).source).toBe('jvm');
    expect(parseLine(line('Caused by: java.io.IOException: x')).source).toBe('jvm');
    expect(parseLine(line('... 42 more')).source).toBe('jvm');
  });

  it('falls back to unknown rather than failing', () => {
    const parsed = parseLine(line('some completely unstructured output'));
    expect(parsed.source).toBe('unknown');
    expect(parsed.message).toBe('some completely unstructured output');
  });

  it('strips colour codes before parsing', () => {
    // itzg colours logError() with tput whenever the container has a TTY, which puts escape
    // sequences in the middle of the strings the rules match on.
    const coloured = `[init] [31m[ERROR] Invalid TYPE: 'PAPERMC' [0m`;
    const parsed = parseLine(line(coloured));
    expect(parsed.level).toBe('error');
    expect(parsed.message).toBe("Invalid TYPE: 'PAPERMC'");
  });

  it('strips a leading Docker timestamp if the caller left one on', () => {
    const parsed = parseLine(
      line('2026-08-07T12:04:11.123456789Z [21:04:11] [Server thread/INFO]: hi')
    );
    expect(parsed.source).toBe('minecraft');
    expect(parsed.message).toBe('hi');
  });

  it('carries the Docker timestamp through and tolerates null', () => {
    expect(parseLine({ seq: 1, stream: 'stdout', text: 'x', timestamp: 1234 }).timestamp).toBe(
      1234
    );
    expect(
      parseLine({ seq: 1, stream: 'stdout', text: 'x', timestamp: null }).timestamp
    ).toBeUndefined();
  });

  it('preserves leading whitespace in raw but not the record prefix in message', () => {
    const parsed = parseLine(line('\tat com.example.Foo.bar(Foo.java:1)'));
    expect(parsed.raw.startsWith('\t')).toBe(true);
  });
});

describe('groupTraces', () => {
  it('keeps a stack trace with the line that introduced it', () => {
    const blocks = toBlocks(
      toLines(
        [
          '[12:04:11] [Server thread/ERROR]: Encountered an unexpected exception',
          'java.lang.OutOfMemoryError: Java heap space',
          '\tat java.base/java.util.Arrays.copyOf(Arrays.java:3537)',
          '\tat net.minecraft.Foo.bar(Foo.java:1)',
          '[12:04:12] [Server thread/INFO]: Stopping server',
        ].join('\n')
      )
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.lines).toHaveLength(4);
    expect(blocks[0]?.text).toContain('OutOfMemoryError');
    expect(blocks[0]?.hasStackTrace).toBe(true);
    expect(blocks[1]?.head.message).toBe('Stopping server');
  });

  it('absorbs Caused by and "... N more"', () => {
    const blocks = toBlocks(
      toLines(
        [
          'Exception in thread "main" java.lang.RuntimeException: outer',
          '\tat com.example.A.a(A.java:1)',
          'Caused by: java.io.IOException: inner',
          '\tat com.example.B.b(B.java:2)',
          '\t... 42 more',
        ].join('\n')
      )
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toContain('Caused by: java.io.IOException: inner');
    expect(blocks[0]?.text).toContain('... 42 more');
  });

  it('keeps a throwable rendered beneath its own log message in one block', () => {
    // log4j prints the message, then the exception class at column zero. Splitting there would
    // separate a rule's header match from the detail lines it needs.
    const blocks = toBlocks(loadFixture('fabric-missing-dependency.log'));
    const block = blocks.find((b) => b.text.includes('Incompatible mod set!'));
    expect(block).toBeDefined();
    expect(block?.text).toContain("Mod 'Create' (create)");
    expect(block?.text).toContain('Unmet dependency listing:');
  });

  it('keeps an unindented exception message body with its trace', () => {
    const blocks = toBlocks(loadFixture('fabric-missing-dependency-modern.log'));
    const block = blocks.find((b) => b.text.includes('Incompatible mods found!'));
    expect(block?.text).toContain('More details:');
    expect(block?.text).toContain("Mod 'Sodium' (sodium) 0.4.10 requires");
  });

  it("keeps Forge's tab-indented dependency table with its header", () => {
    const blocks = toBlocks(loadFixture('forge-missing-dependency.log'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toContain('Missing or unsupported mandatory dependencies:');
    expect(blocks[0]?.text).toContain("Mod ID: 'jei'");
  });

  it('groups a run of entrypoint errors into one piece of evidence', () => {
    // The entrypoint has no multi-line logging, so it prints a paragraph as four calls.
    const blocks = toBlocks(loadFixture('eula-not-accepted.log'));
    const block = blocks.find((b) => b.text.includes('Please accept the Minecraft EULA'));
    expect(block?.lines.length).toBe(4);
    expect(block?.text).toContain('-e EULA=TRUE');
  });

  it('does not glue unrelated info lines together', () => {
    const lines = loadFixture('healthy-startup.log');
    const blocks = toBlocks(lines);
    // Every line here is its own record; nothing should have been merged.
    expect(blocks.length).toBe(lines.length);
  });

  it('caps a runaway trace instead of building an unbounded block', () => {
    const frames = Array.from({ length: 900 }, (_, i) => `\tat com.example.Foo.bar(Foo.java:${i})`);
    const blocks = toBlocks(toLines(['java.lang.StackOverflowError: boom', ...frames].join('\n')));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.truncated).toBe(true);
    expect(blocks[0]?.lines.length).toBeLessThanOrEqual(400);
  });

  it('records the sequence range covered by a block', () => {
    const blocks = groupTraces(
      parseLines(
        toLines(['java.lang.Error: x', '\tat a.B.c(B.java:1)', '\tat d.E.f(E.java:2)'].join('\n'))
      )
    );
    expect(blocks[0]?.firstSeq).toBe(0);
    expect(blocks[0]?.lastSeq).toBe(2);
  });

  it('returns nothing for empty input', () => {
    expect(toBlocks([])).toEqual([]);
  });
});
