import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ledgerProvenRun, type TeceraEvent } from '@tecera/contracts';
import { SqliteLedger } from '@tecera/ledger';
import { main, type MainOptions } from '../cli/main.js';
import { EXIT } from '../errors.js';
import { capabilityAccess, repositoryFacts, runtimeEnvironment, withStandIns } from './access.js';

/**
 * What a worker step can reach beyond the repository, end to end through `tecera run` on samples/fix-failing-test
 * with scripted models, the real sandbox, the real gates and git (live rerun 2, D-I and the worker-context gap):
 * - a capability resolved to a stand-in is served to every worker step whatever tools the plan listed: a plan
 *   whose steps never list `mail` still sends through the sink and reaches a provisional PR;
 * - when no step calls the stand-in, the criteria requiring it are still proven at fidelity mocked (never a
 *   terminal "capability the inventory lacks");
 * - a provisioned sqlite reaches the step as data (kind, locator, TECERA_RESOURCE_<ID>) and the criterion's
 *   contained process as that variable: the criterion opens the provisioned file and is proven provisioned.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
const SAMPLE = join(REPO, 'samples/fix-failing-test');
const FIXTURES = resolve(HERE, '../../test-fixtures/fix-failing-test');

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix = 'tecera-access-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

const HOST = typeof process.getuid === 'function' && process.getuid() === 0 ? { TECERA_VERIFY_ALLOW_ROOT: '1' } : {};
const ENV = { PATH: process.env.PATH, HOME: process.env.HOME, USER: 'tester', ...HOST };
const KEYS = { ANTHROPIC_API_KEY: 'test-anthropic-credential-0123456789', OPENAI_API_KEY: 'test-openai-credential-9876543210', OPENROUTER_API_KEY: 'test-openrouter-credential-5555555555' };

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null' },
  }).toString('utf8');
}

let idn = 0;
async function cli(cwd: string, argv: string[], opts: MainOptions = {}): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const { env: extraEnv, ...rest } = opts;
  const code = await main(argv, { cwd, env: { ...ENV, ...(extraEnv ?? {}) }, stdout: (s) => (out += s), stderr: (s) => (err += s), isTTY: false, ids: (p) => `${p}_a${++idn}`, ...rest });
  return { code, out, err };
}

async function events(dir: string): Promise<Array<TeceraEvent & { seq: number }>> {
  const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
  const out: Array<TeceraEvent & { seq: number }> = [];
  for await (const e of l.events()) out.push(e);
  l.close();
  return out;
}

async function dump(dir: string): Promise<string> {
  return (await events(dir)).map((e) => `${e.seq} ${e.kind} ${e.trace.stepId ?? ''} ${JSON.stringify(e.payload).slice(0, 500)}`).join('\n');
}

const GOAL = (dir: string): string => join(dir, '.tecera/goals/fix-failing-test.goal.md');

async function sampleRepo(mutate: (dir: string) => void): Promise<{ dir: string; wt: string; res: string }> {
  const dir = tmp();
  cpSync(SAMPLE, dir, { recursive: true, filter: (src) => !/node_modules|ledger\.sqlite|[\\/]runs([\\/]|$)/.test(src) });
  mutate(dir);
  const r = await cli(dir, ['init']);
  expect(r.code, r.err).toBe(0);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return { dir, wt: tmp('tecera-wt-'), res: join(tmp('tecera-res-'), 'resources') };
}

function withCriteria(criteria: unknown[]): (dir: string) => void {
  return (dir) => {
    const text = readFileSync(GOAL(dir), 'utf8');
    writeFileSync(GOAL(dir), text.replace(/^on-violation: wake-human$/m, `on-violation: wake-human\ncriteria: ${JSON.stringify(criteria)}`));
  };
}

function connections(c: Record<string, unknown>): (dir: string) => void {
  return (dir) => {
    const p = join(dir, 'tecera.json');
    const m = JSON.parse(readFileSync(p, 'utf8'));
    m.connections = c;
    writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`);
  };
}

type Reply = { text: string; expect?: string; usage?: unknown };
const fixtureReplies = (): { worker: Reply[]; reviewer: Reply[] } => JSON.parse(readFileSync(join(FIXTURES, 'replies.json'), 'utf8'));
const fixturePlan = (): Record<string, unknown> & { steps: Array<{ id: string; tools?: string[] }>; permissions: { tools: string[] }; capabilities?: string[] } => JSON.parse(readFileSync(join(FIXTURES, 'plan.json'), 'utf8'));

function scripts(o: { replies?: Record<string, unknown>; plan?: unknown } = {}): string {
  const d = tmp('tecera-scripts-');
  writeFileSync(join(d, 'plan.json'), JSON.stringify(o.plan ?? fixturePlan()));
  writeFileSync(join(d, 'replies.json'), JSON.stringify(o.replies ?? fixtureReplies()));
  return d;
}

function pending(evs: TeceraEvent[]): TeceraEvent | undefined {
  const closed = new Set(evs.filter((e) => ['approval.granted', 'approval.denied', 'approval.expired', 'approval.consumed'].includes(e.kind)).map((e) => (e.payload as { requestId?: string }).requestId));
  return [...evs].reverse().find((e) => e.kind === 'approval.requested' && !closed.has((e.payload as { requestId: string }).requestId));
}

const runIdOf = (evs: TeceraEvent[]): string => evs.find((e) => e.kind === 'run.started')!.runId!;

/** run → PR hold → approve → resume; returns the resumed exit code and the events. */
async function throughPr(dir: string, env: Record<string, string>, s: { plan?: unknown; replies?: Record<string, unknown> }): Promise<{ code: number; out: string; runId: string; evs: Array<TeceraEvent & { seq: number }> }> {
  const run = await cli(dir, ['run', 'fix-failing-test', '--scripted', scripts(s)], { env });
  if (run.code !== EXIT.held) console.log(await dump(dir));
  expect(run.code, run.err + run.out).toBe(EXIT.held);
  const evs = await events(dir);
  const runId = runIdOf(evs);
  const held = pending(evs)!;
  expect(held, 'held for the PR approval').toBeTruthy();
  expect((await cli(dir, ['approve', (held.payload as { requestId: string }).requestId, '--as', 'reviewer-human'], { env })).code).toBe(0);
  const resumed = await cli(dir, ['run', '--resume', runId, '--scripted', scripts({ ...(s.plan ? { plan: s.plan } : {}), replies: {} })], { env });
  return { code: resumed.code, out: resumed.err + resumed.out, runId, evs: await events(dir) };
}

const MAIL = { mail: { kind: 'smtp', mockable: true } };
const welcome = [{ id: 'tests-pass', statement: 'the suite passes and a welcome mail would go out', verify: 'node --test', requires: ['mail'] }];

describe('a mocked capability is served to every worker step (D-I)', () => {
  it('capabilities [mail], no step lists the mail tool: the edit step sends through the stand-in, the sink records the message, the PR is provisional', async () => {
    const { dir, wt, res } = await sampleRepo((d) => {
      connections(MAIL)(d);
      withCriteria(welcome)(d);
    });
    const env = { ...KEYS, TECERA_WORKTREES: wt, TECERA_RESOURCES: res };
    const plan = fixturePlan();
    plan.capabilities = ['mail'];
    // The plan's tool lists never name mail (the live s5 shape).
    expect(JSON.stringify(plan.steps.map((s) => s.tools)) + JSON.stringify(plan.permissions.tools)).not.toContain('mail');
    const fx = fixtureReplies();
    // The step is told what stands in for mail (capabilityAccess) and what it may import (runtimeEnvironment).
    fx.worker[1] = {
      ...fx.worker[1]!,
      expect: 'capabilityAccess[\\s\\S]*toolName[\\s\\S]*mail[\\s\\S]*simulated message sink',
      text: fx.worker[1]!.text
        .replace('```js\n', "```js\nconst sent = await mail.send({ to: 'ada@example.com', subject: 'welcome' });\nconst box = await mail.outbox();\n")
        .replace("{ key: 'changedFiles', value: ['src/slugify.js'] },", "{ key: 'changedFiles', value: ['src/slugify.js'] },\n  { key: 'sent', value: sent },\n  { key: 'outbox', value: box.length },"),
    };
    fx.worker[0] = { ...fx.worker[0]!, expect: 'runtimeEnvironment[\\s\\S]*node:sqlite[\\s\\S]*No package is installed' };
    const r = await throughPr(dir, env, { plan, replies: fx });
    if (r.code !== EXIT.provisional) console.log(await dump(dir));
    expect(r.code, r.out).toBe(EXIT.provisional);
    const mocked = r.evs.filter((e) => e.kind === 'capability.mocked');
    expect(mocked).toHaveLength(1);
    expect(mocked[0]!.payload).toMatchObject({ capability: 'mail', kind: 'smtp', tool: 'mail', mockId: 'mock_mail' });
    // The sink recorded the message: the edit step's output carries its receipt and the outbox count.
    const edit = r.evs.find((e) => e.kind === 'step.completed' && e.trace.stepId === 'edit')!;
    const facts = (edit.payload as { output: { facts: Array<{ key: string; value: unknown }> } }).output.facts;
    expect(facts.find((f) => f.key === 'sent')!.value).toEqual({ id: 'sim-msg-1', accepted: true, simulated: true });
    expect(facts.find((f) => f.key === 'outbox')!.value).toBe(1);
    expect(r.evs.find((e) => e.kind === 'goal.provisional')!.payload).toMatchObject({ mocked: ['tests-pass'] });
    expect(r.evs.map((e) => e.kind)).not.toContain('goal.achieved');
    const request = JSON.parse(readFileSync(join(dir, '.tecera/runs', r.runId, 'pr', 'request.json'), 'utf8'));
    expect(request).toMatchObject({ provisional: true, fidelity: 'mocked' });
    const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
    try {
      expect(await ledgerProvenRun(l, r.runId, {})).toMatchObject({ achieved: false, provisional: true });
    } finally {
      l.close();
    }
  }, 600_000);

  it('no step calls the stand-in: the criterion requiring mail is still proven at fidelity mocked before the verify gate runs it (never exit 9)', async () => {
    const { dir, wt, res } = await sampleRepo((d) => {
      connections(MAIL)(d);
      withCriteria(welcome)(d);
    });
    const env = { ...KEYS, TECERA_WORKTREES: wt, TECERA_RESOURCES: res };
    const plan = fixturePlan();
    plan.capabilities = ['mail'];
    const r = await throughPr(dir, env, { plan });
    if (r.code !== EXIT.provisional) console.log(await dump(dir));
    expect(r.code, r.out).toBe(EXIT.provisional);
    const mocked = r.evs.filter((e) => e.kind === 'capability.mocked');
    expect(mocked).toHaveLength(1);
    expect(mocked[0]!.payload).toMatchObject({ capability: 'mail', tool: 'mail', mockId: 'mock_mail' });
    expect((mocked[0]!.payload as { reason: string }).reason).toMatch(/no step called it/);
    // Recorded before the first verify ran the criterion (after the loop announced it, before its result).
    const firstResult = r.evs.find((e) => e.kind === 'verify.passed' || e.kind === 'verify.failed')!;
    expect(firstResult.kind).toBe('verify.passed');
    expect(mocked[0]!.seq).toBeLessThan(firstResult.seq);
    expect(r.evs.find((e) => e.kind === 'goal.provisional')!.payload).toMatchObject({ mocked: ['tests-pass'] });
  }, 600_000);
});

describe('a provisioned resource reaches the step and the criterion (worker context)', () => {
  // The live s4 shape: persistence needs a database the repository lacks; Tecera provisions a local sqlite.
  // The check is a committed script (a criterion target the worker may not edit) given the variable.
  const stored = 'node check/stored.mjs $TECERA_RESOURCE_DB';
  const script = [
    "import assert from 'node:assert/strict';",
    "import { DatabaseSync } from 'node:sqlite';",
    "import { slugify } from '../src/slugify.js';",
    'const db = new DatabaseSync(process.argv[2]);',
    "db.exec('CREATE TABLE IF NOT EXISTS slugs (v TEXT)');",
    "db.prepare('INSERT INTO slugs VALUES (?)').run(slugify('a -- b  c'));",
    "assert.equal(db.prepare('SELECT v FROM slugs ORDER BY rowid DESC').get().v, 'a-b-c');",
    'db.close();',
    '',
  ].join('\n');

  it('the step gets kind, locator and TECERA_RESOURCE_DB; the criterion opens the provisioned file and is proven provisioned; the goal is achieved', async () => {
    const { dir, wt, res } = await sampleRepo((d) => {
      connections({ db: { kind: 'sqlite' } })(d);
      mkdirSync(join(d, 'check'));
      writeFileSync(join(d, 'check/stored.mjs'), script);
      withCriteria([{ id: 'slug-stored', statement: 'the slug is stored in the provisioned database', verify: stored, requires: ['db'], timeoutSec: 60 }])(d);
    });
    const env = { ...KEYS, TECERA_WORKTREES: wt, TECERA_RESOURCES: res };
    const fx = fixtureReplies();
    // The edit step is told where the database is and how to open it.
    fx.worker[1] = { ...fx.worker[1]!, expect: 'capabilityAccess[\\s\\S]*fidelity[\\s\\S]*provisioned[\\s\\S]*TECERA_RESOURCE_DB[\\s\\S]*node:sqlite' };
    const r = await throughPr(dir, env, { replies: fx });
    if (r.code !== EXIT.ok) console.log(await dump(dir));
    expect(r.code, r.out).toBe(EXIT.ok);
    const resource = (r.evs.find((e) => e.kind === 'resource.provisioned')!.payload as { resource: { id: string; locator: string; kind: string } }).resource;
    expect(resource.kind).toBe('sqlite');
    expect(resource.locator.startsWith(res)).toBe(true);
    // The provisioned file is the one the criterion wrote (read below).
    expect(existsSync(resource.locator)).toBe(true);
    const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
    try {
      const v = await ledgerProvenRun(l, r.runId, {});
      expect(v.achieved).toBe(true);
      expect(v.goals['fix-failing-test']!.proof!.criteria!.map((k) => [k.criterionId, k.fidelity])).toEqual([['slug-stored', 'provisioned']]);
      const ev = (await l.getEvidence(v.goals['fix-failing-test']!.proof!.criteria![0]!.evidenceKey))!.body as Record<string, unknown>;
      expect(ev).toMatchObject({ command: stored, fidelity: 'provisioned', resourceEnv: ['TECERA_RESOURCE_DB'] });
    } finally {
      l.close();
    }
    // The criterion wrote to the provisioned file (once per verify of the plan), not to a database of its own.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(resource.locator, { readOnly: true });
    const rows = db.prepare('SELECT v FROM slugs').all() as Array<{ v: string }>;
    db.close();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(new Set(rows.map((x) => x.v))).toEqual(new Set(['a-b-c']));
  }, 600_000);
});

describe('the planner sees the repository; refused drafts are on the ledger (D-D)', () => {
  it('a statement run whose drafts import a package nothing installs: both drafts are refused and each is recorded as criteria.rejected evidence with its issues', async () => {
    const { dir, wt, res } = await sampleRepo(() => undefined);
    const env = { ...KEYS, TECERA_WORKTREES: wt, TECERA_RESOURCES: res };
    const draft = JSON.stringify({
      criteria: [
        { id: 'collapsed', statement: 'runs of separators become one dash', kind: 'command', command: 'node --input-type=module -e \'import assert from "node:assert/strict"; import Database from "better-sqlite3"; import { slugify } from "./src/slugify.js"; assert.equal(slugify("a -- b"), "a-b"); void Database;\'', timeoutSec: 60, prompt: null, requires: [], tags: [] },
        { id: 'suite', statement: 'the existing tests pass', kind: 'command', command: 'node --test', timeoutSec: 60, prompt: null, requires: [], tags: [] },
      ],
      outOfScope: [],
      assumptions: [],
      needs: [],
    });
    const d = tmp('tecera-scripts-');
    // No plan.json and no contract.json: the LLM planner drafts, over the scripted planner seat. The drafting
    // prompt says what is installed (nothing) and the API the sample's test uses.
    writeFileSync(join(d, 'replies.json'), JSON.stringify({ planner: [{ text: draft, expect: 'Packages the repository installs \\(package.json\\): none[\\s\\S]*src/slugify.js[\\s\\S]*slugify' }, { text: draft }] }));
    const r = await cli(dir, ['run', 'make the failing test pass', '--scripted', d], { env });
    expect(r.code, r.err + r.out).not.toBe(EXIT.ok);
    const evs = await events(dir);
    const rejected = evs.filter((e) => e.kind === 'evidence.appended' && (e.payload as { kind?: string }).kind === 'criteria.rejected');
    if (rejected.length !== 2) console.log(await dump(dir));
    expect(rejected.map((e) => (e.payload as { attempt: number }).attempt)).toEqual([1, 2]);
    expect(rejected[0]!.trace.goalId).toBe('make-the-failing-test-pass');
    expect(rejected[0]!.actor).toEqual({ kind: 'system', id: 'planner' });
    expect(JSON.stringify(rejected[0]!.payload)).toMatch(/imports package better-sqlite3, which the repository does not install \(installed: none\)/);
    const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
    try {
      const body = (await l.getEvidence((rejected[0]!.payload as { evidenceKey: string }).evidenceKey))!.body as { goalId: string; contract: { criteria: Array<{ id: string }> }; issues: string[] };
      expect(body.goalId).toBe('make-the-failing-test-pass');
      expect(body.contract.criteria.map((k) => k.id)).toEqual(['collapsed', 'suite']);
      expect(body.issues.join('\n')).toMatch(/better-sqlite3/);
    } finally {
      l.close();
    }
    // Nothing was drafted as the contract, so nothing can be signed off.
    expect(evs.map((e) => e.kind)).not.toContain('criteria.drafted');
  }, 300_000);
});

describe('capability access helpers', () => {
  it('a step learns each stand-in and provisioned resource it may reach; nothing for a capability it does not name', () => {
    const decl = { capability: 'mail', kind: 'smtp', tool: 'mail', methods: ['send', 'outbox'], schema: {}, mockId: 'mock_mail', reason: 'r' };
    const res = { id: 'res1', capability: 'db', kind: 'sqlite', provider: 'local', locator: '/tmp/tecera-res/res1/db.sqlite', teardown: 'rm -rf x', createdAt: 1, expiresAt: 2, transfer: 'pending' as const };
    const other = { ...res, id: 'res2', capability: 'cache' };
    const access = capabilityAccess({ mocks: [decl], resources: [res, other], wanted: new Set(['mail', 'db']), tools: new Set(['db']), inventory: [{ id: 'db', kind: 'sqlite', state: 'provisioned', resourceId: 'res1' }, { id: 'cache', kind: 'sqlite', state: 'provisioned', resourceId: 'res2' }] });
    expect(access).toEqual([
      expect.objectContaining({ capability: 'mail', fidelity: 'mocked', toolName: 'mail', methods: ['send', 'outbox'] }),
      expect.objectContaining({ capability: 'db', kind: 'sqlite', fidelity: 'provisioned', locator: res.locator, env: 'TECERA_RESOURCE_DB', toolName: 'db' }),
    ]);
    expect(JSON.stringify(access)).not.toContain('res2');
    // A resource the inventory does not back as provisioned (released, refused) is not offered.
    expect(capabilityAccess({ mocks: [], resources: [res], wanted: new Set(['db']), tools: new Set(), inventory: [{ id: 'db', kind: 'sqlite', state: 'missing' }] })).toEqual([]);
  });

  it('withStandIns adds only the stand-in tools to the plan, the step and the capability set', () => {
    const req = { plan: { permissions: { tools: ['read', 'edit'] } }, step: { id: 'edit', tools: ['read'] }, capabilities: { tools: ['read'] } } as never;
    const out = withStandIns(req, ['mail']) as unknown as { plan: { permissions: { tools: string[] } }; step: { tools: string[] }; capabilities: { tools: string[] } };
    expect(out.plan.permissions.tools).toEqual(['read', 'edit', 'mail']);
    expect(out.step.tools).toEqual(['read', 'mail']);
    expect(out.capabilities.tools).toEqual(['read', 'mail']);
    expect(withStandIns(req, [])).toBe(req);
  });

  it('repositoryFacts reads package names and the API the tests use; runtimeEnvironment says nothing is installed', () => {
    const facts = repositoryFacts(join(REPO, 'packages/bench/fixtures/04-needs-db/repo'));
    // The tests call createSessionStore() with no argument and use set/get/delete/close on what it returns; the
    // module declares one optional `options` parameter defaulted to an object (the call-shape screen's facts).
    expect(facts).toEqual({
      dependencies: [],
      testedApi: [
        {
          module: 'src/sessions.js',
          names: ['createSessionStore'],
          tests: ['test/sessions.test.js'],
          calls: [
            {
              name: 'createSessionStore',
              signatures: [[]],
              methods: ['close', 'delete', 'get', 'set'],
              params: [{ name: 'options', kind: 'object', optional: true, rest: false, members: [] }],
            },
          ],
        },
      ],
    });
    expect(runtimeEnvironment(facts)).toMatchObject({ builtins: expect.arrayContaining(['node:sqlite', 'node:test']), dependencies: [], notes: expect.stringMatching(/No package is installed/) });
    expect(repositoryFacts(join(tmp(), 'missing'))).toEqual({ dependencies: [], testedApi: [] });
  });
});
