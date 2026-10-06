import { describe, expect, it } from 'vitest';
import type { Ledger, LLM, LLMRequest, LLMResponse } from '@tecera/contracts';
import { MemoryLedger } from '@tecera/ledger';
import { createGates } from './index.js';
import { ReviewGate } from './reviewGate.js';
import { ctx, FakeReviewer, FakeRunner, LEDGERS, makeRepo, manifest, NOW, withBudget, WRITERS, type Repo } from './testkit/fixtures.js';

/**
 * Reviewer seat settlement (Codex sprint-3 'Missing tests'; next-step 12 for the reviewer seat) and S5
 * (next-step 10) at the gate.
 *
 * Accounting goes through contracts meteredCall: 'calls', 'usd' and 'tokens' are reserved before the call
 * and settled after it; malformed, missing or zero usage settles at the reservation; a settle or non-budget
 * reserve failure is a terminal 'ledger' result that discards the verdict.
 */

const APPROVE = '{"verdict":"approve","findings":[]}';

class UsageReviewer implements LLM {
  readonly provider = 'openai';
  readonly keyFingerprint = 'kf-openai';
  readonly id = 'openai-reviewer';
  calls: LLMRequest[] = [];
  constructor(private readonly usage: unknown, private readonly content: unknown = APPROVE, private readonly gate?: Promise<void>) {}
  async complete(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    this.calls.push(req);
    if (this.gate) {
      await new Promise<void>((resolve, reject) => {
        void this.gate!.then(resolve);
        signal?.addEventListener('abort', () => reject(new Error('aborted by signal')), { once: true });
      });
    }
    return { content: this.content, usage: this.usage, model: req.model, finishReason: 'stop' } as unknown as LLMResponse;
  }
}

function setup(ledger: Ledger, reviewer: LLM, o: { maxAttempts?: number; reservation?: { usd: number; tokens?: number } | null } = {}) {
  const repo = makeRepo();
  repo.write('src/a.ts', 'export const a = 2;\n');
  const gate = new ReviewGate({ reviewer, writers: WRITERS, ledger, worktree: repo.dir, base: 'main', ...(o.maxAttempts ? { maxAttempts: o.maxAttempts } : {}), ...(o.reservation !== undefined ? { reservation: o.reservation } : {}) });
  return { repo, gate, c: ctx('r', { worktree: repo.dir }) };
}

/** How much of a pool is charged: the largest probe reservation that still fits, by bisection. */
async function headroom(ledger: Ledger, pool: string, cap: number): Promise<number> {
  let lo = 0;
  let hi = cap;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const fits = await ledger.reserve(pool, mid, 'run1', `probe-${pool}-${i}-${mid}`).then(
      async (r) => (await ledger.settle(r.id, 0), true),
      () => false,
    );
    if (fits) lo = mid;
    else hi = mid;
  }
  return lo;
}

describe.each(LEDGERS)('reviewer seat settlement (%s)', (_n, mk) => {
  const MALFORMED: Array<[string, unknown]> = [
    ['usage missing', undefined],
    ['usage null', null],
    ['usd NaN', { inputTokens: 10, outputTokens: 5, usd: Number.NaN }],
    ['usd negative', { inputTokens: 10, outputTokens: 5, usd: -1 }],
    ['tokens as strings', { inputTokens: '10', outputTokens: '5', usd: 0.001 }],
    ['zero usd and zero tokens (unknown, not free)', { inputTokens: 0, outputTokens: 0, usd: 0 }],
  ];
  for (const [name, usage] of MALFORMED) {
    it(`malformed usage (${name}) settles at the reservation, never at zero; the review itself still completes`, async () => {
      const ledger = withBudget(mk(), 'run1', { usd: 1, tokens: 100_000, calls: 10 });
      const s = setup(ledger, new UsageReviewer(usage), { reservation: { usd: 0.25, tokens: 20_000 } });
      const r = await s.gate.review(s.c);
      expect(r.verdict).toBe('approve');
      // Charged the full reservation: 0.75 usd and 80k tokens left, one call spent.
      expect(await headroom(ledger, 'usd', 1)).toBeCloseTo(0.75, 3);
      expect(await headroom(ledger, 'tokens', 100_000)).toBeCloseTo(80_000, -1);
      expect(await headroom(ledger, 'calls', 10)).toBeCloseTo(9, 3);
      const body = (await ledger.getEvidence(r.evidenceKey))!.body as Record<string, unknown>;
      expect(body.usage === null || typeof body.usage === 'object').toBe(true);
    });
  }

  it('well-formed usage settles at the reported amounts', async () => {
    const ledger = withBudget(mk(), 'run1', { usd: 1, tokens: 100_000, calls: 10 });
    const s = setup(ledger, new UsageReviewer({ inputTokens: 100, outputTokens: 50, usd: 0.01 }), { reservation: { usd: 0.25, tokens: 20_000 } });
    expect((await s.gate.review(s.c)).verdict).toBe('approve');
    expect(await headroom(ledger, 'usd', 1)).toBeCloseTo(0.99, 3);
    expect(await headroom(ledger, 'tokens', 100_000)).toBeCloseTo(99_850, -1);
  });

  it('the calls pool is reserved too: an exhausted (or unopened) calls pool refuses before the call (terminal budget)', async () => {
    const ledger = withBudget(mk(), 'run1', { calls: 0 });
    const reviewer = new UsageReviewer({ inputTokens: 1, outputTokens: 1, usd: 0.001 });
    const s = setup(ledger, reviewer);
    expect(await s.gate.review(s.c)).toMatchObject({ verdict: 'reject', reason: 'budget', terminal: true, failure: 'budget' });
    expect(reviewer.calls).toHaveLength(0);
    // The usd/tokens reservations taken before calls was refused were released (charged 0).
    expect(await headroom(ledger, 'usd', 100)).toBeCloseTo(100, 3);
  });

  it('a settle failure after an APPROVING call is a terminal "ledger" result: the verdict is discarded and the commit refuses', async () => {
    const ledger = withBudget(mk());
    ledger.settle = async () => {
      throw new Error('disk full');
    };
    const repo = makeRepo();
    repo.write('src/a.ts', 'export const a = 2;\n');
    const reviewer = new FakeReviewer('openai', () => APPROVE);
    const g = createGates({ manifest: manifest(), ledger, verifyRunner: new FakeRunner(), reviewer, writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1' });
    const v = await g.verify(ctx('v', { worktree: repo.dir }));
    const r = await g.review(ctx('r', { worktree: repo.dir, candidate: { d1: v.fingerprint } }));
    expect(reviewer.calls).toHaveLength(1);
    expect(r).toMatchObject({ verdict: 'reject', reason: 'ledger', terminal: true, failure: 'ledger' });
    const body = (await ledger.getEvidence(r.evidenceKey))!.body as Record<string, unknown>;
    expect(body).toMatchObject({ verdict: 'reject', reason: 'ledger', failure: 'ledger', findings: [] });
    expect(String(body.error)).toMatch(/ledger: reviewer seat/);
    expect(await g.commit(ctx('c', { worktree: repo.dir, candidate: { d1: v.fingerprint, d2: r.fingerprint } }))).toMatchObject({ exitCode: 8, reason: 'review-not-approved' });
  });

  it('a non-budget reserve failure is a terminal "ledger" result and the reviewer is never asked', async () => {
    const ledger = withBudget(mk());
    ledger.reserve = async () => {
      throw new Error('database is locked');
    };
    const reviewer = new UsageReviewer({ inputTokens: 1, outputTokens: 1, usd: 0.001 });
    const s = setup(ledger, reviewer);
    expect(await s.gate.review(s.c)).toMatchObject({ verdict: 'reject', reason: 'ledger', terminal: true, failure: 'ledger' });
    expect(reviewer.calls).toHaveLength(0);
  });

  it('cancellation mid-call (deadline / lease loss) stops waiting at once and settles at least the reservation', async () => {
    const ledger = withBudget(mk(), 'run1', { usd: 1, tokens: 100_000, calls: 10 });
    const never = new Promise<void>(() => undefined);
    const reviewer = new UsageReviewer({ inputTokens: 1, outputTokens: 1, usd: 0.001 }, APPROVE, never);
    const s = setup(ledger, reviewer, { reservation: { usd: 0.25, tokens: 20_000 } });
    const ac = new AbortController();
    const p = s.gate.review({ ...s.c, signal: ac.signal });
    while (reviewer.calls.length === 0) await new Promise((r) => setTimeout(r, 5));
    ac.abort(new Error('deadline'));
    const r = await p;
    expect(r).toMatchObject({ verdict: 'reject', reason: 'reviewer-error' });
    expect(await headroom(ledger, 'usd', 1)).toBeCloseTo(0.75, 3);
  });
});

describe.each(LEDGERS)('S5 at the gate: recovered review and review.maxAttempts (%s)', (_n, mk) => {
  /** First process: the reviewer call never returns (the process "dies" inside it). */
  async function lostReview(ledger: Ledger, repo: Repo, maxAttempts: number): Promise<void> {
    let reached!: () => void;
    const at = new Promise<void>((r) => (reached = r));
    const dying = new FakeReviewer('openai', () => (reached(), new Promise<string>(() => undefined)));
    const g = new ReviewGate({ reviewer: dying, writers: WRITERS, ledger, worktree: repo.dir, base: 'main', maxAttempts });
    void g.review(ctx('r', { worktree: repo.dir }));
    await at;
  }
  const repoWithChange = () => {
    const repo = makeRepo();
    repo.write('src/a.ts', 'export const a = 2;\n');
    return repo;
  };

  it('maxAttempts 1: recovered with no verdict → terminal "interrupted" (human); the reviewer is NOT called', async () => {
    const ledger = withBudget(mk());
    const repo = repoWithChange();
    await lostReview(ledger, repo, 1);
    const second = new FakeReviewer('openai');
    const g = new ReviewGate({ reviewer: second, writers: WRITERS, ledger, worktree: repo.dir, base: 'main', maxAttempts: 1 });
    expect(await g.review({ ...ctx('r', { worktree: repo.dir }), recovered: true })).toMatchObject({ verdict: 'reject', reason: 'interrupted', terminal: true, failure: 'human' });
    expect(second.calls).toHaveLength(0);
  });

  it('maxAttempts 1: recovered with no claim at all (died before the claim) still counts the lost call: human, no call', async () => {
    const ledger = withBudget(mk());
    const repo = repoWithChange();
    const reviewer = new FakeReviewer('openai');
    const g = new ReviewGate({ reviewer, writers: WRITERS, ledger, worktree: repo.dir, base: 'main', maxAttempts: 1 });
    expect(await g.review({ ...ctx('r', { worktree: repo.dir }), recovered: true })).toMatchObject({ reason: 'interrupted', terminal: true, failure: 'human' });
    expect(reviewer.calls).toHaveLength(0);
  });

  it('maxAttempts 2: one lost call → the recovered review is allowed exactly one more call, under its own claim and reservation', async () => {
    const ledger = withBudget(mk(), 'run1', { usd: 1 });
    const repo = repoWithChange();
    await lostReview(ledger, repo, 2);
    const second = new FakeReviewer('openai');
    const g = new ReviewGate({ reviewer: second, writers: WRITERS, ledger, worktree: repo.dir, base: 'main', maxAttempts: 2 });
    const r = await g.review({ ...ctx('r', { worktree: repo.dir }), recovered: true });
    expect(r).toMatchObject({ verdict: 'approve', reason: 'approved', terminal: false });
    expect(second.calls).toHaveLength(1);
    const d1 = r.fingerprint!;
    expect(await ledger.getEvidence(`review-claim:run1:${d1}`)).not.toBeNull();
    expect(await ledger.getEvidence(`review-claim:run1:${d1}:2`)).not.toBeNull();
    expect((await ledger.getEvidence(`review:run1:${d1}`))!.body).toMatchObject({ verdict: 'approve', reviewAttempt: 2, recovered: true });
    // Both calls are charged: the lost one's reservation stays reserved (0.25), the second settled at its usage.
    await expect(ledger.reserve('usd', 0.8, 'run1', 'probe')).rejects.toThrow(/budget/);
    // A third recovery reuses the verdict: no further call.
    const third = new FakeReviewer('openai');
    const g3 = new ReviewGate({ reviewer: third, writers: WRITERS, ledger, worktree: repo.dir, base: 'main', maxAttempts: 2 });
    expect(await g3.review({ ...ctx('r', { worktree: repo.dir }), recovered: true })).toMatchObject({ verdict: 'approve', reused: true });
    expect(third.calls).toHaveLength(0);
  });

  it('maxAttempts 2: two lost calls → the next recovered review stops for a human without a third call', async () => {
    const ledger = withBudget(mk());
    const repo = repoWithChange();
    await lostReview(ledger, repo, 2);
    // The second (recovered) call dies too.
    let reached!: () => void;
    const at = new Promise<void>((r) => (reached = r));
    const dying = new FakeReviewer('openai', () => (reached(), new Promise<string>(() => undefined)));
    void new ReviewGate({ reviewer: dying, writers: WRITERS, ledger, worktree: repo.dir, base: 'main', maxAttempts: 2 }).review({ ...ctx('r', { worktree: repo.dir }), recovered: true });
    await at;
    const third = new FakeReviewer('openai');
    const g = new ReviewGate({ reviewer: third, writers: WRITERS, ledger, worktree: repo.dir, base: 'main', maxAttempts: 2 });
    expect(await g.review({ ...ctx('r', { worktree: repo.dir }), recovered: true })).toMatchObject({ reason: 'interrupted', terminal: true, failure: 'human' });
    expect(third.calls).toHaveLength(0);
  });

  it('maxAttempts 2 never lets a LIVE (not recovered) call take a second slot: concurrent/in-flight claims stay at-most-once', async () => {
    const ledger = withBudget(mk());
    const repo = repoWithChange();
    await lostReview(ledger, repo, 2);
    const live = new FakeReviewer('openai');
    const g = new ReviewGate({ reviewer: live, writers: WRITERS, ledger, worktree: repo.dir, base: 'main', maxAttempts: 2 });
    expect(await g.review(ctx('r', { worktree: repo.dir }))).toMatchObject({ reason: 'claimed', terminal: true, failure: 'human' });
    expect(live.calls).toHaveLength(0);
  });

  it('createGates takes review.maxAttempts from the manifest', async () => {
    const ledger = withBudget(mk());
    const repo = repoWithChange();
    await lostReview(ledger, repo, 2);
    const second = new FakeReviewer('openai');
    const g = createGates({ manifest: manifest({ review: { foreign: true, maxAttempts: 2 } }), ledger, verifyRunner: new FakeRunner(), reviewer: second, writers: WRITERS, worktree: repo.dir, now: () => NOW });
    expect((await g.review({ ...ctx('r', { worktree: repo.dir }), recovered: true })).verdict).toBe('approve');
    expect(second.calls).toHaveLength(1);
  });

  it('a malformed maxAttempts allows only the first call (fail closed)', async () => {
    const ledger = withBudget(mk());
    const repo = repoWithChange();
    await lostReview(ledger, repo, 1);
    const second = new FakeReviewer('openai');
    const g = new ReviewGate({ reviewer: second, writers: WRITERS, ledger, worktree: repo.dir, base: 'main', maxAttempts: Number.NaN });
    expect(await g.review({ ...ctx('r', { worktree: repo.dir }), recovered: true })).toMatchObject({ reason: 'interrupted' });
    expect(second.calls).toHaveLength(0);
  });
});

describe('reviewer seat without a calls pool (MemoryLedger)', () => {
  it('only usd/tokens opened (the pre-wave-4 fixture shape) → terminal budget, no call', async () => {
    const ledger = new MemoryLedger();
    await ledger.openBudget('run1', 'usd', 10);
    await ledger.openBudget('run1', 'tokens', 1_000_000);
    const reviewer = new FakeReviewer('openai');
    const s = setup(ledger, reviewer);
    expect(await s.gate.review(s.c)).toMatchObject({ reason: 'budget', failure: 'budget' });
    expect(reviewer.calls).toHaveLength(0);
  });
});
