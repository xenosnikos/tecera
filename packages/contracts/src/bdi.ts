import type { Json, JsonObject } from './json.js';

/**
 * BDI vocabulary. Beliefs are plain facts projected from the log. Goals carry an environmental check.
 * Plans are trigger + context + steps + allowed models + permissions + budget. Intentions are committed
 * plan instances with a commitment policy. See docs/architecture.md "Plans, gates and the first job".
 */

export type Commitment = 'blind' | 'single-minded' | 'open-minded';

export interface Principal {
  kind: 'human' | 'agent' | 'system';
  id: string;
}

export interface Provenance {
  /** Where the value came from: memory tier, tool, model, user, system. */
  src: string;
  trust: 'trusted' | 'untrusted';
  digest?: string;
  path?: string;
  runId?: string;
}

export interface Belief {
  id: string;
  key: string;
  value: Json;
  provenance: Provenance;
  at: number;
  /** Set when a later event invalidated this belief; the projection keeps it for audit. */
  invalidatedAt?: number;
}

export interface EnvironmentalCheck {
  command: string;
  timeoutSec: number;
}

export type GoalStatus = 'open' | 'achieved' | 'demoted' | 'dropped';

/**
 * Proof of achievement (owner decision D4): the goal's check command ran against the final candidate and
 * exited 0. `evidenceKey` names the gate.verify evidence record behind the verify.passed event; `fingerprint`
 * is the candidate tree it ran on (D1); `verifiedAt` is when the verify.passed was recorded (epoch ms).
 * goal.achieved is never emitted without one.
 */
export interface AchievementProof {
  command: string;
  exitCode: 0;
  fingerprint: string;
  evidenceKey: string;
  verifiedAt: number;
}

export interface AchievementGoal {
  id: string;
  statement: string;
  check: EnvironmentalCheck;
  commitment: Commitment;
  budget?: Partial<Budget>;
  status: GoalStatus;
  /** Evidence keys (ledger event ids / evidence keys) that justify the current status. */
  evidence: string[];
  /** Set while the goal is achieved: what proves it (D4). */
  proof?: AchievementProof;
}

/** Why `p` is not a well-formed achievement proof (null when it is). Checks shape only, not the ledger. */
export function achievementProofProblem(p: unknown, check?: EnvironmentalCheck): string | null {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'no proof of achievement';
  const o = p as Record<string, unknown>;
  if (typeof o.command !== 'string' || !o.command) return 'proof names no check command';
  if (o.exitCode !== 0) return `proof records exit ${JSON.stringify(o.exitCode ?? null)}, not 0`;
  if (typeof o.fingerprint !== 'string' || !o.fingerprint) return 'proof names no candidate fingerprint';
  if (typeof o.evidenceKey !== 'string' || !o.evidenceKey) return 'proof names no verify evidence';
  if (typeof o.verifiedAt !== 'number' || !Number.isFinite(o.verifiedAt)) return 'proof has no verification time';
  if (check && o.command !== check.command) return 'proof ran another command than the goal check';
  return null;
}

export interface Budget {
  usd: number;
  tokens: number;
  wallClockSec: number;
  maxDepth: number;
  maxIterations: number;
  maxAttempts: number;
  maxChangedFiles: number;
}

/**
 * Step kinds. Host-run gates: verify, review, commit (to the work branch, no approval), pr (the approval
 * point: push the work branch and open a PR, or record pr.requested with a patch bundle; never merges).
 */
export type StepKind = 'worker' | 'gate.verify' | 'gate.review' | 'gate.commit' | 'gate.pr' | 'subgoal';

/** Every StepKind, for validation of untrusted plans. */
export const STEP_KINDS: readonly StepKind[] = ['worker', 'gate.verify', 'gate.review', 'gate.commit', 'gate.pr', 'subgoal'];
export type StepStatus = 'pending' | 'ready' | 'held' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Step {
  id: string;
  kind: StepKind;
  /** Ids of steps in the same plan that must be `done` first. */
  dependsOn: string[];
  inputs: JsonObject;
  /** JSON schema the worker's return value must satisfy (worker steps only). */
  output?: JsonObject;
  /** Natural-language instruction for worker steps; ignored for gates. */
  instruction?: string;
  /**
   * Per-step narrowing of plan.permissions.tools (worker steps). Absent = the plan's tools. Every entry
   * must be in plan.permissions.tools (validatePlanShape). Replaces the old `inputs.tools` convention.
   */
  tools?: string[];
}

/** What a plan reacts to: an event kind plus optional payload constraints. */
export interface EventPattern {
  kind: string;
  where?: JsonObject;
}

/** Context condition: beliefs that must hold for the plan to apply. */
export interface BeliefPattern {
  key: string;
  equals?: Json;
  exists?: boolean;
}

export interface PlanPermissions {
  tools: string[];
  write: string[];
  approvals: string[];
}

export type PlanOrigin = 'generated' | 'graduated' | 'seed';
export type PlanStatus = 'candidate' | 'accepted' | 'rejected' | 'retracted';

export interface Plan {
  id: string;
  trigger: EventPattern;
  context: BeliefPattern[];
  steps: Step[];
  /** step id → seat ids allowed to run it (worker steps). Empty list means any worker seat. */
  allowedModels: Record<string, string[]>;
  permissions: PlanPermissions;
  budget: Partial<Budget>;
  origin: PlanOrigin;
  status: PlanStatus;
  /** Which goal kinds this plan was written for; free-form tags used for matching and review. */
  goalKinds: string[];
  rationale?: string;
}

export type IntentionStatus = 'committed' | 'running' | 'held' | 'done' | 'dropped' | 'failed';

export interface Intention {
  id: string;
  goalId: string;
  planId: string;
  parentIntentionId?: string;
  commitment: Commitment;
  status: IntentionStatus;
  stepStatus: Record<string, StepStatus>;
  attempt: number;
  checkpointId?: string;
  /** Worker resume token of a step held on a worker suspension; survives a restart via intention.held. */
  resumeToken?: string;
  /** Approval request the held step waits on (worker suspension or loop-level gate hold). */
  heldRequestId?: string;
}

// ---------- memory ----------

/** One entry in the four-tier memory (agentic-stack port). Lessons graduate only through human decisions. */
export interface MemoryEntry {
  id: string;
  tier: 'personal' | 'working' | 'semantic' | 'episodic';
  kind: string;
  content: string;
  provenance: { runId?: string; hookId?: string; evidenceKey?: string; commitSha?: string };
  salience: { createdAt: number; pain: number; importance: number; recurrence: number };
  state: 'active' | 'candidate' | 'rejected' | 'retracted';
  decisions: Array<{ by: Principal; verdict: string; rationale: string; at: number }>;
}

// ---------- lifecycles ----------

export class IllegalTransition extends Error {
  constructor(public readonly entity: string, public readonly from: string, public readonly to: string, detail?: string) {
    super(`illegal ${entity} transition ${from} → ${to}${detail ? `: ${detail}` : ''}`);
    this.name = 'IllegalTransition';
  }
}

const GOAL_EDGES: Record<GoalStatus, ReadonlySet<GoalStatus>> = {
  open: new Set(['achieved', 'dropped']),
  achieved: new Set(['demoted']),
  demoted: new Set(['achieved', 'dropped']),
  dropped: new Set([]),
};

const INTENTION_EDGES: Record<IntentionStatus, ReadonlySet<IntentionStatus>> = {
  committed: new Set(['running', 'dropped']),
  running: new Set(['held', 'done', 'failed', 'dropped']),
  held: new Set(['running', 'dropped', 'failed']),
  done: new Set([]),
  dropped: new Set([]),
  failed: new Set(['committed']), // a retry re-commits with attempt + 1
};

const STEP_EDGES: Record<StepStatus, ReadonlySet<StepStatus>> = {
  pending: new Set(['ready', 'cancelled']),
  ready: new Set(['held', 'running', 'cancelled']),
  held: new Set(['ready', 'running', 'cancelled', 'failed']),
  running: new Set(['held', 'done', 'failed', 'cancelled']), // held: the worker suspended on an approval-gated action
  done: new Set([]),
  failed: new Set(['ready']), // retry
  cancelled: new Set([]),
};

/**
 * Goal lifecycle. 'achieved' requires non-empty evidence (D4: a goal is achieved only on recorded proof)
 * and, when `proof` is given, a well-formed proof for the goal's own check command; the proof is kept on
 * the goal while it stays achieved and cleared on demotion.
 */
export function transitionGoal(g: AchievementGoal, to: GoalStatus, evidence: string[] = [], proof?: AchievementProof): AchievementGoal {
  if (!GOAL_EDGES[g.status].has(to)) throw new IllegalTransition('goal', g.status, to);
  if (to === 'achieved') {
    const ev = Array.isArray(evidence) ? evidence.filter((e) => typeof e === 'string' && e.length > 0) : [];
    if (ev.length === 0) throw new IllegalTransition('goal', g.status, to, 'achievement requires non-empty evidence');
    if (proof !== undefined) {
      const why = achievementProofProblem(proof, g.check);
      if (why) throw new IllegalTransition('goal', g.status, to, why);
    }
  }
  const { proof: _old, ...rest } = g;
  void _old;
  return { ...rest, status: to, evidence: [...g.evidence, ...evidence], ...(to === 'achieved' && proof ? { proof } : {}) };
}

export function transitionIntention(i: Intention, to: IntentionStatus): Intention {
  if (!INTENTION_EDGES[i.status].has(to)) throw new IllegalTransition('intention', i.status, to);
  const attempt = i.status === 'failed' && to === 'committed' ? i.attempt + 1 : i.attempt;
  return { ...i, status: to, attempt };
}

export function transitionStep(i: Intention, stepId: string, to: StepStatus): Intention {
  const from = i.stepStatus[stepId];
  if (from === undefined) throw new IllegalTransition(`step ${stepId}`, 'absent', to);
  if (!STEP_EDGES[from].has(to)) throw new IllegalTransition(`step ${stepId}`, from, to);
  return { ...i, stepStatus: { ...i.stepStatus, [stepId]: to } };
}

/** Steps whose dependencies are all done and which are still pending. */
export function readySteps(plan: Plan, i: Intention): Step[] {
  return plan.steps.filter((s) => {
    if (i.stepStatus[s.id] !== 'pending') return false;
    return s.dependsOn.every((d) => i.stepStatus[d] === 'done');
  });
}

/** Validate plan structure: unique step ids, known dependencies, no cycles, allowedModels keys exist. */
export function validatePlanShape(plan: Plan): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const s of plan.steps) {
    if (ids.has(s.id)) errors.push(`duplicate step id ${s.id}`);
    ids.add(s.id);
  }
  for (const s of plan.steps) {
    if (!STEP_KINDS.includes(s.kind)) errors.push(`step ${s.id} has unknown kind ${String(s.kind)}`);
    for (const d of s.dependsOn) if (!ids.has(d)) errors.push(`step ${s.id} depends on unknown ${d}`);
  }
  for (const k of Object.keys(plan.allowedModels)) if (!ids.has(k)) errors.push(`allowedModels references unknown step ${k}`);
  const planTools: unknown = plan.permissions?.tools;
  const allowedTools = new Set(Array.isArray(planTools) ? planTools.filter((t): t is string => typeof t === 'string') : []);
  for (const s of plan.steps) {
    if (s.tools === undefined) continue;
    if (!Array.isArray(s.tools) || s.tools.some((t) => typeof t !== 'string')) {
      errors.push(`step ${s.id} tools must be an array of tool names`);
      continue;
    }
    for (const t of s.tools) if (!allowedTools.has(t)) errors.push(`step ${s.id} tool ${t} is not in plan.permissions.tools`);
  }
  // cycle check (Kahn)
  const indeg = new Map<string, number>();
  for (const s of plan.steps) indeg.set(s.id, s.dependsOn.length);
  const queue = [...indeg.entries()].filter(([, n]) => n === 0).map(([id]) => id);
  let seen = 0;
  while (queue.length) {
    const id = queue.shift()!;
    seen++;
    for (const s of plan.steps) {
      if (s.dependsOn.includes(id)) {
        const n = indeg.get(s.id)! - 1;
        indeg.set(s.id, n);
        if (n === 0) queue.push(s.id);
      }
    }
  }
  if (seen !== plan.steps.length) errors.push('plan steps contain a dependency cycle');
  if (plan.steps.length === 0) errors.push('plan has no steps');
  if (plan.steps.length > 12) errors.push('plan has more than 12 steps');
  return errors;
}

/** Create a fresh intention for a plan: every step pending. */
export function newIntention(args: {
  id: string;
  goalId: string;
  plan: Plan;
  commitment: Commitment;
  parentIntentionId?: string;
}): Intention {
  const stepStatus: Record<string, StepStatus> = {};
  for (const s of args.plan.steps) stepStatus[s.id] = 'pending';
  return {
    id: args.id,
    goalId: args.goalId,
    planId: args.plan.id,
    parentIntentionId: args.parentIntentionId,
    commitment: args.commitment,
    status: 'committed',
    stepStatus,
    attempt: 1,
  };
}

/** Worker tools that cannot change the worktree. Any other tool makes a worker step a write (fail closed). */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['read', 'readFile', 'listFiles', 'list', 'search', 'grep', 'glob']);

/** A worker step that may change the worktree: any effective tool outside READ_ONLY_TOOLS. */
export function isWritingStep(plan: Plan, step: Step): boolean {
  return step.kind === 'worker' && effectiveStepTools(plan, step).some((t) => !READ_ONLY_TOOLS.has(t));
}

/**
 * Tools a step may use: plan.permissions.tools narrowed by step.tools (intersection, never widening).
 * Workers and the loop's capability builder use this; nothing else may read tools from step.inputs.
 */
export function effectiveStepTools(plan: Plan, step: Step): string[] {
  const planTools = plan.permissions.tools;
  return step.tools === undefined ? [...planTools] : planTools.filter((t) => step.tools!.includes(t));
}

// ---------- progress ----------

/** The candidate fingerprint (verify D1) one attempt of an intention produced. */
export interface AttemptFingerprint {
  attempt: number;
  fingerprint: string | null | undefined;
  /**
   * Which worker execution produced the candidate (e.g. the count of worker completions of the intention when
   * the verify ran). Two verifies of the SAME execution (an interrupted verify re-run, a second verify gate)
   * are never compared; only candidates of different executions are.
   */
  exec?: number | string;
}

/**
 * No-progress rule (policy progressCheck, security.md §6 recover.noop_twice): two DIFFERENT worker
 * executions that produced the same non-empty candidate fingerprint made no progress. An entry without
 * `exec` is identified by its attempt (one execution per attempt). Returns the reason, or null.
 */
export function noProgressReason(history: readonly AttemptFingerprint[]): string | null {
  const first = new Map<string, AttemptFingerprint & { key: string }>();
  for (const h of history) {
    if (typeof h.fingerprint !== 'string' || h.fingerprint === '') continue;
    const key = h.exec !== undefined && h.exec !== null ? `x:${String(h.exec)}` : `a:${h.attempt}`;
    const seen = first.get(h.fingerprint);
    if (seen === undefined) {
      first.set(h.fingerprint, { ...h, key });
      continue;
    }
    if (seen.key === key) continue;
    const execs = seen.exec !== undefined && h.exec !== undefined ? ` (worker executions ${String(seen.exec)} and ${String(h.exec)})` : '';
    if (seen.attempt !== h.attempt) return `no progress: attempts ${Math.min(seen.attempt, h.attempt)} and ${Math.max(seen.attempt, h.attempt)} produced the same candidate fingerprint ${h.fingerprint.slice(0, 16)}${execs}`;
    return `no progress: two worker executions${execs} of attempt ${h.attempt} produced the same candidate fingerprint ${h.fingerprint.slice(0, 16)}`;
  }
  return null;
}
