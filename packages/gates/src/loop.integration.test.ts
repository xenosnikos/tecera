import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  approvalGrantedEvent,
  type AchievementGoal,
  type ApprovalGrant,
  type DecisionRecord,
  type GateRunner,
  type Ledger,
  type Manifest,
  type Outcome,
  type Plan,
  type Planner,
  type TeceraEvent,
  type Worker,
  type WorkerStepRequest,
} from '@tecera/contracts';
import { SqliteLedger } from '@tecera/ledger';
// Dev-only workspace imports (as packages/planner/src/loop.integration.test.ts does): the real loop and
// reflex drive the real gates. Nothing here is part of the gates build.
import { Loop, MemoryPlanLibrary } from '@tecera/loop';
import { ReflexRouter } from '@tecera/reflex';
import { createGates, type CreateGatesOptions } from './index.js';
import { FakeReviewer, FakeRunner, LEDGERS, liveGuard, makeRepo, manifest, sqlitePath, withBudget, WRITERS, type Repo } from './testkit/fixtures.js';

/**
 * Composition, not replay (D6): @tecera/loop runs worker → verify → review → verify → commit → pr. The
 * commit lands on the work branch WITHOUT approval; gate.pr is the only hold; a human grants it through
 * approve(…, audit), loop.resume() hands the approval to the real PR gate, which consumes it and (no remote
 * here) records the patch bundle; terminal gate outcomes are never retried; and a crash inside the commit is
 * recovered by Loop.restore() through gates.reconcile (security.md §4 S8), including the index window.
 */

const GOAL_CHECK = 'node --test test/goal.test.js';

function osManifest(reviewMaxAttempts = 1): Manifest {
  // 'os' isolation: the degraded-isolation worker hold is the loop's own test; here the commit hold matters.
  return manifest({ sandbox: { profile: 'process', isolation: 'os', network: false, memoryMb: 256, execTimeoutSec: 60 }, review: { foreign: true, maxAttempts: reviewMaxAttempts } });
}

const plan = (): Plan => ({
  id: 'p_int',
  trigger: { kind: 'goal.adopted' },
  context: [],
  steps: [
    { id: 'w', kind: 'worker', dependsOn: [], inputs: {}, instruction: 'fix src/a.ts' },
    { id: 'v', kind: 'gate.verify', dependsOn: ['w'], inputs: {} },
    { id: 'r', kind: 'gate.review', dependsOn: ['v'], inputs: {} },
    { id: 'v2', kind: 'gate.verify', dependsOn: ['r'], inputs: {} },
    { id: 'c', kind: 'gate.commit', dependsOn: ['v2'], inputs: {} },
    { id: 'pr', kind: 'gate.pr', dependsOn: ['c'], inputs: {} },
  ],
  allowedModels: { w: ['worker'] },
  permissions: { tools: ['read', 'edit'], write: ['src/**'], approvals: ['open_pr'] },
  budget: {},
  origin: 'generated',
  status: 'candidate',
  goalKinds: ['fix'],
});

class OnePlan implements Planner {
  async write(): Promise<Plan> {
    return plan();
  }
  async deliberate(options: Plan[]): Promise<Plan> {
    return options[0]!;
  }
}

class EditingWorker implements Worker {
  runs = 0;
  constructor(private readonly edit: () => void) {}
  async run(req: WorkerStepRequest): Promise<Outcome> {
    this.runs++;
    this.edit();
    return { kind: 'returned', value: { facts: [] }, run: { runId: req.runId, invokeId: `w${this.runs}`, depth: 0 } };
  }
  async resume(): Promise<Outcome> {
    throw new Error('the worker never suspends here');
  }
}

interface Rig {
  repo: Repo;
  ledger: Ledger;
  runner: FakeRunner;
  reviewer: FakeReviewer;
  worker: EditingWorker;
  gates: ReturnType<typeof createGates>;
  loop: Loop;
  clock: { t: number };
  runsDir: string;
  newLoop(extra?: Partial<CreateGatesOptions>, wrap?: (g: ReturnType<typeof createGates>) => GateRunner): { loop: Loop; gates: ReturnType<typeof createGates> };
}

function rig(o: { ledger: Ledger; edit?: (r: Repo) => void; runner?: FakeRunner; extra?: Partial<CreateGatesOptions>; repo?: Repo; reviewMaxAttempts?: number; reviewer?: FakeReviewer }): Rig {
  const repo = o.repo ?? makeRepo();
  const ledger = withBudget(o.ledger);
  const m = osManifest(o.reviewMaxAttempts);
  const runner = o.runner ?? new FakeRunner();
  const reviewer = o.reviewer ?? new FakeReviewer('openai');
  const worker = new EditingWorker(() => (o.edit ?? ((r: Repo) => r.write('src/a.ts', 'export const a = 2;\n')))(repo));
  const clock = { t: 1_000_000 };
  const now = () => ++clock.t;
  const runsDir = mkdtempSync(join(tmpdir(), 'tecera-gates-runs-'));
  const sink = { async record(_d: DecisionRecord) {} };
  const build = (extra: Partial<CreateGatesOptions> = {}, wrap?: (g: ReturnType<typeof createGates>) => GateRunner) => {
    const gates = createGates({ manifest: m, ledger, verifyRunner: runner, reviewer, writers: WRITERS, worktree: repo.dir, sessionId: 's', now, runsDir, gh: null, ...o.extra, ...extra });
    const loop = new Loop({
      manifest: m,
      ledger,
      library: new MemoryPlanLibrary(),
      planner: new OnePlan(),
      reflex: new ReflexRouter({ settings: m.reflexes, threshold: m.reflexes.threshold }, { sink, runId: 'run1', now }),
      worker,
      gates: wrap ? wrap(gates) : gates,
      validator: { validatePlan: () => [] },
      seats: [{ seatId: 'worker', costPerMTok: 1 }],
      runId: 'run1',
      sessionId: 's',
      worktree: repo.dir,
      now,
    });
    return { loop, gates };
  };
  const first = build();
  return { repo, ledger, runner, reviewer, worker, clock, runsDir, ...first, newLoop: build };
}

const goal = (): Omit<AchievementGoal, 'status' | 'evidence' | 'commitment'> => ({ id: 'g1', statement: 'make a two', check: { command: GOAL_CHECK, timeoutSec: 60 } });

async function events(ledger: Ledger, kind?: string): Promise<Array<TeceraEvent & { seq: number }>> {
  const out: Array<TeceraEvent & { seq: number }> = [];
  for await (const e of ledger.events()) if (!kind || e.kind === kind) out.push(e);
  return out;
}

/** A human grant through authenticated ingress: grant + approval.granted audit event, atomically. */
async function humanGrant(ledger: Ledger, requestId: string, at: number): Promise<ApprovalGrant> {
  const view = (await ledger.getApproval(requestId))!;
  const req = (await events(ledger, 'approval.requested')).find((e) => e.payload.requestId === requestId)!;
  const approver = { kind: 'human' as const, id: 'alice' };
  const audit = approvalGrantedEvent({ id: `grant-${requestId}`, at, requestId, runId: view.runId, sessionId: view.sessionId, actionHash: view.actionHash, approver, trace: req.trace });
  return ledger.approve(requestId, approver, view.sessionId, at, audit);
}

const branchSha = (r: Repo) => r.g('rev-parse', 'refs/heads/tecera/g1').trim();
const noBranch = (r: Repo) => expect(() => r.g('rev-parse', '--verify', '--quiet', 'refs/heads/tecera/g1')).toThrow();

describe.each(LEDGERS)('real loop → real gates (%s)', (_name, mk) => {
  it('commit without approval → PR hold → audited grant → resume: the PR gate consumes the grant, records the bundle, the goal is achieved with proof', async () => {
    const s = rig({ ledger: mk() });
    await s.loop.start('h');
    await s.loop.adoptGoal(goal());
    const held = await s.loop.runUntilQuiescent();
    // D6: the commit already landed on the work branch with no approval; only the PR holds.
    expect(held.held).toHaveLength(1);
    expect(held.held[0]!.stepId).toBe('pr');
    const recorded = await events(s.ledger, 'commit.recorded');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.payload.sha).toBe(branchSha(s.repo));
    expect(s.repo.g('rev-list', '--count', 'main..tecera/g1').trim()).toBe('1');
    expect(s.repo.g('cat-file', 'blob', 'tecera/g1:src/a.ts')).toBe('export const a = 2;\n');
    expect(s.repo.g('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('tecera/g1');
    expect(s.repo.g('diff', '--cached', '--name-only', 'HEAD').trim()).toBe('');
    // The adopted goal's check ran (twice: before and after the review), never the manifest's verify command.
    expect(s.runner.calls.map((c) => c.command)).toEqual([GOAL_CHECK, GOAL_CHECK]);
    expect(s.loop.goal('g1')!.status).not.toBe('achieved');
    const requestId = held.held[0]!.requestId;
    expect((await s.ledger.getApproval(requestId))!.state).toBe('pending');

    const grant = await humanGrant(s.ledger, requestId, ++s.clock.t);
    await s.loop.resume(requestId, grant);
    await s.loop.runUntilQuiescent();

    expect((await s.ledger.getApproval(requestId))!.state).toBe('consumed');
    const prs = await events(s.ledger, 'pr.requested');
    expect(prs).toHaveLength(1);
    expect(prs[0]!.payload).toMatchObject({ sha: branchSha(s.repo) });
    const bundle = join(s.runsDir, 'run1', 'pr');
    expect(existsSync(join(bundle, `${branchSha(s.repo)}.patch`))).toBe(true);
    expect(readFileSync(join(bundle, 'request.json'), 'utf8')).toMatch(/"branch": "tecera\/g1"/);
    expect(s.loop.goal('g1')!.status).toBe('achieved');
    const achieved = (await events(s.ledger, 'goal.achieved'))[0]!;
    expect((achieved.payload as { proof?: { command?: string; exitCode?: number } }).proof).toMatchObject({ command: GOAL_CHECK, exitCode: 0 });
    expect(s.reviewer.calls).toHaveLength(1);
    // Tecera never merges: main is untouched.
    expect(s.repo.g('rev-list', '--count', 'tecera/g1..main').trim()).toBe('0');
    expect(s.repo.g('rev-parse', 'main').trim()).not.toBe(branchSha(s.repo));
  });

  it('terminal verify outcome (tests mutate the tree) is not retried: one verify, no review, no commit, goal dropped', async () => {
    let dir = '';
    const runner = new FakeRunner(() => (writeFileSync(join(dir, 'src/a.ts'), 'export const a = 3;\n'), { exitCode: 0 }));
    const s = rig({ ledger: mk(), runner });
    dir = s.repo.dir;
    await s.loop.start('h');
    await s.loop.adoptGoal(goal());
    const st = await s.loop.runUntilQuiescent();
    expect(st.held).toHaveLength(0);
    expect(runner.calls).toHaveLength(1);
    expect(s.reviewer.calls).toHaveLength(0);
    const failed = (await events(s.ledger, 'step.failed')).find((e) => e.trace.stepId === 'v')!;
    expect(failed.payload).toMatchObject({ terminal: true });
    expect(s.loop.goal('g1')!.status).toBe('dropped');
    noBranch(s.repo);
  });

  it('terminal commit refusal (an ignored file appeared after the baseline) is not retried, asks nobody for approval and spends nothing else', async () => {
    const repo = makeRepo();
    const s = rig({ ledger: mk(), repo, edit: (r) => (r.write('src/a.ts', 'export const a = 2;\n'), r.write('ignored/late.js', 'x\n')) });
    expect((await s.gates.baseline({ runId: 'run1', check: goal().check })).exitCode).toBe(0);
    await s.loop.start('h');
    await s.loop.adoptGoal(goal());
    const st = await s.loop.runUntilQuiescent();
    expect(st.held).toHaveLength(0);
    const failed = (await events(s.ledger, 'step.failed')).filter((e) => e.trace.stepId === 'c');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ terminal: true, reason: 'boundary' });
    expect(await events(s.ledger, 'approval.requested')).toHaveLength(0);
    expect((await events(s.ledger, 'commit.recorded'))).toHaveLength(0);
    expect(await events(s.ledger, 'pr.requested')).toHaveLength(0);
    expect(s.loop.goal('g1')!.status).toBe('dropped');
    noBranch(s.repo);
  });

  async function crashAfterHead(mk: () => Ledger) {
    let reached!: () => void;
    const atCrash = new Promise<void>((r) => (reached = r));
    const s = rig({ ledger: mk(), extra: { commitTestHooks: { afterHead: () => (reached(), new Promise<void>(() => undefined)) } } });
    await s.loop.start('h');
    await s.loop.adoptGoal(goal());
    void s.loop.runUntilQuiescent(); // the process "dies" inside commit (no approval needed); this promise never settles
    await atCrash;
    // The crash window: branch and HEAD moved, the worktree index still holds the base tree.
    expect(s.repo.g('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('tecera/g1');
    expect(s.repo.g('diff', '--cached', '--name-only', 'HEAD').trim()).toBe('src/a.ts');
    return s;
  }

  it('S8 through Loop.restore() with a guarded reconcile: a crash after HEAD moved but before the index was updated is reconciled; the index is repaired', async () => {
    const s = await crashAfterHead(mk);
    // The restarted process hands its live fence to reconcile (as the runtime's GateRunner wrapper can).
    const fence = liveGuard();
    const fresh = s.newLoop({ commitTestHooks: {} }, (g) => ({ verify: g.verify, review: g.review, commit: g.commit, pr: g.pr, reconcile: (c) => g.reconcile({ ...c, guard: fence.guard }) }));
    const st = await fresh.loop.restore();
    expect(st.recovered?.find((n) => n.stepId === 'c')?.action).toBe('reconciled');
    const held = await fresh.loop.runUntilQuiescent();
    expect(held.held.map((h) => h.stepId)).toEqual(['pr']);
    const recorded = await events(s.ledger, 'commit.recorded');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.payload).toMatchObject({ sha: branchSha(s.repo), reconciled: true });
    expect(s.repo.g('diff', '--cached', '--name-only', 'HEAD').trim()).toBe('');
    expect(s.repo.g('write-tree').trim()).toBe(s.repo.g('rev-parse', 'HEAD^{tree}').trim());
    const requestId = held.held[0]!.requestId;
    await fresh.loop.resume(requestId, await humanGrant(s.ledger, requestId, ++s.clock.t));
    await fresh.loop.runUntilQuiescent();
    expect(fresh.loop.goal('g1')!.status).toBe('achieved');
    expect(s.repo.g('rev-list', '--count', 'main..tecera/g1').trim()).toBe('1');
    expect(fence.checks).toBeGreaterThan(0);
  });

  it('S8 through Loop.restore() WITHOUT a guard on reconcile (the loop passes none today): the needed index repair is refused for a human; nothing moves, nothing is recorded', async () => {
    const s = await crashAfterHead(mk);
    const indexBefore = s.repo.g('write-tree').trim();
    const fresh = s.newLoop({ commitTestHooks: {} });
    const st = await fresh.loop.restore();
    expect(st.recovered?.find((n) => n.stepId === 'c')?.action).toBe('failed');
    await fresh.loop.runUntilQuiescent();
    expect(await events(s.ledger, 'commit.recorded')).toHaveLength(0);
    const failed = (await events(s.ledger, 'step.failed')).find((e) => e.trace.stepId === 'c')!;
    expect(failed.payload).toMatchObject({ terminal: true, failure: 'human' });
    expect(String(failed.payload.reason)).toMatch(/reconcile-needs-guard/);
    // Nothing was repaired without the fence: the stale index is still there for the human to see.
    expect(s.repo.g('write-tree').trim()).toBe(indexBefore);
    expect(s.repo.g('diff', '--cached', '--name-only', 'HEAD').trim()).toBe('src/a.ts');
  });
});

describe.each(LEDGERS)('S5 through Loop.restore(): a lost review (%s)', (_name, mk) => {
  function lostReviewRig(ledger: Ledger, reviewMaxAttempts: number) {
    let reached!: () => void;
    const atCall = new Promise<void>((r) => (reached = r));
    let calls = 0;
    const reviewer = new FakeReviewer('openai', () => (++calls === 1 ? (reached(), new Promise<string>(() => undefined)) : '{"verdict":"approve","findings":[]}'));
    const s = rig({ ledger, reviewMaxAttempts, reviewer });
    return { s, reviewer, atCall };
  }

  it('review.maxAttempts 2: the loop re-dispatches the review once, the gate allows exactly that second call, and the run reaches the PR hold', async () => {
    const { s, reviewer, atCall } = lostReviewRig(mk(), 2);
    await s.loop.start('h');
    await s.loop.adoptGoal(goal());
    void s.loop.runUntilQuiescent(); // dies inside the reviewer call
    await atCall;
    const fresh = s.newLoop();
    const st = await fresh.loop.restore();
    expect(st.recovered?.find((n) => n.stepId === 'r')?.action).toBe('re-dispatch');
    const held = await fresh.loop.runUntilQuiescent();
    expect(reviewer.calls).toHaveLength(2);
    expect(held.held.map((h) => h.stepId)).toEqual(['pr']);
    const passed = await events(s.ledger, 'review.passed');
    expect(passed).toHaveLength(1);
  });

  it('review.maxAttempts 1: the loop stops for a human and the gate is never asked again', async () => {
    const { s, reviewer, atCall } = lostReviewRig(mk(), 1);
    await s.loop.start('h');
    await s.loop.adoptGoal(goal());
    void s.loop.runUntilQuiescent();
    await atCall;
    const fresh = s.newLoop();
    const st = await fresh.loop.restore();
    expect(st.recovered?.find((n) => n.stepId === 'r')?.action).toBe('failed');
    await fresh.loop.runUntilQuiescent();
    expect(reviewer.calls).toHaveLength(1);
    const failed = (await events(s.ledger, 'step.failed')).find((e) => e.trace.stepId === 'r')!;
    expect(failed.payload).toMatchObject({ terminal: true, failure: 'human' });
  });
});

describe('real loop → real gates across processes (SqliteLedger reopened)', () => {
  it('S8: a crash after the intent but before commit-tree is a terminal human failure; nothing is committed', async () => {
    const path = sqlitePath();
    let reached!: () => void;
    const atCrash = new Promise<void>((r) => (reached = r));
    const s = rig({ ledger: new SqliteLedger(path), extra: { commitTestHooks: { beforeCommit: () => (reached(), new Promise<void>(() => undefined)) } } });
    await s.loop.start('h');
    await s.loop.adoptGoal(goal());
    void s.loop.runUntilQuiescent();
    await atCrash;
    const second = rig({ ledger: new SqliteLedger(path), repo: s.repo, extra: { commitTestHooks: {} } });
    const st = await second.loop.restore();
    expect(st.recovered?.find((n) => n.stepId === 'c')?.action).toBe('failed');
    await second.loop.runUntilQuiescent();
    expect(await events(second.ledger, 'commit.recorded')).toHaveLength(0);
    const failed = (await events(second.ledger, 'step.failed')).find((e) => e.trace.stepId === 'c')!;
    expect(failed.payload).toMatchObject({ terminal: true, failure: 'human' });
    expect(String(failed.payload.reason)).toMatch(/reconcile-no-commit/);
    noBranch(s.repo);
  });
});
