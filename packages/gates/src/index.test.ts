import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prActionHash, type GateContext, type GateRunner } from '@tecera/contracts';
import { createGates, SameProviderReview } from './index.js';
import { ctx, FakeReviewer, FakeRunner, grantAudited, LEDGERS, makeRepo, manifest, WRITERS } from './testkit/fixtures.js';

/**
 * The loop's side of the contract (D6), replayed step by step exactly as packages/loop/src/loop.ts does it
 * (gates may not depend on @tecera/loop): candidate.d1 = verify fingerprint, candidate.d2 = review
 * fingerprint; gate.commit runs with NO approval; gate.pr holds with requestApproval(prActionHash({intentionId,
 * stepId, attempt, sha})), resume checks the grant without consuming, passes GateContext.approval and
 * GateContext.commit, and afterwards requires the ledger state 'consumed' (noteConsumed).
 */
describe.each(LEDGERS)('loop: commit (no approval) → PR hold → grant → resume through the GateRunner (%s)', (_n, mk) => {
  it('commits once without approval, the PR gate consumed the grant, and the gates emitted no events', async () => {
    const repo = makeRepo();
    repo.write('src/a.ts', 'export const a = 2;\n');
    const ledger = mk();
    const reviewer = new FakeReviewer('openai');
    const runsDir = mkdtempSync(join(tmpdir(), 'tecera-gates-runs-'));
    const gates: GateRunner = createGates({ manifest: manifest(), ledger, verifyRunner: new FakeRunner(), reviewer, writers: WRITERS, worktree: repo.dir, now: () => 1000, sessionId: 'local', runsDir, gh: null });
    const base = { worktree: repo.dir };
    const v = await gates.verify(ctx('v', base));
    expect(v).toMatchObject({ exitCode: 0, terminal: false });
    const r = await gates.review(ctx('r', { ...base, candidate: { d1: v.fingerprint } }));
    expect(r).toMatchObject({ verdict: 'approve', terminal: false, fingerprint: v.fingerprint });
    expect(reviewer.calls[0]!.model).toBe('gpt-review');
    expect(reviewer.calls[0]!.effort).toBe('high');

    const candidate = { d1: v.fingerprint, d2: r.fingerprint };
    const c = await gates.commit(ctx('c', { ...base, candidate }));
    expect(c).toMatchObject({ exitCode: 0, terminal: false });
    // loop.hold() for gate.pr, bound to the committed sha
    const actionHash = prActionHash({ intentionId: 'i1', stepId: 'pr', attempt: 0, sha: c.sha! });
    await ledger.requestApproval({ requestId: 'ap1', runId: 'run1', sessionId: 'local', actionHash, requester: { kind: 'agent', id: 'loop' }, reason: 'gate.pr pr', expiresAt: 10_000 });
    await grantAudited(ledger, { requestId: 'ap1', runId: 'run1', sessionId: 'local', actionHash, approver: { kind: 'human', id: 'h' }, at: 1000, stepId: 'pr' });
    expect((await ledger.getApproval!('ap1'))!.state).toBe('granted');
    const prCtx: GateContext = ctx('pr', { ...base, approval: { requestId: 'ap1', sessionId: 'local', actionHash }, commit: { sha: c.sha!, d1: v.fingerprint, evidenceKey: c.evidenceKey } });
    const pr = await gates.pr(prCtx);
    expect(pr).toMatchObject({ exitCode: 0, terminal: false, sha: c.sha, reason: 'pr-requested', pushed: false });
    // loop.noteConsumed()
    expect((await ledger.getApproval!('ap1'))!.state).toBe('consumed');
    const events = [];
    for await (const e of ledger.events()) events.push(e);
    // The only event is the ingress audit of the grant: the gates themselves emit none.
    expect(events.map((e) => e.kind)).toEqual(['approval.granted']);
    for (const k of [v.evidenceKey, r.evidenceKey, c.evidenceKey, pr.evidenceKey]) expect(await ledger.getEvidence(k)).not.toBeNull();
  });
});

describe('createGates', () => {
  it('refuses a same-vendor or same-credential reviewer at composition time', () => {
    const repo = makeRepo();
    const o = { manifest: manifest(), ledger: LEDGERS[0]![1](), verifyRunner: new FakeRunner(), writers: WRITERS, worktree: repo.dir };
    expect(() => createGates({ ...o, reviewer: new FakeReviewer('anthropic') })).toThrow(SameProviderReview);
    expect(() => createGates({ ...o, reviewer: new FakeReviewer('openai', undefined, 'x', 'kf-anthropic') })).toThrow(SameProviderReview);
    expect(() => createGates({ ...o, reviewer: new FakeReviewer('openai', undefined, 'x', null) })).toThrow(SameProviderReview);
  });

  it('tooling and mutation outcomes are terminal so the loop never retries them', async () => {
    const repo = makeRepo();
    repo.write('src/a.ts', 'export const a = 2;\n');
    const runner = new FakeRunner(() => ({ exitCode: 127 }));
    const g = createGates({ manifest: manifest(), ledger: LEDGERS[0]![1](), verifyRunner: runner, reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir });
    expect(await g.verify(ctx('v', { worktree: repo.dir }))).toMatchObject({ exitCode: 127, terminal: true });
    const mut = createGates({
      manifest: manifest(),
      ledger: LEDGERS[0]![1](),
      verifyRunner: new FakeRunner(() => (writeFileSync(join(repo.dir, 'src/a.ts'), 'x\n'), {})),
      reviewer: new FakeReviewer('openai'),
      writers: WRITERS,
      worktree: repo.dir,
    });
    expect(await mut.verify(ctx('v', { worktree: repo.dir }))).toMatchObject({ exitCode: 9, terminal: true });
    // No approval is needed to commit (D6), but nothing unverified/unreviewed ever commits.
    expect(await mut.commit(ctx('c', { worktree: repo.dir }))).toMatchObject({ exitCode: 9, reason: 'no-reviewed-digest', terminal: true });
  });
});
