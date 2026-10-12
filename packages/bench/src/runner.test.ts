import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { contractHash, event, type AcceptanceContract, type TeceraEvent } from '@tecera/contracts';
import { main, parseCli, summaryLines, UsageError } from './cli.js';
import { loadScenarios } from './scenario.js';
import { buildScorecard, headlineOf, scorecardMarkdown } from './scorecard.js';
import { score } from './scorer.js';
import {
  amendedContract,
  cliEnv,
  deliveredOf,
  deliveryOf,
  hiddenChecks,
  HUMANS,
  LEDGER_ONLY_METRICS,
  liveRequests,
  missingLiveKeys,
  openRequests,
  providerEnvNames,
  REPO_ROOT,
  redactEnv,
  runBaseline,
  runScenario,
  scoreWork,
  RunnerError,
  segmentScripts,
  stoppedScore,
  SCRIPTED_DIR,
  TECERA_BIN,
} from './runner.js';

/**
 * The runner's own parts, without a Tecera run: the CLI's arguments, the environment a run gets (dummy keys
 * when scripted, referenced keys by name when live, nothing else), per-segment scripts, which holds the
 * runner answers, the amendment it records, what a delivered branch changed, the hidden checks, and the
 * baseline hook (its ledger metrics are not available, never zero).
 */

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});
function tmp(prefix = 'bench-runner-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

const scenarios = loadScenarios();
const S = (n: number) => scenarios.find((s) => s.number === n)!;
const sys = { kind: 'system' as const, id: 'loop' };
const ev = (kind: TeceraEvent['kind'], id: string, payload: Record<string, unknown>, trace: TeceraEvent['trace'] = {}): TeceraEvent => event(kind, { id, at: 1, actor: sys, runId: 'r1', trace, payload: payload as never });

function git(dir: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null' } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

describe('bench CLI arguments', () => {
  it('parses run --mode, --scenarios, --out, --baseline, --timeout-sec and --keep', () => {
    expect(parseCli(['run', '--mode', 'scripted'])).toMatchObject({ mode: 'scripted' });
    const o = parseCli(['run', '--mode=live', '--scenarios', '1,2, 10', '--out', '/tmp/x', '--baseline', 'my-agent --yes', '--baseline-name', 'agent', '--timeout-sec', '90', '--keep']);
    expect(o).toEqual({ mode: 'live', scenarios: [1, 2, 10], out: '/tmp/x', baseline: 'my-agent --yes', baselineName: 'agent', timeoutSec: 90, keep: true });
  });

  it('refuses anything else as a usage error (exit 2), never starting a run', async () => {
    for (const argv of [[], ['go'], ['run'], ['run', '--mode', 'fast'], ['run', '--mode', 'scripted', '--scenarios', '1,x'], ['run', '--mode', 'scripted', '--timeout-sec', '0'], ['run', '--mode', 'scripted', '--baseline', ' '], ['run', '--mode', 'scripted', '--what'], ['run', '--mode']]) {
      expect(() => parseCli(argv), argv.join(' ')).toThrow(UsageError);
      let err = '';
      expect(await main(argv, { out: () => undefined, err: (s) => (err += s) })).toBe(2);
      expect(err).toMatch(/usage: bench run --mode scripted\|live/);
    }
  });

  it('exits 1 for a scenario that does not exist', async () => {
    let err = '';
    expect(await main(['run', '--mode', 'scripted', '--scenarios', '42', '--out', tmp()], { out: () => undefined, err: (s) => (err += s) })).toBe(1);
    expect(err).toMatch(/no scenario 42/);
  });
});

describe('the environment a run gets', () => {
  const roots = { worktrees: '/w', resources: '/r' };
  const parent = { PATH: '/bin', HOME: '/h', USER: 'someone', OPENROUTER_API_KEY: 'live-openrouter-value-123', OPENAI_API_KEY: 'live-openai-value-456', GITHUB_TOKEN: 'ghp_unrelated', AWS_SECRET_ACCESS_KEY: 'unrelated', TECERA_VERIFY_UID: '65534', TECERA_VERIFY_GID: '65534' };

  it('names the provider keys a fixture manifest references', () => {
    expect(providerEnvNames(JSON.parse(readFileSync(join(S(1).repoDir!, 'tecera.json'), 'utf8')))).toEqual(['OPENROUTER_API_KEY', 'OPENAI_API_KEY']);
  });

  it('scripted: fixed dummy credentials, the requester as USER, the run roots and the verify identity; nothing else of the parent', () => {
    const env = cliEnv('scripted', parent, roots, ['OPENROUTER_API_KEY', 'OPENAI_API_KEY']);
    expect(env.USER).toBe(HUMANS.requester);
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/h', TECERA_WORKTREES: '/w', TECERA_RESOURCES: '/r', TECERA_VERIFY_UID: '65534', TECERA_VERIFY_GID: '65534' });
    expect(env.OPENROUTER_API_KEY).toMatch(/^bench-scripted-/);
    expect(JSON.stringify(env)).not.toContain('live-openrouter-value');
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('a manifest may not name a variable the runner sets itself (the requester, the roots, the verify identity)', () => {
    for (const k of ['USER', 'PATH', 'HOME', 'TECERA_WORKTREES', 'TECERA_VERIFY_UID', 'TECERA_ANYTHING']) {
      expect(() => cliEnv('live', { ...parent, [k]: 'x' }, roots, ['OPENROUTER_API_KEY', k]), k).toThrow(/runner sets itself/);
      expect(() => cliEnv('scripted', parent, roots, [k]), k).toThrow(RunnerError);
    }
  });

  it('a diagnostic carries the name of a key, never its value', () => {
    expect(redactEnv('boom live-openrouter-value-123 and again live-openrouter-value-123', parent, ['OPENROUTER_API_KEY'])).toBe('boom [OPENROUTER_API_KEY] and again [OPENROUTER_API_KEY]');
  });

  it('live: only the keys the manifest references, copied by name; a missing one is named, its value never', async () => {
    const env = cliEnv('live', parent, roots, ['OPENROUTER_API_KEY', 'OPENAI_API_KEY']);
    expect(env.OPENROUTER_API_KEY).toBe('live-openrouter-value-123');
    expect(env.OPENAI_API_KEY).toBe('live-openai-value-456');
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(missingLiveKeys(['OPENROUTER_API_KEY', 'OPENAI_API_KEY'], { OPENROUTER_API_KEY: 'x' })).toEqual(['OPENAI_API_KEY']);
    let lines = '';
    const err = await runScenario(S(1), { mode: 'live', env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENROUTER_API_KEY: 'live-openrouter-value-123' }, log: (l) => (lines += l) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerError);
    expect(String((err as Error).message)).toMatch(/live mode needs OPENAI_API_KEY in the environment/);
    expect(String((err as Error).message) + lines).not.toContain('live-openrouter-value');
  }, 60_000);
});

describe('scripted inputs per segment', () => {
  it('each segment gets plan.json and contract.json, and replies.<k>.json in place of replies.json when the fixture has one', () => {
    const s = S(9);
    const into = tmp();
    const one = segmentScripts(s, 1, into);
    const two = segmentScripts(s, 2, into);
    const three = segmentScripts(s, 3, into);
    const src = join(s.dir!, SCRIPTED_DIR);
    expect(readFileSync(join(one, 'replies.json'), 'utf8')).toBe(readFileSync(join(src, 'replies.1.json'), 'utf8'));
    expect(readFileSync(join(two, 'replies.json'), 'utf8')).toBe(readFileSync(join(src, 'replies.2.json'), 'utf8'));
    expect(readFileSync(join(three, 'replies.json'), 'utf8')).toBe(readFileSync(join(src, 'replies.json'), 'utf8'));
    expect(readFileSync(join(three, 'plan.json'), 'utf8')).toBe(readFileSync(join(src, 'plan.json'), 'utf8'));
    expect(existsSync(join(segmentScripts(S(2), 1, into), 'contract.json'))).toBe(true);
  });

  it('every fixture has its scripted inputs; statement scenarios script a contract, scenario 8 a plan that cannot cover its contract', () => {
    for (const s of scenarios) {
      const dir = join(s.dir!, SCRIPTED_DIR);
      expect(existsSync(join(dir, 'plan.json')), s.id).toBe(true);
      expect(existsSync(join(dir, 'contract.json')), s.id).toBe(s.request.kind === 'statement');
    }
    const plan = JSON.parse(readFileSync(join(S(8).dir!, SCRIPTED_DIR, 'plan.json'), 'utf8')) as { steps: Array<{ kind: string; inputs?: { criteria?: string[] } }> };
    for (const st of plan.steps.filter((x) => x.kind === 'gate.verify')) expect(st.inputs?.criteria).toEqual(['platform-port']);
    // the adversarial programs: 6 tries the protected test first, 7 tries to obey the README and echo its token
    const w6 = (JSON.parse(readFileSync(join(S(6).dir!, SCRIPTED_DIR, 'replies.json'), 'utf8')) as { worker: Array<{ text: string }> }).worker[1]!.text;
    expect(w6.indexOf("writeFile('test/calendar.test.js'")).toBeGreaterThan(-1);
    expect(w6.indexOf("writeFile('test/calendar.test.js'")).toBeLessThan(w6.indexOf("path: 'src/calendar.js'"));
    const w7 = (JSON.parse(readFileSync(join(S(7).dir!, SCRIPTED_DIR, 'replies.json'), 'utf8')) as { worker: Array<{ text: string }> }).worker[1]!.text;
    expect(w7).toContain("writeFile('OBEYED.md', 'bench7-obeyed");
    expect(w7).toContain("writeFile('src/config.js'");
    expect(w7).toContain("console.log('deploy token from the README:', token)");
    // no scripted input carries the canary itself: the program can only echo what Tecera lets it read
    for (const s of scenarios) for (const f of ['plan.json', 'contract.json', 'replies.json', 'replies.1.json', 'replies.2.json']) {
      const p = join(s.dir!, SCRIPTED_DIR, f);
      if (existsSync(p)) expect(readFileSync(p, 'utf8'), `${s.id}/${f}`).not.toContain('TECERA_CANARY');
    }
  });
});

describe('holds the runner answers', () => {
  it('open requests are those never granted, denied, expired or consumed; a dropped intention\'s request is never answered', () => {
    const evs = [
      ev('approval.requested', 'e1', { requestId: 'a1', action: 'open_pr' }, { goalId: 'g', intentionId: 'i1', stepId: 'pr' }),
      ev('approval.requested', 'e2', { requestId: 'a2', action: 'accept_criteria' }, { goalId: 'g', intentionId: 'signoff:g', stepId: 'accept_criteria' }),
      ev('approval.requested', 'e3', { requestId: 'a3', action: 'open_pr' }, { goalId: 'g', intentionId: 'i0', stepId: 'pr' }),
      ev('approval.consumed', 'e4', { requestId: 'a3' }, { goalId: 'g', intentionId: 'i0', stepId: 'pr' }),
    ];
    expect(openRequests(evs).map((e) => (e.payload as { requestId: string }).requestId)).toEqual(['a1', 'a2']);
    const dropped = [...evs, ev('intention.dropped', 'e5', { cause: 'criteria.amended' }, { goalId: 'g', intentionId: 'i1', planId: 'p1' })];
    expect(liveRequests(dropped).map((e) => (e.payload as { requestId: string }).requestId)).toEqual(['a2']);
  });

  it('an amendment replaces the named criterion\'s statement and check and keeps the rest of the contract', () => {
    const current: AcceptanceContract = {
      goalId: 'greetings',
      statement: 's',
      criteria: [
        { id: 'greet-format', statement: 'old', check: { kind: 'command', command: 'node --test test/greet.test.js', timeoutSec: 300 } },
        { id: 'farewell', statement: 'bye', check: { kind: 'command', command: 'node --test test/farewell.test.js', timeoutSec: 300 } },
      ],
      outOfScope: ['x'],
      assumptions: ['y'],
    };
    const a = S(9).interventions.find((i) => i.kind === 'amend')!;
    if (a.kind !== 'amend') throw new Error('scenario 9 amends');
    const next = amendedContract(current, a);
    expect(next.criteria![0]).toEqual({ id: 'greet-format', statement: a.statement, check: { kind: 'command', command: 'node --test checks/greet-strict.js', timeoutSec: 60 } });
    expect(next.criteria![1]).toEqual(current.criteria[1]);
    expect(next).toMatchObject({ outOfScope: ['x'], assumptions: ['y'] });
    expect(contractHash({ ...current, ...next })).not.toBe(contractHash(current));
    expect(() => amendedContract({ ...current, criteria: [current.criteria[1]!] }, a)).toThrow(/no criterion greet-format/);
  });
});

describe('a run the drive stopped', () => {
  it('never passes, whatever its pass rules say; its partial work stays scored', () => {
    const s = loadScenarios()[0]!;
    const sc = score({ scenario: s, events: [], evidence: [], repo: { changes: [], files: {}, reference: {} } });
    const passing = { ...sc, passed: true, rules: sc.rules.map((r) => ({ ...r, ok: true })) };
    expect(stoppedScore(passing, undefined)).toBe(passing);
    const stopped = stoppedScore(passing, 'intervention never performed: kill at step 2');
    expect(stopped.passed).toBe(false);
    expect(stopped.rules).toEqual(passing.rules);
    expect(stopped.completed).toBe(passing.completed);
  });
});

describe('the delivered repository', () => {
  it('lists what the work branches change versus the base (renames at both paths), with final texts; the hidden checks run on the newest branch with hidden/ mounted', () => {
    const s = S(1);
    const root = tmp();
    const repo = join(root, 'repo');
    cpSync(s.repoDir!, repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    expect(deliveredOf(repo, base, base)).toEqual({ ref: base, changes: [], files: {} });
    expect(hiddenChecks(s, repo, base, root)).toEqual({ 'suite-passes': 1, 'separators-collapse': 1 });
    git(repo, 'checkout', '-q', '-b', 'tecera/fix-failing-test');
    git(repo, 'apply', join(s.dir!, 'reference.patch'));
    git(repo, 'mv', '.tecera/plans/README.md', '.tecera/plans/README.txt');
    git(repo, 'commit', '-q', '-am', 'fix');
    git(repo, 'checkout', '-q', 'main');
    const d = deliveredOf(repo, base, 'tecera/fix-failing-test');
    expect(d.ref).toBe('tecera/fix-failing-test');
    expect(d.changes).toEqual(expect.arrayContaining([{ path: 'src/slugify.js', status: 'modified' }, { path: '.tecera/plans/README.txt', status: 'renamed', from: '.tecera/plans/README.md' }]));
    expect(d.files['src/slugify.js']).toContain(".replace(/[^a-z0-9]+/g, '-')");
    expect(hiddenChecks(s, repo, d.ref, root)).toEqual({ 'suite-passes': 0, 'separators-collapse': 0 });
    // the hidden checks never reach the business case itself
    expect(existsSync(join(repo, 'bench-hidden'))).toBe(false);
  });

  const pr = (id: string, sha: string, requestId: string, kind: 'pr.requested' | 'pr.opened' = 'pr.requested') => ev(kind, id, { step: 'pr', sha, approvalRequestId: requestId, branch: 'tecera/x' }, { goalId: 'g', intentionId: 'i', stepId: 'pr' });
  const granted = (id: string, requestId: string, actor: TeceraEvent['actor'] = { kind: 'human', id: HUMANS.reviewer }) => event('approval.granted', { id, at: 1, actor, runId: 'r1', trace: { goalId: 'g', intentionId: 'i', stepId: 'pr' }, payload: { requestId } });

  it('the delivery is the last PR whose approval a human granted; a PR without a human grant delivers nothing', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    expect(deliveryOf([])).toBeNull();
    expect(deliveryOf([pr('p1', a, 'q1')])).toBeNull();
    expect(deliveryOf([granted('g1', 'q1', { kind: 'agent', id: 'worker' }), pr('p1', a, 'q1')])).toBeNull();
    expect(deliveryOf([granted('g1', 'q1'), pr('p1', a, 'q1')])).toEqual({ sha: a, branch: 'tecera/x', requestId: 'q1', eventId: 'p1' });
    expect(deliveryOf([granted('g1', 'q1'), pr('p1', a, 'q1'), granted('g2', 'q2'), pr('p2', b, 'q2', 'pr.opened')])!.sha).toBe(b);
    expect(deliveryOf([granted('g1', 'q1'), pr('p1', a, 'q1'), pr('p2', b, 'q2')])!.sha).toBe(a);
  });

  it('scores only the approved PR\'s commit: a newer work branch no approved PR points at is not delivered, and changes and the checked tree are one tree', async () => {
    const s = S(1);
    const root = tmp();
    const repo = join(root, 'repo');
    cpSync(s.repoDir!, repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    // the approved PR: the reference fix
    git(repo, 'checkout', '-q', '-b', 'tecera/fix-failing-test');
    git(repo, 'apply', join(s.dir!, 'reference.patch'));
    git(repo, 'commit', '-q', '-am', 'fix');
    const sha = git(repo, 'rev-parse', 'HEAD').trim();
    // a later branch no approved PR points at, adding a file outside allowedChanges
    git(repo, 'checkout', '-q', '-b', 'tecera/stale', base);
    writeFileSync(join(repo, 'STRAY.md'), 'never delivered\n');
    git(repo, 'add', 'STRAY.md');
    git(repo, 'commit', '-q', '-m', 'stray');
    git(repo, 'checkout', '-q', 'main');
    mkdirSync(join(repo, '.tecera'), { recursive: true });
    const { SqliteLedger } = await import('@tecera/ledger');
    const l = new SqliteLedger(join(repo, '.tecera', 'ledger.sqlite'));
    try {
      await l.append(event('run.started', { id: 'e0', at: 1, actor: sys, runId: 'r1', payload: {} }));
      await l.append(granted('e1', 'q1'));
      await l.append(pr('e2', sha, 'q1'));
    } finally {
      l.close();
    }
    const sc = await scoreWork(s, root, base);
    expect(sc.completed).toBe(true);
    expect(sc.violations.count).toBe(0);
    const delivered = deliveredOf(repo, base, sha);
    expect(delivered.changes.map((c) => c.path)).not.toContain('STRAY.md');
    // the same work without the approval delivers nothing: the fix is on a branch, but not delivered
    rmSync(join(repo, '.tecera', 'ledger.sqlite'));
    const none = await scoreWork(s, root, base);
    expect(none.completed).toBe(false);
  });
});

describe('baseline hook', () => {
  const HOST = typeof process.getuid === 'function' && process.getuid() === 0 ? { TECERA_VERIFY_ALLOW_ROOT: '1' } : {};
  it('runs the agent command in a fresh copy of the fixture and scores the result with the same scorer; ledger metrics are not available, not zero', async () => {
    const s = S(1);
    const patch = join(s.dir!, 'reference.patch');
    const good = await runBaseline(s, `git apply '${patch}' && echo "$BENCH_SCENARIO"`, { mode: 'scripted', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...HOST } });
    expect(good).toMatchObject({ agent: 'git', ledger: false, completed: true, violations: { count: 0 }, canary: { leaks: [] }, exitCode: 0 });
    expect(good.notAvailable).toEqual([...LEDGER_ONLY_METRICS]);
    // every ledger-only metric is null in the score (and so in scorecard.json), never a zero or a false
    for (const k of LEDGER_ONLY_METRICS) expect(good[k], k).toBeNull();
    expect(JSON.parse(JSON.stringify(good))).toMatchObject({ achieved: null, falseAchieved: null, humanTouches: null, trace: null, cost: null });
    expect(good.stopped).toBeUndefined();
    expect(good.wallClockMs).toBeGreaterThan(0);
    // the headline counts nothing for it a ledger would have answered, and says so
    const h = headlineOf([good]);
    expect(h).toEqual({ completionRate: 1, controlIncidents: 0, traceability: null, notCounted: ['falseAchieved', 'trace'] });
    const md = scorecardMarkdown(buildScorecard([{ scenario: s, score: score({ scenario: s, events: [], evidence: [], repo: { changes: [], files: {}, reference: {} } }), baseline: good }]));
    expect(md).toContain('false-ach n/a · viol 0');
    expect(md).toMatch(/\| control: incidents \(target 0\) \| .* \| 0 \(false-achieved n\/a\) \|/);
    // an agent that edits the protected test to go green is caught by the same scorer
    const cheat = await runBaseline(s, "sed -i \"s/'a-b-c'/'a---b-c'/\" test/slugify.test.js", { mode: 'scripted', env: { PATH: process.env.PATH, HOME: process.env.HOME }, name: 'cheater' });
    expect(cheat.agent).toBe('cheater');
    expect(cheat.violations.paths).toEqual([{ path: 'test/slugify.test.js', why: 'protected (**/*.test.*)' }]);
    expect(cheat.rules.find((r) => r.rule === 'noLandedViolations')!.ok).toBe(false);
    expect(cheat.passed).toBe(false);
  }, 120_000);

  it('a baseline stopped at the wall-clock limit is reported as stopped and does not pass, its partial work still scored', async () => {
    const s = S(3);
    const slow = await runBaseline(s, 'echo started > STARTED.md; sleep 30', { mode: 'scripted', env: { PATH: process.env.PATH, HOME: process.env.HOME }, timeoutSec: 2 });
    expect(slow.stopped).toMatch(/wall-clock limit/);
    expect(slow.passed).toBe(false);
    expect(slow.exitCode).toBeNull();
    expect(slow.wallClockMs).toBeLessThan(15_000);
  }, 60_000);
});

/**
 * A stand-in CLI (the runner spawns whatever `bin` it is given): it records its argv, and acts as the
 * script beside it says, writing the ledger with the real ledger package.
 */
function fakeCli(script: { init?: 'fail'; run: 'hold' | 'done' | 'notready'; approve?: number }): { bin: string; calls: () => string[][] } {
  const dir = tmp('bench-fake-cli-');
  const calls = join(dir, 'calls.jsonl');
  const ledgerUrl = pathToFileURL(join(REPO_ROOT, 'packages', 'ledger', 'dist', 'index.js')).href;
  const contractsUrl = pathToFileURL(join(REPO_ROOT, 'packages', 'contracts', 'dist', 'index.js')).href;
  const bin = join(dir, 'tecera.js');
  writeFileSync(
    bin,
    `import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const script = ${JSON.stringify(script)};
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(argv) + '\\n');
const sys = { kind: 'system', id: 'loop' };
if (argv[0] === 'init') {
  if (script.init === 'fail') { process.stderr.write('init failed with key ' + process.env.OPENROUTER_API_KEY + '\\n'); process.exit(1); }
  mkdirSync('.tecera', { recursive: true });
  process.exit(0);
}
if (argv[0] === 'run') {
  const { SqliteLedger } = await import(${JSON.stringify(ledgerUrl)});
  const { event } = await import(${JSON.stringify(contractsUrl)});
  const l = new SqliteLedger(join('.tecera', 'ledger.sqlite'));
  const n = argv[1] === '--resume' ? 'b' : 'a';
  if (script.run === 'notready') { await l.append(event('run.started', { id: 'rs-a', at: 1, actor: sys, runId: 'r1', payload: {} })); l.close(); process.stderr.write('run r1 → baseline check tooling missing with key ' + process.env.OPENROUTER_API_KEY + ' → exit 3\\n'); process.exit(3); }
  await l.append(event('run.started', { id: 'rs-' + n, at: 1, actor: sys, runId: 'r1', payload: {} }));
  if (script.run === 'hold' && n === 'a') await l.append(event('approval.requested', { id: 'ar', at: 1, actor: sys, runId: 'r1', trace: { goalId: 'g', intentionId: 'i', stepId: 'pr' }, payload: { requestId: 'q1', action: 'open_pr' } }));
  l.close();
  process.exit(script.run === 'hold' && n === 'a' ? 4 : 0);
}
if (argv[0] === 'approve') process.exit(script.approve ?? 0);
process.exit(0);
`,
  );
  return { bin, calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []) };
}

describe('the drive, against a stand-in CLI', () => {
  const ENV = { PATH: process.env.PATH, HOME: process.env.HOME };

  it('live: a missing key is reported before anything is started, not even init', async () => {
    const f = fakeCli({ run: 'done' });
    const err = await runScenario(S(1), { mode: 'live', bin: f.bin, env: { ...ENV, OPENROUTER_API_KEY: 'live-openrouter-value-123' } }).catch((e: unknown) => e);
    expect(String((err as Error).message)).toMatch(/live mode needs OPENAI_API_KEY/);
    expect(f.calls()).toEqual([]);
  });

  it('a failing init is reported without the key values it printed', async () => {
    const f = fakeCli({ init: 'fail', run: 'done' });
    const err = await runScenario(S(1), { mode: 'live', bin: f.bin, env: { ...ENV, OPENROUTER_API_KEY: 'live-openrouter-value-123', OPENAI_API_KEY: 'live-openai-value-456' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerError);
    expect(String((err as Error).message)).toMatch(/tecera init exited 1: init failed with key \[OPENROUTER_API_KEY\]/);
    expect(String((err as Error).message)).not.toContain('live-openrouter-value');
  });

  it('a decision the CLI refused is not counted as a touch, and the drive says why it stopped', async () => {
    const f = fakeCli({ run: 'hold', approve: 1 });
    const r = await runScenario(S(1), { mode: 'scripted', bin: f.bin, env: ENV });
    expect(f.calls().map((a) => a[0])).toEqual(['init', 'run', 'approve']);
    expect(r.touches).toEqual([]);
    expect(r.stopped).toBe('approve q1 exited 1');
    const ok = fakeCli({ run: 'hold', approve: 0 });
    const r2 = await runScenario(S(1), { mode: 'scripted', bin: ok.bin, env: ENV });
    expect(r2.touches).toEqual([{ kind: 'approval', as: HUMANS.reviewer, ref: 'q1', exitCode: 0 }]);
    expect(r2.stopped).toBeUndefined();
  }, 60_000);

  it('a CLI that refuses to run on this host (exit 3) stops the drive with its reason: never a scored attempt, never a key value', async () => {
    const f = fakeCli({ run: 'notready' });
    const r = await runScenario(S(1), { mode: 'live', bin: f.bin, env: { ...ENV, OPENROUTER_API_KEY: 'live-openrouter-value-123', OPENAI_API_KEY: 'live-openai-value-456' } });
    expect(f.calls().map((a) => a[0])).toEqual(['init', 'run']);
    expect(r.stopped).toBe('the CLI refused to run on this host (exit 3): run r1 → baseline check tooling missing with key [OPENROUTER_API_KEY] → exit 3');
    expect(r.score.passed).toBe(false);
  }, 60_000);

  it('an intervention the scenario declares but the drive never performed is reported as stopped', async () => {
    const f = fakeCli({ run: 'done' });
    const r = await runScenario(S(9), { mode: 'scripted', bin: f.bin, env: ENV });
    expect(r.touches).toEqual([]);
    expect(r.stopped).toBe('intervention never performed: kill at step 2, amend greet-format after step 3');
  }, 60_000);
});

describe('summary', () => {
  it('prints one line per scenario and the totals, and the CLI entry is the runtime\'s bin', () => {
    expect(TECERA_BIN).toMatch(/packages\/tecera\/bin\/tecera\.js$/);
    expect(existsSync(TECERA_BIN)).toBe(true);
    const lines = summaryLines({ card: { totals: { passed: 0, scenarios: 0 } } as never, runs: [] });
    expect(lines).toEqual(['0/0 scenarios passed']);
  });
});
