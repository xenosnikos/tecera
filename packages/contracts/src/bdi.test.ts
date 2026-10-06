import { describe, expect, it } from 'vitest';
import {
  IllegalTransition,
  achievementProofProblem,
  isWritingStep,
  newIntention,
  readySteps,
  transitionGoal,
  transitionIntention,
  transitionStep,
  validatePlanShape,
  type AchievementGoal,
  type GoalStatus,
  type IntentionStatus,
  type Plan,
  type StepStatus,
} from './bdi.js';

export function samplePlan(): Plan {
  return {
    id: 'p_1',
    trigger: { kind: 'goal.adopted' },
    context: [{ key: 'verify.baseline', equals: 'failing' }],
    steps: [
      { id: 'analyze', kind: 'worker', dependsOn: [], inputs: {} },
      { id: 'edit', kind: 'worker', dependsOn: ['analyze'], inputs: {} },
      { id: 'verify1', kind: 'gate.verify', dependsOn: ['edit'], inputs: {} },
      { id: 'review', kind: 'gate.review', dependsOn: ['verify1'], inputs: {} },
      { id: 'verify2', kind: 'gate.verify', dependsOn: ['review'], inputs: {} },
      { id: 'commit', kind: 'gate.commit', dependsOn: ['verify2'], inputs: {} },
      { id: 'pr', kind: 'gate.pr', dependsOn: ['commit'], inputs: {} },
    ],
    allowedModels: { analyze: ['worker'], edit: ['worker'] },
    permissions: { tools: ['read', 'edit', 'runVerify'], write: ['src/**'], approvals: ['open_pr'] },
    budget: { usd: 1 },
    origin: 'generated',
    status: 'candidate',
    goalKinds: ['fix-failing-test'],
  };
}

const goal = (): AchievementGoal => ({
  id: 'g_1',
  statement: 'make the failing test pass',
  check: { command: 'npm test', timeoutSec: 300 },
  commitment: 'single-minded',
  status: 'open',
  evidence: [],
});

describe('goal lifecycle', () => {
  const legal: Array<[GoalStatus, GoalStatus]> = [
    ['open', 'achieved'],
    ['open', 'dropped'],
    ['achieved', 'demoted'],
    ['demoted', 'achieved'],
    ['demoted', 'dropped'],
  ];
  const all: GoalStatus[] = ['open', 'achieved', 'demoted', 'dropped'];
  for (const from of all) {
    for (const to of all) {
      const ok = legal.some(([f, t]) => f === from && t === to);
      it(`${from} → ${to} is ${ok ? 'legal' : 'illegal'}`, () => {
        const g = { ...goal(), status: from };
        if (ok) expect(transitionGoal(g, to, ['ev1']).evidence).toEqual(['ev1']);
        else expect(() => transitionGoal(g, to)).toThrow(IllegalTransition);
      });
    }
  }
});

describe('goal achievement needs evidence and a well-formed proof (D4)', () => {
  const proof = { command: 'npm test', exitCode: 0 as const, fingerprint: 'fp1', evidenceKey: 'verify:r:1', verifiedAt: 5 };
  it('open → achieved without evidence throws IllegalTransition', () => {
    expect(() => transitionGoal(goal(), 'achieved')).toThrow(IllegalTransition);
    expect(() => transitionGoal(goal(), 'achieved', [])).toThrow(/non-empty evidence/);
    expect(() => transitionGoal(goal(), 'achieved', [''])).toThrow(/non-empty evidence/);
    expect(() => transitionGoal({ ...goal(), status: 'demoted' }, 'achieved')).toThrow(IllegalTransition);
  });
  it('a proof is kept on the achieved goal; a malformed proof or another command throws; demotion clears it', () => {
    const g = transitionGoal(goal(), 'achieved', ['ev1', proof.evidenceKey], proof);
    expect(g).toMatchObject({ status: 'achieved', proof });
    for (const bad of [{ ...proof, exitCode: 1 }, { ...proof, fingerprint: '' }, { ...proof, evidenceKey: '' }, { ...proof, command: 'true' }, { ...proof, verifiedAt: Number.NaN }]) {
      expect(() => transitionGoal(goal(), 'achieved', ['ev1'], bad as never), JSON.stringify(bad)).toThrow(IllegalTransition);
    }
    expect(achievementProofProblem(proof, goal().check)).toBeNull();
    expect(achievementProofProblem(undefined)).toMatch(/no proof/);
    expect(transitionGoal(g, 'demoted', ['gate']).proof).toBeUndefined();
  });
});

describe('intention lifecycle', () => {
  const legal: Array<[IntentionStatus, IntentionStatus]> = [
    ['committed', 'running'],
    ['committed', 'dropped'],
    ['running', 'held'],
    ['running', 'done'],
    ['running', 'failed'],
    ['running', 'dropped'],
    ['held', 'running'],
    ['held', 'dropped'],
    ['held', 'failed'],
    ['failed', 'committed'],
  ];
  const all: IntentionStatus[] = ['committed', 'running', 'held', 'done', 'dropped', 'failed'];
  for (const from of all) {
    for (const to of all) {
      const ok = legal.some(([f, t]) => f === from && t === to);
      it(`${from} → ${to} is ${ok ? 'legal' : 'illegal'}`, () => {
        const i = { ...newIntention({ id: 'i', goalId: 'g', plan: samplePlan(), commitment: 'single-minded' }), status: from };
        if (ok) expect(transitionIntention(i, to).status).toBe(to);
        else expect(() => transitionIntention(i, to)).toThrow(IllegalTransition);
      });
    }
  }

  it('a retry increments the attempt', () => {
    const i = { ...newIntention({ id: 'i', goalId: 'g', plan: samplePlan(), commitment: 'blind' }), status: 'failed' as const };
    expect(transitionIntention(i, 'committed').attempt).toBe(2);
  });
});

describe('step lifecycle and readiness', () => {
  it('only dependency-satisfied pending steps are ready', () => {
    const plan = samplePlan();
    let i = newIntention({ id: 'i', goalId: 'g', plan, commitment: 'single-minded' });
    expect(readySteps(plan, i).map((s) => s.id)).toEqual(['analyze']);
    i = transitionStep(i, 'analyze', 'ready');
    i = transitionStep(i, 'analyze', 'running');
    i = transitionStep(i, 'analyze', 'done');
    expect(readySteps(plan, i).map((s) => s.id)).toEqual(['edit']);
  });

  it('rejects illegal step edges and unknown steps', () => {
    const i = newIntention({ id: 'i', goalId: 'g', plan: samplePlan(), commitment: 'single-minded' });
    expect(() => transitionStep(i, 'analyze', 'done')).toThrow(IllegalTransition);
    expect(() => transitionStep(i, 'nope', 'ready')).toThrow(IllegalTransition);
    const edges: Array<[StepStatus, StepStatus, boolean]> = [
      ['held', 'running', true],
      ['failed', 'ready', true],
      ['done', 'ready', false],
      ['cancelled', 'ready', false],
    ];
    for (const [from, to, ok] of edges) {
      const j = { ...i, stepStatus: { ...i.stepStatus, analyze: from } };
      if (ok) expect(transitionStep(j, 'analyze', to).stepStatus.analyze).toBe(to);
      else expect(() => transitionStep(j, 'analyze', to)).toThrow(IllegalTransition);
    }
  });
});

describe('validatePlanShape', () => {
  it('accepts the sample plan', () => {
    expect(validatePlanShape(samplePlan())).toEqual([]);
  });
  it('reports duplicates, unknown deps, cycles, bad allowedModels, size', () => {
    const p = samplePlan();
    p.steps.push({ id: 'analyze', kind: 'worker', dependsOn: ['ghost'], inputs: {} });
    p.allowedModels.phantom = ['worker'];
    const errs = validatePlanShape(p);
    expect(errs.join('\n')).toMatch(/duplicate step id analyze/);
    expect(errs.join('\n')).toMatch(/unknown ghost/);
    expect(errs.join('\n')).toMatch(/unknown step phantom/);
    const cyc = samplePlan();
    cyc.steps[0]!.dependsOn = ['commit'];
    expect(validatePlanShape(cyc)).toContain('plan steps contain a dependency cycle');
    const empty = { ...samplePlan(), steps: [], allowedModels: {} };
    expect(validatePlanShape(empty)).toContain('plan has no steps');
  });
});

describe('gate.pr and writing steps', () => {
  it('gate.pr is a step kind; unknown kinds are refused by validatePlanShape; isWritingStep follows the effective tools', () => {
    const p = samplePlan();
    expect(validatePlanShape(p)).toEqual([]);
    (p.steps[0] as { kind: string }).kind = 'gate.merge';
    expect(validatePlanShape(p).join('\n')).toMatch(/unknown kind gate.merge/);
    const q = samplePlan();
    q.steps[0]!.tools = ['read'];
    expect(isWritingStep(q, q.steps[0]!)).toBe(false);
    expect(isWritingStep(q, q.steps[1]!)).toBe(true);
    expect(isWritingStep(q, q.steps[2]!)).toBe(false);
  });
});

describe('step tool narrowing', () => {
  it('validatePlanShape rejects step tools outside plan.permissions.tools; effectiveStepTools intersects', async () => {
    const { effectiveStepTools } = await import('./bdi.js');
    const p = samplePlan();
    p.permissions = { tools: ['read', 'edit'], write: [], approvals: [] };
    p.steps[0]!.tools = ['read'];
    expect(validatePlanShape(p)).toEqual([]);
    expect(effectiveStepTools(p, p.steps[0]!)).toEqual(['read']);
    expect(effectiveStepTools(p, p.steps[1]!)).toEqual(['read', 'edit']);
    p.steps[1]!.tools = ['read', 'git_push'];
    expect(validatePlanShape(p).join('\n')).toMatch(/step edit tool git_push is not in plan.permissions.tools/);
    p.steps[1]!.tools = 'read' as unknown as string[];
    expect(validatePlanShape(p).join('\n')).toMatch(/tools must be an array/);
  });
});
