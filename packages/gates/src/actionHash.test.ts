import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, commitActionHash as contractsCommitActionHash, sha256 } from '@tecera/contracts';
import { actionHash, commitActionHash } from './actionHash.js';
import { isTerminalExit, refSafe } from './index.js';

describe('commitActionHash (the loop binding)', () => {
  it('is the contracts function, and matches the documented formula on a fixed vector', () => {
    expect(commitActionHash).toBe(contractsCommitActionHash);
    // Formula from the kernel report, computed independently of canonicalJson: sorted keys, no spaces.
    const literal = '{"attempt":0,"candidateD1":"abc","intentionId":"i1","stepId":"c"}';
    const vector = createHash('sha256').update(literal, 'utf8').digest('hex');
    expect(commitActionHash({ intentionId: 'i1', stepId: 'c', attempt: 0, candidateD1: 'abc' })).toBe(vector);
    expect(vector).toBe('f51f7f9ee322d84b28fa74e27fe52fefb4aa0a0362f35afce933109860ce425c');
  });

  it('binds intention, step, attempt and D1; null D1 is its own (refused by the gate) value', () => {
    const base = { intentionId: 'i1', stepId: 'c', attempt: 0, candidateD1: 'abc' };
    const h = commitActionHash(base);
    expect(commitActionHash({ ...base, attempt: 1 })).not.toBe(h);
    expect(commitActionHash({ ...base, candidateD1: 'abd' })).not.toBe(h);
    expect(commitActionHash({ ...base, stepId: 'd' })).not.toBe(h);
    expect(commitActionHash({ ...base, intentionId: 'i2' })).not.toBe(h);
    expect(commitActionHash({ ...base, candidateD1: null })).toBe(sha256('{"attempt":0,"candidateD1":null,"intentionId":"i1","stepId":"c"}'));
  });
});

describe('actionHash (tool form)', () => {
  it('= sha256(canonicalJSON({tool, method, args, worktree, candidateDigest}))', () => {
    const h = actionHash({ tool: 'git', method: 'commit', worktree: '/w', candidateDigest: 'abc' });
    expect(h).toBe(sha256(canonicalJson({ args: {}, candidateDigest: 'abc', method: 'commit', tool: 'git', worktree: '/w' })));
  });

  it('refuses an incomplete descriptor', () => {
    expect(() => actionHash({ tool: 'git', method: 'commit', worktree: '/w', candidateDigest: '' })).toThrow();
  });
});

describe('helpers', () => {
  it('refSafe produces git-ref-safe suffixes', () => {
    expect(refSafe('goal one/..x~^:?*[')).toBe('goal-one/.x------');
    expect(refSafe('-.lead')).toBe('lead');
    expect(refSafe('a.lock')).toBe('a-lock');
  });

  it('terminal exits are policy, human and tooling codes', () => {
    expect([0, 1, 2, 8, 9, 124, 126, 127].filter(isTerminalExit)).toEqual([8, 9, 124, 126, 127]);
  });
});

describe('gate keys and digests match the contracts definitions the loop and replay use', () => {
  it('commandDigest === contracts verifyCommandDigest; review verdict key === contracts reviewEvidenceKey', async () => {
    const { verifyCommandDigest, reviewEvidenceKey } = await import('@tecera/contracts');
    const { commandDigest } = await import('./evidence.js');
    for (const cmd of ['node --test', 'node --test test/goal.test.js', '', 'ünïcode && echo $X']) expect(commandDigest(cmd)).toBe(verifyCommandDigest(cmd));
    const { ReviewGate } = await import('./reviewGate.js');
    const { makeRepo, memLedger, ctx, FakeReviewer, WRITERS } = await import('./testkit/fixtures.js');
    const repo = makeRepo();
    repo.write('src/a.ts', 'export const a = 2;\n');
    const r = await new ReviewGate({ reviewer: new FakeReviewer('openai'), writers: WRITERS, ledger: memLedger(), worktree: repo.dir, base: 'main' }).review(ctx('r', { worktree: repo.dir }));
    expect(r.evidenceKey).toBe(reviewEvidenceKey('run1', r.fingerprint!));
  });
});
