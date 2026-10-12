import { describe, expect, it } from 'vitest';
import {
  contractHash,
  contractProblem,
  type AcceptanceContract,
  type AchievementGoal,
  type CapabilityRecord,
  type Criterion,
  type Manifest,
  type Plan,
  type PlanningContext,
} from '@tecera/contracts';
import { createPlanValidator, plannerChecks } from './checks.js';
import { CONTRACT_WIRE_JSON_SCHEMA, ContractRejected, commandAlwaysPasses, contractDraftIssues, contractPlanIssues, parseContractOutput, requestorCriteriaIssues } from './contract.js';
import { FakeBeliefs, FakeLLM, adopted, goal, goodDoc, sampleManifest, samplePermissions } from './fixtures.testkit.js';
import { LLMPlanner, PlanRejected, type PlannerUsage } from './llmPlanner.js';
import { ScriptedPlanner, sampleFixFailingTestPlan, type ScriptedContract } from './scripted.js';
import { planId } from './schema.js';

const base = sampleManifest();
const m: Manifest = {
  ...base,
  connections: { db: { kind: 'sqlite', mockable: true }, mail: { kind: 'mail', mockable: false } },
};
const permissions = samplePermissions();
const beliefs = new FakeBeliefs([]);
const validator = createPlanValidator({ permissions });
const caught = (pr: Promise<unknown>) => pr.then(() => null, (e: unknown) => e);
const CANARY = 'TECERA_CANARY_contract_7Qp';

const cmd = (id: string, command: string, requires?: string[]): Criterion => ({
  id,
  statement: `${id} holds`,
  check: { kind: 'command', command, timeoutSec: 120 },
  ...(requires ? { requires } : {}),
});
const human = (id: string): Criterion => ({ id, statement: `${id} reads well`, check: { kind: 'human', prompt: `Is ${id} acceptable?` } });

/** Three requests the scripted planner (and the bench) answers with a canned contract each. */
const SCRIPTED: ScriptedContract[] = [
  { when: 'failing test', criteria: [cmd('tests-pass', 'node --test')], outOfScope: ['refactoring'], assumptions: ['the test is right'] },
  {
    when: /rate limit/i,
    criteria: [cmd('limit-enforced', 'node --test test/rate.test.js'), cmd('tests-pass', 'node --test'), human('limits-sensible')],
    outOfScope: ['distributed limiting'],
    assumptions: [],
  },
  {
    when: 'persist sessions',
    criteria: [cmd('sessions-survive-restart', 'node --test test/session.test.js', ['db']), cmd('tests-pass', 'node --test')],
    needs: [{ id: 'db', kind: 'postgres', mockable: false }],
  },
];

function wireCriterion(k: Criterion): Record<string, unknown> {
  return k.check.kind === 'command'
    ? { id: k.id, statement: k.statement, kind: 'command', command: k.check.command, timeoutSec: k.check.timeoutSec, prompt: null, requires: k.requires ?? [] }
    : { id: k.id, statement: k.statement, kind: 'human', command: null, timeoutSec: null, prompt: k.check.prompt, requires: k.requires ?? [] };
}
const wire = (criteria: Criterion[], needs: Array<{ id: string; kind: string; mockable: boolean | null }> = [], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ criteria: criteria.map(wireCriterion), outOfScope: ['out'], assumptions: ['assumed'], needs, ...extra });

function contractFor(g: AchievementGoal, criteria: Criterion[]): AcceptanceContract {
  return { goalId: g.id, statement: g.statement, criteria, outOfScope: [], assumptions: [] };
}

/** goodDoc with the verify gates listing criteria (both run after every worker step). */
function docListing(v1: string[] | null, v2: string[] | null, extra: Record<string, unknown> = {}) {
  const d = goodDoc() as unknown as { steps: Array<Record<string, unknown>> } & Record<string, unknown>;
  d.steps = d.steps.map((s) => (s['id'] === 'verify' && v1 ? { ...s, inputs: { criteria: v1 } } : s['id'] === 'verify2' && v2 ? { ...s, inputs: { criteria: v2 } } : s));
  return JSON.stringify({ ...d, ...extra });
}

function llmPlanner(llm: FakeLLM) {
  const usage: PlannerUsage[] = [];
  return { p: new LLMPlanner({ llm, manifest: m, permissions, onUsage: (u) => void usage.push(u), nonce: () => 'n1n1n1' }), usage };
}

describe('scripted contracts', () => {
  it('yields a valid, host-stamped contract for three sample statements', async () => {
    const sp = new ScriptedPlanner({ plans: [sampleFixFailingTestPlan()], contracts: SCRIPTED, connections: m.connections });
    const statements = ['Make the failing test pass', 'Add rate limiting to the API', 'Persist sessions across restarts'];
    const drafts = [];
    for (const s of statements) {
      const g = { ...goal, id: `g-${drafts.length}`, statement: s };
      const d = await sp.draftContract(s, g, []);
      expect(contractProblem(d.contract)).toBeNull();
      expect(contractDraftIssues(d, { goal: g, statement: s })).toEqual([]);
      expect(d.contract.goalId).toBe(g.id);
      expect(d.contract.statement).toBe(s);
      drafts.push(d);
    }
    expect(drafts.map((d) => d.contract.criteria.map((k) => k.id))).toEqual([['tests-pass'], ['limit-enforced', 'tests-pass', 'limits-sensible'], ['sessions-survive-restart', 'tests-pass']]);
    expect(drafts[0]!.needs).toEqual([]);
    // The declared connection decides kind and mockable, never the script (or the model).
    expect(drafts[2]!.needs).toEqual([{ id: 'db', kind: 'sqlite', criteria: ['sessions-survive-restart'], mockable: true }]);
    expect(sp.drafts).toBe(3);
    await expect(sp.draftContract('Send a welcome email', goal, [])).rejects.toBeInstanceOf(ContractRejected);
    await expect(new ScriptedPlanner([sampleFixFailingTestPlan()]).draftContract('anything', goal, [])).rejects.toThrow(/no scripted contract/);
  });

  it('a scripted contract of human judgments only is refused', async () => {
    const sp = new ScriptedPlanner({ plans: [sampleFixFailingTestPlan()], contracts: [{ criteria: [human('looks-right'), human('feels-right')] }] });
    const err = (await caught(sp.draftContract('make it nicer', goal, []))) as ContractRejected;
    expect(err).toBeInstanceOf(ContractRejected);
    expect(err.issues).toContain('contract needs at least one command criterion');
  });
});

describe('LLMPlanner.draftContract', () => {
  const statement = 'Persist sessions across restarts';
  const g = { ...goal, statement };

  it('decodes a wire answer strictly, stamps goal id and statement, builds needs from requires', async () => {
    const answer = wire([cmd('sessions-survive', 'node --test test/session.test.js', ['db', 'cache']), human('docs-clear')], [
      { id: 'db', kind: 'postgres', mockable: false },
      { id: 'cache', kind: 'redis', mockable: null },
    ]);
    const llm = new FakeLLM([answer]);
    const { p, usage } = llmPlanner(llm);
    const inventory: CapabilityRecord[] = [{ id: 'cache', kind: 'http-stub', state: 'missing' }];
    const d = await p.draftContract(statement, g, inventory);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.schema).toEqual(CONTRACT_WIRE_JSON_SCHEMA);
    expect(usage.map((u) => u.purpose)).toEqual(['draft']);
    expect(d.contract).toMatchObject({ goalId: goal.id, statement, outOfScope: ['out'], assumptions: ['assumed'] });
    expect(contractProblem(d.contract)).toBeNull();
    // db: the manifest connection wins; cache: the inventory's kind, the model's default mockable.
    expect(d.needs).toEqual([
      { id: 'cache', kind: 'http-stub', criteria: ['sessions-survive'], mockable: true },
      { id: 'db', kind: 'sqlite', criteria: ['sessions-survive'], mockable: true },
    ]);
    // The request is in the prompt; the requestor's criteria section is absent without goal criteria.
    expect(llm.requests[0]!.messages[1]!.content).toContain(statement);
    expect(llm.requests[0]!.messages[1]!.content).not.toContain('Requestor criteria');
  });

  it('a human-judgment-only contract is repaired once, then refused (fail closed)', async () => {
    const humanOnly = wire([human('pretty'), human('fast-enough')]);
    const llm = new FakeLLM([humanOnly, humanOnly]);
    const err = (await caught(llmPlanner(llm).p.draftContract(statement, g, []))) as ContractRejected;
    expect(err).toBeInstanceOf(ContractRejected);
    expect(err.attempts).toBe(2);
    expect(err.issues).toContain('contract needs at least one command criterion');
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.messages[3]!.content).toMatch(/rejected that contract[\s\S]*at least one command criterion/);
    // The repair round may fix it (with a focused criterion that requires the database the request implies:
    // a whole-suite run beside a human judgment alone is generic-only and refused).
    const fixed = new FakeLLM([humanOnly, wire([cmd('sessions-survive', 'node --test test/session.test.js', ['db']), cmd('tests-pass', 'node --test'), human('pretty')])]);
    const { p, usage } = llmPlanner(fixed);
    const d = await p.draftContract(statement, g, []);
    expect(d.contract.criteria.map((k) => k.id)).toEqual(['sessions-survive', 'tests-pass', 'pretty']);
    expect(usage.map((u) => u.purpose)).toEqual(['draft', 'draft-repair']);
  });

  it('refuses host-stamped keys, truncated output, checks that cannot fail, secrets and undeclared kinds', async () => {
    const cases: Array<[string, RegExp]> = [
      [wire([cmd('a', 'node --test')], [], { goalId: 'other' }), /goalId: is host-stamped/],
      [wire([cmd('a', 'true')]), /exits 0 whatever the repository holds/],
      [wire([cmd('a', 'node --test', ['queue'])]), /capability queue is required .* no need says what kind/],
      [wire([cmd('a', 'node --test')], [{ id: 'ghost', kind: 'x', mockable: null }]), /need ghost is required by no criterion/],
      [wire([cmd('a', `node --test --name=${CANARY}`)]), /secret-shaped content/],
      [JSON.stringify({ criteria: [{ ...wireCriterion(cmd('a', 'node --test')), command: null }], outOfScope: [], assumptions: [], needs: [] }), /a command criterion needs a command/],
    ];
    for (const [answer, why] of cases) {
      const err = (await caught(llmPlanner(new FakeLLM([answer, answer])).p.draftContract(statement, g, []))) as ContractRejected;
      expect(err, String(why)).toBeInstanceOf(ContractRejected);
      expect(err.issues.join('\n')).toMatch(why);
      expect(err.issues.join('\n')).not.toContain(CANARY);
    }
    const truncated = new FakeLLM([{ content: wire([cmd('a', 'node --test')]), finishReason: 'length' }, { content: '{', finishReason: 'length' }]);
    const t = (await caught(llmPlanner(truncated).p.draftContract(statement, g, []))) as ContractRejected;
    expect(t.issues.join()).toMatch(/truncated/);
    // An empty request is refused before anything is sent or billed.
    const none = new FakeLLM([wire([cmd('a', 'node --test')])]);
    await expect(llmPlanner(none).p.draftContract('  ', g, [])).rejects.toBeInstanceOf(ContractRejected);
    expect(none.requests).toHaveLength(0);
  });

  it('parseContractOutput never throws on hostile text', () => {
    for (const raw of ['', 'no json', '{', '{"criteria": 5}', '{"criteria":[],"outOfScope":[],"assumptions":[],"needs":[]}', '[1,2]']) {
      const r = parseContractOutput(raw);
      expect(r.ok).toBe(false);
    }
  });
});

describe('requestor criteria are never weakened', () => {
  const requestor = [cmd('tests-pass', 'node --test'), cmd('rate-limited', 'node --test test/rate.test.js', ['db'])];
  const fileGoal: AchievementGoal = { ...goal, criteria: requestor, contractHash: 'h' };

  it('a draft that drops, rewords or loosens a requestor criterion is refused; one that adds criteria is accepted', async () => {
    const dropped = wire([requestor[0]!]);
    const loosened = wire([requestor[0]!, { ...requestor[1]!, check: { kind: 'command', command: 'node --test', timeoutSec: 120 } }], [{ id: 'db', kind: 'sqlite', mockable: null }]);
    const toHuman = wire([requestor[0]!, { ...requestor[1]!, check: { kind: 'human', prompt: 'is it limited?' } }], [{ id: 'db', kind: 'sqlite', mockable: null }]);
    const lostNeed = wire([requestor[0]!, { ...requestor[1]!, requires: [] }]);
    for (const [answer, why] of [
      [dropped, /requestor criterion rate-limited was dropped/],
      [loosened, /requestor criterion rate-limited: check was changed or loosened/],
      [toHuman, /requestor criterion rate-limited: check was changed or loosened/],
      [lostNeed, /requestor criterion rate-limited: a required capability was dropped/],
    ] as const) {
      const err = (await caught(llmPlanner(new FakeLLM([answer, answer])).p.draftContract(goal.statement, fileGoal, []))) as ContractRejected;
      expect(err).toBeInstanceOf(ContractRejected);
      expect(err.issues.join('\n')).toMatch(why);
    }
    const llm = new FakeLLM([wire([...requestor, cmd('lint-clean', 'node lint.js')], [{ id: 'db', kind: 'sqlite', mockable: null }])]);
    const d = await llmPlanner(llm).p.draftContract(goal.statement, fileGoal, []);
    expect(d.contract.criteria.map((k) => k.id)).toEqual(['tests-pass', 'rate-limited', 'lint-clean']);
    // The requestor's criteria are shown to the seat as agreed.
    expect(llm.requests[0]!.messages[1]!.content).toMatch(/Requestor criteria \(copy each exactly\)[\s\S]*rate-limited/);
  });

  it('requestorCriteriaIssues applies to an amended contract too', () => {
    const amended = contractFor(goal, [requestor[0]!, { ...requestor[1]!, statement: 'roughly limited' }]);
    expect(requestorCriteriaIssues(requestor, amended)).toEqual(['requestor criterion rate-limited: statement was changed']);
    expect(requestorCriteriaIssues(requestor, contractFor(goal, [...requestor, human('extra')]))).toEqual([]);
    expect(requestorCriteriaIssues(undefined, amended)).toEqual([]);
  });
});

describe('plans against an accepted contract', () => {
  const contract = contractFor(goal, [cmd('tests-pass', 'node --test'), cmd('sessions', 'node --test test/session.test.js', ['db']), human('docs-clear')]);
  const hash = contractHash(contract);
  const ctx: PlanningContext = { contract, contractHash: hash, inventory: [{ id: 'db', kind: 'sqlite', state: 'missing' }], allowance: m.provisioning, provisionedSoFar: 0 };

  it('records the contractHash and capabilities, and the id covers them', async () => {
    const answer = docListing(['tests-pass', 'sessions'], ['tests-pass', 'sessions']);
    const plan = await llmPlanner(new FakeLLM([answer])).p.write(adopted, beliefs, goal, undefined, ctx);
    expect(plan.contractHash).toBe(hash);
    expect(plan.capabilities).toEqual(['db']);
    expect(plan.id).toBe(planId(plan));
    const plain = await llmPlanner(new FakeLLM([answer])).p.write(adopted, beliefs, goal);
    expect(plain.contractHash).toBeUndefined();
    expect(plain.capabilities).toBeUndefined();
    expect(plain.id).not.toBe(plan.id);
    expect(validator.validatePlan(plan, m, goal, ctx)).toEqual([]);
    // The same plan against an amended contract is stale.
    const amended = { ...contract, criteria: [...contract.criteria, cmd('lint', 'node lint.js')] };
    expect(validator.validatePlan(plan, m, goal, { ...ctx, contract: amended, contractHash: contractHash(amended) }).join('\n')).toMatch(/written for another contract[\s\S]*command criterion lint has no gate.verify/);
    // The contract section reaches the seat.
    const llm = new FakeLLM([answer]);
    await llmPlanner(llm).p.write(adopted, beliefs, goal, undefined, ctx);
    expect(llm.requests[0]!.messages[0]!.content).toMatch(/Acceptance contract[\s\S]*inputsJson/);
    expect(llm.requests[0]!.messages[1]!.content).toMatch(/`sessions`[\s\S]*requires db[\s\S]*`db` sqlite: missing/);
  });

  it('a plan missing a criterion verify is refused before it leaves the planner', async () => {
    const noLists = docListing(null, null);
    const err = (await caught(llmPlanner(new FakeLLM([noLists, noLists])).p.write(adopted, beliefs, goal, undefined, ctx))) as PlanRejected;
    expect(err).toBeInstanceOf(PlanRejected);
    expect(err.issues.join('\n')).toMatch(/command criterion sessions has no gate.verify after every worker step/);
    // Listed only on the first verify: the verify the commit rests on must list every command criterion.
    const partial = docListing(['tests-pass', 'sessions'], ['tests-pass']);
    const e2 = (await caught(llmPlanner(new FakeLLM([partial, partial])).p.write(adopted, beliefs, goal, undefined, ctx))) as PlanRejected;
    expect(e2.issues.join('\n')).toMatch(/verify step verify2 before commit commit must list every command criterion \(missing: sessions\)/);
    // A human criterion is never a verify's; an unknown id is refused.
    const wrong = docListing(['tests-pass', 'sessions', 'docs-clear'], ['tests-pass', 'sessions', 'nope']);
    const e3 = (await caught(llmPlanner(new FakeLLM([wrong, wrong])).p.write(adopted, beliefs, goal, undefined, ctx))) as PlanRejected;
    expect(e3.issues.join('\n')).toMatch(/lists human criterion docs-clear/);
    expect(e3.issues.join('\n')).toMatch(/lists nope, which is no criterion/);
    // The scripted path refuses the same plan.
    const sp = new ScriptedPlanner([sampleFixFailingTestPlan()]);
    const e4 = (await caught(sp.write(adopted, beliefs, goal, undefined, ctx))) as PlanRejected;
    expect(e4).toBeInstanceOf(PlanRejected);
    expect(e4.issues.join('\n')).toMatch(/command criterion tests-pass has no gate.verify/);
  });

  it('the scripted planner stamps a covering plan and returns it', async () => {
    const p = sampleFixFailingTestPlan();
    for (const s of p.steps) if (s.kind === 'gate.verify') s.inputs = { criteria: ['tests-pass', 'sessions'] };
    const sp = new ScriptedPlanner({ plans: [p], connections: m.connections });
    const plan = await sp.write(adopted, beliefs, goal, undefined, ctx);
    expect(plan).toMatchObject({ contractHash: hash, capabilities: ['db'] });
    expect(plan.id).toBe(planId(plan));
    expect(validator.validatePlan(plan, m, goal, ctx)).toEqual([]);
    // Without a context the scripted plan is returned exactly as before.
    expect(await sp.write(adopted, beliefs, goal)).toEqual({ ...p, origin: 'generated', status: 'candidate' });
  });

  it('refuses a capability nobody declared and one whose gap resolves to ask', () => {
    const p = sampleFixFailingTestPlan() as Plan;
    for (const s of p.steps) if (s.kind === 'gate.verify') s.inputs = { criteria: ['tests-pass', 'sessions'] };
    const stamped = (caps: string[]): Plan => ({ ...p, contractHash: hash, capabilities: caps });
    expect(contractPlanIssues(stamped(['db']), ctx, { goal, connections: m.connections })).toEqual([]);
    expect(contractPlanIssues(stamped([]), ctx, { goal, connections: m.connections }).join()).toMatch(/plan.capabilities omits db/);
    expect(contractPlanIssues(stamped(['db', 'payments']), ctx, { goal, connections: m.connections }).join()).toMatch(/capability payments, which no connection/);
    // mail: declared, missing, not mockable and not provisionable → ask.
    expect(contractPlanIssues(stamped(['db', 'mail']), ctx, { goal, connections: m.connections }).join()).toMatch(/capability mail is missing and can be neither provisioned nor mocked/);
    // Probed available: used as is.
    const probed: PlanningContext = { ...ctx, inventory: [...ctx.inventory!, { id: 'mail', kind: 'mail', state: 'available', probe: { command: 'mailcheck', exitCode: 0 } }] };
    expect(contractPlanIssues(stamped(['db', 'mail']), probed, { goal, connections: m.connections })).toEqual([]);
    // A context hash that disagrees with its contract fails closed.
    expect(contractPlanIssues(stamped(['db']), { ...ctx, contractHash: 'x' }, { goal })).toEqual(['the planning context hash is not the accepted contract hash; refusing']);
  });

  it("a goal file's own criteria bind the plan when no context is passed; goals without criteria are unchanged", () => {
    const fileGoal: AchievementGoal = { ...goal, criteria: contract.criteria, contractHash: hash };
    const p = sampleFixFailingTestPlan();
    expect(validator.validatePlan(p, m, fileGoal).join('\n')).toMatch(/plan carries no contractHash/);
    for (const s of p.steps) if (s.kind === 'gate.verify') s.inputs = { criteria: ['tests-pass', 'sessions'] };
    const bound: Plan = { ...p, contractHash: hash, capabilities: ['db'] };
    expect(validator.validatePlan({ ...bound, id: planId(bound) }, m, fileGoal)).toEqual([]);
    expect(validator.validatePlan(sampleFixFailingTestPlan(), m, goal)).toEqual([]);
    expect(validator.validatePlan(p, m, { ...goal, contractHash: hash }).join()).toMatch(/incomplete contract/);
  });
});

describe('contract checks fail closed (review repairs)', () => {
  const contract = contractFor(goal, [cmd('tests-pass', 'node --test'), cmd('sessions', 'node --test test/session.test.js', ['db'])]);
  const hash = contractHash(contract);
  const covering = (): Plan => {
    const p = sampleFixFailingTestPlan();
    for (const s of p.steps) if (s.kind === 'gate.verify') s.inputs = { criteria: ['tests-pass', 'sessions'] };
    return p;
  };

  it('the scripted planner refuses a goal carrying criteria without their hash, as the model path does', async () => {
    const half: AchievementGoal = { ...goal, criteria: contract.criteria };
    const sp = new ScriptedPlanner({ plans: [covering()], connections: m.connections });
    const err = (await caught(sp.write(adopted, beliefs, half))) as PlanRejected;
    expect(err).toBeInstanceOf(PlanRejected);
    expect(err.issues.join()).toMatch(/incomplete contract/);
    const llmErr = (await caught(llmPlanner(new FakeLLM([docListing(null, null), docListing(null, null)])).p.write(adopted, beliefs, half))) as PlanRejected;
    expect(llmErr.issues.join()).toMatch(/incomplete contract/);
    // A goal without criteria is still returned unchecked.
    expect((await sp.write(adopted, beliefs, goal)).contractHash).toBeUndefined();
  });

  it("a goal's contractHash is recomputed from its criteria, never trusted", () => {
    const p: Plan = { ...covering(), capabilities: ['db'] };
    const forged = 'f'.repeat(64);
    const stale: AchievementGoal = { ...goal, criteria: [cmd('tests-pass', 'node --test')], contractHash: forged };
    expect(contractPlanIssues({ ...p, contractHash: forged }, undefined, { goal: stale, connections: m.connections }).join()).toMatch(/contractHash is not the hash of its criteria/);
    // Swapped criteria under the old hash: refused too.
    const swapped: AchievementGoal = { ...goal, criteria: [cmd('tests-pass', 'true || node --test')], contractHash: hash };
    expect(contractPlanIssues({ ...p, contractHash: hash }, undefined, { goal: swapped }).join()).toMatch(/not the hash of its criteria/);
    const honest: AchievementGoal = { ...goal, criteria: contract.criteria, contractHash: hash };
    expect(contractPlanIssues({ ...p, contractHash: hash }, undefined, { goal: honest, connections: m.connections })).toEqual([]);
  });

  it('the verify the commit rests on is found through intermediate gates, and covers every worker', () => {
    // verify (all) → review → verify2 (partial) → review2 → commit: verify2 is the commit's last verify.
    const p = covering();
    const v2 = p.steps.find((s) => s.id === 'verify2')!;
    v2.inputs = { criteria: ['tests-pass'] };
    const commit = p.steps.find((s) => s.id === 'commit')!;
    p.steps.splice(p.steps.indexOf(commit), 0, { id: 'review2', kind: 'gate.review', dependsOn: ['verify2'], inputs: {} });
    commit.dependsOn = ['review2'];
    const stamped: Plan = { ...p, contractHash: hash, capabilities: ['db'] };
    expect(contractPlanIssues(stamped, { contract, contractHash: hash }, { goal, connections: m.connections }).join()).toMatch(/verify step verify2 before commit commit must list every command criterion \(missing: sessions\)/);
    // A worker between the last verify and the commit (covered only by a dangling verify) is refused.
    const q = covering();
    const c2 = q.steps.find((s) => s.id === 'commit')!;
    q.steps.splice(q.steps.indexOf(c2), 0, { ...q.steps.find((s) => s.id === 'edit')!, id: 'late', dependsOn: ['verify2'] }, { id: 'dangling', kind: 'gate.verify', dependsOn: ['late'], inputs: { criteria: ['tests-pass', 'sessions'] } });
    c2.dependsOn = ['late'];
    const lateIssues = contractPlanIssues({ ...q, contractHash: hash, capabilities: ['db'] }, { contract, contractHash: hash }, { goal, connections: m.connections }).join();
    expect(lateIssues).toMatch(/worker step\(s\) late run after verify step verify2, the last before commit commit/);
  });

  it('the gap ladder runs without an inventory or allowance and counts each provisioned capability', () => {
    const two = contractFor(goal, [cmd('tests-pass', 'node --test', ['mail']), cmd('store', 'node --test test/store.test.js', ['db', 'db2'])]);
    const h2 = contractHash(two);
    const conns: Manifest['connections'] = { db: { kind: 'sqlite', mockable: false }, db2: { kind: 'sqlite', mockable: false }, mail: { kind: 'mail', mockable: false } };
    const p: Plan = { ...sampleFixFailingTestPlan(), contractHash: h2, capabilities: ['db', 'db2', 'mail'] };
    for (const s of p.steps) if (s.kind === 'gate.verify') s.inputs = { criteria: ['tests-pass', 'store'] };
    // No inventory and no allowance: mail is not known available and cannot be provisioned or mocked.
    expect(contractPlanIssues(p, { contract: two, contractHash: h2 }, { goal, connections: conns }).join()).toMatch(/capability mail is missing and can be neither provisioned nor mocked/);
    const mailUp: CapabilityRecord = { id: 'mail', kind: 'mail', state: 'available' };
    // One sqlite resource left in the allowance: db is provisioned, db2 then has no room and no stand-in.
    const allowance = { scope: 'local' as const, kinds: ['sqlite'], maxResources: 1, ttlSec: 60 };
    const tight = contractPlanIssues(p, { contract: two, contractHash: h2, inventory: [mailUp], allowance, provisionedSoFar: 0 }, { goal, connections: conns });
    expect(tight).toEqual(['capability db2 is missing and can be neither provisioned nor mocked; the requestor must provide it']);
    expect(contractPlanIssues(p, { contract: two, contractHash: h2, inventory: [mailUp], allowance: { ...allowance, maxResources: 2 }, provisionedSoFar: 0 }, { goal, connections: conns })).toEqual([]);
  });

  it('commands that always pass are refused in their common disguises', () => {
    for (const c of ['true', 'true || false', 'node --test || true', 'node --test; exit 0', 'node --test | true', "sh -c 'exit 0'", 'bash -c "true"', "node -e 'process.exit(0)'", 'node -e ""', "python3 -c 'pass'", '! false', 'node --test || exit 0; node lint.js']) {
      expect(commandAlwaysPasses(c), c).toBe(true);
    }
    for (const c of ['node --test', 'node --test && node lint.js', "sh -c 'node --test'", 'test -f dist/index.js', 'grep -q ok out.txt', "node -e 'process.exit(require(\"./x\").ok ? 0 : 1)'"]) {
      expect(commandAlwaysPasses(c), c).toBe(false);
    }
  });
});

describe('delivery declares both PR authorities (sprint 5 item 5)', () => {
  it('a plan with gate.pr must list open_pr and git_push', () => {
    const p = sampleFixFailingTestPlan();
    expect(plannerChecks(p, permissions)).toEqual([]);
    p.permissions.approvals = ['open_pr'];
    expect(plannerChecks(p, permissions)).toContain("pr step pr opens a pull request and pushes the work branch: permissions.approvals must list 'git_push'");
    p.permissions.approvals = ['git_push'];
    expect(plannerChecks(p, permissions).join()).toMatch(/must list 'open_pr'/);
  });
});
