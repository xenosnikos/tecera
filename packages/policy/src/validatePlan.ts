import { isWritingStep, type Budget, type Manifest, type Plan, type Step } from '@tecera/contracts';
import { writesWithin } from './diffBoundary.js';
import { matchesAny } from './glob.js';
import { classify, type PermissionsDoc } from './permissions.js';

/**
 * A generated plan may never exceed what the manifest and permissions allow. Shape validation
 * (`validatePlanShape` in contracts) runs first; this checks the authority boundary and the delivery chain.
 */
export interface PlanValidationOptions {
  toolCatalog: readonly string[];
  permissions: PermissionsDoc;
  goalHasCheck: boolean;
}

/** The delivery chain every code-changing plan must end with (D6). */
export const DELIVERY_CHAIN = ['worker', 'gate.verify', 'gate.review', 'gate.verify', 'gate.commit', 'gate.pr'] as const;

export function validatePlan(plan: Plan, m: Manifest, opts: PlanValidationOptions): string[] {
  const errors: string[] = [];

  for (const t of plan.permissions.tools) {
    if (!opts.toolCatalog.includes(t)) errors.push(`unknown tool ${t}`);
    if (classify(t, opts.permissions) === 'never') errors.push(`tool ${t} is never allowed`);
  }
  for (const w of writesWithin(plan.permissions.write, m.repo.allowedChanges)) errors.push(`write glob ${w} is outside allowedChanges`);
  for (const w of plan.permissions.write) {
    const prot = matchesAny(w, m.policy.protectedPaths);
    if (prot) errors.push(`write glob ${w} targets a protected path (${prot})`);
  }

  const budgetKeys: Array<keyof Omit<Budget, never>> = ['usd', 'tokens', 'wallClockSec', 'maxDepth', 'maxIterations', 'maxAttempts', 'maxChangedFiles'];
  for (const k of budgetKeys) {
    const v = plan.budget[k];
    const cap = m.budgets[k];
    if (typeof v === 'number' && typeof cap === 'number' && v > cap) errors.push(`budget.${k} ${v} exceeds manifest ${cap}`);
  }

  const workerSeats = new Set(m.seats.workers.map((w) => w.id));
  for (const [stepId, seats] of Object.entries(plan.allowedModels)) {
    for (const s of seats) if (!workerSeats.has(s)) errors.push(`allowedModels[${stepId}] references unknown worker seat ${s}`);
  }

  const kinds = new Set(plan.steps.map((s) => s.kind));
  if (opts.goalHasCheck && !kinds.has('gate.verify')) errors.push('plan has no gate.verify step but the goal has an environmental check');
  errors.push(...deliveryChainProblems(plan));
  if (kinds.has('gate.pr') && !plan.permissions.approvals.includes('open_pr')) errors.push("a gate.pr needs the human approval 'open_pr' declared in permissions.approvals");
  for (const a of plan.permissions.approvals) {
    if (classify(a, opts.permissions) === 'never') errors.push(`approval for ${a} cannot be granted: action is never allowed`);
  }
  if (kinds.has('subgoal')) errors.push('subgoal steps are not supported yet');
  return errors;
}

/**
 * D6: a plan that changes code (a writing worker step, a commit or a PR) must end
 * worker → gate.verify → gate.review → gate.verify → gate.commit → gate.pr: exactly one commit and one PR;
 * the PR depends on the commit, the commit on a verify, that verify on a review, that review on a verify
 * which comes after every writing worker; no writing worker runs after that first verify; and the PR is the
 * plan's last step (every other step is upstream of it). Read-only plans need none of it.
 */
export function deliveryChainProblems(plan: Plan): string[] {
  const writers = plan.steps.filter((s) => isWritingStep(plan, s));
  const commits = plan.steps.filter((s) => s.kind === 'gate.commit');
  const prs = plan.steps.filter((s) => s.kind === 'gate.pr');
  if (writers.length === 0 && commits.length === 0 && prs.length === 0) return [];
  const chain = DELIVERY_CHAIN.join(' → ');
  const errors: string[] = [];
  if (commits.length !== 1) errors.push(`a plan that changes code needs exactly one gate.commit (found ${commits.length}); it must end ${chain}`);
  if (prs.length !== 1) errors.push(`a plan that changes code needs exactly one gate.pr (found ${prs.length}); it must end ${chain}`);
  if (errors.length) return errors;
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const pr = prs[0]!;
  const commit = commits[0]!;
  const directUp = (s: Step, kind: Step['kind']): Step | undefined => s.dependsOn.map((d) => byId.get(d)).find((d): d is Step => d?.kind === kind);
  if (!pr.dependsOn.includes(commit.id)) errors.push(`gate.pr ${pr.id} must depend on gate.commit ${commit.id} (${chain})`);
  const v2 = directUp(commit, 'gate.verify');
  if (!v2) return [...errors, `gate.commit ${commit.id} must depend on a gate.verify (${chain})`];
  const review = directUp(v2, 'gate.review');
  if (!review) return [...errors, `gate.verify ${v2.id} before the commit must depend on a gate.review (${chain})`];
  const v1 = directUp(review, 'gate.verify');
  if (!v1) return [...errors, `gate.review ${review.id} must depend on a gate.verify (${chain})`];
  const up = ancestors(plan, v1.id);
  for (const w of writers) if (!up.has(w.id)) errors.push(`writing step ${w.id} is not verified before review: ${v1.id} must come after it (${chain})`);
  if (writers.length === 0) errors.push(`a commit or PR without a writing worker step has nothing to deliver (${chain})`);
  const toPr = ancestors(plan, pr.id);
  for (const s of plan.steps) if (s.id !== pr.id && !toPr.has(s.id)) errors.push(`step ${s.id} runs outside the delivery chain: gate.pr ${pr.id} must be the plan's last step`);
  return errors;
}

/** Every step `id` depends on, transitively. */
function ancestors(plan: Plan, id: string): Set<string> {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const out = new Set<string>();
  const stack = [...(byId.get(id)?.dependsOn ?? [])];
  while (stack.length) {
    const d = stack.pop()!;
    if (out.has(d)) continue;
    out.add(d);
    stack.push(...(byId.get(d)?.dependsOn ?? []));
  }
  return out;
}
