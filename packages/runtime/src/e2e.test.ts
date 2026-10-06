import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { LedgerError, prActionHash, type Ledger, type TeceraEvent } from '@tecera/contracts';
import { SqliteLedger } from '@tecera/ledger';
import { main, type MainOptions } from './cli/main.js';
import { replayRun } from './replay.js';
import { createWiring, type WireFn } from './wiring.js';

/**
 * End to end through `tecera run` on samples/fix-failing-test with scripted models: real ledger, real
 * provider adapters (scripted transport: OpenRouter for the Claude seats, OpenAI for the reviewer), real
 * worker sandbox child, real verify runner, real gates and git. Everything lives under os.tmpdir().
 *
 * The owner decisions this proves end to end: writes to the work branch proceed under node isolation with
 * no approval (D6), the commit lands on tecera/<goal> without approval, the run holds only at the PR
 * (exit 4), a local human principal approves it (D1), the resume pushes / opens the PR or records
 * pr.requested with a patch bundle (never merges), goal.achieved carries its proof (D4) and the Stop hook
 * blocks before and allows after. Budgets are reported, never a stop, unless budgets.enforce (D3).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const SAMPLE = join(REPO, 'samples/fix-failing-test');
const FIXTURES = resolve(HERE, '../test-fixtures/fix-failing-test');

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix = 'tecera-e2e-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

/**
 * This host runs the tests as root and its node binary is not readable by an unprivileged uid, so the
 * verify runner (which refuses a root identity by default) is allowed a degraded root verify here, by the
 * operator switch, recorded as verify.degraded. A non-root host needs nothing.
 */
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
  const code = await main(argv, {
    cwd,
    env: { ...ENV, ...(extraEnv ?? {}) },
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    isTTY: false,
    ids: (p) => `${p}_e${++idn}`,
    ...rest,
  });
  return { code, out, err };
}

async function events(dir: string): Promise<Array<TeceraEvent & { seq: number; hash: string }>> {
  const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
  const out: Array<TeceraEvent & { seq: number; hash: string }> = [];
  for await (const e of l.events()) out.push(e);
  l.close();
  return out;
}

/**
 * A temp copy of samples/fix-failing-test exactly as shipped (manifest verify.command, the goal file's
 * `verify:` line and package.json scripts.test are all `node --test`), initialised and committed as a git
 * repository on `main`. NOTHING in the copy is rewritten: the shipped sample runs unmodified.
 *
 * Guard: this host's global npm must never run (its lib/cli.js carries injected code). Every check command
 * in the copy (manifest verify, goal `verify:` lines, scripts.test) is asserted npm-free BEFORE anything runs;
 * a sample that still said `npm test` fails here instead of being patched.
 */
function goalFile(dir: string): string {
  return join(dir, '.tecera/goals/fix-failing-test.goal.md');
}
const NPM = /(^|[\s;&|])(npm|npx)(\s|$)/;
async function sampleRepo(mutate?: (dir: string) => void): Promise<{ dir: string; wt: string }> {
  const dir = tmp();
  cpSync(SAMPLE, dir, { recursive: true, filter: (src) => !/node_modules|ledger\.sqlite|[\\/]runs([\\/]|$)/.test(src) });
  const manifest = JSON.parse(readFileSync(join(dir, 'tecera.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  expect(manifest.verify.command).toBe('node --test');
  expect(pkg.scripts.test).toBe('node --test');
  expect(readFileSync(goalFile(dir), 'utf8')).toMatch(/^verify: node --test$/m);
  mutate?.(dir);
  for (const c of [manifest.verify.command, pkg.scripts.test, ...[...readFileSync(goalFile(dir), 'utf8').matchAll(/^verify: (.*)$/gm)].map((m) => m[1]!)]) expect(NPM.test(c), `check command "${c}" would run npm`).toBe(false);
  const r = await cli(dir, ['init']);
  expect(r.code, r.err).toBe(0);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const wt = tmp('tecera-wt-');
  return { dir, wt };
}

/** A scripts dir: the sample plan plus the given replies (defaults: the shipped fixture). */
function scripts(replies?: Record<string, unknown>): string {
  const d = tmp('tecera-scripts-');
  cpSync(join(FIXTURES, 'plan.json'), join(d, 'plan.json'));
  writeFileSync(join(d, 'replies.json'), JSON.stringify(replies ?? JSON.parse(readFileSync(join(FIXTURES, 'replies.json'), 'utf8'))));
  return d;
}
type Reply = { text: string; expect?: string; usage?: unknown };
const fixtureReplies = (): { worker: Reply[]; reviewer: Reply[] } => JSON.parse(readFileSync(join(FIXTURES, 'replies.json'), 'utf8'));
const js = (body: string): string => `\`\`\`js\n${body}\n\`\`\``;

/** The newest pending approval (approval.requested, or a worker-owned step.held) not yet decided or consumed. */
function pendingRequest(evs: TeceraEvent[]): TeceraEvent | undefined {
  const closed = new Set(evs.filter((e) => ['approval.granted', 'approval.denied', 'approval.expired', 'approval.consumed'].includes(e.kind)).map((e) => (e.payload as { requestId?: string }).requestId));
  return [...evs].reverse().find((e) => (e.kind === 'approval.requested' || (e.kind === 'step.held' && (e.payload as { owner?: string }).owner === 'worker')) && !closed.has((e.payload as { requestId: string }).requestId));
}

/**
 * Approve the pending request (the local human principal, D1) and resume the run in scripted mode with
 * `replies` (scripted replies are served from the start in every process, so each resume segment gets the
 * replies of the model calls it will make).
 */
async function approveAndResume(dir: string, env: Record<string, string>, replies: Record<string, unknown>, opts: MainOptions = {}, approver = 'reviewer-human'): Promise<{ held: TeceraEvent; requestId: string; approve: { code: number; out: string; err: string }; resumed: { code: number; out: string; err: string } }> {
  const held = pendingRequest(await events(dir));
  expect(held, 'a pending approval').toBeTruthy();
  const requestId = (held!.payload as { requestId: string }).requestId;
  const approve = await cli(dir, ['approve', requestId, '--as', approver, '--yes'], { env });
  expect(approve.code, approve.err).toBe(0);
  const resumed = await cli(dir, ['run', '--resume', held!.runId!, '--scripted', scripts(replies)], { env, ...opts });
  return { held: held!, requestId, approve, resumed };
}

const SRC_BEFORE = readFileSync(join(SAMPLE, 'src/slugify.js'), 'utf8');

async function dump(dir: string): Promise<string> {
  const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
  const lines: string[] = [];
  for await (const e of l.events()) {
    lines.push(`${e.seq} ${e.kind} ${e.trace.stepId ?? ''} ${JSON.stringify(e.payload).slice(0, 600)}`);
    const k = (e.payload as { evidenceKey?: string }).evidenceKey;
    if (k) lines.push(`    evidence ${JSON.stringify((await l.getEvidence(k))?.body).slice(0, 1500)}`);
  }
  l.close();
  return lines.join('\n');
}

/** Ordered subsequence check: every kind appears, in this order. */
function inOrder(kinds: string[], want: string[]): void {
  let i = 0;
  for (const k of kinds) if (k === want[i]) i++;
  expect(want.slice(i), `missing or out of order after ${want.slice(0, i).join(' → ')}; kinds: ${kinds.join(' ')}`).toEqual([]);
}

/** The sample with budgets.enforce true (D3: exhaustion ends the run). */
const enforced = (d: string): void => {
  const p = join(d, 'tecera.json');
  const m = JSON.parse(readFileSync(p, 'utf8'));
  m.budgets.enforce = true;
  writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`);
};

/** A bare repository as `origin` of the business case, and a fake gh first on PATH that logs its calls. */
function remoteAndGh(dir: string, o: { authenticated?: boolean } = {}): { bare: string; bin: string; log: string; path: string } {
  const bare = tmp('tecera-remote-');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env: { PATH: process.env.PATH ?? '', HOME: bare, GIT_CONFIG_GLOBAL: '/dev/null' } });
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', 'origin', 'main');
  const bin = tmp('tecera-gh-');
  const log = join(bin, 'gh.log');
  const auth = o.authenticated === false ? 'exit 1' : 'exit 0';
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\nprintf '%s\\n' "ARGS $*" >> '${log}'\nenv | cut -d= -f1 | sed 's/^/ENV /' >> '${log}'\ncase "$1 $2" in\n  "auth status") ${auth} ;;\n  "pr create") cat > '${bin}/body.md'; echo "https://github.example/acme/fix-failing-test/pull/7"; exit 0 ;;\nesac\nexit 3\n`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  return { bare, bin, log, path: `${bin}:${process.env.PATH ?? ''}` };
}

const stopHook = (dir: string, extra: Record<string, unknown> = {}) => cli(dir, ['hook', 'stop'], { stdin: JSON.stringify({ hook_event_name: 'Stop', cwd: dir, session_id: 'cc-1', stop_hook_active: false, ...extra }) });

describe('tecera run end to end (scripted models, real sandbox, real gates)', () => {
  it('acceptance on the sample as shipped (unmodified): writes and the commit proceed without approval under node isolation, the run holds only at the PR (exit 4), the Stop hook blocks; approve → resume records pr.requested with a patch bundle (no remote), goal.achieved carries its proof, the Stop hook allows; cost, evidence, why, staging and strict offline replay', async () => {
    const { dir, wt } = await sampleRepo();
    const fx = fixtureReplies();
    const env = { ...KEYS, TECERA_WORKTREES: wt };
    expect((await stopHook(dir)).code, 'no run yet: stopping is allowed').toBe(0);

    // segment 1: baseline, plan, both worker steps (the test edit denied, the src write landing), verify,
    // review, verify, the commit on the work branch — then the PR holds
    const run = await cli(dir, ['run', 'fix-failing-test', '--scripted', scripts({ worker: fx.worker, reviewer: fx.reviewer })], { env });
    if (run.code !== 4) console.log(await dump(dir));
    expect(run.code, run.err + run.out).toBe(4);
    let evs = await events(dir);
    const runId = evs.find((e) => e.kind === 'run.started')!.runId!;
    const wtSrc = join(wt, runId, 'src/slugify.js');
    expect(evs.some((e) => e.kind === 'isolation.degraded')).toBe(true);
    // D6: nothing held before the PR, no per-write approval
    expect(evs.filter((e) => e.kind === 'approval.requested')).toHaveLength(1);
    expect(evs.filter((e) => e.kind === 'step.held')).toHaveLength(1);
    const held = pendingRequest(evs)!;
    expect(held.trace.stepId).toBe('pr');
    const commit = evs.find((e) => e.kind === 'commit.recorded')!;
    const sha = (commit.payload as { sha: string }).sha;
    expect(commit.payload).toMatchObject({ valid: true });
    expect(evs.indexOf(commit)).toBeLessThan(evs.indexOf(held));
    expect(held.payload).toMatchObject({ owner: 'gate', sha });
    expect((held.payload as { actionHash: string }).actionHash).toBe(prActionHash({ intentionId: held.trace.intentionId!, stepId: 'pr', attempt: (held.payload as { attempt: number }).attempt, sha }));
    // the commit is on tecera/fix-failing-test in the repository: src only, the test untouched, no approval
    expect(git(dir, 'rev-parse', 'tecera/fix-failing-test').trim()).toBe(sha);
    expect(git(dir, 'diff', '--name-only', 'main', sha).trim().split('\n')).toEqual(['src/slugify.js']);
    expect(git(dir, 'show', `${sha}:src/slugify.js`)).toContain(".replace(/[^a-z0-9]+/g, '-')");
    expect(git(dir, 'show', `${sha}:test/slugify.test.js`)).toBe(git(dir, 'show', 'main:test/slugify.test.js'));
    expect(readFileSync(join(dir, 'src/slugify.js'), 'utf8'), 'the developer checkout is untouched').toContain("'-'.repeat(m.length)");
    expect(readFileSync(wtSrc, 'utf8')).not.toBe(SRC_BEFORE);
    expect(evs.some((e) => e.kind === 'approval.consumed')).toBe(false);
    for (const k of ['pr.requested', 'pr.opened', 'goal.achieved', 'plan.staged']) expect(evs.map((e) => e.kind)).not.toContain(k);
    // the run reports what it cost: per model (Claude seats through OpenRouter, the reviewer through OpenAI)
    expect(run.out).toMatch(/^cost {7}\$\d+\.\d{4} · [\d,]+ tokens · \d+ model call\(s\) · usd pool \$\d+\.\d{4}\/\$2\.0000 incl\. reservations \(not enforced\) · by model: .*openrouter\/anthropic\/claude-haiku-4\.5/m);
    expect(run.out).toMatch(/openai\/gpt-5\.6-terra \$\d/);
    expect(run.out).toMatch(/held for PR approval/);

    // D4: the assistant may not stop while the run is held without a proof
    const blocked = await stopHook(dir);
    expect(blocked.code).toBe(2);
    expect(blocked.err).toMatch(new RegExp(`goal not achieved: run ${runId} \\(goal g_fix-failing-test\\) is held for a human decision and has no goal.achieved proof`));

    // segment 2: a local human approves the PR (D1: $USER); the resume delivers it — no remote: pr.requested
    const s2 = await approveAndResume(dir, env, {}, {}, 'reviewer-human');
    if (s2.resumed.code !== 0) console.log(await dump(dir));
    expect(s2.resumed.code, s2.resumed.err + s2.resumed.out).toBe(0);
    expect(s2.approve.out).toMatch(/approved \S+ as reviewer-human \(local principal, --as\)/);
    evs = await events(dir);
    const mine = evs.filter((e) => e.runId === runId);
    const kinds = mine.map((e) => e.kind);
    inOrder(kinds, [
      'goal.adopted', 'plan.generated', 'intention.pushed',
      'step.requested', 'step.completed', // analyze
      'step.requested', 'step.completed', // edit (its write landed, no approval)
      'verify.passed', 'review.passed', 'verify.passed', 'commit.recorded',
      'approval.requested', 'step.held', 'run.ended',
      'approval.granted', 'approval.consumed', 'pr.requested', 'goal.achieved', 'plan.staged', 'run.ended',
    ]);
    expect(kinds.filter((k) => k === 'plan.staged')).toHaveLength(1);
    const pr = mine.find((e) => e.kind === 'pr.requested')!;
    expect(pr.payload).toMatchObject({ sha, branch: 'tecera/fix-failing-test', base: 'main', approvalRequestId: s2.requestId });
    const prDir = join(dir, '.tecera/runs', runId, 'pr');
    expect(existsSync(join(prDir, `${sha}.patch`)), 'the patch bundle is under .tecera/runs/<run>/pr/').toBe(true);
    expect(readFileSync(join(prDir, `${sha}.patch`), 'utf8')).toContain('src/slugify.js');
    expect(JSON.parse(readFileSync(join(prDir, 'request.json'), 'utf8'))).toMatchObject({ sha, branch: 'tecera/fix-failing-test', base: 'main' });
    expect(mine.filter((e) => e.kind === 'approval.consumed')).toHaveLength(1);
    expect(mine.find((e) => e.kind === 'approval.consumed')!.payload).toMatchObject({ requestId: s2.requestId, by: 'gate.pr' });
    // D4: goal.achieved carries the proof of the final verify
    const achieved = mine.find((e) => e.kind === 'goal.achieved')!;
    const lastVerify = [...mine].reverse().find((e) => e.kind === 'verify.passed')!;
    expect((achieved.payload as { proof: unknown }).proof).toMatchObject({ command: 'node --test', exitCode: 0, fingerprint: (lastVerify.payload as { fingerprint: string }).fingerprint, evidenceKey: (lastVerify.payload as { evidenceKey: string }).evidenceKey });
    // the denied test edit is evidence and an event
    const denied = mine.find((e) => e.kind === 'evidence.appended' && (e.payload as { kind?: string }).kind === 'tool.denied')!;
    expect(denied, kinds.join(' ')).toBeTruthy();
    expect(denied.payload).toMatchObject({ tool: 'edit', path: 'test/slugify.test.js' });
    const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
    expect(JSON.stringify((await l.getEvidence((denied.payload as { evidenceKey: string }).evidenceKey))?.body)).toMatch(/protected/);
    expect((await l.verifyChain()).ok).toBe(true);
    l.close();

    // D4: with the proof recorded the assistant may stop; both decisions are in the ledger
    const allowed = await stopHook(dir);
    expect(allowed.code, allowed.err).toBe(0);
    expect(allowed.out).toMatch(/proved its goal: `node --test` exited 0/);
    const stops = (await events(dir)).filter((e) => e.kind === 'stop.blocked' || e.kind === 'stop.allowed').map((e) => e.kind);
    expect(stops).toEqual(['stop.allowed', 'stop.blocked', 'stop.allowed']);
    // README transcript: TECERA_E2E_TRANSCRIPT=<file under os.tmpdir()> writes it out.
    if (process.env.TECERA_E2E_TRANSCRIPT) {
      const transcript = [
        '$ tecera run fix-failing-test --scripted <fixtures>',
        run.out.trim(),
        `→ exit ${run.code}`,
        '$ tecera hook stop          # Claude Code Stop hook, payload on stdin',
        blocked.err.trim(),
        `→ exit ${blocked.code}`,
        `$ tecera approve ${s2.requestId} --as reviewer-human --yes`,
        s2.approve.out.trim(),
        `$ tecera run --resume ${runId} --scripted <fixtures>`,
        s2.resumed.out.trim(),
        `→ exit ${s2.resumed.code}`,
        '$ tecera hook stop',
        allowed.out.trim(),
        `→ exit ${allowed.code}`,
      ].join('\n');
      writeFileSync(process.env.TECERA_E2E_TRANSCRIPT, `${transcript}\n`);
      writeFileSync(`${process.env.TECERA_E2E_TRANSCRIPT}.events`, `${mine.map((e) => e.kind).filter((k) => k !== 'decision.recorded' && k !== 'belief.added').join(' ')}\n`);
    }

    // why walks the PR event
    const why = await cli(dir, ['why', pr.id]);
    expect(why.code, why.err).toBe(0);
    expect(why.out).toMatch(/^action\s+pr\.requested/m);
    expect(why.out).toMatch(/^plan\s+p_a529e0b9\s+plan\.generated → plan\.staged/m);

    // evidence export: summary with the proof, the PR and the cost per step / per model
    const ex = await cli(dir, ['evidence', runId]);
    expect(ex.code, ex.err).toBe(0);
    const out = join(dir, '.tecera/runs', runId);
    const summary = readFileSync(join(out, 'summary.md'), 'utf8');
    expect(summary).toMatch(/- proof: `node --test` exit 0 on /);
    expect(summary).toMatch(/- PR requested \(no remote or gh\): tecera\/fix-failing-test → main/);
    expect(summary).toMatch(/## Cost/);
    expect(summary).toMatch(/### Per step[\s\S]*\| edit@\S+ \| 1 \|/);
    expect(summary).toMatch(/### Per model[\s\S]*\| openrouter\/anthropic\/claude-haiku-4\.5 \| 2 \|/);
    expect(summary).toMatch(/\| openai\/gpt-5\.6-terra \| 1 \|/);
    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    expect(index.missing).toEqual([]);
    expect(Object.values(index.evidence as Record<string, { kind: string }>).map((x) => x.kind)).toEqual(expect.arrayContaining(['tool.denied', 'gate.verify', 'gate.review', 'gate.commit', 'gate.pr', 'run.scripted', 'worktree.leased']));

    // offline replay re-derives goal.achieved from the ledger alone: PR approval accounted for, proof matched
    const l2 = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
    const replay = await replayRun(l2, runId);
    l2.close();
    expect(replay.chainValid).toBe(true);
    expect(replay.goals['g_fix-failing-test'], JSON.stringify(replay)).toMatchObject({ derived: 'achieved', recorded: 'achieved', agrees: true });
    expect(replay.problems).toEqual([]);

    const st = await cli(dir, ['status', '--run', runId]);
    expect(st.out).toMatch(/exit 0/);
    expect(st.out).toMatch(/^cost {7}\$\d+\.\d{4}/m);
    expect(st.out).toMatch(/1 candidate\(s\) awaiting review/);
    const again = await cli(dir, ['run', '--resume', runId, '--scripted', scripts({})], { env });
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/nothing to resume/);
    // Tecera never merges: main is where it was
    expect(git(dir, 'rev-parse', 'main').trim()).toBe(git(dir, 'rev-parse', `${sha}^`).trim());
  }, 600_000);

  it('with an origin remote and an authenticated gh: the approved PR pushes the work branch and opens the PR (pr.opened with its url); gh never sees a model key and nothing merges', async () => {
    const { dir, wt } = await sampleRepo();
    const fx = fixtureReplies();
    const r = remoteAndGh(dir);
    const env = { ...KEYS, TECERA_WORKTREES: wt, PATH: r.path };
    const run = await cli(dir, ['run', 'fix-failing-test', '--scripted', scripts({ worker: fx.worker, reviewer: fx.reviewer })], { env });
    if (run.code !== 4) console.log(await dump(dir));
    expect(run.code, run.err + run.out).toBe(4);
    expect(existsSync(r.log), 'gh is not called before the approval').toBe(false);
    expect(git(r.bare, 'branch', '--list', 'tecera/*').trim(), 'nothing pushed before the approval').toBe('');
    const s = await approveAndResume(dir, env, {});
    if (s.resumed.code !== 0) console.log(await dump(dir));
    expect(s.resumed.code, s.resumed.err + s.resumed.out).toBe(0);
    const evs = await events(dir);
    const opened = evs.find((e) => e.kind === 'pr.opened')!;
    const sha = (evs.find((e) => e.kind === 'commit.recorded')!.payload as { sha: string }).sha;
    expect(opened.payload).toMatchObject({ url: 'https://github.example/acme/fix-failing-test/pull/7', sha, branch: 'tecera/fix-failing-test', pushed: true });
    expect(evs.map((e) => e.kind)).not.toContain('pr.requested');
    expect(git(r.bare, 'rev-parse', 'refs/heads/tecera/fix-failing-test').trim()).toBe(sha);
    expect(git(r.bare, 'rev-parse', 'refs/heads/main').trim(), 'the base branch was never pushed to').toBe(git(dir, 'rev-parse', 'main').trim());
    const log = readFileSync(r.log, 'utf8');
    expect(log).toMatch(/^ARGS auth status$/m);
    expect(log).toMatch(/^ARGS pr create --base main --head tecera\/fix-failing-test --title /m);
    expect(log).not.toMatch(/merge/);
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY']) expect(log).not.toContain(`ENV ${k}`);
    expect(readFileSync(join(r.bin, 'body.md'), 'utf8')).toMatch(/node --test/);
    expect((await stopHook(dir)).code).toBe(0);
  }, 600_000);

  it('the bundled `tecera init --sample` asset (what an installed package ships) is byte-identical to the sample and runs UNMODIFIED to a delivered PR (exit 0), its checks npm-free', async () => {
    const pkg = tmp('tecera-pkg-');
    execFileSync(process.execPath, [join(HERE, '..', 'scripts', 'copy-assets.mjs'), join(pkg, 'assets')]);
    const dir = tmp();
    const init = await cli(dir, ['init', '--sample'], { assetsRoot: join(pkg, 'assets') });
    expect(init.code, init.err).toBe(0);
    // byte-identical to samples/fix-failing-test (the asset is a copy, nothing rewritten)
    const walk = (d: string, rel = ''): string[] => readdirSync(join(d, rel), { withFileTypes: true }).flatMap((n) => (/^(node_modules|runs|\.git)$|^ledger\.sqlite/.test(n.name) ? [] : n.isDirectory() ? walk(d, join(rel, n.name)) : [join(rel, n.name)]));
    for (const f of walk(SAMPLE)) expect(readFileSync(join(dir, f)).equals(readFileSync(join(SAMPLE, f))), f).toBe(true);
    expect(readFileSync(goalFile(dir), 'utf8')).toMatch(/^verify: node --test$/m);
    const manifest = JSON.parse(readFileSync(join(dir, 'tecera.json'), 'utf8'));
    for (const c of [manifest.verify.command, JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts.test, ...[...readFileSync(goalFile(dir), 'utf8').matchAll(/^verify: (.*)$/gm)].map((m) => m[1]!)]) expect(NPM.test(c), c).toBe(false);
    // the shipped defaults (D2/D3/D5/D6/D7)
    expect(manifest.budgets.enforce).toBe(false);
    expect(manifest.review.foreign).toBe(true);
    expect(manifest.policy.approvals.required).toEqual(['open_pr']);
    expect(Object.values(manifest.reflexes).filter((v) => typeof v === 'string')).not.toContain('off');
    expect(manifest.seats.planner).toMatchObject({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' });
    expect(manifest.seats.workers[0]).toMatchObject({ provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' });
    expect(manifest.seats.reviewer).toMatchObject({ provider: 'openai', model: 'gpt-5.6-terra' });
    if (!existsSync(join(dir, 'tecera.lock'))) expect((await cli(dir, ['init'])).code).toBe(0);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    const wt = tmp('tecera-wt-');
    const env = { ...KEYS, TECERA_WORKTREES: wt };
    const fx = fixtureReplies();
    let code = (await cli(dir, ['run', 'fix-failing-test', '--scripted', scripts({ worker: fx.worker, reviewer: fx.reviewer })], { env })).code;
    expect(code).toBe(4);
    code = (await approveAndResume(dir, env, {})).resumed.code;
    if (code !== 0) console.log(await dump(dir));
    expect(code).toBe(0);
    const evs = await events(dir);
    expect(evs.filter((e) => e.kind === 'commit.recorded')).toHaveLength(1);
    expect(evs.filter((e) => e.kind === 'pr.requested')).toHaveLength(1);
    const verifyRec = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
    const runId = evs.find((e) => e.kind === 'run.started')!.runId!;
    const replay = await replayRun(verifyRec, runId);
    verifyRec.close();
    expect(replay.goals['g_fix-failing-test']).toMatchObject({ derived: 'achieved', agrees: true });
  }, 600_000);

  it('a scripted reviewer reject → exit 6: no PR approval requested, no commit, no branch', async () => {
    const { dir, wt } = await sampleRepo();
    const env = { ...KEYS, TECERA_WORKTREES: wt };
    const r = fixtureReplies();
    const reject = [{ text: JSON.stringify({ verdict: 'reject', findings: [{ title: 'off-by-one in the separator class', path: 'src/slugify.js' }] }) }];
    const res = await cli(dir, ['run', 'fix-failing-test', '--scripted', scripts({ worker: r.worker, reviewer: reject })], { env });
    if (res.code !== 6) console.log(await dump(dir));
    expect(res.code, res.err + res.out).toBe(6);
    const evs = await events(dir);
    const kinds = evs.map((e) => e.kind);
    expect(kinds).toContain('review.rejected');
    expect(kinds).toContain('goal.dropped');
    expect(kinds).not.toContain('approval.requested');
    for (const k of ['commit.recorded', 'pr.requested', 'goal.achieved', 'plan.staged']) expect(kinds).not.toContain(k);
    expect(git(dir, 'branch', '--list', 'tecera/*').trim()).toBe('');
    expect((await stopHook(dir)).code, 'a failed run is not active').toBe(0);
  }, 600_000);

  it('a scripted worker that only edits the test file → the edit is denied and recorded, verify fails twice on the SAME candidate → no progress stops for a human (exit 9), never a commit', async () => {
    const { dir, wt } = await sampleRepo();
    const env = { ...KEYS, TECERA_WORKTREES: wt };
    const r = fixtureReplies();
    const testOnly = {
      expect: 'Fix the root cause',
      text: js(`let denied = null;
try { await writeFile({ path: 'test/slugify.test.js', oldText: "'a-b-c'", newText: "'a--b-c'" }); } catch (e) { denied = String(e.message); }
return { facts: [{ key: 'testEditDenied', value: denied !== null }] };`),
    };
    // attempt 1: the test edit is denied, nothing is written; verify fails. The retry re-runs the edit worker
    // (a new execution): the same denied edit → the identical candidate → no progress
    const res = await cli(dir, ['run', 'fix-failing-test', '--scripted', scripts({ worker: [r.worker[0], testOnly, testOnly] })], { env });
    const evs = await events(dir);
    if (res.code !== 9) console.log(await dump(dir));
    expect(res.code, res.err + res.out).toBe(9);
    const failedVerifies = evs.filter((e) => e.kind === 'verify.failed');
    expect(failedVerifies.some((e) => (e.payload as { noProgress?: boolean }).noProgress === true)).toBe(true);
    const lastFail = [...evs].reverse().find((e) => e.kind === 'step.failed')!;
    expect(lastFail.payload).toMatchObject({ terminal: true, failure: 'human' });
    expect(evs.map((e) => e.kind)).not.toContain('approval.requested');
    const denied = evs.filter((e) => e.kind === 'evidence.appended' && (e.payload as { kind?: string }).kind === 'tool.denied');
    expect(denied.length).toBeGreaterThanOrEqual(1);
    expect(denied[0]!.payload).toMatchObject({ tool: 'edit', path: 'test/slugify.test.js' });
    expect(evs.map((e) => e.kind)).not.toContain('review.started');
    const runId = evs.find((e) => e.kind === 'run.started')!.runId!;
    expect(readFileSync(join(wt, runId, 'test/slugify.test.js'), 'utf8')).toBe(readFileSync(join(dir, 'test/slugify.test.js'), 'utf8'));
  }, 600_000);

  it('D3 budgets off (the default): a worker turn and a review over the token cap are recorded (budget.exhausted, once per pool) and reported, and the run still reaches the PR hold (exit 4)', async () => {
    const { dir, wt } = await sampleRepo();
    const env = { ...KEYS, TECERA_WORKTREES: wt };
    const fx = fixtureReplies();
    const replies = { worker: [{ ...fx.worker[0]!, usage: { input: 400000, output: 1000 } }, fx.worker[1]], reviewer: [{ ...fx.reviewer[0]!, usage: { input: 300000, output: 40 } }] };
    const res = await cli(dir, ['run', 'fix-failing-test', '--scripted', scripts(replies)], { env });
    if (res.code !== 4) console.log(await dump(dir));
    expect(res.code, res.err + res.out).toBe(4);
    const evs = await events(dir);
    expect(pendingRequest(evs)!.trace.stepId).toBe('pr');
    const ex = evs.filter((e) => e.kind === 'budget.exhausted');
    expect(ex.some((e) => (e.payload as { pool?: string }).pool === 'tokens')).toBe(true);
    expect(ex.every((e) => (e.payload as { enforced?: boolean }).enforced === false)).toBe(true);
    const pools = ex.map((e) => (e.payload as { pool: string }).pool);
    expect(new Set(pools).size, 'once per pool').toBe(pools.length);
    expect(evs.some((e) => (e.payload as { failure?: string }).failure === 'budget')).toBe(false);
    expect(res.out).toMatch(/^cost {7}.*[\d,]{7,} tokens .*\(not enforced\)/m);
  }, 600_000);

  it('D3 budgets.enforce true: a worker turn that reports more tokens than the run may spend stops the step → exit 7', async () => {
    const { dir, wt } = await sampleRepo(enforced);
    const env = { ...KEYS, TECERA_WORKTREES: wt };
    const res = await cli(dir, ['run', 'fix-failing-test', '--scripted', scripts({ worker: [{ expect: 'Run verify and read the failing assertion', text: js(`console.log('thinking about it');`), usage: { input: 400000, output: 1000 } }] })], { env });
    if (res.code !== 7) console.log(await dump(dir));
    expect(res.code, res.err + res.out).toBe(7);
    const evs = await events(dir);
    const failed = evs.filter((e) => e.kind === 'step.failed');
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect((failed[failed.length - 1]!.payload as { reason: string }).reason).toMatch(/budget/);
    expect(failed[failed.length - 1]!.payload).toMatchObject({ terminal: true, failure: 'budget' });
    expect(evs.map((e) => e.kind)).not.toContain('verify.started');
    // exhaustion is terminal: nothing asks a human for anything
    expect(evs.filter((e) => e.kind === 'approval.requested')).toHaveLength(0);
    expect((await stopHook(dir)).code, 'budget never holds the assistant').toBe(0);
  }, 600_000);

  it('D3 budgets.enforce true: a review call that pushes the run over its token cap stops the run as a budget failure (exit 7); its verdict is not used, nothing is committed', async () => {
    const { dir, wt } = await sampleRepo(enforced);
    const env = { ...KEYS, TECERA_WORKTREES: wt };
    const r = fixtureReplies();
    const res = await cli(dir, ['run', 'fix-failing-test', '--scripted', scripts({ worker: r.worker, reviewer: [{ ...r.reviewer[0]!, usage: { input: 300000, output: 40 } }] })], { env });
    if (res.code !== 7) console.log(await dump(dir));
    expect(res.code, res.err + res.out).toBe(7);
    const evs = await events(dir);
    const failed = evs.filter((e) => e.kind === 'step.failed');
    expect(failed[failed.length - 1]!.trace.stepId).toBe('review');
    expect(failed[failed.length - 1]!.payload).toMatchObject({ failure: 'budget' });
    expect(evs.map((e) => e.kind)).not.toContain('approval.requested');
    expect(evs.map((e) => e.kind)).not.toContain('commit.recorded');
  }, 600_000);

  it("reviewer seat accounting failure (the ledger cannot reserve, not a budget refusal): the reviewer is never called, the gate's verdict is not used, the run terminates (failure 'ledger', exit 9); nothing is committed", async () => {
    const { dir, wt } = await sampleRepo();
    const env = { ...KEYS, TECERA_WORKTREES: wt };
    const r = fixtureReplies();
    const asked: string[] = [];
    const inner = createWiring({ tap: (seat) => void asked.push(seat) });
    const wire: WireFn = async (ctx) => {
      const l = ctx.ledger as Ledger;
      const reserve = l.reserve.bind(l);
      (l as { reserve: Ledger['reserve'] }).reserve = async (pool, amount, runId, idem) => {
        if (idem.startsWith('seat:reviewer:')) throw new Error('disk gone');
        return reserve(pool, amount, runId, idem);
      };
      return inner(ctx);
    };
    const res = await cli(dir, ['run', 'fix-failing-test', '--scripted', scripts({ worker: r.worker, reviewer: r.reviewer })], { env, wire });
    if (res.code !== 9) console.log(await dump(dir));
    expect(res.code, res.err + res.out).toBe(9);
    expect(asked).not.toContain('reviewer');
    const evs = await events(dir);
    const kinds = evs.map((e) => e.kind);
    expect(kinds).not.toContain('review.passed');
    expect(kinds).not.toContain('commit.recorded');
    expect(kinds).not.toContain('approval.requested');
    expect(JSON.stringify(evs.filter((e) => e.kind === 'step.failed' || e.kind === 'run.ended' || e.kind === 'goal.dropped').map((e) => e.payload))).toMatch(/ledger/);
  }, 600_000);

  it('secret canaries (env, repo file, credential-named env value, provider keys) never reach the ledger file, the run export, the PR bundle, a sandbox child or a model request (incl. the review packet)', async () => {
    const ENV_CANARY = 'TECERA_CANARY_envplant_7f3a9c21';
    const REPO_CANARY = 'TECERA_CANARY_repofile_5d1e8b0a';
    const PLAIN = 'plainsecretvalue-4242-zz';
    const { dir, wt } = await sampleRepo((d) => {
      const p = join(d, 'src/slugify.js');
      writeFileSync(p, `// build ${REPO_CANARY} token ${PLAIN}\n${readFileSync(p, 'utf8')}`);
    });
    const childIn: string[] = [];
    const modelOut: Array<{ seat: string; body: string }> = [];
    const wire = createWiring({ tap: (seat, _url, body) => modelOut.push({ seat, body }), childTap: (_k, data) => childIn.push(data) });
    const env = { ...KEYS, TECERA_WORKTREES: wt, TECERA_CANARY_ENV: ENV_CANARY, MY_SERVICE_KEY: PLAIN };
    const fx = fixtureReplies();
    const run = await cli(dir, ['run', 'fix-failing-test', '--scripted', scripts({ worker: fx.worker, reviewer: fx.reviewer })], { env, wire });
    expect(run.code, run.err + run.out).toBe(4);
    const s = await approveAndResume(dir, env, {}, { wire });
    const outs = [run, s.approve, s.resumed];
    expect(s.resumed.code, outs.map((o) => o.err + o.out).join('\n')).toBe(0);
    const runId = (await events(dir)).find((e) => e.kind === 'run.started')!.runId!;
    expect((await cli(dir, ['evidence', runId], { env })).code).toBe(0);

    // the run really carried the planted values through every boundary
    expect(modelOut.some((m) => m.seat === 'reviewer' && m.body.includes('build [REDACTED'))).toBe(true);
    expect(childIn.length).toBeGreaterThan(2);

    const needles = [ENV_CANARY, PLAIN, KEYS.ANTHROPIC_API_KEY, KEYS.OPENAI_API_KEY, KEYS.OPENROUTER_API_KEY].flatMap((v) => [v, Buffer.from(v).toString('base64')]);
    const scan = (where: string, text: string, extra: string[] = []): void => {
      for (const n of [...needles, ...extra]) expect(text.includes(n), `${where} contains a planted secret`).toBe(false);
    };
    for (const m of modelOut) scan(`model request (${m.seat})`, m.body, [REPO_CANARY]);
    for (const c of childIn) scan('sandbox child input', c, [REPO_CANARY]);
    for (const f of readdirSync(join(dir, '.tecera')).filter((n) => n.startsWith('ledger.sqlite'))) scan(f, readFileSync(join(dir, '.tecera', f)).toString('latin1'), [REPO_CANARY]);
    const keysOnly = [ENV_CANARY, KEYS.ANTHROPIC_API_KEY, KEYS.OPENAI_API_KEY, KEYS.OPENROUTER_API_KEY].flatMap((v) => [v, Buffer.from(v).toString('base64')]);
    const walk = (d: string, extra: string[]): void => {
      for (const n of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, n.name);
        if (n.isDirectory()) walk(p, extra);
        else if (n.name.endsWith('.patch')) {
          // the PR bundle's patch IS the committed diff: the repository's own lines (the planted comment is
          // in its context) are what is delivered, exactly as on the branch; no credential or env canary may ride along
          const text = readFileSync(p).toString('latin1');
          for (const k of keysOnly) expect(text.includes(k), `${p} contains a credential`).toBe(false);
        } else scan(p, readFileSync(p).toString('latin1'), extra);
      }
    };
    walk(join(dir, '.tecera/runs', runId), [REPO_CANARY]);
    scan('run stdout', outs.map((o) => o.out + o.err).join('\n'), [REPO_CANARY]);
  }, 600_000);

  it('interruption: an abort while a worker step waits on its model stops the run (130), releases the lease, starts no gate; the Stop hook blocks on the interrupted run', async () => {
    const { dir, wt } = await sampleRepo();
    const env = { ...KEYS, TECERA_WORKTREES: wt };
    const ac = new AbortController();
    let workerCalls = 0;
    const wire = createWiring({ tap: (seat) => (seat === 'worker' && ++workerCalls === 1 ? ac.abort(new Error('SIGINT')) : undefined) });
    const res = await cli(dir, ['run', 'fix-failing-test', '--scripted', scripts({ worker: [fixtureReplies().worker[0]] })], { env, wire, signal: ac.signal });
    if (res.code !== 130) console.log(await dump(dir));
    expect(res.code, res.err + res.out).toBe(130);
    const evs = await events(dir);
    const kinds = evs.map((e) => e.kind);
    expect(kinds).toContain('run.interrupted');
    expect(kinds).not.toContain('verify.started');
    const runId = evs.find((e) => e.kind === 'run.started')!.runId!;
    expect(readFileSync(join(wt, runId, 'src/slugify.js'), 'utf8')).toBe(readFileSync(join(dir, 'src/slugify.js'), 'utf8'));
    const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
    expect(await l.lease(`worktree:${runId}`, 'someone-else', 1000)).not.toBeNull();
    l.close();
    const stop = await stopHook(dir);
    expect(stop.code).toBe(2);
    expect(stop.err).toMatch(/is interrupted and has no goal.achieved proof/);
  }, 600_000);

  it('fail closed on resume: a live run cannot be resumed scripted, a scripted run not live; a missing worktree refuses (3)', async () => {
    const { dir, wt } = await sampleRepo();
    const env = { ...KEYS, TECERA_WORKTREES: wt };
    const run = await cli(dir, ['run', 'fix-failing-test', '--scripted', scripts()], { env });
    expect(run.code).toBe(4);
    const runId = (await events(dir)).find((e) => e.kind === 'run.started')!.runId!;
    const live = await cli(dir, ['run', '--resume', runId], { env });
    expect(live.code).toBe(3);
    expect(live.err).toMatch(/was scripted; resume it with --scripted/);
    rmSync(join(wt, runId), { recursive: true, force: true });
    const gone = await cli(dir, ['run', '--resume', runId, '--scripted', scripts()], { env });
    expect(gone.code).toBe(3);
    expect(gone.err).toMatch(/worktree of run .* is missing/);
  }, 300_000);

  it('lease loss during a worker write: the fenced write is refused at the tool, the lease is revoked, the loop stops (exit 9), no gate runs, the worktree keeps no write', async () => {
    const { dir, wt } = await sampleRepo();
    const env = { ...KEYS, TECERA_WORKTREES: wt };
    const fx = fixtureReplies();
    // another holder takes the worktree over the moment the edit's model request leaves this process:
    // from then on the ledger refuses this process's renewal (as it would after an expiry + takeover)
    let stolen = false;
    let workerCalls = 0;
    const inner = createWiring({ tap: (seat) => void (seat === 'worker' && ++workerCalls === 2 && (stolen = true)) });
    const wire: WireFn = async (ctx) => {
      const l = ctx.ledger as Ledger;
      const renew = l.renew.bind(l);
      (l as { renew: Ledger['renew'] }).renew = async (lease, ttl) => {
        if (stolen) throw new LedgerError(`lease on ${lease.resource} is no longer held by ${lease.holder}`, 'lease');
        return renew(lease, ttl);
      };
      return inner(ctx);
    };
    const res = await cli(dir, ['run', 'fix-failing-test', '--scripted', scripts({ worker: fx.worker, reviewer: fx.reviewer })], { env, wire });
    if (res.code !== 9) console.log(await dump(dir));
    expect(res.code, res.err + res.out).toBe(9);
    expect(res.out + res.err).toMatch(/lease lost/);
    const evs = await events(dir);
    const runId = evs.find((e) => e.kind === 'run.started')!.runId!;
    expect(stolen).toBe(true);
    expect(evs.filter((e) => e.runId === runId).map((e) => e.kind)).not.toContain('verify.started');
    expect(readFileSync(join(wt, runId, 'src/slugify.js'), 'utf8'), 'no write after the lease was lost').toBe(SRC_BEFORE);
    expect(git(dir, 'branch', '--list', 'tecera/*').trim()).toBe('');
  }, 600_000);

  it('lease loss while the review runs: the next gate re-proves the lease and is refused, the loop stops (exit 9); no commit, no PR approval', async () => {
    const { dir, wt } = await sampleRepo();
    const env = { ...KEYS, TECERA_WORKTREES: wt };
    const fx = fixtureReplies();
    let stolen = false;
    const inner = createWiring({ tap: (seat) => void (seat === 'reviewer' && (stolen = true)) });
    const wire: WireFn = async (ctx) => {
      const l = ctx.ledger as Ledger;
      const renew = l.renew.bind(l);
      (l as { renew: Ledger['renew'] }).renew = async (lease, ttl) => {
        if (stolen) throw new LedgerError(`lease on ${lease.resource} is no longer held by ${lease.holder}`, 'lease');
        return renew(lease, ttl);
      };
      return inner(ctx);
    };
    const res = await cli(dir, ['run', 'fix-failing-test', '--scripted', scripts({ worker: fx.worker, reviewer: fx.reviewer })], { env, wire });
    if (res.code !== 9) console.log(await dump(dir));
    expect(res.code, res.err + res.out).toBe(9);
    const evs = await events(dir);
    expect(evs.map((e) => e.kind)).not.toContain('approval.requested');
    expect(evs.map((e) => e.kind)).not.toContain('commit.recorded');
    // the second verify never ran its command under a lost lease
    expect(evs.filter((e) => e.kind === 'verify.passed' && e.trace.stepId === 'verify2')).toHaveLength(0);
    expect(git(dir, 'branch', '--list', 'tecera/*').trim()).toBe('');
  }, 600_000);

  it('D6: two distinct writes in one step land under node isolation with no approval (fenced, inside repo.allowedChanges); a protected-path write is denied; the commit carries both and only the PR holds', async () => {
    const { dir, wt } = await sampleRepo();
    const env = { ...KEYS, TECERA_WORKTREES: wt };
    const fx = fixtureReplies();
    const twoWrites = {
      expect: 'Fix the root cause',
      text: js(`let denied = null;
try { await writeFile('package.json', '{}'); } catch (e) { denied = String(e.message); }
await writeFile({ path: 'src/slugify.js', oldText: "(m) => '-'.repeat(m.length)", newText: "'-'" });
await writeFile('src/notes.js', 'export const note = 1;\\n');
const v = await runVerify();
return { facts: [{ key: 'changedFiles', value: ['src/slugify.js', 'src/notes.js'] }, { key: 'verifyExit', value: v.exitCode }, { key: 'protectedDenied', value: denied !== null }] };`),
    };
    const res = await cli(dir, ['run', 'fix-failing-test', '--scripted', scripts({ worker: [fx.worker[0], twoWrites], reviewer: fx.reviewer })], { env });
    if (res.code !== 4) console.log(await dump(dir));
    expect(res.code, res.err + res.out).toBe(4);
    const evs = await events(dir);
    const runId = evs.find((e) => e.kind === 'run.started')!.runId!;
    expect(readFileSync(join(wt, runId, 'src/notes.js'), 'utf8')).toBe('export const note = 1;\n');
    expect(readFileSync(join(wt, runId, 'src/slugify.js'), 'utf8')).not.toBe(SRC_BEFORE);
    expect(evs.filter((e) => e.kind === 'approval.requested').map((e) => e.trace.stepId)).toEqual(['pr']);
    expect(evs.filter((e) => e.kind === 'step.held' && (e.payload as { write?: unknown }).write !== undefined)).toHaveLength(0);
    expect(evs.some((e) => e.kind === 'evidence.appended' && (e.payload as { kind?: string; path?: string }).kind === 'tool.denied' && (e.payload as { path?: string }).path === 'package.json')).toBe(true);
    const sha = (evs.find((e) => e.kind === 'commit.recorded')!.payload as { sha: string }).sha;
    expect(git(dir, 'diff', '--name-only', 'main', sha).trim().split('\n').sort()).toEqual(['src/notes.js', 'src/slugify.js']);
    expect(git(dir, 'show', `${sha}:package.json`)).toBe(git(dir, 'show', 'main:package.json'));
  }, 600_000);

  it('mutation-time fencing: an edit call already past its entry checks when the lease is taken over (renewals stall, a new holder acquires it) never publishes its write; the run stops (exit 9)', async () => {
    const { dir, wt } = await sampleRepo();
    const env = { ...KEYS, TECERA_WORKTREES: wt };
    const fx = fixtureReplies();
    // pause the src write after it read the file (entry checks passed), stall every renewal until the lease
    // lapses, let another holder take it, then let it go on
    let ledger: Ledger | null = null;
    let stall = false;
    let thief: unknown = null;
    let runId = '';
    const wire: WireFn = async (ctx) => {
      const l = ctx.ledger as Ledger;
      ledger = l;
      runId = ctx.runId;
      const renew = l.renew.bind(l);
      (l as { renew: Ledger['renew'] }).renew = (lease, ttl) => (stall ? new Promise(() => undefined) : renew(lease, ttl));
      return createWiring({
        leaseTtlMs: 900,
        editToolSeams: {
          afterRead: async (r) => {
            if (r.rel !== 'src/slugify.js') return;
            stall = true;
            for (let i = 0; i < 200 && !thief; i++) {
              await new Promise((res) => setTimeout(res, 25));
              thief = await ledger!.lease(`worktree:${runId}`, 'run:thief', 60_000);
            }
          },
        },
      })(ctx);
    };
    const res = await cli(dir, ['run', 'fix-failing-test', '--scripted', scripts({ worker: fx.worker, reviewer: fx.reviewer })], { env, wire });
    if (res.code !== 9) console.log(await dump(dir));
    expect(thief, 'another holder acquired the lease while the call was in flight').toBeTruthy();
    expect(res.code, res.err + res.out).toBe(9);
    expect(readFileSync(join(wt, runId, 'src/slugify.js'), 'utf8'), 'no write after the lease was lost').toBe(SRC_BEFORE);
    const evs = (await events(dir)).filter((e) => e.runId === runId);
    expect(evs.map((e) => e.kind)).not.toContain('verify.started');
    expect(git(dir, 'branch', '--list', 'tecera/*').trim()).toBe('');
  }, 600_000);

  it('mutation-time fencing in the commit gate: the lease is taken over after the commit intent is persisted, before commit-tree/update-ref → no commit object is published on the branch, the run stops (exit 9)', async () => {
    const { dir, wt } = await sampleRepo();
    const env = { ...KEYS, TECERA_WORKTREES: wt };
    const fx = fixtureReplies();
    let ledger: Ledger | null = null;
    let stall = false;
    let thief: unknown = null;
    let runId = '';
    const wire: WireFn = async (ctx) => {
      const l = ctx.ledger as Ledger;
      ledger = l;
      runId = ctx.runId;
      const renew = l.renew.bind(l);
      (l as { renew: Ledger['renew'] }).renew = (lease, ttl) => (stall ? new Promise(() => undefined) : renew(lease, ttl));
      return createWiring({
        leaseTtlMs: 900,
        commitTestHooks: {
          beforeCommit: async () => {
            stall = true;
            for (let i = 0; i < 200 && !thief; i++) {
              await new Promise((res) => setTimeout(res, 25));
              thief = await ledger!.lease(`worktree:${runId}`, 'run:thief', 60_000);
            }
          },
        },
      })(ctx);
    };
    const res = await cli(dir, ['run', 'fix-failing-test', '--scripted', scripts({ worker: fx.worker, reviewer: fx.reviewer })], { env, wire });
    if (res.code !== 9) console.log(await dump(dir));
    expect(thief, 'another holder acquired the lease during the commit').toBeTruthy();
    expect(res.code, res.err + res.out).toBe(9);
    expect(git(dir, 'branch', '--list', 'tecera/*').trim(), 'no branch was created or moved').toBe('');
    const evs = (await events(dir)).filter((e) => e.runId === runId);
    expect(evs.map((e) => e.kind)).not.toContain('commit.recorded');
    expect(evs.map((e) => e.kind)).not.toContain('goal.achieved');
  }, 600_000);

  it.skipIf(!(typeof process.getuid === 'function' && process.getuid() === 0))('as root, the verify runner refuses a root identity unless the operator names an unprivileged uid or explicitly allows a degraded root verify (exit 3, nothing runs)', async () => {
    const { dir, wt } = await sampleRepo();
    const res = await cli(dir, ['run', 'fix-failing-test', '--scripted', scripts({})], { env: { ...KEYS, TECERA_WORKTREES: wt, TECERA_VERIFY_ALLOW_ROOT: '' } });
    expect(res.code, res.err + res.out).toBe(3);
    expect(res.err).toMatch(/TECERA_VERIFY_ALLOW_ROOT=1/);
    expect((await events(dir)).some((e) => e.kind === 'run.started')).toBe(false);
  }, 300_000);
});
