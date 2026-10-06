import { isWritingStep, READ_ONLY_TOOLS, validatePlanShape, type AchievementGoal, type Manifest, type Plan, type PlanValidator, type Redactor, type Step } from '@tecera/contracts';
import { DEFAULT_PERMISSIONS, classify, validatePlan, type PermissionsDoc } from '@tecera/policy';
import { budgetIssues } from './budget.js';
import { deepSecretKind, inertDepth, MAX_PLAN_DEPTH, patternRedactor, UNSCANNABLE } from './hygiene.js';
import { safeLine } from './render.js';

/**
 * Authority rules that shape and policy validation do not cover (docs/architecture.md P1.2, security.md §5).
 *
 * Delivery chain (owner decision D6). A plan that can change code (a commit or PR step, any write glob, or
 * a worker whose effective tools include anything outside the contracts READ_ONLY_TOOLS) must end in ONE
 * connected chain
 *   every worker → V1 gate.verify → R gate.review → V2 gate.verify → C gate.commit → P gate.pr
 * linked through dependsOn ancestry: V1 has every worker step as an ancestor, R has V1, V2 has R, C has V2,
 * P depends directly on C; C depends on every worker and only P follows it; P is the single last step. The
 * commit lands on the work branch without approval; P is the one human approval point (it needs 'open_pr'
 * in permissions.approvals, which policy.validatePlan checks together with its own deliveryChainProblems).
 * A verify that runs beside the review, a review that only follows an earlier verify, or a commit whose
 * chain does not cover a writing step is rejected.
 *
 * Seats. Every worker step names >= 1 worker seat in allowedModels, each a manifest worker seat (and in
 * the allowed subset when given). Empty or missing never means "any seat". Gates carry no seats.
 *
 * Tools. Per-step narrowing is Step.tools (worker steps only, subset of permissions.tools, checked by
 * validatePlanShape too). The old `inputs.tools` convention is rejected so nothing relies on it.
 */

/** Tools the broker offers in Phase 1 (see docs/security.md §3). */
export const DEFAULT_TOOL_CATALOG: readonly string[] = ['read', 'listFiles', 'edit', 'runVerify'];
/** Tools that cannot change the worktree: the contracts set (runVerify is NOT in it: a test run can write). */
export { READ_ONLY_TOOLS };

function ancestors(plan: Plan): Map<string, Set<string>> {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const memo = new Map<string, Set<string>>();
  const visit = (id: string, stack: Set<string>): Set<string> => {
    const hit = memo.get(id);
    if (hit) return hit;
    const out = new Set<string>();
    if (stack.has(id)) return out; // cycles are reported by validatePlanShape
    stack.add(id);
    for (const d of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(d)) continue;
      out.add(d);
      for (const a of visit(d, stack)) out.add(a);
    }
    stack.delete(id);
    memo.set(id, out);
    return out;
  };
  for (const s of plan.steps) visit(s.id, new Set());
  return memo;
}

/** True when a worker step may change the worktree (contracts isWritingStep; unreadable tools count as writing). */
export function stepMayWrite(plan: Plan, step: Step): boolean {
  if (step.kind !== 'worker') return false;
  if (!Array.isArray(plan.permissions?.tools)) return true;
  return isWritingStep(plan, step);
}

export interface PlannerCheckOptions {
  /**
   * Worker seat ids a worker step may name. When given, allowedModels entries outside it are rejected and
   * every worker step must name at least one. Default: no seat-membership check here (policy checks
   * membership in the manifest), but missing/empty entries are still rejected.
   */
  workerSeats?: readonly string[];
}

export function plannerChecks(plan: Plan, permissions: PermissionsDoc = DEFAULT_PERMISSIONS, o: PlannerCheckOptions = {}): string[] {
  const errors: string[] = [];
  const anc = ancestors(plan);
  const has = (id: string, a: string) => anc.get(id)?.has(a) ?? false;
  const of = (kind: Step['kind']) => plan.steps.filter((s) => s.kind === kind);
  const workers = of('worker');
  const verifies = of('gate.verify');
  const reviews = of('gate.review');
  const commits = of('gate.commit');
  const coversWorkers = (id: string) => workers.every((w) => has(id, w.id));
  const allowedModels = (plan.allowedModels ?? {}) as Record<string, unknown>;

  // ---- step hygiene, seats, tools ----
  for (const s of plan.steps) {
    const seats = allowedModels[s.id];
    if (s.kind === 'worker') {
      if (!s.instruction || s.instruction.trim().length === 0) errors.push(`worker step ${s.id} has no instruction`);
      if (seats === undefined) errors.push(`allowedModels[${s.id}] is missing: every worker step must name at least one worker seat`);
      else if (!Array.isArray(seats) || seats.some((x) => typeof x !== 'string')) errors.push(`allowedModels[${s.id}] must be a list of worker seat ids`);
      else {
        if (seats.length === 0) errors.push(`allowedModels[${s.id}] is empty: an empty list never means "any seat"; name at least one worker seat`);
        if (new Set(seats).size !== seats.length) errors.push(`allowedModels[${s.id}] lists a seat twice`);
        if (o.workerSeats) for (const x of seats as string[]) if (!o.workerSeats.includes(x)) errors.push(`allowedModels[${s.id}] seat ${x} is not an allowed worker seat`);
      }
    } else {
      if (seats !== undefined) errors.push(`allowedModels[${s.id}]: only worker steps run on model seats (${s.id} is ${s.kind})`);
      if (s.tools !== undefined) errors.push(`step ${s.id}: only worker steps may set tools (${s.id} is ${s.kind})`);
    }
    if (s.inputs && typeof s.inputs === 'object' && Object.prototype.hasOwnProperty.call(s.inputs, 'tools')) {
      errors.push(`step ${s.id} sets inputs.tools, which is not honoured; narrow tools with the step's tools field`);
    }
    if (s.tools !== undefined && Array.isArray(s.tools)) {
      if (new Set(s.tools).size !== s.tools.length) errors.push(`step ${s.id} tools lists a tool twice`);
      for (const t of s.tools) if (!plan.permissions.tools.includes(t)) errors.push(`step ${s.id} tools widens the plan: ${t} is not in permissions.tools`);
    }
  }

  // ---- the connected delivery chain (D6) ----
  const prs = of('gate.pr');
  const writers = workers.filter((w) => stepMayWrite(plan, w));
  const chainRequired = commits.length > 0 || prs.length > 0 || plan.permissions.write.length > 0 || writers.length > 0;
  const CHAIN = 'gate.verify → gate.review → gate.verify → gate.commit → gate.pr';

  for (const r of reviews) {
    if (!verifies.some((v) => has(r.id, v.id) && coversWorkers(v.id))) errors.push(`review step ${r.id} must depend on a verify step that runs after every worker step (order is verify → review → verify → commit → pr)`);
  }

  if (commits.length > 1) errors.push(`plan has ${commits.length} commit steps; exactly one is allowed`);
  if (prs.length > 1) errors.push(`plan has ${prs.length} pr steps; exactly one is allowed`);
  if (chainRequired && (commits.length === 0 || prs.length === 0)) {
    const why = writers.length ? `worker step(s) ${writers.map((w) => w.id).join(', ')} may write` : plan.permissions.write.length ? 'it declares write globs' : 'it delivers a commit or PR';
    errors.push(`a plan that can change code (${why}) must end in ${CHAIN}`);
  }
  for (const c of commits) {
    const dependents = plan.steps.filter((s) => s.dependsOn.includes(c.id));
    const notPr = dependents.filter((s) => s.kind !== 'gate.pr').map((s) => s.id);
    if (notPr.length) errors.push(`commit step ${c.id} may only be followed by the gate.pr step (${notPr.join(', ')} depend on it)`);
    const uncovered = workers.filter((w) => !has(c.id, w.id)).map((w) => w.id);
    if (uncovered.length) errors.push(`commit step ${c.id} must depend on every worker step (not: ${uncovered.join(', ')})`);
    const v1 = verifies.filter((v) => has(c.id, v.id) && coversWorkers(v.id));
    const r = reviews.filter((x) => has(c.id, x.id) && v1.some((v) => has(x.id, v.id)));
    const v2 = verifies.filter((v) => has(c.id, v.id) && r.some((x) => has(v.id, x.id)));
    if (!verifies.some((v) => has(c.id, v.id))) errors.push(`commit step ${c.id} has no preceding verify step`);
    else if (v1.length === 0) errors.push(`commit step ${c.id}: no preceding verify step runs after every worker step`);
    if (!reviews.some((x) => has(c.id, x.id))) errors.push(`commit step ${c.id} has no preceding review step`);
    else if (r.length === 0) errors.push(`commit step ${c.id}: no preceding review step depends on a verify that runs after every worker step`);
    if (r.length > 0 && v2.length === 0) errors.push(`commit step ${c.id}: no verify step runs after the review (chain is verify → review → verify → commit → pr)`);
  }
  for (const p of prs) {
    const dependents = plan.steps.filter((s) => s.dependsOn.includes(p.id)).map((s) => s.id);
    if (dependents.length) errors.push(`pr step ${p.id} must be the last step (${dependents.join(', ')} depend on it)`);
    if (!commits.some((c) => p.dependsOn.includes(c.id))) errors.push(`pr step ${p.id} must depend directly on the commit step (the PR delivers the committed work branch)`);
    const outside = plan.steps.filter((s) => s.id !== p.id && !has(p.id, s.id)).map((s) => s.id);
    if (outside.length) errors.push(`pr step ${p.id} must be the plan's single last step (not downstream of: ${outside.join(', ')})`);
  }
  for (const w of writers) {
    if (!commits.some((c) => has(c.id, w.id))) errors.push(`worker step ${w.id} may write but no commit chain depends on it`);
  }

  for (const t of plan.permissions.tools) {
    if (classify(t, permissions) === 'requiresApproval' && !plan.permissions.approvals.includes(t)) errors.push(`tool ${t} requires approval but the plan does not declare it in permissions.approvals`);
  }
  return [...new Set(errors)];
}

export interface CandidateValidationOptions {
  manifest: Manifest;
  /** The goal the plan is for: its check decides goalHasCheck and its budget bounds the plan. */
  goal?: AchievementGoal;
  permissions?: PermissionsDoc;
  toolCatalog?: readonly string[];
  /** Overrides the goal-derived value. Default: the goal has a non-empty check command (or true without a goal). */
  goalHasCheck?: boolean;
  /** Worker seats a step may name; default the manifest's worker seats. Intersected with the manifest. */
  workerSeats?: readonly string[];
  /**
   * Known secrets to scan for (and to redact diagnostics with). A plan carrying a secret or secret-shaped
   * string, at any depth and in any decoded form, is always rejected; without a redactor the scan and the
   * diagnostic redaction use SECRET_PATTERNS only (key shapes, JWTs, TECERA_CANARY_*).
   */
  redactor?: Redactor;
  /** Require every budget field (default: true for origin 'generated', false otherwise). */
  requireCompleteBudget?: boolean;
}

function hasCheck(goal: AchievementGoal | undefined, override: boolean | undefined): boolean {
  if (override !== undefined) return override;
  if (!goal) return true;
  return typeof goal.check?.command === 'string' && goal.check.command.trim().length > 0;
}

function seatsFor(m: Manifest, allowed?: readonly string[]): string[] {
  const manifestSeats = (m.seats?.workers ?? []).map((w) => w.id);
  return allowed ? manifestSeats.filter((s) => allowed.includes(s)) : manifestSeats;
}

/** Every diagnostic leaves redacted, single-line, defanged and bounded (truncated only after redaction). */
export function sanitizeDiagnostics(issues: readonly unknown[], r: Redactor = patternRedactor()): string[] {
  const out: string[] = [];
  for (const x of issues) {
    let line: string;
    try {
      line = safeLine(typeof x === 'string' ? x : '[non-text diagnostic]', r, '', 300);
    } catch {
      line = 'diagnostic withheld: redaction failed';
    }
    out.push(line);
  }
  return [...new Set(out)];
}

/**
 * Integrity of the plan as data, checked before anything reads it: nesting bounded (MAX_PLAN_DEPTH, counting
 * the enclosing Plan structure) and a COMPLETE secret scan (every depth, every string and key, decoded
 * views; accessors, Proxies and non-plain values are unscannable and rejected). Returns issues.
 */
export function planDataIssues(plan: unknown, r: Redactor = patternRedactor()): string[] {
  const shape = planStructureIssue(plan);
  if (shape) return [shape];
  return planSecretIssues(plan, r);
}

/** Nesting/inertness of a plan; null when it may be walked safely. */
function planStructureIssue(plan: unknown): string | null {
  const depth = inertDepth(plan, MAX_PLAN_DEPTH + 1);
  if (depth <= MAX_PLAN_DEPTH) return null;
  return depth === Infinity
    ? 'plan is not plain inert data (an accessor, Proxy, non-plain object or nesting beyond the limit); refusing'
    : `plan nests deeper than ${MAX_PLAN_DEPTH} levels; refusing`;
}

function planSecretIssues(plan: unknown, r: Redactor): string[] {
  const kind = deepSecretKind(plan, r);
  if (kind === UNSCANNABLE) return ['plan could not be completely scanned for secrets; refusing'];
  if (kind !== null) return [`plan contains secret-shaped content (${kind}); a plan never carries secrets`];
  return [];
}

/**
 * Everything the planner checks before handing a plan to the loop: plan-as-data integrity (depth, complete
 * secret scan), shape, policy, planner rules, goal-aware budgets. Deduplicated, and every returned
 * diagnostic is sanitized (redacted with `o.redactor`, or SECRET_PATTERNS without one; flattened, defanged,
 * bounded after redaction). Never throws: an internal failure is an issue (fail closed).
 */
export function validateCandidate(plan: Plan, o: CandidateValidationOptions): string[] {
  const r = o.redactor ?? patternRedactor();
  try {
    // Data integrity first: nothing below may walk a plan that is too deep or not inert.
    const structure = planStructureIssue(plan);
    if (structure) return sanitizeDiagnostics([structure], r);
    const permissions = o.permissions ?? DEFAULT_PERMISSIONS;
    const all = [
      ...planSecretIssues(plan, r),
      ...validatePlanShape(plan),
      ...validatePlan(plan, o.manifest, { toolCatalog: o.toolCatalog ?? DEFAULT_TOOL_CATALOG, permissions, goalHasCheck: hasCheck(o.goal, o.goalHasCheck) }),
      ...plannerChecks(plan, permissions, { workerSeats: seatsFor(o.manifest, o.workerSeats) }),
      ...budgetIssues(plan, o.manifest, o.goal ?? null, { requireComplete: o.requireCompleteBudget ?? plan.origin === 'generated' }),
    ];
    return sanitizeDiagnostics(all, r);
  } catch (err) {
    return sanitizeDiagnostics([`plan validation failed: ${err instanceof Error ? err.name : 'error'}`], r);
  }
}

export interface PlanValidatorOptions {
  permissions?: PermissionsDoc;
  toolCatalog?: readonly string[];
  /** Worker seats plans may name (default: the manifest's worker seats). */
  workerSeats?: readonly string[];
  /** Scan plans for secrets (e.g. makeRedactor(secrets)). */
  redactor?: Redactor;
  /** 'generated' (default): only generated plans must state every budget field; 'always' | 'never'. */
  requireCompleteBudget?: 'generated' | 'always' | 'never';
}

/**
 * The loop's PlanValidator port (contracts): validatePlan(plan, manifest, goal). The loop runs it on
 * generated AND library-matched plans; it applies policy, the planner rules and the goal's budget ceiling
 * (policy.validatePlan has no goal parameter yet, so the goal ceilings are enforced here). Shape
 * validation is included as well; the loop also runs it, duplicates are harmless. Every diagnostic it
 * returns is sanitized (redacted with the supplied redactor, or SECRET_PATTERNS without one).
 */
export function createPlanValidator(o: PlanValidatorOptions = {}): PlanValidator {
  return {
    validatePlan(plan: Plan, manifest: Manifest, goal: AchievementGoal): string[] {
      if (!goal || typeof goal !== 'object') return ['plan validation needs the goal (budget ceilings and check); refusing'];
      const mode = o.requireCompleteBudget ?? 'generated';
      let origin: unknown;
      try {
        origin = (plan as { origin?: unknown } | null)?.origin;
      } catch {
        origin = undefined;
      }
      // validateCandidate never throws and returns sanitized diagnostics only.
      return validateCandidate(plan, {
        manifest,
        goal,
        permissions: o.permissions,
        toolCatalog: o.toolCatalog,
        workerSeats: o.workerSeats,
        redactor: o.redactor,
        requireCompleteBudget: mode === 'always' ? true : mode === 'never' ? false : origin === 'generated',
      });
    },
  };
}
