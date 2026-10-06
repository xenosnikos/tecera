import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newIntention, type CapabilitySet, type Effect, type Hook, type Inputs, type JsonObject, type Plan, type SpanEvent, type Tool, type WorkerStepRequest } from '@tecera/contracts';
import { Broker } from '../broker/broker.js';
import { createEditTool } from '../tools/edit.js';
import { worktreeTaint } from '../tools/paths.js';
import { createReadTool } from '../tools/read.js';
import { FakeLedger, FakeLLM, FakeRepl, liveWriteGuard } from './fakes.js';
import { invoke, isTainted, resume, type InvokeOptions, type ResumeDeps } from './invoke.js';
import type { TraceEntry } from './span.js';
import { StepWorker } from './stepWorker.js';

/**
 * Wave 3 (Codex sprint-2 invoke lane): completed children across a parent resume (item 13), quarantine of
 * unresolved writers (item 5), late nested ledger failures, ordinary-secret redaction (item 4), and grant
 * consumption followed by a checkpoint failure under the production audit rule.
 */

const SECRET = 'plain-ordinary-password-0042';
const KEY_SECRET = 'plainordinarypassword0042';
const fragments = (s: string): string[] => Array.from({ length: s.length - 7 }, (_, i) => s.slice(i, i + 8));
const noSecret = (v: unknown, label: string): void => {
  const text = JSON.stringify(v);
  for (const f of [...fragments(SECRET), ...fragments(KEY_SECRET)]) expect(text, `${label} leaks ${f}`).not.toContain(f);
};

const caps = (over: Partial<CapabilitySet> = {}): CapabilitySet => ({
  tools: ['read', 'edit', 'slow', 'leaky'],
  paths: { read: ['**'], write: ['src/**'], protected: ['test/**'] },
  network: 'none',
  limits: { usd: 1, tokens: 100_000, calls: 50, wallMs: 60_000, depth: 3, iterations: 10 },
  ...over,
});
const hook = (id: string, spans: SpanEvent['span'][], fn: (e: SpanEvent) => Effect[] | Promise<Effect[]>): Hook => ({ id, mandatory: false, spans: new Set(spans), handle: fn, describe: () => ({ id, mandatory: false, config: {} }) });
/** Approval required only for writes to src/gated.ts. */
const gatedOnly = hook('approvalGate', ['ToolCall'], (e) => {
  const i = e.input as { tool: string; actionHash: string; path?: string };
  return e.stage === 'Send' && i.tool === 'edit' && i.path === 'src/gated.ts' ? [{ type: 'Suspend', request: { requestId: `ap_${e.spanId}`, action: 'edit', actionHash: i.actionHash, reason: 'gated', requester: 'worker' } }] : [];
});
const allEdits = hook('approvalGate', ['ToolCall'], (e) => {
  const i = e.input as { tool: string; actionHash: string };
  return e.stage === 'Send' && i.tool === 'edit' ? [{ type: 'Suspend', request: { requestId: `ap_${e.spanId}`, action: 'edit', actionHash: i.actionHash, reason: 'edit requires approval', requester: 'worker' } }] : [];
});
const js = (body: string): string => `\`\`\`js\n${body}\n\`\`\``;
const SCHEMA: JsonObject = { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } };
const goal: Inputs = { goal: { kind: 'value', value: { statement: 'wave 3' }, provenance: { src: 'goal', trust: 'trusted' } } };
const human = { kind: 'human' as const, id: 'alice' };

let root: string;
let effects: string[] = [];
const countingEdit = (): Tool => {
  const inner = createEditTool();
  return Object.assign({ ...inner }, { call: async (r: Parameters<Tool['call']>[0], c: Parameters<Tool['call']>[1], g?: Parameters<Tool['call']>[2]) => (effects.push(String((r.args[0] as string) ?? '')), inner.call(r, c, g)) });
};
beforeEach(async () => {
  effects = [];
  root = await mkdtemp(join(tmpdir(), 'tecera-wave3-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const mkBroker = (tools: Tool[] = [createReadTool(), countingEdit()], o: { drainMs?: number; capabilities?: CapabilitySet } = {}) => new Broker({ tools, runId: 'run_w', worktree: root, capabilities: o.capabilities ?? caps(), fencingToken: 2, guard: liveWriteGuard(), ...(o.drainMs !== undefined ? { drainMs: o.drainMs } : {}) });
const opts = (llm: FakeLLM, extra: Partial<InvokeOptions> = {}): InvokeOptions => ({ output: SCHEMA, hooks: [], llm, repl: new FakeRepl(), broker: mkBroker(), run: { runId: 'run_w', invokeId: 'inv_w', depth: 0 }, ...extra });
const deps = (ledger: FakeLedger, extra: Partial<ResumeDeps> = {}): ResumeDeps => ({ hooks: [gatedOnly], llm: new FakeLLM([]), repl: new FakeRepl(), broker: mkBroker(), ledger, ...extra });

describe('completed child → parent suspension → resume: exactly-once child effects (Codex New finding 6, wave 3 item 13)', () => {
  const parent = js(`const r = await invoke({ file: 'src/c.ts' }, { output: { type: 'object' }, narrow: { tools: ['read', 'edit'] } });\nawait writeFile('src/gated.ts', 'gate');\nreturn { summary: JSON.stringify(r.value) };`);
  const child = js(`await writeFile(file, 'child');\nreturn { wrote: file };`);

  it('the completed child is replayed from the parent checkpoint: no new model call, no second write (Codex probe)', async () => {
    const ledger = new FakeLedger();
    const llm = new FakeLLM([parent, child]);
    const trace: TraceEntry[] = [];
    const first = await invoke(goal, opts(llm, { hooks: [gatedOnly], ledger, trace }));
    if (first.kind !== 'suspended') throw new Error(`expected suspended, got ${JSON.stringify(first)}`);
    expect(effects).toEqual(['src/c.ts']); // the gated write suspended before it ran
    const g = await ledger.grantAudited(first.request.requestId, human, 'local', Date.now());
    const done = await resume(first.resumeToken, g, deps(ledger, { llm, trace }));
    expect(done).toMatchObject({ kind: 'returned', value: { summary: '{"wrote":"src/c.ts"}' } });
    expect(effects).toEqual(['src/c.ts', 'src/gated.ts']); // the child wrote ONCE
    expect(llm.requests).toHaveLength(2); // parent turn 1 + child turn 1; nothing re-planned
    expect(await readFile(join(root, 'src/c.ts'), 'utf8')).toBe('child');
    expect(await readFile(join(root, 'src/gated.ts'), 'utf8')).toBe('gate');
    expect([...ledger.ev.values()].some((e) => e.kind === 'invoke.replayed')).toBe(true);
  });

  it('under a narrower scope on resume the completed child is NOT replayed and NOT re-run: the call is refused', async () => {
    const ledger = new FakeLedger();
    const tolerant = js(`let r; try { r = await invoke({ file: 'src/c.ts' }, { output: { type: 'object' }, narrow: { tools: ['read', 'edit'] } }); } catch (e) { r = { value: 'refused: ' + e.message }; }\nawait writeFile('src/gated.ts', 'gate');\nreturn { summary: JSON.stringify(r.value) };`);
    const llm = new FakeLLM([tolerant, child]);
    const first = await invoke(goal, opts(llm, { hooks: [gatedOnly], ledger }));
    if (first.kind !== 'suspended') throw new Error(`expected suspended, got ${first.kind}`);
    const g = await ledger.grantAudited(first.request.requestId, human, 'local', Date.now());
    const narrower = caps({ paths: { read: ['**'], write: ['src/gated.ts'], protected: ['test/**'] } });
    const done = await resume(first.resumeToken, g, deps(ledger, { llm, broker: mkBroker(undefined, { capabilities: narrower }), capabilities: narrower }));
    expect(done).toMatchObject({ kind: 'returned', value: { summary: expect.stringMatching(/cannot be replayed.*write allowlist.*not run again/) } });
    expect(effects.filter((p) => p === 'src/c.ts')).toHaveLength(1);
    expect(llm.requests).toHaveLength(2);
    expect([...ledger.ev.values()].some((e) => e.kind === 'invoke.replay.refused')).toBe(true);
  });
});

describe('late nested ledger failure (Codex New finding 3) and Exit failure after `failed`', () => {
  it('a nested invoke whose LLM Exit record fails, alongside a gated sibling that suspends, aborts the parent with ledger (Codex probe)', async () => {
    const ledger = new FakeLedger();
    const real = ledger.evidence.bind(ledger);
    ledger.evidence = async (e) => {
      if (e.key.startsWith('exit:LLMQuery:llm:inv_w/')) throw new Error('disk full');
      return real(e);
    };
    const rec = hook('rec', ['LLMQuery'], (e) => (e.stage === 'Exit' ? [{ type: 'AppendEvidence', key: `exit:${e.span}:${e.spanId}`, kind: 'span', body: {} }] : []));
    const parent = js(`await Promise.all([invoke({}, { output: {} }).catch(() => null), writeFile('src/gated.ts', 'x')]);\nreturn { summary: 'never' };`);
    const slowChild = async (): Promise<string> => (await new Promise((r) => setTimeout(r, 40)), js(`return {};`));
    const out = await invoke(goal, opts(new FakeLLM([parent, slowChild]), { hooks: [rec, gatedOnly], ledger }));
    expect(out.kind).toBe('aborted');
    if (out.kind === 'aborted') expect(out.reasons.some((r) => r.code === 'ledger')).toBe(true);
    expect(effects).not.toContain('src/gated.ts');
  });

  it('a `failed` invoke whose final record cannot be written is reported aborted (ledger), not failed', async () => {
    const ledger = new FakeLedger();
    const real = ledger.evidence.bind(ledger);
    ledger.evidence = async (e) => {
      if (e.key.startsWith('exit:Invoke:')) throw new Error('disk full');
      return real(e);
    };
    const rec = hook('rec', ['Invoke'], (e) => (e.stage === 'Exit' ? [{ type: 'AppendEvidence', key: `exit:${e.span}:${e.spanId}`, kind: 'span', body: { outcome: e.outcome ?? null } }] : []));
    const out = await invoke(goal, opts(new FakeLLM([new Error('503')]), { hooks: [rec], ledger, llmRetries: 0 }));
    expect(out).toMatchObject({ kind: 'aborted', reasons: expect.arrayContaining([expect.objectContaining({ code: 'ledger' })]) });
  });
});

describe('quarantine through invoke and StepWorker (wave 3 item 5)', () => {
  it('a writer still running at drain timeout makes the outcome aborted+tainted: no suspension checkpoint, no approval request, no reuse', async () => {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const slow: Tool = {
      name: 'slow',
      methods: ['call'],
      risk: 'write',
      schema: {},
      call: async (req) => {
        await released;
        await writeFile(join(root, 'src/late.ts'), 'late');
        return { callId: req.callId, ok: true, value: 1, provenance: { src: 'tool:slow', trust: 'untrusted' }, truncated: false };
      },
    };
    const ledger = new FakeLedger();
    const trace: TraceEntry[] = [];
    const program = js(`slow().catch(() => null);\nawait writeFile('src/gated.ts', 'x');\nreturn { summary: 'never' };`);
    const out = await invoke(goal, opts(new FakeLLM([program]), { hooks: [gatedOnly], ledger, trace, broker: mkBroker([createReadTool(), countingEdit(), slow], { drainMs: 30 }) }));
    expect(out.kind).toBe('aborted');
    expect(isTainted(out)).toBe(true);
    if (out.kind === 'aborted') expect(out.reasons[0]).toMatchObject({ code: 'cancelled', hookId: 'quarantine', reason: expect.stringMatching(/^tainted: /) });
    expect(ledger.checkpoints.size).toBe(0); // the suspension was NOT checkpointed
    expect(ledger.approvals.size).toBe(0);
    expect([...ledger.ev.values()].some((e) => e.kind === 'exec.tainted')).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(trace.some((t) => t.type === 'evidence' && t.kind === 'tool.late' && (t.body as { discarded?: boolean }).discarded === true)).toBe(true);
    expect(worktreeTaint(root)).not.toBeNull();

    // a later step on the same worktree is refused before any model call
    const llm = new FakeLLM([js(`return { summary: 'x', facts: [] };`)]);
    const plan: Plan = { id: 'p', trigger: { kind: 'goal.adopted' }, context: [], steps: [{ id: 's', kind: 'worker', dependsOn: [], inputs: {}, instruction: 'x' }], allowedModels: { s: ['cheap'] }, permissions: { tools: ['read', 'edit'], write: ['src/**'], approvals: [] }, budget: {}, origin: 'generated', status: 'candidate', goalKinds: [] };
    const req: WorkerStepRequest = { runId: 'run_w2', goal: { id: 'g', statement: 's', check: { command: 'node --test', timeoutSec: 5 }, commitment: 'single-minded', status: 'open', evidence: [] }, plan, intention: newIntention({ id: 'i', goalId: 'g', plan, commitment: 'single-minded' }), step: plan.steps[0]!, seatId: 'cheap', inputs: {}, capabilities: caps(), worktree: root, fencingToken: 3, guard: liveWriteGuard() };
    const again = await new StepWorker({ seats: { cheap: llm }, repl: new FakeRepl(), tools: [createReadTool(), createEditTool()], hooks: [] }).run(req);
    expect(isTainted(again)).toBe(true);
    expect(llm.requests).toHaveLength(0);
  });
});

describe('ordinary registered secrets at the invoke boundaries (Codex New finding 4/5, wave 3 item 4)', () => {
  it('InvokeOptions.secrets configures the supplied broker: a tool result reaches the child redacted (Codex probe)', async () => {
    await writeFile(join(root, 'src/s.txt'), `token=${SECRET}`);
    const repl = new FakeRepl();
    const seen: string[] = [];
    const spy = hook('spy', ['ToolCall'], (e) => (e.stage === 'Complete' ? (seen.push(JSON.stringify(e.output)), []) : []));
    const llm = new FakeLLM([js(`const f = await readFile('src/s.txt');\nreturn { summary: f.content };`)]);
    const out = await invoke(goal, opts(llm, { repl, secrets: [SECRET], hooks: [spy] }));
    expect(out.kind).toBe('returned');
    noSecret(out, 'outcome');
    noSecret(seen, 'tool output seen by hooks/program');
  });

  it('error names, value-binding provenance, checkpoint keys/values, parse-failure history cuts and abort reasons are redacted', async () => {
    const leaky: Tool = { name: 'leaky', methods: ['call'], risk: 'read', schema: {}, call: async (req) => ({ callId: req.callId, ok: false, error: { name: SECRET, message: `nope ${SECRET}` }, provenance: { src: 'tool:leaky', trust: 'untrusted' }, truncated: false }) };
    const repl = new FakeRepl();
    const ledger = new FakeLedger();
    const trace: TraceEntry[] = [];
    const nearCut = `${'z'.repeat(2000 - 12)}${SECRET} and no code block`; // the secret straddles the 2000-char cut
    const llm = new FakeLLM([
      nearCut,
      js(`let n; try { await leaky(); } catch (e) { n = e.name + ' ' + e.message; }\nlet k; try { await checkpoint('${KEY_SECRET}', 1); k = 'stored'; } catch (e) { k = 'refused'; }\nawait checkpoint('note', 'v=${SECRET}');\nconsole.log(n, k);`),
      js(`return { summary: JSON.stringify(checkpoints) + ' ' + src };`),
    ]);
    const blocker = hook('blocker', ['Invoke'], (e) => (e.stage === 'Complete' ? [{ type: 'Abort', code: 'policy', reason: `refusing ${SECRET}` }] : []));
    const inputs: Inputs = { ...goal, src: { kind: 'value', value: 'from user', provenance: { src: `user:${SECRET}`, trust: 'untrusted' } } };
    const out = await invoke(inputs, opts(llm, { repl, ledger, trace, secrets: [SECRET, KEY_SECRET], hooks: [blocker], broker: mkBroker([createReadTool(), countingEdit(), leaky]) }));
    expect(out.kind).toBe('aborted');
    noSecret(out, 'outcome');
    noSecret(repl.execs.map((e) => e.bindings), 'child bindings (provenance)');
    noSecret(llm.requests, 'prompts (history after the parse-failure cut)');
    noSecret(trace, 'trace');
    noSecret([...ledger.ev.values()], 'evidence');
    expect(JSON.stringify(llm.requests[2])).toContain('refused'); // the secret checkpoint key was refused
  });
});

describe('grant consumption followed by a checkpoint failure (production audit semantics)', () => {
  const twoEdits = js(`await Promise.all([writeFile('src/x.ts', 'X'), writeFile('src/y.ts', 'Y')]);\nreturn { summary: 'both' };`);

  it('the consumed grant cannot be re-presented after the partial-approval checkpoint failed; nothing was written', async () => {
    const ledger = new FakeLedger();
    const first = await invoke(goal, opts(new FakeLLM([twoEdits]), { hooks: [allEdits], ledger }));
    if (first.kind !== 'suspended') throw new Error(`expected suspended, got ${first.kind}`);
    const g1 = await ledger.grantAudited(first.request.requestId, human, 'local', Date.now());
    const realCheckpoint = ledger.checkpoint.bind(ledger);
    ledger.checkpoint = async (runId, key, state) => {
      if (key.includes(':granted:')) throw new Error('io error');
      return realCheckpoint(runId, key, state);
    };
    const r1 = await resume(first.resumeToken, g1, deps(ledger, { hooks: [allEdits] }));
    expect(r1).toMatchObject({ kind: 'aborted', reasons: [{ code: 'ledger', reason: expect.stringMatching(/partial approval not recorded/) }] });
    expect(ledger.approvals.get(first.request.requestId)?.state).toBe('consumed');
    ledger.checkpoint = realCheckpoint;
    // replaying the original token with the consumed grant is refused (fail closed: a new approval cycle is needed)
    const r2 = await resume(first.resumeToken, g1, deps(ledger, { hooks: [allEdits] }));
    expect(r2).toMatchObject({ kind: 'aborted', reasons: [{ reason: expect.stringMatching(/consumed/) }] });
    expect(effects).toEqual([]);
  });

  it('an unaudited grant (approve without its approval.granted event) cannot be consumed: resume refuses and writes nothing', async () => {
    const ledger = new FakeLedger();
    const first = await invoke(goal, opts(new FakeLLM([js(`await writeFile('src/x.ts', 'X');\nreturn { summary: 'x' };`)]), { hooks: [allEdits], ledger }));
    if (first.kind !== 'suspended') throw new Error(`expected suspended, got ${first.kind}`);
    const g = await ledger.approve(first.request.requestId, human, 'local', Date.now());
    const r = await resume(first.resumeToken, g, deps(ledger, { hooks: [allEdits] }));
    expect(r).toMatchObject({ kind: 'aborted', reasons: [{ reason: expect.stringMatching(/unaudited/) }] });
    expect(ledger.approvals.get(first.request.requestId)?.state).toBe('granted');
    expect(effects).toEqual([]);
  });
});
