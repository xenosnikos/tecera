import { describe, expect, it } from 'vitest';
import { event, type Ledger } from '@tecera/contracts';
import { SqliteLedger } from '@tecera/ledger';
import { createGates } from './index.js';
import { ctx, FakeReviewer, FakeRunner, LOOP, makeRepo, manifest, NOW, sqlitePath, withBudget, WRITERS, type Repo } from './testkit/fixtures.js';

/**
 * Two gate runners on two SEPARATE SqliteLedger connections to the same database file (two processes in
 * miniature: separate memos, separate connections, one worktree). Exactly-once must come from the ledger
 * (claims) and from git (update-ref with the expected old value), not from shared memory.
 */

function twoConnections(): { path: string; a: Ledger; b: Ledger } {
  const path = sqlitePath();
  const a = withBudget(new SqliteLedger(path));
  const b = new SqliteLedger(path);
  return { path, a, b };
}

function gatesOn(ledger: Ledger, repo: Repo, reviewer: FakeReviewer) {
  return createGates({ manifest: manifest(), ledger, verifyRunner: new FakeRunner(), reviewer, writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1' });
}

const trace = (stepId: string) => ({ goalId: 'g1', intentionId: 'i1', stepId });

describe('separate SqliteLedger connections', () => {
  it('concurrent reviews of the same D1 from two connections ask the reviewer exactly once', async () => {
    const { a, b } = twoConnections();
    const repo = makeRepo();
    repo.write('src/a.ts', 'export const a = 2;\n');
    let release!: () => void;
    const open = new Promise<void>((r) => (release = r));
    const reviewer = new FakeReviewer('openai', async () => (await open, '{"verdict":"approve","findings":[]}'));
    const ga = gatesOn(a, repo, reviewer);
    const gb = gatesOn(b, repo, reviewer);
    const v = await ga.verify(ctx('v', { worktree: repo.dir }));
    const c = ctx('r', { worktree: repo.dir, candidate: { d1: v.fingerprint } });
    const both = Promise.all([ga.review(c), gb.review(c)]);
    setTimeout(release, 150);
    const results = await both;
    expect(reviewer.calls).toHaveLength(1);
    expect(results.filter((r) => r.verdict === 'approve').length).toBeGreaterThanOrEqual(1);
    for (const r of results) if (r.verdict !== 'approve') expect(r).toMatchObject({ reason: 'claimed', terminal: true });
  });

  it('concurrent commits of the same step from two connections: exactly one commit (intent claim + update-ref CAS)', async () => {
    const { a, b } = twoConnections();
    const repo = makeRepo();
    repo.write('src/a.ts', 'export const a = 2;\n');
    const reviewer = new FakeReviewer('openai');
    const ga = gatesOn(a, repo, reviewer);
    const v = await ga.verify(ctx('v', { worktree: repo.dir }));
    const r = await ga.review(ctx('r', { worktree: repo.dir, candidate: { d1: v.fingerprint } }));
    // The loop's events carry the evidence keys, so the second process (empty memo) finds D1/D2 on the ledger.
    await a.append(event('verify.passed', { id: 'e1', at: NOW, actor: LOOP, runId: 'run1', trace: trace('v'), payload: { exitCode: 0, evidenceKey: v.evidenceKey } }));
    await a.append(event('review.passed', { id: 'e2', at: NOW, actor: LOOP, runId: 'run1', trace: trace('r'), payload: { verdict: 'approve', evidenceKey: r.evidenceKey } }));
    const gb = gatesOn(b, repo, reviewer);
    const commitCtx = ctx('c', { worktree: repo.dir, candidate: { d1: v.fingerprint, d2: r.fingerprint } });
    const results = await Promise.all([ga.commit(commitCtx), gb.commit(commitCtx)]);
    const ok = results.filter((x) => x.exitCode === 0);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((x) => x.sha)).size).toBe(1);
    for (const x of results) if (x.exitCode !== 0) expect(x.terminal).toBe(true);
    expect(repo.g('rev-list', '--count', 'main..tecera/g1').trim()).toBe('1');
    // Either connection reads the same final record.
    expect((await b.getEvidence('commit:run1:i1:c:0'))!.body).toMatchObject({ outcome: 'committed', sha: ok[0]!.sha });
  });

  it('a commit recorded through one connection is returned through the other, never made twice', async () => {
    const { a, b } = twoConnections();
    const repo = makeRepo();
    repo.write('src/a.ts', 'export const a = 2;\n');
    const ga = gatesOn(a, repo, new FakeReviewer('openai'));
    const v = await ga.verify(ctx('v', { worktree: repo.dir }));
    const r = await ga.review(ctx('r', { worktree: repo.dir, candidate: { d1: v.fingerprint } }));
    const c = ctx('c', { worktree: repo.dir, candidate: { d1: v.fingerprint, d2: r.fingerprint } });
    const first = await ga.commit(c);
    expect(first.exitCode).toBe(0);
    const second = await gatesOn(b, repo, new FakeReviewer('openai')).commit(c);
    expect(second).toMatchObject({ exitCode: 0, sha: first.sha, reconciled: true });
    expect(repo.g('rev-list', '--count', 'main..tecera/g1').trim()).toBe('1');
  });

});
