import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  acceptedContractOf,
  acceptCriteriaActionHash,
  approvalGrantedEvent,
  capabilityInventoryOf,
  contractHash,
  resourceRegistryOf,
  signoffTrace,
  type AcceptanceContract,
  type CapabilityRecord,
  type CriterionProof,
  type JsonObject,
  type MockToolDeclaration,
  newIntention,
  type Plan,
  type Principal,
  type ProvisionedResource,
  type WorkerStepRequest,
} from '@tecera/contracts';
import { SqliteLedger } from '@tecera/ledger';
import { LocalProvisioner, ProvisioningRefused, teardownFor } from '@tecera/runtime';
import { Broker, createReadTool, FakeLLM, FakeRepl, liveWriteGuard, MockRegistrationError, standInFor, StepWorker } from '@tecera/worker';
import { cli, fixturePlan, fixtureReplies, git, js, type Ev } from './harness/e2e.js';
import {
  approvePending,
  both,
  contractRepo,
  contractScripts,
  copyCase,
  dump,
  editManifest,
  forge,
  GOAL_FILE,
  GOAL_ID,
  ledgerEvents,
  pendingRequest,
  REQUESTOR,
  requestIdOf,
  resume,
  runEvents,
  runEvidence,
  start,
  stopDecision,
  verdictOf,
  withCriteria,
  type ContractRun,
} from './harness/contract.js';
import { execReq, recorder, replRig } from './harness/sandbox.js';
import { cleanupTemps, tmp } from './harness/tmp.js';

/**
 * Owner decisions of 2026-10-06 (D8 acceptance contract, D9 capability inventory, D10 gap ladder, D11
 * fidelity, D12 provisioned resources are debts) under attack, through the REAL components: `tecera run`
 * end to end with scripted models (real ledger, sandbox, verify runner, gates, git, local provisioner), the
 * worker's broker and StepWorker, the sandbox child and the local provisioner. Each case is an attempt that
 * must be refused, and the refusal is read back from the ledger: plan.rejected, a hold that stays, a failed
 * step naming its reason, tool.denied evidence, stop.blocked, the absence of what the attempt wanted
 * (capability.mocked, pr.requested, goal.achieved) next to the event that shows it ran.
 *
 * Three checks also run below the ledger, as defence in depth beside an end-to-end case that records the
 * refusal: the Broker and StepWorker given a stand-in for an available capability (the run never offers
 * one; d10_mock_for_available [run] shows it on the ledger), the LocalProvisioner called past its
 * allowance (d12_provision_outside_allowance [run] and [forged ...]) and the sandbox child reaching a
 * provisioned locator. The last has no refusal to record: the child has no route to the resource at all,
 * and the stub's own request log and the database bytes are the evidence.
 *
 * Out-of-band attacks append chain-valid events with `forge` (a compromised component with ledger access);
 * a shared run is driven once and copied (copyCase) so each attack gets its own ledger.
 */

afterAll(cleanupTemps);

const STATEMENT = 'make the failing test pass';
/** The planner's draft for the statement run (contract.json in the scripts dir). */
const DRAFT = { criteria: [{ id: 'tests-pass', statement: 'the whole test suite passes', check: { kind: 'command', command: 'node --test', timeoutSec: 120 } }], assumptions: ['the failing test states the intended behaviour'] };
const TESTS_PASS = { id: 'tests-pass', statement: 'the test suite passes', verify: 'node --test' };
const SLUGIFY_TEST = { id: 'slugify-test', statement: 'the slugify test passes on its own', verify: 'node --test test/slugify.test.js', timeoutSec: 120 };

const kinds = (evs: readonly Ev[]): string[] => evs.map((e) => e.kind);
const payload = <T = Record<string, unknown>>(e: Ev | undefined): T => (e?.payload ?? {}) as T;
const after = (evs: readonly Ev[], seq: number): Ev[] => evs.filter((e) => e.seq > seq);
const GOAL_PATH = '.tecera/goals/fix-failing-test.goal.md';

/** A worker reply that also returns `variable` as the fact `key`: what the attack got back lands on the ledger (belief.added). */
function reportFact(text: string, key: string, variable: string): string {
  if (!text.includes('return { facts: [\n')) throw new Error('the worker reply returns no facts to extend');
  return text.replace('return { facts: [\n', `return { facts: [\n  { key: '${key}', value: ${variable} },\n`);
}

/** The fact `key` a worker step returned, as the loop recorded it. */
const factOf = (evs: readonly Ev[], stepId: string, key: string): { key: string; value: unknown } | undefined =>
  evs.map((e) => (e.kind === 'belief.added' && e.trace.stepId === stepId ? payload<{ key: string; value: unknown }>(e) : null)).find((p) => p?.key === key) ?? undefined;

/** Memoise a shared run: driven once, used by several attacks (each on its own copy). */
function once<T>(f: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= f());
}

/** A statement run held for the requestor's sign-off of the drafted contract (D8): nothing planned yet. */
async function heldAtSignoff(): Promise<ContractRun & { goalId: string; hash: string; requestId: string; requester: Principal; sessionId: string }> {
  const { dir, env } = await contractRepo();
  const run = await start(dir, env, STATEMENT, contractScripts({ contract: DRAFT, replies: {} }));
  expect(run.code, run.err + run.out + (await dump(dir))).toBe(4);
  const evs = await runEvents(run);
  expect(kinds(evs)).not.toContain('plan.generated');
  const goalId = evs.find((e) => e.kind === 'goal.adopted')!.trace.goalId!;
  const hash = payload<{ hash: string }>(evs.find((e) => e.kind === 'criteria.drafted')).hash;
  const req = pendingRequest(evs)!;
  expect(payload(req)).toMatchObject({ action: 'accept_criteria' });
  return { ...run, goalId, hash, requestId: requestIdOf(req)!, requester: req.actor, sessionId: payload<{ sessionId: string }>(req).sessionId };
}

/** Resume a statement run held at its sign-off: it must stay held for a sign-off of the same contract, nothing planned, no worker started. */
async function stillHeldAtSignoff(run: ContractRun, hash: string): Promise<Ev[]> {
  const seg = await resume(run, contractScripts({ contract: DRAFT }));
  expect(seg.code, seg.err + seg.out + (await dump(run.dir))).toBe(4);
  const evs = await runEvents(run);
  expect(kinds(evs), 'planned before the requestor signed off').not.toContain('plan.generated');
  expect(kinds(evs), 'a worker started before the requestor signed off').not.toContain('step.started');
  expect(payload(pendingRequest(evs)), 'the sign-off hold stands').toMatchObject({ action: 'accept_criteria', contractHash: hash });
  return evs;
}

/** A goal-file run (criteria in the file, accepted by it) driven to its PR hold. */
async function heldAtPr(o: { criteria?: Parameters<typeof withCriteria>[0]; mutate?: (dir: string) => void; plan?: unknown; replies?: NonNullable<Parameters<typeof contractScripts>[0]>['replies'] } = {}): Promise<ContractRun> {
  const { dir, env } = await contractRepo(both(withCriteria(o.criteria ?? [TESTS_PASS]), o.mutate ?? (() => undefined)));
  const run = await start(dir, env, GOAL_ID, contractScripts({ ...(o.plan ? { plan: o.plan } : {}), ...(o.replies ? { replies: o.replies } : {}) }));
  expect(run.code, run.err + run.out + (await dump(dir))).toBe(4);
  expect(payload(pendingRequest(await runEvents(run))).action ?? 'pr', 'held at the PR').not.toBe('accept_criteria');
  return run;
}

/** Approve the PR hold and resume to the end. */
async function deliver(run: ContractRun, plan?: unknown) {
  await approvePending(run);
  return resume(run, contractScripts({ ...(plan ? { plan } : {}), replies: {} }));
}

// ---- shared runs ---------------------------------------------------------------------------------------

/** A goal-file run with one criterion: a copy at its PR hold, then delivered (achieved). */
const goalFileRun = once(async () => {
  const run = await heldAtPr();
  const held = copyCase(run.dir);
  const done = await deliver(run);
  expect(done.code, done.err + done.out + (await dump(run.dir))).toBe(0);
  expect((await verdictOf(run.dir, run.runId)).achieved).toBe(true);
  return { run, held };
});

/** A goal-file run with two criteria that run the same command, held at its PR: each has its own verify evidence. */
const TWIN = { ...TESTS_PASS, id: 'tests-pass-twin', statement: 'the test suite passes, counted again' };
const twinRun = once(() => heldAtPr({ criteria: [TESTS_PASS, TWIN] }));

/** The plan and replies of a run whose edit step warms a cache through the broker's stand-in (D10 mock rung). */
function mockedScripts(): { plan: Plan; replies: ReturnType<typeof fixtureReplies> } {
  const plan = fixturePlan() as unknown as Plan;
  plan.permissions.tools.push('cache');
  plan.steps.find((s) => s.id === 'edit')!.tools!.push('cache');
  const replies = fixtureReplies();
  replies.worker[1] = { ...replies.worker[1]!, text: replies.worker[1]!.text.replace('```js\n', "```js\nawait cache.set('slug:warm', 'a-b-c');\n") };
  return { plan, replies };
}

/** A goal-file run whose criterion rests on a mocked cache: delivered, provisional (exit 10), never achieved. */
const mockedRun = once(async () => {
  const { plan, replies } = mockedScripts();
  const run = await heldAtPr({
    criteria: [{ id: 'tests-pass', statement: 'the test suite passes with the cache warmed', verify: 'node --test', requires: ['cache'] }],
    mutate: editManifest((m) => (m.connections = { cache: { kind: 'redis', mockable: true } })),
    plan,
    replies,
  });
  const done = await deliver(run, plan);
  expect(done.code, done.err + done.out + (await dump(run.dir))).toBe(10);
  const evs = await runEvents(run);
  expect(kinds(evs)).not.toContain('goal.achieved');
  expect(kinds(evs)).toContain('goal.provisional');
  expect(evs.filter((e) => e.kind === 'capability.mocked')).toHaveLength(1);
  return run;
});

/** The goal.achieved a compromised component would append: the run's own final verify, its criteria, a fidelity. */
function forgedProof(evs: readonly Ev[], fidelity: 'real' | 'provisioned' | 'mocked', o: { evidenceKey?: string } = {}): JsonObject {
  const passed = [...evs].reverse().find((e) => e.kind === 'verify.passed')!;
  const vp = payload<{ evidenceKey: string; fingerprint: string; criteria?: CriterionProof[] }>(passed);
  const hash = acceptedContractOf(evs, GOAL_ID, { runId: passed.runId! }).current!;
  const criteria = (vp.criteria ?? []).map((k) => ({ ...k, fidelity }));
  return { command: 'node --test', exitCode: 0, fingerprint: vp.fingerprint, evidenceKey: o.evidenceKey ?? vp.evidenceKey, verifiedAt: passed.at, contractHash: hash, criteria, fidelity } as unknown as JsonObject;
}

// ---- D8: the acceptance contract -------------------------------------------------------------------------

describe('D8 acceptance contract', () => {
  it('decision.d8_forged_acceptance: a criteria.accepted appended out of band (by an agent naming the pending sign-off; as a goal file for a statement run) accepts nothing: the resume stays held at the sign-off, nothing is planned, the Stop hook blocks and records it', async () => {
    const run = await heldAtSignoff();
    const trace = { goalId: run.goalId };
    await forge(run.dir, 'criteria.accepted', { runId: run.runId, trace, payload: { hash: run.hash, via: 'approval', requestId: run.requestId, approver: { kind: 'human', id: REQUESTOR } } });
    await forge(run.dir, 'criteria.accepted', { runId: run.runId, trace, actor: { kind: 'system', id: 'loop' }, payload: { hash: run.hash, via: 'goal-file' } });
    let evs = await runEvents(run);
    const view = acceptedContractOf(evs, run.goalId, { runId: run.runId });
    expect(view.state).toBe('drafted');
    expect(view.problems.join('\n')).toMatch(/has no audited grant by a human other than the requester|was not adopted with contract/);
    evs = await stillHeldAtSignoff(run, run.hash);
    const stop = await stopDecision(run.dir);
    expect(stop.code, stop.err).toBe(2);
    expect(stop.recorded?.kind).toBe('stop.blocked');
    // the hold is live: the requestor's own sign-off is the route that grants it
    const live = requestIdOf(pendingRequest(evs))!;
    const accept = await cli(run.dir, ['criteria', 'accept', run.runId, '--as', REQUESTOR], { env: run.env });
    expect(accept.code, accept.err + accept.out).toBe(0);
    const l = new SqliteLedger(join(run.dir, '.tecera/ledger.sqlite'));
    try {
      expect(await l.getApproval(live)).toMatchObject({ state: 'granted', approver: { kind: 'human', id: REQUESTOR } });
    } finally {
      l.close();
    }
  }, 300_000);

  it('decision.d8_forged_acceptance [forged sign-off chain]: an out-of-band approval.granted carrying a human actor, an approval.consumed by a system actor and a criteria.accepted, with no grant in the approvals table, accepts nothing: the resume plans nothing', async () => {
    const run = await heldAtSignoff();
    const trace = signoffTrace(run.goalId);
    const actionHash = acceptCriteriaActionHash({ goalId: run.goalId, runId: run.runId, contractHash: run.hash });
    const mallory: Principal = { kind: 'human', id: 'mallory' };
    await forge(run.dir, 'approval.granted', { runId: run.runId, trace, actor: mallory, payload: approvalGrantedEvent({ id: 'x', at: Date.now(), requestId: run.requestId, runId: run.runId, sessionId: run.sessionId, actionHash, approver: mallory, trace }).payload as Record<string, unknown> });
    await forge(run.dir, 'approval.consumed', { runId: run.runId, trace, actor: { kind: 'system', id: 'loop' }, payload: { requestId: run.requestId, actionHash, sessionId: run.sessionId } });
    await forge(run.dir, 'criteria.accepted', { runId: run.runId, trace: { goalId: run.goalId }, actor: { kind: 'system', id: 'loop' }, payload: { hash: run.hash, via: 'approval', requestId: run.requestId, approver: mallory } });
    // the approvals table never saw a grant: the request is still pending there
    const l = new SqliteLedger(join(run.dir, '.tecera/ledger.sqlite'));
    try {
      expect((await l.getApproval(run.requestId))?.state).toBe('pending');
    } finally {
      l.close();
    }
    // the event log alone says accepted; the approvals table is the authority the resume checks
    expect(acceptedContractOf(await runEvents(run), run.goalId, { runId: run.runId }).state).toBe('accepted');
    const evs = await stillHeldAtSignoff(run, run.hash);
    expect(kinds(evs), 'nothing is planned on a sign-off chain with no grant row').not.toContain('plan.generated');
    const stop = await stopDecision(run.dir);
    expect(stop.code, stop.err).toBe(2);
    expect(stop.recorded?.kind).toBe('stop.blocked');
  }, 300_000);

  it('decision.d8_self_acceptance: the requester of the sign-off (Tecera) cannot accept its own contract: the ledger refuses the self-grant and an agent grant; a forged self-grant chain on the ledger accepts nothing; the resume stays held', async () => {
    const run = await heldAtSignoff();
    expect(run.requester.kind).toBe('system');
    const trace = signoffTrace(run.goalId);
    const actionHash = acceptCriteriaActionHash({ goalId: run.goalId, runId: run.runId, contractHash: run.hash });
    const l = new SqliteLedger(join(run.dir, '.tecera/ledger.sqlite'));
    try {
      for (const who of [run.requester, { kind: 'agent', id: 'planner' } as Principal]) {
        const audit = approvalGrantedEvent({ id: `self_${who.kind}`, at: Date.now(), requestId: run.requestId, runId: run.runId, sessionId: run.sessionId, actionHash, approver: who, trace });
        await expect(l.approve(run.requestId, who, run.sessionId, Date.now(), audit), `${who.kind}:${who.id}`).rejects.toThrow(/requester cannot approve their own request|only a human principal can approve/);
      }
      expect((await l.getApproval(run.requestId))?.state).toBe('pending');
    } finally {
      l.close();
    }
    // the same self-grant written straight into the event log, consumed and accepted
    await forge(run.dir, 'approval.granted', { runId: run.runId, trace, actor: run.requester, payload: approvalGrantedEvent({ id: 'x', at: Date.now(), requestId: run.requestId, runId: run.runId, sessionId: run.sessionId, actionHash, approver: run.requester, trace }).payload as Record<string, unknown> });
    await forge(run.dir, 'approval.consumed', { runId: run.runId, trace, actor: { kind: 'system', id: 'loop' }, payload: { requestId: run.requestId, actionHash, sessionId: run.sessionId } });
    await forge(run.dir, 'criteria.accepted', { runId: run.runId, trace: { goalId: run.goalId }, actor: run.requester, payload: { hash: run.hash, via: 'approval', requestId: run.requestId, approver: run.requester } });
    const view = acceptedContractOf(await runEvents(run), run.goalId, { runId: run.runId });
    expect(view.state).toBe('drafted');
    expect(view.problems.join('\n')).toMatch(/no audited grant by a human other than the requester/);
    await stillHeldAtSignoff(run, run.hash);
    expect((await stopDecision(run.dir)).recorded?.kind).toBe('stop.blocked');
  }, 300_000);

  it('decision.d8_contract_edited: once accepted, the contract cannot be changed under the run: an out-of-band draft of a weaker contract makes the acceptance stale and the resume delivers nothing and achieves nothing; the stored contract rewritten in place breaks the hash chain (Stop blocks, criteria accept refuses, nothing is proven)', async () => {
    const run = await heldAtPr({ criteria: [TESTS_PASS, SLUGIFY_TEST] });
    const evs0 = await runEvents(run);
    const before = acceptedContractOf(evs0, GOAL_ID, { runId: run.runId });
    expect(before.state).toBe('accepted');
    const weak: AcceptanceContract = { ...before.contract!, criteria: [before.contract!.criteria[0]!] };
    const weakHash = contractHash(weak);
    // (b, on a copy first) the accepted contract rewritten in the database: the chain names the edit
    const copy = copyCase(run.dir);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(copy, '.tecera/ledger.sqlite'));
    for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>) db.exec(`DROP TRIGGER ${t.name}`);
    const drafted = evs0.find((e) => e.kind === 'criteria.drafted')!;
    db.prepare('UPDATE events SET payload = ? WHERE seq = ?').run(JSON.stringify({ ...payload(drafted), contract: weak, hash: weakHash }), drafted.seq);
    db.close();
    const cs = await stopDecision(copy);
    expect(cs.code, cs.err).toBe(2);
    expect(cs.err).toMatch(/chain/);
    const acc = await cli(copy, ['criteria', 'accept', run.runId, '--as', REQUESTOR], { env: run.env });
    expect(acc.code).toBe(9);
    await expect(verdictOf(copy, run.runId)).resolves.toMatchObject({ achieved: false });

    // (a) a weaker contract drafted after the acceptance, then the PR approved and the run resumed
    const draftId = await forge(run.dir, 'criteria.drafted', { runId: run.runId, trace: { goalId: GOAL_ID }, actor: { kind: 'agent', id: 'planner' }, payload: { contract: weak, hash: weakHash, needs: [], source: 'planner' } });
    const forgedAt = (await runEvents(run)).find((e) => e.id === draftId)!.seq;
    expect(acceptedContractOf(await runEvents(run), GOAL_ID, { runId: run.runId }).state).toBe('stale');
    const seg = await deliver(run);
    const evs = await runEvents(run);
    const tail = after(evs, forgedAt);
    expect(seg.code, seg.err + seg.out + (await dump(run.dir))).not.toBe(0);
    expect(kinds(tail), 'delivered under a stale contract').not.toContain('pr.requested');
    expect(kinds(tail)).not.toContain('pr.opened');
    expect(kinds(tail), 'achieved under a stale contract').not.toContain('goal.achieved');
    expect((await verdictOf(run.dir, run.runId)).achieved).toBe(false);
    // the refusal is on the ledger: the intention planned for the replaced contract is dropped or held for a new sign-off
    expect(tail.some((e) => e.kind === 'intention.dropped' || e.kind === 'goal.dropped' || (e.kind === 'approval.requested' && payload(e).action === 'accept_criteria')), kinds(tail).join(' ')).toBe(true);
  }, 600_000);

  it('decision.d8_weaker_draft: the planner cannot weaken a goal file\'s contract: its weaker draft is never asked for or recorded, and a plan whose verify steps cover only the weaker contract is refused (plan.rejected) before any worker runs', async () => {
    const plan = fixturePlan() as unknown as Plan;
    for (const s of plan.steps) if (s.kind === 'gate.verify') s.inputs = { ...(s.inputs ?? {}), criteria: ['tests-pass'] } as never;
    const weakDraft = { criteria: [DRAFT.criteria[0]] };
    const { dir, env } = await contractRepo(withCriteria([TESTS_PASS, SLUGIFY_TEST]));
    const run = await start(dir, env, GOAL_ID, contractScripts({ plan, contract: weakDraft }));
    const evs = await runEvents(run);
    expect(run.code, run.err + run.out + (await dump(dir))).not.toBe(0);
    expect(run.code).not.toBe(4);
    expect(evs.filter((e) => e.kind === 'criteria.drafted').map((e) => payload(e).source)).toEqual(['goal-file']);
    const rejected = evs.filter((e) => e.kind === 'plan.rejected');
    expect(rejected.length, kinds(evs).join(' ')).toBeGreaterThan(0);
    expect(JSON.stringify(rejected.map((e) => e.payload))).toMatch(/slugify-test/);
    expect(kinds(evs)).not.toContain('step.started');
    expect(kinds(evs)).not.toContain('goal.achieved');
    expect(acceptedContractOf(evs, GOAL_ID, { runId: run.runId }).accepted?.contract.criteria.map((k) => k.id)).toEqual(['tests-pass', 'slugify-test']);
  }, 300_000);

  it('decision.d8_weaker_draft [after achievement]: a planner draft appended after goal.achieved revokes the proof (ledgerProvenRun: not achieved)', async () => {
    const { run } = await goalFileRun();
    const copy = copyCase(run.dir);
    const evs = await ledgerEvents(copy);
    const c = acceptedContractOf(evs, GOAL_ID, { runId: run.runId }).contract!;
    const weak = { ...c, criteria: c.criteria.map((k) => ({ ...k, statement: `${k.statement} (roughly)` })) };
    await forge(copy, 'criteria.drafted', { runId: run.runId, trace: { goalId: GOAL_ID }, actor: { kind: 'agent', id: 'planner' }, payload: { contract: weak, hash: contractHash(weak), needs: [], source: 'planner' } });
    const v = await verdictOf(copy, run.runId);
    expect(v.achieved).toBe(false);
    expect(v.why).toMatch(/criteria.drafted after goal.achieved/);
  }, 600_000);

  it('decision.d8_worker_edits_criterion: a worker write to the contract (the goal file) is attempted, refused (tool.denied evidence, the program sees the refusal) and never lands', async () => {
    const replies = fixtureReplies();
    replies.worker[1] = {
      ...replies.worker[1]!,
      text: reportFact(
        replies.worker[1]!.text.replace('```js\n', `\`\`\`js\nlet contractDenied = null;\ntry { await writeFile({ path: '${GOAL_PATH}', oldText: 'node --test', newText: 'true' }); } catch (e) { contractDenied = String((e && e.message) || e); }\n`),
        'contractEditDenied',
        'contractDenied',
      ),
    };
    const run = await heldAtPr({ replies });
    const evs = await runEvents(run);
    // the attack ran: the edit step's program reached the write and reports what it got back
    const fact = factOf(evs, 'edit', 'contractEditDenied');
    expect(fact, kinds(evs).join(' ')).toBeDefined();
    expect(typeof fact!.value, 'the contract write was not refused').toBe('string');
    expect(String(fact!.value)).toMatch(/protected|denied|refused|not allowed|outside/i);
    // the refusal is on the ledger
    const denied = (await runEvidence(run.dir, run.runId)).filter((r) => r.kind === 'tool.denied' && (r.body as { path?: string }).path === GOAL_PATH);
    expect(denied.length, 'no tool.denied evidence for the contract write').toBeGreaterThan(0);
    expect(git(run.dir, 'diff', '--name-only', 'main', 'tecera/fix-failing-test').trim()).toBe('src/slugify.js');
    expect(git(run.dir, 'show', `tecera/fix-failing-test:${GOAL_PATH}`)).toBe(readFileSync(GOAL_FILE(run.dir), 'utf8'));
  }, 600_000);

  it('decision.d8_worker_edits_criterion [criterion check file]: a worker that rewrites the file a criterion\'s check runs (inside allowedChanges, not a protected path) is refused, and the rewrite never reaches the work branch', async () => {
    const check = "import assert from 'node:assert/strict';\nimport { slugify } from './slugify.js';\nassert.equal(slugify('a -- b  c'), 'a-b-c');\n";
    const replies = fixtureReplies();
    replies.worker[1] = {
      ...replies.worker[1]!,
      text: reportFact(
        replies.worker[1]!.text.replace('```js\n', "```js\nlet checkEdit = 'landed';\ntry { await writeFile({ path: 'src/check-slug.js', oldText: \"assert.equal(slugify('a -- b  c'), 'a-b-c');\", newText: 'process.exit(0);' }); } catch (e) { checkEdit = String((e && e.message) || e); }\n"),
        'criterionCheckEdit',
        'checkEdit',
      ),
    };
    const run = await heldAtPr({
      criteria: [TESTS_PASS, { id: 'slug-check', statement: 'the slug check script passes', verify: 'node src/check-slug.js' }],
      mutate: (d) => writeFileSync(join(d, 'src/check-slug.js'), check),
      replies,
    });
    const evs = await runEvents(run);
    // the attack ran: the edit step's program reached the write and reported its outcome (landed, or the refusal)
    const fact = factOf(evs, 'edit', 'criterionCheckEdit');
    expect(fact, kinds(evs).join(' ')).toBeDefined();
    expect(typeof fact!.value).toBe('string');
    // the refusal: the program got it back, and tool.denied evidence names the check file
    expect(String(fact!.value), 'the criterion check write was not refused').toMatch(/tampering/);
    const denied = (await runEvidence(run.dir, run.runId)).filter((r) => r.kind === 'tool.denied' && (r.body as { path?: string }).path === 'src/check-slug.js');
    expect(denied.length, 'no tool.denied evidence for the criterion check write').toBeGreaterThan(0);
    expect(git(run.dir, 'diff', '--name-only', 'main', 'tecera/fix-failing-test').trim().split('\n'), 'the rewritten criterion check never reaches the work branch').not.toContain('src/check-slug.js');
  }, 600_000);
});

// ---- D11: fidelity --------------------------------------------------------------------------------------

describe('D11 fidelity: a mock is never reported as real, never achieved', () => {
  it('decision.d11_mock_reported_real: the PR and the gate evidence of a run whose criterion rests on a mock say provisional and mocked, never real', async () => {
    const run = await mockedRun();
    const evs = await runEvents(run);
    const request = JSON.parse(readFileSync(join(run.dir, '.tecera/runs', run.runId, 'pr', 'request.json'), 'utf8')) as Record<string, unknown>;
    expect(request).toMatchObject({ provisional: true, fidelity: 'mocked' });
    expect(JSON.stringify(request.criteria)).not.toMatch(/"fidelity":"real"/);
    const body = readFileSync(join(run.dir, '.tecera/runs', run.runId, 'pr', 'body.md'), 'utf8');
    expect(body).toMatch(/provisional/i);
    expect(body).toMatch(/mocked/);
    const prEv = evs.find((e) => e.kind === 'pr.requested' || e.kind === 'pr.opened')!;
    expect(JSON.stringify(prEv.payload)).not.toMatch(/"fidelity":"real"/);
    const prov = evs.find((e) => e.kind === 'goal.provisional')!;
    expect(payload(prov)).toMatchObject({ mocked: ['tests-pass'] });
    expect(JSON.stringify(payload(prov).proof)).not.toMatch(/"fidelity":"real"/);
    const gate = (await runEvidence(run.dir, run.runId)).filter((r) => r.kind === 'gate.pr');
    expect(gate.length).toBeGreaterThan(0);
    for (const r of gate) expect((r.body as { fidelity?: string }).fidelity).toBe('mocked');
  }, 900_000);

  it('decision.d11_mock_reported_real [PR event]: the ledger\'s own record of the delivered PR says provisional when a criterion rests on a mock (an auditor reading only the ledger cannot tell otherwise)', async () => {
    const run = await mockedRun();
    const evs = await runEvents(run);
    const prEv = evs.find((e) => e.kind === 'pr.requested' || e.kind === 'pr.opened');
    expect(prEv, 'the PR was delivered').toBeTruthy();
    const gate = (await runEvidence(run.dir, run.runId)).filter((r) => r.kind === 'gate.pr');
    expect(gate.some((r) => (r.body as { provisional?: boolean }).provisional === true), 'the gate evidence says provisional').toBe(true);
    expect(payload(prEv).provisional, 'the PR event says provisional').toBe(true);
  }, 900_000);

  it('decision.d11_mock_reported_real [proof]: a goal.achieved claiming real fidelity for the mocked criterion is refused: not achieved, the Stop hook blocks and records it', async () => {
    const run = await mockedRun();
    const copy = copyCase(run.dir);
    await forge(copy, 'goal.achieved', { runId: run.runId, trace: { goalId: GOAL_ID }, payload: { proof: forgedProof(await ledgerEvents(copy), 'real') } });
    const v = await verdictOf(copy, run.runId);
    expect(v.achieved).toBe(false);
    expect(v.why).toMatch(/claims real, the inventory allows at best mocked/);
    const stop = await stopDecision(copy);
    expect(stop.code, stop.err).toBe(2);
    expect(stop.recorded?.kind).toBe('stop.blocked');
  }, 900_000);

  it('decision.d11_mock_reported_real [relabelled capability]: a capability.probed "available" appended out of band after the mock (any actor, a probe command that "exited 0") never lets a goal.achieved claiming real fidelity for the mocked criterion stand: the criterion\'s recorded fidelity is a ceiling; the Stop hook blocks', async () => {
    const run = await mockedRun();
    const copy = copyCase(run.dir);
    await forge(copy, 'capability.probed', { runId: run.runId, trace: {}, payload: { capability: { id: 'cache', kind: 'redis', state: 'available', probe: { command: 'true', exitCode: 0 } } } });
    await forge(copy, 'goal.achieved', { runId: run.runId, trace: { goalId: GOAL_ID }, payload: { proof: forgedProof(await ledgerEvents(copy), 'real') } });
    // the criterion's own verify evidence recorded it as mocked
    const crit = (await runEvidence(copy, run.runId)).filter((r) => r.kind === 'gate.verify' && (r.body as { criterionId?: string }).criterionId === 'tests-pass');
    expect(crit.length).toBeGreaterThan(0);
    for (const r of crit) expect((r.body as { fidelity?: string }).fidelity).toBe('mocked');
    const v = await verdictOf(copy, run.runId);
    expect(v.achieved, 'a mocked criterion relabelled real is not achieved').toBe(false);
    expect(v.why).toMatch(/criterion tests-pass claims real, its verify evidence recorded mocked/);
    const stop = await stopDecision(copy);
    expect(stop.code, stop.err).toBe(2);
    expect(stop.recorded?.kind).toBe('stop.blocked');
  }, 900_000);

  it('decision.d11_mock_reported_real [beliefs]: facts a worker step returned after using a stand-in are recorded as simulated beliefs', async () => {
    const run = await mockedRun();
    const evs = await runEvents(run);
    const mocked = evs.find((e) => e.kind === 'capability.mocked')!;
    const facts = evs.filter((e) => e.kind === 'belief.added' && e.trace.stepId === 'edit');
    expect(facts.length, 'the mocked step returned facts').toBeGreaterThan(0);
    expect(mocked.trace.goalId).toBe(GOAL_ID);
    expect(facts.map((e) => payload<{ provenance?: { simulated?: boolean; src?: string } }>(e).provenance?.simulated === true || String(payload<{ provenance?: { src?: string } }>(e).provenance?.src ?? '').startsWith('simulated:')), 'beliefs from a mocked step are simulated').toEqual(facts.map(() => true));
  }, 900_000);

  it('decision.d11_achieved_over_mock: a goal.achieved over the mocked criterion (labelled mocked, labelled provisioned, with no fidelity on the proof, or with no fidelity anywhere) is never achieved: provenRun says provisional, the Stop hook blocks and records it, status does not say achieved', async () => {
    const run = await mockedRun();
    /** The proof with its fidelity removed: from the proof only, or from the proof and every criterion proof. */
    const unlabelled = (evs: readonly Ev[], criteriaToo: boolean): JsonObject => {
      const { fidelity: _f, ...rest } = forgedProof(evs, 'mocked') as Record<string, unknown>;
      return { ...rest, ...(criteriaToo ? { criteria: (rest.criteria as Array<Record<string, unknown>>).map(({ fidelity: _k, ...c }) => c) } : {}) } as JsonObject;
    };
    const variants: Array<[string, (evs: readonly Ev[]) => JsonObject, RegExp]> = [
      ['mocked', (evs) => forgedProof(evs, 'mocked'), /mock|provisional|inventory allows/],
      ['provisioned', (evs) => forgedProof(evs, 'provisioned'), /claims provisioned, the inventory allows at best mocked/],
      ['no proof fidelity', (evs) => unlabelled(evs, false), /mock|provisional|inventory allows/],
      ['no fidelity anywhere', (evs) => unlabelled(evs, true), /records no fidelity/],
    ];
    for (const [name, proofOf, why] of variants) {
      const copy = copyCase(run.dir);
      const proof = proofOf(await ledgerEvents(copy));
      if (name.startsWith('no ')) expect(JSON.stringify(proof).includes('"fidelity":"real"') || (proof as { fidelity?: unknown }).fidelity !== undefined, name).toBe(false);
      await forge(copy, 'goal.achieved', { runId: run.runId, trace: { goalId: GOAL_ID }, payload: { proof } });
      const v = await verdictOf(copy, run.runId);
      expect(v.achieved, name).toBe(false);
      expect(v.why, name).toMatch(why);
      const stop = await stopDecision(copy);
      expect(stop.code, `${name}: ${stop.err}`).toBe(2);
      expect(stop.recorded?.kind, name).toBe('stop.blocked');
      const st = await cli(copy, ['status', '--json']);
      expect(st.out, name).not.toMatch(/"achieved":true/);
    }
  }, 900_000);

  it('decision.d11_forged_achieved_stop: while the contract run is held at its PR, a goal.achieved whose proof names no verify evidence, carries no criterion proofs, names another command, or proves each criterion with the other criterion\'s evidence (same command) does not let the assistant stop (stop.blocked recorded)', async () => {
    const { run, held } = await goalFileRun();
    const evs = await ledgerEvents(held);
    const twin = await twinRun();
    const twinEvs = await ledgerEvents(twin.dir);
    // two criteria with the same command: each proof names the other's gate.verify evidence (the commands match)
    const swapped = forgedProof(twinEvs, 'real') as unknown as { criteria: CriterionProof[] };
    expect(swapped.criteria.map((k) => k.criterionId).sort()).toEqual(['tests-pass', 'tests-pass-twin']);
    const keys = swapped.criteria.map((k) => k.evidenceKey);
    expect(new Set(keys).size, 'each criterion has its own evidence').toBe(2);
    const crossed = { ...swapped, criteria: swapped.criteria.map((k, i) => ({ ...k, evidenceKey: keys[1 - i]! })) } as unknown as JsonObject;
    const variants: Array<[string, string, string, JsonObject, RegExp]> = [
      ['no evidence', held, run.runId, { ...forgedProof(evs, 'real'), evidenceKey: `verify:${run.runId}:forged` }, /evidence/],
      ['no criteria', held, run.runId, { ...forgedProof(evs, 'real'), criteria: [] }, /has no proof/],
      ['another command', held, run.runId, { ...forgedProof(evs, 'real'), command: 'true' }, /command/],
      ['evidence of another criterion', twin.dir, twin.runId, crossed, /its evidence is for criterion tests-pass(-twin)?\b/],
    ];
    for (const [name, base, runId, proof, why] of variants) {
      const copy = copyCase(base);
      await forge(copy, 'goal.achieved', { runId, trace: { goalId: GOAL_ID }, payload: { proof } });
      const v = await verdictOf(copy, runId);
      expect(v.achieved, name).toBe(false);
      expect(v.why, name).toMatch(why);
      const stop = await stopDecision(copy);
      expect(stop.code, `${name}: ${stop.err}`).toBe(2);
      expect(stop.recorded?.kind, name).toBe('stop.blocked');
    }
  }, 900_000);

  it('decision.d11_forged_achieved_stop [well-formed while held]: a goal.achieved whose proof copies the real final verify and criterion proofs, appended while the run is held at its PR (nothing delivered), does not let the assistant stop', async () => {
    const { run, held } = await goalFileRun();
    const copy = copyCase(held);
    await forge(copy, 'goal.achieved', { runId: run.runId, trace: { goalId: GOAL_ID }, payload: { proof: forgedProof(await ledgerEvents(copy), 'real') } });
    const evs = await ledgerEvents(copy);
    expect(kinds(evs)).not.toContain('pr.requested');
    expect(kinds(evs)).not.toContain('pr.opened');
    const stop = await stopDecision(copy);
    expect(stop.code, 'the Stop hook blocks an achievement claimed before delivery').toBe(2);
    expect(stop.recorded?.kind).toBe('stop.blocked');
    expect(stop.err).toMatch(/before delivering it: no PR was delivered/);
  }, 900_000);
});

// ---- D9 / D10: inventory and gap ladder ------------------------------------------------------------------

describe('D9/D10 capability inventory and gap ladder', () => {
  it('decision.d9_undeclared_connection: a criterion needing a connection the manifest does not declare, and one needing a declared connection that probes missing and can be neither provisioned nor mocked, never reach a worker: the run holds asking for the capability (capability.missing resolution ask)', async () => {
    for (const [name, mutate, need] of [
      ['undeclared', withCriteria([{ ...TESTS_PASS, requires: ['vault'] }]), 'vault'],
      [
        'missing, not mockable',
        both(editManifest((m) => (m.connections = { billing: { kind: 'payments', probe: 'node -e "process.exit(3)"', mockable: false } })), withCriteria([{ ...TESTS_PASS, requires: ['billing'] }])),
        'billing',
      ],
    ] as const) {
      const { dir, env } = await contractRepo(mutate);
      const run = await start(dir, env, GOAL_ID, contractScripts());
      const evs = await runEvents(run);
      expect(kinds(evs), `${name}\n${await dump(dir)}`).not.toContain('step.started');
      expect(kinds(evs), name).not.toContain('resource.provisioned');
      expect(kinds(evs), name).not.toContain('capability.mocked');
      const missing = evs.filter((e) => e.kind === 'capability.missing' && payload<{ capability: { id: string } }>(e).capability.id === need);
      expect(missing.length, `${name}: ${kinds(evs).join(' ')}`).toBeGreaterThan(0);
      expect(payload(missing[missing.length - 1])).toMatchObject({ resolution: 'ask' });
      expect(run.code, name).toBe(4);
      expect(payload(pendingRequest(evs))).toMatchObject({ action: 'provide_capability' });
    }
  }, 600_000);

  it('decision.d9_undeclared_connection [plan]: a plan that names a capability no criterion requires and the manifest does not declare is refused (plan.rejected) before any worker runs', async () => {
    const plan = fixturePlan() as unknown as Plan;
    plan.capabilities = ['vault'];
    plan.permissions.tools.push('vault');
    plan.steps.find((s) => s.id === 'edit')!.tools!.push('vault');
    const { dir, env } = await contractRepo(withCriteria([TESTS_PASS]));
    const run = await start(dir, env, GOAL_ID, contractScripts({ plan }));
    const evs = await runEvents(run);
    expect(kinds(evs), await dump(dir)).not.toContain('step.started');
    expect(kinds(evs)).not.toContain('goal.achieved');
    expect(evs.some((e) => e.kind === 'plan.rejected' || (e.kind === 'capability.missing' && payload<{ capability: { id: string } }>(e).capability.id === 'vault')), kinds(evs).join(' ')).toBe(true);
  }, 300_000);

  it('decision.d10_mock_for_available [run]: a declared connection that probes available and allows a stand-in is never mocked in a run whose step names it: the ledger records the probe (available), no capability.mocked, the step\'s program finds no stand-in, the criterion is proven real', async () => {
    const { plan, replies } = mockedScripts();
    replies.worker[1] = { ...replies.worker[1]!, text: reportFact(replies.worker[1]!.text.replace("await cache.set('slug:warm', 'a-b-c');\n", 'const cacheTool = typeof cache;\n'), 'cacheTool', 'cacheTool') };
    expect(replies.worker[1]!.text).not.toMatch(/cache\.set/);
    const run = await heldAtPr({
      criteria: [{ id: 'tests-pass', statement: 'the test suite passes with the cache warmed', verify: 'node --test', requires: ['cache'] }],
      mutate: editManifest((m) => (m.connections = { cache: { kind: 'redis', probe: 'true', mockable: true } })),
      plan,
      replies,
    });
    const evs = await runEvents(run);
    const probed = evs.filter((e) => e.kind === 'capability.probed' && payload<{ capability: { id: string } }>(e).capability.id === 'cache');
    expect(probed.length, kinds(evs).join(' ')).toBeGreaterThan(0);
    expect(payload<{ capability: CapabilityRecord }>(probed[probed.length - 1]).capability.state).toBe('available');
    // recorded by the loop's own probe (today actor agent:loop, the run's loop principal), never by a worker
    expect(probed.map((e) => (e.actor.kind === 'system' ? 'system' : `${e.actor.kind}:${e.actor.id}`)).filter((a) => a !== 'system' && a !== 'agent:loop'), 'the probe is the loop\'s').toEqual([]);
    // the step ran, and no stand-in was served or recorded for the available capability
    expect(factOf(evs, 'edit', 'cacheTool')?.value, kinds(evs).join(' ')).toBe('undefined');
    expect(kinds(evs)).not.toContain('capability.mocked');
    expect(await runEvidence(run.dir, run.runId).then((rs) => rs.filter((r) => r.kind === 'capability.mocked'))).toEqual([]);
    const passed = [...evs].reverse().find((e) => e.kind === 'verify.passed');
    expect(payload<{ criteria?: CriterionProof[] }>(passed).criteria?.map((k) => [k.criterionId, k.fidelity])).toEqual([['tests-pass', 'real']]);
  }, 600_000);

  it('decision.d10_mock_for_available: a stand-in for a capability that is available is never served: the broker refuses to register it, the StepWorker aborts the step before any model call, and a capability.mocked appended after the probe never downgrades the inventory', async () => {
    const decl: MockToolDeclaration = { capability: 'mail', kind: 'email', tool: 'mail', methods: ['send', 'outbox'], schema: { type: 'object' }, mockId: 'mock_mail_adv', reason: 'adversarial' };
    const available: CapabilityRecord = { id: 'mail', kind: 'email', state: 'available', probe: { command: 'smtp-check', exitCode: 0 } };
    const wt = tmp('tecera-adv-mock-');
    mkdirSync(join(wt, 'src'));
    const caps = { tools: ['read', 'mail'], paths: { read: ['**'], write: ['src/**'], protected: [] }, network: 'none' as const, limits: { usd: 1, tokens: 1000, calls: 5, wallMs: 10_000, depth: 2, iterations: 3 } };
    // 1. the broker: registration refused against the inventory
    expect(() => new Broker({ tools: [createReadTool()], runId: 'run_m', worktree: wt, capabilities: caps, fencingToken: 1, guard: liveWriteGuard(), standIns: [{ declaration: decl, tool: standInFor(decl) }], inventory: [available] })).toThrow(MockRegistrationError);
    // 2. the StepWorker over a real ledger whose inventory shows mail available
    const ledgerPath = join(tmp('tecera-adv-mockl-'), 'ledger.sqlite');
    const ledger = new SqliteLedger(ledgerPath);
    try {
      await ledger.append({ id: 'ev_probe', kind: 'capability.probed', at: 1, actor: { kind: 'system', id: 'probe' }, runId: 'run_m', trace: {}, payload: { capability: available as unknown as JsonObject } });
      const plan = { id: 'p_m', trigger: { kind: 'goal.adopted' }, context: [], steps: [{ id: 'welcome', kind: 'worker', dependsOn: [], inputs: {}, instruction: 'send the welcome email' }], allowedModels: {}, permissions: { tools: ['read', 'mail'], write: [], approvals: [] }, budget: {}, origin: 'generated', status: 'candidate', goalKinds: [] } as unknown as Plan;
      const llm = new FakeLLM([js("await mail.send({ to: 'x@example.test' }); return { summary: 'sent' };")]);
      const req: WorkerStepRequest = {
        runId: 'run_m',
        goal: { id: 'g_m', statement: 'send a welcome email', check: { command: 'node --test', timeoutSec: 30 }, commitment: 'single-minded', status: 'open', evidence: [] },
        plan,
        intention: newIntention({ id: 'i_m', goalId: 'g_m', plan, commitment: 'single-minded' }),
        step: plan.steps[0]!,
        seatId: 'cheap',
        inputs: {},
        capabilities: caps,
        worktree: wt,
        fencingToken: 1,
        guard: liveWriteGuard(),
        mocks: [decl],
      };
      const out = await new StepWorker({ seats: { cheap: llm }, repl: new FakeRepl(), tools: [createReadTool()], hooks: [], ledger }).run(req);
      expect(out.kind).toBe('aborted');
      if (out.kind === 'aborted') expect(out.reasons[0]).toMatchObject({ code: 'policy', reason: expect.stringMatching(/available/) });
      expect(llm.requests).toHaveLength(0);
      expect(await ledger.listEvidence('run_m', 'capability.mocked')).toEqual([]);
      // 3. a capability.mocked appended after the probe: the inventory keeps the real one and names the attempt
      await ledger.append({ id: 'ev_mock', kind: 'capability.mocked', at: 2, actor: { kind: 'agent', id: 'worker' }, runId: 'run_m', trace: { goalId: 'g_m' }, payload: { capability: 'mail', kind: 'email', tool: 'mail', mockId: 'mock_mail_adv', reason: 'adversarial' } });
      const evs = [];
      for await (const e of ledger.events({ runId: 'run_m' })) evs.push(e);
      const inv = capabilityInventoryOf(evs, { runId: 'run_m' });
      expect(inv.byId.mail?.state).toBe('available');
      expect(inv.problems.join('\n')).toMatch(/a mock may not stand in for it/);
    } finally {
      ledger.close();
    }
  });
});

// ---- D12: provisioned resources are debts ----------------------------------------------------------------

/** A resource a compromised component records itself (agent actor): valid unless the case breaks it. */
function forgedResource(o: Partial<ProvisionedResource> & { id: string }): Record<string, unknown> {
  const now = Date.now();
  return { capability: 'scratch', kind: 'tmpdir', provider: 'local', locator: `/tmp/tecera-adv-forged/${o.id}`, teardown: `rm -rf /tmp/tecera-adv-forged/${o.id}`, createdAt: now, expiresAt: now + 600_000, transfer: 'pending', ...o };
}

/** The sample manifest's provisioning allowance (the schema default): what the PR gate checks resources against. */
const SAMPLE_ALLOWANCE = { scope: 'local', kinds: ['tmpdir', 'git-remote', 'sqlite', 'http-stub'], maxResources: 4, ttlSec: 3600 } as const;

/**
 * Forge `resources` into a goal-file run held at its PR, approve, resume: the PR gate must refuse delivery,
 * and the refusal is on the ledger (step.failed of the PR step naming the resource registry). Nothing is
 * delivered, bundled or achieved. `problems` are the registry's problems over the run's ledger with the
 * manifest allowance: the caller checks they name exactly its violation.
 */
async function prRefusesForgedResources(resources: Array<Record<string, unknown>>): Promise<{ run: ContractRun; tail: Ev[]; code: number; refusal: Record<string, unknown>; problems: string[] }> {
  const run = await heldAtPr();
  let first = Number.POSITIVE_INFINITY;
  for (const r of resources) {
    const id = await forge(run.dir, 'resource.provisioned', { runId: run.runId, trace: { goalId: GOAL_ID }, payload: { resource: r } });
    first = Math.min(first, (await runEvents(run)).find((e) => e.id === id)!.seq);
  }
  const seg = await deliver(run);
  const evs = await runEvents(run);
  const tail = after(evs, first);
  expect(seg.code, seg.err + seg.out + (await dump(run.dir))).not.toBe(0);
  expect(kinds(tail), kinds(tail).join(' ')).not.toContain('pr.requested');
  expect(kinds(tail)).not.toContain('pr.opened');
  expect(kinds(tail)).not.toContain('goal.achieved');
  const failed = tail.filter((e) => e.kind === 'step.failed' && e.trace.stepId === 'pr');
  expect(failed.length, `the PR gate's refusal is on the ledger: ${kinds(tail).join(' ')}`).toBeGreaterThan(0);
  const refusal = payload(failed[0]);
  expect(JSON.stringify(refusal)).toMatch(/resource-registry/);
  const prDir = join(run.dir, '.tecera/runs', run.runId, 'pr');
  expect(existsSync(prDir) ? readdirSync(prDir) : [], 'nothing is bundled').toEqual([]);
  expect((await verdictOf(run.dir, run.runId)).achieved).toBe(false);
  const problems = resourceRegistryOf(evs, { runId: run.runId, goalId: GOAL_ID, allowance: SAMPLE_ALLOWANCE }).problems;
  return { run, tail, code: seg.code, refusal, problems };
}

describe('D12 provisioned resources', () => {
  it('decision.d12_provision_outside_allowance: the local provisioner refuses a kind outside the allowance, a resource past maxResources and a scope of none; it never records a lifetime beyond the allowance', async () => {
    const repoRoot = tmp('tecera-adv-prov-repo-');
    const root = join(tmp('tecera-adv-prov-'), 'resources');
    const base = { root, repoRoot, runId: 'run_prov' };
    const narrow = new LocalProvisioner({ ...base, allowance: { scope: 'local', kinds: ['tmpdir'], maxResources: 1, ttlSec: 60 } });
    await expect(narrow.provision({ capability: 'db', kind: 'sqlite', goalId: 'g' })).rejects.toThrow(/outside the allowance/);
    const first = await narrow.provision({ capability: 'scratch', kind: 'tmpdir', goalId: 'g', ttlSec: 86_400 });
    // ProvisionNeed.ttlSec asks for a SHORTER lifetime (the loop never passes one): a longer request gets the
    // allowance's own lifetime, never more. A record claiming more is refused ([forged ttl]).
    expect(first.expiresAt - first.createdAt, 'a longer lifetime than the allowance is clamped').toBe(60_000);
    expect(resourceRegistryOf([{ id: 'e', kind: 'resource.provisioned', at: 1, actor: { kind: 'system', id: 'p' }, runId: 'run_prov', trace: { goalId: 'g' }, payload: { resource: first as unknown as JsonObject } }] as unknown as Ev[], { runId: 'run_prov', allowance: { scope: 'local', kinds: ['tmpdir'], maxResources: 1, ttlSec: 60 } }).problems).toEqual([]);
    await expect(narrow.provision({ capability: 'scratch2', kind: 'tmpdir', goalId: 'g' })).rejects.toThrow(/already provisioned 1 of 1/);
    // a second provisioner of the same run on the same root sees the live record (no doubled allowance)
    await expect(new LocalProvisioner({ ...base, allowance: { scope: 'local', kinds: ['tmpdir'], maxResources: 1, ttlSec: 60 } }).provision({ capability: 'scratch3', kind: 'tmpdir', goalId: 'g' })).rejects.toThrow(ProvisioningRefused);
    await expect(new LocalProvisioner({ ...base, runId: 'run_none', allowance: { scope: 'none', kinds: ['tmpdir'], maxResources: 4, ttlSec: 60 } }).provision({ capability: 'x', kind: 'tmpdir', goalId: 'g' })).rejects.toThrow(/scope is none/);
    expect((await narrow.releaseResource(first)).teardownExit).toBe(0);
  });

  it('decision.d12_provision_outside_allowance [run]: a missing git remote whose kind the manifest allowance excludes is not provisioned; past maxResources a second need is not provisioned: both hold asking (capability.missing ask), nothing provisioned beyond the allowance', async () => {
    for (const [name, mutate, provisioned] of [
      [
        'kind outside the allowance',
        both(
          editManifest((m) => {
            m.connections = { origin: { kind: 'git-remote', probe: 'git ls-remote --exit-code origin', mockable: false } };
            m.provisioning = { scope: 'local', kinds: ['tmpdir'], maxResources: 4, ttlSec: 3600 };
          }),
          withCriteria([{ ...TESTS_PASS, requires: ['origin'] }]),
        ),
        0,
      ],
      [
        'past maxResources',
        both(
          editManifest((m) => {
            m.connections = { origin: { kind: 'git-remote', probe: 'git ls-remote --exit-code origin', mockable: false }, store: { kind: 'sqlite', probe: 'node -e "process.exit(4)"', mockable: false } };
            m.provisioning = { scope: 'local', kinds: ['git-remote', 'sqlite'], maxResources: 1, ttlSec: 3600 };
          }),
          withCriteria([{ ...TESTS_PASS, requires: ['origin', 'store'] }]),
        ),
        1,
      ],
    ] as const) {
      const { dir, env } = await contractRepo(mutate);
      const run = await start(dir, env, GOAL_ID, contractScripts());
      const evs = await runEvents(run);
      expect(evs.filter((e) => e.kind === 'resource.provisioned'), `${name}\n${await dump(dir)}`).toHaveLength(provisioned);
      expect(kinds(evs), name).not.toContain('step.started');
      expect(evs.some((e) => e.kind === 'capability.missing' && payload(e).resolution === 'ask'), name).toBe(true);
      expect(run.code, name).toBe(4);
      expect(payload(pendingRequest(evs))).toMatchObject({ action: 'provide_capability' });
      const reg = resourceRegistryOf(evs, { runId: run.runId, allowance: { scope: 'local', kinds: name === 'past maxResources' ? ['git-remote', 'sqlite'] : ['tmpdir'], maxResources: provisioned || 4, ttlSec: 3600 } });
      expect(reg.overAllowance, name).toEqual([]);
      expect(reg.problems, name).toEqual([]);
    }
  }, 600_000);

  it('decision.d12_provision_outside_allowance [forged kind]: a resource recorded out of band with a kind the allowance excludes (otherwise valid) makes the PR gate refuse delivery: step.failed names the resource registry, nothing delivered, bundled or achieved', async () => {
    const { problems } = await prRefusesForgedResources([forgedResource({ id: 'res_advkind', kind: 'postgres', capability: 'db' })]);
    expect(problems).toEqual([expect.stringMatching(/resource kind postgres is outside the allowance/)]);
  }, 600_000);

  it('decision.d12_provision_outside_allowance [forged ttl]: a resource recorded out of band with a lifetime beyond the allowance\'s ttlSec (an allowed kind, otherwise valid) makes the PR gate refuse delivery: step.failed names the resource registry, nothing delivered, bundled or achieved', async () => {
    const now = Date.now();
    const { problems } = await prRefusesForgedResources([forgedResource({ id: 'res_advttl', createdAt: now, expiresAt: now + 48 * 3_600_000 })]);
    expect(problems).toEqual([expect.stringMatching(/resource res_advttl lives longer than the allowance \(3600s\)/)]);
  }, 600_000);

  it('decision.d12_resource_without_teardown: a resource recorded without a teardown makes the PR gate refuse delivery (step.failed names the resource registry); a recorded teardown that is not the provisioner\'s own is never run (release refuses, exit 126, nothing removed)', async () => {
    const { problems } = await prRefusesForgedResources([forgedResource({ id: 'res_advnotear', teardown: '' })]);
    expect(problems).toEqual([expect.stringMatching(/resource res_advnotear has no teardown/)]);
    // a hostile teardown on an expired resource: release (and the sweep) refuse to run it
    const { dir, env } = await contractRepo();
    const marker = join(dir, 'src');
    await forge(dir, 'resource.provisioned', { runId: 'run_hostile', trace: { goalId: GOAL_ID }, payload: { resource: forgedResource({ id: 'res_advhostile', teardown: `rm -rf ${marker}`, createdAt: Date.now() - 120_000, expiresAt: Date.now() - 60_000 }) } });
    const rel = await cli(dir, ['resources', 'release', 'res_advhostile', '--as', 'ops-human'], { env });
    expect(rel.code, rel.err + rel.out).not.toBe(0);
    // refused by the teardown check (TEARDOWN_REFUSED), not any other failure
    expect(rel.err).toMatch(/the teardown of res_advhostile exited 126 .*nothing was recorded, it stays pending/);
    expect(existsSync(join(marker, 'slugify.js')), 'the hostile teardown never ran').toBe(true);
    expect((await ledgerEvents(dir)).filter((e) => e.kind === 'resource.released')).toEqual([]);
  }, 600_000);

  it('decision.d12_resource_without_teardown [debt kept]: a recorded resource the registry refuses (no teardown) stays listed as a debt, so it is never silently forgotten', async () => {
    const evs = [
      { id: 'e1', kind: 'resource.provisioned', at: 1, actor: { kind: 'system', id: 'provisioner' }, runId: 'r1', trace: { goalId: 'g' }, payload: { resource: forgedResource({ id: 'res_nt', teardown: '' }) } },
    ] as unknown as Ev[];
    const reg = resourceRegistryOf(evs, { runId: 'r1' });
    expect(reg.problems.join('\n')).toMatch(/has no teardown/);
    expect(reg.resources.map((r) => r.id), 'a refused resource stays a listed debt').toContain('res_nt');
    expect(reg.refused).toEqual(['res_nt']);
    // listed, never usable: nothing pushes to, hands out or transfers a refused resource
    expect(reg.pending.map((r) => r.id)).not.toContain('res_nt');
  });

  it('decision.d12_resource_locator: a resource whose locator carries a credential (userinfo, a secret-named parameter, a canary, double-encoded) is refused by the provisioner check and makes the PR gate refuse delivery', async () => {
    for (const loc of ['http://u:p@127.0.0.1:9/x', '/tmp/x?token=abc', '/tmp/x?pass%253Dword', 'http://127.0.0.1:9/TECERA_CANARY_LOCATOR']) {
      expect(resourceRegistryOf([{ id: 'e', kind: 'resource.provisioned', at: 1, actor: { kind: 'system', id: 'p' }, runId: 'r', trace: { goalId: 'g' }, payload: { resource: forgedResource({ id: 'res_c', locator: loc }) } }] as unknown as Ev[]).problems.join('\n'), loc).toMatch(/resource locator carries/);
    }
    // the provisioner's own records are its ingress: its locators are paths under its root or a loopback URL, never a credential
    const prov = new LocalProvisioner({ root: join(tmp('tecera-adv-locp-'), 'resources'), repoRoot: tmp('tecera-adv-locp-repo-'), runId: 'run_locp', allowance: SAMPLE_ALLOWANCE });
    const own = await prov.provision({ capability: 'scratch', kind: 'tmpdir', goalId: 'g' });
    try {
      expect(resourceRegistryOf([{ id: 'e', kind: 'resource.provisioned', at: 1, actor: { kind: 'system', id: 'p' }, runId: 'run_locp', trace: { goalId: 'g' }, payload: { resource: own as unknown as JsonObject } }] as unknown as Ev[]).problems).toEqual([]);
    } finally {
      await prov.releaseResource(own);
    }
    // a provisioner whose root lies inside the repository is refused before anything is created
    const repo = tmp('tecera-adv-locin-repo-');
    expect(() => new LocalProvisioner({ root: join(repo, 'resources'), repoRoot: repo, runId: 'run_locin', allowance: SAMPLE_ALLOWANCE })).toThrow(/outside the repository/);
    // end to end: a forged http-stub with a credential in its locator
    const { run, problems } = await prRefusesForgedResources([forgedResource({ id: 'res_advcred', kind: 'http-stub', capability: 'api', locator: 'http://admin:hunter2@127.0.0.1:9/' })]);
    expect(problems).toEqual([expect.stringMatching(/res_advcred: .*resource locator carries/)]);
    // only the forged event itself carries it: nothing the run wrote afterwards (events, evidence, run files)
    const forgedEv = (await runEvents(run)).filter((e) => JSON.stringify(e).includes('hunter2'));
    expect(forgedEv.map((e) => e.kind)).toEqual(['resource.provisioned']);
    expect(forgedEv[0]!.id).toMatch(/^forged_/);
    expect(JSON.stringify(await runEvidence(run.dir, run.runId))).not.toContain('hunter2');
    const runFiles = join(run.dir, '.tecera/runs', run.runId);
    const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? walk(join(d, x.name)) : [join(d, x.name)])) : []);
    for (const f of walk(runFiles)) expect(readFileSync(f, 'utf8'), f).not.toContain('hunter2');
  }, 600_000);

  it('decision.d12_resource_locator [inside the repository]: a git-remote resource recorded out of band whose locator is inside the business case repository never receives the push', async () => {
    let target = '';
    const run = await heldAtPr({
      mutate: () => undefined,
    });
    target = join(run.dir, 'vendor', 'remote.git');
    mkdirSync(join(run.dir, 'vendor'), { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', target]);
    await forge(run.dir, 'resource.provisioned', { runId: run.runId, trace: { goalId: GOAL_ID }, payload: { resource: forgedResource({ id: 'res_advrepo', kind: 'git-remote', capability: 'origin', locator: target, teardown: teardownFor('git-remote', target) }) } });
    const seg = await deliver(run);
    const pushed = (() => {
      try {
        return execFileSync('git', ['-C', target, 'for-each-ref', '--format=%(refname)'], { env: { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null' } }).toString().trim();
      } catch {
        return '';
      }
    })();
    expect(pushed, 'nothing is pushed into the repository').toBe('');
    // the refusal is on the ledger: the PR step failed naming the stray remote, nothing delivered or achieved
    expect(seg.code).not.toBe(0);
    const tail = await runEvents(run);
    expect(JSON.stringify(tail.filter((e) => (e.kind === 'step.failed' || e.kind === 'pr.failed') && e.trace.stepId === 'pr').map((e) => e.payload))).toMatch(/res_advrepo does not lie under the resources root/);
    expect(kinds(tail)).not.toContain('pr.requested');
    expect(kinds(tail)).not.toContain('goal.achieved');
  }, 600_000);

  it('decision.d12_sandbox_reaches_locator: a program in the sandbox child cannot reach a provisioned resource directly: the loopback stub receives no request, the sqlite file is unread and unchanged', async () => {
    const repoRoot = tmp('tecera-adv-loc-repo-');
    const prov = new LocalProvisioner({ root: join(tmp('tecera-adv-loc-'), 'resources'), repoRoot, runId: 'run_loc', allowance: { scope: 'local', kinds: ['sqlite', 'http-stub'], maxResources: 4, ttlSec: 120 } });
    const stub = await prov.provision({ capability: 'api', kind: 'http-stub', goalId: 'g', stub: { routes: [{ method: 'GET', path: '/', status: 200, body: { ok: true } }] } as never });
    const db = await prov.provision({ capability: 'db', kind: 'sqlite', goalId: 'g' });
    try {
      const dbBefore = readFileSync(db.locator);
      const stubDir = stub.teardown.match(/rm -rf -- '([^']+)'/)?.[1];
      expect(stubDir, stub.teardown).toBeTruthy();
      const requests = join(stubDir!, 'requests.jsonl');
      const rig = replRig();
      const code = `
        const out = {};
        const err = (e) => (e && (e.code || e.name)) || String(e);
        try { const r = await fetch(${JSON.stringify(stub.locator)}); out.fetch = 'status:' + r.status; } catch (e) { out.fetch = err(e); }
        try { const m = await import('node:http'); out.http = typeof m.get; } catch (e) { out.http = err(e); }
        try { const m = await import('node:net'); out.net = typeof m.connect; } catch (e) { out.net = err(e); }
        try { const m = await import('node:fs'); out.fs = m.readFileSync(${JSON.stringify(db.locator)}).length; } catch (e) { out.fs = err(e); }
        try { const m = await import('node:sqlite'); out.sqlite = typeof m.DatabaseSync; } catch (e) { out.sqlite = err(e); }
        out.globals = [typeof fetch, typeof WebSocket, typeof XMLHttpRequest, typeof process, typeof require].join(',');
        return out;`;
      const r = await rig.repl.exec(execReq(code), recorder().bridge);
      expect(r.kind, JSON.stringify(r)).toBe('return');
      const out = (r as { value: Record<string, unknown> }).value;
      expect(out.fetch).not.toMatch(/^status:/);
      for (const k of ['http', 'net', 'sqlite']) expect(out[k], k).not.toBe('function');
      expect(typeof out.fs, 'the sqlite file was read').not.toBe('number');
      expect(out.globals).toBe('undefined,undefined,undefined,undefined,undefined');
      expect(readFileSync(db.locator).equals(dbBefore)).toBe(true);
      const logged = existsSync(requests) ? readFileSync(requests, 'utf8').trim() : '';
      expect(logged, 'the stub received a request from the sandbox').toBe('');
      // positive control: the stub is up and logs a request made from the host
      expect((await fetch(stub.locator)).status).toBe(200);
      expect(readFileSync(requests, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      await prov.releaseResource(stub);
      await prov.releaseResource(db);
    }
  });
});
