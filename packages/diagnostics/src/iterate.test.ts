import { describe, expect, it } from 'vitest';
import { diagnose } from './diagnose';
import { explainPlan, planFixes } from './iterate';
import { loadFixture } from './rules/fixtures';
import type { Diagnosis, Finding, Fix } from './types';

/** Build a diagnosis by hand so plan behaviour can be tested without a matching log. */
function fakeDiagnosis(findings: readonly Partial<Finding>[]): Diagnosis {
  const full: Finding[] = findings.map((f, i) => ({
    ruleId: f.ruleId ?? `rule.${i}`,
    title: f.title ?? `Finding ${i}`,
    severity: f.severity ?? 'critical',
    category: f.category ?? 'mods',
    explanation: f.explanation ?? 'because',
    confidence: f.confidence ?? 'high',
    evidence: f.evidence ?? { lines: [], firstSeq: 0, lastSeq: 0 },
    fixes: f.fixes ?? [],
  }));
  return {
    summary: 'test',
    findings: full,
    healthy: false,
    analysedLines: 0,
    window: { from: 0, to: 0 },
  };
}

const fix = (over: Partial<Fix> & Pick<Fix, 'id'>): Fix => ({
  title: over.title ?? over.id,
  detail: over.detail ?? 'detail',
  kind: over.kind ?? 'automatic',
  confidence: over.confidence ?? 'high',
  ...over,
});

describe('planFixes', () => {
  it('returns an empty plan for a healthy diagnosis', () => {
    const plan = planFixes(diagnose({ lines: loadFixture('healthy-startup.log') }));
    expect(plan.steps).toEqual([]);
    expect(plan.requiresApproval).toBe(false);
    expect(explainPlan(plan)).toContain('nothing to do');
  });

  it('numbers steps from one, in order', () => {
    const plan = planFixes(diagnose({ lines: loadFixture('forge-missing-dependency.log') }));
    expect(plan.steps.map((s) => s.order)).toEqual(plan.steps.map((_, i) => i + 1));
  });

  it('keeps only the largest memory change when several are proposed', () => {
    const plan = planFixes(
      fakeDiagnosis([
        {
          ruleId: 'a',
          fixes: [fix({ id: 'small', action: { type: 'set_memory', memoryMiB: 4096 } })],
        },
        {
          ruleId: 'b',
          fixes: [fix({ id: 'big', action: { type: 'set_memory', memoryMiB: 8192 } })],
        },
        {
          ruleId: 'c',
          fixes: [fix({ id: 'mid', action: { type: 'set_memory', memoryMiB: 6144 } })],
        },
      ])
    );
    const memorySteps = plan.steps.filter((s) => s.fix.action?.type === 'set_memory');
    expect(memorySteps).toHaveLength(1);
    expect(memorySteps[0]?.fix.action).toEqual({ type: 'set_memory', memoryMiB: 8192 });
    expect(plan.skipped).toHaveLength(2);
    expect(plan.skipped[0]?.reason).toContain('8 GB');
  });

  it('drops a fix that a better fix makes pointless', () => {
    // Removing a mod that only failed because of the Java version is an irreversible answer to a
    // reversible problem.
    const plan = planFixes(
      fakeDiagnosis([
        {
          ruleId: 'java',
          fixes: [fix({ id: 'java', action: { type: 'change_java_version', java: 17 } })],
        },
        {
          ruleId: 'mods',
          fixes: [
            fix({
              id: 'remove',
              action: { type: 'remove_mod', match: 'create' },
              supersededBy: ['change_java_version'],
            }),
          ],
        },
      ])
    );
    expect(plan.steps.map((s) => s.fix.id)).toEqual(['java']);
    expect(plan.skipped[0]?.fix.id).toBe('remove');
    expect(plan.skipped[0]?.reason).toContain('Java version');
  });

  it('keeps a superseded-by fix when the superseding action is absent', () => {
    const plan = planFixes(
      fakeDiagnosis([
        {
          ruleId: 'mods',
          fixes: [
            fix({
              id: 'remove',
              action: { type: 'remove_mod', match: 'create' },
              supersededBy: ['change_java_version'],
            }),
          ],
        },
      ])
    );
    expect(plan.steps.map((s) => s.fix.id)).toEqual(['remove']);
    expect(plan.skipped).toEqual([]);
  });

  it('collapses identical actions proposed by two rules', () => {
    const plan = planFixes(
      fakeDiagnosis([
        { ruleId: 'a', fixes: [fix({ id: 'x', action: { type: 'remove_mod', match: 'create' } })] },
        { ruleId: 'b', fixes: [fix({ id: 'y', action: { type: 'remove_mod', match: 'create' } })] },
      ])
    );
    expect(plan.steps).toHaveLength(1);
    expect(plan.skipped[0]?.reason).toContain('identical');
  });

  it('does not collapse different mods', () => {
    const plan = planFixes(
      fakeDiagnosis([
        { ruleId: 'a', fixes: [fix({ id: 'x', action: { type: 'remove_mod', match: 'create' } })] },
        { ruleId: 'b', fixes: [fix({ id: 'y', action: { type: 'remove_mod', match: 'jei' } })] },
      ])
    );
    expect(plan.steps).toHaveLength(2);
  });

  it('puts cheap reversible changes before destructive ones', () => {
    const plan = planFixes(
      fakeDiagnosis([
        {
          ruleId: 'world',
          severity: 'critical',
          fixes: [
            fix({ id: 'restore', action: { type: 'restore_backup' } }),
            fix({ id: 'retry', action: { type: 'retry_start' } }),
          ],
        },
      ])
    );
    expect(plan.steps.map((s) => s.fix.id)).toEqual(['retry', 'restore']);
  });

  it('sorts a more severe finding ahead of a less severe one', () => {
    const plan = planFixes(
      fakeDiagnosis([
        {
          ruleId: 'warn',
          severity: 'warning',
          fixes: [fix({ id: 'w', action: { type: 'retry_start' } })],
        },
        {
          ruleId: 'crit',
          severity: 'critical',
          fixes: [fix({ id: 'c', action: { type: 'restore_backup' } })],
        },
      ])
    );
    expect(plan.steps.map((s) => s.fix.id)).toEqual(['c', 'w']);
  });

  it('flags a destructive plan', () => {
    const safe = planFixes(
      fakeDiagnosis([{ fixes: [fix({ id: 'a', action: { type: 'accept_eula' } })] }])
    );
    expect(safe.destructive).toBe(false);

    const risky = planFixes(
      fakeDiagnosis([{ fixes: [fix({ id: 'b', action: { type: 'restore_backup' } })] }])
    );
    expect(risky.destructive).toBe(true);
  });

  it('only requires approval when something would actually change', () => {
    const advisory = planFixes(fakeDiagnosis([{ fixes: [fix({ id: 'a', kind: 'manual' })] }]));
    expect(advisory.requiresApproval).toBe(false);
    expect(advisory.steps).toHaveLength(1);
  });

  it('carries the reasoning alongside each step', () => {
    const plan = planFixes(diagnose({ lines: loadFixture('eula-not-accepted.log'), exitCode: 1 }));
    expect(plan.steps[0]?.ruleId).toBe('config.eula-not-accepted');
    expect(plan.steps[0]?.findingTitle).toContain('licence');
  });
});

describe('explainPlan', () => {
  it('separates what Platter will do from what the user must do', () => {
    const prose = explainPlan(
      planFixes(
        fakeDiagnosis([
          {
            fixes: [
              fix({
                id: 'auto',
                title: 'Switch to Java 17',
                action: { type: 'change_java_version', java: 17 },
              }),
              fix({ id: 'manual', title: 'Check the mod list', kind: 'manual' }),
            ],
          },
        ])
      )
    );
    expect(prose).toContain('Platter can make one change for you');
    expect(prose).toContain('One thing needs you rather than Platter');
    expect(prose).toContain('Switch to Java 17');
    expect(prose).toContain('Check the mod list');
  });

  it('warns when the plan cannot simply be undone', () => {
    const prose = explainPlan(
      planFixes(fakeDiagnosis([{ fixes: [fix({ id: 'r', action: { type: 'restore_backup' } })] }]))
    );
    expect(prose).toContain('cannot be undone');
  });

  it('hedges a low-confidence step so a human can weigh it', () => {
    const prose = explainPlan(
      planFixes(
        fakeDiagnosis([
          {
            fixes: [
              fix({ id: 'guess', confidence: 'low', action: { type: 'remove_mod', match: 'x' } }),
            ],
          },
        ])
      )
    );
    expect(prose).toContain('a guess');
  });

  it('says why suggestions were left out', () => {
    const prose = explainPlan(
      planFixes(
        fakeDiagnosis([
          {
            ruleId: 'a',
            fixes: [fix({ id: 'small', action: { type: 'set_memory', memoryMiB: 4096 } })],
          },
          {
            ruleId: 'b',
            fixes: [fix({ id: 'big', action: { type: 'set_memory', memoryMiB: 8192 } })],
          },
        ])
      )
    );
    expect(prose).toContain('left out');
  });

  it('produces prose with no identifiers or jargon leaking through', () => {
    const prose = explainPlan(
      planFixes(diagnose({ lines: loadFixture('java-too-old.log'), exitCode: 1 }))
    );
    expect(prose).not.toContain('UnsupportedClassVersionError');
    expect(prose).not.toContain('ruleId');
    expect(prose).toContain('Java 21');
  });
});

describe('the whole path, end to end', () => {
  it('turns a crashed container into an approvable plan', () => {
    const diagnosis = diagnose({
      lines: loadFixture('forge-missing-dependency.log'),
      server: { loader: 'forge', gameVersion: '1.20.1', memoryMiB: 4096, exitCode: 1 },
      installed: [{ slug: 'framework', name: 'Framework' }],
    });

    expect(diagnosis.healthy).toBe(false);
    expect(diagnosis.summary).toBeTruthy();

    const plan = planFixes(diagnosis);
    expect(plan.steps.length).toBeGreaterThan(0);

    // The whole thing has to survive a trip through JSON to reach a model and come back.
    const round = JSON.parse(JSON.stringify({ diagnosis, plan }));
    expect(round.plan.steps.length).toBe(plan.steps.length);
    expect(explainPlan(plan).length).toBeGreaterThan(50);
  });
});
