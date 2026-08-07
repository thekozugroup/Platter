import { describe, expect, it } from 'vitest';
import { diagnose } from './diagnose';
import { loadFixture, toLines } from './rules/fixtures';

describe('diagnose', () => {
  it('returns something usable for an empty log', () => {
    const diagnosis = diagnose({ lines: [] });
    expect(diagnosis.findings).toEqual([]);
    expect(diagnosis.healthy).toBe(true);
    expect(diagnosis.analysedLines).toBe(0);
    expect(diagnosis.summary.length).toBeGreaterThan(10);
  });

  it('reports the window it looked at', () => {
    const lines = loadFixture('healthy-startup.log');
    const diagnosis = diagnose({ lines });
    expect(diagnosis.analysedLines).toBe(lines.length);
    expect(diagnosis.window.from).toBe(0);
    expect(diagnosis.window.to).toBe(lines.length - 1);
  });

  it('summarises with a sentence, not a count', () => {
    const diagnosis = diagnose({ lines: loadFixture('eula-not-accepted.log'), exitCode: 1 });
    expect(diagnosis.summary).toContain('licence');
    expect(diagnosis.summary).not.toMatch(/^\d+ issues?/);
  });

  it('marks a server with a critical finding as unhealthy', () => {
    const diagnosis = diagnose({ lines: loadFixture('out-of-memory.log') });
    expect(diagnosis.healthy).toBe(false);
  });

  it('leaves a server healthy when only informational findings fire', () => {
    const diagnosis = diagnose({
      lines: loadFixture('server-paused.log'),
      server: { autopauseEnabled: true },
      health: 'healthy',
    });
    expect(diagnosis.findings.map((f) => f.ruleId)).toContain('startup.server-paused');
    expect(diagnosis.healthy).toBe(true);
  });

  it('contradicts a green healthcheck when the server is merely paused', () => {
    // The image's healthcheck returns success for a paused server by design, so "healthy" alone
    // would be a false all-clear.
    const diagnosis = diagnose({ lines: [], paused: true, health: 'healthy' });
    const finding = diagnosis.findings.find((f) => f.ruleId === 'startup.server-paused');
    expect(finding).toBeDefined();
    expect(finding?.explanation).toContain('health check');
  });

  it('orders findings by severity, then confidence, then position', () => {
    const lines = [
      ...loadFixture('healthy-startup.log'),
      ...loadFixture('out-of-memory.log').map((l, i) => ({ ...l, seq: 100 + i })),
    ];
    const diagnosis = diagnose({ lines, server: { autopauseEnabled: true }, paused: true });
    const severities = diagnosis.findings.map((f) => f.severity);
    expect(severities[0]).toBe('critical');
    expect(severities[severities.length - 1]).toBe('info');
  });

  it('carries evidence with every finding', () => {
    const diagnosis = diagnose({ lines: loadFixture('forge-missing-dependency.log') });
    const finding = diagnosis.findings[0];
    expect(finding?.evidence.lines.some((l) => l.includes("Mod ID: 'jei'"))).toBe(true);
    expect(finding?.evidence.firstSeq).toBe(0);
  });

  it('drops a symptom when the underlying cause also fired', () => {
    // A mixin failure caused by the wrong JVM is not a mod problem, and reporting it as one
    // would point the user at deleting a mod that was never broken.
    const lines = [
      ...loadFixture('java-too-new-mixin.log'),
      ...loadFixture('mixin-apply-failure.log').map((l, i) => ({ ...l, seq: 100 + i })),
    ];
    const diagnosis = diagnose({ lines, server: { javaVersion: 21 } });
    const ids = diagnosis.findings.map((f) => f.ruleId);
    expect(ids).toContain('java.version-too-new-for-mods');
    expect(ids).not.toContain('mods.mixin-apply-failure');
  });

  describe('exit code 137, which is overloaded', () => {
    const oomLines = loadFixture('out-of-memory.log');
    const shutdownLines = toLines(
      [
        '[12:04:11] [Server thread/INFO]: Stopping the server',
        '[12:04:11] [Server thread/INFO]: Saving players',
        '[12:04:12] [Server thread/INFO]: Saving worlds',
      ].join('\n')
    );

    it('blames the kernel when there is no Java error to explain the kill', () => {
      const diagnosis = diagnose({ lines: [], exitCode: 137, server: { memoryMiB: 2048 } });
      const ids = diagnosis.findings.map((f) => f.ruleId);
      expect(ids).toContain('memory.container-killed');
      expect(ids).not.toContain('world.killed-during-save');
    });

    it('defers to the Java error when the JVM did report running out of memory', () => {
      const diagnosis = diagnose({ lines: oomLines, exitCode: 137, server: { memoryMiB: 2048 } });
      const ids = diagnosis.findings.map((f) => f.ruleId);
      expect(ids).toContain('memory.out-of-memory');
      expect(ids).not.toContain('memory.container-killed');
    });

    it('recognises a shutdown that outran its grace period', () => {
      const diagnosis = diagnose({ lines: shutdownLines, exitCode: 137 });
      const ids = diagnosis.findings.map((f) => f.ruleId);
      expect(ids).toContain('world.killed-during-save');
      expect(ids).not.toContain('memory.container-killed');
    });

    it("trusts Docker's OOMKilled flag over the shutdown evidence", () => {
      const diagnosis = diagnose({ lines: shutdownLines, exitCode: 137, oomKilled: true });
      const finding = diagnosis.findings.find((f) => f.ruleId === 'memory.container-killed');
      expect(finding).toBeDefined();
      expect(finding?.confidence).toBe('high');
    });

    it('does not fire either rule on a clean exit', () => {
      const diagnosis = diagnose({ lines: shutdownLines, exitCode: 0 });
      const ids = diagnosis.findings.map((f) => f.ruleId);
      expect(ids).not.toContain('memory.container-killed');
      expect(ids).not.toContain('world.killed-during-save');
    });
  });

  describe('input shapes', () => {
    it('accepts exit code and health nested under server', () => {
      const diagnosis = diagnose({
        lines: [],
        server: { exitCode: 137, health: 'unhealthy', memoryMiB: 4096 },
      });
      expect(diagnosis.findings.map((f) => f.ruleId)).toContain('memory.container-killed');
    });

    it('treats a null exit code as "has not exited"', () => {
      const diagnosis = diagnose({ lines: [], server: { exitCode: null } });
      expect(diagnosis.findings).toEqual([]);
    });

    it('accepts installed mods under either name', () => {
      const mods = [{ name: 'Create', slug: 'create' }];
      const viaMods = diagnose({ lines: loadFixture('out-of-memory.log'), mods });
      const viaInstalled = diagnose({ lines: loadFixture('out-of-memory.log'), installed: mods });
      expect(viaInstalled.findings[0]?.fixes[0]?.action).toEqual(
        viaMods.findings[0]?.fixes[0]?.action
      );
    });

    it('tolerates null timestamps on log lines', () => {
      const diagnosis = diagnose({
        lines: [
          {
            seq: 0,
            stream: 'stdout',
            text: '[init] [ERROR] Please accept the Minecraft EULA at',
            timestamp: null,
          },
        ],
      });
      expect(diagnosis.findings.map((f) => f.ruleId)).toContain('config.eula-not-accepted');
    });
  });

  it('scales to a crash loop without pathological cost', () => {
    // A crash-looping server produces a lot of log and this runs on every crash.
    const noise = Array.from({ length: 40_000 }, (_, i) => ({
      seq: i,
      stream: 'stdout' as const,
      text: `[12:04:11] [Server thread/INFO]: Saving chunk ${i}`,
    }));
    const lines = [
      ...noise,
      ...loadFixture('out-of-memory.log').map((l, i) => ({ ...l, seq: 40_000 + i })),
    ];

    const started = Date.now();
    const diagnosis = diagnose({ lines, server: { memoryMiB: 4096 } });
    const elapsed = Date.now() - started;

    expect(diagnosis.findings.map((f) => f.ruleId)).toContain('memory.out-of-memory');
    expect(elapsed).toBeLessThan(4000);
  });

  it('is deterministic', () => {
    const input = { lines: loadFixture('forge-missing-dependency.log'), exitCode: 1 };
    expect(JSON.stringify(diagnose(input))).toBe(JSON.stringify(diagnose(input)));
  });
});
