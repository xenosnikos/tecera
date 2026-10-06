import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CapabilitySet, Effect, Hook, Inputs, JsonObject, SpanEvent, Tool } from '@tecera/contracts';
import { Broker } from '../broker/broker.js';
import { createEditTool } from '../tools/edit.js';
import { createReadTool } from '../tools/read.js';
import { FakeLedger, FakeLLM, FakeRepl, liveWriteGuard } from './fakes.js';
import { invoke, resume, type InvokeOptions } from './invoke.js';
import type { TraceEntry } from './span.js';

const caps = (tools = ['read', 'edit']): CapabilitySet => ({
  tools,
  paths: { read: ['**'], write: ['src/**'], protected: ['test/**'] },
  network: 'none',
  limits: { usd: 1, tokens: 100_000, calls: 50, wallMs: 60_000, depth: 3, iterations: 10 },
});
const hook = (id: string, spans: SpanEvent['span'][], fn: (e: SpanEvent) => Effect[] | Promise<Effect[]>): Hook => ({ id, mandatory: false, spans: new Set(spans), handle: fn, describe: () => ({ id, mandatory: false, config: {} }) });
/** Local stand-in for policy's IterationLimit (the worker never imports policy). */
const iterationLimit = (max: number): Hook => {
  const counts = new Map<string, number>();
  return hook('iterationLimit', ['LLMQuery'], (e) => {
    if (e.stage !== 'Enter') return [];
    const n = (counts.get(e.run.invokeId) ?? 0) + 1;
    counts.set(e.run.invokeId, n);
    return n > max ? [{ type: 'Abort', code: 'iterations', reason: `iteration ${n} exceeds ${max}` }] : [];
  });
};
const recursionLimit = (max: number): Hook => hook('recursionLimit', ['Invoke'], (e) => (e.stage === 'Enter' && e.run.depth >= max ? [{ type: 'Abort', code: 'recursion', reason: 'too deep' }] : []));
const approvalGate = hook('approvalGate', ['ToolCall'], (e) => {
  const i = e.input as { tool: string; actionHash: string };
  return e.stage === 'Send' && i.tool === 'edit' ? [{ type: 'Suspend', request: { requestId: `ap_${e.run.runId}_${e.spanId}`, action: 'edit', actionHash: i.actionHash, reason: 'edit requires approval', requester: 'worker' } }] : [];
});
const js = (body: string): string => `\`\`\`js\n${body}\n\`\`\``;
const SCHEMA: JsonObject = { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } };
const goal: Inputs = { goal: { kind: 'value', value: { statement: 'make a = 2' }, provenance: { src: 'goal', trust: 'trusted' } } };

let root: string;
let reads = 0;
const countingRead = (): Tool => {
  const inner = createReadTool();
  return { ...inner, call: async (r, c) => (reads++, inner.call(r, c)) };
};
beforeEach(async () => {
  reads = 0;
  root = await mkdtemp(join(tmpdir(), 'tecera-invoke-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
});
afterEach(async () => rm(root, { recursive: true, force: true }));

function opts(llm: FakeLLM, extra: Partial<InvokeOptions> = {}): InvokeOptions {
  return {
    output: SCHEMA,
    hooks: [],
    llm,
    repl: new FakeRepl(),
    broker: new Broker({ tools: [countingRead(), createEditTool()], runId: 'run_1', worktree: root, capabilities: caps(), fencingToken: 1, guard: liveWriteGuard() }),
    run: { runId: 'run_1', invokeId: 'inv_1', depth: 0 },
    ...extra,
  };
}

describe('invoke', () => {
  it('happy path: continue, then return on the second turn', async () => {
    const llm = new FakeLLM([js(`const f = await readFile('src/a.ts');\nconsole.log('len', f.content.length);`), js(`const n = await __history__.len();\nreturn { summary: 'read ' + n + ' turn(s)' };`)]);
    const trace: TraceEntry[] = [];
    const out = await invoke(goal, opts(llm, { trace }));
    expect(out).toMatchObject({ kind: 'returned', value: { summary: 'read 1 turn(s)' }, run: { runId: 'run_1', invokeId: 'inv_1' } });
    expect(llm.requests).toHaveLength(2);
    const second = llm.requests[1]!.messages;
    expect(second[0]!.role).toBe('system');
    expect(second.at(-1)!.content).toMatch(/Result of turn 1 \(continue\):\n<untrusted src="repl" nonce="[a-f0-9]{16}">\nlen 20/);
    expect(second[1]!.content).toContain('### goal (value, src=goal, trusted)');
    const spans = trace.filter((t) => t.type === 'span').map((t) => (t.type === 'span' ? `${t.span}/${t.stage}` : ''));
    expect(spans.slice(0, 2)).toEqual(['Invoke/Enter', 'Invoke/Send']);
    expect(spans).toContain('ToolCall/Exit');
    expect(spans.at(-2)).toBe('Invoke/Complete');
    expect(spans.at(-1)).toBe('Invoke/Exit');
  });

  it('a return failing the output schema goes back to the model; the iteration hook then aborts', async () => {
    const llm = new FakeLLM([js('return { nope: 1 };'), js('return { summary: 42 };'), js('return { summary: "never reached" };')]);
    const out = await invoke(goal, opts(llm, { hooks: [iterationLimit(2)] }));
    expect(out.kind).toBe('aborted');
    if (out.kind === 'aborted') expect(out.reasons).toEqual([{ code: 'iterations', reason: 'iteration 3 exceeds 2', hookId: 'iterationLimit' }]);
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.messages.at(-1)!.content).toMatch(/ReturnSchemaError: .*\$\.summary: required/);
  });

  it('parse failures and thrown errors are fed back, not fatal', async () => {
    const llm = new FakeLLM(['```js\nconst x = require("fs");\n```', js('throw new Error("boom")'), js('return { summary: "ok" };')]);
    const out = await invoke(goal, opts(llm));
    expect(out.kind).toBe('returned');
    expect(llm.requests[1]!.messages.at(-1)!.content).toContain('ParseError: require is not available');
    expect(llm.requests[2]!.messages.at(-1)!.content).toContain('Error: boom');
  });

  it('Abort dominates other effects at the same stage, and a throwing hook aborts', async () => {
    const replace = hook('replace', ['LLMQuery'], (e) => (e.stage === 'Send' ? [{ type: 'ReplaceOutput', value: js('return {summary: "hijack"}') }] : []));
    const stop = hook('stop', ['LLMQuery'], (e) => (e.stage === 'Send' ? [{ type: 'Abort', code: 'policy', reason: 'stop' }] : []));
    const out = await invoke(goal, opts(new FakeLLM([]), { hooks: [replace, stop] }));
    expect(out).toMatchObject({ kind: 'aborted', reasons: [{ code: 'policy', reason: 'stop', hookId: 'stop' }] });
    const thrower = hook('thrower', ['Invoke'], () => {
      throw new Error('bug');
    });
    const out2 = await invoke(goal, opts(new FakeLLM([]), { hooks: [thrower] }));
    expect(out2).toMatchObject({ kind: 'aborted', reasons: [{ code: 'hookError', hookId: 'thrower' }] });
    // without the abort, ReplaceOutput skips the model entirely
    const out3 = await invoke(goal, opts(new FakeLLM([]), { hooks: [replace] }));
    expect(out3).toMatchObject({ kind: 'returned', value: { summary: 'hijack' } });
  });

  it('a protected write is denied and recorded, and the invoke continues', async () => {
    const llm = new FakeLLM([js(`try { await writeFile('test/a.test.ts', 'x'); } catch (e) { console.log('denied:', e.name, e.message); }\nreturn { summary: 'tried' };`)]);
    const trace: TraceEntry[] = [];
    const prot = hook('protectedPaths', ['ToolCall'], (e) => (e.stage === 'Enter' && String((e.input as { path?: string }).path).startsWith('test/') ? [{ type: 'Abort', code: 'protected', reason: 'test/ is protected' }] : []));
    const out = await invoke(goal, opts(llm, { hooks: [prot], trace }));
    expect(out.kind).toBe('returned');
    expect(trace.some((t) => t.type === 'evidence' && t.kind === 'tool.denied')).toBe(true);
  });

  it('Suspend at ToolCall Send → suspended with checkpoint and approval request; resume completes once', async () => {
    const ledger = new FakeLedger();
    const program = js(`const f = await readFile('src/a.ts');\nconst r = await writeFile({ path: 'src/a.ts', oldText: '= 1', newText: '= 2' });\nreturn { summary: 'edited ' + r.path };`);
    const llm = new FakeLLM([program]);
    const first = await invoke(goal, opts(llm, { hooks: [approvalGate], ledger }));
    expect(first.kind).toBe('suspended');
    if (first.kind !== 'suspended') return;
    expect(first.request.reason).toBe('edit requires approval');
    expect(first.run.checkpointId).toBe(first.resumeToken);
    expect(ledger.checkpoints.has(first.resumeToken)).toBe(true);
    expect(ledger.approvals.get(first.request.requestId)?.state).toBe('pending');
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(reads).toBe(1);

    const grant = await ledger.grantAudited(first.request.requestId, { kind: 'human', id: 'alice' }, 'local', Date.now());
    const deps = () => ({ hooks: [approvalGate], llm: new FakeLLM([]), repl: new FakeRepl(), broker: new Broker({ tools: [countingRead(), createEditTool()], runId: 'run_1', worktree: root, capabilities: caps(), fencingToken: 1, guard: liveWriteGuard() }), ledger });
    const second = await resume(first.resumeToken, grant, deps());
    expect(second).toMatchObject({ kind: 'returned', value: { summary: 'edited src/a.ts' } });
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(reads).toBe(2); // reads are never journalled: the read re-ran under the current scope
    expect(ledger.approvals.get(first.request.requestId)?.state).toBe('consumed');
    // replaying the grant fails closed
    const third = await resume(first.resumeToken, grant, deps());
    expect(third.kind).toBe('aborted');
    // a grant for another request is refused
    const wrong = await resume(first.resumeToken, { ...grant, requestId: 'other' }, deps());
    expect(wrong).toMatchObject({ kind: 'aborted', reasons: [{ code: 'policy' }] });
  });

  it('suspends without a ledger using an in-process checkpoint', async () => {
    const llm = new FakeLLM([js(`await writeFile('src/b.ts', 'x');\nreturn { summary: 'ok' };`)]);
    const first = await invoke(goal, opts(llm, { hooks: [approvalGate] }));
    expect(first.kind).toBe('suspended');
    if (first.kind !== 'suspended') return;
    expect(first.resumeToken).toMatch(/^mem:/);
    const grant = { requestId: first.request.requestId, approver: { kind: 'human' as const, id: 'a' }, grantedAt: 0, expiresAt: Date.now() + 60_000 };
    const d = () => ({ hooks: [approvalGate], llm: new FakeLLM([]), repl: new FakeRepl(), broker: new Broker({ tools: [createEditTool()], runId: 'run_1', worktree: root, capabilities: caps(), fencingToken: 1, guard: liveWriteGuard() }) });
    // without a ledger a grant cannot be verified: refused unless explicitly allowed (tests only)
    expect(await resume(first.resumeToken, grant, d())).toMatchObject({ kind: 'aborted', reasons: [{ reason: expect.stringMatching(/no ledger/) }] });
    await expect(readFile(join(root, 'src/b.ts'), 'utf8')).rejects.toThrow();
    const out = await resume(first.resumeToken, grant, { ...d(), allowUnverifiedGrants: true });
    expect(out.kind).toBe('returned');
    expect(await readFile(join(root, 'src/b.ts'), 'utf8')).toBe('x');
  });

  it('nested invoke narrows capabilities, adds depth, shares hooks, and refuses widening with evidence', async () => {
    const seenDepths: number[] = [];
    const depthSpy = hook('depthSpy', ['Invoke'], (e) => (e.stage === 'Enter' ? (seenDepths.push(e.run.depth), []) : []));
    const parent = js(`const child = await invoke({ question: 'which tools?' }, { output: { type: 'object' }, narrow: { tools: ['read'] } });
let widened = 'no error';
try { await invoke({}, { narrow: { tools: ['read', 'edit', 'shell'] } }); } catch (e) { widened = e.name + ': ' + e.message; }
return { summary: JSON.stringify({ child, widened }) };`);
    const child = js(`return { tools: __capabilities__.tools, depth: __depth__, canWrite: typeof writeFile, q: question };`);
    const llm = new FakeLLM([parent, child]);
    const trace: TraceEntry[] = [];
    const out = await invoke(goal, opts(llm, { hooks: [depthSpy, recursionLimit(3)], trace }));
    expect(out.kind).toBe('returned');
    if (out.kind !== 'returned') return;
    const v = JSON.parse((out.value as { summary: string }).summary);
    expect(v.child).toEqual({ kind: 'returned', value: { tools: ['read'], depth: 1, canWrite: 'undefined', q: 'which tools?' } });
    expect(v.widened).toMatch(/E_DENIED: .*beyond its parent/);
    expect(seenDepths).toEqual([0, 1]);
    expect(trace.some((t) => t.type === 'evidence' && t.kind === 'capability.widen.refused')).toBe(true);
    expect(llm.requests[1]!.messages[1]!.content).toContain('<untrusted src="invoke:inv_1"');
  });

  it('the recursion hook stops runaway nesting', async () => {
    const program = js(`let r; try { r = await invoke({}, { output: { type: 'object' } }); } catch (e) { r = e.name + ': ' + e.message; } return { summary: JSON.stringify(r) };`);
    const llm = new FakeLLM([program]);
    const out = await invoke(goal, opts(llm, { hooks: [recursionLimit(1)] }));
    expect(out.kind).toBe('returned');
    if (out.kind === 'returned') expect((out.value as { summary: string }).summary).toMatch(/E_ABORTED: recursion: too deep/);
  });

  it('checkpoint() values survive to later turns; method-form stubs work too', async () => {
    const llm = new FakeLLM([js(`const f = await readFile.call('src/a.ts');\ncheckpoint('len', f.content.length);`), js(`return { summary: 'len=' + checkpoints.len };`)]);
    const out = await invoke(goal, opts(llm));
    expect(out).toMatchObject({ kind: 'returned', value: { summary: 'len=20' } });
    expect(llm.requests[1]!.messages[1]!.content).toContain('### checkpoints (value, src=checkpoint, untrusted)');
  });

  it('refuses reserved bindings and cancels on signal', async () => {
    const bad = await invoke({ __history__: { kind: 'hidden', value: [] } }, opts(new FakeLLM([])));
    expect(bad).toMatchObject({ kind: 'aborted', reasons: [{ code: 'policy' }] });
    const ac = new AbortController();
    ac.abort();
    const out = await invoke(goal, opts(new FakeLLM([js('return {summary:"x"}')]), { signal: ac.signal }));
    expect(out).toMatchObject({ kind: 'aborted', reasons: [{ code: 'cancelled' }] });
  });

  it('ReserveBudget goes to the ledger and an exhausted pool aborts with budget', async () => {
    const ledger = new FakeLedger();
    await ledger.openBudget('run_1', 'calls', 1);
    const reserve = hook('budget', ['LLMQuery'], (e) => (e.stage === 'Send' ? [{ type: 'ReserveBudget', pool: 'calls', amount: 1 }] : []));
    const llm = new FakeLLM([js('console.log(1)'), js('return {summary:"x"}')]);
    const out = await invoke(goal, opts(llm, { hooks: [reserve], ledger }));
    expect(out).toMatchObject({ kind: 'aborted', reasons: [{ code: 'budget' }] });
    expect(llm.requests).toHaveLength(1);
  });

  it('LLM transport failures retry, then fail', async () => {
    const llm = new FakeLLM([new Error('503'), js('return {summary:"after retry"}')]);
    expect(await invoke(goal, opts(llm))).toMatchObject({ kind: 'returned' });
    const dead = new FakeLLM([new Error('a'), new Error('b'), new Error('c')]);
    expect(await invoke(goal, opts(dead))).toMatchObject({ kind: 'failed', error: { name: 'LLMError' } });
  });

  it('redacts secrets from prompts', async () => {
    const llm = new FakeLLM([js(`const f = await readFile('src/s.txt'); console.log(f.content);`), js('return {summary:"x"}')]);
    await writeFile(join(root, 'src/s.txt'), 'token=s3cr3t-value-123 and TECERA_CANARY_zz9');
    const out = await invoke(goal, opts(llm, { secrets: ['s3cr3t-value-123'] }));
    expect(out.kind).toBe('returned');
    const all = JSON.stringify(llm.requests);
    expect(all).not.toContain('s3cr3t-value-123');
    expect(all).not.toContain('TECERA_CANARY_zz9');
    expect(all).toContain('[REDACTED:canary:');
  });
});
