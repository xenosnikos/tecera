import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRedactor, type Json, type Ledger } from '@tecera/contracts';
import { claim, ignoredBaseline, ignoredBaselineKey } from './evidence.js';
import { GateMemo } from './evidence.js';
import { createGates } from './index.js';
import { ctx, FakeReviewer, FakeRunner, LEDGERS, prGrant, makeRepo, manifest, NOW, recordVerify, WRITERS } from './testkit/fixtures.js';

/**
 * Canary scans across EVERY evidence record the gates write (verify, verify start, baseline, ignored
 * baseline, review claim, review, commit intent, commit, refusals): the body as handed to the ledger and as
 * read back. Known secrets are checked raw and in the encodings the shared redactor covers; canaries by
 * pattern. Secret-bearing names go through ignored paths, verify output, reviewer/provider metadata and the
 * goal statement.
 */

const KNOWN = 'hunter2-gates-known-secret-0042';
const CANARY = 'TECERA_CANARY_gates_wave3_1';
const enc = (v: string) => [v, Buffer.from(v).toString('hex'), Buffer.from(v).toString('base64'), Buffer.from(v).toString('base64url'), encodeURIComponent(v + '/x').slice(0, -4)];
const NEEDLES = [...enc(KNOWN), CANARY, 'TECERA_CANARY_'];

class SpyLedger {
  readonly written: Array<{ key: string; body: Json }> = [];
  constructor(readonly inner: Ledger) {
    const orig = inner.evidence.bind(inner);
    inner.evidence = async (e) => {
      this.written.push({ key: e.key, body: e.body });
      return orig(e);
    };
  }
  async scan(): Promise<string[]> {
    const hits: string[] = [];
    for (const w of this.written) {
      const stored = await this.inner.getEvidence(w.key);
      for (const [where, text] of [
        ['written', JSON.stringify(w.body)],
        ['stored', JSON.stringify(stored?.body ?? null)],
        ['key', w.key],
      ] as const) {
        for (const n of NEEDLES) if (text.includes(n)) hits.push(`${w.key} (${where}) contains ${n === KNOWN ? 'the known secret' : n.slice(0, 12) + '…'}`);
      }
    }
    return hits;
  }
}

describe.each(LEDGERS)('every gate evidence record is free of secrets and canaries (%s)', (_n, mk) => {
  it('baseline paths, verify output, claim metadata, reviewer/provider metadata, goal statement, commit intent', async () => {
    const repo = makeRepo();
    // Ignored files present on the untouched tree, named with secrets in several encodings.
    repo.write(`ignored/${KNOWN}.js`, 'module.exports = 1;\n');
    repo.write(`ignored/${CANARY}.js`, 'module.exports = 2;\n');
    repo.write(`ignored/${Buffer.from(KNOWN).toString('hex')}.js`, 'x\n');
    repo.write(`ignored/${Buffer.from(KNOWN).toString('base64url')}.js`, 'y\n');
    const spy = new SpyLedger(mk());
    const ledger = spy.inner;
    const runner = new FakeRunner(() => ({ stdout: `ok ${KNOWN} ${Buffer.from(KNOWN).toString('base64')} ${CANARY}`, stderr: Buffer.from(KNOWN).toString('hex') }));
    const reviewer = new FakeReviewer('openai', () => '{"verdict":"approve","findings":[]}', `openai-${KNOWN}`, `kf-${KNOWN}`);
    const opts = { manifest: manifest(), ledger, verifyRunner: runner, reviewer, writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1', secrets: [KNOWN], reviewModel: `gpt-${CANARY}` };
    const first = createGates(opts);
    expect((await first.baseline({ runId: 'run1' })).exitCode).toBe(0);

    // Restart: a fresh instance reads the redacted baseline back and still matches every unchanged file.
    const g = createGates(opts);
    repo.write('src/a.ts', 'export const a = 2;\n');
    const goalCtx = (step: 'v' | 'r' | 'c', o: Parameters<typeof ctx>[1] = {}) => {
      const c = ctx(step, { worktree: repo.dir, ...o });
      return { ...c, goal: { ...c.goal, statement: `fix it ${KNOWN} ${CANARY}` } };
    };
    const v = await g.verify(goalCtx('v'));
    expect(v.exitCode).toBe(0);
    const r = await g.review(goalCtx('r', { candidate: { d1: v.fingerprint } }));
    expect(r.verdict).toBe('approve');
    const c = await g.commit(goalCtx('c', { candidate: { d1: v.fingerprint, d2: r.fingerprint } }));
    expect(c.exitCode).toBe(0);
    expect(repo.g('log', '-1', '--format=%B')).not.toContain(KNOWN);

    // A deletion of a secret-named baseline file is refused, and its display name is redacted too.
    rmSync(join(repo.dir, `ignored/${KNOWN}.js`));
    const v2 = await g.verify(goalCtx('v', { intentionId: 'i2' }));
    const body = JSON.stringify((await ledger.getEvidence(v2.evidenceKey))!.body);
    expect(body).toMatch(/"deleted":true/);

    const kinds = new Set(spy.written.map((w) => w.key.split(':')[0]));
    for (const k of ['verify-baseline-ignored', 'verify-baseline', 'verify-start', 'verify', 'review-claim', 'review', 'commit-intent', 'commit']) expect(kinds, k).toContain(k);
    expect(await spy.scan()).toEqual([]);
    // The baseline record holds keys and redacted names only.
    const base = (await ledger.getEvidence(ignoredBaselineKey('run1')))!.body as { entries: Record<string, string>; names: Record<string, string> };
    expect(Object.keys(base.entries)).toHaveLength(4);
    expect(Object.values(base.names).filter((n) => n.includes('[REDACTED:'))).toHaveLength(4);
  });

  it('refusal evidence (PR approval refused) and an ignored commit approval are scanned too; a secret-bearing patch is never delivered', async () => {
    const repo = makeRepo();
    const spy = new SpyLedger(mk());
    const runsDir = mkdtempSync(join(tmpdir(), 'tecera-gates-runs-'));
    const g = createGates({ manifest: manifest(), ledger: spy.inner, verifyRunner: new FakeRunner(), reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1', secrets: [KNOWN], runsDir, gh: null });
    repo.write(`src/${CANARY}.ts`, `export const k = '${KNOWN}';\n`);
    const withGoal = <T extends ReturnType<typeof ctx>>(c: T): T => ({ ...c, goal: { ...c.goal, statement: `ship ${KNOWN} ${CANARY}` } });
    const v = await g.verify(withGoal(ctx('v', { worktree: repo.dir })));
    await recordVerify(spy.inner, v);
    const r = await g.review(withGoal(ctx('r', { worktree: repo.dir, candidate: { d1: v.fingerprint } })));
    // D6: a grant handed to gate.commit is ignored (its id is recorded redacted), the commit proceeds.
    const c = await g.commit(withGoal(ctx('c', { worktree: repo.dir, candidate: { d1: v.fingerprint, d2: r.fingerprint }, approval: { requestId: `ap-${CANARY}`, sessionId: 's1', actionHash: 'f'.repeat(64) } })));
    expect(c.exitCode).toBe(0);
    const bogus = await g.pr(withGoal(ctx('pr', { worktree: repo.dir, commit: { sha: c.sha!, evidenceKey: c.evidenceKey }, approval: { requestId: `ap-${CANARY}`, sessionId: 's1', actionHash: 'f'.repeat(64) } })));
    expect(bogus).toMatchObject({ exitCode: 8, reason: 'approval' });
    // The committed change itself carries the secret and the canary: no redaction can leave a valid patch, so
    // the delivery is refused whole (pr.failed), the grant is not spent and nothing is bundled.
    const ap = await prGrant(spy.inner, { sha: c.sha! });
    const refused = await g.pr(withGoal(ctx('pr', { worktree: repo.dir, commit: { sha: c.sha!, evidenceKey: c.evidenceKey }, approval: ap })));
    expect(refused).toMatchObject({ exitCode: 8, reason: 'secret-in-delivery', terminal: true });
    expect((await spy.inner.getApproval(ap.requestId))!.state).toBe('granted');
    expect(existsSync(join(runsDir, 'run1', 'pr'))).toBe(false);
    expect(await spy.scan()).toEqual([]);
  });
});

describe.each(LEDGERS)('a registered secret inside a run or intention id never reaches an evidence key or a returned result (%s)', (_n, mk) => {
  it('keys carry a digest of the identifier; the gates still find their own records (commit → PR)', async () => {
    const repo = makeRepo();
    const spy = new SpyLedger(mk());
    const runsDir = mkdtempSync(join(tmpdir(), 'tecera-gates-runs-'));
    const g = createGates({ manifest: manifest(), ledger: spy.inner, verifyRunner: new FakeRunner(), reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1', secrets: [KNOWN], runsDir, gh: null });
    repo.write('src/a.ts', 'export const a = 2;\n');
    const intentionId = `i-${KNOWN}`;
    const v = await g.verify(ctx('v', { worktree: repo.dir, intentionId }));
    expect(v.exitCode).toBe(0);
    await recordVerify(spy.inner, v, { intentionId });
    const r = await g.review(ctx('r', { worktree: repo.dir, intentionId, candidate: { d1: v.fingerprint } }));
    expect(r.verdict).toBe('approve');
    const c = await g.commit(ctx('c', { worktree: repo.dir, intentionId, candidate: { d1: v.fingerprint, d2: r.fingerprint } }));
    expect(c.exitCode).toBe(0);
    // the PR gate finds the commit record under the same digest key (its body names the id only redacted, so
    // delivery for such an id is refused, fail closed), and its refusal carries no secret either
    expect(c.evidenceKey).toMatch(/^commit:h_[0-9a-f]{24}$/);
    const ap = await prGrant(spy.inner, { sha: c.sha!, intentionId });
    const pr = await g.pr(ctx('pr', { worktree: repo.dir, intentionId, commit: { sha: c.sha!, evidenceKey: c.evidenceKey }, approval: ap }));
    expect(pr.reason).not.toBe('commit-evidence-key-mismatch');
    for (const res of [v, r, c, pr]) expect(JSON.stringify(res)).not.toContain(KNOWN);
    expect(spy.written.length).toBeGreaterThan(0);
    for (const w of spy.written) expect(w.key, w.key).not.toContain(KNOWN);
    expect(await spy.scan()).toEqual([]);
    // an identifier without a secret keeps its readable key
    const plain = await g.verify(ctx('v', { worktree: repo.dir, intentionId: 'i9' }));
    expect(plain.evidenceKey).toMatch(/^verify:run1:i9:v:0:\d+$/);
  });
});

describe.each(LEDGERS)('a registered secret in a RUN id, or on a refused path, never reaches an evidence key or a result (%s)', (_n, mk) => {
  it('an intention id with a secret on the refused-verify path (unsafe repository): the fallback key carries a digest', async () => {
    const repo = makeRepo();
    repo.g('config', 'core.hooksPath', '.hooks');
    const spy = new SpyLedger(mk());
    const g = createGates({ manifest: manifest(), ledger: spy.inner, verifyRunner: new FakeRunner(), reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1', secrets: [KNOWN] });
    repo.write('src/a.ts', 'export const a = 2;\n');
    const v = await g.verify(ctx('v', { worktree: repo.dir, intentionId: `i-${KNOWN}` }));
    expect(v.exitCode).not.toBe(0);
    expect(v.evidenceKey).toMatch(/^verify-refused:h_[0-9a-f]{24}:/);
    expect(JSON.stringify(v)).not.toContain(KNOWN);
    expect(spy.written.length).toBeGreaterThan(0);
    for (const w of spy.written) expect(w.key, w.key).not.toContain(KNOWN);
  });

  it('a run id with a secret: verify, baseline and review refuse (their shared keys are derived from the raw id) and no key holds it', async () => {
    const repo = makeRepo();
    const spy = new SpyLedger(mk());
    const g = createGates({ manifest: manifest(), ledger: spy.inner, verifyRunner: new FakeRunner(), reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1', secrets: [KNOWN] });
    repo.write('src/a.ts', 'export const a = 2;\n');
    const runId = `run-${KNOWN}`;
    const base = await g.baseline({ runId, worktree: repo.dir });
    expect(base.exitCode).not.toBe(0);
    expect(base.evidenceKey).toMatch(/^verify-baseline:h_[0-9a-f]{24}:/);
    const v = await g.verify(ctx('v', { worktree: repo.dir, runId }));
    expect(v).toMatchObject({ outcome: 'refused' });
    expect(v.exitCode).not.toBe(0);
    const r = await g.review(ctx('r', { worktree: repo.dir, runId }));
    expect(r).toMatchObject({ verdict: 'reject', reason: 'incomplete-packet' });
    for (const res of [base, v, r]) expect(JSON.stringify(res)).not.toContain(KNOWN);
    expect(spy.written.length).toBe(3);
    for (const w of spy.written) expect(w.key, w.key).not.toContain(KNOWN);
  });
});

describe('claim() and the ignored baseline write through the redactor', () => {
  it('claim metadata is redacted; the winner is still recognised by its nonce', async () => {
    const ledger = LEDGERS[0]![1]();
    const redactor = makeRedactor([KNOWN]);
    const c = await claim(ledger, redactor, 'k1', 'gate.review.claim', 'run1', { note: `${KNOWN} ${CANARY}`, provider: { id: KNOWN } });
    expect(c.won).toBe(true);
    const body = JSON.stringify((await ledger.getEvidence('k1'))!.body);
    expect(body).not.toContain(KNOWN);
    expect(body).not.toContain(CANARY);
    expect((await claim(ledger, redactor, 'k1', 'gate.review.claim', 'run1', { note: 'x' })).won).toBe(false);
  });

  it('a malformed persisted baseline is treated as absent (nothing excused)', async () => {
    const ledger = LEDGERS[0]![1]();
    await ledger.evidence({ key: ignoredBaselineKey('run1'), kind: 'gate.verify.baseline.ignored', runId: 'run1', body: { v: 2, entries: { 'not-a-key': 'x' } } });
    expect(await ignoredBaseline(ledger, new GateMemo(), 'run1')).toBeUndefined();
  });
});
