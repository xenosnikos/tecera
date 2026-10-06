import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Ledger } from '@tecera/contracts';
import { SqliteLedger } from '@tecera/ledger';
import { replayRun } from '@tecera/runtime';
import { crashRun, LEASE_TTL_MS, type CrashPoint, type CrashResult } from './harness/crash.js';
import { approve, dump, fixtureReplies, Flow, git, js, ledgerEvents, requestIdOf, runIdOf, sampleRepo, type Ev } from './harness/e2e.js';
import { alive, cmdline, processesUnder } from './harness/procs.js';
import { cleanupTemps, sleep, tmp } from './harness/tmp.js';

/**
 * security.md §6 recover.*: the first job, with the supervisor SIGKILLed at each step of the §4 recovery
 * matrix (S2…S9) and restarted with `tecera run --resume`; and the no-progress rule (two execs, equal
 * digests → stop for a human). Everything runs the REAL runtime/loop/worker/gates/ledger (scripted models).
 *
 * Owner decision D6: nothing holds before the PR, so the crashed segment is the FIRST `tecera run` itself
 * (S2…S8), run in a child supervisor (harness/crash.ts) that freezes at the injection point and is SIGKILLed
 * from here; S9 is the resume after the human approved the PR. The restart is `tecera run --resume` in this
 * process. The PR grant is the only approval of a run; it is bound to the committed sha and spent once.
 */

afterAll(cleanupTemps);

const SRC = 'src/slugify.js';
const FIX = ".replace(/[^a-z0-9]+/g, '-')";
const BRANCH = 'tecera/fix-failing-test';

interface Scenario {
  flow: Flow;
  crash: CrashResult;
  base: string;
}

/** A repo whose test suite carries a slow test that writes its pid to `marker` (proves the verify command runs). */
async function repo(o: { marker?: string; mutate?: (dir: string) => void } = {}): Promise<{ dir: string; wt: string }> {
  return sampleRepo({
    mutate: (d) => {
      if (o.marker) {
        writeFileSync(
          join(d, 'test/zz-slow.test.js'),
          `import { test } from 'node:test';\nimport { writeFileSync } from 'node:fs';\ntest('slow', async () => { try { writeFileSync(${JSON.stringify(o.marker)}, String(process.pid)); } catch {} await new Promise((r) => setTimeout(r, 2500)); });\n`,
        );
      }
      o.mutate?.(d);
    },
  });
}

function markerPath(): string {
  const d = tmp('tecera-adv-marker-');
  chmodSync(d, 0o777);
  return join(d, 'verify-running');
}

/** A fresh sample repo and its flow, before anything ran. */
async function fresh(o: { marker?: string; mutate?: (dir: string) => void } = {}): Promise<{ flow: Flow; base: string }> {
  const { dir, wt } = await repo(o);
  return { flow: new Flow(dir, wt), base: readFileSync(join(dir, SRC), 'utf8') };
}

/** The crashed segment (the first run, or a resume when the flow already has a run), killed at `at`. */
async function crash(flow: Flow, at: CrashPoint, marker?: string): Promise<CrashResult> {
  const before = flow.runId ? await flow.events() : [];
  const endedBefore = before.filter((e) => e.kind === 'run.ended').length;
  const c = await crashRun({ cwd: flow.dir, argv: flow.argv(), env: flow.env, at, ...(marker ? { marker, liveNeedle: 'zz-slow.test.js' } : {}) });
  // the injection must have fired at the intended step; otherwise this case tested nothing
  expect(c.where, `crash point ${at} never reached: ${c.error ?? ''} exit ${c.exitCode}\n${c.stdout}\n${c.stderr}\n${await dump(flow.dir)}`).toBe(at);
  expect(c.signal).toBe('SIGKILL');
  if (marker) {
    // S4/S6: the verify COMMAND was running (it wrote the marker; its test process is alive and a descendant of the supervisor) at the kill
    expect(c.liveAtKill, `no live verify command among the supervisor's descendants at the kill: ${c.pids.map((p) => `${p}:${cmdline(p)}`).join(' | ')}`).toBe(true);
    expect(c.livePid).toBeGreaterThan(0);
  }
  flow.consumed(c.asked);
  if (!flow.runId) flow.runId = runIdOf(await ledgerEvents(flow.dir));
  const evs = await flow.events();
  expect(evs.filter((e) => e.kind === 'run.ended').length, 'the killed segment wrote run.ended').toBe(endedBefore);
  await sleep(LEASE_TTL_MS + 400); // the dead supervisor's worktree lease expires
  return c;
}

async function crashAt(at: CrashPoint): Promise<Scenario> {
  const marker = at === 'S4' || at === 'S6' ? markerPath() : undefined;
  const { flow, base } = await fresh(marker ? { marker } : {});
  const c = await crash(flow, at, marker);
  return { flow, crash: c, base };
}

/** Orphans of the dead supervisor (sandbox children, verify trees) must be gone: none outlives it. */
async function noOrphans(s: { flow: Flow; crash: CrashResult }): Promise<void> {
  const until = Date.now() + 5_000;
  while (Date.now() < until && s.crash.pids.some(alive)) await sleep(100);
  expect(s.crash.pids.filter(alive), 'processes of the killed supervisor still alive').toEqual([]);
  expect(processesUnder(join(s.flow.wt, s.flow.runId)), 'processes still running inside the worktree').toEqual([]);
}

const prRequests = (evs: Ev[]): Ev[] => evs.filter((e) => e.kind === 'approval.requested' && e.trace.stepId === 'pr');

/** One commit of exactly the reviewed fix, one delivered PR on one spent grant; chain valid; replay derives the achievement. */
async function assertDeliveredOnce(flow: Flow): Promise<Ev[]> {
  const evs = await flow.events();
  expect(evs.filter((e) => e.kind === 'commit.recorded')).toHaveLength(1);
  expect(evs.filter((e) => e.kind === 'pr.requested' || e.kind === 'pr.opened')).toHaveLength(1);
  const achieved = evs.filter((e) => e.kind === 'goal.achieved');
  expect(achieved).toHaveLength(1);
  expect(achieved[0]!.payload, 'goal.achieved carries its proof (D4)').toMatchObject({ proof: { exitCode: 0 } });
  const sha = (evs.find((e) => e.kind === 'commit.recorded')!.payload as { sha: string }).sha;
  expect(git(flow.dir, 'rev-parse', BRANCH).trim()).toBe(sha);
  expect(git(flow.dir, 'rev-list', '--count', `main..${BRANCH}`).trim()).toBe('1');
  expect(git(flow.dir, 'diff', '--name-only', 'main', sha).trim()).toBe(SRC);
  expect(git(flow.dir, 'show', `${sha}:${SRC}`)).toContain(FIX);
  // the only approvals of the run are PR requests; exactly one was consumed, exactly once (an expired one never is)
  expect(evs.filter((e) => e.kind === 'approval.requested' && e.trace.stepId !== 'pr'), 'an approval other than the PR').toEqual([]);
  const rids = prRequests(evs).map((e) => requestIdOf(e));
  const uses = rids.map((rid) => evs.filter((e) => e.kind === 'approval.consumed' && requestIdOf(e) === rid).length);
  expect(uses.filter((n) => n === 1), JSON.stringify({ rids, uses })).toHaveLength(1);
  expect(uses.every((n) => n <= 1)).toBe(true);
  const l = new SqliteLedger(join(flow.dir, '.tecera/ledger.sqlite'));
  try {
    expect(await l.verifyChain()).toMatchObject({ ok: true });
    const replay = await replayRun(l, flow.runId);
    expect(Object.values(replay.goals), JSON.stringify(replay.goals)).toEqual([expect.objectContaining({ derived: 'achieved', agrees: true })]);
  } finally {
    l.close();
  }
  return evs;
}

/** From the PR hold: approve, resume, one delivered PR. */
async function finishFromPrHold(flow: Flow): Promise<void> {
  expect((await flow.pending())?.trace.stepId, await dump(flow.dir)).toBe('pr');
  const done = await flow.finish();
  expect(done.code, done.err + done.out + (await dump(flow.dir))).toBe(0);
  await assertDeliveredOnce(flow);
}

const kinds = (evs: Ev[]): string[] => evs.map((e) => e.kind);

async function approvalState(dir: string, requestId: string): Promise<string | undefined> {
  const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
  try {
    return (await l.getApproval(requestId))?.state;
  } finally {
    l.close();
  }
}

describe('recover (security.md §6, §4 recovery matrix)', () => {
  it('recover.crash_each_step S2 exec child: real supervisor death right after the edit write landed (no harness cleanup) → orphans die, the worktree is restored to the last checkpoint before the step re-executes, the step re-runs with no approval (D6), replaying the same program ends in one commit and one PR on one grant', async () => {
    const s = await crashAt('S2');
    expect(s.crash.pids.length, 'the sandbox child was running at the kill').toBeGreaterThan(0);
    const wtFile = join(s.flow.wt, s.flow.runId, SRC);
    expect(readFileSync(wtFile, 'utf8'), 'the attempt-1 write really landed before the kill').toContain(FIX);
    // idempotent replay: the SAME edit program is served again; the worktree is read the moment the restart
    // asks the worker seat (before the step re-executes): it must already be back at the last checkpoint
    s.flow.setReplies({ worker: [fixtureReplies().worker[1]!], reviewer: fixtureReplies().reviewer });
    let atReask: string | null = null;
    // nothing is cleaned up by the harness: the restart itself must reap the dead supervisor's processes
    const r = await s.flow.segment({ tap: (seat) => void (seat === 'worker' && atReask === null && (atReask = readFileSync(wtFile, 'utf8'))) });
    await noOrphans(s);
    expect(r.code, r.err + r.out + (await dump(s.flow.dir))).toBe(4);
    const evs = await s.flow.events();
    expect(evs.some((e) => e.kind === 'step.interrupted' && e.trace.stepId === 'edit'), kinds(evs).join(' ')).toBe(true);
    // matrix S2: worktree digest vs last checkpoint; mismatch → discard, replay from the checkpoint (no checkpoint after the write: the base)
    expect(atReask, 'worktree when the step re-executes must equal the last checkpoint').toBe(s.base);
    // D6: the re-run needed no approval; the run holds only at the PR
    expect(evs.filter((e) => e.kind === 'approval.requested').map((e) => e.trace.stepId)).toEqual(['pr']);
    expect(evs.filter((e) => e.kind === 'step.completed' && e.trace.stepId === 'edit')).toHaveLength(1);
    await finishFromPrHold(s.flow);
  }, 300_000);

  it('recover.crash_each_step S3 freeze: killed as the first verify gate is entered → verify.interrupted, re-frozen and re-run on restart, then the PR hold; completes with one commit and one PR', async () => {
    const s = await crashAt('S3');
    const r = await s.flow.segment();
    expect(r.code, r.err + r.out + (await dump(s.flow.dir))).toBe(4);
    const evs = await s.flow.events();
    expect(kinds(evs)).toContain('verify.interrupted');
    expect(evs.some((e) => e.kind === 'verify.started' && e.trace.stepId === 'verify' && (e.payload as { recovered?: boolean }).recovered === true)).toBe(true);
    await finishFromPrHold(s.flow);
  }, 300_000);

  it('recover.crash_each_step S4 verify: killed while the check command runs (pid proven live) → the verify tree dies with the supervisor, interrupted-verify evidence, re-run reproduces D1, completes once', async () => {
    const s = await crashAt('S4');
    const r = await s.flow.segment();
    await noOrphans(s);
    expect(s.crash.livePid !== undefined && !alive(s.crash.livePid)).toBe(true);
    expect(r.code, r.err + r.out + (await dump(s.flow.dir))).toBe(4);
    const evs = await s.flow.events();
    const interrupted = evs.find((e) => e.kind === 'verify.interrupted' && e.trace.stepId === 'verify');
    expect(interrupted, kinds(evs).join(' ')).toBeTruthy();
    const rerun = evs.filter((e) => e.kind === 'verify.started' && e.trace.stepId === 'verify' && (e.payload as { recovered?: boolean }).recovered === true);
    expect(rerun.length).toBeGreaterThanOrEqual(1);
    await finishFromPrHold(s.flow);
  }, 300_000);

  for (const at of ['S4', 'S6'] as const) {
    it(`recover.crash_each_step ${at} ${at === 'S4' ? 'verify' : 'final verify'} [digest drift]: killed while the check runs, then the worktree changes while the supervisor is dead → the drifted tree is never reviewed, committed or delivered (re-run digest ≠ D1 → human; or the tree is restored to D1 first)`, async () => {
      const s = await crashAt(at);
      const f = join(s.flow.wt, s.flow.runId, SRC);
      const DRIFT = `// drift written while supervisor ${at} was dead`;
      writeFileSync(f, `${readFileSync(f, 'utf8')}${DRIFT}\n`);
      const reviewed: string[] = [];
      const r = await s.flow.segment({ tap: (seat, _u, body) => void (seat === 'reviewer' && reviewed.push(body)) });
      await noOrphans(s);
      const evs = await s.flow.events();
      expect(reviewed.filter((b) => b.includes('drift written')), 'the drifted tree reached the reviewer').toEqual([]);
      console.log(`[recover ${at} drift] restart exit ${r.code}: ${r.code === 4 ? 'tree restored to D1, run went on' : 'stopped for a human'}`);
      if (r.code === 4) {
        // the only acceptable way on: the tree was put back to D1 before anything else ran
        expect(readFileSync(f, 'utf8'), `restored to D1 before going on\n${await dump(s.flow.dir)}`).not.toContain(DRIFT);
        await finishFromPrHold(s.flow);
        const sha = ((await s.flow.events()).find((e) => e.kind === 'commit.recorded')!.payload as { sha: string }).sha;
        expect(git(s.flow.dir, 'show', `${sha}:${SRC}`)).not.toContain('drift written');
      } else {
        expect(r.code, r.err + r.out + (await dump(s.flow.dir))).toBe(9);
        expect(kinds(evs)).not.toContain('commit.recorded');
        expect(prRequests(evs), 'a PR approval after the drift').toEqual([]);
        expect(evs.some((e) => (e.kind === 'step.failed' || e.kind === 'intention.failed') && (e.payload as { failure?: string }).failure === 'human'), kinds(evs).join(' ')).toBe(true);
        expect(git(s.flow.dir, 'branch', '--list', 'tecera/*').trim()).toBe('');
      }
    }, 300_000);
  }

  for (const seam of ['beforeOpen', 'afterRead'] as const) {
    it(`recover.crash_each_step [S1 takeover, pre-opened call: ${seam}]: the edit call has entered (entry checks passed) when its supervisor stalls, the lease lapses and another holder takes the worktree → the stalled call never publishes its write; the run stops (exit 9); no verify, no commit`, async () => {
      const { flow, base } = await fresh();
      let ledger: Ledger | null = null;
      let stall = false;
      let entered = false;
      let thief: unknown = null;
      const pause = async (x: { rel: string }): Promise<void> => {
        if (x.rel !== SRC) return;
        entered = true;
        stall = true;
        for (let i = 0; i < 400 && !thief; i++) {
          await sleep(25);
          thief = await ledger!.lease(`worktree:${flow.runId || runIdOf(await ledgerEvents(flow.dir))}`, 'run:adv-thief', 60_000).catch(() => null);
        }
      };
      const r = await flow.segment({
        leaseTtlMs: 900,
        editToolSeams: { [seam]: pause },
        wrap: (inner) => async (ctx) => {
          const l = ctx.ledger as Ledger;
          ledger = l;
          const renew = l.renew.bind(l);
          (l as { renew: Ledger['renew'] }).renew = (lease, ttl) => (stall ? new Promise(() => undefined) : renew(lease, ttl));
          return inner(ctx);
        },
      });
      expect(entered, 'the edit call reached the seam (it was in flight when the lease was lost)').toBe(true);
      expect(thief, 'another holder acquired the lease while the call was in flight').toBeTruthy();
      expect(readFileSync(join(flow.wt, flow.runId, SRC), 'utf8'), 'no write after the lease was lost').toBe(base);
      expect(r.code, r.err + r.out + (await dump(flow.dir))).toBe(9);
      const evs = await flow.events();
      expect(kinds(evs)).not.toContain('verify.started');
      expect(kinds(evs)).not.toContain('commit.recorded');
      expect(git(flow.dir, 'branch', '--list', 'tecera/*').trim()).toBe('');
    }, 300_000);
  }

  it('recover.crash_each_step S5 review: the reviewer answer is lost with the supervisor → on restart the reviewer is never asked again for the same D1 (at most once per (run, D1)); no commit, no PR approval; the run stops for a human (failure human, exit 9)', async () => {
    const s = await crashAt('S5');
    expect(s.crash.asked.reviewer, 'the review request left the host before the kill').toBe(1);
    const asked: string[] = [];
    const r = await s.flow.segment({ tap: (seat) => void asked.push(seat) });
    const evs = await s.flow.events();
    // at most once per (run, D1): unconditional
    expect(asked.filter((x) => x === 'reviewer'), 'the reviewer was asked a second time for the same D1').toEqual([]);
    expect(prRequests(evs)).toEqual([]);
    expect(kinds(evs)).not.toContain('commit.recorded');
    expect(git(s.flow.dir, 'branch', '--list', 'tecera/*').trim()).toBe('');
    expect([0, 4]).not.toContain(r.code);
    const failed = [...evs].reverse().find((e) => e.kind === 'step.failed' && e.trace.stepId === 'review');
    expect(failed?.payload, `the lost review ends as a terminal human-needed failure (exit ${r.code}; step.failed ${JSON.stringify(failed?.payload)})`).toMatchObject({ terminal: true, failure: 'human' });
    expect(r.code, r.err + r.out).toBe(9);
    // a further restart asks nobody and commits nothing
    const again: string[] = [];
    const r2 = await s.flow.segment({ tap: (seat) => void again.push(seat) });
    expect(again.filter((x) => x === 'reviewer')).toEqual([]);
    expect([0, 4]).not.toContain(r2.code);
    expect(git(s.flow.dir, 'branch', '--list', 'tecera/*').trim()).toBe('');
  }, 300_000);

  it('recover.crash_each_step S6 final verify: killed while the second check runs (pid proven live) → interrupted, re-run equals D1, not re-reviewed; the PR hold; completes once', async () => {
    const s = await crashAt('S6');
    const r = await s.flow.segment();
    await noOrphans(s);
    expect(r.code, r.err + r.out + (await dump(s.flow.dir))).toBe(4);
    const evs = await s.flow.events();
    expect(evs.some((e) => e.kind === 'verify.interrupted' && e.trace.stepId === 'verify2'), kinds(evs).join(' ')).toBe(true);
    expect(evs.filter((e) => e.kind === 'review.passed')).toHaveLength(1);
    await finishFromPrHold(s.flow);
  }, 300_000);

  it('recover.crash_each_step S7 approval held: killed after the PR approval request is durable, before step.held → restart re-holds the SAME request bound to the same committed sha (exit 4, nothing delivered); approving it completes once', async () => {
    const s = await crashAt('S7');
    expect(s.crash.requestId).toBeTruthy();
    const sha = git(s.flow.dir, 'rev-parse', BRANCH).trim();
    const r = await s.flow.segment();
    expect(r.code, r.err + r.out + (await dump(s.flow.dir))).toBe(4);
    const evs = await s.flow.events();
    expect(prRequests(evs).map((e) => requestIdOf(e))).toEqual([s.crash.requestId]);
    expect(evs.some((e) => e.kind === 'step.held' && e.trace.stepId === 'pr' && requestIdOf(e) === s.crash.requestId)).toBe(true);
    expect(evs.filter((e) => e.kind === 'commit.recorded'), 'committed once, before the hold').toHaveLength(1);
    expect(git(s.flow.dir, 'rev-parse', BRANCH).trim()).toBe(sha);
    // a restart without a grant stays held and delivers nothing
    const again = await s.flow.segment();
    expect(again.code).toBe(4);
    expect(kinds(await s.flow.events())).not.toContain('pr.requested');
    await finishFromPrHold(s.flow);
  }, 300_000);

  it('recover.crash_each_step S7 expiry: the durable PR request expires while the supervisor is dead → on restart it is expired, never consumable, and a fresh request is held for the SAME committed sha (no second commit); approving that completes once', async () => {
    // long enough for the request to survive the child supervisor start-up (imports from the repo mount are slow)
    const ttlSec = 30;
    const { flow } = await fresh({
      mutate: (d) => {
        const m = JSON.parse(readFileSync(join(d, 'tecera.json'), 'utf8'));
        m.policy.approvals.ttlSec = ttlSec;
        writeFileSync(join(d, 'tecera.json'), `${JSON.stringify(m, null, 2)}\n`);
      },
    });
    const c = await crash(flow, 'S7');
    expect(c.requestId).toBeTruthy();
    const sha = git(flow.dir, 'rev-parse', BRANCH).trim();
    await sleep(ttlSec * 1000 + 500);
    const r = await flow.segment();
    const evs = await flow.events();
    expect(evs.some((e) => e.kind === 'approval.expired' && requestIdOf(e) === c.requestId), `${r.code} ${r.err}\n${await dump(flow.dir)}`).toBe(true);
    // the expired request can never be approved (so never consumed)
    expect((await approve(flow.dir, c.requestId!, flow.env)).code).not.toBe(0);
    const reqs = prRequests(evs);
    expect(reqs.length, 'a fresh PR request after the expiry').toBe(2);
    expect(requestIdOf(reqs[1])).not.toBe(c.requestId);
    // bound to the same committed sha: the commit is not redone
    expect(evs.filter((e) => e.kind === 'commit.recorded')).toHaveLength(1);
    expect((reqs[1]!.payload as { candidateD1?: string; sha?: string }).sha ?? (reqs[1]!.payload as { candidateD1?: string }).candidateD1).toBe(sha);
    expect(r.code, r.err + r.out).toBe(4);
    await finishFromPrHold(flow);
    expect((await flow.events()).filter((e) => e.kind === 'approval.consumed' && requestIdOf(e) === c.requestId)).toHaveLength(0);
  }, 300_000);

  it('recover.crash_each_step S8 commit: killed between update-ref and the final record → restart reconciles (HEAD tree = recorded write-tree), records it once with no approval, never commits twice, then holds at the PR; a later restart is a no-op', async () => {
    const { flow } = await fresh();
    await crash(flow, 'S8');
    // the attack state: the commit object and the branch exist, the final record does not
    expect(git(flow.dir, 'rev-list', '--count', `main..${BRANCH}`).trim()).toBe('1');
    const shaBefore = git(flow.dir, 'rev-parse', BRANCH).trim();
    expect(kinds(await flow.events())).not.toContain('commit.recorded');
    const r = await flow.segment();
    expect(r.code, r.err + r.out + (await dump(flow.dir))).toBe(4);
    const evs = await flow.events();
    expect(evs.filter((e) => e.kind === 'commit.recorded')).toHaveLength(1);
    expect(evs.find((e) => e.kind === 'commit.recorded')!.payload).toMatchObject({ sha: shaBefore, reconciled: true });
    expect(evs.filter((e) => e.kind === 'approval.requested').map((e) => e.trace.stepId)).toEqual(['pr']);
    await finishFromPrHold(flow);
    const again = await flow.segment();
    expect(again.code).toBe(0);
    expect(git(flow.dir, 'rev-parse', BRANCH).trim()).toBe(shaBefore);
    expect((await flow.events()).filter((e) => e.kind === 'commit.recorded')).toHaveLength(1);
  }, 300_000);

  it('recover.crash_each_step S9 PR delivery: killed right after the PR gate consumed the human grant, before anything was delivered or recorded → the restart never spends the grant again, never pushes or writes a second delivery, and stops for a human (exit 9)', async () => {
    const { flow } = await fresh();
    const held = await flow.drive();
    expect(held.code, held.err + held.out + (await dump(flow.dir))).toBe(4);
    const rid = await flow.approvePending('pr');
    const mainSha = git(flow.dir, 'rev-parse', 'main').trim();
    const c = await crash(flow, 'S9');
    expect(c.requestId).toBe(rid);
    expect(await approvalState(flow.dir, rid), 'the grant was spent before the kill').toBe('consumed');
    const r = await flow.segment();
    const evs = await flow.events();
    expect(kinds(evs)).not.toContain('pr.requested');
    expect(kinds(evs)).not.toContain('pr.opened');
    expect(kinds(evs)).not.toContain('goal.achieved');
    expect(evs.filter((e) => e.kind === 'approval.consumed' && requestIdOf(e) === rid).length, 'the spent grant consumed again').toBeLessThanOrEqual(1);
    expect((await approve(flow.dir, rid, flow.env)).code, 'a spent grant cannot be re-approved').not.toBe(0);
    expect(r.code, r.err + r.out + (await dump(flow.dir))).toBe(9);
    expect(evs.some((e) => (e.kind === 'step.failed' || e.kind === 'intention.failed') && (e.payload as { failure?: string }).failure === 'human'), kinds(evs).join(' ')).toBe(true);
    expect(git(flow.dir, 'rev-parse', 'main').trim(), 'Tecera never merges').toBe(mainSha);
    // a further restart delivers nothing either
    const r2 = await flow.segment();
    expect([0, 4]).not.toContain(r2.code);
    expect(kinds(await flow.events())).not.toContain('pr.requested');
  }, 300_000);

  it('recover.noop_twice: two worker EXECUTIONS of a no-op program produce equal candidate digests → the run stops for a human with a no-progress reason (no third exec, no commit)', async () => {
    const { dir, wt } = await sampleRepo();
    const r = fixtureReplies();
    const noop = { text: js("console.log('nothing to change');\nreturn { facts: [{ key: 'changedFiles', value: [] }] };") };
    r.worker = [r.worker[0]!, noop, noop, noop, noop, noop, noop];
    const flow = new Flow(dir, wt, r);
    const res = await flow.drive();
    const evs = await flow.events();
    // the attack really ran: the no-op program executed (it reported no change) and the tree never changed
    expect(evs.find((e) => e.kind === 'belief.added' && (e.payload as { key?: string }).key === 'changedFiles')?.payload, await dump(dir)).toMatchObject({ value: [] });
    expect(readFileSync(join(wt, flow.runId, SRC), 'utf8')).toBe(readFileSync(join(dir, SRC), 'utf8'));
    // two worker executions of the edit step (the verify failure re-ran the closest upstream worker step)
    const edits = evs.filter((e) => e.kind === 'step.completed' && e.trace.stepId === 'edit');
    expect(edits.length, `worker executions of edit\n${await dump(dir)}`).toBe(2);
    expect(flow.segments.reduce((n, x) => n + (x.asked.worker ?? 0), 0), 'the worker seat was asked once per exec (plus analyze)').toBe(3);
    const verifies = evs.filter((e) => (e.kind === 'verify.failed' || e.kind === 'verify.passed') && e.trace.stepId === 'verify');
    expect(verifies.length, 'one verify per exec, no third').toBe(2);
    const fps = verifies.map((e) => (e.payload as { fingerprint?: string }).fingerprint);
    expect(new Set(fps).size, 'equal candidate digests').toBe(1);
    const execs = verifies.map((e) => (e.payload as { workerExec?: unknown }).workerExec);
    expect(execs.every((x) => x !== undefined), JSON.stringify(verifies.map((v) => v.payload))).toBe(true);
    expect(new Set(execs.map(String)).size, 'the two verifies belong to two different worker executions').toBe(2);
    const stops = evs.filter((e) => ['verify.failed', 'step.failed', 'intention.failed', 'goal.dropped'].includes(e.kind)).map((e) => JSON.stringify(e.payload));
    expect(stops.join('\n'), `exit ${res.code}\n${await dump(dir)}`).toMatch(/no[- ]?progress/i);
    expect(verifies.at(-1)!.payload).toMatchObject({ noProgress: true });
    expect(evs.some((e) => e.kind === 'step.failed' && (e.payload as { failure?: string }).failure === 'human')).toBe(true);
    expect(res.code, res.err + res.out).toBe(9);
    expect(kinds(evs)).not.toContain('commit.recorded');
    expect(kinds(evs)).not.toContain('approval.requested');
  }, 300_000);
});
