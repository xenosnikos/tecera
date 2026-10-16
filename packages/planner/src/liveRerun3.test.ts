import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contractHash, parseManifest, type AcceptanceContract, type AchievementGoal, type Criterion, type Manifest, type PlanningContext } from '@tecera/contracts';
import { declaredExports, nameUses, resolveFrom } from './apiSurface.js';
import { ContractRejected } from './contract.js';
import { FakeBeliefs, FakeLLM, adopted, goal, goodDoc, samplePermissions } from './fixtures.testkit.js';
import { LLMPlanner, PlanRejected } from './llmPlanner.js';
import { buildContractPrompt, buildPlannerPrompt } from './prompt.js';
import { asksToChange, callShapeConflict, commandReadsScriptFromStdin, commandSandboxProblems, contractQualityIssues } from './quality.js';
import { testedApiOf, type RepoFacts } from './repoFacts.js';
import { capabilityRoutes, seamsFor, standInInstructionIssues } from './standIn.js';

/**
 * Third live rerun at the planner seat, with the shapes the live runs produced: a write scope narrowed to the
 * path a request names (s3), criteria that call an existing tested function with an invented call shape (s4,
 * s5), a plan that tells the worker to send mail with the stand-in tool from product code (s5), and criteria
 * that start a server, fetch it and background the check (s2). The bench fixtures' repositories are the inputs.
 */

const fixture = (scenario: string, rel: string) => new URL(`../../bench/fixtures/${scenario}/${rel}`, import.meta.url);
const manifestOf = (id: string): Manifest => parseManifest(JSON.parse(readFileSync(fixture(id, 'repo/tecera.json'), 'utf8')));
const file = (scenario: string, path: string) => ({ path, text: readFileSync(fixture(scenario, `repo/${path}`), 'utf8') });
/** The facts the host reads from a fixture repository: its test file and the module the test imports. */
const factsOf = (scenario: string, test: string, module: string): RepoFacts => ({ dependencies: [], testedApi: testedApiOf([file(scenario, test)], [file(scenario, module)]) });

const permissions = samplePermissions();
const beliefs = new FakeBeliefs([]);
const caught = (pr: Promise<unknown>) => pr.then(() => null, (e: unknown) => e);
const cmd = (id: string, command: string, statement = id, requires?: string[]): Criterion => ({ id, statement, check: { kind: 'command', command, timeoutSec: 60 }, ...(requires ? { requires } : {}) });
const inline = (body: string) => `node --input-type=module -e 'import assert from "node:assert/strict"; ${body}'`;
const g = (statement: string): AchievementGoal => ({ ...goal, id: 'g-live3', statement, criteria: undefined, contractHash: undefined } as AchievementGoal);
const draftOf = (statement: string, criteria: Criterion[], needs: Array<{ id: string; kind: string; criteria: string[]; mockable: boolean }> = []) => ({
  contract: { goalId: 'g-live3', statement, criteria, outOfScope: [], assumptions: [] },
  needs,
});
const wire = (criteria: Criterion[], needs: Array<{ id: string; kind: string; mockable: boolean | null }> = []) =>
  JSON.stringify({
    criteria: criteria.map((c) => ({ id: c.id, statement: c.statement, kind: 'command', command: c.check.kind === 'command' ? c.check.command : '', timeoutSec: 60, prompt: null, requires: c.requires ?? [], tags: [] })),
    outOfScope: [],
    assumptions: [],
    envelope: [{ path: 'src/*.js', ops: ['create', 'modify'] }],
    needs,
  });
const planningFor = (m: Manifest, statement: string, criteria: Criterion[], inventory: PlanningContext['inventory']): PlanningContext => {
  const c: AcceptanceContract = { goalId: 'g-live3', statement, criteria, outOfScope: [], assumptions: [] };
  return { contract: c, contractHash: contractHash(c), inventory, allowance: m.provisioning, provisionedSoFar: 0 };
};
/** goodDoc with its verify steps listing `ids` and its edit step replaced by `edit`. */
const docWith = (ids: string[], edit: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
  const d = JSON.parse(JSON.stringify(goodDoc())) as { steps: Array<Record<string, unknown>> } & Record<string, unknown>;
  d.steps = d.steps.map((s) => (s['id'] === 'edit' ? { ...s, ...edit } : s['kind'] === 'gate.verify' ? { ...s, inputs: { criteria: ids } } : s));
  return JSON.stringify({ ...d, ...extra });
};

// ---------------------------------------------------------------------------------------------------------
// 1. write scope (s3)
// ---------------------------------------------------------------------------------------------------------

describe('s3: a path the request or contract names never narrows the write scope', () => {
  const m3 = manifestOf('03-csv-export');
  const repo = new Set(['src/report.js', 'bin/report.js', 'test/report.test.js', 'data/sales.json']);
  // The live contract imported the existing src/report.js; the command that must change is bin/report.js,
  // which imports it and which no criterion and no request text names.
  const criteria = [cmd('csv-format', inline('import { formatCSV } from "./src/report.js"; assert.equal(formatCSV([{ region: "a", total: 2 }]), "region,total\\na,2.00\\n");'), 'formatCSV in src/report.js renders rows as CSV'), cmd('suite', 'node --test', 'existing tests pass')];

  it('src/report.js is named and exists, the model wrote src/**: both src/** and bin/** stay writable', async () => {
    expect(readFileSync(fixture('03-csv-export', 'repo/bin/report.js'), 'utf8')).toContain("from '../src/report.js'");
    for (const statement of ['add CSV export to the report command', 'add CSV export to src/report.js']) {
      const ctx = planningFor(m3, statement, criteria, []);
      const llm = new FakeLLM([docWith(['csv-format', 'suite'])]);
      const plan = await new LLMPlanner({ llm, manifest: m3, permissions, nonce: () => 'n1', repoFiles: (p) => repo.has(p) }).write(adopted, beliefs, g(statement), undefined, ctx);
      // The model's own document asked for src/** only.
      expect(JSON.parse(docWith([])).permissions.write).toEqual(['src/**']);
      expect(plan.permissions.write).toEqual(['src/**', 'bin/**']);
      expect(plan.rationale).not.toMatch(/narrowed/);
    }
  });

  it('the prompt tells the model to use allowedChanges as they are', () => {
    const [sys] = buildPlannerPrompt({ manifest: m3, goal: g('add CSV export to the report command'), event: adopted, beliefs: [], permissions, nonce: 'n' });
    expect(sys!.content).toMatch(/Use them as they are; the host sets allowedChanges for any plan that changes files/);
  });
});

// ---------------------------------------------------------------------------------------------------------
// 2. the existing tested API (s4, s5)
// ---------------------------------------------------------------------------------------------------------

describe('s4 / s5: criteria keep the call shapes the existing tests use', () => {
  const facts4 = factsOf('04-needs-db', 'test/sessions.test.js', 'src/sessions.js');
  const facts5 = factsOf('05-needs-mail', 'test/signup.test.js', 'src/signup.js');
  const has4 = (p: string) => ['src/sessions.js', 'test/sessions.test.js', 'package.json'].includes(p);
  const has5 = (p: string) => ['src/signup.js', 'test/signup.test.js', 'package.json'].includes(p);
  const needDb = (ids: string[]) => [{ id: 'db', kind: 'sqlite', criteria: ids, mockable: true }];
  const needMail = (ids: string[]) => [{ id: 'mail', kind: 'smtp', criteria: ids, mockable: true }];

  it('the host reads the call shapes from the tests and the declared parameters from the module', () => {
    expect(facts4.testedApi).toEqual([
      {
        module: 'src/sessions.js',
        names: ['createSessionStore'],
        tests: ['test/sessions.test.js'],
        calls: [{ name: 'createSessionStore', signatures: [[]], methods: ['close', 'delete', 'get', 'set'], params: [{ name: 'options', kind: 'object', optional: true, rest: false, members: [] }] }],
        // the module's comment documents the options object
        documented: ["Session store: createSessionStore({ path }) keeps the app's sessions."],
        shapes: [{ name: 'createSessionStore', keys: ['path'] }],
      },
    ]);
    expect(facts5.testedApi[0]!.calls).toEqual([
      {
        name: 'signup',
        signatures: [['object']],
        methods: [],
        params: [
          { name: 'user', kind: 'unknown', optional: false, rest: false, members: ['email', 'name'] },
          { name: 'deps', kind: 'object', optional: true, rest: false, members: ['mailer'] },
        ],
      },
    ]);
    // A factory whose result the tests call as a function (the s2 handler).
    expect(factsOf('02-api-no-limits', 'test/app.test.js', 'src/app.js').testedApi[0]!.calls[0]).toMatchObject({ name: 'createApp', signatures: [[]], resultCalled: true });
    // Without the module's text only the tests' shapes are known.
    expect(testedApiOf([file('05-needs-mail', 'test/signup.test.js')])[0]!.calls).toEqual([{ name: 'signup', signatures: [['object']], methods: [] }]);
    expect(declaredExports('export const f = async ({ a, b = 1 }, ...rest) => a; export default function (x = []) {}')).toEqual([
      { name: 'default', params: [{ name: 'x', kind: 'array', optional: true, rest: false, members: [] }] },
      { name: 'f', params: [{ name: '{…}', kind: 'object', optional: false, rest: false, members: ['a', 'b'] }, { name: 'rest', kind: 'array', optional: false, rest: true, members: [] }] },
    ]);
    expect(nameUses('import { f } from "./src/a.js"; const db = new X(); const s = f(db, process.env.P, "x"); s.go();', resolveFrom('inline.mjs'))).toEqual([{ module: 'src/a.js', name: 'f', calls: [['instance', 'string', 'string']], methods: ['go'], resultCalled: false }]);
  });

  it('callShapeConflict: another kind or too few arguments conflicts; an unknown kind or an added argument does not', () => {
    const signup = facts5.testedApi[0]!.calls[0]!;
    expect(callShapeConflict(['string'], signup)).toBe('argument 1 is a string, the existing code takes an object');
    expect(callShapeConflict([], signup)).toBe('0 arguments, the existing code is always given at least 1');
    expect(callShapeConflict(['object'], signup)).toBeNull();
    expect(callShapeConflict(['object', 'object'], signup)).toBeNull();
    expect(callShapeConflict(['unknown', 'unknown'], signup)).toBeNull();
    expect(callShapeConflict(['object', 'function'], signup)).toBe('argument 2 is a function, the existing code takes an object');
    // An argument beyond what is declared is an addition, not a conflict.
    expect(callShapeConflict(['object', 'object', 'string'], signup)).toBeNull();
    expect(callShapeConflict(['string'], { signatures: [] })).toBeNull();
  });

  it('s4: createSessionStore(db).create() against createSessionStore({ path }).set/get/delete is refused', () => {
    const statement = 'persist sessions';
    // The two live drafts: a DatabaseSync instance with create(), then a bare path with async set and destroy.
    const instance = cmd('session-created-stored', inline('import { DatabaseSync } from "node:sqlite"; import { createSessionStore } from "./src/sessions.js"; const db = new DatabaseSync(process.env.TECERA_RESOURCE_DB); const store = createSessionStore(db); const sessionId = store.create({ userId: 123 }); assert.ok(sessionId); const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId); assert.ok(row);'), 'A session can be created and stored in the database.', ['db']);
    const path = cmd('sessions-persist-restart', inline('import { createSessionStore } from "./src/sessions.js"; const store = createSessionStore(process.env.TECERA_RESOURCE_DB); await store.set("sid1", {user: "alice"}); const store2 = createSessionStore(process.env.TECERA_RESOURCE_DB); const session = await store2.get("sid1"); assert.deepEqual(session, {user: "alice"});'), 'Sessions persist across store recreation using the same database file.', ['db']);
    const suite = cmd('existing-unchanged', 'node --test', 'Existing tests continue to pass.');
    const ctx = { statement, goal: g(statement), fileExists: has4, dependencies: [], testedApi: facts4.testedApi };

    const a = contractQualityIssues(draftOf(statement, [instance, suite], needDb([instance.id])), ctx);
    expect(a).toEqual([
      'criterion session-created-stored calls createSessionStore(new …): argument 1 is a class instance, the existing code takes an object. Existing: createSessionStore(options = {}) in src/sessions.js (tests call createSessionStore()). Keep that call shape; add an option or a new function instead',
    ]);
    const b = contractQualityIssues(draftOf(statement, [path, suite], needDb([path.id])), ctx);
    expect(b.join('\n')).toMatch(/criterion sessions-persist-restart calls createSessionStore\("…"\): argument 1 is a string, the existing code takes an object/);

    // The existing shape with the provisioned location behind an option is what a contract may ask for.
    const kept = cmd('sessions-survive-restart', inline('import { createSessionStore } from "./src/sessions.js"; const a = createSessionStore({ path: process.env.TECERA_RESOURCE_DB }); a.set("s", { user: "ada" }); a.close(); const b = createSessionStore({ path: process.env.TECERA_RESOURCE_DB }); assert.deepEqual(b.get("s"), { user: "ada" }); b.delete("s"); b.close();'), 'Sessions survive a restart', ['db']);
    expect(contractQualityIssues(draftOf(statement, [kept, suite], needDb([kept.id])), ctx)).toEqual([]);
    // Without the tested API the screen cannot say and stays silent (the earlier behaviour).
    expect(contractQualityIssues(draftOf(statement, [instance, suite], needDb([instance.id])), { ...ctx, testedApi: undefined })).toEqual([]);
    // A request that asks for the new call shape is exempt.
    const asked = 'persist sessions: change createSessionStore to accept a DatabaseSync instance';
    expect(contractQualityIssues(draftOf(asked, [instance, suite], needDb([instance.id])), { ...ctx, statement: asked, goal: g(asked) }).join('\n')).not.toMatch(/createSessionStore\(new/);
  });

  it('s5: signup(email) against signup(user, deps) is refused; the fake injected through deps.mailer passes', () => {
    const statement = 'send a welcome email';
    const invented = cmd('welcome-email-sent', inline('import { signup } from "./src/signup.js"; const result = await signup("user@example.com"); assert.ok(result.emailSent === true);'), 'A welcome email is sent when signup is called.', ['mail']);
    // The same through a variable bound to a literal (the second live criterion).
    const viaVar = cmd('email-recipient-matches', inline('import { signup } from "./src/signup.js"; const email = "test@example.com"; const result = await signup(email); assert.strictEqual(result.emailTo, email);'), 'The welcome email recipient matches the signup email address.', ['mail']);
    const suite = cmd('existing-behavior-unchanged', 'node --test', 'Existing tests still pass.');
    const ctx = { statement, goal: g(statement), fileExists: has5, dependencies: [], testedApi: facts5.testedApi };
    const issues = contractQualityIssues(draftOf(statement, [invented, viaVar, suite], needMail([invented.id, viaVar.id])), ctx);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toBe('criterion welcome-email-sent calls signup("…"): argument 1 is a string, the existing code takes an object. Existing: signup(user, deps = {}) in src/signup.js (tests call signup({…})). Keep that call shape; add an option or a new function instead');
    expect(issues[1]).toMatch(/^criterion email-recipient-matches calls signup\("…"\)/);

    const seam = cmd('welcome-sent', inline('import { signup } from "./src/signup.js"; const sent = []; await signup({ email: "ada@example.com", name: "Ada" }, { mailer: { send: async (m) => { sent.push(m); } } }); assert.equal(sent.length, 1); assert.equal(sent[0].to, "ada@example.com");'), 'Signing up sends one welcome email to the new user', ['mail']);
    expect(contractQualityIssues(draftOf(statement, [seam, suite], needMail([seam.id])), ctx)).toEqual([]);
  });

  it('a second function of an existing exported name in a module the repository does not hold is refused', () => {
    const statement = 'persist sessions in src/store.js';
    const second = cmd('persists', inline('import { createSessionStore } from "./src/store.js"; const s = createSessionStore({ path: process.env.TECERA_RESOURCE_DB }); s.set("a", 1); assert.equal(s.get("a"), 1);'), 'Sessions persist', ['db']);
    const ctx = { statement, goal: g(statement), fileExists: has4, dependencies: [], testedApi: facts4.testedApi };
    expect(contractQualityIssues(draftOf(statement, [second, cmd('suite', 'node --test')], needDb(['persists'])), ctx)).toEqual([
      'criterion persists imports createSessionStore from src/store.js, a module the repository does not hold, but src/sessions.js already exports createSessionStore (used by test/sessions.test.js); extend the existing function instead of defining a second one',
    ]);
    // Another name in a new module the request names is new code, not a collision.
    const other = cmd('persists', inline('import { openStore } from "./src/store.js"; const s = openStore(process.env.TECERA_RESOURCE_DB); s.set("a", 1); assert.equal(s.get("a"), 1);'), 'Sessions persist', ['db']);
    expect(contractQualityIssues(draftOf(statement, [other, cmd('suite', 'node --test')], needDb(['persists'])), ctx)).toEqual([]);
  });

  it('both prompts list the call shapes and say they are preserved unless the request asks otherwise', () => {
    const m4 = manifestOf('04-needs-db');
    const sys = buildContractPrompt({ manifest: m4, goal: g('persist sessions'), statement: 'persist sessions', repo: facts4, nonce: 'n' })[0]!.content as string;
    expect(sys).toMatch(/Criteria preserve every call shape listed \(the same arguments in the same positions, the same methods on what is returned\) unless the request asks to change it/);
    expect(sys).toContain('  - `src/sessions.js`: `createSessionStore` (used by test/sessions.test.js)');
    expect(sys).toContain('    - `createSessionStore`: declared `createSessionStore(options = {})`; the tests call `createSessionStore()`; then `.close()`, `.delete()`, `.get()`, `.set()` on what it returns');
    const m5 = manifestOf('05-needs-mail');
    const sys5 = buildContractPrompt({ manifest: m5, goal: g('send a welcome email'), statement: 'send a welcome email', repo: facts5, nonce: 'n' })[0]!.content as string;
    expect(sys5).toContain('    - `signup`: declared `signup(user, deps = {})`; the tests call `signup({…})`; `user` carries `user.email`, `user.name`; `deps` carries `deps.mailer`');
    const [plan] = buildPlannerPrompt({ manifest: m5, goal: g('send a welcome email'), event: adopted, beliefs: [], permissions, repo: facts5, nonce: 'n' });
    expect(plan!.content).toMatch(/## Existing API \(the repository's own tests use it\)\n- Step instructions keep every call shape below working[^\n]*unless the request asks to change it/);
    expect(plan!.content).toContain('declared `signup(user, deps = {})`');
    // No facts, no section.
    expect(buildPlannerPrompt({ manifest: m5, goal: g('send a welcome email'), event: adopted, beliefs: [], permissions, nonce: 'n' })[0]!.content).not.toMatch(/## Existing API/);
  });

  it('LLMPlanner refuses the live s4 draft with its repository facts and accepts the one that keeps the API', async () => {
    const m4 = manifestOf('04-needs-db');
    const statement = 'persist sessions';
    const bad = cmd('session-created-stored', inline('import { DatabaseSync } from "node:sqlite"; import { createSessionStore } from "./src/sessions.js"; const db = new DatabaseSync(process.env.TECERA_RESOURCE_DB); const store = createSessionStore(db); const sessionId = store.create({ userId: 123 }); assert.ok(sessionId);'), 'A session can be created and stored in the database.', ['db']);
    const good = cmd('sessions-survive-restart', inline('import { createSessionStore } from "./src/sessions.js"; const a = createSessionStore({ path: process.env.TECERA_RESOURCE_DB }); a.set("s", 1); a.close(); assert.equal(createSessionStore({ path: process.env.TECERA_RESOURCE_DB }).get("s"), 1);'), 'Sessions survive a restart', ['db']);
    const suite = cmd('suite', 'node --test', 'existing tests pass');
    const needs = [{ id: 'db', kind: 'sqlite', mockable: true }];
    const planner = (answers: string[]) => new LLMPlanner({ llm: new FakeLLM(answers), manifest: m4, permissions, nonce: () => 'n7n7n7', repoFiles: has4, repoFacts: () => facts4 });
    const err = (await caught(planner([wire([bad, suite], needs), wire([bad, suite], needs)]).draftContract(statement, g(statement), []))) as ContractRejected;
    expect(err).toBeInstanceOf(ContractRejected);
    expect(err.issues.join('\n')).toMatch(/calls createSessionStore\(new …\): argument 1 is a class instance, the existing code takes an object\. Existing: createSessionStore\(options = \{\}\) in src\/sessions\.js \(tests call createSessionStore\(\)\)\. Keep that call shape; add an option or a new function instead$/m);
    // The repair round gets the reason and its corrected answer is accepted.
    const llm = new FakeLLM([wire([bad, suite], needs), wire([good, suite], needs)]);
    const draft = await new LLMPlanner({ llm, manifest: m4, permissions, nonce: () => 'n7n7n7', repoFiles: has4, repoFacts: facts4 }).draftContract(statement, g(statement), []);
    expect(draft.contract.criteria.map((k) => k.id)).toEqual(['sessions-survive-restart', 'suite']);
    expect(llm.requests[1]!.messages.at(-1)!.content).toMatch(/Keep that call shape; add an option or a new function instead/);
  });
});

// ---------------------------------------------------------------------------------------------------------
// 3. stand-in tools stay out of product code (s5)
// ---------------------------------------------------------------------------------------------------------

describe('s5: a stand-in tool is the worker\'s own instrument, never what product code calls', () => {
  const m5 = manifestOf('05-needs-mail');
  const statement = 'send a welcome email';
  const facts5 = factsOf('05-needs-mail', 'test/signup.test.js', 'src/signup.js');
  const criteria = [cmd('welcome', inline('import { signup } from "./src/signup.js"; const sent = []; await signup({ email: "a@b.c" }, { mailer: { send: async (m) => { sent.push(m); } } }); assert.equal(sent.length, 1);'), 'signing up sends a welcome email', ['mail']), cmd('suite', 'node --test')];
  const ctx = planningFor(m5, statement, criteria, [{ id: 'mail', kind: 'smtp', state: 'missing' }]);
  const routes = capabilityRoutes({ manifest: m5, criteria, planning: ctx });
  // The two live instructions (s5 and its second attempt).
  const LIVE = [
    "Create or modify src/signup.js to export a signup function that accepts {email, name} and sends a welcome email using the mail tool. The email should have a subject line containing 'Welcome' and the body should include a greeting with the recipient's name. Use the mail tool's send() method.",
    "Implement the signup function in src/signup.js that accepts an email address parameter and sends a welcome email using the mail tool. The function must return an object with {emailSent: true, emailTo: <email>, emailSubject: <subject>} where the subject contains 'Welcome'. Use the simulated mail tool with send(message) where message has to, subject, and body properties. Create the file if it doesn't exist, or modify it if it does.",
  ];
  const step = (instruction: string) => [{ id: 'implement', kind: 'worker', instruction }];

  it('the routes say which capabilities are served as a tool, and the seam is named from the existing code', () => {
    expect(routes).toEqual([{ id: 'mail', kind: 'smtp', rung: 'mock', tool: true }]);
    expect(seamsFor(facts5, 'smtp', 'mail')).toEqual([{ path: 'deps.mailer', declared: 'signup(user, deps = {})', module: 'src/signup.js' }]);
    expect(seamsFor(undefined, 'smtp', 'mail')).toEqual([]);
    const prov = capabilityRoutes({ manifest: m5, criteria: [cmd('d', 'node x.js', 'd', ['db']), cmd('r', 'node y.js', 'r', ['remote'])], planning: { ...ctx, inventory: [{ id: 'db', kind: 'sqlite', state: 'provisioned', resourceId: 'r1' }, { id: 'remote', kind: 'git-remote', state: 'provisioned', resourceId: 'r2' }] } });
    expect(prov).toEqual([{ id: 'db', kind: 'sqlite', rung: 'provisioned', tool: true }, { id: 'remote', kind: 'git-remote', rung: 'provisioned', tool: false }]);
  });

  it('the plan prompt keeps the tool to the worker\'s own checks and names deps.mailer as what the code calls', () => {
    const [sys] = buildPlannerPrompt({ manifest: m5, goal: g(statement), event: adopted, beliefs: [], permissions, toolCatalog: ['read', 'edit', 'listFiles', 'runVerify', 'mail'], planning: ctx, repo: facts5, nonce: 'n' });
    const line = (sys!.content as string).split('\n').find((l) => l.includes('`mail` (smtp) is missing'))!;
    expect(line).toMatch(/worker tool `mail` is a simulated stand-in \(send\(message\), outbox\(\)\)/);
    expect(line).toMatch(/Tool `mail` exists only inside the worker's sandbox session, for the worker's own exploration and checks: it is never called from the repository's code \(it is not defined when the criteria run\)\./);
    expect(line).toMatch(/The code reaches the capability through the repository's own seam \(`deps\.mailer` of `signup\(user, deps = \{\}\)` in `src\/signup\.js`\), and the criteria inject a fake through that seam/);
    expect(sys!.content).toMatch(/A step instruction that tells the worker to use such a tool from the code[^\n]*is refused\./);
    // Without repository facts the seam is described, not named.
    const [bare] = buildPlannerPrompt({ manifest: m5, goal: g(statement), event: adopted, beliefs: [], permissions, planning: ctx, nonce: 'n' });
    expect(bare!.content).toMatch(/the repository's own seam \(an injected dependency the existing code takes, e\.g\. a `deps\.mailer` argument/);
    // A provisioned tool is the worker's own too.
    const prov = planningFor(m5, statement, [cmd('d', 'node x.js', 'd', ['db'])], [{ id: 'db', kind: 'sqlite', state: 'provisioned', resourceId: 'r1' }]);
    const [p] = buildPlannerPrompt({ manifest: m5, goal: g(statement), event: adopted, beliefs: [], permissions, planning: prov, nonce: 'n' });
    expect(p!.content).toMatch(/`db` \(sqlite\) is provisioned by Tecera: worker tool `db` reaches it; [^\n]*`TECERA_RESOURCE_DB`\. Tool `db` exists only inside the worker's sandbox session/);
    // The drafting prompt tells the criteria to inject a fake through the seam.
    const draft = buildContractPrompt({ manifest: m5, goal: g(statement), statement, repo: facts5, nonce: 'n' })[0]!.content as string;
    expect(draft).toMatch(/That tool exists only inside the worker's sandbox session: it is not defined when a criterion runs and the repository's code never calls it\. A criterion about such a capability calls the code through the repository's own seam/);
  });

  it('both live instructions are refused with the seam to use instead', () => {
    for (const text of LIVE) {
      expect(standInInstructionIssues(step(text), routes, facts5)).toEqual([
        "step implement has the code use the mail tool, which exists only in the worker's sandbox session (for its own checks) and is not defined when the criteria run; the code must reach the capability through the repository's own seam: deps.mailer of signup(user, deps = {}) in src/signup.js",
      ]);
    }
    expect(standInInstructionIssues(step('In src/signup.js call mail.send({ to, subject, text }) after registering.'), routes)).toHaveLength(1);
    expect(standInInstructionIssues(step('Send it with the `mail` tool.'), routes)).toHaveLength(1);
  });

  it('an instruction that sends through the seam, forbids the tool or keeps it to the worker\'s checks passes', () => {
    const scripted = JSON.parse(readFileSync(fixture('05-needs-mail', 'scripted/plan.json'), 'utf8')) as { steps: Array<{ id: string; kind: string; instruction?: string }> };
    expect(scripted.steps.some((s) => /deps\.mailer/.test(s.instruction ?? ''))).toBe(true);
    expect(standInInstructionIssues(scripted.steps, routes, facts5)).toEqual([]);
    for (const ok of [
      'Send the welcome message through deps.mailer.send({ to, subject, text }) after registering. Never call the mail tool from src/signup.js.',
      'Try the message on the mail tool first to see what the outbox records, then have signup call deps.mailer.send().',
      'Use the mail tool only for your own checks; the code sends through deps.mailer.',
      'Email the user by calling deps.mailer.send(message).',
    ]) expect(standInInstructionIssues(step(ok), routes, facts5)).toEqual([]);
    // No tool is served for an available capability, a gate step has no instruction to screen.
    expect(standInInstructionIssues(step(LIVE[0]!), [{ id: 'mail', kind: 'smtp', rung: 'available', tool: false }])).toEqual([]);
    expect(standInInstructionIssues([{ id: 'verify', kind: 'gate.verify' }], routes)).toEqual([]);
  });

  it('LLMPlanner refuses the live plan, feeds the reason to the repair round and accepts the corrected one', async () => {
    const live = docWith(['welcome', 'suite'], { instruction: LIVE[0], tools: ['read', 'edit', 'mail'] }, { permissions: { ...goodDoc().permissions, tools: [...goodDoc().permissions.tools, 'mail'] }, capabilities: ['mail'] });
    const fixed = docWith(['welcome', 'suite'], { instruction: 'In src/signup.js send the welcome message through deps.mailer.send({ to, subject, text }) after registering; keep the email validation. Never call the mail tool from the code.', tools: ['read', 'edit', 'mail'] }, { permissions: { ...goodDoc().permissions, tools: [...goodDoc().permissions.tools, 'mail'] }, capabilities: ['mail'] });
    const planner = (answers: string[]) => new LLMPlanner({ llm: new FakeLLM(answers), manifest: m5, permissions, nonce: () => 'n7n7n7', repoFacts: facts5 });
    const err = (await caught(planner([live, live]).write(adopted, beliefs, g(statement), undefined, ctx))) as PlanRejected;
    expect(err).toBeInstanceOf(PlanRejected);
    expect(err.issues.join('\n')).toMatch(/step edit has the code use the mail tool, which exists only in the worker's sandbox session[^\n]*the repository's own seam: deps\.mailer of signup\(user, deps = \{\}\) in src\/signup\.js$/m);
    const llm = new FakeLLM([live, fixed]);
    const plan = await new LLMPlanner({ llm, manifest: m5, permissions, nonce: () => 'n7n7n7', repoFacts: facts5 }).write(adopted, beliefs, g(statement), undefined, ctx);
    expect(plan.steps.find((s) => s.id === 'edit')!.instruction).toMatch(/deps\.mailer\.send/);
    expect(llm.requests[1]!.messages.at(-1)!.content).toMatch(/has the code use the mail tool[^\n]*deps\.mailer of signup\(user, deps = \{\}\) in src\/signup\.js/);
  });
});

// ---------------------------------------------------------------------------------------------------------
// 4. criteria the verify sandbox cannot run (s2)
// ---------------------------------------------------------------------------------------------------------

describe('s2: criteria that start a server, reach the network or background the check are refused', () => {
  const m2 = manifestOf('02-api-no-limits');
  const statement = 'add rate limiting';
  const fetched = (body: string, tail: string) => `node --input-type=module -e 'import assert from "node:assert/strict"; import { createApp } from "./src/app.js"; const app = createApp(); ${body}' ${tail}`;
  // Three of the six live commands, as drafted.
  const LIVE: Array<[string, string]> = [
    ['requests-under-limit-succeed', fetched('const responses = await Promise.all(Array(5).fill().map((_, i) => fetch(`http://localhost:${3000 + process.pid % 1000}/`, { headers: { "X-Forwarded-For": "192.0.2.1" } }).then(r => r.status))); assert.ok(responses.every(s => s === 200));', '& sleep 1 && kill %1')],
    ['requests-over-limit-blocked', fetched('const responses = await Promise.all(Array(200).fill().map(() => fetch(`http://localhost:${3000 + process.pid % 1000}/`, { headers: { "X-Forwarded-For": "192.0.2.2" } }).then(r => r.status))); assert.ok(responses.some(s => s === 429));', '& sleep 2 && kill %1')],
    ['rate-limit-resets', fetched('const ip = "192.0.2.4"; await Promise.all(Array(100).fill().map(() => fetch(`http://localhost:${3000 + process.pid % 1000}/`, { headers: { "X-Forwarded-For": ip } }))); await new Promise(r => setTimeout(r, 61000)); const response = await fetch(`http://localhost:${3000 + process.pid % 1000}/`, { headers: { "X-Forwarded-For": ip } }); assert.equal(response.status, 200);', '& sleep 65 && kill %1')],
  ];
  const inProcess = cmd('limit-429', inline('import { createApp } from "./src/app.js"; const app = createApp({ rateLimit: { limit: 2, windowMs: 1000 }, now: () => 0 }); const hit = () => app({ ip: "127.0.0.1", path: "/items" }).status; assert.deepEqual([hit(), hit(), hit()], [200, 200, 429]);'), 'A client over the limit gets 429');

  it('each live command is named for what the sandbox cannot run', () => {
    for (const [id, command] of LIVE) expect(commandSandboxProblems(command)).toEqual(['backgrounds a command (&)', 'uses sleep', 'uses kill', ...(id === 'rate-limit-resets' ? ['waits on a timer'] : []), 'names a loopback address', 'calls fetch()']);
    const issues = contractQualityIssues(draftOf(statement, [...LIVE.map(([id, c]) => cmd(id, c)), cmd('existing-tests-pass', 'node --test')]), { statement, goal: g(statement) });
    expect(issues).toHaveLength(3);
    expect(issues[0]).toBe('criterion requests-under-limit-succeed backgrounds a command (&), uses sleep, uses kill, names a loopback address, calls fetch(): the verify sandbox has no network and no background jobs; import the code and call it in-process, as the existing tests do (fake the time instead of waiting)');
    // Every diagnostic survives the planner's bound on a diagnostic line whole.
    for (const x of issues) expect(x.length).toBeLessThan(300);
  });

  it('each way out of the process is refused on its own; in-process checks and shell plumbing are not', () => {
    const bad: Array<[string, RegExp]> = [
      ['node server.js & node check.js', /background/],
      ['sh -c "node server.js & node check.js"', /background/],
      ['node check.js; sleep 1', /uses sleep/],
      ['node a.js && wait', /uses wait/],
      ['curl -fsS http://example.com/health', /runs curl/],
      ['wget -qO- example.com', /runs wget/],
      [inline('import http from "node:http"; http.createServer(() => {}).listen(0);'), /starts a server/],
      [inline('const r = await fetch(process.env.URL); assert.equal(r.status, 200);'), /calls fetch\(\)/],
      [inline('import https from "node:https"; https.request({ hostname: "localhost" });'), /calls http\.request/],
      ['PORT=3000 node --test test/a.test.js', /names a port/],
      [inline('import { start } from "./src/app.js"; start({ port: 8080 });'), /names a port/],
      [inline('import { get } from "./src/c.js"; assert.ok(await get("127.0.0.1:8080"));'), /names a loopback address/],
    ];
    for (const [command, why] of bad) expect(commandSandboxProblems(command).join(', '), command).toMatch(why);
    const fine = [
      inProcess.check.kind === 'command' ? inProcess.check.command : '',
      'node --test test/app.test.js',
      'node --test 2>&1 | tail -1 && node bin/report.js >/dev/null 2>&1',
      'node bin/report.js --format csv &> out.txt && node --test',
      inline('import { handle } from "./src/app.js"; assert.equal(handle({ host: "example.com", url: "/x?a=1&b=2" }).status, 200);'),
    ];
    for (const command of fine) expect(commandSandboxProblems(command), command).toEqual([]);
    // A criterion that requires an HTTP capability may call it; it still may not background or wait.
    const stub = inline('const r = await fetch(process.env.TECERA_RESOURCE_API + "/ping"); assert.equal(r.status, 200);');
    expect(commandSandboxProblems(stub, true)).toEqual([]);
    expect(commandSandboxProblems(`${stub} & sleep 1`, true)).toEqual(['backgrounds a command (&)', 'uses sleep']);
  });

  it('the in-process contract passes the screen with the fixture\'s tested API; a requestor criterion is kept verbatim', () => {
    const facts2 = factsOf('02-api-no-limits', 'test/app.test.js', 'src/app.js');
    expect(contractQualityIssues(draftOf(statement, [inProcess, cmd('suite', 'node --test')]), { statement, goal: g(statement), fileExists: (p) => p === 'src/app.js', dependencies: [], testedApi: facts2.testedApi })).toEqual([]);
    // A criterion the requestor wrote is agreed already: the screen does not judge it.
    const own = cmd(LIVE[0]![0], LIVE[0]![1]);
    const agreed = { ...g(statement), criteria: [own] } as AchievementGoal;
    expect(contractQualityIssues(draftOf(statement, [own, inProcess, cmd('suite', 'node --test')]), { statement, goal: agreed })).toEqual([]);
  });

  it('the drafting prompt says the sandbox has no network and that a criterion calls the code in-process', () => {
    const sys = buildContractPrompt({ manifest: m2, goal: g(statement), statement, nonce: 'n' })[0]!.content as string;
    expect(sys).toMatch(/The verify sandbox has no network and a criterion's exit status must be the check's own\. A criterion calls the code in-process/);
    expect(sys).toMatch(/never uses `&` or a background job, `sleep`, `kill` or `wait`, and never reaches the network \(`fetch`, `http\.request`, `curl`, `wget`, `localhost`, `127\.0\.0\.1`, a port\)/);
  });

  it('LLMPlanner refuses the live s2 contract and accepts the in-process one from the repair round', async () => {
    const live = wire([...LIVE.map(([id, c]) => cmd(id, c)), cmd('existing-tests-pass', 'node --test')]);
    const err = (await caught(new LLMPlanner({ llm: new FakeLLM([live, live]), manifest: m2, permissions, nonce: () => 'n7n7n7' }).draftContract(statement, g(statement), []))) as ContractRejected;
    expect(err).toBeInstanceOf(ContractRejected);
    expect(err.issues.join('\n')).toMatch(/criterion rate-limit-resets backgrounds a command \(&\), uses sleep, uses kill, waits on a timer, names a loopback address, calls fetch\(\): the verify sandbox has no network and no background jobs; import the code and call it in-process, as the existing tests do \(fake the time instead of waiting\)$/m);
    const draft = await new LLMPlanner({ llm: new FakeLLM([live, wire([inProcess, cmd('existing-tests-pass', 'node --test')])]), manifest: m2, permissions, nonce: () => 'n7n7n7' }).draftContract(statement, g(statement), []);
    expect(draft.contract.criteria.map((k) => k.id)).toEqual(['limit-429', 'existing-tests-pass']);
  });
});

// ---------------------------------------------------------------------------------------------------------
// the same screens against the ways around them
// ---------------------------------------------------------------------------------------------------------

describe('s4: the screen holds on the facts a host reads from the tests alone, and on the methods', () => {
  const statement = 'persist sessions';
  const testsOnly = testedApiOf([file('04-needs-db', 'test/sessions.test.js')]);
  const full = factsOf('04-needs-db', 'test/sessions.test.js', 'src/sessions.js').testedApi;
  const has4 = (p: string) => ['src/sessions.js', 'test/sessions.test.js', 'package.json'].includes(p);
  const suite = cmd('suite', 'node --test', 'Existing tests continue to pass.');
  const issuesOf = (body: string, testedApi: typeof full) => {
    const k = cmd('persists', inline(`import { DatabaseSync } from "node:sqlite"; import { createSessionStore } from "./src/sessions.js"; ${body}`), 'Sessions are stored in the database.', ['db']);
    return contractQualityIssues(draftOf(statement, [k, suite], [{ id: 'db', kind: 'sqlite', criteria: ['persists'], mockable: true }]), { statement, goal: g(statement), fileExists: has4, dependencies: [], testedApi });
  };
  const LIVE_DRAFT = 'const db = new DatabaseSync(process.env.TECERA_RESOURCE_DB); const s = createSessionStore(db); assert.ok(s.create({ u: 1 }));';

  it('tests-only facts: the live draft is refused although no declaration was read', () => {
    expect(testsOnly[0]!.calls).toEqual([{ name: 'createSessionStore', signatures: [[]], methods: ['close', 'delete', 'get', 'set'] }]);
    expect(issuesOf(LIVE_DRAFT, testsOnly)).toEqual([
      'criterion persists calls createSessionStore(new …): argument 1 is a class instance, the existing tests call it with no arguments (only an options object can be added). Existing: createSessionStore() in src/sessions.js. Keep that call shape; add an option or a new function instead',
    ]);
    expect(issuesOf('const s = createSessionStore(process.env.TECERA_RESOURCE_DB); s.set("a", 1); assert.equal(s.get("a"), 1);', testsOnly).join('\n')).toMatch(/argument 1 is a string, the existing tests call it with no arguments/);
    // An options object is the addition that leaves the tested call working.
    expect(issuesOf('const s = createSessionStore({ path: process.env.TECERA_RESOURCE_DB }); s.set("a", 1); assert.equal(s.get("a"), 1); s.close();', testsOnly)).toEqual([]);
    expect(callShapeConflict(['object'], testsOnly[0]!.calls[0]!)).toBeNull();
    expect(callShapeConflict(['unknown'], testsOnly[0]!.calls[0]!)).toBeNull();
    // A function the tests call with an argument may gain a trailing one of any kind.
    expect(callShapeConflict(['object', 'string'], { signatures: [['object']] })).toBeNull();
  });

  it('a draft that calls only methods the tests never call on the result is refused', () => {
    for (const api of [full, testsOnly]) {
      expect(issuesOf('const db = new DatabaseSync(process.env.TECERA_RESOURCE_DB); const s = createSessionStore({ db }); assert.ok(s.create({ u: 1 }));', api)).toEqual([
        'criterion persists calls only .create() on what createSessionStore returns; the existing tests call .close(), .delete(), .get(), .set() (src/sessions.js). Keep those methods working and check the behaviour through them; add a method, never replace them',
        // with the module's text the host also knows the documented options ({ path }), and { db } is not one
        ...(api === full ? ['criterion persists gives createSessionStore { db }, which src/sessions.js documents as createSessionStore({ path }); use the documented keys'] : []),
      ]);
      expect(issuesOf('const s = createSessionStore({ path: process.env.TECERA_RESOURCE_DB }); await s.save("a", 1); assert.equal(await s.load("a"), 1); s.destroy("a");', api).join('\n')).toMatch(/calls only \.destroy\(\), \.load\(\), \.save\(\) on what createSessionStore returns/);
      // A method added beside the tested ones is new behaviour behind what exists.
      expect(issuesOf('const s = createSessionStore({ path: process.env.TECERA_RESOURCE_DB }); s.set("a", 1); s.flush(); assert.equal(s.get("a"), 1);', api)).toEqual([]);
    }
  });

  it('an argument built by a local function or a conversion still has its kind', () => {
    expect(issuesOf('const open = () => new DatabaseSync(process.env.TECERA_RESOURCE_DB); const s = createSessionStore(open()); s.set("a", 1); assert.equal(s.get("a"), 1);', full).join('\n')).toMatch(/calls createSessionStore\(new …\): argument 1 is a class instance, the existing code takes an object/);
    expect(issuesOf('function where() { return String(process.env.TECERA_RESOURCE_DB); } const s = createSessionStore(where()); s.set("a", 1); assert.equal(s.get("a"), 1);', full).join('\n')).toMatch(/argument 1 is a string/);
  });
});

describe('s5: the call-shape screen follows the import forms and the argument forms a draft can take', () => {
  const facts5 = factsOf('05-needs-mail', 'test/signup.test.js', 'src/signup.js');
  const has5 = (p: string) => ['src/signup.js', 'test/signup.test.js', 'package.json'].includes(p);
  const suite = cmd('suite', 'node --test', 'Existing tests still pass.');
  const check = (command: string, statement = 'send a welcome email') => {
    const k = cmd('welcome', command, 'A welcome email is sent when signup is called.', ['mail']);
    return contractQualityIssues(draftOf(statement, [k, suite], [{ id: 'mail', kind: 'smtp', criteria: ['welcome'], mockable: true }]), { statement, goal: g(statement), fileExists: has5, dependencies: [], testedApi: facts5.testedApi });
  };
  const script = (body: string) => `node --input-type=module -e 'import assert from "node:assert/strict"; ${body}'`;
  const REFUSED = /calls signup\("…"\): argument 1 is a string, the existing code takes an object/;

  it('signup(email) is refused through a namespace, a dynamic import, an alias and a wrapped or reassigned argument', () => {
    const forms = [
      'import * as m from "./src/signup.js"; const r = await m.signup("u@e.com"); assert.ok(r);',
      'const m = await import("./src/signup.js"); const r = await m.signup("u@e.com"); assert.ok(r);',
      'const m = await import("./src/signup.js"); const r = await m["signup"]("u@e.com"); assert.ok(r);',
      'const r = await (await import("./src/signup.js")).signup("u@e.com"); assert.ok(r);',
      'const m = await import("./src/signup.js"); const { signup: go } = m; const r = await go("u@e.com"); assert.ok(r);',
      'import { signup } from "./src/signup.js"; const r = await signup(String("u@e.com")); assert.ok(r);',
      'import { signup } from "./src/signup.js"; const mk = () => "u@e.com"; const r = await signup(mk()); assert.ok(r);',
      'import { signup } from "./src/signup.js"; let e; e = "u@e.com"; const r = await signup(e); assert.ok(r);',
      'import { signup } from "./src/signup.js"; const f = signup; const r = await f("u@e.com"); assert.ok(r);',
      'import { signup } from "./src/signup.js"; const r = await signup.call(null, "u@e.com"); assert.ok(r);',
    ];
    for (const body of forms) expect(check(script(body)).join('\n'), body).toMatch(REFUSED);
    // The same forms with the existing shape pass.
    for (const body of [
      'import * as m from "./src/signup.js"; const sent = []; await m.signup({ email: "u@e.com" }, { mailer: { send: async (x) => { sent.push(x); } } }); assert.equal(sent.length, 1);',
      'import { signup } from "./src/signup.js"; const f = signup; const user = { email: "u@e.com" }; const sent = []; await f(user, { mailer: { send: async (x) => { sent.push(x); } } }); assert.equal(sent.length, 1);',
    ]) expect(check(script(body)), body).toEqual([]);
  });

  it('a tested module imported in a form the host cannot follow is refused, and so is a script on standard input', () => {
    expect(check(script('const { ["signup"]: go } = await import("./src/signup.js"); const r = await go("u@e.com"); assert.ok(r);')).join('\n')).toMatch(/criterion welcome imports src\/signup\.js in a form the host cannot read the calls from; import the names it calls \(import \{ signup \} from "\.\/src\/signup\.js"\)/);
    const piped = `echo 'import assert from "node:assert/strict"; import { signup } from "./src/signup.js"; const r = await signup("u@e.com"); assert.ok(r);' | node --input-type=module`;
    expect(commandReadsScriptFromStdin(piped)).toBe(true);
    expect(check(piped).join('\n')).toMatch(/criterion welcome hands an interpreter its script on standard input/);
    expect(commandReadsScriptFromStdin("node --input-type=module <<'EOF'\nimport './src/signup.js';\nEOF")).toBe(true);
    expect(commandReadsScriptFromStdin('cat check.mjs | node -')).toBe(true);
    for (const fine of [script('assert.ok(1 << 2);'), 'node --test test/signup.test.js', 'node --test', 'node bin/report.js < data/sales.json', 'python3 -m pytest tests/test_a.py', 'node --test 2>&1 | tail -1']) expect(commandReadsScriptFromStdin(fine), fine).toBe(false);
  });

  it('only a request that says the function\'s inputs change lifts the screen', () => {
    const invented = script('import { signup } from "./src/signup.js"; const r = await signup("u@e.com"); assert.ok(r);');
    for (const statement of [
      'send a welcome email after signup. Do not change the validation',
      'send a welcome email on signup instead of doing nothing',
      'send a welcome email; do not change the arguments of signup',
      'send a welcome email. signup must not accept anything new',
    ]) {
      expect(asksToChange(statement, 'signup'), statement).toBe(false);
      expect(check(invented, statement).join('\n'), statement).toMatch(REFUSED);
    }
    for (const statement of [
      'send a welcome email: change signup to accept an email address string',
      'send a welcome email. `signup()` now takes the address alone',
      'send a welcome email and change the signature of signup',
      'rename signup to register and send a welcome email',
    ]) {
      expect(asksToChange(statement, 'signup'), statement).toBe(true);
      expect(check(invented, statement).join('\n'), statement).not.toMatch(REFUSED);
    }
  });
});

describe('s5: a negation or "try" elsewhere in the sentence does not let the tool into the code', () => {
  const facts5 = factsOf('05-needs-mail', 'test/signup.test.js', 'src/signup.js');
  const routes = [{ id: 'mail', kind: 'smtp', rung: 'mock' as const, tool: true }];
  const step = (instruction: string) => [{ id: 'implement', kind: 'worker', instruction }];
  const USES_TOOL = /^step implement has the code use the mail tool/;

  it('each instruction that has the code use the tool is refused, however the sentence is dressed', () => {
    for (const text of [
      'Without changing the validation, make signup in src/signup.js send a welcome email using the mail tool.',
      'Modify src/signup.js so signup sends a welcome email using the mail tool (no attachments).',
      'Modify src/signup.js to send the welcome email with the mail tool to check that new users are greeted.',
      'In src/signup.js, try to send the welcome email via the mail tool and return emailSent: true.',
      'In src/signup.js, send the welcome email via `mail.send` and return emailSent.',
      'In src/signup.js, call the send method of the tool named mail with {to, subject, body}.',
      'In src/signup.js, use the mailer tool `mail` to send the welcome email.',
      'Do not touch the tests, but have signup send the welcome email with the mail tool.',
    ]) {
      // With and without repository facts: the seam requirement is not what refuses these.
      expect(standInInstructionIssues(step(text), routes)[0], text).toMatch(USES_TOOL);
      expect(standInInstructionIssues(step(`${text} The fake in the criteria goes through deps.mailer.`), routes, facts5)[0], text).toMatch(USES_TOOL);
    }
  });

  it('a negation that governs the tool, or the worker\'s own use of it, still passes', () => {
    for (const ok of [
      'Send through deps.mailer.send(message). Do not call the mail tool from src/signup.js.',
      'In src/signup.js send through deps.mailer rather than the mail tool.',
      'Have signup call deps.mailer.send(); the mail tool is only for your own checks.',
      'Explore what the mail tool records, then have signup call deps.mailer.send().',
    ]) expect(standInInstructionIssues(step(ok), routes, facts5), ok).toEqual([]);
  });

  it('a plan for a stood-in capability that never names the seam the code declares is refused', () => {
    expect(standInInstructionIssues(step('Make signup in src/signup.js send a welcome email to the new user through the simulated mailbox.'), routes, facts5)).toEqual([
      'no step instruction names the repository\'s own seam for mail (deps.mailer of signup(user, deps = {}) in src/signup.js); say that the code reaches the capability through it, since the mail tool is not defined when the criteria run',
    ]);
    // Any worker step may name it; without a seam read from the code nothing is required.
    expect(standInInstructionIssues([...step('Read src/signup.js.'), { id: 'send', kind: 'worker', instruction: 'Send the welcome message through the injected mailer.' }], routes, facts5)).toEqual([]);
    expect(standInInstructionIssues(step('Make signup send a welcome email.'), routes)).toEqual([]);
    expect(standInInstructionIssues(step('Make signup send a welcome email.'), [{ id: 'mail', kind: 'smtp', rung: 'available', tool: false }], facts5)).toEqual([]);
  });
});

describe('s2: the sandbox screen reads nested shells and in-script waiting, and leaves plain data alone', () => {
  it('a background job, sleep and kill inside bash -lc, sh -ec or eval are refused', () => {
    for (const command of [
      'bash -lc "node server.js & sleep 1; node check.js; kill %1"',
      "sh -ec 'node server.js & sleep 1; node check.js; kill %1'",
      'bash --noprofile -o pipefail -c "node server.js & sleep 1; node check.js; kill %1"',
      'eval "node server.js & sleep 1; node check.js; kill %1"',
      'env A=1 bash -xc "bash -c \'node server.js & sleep 1; kill %1\'"',
    ]) expect(commandSandboxProblems(command), command).toEqual(['backgrounds a command (&)', 'uses sleep', 'uses kill']);
    expect(commandSandboxProblems('bash -lc "curl -fsS http://example.com"')).toEqual(['runs curl']);
  });

  it('waiting, detaching and an aliased fetch inside the script are refused', () => {
    const bad: Array<[string, RegExp]> = [
      [inline('import { createApp } from "./src/app.js"; await new Promise(r => setTimeout(r, 61000)); assert.ok(createApp());'), /waits on a timer/],
      [inline('import { setTimeout as wait } from "node:timers/promises"; import { createApp } from "./src/app.js"; await setTimeout(2_000); assert.ok(createApp());'), /waits on a timer/],
      [inline('import { spawn } from "node:child_process"; spawn("node", ["bin/server.js"], { detached: true }); await new Promise(r => setTimeout(r, 1000)); const f = globalThis["fetch"]; const r = await f(process.env.BASE); assert.equal(r.status, 200);'), /detaches a process, .*waits on a timer|waits on a timer, detaches a process/],
      [inline('const f = globalThis.fetch; assert.ok(await f(process.env.BASE));'), /calls fetch\(\)/],
      [inline('import { execSync } from "node:child_process"; execSync("sleep 2"); assert.ok(1);'), /uses sleep/],
      [inline('Bun.serve({ fetch() { return new Response("ok"); } }); assert.ok(1);'), /starts a server/],
    ];
    for (const [command, why] of bad) expect(commandSandboxProblems(command).join(', '), command).toMatch(why);
    expect(commandSandboxProblems(inline('const f = globalThis["fetch"]; assert.ok(f);'))).toContain('calls fetch()');
  });

  it('data that only looks like a network module, a short timer and |& are not refused', () => {
    for (const command of [
      inline('import { handle } from "./src/app.js"; assert.equal(handle({ scheme: "http", path: "/" }).status, 200);'),
      inline('import { handle } from "./src/app.js"; await new Promise(r => setTimeout(r, 5)); assert.equal(handle({ transport: "tls" }).status, 200);'),
      'node --test test/app.test.js 2>&1 |& tail -1',
    ]) expect(commandSandboxProblems(command), command).toEqual([]);
    expect(commandSandboxProblems(inline('import http from "node:http"; assert.ok(http);'))).toEqual(['imports a network module']);
    expect(commandSandboxProblems(inline('const net = require("net"); assert.ok(net);'))).toEqual(['imports a network module']);
  });

  it('a draft cannot lift the network screen by declaring an HTTP need of its own', () => {
    const statement = 'call the partner webhook';
    const needs = [{ id: 'api', kind: 'http-stub', criteria: ['calls-out'], mockable: true }];
    const ctx = { statement, goal: g(statement) };
    const outside = cmd('calls-out', inline('import { notify } from "./src/notify.js"; const r = await fetch("https://example.com/"); assert.equal(r.status, 200); assert.ok(notify);'), 'The webhook is called', ['api']);
    expect(contractQualityIssues(draftOf(statement, [outside, cmd('suite', 'node --test')], needs), ctx).join('\n')).toMatch(/criterion calls-out calls fetch\(\): the verify sandbox has no network/);
    // Reading the capability's location lifts the client check, never a URL written into the command.
    const both = cmd('calls-out', inline('import { notify } from "./src/notify.js"; await fetch(process.env.TECERA_RESOURCE_API + "/ping"); const r = await fetch("https://example.com/"); assert.equal(r.status, 200); assert.ok(notify);'), 'The webhook is called', ['api']);
    expect(contractQualityIssues(draftOf(statement, [both, cmd('suite', 'node --test')], needs), ctx).join('\n')).toMatch(/criterion calls-out reaches an address that is not the capability's/);
    const stub = cmd('calls-out', inline('import { notify } from "./src/notify.js"; await notify({ url: process.env.TECERA_RESOURCE_API }); const r = await fetch(process.env.TECERA_RESOURCE_API + "/calls"); assert.equal(r.status, 200);'), 'The webhook is called', ['api']);
    expect(contractQualityIssues(draftOf(statement, [stub, cmd('suite', 'node --test')], needs), ctx)).toEqual([]);
  });
});
