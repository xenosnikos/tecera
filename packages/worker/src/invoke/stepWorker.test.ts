import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newIntention, type CapabilitySet, type Effect, type Hook, type Outcome, type Plan, type SpanEvent, type VerifyRequest, type VerifyRunner, type WorkerStepRequest } from '@tecera/contracts';
import { createEditTool } from '../tools/edit.js';
import { createListFilesTool } from '../tools/listFiles.js';
import { createReadTool } from '../tools/read.js';
import { FakeLedger, FakeLLM, FakeRepl, liveWriteGuard } from './fakes.js';
import { StepWorker } from './stepWorker.js';

const js = (body: string): string => `\`\`\`js\n${body}\n\`\`\``;
const caps: CapabilitySet = { tools: ['read', 'edit', 'listFiles', 'runVerify'], paths: { read: ['**'], write: ['src/**'], protected: ['test/**'] }, network: 'none', limits: { usd: 1, tokens: 100_000, calls: 50, wallMs: 60_000, depth: 3, iterations: 8 } };
const plan: Plan = {
  id: 'plan_1',
  trigger: { kind: 'goal.adopted' },
  context: [],
  steps: [{ id: 'edit', kind: 'worker', dependsOn: [], inputs: { hint: 'src/sum.ts' }, instruction: 'Fix the bug in sum', output: { type: 'object', required: ['summary', 'facts'], properties: { summary: { type: 'string' }, facts: { type: 'array' } } } }],
  allowedModels: { edit: ['cheap'] },
  permissions: { tools: caps.tools, write: ['src/**'], approvals: [] },
  budget: {},
  origin: 'generated',
  status: 'candidate',
  goalKinds: ['fix-test'],
};
const request = (over: Partial<WorkerStepRequest> = {}): WorkerStepRequest => ({
  runId: 'run_e2e',
  goal: { id: 'g1', statement: 'make the failing test pass', check: { command: 'node --test', timeoutSec: 60 }, commitment: 'single-minded', status: 'open', evidence: [] },
  plan,
  intention: newIntention({ id: 'i1', goalId: 'g1', plan, commitment: 'single-minded' }),
  step: plan.steps[0]!,
  seatId: 'cheap',
  inputs: { beliefs: { kind: 'value', value: { 'test.failing': 'sum.test.ts' }, provenance: { src: 'beliefs', trust: 'trusted' } } },
  capabilities: caps,
  worktree: root,
  fencingToken: 9,
  guard: liveWriteGuard(),
  ...over,
});

let root: string;
const verifyCalls: VerifyRequest[] = [];
const runner: VerifyRunner = {
  run: async (r) => {
    verifyCalls.push(r);
    const src = await readFile(join(r.cwd, 'src/sum.ts'), 'utf8');
    const pass = src.includes('a + b');
    return { exitCode: pass ? 0 : 1, signal: null, timedOut: false, stdout: pass ? 'PASS' : 'FAIL', stderr: '', durationMs: 3, truncated: false };
  },
};
beforeEach(async () => {
  verifyCalls.length = 0;
  root = await mkdtemp(join(tmpdir(), 'tecera-step-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(join(root, 'src/sum.ts'), 'export const sum = (a: number, b: number) => a - b;\n');
  await writeFile(join(root, 'test/sum.test.ts'), 'expect(sum(1, 2)).toBe(3);\n');
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const program = js(`const { files } = await listFiles('src/');
const f = await readFile(files[0]);
await writeFile({ path: files[0], oldText: 'a - b', newText: 'a + b' });
const v = await runVerify();
return { summary: 'fixed ' + files[0] + ' (' + step.instruction + ')', facts: [{ key: 'verify.exit', value: v.exitCode }, { key: 'goal', value: goal.statement }] };`);

describe('StepWorker', () => {
  it('runs a worker step end to end through invoke, broker, tools and the verify runner', async () => {
    const worker = new StepWorker({ seats: { cheap: new FakeLLM([program]) }, repl: new FakeRepl(), tools: [createReadTool(), createEditTool(), createListFilesTool()], hooks: [], verifyRunner: runner, ids: () => 'inv_e2e' });
    const out = await worker.run(request());
    expect(out).toMatchObject({
      kind: 'returned',
      value: { summary: 'fixed src/sum.ts (Fix the bug in sum)', facts: [{ key: 'verify.exit', value: 0 }, { key: 'goal', value: 'make the failing test pass' }] },
      run: { runId: 'run_e2e', invokeId: 'inv_e2e', depth: 0 },
    });
    expect(await readFile(join(root, 'src/sum.ts'), 'utf8')).toContain('a + b');
    expect(verifyCalls).toEqual([{ cwd: root, command: 'node --test', timeoutSec: 60, envAllowlist: ['PATH', 'HOME', 'CI'] }]);
  });

  it('builds a REPL per run from a factory (with sandbox callbacks) and disposes it', async () => {
    const made: Array<{ runId: string; tools: string[]; hasCallbacks: boolean }> = [];
    let disposed = 0;
    const factory = (ctx: { runId: string; capabilities: CapabilitySet; callbacks: { onInvoke: unknown; onCheckpoint: unknown } }) => {
      made.push({ runId: ctx.runId, tools: ctx.capabilities.tools, hasCallbacks: typeof ctx.callbacks.onInvoke === 'function' && typeof ctx.callbacks.onCheckpoint === 'function' });
      const r = new FakeRepl();
      r.dispose = async () => void disposed++;
      return r;
    };
    const worker = new StepWorker({ seats: { cheap: new FakeLLM([program]) }, repl: factory, tools: [createReadTool(), createEditTool(), createListFilesTool()], hooks: [], verifyRunner: runner });
    expect((await worker.run(request())).kind).toBe('returned');
    expect(made).toEqual([{ runId: 'run_e2e', tools: caps.tools, hasCallbacks: true }]);
    expect(disposed).toBe(1);
  });

  it('picks the LLM by seat, refuses reserved inputs and non-worker steps', async () => {
    const worker = new StepWorker({ seats: { cheap: new FakeLLM([]) }, repl: new FakeRepl(), tools: [], hooks: [] });
    expect(await worker.run(request({ seatId: 'frontier' }))).toMatchObject({ kind: 'failed', error: { name: 'SeatError' } });
    expect(await worker.run(request({ inputs: { __capabilities__: { kind: 'hidden', value: {} } } }))).toMatchObject({ kind: 'aborted', reasons: [{ code: 'policy' }] });
    expect(await worker.run(request({ step: { ...plan.steps[0]!, kind: 'gate.verify' } }))).toMatchObject({ kind: 'failed', error: { name: 'StepError' } });
  });

  it('suspends on an approval-gated edit and resume() completes it', async () => {
    const ledger = new FakeLedger();
    const gate: Hook = {
      id: 'approvalGate',
      mandatory: true,
      spans: new Set<SpanEvent['span']>(['ToolCall']),
      handle: (e): Effect[] => {
        const i = e.input as { tool: string; actionHash: string };
        return e.stage === 'Send' && i.tool === 'edit' ? [{ type: 'Suspend', request: { requestId: `ap_${e.spanId}`, action: 'edit', actionHash: i.actionHash, reason: 'edit requires approval', requester: 'worker' } }] : [];
      },
      describe: () => ({ id: 'approvalGate', mandatory: true, config: {} }),
    };
    const llm = new FakeLLM([program]);
    const mk = () => new StepWorker({ seats: { cheap: llm }, repl: new FakeRepl(), tools: [createReadTool(), createEditTool(), createListFilesTool()], hooks: [gate], ledger, verifyRunner: runner, sessionId: 'sess', resumeLease: () => ({ worktree: root, fencingToken: 10 }) });
    const first = await mk().run(request());
    expect(first.kind).toBe('suspended');
    if (first.kind !== 'suspended') return;
    expect(await readFile(join(root, 'src/sum.ts'), 'utf8')).toContain('a - b');
    const grant = await ledger.grantAudited(first.request.requestId, { kind: 'human', id: 'reviewer' }, 'sess', Date.now());
    const second = await mk().resume(first.resumeToken, grant, undefined, liveWriteGuard()); // a fresh worker instance: everything comes from the checkpoint
    expect(second).toMatchObject({ kind: 'returned', value: { facts: [{ key: 'verify.exit', value: 0 }, { key: 'goal', value: 'make the failing test pass' }] } });
    expect(await readFile(join(root, 'src/sum.ts'), 'utf8')).toContain('a + b');
    expect(llm.requests).toHaveLength(1);
  });

  const gate: Hook = {
    id: 'approvalGate',
    mandatory: true,
    spans: new Set<SpanEvent['span']>(['ToolCall']),
    handle: (e): Effect[] => {
      const i = e.input as { tool: string; actionHash: string };
      return e.stage === 'Send' && i.tool === 'edit' ? [{ type: 'Suspend', request: { requestId: `ap_${e.spanId}`, action: 'edit', actionHash: i.actionHash, reason: 'edit requires approval', requester: 'worker' } }] : [];
    },
    describe: () => ({ id: 'approvalGate', mandatory: true, config: {} }),
  };
  const tools = () => [createReadTool(), createEditTool(), createListFilesTool()];
  const editOnly = js(`await writeFile({ path: 'src/sum.ts', oldText: 'a - b', newText: 'a + b' });\nreturn { summary: 'edited', facts: [] };`);

  it("uses the request's worktree and lease: '' refuses file tools, a missing fencing token refuses writes", async () => {
    const noTree = new StepWorker({ seats: { cheap: new FakeLLM([js(`let m; try { await readFile('src/sum.ts'); m = 'read'; } catch (e) { m = e.message; }\nreturn { summary: m, facts: [] };`)]) }, repl: new FakeRepl(), tools: tools(), hooks: [] });
    expect(await noTree.run(request({ worktree: '' }))).toMatchObject({ kind: 'returned', value: { summary: expect.stringMatching(/no worktree/) } });
    const noLease = new StepWorker({ seats: { cheap: new FakeLLM([js(`let m; try { await writeFile('src/sum.ts', 'x'); m = 'wrote'; } catch (e) { m = e.message; }\nreturn { summary: m, facts: [] };`)]) }, repl: new FakeRepl(), tools: tools(), hooks: [] });
    const { fencingToken: _f, ...noToken } = request();
    expect(await noLease.run(noToken)).toMatchObject({ kind: 'returned', value: { summary: expect.stringMatching(/fencing token/) } });
    expect(await readFile(join(root, 'src/sum.ts'), 'utf8')).toContain('a - b');
  });

  it('narrows capabilities by the step tool list (effectiveStepTools)', async () => {
    const llm = new FakeLLM([js(`return { summary: __capabilities__.tools.join(','), facts: [] };`)]);
    const worker = new StepWorker({ seats: { cheap: llm }, repl: new FakeRepl(), tools: tools(), hooks: [] });
    const step = { ...plan.steps[0]!, tools: ['read', 'listFiles'] };
    expect(await worker.run(request({ step, plan: { ...plan, steps: [step] } }))).toMatchObject({ kind: 'returned', value: { summary: 'read,listFiles' } });
  });

  it('a held step dispatched again answers with its existing suspension instead of running twice', async () => {
    const ledger = new FakeLedger();
    const llm = new FakeLLM([editOnly]);
    const worker = new StepWorker({ seats: { cheap: llm }, repl: new FakeRepl(), tools: tools(), hooks: [gate], ledger, sessionId: 'sess' });
    const first = await worker.run(request());
    if (first.kind !== 'suspended') throw new Error('expected suspended');
    const held = { ...request().intention, resumeToken: first.resumeToken, heldRequestId: first.request.requestId };
    const again = await worker.run(request({ intention: held }));
    expect(again).toMatchObject({ kind: 'suspended', resumeToken: first.resumeToken, request: { requestId: first.request.requestId } });
    expect(llm.requests).toHaveLength(1);
    expect([...ledger.approvals.keys()]).toHaveLength(1);
    // a token that belongs to another step fails closed
    const other = await worker.run(request({ intention: { ...held, id: 'i-other' } }));
    expect(other).toMatchObject({ kind: 'failed', error: { name: 'ResumeError' } });
    const missing = await worker.run(request({ intention: { ...held, resumeToken: 'nope' } }));
    expect(missing).toMatchObject({ kind: 'failed', error: { name: 'ResumeError' } });
  });

  it('resume without a configured lease keeps writes refused (fail closed)', async () => {
    const ledger = new FakeLedger();
    const mk = () => new StepWorker({ seats: { cheap: new FakeLLM([editOnly]) }, repl: new FakeRepl(), tools: tools(), hooks: [gate], ledger, sessionId: 'sess' });
    const first = await mk().run(request());
    if (first.kind !== 'suspended') throw new Error('expected suspended');
    const grant = await ledger.grantAudited(first.request.requestId, { kind: 'human', id: 'reviewer' }, 'sess', Date.now());
    const out: Outcome = await mk().resume(first.resumeToken, grant, undefined, liveWriteGuard());
    expect(out.kind).not.toBe('returned');
    expect(await readFile(join(root, 'src/sum.ts'), 'utf8')).toContain('a - b');
  });
});
