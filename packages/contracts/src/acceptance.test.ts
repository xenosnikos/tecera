import { describe, expect, it } from 'vitest';
import {
  achievementProofProblem,
  contractHash,
  contractProblem,
  criteriaProofProblem,
  fidelityOf,
  resolveGap,
  weakestFidelity,
  type AcceptanceContract,
  type CriterionProof,
  type ProvisioningAllowance,
} from './index.js';

const contract = (): AcceptanceContract => ({
  goalId: 'g_rate-limit',
  statement: 'Add rate limiting to the API',
  criteria: [
    { id: 'tests', statement: 'the suite passes', check: { kind: 'command', command: 'node --test', timeoutSec: 120 } },
    { id: 'limit', statement: 'the 101st request in a minute gets 429', check: { kind: 'command', command: 'node scripts/burst.js', timeoutSec: 60 }, requires: ['redis'] },
    { id: 'docs', statement: 'the README explains the limit', check: { kind: 'human', prompt: 'Is the limit documented clearly?' } },
  ],
  outOfScope: ['per-tenant limits'],
  assumptions: ['one process'],
});

const proofs = (): CriterionProof[] => [
  { criterionId: 'tests', fidelity: 'real', via: 'command', command: 'node --test', exitCode: 0, fingerprint: 'f1', evidenceKey: 'ev1', verifiedAt: 1 },
  { criterionId: 'limit', fidelity: 'provisioned', via: 'command', command: 'node scripts/burst.js', exitCode: 0, fingerprint: 'f1', evidenceKey: 'ev2', verifiedAt: 2 },
  { criterionId: 'docs', fidelity: 'real', via: 'human', approver: 'ana', evidenceKey: 'ap1', verifiedAt: 3 },
];

describe('acceptance contract', () => {
  it('accepts a well-formed contract', () => {
    expect(contractProblem(contract())).toBeNull();
  });

  it.each([
    ['no criteria', (c: AcceptanceContract) => { c.criteria = []; }, /no criteria/],
    ['duplicate id', (c: AcceptanceContract) => { c.criteria[1]!.id = 'tests'; }, /appears twice/],
    ['bad id', (c: AcceptanceContract) => { c.criteria[0]!.id = 'Tests!'; }, /is not an id/],
    ['empty command', (c: AcceptanceContract) => { c.criteria[0]!.check = { kind: 'command', command: ' ', timeoutSec: 1 }; }, /names no check command/],
    ['no timeout', (c: AcceptanceContract) => { c.criteria[0]!.check = { kind: 'command', command: 'x', timeoutSec: 0 }; }, /no check timeout/],
    ['human judgments only', (c: AcceptanceContract) => { c.criteria = [c.criteria[2]!]; }, /at least one command criterion/],
    ['unknown check kind', (c: AcceptanceContract) => { (c.criteria[0] as unknown as { check: unknown }).check = { kind: 'model', prompt: 'ok?' }; }, /unknown check kind/],
  ])('refuses: %s', (_name, mutate, re) => {
    const c = contract();
    mutate(c);
    expect(contractProblem(c)).toMatch(re);
  });

  it('hash is stable across requires order and changes with any criterion edit', () => {
    const a = contract();
    const b = contract();
    a.criteria[1]!.requires = ['redis', 'clock'];
    b.criteria[1]!.requires = ['clock', 'redis'];
    expect(contractHash(a)).toBe(contractHash(b));
    b.criteria[0]!.check = { kind: 'command', command: 'node --test --test-only', timeoutSec: 120 };
    expect(contractHash(a)).not.toBe(contractHash(b));
    const c = contract();
    c.outOfScope = [];
    expect(contractHash(c)).not.toBe(contractHash(contract()));
  });
});

describe('criterion proofs', () => {
  it('one proof per criterion proves the contract', () => {
    expect(criteriaProofProblem(contract(), proofs())).toBeNull();
  });

  it.each([
    ['missing proof', (p: CriterionProof[]) => { p.pop(); }, /docs has no proof/],
    ['stray proof', (p: CriterionProof[]) => { p.push({ ...p[0]!, criterionId: 'extra' }); }, /unknown criterion extra/],
    ['proven twice', (p: CriterionProof[]) => { p.push({ ...p[0]! }); }, /proven twice/],
    ['another command', (p: CriterionProof[]) => { p[0]!.command = 'true'; }, /another command/],
    ['non-zero exit', (p: CriterionProof[]) => { (p[0] as unknown as { exitCode: number }).exitCode = 1; }, /exit 1, not 0/],
    ['no fingerprint', (p: CriterionProof[]) => { delete p[0]!.fingerprint; }, /no candidate fingerprint/],
    ['human criterion proven by a command', (p: CriterionProof[]) => { p[2] = { ...p[0]!, criterionId: 'docs' }; }, /the contract says human/],
    ['human proof without approver', (p: CriterionProof[]) => { delete p[2]!.approver; }, /names no approver/],
    ['no fidelity', (p: CriterionProof[]) => { delete (p[1] as Partial<CriterionProof>).fidelity; }, /records no fidelity/],
  ])('refuses: %s', (_name, mutate, re) => {
    const p = proofs();
    mutate(p);
    expect(criteriaProofProblem(contract(), p)).toMatch(re);
  });

  it('a proof resting on a mock can never be an achievement proof', () => {
    const base = { command: 'node --test', exitCode: 0, fingerprint: 'f1', evidenceKey: 'ev1', verifiedAt: 1 };
    expect(achievementProofProblem({ ...base, criteria: proofs(), fidelity: 'provisioned' })).toBeNull();
    expect(achievementProofProblem({ ...base, fidelity: 'mocked' })).toMatch(/mocked capability/);
    const p = proofs();
    p[1]!.fidelity = 'mocked';
    // the summary field lying about it does not help
    expect(achievementProofProblem({ ...base, criteria: p, fidelity: 'real' })).toMatch(/mocked capability/);
  });
});

describe('capabilities', () => {
  it('fidelity is the weakest link; a missing capability proves nothing', () => {
    expect(weakestFidelity([])).toBe('real');
    expect(weakestFidelity(['real', 'provisioned'])).toBe('provisioned');
    expect(weakestFidelity(['mocked', 'provisioned', 'real'])).toBe('mocked');
    expect(fidelityOf(['available'])).toBe('real');
    expect(fidelityOf(['available', 'provisioned'])).toBe('provisioned');
    expect(fidelityOf(['provisioned', 'mocked'])).toBe('mocked');
    expect(fidelityOf(['available', 'missing'])).toBeNull();
  });

  it('gap ladder: use, then provision inside the allowance, then mock, then ask', () => {
    const local: ProvisioningAllowance = { scope: 'local', kinds: ['sqlite', 'http-stub'], maxResources: 2, ttlSec: 60 };
    expect(resolveGap({ kind: 'sqlite', available: true, mockable: true }, local, 0)).toBe('use');
    expect(resolveGap({ kind: 'sqlite', available: false, mockable: true }, local, 0)).toBe('provision');
    expect(resolveGap({ kind: 'sqlite', available: false, mockable: true }, local, 2), 'allowance used up').toBe('mock');
    expect(resolveGap({ kind: 'smtp', available: false, mockable: true }, local, 0), 'kind outside the allowance').toBe('mock');
    expect(resolveGap({ kind: 'smtp', available: false, mockable: false }, local, 0)).toBe('ask');
    expect(resolveGap({ kind: 'sqlite', available: false, mockable: false }, { ...local, scope: 'none' }, 0)).toBe('ask');
  });
});
