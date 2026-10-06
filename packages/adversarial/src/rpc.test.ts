import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { HANDLE_RE, RPC_LIMITS, type CapabilitySet, type Inputs, type JsonObject } from '@tecera/contracts';
import { Broker, ChildProcessRepl, createListFilesTool, createReadTool, decodeFrame, FakeLLM, FrameError, FrameReader, invoke, type ReplFactory } from '@tecera/worker';
import { CAPS, execReq, FILES, recorder, replRig, SANDBOX } from './harness/sandbox.js';
import { cleanupTemps, tmp } from './harness/tmp.js';

/**
 * security.md §6 rpc.*: the child ↔ supervisor protocol against the REAL ChildProcessRepl host (HMAC
 * exec-scoped handles, frame caps enforced before parsing, sub-invoke narrowing) and the real invoke tree.
 */

afterAll(cleanupTemps);

const js = (body: string): string => `\`\`\`js\n${body}\n\`\`\``;

describe('rpc (security.md §6)', () => {
  it('rpc.forged_handle', async () => {
    const rig = replRig();
    const rec = recorder();
    // a fabricated handle of the right shape, one for another run, and a stub's own handle with a bumped seq
    for (const code of [
      "return await fs.read({ $handle: 'h1.run_adv.1.0123456789abcdef' })",
      "return await fs.read({ $handle: 'h1.other_run.1.0123456789abcdef' })",
      "const h = JSON.parse(JSON.stringify(fs)).$handle; const [v, r, s, mac] = h.split('.'); return await fs.read({ $handle: [v, r, String(Number(s) + 1), mac].join('.') })",
      "const h = JSON.parse(JSON.stringify(fs)).$handle; return await fs.read({ $handle: h.slice(0, -1) + (h.endsWith('0') ? '1' : '0') })",
    ]) {
      const before = rec.calls.length;
      const r = await rig.repl.exec(execReq(code), rec.bridge);
      expect(r.kind, code).toBe('raise');
      if (r.kind === 'raise') expect(r.exception.name, code).toBe('E_HANDLE');
      expect(rec.calls.length, code).toBe(before);
      expect(r.trace.killed?.gone, code).toBe(true);
    }
    expect(rig.evidence.filter((e) => e.kind === 'sandbox.violation').length).toBeGreaterThanOrEqual(4);
    // a handle-shaped value coming back from a tool is data: calling it is E_HANDLE, never a tool call
    const rec2 = recorder(() => ({ value: { $handle: 'h1.run_adv.999.fedcba9876543210' } }));
    const r2 = await rig.repl.exec(execReq("const v = await fs.read('a'); return await v.len()"), rec2.bridge);
    expect(r2.kind).toBe('raise');
    if (r2.kind === 'raise') expect(r2.exception.name).toBe('E_HANDLE');
    expect(rec2.calls).toHaveLength(1);
  });

  it('rpc.stale_handle', async () => {
    const rig = replRig({ handleKey: Buffer.alloc(32, 3) });
    const rec = recorder();
    const first = await rig.repl.exec(execReq('return { fs: JSON.parse(JSON.stringify(fs)).$handle, hist: JSON.parse(JSON.stringify(__history__)).$handle }'), rec.bridge);
    expect(first.kind).toBe('return');
    const stale = (first as unknown as { value: { fs: string; hist: string } }).value;
    expect(stale.fs).toMatch(HANDLE_RE);
    // same REPL, next exec: the exec-scoped table no longer knows it
    for (const code of [`return await fs.read({ $handle: ${JSON.stringify(stale.fs)} })`, `return await fs.read({ $handle: ${JSON.stringify(stale.hist)} })`]) {
      const r = await rig.repl.exec(execReq(code), rec.bridge);
      expect(r.kind, code).toBe('raise');
      if (r.kind === 'raise') expect(r.exception.name, code).toBe('E_HANDLE');
    }
    // planted back as a value binding (e.g. via a checkpoint) it is still dead
    const viaBinding = await rig.repl.exec(
      execReq('return await old.len()', { ...FILES, old: { kind: 'value', value: { $handle: stale.fs } as never, provenance: { src: 'checkpoint', trust: 'untrusted' } } }),
      rec.bridge,
    );
    expect(viaBinding.kind).toBe('raise');
    if (viaBinding.kind === 'raise') expect(viaBinding.exception.name).toBe('E_HANDLE');
    // a new REPL with the SAME run key material derives its own MAC key: old handles never survive reconstruction
    const rig2 = replRig({ handleKey: Buffer.alloc(32, 3) });
    const r3 = await rig2.repl.exec(execReq(`return await fs.read({ $handle: ${JSON.stringify(stale.fs)} })`), rec.bridge);
    expect(r3.kind).toBe('raise');
    if (r3.kind === 'raise') expect(r3.exception.name).toBe('E_HANDLE');
    expect(rec.calls).toHaveLength(0);
  });

  it('rpc.oversized_frame', async () => {
    // child side: a 2 MiB argument never reaches the bridge
    const rig = replRig();
    const rec = recorder();
    const r = await rig.repl.exec(execReq("return await fs.write('a', 'x'.repeat(2 * 1024 * 1024))"), rec.bridge);
    expect(r.kind).toBe('raise');
    if (r.kind === 'raise') expect(r.exception.name).toBe('E_FRAME');
    expect(rec.calls).toHaveLength(0);
    // deep nesting is refused the same way
    const deep = await rig.repl.exec(execReq("let v = 1; for (let i = 0; i < 64; i++) v = [v]; return await fs.write('a', v)"), rec.bridge);
    expect(deep.kind).toBe('raise');
    expect(rec.calls).toHaveLength(0);
    // supervisor side: an oversized line is refused before any parse (decodeFrame and the streaming reader)
    const parse = vi.fn(JSON.parse);
    const big = Buffer.from(JSON.stringify({ t: 'call', callId: 'c1', handle: 'h1.r.1.0123456789abcdef', method: 'read', args: ['x'.repeat(2 * 1024 * 1024)] }));
    expect(() => decodeFrame(big, parse)).toThrow(FrameError);
    expect(parse).not.toHaveBeenCalled();
    const lines: Buffer[] = [];
    const errors: FrameError[] = [];
    const reader = new FrameReader((l) => lines.push(l), (e) => errors.push(e));
    // fed in small chunks with no newline: the buffer must stop growing at the cap
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    for (let i = 0; i < 40; i++) reader.push(chunk);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe('E_FRAME');
    expect(lines).toHaveLength(0);
    expect(RPC_LIMITS.maxFrameBytes).toBe(1024 * 1024);
  });

  it('rpc.widen_caps', async () => {
    const onInvoke = vi.fn(async () => 'ran');
    const rig = replRig({ capabilities: CAPS, onInvoke });
    const rec = recorder();
    for (const narrow of ["{ tools: ['files', 'shell'] }", '{ limits: { usd: 50 } }', '{ limits: { calls: 1e9 } }', '{ depth: 3 }', "{ tools: ['__invoke__'] }"]) {
      const r = await rig.repl.exec(execReq(`return await invoke({ task: 'x' }, { narrow: ${narrow} })`), rec.bridge);
      expect(r.kind, narrow).toBe('raise');
      if (r.kind === 'raise') expect(r.exception.name, narrow).toMatch(/E_DENIED|E_FRAME/);
    }
    expect(onInvoke).not.toHaveBeenCalled();

    // through the real invoke tree: a child asking for a tool its parent does not have never runs
    const root = tmp('tecera-adv-widen-');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;\n');
    const replRoot = tmp('tecera-adv-widen-repl-');
    chmodSync(replRoot, 0o711);
    const factory: ReplFactory = (ctx) => new ChildProcessRepl({ runId: ctx.runId, sandbox: SANDBOX, capabilities: ctx.capabilities, onInvoke: ctx.callbacks.onInvoke, onCheckpoint: ctx.callbacks.onCheckpoint, tmpRoot: replRoot });
    const caps: CapabilitySet = { tools: ['read', 'listFiles'], paths: { read: ['**'], write: [], protected: [] }, network: 'none', limits: { usd: 1, tokens: 100_000, calls: 50, wallMs: 60_000, depth: 4, iterations: 6 } };
    const parent = js(`let r; try { r = await invoke({}, { output: {}, narrow: { tools: ['read', 'edit'] } }); } catch (e) { r = { refused: String(e.message || e) }; }\nreturn r;`);
    const llm = new FakeLLM([parent, js('return { parentTurn2: true }')]);
    const broker = new Broker({ tools: [createReadTool(), createListFilesTool()], runId: 'run_widen', worktree: root, capabilities: caps });
    const inputs: Inputs = { goal: { kind: 'value', value: { statement: 'probe' }, provenance: { src: 'goal', trust: 'trusted' } } };
    const out = await invoke(inputs, { output: { type: 'object' } as JsonObject, hooks: [], llm, repl: factory, broker, run: { runId: 'run_widen', invokeId: 'inv_widen', depth: 0 }, capabilities: caps });
    expect(out).toMatchObject({ kind: 'returned', value: { parentTurn2: true } });
    // the widening request killed the parent's exec (a violation, not a catchable error) and no child ever ran:
    // both model requests are the parent's (depth 0), and the second one reports the rejection
    expect(llm.requests).toHaveLength(2);
    for (const rq of llm.requests) expect(rq.messages.map((m) => m.content).join('\n')).toMatch(/### __depth__ \(value, src=system, trusted\)\n0\b/);
    expect(llm.requests[1]!.messages.at(-1)!.content).toMatch(/E_DENIED[\s\S]*rejected, not clamped/);
  });
});
