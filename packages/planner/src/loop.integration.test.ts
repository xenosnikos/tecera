import { describe, expect, it } from 'vitest';
import { LedgerError, type AchievementGoal, type Json, type Outcome, type TeceraEvent, type Worker, type WorkerStepRequest } from '@tecera/contracts';
import { MemoryLedger } from '@tecera/ledger';
import { Loop, MemoryPlanLibrary, type GateRunner, type LoopPorts } from '@tecera/loop';
import { ReflexRouter } from '@tecera/reflex';
import { createPlanValidator } from './checks.js';
import { FakeLLM, goal, goodDoc, sampleManifest, samplePermissions } from './fixtures.testkit.js';
import { LLMPlanner } from './llmPlanner.js';
import { sampleFixFailingTestPlan } from './scripted.js';

/**
 * Integration with the real loop (dev-only import of @tecera/loop, @tecera/ledger, @tecera/reflex via the
 * workspace): an exhausted repair emits plan.rejected, drops the goal, and the candidate is never staged
 * or executed. The goal-aware validator also guards library-reused plans.
 */

const m = sampleManifest();
const permissions = samplePermissions();
const CANARY = 'TECERA_CANARY_loop_rejected_1';

class NeverWorker implements Worker {
  calls: WorkerStepRequest[] = [];
  async run(req: WorkerStepRequest): Promise<Outcome> {
    this.calls.push(req);
    throw new Error('worker must not run');
  }
  async resume(): Promise<Outcome> {
    throw new Error('worker must not resume');
  }
}

class NeverGates implements GateRunner {
  calls = 0;
  async verify(): Promise<never> {
    this.calls++;
    throw new Error('gate must not run');
  }
  async review(): Promise<never> {
    this.calls++;
    throw new Error('gate must not run');
  }
  async commit(): Promise<never> {
    this.calls++;
    throw new Error('gate must not run');
  }
}

/**
 * The loop reserves 'calls', 'usd' and 'tokens' before every planner call, so the run's pools must be
 * open (Loop.start opens 'calls'; tests that skip start open it here). `settled` records every settlement
 * amount (the loop settles at the usage the planner metered).
 */
async function build(planner: LoopPorts['planner'], library = new MemoryPlanLibrary(), caps: { usd: number; tokens: number; calls?: number } = { usd: 100, tokens: 10_000_000 }) {
  const ledger = new MemoryLedger();
  await ledger.openBudget('r', 'calls', caps.calls ?? 100);
  await ledger.openBudget('r', 'usd', caps.usd);
  await ledger.openBudget('r', 'tokens', caps.tokens);
  const settled: number[] = [];
  const settle = ledger.settle.bind(ledger);
  ledger.settle = async (id: string, actual: number) => {
    settled.push(actual);
    return settle(id, actual);
  };
  const worker = new NeverWorker();
  const gates = new NeverGates();
  let t = 0;
  const reflex = new ReflexRouter({ settings: m.reflexes, threshold: m.reflexes.threshold }, { sink: { async record() {} }, runId: 'r', now: () => ++t });
  const loop = new Loop({
    manifest: m,
    ledger,
    library,
    planner,
    reflex,
    worker,
    gates,
    validator: createPlanValidator({ permissions }),
    seats: [{ seatId: 'worker', costPerMTok: 1 }],
    runId: 'r',
    sessionId: 'r',
    worktree: '/nonexistent-worktree',
    now: () => ++t,
  });
  return { loop, ledger, worker, gates, library, settled };
}

async function events(ledger: MemoryLedger): Promise<TeceraEvent[]> {
  const out: TeceraEvent[] = [];
  for await (const e of ledger.events()) out.push(e);
  return out;
}

const goalInput = (g: Partial<AchievementGoal> = {}) => ({ id: goal.id, statement: goal.statement, check: goal.check, budget: goal.budget, ...g });

describe('LLMPlanner inside the real loop', () => {
  it('exhausted repair → plan.rejected {errors, plan} + goal.dropped; nothing staged, no worker or gate runs', async () => {
    const pushing = JSON.stringify({ ...goodDoc(), rationale: `token ${CANARY}`, permissions: { ...goodDoc().permissions, tools: ['read', 'edit', 'merge'] } });
    const llm = new FakeLLM([pushing, pushing]);
    const { loop, ledger, worker, gates, library } = await build(new LLMPlanner({ llm, manifest: m, permissions }));
    await loop.start('h');
    await loop.adoptGoal(goalInput());
    await loop.runUntilQuiescent();

    const evs = await events(ledger);
    const kinds = evs.map((e) => e.kind);
    const rej = evs.find((e) => e.kind === 'plan.rejected')!;
    expect(rej).toBeDefined();
    expect(rej.payload.source).toBe('planner');
    const errors = rej.payload.errors as string[];
    expect(errors.join('\n')).toMatch(/tool merge is never allowed/);
    expect(rej.trace.planId).toMatch(/^p_[0-9a-f]{8}$/);
    expect((rej.payload.plan as { id?: Json }).id).toBe(rej.trace.planId);
    expect(kinds).toContain('goal.dropped');
    expect(loop.goal(goal.id)!.status).toBe('dropped');
    for (const k of ['plan.generated', 'plan.staged', 'intention.pushed', 'step.started']) expect(kinds).not.toContain(k);
    expect(library.all()).toHaveLength(0);
    expect(worker.calls).toHaveLength(0);
    expect(gates.calls).toBe(0);
    expect(llm.requests).toHaveLength(2);
    expect(JSON.stringify(evs)).not.toContain('TECERA_CANARY_');
    expect(loop.status().state).toBe('active');
  });

  it('a non-budget accounting failure inside write() terminates the run (failure ledger): no plan.rejected, nothing staged', async () => {
    const llm = new FakeLLM([JSON.stringify(goodDoc())]);
    const planner = new LLMPlanner({ llm, manifest: m, permissions, onUsage: async () => Promise.reject(new Error('ledger failed')) });
    const { loop, ledger, library, worker } = await build(planner);
    // The loop stops the run and adoptGoal surfaces it.
    await expect(loop.adoptGoal(goalInput())).rejects.toThrow(/accounting failure: usage settlement failed \(write\)/);
    const evs = await events(ledger);
    const kinds = evs.map((e) => e.kind);
    const dropped = evs.find((e) => e.kind === 'goal.dropped')!;
    expect(dropped).toBeDefined();
    expect(dropped.payload.failure).toBe('ledger');
    expect(kinds).not.toContain('plan.rejected');
    expect(kinds).not.toContain('plan.staged');
    expect(library.all()).toHaveLength(0);
    expect(worker.calls).toHaveLength(0);
    const st = loop.status();
    expect(st.state).toBe('stopped');
    expect(st.failure).toBe('ledger');
  });

  it('a valid generated plan passes the loop re-validation with the goal and is staged as a candidate', async () => {
    const llm = new FakeLLM([JSON.stringify({ ...goodDoc(), budget: {} })]);
    const { loop, ledger, library } = await build(new LLMPlanner({ llm, manifest: m, permissions }));
    await loop.adoptGoal(goalInput({ budget: { usd: 0.25 } }));
    const kinds = (await events(ledger)).map((e) => e.kind);
    expect(kinds).toContain('plan.staged');
    expect(kinds).not.toContain('plan.rejected');
    expect(library.all()[0]!.budget.usd).toBe(0.25);
  });

  it('a library plan whose omitted budget would exceed the goal ceiling is rejected as reused', async () => {
    const library = new MemoryPlanLibrary();
    library.accept({ ...sampleFixFailingTestPlan(), id: 'p_reused1', origin: 'graduated', status: 'accepted', budget: {} });
    const llm = new FakeLLM(['not a plan', 'still not a plan']);
    const { loop, ledger } = await build(new LLMPlanner({ llm, manifest: m, permissions }), library);
    await loop.adoptGoal(goalInput({ budget: { usd: 0.01 } }));
    const rej = (await events(ledger)).filter((e) => e.kind === 'plan.rejected');
    const reused = rej.find((e) => e.payload.reused === true)!;
    expect(reused.trace.planId).toBe('p_reused1');
    expect((reused.payload.errors as string[]).join('\n')).toMatch(/budget.usd is omitted, so the run would get manifest 2, which exceeds goal budget 0.01/);
  });

  it('the loop settles planner reservations at the usage the planner metered (not the full reservation)', async () => {
    const llm = new FakeLLM([JSON.stringify(goodDoc())]);
    const { loop, ledger, settled } = await build(new LLMPlanner({ llm, manifest: m, permissions }));
    await loop.adoptGoal(goalInput());
    expect((await events(ledger)).map((e) => e.kind)).toContain('plan.staged');
    // FakeLLM bills 100 + 50 tokens and $0.001 per call; one call was made (calls, usd, tokens pools).
    expect(settled).toEqual([1, 0.001, 150]);
  });

  it('a pool too small for the reservation is a budget failure before any planner call (goal.dropped {failure: budget})', async () => {
    const llm = new FakeLLM([JSON.stringify(goodDoc())]);
    const { loop, ledger, library } = await build(new LLMPlanner({ llm, manifest: m, permissions }), new MemoryPlanLibrary(), { usd: 0.01, tokens: 10_000_000 });
    await loop.adoptGoal(goalInput());
    const evs = await events(ledger);
    const dropped = evs.find((e) => e.kind === 'goal.dropped')!;
    expect(dropped.payload.failure).toBe('budget');
    expect(evs.map((e) => e.kind)).not.toContain('plan.rejected');
    expect(llm.requests).toHaveLength(0);
    expect(library.all()).toHaveLength(0);
  });

  it('an exhausted calls pool refuses the planner seat before any call (goal.dropped {failure: budget})', async () => {
    const llm = new FakeLLM([JSON.stringify(goodDoc())]);
    const { loop, ledger, library } = await build(new LLMPlanner({ llm, manifest: m, permissions }), new MemoryPlanLibrary(), { usd: 100, tokens: 10_000_000, calls: 0 });
    await loop.adoptGoal(goalInput());
    const evs = await events(ledger);
    expect(evs.find((e) => e.kind === 'goal.dropped')!.payload.failure).toBe('budget');
    expect(evs.map((e) => e.kind)).not.toContain('plan.rejected');
    expect(llm.requests).toHaveLength(0);
    expect(library.all()).toHaveLength(0);
  });

  it('a budget refusal from the usage sink is a budget failure, never a plan rejection or a staged plan', async () => {
    const llm = new FakeLLM([JSON.stringify(goodDoc())]);
    const planner = new LLMPlanner({ llm, manifest: m, permissions, onUsage: async () => Promise.reject(new LedgerError('budget exceeded for usd', 'budget')) });
    const { loop, ledger, library } = await build(planner);
    await loop.adoptGoal(goalInput());
    const evs = await events(ledger);
    const kinds = evs.map((e) => e.kind);
    expect(evs.find((e) => e.kind === 'goal.dropped')!.payload.failure).toBe('budget');
    expect(kinds).not.toContain('plan.rejected');
    expect(kinds).not.toContain('plan.staged');
    expect(library.all()).toHaveLength(0);
  });

  it('secret-bearing loop diagnostics: plan.rejected errors from the planner validator carry no canary', async () => {
    const seatDoc = JSON.stringify({ ...goodDoc(), allowedModels: { analyze: ['TECERA_CANARY_seat_77'], edit: ['worker'] } });
    const llm = new FakeLLM([seatDoc, seatDoc]);
    const { loop, ledger } = await build(new LLMPlanner({ llm, manifest: m, permissions }));
    await loop.adoptGoal(goalInput());
    const evs = await events(ledger);
    expect(evs.map((e) => e.kind)).toContain('plan.rejected');
    expect(JSON.stringify(evs)).not.toContain('TECERA_CANARY_seat_77');
  });
});
