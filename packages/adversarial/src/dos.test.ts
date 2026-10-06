import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import type { CapabilitySet, Inputs, JsonObject } from '@tecera/contracts';
import { createGates } from '@tecera/gates';
import { MemoryLedger, SqliteLedger } from '@tecera/ledger';
import { DEFAULT_PERMISSIONS, mandatoryHooks } from '@tecera/policy';
import { Broker, ChildProcessRepl, createEditTool, createListFilesTool, createReadTool, FakeLLM, invoke, ProcessVerifyRunner, type ReplFactory, type TraceEntry } from '@tecera/worker';
import { gateCtx, makeRepo, manifest, StubReviewer, StubRunner, WRITERS } from './harness/gates.js';
import { alive, descendants, processesMatching } from './harness/procs.js';
import { execReq, FILES, recorder, replRig, SANDBOX } from './harness/sandbox.js';
import { cleanupTemps, sleep, tmp } from './harness/tmp.js';

/**
 * security.md §6 dos.*: resource exhaustion against the REAL sandbox child, the invoke tree with the
 * REAL mandatory hooks (policy mandatoryHooks), and the verify path (ProcessVerifyRunner + VerifyGate).
 */

afterAll(cleanupTemps);

/**
 * The real sandboxed verify runner. This host runs as root and its node binary is unreadable to an unprivileged
 * uid, so the runner is built with the operator's explicit degraded opt-in (allowRoot: capabilities dropped,
 * recorded as degraded); elsewhere it runs with its defaults.
 */
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const verifyRunner = (): ProcessVerifyRunner => new ProcessVerifyRunner({ netns: true, ...(IS_ROOT ? { allowRoot: true } : {}) });

const js = (body: string): string => `\`\`\`js\n${body}\n\`\`\``;

/** Wait until every pid is gone (bounded). */
async function gone(pids: number[], ms = 3_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pids.every((p) => !alive(p))) return true;
    await sleep(50);
  }
  return pids.every((p) => !alive(p));
}

describe('dos (security.md §6)', () => {
  it('dos.infinite_loop', async () => {
    const rig = replRig({ sandbox: { ...SANDBOX, execTimeoutSec: 30 } });
    const rec = recorder();
    const t0 = Date.now();
    // a busy loop after a tool call (so the child pid is observed), plus one that never yields at all
    const r = await rig.repl.exec(execReq("await fs.read('x'); while (true) {}", FILES, 1_000), rec.bridge);
    expect(Date.now() - t0).toBeLessThan(6_000);
    expect(r.kind).toBe('raise');
    if (r.kind === 'raise') expect(r.exception.name).toBe('E_TIMEOUT');
    expect(r.trace.killed).toEqual({ cause: 'timeout', gone: true });
    expect(rec.childPids.length).toBe(1);
    expect(await gone(rec.childPids)).toBe(true);
    const r2 = await rig.repl.exec(execReq('for (;;) {}', {}, 1_000), rec.bridge);
    expect(r2.kind).toBe('raise');
    if (r2.kind === 'raise') expect(r2.exception.name).toBe('E_TIMEOUT');
    // a promise chain that never settles is a timeout too, not a hang
    const r3 = await rig.repl.exec(execReq('await new Promise(() => {}); return 1', {}, 1_000), rec.bridge);
    expect(r3.kind).toBe('raise');
  });

  it('dos.oom', async () => {
    const rig = replRig({ sandbox: { ...SANDBOX, memoryMb: 32, execTimeoutSec: 30 } });
    const rec = recorder();
    const r = await rig.repl.exec(execReq("await fs.read('x'); const keep = []; while (true) keep.push(new Array(1e5).fill({ x: Math.random() }));", FILES, 15_000), rec.bridge);
    expect(r.kind).toBe('raise');
    if (r.kind === 'raise') expect(r.exception.name).toBe('E_OOM');
    expect(rec.childPids.length).toBe(1);
    expect(await gone([...rec.childPids, ...rec.childPids.flatMap(descendants)])).toBe(true);
    // a huge single allocation is refused too, not a host crash
    const r2 = await rig.repl.exec(execReq("await fs.read('y'); const a = new Array(1e9).fill(1); return a.length", FILES, 15_000), rec.bridge);
    expect(r2.kind).toBe('raise');
  }, 60_000);

  it('dos.fork_bomb_subinvoke', async () => {
    const m = manifest({ budgets: { usd: 2, tokens: 200000, wallClockSec: 1200, maxDepth: 3, maxIterations: 20, maxAttempts: 2, maxChangedFiles: 5 } });
    const hooks = mandatoryHooks(m, { permissions: DEFAULT_PERMISSIONS });
    const root = tmp('tecera-adv-bomb-');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;\n');
    const caps: CapabilitySet = { tools: ['read', 'listFiles'], paths: { read: ['**'], write: [], protected: [] }, network: 'none', limits: { usd: 1, tokens: 100_000, calls: 50, wallMs: 60_000, depth: 8, iterations: 6 } };
    const ledgerPath = join(tmp('tecera-adv-bomb-ledger-'), 'l.sqlite');
    const ledger = new SqliteLedger(ledgerPath);
    for (const [pool, cap] of [['usd', 1], ['tokens', 100_000], ['calls', 50]] as const) await ledger.openBudget('run_bomb', pool, cap);
    const made: number[] = [];
    const replRoot = tmp('tecera-adv-bomb-repl-');
    chmodSync(replRoot, 0o711);
    const factory: ReplFactory = (ctx) => {
      made.push(ctx.depth);
      return new ChildProcessRepl({ runId: ctx.runId, sandbox: SANDBOX, capabilities: ctx.capabilities, onInvoke: ctx.callbacks.onInvoke, onCheckpoint: ctx.callbacks.onCheckpoint, tmpRoot: replRoot });
    };
    // every level spawns two children (a fork bomb), each child does the same
    const bomb = js(`const out = [];\nfor (let i = 0; i < 2; i++) { try { out.push(await invoke({ i }, { output: {} })); } catch (e) { out.push({ error: String(e.message || e) }); } }\nreturn { depth: __depth__, out };`);
    const llm = new FakeLLM(Array.from({ length: 40 }, () => bomb));
    const trace: TraceEntry[] = [];
    const broker = new Broker({ tools: [createReadTool(), createListFilesTool()], runId: 'run_bomb', worktree: root, capabilities: caps });
    const goal: Inputs = { goal: { kind: 'value', value: { statement: 'probe' }, provenance: { src: 'goal', trust: 'trusted' } } };
    const out = await invoke(goal, { output: { type: 'object' } as JsonObject, hooks, llm, repl: factory, broker, ledger, run: { runId: 'run_bomb', invokeId: 'inv_bomb', depth: 0 }, capabilities: caps, trace });
    // RecursionLimit(maxDepth=3) stops the tree: no invoke ever entered at depth >= 3
    const entered = trace.filter((t) => t.type === 'span' && t.span === 'Invoke' && t.stage === 'Enter');
    // stopped by the recursion bound (RecursionLimit hook, or the depth limit before the hook is reached)
    expect(JSON.stringify(out)).toMatch(/recursion|not available at this depth/);
    expect(Math.max(...made)).toBeLessThan(3);
    // the tree is bounded: depth 0 (1) + depth 1 (2) + depth 2 (4) model calls at most
    expect(llm.requests.length).toBeLessThanOrEqual(7);
    expect(entered.length).toBeGreaterThan(0);
    ledger.close();
    // budget charged once: every reservation has a unique key, each LLM call reserved usd exactly once,
    // and nothing is left reserved (every reservation was charged or released)
    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    const rows = db.prepare("SELECT pool, state, idem_key FROM reservations WHERE run_id = 'run_bomb'").all() as Array<{ pool: string; state: string; idem_key: string }>;
    db.close();
    expect(new Set(rows.map((r) => r.idem_key)).size).toBe(rows.length);
    expect(rows.filter((r) => r.pool === 'usd').length).toBe(llm.requests.length);
    expect(rows.filter((r) => r.state === 'reserved')).toEqual([]);
  }, 120_000);

  it('dos.output_flood', async () => {
    const rig = replRig({ sandbox: { ...SANDBOX, execTimeoutSec: 30 } });
    const rec = recorder();
    const r = await rig.repl.exec(execReq("await fs.read('x'); const s = 'x'.repeat(100000); for (let i = 0; i < 100; i++) console.log(s); return 'finished'", FILES, 15_000), rec.bridge);
    expect(r.kind).toBe('raise');
    if (r.kind === 'raise') expect(r.exception.name).toBe('E_OUTPUT');
    expect(Buffer.byteLength(r.printed)).toBeLessThanOrEqual(1024 * 1024);
    expect(r.trace.killed).toEqual({ cause: 'output-flood', gone: true });
    expect(await gone(rec.childPids)).toBe(true);
    expect(rig.evidence.some((e) => e.kind === 'sandbox.kill' || e.kind === 'sandbox.violation')).toBe(true);
    // stderr flood (console.error) is capped as well
    const r2 = await rig.repl.exec(execReq("const s = 'y'.repeat(100000); for (let i = 0; i < 100; i++) console.error(s); return 'finished'", {}, 15_000), rec.bridge);
    expect(r2.kind).toBe('raise');
  }, 60_000);

  it('dos.infinite_loop [verify runner]: a hanging verify command with an escaped background descendant is timed out and its whole tree is gone', async () => {
    const wt = tmp('tecera-adv-vhang-');
    const tag = `30.${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
    const runner = verifyRunner();
    const t0 = Date.now();
    const out = await runner.run({ cwd: wt, command: `(sleep ${tag} &) ; nohup sleep ${tag} >/dev/null 2>&1 & sleep ${tag}`, timeoutSec: 1, envAllowlist: ['PATH'] });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(out.timedOut).toBe(true);
    expect(out.exitCode === 0).toBe(false);
    expect((out as { gone?: boolean }).gone).toBe(true);
    await sleep(200);
    expect(processesMatching(`sleep ${tag}`)).toEqual([]);
  }, 30_000);

  it('dos.output_flood [verify runner, pre-aborted signal]: an already-cancelled verify never starts the command', async () => {
    const wt = tmp('tecera-adv-vabort-');
    chmodSync(wt, 0o777);
    const marker = join(wt, 'ran');
    const ac = new AbortController();
    ac.abort(new Error('cancelled before start'));
    const out = await verifyRunner().run({ cwd: wt, command: `touch ${marker}; node -e "process.stdout.write('x'.repeat(10*1024*1024))"`, timeoutSec: 30, envAllowlist: ['PATH'] }, ac.signal);
    await sleep(200);
    expect(existsSync(marker)).toBe(false);
    expect(out.exitCode === 0).toBe(false);
  }, 30_000);

  it('dos.output_flood [verify gate]: 10 MB of verify output is cut at the cap, the command is killed there, and the gate never passes', async () => {
    const repo = makeRepo();
    repo.write('src/a.ts', 'export const a = 2;\n');
    const marker = join(tmp('tecera-adv-flood-'), 'finished');
    chmodSync(join(marker, '..'), 0o777);
    // floods, then would idle 3 s and mark that it ran to the end
    expect(marker).not.toMatch(/['"\\$`]/);
    const flood = `node -e "process.stdout.write('x'.repeat(10*1024*1024)); setTimeout(() => require('fs').writeFileSync('${marker}', '1'), 3000)"`;
    // the attack is real: through the runner itself the flood hits the cap (truncated) and the command is killed, never exit 0
    const t0 = Date.now();
    const raw = await verifyRunner().run({ cwd: repo.dir, command: flood, timeoutSec: 60, envAllowlist: ['PATH'] });
    expect(raw.truncated, JSON.stringify({ ...raw, stdout: raw.stdout.length })).toBe(true);
    expect(raw.exitCode === 0).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2_500);
    await sleep(3_500);
    expect(existsSync(marker), 'the flooding command ran to the end (not killed at the cap)').toBe(false);
    // and through the gate
    const m = manifest({ verify: { command: flood, timeoutSec: 60 } });
    const ledger = new MemoryLedger();
    const gates = createGates({ manifest: m, ledger, verifyRunner: verifyRunner(), reviewer: new StubReviewer('openai'), writers: WRITERS, worktree: repo.dir, sessionId: 's1' });
    const t1 = Date.now();
    const v = await gates.verify(gateCtx('v', { worktree: repo.dir, check: { command: flood, timeoutSec: 60 } }));
    const ev = ((await ledger.getEvidence(v.evidenceKey))?.body ?? {}) as Record<string, unknown>;
    // the gate ran the flood (its evidence records that command and the truncation), not some other command
    expect({ command: ev.command, ran: ev.ran, outputTruncated: ev.outputTruncated }).toEqual({ command: flood, ran: true, outputTruncated: true });
    expect(v.outcome).not.toBe('passed');
    expect(v.exitCode).not.toBe(0);
    expect(Date.now() - t1).toBeLessThan(2_500);
  }, 60_000);

  it('dos.output_flood [verify gate, exit 0 + truncated]: a runner that reports success on output cut at the cap never passes the gate (the truncation alone refuses)', async () => {
    const repo = makeRepo();
    repo.write('src/a.ts', 'export const a = 2;\n');
    const runner = new StubRunner(() => ({ exitCode: 0, truncated: true, stdout: 'x'.repeat(4096) }));
    const ledger = new MemoryLedger();
    const gates = createGates({ manifest: manifest(), ledger, verifyRunner: runner, reviewer: new StubReviewer('openai'), writers: WRITERS, worktree: repo.dir, sessionId: 's1' });
    const v = await gates.verify(gateCtx('v', { worktree: repo.dir }));
    // the attack reached the gate: the runner was asked and answered exit 0 with truncated output
    expect(runner.calls.length).toBeGreaterThan(0);
    expect(v.outcome).not.toBe('passed');
    const ev = ((await ledger.getEvidence(v.evidenceKey))?.body ?? {}) as Record<string, unknown>;
    expect(ev.outputTruncated, JSON.stringify(ev).slice(0, 400)).toBe(true);
  });
});
