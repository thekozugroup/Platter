import { describe, expect, it } from 'vitest';
import { describeExitCode } from '@/lib/exit-code.js';

/**
 * The crash banner is the first thing a worried person reads, and for a long time it said
 * "The process stopped with exit code 137" and stopped. These cases guard the translation
 * from that number into a sentence and a next step.
 */
describe('describeExitCode', () => {
  it('reads 137 as running out of memory, and says so', () => {
    const explained = describeExitCode(137);

    expect(explained?.outOfMemory).toBe(true);
    expect(explained?.summary).toMatch(/ran out of memory/i);
    expect(explained?.fix).toMatch(/more memory/i);
    // Hedged, not asserted: this side cannot read Docker's `OOMKilled` flag.
    expect(explained?.summary).toMatch(/nearly always/i);
  });

  it('does not offer a memory fix for an ordinary error exit', () => {
    const explained = describeExitCode(1);

    expect(explained?.outOfMemory).toBe(false);
    expect(explained?.fix).not.toMatch(/memory/i);
  });

  it('names the signal behind any other 128+n code', () => {
    expect(describeExitCode(130)?.summary).toContain('signal 2 (SIGINT)');
    expect(describeExitCode(139)?.summary).toContain('signal 11');
  });

  it('still answers for a code it has no sentence for, and never for a missing one', () => {
    expect(describeExitCode(42)?.summary).toBe('The server exited with code 42.');
    expect(describeExitCode(null)).toBeNull();
  });
});
