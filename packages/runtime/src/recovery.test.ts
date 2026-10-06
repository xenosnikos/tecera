import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TeceraEvent } from '@tecera/contracts';
import { SqliteLedger } from '@tecera/ledger';
import { main, type MainOptions } from './cli/main.js';
import { replayRun } from './replay.js';
import { createWiring } from './wiring.js';

/**
 * security.md §4 recovery matrix, end to end: the run executes in a CHILD process (the supervisor, the real
 * `tecera run` with the real wiring) that SIGKILLs itself at a chosen step — no cleanup, no run.ended, the
 * worktree lease left to expire, sandbox/verify children orphaned. The test then restarts the run in this
 * process (`tecera run --resume`) and asserts the matrix outcome. The supervisor imports the runtime's dist
 * (built here when stale), the sample is the shipped one, models are scripted.
 *
 * D6: writes and the commit need no approval, so every crash below happens in the FIRST segment of the run;
 * the only hold is the PR (approved by a local human, D1), after which the resume delivers it.
 *
 * Injection points (each proven reached: the child writes where it died before killing itself):
 *  S2 exec child   - the edit step's exec, right after its src write landed (tool result ok)
 *  S3 freeze (D1)  - the first verify gate is entered, before it snapshots anything
 *  S4 verify       - the first verify's command is RUNNING (it wrote a marker file, then sleeps)
 *  S5 review       - the reviewer request leaves the host (the provider call is lost)
 *  S6 final verify - the second verify's command is RUNNING
 *  S7 approval     - approval.requested for the PR is durable, step.held is not
 *  S8 commit       - git commit/update-ref done, the final commit evidence row not yet written
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const REPO = resolve(HERE, '../../..');
const SAMPLE = join(REPO, 'samples/fix-failing-test');
const FIXTURES = resolve(HERE, '../test-fixtures/fix-failing-test');
const LEASE_TTL_MS = 1500;

const temps: string[] = [];
const orphans: number[] = [];
afterEach(() => {
  for (const p of orphans.splice(0)) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix = 'tecera-rec-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

/** The supervisor imports dist: rebuild it when any source is newer (never via npm/npx). */
beforeAll(() => {
  const newest = (dir: string): number => {
    let t = 0;
    for (const n of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, n.name);
      if (n.isDirectory()) t = Math.max(t, newest(p));
      else if (n.name.endsWith('.ts') && !n.name.endsWith('.test.ts')) t = Math.max(t, statSync(p).mtimeMs);
    }
    return t;
  };
  const built = existsSync(join(PKG, 'dist/index.js')) ? statSync(join(PKG, 'dist/commands/run.js')).mtimeMs : 0;
  if (newest(join(PKG, 'src')) > built) execFileSync(process.execPath, [join(REPO, 'node_modules/typescript/bin/tsc'), '-p', PKG], { stdio: 'inherit' });
}, 300_000);

const HOST = typeof process.getuid === 'function' && process.getuid() === 0 ? { TECERA_VERIFY_ALLOW_ROOT: '1' } : {};
const ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/root', USER: 'tester', ...HOST };
const KEYS = { ANTHROPIC_API_KEY: 'test-anthropic-credential-0123456789', OPENAI_API_KEY: 'test-openai-credential-9876543210', OPENROUTER_API_KEY: 'test-openrouter-credential-5555555555' };

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args], { env: { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null' } }).toString('utf8');
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

/**
 * The newest pending approval: an approval.requested (loop / gate holds) or a worker-owned step.held (one
 * write under degraded isolation: the worker requested it on the ledger) not yet granted, denied, expired
 * or consumed.
 */
function pendingRequest(evs: TeceraEvent[]): TeceraEvent | undefined {
  const closed = new Set(evs.filter((e) => ['approval.granted', 'approval.denied', 'approval.expired', 'approval.consumed'].includes(e.kind)).map((e) => (e.payload as { requestId?: string }).requestId));
  return [...evs].reverse().find((e) => (e.kind === 'approval.requested' || (e.kind === 'step.held' && (e.payload as { owner?: string }).owner === 'worker')) && !closed.has((e.payload as { requestId: string }).requestId));
}

type Reply = { text: string; expect?: string; usage?: unknown };
const fixture = (): { worker: Reply[]; reviewer: Reply[] } => JSON.parse(readFileSync(join(FIXTURES, 'replies.json'), 'utf8'));
function scripts(replies: Record<string, unknown>): string {
  const d = tmp('tecera-rec-scripts-');
  cpSync(join(FIXTURES, 'plan.json'), join(d, 'plan.json'));
  writeFileSync(join(d, 'replies.json'), JSON.stringify(replies));
  return d;
}

/**
 * The shipped sample, initialised and committed. For S4/S6 a slow test file is added to the base commit: it
 * writes `marker` (proving the verify command itself is running) and sleeps, so the kill lands mid-command.
 */
async function sampleRepo(slowMarker?: string): Promise<{ dir: string; wt: string; env: Record<string, string> }> {
  const dir = tmp();
  cpSync(SAMPLE, dir, { recursive: true, filter: (src) => !/node_modules|ledger\.sqlite|[\\/]runs([\\/]|$)/.test(src) });
  const manifest = JSON.parse(readFileSync(join(dir, 'tecera.json'), 'utf8'));
  const goal = join(dir, '.tecera/goals/fix-failing-test.goal.md');
  // the shipped sample runs unmodified; it must never run npm on this host
  expect(manifest.verify.command).toBe('node --test');
  for (const m of readFileSync(goal, 'utf8').matchAll(/^verify: (.*)$/gm)) expect(/(^|\s)(npm|npx)(\s|$)/.test(m[1]!)).toBe(false);
  if (slowMarker) {
    writeFileSync(join(dir, 'test/zz-slow.test.js'), `import { test } from 'node:test';\nimport { writeFileSync } from 'node:fs';\ntest('slow', async () => { try { writeFileSync(${JSON.stringify(slowMarker)}, String(process.pid)); } catch {} await new Promise((r) => setTimeout(r, 2500)); });\n`);
  }
  expect((await cli(dir, ['init'])).code).toBe(0);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const wt = tmp('tecera-rec-wt-');
  return { dir, wt, env: { ...KEYS, TECERA_WORKTREES: wt } };
}

async function approve(dir: string, env: Record<string, string>, stepId: string): Promise<string> {
  const held = pendingRequest(await events(dir));
  expect(held?.trace.stepId, `pending approval for ${stepId}`).toBe(stepId);
  const requestId = (held!.payload as { requestId: string }).requestId;
  const a = await cli(dir, ['approve', requestId, '--as', 'reviewer-human'], { env });
  expect(a.code, a.err).toBe(0);
  return requestId;
}

const CHILD = String.raw`
import { readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { main, createWiring } = await import(cfg.runtimeIndex);
function ppidOf(pid) { try { const s = readFileSync('/proc/' + pid + '/stat', 'utf8'); return Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]); } catch { return -1; } }
function descendants(root) {
  const kids = new Map();
  for (const d of readdirSync('/proc')) { if (!/^\d+$/.test(d)) continue; const p = Number(d); const pp = ppidOf(p); if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(p); }
  const out = []; const stack = [root];
  while (stack.length) { const p = stack.pop(); for (const k of kids.get(p) || []) { out.push(k); stack.push(k); } }
  return out;
}
function die(where) { writeFileSync(cfg.diedFile, JSON.stringify({ where, pids: descendants(process.pid) })); process.kill(process.pid, 'SIGKILL'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let verifies = 0;
const inner = createWiring({
  leaseTtlMs: cfg.leaseTtlMs,
  tap: (seat) => { if (cfg.at === 'S5' && seat === 'reviewer') die('S5'); },
  childTap: (kind, data) => {
    if (cfg.at === 'S2' && kind === 'result' && data.includes('tool:edit') && data.includes('"ok":true')) {
      // an orphaned writer that keeps working in the worktree after the supervisor dies (detached: its own
      // session, so the supervisor's death does not take it down)
      const wt = cfg.worktreesRoot + '/' + readdirSync(cfg.worktreesRoot, { withFileTypes: true }).filter((n) => n.isDirectory())[0].name;
      spawn('sh', ['-c', 'while :; do echo stale >> .orphan-writes; sleep 0.2; done'], { cwd: wt, detached: true, stdio: 'ignore' }).unref();
      die('S2');
    }
  },
});
const wire = async (ctx) => {
  const l = ctx.ledger;
  const append = l.append.bind(l);
  const evidence = l.evidence.bind(l);
  l.append = async (e) => { const r = await append(e); if (cfg.at === 'S7' && e.kind === 'approval.requested' && e.trace.stepId === 'pr') die('S7'); return r; };
  l.evidence = async (e) => { if (cfg.at === 'S8' && e.kind === 'gate.commit' && e.key.startsWith('commit:' + ctx.runId + ':') && e.body && e.body.outcome === 'committed') die('S8'); return evidence(e); };
  const ports = await inner(ctx);
  const gates = ports.gates;
  ports.gates = {
    ...gates,
    verify: async (g) => {
      verifies++;
      if (cfg.at === 'S3' && verifies === 1) die('S3');
      if ((cfg.at === 'S4' && verifies === 1) || (cfg.at === 'S6' && verifies === 2)) {
        if (existsSync(cfg.marker)) rmSync(cfg.marker);
        const p = gates.verify(g);
        for (let i = 0; i < 800 && !existsSync(cfg.marker); i++) await sleep(25);
        if (!existsSync(cfg.marker)) { writeFileSync(cfg.diedFile, JSON.stringify({ where: null, error: 'the verify command never ran' })); process.exit(97); }
        die(cfg.at);
        return p;
      }
      return gates.verify(g);
    },
  };
  return ports;
};
const code = await main(cfg.argv, { cwd: cfg.cwd, env: cfg.env, stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s), isTTY: false, wire });
writeFileSync(cfg.diedFile, JSON.stringify({ where: null, exitCode: code }));
process.exit(code);
`;

interface Crash {
  where: string | null;
  pids: number[];
  signal: string | null;
  stdout: string;
  stderr: string;
}

/** Run `tecera run fix-failing-test` (fresh) in a supervisor child that SIGKILLs itself at `at`. */
async function crashRun(o: { dir: string; env: Record<string, string>; replies: Record<string, unknown>; at: string; marker?: string }): Promise<Crash & { runId: string }> {
  const c = await crashResume({ ...o, argv: ['run', 'fix-failing-test', '--scripted', scripts(o.replies)] });
  const runId = (await events(o.dir)).find((e) => e.kind === 'run.started')!.runId!;
  return { ...c, runId };
}

async function crashResume(o: { dir: string; env: Record<string, string>; runId?: string; argv?: string[]; replies: Record<string, unknown>; at: string; marker?: string }): Promise<Crash> {
  const d = tmp('tecera-rec-sup-');
  const cfgPath = join(d, 'cfg.json');
  const diedFile = join(d, 'died.json');
  writeFileSync(join(d, 'supervisor.mjs'), CHILD);
  writeFileSync(
    cfgPath,
    JSON.stringify({
      runtimeIndex: pathToFileURL(join(PKG, 'dist/index.js')).href,
      argv: o.argv ?? ['run', '--resume', o.runId!, '--scripted', scripts(o.replies)],
      cwd: o.dir,
      env: { ...ENV, ...o.env },
      at: o.at,
      diedFile,
      marker: o.marker ?? join(d, 'unused-marker'),
      leaseTtlMs: LEASE_TTL_MS,
      // S2's orphan works in the run's worktree: the only run under this worktrees root
      worktreesRoot: o.env.TECERA_WORKTREES!,
    }),
  );
  const child = spawn(process.execPath, [join(d, 'supervisor.mjs'), cfgPath], { cwd: d, env: { PATH: ENV.PATH, HOME: ENV.HOME }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b) => (stdout += b));
  child.stderr.on('data', (b) => (stderr += b));
  const timer = setTimeout(() => child.kill('SIGKILL'), 240_000);
  const [, signal] = await new Promise<[number | null, string | null]>((res) => child.on('close', (c, s) => res([c, s])));
  clearTimeout(timer);
  const rec = existsSync(diedFile) ? (JSON.parse(readFileSync(diedFile, 'utf8')) as { where: string | null; pids?: number[] }) : { where: null };
  const pids = rec.pids ?? [];
  orphans.push(...pids);
  // the lease the dead supervisor held must expire before anyone may drive the worktree again. NO process
  // cleanup here: whatever the dead supervisor left running is the restart's job to find and kill.
  await new Promise((r) => setTimeout(r, LEASE_TTL_MS + 700));
  return { where: rec.where, pids, signal, stdout, stderr };
}

/** Is this pid alive (not a zombie)? */
function alive(pid: number): boolean {
  try {
    const st = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !/^\d+ \(.*\) [ZX] /.test(st);
  } catch {
    return false;
  }
}

const SRC_BEFORE = readFileSync(join(SAMPLE, 'src/slugify.js'), 'utf8');

/** After recovery reached the PR hold: approve it (local principal) and resume to the end (exit 0); one commit, one PR, chain valid, replay agrees. */
async function finishAfterPrHold(dir: string, env: Record<string, string>, runId: string): Promise<void> {
  await approve(dir, env, 'pr');
  const r = await cli(dir, ['run', '--resume', runId, '--scripted', scripts({})], { env });
  expect(r.code, r.err + r.out).toBe(0);
  await assertCommittedOnce(dir, runId);
}

async function assertCommittedOnce(dir: string, runId: string): Promise<void> {
  const evs = (await events(dir)).filter((e) => e.runId === runId);
  expect(evs.filter((e) => e.kind === 'commit.recorded')).toHaveLength(1);
  expect(evs.filter((e) => e.kind === 'pr.requested' || e.kind === 'pr.opened')).toHaveLength(1);
  expect(evs.filter((e) => e.kind === 'goal.achieved')).toHaveLength(1);
  expect((evs.find((e) => e.kind === 'goal.achieved')!.payload as { proof?: { command?: string } }).proof?.command).toBe('node --test');
  expect(git(dir, 'rev-list', '--count', 'main..tecera/fix-failing-test').trim()).toBe('1');
  expect(git(dir, 'diff', '--name-only', 'main', 'tecera/fix-failing-test').trim().split('\n')).toEqual(['src/slugify.js']);
  const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
  expect((await l.verifyChain()).ok).toBe(true);
  const replay = await replayRun(l, runId);
  l.close();
  expect(replay.goals['g_fix-failing-test'], JSON.stringify(replay.goals)).toMatchObject({ derived: 'achieved', agrees: true });
}

async function dump(dir: string): Promise<string> {
  const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
  const lines: string[] = [];
  for await (const e of l.events()) {
    lines.push(`${e.seq} ${e.kind} ${e.trace.stepId ?? ''} ${JSON.stringify(e.payload).slice(0, 500)}`);
    const k = (e.payload as { evidenceKey?: string }).evidenceKey;
    if (k && /commit|review/.test(e.kind)) lines.push(`    evidence ${JSON.stringify((await l.getEvidence(k))?.body).slice(0, 1200)}`);
  }
  l.close();
  return lines.join('\n');
}

const kindsOf = async (dir: string, runId: string): Promise<string[]> => (await events(dir)).filter((e) => e.runId === runId).map((e) => e.kind);

describe('recover.crash_each_step: SIGKILL the supervisor at each §4 step, restart, matrix outcome', () => {
  it('S2 exec child: the supervisor is SIGKILLed right after the edit write landed (no harness cleanup) → restart reaps the dead supervisor\'s processes itself, restores the worktree to its checkpoint (the uncheckpointed write is discarded) BEFORE anything runs, restarts the worker with attempt + 1 (no approval, D6), then the gates and the PR hold; exactly one commit and one PR', async () => {
    const { dir, wt, env } = await sampleRepo();
    const fx = fixture();
    const crash = await crashRun({ dir, env, at: 'S2', replies: { worker: fx.worker, reviewer: fx.reviewer } });
    const runId = crash.runId;
    expect(crash.where, crash.stderr + crash.stdout).toBe('S2');
    expect(crash.signal).toBe('SIGKILL');
    const wtSrc = join(wt, runId, 'src/slugify.js');
    expect(readFileSync(wtSrc, 'utf8'), 'the write landed before the crash').not.toBe(SRC_BEFORE);
    // what the dead supervisor left running is NOT cleaned up by this harness: its orphaned writer is still
    // writing into the worktree when the restart begins
    const leftover = crash.pids.filter(alive);
    expect(leftover.length, 'the dead supervisor left a live writer behind').toBeGreaterThanOrEqual(1);
    const orphanLog = join(wt, runId, '.orphan-writes');
    expect(existsSync(orphanLog)).toBe(true);
    const restart = await cli(dir, ['run', '--resume', runId, '--scripted', scripts({ worker: [fx.worker[1]], reviewer: fx.reviewer })], { env });
    if (restart.code !== 4) console.log(await dump(dir));
    expect(restart.code, restart.err + restart.out).toBe(4);
    // the restart killed every process of the previous supervisor itself, before restoring the worktree
    for (const p of [...leftover, ...crash.pids]) expect(alive(p), `pid ${p} of the dead supervisor survived the restart`).toBe(false);
    expect(restart.out + restart.err).toMatch(/reaped pid/);
    const evs = (await events(dir)).filter((e) => e.runId === runId);
    expect(evs.some((e) => e.kind === 'evidence.appended' && (e.payload as { kind?: string }).kind === 'recovery.reaped')).toBe(true);
    // the orphan's writes were discarded with the worktree restore and nothing writes any more
    await new Promise((r) => setTimeout(r, 600));
    expect(existsSync(orphanLog), 'no writer survived to write again').toBe(false);
    expect(evs.some((e) => e.kind === 'step.interrupted' && e.trace.stepId === 'edit')).toBe(true);
    // the uncheckpointed write was gone before attempt 2 started: the worktree went back to its checkpoint
    const restored = evs.find((e) => e.kind === 'intention.advanced' && (e.payload as { worktreeRestored?: string }).worktreeRestored !== undefined);
    expect(restored, 'confirmWorktreeRestored recorded').toBeTruthy();
    const required = evs.find((e) => e.kind === 'intention.advanced' && (e.payload as { worktreeRequired?: unknown }).worktreeRequired !== undefined)!;
    expect(required.seq).toBeLessThan(restored!.seq);
    const editRestarted = evs.filter((e) => e.kind === 'step.requested' && e.trace.stepId === 'edit').pop()!;
    expect(editRestarted.seq).toBeGreaterThan(restored!.seq);
    const attempt = [...evs].reverse().find((e) => e.kind.startsWith('intention.') && (e.payload as { intention?: { attempt?: number } }).intention?.attempt !== undefined)!;
    expect((attempt.payload as { intention: { attempt: number } }).intention.attempt).toBe(2);
    // D6: nothing but the PR asked for an approval
    expect(evs.filter((e) => e.kind === 'approval.requested').map((e) => e.trace.stepId)).toEqual(['pr']);
    expect(pendingRequest(evs)?.trace.stepId).toBe('pr');
    await finishAfterPrHold(dir, env, runId);
  }, 600_000);

  it('S3 freeze: killed as the first verify gate is entered → verify.interrupted, re-run on restart, then review, verify, commit, PR hold; completes with one commit', async () => {
    const { dir, env } = await sampleRepo();
    const fx = fixture();
    const crash = await crashRun({ dir, env, at: 'S3', replies: { worker: fx.worker, reviewer: fx.reviewer } });
    const runId = crash.runId;
    expect(crash.where, crash.stderr + crash.stdout).toBe('S3');
    const restart = await cli(dir, ['run', '--resume', runId, '--scripted', scripts({ reviewer: fx.reviewer })], { env });
    expect(restart.code, restart.err + restart.out).toBe(4);
    const kinds = await kindsOf(dir, runId);
    expect(kinds).toContain('verify.interrupted');
    expect(pendingRequest((await events(dir)).filter((e) => e.runId === runId))?.trace.stepId).toBe('pr');
    await finishAfterPrHold(dir, env, runId);
  }, 600_000);

  it('S4 verify: killed while the check command runs → interrupted-verify evidence, re-run must reproduce D1, then continues to the PR hold and completes', async () => {
    const marker = join(tmp('tecera-rec-marker-'), 'verify-running');
    const { dir, env } = await sampleRepo(marker);
    const fx = fixture();
    const crash = await crashRun({ dir, env, at: 'S4', marker, replies: { worker: fx.worker, reviewer: fx.reviewer } });
    const runId = crash.runId;
    expect(crash.where, crash.stderr + crash.stdout).toBe('S4');
    const restart = await cli(dir, ['run', '--resume', runId, '--scripted', scripts({ reviewer: fx.reviewer })], { env });
    expect(restart.code, restart.err + restart.out).toBe(4);
    const evs = (await events(dir)).filter((e) => e.runId === runId);
    expect(evs.some((e) => e.kind === 'verify.interrupted')).toBe(true);
    const rerun = evs.filter((e) => e.kind === 'verify.started' && (e.payload as { recovered?: boolean }).recovered === true);
    expect(rerun.length).toBeGreaterThanOrEqual(1);
    await finishAfterPrHold(dir, env, runId);
  }, 600_000);

  it('S5 review: the reviewer call is lost with the supervisor → on restart the lost review stops for a human (exit 9) without another reviewer call; no commit, no PR approval', async () => {
    const { dir, env } = await sampleRepo();
    const fx = fixture();
    const crash = await crashRun({ dir, env, at: 'S5', replies: { worker: fx.worker, reviewer: fx.reviewer } });
    const runId = crash.runId;
    expect(crash.where, crash.stderr + crash.stdout).toBe('S5');
    const asked: string[] = [];
    const wire = createWiring({ tap: (seat) => void asked.push(seat) });
    const restart = await cli(dir, ['run', '--resume', runId, '--scripted', scripts({ reviewer: fx.reviewer })], { env, wire });
    const evs = (await events(dir)).filter((e) => e.runId === runId);
    if (restart.code !== 9) console.log(await dump(dir));
    expect(restart.code, restart.err + restart.out).toBe(9);
    // at most one reviewer call per (run, D1): the lost call counts, no second one is made
    expect(asked.filter((s) => s === 'reviewer')).toHaveLength(0);
    expect(evs.map((e) => e.kind)).not.toContain('approval.requested');
    expect(evs.map((e) => e.kind)).not.toContain('commit.recorded');
    expect(git(dir, 'branch', '--list', 'tecera/*').trim()).toBe('');
    const failed = [...evs].reverse().find((e) => e.kind === 'step.failed')!;
    expect(failed.trace.stepId).toBe('review');
    expect(failed.payload).toMatchObject({ terminal: true, failure: 'human' });
  }, 600_000);

  it('S6 final verify: killed while the second check runs → re-run on restart must equal D1, then the commit and the PR hold; completes', async () => {
    const marker = join(tmp('tecera-rec-marker-'), 'verify-running');
    const { dir, env } = await sampleRepo(marker);
    const fx = fixture();
    const crash = await crashRun({ dir, env, at: 'S6', marker, replies: { worker: fx.worker, reviewer: fx.reviewer } });
    const runId = crash.runId;
    expect(crash.where, crash.stderr + crash.stdout).toBe('S6');
    const restart = await cli(dir, ['run', '--resume', runId, '--scripted', scripts({})], { env });
    expect(restart.code, restart.err + restart.out).toBe(4);
    const evs = (await events(dir)).filter((e) => e.runId === runId);
    expect(evs.some((e) => e.kind === 'verify.interrupted')).toBe(true);
    expect(evs.filter((e) => e.kind === 'review.passed')).toHaveLength(1);
    expect(pendingRequest(evs)?.trace.stepId).toBe('pr');
    await finishAfterPrHold(dir, env, runId);
  }, 600_000);

  it('S7 approval: killed after the PR approval request is durable but before step.held → restart re-holds the SAME request (durable), exit 4; approving it completes', async () => {
    const { dir, env } = await sampleRepo();
    const fx = fixture();
    const crash = await crashRun({ dir, env, at: 'S7', replies: { worker: fx.worker, reviewer: fx.reviewer } });
    const runId = crash.runId;
    expect(crash.where, crash.stderr + crash.stdout).toBe('S7');
    const requested = (await events(dir)).filter((e) => e.runId === runId && e.kind === 'approval.requested' && e.trace.stepId === 'pr');
    expect(requested).toHaveLength(1);
    const restart = await cli(dir, ['run', '--resume', runId, '--scripted', scripts({})], { env });
    expect(restart.code, restart.err + restart.out).toBe(4);
    const evs = (await events(dir)).filter((e) => e.runId === runId);
    expect(evs.filter((e) => e.kind === 'approval.requested' && e.trace.stepId === 'pr')).toHaveLength(1);
    expect(evs.some((e) => e.kind === 'step.held' && e.trace.stepId === 'pr' && (e.payload as { requestId: string }).requestId === (requested[0]!.payload as { requestId: string }).requestId)).toBe(true);
    await finishAfterPrHold(dir, env, runId);
  }, 600_000);

  it('S8 commit: killed between the git commit and its final record → restart reconciles (HEAD tree = recorded write-tree) and records it once; never commits again; then the PR hold completes', async () => {
    const { dir, env } = await sampleRepo();
    const fx = fixture();
    const crash = await crashRun({ dir, env, at: 'S8', replies: { worker: fx.worker, reviewer: fx.reviewer } });
    const runId = crash.runId;
    expect(crash.where, crash.stderr + crash.stdout).toBe('S8');
    expect((await kindsOf(dir, runId)).filter((k) => k === 'commit.recorded')).toHaveLength(0);
    const shaBefore = git(dir, 'rev-parse', 'tecera/fix-failing-test').trim();
    const restart = await cli(dir, ['run', '--resume', runId, '--scripted', scripts({})], { env });
    if (restart.code !== 4) console.log(await dump(dir));
    expect(restart.code, restart.err + restart.out).toBe(4);
    const evs = (await events(dir)).filter((e) => e.runId === runId);
    const rec = evs.find((e) => e.kind === 'commit.recorded')!;
    expect(rec.payload).toMatchObject({ sha: shaBefore, reconciled: true });
    expect(pendingRequest(evs)?.trace.stepId).toBe('pr');
    expect((pendingRequest(evs)!.payload as { sha?: string }).sha).toBe(shaBefore);
    await finishAfterPrHold(dir, env, runId);
    expect(git(dir, 'rev-parse', 'tecera/fix-failing-test').trim()).toBe(shaBefore);
    // a second restart is a no-op
    const again = await cli(dir, ['run', '--resume', runId, '--scripted', scripts({})], { env });
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/nothing to resume/);
  }, 600_000);
});

const js = (body: string): string => `\`\`\`js\n${body}\n\`\`\``;
