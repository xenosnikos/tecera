import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecRequest, Inputs, Json, ToolBridge, ToolRequest, ToolResult } from '@tecera/contracts';
import { ChildProcessRepl, SETTLE_LOG_ENV, listWorktreeQuarantines, releaseWorktreeQuarantine, worktreeQuarantine, type ChildProcessReplOptions, type ExecOutput, type SandboxEvidence } from './index.js';

/**
 * How an exec ended, exactly. Every ending that is not a program result records its cause, the phase it was
 * in and whether the supervisor really killed the child ('sandbox.kill') or not ('sandbox.ended'); startup
 * (spawn until hello) is bounded apart from the program's execution budget. Scripted children (the spawn
 * seam) deliver the orderings deterministically; real children prove the kill is a kill.
 */

const sandbox = { profile: 'process' as const, isolation: 'node' as const, memoryMb: 128, execTimeoutSec: 10, envAllowlist: ['PATH', 'HOME'] };
const files: Inputs = { fs: { kind: 'handle', id: 'files', methods: ['read', 'write'], description: 'repo files' } };
const ok = (rq: ToolRequest, value: Json): ToolResult => ({ callId: rq.callId, ok: true, value, provenance: { src: `tool:${rq.tool}`, trust: 'untrusted' }, truncated: false });
const bridge: ToolBridge = async (rq) => ok(rq, 1);
let execNo = 1000;
const req = (code = 'return 1', timeoutMs = 5_000): ExecRequest => ({ execNo: ++execNo, code, bindings: files, timeoutMs });

/** A REPL whose evidence is collected; 'isolation.degraded' (written on the first exec) is kept apart. */
function rig(extra: Partial<ChildProcessReplOptions> = {}) {
  const evidence: SandboxEvidence[] = [];
  const repl = new ChildProcessRepl({ runId: 'run_settle', sandbox, onEvidence: (e) => void evidence.push(e), ...extra });
  const endings = () => evidence.filter((e) => e.kind === 'sandbox.kill' || e.kind === 'sandbox.ended');
  return { repl, evidence, endings };
}

interface Fake {
  /** Write one frame to the fake child's stdout. */
  send(frame: Record<string, unknown>): void;
  hello(): void;
  result(execNo: number, value: Json): void;
  /** The child process is gone ('exit'): its status is known, its pipes may still hold data. */
  exit(code: number | null, signal?: NodeJS.Signals | null): void;
  /** Its stdio has closed ('close'). */
  close(code: number | null, signal?: NodeJS.Signals | null): void;
  stderr(text: string): void;
  /** Frames the supervisor wrote to the child's stdin, parsed. */
  received: Array<Record<string, unknown>>;
}

/** A pid no process has: the kill the finalizer always attempts must reach nothing. */
function unusedPid(): number {
  for (let p = 4_192_000; p > 4_000_000; p--) if (!existsSync(`/proc/${p}`)) return p;
  throw new Error('no unused pid');
}

/**
 * A scripted child through the spawn seam. `script` runs at spawn; `onProgram` when the program frame arrives.
 * It has no process behind it: when the supervisor ends an exec it has not left, the kill finds nothing and
 * the finalizer waits out its reap bound (3 s) for an exit that never comes; such tests take that long.
 */
function scripted(script: (f: Fake) => void, onProgram?: (f: Fake, program: { execNo: number; bindings: Array<{ name: string; handle?: string }> }) => void): typeof spawn {
  return (() => {
    const c = new EventEmitter() as unknown as ChildProcess & { exitCode: number | null; signalCode: string | null };
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const fake: Fake = {
      received: [],
      send: (frame) => void stdout.write(`${JSON.stringify(frame)}\n`),
      hello: () => fake.send({ t: 'hello', protocolVersion: 1 }),
      result: (n, value) => fake.send({ t: 'result', execNo: n, result: { kind: 'return', value, output: '' }, printed: '' }),
      exit: (code, signal = null) => {
        c.exitCode = code;
        c.signalCode = signal;
        c.emit('exit', code, signal);
      },
      close: (code, signal = null) => void c.emit('close', code, signal),
      stderr: (text) => void stderr.write(text),
    };
    let buf = '';
    const stdin = new Writable({
      write(chunk: Buffer, _enc, cb) {
        buf += chunk.toString();
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          const f = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
          buf = buf.slice(nl + 1);
          fake.received.push(f);
          if (f.t === 'program') onProgram?.(fake, f as unknown as { execNo: number; bindings: Array<{ name: string; handle?: string }> });
        }
        cb();
      },
    });
    Object.assign(c, { pid: unusedPid(), stdin, stdout, stderr, exitCode: null, signalCode: null, unref: () => undefined, kill: () => true });
    setImmediate(() => script(fake));
    return c;
  }) as unknown as typeof spawn;
}

const later = (ms: number, fn: () => void) => void setTimeout(fn, ms);
const raised = (o: ExecOutput): { name: string; message: string } => (o.kind === 'raise' ? o.exception : { name: `(${o.kind})`, message: '' });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    releaseWorktreeQuarantine(d, { by: 'test', reason: 'cleanup' });
    rmSync(d, { recursive: true, force: true });
  }
  delete process.env[SETTLE_LOG_ENV];
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(d, 0o777);
  dirs.push(d);
  return d;
}

describe('ordering: exit, buffered result, close', () => {
  it("'exit' delivered BEFORE the buffered result and 'close': the result is processed; no kill, no crash and no taint is invented", async () => {
    for (let i = 0; i < 3; i++) {
      const r = rig({
        testSpawn: scripted(
          (f) => f.hello(),
          (f, p) => {
            // The process is gone first; its last frame is still in the pipe; the pipes close last.
            f.exit(0);
            later(20, () => f.result(p.execNo, 7));
            later(60, () => f.close(0));
          },
        ),
      });
      const out = await r.repl.exec(req(), bridge);
      expect(out, JSON.stringify(raised(out))).toMatchObject({ kind: 'return', value: 7 });
      expect(out.trace.exit).toEqual({ code: 0, signal: null });
      expect(out.trace.killed).toBeUndefined();
      expect(out.tainted).toBeUndefined();
      expect(out.trace.settlement).toMatchObject({ cause: 'result', phase: 'execution', killed: false, signalSent: false, gone: true, exit: { code: 0, signal: null } });
      expect(out.trace.settlement!.at.exit!).toBeLessThanOrEqual(out.trace.settlement!.at.result!);
      expect(r.endings()).toEqual([]);
      expect(await r.repl.shutdown()).toEqual({ clean: true, tainted: false, outstanding: [], processes: [] });
    }
  });

  it("'close' that arrives with no result at all, after hello: 'exit-before-result', recorded as ended (nothing was killed)", async () => {
    const r = rig({
      testSpawn: scripted(
        (f) => f.hello(),
        (f) => {
          f.stderr('segfault in addon\n');
          later(10, () => {
            f.exit(7);
            f.close(7);
          });
        },
      ),
    });
    const out = await r.repl.exec(req(), bridge);
    expect(raised(out)).toMatchObject({ name: 'E_CRASH', message: expect.stringMatching(/child exited \(code=7, signal=null\) before returning a result: segfault in addon/) });
    expect(out.trace.killed).toBeUndefined();
    expect(out.trace.settlement).toMatchObject({ cause: 'exit-before-result', phase: 'execution', killed: false, signalSent: false, exit: { code: 7, signal: null }, stderrTail: 'segfault in addon' });
    expect(r.endings().map((e) => [e.kind, (e.body as { cause: string }).cause])).toEqual([['sandbox.ended', 'exit-before-result']]);
    expect(r.endings()[0]!.body).toMatchObject({ signalled: false, phase: 'execution', exit: { code: 7, signal: null } });
    expect(out.tainted).toBeUndefined();
  });
});

describe('startup is a phase of its own', () => {
  it('a hello that arrives later than the execution budget still runs the program: load before hello is not charged to it', async () => {
    const r = rig({
      startupTimeoutMs: 5_000,
      testSpawn: scripted(
        (f) => later(400, () => f.hello()),
        (f, p) => {
          f.result(p.execNo, 'ran');
          later(5, () => {
            f.exit(0);
            f.close(0);
          });
        },
      ),
    });
    // 150 ms of execution budget, 400 ms of startup: with one timer from the spawn this was E_TIMEOUT.
    const out = await r.repl.exec(req('return 1', 150), bridge);
    expect(out, JSON.stringify(raised(out))).toMatchObject({ kind: 'return', value: 'ran' });
    expect(out.trace.settlement).toMatchObject({ cause: 'result', limits: { startupMs: 5_000, execMs: 150, deadlineMs: 5_150 } });
    expect(out.trace.settlement!.at.hello!).toBeGreaterThanOrEqual(390);
    expect(r.endings()).toEqual([]);
  });

  it('hello never arrives and the child stays up: startup-timeout, in the startup phase, naming that the program did not run', async () => {
    const r = rig({ startupTimeoutMs: 150, testSpawn: scripted(() => undefined) });
    const t0 = Date.now();
    const out = await r.repl.exec(req('return 1', 9_000), bridge);
    expect(Date.now() - t0).toBeLessThan(8_000); // the startup bound, not the 9 s execution budget
    expect(raised(out)).toMatchObject({ name: 'E_TIMEOUT', message: expect.stringMatching(/did not start within 150 ms \(no hello\).*The program did not run/) });
    expect(out.trace.settlement).toMatchObject({ cause: 'startup-timeout', phase: 'startup', limits: { startupMs: 150, execMs: 9_000, deadlineMs: 9_150 } });
    expect(out.trace.settlement!.at.hello).toBeUndefined();
    expect(out.trace.settlement!.at.program).toBeUndefined();
    // the scripted child has no process behind it: no signal was delivered, so this is not a kill
    expect(out.trace.killed).toBeUndefined();
    expect(r.endings().map((e) => [e.kind, (e.body as { cause: string }).cause])).toEqual([['sandbox.ended', 'startup-timeout']]);
  }, 30_000);

  it('a REAL child that never says hello is killed at the startup bound: sandbox.kill, signalled, cause startup-timeout', async () => {
    const r = rig({ startupTimeoutMs: 300, testSpawn: ((_cmd: string, _args: string[], o: Parameters<typeof spawn>[2]) => spawn('/bin/sleep', ['30'], { ...o, env: {}, cwd: '/' })) as unknown as typeof spawn });
    const out = await r.repl.exec(req('return 1', 5_000), bridge);
    expect(raised(out).name).toBe('E_TIMEOUT');
    expect(out.trace.killed).toEqual({ cause: 'startup-timeout', gone: true });
    expect(out.trace.settlement).toMatchObject({ cause: 'startup-timeout', phase: 'startup', killed: true, signalSent: true, gone: true, exit: { code: null, signal: 'SIGKILL' } });
    expect(out.trace.settlement!.at.kill!).toBeGreaterThanOrEqual(out.trace.settlement!.at.settle!);
    expect(r.endings().map((e) => [e.kind, (e.body as { cause: string; signalled: boolean }).cause, (e.body as { signalled: boolean }).signalled])).toEqual([['sandbox.kill', 'startup-timeout', true]]);
  }, 20_000);

  it('hello never arrives because the child exited (a wrapper that failed): exit-before-hello with its status and stderr, never a kill', async () => {
    // scripted: status and stderr are exact
    const r = rig({
      testSpawn: scripted((f) => {
        f.stderr('Failed to start transient scope unit: Connection timed out\n');
        later(10, () => {
          f.exit(1);
          f.close(1);
        });
      }),
    });
    const out = await r.repl.exec(req(), bridge);
    expect(raised(out)).toMatchObject({ name: 'E_CRASH', message: expect.stringMatching(/exited \(code=1, signal=null\) before it started \(no hello\): Failed to start transient scope unit.*The program did not run/) });
    expect(out.trace.killed).toBeUndefined();
    expect(out.trace.settlement).toMatchObject({ cause: 'exit-before-hello', phase: 'startup', killed: false, exit: { code: 1, signal: null }, stderrTail: expect.stringContaining('Connection timed out') });
    expect(r.endings().map((e) => [e.kind, (e.body as { cause: string }).cause])).toEqual([['sandbox.ended', 'exit-before-hello']]);
    // a real process that exits by itself: whatever the sweep finds, it is not reported as a kill
    const real = rig({ testSpawn: ((_cmd: string, _args: string[], o: Parameters<typeof spawn>[2]) => spawn('/bin/sh', ['-c', 'echo wrapper-broke >&2; exit 3'], { ...o, env: {}, cwd: '/' })) as unknown as typeof spawn });
    const out2 = await real.repl.exec(req(), bridge);
    expect(raised(out2).name).toBe('E_CRASH');
    expect(out2.trace.killed).toBeUndefined();
    expect(out2.trace.settlement).toMatchObject({ cause: 'exit-before-hello', killed: false, exit: { code: 3, signal: null }, stderrTail: 'wrapper-broke' });
    expect(real.endings().map((e) => e.kind)).toEqual(['sandbox.ended']);
  }, 20_000);

  it('the execution budget counts from hello: a real endless program is killed as a timeout in the execution phase', async () => {
    const r = rig();
    const out = await r.repl.exec(req('while (true) {}', 400), bridge);
    expect(raised(out).name).toBe('E_TIMEOUT');
    expect(out.trace.killed).toEqual({ cause: 'timeout', gone: true });
    const s = out.trace.settlement!;
    expect(s).toMatchObject({ cause: 'timeout', phase: 'execution', killed: true, signalSent: true, exit: { code: null, signal: 'SIGKILL' }, limits: { execMs: 400 } });
    expect(s.at.settle! - s.at.hello!).toBeGreaterThanOrEqual(395); // the whole budget was the program's
    expect(r.endings().map((e) => [e.kind, (e.body as { cause: string }).cause])).toEqual([['sandbox.kill', 'timeout']]);
  }, 20_000);
});

describe('evidence sinks', () => {
  it('a rejected isolation.degraded sink on the first exec: E_INTERNAL with cause evidence-sink-rejected and the sink named; the REPL stays clean', async () => {
    const seen: SandboxEvidence[] = [];
    const r = rig({
      onEvidence: (e) => {
        seen.push(e);
        if (e.kind === 'isolation.degraded') throw new Error('ledger busy');
      },
    });
    const out = await r.repl.exec(req(), bridge);
    expect(raised(out)).toMatchObject({ name: 'E_INTERNAL', message: expect.stringMatching(/evidence sink failed \(isolation\.degraded\): Error: ledger busy/) });
    expect(out.trace.settlement).toMatchObject({ cause: 'evidence-sink-rejected', detail: expect.stringContaining('ledger busy') });
    expect(out.trace.settlement!.sinks!.rejected).toEqual([expect.stringMatching(/-sink:evidence:isolation\.degraded#1$/)]);
    expect(out.trace.settlement!.sinks!.hung).toEqual([]);
    // the ending itself was still recorded (the sink accepts other kinds), under its exact cause
    const ending = seen.find((e) => e.kind === 'sandbox.kill' || e.kind === 'sandbox.ended');
    expect(ending?.body).toMatchObject({ cause: 'evidence-sink-rejected' });
    expect(out.tainted).toBeUndefined();
    expect(await r.repl.shutdown()).toEqual({ clean: true, tainted: false, outstanding: [], processes: [] });
  }, 20_000);

  it('a HUNG isolation.degraded sink: the program result stands as the cause, the exec is E_TAINTED naming the sink, and the taint is genuine', async () => {
    const wt = tmp('tecera-settle-wt-');
    const unrelated = tmp('tecera-settle-other-');
    const r = rig({ worktree: wt, sinkTimeoutMs: 200, drainMs: 100, onEvidence: (e) => (e.kind === 'isolation.degraded' ? new Promise<void>(() => undefined) : undefined) });
    const out = await r.repl.exec(req(), bridge);
    expect(raised(out)).toMatchObject({ name: 'E_TAINTED', message: expect.stringMatching(/1 checkpoint\/evidence sink\(s\) did not settle within 200 ms/) });
    expect(out.trace.settlement).toMatchObject({ cause: 'result', killed: false });
    expect(out.trace.settlement!.sinks).toEqual({ rejected: [], hung: [expect.stringMatching(/-sink:evidence:isolation\.degraded#1$/)] });
    expect(out.trace.settlement!.sinksMs!).toBeGreaterThanOrEqual(190);
    expect(out.tainted?.outstanding).toEqual(out.trace.settlement!.sinks!.hung);
    // genuine taint still taints: this REPL, and a fresh REPL on the same worktree, refuse without running
    const again = await r.repl.exec(req(), bridge);
    expect(raised(again).name).toBe('E_TAINTED');
    expect(again.trace.settlement).toMatchObject({ cause: 'quarantined', phase: 'setup', killed: false });
    const q = worktreeQuarantine(wt);
    expect(q).toMatchObject({ source: 'repl', origin: expect.stringMatching(/^run run_settle exec \d+$/), matched: { relation: 'same' } });
    let ran = 0;
    const fresh = rig({ worktree: wt });
    const refused = await fresh.repl.exec(req(), async (rq) => (ran++, ok(rq, 1)));
    expect(raised(refused)).toMatchObject({ name: 'E_TAINTED', message: expect.stringMatching(/worktree quarantined: repl work on it was left unresolved by run run_settle exec \d+/) });
    expect(ran).toBe(0);
    expect(fresh.endings().map((e) => [e.kind, (e.body as { cause: string }).cause])).toEqual([['sandbox.ended', 'quarantined']]);
    // a path inside the worktree is covered and says which recorded path matched; an unrelated one is not
    expect(worktreeQuarantine(join(wt, 'src'))?.matched).toEqual({ path: q!.path, relation: 'ancestor' });
    expect(worktreeQuarantine(unrelated)).toBeUndefined();
    const elsewhere = await rig({ worktree: unrelated }).repl.exec(req(), bridge);
    expect(elsewhere).toMatchObject({ kind: 'return', value: 1 });
    expect(listWorktreeQuarantines().filter((t) => t.path.includes('tecera-settle-')).map((t) => t.path)).toEqual([q!.path]);
  }, 30_000);
});

describe('late and out-of-order frames', () => {
  it('calls sent after the result are never served: the result stands, the bytes are counted, nothing is recorded as an ending', async () => {
    let served = 0;
    const r = rig({
      testSpawn: scripted(
        (f) => f.hello(),
        (f, p) => {
          const h = p.bindings.find((b) => b.name === 'fs')!.handle!;
          f.result(p.execNo, 'done');
          later(10, () => f.send({ t: 'call', callId: 'late1', handle: h, method: 'write', args: ['a', 'b'] }));
          later(20, () => f.send({ t: 'call', callId: 'late2', handle: h, method: 'write', args: ['c', 'd'] }));
          later(60, () => {
            f.exit(0);
            f.close(0);
          });
        },
      ),
    });
    const out = await r.repl.exec(req(), async (rq) => (served++, ok(rq, 1)));
    expect(out).toMatchObject({ kind: 'return', value: 'done' });
    expect(served).toBe(0);
    expect(out.trace.calls).toEqual([]);
    expect(out.trace.settlement).toMatchObject({ cause: 'result', killed: false });
    expect(out.trace.settlement!.lateStdoutBytes!).toBeGreaterThan(50);
    expect(r.endings()).toEqual([]);
  });

  it('a second hello after the program started is a protocol violation, recorded under that exact cause', async () => {
    const r = rig({ testSpawn: scripted((f) => f.hello(), (f) => later(5, () => f.hello())) });
    const out = await r.repl.exec(req(), bridge);
    expect(raised(out)).toMatchObject({ name: 'E_FRAME', message: 'duplicate hello' });
    expect(out.trace.settlement).toMatchObject({ cause: 'violation:E_FRAME', phase: 'execution' });
    expect(r.endings().map((e) => (e.body as { cause: string }).cause)).toEqual(['violation:E_FRAME']);
    expect(r.evidence.some((e) => e.kind === 'sandbox.violation')).toBe(true);
  }, 30_000);

  it('a frame before hello is a violation in the startup phase', async () => {
    const r = rig({ testSpawn: scripted((f) => f.send({ t: 'log', level: 'log', text: 'early' })) });
    const out = await r.repl.exec(req(), bridge);
    expect(raised(out)).toMatchObject({ name: 'E_FRAME', message: 'expected hello, got log' });
    expect(out.trace.settlement).toMatchObject({ cause: 'violation:E_FRAME', phase: 'startup' });
  }, 30_000);
});

describe('cancellation and callbacks', () => {
  it('cancelled before start: cause cancel in the setup phase, recorded as ended; cancelled while running: the real child is killed', async () => {
    const pre = new AbortController();
    pre.abort();
    const r = rig();
    const early = await r.repl.exec(req(), bridge, pre.signal);
    expect(raised(early).name).toBe('E_CANCELLED');
    expect(early.trace.settlement).toMatchObject({ cause: 'cancel', phase: 'setup', killed: false, signalSent: false });
    expect(r.endings().map((e) => [e.kind, (e.body as { cause: string }).cause])).toEqual([['sandbox.ended', 'cancel']]);

    const ac = new AbortController();
    const r2 = rig({ cancelGraceMs: 100 });
    const p = r2.repl.exec(req("await fs.read('x'); while (true) {}", 10_000), async (rq) => (setTimeout(() => ac.abort(), 20), ok(rq, 1)), ac.signal);
    const out = await p;
    expect(raised(out).name).toBe('E_CANCELLED');
    expect(out.trace.killed).toEqual({ cause: 'cancel', gone: true });
    expect(out.trace.settlement).toMatchObject({ cause: 'cancel', phase: 'execution', killed: true, exit: { code: null, signal: 'SIGKILL' } });
    expect(r2.endings().map((e) => [e.kind, (e.body as { cause: string }).cause])).toEqual([['sandbox.kill', 'cancel']]);
  }, 20_000);

  it('a throwing bridge and a rejecting checkpoint sink each end the exec under their own cause', async () => {
    const r = rig();
    const thrown = await r.repl.exec(req("return await fs.read('x')"), async () => {
      throw new Error('broker down');
    });
    expect(raised(thrown).name).toBe('E_INTERNAL');
    expect(thrown.trace.settlement).toMatchObject({ cause: 'bridge-failed', phase: 'execution', detail: expect.stringContaining('broker down') });
    const r2 = rig({ onCheckpoint: () => Promise.reject(new Error('disk full')) });
    const cp = await r2.repl.exec(req("checkpoint('k', 1); await new Promise((r) => setTimeout(r, 200)); return 1"), bridge);
    expect(raised(cp).name).toBe('E_INTERNAL');
    expect(cp.trace.settlement).toMatchObject({ cause: 'checkpoint-sink-rejected', detail: expect.stringContaining('disk full') });
    expect(cp.trace.settlement!.sinks!.rejected).toEqual([expect.stringMatching(/-sink:checkpoint:k#\d+$/)]);
  }, 20_000);
});

describe('diagnostic settle log', () => {
  it(`${SETTLE_LOG_ENV}: every exec that did not end with a result appends its settlement as one JSON line; results append nothing`, async () => {
    const dir = tmp('tecera-settle-log-');
    const file = join(dir, 'settle.jsonl');
    process.env[SETTLE_LOG_ENV] = file;
    const r = rig({ startupTimeoutMs: 100, testSpawn: scripted(() => undefined) });
    await r.repl.exec(req(), bridge);
    const okRun = rig({
      testSpawn: scripted(
        (f) => f.hello(),
        (f, p) => {
          f.result(p.execNo, 1);
          later(10, () => {
            f.exit(0);
            f.close(0);
          });
        },
      ),
    });
    expect((await okRun.repl.exec(req(), bridge)).kind).toBe('return');
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { runId: string; execNo: number; settlement: { cause: string; phase: string } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ runId: 'run_settle', settlement: { cause: 'startup-timeout', phase: 'startup' } });
  }, 30_000);
});
