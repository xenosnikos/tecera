import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newIntention, type CapabilityMockedPayload, type CapabilityRecord, type CapabilitySet, type Effect, type Hook, type Inputs, type JsonObject, type MockToolDeclaration, type Plan, type SpanEvent, type TeceraEvent, type Tool, type ToolResult, type WorkerStepRequest } from '@tecera/contracts';
import { Broker } from '../broker/broker.js';
import { standInFor, type StandInTool } from '../mocks/standins.js';
import { createEditTool } from '../tools/edit.js';
import { createReadTool } from '../tools/read.js';
import { FakeLedger, FakeLLM, FakeRepl, liveWriteGuard } from './fakes.js';
import { invoke } from './invoke.js';
import { simulationOf, StepWorker } from './stepWorker.js';

/**
 * Wave 6, worker lane: the write-boundary regression at the invoke level (sprint 5 worker finding 1: a
 * write-risk tool's suspension without `write` metadata must create no checkpoint and no approval) and
 * stand-ins end to end through the StepWorker (admission against the inventory, capability.mocked, the
 * outcome marked simulated, resume served by the same stand-in).
 */

const js = (body: string): string => `\`\`\`js\n${body}\n\`\`\``;
const hook = (id: string, fn: (e: SpanEvent) => Effect[]): Hook => ({ id, mandatory: false, spans: new Set(['ToolCall']), handle: fn, describe: () => ({ id, mandatory: false, config: {} }) });
const caps = (tools: string[]): CapabilitySet => ({ tools, paths: { read: ['**'], write: ['src/**'], protected: ['test/**'] }, network: 'none', limits: { usd: 1, tokens: 100_000, calls: 50, wallMs: 60_000, depth: 3, iterations: 8 } });
const human = { kind: 'human' as const, id: 'alice' };

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tecera-wave6-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
});
afterEach(async () => rm(root, { recursive: true, force: true }));

describe('D6 at the invoke level: a write-risk tool held without write metadata creates no checkpoint and no approval', () => {
  it('the hook suspension on edit (correct actionHash, no SuspendRequest.write) is refused; the step returns; no approval, no checkpoint, nothing written', async () => {
    const gate = hook('approvalGate', (e) => {
      const i = e.input as { tool: string; actionHash: string };
      return e.stage === 'Send' && i.tool === 'edit' ? [{ type: 'Suspend', request: { requestId: `ap_${e.spanId}`, action: 'edit', actionHash: i.actionHash, reason: 'edit requires approval', requester: 'worker' } }] : [];
    });
    const ledger = new FakeLedger();
    const program = js(`let why = 'written';\ntry { await writeFile('src/a.ts', 'held?'); } catch (e) { why = e.name + ': ' + e.message; }\nreturn { summary: why };`);
    const broker = new Broker({ tools: [createReadTool(), createEditTool()], runId: 'run_6', worktree: root, capabilities: caps(['read', 'edit']), fencingToken: 1, guard: liveWriteGuard() });
    const out = await invoke({}, { output: { type: 'object' } as JsonObject, hooks: [gate], llm: new FakeLLM([program]), repl: new FakeRepl(), broker, ledger, run: { runId: 'run_6', invokeId: 'inv_6', depth: 0 } });
    expect(out.kind).toBe('returned');
    if (out.kind === 'returned') expect((out.value as { summary: string }).summary).toMatch(/^E_DENIED: policy: edit is a write-risk tool/);
    expect(ledger.approvals.size).toBe(0);
    expect(ledger.checkpoints.size).toBe(0);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });
});

// ---------------------------------------------------------------- stand-ins through the StepWorker

const mailDecl: MockToolDeclaration = { capability: 'mail', kind: 'email', tool: 'mail', methods: ['send', 'outbox'], schema: { type: 'object' }, mockId: 'mock_mail_r', reason: 'no sender declared; email is not provisionable' };
const plan: Plan = {
  id: 'plan_6',
  trigger: { kind: 'goal.adopted' },
  context: [],
  steps: [{ id: 'welcome', kind: 'worker', dependsOn: [], inputs: {}, instruction: 'send the welcome email' }],
  allowedModels: {},
  permissions: { tools: ['read', 'mail', 'notify'], write: [], approvals: [] },
  budget: {},
  origin: 'generated',
  status: 'candidate',
  goalKinds: [],
};
const request = (over: Partial<WorkerStepRequest> = {}): WorkerStepRequest => ({
  runId: 'run_mk',
  goal: { id: 'g6', statement: 'send a welcome email', check: { command: 'node --test', timeoutSec: 30 }, commitment: 'single-minded', status: 'open', evidence: [] },
  plan,
  intention: newIntention({ id: 'i6', goalId: 'g6', plan, commitment: 'single-minded' }),
  step: plan.steps[0]!,
  seatId: 'cheap',
  inputs: {},
  capabilities: caps(['read', 'mail', 'notify']),
  worktree: root,
  fencingToken: 3,
  guard: liveWriteGuard(),
  mocks: [mailDecl],
  ...over,
});
const probed = (state: 'available' | 'missing'): TeceraEvent =>
  ({ id: `ev_probe_${state}`, kind: 'capability.probed', at: 1, actor: { kind: 'system', id: 'probe' }, runId: 'run_mk', trace: {}, payload: { capability: { id: 'mail', kind: 'email', state, probe: { command: 'smtp-check', exitCode: state === 'available' ? 0 : 1 } } } }) as unknown as TeceraEvent;
const send = js(`const r = await mail.send({ to: 'new.user@example.test', subject: 'Welcome' });\nreturn { summary: 'sent ' + r.id, facts: [{ key: 'welcome.sent', value: r.id }], simulated: false };`);

describe('stand-ins through the StepWorker', () => {
  it('a declared mock serves the step: the outcome is marked simulated (whatever the program returns), capability.mocked is recorded once', async () => {
    const ledger = new FakeLedger();
    await ledger.append(probed('missing'));
    const announced: Array<[string, CapabilityMockedPayload]> = [];
    let made: StandInTool | undefined;
    const worker = new StepWorker({ seats: { cheap: new FakeLLM([send]) }, repl: new FakeRepl(), tools: [createReadTool()], hooks: [], ledger, standIns: (d) => (made = standInFor(d)), onMocked: (runId, p) => void announced.push([runId, p]) });
    const out = await worker.run(request());
    expect(out).toMatchObject({ kind: 'returned', value: { summary: 'sent sim-msg-1', simulated: false } });
    expect(simulationOf(out)).toEqual({ capabilities: ['mail'], mockIds: ['mock_mail_r'] });
    expect(announced).toEqual([['run_mk', { capability: 'mail', kind: 'email', tool: 'mail', mockId: 'mock_mail_r', reason: mailDecl.reason }]]);
    expect((await ledger.listEvidence('run_mk', 'capability.mocked')).map((e) => e.key)).toEqual(['mock:run_mk:mock_mail_r']);
    expect(made!.sent()).toEqual([{ id: 'sim-msg-1', message: { to: 'new.user@example.test', subject: 'Welcome' } }]);
  });

  it('a step that declares mocks but never uses one is not marked; a step without mocks is never marked', async () => {
    const plain = js(`return { summary: 'nothing sent' };`);
    const w = new StepWorker({ seats: { cheap: new FakeLLM([plain, plain]) }, repl: new FakeRepl(), tools: [createReadTool()], hooks: [], inventory: () => [{ id: 'mail', kind: 'email', state: 'missing' }] });
    const a = await w.run(request());
    expect(a.kind).toBe('returned');
    expect(simulationOf(a)).toBeNull();
    const b = await w.run(request({ mocks: undefined, capabilities: caps(['read']) }));
    expect(simulationOf(b)).toBeNull();
    expect('simulated' in b).toBe(false);
  });

  it('a mock for a capability the ledger inventory shows available is refused before anything runs (aborted, policy)', async () => {
    const ledger = new FakeLedger();
    await ledger.append(probed('available'));
    const llm = new FakeLLM([send]);
    const out = await new StepWorker({ seats: { cheap: llm }, repl: new FakeRepl(), tools: [createReadTool()], hooks: [], ledger }).run(request());
    expect(out.kind).toBe('aborted');
    if (out.kind === 'aborted') expect(out.reasons[0]).toMatchObject({ code: 'policy', reason: expect.stringMatching(/capability mail is available: it may not be mocked/) });
    expect(llm.requests).toHaveLength(0);
    expect(await ledger.listEvidence('run_mk', 'capability.mocked')).toEqual([]);
  });

  it('with no inventory at all (no ledger, no inventory option) every mock is refused (fail closed)', async () => {
    const llm = new FakeLLM([send]);
    const out = await new StepWorker({ seats: { cheap: llm }, repl: new FakeRepl(), tools: [createReadTool()], hooks: [] }).run(request());
    expect(out.kind).toBe('aborted');
    if (out.kind === 'aborted') expect(out.reasons[0]!.reason).toMatch(/need the capability inventory/);
    expect(llm.requests).toHaveLength(0);
  });

  it('a factory that cannot serve a declaration refuses the step', async () => {
    const out = await new StepWorker({ seats: { cheap: new FakeLLM([send]) }, repl: new FakeRepl(), tools: [createReadTool()], hooks: [], inventory: () => [] }).run(request({ mocks: [{ ...mailDecl, kind: 'payments' }] }));
    expect(out.kind).toBe('aborted');
    if (out.kind === 'aborted') expect(out.reasons[0]!.reason).toMatch(/no stand-in for mail: no generic stand-in serves kind "payments"/);
  });

  it('resume serves the same stand-in: the send before the hold is replayed from the journal, not sent twice; the resumed outcome is still marked', async () => {
    const notify: Tool = { name: 'notify', methods: ['call'], risk: 'irreversible', schema: {}, call: async (r): Promise<ToolResult> => ({ callId: r.callId, ok: true, value: 'ok', provenance: { src: 'tool:notify', trust: 'untrusted' }, truncated: false }) };
    const gate = hook('approvalGate', (e) => {
      const i = e.input as { tool: string; actionHash: string };
      return e.stage === 'Send' && i.tool === 'notify' ? [{ type: 'Suspend', request: { requestId: `ap_${e.spanId}`, action: 'notify', actionHash: i.actionHash, reason: 'notify requires approval', requester: 'worker' } }] : [];
    });
    const ledger = new FakeLedger();
    let made = 0;
    let sink: StandInTool | undefined;
    const program = js(`const r = await mail.send({ to: 'u@example.test' });\nawait notify('ops');\nreturn { summary: r.id };`);
    const worker = new StepWorker({ seats: { cheap: new FakeLLM([program]) }, repl: new FakeRepl(), tools: [createReadTool(), notify], hooks: [gate], ledger, sessionId: 'sess', inventory: () => [], standIns: (d) => (made++, (sink = standInFor(d))), resumeLease: () => ({ worktree: root, fencingToken: 3 }) });
    const first = await worker.run(request());
    if (first.kind !== 'suspended') throw new Error(`expected suspended, got ${JSON.stringify(first)}`);
    expect(simulationOf(first)?.mockIds).toEqual(['mock_mail_r']);
    const grant = await ledger.grantAudited(first.request.requestId, human, 'sess', Date.now());
    const done = await worker.resume(first.resumeToken, grant, undefined, liveWriteGuard());
    expect(done).toMatchObject({ kind: 'returned', value: { summary: 'sim-msg-1' } });
    expect(simulationOf(done)).toEqual({ capabilities: ['mail'], mockIds: ['mock_mail_r'] });
    expect(made).toBe(1);
    expect(sink!.sent()).toHaveLength(1);
  });

  it('inputs and goal bindings the program sees never carry the inventory or the stand-in state', async () => {
    let seen: Inputs | undefined;
    const repl = new FakeRepl({ script: [async (req) => ((seen = req.bindings), { kind: 'return', value: { summary: 'x' }, output: '', printed: '' })] });
    await new StepWorker({ seats: { cheap: new FakeLLM([js('return 1;')]) }, repl, tools: [createReadTool()], hooks: [], inventory: (): CapabilityRecord[] => [{ id: 'mail', kind: 'email', state: 'missing' }] }).run(request());
    expect(seen!.mail).toMatchObject({ kind: 'handle', methods: ['send', 'outbox'] });
    expect(Object.keys(seen!).filter((k) => /inventory|mock/i.test(k))).toEqual([]);
    expect(JSON.stringify(seen)).not.toMatch(/mock_mail_r|"state":"missing"/);
  });
});
