import { describe, expect, it } from 'vitest';
import { canonicalJson, digest, sha256, type Json, type JsonObject } from './json.js';
import { noProgressReason } from './bdi.js';
import { event, type TeceraEvent } from './events.js';
import {
  FenceLost,
  FencedWriteGuard,
  WriteRefused,
  fenceOf,
  refusingWriteGuard,
  requireWriteGuard,
  writeActionHash,
} from './worker.js';
import {
  LedgerError,
  approvalGrantedEvent,
  commitActionHash,
  prActionHash,
  requireListEvidence,
  reviewEvidenceKey,
  verifyCommandDigest,
  type EvidenceRecord,
  type Ledger,
  type LLM,
  type LLMRequest,
} from './ports.js';
import { AccountingFailure, CallCancelled, chargeOf, meteredCall, meteredLLM } from './accounting.js';
import { GENESIS_HASH, chainHash, eventsChainProblem } from './chain.js';
import { achievedProofOf, activeRunOf, deriveGoalStatus } from './goalStatus.js';
import { openRunPools } from './accounting.js';
import type { Manifest } from './manifest.js';

describe('mutation-time fencing contract (next-steps 5)', () => {
  it('writeActionHash is sha256(canonicalJson({runId, intentionId, stepId, path, contentDigest})); any field change is another action', () => {
    const a = { runId: 'r', intentionId: 'i', stepId: 'edit', path: 'src/a.ts', contentDigest: 'd1' };
    expect(writeActionHash(a)).toBe(sha256(canonicalJson(a)));
    for (const k of Object.keys(a) as Array<keyof typeof a>) expect(writeActionHash({ ...a, [k]: `${a[k]}x` })).not.toBe(writeActionHash(a));
  });

  it('a FencedWriteGuard checks liveness at every call, not once: it throws FenceLost after the lease is lost mid-operation', () => {
    let lost: string | null = null;
    const ac = new AbortController();
    const g = new FencedWriteGuard({ live: () => lost, signal: ac.signal });
    expect(() => g.check()).not.toThrow();
    lost = 'fencing token changed 7 → 8';
    expect(() => g.check()).toThrow(FenceLost);
    expect(() => g.check()).toThrow(/fencing token changed/);
    lost = null;
    ac.abort(new Error('deadline'));
    expect(() => g.check()).toThrow(/deadline/);
    expect(g.signal.aborted).toBe(true);
  });

  it('a throwing liveness callback is a lost fence; authorizeWrite checks the fence first and requires a path and digest', () => {
    const g = new FencedWriteGuard({ live: () => { throw new Error('ledger down'); }, signal: new AbortController().signal });
    expect(() => g.check()).toThrow(FenceLost);
    expect(() => g.authorizeWrite({ path: 'a', contentDigest: 'd' })).toThrow(FenceLost);
    const ok = new FencedWriteGuard({ live: () => null, signal: new AbortController().signal });
    expect(ok.authorizeWrite({ path: 'a', contentDigest: 'd' })).toEqual({ kind: 'allowed' });
    expect(() => ok.authorizeWrite({ path: '', contentDigest: 'd' })).toThrow(WriteRefused);
  });

  it('no guard means no write: requireWriteGuard/refusingWriteGuard refuse, fenceOf reports false', () => {
    expect(() => requireWriteGuard(undefined).check()).toThrow(FenceLost);
    expect(requireWriteGuard(undefined).signal.aborted).toBe(true);
    expect(() => refusingWriteGuard('x').authorizeWrite!({ path: 'a', contentDigest: 'd' })).toThrow(FenceLost);
    expect(fenceOf(undefined)()).toBe(false);
    let live: string | null = null;
    const f = fenceOf(new FencedWriteGuard({ live: () => live, signal: new AbortController().signal }));
    expect(f()).toBe(true);
    live = 'gone';
    expect(f()).toBe(false);
  });

  it('the guard survives spread, JSON and structuredClone of the request that carries it (clones to {} instead of throwing)', () => {
    const g = new FencedWriteGuard({ live: () => null, signal: new AbortController().signal });
    const req = { runId: 'r', guard: g };
    expect({ ...req }.guard).toBe(g);
    expect(JSON.parse(JSON.stringify(req))).toEqual({ runId: 'r', guard: {} });
    expect(() => structuredClone(req)).not.toThrow();
    expect(canonicalJson(req as unknown as Json)).toBe('{"guard":{},"runId":"r"}');
  });

  it('reviewEvidenceKey and verifyCommandDigest match the gates formats', () => {
    expect(reviewEvidenceKey('r1', 'd1')).toBe('review:r1:d1');
    expect(verifyCommandDigest('node --test')).toBe(sha256('tecera.verify.command\0node --test'));
  });
});

describe('noProgressReason compares worker executions (ADV-8 precision)', () => {
  it('two verifies of the SAME worker execution are never no-progress, even across attempts', () => {
    expect(noProgressReason([{ attempt: 1, fingerprint: 'f', exec: 2 }, { attempt: 2, fingerprint: 'f', exec: 2 }])).toBeNull();
  });
  it('two different worker executions with the same candidate are no progress', () => {
    expect(noProgressReason([{ attempt: 1, fingerprint: 'f', exec: 2 }, { attempt: 2, fingerprint: 'f', exec: 3 }])).toMatch(/^no progress: attempts 1 and 2 .*worker executions 2 and 3/);
    expect(noProgressReason([{ attempt: 1, fingerprint: 'f', exec: 2 }, { attempt: 1, fingerprint: 'f', exec: 3 }])).toMatch(/two worker executions/);
  });
  it('entries without exec keep the per-attempt rule', () => {
    expect(noProgressReason([{ attempt: 1, fingerprint: 'f' }, { attempt: 1, fingerprint: 'f' }])).toBeNull();
    expect(noProgressReason([{ attempt: 1, fingerprint: 'f' }, { attempt: 2, fingerprint: 'f' }])).toMatch(/^no progress: attempts 1 and 2/);
  });
});

// ---------- accounting ----------

class PoolLedger {
  caps = new Map<string, number>();
  soft = new Set<string>();
  res = new Map<string, { pool: string; amount: number; state: 'reserved' | 'charged'; actual?: number }>();
  failReserve?: (pool: string) => Error | undefined;
  failSettle?: Error;
  async openBudget(_r: string, pool: string, cap: number, opts?: { enforce?: boolean }) {
    this.caps.set(pool, cap);
    if (opts?.enforce === false) this.soft.add(pool);
  }
  async reserve(pool: string, amount: number, runId: string, idemKey: string) {
    const f = this.failReserve?.(pool);
    if (f) throw f;
    const cap = this.caps.get(pool);
    if (cap === undefined) throw new LedgerError(`no budget opened for pool ${pool}`, 'budget');
    const used = this.used(pool);
    const over = used + amount > cap;
    if (over && !this.soft.has(pool)) throw new LedgerError(`budget exceeded for pool ${pool}`, 'budget');
    this.res.set(idemKey, { pool, amount, state: 'reserved' });
    return { id: idemKey, pool, amount, runId, ...(over ? { exhausted: { used, cap } } : {}) };
  }
  async settle(id: string, actual: number) {
    if (this.failSettle) throw this.failSettle;
    const r = this.res.get(id)!;
    r.state = 'charged';
    r.actual = actual;
  }
  used(pool: string): number {
    let n = 0;
    for (const r of this.res.values()) if (r.pool === pool) n += r.state === 'charged' ? r.actual! : r.amount;
    return n;
  }
  get ledger(): Ledger {
    return this as unknown as Ledger;
  }
}

const pools = async (caps: Record<string, number> = { calls: 10, usd: 10, tokens: 1e6 }) => {
  const l = new PoolLedger();
  for (const [p, c] of Object.entries(caps)) await l.openBudget('r', p, c);
  return l;
};

const fakeLLM = (usage: unknown, opts: { hang?: boolean; seen?: Array<AbortSignal | undefined> } = {}): LLM & { calls: number } => {
  const llm = {
    id: 'w1',
    provider: 'anthropic',
    calls: 0,
    async complete(_req: LLMRequest, signal?: AbortSignal) {
      llm.calls++;
      opts.seen?.push(signal);
      if (opts.hang) return new Promise<never>(() => undefined);
      return { content: 'ok', usage: usage as never, model: 'm', finishReason: 'stop' as const };
    },
  };
  return llm;
};
const req: LLMRequest = { seatId: 'worker', model: 'm', messages: [{ role: 'user', content: 'x' }] };
const RES = { usd: 0.5, tokens: 1000 };

describe('seat accounting: calls/usd/tokens per LLM call (next-steps 12)', () => {
  it('reserves calls, usd and tokens before the call and settles at the reported usage', async () => {
    const l = await pools();
    let during: number[] = [];
    await meteredCall(l.ledger, { runId: 'r', idemKey: 'k1', reservation: RES }, async (m) => {
      during = [l.used('calls'), l.used('usd'), l.used('tokens')];
      m.record({ inputTokens: 100, outputTokens: 20, usd: 0.01 });
    });
    expect(during).toEqual([1, 0.5, 1000]);
    expect([l.used('calls'), l.used('usd'), l.used('tokens')]).toEqual([1, 0.01, 120]);
  });

  it('malformed or unknown usage settles at the RESERVED amount, never zero; no report at all is the reservation', async () => {
    for (const bad of [undefined, null, 'x', { inputTokens: NaN, outputTokens: 1, usd: 1 }, { inputTokens: -1, outputTokens: 1, usd: 1 }, { inputTokens: 1, outputTokens: 1 }, { inputTokens: 0, outputTokens: 0, usd: 0 }]) {
      const l = await pools();
      await meteredCall(l.ledger, { runId: 'r', idemKey: 'k', reservation: RES }, async (m) => void m.record(bad as never));
      expect([l.used('usd'), l.used('tokens')], JSON.stringify(bad)).toEqual([0.5, 1000]);
    }
    const l = await pools();
    await meteredCall(l.ledger, { runId: 'r', idemKey: 'k', reservation: RES }, async () => undefined);
    expect([l.used('calls'), l.used('usd'), l.used('tokens')]).toEqual([1, 0.5, 1000]);
    expect(chargeOf({ inputTokens: 10, outputTokens: 0, usd: 0 }, RES)).toEqual({ usd: 0.5, tokens: 10, known: false });
  });

  it('usage flagged unknown:true (an estimate) is charged at least the reservation and stays unknown (Codex sprint-4 finding)', async () => {
    expect(chargeOf({ inputTokens: 1, outputTokens: 1, usd: 0.000001, unknown: true }, RES)).toEqual({ usd: 0.5, tokens: 1000, known: false });
    expect(chargeOf({ inputTokens: 5000, outputTokens: 1, usd: 0.9, unknown: true }, RES)).toEqual({ usd: 0.9, tokens: 5001, known: false });
    const l = await pools();
    await meteredCall(l.ledger, { runId: 'r', idemKey: 'k', reservation: RES }, async (m) => void m.record({ inputTokens: 1, outputTokens: 1, usd: 0.000001, unknown: true }));
    expect([l.used('usd'), l.used('tokens')]).toEqual([0.5, 1000]);
  });

  it('D3: a soft pool past its cap still reserves, runs and settles the call, and reports the exhaustion once per pool', async () => {
    const l = new PoolLedger();
    await l.openBudget('r', 'calls', 10, { enforce: false });
    await l.openBudget('r', 'usd', 0.1, { enforce: false });
    await l.openBudget('r', 'tokens', 1e6, { enforce: false });
    const seen: unknown[] = [];
    const out = await meteredCall(l.ledger, { runId: 'r', idemKey: 'k', reservation: RES, purpose: 'planner', onExhausted: (e) => void seen.push(e) }, async (m) => {
      m.record({ inputTokens: 10, outputTokens: 10, usd: 0.2 });
      return 'ran';
    });
    expect(out).toBe('ran');
    expect(seen).toEqual([{ pool: 'usd', used: 0, cap: 0.1, amount: 0.5, purpose: 'planner' }]);
    expect(l.used('usd')).toBeCloseTo(0.2);
    // an enforced pool still refuses (budgets.enforce true)
    const hard = await pools({ calls: 10, usd: 0.1, tokens: 1e6 });
    await expect(meteredCall(hard.ledger, { runId: 'r', idemKey: 'k', reservation: RES }, async () => 1)).rejects.toMatchObject({ code: 'budget', pool: 'usd' });
  });

  it('openRunPools opens usd/tokens/calls/wallMs from the manifest, soft unless budgets.enforce', async () => {
    const opened: Array<[string, number, unknown]> = [];
    const fake = { openBudget: async (_r: string, p: string, c: number, o?: unknown) => void opened.push([p, c, o]) } as unknown as Ledger;
    const budgets = { usd: 2, tokens: 200000, wallClockSec: 1200, maxDepth: 3, maxIterations: 20, maxAttempts: 2, maxChangedFiles: 5, enforce: false };
    await openRunPools(fake, 'r', { budgets } as Manifest, { callsCap: 400 });
    expect(opened).toEqual([
      ['usd', 2, { enforce: false }],
      ['tokens', 200000, { enforce: false }],
      ['calls', 400, { enforce: false }],
      ['wallMs', 1_200_000, { enforce: false }],
    ]);
    opened.length = 0;
    await openRunPools(fake, 'r', { budgets: { ...budgets, enforce: true } } as Manifest, { callsCap: 9 });
    expect(opened.every(([, , o]) => (o as { enforce: boolean }).enforce === true)).toBe(true);
  });

  it('an exhausted or unopened calls pool refuses before the call (AccountingFailure budget) and releases what it reserved', async () => {
    const l = await pools({ calls: 0, usd: 10, tokens: 1e6 });
    const llm = fakeLLM({ inputTokens: 1, outputTokens: 1, usd: 0.01 });
    const err = await meteredLLM(llm, { ledger: l.ledger, runId: 'r', reservation: RES }).complete(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountingFailure);
    expect(err).toMatchObject({ code: 'budget', pool: 'calls' });
    expect(llm.calls).toBe(0);
    const none = await pools({ usd: 10, tokens: 1e6 });
    await expect(meteredCall(none.ledger, { runId: 'r', idemKey: 'k', reservation: RES }, async () => 1)).rejects.toMatchObject({ name: 'AccountingFailure', code: 'budget' });
    const partial = await pools({ calls: 5, usd: 10, tokens: 1 });
    await expect(meteredCall(partial.ledger, { runId: 'r', idemKey: 'k', reservation: RES }, async () => 1)).rejects.toMatchObject({ code: 'budget', pool: 'tokens' });
    expect([partial.used('calls'), partial.used('usd')]).toEqual([0, 0]);
  });

  it('a non-budget reserve failure or any settle failure is AccountingFailure ledger; a settle failure discards the result', async () => {
    const l = await pools();
    l.failReserve = (p) => (p === 'usd' ? new LedgerError('disk I/O', 'io') : undefined);
    await expect(meteredCall(l.ledger, { runId: 'r', idemKey: 'k', reservation: RES }, async () => 1)).rejects.toMatchObject({ name: 'AccountingFailure', code: 'ledger' });
    const s = await pools();
    s.failSettle = new LedgerError('database is locked', 'io');
    await expect(meteredCall(s.ledger, { runId: 'r', idemKey: 'k', reservation: RES }, async () => 'result')).rejects.toMatchObject({ name: 'AccountingFailure', code: 'ledger', message: expect.stringMatching(/could not settle/) });
  });

  it('cancellation (deadline / lease loss) aborts the in-flight call signal, stops waiting at once and charges at least the reservation', async () => {
    const l = await pools();
    const run = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const llm = fakeLLM({ inputTokens: 1, outputTokens: 1, usd: 0.01 }, { hang: true, seen });
    const p = meteredLLM(llm, { ledger: l.ledger, runId: 'r', reservation: RES, signal: () => run.signal }).complete(req);
    await new Promise((r) => setTimeout(r, 5));
    run.abort(new Error('lease lost'));
    await expect(p).rejects.toThrow(/lease lost/);
    expect(seen[0]!.aborted).toBe(true);
    expect([l.used('calls'), l.used('usd'), l.used('tokens')]).toEqual([1, 0.5, 1000]);
    const pre = new AbortController();
    pre.abort('deadline');
    await expect(meteredCall(l.ledger, { runId: 'r', idemKey: 'k2', reservation: RES, signal: pre.signal }, async () => 1)).rejects.toBeInstanceOf(CallCancelled);
    expect(l.used('calls')).toBe(1); // nothing reserved for a call that never started
  });

  it('every seat wrapped by meteredLLM reserves a call: the third call on a 2-call pool is refused', async () => {
    const l = await pools({ calls: 2, usd: 10, tokens: 1e6 });
    const llm = fakeLLM({ inputTokens: 1, outputTokens: 1, usd: 0.01 });
    const m = meteredLLM(llm, { ledger: l.ledger, runId: 'r', reservation: RES });
    await m.complete(req);
    await m.complete(req);
    await expect(m.complete(req)).rejects.toMatchObject({ code: 'budget', pool: 'calls' });
    expect(llm.calls).toBe(2);
  });
});

// ---------- evidence enumeration ----------

describe('requireListEvidence', () => {
  it('fails closed when the ledger cannot enumerate evidence', async () => {
    await expect(requireListEvidence({} as Ledger, 'r')).rejects.toMatchObject({ name: 'LedgerError', code: 'evidence' });
    const l = { listEvidence: async (runId: string, p?: string) => [{ key: `${runId}:${p}` }] } as unknown as Ledger;
    await expect(requireListEvidence(l, 'r', 'gate.')).resolves.toEqual([{ key: 'r:gate.' }]);
  });
});

// ---------- replay goal derivation ----------

type Ev = TeceraEvent & { seq: number; hash: string };
const sys = { kind: 'system' as const, id: 'loop' };
const human = { kind: 'human' as const, id: 'nick' };
const CHECK = { command: 'node --test', timeoutSec: 60 };
const trace = (stepId?: string) => ({ goalId: 'g', intentionId: 'i1', planId: 'p', ...(stepId ? { stepId } : {}) });

function chain(list: TeceraEvent[]): Ev[] {
  let prev = GENESIS_HASH;
  return list.map((e, n) => {
    const hash = chainHash(prev, e);
    prev = hash;
    return { ...e, seq: n + 1, hash };
  });
}

function scenario(o: { evidenceRun?: string; command?: string; grantActor?: { kind: 'human' | 'agent'; id: string }; consumeAfterPr?: boolean; noGrant?: boolean; bound?: string; noProof?: boolean; proofKey?: string; noPr?: boolean; prSha?: string; plan?: 'none' | 'commit-only' } = {}) {
  const ah = prActionHash({ intentionId: 'i1', stepId: 'pr', attempt: 1, sha: o.bound ?? 'abc' });
  const n = { i: 0 };
  const id = () => `e${++n.i}`;
  const mk = (kind: TeceraEvent['kind'], payload: JsonObject, tr: TeceraEvent['trace'] = {}, actor = sys) => event(kind, { id: id(), at: n.i, actor, payload, trace: tr, runId: 'r1' });
  const intention = { id: 'i1', goalId: 'g', planId: 'p', commitment: 'single-minded', status: 'committed', stepStatus: {}, attempt: 1 };
  const grant = approvalGrantedEvent({ id: 'grant1', at: 50, requestId: 'ap1', runId: 'r1', sessionId: 's', actionHash: ah, approver: (o.grantActor ?? human) as { kind: 'human'; id: string }, trace: trace('pr') });
  const steps = [
    { id: 'verify', kind: 'gate.verify', dependsOn: [], inputs: {} },
    ...(o.plan === 'none' ? [] : [{ id: 'commit', kind: 'gate.commit', dependsOn: ['verify'], inputs: {} }]),
    ...(o.plan === undefined ? [{ id: 'pr', kind: 'gate.pr', dependsOn: ['commit'], inputs: {} }] : []),
  ];
  const plan = { id: 'p', trigger: { kind: 'goal.adopted' }, context: [], steps, allowedModels: {}, permissions: { tools: [], write: [], approvals: ['open_pr'] }, budget: {}, origin: 'generated', status: 'candidate', goalKinds: [] };
  const proof = { command: CHECK.command, exitCode: 0, fingerprint: 'fp1', evidenceKey: o.proofKey ?? 'v1', verifiedAt: 4 };
  const prEvents: TeceraEvent[] = o.plan !== undefined || o.noPr
    ? []
    : [
        mk('approval.requested', { requestId: 'ap1', actionHash: ah, sessionId: 's', candidateD1: o.bound ?? 'abc', attempt: 1 }, trace('pr')),
        ...(o.noGrant ? [] : [grant]),
        ...(o.consumeAfterPr ? [] : [mk('approval.consumed', { requestId: 'ap1', by: 'gate.pr' }, trace('pr'))]),
        mk('pr.opened', { sha: o.prSha ?? 'abc', url: 'https://example.test/pr/1', approvalRequestId: 'ap1', evidenceKey: 'pr1' }, trace('pr')),
        ...(o.consumeAfterPr ? [mk('approval.consumed', { requestId: 'ap1', by: 'gate.pr' }, trace('pr'))] : []),
      ];
  const list: TeceraEvent[] = [
    mk('run.started', { manifestHash: 'h' }),
    mk('goal.adopted', { goal: { id: 'g', statement: 's', check: CHECK, commitment: 'single-minded', status: 'open', evidence: [] } }, { goalId: 'g' }),
    mk('plan.generated', { plan: plan as unknown as JsonObject }, { goalId: 'g', planId: 'p' }),
    mk('intention.pushed', { intention }, trace()),
    mk('verify.passed', { evidenceKey: 'v1', fingerprint: 'fp1', exitCode: 0, attempt: 1 }, trace('verify')),
    ...(o.plan === 'none' ? [] : [mk('commit.recorded', { sha: 'abc', valid: true, evidenceKey: 'c1', d1: 'fp1' }, trace('commit'))]),
    ...prEvents,
    mk('intention.done', { intention: { ...intention, status: 'done' } }, trace()),
    mk('goal.achieved', { goal: { id: 'g', check: CHECK }, ...(o.noProof ? {} : { proof }) }, { goalId: 'g' }),
  ];
  const events = chain(list);
  const body: Json = { command: o.command ?? CHECK.command, commandDigest: verifyCommandDigest(o.command ?? CHECK.command), timeoutSec: 60, exitCode: 0, outcome: 'passed', fingerprint: 'fp1' };
  const evidence: EvidenceRecord[] = [{ key: 'v1', kind: 'gate.verify', runId: o.evidenceRun ?? 'r1', digest: digest(body), body, seq: 4 }];
  return { events, evidence };
}

describe('deriveGoalStatus (replay evidence binding; D4 proof, D6 PR chain)', () => {
  it('achieved: same-command verify evidence of this run, valid chain, commit without approval, PR opened on an audited approval bound to the committed sha, goal.achieved proof', () => {
    const { events, evidence } = scenario();
    const d = deriveGoalStatus(events, evidence);
    expect(d.chainValid).toBe(true);
    expect(d.goals.g).toMatchObject({ status: 'achieved', recorded: 'achieved', agrees: true, proof: { intentionId: 'i1', verifyEvidenceKey: 'v1', sha: 'abc', approvalRequestId: 'ap1', prUrl: 'https://example.test/pr/1', achievement: { evidenceKey: 'v1', fingerprint: 'fp1', exitCode: 0 } } });
  });

  it('D4: goal.achieved without a proof, or with a proof naming another verify, derives nothing', () => {
    for (const o of [{ noProof: true }, { proofKey: 'v-other' }]) {
      const { events, evidence } = scenario(o);
      const g = deriveGoalStatus(events, evidence).goals.g!;
      expect(g.status, JSON.stringify(o)).toBe('open');
      expect(g.agrees).toBe(false);
      expect(g.reasons.join(' ')).toMatch(/proof/);
    }
  });

  it('same-run evidence of ANOTHER command cannot derive achievement', () => {
    const { events, evidence } = scenario({ command: 'true' });
    const g = deriveGoalStatus(events, evidence).goals.g!;
    expect(g.status).toBe('open');
    expect(g.agrees).toBe(false);
    expect(g.reasons.join(' ')).toMatch(/another command/);
  });

  it('evidence from another run, a tampered body, or a missing record derives nothing', () => {
    const other = scenario({ evidenceRun: 'r0' });
    expect(deriveGoalStatus(other.events, other.evidence).goals.g!.status).toBe('open');
    const t = scenario();
    const tampered = [{ ...t.evidence[0]!, body: { ...(t.evidence[0]!.body as JsonObject), exitCode: 0, outcome: 'passed', extra: 1 } }];
    const d = deriveGoalStatus(t.events, tampered);
    expect(d.chainValid).toBe(false);
    expect(d.goals.g!.status).toBe('open');
    expect(deriveGoalStatus(t.events, []).goals.g!.reasons.join(' ')).toMatch(/missing or invalid/);
  });

  it('a broken or partial chain derives nothing achieved; so does a failing ledger ChainVerdict', () => {
    const { events, evidence } = scenario();
    const forged = events.map((e) => (e.kind === 'verify.passed' ? { ...e, payload: { ...e.payload, fingerprint: 'fp1', forged: true } } : e));
    expect(eventsChainProblem(forged)).toMatch(/broken at seq 5/);
    expect(deriveGoalStatus(forged, evidence).goals.g!.status).toBe('open');
    expect(deriveGoalStatus(events.slice(1), evidence).chainValid).toBe(false);
    expect(deriveGoalStatus(events, evidence, { chain: { ok: false, brokenAtSeq: 3 } }).goals.g!.status).toBe('open');
  });

  it('D6 approval at the PR: no grant, a non-human grant, consumption after the PR, or a binding to another sha → not achieved', () => {
    for (const o of [{ noGrant: true }, { grantActor: { kind: 'agent' as const, id: 'w' } }, { consumeAfterPr: true }, { bound: 'other-sha' }]) {
      const { events, evidence } = scenario(o);
      const g = deriveGoalStatus(events, evidence).goals.g!;
      expect(g.status, JSON.stringify(o)).toBe('open');
      expect(g.reasons.join(' '), JSON.stringify(o)).toMatch(/approval/);
    }
  });

  it('D6 chain as the plan says: a plan with gate.pr needs a PR for the committed sha; commit-only and verify-only plans need only what they contain', () => {
    const noPr = scenario({ noPr: true });
    expect(deriveGoalStatus(noPr.events, noPr.evidence).goals.g!.reasons.join(' ')).toMatch(/no pr.opened or pr.requested/);
    const wrongSha = scenario({ prSha: 'zzz' });
    expect(deriveGoalStatus(wrongSha.events, wrongSha.evidence).goals.g!.status).toBe('open');
    const commitOnly = scenario({ plan: 'commit-only' });
    expect(deriveGoalStatus(commitOnly.events, commitOnly.evidence).goals.g!).toMatchObject({ status: 'achieved', proof: { sha: 'abc' } });
    const verifyOnly = scenario({ plan: 'none' });
    expect(deriveGoalStatus(verifyOnly.events, verifyOnly.evidence).goals.g!.status).toBe('achieved');
  });

  it('approval rows, when supplied, must be consumed and match the request', () => {
    const { events, evidence } = scenario();
    const ah = prActionHash({ intentionId: 'i1', stepId: 'pr', attempt: 1, sha: 'abc' });
    expect(ah).toBe(commitActionHash({ intentionId: 'i1', stepId: 'pr', attempt: 1, candidateD1: 'abc' }));
    const row = { requestId: 'ap1', runId: 'r1', sessionId: 's', actionHash: ah, requester: { kind: 'agent' as const, id: 'loop' }, state: 'consumed' as const, expiresAt: 1e12, approver: human };
    expect(deriveGoalStatus(events, evidence, { approvals: [row] }).goals.g!.status).toBe('achieved');
    expect(deriveGoalStatus(events, evidence, { approvals: [{ ...row, state: 'granted' }] }).goals.g!.status).toBe('open');
    expect(deriveGoalStatus(events, evidence, { approvals: [] }).goals.g!.status).toBe('open');
  });
});

describe('stop hook inputs (D4)', () => {
  it('activeRunOf: the latest started run without run.ended; achievedProofOf: a well-formed, undemoted proof for every goal', () => {
    const { events } = scenario();
    expect(activeRunOf(events)).toEqual({ runId: 'r1', goalId: 'g' });
    expect(achievedProofOf(events, 'r1')).toMatchObject({ evidenceKey: 'v1', exitCode: 0 });
    const ended = [...events, event('run.ended', { id: 'end', at: 99, actor: sys, payload: { exitCode: 0 }, trace: {}, runId: 'r1' })];
    expect(activeRunOf(ended)).toBeNull();
    const noProof = scenario({ noProof: true });
    expect(achievedProofOf(noProof.events, 'r1')).toBeNull();
    const demoted = [...events, event('goal.demoted', { id: 'dm', at: 99, actor: sys, payload: {}, trace: { goalId: 'g' }, runId: 'r1' })];
    expect(achievedProofOf(demoted, 'r1')).toBeNull();
    expect(activeRunOf([])).toBeNull();
  });
});
