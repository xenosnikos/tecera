import { renameSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOST_FUNCTIONS, makeRedactor, type CapabilitySet, type Effect, type Hook, type Inputs, type Json, type SpanEvent, type Tool, type ToolBridge, type ToolResult } from '@tecera/contracts';
import { Dispatcher } from '../hooks/dispatcher.js';
import { FakeLedger, liveWriteGuard } from '../invoke/fakes.js';
import { History } from '../invoke/history.js';
import { SpanRunner, type TraceEntry } from '../invoke/span.js';
import { createEditTool } from '../tools/edit.js';
import { createReadTool } from '../tools/read.js';
import { createRunVerifyTool } from '../tools/runVerify.js';
import { worktreeTaint } from '../tools/paths.js';
import { Broker, type ExecSession, type SubInvokeResult } from './broker.js';

/**
 * Quarantine of unresolved writers and redaction at every broker boundary (Codex sprint-2 invoke New
 * findings 2, 3, 4; wave 3 items 4 and 5). Secrets here are ORDINARY registered values that no pattern
 * recognises, so only the configured secret list can catch them.
 */

const SECRET = 'plain-ordinary-password-0042';
const KEY_SECRET = 'plainordinarypassword0042';
const fragments = (s: string): string[] => Array.from({ length: s.length - 7 }, (_, i) => s.slice(i, i + 8));
const noSecret = (v: unknown, label: string): void => {
  const text = JSON.stringify(v);
  for (const f of [...fragments(SECRET), ...fragments(KEY_SECRET)]) expect(text, `${label} leaks ${f}`).not.toContain(f);
};

const caps = (tools = ['read', 'edit', 'slow', 'leaky', 'runVerify']): CapabilitySet => ({
  tools,
  paths: { read: ['**'], write: ['src/**'], protected: ['test/**'] },
  network: 'none',
  limits: { usd: 1, tokens: 1000, calls: 20, wallMs: 1000, depth: 3, iterations: 5 },
});
const hook = (id: string, fn: (e: SpanEvent) => Effect[] | Promise<Effect[]>): Hook => ({ id, mandatory: false, spans: new Set(['ToolCall']), handle: fn, describe: () => ({ id, mandatory: false, config: {} }) });
const deferred = () => {
  let resolve!: () => void;
  const p = new Promise<void>((r) => (resolve = r));
  return { p, resolve };
};
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const call = (bridge: ToolBridge, b: Inputs[string] | undefined, args: Json[], method = 'call'): Promise<ToolResult> => bridge({ callId: 'c', tool: b && b.kind === 'handle' ? b.id : 'nope', method, args, idemKey: '' });

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tecera-quarantine-'));
  await mkdir(join(root, 'src/d'), { recursive: true });
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'src/d/f.ts'), 'f');
});
afterEach(async () => rm(root, { recursive: true, force: true }));

function setup(o: { tools: Tool[]; hooks?: Hook[]; ledger?: FakeLedger; drainMs?: number; secrets?: string[] }) {
  const broker = new Broker({ tools: o.tools, runId: 'run_q', worktree: root, capabilities: caps(), fencingToken: 4, guard: liveWriteGuard(), ...(o.drainMs !== undefined ? { drainMs: o.drainMs } : {}), ...(o.secrets ? { redactor: makeRedactor(o.secrets) } : {}) });
  const trace: TraceEntry[] = [];
  const spans = new SpanRunner({ dispatcher: new Dispatcher(o.hooks ?? []), run: { runId: 'run_q', invokeId: 'inv_q', depth: 0 }, trace, ...(o.ledger ? { ledger: o.ledger } : {}) });
  const session = (execNo: number, extra: Partial<ExecSession> = {}): ExecSession => ({ execNo, invokeId: 'inv_q', capabilities: caps(), spans, history: new History(), checkpoints: new Map(), ...extra });
  return { broker, trace, session };
}

/** A writer that ignores cancellation: after `release` it mutates the worktree directly. */
function stubbornWriter(release: Promise<void>, started: () => void): Tool {
  return {
    name: 'slow',
    methods: ['call'],
    risk: 'write',
    schema: {},
    call: async (req) => {
      started();
      await release;
      await writeFile(join(root, 'src/late.ts'), 'mutated after the drain timeout');
      return { callId: req.callId, ok: true, value: { wrote: 'src/late.ts' }, provenance: { src: 'tool:slow', trust: 'untrusted' }, truncated: false };
    },
  };
}

describe('quarantine: an unresolved writer at drain timeout (wave 3 item 5)', () => {
  it('taints the exec, the tree and the worktree; the later mutation is discarded with evidence and never journalled; nothing reuses the worktree', async () => {
    const release = deferred();
    const started = deferred();
    const ledger = new FakeLedger();
    const { broker, trace, session } = setup({ tools: [createReadTool(), createEditTool(), stubbornWriter(release.p, started.resolve)], ledger, drainMs: 30 });
    const b = broker.beginExec(session(1));
    const pending = call(broker.bridge, b.slow, []);
    await started.p;
    const rep = await broker.endExec();

    // endExec returned while the writer is still active: that is a quarantine, never a completed cleanup
    expect(rep.tainted).toMatchObject({ reason: expect.stringMatching(/unresolved writer/), unresolved: ['slow'], worktree: root });
    expect(rep.fatal).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'cancelled', hookId: 'quarantine', reason: expect.stringMatching(/^tainted: /) })]));
    expect([...ledger.ev.values()].some((e) => e.kind === 'exec.tainted')).toBe(true);
    expect(worktreeTaint(root)).toMatch(/unresolved writer/);
    expect(broker.tainted).not.toBeNull();
    expect(() => broker.beginExec(session(2))).toThrow(/quarantined/);
    expect(() => broker.child(caps()).beginExec(session(3))).toThrow(/quarantined/);

    // the writer finishes later: it happened, but it is discarded (not journalled) with evidence
    release.resolve();
    expect((await pending).ok).toBe(false);
    await tick(20);
    expect(await readFile(join(root, 'src/late.ts'), 'utf8')).toBe('mutated after the drain timeout');
    expect(broker.exportJournal()).toHaveLength(0);
    expect(trace.some((t) => t.type === 'evidence' && t.kind === 'tool.late' && (t.body as { tainted?: boolean; discarded?: boolean }).tainted === true && (t.body as { discarded?: boolean }).discarded === true)).toBe(true);

    // worktree reuse is refused by every file and verify tool, from any broker in this process
    const ctx = { runId: 'other', worktree: root, capabilities: caps(), fencingToken: 99 };
    expect((await createEditTool().call({ callId: 'x', tool: 'edit', method: 'call', args: ['src/a.ts', 'reuse'], idemKey: '' }, ctx)).error?.message).toMatch(/quarantined/);
    let verified = false;
    const verify = createRunVerifyTool({ runner: { run: async () => ((verified = true), { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', durationMs: 1, truncated: false }) }, command: 'node --test', timeoutSec: 5 });
    expect((await verify.call({ callId: 'v', tool: 'runVerify', method: 'call', args: [], idemKey: '' }, ctx)).ok).toBe(false);
    expect(verified).toBe(false);
    expect(() => new Broker({ tools: [createReadTool()], runId: 'r2', worktree: root, capabilities: caps(), fencingToken: 1 }).beginExec(session(1))).toThrow(/quarantined/);
  });

  it('a commit that fails its post-commit verification (TaintError) quarantines the exec too', async () => {
    const edit = createEditTool({ beforeCommit: () => renameSync(join(root, 'src/d'), join(root, 'test/d')) });
    const { broker, session } = setup({ tools: [createReadTool(), edit] });
    const b = broker.beginExec(session(1));
    const r = await call(broker.bridge, b.writeFile, ['src/d/f.ts', 'x']);
    expect(r.ok).toBe(false);
    const rep = await broker.endExec();
    expect(rep.tainted?.reason).toMatch(/post-commit verification failed/);
    expect(rep.fatal?.some((f) => f.hookId === 'quarantine')).toBe(true);
    expect(broker.exportJournal()).toHaveLength(0);
  });
});

describe('late nested ledger failure (Codex New finding 3)', () => {
  it('a nested ledger abort that arrives after the exec stopped is fatal, not an ordinary late completion', async () => {
    const childDone = deferred();
    const { broker, trace, session } = setup({ tools: [createReadTool(), createEditTool()] });
    const subInvoke = async (): Promise<SubInvokeResult> => {
      await childDone.p;
      return { kind: 'aborted', reasons: [{ code: 'ledger', reason: 'evidence exit:LLMQuery not written: disk full', hookId: 'ledger' }], run: { runId: 'run_q', invokeId: 'inv_q/e1c1', depth: 1 } };
    };
    broker.beginExec(session(1, { subInvoke }));
    const nested = broker.bridge({ callId: 'n', tool: HOST_FUNCTIONS.invoke, method: 'invoke', args: [{}, { output: {} }], idemKey: '' });
    await tick();
    const ending = broker.endExec();
    await tick();
    childDone.resolve();
    const rep = await ending;
    expect((await nested).ok).toBe(false);
    expect(rep.fatal).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ledger', reason: expect.stringMatching(/^nested invoke: /) })]));
    expect(trace.some((t) => t.type === 'evidence' && t.kind === 'invoke.late')).toBe(true);
  });

  it('with a sibling suspension recorded first, the report carries the ledger fatal (the invoke then aborts instead of suspending)', async () => {
    const childDone = deferred();
    const gate = hook('approvalGate', (e) => (e.stage === 'Send' && (e.input as { tool: string }).tool === 'edit' ? [{ type: 'Suspend', request: { requestId: 'apQ2', action: 'edit', actionHash: (e.input as { actionHash: string }).actionHash, reason: 'gated', requester: 'w' } }] : []));
    const { broker, session } = setup({ tools: [createReadTool(), createEditTool()], hooks: [gate] });
    const subInvoke = async (): Promise<SubInvokeResult> => {
      await childDone.p;
      return { kind: 'aborted', reasons: [{ code: 'ledger', reason: 'settlement failed', hookId: 'ledger' }], run: { runId: 'run_q', invokeId: 'inv_q/e1c1', depth: 1 } };
    };
    const b = broker.beginExec(session(1, { subInvoke }));
    const nested = broker.bridge({ callId: 'n', tool: HOST_FUNCTIONS.invoke, method: 'invoke', args: [{}, { output: {} }], idemKey: '' });
    await tick();
    expect((await call(broker.bridge, b.writeFile, ['src/a.ts', 'gated'])).error?.name).toBe('E_SUSPENDED');
    const ending = broker.endExec();
    await tick();
    childDone.resolve();
    const rep = await ending;
    await nested;
    expect(rep.suspension?.requests.map((r) => r.requestId)).toEqual(['apQ2']);
    expect(rep.fatal).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ledger' })]));
  });
});

describe('redaction with an ordinary registered secret at every broker boundary (wave 3 item 4)', () => {
  const leaky = (over: Partial<ToolResult>): Tool => ({
    name: 'leaky',
    methods: ['call'],
    risk: 'read',
    schema: {},
    call: async (req) => ({ callId: req.callId, ok: true, value: null, provenance: { src: 'tool:leaky', trust: 'untrusted' }, truncated: false, ...over }),
  });

  it('a redactor adopted after construction (invoke secrets) covers results of this broker and of child brokers', async () => {
    const { broker, session } = setup({ tools: [leaky({ value: { content: `token=${SECRET}`, [SECRET]: 1 } })] });
    broker.adoptRedactor(makeRedactor([SECRET]));
    const b = broker.beginExec(session(1));
    const r = await call(broker.bridge, b.leaky, []);
    noSecret(r, 'result');
    expect(JSON.stringify(r)).toContain('[REDACTED:secret:');
    await broker.endExec();
    const child = broker.child(caps());
    const cb = child.beginExec(session(2, { invokeId: 'inv_q/e1c1' }));
    noSecret(await call(child.bridge, cb.leaky, []), 'child result');
    await child.endExec();
  });

  it('error names and messages, provenance paths and broker faults are redacted', async () => {
    const { broker, session } = setup({ tools: [leaky({ ok: false, error: { name: SECRET, message: `failed for ${SECRET}` }, provenance: { src: 'tool:leaky', trust: 'trusted', path: `src/${SECRET}.ts` } })], secrets: [SECRET] });
    const b = broker.beginExec(session(1));
    const r = await call(broker.bridge, b.leaky, []);
    noSecret(r, 'error result');
    expect(r.provenance.trust).toBe('untrusted');
    await broker.endExec();
    const throwing: Tool = { name: 'leaky', methods: ['call'], risk: 'read', schema: {}, call: async () => Promise.reject(Object.assign(new Error(`boom ${SECRET}`), { name: SECRET })) };
    const t = setup({ tools: [throwing], secrets: [SECRET] });
    const tb = t.broker.beginExec(t.session(1));
    noSecret(await call(t.broker.bridge, tb.leaky, []), 'thrown error');
    await t.broker.endExec();
  });

  it('checkpoint keys carrying a secret are refused; checkpoint values are stored redacted', async () => {
    const { broker, trace, session } = setup({ tools: [createReadTool()], secrets: [SECRET, KEY_SECRET] });
    const s = session(1);
    broker.beginExec(s);
    const k = await broker.bridge({ callId: 'k', tool: HOST_FUNCTIONS.checkpoint, method: 'call', args: [KEY_SECRET, 1], idemKey: '' });
    expect(k.ok).toBe(false);
    noSecret(k, 'refusal');
    const v = await broker.bridge({ callId: 'v', tool: HOST_FUNCTIONS.checkpoint, method: 'call', args: ['note', { text: SECRET }], idemKey: '' });
    expect(v.ok).toBe(true);
    await broker.endExec();
    expect([...s.checkpoints.keys()]).toEqual(['note']);
    noSecret(Object.fromEntries(s.checkpoints), 'checkpoints');
    noSecret(trace, 'trace');
  });

  it('history entries cut at the slice bound and search snippets never expose a secret fragment', async () => {
    const red = makeRedactor([SECRET]);
    const h = new History([], red);
    h.push({ turn: 1, code: `const k = '${SECRET}';`, output: `${'a'.repeat(50_000 - 10)}${SECRET}${'b'.repeat(100)}`, result: 'continue' });
    const { broker, session } = setup({ tools: [createReadTool()], secrets: [SECRET] });
    const b = broker.beginExec(session(1, { history: h }));
    noSecret(await call(broker.bridge, b.__history__, [0, 1], 'slice'), 'slice');
    noSecret(await call(broker.bridge, b.__history__, ['aaaa'], 'search'), 'search');
    noSecret(await call(broker.bridge, b.__history__, ['const k'], 'search'), 'code search');
    await broker.endExec();
    noSecret(h.all(), 'stored history');
  });

  it('tools receive the tree redactor and the exec signal in their context', async () => {
    let seen: { redactor?: unknown; signal?: AbortSignal } = {};
    const probe: Tool = { name: 'leaky', methods: ['call'], risk: 'read', schema: {}, call: async (req, ctx) => ((seen = ctx as typeof seen), { callId: req.callId, ok: true, value: 1, provenance: { src: 'x', trust: 'untrusted' }, truncated: false }) };
    const { broker, session } = setup({ tools: [probe], secrets: [SECRET] });
    const b = broker.beginExec(session(1));
    await call(broker.bridge, b.leaky, []);
    expect((seen.redactor as { redactText(s: string): string }).redactText(SECRET)).toMatch(/^\[REDACTED:secret:/);
    expect(seen.signal?.aborted).toBe(false);
    await broker.endExec();
    expect(seen.signal?.aborted).toBe(true);
  });
});
