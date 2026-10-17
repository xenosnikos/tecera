import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseManifest, type AchievementGoal, type ChangePath, type ContractDraft, type Criterion, type Manifest } from '@tecera/contracts';
import { ContractRejected } from './contract.js';
import { FakeBeliefs, FakeLLM, adopted, goal, goodDoc, sampleManifest, samplePermissions } from './fixtures.testkit.js';
import { settlePlanDocument } from './scope.js';
import { parsePlanOutput } from './parse.js';
import { LLMPlanner } from './llmPlanner.js';
import { buildContractPrompt, buildPlannerPrompt } from './prompt.js';
import { contractQualityIssues, type QualityContext } from './quality.js';
import { assertionsOf, entryPointsOf, spawnedByTests, testedApiOf, type RepoFacts } from './repoFacts.js';

/**
 * Fifth live run at the drafting seat: contracts that contradicted what the repository's tests assert about
 * returned handlers and absent values (s2, s4), an interface documented only in a comment (s5), an envelope
 * without the command the request is about (s3), and an expected value guessed against the standard (s3).
 * The bench fixtures' repositories are the inputs; the host's facts are read the way repositoryFacts reads them.
 */

const fixture = (scenario: string, rel: string) => new URL(`../../bench/fixtures/${scenario}/${rel}`, import.meta.url);
const manifestOf = (id: string): Manifest => parseManifest(JSON.parse(readFileSync(fixture(id, 'repo/tecera.json'), 'utf8')));
const read = (scenario: string, path: string) => ({ path, text: readFileSync(fixture(scenario, `repo/${path}`), 'utf8') });

/** The facts of a fixture repository: its tests, the modules they import, its commands. */
function factsOf(scenario: string): RepoFacts {
  const tests = readdirSync(fixture(scenario, 'repo/test')).map((f) => read(scenario, `test/${f}`));
  const sources = testedApiOf(tests).map((t) => read(scenario, t.module));
  let bins: string[] = [];
  try {
    bins = readdirSync(fixture(scenario, 'repo/bin')).map((f) => `bin/${f}`);
  } catch {
    bins = [];
  }
  const entries = [...new Set([...bins, ...spawnedByTests(tests)])].map((p) => read(scenario, p));
  return { dependencies: [], testedApi: testedApiOf(tests, sources), assertions: assertionsOf(tests), entryPoints: entryPointsOf(entries) };
}

const inline = (body: string) => `node --input-type=module -e 'import assert from "node:assert/strict"; ${body}'`;
const cmd = (id: string, command: string, statement = id, requires?: string[]): Criterion => ({ id, statement, check: { kind: 'command', command, timeoutSec: 60 }, ...(requires ? { requires } : {}) });
const g = (statement: string): AchievementGoal => ({ ...goal, id: 'g-live5', statement, criteria: undefined, contractHash: undefined } as AchievementGoal);
const draftOf = (statement: string, criteria: Criterion[], o: { assumptions?: string[]; envelope?: ChangePath[]; needs?: ContractDraft['needs'] } = {}): ContractDraft => ({
  contract: { goalId: 'g-live5', statement, criteria, outOfScope: [], assumptions: o.assumptions ?? [], ...(o.envelope ? { envelope: o.envelope } : {}) },
  needs: o.needs ?? [],
});
const ctxOf = (statement: string, facts: RepoFacts, m: Manifest): QualityContext => ({
  statement,
  goal: g(statement),
  verifyCommand: m.verify.command,
  connections: m.connections,
  dependencies: facts.dependencies,
  testedApi: facts.testedApi,
  ...(facts.assertions ? { assertions: facts.assertions } : {}),
  ...(facts.entryPoints ? { entryPoints: facts.entryPoints } : {}),
  allowedChanges: m.repo.allowedChanges,
});
const suite = cmd('existing-tests-pass', 'node --test');

describe('the host reads what a returned handler is given and gives back, exact asserted values, documented shapes and commands', () => {
  it('s2: the handler createApp returns is called with { ip, path } and read through .status and .body; the comment documents rateLimit ({ limit, windowMs })', () => {
    const f = factsOf('02-api-no-limits');
    const call = f.testedApi[0]!.calls.find((c) => c.name === 'createApp')!;
    expect(call).toMatchObject({ resultCalled: true, resultArgKeys: [['ip', 'path']], resultProps: ['body', 'status'] });
    expect(f.testedApi[0]!.shapes).toEqual([{ name: 'rateLimit', keys: ['limit', 'windowMs'] }]);
    expect(f.assertions).toEqual(expect.arrayContaining([{ actual: "app({ip:'a',path:'/health'}).status", value: '200', test: 'test/app.test.js' }]));
  });

  it('s4: get after delete is asserted undefined (not null); s5: the comment documents send({ to, subject, text }); s3: bin/report.js imports src/report.js', () => {
    expect(factsOf('04-needs-db').assertions).toEqual([{ actual: "s.get('a')", value: 'undefined', callee: 'get', test: 'test/sessions.test.js' }]);
    const f5 = factsOf('05-needs-mail');
    expect(f5.testedApi[0]!.shapes).toEqual([{ name: 'send', keys: ['to', 'subject', 'text'] }]);
    expect(f5.testedApi[0]!.documented!.join(' ')).toMatch(/send\(\{ to, subject, text \}\)/);
    expect(factsOf('03-csv-export').entryPoints).toEqual([{ path: 'bin/report.js', imports: ['src/report.js'], documented: [expect.stringMatching(/report \[--format text\]/)] }]);
  });

  it('the drafting prompt states them as facts to keep, the comments as untrusted data, and where expected values come from', () => {
    const text = (id: string, statement: string) =>
      buildContractPrompt({ manifest: manifestOf(id), goal: g(statement), statement, inventory: [], nonce: 'n5n5n5', repo: factsOf(id) })
        .map((x) => x.content)
        .join('\n');
    const s2 = text('02-api-no-limits', 'add rate limiting');
    expect(s2).toContain('and call what it returns as a function with `{ ip, path }`, reading `.body`, `.status` on its result');
    expect(s2).toMatch(/<untrusted src="comments:src\/app\.js"[^>]*nonce="n5n5n5">\n[^<]*rateLimit \(\{ limit, windowMs \}\)/);
    expect(text('04-needs-db', 'persist sessions')).toContain("`s.get('a')` is `undefined` (test/sessions.test.js)");
    const s3 = text('03-csv-export', 'add CSV export to the report command');
    expect(s3).toContain('`bin/report.js` imports `src/report.js`');
    expect(s3).toMatch(/RFC 4180 .* doubles a quote inside it/);
    expect(s3).toMatch(/When the request is about a command, the command file is in the envelope/);
  });
});

describe('drafts that contradict them are refused; the corrected drafts pass', () => {
  it('s2: a handler called with invented keys, or read through invented properties, and an invented rateLimit key', () => {
    const m = manifestOf('02-api-no-limits');
    const f = factsOf('02-api-no-limits');
    const st = 'add rate limiting';
    const live = cmd('limit-429', inline(`import { createApp } from "./src/app.js"; const app = createApp({ rateLimit: { max: 1, windowMs: 1000 }, now: () => 0 }); await app({ method: "GET", url: "/items", headers: {} }); const r = await app({ method: "GET", url: "/items", headers: {} }); assert.equal(r.statusCode, 429);`));
    const issues = contractQualityIssues(draftOf(st, [live, suite]), ctxOf(st, f, m)).join('\n');
    expect(issues).toMatch(/calls what createApp returns with \{ method, url, headers \}; the existing tests call it with \{ ip, path \}/);
    expect(issues).toMatch(/gives rateLimit \{ max \}, which src\/app\.js documents as rateLimit\(\{ limit, windowMs \}\)/);
    const props = cmd('limit-429', inline(`import { createApp } from "./src/app.js"; const app = createApp({ rateLimit: { limit: 1, windowMs: 1000 }, now: () => 0 }); app({ ip: "a", path: "/items" }); const r = app({ ip: "a", path: "/items" }); assert.equal(r.statusCode, 429);`));
    expect(contractQualityIssues(draftOf(st, [props, suite]), ctxOf(st, f, m)).join('\n')).toMatch(/reads \.statusCode on what the handler from createApp returns; the existing tests read \.body, \.status/);
    const good = cmd('limit-429', inline(`import { createApp } from "./src/app.js"; const app = createApp({ rateLimit: { limit: 1, windowMs: 1000 }, now: () => 0 }); app({ ip: "a", path: "/items" }); const r = app({ ip: "a", path: "/items" }); assert.equal(r.status, 429);`));
    expect(contractQualityIssues(draftOf(st, [good, suite]), ctxOf(st, f, m))).toEqual([]);
  });

  it('s4: get after delete asserted null where the existing test asserts undefined', () => {
    const m = manifestOf('04-needs-db');
    const f = factsOf('04-needs-db');
    const st = 'persist sessions';
    const needs = [{ id: 'db', kind: 'sqlite', criteria: ['sessions-persist', 'sessions-delete'], mockable: true }];
    const persist = cmd('sessions-persist', inline('import { createSessionStore } from "./src/sessions.js"; const p = process.env.TECERA_RESOURCE_DB; const a = createSessionStore({ path: p }); a.set("x", { u: 1 }); a.close(); const b = createSessionStore({ path: p }); assert.deepEqual(b.get("x"), { u: 1 }); b.close();'), 'sessions survive a restart', ['db']);
    const del = (value: string) => cmd('sessions-delete', inline(`import { createSessionStore } from "./src/sessions.js"; const p = process.env.TECERA_RESOURCE_DB; const a = createSessionStore({ path: p }); a.set("y", { u: 1 }); a.delete("y"); a.close(); const b = createSessionStore({ path: p }); assert.equal(b.get("y"), ${value}); b.close();`), 'a deleted session stays deleted after a restart', ['db']);
    expect(contractQualityIssues(draftOf(st, [persist, del('null'), suite], { needs }), ctxOf(st, f, m)).join('\n')).toMatch(/expects \.get\(…\) to give null; test\/sessions\.test\.js asserts undefined/);
    expect(contractQualityIssues(draftOf(st, [persist, del('undefined'), suite], { needs }), ctxOf(st, f, m))).toEqual([]);
  });

  it('s5: an assumption or a criterion that gives the documented send() other keys', () => {
    const m = manifestOf('05-needs-mail');
    const f = factsOf('05-needs-mail');
    const st = 'send a welcome email';
    const needs = [{ id: 'mail', kind: 'smtp', criteria: ['welcome-sent'], mockable: true }];
    const sent = (fields: string) => cmd('welcome-sent', inline(`import { signup } from "./src/signup.js"; const sent = []; await signup({ email: "a@b.c" }, { mailer: { send: async (m) => { sent.push(m); } } }); assert.equal(sent.length, 1); assert.deepEqual(Object.keys(sent[0]).sort(), ${fields});`), 'a welcome email is sent on signup', ['mail']);
    const live = draftOf(st, [sent('["subject","text","to"]'), suite], { needs, assumptions: ['deps.mailer.send accepts {to, body}'] });
    expect(contractQualityIssues(live, ctxOf(st, f, m)).join('\n')).toMatch(/assumption 1 gives send \{ body \}, which src\/signup\.js documents as send\(\{ to, subject, text \}\)/);
    const inScript = cmd('welcome-sent', inline('import { signup } from "./src/signup.js"; const sent = []; const mailer = { send: async (m) => { sent.push(m); } }; await signup({ email: "a@b.c" }, { mailer }); await mailer.send({ to: "x", body: "y" }); assert.equal(sent.length, 2);'), 'a welcome email is sent on signup', ['mail']);
    expect(contractQualityIssues(draftOf(st, [inScript, suite], { needs }), ctxOf(st, f, m)).join('\n')).toMatch(/criterion welcome-sent gives send \{ body \}/);
    expect(contractQualityIssues(draftOf(st, [sent('["subject","text","to"]'), suite], { needs, assumptions: ['deps.mailer.send accepts { to, subject, text }'] }), ctxOf(st, f, m))).toEqual([]);
  });

  it('s3: an envelope without the command the request is about; and an expected value that contradicts the existing assertion for the same call', () => {
    const m = manifestOf('03-csv-export');
    const f = factsOf('03-csv-export');
    const st = 'add CSV export to the report command';
    const csv = cmd('csv-header', inline('import { spawnSync } from "node:child_process"; const r = spawnSync(process.execPath, ["bin/report.js", "--format", "csv"], { encoding: "utf8" }); assert.equal(r.status, 0); assert.equal(r.stdout.split("\\n")[0], "region,total");'));
    const lib = [{ path: 'src/report.js', ops: ['modify' as const] }];
    expect(contractQualityIssues(draftOf(st, [csv, suite], { envelope: lib }), ctxOf(st, f, m)).join('\n')).toMatch(/the request is about a command, but the envelope does not list bin\/report\.js \(the command it names\); add bin\/report\.js with modify/);
    const both = [...lib, { path: 'bin/report.js', ops: ['modify' as const] }];
    expect(contractQualityIssues(draftOf(st, [csv, suite], { envelope: both }), ctxOf(st, f, m))).toEqual([]);
    // a request that is not about a command asks for no command file
    expect(contractQualityIssues(draftOf('add a CSV formatter function', [cmd('csv-fn', inline('import { formatCsv } from "./src/report.js"; assert.equal(formatCsv([]), "region,total\\n");')), suite], { envelope: lib }), ctxOf('add a CSV formatter function', f, m)).join('\n')).not.toMatch(/about a command/);
    // the same call the existing test asserts, with another expected value
    const text = cmd('text-unchanged', inline('import { formatText } from "./src/report.js"; assert.equal(formatText([{ region: "a", total: 2 }]), "a 2.00\\n");'));
    expect(contractQualityIssues(draftOf(st, [csv, text, suite], { envelope: both }), ctxOf(st, f, m)).join('\n')).toMatch(/criterion text-unchanged expects formatText\(\[\{region:"a",total:2\}\]\) to be "a 2\.00\\n"; test\/report\.test\.js asserts/);
  });

  it('end to end: the planner refuses the s3 draft without the command file and accepts the redraft that lists it', async () => {
    const m = manifestOf('03-csv-export');
    const f = factsOf('03-csv-export');
    const st = 'add CSV export to the report command';
    const wire = (envelope: ChangePath[]) =>
      JSON.stringify({
        criteria: [
          { id: 'csv-header', statement: 'the csv report starts with region,total', kind: 'command', command: inline('import { spawnSync } from "node:child_process"; const r = spawnSync(process.execPath, ["bin/report.js", "--format", "csv"], { encoding: "utf8" }); assert.equal(r.status, 0); assert.equal(r.stdout.split("\\n")[0], "region,total");'), timeoutSec: 60, prompt: null, requires: [], tags: [] },
          { id: 'existing-tests-pass', statement: 'the existing tests pass', kind: 'command', command: 'node --test', timeoutSec: 60, prompt: null, requires: [], tags: [] },
        ],
        outOfScope: [],
        assumptions: [],
        envelope,
        needs: [],
      });
    const has = (p: string) => ['src/report.js', 'bin/report.js', 'test/report.test.js', 'package.json', 'data/sales.json'].includes(p);
    const lib = [{ path: 'src/report.js', ops: ['modify' as const] }];
    const both = [...lib, { path: 'bin/report.js', ops: ['modify' as const] }];
    const planner = (answers: string[]) => new LLMPlanner({ llm: new FakeLLM(answers), manifest: m, permissions: samplePermissions(), nonce: () => 'n5n5n5', repoFiles: has, repoFacts: f });
    const err = (await planner([wire(lib), wire(lib)]).draftContract(st, g(st), []).then(() => null, (e: unknown) => e)) as ContractRejected;
    expect(err).toBeInstanceOf(ContractRejected);
    expect(err.issues.join('\n')).toMatch(/does not list bin\/report\.js/);
    const d = await planner([wire(lib), wire(both)]).draftContract(st, g(st), []);
    expect(d.contract.envelope).toEqual([{ path: 'bin/report.js', ops: ['modify'] }, { path: 'src/report.js', ops: ['modify'] }]);
  });
});

describe('a step that edits files may run the tests', () => {
  const doc = () => {
    const r = parsePlanOutput(JSON.stringify({ ...goodDoc(), steps: goodDoc().steps.map((x) => (x.id === 'edit' ? { ...x, tools: ['read', 'edit'] } : x)), permissions: { ...goodDoc().permissions, tools: ['read', 'listFiles', 'edit'] } }));
    if (!r.ok) throw new Error(r.issues.join('; '));
    return r.plan;
  };

  it('settling the plan adds runVerify to every writing step and to the plan, never to a read step, and only when the host wires it', () => {
    const out = settlePlanDocument(doc(), { manifest: sampleManifest() });
    expect(out.steps.find((x) => x.id === 'edit')!.tools).toEqual(['read', 'edit', 'runVerify']);
    expect(out.steps.find((x) => x.id === 'analyze')!.tools).toEqual(['read', 'listFiles', 'runVerify']);
    expect(out.permissions.tools).toContain('runVerify');
    const without = settlePlanDocument(doc(), { manifest: sampleManifest(), toolCatalog: ['read', 'listFiles', 'edit'] });
    expect(without.steps.find((x) => x.id === 'edit')!.tools).toEqual(['read', 'edit']);
    expect(without.permissions.tools).not.toContain('runVerify');
  });

  it('a generated plan whose editing step lists no runVerify gets it', async () => {
    const raw = { ...goodDoc(), steps: goodDoc().steps.map((x) => (x.id === 'edit' ? { ...x, tools: ['read', 'edit'] } : x)) };
    const p = await new LLMPlanner({ llm: new FakeLLM([JSON.stringify(raw)]), manifest: sampleManifest(), permissions: samplePermissions(), nonce: () => 'n5n5n5' }).write(adopted, new FakeBeliefs([]), goal);
    expect(p.steps.find((x) => x.id === 'edit')!.tools).toEqual(['read', 'edit', 'runVerify']);
  });
});

describe('every writing step carries a keep-list, and the plan prompt renders the asserted values and documented interfaces', () => {
  const doc = (over: Partial<{ inputs: Record<string, unknown>; changes: ChangePath[] }> = {}) => {
    const r = parsePlanOutput(JSON.stringify({ ...goodDoc(), steps: goodDoc().steps.map((x) => (x.id === 'edit' ? { ...x, tools: ['read', 'edit'], ...over } : x)), permissions: { ...goodDoc().permissions, tools: ['read', 'listFiles', 'edit'], write: ['src/**', 'bin/**'] } }));
    if (!r.ok) throw new Error(r.issues.join('; '));
    return r.plan;
  };

  it('the host builds the keep-list from the tested modules the step may change: exports, call shapes, asserted values, documented lines; a read step gets none', () => {
    const out = settlePlanDocument(doc(), { manifest: manifestOf('03-csv-export'), repo: factsOf('03-csv-export') });
    const keep = out.steps.find((x) => x.id === 'edit')!.inputs['keep'] as string[];
    expect(keep).toContain('src/report.js exports `formatText`, `summarize` (used by test/report.test.js)');
    expect(keep).toEqual(expect.arrayContaining([expect.stringMatching(/^src\/report\.js: `summarize` .*called as `summarize\(\[…\]\)`/), expect.stringMatching(/^`formatText\(\[\{region:'a',total:2\}\]\)` is `'a {22}2\.00\\n'` \(test\/report\.test\.js\)$/)]));
    expect(out.steps.find((x) => x.id === 'analyze')!.inputs).not.toHaveProperty('keep');
    // s5: the documented send({ to, subject, text }) is kept
    const mail = settlePlanDocument(doc(), { manifest: manifestOf('05-needs-mail'), repo: factsOf('05-needs-mail') });
    expect((mail.steps.find((x) => x.id === 'edit')!.inputs['keep'] as string[]).join('\n')).toMatch(/src\/signup\.js documents: .*send\(\{ to, subject, text \}\)/);
  });

  it("the model's own entries come first; declared changes narrow the host's entries to the modules they cover; without facts the model's list stands alone", () => {
    const own = settlePlanDocument(doc({ inputs: { keep: ['the text report format'], other: 1 } }), { manifest: manifestOf('03-csv-export'), repo: factsOf('03-csv-export') });
    const keep = own.steps.find((x) => x.id === 'edit')!.inputs['keep'] as string[];
    expect(keep[0]).toBe('the text report format');
    expect(keep.length).toBeGreaterThan(1);
    expect(own.steps.find((x) => x.id === 'edit')!.inputs['other']).toBe(1);
    const bin = settlePlanDocument(doc({ changes: [{ path: 'bin/report.js', ops: ['modify'] }] }), { manifest: manifestOf('03-csv-export'), repo: factsOf('03-csv-export') });
    expect((bin.steps.find((x) => x.id === 'edit')!.inputs['keep'] as string[]).filter((k) => k.includes('src/report.js'))).toEqual([]);
    const none = settlePlanDocument(doc({ inputs: { keep: ['x', 3, ''] } }), { manifest: manifestOf('03-csv-export') });
    expect(none.steps.find((x) => x.id === 'edit')!.inputs['keep']).toEqual(['x']);
    expect(settlePlanDocument(doc(), { manifest: manifestOf('03-csv-export') }).steps.find((x) => x.id === 'edit')!.inputs['keep']).toEqual([]);
  });

  it("the model's entries cannot crowd the repository's facts out: own entries are capped, room is kept for the asserted values, and what was dropped is reported", () => {
    const verbose = Array.from({ length: 40 }, (_, i) => `item ${i}`);
    const out = settlePlanDocument(doc({ inputs: { keep: verbose } }), { manifest: manifestOf('03-csv-export'), repo: factsOf('03-csv-export') });
    const step = out.steps.find((x) => x.id === 'edit')!;
    const keep = step.inputs['keep'] as string[];
    expect(keep.length).toBeLessThanOrEqual(40);
    expect(keep.slice(0, 12)).toEqual(verbose.slice(0, 12));
    expect(keep.filter((k) => k.startsWith('item '))).toHaveLength(12);
    expect(keep).toContain('src/report.js exports `formatText`, `summarize` (used by test/report.test.js)');
    expect(keep.some((k) => /^`formatText\(.*\)` is `.*` \(test\/report\.test\.js\)$/.test(k))).toBe(true);
    expect(step.inputs['keepDropped']).toMatchObject({ own: 28 });
    // a long entry is clipped; a step within the bounds reports nothing dropped
    const long = settlePlanDocument(doc({ inputs: { keep: ['x'.repeat(400)] } }), { manifest: manifestOf('03-csv-export') });
    expect((long.steps.find((x) => x.id === 'edit')!.inputs['keep'] as string[])[0]).toHaveLength(300);
    expect(long.steps.find((x) => x.id === 'edit')!.inputs).not.toHaveProperty('keepDropped');
    expect(settlePlanDocument(doc(), { manifest: manifestOf('03-csv-export'), repo: factsOf('03-csv-export') }).steps.find((x) => x.id === 'edit')!.inputs).not.toHaveProperty('keepDropped');
  });

  it('a generated plan reaches the loop with the keep-list on its writing step', async () => {
    const raw = { ...goodDoc(), steps: goodDoc().steps.map((x) => (x.id === 'edit' ? { ...x, tools: ['read', 'edit'] } : x)) };
    const p = await new LLMPlanner({ llm: new FakeLLM([JSON.stringify(raw)]), manifest: sampleManifest(), permissions: samplePermissions(), nonce: () => 'n5n5n5', repoFacts: factsOf('03-csv-export') }).write(adopted, new FakeBeliefs([]), goal);
    const keep = p.steps.find((x) => x.id === 'edit')!.inputs['keep'] as string[];
    expect(keep.some((k) => k.startsWith('src/report.js exports'))).toBe(true);
  });

  it('the plan prompt states the asserted values as facts, the documented interfaces as untrusted data, and the keep-list rule', () => {
    const text = (id: string) => buildPlannerPrompt({ manifest: manifestOf(id), goal: g('change it'), event: adopted, beliefs: [], permissions: samplePermissions(), nonce: 'n5n5n5', repo: factsOf(id) })[0]!.content;
    expect(text('04-needs-db')).toContain("`s.get('a')` is `undefined` (test/sessions.test.js)");
    expect(text('04-needs-db')).toMatch(/Exact values the existing tests assert \(they stay true after the change/);
    expect(text('05-needs-mail')).toMatch(/<untrusted src="comments:src\/signup\.js"[^>]*nonce="n5n5n5">\n[^<]*send\(\{ to, subject, text \}\)/);
    expect(text('03-csv-export')).toMatch(/Every writing step carries a keep-list: its `inputsJson` holds `"keep": \["…", …\]`/);
  });

  it("the drafting prompt says a name the request leaves open takes the repository's spelling, case included", () => {
    const id = '03-csv-export';
    const statement = 'add CSV export to the report command';
    const text = buildContractPrompt({ manifest: manifestOf(id), goal: g(statement), statement, inventory: [], nonce: 'n5n5n5', repo: factsOf(id) })[0]!.content;
    expect(text).toContain("A name the request leaves open (a column header, a label, a key) takes the repository's own spelling, case included: fields the code returns as `region` and `total` make the CSV header `region,total`, never `Region,Total`.");
  });
});
