import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeRedactor, type CapabilitySet, type Effect, type Hook, type Inputs, type Json, type SpanEvent, type Tool, type ToolBridge, type ToolResult } from '@tecera/contracts';
import { Dispatcher } from '../hooks/dispatcher.js';
import { History } from '../invoke/history.js';
import { SpanRunner, type TraceEntry } from '../invoke/span.js';
import { FakeLedger, liveWriteGuard } from '../invoke/fakes.js';
import { createEditTool } from '../tools/edit.js';
import { createReadTool } from '../tools/read.js';
import { Broker, HOST_GATE_ACTIONS, hostGateActionOf, type ExecSession } from './broker.js';

/**
 * Owner decision D6 (2026-10-05), worker side: the PR is a host gate. Pushing, opening a PR and merging
 * are never worker tool calls: a program that calls one is REFUSED (E_DENIED, code 'policy'), never
 * suspended for an approval, even when a hook would hold it; the tool never runs. A Suspend that names a
 * write (the removed per-write approval) is refused too, while an ordinary Suspend on another
 * requiresApproval action still holds the exec (the JAZ approval machinery is unchanged).
 */

const caps = (tools: string[]): CapabilitySet => ({
  tools,
  paths: { read: ['**'], write: ['src/**'], protected: ['test/**'] },
  network: 'none',
  limits: { usd: 1, tokens: 1000, calls: 20, wallMs: 1000, depth: 2, iterations: 5 },
});
const hook = (id: string, fn: (e: SpanEvent) => Effect[] | Promise<Effect[]>): Hook => ({ id, mandatory: false, spans: new Set(['ToolCall']), handle: fn, describe: () => ({ id, mandatory: false, config: {} }) });
/** A hook that holds EVERY call at Send (what a requiresApproval classification of the action would do). */
const holdAll = (seen: string[]) =>
  hook('approvalGate', (e) => {
    if (e.stage !== 'Send') return [];
    const i = e.input as { tool: string; method: string; actionHash: string };
    seen.push(`${i.tool}.${i.method}`);
    return [{ type: 'Suspend', request: { requestId: `ap_${e.spanId}`, action: i.tool, actionHash: i.actionHash, reason: `${i.tool} requires approval`, requester: 'worker' } }];
  });

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tecera-hostgate-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
});
afterEach(async () => rm(root, { recursive: true, force: true }));

/** A host-side tool that records whether it ever ran. */
function spyTool(name: string, methods: string[] = ['call'], risk: Tool['risk'] = 'irreversible'): Tool & { ran: string[] } {
  const ran: string[] = [];
  return { name, methods, risk, schema: {}, ran, call: async (req) => (ran.push(req.method), { callId: req.callId, ok: true, value: 'done', provenance: { src: `tool:${name}`, trust: 'untrusted' }, truncated: false }) };
}

function setup(tools: Tool[], hooks: Hook[]) {
  const c = caps(tools.map((t) => t.name));
  const ledger = new FakeLedger();
  const broker = new Broker({ tools, runId: 'run_hg', worktree: root, capabilities: c, fencingToken: 3, guard: liveWriteGuard(), redactor: makeRedactor([]) });
  const run = { runId: 'run_hg', invokeId: 'inv_hg', depth: 0 };
  const trace: TraceEntry[] = [];
  const spans = new SpanRunner({ dispatcher: new Dispatcher(hooks), run, trace, ledger });
  const session = (execNo: number): ExecSession => ({ execNo, invokeId: 'inv_hg', capabilities: c, spans, history: new History([]), checkpoints: new Map(), onStop: () => undefined });
  return { broker, session, trace, ledger };
}
const call = (bridge: ToolBridge, b: Inputs[string] | undefined, args: Json[], method = 'call'): Promise<ToolResult> => bridge({ callId: 'c', tool: b && b.kind === 'handle' ? b.id : 'nope', method, args, idemKey: 'x' });

describe('D6: push / PR / merge are host gates; a worker program is refused, never suspended', () => {
  it('the host-gate set covers @tecera/policy PR_GATE_ACTIONS and MERGE_ACTIONS', () => {
    for (const a of ['open_pr', 'git_push', 'gh_pr', 'pr_create', 'gh_pr_create', 'merge', 'git_merge', 'gh_merge', 'pr_merge', 'gh_pr_merge']) expect(HOST_GATE_ACTIONS.has(a)).toBe(true);
    expect(hostGateActionOf('git', 'push')).toBe('git_push');
    expect(hostGateActionOf('gh', 'pr_create')).toBe('gh_pr_create');
    expect(hostGateActionOf('open_pr', 'call')).toBe('open_pr');
    expect(hostGateActionOf('edit', 'call')).toBeUndefined();
    expect(hostGateActionOf('read', 'call')).toBeUndefined();
  });

  for (const [name, methods, method] of [
    ['git_push', ['call'], 'call'],
    ['open_pr', ['call'], 'call'],
    ['git', ['push', 'status'], 'push'],
    ['gh', ['pr_create'], 'pr_create'],
    ['merge', ['call'], 'call'],
    ['gh', ['pr_merge'], 'pr_merge'],
  ] as const) {
    it(`${name}.${method}: E_DENIED (policy) before any hook, the tool never runs, no suspension, no approval requested`, async () => {
      const t = spyTool(name, [...methods]);
      const seen: string[] = [];
      const { broker, session, trace, ledger } = setup([t], [holdAll(seen)]);
      const b = broker.beginExec(session(1));
      const r = await call(broker.bridge, b[name], ['origin', 'tecera/goal'], method);
      expect(r.ok).toBe(false);
      expect(r.error?.name).toBe('E_DENIED');
      expect(r.error?.message).toMatch(/policy: .*host gate/);
      expect(t.ran).toEqual([]);
      expect(seen).toEqual([]); // no hook saw a Send it could turn into a hold
      const rep = await broker.endExec();
      expect(rep.suspension).toBeUndefined();
      expect(rep.fatal).toBeUndefined();
      expect(ledger.approvals.size).toBe(0);
      // the refusal is still audited as an aborted ToolCall span
      expect(trace.some((e) => e.type === 'span' && e.span === 'ToolCall' && e.stage === 'Exit' && (e as { outcome?: string }).outcome === 'Aborted')).toBe(true);
    });
  }

  it('the exec stays live after the refusal: other calls proceed (a refusal, not an abort of the step)', async () => {
    const t = spyTool('git_push');
    const { broker, session } = setup([t, createReadTool()], []);
    const b = broker.beginExec(session(1));
    expect((await call(broker.bridge, b.git_push, [])).error?.name).toBe('E_DENIED');
    expect((await call(broker.bridge, b.readFile, ['src/a.ts'])).ok).toBe(true);
    await broker.endExec();
    expect(t.ran).toEqual([]);
  });

  it('control: a requiresApproval action that is not a host gate still suspends the exec (approval machinery unchanged)', async () => {
    const t = spyTool('externalWrite');
    const seen: string[] = [];
    const { broker, session } = setup([t], [holdAll(seen)]);
    const b = broker.beginExec(session(1));
    expect((await call(broker.bridge, b.externalWrite, ['x'])).error?.name).toBe('E_SUSPENDED');
    const rep = await broker.endExec();
    expect(rep.suspension?.requests[0]?.reason).toBe('externalWrite requires approval');
    expect(t.ran).toEqual([]);
  });
});

describe('D6: a Suspend that names a write is refused (per-write approvals were removed)', () => {
  it('a hook holding a write with SuspendRequest.write: E_DENIED, no suspension, nothing written', async () => {
    const perWrite = hook('legacyPerWrite', (e) => {
      if (e.stage !== 'Send') return [];
      const i = e.input as { tool: string; actionHash: string; path?: string };
      return i.tool === 'edit' ? [{ type: 'Suspend', request: { requestId: 'wr_legacy', action: `write ${i.path}`, actionHash: i.actionHash, reason: 'isolation is degraded', requester: 'worker', write: { path: String(i.path), contentDigest: 'd' } } }] : [];
    });
    const { broker, session, ledger } = setup([createReadTool(), createEditTool()], [perWrite]);
    const b = broker.beginExec(session(1));
    const r = await call(broker.bridge, b.writeFile, ['src/a.ts', 'held?']);
    expect(r.error?.name).toBe('E_DENIED');
    expect(r.error?.message).toMatch(/names a write: per-write approvals were removed/);
    const rep = await broker.endExec();
    expect(rep.suspension).toBeUndefined();
    expect(ledger.approvals.size).toBe(0);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });
});
