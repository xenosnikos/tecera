import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newIntention, sha256, writeActionHash, type CapabilitySet, type JsonObject as JO, type ToolResult, type Effect, type Hook, type Inputs, type JsonObject, type Plan, type SpanEvent, type Tool, type WorkerStepRequest } from '@tecera/contracts';
import { Broker } from '../broker/broker.js';
import { createEditTool } from '../tools/edit.js';
import { createReadTool } from '../tools/read.js';
import { FakeLedger, FakeLLM, FakeRepl, FakeWriteGuard, liveWriteGuard } from './fakes.js';
import type { TraceEntry } from './span.js';
import { invoke, isTainted, resume, type InvokeOptions, type ResumeDeps } from './invoke.js';
import { StepWorker } from './stepWorker.js';

/**
 * Wave 4, lane I4: completed-child replay re-authorizes READS (Codex sprint-3 invoke New finding 4),
 * writes under degraded isolation through the real StepWorker (owner decision D6, 2026-10-05: they proceed
 * without a hold; this replaced the per-write approvals of next step 8), and the durable quarantine lookup
 * (Missing tests: a tainted worktree cannot be reused after a restart).
 */

const caps = (over: Partial<CapabilitySet> = {}): CapabilitySet => ({
  tools: ['read', 'edit'],
  paths: { read: ['**'], write: ['src/**'], protected: ['test/**'] },
  network: 'none',
  limits: { usd: 1, tokens: 100_000, calls: 50, wallMs: 60_000, depth: 3, iterations: 10 },
  ...over,
});
const hook = (id: string, spans: SpanEvent['span'][], fn: (e: SpanEvent) => Effect[] | Promise<Effect[]>): Hook => ({ id, mandatory: false, spans: new Set(spans), handle: fn, describe: () => ({ id, mandatory: false, config: {} }) });
const gatedOnly = hook('approvalGate', ['ToolCall'], (e) => {
  const i = e.input as { tool: string; actionHash: string; path?: string };
  return e.stage === 'Send' && i.tool === 'edit' && i.path === 'src/gated.ts' ? [{ type: 'Suspend', request: { requestId: `ap_${e.spanId}`, action: 'edit', actionHash: i.actionHash, reason: 'gated', requester: 'worker' } }] : [];
});
const js = (body: string): string => `\`\`\`js\n${body}\n\`\`\``;
const SCHEMA: JsonObject = { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } };
const goal: Inputs = { goal: { kind: 'value', value: { statement: 'wave 4' }, provenance: { src: 'goal', trust: 'trusted' } } };
const human = { kind: 'human' as const, id: 'alice' };
const PRIVATE = 'private document';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tecera-wave4-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'src/private.txt'), PRIVATE);
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const mkBroker = (capabilities: CapabilitySet = caps(), tools: Tool[] = [createReadTool(), createEditTool()]) => new Broker({ tools, runId: 'run_4', worktree: root, capabilities, fencingToken: 2, guard: liveWriteGuard() });
const opts = (llm: FakeLLM, extra: Partial<InvokeOptions> = {}): InvokeOptions => ({ output: SCHEMA, hooks: [], llm, repl: new FakeRepl(), broker: mkBroker(), run: { runId: 'run_4', invokeId: 'inv_4', depth: 0 }, ...extra });
const deps = (ledger: FakeLedger, extra: Partial<ResumeDeps> = {}): ResumeDeps => ({ hooks: [gatedOnly], llm: new FakeLLM([]), repl: new FakeRepl(), broker: mkBroker(), ledger, ...extra });

describe('completed read-only child replay re-authorizes its reads (Codex sprint-3 invoke New finding 4)', () => {
  const parent = (narrow: string) => js(`let r; try { r = await invoke({ file: 'src/private.txt' }, { output: { type: 'object' }${narrow} }); } catch (e) { r = { value: 'refused: ' + e.message }; }\nawait writeFile('src/gated.ts', 'gate');\nreturn { summary: JSON.stringify(r.value) };`);
  const child = js(`const f = await readFile(file);\nreturn { content: f.content };`);

  async function suspendedAfterChildRead(llm: FakeLLM, ledger: FakeLedger) {
    const first = await invoke(goal, opts(llm, { hooks: [gatedOnly], ledger }));
    if (first.kind !== 'suspended') throw new Error(`expected suspended, got ${JSON.stringify(first)}`);
    return { first, grant: await ledger.grantAudited(first.request.requestId, human, 'local', Date.now()) };
  }

  it('control: under the same scope the child is replayed (no new model call) and its data returned', async () => {
    const ledger = new FakeLedger();
    const llm = new FakeLLM([parent(`, narrow: { tools: ['read'] }`), child]);
    const { first, grant } = await suspendedAfterChildRead(llm, ledger);
    const done = await resume(first.resumeToken, grant, deps(ledger, { llm }));
    expect(done).toMatchObject({ kind: 'returned', value: { summary: JSON.stringify({ content: PRIVATE }) } });
    expect(llm.requests).toHaveLength(2);
  });

  it('read paths revoked on resume (paths.read: []): the cached data is NOT returned and the child is not re-run (Codex probe)', async () => {
    const ledger = new FakeLedger();
    const llm = new FakeLLM([parent(`, narrow: { tools: ['read'] }`), child]);
    const { first, grant } = await suspendedAfterChildRead(llm, ledger);
    const revoked = caps({ paths: { read: [], write: ['src/**'], protected: ['test/**'] } });
    const done = await resume(first.resumeToken, grant, deps(ledger, { llm, broker: mkBroker(revoked), capabilities: revoked }));
    expect(done).toMatchObject({ kind: 'returned', value: { summary: expect.stringMatching(/refused: .*cannot be replayed.*read allowlist/) } });
    expect(JSON.stringify(done)).not.toContain(PRIVATE);
    expect(llm.requests).toHaveLength(2); // never re-planned
    expect([...ledger.ev.values()].some((e) => e.kind === 'invoke.replay.refused')).toBe(true);
  });

  it('the read tool revoked on resume: the cached data is NOT returned', async () => {
    const ledger = new FakeLedger();
    const llm = new FakeLLM([parent(''), child]); // the child inherits the parent's tools
    const { first, grant } = await suspendedAfterChildRead(llm, ledger);
    const noRead = caps({ tools: ['edit'] });
    const done = await resume(first.resumeToken, grant, deps(ledger, { llm, broker: mkBroker(noRead), capabilities: noRead }));
    expect(done).toMatchObject({ kind: 'returned', value: { summary: expect.stringMatching(/refused: .*tool read is outside the current capabilities/) } });
    expect(JSON.stringify(done)).not.toContain(PRIVATE);
  });

  it('a read tool without authorize() is replayed only while the read scope it ran under is still granted', async () => {
    const lister: Tool = { name: 'lister', methods: ['call'], risk: 'read', schema: {}, call: async (req) => ({ callId: req.callId, ok: true, value: [PRIVATE], provenance: { src: 'tool:lister', trust: 'untrusted' }, truncated: false }) };
    const ledger = new FakeLedger();
    const p = js(`let r; try { r = await invoke({}, { output: { type: 'object' } }); } catch (e) { r = { value: 'refused: ' + e.message }; }\nawait writeFile('src/gated.ts', 'gate');\nreturn { summary: JSON.stringify(r.value) };`);
    const c = js(`return { names: await lister() };`);
    const llm = new FakeLLM([p, c]);
    const wide = caps({ tools: ['read', 'edit', 'lister'], paths: { read: ['src/**', 'docs/**'], write: ['src/**'], protected: [] } });
    const first = await invoke(goal, opts(llm, { hooks: [gatedOnly], ledger, broker: mkBroker(wide, [createReadTool(), createEditTool(), lister]), capabilities: wide }));
    if (first.kind !== 'suspended') throw new Error('expected suspended');
    const grant = await ledger.grantAudited(first.request.requestId, human, 'local', Date.now());
    const narrower = { ...wide, paths: { ...wide.paths, read: ['src/**'] } };
    const done = await resume(first.resumeToken, grant, deps(ledger, { llm, broker: mkBroker(narrower, [createReadTool(), createEditTool(), lister]), capabilities: narrower }));
    expect(done).toMatchObject({ kind: 'returned', value: { summary: expect.stringMatching(/refused: .*docs\/\*\*.*no longer granted/) } });
    expect(JSON.stringify(done)).not.toContain(PRIVATE);
  });
});

// ---------------------------------------------------------------- D6: writes proceed without a hold (degraded isolation)

const plan: Plan = {
  id: 'plan_d',
  trigger: { kind: 'goal.adopted' },
  context: [],
  steps: [{ id: 'edit', kind: 'worker', dependsOn: [], inputs: {}, instruction: 'write', output: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } } }],
  allowedModels: { edit: ['cheap'] },
  permissions: { tools: ['read', 'edit'], write: ['src/**'], approvals: [] },
  budget: {},
  origin: 'generated',
  status: 'candidate',
  goalKinds: [],
};
const intention = newIntention({ id: 'i_d', goalId: 'g', plan, commitment: 'single-minded' });
const STEP = { runId: 'run_d', intentionId: 'i_d', stepId: 'edit' };
const request = (guard: FakeWriteGuard, over: Partial<WorkerStepRequest> = {}): WorkerStepRequest => ({
  runId: 'run_d',
  goal: { id: 'g', statement: 's', check: { command: 'node --test', timeoutSec: 5 }, commitment: 'single-minded', status: 'open', evidence: [] },
  plan,
  intention,
  step: plan.steps[0]!,
  seatId: 'cheap',
  inputs: {},
  capabilities: caps(),
  worktree: root,
  fencingToken: 4,
  guard: guard.guard,
  ...over,
});
const hashOf = (path: string, content: string): string => writeActionHash({ ...STEP, path, contentDigest: sha256(content) });
/** A host tool standing in for a requiresApproval action that is not a write (e.g. externalWrite). */
const notifyTool = (): Tool & { ran: number } => {
  const t = { name: 'notify', methods: ['call'], risk: 'irreversible' as const, schema: {}, ran: 0, call: async (req: { callId: string }): Promise<ToolResult> => (t.ran++, { callId: req.callId, ok: true, value: 'sent', provenance: { src: 'tool:notify', trust: 'untrusted' }, truncated: false }) };
  return t;
};
const notifyGate = hook('approvalGate', ['ToolCall'], (e) => {
  const i = e.input as { tool: string; actionHash: string };
  return e.stage === 'Send' && i.tool === 'notify' ? [{ type: 'Suspend', request: { requestId: `ap_${e.spanId}`, action: 'notify', actionHash: i.actionHash, reason: 'notify requires approval', requester: 'worker' } }] : [];
});

describe('D6: under degraded isolation writes inside paths.write proceed without a hold (fenced, logged; protected paths and tamper still refuse)', () => {
  const mk = (ledger: FakeLedger, llm: FakeLLM, trace?: TraceEntry[]) => new StepWorker({ seats: { cheap: llm }, repl: new FakeRepl(), tools: [createReadTool(), createEditTool()], hooks: [], ledger, sessionId: 'sess', resumeLease: () => ({ worktree: root, fencingToken: 5 }), ...(trace ? { trace } : {}) });

  it('two distinct writes (one in a new directory) complete in ONE run: no suspension, no approval request, each write fenced and authorized with its exact bytes', async () => {
    const ledger = new FakeLedger();
    const trace: TraceEntry[] = [];
    const guard = new FakeWriteGuard();
    const llm = new FakeLLM([js(`await writeFile('src/a.ts', 'A2');\nawait writeFile('src/new/b.ts', 'B2');\nreturn { summary: 'both' };`)]);
    const out = await mk(ledger, llm, trace).run(request(guard));
    expect(out).toMatchObject({ kind: 'returned', value: { summary: 'both' } });
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('A2');
    expect(await readFile(join(root, 'src/new/b.ts'), 'utf8')).toBe('B2');
    expect(ledger.approvals.size).toBe(0);
    expect(ledger.consumed).toEqual([]);
    expect(guard.authorized).toEqual([
      { path: 'src/a.ts', contentDigest: sha256('A2') },
      { path: 'src/new/b.ts', contentDigest: sha256('B2') },
    ]);
    // fenced: check() ran before every mutation of both writes, not once
    expect(guard.checks).toBeGreaterThanOrEqual(10);
    // logged: both edits are completed ToolCall spans; nothing was suspended
    const exits = trace.filter((e) => e.type === 'span' && e.span === 'ToolCall' && e.stage === 'Exit');
    expect(exits.map((e) => (e as { outcome?: string }).outcome)).toEqual(['Completed', 'Completed']);
    expect(trace.some((e) => e.type === 'span' && e.suspended === true)).toBe(false);
    expect(llm.requests).toHaveLength(1);
  });

  it('protected paths and tamper paths still refuse (no hold, nothing written); the step goes on and returns', async () => {
    await mkdir(join(root, 'test'), { recursive: true });
    await mkdir(join(root, '.git'), { recursive: true });
    await writeFile(join(root, '.git/config'), '[core]\n');
    const ledger = new FakeLedger();
    const guard = new FakeWriteGuard();
    const program = js(
      [
        "const out = [];",
        "for (const p of ['test/a.test.ts', '.git/config', 'src/../test/b.test.ts', 'README.md']) {",
        "  try { await writeFile(p, 'pwned'); out.push(p + ':written'); } catch (e) { out.push(p + ':refused'); }",
        "}",
        "await writeFile('src/a.ts', 'ok');",
        "return { summary: out.join(',') };",
      ].join('\n'),
    );
    const out = await mk(ledger, new FakeLLM([program])).run(request(guard, { capabilities: caps({ paths: { read: ['**'], write: ['src/**', 'test/**', '.git/**', 'README.md'], protected: ['test/**'] } }) }));
    expect(out).toMatchObject({ kind: 'returned' });
    const summary = out.kind === 'returned' ? String((out.value as JO).summary) : '';
    expect(summary).toBe('test/a.test.ts:refused,.git/config:refused,src/../test/b.test.ts:refused,README.md:written');
    await expect(readFile(join(root, 'test/a.test.ts'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(root, 'test/b.test.ts'), 'utf8')).rejects.toThrow();
    expect(await readFile(join(root, '.git/config'), 'utf8')).toBe('[core]\n');
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('ok');
    expect(ledger.approvals.size).toBe(0);
  });

  it('a lost fence still refuses the write (no hold, nothing written)', async () => {
    const ledger = new FakeLedger();
    const guard = new FakeWriteGuard();
    guard.revoke('lease taken over');
    const llm = new FakeLLM([js(`let m = ''; try { await writeFile('src/a.ts', 'late'); } catch (e) { m = e.message; }\nreturn { summary: m };`)]);
    const out = await mk(ledger, llm).run(request(guard));
    expect(out.kind).not.toBe('suspended');
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(ledger.approvals.size).toBe(0);
  });

  it('a guard that still answers needs-approval (an older loop) refuses the write instead of suspending: no approval request, nothing written', async () => {
    const ledger = new FakeLedger();
    const guard = new FakeWriteGuard({ answer: (w) => ({ kind: 'needs-approval', actionHash: hashOf(w.path, 'A2') }) });
    const llm = new FakeLLM([js(`let m = ''; try { await writeFile('src/a.ts', 'A2'); } catch (e) { m = e.message; }\nreturn { summary: m };`)]);
    const out = await mk(ledger, llm).run(request(guard));
    expect(out).toMatchObject({ kind: 'returned', value: { summary: expect.stringMatching(/per-write approvals were removed/) } });
    expect(ledger.approvals.size).toBe(0);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  it('a held step whose checkpoint names a write (an older per-write hold) is never resumed and its grant is not consumed', async () => {
    const ledger = new FakeLedger();
    const llm = new FakeLLM([js(`await notify('deploy');\nawait writeFile('src/a.ts', 'A2');\nreturn { summary: 'done' };`)]);
    const capsN = caps({ tools: ['read', 'edit', 'notify'] });
    const broker = new Broker({ tools: [createReadTool(), createEditTool(), notifyTool()], runId: 'run_4', worktree: root, capabilities: capsN, fencingToken: 2, guard: liveWriteGuard() });
    const first = await invoke(goal, opts(llm, { hooks: [notifyGate], ledger, broker, capabilities: capsN }));
    if (first.kind !== 'suspended') throw new Error(`expected suspended, got ${JSON.stringify(first)}`);
    expect(first.request.write).toBeUndefined();
    const cp = ledger.checkpoints.get(first.resumeToken) as { pending: { requests: Array<Record<string, unknown>> } };
    cp.pending.requests[0]!.write = { path: 'src/a.ts', contentDigest: sha256('A2') };
    const grant = await ledger.grantAudited(first.request.requestId, human, 'local', Date.now());
    const out = await resume(first.resumeToken, grant, deps(ledger, { llm, hooks: [notifyGate], broker: new Broker({ tools: [createReadTool(), createEditTool(), notifyTool()], runId: 'run_4', worktree: root, capabilities: capsN, fencingToken: 2, guard: liveWriteGuard() }), capabilities: capsN }));
    expect(out).toMatchObject({ kind: 'aborted', reasons: [{ code: 'policy', reason: expect.stringMatching(/per-write approvals were removed/) }] });
    expect(ledger.consumed).toEqual([]);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  it('a turn-level Suspend that names a write is never recorded: aborted (policy), no checkpoint, no approval request', async () => {
    const ledger = new FakeLedger();
    const legacy = hook('legacyPerWrite', ['LLMQuery'], (e) => (e.stage === 'Send' ? [{ type: 'Suspend', request: { requestId: 'wr_turn', action: 'write src/a.ts', actionHash: hashOf('src/a.ts', 'A2'), reason: 'degraded', requester: 'worker', write: { path: 'src/a.ts', contentDigest: sha256('A2') } } }] : []));
    const out = await invoke(goal, opts(new FakeLLM([js(`return { summary: 'x' };`)]), { hooks: [legacy], ledger }));
    expect(out).toMatchObject({ kind: 'aborted', reasons: [{ code: 'policy', reason: expect.stringMatching(/names a write: per-write approvals were removed/) }] });
    expect(ledger.approvals.size).toBe(0);
    expect(ledger.checkpoints.size).toBe(0);
  });

  it('control: an approval on a non-write requiresApproval action still holds and resumes (the approval machinery is unchanged)', async () => {
    const ledger = new FakeLedger();
    const llm = new FakeLLM([js(`await notify('deploy');\nawait writeFile('src/a.ts', 'A2');\nreturn { summary: 'done' };`)]);
    const capsN = caps({ tools: ['read', 'edit', 'notify'] });
    const t1 = notifyTool();
    const first = await invoke(goal, opts(llm, { hooks: [notifyGate], ledger, broker: mkBroker(capsN, [createReadTool(), createEditTool(), t1]), capabilities: capsN }));
    if (first.kind !== 'suspended') throw new Error('expected suspended');
    expect(t1.ran).toBe(0);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    const grant = await ledger.grantAudited(first.request.requestId, human, 'local', Date.now());
    const t2 = notifyTool();
    const done = await resume(first.resumeToken, grant, deps(ledger, { llm, hooks: [notifyGate], broker: mkBroker(capsN, [createReadTool(), createEditTool(), t2]), capabilities: capsN }));
    expect(done).toMatchObject({ kind: 'returned', value: { summary: 'done' } });
    expect(t2.ran).toBe(1);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('A2');
    expect(ledger.consumed).toEqual([first.request.requestId]);
  });
});

// ---------------------------------------------------------------- durable quarantine

describe('durable quarantine: a worktree quarantined by an earlier process is refused (Missing tests)', () => {
  const mk = (ledger: FakeLedger, llm: FakeLLM) => new StepWorker({ seats: { cheap: llm }, repl: new FakeRepl(), tools: [createReadTool(), createEditTool()], hooks: [], ledger, sessionId: 'sess', resumeLease: () => ({ worktree: root, fencingToken: 5 }) });

  it('exec.tainted evidence for this worktree in the ledger refuses run() before any model call (the in-process registry does not know it)', async () => {
    const ledger = new FakeLedger();
    await ledger.evidence({ key: 'taint:run_d:inv_old:e1:g1', kind: 'exec.tainted', runId: 'run_d', body: { reason: 'orphan writer still running', unresolved: ['slow'], worktree: root, execNo: 1, invokeId: 'inv_old' } });
    const llm = new FakeLLM([js(`return { summary: 'x' };`)]);
    const out = await mk(ledger, llm).run(request(new FakeWriteGuard()));
    expect(isTainted(out)).toBe(true);
    if (out.kind === 'aborted') expect(out.reasons[0]!.reason).toMatch(/earlier exec: orphan writer/);
    expect(llm.requests).toHaveLength(0);
  });

  it('resume() of a held step on a worktree quarantined since the suspension is refused', async () => {
    const ledger = new FakeLedger();
    const llm = new FakeLLM([js(`await notify('deploy');\nawait writeFile('src/a.ts', 'A2');\nreturn { summary: 'done' };`)]);
    const capsN = caps({ tools: ['read', 'edit', 'notify'] });
    const held = new StepWorker({ seats: { cheap: llm }, repl: new FakeRepl(), tools: [createReadTool(), createEditTool(), notifyTool()], hooks: [notifyGate], ledger, sessionId: 'sess', resumeLease: () => ({ worktree: root, fencingToken: 5 }) });
    const planN: Plan = { ...plan, permissions: { ...plan.permissions, tools: ['read', 'edit', 'notify'] } };
    const first = await held.run(request(new FakeWriteGuard(), { capabilities: capsN, plan: planN, intention: newIntention({ id: 'i_d', goalId: 'g', plan: planN, commitment: 'single-minded' }) }));
    if (first.kind !== 'suspended') throw new Error(`expected suspended, got ${JSON.stringify(first)}`);
    await ledger.evidence({ key: 'taint:run_d:x', kind: 'exec.tainted', runId: 'run_d', body: { reason: 'unverifiable commit', unresolved: [], worktree: root, execNo: 1, invokeId: 'x' } });
    const grant = await ledger.grantAudited(first.request.requestId, human, 'sess', Date.now());
    const out = await held.resume(first.resumeToken, grant, undefined, new FakeWriteGuard().guard);
    expect(isTainted(out)).toBe(true);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(ledger.consumed).toEqual([]); // refused before the grant was touched
  });

  it('a ledger that cannot enumerate evidence refuses (fail closed); evidence for another worktree does not', async () => {
    const llm = new FakeLLM([js(`return { summary: 'x' };`)]);
    const blind = new FakeLedger();
    Object.defineProperty(blind, 'listEvidence', { value: undefined });
    const out = await mk(blind, llm).run(request(new FakeWriteGuard()));
    expect(isTainted(out)).toBe(true);
    if (out.kind === 'aborted') expect(out.reasons[0]!.reason).toMatch(/cannot show whether this worktree was quarantined/);
    expect(llm.requests).toHaveLength(0);

    const other = new FakeLedger();
    await other.evidence({ key: 'taint:run_d:y', kind: 'exec.tainted', runId: 'run_d', body: { reason: 'elsewhere', unresolved: [], worktree: join(tmpdir(), 'some-other-worktree'), execNo: 1, invokeId: 'y' } });
    expect((await mk(other, llm).run(request(new FakeWriteGuard()))).kind).toBe('returned');
  });
});
