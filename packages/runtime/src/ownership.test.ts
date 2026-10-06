import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FencedWriteGuard, type GateContext } from '@tecera/contracts';
import { MemoryLedger } from '@tecera/ledger';
import { leasedGateContext, leaseGuard, mutationCheck, stepGuards } from './fencing.js';
import { OwnershipRecorder, procAvailable, readRecords, reapPriorProcesses, statOf } from './ownership.js';
import { attemptFingerprints } from './wiring.js';
import { leaseWorktree, restoreTree, snapshotTree } from './worktree.js';

/**
 * S2 building blocks without a full run: process ownership records and the restart's reap (no harness
 * cleanup), worktree checkpoints and their proven restore, the lease-composed write guard for tools and
 * gates, and the progressCheck history source.
 */

const temps: string[] = [];
const spawned: number[] = [];
afterEach(() => {
  for (const p of spawned.splice(0)) {
    try {
      process.kill(-p, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (p = 'tecera-own-'): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  temps.push(d);
  return d;
};
const alive = (pid: number): boolean => {
  const st = statOf(pid);
  return !!st && st.state !== 'Z' && st.state !== 'X';
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args], { env: { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null' } }).toString('utf8');

describe.skipIf(!procAvailable())('process ownership and the restart reap (S2: orphan termination, no harness cleanup)', () => {
  it('a recorded detached child of a dead supervisor (its whole session/group) and anything working inside the worktree are killed and proven gone; unrelated processes and our ancestors are not touched', async () => {
    const wtRoot = tmp('tecera-own-wts-');
    const wt = join(wtRoot, 'r_x');
    mkdirSync(wt);
    const owner = join(wtRoot, 'r_x.owner');
    // a "previous supervisor": a detached node that spawns a detached grandchild (its own session) and a
    // plain child, then records them the way OwnershipRecorder does, and keeps running (it never cleans up)
    const sup = spawn(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const stat = (p) => { const s = fs.readFileSync('/proc/' + p + '/stat', 'utf8'); const f = s.slice(s.lastIndexOf(')') + 2).split(' '); return { pgid: +f[2], sid: +f[3], start: +f[19] }; };
      const det = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
      const grand = spawn('sh', ['-c', 'sleep 300 & sleep 300'], { detached: true, stdio: 'ignore' });
      setTimeout(() => {
        const rec = (role, pid) => JSON.stringify({ role, pid, ...stat(pid), by: process.pid, at: Date.now() });
        fs.appendFileSync(${JSON.stringify(owner)}, [rec('supervisor', process.pid), rec('descendant', det.pid), rec('descendant', grand.pid)].join('\\n') + '\\n');
        fs.writeFileSync(${JSON.stringify(join(wtRoot, 'ready'))}, 'x');
      }, 100);
      setInterval(() => {}, 1000);
    `], { detached: true, stdio: 'ignore' });
    spawned.push(sup.pid!);
    // a process working inside the worktree that nobody recorded (escaped the records)
    const inTree = spawn('sleep', ['300'], { cwd: wt, detached: true, stdio: 'ignore' });
    spawned.push(inTree.pid!);
    // an unrelated process elsewhere: must survive
    const bystander = spawn('sleep', ['300'], { cwd: tmp(), detached: true, stdio: 'ignore' });
    spawned.push(bystander.pid!);
    for (let i = 0; i < 100 && !existsSync(join(wtRoot, 'ready')); i++) await sleep(50);
    const recs = readRecords(owner);
    expect(recs.map((r) => r.role)).toEqual(['supervisor', 'descendant', 'descendant']);
    const grandSession = recs[2]!.sid;
    const sessionMembers = () => {
      const out: number[] = [];
      for (const d of execFileSync('ls', ['/proc']).toString().split('\n')) if (/^\d+$/.test(d) && statOf(Number(d))?.sid === grandSession && alive(Number(d))) out.push(Number(d));
      return out;
    };
    expect(sessionMembers().length).toBeGreaterThanOrEqual(2); // sh + both sleeps
    // a stale record whose pid was reused (start time differs) is never a target
    appendFileSync(owner, JSON.stringify({ role: 'descendant', pid: bystander.pid, start: 1, pgid: bystander.pid, sid: bystander.pid, by: 999999, at: 0 }) + '\n');

    const r = await reapPriorProcesses({ ownerFile: owner, worktree: wt });
    expect(r.refused).toBeUndefined();
    expect(r.survivors).toEqual([]);
    const killed = r.killed.map((k) => k.pid);
    for (const rec of recs) expect(killed).toContain(rec.pid);
    expect(killed).toContain(inTree.pid);
    expect(killed).not.toContain(bystander.pid);
    expect(killed).not.toContain(process.pid);
    await sleep(100);
    for (const rec of recs) expect(alive(rec.pid), `recorded ${rec.role} ${rec.pid}`).toBe(false);
    expect(sessionMembers(), 'every member of the detached session').toEqual([]);
    expect(alive(inTree.pid!)).toBe(false);
    expect(alive(bystander.pid!)).toBe(true);
    expect(alive(process.pid)).toBe(true);
  }, 60_000);

  it.skipIf(!existsSync('/usr/bin/script'))('an unrecorded process working in the worktree FROM A TERMINAL (an operator\'s shell or job) is never killed: it is reported and the restart must refuse', async () => {
    const wtRoot = tmp('tecera-own-wts-');
    const wt = join(wtRoot, 'r_t');
    mkdirSync(wt);
    // `script` gives the inner sleep a pseudo-terminal as its controlling tty
    // (the terminal itself lives elsewhere, as an operator's terminal emulator would)
    const term = spawn('script', ['-qfc', `cd ${JSON.stringify(wt)} && exec sleep 300`, '/dev/null'], { cwd: tmp(), detached: true, stdio: 'ignore' });
    spawned.push(term.pid!);
    let inner: number | null = null;
    for (let i = 0; i < 100 && inner === null; i++) {
      await sleep(50);
      for (const d of execFileSync('ls', ['/proc']).toString().split('\n')) {
        const st = /^\d+$/.test(d) ? statOf(Number(d)) : null;
        if (st && st.ppid === term.pid && st.tty !== 0) inner = st.pid;
      }
    }
    expect(inner, 'a terminal-attached process in the worktree').not.toBeNull();
    const r = await reapPriorProcesses({ ownerFile: join(wtRoot, 'r_t.owner'), worktree: wt, deadlineMs: 500 });
    expect(r.killed.map((k) => k.pid)).not.toContain(inner);
    expect(r.survivors).toContain(inner);
    expect(r.notes?.join(' ')).toMatch(/from a terminal/);
    expect(alive(inner!)).toBe(true);
  }, 30_000);

  it('the recorder writes this supervisor and its descendants (pid + start time) to the owner file; a record written by THIS process is never reaped by it', async () => {
    const dir = tmp();
    const owner = join(dir, 'r.owner');
    const rec = new OwnershipRecorder(owner);
    rec.start(50);
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    spawned.push(child.pid!);
    await sleep(250);
    rec.stop();
    const recs = readRecords(owner);
    expect(recs[0]).toMatchObject({ role: 'supervisor', pid: process.pid, start: statOf(process.pid)!.start });
    expect(recs.find((r) => r.pid === child.pid)).toMatchObject({ role: 'descendant', by: process.pid, start: statOf(child.pid!)!.start });
    const r = await reapPriorProcesses({ ownerFile: owner, worktree: join(dir, 'no-such-worktree') });
    expect(r.killed).toEqual([]);
    expect(alive(child.pid!)).toBe(true);
  }, 30_000);
});

describe('worktree checkpoints (S2: discard uncheckpointed writes)', () => {
  it('snapshot is a tree of tracked + untracked (not ignored) files; restore makes the worktree equal to it (edits reverted, new files removed, deleted files back, ignored files kept), proven by re-snapshot; base restores the base tree; a bad id refuses', async () => {
    const root = tmp();
    writeFileSync(join(root, 'a.txt'), 'a0\n');
    writeFileSync(join(root, 'b.txt'), 'b0\n');
    writeFileSync(join(root, '.gitignore'), 'ignored/\n');
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    const ledger = new MemoryLedger();
    const wt = await leaseWorktree({ root, runId: 'r_cp', base: 'main', ledger, worktreesRoot: tmp('tecera-own-wts-'), resume: false, ttlMs: 60_000, holder: 'h' });
    try {
      const p = (n: string) => join(wt.path, n);
      writeFileSync(p('a.txt'), 'a1\n');
      writeFileSync(p('new.txt'), 'n1\n');
      const cp = await wt.checkpoint();
      expect(cp).toMatch(/^tree:[0-9a-f]{40,64}$/);
      // uncheckpointed writes after the checkpoint
      writeFileSync(p('a.txt'), 'a2 (uncheckpointed)\n');
      rmSync(p('b.txt'));
      writeFileSync(p('later.txt'), 'x\n');
      mkdirSync(p('ignored'));
      writeFileSync(p('ignored/cache'), 'c\n');
      expect(await restoreTree(wt.path, wt.baseSha, cp)).toBe(cp);
      expect(readFileSync(p('a.txt'), 'utf8')).toBe('a1\n');
      expect(readFileSync(p('b.txt'), 'utf8')).toBe('b0\n');
      expect(readFileSync(p('new.txt'), 'utf8')).toBe('n1\n');
      expect(existsSync(p('later.txt'))).toBe(false);
      expect(existsSync(p('ignored/cache'))).toBe(true);
      expect(await snapshotTree(wt.path)).toBe(cp);
      // the index is back at HEAD: nothing staged
      expect(git(wt.path, 'diff', '--cached', '--name-only').trim()).toBe('');
      // base
      await wt.restore('base');
      expect(readFileSync(p('a.txt'), 'utf8')).toBe('a0\n');
      expect(existsSync(p('new.txt'))).toBe(false);
      expect(git(wt.path, 'status', '--porcelain').trim()).toBe('');
      await expect(wt.restore('tree:nothex')).rejects.toThrow(/not a worktree checkpoint/);
      await expect(wt.restore('HEAD')).rejects.toThrow(/not a worktree checkpoint/);
      const blob = git(wt.path, 'rev-parse', 'HEAD:a.txt').trim();
      await expect(wt.restore(`tree:${blob}`)).rejects.toThrow(/not a tree/);
    } finally {
      await wt.release();
    }
  }, 60_000);
});

describe('the lease-composed write guard (tools and gates)', () => {
  const lease = () => {
    const ctl = new AbortController();
    let reason: string | null = null;
    return { ctl, set: (r: string | null) => (reason = r), lease: { lost: ctl.signal, assertHeld: async () => 1, heldReason: () => reason } };
  };

  it("check() fails once the lease lapses or is lost, whatever the step guard says; the step guard's own refusal stands; authorizeWrite is the step's; no step guard → no write authority", () => {
    const l = lease();
    const step = new FencedWriteGuard({ live: () => null, signal: new AbortController().signal, authorizeWrite: () => ({ kind: 'needs-approval', actionHash: 'h' }) });
    const g = leaseGuard(l.lease, step);
    expect(() => g.check()).not.toThrow();
    expect(g.authorizeWrite({ path: 'src/a.js', contentDigest: 'd' })).toEqual({ kind: 'needs-approval', actionHash: 'h' });
    l.set('no successful renewal within the lease validity');
    expect(() => g.check()).toThrow(/lease validity/);
    l.set(null);
    l.ctl.abort(new Error('worktree lease lost: taken'));
    expect(() => g.check()).toThrow(/taken/);
    expect(g.signal.aborted).toBe(true);
    const l2 = lease();
    expect(() => leaseGuard(l2.lease, new FencedWriteGuard({ live: () => 'step edit is done, not running', signal: new AbortController().signal })).check()).toThrow(/not running/);
    const none = leaseGuard(l2.lease, undefined);
    expect(() => none.check()).toThrow(/no write guard/);
  });

  it('mutationCheck (the edit tool pre-commit seam) refuses without a bound step guard and once the lease is gone', () => {
    const l = lease();
    const check = mutationCheck(l.lease);
    expect(() => check()).toThrow(/no write guard is bound/);
    const g = leaseGuard(l.lease, new FencedWriteGuard({ live: () => null, signal: new AbortController().signal }));
    stepGuards.run({ guard: g }, () => expect(() => check()).not.toThrow());
    l.set('lapsed');
    stepGuards.run({ guard: g }, () => expect(() => check()).toThrow(/lapsed/));
  });

  it('gates: the loop guard is composed with the lease (commit git mutations stop on loss); a reconcile called without a guard still gets a lease-bound one', () => {
    const l = lease();
    const base = { runId: 'r', worktree: '/w', signal: new AbortController().signal } as unknown as GateContext;
    const withLoop = leasedGateContext({ ...base, guard: new FencedWriteGuard({ live: () => null, signal: new AbortController().signal }) }, l.lease);
    const reconcile = leasedGateContext(base, l.lease);
    expect(() => withLoop.guard!.check()).not.toThrow();
    expect(() => reconcile.guard!.check()).not.toThrow();
    l.ctl.abort(new Error('worktree lease lost: renewal refused'));
    expect(() => withLoop.guard!.check()).toThrow(/renewal refused/);
    expect(() => reconcile.guard!.check()).toThrow(/renewal refused/);
    expect(withLoop.signal!.aborted).toBe(true);
  });
});

describe('progressCheck wiring', () => {
  it("the worker's progressHistory comes from the loop's verify events of the step's intention: attempt, fingerprint and worker execution", async () => {
    const l = new MemoryLedger();
    const { event } = await import('@tecera/contracts');
    let n = 0;
    const v = (kind: 'verify.passed' | 'verify.failed', iid: string, payload: Record<string, unknown>) =>
      l.append(event(kind, { id: `e${++n}`, at: n, actor: { kind: 'system', id: 't' }, runId: 'r', trace: { goalId: 'g', planId: 'p', intentionId: iid, stepId: 'verify' }, payload: payload as never }));
    await v('verify.failed', 'i', { attempt: 1, fingerprint: 'f1', workerExec: 2 });
    await v('verify.failed', 'other', { attempt: 1, fingerprint: 'zz', workerExec: 9 });
    await v('verify.failed', 'i', { attempt: 2, fingerprint: 'f1', workerExec: 3 });
    const { fps, history } = await attemptFingerprints(l, 'r', 'i');
    expect(history).toEqual([
      { attempt: 1, fingerprint: 'f1', exec: 2 },
      { attempt: 2, fingerprint: 'f1', exec: 3 },
    ]);
    expect(fps.get(2)).toBe('f1');
    const { noProgressReason } = await import('@tecera/contracts');
    expect(noProgressReason(history)).toMatch(/no progress/);
  });
});
