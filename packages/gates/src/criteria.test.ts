import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  answerCriterionActionHash,
  contractHash,
  criterionEvidenceKey,
  event,
  type AcceptanceContract,
  type CapabilityRecord,
  type GateApproval,
  type GateContext,
  type HumanCriterionAnswer,
  type Ledger,
  type Principal,
  type ProvisionedResource,
} from '@tecera/contracts';
import { createGates, type CreateGatesOptions } from './index.js';
import { ctx, FakeReviewer, FakeRunner, grantAudited, LEDGERS, LOOP, makeRepo, manifest, NOW, prGrant, recordVerify, WRITERS, type Repo } from './testkit/fixtures.js';

/**
 * Acceptance contracts at the gates (D8, D11, D12). gate.verify runs every command criterion on the frozen
 * candidate, goal check last, one proof each with the fidelity its capabilities allow. gate.pr lists every
 * criterion, how it was proven and its fidelity, and the resources pending transfer; anything mocked makes
 * it provisional; a criterion without a proof refuses it.
 */

const SYS: Principal = { kind: 'system', id: 'tecera' };
const BOB: Principal = { kind: 'human', id: 'bob' };

const CONTRACT: AcceptanceContract = {
  goalId: 'g1',
  statement: 'make a two and send a welcome mail',
  criteria: [
    { id: 'c1', statement: 'a is two', check: { kind: 'command', command: 'check-c1', timeoutSec: 30 } },
    { id: 'c2', statement: 'a welcome mail goes out', check: { kind: 'command', command: 'check-c2', timeoutSec: 30 }, requires: ['mail'] },
    { id: 'h1', statement: 'the mail copy reads well', check: { kind: 'human', prompt: 'does the copy read well?' } },
  ],
  outOfScope: [],
  assumptions: [],
};
const HASH = contractHash(CONTRACT);
const MOCKED_MAIL: CapabilityRecord[] = [{ id: 'mail', kind: 'smtp', state: 'mocked', resourceId: 'mock-mail' }];

let n = 0;
const ev = (kind: Parameters<typeof event>[0], payload: Record<string, unknown>, actor: Principal = SYS) =>
  event(kind, { id: `ev-${kind}-${++n}`, at: NOW - 100 + n, actor, runId: 'run1', trace: { goalId: 'g1' }, payload: payload as never });

/** The loop's record of a goal-file contract: adopted with it, drafted, accepted by the system (signoff: statement). */
async function acceptContract(ledger: Ledger, o: { accept?: boolean; mockMail?: boolean } = {}) {
  await ledger.append(ev('goal.adopted', { goal: { id: 'g1', statement: 'make a two', check: { command: 'node --test', timeoutSec: 60 }, commitment: 'single-minded', status: 'open', evidence: [], criteria: CONTRACT.criteria, contractHash: HASH } }));
  await ledger.append(ev('criteria.drafted', { contract: CONTRACT, hash: HASH, needs: [], source: 'goal-file' }));
  if (o.accept !== false) await ledger.append(ev('criteria.accepted', { hash: HASH, via: 'goal-file' }));
  if (o.mockMail !== false) await ledger.append(ev('capability.mocked', { capability: 'mail', kind: 'smtp', tool: 'send_mail', mockId: 'mock-mail', reason: 'no sender declared' }));
}

const withContract = (c: GateContext, x: Partial<GateContext> = {}): GateContext => ({
  ...c,
  goal: { ...c.goal, criteria: CONTRACT.criteria, contractHash: HASH },
  contract: CONTRACT,
  contractHash: HASH,
  inventory: MOCKED_MAIL,
  ...x,
});

interface Flow {
  repo: Repo;
  ledger: Ledger;
  runner: FakeRunner;
  gates: ReturnType<typeof createGates>;
  runsDir: string;
  d1: string;
  sha: string;
  commitKey: string;
  prCtx(approval: GateApproval | undefined, x?: Partial<GateContext>): GateContext;
  answer(o?: { requestId?: string; approver?: Principal; requester?: Principal; criterionId?: string; fingerprint?: string }): Promise<HumanCriterionAnswer>;
}

/** verify → review → verify → commit under the contract, the way the loop drives it (verify.passed recorded). */
async function flow(o: { ledger?: Ledger; extra?: Partial<CreateGatesOptions>; mockMail?: boolean; inventory?: CapabilityRecord[]; before?: (r: Repo, l: Ledger) => Promise<void> | void } = {}): Promise<Flow> {
  const repo = makeRepo();
  repo.write('src/a.ts', 'export const a = 2;\n');
  const ledger = o.ledger ?? LEDGERS[0]![1]();
  await acceptContract(ledger, { mockMail: o.mockMail });
  await o.before?.(repo, ledger);
  const runner = new FakeRunner();
  const inv = o.inventory ?? MOCKED_MAIL;
  const runsDir = mkdtempSync(join(tmpdir(), 'tecera-gates-runs-'));
  const gates = createGates({ manifest: manifest(), ledger, verifyRunner: runner, reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1', runsDir, gh: null, ...o.extra });
  const v = await gates.verify(withContract(ctx('v', { worktree: repo.dir }), { inventory: inv }));
  expect(v.exitCode).toBe(0);
  await recordVerify(ledger, v, { at: NOW - 3 });
  const r = await gates.review(withContract(ctx('r', { worktree: repo.dir, candidate: { d1: v.fingerprint } })));
  expect(r.verdict).toBe('approve');
  const v2 = await gates.verify(withContract(ctx('v', { worktree: repo.dir }), { inventory: inv }));
  expect(v2.exitCode).toBe(0);
  await recordVerify(ledger, v2, { at: NOW - 2 });
  const c = await gates.commit(withContract(ctx('c', { worktree: repo.dir, candidate: { d1: v2.fingerprint, d2: r.fingerprint } })));
  expect(c).toMatchObject({ exitCode: 0 });
  const f: Flow = {
    repo,
    ledger,
    runner,
    gates,
    runsDir,
    d1: v2.fingerprint,
    sha: c.sha!,
    commitKey: c.evidenceKey,
    prCtx: (approval, x = {}) => withContract(ctx('pr', { worktree: repo.dir, ...(approval ? { approval } : {}), commit: { sha: f.sha, d1: f.d1, evidenceKey: c.evidenceKey } }), { inventory: inv, ...x }),
    answer: async (a = {}) => {
      const requestId = a.requestId ?? 'ans-h1';
      const actionHash = answerCriterionActionHash({ goalId: 'g1', runId: 'run1', contractHash: HASH, criterionId: a.criterionId ?? 'h1', fingerprint: a.fingerprint ?? f.d1 });
      await ledger.requestApproval({ requestId, runId: 'run1', sessionId: 's1', actionHash, requester: a.requester ?? LOOP, reason: 'answer_criterion h1', expiresAt: NOW + 60_000 });
      await grantAudited(ledger, { requestId, runId: 'run1', sessionId: 's1', actionHash, approver: a.approver ?? BOB, stepId: 'pr' });
      return { criterionId: 'h1', approver: { kind: 'human', id: (a.approver ?? BOB).id }, verdict: 'yes', requestId, answeredAt: NOW };
    },
  };
  return f;
}

describe.each(LEDGERS)('gate.verify runs every command criterion on the frozen candidate (%s)', (_n, mk) => {
  it('one proof per command criterion on the same fingerprint, fidelity from the inventory, goal check last', async () => {
    const repo = makeRepo();
    repo.write('src/a.ts', 'export const a = 2;\n');
    const ledger = mk();
    const runner = new FakeRunner();
    const g = createGates({ manifest: manifest(), ledger, verifyRunner: runner, reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1' });
    const v = await g.verify(withContract(ctx('v', { worktree: repo.dir })));
    expect(v).toMatchObject({ exitCode: 0, outcome: 'passed', terminal: false });
    expect(v.failedCriteria).toBeUndefined();
    // Criteria first, inside the frozen D1; the goal's single check stays the final verify of the step.
    expect(runner.calls.map((c) => c.command)).toEqual(['check-c1', 'check-c2', 'node --test']);
    expect(v.criteria!.map((p) => [p.criterionId, p.via, p.fidelity, p.fingerprint, p.exitCode])).toEqual([
      ['c1', 'command', 'real', v.fingerprint, 0],
      ['c2', 'command', 'mocked', v.fingerprint, 0],
    ]);
    for (const p of v.criteria!) {
      expect(p.evidenceKey).toBe(criterionEvidenceKey('run1', p.criterionId, v.fingerprint));
      const rec = (await ledger.getEvidence(p.evidenceKey))!;
      expect(rec.kind).toBe('gate.verify');
      expect(rec.body).toMatchObject({ criterionId: p.criterionId, outcome: 'passed', exitCode: 0, fingerprint: v.fingerprint, runId: 'run1', contractHash: HASH, fidelity: p.fidelity, command: p.command });
    }
    // The step's own evidence (the goal check) names the criteria it covered.
    expect((await ledger.getEvidence(v.evidenceKey))!.body).toMatchObject({ command: 'node --test', outcome: 'passed', contractHash: HASH, criteria: [{ criterionId: 'c1' }, { criterionId: 'c2' }] });
    // A second verify on the unchanged candidate proves under the same keys again.
    const again = await g.verify(withContract(ctx('v', { worktree: repo.dir })));
    expect(again.exitCode).toBe(0);
    expect(again.criteria!.map((p) => p.evidenceKey)).toEqual(v.criteria!.map((p) => p.evidenceKey));
  });

  it('a criterion that exits non-zero fails the step (1, retryable), names it, and the goal check does not run', async () => {
    const repo = makeRepo();
    repo.write('src/a.ts', 'export const a = 2;\n');
    const ledger = mk();
    const runner = new FakeRunner((req) => ({ exitCode: req.command === 'check-c1' ? 3 : 0 }));
    const g = createGates({ manifest: manifest(), ledger, verifyRunner: runner, reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1' });
    const v = await g.verify(withContract(ctx('v', { worktree: repo.dir })));
    expect(v).toMatchObject({ exitCode: 1, outcome: 'failed', terminal: false, failedCriteria: ['c1'], criteria: [] });
    expect(v.reason).toMatch(/c1/);
    expect(runner.calls.map((c) => c.command)).toEqual(['check-c1', 'check-c2']);
    // No passing record under the failed criterion's key; the failure is evidence of its own.
    expect(await ledger.getEvidence(criterionEvidenceKey('run1', 'c1', v.fingerprint))).toBeNull();
    expect((await ledger.getEvidence(v.evidenceKey))!.body).toMatchObject({ outcome: 'failed', failedCriteria: ['c1'] });
    // A reviewed candidate whose last verify failed a criterion is never committed.
    const r = await g.review(withContract(ctx('r', { worktree: repo.dir, candidate: { d1: v.fingerprint } })));
    expect(await g.commit(withContract(ctx('c', { worktree: repo.dir, candidate: { d1: v.fingerprint, d2: r.fingerprint } })))).toMatchObject({ exitCode: 8, reason: 'verify-not-passed' });
  });

  it('a criterion requiring a missing capability proves nothing: refused (9) before any command runs, named', async () => {
    const repo = makeRepo();
    const runner = new FakeRunner();
    const g = createGates({ manifest: manifest(), ledger: mk(), verifyRunner: runner, reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1' });
    const v = await g.verify(withContract(ctx('v', { worktree: repo.dir }), { inventory: [] }));
    expect(v).toMatchObject({ exitCode: 9, outcome: 'refused', terminal: true, failedCriteria: ['c2'], criteria: [] });
    expect(runner.calls).toHaveLength(0);
  });

  it('a capability the context lists as missing counts as mocked once the run ledger records a stand-in for it: never refused (9), proven at fidelity mocked', async () => {
    const repo = makeRepo();
    repo.write('src/a.ts', 'export const a = 2;\n');
    const ledger = mk();
    const runner = new FakeRunner();
    const g = createGates({ manifest: manifest(), ledger, verifyRunner: runner, reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1' });
    // The loop built the context before the stand-in was recorded: its inventory says mail is missing.
    const missing: CapabilityRecord[] = [{ id: 'mail', kind: 'smtp', state: 'missing' }];
    expect(await g.verify(withContract(ctx('v', { worktree: repo.dir }), { inventory: missing }))).toMatchObject({ exitCode: 9, outcome: 'refused', failedCriteria: ['c2'] });
    await ledger.append(ev('capability.mocked', { capability: 'mail', kind: 'smtp', tool: 'mail', mockId: 'mock_mail', reason: 'mock rung' }));
    const v = await g.verify(withContract(ctx('v', { worktree: repo.dir }), { inventory: missing }));
    expect(v).toMatchObject({ exitCode: 0, outcome: 'passed' });
    expect(v.criteria!.map((p) => [p.criterionId, p.fidelity])).toEqual([['c1', 'real'], ['c2', 'mocked']]);
    // A mock recorded on the ledger never stands in for what the context says is available.
    const avail: CapabilityRecord[] = [{ id: 'mail', kind: 'smtp', state: 'available', probe: { command: 'true', exitCode: 0 } }];
    expect((await g.verify(withContract(ctx('v', { worktree: repo.dir }), { inventory: avail }))).criteria!.map((p) => p.fidelity)).toEqual(['real', 'real']);
    // A capability missing on both stays terminal.
    const other = { ...CONTRACT, criteria: [CONTRACT.criteria[0]!, { ...CONTRACT.criteria[1]!, requires: ['sms'] }] };
    expect(await g.verify(withContract(ctx('v', { worktree: repo.dir }), { contract: other, contractHash: contractHash(other), goal: { ...ctx('v').goal, criteria: other.criteria, contractHash: contractHash(other) }, inventory: missing }))).toMatchObject({ exitCode: 9, outcome: 'refused' });
  });

  it('a provisioned sqlite reaches the criterion as TECERA_RESOURCE_<ID>; fidelity provisioned only for a command that uses it, mocked for one that ignores it', async () => {
    const repo = makeRepo();
    repo.write('src/a.ts', 'export const a = 2;\n');
    const ledger = mk();
    const loc = "/tmp/tecera-res/res-db/it's.sqlite";
    const res: ProvisionedResource = { id: 'res-db', capability: 'db', kind: 'sqlite', provider: 'local', locator: loc, teardown: "rm -f -- '/tmp/tecera-res/res-db'", createdAt: NOW - 1000, expiresAt: NOW + 3_000_000, transfer: 'pending', goalId: 'g1', runId: 'run1' };
    await ledger.append(ev('resource.provisioned', { resource: res }));
    const contract: AcceptanceContract = {
      ...CONTRACT,
      criteria: [
        { id: 'uses', statement: 'sessions persist in the db', check: { kind: 'command', command: 'node -e "open(process.env.TECERA_RESOURCE_DB)"', timeoutSec: 30 }, requires: ['db'] },
        { id: 'ignores', statement: 'sessions persist somewhere', check: { kind: 'command', command: 'node -e "open(\':memory:\')"', timeoutSec: 30 }, requires: ['db'] },
        { id: 'plain', statement: 'a is two', check: { kind: 'command', command: 'check-plain', timeoutSec: 30 } },
      ],
    };
    const hash = contractHash(contract);
    const inv: CapabilityRecord[] = [{ id: 'db', kind: 'sqlite', state: 'provisioned', resourceId: 'res-db' }];
    const runner = new FakeRunner();
    const g = createGates({ manifest: manifest(), ledger, verifyRunner: runner, reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1' });
    const c = ctx('v', { worktree: repo.dir });
    const v = await g.verify({ ...c, goal: { ...c.goal, criteria: contract.criteria, contractHash: hash }, contract, contractHash: hash, inventory: inv });
    expect(v).toMatchObject({ exitCode: 0, outcome: 'passed' });
    expect(v.criteria!.map((p) => [p.criterionId, p.fidelity])).toEqual([['uses', 'provisioned'], ['ignores', 'mocked'], ['plain', 'real']]);
    // Both db criteria get the locator in their own shell (quoted); the others get nothing; evidence binds the criterion's own command.
    const quoted = `export TECERA_RESOURCE_DB='/tmp/tecera-res/res-db/it'\\''s.sqlite'; `;
    expect(runner.calls.map((r) => r.command)).toEqual([`${quoted}node -e "open(process.env.TECERA_RESOURCE_DB)"`, `${quoted}node -e "open(':memory:')"`, 'check-plain', 'node --test']);
    const uses = (await ledger.getEvidence(criterionEvidenceKey('run1', 'uses', v.fingerprint)))!.body as Record<string, unknown>;
    expect(uses).toMatchObject({ command: 'node -e "open(process.env.TECERA_RESOURCE_DB)"', fidelity: 'provisioned', resourceEnv: ['TECERA_RESOURCE_DB'] });
    expect((await ledger.getEvidence(criterionEvidenceKey('run1', 'ignores', v.fingerprint)))!.body).toMatchObject({ fidelity: 'mocked', resourceUnused: ['db'] });
    // A provisioned row whose resource the registry cannot vouch for gives no locator and proves nothing about it.
    const ghost: CapabilityRecord[] = [{ id: 'db', kind: 'sqlite', state: 'provisioned', resourceId: 'res-ghost' }];
    const w = await g.verify({ ...c, goal: { ...c.goal, criteria: contract.criteria, contractHash: hash }, contract, contractHash: hash, inventory: ghost });
    expect(w.criteria!.map((p) => p.fidelity)).toEqual(['mocked', 'mocked', 'real']);
  });

  it('a provisioned http-stub is out of a criterion\'s reach (criteria run without network): no URL is handed over and the criterion is mocked, never provisioned', async () => {
    const repo = makeRepo();
    repo.write('src/a.ts', 'export const a = 2;\n');
    const ledger = mk();
    const res: ProvisionedResource = { id: 'res-api', capability: 'api', kind: 'http-stub', provider: 'local', locator: 'http://127.0.0.1:45123', teardown: "rm -rf -- '/tmp/tecera-res/res-api'", createdAt: NOW - 1000, expiresAt: NOW + 3_000_000, transfer: 'pending', goalId: 'g1', runId: 'run1' };
    await ledger.append(ev('resource.provisioned', { resource: res }));
    const contract: AcceptanceContract = {
      ...CONTRACT,
      criteria: [
        { id: 'env', statement: 'the client calls the api', check: { kind: 'command', command: 'node -e "fetch(process.env.TECERA_RESOURCE_API)"', timeoutSec: 30 }, requires: ['api'] },
        { id: 'url', statement: 'the client calls the api', check: { kind: 'command', command: 'node call.mjs http://127.0.0.1:45123', timeoutSec: 30 }, requires: ['api'] },
      ],
    };
    const hash = contractHash(contract);
    const inv: CapabilityRecord[] = [{ id: 'api', kind: 'http-stub', state: 'provisioned', resourceId: 'res-api' }];
    const runner = new FakeRunner();
    const g = createGates({ manifest: manifest(), ledger, verifyRunner: runner, reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1' });
    const c = ctx('v', { worktree: repo.dir });
    const v = await g.verify({ ...c, goal: { ...c.goal, criteria: contract.criteria, contractHash: hash }, contract, contractHash: hash, inventory: inv });
    expect(v.criteria!.map((p) => [p.criterionId, p.fidelity])).toEqual([['env', 'mocked'], ['url', 'mocked']]);
    // nothing is exported to the criterion's shell
    expect(runner.calls.map((r) => r.command)).toEqual(['node -e "fetch(process.env.TECERA_RESOURCE_API)"', 'node call.mjs http://127.0.0.1:45123', 'node --test']);
    expect((await ledger.getEvidence(criterionEvidenceKey('run1', 'env', v.fingerprint)))!.body).toMatchObject({ fidelity: 'mocked', resourceUnused: ['api'] });
  });

  it('a criterion that mutates the candidate is terminal (9 mutated), like the goal check', async () => {
    const repo = makeRepo();
    repo.write('src/a.ts', 'export const a = 2;\n');
    const runner = new FakeRunner((req) => (req.command === 'check-c2' ? (writeFileSync(join(repo.dir, 'src/a.ts'), 'export const a = 3;\n'), {}) : {}));
    const g = createGates({ manifest: manifest(), ledger: mk(), verifyRunner: runner, reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1' });
    const v = await g.verify(withContract(ctx('v', { worktree: repo.dir })));
    expect(v).toMatchObject({ exitCode: 9, outcome: 'mutated', terminal: true, failedCriteria: ['c2'] });
    expect(runner.calls.map((c) => c.command)).toEqual(['check-c1', 'check-c2']);
  });

  it('the single-check path is unchanged; a goal promised a contract without one in GateContext, or a wrong hash, is refused', async () => {
    const repo = makeRepo();
    repo.write('src/a.ts', 'export const a = 2;\n');
    const runner = new FakeRunner();
    const g = createGates({ manifest: manifest(), ledger: mk(), verifyRunner: runner, reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1' });
    const plain = await g.verify(ctx('v', { worktree: repo.dir }));
    expect(plain).toMatchObject({ exitCode: 0, outcome: 'passed' });
    expect('criteria' in plain).toBe(false);
    expect(runner.calls.map((c) => c.command)).toEqual(['node --test']);
    const c = withContract(ctx('v', { worktree: repo.dir }));
    expect(await g.verify({ ...c, contract: undefined, contractHash: undefined })).toMatchObject({ exitCode: 9, outcome: 'refused' });
    expect(await g.verify({ ...c, contractHash: 'f'.repeat(64) })).toMatchObject({ exitCode: 9, outcome: 'refused' });
    expect(await g.verify({ ...c, contract: { ...CONTRACT, goalId: 'g2' }, contractHash: undefined })).toMatchObject({ exitCode: 9, outcome: 'refused' });
    expect(runner.calls).toHaveLength(1);
  });
});

describe.each(LEDGERS)('gate.pr under an acceptance contract (%s)', (_n, mk) => {
  it('lists every criterion, how it was proven and its own fidelity; a mocked criterion makes the PR provisional and is never called real', async () => {
    const f = await flow({ ledger: mk() });
    const ap = await prGrant(f.ledger, { sha: f.sha });
    const r = await f.gates.pr(f.prCtx(ap, { humanAnswers: [await f.answer()] }));
    expect(r).toMatchObject({ exitCode: 0, outcome: 'requested', provisional: true });
    const body = readFileSync(join(r.bundle!, 'body.md'), 'utf8');
    const request = JSON.parse(readFileSync(join(r.bundle!, 'request.json'), 'utf8')) as Record<string, any>;
    // The title says provisional; so do the body and request.json.
    expect(request.title).toMatch(/^tecera \(provisional\): /);
    expect(request).toMatchObject({ contractHash: HASH, fidelity: 'mocked', provisional: true });
    expect(request.criteria.map((p: any) => [p.criterionId, p.via, p.fidelity])).toEqual([
      ['c1', 'command', 'real'],
      ['c2', 'command', 'mocked'],
      ['h1', 'human', 'real'],
    ]);
    expect(body).toContain('## Acceptance criteria');
    expect(body).toContain(`- contract: ${HASH}`);
    expect(body).toContain('- fidelity: mocked (the weakest criterion)');
    expect(body).toMatch(/\*\*Provisional:\*\* c2 rest on a stand-in/);
    // Each criterion's block: c2 is mocked and nowhere real; exactly c1 and h1 are real.
    const block = (id: string) => body.slice(body.indexOf(`- ${id}: `)).split('\n').slice(0, 3).join('\n');
    expect(block('c1')).toMatch(/proven: command `check-c1` exited 0[\s\S]*fidelity: real/);
    expect(block('c2')).toMatch(/proven: command `check-c2` exited 0[\s\S]*fidelity: mocked, against a stand-in/);
    expect(block('c2')).not.toMatch(/real\b(?! capability)/);
    expect(block('h1')).toMatch(/answered yes by bob \(approval ans-h1\)[\s\S]*fidelity: real/);
    expect(body.match(/fidelity: real/g)).toHaveLength(2);
    // The recorded proof carries the same: what the loop settles goal.provisional with.
    const ev = (await f.ledger.getEvidence(r.evidenceKey))!.body as Record<string, any>;
    expect(ev).toMatchObject({ provisional: true, fidelity: 'mocked', contractHash: HASH });
    expect(ev.proof).toMatchObject({ contractHash: HASH, fidelity: 'mocked', fingerprint: f.d1, verifiedAt: NOW - 2 });
    expect(ev.proof.criteria.find((p: any) => p.criterionId === 'h1')).toMatchObject({ via: 'human', approver: 'bob', evidenceKey: 'ans-h1', fidelity: 'real', verifiedAt: NOW });
  });

  it('a mock is never upgraded: a loop-reported proof or an inventory claiming real does not make c2 real', async () => {
    const f = await flow({ ledger: mk() });
    const c = f.prCtx(await prGrant(f.ledger, { sha: f.sha }), {
      humanAnswers: [await f.answer()],
      inventory: [{ id: 'mail', kind: 'smtp', state: 'available', probe: { command: 'true', exitCode: 0 } }],
      criterionProofs: [{ criterionId: 'c2', via: 'command', fidelity: 'real', command: 'check-c2', exitCode: 0, fingerprint: f.d1, evidenceKey: criterionEvidenceKey('run1', 'c2', f.d1), verifiedAt: NOW }],
    });
    const r = await f.gates.pr(c);
    expect(r).toMatchObject({ exitCode: 0, provisional: true });
    const request = JSON.parse(readFileSync(join(r.bundle!, 'request.json'), 'utf8')) as Record<string, any>;
    expect(request.criteria.find((p: any) => p.criterionId === 'c2').fidelity).toBe('mocked');
  });

  it('the ledger inventory caps fidelity: a verify run on a context claiming mail available still lists c2 as mocked', async () => {
    // GateContext (and so the verify evidence) says mail is available; the run's ledger says a mock served it.
    const avail: CapabilityRecord[] = [{ id: 'mail', kind: 'smtp', state: 'available', probe: { command: 'true', exitCode: 0 } }];
    const f = await flow({ ledger: mk(), inventory: avail });
    expect(((await f.ledger.getEvidence(criterionEvidenceKey('run1', 'c2', f.d1)))!.body as { fidelity: string }).fidelity).toBe('real');
    const r = await f.gates.pr(f.prCtx(await prGrant(f.ledger, { sha: f.sha }), { humanAnswers: [await f.answer()] }));
    expect(r).toMatchObject({ exitCode: 0, provisional: true });
    const body = readFileSync(join(r.bundle!, 'body.md'), 'utf8');
    expect(body).toContain('- fidelity: mocked (the weakest criterion)');
    expect(body.match(/fidelity: real/g)).toHaveLength(2);
  });

  it('every criterion real → not provisional, plain title', async () => {
    const f = await flow({
      ledger: mk(),
      mockMail: false,
      before: async (_r, l) => {
        await l.append(ev('capability.probed', { capability: { id: 'mail', kind: 'smtp', state: 'available', probe: { command: 'true', exitCode: 0 } } }));
      },
      inventory: [{ id: 'mail', kind: 'smtp', state: 'available', probe: { command: 'true', exitCode: 0 } }],
    });
    const r = await f.gates.pr(f.prCtx(await prGrant(f.ledger, { sha: f.sha }), { humanAnswers: [await f.answer()] }));
    expect(r).toMatchObject({ exitCode: 0, outcome: 'requested' });
    expect(r.provisional).toBeUndefined();
    const request = JSON.parse(readFileSync(join(r.bundle!, 'request.json'), 'utf8')) as Record<string, any>;
    expect(request.provisional).toBe(false);
    expect(request.title).toMatch(/^tecera: /);
    expect(request.fidelity).toBe('real');
  });

  it('a criterion with no passing proof on the committed candidate blocks the PR (9), grant untouched, nothing bundled', async () => {
    const ledger = mk();
    let hide = false;
    const get = ledger.getEvidence.bind(ledger);
    ledger.getEvidence = async (k) => (hide && k === criterionEvidenceKey('run1', 'c1', f.d1) ? null : get(k));
    const f = await flow({ ledger });
    hide = true;
    const ap = await prGrant(f.ledger, { sha: f.sha });
    expect(await f.gates.pr(f.prCtx(ap, { humanAnswers: [await f.answer()] }))).toMatchObject({ exitCode: 9, reason: 'criterion-unproven', terminal: true });
    expect((await f.ledger.getApproval(ap.requestId))!.state).toBe('granted');
    expect(existsSync(join(f.runsDir, 'run1', 'pr'))).toBe(false);
  });

  it('human criteria: unanswered, answered no, answered with the PR approval, self-approved or for another candidate → refused', async () => {
    const f = await flow({ ledger: mk() });
    const ap = await prGrant(f.ledger, { sha: f.sha });
    const pr = (x: Partial<GateContext>) => f.gates.pr(f.prCtx(ap, x));
    expect(await pr({})).toMatchObject({ exitCode: 9, reason: 'criterion-unanswered' });
    const yes = await f.answer();
    expect(await pr({ humanAnswers: [{ ...yes, verdict: 'no' }] })).toMatchObject({ exitCode: 9, reason: 'criterion-rejected' });
    expect(await pr({ humanAnswers: [{ ...yes, requestId: ap.requestId }] })).toMatchObject({ exitCode: 9, reason: 'criterion-answer-invalid' });
    const self = await f.answer({ requestId: 'ans-self', requester: BOB });
    expect(await pr({ humanAnswers: [self] })).toMatchObject({ exitCode: 9, reason: 'criterion-answer-invalid' });
    const stale = await f.answer({ requestId: 'ans-stale', fingerprint: 'f'.repeat(64) });
    expect(await pr({ humanAnswers: [stale] })).toMatchObject({ exitCode: 9, reason: 'criterion-answer-invalid' });
    expect(await pr({ humanAnswers: [{ ...yes, approver: { kind: 'human', id: 'mallory' } }] })).toMatchObject({ exitCode: 9, reason: 'criterion-answer-invalid' });
    expect((await f.ledger.getApproval(ap.requestId))!.state).toBe('granted');
    expect(await pr({ humanAnswers: [yes] })).toMatchObject({ exitCode: 0 });
  });

  it('a contract the ledger never accepted is refused (9 contract-not-accepted)', async () => {
    const ledger = mk();
    const f = await flow({ ledger, before: async (_r, l) => void (await l.append(ev('criteria.amended', { from: HASH, to: HASH, contract: CONTRACT, reason: 'edited' }))) });
    expect(await f.gates.pr(f.prCtx(await prGrant(f.ledger, { sha: f.sha }), { humanAnswers: [await f.answer()] }))).toMatchObject({ exitCode: 9, reason: 'contract-not-accepted' });
  });

  it('lists the resources pending transfer with locator, teardown and expiry; a credential-bearing locator refuses the PR', async () => {
    const res: ProvisionedResource = { id: 'res-db', capability: 'db', kind: 'sqlite', provider: 'local', locator: '/tmp/tecera-res/sessions.sqlite', teardown: 'rm -f /tmp/tecera-res/sessions.sqlite', createdAt: NOW - 1000, expiresAt: NOW + 3_000_000, transfer: 'pending', goalId: 'g1', runId: 'run1' };
    const f = await flow({ ledger: mk(), before: async (_r, l) => void (await l.append(ev('resource.provisioned', { resource: res }))) });
    const ap = await prGrant(f.ledger, { sha: f.sha });
    const yes = await f.answer();
    // A resource GateContext lists that the ledger does not know is refused.
    expect(await f.gates.pr(f.prCtx(ap, { humanAnswers: [yes], pendingResources: [res, { ...res, id: 'res-ghost' }] }))).toMatchObject({ exitCode: 9, reason: 'resource-not-on-ledger' });
    const r = await f.gates.pr(f.prCtx(ap, { humanAnswers: [yes], pendingResources: [res] }));
    expect(r.exitCode).toBe(0);
    const body = readFileSync(join(r.bundle!, 'body.md'), 'utf8');
    expect(body).toContain('## Pending transfer');
    expect(body).toContain('- res-db (sqlite for db): `/tmp/tecera-res/sessions.sqlite`; teardown `rm -f /tmp/tecera-res/sessions.sqlite`; expires ');
    const request = JSON.parse(readFileSync(join(r.bundle!, 'request.json'), 'utf8')) as Record<string, any>;
    expect(request.pendingTransfer).toEqual([{ id: 'res-db', capability: 'db', kind: 'sqlite', locator: res.locator, teardown: res.teardown, expiresAt: res.expiresAt }]);

    const bad = await flow({ ledger: mk(), before: async (_r, l) => void (await l.append(ev('resource.provisioned', { resource: { ...res, id: 'res-bad', locator: 'https://u:p4ss@127.0.0.1/db' } }))) });
    const b = await bad.gates.pr(bad.prCtx(await prGrant(bad.ledger, { sha: bad.sha }), { humanAnswers: [await bad.answer()] }));
    expect(b).toMatchObject({ exitCode: 9, reason: 'resource-registry' });
    expect(JSON.stringify((await bad.ledger.getEvidence(b.evidenceKey))!.body)).not.toContain('p4ss');
  });
});
