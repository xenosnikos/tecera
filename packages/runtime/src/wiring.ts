import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AccountingFailure,
  capabilityInventoryOf,
  event,
  LedgerError,
  payloadOf,
  resourceRegistryOf,
  acceptedContractOf,
  statedAllows,
  statedEnvelope,
  type AcceptanceContract,
  type AchievementGoal,
  type CapabilityMockedPayload,
  type CapabilityProbe,
  type CapabilityRecord,
  type ContractDraft,
  type MockToolDeclaration,
  type PlanningContext,
  type ProvisionedResource,
  type Provisioner,
  type ResourceRegistry,
  type Tool,
  type AttemptFingerprint,
  type ApprovalGrant,
  type BeliefProjection,
  type Budget,
  type EvidenceRecord,
  type ExecRequest,
  type BudgetExhaustion,
  type GateContext,
  type GatePrResult,
  type GateReconcileOutcome,
  type GateRunner,
  type Intention,
  type Json,
  type Ledger,
  type LLM,
  type LLMUsage,
  type Manifest,
  type Outcome,
  type PathChange,
  type Plan,
  type PlanLibrary,
  type PoolUsage,
  type PlanValidator,
  type Planner,
  type Redactor,
  type Reflex,
  type Repl,
  type SecretInput,
  type StatedEnvelope,
  type TeceraEvent,
  type Trace,
  type UsageMeter,
  type VerifyRunner,
  type Worker,
  type WorkerStepRequest,
  type WriteGuard,
} from '@tecera/contracts';
import { Brain } from '@tecera/brain';
import { claim, createGates, GateMemo, hostGit, ignoredBaseline, intentionBranchName, preparationKeys, preparationRecordOf, PrGate, scrubbedAllowlist, snapshotCandidate, writeEvidence, type Gates } from '@tecera/gates';
import { DEFAULT_LLM_RESERVATION, type IntentionPreparation, type IntentionPreparationRequest, type SeatCost, type WorktreeChange } from '@tecera/loop';
import { createPlanValidator, LLMPlanner, type RepoFacts } from '@tecera/planner';
import { allowanceOf, assertMandatory, criterionScriptDirs, mandatoryHooks, packageScriptsOf, type PackageScripts, type PermissionsDoc } from '@tecera/policy';
import { createProvider, doctorProbe, priceFor, type FetchLike, type SecretStore } from '@tecera/providers';
import type { Frontier } from '@tecera/reflex';
import { ChildProcessRepl, createDeleteTool, createEditTool, createListFilesTool, createReadTool, MESSAGE_KINDS, MESSAGE_METHODS, resourceTools, StepWorker, STORE_KINDS, STORE_METHODS, type ChangeAuthorizer, type ReplFactory } from '@tecera/worker';
import { capabilityAccess, hostBinding, repositoryFacts, runtimeEnvironment, withStandIns } from './capabilities/access.js';
import { ConnectionProbe, storeAuthResolver } from './capabilities/probe.js';
import { LocalProvisioner, locatorWithin, resourcesRoot } from './capabilities/provisioner.js';
import { releaseExpired } from './capabilities/sweep.js';
import { admitVerify, VERIFY_ALLOW_ROOT_ENV, VerifyContainmentError, verifyIdentity } from './containment.js';
import { COST_KIND, costLine, costRecordingLLM, costReport, type CostSink } from './cost.js';
import { fencedTool, fencedVerifyRunner, leasedGateContext, leaseGuard, mutationCheck, stepGuards } from './fencing.js';
import { ModelFrontier } from './frontier.js';
import type { GoalSpec } from './goals.js';
import { cancellableLLM, meteredLLM, SeatMeter, type SeatReservation } from './metering.js';
import { OwnershipRecorder, ownerFilePath, reapPriorProcesses, type ReapResult } from './ownership.js';
import { providerOptions, providerSetup, withIdentity } from './providerSetup.js';
import { loadScripts, scriptedFetch, ScriptedRunPlanner, type ScriptSet, type ScriptTap } from './scripted.js';
import { gitSync, type Env } from './util/proc.js';
import { changedPaths, diffTrees, leaseWorktree, repoFileView, WiringError, worktreesRoot, type LeasedWorktree } from './worktree.js';

export { WiringError } from './worktree.js';

/**
 * The seam between the runtime and the model-backed packages (@tecera/providers, @tecera/planner,
 * @tecera/gates, worker invoke/sandbox). `wireRunPorts` builds every port of one run; everything else about
 * a run (readiness, effective budgets, the Loop, baseline, cancellation, resume, exit codes) lives in
 * commands/run.ts and takes what is returned here.
 *
 * What wiring does, in order (each step fail-closed with WiringError → the run does not start):
 * 1. scripted mode (ctx.scripted): load plan/replies; the provider TRANSPORT is replaced, nothing else;
 *    a run cannot switch between scripted and live across resume;
 * 2. one provider per seat (createProvider over the run's SecretStore, the shared redactor on top);
 * 3. the worktree lease (worktree.ts): fresh `git worktree add` (or a private copy when the business case is
 *    not a git repository), reused on resume; fencing token renewed while the run lives;
 * 4. the verify runner (ProcessVerifyRunner: owned process tree, scrubbed env, no network; IsolationUnavailable
 *    refuses the run) shared by the worker's runVerify tool and the verify gate;
 * 5. the worker: StepWorker over a ChildProcessRepl per exec (sandbox profile from the manifest), the
 *    fourteen mandatory hooks (assertMandatory; progressCheck fed from the ledger's verify fingerprints per
 *    attempt of the step's intention), tools read/edit/delete/listFiles (+ runVerify bound to the goal check), every
 *    known secret for redaction and the canary, brain context added to each step's inputs;
 * 6. gates: createGates with the METERED reviewer seat, every writer identity (planner + workers), the
 *    redactor, the worktree and the session; verify/review/commit/pr/reconcile are exposed (D6: commit lands
 *    on the work branch tecera/<goal> without approval; gate.pr is the only approval point and Tecera never
 *    merges; a gates build without a PR gate fails gate.pr terminally for a human);
 * 7. planner: ScriptedRunPlanner (scripted.ts) when a scripted plan is given, else LLMPlanner on the planner seat with brain
 *    lessons and recorded deliberations. The loop reserves before and settles after every planner call; the
 *    planner's usage reports are bridged onto the loop's meter (never charged twice);
 * 8. goal-aware validator (planner createPlanValidator over the real tool catalog, worker seats, redactor);
 * 9. route costs per worker seat, and the planner seat as the METERED frontier for shaky reflex answers;
 * 10. capabilities (D9, D10, D12): the connection probe (ConnectionProbe over the contained verify runner, in
 *    the worktree), the local provisioner (LocalProvisioner under $TECERA_RESOURCES), the run's secrets
 *    predicate, and the expiry sweep. A provisioned sqlite / http-stub becomes a brokered tool named after its
 *    capability; a capability the loop resolved to 'mock' is served by a stand-in (WorkerStepRequest.mocks) to
 *    every worker step, whatever tools the plan listed (the stand-in's tool is added to the step's), and its
 *    first use is recorded as capability.mocked; a criterion that requires such a capability when no step used
 *    the stand-in is proven against the code's own fake, so the verify port records capability.mocked before
 *    the gate runs it (a mock rung is never an exit 9). Each worker step's inputs carry `capabilityAccess`
 *    (per stand-in or provisioned resource: kind, fidelity, tool name, locator and its TECERA_RESOURCE_<ID>
 *    variable, how to use it) and `runtimeEnvironment` (Node built-ins, the packages package.json lists). A
 *    provisioned git-remote is the remote gate.pr pushes to (added to the worktree for the delivery, removed
 *    after it) when the repository has no remote of that name.
 * 11. the planner's view of the repository: repoFiles (existence), repoFacts (packages, tested API), and
 *    every contract draft its screen refused recorded as `criteria.rejected` evidence + evidence.appended.
 *
 * Lease authority (security.md §4): the lease's `lost` signal is handed to the loop (it stops and aborts
 * running steps), every live sandbox child is disposed on loss, every write-class tool re-proves the lease
 * on the ledger before it runs (fencing.ts), and every gate call re-proves it before it starts and runs with
 * the lease signal merged into its own. A stale fencing token is refused at each of those boundaries.
 *
 * Seat accounting: reviewer and frontier calls go through SeatMeter (reserve before, settle after, probe for
 * overrun). With budgets.enforce true, exhaustion is LedgerError('budget') and ends the step as a budget
 * failure (exit 7); with enforce false (the default, D3) the pools are soft: usage is recorded and reported,
 * exhaustion is recorded once per pool as budget.exhausted and the run continues. The durable run deadline
 * (wall clock) follows the same switch; loop-safety limits (depth, iterations, attempts, exec timeouts)
 * are always enforced.
 *
 * Cost (cost.ts): every seat's completed calls are recorded as cost.call events (worker and review calls
 * with the step's trace), the source of the per-run / per-step / per-model cost report.
 */

/** Tools the wired worker exposes (the validator's catalog). */
export const WIRED_TOOLS = ['read', 'edit', 'delete', 'listFiles', 'runVerify'] as const;

export interface WiringContext {
  root: string;
  /** The effective manifest: tecera.json with budgets narrowed to `budget`. Frozen. */
  manifest: Manifest;
  /** Hash of tecera.json as pinned (not of the effective manifest). */
  manifestHash: string;
  permissions: PermissionsDoc;
  /** Ledger behind the runtime's redaction boundary. */
  ledger: Ledger;
  runId: string;
  /** Approval session. Equal to runId so `tecera approve` finds it through the ledger. */
  sessionId: string;
  /** Environment after secret resolution (credentials removed). */
  env: Env;
  now: () => number;
  ids: () => string;
  /** Host verify runner (SAFE_ENV, process-group kill). Wiring may return a sandboxed one instead. */
  verifyRunner: VerifyRunner;
  /** Ledger-backed plan registry; the Loop matches accepted plans (and re-validates them) and stages generated ones. */
  library: PlanLibrary;
  goal: GoalSpec;
  budget: Budget;
  /** Resolved provider credentials. */
  secrets: SecretStore;
  /** The shared redactor (contracts). */
  redactor: Redactor;
  /** Present when the run is being resumed from the ledger (`tecera run --resume <runId>`). */
  resume?: { runId: string };
  /** Every secret the runtime redacts (credentials, approver key, canaries, credential-named env values). */
  secretInputs?: readonly SecretInput[];
  /** Scripted mode: directory with plan.json / replies.json (absolute, or relative to cwd). */
  scripted?: string;
  /** Directory scripted paths are relative to (the CLI cwd). */
  cwd?: string;
  signal?: AbortSignal;
}

/** Result of the preflight baseline check on the untouched worktree. */
export interface BaselineResult {
  exitCode: number | null;
  /** 'passed' | 'failed' | anything else (tooling, refused, mutated): the run must not proceed. */
  outcome: string;
  /** Why the baseline is unusable (tooling/refused/mutated); null when it ran. */
  problem: string | null;
  evidenceKey: string;
  durationMs?: number;
}

export interface WiredPorts {
  planner: Planner;
  worker: Worker;
  gates: GateRunner;
  /** Worker seats with a cost figure for the route reflex (cheapest allowed wins). */
  seats: SeatCost[];
  /** Escalation target when a reflex is unsure; normally the planner seat. */
  frontier?: Frontier;
  /** Decision-model reflex provider for seams set to `model` (Phase 2). */
  model?: Reflex;
  /** Override the default policy-backed plan validator (must stay goal-aware and at least as strict). */
  validator?: PlanValidator;
  /** Tool names the worker exposes; plan validation rejects anything else. */
  toolCatalog?: string[];
  /** Absolute path of the leased worktree every gate and worker step operates on. */
  worktree?: string;
  /** Current lease fencing token for repo writes. */
  fencingToken?: () => number | undefined;
  /** Sandboxed verify runner for the baseline check (default: the runtime's host runner). */
  verifyRunner?: VerifyRunner;
  /** Baseline check through the verify gate (records the ignored-file baseline the commit gate needs). */
  baseline?(signal?: AbortSignal): Promise<BaselineResult>;
  /** Lines for the operator (mode, isolation, worktree). Never secret-bearing. */
  notes?: string[];
  /** Aborted when the worktree lease is lost: the loop stops and aborts every running step. */
  leaseSignal?: AbortSignal;
  /**
   * The worker child has no OS isolation (recorded as isolation.degraded and on gate questions). It no longer
   * makes writes hold (D6): work-branch writes inside repo.allowedChanges proceed, fenced and logged.
   */
  isolationDegraded?: boolean;
  /** LoopPorts.worktreeCheckpoint: snapshot the leased worktree (`tree:<oid>`). */
  worktreeCheckpoint?: (a: { runId: string; intentionId: string; stepId: string; attempt: number; reason: 'baseline' | 'completed' | 'suspended' }) => Promise<string>;
  /** LoopPorts.worktreeChanges: files changed between two checkpoints of the leased worktree (paths and counts). */
  worktreeChanges?: (a: { runId: string; intentionId: string; stepId: string; from: string; to: string }) => Promise<WorktreeChange[]>;
  /** LoopPorts.stepChanges: every path changed between two checkpoints with its operation against the base, and the ignored files that differ from the run's baseline. */
  stepChanges?(a: { from: string; to: string }): Promise<PathChange[]>;
  /** Restore the leased worktree to a checkpoint ('base' or `tree:<oid>`), proven by a re-snapshot. */
  restoreWorktree?(checkpointId: string, signal?: AbortSignal): Promise<string>;
  /**
   * LoopPorts.prepareIntention: put the leased worktree on a later intention's own branch at the pinned base,
   * behind a durable preparation record (intent before anything moves, completion after). Idempotent.
   */
  prepareIntention?(a: IntentionPreparationRequest): Promise<IntentionPreparation>;
  /** Kill every process of a previous supervisor of this run (owner records + anything working in the worktree). */
  reapPrior?(): Promise<ReapResult>;
  /** Arm the durable run deadline (epoch ms): it aborts the run-wide signal every model call and gate runs under. */
  setDeadline?(deadlineMs: number): void;
  /** Run-wide cancellation: CLI interrupt, lease loss, durable deadline (when budgets are enforced). */
  runSignal?: AbortSignal;
  /** Model calls whose cost.call record could not be written (the cost report says it is incomplete). */
  costUnrecorded?(): number;
  /** LoopPorts.probe: probes the manifest's declared connections for real. */
  probe?: CapabilityProbe;
  /** LoopPorts.provisioner: creates resources in Tecera's own space inside manifest.provisioning. */
  provisioner?: Provisioner;
  /** LoopPorts.secrets: a value that carries a known secret (no resource locator may). */
  secrets?: (value: string) => boolean;
  /** Release every expired pending resource (run start, D12); lines for the operator. */
  sweep?(): Promise<string[]>;
  dispose?(): Promise<void>;
}

export type WireFn = (ctx: WiringContext) => Promise<WiredPorts>;

export const wireRunPorts: WireFn = (ctx) => createWiring()(ctx);

export { VERIFY_UID_ENV, VERIFY_GID_ENV, VERIFY_ALLOW_ROOT_ENV, verifyIdentity } from './containment.js';

// ---------- the wiring ----------

export interface WiringOptions {
  /** Override the worktrees root (default $TECERA_WORKTREES or ~/.tecera/worktrees). */
  worktreesRoot?: string;
  /** Override the provider transport for every seat (tests). Scripted mode takes precedence. */
  fetch?: FetchLike;
  /** Observe every scripted model request (exact outgoing bytes). */
  tap?: ScriptTap;
  /** Observe everything handed to a sandbox child: the exec request and every tool result. */
  childTap?: (kind: 'exec' | 'result', data: string) => void;
  /** Replace the sandboxed verify runner (tests on hosts without containment). */
  verifyRunner?: VerifyRunner;
  /** Lease TTL (default: the run's wall-clock budget + 5 min). */
  leaseTtlMs?: number;
  /** Per-call reservation for the reviewer and frontier seats (default SEAT_RESERVATION). */
  seatReservation?: SeatReservation;
  /**
   * Test seams of the edit tool (race tests: pause a call after its entry checks, before it publishes).
   * The runtime's own pre-commit fence (mutationCheck) is always installed and cannot be replaced.
   */
  editToolSeams?: { beforeOpen?: (r: { rel: string; abs: string }) => Promise<void>; afterRead?: (r: { rel: string; abs: string }) => Promise<void> };
  /** Commit-gate fault injection (crash/race tests only): passed to createGates unchanged. */
  commitTestHooks?: NonNullable<Parameters<typeof createGates>[0]['commitTestHooks']>;
  /** Fault injection for the intention-branch preparation (crash and fence tests only). */
  prepareTestHooks?: {
    /** After the intent record, before the first repository mutation. `loseLease` releases the worktree lease. */
    beforeMutation?: (c: { intentionId: string; branch: string; loseLease: () => Promise<void> }) => void | Promise<void>;
    /** After the worktree is on the new branch, before the completion record. */
    afterMutation?: (c: { intentionId: string; branch: string; loseLease: () => Promise<void> }) => void | Promise<void>;
  };
  /** gh binary for gate.pr (tests): undefined = look it up on the run environment's PATH, null = never use gh. */
  gh?: string | null;
  /** Verify identity override (tests); default from the operator env (verifyIdentity). */
  verifyIdentity?: { runAs?: { uid: number; gid: number }; allowRoot?: boolean };
}

/** Evidence kinds a worker writes that become `evidence.appended` events (so `why`/`evidence` find them). */
const SURFACED_EVIDENCE = new Set(['tool.denied', 'sandbox.violation', 'sandbox.kill', 'sandbox.ended', 'sandbox.outstanding']);

interface StepTrace {
  trace: Trace;
  /** Latest verify fingerprint (D1) per attempt of the step's intention, read from the ledger (progressCheck). */
  fps?: Map<number, string | null>;
  /** Current attempt of the step's intention. */
  attempt?: number;
  /** Candidate history of the step's intention (attempt, D1, worker execution), from its verify events. */
  history?: AttemptFingerprint[];
  /** The accepted acceptance contract of the step's goal (tamperCheck protects it and what its criteria run). */
  contract?: AcceptanceContract | null;
  /** The change-path envelope stated for the step (the contract's and the step's declared subset); null = none. */
  envelope?: StatedEnvelope | null;
}

/** Per-call reservation for the reviewer and frontier seats (settled at actual usage). */
export const SEAT_RESERVATION: SeatReservation = { ...DEFAULT_LLM_RESERVATION };

/**
 * The worker's ledger: every call delegates; evidence of the kinds above additionally appends an
 * `evidence.appended` event carrying the step trace (from the AsyncLocalStorage the worker wrapper sets) and
 * the evidence key. A failed append fails the evidence write (the worker treats it as a ledger failure).
 */
class SurfacingLedger implements Ledger {
  constructor(
    private readonly inner: Ledger,
    private readonly als: AsyncLocalStorage<StepTrace>,
    private readonly o: { runId: string; ids: () => string; now: () => number },
  ) {}
  append: Ledger['append'] = (e) => this.inner.append(e);
  events: Ledger['events'] = (f) => this.inner.events(f);
  verifyChain: Ledger['verifyChain'] = () => this.inner.verifyChain();
  getEvidence: Ledger['getEvidence'] = (k) => this.inner.getEvidence(k);
  listEvidence = async (runId: string, kindPrefix?: string): Promise<EvidenceRecord[]> => {
    if (typeof this.inner.listEvidence !== 'function') throw new LedgerError('ledger does not support evidence enumeration (listEvidence)', 'evidence');
    return kindPrefix === undefined ? this.inner.listEvidence(runId) : this.inner.listEvidence(runId, kindPrefix);
  };
  openBudget: Ledger['openBudget'] = (r, p, c, o) => (o === undefined ? this.inner.openBudget(r, p, c) : this.inner.openBudget(r, p, c, o));
  budgetUsage = async (runId: string): Promise<PoolUsage[]> => (typeof this.inner.budgetUsage === 'function' ? this.inner.budgetUsage(runId) : []);
  reserve: Ledger['reserve'] = (p, a, r, i) => this.inner.reserve(p, a, r, i);
  settle: Ledger['settle'] = (id, a) => this.inner.settle(id, a);
  lease: Ledger['lease'] = (r, h, t) => this.inner.lease(r, h, t);
  renew: Ledger['renew'] = (l, t) => this.inner.renew(l, t);
  release: Ledger['release'] = (l) => this.inner.release(l);
  requestApproval: Ledger['requestApproval'] = (r) => this.inner.requestApproval(r);
  approve: Ledger['approve'] = (r, a, s, at, audit) => (audit === undefined ? this.inner.approve(r, a, s, at) : this.inner.approve(r, a, s, at, audit));
  deny: Ledger['deny'] = (r, a, why, at) => this.inner.deny(r, a, why, at);
  consume: Ledger['consume'] = (r, h, s, i, at) => this.inner.consume(r, h, s, i, at);
  checkpoint: Ledger['checkpoint'] = (r, k, st) => this.inner.checkpoint(r, k, st);
  loadCheckpoint: Ledger['loadCheckpoint'] = (id) => this.inner.loadCheckpoint(id);
  getApproval: Ledger['getApproval'] = async (id) => {
    if (typeof this.inner.getApproval !== 'function') throw new LedgerError('ledger does not support approval lookup (getApproval)', 'approval');
    return this.inner.getApproval(id);
  };
  async evidence(e: { key: string; kind: string; runId: string; body: Json }): Promise<EvidenceRecord> {
    const rec = await this.inner.evidence(e);
    if (SURFACED_EVIDENCE.has(e.kind)) {
      const b = (e.body && typeof e.body === 'object' && !Array.isArray(e.body) ? e.body : {}) as Record<string, Json>;
      const summary: Record<string, Json> = { kind: e.kind, evidenceKey: e.key };
      for (const k of ['tool', 'method', 'path', 'reasons']) if (b[k] !== undefined) summary[k] = b[k]!;
      await this.inner.append(event('evidence.appended', { id: this.o.ids(), at: this.o.now(), actor: { kind: 'agent', id: 'worker' }, runId: this.o.runId, trace: this.als.getStore()?.trace ?? {}, payload: summary }));
    }
    return rec;
  }
}

/** Charge one completion against the run's usd/tokens pools (reserve + settle; over an ENFORCED cap throws). */
export async function chargeUsage(ledger: Ledger, runId: string, usage: LLMUsage, idemKey: string): Promise<void> {
  const tokens = Math.max(0, (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
  const usd = Math.max(0, usage.usd ?? 0);
  for (const [pool, amount] of [['usd', usd], ['tokens', tokens]] as const) {
    const r = await ledger.reserve(pool, amount, runId, `${idemKey}:${pool}`);
    await ledger.settle(r.id, amount);
  }
}

/** Was this run started in scripted mode? (`evidence.appended` {kind: 'run.scripted'} in its events.) */
async function runWasScripted(ledger: Ledger, runId: string): Promise<boolean> {
  for await (const e of ledger.events({ runId, kinds: ['evidence.appended'] })) if ((e.payload as { kind?: string }).kind === 'run.scripted') return true;
  return false;
}

/**
 * Candidate history of one intention from its verify.passed / verify.failed events: the latest fingerprint
 * per attempt (legacy progressCheck source) and every (attempt, fingerprint, worker execution) the loop
 * recorded (the kernel's progressHistory: only candidates of DIFFERENT worker executions are compared).
 */
export async function attemptFingerprints(ledger: Ledger, runId: string, intentionId: string): Promise<{ fps: Map<number, string | null>; history: AttemptFingerprint[] }> {
  const fps = new Map<number, string | null>();
  const history: AttemptFingerprint[] = [];
  for await (const e of ledger.events({ runId, kinds: ['verify.passed', 'verify.failed'] })) {
    if (e.trace.intentionId !== intentionId) continue;
    const p = e.payload as { attempt?: unknown; fingerprint?: unknown; workerExec?: unknown };
    if (typeof p.attempt !== 'number' || !Number.isInteger(p.attempt)) continue;
    const fp = typeof p.fingerprint === 'string' ? p.fingerprint : null;
    fps.set(p.attempt, fp);
    history.push({ attempt: p.attempt, fingerprint: fp, ...(typeof p.workerExec === 'number' || typeof p.workerExec === 'string' ? { exec: p.workerExec } : {}) });
  }
  return { fps, history };
}

/**
 * Bridge planner usage onto the loop's meter. The loop reserves before each planner call and settles at what
 * the meter recorded. A planner that records on the meter itself is authoritative; otherwise the usage it
 * reports through onUsage is recorded for it. Either way each call is counted once. A planner call made
 * outside the loop (no meter) is charged directly through `direct`.
 */
export class MeteredPlanner implements Planner {
  private readonly als = new AsyncLocalStorage<{ meter: UsageMeter; direct: number; reported: LLMUsage[] }>();
  /** Drafting of a statement's acceptance contract, metered like write; present only when the inner planner drafts. */
  readonly draftContract?: (statement: string, goal: AchievementGoal, inventory: readonly CapabilityRecord[], meter?: UsageMeter) => Promise<ContractDraft>;

  constructor(
    private readonly inner: Planner,
    private readonly direct: (u: LLMUsage, purpose: string) => Promise<void>,
  ) {
    const drafter = inner.draftContract?.bind(inner);
    if (drafter) this.draftContract = (statement, goal, inventory, meter) => this.bridged(meter, (m) => drafter(statement, goal, inventory, m));
  }

  /** The cancellation signal of the loop meter the current planner call runs under (deadline, loop stop). */
  readonly meterSignal = (): AbortSignal | undefined => this.als.getStore()?.meter.signal;

  /** The planner's onUsage sink. */
  readonly onUsage = async (u: { usage: LLMUsage; purpose: string }): Promise<void> => {
    const st = this.als.getStore();
    if (st) st.reported.push(u.usage);
    else await this.direct(u.usage, `planner.${u.purpose}`);
  };

  private async bridged<T>(meter: UsageMeter | undefined, call: (m: UsageMeter | undefined) => Promise<T>): Promise<T> {
    if (!meter) return call(undefined);
    const st = { meter, direct: 0, reported: [] as LLMUsage[] };
    const counting: UsageMeter = {
      record: (u) => {
        st.direct++;
        meter.record(u);
      },
      ...(meter.signal ? { signal: meter.signal } : {}),
    };
    try {
      return await this.als.run(st, () => call(counting));
    } finally {
      if (st.direct === 0) for (const u of st.reported) meter.record(u);
    }
  }

  write(e: TeceraEvent, beliefs: BeliefProjection, goal: AchievementGoal, meter?: UsageMeter, ctx?: PlanningContext): Promise<Plan> {
    return this.bridged(meter, (m) => (ctx === undefined ? this.inner.write(e, beliefs, goal, m) : this.inner.write(e, beliefs, goal, m, ctx)));
  }



  deliberate(options: Plan[], intentions: Intention[], beliefs: BeliefProjection, meter?: UsageMeter): Promise<Plan> {
    return this.bridged(meter, (m) => this.inner.deliberate(options, intentions, beliefs, m));
  }
}

/**
 * budget.exhausted (D3, informational): recorded once per (run, pool) when a soft pool passes its cap (the
 * loop records its own the same way). Never throws: a report that cannot be written changes nothing.
 */
export function exhaustionRecorder(ledger: Ledger, runId: string, o: { ids: () => string; now: () => number; enforce: boolean }): (e: BudgetExhaustion) => Promise<void> {
  const seen = new Set<string>();
  return async (e) => {
    if (o.enforce || seen.has(e.pool)) return;
    seen.add(e.pool);
    try {
      for await (const x of ledger.events({ runId, kinds: ['budget.exhausted'] })) if ((x.payload as { pool?: unknown }).pool === e.pool) return;
      await ledger.append(event('budget.exhausted', { id: o.ids(), at: o.now(), actor: { kind: 'system', id: 'budget' }, runId, trace: {}, payload: { pool: e.pool, used: e.used, cap: e.cap, amount: e.amount, purpose: e.purpose, enforced: false } }));
    } catch {
      /* informational */
    }
  };
}

/** Variables gh may see (gate.pr): its own config and token, proxies and certificates; never a model key. */
export const GH_ENV_KEYS = ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'] as const;

export function ghEnvOf(env: Env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of GH_ENV_KEYS) if (typeof env[k] === 'string') out[k] = env[k];
  return out;
}

/** The cost sink of a run: one cost.call event per completed model call (cost.ts). */
export function ledgerCostSink(ledger: Ledger, runId: string, o: { ids: () => string; now: () => number }): CostSink {
  return async (c, trace) => {
    await ledger.append(event('evidence.appended', { id: o.ids(), at: o.now(), actor: { kind: 'system', id: 'cost' }, runId, trace, payload: { kind: COST_KIND, ...c } }));
  };
}

/** The latest capability.missing of `id` in a run: the rung the loop resolved it to and the kind it recorded. */
function lastMissing(events: readonly TeceraEvent[], id: string): { resolution: string; kind?: string } | null {
  let out: { resolution: string; kind?: string } | null = null;
  for (const e of events) {
    if (e.kind !== 'capability.missing') continue;
    const p = e.payload as { capability?: { id?: unknown; kind?: unknown }; resolution?: unknown };
    if (p.capability?.id !== id || typeof p.resolution !== 'string') continue;
    out = { resolution: p.resolution, ...(typeof p.capability.kind === 'string' ? { kind: p.capability.kind } : {}) };
  }
  return out;
}

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The pending resources a run may hand its workers as tools: none at all while the registry reports a
 * problem or a resource past the allowance (a refusal, never a partial use of what is left).
 */
export function usableResources(reg: Pick<ResourceRegistry, 'pending' | 'problems' | 'overAllowance'>): ProvisionedResource[] {
  if (reg.problems.length || reg.overAllowance.length) return [];
  return reg.pending;
}

/**
 * The provisioned git remote a PR delivery may push to (null when none): a usable pending 'git-remote' whose
 * capability is a plain remote name and whose locator is an absolute local path (what the local provisioner
 * makes; never a URL, a network path or a git transport such as `ext::`). With `place`, the locator must also
 * lie under the provisioner's root and outside the repository (locatorWithin): a recorded resource pointing
 * into the business repository or elsewhere on the host never receives a push.
 */
export function pushableRemote(reg: Pick<ResourceRegistry, 'pending' | 'problems' | 'overAllowance'>, place?: { root: string; repoRoot: string }): ProvisionedResource | null {
  return (
    usableResources(reg).find(
      (x) => x.kind === 'git-remote' && REMOTE_NAME.test(x.capability) && /^\/(?!\/)/.test(x.locator) && !x.locator.includes('::') && (!place || locatorWithin(x.locator, place.root, place.repoRoot)),
    ) ?? null
  );
}

export function createWiring(o: WiringOptions = {}): WireFn {
  return async (ctx: WiringContext): Promise<WiredPorts> => {
    const m = ctx.manifest;
    const { ledger, runId, redactor } = ctx;
    const notes: string[] = [];
    const cleanups: Array<() => Promise<void>> = [];
    const dispose = async (): Promise<void> => {
      for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
    };
    // Run-wide cancellation: the CLI signal, lease loss and the durable run deadline (setDeadline) abort it;
    // every model call (all seats), every gate and the baseline run under it.
    const runCtl = new AbortController();
    const abortRun = (why: unknown): void => {
      if (!runCtl.signal.aborted) runCtl.abort(why instanceof Error ? why : new Error(String(why ?? 'run cancelled')));
    };
    const runSignal = (): AbortSignal => runCtl.signal;
    if (ctx.signal) {
      const ext = ctx.signal;
      if (ext.aborted) abortRun(ext.reason);
      else {
        const on = (): void => abortRun(ext.reason ?? 'run interrupted');
        ext.addEventListener('abort', on, { once: true });
        cleanups.push(async () => ext.removeEventListener('abort', on));
      }
    }
    let deadlineTimer: NodeJS.Timeout | null = null;
    cleanups.push(async () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    });
    try {
      // 1. scripted mode
      let scripts: ScriptSet | null = null;
      if (ctx.scripted) scripts = loadScripts(ctx.scripted, ctx.cwd ?? ctx.root);
      if (ctx.resume) {
        const was = await runWasScripted(ledger, runId);
        if (was !== !!scripts) throw new WiringError(was ? `run ${runId} was scripted; resume it with --scripted` : `run ${runId} was live; it cannot be resumed in scripted mode`);
      }
      const secretInputs: SecretInput[] = [...(ctx.secretInputs ?? ctx.secrets.canaryValues().map((value) => ({ kind: 'credential', value })))];
      const secretValues = secretInputs.map((s) => (typeof s === 'string' ? s : s.value));

      // 2. providers, one per seat (D7: anthropic / openai / openrouter keys from the environment, kinds and
      //    base URLs from providerSetup), each reporting its completed calls to the run's cost record
      const setup = providerSetup(m);
      const costSink = ledgerCostSink(ledger, runId, { ids: ctx.ids, now: ctx.now });
      let unrecorded = 0;
      const als = new AsyncLocalStorage<StepTrace>();
      const fetchFor = (seat: string): FetchLike | undefined => (scripts ? scriptedFetch(seat, 'auto', scripts.replies[seat] ?? [], o.tap) : o.fetch);
      const raw = (seatId: string, seat: { provider: string; model: string; effort?: string }): LLM => {
        try {
          const f = fetchFor(seatId);
          return withIdentity(createProvider(seat as Parameters<typeof createProvider>[0], ctx.secrets, providerOptions(setup, { redactor, ...(f ? { fetch: f } : {}) })), setup, seat.provider);
        } catch (e) {
          throw new WiringError(`seat ${seatId} (${seat.provider}/${seat.model}): ${(e as Error).message}`);
        }
      };
      const costed = (llm: LLM, seatId: string, provider: string): LLM =>
        costRecordingLLM(llm, { seat: seatId, provider, sink: costSink, trace: () => als.getStore()?.trace, onUnrecorded: () => void unrecorded++ });
      const make = (seatId: string, seat: { provider: string; model: string; effort?: string }): LLM => costed(raw(seatId, seat), seatId, seat.provider);
      // The frontier is the planner seat (same provider instance, same scripted replies), reported as 'frontier'.
      const plannerRaw = raw('planner', m.seats.planner);
      const plannerLLM = costed(plannerRaw, 'planner', m.seats.planner.provider);
      const frontierLLM = costed(plannerRaw, 'frontier', m.seats.planner.provider);
      const workerLLMs: Record<string, LLM> = {};
      // Worker seats are metered by the worker's span reservations (calls/usd/tokens per LLMQuery); here they
      // only gain the run-wide cancellation (deadline, lease loss) on top of the step signal.
      for (const w of m.seats.workers) workerLLMs[w.id] = cancellableLLM(make(w.id, w), runSignal);
      const reviewerLLM = make('reviewer', m.seats.reviewer);
      const onExhausted = exhaustionRecorder(ledger, runId, { ids: ctx.ids, now: ctx.now, enforce: m.budgets.enforce });

      // 3. worktree lease
      const ttlMs = o.leaseTtlMs ?? m.budgets.wallClockSec * 1000 + 5 * 60_000;
      const wtRoot = o.worktreesRoot ?? worktreesRoot(ctx.env);
      const wt: LeasedWorktree = await leaseWorktree({
        root: ctx.root,
        runId,
        base: m.repo.base,
        ledger,
        worktreesRoot: wtRoot,
        resume: !!ctx.resume,
        ttlMs,
        holder: `run:${runId}:${process.pid}:${randomUUID().slice(0, 8)}`,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      cleanups.push(() => wt.release());
      if (wt.lost.aborted) abortRun(wt.lost.reason);
      else {
        const onLeaseLost = (): void => abortRun(wt.lost.reason);
        wt.lost.addEventListener('abort', onLeaseLost, { once: true });
        cleanups.push(async () => wt.lost.removeEventListener('abort', onLeaseLost));
      }
      // Process ownership (S2 restart reaps a dead supervisor's processes): this supervisor and its
      // descendants are recorded outside the worktree for as long as the run lives here.
      const ownerFile = ownerFilePath(wtRoot, runId);
      const recorder = new OwnershipRecorder(ownerFile, ctx.now);
      try {
        recorder.start();
        cleanups.push(async () => recorder.stop());
      } catch (e) {
        notes.push(`ownership  not recorded (${(e as Error).message}); a restart of this run will refuse to proceed without proof the old writers stopped`);
      }
      notes.push(`worktree   ${wt.path} (${wt.git ? `git worktree at ${m.repo.base}@${wt.baseSha.slice(0, 7)}` : 'private copy: the business case is not a git repository'}) · lease token ${wt.fencingToken() ?? '-'}`);

      // 4. verify runner: owned process tree, scrubbed env, no network, never as root unless the operator
      //    names an unprivileged identity or explicitly accepts a degraded root verify (recorded).
      let verifyRunner: VerifyRunner;
      let verifyDegraded: string | null = null;
      if (o.verifyRunner) verifyRunner = o.verifyRunner;
      else {
        // The same admission as `tecera preflight` and `tecera gate` (containment.ts): no host-shell fallback.
        try {
          const a = admitVerify(ctx.env, redactor, o);
          verifyRunner = a.runner;
          verifyDegraded = a.degraded;
        } catch (e) {
          if (e instanceof VerifyContainmentError) throw new WiringError(e.message);
          throw e;
        }
      }

      // run markers (evidence + events so `tecera evidence` exports them)
      const mark = async (kind: string, body: Json): Promise<void> => {
        const key = `${kind}:${runId}:${randomUUID().slice(0, 8)}`;
        await ledger.evidence({ key, kind, runId, body });
        await ledger.append(event('evidence.appended', { id: ctx.ids(), at: ctx.now(), actor: { kind: 'system', id: 'wiring' }, runId, trace: {}, payload: { kind, evidenceKey: key } }));
      };
      if (verifyDegraded) {
        await mark('verify.degraded', { reason: verifyDegraded, allowedBy: ctx.env[VERIFY_ALLOW_ROOT_ENV] === '1' ? `env:${VERIFY_ALLOW_ROOT_ENV}` : null });
        notes.push(`verify     degraded: ${verifyDegraded}`);
      }
      if (!ctx.resume) {
        if (scripts) await mark('run.scripted', { dir: scripts.dir, seats: Object.keys(scripts.replies), plan: scripts.plan?.id ?? null, note: 'provider transport replaced by scripted replies; no network, no model' });
        await mark(wt.git ? 'worktree.leased' : 'worktree.no-git', { path: wt.path, base: m.repo.base, baseSha: wt.baseSha, git: wt.git, ...(wt.git ? {} : { note: 'the business case is not a git repository: the worktree is a private copy and the commit lands there' }) });
      }
      if (scripts) notes.push(`scripted   replies from ${scripts.dir} (no network, no model)`);

      // 11. the repository as the planner and the workers may rely on it (read once, from the leased worktree)
      let repoFactsCache: RepoFacts | null = null;
      const facts = (): RepoFacts => (repoFactsCache ??= repositoryFacts(wt.path));

      // 10. capabilities (D9, D10, D12). The run's events are read fresh for every decision below.
      const secrets = (v: string): boolean => redactor.containsSecret(v) !== null;
      const allowance = allowanceOf(m);
      const runEvents = async (rid = runId): Promise<TeceraEvent[]> => {
        const evs: TeceraEvent[] = [];
        for await (const e of ledger.events({ runId: rid })) evs.push(e);
        return evs;
      };
      // Probes run in the worktree through the contained verify runner (no network, scrubbed env, reaped tree).
      const probe = new ConnectionProbe({ connections: m.connections, runner: verifyRunner, cwd: wt.path, envAllowlist: [...m.sandbox.envAllowlist], authResolves: storeAuthResolver(ctx.env, ctx.root), redactor, signal: runCtl.signal });
      // A provisioned sqlite / http-stub is a brokered tool named after its capability; its locator reaches a
      // step only as data in capabilityAccess (the step's file tools stay inside the worktree).
      const workerTools: Tool[] = [];
      const toolOf = new Set<string>();
      const addResourceTool = (r: ProvisionedResource): void => {
        if ((r.kind !== 'sqlite' && r.kind !== 'http-stub') || toolOf.has(r.capability)) return;
        try {
          workerTools.push(...resourceTools([r]));
          toolOf.add(r.capability);
        } catch (e) {
          notes.push(`resource   ${r.id} (${r.kind}) is not usable as a tool: ${(e as Error).message}`);
        }
      };
      let local: LocalProvisioner | null = null;
      try {
        const reg = resourceRegistryOf(await runEvents(), { runId, allowance, secrets });
        const ident = o.verifyIdentity ?? verifyIdentity(ctx.env);
        const asRoot = typeof process.geteuid === 'function' && process.geteuid() === 0;
        local = new LocalProvisioner({
          root: resourcesRoot(ctx.env),
          repoRoot: ctx.root,
          allowance,
          runId,
          provisionedSoFar: reg.resources.length,
          // tmpdir and sqlite payloads are handed to the verify identity (only root can chown).
          ...(ident.runAs && asRoot ? { share: ident.runAs } : {}),
          secrets,
          now: ctx.now,
        });
        for (const r of usableResources(reg)) addResourceTool(r);
      } catch (e) {
        notes.push(`provision  unavailable: ${(e as Error).message}`);
      }
      const provisioner: Provisioner | undefined = local
        ? {
            kinds: () => local!.kinds(),
            provision: async (need) => {
              const r = await local!.provision(need);
              addResourceTool(r);
              return r;
            },
            release: (id) => local!.release(id),
            list: () => local!.list(),
          }
        : undefined;
      /**
       * Stand-ins for every worker step (D10 mock rung): each capability the run's gap ladder resolved to 'mock'
       * (capability.missing) or a stand-in already serves, plus any the plan names, whose kind has a generic
       * stand-in (a store or a message sink). The plan's tool lists do not decide it: the step gets the
       * stand-in's tool (withStandIns). Never for an available or provisioned capability (the broker admits
       * each one again against the inventory), never under a name a wired tool already has.
       */
      const mockDeclarations = async (req: WorkerStepRequest, evs: readonly TeceraEvent[]): Promise<MockToolDeclaration[]> => {
        const resolved = evs.filter((e) => e.kind === 'capability.missing' || e.kind === 'capability.mocked').map((e) => {
          const c = (e.payload as { capability?: unknown }).capability;
          return typeof c === 'string' ? c : typeof (c as { id?: unknown } | undefined)?.id === 'string' ? (c as { id: string }).id : '';
        });
        const wanted = [...new Set([...(req.plan.capabilities ?? []), ...resolved])].filter((c) => c && !toolOf.has(c) && !(WIRED_TOOLS as readonly string[]).includes(c));
        if (!wanted.length) return [];
        const inv = capabilityInventoryOf(evs, { runId, allowance, secrets });
        const out: MockToolDeclaration[] = [];
        for (const id of wanted) {
          const rec = inv.byId[id];
          if (rec?.state === 'available' || rec?.state === 'provisioned') continue;
          const last = lastMissing(evs, id);
          if (rec?.state !== 'mocked' && last?.resolution !== 'mock') continue;
          const kind = m.connections[id]?.kind ?? last?.kind ?? rec?.kind ?? 'unknown';
          const methods = STORE_KINDS.includes(kind) ? STORE_METHODS : MESSAGE_KINDS.includes(kind) ? MESSAGE_METHODS : null;
          if (!methods) {
            notes.push(`mock       no generic stand-in for ${id} (kind ${kind}); the step runs without it`);
            continue;
          }
          out.push({ capability: id, kind, tool: id, methods: [...methods], schema: {}, mockId: `mock_${id}`, reason: 'missing, not provisionable within the allowance, mockable: the gap ladder resolved it to a stand-in' });
        }
        return out;
      };
      const onMocked = async (rid: string, p: CapabilityMockedPayload): Promise<void> => {
        const goalId = als.getStore()?.trace.goalId;
        await ledger.append(event('capability.mocked', { id: ctx.ids(), at: ctx.now(), actor: { kind: 'system', id: 'broker' }, runId: rid, trace: goalId ? { goalId } : {}, payload: payloadOf('capability.mocked', p) }));
      };
      /**
       * Before a verify under a contract: a criterion requiring a capability the gap ladder resolved to 'mock'
       * (mockable, not available or provisioned) that no step's stand-in recorded yet can only be proven against
       * the code's own fake. It is recorded as mocked now (the goal is then provisional, never achieved) instead
       * of being refused as missing; a capability resolved to anything else stays missing.
       */
      const recordCriterionMocks = async (g: GateContext): Promise<void> => {
        const ids = [...new Set((g.contract?.criteria ?? []).flatMap((k) => k.requires ?? []))];
        if (!ids.length) return;
        const evs = await runEvents();
        const inv = capabilityInventoryOf(evs, { runId, allowance, secrets });
        for (const id of ids) {
          const state = inv.byId[id]?.state;
          if (state === 'available' || state === 'provisioned' || state === 'mocked') continue;
          const last = lastMissing(evs, id);
          if (last?.resolution !== 'mock' || m.connections[id]?.mockable === false) continue;
          const kind = m.connections[id]?.kind ?? last.kind ?? 'unknown';
          const p: CapabilityMockedPayload = { capability: id, kind, tool: id, mockId: `mock_${id}`, reason: 'missing and resolved to a stand-in; no step called it, so the criteria requiring it rest on the code\'s own fake' };
          await ledger.append(event('capability.mocked', { id: ctx.ids(), at: ctx.now(), actor: { kind: 'system', id: 'broker' }, runId, trace: { goalId: g.goal.id }, payload: payloadOf('capability.mocked', p) }));
        }
      };

      // Lease loss revokes authority in this process: every live sandbox child is disposed (its writes
      // stop), the loop stops on leaseSignal, and the guards below refuse every further tool write and gate.
      const liveRepls = new Set<Repl>();
      const onLost = (): void => {
        for (const r of [...liveRepls]) void Promise.resolve(r.dispose()).catch(() => undefined);
        liveRepls.clear();
      };
      if (wt.lost.aborted) onLost();
      else wt.lost.addEventListener('abort', onLost, { once: true });
      cleanups.push(async () => wt.lost.removeEventListener('abort', onLost));
      const leaseReason = (): string => {
        const r = wt.lost.reason as Error | undefined;
        return r?.message ?? 'worktree lease lost';
      };

      // 5. worker
      // The package scripts a criterion runs, as they are on the run's base (the base commit, or the business
      // case itself when the worktree is a private copy): never the worktree a worker writes.
      const baseScriptCache = new Map<string, Record<string, string>>();
      const baseScriptsOfDir = (d: string): Record<string, string> => {
        const hit = baseScriptCache.get(d);
        if (hit) return hit;
        const rel = d ? `${d}/package.json` : 'package.json';
        let text = '';
        if (wt.git) {
          const r = gitSync(wt.path, ['cat-file', 'blob', `${wt.baseSha}:${rel}`], { env: ctx.env });
          text = r.code === 0 ? r.stdout : '';
        } else {
          try {
            text = readFileSync(join(ctx.root, rel), 'utf8');
          } catch {
            text = '';
          }
        }
        const scripts = packageScriptsOf(text);
        baseScriptCache.set(d, scripts);
        return scripts;
      };
      const basePackageScripts = (contract: AcceptanceContract): PackageScripts => {
        const out: Record<string, Record<string, string>> = {};
        for (let round = 0; round < 4; round++) {
          const missing = criterionScriptDirs(contract, out).filter((d) => !(d in out));
          if (!missing.length) break;
          for (const d of missing) out[d] = baseScriptsOfDir(d);
        }
        return out;
      };
      const hooks = mandatoryHooks(m, {
        permissions: ctx.permissions,
        secretValues,
        // progressCheck: the candidates THIS step's intention produced (attempt, D1, worker execution), from
        // the loop's verify events; only candidates of different worker executions are compared (ADV-8).
        progressHistory: () => als.getStore()?.history ?? [],
        fingerprintOf: (attempt) => als.getStore()?.fps?.get(attempt) ?? null,
        attempt: () => als.getStore()?.attempt ?? 1,
        // Under a contract, a worker write to the goal file, to a file a criterion's check runs, or to a script
        // a criterion runs is refused at the tool call (D8).
        contract: () => als.getStore()?.contract ?? null,
        packageScripts: basePackageScripts,
      });
      try {
        assertMandatory(hooks, m);
      } catch (e) {
        throw new WiringError((e as Error).message, 8);
      }
      const workerLedger = new SurfacingLedger(ledger, als, { runId, ids: ctx.ids, now: ctx.now });
      const sandbox = { profile: m.sandbox.profile, isolation: m.sandbox.isolation, network: false as const, memoryMb: m.sandbox.memoryMb, execTimeoutSec: m.sandbox.execTimeoutSec, envAllowlist: [...m.sandbox.envAllowlist] };
      let evSeq = 0;
      const replFactory: ReplFactory = (r) => {
        if (wt.lost.aborted) throw new WiringError(`sandbox refused: ${leaseReason()}`, 9);
        const inner: Repl = new ChildProcessRepl({
          runId: r.runId,
          sandbox,
          capabilities: r.capabilities,
          onInvoke: r.callbacks.onInvoke,
          onCheckpoint: r.callbacks.onCheckpoint,
          onEvidence: async (ev) => {
            await workerLedger.evidence({ key: `sandbox:${runId}:${r.invokeId}:e${r.execNo}:${ev.kind}:${++evSeq}`, kind: ev.kind, runId, body: ev.body });
          },
          redactor,
        });
        liveRepls.add(inner);
        const tap = o.childTap;
        const repl: Repl = {
          exec: async (req: ExecRequest, bridge, signal) => {
            if (wt.lost.aborted) throw new Error(`exec refused: ${leaseReason()}`);
            const merged = signal ? AbortSignal.any([signal, wt.lost]) : wt.lost;
            setImmediate(() => recorder.sample());
            if (!tap) return inner.exec(req, bridge, merged);
            tap('exec', JSON.stringify(req));
            const tapped: typeof bridge = async (...args) => {
              const res = await (bridge as (...a: unknown[]) => ReturnType<typeof bridge>)(...args);
              tap('result', JSON.stringify(res));
              return res;
            };
            return inner.exec(req, tapped, merged);
          },
          dispose: async () => {
            liveRepls.delete(inner);
            await inner.dispose();
          },
        };
        return repl;
      };
      // The change-path envelope at the tool call: a write or a deletion of a path outside the step's declared
      // subset of the accepted envelope is refused before anything is touched. Operations are relative to
      // the base commit (a path the base lacks is created; removing such a path is no change at all).
      let baseFiles: Set<string> | null = null;
      const inBase = (rel: string): boolean => {
        if (!baseFiles) {
          const r = gitSync(wt.path, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', wt.baseSha], { env: ctx.env });
          if (r.code !== 0) throw new Error('the base tree could not be listed; the change-path envelope cannot be checked');
          baseFiles = new Set(r.stdout.split('\0').filter((p) => p.length > 0));
        }
        return baseFiles.has(rel);
      };
      const authorizeChange: ChangeAuthorizer = (rel, kind) => {
        const env = als.getStore()?.envelope;
        if (!env) return;
        const present = inBase(rel);
        if (kind === 'delete' && !present) return;
        const op = kind === 'delete' ? 'delete' : present ? 'modify' : 'create';
        if (!statedAllows(env, rel, op)) throw new Error(`${rel} (${op}) is outside ${env.source === 'step' ? 'the change paths this step declared' : 'the accepted change-path envelope'}; only an amended contract can add a path`);
      };
      workerTools.unshift(
        createReadTool(),
        fencedTool(createEditTool({ ...(o.editToolSeams ?? {}), beforeCommit: mutationCheck(wt), authorizeChange }), wt),
        fencedTool(createDeleteTool({ beforeCommit: mutationCheck(wt), authorizeChange }), wt),
        createListFilesTool(),
      );
      const stepWorker = new StepWorker({
        seats: workerLLMs,
        repl: replFactory,
        // Write-class tools re-prove the lease on the ledger at entry (a copied token is not enough), run with
        // the step's lease-composed WriteGuard (third argument, ctx.fence), and the edit tool re-checks that
        // guard synchronously right before it publishes a write (after every await of the call).
        tools: workerTools,
        hooks,
        ledger: workerLedger,
        // The worker's runVerify runs repository code in the worktree: it re-proves the lease per run too.
        verifyRunner: fencedVerifyRunner(verifyRunner, wt),
        resumeLease: (rid) => (rid === runId && !wt.lost.aborted ? { worktree: wt.path, ...(wt.fencingToken() !== undefined ? { fencingToken: wt.fencingToken()! } : {}) } : undefined),
        sessionId: ctx.sessionId,
        secrets: secretInputs,
        envAllowlist: scrubbedAllowlist(m),
        now: ctx.now,
        // Stand-ins are admitted against this run's inventory (manifest allowance, secrets) and connections.
        inventory: async (rid) => capabilityInventoryOf(await runEvents(rid), { runId: rid, allowance, secrets }).records,
        connections: m.connections,
        onMocked,
      });
      const brain = await Brain.load(ledger, { runId, budgetTokens: m.memory.contextBudgetTokens, now: ctx.now });
      const leaseAborted = (rid: string, why: string): Outcome => ({ kind: 'aborted', reasons: [{ code: 'cancelled', reason: why, hookId: 'runtime.lease' }], run: { runId: rid, invokeId: 'lease-lost', depth: 0 } });
      /**
       * A worker aborted by its budget hook spent the run's (or the step's) pool: a retry cannot succeed and
       * must not ask for another approval. Surface it as LedgerError('budget') so the loop fails the step
       * terminally with failure 'budget' (exit 7) instead of retrying.
       */
      const budgetTerminal = (out: Outcome): Outcome => {
        if (out.kind === 'aborted' && out.reasons.some((r) => r.code === 'budget')) {
          throw new LedgerError(`worker budget exhausted: ${out.reasons.filter((r) => r.code === 'budget').map((r) => r.reason).join('; ')}`, 'budget');
        }
        return out;
      };
      // The worker port takes the guard as resume's 4th argument (contracts); call it through that signature.
      const resumeStep = stepWorker.resume.bind(stepWorker) as Worker['resume'];
      /**
       * The contract of `goalId` in this run, accepted or awaiting sign-off (null = none). A resumed step names no goal: the run's
       * only goal under a contract is used, and with several none is guessed (the commit gate still refuses a
       * criterion target the contract protects).
       */
      const acceptedContractFor = async (goalId: string | null): Promise<AcceptanceContract | null> => {
        const evs = await runEvents();
        const ids = goalId ? [goalId] : [...new Set(evs.filter((e) => e.kind === 'goal.adopted' && e.trace.goalId).map((e) => e.trace.goalId!))];
        const found = ids.map((g) => {
          const v = acceptedContractOf(evs, g, { runId });
          return v.accepted?.contract ?? v.contract ?? null;
        }).filter((c): c is AcceptanceContract => c !== null);
        return found.length === 1 ? found[0]! : null;
      };
      const worker: Worker = {
        run: async (req: WorkerStepRequest, signal?: AbortSignal): Promise<Outcome> => {
          if (wt.lost.aborted) return leaseAborted(req.runId, leaseReason());
          // The token the loop dispatched with must be the live one (a stale copy never starts a step).
          if (req.fencingToken !== undefined && req.fencingToken !== wt.fencingToken()) return leaseAborted(req.runId, `stale fencing token ${req.fencingToken}`);
          // The loop's step guard AND the live lease: every tool mutation of this step checks both.
          const guard: WriteGuard = leaseGuard(wt, req.guard);
          // Brain context (graduated lessons, episodes) joins the loop's inputs; it never replaces them.
          const extra = brain.assembleContext({ query: `${req.goal.statement}\n${req.step.instruction ?? ''}` }).inputs;
          const trace: Trace = { goalId: req.goal.id, intentionId: req.intention.id, planId: req.plan.id, stepId: req.step.id };
          const { fps, history } = await attemptFingerprints(ledger, runId, req.intention.id);
          const merged = AbortSignal.any([...(signal ? [signal] : []), guard.signal]);
          const evs = await runEvents();
          const extraMocks = await mockDeclarations(req, evs);
          const mocks = [...(req.mocks ?? []), ...extraMocks.filter((d) => !(req.mocks ?? []).some((x) => x.capability === d.capability))];
          const contract = await acceptedContractFor(req.goal.id);
          // What the step may reach beyond the repository, and what it may import (host data, never the model's).
          const reg = resourceRegistryOf(evs, { runId, allowance, secrets });
          const wanted = new Set([...(req.plan.capabilities ?? []), ...(contract?.criteria ?? []).flatMap((k) => k.requires ?? [])]);
          const access = capabilityAccess({ mocks, resources: usableResources(reg), wanted, tools: toolOf, inventory: capabilityInventoryOf(evs, { runId, allowance, secrets }).records });
          const host = { runtimeEnvironment: hostBinding('runtime:environment', runtimeEnvironment(facts())), ...(access.length ? { capabilityAccess: hostBinding('runtime:capabilities', access) } : {}) };
          const inputs = { ...extra, ...host, ...(req.inputs ?? {}) };
          const served = withStandIns(req, mocks.map((d) => d.tool));
          const envelope = statedEnvelope(contract, req.step);
          return budgetTerminal(await als.run({ trace, fps, history, attempt: req.intention.attempt, contract, envelope }, () => stepGuards.run({ guard }, () => stepWorker.run({ ...served, inputs, guard, ...(mocks.length ? { mocks } : {}) }, merged))));
        },
        resume: async (token: string, grant: ApprovalGrant, signal?: AbortSignal, given?: WriteGuard): Promise<Outcome> => {
          if (wt.lost.aborted) return leaseAborted(runId, leaseReason());
          const guard: WriteGuard = leaseGuard(wt, given);
          const merged = AbortSignal.any([...(signal ? [signal] : []), guard.signal]);
          const contract = await acceptedContractFor(null);
          return budgetTerminal(await als.run({ trace: {}, contract, envelope: statedEnvelope(contract, null) }, () => stepGuards.run({ guard }, () => resumeStep(token, grant, merged, guard))));
        },
      };

      // 6. gates (the reviewer seat is metered: reserve before, settle after every call)
      const reviewerMeter = new SeatMeter({ ledger, runId, seat: 'reviewer', reservation: o.seatReservation ?? SEAT_RESERVATION, signal: runSignal, onExhausted });
      let gates: Gates;
      let prOptions: ConstructorParameters<typeof PrGate>[0] | null = null;
      try {
        const gateOptions = {
          manifest: m,
          ledger,
          verifyRunner,
          reviewer: meteredLLM(reviewerLLM, reviewerMeter, 'review'),
          // the reviewer is metered here (SeatMeter); gate-side accounting off, so a review is charged once
          reviewReservation: null,
          writers: [plannerLLM, ...Object.values(workerLLMs)],
          worktree: wt.path,
          redactor,
          sessionId: ctx.sessionId,
          now: ctx.now,
          // gate.pr (D6): the patch bundle goes under the business case's .tecera/runs/<run>/pr/; gh is looked
          // up on the run environment's PATH and sees only its own variables (never a model key).
          runsDir: join(ctx.root, '.tecera', 'runs'),
          ...(o.gh !== undefined ? { gh: o.gh } : {}),
          ghEnv: ghEnvOf(ctx.env),
          costLine: async (rid: string): Promise<string | null> => {
            const evs: TeceraEvent[] = [];
            for await (const e of ledger.events({ runId: rid })) evs.push(e);
            const pools = typeof ledger.budgetUsage === 'function' ? await ledger.budgetUsage(rid).catch(() => []) : [];
            return costLine(costReport(evs, pools)).replace(/^cost\s+/, '');
          },
          ...(o.commitTestHooks ? { commitTestHooks: o.commitTestHooks } : {}),
        };
        gates = createGates(gateOptions as Parameters<typeof createGates>[0]);
        prOptions = { ledger, manifest: m, worktree: wt.path, sessionId: ctx.sessionId, redactor, now: ctx.now, ids: ctx.ids, runsDir: gateOptions.runsDir, ...(o.gh !== undefined ? { gh: o.gh } : {}), ghEnv: gateOptions.ghEnv, costLine: gateOptions.costLine };
      } catch (e) {
        throw new WiringError(`review seat: ${(e as Error).message}`, 8);
      }

      // 7. planner (the loop meters every call; usage reports are bridged onto its meter)
      let charges = 0;
      const charge = async (usage: LLMUsage, purpose: string): Promise<void> => chargeUsage(ledger, runId, usage, `${purpose}:${runId}:${++charges}:${randomUUID().slice(0, 8)}`);
      const workerSeats = m.seats.workers.map((w) => ({ id: w.id, provider: w.provider, model: w.model, costPerMTok: priceFor(w.model).inputPerM }));
      let bridge: MeteredPlanner | null = null;
      const innerPlanner: Planner = scripts?.plan
        ? new ScriptedRunPlanner(scripts.plan, { ...(scripts.contracts ? { contracts: scripts.contracts } : {}), connections: m.connections, allowedChanges: m.repo.allowedChanges, protectedPaths: m.policy.protectedPaths, fileExists: repoFileView(wt.path) })
        : new LLMPlanner({
            // every planner call is cancelled by the loop meter's signal (deadline, loop stop) and the run's
            llm: cancellableLLM(plannerLLM, runSignal, () => bridge?.meterSignal()),
            manifest: m,
            permissions: ctx.permissions,
            toolCatalog: WIRED_TOOLS,
            redactor,
            seats: workerSeats,
            // read-only: a drafted criterion may only run a file the leased worktree already holds, and only
            // import a package its package.json lists
            repoFiles: repoFileView(wt.path),
            repoFacts: facts,
            onDraftRejected: async (r) => {
              const key = `criteria.rejected:${runId}:${randomUUID().slice(0, 8)}`;
              await ledger.evidence({ key, kind: 'criteria.rejected', runId, body: { goalId: r.goalId, attempt: r.attempt, issues: r.issues, contract: r.contract } });
              await ledger.append(event('evidence.appended', { id: ctx.ids(), at: ctx.now(), actor: { kind: 'system', id: 'planner' }, runId, trace: { goalId: r.goalId }, payload: { kind: 'criteria.rejected', evidenceKey: key, rejected: true, attempt: r.attempt, issues: r.issues } }));
            },
            lessons: (goal) => brain.recall({ query: goal.statement, tiers: ['semantic'], k: 8 }).map((r) => ({ src: `lesson:${r.entry.id}`, text: r.entry.content })),
            onUsage: async (u) => {
              if (!bridge) throw new LedgerError('planner usage reported before accounting was wired', 'budget');
              await bridge.onUsage(u);
            },
            onDeliberation: async (d) => {
              await ledger.evidence({ key: `deliberation:${runId}:${randomUUID().slice(0, 8)}`, kind: 'planner.deliberation', runId, body: { planId: d.planId, reason: d.reason, fallback: d.fallback } });
            },
            signal: runCtl.signal,
          });
      bridge = new MeteredPlanner(innerPlanner, charge);
      const planner: Planner = bridge;

      // 8. validator, 9. route costs and frontier (metered on the run's pools; exhaustion propagates)
      // Under a contract the capabilities its criteria require may be tools too (a provisioned resource or a
      // stand-in, served by the broker under the capability's name); the broker still refuses one it cannot serve.
      const validatorFor = (catalog: readonly string[]): PlanValidator => createPlanValidator({ permissions: ctx.permissions, toolCatalog: catalog, workerSeats: m.seats.workers.map((w) => w.id), redactor });
      const baseValidator = validatorFor(WIRED_TOOLS);
      const validator: PlanValidator = {
        validatePlan: (plan, man, goal, pctx) => {
          if (!pctx) return baseValidator.validatePlan(plan, man, goal);
          const caps = [...new Set((pctx.contract?.criteria ?? []).flatMap((k) => k.requires ?? []))];
          return (caps.length ? validatorFor([...WIRED_TOOLS, ...caps]) : baseValidator).validatePlan(plan, man, goal, pctx);
        },
      };
      const seats: SeatCost[] = workerSeats.map((w) => ({ seatId: w.id, costPerMTok: w.costPerMTok }));
      const frontierMeter = new SeatMeter({ ledger, runId, seat: 'frontier', reservation: o.seatReservation ?? SEAT_RESERVATION, signal: runSignal, onExhausted });
      const frontier = new ModelFrontier({ llm: frontierLLM, model: m.seats.planner.model, redactor, meter: frontierMeter, signal: runSignal });

      // A degraded verify (root identity) runs repository code with the supervisor's uid: the run is recorded as
      // degraded too. D6: degradation is recorded, never a hold — work-branch writes inside allowedChanges
      // proceed (fenced, protected paths and tamper rules apply); the PR is the approval point.
      const isolationDegraded = m.sandbox.isolation === 'node' || verifyDegraded !== null;
      if (isolationDegraded) notes.push('isolation  node: the worker child has no OS isolation beyond what the host provides (recorded as isolation.degraded); writes to the work branch proceed fenced, the PR gate is the approval point');

      // The commit branch is `<branchPrefix><goal name>` (dx.md: tecera/fix-failing-test). The gates derive it
      // from GateContext.goal.id, which is also the id they look the goal up by on the ledger (verify.passed,
      // the accepted contract, resources), so the goal id IS the name (goals.ts). A run adopted before that
      // (`g_<name>` on the ledger) still commits to the named branch.
      const goalName = ctx.goal.id;
      const forCommit = (g: GateContext): GateContext => (g.goal.id === ctx.goal.goalId ? { ...g, goal: { ...g.goal, id: goalName } } : g);
      const gateTrace = (g: GateContext): Trace => ({ goalId: g.goal.id, intentionId: g.intention.id, planId: g.plan.id, stepId: g.step.id });
      /**
       * Re-prove the lease before a gate starts; the gate runs with the lease composed into its WriteGuard
       * (the commit gate checks it before every git mutation) and the lease + run signals merged into its own.
       */
      const leased = async (g: GateContext): Promise<{ ok: true; ctx: GateContext } | { ok: false; reason: string }> => {
        try {
          await wt.assertHeld();
        } catch (e) {
          return { ok: false, reason: `gate refused: ${(e as Error).message}` };
        }
        const c = leasedGateContext(g, wt);
        return { ok: true, ctx: { ...c, signal: AbortSignal.any([c.signal ?? wt.lost, runCtl.signal]) } };
      };
      /** The pending git-remote resource of `goalId` to push to, unless the worktree already has a remote of its name. */
      const provisionedRemote = async (goalId: string): Promise<{ name: string; locator: string; resourceId: string } | { refuse: string } | null> => {
        const reg = resourceRegistryOf(await runEvents(), { runId, goalId, allowance, secrets });
        let place: { root: string; repoRoot: string } | null = null;
        try {
          place = { root: resourcesRoot(ctx.env), repoRoot: ctx.root };
        } catch {
          place = null;
        }
        const r = place ? pushableRemote(reg, place) : null;
        // A pending git remote that is not in Tecera's own space (the repository, elsewhere on the host) is
        // refused, never silently skipped: the delivery stops and says which resource.
        const stray = pushableRemote(reg);
        if (!r && stray) return { refuse: `gate.pr: the provisioned remote ${stray.id} does not lie under the resources root outside the repository; nothing is pushed to it` };
        if (!r) return null;
        const existing = (await hostGit(wt.path, ['config', '--get', `remote.${r.capability}.url`]).catch(() => '')).trim();
        return existing ? null : { name: r.capability, locator: r.locator, resourceId: r.id };
      };
      const gatePorts: GateRunner = {
        verify: async (g) => {
          const l = await leased(g);
          if (!l.ok) return { exitCode: 9, evidenceKey: '', terminal: true, reason: l.reason };
          await recordCriterionMocks(l.ctx);
          return gates.verify(l.ctx);
        },
        review: async (g) => {
          const l = await leased(g);
          if (!l.ok) return { verdict: 'reject' as const, evidenceKey: '', terminal: true, reason: l.reason };
          const r = await als.run({ trace: gateTrace(g) }, () => gates.review(l.ctx));
          // The gate turns provider errors into a verdict; accounting is never a verdict: a ledger failure
          // terminates the run (exit 9), a budget refusal is a budget failure (exit 7).
          if (reviewerMeter.broken) throw reviewerMeter.broken;
          if (reviewerMeter.exhausted) throw new AccountingFailure(`review: ${reviewerMeter.exhausted.message}`, 'budget', 'review', { cause: reviewerMeter.exhausted });
          return r;
        },
        commit: async (g) => {
          const l = await leased(g);
          if (!l.ok) return { exitCode: 9, evidenceKey: '', terminal: true, reason: l.reason };
          return gates.commit(forCommit(l.ctx));
        },
        pr: async (g): Promise<GatePrResult> => {
          const sha = g.commit?.sha ?? '';
          const l = await leased(g);
          if (!l.ok) return { exitCode: 9, sha, evidenceKey: '', terminal: true, reason: l.reason };
          // The PR gate is @tecera/gates' (push the work branch, `gh pr create`, else a patch bundle under
          // .tecera/runs/<run>/pr/; consume the grant bound to prActionHash of the sha; never merge). A gates
          // build without one cannot deliver: a human must (terminal, never a silent success).
          const prGate = (gates as Partial<Pick<GateRunner, 'pr'>>).pr;
          if (typeof prGate !== 'function') return { exitCode: 9, sha, evidenceKey: '', terminal: true, reason: 'gate.pr: the installed @tecera/gates has no PR gate; deliver the work branch by hand', failure: 'human' };
          // D12: a git remote Tecera provisioned for this goal (pending, inside the allowance) receives the push
          // when the repository has no remote of the capability's name; it is added for this delivery only.
          const remote = await provisionedRemote(g.goal.id);
          if (!remote) return prGate.call(gates, forCommit(l.ctx));
          if ('refuse' in remote) return { exitCode: 9, sha, evidenceKey: '', terminal: true, reason: remote.refuse, failure: 'human' };
          try {
            await hostGit(wt.path, ['remote', 'add', remote.name, remote.locator]);
          } catch (e) {
            return { exitCode: 9, sha, evidenceKey: '', terminal: true, reason: `gate.pr: the provisioned remote ${remote.resourceId} could not be added (${(e as Error).message})`, failure: 'human' };
          }
          try {
            const gate = remote.name === 'origin' || !prOptions ? null : new PrGate({ ...prOptions, remote: remote.name });
            return gate ? await gate.pr(forCommit(l.ctx)) : await prGate.call(gates, forCommit(l.ctx));
          } finally {
            await hostGit(wt.path, ['remote', 'remove', remote.name]).catch(() => undefined);
          }
        },
        reconcile: async (g): Promise<GateReconcileOutcome> => {
          const l = await leased(g);
          if (!l.ok) return { recorded: false, reason: l.reason };
          return gates.reconcile(forCommit(l.ctx));
        },
      };

      return {
        planner,
        worker,
        gates: gatePorts,
        seats,
        frontier,
        validator,
        toolCatalog: [...WIRED_TOOLS],
        worktree: wt.path,
        fencingToken: () => wt.fencingToken(),
        leaseSignal: wt.lost,
        isolationDegraded,
        verifyRunner,
        runSignal: runCtl.signal,
        setDeadline: (deadlineMs: number): void => {
          if (deadlineTimer) clearTimeout(deadlineTimer);
          deadlineTimer = null;
          const rem = deadlineMs - ctx.now();
          // D3: the wall-clock budget ends a run only when budgets are enforced; otherwise passing it is recorded.
          const passed = (): void => {
            if (m.budgets.enforce) abortRun(new LedgerError('budget: run deadline exceeded', 'budget'));
            else void onExhausted({ pool: 'wallClock', used: Math.max(0, ctx.now() - (deadlineMs - m.budgets.wallClockSec * 1000)), cap: m.budgets.wallClockSec * 1000, amount: 0, purpose: 'run deadline' });
          };
          if (!Number.isFinite(rem) || rem <= 0) passed();
          else if (rem < 2 ** 31 - 1) {
            deadlineTimer = setTimeout(passed, rem);
            deadlineTimer.unref();
          }
        },
        costUnrecorded: () => unrecorded,
        probe,
        ...(provisioner ? { provisioner } : {}),
        secrets,
        sweep: async (): Promise<string[]> => {
          if (!local) return [];
          const out: string[] = [];
          const res = await releaseExpired({ ledger, provisioner: local, actor: { kind: 'system', id: 'expiry' }, ids: () => ctx.ids(), now: ctx.now, allowance, secrets });
          for (const r of res.released) out.push(`resource   ${r.resourceId} expired and was released (teardown exit 0)`);
          for (const r of res.failed) out.push(`resource   ${r.resourceId} expired but ${r.unrecorded ? `its release could not be recorded (${r.unrecorded})` : `its teardown exited ${r.teardownExit}${r.reason ? ` (${r.reason})` : ''}`}; it stays a pending debt`);
          for (const r of res.orphans) out.push(`resource   ${r.resourceId} (never recorded) expired: teardown exit ${r.teardownExit}`);
          return out;
        },
        worktreeCheckpoint: async (): Promise<string> => {
          const l = wt.heldReason();
          if (l) throw new Error(`no checkpoint without the lease: ${l}`);
          return wt.checkpoint(runCtl.signal);
        },
        worktreeChanges: async (a: { from: string; to: string }): Promise<WorktreeChange[]> => {
          const l = wt.heldReason();
          if (l) throw new Error(`no change summary without the lease: ${l}`);
          return diffTrees(wt.path, a.from, a.to, runCtl.signal);
        },
        stepChanges: async (a: { from: string; to: string }): Promise<PathChange[]> => {
          const l = wt.heldReason();
          if (l) throw new Error(`no changed paths without the lease: ${l}`);
          const out: PathChange[] = [];
          for (const c of await changedPaths(wt.path, a.from, a.to, runCtl.signal, wt.baseSha)) {
            const present = inBase(c.path);
            // gone again and never in the base: nothing changed against the base
            if (c.deleted && !present) continue;
            out.push({ path: c.path, op: c.deleted ? 'delete' : present ? 'modify' : 'create' });
          }
          // Ignored files are in no checkpoint tree: they are compared with the run's ignored baseline, as the gates do.
          const snap = await snapshotCandidate(wt.path, m.repo.base, { ignoredBaseline: await ignoredBaseline(ledger, new GateMemo(), runId), signal: runCtl.signal });
          for (const f of snap.files) if (f.status === '!') out.push({ path: f.path, op: 'ignored' });
          return out;
        },
        prepareIntention: async (a: IntentionPreparationRequest): Promise<IntentionPreparation> => {
          // Proven on the ledger first; every mutation below re-checks the lease itself (wt.prepareBranch).
          const token = await wt.assertHeld();
          const signal = a.signal ? AbortSignal.any([a.signal, wt.lost, runCtl.signal]) : AbortSignal.any([wt.lost, runCtl.signal]);
          const nameOf = (goalId: string): string => (goalId === ctx.goal.goalId ? goalName : goalId);
          const branch = intentionBranchName(m.repo.branchPrefix, nameOf(a.goalId), a.ordinal);
          const keys = preparationKeys(redactor, runId, a.intentionId);
          const oidOf = async (b: string): Promise<string | null> => (await hostGit(wt.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}^{commit}`]).catch(() => '')).trim() || null;
          // The previous intention's branch: the one its own preparation named, else the goal's first branch.
          const prevDone = preparationRecordOf((await ledger.getEvidence(preparationKeys(redactor, runId, a.previousIntentionId).done))?.body);
          const previousBranch = prevDone?.branch ?? intentionBranchName(m.repo.branchPrefix, nameOf(a.goalId), 1);
          const transition = { intentionId: a.intentionId, previousIntentionId: a.previousIntentionId, goalId: a.goalId, ordinal: a.ordinal, base: m.repo.base, baseSha: wt.baseSha, branch, previousBranch };
          // The intent is written once, before anything moves: a restart finds it and completes exactly this
          // transition, with the previous branch still where the intent saw it.
          const obj = (b: Json | undefined): Record<string, Json> | null => (b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, Json>) : null);
          let intent = obj((await ledger.getEvidence(keys.intent))?.body);
          if (!intent) {
            await claim(ledger, redactor, keys.intent, 'intention.prepare', runId, { ...transition, previousBranchSha: await oidOf(previousBranch), fencingToken: token, at: ctx.now() });
            intent = obj((await ledger.getEvidence(keys.intent))?.body);
          }
          const recorded = preparationRecordOf(intent as Json);
          if (!intent || !recorded || recorded.intentionId !== a.intentionId || recorded.previousIntentionId !== a.previousIntentionId || recorded.baseSha !== wt.baseSha || recorded.branch !== branch || intent.previousBranch !== previousBranch) {
            throw new Error(`the preparation intent on record for intention ${a.intentionId} names another transition; a human must look`);
          }
          const previousBranchSha = typeof intent.previousBranchSha === 'string' ? intent.previousBranchSha : null;
          const moved = async (): Promise<string | null> => {
            const now = await oidOf(previousBranch);
            return now === previousBranchSha ? null : `the previous intention's branch ${previousBranch} moved (${previousBranchSha ?? 'absent'} → ${now ?? 'absent'})`;
          };
          const before = await moved();
          if (before) throw new Error(before);
          const baseline = await ignoredBaseline(ledger, new GateMemo(), runId);
          const prepared = await wt.prepareBranch({
            branch,
            keepIgnored: (k) => baseline?.entries[k] !== undefined,
            signal,
            ...(o.prepareTestHooks?.beforeMutation ? { beforeMutation: () => o.prepareTestHooks!.beforeMutation!({ intentionId: a.intentionId, branch, loseLease: () => wt.release() }) } : {}),
          });
          const after = await moved();
          if (after) throw new Error(after);
          await o.prepareTestHooks?.afterMutation?.({ intentionId: a.intentionId, branch, loseLease: () => wt.release() });
          // What the planner and the workers are told about the repository is read again from the base.
          repoFactsCache = null;
          const done = await ledger.getEvidence(keys.done);
          if (done) {
            const d = preparationRecordOf(done.body);
            if (!d || d.intentionId !== a.intentionId || d.branch !== branch || d.baseSha !== wt.baseSha) throw new Error(`the preparation record of intention ${a.intentionId} names another branch or base; a human must look`);
          } else {
            const l = wt.heldReason();
            if (l) throw new Error(`no preparation record without the lease: ${l}`);
            await writeEvidence(ledger, redactor, { key: keys.done, kind: 'intention.prepared', runId, body: { ...transition, previousBranchSha, fencingToken: token, intentFencingToken: recorded.fencingToken, created: prepared.created, removedIgnored: prepared.removedIgnored, at: ctx.now() } });
            await ledger.append(event('evidence.appended', { id: ctx.ids(), at: ctx.now(), actor: { kind: 'system', id: 'wiring' }, runId, trace: { goalId: a.goalId, intentionId: a.intentionId }, payload: { kind: 'intention.prepared', evidenceKey: keys.done, branch, baseSha: wt.baseSha, previousIntentionId: a.previousIntentionId, previousBranch, fencingToken: token } }));
          }
          return { branch, baseSha: wt.baseSha, fencingToken: token, evidenceKey: keys.done };
        },
        restoreWorktree: async (checkpointId: string, signal?: AbortSignal): Promise<string> => {
          await wt.assertHeld();
          const l = wt.heldReason();
          if (l) throw new Error(`no restore without the lease: ${l}`);
          return wt.restore(checkpointId, signal ? AbortSignal.any([signal, wt.lost]) : wt.lost);
        },
        reapPrior: () => reapPriorProcesses({ ownerFile, worktree: wt.path }),
        baseline: async (signal?: AbortSignal): Promise<BaselineResult> => {
          try {
            await wt.assertHeld();
          } catch (e) {
            return { exitCode: null, outcome: 'refused', problem: `worktree lease lost before the baseline (${(e as Error).message})`, evidenceKey: '' };
          }
          const merged = AbortSignal.any([...(signal ? [signal] : []), wt.lost, runCtl.signal]);
          const r = await gates.baseline({ runId, worktree: wt.path, signal: merged });
          const ran = r.outcome === 'passed' || r.outcome === 'failed';
          return { exitCode: r.exitCode, outcome: r.outcome, problem: ran ? null : (r.reason ?? r.outcome), evidenceKey: r.evidenceKey };
        },
        notes,
        dispose,
      };
    } catch (e) {
      await dispose();
      throw e;
    }
  };
}


// ---------- live seat probes (doctor) ----------

export interface SeatRef {
  role: 'planner' | 'worker' | 'reviewer';
  id: string;
  provider: string;
  model: string;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  usd: number;
  /** The provider could not report what the probe billed (`usd` is a bound or zero). */
  usageUnknown?: boolean;
  detail?: string;
}

/** One real, minimal completion against a seat. Credentials come from `secrets`; never print or return them. */
export type SeatProbe = (seat: SeatRef, ctx: { manifest: Manifest; env: Env; secrets?: SecretStore; redactor?: Redactor; signal?: AbortSignal }) => Promise<ProbeResult>;

/**
 * The live seat probe `tecera doctor` uses: the seat's real provider adapter (createProvider over the run's
 * SecretStore, the shared redactor on top) and @tecera/providers doctorProbe (one "reply ok" completion,
 * latency and cost). No SecretStore → not ready (fail closed, nothing is sent). The detail is the provider's
 * error text, which doctor redacts again before printing. `fetch` replaces the transport (tests).
 */
export function createProbe(o: { fetch?: FetchLike } = {}): SeatProbe {
  return async (seat, ctx) => {
    if (!ctx.secrets) return { ok: false, latencyMs: 0, usd: 0, detail: 'no credentials resolved (SecretStore missing); nothing was sent' };
    const conf = seat.role === 'planner' ? ctx.manifest.seats.planner : seat.role === 'reviewer' ? ctx.manifest.seats.reviewer : ctx.manifest.seats.workers.find((w) => w.id === seat.id);
    if (!conf) return { ok: false, latencyMs: 0, usd: 0, detail: `seat ${seat.id} is not in the manifest` };
    let llm: LLM;
    try {
      const setup = providerSetup(ctx.manifest);
      llm = withIdentity(createProvider(conf as Parameters<typeof createProvider>[0], ctx.secrets, providerOptions(setup, { ...(ctx.redactor ? { redactor: ctx.redactor } : {}), ...(o.fetch ? { fetch: o.fetch } : {}), maxRetries: 0 })), setup, conf.provider);
    } catch (e) {
      return { ok: false, latencyMs: 0, usd: 0, detail: `provider not usable: ${(e as Error).message}` };
    }
    const r = await doctorProbe(llm, { model: seat.model, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    const unknown = (r as { usageUnknown?: boolean }).usageUnknown === true;
    return { ok: r.ok, latencyMs: r.latencyMs, usd: r.usd, ...(unknown ? { usageUnknown: true } : {}), ...(r.ok ? {} : { detail: r.error ?? r.finishReason }) };
  };
}

export const defaultProbe: SeatProbe = createProbe();
