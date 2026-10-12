import { changeWithin, contractHash, contractProblem, envelopeProblem, isWritingStep, resolveGap, type AchievementGoal, type ChangePath, type Criterion, type Budget, type CapabilityRecord, type Manifest, type Plan, type PlanningContext, type ProvisioningAllowance, type Step } from '@tecera/contracts';
import { writesWithin } from './diffBoundary.js';
import { globWithin, matchesAny, matchesProtected } from './glob.js';
import { APPROVAL_ONLY_ACTIONS, OBSOLETE_WRITE_APPROVALS, PR_GATE_ACTIONS, classify, type PermissionsDoc } from './permissions.js';
import { allowanceOf } from './provisioning.js';

/**
 * A generated plan may never exceed what the manifest and permissions allow. Shape validation
 * (`validatePlanShape` in contracts) runs first; this checks the authority boundary, the delivery chain and,
 * under an acceptance contract, that the plan was written for the accepted contract and the capabilities
 * the run actually has.
 */
export interface PlanValidationOptions {
  toolCatalog: readonly string[];
  permissions: PermissionsDoc;
  goalHasCheck: boolean;
  /**
   * The accepted contract and the run's capability inventory (the PlanValidator port's `ctx`). Absent = the
   * single-check path, unless `goal` carries criteria (a goal file), which are then checked the same way.
   */
  context?: PlanningContext;
  goal?: AchievementGoal;
}

/** The delivery chain every code-changing plan must end with (D6). */
export const DELIVERY_CHAIN = ['worker', 'gate.verify', 'gate.review', 'gate.verify', 'gate.commit', 'gate.pr'] as const;

/** The approvals a plan containing gate.pr declares (D6): the one commit-bound human grant covers both. */
export const PR_APPROVALS = ['open_pr', 'git_push'] as const;

export function validatePlan(plan: Plan, m: Manifest, opts: PlanValidationOptions): string[] {
  const errors: string[] = [];

  for (const t of plan.permissions.tools) {
    if (!opts.toolCatalog.includes(t)) errors.push(`unknown tool ${t}`);
    if (classify(t, opts.permissions) === 'never') errors.push(`tool ${t} is never allowed`);
    if (APPROVAL_ONLY_ACTIONS.has(t)) errors.push(`tool ${t} is a human approval, never a tool a plan or worker holds`);
    else if (PR_GATE_ACTIONS.has(t)) errors.push(`tool ${t} happens only at the gate.pr step, on its human approval`);
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
  // D6 (sprint 5 item 5): gate.pr pushes the work branch and opens the PR. The plan declares both, and the
  // gate consumes the one commit-bound human approval for both: never two approval points.
  if (kinds.has('gate.pr')) {
    for (const a of PR_APPROVALS) {
      if (!plan.permissions.approvals.includes(a)) errors.push(`a gate.pr needs the human approval '${a}' declared in permissions.approvals (one commit-bound grant covers ${PR_APPROVALS.join(' and ')})`);
      // A permissions file listing it in always would let the gate push or open the PR with no human at all.
      if (classify(a, opts.permissions) === 'always') errors.push(`${a} is listed in always: a gate.pr needs it to require the human approval (requiresApproval)`);
    }
  }
  for (const a of plan.permissions.approvals) {
    if (classify(a, opts.permissions) === 'never') errors.push(`approval for ${a} cannot be granted: action is never allowed`);
    if (APPROVAL_ONLY_ACTIONS.has(a)) errors.push(`approval ${a} is the requestor's, granted before planning; a plan cannot declare or grant it`);
    if (OBSOLETE_WRITE_APPROVALS.has(a)) errors.push(`approval ${a} is obsolete: writes inside allowedChanges on the work branch and commits need no approval (D6)`);
  }
  if (kinds.has('subgoal')) errors.push('subgoal steps are not supported yet');
  errors.push(...contractPlanProblems(plan, m, opts.context, opts.goal));
  errors.push(...stepChangesProblems(plan, m, opts.context?.contract?.envelope));
  return errors;
}

/**
 * A step's declared change paths (step.changes) may only narrow: every entry must lie inside the accepted
 * contract's envelope or, when the contract states none, inside repo.allowedChanges; never on a protected
 * path; and only a step that can write declares any. A plan cannot give itself a path the requestor did
 * not sign off: widening the envelope takes an amendment of the contract.
 */
export function stepChangesProblems(plan: Plan, m: Manifest, envelope?: readonly ChangePath[]): string[] {
  const errors: string[] = [];
  for (const s of plan.steps) {
    if (s.changes === undefined) continue;
    const shape = envelopeProblem(s.changes);
    if (shape) {
      errors.push(`step ${s.id} changes: ${shape}`);
      continue;
    }
    if (!isWritingStep(plan, s)) errors.push(`step ${s.id} declares changes but has no tool that writes`);
    for (const e of s.changes) {
      const prot = matchesProtected(e.path, m.policy.protectedPaths);
      if (prot) errors.push(`step ${s.id} changes: ${e.path} is a protected path (${prot})`);
      if (envelope) {
        const why = changeWithin(e, envelope);
        if (why) errors.push(`step ${s.id} changes: ${why}; a plan can narrow the envelope, only an amended contract can widen it`);
      } else {
        const inside = e.path.includes('*') ? m.repo.allowedChanges.some((a) => globWithin(e.path, a)) : matchesAny(e.path, m.repo.allowedChanges) !== null;
        if (!inside) errors.push(`step ${s.id} changes: ${e.path} is outside allowedChanges`);
      }
    }
  }
  return errors;
}

/**
 * Under an acceptance contract (the accepted one in `ctx`, else the criteria a goal file carries): the plan
 * names that contract's hash, verifies every command criterion (gate.verify runs each one), and names only
 * capabilities the run can serve. A capability the inventory and the manifest do not know is undeclared; a
 * missing one must resolve on the gap ladder to provision or mock (resolveGap), never to 'ask'.
 */
export function contractPlanProblems(plan: Plan, m: Manifest, ctx?: PlanningContext, goal?: AchievementGoal): string[] {
  const errors: string[] = [];
  const criteria: readonly Criterion[] = (ctx?.contract ? ctx.contract.criteria : goal?.criteria) ?? [];
  const fromGoal = !ctx?.contract && !!goal?.criteria;
  let expected = ctx?.contractHash ?? (fromGoal ? goal?.contractHash : undefined);
  if (!ctx?.contract && ctx?.contractHash !== undefined) errors.push('the planning context names a contract hash without the contract; refusing');
  // A goal file's criteria and contractHash go together: criteria without a hash would bind the plan to nothing.
  if (!ctx?.contract && goal && (goal.criteria?.length ? !goal.contractHash : goal.contractHash !== undefined)) {
    errors.push('the goal carries an incomplete contract (criteria and contractHash go together); refusing');
  }
  if (ctx?.contract) {
    const shape = contractProblem(ctx.contract);
    if (shape) errors.push(`the accepted contract is not well formed (${shape}); refusing`);
    const h = contractHash(ctx.contract);
    if (expected !== undefined && expected !== h) errors.push('the planning context names another contract hash than its contract; refusing');
    expected = expected ?? h;
  }
  if (expected !== undefined) {
    if (plan.contractHash === undefined) errors.push(`plan names no contractHash; it must be written for the accepted contract ${expected.slice(0, 12)}`);
    else if (plan.contractHash !== expected) errors.push(`plan was written for contract ${String(plan.contractHash).slice(0, 12)}, not the accepted ${expected.slice(0, 12)}; re-plan`);
  } else if (plan.contractHash !== undefined) {
    errors.push(`plan was written for contract ${String(plan.contractHash).slice(0, 12)} but no contract is accepted for this goal`);
  }

  const commands = criteria.filter((k) => k.check?.kind === 'command');
  if (commands.length && !plan.steps.some((s) => s.kind === 'gate.verify')) {
    errors.push(`plan has no gate.verify step to prove command criteria ${commands.map((k) => k.id).join(', ')}`);
  }
  if (plan.capabilities !== undefined && !Array.isArray(plan.capabilities)) return [...errors, 'plan.capabilities must be a list of capability ids'];
  for (const k of criteria) {
    for (const cap of k.requires ?? []) if (!(plan.capabilities ?? []).includes(cap)) errors.push(`criterion ${k.id} requires capability ${cap}, which the plan does not name in capabilities`);
  }

  const inventory = new Map<string, CapabilityRecord>((ctx?.inventory ?? []).map((r) => [r.id, r]));
  const connections = (m.connections ?? {}) as Record<string, { kind: string; mockable?: boolean }>;
  const allowance = narrower(allowanceOf(m), ctx?.allowance);
  let provisioned = Math.max(0, ctx?.provisionedSoFar ?? 0);
  for (const cap of plan.capabilities ?? []) {
    const rec = inventory.get(cap);
    const conn = Object.prototype.hasOwnProperty.call(connections, cap) ? connections[cap] : undefined;
    if (!rec && !conn) {
      errors.push(`plan uses capability ${cap}, which is neither declared in the manifest connections nor in the run's inventory`);
      continue;
    }
    const state = rec?.state ?? 'missing';
    if (state === 'available' || state === 'provisioned') continue;
    const mockable = conn ? conn.mockable !== false : true;
    if (state === 'mocked') {
      if (!mockable) errors.push(`capability ${cap} is mocked, but its connection is not mockable`);
      continue;
    }
    const gap = resolveGap({ kind: rec?.kind ?? conn!.kind, available: false, mockable }, allowance, provisioned);
    if (gap === 'ask') errors.push(`plan uses capability ${cap}, which is missing and can be neither provisioned within the allowance nor mocked: ask the requestor`);
    else if (gap === 'provision') provisioned++;
  }
  return errors;
}

/** The narrower of the manifest's allowance and the one the loop passed (the manifest is the authority). */
function narrower(base: ProvisioningAllowance, other?: ProvisioningAllowance): ProvisioningAllowance {
  if (!other) return base;
  return {
    scope: base.scope === 'local' && other.scope === 'local' ? 'local' : 'none',
    kinds: base.kinds.filter((k) => other.kinds.includes(k)),
    maxResources: Math.min(base.maxResources, other.maxResources),
    ttlSec: Math.min(base.ttlSec, other.ttlSec),
  };
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
