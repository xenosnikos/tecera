import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contractHash, parseManifest, type AcceptanceContract, type AchievementGoal, type Criterion, type Manifest, type PlanningContext } from '@tecera/contracts';
import { createPlanValidator } from './checks.js';
import { ContractRejected } from './contract.js';
import { FakeBeliefs, FakeLLM, adopted, goal, goodDoc, samplePermissions } from './fixtures.testkit.js';
import { LLMPlanner, type RejectedDraft } from './llmPlanner.js';
import { buildContractPrompt, buildPlannerPrompt } from './prompt.js';
import { commandImports, commandRunsFiles, contractQualityIssues, isNodeBuiltin, packageOf } from './quality.js';
import { dependencyNames, isTestPath, testedApiOf } from './repoFacts.js';
import { settlePlanDocument } from './scope.js';
import type { PlanDocument } from './schema.js';

/**
 * Second live rerun at the planner seat: write narrowing from a path the contract invented (D-C, new route),
 * criteria whose inline scripts spawn missing files or import packages nothing installs (D-D), drafts the
 * screen refused leaving no record, and a plan that is never told which tool stands in for a missing
 * capability (D-I). The bench fixtures' manifests and repositories are the inputs.
 */

const fixture = (scenario: string, rel: string) => new URL(`../../bench/fixtures/${scenario}/${rel}`, import.meta.url);
const manifestOf = (id: string): Manifest => parseManifest(JSON.parse(readFileSync(fixture(id, 'repo/tecera.json'), 'utf8')));
const permissions = samplePermissions();
const beliefs = new FakeBeliefs([]);
const caught = (pr: Promise<unknown>) => pr.then(() => null, (e: unknown) => e);

const cmd = (id: string, command: string, statement = id, requires?: string[]): Criterion => ({ id, statement, check: { kind: 'command', command, timeoutSec: 60 }, ...(requires ? { requires } : {}) });
const inline = (body: string) => `node --input-type=module -e 'import assert from "node:assert/strict"; ${body}'`;
const g = (statement: string): AchievementGoal => ({ ...goal, id: 'g-live2', statement, criteria: undefined, contractHash: undefined } as AchievementGoal);
const draftOf = (statement: string, criteria: Criterion[], needs: Array<{ id: string; kind: string; criteria: string[]; mockable: boolean }> = []) => ({
  contract: { goalId: 'g-live2', statement, criteria, outOfScope: [], assumptions: [] },
  needs,
});
type WireCriterion = { id: string; statement: string; command: string; requires?: string[] };
const wire = (criteria: WireCriterion[], needs: Array<{ id: string; kind: string; mockable: boolean | null }> = []) =>
  JSON.stringify({
    criteria: criteria.map((c) => ({ id: c.id, statement: c.statement, kind: 'command', command: c.command, timeoutSec: 60, prompt: null, requires: c.requires ?? [], tags: [] })),
    outOfScope: [],
    assumptions: [],
    needs,
  });

describe('D-C (new route): what the request or the contract names never narrows the write scope', () => {
  // The live s3 shape: the contract names src/cli.js (invented); the command is bin/report.js.
  const m3 = manifestOf('03-csv-export');
  const statement = 'add CSV export to the report command';
  const contract = { criteria: [cmd('csv', inline('import { spawnSync } from "node:child_process"; const r = spawnSync("node", ["src/cli.js", "--format", "csv"]); assert.equal(r.status, 0);'), 'node src/cli.js --format csv prints CSV')] };
  const doc = { ...goodDoc(), context: [] } as unknown as PlanDocument;

  it('a plan the model narrowed to src/** gets allowedChanges back, and its rationale is left as written', () => {
    expect(doc.permissions.write).toEqual(['src/**']);
    const out = settlePlanDocument(doc, { manifest: m3 });
    expect(out.permissions.write).toEqual(['src/**', 'bin/**']);
    expect(out.rationale).toBe(doc.rationale);
    // The document handed in is not changed.
    expect(doc.permissions.write).toEqual(['src/**']);
  });

  it('LLMPlanner settles the scope whatever the contract names, with or without a repository view', async () => {
    const ctxGoal = { ...g(statement), criteria: contract.criteria, contractHash: undefined } as unknown as AchievementGoal;
    const c: AcceptanceContract = { goalId: ctxGoal.id, statement, criteria: contract.criteria, outOfScope: [], assumptions: [] };
    const ctx: PlanningContext = { contract: c, contractHash: contractHash(c), inventory: [], allowance: m3.provisioning, provisionedSoFar: 0 };
    const doc2 = JSON.parse(JSON.stringify(goodDoc()));
    doc2.steps = doc2.steps.map((s: { id: string }) => (s.id === 'verify' || s.id === 'verify2' ? { ...s, inputs: { criteria: ['csv'] } } : s));
    for (const repoFiles of [(p: string) => p === 'src/report.js' || p === 'bin/report.js', undefined]) {
      const p = await new LLMPlanner({ llm: new FakeLLM([JSON.stringify(doc2)]), manifest: m3, permissions, nonce: () => 'n1', ...(repoFiles ? { repoFiles } : {}) }).write(adopted, beliefs, g(statement), undefined, ctx);
      expect(p.permissions.write).toEqual(['src/**', 'bin/**']);
      expect(p.rationale).toBe('read, edit, gates');
    }
  });
});

describe('D-D (remaining): inline scripts are screened for spawned files and imports', () => {
  it('commandRunsFiles names the script files an inline script spawns; commandImports names modules and packages', () => {
    const spawn = inline('import { spawnSync } from "node:child_process"; const r = spawnSync("node", ["src/cli.js", "--csv"]); assert.equal(r.status, 0);');
    expect(commandRunsFiles(spawn)).toEqual(['src/cli.js']);
    const imp = inline('import { parse } from "csv-parse/sync"; import Database from "better-sqlite3"; import { DatabaseSync } from "node:sqlite"; import { report } from "./src/report.js"; const m = await import("../x.js");');
    expect(commandImports(imp)).toEqual({ modules: ['src/report.js'], packages: ['node:assert/strict', 'csv-parse/sync', 'better-sqlite3', 'node:sqlite'] });
    // A path outside the repository (../x.js) names no repository module.
    // An imported module is not a file the criterion runs.
    expect(commandRunsFiles(imp)).toEqual([]);
    expect(packageOf('csv-parse/sync')).toBe('csv-parse');
    expect(packageOf('@scope/pkg/sub')).toBe('@scope/pkg');
    expect(isNodeBuiltin('node:sqlite')).toBe(true);
    expect(isNodeBuiltin('node:test')).toBe(true);
    expect(isNodeBuiltin('assert')).toBe(true);
    expect(isNodeBuiltin('node:assert/strict')).toBe(true);
    expect(isNodeBuiltin('better-sqlite3')).toBe(false);
  });

  const statement = 'persist sessions';
  const repo = new Set(['src/sessions.js', 'test/sessions.test.js', 'package.json']);
  const has = (p: string) => repo.has(p);
  const persist = (body: string) => cmd('survives', inline(`${body} const a = createSessionStore({ path: process.env.TECERA_RESOURCE_DB }); a.set("s", 1); a.close(); assert.equal(createSessionStore({ path: process.env.TECERA_RESOURCE_DB }).get("s"), 1);`), 'Sessions survive a restart', ['db']);
  const need = [{ id: 'db', kind: 'sqlite', criteria: ['survives'], mockable: true }];

  it('a package the repository does not install is refused with the reason; node built-ins and listed packages pass', () => {
    const ok = draftOf(statement, [persist('import { createSessionStore } from "./src/sessions.js"; import { DatabaseSync } from "node:sqlite";'), cmd('suite', 'node --test')], need);
    expect(contractQualityIssues(ok, { statement, goal: g(statement), fileExists: has, dependencies: [] })).toEqual([]);
    for (const [pkg, body] of [['better-sqlite3', 'import Database from "better-sqlite3";'], ['csv-parse', 'import { parse } from "csv-parse/sync";']] as const) {
      const bad = draftOf(statement, [persist(`import { createSessionStore } from "./src/sessions.js"; ${body}`), cmd('suite', 'node --test')], need);
      expect(contractQualityIssues(bad, { statement, goal: g(statement), fileExists: has, dependencies: [] }).join('\n')).toContain(`criterion survives imports package ${pkg}, which the repository does not install (installed: none)`);
      // A package the repository lists is fine; without the dependency list nothing is checked.
      expect(contractQualityIssues(bad, { statement, goal: g(statement), fileExists: has, dependencies: [pkg] })).toEqual([]);
      expect(contractQualityIssues(bad, { statement, goal: g(statement), fileExists: has })).toEqual([]);
    }
  });

  it('an inline script that spawns a missing file, or imports a module the repository lacks and the request does not name, is refused', () => {
    const spawn = draftOf(statement, [persist('import { createSessionStore } from "./src/sessions.js"; import { spawnSync } from "node:child_process"; spawnSync("node", ["src/cli.js"]);'), cmd('suite', 'node --test')], need);
    expect(contractQualityIssues(spawn, { statement, goal: g(statement), fileExists: has, dependencies: [] }).join('\n')).toMatch(/criterion survives runs src\/cli\.js, which is not in the repository/);
    const invented = draftOf(statement, [persist('import { createSessionStore } from "./src/sessionDb.js";'), cmd('suite', 'node --test')], need);
    expect(contractQualityIssues(invented, { statement, goal: g(statement), fileExists: has, dependencies: [] }).join('\n')).toMatch(/criterion survives imports src\/sessionDb\.js, which is not in the repository and the request does not name it/);
    // A module the request names is new code the work adds: allowed.
    const named = 'persist sessions in src/sessionDb.js';
    expect(contractQualityIssues(invented, { statement: named, goal: g(named), fileExists: has, dependencies: [] })).toEqual([]);
  });

  it('the drafting prompt states the runtime, the installed packages, the resource variable and the API the tests use', () => {
    const files = [
      { path: 'test/sessions.test.js', text: "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createSessionStore } from '../src/sessions.js';\n" },
      { path: 'test/other.test.js', text: "const { a, b: c } = require('../src/util.js');\nimport def, { x as y } from './helper.js';" },
    ];
    expect(testedApiOf(files)).toEqual([
      { module: 'src/sessions.js', names: ['createSessionStore'], tests: ['test/sessions.test.js'], calls: [] },
      { module: 'src/util.js', names: ['a', 'b'], tests: ['test/other.test.js'], calls: [] },
      { module: 'test/helper.js', names: ['default', 'x'], tests: ['test/other.test.js'], calls: [] },
    ]);
    expect(dependencyNames(readFileSync(fixture('04-needs-db', 'repo/package.json'), 'utf8'))).toEqual([]);
    expect(dependencyNames('{"dependencies":{"csv-parse":"^5"},"devDependencies":{"@x/y":"1"}}')).toEqual(['@x/y', 'csv-parse']);
    expect(dependencyNames('not json')).toEqual([]);
    expect(isTestPath('test/a.js')).toBe(true);
    expect(isTestPath('src/a.spec.ts')).toBe(true);
    expect(isTestPath('src/a.js')).toBe(false);
    const m4 = manifestOf('04-needs-db');
    const sys = buildContractPrompt({ manifest: m4, goal: g(statement), statement, repo: { dependencies: [], testedApi: testedApiOf(files.slice(0, 1)) }, nonce: 'n' })[0]!.content as string;
    expect(sys).toMatch(/Node 22[\s\S]*`node:sqlite` \(DatabaseSync\)/);
    expect(sys).toContain('Packages the repository installs (package.json): none.');
    expect(sys).toContain('`TECERA_RESOURCE_DB` for `db`');
    expect(sys).toMatch(/`src\/sessions\.js`: `createSessionStore` \(used by test\/sessions\.test\.js\)/);
  });

  it('LLMPlanner refuses a draft importing an uninstalled package and records every refused draft (onDraftRejected)', async () => {
    const m4 = manifestOf('04-needs-db');
    const answer = wire(
      [
        { id: 'survives', statement: 'Sessions survive a restart', command: inline('import Database from "better-sqlite3"; import { createSessionStore } from "./src/sessions.js"; assert.ok(new Database(process.env.TECERA_RESOURCE_DB) && createSessionStore);'), requires: ['db'] },
        { id: 'suite', statement: 'existing tests pass', command: 'node --test' },
      ],
      [{ id: 'db', kind: 'sqlite', mockable: true }],
    );
    const records: RejectedDraft[] = [];
    const planner = new LLMPlanner({ llm: new FakeLLM([answer, answer]), manifest: m4, permissions, nonce: () => 'n', repoFiles: has, repoFacts: () => ({ dependencies: [], testedApi: [] }), onDraftRejected: (r) => void records.push(r) });
    const err = (await caught(planner.draftContract(statement, g(statement), []))) as ContractRejected;
    expect(err).toBeInstanceOf(ContractRejected);
    expect(err.issues.join('\n')).toMatch(/imports package better-sqlite3, which the repository does not install/);
    expect(records.map((r) => [r.goalId, r.attempt])).toEqual([['g-live2', 1], ['g-live2', 2]]);
    expect(records[0]!.issues.join('\n')).toMatch(/better-sqlite3/);
    expect((records[0]!.contract as { criteria: Array<{ id: string }> }).criteria.map((k) => k.id)).toEqual(['survives', 'suite']);
    // An answer that does not parse is recorded too, with no contract.
    const junk: RejectedDraft[] = [];
    await caught(new LLMPlanner({ llm: new FakeLLM(['not json', 'not json']), manifest: m4, permissions, nonce: () => 'n', onDraftRejected: (r) => void junk.push(r) }).draftContract(statement, g(statement), []));
    expect(junk.map((r) => r.contract)).toEqual([null, null]);
    // A record that cannot be written aborts the call (never a silent loss).
    const failing = new LLMPlanner({ llm: new FakeLLM([answer, answer]), manifest: m4, permissions, nonce: () => 'n', repoFacts: { dependencies: [], testedApi: [] }, onDraftRejected: () => { throw new Error('ledger down'); } });
    expect(String(await caught(failing.draftContract(statement, g(statement), [])))).toMatch(/rejected draft record failed: ledger down/);
  });
});

describe('D-I at the planner: the plan is told which tool stands in for a missing capability', () => {
  const m5 = manifestOf('05-needs-mail');
  const statement = 'send a welcome email';
  const c: AcceptanceContract = { goalId: 'g-live2', statement, criteria: [cmd('welcome', inline('import { signup } from "./src/signup.js"; assert.ok(signup);'), 'signing up sends a welcome email', ['mail']), cmd('suite', 'node --test')], outOfScope: [], assumptions: [] };
  const ctx: PlanningContext = { contract: c, contractHash: contractHash(c), inventory: [{ id: 'mail', kind: 'smtp', state: 'missing' }], allowance: m5.provisioning, provisionedSoFar: 0 };

  it('the prompt names the stand-in tool per missing capability and the catalog includes it', () => {
    const [sys] = buildPlannerPrompt({ manifest: m5, goal: g(statement), event: adopted, beliefs: [], permissions, toolCatalog: ['read', 'edit', 'listFiles', 'runVerify', 'mail'], planning: ctx, nonce: 'n' });
    expect(sys!.content).toMatch(/`mail` \(smtp\) is missing: worker tool `mail` is a simulated stand-in \(send\(message\), outbox\(\)\)/);
    expect(sys!.content).toMatch(/list it in `permissions.tools` and in `tools` of every worker step that changes files and uses it/);
    const prov: PlanningContext = { ...ctx, inventory: [{ id: 'mail', kind: 'smtp', state: 'missing' }, { id: 'db', kind: 'sqlite', state: 'provisioned', resourceId: 'r1' }], contract: { ...c, criteria: [...c.criteria, cmd('db', 'node x.js', 'db', ['db'])] } };
    const [s2] = buildPlannerPrompt({ manifest: m5, goal: g(statement), event: adopted, beliefs: [], permissions, planning: prov, nonce: 'n' });
    expect(s2!.content).toMatch(/`db` \(sqlite\) is provisioned by Tecera: worker tool `db` reaches it; the code under test and the criteria read its location from `TECERA_RESOURCE_DB`/);
  });

  it('a plan listing the stand-in tool on its writing step passes the planner and the host validator', async () => {
    const d = goodDoc() as unknown as { steps: Array<Record<string, unknown>>; permissions: { tools: string[] } } & Record<string, unknown>;
    d.steps = d.steps.map((s) => (s['id'] === 'edit' ? { ...s, tools: ['read', 'edit', 'mail'] } : s['kind'] === 'gate.verify' ? { ...s, inputs: { criteria: ['welcome', 'suite'] } } : s));
    d.permissions.tools = [...d.permissions.tools, 'mail'];
    const llm = new FakeLLM([JSON.stringify({ ...d, capabilities: ['mail'] })]);
    const plan = await new LLMPlanner({ llm, manifest: m5, permissions, toolCatalog: ['read', 'edit', 'listFiles', 'runVerify'], nonce: () => 'n' }).write(adopted, beliefs, g(statement), undefined, ctx);
    expect(plan.permissions.tools).toContain('mail');
    expect(plan.capabilities).toEqual(['mail']);
    expect(llm.requests[0]!.messages[0]!.content).toMatch(/Tool catalog \(`permissions.tools` must be a subset\): `read`, `edit`, `listFiles`, `runVerify`, `mail`/);
    expect(createPlanValidator({ permissions, toolCatalog: ['read', 'edit', 'listFiles', 'runVerify', 'mail'] }).validatePlan(plan, m5, g(statement), ctx)).toEqual([]);
  });
});
