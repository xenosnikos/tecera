import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AcceptanceContract, ChangePath, Ledger, Plan } from '@tecera/contracts';
import { createGates } from './index.js';
import { candidateEnvelope } from './envelope.js';
import { ctx, FakeReviewer, FakeRunner, LEDGERS, makeRepo, manifest, NOW, plan, prGrant, recordVerify, WRITERS, type Repo } from './testkit/fixtures.js';

/**
 * The change-path envelope at the gates, on temp git repositories with the real gates and a reviewer that
 * approves everything: a file nobody asked for, inside repo.allowedChanges, is refused at verify and at
 * commit with a reason that names it.
 */

const contract = (envelope?: ChangePath[]): AcceptanceContract => ({
  goalId: 'g1',
  statement: 'make a two',
  criteria: [{ id: 'tests-pass', statement: 'the test suite passes', check: { kind: 'command', command: 'node --test', timeoutSec: 60 } }],
  outOfScope: ['configuration files'],
  assumptions: [],
  ...(envelope ? { envelope } : {}),
});
const ONLY_A: ChangePath[] = [{ path: 'src/a.ts', ops: ['modify'] }];

interface S {
  repo: Repo;
  ledger: Ledger;
  gates: ReturnType<typeof createGates>;
  runner: FakeRunner;
  reviewer: FakeReviewer;
  base: string;
}

function setup(change: (r: Repo) => void): S {
  const repo = makeRepo({ 'src/old.ts': 'export const old = 1;\n' });
  const base = repo.g('rev-parse', 'HEAD').trim();
  change(repo);
  const ledger = LEDGERS[0]![1]();
  const runner = new FakeRunner();
  const reviewer = new FakeReviewer('openai'); // approves whatever it is shown
  const gates = createGates({ manifest: manifest(), ledger, verifyRunner: runner, reviewer, writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1', runsDir: mkdtempSync(join(tmpdir(), 'tecera-gates-runs-')), gh: null });
  return { repo, ledger, gates, runner, reviewer, base };
}

const withContract = (c: ReturnType<typeof ctx>, k: AcceptanceContract, p?: Plan) => ({ ...c, contract: k, ...(p ? { plan: p } : {}) });
const planted = (r: Repo): void => {
  r.write('src/a.ts', 'export const a = 2;\n');
  // inside repo.allowedChanges (src/**), readable text, no tamper finding: only review stood in its way
  r.write('src/config.ts', 'export const config = { planted: true };\n');
};

describe('an unrequested file inside allowedChanges, with a reviewer that approves everything', () => {
  it('verify refuses the candidate before any check runs, with a reason and a result naming the path; it is a failure the worker can fix, not a dead end', async () => {
    const s = setup(planted);
    const v = await s.gates.verify(withContract(ctx('v', { worktree: s.repo.dir }), contract(ONLY_A)));
    expect(v.exitCode).toBe(1);
    expect(v.outcome).toBe('failed');
    expect(v.terminal).toBe(false);
    expect(v.reason).toBe('changed paths outside the accepted change-path envelope: src/config.ts (create)');
    expect(v.unexpected).toEqual([{ path: 'src/config.ts', op: 'create' }]);
    expect(v.criteria).toEqual([]);
    expect(s.runner.calls).toEqual([]);
    const body = (await s.ledger.getEvidence(v.evidenceKey))!.body as { envelope: unknown; ran: boolean };
    expect(body.envelope).toEqual({ source: 'contract', paths: 1, unexpected: [{ path: 'src/config.ts', op: 'create' }] });
    expect(body.ran).toBe(false);
  });

  it('the commit gate refuses it even with a passing verify and an approving review on record: nothing is committed, and the PR gate has nothing to deliver', async () => {
    const s = setup(planted);
    // a verify and a review that never looked at the envelope (no contract in their context): both pass
    const v = await s.gates.verify(ctx('v', { worktree: s.repo.dir }));
    expect(v.exitCode).toBe(0);
    await recordVerify(s.ledger, v, { at: NOW - 1 });
    const r = await s.gates.review(ctx('r', { worktree: s.repo.dir, candidate: { d1: v.fingerprint } }));
    expect(r.verdict).toBe('approve');
    const c = await s.gates.commit(withContract(ctx('c', { worktree: s.repo.dir, candidate: { d1: v.fingerprint, d2: r.fingerprint } }), contract(ONLY_A)));
    expect(c.exitCode).toBe(8);
    expect(c.terminal).toBe(true);
    expect(c.failure).toBe('policy');
    expect(c.reason).toBe('outside-envelope: src/config.ts (create)');
    expect(c.sha).toBeUndefined();
    expect(() => s.repo.g('rev-parse', '--verify', '--quiet', 'refs/heads/tecera/g1')).toThrow();
    expect(s.repo.g('rev-parse', 'HEAD').trim()).toBe(s.base);
    const detail = (await s.ledger.getEvidence(c.evidenceKey))!.body as { detail: unknown; envelope: unknown };
    expect(detail.detail).toEqual([{ path: 'src/config.ts', op: 'create' }]);
    expect(detail.envelope).toEqual({ source: 'contract', paths: 1 });
    // no commit, so no PR: a grant for any sha delivers nothing
    const pr = await s.gates.pr({ ...withContract(ctx('pr', { worktree: s.repo.dir, approval: await prGrant(s.ledger, { sha: s.base }), commit: { sha: s.base, d1: v.fingerprint } }), contract(ONLY_A)) });
    expect(pr.exitCode).not.toBe(0);
    expect(pr.outcome).toBe('refused');
    expect(existsSync(join(s.repo.dir, 'src/config.ts'))).toBe(true); // the gate refuses; it does not clean up
  });

  it('once the file is gone the same candidate passes verify, review and commit under the same envelope', async () => {
    const s = setup(planted);
    rmSync(join(s.repo.dir, 'src/config.ts'));
    const k = contract(ONLY_A);
    const v = await s.gates.verify(withContract(ctx('v', { worktree: s.repo.dir }), k));
    expect(v).toMatchObject({ exitCode: 0, outcome: 'passed' });
    expect(v.unexpected).toBeUndefined();
    const r = await s.gates.review(withContract(ctx('r', { worktree: s.repo.dir, candidate: { d1: v.fingerprint } }), k));
    const c = await s.gates.commit(withContract(ctx('c', { worktree: s.repo.dir, candidate: { d1: v.fingerprint, d2: r.fingerprint } }), k));
    expect(c).toMatchObject({ exitCode: 0, terminal: false });
    expect(s.repo.g('diff', '--name-only', 'main', 'tecera/g1').trim()).toBe('src/a.ts');
  });
});

describe('operations and sources', () => {
  it('a deletion nobody allowed, and a modification where only creation was allowed, are unexpected; the allowed operations pass', async () => {
    const s = setup((r) => {
      r.write('src/a.ts', 'export const a = 2;\n');
      rmSync(join(r.dir, 'src/old.ts'));
      r.write('src/new.ts', 'export const n = 1;\n');
    });
    const tight = contract([{ path: 'src/a.ts', ops: ['create'] }, { path: 'src/new.ts', ops: ['create'] }]);
    const v = await s.gates.verify(withContract(ctx('v', { worktree: s.repo.dir }), tight));
    expect(v.unexpected).toEqual([{ path: 'src/a.ts', op: 'modify' }, { path: 'src/old.ts', op: 'delete' }]);
    const right = contract([{ path: 'src/a.ts', ops: ['modify'] }, { path: 'src/old.ts', ops: ['delete'] }, { path: 'src/*.ts', ops: ['create'] }]);
    const ok = await s.gates.verify(withContract(ctx('v', { worktree: s.repo.dir, intentionId: 'i2' }), right));
    expect(ok).toMatchObject({ exitCode: 0, outcome: 'passed' });
  });

  it('a glob never matches at another depth than it names, and an exact path never matches a namesake elsewhere', async () => {
    const s = setup((r) => {
      r.write('src/a.ts', 'export const a = 2;\n');
      r.write('src/deep/a.ts', 'export const a = 3;\n');
    });
    const v = await s.gates.verify(withContract(ctx('v', { worktree: s.repo.dir }), contract([{ path: 'src/a.ts', ops: ['modify'] }, { path: 'src/*.ts', ops: ['create'] }])));
    expect(v.unexpected).toEqual([{ path: 'src/deep/a.ts', op: 'create' }]);
  });

  it('a contract without an envelope: the plan\'s own declared changes are the envelope when every writing step declares them', async () => {
    const s = setup(planted);
    const declared: Plan = { ...plan(), steps: plan().steps.map((x) => (x.id === 'w' ? { ...x, changes: ONLY_A } : x)) };
    expect(candidateEnvelope({ contract: contract(), plan: declared })?.source).toBe('plan');
    const v = await s.gates.verify(withContract(ctx('v', { worktree: s.repo.dir, plan: declared }), contract(), declared));
    expect(v.unexpected).toEqual([{ path: 'src/config.ts', op: 'create' }]);
    expect(((await s.ledger.getEvidence(v.evidenceKey))!.body as { envelope: { source: string } }).envelope.source).toBe('plan');
  });

  it('no envelope anywhere: repo.allowedChanges is the boundary, exactly as before, and the evidence says so', async () => {
    const s = setup(planted);
    expect(candidateEnvelope({ contract: contract(), plan: plan() })).toBeNull();
    const v = await s.gates.verify(withContract(ctx('v', { worktree: s.repo.dir }), contract()));
    expect(v).toMatchObject({ exitCode: 0, outcome: 'passed' });
    expect(((await s.ledger.getEvidence(v.evidenceKey))!.body as { envelope: unknown }).envelope).toEqual({ source: 'manifest', paths: 0, unexpected: [] });
    const r = await s.gates.review(withContract(ctx('r', { worktree: s.repo.dir, candidate: { d1: v.fingerprint } }), contract()));
    const c = await s.gates.commit(withContract(ctx('c', { worktree: s.repo.dir, candidate: { d1: v.fingerprint, d2: r.fingerprint } }), contract()));
    expect(c.exitCode).toBe(0);
    expect(s.repo.g('diff', '--name-only', 'main', 'tecera/g1').trim().split('\n')).toEqual(['src/a.ts', 'src/config.ts']);
  });
});

describe('the review packet', () => {
  it('shows the accepted criteria, the out-of-scope list, the envelope and the host-computed unexpected paths', async () => {
    const s = setup(planted);
    await s.gates.review(withContract(ctx('r', { worktree: s.repo.dir }), contract(ONLY_A)));
    const prompt = s.reviewer.calls[0]!.messages.map((m) => m.content).join('\n');
    expect(prompt).toMatch(/Accepted criteria[^\n]*\n<<<UNTRUSTED CRITERIA [0-9a-f]+>>>\n- tests-pass: the test suite passes \[command: node --test\]/);
    expect(prompt).toMatch(/Out of scope[^\n]*\n<<<UNTRUSTED OUT_OF_SCOPE [0-9a-f]+>>>\n- configuration files/);
    expect(prompt).toMatch(/Change-path envelope \(accepted with the criteria; path and allowed operations\):\n<<<UNTRUSTED ENVELOPE [0-9a-f]+>>>\n- src\/a\.ts: modify/);
    expect(prompt).toMatch(/Paths the host found changed outside the envelope: 1 \(the change cannot be committed with these, whatever your verdict\)\n<<<UNTRUSTED UNEXPECTED [0-9a-f]+>>>\n- src\/config\.ts \(create\)/);
  });

  it('without a stated envelope it says so and lists no unexpected path', async () => {
    const s = setup(planted);
    await s.gates.review(ctx('r', { worktree: s.repo.dir }));
    const prompt = s.reviewer.calls[0]!.messages.map((m) => m.content).join('\n');
    expect(prompt).toMatch(/Change-path envelope: none was stated/);
    expect(prompt).toMatch(/Paths the host found changed outside the envelope: 0\n/);
    expect(prompt).not.toMatch(/Accepted criteria/);
  });
});
