import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { acceptedContractOf, contractHash, event, ledgerProvenRun, resourceRegistryOf, type AcceptanceContract, type JsonObject, type ProvisionedResource, type TeceraEvent } from '@tecera/contracts';
import { SqliteLedger } from '@tecera/ledger';
import { main, type MainOptions } from './cli/main.js';
import { EXIT } from './errors.js';
import { parseGoalFile, resolveGoal, GoalError } from './goals.js';
import { othersTraverse, worktreesRoot } from './worktree.js';
import { pushableRemote, usableResources } from './wiring.js';
import { locatorWithin } from './capabilities/provisioner.js';
import { loadManifest } from './manifest/load.js';

/**
 * Acceptance contracts end to end (D8–D12) through `tecera run` on samples/fix-failing-test with scripted
 * models, the real sandbox, the real gates and git: a goal file with criteria (no sign-off), a statement run
 * through both holds, a mocked capability (provisional, never achieved), a provisioned bare remote (pushed
 * to, listed for transfer, released), and an amendment mid-run (re-plan after a fresh sign-off). Plus the
 * carried-over L5 regressions (one slug across holds, a worktree root the verify uid can reach, the ledger's
 * sidecar files ignored).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const SAMPLE = join(REPO, 'samples/fix-failing-test');
const FIXTURES = resolve(HERE, '../test-fixtures/fix-failing-test');

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix = 'tecera-crit-'): string {
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
  const code = await main(argv, { cwd, env: { ...ENV, ...(extraEnv ?? {}) }, stdout: (s) => (out += s), stderr: (s) => (err += s), isTTY: false, ids: (p) => `${p}_c${++idn}`, ...rest });
  return { code, out, err };
}

async function events(dir: string): Promise<Array<TeceraEvent & { seq: number }>> {
  const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
  const out: Array<TeceraEvent & { seq: number }> = [];
  for await (const e of l.events()) out.push(e);
  l.close();
  return out;
}

async function verdictOf(dir: string, runId: string, allowance?: Parameters<typeof ledgerProvenRun>[2]) {
  const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
  try {
    return await ledgerProvenRun(l, runId, allowance ?? {});
  } finally {
    l.close();
  }
}

async function dump(dir: string): Promise<string> {
  const lines: string[] = [];
  for (const e of await events(dir)) lines.push(`${e.seq} ${e.kind} ${e.trace.stepId ?? ''} ${JSON.stringify(e.payload).slice(0, 500)}`);
  return lines.join('\n');
}

const GOAL = (dir: string): string => join(dir, '.tecera/goals/fix-failing-test.goal.md');

/** A temp copy of the sample, mutated before `tecera init` pins it, committed on main. */
async function sampleRepo(mutate?: (dir: string) => void): Promise<{ dir: string; wt: string; res: string }> {
  const dir = tmp();
  cpSync(SAMPLE, dir, { recursive: true, filter: (src) => !/node_modules|ledger\.sqlite|[\\/]runs([\\/]|$)/.test(src) });
  mutate?.(dir);
  const r = await cli(dir, ['init']);
  expect(r.code, r.err).toBe(0);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return { dir, wt: tmp('tecera-wt-'), res: join(tmp('tecera-res-'), 'resources') };
}

/** Add `criteria:` to the sample goal file (one front-matter line, JSON flow style). */
function withCriteria(criteria: unknown[]): (dir: string) => void {
  return (dir) => {
    const text = readFileSync(GOAL(dir), 'utf8');
    writeFileSync(GOAL(dir), text.replace(/^on-violation: wake-human$/m, `on-violation: wake-human\ncriteria: ${JSON.stringify(criteria)}`));
  };
}

function manifestEdit(edit: (m: Record<string, unknown>) => void): (dir: string) => void {
  return (dir) => {
    const p = join(dir, 'tecera.json');
    const m = JSON.parse(readFileSync(p, 'utf8'));
    edit(m);
    writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`);
  };
}

type Reply = { text: string; expect?: string; usage?: unknown };
const fixtureReplies = (): { worker: Reply[]; reviewer: Reply[] } => JSON.parse(readFileSync(join(FIXTURES, 'replies.json'), 'utf8'));
const fixturePlan = (): Record<string, unknown> & { steps: Array<{ id: string; tools?: string[] }>; permissions: { tools: string[] } } => JSON.parse(readFileSync(join(FIXTURES, 'plan.json'), 'utf8'));

/** A scripts dir: the (optionally edited) sample plan, the replies, and an optional contract.json. */
function scripts(o: { replies?: Record<string, unknown>; plan?: unknown; contract?: unknown } = {}): string {
  const d = tmp('tecera-scripts-');
  writeFileSync(join(d, 'plan.json'), JSON.stringify(o.plan ?? fixturePlan()));
  writeFileSync(join(d, 'replies.json'), JSON.stringify(o.replies ?? fixtureReplies()));
  if (o.contract !== undefined) writeFileSync(join(d, 'contract.json'), JSON.stringify(o.contract));
  return d;
}

function pending(evs: TeceraEvent[]): TeceraEvent | undefined {
  const closed = new Set(evs.filter((e) => ['approval.granted', 'approval.denied', 'approval.expired', 'approval.consumed'].includes(e.kind)).map((e) => (e.payload as { requestId?: string }).requestId));
  return [...evs].reverse().find((e) => e.kind === 'approval.requested' && !closed.has((e.payload as { requestId: string }).requestId));
}

const stopHook = (dir: string) => cli(dir, ['hook', 'stop'], { stdin: JSON.stringify({ hook_event_name: 'Stop', cwd: dir, session_id: 'cc-1', stop_hook_active: false }) });
const runIdOf = (evs: TeceraEvent[]): string => evs.find((e) => e.kind === 'run.started')!.runId!;

describe('acceptance contracts end to end (scripted models, real sandbox, real gates)', () => {
  it('(a) a goal file with criteria: the file accepts its own contract (no sign-off hold), every criterion is verified, the PR hold is the one hold, and the goal is achieved with real fidelity', async () => {
    const criteria = [
      { id: 'tests-pass', statement: 'the test suite passes', verify: 'node --test' },
      { id: 'slugify-test', statement: 'the slugify test passes on its own', verify: 'node --test test/slugify.test.js', timeoutSec: 120 },
    ];
    const { dir, wt, res } = await sampleRepo(withCriteria(criteria));
    const env = { ...KEYS, TECERA_WORKTREES: wt, TECERA_RESOURCES: res };
    const run = await cli(dir, ['run', 'fix-failing-test', '--scripted', scripts()], { env });
    if (run.code !== EXIT.held) console.log(await dump(dir));
    expect(run.code, run.err + run.out).toBe(EXIT.held);
    let evs = await events(dir);
    const runId = runIdOf(evs);
    // no sign-off: the goal file's contract was accepted by the file, by a system actor
    expect(evs.filter((e) => e.kind === 'approval.requested').map((e) => (e.payload as { action?: string }).action ?? 'pr')).not.toContain('accept_criteria');
    const accepted = evs.find((e) => e.kind === 'criteria.accepted')!;
    expect(accepted.payload).toMatchObject({ via: 'goal-file' });
    expect(accepted.actor.kind).toBe('system');
    // both command criteria were run by the verify gate on the candidate
    const passed = evs.filter((e) => e.kind === 'verify.passed');
    expect(passed.some((e) => JSON.stringify(e.payload).includes('slugify-test'))).toBe(true);
    // the plan was written for the accepted contract
    const plan = evs.find((e) => e.kind === 'plan.generated')!.payload as { plan: { contractHash?: string } };
    expect(plan.plan.contractHash).toBe((accepted.payload as { hash: string }).hash);
    // the status names the contract
    const st = await cli(dir, ['status', '--json']);
    expect(st.out).toMatch(/"contracts":\[\{"goalId":"fix-failing-test","state":"accepted"/);

    const held = pending(evs)!;
    expect((await cli(dir, ['approve', (held.payload as { requestId: string }).requestId, '--as', 'reviewer-human'], { env })).code).toBe(0);
    const resumed = await cli(dir, ['run', '--resume', runId, '--scripted', scripts({ replies: {} })], { env });
    if (resumed.code !== 0) console.log(await dump(dir));
    expect(resumed.code, resumed.err + resumed.out).toBe(EXIT.ok);
    evs = await events(dir);
    const v = await verdictOf(dir, runId);
    expect(v.achieved).toBe(true);
    const proof = v.goals['fix-failing-test']!.proof!;
    expect(proof.criteria!.map((k) => [k.criterionId, k.fidelity])).toEqual([['tests-pass', 'real'], ['slugify-test', 'real']]);
    expect(proof.fidelity).toBe('real');
    expect((await stopHook(dir)).code).toBe(0);
    const show = await cli(dir, ['criteria', 'show', runId]);
    expect(show.code).toBe(0);
    expect(show.out).toMatch(/tests-pass[\s\S]*real \(command\)/);
  }, 600_000);

  it('(b) `tecera run "make the failing test pass"`: the drafted contract holds for sign-off (exit 4) before anything is planned; `criteria accept` signs it off, the PR holds, approve → achieved; one slug names the goal and the branch on every segment (L5-F1)', async () => {
    const { dir, wt, res } = await sampleRepo();
    const env = { ...KEYS, TECERA_WORKTREES: wt, TECERA_RESOURCES: res };
    const contract = { criteria: [{ id: 'tests-pass', statement: 'the whole test suite passes', check: { kind: 'command', command: 'node --test', timeoutSec: 120 } }], assumptions: ['the failing test states the intended behaviour'] };
    const seg1 = await cli(dir, ['run', 'make the failing test pass', '--scripted', scripts({ contract, replies: {} })], { env });
    if (seg1.code !== EXIT.held) console.log(await dump(dir));
    expect(seg1.code, seg1.err + seg1.out).toBe(EXIT.held);
    expect(seg1.out).toMatch(/held for criteria sign-off approval/);
    let evs = await events(dir);
    const runId = runIdOf(evs);
    // nothing was planned and no worker ran before the sign-off
    expect(evs.map((e) => e.kind)).not.toContain('plan.generated');
    expect(evs.map((e) => e.kind)).not.toContain('step.started');
    expect(evs.find((e) => e.kind === 'goal.adopted')!.trace.goalId).toBe('make-the-failing-test-pass');
    const drafted = evs.find((e) => e.kind === 'criteria.drafted')!;
    expect(drafted.payload).toMatchObject({ source: 'planner' });
    // the Stop hook blocks while the sign-off is pending; the requester (Tecera) can never be the approver
    expect((await stopHook(dir)).code).toBe(2);
    const show = await cli(dir, ['criteria', 'show', runId]);
    expect(show.out).toMatch(/drafted/);
    expect(show.out).toMatch(/sign-off \S+ pending → tecera criteria accept/);

    const accept = await cli(dir, ['criteria', 'accept', runId, '--as', 'requestor-human'], { env });
    expect(accept.code, accept.err + accept.out).toBe(0);
    const seg2 = await cli(dir, ['run', '--resume', runId, '--scripted', scripts({ contract, replies: fixtureReplies() })], { env });
    if (seg2.code !== EXIT.held) console.log(await dump(dir));
    expect(seg2.code, seg2.err + seg2.out).toBe(EXIT.held);
    expect(seg2.out).toMatch(/held for PR approval/);
    evs = await events(dir);
    expect(evs.find((e) => e.kind === 'criteria.accepted')!.payload).toMatchObject({ via: 'approval', approver: { kind: 'human', id: 'requestor-human' } });
    const consumed = evs.find((e) => e.kind === 'approval.consumed')!;
    expect(consumed.actor.kind).toBe('system');
    // the commit is on the slug's branch (the same name the resume derives from the ledger)
    expect(git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/tecera/').trim()).toBe('tecera/make-the-failing-test-pass');

    const pr = pending(evs)!;
    expect((await cli(dir, ['approve', (pr.payload as { requestId: string }).requestId, '--as', 'reviewer-human'], { env })).code).toBe(0);
    const seg3 = await cli(dir, ['run', '--resume', runId, '--scripted', scripts({ contract, replies: {} })], { env });
    if (seg3.code !== 0) console.log(await dump(dir));
    expect(seg3.code, seg3.err + seg3.out).toBe(EXIT.ok);
    evs = await events(dir);
    expect(evs.find((e) => e.kind === 'pr.requested')!.payload).toMatchObject({ branch: 'tecera/make-the-failing-test-pass' });
    const v = await verdictOf(dir, runId);
    expect(v.achieved).toBe(true);
    expect((await stopHook(dir)).code).toBe(0);
  }, 600_000);

  it('(c) a criterion resting on a mocked capability: the stand-in serves the step (capability.mocked), the PR says provisional, the goal is goal.provisional (exit 10, never 0) and the Stop hook keeps blocking', async () => {
    const { dir, wt, res } = await sampleRepo((d) => {
      // a cache the business case declares but nothing serves, of a kind Tecera may not provision: mock rung
      manifestEdit((m) => (m.connections = { cache: { kind: 'redis', mockable: true } }))(d);
      withCriteria([{ id: 'tests-pass', statement: 'the test suite passes with the cache warmed', verify: 'node --test', requires: ['cache'] }])(d);
    });
    const env = { ...KEYS, TECERA_WORKTREES: wt, TECERA_RESOURCES: res };
    const plan = fixturePlan();
    plan.permissions.tools.push('cache');
    plan.steps.find((s) => s.id === 'edit')!.tools!.push('cache');
    const fx = fixtureReplies();
    // the edit step warms the cache through the stand-in, then makes the fix
    fx.worker[1] = { ...fx.worker[1]!, text: fx.worker[1]!.text.replace('```js\n', "```js\nawait cache.set('slug:warm', 'a-b-c');\n") };
    const run = await cli(dir, ['run', 'fix-failing-test', '--scripted', scripts({ plan, replies: fx })], { env });
    if (run.code !== EXIT.held) console.log(await dump(dir));
    expect(run.code, run.err + run.out).toBe(EXIT.held);
    let evs = await events(dir);
    const runId = runIdOf(evs);
    const missing = evs.find((e) => e.kind === 'capability.missing')!;
    expect(missing.payload).toMatchObject({ capability: { id: 'cache' }, resolution: 'mock' });
    const mocked = evs.filter((e) => e.kind === 'capability.mocked');
    expect(mocked.length).toBe(1);
    expect(mocked[0]!.payload).toMatchObject({ capability: 'cache', tool: 'cache' });
    expect(mocked[0]!.trace.goalId).toBe('fix-failing-test');

    const held = pending(evs)!;
    expect((await cli(dir, ['approve', (held.payload as { requestId: string }).requestId, '--as', 'reviewer-human'], { env })).code).toBe(0);
    const resumed = await cli(dir, ['run', '--resume', runId, '--scripted', scripts({ plan, replies: {} })], { env });
    if (resumed.code !== EXIT.provisional) console.log(await dump(dir));
    expect(resumed.code, resumed.err + resumed.out).toBe(EXIT.provisional);
    expect(resumed.out).toMatch(/goal provisional/);
    evs = await events(dir);
    expect(evs.map((e) => e.kind)).not.toContain('goal.achieved');
    const prov = evs.find((e) => e.kind === 'goal.provisional')!;
    expect(prov.payload).toMatchObject({ mocked: ['tests-pass'] });
    // the PR is marked provisional (title and request) and lists the criterion at fidelity mocked
    const pr = evs.find((e) => e.kind === 'pr.requested' || e.kind === 'pr.opened')!;
    const request = JSON.parse(readFileSync(join(dir, '.tecera/runs', runId, 'pr', 'request.json'), 'utf8'));
    expect(request).toMatchObject({ provisional: true, fidelity: 'mocked' });
    expect(JSON.stringify(pr.payload) + JSON.stringify(request)).toMatch(/provisional/);
    const v = await verdictOf(dir, runId);
    expect(v).toMatchObject({ achieved: false, provisional: true });
    const stop = await stopHook(dir);
    expect(stop.code).toBe(2);
    expect(stop.err).toMatch(/provisional/);
    const st = await cli(dir, ['status']);
    expect(st.out).toMatch(/PROVISIONAL/);
  }, 600_000);

  it('(d) a provisioned bare remote: the missing git remote is provisioned in Tecera\'s space, receives the push, is listed for transfer on the PR; `tecera resources release` runs its recorded teardown', async () => {
    const { dir, wt, res } = await sampleRepo((d) => {
      manifestEdit((m) => (m.connections = { origin: { kind: 'git-remote', probe: 'git ls-remote --exit-code origin', mockable: false } }))(d);
      withCriteria([{ id: 'tests-pass', statement: 'the fix is delivered to a remote and the suite passes', verify: 'node --test', requires: ['origin'] }])(d);
    });
    const env = { ...KEYS, TECERA_WORKTREES: wt, TECERA_RESOURCES: res };
    const run = await cli(dir, ['run', 'fix-failing-test', '--scripted', scripts()], { env });
    if (run.code !== EXIT.held) console.log(await dump(dir));
    expect(run.code, run.err + run.out).toBe(EXIT.held);
    let evs = await events(dir);
    const runId = runIdOf(evs);
    const probed = evs.find((e) => e.kind === 'capability.probed')!;
    expect(probed.payload).toMatchObject({ capability: { id: 'origin', state: 'missing' } });
    const prov = evs.find((e) => e.kind === 'resource.provisioned')!;
    const resource = (prov.payload as { resource: { id: string; locator: string; teardown: string; kind: string } }).resource;
    expect(resource).toMatchObject({ kind: 'git-remote', capability: 'origin', transfer: 'pending' });
    expect(resource.locator.startsWith(res)).toBe(true);
    expect(existsSync(resource.locator)).toBe(true);

    const held = pending(evs)!;
    expect((await cli(dir, ['approve', (held.payload as { requestId: string }).requestId, '--as', 'reviewer-human'], { env })).code).toBe(0);
    const resumed = await cli(dir, ['run', '--resume', runId, '--scripted', scripts({ replies: {} })], { env });
    if (resumed.code !== 0) console.log(await dump(dir));
    expect(resumed.code, resumed.err + resumed.out).toBe(EXIT.ok);
    evs = await events(dir);
    const sha = git(dir, 'rev-parse', 'tecera/fix-failing-test').trim();
    // the provisioned remote received the work branch; the business case keeps no remote of Tecera's
    expect(git(resource.locator, 'rev-parse', 'refs/heads/tecera/fix-failing-test').trim()).toBe(sha);
    expect(git(dir, 'remote').trim()).toBe('');
    // the PR lists it for transfer; the proof is at fidelity provisioned
    const request = JSON.parse(readFileSync(join(dir, '.tecera/runs', runId, 'pr', 'request.json'), 'utf8'));
    expect(request.pendingTransfer).toEqual([expect.objectContaining({ id: resource.id, kind: 'git-remote', locator: resource.locator, teardown: resource.teardown })]);
    const v = await verdictOf(dir, runId);
    expect(v.achieved).toBe(true);
    expect(v.goals['fix-failing-test']!.proof!.fidelity).toBe('provisioned');
    const st = await cli(dir, ['status']);
    expect(st.out).toMatch(new RegExp(`transfer\\s+${resource.id}\\s+git-remote`));
    const listed = await cli(dir, ['resources', 'list', '--json'], { env });
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(resource.id);

    // a human releases it: the recorded teardown runs, resource.released is recorded with them as actor
    const rel = await cli(dir, ['resources', 'release', resource.id, '--as', 'ops-human'], { env });
    expect(rel.code, rel.err + rel.out).toBe(0);
    expect(existsSync(resource.locator)).toBe(false);
    const released = (await events(dir)).find((e) => e.kind === 'resource.released')!;
    expect(released.payload).toMatchObject({ resourceId: resource.id, teardownExit: 0 });
    expect(released.actor).toEqual({ kind: 'human', id: 'ops-human' });
  }, 600_000);

  it('(e) `tecera criteria amend` mid-run (at the PR hold): the acceptance goes stale, the resume drops the running intention and holds for a sign-off of the new contract; once accepted the goal is re-planned for the new hash', async () => {
    const { dir, wt, res } = await sampleRepo(withCriteria([{ id: 'tests-pass', statement: 'the test suite passes', verify: 'node --test' }]));
    const env = { ...KEYS, TECERA_WORKTREES: wt, TECERA_RESOURCES: res };
    const run = await cli(dir, ['run', 'fix-failing-test', '--scripted', scripts()], { env });
    if (run.code !== EXIT.held) console.log(await dump(dir));
    expect(run.code, run.err + run.out).toBe(EXIT.held);
    let evs = await events(dir);
    const runId = runIdOf(evs);
    const firstPlan = evs.find((e) => e.kind === 'plan.generated')!;
    const intentionId = evs.find((e) => e.kind === 'intention.pushed')!.trace.intentionId!;
    const before = acceptedContractOf(evs, 'fix-failing-test', { runId });
    expect(before.state).toBe('accepted');

    // a human tightens the contract: a second criterion
    const amended: Partial<AcceptanceContract> = { criteria: [...before.contract!.criteria, { id: 'slugify-test', statement: 'the slugify test passes on its own', check: { kind: 'command', command: 'node --test test/slugify.test.js', timeoutSec: 60 } }] };
    const file = join(tmp('tecera-amend-'), 'contract.json');
    writeFileSync(file, JSON.stringify(amended));
    const amend = await cli(dir, ['criteria', 'amend', runId, '--file', file, '--reason', 'the slugify test must pass alone too', '--as', 'requestor-human'], { env });
    expect(amend.code, amend.err + amend.out).toBe(0);
    const newHash = contractHash({ ...before.contract!, criteria: amended.criteria! });
    evs = await events(dir);
    const am = evs.find((e) => e.kind === 'criteria.amended')!;
    expect(am.payload).toMatchObject({ from: before.current, to: newHash });
    expect(am.actor).toEqual({ kind: 'human', id: 'requestor-human' });
    expect(acceptedContractOf(evs, 'fix-failing-test', { runId }).state).toBe('stale');

    // resume: the old intention is dropped (never resumed at the PR), the goal holds for the new sign-off
    const seg2 = await cli(dir, ['run', '--resume', runId, '--scripted', scripts({ replies: {} })], { env });
    if (seg2.code !== EXIT.held) console.log(await dump(dir));
    expect(seg2.code, seg2.err + seg2.out).toBe(EXIT.held);
    evs = await events(dir);
    const dropped = evs.find((e) => e.kind === 'intention.dropped' && e.trace.intentionId === intentionId);
    expect(dropped, 'the intention planned for the superseded contract is dropped').toBeTruthy();
    const amendSeq = am.seq;
    expect(evs.filter((e) => e.seq > amendSeq && e.trace.intentionId === intentionId && e.kind === 'step.started')).toEqual([]);
    const signoff = pending(evs)!;
    expect(signoff.payload).toMatchObject({ action: 'accept_criteria', contractHash: newHash });

    const accept = await cli(dir, ['criteria', 'accept', runId, '--as', 'requestor-human'], { env });
    expect(accept.code, accept.err + accept.out).toBe(0);
    await cli(dir, ['run', '--resume', runId, '--scripted', scripts({ replies: fixtureReplies() })], { env });
    evs = await events(dir);
    const plans = evs.filter((e) => e.kind === 'plan.generated').map((e) => (e.payload as { plan: { id: string; contractHash?: string } }).plan);
    expect(plans.length).toBeGreaterThanOrEqual(2);
    expect(plans[plans.length - 1]!.contractHash).toBe(newHash);
    expect(plans[plans.length - 1]!.id).not.toBe((firstPlan.payload as { plan: { id: string } }).plan.id);
  }, 600_000);
});

describe('doctor and preflight print the capability inventory', () => {
  it('each declared connection is probed for real and listed with the rung a missing one resolves to; the allowance is listed', async () => {
    const { dir, res } = await sampleRepo(
      manifestEdit((m) => {
        m.connections = { svc: { kind: 'http', probe: 'node -e "process.exit(0)"' }, mail: { kind: 'smtp', mockable: true }, vault: { kind: 'vault', probe: 'node -e "process.exit(3)"', mockable: false }, store: { kind: 'sqlite' } };
      }),
    );
    const env = { ...KEYS, TECERA_RESOURCES: res };
    for (const argv of [['doctor', '--skip-live'], ['preflight', 'fix-failing-test', '--skip-live']]) {
      const r = await cli(dir, argv, { env });
      const out = r.out + r.err;
      expect(out, argv[0]).toMatch(/cap:svc\s+http available \(probe exited 0\)/);
      expect(out, argv[0]).toMatch(/cap:mail\s+smtp missing \(connection mail declares neither a probe nor an auth reference\) → a run would serve a stand-in/);
      expect(out, argv[0]).toMatch(/cap:vault\s+vault missing \(probe exited 3\) → a run would ask the requestor/);
      expect(out, argv[0]).toMatch(/cap:store\s+sqlite missing .* → a run would provision a local sqlite/);
      expect(out, argv[0]).toMatch(/provision\s+local: tmpdir, git-remote, sqlite, http-stub · at most 4 per run · 3600s lifetime/);
    }
  }, 300_000);
});

describe('goal files with criteria (front matter)', () => {
  const m = loadManifest(SAMPLE).manifest;
  const file = (front: string): string => `---\nid: g1\nkind: achievement\nverify: node --test\n${front}\n---\nDo the thing.\n`;
  it('verify / ask / timeoutSec / requires become an acceptance contract bound by its hash; a file without criteria keeps the single-check path', () => {
    const g = parseGoalFile(file(`criteria: [{"id": "a", "statement": "it builds", "verify": "node build.js", "timeoutSec": 30, "requires": ["db"]}, {"id": "b", "statement": "reads well", "ask": "Is the README clear?"}]`), m);
    expect(g.goalId).toBe('g1');
    expect(g.contract!.criteria).toEqual([
      { id: 'a', statement: 'it builds', check: { kind: 'command', command: 'node build.js', timeoutSec: 30 }, requires: ['db'] },
      { id: 'b', statement: 'reads well', check: { kind: 'human', prompt: 'Is the README clear?' } },
    ]);
    expect(g.contractHash).toBe(contractHash(g.contract!));
    // the goal's check timeout is a criterion's default
    expect(parseGoalFile(file(`timeoutSec: 45\ncriteria: [{"id": "a", "statement": "s", "verify": "x"}]`), m).contract!.criteria[0]!.check).toEqual({ kind: 'command', command: 'x', timeoutSec: 45 });
    const plain = parseGoalFile(file(''), m);
    expect(plain.contract).toBeUndefined();
    expect(plain.contractHash).toBeUndefined();
  });
  it('a criterion needs exactly one of verify or ask; human judgment alone is no contract; unknown keys are refused', () => {
    expect(() => parseGoalFile(file(`criteria: [{"id": "a", "statement": "s"}]`), m)).toThrow(GoalError);
    expect(() => parseGoalFile(file(`criteria: [{"id": "a", "statement": "s", "verify": "x", "ask": "y"}]`), m)).toThrow(/exactly one of verify/);
    expect(() => parseGoalFile(file(`criteria: [{"id": "a", "statement": "s", "ask": "y"}]`), m)).toThrow(/at least one command criterion/);
    expect(() => parseGoalFile(file(`criteria: [{"id": "a", "statement": "s", "verify": "x", "weight": 2}]`), m)).toThrow(GoalError);
    expect(() => parseGoalFile(file(`criteria: []`), m)).toThrow(GoalError);
    expect(() => parseGoalFile(file(`criteria: [{"id": "a", "statement": "s", "verify": "x"}, {"id": "a", "statement": "t", "verify": "y"}]`), m)).toThrow(/appears twice/);
  });
});

describe('carried-over L5 regressions', () => {
  it('L5-F1: an ad hoc statement has one canonical slug for its goal id and branch name (no shared `adhoc`)', () => {
    const m = loadManifest(SAMPLE).manifest;
    const a = resolveGoal(SAMPLE, 'make the failing test pass', m);
    expect(a).toMatchObject({ id: 'make-the-failing-test-pass', goalId: 'make-the-failing-test-pass', source: 'statement' });
    expect(resolveGoal(SAMPLE, 'add CSV export', m).id).not.toBe(a.id);
    // a goal file resolves by id, with or without the old g_ prefix, to the same ledger id
    expect(resolveGoal(SAMPLE, 'g_fix-failing-test', m).goalId).toBe('fix-failing-test');
  });

  it('L5-F3: the default worktree root is one the verify uid can traverse; a home it cannot (0700) moves it to a per-uid temp dir', () => {
    const closed = tmp('tecera-home-');
    chmodSync(closed, 0o700);
    expect(othersTraverse(closed)).toBe(false);
    const t = tmp('tecera-tmp-');
    chmodSync(t, 0o755);
    const uid = typeof process.geteuid === 'function' ? process.geteuid() : 'user';
    expect(worktreesRoot({}, { home: closed, tmp: t })).toBe(join(t, `tecera-${uid}`, 'worktrees'));
    const open = tmp('tecera-home-');
    chmodSync(open, 0o711);
    expect(othersTraverse(open)).toBe(true);
    expect(worktreesRoot({}, { home: open, tmp: t })).toBe(join(open, '.tecera', 'worktrees'));
    expect(worktreesRoot({ TECERA_WORKTREES: '/srv/wt' }, { home: closed })).toBe('/srv/wt');
  });

  it('L5-F3: a run creates its worktree root traversable (0711) so the contained check can enter the worktree', async () => {
    const { dir, res } = await sampleRepo();
    const wtRoot = join(tmp('tecera-wtroot-'), 'nested', 'worktrees');
    const env = { ...KEYS, TECERA_WORKTREES: wtRoot, TECERA_RESOURCES: res };
    const contract = { criteria: [{ id: 'tests-pass', statement: 's', check: { kind: 'command', command: 'node --test', timeoutSec: 60 } }] };
    const r = await cli(dir, ['run', 'make the failing test pass', '--scripted', scripts({ contract, replies: {} })], { env });
    expect(r.code, r.err + r.out).toBe(EXIT.held);
    const { statSync } = await import('node:fs');
    expect(statSync(wtRoot).mode & 0o777).toBe(0o711);
  }, 120_000);

  it('L5-F4: .tecera/.gitignore of the sample, the template and their bundled copies ignores the ledger and all its sidecar files', async () => {
    for (const p of ['samples/fix-failing-test', 'templates/business-case', 'packages/runtime/assets/samples/fix-failing-test', 'packages/runtime/assets/templates/business-case']) {
      expect(readFileSync(join(REPO, p, '.tecera/.gitignore'), 'utf8').split('\n')).toContain('ledger.sqlite*');
    }
    const { dir } = await sampleRepo();
    mkdirSync(join(dir, '.tecera'), { recursive: true });
    for (const f of ['ledger.sqlite-wal', 'ledger.sqlite-shm', 'ledger.sqlite-journal']) writeFileSync(join(dir, '.tecera', f), '');
    expect(git(dir, 'status', '--porcelain').trim()).toBe('');
  }, 120_000);
});

describe('review repairs', () => {
  it('a goal file id may not start with g_ (the prefix refers to a goal file, so one goal would have two names)', () => {
    const m = loadManifest(SAMPLE).manifest;
    expect(() => parseGoalFile('---\nid: g_tests\nkind: achievement\n---\nDo it.\n', m)).toThrow(/g_ prefix is reserved/);
    expect(parseGoalFile('---\nid: tests\nkind: achievement\n---\nDo it.\n', m).goalId).toBe('tests');
  });

  it('worker resource tools and the PR remote: nothing while the registry reports a problem or a resource past the allowance; the remote is an absolute local path only', () => {
    const r = (o: Partial<ProvisionedResource> = {}): ProvisionedResource => ({ id: 'res1', capability: 'origin', kind: 'git-remote', provider: 'local', locator: '/tmp/tecera-res/res1/remote.git', teardown: "rm -rf -- '/tmp/tecera-res/res1'", createdAt: 1, expiresAt: 3_600_001, transfer: 'pending', ...o });
    const clean = { pending: [r()], problems: [], overAllowance: [] };
    expect(usableResources(clean)).toEqual([r()]);
    expect(pushableRemote(clean)).toEqual(r());
    expect(usableResources({ ...clean, overAllowance: ['res1'] })).toEqual([]);
    expect(usableResources({ ...clean, problems: ['resource.provisioned x: names run y'] })).toEqual([]);
    expect(pushableRemote({ ...clean, overAllowance: ['res2'] })).toBeNull();
    for (const locator of ['https://attacker.example/x.git', '//attacker.example/x', 'ext::sh -c id', 'git@github.com:o/r.git', 'relative/r.git']) expect(pushableRemote({ ...clean, pending: [r({ locator })] }), locator).toBeNull();
    // from the ledger: a third sqlite past maxResources 2 makes the whole run's set unusable
    const allowance = { scope: 'local' as const, kinds: ['sqlite', 'git-remote'], maxResources: 2, ttlSec: 3600 };
    const evs = [1, 2, 3].map((i) => event('resource.provisioned', { id: `rp${i}`, at: i, actor: { kind: 'system', id: 'loop' }, runId: 'r1', trace: { goalId: 'g' }, payload: { resource: r({ id: `res${i}`, capability: `db${i}`, kind: 'sqlite', locator: `/tmp/tecera-res/res${i}/db.sqlite` }) as unknown as JsonObject } }));
    const reg = resourceRegistryOf(evs, { runId: 'r1', allowance });
    expect(reg.pending).toHaveLength(3);
    expect(usableResources(reg)).toEqual([]);
    expect(usableResources(resourceRegistryOf(evs.slice(0, 2), { runId: 'r1', allowance }))).toHaveLength(2);
  });

  it('the PR remote lies under the resources root and outside the repository: a recorded git remote anywhere else is never pushed to', () => {
    const root = mkdtempSync(join(tmpdir(), 'tecera-rt-res-'));
    const repo = mkdtempSync(join(tmpdir(), 'tecera-rt-repo-'));
    const place = { root, repoRoot: repo };
    const r = (locator: string): ProvisionedResource => ({ id: 'res1', capability: 'origin', kind: 'git-remote', provider: 'local', locator, teardown: `rm -rf -- '${locator}'`, createdAt: 1, expiresAt: 3_600_001, transfer: 'pending' });
    const reg = (locator: string) => ({ pending: [r(locator)], problems: [], overAllowance: [] });
    expect(pushableRemote(reg(join(root, 'res1', 'remote.git')), place)?.id).toBe('res1');
    for (const locator of [join(repo, 'vendor', 'remote.git'), repo, root, join(tmpdir(), 'elsewhere.git'), join(root, '..', 'escape.git')]) expect(pushableRemote(reg(locator), place), locator).toBeNull();
    // a resources root that is itself inside the repository places nothing
    expect(pushableRemote(reg(join(repo, 'res', 'remote.git')), { root: join(repo, 'res'), repoRoot: repo })).toBeNull();
    // without a place only the shape is checked (what the wiring uses to name a stray remote it refuses)
    expect(pushableRemote(reg(join(repo, 'vendor', 'remote.git')))?.id).toBe('res1');
    expect(locatorWithin(join(root, 'a'), root, repo)).toBe(true);
    expect(locatorWithin('relative/a', root, repo)).toBe(false);
  });

  it('criteria accept and amend refuse on a ledger whose hash chain is broken (exit 9, nothing recorded)', async () => {
    const { dir, wt, res } = await sampleRepo();
    const env = { ...KEYS, TECERA_WORKTREES: wt, TECERA_RESOURCES: res };
    const contract = { criteria: [{ id: 'tests-pass', statement: 's', check: { kind: 'command', command: 'node --test', timeoutSec: 60 } }] };
    const seg1 = await cli(dir, ['run', 'make the failing test pass', '--scripted', scripts({ contract, replies: {} })], { env });
    expect(seg1.code, seg1.err + seg1.out).toBe(EXIT.held);
    const before = await events(dir);
    const runId = runIdOf(before);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(dir, '.tecera/ledger.sqlite'));
    db.exec('DROP TRIGGER events_no_update');
    db.exec("UPDATE events SET payload = '{\"tampered\":true}' WHERE seq = 2");
    db.close();
    const accept = await cli(dir, ['criteria', 'accept', runId, '--as', 'requestor-human'], { env });
    expect(accept.code, accept.err + accept.out).toBe(EXIT.ledger);
    expect(accept.err).toMatch(/hash chain is broken/);
    const file = join(tmp('tecera-amend-'), 'contract.json');
    writeFileSync(file, JSON.stringify({ criteria: [{ id: 'other', statement: 't', check: { kind: 'command', command: 'node --test test/slugify.test.js', timeoutSec: 60 } }] }));
    const amend = await cli(dir, ['criteria', 'amend', runId, '--file', file, '--reason', 'r', '--as', 'requestor-human'], { env });
    expect(amend.code, amend.err + amend.out).toBe(EXIT.ledger);
    const kinds = (await events(dir)).map((e) => e.kind);
    expect(kinds).not.toContain('approval.granted');
    expect(kinds).not.toContain('criteria.amended');
    expect(kinds.length).toBe(before.length);
  }, 300_000);

  it('the durable run deadline stops a running worker step (its tools, not only its model calls) when budgets are enforced: the loop aborts the step signal the worker port receives', async () => {
    const { dir, wt, res } = await sampleRepo(manifestEdit((m) => {
      (m.budgets as Record<string, unknown>).enforce = true;
      (m.budgets as Record<string, unknown>).wallClockSec = 300;
    }));
    const env = { ...KEYS, TECERA_WORKTREES: wt, TECERA_RESOURCES: res };
    const contract = { criteria: [{ id: 'tests-pass', statement: 's', check: { kind: 'command', command: 'node --test', timeoutSec: 60 } }] };
    const seg1 = await cli(dir, ['run', 'make the failing test pass', '--scripted', scripts({ contract, replies: {} })], { env });
    expect(seg1.code, seg1.err + seg1.out).toBe(EXIT.held);
    const evs = await events(dir);
    const runId = runIdOf(evs);
    const deadline = (evs.find((e) => e.kind === 'run.started')!.payload as { deadline: number }).deadline;
    expect((await cli(dir, ['criteria', 'accept', runId, '--as', 'requestor-human'], { env })).code).toBe(0);
    // the resume starts 8 s before the durable deadline; the analyze step then spins until its 60 s exec timeout
    const hang = { worker: [{ expect: 'Read the failing test and the implementation under test', text: "```js\nwhile (true) {}\n```" }], reviewer: [] };
    const plan = fixturePlan() as ReturnType<typeof fixturePlan> & { budget: Record<string, number> };
    plan.budget.wallClockSec = 300;
    const t0 = Date.now();
    const skew = deadline - 8000 - t0;
    const seg2 = await cli(dir, ['run', '--resume', runId, '--scripted', scripts({ contract, plan, replies: hang })], { env, now: () => Date.now() + skew });
    const took = Date.now() - t0;
    if (seg2.code !== EXIT.budget) console.log(await dump(dir));
    expect(seg2.code, seg2.err + seg2.out).toBe(EXIT.budget);
    expect(took, 'the step was stopped at the deadline, not left to finish its sleep').toBeLessThan(35_000);
    const after = await events(dir);
    expect(after.some((e) => e.kind === 'step.started')).toBe(true);
  }, 300_000);
});
