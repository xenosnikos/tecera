import type { AchievementGoal, BeliefProjection, Intention, Plan, Planner, TeceraEvent } from '@tecera/contracts';
import { PlanRejected } from './llmPlanner.js';
import { planId } from './schema.js';

/**
 * A planner with no model, for other packages' tests and offline e2e. It returns canned plans either
 * in order (the last one repeats once the list is exhausted) or by goal kind (the first plan whose
 * goalKinds include the goal's kind; none → PlanRejected, fail closed). It does not validate: the loop
 * does. Every returned plan is a fresh deep copy stamped origin 'generated', status 'candidate'.
 */

export interface ScriptedPlannerOptions {
  plans: readonly Plan[];
  /** 'order' (default) or 'goalKind'. */
  mode?: 'order' | 'goalKind';
  /** Goal kind for 'goalKind' mode. Default: goal.id (goal files use the kind as id, e.g. fix-failing-test). */
  goalKindOf?: (goal: AchievementGoal, e: TeceraEvent) => string;
  /** Deliberation choice; default first option. */
  choose?: (options: Plan[], intentions: Intention[]) => Plan | undefined;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class ScriptedPlanner implements Planner {
  writes = 0;
  deliberations = 0;
  readonly calls: Array<{ event: TeceraEvent; goal: AchievementGoal; planId: string }> = [];
  private readonly o: ScriptedPlannerOptions;

  constructor(plans: readonly Plan[] | ScriptedPlannerOptions) {
    this.o = Array.isArray(plans) ? { plans: plans as readonly Plan[] } : (plans as ScriptedPlannerOptions);
    if (this.o.plans.length === 0) throw new Error('ScriptedPlanner needs at least one plan');
  }

  async write(e: TeceraEvent, _beliefs: BeliefProjection, goal: AchievementGoal): Promise<Plan> {
    const n = this.writes++;
    let chosen: Plan | undefined;
    if (this.o.mode === 'goalKind') {
      const kind = this.o.goalKindOf ? this.o.goalKindOf(goal, e) : goal.id;
      chosen = this.o.plans.find((p) => p.goalKinds.includes(kind));
      if (!chosen) throw new PlanRejected([`no scripted plan for goal kind ${kind}`], undefined, 1);
    } else {
      chosen = this.o.plans[Math.min(n, this.o.plans.length - 1)]!;
    }
    const plan: Plan = { ...clone(chosen), origin: 'generated', status: 'candidate' };
    this.calls.push({ event: e, goal, planId: plan.id });
    return plan;
  }

  async deliberate(options: Plan[], intentions: Intention[]): Promise<Plan> {
    this.deliberations++;
    const first = options[0];
    if (!first) throw new Error('deliberate called with no options');
    return this.o.choose?.(options, intentions) ?? first;
  }
}

/** The analyze step's tools: no edit tool (runVerify still counts as a writing tool for the delivery chain). */
const ANALYZE_TOOLS = ['read', 'listFiles', 'runVerify'];

function samplePlan(): Plan {
  const body: Omit<Plan, 'id' | 'origin' | 'status' | 'rationale'> = {
    trigger: { kind: 'goal.adopted' },
    context: [],
    steps: [
      {
        id: 'analyze',
        kind: 'worker',
        dependsOn: [],
        inputs: {},
        tools: [...ANALYZE_TOOLS],
        instruction:
          'Run verify and read the failing assertion, then read the implementation under test. Do not edit anything. Return {"facts":[{"key":"rootCause","value":"<one sentence>"},{"key":"targetFiles","value":["src/..."]}]}.',
        output: {
          type: 'object',
          required: ['facts'],
          properties: {
            facts: {
              type: 'array',
              items: { type: 'object', required: ['key', 'value'], properties: { key: { type: 'string' }, value: {} } },
            },
          },
        },
      },
      {
        id: 'edit',
        kind: 'worker',
        dependsOn: ['analyze'],
        inputs: {},
        tools: ['read', 'listFiles', 'edit', 'runVerify'],
        instruction:
          'Fix the root cause with the smallest diff under src/**. Never edit tests, configs or lockfiles. Run verify before returning. Return {"facts":[{"key":"changedFiles","value":["src/..."]}]}.',
        output: {
          type: 'object',
          required: ['facts'],
          properties: { facts: { type: 'array', items: { type: 'object', required: ['key', 'value'] } } },
        },
      },
      { id: 'verify', kind: 'gate.verify', dependsOn: ['edit'], inputs: {} },
      { id: 'review', kind: 'gate.review', dependsOn: ['verify'], inputs: {} },
      { id: 'verify2', kind: 'gate.verify', dependsOn: ['review'], inputs: {} },
      { id: 'commit', kind: 'gate.commit', dependsOn: ['verify2'], inputs: {} },
      { id: 'pr', kind: 'gate.pr', dependsOn: ['commit'], inputs: {} },
    ],
    allowedModels: { analyze: ['worker'], edit: ['worker'] },
    // D6: the commit lands on the work branch without approval; the PR gate consumes the one human approval.
    permissions: { tools: ['read', 'listFiles', 'edit', 'runVerify'], write: ['src/**'], approvals: ['open_pr'] },
    // Every field stated (the effective budget for the sample goal: manifest ∩ goal {usd 2, wallClockSec 1200}).
    budget: { usd: 1.5, tokens: 150000, wallClockSec: 1200, maxDepth: 2, maxIterations: 20, maxAttempts: 2, maxChangedFiles: 3 },
    goalKinds: ['fix-failing-test'],
  };
  return {
    id: planId(body),
    ...body,
    origin: 'generated',
    status: 'candidate',
    rationale: 'Read before writing; one worker edits src/** only; verify, foreign review, verify again, commit to the work branch, then a pull request held for human approval.',
  };
}

/**
 * The first job's plan (D6 delivery chain): analyze (no edit tool) → edit → verify → review → verify2 →
 * commit (work branch, no approval) → pr (the human approval, bound to the commit sha). Every worker names
 * the sample's `worker` seat; every budget field is stated.
 */
export const SAMPLE_FIX_FAILING_TEST_PLAN: Readonly<Plan> = Object.freeze(samplePlan());

/** A fresh mutable copy of the sample plan. */
export function sampleFixFailingTestPlan(): Plan {
  return clone(SAMPLE_FIX_FAILING_TEST_PLAN) as Plan;
}
