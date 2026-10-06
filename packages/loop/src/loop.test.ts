import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MANDATORY_HOOKS,
  commitActionHash as contractsCommitActionHash,
  approvalGrantedEvent,
  type ApprovalGrant,
  type GateCommitResult,
  type GateContext,
  type GateReconcileResult,
  type GateReviewResult,
  type GateVerifyResult,
  type Ledger,
  parseManifest,
  type AchievementGoal,
  type BeliefProjection,
  type DecisionRecord,
  type Intention,
  type Json,
  type Manifest,
  type ManifestInput,
  type Outcome,
  type Plan,
  type Planner,
  type TeceraEvent,
  type Worker,
  type WorkerStepRequest,
  type WriteGuard,
  FenceLost,
  LedgerError,
  WriteRefused,
  reviewEvidenceKey,
  prActionHash,
  verifyCommandDigest,
  type GatePrResult,
} from '@tecera/contracts';
import { MemoryLedger, SqliteLedger } from '@tecera/ledger';
import { ReflexRouter, RulesReflex } from '@tecera/reflex';
import { ApprovalExpired, Loop, LoopStopped, commitActionHash, type GateRunner, type LoopPorts } from './loop.js';
import { MemoryPlanLibrary } from './library.js';
import { assembleStepContext } from './context.js';

// ---------- fakes ----------

function manifest(overrides: Partial<ManifestInput> = {}): Manifest {
  return parseManifest({
    schemaVersion: 1,
    id: 'bc_sample01',
    name: 'sample',
    owner: 'o',
    runtime: { tecera: '>=0.1.0' },
    repo: { base: 'main', branchPrefix: 'tecera/', allowedChanges: ['src/**'] },
    providers: { anthropic: { auth: 'env:A' }, openai: { auth: 'env:O' } },
    seats: {
      planner: { provider: 'anthropic', model: 'p', effort: 'high' },
      workers: [{ id: 'cheap', provider: 'anthropic', model: 'c', effort: 'low' }, { id: 'strong', provider: 'anthropic', model: 's', effort: 'high' }],
      reviewer: { provider: 'openai', model: 'r', effort: 'high' },
      reflex: { provider: 'rules' },
    },
    budgets: { usd: 2, tokens: 100000, wallClockSec: 600, maxDepth: 3, maxIterations: 10, maxAttempts: 2, maxChangedFiles: 5 },
    // 'os' isolation: the degraded-isolation hold has its own tests below.
    sandbox: { profile: 'process', isolation: 'os', network: false, memoryMb: 256, execTimeoutSec: 60 },
    policy: {
      protectedPaths: ['**/*.test.*'],
      approvals: { required: ['open_pr'], ttlSec: 900, quorum: 1, separationOfDuty: true },
      failure: { onVerifyFail: 'retry-once', onReviewFail: 'retry-once', onLedgerError: 'stop' },
    },
    verify: { command: 'npm test', timeoutSec: 60 },
    review: { foreign: true, maxAttempts: 1 },
    hooks: { mandatory: [...MANDATORY_HOOKS] },
    ...overrides,
  });
}

export const fivePlan = (id = 'p_fix'): Plan => ({
  id,
  trigger: { kind: 'goal.adopted' },
  context: [{ key: 'verify.baseline', equals: 'failing' }],
  steps: [
    { id: 'analyze', kind: 'worker', dependsOn: [], inputs: {}, instruction: 'read the failing test' },
    { id: 'edit', kind: 'worker', dependsOn: ['analyze'], inputs: {}, instruction: 'fix the implementation' },
    { id: 'verify1', kind: 'gate.verify', dependsOn: ['edit'], inputs: {} },
    { id: 'review', kind: 'gate.review', dependsOn: ['verify1'], inputs: {} },
    { id: 'verify2', kind: 'gate.verify', dependsOn: ['review'], inputs: {} },
    { id: 'commit', kind: 'gate.commit', dependsOn: ['verify2'], inputs: {} },
    { id: 'pr', kind: 'gate.pr', dependsOn: ['commit'], inputs: {} },
  ],
  allowedModels: { analyze: ['cheap'], edit: ['strong', 'cheap'] },
  permissions: { tools: ['read', 'edit', 'runVerify'], write: ['src/**'], approvals: ['open_pr'] },
  budget: {},
  origin: 'generated',
  status: 'candidate',
  goalKinds: ['fix-failing-test'],
});

class ScriptedPlanner implements Planner {
  writes = 0;
  deliberations = 0;
  constructor(private readonly plan: () => Plan) {}
  async write(_e: TeceraEvent, _b: BeliefProjection, _g: AchievementGoal): Promise<Plan> {
    this.writes++;
    return this.plan();
  }
  async deliberate(options: Plan[]): Promise<Plan> {
    this.deliberations++;
    return options[0]!;
  }
}

class ScriptedWorker implements Worker {
  calls: WorkerStepRequest[] = [];
  resumes: Array<{ token: string; grant: ApprovalGrant }> = [];
  ledger?: Ledger;
  /** What resume() does; default: consume the grant (the worker owns it) and return. */
  onResume?: (token: string, grant: ApprovalGrant, guard?: WriteGuard) => Promise<Outcome>;
  guards: Array<WriteGuard | undefined> = [];
  constructor(private readonly script: (req: WorkerStepRequest) => Outcome | Promise<Outcome>) {}
  onRun?: (signal?: AbortSignal) => void;
  /**
   * Bumped by every run() of a step other than 'analyze' (in these fakes analyze only reads): the scripted
   * gates derive their default fingerprint from it, so the same tree has the same fingerprint (fp-1 after the
   * first edit, fp-2 after the second, …).
   */
  tree = { version: 0 };
  async run(req: WorkerStepRequest, signal?: AbortSignal): Promise<Outcome> {
    this.calls.push(req);
    if (req.step.id !== 'analyze') this.tree.version++;
    this.onRun?.(signal);
    if (signal?.aborted) return { kind: 'aborted', reasons: [{ code: 'cancelled', reason: 'aborted', hookId: 'test' }], run: { runId: req.runId, invokeId: 'x', depth: 0 } };
    return this.script(req);
  }
  async resume(token: string, grant: ApprovalGrant, _signal?: AbortSignal, guard?: WriteGuard): Promise<Outcome> {
    this.resumes.push({ token, grant });
    this.guards.push(guard);
    if (this.onResume) return this.onResume(token, grant, guard);
    const view = await this.ledger!.getApproval!(grant.requestId);
    await this.ledger!.consume(grant.requestId, view!.actionHash, 's', `worker:${grant.requestId}`, 50);
    return okOutcome([{ key: 'resumed.with', value: token }]);
  }
}

const okOutcome = (facts: Array<{ key: string; value: Json }> = []): Outcome => ({ kind: 'returned', value: { facts }, run: { runId: 'r', invokeId: 'i', depth: 0 } });

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
/** A call that never returns: the process "dies" while it runs. */
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

class ScriptedGates implements GateRunner {
  /** Hang the n-th call of a gate (the crash point); `afterConsume` hangs pr after spending its grant. */
  hang?: { on: 'verify' | 'review' | 'commit' | 'pr'; call: number; reached: Deferred; afterConsume?: boolean };
  calls = { verify: 0, review: 0, commit: 0, pr: 0 };
  /** Fingerprint per verify call (1-based); default fp-<worker runs so far> (same tree → same fingerprint). */
  fps?: string[];
  /** The worktree version the default fingerprint follows (linked to the ScriptedWorker by build()). */
  tree = { version: 0 };
  reconcile?: (ctx: GateContext) => Promise<GateReconcileResult>;
  reconciles: GateContext[] = [];
  withReconcile(r: (ctx: GateContext) => GateReconcileResult | Promise<GateReconcileResult>): this {
    this.reconcile = async (ctx) => {
      this.reconciles.push(ctx);
      return r(ctx);
    };
    return this;
  }
  private hangNow(on: 'verify' | 'review' | 'commit' | 'pr'): boolean {
    if (this.hang?.on !== on || this.hang.call !== this.calls[on]) return false;
    this.hang.reached.resolve();
    return true;
  }
  verifyCodes: number[] = [0, 0];
  verdict: 'approve' | 'reject' = 'approve';
  commitCode = 0;
  prCode = 0;
  /** URL the PR gate reports (absent → pr.requested with a bundle). */
  prUrl?: string = 'https://example.test/pr/1';
  log: string[] = [];
  contexts: GateContext[] = [];
  ledger?: Ledger;
  /** PR gate consumes the approval it is handed (the gate is the owner). */
  consume = true;
  verifyExtra: { terminal?: boolean; reason?: string; fingerprint?: string } = {};
  reviewExtra: { terminal?: boolean; reason?: string } = {};
  commitExtra: { terminal?: boolean; reason?: string; sha?: string } = {};
  prExtra: Partial<GatePrResult> = {};
  /** When false, verify omits the fingerprint and the loop must read it from evidence. */
  fingerprintInResult = true;
  /** When false, verify writes no gate.verify evidence (the loop cannot prove achievement). */
  writeEvidence = true;
  /** Command the verify evidence records (default: the goal check). */
  evidenceCommand?: string;
  private v = 0;
  async verify(ctx: GateContext) {
    this.log.push('verify');
    this.contexts.push(ctx);
    this.calls.verify++;
    if (this.hangNow('verify')) return never<GateVerifyResult>();
    const n = ++this.v;
    const fp = this.fps?.[Math.min(n - 1, this.fps.length - 1)] ?? `fp-${this.tree.version}`;
    const evidenceKey = `verify-${n}-${Math.random().toString(36).slice(2, 6)}`;
    const exitCode = this.verifyCodes[Math.min(n - 1, this.verifyCodes.length - 1)]!;
    const command = this.evidenceCommand ?? ctx.goal.check.command;
    if (this.writeEvidence) await this.ledger!.evidence({ key: evidenceKey, kind: 'gate.verify', runId: ctx.runId, body: { command, commandDigest: verifyCommandDigest(command), exitCode, outcome: exitCode === 0 ? 'passed' : 'failed', fingerprint: fp } });
    return { exitCode, evidenceKey, ...(this.fingerprintInResult ? { fingerprint: fp } : {}), ...this.verifyExtra };
  }
  async review(ctx: GateContext) {
    this.log.push('review');
    this.contexts.push(ctx);
    this.calls.review++;
    if (this.hangNow('review')) return never<GateReviewResult>();
    return { verdict: this.verdict, evidenceKey: 'review-1', fingerprint: ctx.candidate?.d1 ?? 'fp-review', ...this.reviewExtra };
  }
  async commit(ctx: GateContext) {
    this.log.push('commit');
    this.contexts.push(ctx);
    this.calls.commit++;
    if (this.hangNow('commit')) return never<GateCommitResult>();
    return { exitCode: this.commitCode, sha: 'abc123', evidenceKey: 'commit-1', ...this.commitExtra };
  }
  async pr(ctx: GateContext): Promise<GatePrResult> {
    this.log.push('pr');
    this.contexts.push(ctx);
    this.calls.pr++;
    if (!this.hang?.afterConsume && this.hangNow('pr')) return never<GatePrResult>();
    const sha = ctx.commit?.sha ?? '';
    if (ctx.approval && this.consume) {
      const expected = prActionHash({ intentionId: ctx.intention.id, stepId: ctx.step.id, attempt: ctx.intention.attempt, sha });
      if (expected !== ctx.approval.actionHash) return { exitCode: 8, sha, evidenceKey: 'pr-1', reason: 'hash mismatch' };
      await this.ledger!.consume(ctx.approval.requestId, expected, ctx.approval.sessionId, `gate:${ctx.approval.requestId}`, 40);
    }
    if (this.hang?.afterConsume && this.hangNow('pr')) return never<GatePrResult>();
    return { exitCode: this.prCode, sha, evidenceKey: 'pr-1', branch: 'tecera/g_fix', base: 'main', ...(this.prUrl ? { url: this.prUrl, pushed: true } : { bundle: '.tecera/runs/r/pr/abc123.bundle', pushed: false }), ...this.prExtra };
  }
}

const sink = { records: [] as DecisionRecord[], async record(d: DecisionRecord) { this.records.push(d); } };

function build(opts: {
  plan?: () => Plan;
  worker?: (req: WorkerStepRequest) => Outcome | Promise<Outcome>;
  gates?: ScriptedGates;
  manifest?: Manifest;
  library?: MemoryPlanLibrary;
  validatorErrors?: string[];
  ledger?: Ledger;
  planner?: Planner;
  validator?: LoopPorts['validator'];
  extra?: Partial<LoopPorts>;
  noBudget?: boolean;
} = {}) {
  const m = opts.manifest ?? manifest();
  const ledger = (opts.ledger ?? new MemoryLedger()) as MemoryLedger;
  // The run's pools (the runtime opens them before loop.start, soft unless budgets.enforce); planner calls reserve on usd/tokens.
  if (!opts.noBudget) {
    const enforce = m.budgets.enforce;
    void ledger.openBudget('r', 'usd', m.budgets.usd, { enforce });
    void ledger.openBudget('r', 'tokens', m.budgets.tokens, { enforce });
    void ledger.openBudget('r', 'calls', 400, { enforce });
  }
  const planner = (opts.planner ?? new ScriptedPlanner(opts.plan ?? fivePlan)) as ScriptedPlanner;
  const worker = new ScriptedWorker(opts.worker ?? (() => okOutcome()));
  worker.ledger = ledger;
  const gates = opts.gates ?? new ScriptedGates();
  gates.ledger = ledger;
  gates.tree = worker.tree;
  const library = opts.library ?? new MemoryPlanLibrary();
  let t = 0;
  const reflex = new ReflexRouter({ settings: m.reflexes, threshold: m.reflexes.threshold }, { sink, runId: 'r', now: () => ++t });
  const ports: LoopPorts = {
    manifest: m,
    ledger,
    library,
    planner,
    reflex,
    worker,
    gates,
    validator: opts.validator ?? { validatePlan: () => opts.validatorErrors ?? [] },
    seats: [{ seatId: 'cheap', costPerMTok: 1 }, { seatId: 'strong', costPerMTok: 5 }],
    runId: 'r',
    sessionId: 's',
    worktree: '/tmp/wt',
    now: () => ++t,
    ...opts.extra,
  };
  const loop = new Loop(ports);
  return { loop, ledger, planner, worker, gates, library, m };
}

/** A human grant recorded with its approval.granted audit event (consume() refuses unaudited grants). */
async function grantWithAudit(ledger: Ledger, requestId: string, at = 10, approver: { kind: 'human'; id: string } = { kind: 'human', id: 'nick' }): Promise<ApprovalGrant> {
  const view = (await ledger.getApproval(requestId))!;
  let trace: { goalId?: string; intentionId?: string; stepId?: string; planId?: string } = { goalId: 'g_fix', intentionId: 'i', stepId: 's' };
  for await (const e of ledger.events({ kinds: ['approval.requested', 'step.held'] })) if (e.payload.requestId === requestId) trace = { ...e.trace };
  const audit = approvalGrantedEvent({ id: `grant_${requestId}_${at}_${Math.random().toString(36).slice(2, 8)}`, at, requestId, runId: view.runId, sessionId: view.sessionId, actionHash: view.actionHash, approver, trace });
  return ledger.approve(requestId, approver, view.sessionId, at, audit);
}

async function eventsOf(ledger: Ledger, kind: TeceraEvent["kind"]): Promise<Array<TeceraEvent & { seq: number }>> {
  const out: Array<TeceraEvent & { seq: number }> = [];
  for await (const e of ledger.events({ kinds: [kind] })) out.push(e);
  return out;
}

/** Drive a run to its PR hold, grant it with an audit and resume: the full delivery. */
async function deliver(loop: Loop, ledger: Ledger): Promise<void> {
  const st = await loop.runUntilQuiescent();
  const h = st.held.find((x) => x.stepId === 'pr');
  if (!h) throw new Error(`no PR hold: ${JSON.stringify(st.held)}`);
  await loop.resume(h.requestId, await grantWithAudit(ledger, h.requestId));
  await loop.runUntilQuiescent();
}

async function kinds(ledger: MemoryLedger): Promise<string[]> {
  const out: string[] = [];
  for await (const e of ledger.events()) out.push(e.kind);
  return out;
}

/** A manifest with budgets.enforce true (D3: exhaustion ends the run). */
const enforcing = (budgets: Partial<Manifest['budgets']> = {}): Manifest => manifest({ budgets: { usd: 2, tokens: 100000, wallClockSec: 600, maxDepth: 3, maxIterations: 10, maxAttempts: 2, maxChangedFiles: 5, enforce: true, ...budgets } });

const goalInput = { id: 'g_fix', statement: 'make the failing test pass', check: { command: 'npm test', timeoutSec: 60 } };

// ---------- P0.5 planner + library ----------

describe('deliberation and plan generation', () => {
  it('no plan matches → planner writes one once; it is staged, not accepted', async () => {
    const { loop, planner, library, ledger } = build();
    await loop.start('h');
    await loop.addBelief('verify.baseline', 'failing', { src: 'preflight', trust: 'trusted' });
    await loop.adoptGoal(goalInput);
    expect(planner.writes).toBe(1);
    const staged = library.all();
    expect(staged).toHaveLength(1);
    expect(staged[0]!.status).toBe('candidate');
    expect(staged[0]!.origin).toBe('generated');
    const ks = await kinds(ledger);
    expect(ks).toContain('plan.generated');
    expect(ks).toContain('plan.staged');
    expect(ks).toContain('intention.pushed');
    // a second identical goal does not match the candidate: planner is asked again
    await loop.adoptGoal({ ...goalInput, id: 'g_2' });
    expect(planner.writes).toBe(2);
  });

  it('a graduated plan matches and the planner is not called', async () => {
    const library = new MemoryPlanLibrary();
    library.accept(fivePlan('p_acc'));
    const { loop, planner } = build({ library });
    await loop.addBelief('verify.baseline', 'failing');
    await loop.adoptGoal(goalInput);
    expect(planner.writes).toBe(0);
    expect(loop.status().intentions[0]!.planId).toBe('p_acc');
  });

  it('a plan that fails validation is rejected and the goal is dropped', async () => {
    const { loop, ledger } = build({ validatorErrors: ['plan requests git_push'] });
    await loop.addBelief('verify.baseline', 'failing');
    await loop.adoptGoal(goalInput);
    const ks = await kinds(ledger);
    expect(ks).toContain('plan.rejected');
    expect(ks).toContain('goal.dropped');
    expect(loop.goal('g_fix')!.status).toBe('dropped');
    expect(loop.status().intentions).toHaveLength(0);
  });

  it('a malformed generated plan (cycle) is rejected by shape validation', async () => {
    const cyclic = () => {
      const p = fivePlan();
      p.steps[0]!.dependsOn = ['commit'];
      return p;
    };
    const { loop, ledger } = build({ plan: cyclic });
    await loop.adoptGoal(goalInput);
    expect(await kinds(ledger)).toContain('plan.rejected');
  });
});

// ---------- P0.3 the cycle ----------

describe('the cycle', () => {
  it('D6: runs worker → verify → review → verify → commit (no approval) → PR (the one approval) to goal.achieved with a proof (D4), and routes each worker step to the cheapest allowed seat', async () => {
    const { loop, ledger, gates, worker } = build();
    await loop.start('h');
    await loop.addBelief('verify.baseline', 'failing', { src: 'preflight', trust: 'trusted' });
    await loop.adoptGoal(goalInput);
    let status = await loop.runUntilQuiescent();
    // the commit went to the work branch without a hold; the PR is held for approval
    expect(status.held).toHaveLength(1);
    expect(status.held[0]!.stepId).toBe('pr');
    expect(status.intentions[0]!.status).toBe('held');
    expect(gates.log).toEqual(['verify', 'review', 'verify', 'commit']);
    const req = status.held[0]!.requestId;
    // the approval is bound to the committed sha
    const view = (await ledger.getApproval(req))!;
    expect(view.actionHash).toBe(prActionHash({ intentionId: status.intentions[0]!.id, stepId: 'pr', attempt: 1, sha: 'abc123' }));
    const grant = await grantWithAudit(ledger, req);
    await loop.resume(req, grant);
    status = await loop.runUntilQuiescent();
    expect(gates.log).toEqual(['verify', 'review', 'verify', 'commit', 'pr']);
    const prCtx = gates.contexts.at(-1)!;
    expect(prCtx.approval).toMatchObject({ requestId: req, actionHash: view.actionHash });
    expect(prCtx.commit).toMatchObject({ sha: 'abc123', d1: 'fp-1' });
    // the commit gate never receives an approval
    expect(gates.contexts.find((c) => c.step.id === 'commit')!.approval).toBeUndefined();
    const goal = loop.goal('g_fix')!;
    expect(goal.status).toBe('achieved');
    expect(goal.proof).toMatchObject({ command: 'npm test', exitCode: 0, fingerprint: 'fp-1' });
    expect(status.intentions[0]!.status).toBe('done');
    const ks = await kinds(ledger);
    for (const k of ['run.started', 'goal.adopted', 'plan.generated', 'plan.staged', 'intention.pushed', 'step.requested', 'step.completed', 'verify.passed', 'review.passed', 'commit.recorded', 'approval.requested', 'step.held', 'approval.consumed', 'pr.opened', 'intention.done', 'goal.achieved']) expect(ks).toContain(k);
    expect(ks.indexOf('commit.recorded')).toBeLessThan(ks.indexOf('approval.requested'));
    const achieved = await eventsOf(ledger, 'goal.achieved');
    const proof = achieved[0]!.payload.proof as Record<string, unknown>;
    const lastVerify = (await eventsOf(ledger, 'verify.passed')).at(-1)!;
    expect(proof).toEqual({ command: 'npm test', exitCode: 0, fingerprint: 'fp-1', evidenceKey: lastVerify.payload.evidenceKey, verifiedAt: lastVerify.at });
    expect((await eventsOf(ledger, 'pr.opened'))[0]!.payload).toMatchObject({ sha: 'abc123', url: 'https://example.test/pr/1', approvalRequestId: req });
    expect(worker.calls.map((c) => `${c.step.id}:${c.seatId}`)).toEqual(['analyze:cheap', 'edit:cheap']);
    expect(await ledger.verifyChain()).toMatchObject({ ok: true });
  });

  it('two independent intentions run concurrently under the per-agent cap', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const worker = async (): Promise<Outcome> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return okOutcome();
    };
    const { loop } = build({ worker, manifest: manifest({ concurrency: { perAgent: 2 } }) });
    await loop.addBelief('verify.baseline', 'failing');
    await loop.adoptGoal(goalInput);
    await loop.adoptGoal({ ...goalInput, id: 'g_two' });
    await loop.adoptGoal({ ...goalInput, id: 'g_three' });
    await loop.runUntilQuiescent();
    expect(maxInFlight).toBe(2);
    expect(loop.status().intentions.every((i) => i.status === 'held')).toBe(true);
  });

  it('dependent steps wait: edit never starts before analyze completes', async () => {
    const order: string[] = [];
    const { loop } = build({
      worker: async (req) => {
        order.push(`start:${req.step.id}`);
        await new Promise((r) => setTimeout(r, 2));
        order.push(`end:${req.step.id}`);
        return okOutcome();
      },
    });
    await loop.addBelief('verify.baseline', 'failing');
    await loop.adoptGoal(goalInput);
    await loop.runUntilQuiescent();
    expect(order).toEqual(['start:analyze', 'end:analyze', 'start:edit', 'end:edit']);
  });

  it('a failed verify retries once then fails the intention and drops the goal', async () => {
    const gates = new ScriptedGates();
    gates.verifyCodes = [1, 1, 1];
    const { loop, ledger } = build({ gates });
    await loop.addBelief('verify.baseline', 'failing');
    await loop.adoptGoal(goalInput);
    await loop.runUntilQuiescent();
    const ks = await kinds(ledger);
    expect(ks.filter((k) => k === 'verify.failed')).toHaveLength(2); // maxAttempts = 2
    expect(ks).toContain('intention.failed');
    expect(loop.goal('g_fix')!.status).toBe('dropped');
  });

  it('a rejected review fails the step; worker facts become beliefs with untrusted provenance', async () => {
    const gates = new ScriptedGates();
    gates.verdict = 'reject';
    const { loop, ledger } = build({ gates, worker: () => okOutcome([{ key: 'root.cause', value: 'off by one' }]) });
    await loop.addBelief('verify.baseline', 'failing');
    await loop.adoptGoal(goalInput);
    await loop.runUntilQuiescent();
    expect(loop.beliefs.get('root.cause')).toMatchObject({ value: 'off by one', provenance: { trust: 'untrusted' } });
    expect(await kinds(ledger)).toContain('review.rejected');
    expect(loop.goal('g_fix')!.status).toBe('dropped');
  });

  it('a worker abort fails the step; returned never means done without a verify gate', async () => {
    const noVerify = () => ({ ...fivePlan('p_nv'), steps: [{ id: 'only', kind: 'worker' as const, dependsOn: [], inputs: {} }], allowedModels: {} });
    const { loop, ledger } = build({ plan: noVerify });
    await loop.adoptGoal(goalInput);
    await loop.runUntilQuiescent();
    expect(loop.status().intentions[0]!.status).toBe('done');
    expect(loop.goal('g_fix')!.status).toBe('open');
    expect(await kinds(ledger)).not.toContain('goal.achieved');
  });

  it('a suspended worker outcome holds the step with the worker\'s approval request', async () => {
    const { loop, ledger } = build({
      worker: (req) =>
        req.step.id === 'edit'
          ? ({ kind: 'suspended', request: { requestId: 'ap_worker', action: 'edit', actionHash: 'h', reason: 'write outside allowed', requester: 'worker' }, resumeToken: 't', run: { runId: 'r', invokeId: 'i', depth: 0 } } as Outcome)
          : okOutcome(),
    });
    await loop.addBelief('verify.baseline', 'failing');
    await loop.adoptGoal(goalInput);
    const s = await loop.runUntilQuiescent();
    expect(s.held).toEqual([{ intentionId: s.intentions[0]!.id, stepId: 'edit', requestId: 'ap_worker' }]);
    expect(await kinds(ledger)).toContain('step.held');
  });
});

// ---------- P0.4 commitment policies ----------

describe('commitment policies and reconsideration', () => {
  const slowWorker = async (): Promise<Outcome> => {
    await new Promise((r) => setTimeout(r, 10));
    return okOutcome();
  };

  it('blind: a context-invalidating belief does not interrupt', async () => {
    const { loop, ledger } = build({ worker: slowWorker });
    await loop.addBelief('verify.baseline', 'failing');
    await loop.adoptGoal({ ...goalInput, commitment: 'blind' });
    const run = loop.runUntilQuiescent();
    await loop.addBelief('verify.baseline', 'passing');
    await run;
    expect(await kinds(ledger)).not.toContain('intention.dropped');
  });

  it('single-minded: a belief that breaks the plan context drops the intention and re-deliberates', async () => {
    const { loop, ledger, planner } = build({ worker: slowWorker });
    await loop.addBelief('verify.baseline', 'failing');
    await loop.adoptGoal({ ...goalInput, commitment: 'single-minded' });
    const run = loop.runUntilQuiescent();
    await loop.addBelief('verify.baseline', 'passing');
    await run;
    const ks = await kinds(ledger);
    expect(ks).toContain('intention.dropped');
    expect(planner.writes).toBe(2); // re-deliberated with a fresh plan
    const dropped = loop.status().intentions.filter((i) => i.status === 'dropped');
    expect(dropped).toHaveLength(1);
  });

  it('single-minded ignores goal changes of other goals; open-minded reacts to its own goal being dropped', async () => {
    const { loop, ledger } = build({ worker: slowWorker });
    await loop.addBelief('verify.baseline', 'failing');
    await loop.adoptGoal({ ...goalInput, commitment: 'open-minded' });
    const run = loop.runUntilQuiescent();
    // unrelated belief: no interruption for open-minded either
    await loop.addBelief('weather', 'sunny');
    await run;
    expect(await kinds(ledger)).not.toContain('intention.dropped');
  });
});

// ---------- P0.6 context filter ----------

describe('context filter', () => {
  it('worker inputs contain exactly the beliefs the plan context mentions, plus goal and step, under budget', () => {
    const beliefs = {
      map: new Map<string, { value: Json; src: string }>([
        ['verify.baseline', { value: 'failing', src: 'preflight' }],
        ['secret.key', { value: 'should-not-leak', src: 'env' }],
        ['files.changed', { value: 0, src: 'git' }],
      ]),
      get(k: string) {
        const b = this.map.get(k);
        return b ? { id: k, key: k, value: b.value, provenance: { src: b.src, trust: 'trusted' as const }, at: 1 } : undefined;
      },
      all() {
        return [...this.map.keys()].map((k) => this.get(k)!);
      },
      match() {
        return true;
      },
    };
    const goal: AchievementGoal = { ...goalInput, commitment: 'blind', status: 'open', evidence: [] };
    const plan = fivePlan();
    const ctx = assembleStepContext(goal, plan, plan.steps[0]!, beliefs, { budgetTokens: 1000, extraKeys: ['files.changed'] });
    const beliefsBinding = ctx.inputs.beliefs as { kind: 'value'; value: Record<string, Json> };
    expect(Object.keys(beliefsBinding.value).sort()).toEqual(['files.changed', 'verify.baseline']);
    expect(JSON.stringify(ctx.inputs)).not.toContain('should-not-leak');
    expect(ctx.inputs.goal).toBeDefined();
    expect(ctx.inputs.step).toBeDefined();
    expect(ctx.dropped).toEqual([]);
    const tight = assembleStepContext(goal, plan, plan.steps[0]!, beliefs, { budgetTokens: 1 });
    expect(tight.inputs.goal).toBeDefined(); // always-on never dropped
    expect(tight.dropped).toContain('beliefs');
  });
});

// ---------- wave-2 kernel alignment ----------

async function events(ledger: Ledger): Promise<TeceraEvent[]> {
  const out: TeceraEvent[] = [];
  for await (const e of ledger.events()) out.push(e);
  return out;
}

class ThrowingPlanner implements Planner {
  constructor(private readonly err: unknown) {}
  async write(): Promise<Plan> {
    throw this.err;
  }
  async deliberate(options: Plan[]): Promise<Plan> {
    return options[0]!;
  }
}

class FlakyLedger extends MemoryLedger {
  failOn?: string;
  /** With failOn: only events of this step fail. */
  failStep?: string;
  failAfter?: number;
  appended = 0;
  override async append(e: TeceraEvent) {
    if ((e.kind === this.failOn && (this.failStep === undefined || e.trace.stepId === this.failStep)) || (this.failAfter !== undefined && this.appended >= this.failAfter)) throw new Error('disk full');
    this.appended++;
    return super.append(e);
  }
}

async function runToPrHold(opts: Parameters<typeof build>[0] = {}) {
  const b = build(opts);
  await b.loop.addBelief('verify.baseline', 'failing', { src: 'preflight', trust: 'trusted' });
  await b.loop.adoptGoal(goalInput);
  const status = await b.loop.runUntilQuiescent();
  return { ...b, status };
}

describe('(a) planner.write failures', () => {
  it('a PlanRejected-style throw becomes plan.rejected {errors from issues} + goal.dropped', async () => {
    const err = Object.assign(new Error('plan rejected'), { issues: ['requests git_push', { message: 'no verify gate' }], plan: { id: 'p_bad', steps: [] } });
    const { loop, ledger } = build({ planner: new ThrowingPlanner(err) });
    await loop.adoptGoal(goalInput);
    const evs = await events(ledger);
    const rej = evs.find((e) => e.kind === 'plan.rejected')!;
    expect(rej.payload.errors).toEqual(['requests git_push', 'no verify gate']);
    expect(rej.trace.planId).toBe('p_bad');
    const dropped = evs.find((e) => e.kind === 'goal.dropped')!;
    expect(dropped.payload.errors).toEqual(['requests git_push', 'no verify gate']);
    expect(loop.goal('g_fix')!.status).toBe('dropped');
    expect(loop.status().state).toBe('active');
    expect(loop.status().intentions).toHaveLength(0);
  });

  it('a plain throw yields [message] and a placeholder plan id', async () => {
    const { loop, ledger } = build({ planner: new ThrowingPlanner(new Error('provider timed out')) });
    await loop.adoptGoal(goalInput);
    const rej = (await events(ledger)).find((e) => e.kind === 'plan.rejected')!;
    expect(rej.payload).toMatchObject({ plan: null, errors: ['provider timed out'] });
    expect(rej.trace.planId).toBe('p_unparsed_g_fix');
    expect(loop.goal('g_fix')!.status).toBe('dropped');
  });
});

describe('(b)(c) D6 PR approval: bound to the committed sha, PR gate consumes, loop never does; commit needs no approval', () => {
  it('approval.requested on gate.pr uses prActionHash with the committed sha; resume hands {requestId, sessionId, actionHash} and the commit to the PR gate', async () => {
    const { loop, ledger, gates, status } = await runToPrHold();
    const i = status.intentions[0]!;
    const req = (await events(ledger)).find((e) => e.kind === 'approval.requested')!;
    const expected = prActionHash({ intentionId: i.id, stepId: 'pr', attempt: i.attempt, sha: 'abc123' });
    expect(expected).toBe(contractsCommitActionHash({ intentionId: i.id, stepId: 'pr', attempt: i.attempt, candidateD1: 'abc123' }));
    expect(req.trace.stepId).toBe('pr');
    expect(req.payload).toMatchObject({ actionHash: expected, sessionId: 's', owner: 'gate', candidateD1: 'abc123', sha: 'abc123', reviewedD1: 'fp-1' });
    expect(i.heldRequestId).toBe(req.payload.requestId);
    // the commit ran before any approval and received none
    expect(gates.calls.commit).toBe(1);
    expect(gates.contexts.find((c) => c.step.kind === 'gate.commit')!.approval).toBeUndefined();
    expect((await events(ledger)).find((e) => e.kind === 'commit.recorded')!.payload).toMatchObject({ sha: 'abc123', valid: true, d1: 'fp-1' });
    const requestId = status.held[0]!.requestId;
    const grant = await grantWithAudit(ledger, requestId);
    await loop.resume(requestId, grant);
    // the loop did not consume: the PR gate did, inside pr()
    const prCtx = gates.contexts.find((c) => c.step.kind === 'gate.pr')!;
    expect(prCtx.approval).toEqual({ requestId, sessionId: 's', actionHash: expected });
    expect(prCtx.commit).toEqual({ sha: 'abc123', d1: 'fp-1', evidenceKey: 'commit-1' });
    expect(prCtx.worktree).toBe('/tmp/wt');
    expect(prCtx.signal).toBeInstanceOf(AbortSignal);
    expect((await ledger.getApproval(requestId))!.state).toBe('consumed');
    const consumed = (await events(ledger)).filter((e) => e.kind === 'approval.consumed');
    expect(consumed).toHaveLength(1);
    expect(consumed[0]!.payload).toMatchObject({ requestId, by: 'gate.pr' });
    expect(loop.goal('g_fix')!.status).toBe('achieved');
  });

  it('no remote / no gh: the PR gate reports no url and the loop records pr.requested with branch, base and bundle; the goal is achieved', async () => {
    const gates = new ScriptedGates();
    gates.prUrl = undefined;
    const { loop, ledger } = await runToPrHold({ gates });
    await deliver(loop, ledger);
    const ks = await kinds(ledger);
    expect(ks).toContain('pr.requested');
    expect(ks).not.toContain('pr.opened');
    expect((await eventsOf(ledger, 'pr.requested'))[0]!.payload).toMatchObject({ sha: 'abc123', branch: 'tecera/g_fix', base: 'main', bundle: '.tecera/runs/r/pr/abc123.bundle', pushed: false });
    expect(loop.goal('g_fix')!.status).toBe('achieved');
  });

  it('the PR needs a review.passed for exactly the committed candidate: a commit of another candidate is refused before any approval is requested', async () => {
    // verify1 and verify2 report different trees: the review approved fp-a, the commit is of fp-b
    const gates = new ScriptedGates();
    gates.fps = ['fp-a', 'fp-b'];
    const { loop, ledger } = await runToPrHold({ gates });
    expect(loop.status().held).toHaveLength(0);
    const evs = await events(ledger);
    expect(evs.filter((e) => e.kind === 'approval.requested')).toHaveLength(0);
    expect(evs.find((e) => e.kind === 'step.failed' && e.trace.stepId === 'pr')!.payload).toMatchObject({ terminal: true, failure: 'policy', reason: expect.stringMatching(/no review.passed for the committed candidate fp-b/) });
    expect(gates.calls.pr).toBe(0);
    expect(loop.goal('g_fix')!.status).toBe('dropped');
  });

  it('the PR always holds, even when the reflex answers allow for it', async () => {
    const rules = new RulesReflex();
    const allowAll = {
      ask: async (seam: never, q: never) => (seam === 'gate' ? { seam, answer: { decision: 'allow' }, confidence: 1, provider: 'jev', abstained: false } : rules.ask(seam, q)),
    } as unknown as LoopPorts['reflex'];
    const { loop, gates } = build({ extra: { reflex: allowAll } });
    await loop.addBelief('verify.baseline', 'failing');
    await loop.adoptGoal(goalInput);
    const st = await loop.runUntilQuiescent();
    expect(st.held.map((h) => h.stepId)).toEqual(['pr']);
    expect(gates.calls.commit).toBe(1);
    expect(gates.calls.pr).toBe(0);
  });

  it('D1 comes from the verify evidence when the result carries no fingerprint (and reaches the commit and the PR binding)', async () => {
    const gates = new ScriptedGates();
    gates.fingerprintInResult = false;
    const { ledger, status } = await runToPrHold({ gates });
    const i = status.intentions[0]!;
    expect(gates.contexts.find((c) => c.step.kind === 'gate.commit')!.candidate).toMatchObject({ d1: 'fp-1' });
    const req = (await events(ledger)).find((e) => e.kind === 'approval.requested')!;
    expect(req.payload).toMatchObject({ actionHash: prActionHash({ intentionId: i.id, stepId: 'pr', attempt: i.attempt, sha: 'abc123' }), reviewedD1: 'fp-1' });
  });

  it('a PR gate that does not consume the grant fails the step terminally; the grant stays unspent; no pr.opened', async () => {
    const gates = new ScriptedGates();
    gates.consume = false;
    const { loop, ledger, status } = await runToPrHold({ gates });
    const requestId = status.held[0]!.requestId;
    await loop.resume(requestId, await grantWithAudit(ledger, requestId));
    await loop.runUntilQuiescent();
    expect((await ledger.getApproval(requestId))!.state).toBe('granted');
    const evs = await events(ledger);
    expect(evs.filter((e) => e.kind === 'approval.consumed')).toHaveLength(0);
    expect(evs.filter((e) => e.kind === 'pr.opened')).toHaveLength(0);
    expect(evs.find((e) => e.kind === 'pr.failed')!.payload).toMatchObject({ failure: 'policy' });
    expect(evs.find((e) => e.kind === 'step.failed' && e.trace.stepId === 'pr')!.payload).toMatchObject({ terminal: true });
    expect(gates.log.filter((x) => x === 'pr')).toHaveLength(1); // never retried
    expect(loop.goal('g_fix')!.status).toBe('dropped');
  });

  it('a PR gate that delivers another sha than the committed one is refused (policy)', async () => {
    const gates = new ScriptedGates();
    gates.prExtra = { sha: 'deadbeef' };
    const { loop, ledger } = await runToPrHold({ gates });
    await deliver(loop, ledger);
    expect((await events(ledger)).find((e) => e.kind === 'step.failed' && e.trace.stepId === 'pr')!.payload).toMatchObject({ terminal: true, failure: 'policy', reason: expect.stringMatching(/not the committed abc123/) });
    expect(loop.goal('g_fix')!.status).toBe('dropped');
  });

  it('a commit gate reporting success without a sha is a terminal policy failure (nothing to put in a PR)', async () => {
    const gates = new ScriptedGates();
    gates.commitExtra = { sha: '' };
    const { loop, ledger } = await runToPrHold({ gates });
    expect(loop.status().held).toHaveLength(0);
    expect((await events(ledger)).find((e) => e.kind === 'step.failed' && e.trace.stepId === 'commit')!.payload).toMatchObject({ terminal: true, failure: 'policy' });
  });

  it('resume refuses a grant that is not granted, is for another request, or a different action', async () => {
    const { loop, ledger, status } = await runToPrHold();
    const requestId = status.held[0]!.requestId;
    const fake: ApprovalGrant = { requestId, approver: { kind: 'human', id: 'nick' }, grantedAt: 1, expiresAt: 1e12 };
    await expect(loop.resume(requestId, fake)).rejects.toThrow(/pending, not granted/);
    await expect(loop.resume(requestId, { ...fake, requestId: 'other' })).rejects.toThrow(/grant is for other/);
    expect(loop.status().held).toHaveLength(1); // nothing changed
    void ledger;
  });
});

describe('(d) terminal gate outcomes are never retried', () => {
  it('verify exit 9 (human needed) fails once: intention.failed + goal.dropped carry the reason', async () => {
    const gates = new ScriptedGates();
    gates.verifyCodes = [9, 9, 9];
    gates.verifyExtra = { reason: 'digest-drift' };
    const { loop, ledger } = build({ gates });
    await loop.addBelief('verify.baseline', 'failing');
    await loop.adoptGoal(goalInput);
    await loop.runUntilQuiescent();
    const evs = await events(ledger);
    expect(evs.filter((e) => e.kind === 'verify.failed')).toHaveLength(1);
    expect(evs.find((e) => e.kind === 'intention.failed')!.payload).toMatchObject({ reason: 'digest-drift', terminal: true });
    expect(evs.find((e) => e.kind === 'goal.dropped')!.payload).toMatchObject({ reason: 'digest-drift', terminal: true });
  });

  it('exit 8 without a reason, review terminal:true, commit exit 9 and PR exit 9 are not retried either', async () => {
    const g8 = new ScriptedGates();
    g8.verifyCodes = [8];
    const a = build({ gates: g8 });
    await a.loop.addBelief('verify.baseline', 'failing');
    await a.loop.adoptGoal(goalInput);
    await a.loop.runUntilQuiescent();
    expect(g8.log.filter((x) => x === 'verify')).toHaveLength(1);
    expect((await events(a.ledger)).find((e) => e.kind === 'intention.failed')!.payload.reason).toBe('verify exit 8');

    const gr = new ScriptedGates();
    gr.verdict = 'reject';
    gr.reviewExtra = { terminal: true, reason: 'mutated' };
    const b = build({ gates: gr });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    await b.loop.runUntilQuiescent();
    expect(gr.log.filter((x) => x === 'review')).toHaveLength(1);
    expect((await events(b.ledger)).find((e) => e.kind === 'goal.dropped')!.payload.reason).toBe('mutated');

    const gc = new ScriptedGates();
    gc.commitCode = 9;
    gc.commitExtra = { reason: 'tree-mismatch' };
    const c = await runToPrHold({ gates: gc });
    expect(c.status.held).toHaveLength(0);
    expect(gc.log.filter((x) => x === 'commit')).toHaveLength(1);
    expect((await events(c.ledger)).find((e) => e.kind === 'intention.failed')!.payload).toMatchObject({ reason: 'tree-mismatch', terminal: true });

    const gp = new ScriptedGates();
    gp.prCode = 9;
    gp.prExtra = { reason: 'gh not authenticated and no bundle written' };
    const d = await runToPrHold({ gates: gp });
    await deliver(d.loop, d.ledger);
    expect(gp.log.filter((x) => x === 'pr')).toHaveLength(1);
    expect((await events(d.ledger)).find((e) => e.kind === 'pr.failed')!.payload).toMatchObject({ exitCode: 9 });
    expect((await events(d.ledger)).find((e) => e.kind === 'intention.failed')!.payload).toMatchObject({ terminal: true });
  });
});

describe('(e) a ledger append failure stops the run', () => {
  it('status becomes stopped with the reason; no further step runs and the error does not propagate from runUntilQuiescent', async () => {
    const ledger = new FlakyLedger();
    ledger.failOn = 'step.completed';
    const { loop, worker } = build({ ledger });
    await loop.addBelief('verify.baseline', 'failing');
    await loop.adoptGoal(goalInput);
    const status = await loop.runUntilQuiescent();
    expect(status.state).toBe('stopped');
    expect(status.stopReason).toMatch(/ledger append failed for step.completed: disk full/);
    expect(worker.calls).toHaveLength(1); // analyze ran; its completion could not be recorded; edit never ran
    await expect(loop.addBelief('x', 1)).rejects.toBeInstanceOf(LoopStopped);
    expect(await loop.tick()).toBe(false);
  });

  it('a failure while adopting a goal throws LoopStopped from adoptGoal', async () => {
    const ledger = new FlakyLedger();
    ledger.failOn = 'intention.pushed';
    const { loop } = build({ ledger });
    await loop.addBelief('verify.baseline', 'failing');
    await expect(loop.adoptGoal(goalInput)).rejects.toBeInstanceOf(LoopStopped);
    expect(loop.status().state).toBe('stopped');
  });
});

describe('(f) worker suspension: resume token persisted and used', () => {
  const suspendingWorker = (ledger: () => Ledger) => async (req: WorkerStepRequest): Promise<Outcome> => {
    if (req.step.id !== 'edit') return okOutcome();
    await ledger().requestApproval({ requestId: 'ap_w1', runId: 'r', sessionId: 's', actionHash: 'edit-hash', requester: { kind: 'agent', id: 'worker' }, reason: 'write', expiresAt: 1e12 });
    return { kind: 'suspended', request: { requestId: 'ap_w1', action: 'edit', actionHash: 'edit-hash', reason: 'write', requester: 'worker' }, resumeToken: 'tok-123', run: { runId: 'r', invokeId: 'i', depth: 0 } };
  };

  it('intention.held carries resumeToken/heldRequestId; resume() calls worker.resume(token, grant), never run() again', async () => {
    let l: Ledger;
    const b = build({ worker: suspendingWorker(() => l) });
    l = b.ledger;
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    const s = await b.loop.runUntilQuiescent();
    expect(s.held).toEqual([{ intentionId: s.intentions[0]!.id, stepId: 'edit', requestId: 'ap_w1' }]);
    const held = (await events(b.ledger)).filter((e) => e.kind === 'intention.held').pop()!;
    expect(held.payload.intention).toMatchObject({ resumeToken: 'tok-123', heldRequestId: 'ap_w1', status: 'held' });
    const grant = await grantWithAudit(b.ledger, 'ap_w1');
    await b.loop.resume('ap_w1', grant);
    expect(b.worker.resumes).toEqual([{ token: 'tok-123', grant }]);
    expect(b.worker.calls.map((c) => c.step.id)).toEqual(['analyze', 'edit']);
    expect((await b.ledger.getApproval('ap_w1'))!.state).toBe('consumed');
    expect(b.loop.beliefs.get('resumed.with')?.value).toBe('tok-123');
    expect(b.loop.status().intentions[0]!.resumeToken).toBeUndefined();
  });

  it('a worker that returns after resume without consuming the grant fails terminally', async () => {
    let l: Ledger;
    const b = build({ worker: suspendingWorker(() => l) });
    l = b.ledger;
    b.worker.onResume = async () => okOutcome();
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    await b.loop.runUntilQuiescent();
    await b.loop.resume('ap_w1', await grantWithAudit(b.ledger, 'ap_w1'));
    const failed = (await events(b.ledger)).find((e) => e.kind === 'step.failed')!;
    expect(failed.payload).toMatchObject({ terminal: true, reason: 'worker did not consume approval ap_w1' });
  });

  it('after a restart, a fresh Loop restores the held step from the SqliteLedger and resumes it with the token', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tecera-loop-')), 'l.sqlite');
    const ledger1 = new SqliteLedger(path);
    const first = build({ ledger: ledger1, worker: suspendingWorker(() => ledger1) });
    await first.loop.addBelief('verify.baseline', 'failing');
    await first.loop.adoptGoal(goalInput);
    await first.loop.runUntilQuiescent();
    ledger1.close();

    const ledger2 = new SqliteLedger(path);
    const second = build({ ledger: ledger2, worker: () => okOutcome() });
    const restored = await second.loop.restore();
    expect(restored.held).toEqual([{ intentionId: restored.intentions[0]!.id, stepId: 'edit', requestId: 'ap_w1' }]);
    const grant = await grantWithAudit(ledger2, 'ap_w1');
    await second.loop.resume('ap_w1', grant);
    expect(second.worker.resumes.map((r) => r.token)).toEqual(['tok-123']);
    const s = await second.loop.runUntilQuiescent();
    expect(s.held.map((h) => h.stepId)).toEqual(['pr']); // now held at the PR (the commit needed none)
    expect(second.gates.log).toEqual(['verify', 'review', 'verify', 'commit']);
    expect(await ledger2.verifyChain()).toMatchObject({ ok: true });
    ledger2.close();
  });
});

describe('(g)(h) validator gets the goal; payloads are JSON-safe on SqliteLedger; step tools narrow capabilities', () => {
  it('validatePlan receives (plan, manifest, goal) for generated and reused plans; invalid reused plans are rejected', async () => {
    const seen: Array<{ planId: string; goalId: string }> = [];
    const library = new MemoryPlanLibrary();
    library.accept(fivePlan('p_old'));
    const validator = {
      validatePlan: (plan: Plan, _m: Manifest, goal: AchievementGoal) => {
        seen.push({ planId: plan.id, goalId: goal.id });
        return plan.id === 'p_old' ? ['reused plan exceeds goal budget'] : [];
      },
    };
    const { loop, ledger, planner } = build({ library, validator });
    await loop.addBelief('verify.baseline', 'failing');
    await loop.adoptGoal(goalInput);
    expect(seen).toEqual([{ planId: 'p_old', goalId: 'g_fix' }, { planId: 'p_fix', goalId: 'g_fix' }]);
    expect(planner.writes).toBe(1);
    const rej = (await events(ledger)).find((e) => e.kind === 'plan.rejected')!;
    expect(rej.payload).toMatchObject({ reused: true, errors: ['reused plan exceeds goal budget'] });
    expect(loop.status().intentions[0]!.planId).toBe('p_fix');
  });

  it('a full run on SqliteLedger: every payload parses, contains no undefined, and the chain verifies', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tecera-loop-')), 'l.sqlite');
    const ledger = new SqliteLedger(path);
    const { loop, status } = await runToPrHold({ ledger });
    const rid = status.held[0]!.requestId;
    await loop.resume(rid, await grantWithAudit(ledger, rid));
    await loop.runUntilQuiescent();
    expect(loop.goal('g_fix')!.status).toBe('achieved');
    const evs = await events(ledger);
    for (const e of evs) expect(JSON.stringify(e.payload)).not.toContain('undefined');
    expect(evs.find((e) => e.kind === 'intention.pushed')!.payload.intention).not.toHaveProperty('parentIntentionId');
    expect(await ledger.verifyChain()).toMatchObject({ ok: true });
    ledger.close();
  });

  it('step.tools narrows the worker capabilities; the request carries worktree and fencing token', async () => {
    const plan = () => {
      const p = fivePlan();
      p.steps[0]!.tools = ['read'];
      return p;
    };
    const { loop, worker } = build({ plan, extra: { fencingToken: () => 7 } });
    await loop.addBelief('verify.baseline', 'failing');
    await loop.adoptGoal(goalInput);
    await loop.runUntilQuiescent();
    expect(worker.calls[0]!.capabilities.tools).toEqual(['read']);
    expect(worker.calls[1]!.capabilities.tools).toEqual(['read', 'edit', 'runVerify']);
    expect(worker.calls[0]!.worktree).toBe('/tmp/wt');
    expect(worker.calls[0]!.fencingToken).toBe(7);
  });

  it('the redact port runs on every payload', async () => {
    const { loop, ledger } = build({ extra: { redact: (v) => JSON.parse(JSON.stringify(v).replaceAll('make the failing test pass', '[REDACTED:secret:x]')) } });
    await loop.addBelief('verify.baseline', 'failing');
    await loop.adoptGoal(goalInput);
    for (const e of await events(ledger)) expect(JSON.stringify(e.payload)).not.toContain('make the failing test pass');
  });
});


// ---------- K3 wave 3: isolation, seat accounting, deadline, progress, recovery ----------

async function evs(ledger: Ledger, kind?: string): Promise<TeceraEvent[]> {
  const out: TeceraEvent[] = [];
  for await (const e of ledger.events()) if (!kind || e.kind === kind) out.push(e);
  return out;
}

describe('D6: degraded isolation is recorded, never a per-write hold; work-branch writes proceed under any isolation', () => {
  const readOnlyAnalyze = () => {
    const p = fivePlan();
    p.steps[0]!.tools = ['read'];
    return p;
  };

  it('manifest isolation "node": the writing worker step runs without a hold; the only hold is the PR, which records isolationDegraded', async () => {
    const m = manifest({ sandbox: { profile: 'process', isolation: 'node', network: false, memoryMb: 256, execTimeoutSec: 60 } });
    const b = build({ manifest: m, plan: readOnlyAnalyze });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    const s = await b.loop.runUntilQuiescent();
    expect(b.worker.calls.map((c) => c.step.id)).toEqual(['analyze', 'edit']);
    expect(s.held.map((h) => h.stepId)).toEqual(['pr']);
    const reqs = await evs(b.ledger, 'approval.requested');
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.payload).toMatchObject({ owner: 'gate', isolationDegraded: true, step: 'pr' });
    // the edit's guard authorizes its writes without any approval
    const guard = b.worker.calls[1]!.guard;
    expect(guard).toBeDefined();
  });

  it('the port can add degradation (os manifest + isolationDegraded: true) but never remove it; either way only the PR holds', async () => {
    const a = build({ plan: readOnlyAnalyze, extra: { isolationDegraded: true } });
    await a.loop.addBelief('verify.baseline', 'failing');
    await a.loop.adoptGoal(goalInput);
    expect((await a.loop.runUntilQuiescent()).held.map((h) => h.stepId)).toEqual(['pr']);
    expect((await evs(a.ledger, 'approval.requested'))[0]!.payload).toMatchObject({ isolationDegraded: true });
    const m = manifest({ sandbox: { profile: 'process', isolation: 'node', network: false, memoryMb: 256, execTimeoutSec: 60 } });
    const b = build({ manifest: m, plan: readOnlyAnalyze, extra: { isolationDegraded: false } });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    expect((await b.loop.runUntilQuiescent()).held.map((h) => h.stepId)).toEqual(['pr']);
    expect((await evs(b.ledger, 'approval.requested'))[0]!.payload).toMatchObject({ isolationDegraded: true });
  });

  it('a loop-owned hold (the gate reflex held a step) granted without its approval.granted event is never consumed: the step fails terminally', async () => {
    const rules = new RulesReflex();
    const holdEdit = {
      ask: async (seam: never, q: { state: { tool?: string; risk?: string } }) =>
        seam === 'gate' && q.state.risk === 'write' && q.state.tool === 'worker' ? { seam, answer: { decision: 'hold' }, confidence: 1, provider: 'jev', abstained: false } : rules.ask(seam, q as never),
    } as unknown as LoopPorts['reflex'];
    const b = build({ plan: readOnlyAnalyze, extra: { reflex: holdEdit } });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    const s = await b.loop.runUntilQuiescent();
    expect(s.held.map((h) => h.stepId)).toEqual(['edit']);
    expect((await evs(b.ledger, 'approval.requested'))[0]!.payload).toMatchObject({ owner: 'loop', step: 'edit' });
    const rid = s.held[0]!.requestId;
    const g = await b.ledger.approve(rid, { kind: 'human', id: 'nick' }, 's', 10); // unaudited
    await b.loop.resume(rid, g);
    expect(b.worker.calls.map((c) => c.step.id)).toEqual(['analyze']);
    const failed = (await evs(b.ledger, 'step.failed'))[0]!;
    expect(failed.payload).toMatchObject({ terminal: true, failure: 'policy', reason: expect.stringMatching(/unaudited grant/) });
  });
});

describe('seat accounting: planner calls reserve before and settle after; exhaustion is a budget failure', () => {
  const meteredPlanner = (usage: { usd: number; inputTokens: number; outputTokens: number } | null, probe?: () => Promise<void>): Planner => ({
    async write(_e, _b, _g, meter) {
      await probe?.();
      if (usage) meter?.record({ ...usage });
      return fivePlan();
    },
    async deliberate(options) {
      return options[0]!;
    },
  });

  it('the usd/tokens reservation is held during the call and settled at the metered usage after it', async () => {
    const ledger = new MemoryLedger();
    await ledger.openBudget('r', 'usd', 0.08);
    let during: unknown = null;
    const planner = meteredPlanner({ usd: 0.01, inputTokens: 100, outputTokens: 50 }, async () => {
      during = await ledger.reserve('usd', 0.04, 'r', 'probe-during').catch((e: Error) => e);
    });
    const b = build({ ledger, planner, noBudget: true });
    await ledger.openBudget('r', 'tokens', 100000); await ledger.openBudget('r', 'calls', 400);
    await b.loop.adoptGoal(goalInput);
    expect(during).toBeInstanceOf(Error); // 0.05 reserved + 0.04 > 0.08 while the call ran
    expect((during as Error).message).toMatch(/budget exceeded/);
    await expect(ledger.reserve('usd', 0.07, 'r', 'probe-after')).resolves.toBeDefined(); // settled at 0.01
    await expect(ledger.reserve('usd', 0.001, 'r', 'probe-over')).rejects.toThrow(/budget exceeded/);
    expect(b.loop.status().intentions).toHaveLength(1);
  });

  it('a planner that reports no usage is charged the full reservation (fail closed)', async () => {
    const ledger = new MemoryLedger();
    await ledger.openBudget('r', 'usd', 0.1);
    await ledger.openBudget('r', 'tokens', 100000); await ledger.openBudget('r', 'calls', 400);
    const b = build({ ledger, noBudget: true });
    await b.loop.adoptGoal(goalInput);
    await b.loop.adoptGoal({ ...goalInput, id: 'g_2' });
    await b.loop.adoptGoal({ ...goalInput, id: 'g_3' });
    expect(b.planner.writes).toBe(2);
    const dropped = (await evs(ledger, 'goal.dropped')).find((e) => e.trace.goalId === 'g_3')!;
    expect(dropped.payload).toMatchObject({ terminal: true, failure: 'budget', reason: expect.stringMatching(/^budget: /) });
  });

  it('an exhausted pool stops planning before the call: goal.dropped {failure: budget}, no plan.rejected, planner never called', async () => {
    const ledger = new MemoryLedger();
    await ledger.openBudget('r', 'usd', 0.01);
    await ledger.openBudget('r', 'tokens', 100000); await ledger.openBudget('r', 'calls', 400);
    const b = build({ ledger, noBudget: true });
    await b.loop.adoptGoal(goalInput);
    expect(b.planner.writes).toBe(0);
    const ks = await kinds(ledger);
    expect(ks).not.toContain('plan.rejected');
    expect((await evs(ledger, 'goal.dropped'))[0]!.payload).toMatchObject({ terminal: true, failure: 'budget' });
  });

  it('a run with no budget opened cannot plan at all (fail closed)', async () => {
    const b = build({ noBudget: true });
    await b.loop.adoptGoal(goalInput);
    expect(b.planner.writes).toBe(0);
    expect((await evs(b.ledger, 'goal.dropped'))[0]!.payload).toMatchObject({ failure: 'budget', reason: expect.stringMatching(/no budget opened/) });
  });

  it('a planner whose own accounting hits the budget (PlannerAccountingError with a LedgerError budget) is a budget failure, not plan.rejected', async () => {
    const err = Object.assign(new Error('usage settlement failed (write): accounting'), { name: 'PlannerAccountingError', cause: new LedgerError('budget exceeded for pool usd', 'budget') });
    const b = build({ planner: new ThrowingPlanner(err) });
    await b.loop.adoptGoal(goalInput);
    const ks = await kinds(b.ledger);
    expect(ks).not.toContain('plan.rejected');
    expect((await evs(b.ledger, 'goal.dropped'))[0]!.payload).toMatchObject({ terminal: true, failure: 'budget' });
  });

  it('planner.deliberate is metered too: an exhausted pool stops it with a budget failure', async () => {
    const library = new MemoryPlanLibrary();
    library.accept(fivePlan('p_a'));
    library.accept(fivePlan('p_b')); // equal scores: the choosePlan reflex abstains → deliberate
    const ledger = new MemoryLedger();
    await ledger.openBudget('r', 'usd', 0.01);
    await ledger.openBudget('r', 'tokens', 100000); await ledger.openBudget('r', 'calls', 400);
    const b = build({ library, ledger, noBudget: true });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    expect(b.planner.deliberations).toBe(0);
    expect((await evs(ledger, 'goal.dropped'))[0]!.payload).toMatchObject({ failure: 'budget' });
  });
});

describe('reflex seams set to model/frontier are metered like planner calls', () => {
  it('a model-backed gate seam reserves per ask; when the pool is exhausted the step fails with a budget failure', async () => {
    const m = manifest({ reflexes: { triage: 'rule', choosePlan: 'rule', route: 'rule', gate: 'model', reconsider: 'rule', closeOut: 'rule', threshold: 0.6 } });
    const ledger = new MemoryLedger();
    await ledger.openBudget('r', 'usd', 0.16); // planner.write 0.05 + two gate asks (0.15), not a third
    await ledger.openBudget('r', 'tokens', 1_000_000); await ledger.openBudget('r', 'calls', 400);
    const b = build({ manifest: m, ledger, noBudget: true });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    await b.loop.runUntilQuiescent();
    expect(b.worker.calls.map((c) => c.step.id)).toEqual(['analyze', 'edit']);
    const failed = (await evs(ledger, 'step.failed'))[0]!;
    expect(failed.trace.stepId).toBe('verify1');
    expect(failed.payload).toMatchObject({ terminal: true, failure: 'budget', reason: expect.stringMatching(/^budget: reflex.gate could not reserve usd/) });
  });
});

describe('D4: goal.achieved only with a proof built from the final verify.passed evidence', () => {
  it('no gate.verify evidence on the ledger → the goal stays open (intention done, a note says why); no goal.achieved', async () => {
    const gates = new ScriptedGates();
    gates.writeEvidence = false;
    const { loop, ledger } = await runToPrHold({ gates });
    await deliver(loop, ledger);
    expect(loop.goal('g_fix')!.status).toBe('open');
    expect(await kinds(ledger)).not.toContain('goal.achieved');
    const notes = (await eventsOf(ledger, 'intention.advanced')).map((e) => String(e.payload.note ?? '')).filter(Boolean);
    expect(notes.pop()).toMatch(/goal stays open: verify evidence .* is missing/);
  });

  it('verify evidence of another command than the goal check never proves the goal', async () => {
    const gates = new ScriptedGates();
    gates.evidenceCommand = 'true';
    const { loop, ledger } = await runToPrHold({ gates });
    await deliver(loop, ledger);
    expect(loop.goal('g_fix')!.status).toBe('open');
    const notes = (await eventsOf(ledger, 'intention.advanced')).map((e) => String(e.payload.note ?? '')).filter(Boolean);
    expect(notes.pop()).toMatch(/ran another command than the goal check/);
  });

  it('a read-only plan (verify only) is achieved on its proof without commit or PR', async () => {
    const plan = (): Plan => ({ ...fivePlan('p_ro'), steps: [{ id: 'look', kind: 'worker', dependsOn: [], inputs: {}, tools: ['read'] }, { id: 'verify1', kind: 'gate.verify', dependsOn: ['look'], inputs: {} }], allowedModels: {}, permissions: { tools: ['read'], write: [], approvals: [] } });
    const b = build({ plan });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    await b.loop.runUntilQuiescent();
    const g = b.loop.goal('g_fix')!;
    expect(g.status).toBe('achieved');
    expect(g.proof).toMatchObject({ command: 'npm test', exitCode: 0 });
    expect((await eventsOf(b.ledger, 'goal.achieved'))[0]!.payload.proof).toMatchObject({ evidenceKey: expect.stringMatching(/^verify-/) });
  });

  it('the derivation agrees with the loop: deriveGoalStatus re-derives achieved from the run, with the same proof', async () => {
    const { deriveGoalStatus } = await import('@tecera/contracts');
    const { loop, ledger } = await runToPrHold();
    await deliver(loop, ledger);
    const all: Array<TeceraEvent & { seq: number; hash: string }> = [];
    for await (const e of ledger.events()) all.push(e);
    const d = deriveGoalStatus(all, await ledger.listEvidence!('r'), { approvals: [(await ledger.getApproval((await eventsOf(ledger, 'approval.requested'))[0]!.payload.requestId as string))!] });
    expect(d.goals.g_fix).toMatchObject({ status: 'achieved', agrees: true, proof: { sha: 'abc123', prUrl: 'https://example.test/pr/1', achievement: loop.goal('g_fix')!.proof } });
  });
});

describe('D2: frontier escalation is on by default in the loop (LoopPorts.frontier)', () => {
  const rules = new RulesReflex();
  /** A reflex that is unsure about one seam (abstains with its rule answer). */
  const unsureAbout = (seam: string): LoopPorts['reflex'] =>
    ({
      ask: async (s: never, q: never) => {
        const r = await rules.ask(s, q);
        return s === seam ? { ...r, abstained: true, confidence: 0 } : r;
      },
    }) as unknown as LoopPorts['reflex'];

  it('an unsure route answer escalates to the frontier, whose pick (an offered seat) is used and recorded', async () => {
    const asked: string[] = [];
    const frontier = { decide: async <S extends 'route'>(seam: S) => (asked.push(seam), { seam, answer: { seatId: 'strong' }, confidence: 0.9, provider: 'frontier', abstained: false }) as never };
    const b = build({ extra: { reflex: unsureAbout('route'), frontier } });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    await b.loop.runUntilQuiescent();
    expect(asked).toEqual(['route', 'route']);
    // analyze may only run on 'cheap' (the frontier's 'strong' is not offered there); edit takes the frontier's pick
    expect(b.worker.calls.map((x) => `${x.step.id}:${x.seatId}`)).toEqual(['analyze:cheap', 'edit:strong']);
    const recs = await evs(b.ledger, 'decision.recorded');
    expect(recs.map((e) => e.payload)).toEqual([
      expect.objectContaining({ seam: 'route', provider: 'frontier', outcome: 'escalated', via: 'loop', answer: { seatId: 'cheap' } }),
      expect.objectContaining({ seam: 'route', provider: 'frontier', outcome: 'escalated', via: 'loop', answer: { seatId: 'strong' } }),
    ]);
  });

  it('the frontier may tighten a gate answer, never loosen it; an out-of-options pick is ignored', async () => {
    const block = { decide: async <S extends 'gate'>(seam: S) => ({ seam, answer: { decision: 'block' }, confidence: 1, provider: 'frontier', abstained: false }) as never };
    const b = build({ extra: { reflex: unsureAbout('gate'), frontier: block } });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    await b.loop.runUntilQuiescent();
    expect(b.worker.calls).toHaveLength(0);
    expect((await evs(b.ledger, 'step.failed'))[0]!.payload).toMatchObject({ step: 'analyze', blocked: true });
    expect((await evs(b.ledger, 'decision.recorded'))[0]!.payload).toMatchObject({ seam: 'gate', provider: 'frontier', outcome: 'escalated', answer: { decision: 'block' } });
    // a frontier answering allow where the (unsure) rule answer is hold keeps the hold
    const allow = { decide: async <S extends 'gate'>(seam: S) => ({ seam, answer: { decision: 'allow' }, confidence: 1, provider: 'frontier', abstained: false }) as never };
    const c = build({ extra: { reflex: unsureAbout('gate'), frontier: allow } });
    await c.loop.addBelief('verify.baseline', 'failing');
    await c.loop.adoptGoal(goalInput);
    const st = await c.loop.runUntilQuiescent();
    expect(st.held.map((h) => h.stepId)).toEqual(['pr']);
    const prGate = (await evs(c.ledger, 'decision.recorded')).find((e) => (e.payload.from as { decision?: string }).decision === 'hold')!;
    expect(prGate.payload).toMatchObject({ answer: { decision: 'hold' } });
    // a route pick outside the offered seats is ignored
    const rogue = { decide: async <S extends 'route'>(seam: S) => ({ seam, answer: { seatId: 'opus-unlisted' }, confidence: 1, provider: 'frontier', abstained: false }) as never };
    const d = build({ extra: { reflex: unsureAbout('route'), frontier: rogue } });
    await d.loop.addBelief('verify.baseline', 'failing');
    await d.loop.adoptGoal(goalInput);
    await d.loop.runUntilQuiescent();
    expect(d.worker.calls.map((x) => x.seatId)).toEqual(['cheap', 'cheap']);
  });

  it('without a frontier port the unsure answer stands (no escalation, nothing recorded by the loop)', async () => {
    const b = build({ extra: { reflex: unsureAbout('route') } });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    await b.loop.runUntilQuiescent();
    expect(await evs(b.ledger, 'decision.recorded')).toHaveLength(0);
    expect(b.worker.calls.map((x) => x.seatId)).toEqual(['cheap', 'cheap']);
  });
});

describe('D3: budgets are off by default — exhaustion is recorded (budget.exhausted) and the run continues', () => {
  it('soft pools: planner calls past the usd cap still run and settle; budget.exhausted is recorded once per pool; the run reaches the PR', async () => {
    const ledger = new MemoryLedger();
    const m = manifest();
    expect(m.budgets.enforce).toBe(false);
    await ledger.openBudget('r', 'usd', 0.01, { enforce: false });
    await ledger.openBudget('r', 'tokens', 100000, { enforce: false });
    await ledger.openBudget('r', 'calls', 400, { enforce: false });
    const b = build({ ledger, manifest: m, noBudget: true });
    await b.loop.start('h');
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    await b.loop.adoptGoal({ ...goalInput, id: 'g_2' });
    expect(b.planner.writes).toBe(2);
    const ex = await evs(ledger, 'budget.exhausted');
    expect(ex).toHaveLength(1);
    expect(ex[0]!.payload).toMatchObject({ pool: 'usd', enforced: false, cap: 0.01, purpose: 'planner.write' });
    expect((await evs(ledger, 'goal.dropped'))).toHaveLength(0);
    const st = await b.loop.runUntilQuiescent();
    expect(st.held.map((h) => h.stepId)).toEqual(['pr', 'pr']);
    // usage is still recorded: the reservations were settled
    const usage = await ledger.budgetUsage('r');
    expect(usage.find((u) => u.pool === 'usd')).toMatchObject({ enforce: false, cap: 0.01 });
    expect(usage.find((u) => u.pool === 'usd')!.used).toBeGreaterThan(0.01);
  });

  it('a passed run deadline is recorded once (pool wallClock) and neither cancels a step nor fails one; a restore past it fails nothing', async () => {
    let clock = 1000;
    const ledger = new MemoryLedger();
    const b = build({ ledger, extra: { now: () => clock } });
    await b.loop.start('h');
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    clock = 1000 + 600_000 + 1;
    let signal: AbortSignal | undefined;
    b.worker.onRun = (sg) => {
      signal = sg;
    };
    const st = await b.loop.runUntilQuiescent();
    expect(b.worker.calls.map((c) => c.step.id)).toEqual(['analyze', 'edit']);
    expect(signal?.aborted).toBe(false);
    expect(st.held.map((h) => h.stepId)).toEqual(['pr']);
    const ex = await evs(ledger, 'budget.exhausted');
    expect(ex).toHaveLength(1);
    expect(ex[0]!.payload).toMatchObject({ pool: 'wallClock', enforced: false, deadline: 601_000 });
    expect(await kinds(ledger)).not.toContain('step.failed');
    // restore past the deadline keeps the PR hold
    const c = build({ ledger, extra: { now: () => clock } });
    const restored = await c.loop.restore();
    expect(restored.held.map((h) => h.stepId)).toEqual(['pr']);
    expect(c.loop.goal('g_fix')!.status).toBe('open');
    // and the run still delivers
    await c.loop.resume(restored.held[0]!.requestId, await grantWithAudit(ledger, restored.held[0]!.requestId));
    expect(c.loop.goal('g_fix')!.status).toBe('achieved');
  });

  it('loop-safety limits stay enforced with budgets off: maxAttempts still ends a failing intention', async () => {
    const gates = new ScriptedGates();
    gates.verifyCodes = [1, 1, 1, 1];
    const b = build({ gates });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    await b.loop.runUntilQuiescent();
    expect(gates.calls.verify).toBe(2);
    expect(b.loop.goal('g_fix')!.status).toBe('dropped');
  });
});

describe('durable run deadline (wallClockSec) with budgets.enforce true', () => {
  it('run.started records the deadline; past it, dispatch fails the step with a terminal budget failure', async () => {
    let clock = 1000;
    const b = build({ manifest: enforcing(), extra: { now: () => clock } });
    await b.loop.start('h');
    const started = (await evs(b.ledger, 'run.started'))[0]!;
    expect(started.payload).toMatchObject({ deadline: 1000 + 600_000, wallClockSec: 600 });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    clock = 1000 + 600_000;
    await b.loop.runUntilQuiescent();
    expect(b.worker.calls).toHaveLength(0);
    expect((await evs(b.ledger, 'step.failed'))[0]!.payload).toMatchObject({ terminal: true, failure: 'budget', reason: 'budget: run deadline exceeded' });
    expect((await evs(b.ledger, 'goal.dropped'))[0]!.payload).toMatchObject({ failure: 'budget' });
    // and no more planner calls either
    await b.loop.adoptGoal({ ...goalInput, id: 'g_late' });
    expect(b.planner.writes).toBe(1);
  });

  it('a step whose result arrives after the deadline is a budget failure, not progress', async () => {
    let clock = 0;
    const b = build({
      manifest: enforcing(),
      extra: { now: () => clock },
      worker: async (req) => {
        if (req.step.id === 'analyze') clock = 10_000_000;
        return okOutcome();
      },
    });
    await b.loop.start('h');
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    await b.loop.runUntilQuiescent();
    expect(b.worker.calls.map((c) => c.step.id)).toEqual(['analyze']);
    expect((await evs(b.ledger, 'step.failed'))[0]!.payload).toMatchObject({ failure: 'budget' });
    expect(await kinds(b.ledger)).not.toContain('step.completed');
  });

  it('the deadline aborts the running step through its AbortSignal', async () => {
    const m = enforcing({ wallClockSec: 1 });
    let aborted = false;
    let signal: AbortSignal | undefined;
    const b = build({
      manifest: m,
      extra: { now: () => Date.now() },
      // a well-behaved worker: stops when its signal aborts (else it would run 5 s)
      worker: (req) =>
        new Promise<Outcome>((resolve) => {
          const t = setTimeout(() => resolve(okOutcome()), 5000);
          signal?.addEventListener('abort', () => {
            aborted = true;
            clearTimeout(t);
            resolve({ kind: 'aborted', reasons: [{ code: 'cancelled', reason: String(signal?.reason), hookId: 'test' }], run: { runId: req.runId, invokeId: 'x', depth: 0 } });
          });
        }),
    });
    b.worker.onRun = (s) => {
      signal = s;
    };
    await b.loop.start('h');
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    const t0 = Date.now();
    await b.loop.runUntilQuiescent();
    expect(aborted).toBe(true);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect((await evs(b.ledger, 'step.failed'))[0]!.payload).toMatchObject({ failure: 'budget' });
  }, 10_000);

  it('restore enforces the recorded deadline even when the new process has a longer wallClockSec', async () => {
    let clock = 0;
    const ledger = new MemoryLedger();
    const gates = new ScriptedGates();
    const a = build({ ledger, gates, manifest: enforcing(), extra: { now: () => clock } });
    await a.loop.start('h');
    await a.loop.addBelief('verify.baseline', 'failing');
    await a.loop.adoptGoal(goalInput);
    await a.loop.runUntilQuiescent(); // held at the PR
    clock = 600_001;
    const longer = enforcing({ wallClockSec: 100_000 });
    const b = build({ ledger, manifest: longer, extra: { now: () => clock } });
    const st = await b.loop.restore();
    expect(st.deadline).toBe(600_000);
    expect(st.held).toHaveLength(0);
    expect(st.recovered).toEqual([expect.objectContaining({ action: 'failed', reason: 'run deadline exceeded' })]);
    expect(b.loop.goal('g_fix')!.status).toBe('dropped');
    expect((await evs(ledger, 'goal.dropped')).pop()!.payload).toMatchObject({ failure: 'budget' });
  });
});

describe('progressCheck (ADV-8): equal candidate fingerprints across attempts stop for a human', () => {
  it('two attempts with the same verify fingerprint → verify.failed {noProgress}, step/intention/goal failure "human", not a plain verify failure', async () => {
    const gates = new ScriptedGates();
    gates.verifyCodes = [1, 1, 1];
    gates.fps = ['fp-same', 'fp-same', 'fp-same'];
    const b = build({ gates });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    await b.loop.runUntilQuiescent();
    const verifies = [...(await evs(b.ledger, 'verify.failed')), ...(await evs(b.ledger, 'verify.passed'))];
    expect(verifies).toHaveLength(2);
    expect(verifies[1]!.payload).toMatchObject({ attempt: 2, noProgress: true, failure: 'human', terminal: true });
    const failed = (await evs(b.ledger, 'step.failed')).pop()!;
    expect(failed.payload).toMatchObject({ terminal: true, failure: 'human', reason: expect.stringMatching(/^no progress: attempts 1 and 2/) });
    expect((await evs(b.ledger, 'intention.failed'))[0]!.payload).toMatchObject({ failure: 'human' });
    expect((await evs(b.ledger, 'goal.dropped'))[0]!.payload).toMatchObject({ failure: 'human', reason: expect.stringMatching(/no progress/) });
  });

  it('a new candidate on the retry is progress (ordinary retry), and the same fingerprint within one attempt is not compared', async () => {
    const gates = new ScriptedGates();
    gates.verifyCodes = [1, 0, 0];
    gates.fps = ['fp-a', 'fp-b', 'fp-b'];
    const b = build({ gates });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    const s = await b.loop.runUntilQuiescent();
    expect(s.held.map((h) => h.stepId)).toEqual(['pr']); // verify1 (attempt 2) and verify2 share fp-b, reviewed and committed
  });
});

describe('lease loss stops the loop (compose finding)', () => {
  it('the lease signal aborts the running step and nothing else is dispatched', async () => {
    const lease = new AbortController();
    let signal: AbortSignal | undefined;
    const b = build({
      extra: { leaseSignal: lease.signal },
      worker: (req) =>
        new Promise<Outcome>((resolve) => {
          signal?.addEventListener('abort', () => resolve({ kind: 'aborted', reasons: [{ code: 'cancelled', reason: 'lease', hookId: 't' }], run: { runId: req.runId, invokeId: 'x', depth: 0 } }));
        }),
    });
    b.worker.onRun = (s) => {
      signal = s;
      setTimeout(() => lease.abort(new Error('renewal failed')), 5);
    };
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    const s = await b.loop.runUntilQuiescent();
    expect(signal?.aborted).toBe(true);
    expect(s.state).toBe('stopped');
    expect(s.stopReason).toMatch(/^lease lost: renewal failed/);
    expect(b.worker.calls.map((c) => c.step.id)).toEqual(['analyze']);
    expect(b.gates.log).toEqual([]);
  });

  it('a fencing token that disappears or changes stops dispatch; the PR is never handed out', async () => {
    let token: number | undefined = 7;
    const b = build({ extra: { fencingToken: () => token } });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    const s1 = await b.loop.runUntilQuiescent();
    const rid = s1.held[0]!.requestId;
    token = 8; // another holder re-leased the worktree
    await expect(b.loop.resume(rid, await grantWithAudit(b.ledger, rid))).rejects.toBeInstanceOf(LoopStopped);
    const s2 = b.loop.status();
    expect(s2.state).toBe('stopped');
    expect(s2.stopReason).toMatch(/fencing token changed 7 → 8/);
    expect(b.gates.log).not.toContain('pr');
    expect((await b.ledger.getApproval(rid))!.state).toBe('granted'); // unspent

    let t2: number | undefined = 3;
    const c = build({ extra: { fencingToken: () => t2 } });
    await c.loop.addBelief('verify.baseline', 'failing');
    await c.loop.adoptGoal(goalInput);
    t2 = undefined;
    const s3 = await c.loop.runUntilQuiescent();
    expect(s3.stopReason).toMatch(/no fencing token/);
    expect(c.worker.calls).toHaveLength(0);
  });
});

describe('Loop.restore(): recovery of non-held work at each crash point (security.md §4 S2–S9)', () => {
  /** Run loop 1 until it reaches the crash point (a call that never returns), then hand the ledger to a fresh loop. */
  async function crash(opts: Parameters<typeof build>[0], reached: Promise<void>) {
    const a = build(opts);
    await a.loop.start('h');
    await a.loop.addBelief('verify.baseline', 'failing', { src: 'preflight', trust: 'trusted' });
    await a.loop.adoptGoal(goalInput);
    void a.loop.runUntilQuiescent();
    await reached;
    return a;
  }
  /** Run loop 1 until a ledger write fails at the window (the process dies before that event exists). */
  async function crashOnAppend(failWhen: (e: TeceraEvent) => boolean, opts: Parameters<typeof build>[0] = {}) {
    const ledger = new FlakyLedger();
    let armed = true;
    const orig = ledger.append.bind(ledger);
    ledger.append = async (e: TeceraEvent) => {
      if (armed && failWhen(e)) {
        armed = false;
        throw new Error('power cut');
      }
      return orig(e);
    };
    const a = build({ ...opts, ledger });
    await a.loop.start('h');
    await a.loop.addBelief('verify.baseline', 'failing', { src: 'preflight', trust: 'trusted' });
    await a.loop.adoptGoal(goalInput);
    const s = await a.loop.runUntilQuiescent();
    return { a, ledger, s };
  }
  const restart = (ledger: Ledger, opts: Parameters<typeof build>[0] = {}) => build({ ...opts, ledger });

  it('S2 worker running: step.interrupted + evidence; with no checkpoint the worktree must go back to base, every uncheckpointed writing step re-runs, nothing dispatches until the restore is confirmed, then exactly one commit', async () => {
    const reached = deferred();
    const a = await crash({ worker: (req) => (req.step.id === 'edit' ? (reached.resolve(), never<Outcome>()) : okOutcome()) }, reached.promise);
    const b = restart(a.ledger);
    const st = await b.loop.restore();
    const iid = st.intentions[0]!.id;
    expect(st.recovered).toEqual([expect.objectContaining({ stepId: 'edit', action: 'restart' })]);
    const intr = (await evs(a.ledger, 'step.interrupted'))[0]!;
    expect(intr.payload).toMatchObject({ step: 'edit', kind: 'worker', action: 'restart' });
    expect(await a.ledger.getEvidence(intr.payload.evidenceKey as string)).toMatchObject({ kind: 'step.interrupted', body: { stepId: 'edit', attempt: 1 } });
    // analyze may write (its tools include edit) and was never checkpointed: its effects go with the worktree too
    expect(st.requiredWorktreeState).toEqual({ [iid]: expect.objectContaining({ checkpointId: 'base', stepId: 'edit', attempt: 2, reset: ['analyze', 'edit'] }) });
    expect(st.dispatchable).toBe(0);
    await b.loop.runUntilQuiescent();
    expect(b.worker.calls).toHaveLength(0); // refuses to dispatch before the runtime restored the worktree
    await expect(b.loop.confirmWorktreeRestored(iid, 'cp-other')).rejects.toThrow(/needs its worktree at base/);
    await b.loop.confirmWorktreeRestored(iid, 'base');
    expect(b.loop.status().requiredWorktreeState).toBeUndefined();
    const s = await b.loop.runUntilQuiescent();
    expect(b.worker.calls.map((c) => `${c.step.id}@${c.intention.attempt}`)).toEqual(['analyze@2', 'edit@2']);
    expect(s.held.map((h) => h.stepId)).toEqual(['pr']);
    await b.loop.resume(s.held[0]!.requestId, await grantWithAudit(a.ledger, s.held[0]!.requestId));
    expect(b.gates.calls.commit).toBe(1);
    expect(await evs(a.ledger, 'commit.recorded')).toHaveLength(1);
    expect(b.loop.goal('g_fix')!.status).toBe('achieved');
  });

  it('S2 with worktree checkpoints: the restore target is the checkpoint after the last completed step, only the interrupted step re-runs; an unconfirmed restore survives another restart', async () => {
    const reached = deferred();
    const cps: string[] = [];
    const worktreeCheckpoint = async (x: { stepId: string; attempt: number; reason: string }) => {
      const id = `cp-${x.stepId}-${x.attempt}-${x.reason}`;
      cps.push(id);
      return id;
    };
    const a = await crash({ extra: { worktreeCheckpoint }, worker: (req) => (req.step.id === 'edit' ? (reached.resolve(), never<Outcome>()) : okOutcome()) }, reached.promise);
    expect(cps).toEqual(['cp-analyze-1-completed']);
    expect((await evs(a.ledger, 'step.completed'))[0]!.payload).toMatchObject({ step: 'analyze', worktreeCheckpoint: 'cp-analyze-1-completed' });
    const b = restart(a.ledger, { extra: { worktreeCheckpoint } });
    const st = await b.loop.restore();
    const iid = st.intentions[0]!.id;
    expect(st.requiredWorktreeState![iid]).toMatchObject({ checkpointId: 'cp-analyze-1-completed', reset: ['edit'] });
    // the process dies again before the runtime confirmed: a third process still refuses to dispatch
    const c = restart(a.ledger, { extra: { worktreeCheckpoint } });
    const st2 = await c.loop.restore();
    expect(st2.requiredWorktreeState![iid]).toMatchObject({ checkpointId: 'cp-analyze-1-completed', stepId: 'edit' });
    await c.loop.runUntilQuiescent();
    expect(c.worker.calls).toHaveLength(0);
    await c.loop.confirmWorktreeRestored(iid, 'cp-analyze-1-completed');
    const s = await c.loop.runUntilQuiescent();
    expect(c.worker.calls.map((x) => `${x.step.id}@${x.intention.attempt}`)).toEqual(['edit@2']);
    expect(s.held.map((h) => h.stepId)).toEqual(['pr']);
    // after the confirmation a fourth process is not blocked
    const d = restart(a.ledger, { extra: { worktreeCheckpoint } });
    expect((await d.loop.restore()).requiredWorktreeState).toBeUndefined();
  });

  it('S2: a checkpoint port that fails fails the step terminally ("human"): a write that cannot be checkpointed cannot be recovered', async () => {
    const b = build({ extra: { worktreeCheckpoint: async () => { throw new Error('git write-tree failed'); } } });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    await b.loop.runUntilQuiescent();
    expect((await evs(b.ledger, 'step.failed'))[0]!.payload).toMatchObject({ step: 'analyze', terminal: true, failure: 'human', reason: expect.stringMatching(/worktree checkpoint failed/) });
    expect(b.gates.log).toEqual([]);
  });

  it('S2 attempts exhausted: an interrupted worker with no attempt left fails (exit path "interrupted"), never re-runs', async () => {
    const reached = deferred();
    const m = manifest({ budgets: { usd: 2, tokens: 100000, wallClockSec: 600, maxDepth: 3, maxIterations: 10, maxAttempts: 1, maxChangedFiles: 5 } });
    const a = await crash({ manifest: m, worker: (req) => (req.step.id === 'analyze' ? (reached.resolve(), never<Outcome>()) : okOutcome()) }, reached.promise);
    const b = restart(a.ledger, { manifest: m });
    await b.loop.restore();
    await b.loop.runUntilQuiescent();
    expect(b.worker.calls).toHaveLength(0);
    expect((await evs(a.ledger, 'step.failed')).pop()!.payload).toMatchObject({ terminal: true, reason: expect.stringMatching(/^interrupted: /) });
  });

  it('S3 window: edit completed but the intention snapshot never followed — the completion is honoured and verify runs next', async () => {
    const { a, s } = await crashOnAppend((e) => e.kind === 'intention.advanced' && e.payload.completed === 'edit');
    expect(s.state).toBe('stopped');
    const b = restart(a.ledger);
    const st = await b.loop.restore();
    expect(st.intentions[0]!.stepStatus).toMatchObject({ analyze: 'done', edit: 'done', verify1: 'pending' });
    await b.loop.runUntilQuiescent();
    expect(b.worker.calls).toHaveLength(0); // edit is not redone
    expect(b.gates.log).toEqual(['verify', 'review', 'verify', 'commit']);
  });

  it('S4 verify running: verify.interrupted evidence, the verify re-runs with ctx.recovered, the run proceeds', async () => {
    const reached = deferred();
    const gates = new ScriptedGates();
    gates.hang = { on: 'verify', call: 1, reached };
    const a = await crash({ gates }, reached.promise);
    const b = restart(a.ledger);
    const st = await b.loop.restore();
    expect(st.recovered).toEqual([expect.objectContaining({ stepId: 'verify1', action: 're-dispatch' })]);
    const vi = (await evs(a.ledger, 'verify.interrupted'))[0]!;
    expect(vi.payload).toMatchObject({ step: 'verify1', attempt: 1 });
    expect(await a.ledger.getEvidence(vi.payload.evidenceKey as string)).toMatchObject({ kind: 'verify.interrupted' });
    const s = await b.loop.runUntilQuiescent();
    expect(b.gates.contexts[0]!.recovered).toBe(true);
    expect(b.gates.contexts[1]!.recovered).toBeUndefined();
    expect(s.held.map((h) => h.stepId)).toEqual(['pr']);
  });

  it('S5 review lost (ADV-5): no recorded verdict and review.maxAttempts 1 → a terminal "human" failure; the reviewer is NOT asked again; no commit approval, no commit', async () => {
    const reached = deferred();
    const gates = new ScriptedGates();
    gates.hang = { on: 'review', call: 1, reached };
    const a = await crash({ gates }, reached.promise);
    const b = restart(a.ledger);
    const st = await b.loop.restore();
    expect(st.recovered).toEqual([expect.objectContaining({ stepId: 'review', action: 'failed' })]);
    expect((await evs(a.ledger, 'step.interrupted'))[0]!.payload).toMatchObject({ step: 'review', kind: 'gate.review', action: 'human' });
    await b.loop.runUntilQuiescent();
    expect(b.gates.calls.review).toBe(0);
    expect(b.gates.log).toEqual([]);
    const failed = (await evs(a.ledger, 'step.failed')).pop()!;
    expect(failed.trace.stepId).toBe('review');
    expect(failed.payload).toMatchObject({ terminal: true, failure: 'human', reason: expect.stringMatching(/review interrupted with no recorded verdict/) });
    expect((await evs(a.ledger, 'intention.failed'))[0]!.payload).toMatchObject({ failure: 'human' });
    expect((await evs(a.ledger, 'goal.dropped'))[0]!.payload).toMatchObject({ failure: 'human' });
    expect(await evs(a.ledger, 'approval.requested')).toHaveLength(0);
    expect(await evs(a.ledger, 'commit.recorded')).toHaveLength(0);
    expect((await evs(a.ledger, 'review.started')).map((e) => e.payload.d1)).toEqual(['fp-1']);
  });

  it('S5 review lost with review.maxAttempts 2: one more reviewer call is allowed (ctx.recovered, same D1); losing that one too stops for a human', async () => {
    const m = manifest({ review: { foreign: true, maxAttempts: 2 } });
    const reached = deferred();
    const gates = new ScriptedGates();
    gates.hang = { on: 'review', call: 1, reached };
    const a = await crash({ gates, manifest: m }, reached.promise);
    const b = restart(a.ledger, { manifest: m });
    const st = await b.loop.restore();
    expect(st.recovered).toEqual([expect.objectContaining({ stepId: 'review', action: 're-dispatch' })]);
    await b.loop.runUntilQuiescent();
    expect(b.gates.log).toEqual(['review', 'verify', 'commit']);
    expect(b.gates.contexts[0]!).toMatchObject({ recovered: true, candidate: { d1: 'fp-1' } });

    const reached2 = deferred();
    const g2 = new ScriptedGates();
    g2.hang = { on: 'review', call: 1, reached: reached2 };
    const a2 = await crash({ gates: g2, manifest: m }, reached2.promise);
    const reached3 = deferred();
    const b2 = restart(a2.ledger, { manifest: m });
    b2.gates.hang = { on: 'review', call: 1, reached: reached3 };
    await b2.loop.restore();
    void b2.loop.runUntilQuiescent();
    await reached3.promise; // the second reviewer call is lost as well
    const c2 = restart(a2.ledger, { manifest: m });
    await c2.loop.restore();
    await c2.loop.runUntilQuiescent();
    expect(c2.gates.calls.review).toBe(0);
    expect((await evs(a2.ledger, 'step.failed')).pop()!.payload).toMatchObject({ terminal: true, failure: 'human' });
  });

  it('S5 window: the gate recorded its verdict for (run, D1) but review.passed was lost → the recorded verdict is reused, no reviewer call; an unusable record is a "human" stop, never a second call', async () => {
    const reached = deferred();
    const gates = new ScriptedGates();
    gates.hang = { on: 'review', call: 1, reached };
    const a = await crash({ gates }, reached.promise);
    await a.ledger.evidence({ key: reviewEvidenceKey('r', 'fp-1'), kind: 'gate.review', runId: 'r', body: { verdict: 'approve', terminal: false, fingerprintBefore: 'fp-1', fingerprintAfter: 'fp-1' } });
    const b = restart(a.ledger);
    b.worker.tree.version = a.worker.tree.version; // same worktree after the restart
    const st = await b.loop.restore();
    expect(st.recovered).toEqual([expect.objectContaining({ stepId: 'review', action: 're-dispatch' })]);
    const s = await b.loop.runUntilQuiescent();
    expect(b.gates.calls.review).toBe(0);
    expect(b.gates.log).toEqual(['verify', 'commit']);
    expect((await evs(a.ledger, 'review.passed')).pop()!.payload).toMatchObject({ reused: true, evidenceKey: 'review:r:fp-1' });
    expect(s.held.map((h) => h.stepId)).toEqual(['pr']);

    const r2 = deferred();
    const g2 = new ScriptedGates();
    g2.hang = { on: 'review', call: 1, reached: r2 };
    const x = await crash({ gates: g2 }, r2.promise);
    // the tree changed during the lost review (after ≠ before): not reusable, and not a reason to ask again
    await x.ledger.evidence({ key: reviewEvidenceKey('r', 'fp-1'), kind: 'gate.review', runId: 'r', body: { verdict: 'approve', terminal: false, fingerprintBefore: 'fp-1', fingerprintAfter: 'fp-mutated' } });
    const y = restart(x.ledger);
    await y.loop.restore();
    await y.loop.runUntilQuiescent();
    expect(y.gates.calls.review).toBe(0);
    expect((await evs(x.ledger, 'step.failed')).pop()!.payload).toMatchObject({ terminal: true, failure: 'human' });
  });

  it('S5 window: review.passed recorded but step.completed lost — the recorded verdict is reused, the reviewer is never asked twice', async () => {
    const { a } = await crashOnAppend((e) => e.kind === 'step.completed' && e.trace.stepId === 'review');
    expect(a.gates.calls.review).toBe(1);
    const b = restart(a.ledger);
    b.worker.tree.version = a.worker.tree.version; // same worktree after the restart
    const st = await b.loop.restore();
    expect(st.recovered).toEqual([expect.objectContaining({ stepId: 'review', action: 'completed' })]);
    const s = await b.loop.runUntilQuiescent();
    expect(b.gates.log).toEqual(['verify', 'commit']); // only verify2 (and the commit); no second review
    expect(s.held.map((h) => h.stepId)).toEqual(['pr']);
  });

  it('S4 window: verify.failed recorded but step.failed lost — the recorded outcome is reused (no second verify for that attempt)', async () => {
    const gates = new ScriptedGates();
    gates.verifyCodes = [1];
    const { a } = await crashOnAppend((e) => e.kind === 'step.failed' && e.trace.stepId === 'verify1', { gates });
    const g2 = new ScriptedGates();
    g2.fps = ['fp-new'];
    const b = restart(a.ledger, { gates: g2 });
    const st = await b.loop.restore();
    expect(st.recovered).toEqual([expect.objectContaining({ stepId: 'verify1', action: 'completed' })]);
    expect(st.intentions[0]!).toMatchObject({ attempt: 2, stepStatus: { verify1: 'pending' } });
    await b.loop.runUntilQuiescent();
    expect(g2.log).toEqual(['verify', 'review', 'verify', 'commit']); // the retry (attempt 2) only
  });

  it('S6 final verify running: the re-run must reproduce D1; equal → proceeds to the commit hold', async () => {
    const reached = deferred();
    const gates = new ScriptedGates();
    gates.hang = { on: 'verify', call: 2, reached };
    const a = await crash({ gates }, reached.promise);
    const g2 = new ScriptedGates();
    g2.fps = ['fp-1'];
    const b = restart(a.ledger, { gates: g2 });
    const st = await b.loop.restore();
    expect(st.recovered![0]).toMatchObject({ stepId: 'verify2', reason: expect.stringMatching(/reproduce D1/) });
    const s = await b.loop.runUntilQuiescent();
    expect(s.held.map((h) => h.stepId)).toEqual(['pr']);
  });

  it('S6 digest drift: a re-run verify whose fingerprint differs from D1 is a terminal "human" failure', async () => {
    const reached = deferred();
    const gates = new ScriptedGates();
    gates.hang = { on: 'verify', call: 2, reached };
    const a = await crash({ gates }, reached.promise);
    const g2 = new ScriptedGates();
    g2.fps = ['fp-tampered'];
    const b = restart(a.ledger, { gates: g2 });
    await b.loop.restore();
    await b.loop.runUntilQuiescent();
    expect((await evs(a.ledger, 'step.failed')).pop()!.payload).toMatchObject({ terminal: true, failure: 'human', reason: expect.stringMatching(/digest drift/) });
    expect(g2.log).toEqual(['verify']);
    expect(b.loop.goal('g_fix')!.status).toBe('dropped');
  });

  it('S7 (ADV-6): crash between approval.requested and step.held of the PR — restore re-holds durably and the grant resumes it', async () => {
    const { a } = await crashOnAppend((e) => e.kind === 'step.held');
    const rid = (await evs(a.ledger, 'approval.requested'))[0]!.payload.requestId as string;
    // the human approves while the run is down
    await grantWithAudit(a.ledger, rid);
    const b = restart(a.ledger);
    const st = await b.loop.restore();
    expect(st.held).toEqual([{ intentionId: st.intentions[0]!.id, stepId: 'pr', requestId: rid }]);
    expect((await evs(a.ledger, 'step.held')).pop()!.payload).toMatchObject({ requestId: rid, recovered: true });
    expect((await evs(a.ledger, 'intention.held')).pop()!.payload).toMatchObject({ requestId: rid, recovered: true });
    // a third process also finds the hold (now from the durable events), resumes and opens the PR once
    const c = restart(a.ledger);
    const st2 = await c.loop.restore();
    expect(st2.held.map((h) => h.requestId)).toEqual([rid]);
    const view = (await a.ledger.getApproval(rid))!;
    await c.loop.resume(rid, { requestId: rid, approver: view.approver!, grantedAt: 10, expiresAt: view.expiresAt });
    await c.loop.runUntilQuiescent();
    expect(c.gates.log).toEqual(['pr']);
    expect(c.gates.contexts[0]!.commit).toMatchObject({ sha: 'abc123', d1: 'fp-1' });
    expect(c.loop.goal('g_fix')!.status).toBe('achieved');
  });

  it('S7 expiry of the PR hold: recorded; a fresh approval is requested for the SAME commit (its sha cannot change), without re-verifying or re-committing; one PR', async () => {
    let clock = 0;
    const ledger = new MemoryLedger();
    // a deadline longer than the approval ttl (900 s), so only the approval expires
    const m = manifest({ budgets: { usd: 2, tokens: 100000, wallClockSec: 10_000, maxDepth: 3, maxIterations: 10, maxAttempts: 2, maxChangedFiles: 5 } });
    const a = build({ ledger, manifest: m, extra: { now: () => ++clock } });
    await a.loop.start('h');
    await a.loop.addBelief('verify.baseline', 'failing');
    await a.loop.adoptGoal(goalInput);
    const s1 = await a.loop.runUntilQuiescent();
    const rid = s1.held[0]!.requestId;
    const first = (await evs(ledger, 'approval.requested'))[0]!;
    expect(first.payload).toMatchObject({ candidateD1: 'abc123', attempt: 1 });
    clock += 900_000 + 1; // ttl 900 s
    const b = restart(ledger, { manifest: m, extra: { now: () => ++clock } });
    const st = await b.loop.restore();
    expect(st.recovered).toEqual([expect.objectContaining({ stepId: 'pr', action: 'expired', reason: expect.stringMatching(/same commit/) })]);
    expect((await evs(ledger, 'approval.expired'))[0]!.payload).toMatchObject({ requestId: rid });
    const s2 = await b.loop.runUntilQuiescent();
    expect(b.gates.log).toEqual([]); // nothing re-verified, re-reviewed or re-committed
    expect(s2.held).toHaveLength(1);
    expect(s2.held[0]!.requestId).not.toBe(rid);
    const fresh = (await evs(ledger, 'approval.requested')).pop()!;
    expect(fresh.payload).toMatchObject({ candidateD1: 'abc123', actionHash: first.payload.actionHash });
    await b.loop.resume(s2.held[0]!.requestId, await grantWithAudit(ledger, s2.held[0]!.requestId, clock));
    expect(b.gates.calls.pr).toBe(1);
    expect(await evs(ledger, 'pr.opened')).toHaveLength(1);
    expect(await evs(ledger, 'commit.recorded')).toHaveLength(1);
    expect(b.loop.goal('g_fix')!.status).toBe('achieved');
    await expect(grantWithAudit(ledger, rid, clock)).rejects.toThrow(); // the expired request can never be granted (so never consumed)
    expect((await ledger.getApproval(rid))!.state).toBe('expired');
  });

  /** A gate reflex that holds the commit (a model gate may): the hold is loop-owned and its expiry goes back to verify. */
  const holdCommit = (): LoopPorts['reflex'] => {
    const rules = new RulesReflex();
    return {
      ask: async (seam: never, q: { state: { tool?: string } }) =>
        seam === 'gate' && q.state.tool === 'gate.commit' ? { seam, answer: { decision: 'hold' }, confidence: 1, provider: 'jev', abstained: false } : rules.ask(seam, q as never),
    } as unknown as LoopPorts['reflex'];
  };

  it('S7 expiry of a loop-owned commit hold (a model gate held it): back to S3 — verify re-runs and must equal D1 BEFORE a fresh approval; the review is not repeated; then the commit and the PR hold', async () => {
    let clock = 0;
    const ledger = new MemoryLedger();
    const m = manifest({ budgets: { usd: 2, tokens: 100000, wallClockSec: 10_000, maxDepth: 3, maxIterations: 10, maxAttempts: 2, maxChangedFiles: 5 } });
    const a = build({ ledger, manifest: m, extra: { now: () => ++clock, reflex: holdCommit() } });
    await a.loop.start('h');
    await a.loop.addBelief('verify.baseline', 'failing');
    await a.loop.adoptGoal(goalInput);
    const s1 = await a.loop.runUntilQuiescent();
    expect(s1.held.map((h) => h.stepId)).toEqual(['commit']);
    const rid = s1.held[0]!.requestId;
    expect((await evs(ledger, 'approval.requested'))[0]!.payload).toMatchObject({ owner: 'loop', candidateD1: 'fp-1' });
    clock += 900_001;
    const b = restart(ledger, { manifest: m, extra: { now: () => ++clock, reflex: holdCommit() } });
    b.gates.fps = ['fp-1']; // the tree did not change while the approval waited
    const st = await b.loop.restore();
    expect(st.recovered).toEqual([expect.objectContaining({ stepId: 'commit', action: 'expired', reason: expect.stringMatching(/back to verify2/) })]);
    const s2 = await b.loop.runUntilQuiescent();
    expect(b.gates.log).toEqual(['verify']); // re-frozen and re-verified; no second review
    expect(b.gates.contexts[0]).toMatchObject({ recovered: true, step: { id: 'verify2' } });
    expect(s2.held.map((h) => h.stepId)).toEqual(['commit']);
    expect(s2.held[0]!.requestId).not.toBe(rid);
    await b.loop.resume(s2.held[0]!.requestId, await grantWithAudit(ledger, s2.held[0]!.requestId, clock));
    const s3 = await b.loop.runUntilQuiescent();
    expect(b.gates.calls.commit).toBe(1);
    expect(s3.held.map((h) => h.stepId)).toEqual(['pr']);
  });

  it('S7 expiry of a loop-owned commit hold with a mutation while it waited: the re-verify fingerprint differs from D1 → terminal "human", no fresh approval, no commit', async () => {
    let clock = 0;
    const ledger = new MemoryLedger();
    const m = manifest({ budgets: { usd: 2, tokens: 100000, wallClockSec: 10_000, maxDepth: 3, maxIterations: 10, maxAttempts: 2, maxChangedFiles: 5 } });
    const a = build({ ledger, manifest: m, extra: { now: () => ++clock, reflex: holdCommit() } });
    await a.loop.start('h');
    await a.loop.addBelief('verify.baseline', 'failing');
    await a.loop.adoptGoal(goalInput);
    await a.loop.runUntilQuiescent();
    clock += 900_001;
    const b = restart(ledger, { manifest: m, extra: { now: () => ++clock, reflex: holdCommit() } });
    b.gates.fps = ['fp-mutated'];
    await b.loop.restore();
    const s = await b.loop.runUntilQuiescent();
    expect(s.held).toHaveLength(0);
    expect(await evs(ledger, 'approval.requested')).toHaveLength(1);
    expect((await evs(ledger, 'verify.failed')).pop()!.payload).toMatchObject({ failure: 'human', reason: expect.stringMatching(/digest drift/) });
    expect(b.gates.calls.commit).toBe(0);
  });

  it('S7 expiry while live: resume() with an expired PR approval throws ApprovalExpired, never consumes it, and requests a fresh approval for the same commit', async () => {
    let clock = 0;
    const m = manifest({ budgets: { usd: 2, tokens: 100000, wallClockSec: 10_000, maxDepth: 3, maxIterations: 10, maxAttempts: 2, maxChangedFiles: 5 } });
    const b = build({ manifest: m, extra: { now: () => ++clock } });
    await b.loop.start('h');
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    const s1 = await b.loop.runUntilQuiescent();
    const rid = s1.held[0]!.requestId;
    const grant = await grantWithAudit(b.ledger, rid, clock);
    clock += 900_001;
    await expect(b.loop.resume(rid, grant)).rejects.toBeInstanceOf(ApprovalExpired);
    expect((await evs(b.ledger, 'approval.expired'))[0]!.payload).toMatchObject({ requestId: rid });
    const s2 = await b.loop.runUntilQuiescent();
    expect(b.gates.log).toEqual(['verify', 'review', 'verify', 'commit']);
    expect(s2.held.map((h) => h.stepId)).toEqual(['pr']);
    expect(s2.held[0]!.requestId).not.toBe(rid);
    expect((await b.ledger.getApproval(rid))!.state).not.toBe('consumed');
    expect(b.gates.calls.pr).toBe(0);
  });

  it('S7 denied while down: terminal policy failure, nothing runs', async () => {
    const ledger = new MemoryLedger();
    const a = build({ ledger });
    await a.loop.addBelief('verify.baseline', 'failing');
    await a.loop.adoptGoal(goalInput);
    const rid = (await a.loop.runUntilQuiescent()).held[0]!.requestId;
    await ledger.deny(rid, { kind: 'human', id: 'nick' }, 'no', 10);
    const b = restart(ledger);
    await b.loop.restore();
    await b.loop.runUntilQuiescent();
    expect(b.gates.log).toEqual([]);
    expect((await evs(ledger, 'step.failed')).pop()!.payload).toMatchObject({ terminal: true, failure: 'policy', reason: `approval ${rid} denied` });
  });

  /** The process dies inside the commit gate (no approval involved, D6). */
  async function commitCrash(gatesB: ScriptedGates) {
    const reached = deferred();
    const gates = new ScriptedGates();
    gates.hang = { on: 'commit', call: 1, reached };
    const a = await crash({ gates }, reached.promise);
    const b = restart(a.ledger, { gates: gatesB });
    b.worker.tree.version = a.worker.tree.version;
    return { a, b, gates };
  }

  it('S8 (ADV-7): the process died inside the commit gate — restore reconciles, records the commit once, never re-commits; the PR hold follows', async () => {
    const g2 = new ScriptedGates().withReconcile(() => ({ recorded: true, sha: 'abc123', evidenceKey: 'reconcile-1' }));
    const { a, b, gates } = await commitCrash(g2);
    const st = await b.loop.restore();
    expect(st.recovered).toEqual([expect.objectContaining({ stepId: 'commit', action: 'reconciled' })]);
    expect(g2.reconciles).toHaveLength(1);
    expect(g2.reconciles[0]!).toMatchObject({ recovered: true });
    expect(g2.reconciles[0]!.approval).toBeUndefined();
    expect(g2.log).toEqual([]); // commit() never called again
    expect(gates.calls.commit).toBe(1);
    const recs = await evs(a.ledger, 'commit.recorded');
    expect(recs).toHaveLength(1);
    expect(recs[0]!.payload).toMatchObject({ sha: 'abc123', reconciled: true, valid: true, d1: 'fp-1' });
    expect(recs[0]!.idemKey).toBe('commit.recorded:r:abc123');
    expect(await evs(a.ledger, 'approval.consumed')).toHaveLength(0);
    // item 6: a duplicate restore never double-commits or double-records
    const g3 = new ScriptedGates().withReconcile(() => ({ recorded: true, sha: 'abc123' }));
    const c = restart(a.ledger, { gates: g3 });
    const st3 = await c.loop.restore();
    expect(st3.recovered).toEqual([]);
    const s = await c.loop.runUntilQuiescent();
    expect(g3.reconciles).toHaveLength(0);
    expect(g3.log).toEqual([]);
    expect(s.held.map((h) => h.stepId)).toEqual(['pr']);
    expect(await evs(a.ledger, 'commit.recorded')).toHaveLength(1);
    await c.loop.resume(s.held[0]!.requestId, await grantWithAudit(a.ledger, s.held[0]!.requestId));
    expect(c.loop.goal('g_fix')!.status).toBe('achieved');
    expect(await a.ledger.verifyChain()).toMatchObject({ ok: true });
  });

  it('S8 unprovable: reconcile says not recorded → terminal "human" failure; without a reconcile port → "human" too', async () => {
    const g2 = new ScriptedGates().withReconcile(() => ({ recorded: false, reason: 'HEAD^{tree} differs from the recorded write-tree' }));
    const x = await commitCrash(g2);
    await x.b.loop.restore();
    expect((await evs(x.a.ledger, 'step.failed')).pop()!.payload).toMatchObject({ terminal: true, failure: 'human', reason: expect.stringMatching(/write-tree/) });
    expect(await evs(x.a.ledger, 'commit.recorded')).toHaveLength(0);
    expect(g2.log).toEqual([]);

    const y = await commitCrash(new ScriptedGates());
    await y.b.loop.restore();
    expect((await evs(y.a.ledger, 'step.failed')).pop()!.payload).toMatchObject({ terminal: true, failure: 'human', reason: expect.stringMatching(/cannot reconcile/) });
    expect(y.b.gates.log).toEqual([]);
  });

  it('S8 with the @tecera/gates reconcile shape: CommitResult exit 0 + sha records; null (no intent) or exit 9 is a "human" failure', async () => {
    const ok = await commitCrash(new ScriptedGates().withReconcile(() => ({ exitCode: 0, sha: 'abc123', evidenceKey: 'final', terminal: false }) as unknown as GateReconcileResult));
    await ok.b.loop.restore();
    expect((await evs(ok.a.ledger, 'commit.recorded'))[0]!.payload).toMatchObject({ sha: 'abc123', reconciled: true });
    expect((await ok.b.loop.runUntilQuiescent()).held.map((h) => h.stepId)).toEqual(['pr']);
    for (const answer of [null, { exitCode: 9, evidenceKey: 'x', terminal: true, reason: 'reconcile-tree-mismatch' }, { exitCode: 0, evidenceKey: 'x' }]) {
      const x = await commitCrash(new ScriptedGates().withReconcile(() => answer as unknown as GateReconcileResult));
      await x.b.loop.restore();
      expect(await evs(x.a.ledger, 'commit.recorded')).toHaveLength(0);
      expect((await evs(x.a.ledger, 'step.failed')).pop()!.payload).toMatchObject({ terminal: true, failure: 'human' });
    }
  });

  /** The process dies inside the PR gate, before or after it spent its grant. */
  async function prCrash(afterConsume: boolean) {
    const reached = deferred();
    const gates = new ScriptedGates();
    gates.hang = { on: 'pr', call: 1, reached, afterConsume };
    const a = build({ gates });
    await a.loop.start('h');
    await a.loop.addBelief('verify.baseline', 'failing');
    await a.loop.adoptGoal(goalInput);
    const rid = (await a.loop.runUntilQuiescent()).held[0]!.requestId;
    void a.loop.resume(rid, await grantWithAudit(a.ledger, rid));
    await reached.promise;
    const b = restart(a.ledger);
    return { a, b, rid };
  }

  it('PR interrupted before it spent its grant: held again; the same grant opens the PR exactly once', async () => {
    const { a, b, rid } = await prCrash(false);
    expect((await a.ledger.getApproval(rid))!.state).toBe('granted');
    const st = await b.loop.restore();
    expect(st.held.map((h) => h.requestId)).toEqual([rid]);
    expect(st.recovered).toEqual([expect.objectContaining({ stepId: 'pr', action: 'held' })]);
    const view = (await a.ledger.getApproval(rid))!;
    await b.loop.resume(rid, { requestId: rid, approver: view.approver!, grantedAt: 10, expiresAt: view.expiresAt });
    await b.loop.runUntilQuiescent();
    expect(b.gates.log).toEqual(['pr']);
    expect(await evs(a.ledger, 'pr.opened')).toHaveLength(1);
    expect(b.loop.goal('g_fix')!.status).toBe('achieved');
  });

  it('PR interrupted after it spent its grant, outcome unrecorded: a terminal "human" failure — never a second push or PR without a person', async () => {
    const { a, b, rid } = await prCrash(true);
    expect((await a.ledger.getApproval(rid))!.state).toBe('consumed');
    const st = await b.loop.restore();
    expect(st.recovered).toEqual([expect.objectContaining({ stepId: 'pr', action: 'failed' })]);
    await b.loop.runUntilQuiescent();
    expect(b.gates.log).toEqual([]);
    expect((await evs(a.ledger, 'step.failed')).pop()!.payload).toMatchObject({ terminal: true, failure: 'human', reason: expect.stringMatching(/check the remote and open PRs for abc123/) });
    expect(await evs(a.ledger, 'pr.opened')).toHaveLength(0);
  });

  it('S8/S9 windows: commit.recorded written but step.completed lost → completed on restore without calling the gate; pr.opened written but step.completed lost → completed too; a second restore is a no-op', async () => {
    const ledger = new FlakyLedger();
    const b1 = build({ ledger });
    await b1.loop.addBelief('verify.baseline', 'failing');
    await b1.loop.adoptGoal(goalInput);
    ledger.failOn = 'step.completed';
    ledger.failStep = 'commit';
    await b1.loop.runUntilQuiescent();
    expect(b1.loop.status().state).toBe('stopped');
    expect(await evs(ledger, 'commit.recorded')).toHaveLength(1);
    ledger.failOn = undefined;
    const g2 = new ScriptedGates().withReconcile(() => ({ recorded: true, sha: 'abc123' }));
    const b2 = restart(ledger, { gates: g2 });
    const st = await b2.loop.restore();
    expect(st.recovered).toEqual([expect.objectContaining({ stepId: 'commit', action: 'completed' })]);
    expect(g2.reconciles).toHaveLength(0);
    const s = await b2.loop.runUntilQuiescent();
    expect(g2.log).toEqual([]);
    const rid = s.held[0]!.requestId;
    ledger.failOn = 'step.completed';
    ledger.failStep = 'pr';
    await b2.loop.resume(rid, await grantWithAudit(ledger, rid)).catch(() => undefined);
    expect(await evs(ledger, 'pr.opened')).toHaveLength(1);
    ledger.failOn = undefined;
    const b3 = restart(ledger);
    const st3 = await b3.loop.restore();
    expect(st3.recovered).toEqual([expect.objectContaining({ stepId: 'pr', action: 'completed' })]);
    expect(b3.gates.log).toEqual([]);
    expect(b3.loop.goal('g_fix')!.status).toBe('achieved');
    const b4 = restart(ledger);
    expect((await b4.loop.restore()).recovered).toEqual([]);
    expect(await evs(ledger, 'commit.recorded')).toHaveLength(1);
    expect(await evs(ledger, 'pr.opened')).toHaveLength(1);
    expect(await evs(ledger, 'goal.achieved')).toHaveLength(1);
  });

  it('S2 resumed worker interrupted before it spent its grant: with a suspension checkpoint it is held again (token kept) behind a restore to that checkpoint; the same grant resumes it only after the confirmation', async () => {
    const ledger = new MemoryLedger();
    const worktreeCheckpoint = async (x: { stepId: string; reason: string }) => `cp-${x.stepId}-${x.reason}`;
    const suspend = async (req: WorkerStepRequest): Promise<Outcome> => {
      if (req.step.id !== 'edit') return okOutcome();
      await ledger.requestApproval({ requestId: 'ap_w9', runId: 'r', sessionId: 's', actionHash: 'edit-hash', requester: { kind: 'agent', id: 'worker' }, reason: 'write', expiresAt: 1e12 });
      return { kind: 'suspended', request: { requestId: 'ap_w9', action: 'edit', actionHash: 'edit-hash', reason: 'write', requester: 'worker' }, resumeToken: 'tok-9', run: { runId: 'r', invokeId: 'i', depth: 0 } };
    };
    const a = build({ ledger, worker: suspend, extra: { worktreeCheckpoint } });
    await a.loop.addBelief('verify.baseline', 'failing');
    await a.loop.adoptGoal(goalInput);
    await a.loop.runUntilQuiescent();
    expect((await evs(ledger, 'step.held'))[0]!.payload).toMatchObject({ requestId: 'ap_w9', worktreeCheckpoint: 'cp-edit-suspended' });
    const reached = deferred();
    a.worker.onResume = () => (reached.resolve(), never<Outcome>());
    void a.loop.resume('ap_w9', await grantWithAudit(ledger, 'ap_w9'));
    await reached.promise;
    const b = restart(ledger, { extra: { worktreeCheckpoint } });
    const st = await b.loop.restore();
    const iid = st.intentions[0]!.id;
    expect(st.held).toEqual([{ intentionId: iid, stepId: 'edit', requestId: 'ap_w9' }]);
    expect(st.intentions[0]!.resumeToken).toBe('tok-9');
    expect(st.requiredWorktreeState![iid]).toMatchObject({ checkpointId: 'cp-edit-suspended', stepId: 'edit', reset: [] });
    const view = (await ledger.getApproval('ap_w9'))!;
    const grant = { requestId: 'ap_w9', approver: view.approver!, grantedAt: 10, expiresAt: view.expiresAt };
    await expect(b.loop.resume('ap_w9', grant)).rejects.toThrow(/worktree/);
    expect(b.worker.resumes).toHaveLength(0);
    await b.loop.confirmWorktreeRestored(iid, 'cp-edit-suspended');
    await b.loop.resume('ap_w9', grant);
    expect(b.worker.resumes.map((r) => r.token)).toEqual(['tok-9']);
    expect((await ledger.getApproval('ap_w9'))!.state).toBe('consumed');
  });

  it('S2 resumed worker interrupted without a suspension checkpoint is not resumed: it restarts behind a restore to the last checkpoint (base), its unspent grant is never used', async () => {
    const ledger = new MemoryLedger();
    const suspend = async (req: WorkerStepRequest): Promise<Outcome> => {
      if (req.step.id !== 'edit') return okOutcome();
      await ledger.requestApproval({ requestId: 'ap_w8', runId: 'r', sessionId: 's', actionHash: 'edit-hash', requester: { kind: 'agent', id: 'worker' }, reason: 'write', expiresAt: 1e12 }).catch(() => undefined);
      return { kind: 'suspended', request: { requestId: 'ap_w8', action: 'edit', actionHash: 'edit-hash', reason: 'write', requester: 'worker' }, resumeToken: 'tok-8', run: { runId: 'r', invokeId: 'i', depth: 0 } };
    };
    const a = build({ ledger, worker: suspend });
    await a.loop.addBelief('verify.baseline', 'failing');
    await a.loop.adoptGoal(goalInput);
    await a.loop.runUntilQuiescent();
    const reached = deferred();
    a.worker.onResume = () => (reached.resolve(), never<Outcome>());
    void a.loop.resume('ap_w8', await grantWithAudit(ledger, 'ap_w8'));
    await reached.promise;
    const b = restart(ledger);
    const st = await b.loop.restore();
    const iid = st.intentions[0]!.id;
    expect(st.held).toEqual([]);
    expect(st.recovered).toEqual([expect.objectContaining({ stepId: 'edit', action: 'restart' })]);
    expect(st.requiredWorktreeState![iid]).toMatchObject({ checkpointId: 'base', reset: ['analyze', 'edit'] });
    expect(b.worker.resumes).toHaveLength(0);
    expect((await ledger.getApproval('ap_w8'))!.state).toBe('granted');
  });

  it('S9: every step done but intention.done never written → closed and the goal settled on restore', async () => {
    const plan = () => ({ ...fivePlan('p_s9'), steps: [{ id: 'verify1', kind: 'gate.verify' as const, dependsOn: [], inputs: {} }], allowedModels: {} });
    const { a } = await crashOnAppend((e) => e.kind === 'intention.done', { plan });
    const b = restart(a.ledger, { plan });
    const st = await b.loop.restore();
    expect(st.recovered).toEqual([expect.objectContaining({ action: 'completed' })]);
    expect(b.loop.goal('g_fix')!.status).toBe('achieved');
  });

  it('crash between step.failed and the retry snapshot: the retry decision is finished on restore', async () => {
    const gates = new ScriptedGates();
    gates.verifyCodes = [1, 0, 0];
    const { a } = await crashOnAppend((e) => e.kind === 'intention.advanced' && e.payload.retry === 'verify1', { gates });
    const g2 = new ScriptedGates();
    g2.fps = ['fp-new']; // the retry verifies a new candidate (an equal one would be "no progress")
    const b = restart(a.ledger, { gates: g2 });
    const st = await b.loop.restore();
    expect(st.intentions[0]!).toMatchObject({ attempt: 2, stepStatus: { verify1: 'pending' } });
    const s = await b.loop.runUntilQuiescent();
    expect(s.held.map((h) => h.stepId)).toEqual(['pr']);
  });

  it('S1/deliberation window: the process died during planner.write — restore deliberates again (reserved), then the run proceeds', async () => {
    const reached = deferred();
    const hanging: Planner = {
      async write() {
        reached.resolve();
        return never<Plan>();
      },
      async deliberate(o) {
        return o[0]!;
      },
    };
    const a = build({ planner: hanging });
    await a.loop.start('h');
    await a.loop.addBelief('verify.baseline', 'failing');
    void a.loop.adoptGoal(goalInput);
    await reached.promise;
    const b = restart(a.ledger);
    const st = await b.loop.restore();
    expect(st.recovered).toEqual([expect.objectContaining({ kind: 'goal', goalId: 'g_fix', action: 're-deliberate' })]);
    expect(b.planner.writes).toBe(1);
    expect((await b.loop.runUntilQuiescent()).held.map((h) => h.stepId)).toEqual(['pr']);
    // a goal that already has an intention (even a finished one) is never re-planned
    const c = restart(a.ledger);
    await c.loop.restore();
    expect(c.planner.writes).toBe(0);
  });

  it('restore refuses another run id and a non-fresh loop', async () => {
    const b = build();
    await expect(b.loop.restore('other')).rejects.toThrow(/run r/);
    await b.loop.adoptGoal(goalInput);
    await expect(b.loop.restore()).rejects.toThrow(/fresh Loop/);
  });

  it('S8 on SqliteLedger across a real reopen: reconciled once, chain verifies, then the PR delivers', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tecera-loop-')), 'l.sqlite');
    const l1 = new SqliteLedger(path);
    const reached = deferred();
    const gates = new ScriptedGates();
    gates.hang = { on: 'commit', call: 1, reached };
    const a = build({ ledger: l1, gates });
    await a.loop.start('h');
    await a.loop.addBelief('verify.baseline', 'failing');
    await a.loop.adoptGoal(goalInput);
    void a.loop.runUntilQuiescent();
    await reached.promise;
    const l2 = new SqliteLedger(path);
    const g2 = new ScriptedGates().withReconcile(() => ({ recorded: true, sha: 'abc123' }));
    const b = build({ ledger: l2, gates: g2 });
    await b.loop.restore();
    expect(await evs(l2, 'commit.recorded')).toHaveLength(1);
    await deliver(b.loop, l2);
    expect(b.loop.goal('g_fix')!.status).toBe('achieved');
    expect(await l2.verifyChain()).toMatchObject({ ok: true });
    l1.close();
    l2.close();
  });
});

// keep type imports used
void (0 as unknown as Intention);

// ---------- wave 4: mutation-time fencing, per-write approval, seat accounting, ADV-8 precision ----------

describe('mutation-time fencing: one live guard per step, checked at each mutation (next-steps 5)', () => {
  it('lease lost after the worker entered: the next guard.check() and authorizeWrite throw FenceLost, so no write can follow the revocation', async () => {
    const lease = new AbortController();
    const proceed = deferred();
    const entered = deferred();
    const seen: { before?: boolean; after?: unknown; write?: unknown; signal?: boolean } = {};
    const b = build({
      extra: { leaseSignal: lease.signal },
      worker: async (req) => {
        if (req.step.id !== 'analyze') return okOutcome();
        req.guard!.check();
        seen.before = true;
        entered.resolve();
        await proceed.promise;
        try {
          req.guard!.check();
        } catch (e) {
          seen.after = e;
        }
        try {
          req.guard!.authorizeWrite!({ path: 'src/a.ts', contentDigest: 'd' });
        } catch (e) {
          seen.write = e;
        }
        seen.signal = req.guard!.signal.aborted;
        return okOutcome();
      },
    });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    const run = b.loop.runUntilQuiescent();
    await entered.promise;
    lease.abort(new Error('renewal failed'));
    proceed.resolve();
    const s = await run;
    expect(seen.before).toBe(true);
    expect(seen.after).toBeInstanceOf(FenceLost);
    expect(seen.write).toBeInstanceOf(FenceLost);
    expect(seen.signal).toBe(true);
    expect(s.state).toBe('stopped');
    expect(b.worker.calls.map((c) => c.step.id)).toEqual(['analyze']);
  });

  it('the fencing token changes inside the commit gate (after its entry check): ctx.guard.check() throws, the loop stops, nothing is recorded as committed', async () => {
    let token = 7;
    const gates = new ScriptedGates();
    let gateErr: unknown;
    let mutated = false;
    gates.commit = async (ctx: GateContext) => {
      gates.calls.commit++;
      token = 8; // another holder took the worktree lease while the gate ran
      try {
        ctx.guard!.check();
        mutated = true;
      } catch (e) {
        gateErr = e;
      }
      return { exitCode: 8, evidenceKey: 'c', reason: 'fence lost', terminal: true };
    };
    const b = build({ gates, extra: { fencingToken: () => token } });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    await b.loop.runUntilQuiescent(); // the commit needs no approval (D6): it runs in this pass
    expect(gates.calls.commit).toBe(1);
    expect(gateErr).toBeInstanceOf(FenceLost);
    expect(String((gateErr as Error).message)).toMatch(/fencing token changed 7 → 8/);
    expect(mutated).toBe(false);
    expect(b.loop.status().state).toBe('stopped');
    expect(await evs(b.ledger, 'commit.recorded')).toHaveLength(0);
  });

  it('a guard outlives nothing: once its step finished (or the intention was dropped) every check fails', async () => {
    const guards: WriteGuard[] = [];
    const b = build({ worker: (req) => (guards.push(req.guard!), okOutcome()) });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    await b.loop.runUntilQuiescent();
    expect(guards).toHaveLength(2);
    for (const g of guards) expect(() => g.check()).toThrow(FenceLost);
    expect(b.gates.contexts.every((c) => c.guard !== undefined)).toBe(true);
  });

  it('authorizeWrite answers "allowed" (after the fence check) for any write', async () => {
    let auth: unknown;
    const b = build({ worker: (req) => ((auth = req.step.id === 'edit' ? req.guard!.authorizeWrite!({ path: 'src/a.ts', contentDigest: 'd' }) : auth), okOutcome()) });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    await b.loop.runUntilQuiescent();
    expect(auth).toEqual({ kind: 'allowed' });
  });
});

describe('D6: no per-write approvals — work-branch writes proceed under any isolation, fenced by the guard', () => {
  const nodeManifest = () => manifest({ sandbox: { profile: 'process', isolation: 'node', network: false, memoryMb: 256, execTimeoutSec: 60 } });
  const A = { path: 'src/a.ts', contentDigest: 'da' };
  const B = { path: 'src/b.ts', contentDigest: 'db' };

  it('under node isolation the guard authorizes every write ("allowed") without a suspension; the only hold of the run is the PR', async () => {
    const auths: unknown[] = [];
    const b = build({
      manifest: nodeManifest(),
      worker: (req) => {
        if (req.step.id === 'edit') for (const w of [A, B, A]) auths.push(req.guard!.authorizeWrite!(w));
        return okOutcome();
      },
    });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    const s = await b.loop.runUntilQuiescent();
    expect(auths).toEqual([{ kind: 'allowed' }, { kind: 'allowed' }, { kind: 'allowed' }]);
    expect(s.held.map((h) => h.stepId)).toEqual(['pr']);
    expect(await evs(b.ledger, 'approval.requested')).toHaveLength(1);
  });

  it('the guard still fences: once the loop stopped (lease lost), authorizeWrite throws FenceLost', async () => {
    const lease = new AbortController();
    let after: unknown;
    const b = build({
      manifest: nodeManifest(),
      extra: { leaseSignal: lease.signal },
      worker: (req) => {
        if (req.step.id === 'edit') {
          lease.abort(new Error('renewal failed'));
          try {
            req.guard!.authorizeWrite!(A);
          } catch (e) {
            after = e;
          }
        }
        return okOutcome();
      },
    });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    await b.loop.runUntilQuiescent();
    expect(after).toBeInstanceOf(FenceLost);
  });

  it('a worker suspension asking approval for a write is refused (terminal "policy"), never held', async () => {
    const b = build({
      manifest: nodeManifest(),
      worker: (req) =>
        req.step.id === 'edit'
          ? { kind: 'suspended', request: { requestId: 'wr-1', action: 'writeFile', actionHash: 'h', reason: 'write src/a.ts', requester: 'worker', write: A }, resumeToken: 'tok', run: { runId: 'r', invokeId: 'i', depth: 0 } }
          : okOutcome(),
    });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    const s = await b.loop.runUntilQuiescent();
    expect(s.held).toEqual([]);
    expect((await evs(b.ledger, 'step.failed')).pop()!.payload).toMatchObject({ step: 'edit', terminal: true, failure: 'policy', reason: expect.stringMatching(/per-write approvals were removed/) });
    expect(b.gates.calls.commit).toBe(0);
  });
});

describe('seat accounting: calls pool, cancellation, accounting failures terminate the run (next-steps 12)', () => {
  const pools = async (ledger: MemoryLedger, caps: { usd?: number; tokens?: number; calls?: number }) => {
    for (const [p, c] of Object.entries({ usd: 10, tokens: 1e6, calls: 400, ...caps })) await ledger.openBudget('r', p, c);
  };

  it('every planner call reserves one "calls": a 1-call pool plans the first goal and refuses the second (failure "budget"), the planner is not called', async () => {
    const ledger = new MemoryLedger();
    await pools(ledger, { calls: 1 });
    const b = build({ ledger, noBudget: true });
    await b.loop.adoptGoal(goalInput);
    await b.loop.adoptGoal({ ...goalInput, id: 'g_2' });
    expect(b.planner.writes).toBe(1);
    expect((await evs(ledger, 'goal.dropped')).find((e) => e.trace.goalId === 'g_2')!.payload).toMatchObject({ terminal: true, failure: 'budget', reason: expect.stringMatching(/calls/) });
  });

  it('start() opens the calls pool but never widens a cap the runtime already set', async () => {
    const ledger = new MemoryLedger();
    await pools(ledger, { calls: 1 });
    const b = build({ ledger, noBudget: true });
    await b.loop.start('h');
    await b.loop.adoptGoal(goalInput);
    await b.loop.adoptGoal({ ...goalInput, id: 'g_2' });
    expect(b.planner.writes).toBe(1);
    const c = build({ ledger: new MemoryLedger(), manifest: enforcing() });
    await c.loop.start('h');
    await expect(c.ledger.reserve('calls', 401, 'r', 'probe')).rejects.toThrow(/budget exceeded/);
    // D3: with budgets off the loop opens a soft calls pool: past the cap it records, never refuses
    const d = build({ ledger: new MemoryLedger(), noBudget: true });
    await d.loop.start('h');
    const over = await d.ledger.reserve('calls', 401, 'r', 'probe');
    expect(over.exhausted).toEqual({ used: 0, cap: 400 });
    expect((await d.ledger.budgetUsage('r')).find((u) => u.pool === 'calls')).toMatchObject({ enforce: false, cap: 400 });
  });

  it('unknown usage (all zeros) settles at the reservation, never zero', async () => {
    const ledger = new MemoryLedger();
    await pools(ledger, { usd: 0.1 });
    const planner: Planner = { write: async (_e, _b, _g, meter) => (meter?.record({ inputTokens: 0, outputTokens: 0, usd: 0 }), fivePlan()), deliberate: async (o) => o[0]! };
    const b = build({ ledger, noBudget: true, planner });
    await b.loop.adoptGoal(goalInput);
    await b.loop.adoptGoal({ ...goalInput, id: 'g_2' });
    await b.loop.adoptGoal({ ...goalInput, id: 'g_3' });
    expect((await evs(ledger, 'goal.dropped')).find((e) => e.trace.goalId === 'g_3')!.payload).toMatchObject({ failure: 'budget' });
  });

  it('a settle failure terminates the run: status stopped with failure "ledger", the goal dropped with failure "ledger", no plan staged', async () => {
    class SettleFails extends MemoryLedger {
      override async settle(): Promise<void> {
        throw new LedgerError('database is locked', 'io');
      }
    }
    const ledger = new SettleFails();
    await pools(ledger, {});
    const b = build({ ledger, noBudget: true });
    await expect(b.loop.adoptGoal(goalInput)).rejects.toBeInstanceOf(LoopStopped);
    const s = b.loop.status();
    expect(s).toMatchObject({ state: 'stopped', failure: 'ledger', stopReason: expect.stringMatching(/^accounting failure: .*could not settle/) });
    expect((await evs(ledger, 'goal.dropped'))[0]!.payload).toMatchObject({ terminal: true, failure: 'ledger' });
    expect(await kinds(ledger)).not.toContain('plan.generated');
    expect(await kinds(ledger)).not.toContain('plan.rejected');
  });

  it('a non-budget reserve failure terminates the run the same way (never a plan rejection, the planner never called)', async () => {
    class ReserveFails extends MemoryLedger {
      override async reserve(pool: string, amount: number, runId: string, idemKey: string) {
        if (pool === 'tokens') throw new LedgerError('disk I/O error', 'io');
        return super.reserve(pool, amount, runId, idemKey);
      }
    }
    const ledger = new ReserveFails();
    await pools(ledger, {});
    const b = build({ ledger, noBudget: true });
    await expect(b.loop.adoptGoal(goalInput)).rejects.toBeInstanceOf(LoopStopped);
    expect(b.loop.status().failure).toBe('ledger');
    expect(b.planner.writes).toBe(0);
    expect((await evs(ledger, 'goal.dropped'))[0]!.payload).toMatchObject({ failure: 'ledger' });
  });

  it("the planner's own non-budget accounting failure (PlannerAccountingError) terminates the run with 'ledger', not plan.rejected", async () => {
    const planner: Planner = {
      write: async () => {
        throw Object.assign(new Error('usage sink failed'), { name: 'PlannerAccountingError', sink: 'usage' });
      },
      deliberate: async (o) => o[0]!,
    };
    const b = build({ planner });
    await expect(b.loop.adoptGoal(goalInput)).rejects.toBeInstanceOf(LoopStopped);
    expect(b.loop.status().failure).toBe('ledger');
    expect(await kinds(b.ledger)).not.toContain('plan.rejected');
  });

  it('lease loss cancels an in-flight planner call: its meter.signal aborts, the loop stops without waiting, the call is charged its reservation', async () => {
    const ledger = new MemoryLedger();
    await pools(ledger, { calls: 2 });
    const lease = new AbortController();
    let signal: AbortSignal | undefined;
    const planner: Planner = { write: (_e, _b, _g, meter) => ((signal = meter?.signal), never<Plan>()), deliberate: async (o) => o[0]! };
    const b = build({ ledger, noBudget: true, planner, extra: { leaseSignal: lease.signal } });
    const adopting = b.loop.adoptGoal(goalInput);
    setTimeout(() => lease.abort(new Error('renewal failed')), 5);
    await expect(adopting).rejects.toBeInstanceOf(LoopStopped);
    expect(signal?.aborted).toBe(true);
    expect(b.loop.status().stopReason).toMatch(/lease lost/);
    await expect(ledger.reserve('calls', 2, 'r', 'probe-2')).rejects.toThrow(/budget exceeded/); // one call charged
    await expect(ledger.reserve('calls', 1, 'r', 'probe-1')).resolves.toBeDefined();
  });

  it('the run deadline (budgets.enforce true) cancels an in-flight planner call: budget failure, the hung call is not awaited', async () => {
    const m = enforcing({ wallClockSec: 1 });
    let signal: AbortSignal | undefined;
    const planner: Planner = { write: (_e, _b, _g, meter) => ((signal = meter?.signal), never<Plan>()), deliberate: async (o) => o[0]! };
    const b = build({ manifest: m, planner });
    await b.loop.adoptGoal(goalInput);
    expect(signal?.aborted).toBe(true);
    expect((await evs(b.ledger, 'goal.dropped'))[0]!.payload).toMatchObject({ terminal: true, failure: 'budget', reason: expect.stringMatching(/deadline/) });
  }, 10_000);

  it('a model-backed reflex seam receives the meter and the cancellation signal', async () => {
    const m = manifest({ reflexes: { ...manifest().reflexes, gate: 'model' } });
    const seen: Array<{ signal?: AbortSignal; meter?: unknown }> = [];
    const b = build({ manifest: m });
    const inner = b.loop['p'].reflex;
    (b.loop as unknown as { p: LoopPorts }).p.reflex = {
      ask: (seam, q, opts) => {
        if (seam === 'gate') seen.push({ ...(opts ?? {}) });
        return inner.ask(seam, q);
      },
    };
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    await b.loop.runUntilQuiescent();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(typeof (seen[0]!.meter as { record?: unknown }).record).toBe('function');
  });
});

describe('progressCheck precision (ADV-8): candidates of worker executions, not merely verifies', () => {
  it('a failed verify re-executes the worker that produced the candidate; two worker executions with the same tree stop for a human', async () => {
    const gates = new ScriptedGates();
    gates.verifyCodes = [1, 1, 1];
    gates.fps = ['fp-same', 'fp-same', 'fp-same'];
    const b = build({ gates });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    await b.loop.runUntilQuiescent();
    expect(b.worker.calls.map((c) => `${c.step.id}@${c.intention.attempt}`)).toEqual(['analyze@1', 'edit@1', 'edit@2']);
    const v = await evs(b.ledger, 'verify.failed');
    expect(v.map((e) => e.payload.workerExec)).toEqual([2, 3]);
    expect(v[1]!.payload).toMatchObject({ noProgress: true, failure: 'human', reason: expect.stringMatching(/worker executions 2 and 3/) });
    expect((await evs(b.ledger, 'intention.advanced')).find((e) => e.payload.retry === 'verify1')!.payload).toMatchObject({ rerun: ['edit', 'verify1'] });
  });

  it('two verifies of ONE worker execution are never "no progress": a verify-only plan retried on the same tree is an ordinary verify failure', async () => {
    const verifyOnly = (): Plan => ({ ...fivePlan('p_v'), steps: [{ id: 'v', kind: 'gate.verify', dependsOn: [], inputs: {} }], allowedModels: {} });
    const gates = new ScriptedGates();
    gates.verifyCodes = [1, 1];
    gates.fps = ['fp-same', 'fp-same'];
    const b = build({ gates, plan: verifyOnly });
    await b.loop.addBelief('verify.baseline', 'failing');
    await b.loop.adoptGoal(goalInput);
    await b.loop.runUntilQuiescent();
    const v = await evs(b.ledger, 'verify.failed');
    expect(v).toHaveLength(2);
    expect(v.some((e) => e.payload.noProgress === true)).toBe(false);
    expect((await evs(b.ledger, 'step.failed')).pop()!.payload).not.toHaveProperty('failure');
  });
});
