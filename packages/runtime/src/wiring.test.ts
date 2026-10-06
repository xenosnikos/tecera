import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { approvalGrantedEvent, prActionHash, commitActionHash, deriveGoalStatus, verifyCommandDigest, event, FencedWriteGuard, LedgerError, makeRedactor, type AchievementGoal, type BeliefProjection, type Intention, type LLM, type LLMRequest, type LLMResponse, type LLMUsage, type Plan, type Planner, type TeceraEvent, type Tool, type ToolContext, type ToolRequest, type UsageMeter } from '@tecera/contracts';
import { MemoryLedger } from '@tecera/ledger';
import { cancellableGates, effectiveManifest, exitCodeForRun } from './commands/run.js';
import { fencedTool, fencedVerifyRunner } from './fencing.js';
import { ModelFrontier } from './frontier.js';
import { cancellableLLM, meteredLLM, SeatMeter } from './metering.js';
import { VerifyContainmentError } from './containment.js';
import { replayRun } from './replay.js';
import { loadScripts, scriptedFetch } from './scripted.js';
import { deferStaging, stageAchievedPlans } from './staging.js';
import { MeteredPlanner, verifyIdentity } from './wiring.js';
import { leaseWorktree, WiringError } from './worktree.js';

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (p = 'tecera-wiring-'): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  temps.push(d);
  return d;
};
const SAMPLE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../samples/fix-failing-test');
const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args], { env: { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null' } }).toString('utf8');

function businessCase(withGit: boolean): string {
  const root = tmp();
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, '.tecera/runs/r_old'), { recursive: true });
  writeFileSync(join(root, 'src/a.js'), 'export const a = 1;\n');
  writeFileSync(join(root, '.tecera/ledger.sqlite'), 'not copied');
  writeFileSync(join(root, '.tecera/runs/r_old/summary.md'), 'not copied');
  if (withGit) {
    writeFileSync(join(root, '.gitignore'), '.tecera/ledger.sqlite*\n.tecera/runs/\n');
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
  }
  return root;
}

const opts = (root: string, ledger: MemoryLedger, wtRoot: string, over: Partial<Parameters<typeof leaseWorktree>[0]> = {}) => ({ root, runId: 'r_1', base: 'main', ledger, worktreesRoot: wtRoot, resume: false, ttlMs: 60_000, holder: 'run:r_1:a', ...over });

describe('worktree lease', () => {
  it('git: a detached worktree at the base commit, fenced; a second holder is refused while it lives; release frees it; resume reuses it', async () => {
    const root = businessCase(true);
    const ledger = new MemoryLedger();
    const wtRoot = tmp('tecera-wts-');
    const wt = await leaseWorktree(opts(root, ledger, wtRoot));
    expect(wt.git).toBe(true);
    expect(wt.path).toBe(join(wtRoot, 'r_1'));
    expect(git(wt.path, 'rev-parse', 'HEAD').trim()).toBe(git(root, 'rev-parse', 'main').trim());
    expect(wt.fencingToken()).toBe(1);
    await expect(leaseWorktree(opts(root, ledger, wtRoot, { holder: 'run:r_1:b', resume: true }))).rejects.toThrow(/leased by another live process/);
    await wt.release();
    expect(wt.fencingToken()).toBeUndefined();
    const again = await leaseWorktree(opts(root, ledger, wtRoot, { holder: 'run:r_1:b', resume: true }));
    expect(again.fencingToken()).toBe(2);
    await again.release();
    // a fresh run never reuses an existing worktree directory
    await expect(leaseWorktree(opts(root, ledger, wtRoot, { holder: 'run:r_1:c' }))).rejects.toThrow(/already exists/);
  });

  it('not a git repository: a private copy without ledger files or runs becomes a one-commit repository on the base', async () => {
    const root = businessCase(false);
    const ledger = new MemoryLedger();
    const wt = await leaseWorktree(opts(root, ledger, tmp('tecera-wts-')));
    expect(wt.git).toBe(false);
    expect(existsSync(join(wt.path, 'src/a.js'))).toBe(true);
    expect(existsSync(join(wt.path, '.tecera/ledger.sqlite'))).toBe(false);
    expect(existsSync(join(wt.path, '.tecera/runs'))).toBe(false);
    expect(git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(git(wt.path, 'status', '--porcelain').trim()).toBe('');
    await wt.release();
  });

  it('refuses: worktrees inside the business case, a missing worktree on resume, an unsafe repository config, a bad run id', async () => {
    const root = businessCase(true);
    const ledger = new MemoryLedger();
    await expect(leaseWorktree(opts(root, ledger, join(root, 'wts')))).rejects.toThrow(/inside the business case/);
    await expect(leaseWorktree(opts(root, ledger, tmp('tecera-wts-'), { resume: true }))).rejects.toThrow(/is missing/);
    await expect(leaseWorktree(opts(root, ledger, tmp('tecera-wts-'), { runId: '../x' }))).rejects.toThrow(WiringError);
    git(root, 'config', 'core.fsmonitor', 'touch /tmp/pwned');
    await expect(leaseWorktree(opts(root, ledger, tmp('tecera-wts-'), { runId: 'r_2', holder: 'h2' }))).rejects.toThrow(/core\.fsmonitor/);
    // the lease of a refused attempt is released, not leaked
    expect(await ledger.lease('worktree:r_2', 'other', 1000)).not.toBeNull();
  });
});

describe('lease loss revokes authority', () => {
  it('a takeover after expiry: renewals stall, the LOCAL validity lapses first (lost fires, token gone, sync fence closed) before the ledger lets a thief in; assertHeld then fails; a stale token is refused', async () => {
    const root = businessCase(true);
    const ledger = new MemoryLedger();
    const wt = await leaseWorktree(opts(root, ledger, tmp('tecera-wts-'), { ttlMs: 400 }));
    expect(await wt.assertHeld(1)).toBe(1);
    await expect(wt.assertHeld(7)).rejects.toThrow(/stale fencing token 7/);
    expect(wt.lost.aborted).toBe(false);
    expect(wt.heldReason()).toBeNull();
    // the ledger stops answering renewals (a partition, a stalled disk): nothing renews any more
    const renew = ledger.renew.bind(ledger);
    let stalled = true;
    ledger.renew = (l, t) => (stalled ? new Promise(() => undefined) : renew(l, t));
    let thief: Awaited<ReturnType<MemoryLedger['lease']>> = null;
    let lostBeforeThief: boolean | null = null;
    for (let i = 0; i < 100 && !thief; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const t = await ledger.lease('worktree:r_1', 'run:r_1:thief', 60_000);
      if (t) {
        lostBeforeThief = wt.lost.aborted && wt.heldReason() !== null && wt.fencingToken() === undefined;
        thief = t;
      }
    }
    expect(thief?.fencingToken).toBe(2);
    expect(lostBeforeThief, 'this process stopped writing before the ledger could hand the lease to anyone else').toBe(true);
    expect(String((wt.lost.reason as Error).message)).toMatch(/no successful renewal within the lease validity/);
    stalled = false;
    await expect(wt.assertHeld()).rejects.toThrow(/lost/);
    await wt.release();
    // releasing a lost lease never frees the thief's
    expect(await ledger.lease('worktree:r_1', 'someone', 1000)).toBeNull();
  });

  it('a renewal refused by the ledger revokes with that reason', async () => {
    const root = businessCase(true);
    const ledger = new MemoryLedger();
    const wt = await leaseWorktree(opts(root, ledger, tmp('tecera-wts-'), { ttlMs: 60_000 }));
    ledger.renew = async () => {
      throw new LedgerError('lease taken', 'lease');
    };
    await expect(wt.assertHeld()).rejects.toThrow(/lost: renewal refused/);
    expect(String((wt.lost.reason as Error).message)).toMatch(/renewal refused/);
    expect(wt.fencingToken()).toBeUndefined();
    expect(wt.heldReason()).toMatch(/renewal refused/);
    await wt.release();
  });

  it('a renewal the ledger refuses on the timer revokes too', async () => {
    const root = businessCase(true);
    const ledger = new MemoryLedger();
    let refuse = false;
    const renew = ledger.renew.bind(ledger);
    ledger.renew = async (l, t) => {
      if (refuse) throw new LedgerError('lease taken', 'lease');
      return renew(l, t);
    };
    const wt = await leaseWorktree(opts(root, ledger, tmp('tecera-wts-'), { ttlMs: 900 }));
    refuse = true;
    await new Promise<void>((resolve) => (wt.lost.aborted ? resolve() : wt.lost.addEventListener('abort', () => resolve(), { once: true })));
    expect(wt.fencingToken()).toBeUndefined();
    await wt.release();
  });

  it('fenced write tools re-prove the lease before every call; read tools pass through', async () => {
    const calls: string[] = [];
    const writeTool: Tool = { name: 'edit', methods: ['writeFile'], schema: {}, risk: 'write', call: async (req) => (calls.push(req.callId), { callId: req.callId, ok: true, value: 'written', provenance: { src: 'tool:edit', trust: 'untrusted' }, truncated: false }) };
    const readTool: Tool = { ...writeTool, name: 'read', risk: 'read' };
    const ctl = new AbortController();
    let held = true;
    const lease = { lost: ctl.signal, assertHeld: async (t?: number) => { if (!held || t !== 3) throw new Error(held ? `stale fencing token ${t}` : 'renewal refused'); return 3; } };
    const req = (id: string): ToolRequest => ({ callId: id, tool: 'edit', method: 'writeFile', args: [] }) as unknown as ToolRequest;
    const ctx = (token?: number): ToolContext => ({ runId: 'r', worktree: '/w', capabilities: { tools: [], paths: { read: [], write: [], protected: [] }, network: 'none', limits: { usd: 1, tokens: 1, calls: 1, wallMs: 1, depth: 1, iterations: 1 } }, ...(token !== undefined ? { fencingToken: token } : {}) });
    const fenced = fencedTool(writeTool, lease);
    const step = new FencedWriteGuard({ live: () => null, signal: new AbortController().signal });
    expect((await fenced.call(req('a'), ctx(3), step)).ok).toBe(true);
    // no guard at all: no write authority (fail closed)
    expect((await fenced.call(req('n'), ctx(3))).error?.message).toMatch(/no write guard/);
    // a step guard that says the step is no longer running refuses before the tool runs
    expect((await fenced.call(req('g'), ctx(3), new FencedWriteGuard({ live: () => 'step edit is done, not running', signal: new AbortController().signal }))).error?.message).toMatch(/not running/);
    const stale = await fenced.call(req('b'), ctx(2), step);
    expect(stale.ok).toBe(false);
    expect(stale.error?.message).toMatch(/stale fencing token 2/);
    expect((await fenced.call(req('c'), ctx(), step)).error?.message).toMatch(/no worktree lease fencing token/);
    held = false;
    expect((await fenced.call(req('d'), ctx(3), step)).error?.message).toMatch(/renewal refused/);
    ctl.abort(new Error('lease lost: x'));
    expect((await fenced.call(req('e'), ctx(3), step)).error?.message).toMatch(/lease lost/);
    expect(calls).toEqual(['a']);
    expect(fencedTool(readTool, lease)).toBe(readTool);
  });

  it("the worker's verify runner (runVerify runs repository code) re-proves the lease and runs under the lease signal", async () => {
    const ctl = new AbortController();
    let held = true;
    const seen: Array<AbortSignal | undefined> = [];
    const runner = { run: async (_r: unknown, s?: AbortSignal) => (seen.push(s), { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', durationMs: 1, truncated: false }) };
    const fenced = fencedVerifyRunner(runner, { lost: ctl.signal, assertHeld: async () => { if (!held) throw new Error('renewal refused'); return 1; } });
    const req = { cwd: '/w', command: 'node --test', timeoutSec: 5, envAllowlist: [] };
    expect((await fenced.run(req)).exitCode).toBe(0);
    expect(seen[0]).toBeDefined();
    ctl.abort(new Error('lease lost: taken'));
    expect(seen[0]!.aborted).toBe(true); // a running check is killed with the lease
    await expect(fenced.run(req)).rejects.toThrow(/verify refused: lease lost/);
    held = false;
    await expect(fencedVerifyRunner(runner, { lost: new AbortController().signal, assertHeld: async () => { throw new Error('renewal refused'); } }).run(req)).rejects.toThrow(/renewal refused/);
    expect(seen).toHaveLength(1);
  });
});

describe('seat accounting (reviewer, frontier, planner bridge)', () => {
  const usage = (t: number, usd = 0.01): LLMUsage => ({ inputTokens: t, outputTokens: 0, usd });
  class Usage implements LLM {
    readonly id = 'u';
    readonly provider = 'openai';
    readonly keyFingerprint = 'kfp';
    calls = 0;
    constructor(private readonly tokens: number, private readonly content = '{"answer":{"decision":"block"}}') {}
    async complete(): Promise<LLMResponse> {
      this.calls++;
      return { content: this.content, usage: usage(this.tokens), model: 'm', finishReason: 'stop' };
    }
  }
  async function pools(tokens: number, usd = 1, calls = 100): Promise<MemoryLedger> {
    const l = new MemoryLedger();
    await l.openBudget('r', 'usd', usd);
    await l.openBudget('r', 'tokens', tokens);
    await l.openBudget('r', 'calls', calls);
    return l;
  }

  it("every seat reserves 'calls': an exhausted or unopened calls pool refuses the reviewer and the frontier BEFORE the provider is called (budget, exit 7 path)", async () => {
    for (const seat of ['reviewer', 'frontier'] as const) {
      const l = await pools(100_000, 10, 2);
      const llm = new Usage(10, '{"answer":{"decision":"allow"}}');
      const meter = new SeatMeter({ ledger: l, runId: 'r', seat, reservation: { usd: 0.01, tokens: 100 } });
      const call = seat === 'reviewer' ? () => meteredLLM(llm, meter, 'review').complete({} as LLMRequest) : () => new ModelFrontier({ llm, model: 'm', redactor, meter }).decide('gate', gateQ('always'));
      await call();
      await call();
      await expect(call(), `${seat}: third call over a calls cap of 2`).rejects.toMatchObject({ code: 'budget' });
      expect(llm.calls).toBe(2);
      expect(meter.exhausted).not.toBeNull();
      // no calls pool opened at all: refused, never called
      const none = new MemoryLedger();
      await none.openBudget('r', 'usd', 10);
      await none.openBudget('r', 'tokens', 100_000);
      const llm2 = new Usage(10);
      await expect(meteredLLM(llm2, new SeatMeter({ ledger: none, runId: 'r', seat, reservation: { usd: 0.01, tokens: 100 } }), 'x').complete({} as LLMRequest)).rejects.toMatchObject({ code: 'budget' });
      expect(llm2.calls).toBe(0);
    }
  });

  it('the run-wide signal (deadline, lease loss) cancels an in-flight reviewer / frontier / planner call: the caller stops waiting at once, the provider sees the abort, the reservation is charged', async () => {
    class Hang implements LLM {
      readonly id = 'h';
      readonly provider = 'openai';
      seen: AbortSignal[] = [];
      complete(_r: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
        if (signal) this.seen.push(signal);
        return new Promise(() => undefined); // never answers on its own
      }
    }
    const l = await pools(100_000, 10);
    const run = new AbortController();
    const hang = new Hang();
    const meter = new SeatMeter({ ledger: l, runId: 'r', seat: 'reviewer', reservation: { usd: 0.02, tokens: 500 }, signal: () => run.signal });
    const p = meteredLLM(hang, meter, 'review').complete({} as LLMRequest);
    await new Promise((r) => setTimeout(r, 20));
    run.abort(new Error('budget: run deadline exceeded'));
    await expect(p).rejects.toThrow(/deadline exceeded/);
    expect(hang.seen[0]!.aborted).toBe(true);
    // the reservation was settled (charged), not released
    await expect(l.reserve('usd', 9.99, 'r', 'probe-usd')).rejects.toMatchObject({ code: 'budget' });
    // the frontier: same signal, same cancellation (a cancelled answer is never a decision)
    const run2 = new AbortController();
    const hang2 = new Hang();
    const f = new ModelFrontier({ llm: hang2, model: 'm', redactor, meter: new SeatMeter({ ledger: await pools(100_000, 10), runId: 'r', seat: 'frontier', reservation: { usd: 0.01, tokens: 100 } }), signal: () => run2.signal });
    const fp = f.decide('gate', gateQ('always'));
    await new Promise((r) => setTimeout(r, 20));
    run2.abort(new Error('lease lost'));
    expect((await fp).answer.decision).toBe('hold');
    expect(hang2.seen[0]!.aborted).toBe(true);
    // the planner seat (metered by the loop): cancellableLLM aborts on the run signal AND the loop meter's
    const run3 = new AbortController();
    const meterAbort = new AbortController();
    const hang3 = new Hang();
    const planner = cancellableLLM(hang3, () => run3.signal, () => meterAbort.signal);
    const pp = planner.complete({} as LLMRequest);
    meterAbort.abort(new Error('budget: run deadline exceeded'));
    expect(hang3.seen[0]!.aborted).toBe(true);
    void pp.catch(() => undefined);
    await expect(planner.complete({} as LLMRequest)).rejects.toThrow(/deadline exceeded/);
  });

  it('reserve before, settle at actual after; an overrunning call is exhaustion (its answer unused) and every later call is refused without calling', async () => {
    const l = await pools(10_000);
    const meter = new SeatMeter({ ledger: l, runId: 'r', seat: 'reviewer', reservation: { usd: 0.05, tokens: 1000 } });
    const llm = new Usage(4000);
    const m = meteredLLM(llm, meter, 'review');
    expect(m.provider).toBe('openai');
    expect(m.keyFingerprint).toBe('kfp');
    expect((await m.complete({} as LLMRequest)).content).toContain('block');
    expect((await m.complete({} as LLMRequest)).content).toContain('block'); // 8000 used
    await expect(m.complete({} as LLMRequest)).rejects.toMatchObject({ code: 'budget' }); // 12000 > 10000
    expect(meter.exhausted).not.toBeNull();
    await expect(m.complete({} as LLMRequest)).rejects.toMatchObject({ code: 'budget' });
    expect(llm.calls).toBe(3);
    // a reservation that does not fit refuses before the call
    const tight = await pools(500);
    const t = new Usage(1);
    await expect(meteredLLM(t, new SeatMeter({ ledger: tight, runId: 'r', seat: 'reviewer', reservation: { usd: 0.05, tokens: 1000 } }), 'review').complete({} as LLMRequest)).rejects.toMatchObject({ code: 'budget' });
    expect(t.calls).toBe(0);
  });

  it('frontier: a budget refusal propagates (exit 7 path), any other failure is the fail-closed fallback', async () => {
    const l = await pools(500);
    const meter = new SeatMeter({ ledger: l, runId: 'r', seat: 'frontier', reservation: { usd: 0.05, tokens: 1000 } });
    const f = new ModelFrontier({ llm: new Usage(1, '{"answer":{"decision":"allow"}}'), model: 'm', redactor, meter });
    await expect(f.decide('gate', gateQ('always'))).rejects.toMatchObject({ code: 'budget' });
    const ok = new ModelFrontier({ llm: new OneShot(new Error('down')), model: 'm', redactor, meter: new SeatMeter({ ledger: await pools(100_000), runId: 'r', seat: 'frontier', reservation: { usd: 0.05, tokens: 1000 } }) });
    expect((await ok.decide('gate', gateQ('always'))).answer.decision).toBe('hold');
  });

  it('planner usage is bridged onto the loop meter exactly once (direct records win over onUsage reports); outside the loop it is charged directly', async () => {
    const recorded: LLMUsage[] = [];
    const meter: UsageMeter = { record: (u) => void recorded.push(u) };
    const direct: string[] = [];
    let bridge!: MeteredPlanner;
    const plan = { id: 'p' } as Plan;
    const reportsOnly: Planner = {
      write: async () => {
        await bridge.onUsage({ usage: usage(100), purpose: 'write' });
        await bridge.onUsage({ usage: usage(50), purpose: 'repair' });
        return plan;
      },
      deliberate: async () => plan,
    };
    bridge = new MeteredPlanner(reportsOnly, async (_u, p) => void direct.push(p));
    await bridge.write({} as TeceraEvent, {} as BeliefProjection, {} as AchievementGoal, meter);
    expect(recorded.map((u) => u.inputTokens)).toEqual([100, 50]);
    const both: Planner = {
      write: async (_e, _b, _g, m) => {
        m?.record(usage(70));
        await bridge.onUsage({ usage: usage(70), purpose: 'write' });
        return plan;
      },
      deliberate: async (_o: Plan[], _i: Intention[], _b: BeliefProjection) => plan,
    };
    recorded.length = 0;
    bridge = new MeteredPlanner(both, async (_u, p) => void direct.push(p));
    await bridge.write({} as TeceraEvent, {} as BeliefProjection, {} as AchievementGoal, meter);
    expect(recorded.map((u) => u.inputTokens)).toEqual([70]); // not 70 twice
    await bridge.write({} as TeceraEvent, {} as BeliefProjection, {} as AchievementGoal);
    expect(direct).toEqual(['planner.write']);
  });
});

describe('effective manifest, gates passthrough and verify identity', () => {
  it('the goal check is bound into the effective manifest (gates run the goal command); reconcile is passed through only when wired', async () => {
    const m = JSON.parse(readFileSync(join(SAMPLE_DIR, 'tecera.json'), 'utf8'));
    const eff = effectiveManifest(m, m.budgets, { command: 'node --test test/slugify.test.js', timeoutSec: 30 });
    expect(eff.verify).toEqual({ command: 'node --test test/slugify.test.js', timeoutSec: 30 });
    expect(Object.isFrozen(eff.verify)).toBe(true);
    const ac = new AbortController();
    const base = { verify: async () => ({ exitCode: 0, evidenceKey: '' }), review: async () => ({ verdict: 'approve' as const, evidenceKey: '' }), commit: async () => ({ exitCode: 0, evidenceKey: '' }) };
    expect(cancellableGates(base, ac.signal).reconcile).toBeUndefined();
    const withRec = cancellableGates({ ...base, reconcile: async () => ({ recorded: true, sha: 'abc' }) }, ac.signal);
    expect(await withRec.reconcile!({} as never)).toEqual({ recorded: true, sha: 'abc' });
    ac.abort();
    expect(await withRec.reconcile!({} as never)).toMatchObject({ recorded: false });
  });

  it('verify identity comes from the operator env only: uid/gid, or an explicit degraded root; bad values refuse', () => {
    expect(verifyIdentity({})).toEqual({});
    expect(verifyIdentity({ TECERA_VERIFY_UID: '1000', TECERA_VERIFY_GID: '1000' })).toEqual({ runAs: { uid: 1000, gid: 1000 } });
    expect(verifyIdentity({ TECERA_VERIFY_ALLOW_ROOT: '1' })).toEqual({ allowRoot: true });
    expect(verifyIdentity({ TECERA_VERIFY_ALLOW_ROOT: 'yes' })).toEqual({});
    expect(() => verifyIdentity({ TECERA_VERIFY_UID: '0' })).toThrow(VerifyContainmentError);
    expect(() => verifyIdentity({ TECERA_VERIFY_UID: 'nobody' })).toThrow(VerifyContainmentError);
  });
});

describe('scripted transport', () => {
  it('serves replies in the provider wire format, in order; a request that does not match `expect` or runs past the script is an error status', async () => {
    const f = scriptedFetch('worker', 'anthropic', [{ text: 'one', expect: 'analyze', usage: { input: 10, output: 2 } }, { text: 'two' }]);
    const r1 = await f('https://x/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'm', messages: [{ content: 'analyze this' }] }) });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ model: 'm', content: [{ type: 'text', text: 'one' }], usage: { input_tokens: 10, output_tokens: 2 } });
    const g = scriptedFetch('w', 'openai', [{ text: 'x', expect: 'never' }]);
    expect((await g('u', { method: 'POST', body: '{}' })).status).toBe(418);
    expect((await f('u', { method: 'POST', body: '{}' })).status).toBe(200);
    expect((await f('u', { method: 'POST', body: '{}' })).status).toBe(418);
  });

  it('loadScripts refuses a missing dir, bad JSON, bad regex and a set with neither plan nor planner replies', () => {
    const d = tmp();
    expect(() => loadScripts(join(d, 'nope'), d)).toThrow(/not a directory/);
    writeFileSync(join(d, 'replies.json'), '{"worker": ["x"]}');
    expect(() => loadScripts(d, d)).toThrow(/plan.json or replies for the planner/);
    writeFileSync(join(d, 'replies.json'), '{"planner": [{"text": "x", "expect": "("}]}');
    expect(() => loadScripts(d, d)).toThrow(/not a valid regex/);
    writeFileSync(join(d, 'replies.json'), '{oops');
    expect(() => loadScripts(d, d)).toThrow(/not valid JSON/);
  });
});

class OneShot implements LLM {
  readonly id = 'p';
  readonly provider = 'anthropic';
  constructor(private readonly r: Partial<LLMResponse> | Error) {}
  async complete(_req: LLMRequest): Promise<LLMResponse> {
    if (this.r instanceof Error) throw this.r;
    return { content: '', usage: { inputTokens: 1, outputTokens: 1, usd: 0 }, model: 'm', finishReason: 'stop', ...this.r };
  }
}
const redactor = makeRedactor([]);
const gateQ = (permission: string) => ({ state: { tool: 'gate.commit', risk: 'irreversible', permission }, options: [{ decision: 'allow' as const }, { decision: 'hold' as const }, { decision: 'block' as const }] });

describe('frontier (planner seat) never loosens a decision', () => {
  it('gate: stricter of rule and model; failure → hold. closeOut: needs both. route: only offered seats', async () => {
    const allow = new ModelFrontier({ llm: new OneShot({ content: '{"answer":{"decision":"allow"}}' }), model: 'm', redactor });
    expect((await allow.decide('gate', gateQ('requiresApproval'))).answer.decision).toBe('hold');
    const block = new ModelFrontier({ llm: new OneShot({ content: '{"answer":{"decision":"block"}}' }), model: 'm', redactor });
    expect((await block.decide('gate', gateQ('always'))).answer.decision).toBe('block');
    const broken = new ModelFrontier({ llm: new OneShot(new Error('down')), model: 'm', redactor });
    expect((await broken.decide('gate', { ...gateQ('always'), state: { tool: 'worker', risk: 'read', permission: 'always' } })).answer.decision).toBe('hold');
    const truncated = new ModelFrontier({ llm: new OneShot({ content: '{"answer":{"achieved":true}}', finishReason: 'length' }), model: 'm', redactor });
    expect((await truncated.decide('closeOut', { state: { stepKind: 'gate.verify', exitCode: 0 } })).answer.achieved).toBe(false);
    const yes = new ModelFrontier({ llm: new OneShot({ content: '{"answer":{"achieved":true}}' }), model: 'm', redactor });
    expect((await yes.decide('closeOut', { state: { stepKind: 'gate.verify', exitCode: 1 } })).answer.achieved).toBe(false);
    const rogue = new ModelFrontier({ llm: new OneShot({ content: '{"answer":{"seatId":"expensive-unlisted"}}' }), model: 'm', redactor });
    expect((await rogue.decide('route', { state: {}, options: [{ seatId: 'worker', costPerMTok: 1 }] })).answer.seatId).toBe('worker');
    // an accounting failure that is not a budget refusal (the ledger is down) is NOT a quiet fallback: the
    // call is never made and the failure propagates (the loop terminates the run, failure 'ledger', exit 9)
    const down = new MemoryLedger();
    down.reserve = async () => {
      throw new Error('disk gone');
    };
    const llm = new OneShot({ content: '{"answer":{"decision":"allow"}}' });
    const charged = new ModelFrontier({ llm, model: 'm', redactor, meter: new SeatMeter({ ledger: down, runId: 'r', seat: 'frontier', reservation: { usd: 0.01, tokens: 10 } }) });
    await expect(charged.decide('gate', gateQ('always'))).rejects.toMatchObject({ name: 'AccountingFailure', code: 'ledger' });
  });
});

const ev = (kind: TeceraEvent['kind'], i: number, payload: Record<string, unknown> = {}, trace: TeceraEvent['trace'] = {}): TeceraEvent =>
  event(kind, { id: `e${i}`, at: i, actor: { kind: 'system', id: 't' }, runId: 'r', trace, payload: payload as never });

describe('exit codes classify terminal failures', () => {
  it("step.failed / goal.dropped failure: 'budget' → 7, 'policy' → 8, 'human' → 9; planner budget exhaustion (goal.dropped only) → 7", () => {
    const t = { goalId: 'g', intentionId: 'i', planId: 'p', stepId: 's' };
    for (const [failure, code] of [['budget', 7], ['policy', 8], ['human', 9], ['ledger', 9]] as const) {
      expect(exitCodeForRun([ev('run.started', 1), ev('step.failed', 2, { reason: 'x', terminal: true, failure }, t), ev('goal.dropped', 3, { failure }, { goalId: 'g' })], 'g').exitCode, failure).toBe(code);
      expect(exitCodeForRun([ev('run.started', 1), ev('goal.dropped', 2, { reason: `${failure}: x`, failure }, { goalId: 'g' })], 'g').exitCode, failure).toBe(code);
    }
    // a verify failure without classification stays 5
    expect(exitCodeForRun([ev('step.failed', 1, { reason: 'verify exit 1' }, t), ev('goal.dropped', 2, {}, { goalId: 'g' })], 'g').exitCode).toBe(5);
    // a loop that stopped on its accounting: 'ledger' (or unclassified) → 9, a budget refusal → 7
    expect(exitCodeForRun([ev('run.started', 1)], 'g', { state: 'stopped', stopReason: 'ledger could not settle', failure: 'ledger' }).exitCode).toBe(9);
    expect(exitCodeForRun([ev('run.started', 1)], 'g', { state: 'stopped', stopReason: 'x' }).exitCode).toBe(9);
    expect(exitCodeForRun([ev('run.started', 1)], 'g', { state: 'stopped', stopReason: 'calls pool exhausted', failure: 'budget' }).exitCode).toBe(7);
  });
});

describe('exit codes read the current execution only', () => {
  it('an interrupted segment followed by a successful resume is 0; an interruption in the current segment is 130', () => {
    const g = { goalId: 'g' };
    const interruptedThenAchieved = [ev('run.started', 1), ev('run.interrupted', 2), ev('run.ended', 3, { exitCode: 130 }), ev('goal.achieved', 4, {}, g)];
    expect(exitCodeForRun(interruptedThenAchieved, 'g').exitCode).toBe(0);
    const resumedThenInterrupted = [ev('run.started', 1), ev('run.ended', 2, { exitCode: 4 }), ev('run.interrupted', 3)];
    expect(exitCodeForRun(resumedThenInterrupted, 'g').exitCode).toBe(130);
    const oldInterruptNowHeld = [ev('run.interrupted', 1), ev('run.ended', 2), ev('approval.requested', 3, { requestId: 'ap' }, { goalId: 'g', planId: 'p', intentionId: 'i', stepId: 'c' })];
    expect(exitCodeForRun(oldInterruptNowHeld, 'g').exitCode).toBe(4);
  });
});

const CHECK = { command: 'node --test', timeoutSec: 60 };
type VerifyBody = Record<string, unknown>;
const verifyBody = (over: VerifyBody = {}): VerifyBody => ({ outcome: 'passed', exitCode: 0, fingerprint: 'f', fingerprintAfter: 'f', command: CHECK.command, commandDigest: verifyCommandDigest(CHECK.command), timeoutSec: CHECK.timeoutSec, runId: 'r', intentionId: 'i', attempt: 1, ...over });

/**
 * A fully accounted D6 run in a memory ledger: verify → commit to the work branch (no approval) → PR on an
 * audited, consumed human grant bound to the committed sha (prActionHash) → goal.achieved with its proof (D4).
 */
async function achievedLedger(o: { approval?: 'none' | 'unconsumed' | 'ok'; foreignVerify?: boolean; verify?: VerifyBody; proof?: 'ok' | 'none' | 'other-key' } = {}): Promise<MemoryLedger> {
  const l = new MemoryLedger();
  const plan = {
    id: 'p',
    trigger: { kind: 'goal.adopted' },
    context: [],
    steps: [
      { id: 'v', kind: 'gate.verify', dependsOn: [], inputs: {} },
      { id: 'c', kind: 'gate.commit', dependsOn: ['v'], inputs: {} },
      { id: 'pr', kind: 'gate.pr', dependsOn: ['c'], inputs: {} },
    ],
    allowedModels: {},
    permissions: { tools: [], write: [], approvals: ['open_pr'] },
    budget: {},
    origin: 'generated',
    status: 'candidate',
    goalKinds: [],
  };
  const t = { goalId: 'g', intentionId: 'i', planId: 'p' };
  await l.evidence({ key: 'vk', kind: 'gate.verify', runId: o.foreignVerify ? 'other-run' : 'r', body: (o.verify ?? verifyBody()) as never });
  await l.evidence({ key: 'ck', kind: 'gate.commit', runId: 'r', body: { outcome: 'committed', sha: 'abc', fingerprints: { d1: 'f', d2: 'f', d3: 'f' } } });
  await l.evidence({ key: 'pk', kind: 'gate.pr', runId: 'r', body: { outcome: 'requested', sha: 'abc', branch: 'tecera/g', exitCode: 0 } });
  const actionHash = prActionHash({ intentionId: 'i', stepId: 'pr', attempt: 1, sha: 'abc' });
  let n = 0;
  const add = async (kind: TeceraEvent['kind'], payload: Record<string, unknown>, trace: TeceraEvent['trace'] = {}) => l.append(ev(kind, ++n, payload, trace));
  await add('goal.adopted', { goal: { id: 'g', statement: 's', check: CHECK } }, { goalId: 'g' });
  await add('plan.generated', { plan }, { goalId: 'g', planId: 'p' });
  await add('intention.pushed', { intention: { id: 'i', goalId: 'g', planId: 'p', attempt: 1 } }, t);
  await add('verify.passed', { evidenceKey: 'vk', fingerprint: 'f', attempt: 1 }, { ...t, stepId: 'v' });
  const verifiedAt = n;
  await add('step.completed', {}, { ...t, stepId: 'v' });
  await add('commit.recorded', { sha: 'abc', valid: true, evidenceKey: 'ck', d1: 'f' }, { ...t, stepId: 'c' });
  await add('step.completed', {}, { ...t, stepId: 'c' });
  const approval = o.approval ?? 'ok';
  if (approval !== 'none') {
    await l.requestApproval({ requestId: 'ap', runId: 'r', sessionId: 'r', actionHash, requester: { kind: 'agent', id: 'loop' }, reason: 'gate.pr pr', expiresAt: Date.now() + 60_000 });
    await add('approval.requested', { requestId: 'ap', actionHash, candidateD1: 'abc', sha: 'abc', reviewedD1: 'f', owner: 'gate', sessionId: 'r', attempt: 1 }, { ...t, stepId: 'pr' });
    await l.approve('ap', { kind: 'human', id: 'bob' }, 'r', Date.now(), approvalGrantedEvent({ id: `e${++n}`, at: n, requestId: 'ap', runId: 'r', sessionId: 'r', actionHash, approver: { kind: 'human', id: 'bob' }, trace: { ...t, stepId: 'pr' } }));
    if (approval === 'ok') {
      await l.consume('ap', actionHash, 'r', 'gate.pr:ap', Date.now());
      await add('approval.consumed', { requestId: 'ap', by: 'gate.pr' }, { ...t, stepId: 'pr' });
    }
  }
  await add('pr.requested', { step: 'pr', sha: 'abc', evidenceKey: 'pk', branch: 'tecera/g', base: 'main', ...(approval === 'none' ? {} : { approvalRequestId: 'ap' }) }, { ...t, stepId: 'pr' });
  await add('step.completed', {}, { ...t, stepId: 'pr' });
  await add('intention.done', { intention: { id: 'i', goalId: 'g', planId: 'p', attempt: 1, status: 'done' } }, t);
  const proofMode = o.proof ?? 'ok';
  const proof = { command: CHECK.command, exitCode: 0, fingerprint: 'f', evidenceKey: proofMode === 'other-key' ? 'vk-other' : 'vk', verifiedAt };
  await add('goal.achieved', { evidence: ['e4', 'vk'], ...(proofMode === 'none' ? {} : { proof }) }, { goalId: 'g' });
  return l;
}

describe('offline replay is strict', () => {
  it('a fully accounted run is achieved; a broken chain, a PR without an approval, an unconsumed grant, foreign evidence or a missing proof derive nothing achieved', async () => {
    expect((await replayRun(await achievedLedger(), 'r')).goals.g).toMatchObject({ derived: 'achieved', agrees: true });

    const tampered = await achievedLedger();
    tampered.tamperEvidenceForTest('ck', { outcome: 'committed', sha: 'abc', fingerprints: { d1: 'f', d2: 'f', d3: 'f' }, forged: true });
    const broken = await replayRun(tampered, 'r');
    expect(broken.chainValid).toBe(false);
    expect(broken.goals.g).toMatchObject({ derived: 'open', recorded: 'achieved', agrees: false });
    expect(broken.goals.g!.why.join(' ')).toMatch(/hash chain is broken/);

    // D6: the commit needs no approval; the PR does
    const none = await replayRun(await achievedLedger({ approval: 'none' }), 'r');
    expect(none.goals.g!.derived).not.toBe('achieved');
    expect(none.goals.g!.why.join(' ')).toMatch(/pr step pr carries no approval request id/);
    expect((await replayRun(await achievedLedger({ approval: 'none' }), 'r', { requirePrApproval: false })).goals.g!.why.join(' ')).not.toMatch(/approval/);

    const unconsumed = await replayRun(await achievedLedger({ approval: 'unconsumed' }), 'r');
    expect(unconsumed.goals.g!.derived).not.toBe('achieved');
    expect(unconsumed.goals.g!.why.join(' ')).toMatch(/granted, not consumed/);

    const foreign = await replayRun(await achievedLedger({ foreignVerify: true }), 'r');
    expect(foreign.goals.g!.derived).not.toBe('achieved');
    expect(foreign.goals.g!.why.join(' ')).toMatch(/no passing, unmutated verify evidence/);

    // D4: goal.achieved must carry the proof of exactly the verify it rests on
    const noProof = await replayRun(await achievedLedger({ proof: 'none' }), 'r');
    expect(noProof.goals.g!.derived).not.toBe('achieved');
    expect(noProof.goals.g!.why.join(' ')).toMatch(/goal.achieved proof does not name the verify it rests on \(no proof of achievement\)/);
    const otherKey = await replayRun(await achievedLedger({ proof: 'other-key' }), 'r');
    expect(otherKey.goals.g!.derived).not.toBe('achieved');
  });

  it('same-run evidence substitution cannot derive achievement: another command, a longer timeout, another intention or attempt, a mismatching fingerprint (runtime replay AND the kernel derivation)', async () => {
    const cases: Array<[string, VerifyBody, RegExp]> = [
      ['another command (digest)', verifyBody({ command: 'true', commandDigest: verifyCommandDigest('true') }), /another command than the goal check/],
      ['another command (literal, no digest)', verifyBody({ command: 'true', commandDigest: undefined }), /does not prove the goal check command ran/],
      ['a longer timeout', verifyBody({ timeoutSec: 600 }), /longer timeout/],
      ['another intention', verifyBody({ intentionId: 'other' }), /belongs to intention other/],
      ['another attempt', verifyBody({ attempt: 2 }), /attempt 2/],
    ];
    for (const [name, body, why] of cases) {
      const r = await replayRun(await achievedLedger({ verify: JSON.parse(JSON.stringify(body)) as VerifyBody }), 'r');
      expect(r.goals.g!.derived, name).not.toBe('achieved');
      expect(r.goals.g!.why.join(' '), name).toMatch(why);
    }
    // the kernel derivation alone refuses a same-run command substitution as well
    const l = await achievedLedger({ verify: verifyBody({ command: 'true', commandDigest: verifyCommandDigest('true') }) });
    const all: Array<TeceraEvent & { seq: number; hash: string }> = [];
    for await (const e of l.events()) all.push(e);
    const derived = deriveGoalStatus(all, await l.listEvidence('r'), { chain: await l.verifyChain() });
    expect(derived.goals.g!.status).not.toBe('achieved');
    expect(derived.goals.g!.reasons.join(' ')).toMatch(/another command than the goal check/);
  });
});

describe('plan staging after goal.achieved', () => {
  it("the loop's early plan.staged is deferred; staging is written once after goal.achieved, idempotently, only for generated plans", async () => {
    const l = new MemoryLedger();
    const loopActor = { kind: 'agent' as const, id: 'loop' };
    const deferred = deferStaging(l, loopActor);
    const plan = { id: 'p' };
    await deferred.append(event('plan.generated', { id: 'a1', at: 1, actor: loopActor, runId: 'r', trace: { planId: 'p', goalId: 'g' }, payload: { plan } }));
    const r = await deferred.append(event('plan.staged', { id: 'a2', at: 2, actor: loopActor, runId: 'r', trace: { planId: 'p' }, payload: { planId: 'p' } }));
    expect(r.duplicate).toBe(false);
    const kinds = async () => { const out: string[] = []; for await (const e of l.events()) out.push(e.kind); return out; };
    expect(await kinds()).toEqual(['plan.generated']);
    let n = 10;
    const clock = { ids: () => `s${++n}`, now: () => n };
    expect(await stageAchievedPlans(l, 'r', clock)).toEqual([]); // not achieved yet
    await l.append(event('intention.done', { id: 'a3', at: 3, actor: loopActor, runId: 'r', trace: { intentionId: 'i', goalId: 'g', planId: 'p' }, payload: { intention: { id: 'i', goalId: 'g', planId: 'p' } } }));
    await l.append(event('goal.achieved', { id: 'a4', at: 4, actor: loopActor, runId: 'r', trace: { goalId: 'g' }, payload: {} }));
    expect(await stageAchievedPlans(l, 'r', clock)).toEqual(['p']);
    expect(await stageAchievedPlans(l, 'r', clock)).toEqual([]);
    expect(await kinds()).toEqual(['plan.generated', 'intention.done', 'goal.achieved', 'plan.staged']);
  });
});

describe('offline replay', () => {
  it('a recorded goal.achieved without passing verify evidence is NOT re-derived (disagreement reported)', async () => {
    const l = new MemoryLedger();
    const plan = { id: 'p', trigger: { kind: 'goal.adopted' }, context: [], steps: [{ id: 'v', kind: 'gate.verify', dependsOn: [], inputs: {} }], allowedModels: {}, permissions: { tools: [], write: [], approvals: [] }, budget: {}, origin: 'generated', status: 'candidate', goalKinds: [] };
    const t = { goalId: 'g', intentionId: 'i', planId: 'p' };
    await l.evidence({ key: 'vk', kind: 'gate.verify', runId: 'r', body: { outcome: 'failed', exitCode: 1, fingerprint: 'f', fingerprintAfter: 'f' } });
    const evs = [
      ev('goal.adopted', 1, { goal: { id: 'g', statement: 's' } }, { goalId: 'g' }),
      ev('plan.generated', 2, { plan }, { goalId: 'g', planId: 'p' }),
      ev('intention.pushed', 3, { intention: { id: 'i', goalId: 'g', planId: 'p' } }, t),
      ev('verify.passed', 4, { evidenceKey: 'vk' }, { ...t, stepId: 'v' }),
      ev('step.completed', 5, {}, { ...t, stepId: 'v' }),
      ev('goal.achieved', 6, { evidence: ['e4'] }, { goalId: 'g' }),
    ];
    for (const e of evs) await l.append(e);
    const r = await replayRun(l, 'r');
    expect(r.goals.g).toMatchObject({ derived: 'open', recorded: 'achieved', agrees: false });
    expect(r.problems.join(' ')).toMatch(/replay derives open, the ledger recorded achieved/);
    // honest, passing evidence for a goal that never committed is still not achieved (Phase 1 always commits:
    // the kernel derivation requires a recorded, approved commit); the fully committed run agrees (above)
    const l2 = new MemoryLedger();
    await l2.evidence({ key: 'vk', kind: 'gate.verify', runId: 'r', body: verifyBody() as never });
    for (const e of evs) await l2.append(e);
    const r2 = await replayRun(l2, 'r');
    expect(r2.goals.g).toMatchObject({ derived: 'open', agrees: false });
    expect(r2.goals.g!.why.join(' ')).toMatch(/no valid commit\.recorded|goal has no check/);
    expect((await replayRun(await achievedLedger(), 'r')).goals.g).toMatchObject({ derived: 'achieved', agrees: true });
  });
});
