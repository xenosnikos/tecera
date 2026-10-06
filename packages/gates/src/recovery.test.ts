import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reconcileVerdict, type GateApproval, type Ledger, type VerifyOutcome } from '@tecera/contracts';
import { createGates, type CreateGatesOptions } from './index.js';
import { ctx, FakeReviewer, FakeRunner, LEDGERS, liveGuard, makeRepo, manifest, NOW, WRITERS, type Repo } from './testkit/fixtures.js';

/**
 * Crash windows of the commit (security.md §4 S8) and of verify (S4), on both ledgers. A "crash" is a test
 * hook that never returns (the call is abandoned) or throws; the restart is a fresh createGates on the same
 * ledger and worktree (empty memo).
 */

interface Setup {
  repo: Repo;
  ledger: Ledger;
  gates: ReturnType<typeof createGates>;
  d1: string;
  d2: string;
  commitCtx(approval?: GateApproval): ReturnType<typeof ctx>;
  fresh(extra?: Partial<CreateGatesOptions>): ReturnType<typeof createGates>;
}

async function prepared(ledger: Ledger, extra: Partial<CreateGatesOptions> = {}): Promise<Setup> {
  const repo = makeRepo();
  repo.write('src/a.ts', 'export const a = 2;\n');
  const make = (more: Partial<CreateGatesOptions> = {}) =>
    createGates({ manifest: manifest(), ledger, verifyRunner: new FakeRunner(), reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1', ...extra, ...more });
  const gates = make();
  const v = await gates.verify(ctx('v', { worktree: repo.dir }));
  const r = await gates.review(ctx('r', { worktree: repo.dir, candidate: { d1: v.fingerprint } }));
  expect(v.exitCode).toBe(0);
  expect(r.verdict).toBe('approve');
  const s: Setup = {
    repo,
    ledger,
    gates,
    d1: v.fingerprint,
    d2: r.fingerprint!,
    commitCtx: (approval) => ({ ...ctx('c', { worktree: repo.dir, candidate: { d1: s.d1, d2: s.d2 }, ...(approval ? { approval } : {}) }), recovered: true }),
    fresh: make,
  };
  return s;
}

const hang = (reached: () => void) => () => (reached(), new Promise<void>(() => undefined));
const deferred = () => {
  let resolve!: () => void;
  const p = new Promise<void>((r) => (resolve = r));
  return { p, resolve };
};
const indexTree = (r: Repo) => r.g('write-tree').trim();
const headTree = (r: Repo) => r.g('rev-parse', 'HEAD^{tree}').trim();
const noBranch = (r: Repo) => expect(() => r.g('rev-parse', '--verify', '--quiet', 'refs/heads/tecera/g1')).toThrow();

describe.each(LEDGERS)('S8 commit crash windows (%s)', (_n, mk) => {
  it('crash after HEAD moved, before the index update: reconcile repairs the index, then records (index == expected tree)', async () => {
    const at = deferred();
    const s = await prepared(mk(), { commitTestHooks: { afterHead: hang(at.resolve) } });
    void s.gates.commit(s.commitCtx());
    await at.p;
    // The window: HEAD names the branch, the index still holds the base tree.
    expect(s.repo.g('symbolic-ref', 'HEAD').trim()).toBe('refs/heads/tecera/g1');
    expect(indexTree(s.repo)).not.toBe(headTree(s.repo));
    const intent = (await s.ledger.getEvidence('commit-intent:run1:i1:c:0'))!.body as Record<string, unknown>;
    expect(intent).toMatchObject({ headRef: 'refs/heads/tecera/g1', indexTree: intent.expectedTree });

    const r = await s.fresh().reconcile(s.commitCtx());
    expect(r).toMatchObject({ exitCode: 0, reconciled: true });
    expect(reconcileVerdict(r)).toMatchObject({ recorded: true, sha: s.repo.g('rev-parse', 'tecera/g1').trim() });
    expect(indexTree(s.repo)).toBe(headTree(s.repo));
    expect(indexTree(s.repo)).toBe(intent.expectedTree);
    expect((await s.ledger.getEvidence(r!.evidenceKey))!.body).toMatchObject({ outcome: 'committed', reconciled: true, indexTree: intent.expectedTree });
  });

  it('reconcile never reports success with a stale index even when HEAD already sits on the branch', async () => {
    const s = await prepared(mk(), { commitTestHooks: { afterRef: () => Promise.reject(new Error('crash')) } });
    await expect(s.gates.commit(s.commitCtx())).rejects.toThrow('crash');
    // Someone (or a half-finished operation) put the old tree back into the index.
    s.repo.g('read-tree', 'main');
    expect(indexTree(s.repo)).not.toBe(headTree(s.repo));
    const r = await s.fresh({ commitTestHooks: {} }).reconcile(s.commitCtx());
    expect(r).toMatchObject({ exitCode: 0, reconciled: true });
    expect(indexTree(s.repo)).toBe(headTree(s.repo));
  });

  it('the commit path itself verifies the index: an index reset after read-tree is 9 (index-mismatch), never success', async () => {
    let dir = '';
    const s = await prepared(mk(), {
      commitTestHooks: {
        afterRef: () => {
          makeRepoGit(dir)('read-tree', 'main');
        },
      },
    });
    dir = s.repo.dir;
    const r = await s.gates.commit(s.commitCtx());
    expect(r).toMatchObject({ exitCode: 9, reason: 'index-mismatch', terminal: true });
    expect(await s.ledger.getEvidence('commit:run1:i1:c:0')).toBeNull();
    // A later reconcile repairs the index and can then prove the commit.
    const again = await s.fresh({ commitTestHooks: {} }).reconcile(s.commitCtx());
    expect(again).toMatchObject({ exitCode: 0, reconciled: true });
    expect(indexTree(s.repo)).toBe(headTree(s.repo));
  });

  it('crash between the commit and its record (after update-ref, HEAD and index): GateRunner.reconcile proves it; commit() is not re-run', async () => {
    const at = deferred();
    const s = await prepared(mk(), { commitTestHooks: { afterRef: hang(at.resolve) } });
    void s.gates.commit(s.commitCtx());
    await at.p;
    const sha = s.repo.g('rev-parse', 'tecera/g1').trim();
    expect(await s.ledger.getEvidence('commit:run1:i1:c:0')).toBeNull();
    const restarted = s.fresh({ commitTestHooks: {} });
    const verdict = reconcileVerdict(await restarted.reconcile(s.commitCtx()));
    expect(verdict).toMatchObject({ recorded: true, sha, evidenceKey: 'commit:run1:i1:c:0' });
    // Idempotent: a second reconcile reads the record.
    expect(reconcileVerdict(await restarted.reconcile(s.commitCtx()))).toMatchObject({ recorded: true, sha });
    expect(s.repo.g('rev-list', '--count', 'main..tecera/g1').trim()).toBe('1');
  });

  it('reconcile → human (9) when the branch commit is not the recorded tree; recorded: false', async () => {
    const at = deferred();
    const s = await prepared(mk(), { commitTestHooks: { afterRef: hang(at.resolve) } });
    void s.gates.commit(s.commitCtx());
    await at.p;
    // Someone moved the branch to another tree between the crash and the restart.
    s.repo.write('src/a.ts', 'export const a = 99;\n');
    s.repo.g('add', 'src/a.ts');
    s.repo.g('commit', '-q', '-m', 'foreign');
    const r = await s.fresh({ commitTestHooks: {} }).reconcile(s.commitCtx());
    expect(r).toMatchObject({ exitCode: 9, reason: 'reconcile-tree-mismatch', terminal: true });
    expect(reconcileVerdict(r)).toMatchObject({ recorded: false });
  });

  it('reconcile with no intent recorded is null (the loop then fails the step for a human)', async () => {
    const s = await prepared(mk());
    const r = await s.gates.reconcile(s.commitCtx());
    expect(r).toBeNull();
    expect(reconcileVerdict(r)).toMatchObject({ recorded: false });
    noBranch(s.repo);
  });

  it('crash right before the intent claim: nothing moved, nothing to reconcile; the restart commits exactly once (D6: no grant to lose)', async () => {
    const s = await prepared(mk(), { commitTestHooks: { afterConsume: () => Promise.reject(new Error('crash')) } });
    await expect(s.gates.commit(s.commitCtx())).rejects.toThrow('crash');
    expect(await s.ledger.getEvidence('commit-intent:run1:i1:c:0')).toBeNull();
    noBranch(s.repo);
    const restarted = s.fresh({ commitTestHooks: {} });
    // The restarted process recovers verify/review evidence (the loop's events would carry the keys).
    restarted.memo.verify.set('run1:i1', s.gates.memo.verify.get('run1:i1')!);
    restarted.memo.review.set('run1:i1', s.gates.memo.review.get('run1:i1')!);
    expect(await restarted.reconcile(s.commitCtx())).toBeNull();
    const again = await restarted.commit(s.commitCtx());
    expect(again).toMatchObject({ exitCode: 0, terminal: false });
    expect(s.repo.g('rev-list', '--count', 'main..tecera/g1').trim()).toBe('1');
  });

  it('ledger failure writing the intent is 9 (intent-not-recorded) and nothing moved; a retry on a healthy ledger commits once', async () => {
    const ledger = mk();
    const orig = ledger.evidence.bind(ledger);
    let broken = true;
    ledger.evidence = async (e) => {
      if (broken && e.key.startsWith('commit-intent:')) throw new Error('disk full');
      return orig(e);
    };
    const s = await prepared(ledger);
    const r = await s.gates.commit(s.commitCtx());
    expect(r).toMatchObject({ exitCode: 9, reason: 'intent-not-recorded', terminal: true });
    noBranch(s.repo);
    broken = false;
    const retry = await s.gates.commit(s.commitCtx());
    expect(retry).toMatchObject({ exitCode: 0 });
    expect(s.repo.g('rev-list', '--count', 'main..tecera/g1').trim()).toBe('1');
  });
});

describe.each(LEDGERS)('S8 reconcile covers both partial end states (%s)', (_n, mk) => {
  it("'HEAD moved, index not updated' WITHOUT a guard: 9 reconcile-needs-guard, nothing moved; then WITH a guard: index repaired, recorded", async () => {
    const at = deferred();
    const s = await prepared(mk(), { commitTestHooks: { afterHead: hang(at.resolve) } });
    void s.gates.commit(s.commitCtx());
    await at.p;
    const staleIndex = indexTree(s.repo);
    expect(staleIndex).not.toBe(headTree(s.repo));
    const fresh = s.fresh({ commitTestHooks: {} });
    const unguarded = await fresh.reconcile({ ...s.commitCtx(), guard: undefined });
    expect(unguarded).toMatchObject({ exitCode: 9, reason: 'reconcile-needs-guard', terminal: true, failure: 'human' });
    expect(reconcileVerdict(unguarded)).toMatchObject({ recorded: false });
    expect(indexTree(s.repo)).toBe(staleIndex);
    expect(await s.ledger.getEvidence('commit:run1:i1:c:0')).toBeNull();
    const fence = liveGuard();
    const r = await fresh.reconcile({ ...s.commitCtx(), guard: fence.guard });
    expect(r).toMatchObject({ exitCode: 0, reconciled: true });
    expect(indexTree(s.repo)).toBe(headTree(s.repo));
    expect((await s.ledger.getEvidence(r!.evidenceKey))!.body).toMatchObject({ outcome: 'committed', reconciled: true, repaired: ['index'] });
    expect(fence.checks).toBe(1);
  });

  it("'branch moved, HEAD not moved, index not updated' (crash right after update-ref): reconcile moves HEAD and repairs the index", async () => {
    const at = deferred();
    const s = await prepared(mk(), { commitTestHooks: { afterUpdateRef: hang(at.resolve) } });
    void s.gates.commit(s.commitCtx());
    await at.p;
    expect(s.repo.g('symbolic-ref', 'HEAD').trim()).toBe('refs/heads/main');
    const sha = s.repo.g('rev-parse', 'tecera/g1').trim();
    const r = await s.fresh({ commitTestHooks: {} }).reconcile(s.commitCtx());
    expect(reconcileVerdict(r)).toMatchObject({ recorded: true, sha });
    expect(s.repo.g('symbolic-ref', 'HEAD').trim()).toBe('refs/heads/tecera/g1');
    expect(indexTree(s.repo)).toBe(headTree(s.repo));
    expect((await s.ledger.getEvidence(r!.evidenceKey))!.body).toMatchObject({ repaired: ['head', 'index'] });
  });

  it("'index updated, HEAD not moved': reconcile moves HEAD only (the index already holds the tree) and records", async () => {
    const at = deferred();
    const s = await prepared(mk(), { commitTestHooks: { afterUpdateRef: hang(at.resolve) } });
    void s.gates.commit(s.commitCtx());
    await at.p;
    const intent = (await s.ledger.getEvidence('commit-intent:run1:i1:c:0'))!.body as { expectedTree: string };
    // The index reached the expected tree while HEAD still names the base branch.
    s.repo.g('read-tree', intent.expectedTree);
    expect(indexTree(s.repo)).toBe(intent.expectedTree);
    expect(s.repo.g('symbolic-ref', 'HEAD').trim()).toBe('refs/heads/main');
    // Without a guard the HEAD repair is refused and nothing moves.
    const fresh = s.fresh({ commitTestHooks: {} });
    expect(await fresh.reconcile({ ...s.commitCtx(), guard: undefined })).toMatchObject({ exitCode: 9, reason: 'reconcile-needs-guard' });
    expect(s.repo.g('symbolic-ref', 'HEAD').trim()).toBe('refs/heads/main');
    const r = await fresh.reconcile(s.commitCtx());
    expect(r).toMatchObject({ exitCode: 0, reconciled: true });
    expect(s.repo.g('symbolic-ref', 'HEAD').trim()).toBe('refs/heads/tecera/g1');
    expect(indexTree(s.repo)).toBe(headTree(s.repo));
    expect((await s.ledger.getEvidence(r!.evidenceKey))!.body).toMatchObject({ repaired: ['head'] });
  });

  it('nothing left to repair (crash after HEAD and index, before the record): reconcile proves it read-only, with or without a guard', async () => {
    const at = deferred();
    const s = await prepared(mk(), { commitTestHooks: { afterRef: hang(at.resolve) } });
    void s.gates.commit(s.commitCtx());
    await at.p;
    const r = await s.fresh({ commitTestHooks: {} }).reconcile({ ...s.commitCtx(), guard: undefined });
    expect(r).toMatchObject({ exitCode: 0, reconciled: true });
    expect((await s.ledger.getEvidence(r!.evidenceKey))!.body).toMatchObject({ repaired: [] });
  });

  it('HEAD moved somewhere else (not the parent, not the branch): 9 reconcile-head-moved, nothing touched', async () => {
    const at = deferred();
    const s = await prepared(mk(), { commitTestHooks: { afterUpdateRef: hang(at.resolve) } });
    void s.gates.commit(s.commitCtx());
    await at.p;
    s.repo.g('checkout', '-q', '-b', 'elsewhere');
    s.repo.g('commit', '-q', '--allow-empty', '-m', 'other');
    const r = await s.fresh({ commitTestHooks: {} }).reconcile(s.commitCtx());
    expect(r).toMatchObject({ exitCode: 9, reason: 'reconcile-head-moved', terminal: true });
    expect(s.repo.g('symbolic-ref', 'HEAD').trim()).toBe('refs/heads/elsewhere');
  });
});

describe.each(LEDGERS)('S4 interrupted verify (%s)', (_n, mk) => {
  function crashingVerify(ledger: Ledger, repo: Repo) {
    const at = deferred();
    const hangRunner = new FakeRunner(() => (at.resolve(), new Promise<Partial<VerifyOutcome>>(() => undefined)));
    const gates = createGates({ manifest: manifest(), ledger, verifyRunner: hangRunner, reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1' });
    void gates.verify(ctx('v', { worktree: repo.dir }));
    return at.p;
  }

  it('the tree changed between the crash and the restart: the recovered verify is mutated (9, terminal) and never re-runs the command', async () => {
    const ledger = mk();
    const repo = makeRepo();
    repo.write('src/a.ts', 'export const a = 2;\n');
    await crashingVerify(ledger, repo);
    writeFileSync(join(repo.dir, 'src/a.ts'), 'export const a = 7;\n'); // mutation before restart
    const runner = new FakeRunner();
    const g = createGates({ manifest: manifest(), ledger, verifyRunner: runner, reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1' });
    const r = await g.verify({ ...ctx('v', { worktree: repo.dir }), recovered: true });
    expect(r).toMatchObject({ exitCode: 9, outcome: 'mutated', terminal: true });
    expect(r.reason).toMatch(/interrupted verify/);
    expect(runner.calls).toHaveLength(0);
    const body = (await ledger.getEvidence(r.evidenceKey))!.body as Record<string, unknown>;
    expect(body).toMatchObject({ ran: false, recovered: true, interruptedVerify: { key: 'verify-start:run1:i1:v:0:0' } });
    // It stays that way: a second attempt at the same step refuses again (the interrupted start stays open).
    expect((await g.verify(ctx('v', { worktree: repo.dir }))).outcome).toBe('mutated');
    // And nothing downstream can use it: commit refuses (verify not passed).
    const c = await g.commit(ctx('c', { worktree: repo.dir }));
    expect(c.exitCode).not.toBe(0);
  });

  it('an unchanged tree re-runs the check, closes the interrupted run, and passes', async () => {
    const ledger = mk();
    const repo = makeRepo();
    repo.write('src/a.ts', 'export const a = 2;\n');
    await crashingVerify(ledger, repo);
    const runner = new FakeRunner();
    const g = createGates({ manifest: manifest(), ledger, verifyRunner: runner, reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1' });
    const r = await g.verify({ ...ctx('v', { worktree: repo.dir }), recovered: true });
    expect(r).toMatchObject({ exitCode: 0, outcome: 'passed', evidenceKey: 'verify:run1:i1:v:0:1' });
    expect(runner.calls).toHaveLength(1);
    expect((await ledger.getEvidence('verify:run1:i1:v:0:0'))!.body).toMatchObject({ outcome: 'interrupted', supersededBy: 'verify:run1:i1:v:0:1' });
    expect((await ledger.getEvidence(r.evidenceKey))!.body).toMatchObject({ interruptedVerify: { key: 'verify-start:run1:i1:v:0:0' } });
    // A later verify of the same step finds nothing interrupted and runs normally.
    expect((await g.verify(ctx('v', { worktree: repo.dir }))).outcome).toBe('passed');
  });
});

function makeRepoGit(dir: string) {
  return (...args: string[]) => {
    return execFileSync('git', ['-C', dir, ...args], { env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, encoding: 'utf8' });
  };
}
