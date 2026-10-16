import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contractHash, parseManifest, type AcceptanceContract, type AchievementGoal, type Criterion, type Json, type JsonObject, type Manifest } from '@tecera/contracts';
import { createPlanValidator } from './checks.js';
import { ContractRejected } from './contract.js';
import { FakeBeliefs, FakeLLM, adopted, goal, goodDoc, samplePermissions } from './fixtures.testkit.js';
import { LLMPlanner, PlanRejected } from './llmPlanner.js';
import { commandFocus, commandIsGeneric, commandOnlyInspectsText, commandRunsFiles, contractQualityIssues, criterionTags, derivedTags, impliedNeeds, statementBehaviourShape, statementBehaviours } from './quality.js';
import { namedPaths, settlePlanDocument, stepChangesFiles, WRITING_STEP_OUTPUT, writingOutputProblem, writingStepOutput } from './scope.js';
import { ScriptedPlanner, sampleFixFailingTestPlan, type ScriptedContract } from './scripted.js';
import type { PlanDocument } from './schema.js';

/**
 * Wave 6 live-run defects at the planner seat: write scope narrower than the manifest, weak drafted
 * contracts (generic or keyword-only criteria, no requires), and writing steps whose schema let a worker
 * return without changing anything. The bench fixtures' statements, manifests and hidden criteria are the
 * test inputs; the bench's coverage matcher is reimplemented minimally below (the planner does not depend
 * on the bench package).
 */

const fixture = (scenario: string, rel: string) => new URL(`../../bench/fixtures/${scenario}/${rel}`, import.meta.url);
const readJson = <T>(scenario: string, rel: string): T => JSON.parse(readFileSync(fixture(scenario, rel), 'utf8')) as T;

interface Hidden {
  id: string;
  tags: string[];
  keywords?: string[];
  requires?: string[];
}
interface Scenario {
  request: { kind: string; text?: string };
  hidden: Hidden[];
  connections?: { needs?: Array<{ capability: string; kind: string }> };
}
const scenario = (id: string) => readJson<Scenario>(id, 'scenario.json');
const manifestOf = (id: string): Manifest => parseManifest(readJson<unknown>(id, 'repo/tecera.json'));

// The bench's matcher (packages/bench/src/scorer.ts criterionCovers), reimplemented: a declared tag or the
// criterion id equals a hidden tag, or a hidden keyword is a whole word or phrase of the id or statement.
const words = (s: string): string => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
function covers(c: Criterion, h: Hidden): boolean {
  const extra = (c as { tags?: unknown }).tags;
  const declared = new Set<string>([c.id, ...(Array.isArray(extra) ? extra.filter((t): t is string => typeof t === 'string') : [])]);
  if (h.tags.some((t) => declared.has(t))) return true;
  const text = words(`${c.id} ${c.statement}`);
  return (h.keywords ?? []).some((k) => words(k).trim().length > 0 && text.includes(words(k)));
}
const coverage = (criteria: readonly Criterion[], hidden: readonly Hidden[]) => hidden.filter((h) => criteria.some((c) => covers(c, h))).length / hidden.length;

const permissions = samplePermissions();
const beliefs = new FakeBeliefs([]);
const caught = (pr: Promise<unknown>) => pr.then(() => null, (e: unknown) => e);

type WireCriterion = { id: string; statement: string; command?: string; prompt?: string; requires?: string[]; tags?: string[] };
const wc = (c: WireCriterion) => ({
  id: c.id,
  statement: c.statement,
  kind: c.prompt ? 'human' : 'command',
  command: c.prompt ? null : (c.command ?? ''),
  timeoutSec: c.prompt ? null : 60,
  prompt: c.prompt ?? null,
  requires: c.requires ?? [],
  tags: c.tags ?? [],
});
const wire = (criteria: WireCriterion[], needs: Array<{ id: string; kind: string; mockable: boolean | null }> = []) =>
  JSON.stringify({ criteria: criteria.map(wc), outOfScope: [], assumptions: [], envelope: [{ path: 'src/*.js', ops: ['create', 'modify'] }], needs });
const assertion = (body: string) => `node --input-type=module -e 'import assert from "node:assert/strict"; ${body}'`;

// ---------------------------------------------------------------------------------------------------------
// D-C: write scope
// ---------------------------------------------------------------------------------------------------------

describe('write scope defaults to the manifest', () => {
  const m3 = manifestOf('03-csv-export');
  const s3 = scenario('03-csv-export').request.text!;
  const csvGoal: AchievementGoal = { ...goal, id: 'g-csv', statement: s3 };
  const llmPlanner = (llm: FakeLLM, m: Manifest = m3) => new LLMPlanner({ llm, manifest: m, permissions, nonce: () => 'n1n1n1' });

  it('a plan the model narrowed to src/** writes where the manifest allows (src/** and bin/**)', async () => {
    expect(m3.repo.allowedChanges).toEqual(['src/**', 'bin/**']);
    const doc = goodDoc();
    expect(doc.permissions.write).toEqual(['src/**']);
    const plan = await llmPlanner(new FakeLLM([JSON.stringify(doc)])).write(adopted, beliefs, csvGoal);
    expect(plan.permissions.write).toEqual(['src/**', 'bin/**']);
    expect(plan.rationale).toBe(doc.rationale);
    expect(createPlanValidator({ permissions }).validatePlan(plan, m3, csvGoal)).toEqual([]);
    // A plan with no write globs at all gets them too when a step edits.
    const none = await llmPlanner(new FakeLLM([JSON.stringify({ ...doc, permissions: { ...doc.permissions, write: [] } })])).write(adopted, beliefs, csvGoal);
    expect(none.permissions.write).toEqual(['src/**', 'bin/**']);
  });

  it('a contract whose criteria run bin/report.js keeps the default', () => {
    const contracts = readJson<ScriptedContract[]>('03-csv-export', 'scripted/contract.json');
    const criteria = contracts[0]!.criteria;
    const doc = { ...goodDoc(), context: [] } as unknown as PlanDocument;
    expect(namedPaths(criteria.map((k) => (k.check.kind === 'command' ? k.check.command : '')).join(' '))).toContain('bin/report.js');
    const out = settlePlanDocument(doc, { manifest: m3 });
    expect(out.permissions.write).toEqual(['src/**', 'bin/**']);
  });

  it('a path the request names never narrows the scope: the command that imports it stays writable', async () => {
    // The request names src/report.js; bin/report.js imports it and is named nowhere.
    const g = { ...csvGoal, statement: 'Fix the rounding in src/report.js' };
    const plan = await llmPlanner(new FakeLLM([JSON.stringify(goodDoc())])).write(adopted, beliefs, g);
    expect(plan.permissions.write).toEqual(['src/**', 'bin/**']);
    expect(plan.rationale).toBe('read, edit, gates');
  });

  it('never widens past the manifest: a glob outside allowedChanges is still refused', async () => {
    const wide = JSON.stringify({ ...goodDoc(), permissions: { ...goodDoc().permissions, write: ['src/**', 'docs/**'] } });
    const err = (await caught(llmPlanner(new FakeLLM([wide, wide])).write(adopted, beliefs, csvGoal))) as PlanRejected;
    expect(err).toBeInstanceOf(PlanRejected);
    expect(err.issues.join('\n')).toMatch(/write glob docs\/\*\* is outside allowedChanges/);
  });

  it('a read-only plan gets no write globs', () => {
    const doc = { ...goodDoc(), context: [], steps: [{ id: 'look', kind: 'worker', dependsOn: [], inputs: {}, instruction: 'read', tools: ['read', 'listFiles'] }], allowedModels: { look: ['worker'] }, permissions: { tools: ['read', 'listFiles'], write: [], approvals: [] } } as unknown as PlanDocument;
    expect(settlePlanDocument(doc, { manifest: m3 }).permissions.write).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// D-E: writing steps return what they changed
// ---------------------------------------------------------------------------------------------------------

/** The subset of JSON schema the worker's validator applies (type, required, properties, minItems, minLength). */
function schemaErrors(v: Json | undefined, s: JsonObject, path = '$'): string[] {
  const x = s as { type?: string; required?: string[]; properties?: Record<string, JsonObject>; items?: JsonObject; minItems?: number; minLength?: number };
  const typeOf = (u: unknown) => (Array.isArray(u) ? 'array' : u === null ? 'null' : typeof u);
  if (v === undefined) return [`${path}: missing`];
  if (x.type && typeOf(v) !== x.type) return [`${path}: expected ${x.type}`];
  const out: string[] = [];
  if (typeof v === 'string' && typeof x.minLength === 'number' && v.length < x.minLength) out.push(`${path}: too short`);
  if (Array.isArray(v)) {
    if (typeof x.minItems === 'number' && v.length < x.minItems) out.push(`${path}: fewer than ${x.minItems} items`);
    if (x.items) v.forEach((e, i) => out.push(...schemaErrors(e, x.items!, `${path}[${i}]`)));
  } else if (v && typeof v === 'object') {
    for (const k of x.required ?? []) if (!(k in v)) out.push(`${path}.${k}: required`);
    for (const [k, sub] of Object.entries(x.properties ?? {})) if (k in v) out.push(...schemaErrors((v as JsonObject)[k], sub, `${path}.${k}`));
  }
  return out;
}

describe('a writing step must return the files it changed', () => {
  const m3 = manifestOf('03-csv-export');

  it('the generated plan stamps the writing schema on editing steps only; read steps keep theirs', async () => {
    // The live scenario 4 shape: the model gave the writing step `{type: object}`.
    const doc = goodDoc();
    const steps = doc.steps.map((s) => (s.id === 'edit' ? { ...s, output: { type: 'object' } } : s.id === 'analyze' ? { ...s, output: { type: 'object', required: ['facts'] } } : s));
    const plan = await new LLMPlanner({ llm: new FakeLLM([JSON.stringify({ ...doc, steps })]), manifest: m3, permissions, nonce: () => 'n' }).write(adopted, beliefs, goal);
    const edit = plan.steps.find((s) => s.id === 'edit')!;
    const analyze = plan.steps.find((s) => s.id === 'analyze')!;
    expect(writingOutputProblem(edit.output)).toBeNull();
    expect(analyze.output).toEqual({ type: 'object', required: ['facts'] });
    // An exploration object, an empty change set or a missing summary fails the schema; a real change passes.
    expect(schemaErrors({ step: 'analyzing requirements' }, edit.output!)).not.toEqual([]);
    expect(schemaErrors({ changed: [], summary: 'looked around' }, edit.output!).join()).toMatch(/fewer than 1 items/);
    expect(schemaErrors({ changed: [''], summary: 'x' }, edit.output!).join()).toMatch(/too short/);
    expect(schemaErrors({ changed: ['src/report.js'] }, edit.output!).join()).toMatch(/summary: required/);
    expect(schemaErrors({ changed: ['src/report.js'], summary: 'added formatCsv' }, edit.output!)).toEqual([]);
    expect(schemaErrors({ step: 'analyzing requirements' }, { type: 'object' })).toEqual([]);
  });

  it('keeps the properties the model asked for beside changed and summary', () => {
    const merged = writingStepOutput({ type: 'object', required: ['facts'], properties: { facts: { type: 'array' }, changed: { type: 'array' } } });
    expect(merged['required']).toEqual(['changed', 'summary', 'facts']);
    expect((merged['properties'] as JsonObject)['facts']).toEqual({ type: 'array' });
    // The host's changed (minItems 1) wins over the model's looser one.
    expect(writingOutputProblem(merged)).toBeNull();
    expect(writingStepOutput({ type: 'string' })).toEqual(WRITING_STEP_OUTPUT);
    expect(writingOutputProblem({ type: 'object' })).toMatch(/does not require changed/);
  });

  it('a step with only read tools and runVerify is a read step; a step inheriting edit is a writing step', () => {
    const doc = goodDoc() as unknown as PlanDocument;
    expect(stepChangesFiles(doc, doc.steps[0]!)).toBe(false);
    expect(stepChangesFiles(doc, doc.steps[1]!)).toBe(true);
    expect(stepChangesFiles(doc, doc.steps[2]!)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------
// D-D: drafted contracts are concrete and name what the request needs
// ---------------------------------------------------------------------------------------------------------

describe('contract drafting refuses weak drafts and infers requires', () => {
  const s2 = scenario('02-api-no-limits');
  const s4 = scenario('04-needs-db');
  const s5 = scenario('05-needs-mail');
  const planner = (llm: FakeLLM, m: Manifest) => new LLMPlanner({ llm, manifest: m, permissions, nonce: () => 'n1n1n1' });

  it('implies the capabilities the bench scenarios need, from their statements and connections', () => {
    expect(impliedNeeds(s2.request.text!, manifestOf('02-api-no-limits').connections)).toEqual([]);
    const db = impliedNeeds(s4.request.text!, manifestOf('04-needs-db').connections);
    expect(db.map(({ id, kind }) => ({ id, kind }))).toEqual([{ id: 'db', kind: 'sqlite' }]);
    // The scenario's hidden criteria require exactly these, with the kind its gap ladder expects.
    expect([...new Set(s4.hidden.flatMap((h) => h.requires ?? []))]).toEqual(db.map((n) => n.id));
    expect(s4.connections!.needs!.map((n) => ({ id: n.capability, kind: n.kind }))).toEqual([{ id: 'db', kind: 'sqlite' }]);
    // The declared connection (kind smtp) is used for a message sender.
    expect(impliedNeeds(s5.request.text!, manifestOf('05-needs-mail').connections).map(({ id, kind }) => ({ id, kind }))).toEqual([{ id: 'mail', kind: 'smtp' }]);
    expect(impliedNeeds('add CSV export to the report command')).toEqual([]);
  });

  it('scenario 2: the live weak contract (tests pass, a grep, a human check) is refused and redrafted; the redraft covers the hidden criteria', async () => {
    const m2 = manifestOf('02-api-no-limits');
    const g: AchievementGoal = { ...goal, id: 'g-rate', statement: s2.request.text! };
    const weak = wire([
      { id: 'tests-pass', statement: 'All tests pass', command: 'node --test' },
      { id: 'rate-limit-tested', statement: 'Tests exercise rate limiting', command: 'grep -rqi "rate.limit" test/' },
      { id: 'sensible', statement: 'The limits are sensible', prompt: 'Are the limits sensible?' },
    ]);
    const app = 'import { createApp } from "./src/app.js";';
    const good = wire([
      { id: 'over-limit', statement: 'A client over its limit within the window gets 429', command: assertion(`${app} const h = createApp({ rateLimit: { limit: 1, windowMs: 1000 }, now: () => 0 }); h({ ip: "a" }); assert.equal(h({ ip: "a" }).status, 429);`), tags: ['http-429'] },
      { id: 'retry-header', statement: 'A refused response carries Retry-After in whole seconds', command: assertion(`${app} const h = createApp({ rateLimit: { limit: 1, windowMs: 5000 }, now: () => 0 }); h({ ip: "a" }); assert.ok(Number(h({ ip: "a" }).headers["Retry-After"]) >= 1);`) },
      { id: 'scoped', statement: 'Each ip is counted on its own', command: assertion(`${app} const h = createApp({ rateLimit: { limit: 1, windowMs: 1000 }, now: () => 0 }); h({ ip: "a" }); assert.equal(h({ ip: "b" }).status, 200);`), tags: ['per-client'] },
      { id: 'resets', statement: 'The count resets when the window passes', command: assertion(`${app} let t = 0; const h = createApp({ rateLimit: { limit: 1, windowMs: 1000 }, now: () => t }); h({ ip: "a" }); t = 1000; assert.equal(h({ ip: "a" }).status, 200);`) },
      { id: 'limit-option', statement: 'The limit and window come from the rateLimit option', command: assertion(`${app} const h = createApp({ rateLimit: { limit: 3, windowMs: 1000 }, now: () => 0 }); for (let i = 0; i < 3; i++) assert.equal(h({ ip: "a" }).status, 200);`), tags: ['Configurable Limit'] },
      { id: 'remaining', statement: 'Every response carries X-RateLimit-Remaining', command: assertion(`${app} const h = createApp({ rateLimit: { limit: 3, windowMs: 1000 }, now: () => 0 }); assert.equal(h({ ip: "a" }).headers["X-RateLimit-Remaining"], "2");`) },
      { id: 'suite', statement: 'The existing test suite still passes', command: 'node --test' },
    ]);
    const weakCriteria: Criterion[] = JSON.parse(weak).criteria.map((c: { id: string; statement: string }) => ({ id: c.id, statement: c.statement, check: { kind: 'command', command: 'x', timeoutSec: 1 } }));
    // The matcher reproduces the live measurement: the weak draft covers 0 of 6.
    expect(coverage(weakCriteria, s2.hidden)).toBe(0);

    const refused = (await caught(planner(new FakeLLM([weak, weak]), m2).draftContract(g.statement, g, []))) as ContractRejected;
    expect(refused).toBeInstanceOf(ContractRejected);
    expect(refused.attempts).toBe(2);
    expect(refused.issues.join('\n')).toMatch(/criterion rate-limit-tested only searches the repository text/);
    expect(refused.issues.join('\n')).toMatch(/only generic criteria/);

    const llm = new FakeLLM([weak, good]);
    const d = await planner(llm, m2).draftContract(g.statement, g, []);
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.messages[3]!.content).toMatch(/rejected that contract[\s\S]*only searches the repository text/);
    const share = coverage(d.contract.criteria, s2.hidden);
    expect(share).toBeGreaterThanOrEqual(0.8);
    expect(share).toBe(1);
    // Tags are normalised (the model's and the ones the statement names) and stay outside the hash.
    const tags = Object.fromEntries(d.contract.criteria.map((k) => [k.id, (k as { tags?: string[] }).tags ?? []]));
    expect(tags['over-limit']).toEqual(['http-429', 'too-many-requests']);
    expect(tags['limit-option']).toEqual(['configurable-limit']);
    expect(tags['retry-header']).toEqual(['retry-after']);
    expect(tags['remaining']).toEqual(['x-ratelimit-remaining']);
    const untagged: AcceptanceContract = { ...d.contract, criteria: d.contract.criteria.map(({ id, statement, check, requires }) => ({ id, statement, check, ...(requires ? { requires } : {}) })) };
    expect(contractHash(untagged)).toBe(contractHash(d.contract));
  });

  it('scenario 4: a contract without the implied database is refused; the redraft requires db and gets its kind from the statement', async () => {
    const m4 = manifestOf('04-needs-db');
    const g: AchievementGoal = { ...goal, id: 'g-sessions', statement: s4.request.text! };
    const store = 'import { createSessionStore } from "./src/sessions.js"; import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"; const path = join(mkdtempSync(join(tmpdir(), "c-")), "s.db");';
    const persist = { id: 'survives-restart', statement: 'Sessions survive a process restart', command: assertion(`${store} const a = createSessionStore({ path }); a.set("s1", { u: 1 }); a.close(); assert.deepEqual(createSessionStore({ path }).get("s1"), { u: 1 });`), tags: ['sessions-persist'] };
    const deleted = { id: 'delete-sticks', statement: 'A deleted session stays deleted after a restart', command: assertion(`${store} const a = createSessionStore({ path }); a.set("s1", {}); a.delete("s1"); a.close(); assert.equal(createSessionStore({ path }).get("s1"), undefined);`) };
    const suite = { id: 'store-api-unchanged', statement: 'The store API is unchanged and its tests pass', command: 'node --test' };
    const noRequires = wire([persist, deleted, suite]);
    const err = (await caught(planner(new FakeLLM([noRequires, noRequires]), m4).draftContract(g.statement, g, []))) as ContractRejected;
    expect(err).toBeInstanceOf(ContractRejected);
    expect(err.issues.join('\n')).toMatch(/"persist" implies a database: a criterion that exercises it must require capability db \(kind sqlite\)/);

    // The repair requires db but names no need: the implied kind fills it in.
    const llm = new FakeLLM([noRequires, wire([{ ...persist, requires: ['db'] }, { ...deleted, requires: ['db'] }, suite])]);
    const d = await planner(llm, m4).draftContract(g.statement, g, []);
    expect(d.needs).toEqual([{ id: 'db', kind: 'sqlite', criteria: ['survives-restart', 'delete-sticks'], mockable: true }]);
    expect(coverage(d.contract.criteria, s4.hidden)).toBe(1);
    const hiddenRequires = new Set(s4.hidden.flatMap((h) => h.requires ?? []));
    expect([...hiddenRequires].every((r) => d.contract.criteria.some((k) => k.requires?.includes(r)))).toBe(true);
    // The prompt told the seat what the request implies and which kinds can be provisioned.
    expect(llm.requests[0]!.messages[0]!.content).toMatch(/`db` kind sqlite \("persist" implies a database\)/);
    expect(llm.requests[0]!.messages[0]!.content).toMatch(/provision locally: `tmpdir`, `git-remote`, `sqlite`, `http-stub`/);
  });

  it('a need named differently but of the implied kind satisfies the inference', () => {
    const g = { ...goal, statement: 'persist sessions' };
    const k: Criterion = { id: 'p', statement: 'persisted', check: { kind: 'command', command: 'node test/p.js', timeoutSec: 5 }, requires: ['sessiondb'] };
    const draft = { contract: { goalId: g.id, statement: g.statement, criteria: [k], outOfScope: [], assumptions: [] }, needs: [{ id: 'sessiondb', kind: 'sqlite', criteria: ['p'], mockable: true }] };
    expect(contractQualityIssues(draft, { statement: g.statement, goal: g })).toEqual([]);
    expect(contractQualityIssues({ ...draft, needs: [{ ...draft.needs[0]!, kind: 'smtp' }] }, { statement: g.statement, goal: g }).join()).toMatch(/must require capability db/);
  });

  it('the scripted contracts of the bench fixtures are unchanged by the scripted planner and pass the quality checks', async () => {
    for (const id of ['02-api-no-limits', '03-csv-export', '04-needs-db', '05-needs-mail']) {
      const m = manifestOf(id);
      const statement = scenario(id).request.text!;
      const contracts = readJson<ScriptedContract[]>(id, 'scripted/contract.json');
      const g: AchievementGoal = { ...goal, id: `g-${id}`, statement };
      const d = await new ScriptedPlanner({ plans: [sampleFixFailingTestPlan()], contracts, connections: m.connections }).draftContract(statement, g, []);
      // Same criteria as scripted: no tags added, nothing rewritten.
      expect(d.contract.criteria, id).toEqual(contracts[0]!.criteria);
      expect(contractQualityIssues(d, { statement, goal: g, verifyCommand: m.verify.command, connections: m.connections }), id).toEqual([]);
    }
  });

  it('requestor criteria are exempt from the per-criterion checks', () => {
    const grep: Criterion = { id: 'agreed', statement: 'mentions it', check: { kind: 'command', command: 'grep -q x README.md', timeoutSec: 5 } };
    const focused: Criterion = { id: 'works', statement: 'works', check: { kind: 'command', command: 'node test/works.js', timeoutSec: 5 } };
    const g: AchievementGoal = { ...goal, criteria: [grep], contractHash: 'h' };
    const draft = { contract: { goalId: g.id, statement: 'make it work', criteria: [grep, focused], outOfScope: [], assumptions: [] }, needs: [] };
    expect(contractQualityIssues(draft, { statement: 'make it work', goal: g })).toEqual([]);
    expect(contractQualityIssues(draft, { statement: 'make it work', goal }).join()).toMatch(/criterion agreed only searches/);
  });
});

describe('quality screens', () => {
  it('text searches and file checks are told apart from commands that run the behaviour', () => {
    for (const c of ['grep -rqi "rate.limit" test/', 'rg -q rateLimit src', 'test -f src/sessions.js', '[ -f src/a.js ] && grep -q b src/a.js', 'sh -c "grep -q x src/a.js"', 'git grep -q limit', 'cat src/a.js | grep -q limit', 'ls src/email.js'])
      expect(commandOnlyInspectsText(c), c).toBe(true);
    for (const c of ['node --test', 'node --test test/a.test.js', "node -e 'require(\"./src/a\")'", 'npm test', 'node bin/report.js --format csv | grep -q region', './check.sh'])
      expect(commandOnlyInspectsText(c), c).toBe(false);
  });

  it('a bare runner or the verify command is generic; a focused test is not', () => {
    for (const c of ['node --test', 'npm test', 'yarn test', 'npx vitest run', 'pytest']) expect(commandIsGeneric(c), c).toBe(true);
    expect(commandIsGeneric('node scripts/all.js', 'node scripts/all.js')).toBe(true);
    for (const c of ['node --test test/a.test.js', 'npx vitest run src/a.test.ts', "node -e 'x'"]) expect(commandIsGeneric(c), c).toBe(false);
  });

  it('counts the behaviours a statement names, negative constraints included', () => {
    expect(statementBehaviours('add rate limiting')).toBe(1);
    expect(statementBehaviours('add CSV export and keep the text report unchanged')).toBe(2);
    // "Do not modify tests, configs, or lockfiles" is a preservation constraint the suite may cover.
    expect(statementBehaviourShape(goal.statement)).toEqual({ focused: 1, preserve: 1 });
    expect(statementBehaviours(goal.statement)).toBe(2);
  });

  it('derives tags the statement names outright', () => {
    expect(derivedTags('Over the limit the client gets 429 Too Many Requests with Retry-After')).toEqual(['http-429', 'too-many-requests', 'retry-after']);
    expect(criterionTags({ id: 'x', statement: 'carries X-RateLimit-Remaining', tags: ['Per Client', '', 'x', '!!'] })).toEqual(['per-client', 'x-ratelimit-remaining']);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Review follow-up: screens that a weak draft could slip past
// ---------------------------------------------------------------------------------------------------------

describe('a focused criterion must be able to fail on the behaviour', () => {
  const g = (statement: string): AchievementGoal => ({ ...goal, id: 'g-q', statement, criteria: undefined, contractHash: undefined } as AchievementGoal);
  const draftOf = (statement: string, criteria: Criterion[], needs: Array<{ id: string; kind: string; criteria: string[]; mockable: boolean }> = []) => ({
    contract: { goalId: 'g-q', statement, criteria, outOfScope: [], assumptions: [] },
    needs,
  });
  const cmdK = (id: string, command: string, statement = id, requires?: string[]): Criterion => ({ id, statement, check: { kind: 'command', command, timeoutSec: 30 }, ...(requires ? { requires } : {}) });
  const real = (fn: string) => assertion(`import { ${fn} } from "./src/app.js"; assert.equal(${fn}(1), 2);`);

  it('an inline script that reaches no repository code or asserts nothing is inert, not focused', () => {
    for (const c of [`node -e 'console.log("ok")'`, `node -e 'import("./src/app.js")'`, `node -p '1 + 1'`, 'echo ok', 'true && echo done', `python3 -c "print(1)"`, `grep -q limit src/app.js && node -e 'console.log(1)'`])
      expect(commandFocus(c), c).toBe('inert');
    for (const c of [real('f'), `node -e 'const r = require("./src/a"); if (r.x !== 1) process.exit(1)'`, `node -e 'require("./src/a").run().catch(() => { process.exitCode = 2 })'`, 'node bin/report.js --format csv | grep -q region', './check.sh', `python3 -c "from app.limits import allow; assert allow(1)"`, `grep -q x src/a.js && ${real('g')}`])
      expect(commandFocus(c), c).toBe('focused');
    // The bench scripted contracts' commands are all focused or the suite.
    for (const id of ['02-api-no-limits', '03-csv-export', '04-needs-db', '05-needs-mail'])
      for (const k of readJson<ScriptedContract[]>(id, 'scripted/contract.json')[0]!.criteria)
        if (k.check.kind === 'command') expect(commandFocus(k.check.command), `${id} ${k.id}`).toBe(k.check.command === 'node --test' ? 'generic' : 'focused');
  });

  it('a draft whose behavioural criterion is a no-op is refused, and the planner redrafts it', async () => {
    const statement = 'add rate limiting';
    const noop = draftOf(statement, [cmdK('limited', `node -e 'console.log("ok")'`), cmdK('suite', 'node --test')]);
    const issues = contractQualityIssues(noop, { statement, goal: g(statement) });
    expect(issues.join('\n')).toMatch(/criterion limited runs nothing that can fail on the behaviour/);
    expect(issues.join('\n')).toMatch(/only generic criteria/);
    const m2 = manifestOf('02-api-no-limits');
    const weak = wire([{ id: 'limited', statement: 'limits', command: `node -e 'console.log("ok")'` }, { id: 'suite', statement: 'suite passes', command: 'node --test' }]);
    const good = wire([{ id: 'limited', statement: 'limits', command: real('limit') }, { id: 'suite', statement: 'suite passes', command: 'node --test' }]);
    const err = (await caught(new LLMPlanner({ llm: new FakeLLM([weak, weak]), manifest: m2, permissions, nonce: () => 'n' }).draftContract(statement, g(statement), []))) as ContractRejected;
    expect(err).toBeInstanceOf(ContractRejected);
    const d = await new LLMPlanner({ llm: new FakeLLM([weak, good]), manifest: m2, permissions, nonce: () => 'n' }).draftContract(statement, g(statement), []);
    expect(d.contract.criteria.map((k) => k.id)).toEqual(['limited', 'suite']);
  });

  it('a runner with only options or the whole tree is generic; a file, a positional filter or a name filter focuses it', () => {
    for (const c of ['npm test -- --runInBand', 'pytest -q', 'cargo test --all', 'go test ./...', 'yarn test --reporter dot', 'node --test --test-reporter=spec', 'npx jest --ci', 'cd api && npm test', 'npm run test', 'python3 -m pytest -x'])
      expect(commandFocus(c), c).toBe('generic');
    for (const c of ['pytest -k limit', 'cargo test parse_csv', 'npm test -- test/a.test.js', 'go test ./pkg/limit', 'npx vitest run -t "rate limit"', 'node --test --test-name-pattern=limit'])
      expect(commandFocus(c), c).toBe('focused');
    expect(commandFocus('node scripts/all.js --bail', 'node scripts/all.js')).toBe('generic');
    // A text search chained to the suite is still generic, never focused.
    expect(commandFocus('grep -q limit src/app.js && npm test')).toBe('generic');
  });

  it('behaviours are counted on distinct commands, and prohibitions count', () => {
    const two = 'add a 429 response and add a Retry-After header';
    const dup = draftOf(two, [cmdK('a', real('f')), cmdK('b', `${real('f')}  `), cmdK('suite', 'node --test')]);
    expect(contractQualityIssues(dup, { statement: two, goal: g(two) }).join()).toMatch(/names 2 behaviours but the contract has 1 distinct focused command criteria/);
    expect(contractQualityIssues(draftOf(two, [cmdK('a', real('f')), cmdK('b', real('g'))]), { statement: two, goal: g(two) })).toEqual([]);

    const prohibit = 'Add rate limiting. Do not expose stack traces in error responses.';
    expect(statementBehaviourShape(prohibit)).toEqual({ focused: 2, preserve: 0 });
    expect(contractQualityIssues(draftOf(prohibit, [cmdK('a', real('f')), cmdK('suite', 'node --test')]), { statement: prohibit, goal: g(prohibit) }).join()).toMatch(/names 2 behaviours but the contract has 1/);
    // "Do not change the API" is covered by the existing suite, or else needs its own focused check.
    const keep = 'Add rate limiting. Do not change the public API.';
    expect(statementBehaviourShape(keep)).toEqual({ focused: 1, preserve: 1 });
    expect(contractQualityIssues(draftOf(keep, [cmdK('a', real('f')), cmdK('suite', 'node --test')]), { statement: keep, goal: g(keep) })).toEqual([]);
    expect(contractQualityIssues(draftOf(keep, [cmdK('a', real('f'))]), { statement: keep, goal: g(keep) }).join()).toMatch(/names 2 behaviours but the contract has 1 distinct focused command criteria and none runs the existing suite/);
  });

  it('the implied capability sits on the criteria that exercise it, not on the suite or an unrelated one', () => {
    const statement = 'persist sessions';
    const need = [{ id: 'db', kind: 'sqlite', criteria: ['suite'], mockable: true }];
    const onSuite = draftOf(statement, [cmdK('survives', real('f'), 'Sessions survive a restart'), cmdK('suite', 'node --test', 'suite passes', ['db'])], need);
    expect(contractQualityIssues(onSuite, { statement, goal: g(statement) }).join()).toMatch(/"persist" implies a database: a criterion that exercises it must require capability db/);

    const unrelated = draftOf(statement, [cmdK('survives', real('f'), 'Sessions survive a restart'), cmdK('header', real('g'), 'The response has a header', ['db'])], [{ id: 'db', kind: 'sqlite', criteria: ['header'], mockable: true }]);
    expect(contractQualityIssues(unrelated, { statement, goal: g(statement) }).join()).toMatch(/criterion survives is about a database \("sessions"\) but does not require capability db/);

    const right = draftOf(statement, [cmdK('survives', real('f'), 'Sessions survive a restart', ['db']), cmdK('header', real('g'), 'The response has a header')], [{ id: 'db', kind: 'sqlite', criteria: ['survives'], mockable: true }]);
    expect(contractQualityIssues(right, { statement, goal: g(statement) })).toEqual([]);
  });

  it('a criterion may not run a file the repository does not hold (the worker could never write it)', async () => {
    expect(commandRunsFiles('node --test test/new.test.js test/b.test.js')).toEqual(['test/new.test.js', 'test/b.test.js']);
    expect(commandRunsFiles('node bin/report.js --format csv | grep -q region')).toEqual(['bin/report.js']);
    expect(commandRunsFiles('./scripts/check.sh && node --import ./reg.js test/x.js')).toEqual(['scripts/check.sh', 'test/x.js']);
    expect(commandRunsFiles(`${real('f')} && node --test && python3 -m pytest tests/a.py && node --test "test/**/*.test.js"`)).toEqual([]);

    const statement = 'add rate limiting';
    const draft = draftOf(statement, [cmdK('limited', 'node --test test/rate.test.js'), cmdK('suite', 'node --test')]);
    const has = (p: string) => p === 'test/app.test.js';
    expect(contractQualityIssues(draft, { statement, goal: g(statement), fileExists: has }).join()).toMatch(/criterion limited runs test\/rate\.test\.js, which is not in the repository/);
    expect(contractQualityIssues(draft, { statement, goal: g(statement), fileExists: (p) => p === 'test/rate.test.js' })).toEqual([]);
    // Without the repository view the check does not apply; a throwing view counts as absent.
    expect(contractQualityIssues(draft, { statement, goal: g(statement) })).toEqual([]);
    expect(contractQualityIssues(draft, { statement, goal: g(statement), fileExists: () => { throw new Error('io'); } }).join()).toMatch(/not in the repository/);

    const m2 = manifestOf('02-api-no-limits');
    const answer = wire([{ id: 'limited', statement: 'limits', command: 'node --test test/rate.test.js' }, { id: 'suite', statement: 'suite passes', command: 'node --test' }]);
    const err = (await caught(new LLMPlanner({ llm: new FakeLLM([answer, answer]), manifest: m2, permissions, nonce: () => 'n', repoFiles: has }).draftContract(statement, g(statement), []))) as ContractRejected;
    expect(err).toBeInstanceOf(ContractRejected);
    expect(err.issues.join('\n')).toMatch(/runs test\/rate\.test\.js, which is not in the repository/);
  });

  it('only a completed answer is used: an unknown finish reason refuses the contract and the plan', async () => {
    const m3 = manifestOf('03-csv-export');
    const statement = 'add CSV export to the report command';
    const answer = wire([{ id: 'csv', statement: 'csv', command: real('csv') }, { id: 'suite', statement: 'suite passes', command: 'node --test' }]);
    const filtered = { content: answer, finishReason: 'content_filter' as never };
    const err = (await caught(new LLMPlanner({ llm: new FakeLLM([filtered, filtered]), manifest: m3, permissions, nonce: () => 'n' }).draftContract(statement, g(statement), []))) as ContractRejected;
    expect(err).toBeInstanceOf(ContractRejected);
    expect(err.issues.join('\n')).toMatch(/did not finish its answer/);
    const plan = { content: JSON.stringify(goodDoc()), finishReason: 'content_filter' as never };
    const perr = (await caught(new LLMPlanner({ llm: new FakeLLM([plan, plan]), manifest: m3, permissions, nonce: () => 'n' }).write(adopted, beliefs, goal))) as PlanRejected;
    expect(perr).toBeInstanceOf(PlanRejected);
    expect(perr.issues.join('\n')).toMatch(/did not finish its answer/);
  });
});
