import { type ChildProcess, type spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CapabilitySet, ExecRequest, ExecResult, Inputs, Json, Repl, ToolBridge, ToolContext, ToolRequest, ToolResult, VerifyRunner } from '@tecera/contracts';
import { Broker } from '../broker/broker.js';
import { FakeLedger, FakeLLM, liveWriteGuard } from '../invoke/fakes.js';
import { invoke, isTainted } from '../invoke/invoke.js';
import { createEditTool } from '../tools/edit.js';
import { markWorktreeTainted, worktreeTaint } from '../tools/paths.js';
import { createReadTool } from '../tools/read.js';
import { createRunVerifyTool } from '../tools/runVerify.js';
import { ChildProcessRepl, quarantineWorktree, releaseWorktreeQuarantine, listWorktreeQuarantines, ProcessVerifyRunner, worktreeQuarantine, type ChildProcessReplOptions, type SandboxEvidence } from './index.js';

/**
 * Codex sprint-3 sandbox missing tests: worktree reuse through a fresh REPL after taint (process-wide
 * worktree quarantine shared with the verify runner), durable taint evidence, and deterministic delivery of
 * multiple call frames in ONE stdout chunk (a scripted child via the spawn seam).
 */

const sandbox = { profile: 'process' as const, isolation: 'node' as const, memoryMb: 128, execTimeoutSec: 10, envAllowlist: ['PATH', 'HOME'] };
const files: Inputs = { fs: { kind: 'handle', id: 'files', methods: ['read', 'write'], description: 'repo files' } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ok = (rq: ToolRequest, value: Json): ToolResult => ({ callId: rq.callId, ok: true, value, provenance: { src: `tool:${rq.tool}`, trust: 'untrusted' }, truncated: false });
let execNo = 0;
const req = (code: string, timeoutMs = 5_000): ExecRequest => ({ execNo: ++execNo, code, bindings: files, timeoutMs });
const repl = (extra: Partial<ChildProcessReplOptions> = {}) => new ChildProcessRepl({ runId: 'run_q', sandbox, ...extra });
const isRoot = typeof process.geteuid === 'function' && process.geteuid() === 0;

let wt: string;
let other: string;
beforeAll(async () => {
  wt = await mkdtemp(join(tmpdir(), 'tecera-q-wt-'));
  other = await mkdtemp(join(tmpdir(), 'tecera-q-other-'));
  chmodSync(wt, 0o777);
});
afterAll(async () => {
  await rm(wt, { recursive: true, force: true });
  await rm(other, { recursive: true, force: true });
});

describe('worktree quarantine survives the REPL instance', () => {
  it('a taint on worktree W refuses a FRESH REPL on W (and a verify of W) until the supervisor clears it', async () => {
    const ev: SandboxEvidence[] = [];
    let mutations = 0;
    const slowWriter = (async (rq: ToolRequest) => {
      await sleep(700); // ignores the abort: keeps writing after the exec reports
      mutations++;
      return ok(rq, 'done');
    }) as ToolBridge;
    const a = repl({ worktree: wt, drainMs: 100, onEvidence: (e) => void ev.push(e) });
    const r = await a.exec(req("fs.write('src/a.ts', 'x'); return 1"), slowWriter);
    expect(r.kind === 'raise' && r.exception.name).toBe('E_TAINTED');
    expect(r.tainted?.recorded).toBe(true); // the taint record reached the sink before the exec reported
    expect(ev.find((e) => e.kind === 'sandbox.tainted')?.body).toMatchObject({ worktree: wt });
    expect(worktreeQuarantine(wt)?.source).toBe('repl');
    expect(worktreeQuarantine(join(wt, 'src'))).toBeDefined(); // a path inside is covered too

    // A fresh REPL instance on the same worktree: refuses, nothing runs, the bridge is never called.
    let calls = 0;
    const b = repl({ worktree: wt });
    const rb = await b.exec(req("await fs.read('x'); return 2"), async (rq) => {
      calls++;
      return ok(rq, 1);
    });
    expect(rb.kind === 'raise' && rb.exception.name).toBe('E_TAINTED');
    expect(rb.kind === 'raise' && rb.exception.message).toMatch(/worktree quarantined/);
    expect(rb.tainted?.outstanding.length).toBeGreaterThan(0);
    expect(calls).toBe(0);

    // Another worktree is unaffected.
    const c = repl({ worktree: other });
    expect((await c.exec(req('return 3'), async (rq) => ok(rq, 1))).kind).toBe('return');

    // The verify runner refuses a tainted cwd before anything runs.
    const runner = new ProcessVerifyRunner({ ...(isRoot ? { allowRoot: true } : {}), containment: { cgroupBase: null, pidns: null }, allowWeakContainment: true });
    const v = await runner.run({ cwd: wt, command: 'echo ran > verify-ran.txt', timeoutSec: 5, envAllowlist: ['PATH'] });
    expect(v.exitCode).toBeNull();
    expect(v.reason).toMatch(/worktree tainted/);
    expect(v.tainted).toBeDefined();
    expect(existsSync(join(wt, 'verify-ran.txt'))).toBe(false);

    // Clearing needs an attestation; afterwards a fresh REPL runs again.
    expect(() => releaseWorktreeQuarantine(wt, undefined as unknown as { by: string; reason: string })).toThrow(/attestation/);
    await sleep(800);
    expect(mutations).toBe(1);
    expect(releaseWorktreeQuarantine(wt, { by: 'test-supervisor', reason: 'abandoned write settled; tree re-checked' })).toBe(true);
    expect(worktreeQuarantine(wt)).toBeUndefined();
    expect((await repl({ worktree: wt }).exec(req('return 4'), async (rq) => ok(rq, 1))).kind).toBe('return');
  }, 20_000);

  it('a taint record that cannot be written in time is reported (recorded: false) for the caller to persist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tecera-q-rec-'));
    try {
      const r0 = repl({ worktree: dir, drainMs: 100, sinkTimeoutMs: 150, onEvidence: (e) => (e.kind === 'sandbox.tainted' ? new Promise<void>(() => undefined) : undefined) });
      const r = await r0.exec(req("fs.write('a', 'b'); return 1"), () => new Promise<ToolResult>(() => undefined));
      expect(r.kind === 'raise' && r.exception.name).toBe('E_TAINTED');
      expect(r.tainted?.recorded).toBe(false);
      expect(r.trace.handlerFailures.join(' ')).toMatch(/taint evidence was not recorded/);
      expect(worktreeQuarantine(dir)).toBeDefined();
    } finally {
      releaseWorktreeQuarantine(dir, { by: 'test', reason: 'cleanup' });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a verify run whose leader survives taints its cwd: the next verify there refuses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tecera-q-v-'));
    try {
      let pid = 4_194_000;
      while (existsSync(`/proc/${pid}`)) pid--;
      const fake = (() => {
        const c = new EventEmitter() as unknown as ChildProcess;
        Object.assign(c, { pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref: () => undefined });
        return c;
      }) as unknown as typeof spawn;
      const ident = isRoot ? { allowRoot: true } : {};
      const containment = { cgroupBase: null, pidns: null };
      const stuck = new ProcessVerifyRunner({ ...ident, containment, allowWeakContainment: true, drainMs: 100, reapMs: 100, testSpawn: fake });
      const r1 = await stuck.run({ cwd: dir, command: 'true', timeoutSec: 0.2, envAllowlist: ['PATH'] });
      expect(r1.tainted).toBeDefined();
      expect(worktreeQuarantine(dir)?.source).toBe('verify');
      const r2 = await new ProcessVerifyRunner({ ...ident, containment, allowWeakContainment: true }).run({ cwd: dir, command: 'echo ran > ran.txt', timeoutSec: 5, envAllowlist: ['PATH'] });
      expect(r2.exitCode).toBeNull();
      expect(r2.reason).toMatch(/worktree tainted/);
      expect(existsSync(join(dir, 'ran.txt'))).toBe(false);
      // A REPL on that worktree refuses too.
      const rr = await repl({ worktree: dir }).exec(req('return 1'), async (rq) => ok(rq, 1));
      expect(rr.kind === 'raise' && rr.exception.name).toBe('E_TAINTED');
    } finally {
      releaseWorktreeQuarantine(dir, { by: 'test', reason: 'cleanup' });
      await rm(dir, { recursive: true, force: true });
    }
    expect(listWorktreeQuarantines().filter((t) => t.path.includes('tecera-q-v-'))).toEqual([]);
  });
});

describe('deterministic delivery: several call frames in ONE stdout chunk', () => {
  /** A scripted child: hello, then (on the program) five identical call frames in one chunk, then the result. */
  function scripted(seen: { chunks: number; replies: string[] }): typeof spawn {
    let pid = 4_193_000;
    while (existsSync(`/proc/${pid}`)) pid--;
    return (() => {
      const c = new EventEmitter() as unknown as ChildProcess & { exitCode: number | null; signalCode: string | null };
      const stdout = new PassThrough();
      let buf = '';
      let execNoSeen = 0;
      const stdin = new Writable({
        write(chunk: Buffer, _enc, cb) {
          buf += chunk.toString();
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            const f = JSON.parse(line) as { t: string; execNo?: number; bindings?: Array<{ name: string; handle?: string }>; callId?: string };
            if (f.t === 'program') {
              execNoSeen = f.execNo!;
              const h = f.bindings!.find((b) => b.name === 'fs')!.handle!;
              const frames = [1, 2, 3, 4, 5].map((i) => JSON.stringify({ t: 'call', callId: `k${i}`, handle: h, method: i > 3 ? 'write' : 'read', args: ['same'] })).join('\n') + '\n';
              seen.chunks++;
              stdout.write(Buffer.from(frames)); // exactly one chunk
            } else if (f.t === 'reply' || f.t === 'error') {
              seen.replies.push(f.callId!);
              if (seen.replies.length === 5) {
                // Like a real child: the result follows the replies a little later, never in the same tick.
                setTimeout(() => stdout.write(JSON.stringify({ t: 'result', execNo: execNoSeen, result: { kind: 'return', value: 1, output: '' }, printed: '' }) + '\n'), 20);
                setTimeout(() => {
                  c.exitCode = 0;
                  c.emit('exit', 0, null);
                  c.emit('close', 0, null);
                }, 40);
              }
            }
          }
          cb();
        },
      });
      Object.assign(c, { pid, stdin, stdout, stderr: new PassThrough(), exitCode: null, signalCode: null, unref: () => undefined });
      setTimeout(() => stdout.write(JSON.stringify({ t: 'hello', protocolVersion: 1 }) + '\n'), 5);
      return c;
    }) as unknown as typeof spawn;
  }

  it('five identical requests delivered in a single chunk get five distinct call ids and idempotency keys', async () => {
    const seen = { chunks: 0, replies: [] as string[] };
    const reqs: ToolRequest[] = [];
    const r = await repl({ testSpawn: scripted(seen) }).exec(req('return 1'), async (rq) => {
      reqs.push(rq);
      await sleep(10);
      return ok(rq, 'x');
    });
    expect(seen.chunks).toBe(1);
    expect(r.kind, JSON.stringify(r.kind === 'raise' ? r.exception : null)).toBe('return');
    expect(reqs).toHaveLength(5);
    expect(reqs.map((q) => q.callId).sort()).toEqual([1, 2, 3, 4, 5].map((n) => `x${execNo}-c${n}`).sort());
    expect(new Set(reqs.map((q) => q.idemKey)).size).toBe(5);
    expect(seen.replies.sort()).toEqual(['k1', 'k2', 'k3', 'k4', 'k5']);
  });
});

describe('one quarantine registry: a taint recorded by either side is honoured by both', () => {
  const capabilities: CapabilitySet = { tools: ['edit', 'read', 'runVerify'], paths: { read: ['**'], write: ['src/**'], protected: [] }, network: 'none', limits: { usd: 1, tokens: 1000, calls: 10, wallMs: 1000, depth: 2, iterations: 5 } };
  const call = (...args: Json[]): ToolRequest => ({ callId: 'c1', tool: 't', method: 'call', args, idemKey: 'k' });
  const ident = isRoot ? { allowRoot: true } : {};
  const runner = () => new ProcessVerifyRunner({ ...ident, containment: { cgroupBase: null, pidns: null }, allowWeakContainment: true });
  let dir: string;
  let ctx: ToolContext;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tecera-q-one-'));
    chmodSync(dir, 0o777);
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src/x.ts'), 'ORIGINAL');
    ctx = { runId: 'r1', worktree: dir, capabilities, fencingToken: 1 };
  });
  afterEach(async () => {
    releaseWorktreeQuarantine(dir, { by: 'test', reason: 'cleanup' });
    await rm(dir, { recursive: true, force: true });
  });

  it('after a verify (or REPL) taint the file tools, the verify tool and the broker refuse the worktree', async () => {
    let ran = 0;
    const stub = { run: async () => (ran++, { exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 1, stdout: '', stderr: '', truncated: false }) } as unknown as VerifyRunner;
    quarantineWorktree(dir, { source: 'verify', reason: 'descendants survived: 1 process(es)', outstanding: [], processes: [4242] });
    const w = await createEditTool().call(call({ path: 'src/x.ts', content: 'WRITTEN' }), ctx, liveWriteGuard());
    expect(w.ok).toBe(false);
    expect(w.error?.message).toMatch(/quarantined/);
    expect(await readFile(join(dir, 'src/x.ts'), 'utf8')).toBe('ORIGINAL');
    expect(worktreeTaint(dir)).toMatch(/descendants survived/);
    expect(worktreeTaint(join(dir, 'src'))).toMatch(/descendants survived/);
    const rd = await createReadTool().call(call('src/x.ts'), ctx);
    expect(rd.error?.message).toMatch(/quarantined/);
    const v = await createRunVerifyTool({ runner: stub, command: 'true', timeoutSec: 5 }).call(call(), ctx, liveWriteGuard());
    expect(v.error?.message).toMatch(/quarantined/);
    expect(ran).toBe(0);
    const broker = new Broker({ tools: [createEditTool()], runId: 'r1', worktree: dir, capabilities, fencingToken: 1, guard: liveWriteGuard() });
    expect(broker.tainted).toMatchObject({ reason: expect.stringMatching(/descendants survived/), worktree: dir });
    // Released by the supervisor: the same call writes.
    expect(releaseWorktreeQuarantine(dir, { by: 'test', reason: 'nothing was alive' })).toBe(true);
    expect(worktreeTaint(dir)).toBeNull();
    expect((await createEditTool().call(call({ path: 'src/x.ts', content: 'WRITTEN' }), ctx, liveWriteGuard())).ok).toBe(true);
  });

  it('after a broker (file tool) taint a real verify run and a fresh REPL on the worktree refuse', async () => {
    markWorktreeTainted(dir, 'edit: unresolved writer at drain timeout');
    markWorktreeTainted(dir, 'edit: unresolved writer at drain timeout');
    const v = await runner().run({ cwd: dir, command: 'echo ran > ran.txt', timeoutSec: 5, envAllowlist: ['PATH'] });
    expect(v.exitCode).toBeNull();
    expect(worktreeTaint(dir)).toBe('edit: unresolved writer at drain timeout'); // the same reason is recorded once
    expect(worktreeQuarantine(dir)).toMatchObject({ source: 'tools', reason: 'edit: unresolved writer at drain timeout' });
    expect(v.reason).toMatch(/worktree tainted: tools work/);
    expect(v.tainted).toBeDefined();
    expect(existsSync(join(dir, 'ran.txt'))).toBe(false);
    const rr = await repl({ worktree: dir }).exec(req('return 1'), async (rq) => ok(rq, 1));
    expect(rr.kind === 'raise' && rr.exception.name).toBe('E_TAINTED');
    // Control: once released, the same verify run executes.
    releaseWorktreeQuarantine(dir, { by: 'test', reason: 'the writer settled' });
    const again = await runner().run({ cwd: dir, command: 'echo ran > ran.txt', timeoutSec: 5, envAllowlist: ['PATH'] });
    expect(again.exitCode).toBe(0);
    expect(existsSync(join(dir, 'ran.txt'))).toBe(true);
  }, 20_000);

  it('a verify runner that reports survivors through the verify tool quarantines the worktree for the file tools', async () => {
    const survivors = { run: async () => ({ exitCode: null, signal: null, timedOut: false, cancelled: true, durationMs: 1, stdout: '', stderr: '', truncated: false, tainted: { reason: 'descendants survived: 2 process(es)', processes: [7, 8] } }) } as unknown as VerifyRunner;
    const v = await createRunVerifyTool({ runner: survivors, command: 'true', timeoutSec: 5 }).call(call(), ctx, liveWriteGuard());
    expect((v.value as { passed?: boolean } | undefined)?.passed ?? false).toBe(false);
    expect(worktreeTaint(dir)).toMatch(/descendants survived/);
    expect((await createEditTool().call(call({ path: 'src/x.ts', content: 'WRITTEN' }), ctx, liveWriteGuard())).ok).toBe(false);
    expect(await readFile(join(dir, 'src/x.ts'), 'utf8')).toBe('ORIGINAL');
  });

  it('an exec whose REPL reports unresolved work quarantines the broker worktree even when the REPL was built without one', async () => {
    const taintedRepl: Repl = {
      exec: async () => ({ kind: 'raise', exception: { name: 'E_TAINTED', message: 'worktree tainted' }, printed: '', tainted: { reason: 'process group survived SIGKILL', outstanding: ['x1-c1'], processes: [4242] } }) as unknown as ExecResult & { printed: string },
      dispose: async () => undefined,
    };
    const ledger = new FakeLedger();
    const broker = new Broker({ tools: [createEditTool()], runId: 'run_q', worktree: dir, capabilities, fencingToken: 1, guard: liveWriteGuard() });
    const llm = new FakeLLM(['```js\nconsole.log(1)\n```', '```js\nreturn {};\n```']);
    const out = await invoke({}, { output: { type: 'object' }, hooks: [], llm, repl: () => taintedRepl, broker, ledger, run: { runId: 'run_q', invokeId: 'inv_q', depth: 0 } });
    expect(out.kind).toBe('aborted');
    expect(isTainted(out)).toBe(true);
    expect(llm.requests).toHaveLength(1); // no second turn on a tainted worktree
    expect(worktreeQuarantine(dir)).toMatchObject({ source: 'repl', processes: [4242] });
    expect(worktreeTaint(dir)).toMatch(/process group survived SIGKILL/);
    // Recorded for a later process too (StepWorker reads exec.tainted evidence of the run).
    expect((await ledger.listEvidence('run_q', 'exec.tainted')).map((e) => e.body)).toEqual([expect.objectContaining({ worktree: dir, reason: expect.stringMatching(/process group survived SIGKILL/) })]);
    expect((await createEditTool().call(call({ path: 'src/x.ts', content: 'WRITTEN' }), ctx, liveWriteGuard())).ok).toBe(false);
  });
});
