import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRedactor, type Ledger } from '@tecera/contracts';
import { createGates } from './index.js';
import { writeEvidence } from './evidence.js';
import { intentionBranchName, preparationKeys, workBranchOf } from './intentionBranch.js';
import { ctx, FakeReviewer, FakeRunner, LEDGERS, makeRepo, manifest, NOW, prGrant, recordVerify, WRITERS, type Repo } from './testkit/fixtures.js';

/**
 * One work branch per intention, on temp git repositories with the real gates. Intention A (i1) commits to
 * tecera/g1 and is superseded before its PR; intention B (i2) is prepared onto tecera/g1.2 at the base (the
 * runtime's preparation is reproduced here with plain git and the same record) and goes through verify,
 * review and commit on its own.
 */

const redactor = makeRedactor([]);
const EDIT = 'export const a = 2;\n';

interface Two {
  repo: Repo;
  ledger: Ledger;
  gates: ReturnType<typeof createGates>;
  reviewer: FakeReviewer;
  base: string;
  a: { sha: string; d1: string; commitKey: string };
}

/** Intention A through verify, review and commit on tecera/g1. */
async function committedA(ledger: Ledger = LEDGERS[0]![1]()): Promise<Two> {
  const repo = makeRepo();
  const base = repo.g('rev-parse', 'HEAD').trim();
  repo.write('src/a.ts', EDIT);
  const reviewer = new FakeReviewer('openai');
  const gates = createGates({ manifest: manifest(), ledger, verifyRunner: new FakeRunner(), reviewer, writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1', runsDir: mkdtempSync(join(tmpdir(), 'tecera-gates-runs-')), gh: null });
  const v = await gates.verify(ctx('v', { worktree: repo.dir }));
  await recordVerify(ledger, v, { at: NOW - 1 });
  const r = await gates.review(ctx('r', { worktree: repo.dir, candidate: { d1: v.fingerprint } }));
  const c = await gates.commit(ctx('c', { worktree: repo.dir, candidate: { d1: v.fingerprint, d2: r.fingerprint } }));
  expect(c).toMatchObject({ exitCode: 0, terminal: false });
  expect(repo.g('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('tecera/g1');
  return { repo, ledger, gates, reviewer, base, a: { sha: c.sha!, d1: v.fingerprint, commitKey: c.evidenceKey } };
}

/** What the runtime's preparation does to the repository: the branch at the base, HEAD on it, the tree reset. */
function resetOnto(repo: Repo, branch: string, base: string): void {
  repo.g('update-ref', `refs/heads/${branch}`, base, '0'.repeat(40));
  repo.g('symbolic-ref', 'HEAD', `refs/heads/${branch}`);
  repo.g('read-tree', '--reset', '-u', `${base}^{tree}`);
  repo.g('clean', '-f', '-d', '-q');
}

async function record(ledger: Ledger, o: { branch: string; base: string; intentionId?: string }): Promise<void> {
  const intentionId = o.intentionId ?? 'i2';
  await writeEvidence(ledger, redactor, {
    key: preparationKeys(redactor, 'run1', intentionId).done,
    kind: 'intention.prepared',
    runId: 'run1',
    body: { intentionId, previousIntentionId: 'i1', goalId: 'g1', ordinal: 2, base: 'main', baseSha: o.base, branch: o.branch, previousBranch: 'tecera/g1', fencingToken: 2 },
  });
}

const B = { intentionId: 'i2', branch: 'tecera/g1.2' } as const;
const bCtx = (repo: Repo, step: 'v' | 'r' | 'c' | 'pr', o: Parameters<typeof ctx>[1] = {}) => ({ ...ctx(step, { worktree: repo.dir, intentionId: B.intentionId, ...o }), branch: B.branch });

describe('naming rule', () => {
  it('the first intention keeps <prefix><goal>; the n-th gets <prefix><goal>.<n>', () => {
    expect(intentionBranchName('tecera/', 'fix-failing-test', 1)).toBe('tecera/fix-failing-test');
    expect(intentionBranchName('tecera/', 'fix-failing-test', 2)).toBe('tecera/fix-failing-test.2');
    expect(intentionBranchName('tecera/', 'fix-failing-test', 3)).toBe('tecera/fix-failing-test.3');
    // an ordinal that is not a later one never invents a suffix
    expect(intentionBranchName('tecera/', 'g', 0)).toBe('tecera/g');
    expect(intentionBranchName('tecera/', 'g', 1.5)).toBe('tecera/g');
  });
});

describe('intention B after A committed', () => {
  it('without a preparation the commit gate still refuses a second commit on top of A (head-not-base)', async () => {
    const s = await committedA();
    s.repo.write('src/a.ts', 'export const a = 3;\n');
    const v = await s.gates.verify(ctx('v', { worktree: s.repo.dir, intentionId: 'i2' }));
    const r = await s.gates.review(ctx('r', { worktree: s.repo.dir, intentionId: 'i2', candidate: { d1: v.fingerprint } }));
    const c = await s.gates.commit(ctx('c', { worktree: s.repo.dir, intentionId: 'i2', candidate: { d1: v.fingerprint, d2: r.fingerprint } }));
    expect(c).toMatchObject({ exitCode: 9, reason: 'head-not-base', terminal: true });
    expect(s.repo.g('rev-parse', 'tecera/g1').trim()).toBe(s.a.sha);
  });

  it('prepared onto its own branch: B commits on tecera/g1.2 with the base as parent, A\'s branch is unchanged, and B has its own verify and review evidence even for byte-identical content', async () => {
    const s = await committedA();
    resetOnto(s.repo, B.branch, s.base);
    await record(s.ledger, { branch: B.branch, base: s.base });
    // B's worker writes exactly what A's did
    s.repo.write('src/a.ts', EDIT);
    const reviews = s.reviewer.calls.length;
    const v = await s.gates.verify(bCtx(s.repo, 'v'));
    expect(v.exitCode).toBe(0);
    // the same bytes on the same base, and still not A's candidate
    expect(v.fingerprint).not.toBe(s.a.d1);
    expect(v.evidenceKey).not.toMatch(/:i1:/);
    const r = await s.gates.review(bCtx(s.repo, 'r', { candidate: { d1: v.fingerprint } }));
    expect(r).toMatchObject({ verdict: 'approve', reason: 'approved' });
    expect(r.reused).toBeUndefined();
    expect(s.reviewer.calls.length).toBe(reviews + 1);
    expect(r.evidenceKey).toBe(`review:run1:${v.fingerprint}`);
    const c = await s.gates.commit(bCtx(s.repo, 'c', { candidate: { d1: v.fingerprint, d2: r.fingerprint } }));
    expect(c).toMatchObject({ exitCode: 0, terminal: false });
    expect(s.repo.g('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(B.branch);
    expect(s.repo.g('rev-parse', B.branch).trim()).toBe(c.sha);
    expect(s.repo.g('rev-parse', `${c.sha}^`).trim()).toBe(s.base);
    expect(c.sha).not.toBe(s.a.sha);
    // A is exactly where it was, one commit on the base; main never moved
    expect(s.repo.g('rev-parse', 'tecera/g1').trim()).toBe(s.a.sha);
    expect(s.repo.g('rev-parse', `${s.a.sha}^`).trim()).toBe(s.base);
    expect(s.repo.g('rev-parse', 'main').trim()).toBe(s.base);
    expect(s.repo.g('log', '-1', '--format=%B', c.sha!)).toMatch(/Tecera-Intention: i2/);
  });

  it('A\'s PR approval cannot deliver B: the PR gate refuses it for B\'s commit and the grant stays unspent; B\'s own approval delivers B\'s branch', async () => {
    const s = await committedA();
    const grantA = await prGrant(s.ledger, { sha: s.a.sha, requestId: 'prA' });
    resetOnto(s.repo, B.branch, s.base);
    await record(s.ledger, { branch: B.branch, base: s.base });
    s.repo.write('src/a.ts', EDIT);
    const v = await s.gates.verify(bCtx(s.repo, 'v'));
    await recordVerify(s.ledger, v, { at: NOW - 1, intentionId: 'i2' });
    const r = await s.gates.review(bCtx(s.repo, 'r', { candidate: { d1: v.fingerprint } }));
    const c = await s.gates.commit(bCtx(s.repo, 'c', { candidate: { d1: v.fingerprint, d2: r.fingerprint } }));
    expect(c.exitCode).toBe(0);
    const commit = { sha: c.sha!, d1: v.fingerprint, evidenceKey: c.evidenceKey };
    const withA = await s.gates.pr(bCtx(s.repo, 'pr', { approval: grantA, commit }));
    expect(withA).toMatchObject({ exitCode: 8, terminal: true, outcome: 'refused' });
    expect((await s.ledger.getApproval('prA'))?.state).toBe('granted');
    // nor may B present A's commit as its own
    const stolen = await s.gates.pr(bCtx(s.repo, 'pr', { approval: grantA, commit: { sha: s.a.sha, d1: s.a.d1, evidenceKey: s.a.commitKey } }));
    expect(stolen).toMatchObject({ exitCode: 9, reason: 'commit-of-another-intention' });
    expect((await s.ledger.getApproval('prA'))?.state).toBe('granted');
    const grantB = await prGrant(s.ledger, { sha: c.sha!, requestId: 'prB', intentionId: 'i2' });
    const ok = await s.gates.pr(bCtx(s.repo, 'pr', { approval: grantB, commit }));
    expect(ok).toMatchObject({ exitCode: 0, outcome: 'requested', branch: B.branch, sha: c.sha });
    expect((await s.ledger.getApproval('prB'))?.state).toBe('consumed');
    expect((await s.ledger.getApproval('prA'))?.state).toBe('granted');
  });

  it('the branch comes from the preparation record, never from the context alone', async () => {
    const s = await committedA();
    resetOnto(s.repo, B.branch, s.base);
    s.repo.write('src/a.ts', EDIT);
    // a context that names a branch nobody prepared: every gate refuses
    expect(await s.gates.verify(bCtx(s.repo, 'v'))).toMatchObject({ exitCode: 9, terminal: true, outcome: 'refused' });
    expect(await s.gates.review(bCtx(s.repo, 'r'))).toMatchObject({ verdict: 'reject', terminal: true });
    expect(await s.gates.commit(bCtx(s.repo, 'c'))).toMatchObject({ exitCode: 9, reason: 'branch-not-prepared' });
    // a record, and a context that omits the branch or names another one
    await record(s.ledger, { branch: B.branch, base: s.base });
    expect(await s.gates.commit(ctx('c', { worktree: s.repo.dir, intentionId: 'i2' }))).toMatchObject({ exitCode: 9, reason: 'branch-mismatch' });
    expect(await s.gates.commit({ ...bCtx(s.repo, 'c'), branch: 'tecera/g1.3' })).toMatchObject({ exitCode: 9, reason: 'branch-mismatch' });
    expect(await s.gates.verify(ctx('v', { worktree: s.repo.dir, intentionId: 'i2' }))).toMatchObject({ exitCode: 9, outcome: 'refused' });
    // nothing was committed anywhere by any of it
    expect(s.repo.g('rev-parse', B.branch).trim()).toBe(s.base);
    expect(s.repo.g('rev-parse', 'tecera/g1').trim()).toBe(s.a.sha);
  });

  it('a record that names the goal\'s first branch, a branch outside the prefix, or another intention is refused', async () => {
    for (const [branch, intentionId] of [['tecera/g1', 'i2'], ['other/g1.2', 'i2']] as const) {
      const s = await committedA();
      await record(s.ledger, { branch, base: s.base, intentionId });
      const w = await workBranchOf(s.ledger, redactor, 'tecera/', { ...ctx('c', { intentionId: 'i2' }), branch });
      expect(w).toMatchObject({ ok: false, reason: 'bad-preparation-record' });
    }
    const s = await committedA();
    // i3's key holding a record written for i2
    await writeEvidence(s.ledger, redactor, { key: preparationKeys(redactor, 'run1', 'i3').done, kind: 'intention.prepared', runId: 'run1', body: { intentionId: 'i2', previousIntentionId: 'i1', goalId: 'g1', ordinal: 2, base: 'main', baseSha: s.base, branch: B.branch, fencingToken: 2 } });
    expect(await workBranchOf(s.ledger, redactor, 'tecera/', { ...ctx('c', { intentionId: 'i3' }), branch: B.branch })).toMatchObject({ ok: false, reason: 'bad-preparation-record' });
    // the first intention, no record: the goal's first branch
    expect(await workBranchOf(s.ledger, redactor, 'tecera/', ctx('c'))).toEqual({ ok: true, branch: 'tecera/g1', prepared: null });
  });

  it('a prepared branch that is no longer at the base it was cut from is refused (the base moved)', async () => {
    const s = await committedA();
    resetOnto(s.repo, B.branch, s.base);
    await record(s.ledger, { branch: B.branch, base: 'c'.repeat(40) });
    s.repo.write('src/a.ts', EDIT);
    const v = await s.gates.verify(bCtx(s.repo, 'v'));
    const r = await s.gates.review(bCtx(s.repo, 'r', { candidate: { d1: v.fingerprint } }));
    expect(await s.gates.commit(bCtx(s.repo, 'c', { candidate: { d1: v.fingerprint, d2: r.fingerprint } }))).toMatchObject({ exitCode: 9, reason: 'prepared-base-moved' });
  });
});
