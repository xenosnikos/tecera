import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSimulated, makeRedactor, type CapabilityMockedPayload, type CapabilityRecord, type CapabilitySet, type Effect, type Hook, type Inputs, type Json, type MockToolDeclaration, type SpanEvent, type Tool, type ToolBridge, type ToolResult } from '@tecera/contracts';
import { Broker, type ExecSession } from '../broker/broker.js';
import { Dispatcher } from '../hooks/dispatcher.js';
import { FakeLedger, FakeWriteGuard, liveWriteGuard } from '../invoke/fakes.js';
import { History } from '../invoke/history.js';
import { SpanRunner, type TraceEntry } from '../invoke/span.js';
import { createEditTool } from '../tools/edit.js';
import { createReadTool } from '../tools/read.js';
import { MockRegistrationError, type StandIn } from './admit.js';
import { createMessageSinkStandIn, createStoreStandIn, standInFor, StandInError } from './standins.js';

/**
 * The mock rung of the gap ladder (owner decision D10/D11): stand-ins behind the broker. Every result is
 * provenance-tagged simulated, the first use records capability.mocked, a stand-in is never admitted for an
 * available or provisioned capability, and neither a program nor a tool can relabel a mock as real.
 */

const mailDecl: MockToolDeclaration = { capability: 'mail', kind: 'email', tool: 'mail', methods: ['send', 'outbox'], schema: { type: 'object', properties: { to: { type: 'string' } } }, mockId: 'mock_mail_1', reason: 'no sender is declared and email is not provisionable' };
const dbDecl: MockToolDeclaration = { capability: 'sessions', kind: 'kv', tool: 'sessions', methods: ['get', 'set', 'insert', 'select'], schema: { type: 'object' }, mockId: 'mock_db_1', reason: 'not provisionable here' };
const missing = (id: string, kind = 'email'): CapabilityRecord => ({ id, kind, state: 'missing' });
const INVENTORY: CapabilityRecord[] = [missing('mail'), missing('sessions', 'kv')];

const caps = (tools: string[]): CapabilitySet => ({ tools, paths: { read: ['**'], write: ['src/**'], protected: ['test/**'] }, network: 'none', limits: { usd: 1, tokens: 1000, calls: 20, wallMs: 1000, depth: 2, iterations: 5 } });
const hook = (id: string, fn: (e: SpanEvent) => Effect[] | Promise<Effect[]>): Hook => ({ id, mandatory: false, spans: new Set(['ToolCall']), handle: fn, describe: () => ({ id, mandatory: false, config: {} }) });
const call = (bridge: ToolBridge, b: Inputs[string] | undefined, args: Json[], method: string): Promise<ToolResult> => bridge({ callId: 'c', tool: b && b.kind === 'handle' ? b.id : 'nope', method, args, idemKey: 'x' });

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tecera-mocks-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
});
afterEach(async () => rm(root, { recursive: true, force: true }));

function setup(o: { standIns?: StandIn[]; inventory?: CapabilityRecord[]; tools?: Tool[]; hooks?: Hook[]; onMocked?: (p: CapabilityMockedPayload) => void | Promise<void>; capTools?: string[] } = {}) {
  const standIns = o.standIns ?? [{ declaration: mailDecl, tool: standInFor(mailDecl) }];
  const c = caps(o.capTools ?? ['read', 'edit', ...standIns.map((s) => s.declaration.tool)]);
  const ledger = new FakeLedger();
  const trace: TraceEntry[] = [];
  const broker = new Broker({ tools: o.tools ?? [createReadTool(), createEditTool()], runId: 'run_m', worktree: root, capabilities: c, fencingToken: 1, guard: liveWriteGuard(), redactor: makeRedactor([]), standIns, inventory: o.inventory ?? INVENTORY, ...(o.onMocked ? { onMocked: o.onMocked } : {}) });
  const spans = new SpanRunner({ dispatcher: new Dispatcher(o.hooks ?? []), run: { runId: 'run_m', invokeId: 'inv_m', depth: 0 }, trace, ledger });
  const session = (execNo: number): ExecSession => ({ execNo, invokeId: 'inv_m', capabilities: c, spans, history: new History([]), checkpoints: new Map() });
  return { broker, session, ledger, trace, standIns };
}

describe('generic stand-ins (deterministic, in-memory, host side)', () => {
  const g = () => liveWriteGuard();
  const req = (method: string, ...args: Json[]) => ({ callId: 'c', tool: 't', method, args, idemKey: '' });
  const ctx = { runId: 'r', worktree: '', capabilities: caps([]) };

  it('the store keeps keys and SQL-ish tables; ids are sequential, listings sorted; the same calls give the same answers', async () => {
    const run = async () => {
      const s = createStoreStandIn(dbDecl);
      const out: Json[] = [];
      for (const [m, ...a] of [['set', 'b', 2], ['set', 'a', { x: 1 }], ['get', 'a'], ['get', 'zz'], ['insert', 'sessions', { user: 'u1' }], ['insert', 'sessions', { user: 'u2' }], ['select', 'sessions', { user: 'u2' }]] as Array<[string, ...Json[]]>) {
        out.push((await s.call(req(m, ...a), ctx, g())).value ?? null);
      }
      return { out, snap: s.snapshot() };
    };
    const one = await run();
    expect(one.out).toEqual([{ ok: true }, { ok: true }, { x: 1 }, null, { id: 1 }, { id: 2 }, [{ user: 'u2', id: 2 }]]);
    expect(one.snap.tables.sessions).toHaveLength(2);
    expect(await run()).toEqual(one);
  });

  it('the sink records what would have been sent and never delivers anything', async () => {
    const s = createMessageSinkStandIn(mailDecl);
    const r = await s.call(req('send', { to: 'new.user@example.test', subject: 'Welcome' }), ctx, g());
    expect(r.value).toEqual({ id: 'sim-msg-1', accepted: true, simulated: true });
    expect(isSimulated(r.provenance)).toBe(true);
    expect(s.sent()).toEqual([{ id: 'sim-msg-1', message: { to: 'new.user@example.test', subject: 'Welcome' } }]);
    expect((await s.call(req('outbox'), ctx, g())).value).toEqual(s.sent());
  });

  it('a stand-in records nothing once its write guard is lost', async () => {
    const s = createMessageSinkStandIn(mailDecl);
    const fg = new FakeWriteGuard();
    fg.revoke('exec stopped');
    const r = await s.call(req('send', { to: 'x' }), ctx, fg.guard);
    expect(r.ok).toBe(false);
    expect(r.error?.name).toBe('FenceLost');
    expect(s.sent()).toEqual([]);
  });

  it('an unknown kind or an unserved declared method has no generic stand-in', () => {
    expect(() => standInFor({ ...mailDecl, kind: 'payments' })).toThrow(StandInError);
    expect(() => standInFor({ ...mailDecl, methods: ['send', 'bounce'] })).toThrow(/no method bounce/);
  });
});

describe('admission: a mock never stands in for something real', () => {
  const build = (o: Parameters<typeof setup>[0]) => () => setup(o);

  for (const state of ['available', 'provisioned'] as const) {
    it(`a stand-in for a capability that is ${state} is refused (MockRegistrationError), nothing is served`, () => {
      const inventory: CapabilityRecord[] = [{ id: 'mail', kind: 'email', state, ...(state === 'available' ? { probe: { command: 'smtp-probe', exitCode: 0 } } : { resourceId: 'res_1' }) }];
      expect(build({ inventory })).toThrow(MockRegistrationError);
      expect(build({ inventory })).toThrow(new RegExp(`capability mail is ${state}: it may not be mocked`));
    });
  }

  it('without an inventory to check against, every stand-in is refused (fail closed)', () => {
    expect(() => new Broker({ tools: [createReadTool()], runId: 'r', worktree: root, capabilities: caps(['read', 'mail']), standIns: [{ declaration: mailDecl, tool: standInFor(mailDecl) }] })).toThrow(/need the capability inventory/);
  });

  it('a connection that says mockable: false refuses its stand-in', () => {
    expect(() => new Broker({ tools: [], runId: 'r', worktree: root, capabilities: caps(['mail']), standIns: [{ declaration: mailDecl, tool: standInFor(mailDecl) }], inventory: INVENTORY, connections: { mail: { mockable: false } } })).toThrow(/not mockable/);
  });

  it('a stand-in may not shadow a real tool, a program binding, a host function or a host gate', () => {
    const shadow = (tool: string, methods = ['call']) => {
      const d: MockToolDeclaration = { ...mailDecl, tool, methods };
      const t: Tool = { name: tool, methods, risk: 'irreversible', schema: {}, call: async (r) => ({ callId: r.callId, ok: true, value: 'x', provenance: { src: 'x', trust: 'untrusted' }, truncated: false }) };
      return () => setup({ standIns: [{ declaration: d, tool: t }], capTools: ['read', 'edit', tool] });
    };
    expect(shadow('read')).toThrow(/would shadow/);
    expect(shadow('readFile')).toThrow(/would shadow/);
    expect(shadow('writeFile')).toThrow(/would shadow/);
    expect(shadow('invoke')).toThrow(/would shadow/);
    expect(shadow('__history__')).toThrow(/would shadow/);
    expect(shadow('git', ['push'])).toThrow(/host gate git_push/);
  });

  it('the stand-in must be the declared tool: same name, exactly the declared methods, the declared capability', () => {
    const other = standInFor({ ...mailDecl, tool: 'mailer' });
    expect(build({ standIns: [{ declaration: mailDecl, tool: other }] })).toThrow(/serves tool mailer/);
    const fewer = standInFor({ ...mailDecl, methods: ['send'] });
    expect(build({ standIns: [{ declaration: mailDecl, tool: fewer }] })).toThrow(/exactly the declared methods/);
    const elsewhere = { ...standInFor(mailDecl), standsIn: 'sms' };
    expect(build({ standIns: [{ declaration: mailDecl, tool: elsewhere }] })).toThrow(/stands in for sms/);
  });

  it('a stand-in passed as an ordinary tool (Tool.standsIn without admission) is refused: a mock cannot be served under a real label', () => {
    const smuggled = standInFor(mailDecl);
    expect(() => new Broker({ tools: [createReadTool(), smuggled], runId: 'r', worktree: root, capabilities: caps(['read', 'mail']) })).toThrow(/claims to stand in for mail but was not admitted/);
  });
});

describe('serving: results are simulated, the first use is announced', () => {
  it('every stand-in result is tagged simulated (src simulated:<capability>, untrusted), whatever the stand-in claims', async () => {
    const liar: Tool = { ...standInFor(mailDecl), call: async (r) => ({ callId: r.callId, ok: true, value: { id: 'real-1' }, provenance: { src: 'tool:smtp', trust: 'trusted' }, truncated: false }) };
    const { broker, session } = setup({ standIns: [{ declaration: mailDecl, tool: liar }] });
    const b = broker.beginExec(session(1));
    const r = await call(broker.bridge, b.mail, [{ to: 'a@example.test' }], 'send');
    expect(r.ok).toBe(true);
    expect(r.provenance).toMatchObject({ src: 'simulated:mail', trust: 'untrusted', simulated: true, runId: 'run_m' });
    expect(isSimulated(r.provenance)).toBe(true);
    // a real tool next to it is untouched
    const real = await call(broker.bridge, b.readFile, ['src/a.ts'], 'call');
    expect(real.provenance).toMatchObject({ src: 'tool:read', trust: 'untrusted' });
    expect(isSimulated(real.provenance)).toBe(false);
    await broker.endExec();
  });

  it('a failing stand-in call, a ReplaceOutput at Send and a PatchOutput at Complete stay simulated', async () => {
    const replace = hook('replace', (e) => (e.stage === 'Send' && (e.input as { method: string }).method === 'outbox' ? [{ type: 'ReplaceOutput', value: { replaced: true } }] : []));
    const patch = hook('patch', (e) => (e.stage === 'Complete' ? [{ type: 'PatchOutput', path: 'value.patched', value: true }] : []));
    const { broker, session } = setup({ hooks: [replace, patch] });
    const b = broker.beginExec(session(1));
    const bad = await call(broker.bridge, b.mail, ['not an object'], 'send');
    expect(bad.ok).toBe(false);
    expect(isSimulated(bad.provenance)).toBe(true);
    const replaced = await call(broker.bridge, b.mail, [], 'outbox');
    expect(replaced.value).toMatchObject({ replaced: true });
    expect(isSimulated(replaced.provenance)).toBe(true);
    const sent = await call(broker.bridge, b.mail, [{ to: 'x' }], 'send');
    expect(sent.value).toMatchObject({ patched: true });
    expect(isSimulated(sent.provenance)).toBe(true);
    await broker.endExec();
  });

  it('the first use records capability.mocked once (evidence + onMocked), concurrent first calls included; later uses do not', async () => {
    const announced: CapabilityMockedPayload[] = [];
    const { broker, session, ledger, standIns } = setup({ onMocked: (p) => void announced.push(p) });
    expect(broker.simulatedUses()).toEqual({ capabilities: [], mockIds: [] });
    const b = broker.beginExec(session(1));
    const [r1, r2] = await Promise.all([call(broker.bridge, b.mail, [{ to: 'a' }], 'send'), call(broker.bridge, b.mail, [{ to: 'b' }], 'send')]);
    expect([r1.ok, r2.ok]).toEqual([true, true]);
    await call(broker.bridge, b.mail, [{ to: 'c' }], 'send');
    await broker.endExec();
    expect(announced).toEqual([{ capability: 'mail', kind: 'email', tool: 'mail', mockId: 'mock_mail_1', reason: mailDecl.reason }]);
    const ev = await ledger.listEvidence('run_m', 'capability.mocked');
    expect(ev.map((e) => [e.key, e.body])).toEqual([['mock:run_m:mock_mail_1', announced[0]]]);
    expect(broker.simulatedUses()).toEqual({ capabilities: ['mail'], mockIds: ['mock_mail_1'] });
    expect((standIns[0]!.tool as ReturnType<typeof standInFor>).sent()).toHaveLength(3);
  });

  it('a host that refuses the announcement refuses the call: the stand-in never runs', async () => {
    const { broker, session, standIns } = setup({ onMocked: () => Promise.reject(new Error('no capability.mocked event appended')) });
    const b = broker.beginExec(session(1));
    const r = await call(broker.bridge, b.mail, [{ to: 'a' }], 'send');
    expect(r.error?.name).toBe('E_DENIED');
    expect(r.error?.message).toMatch(/capability.mocked refused by the host/);
    await broker.endExec();
    expect((standIns[0]!.tool as ReturnType<typeof standInFor>).sent()).toEqual([]);
    expect(broker.simulatedUses().mockIds).toEqual([]);
  });

  it('program-side relabel attempts: arguments claiming real provenance change nothing, undeclared methods are refused, an unregistered mock does not exist', async () => {
    const { broker, session } = setup();
    const b = broker.beginExec(session(1));
    const claim = await call(broker.bridge, b.mail, [{ to: 'a', provenance: { src: 'tool:smtp', trust: 'trusted', simulated: false }, simulated: false }], 'send');
    expect(claim.provenance).toMatchObject({ src: 'simulated:mail', simulated: true, trust: 'untrusted' });
    for (const m of ['markReal', 'setProvenance', 'call']) expect((await call(broker.bridge, b.mail, [], m)).error?.name, m).toBe('E_DENIED');
    // the program cannot ask for a stand-in the host did not register: there is no binding or handle for it
    expect(b.sms).toBeUndefined();
    expect((await broker.bridge({ callId: 'c', tool: 'sms', method: 'send', args: [{ to: 'x' }], idemKey: '' })).error?.name).toBe('E_HANDLE');
    // the program-facing description says what it is
    expect((b.mail as { description: string }).description).toMatch(/stand-in mail for mail .*SIMULATED/);
    await broker.endExec();
  });

  it('a stand-in serves only inside the capabilities, like any tool (no handle when its tool is not granted)', async () => {
    const { broker, session } = setup({ capTools: ['read', 'edit'] });
    const b = broker.beginExec(session(1));
    expect(b.mail).toBeUndefined();
    await broker.endExec();
  });

  it('a child broker serves the same stand-ins and shares the announcement', async () => {
    const announced: string[] = [];
    const { broker, session } = setup({ onMocked: (p) => void announced.push(p.mockId) });
    const b = broker.beginExec(session(1));
    await call(broker.bridge, b.mail, [{ to: 'a' }], 'send');
    await broker.endExec();
    const child = broker.child(caps(['mail']));
    const cb = child.beginExec({ ...session(2), invokeId: 'inv_m/e1c1', capabilities: caps(['mail']) });
    const r = await call(child.bridge, cb.mail, [{ to: 'b' }], 'send');
    expect(isSimulated(r.provenance)).toBe(true);
    await child.endExec();
    expect(announced).toEqual(['mock_mail_1']);
  });
});
