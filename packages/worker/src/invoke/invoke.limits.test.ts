import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CapabilitySet, Effect, Hook, Inputs, JsonObject, Limits, SpanEvent } from '@tecera/contracts';
import { Broker } from '../broker/broker.js';
import { DEFAULT_CONFIG } from '../config.js';
import { Dispatcher } from '../hooks/dispatcher.js';
import { createReadTool } from '../tools/read.js';
import { FakeLLM, FakeRepl, liveWriteGuard, type FakeReply } from './fakes.js';
import type { ReplFactory } from './invoke.js';
import { effectiveLimits, invoke, type InvokeOptions } from './invoke.js';

/**
 * One effective limit set per invoke: configuration ∩ capabilities (broker ∩ enclosing scope ∩ hook
 * restrictions). The iteration backstop, the depth ceiling and the exec timeout read it; none of them reads
 * the configuration alone. No hook enforces anything here unless the test says so: these limits are the
 * loop's own and do not depend on a policy hook or on budgets being enforced.
 */

const js = (body: string): string => `\`\`\`js\n${body}\n\`\`\``;
const SCHEMA: JsonObject = { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } };
const goal: Inputs = { goal: { kind: 'value', value: { statement: 'do the thing' }, provenance: { src: 'goal', trust: 'trusted' } } };
const hook = (id: string, spans: SpanEvent['span'][], fn: (e: SpanEvent) => Effect[] | Promise<Effect[]>): Hook => ({ id, mandatory: false, spans: new Set(spans), handle: fn, describe: () => ({ id, mandatory: false, config: {} }) });
const caps = (limits: Partial<Limits> = {}): CapabilitySet => ({
  tools: ['read'],
  paths: { read: ['**'], write: [], protected: [] },
  network: 'none',
  limits: { usd: 1, tokens: 100_000, calls: 50, wallMs: 60_000, depth: 3, iterations: 10, ...limits },
});
/** A model that never returns: every turn prints and falls off the end. */
const never = (n: number): FakeReply[] => Array.from({ length: n }, (_, i) => js(`console.log('still going ${i}');`));
/** A model whose every return violates the output schema. */
const invalid = (n: number): FakeReply[] => Array.from({ length: n }, () => js('return { nope: 1 };'));

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tecera-limits-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
});
afterEach(async () => rm(root, { recursive: true, force: true }));

function opts(llm: FakeLLM, limits: Partial<Limits> = {}, extra: Partial<InvokeOptions> = {}): InvokeOptions & { repl: FakeRepl } {
  return {
    output: SCHEMA,
    hooks: [],
    llm,
    repl: new FakeRepl(),
    broker: new Broker({ tools: [createReadTool()], runId: 'run_l', worktree: root, capabilities: caps(limits), fencingToken: 1, guard: liveWriteGuard() }),
    run: { runId: 'run_l', invokeId: 'inv_l', depth: 0 },
    ...extra,
  } as InvokeOptions & { repl: FakeRepl };
}

describe('effectiveLimits', () => {
  it('is the smaller of configuration and capabilities for every limit', () => {
    expect(effectiveLimits(DEFAULT_CONFIG, caps({ iterations: 4, depth: 2, wallMs: 500 }))).toEqual({ usd: 1, tokens: 100_000, calls: 50, wallMs: 500, depth: 2, iterations: 4 });
    expect(effectiveLimits({ ...DEFAULT_CONFIG, limits: { ...DEFAULT_CONFIG.limits, iterations: 3, depth: 1 } }, caps())).toMatchObject({ iterations: 3, depth: 1 });
  });
});

describe('the iteration backstop', () => {
  it('a model that never returns hits the backstop and aborts with code iterations (no hook involved)', async () => {
    const llm = new FakeLLM(never(30));
    const out = await invoke(goal, opts(llm, { iterations: 4 }));
    expect(out).toMatchObject({ kind: 'aborted', reasons: [{ code: 'iterations', reason: 'iteration backstop 4 reached', hookId: 'invoke' }] });
    expect(llm.requests).toHaveLength(4); // capabilities say 4; the configuration's 20 does not apply
  });

  it('a model that only ever returns an invalid value hits it too', async () => {
    const llm = new FakeLLM(invalid(30));
    const out = await invoke(goal, opts(llm, { iterations: 3 }));
    expect(out).toMatchObject({ kind: 'aborted', reasons: [{ code: 'iterations', reason: 'iteration backstop 3 reached' }] });
    expect(llm.requests).toHaveLength(3);
  });

  it('the configuration still bounds it when it is the smaller one, and the prompt states the effective number', async () => {
    const llm = new FakeLLM(never(30));
    const out = await invoke(goal, opts(llm, { iterations: 10 }, { config: { limits: { iterations: 2 } } }));
    expect(out).toMatchObject({ kind: 'aborted', reasons: [{ code: 'iterations', reason: 'iteration backstop 2 reached' }] });
    expect(llm.requests).toHaveLength(2);
    const llm2 = new FakeLLM(never(30));
    await invoke(goal, opts(llm2, { iterations: 4 }));
    expect(llm2.requests[0]!.messages[0]!.content).toContain('You have at most 4 turns.');
  });

  it('a hook restriction at Invoke/Enter narrows it; one applied mid-loop counts from the next turn', async () => {
    const atEnter = hook('restrict', ['Invoke'], (e) => (e.stage === 'Enter' ? [{ type: 'RestrictCapabilities', to: { limits: { iterations: 2 } as never } }] : []));
    const llm = new FakeLLM(never(30));
    const out = await invoke(goal, opts(llm, {}, { hooks: [atEnter] }));
    expect(out).toMatchObject({ kind: 'aborted', reasons: [{ code: 'iterations', reason: 'iteration backstop 2 reached' }] });
    expect(llm.requests).toHaveLength(2);
    // third LLMQuery/Enter restricts to 3 iterations: turn 3 still runs (it has started), turn 4 does not
    let n = 0;
    const midLoop = hook('late', ['LLMQuery'], (e) => (e.stage === 'Enter' && ++n === 3 ? [{ type: 'RestrictCapabilities', to: { limits: { iterations: 3 } as never } }] : []));
    const llm2 = new FakeLLM(never(30));
    const out2 = await invoke(goal, opts(llm2, {}, { hooks: [midLoop] }));
    expect(out2).toMatchObject({ kind: 'aborted', reasons: [{ code: 'iterations', reason: 'iteration backstop 3 reached' }] });
    expect(llm2.requests).toHaveLength(3);
  });

  it('a restriction carrying a negative or fractional count is a hook error, not a limit', async () => {
    for (const bad of [{ iterations: -1 }, { iterations: 1.5 }, { depth: Number.NaN }]) {
      const h = hook('bad', ['Invoke'], (e) => (e.stage === 'Enter' ? [{ type: 'RestrictCapabilities', to: { limits: bad as never } }] : []));
      const llm = new FakeLLM(never(5));
      const out = await invoke(goal, opts(llm, {}, { hooks: [h] }));
      expect(out, JSON.stringify(bad)).toMatchObject({ kind: 'aborted', reasons: [{ code: 'hookError', reason: expect.stringMatching(/RestrictCapabilities carries an invalid limit/) }] });
      expect(llm.requests).toHaveLength(0);
    }
  });
});

describe('a narrowed sub-invoke runs under its own limits, never its parent\'s or the configuration\'s', () => {
  const parentOf = (narrow: string, output = "{ type: 'object' }"): string => js(`let r; try { r = await invoke({ q: 1 }, { output: ${output}, narrow: ${narrow} }); } catch (e) { r = e.name + ': ' + e.message; }\nreturn { summary: JSON.stringify(r) };`);
  const summary = (out: Awaited<ReturnType<typeof invoke>>): string => (out.kind === 'returned' ? (out.value as { summary: string }).summary : `(${out.kind})`);

  it('parent 10 iterations, child narrowed to 2, child model always continues: exactly two child turns, no third call, reason iterations', async () => {
    const llm = new FakeLLM([parentOf('{ limits: { iterations: 2 } }'), ...never(30)]);
    const out = await invoke(goal, opts(llm, { iterations: 10 }));
    expect(summary(out)).toMatch(/E_ABORTED: iterations: iteration backstop 2 reached/);
    expect(llm.requests).toHaveLength(3); // the parent's turn and two child turns
  });

  it('the same with a child that always returns an invalid value', async () => {
    const llm = new FakeLLM([parentOf('{ limits: { iterations: 2 } }', "{ type: 'object', required: ['answer'] }"), ...invalid(30)]);
    const out = await invoke(goal, opts(llm, { iterations: 10 }));
    expect(summary(out)).toMatch(/E_ABORTED: iterations: iteration backstop 2 reached/);
    expect(llm.requests).toHaveLength(3);
  });

  it('a child that narrows nothing inherits its parent\'s iterations (3), not the configuration\'s 20; asking for more is refused', async () => {
    const llm = new FakeLLM([parentOf('{ tools: [\'read\'] }'), ...never(30)]);
    const out = await invoke(goal, opts(llm, { iterations: 3 }));
    expect(summary(out)).toMatch(/E_ABORTED: iterations: iteration backstop 3 reached/);
    expect(llm.requests).toHaveLength(4);
    const wide = new FakeLLM([parentOf('{ limits: { iterations: 4 } }'), ...never(30)]);
    const refused = await invoke(goal, opts(wide, { iterations: 3 }));
    expect(summary(refused)).toMatch(/E_DENIED: .*beyond its parent/);
    expect(wide.requests).toHaveLength(1);
  });

  it('depth is the absolute ceiling of the tree: under a ceiling of 2 the child (depth 1) cannot invoke, whatever the configuration (3) says', async () => {
    const child = js(`let g; try { g = await invoke({}, { output: { type: 'object' } }); } catch (e) { g = e.name + ': ' + e.message; }\nreturn { depth: __depth__, grandchild: g };`);
    const llm = new FakeLLM([parentOf('{}'), child, js('return { reached: true };')]);
    const out = await invoke(goal, opts(llm, { depth: 2 }));
    const v = JSON.parse(summary(out)) as { kind: string; value: { depth: number; grandchild: string } };
    expect(v).toMatchObject({ kind: 'returned', value: { depth: 1, grandchild: expect.stringMatching(/E_DENIED: .*invoke is not available at this depth/) } });
    expect(llm.requests).toHaveLength(2); // no grandchild ever asked the model
    // and the child was told so: its prompt does not offer invoke, the root's does
    expect(llm.requests[0]!.messages[0]!.content).toContain('await invoke(inputs');
    expect(llm.requests[1]!.messages[0]!.content).not.toContain('await invoke(inputs');
  });

  it('a child narrowed to depth 2 under a parent ceiling of 3 cannot invoke; a ceiling that leaves no level for the child itself is refused', async () => {
    const child = js(`let g; try { g = await invoke({}, { output: { type: 'object' } }); } catch (e) { g = e.name + ': ' + e.message; }\nreturn { grandchild: g };`);
    const llm = new FakeLLM([parentOf('{ depth: 2 }'), child, js('return { reached: true };')]);
    const out = await invoke(goal, opts(llm, { depth: 3 }));
    expect(summary(out)).toMatch(/invoke is not available at this depth/);
    expect(llm.requests).toHaveLength(2);
    // unnarrowed, the same tree does reach the grandchild (the ceiling of 3 allows depth 2)
    const llm2 = new FakeLLM([parentOf('{}'), child, js('return { reached: true };')]);
    expect(summary(await invoke(goal, opts(llm2, { depth: 3 })))).toContain('reached');
    expect(llm2.requests).toHaveLength(3);
    for (const narrow of ['{ depth: 1 }', '{ depth: 0 }', '{ limits: { depth: 1 } }']) {
      const none = new FakeLLM([parentOf(narrow), js('return { reached: true };')]);
      expect(summary(await invoke(goal, opts(none, { depth: 3 }))), narrow).toMatch(/E_DENIED: sub-invoke would run at depth 1, at or past its depth ceiling [01]: refused/);
      expect(none.requests, narrow).toHaveLength(1);
    }
  });

  it('negative, non-finite and fractional count limits are refused (never clamped); a fractional amount is fine', async () => {
    const bad: Array<[string, RegExp]> = [
      ['{ limits: { iterations: -1 } }', /limit iterations must not be negative/],
      ['{ limits: { iterations: 1.5 } }', /limit iterations counts whole things and must be an integer/],
      ['{ limits: { calls: 0.5 } }', /limit calls counts whole things/],
      ['{ limits: { tokens: 10.25 } }', /limit tokens counts whole things/],
      ['{ limits: { depth: 1.5 } }', /limit depth counts whole things/],
      ['{ limits: { usd: -0.01 } }', /limit usd must not be negative/],
      ['{ limits: { wallMs: -5 } }', /limit wallMs must not be negative/],
      ['{ limits: { iterations: Infinity } }', /limit iterations must be a finite number/],
      ['{ limits: { iterations: "3" } }', /limit iterations must be a finite number/],
      ['{ limits: { turns: 3 } }', /unknown limit turns/],
      ['{ depth: -1 }', /narrow\.depth is invalid: limit depth must not be negative/],
      ['{ depth: 1.5 }', /narrow\.depth is invalid: limit depth counts whole things/],
    ];
    for (const [narrow, why] of bad) {
      const llm = new FakeLLM([parentOf(narrow), js('return { reached: true };')]);
      const s = summary(await invoke(goal, opts(llm)));
      expect(s, narrow).toMatch(/E_DENIED/);
      expect(s, narrow).toMatch(why);
      expect(llm.requests, narrow).toHaveLength(1); // the child never started
    }
    const fine = new FakeLLM([parentOf('{ limits: { usd: 0.25, wallMs: 1500.5, iterations: 2 } }'), js('return { reached: true };')]);
    expect(summary(await invoke(goal, opts(fine)))).toContain('reached');
  });
});

describe('exec timeout and the invoke deadline', () => {
  it('the run\'s own wall limit is not a deadline here: a root exec gets the configured timeout', async () => {
    const o = opts(new FakeLLM([js('return { summary: "ok" };')]), { wallMs: 1_000 });
    expect((await invoke(goal, o)).kind).toBe('returned');
    expect(o.repl.execs.map((e) => e.timeoutMs)).toEqual([DEFAULT_CONFIG.exec.timeoutMs]);
  });

  it('a sub-invoke narrowed to 400 ms of wall time: its exec timeout is clamped to what is left, and no turn starts past the deadline', async () => {
    const parent = js(`let r; try { r = await invoke({ q: 1 }, { output: { type: 'object' }, narrow: { limits: { wallMs: 400 } } }); } catch (e) { r = e.name + ': ' + e.message; }\nreturn { summary: JSON.stringify(r) };`);
    const slow = js(`await new Promise((r) => setTimeout(r, 450)); console.log('slept');`);
    const llm = new FakeLLM([parent, slow, ...never(10)]);
    const o = opts(llm);
    const out = await invoke(goal, o);
    expect(out.kind === 'returned' ? (out.value as { summary: string }).summary : out.kind).toMatch(/E_ABORTED: budget: the narrowed wall-clock limit of invoke inv_l\/e1c1 was reached/);
    expect(llm.requests).toHaveLength(2); // the parent's turn and ONE child turn
    const [parentExec, childExec] = o.repl.execs;
    expect(parentExec!.timeoutMs).toBe(DEFAULT_CONFIG.exec.timeoutMs);
    expect(childExec!.timeoutMs).toBeGreaterThan(0);
    expect(childExec!.timeoutMs).toBeLessThanOrEqual(400);
  });

  it('a hook that narrows the wall limit of one invoke sets its deadline from that invoke\'s start', async () => {
    const h = hook('wall', ['Invoke'], (e) => (e.stage === 'Enter' ? [{ type: 'RestrictCapabilities', to: { limits: { wallMs: 300 } as never } }] : []));
    const llm = new FakeLLM([js(`await new Promise((r) => setTimeout(r, 350)); console.log('slept');`), ...never(10)]);
    const o = opts(llm, {}, { hooks: [h] });
    const out = await invoke(goal, o);
    expect(out).toMatchObject({ kind: 'aborted', reasons: [{ code: 'budget', reason: expect.stringMatching(/narrowed wall-clock limit of invoke inv_l was reached/) }] });
    expect(llm.requests).toHaveLength(1);
    expect(o.repl.execs[0]!.timeoutMs).toBeLessThanOrEqual(300);
  });
});

describe('Exit-stage hooks that are slow', () => {
  const slowAt = (span: SpanEvent['span'], ms: number): Hook => hook('slowExit', [span], async (e) => (e.stage === 'Exit' ? (await new Promise((r) => setTimeout(r, ms)), []) : []));

  it('a REPLExec Exit hook slower than the hook bound aborts the step naming the hook, the stage and the timeout; the model gets no further turn', async () => {
    const llm = new FakeLLM([js('console.log("first turn");'), js('return { summary: "second turn" };')]);
    const h = slowAt('REPLExec', 300);
    const out = await invoke(goal, opts(llm, {}, { hooks: [h], dispatcher: new Dispatcher([h], { hookTimeoutMs: 40 }) }));
    expect(out).toMatchObject({ kind: 'aborted', reasons: [{ code: 'hookError', hookId: 'slowExit', reason: 'hook failed: hook slowExit timed out at REPLExec/Exit after 40 ms (it had not answered; its effects, if any, are lost)' }] });
    expect(llm.requests).toHaveLength(1);
  });

  it('the same hook inside the bound changes nothing: no abort is invented by a delay alone', async () => {
    const llm = new FakeLLM([js('console.log("first turn");'), js('return { summary: "second turn" };')]);
    const h = slowAt('REPLExec', 60);
    const out = await invoke(goal, opts(llm, {}, { hooks: [h], dispatcher: new Dispatcher([h], { hookTimeoutMs: 2_000 }) }));
    expect(out).toMatchObject({ kind: 'returned', value: { summary: 'second turn' } });
    expect(llm.requests).toHaveLength(2);
  });

  it('a slow LLMQuery Exit hook and a throwing Invoke Exit hook report their own span and cause', async () => {
    const h = slowAt('LLMQuery', 300);
    const out = await invoke(goal, opts(new FakeLLM([js('return { summary: "x" };')]), {}, { hooks: [h], dispatcher: new Dispatcher([h], { hookTimeoutMs: 40 }) }));
    expect(out).toMatchObject({ kind: 'aborted', reasons: [{ code: 'hookError', hookId: 'slowExit', reason: expect.stringMatching(/timed out at LLMQuery\/Exit after 40 ms/) }] });
    const boom = hook('boom', ['Invoke'], (e) => {
      if (e.stage === 'Exit') throw new Error('exit record lost');
      return [];
    });
    const out2 = await invoke(goal, opts(new FakeLLM([js('return { summary: "x" };')]), {}, { hooks: [boom] }));
    expect(out2).toMatchObject({ kind: 'aborted', reasons: [{ code: 'hookError', hookId: 'boom', reason: 'hook failed: hook boom threw at Invoke/Exit: exit record lost' }] });
  });
});

describe('an exec the sandbox itself ended or refused is not a model turn', () => {
  it('E_DISPOSED (the supervisor disposed the REPL, e.g. the lease was lost) aborts the step with that cause; the model is not asked again', async () => {
    const llm = new FakeLLM([js('console.log("first turn");'), js('return { summary: "second turn" };')]);
    const repl = new FakeRepl({ script: [async () => ({ kind: 'raise', exception: { name: 'E_DISPOSED', message: 'repl disposed' }, printed: '' })] });
    const out = await invoke(goal, opts(llm, {}, { repl }));
    expect(out).toMatchObject({ kind: 'aborted', reasons: [{ code: 'cancelled', hookId: 'sandbox', reason: expect.stringMatching(/the sandbox did not run exec 1 to an end of its own \(E_DISPOSED: repl disposed\)/) }] });
    expect(llm.requests).toHaveLength(1);
  });

  it('a REPL that throws instead of answering, and a factory that refuses to build one, abort the same way', async () => {
    const llm = new FakeLLM([js('console.log("first turn");'), js('return { summary: "second turn" };')]);
    const throwing = new FakeRepl({
      script: [
        async () => {
          throw new Error('exec refused: worktree lease of run r lost');
        },
      ],
    });
    const out = await invoke(goal, opts(llm, {}, { repl: throwing }));
    expect(out).toMatchObject({ kind: 'aborted', reasons: [{ code: 'cancelled', hookId: 'sandbox', reason: expect.stringMatching(/Error: exec refused: worktree lease of run r lost/) }] });
    expect(llm.requests).toHaveLength(1);
    const llm2 = new FakeLLM([js('console.log("first turn");'), js('return { summary: "second turn" };')]);
    const factory: ReplFactory = () => {
      throw new Error('sandbox refused: lease lost');
    };
    const out2 = await invoke(goal, opts(llm2, {}, { repl: factory }));
    expect(out2).toMatchObject({ kind: 'aborted', reasons: [{ code: 'cancelled', hookId: 'sandbox', reason: expect.stringMatching(/sandbox refused: lease lost/) }] });
    expect(llm2.requests).toHaveLength(1);
  });

  it('an ordinary failure of the program is still the model\'s to fix', async () => {
    const llm = new FakeLLM([js('throw new Error("boom");'), js('return { summary: "fixed" };')]);
    expect(await invoke(goal, opts(llm))).toMatchObject({ kind: 'returned', value: { summary: 'fixed' } });
    expect(llm.requests).toHaveLength(2);
  });
});
