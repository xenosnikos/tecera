import { describe, expect, it } from 'vitest';
import { reconcileVerdict, type Ledger } from '@tecera/contracts';
import { createGates, type CreateGatesOptions } from './index.js';
import { ctx, FakeReviewer, FakeRunner, LEDGERS, liveGuard, makeRepo, manifest, NOW, WRITERS, type Repo } from './testkit/fixtures.js';

/**
 * Mutation-time fence at the commit gate (contracts GateContext.guard; Codex next-step 5 "include commit
 * mutation"; kernel sprint-3 gap for the gates lane). commit() refuses without a guard, and checks it
 * immediately before every repository mutation: a fence lost at any point stops everything after it.
 * reconcile() proves read-only without a guard and repairs only under one.
 */

async function prepared(ledger: Ledger, extra: Partial<CreateGatesOptions> = {}) {
  const repo = makeRepo();
  repo.write('src/a.ts', 'export const a = 2;\n');
  const make = (more: Partial<CreateGatesOptions> = {}) =>
    createGates({ manifest: manifest(), ledger, verifyRunner: new FakeRunner(), reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1', ...extra, ...more });
  const gates = make();
  const v = await gates.verify(ctx('v', { worktree: repo.dir }));
  const r = await gates.review(ctx('r', { worktree: repo.dir, candidate: { d1: v.fingerprint } }));
  expect(r.verdict).toBe('approve');
  const commitCtx = (o: Parameters<typeof ctx>[1] = {}) => ctx('c', { worktree: repo.dir, candidate: { d1: v.fingerprint, d2: r.fingerprint }, ...o });
  return { repo, ledger, gates, make, commitCtx };
}

const objectCount = (r: Repo) => r.g('count-objects', '-v').split('\n').find((l) => l.startsWith('count:'))!;
const noBranch = (r: Repo) => expect(() => r.g('rev-parse', '--verify', '--quiet', 'refs/heads/tecera/g1')).toThrow();

describe.each(LEDGERS)('commit gate write guard (%s)', (_n, mk) => {
  it('no guard in GateContext → 9 no-write-guard before anything: no objects written, no branch', async () => {
    const s = await prepared(mk());
    const objects = objectCount(s.repo);
    const r = await s.gates.commit(s.commitCtx({ guard: null }));
    expect(r).toMatchObject({ exitCode: 9, reason: 'no-write-guard', terminal: true, failure: 'human' });
    expect(objectCount(s.repo)).toBe(objects);
    noBranch(s.repo);
    // A malformed guard (no check/signal) is no guard.
    expect(await s.gates.commit({ ...s.commitCtx(), guard: {} as never })).toMatchObject({ exitCode: 9, reason: 'no-write-guard' });
  });

  it('a guard already lost (lease taken over) → 9 fence-lost before the first object write', async () => {
    const s = await prepared(mk());
    const g = liveGuard();
    g.revoke('lease taken over by another holder');
    const objects = objectCount(s.repo);
    const r = await s.gates.commit(s.commitCtx({ guard: g.guard }));
    expect(r).toMatchObject({ exitCode: 9, reason: 'fence-lost', terminal: true, failure: 'human' });
    expect(objectCount(s.repo)).toBe(objects);
    noBranch(s.repo);
  });

  it('fence lost after staging, before the intent claim: 9 fence-lost, no intent, nothing moves', async () => {
    const g = liveGuard();
    const s = await prepared(mk(), { commitTestHooks: { afterStage: () => g.revoke() } });
    const r = await s.gates.commit(s.commitCtx({ guard: g.guard }));
    expect(r).toMatchObject({ exitCode: 9, reason: 'fence-lost' });
    expect(await s.ledger.getEvidence('commit-intent:run1:i1:c:0')).toBeNull();
    noBranch(s.repo);
    expect(s.repo.g('symbolic-ref', 'HEAD').trim()).toBe('refs/heads/main');
  });

  it('fence lost after update-ref: HEAD is never moved by the stale holder; the new holder reconciles HEAD and index under its own guard', async () => {
    const stale = liveGuard();
    const s = await prepared(mk(), { commitTestHooks: { afterUpdateRef: () => stale.revoke('lease lost mid-commit') } });
    const r = await s.gates.commit(s.commitCtx({ guard: stale.guard }));
    expect(r).toMatchObject({ exitCode: 9, reason: 'fence-lost', terminal: true });
    // The branch moved; HEAD and the index did not.
    expect(s.repo.g('symbolic-ref', 'HEAD').trim()).toBe('refs/heads/main');
    const sha = s.repo.g('rev-parse', 'refs/heads/tecera/g1').trim();
    // The new holder: a fresh instance with a live guard.
    const fresh = s.make({ commitTestHooks: {} });
    const g2 = liveGuard();
    const rec = await fresh.reconcile({ ...s.commitCtx({ guard: g2.guard }), recovered: true });
    expect(reconcileVerdict(rec)).toMatchObject({ recorded: true, sha });
    expect(s.repo.g('symbolic-ref', 'HEAD').trim()).toBe('refs/heads/tecera/g1');
    expect(s.repo.g('write-tree').trim()).toBe(s.repo.g('rev-parse', 'HEAD^{tree}').trim());
    expect(g2.checks).toBeGreaterThanOrEqual(2);
  });

  it('every git mutation is preceded by a check: revoking at the Nth check stops at that mutation', async () => {
    // Count the checks of a successful commit, then revoke at each one in turn: never a partial success.
    const probe = liveGuard();
    const ok = await prepared(mk());
    expect((await ok.gates.commit(ok.commitCtx({ guard: probe.guard }))).exitCode).toBe(0);
    const total = probe.checks;
    // hash-object (1 change) + write-tree + intent claim + commit-tree + update-ref + symbolic-ref + read-tree
    expect(total).toBeGreaterThanOrEqual(7);
    for (let n = 1; n <= total; n++) {
      const g = liveGuard();
      let seen = 0;
      g.onCheck = () => {
        if (++seen === n) g.revoke(`revoked at check ${n}`);
      };
      const s = await prepared(mk());
      const r = await s.gates.commit(s.commitCtx({ guard: g.guard }));
      expect(r, `check ${n}`).toMatchObject({ exitCode: 9, reason: 'fence-lost', terminal: true });
      expect(await s.ledger.getEvidence('commit:run1:i1:c:0'), `check ${n}`).toBeNull();
      // HEAD never moves unless the symbolic-ref check passed, which is one of the last two checks.
      if (n < total - 1) expect(s.repo.g('symbolic-ref', 'HEAD').trim(), `check ${n}`).toBe('refs/heads/main');
    }
  });

  it('review with a lost guard: the packet (object writes) is refused before any write; the reviewer is not asked', async () => {
    const repo = makeRepo();
    repo.write('src/a.ts', 'export const a = 2;\n');
    const ledger = mk();
    const reviewer = new FakeReviewer('openai');
    const g = createGates({ manifest: manifest(), ledger, verifyRunner: new FakeRunner(), reviewer, writers: WRITERS, worktree: repo.dir, now: () => NOW });
    const lost = liveGuard();
    lost.revoke();
    const objects = objectCount(repo);
    const r = await g.review(ctx('r', { worktree: repo.dir, guard: lost.guard }));
    expect(r).toMatchObject({ verdict: 'reject', reason: 'incomplete-packet', terminal: true, failure: 'human' });
    expect(reviewer.calls).toHaveLength(0);
    expect(objectCount(repo)).toBe(objects);
  });
});
