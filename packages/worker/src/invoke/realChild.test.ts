import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newIntention, type CapabilitySet, type Effect, type Hook, type Inputs, type JsonObject, type Plan, type SpanEvent, type WorkerStepRequest } from '@tecera/contracts';
import { ChildProcessRepl } from '../sandbox/host.js';
import { Broker } from '../broker/broker.js';
import { EXAMPLE_PROGRAM } from '../protocol/prompts.js';
import { createEditTool } from '../tools/edit.js';
import { createListFilesTool } from '../tools/listFiles.js';
import { createReadTool } from '../tools/read.js';
import { FakeLedger, FakeLLM, liveWriteGuard } from './fakes.js';
import { invoke, type InvokeOptions, type ReplFactory } from './invoke.js';
import { StepWorker } from './stepWorker.js';
import type { TraceEntry } from './span.js';

/**
 * The invoke loop against the REAL sandbox child (ChildProcessRepl), wired the way production wires it:
 * a REPL factory per exec whose host callbacks belong to that exec's broker, speaking the contracts/rpc.ts
 * dialect (callable stubs, nested `{output, narrow}` options, view handles for large values).
 */

const sandbox = { profile: 'process' as const, isolation: 'node' as const, memoryMb: 128, execTimeoutSec: 20, envAllowlist: ['PATH', 'HOME'] };
const caps = (tools = ['read', 'edit', 'listFiles']): CapabilitySet => ({
  tools,
  paths: { read: ['**'], write: ['src/**'], protected: ['test/**'] },
  network: 'none',
  limits: { usd: 1, tokens: 100_000, calls: 50, wallMs: 60_000, depth: 4, iterations: 6 },
});
const js = (body: string): string => `\`\`\`js\n${body}\n\`\`\``;
const made: Array<{ invokeId: string; execNo: number; tools: string[] }> = [];
const factory: ReplFactory = (ctx) => {
  made.push({ invokeId: ctx.invokeId, execNo: ctx.execNo, tools: ctx.capabilities.tools });
  return new ChildProcessRepl({ runId: ctx.runId, sandbox, capabilities: ctx.capabilities, onInvoke: ctx.callbacks.onInvoke, onCheckpoint: ctx.callbacks.onCheckpoint, handleKey: Buffer.alloc(32, 7) });
};

let root: string;
beforeEach(async () => {
  made.length = 0;
  root = await mkdtemp(join(tmpdir(), 'tecera-realchild-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const SCHEMA: JsonObject = { type: 'object' };
const goal: Inputs = { goal: { kind: 'value', value: { statement: 'probe' }, provenance: { src: 'goal', trust: 'trusted' } } };
const hook = (id: string, spans: SpanEvent['span'][], fn: (e: SpanEvent) => Effect[]): Hook => ({ id, mandatory: false, spans: new Set(spans), handle: fn, describe: () => ({ id, mandatory: false, config: {} }) });
function opts(llm: FakeLLM, extra: Partial<InvokeOptions> = {}): InvokeOptions {
  return { output: SCHEMA, hooks: [], llm, repl: factory, broker: new Broker({ tools: [createReadTool(), createEditTool(), createListFilesTool()], runId: 'run_rc', worktree: root, capabilities: caps(), fencingToken: 1, guard: liveWriteGuard() }), run: { runId: 'run_rc', invokeId: 'inv_rc', depth: 0 }, ...extra };
}

describe('invoke on the real sandbox child', () => {
  it('method-form tool calls and truncated-result view handles work end to end', async () => {
    await writeFile(join(root, 'src/big.txt'), 'abc'.repeat(30_000));
    const llm = new FakeLLM([js(`const f = await readFile.call('src/big.txt');\nreturn { len: await f.content.len(), tail: await f.content.slice(89991, 90000), hits: (await f.content.search('cab')).length };`)]);
    const out = await invoke(goal, opts(llm));
    expect(out).toMatchObject({ kind: 'returned', value: { len: 90_000, tail: 'abcabcabc', hits: 100 } });
  }, 60_000);

  it('dos.fork_bomb_subinvoke: recursion through the factory wiring is counted per invoke and stopped by the recursion hook', async () => {
    const depths: number[] = [];
    const recursion = hook('recursionLimit', ['Invoke'], (e) => (e.stage === 'Enter' ? (depths.push(e.run.depth), e.run.depth >= 2 ? [{ type: 'Abort', code: 'recursion', reason: 'too deep' }] : []) : []));
    const reserve = hook('budget', ['LLMQuery'], (e) => (e.stage === 'Send' ? [{ type: 'ReserveBudget', pool: 'calls', amount: 1 }] : []));
    const ledger = new FakeLedger();
    await ledger.openBudget('run_rc', 'calls', 10);
    const bomb = js(`let r; try { r = await invoke({}, { output: {} }); } catch (e) { r = { error: e.message }; }\nreturn { depth: __depth__, inner: r };`);
    const trace: TraceEntry[] = [];
    const out = await invoke(goal, opts(new FakeLLM([bomb, bomb, bomb]), { hooks: [recursion, reserve], ledger, trace }));
    expect(out.kind).toBe('returned');
    expect(depths).toEqual([0, 1, 2]);
    expect(JSON.stringify(out)).toMatch(/recursion: too deep/);
    // one REPL per exec, each bound to its own invoke
    expect(made.map((m) => m.invokeId)).toEqual(['inv_rc', 'inv_rc/e1c1']);
    expect(trace.filter((t) => t.type === 'reserve')).toHaveLength(2);
  }, 60_000);

  it("checkpoint ownership: a nested invoke's checkpoint() lands in the child, never in the parent", async () => {
    const parent = js(`const r = await invoke({}, { output: {} });\ncheckpoint('parentKey', 1);\nreturn { child: r.value };`);
    const childTurn1 = js(`checkpoint('childKey', 41);`);
    const childTurn2 = js(`return { v: checkpoints.childKey + 1, keys: Object.keys(checkpoints) };`);
    const out = await invoke(goal, opts(new FakeLLM([parent, childTurn1, childTurn2])));
    expect(out).toMatchObject({ kind: 'returned', value: { child: { v: 42, keys: ['childKey'] } } });
  }, 60_000);

  it('callable tool stubs (contracts rpc dialect): the prompt example runs on the real child', async () => {
    const plan: Plan = { id: 'p', trigger: { kind: 'goal.adopted' }, context: [], steps: [{ id: 's', kind: 'worker', dependsOn: [], inputs: {} }], allowedModels: {}, permissions: { tools: ['read', 'listFiles'], write: [], approvals: [] }, budget: {}, origin: 'generated', status: 'candidate', goalKinds: [] };
    const req: WorkerStepRequest = {
      runId: 'run_rc',
      goal: { id: 'g', statement: 'read', check: { command: 'true', timeoutSec: 5 }, commitment: 'blind', status: 'open', evidence: [] },
      plan,
      intention: newIntention({ id: 'i', goalId: 'g', plan, commitment: 'blind' }),
      step: plan.steps[0]!,
      seatId: 'w',
      inputs: {},
      capabilities: caps(['read', 'listFiles']),
      worktree: root,
    };
    const worker = new StepWorker({ seats: { w: new FakeLLM([js(EXAMPLE_PROGRAM)]) }, repl: factory, tools: [createReadTool(), createListFilesTool()], hooks: [] });
    expect(await worker.run(req)).toMatchObject({ kind: 'returned', value: { summary: 'read src/a.ts' } });
  }, 60_000);

  it('nested narrowing through {output, narrow} (contracts rpc dialect) reaches the child invoke', async () => {
    const parent = js(`const r = await invoke({}, { output: {}, narrow: { tools: ['read'] } });\nreturn { child: r.value };`);
    const child = js(`return { tools: __capabilities__.tools, canWrite: typeof writeFile };`);
    const out = await invoke(goal, opts(new FakeLLM([parent, child])));
    expect(out).toMatchObject({ kind: 'returned', value: { child: { tools: ['read'], canWrite: 'undefined' } } });
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
  }, 60_000);

  it('suspension and resume through the real child: the gated write happens exactly once, after the grant', async () => {
    const gate = hook('approvalGate', ['ToolCall'], (e) => {
      const i = e.input as { tool: string; actionHash: string };
      return e.stage === 'Send' && i.tool === 'edit' ? [{ type: 'Suspend', request: { requestId: `ap_${e.spanId}`, action: 'edit', actionHash: i.actionHash, reason: 'edit requires approval', requester: 'worker' } }] : [];
    });
    const ledger = new FakeLedger();
    const program = js(`const f = await readFile('src/a.ts');\nawait writeFile({ path: 'src/a.ts', oldText: '= 1', newText: '= 2' });\nreturn { done: f.path };`);
    const first = await invoke(goal, opts(new FakeLLM([program]), { hooks: [gate], ledger }));
    expect(first.kind).toBe('suspended');
    if (first.kind !== 'suspended') return;
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    const g = await ledger.grantAudited(first.request.requestId, { kind: 'human', id: 'h' }, 'local', Date.now());
    const { resume } = await import('./invoke.js');
    const done = await resume(first.resumeToken, g, { hooks: [gate], llm: new FakeLLM([]), repl: factory, broker: opts(new FakeLLM([])).broker, ledger });
    expect(done).toMatchObject({ kind: 'returned', value: { done: 'src/a.ts' } });
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
  }, 60_000);
});
