import { canonicalJson, sha256, type Json, type JsonObject } from './json.js';
import type { AchievementGoal, AchievementProof, Belief, Intention, Plan, Principal, Step } from './bdi.js';
import type { Manifest } from './manifest.js';
import type { TeceraEvent, EventKind, Trace } from './events.js';
import type { DecisionRecord, ReflexAnswers, ReflexQuestions, ReflexResult, ReflexSeam } from './reflex.js';
import type { CapabilitySet, Effect, ExecResult, HookDescriptor, Inputs, Outcome, SpanEvent, SpanKind, ToolRequest, ToolResult, WriteGuard } from './worker.js';

/**
 * Ports implemented by sibling packages and wired by @tecera/runtime. @tecera/loop depends only on
 * these; nothing here performs I/O by itself.
 */

// ---- events / bus ----

export interface Bus {
  publish(e: TeceraEvent): Promise<void>;
  subscribe(kinds: EventKind[] | '*', handler: (e: TeceraEvent) => Promise<void>): () => void;
}

// ---- ledger ----

export interface AppendResult {
  seq: number;
  hash: string;
  /** True when an event with the same idemKey already existed and nothing was written. */
  duplicate: boolean;
}

export interface EvidenceRecord {
  key: string;
  kind: string;
  runId: string;
  digest: string;
  body: Json;
  seq: number;
}

export interface Reservation {
  id: string;
  pool: string;
  amount: number;
  runId: string;
  /**
   * Set when this reservation took an UNENFORCED pool past its cap (budgets.enforce false, D3): the
   * reservation was still recorded; `used` is the pool's usage before it. Never set on an enforced pool
   * (which refuses with LedgerError('budget') instead).
   */
  exhausted?: { used: number; cap: number };
}

/** openBudget options. `enforce` (default true): false opens a soft pool that records usage past its cap. */
export interface BudgetOptions {
  enforce?: boolean;
}

/** One pool of a run, for reporting (Ledger.budgetUsage). `used` counts charged actuals plus open reservations. */
export interface PoolUsage {
  pool: string;
  cap: number;
  used: number;
  enforce: boolean;
  /** Reservations made on the pool (any state). */
  reservations: number;
}

export interface Lease {
  resource: string;
  holder: string;
  fencingToken: number;
  expiresAt: number;
}

export interface ApprovalRequest {
  requestId: string;
  runId: string;
  sessionId: string;
  actionHash: string;
  requester: Principal;
  reason: string;
  expiresAt: number;
}

export interface ApprovalGrant {
  requestId: string;
  approver: Principal;
  grantedAt: number;
  expiresAt: number;
}

export type ApprovalState = 'pending' | 'granted' | 'denied' | 'consumed' | 'expired';

/** Read model of one approval row. `approver` is set once granted or denied. */
export interface ApprovalView {
  requestId: string;
  runId: string;
  sessionId: string;
  actionHash: string;
  requester: Principal;
  state: ApprovalState;
  expiresAt: number;
  approver?: Principal;
}

export class LedgerError extends Error {
  constructor(message: string, public readonly code: 'append-only' | 'budget' | 'approval' | 'lease' | 'evidence' | 'chain' | 'io') {
    super(message);
    this.name = 'LedgerError';
  }
}

/**
 * Result of Ledger.verifyChain. A broken events link reports exactly {ok:false, brokenAtSeq}; a broken evidence link (evidence rows
 * are hash-chained too, each row bound to the events head at its seq) also names the evidence key.
 */
export type ChainVerdict = { ok: true; length: number } | { ok: false; brokenAtSeq: number; brokenEvidenceKey?: string; reason?: string };

export interface Ledger {
  /**
   * Append one event. Events are append-only: an existing seq, id or idemKey can never be rewritten (an
   * equal id/idemKey returns `duplicate: true` and writes nothing; a raw INSERT OR REPLACE aborts).
   */
  append(e: TeceraEvent): Promise<AppendResult>;
  events(filter?: { runId?: string; kinds?: EventKind[]; sinceSeq?: number }): AsyncIterable<TeceraEvent & { seq: number; hash: string }>;
  /** Recompute the events hash chain and the evidence chain; report the first broken link, if any. */
  verifyChain(): Promise<ChainVerdict>;
  evidence(e: { key: string; kind: string; runId: string; body: Json }): Promise<EvidenceRecord>;
  getEvidence(key: string): Promise<EvidenceRecord | null>;
  /**
   * Declare the cap for a pool within a run. Re-opening never widens it (the smaller cap wins) and never
   * relaxes it (an enforced pool stays enforced). Enforced pools (the default): reservations beyond the cap
   * throw LedgerError('budget'). Soft pools (`{enforce: false}`, D3): the reservation is recorded anyway
   * and carries `exhausted`.
   */
  openBudget(runId: string, pool: string, cap: number, opts?: BudgetOptions): Promise<void>;
  reserve(pool: string, amount: number, runId: string, idemKey: string): Promise<Reservation>;
  /** Every pool of a run with its cap and usage (reporting). Optional for compatibility. */
  budgetUsage?(runId: string): Promise<PoolUsage[]>;
  settle(reservationId: string, actual: number): Promise<void>;
  lease(resource: string, holder: string, ttlMs: number): Promise<Lease | null>;
  renew(lease: Lease, ttlMs: number): Promise<Lease>;
  release(lease: Lease): Promise<void>;
  requestApproval(r: ApprovalRequest): Promise<ApprovalRequest>;
  /**
   * pending → granted, atomically with the state read (no check-then-write window across connections).
   * Refuses: unknown, not pending, expired (marks it expired), other session, self-approval, non-human.
   *
   * `audit` is the grant's `approval.granted` event (see approvalGrantedEvent / approvalAuditProblem). When
   * given, the grant and the event are recorded atomically (one transaction / one critical section): both
   * or neither. Without it the grant is recorded but stays UNAUDITED, and consume() refuses it until a
   * matching approval.granted event has been appended.
   */
  approve(requestId: string, approver: Principal, sessionId: string, at: number, audit?: TeceraEvent): Promise<ApprovalGrant>;
  /** pending → denied, atomically. An expired request is marked expired and refused. */
  deny(requestId: string, approver: Principal, reason: string, at: number): Promise<void>;
  /**
   * granted → consumed exactly once, bound to actionHash + sessionId, before expiry. Refuses an unaudited
   * grant: one whose `approval.granted` event (same request, same run, actor = the approver) is absent.
   */
  consume(requestId: string, actionHash: string, sessionId: string, idemKey: string, at: number): Promise<void>;
  /** Current state of an approval, or null when unknown. Required (every ledger implements it). */
  getApproval(requestId: string): Promise<ApprovalView | null>;
  /**
   * Every evidence record of a run, in the order it was written (evidence chain order), optionally only the
   * kinds starting with `kindPrefix`. Used by reconciliation and offline replay (deriveGoalStatus). Optional
   * for compatibility; callers that need it use requireListEvidence (fail closed when absent).
   */
  listEvidence?(runId: string, kindPrefix?: string): Promise<EvidenceRecord[]>;
  checkpoint(runId: string, key: string, state: JsonObject): Promise<string>;
  loadCheckpoint(id: string): Promise<JsonObject | null>;
}

/** Fail-closed approval lookup: throws LedgerError('approval') when the ledger cannot answer. */
export async function requireApproval(ledger: Ledger, requestId: string): Promise<ApprovalView | null> {
  if (typeof (ledger as Partial<Ledger>).getApproval !== 'function') throw new LedgerError('ledger does not support approval lookup (getApproval)', 'approval');
  return ledger.getApproval(requestId);
}

/** Fail-closed evidence enumeration: throws LedgerError('evidence') when the ledger cannot list evidence. */
export async function requireListEvidence(ledger: Ledger, runId: string, kindPrefix?: string): Promise<EvidenceRecord[]> {
  if (typeof (ledger as Partial<Ledger>).listEvidence !== 'function') throw new LedgerError('ledger does not support evidence enumeration (listEvidence)', 'evidence');
  return ledger.listEvidence!(runId, kindPrefix);
}

/** What an approval.granted audit event must match: the approval row and its approver. */
export interface ApprovalAuditTarget {
  requestId: string;
  runId: string;
  sessionId: string;
  actionHash: string;
  approver: Principal;
}

/**
 * Why `e` is not the audit event of the grant `a` (null when it is): kind approval.granted, payload.requestId
 * = the request, runId = the approval's run, actor = the approver; payload sessionId / actionHash / approver,
 * when present, must agree with the row. Both ledgers apply it on approve(…, audit) and on consume().
 */
export function approvalAuditProblem(e: Pick<TeceraEvent, 'kind' | 'runId' | 'actor' | 'payload'>, a: ApprovalAuditTarget): string | null {
  if (e.kind !== 'approval.granted') return `audit event is ${e.kind}, not approval.granted`;
  const p = (e.payload ?? {}) as Record<string, unknown>;
  if (p.requestId !== a.requestId) return 'audit event names another request';
  if (e.runId !== a.runId) return 'audit event belongs to another run';
  if (e.actor?.kind !== a.approver.kind || e.actor?.id !== a.approver.id) return 'audit event actor is not the approver';
  if (p.sessionId !== undefined && p.sessionId !== a.sessionId) return 'audit event session differs from the approval';
  if (p.actionHash !== undefined && p.actionHash !== a.actionHash) return 'audit event action hash differs from the approval';
  const ap = p.approver as { kind?: unknown; id?: unknown } | undefined;
  if (ap !== undefined && (ap === null || typeof ap !== 'object' || ap.kind !== a.approver.kind || ap.id !== a.approver.id)) return 'audit event approver differs from the grant';
  return null;
}

/**
 * Build the approval.granted audit event for approve(…, audit). idemKey defaults to
 * `approval.granted:<requestId>` (the key the CLI uses), so a repaired decision can never be recorded twice.
 */
export function approvalGrantedEvent(a: ApprovalAuditTarget & { id: string; at: number; trace: Trace; reason?: string; idemKey?: string; extra?: JsonObject }): TeceraEvent {
  return {
    id: a.id,
    kind: 'approval.granted',
    at: a.at,
    actor: { kind: a.approver.kind, id: a.approver.id },
    runId: a.runId,
    trace: a.trace,
    idemKey: a.idemKey ?? `approval.granted:${a.requestId}`,
    payload: {
      ...(a.extra ?? {}),
      requestId: a.requestId,
      approver: { kind: a.approver.kind, id: a.approver.id },
      sessionId: a.sessionId,
      actionHash: a.actionHash,
      reason: a.reason ?? '',
    },
  };
}

// ---- projections ----

export interface BeliefProjection {
  get(key: string): Belief | undefined;
  all(): Belief[];
  match(pattern: { key: string; equals?: Json; exists?: boolean }): boolean;
}

export interface Board {
  intentions(): Promise<Intention[]>;
  upsert(i: Intention): Promise<void>;
  goals(): Promise<AchievementGoal[]>;
  upsertGoal(g: AchievementGoal): Promise<void>;
}

// ---- plans ----

export interface PlanLibrary {
  match(e: TeceraEvent, beliefs: BeliefProjection): Promise<Plan[]>;
  get(id: string): Promise<Plan | undefined>;
  stage(p: Plan): Promise<void>;
}

/**
 * Plan validation beyond shape: permissions, budgets and goal ceilings within the manifest. Implemented by
 * @tecera/policy / @tecera/planner. The loop runs it on generated AND reused (library) plans before use.
 */
export interface PlanValidator {
  validatePlan(plan: Plan, manifest: Manifest, goal: AchievementGoal): string[];
}

/**
 * Per-call usage sink the loop hands to the planner. The loop reserves the seat's usd/tokens on the ledger
 * BEFORE the call and settles AFTER it: at the usage recorded here, or at the full reservation when the
 * planner records nothing (fail closed: unreported usage is charged at the estimate).
 */
export interface UsageMeter {
  record(usage: LLMUsage): void;
  /**
   * Aborted when the call must stop: the run deadline passed, the lease was lost or the loop stopped. The
   * seat MUST pass it to LLM.complete(req, signal). The loop also stops waiting for the call when it fires
   * and charges the full reservation (the request may still be billed).
   */
  readonly signal?: AbortSignal;
}

export interface Planner {
  /** Write a plan for an event when the library has none. Returns a candidate plan; the loop validates it. */
  write(e: TeceraEvent, beliefs: BeliefProjection, goal: AchievementGoal, meter?: UsageMeter): Promise<Plan>;
  /** Deliberate between options when the reflex is unsure. */
  deliberate(options: Plan[], intentions: Intention[], beliefs: BeliefProjection, meter?: UsageMeter): Promise<Plan>;
}

// ---- reflexes ----

/**
 * The frontier seat answering a reflex question (the planner model). Wired into the reflex router and,
 * optionally, the loop (LoopPorts.frontier) so a shaky answer escalates by default (D2).
 */
export interface ReflexFrontier {
  decide<S extends ReflexSeam>(seam: S, q: ReflexQuestions[S], opts?: ReflexAskOptions): Promise<ReflexResult<S>>;
}

/** Per-ask context for reflex seams backed by a model ('model' / 'frontier'): cancellation and usage reporting. */
export interface ReflexAskOptions {
  signal?: AbortSignal;
  meter?: UsageMeter;
}

export interface Reflex {
  /** `opts` is optional; a model-backed seam should pass opts.signal to its LLM call and report usage on opts.meter. */
  ask<S extends ReflexSeam>(seam: S, q: ReflexQuestions[S], opts?: ReflexAskOptions): Promise<ReflexResult<S>>;
}

export interface DecisionSink {
  record(d: DecisionRecord): Promise<void>;
}

export type ReflexAnswer<S extends ReflexSeam> = ReflexAnswers[S];

// ---- models ----

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type LLMEffort = 'low' | 'medium' | 'high';

export interface LLMRequest {
  seatId: string;
  model: string;
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Per-call reasoning effort; absent = the seat's configured effort. */
  effort?: LLMEffort;
  /** Optional JSON schema for structured output. */
  schema?: JsonObject;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  usd: number;
  /** Prompt-cache reads included in inputTokens, when the provider reports them. */
  cacheReadTokens?: number;
  /** Prompt-cache writes included in inputTokens, when the provider reports them. */
  cacheWriteTokens?: number;
  /**
   * The figures are an estimate (missing usage, unpriced model): the call may have been billed more. Seat
   * accounting charges at least the reservation for it and keeps it classified as unknown (chargeOf).
   */
  unknown?: true;
}

export interface LLMResponse {
  content: string;
  usage: LLMUsage;
  model: string;
  finishReason: 'stop' | 'length' | 'error';
  /** Sanitized error description when finishReason is 'error' (never the raw provider body). */
  error?: string;
  raw?: Json;
}

export interface LLM {
  id: string;
  /** Vendor identity (e.g. 'anthropic', 'openai'). Foreign-review checks compare this. */
  provider: string;
  /** Default model of this seat. */
  model?: string;
  /**
   * Non-reversible fingerprint of the credential this LLM uses (e.g. sha256(key).slice(0, 16)); never the
   * key. Foreign-review checks compare it; a reviewer whose provider or keyFingerprint is missing must be
   * treated as NOT foreign (fail closed).
   */
  keyFingerprint?: string;
  complete(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse>;
}

// ---- worker ----

export interface WorkerStepRequest {
  runId: string;
  goal: AchievementGoal;
  plan: Plan;
  intention: Intention;
  step: Step;
  seatId: string;
  inputs: Inputs;
  /** Effective capabilities: plan permissions narrowed by step.tools and the manifest. */
  capabilities: CapabilitySet;
  /**
   * Absolute worktree path the step operates on. Empty string = not configured: a worker MUST refuse any
   * file or verify tool (fail closed).
   */
  worktree: string;
  /** Lease fencing token for repo writes; absent = writes must be refused. */
  fencingToken?: number;
  /**
   * Live mutation-time fence for this step (see WriteGuard in worker.ts). The worker hands it to every
   * tool call (Tool.call's third argument) and derives ToolContext.fence from it. Absent = every write
   * must be refused (requireWriteGuard).
   */
  guard?: WriteGuard;
}

export interface Worker {
  run(req: WorkerStepRequest, signal?: AbortSignal): Promise<Outcome>;
  /**
   * Continue a suspended step from its checkpoint. The worker owns consumption of a grant for a request it
   * suspended on (the loop only checks the grant is 'granted' first and never consumes it). `guard` is the
   * live fence for the resumed exec; when the suspension was a write (SuspendRequest.write), its
   * authorizeWrite approves exactly that one write once. Absent = writes must be refused.
   */
  resume(resumeToken: string, grant: ApprovalGrant, signal?: AbortSignal, guard?: WriteGuard): Promise<Outcome>;
}

// ---- gates (host-run gate steps; implemented by @tecera/gates, driven by @tecera/loop) ----

/**
 * Approval the loop hands to a gate. Only gate.pr receives one (D6: the PR is the approval point; commits
 * to the work branch need none). The gate (not the loop) consumes it, with exactly this actionHash.
 */
export interface GateApproval {
  requestId: string;
  sessionId: string;
  actionHash: string;
}

export interface GateContext {
  runId: string;
  goal: AchievementGoal;
  plan: Plan;
  intention: Intention;
  step: Step;
  /** Absolute worktree path. Empty string = not configured: every gate MUST refuse (terminal). */
  worktree: string;
  /** Present on a gate.pr step resumed after a human grant (bound to prActionHash of the committed sha). */
  approval?: GateApproval;
  /** Candidate fingerprints the loop saw: d1 = latest verify fingerprint, d2 = latest review fingerprint. */
  candidate?: { d1?: string; d2?: string };
  /**
   * gate.pr only: the commit the intention's gate.commit recorded on the work branch (sha) and the candidate
   * it committed (d1, the fingerprint a review.passed approved). The PR gate pushes / bundles exactly it.
   */
  commit?: { sha: string; d1?: string; evidenceKey?: string };
  /** Aborted when the intention is dropped or the run stops; gates must stop child processes. */
  signal?: AbortSignal;
  /**
   * True when this gate step is re-dispatched by Loop.restore() after the process died while it ran
   * (security.md §4): verify re-runs and must match D1; review is at-most-once per (run, D1).
   */
  recovered?: boolean;
  /**
   * Live mutation-time fence. The commit gate MUST call guard.check() immediately before each git mutation
   * (object writes, update-ref, index update) and refuse when it is absent (requireWriteGuard).
   */
  guard?: WriteGuard;
}

interface GateResultBase {
  evidenceKey: string;
  /** Never retry this step (policy refusal, human needed, tooling missing). Exit codes 8 and 9 imply it. */
  terminal?: boolean;
  reason?: string;
  /** Classification of a terminal result; the loop carries it onto step.failed / intention.failed / goal.dropped. */
  failure?: 'budget' | 'human' | 'policy' | 'ledger';
}

export interface GateVerifyResult extends GateResultBase {
  exitCode: number;
  /** Fingerprint of the tree the verify ran against (D1 for the commit binding). */
  fingerprint?: string;
}

export interface GateReviewResult extends GateResultBase {
  verdict: 'approve' | 'reject';
  /** Fingerprint of the tree after review (D2). */
  fingerprint?: string;
}

export interface GateCommitResult extends GateResultBase {
  exitCode: number;
  sha?: string;
}

/**
 * gate.pr outcome (D6). exit 0 with `url`: the work branch was pushed and a PR opened (pr.opened). exit 0
 * without `url`: no remote / no authenticated gh, so pr.requested was recorded with the branch, base and a
 * patch bundle under .tecera/runs/<run>/pr/ (`bundle`). Anything else is a failure (pr.failed). `sha` must be
 * the committed sha the approval was bound to. Tecera never merges.
 */
export interface GatePrResult extends GateResultBase {
  exitCode: number;
  sha: string;
  url?: string;
  branch?: string;
  base?: string;
  /** Path of the patch bundle (pr.requested). */
  bundle?: string;
  /** True when the branch was pushed to a remote. */
  pushed?: boolean;
}

/** Outcome of reconciling a commit interrupted after its grant was consumed (security.md §4 S8). */
export interface GateReconcileResult {
  /** True only when the commit is proven to exist for exactly this candidate (HEAD^{tree} = recorded write-tree). */
  recorded: boolean;
  sha?: string;
  reason?: string;
  evidenceKey?: string;
}

/**
 * What reconcile may answer: a GateReconcileResult; or (the @tecera/gates shape) a GateCommitResult where
 * exit 0 + sha means recorded, or null when no commit intent was ever recorded. Only `recorded` with a sha
 * (or exit 0 with a sha) counts as a commit; everything else is a terminal 'human' failure.
 */
export type GateReconcileOutcome = GateReconcileResult | GateCommitResult | null;

export interface GateRunner {
  verify(ctx: GateContext): Promise<GateVerifyResult>;
  review(ctx: GateContext): Promise<GateReviewResult>;
  /** Commit the verified, reviewed candidate to the work branch tecera/<goal>. No approval (D6). */
  commit(ctx: GateContext): Promise<GateCommitResult>;
  /**
   * The PR gate (D6): ctx.approval (a consumed-by-the-gate human grant bound to prActionHash of ctx.commit.sha)
   * and ctx.commit are always present. Push the work branch when a remote exists and open a PR with
   * `gh pr create` when gh is available and authenticated; else record the patch bundle. Never merge.
   */
  pr(ctx: GateContext): Promise<GatePrResult>;
  /**
   * S8 recovery: a gate.commit step was running when the process died and no commit.recorded exists. The
   * loop calls this (never commit() again) with the same context (approval included when the step had
   * one). Proven commit + sha → the loop records it (idempotent by (runId, sha)); anything else → a
   * terminal 'human' failure. Absent → the loop fails the step terminally (human), never re-commits.
   */
  reconcile?(ctx: GateContext): Promise<GateReconcileOutcome>;
}

/** Normalize any reconcile answer: recorded only with a sha and (for the commit shape) exit 0, not terminal. */
export function reconcileVerdict(r: GateReconcileOutcome | undefined): GateReconcileResult {
  if (r === null || r === undefined || typeof r !== 'object') return { recorded: false, reason: 'the gate found no commit intent to reconcile' };
  if ('recorded' in r && typeof r.recorded === 'boolean') {
    const ok = r.recorded === true && typeof r.sha === 'string' && r.sha.length > 0;
    return { recorded: ok, ...(r.sha ? { sha: r.sha } : {}), ...(r.evidenceKey ? { evidenceKey: r.evidenceKey } : {}), ...(ok ? {} : { reason: r.reason ?? 'reconcile could not prove the commit' }) };
  }
  const c = r as GateCommitResult;
  const ok = c.exitCode === 0 && c.terminal !== true && typeof c.sha === 'string' && c.sha.length > 0;
  return { recorded: ok, ...(c.sha ? { sha: c.sha } : {}), ...(c.evidenceKey ? { evidenceKey: c.evidenceKey } : {}), ...(ok ? {} : { reason: c.reason ?? `reconcile exit ${String(c.exitCode)}` }) };
}

export interface CommitActionInput {
  intentionId: string;
  stepId: string;
  attempt: number;
  /** Latest verify fingerprint (D1) when known; null/absent binds to the step only. */
  candidateD1?: string | null;
}

/**
 * The action hash a gate.commit approval is requested under and consumed with:
 * sha256(canonicalJson({intentionId, stepId, attempt, candidateD1})) with candidateD1 = null when unknown.
 * The loop requests with it; the commit gate MUST recompute it from GateContext (intention.id, step.id,
 * intention.attempt, candidate.d1), check it equals approval.actionHash, check d1 equals the tree it is
 * about to commit, and only then consume.
 */
export function commitActionHash(a: CommitActionInput): string {
  return sha256(canonicalJson({ intentionId: a.intentionId, stepId: a.stepId, attempt: a.attempt, candidateD1: a.candidateD1 ?? null }));
}

/**
 * The action hash a gate.pr approval is requested under and consumed with (D6): commitActionHash with
 * candidateD1 = the COMMITTED sha, so a grant opens a PR for exactly that commit.
 */
export function prActionHash(a: { intentionId: string; stepId: string; attempt: number; sha: string }): string {
  return commitActionHash({ intentionId: a.intentionId, stepId: a.stepId, attempt: a.attempt, candidateD1: a.sha });
}

// ---- stop hook (D4) ----

/** What the host Stop hook knows: the active run of this business case (null = none) and its proof, if any. */
export interface StopHookInput {
  activeRun: { runId: string; goalId?: string; state?: string } | null;
  achievedProof: AchievementProof | null | undefined;
}

/**
 * The Stop hook's answer. 'block' = exit 2 with `reason` on stderr (Claude Code keeps the assistant working);
 * 'allow' = exit 0. Budget never blocks stopping.
 */
export interface StopHookDecision {
  decision: 'allow' | 'block';
  exitCode: 0 | 2;
  reason: string;
}

/** Evidence key under which the review gate records its verdict for (run, D1): at most one reviewer call per key. */
export function reviewEvidenceKey(runId: string, d1: string): string {
  return `review:${runId}:${d1}`;
}

/** Digest of the verify command that ran, recorded in gate.verify evidence as `commandDigest`. */
export function verifyCommandDigest(command: string): string {
  return sha256(`tecera.verify.command\0${command}`);
}

// ---- tools ----

export interface ToolContext {
  runId: string;
  worktree: string;
  capabilities: CapabilitySet;
  fencingToken?: number;
  /**
   * True while the lease / fencing token this call was dispatched under is still live and the exec is not
   * tainted (fenceOf(guard)). Absent = treat as false for every mutation (fail closed).
   */
  fence?: () => boolean;
}

export interface Tool {
  name: string;
  methods: string[];
  schema: JsonObject;
  /** Risk class used by the gate reflex's rule fallback. */
  risk: 'read' | 'write' | 'irreversible';
  /**
   * `guard` is the mutation-time fence (worker.ts WriteGuard). A tool whose risk is not 'read' MUST call
   * guard.check() immediately before each mutation, and guard.authorizeWrite(w) before each file write when
   * present; without a guard it must refuse every mutation (requireWriteGuard). Optional in the type only so
   * existing callers keep compiling; callers MUST pass it.
   */
  call(req: ToolRequest, ctx: ToolContext, guard?: WriteGuard): Promise<ToolResult>;
}

// ---- hooks ----

export interface AmbientView {
  capabilities: CapabilitySet;
  blackboard: Readonly<Record<string, Json>>;
  hooks: HookDescriptor[];
}

export interface Hook {
  readonly id: string;
  readonly mandatory: boolean;
  readonly spans: ReadonlySet<SpanKind>;
  handle(event: SpanEvent, view: AmbientView): Effect[] | Promise<Effect[]>;
  describe(): HookDescriptor;
}

// ---- sandbox / verify (implemented by @tecera/worker; consumed by worker tools and @tecera/gates) ----

export interface ExecRequest {
  execNo: number;
  code: string;
  bindings: Inputs;
  timeoutMs: number;
}

export type ToolBridge = (req: ToolRequest) => Promise<ToolResult>;

/** One disposable restricted child per exec. See docs/security.md §2–3. */
export interface Repl {
  exec(req: ExecRequest, bridge: ToolBridge, signal?: AbortSignal): Promise<ExecResult & { printed: string }>;
  dispose(): Promise<void>;
}

export interface VerifyRequest {
  cwd: string;
  command: string;
  timeoutSec: number;
  /** Explicit env allowlist; everything else is scrubbed. */
  envAllowlist: string[];
}

export interface VerifyOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** An output stream hit its byte cap (stdout or stderr). Tree mutation is a separate gate check. */
  truncated: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  /** The run was cancelled through the AbortSignal. */
  cancelled?: boolean;
}

/** Runs the manifest's verify command in a separate scrubbed process (never the REPL child). */
export interface VerifyRunner {
  run(req: VerifyRequest, signal?: AbortSignal): Promise<VerifyOutcome>;
}
