import {
  LedgerError,
  REFLEX_SEAMS,
  acceptedContractOf,
  approvalAuditProblem,
  capabilityInventoryOf,
  ledgerProvenRun,
  resourceRegistryOf,
  openRunPools,
  digest,
  event,
  requireApproval,
  type AcceptanceContract,
  type AchievementGoal,
  type ApprovalGrant,
  type Budget,
  type DecisionRecord,
  type DecisionSink,
  type GateReconcileOutcome,
  type GateRunner,
  type Json,
  type Principal,
  type Manifest,
  type Plan,
  type PlanningContext,
  type PlanValidator,
  type ReflexSeam,
  type ReflexSetting,
  type RunVerdict,
  type TeceraEvent,
  type Worker,
} from '@tecera/contracts';
import { BeliefMap, projectBeliefs } from '@tecera/ledger';
import { ApprovalExpired, Loop, LoopStopped, type LoopStatus } from '@tecera/loop';
import { allowanceOf, validatePlan, type PermissionsDoc } from '@tecera/policy';
import { ReflexRouter } from '@tecera/reflex';
import type { Command, CommandContext } from '../cli/context.js';
import { UnsafeEnvError } from '../env.js';
import { costLine, costReport, type CostReport } from '../cost.js';
import { CliError, EXIT, NotWired } from '../errors.js';
import { effectiveBudget, GoalError, resolveGoal, type GoalSpec } from '../goals.js';
import { PlanRegistry } from '../plans.js';
import { provenOptionsOf } from '../proof.js';
import { executionReadiness } from '../readiness.js';
import { stripUndefined, type Runtime } from '../runtime.js';
import { toolingProblem } from '../verify.js';
import { SCRIPTED_ENV } from '../scripted.js';
import { deferStaging, stageAchievedPlans } from '../staging.js';
import { recordRunLearning } from '../learning.js';
import { WiringError, type WiredPorts, type WiringContext } from '../wiring.js';
import { decisionEvent } from './approve.js';
import { checkIdentityProblem } from '../hardened/context.js';
import { HEARTBEAT_MS } from '../hardened/registry.js';

/**
 * `tecera run <goal|statement> [--dry-run] [--budget-usd n] [--max-depth n]` and `tecera run --resume <runId>`.
 *
 * Order of a run, each step fail-closed:
 * 1. resolve the goal; narrow the budget (goal front matter, then flags; never widened);
 * 2. execution readiness (readiness.ts): validation incl. secret scan and env allowlist, lock present and
 *    current, ledger chain, provider credentials resolved. Not ready → exit 3 before any repository code or
 *    model call;
 * 3. wiring gets the EFFECTIVE manifest (budgets narrowed, frozen) and returns the ports, the leased
 *    worktree, the fencing token and optionally a sandboxed verify runner;
 * 4. the Loop is built on the effective manifest (so worker limits, retries and plan validation all see the
 *    narrowed budget), a goal-aware validator (re-run on library plans by the Loop), the redacting ledger and
 *    the worktree; worker and gates are wrapped so the run's AbortSignal reaches every step;
 * 5. baseline check on the worktree (tooling failure → exit 3, the goal is not adopted; the run deadline
 *    passing during the baseline → exit 7); adopt; tick until quiescent or interrupted.
 *
 * The run enforces the GOAL's check everywhere: the effective manifest's verify command and timeout are the
 * resolved goal check, so the baseline, the worker's runVerify and every verify gate run the same command
 * (a goal whose check differs from tecera.json's verify.command never gets gate evidence from another one).
 *
 * The Loop gets the lease's `leaseSignal` (lease loss stops it and aborts running steps), `isolationDegraded`
 * (recorded only: D6 work-branch writes inside allowedChanges proceed, fenced) and the frontier seat for
 * reflex escalation (D2: reflexes are always on; a shaky answer goes to the planner model).
 *
 * Delivery (D6): commits land on the work branch tecera/<goal> without approval; the plan's gate.pr is the
 * one approval point (exit 4 while it waits). `tecera approve <request>` (local principal, D1) then
 * `tecera run --resume` pushes the branch and opens the PR (or records pr.requested with a patch bundle).
 * goal.achieved carries the proof of the verify it rests on (D4).
 *
 * Budgets (D3): the usd / tokens / calls / wallMs pools are opened from the manifest with its
 * budgets.enforce flag (default false: usage is recorded and reported, exhaustion never ends the run).
 * Every run ends with a cost line (per model; per step in the evidence summary).
 *
 * Resume (`--resume <runId>`): first the restored authority is re-validated against the CURRENT policy
 * (manifest, permissions, goal check: plans of unfinished intentions must still validate; a worker suspension
 * whose policy changed is refused, its checkpoint capabilities cannot be re-derived) → exit 8 when it fails.
 * Then Loop.restore() recovers every unfinished step per security.md §4 (S2–S9, including commit
 * reconciliation through gates.reconcile), granted holds are resumed (granted in the ledger, same session,
 * same action hash, not expired, with their approval.granted audit event), and the loop is driven whenever
 * anything was resumed, recovered or is dispatchable. The durable run deadline and the run's budget pools
 * carry over from the first segment.
 * Acceptance contracts (D8–D12): a statement run is adopted with `draftContract` (the planner drafts the
 * criteria; the goal holds for the requestor's sign-off, an accept_criteria approval, exit 4); a goal file with
 * `criteria:` is adopted with its own contract (no sign-off under `acceptance.signoff: statement`). The loop
 * gets the wiring's capability probe, local provisioner and secrets predicate, so every capability a
 * criterion requires is probed, provisioned, mocked or asked for (a provide_capability hold, exit 4) before
 * anything is planned. Human criteria are asked at the PR hold (answer_criterion approvals, exit 4).
 *
 * Exit code (read back from the ledger; "achieved" is contracts ledgerProvenRun, never a goal.achieved event
 * alone): 0 achieved; 3 not ready; 4 held (criteria sign-off, a capability ask, a human criterion, the PR);
 * 5 verify failed; 6 review rejected; 7 budget (only with budgets.enforce); 8 policy; 9 ledger/loop
 * stopped/not wired/human needed; 10 provisional (every criterion proven, one on a mock: never 0);
 * 130 interrupted. `returned` is never done.
 */

/** Ledger cap on brokered calls (LLM + tool) per run; the worker's budget hook reserves one per call. */
export const CALLS_PER_RUN = 400;

/** Tools the default validator accepts when wiring does not supply a catalog. */
export const DEFAULT_TOOL_CATALOG = ['read', 'edit', 'delete', 'listFiles', 'runVerify'] as const;

export function reflexSettings(m: Manifest): Record<ReflexSeam, ReflexSetting> {
  return Object.fromEntries(REFLEX_SEAMS.map((s) => [s, m.reflexes[s]])) as Record<ReflexSeam, ReflexSetting>;
}

/** Decision records become `decision.recorded` events in the run (offline A/B of reflex providers). */
export function ledgerDecisionSink(rt: Runtime, runId: string): DecisionSink {
  return {
    async record(d: DecisionRecord): Promise<void> {
      await rt.append('decision.recorded', { runId, payload: { record: stripUndefined(d) }, actor: { kind: 'system', id: 'reflex' } });
    },
  };
}

const BUDGET_KEYS: Array<keyof Budget> = ['usd', 'tokens', 'wallClockSec', 'maxDepth', 'maxIterations', 'maxAttempts', 'maxChangedFiles'];

/** Policy-backed, goal-aware validator: permissions, tool catalog, manifest budgets, then the goal's ceilings. */
export function policyValidator(permissions: PermissionsDoc, toolCatalog: readonly string[]): PlanValidator {
  return {
    validatePlan(plan: Plan, m: Manifest, goal: AchievementGoal, ctx?: PlanningContext): string[] {
      const errors = validatePlan(plan, m, { toolCatalog: [...toolCatalog], permissions, goalHasCheck: !!goal?.check?.command, ...(ctx ? { context: ctx } : {}), ...(goal ? { goal } : {}) });
      for (const k of BUDGET_KEYS) {
        const v = plan.budget[k];
        const cap = goal?.budget?.[k];
        if (typeof v === 'number' && typeof cap === 'number' && v > cap) errors.push(`budget.${k} ${v} exceeds the goal's ${cap}`);
      }
      return errors;
    },
  };
}

/**
 * The manifest the run enforces: tecera.json with budgets narrowed to `budget` and, when given, the verify
 * command and timeout bound to the goal's check (so gates, baseline and worker all run the goal's check),
 * deep-frozen.
 */
export function effectiveManifest(m: Manifest, budget: Budget, check?: { command: string; timeoutSec: number }): Manifest {
  const copy = JSON.parse(JSON.stringify({ ...m, budgets: { ...budget, enforce: m.budgets.enforce }, ...(check ? { verify: { ...m.verify, command: check.command, timeoutSec: check.timeoutSec } } : {}) })) as Manifest;
  const freeze = (v: unknown): void => {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      Object.freeze(v);
      for (const x of Object.values(v)) freeze(x);
    }
  };
  freeze(copy);
  return copy;
}

export interface RunOutcome {
  exitCode: number;
  reason: string;
}

/**
 * Read a run's outcome back from its events (and the Loop's state). `verdict` is the run's contracts
 * provenRun / ledgerProvenRun result: the only thing that makes a run exit 0 (a goal.achieved event without
 * a verdict that proves it counts for nothing) or 10 (provisional). `returned` is never done.
 */
export function exitCodeForRun(events: ReadonlyArray<TeceraEvent>, goalId: string, status?: Pick<LoopStatus, 'state' | 'stopReason' | 'failure'>, verdict?: RunVerdict | null): RunOutcome {
  if (status?.state === 'stopped') {
    // A budget refusal that stopped the loop is a budget failure; anything else (ledger, lease) is exit 9.
    if (status.failure === 'budget') return { exitCode: EXIT.budget, reason: `loop stopped: ${status.stopReason ?? 'budget'}` };
    return { exitCode: EXIT.ledger, reason: `loop stopped: ${status.stopReason ?? 'unknown'}` };
  }
  const proven = verdict?.goals?.[goalId];
  if (proven?.achieved === true && proven.proof) {
    const f = proven.proof.fidelity;
    return { exitCode: EXIT.ok, reason: `goal achieved (${proven.proof.criteria?.length ? `${proven.proof.criteria.length} criteria proven${f ? `, fidelity ${f}` : ''}` : 'environmental check passed'})` };
  }
  if (proven?.provisional) return { exitCode: EXIT.provisional, reason: `goal provisional: every criterion is proven but one rests on a mock (${proven.why ?? 'mocked capability'}); never achieved` };
  const unprovenAchieved = events.some((e) => e.kind === 'goal.achieved' && e.trace.goalId === goalId);
  // Only the current execution counts: an earlier segment (ended by run.ended) that was interrupted and then
  // resumed successfully is history, not the outcome.
  let segment = 0;
  events.forEach((e, i) => {
    if (e.kind === 'run.ended') segment = i + 1;
  });
  if (events.slice(segment).some((e) => e.kind === 'run.interrupted')) return { exitCode: EXIT.interrupted, reason: 'interrupted' };
  const requested = new Map<string, TeceraEvent>();
  for (const e of events) {
    const rid = (e.payload as { requestId?: string }).requestId;
    if (rid && (e.kind === 'approval.requested' || e.kind === 'step.held')) requested.set(rid, e);
    else if (rid && (e.kind === 'approval.denied' || e.kind === 'approval.consumed' || e.kind === 'approval.expired')) requested.delete(rid);
    if (e.kind === 'step.completed' || e.kind === 'step.failed') {
      for (const [r, h] of requested) if (h.trace.intentionId === e.trace.intentionId && h.trace.stepId === e.trace.stepId) requested.delete(r);
    }
  }
  const dropped = events.some((e) => e.kind === 'goal.dropped' && e.trace.goalId === goalId);
  if (requested.size && !dropped) {
    const holds = [...requested.values()];
    const action = (h: TeceraEvent): string => String((h.payload as { action?: unknown }).action ?? '');
    const atPr = holds.some((h) => h.kind === 'approval.requested' && /^gate\.pr /.test(String((h.payload as { reason?: unknown }).reason ?? '')));
    const prHeld = atPr || holds.some((h) => (h.payload as { owner?: unknown }).owner === 'gate');
    const what = holds.some((h) => action(h) === 'accept_criteria')
      ? 'criteria sign-off '
      : holds.some((h) => action(h) === 'provide_capability')
        ? 'a capability the run lacks '
        : holds.some((h) => action(h) === 'answer_criterion')
          ? 'human criterion answer '
          : prHeld
            ? 'PR '
            : '';
    return { exitCode: EXIT.held, reason: `held for ${what}approval ${[...requested.keys()].join(', ')}` };
  }
  const lastFail = [...events].reverse().find((e) => e.kind === 'step.failed');
  if (lastFail) {
    const p = lastFail.payload as { reason?: string; blocked?: boolean; terminal?: boolean; failure?: unknown };
    const reason = p.reason ?? '';
    const classified = failureExit(p.failure);
    if (classified !== null) return { exitCode: classified, reason: reason || `step failed (${String(p.failure)})` };
    if (p.blocked) return { exitCode: EXIT.policy, reason: `step ${lastFail.trace.stepId} blocked by policy` };
    if (/interrupted|cancelled/.test(reason)) return { exitCode: EXIT.interrupted, reason };
    if (/^verify exit/.test(reason)) return { exitCode: EXIT.verifyFailed, reason };
    if (/^review /.test(reason)) return { exitCode: EXIT.reviewRejected, reason };
    if (/budget/.test(reason)) return { exitCode: EXIT.budget, reason };
    if (/^aborted: .*(protected|allowlist|policy|conflict|schema)/.test(reason)) return { exitCode: EXIT.policy, reason };
    if (/approval/.test(reason) && p.terminal) return { exitCode: EXIT.policy, reason };
    if (/ledger/i.test(reason)) return { exitCode: EXIT.ledger, reason };
    return { exitCode: EXIT.error, reason: reason || 'step failed' };
  }
  const lastDrop = [...events].reverse().find((e) => e.kind === 'goal.dropped' && e.trace.goalId === goalId);
  if (lastDrop) {
    const p = lastDrop.payload as { reason?: string; failure?: unknown };
    const classified = failureExit(p.failure);
    if (classified !== null) return { exitCode: classified, reason: p.reason ?? `goal dropped (${String(p.failure)})` };
  }
  if (events.some((e) => e.kind === 'plan.rejected')) return { exitCode: EXIT.policy, reason: 'the plan was rejected by policy' };
  if (dropped) return { exitCode: EXIT.error, reason: 'goal dropped' };
  if (unprovenAchieved) return { exitCode: EXIT.ledger, reason: `goal.achieved is recorded but not proven (${proven?.why ?? verdict?.why ?? 'no proven verdict for the run'})` };
  return { exitCode: EXIT.error, reason: 'the loop stopped without reaching the goal' };
}

/** The kernel's terminal-failure classification → exit code ('budget' 7, 'policy' 8, 'human' 9). */
function failureExit(f: unknown): number | null {
  if (f === 'budget') return EXIT.budget;
  if (f === 'policy') return EXIT.policy;
  if (f === 'human') return EXIT.ledger;
  // the run's accounting failed (a reservation or settlement the ledger could not do): never continue
  if (f === 'ledger') return EXIT.ledger;
  return null;
}

function budgetOverrides(c: CommandContext): Partial<Budget> {
  const o: Partial<Budget> = {};
  const usd = c.args.values['budget-usd'];
  if (usd !== undefined) {
    const n = Number(usd);
    if (!(n > 0)) throw new CliError('--budget-usd must be a positive number', EXIT.usage);
    o.usd = n;
  }
  const depth = c.args.values['max-depth'];
  if (depth !== undefined) {
    const n = Number(depth);
    if (!Number.isInteger(n) || n < 1) throw new CliError('--max-depth must be a positive integer', EXIT.usage);
    o.maxDepth = n;
  }
  return o;
}

function describeBudget(b: Budget): string {
  return `$${b.usd} · ${b.tokens} tokens · ${b.wallClockSec}s · depth ${b.maxDepth} · ${b.maxIterations} iterations · ${b.maxAttempts} attempts · ≤${b.maxChangedFiles} files`;
}

function goalOf(goal: GoalSpec, budget: Budget): AchievementGoal {
  return { id: goal.goalId, statement: goal.statement, check: goal.check, commitment: goal.commitment, budget, status: 'open', evidence: [], ...(goal.contract ? { criteria: goal.contract.criteria, contractHash: goal.contractHash } : {}) };
}

async function dryRun(c: CommandContext, rt: Runtime, goal: GoalSpec, budget: Budget): Promise<number> {
  const m = effectiveManifest(rt.manifest, budget, goal.check);
  let registry = new PlanRegistry();
  let beliefs = new BeliefMap();
  if (rt.ledgerExists()) {
    registry = await PlanRegistry.load(rt.ledger());
    beliefs = await projectBeliefs(rt.ledger());
  }
  const probe = event('goal.adopted', { id: 'dry-run', at: rt.now(), actor: { kind: 'system', id: 'dry-run' }, trace: { goalId: goal.goalId }, payload: { goal: { id: goal.goalId, statement: goal.statement } } });
  const matches = await registry.match(probe, beliefs);
  const validator = policyValidator(rt.permissions, DEFAULT_TOOL_CATALOG);
  const verdicts = matches.map((p) => ({ id: p.id, errors: validator.validatePlan(p, m, goalOf(goal, budget)) }));
  const seats = m.seats;
  c.out.say('run (dry run: no model calls, nothing written)');
  c.out.say(`goal       ${goal.goalId}  "${goal.statement.split('\n')[0]}"${goal.path ? `  (${goal.path})` : '  (ad hoc statement)'}`);
  c.out.say(`check      \`${goal.check.command}\` · timeout ${goal.check.timeoutSec}s · ${goal.commitment}`);
  c.out.say(`budget     ${describeBudget(budget)}`);
  c.out.say(
    `seats      planner ${seats.planner.provider}/${seats.planner.model} · workers ${seats.workers.map((w) => `${w.id}=${w.provider}/${w.model}`).join(', ')} · reviewer ${seats.reviewer.provider}/${seats.reviewer.model}${m.review.foreign ? ' (foreign)' : ' (same vendor)'} · reflex ${seats.reflex.provider}`,
  );
  c.out.say(`reflexes   ${REFLEX_SEAMS.map((s) => `${s}=${m.reflexes[s]}`).join(' ')} · threshold ${m.reflexes.threshold}`);
  c.out.say(
    `plans      library: ${registry.accepted().length} accepted, ${registry.candidates().length} candidate(s) · match: ${
      verdicts.length ? verdicts.map((v) => (v.errors.length ? `${v.id} (invalid under current policy: ${v.errors[0]})` : v.id)).join(', ') : 'none → the planner seat would write a plan, validated and staged as a candidate'
    }`,
  );
  c.out.set('goal', goal as unknown as Json);
  c.out.set('budget', budget as unknown as Json);
  c.out.set('matches', matches.map((p) => p.id));
  c.out.set('invalidMatches', verdicts.filter((v) => v.errors.length).map((v) => v.id));
  c.out.set('library', { accepted: registry.accepted().length, candidates: registry.candidates().length });
  return EXIT.ok;
}

async function notReady(c: CommandContext, rt: Runtime, needCredentials: boolean): Promise<number | null> {
  const problems = await executionReadiness(rt, { needCredentials });
  if (!problems.length) return null;
  for (const p of problems) c.out.error(`  ${p.check}: ${p.detail}`);
  c.out.error(`run: not ready (${problems.length} problem(s)); nothing was executed → exit 3`);
  c.out.set('notReady', problems as unknown as Json);
  return EXIT.notReady;
}

/** Find the goal and budget a run was started with, from its goal.adopted event. */
async function resumeTarget(rt: Runtime, runId: string): Promise<{ goal: GoalSpec; budget: Budget } | null> {
  for await (const e of rt.ledger().events({ runId, kinds: ['goal.adopted'] })) {
    const p = e.payload as { goal?: AchievementGoal; contract?: AcceptanceContract; draftContract?: boolean };
    const g = p.goal;
    if (!g?.id) continue;
    const budget = { ...rt.manifest.budgets, ...(g.budget ?? {}) } as Budget;
    for (const k of BUDGET_KEYS) budget[k] = Math.min(budget[k], rt.manifest.budgets[k]);
    // The goal file's contract as adopted (its hash is bound into the goal); a statement's contract is on the
    // ledger as criteria.drafted / amended and the loop rebuilds it on restore.
    const contract = g.criteria?.length && g.contractHash ? (p.contract ?? { goalId: g.id, statement: g.statement, criteria: g.criteria, outOfScope: [], assumptions: [] }) : undefined;
    return {
      // The name is the goal id without its prefix: for a statement it is the same slug the first segment
      // committed under (goals.ts), so the work branch stays tecera/<slug> across holds and resumes (L5-F1).
      goal: {
        id: g.id.replace(/^g_/, ''),
        goalId: g.id,
        statement: g.statement,
        check: g.check,
        commitment: g.commitment,
        budget: g.budget ?? {},
        onViolation: 'wake-human',
        source: p.draftContract || !contract ? 'statement' : 'file',
        ...(contract ? { contract, contractHash: g.contractHash } : {}),
      },
      // enforcement follows the CURRENT manifest (the ledger never relaxes a pool opened enforced)
      budget: { ...budget, enforce: rt.manifest.budgets.enforce } as Budget,
    };
  }
  return null;
}

export const runCommand: Command = async (c) => {
  const resume = !!c.args.bools.resume;
  const arg = c.args.positionals.join(' ').trim();
  if (!arg) throw new CliError(resume ? 'usage: tecera run --resume <runId>' : 'usage: tecera run <goal|statement>', EXIT.usage);
  const rt = c.runtime();
  const m = rt.manifest;

  let goal: GoalSpec;
  let budget: Budget;
  let runId: string;
  if (resume) {
    if (!/^[A-Za-z0-9_-]+$/.test(arg)) throw new CliError(`not a run id: ${arg}`, EXIT.usage);
    if (!rt.ledgerExists()) throw new CliError('no ledger yet', EXIT.error);
    const t = await resumeTarget(rt, arg);
    if (!t) {
      c.out.error(`run --resume: no adopted goal for run ${arg} in the ledger`);
      return EXIT.error;
    }
    ({ goal, budget } = t);
    runId = arg;
  } else {
    try {
      goal = resolveGoal(rt.root, arg, m);
    } catch (e) {
      if (e instanceof GoalError) throw new CliError(e.message, EXIT.usage);
      throw e;
    }
    const eb = effectiveBudget(m, goal, budgetOverrides(c));
    if (eb.errors.length) throw new CliError(`budget: ${eb.errors.join('; ')}`, EXIT.budget);
    budget = eb.budget;
    runId = '';
  }

  if (c.args.bools['dry-run']) {
    if (resume) throw new CliError('--dry-run cannot be combined with --resume', EXIT.usage);
    const nr = await notReady(c, rt, false);
    if (nr !== null) return nr;
    return dryRun(c, rt, goal, budget);
  }
  const nr = await notReady(c, rt, true);
  if (nr !== null) return nr;
  // Interrupted before anything started: no lease, no reap, no restore, no worktree touched.
  if (c.opts.signal?.aborted) {
    c.out.error(`run: interrupted before ${resume ? 'the resume' : 'the run'} started; nothing was done → exit ${EXIT.interrupted}`);
    return EXIT.interrupted;
  }

  const scriptedArg = c.args.values.scripted ?? rt.env[SCRIPTED_ENV];
  const scripted = scriptedArg !== undefined && scriptedArg !== '' ? scriptedArg : undefined;
  if (rt.hardened && !rt.hardened.writer) {
    c.out.error(`run: hardened mode: the supervisor writes the protected state and runs as the operator identity (uid ${rt.hardened.config.operator.uid}); this process cannot write it → exit ${EXIT.policy}`);
    return EXIT.policy;
  }
  const checkAs = rt.hardened ? checkIdentityProblem(rt.hardened.config, rt.env) : null;
  if (checkAs) {
    c.out.error(`run: ${checkAs} → exit ${EXIT.notReady}`);
    return EXIT.notReady;
  }
  const ledger = rt.ledger();
  if (!runId) runId = rt.ids('r');
  // Hardened: the run is registered (or, resumed, moved to running) before anything is wired or dispatched.
  const seg = rt.hardened ? beginSegment(rt, runId, goal.goalId, resume) : null;
  try {
    return await runSegment(c, rt, { goal, budget, runId, resume, scripted, ledger, seg });
  } catch (e) {
    seg?.unknown();
    throw e;
  } finally {
    seg?.stop();
  }
};

/** Hardened: the registry side of one segment (registration, heartbeat, the supervisor's end transition). */
interface Segment {
  /** Work started: the registry says running. */
  started(): void;
  /** The segment ended with an outcome (terminal unless held, interrupted or provisional). */
  end(exitCode: number, reason: string): void;
  /** Nothing was started (wiring failed): a new run is closed as not started, a resumed one put back. */
  notStarted(exitCode: number, reason: string): void;
  /** The supervisor threw: the outcome is unknown and the run stays open. */
  unknown(): void;
  stop(): void;
}

function beginSegment(rt: Runtime, runId: string, goalId: string, resume: boolean): Segment {
  const h = rt.hardened!;
  const { prior } = h.registry.begin(runId, goalId, { resume });
  let done = false;
  const timer = setInterval(() => {
    try {
      h.registry.heartbeat(runId);
    } catch {
      /* a missed heartbeat reads as interrupted, which is the safe side */
    }
  }, HEARTBEAT_MS);
  timer.unref?.();
  return {
    started: () => void h.registry.running(runId),
    end: (exitCode, reason) => {
      done = true;
      h.registry.end(runId, exitCode, reason);
    },
    notStarted: (exitCode, reason) => {
      done = true;
      h.registry.restore(runId, prior, `exit ${exitCode}: ${reason}`);
    },
    unknown: () => {
      if (!done) h.registry.unknown(runId);
      done = true;
    },
    stop: () => clearInterval(timer),
  };
}

async function runSegment(
  c: CommandContext,
  rt: Runtime,
  a: { goal: GoalSpec; budget: Budget; runId: string; resume: boolean; scripted: string | undefined; ledger: ReturnType<Runtime['ledger']>; seg: Segment | null },
): Promise<number> {
  const { goal, budget, runId, resume, scripted, ledger, seg } = a;
  const m = rt.manifest;
  const library = await PlanRegistry.load(ledger);
  const ctx: WiringContext = {
    root: rt.root,
    manifest: effectiveManifest(m, budget, goal.check),
    manifestHash: rt.manifestHash,
    permissions: rt.permissions,
    ledger,
    runId,
    sessionId: runId,
    env: rt.env,
    now: rt.now,
    ids: () => rt.ids('ev'),
    verifyRunner: rt.verifyRunner,
    library,
    goal,
    budget,
    secrets: rt.secretStore,
    redactor: rt.redactor,
    ...(resume ? { resume: { runId } } : {}),
    secretInputs: rt.secrets.secretInputs(),
    ...(scripted ? { scripted } : {}),
    cwd: c.opts.cwd,
    signal: c.opts.signal,
  };
  let ports: WiredPorts;
  try {
    ports = await rt.wire(ctx);
  } catch (e) {
    if (e instanceof NotWired) {
      c.out.error(`run: not wired — ${e.message}`);
      c.out.set('notWired', e.message);
      seg?.notStarted(EXIT.notWired, e.message);
      return EXIT.notWired;
    }
    if (e instanceof WiringError) {
      c.out.error(`run: ${e.message} → exit ${e.exitCode}`);
      c.out.set('wiringError', e.message);
      seg?.notStarted(e.exitCode, e.message);
      return e.exitCode;
    }
    if (e instanceof LedgerError) {
      c.out.error(`run: ledger error — ${e.message}`);
      seg?.notStarted(EXIT.ledger, e.message);
      return EXIT.ledger;
    }
    throw e;
  }
  seg?.started();
  c.out.say(`run        ${runId}  goal ${goal.goalId}${resume ? '  (resume)' : ''}`);
  for (const n of ports.notes ?? []) c.out.say(n);

  try {
    const outcome = resume ? await resumeRun(rt, ctx, ports, c.opts.signal) : await executeRun(rt, ctx, ports, c.opts.signal);
    for (const n of outcome.notes ?? []) c.out.info(n);
    if (outcome.cost) {
      c.out.say(costLine(outcome.cost, ports.costUnrecorded?.() ?? 0));
      c.out.set('cost', { usd: outcome.cost.total.usd, tokens: outcome.cost.total.inputTokens + outcome.cost.total.outputTokens, calls: outcome.cost.total.calls, byModel: outcome.cost.byModel as unknown as Json, pools: outcome.cost.pools as unknown as Json });
    }
    c.out.say(`run ${runId}  goal ${goal.goalId}  → ${outcome.reason} → exit ${outcome.exitCode}`);
    c.out.set('runId', runId);
    c.out.set('outcome', { exitCode: outcome.exitCode, reason: outcome.reason });
    // Hardened: the supervisor's own transition, from the outcome it derived (never from a ledger event).
    seg?.end(outcome.exitCode, outcome.reason);
    return outcome.exitCode;
  } catch (e) {
    if (e instanceof LedgerError || e instanceof LoopStopped) {
      c.out.error(`run: ${e instanceof LoopStopped ? '' : 'ledger error — '}${e.message}`);
      seg?.unknown();
      return EXIT.ledger;
    }
    if (e instanceof UnsafeEnvError) {
      c.out.error(`run: ${e.message}`);
      seg?.unknown();
      return EXIT.invalid;
    }
    throw e;
  } finally {
    await ports.dispose?.();
  }
}

// ---------- cancellation bridge ----------

const anySignal = (a: AbortSignal | undefined, b: AbortSignal): AbortSignal => (a ? AbortSignal.any([a, b]) : b);

/** Gates see the run's signal; once it is aborted no gate starts (terminal result instead). */
export function cancellableGates(g: GateRunner, signal?: AbortSignal): GateRunner {
  if (!signal) return g;
  const stop = { evidenceKey: 'run:interrupted', terminal: true, reason: 'run interrupted' } as const;
  const out: GateRunner = {
    verify: async (ctx) => (signal.aborted ? { ...stop, exitCode: 130 } : g.verify({ ...ctx, signal: anySignal(ctx.signal, signal) })),
    review: async (ctx) => (signal.aborted ? { ...stop, verdict: 'reject' as const } : g.review({ ...ctx, signal: anySignal(ctx.signal, signal) })),
    commit: async (ctx) => (signal.aborted ? { ...stop, exitCode: 130 } : g.commit({ ...ctx, signal: anySignal(ctx.signal, signal) })),
    pr: async (ctx) => (signal.aborted ? { ...stop, exitCode: 130, sha: ctx.commit?.sha ?? '' } : g.pr({ ...ctx, signal: anySignal(ctx.signal, signal) })),
  };
  // S8 reconciliation is exposed exactly when the wired gates provide it (never invented here).
  if (typeof g.reconcile === 'function') {
    const reconcile = g.reconcile.bind(g);
    out.reconcile = async (ctx): Promise<GateReconcileOutcome> => (signal.aborted ? { recorded: false, reason: 'run interrupted' } : reconcile({ ...ctx, signal: anySignal(ctx.signal, signal) }));
  }
  return out;
}

/** The worker sees the run's signal; once it is aborted no step starts. */
export function cancellableWorker(w: Worker, signal?: AbortSignal): Worker {
  if (!signal) return w;
  const aborted = (runId: string) => ({ kind: 'aborted' as const, reasons: [{ code: 'cancelled' as const, reason: 'run interrupted', hookId: 'runtime.signal' }], run: { runId, invokeId: 'cancelled', depth: 0 } });
  return {
    run: async (req, s) => (signal.aborted ? aborted(req.runId) : w.run(req, anySignal(s, signal))),
    // the guard (4th argument) is forwarded unchanged: without it the worker has no write authority
    resume: async (token, grant, s, guard) => (signal.aborted ? aborted('resume') : w.resume(token, grant, anySignal(s, signal), guard)),
  };
}

// ---------- the run ----------

export type RunResult = RunOutcome & { status: LoopStatus; notes?: string[]; cost?: CostReport };

const LOOP_ACTOR: Principal = { kind: 'agent', id: 'loop' };

function buildLoop(rt: Runtime, ctx: WiringContext, ports: WiredPorts, signal?: AbortSignal): Loop {
  const m = ctx.manifest;
  const reflex = new ReflexRouter({ settings: reflexSettings(m), threshold: m.reflexes.threshold }, { model: ports.model, frontier: ports.frontier, sink: ledgerDecisionSink(rt, ctx.runId), runId: ctx.runId, now: rt.now });
  return new Loop({
    manifest: m,
    // The runtime owns the plan library: the loop's early plan.staged is deferred until goal.achieved (staging.ts).
    ledger: deferStaging(ctx.ledger, LOOP_ACTOR),
    library: ctx.library,
    planner: ports.planner,
    reflex,
    worker: cancellableWorker(ports.worker, signal),
    gates: cancellableGates(ports.gates, signal),
    validator: ports.validator ?? policyValidator(rt.permissions, ports.toolCatalog ?? DEFAULT_TOOL_CATALOG),
    seats: ports.seats,
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    actor: LOOP_ACTOR,
    ...(ports.worktree !== undefined ? { worktree: ports.worktree } : {}),
    ...(ports.fencingToken ? { fencingToken: ports.fencingToken } : {}),
    // Lease loss: the loop stops and aborts its running steps (fencingToken also acts as the lease check).
    ...(ports.leaseSignal ? { leaseSignal: ports.leaseSignal } : {}),
    // Recorded on gate questions; never a hold (D6). Node isolation is degraded whatever wiring says.
    isolationDegraded: ports.isolationDegraded === true || m.sandbox.isolation === 'node',
    // D2: escalation of shaky reflex answers to the frontier seat (the port meters its own calls).
    ...(ports.frontier ? { frontier: ports.frontier } : {}),
    // Every model call reserves 'calls' (the runtime opens the pool first; the loop never widens it).
    callsCap: CALLS_PER_RUN,
    // S2: the worktree is checkpointed after every worker step and at each suspension; a restart restores it.
    ...(ports.worktreeCheckpoint ? { worktreeCheckpoint: ports.worktreeCheckpoint } : {}),
    // The change-path envelope at step close-out: the host's own list of what a worker step changed.
    ...(ports.stepChanges ? { stepChanges: (a: { from: string; to: string }) => ports.stepChanges!({ from: a.from, to: a.to }) } : {}),
    // A later intention of the goal works on its own branch cut from the pinned base; nothing is inherited.
    ...(ports.prepareIntention ? { prepareIntention: ports.prepareIntention } : {}),
    // closeOut evidence: which files a worker step changed (paths and line counts, never contents).
    ...(ports.worktreeChanges ? { worktreeChanges: ports.worktreeChanges } : {}),
    // D9/D10: declared connections are probed for real; missing capabilities provisioned in Tecera's space.
    ...(ports.probe ? { probe: ports.probe } : {}),
    ...(ports.provisioner ? { provisioner: ports.provisioner } : {}),
    secrets: ports.secrets ?? ((v: string) => rt.redactor.containsSecret(v) !== null),
    redact: (v: Json) => rt.redactor.redactJson(v),
    now: rt.now,
    ids: ctx.ids,
  });
}

/** Any failure of a direct ledger call is a ledger failure (exit 9), whatever the driver threw. */
async function ledgerOp<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof LedgerError) throw e;
    throw new LedgerError(`ledger unavailable: ${(e as Error)?.message ?? String(e)}`, 'io');
  }
}

/**
 * S2: restore the worktree of every intention the loop blocked on a worktree requirement (a worker that died
 * or whose approval expired mid-step: its uncheckpointed writes must go), then confirm it to the loop. The
 * caller has already proven no writer of the previous process survives (reapPrior). Returns why it could
 * not (the intentions stay blocked; nothing of theirs runs), or null.
 */
async function satisfyWorktree(loop: Loop, ports: WiredPorts, notes: string[], signal?: AbortSignal): Promise<string | null> {
  const req = loop.status().requiredWorktreeState ?? {};
  const entries = Object.entries(req);
  if (!entries.length) return null;
  if (!ports.restoreWorktree) return `the worktree must be restored to ${entries.map(([, r]) => r.checkpointId).join(', ')} but this wiring cannot restore it`;
  const targets = new Set(entries.map(([, r]) => r.checkpointId));
  // One worktree per run: intentions that need different trees cannot both be satisfied.
  if (targets.size > 1) return `intentions need different worktree states (${[...targets].join(', ')}); refusing to pick one`;
  const [checkpointId] = [...targets];
  try {
    await ports.restoreWorktree(checkpointId!, signal);
  } catch (e) {
    return `worktree restore to ${checkpointId} failed: ${(e as Error)?.message ?? String(e)}`;
  }
  for (const [iid, r] of entries) {
    await loop.confirmWorktreeRestored(iid, r.checkpointId);
    notes.push(`worktree of ${iid} restored to ${r.checkpointId} (${r.reason}${r.reset.length ? `; reset ${r.reset.join(', ')}` : ''})`);
  }
  return null;
}

/** Tick until quiescent, the loop stops, or the signal aborts. Worktree requirements are satisfied between ticks. */
async function drive(loop: Loop, signal?: AbortSignal, maxTicks = 1000, ports?: WiredPorts, notes: string[] = []): Promise<LoopStatus> {
  for (let t = 0; t < maxTicks; t++) {
    if (signal?.aborted) break;
    if (ports && Object.keys(loop.status().requiredWorktreeState ?? {}).length) {
      const why = await satisfyWorktree(loop, ports, notes, signal);
      if (why) {
        notes.push(`worktree not restored: ${why}`);
        break;
      }
    }
    let progressed: boolean;
    try {
      progressed = await loop.tick();
    } catch (e) {
      if (e instanceof LoopStopped) break;
      throw e;
    }
    if (!progressed) break;
  }
  return loop.status();
}

/** The run's cost so far: its cost.call events and its pools (informational). */
export async function runCost(ledger: WiringContext['ledger'], runId: string, events?: ReadonlyArray<TeceraEvent>): Promise<CostReport> {
  const evs: TeceraEvent[] = events ? [...events] : [];
  if (!events) for await (const e of ledger.events({ runId })) evs.push(e);
  let pools: Awaited<ReturnType<NonNullable<typeof ledger.budgetUsage>>> = [];
  try {
    pools = typeof ledger.budgetUsage === 'function' ? await ledger.budgetUsage(runId) : [];
  } catch {
    pools = [];
  }
  return costReport(evs, pools);
}

/**
 * The single-source verdict on the run (contracts ledgerProvenRun: the hash chain, the verify evidence, the
 * accepted contract and every criterion proof, the manifest allowance, sign-off and secrets). A ledger whose
 * chain cannot be verified proves nothing: null.
 */
export async function runVerdict(rt: Runtime, ctx: Pick<WiringContext, 'ledger' | 'runId'>): Promise<RunVerdict | null> {
  try {
    return await ledgerProvenRun(ctx.ledger, ctx.runId, provenOptionsOf(rt.manifest, rt.redactor));
  } catch {
    return null;
  }
}

async function finish(rt: Runtime, ctx: WiringContext, status: LoopStatus, signal: AbortSignal | undefined, notes: string[]): Promise<RunResult> {
  const { runId, goal } = ctx;
  if (signal?.aborted) await rt.append('run.interrupted', { runId, payload: { at: 'during loop' } });
  for (const p of await stageAchievedPlans(ctx.ledger, runId, { ids: ctx.ids, now: rt.now })) notes.push(`plan ${p} staged as a candidate (its goal was achieved)`);
  const events: TeceraEvent[] = [];
  for await (const e of ctx.ledger.events({ runId })) events.push(e);
  const outcome = exitCodeForRun(events, goal.goalId, status, await runVerdict(rt, ctx));
  const cost = await runCost(ctx.ledger, runId, events);
  await rt.append('run.ended', {
    runId,
    payload: { exitCode: outcome.exitCode, reason: outcome.reason, goalId: goal.goalId, loopState: status.state, cost: { usd: cost.total.usd, inputTokens: cost.total.inputTokens, outputTokens: cost.total.outputTokens, calls: cost.total.calls, unknownUsage: cost.total.unknown } },
  });
  // Episodes and candidate lessons of the run so far, its outcome included (idempotent per source event).
  notes.push(...(await recordRunLearning(ctx.ledger, runId, { redactor: rt.redactor, now: rt.now })).notes);
  return { ...outcome, status, notes, cost };
}

/**
 * What the run's authority was derived from: the pinned manifest hash, the permissions document and the
 * goal's check. Recorded at the start of a run; a resume under a different fingerprint re-validates.
 */
export function policyFingerprint(rt: Runtime, goal: GoalSpec): string {
  return digest({ manifestHash: rt.manifestHash, permissions: rt.permissions as unknown as Json, check: goal.check as unknown as Json });
}

/** Drive one fresh run through the Loop with wired ports. */
export async function executeRun(rt: Runtime, ctx: WiringContext, ports: WiredPorts, signal?: AbortSignal): Promise<RunResult> {
  const m = ctx.manifest;
  const { runId, goal, budget, ledger } = ctx;
  const loop = buildLoop(rt, ctx, ports, signal);
  // D3: usd / tokens / calls / wallMs from the effective manifest, soft unless budgets.enforce (the worker's
  // budget hook reserves `calls` per LLM/tool call). Opened BEFORE the loop starts: the loop never widens
  // nor relaxes a pool, so an enforced pool opened here could not be softened later.
  await ledgerOp(() => openRunPools(ledger, runId, m, { callsCap: CALLS_PER_RUN }));
  // D12: resources whose lifetime passed are released before anything new is provisioned.
  const sweepNotes = (await ports.sweep?.().catch((e: unknown) => [`resources  expiry sweep failed: ${(e as Error)?.message ?? String(e)}`])) ?? [];
  await loop.start(rt.manifestHash);
  if (loop.status().state === 'stopped') throw new LoopStopped(loop.status().stopReason ?? 'ledger append failed');
  // The durable deadline also cancels every in-flight model call and gate through the run-wide signal.
  const dl = loop.status().deadline;
  if (typeof dl === 'number') ports.setDeadline?.(dl);
  await rt.append('evidence.appended', { runId, payload: { kind: 'run.policy', policyHash: policyFingerprint(rt, goal), manifestHash: rt.manifestHash, check: goal.check as unknown as Json } });
  if (m.sandbox.isolation === 'node' || ports.isolationDegraded) await rt.append('isolation.degraded', { runId, payload: { profile: m.sandbox.profile, isolation: m.sandbox.isolation, enforcement: 'recorded; work-branch writes inside repo.allowedChanges proceed fenced (protected paths and tamper rules apply); the PR gate is the approval point' } });
  if (ports.worktree === undefined) await rt.append('evidence.appended', { runId, payload: { kind: 'worktree.missing', note: 'wiring returned no worktree; gates and workers receive "" and must refuse' } });

  if (signal?.aborted) {
    await rt.append('run.interrupted', { runId, payload: { at: 'before baseline' } });
    return finish(rt, ctx, loop.status(), undefined, []);
  }
  // The durable run deadline (recorded in run.started) also bounds the baseline: it is cancelled when it passes.
  // D3: only an enforced wall-clock budget cancels the baseline; otherwise the deadline is informational.
  const deadline = loop.status().deadline ?? rt.now() + budget.wallClockSec * 1000;
  const deadlineCtl = new AbortController();
  const remaining = deadline - rt.now();
  const enforceDeadline = m.budgets.enforce === true;
  const deadlineTimer = enforceDeadline && remaining > 0 && remaining < 2 ** 31 - 1 ? setTimeout(() => deadlineCtl.abort(new Error('run deadline exceeded')), remaining) : undefined;
  deadlineTimer?.unref?.();
  if (enforceDeadline && remaining <= 0) deadlineCtl.abort(new Error('run deadline exceeded'));
  const baselineSignal = signal ? AbortSignal.any([signal, deadlineCtl.signal]) : deadlineCtl.signal;
  const runner = ports.verifyRunner ?? rt.verifyRunner;
  const cwd = ports.worktree || rt.root;
  let problem: string | null;
  let passing: boolean;
  try {
    if (ports.baseline) {
      // Through the verify gate: same runner, same command, and the ignored-file baseline the commit gate needs.
      const b = await ports.baseline(baselineSignal);
      problem = b.problem;
      passing = b.outcome === 'passed';
      await ledger.evidence({ key: `run:${runId}:baseline`, kind: 'verify.baseline', runId, body: { command: m.verify.command, cwd, exitCode: b.exitCode, outcome: b.outcome, problem, gateEvidenceKey: b.evidenceKey } });
    } else {
      const baseline = await runner.run({ cwd, command: goal.check.command, timeoutSec: goal.check.timeoutSec, envAllowlist: m.sandbox.envAllowlist }, baselineSignal);
      problem = toolingProblem(baseline);
      passing = baseline.exitCode === 0;
      await ledger.evidence({
        key: `run:${runId}:baseline`,
        kind: 'verify.baseline',
        runId,
        body: { command: goal.check.command, cwd, exitCode: baseline.exitCode, timedOut: baseline.timedOut, truncated: baseline.truncated, problem, durationMs: baseline.durationMs },
      });
    }
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
  if (deadlineCtl.signal.aborted && !signal?.aborted) {
    await rt.append('run.ended', { runId, payload: { exitCode: EXIT.budget, reason: 'budget: run deadline exceeded during the baseline check', goalId: goal.goalId, evidenceKey: `run:${runId}:baseline` } });
    return { exitCode: EXIT.budget, reason: 'budget: run deadline exceeded during the baseline check; the goal was not adopted', status: loop.status() };
  }
  if (problem) {
    if (signal?.aborted) {
      await rt.append('run.interrupted', { runId, payload: { at: 'baseline' } });
      return finish(rt, ctx, loop.status(), undefined, []);
    }
    await rt.append('run.ended', { runId, payload: { exitCode: EXIT.notReady, reason: `baseline check: ${problem}`, goalId: goal.goalId, evidenceKey: `run:${runId}:baseline` } });
    return { exitCode: EXIT.notReady, reason: `baseline check ${problem}; tooling missing or interrupted — the goal was not adopted`, status: loop.status() };
  }
  await loop.addBelief('verify.baseline', passing ? 'passing' : 'failing', { src: 'preflight', trust: 'trusted' });
  if (signal?.aborted) {
    await rt.append('run.interrupted', { runId, payload: { at: 'before goal adoption' } });
    return finish(rt, ctx, loop.status(), undefined, []);
  }
  // D8: a goal file with criteria carries its contract; a statement is drafted by the planner and signed off.
  const base = { id: goal.goalId, statement: goal.statement, check: goal.check, commitment: goal.commitment, budget };
  if (goal.contract) await loop.adoptGoal({ ...base, criteria: goal.contract.criteria, contractHash: goal.contractHash }, { contract: goal.contract });
  else if (goal.source === 'statement') await loop.adoptGoal(base, { draftContract: true });
  else await loop.adoptGoal(base);
  const notes: string[] = [...sweepNotes];
  const status = await drive(loop, signal, 1000, ports, notes);
  return finish(rt, ctx, status, signal, notes);
}

interface RunScan {
  events: TeceraEvent[];
  policyHash: string | null;
  /** Unfinished intentions: id → plan id. */
  active: Map<string, string>;
  plans: Map<string, Plan>;
  /** Held worker suspensions (owner 'worker') still awaiting their grant. */
  workerHolds: string[];
}

async function scanRun(ctx: WiringContext): Promise<RunScan> {
  const scan: RunScan = { events: [], policyHash: null, active: new Map(), plans: new Map(), workerHolds: [] };
  const holds = new Map<string, string>();
  for await (const e of ctx.ledger.events({ runId: ctx.runId })) {
    scan.events.push(e);
    const p = e.payload as Record<string, unknown>;
    if (e.kind === 'evidence.appended' && p.kind === 'run.policy' && typeof p.policyHash === 'string') scan.policyHash ??= p.policyHash;
    if (e.kind === 'plan.generated') {
      const plan = p.plan as Plan | undefined;
      if (plan?.id) scan.plans.set(plan.id, plan);
    }
    if (e.kind.startsWith('intention.')) {
      const i = p.intention as { id?: string; planId?: string; status?: string } | undefined;
      if (i?.id && i.planId) {
        if (i.status === 'done' || i.status === 'failed' || i.status === 'dropped' || e.kind === 'intention.done' || e.kind === 'intention.failed' || e.kind === 'intention.dropped') scan.active.delete(i.id);
        else scan.active.set(i.id, i.planId);
      }
    }
    if (e.kind === 'step.held' && p.owner === 'worker' && typeof p.requestId === 'string') holds.set(p.requestId, String(e.trace.stepId ?? ''));
    if ((e.kind === 'approval.consumed' || e.kind === 'approval.denied' || e.kind === 'approval.expired') && typeof p.requestId === 'string') holds.delete(p.requestId);
  }
  scan.workerHolds = [...holds.keys()];
  return scan;
}

/**
 * The planning context of a run's goal under its accepted contract (the one the loop plans with), or
 * undefined when the goal is held to no contract or none is accepted now.
 */
function planningContextOf(rt: Runtime, ctx: WiringContext, events: readonly TeceraEvent[]): PlanningContext | undefined {
  const goalId = ctx.goal.goalId;
  const view = acceptedContractOf(events, goalId, { runId: ctx.runId, ...(rt.manifest.acceptance.signoff === 'always' ? { requireApproval: true } : {}) });
  if (view.state !== 'accepted' || !view.accepted) return undefined;
  const opts = provenOptionsOf(rt.manifest, rt.redactor);
  const allowance = allowanceOf(rt.manifest);
  const fold = { runId: ctx.runId, allowance, ...(opts.secrets ? { secrets: opts.secrets } : {}) };
  return {
    contract: view.accepted.contract,
    contractHash: view.accepted.hash,
    inventory: capabilityInventoryOf(events, fold).records,
    allowance,
    provisionedSoFar: resourceRegistryOf(events, fold).resources.length,
  };
}

/**
 * Re-validate the authority a resumed run would restore against the CURRENT policy. Null when it may
 * proceed; otherwise why not (exit 8). Plans of unfinished intentions must validate under the current
 * manifest, permissions and goal; a worker suspension (whose checkpoint carries the capabilities it was
 * granted) is refused when the policy fingerprint changed, because those capabilities cannot be re-derived.
 */
async function revalidateRestore(rt: Runtime, ctx: WiringContext, ports: WiredPorts, scan: RunScan): Promise<string | null> {
  const current = policyFingerprint(rt, ctx.goal);
  const changed = scan.policyHash !== current;
  const validator = ports.validator ?? policyValidator(rt.permissions, ports.toolCatalog ?? DEFAULT_TOOL_CATALOG);
  const goal = goalOf(ctx.goal, ctx.budget);
  const pctx = planningContextOf(rt, ctx, scan.events);
  for (const [iid, planId] of scan.active) {
    const plan = scan.plans.get(planId) ?? (await ctx.library.get(planId));
    if (!plan) return `intention ${iid}: plan ${planId} is not in the ledger; its authority cannot be re-validated`;
    // A plan written for a contract that is no longer the accepted one never runs again: the loop drops its
    // intention before any step dispatches (and the goal holds for a sign-off of the current contract).
    if (plan.contractHash !== undefined && plan.contractHash !== pctx?.contractHash) continue;
    const errors = pctx ? validator.validatePlan(plan, ctx.manifest, goal, pctx) : validator.validatePlan(plan, ctx.manifest, goal);
    if (errors.length) return `intention ${iid}: plan ${planId} is no longer allowed by the current policy (${errors.slice(0, 3).join('; ')})`;
  }
  if (changed && scan.workerHolds.length) {
    return `the policy changed since this run started (${scan.policyHash ? 'manifest, permissions or goal check differ' : 'no policy fingerprint recorded'}); held worker suspension(s) ${scan.workerHolds.join(', ')} carry capabilities granted under the old policy and cannot be resumed — start a new run`;
  }
  return null;
}

/**
 * Resume a run from the ledger: re-validate authority, restore (recovering every unfinished step per
 * security.md §4), resume granted holds, then drive whatever is dispatchable.
 */
export async function resumeRun(rt: Runtime, ctx: WiringContext, ports: WiredPorts, signal?: AbortSignal): Promise<RunResult> {
  const notes: string[] = [];
  const scan = await scanRun(ctx);
  const refusal = await revalidateRestore(rt, ctx, ports, scan);
  if (refusal) {
    await rt.append('run.ended', { runId: ctx.runId, payload: { exitCode: EXIT.policy, reason: `resume refused: ${refusal}`, goalId: ctx.goal.goalId } });
    const loop = buildLoop(rt, ctx, ports, signal);
    return { exitCode: EXIT.policy, reason: `resume refused: ${refusal}`, status: loop.status(), notes };
  }
  // S2: no writer of a previous supervisor may survive into this one. Its recorded processes (and anything
  // working inside the worktree) are killed and proven gone BEFORE the worktree is touched or work resumes.
  const refuseHuman = async (why: string): Promise<RunResult> => {
    await rt.append('run.ended', { runId: ctx.runId, payload: { exitCode: EXIT.ledger, reason: `resume refused: ${why}`, goalId: ctx.goal.goalId } });
    return { exitCode: EXIT.ledger, reason: `resume refused: ${why}`, status: buildLoop(rt, ctx, ports, signal).status(), notes };
  };
  if (!ports.reapPrior) return refuseHuman('this wiring cannot prove the previous supervisor\'s processes are gone (no reapPrior)');
  const reap = await ports.reapPrior();
  if (reap.refused) return refuseHuman(reap.refused);
  if (reap.survivors.length) return refuseHuman(reap.notes?.length ? reap.notes.join('; ') : `processes of the previous supervisor survived SIGKILL: ${reap.survivors.join(', ')}`);
  for (const k of reap.killed) notes.push(`reaped pid ${k.pid} (${k.why})`);
  if (reap.killed.length) await rt.append('evidence.appended', { runId: ctx.runId, payload: { kind: 'recovery.reaped', pids: reap.killed.map((k) => k.pid), reasons: reap.killed.map((k) => k.why) } });

  for (const n of (await ports.sweep?.().catch((e: unknown) => [`resources  expiry sweep failed: ${(e as Error)?.message ?? String(e)}`])) ?? []) notes.push(n);
  const loop = buildLoop(rt, ctx, ports, signal);
  const restored = await loop.restore();
  const dl = loop.status().deadline;
  if (typeof dl === 'number') ports.setDeadline?.(dl);
  for (const n of restored.recovered ?? []) notes.push(`recovered ${n.kind} ${n.stepId || n.goalId || ''}: ${n.action}${n.reason ? ` (${n.reason})` : ''}`);
  // Uncheckpointed writes of an interrupted worker are discarded before anything of its intention runs.
  const wtProblem = await satisfyWorktree(loop, ports, notes, signal);
  if (wtProblem) return refuseHuman(wtProblem);
  let resumed = 0;
  let failedResumes = 0;
  let expired = 0;
  for (const h of restored.held) {
    if (signal?.aborted) break;
    const view = await requireApproval(ctx.ledger, h.requestId);
    if (!view || view.state !== 'granted' || !view.approver) {
      notes.push(`held ${h.requestId} (${h.stepId}): ${view ? view.state : 'unknown'} — not resumed`);
      continue;
    }
    const ev = await decisionEvent(rt, h.requestId, 'approval.granted');
    const auditProblem = ev ? approvalAuditProblem(ev, { requestId: view.requestId, runId: view.runId, sessionId: view.sessionId, actionHash: view.actionHash, approver: view.approver }) : 'missing';
    if (auditProblem) {
      notes.push(`held ${h.requestId} (${h.stepId}): granted but its approval.granted event is ${auditProblem === 'missing' ? 'missing' : `invalid (${auditProblem})`} — run \`tecera approve ${h.requestId}\` again to record it; not resumed`);
      continue;
    }
    if (view.expiresAt <= rt.now()) {
      notes.push(`held ${h.requestId} (${h.stepId}): grant expired — not resumed`);
      continue;
    }
    const grant: ApprovalGrant = { requestId: h.requestId, approver: view.approver, grantedAt: ev!.at, expiresAt: view.expiresAt };
    try {
      await loop.resume(h.requestId, grant);
      resumed++;
    } catch (e) {
      if (e instanceof LoopStopped) throw e;
      if (e instanceof ApprovalExpired) {
        // S7 expiry while live: the step was routed back (a commit through verify) and needs a fresh grant.
        expired++;
        notes.push(`held ${h.requestId} (${h.stepId}): the grant expired on resume — routed back for fresh verification and approval`);
        continue;
      }
      failedResumes++;
      notes.push(`held ${h.requestId} (${h.stepId}): resume refused (${(e as Error)?.message ?? String(e)})`);
    }
  }
  // An expired worker grant restarts the worker behind a worktree requirement too (live path).
  const wtAfter = await satisfyWorktree(loop, ports, notes, signal);
  if (wtAfter) return refuseHuman(wtAfter);
  const after = loop.status();
  // A note that only re-held a step changed nothing; anything else restore did (re-dispatch, restart,
  // reconcile, complete, fail, expire) must be driven and recorded.
  const recoveredWork = (restored.recovered ?? []).filter((n) => n.action !== 'held').length;
  // An intention still waiting for its own branch is work too: the first tick prepares it.
  const unprepared = Object.keys(after.awaitingPreparation ?? {}).length;
  const work = resumed > 0 || expired > 0 || recoveredWork > 0 || (restored.dispatchable ?? 0) > 0 || (after.dispatchable ?? 0) > 0 || unprepared > 0 || after.state === 'stopped';
  if (!work && failedResumes === 0) {
    // Nothing to do. A crash between goal.achieved and staging is still repaired (idempotent).
    for (const p of await stageAchievedPlans(ctx.ledger, ctx.runId, { ids: ctx.ids, now: rt.now })) notes.push(`plan ${p} staged as a candidate (its goal was achieved)`);
    notes.push(...(await recordRunLearning(ctx.ledger, ctx.runId, { redactor: rt.redactor, now: rt.now })).notes);
    const events: TeceraEvent[] = [];
    for await (const e of ctx.ledger.events({ runId: ctx.runId })) events.push(e);
    const outcome = exitCodeForRun(events, ctx.goal.goalId, after, await runVerdict(rt, ctx));
    notes.push('nothing to resume');
    return { ...outcome, status: after, notes, cost: await runCost(ctx.ledger, ctx.runId, events) };
  }
  const status = await drive(loop, signal, 1000, ports, notes);
  return finish(rt, ctx, status, signal, notes);
}
