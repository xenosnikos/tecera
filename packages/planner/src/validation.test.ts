import { describe, expect, it } from 'vitest';
import { effectiveStepTools, makeRedactor, validatePlanShape, type Plan, type Step } from '@tecera/contracts';
import { validatePlan } from '@tecera/policy';
import { budgetIssues, effectiveCeilings, materializeBudget } from './budget.js';
import { createPlanValidator, DEFAULT_TOOL_CATALOG, plannerChecks, stepMayWrite, validateCandidate } from './checks.js';
import { goal, goodDoc, sampleManifest, samplePermissions } from './fixtures.testkit.js';
import { SAMPLE_FIX_FAILING_TEST_PLAN, sampleFixFailingTestPlan } from './scripted.js';
import { PLAN_DOCUMENT_JSON_SCHEMA, PlanDocumentSchema, planId, toPlan } from './schema.js';

const m = sampleManifest();
const permissions = samplePermissions();
const opts = { manifest: m, goal, permissions, toolCatalog: DEFAULT_TOOL_CATALOG };
const issues = (p: Plan) => validateCandidate(p, opts).join('\n');
const step = (p: Plan, id: string): Step => p.steps.find((s) => s.id === id)!;
const validator = createPlanValidator({ permissions });

describe('SAMPLE_FIX_FAILING_TEST_PLAN', () => {
  it('passes shape, policy, planner checks and the goal-aware validator against samples/fix-failing-test', () => {
    const p = sampleFixFailingTestPlan();
    expect(validatePlanShape(p)).toEqual([]);
    expect(validatePlan(p, m, { toolCatalog: DEFAULT_TOOL_CATALOG, permissions, goalHasCheck: true })).toEqual([]);
    expect(plannerChecks(p, permissions, { workerSeats: ['worker'] })).toEqual([]);
    expect(validateCandidate(p, opts)).toEqual([]);
    expect(validator.validatePlan(p, m, goal)).toEqual([]);
  });

  it('is the connected D6 delivery chain (… → commit → pr), narrows analyze with Step.tools and states every budget field', () => {
    const p = SAMPLE_FIX_FAILING_TEST_PLAN;
    expect(p.steps.map((s) => `${s.id}:${s.kind}<${s.dependsOn.join(',')}`)).toEqual([
      'analyze:worker<',
      'edit:worker<analyze',
      'verify:gate.verify<edit',
      'review:gate.review<verify',
      'verify2:gate.verify<review',
      'commit:gate.commit<verify2',
      'pr:gate.pr<commit',
    ]);
    expect(p.allowedModels).toEqual({ analyze: ['worker'], edit: ['worker'] });
    expect(p.permissions).toEqual({ tools: ['read', 'listFiles', 'edit', 'runVerify'], write: ['src/**'], approvals: ['open_pr'] });
    expect(p.goalKinds).toEqual(['fix-failing-test']);
    for (const s of p.steps) expect(s.inputs).toEqual({});
    expect(effectiveStepTools(p, p.steps[0]!)).toEqual(['read', 'listFiles', 'runVerify']);
    // runVerify is outside the contracts READ_ONLY_TOOLS (a test run can write), so analyze counts as writing
    // and sits upstream of the first verify, as the chain requires.
    expect(stepMayWrite(p, p.steps[0]!)).toBe(true);
    expect(stepMayWrite(p, p.steps[1]!)).toBe(true);
    expect(stepMayWrite(p, { ...p.steps[0]!, tools: ['read', 'listFiles'] })).toBe(false);
    expect(p.id).toMatch(/^p_[0-9a-f]{8}$/);
    expect(p.id).toBe(planId(p));
    expect(Object.isFrozen(p)).toBe(true);
    const eff = effectiveCeilings(m, goal).ceilings;
    expect(Object.keys(p.budget).sort()).toEqual(Object.keys(eff).sort());
    for (const [k, v] of Object.entries(p.budget)) expect(v).toBeLessThanOrEqual(eff[k as keyof typeof eff]);
  });
});

describe('connected gate chain (Codex finding 1)', () => {
  it('rejects the parallel verify/review counterexample: earlyVerify → edit → {lateVerify, review} → commit', () => {
    const p = sampleFixFailingTestPlan();
    p.steps = [
      step(p, 'analyze'),
      { id: 'earlyVerify', kind: 'gate.verify', dependsOn: ['analyze'], inputs: {} },
      { ...step(p, 'edit'), dependsOn: ['earlyVerify'] },
      { id: 'lateVerify', kind: 'gate.verify', dependsOn: ['edit'], inputs: {} },
      { id: 'review', kind: 'gate.review', dependsOn: ['earlyVerify', 'edit'], inputs: {} },
      { id: 'commit', kind: 'gate.commit', dependsOn: ['lateVerify', 'review'], inputs: {} },
      { id: 'pr', kind: 'gate.pr', dependsOn: ['commit'], inputs: {} },
    ];
    p.id = planId(p);
    // policy alone rejects it too now (D6 deliveryChainProblems follows direct links); the planner names why.
    expect(validatePlan(p, m, { toolCatalog: DEFAULT_TOOL_CATALOG, permissions, goalHasCheck: true }).length).toBeGreaterThan(0);
    const out = issues(p);
    expect(out).toMatch(/review step review must depend on a verify step that runs after every worker step/);
    expect(out).toMatch(/commit step commit: no preceding review step depends on a verify that runs after every worker step/);
    expect(validator.validatePlan(p, m, goal).length).toBeGreaterThan(0);
  });

  it('rejects verify → review → commit without the second verify after the review', () => {
    const p = sampleFixFailingTestPlan();
    p.steps = p.steps.filter((s) => s.id !== 'verify2');
    step(p, 'commit').dependsOn = ['review'];
    expect(issues(p)).toMatch(/commit step commit: no verify step runs after the review/);
  });

  it('rejects a second verify that runs beside the review instead of after it', () => {
    const p = sampleFixFailingTestPlan();
    step(p, 'verify2').dependsOn = ['verify'];
    step(p, 'commit').dependsOn = ['verify2', 'review'];
    expect(issues(p)).toMatch(/no verify step runs after the review/);
  });

  it('rejects a chain that does not depend on the writing step', () => {
    const p = sampleFixFailingTestPlan();
    p.steps.push({ id: 'edit2', kind: 'worker', dependsOn: ['analyze'], inputs: {}, instruction: 'also edit' });
    p.allowedModels.edit2 = ['worker'];
    const out = issues(p);
    expect(out).toMatch(/commit step commit must depend on every worker step \(not: edit2\)/);
    expect(out).toMatch(/worker step edit2 may write but no commit chain depends on it/);
    expect(out).toMatch(/no preceding verify step runs after every worker step/);
  });

  it('rejects a commit with no chain at all, and a writing plan with no commit', () => {
    const noVerify = sampleFixFailingTestPlan();
    noVerify.steps = noVerify.steps.filter((s) => s.kind !== 'gate.verify');
    step(noVerify, 'review').dependsOn = ['edit'];
    step(noVerify, 'commit').dependsOn = ['review'];
    const out = issues(noVerify);
    expect(out).toMatch(/plan has no gate.verify step but the goal has an environmental check/);
    expect(out).toMatch(/gate.commit commit must depend on a gate.verify/);
    expect(out).toMatch(/commit step commit has no preceding verify step/);

    const workersOnly = sampleFixFailingTestPlan();
    workersOnly.steps = workersOnly.steps.filter((s) => s.kind === 'worker');
    workersOnly.permissions.write = [];
    expect(validateCandidate(workersOnly, { ...opts, goalHasCheck: false }).join('\n')).toMatch(
      /a plan that can change code \(worker step\(s\) analyze, edit may write\) must end in gate.verify → gate.review → gate.verify → gate.commit → gate.pr/,
    );
  });

  it('D6: a writing plan without the gate.pr step, or with the PR not last, not after the commit, or without open_pr is rejected', () => {
    const noPr = sampleFixFailingTestPlan();
    noPr.steps = noPr.steps.filter((s) => s.kind !== 'gate.pr');
    expect(issues(noPr)).toMatch(/must end in gate.verify → gate.review → gate.verify → gate.commit → gate.pr/);
    expect(issues(noPr)).toMatch(/needs exactly one gate.pr \(found 0\)/);

    const afterPr = sampleFixFailingTestPlan();
    afterPr.steps.push({ id: 'late', kind: 'gate.verify', dependsOn: ['pr'], inputs: {} });
    expect(issues(afterPr)).toMatch(/pr step pr must be the last step \(late depend on it\)/);

    const prBeside = sampleFixFailingTestPlan();
    step(prBeside, 'pr').dependsOn = ['verify2'];
    const out = issues(prBeside);
    expect(out).toMatch(/pr step pr must depend directly on the commit step/);
    expect(out).toMatch(/pr step pr must be the plan's single last step \(not downstream of: commit\)/);

    const twoPrs = sampleFixFailingTestPlan();
    twoPrs.steps.push({ id: 'pr2', kind: 'gate.pr', dependsOn: ['commit'], inputs: {} });
    expect(issues(twoPrs)).toMatch(/plan has 2 pr steps; exactly one is allowed/);

    const noApproval = sampleFixFailingTestPlan();
    noApproval.permissions.approvals = [];
    expect(issues(noApproval)).toMatch(/gate.pr needs the human approval 'open_pr' declared in permissions.approvals/);

    const prOnly = sampleFixFailingTestPlan();
    prOnly.steps = [step(prOnly, 'analyze'), { id: 'pr', kind: 'gate.pr', dependsOn: ['analyze'], inputs: {} }];
    prOnly.allowedModels = { analyze: ['worker'] };
    prOnly.permissions.write = [];
    expect(plannerChecks(prOnly, permissions).join('\n')).toMatch(/pr step pr must depend directly on the commit step/);
  });

  it('a commit followed by anything but the PR, two commits', () => {
    const p = sampleFixFailingTestPlan();
    p.steps.push({ id: 'late', kind: 'worker', dependsOn: ['commit'], inputs: {}, instruction: 'x' }, { id: 'commit2', kind: 'gate.commit', dependsOn: ['late'], inputs: {} });
    p.allowedModels.late = ['worker'];
    const out = issues(p);
    expect(out).toMatch(/commit step commit may only be followed by the gate.pr step \(late depend on it\)/);
    expect(out).toMatch(/plan has 2 commit steps/);
  });

  it('a read-only plan (no write globs, read-only tools, no commit or PR) needs no chain', () => {
    const p = sampleFixFailingTestPlan();
    p.steps = [{ ...step(p, 'analyze'), tools: ['read', 'listFiles'] }, { id: 'verify', kind: 'gate.verify', dependsOn: ['analyze'], inputs: {} }];
    p.allowedModels = { analyze: ['worker'] };
    p.permissions = { tools: ['read', 'listFiles'], write: [], approvals: [] };
    expect(plannerChecks(p, permissions)).toEqual([]);
    expect(validatePlan(p, m, { toolCatalog: DEFAULT_TOOL_CATALOG, permissions, goalHasCheck: true })).toEqual([]);
  });

  it('a runVerify-only worker counts as writing (contracts READ_ONLY_TOOLS) and needs the chain', () => {
    const p = sampleFixFailingTestPlan();
    p.steps = [step(p, 'analyze'), { id: 'verify', kind: 'gate.verify', dependsOn: ['analyze'], inputs: {} }];
    p.allowedModels = { analyze: ['worker'] };
    p.permissions = { tools: ['read', 'listFiles', 'runVerify'], write: [], approvals: [] };
    expect(plannerChecks(p, permissions).join('\n')).toMatch(/worker step\(s\) analyze may write\) must end in/);
  });
});

describe('worker seat restrictions (Codex finding 6)', () => {
  it('a missing or empty allowedModels entry never means "any seat"', () => {
    const missing = sampleFixFailingTestPlan();
    delete missing.allowedModels.edit;
    expect(issues(missing)).toMatch(/allowedModels\[edit\] is missing/);
    expect(validator.validatePlan(missing, m, goal).join('\n')).toMatch(/allowedModels\[edit\] is missing/);
    const empty = sampleFixFailingTestPlan();
    empty.allowedModels.analyze = [];
    expect(issues(empty)).toMatch(/allowedModels\[analyze\] is empty: an empty list never means "any seat"/);
  });

  it('seats outside the manifest or the allowed subset are rejected; gates carry no seats', () => {
    const p = sampleFixFailingTestPlan();
    p.allowedModels.edit = ['worker', 'opus-max'];
    p.allowedModels.verify = ['worker'];
    const out = issues(p);
    expect(out).toMatch(/allowedModels\[edit\] references unknown worker seat opus-max/);
    expect(out).toMatch(/allowedModels\[edit\] seat opus-max is not an allowed worker seat/);
    expect(out).toMatch(/allowedModels\[verify\]: only worker steps/);
    expect(validateCandidate(sampleFixFailingTestPlan(), { ...opts, workerSeats: ['other'] }).join('\n')).toMatch(/seat worker is not an allowed worker seat/);
  });
});

describe('per-step tools (Step.tools)', () => {
  it('widening, gate tools and the old inputs.tools convention are rejected', () => {
    const p = sampleFixFailingTestPlan();
    step(p, 'analyze').tools = ['read', 'shell'];
    step(p, 'verify').tools = ['read'];
    step(p, 'edit').inputs = { tools: ['read'] };
    const out = issues(p);
    expect(out).toMatch(/step analyze tool shell is not in plan.permissions.tools/);
    expect(out).toMatch(/step analyze tools widens the plan: shell/);
    expect(out).toMatch(/step verify: only worker steps may set tools/);
    expect(out).toMatch(/step edit sets inputs.tools, which is not honoured/);
  });
});

describe('effective budgets (Codex finding 2)', () => {
  const tight = { ...goal, budget: { usd: 0.01 } };

  it('materialises omitted fields to min(manifest, goal), never unlimited', () => {
    const { budget, issues: errs } = materializeBudget({}, m, tight);
    expect(errs).toEqual([]);
    expect(budget).toEqual({ usd: 0.01, tokens: 200000, wallClockSec: 1200, maxDepth: 3, maxIterations: 20, maxAttempts: 2, maxChangedFiles: 5 });
    expect(materializeBudget({ usd: 0.5 }, m, tight).issues).toEqual(['budget.usd 0.5 exceeds goal budget 0.01']);
    expect(materializeBudget({ tokens: 300000 }, m, tight).issues).toEqual(['budget.tokens 300000 exceeds manifest 200000']);
  });

  it('a goal budget that is not a valid limit fails closed', () => {
    for (const bad of [{ usd: -1 }, { usd: Number.NaN }, { tokens: 1.5 }, { usd: '1' as unknown as number }]) {
      expect(materializeBudget({}, m, { budget: bad }).issues.join()).toMatch(/goal budget\.\w+ is not a valid limit; refusing/);
    }
  });

  it('the loop validator rejects a reused plan whose omitted field would fall back above the goal ceiling', () => {
    const reused: Plan = { ...sampleFixFailingTestPlan(), origin: 'graduated', status: 'accepted', budget: {} };
    expect(validator.validatePlan(reused, m, goal)).toEqual([]); // goal usd 2 = manifest; omitted is fine
    expect(validator.validatePlan(reused, m, tight).join('\n')).toMatch(/budget.usd is omitted, so the run would get manifest 2, which exceeds goal budget 0.01/);
    const generated: Plan = { ...sampleFixFailingTestPlan(), budget: { usd: 1 } };
    expect(validator.validatePlan(generated, m, goal).join('\n')).toMatch(/budget.tokens is missing; a generated plan states every budget field/);
    expect(budgetIssues({ budget: { usd: 1.5 } }, m, tight)).toContain('budget.usd 1.5 exceeds goal budget 0.01');
  });

  it('the validator refuses without a goal', () => {
    expect(validator.validatePlan(sampleFixFailingTestPlan(), m, undefined as never)).toEqual(['plan validation needs the goal (budget ceilings and check); refusing']);
  });
});

describe('rejections carry readable issues', () => {
  it('a plan requesting merge', () => {
    const p = sampleFixFailingTestPlan();
    p.permissions.tools.push('merge');
    const out = issues(p);
    expect(out).toMatch(/tool merge is never allowed/);
    expect(out).toMatch(/unknown tool merge/);
  });

  it('a write outside allowedChanges, a protected path, a budget above the manifest', () => {
    const p = sampleFixFailingTestPlan();
    p.permissions.write.push('docs/**', 'src/sum.test.ts');
    p.budget.usd = 5;
    p.budget.maxChangedFiles = 50;
    const out = issues(p);
    expect(out).toMatch(/write glob docs\/\*\* is outside allowedChanges/);
    expect(out).toMatch(/write glob src\/sum.test.ts targets a protected path \(\*\*\/\*\.test\.\*\)/);
    expect(out).toMatch(/budget.usd 5 exceeds manifest 2/);
    expect(out).toMatch(/budget.maxChangedFiles 50 exceeds manifest 5/);
  });

  it('missing instructions; an approval-class tool without a declared approval', () => {
    const p = sampleFixFailingTestPlan();
    delete step(p, 'edit').instruction;
    p.permissions.tools.push('network');
    const out = createPlanValidator({ permissions, toolCatalog: [...DEFAULT_TOOL_CATALOG, 'network'] }).validatePlan(p, m, goal).join('\n');
    expect(out).toMatch(/worker step edit has no instruction/);
    expect(out).toMatch(/tool network requires approval but the plan does not declare it/);
  });

  it('a secret-bearing plan is rejected when a redactor is supplied', () => {
    const p = sampleFixFailingTestPlan();
    step(p, 'edit').instruction = 'use TECERA_CANARY_plan_1 as the token';
    expect(validateCandidate(p, { ...opts, redactor: makeRedactor([]) }).join('\n')).toMatch(/plan contains secret-shaped content \(canary\)/);
  });
});

describe('plan document schema', () => {
  it('is strict at every level and duplicate-free', () => {
    const top = { ...goodDoc(), id: 'p_evil' };
    expect(PlanDocumentSchema.safeParse(top).success).toBe(false);
    const stepX = goodDoc();
    (stepX.steps[0] as Record<string, unknown>).seat = 'x';
    expect(PlanDocumentSchema.safeParse(stepX).success).toBe(false);
    const perm = goodDoc();
    (perm.permissions as Record<string, unknown>).network = true;
    expect(PlanDocumentSchema.safeParse(perm).success).toBe(false);
    const budget = goodDoc();
    (budget.budget as Record<string, unknown>).gpus = 1;
    expect(PlanDocumentSchema.safeParse(budget).success).toBe(false);
    const kind = goodDoc();
    (kind.steps[0] as Record<string, unknown>).kind = 'shell';
    expect(PlanDocumentSchema.safeParse(kind).success).toBe(false);
    expect(PlanDocumentSchema.safeParse({ ...goodDoc(), goalKinds: ['fix-failing-test', 'fix-failing-test'] }).success).toBe(false);
    expect(PlanDocumentSchema.safeParse({ ...goodDoc(), permissions: { tools: ['read', 'read'], write: [], approvals: [] } }).success).toBe(false);
    expect(PlanDocumentSchema.safeParse({ ...goodDoc(), permissions: { tools: ['read'], write: ['src/<untrusted> **'], approvals: [] } }).success).toBe(false);
    expect(PlanDocumentSchema.safeParse(goodDoc()).success).toBe(true);
  });

  it('exports a JSON schema whose required keys and properties match the zod schema', () => {
    const shape = PlanDocumentSchema.shape;
    expect(Object.keys(PLAN_DOCUMENT_JSON_SCHEMA.properties as object).sort()).toEqual(Object.keys(shape).sort());
    expect(PLAN_DOCUMENT_JSON_SCHEMA.additionalProperties).toBe(false);
    const required = (PLAN_DOCUMENT_JSON_SCHEMA.required as string[]).sort();
    const zodRequired = Object.entries(shape)
      .filter(([, v]) => !(v as { isOptional(): boolean }).isOptional())
      .map(([k]) => k)
      .sort();
    expect(required).toEqual(zodRequired);
    const stepProps = Object.keys(((PLAN_DOCUMENT_JSON_SCHEMA.properties as Record<string, { items: { properties: object } }>).steps.items.properties)).sort();
    expect(stepProps).toEqual(Object.keys(PlanDocumentSchema.shape.steps.element.shape).sort());
  });

  it('toPlan stamps a deterministic content id over the materialised budget, the trigger, origin and status', () => {
    const doc = PlanDocumentSchema.parse(goodDoc());
    const { budget } = materializeBudget(doc.budget, m, goal);
    const a = toPlan(doc, { trigger: { kind: 'goal.adopted' }, budget });
    const b = toPlan(PlanDocumentSchema.parse({ ...goodDoc(), rationale: 'different words' }), { trigger: { kind: 'goal.adopted' }, budget });
    expect(a.id).toMatch(/^p_[0-9a-f]{8}$/);
    expect(a.id).toBe(b.id);
    expect(a).toMatchObject({ origin: 'generated', status: 'candidate', trigger: { kind: 'goal.adopted' }, context: [] });
    expect(a.steps[0]!.tools).toEqual(['read', 'listFiles', 'runVerify']);
    // omitting a field and stating its ceiling give the same plan
    const explicit = PlanDocumentSchema.parse({ ...goodDoc(), budget });
    expect(toPlan(explicit, { trigger: { kind: 'goal.adopted' }, budget: materializeBudget(explicit.budget, m, goal).budget }).id).toBe(a.id);
    const c = toPlan(doc, { trigger: { kind: 'goal.adopted' }, budget: { ...budget, usd: 1.5 } });
    expect(c.id).not.toBe(a.id);
    expect(validateCandidate(a, opts)).toEqual([]);
  });
});
