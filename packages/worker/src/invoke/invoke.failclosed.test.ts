import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CapabilitySet, Effect, Hook, Inputs, Json, JsonObject, Ledger, SpanEvent, SpanKind, Tool } from '@tecera/contracts';
import { Broker } from '../broker/broker.js';
import { scope } from '../scope.js';
import { createEditTool } from '../tools/edit.js';
import { createReadTool } from '../tools/read.js';
import { FakeLedger, FakeLLM, FakeRepl, liveWriteGuard } from './fakes.js';
import { invoke, resume, type InvokeOptions, type ResumeDeps } from './invoke.js';
import type { TraceEntry } from './span.js';

const caps = (tools = ['read', 'edit']): CapabilitySet => ({
  tools,
  paths: { read: ['**'], write: ['src/**'], protected: ['test/**'] },
  network: 'none',
  limits: { usd: 1, tokens: 100_000, calls: 50, wallMs: 60_000, depth: 3, iterations: 10 },
});
const hook = (id: string, spans: SpanEvent['span'][], fn: (e: SpanEvent) => Effect[] | Promise<Effect[]>): Hook => ({ id, mandatory: false, spans: new Set(spans), handle: fn, describe: () => ({ id, mandatory: false, config: {} }) });
const approvalGate = hook('approvalGate', ['ToolCall'], (e) => {
  const i = e.input as { tool: string; actionHash: string };
  return e.stage === 'Send' && i.tool === 'edit' ? [{ type: 'Suspend', request: { requestId: `ap_${e.run.runId}_${e.spanId}`, action: 'edit', actionHash: i.actionHash, reason: 'edit requires approval', requester: 'worker' } }] : [];
});
const js = (body: string): string => `\`\`\`js\n${body}\n\`\`\``;
const SCHEMA: JsonObject = { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } };
const goal: Inputs = { goal: { kind: 'value', value: { statement: 'make a = 2' }, provenance: { src: 'goal', trust: 'trusted' } } };
const CANARY = 'TECERA_CANARY_invoke_Zz9';
const SECRET = 'sk-live-secret-value-0001';

let root: string;
let writes = 0;
const countingEdit = (): Tool => {
  const inner = createEditTool();
  return Object.assign({ ...inner }, { call: async (r: Parameters<Tool['call']>[0], c: Parameters<Tool['call']>[1], g?: Parameters<Tool['call']>[2]) => (writes++, inner.call(r, c, g)) });
};
beforeEach(async () => {
  writes = 0;
  root = await mkdtemp(join(tmpdir(), 'tecera-invoke-fc-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const mkBroker = (c: CapabilitySet = caps()) => new Broker({ tools: [createReadTool(), countingEdit()], runId: 'run_1', worktree: root, capabilities: c, fencingToken: 1, guard: liveWriteGuard() });
function opts(llm: FakeLLM, extra: Partial<InvokeOptions> = {}): InvokeOptions {
  return { output: SCHEMA, hooks: [], llm, repl: new FakeRepl(), broker: mkBroker(), run: { runId: 'run_1', invokeId: 'inv_1', depth: 0 }, ...extra };
}
const deps = (ledger: Ledger | undefined, extra: Partial<ResumeDeps> = {}): ResumeDeps => ({ hooks: [approvalGate], llm: new FakeLLM([]), repl: new FakeRepl(), broker: mkBroker(), ...(ledger ? { ledger } : {}), ...extra });
const human = { kind: 'human' as const, id: 'alice' };

describe('approval.hash_mismatch / approval.replay: one grant binds one request', () => {
  const twoEdits = js(`const [x, y] = await Promise.all([writeFile('src/x.ts', 'X'), writeFile('src/y.ts', 'Y')]);\nreturn { summary: x.path + ' ' + y.path };`);

  it('two simultaneous approval requirements are both persisted and must be granted independently', async () => {
    const ledger = new FakeLedger();
    const first = await invoke(goal, opts(new FakeLLM([twoEdits]), { hooks: [approvalGate], ledger }));
    expect(first.kind).toBe('suspended');
    if (first.kind !== 'suspended') return;
    const pendingIds = [...ledger.approvals.values()].filter((a) => a.state === 'pending').map((a) => a.requestId);
    expect(pendingIds).toHaveLength(2);
    expect(pendingIds).toContain(first.request.requestId);
    // approve ONLY the first: resume answers with the second request, nothing is written
    const g1 = await ledger.grantAudited(first.request.requestId, human, 'local', Date.now());
    const second = await resume(first.resumeToken, g1, deps(ledger));
    expect(second.kind).toBe('suspended');
    if (second.kind !== 'suspended') return;
    expect(second.request.requestId).not.toBe(first.request.requestId);
    expect(pendingIds).toContain(second.request.requestId);
    expect(second.resumeToken).not.toBe(first.resumeToken);
    expect(writes).toBe(0);
    await expect(readFile(join(root, 'src/x.ts'), 'utf8')).rejects.toThrow();
    // the first grant cannot be applied twice
    expect(await resume(second.resumeToken, g1, deps(ledger))).toMatchObject({ kind: 'aborted', reasons: [{ code: 'policy' }] });
    const g2 = await ledger.grantAudited(second.request.requestId, human, 'local', Date.now());
    const done = await resume(second.resumeToken, g2, deps(ledger));
    expect(done).toMatchObject({ kind: 'returned', value: { summary: 'src/x.ts src/y.ts' } });
    expect(writes).toBe(2);
    expect(ledger.consumed.sort()).toEqual(pendingIds.sort());
  });

  it('a call suspended by two hooks needs both grants; a stale token cannot skip one', async () => {
    const gate2 = hook('secondGate', ['ToolCall'], (e) => {
      const i = e.input as { tool: string; actionHash: string };
      return e.stage === 'Send' && i.tool === 'edit' ? [{ type: 'Suspend', request: { requestId: `ap2_${e.spanId}`, action: 'edit', actionHash: i.actionHash, reason: 'second gate', requester: 'worker' } }] : [];
    });
    const ledger = new FakeLedger();
    const program = js(`await writeFile('src/a.ts', 'two gates');\nreturn { summary: 'ok' };`);
    const first = await invoke(goal, opts(new FakeLLM([program]), { hooks: [approvalGate, gate2], ledger }));
    if (first.kind !== 'suspended') throw new Error(`expected suspended, got ${first.kind}`);
    const g1 = await ledger.grantAudited(first.request.requestId, human, 'local', Date.now());
    const mid = await resume(first.resumeToken, g1, deps(ledger, { hooks: [approvalGate, gate2] }));
    if (mid.kind !== 'suspended') throw new Error(`expected suspended, got ${mid.kind}`);
    // replaying the ORIGINAL token with the first grant again fails (already consumed)
    expect((await resume(first.resumeToken, g1, deps(ledger, { hooks: [approvalGate, gate2] }))).kind).toBe('aborted');
    const g2 = await ledger.grantAudited(mid.request.requestId, human, 'local', Date.now());
    expect(await resume(mid.resumeToken, g2, deps(ledger, { hooks: [approvalGate, gate2] }))).toMatchObject({ kind: 'returned' });
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('two gates');
  });

  it('changed arguments on resume: the grant does not cover the new action, which suspends again', async () => {
    const ledger = new FakeLedger();
    const program = js(`const f = await readFile('src/a.ts');\nawait writeFile('src/a.ts', f.content + '// reviewed\\n');\nreturn { summary: 'ok' };`);
    const first = await invoke(goal, opts(new FakeLLM([program]), { hooks: [approvalGate], ledger }));
    if (first.kind !== 'suspended') throw new Error('expected suspended');
    const g = await ledger.grantAudited(first.request.requestId, human, 'local', Date.now());
    await writeFile(join(root, 'src/a.ts'), 'export const a = 666;\n'); // the tree changed after approval
    const again = await resume(first.resumeToken, g, deps(ledger));
    expect(again.kind).toBe('suspended');
    if (again.kind === 'suspended') expect(again.request.actionHash).not.toBe(first.request.actionHash);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 666;\n');
    expect(writes).toBe(0);
  });

  it('cross-session, wrong-approver, unverifiable and expired grants are refused', async () => {
    const ledger = new FakeLedger();
    const program = js(`await writeFile('src/a.ts', 'x');\nreturn { summary: 'ok' };`);
    const first = await invoke(goal, opts(new FakeLLM([program]), { hooks: [approvalGate], ledger, sessionId: 'sess-A' }));
    if (first.kind !== 'suspended') throw new Error('expected suspended');
    await expect(ledger.grantAudited(first.request.requestId, human, 'sess-B', Date.now())).rejects.toThrow(/session/);
    const g = await ledger.grantAudited(first.request.requestId, human, 'sess-A', Date.now());
    expect(await resume(first.resumeToken, g, deps(ledger, { sessionId: 'sess-B' }))).toMatchObject({ kind: 'aborted', reasons: [{ reason: expect.stringMatching(/another session/) }] });
    expect(await resume(first.resumeToken, { ...g, approver: { kind: 'human', id: 'mallory' } }, deps(ledger, { sessionId: 'sess-A' }))).toMatchObject({ kind: 'aborted', reasons: [{ reason: expect.stringMatching(/approver/) }] });
    expect(await resume(first.resumeToken, { ...g, expiresAt: Date.now() - 1 }, deps(ledger, { sessionId: 'sess-A' }))).toMatchObject({ kind: 'aborted', reasons: [{ reason: expect.stringMatching(/expired/) }] });
    expect(await resume(first.resumeToken, { ...g, approver: { kind: 'agent', id: 'alice' } }, deps(ledger, { sessionId: 'sess-A' }))).toMatchObject({ kind: 'aborted' });
    const noLookup = Object.assign(Object.create(Object.getPrototypeOf(ledger)), ledger) as FakeLedger;
    (noLookup as { getApproval?: unknown }).getApproval = undefined;
    expect(await resume(first.resumeToken, g, deps(noLookup, { sessionId: 'sess-A' }))).toMatchObject({ kind: 'aborted', reasons: [{ reason: expect.stringMatching(/cannot be verified/) }] });
    expect(writes).toBe(0);
    expect(ledger.approvals.get(first.request.requestId)?.state).toBe('granted'); // nothing above consumed it
    expect(await resume(first.resumeToken, g, deps(ledger, { sessionId: 'sess-A' }))).toMatchObject({ kind: 'returned' });
  });

  it('nested suspension recovery: the child resumes from its own checkpoint (no re-planning) and its grant lifts exactly its action', async () => {
    const ledger = new FakeLedger();
    const parent = js(`const r = await invoke({ file: 'src/a.ts' }, { output: { type: 'object' }, narrow: { tools: ['read', 'edit'] } });\nreturn { summary: 'child said ' + JSON.stringify(r.value) };`);
    const child = js(`await writeFile(file, 'from child');\nreturn { wrote: file };`);
    const llm = new FakeLLM([parent, child]);
    const first = await invoke(goal, opts(llm, { hooks: [approvalGate], ledger }));
    if (first.kind !== 'suspended') throw new Error(`expected suspended, got ${JSON.stringify(first)}`);
    expect(first.request.requestId).toContain('inv_1/e1c1'); // the child's own request, tree-unique id
    expect([...ledger.approvals.values()]).toHaveLength(1); // requested once, by the child
    expect(ledger.checkpoints.size).toBe(2); // child checkpoint preserved + parent checkpoint
    const g = await ledger.grantAudited(first.request.requestId, human, 'local', Date.now());
    const done = await resume(first.resumeToken, g, deps(ledger, { llm }));
    expect(done).toMatchObject({ kind: 'returned', value: { summary: 'child said {"wrote":"src/a.ts"}' } });
    expect(llm.requests).toHaveLength(2); // neither parent nor child asked the model again
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('from child');
    expect(writes).toBe(1);
  });

  it('nested invoke options must use the contract dialect; unknown options are refused, not ignored', async () => {
    const program = js(`let r; try { await invoke({}, { tools: ['read'] }); r = 'accepted'; } catch (e) { r = e.message; }\nreturn { summary: r };`);
    const out = await invoke(goal, opts(new FakeLLM([program])));
    expect(out).toMatchObject({ kind: 'returned', value: { summary: expect.stringMatching(/unknown option\(s\) tools/) } });
  });
});

describe('recover.crash_each_step: a failed record at any Exit is terminal', () => {
  const kinds: SpanKind[] = ['Invoke', 'LLMQuery', 'REPLExec', 'ToolCall'];
  for (const target of kinds) {
    it(`evidence failure at ${target}/Exit → aborted (ledger) and nothing further runs`, async () => {
      const ledger = new FakeLedger();
      const real = ledger.evidence.bind(ledger);
      ledger.evidence = async (e) => {
        if (e.key.startsWith(`exit:${target}:`)) throw new Error('disk full');
        return real(e);
      };
      const rec = hook('rec', ['Invoke', 'LLMQuery', 'REPLExec', 'ToolCall'], (e) => (e.stage === 'Exit' ? [{ type: 'AppendEvidence', key: `exit:${e.span}:${e.spanId}`, kind: 'span', body: { outcome: e.outcome ?? null } }] : []));
      const repl = new FakeRepl();
      const llm = new FakeLLM([js(`const f = await readFile('src/a.ts');\nconsole.log(f.path);`), js(`await writeFile('src/b.ts', 'late');\nreturn { summary: 'second turn' };`)]);
      const out = await invoke(goal, opts(llm, { hooks: [rec], ledger, repl }));
      expect(out.kind).toBe('aborted');
      if (out.kind === 'aborted') expect(out.reasons.some((r) => r.code === 'ledger')).toBe(true);
      if (target !== 'Invoke') {
        expect(llm.requests).toHaveLength(1); // no second turn after the failed record
        expect(writes).toBe(0);
      }
      if (target === 'LLMQuery') expect(repl.execs).toHaveLength(0);
    });
  }

  it('a budget settlement failure is terminal (LLM and exec)', async () => {
    for (const span of ['LLMQuery', 'REPLExec'] as const) {
      const ledger = new FakeLedger();
      await ledger.openBudget('run_1', 'calls', 100);
      ledger.settle = async () => {
        throw new Error('settle failed');
      };
      const reserve = hook('budget', [span], (e) => (e.stage === 'Send' ? [{ type: 'ReserveBudget', pool: 'calls', amount: 1 }] : []));
      const repl = new FakeRepl();
      const llm = new FakeLLM([js(`console.log(1)`), js(`return { summary: 'x' };`)]);
      const out = await invoke(goal, opts(llm, { hooks: [reserve], ledger, repl }));
      expect(out, span).toMatchObject({ kind: 'aborted', reasons: expect.arrayContaining([expect.objectContaining({ code: 'ledger' })]) });
      expect(llm.requests, span).toHaveLength(1);
      if (span === 'LLMQuery') expect(repl.execs).toHaveLength(0);
    }
  });

  it('a ledger failure inside a nested invoke is terminal for the parent too', async () => {
    const ledger = new FakeLedger();
    const real = ledger.evidence.bind(ledger);
    ledger.evidence = async (e) => {
      if (e.key.startsWith('exit:LLMQuery:llm:inv_1/')) throw new Error('disk full');
      return real(e);
    };
    const rec = hook('rec', ['LLMQuery'], (e) => (e.stage === 'Exit' ? [{ type: 'AppendEvidence', key: `exit:${e.span}:${e.spanId}`, kind: 'span', body: {} }] : []));
    const parent = js(`try { await invoke({}, { output: {} }); } catch (e) { console.log('child failed', e.message); }\nreturn { summary: 'carried on' };`);
    const out = await invoke(goal, opts(new FakeLLM([parent, js(`return {};`)]), { hooks: [rec], ledger }));
    expect(out).toMatchObject({ kind: 'aborted', reasons: expect.arrayContaining([expect.objectContaining({ code: 'ledger' })]) });
  });

  it('a suspension whose checkpoint cannot be written is aborted, not suspended', async () => {
    const ledger = new FakeLedger();
    ledger.checkpoint = async () => {
      throw new Error('io');
    };
    const out = await invoke(goal, opts(new FakeLLM([js(`await writeFile('src/a.ts', 'x');`)]), { hooks: [approvalGate], ledger }));
    expect(out).toMatchObject({ kind: 'aborted', reasons: [{ code: 'ledger' }] });
  });
});

describe('budget semantics', () => {
  it('Suspend dominates ReserveBudget at the same Send: nothing is reserved for a call that does not run', async () => {
    const ledger = new FakeLedger();
    await ledger.openBudget('run_1', 'calls', 100);
    const trace: TraceEntry[] = [];
    const reserve = hook('budget', ['ToolCall'], (e) => (e.stage === 'Send' ? [{ type: 'ReserveBudget', pool: 'calls', amount: 1 }] : []));
    const out = await invoke(goal, opts(new FakeLLM([js(`await writeFile('src/a.ts', 'x');`)]), { hooks: [reserve, approvalGate], ledger, trace }));
    expect(out.kind).toBe('suspended');
    expect(trace.filter((t) => t.type === 'reserve')).toHaveLength(0);
  });

  it('every physical LLM retry is reserved and settled; an exhausted pool on retry aborts with budget', async () => {
    const ledger = new FakeLedger();
    await ledger.openBudget('run_1', 'calls', 100);
    const trace: TraceEntry[] = [];
    const reserve = hook('budget', ['LLMQuery'], (e) => (e.stage === 'Send' ? [{ type: 'ReserveBudget', pool: 'calls', amount: 1 }] : []));
    const out = await invoke(goal, opts(new FakeLLM([new Error('503'), js(`return { summary: 'ok' };`)]), { hooks: [reserve], ledger, trace }));
    expect(out.kind).toBe('returned');
    expect(trace.filter((t) => t.type === 'reserve')).toHaveLength(2);
    expect(trace.filter((t) => t.type === 'settle')).toHaveLength(2);
    const tight = new FakeLedger();
    await tight.openBudget('run_1', 'calls', 1);
    const llm = new FakeLLM([new Error('503'), js(`return { summary: 'never' };`)]);
    const out2 = await invoke(goal, opts(llm, { hooks: [reserve], ledger: tight }));
    expect(out2).toMatchObject({ kind: 'aborted', reasons: [{ code: 'budget' }] });
    expect(llm.requests).toHaveLength(1);
  });
});

describe('effects are honoured or refused, never ignored', () => {
  it('scope variables reach the program as inputs (explicit inputs win)', async () => {
    const llm = new FakeLLM([js(`return { summary: hint + '/' + goal.statement };`)]);
    const out = await scope({ vars: { hint: { kind: 'value', value: 'from-scope', provenance: { src: 'scope', trust: 'trusted' } }, goal: { kind: 'value', value: { statement: 'shadowed' }, provenance: { src: 'scope', trust: 'trusted' } } } }, () => invoke(goal, opts(llm)));
    expect(out).toMatchObject({ kind: 'returned', value: { summary: 'from-scope/make a = 2' } });
  });

  it('REPLExec Enter PatchInput: code and inputs are applied; anything else aborts', async () => {
    const patch = hook('patch', ['REPLExec'], (e) => (e.stage === 'Enter' ? [{ type: 'PatchInput', path: 'code', value: `return { summary: 'patched ' + extra };` }, { type: 'PatchInput', path: 'inputs.extra', value: 'value' }] : []));
    expect(await invoke(goal, opts(new FakeLLM([js(`return { summary: 'original' };`)]), { hooks: [patch] }))).toMatchObject({ kind: 'returned', value: { summary: 'patched value' } });
    const bad = hook('bad', ['REPLExec'], (e) => (e.stage === 'Enter' ? [{ type: 'PatchInput', path: 'timeoutMs', value: 1 }] : []));
    expect(await invoke(goal, opts(new FakeLLM([js(`return { summary: 'x' };`)]), { hooks: [bad] }))).toMatchObject({ kind: 'aborted', reasons: [{ code: 'conflict' }] });
    const evil = hook('evil', ['REPLExec'], (e) => (e.stage === 'Enter' ? [{ type: 'PatchInput', path: 'code', value: `return eval('1');` }] : []));
    expect(await invoke(goal, opts(new FakeLLM([js(`return { summary: 'x' };`)]), { hooks: [evil] }))).toMatchObject({ kind: 'aborted', reasons: [{ code: 'conflict' }] });
  });

  it('LLMQuery Enter RestrictCapabilities narrows the next exec and the prompt', async () => {
    const restrict = hook('restrict', ['LLMQuery'], (e) => (e.stage === 'Enter' ? [{ type: 'RestrictCapabilities', to: { tools: ['read'] } }] : []));
    const llm = new FakeLLM([js(`return { summary: typeof writeFile + ' ' + __capabilities__.tools.join(',') };`)]);
    const out = await invoke(goal, opts(llm, { hooks: [restrict] }));
    expect(out).toMatchObject({ kind: 'returned', value: { summary: 'undefined read' } });
    expect(llm.requests[0]!.messages[0]!.content).not.toContain('writeFile');
  });
});

describe('secret.canary_*: every boundary', () => {
  it('a value input carrying secret material is refused at Invoke/Enter and never reaches the child or the model', async () => {
    for (const value of [CANARY, { nested: [`x ${SECRET} y`] }, Buffer.from(SECRET).toString('base64')]) {
      const repl = new FakeRepl();
      const llm = new FakeLLM([js(`return { summary: 'x' };`)]);
      const out = await invoke({ ...goal, k: { kind: 'value', value: value as Json, provenance: { src: 'user', trust: 'trusted' } } }, opts(llm, { repl, secrets: [SECRET] }));
      expect(out).toMatchObject({ kind: 'aborted', reasons: [{ code: 'policy' }] });
      expect(repl.execs).toHaveLength(0);
      expect(llm.requests).toHaveLength(0);
      expect(JSON.stringify(out)).not.toContain(SECRET);
      expect(JSON.stringify(out)).not.toContain(CANARY);
    }
  });

  it('hidden bindings never reach the child', async () => {
    const repl = new FakeRepl();
    await invoke({ ...goal, tok: { kind: 'hidden', value: 'hidden-material-123' } }, opts(new FakeLLM([js(`return { summary: String(typeof tok) };`)]), { repl }));
    expect(JSON.stringify(repl.execs.map((e) => e.bindings))).not.toContain('hidden-material-123');
  });

  it('checkpoints, journal, child bindings, replies, history, errors, traces and outcomes carry no secret', async () => {
    await writeFile(join(root, 'src/s.txt'), `token=${SECRET} canary=${CANARY}`);
    const ledger = new FakeLedger();
    const trace: TraceEntry[] = [];
    const repl = new FakeRepl();
    const seenByProgram: string[] = [];
    const turn1 = js(`const f = await readFile('src/s.txt');\ncheckpoint('copy', f.content);\nconsole.log(f.content);\nthrow new Error('failed with ' + f.content);`);
    const turn2 = js(`const f = await readFile('src/s.txt');\nawait writeFile('src/out.ts', 'saw ' + f.content.length);\nreturn { summary: f.content };`);
    const llm = new FakeLLM([turn1, turn2]);
    const spy: Hook = hook('spy', ['ToolCall'], (e) => (e.stage === 'Complete' ? (seenByProgram.push(JSON.stringify(e.output)), []) : []));
    const first = await invoke(goal, opts(llm, { hooks: [approvalGate, spy], ledger, trace, repl, secrets: [SECRET] }));
    expect(first.kind).toBe('suspended');
    if (first.kind !== 'suspended') return;
    const g = await ledger.grantAudited(first.request.requestId, human, 'local', Date.now());
    const repl2 = new FakeRepl();
    const done = await resume(first.resumeToken, g, deps(ledger, { repl: repl2, secrets: [SECRET], trace }));
    expect(done.kind).toBe('returned');
    const surfaces: Record<string, unknown> = {
      checkpoints: [...ledger.checkpoints.values()],
      evidence: [...ledger.ev.values()],
      approvals: [...ledger.approvals.values()],
      childBindings: [...repl.execs, ...repl2.execs].map((e) => e.bindings),
      replies: seenByProgram,
      prompts: llm.requests,
      trace,
      first,
      done,
    };
    for (const [name, v] of Object.entries(surfaces)) {
      const text = JSON.stringify(v);
      expect(text, name).not.toContain(SECRET);
      expect(text, name).not.toContain(CANARY);
    }
    expect(JSON.stringify(done)).toContain('[REDACTED:');
  });

  it('a secret shorter than 8 characters fails closed (it cannot be redacted reliably)', async () => {
    const out = await invoke(goal, opts(new FakeLLM([js(`return { summary: 'x' };`)]), { secrets: ['short'] }));
    expect(out).toMatchObject({ kind: 'failed', error: { name: 'RedactionError' } });
  });
});

describe('inject.history_reference / rpc.widen_caps across invokes', () => {
  it("a child cannot use its parent's handles or history passed as data", async () => {
    const parent = js(`const r = await invoke({ h: 'x' }, { output: { type: 'object' } });\nreturn { summary: JSON.stringify(r.value) };`);
    // The child receives the parent's handle ids only as plain strings; FakeRepl exposes no way to call them.
    // A program that forges a call to a parent handle id through the bridge is refused (broker resolves only its own table).
    const child = js(`return { depth: __depth__, tools: __capabilities__.tools };`);
    const out = await invoke(goal, opts(new FakeLLM([parent, child])));
    expect(out).toMatchObject({ kind: 'returned', value: { summary: '{"depth":1,"tools":["read","edit"]}' } });
    const b = mkBroker();
    const parentBindings = b.beginExec({ execNo: 1, invokeId: 'p', capabilities: caps(), spans: undefined as never, history: undefined as never, checkpoints: new Map() });
    const childBroker = b.child(caps(['read']));
    childBroker.beginExec({ execNo: 2, invokeId: 'p/e1c1', capabilities: caps(['read']), spans: undefined as never, history: undefined as never, checkpoints: new Map() });
    const forged = await childBroker.bridge({ callId: 'f', tool: (parentBindings.__history__ as { id: string }).id, method: 'len', args: [], idemKey: '' });
    expect(forged.error?.name).toBe('E_HANDLE');
  });
});
