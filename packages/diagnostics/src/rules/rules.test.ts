import { describe, expect, it } from 'vitest';
import { diagnose } from '../diagnose';
import type { DiagnoseInput, Finding } from '../types';
import { loadFixture } from './fixtures';
import { RULES, ruleCatalogue } from './index';

/**
 * Every rule, pinned to a real log excerpt and to something that looks like one but is not.
 *
 * The negative half is the important half. A rule that over-matches is worse than a rule that
 * does not exist: it sends someone to delete a mod, restore a backup or buy more memory to solve
 * a problem they do not have. So each entry names a `nearMiss` fixture chosen to be genuinely
 * adversarial — the warning variant of the same message, the debug line that mentions the same
 * subsystem, the chat message quoting the same exception.
 */

interface Case {
  readonly ruleId: string;
  /** Real log excerpts on which the rule must fire. */
  readonly fires: readonly string[];
  /** Excerpts on which it must stay silent. */
  readonly nearMisses: readonly string[];
  /** Extra context the rule needs, e.g. an exit code. */
  readonly input?: Omit<DiagnoseInput, 'lines'>;
  /** Assertions on the finding itself. */
  readonly expect?: (finding: Finding) => void;
}

const CASES: readonly Case[] = [
  {
    ruleId: 'config.eula-not-accepted',
    fires: ['eula-not-accepted.log', 'eula-not-accepted-vanilla.log'],
    nearMisses: ['eula-not-accepted.near-miss.log'],
    expect: (f) => {
      expect(f.fixes[0]?.action).toEqual({ type: 'accept_eula' });
      expect(f.fixes[0]?.kind).toBe('automatic');
    },
  },
  {
    ruleId: 'config.invalid-server-type',
    fires: ['invalid-server-type.log'],
    nearMisses: ['invalid-server-type.near-miss.log'],
    expect: (f) => {
      // PAPERMC is not a valid TYPE, but PAPER is the obvious intent.
      expect(f.fixes[0]?.action).toEqual({ type: 'set_setting', key: 'TYPE', value: 'PAPER' });
    },
  },
  {
    ruleId: 'java.version-too-old',
    fires: ['java-too-old.log', 'java-too-old-bukkit.log'],
    nearMisses: ['java-too-old.near-miss.log'],
    expect: (f) => {
      // class file 65 is Java 21; the JVM reported reading up to 61, which is Java 17.
      expect(f.fixes[0]?.action).toEqual({ type: 'change_java_version', java: 21 });
      expect(f.explanation).toContain('Java 21');
      expect(f.explanation).toContain('Java 17');
    },
  },
  {
    ruleId: 'java.version-too-new-for-mods',
    fires: ['java-too-new-mixin.log'],
    nearMisses: ['java-too-new-mixin.near-miss.log'],
    expect: (f) => {
      expect(f.fixes[0]?.action).toEqual({ type: 'change_java_version', java: 17 });
    },
  },
  {
    ruleId: 'java.version-too-new-for-forge',
    fires: ['java-too-new-forge.log'],
    nearMisses: ['java-too-new-forge.near-miss.log'],
    expect: (f) => {
      expect(f.fixes[0]?.action).toEqual({ type: 'change_java_version', java: 8 });
    },
  },
  {
    ruleId: 'memory.out-of-memory',
    fires: ['out-of-memory.log', 'out-of-memory-metaspace.log'],
    nearMisses: ['out-of-memory.near-miss.log'],
    input: { server: { memoryMiB: 2048, loader: 'fabric' } },
    expect: (f) => {
      const action = f.fixes[0]?.action;
      expect(action?.type).toBe('set_memory');
      // Computed, not a constant: a 2 GB modded server is stepped up, never left where it was.
      if (action?.type === 'set_memory') {
        expect(action.memoryMiB).toBeGreaterThan(2048);
      }
    },
  },
  {
    ruleId: 'network.port-in-use',
    fires: ['port-in-use.log'],
    nearMisses: ['port-in-use.near-miss.log'],
    expect: (f) => {
      expect(f.fixes[0]?.action).toEqual({ type: 'reallocate_port' });
      expect(f.explanation).toContain('25565');
    },
  },
  {
    ruleId: 'mods.fabric-missing-dependency',
    fires: ['fabric-missing-dependency.log', 'fabric-missing-dependency-modern.log'],
    nearMisses: ['fabric-missing-dependency.near-miss.log'],
  },
  {
    ruleId: 'mods.forge-missing-dependency',
    fires: ['forge-missing-dependency.log'],
    nearMisses: ['forge-missing-dependency.near-miss.log'],
    expect: (f) => {
      // 'forge' is the loader, so it must not be offered as a mod to install.
      const loaderFix = f.fixes.find((x) => x.title.includes('forge'));
      expect(loaderFix?.action).toBeUndefined();
      const jeiFix = f.fixes.find((x) => x.action?.type === 'install_mod');
      expect(jeiFix?.action).toMatchObject({ type: 'install_mod', ref: { id: 'jei' } });
      expect(f.explanation).toContain('version 15.2.0.27 or newer');
    },
  },
  {
    ruleId: 'mods.mixin-apply-failure',
    fires: ['mixin-apply-failure.log'],
    nearMisses: ['mixin-apply-failure.near-miss.log'],
    expect: (f) => {
      // Attributed to the owning mod via the mixin config filename.
      expect(f.explanation).toContain('create');
    },
  },
  {
    ruleId: 'mods.duplicate-mod',
    fires: ['duplicate-mod.log', 'duplicate-mod-fabric.log'],
    nearMisses: ['duplicate-mod.near-miss.log'],
  },
  {
    ruleId: 'mods.client-only-mod',
    fires: ['client-only-mod.log'],
    nearMisses: ['client-only-mod.near-miss.log'],
    expect: (f) => {
      // The ModLauncher frame names the mod outright.
      expect(f.fixes[0]?.action).toEqual({ type: 'remove_mod', match: 'minecolonies' });
    },
  },
  {
    ruleId: 'world.corruption',
    fires: ['world-corruption.log'],
    nearMisses: ['world-corruption.near-miss.log'],
    expect: (f) => {
      expect(f.fixes.some((x) => x.action?.type === 'restore_backup')).toBe(true);
    },
  },
  {
    ruleId: 'startup.watchdog-timeout',
    fires: ['watchdog-timeout.log'],
    nearMisses: ['watchdog-timeout.near-miss.log'],
  },
  {
    ruleId: 'permissions.data-not-writable',
    fires: ['permissions.log', 'permissions-java.log'],
    nearMisses: ['permissions.near-miss.log'],
    expect: (f) => {
      expect(f.fixes[0]?.action).toEqual({ type: 'repair_permissions' });
    },
  },
  {
    ruleId: 'disk.no-space',
    fires: ['disk-full.log'],
    nearMisses: ['disk-full.near-miss.log'],
  },
  {
    ruleId: 'startup.download-failed',
    fires: ['download-failed.log', 'download-failed-404.log'],
    nearMisses: ['download-failed.near-miss.log'],
  },
  {
    ruleId: 'startup.server-paused',
    fires: ['server-paused.log'],
    nearMisses: ['server-paused.near-miss.log'],
    input: { server: { autopauseEnabled: true } },
  },
];

function run(fixture: string, extra: Omit<DiagnoseInput, 'lines'> = {}) {
  return diagnose({ lines: loadFixture(fixture), ...extra });
}

describe.each(CASES)('$ruleId', (testCase) => {
  it.each(testCase.fires)('fires on %s', (fixture) => {
    const diagnosis = run(fixture, testCase.input);
    const finding = diagnosis.findings.find((f) => f.ruleId === testCase.ruleId);
    expect(finding, `expected ${testCase.ruleId} to fire on ${fixture}`).toBeDefined();
    if (finding !== undefined) {
      expect(finding.explanation.length).toBeGreaterThan(40);
      expect(finding.fixes.length).toBeGreaterThan(0);
      expect(finding.evidence.lines.length).toBeGreaterThan(0);
      testCase.expect?.(finding);
    }
  });

  it.each(testCase.nearMisses)('stays silent on %s', (fixture) => {
    const diagnosis = run(fixture, testCase.input);
    const finding = diagnosis.findings.find((f) => f.ruleId === testCase.ruleId);
    expect(finding, `${testCase.ruleId} should not fire on ${fixture}`).toBeUndefined();
  });
});

describe('the catalogue as a whole', () => {
  it('reports nothing on a healthy startup', () => {
    const diagnosis = diagnose({ lines: loadFixture('healthy-startup.log'), exitCode: 0 });
    expect(diagnosis.findings).toEqual([]);
    expect(diagnosis.healthy).toBe(true);
    expect(diagnosis.summary).toContain('Nothing wrong');
  });

  it('has a case for every rule', () => {
    const covered = new Set(CASES.map((c) => c.ruleId));
    const uncovered = RULES.map((r) => r.id).filter(
      // The two exit-code rules are context-only and are exercised in diagnose.test.ts, where
      // an exit code can be supplied without a log fixture implying one.
      (id) =>
        !covered.has(id) && id !== 'memory.container-killed' && id !== 'world.killed-during-save'
    );
    expect(uncovered).toEqual([]);
  });

  it('has unique rule ids', () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('exposes a catalogue the UI can render', () => {
    const catalogue = ruleCatalogue();
    expect(catalogue.length).toBe(RULES.length);
    for (const entry of catalogue) {
      expect(entry.title.length).toBeGreaterThan(8);
      expect(entry.id).toMatch(/^[a-z]+\.[a-z-]+$/);
    }
  });

  it('never produces a fix whose action is a function', () => {
    // Fixes cross the MCP boundary and are shown to a human for approval. Anything unserialisable
    // would silently vanish on the way, and approval would be meaningless.
    for (const fixture of CASES.flatMap((c) => c.fires)) {
      const diagnosis = run(fixture, { server: { memoryMiB: 4096 } });
      const roundTripped = JSON.parse(JSON.stringify(diagnosis));
      expect(roundTripped.findings.length).toBe(diagnosis.findings.length);
      for (const finding of diagnosis.findings) {
        for (const fix of finding.fixes) {
          expect(typeof fix.action === 'undefined' || typeof fix.action === 'object').toBe(true);
        }
      }
    }
  });
});
