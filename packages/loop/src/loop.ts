import { randomUUID } from 'node:crypto';
import {
  AccountingFailure,
  FencedWriteGuard,
  LedgerError,
  achievementProofProblem,
  commitActionHash,
  isWritingStep,
  meteredCall,
  prActionHash,
  reviewEvidenceKey,
  verifyCommandDigest,
  digest,
  effectiveStepTools,
  event,
  newIntention,
  noProgressReason,
  normalizeJson,
  reconcileVerdict,
  requireApproval,
  transitionGoal,
  transitionIntention,
  transitionStep,
  validatePlanShape,
  type AchievementGoal,
  type AchievementProof,
  type ApprovalGrant,
  type ApprovalView,
  type AttemptFingerprint,
  type CapabilitySet,
  type Commitment,
  type GateApproval,
  type GateContext,
  type GatePrResult,
  type GateReconcileResult,
  type GateRunner,
  type Intention,
  type Json,
  type JsonObject,
  type Ledger,
  type Manifest,
  type Outcome,
  type Plan,
  type PlanLibrary,
  type PlanValidator,
  type Planner,
  type Principal,
  type Reflex,
  type ReflexFrontier,
  type ReflexQuestions,
  type ReflexResult,
  type ReflexSeam,
  type EventKind,
  type Step,
  type StepKind,
  type TeceraEvent,
  type UsageMeter,
  type Worker,
  type WriteAuthorization,
} from '@tecera/contracts';
import { BeliefMap } from '@tecera/ledger';
import { LedgerBus } from './bus.js';
import { assembleStepContext } from './context.js';
import { IntentionSet } from './intentions.js';

/**
 * Gate contracts live in @tecera/contracts (ports.ts). These aliases keep the loop's old names working:
 * `StepContext` is `GateContext`; `GateRunner` and `PlanValidator` are re-exported unchanged.
 */
export type StepContext = GateContext;
export type { GateRunner, PlanValidator };
/** sha256(canonicalJson({intentionId, stepId, attempt, candidateD1})); gates MUST compute the same. prActionHash binds a PR approval to the committed sha. */
export { commitActionHash, prActionHash };

export interface SeatCost {
  seatId: string;
  costPerMTok: number;
}

/** Per-call ledger reservation for the LLM calls the loop triggers (planner.write, planner.deliberate, model reflex seams). */
export interface LlmReservation {
  usd: number;
  tokens: number;
  /** Calls reserved per metered call on the run's 'calls' pool (default 1). */
  calls?: number;
}

/** Default upper bound reserved before each planner call; settled at the metered usage afterwards. */
export const DEFAULT_LLM_RESERVATION: LlmReservation = { usd: 0.05, tokens: 8000, calls: 1 };

/** Cap the loop opens on the run's 'calls' pool at start/restore when none is configured (openBudget never widens). */
export const DEFAULT_CALLS_CAP = 400;

/**
 * Why an intention/goal ended without success, when it is not an ordinary step failure. 'ledger': the
 * run's accounting (a reservation or settlement) failed for a reason other than the budget; the loop stops.
 */
export type TerminalFailure = 'budget' | 'human' | 'policy' | 'ledger';

/**
 * The worktree state the runtime must restore an intention to before the loop dispatches any of its steps
 * again (S2 recovery: a worker died mid-step and its uncheckpointed writes must be discarded). `checkpointId`
 * is a value returned by LoopPorts.worktreeCheckpoint, or 'base' (the run's base commit). Cleared only by
 * Loop.confirmWorktreeRestored(intentionId, checkpointId).
 */
export interface WorktreeRequirement {
  checkpointId: string;
  /** The step whose interruption required it. */
  stepId: string;
  /** The intention attempt that will run next. */
  attempt: number;
  reason: string;
  /** Steps reset to pending because their effects are discarded with the worktree. */
  reset: string[];
}

/** resume() found the approval expired: the step was routed back (a gate.commit returns through verify) and must be approved afresh. */
export class ApprovalExpired extends Error {
  constructor(public readonly requestId: string) {
    super(`approval ${requestId} expired; the step returns for a fresh approval`);
    this.name = 'ApprovalExpired';
  }
}

export interface LoopPorts {
  manifest: Manifest;
  ledger: Ledger;
  library: PlanLibrary;
  planner: Planner;
  reflex: Reflex;
  worker: Worker;
  gates: GateRunner;
  validator: PlanValidator;
  /** Worker seats with a cost figure for the route reflex. */
  seats: SeatCost[];
  runId: string;
  actor?: Principal;
  sessionId?: string;
  /**
   * Absolute worktree path handed to every worker and gate step. Absent = '' (not configured), which
   * workers and gates are required to refuse.
   */
  worktree?: string;
  /**
   * Current lease fencing token for repo writes (worker steps). When present it is also the lease check:
   * a missing token, or one different from the first token this loop saw, means the lease was lost → the
   * loop stops (no dispatch, running steps aborted, no commit handed out).
   */
  fencingToken?: () => number | undefined;
  /** Aborted by the runtime when lease renewal fails: the loop stops and aborts every running step. */
  leaseSignal?: AbortSignal;
  /**
   * The worker child runs without OS isolation (sandbox profile resolved to isolation 'node'). Recorded on
   * the gate question and on approval requests; it no longer makes writes hold (D6: work-branch writes inside
   * allowedChanges proceed under any isolation, fenced by the write guard; the PR is the approval point).
   * The manifest's `sandbox.isolation === 'node'` also counts as degraded; this port can only add it.
   */
  isolationDegraded?: boolean;
  /**
   * The frontier seat (the planner model) for reflex escalation (D2: on by default). When the reflex answer
   * is abstained or below the manifest threshold and did not already come from the frontier, the loop asks
   * it; its answer may only tighten gate / closeOut / reconsider and must be one of the offered options for
   * triage / route (choosePlan escalates to planner.deliberate). The port meters its own calls.
   */
  frontier?: ReflexFrontier;
  /** Reservation per planner / model-reflex call on the run's 'calls', 'usd' and 'tokens' pools (default DEFAULT_LLM_RESERVATION). */
  llmReservation?: LlmReservation;
  /** Cap for the run's 'calls' pool, opened at start()/restore() (default DEFAULT_CALLS_CAP; never widens an existing cap). */
  callsCap?: number;
  /**
   * Snapshot the worktree and return a checkpoint id (e.g. a git tree object). Called after every worker step
   * completes and when a worker suspends; the id is recorded on step.completed / step.held and in the
   * intention (checkpointId). S2 recovery asks the runtime to restore the latest one (or 'base' when there is
   * none). A throwing port fails the step terminally ('human'): a write that cannot be checkpointed cannot be
   * recovered.
   */
  worktreeCheckpoint?: (a: { runId: string; intentionId: string; stepId: string; attempt: number; reason: 'completed' | 'suspended' }) => Promise<string>;
  /** Applied to every event payload before it reaches the ledger (e.g. makeRedactor(secrets).redactJson). */
  redact?: (value: Json) => Json;
  now?: () => number;
  ids?: () => string;
}

/** One recovery decision Loop.restore() took for a step (or a goal) it found unfinished. */
export interface RecoveryNote {
  /** '' for a goal-level note (re-deliberation of a goal that never got an intention). */
  intentionId: string;
  stepId: string;
  kind: StepKind | 'goal';
  goalId?: string;
  /** 'held' | 're-dispatch' | 'restart' | 'reconciled' | 'completed' | 'failed' | 'approved' | 'expired' */
  action: string;
  reason?: string;
}

export interface LoopStatus {
  /** 'stopped' after a ledger append failure or an unhandled cycle error: nothing else runs. */
  state: 'active' | 'stopped';
  stopReason?: string;
  goals: AchievementGoal[];
  intentions: Intention[];
  held: Array<{ intentionId: string; stepId: string; requestId: string }>;
  /** Durable run deadline (epoch ms on the loop's clock), recorded in run.started. */
  deadline?: number;
  /** Steps that are dispatchable now (restore re-queued them, or they are simply ready). */
  dispatchable?: number;
  /** Set by restore(): what it did with each unfinished step. */
  recovered?: RecoveryNote[];
  /**
   * Intentions that may not dispatch (or resume) until the runtime restored their worktree and called
   * confirmWorktreeRestored(intentionId, checkpointId). Survives restarts (recorded on intention.advanced).
   */
  requiredWorktreeState?: Record<string, WorktreeRequirement>;
  /** Classification when the loop stopped on an accounting failure ('ledger') or a budget refusal. */
  failure?: TerminalFailure;
}

/** Thrown by every entry point once the loop has stopped (a ledger append failed). */
export class LoopStopped extends Error {
  constructor(public readonly reason: string) {
    super(`loop stopped: ${reason}`);
    this.name = 'LoopStopped';
  }
}

/** A planner call could not be reserved or exceeded the run's budget or deadline. */
class BudgetExhausted extends Error {
  readonly code = 'budget';
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExhausted';
  }
}

/** The run's accounting failed for a non-budget reason (reserve/settle threw): the run terminates ('ledger'). */
class AccountingBroken extends Error {
  readonly code = 'ledger';
  constructor(message: string) {
    super(message);
    this.name = 'AccountingBroken';
  }
}

/** Who consumes the approval of a held step. Exactly one owner per approval. */
type ApprovalOwner = 'gate' | 'worker' | 'loop';

interface Held {
  intentionId: string;
  stepId: string;
  requestId: string;
  actionHash: string;
  owner: ApprovalOwner;
  resumeToken?: string;
  /** Worktree checkpoint taken when the worker suspended. */
  worktreeCheckpoint?: string;
}

type ExecMode = { kind: 'fresh' } | { kind: 'approved'; approval: GateApproval } | { kind: 'resume-worker'; resumeToken: string; grant: ApprovalGrant; requestId: string };

/** How a recovered gate step re-runs: verify must reproduce D1; review may reuse a recorded verdict instead of asking again. */
interface Recovery {
  expectD1?: string;
  reuse?: StepResult;
}

/** Gate exit codes that must never be retried: 8 policy refusal, 9 human needed. */
const TERMINAL_EXITS: ReadonlySet<number> = new Set([8, 9]);

const heldKey = (intentionId: string, stepId: string): string => `${intentionId}:${stepId}`;
const msgOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Ledger evidence of the run's state at restore time (indexed by the restore pass). */
interface RunScan {
  requests: Map<string, { intentionId: string; stepId: string; actionHash: string; owner?: ApprovalOwner; seq: number; candidateD1?: string | null }>;
  heldEvents: Map<string, Array<{ seq: number; requestId: string; owner?: ApprovalOwner; worktreeCheckpoint?: string }>>;
  /** D1 of every review.started per step (S5: how many reviewer calls were made for this candidate). */
  reviewStarts: Map<string, Array<string | null>>;
  startedSeq: Map<string, number>;
  consumedEv: Set<string>;
  commits: Map<string, { sha: string; seq: number }>;
  /** pr.opened / pr.requested per (intention, pr step). */
  prs: Map<string, { seq: number; evidenceKey: string; sha: string }>;
  tokens: Map<string, string>;
  failedPayload: Map<string, JsonObject>;
  /** Seq of each intention's latest snapshot event. */
  snapSeq: Map<string, number>;
  /** Latest recorded verify/review outcome per step (at most once: a recorded outcome is reused, never re-asked). */
  gateResults: Map<string, { seq: number; kind: EventKind; payload: JsonObject }>;
}

/**
 * The BDI cycle from the article: onEvent → match plans → planner writes one if none → choosePlan reflex
 * → intentions.push; tick runs every ready step concurrently; dispatch = gate → route → step.requested
 * → worker or gate runner; onStepDone → belief.added → closeOut reflex → advance or drop; reconsider
 * applies the commitment policy to new events. Every transition is an event on the ledger first; if the
 * ledger cannot take an event the loop stops (state 'stopped') instead of continuing unrecorded.
 *
 * Approvals (D6): gate.commit commits to the work branch without approval; gate.pr is the approval point. It
 * always holds, bound to prActionHash(intention, step, attempt, committed sha), only after a review.passed
 * for the committed candidate, and the PR gate consumes the grant. The loop never consumes a gate.pr grant
 * or a worker suspension's (the worker does, in resume()); it consumes only grants of other loop-level
 * holds, where no other party could. Worker writes never hold (no per-write approvals; the guard fences them).
 *
 * Budgets (D3): every planner call is reserved on the run's 'calls', 'usd' and 'tokens' pools before it and
 * settled after it. With budgets.enforce false (the default) a pool past its cap and a passed run deadline
 * are recorded (budget.exhausted, once per pool) and the run continues; with budgets.enforce true they end
 * the goal with a terminal 'budget' failure, and the run deadline (budgets.wallClockSec, recorded in
 * run.started, surviving a restart) is enforced before every dispatch, during every step and on restore.
 * Loop-safety limits (maxAttempts, maxDepth, maxIterations, per-exec timeouts) are always enforced.
 *
 * Achievement (D4): goal.achieved carries a proof {command, exitCode 0, fingerprint, evidenceKey,
 * verifiedAt} built from the final verify.passed evidence; without it the goal stays open.
 *
 * Recovery: restore() rebuilds the run from the ledger and decides, per unfinished step, per
 * docs/design/security.md §4 (S2–S9): re-hold, re-dispatch, restart with attempt + 1, reconcile a commit,
 * or fail terminally for a human. Nothing found running is ever silently forgotten.
 */
export class Loop {
  readonly bus: LedgerBus;
  readonly beliefs = new BeliefMap();
  readonly intentions: IntentionSet;
  private readonly goals = new Map<string, AchievementGoal>();
  private readonly held = new Map<string, Held>();
  private readonly running = new Map<string, AbortController>();
  /** Latest verify fingerprint (D1) and review fingerprint (D2) per intention. */
  private readonly verifyFp = new Map<string, string>();
  private readonly reviewFp = new Map<string, string>();
  /** Every verify fingerprint per intention with the attempt that produced it (progress check). */
  private readonly attemptFps = new Map<string, AttemptFingerprint[]>();
  /** Gate steps re-dispatched by restore(); verify re-runs must reproduce the recorded D1, review may reuse a verdict. */
  private readonly recovering = new Map<string, Recovery>();
  /** Worker completions per intention: identifies the worker execution a candidate came from (ADV-8). */
  private readonly workerExecs = new Map<string, number>();
  /** Latest worktree checkpoint per intention, and the writing worker steps completed since it without one. */
  private readonly cpState = new Map<string, { checkpointId?: string; uncheckpointed: Set<string> }>();
  /** Intentions blocked until the runtime restores their worktree (S2). */
  private readonly awaitingWorktree = new Map<string, WorktreeRequirement>();
  /** The commit each intention's gate.commit recorded (sha) and the candidate it committed (d1). */
  private readonly committed = new Map<string, { sha: string; d1?: string; evidenceKey?: string }>();
  /** Candidates (D1) a review.passed approved, per intention. */
  private readonly reviewedD1 = new Map<string, Set<string>>();
  /** Pools already reported exhausted (budget.exhausted is informational, once per pool). */
  private readonly exhaustedPools = new Set<string>();
  /** Latest recorded review verdict per step (S5/S7: reused for the same D1 instead of asking the reviewer again). */
  private readonly reviewResults = new Map<string, StepResult>();
  /** In-flight metered LLM calls: aborted when the loop stops (lease loss) so billed requests are cancelled. */
  private readonly llmInFlight = new Set<AbortController>();
  /** Loop-owned approvals restore() found already consumed: execute without asking again. */
  private readonly preApproved = new Map<string, GateApproval>();
  private readonly actor: Principal;
  private readonly now: () => number;
  private readonly ids: () => string;
  private readonly nonce: string;
  private deadline: number;
  /** First fencing token observed; any later difference is a lost lease. */
  private fence: number | undefined;
  private stopped: { reason: string; failure?: TerminalFailure } | null = null;
  private seq = 0;
  private llmCalls = 0;

  constructor(private readonly p: LoopPorts) {
    this.bus = new LedgerBus(p.ledger);
    this.intentions = new IntentionSet(p.manifest.concurrency.perAgent);
    this.actor = p.actor ?? { kind: 'system', id: 'loop' };
    this.now = p.now ?? Date.now;
    // Random suffix: a restarted loop must never reuse an event id (the ledger would drop it as a duplicate).
    this.nonce = randomUUID().slice(0, 8);
    this.ids = p.ids ?? (() => `${p.runId}_${this.nonce}_${++this.seq}`);
    this.deadline = this.now() + p.manifest.budgets.wallClockSec * 1000;
    this.bus.subscribe('*', async (e) => {
      try {
        await this.onEvent(e);
      } catch (err) {
        if (!(err instanceof LoopStopped)) this.stop(`event handler failed on ${e.kind}: ${msgOf(err)}`, isAccountingBroken(err) ? 'ledger' : undefined);
      }
    });
    const lease = p.leaseSignal;
    if (lease) {
      const lost = () => this.stop(`lease lost: ${msgOf(lease.reason ?? 'renewal failed')}`);
      if (lease.aborted) lost();
      else lease.addEventListener('abort', lost, { once: true });
    }
  }

  /** Lease check (when a fencing-token port is wired): null when still held, else why it is lost. */
  private leaseProblem(): string | null {
    if (!this.p.fencingToken) return null;
    let t: number | undefined;
    try {
      t = this.p.fencingToken();
    } catch (err) {
      return `lease lost: fencing token unavailable (${msgOf(err)})`;
    }
    if (typeof t !== 'number' || !Number.isFinite(t)) return 'lease lost: no fencing token';
    if (this.fence === undefined) this.fence = t;
    else if (t !== this.fence) return `lease lost: fencing token changed ${this.fence} → ${t}`;
    return null;
  }

  /** Stop on a lost lease before any mutation is dispatched; true when the loop must not proceed. */
  private leaseLost(): boolean {
    if (this.stopped) return true;
    const problem = this.leaseProblem();
    if (problem) this.stop(problem);
    return problem !== null;
  }

  private get sessionId(): string {
    return this.p.sessionId ?? 'local';
  }

  /** Fail closed: the manifest's node isolation is degraded whatever the port says. */
  private get isolationDegraded(): boolean {
    return this.p.isolationDegraded === true || this.p.manifest.sandbox.isolation === 'node';
  }

  /** D3: budgets end the run only when the manifest enforces them. */
  private get budgetsEnforced(): boolean {
    return this.p.manifest.budgets.enforce === true;
  }

  /** Record (once per pool) that an unenforced budget passed its cap; the run continues. */
  private async noteBudgetExhausted(pool: string, detail: JsonObject): Promise<void> {
    if (this.exhaustedPools.has(pool)) return;
    this.exhaustedPools.add(pool);
    await this.emit('budget.exhausted', { pool, enforced: false, ...detail }, {});
  }

  /**
   * True when the run deadline passed and budgets are enforced (the caller fails terminally with 'budget').
   * A passed deadline under budgets.enforce false is recorded as budget.exhausted and ignored.
   */
  private async deadlineStops(): Promise<boolean> {
    if (!this.deadlinePassed()) return false;
    if (this.budgetsEnforced) return true;
    await this.noteBudgetExhausted('wallClock', { deadline: this.deadline, at: this.now(), wallClockSec: this.p.manifest.budgets.wallClockSec });
    return false;
  }

  /**
   * Ask a reflex seam. A seam the manifest sets to 'model' or 'frontier' calls an LLM on every ask, so the
   * call is metered like a planner call (reserved before, settled after; exhaustion is a budget failure).
   * Escalations of a 'rule' seam to the frontier are metered by the frontier itself (runtime ModelFrontier).
   */
  private async ask<S extends ReflexSeam>(seam: S, q: ReflexQuestions[S]): Promise<ReflexResult<S>> {
    const setting = (this.p.manifest.reflexes as Record<string, unknown>)[seam];
    const r =
      setting === 'model' || setting === 'frontier'
        ? await this.metered(`reflex.${seam}`, (meter) => this.p.reflex.ask(seam, q, { ...(meter.signal ? { signal: meter.signal } : {}), meter }))
        : await this.p.reflex.ask(seam, q);
    // D2: frontier escalation by default. choosePlan escalates to planner.deliberate instead.
    const shaky = r.abstained || r.confidence < this.p.manifest.reflexes.threshold;
    if (!shaky || r.provider === 'frontier' || !this.p.frontier || seam === 'choosePlan') return r;
    const f = await this.p.frontier.decide(seam, q);
    const merged = noLooser(seam, q, r, f);
    await this.emit('decision.recorded', { seam, provider: 'frontier', outcome: 'escalated', setting: String(setting), answer: merged.answer as unknown as Json, from: r.answer as unknown as Json, confidence: merged.confidence, via: 'loop' }, {});
    return merged;
  }

  private deadlinePassed(): boolean {
    return this.now() >= this.deadline;
  }

  // ---------- public entry points ----------

  /** Record run.started with the durable run deadline (now + budgets.wallClockSec). */
  async start(manifestHash: string): Promise<void> {
    this.deadline = this.now() + this.p.manifest.budgets.wallClockSec * 1000;
    await this.openCallsPool();
    await this.emit('run.started', { manifestHash, deadline: this.deadline, wallClockSec: this.p.manifest.budgets.wallClockSec }, {});
  }

  /**
   * Every LLM call reserves one 'calls'; open the pool (openBudget never widens a cap, nor relaxes an
   * enforced pool, the runtime already set). Soft unless budgets.enforce (D3).
   */
  private async openCallsPool(): Promise<void> {
    try {
      await this.p.ledger.openBudget(this.p.runId, 'calls', this.p.callsCap ?? DEFAULT_CALLS_CAP, { enforce: this.budgetsEnforced });
    } catch (err) {
      this.stop(`ledger could not open the calls pool: ${msgOf(err)}`, 'ledger');
      throw new LoopStopped(this.stopped!.reason);
    }
  }

  /**
   * The runtime restored the worktree of a blocked intention (S2) to the required checkpoint, after making
   * sure no writer of the previous process survives. Until this is called the intention dispatches and
   * resumes nothing. `checkpointId`, when given, must equal the required one (else this throws and the
   * intention stays blocked). Recorded on the ledger, so a later restart does not ask again.
   */
  async confirmWorktreeRestored(intentionId: string, checkpointId?: string): Promise<void> {
    this.throwIfStopped();
    const req = this.awaitingWorktree.get(intentionId);
    if (!req) throw new Error(`intention ${intentionId} is not waiting for a worktree restore`);
    if (checkpointId !== undefined && checkpointId !== req.checkpointId) throw new Error(`intention ${intentionId} needs its worktree at ${req.checkpointId}, not ${checkpointId}`);
    const i = this.intentions.get(intentionId)!;
    await this.emit('intention.advanced', { intention: i as unknown as Json, worktreeRestored: req.checkpointId, step: req.stepId }, this.traceFor(intentionId));
    this.awaitingWorktree.delete(intentionId);
  }

  /** Dispatchable steps, minus intentions blocked on a worktree restore. */
  private dispatchable(): ReturnType<IntentionSet['dispatchable']> {
    return this.intentions.dispatchable().filter((b) => !this.awaitingWorktree.has(b.intention.id));
  }

  async adoptGoal(g: Omit<AchievementGoal, 'status' | 'evidence' | 'commitment'> & { commitment?: Commitment }): Promise<AchievementGoal> {
    const goal: AchievementGoal = { ...g, commitment: g.commitment ?? this.p.manifest.commitment, status: 'open', evidence: [] };
    this.goals.set(goal.id, goal);
    await this.emit('goal.adopted', { goal: goal as unknown as Json }, { goalId: goal.id });
    this.throwIfStopped();
    return this.goals.get(goal.id)!;
  }

  /** Publish an external fact. The projection updates and running intentions reconsider. */
  async addBelief(key: string, value: Json, provenance?: { src: string; trust: 'trusted' | 'untrusted' }): Promise<void> {
    await this.emit('belief.added', { key, value, provenance: (provenance ?? { src: 'external', trust: 'untrusted' }) as unknown as Json }, {});
    this.throwIfStopped();
  }

  /** Run ticks until nothing can proceed (all intentions terminal or held) or the loop stops. */
  async runUntilQuiescent(maxTicks = 1000): Promise<LoopStatus> {
    for (let t = 0; t < maxTicks && !this.stopped; t++) {
      const progressed = await this.tick();
      if (!progressed && this.intentions.runningSteps() === 0) break;
    }
    return this.status();
  }

  /** One pulse: dispatch every dispatchable step concurrently and wait for them. */
  async tick(): Promise<boolean> {
    if (this.stopped) return false;
    const batch = this.dispatchable();
    if (batch.length === 0) return false;
    await Promise.all(batch.map((b) => this.dispatch(b.intention.id, b.step.id)));
    return !this.stopped;
  }

  /**
   * Resume a held step after a human granted its approval. The loop checks the grant (state 'granted',
   * same session, same action hash, not expired) but does not consume it unless it is the owner:
   * gate.pr → the PR gate consumes (approval passed in GateContext); worker suspension → the worker
   * consumes in worker.resume(resumeToken, grant); any other loop-level hold → the loop consumes.
   * Every consumption goes through Ledger.consume, which refuses a grant without its approval.granted event.
   */
  async resume(requestId: string, grant: ApprovalGrant): Promise<void> {
    this.throwIfStopped();
    if (this.leaseLost()) throw new LoopStopped(this.stopped!.reason);
    const h = [...this.held.values()].find((x) => x.requestId === requestId);
    if (!h) throw new Error(`no held step for approval ${requestId}`);
    if (this.awaitingWorktree.has(h.intentionId)) throw new Error(`intention ${h.intentionId} waits for its worktree to be restored (confirmWorktreeRestored) before anything resumes`);
    if (grant.requestId !== requestId) throw new Error(`grant is for ${grant.requestId}, not ${requestId}`);
    const view = await requireApproval(this.p.ledger, requestId);
    if (!view) throw new Error(`approval ${requestId} is unknown to the ledger`);
    if (view.state === 'expired' || ((view.state === 'granted' || view.state === 'pending') && view.expiresAt <= this.now())) {
      // S7 expiry while live: never consumable; a commit returns through verify for a fresh approval.
      await this.expireHold(h, view);
      throw new ApprovalExpired(requestId);
    }
    if (view.state !== 'granted') throw new Error(`approval ${requestId} is ${view.state}, not granted`);
    if (view.sessionId !== this.sessionId) throw new Error(`approval ${requestId} belongs to another session`);
    if (view.actionHash !== h.actionHash) throw new Error(`approval ${requestId} is bound to a different action`);
    if (view.approver && (view.approver.kind !== grant.approver.kind || view.approver.id !== grant.approver.id)) throw new Error(`grant approver does not match the ledger for ${requestId}`);
    let i = this.intentions.get(h.intentionId);
    if (!i || i.status !== 'held') throw new Error(`intention ${h.intentionId} is not held`);
    const plan = this.intentions.planOf(i.id);
    const step = plan.steps.find((s) => s.id === h.stepId);
    if (!step) throw new Error(`plan ${plan.id} has no step ${h.stepId}`);
    this.held.delete(heldKey(h.intentionId, h.stepId));

    if (h.owner === 'worker') {
      if (!h.resumeToken) throw new Error(`held worker step ${h.stepId} has no resume token`);
      i = clearHold(transitionIntention(i, 'running'));
      this.intentions.update(i);
      await this.emit('intention.advanced', { intention: i as unknown as Json, resumed: h.stepId, requestId }, this.traceFor(i.id));
      await this.execute(i.id, step, { kind: 'resume-worker', resumeToken: h.resumeToken, grant, requestId });
      return;
    }
    i = transitionStep(i, h.stepId, 'ready');
    i = clearHold(transitionIntention(i, 'running'));
    this.intentions.update(i);
    await this.emit('intention.advanced', { intention: i as unknown as Json, resumed: h.stepId, requestId }, this.traceFor(i.id));
    const approval: GateApproval = { requestId, sessionId: this.sessionId, actionHash: h.actionHash };
    if (h.owner === 'loop') {
      try {
        await this.p.ledger.consume(requestId, h.actionHash, this.sessionId, `consume:${requestId}`, this.now());
      } catch (err) {
        await this.failStep(i, plan, step, `approval ${requestId} could not be consumed: ${msgOf(err)}`, { terminal: true, failure: 'policy' });
        return;
      }
      await this.emit('approval.consumed', { requestId, by: 'loop', approver: grant.approver as unknown as Json }, this.traceFor(i.id, step.id));
    }
    await this.execute(i.id, step, { kind: 'approved', approval });
  }

  /**
   * Rebuild this run from the ledger in a fresh process (goals, intentions with their step statuses, held
   * steps, candidate fingerprints, the run deadline) and recover every unfinished step
   * (docs/design/security.md §4):
   *
   * - held / approval requested (S7): pending or granted → held again (durable: a missing step.held or
   *   intention.held is re-emitted), so resume(requestId, grant) works; expired → approval.expired and the
   *   step is re-dispatched (a fresh approval is requested); denied → terminal policy failure.
   * - worker running (S2/S3): step.interrupted evidence, then a held worker resume whose grant is still
   *   unconsumed is held again with its resume token; otherwise the step restarts from scratch with
   *   attempt + 1 (or fails when no attempt remains).
   * - gate.verify running (S4/S6): verify.interrupted evidence, re-run; the re-run must reproduce the D1
   *   already recorded for this attempt, else a terminal 'human' failure.
   * - gate.review running (S5): step.interrupted evidence, re-dispatched with ctx.recovered (the gate is
   *   at-most-once per (run, D1): it reuses its evidence or re-asks).
   * - gate.commit running (S8): commit.recorded already present → completed; grant still unconsumed →
   *   held again; otherwise gates.reconcile(ctx) → commit.recorded (idempotent by (runId, sha)) or a
   *   terminal 'human' failure; without reconcile → terminal 'human' failure. commit() is never re-run.
   * - all steps done but the intention not closed (S9) → closed and the goal settled.
   * - run deadline passed → every unfinished intention fails with a terminal 'budget' failure.
   *
   * Returns the status with `recovered` notes; the caller then drives the loop (runUntilQuiescent) and
   * resumes granted holds.
   */
  async restore(runId?: string): Promise<LoopStatus> {
    if (runId !== undefined && runId !== this.p.runId) throw new Error(`restore(${runId}) on a loop for run ${this.p.runId}`);
    if (this.goals.size || this.intentions.all().length) throw new Error('restore() must run on a fresh Loop');
    const plans = new Map<string, Plan>();
    const snaps = new Map<string, { i: Intention; seq: number }>();
    const stepEvs = new Map<string, Array<{ seq: number; kind: string; stepId: string; payload: JsonObject }>>();
    const scan: RunScan = { requests: new Map(), heldEvents: new Map(), reviewStarts: new Map(), startedSeq: new Map(), consumedEv: new Set(), commits: new Map(), prs: new Map(), tokens: new Map(), failedPayload: new Map(), snapSeq: new Map(), gateResults: new Map() };
    const attemptNow = new Map<string, number>();
    /** Worktree restores required by an earlier restore and not yet confirmed (a crash in between must not forget them). */
    const pendingWt = new Map<string, WorktreeRequirement>();
    let deadline: number | undefined;
    let firstAt: number | undefined;
    await this.openCallsPool();
    for await (const e of this.p.ledger.events({ runId: this.p.runId })) {
      const seq = (e as TeceraEvent & { seq: number }).seq;
      firstAt ??= e.at;
      this.beliefs.apply(e);
      const pl = e.payload as Record<string, unknown>;
      const iid = e.trace.intentionId;
      const sid = e.trace.stepId;
      if (e.kind === 'run.started') {
        if (typeof pl.deadline === 'number') deadline = deadline === undefined ? pl.deadline : Math.min(deadline, pl.deadline);
      } else if (e.kind === 'goal.adopted' || e.kind === 'goal.achieved' || e.kind === 'goal.dropped' || e.kind === 'goal.demoted') {
        const g = pl.goal as AchievementGoal | undefined;
        if (g?.id) this.goals.set(g.id, g);
      } else if (e.kind === 'plan.generated') {
        const plan = pl.plan as Plan | undefined;
        if (plan?.id) plans.set(plan.id, plan);
      } else if (e.kind.startsWith('intention.')) {
        const it = pl.intention as Intention | undefined;
        if (it?.id) {
          snaps.set(it.id, { i: it, seq });
          scan.snapSeq.set(it.id, seq);
          attemptNow.set(it.id, it.attempt);
          if (e.kind === 'intention.held' && it.resumeToken) {
            const hs = Object.entries(it.stepStatus).find(([, st]) => st === 'held')?.[0];
            if (hs) scan.tokens.set(heldKey(it.id, hs), it.resumeToken);
          }
          const wr = pl.worktreeRequired as Partial<WorktreeRequirement> | undefined;
          if (e.kind === 'intention.advanced' && wr && typeof wr.checkpointId === 'string' && typeof wr.stepId === 'string') {
            pendingWt.set(it.id, { checkpointId: wr.checkpointId, stepId: wr.stepId, attempt: typeof wr.attempt === 'number' ? wr.attempt : it.attempt, reason: typeof wr.reason === 'string' ? wr.reason : 'worktree restore required', reset: Array.isArray(wr.reset) ? wr.reset.filter((x): x is string => typeof x === 'string') : [] });
          }
          if (e.kind === 'intention.advanced' && typeof pl.worktreeRestored === 'string' && pendingWt.get(it.id)?.checkpointId === pl.worktreeRestored) pendingWt.delete(it.id);
        }
      } else if (e.kind.startsWith('step.') && iid && sid) {
        const k = heldKey(iid, sid);
        if (!stepEvs.has(iid)) stepEvs.set(iid, []);
        stepEvs.get(iid)!.push({ seq, kind: e.kind, stepId: sid, payload: e.payload });
        if (e.kind === 'step.started') scan.startedSeq.set(k, seq);
        if (e.kind === 'step.failed') scan.failedPayload.set(k, e.payload);
        if (e.kind === 'step.held' && typeof pl.requestId === 'string') {
          if (!scan.heldEvents.has(k)) scan.heldEvents.set(k, []);
          scan.heldEvents.get(k)!.push({ seq, requestId: pl.requestId, ...(isOwner(pl.owner) ? { owner: pl.owner } : {}), ...(typeof pl.worktreeCheckpoint === 'string' ? { worktreeCheckpoint: pl.worktreeCheckpoint } : {}) });
        }
      } else if (e.kind === 'approval.requested' && typeof pl.requestId === 'string' && iid && sid) {
        const candidateD1 = typeof pl.candidateD1 === 'string' ? pl.candidateD1 : null;
        scan.requests.set(pl.requestId, { intentionId: iid, stepId: sid, actionHash: String(pl.actionHash ?? ''), ...(isOwner(pl.owner) ? { owner: pl.owner } : {}), seq, candidateD1 });
      } else if (e.kind === 'approval.consumed' && typeof pl.requestId === 'string') {
        scan.consumedEv.add(pl.requestId);
      } else if (e.kind === 'review.started' && iid && sid) {
        const k = heldKey(iid, sid);
        if (!scan.reviewStarts.has(k)) scan.reviewStarts.set(k, []);
        scan.reviewStarts.get(k)!.push(typeof pl.d1 === 'string' ? pl.d1 : null);
      }
      if ((e.kind === 'verify.passed' || e.kind === 'verify.failed' || e.kind === 'review.passed' || e.kind === 'review.rejected') && iid && sid) {
        scan.gateResults.set(heldKey(iid, sid), { seq, kind: e.kind, payload: e.payload });
      }
      if ((e.kind === 'verify.passed' || e.kind === 'verify.failed') && iid) {
        if (typeof pl.fingerprint === 'string') this.verifyFp.set(iid, pl.fingerprint);
        const attempt = typeof pl.attempt === 'number' ? pl.attempt : (attemptNow.get(iid) ?? 1);
        this.recordAttemptFp(iid, attempt, typeof pl.fingerprint === 'string' ? pl.fingerprint : null, typeof pl.workerExec === 'number' ? pl.workerExec : undefined);
      } else if ((e.kind === 'review.passed' || e.kind === 'review.rejected') && iid) {
        if (typeof pl.fingerprint === 'string') this.reviewFp.set(iid, pl.fingerprint);
        if (sid) this.reviewResults.set(heldKey(iid, sid), recordedResult('gate.review', e.payload));
        if (e.kind === 'review.passed' && typeof pl.d1 === 'string') this.noteReviewed(iid, pl.d1);
      } else if (e.kind === 'commit.recorded' && iid && sid && typeof pl.sha === 'string') {
        scan.commits.set(heldKey(iid, sid), { sha: pl.sha, seq });
        if (pl.valid !== false) this.committed.set(iid, { sha: pl.sha, ...(typeof pl.d1 === 'string' ? { d1: pl.d1 } : {}), ...(typeof pl.evidenceKey === 'string' ? { evidenceKey: pl.evidenceKey } : {}) });
      } else if ((e.kind === 'pr.opened' || e.kind === 'pr.requested') && iid && sid) {
        scan.prs.set(heldKey(iid, sid), { seq, evidenceKey: typeof pl.evidenceKey === 'string' ? pl.evidenceKey : '', sha: typeof pl.sha === 'string' ? pl.sha : '' });
      }
    }
    if (deadline !== undefined) this.deadline = deadline;
    else if (firstAt !== undefined) this.deadline = firstAt + this.p.manifest.budgets.wallClockSec * 1000;

    // Rebuild intentions: the latest snapshot plus the step events recorded after it.
    for (const { i: snap, seq } of snaps.values()) {
      const plan = plans.get(snap.planId) ?? (await this.p.library.get(snap.planId));
      if (!plan) throw new Error(`cannot restore intention ${snap.id}: plan ${snap.planId} not found`);
      let i: Intention = structuredClone(snap);
      for (const ev of stepEvs.get(i.id) ?? []) {
        if (ev.seq <= seq || i.stepStatus[ev.stepId] === undefined) continue;
        if (ev.kind === 'step.started') i = { ...i, stepStatus: { ...i.stepStatus, [ev.stepId]: 'running' }, status: i.status === 'committed' ? 'running' : i.status };
        else if (ev.kind === 'step.completed') i = { ...i, stepStatus: { ...i.stepStatus, [ev.stepId]: 'done' } };
        else if (ev.kind === 'step.failed') i = { ...i, stepStatus: { ...i.stepStatus, [ev.stepId]: 'failed' } };
        else if (ev.kind === 'step.held') i = { ...i, stepStatus: { ...i.stepStatus, [ev.stepId]: 'held' } };
      }
      this.intentions.add(i, plan);
      // Worker executions and worktree checkpoints, over the whole history (not only after the snapshot).
      const cp: { checkpointId?: string; uncheckpointed: Set<string> } = { uncheckpointed: new Set() };
      let execs = 0;
      for (const ev of stepEvs.get(i.id) ?? []) {
        const s = plan.steps.find((x) => x.id === ev.stepId);
        if (ev.kind !== 'step.completed' || s?.kind !== 'worker') continue;
        execs++;
        if (typeof ev.payload.worktreeCheckpoint === 'string') {
          cp.checkpointId = ev.payload.worktreeCheckpoint;
          cp.uncheckpointed.clear();
        } else if (this.riskOf(plan, s) !== 'read') cp.uncheckpointed.add(s.id);
      }
      this.workerExecs.set(i.id, execs);
      this.cpState.set(i.id, cp);
    }

    // Recover every unfinished step of every active intention.
    const notes: RecoveryNote[] = [];
    for (const snap of [...this.intentions.all()]) {
      if (this.stopped) break;
      if (!this.isActive(snap)) continue;
      const plan = this.intentions.planOf(snap.id);
      if (await this.deadlineStops()) {
        await this.recoverPastDeadline(snap.id, plan, notes);
        continue;
      }
      for (const step of plan.steps) {
        const cur = this.intentions.get(snap.id)!;
        if (!this.isActive(cur)) break;
        const st = cur.stepStatus[step.id];
        if (st === 'running') await this.recoverRunning(cur.id, plan, step, scan, notes);
        else if (st === 'ready' || st === 'held') await this.recoverWaiting(cur.id, plan, step, scan, notes);
        else if (st === 'failed') await this.recoverFailed(cur.id, plan, step, scan, notes);
        else if (st === 'pending') {
          // dispatch() does not snapshot 'ready': a pending step with an approval requested after the latest
          // snapshot was being held when the process died (S7, approval.requested before step.held).
          const k = heldKey(cur.id, step.id);
          if (this.latestRequestFor(k, scan, Math.max(scan.startedSeq.get(k) ?? -1, scan.snapSeq.get(cur.id) ?? -1))) await this.recoverWaiting(cur.id, plan, step, scan, notes, scan.snapSeq.get(cur.id));
        }
      }
      const after = this.intentions.get(snap.id)!;
      if (this.isActive(after) && after.status !== 'held' && this.intentions.allStepsDone(after)) {
        // S9: every step done but the intention never closed.
        await this.closeIntention(after.id, plan);
        notes.push({ intentionId: after.id, stepId: plan.steps[plan.steps.length - 1]!.id, kind: plan.steps[plan.steps.length - 1]!.kind, action: 'completed', reason: 'intention closed on restore' });
      } else if (after.status === 'held' && ![...this.held.values()].some((h) => h.intentionId === after.id)) {
        // A held snapshot without a live hold (its step was recovered otherwise): run again.
        const unheld = clearHold({ ...after, status: 'running' });
        this.intentions.update(unheld);
        await this.emit('intention.advanced', { intention: unheld as unknown as Json, recovered: true }, this.traceFor(after.id));
      }
      // A restore required by an earlier restart and never confirmed still blocks this intention.
      const pend = pendingWt.get(snap.id);
      const now = this.intentions.get(snap.id)!;
      if (pend && this.isActive(now) && !this.awaitingWorktree.has(snap.id)) {
        this.awaitingWorktree.set(snap.id, pend);
        notes.push({ intentionId: snap.id, stepId: pend.stepId, kind: plan.steps.find((s) => s.id === pend.stepId)?.kind ?? 'worker', action: 'restore-worktree', reason: `worktree restore to ${pend.checkpointId} still unconfirmed` });
      }
    }
    // A goal adopted but never planned (the process died while deliberating): deliberate again.
    for (const goal of [...this.goals.values()]) {
      if (this.stopped || goal.status !== 'open') continue;
      if (this.intentions.all().some((x) => x.goalId === goal.id)) continue;
      if (await this.deadlineStops()) {
        await this.dropGoal(goal, 'budget: run deadline exceeded', undefined, { terminal: true, failure: 'budget' });
        notes.push({ intentionId: '', stepId: '', kind: 'goal', goalId: goal.id, action: 'failed', reason: 'run deadline exceeded' });
        continue;
      }
      const adopted = await this.lastEvent('goal.adopted', goal.id);
      if (!adopted) continue;
      notes.push({ intentionId: '', stepId: '', kind: 'goal', goalId: goal.id, action: 're-deliberate', reason: 'goal adopted but never planned' });
      await this.deliberate(goal, adopted);
    }
    return { ...this.status(), recovered: notes };
  }

  status(): LoopStatus {
    return {
      state: this.stopped ? 'stopped' : 'active',
      ...(this.stopped ? { stopReason: this.stopped.reason } : {}),
      ...(this.stopped?.failure ? { failure: this.stopped.failure } : {}),
      goals: [...this.goals.values()],
      intentions: this.intentions.all(),
      held: [...this.held.values()].map(({ intentionId, stepId, requestId }) => ({ intentionId, stepId, requestId })),
      deadline: this.deadline,
      dispatchable: this.dispatchable().length,
      ...(this.awaitingWorktree.size ? { requiredWorktreeState: Object.fromEntries([...this.awaitingWorktree].map(([k, v]) => [k, { ...v, reset: [...v.reset] }])) } : {}),
    };
  }

  goal(id: string): AchievementGoal | undefined {
    return this.goals.get(id);
  }

  // ---------- recovery (restore) ----------

  private async interruptedEvidence(i: Intention, step: Step, action: string): Promise<string> {
    const key = `interrupted:${this.p.runId}:${i.id}:${step.id}:${i.attempt}:${this.nonce}`;
    try {
      await this.p.ledger.evidence({ key, kind: step.kind === 'gate.verify' ? 'verify.interrupted' : 'step.interrupted', runId: this.p.runId, body: { intentionId: i.id, stepId: step.id, stepKind: step.kind, attempt: i.attempt, action, at: this.now() } });
    } catch (err) {
      this.stop(`ledger refused interrupted evidence for ${step.id}: ${msgOf(err)}`);
      throw new LoopStopped(this.stopped!.reason);
    }
    const payload = { step: step.id, kind: step.kind, attempt: i.attempt, action, evidenceKey: key };
    if (step.kind === 'gate.verify') await this.emit('verify.interrupted', payload, this.traceFor(i.id, step.id));
    else await this.emit('step.interrupted', payload, this.traceFor(i.id, step.id));
    return key;
  }

  /**
   * The review gate's recorded verdict for (run, D1) (evidence key reviewEvidenceKey), as a step result, or
   * null when none is recorded. Approve only for an approve verdict on exactly D1 with an unchanged tree
   * (fingerprintBefore = fingerprintAfter = D1) that is not terminal; anything else recorded is a terminal
   * 'human' rejection (never a reason to ask the reviewer again).
   */
  private async recordedReview(d1: string): Promise<Extract<StepResult, { kind: 'gate.review' }> | null> {
    const key = reviewEvidenceKey(this.p.runId, d1);
    let rec: Awaited<ReturnType<Ledger['getEvidence']>>;
    try {
      rec = await this.p.ledger.getEvidence(key);
    } catch {
      return null;
    }
    if (!rec || rec.runId !== this.p.runId) return null;
    const b = (rec.body && typeof rec.body === 'object' && !Array.isArray(rec.body) ? rec.body : {}) as JsonObject;
    const approve = b.verdict === 'approve' && b.terminal !== true && b.fingerprintBefore === d1 && b.fingerprintAfter === d1;
    if (approve) return { kind: 'gate.review', verdict: 'approve', evidenceKey: key, fingerprint: d1, reason: 'reused the recorded review for this D1' };
    if (b.verdict === 'reject' && b.terminal !== true && b.fingerprintBefore === d1) return { kind: 'gate.review', verdict: 'reject', evidenceKey: key, reason: 'reused the recorded rejection for this D1' };
    return { kind: 'gate.review', verdict: 'reject', evidenceKey: key, terminal: true, failure: 'human', reason: `the recorded review for D1 ${d1} is unusable (verdict ${JSON.stringify(b.verdict ?? null)}, terminal ${String(b.terminal === true)}, before ${String(b.fingerprintBefore)}, after ${String(b.fingerprintAfter)})` };
  }

  private setStep(intentionId: string, stepId: string, st: Intention['stepStatus'][string], patch: Partial<Intention> = {}): Intention {
    const cur = this.intentions.get(intentionId)!;
    const next: Intention = { ...cur, ...patch, stepStatus: { ...cur.stepStatus, [stepId]: st } };
    this.intentions.update(next);
    return next;
  }

  /** Back to pending so tick() re-dispatches it; the intention runs (a stale 'held' is cleared). */
  private async requeue(intentionId: string, step: Step, note: Record<string, Json>): Promise<void> {
    const cur = this.intentions.get(intentionId)!;
    const status = cur.status === 'held' || cur.status === 'committed' ? 'running' : cur.status;
    this.held.delete(heldKey(intentionId, step.id));
    const i = clearHold(this.setStep(intentionId, step.id, 'pending', { status }));
    this.intentions.update(i);
    await this.emit('intention.advanced', { intention: i as unknown as Json, recovered: step.id, ...note }, this.traceFor(i.id));
  }

  /**
   * Steps whose effects disappear when the worktree goes back to the intention's latest checkpoint: the
   * given roots, every writing worker step completed after that checkpoint, and everything downstream of
   * them that is not pending.
   */
  private discardSet(intentionId: string, plan: Plan, roots: string[]): string[] {
    const i = this.intentions.get(intentionId)!;
    const out = new Set<string>([...roots, ...(this.cpState.get(intentionId)?.uncheckpointed ?? [])]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const s of plan.steps) {
        if (out.has(s.id) || i.stepStatus[s.id] === 'pending') continue;
        if (s.dependsOn.some((d) => out.has(d))) {
          out.add(s.id);
          changed = true;
        }
      }
    }
    return plan.steps.filter((s) => out.has(s.id)).map((s) => s.id);
  }

  /** Block an intention until the runtime restored its worktree (durable: recorded on intention.advanced). */
  private async requireWorktree(intentionId: string, req: WorktreeRequirement, extra: Record<string, Json> = {}): Promise<void> {
    this.awaitingWorktree.set(intentionId, req);
    const i = this.intentions.get(intentionId)!;
    await this.emit('intention.advanced', { intention: i as unknown as Json, ...extra, worktreeRequired: { ...req, reset: [...req.reset] } }, this.traceFor(intentionId));
  }

  /**
   * Worker restart from scratch with attempt + 1 (fails the step when no attempt remains). Its partial,
   * uncheckpointed writes must be discarded first: the intention goes back to its latest worktree checkpoint
   * (or 'base'), every step whose effects that discards is reset, and nothing dispatches until the runtime
   * confirms the restore (confirmWorktreeRestored). S2 of security.md §4.
   */
  private async restartWorker(intentionId: string, plan: Plan, step: Step, reason: string, notes: RecoveryNote[]): Promise<void> {
    const cur = this.intentions.get(intentionId)!;
    if (cur.attempt >= this.p.manifest.budgets.maxAttempts) {
      await this.failStep(cur, plan, step, `interrupted: ${reason}; no attempt remains`, { terminal: true });
      notes.push({ intentionId, stepId: step.id, kind: step.kind, action: 'failed', reason });
      return;
    }
    const reset = this.discardSet(intentionId, plan, [step.id]);
    const cp = this.cpState.get(intentionId) ?? { uncheckpointed: new Set<string>() };
    this.cpState.set(intentionId, cp);
    const stepStatus = { ...cur.stepStatus };
    for (const id of reset) {
      stepStatus[id] = 'pending';
      this.held.delete(heldKey(intentionId, id));
      cp.uncheckpointed.delete(id);
    }
    const status = cur.status === 'held' || cur.status === 'committed' ? 'running' : cur.status;
    const i = clearHold({ ...cur, status, attempt: cur.attempt + 1, stepStatus });
    this.intentions.update(i);
    await this.requireWorktree(intentionId, { checkpointId: cp.checkpointId ?? 'base', stepId: step.id, attempt: i.attempt, reason, reset }, { recovered: step.id, retry: step.id, attempt: i.attempt, reason });
    notes.push({ intentionId, stepId: step.id, kind: step.kind, action: 'restart', reason });
  }

  /** Park a step on an approval again (durable: step.held / intention.held re-emitted when missing). */
  private async rehold(intentionId: string, step: Step, view: ApprovalView, owner: ApprovalOwner, hasHeldEvent: boolean, resumeToken?: string, extra: { worktreeCheckpoint?: string } = {}): Promise<void> {
    this.held.set(heldKey(intentionId, step.id), { intentionId, stepId: step.id, requestId: view.requestId, actionHash: view.actionHash, owner, ...(resumeToken ? { resumeToken } : {}), ...(extra.worktreeCheckpoint ? { worktreeCheckpoint: extra.worktreeCheckpoint } : {}) });
    const before = this.intentions.get(intentionId)!;
    const i: Intention = { ...clearHold(this.setStep(intentionId, step.id, 'held', { status: 'held' })), heldRequestId: view.requestId, ...(resumeToken ? { resumeToken } : {}) };
    this.intentions.update(i);
    if (!hasHeldEvent) await this.emit('step.held', { requestId: view.requestId, owner, recovered: true, ...(extra.worktreeCheckpoint ? { worktreeCheckpoint: extra.worktreeCheckpoint } : {}) }, this.traceFor(intentionId, step.id));
    if (!hasHeldEvent || before.status !== 'held' || before.heldRequestId !== view.requestId) await this.emit('intention.held', { intention: i as unknown as Json, requestId: view.requestId, recovered: true }, this.traceFor(intentionId));
  }

  /** The suspension checkpoint recorded on the step.held of `requestId`, if any. */
  private heldInfo(k: string, requestId: string, scan: RunScan): { worktreeCheckpoint?: string } {
    const hs = (scan.heldEvents.get(k) ?? []).filter((h) => h.requestId === requestId);
    const worktreeCheckpoint = hs.find((h) => h.worktreeCheckpoint)?.worktreeCheckpoint;
    return { ...(worktreeCheckpoint ? { worktreeCheckpoint } : {}) };
  }

  /**
   * S7 expiry of a gate.commit hold: back to S3. The closest gate.verify upstream of the commit and every
   * step between them go back to pending; the verify re-freezes and must reproduce the D1 the expired request
   * was bound to (else a terminal 'human' failure: the tree changed while the approval waited); a review in
   * between reuses its recorded verdict for that D1 (no second reviewer call). Only then is a fresh
   * approval requested.
   */
  private async backToVerify(intentionId: string, plan: Plan, commit: Step, expectD1: string | undefined, requestId: string, notes: RecoveryNote[]): Promise<void> {
    const verify = closestUpstream(plan, commit, 'gate.verify');
    if (!verify) {
      await this.requeue(intentionId, commit, { expired: requestId });
      notes.push({ intentionId, stepId: commit.id, kind: commit.kind, action: 'expired', reason: `approval ${requestId} expired; no verify upstream, a new approval will be requested` });
      return;
    }
    const path = stepsBetween(plan, verify, commit);
    const cur = this.intentions.get(intentionId)!;
    const stepStatus = { ...cur.stepStatus };
    for (const id of path) {
      stepStatus[id] = 'pending';
      this.held.delete(heldKey(intentionId, id));
    }
    const i = clearHold({ ...cur, status: cur.status === 'held' || cur.status === 'committed' ? 'running' : cur.status, stepStatus });
    this.intentions.update(i);
    this.recovering.set(heldKey(intentionId, verify.id), expectD1 !== undefined ? { expectD1 } : {});
    for (const id of path) {
      const s = plan.steps.find((x) => x.id === id)!;
      const prior = this.reviewResults.get(heldKey(intentionId, id));
      if (s.kind === 'gate.review' && prior) this.recovering.set(heldKey(intentionId, id), { reuse: prior });
    }
    await this.emit('intention.advanced', { intention: i as unknown as Json, recovered: commit.id, expired: requestId, reverify: verify.id, rerun: path }, this.traceFor(intentionId));
    notes.push({ intentionId, stepId: commit.id, kind: commit.kind, action: 'expired', reason: `approval ${requestId} expired; back to ${verify.id} (re-freeze; must reproduce D1) before a fresh approval` });
  }

  /** resume() found its approval expired: record it and route the step back (live S7 expiry). */
  private async expireHold(h: Held, view: ApprovalView): Promise<void> {
    const plan = this.intentions.planOf(h.intentionId);
    const step = plan.steps.find((s) => s.id === h.stepId)!;
    await this.emit('approval.expired', { requestId: view.requestId }, this.traceFor(h.intentionId, h.stepId));
    // gate.pr: the committed sha is immutable, so a fresh approval is requested for the same commit.
    if (step.kind === 'gate.pr') await this.requeue(h.intentionId, step, { expired: view.requestId });
    else if (step.kind === 'gate.commit') await this.backToVerify(h.intentionId, plan, step, this.verifyFp.get(h.intentionId), view.requestId, []);
    else if (h.owner === 'worker') await this.restartWorker(h.intentionId, plan, step, `approval ${view.requestId} expired`, []);
    else await this.requeue(h.intentionId, step, { expired: view.requestId });
  }

  private latestRequestFor(k: string, scan: RunScan, afterSeq: number): { requestId: string; owner?: ApprovalOwner; hasHeldEvent: boolean } | null {
    let best: { requestId: string; owner?: ApprovalOwner; seq: number } | null = null;
    for (const [rid, r] of scan.requests) if (heldKey(r.intentionId, r.stepId) === k && r.seq > afterSeq && (!best || r.seq > best.seq)) best = { requestId: rid, seq: r.seq, ...(r.owner ? { owner: r.owner } : {}) };
    for (const h of scan.heldEvents.get(k) ?? []) if (h.seq > afterSeq && (!best || h.seq > best.seq)) best = { requestId: h.requestId, seq: h.seq, ...(h.owner ? { owner: h.owner } : {}) };
    if (!best) return null;
    const hasHeldEvent = (scan.heldEvents.get(k) ?? []).some((h) => h.requestId === best!.requestId);
    return { requestId: best.requestId, ...(best.owner ? { owner: best.owner } : {}), hasHeldEvent };
  }

  private ownerFor(step: Step, declared: ApprovalOwner | undefined, k: string, scan: RunScan): ApprovalOwner {
    if (declared) return declared;
    if (scan.tokens.has(k)) return 'worker';
    return step.kind === 'gate.pr' ? 'gate' : 'loop';
  }

  /** A step that was ready or held at the crash: re-hold, re-dispatch, or fail on its approval's state. */
  private async recoverWaiting(intentionId: string, plan: Plan, step: Step, scan: RunScan, notes: RecoveryNote[], notBefore = -1): Promise<void> {
    const k = heldKey(intentionId, step.id);
    const req = this.latestRequestFor(k, scan, Math.max(scan.startedSeq.get(k) ?? -1, notBefore));
    const note = (action: string, reason?: string) => notes.push({ intentionId, stepId: step.id, kind: step.kind, action, ...(reason ? { reason } : {}) });
    if (!req) {
      await this.requeue(intentionId, step, {});
      note('re-dispatch', 'no approval was requested');
      return;
    }
    const view = await requireApproval(this.p.ledger, req.requestId).catch(() => null);
    const owner = this.ownerFor(step, req.owner, k, scan);
    const token = owner === 'worker' ? scan.tokens.get(k) : undefined;
    if (!view) {
      await this.requeue(intentionId, step, { unknownApproval: req.requestId });
      note('re-dispatch', `approval ${req.requestId} unknown to the ledger`);
      return;
    }
    const expired = view.state === 'expired' || ((view.state === 'pending' || view.state === 'granted') && view.expiresAt <= this.now());
    if (expired) {
      await this.emit('approval.expired', { requestId: view.requestId, recovered: true }, this.traceFor(intentionId, step.id));
      if (owner === 'worker') await this.restartWorker(intentionId, plan, step, `approval ${view.requestId} expired`, notes);
      else if (step.kind === 'gate.pr') {
        // The committed sha does not change while the approval waits: request a fresh approval for it.
        await this.requeue(intentionId, step, { expired: view.requestId });
        note('expired', `approval ${view.requestId} expired; a new approval for the same commit will be requested`);
      } else if (step.kind === 'gate.commit') {
        // S7 expiry → back to S3: re-freeze and re-verify (must reproduce the bound D1) before a fresh request.
        const d1 = scan.requests.get(view.requestId)?.candidateD1;
        await this.backToVerify(intentionId, plan, step, typeof d1 === 'string' ? d1 : this.verifyFp.get(intentionId), view.requestId, notes);
      } else {
        await this.requeue(intentionId, step, { expired: view.requestId });
        note('expired', `approval ${view.requestId} expired; a new approval will be requested`);
      }
      return;
    }
    if (view.state === 'pending' || view.state === 'granted') {
      if (owner === 'worker' && !token) {
        await this.restartWorker(intentionId, plan, step, `worker hold ${view.requestId} has no resume token`, notes);
        return;
      }
      const info = owner === 'worker' ? this.heldInfo(k, view.requestId, scan) : {};
      await this.rehold(intentionId, step, view, owner, req.hasHeldEvent, token, info);
      if (info.worktreeCheckpoint) {
        // The suspended exec's state is the worktree at its suspension: nothing resumes until it is restored.
        await this.requireWorktree(intentionId, { checkpointId: info.worktreeCheckpoint, stepId: step.id, attempt: this.intentions.get(intentionId)!.attempt, reason: `held worker ${step.id} resumes from its suspension checkpoint`, reset: [] });
      }
      note('held', `approval ${view.requestId} is ${view.state}`);
      return;
    }
    if (view.state === 'denied') {
      await this.failStep(this.intentions.get(intentionId)!, plan, step, `approval ${view.requestId} denied`, { terminal: true, failure: 'policy' });
      note('failed', 'approval denied');
      return;
    }
    // consumed
    if (owner === 'loop') {
      if (!scan.consumedEv.has(view.requestId)) await this.emit('approval.consumed', { requestId: view.requestId, by: 'loop', recovered: true }, this.traceFor(intentionId, step.id));
      this.preApproved.set(k, { requestId: view.requestId, sessionId: view.sessionId, actionHash: view.actionHash });
      await this.requeue(intentionId, step, { approved: view.requestId });
      note('approved', `approval ${view.requestId} was consumed by the loop before the step started`);
      return;
    }
    if (step.kind === 'gate.pr') {
      await this.recoverPr(intentionId, plan, step, scan, notes, view);
      return;
    }
    await this.restartWorker(intentionId, plan, step, `approval ${view.requestId} consumed before the step ran`, notes);
  }

  /** A step that was running at the crash. */
  private async recoverRunning(intentionId: string, plan: Plan, step: Step, scan: RunScan, notes: RecoveryNote[]): Promise<void> {
    const k = heldKey(intentionId, step.id);
    const i = this.intentions.get(intentionId)!;
    // The gate's outcome was recorded but the step never closed: finish it with that outcome (never re-ask).
    const recorded = scan.gateResults.get(k);
    if (recorded && recorded.seq > (scan.startedSeq.get(k) ?? -1) && (step.kind === 'gate.verify' || step.kind === 'gate.review')) {
      const result = recordedResult(step.kind, recorded.payload);
      await this.onStepDone(intentionId, step, result);
      notes.push({ intentionId, stepId: step.id, kind: step.kind, action: 'completed', reason: `${recorded.kind} recorded before the restart` });
      return;
    }
    switch (step.kind) {
      case 'gate.verify': {
        await this.interruptedEvidence(i, step, 're-run');
        const sameAttempt = (this.attemptFps.get(intentionId) ?? []).filter((h) => h.attempt === i.attempt && typeof h.fingerprint === 'string');
        const expectD1 = sameAttempt.length ? (sameAttempt[sameAttempt.length - 1]!.fingerprint as string) : undefined;
        this.recovering.set(k, expectD1 !== undefined ? { expectD1 } : {});
        await this.requeue(intentionId, step, { interrupted: step.id });
        notes.push({ intentionId, stepId: step.id, kind: step.kind, action: 're-dispatch', reason: expectD1 ? 'verify interrupted; the re-run must reproduce D1' : 'verify interrupted' });
        return;
      }
      case 'gate.review': {
        // S5: the reviewer answer was lost. At most one reviewer call per (run, D1): reuse the gate's recorded
        // verdict for this D1 if it exists; else a retry only when review.maxAttempts allows another call
        // for this candidate; else stop for a human — never a silent second reviewer call.
        const d1 = this.verifyFp.get(intentionId);
        const reuse = d1 !== undefined ? await this.recordedReview(d1) : null;
        if (reuse) {
          await this.interruptedEvidence(i, step, 'reuse');
          this.recovering.set(k, { reuse });
          await this.requeue(intentionId, step, { interrupted: step.id, reuse: reuse.evidenceKey });
          notes.push({ intentionId, stepId: step.id, kind: step.kind, action: 're-dispatch', reason: `review interrupted; the recorded verdict for D1 ${d1} is reused (no reviewer call)` });
          return;
        }
        const asked = (scan.reviewStarts.get(k) ?? []).filter((x) => x === null || x === (d1 ?? null)).length;
        if (d1 !== undefined && asked < this.p.manifest.review.maxAttempts) {
          await this.interruptedEvidence(i, step, 're-dispatch');
          this.recovering.set(k, {});
          await this.requeue(intentionId, step, { interrupted: step.id });
          notes.push({ intentionId, stepId: step.id, kind: step.kind, action: 're-dispatch', reason: `review interrupted with no recorded verdict; review.maxAttempts ${this.p.manifest.review.maxAttempts} allows call ${asked + 1}` });
          return;
        }
        await this.interruptedEvidence(i, step, 'human');
        await this.failStep(i, plan, step, `review interrupted with no recorded verdict for D1 ${d1 ?? 'unknown'}; the reviewer is not asked again (${asked} of ${this.p.manifest.review.maxAttempts} review call(s) used): a human must decide`, { terminal: true, failure: 'human' });
        notes.push({ intentionId, stepId: step.id, kind: step.kind, action: 'failed', reason: 'review lost; human needed' });
        return;
      }
      case 'gate.commit':
        await this.recoverCommit(intentionId, plan, step, scan, notes);
        return;
      case 'gate.pr':
        await this.recoverPr(intentionId, plan, step, scan, notes);
        return;
      case 'worker': {
        // A resumed worker whose grant is still unspent and whose suspension was checkpointed: hold it again
        // with its token; the worktree must first go back to the suspension checkpoint (writes made after the
        // resume are discarded). Without that checkpoint the exec cannot be resumed safely: restart it.
        const req = this.latestRequestFor(k, scan, -1);
        const token = scan.tokens.get(k);
        if (req && token) {
          const view = await requireApproval(this.p.ledger, req.requestId).catch(() => null);
          const info = this.heldInfo(k, req.requestId, scan);
          if (view && view.state === 'granted' && view.expiresAt > this.now() && info.worktreeCheckpoint) {
            await this.interruptedEvidence(i, step, 'hold');
            await this.rehold(intentionId, step, view, 'worker', false, token, info);
            await this.requireWorktree(intentionId, { checkpointId: info.worktreeCheckpoint, stepId: step.id, attempt: i.attempt, reason: 'resumed worker interrupted; back to its suspension checkpoint', reset: [] });
            notes.push({ intentionId, stepId: step.id, kind: step.kind, action: 'held', reason: 'resumed worker interrupted before it spent its grant' });
            return;
          }
        }
        await this.interruptedEvidence(i, step, 'restart');
        await this.restartWorker(intentionId, plan, step, 'worker interrupted', notes);
        return;
      }
      case 'subgoal':
        await this.failStep(i, plan, step, 'interrupted subgoal step', { terminal: true, failure: 'human' });
        notes.push({ intentionId, stepId: step.id, kind: step.kind, action: 'failed' });
        return;
    }
  }

  /**
   * S8: never re-commit. Recorded → complete; else reconcile or a human. Commits take no approval (D6); a
   * loop-owned hold (a model gate) was consumed before the commit started, so nothing is re-held here.
   */
  private async recoverCommit(intentionId: string, plan: Plan, step: Step, scan: RunScan, notes: RecoveryNote[]): Promise<void> {
    const k = heldKey(intentionId, step.id);
    const started = scan.startedSeq.get(k) ?? -1;
    const recorded = scan.commits.get(k);
    const note = (action: string, reason?: string) => notes.push({ intentionId, stepId: step.id, kind: step.kind, action, ...(reason ? { reason } : {}) });
    if (recorded && recorded.seq > started) {
      await this.completeStep(intentionId, plan, step, { kind: 'gate.commit', exitCode: 0, evidenceKey: '', reason: 'recorded before the restart' });
      note('completed', `commit ${recorded.sha} already recorded`);
      return;
    }
    const i = this.intentions.get(intentionId)!;
    await this.interruptedEvidence(i, step, 'reconcile');
    if (typeof this.p.gates.reconcile !== 'function') {
      await this.failStep(i, plan, step, 'commit interrupted and the gate cannot reconcile; a human must check the branch', { terminal: true, failure: 'human' });
      note('failed', 'no reconcile port');
      return;
    }
    const ctx = this.gateContext(i, plan, step, new AbortController().signal, undefined, true);
    let r: GateReconcileResult;
    try {
      r = reconcileVerdict(await this.p.gates.reconcile(ctx));
    } catch (err) {
      r = { recorded: false, reason: `reconcile failed: ${msgOf(err)}` };
    }
    if (!r.recorded || typeof r.sha !== 'string' || !r.sha) {
      await this.failStep(this.intentions.get(intentionId)!, plan, step, `commit interrupted: ${r.reason ?? 'reconcile could not prove the commit'}`, { terminal: true, failure: 'human' });
      note('failed', r.reason ?? 'not reconciled');
      return;
    }
    const trace = this.traceFor(intentionId, step.id);
    const d1 = this.verifyFp.get(intentionId);
    await this.recordCommit(r.sha, { evidenceKey: r.evidenceKey ?? null, valid: true, reconciled: true, d1: d1 ?? null }, trace);
    this.committed.set(intentionId, { sha: r.sha, ...(d1 !== undefined ? { d1 } : {}), ...(r.evidenceKey ? { evidenceKey: r.evidenceKey } : {}) });
    await this.completeStep(intentionId, plan, step, { kind: 'gate.commit', exitCode: 0, evidenceKey: r.evidenceKey ?? '', reason: 'reconciled' });
    note('reconciled', `commit ${r.sha}`);
  }

  /**
   * A gate.pr that was running (or whose grant was consumed) at the crash. Recorded pr.opened / pr.requested
   * → complete; an unspent grant → held again; a spent grant without a recorded outcome → a terminal 'human'
   * failure (never a second push / PR without a person checking the remote first).
   */
  private async recoverPr(intentionId: string, plan: Plan, step: Step, scan: RunScan, notes: RecoveryNote[], known?: ApprovalView): Promise<void> {
    const k = heldKey(intentionId, step.id);
    const started = scan.startedSeq.get(k) ?? -1;
    const note = (action: string, reason?: string) => notes.push({ intentionId, stepId: step.id, kind: step.kind, action, ...(reason ? { reason } : {}) });
    const pr = scan.prs.get(k);
    if (pr && pr.seq > started) {
      await this.completeStep(intentionId, plan, step, { kind: 'gate.pr', exitCode: 0, evidenceKey: pr.evidenceKey, reason: 'recorded before the restart' });
      note('completed', `PR for ${pr.sha} already recorded`);
      return;
    }
    const req = this.latestRequestFor(k, scan, -1);
    const view = known ?? (req ? await requireApproval(this.p.ledger, req.requestId).catch(() => null) : null);
    const i = this.intentions.get(intentionId)!;
    if (view && view.state === 'granted' && view.expiresAt > this.now()) {
      await this.interruptedEvidence(i, step, 'hold');
      await this.rehold(intentionId, step, view, 'gate', false);
      note('held', `PR interrupted before its grant ${view.requestId} was spent`);
      return;
    }
    await this.interruptedEvidence(i, step, 'human');
    const sha = this.committed.get(intentionId)?.sha ?? 'unknown';
    await this.failStep(i, plan, step, `PR step interrupted after its approval was spent and before its outcome was recorded: check the remote and open PRs for ${sha} before running it again`, { terminal: true, failure: 'human' });
    note('failed', 'PR outcome lost; human needed');
  }

  /** A step.failed recorded after the last snapshot: finish the failure decision that was cut off. */
  private async recoverFailed(intentionId: string, plan: Plan, step: Step, scan: RunScan, notes: RecoveryNote[]): Promise<void> {
    const p = scan.failedPayload.get(heldKey(intentionId, step.id)) ?? {};
    const reason = typeof p.reason === 'string' ? p.reason : 'step failed before the restart';
    const failure = p.failure === 'budget' || p.failure === 'human' || p.failure === 'policy' ? p.failure : undefined;
    await this.failStep(this.intentions.get(intentionId)!, plan, step, reason, { terminal: p.terminal === true, blocked: p.blocked === true, ...(failure ? { failure } : {}), recorded: true });
    notes.push({ intentionId, stepId: step.id, kind: step.kind, action: 'failed', reason });
  }

  private async recoverPastDeadline(intentionId: string, plan: Plan, notes: RecoveryNote[]): Promise<void> {
    const i = this.intentions.get(intentionId)!;
    const running = plan.steps.filter((s) => i.stepStatus[s.id] === 'running');
    for (const s of running) await this.interruptedEvidence(i, s, 'deadline');
    const step = running[0] ?? plan.steps.find((s) => i.stepStatus[s.id] !== 'done') ?? plan.steps[0]!;
    await this.failStep(this.intentions.get(intentionId)!, plan, step, 'budget: run deadline exceeded', { terminal: true, failure: 'budget' });
    notes.push({ intentionId, stepId: step.id, kind: step.kind, action: 'failed', reason: 'run deadline exceeded' });
  }

  private recordAttemptFp(intentionId: string, attempt: number, fingerprint: string | null, exec?: number): AttemptFingerprint[] {
    const list = this.attemptFps.get(intentionId) ?? [];
    list.push({ attempt, fingerprint, ...(exec !== undefined ? { exec } : {}) });
    this.attemptFps.set(intentionId, list);
    return list;
  }

  // ---------- the cycle ----------

  private async onEvent(e: TeceraEvent): Promise<void> {
    this.beliefs.apply(e);
    if (e.kind === 'goal.adopted') {
      const goal = this.goals.get(e.trace.goalId!);
      if (goal) await this.deliberate(goal, e);
      return;
    }
    if (e.kind === 'belief.added' || e.kind === 'belief.removed' || e.kind === 'goal.dropped') {
      await this.triageAndReconsider(e);
    }
  }

  /** Library plans are re-validated against the goal before use; invalid ones are rejected, never run. */
  private async validOptions(goal: AchievementGoal, matched: Plan[]): Promise<Plan[]> {
    const ok: Plan[] = [];
    for (const plan of matched) {
      const errors = this.validate(plan, goal);
      if (errors.length) {
        await this.emit('plan.rejected', { plan: plan as unknown as Json, errors, reused: true }, { goalId: goal.id, planId: plan.id });
        continue;
      }
      ok.push(plan);
    }
    return ok;
  }

  private validate(plan: Plan, goal: AchievementGoal): string[] {
    try {
      return [...validatePlanShape(plan), ...this.p.validator.validatePlan(plan, this.p.manifest, goal)];
    } catch (err) {
      return [`plan validation failed: ${msgOf(err)}`];
    }
  }

  /**
   * Seat accounting for one LLM call the loop triggers (planner.write, planner.deliberate, model reflex
   * seams), through contracts meteredCall: reserve 'calls', 'usd' and 'tokens' before the call, settle after
   * it at the usage recorded on the meter (malformed/unknown usage or none at all → the reservation). The
   * meter's signal aborts on the run deadline and when the loop stops (lease loss): the loop stops waiting
   * and charges the reservation. A refused reservation or a passed deadline is BudgetExhausted; any other
   * accounting failure (reserve or settle threw) is AccountingBroken: the run terminates ('ledger').
   */
  private async metered<T>(purpose: string, call: (meter: UsageMeter) => Promise<T>): Promise<T> {
    if (this.stopped) throw new LoopStopped(this.stopped.reason);
    if (await this.deadlineStops()) throw new BudgetExhausted('run deadline exceeded');
    const est = this.p.llmReservation ?? DEFAULT_LLM_RESERVATION;
    const n = ++this.llmCalls;
    const ac = new AbortController();
    this.llmInFlight.add(ac);
    const remaining = this.deadline - this.now();
    // The deadline cancels the call only when budgets are enforced (D3).
    const timer = this.budgetsEnforced && remaining > 0 && remaining < 2 ** 31 - 1 ? setTimeout(() => ac.abort(new BudgetExhausted('run deadline exceeded')), remaining) : undefined;
    timer?.unref?.();
    try {
      return await meteredCall(
        this.p.ledger,
        {
          runId: this.p.runId,
          idemKey: `loop:${purpose}:${this.p.runId}:${this.nonce}:${n}`,
          reservation: { usd: est.usd, tokens: est.tokens, calls: est.calls ?? 1 },
          signal: ac.signal,
          purpose,
          onExhausted: (x) => this.noteBudgetExhausted(x.pool, { used: x.used, cap: x.cap, amount: x.amount, purpose: x.purpose }).catch(() => undefined),
        },
        call,
      );
    } catch (err) {
      if (err instanceof AccountingFailure) {
        if (err.code === 'budget') throw new BudgetExhausted(err.message);
        throw new AccountingBroken(err.message);
      }
      const st = this.stopped as { reason: string } | null;
      if (st) throw new LoopStopped(st.reason);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      this.llmInFlight.delete(ac);
    }
  }

  /**
   * An accounting failure that is not a budget refusal ends the run: the goal (or step) fails with
   * failure 'ledger' when the ledger still takes events, and the loop stops either way.
   */
  private async terminateAccounting(reason: string, at: { goal?: AchievementGoal; intention?: Intention; plan?: Plan; step?: Step }): Promise<void> {
    try {
      if (at.intention && at.plan && at.step) await this.failStep(at.intention, at.plan, at.step, `accounting: ${reason}`, { terminal: true, failure: 'ledger' });
      else if (at.goal) await this.dropGoal(at.goal, `accounting: ${reason}`, undefined, { terminal: true, failure: 'ledger' });
    } catch {
      // the ledger is failing: stopping is all that is left
    }
    this.stop(`accounting failure: ${reason}`, 'ledger');
  }

  private async deliberate(goal: AchievementGoal, e: TeceraEvent): Promise<void> {
    try {
      let options = await this.validOptions(goal, await this.p.library.match(e, this.beliefs));
      if (options.length === 0) {
        let plan: Plan;
        try {
          plan = await this.metered('planner.write', (meter) => this.p.planner.write(e, this.beliefs, goal, meter));
        } catch (err) {
          if (err instanceof LoopStopped || this.stopped) throw err;
          if (isBudgetError(err)) {
            // Budget exhaustion is a budget failure (exit 7), never a plan rejection.
            await this.dropGoal(goal, `budget: ${msgOf(err)}`, undefined, { terminal: true, failure: 'budget' });
            return;
          }
          if (isAccountingBroken(err)) {
            // The planner's (or the loop's) accounting failed: the run ends, never a plan rejection.
            await this.terminateAccounting(msgOf(err), { goal });
            return;
          }
          const rejected = (err as { plan?: unknown } | null)?.plan;
          const rid = rejected && typeof rejected === 'object' && typeof (rejected as { id?: unknown }).id === 'string' ? (rejected as { id: string }).id : '';
          const errors = errorsOf(err);
          await this.emit('plan.rejected', { plan: (rejected ?? null) as Json, errors, source: 'planner' }, { goalId: goal.id, planId: rid || `p_unparsed_${goal.id}` });
          await this.dropGoal(goal, 'generated plan rejected', errors);
          return;
        }
        const planId = plan && typeof plan === 'object' && typeof plan.id === 'string' && plan.id ? plan.id : `p_invalid_${goal.id}`;
        const errors = this.validate(plan, goal);
        if (errors.length) {
          await this.emit('plan.rejected', { plan: plan as unknown as Json, errors }, { goalId: goal.id, planId });
          await this.dropGoal(goal, 'generated plan rejected', errors);
          return;
        }
        const candidate: Plan = { ...plan, origin: 'generated', status: 'candidate' };
        await this.p.library.stage(candidate);
        await this.emit('plan.generated', { plan: candidate as unknown as Json }, { goalId: goal.id, planId: candidate.id });
        await this.emit('plan.staged', { planId: candidate.id }, { planId: candidate.id });
        options = [candidate];
      }
      const pick = await this.ask('choosePlan', {
        state: { goalId: goal.id, scores: Object.fromEntries(options.map((o) => [o.id, o.status === 'accepted' ? 2 : 1])) },
        options: options.map((o) => ({ planId: o.id, label: o.goalKinds.join(',') })),
      });
      let chosen = options.find((o) => o.id === pick.answer.planId) ?? options[0]!;
      if (pick.abstained) {
        let d: Plan | undefined;
        try {
          d = await this.metered('planner.deliberate', (meter) => this.p.planner.deliberate(options, this.intentions.active(), this.beliefs, meter));
        } catch (err) {
          if (err instanceof LoopStopped || this.stopped) throw err;
          if (isBudgetError(err)) {
            await this.dropGoal(goal, `budget: ${msgOf(err)}`, undefined, { terminal: true, failure: 'budget' });
            return;
          }
          if (isAccountingBroken(err)) {
            await this.terminateAccounting(msgOf(err), { goal });
            return;
          }
          throw err;
        }
        // Deliberation may only pick among validated options.
        chosen = options.find((o) => o.id === d?.id) ?? chosen;
      }
      const intention = newIntention({ id: this.ids(), goalId: goal.id, plan: chosen, commitment: goal.commitment });
      this.intentions.add(intention, chosen);
      await this.emit('intention.pushed', { intention: intention as unknown as Json }, this.traceFor(intention.id));
    } catch (err) {
      if (err instanceof LoopStopped || this.stopped) throw err;
      if (isBudgetError(err)) await this.dropGoal(goal, `budget: ${msgOf(err)}`, undefined, { terminal: true, failure: 'budget' });
      else if (isAccountingBroken(err)) await this.terminateAccounting(msgOf(err), { goal });
      else await this.dropGoal(goal, `deliberation failed: ${msgOf(err)}`);
    }
  }

  private async dropGoal(goal: AchievementGoal, reason: string, errors?: string[], opts: { terminal?: boolean; failure?: TerminalFailure } = {}): Promise<void> {
    const cur = this.goals.get(goal.id) ?? goal;
    if (cur.status !== 'open' && cur.status !== 'demoted') return;
    const dropped = transitionGoal(cur, 'dropped');
    this.goals.set(goal.id, dropped);
    await this.emit('goal.dropped', { goal: dropped as unknown as Json, reason, ...(errors ? { errors } : {}), ...(opts.terminal ? { terminal: true } : {}), ...(opts.failure ? { failure: opts.failure } : {}) }, { goalId: goal.id });
  }

  private async triageAndReconsider(e: TeceraEvent): Promise<void> {
    const active = this.intentions.active();
    if (active.length === 0) return;
    const triage = await this.ask('triage', {
      state: { eventKind: e.kind, trace: e.trace as unknown as Json },
      options: [...active.map((i) => ({ intentionId: i.id, label: i.planId })), { intentionId: null, label: 'new' }],
    });
    const targets = triage.answer.intentionId ? active.filter((i) => i.id === triage.answer.intentionId) : active;
    for (const i of targets) {
      const plan = this.intentions.planOf(i.id);
      const key = (e.payload as { key?: string }).key;
      const invalidatesContext = e.kind.startsWith('belief.') && !!key && plan.context.some((c) => c.key === key) && !plan.context.every((c) => this.beliefs.match(c));
      const goalChanged = e.kind === 'goal.dropped' && e.trace.goalId === i.goalId;
      const r = await this.ask('reconsider', { state: { commitment: i.commitment, eventKind: e.kind, invalidatesContext, goalChanged } });
      if (r.answer.interrupt) await this.interrupt(i, e);
    }
  }

  private async interrupt(stale: Intention, cause: TeceraEvent): Promise<void> {
    // Always transition the latest state: steps may have advanced while the reflex was consulted.
    const i = this.intentions.get(stale.id)!;
    if (i.status === 'done' || i.status === 'dropped' || i.status === 'failed') return;
    for (const [stepId, ac] of this.running) if (stepId.startsWith(`${i.id}:`)) ac.abort();
    for (const k of [...this.held.keys()]) if (k.startsWith(`${i.id}:`)) this.held.delete(k);
    const dropped = clearHold(transitionIntention(i, 'dropped'));
    this.intentions.update(dropped);
    await this.emit('intention.dropped', { intention: dropped as unknown as Json, cause: cause.kind }, this.traceFor(i.id));
    const goal = this.goals.get(i.goalId);
    if (goal && goal.status === 'open') {
      // Re-deliberate: the goal still stands, the plan did not.
      const adopted = await this.lastEvent('goal.adopted', goal.id);
      if (adopted) await this.deliberate(goal, adopted);
    }
  }

  /**
   * Risk the gate reflex sees: a worker step is a write unless every tool it may use is read-only; a commit
   * to the work branch is a write (D6); the PR (push + PR) is irreversible.
   */
  private riskOf(plan: Plan, step: Step): 'read' | 'write' | 'irreversible' {
    if (step.kind === 'gate.pr') return 'irreversible';
    if (step.kind === 'gate.commit') return 'write';
    if (step.kind !== 'worker') return 'read';
    return isWritingStep(plan, step) ? 'write' : 'read';
  }

  /** gate.pr preconditions (D6): a recorded commit, and a review.passed for exactly the committed candidate. */
  private prProblem(intentionId: string): string | null {
    const c = this.committed.get(intentionId);
    if (!c) return 'no commit was recorded on the work branch before the PR';
    if (!c.d1) return `the commit ${c.sha} names no reviewed candidate (D1)`;
    if (!this.reviewedD1.get(intentionId)?.has(c.d1)) return `no review.passed for the committed candidate ${c.d1}`;
    return null;
  }

  private noteReviewed(intentionId: string, d1: string): void {
    const set = this.reviewedD1.get(intentionId) ?? new Set<string>();
    set.add(d1);
    this.reviewedD1.set(intentionId, set);
  }

  private async dispatch(intentionId: string, stepId: string): Promise<void> {
    let i = this.intentions.get(intentionId)!;
    const plan = this.intentions.planOf(intentionId);
    const step = plan.steps.find((s) => s.id === stepId)!;
    try {
      if (this.leaseLost()) return;
      if (this.awaitingWorktree.has(intentionId)) return; // S2: nothing runs until the worktree is restored
      i = transitionStep(i, stepId, 'ready');
      if (i.status === 'committed') i = transitionIntention(i, 'running');
      this.intentions.update(i);
      if (await this.deadlineStops()) {
        await this.failStep(i, plan, step, 'budget: run deadline exceeded', { terminal: true, failure: 'budget' });
        return;
      }
      if (step.kind === 'gate.pr') {
        const problem = this.prProblem(intentionId);
        if (problem) {
          await this.failStep(i, plan, step, `gate.pr refused: ${problem}`, { terminal: true, failure: 'policy' });
          return;
        }
      }
      const pre = this.preApproved.get(heldKey(intentionId, stepId));
      if (pre) {
        this.preApproved.delete(heldKey(intentionId, stepId));
        await this.execute(intentionId, step, { kind: 'approved', approval: pre });
        return;
      }

      const gate = await this.ask('gate', {
        state: {
          tool: step.kind,
          risk: this.riskOf(plan, step),
          // D6: the PR is the approval point; commits to the work branch and work-branch writes are 'always'.
          permission: step.kind === 'gate.pr' ? 'requiresApproval' : 'always',
          isolationDegraded: this.isolationDegraded,
        },
        options: [{ decision: 'allow' }, { decision: 'hold' }, { decision: 'block' }],
      });
      if (gate.answer.decision === 'block') {
        await this.failStep(i, plan, step, 'blocked by gate', { blocked: true });
        return;
      }
      // The PR always waits for a human, whatever the reflex answered.
      if (gate.answer.decision === 'hold' || step.kind === 'gate.pr') {
        await this.hold(i, step);
        return;
      }
      await this.execute(intentionId, step, { kind: 'fresh' });
    } catch (err) {
      if (err instanceof LoopStopped || this.stopped) return;
      if (isAccountingBroken(err)) {
        await this.terminateAccounting(msgOf(err), { intention: this.intentions.get(intentionId)!, plan, step });
        return;
      }
      const budget = isBudgetError(err);
      await this.failStep(this.intentions.get(intentionId)!, plan, step, budget ? `budget: ${msgOf(err)}` : `dispatch failed: ${msgOf(err)}`, { terminal: true, ...(budget ? { failure: 'budget' as const } : {}) }).catch(() => undefined);
    }
  }

  /** Loop-level hold: request an approval bound to this exact action and park the step. */
  private async hold(stale: Intention, step: Step): Promise<void> {
    let i = this.intentions.get(stale.id)!;
    const requestId = `ap_${this.ids()}`;
    // gate.pr: the PR gate consumes the grant, bound to the committed sha (D6). Anything else the loop holds
    // (a model gate holding a commit, a requiresApproval action) is loop-owned.
    const pr = step.kind === 'gate.pr' ? this.committed.get(i.id) : undefined;
    if (step.kind === 'gate.pr' && !pr) throw new Error('gate.pr hold without a recorded commit');
    const owner: ApprovalOwner = pr ? 'gate' : 'loop';
    const candidateD1 = pr ? pr.sha : (this.verifyFp.get(i.id) ?? null);
    const actionHash = pr ? prActionHash({ intentionId: i.id, stepId: step.id, attempt: i.attempt, sha: pr.sha }) : digest({ intentionId: i.id, stepId: step.id, kind: step.kind, attempt: i.attempt });
    try {
      await this.p.ledger.requestApproval({
        requestId,
        runId: this.p.runId,
        sessionId: this.sessionId,
        actionHash,
        requester: { kind: 'agent', id: 'loop' },
        reason: pr ? `gate.pr ${step.id}: push the work branch and open a PR for commit ${pr.sha}` : `${step.kind} ${step.id}`,
        expiresAt: this.now() + this.p.manifest.policy.approvals.ttlSec * 1000,
      });
    } catch (err) {
      this.stop(`ledger refused approval request ${requestId}: ${msgOf(err)}`);
      throw new LoopStopped(this.stopped!.reason);
    }
    this.held.set(heldKey(i.id, step.id), { intentionId: i.id, stepId: step.id, requestId, actionHash, owner });
    i = transitionStep(i, step.id, 'held');
    i = transitionIntention(i, 'held');
    i = { ...clearHold(i), heldRequestId: requestId };
    this.intentions.update(i);
    await this.emit('approval.requested', { requestId, actionHash, step: step.id, sessionId: this.sessionId, owner, candidateD1, attempt: i.attempt, isolationDegraded: this.isolationDegraded, ...(pr ? { sha: pr.sha, reviewedD1: pr.d1 ?? null } : {}) }, this.traceFor(i.id, step.id));
    await this.emit('step.held', { requestId, owner }, this.traceFor(i.id, step.id));
    await this.emit('intention.held', { intention: i as unknown as Json, requestId }, this.traceFor(i.id));
  }

  /**
   * The live mutation-time fence for one step execution (contracts WriteGuard). check() re-evaluates at
   * every call: the loop stopped, the lease signal aborted, the fencing token changed or disappeared, the
   * step was cancelled (its signal: deadline, intention dropped, loop stop), the intention is no longer
   * active or the step no longer running → FenceLost. authorizeWrite(w): after the fence check every write
   * is 'allowed' under any isolation (D6: no per-write approvals; allowedChanges, protected paths, tamper
   * rules and this fence confine writes; the PR is the approval point).
   */
  private writeGuard(intentionId: string, stepId: string, signal: AbortSignal): FencedWriteGuard {
    return new FencedWriteGuard({
      signal,
      live: () => {
        if (this.stopped) return `loop stopped: ${this.stopped.reason}`;
        if (this.p.leaseSignal?.aborted) return 'lease lost';
        const lease = this.leaseProblem();
        if (lease) {
          this.stop(lease);
          return lease;
        }
        const i = this.intentions.get(intentionId);
        if (!i || !this.isActive(i)) return `intention ${intentionId} is ${i?.status ?? 'unknown'}`;
        if (i.stepStatus[stepId] !== 'running') return `step ${stepId} is ${i.stepStatus[stepId] ?? 'unknown'}, not running`;
        if (this.awaitingWorktree.has(intentionId)) return `intention ${intentionId} waits for a worktree restore`;
        return null;
      },
      authorizeWrite: (): WriteAuthorization => ({ kind: 'allowed' }),
    });
  }

  private gateContext(i: Intention, plan: Plan, step: Step, signal: AbortSignal, approval: GateApproval | undefined, recovered: boolean): GateContext {
    const goal = this.goals.get(i.goalId)!;
    const candidate: { d1?: string; d2?: string } = {};
    const d1 = this.verifyFp.get(i.id);
    const d2 = this.reviewFp.get(i.id);
    if (d1 !== undefined) candidate.d1 = d1;
    if (d2 !== undefined) candidate.d2 = d2;
    return {
      runId: this.p.runId,
      goal,
      plan,
      intention: i,
      step,
      worktree: this.p.worktree ?? '',
      candidate,
      signal,
      ...(approval && step.kind === 'gate.pr' ? { approval } : {}),
      ...(step.kind === 'gate.pr' && this.committed.get(i.id) ? { commit: { ...this.committed.get(i.id)! } } : {}),
      ...(recovered ? { recovered: true } : {}),
    };
  }

  private async execute(intentionId: string, step: Step, mode: ExecMode): Promise<void> {
    if (this.leaseLost()) return; // no mutation without the lease (resume and pre-approved paths included)
    let i = this.intentions.get(intentionId)!;
    const plan = this.intentions.planOf(intentionId);
    let seatId = 'host';
    if (step.kind === 'worker' && mode.kind !== 'resume-worker') {
      const allowed = plan.allowedModels[step.id]?.length ? this.p.seats.filter((s) => plan.allowedModels[step.id]!.includes(s.seatId)) : this.p.seats;
      const route = await this.ask('route', { state: { stepId: step.id }, options: allowed });
      seatId = route.answer.seatId;
    }
    i = transitionStep(i, step.id, 'running');
    this.intentions.update(i);
    const resumed = mode.kind !== 'fresh';
    const k = heldKey(intentionId, step.id);
    const recovery = this.recovering.get(k);
    this.recovering.delete(k);
    await this.emit('step.requested', { step: step.id, kind: step.kind, seatId, resumed, ...(recovery ? { recovered: true } : {}) }, this.traceFor(intentionId, step.id));
    await this.emit('step.started', { step: step.id }, this.traceFor(intentionId, step.id));

    const ac = new AbortController();
    this.running.set(k, ac);
    // An enforced run deadline cancels the step in flight (gates and workers must stop their processes on
    // abort). Unenforced (D3): the deadline is reported, never a cancellation; per-exec timeouts still apply.
    const remaining = this.deadline - this.now();
    const enforced = this.budgetsEnforced;
    const timer = enforced && remaining > 0 && remaining < 2 ** 31 - 1 ? setTimeout(() => ac.abort(new BudgetExhausted('run deadline exceeded')), remaining) : undefined;
    timer?.unref?.();
    if (enforced && remaining <= 0) ac.abort(new BudgetExhausted('run deadline exceeded'));
    const guard = this.writeGuard(intentionId, step.id, ac.signal);
    const ctx: GateContext = { ...this.gateContext(i, plan, step, ac.signal, mode.kind === 'approved' ? mode.approval : undefined, recovery !== undefined), guard };
    try {
      let result = await this.runStep(ctx, seatId, ac.signal, mode, recovery);
      const delivered = (result.kind === 'gate.commit' || result.kind === 'gate.pr') && result.exitCode === 0 && !result.terminal;
      // Past an enforced deadline the result is not progress (a commit or PR that already happened stands).
      if (!delivered && (await this.deadlineStops())) result = { ...result, terminal: true, reason: 'budget: run deadline exceeded', failure: 'budget' };
      await this.onStepDone(intentionId, step, result);
    } catch (err) {
      if (err instanceof LoopStopped || this.stopped) return;
      if (isAccountingBroken(err)) await this.terminateAccounting(msgOf(err), { intention: this.intentions.get(intentionId)!, plan, step });
      else if (this.budgetsEnforced && this.deadlinePassed()) await this.failStep(this.intentions.get(intentionId)!, plan, step, `budget: run deadline exceeded (${msgOf(err)})`, { terminal: true, failure: 'budget' });
      else if (isBudgetError(err)) await this.failStep(this.intentions.get(intentionId)!, plan, step, `budget: ${msgOf(err)}`, { terminal: true, failure: 'budget' });
      else await this.failStep(this.intentions.get(intentionId)!, plan, step, msgOf(err), {});
    } finally {
      if (timer) clearTimeout(timer);
      this.running.delete(k);
    }
  }

  private async runStep(ctx: GateContext, seatId: string, signal: AbortSignal, mode: ExecMode, recovery?: Recovery): Promise<StepResult> {
    const trace = this.traceFor(ctx.intention.id, ctx.step.id);
    switch (ctx.step.kind) {
      case 'worker': {
        if (mode.kind === 'resume-worker') {
          const outcome = await this.p.worker.resume(mode.resumeToken, mode.grant, signal, ctx.guard);
          const consumed = await this.noteConsumed(mode.requestId, 'worker', trace);
          // The worker owns the grant: finishing without spending it means the gated action ran unbound.
          if (!consumed && outcome.kind === 'returned') return { kind: 'worker', outcome, terminal: true, reason: `worker did not consume approval ${mode.requestId}` };
          return { kind: 'worker', outcome };
        }
        const assembled = assembleStepContext(ctx.goal, ctx.plan, ctx.step, this.beliefs, { budgetTokens: this.p.manifest.memory.contextBudgetTokens });
        const fencingToken = this.p.fencingToken?.();
        const outcome = await this.p.worker.run(
          {
            runId: this.p.runId,
            goal: ctx.goal,
            plan: ctx.plan,
            intention: ctx.intention,
            step: ctx.step,
            seatId,
            inputs: assembled.inputs,
            capabilities: capabilitiesFor(this.p.manifest, ctx.plan, ctx.step),
            worktree: ctx.worktree,
            ...(typeof fencingToken === 'number' ? { fencingToken } : {}),
            ...(ctx.guard ? { guard: ctx.guard } : {}),
          },
          signal,
        );
        return { kind: 'worker', outcome };
      }
      case 'gate.verify': {
        await this.emit('verify.started', { step: ctx.step.id, attempt: ctx.intention.attempt, ...(recovery ? { recovered: true } : {}) }, trace);
        const r = await this.p.gates.verify(ctx);
        const fingerprint = r.fingerprint ?? (await this.evidenceFingerprint(r.evidenceKey));
        if (fingerprint !== undefined) this.verifyFp.set(ctx.intention.id, fingerprint);
        else this.verifyFp.delete(ctx.intention.id);
        let terminal = isTerminal(r.terminal, r.exitCode);
        let reason = r.reason;
        let failure: TerminalFailure | undefined = terminal ? failureOf(r.failure) : undefined;
        // S4/S6/S7: a re-run after an interrupted verify (or an expired commit approval) must reproduce D1.
        if (recovery?.expectD1 !== undefined && fingerprint !== recovery.expectD1) {
          terminal = true;
          failure = 'human';
          reason = `digest drift: the re-run verify fingerprint ${fingerprint ?? 'none'} differs from D1 ${recovery.expectD1}`;
        }
        // progressCheck: the same candidate from another worker execution is no progress → stop for a human.
        // Two verifies of ONE execution (a recovered re-run, a second verify gate) are never compared (ADV-8).
        const exec = this.workerExecs.get(ctx.intention.id) ?? 0;
        const history = this.recordAttemptFp(ctx.intention.id, ctx.intention.attempt, fingerprint ?? null, exec);
        const noProgress = !terminal ? noProgressReason(history) : null;
        if (noProgress) {
          terminal = true;
          failure = 'human';
          reason = noProgress;
        }
        await this.emit(
          r.exitCode === 0 && !terminal ? 'verify.passed' : 'verify.failed',
          { exitCode: r.exitCode, evidenceKey: r.evidenceKey, fingerprint: fingerprint ?? null, attempt: ctx.intention.attempt, workerExec: exec, terminal, reason: reason ?? null, ...(failure ? { failure } : {}), ...(noProgress ? { noProgress: true } : {}) },
          trace,
        );
        return { kind: 'gate.verify', exitCode: r.exitCode, evidenceKey: r.evidenceKey, terminal, ...(reason ? { reason } : {}), ...(failure ? { failure } : {}) };
      }
      case 'gate.review': {
        const k = heldKey(ctx.intention.id, ctx.step.id);
        if (recovery?.reuse && recovery.reuse.kind === 'gate.review') {
          // At most one reviewer call per (run, D1): the recorded verdict for this candidate stands.
          const r = recovery.reuse;
          if (r.fingerprint !== undefined) this.reviewFp.set(ctx.intention.id, r.fingerprint);
          const terminal = r.terminal === true;
          const d1 = ctx.candidate?.d1;
          const passed = r.verdict === 'approve' && !terminal;
          // The reused verdict is the one recorded for this same D1 (recordedReview / backToVerify reproduce it).
          if (passed && d1 !== undefined) this.noteReviewed(ctx.intention.id, d1);
          await this.emit(passed ? 'review.passed' : 'review.rejected', { verdict: r.verdict, evidenceKey: r.evidenceKey, fingerprint: r.fingerprint ?? null, d1: d1 ?? null, terminal, reason: r.reason ?? null, reused: true, ...(r.failure ? { failure: r.failure } : {}) }, trace);
          this.reviewResults.set(k, r);
          return r;
        }
        const d1 = ctx.candidate?.d1;
        await this.emit('review.started', { step: ctx.step.id, d1: d1 ?? null, ...(recovery ? { recovered: true } : {}) }, trace);
        const r = await this.p.gates.review(ctx);
        if (r.fingerprint !== undefined) this.reviewFp.set(ctx.intention.id, r.fingerprint);
        else this.reviewFp.delete(ctx.intention.id);
        const terminal = r.terminal === true;
        const failure = terminal ? failureOf(r.failure) : undefined;
        const passed = r.verdict === 'approve' && !terminal;
        // The PR gate needs a review.passed for exactly the candidate it delivers (D6): the reviewed D1.
        if (passed && d1 !== undefined) this.noteReviewed(ctx.intention.id, d1);
        await this.emit(passed ? 'review.passed' : 'review.rejected', { verdict: r.verdict, evidenceKey: r.evidenceKey, fingerprint: r.fingerprint ?? null, d1: d1 ?? null, terminal, reason: r.reason ?? null, ...(failure ? { failure } : {}) }, trace);
        const result: StepResult = { kind: 'gate.review', verdict: r.verdict, evidenceKey: r.evidenceKey, terminal, ...(r.reason ? { reason: r.reason } : {}), ...(failure ? { failure } : {}), ...(r.fingerprint !== undefined ? { fingerprint: r.fingerprint } : {}) };
        this.reviewResults.set(k, result);
        return result;
      }
      case 'gate.commit': {
        // A commit to the work branch (D6: no approval). Re-check the lease right before handing it out.
        if (this.leaseLost()) throw new LoopStopped(this.stopped!.reason);
        const r = await this.p.gates.commit(ctx);
        let terminal = isTerminal(r.terminal, r.exitCode);
        let reason = r.reason;
        let failure = terminal ? failureOf(r.failure) : undefined;
        const sha = typeof r.sha === 'string' && r.sha ? r.sha : undefined;
        if (r.exitCode === 0 && !sha) {
          terminal = true;
          reason = 'the commit gate reported success without a commit sha';
          failure = 'policy';
        }
        const d1 = ctx.candidate?.d1;
        if (r.exitCode === 0) await this.recordCommit(sha ?? null, { evidenceKey: r.evidenceKey, valid: !terminal, d1: d1 ?? null }, trace);
        if (r.exitCode === 0 && !terminal && sha) this.committed.set(ctx.intention.id, { sha, ...(d1 !== undefined ? { d1 } : {}), ...(r.evidenceKey ? { evidenceKey: r.evidenceKey } : {}) });
        return { kind: 'gate.commit', exitCode: r.exitCode, evidenceKey: r.evidenceKey, terminal, ...(reason ? { reason } : {}), ...(failure ? { failure } : {}) };
      }
      case 'gate.pr':
        return this.runPr(ctx, trace);
      case 'subgoal':
        throw new Error('subgoal steps are not supported in Phase 1');
    }
  }

  /** commit.recorded is idempotent by (runId, sha): a second record of the same commit writes nothing. */
  private async recordCommit(sha: string | null, payload: JsonObject, trace: TeceraEvent['trace']): Promise<boolean> {
    const r = await this.emit('commit.recorded', { sha, ...payload }, trace, sha ? { idemKey: `commit.recorded:${this.p.runId}:${sha}`, allowDuplicate: true } : {});
    return !r.duplicate;
  }

  /** Emit approval.consumed when the owner actually consumed the grant. Returns whether it did. */
  private async noteConsumed(requestId: string, by: string, trace: TeceraEvent['trace']): Promise<boolean> {
    let state: string;
    try {
      state = (await requireApproval(this.p.ledger, requestId))?.state ?? 'unknown';
    } catch {
      state = 'unknown';
    }
    if (state !== 'consumed') return false;
    await this.emit('approval.consumed', { requestId, by }, trace);
    return true;
  }

  private async evidenceFingerprint(key: string): Promise<string | undefined> {
    try {
      const rec = await this.p.ledger.getEvidence(key);
      const fp = rec && rec.body && typeof rec.body === 'object' && !Array.isArray(rec.body) ? (rec.body as JsonObject).fingerprint : undefined;
      return typeof fp === 'string' && fp ? fp : undefined;
    } catch {
      return undefined;
    }
  }

  private async onStepDone(intentionId: string, step: Step, result: StepResult): Promise<void> {
    let i = this.intentions.get(intentionId)!;
    const plan = this.intentions.planOf(intentionId);
    if (!this.isActive(i)) {
      // The intention was dropped or finished while this step ran: its result is evidence, not progress.
      await this.emit('step.cancelled', { step: step.id, reason: `intention ${i.status}`, result: summarize(result) }, this.traceFor(intentionId, step.id));
      return;
    }
    // facts → beliefs
    if (result.kind === 'worker' && result.outcome.kind === 'returned') {
      const facts = (result.outcome.value as { facts?: Array<{ key: string; value: Json }> } | null)?.facts ?? [];
      if (Array.isArray(facts)) for (const f of facts) if (f && typeof f.key === 'string') await this.emit('belief.added', { key: f.key, value: f.value ?? null, provenance: { src: `worker:${step.id}`, trust: 'untrusted' } }, this.traceFor(intentionId, step.id));
    }
    if (result.kind === 'worker' && result.outcome.kind === 'suspended' && !result.terminal) {
      // The worker hit an approval-gated tool: hold the step with the worker's request and resume token.
      const req = result.outcome.request;
      const resumeToken = result.outcome.resumeToken;
      const problem = await this.suspensionProblem(intentionId, step, req);
      if (problem) {
        await this.failStep(i, plan, step, problem, { terminal: true, failure: 'policy' });
        return;
      }
      let worktreeCheckpoint: string | undefined;
      if (this.p.worktreeCheckpoint) {
        try {
          worktreeCheckpoint = await this.p.worktreeCheckpoint({ runId: this.p.runId, intentionId, stepId: step.id, attempt: i.attempt, reason: 'suspended' });
        } catch (err) {
          await this.failStep(i, plan, step, `worktree checkpoint failed at the suspension of ${step.id}: ${msgOf(err)}`, { terminal: true, failure: 'human' });
          return;
        }
      }
      this.held.set(heldKey(intentionId, step.id), { intentionId, stepId: step.id, requestId: req.requestId, actionHash: req.actionHash, owner: 'worker', resumeToken, ...(worktreeCheckpoint ? { worktreeCheckpoint } : {}) });
      i = transitionStep(i, step.id, 'held');
      i = transitionIntention(i, 'held');
      i = { ...i, resumeToken, heldRequestId: req.requestId };
      this.intentions.update(i);
      await this.emit('step.held', { requestId: req.requestId, reason: req.reason, owner: 'worker', actionHash: req.actionHash, ...(worktreeCheckpoint ? { worktreeCheckpoint } : {}) }, this.traceFor(intentionId, step.id));
      await this.emit('intention.held', { intention: i as unknown as Json, requestId: req.requestId }, this.traceFor(intentionId));
      return;
    }
    if (result.terminal) {
      await this.failStep(i, plan, step, result.reason ?? describeFailure(result), { terminal: true, ...(result.failure ? { failure: result.failure } : {}) });
      return;
    }
    const closeOut = await this.ask('closeOut', { state: closeOutState(step, result) });
    if (!closeOut.answer.achieved) {
      await this.failStep(i, plan, step, describeFailure(result), {});
      return;
    }
    await this.completeStep(intentionId, plan, step, result);
  }

  /**
   * Why a worker suspension may not be held (null when it may): it must name its request id and action
   * hash, and it may not be a per-write approval (D6 removed them: writes inside allowedChanges need none,
   * so a suspension naming a write is a worker that does not honour the guard's 'allowed').
   */
  private async suspensionProblem(_intentionId: string, _step: Step, req: { requestId: string; actionHash: string; write?: unknown }): Promise<string | null> {
    if (typeof req.requestId !== 'string' || !req.requestId || typeof req.actionHash !== 'string' || !req.actionHash) return 'worker suspension without a request id or action hash';
    if (req.write !== undefined && req.write !== null) return `worker suspension ${req.requestId} asks approval for a write: per-write approvals were removed (D6); work-branch writes need none and the PR is the approval point`;
    return null;
  }

  /** Mark a step done, then advance the intention or close it (and settle its goal). */
  private async completeStep(intentionId: string, plan: Plan, step: Step, result: StepResult): Promise<void> {
    let i = this.intentions.get(intentionId)!;
    let worktreeCheckpoint: string | undefined;
    if (step.kind === 'worker' && result.kind === 'worker') {
      // A worker execution produced (or kept) the candidate: count it, and checkpoint the worktree after it.
      if (this.p.worktreeCheckpoint) {
        try {
          worktreeCheckpoint = await this.p.worktreeCheckpoint({ runId: this.p.runId, intentionId, stepId: step.id, attempt: i.attempt, reason: 'completed' });
        } catch (err) {
          await this.failStep(i, plan, step, `worktree checkpoint failed after ${step.id}: ${msgOf(err)}`, { terminal: true, failure: 'human' });
          return;
        }
        if (typeof worktreeCheckpoint !== 'string' || !worktreeCheckpoint) {
          await this.failStep(i, plan, step, `worktree checkpoint after ${step.id} returned no id`, { terminal: true, failure: 'human' });
          return;
        }
      }
      this.workerExecs.set(intentionId, (this.workerExecs.get(intentionId) ?? 0) + 1);
      const cp = this.cpState.get(intentionId) ?? { uncheckpointed: new Set<string>() };
      if (worktreeCheckpoint) {
        cp.checkpointId = worktreeCheckpoint;
        cp.uncheckpointed.clear();
      } else if (this.riskOf(plan, step) !== 'read') cp.uncheckpointed.add(step.id);
      this.cpState.set(intentionId, cp);
      i = this.intentions.get(intentionId)!;
      if (worktreeCheckpoint) i = { ...i, checkpointId: worktreeCheckpoint };
    }
    i = i.stepStatus[step.id] === 'running' ? transitionStep(i, step.id, 'done') : { ...i, stepStatus: { ...i.stepStatus, [step.id]: 'done' } };
    if (i.status === 'held' || i.status === 'committed') i = clearHold({ ...i, status: 'running' });
    this.intentions.update(i);
    await this.emit('step.completed', { step: step.id, result: summarize(result), ...(worktreeCheckpoint ? { worktreeCheckpoint } : {}) }, this.traceFor(intentionId, step.id));
    if (this.intentions.allStepsDone(i)) await this.closeIntention(intentionId, plan);
    else await this.emit('intention.advanced', { intention: i as unknown as Json, completed: step.id }, this.traceFor(intentionId));
  }

  private async closeIntention(intentionId: string, plan: Plan): Promise<void> {
    let i = this.intentions.get(intentionId)!;
    if (i.status === 'committed' || i.status === 'held') i = clearHold({ ...i, status: 'running' });
    i = transitionIntention(i, 'done');
    this.intentions.update(i);
    await this.emit('intention.done', { intention: i as unknown as Json }, this.traceFor(intentionId));
    await this.settleGoal(i, plan);
  }

  /**
   * A goal is achieved only on proof (D4): every gate.verify step of the plan passed last, the final
   * verify.passed has gate.verify evidence of this run that ran the goal's check command and exited 0 on the
   * candidate it names, the commit (when the plan has gate.commit) is recorded for that candidate and the PR
   * (when the plan has gate.pr) was opened or requested for that commit. goal.achieved carries the proof
   * {command, exitCode: 0, fingerprint, evidenceKey, verifiedAt}; anything missing keeps the goal open.
   */
  private async settleGoal(i: Intention, plan: Plan): Promise<void> {
    const goal = this.goals.get(i.goalId)!;
    if (goal.status !== 'open') return;
    const r = await this.achievementProof(i, plan, goal);
    if ('why' in r) {
      await this.emit('intention.advanced', { intention: i as unknown as Json, note: `goal stays open: ${r.why}` }, this.traceFor(i.id));
      return;
    }
    const achieved = transitionGoal(goal, 'achieved', [r.verifyEventId, r.proof.evidenceKey], r.proof);
    this.goals.set(goal.id, achieved);
    await this.emit('goal.achieved', { goal: achieved as unknown as Json, evidence: [r.verifyEventId, r.proof.evidenceKey], proof: r.proof as unknown as Json }, { goalId: goal.id });
  }

  private async achievementProof(i: Intention, plan: Plan, goal: AchievementGoal): Promise<{ proof: AchievementProof; verifyEventId: string } | { why: string }> {
    const verifies = plan.steps.filter((s) => s.kind === 'gate.verify');
    if (verifies.length === 0) return { why: 'the plan has no environmental check (gate.verify)' };
    const latest = new Map<string, TeceraEvent>();
    let last: TeceraEvent | undefined;
    const prs: TeceraEvent[] = [];
    for await (const e of this.p.ledger.events({ runId: this.p.runId, kinds: ['verify.passed', 'verify.failed', 'pr.opened', 'pr.requested'] })) {
      if (e.trace.intentionId !== i.id) continue;
      if (e.kind === 'pr.opened' || e.kind === 'pr.requested') prs.push(e);
      else {
        if (e.trace.stepId) latest.set(e.trace.stepId, e);
        last = e;
      }
    }
    for (const v of verifies) if (latest.get(v.id)?.kind !== 'verify.passed') return { why: `verify step ${v.id} did not pass last` };
    if (!last || last.kind !== 'verify.passed') return { why: 'the final verify did not pass' };
    const p = last.payload as JsonObject;
    const key = typeof p.evidenceKey === 'string' && p.evidenceKey ? p.evidenceKey : undefined;
    if (!key) return { why: 'the final verify.passed names no evidence' };
    let rec: Awaited<ReturnType<Ledger['getEvidence']>>;
    try {
      rec = await this.p.ledger.getEvidence(key);
    } catch (err) {
      return { why: `verify evidence ${key} cannot be read: ${msgOf(err)}` };
    }
    if (!rec) return { why: `verify evidence ${key} is missing` };
    if (rec.runId !== this.p.runId) return { why: `verify evidence ${key} belongs to another run` };
    if (rec.kind !== 'gate.verify') return { why: `verify evidence ${key} has kind ${rec.kind}, not gate.verify` };
    const b = (rec.body && typeof rec.body === 'object' && !Array.isArray(rec.body) ? rec.body : {}) as JsonObject;
    if (typeof b.commandDigest === 'string') {
      if (b.commandDigest !== verifyCommandDigest(goal.check.command)) return { why: `verify evidence ${key} ran another command than the goal check` };
    } else if (b.command !== goal.check.command) return { why: `verify evidence ${key} does not prove the goal check command ran` };
    if (b.exitCode !== 0) return { why: `verify evidence ${key} records exit ${JSON.stringify(b.exitCode ?? null)}` };
    if (b.outcome !== undefined && b.outcome !== 'passed') return { why: `verify evidence ${key} records outcome ${JSON.stringify(b.outcome)}` };
    const fingerprint = typeof b.fingerprint === 'string' && b.fingerprint ? b.fingerprint : undefined;
    if (!fingerprint) return { why: `verify evidence ${key} names no candidate fingerprint` };
    if (typeof p.fingerprint === 'string' && p.fingerprint !== fingerprint) return { why: `verify.passed fingerprint differs from its evidence ${key}` };
    const kinds = new Set(plan.steps.map((s) => s.kind));
    if (kinds.has('gate.commit')) {
      const c = this.committed.get(i.id);
      if (!c) return { why: 'no commit was recorded' };
      if (c.d1 !== undefined && c.d1 !== fingerprint) return { why: `the commit ${c.sha} is of candidate ${c.d1}, not the verified ${fingerprint}` };
      if (kinds.has('gate.pr') && !prs.some((e) => (e.payload as JsonObject).sha === c.sha)) return { why: `no pr.opened or pr.requested for commit ${c.sha}` };
    }
    const proof: AchievementProof = { command: goal.check.command, exitCode: 0, fingerprint, evidenceKey: key, verifiedAt: last.at };
    const problem = achievementProofProblem(proof, goal.check);
    if (problem) return { why: problem };
    return { proof, verifyEventId: last.id };
  }

  /**
   * gate.pr (D6): only with the human grant bound to the committed sha (the gate consumes it) and a
   * review.passed for the committed candidate. Records pr.opened (url) or pr.requested (no remote / no gh:
   * branch, base, bundle), else pr.failed. The returned sha must be the committed one. Never merges.
   */
  private async runPr(ctx: GateContext, trace: TeceraEvent['trace']): Promise<StepResult> {
    if (this.leaseLost()) throw new LoopStopped(this.stopped!.reason);
    const c = this.committed.get(ctx.intention.id);
    const fail = async (reason: string, failure: TerminalFailure, evidenceKey = '', exitCode = 8): Promise<StepResult> => {
      await this.emit('pr.failed', { step: ctx.step.id, sha: c?.sha ?? null, exitCode, evidenceKey, reason, failure }, trace);
      return { kind: 'gate.pr', exitCode, evidenceKey, terminal: true, reason, failure };
    };
    const problem = this.prProblem(ctx.intention.id);
    if (problem || !c) return fail(`gate.pr refused: ${problem ?? 'no commit'}`, 'policy');
    if (!ctx.approval) return fail('gate.pr refused: no human approval was handed to the PR gate', 'policy');
    if (ctx.approval.actionHash !== prActionHash({ intentionId: ctx.intention.id, stepId: ctx.step.id, attempt: ctx.intention.attempt, sha: c.sha })) return fail(`gate.pr refused: approval ${ctx.approval.requestId} is not bound to commit ${c.sha}`, 'policy');
    if (typeof (this.p.gates as Partial<GateRunner>).pr !== 'function') return fail('gate.pr: the gate runner cannot open PRs (no pr port); a human must deliver the branch', 'human', '', 9);
    const r: GatePrResult = await this.p.gates.pr(ctx);
    let terminal = isTerminal(r.terminal, r.exitCode);
    let reason = r.reason;
    let failure = terminal ? failureOf(r.failure) : undefined;
    if (r.exitCode === 0) {
      // The gate owns consumption; a PR that did not spend its grant is not a delivered PR.
      const consumed = await this.noteConsumed(ctx.approval.requestId, 'gate.pr', trace);
      if (!consumed) {
        terminal = true;
        reason = `PR gate did not consume approval ${ctx.approval.requestId}`;
        failure = 'policy';
      } else if (r.sha !== c.sha) {
        terminal = true;
        reason = `PR gate delivered ${String(r.sha)}, not the committed ${c.sha}`;
        failure = 'policy';
      }
    }
    if (r.exitCode === 0 && !terminal) {
      const payload: JsonObject = {
        step: ctx.step.id,
        sha: c.sha,
        evidenceKey: r.evidenceKey,
        approvalRequestId: ctx.approval.requestId,
        ...(r.branch ? { branch: r.branch } : {}),
        ...(r.base ? { base: r.base } : {}),
        ...(r.pushed !== undefined ? { pushed: r.pushed } : {}),
      };
      if (typeof r.url === 'string' && r.url) await this.emit('pr.opened', { ...payload, url: r.url }, trace);
      else await this.emit('pr.requested', { ...payload, ...(r.bundle ? { bundle: r.bundle } : {}) }, trace);
    } else {
      await this.emit('pr.failed', { step: ctx.step.id, sha: c.sha, exitCode: r.exitCode, evidenceKey: r.evidenceKey, reason: reason ?? null, approvalRequestId: ctx.approval.requestId, ...(failure ? { failure } : {}) }, trace);
    }
    return { kind: 'gate.pr', exitCode: r.exitCode, evidenceKey: r.evidenceKey, terminal, ...(reason ? { reason } : {}), ...(failure ? { failure } : {}) };
  }

  /**
   * Fail a step. `blocked` (gate reflex block) and `terminal` (gate terminal result, exit 8/9, unusable
   * approval, dispatch fault, no progress, budget) are never retried: the intention fails and the goal is
   * dropped. `failure` classifies a terminal end ('budget' | 'human' | 'policy') on every event it emits.
   * `recorded`: the step.failed event already exists (restore finishing a cut-off failure).
   */
  private async failStep(stale: Intention, plan: Plan, step: Step, reason: string, opts: { blocked?: boolean; terminal?: boolean; failure?: TerminalFailure; recorded?: boolean }): Promise<void> {
    let i = this.intentions.get(stale.id)!;
    const blocked = opts.blocked === true;
    const terminal = opts.terminal === true || opts.failure !== undefined;
    const failure: JsonObject = opts.failure ? { failure: opts.failure } : {};
    if (!this.isActive(i)) {
      if (!opts.recorded) await this.emit('step.cancelled', { step: step.id, reason: `intention ${i.status}: ${reason}` }, this.traceFor(i.id, step.id));
      return;
    }
    if (i.stepStatus[step.id] === 'running' || i.stepStatus[step.id] === 'held') i = transitionStep(i, step.id, 'failed');
    else i = { ...i, stepStatus: { ...i.stepStatus, [step.id]: 'failed' } };
    this.held.delete(heldKey(i.id, step.id));
    this.intentions.update(i);
    if (!opts.recorded) await this.emit('step.failed', { step: step.id, reason, blocked, terminal, ...failure }, this.traceFor(i.id, step.id));
    const canRetry = !blocked && !terminal && i.attempt < this.p.manifest.budgets.maxAttempts;
    if (canRetry) {
      // A retry keeps the intention running with attempt + 1 and the failed step pending again. A failed
      // verify re-runs the worker step(s) that produced its candidate (and everything between): re-verifying
      // the same tree is not a new attempt, and progressCheck compares worker executions (ADV-8).
      const rerun = step.kind === 'gate.verify' ? retrySet(plan, step) : [step.id];
      const stepStatus = { ...i.stepStatus };
      for (const id of rerun) stepStatus[id] = 'pending';
      i = clearHold({ ...i, status: i.status === 'held' || i.status === 'committed' ? 'running' : i.status, attempt: i.attempt + 1, stepStatus });
      this.intentions.update(i);
      await this.emit('intention.advanced', { intention: i as unknown as Json, retry: step.id, attempt: i.attempt, ...(rerun.length > 1 ? { rerun } : {}) }, this.traceFor(i.id));
      return;
    }
    if (i.status === 'committed') i = transitionIntention(i, 'running');
    i = clearHold(transitionIntention(i, 'failed'));
    this.intentions.update(i);
    for (const k of [...this.held.keys()]) if (k.startsWith(`${i.id}:`)) this.held.delete(k);
    await this.emit('intention.failed', { intention: i as unknown as Json, reason, terminal, blocked, ...failure }, this.traceFor(i.id));
    const goal = this.goals.get(i.goalId)!;
    if (goal.status === 'open') {
      const dropped = transitionGoal(goal, 'dropped');
      this.goals.set(goal.id, dropped);
      await this.emit('goal.dropped', { goal: dropped as unknown as Json, reason, terminal, ...failure }, { goalId: goal.id });
    }
    void plan;
  }

  // ---------- helpers ----------

  private stop(reason: string, failure?: TerminalFailure): void {
    if (this.stopped) return;
    this.stopped = { reason, ...(failure ? { failure } : {}) };
    const why = new LoopStopped(reason);
    for (const ac of this.running.values()) ac.abort(why);
    // Billed model calls in flight are cancelled too (lease loss, accounting failure, ledger failure).
    for (const ac of this.llmInFlight) ac.abort(why);
  }

  private throwIfStopped(): void {
    if (this.stopped) throw new LoopStopped(this.stopped.reason);
  }

  private isActive(i: Intention): boolean {
    return i.status === 'committed' || i.status === 'running' || i.status === 'held';
  }

  private traceFor(intentionId: string, stepId?: string): { goalId: string; intentionId: string; planId: string; stepId?: string } {
    const i = this.intentions.get(intentionId)!;
    return { goalId: i.goalId, intentionId, planId: i.planId, ...(stepId ? { stepId } : {}) };
  }

  /**
   * Append one event (payload redacted and normalized to plain JSON: undefined fields dropped). Any
   * failure to build or append it stops the loop: no transition happens without its event on the log. A
   * duplicate is a fault unless the caller declared an idempotency key it expects to collide on.
   */
  private async emit(kind: TeceraEvent['kind'], payload: JsonObject, trace: TeceraEvent['trace'], opts: { idemKey?: string; allowDuplicate?: boolean } = {}): Promise<{ duplicate: boolean }> {
    this.throwIfStopped();
    let e: TeceraEvent;
    try {
      const redacted = this.p.redact ? this.p.redact(payload) : payload;
      if (redacted === null || typeof redacted !== 'object' || Array.isArray(redacted)) throw new Error('redactor did not return an object');
      const cleanTrace = Object.fromEntries(Object.entries(trace).filter(([, v]) => v !== undefined)) as TeceraEvent['trace'];
      e = event(kind, { id: this.ids(), at: this.now(), actor: this.actor, payload: normalizeJson(redacted as JsonObject), trace: cleanTrace, runId: this.p.runId, ...(opts.idemKey ? { idemKey: opts.idemKey } : {}) });
    } catch (err) {
      this.stop(`could not build ${kind} event: ${msgOf(err)}`);
      throw new LoopStopped(this.stopped!.reason);
    }
    let duplicate: boolean;
    try {
      duplicate = (await this.bus.publishResult(e)).duplicate;
    } catch (err) {
      this.stop(`ledger append failed for ${kind}: ${msgOf(err)}`);
      throw new LoopStopped(this.stopped!.reason);
    }
    if (duplicate && !(opts.allowDuplicate && opts.idemKey)) {
      this.stop(`event id ${e.id} (${kind}) collided with an existing event; refusing to continue unrecorded`);
      throw new LoopStopped(this.stopped!.reason);
    }
    return { duplicate };
  }

  private async lastEvent(kind: TeceraEvent['kind'], goalId: string): Promise<TeceraEvent | undefined> {
    let last: TeceraEvent | undefined;
    for await (const e of this.p.ledger.events({ runId: this.p.runId, kinds: [kind] })) if (e.trace.goalId === goalId) last = e;
    return last;
  }
}

function isOwner(v: unknown): v is ApprovalOwner {
  return v === 'gate' || v === 'worker' || v === 'loop';
}

const GATE_ORDER: Record<string, number> = { allow: 0, hold: 1, block: 2 };

/**
 * Merge a frontier escalation into the reflex answer without loosening it: gate takes the stricter
 * decision, closeOut needs both to say achieved, reconsider interrupts when either does; triage / route
 * take the frontier's pick only when it is one of the offered options.
 */
function noLooser<S extends ReflexSeam>(seam: S, q: ReflexQuestions[S], r: ReflexResult<S>, f: ReflexResult<S>): ReflexResult<S> {
  const fa = (f?.answer ?? {}) as Record<string, unknown>;
  const ra = r.answer as unknown as Record<string, unknown>;
  let answer: Record<string, unknown> = ra;
  if (seam === 'gate') {
    const a = String(ra.decision);
    const b = String(fa.decision);
    answer = { decision: GATE_ORDER[b] !== undefined && GATE_ORDER[b]! >= (GATE_ORDER[a] ?? 2) ? b : a };
  } else if (seam === 'closeOut') answer = { achieved: ra.achieved === true && fa.achieved === true };
  else if (seam === 'reconsider') answer = { interrupt: ra.interrupt === true || fa.interrupt === true };
  else if (seam === 'triage') {
    const opts = (q as ReflexQuestions['triage']).options;
    if (opts.some((o) => o.intentionId === fa.intentionId)) answer = { intentionId: fa.intentionId };
  } else if (seam === 'route') {
    const opts = (q as ReflexQuestions['route']).options;
    if (opts.some((o) => o.seatId === fa.seatId)) answer = { seatId: fa.seatId };
  }
  return { ...r, answer: answer as unknown as ReflexResult<S>['answer'], provider: 'frontier', abstained: false, confidence: typeof f?.confidence === 'number' ? f.confidence : r.confidence };
}

/** A gate's failure classification, when it is one the loop knows. */
function failureOf(v: unknown): TerminalFailure | undefined {
  return v === 'budget' || v === 'human' || v === 'policy' || v === 'ledger' ? v : undefined;
}

/** A gate outcome recorded before a restart, as a step result (verify/review). */
function recordedResult(kind: 'gate.verify' | 'gate.review', p: JsonObject): StepResult {
  const failure = failureOf(p.failure);
  const base = { evidenceKey: typeof p.evidenceKey === 'string' ? p.evidenceKey : '', terminal: p.terminal === true, ...(typeof p.reason === 'string' ? { reason: p.reason } : {}), ...(failure ? { failure } : {}) };
  return kind === 'gate.verify'
    ? { kind: 'gate.verify', exitCode: typeof p.exitCode === 'number' ? p.exitCode : 1, ...base }
    : { kind: 'gate.review', verdict: p.verdict === 'approve' ? 'approve' : 'reject', ...base, ...(typeof p.fingerprint === 'string' ? { fingerprint: p.fingerprint } : {}) };
}

/** The nearest step of `kind` upstream of `from` (breadth-first over dependsOn). */
function closestUpstream(plan: Plan, from: Step, kind: StepKind): Step | undefined {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const seen = new Set<string>();
  let frontier = [...from.dependsOn];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      const s = byId.get(id);
      if (!s) continue;
      if (s.kind === kind) return s;
      next.push(...s.dependsOn);
    }
    frontier = next;
  }
  return undefined;
}

/** `from`, `to` and every step on a dependency path between them (downstream of `from`, upstream of `to`). */
function stepsBetween(plan: Plan, from: Step, to: Step): string[] {
  const up = new Set<string>([to.id]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of plan.steps) if (up.has(s.id)) for (const d of s.dependsOn) if (!up.has(d)) {
      up.add(d);
      changed = true;
    }
  }
  const down = new Set<string>([from.id]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of plan.steps) if (!down.has(s.id) && s.dependsOn.some((d) => down.has(d))) {
      down.add(s.id);
      changed = true;
    }
  }
  return plan.steps.filter((s) => up.has(s.id) && down.has(s.id)).map((s) => s.id);
}

/**
 * What a failed verify re-runs: the verify, the closest worker steps upstream of it (whose execution produced
 * the candidate) and every step between them. A verify with no worker upstream re-runs alone.
 */
function retrySet(plan: Plan, verify: Step): string[] {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const workers: Step[] = [];
  const seen = new Set<string>();
  let frontier = [...verify.dependsOn];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      const s = byId.get(id);
      if (!s) continue;
      if (s.kind === 'worker') workers.push(s);
      else next.push(...s.dependsOn);
    }
    frontier = next;
  }
  const out = new Set<string>([verify.id]);
  for (const w of workers) for (const id of stepsBetween(plan, w, verify)) out.add(id);
  return plan.steps.filter((s) => out.has(s.id)).map((s) => s.id);
}

/** A non-budget accounting failure anywhere in the error chain (the loop's or the planner's own). */
function isAccountingBroken(err: unknown): boolean {
  let e: unknown = err;
  for (let d = 0; e && d < 6; d++) {
    if (e instanceof AccountingBroken) return true;
    if (e instanceof AccountingFailure) return e.code === 'ledger';
    if (typeof e === 'object' && (e as { name?: unknown }).name === 'PlannerAccountingError' && (e as { code?: unknown }).code !== 'budget') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** A budget refusal anywhere in the error chain (ledger budget error, planner accounting failure, deadline). */
function isBudgetError(err: unknown): boolean {
  let e: unknown = err;
  for (let d = 0; e && d < 6; d++) {
    if (e instanceof AccountingBroken) return false; // a broken ledger is never a budget refusal
    if (e instanceof LedgerError) return e.code === 'budget';
    if (e instanceof BudgetExhausted) return true;
    if (typeof e === 'object' && (e as { code?: unknown }).code === 'budget') return true;
    if (e instanceof Error && /budget (exceeded|exhausted)|no budget opened|deadline exceeded/i.test(e.message)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

interface StepResultBase {
  terminal?: boolean;
  reason?: string;
  /** Classification of a terminal end: 'human' (no progress, digest drift, unreconciled commit), 'budget', 'policy'. */
  failure?: TerminalFailure;
}

export type StepResult =
  | ({ kind: 'worker'; outcome: Outcome } & StepResultBase)
  | ({ kind: 'gate.verify'; exitCode: number; evidenceKey: string } & StepResultBase)
  | ({ kind: 'gate.review'; verdict: 'approve' | 'reject'; evidenceKey: string; fingerprint?: string } & StepResultBase)
  | ({ kind: 'gate.commit'; exitCode: number; evidenceKey: string } & StepResultBase)
  | ({ kind: 'gate.pr'; exitCode: number; evidenceKey: string } & StepResultBase);

function isTerminal(flag: boolean | undefined, exitCode: number): boolean {
  return flag === true || TERMINAL_EXITS.has(exitCode);
}

function clearHold(i: Intention): Intention {
  const { resumeToken: _r, heldRequestId: _h, ...rest } = i;
  void _r;
  void _h;
  return rest;
}

/** PlanRejected-style errors carry `issues` (strings or {message}); anything else yields its message. */
function errorsOf(err: unknown): string[] {
  const issues = (err as { issues?: unknown } | null)?.issues;
  if (Array.isArray(issues) && issues.length) {
    return issues.map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' && typeof (x as { message?: unknown }).message === 'string' ? (x as { message: string }).message : JSON.stringify(x) ?? String(x)));
  }
  return [msgOf(err) || 'planner failed'];
}

function closeOutState(step: Step, r: StepResult): Json {
  switch (r.kind) {
    case 'worker':
      return { stepKind: 'worker', returnValid: r.outcome.kind === 'returned', policyAborts: r.outcome.kind === 'aborted' ? r.outcome.reasons.length : 0 };
    case 'gate.verify':
    case 'gate.commit':
    case 'gate.pr':
      return { stepKind: r.kind, exitCode: r.exitCode };
    case 'gate.review':
      return { stepKind: 'gate.review', verdict: r.verdict };
  }
}

function describeFailure(r: StepResult): string {
  switch (r.kind) {
    case 'worker':
      return r.outcome.kind === 'aborted' ? `aborted: ${r.outcome.reasons.map((x) => x.code).join(',')}` : r.outcome.kind === 'failed' ? `failed: ${r.outcome.error.message}` : 'worker did not return';
    case 'gate.verify':
      return `verify exit ${r.exitCode}`;
    case 'gate.review':
      return `review ${r.verdict}`;
    case 'gate.commit':
      return `commit exit ${r.exitCode}`;
    case 'gate.pr':
      return `PR exit ${r.exitCode}`;
  }
}

function summarize(r: StepResult): Json {
  return r.kind === 'worker' ? { outcome: r.outcome.kind } : (normalizeJson({ ...r } as unknown as JsonObject) as Json);
}

function capabilitiesFor(m: Manifest, plan: Plan, step: Step): CapabilitySet {
  return {
    tools: effectiveStepTools(plan, step),
    paths: { read: ['**'], write: plan.permissions.write.filter((w) => m.repo.allowedChanges.includes(w) || m.repo.allowedChanges.some((a) => w.startsWith(a.replace('/**', '')))), protected: m.policy.protectedPaths },
    network: 'none' as const,
    limits: { usd: plan.budget.usd ?? m.budgets.usd, tokens: plan.budget.tokens ?? m.budgets.tokens, calls: 200, wallMs: (plan.budget.wallClockSec ?? m.budgets.wallClockSec) * 1000, depth: plan.budget.maxDepth ?? m.budgets.maxDepth, iterations: plan.budget.maxIterations ?? m.budgets.maxIterations },
  };
}
