import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CapabilitySet, Effect, Hook, Inputs, Json, SpanEvent, Tool, ToolBridge, ToolResult, WriteGuard } from '@tecera/contracts';
import { Dispatcher } from '../hooks/dispatcher.js';
import { FakeLedger, FakeWriteGuard } from '../invoke/fakes.js';
import { History } from '../invoke/history.js';
import { SpanRunner } from '../invoke/span.js';
import { createEditTool } from '../tools/edit.js';
import { Broker, type ExecSession } from './broker.js';

/**
 * Wave 4, lane I4 (Codex sprint-3 invoke New finding 2, next step 5): a quarantine is tree-wide and
 * immediate. Brokers of the same invoke tree that ALREADY had an exec open (siblings, children) stop at
 * once; a call admitted earlier or paused in its hooks never executes; an in-flight built-in tool refuses
 * its next mutation through the exec guard; a custom writer that honours the guard cannot mutate; every
 * post-quarantine result is withheld.
 */

const caps = (): CapabilitySet => ({
  tools: ['edit', 'slow', 'custom', 'polite'],
  paths: { read: ['**'], write: ['src/**'], protected: ['test/**'] },
  network: 'none',
  limits: { usd: 1, tokens: 1000, calls: 20, wallMs: 1000, depth: 3, iterations: 5 },
});
const deferred = () => {
  let resolve!: () => void;
  const p = new Promise<void>((r) => (resolve = r));
  return { p, resolve };
};
const call = (bridge: ToolBridge, b: Inputs[string] | undefined, args: Json[]): Promise<ToolResult> => bridge({ callId: 'c', tool: b && b.kind === 'handle' ? b.id : 'nope', method: 'call', args, idemKey: '' });
const ok = (callId: string, value: Json): ToolResult => ({ callId, ok: true, value, provenance: { src: 'tool', trust: 'untrusted' }, truncated: false });

let root: string;
let mutations: string[];
beforeEach(async () => {
  mutations = [];
  root = await mkdtemp(join(tmpdir(), 'tecera-siblings-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/a.ts'), 'original\n');
});
afterEach(async () => rm(root, { recursive: true, force: true }));

/** A writer that ignores cancellation and the guard (an unresolved writer at drain timeout). */
const stubborn = (release: Promise<void>, started: () => void): Tool => ({
  name: 'slow',
  methods: ['call'],
  risk: 'write',
  schema: {},
  call: async (req) => {
    started();
    await release;
    return ok(req.callId, 'late');
  },
});
/** An injected writer that does NOT consult the guard: only admission can stop it. */
const custom: Tool = { name: 'custom', methods: ['call'], risk: 'write', schema: {}, call: async (req) => (mutations.push('custom'), ok(req.callId, 'mutated')) };
/** An injected writer that honours the contract: guard.check() immediately before its mutation. */
const polite = (gate: Promise<void>, seen: { fence?: boolean }): Tool => ({
  name: 'polite',
  methods: ['call'],
  risk: 'write',
  schema: {},
  call: async (req, ctx, guard?: WriteGuard) => {
    await gate;
    seen.fence = ctx.fence?.();
    try {
      guard!.check();
    } catch (e) {
      return { callId: req.callId, ok: false, error: { name: (e as Error).name, message: (e as Error).message }, provenance: { src: 'tool', trust: 'untrusted' }, truncated: false };
    }
    mutations.push('polite');
    return ok(req.callId, 'mutated');
  },
});

function tree(tools: Tool[], hooks: Hook[] = []) {
  const ledger = new FakeLedger();
  const parent = new Broker({ tools, runId: 'run_s', worktree: root, capabilities: caps(), fencingToken: 5, drainMs: 30, guard: new FakeWriteGuard().guard });
  const dispatcher = new Dispatcher(hooks);
  const spans = (invokeId: string) => new SpanRunner({ dispatcher, run: { runId: 'run_s', invokeId, depth: invokeId.includes('/') ? 1 : 0 }, ledger });
  let stopped = 0;
  const session = (execNo: number, invokeId: string): ExecSession => ({ execNo, invokeId, capabilities: caps(), spans: spans(invokeId), history: new History(), checkpoints: new Map(), onStop: () => void stopped++ });
  return { ledger, parent, session, stops: () => stopped };
}

/** Quarantine the parent: an unresolved writer at drain timeout. */
async function quarantineParent(parent: Broker, pb: Inputs, started: Promise<void>): Promise<void> {
  void call(parent.bridge, pb.slow, []);
  await started;
  const rep = await parent.endExec();
  expect(rep.tainted).toBeDefined();
}

describe('tree-wide quarantine of already-open brokers', () => {
  it('a sibling exec opened BEFORE the quarantine stops at once: a custom writer through it never runs (Codex probe)', async () => {
    const release = deferred();
    const started = deferred();
    const { ledger, parent, session, stops } = tree([stubborn(release.p, started.resolve), custom]);
    const child = parent.child(caps());
    const pb = parent.beginExec(session(1, 'inv_s'));
    const cb = child.beginExec(session(2, 'inv_s/e1c1')); // already open before the taint
    expect(child.active).toBe(true);
    await quarantineParent(parent, pb, started.p);
    expect(child.active).toBe(false);
    expect(child.tainted).not.toBeNull();
    expect(stops()).toBeGreaterThanOrEqual(2); // the sibling's REPL was aborted too
    const r = await call(child.bridge, cb.custom, []);
    expect(r.ok).toBe(false);
    expect(r.error?.name).toBe('E_ABORTED');
    expect(mutations).toEqual([]);
    const crep = await child.endExec();
    expect(crep.tainted).toBeDefined();
    expect(crep.fatal?.[0]).toMatchObject({ code: 'cancelled', hookId: 'quarantine' });
    const tainted = [...ledger.ev.values()].filter((e) => e.kind === 'exec.tainted').map((e) => (e.body as { invokeId: string }).invokeId);
    expect(tainted.sort()).toEqual(['inv_s', 'inv_s/e1c1']);
    release.resolve();
  });

  it('a sibling call paused in its Send hooks when the quarantine lands never executes', async () => {
    const release = deferred();
    const started = deferred();
    const inHook = deferred();
    const unpause = deferred();
    const pause: Hook = {
      id: 'pause',
      mandatory: false,
      spans: new Set(['ToolCall']),
      handle: async (e: SpanEvent): Promise<Effect[]> => {
        if (e.stage === 'Send' && (e.input as { tool: string }).tool === 'custom') {
          inHook.resolve();
          await unpause.p;
        }
        return [];
      },
      describe: () => ({ id: 'pause', mandatory: false, config: {} }),
    };
    const { parent, session } = tree([stubborn(release.p, started.resolve), custom], [pause]);
    const child = parent.child(caps());
    const pb = parent.beginExec(session(1, 'inv_s'));
    const cb = child.beginExec(session(2, 'inv_s/e1c1'));
    const paused = call(child.bridge, cb.custom, []);
    await inHook.p; // admitted, now immediately before execution
    await quarantineParent(parent, pb, started.p);
    unpause.resolve();
    const r = await paused;
    expect(r.ok).toBe(false);
    expect(mutations).toEqual([]);
    const crep = await child.endExec();
    expect(crep.discarded.map((d) => d.tool)).toEqual(['custom']);
    release.resolve();
  });

  it('an in-flight built-in edit in a sibling refuses its next mutation (exec guard): nothing is written, the result is withheld', async () => {
    const release = deferred();
    const started = deferred();
    const atData = deferred();
    const goOn = deferred();
    const edit = createEditTool({
      beforeData: async () => {
        atData.resolve();
        await goOn.p;
      },
    });
    const { parent, session } = tree([stubborn(release.p, started.resolve), edit]);
    const child = parent.child(caps());
    const pb = parent.beginExec(session(1, 'inv_s'));
    const cb = child.beginExec(session(2, 'inv_s/e1c1'));
    const writing = call(child.bridge, cb.writeFile, ['src/a.ts', 'written after the quarantine']);
    await atData.p; // the temp file exists; the data write is next
    await quarantineParent(parent, pb, started.p);
    goOn.resolve();
    const r = await writing;
    expect(r.ok).toBe(false);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('original\n');
    const crep = await child.endExec();
    expect(crep.late.map((l) => l.tool)).toEqual(['edit']);
    expect(crep.late[0]!.ok).toBe(false);
    release.resolve();
  });

  it('a custom writer that honours the guard sees fence() false and FenceLost after the quarantine; it never mutates', async () => {
    const release = deferred();
    const started = deferred();
    const gate = deferred();
    const seen: { fence?: boolean } = {};
    const { parent, session } = tree([stubborn(release.p, started.resolve), polite(gate.p, seen)]);
    const child = parent.child(caps());
    const pb = parent.beginExec(session(1, 'inv_s'));
    const cb = child.beginExec(session(2, 'inv_s/e1c1'));
    const running = call(child.bridge, cb.polite, []);
    await new Promise((r) => setTimeout(r, 5)); // the tool is running (awaiting its gate)
    await quarantineParent(parent, pb, started.p);
    gate.resolve();
    await running;
    expect(seen.fence).toBe(false);
    expect(mutations).toEqual([]);
    await child.endExec();
    release.resolve();
  });

  it('without a quarantine the same polite writer runs (control): fence() true, one mutation', async () => {
    const gate = deferred();
    const seen: { fence?: boolean } = {};
    const { parent, session } = tree([polite(gate.p, seen)]);
    const pb = parent.beginExec(session(1, 'inv_s'));
    gate.resolve();
    expect((await call(parent.bridge, pb.polite, [])).ok).toBe(true);
    expect(seen.fence).toBe(true);
    expect(mutations).toEqual(['polite']);
    await parent.endExec();
  });

  it('a broker built without a step guard refuses every write (fail closed)', async () => {
    const gate = deferred();
    gate.resolve();
    const seen: { fence?: boolean } = {};
    const b = new Broker({ tools: [polite(gate.p, seen), createEditTool()], runId: 'run_s', worktree: root, capabilities: caps(), fencingToken: 5 });
    const ledger = new FakeLedger();
    const h = b.beginExec({ execNo: 1, invokeId: 'inv_n', capabilities: caps(), spans: new SpanRunner({ dispatcher: new Dispatcher([]), run: { runId: 'run_s', invokeId: 'inv_n', depth: 0 }, ledger }), history: new History(), checkpoints: new Map() });
    expect((await call(b.bridge, h.polite, [])).error?.name).toBe('FenceLost');
    expect((await call(b.bridge, h.writeFile, ['src/a.ts', 'x'])).error?.name).toBe('FenceLost');
    expect(seen.fence).toBe(false);
    expect(mutations).toEqual([]);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('original\n');
    await b.endExec();
  });
});
