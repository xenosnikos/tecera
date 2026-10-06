import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeRedactor } from '@tecera/contracts';
import {
  admitVerifyProfile,
  detectContainment,
  detectIsolation,
  IsolationUnavailable,
  probeCgroupMigration,
  ProcessVerifyRunner,
  VERIFY_CANCEL_EXIT,
  VERIFY_OUTPUT_CAP,
  VERIFY_SPAWN_EXIT,
  VERIFY_TIMEOUT_EXIT,
  type ContainmentProbe,
  type VerifyEvidence,
} from './index.js';

/**
 * Codex sprint-3 sandbox findings 2-6 and next steps 6/7 on the verify runner:
 *  - a leader that survives SIGKILL (no 'exit' ever) settles as a tainted terminal failure, never pending;
 *  - cancellation during degraded-evidence recording is honoured (the command never starts);
 *  - output interrupted by the kill (cap, timeout) between encoded-secret chunks leaves no fragment;
 *  - concurrent runs under one uid never kill each other's descendants; unrelated processes of the uid
 *    are never killed (the run refuses beside them);
 *  - a differently owned but group-writable cgroup is tested for writability, not inferred from the owner;
 *  - admitVerifyProfile is the one admission rule set the runner applies.
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const probe = detectContainment();
const iso = detectIsolation();
const isRoot = typeof process.geteuid === 'function' && process.geteuid() === 0;
const strong = Boolean(probe.cgroupBase || probe.pidns);
/** Its own verify uid: verifyRunner.test.ts (65533) runs in a parallel worker, and a shared uid is refused as not exclusive. */
const VUID = 65532;
const runAs = { uid: VUID, gid: VUID };
const canDrop = isRoot && Boolean(probe.setpriv) && strong;
const netns = Boolean(iso.netns);
/** Identity that a test runner can always construct on this host (degraded where needed). */
const anyIdent = isRoot ? { allowRoot: true } : {};
const weak: ContainmentProbe = { cgroupBase: null, pidns: null, cgroupns: null, setpriv: probe.setpriv ?? null };
const TAG = `lc${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const windows = (s: string, n: number): string[] => Array.from({ length: Math.max(0, s.length - n + 1) }, (_, i) => s.slice(i, i + n));

async function openDir(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  chmodSync(d, 0o777);
  return d;
}

/** A fake leader: never emits 'exit' or 'close', whatever is done to it. */
function stuckLeader(pid: number): { spawn: typeof spawn; calls: () => number } {
  let calls = 0;
  const fake = ((..._args: unknown[]) => {
    calls++;
    const c = new EventEmitter() as unknown as ChildProcess & { pid: number };
    Object.assign(c, { pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, unref: () => undefined });
    return c;
  }) as unknown as typeof spawn;
  return { spawn: fake, calls: () => calls };
}

/** A pid that is very unlikely to exist (top of the pid range). */
function unusedPid(): number {
  for (let p = 4_194_000; p > 4_000_000; p--) if (!existsSync(`/proc/${p}`)) return p;
  return 4_194_001;
}

describe('a verify leader that survives SIGKILL never leaves run() pending (sprint-3 finding 3)', () => {
  it('no exit event + reap reports survivors: settles within the bound as terminal failure with taint', async () => {
    const cwd = await openDir('tecera-vl-stuck-');
    try {
      const pid = unusedPid();
      const leader = stuckLeader(pid);
      const ev: VerifyEvidence[] = [];
      const runner = new ProcessVerifyRunner({
        ...anyIdent,
        containment: weak,
        allowWeakContainment: true,
        drainMs: 200,
        reapMs: 200,
        onEvidence: (e) => void ev.push(e),
        testSpawn: leader.spawn,
        testReapOverride: (k) => ({ ...k, gone: false, survivors: [pid] }),
      });
      const t0 = Date.now();
      const r = await runner.run({ cwd, command: 'exit 0', timeoutSec: 0.3, envAllowlist: ['PATH'] });
      expect(Date.now() - t0).toBeLessThan(3_000);
      expect(leader.calls()).toBe(1);
      expect(r.exitCode).toBeNull();
      expect(r.cancelled).toBe(true);
      expect(r.gone).toBe(false);
      expect(r.reason).toMatch(/leader did not exit after SIGKILL/);
      expect(r.tainted?.processes).toContain(pid);
      expect(ev.map((e) => e.kind)).toContain('verify.tainted');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('no exit event even though the reap found nothing: still settles, still fail closed (never a pass)', async () => {
    const cwd = await openDir('tecera-vl-stuck2-');
    try {
      const pid = unusedPid();
      const runner = new ProcessVerifyRunner({ ...anyIdent, containment: weak, allowWeakContainment: true, drainMs: 150, reapMs: 150, testSpawn: stuckLeader(pid).spawn });
      const r = await runner.run({ cwd, command: 'exit 0', timeoutSec: 0.2, envAllowlist: ['PATH'] });
      expect(r.exitCode).toBeNull();
      expect(r.gone).toBe(false);
      expect(r.tainted?.reason).toMatch(/leader did not exit/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('a cancel with a stuck leader also settles (bounded) and is never a pass', async () => {
    const cwd = await openDir('tecera-vl-stuck3-');
    try {
      const ac = new AbortController();
      const runner = new ProcessVerifyRunner({ ...anyIdent, containment: weak, allowWeakContainment: true, drainMs: 150, reapMs: 150, testSpawn: stuckLeader(unusedPid()).spawn });
      setTimeout(() => ac.abort(), 100);
      const r = await runner.run({ cwd, command: 'exit 0', timeoutSec: 30, envAllowlist: ['PATH'] }, ac.signal);
      expect(r.exitCode).toBeNull();
      expect(r.tainted).toBeDefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('cancellation during degraded-evidence recording is honoured (sprint-3 finding 4)', () => {
  it('mocked: abort while the sink is pending -> 130 cancelled, spawn never called, even after the sink completes', async () => {
    const cwd = await openDir('tecera-vl-cancel-');
    try {
      const leader = stuckLeader(unusedPid());
      let release!: () => void;
      let sinkCalls = 0;
      const ac = new AbortController();
      const runner = new ProcessVerifyRunner({
        ...anyIdent,
        containment: weak,
        allowWeakContainment: true,
        testSpawn: leader.spawn,
        onEvidence: () => {
          sinkCalls++;
          setTimeout(() => ac.abort(), 20);
          return new Promise<void>((r) => (release = r));
        },
      });
      expect(runner.degraded).toBeDefined();
      const p = runner.run({ cwd, command: 'exit 0', timeoutSec: 5, envAllowlist: ['PATH'] }, ac.signal);
      const r = await p;
      release(); // the recording completes later; the outcome stays cancelled
      await sleep(50);
      expect(sinkCalls).toBe(1);
      expect(leader.calls()).toBe(0);
      expect(r).toMatchObject({ exitCode: VERIFY_CANCEL_EXIT, cancelled: true });
      expect(r.reason).toMatch(/cancelled while recording degraded evidence/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('mocked: an abort that lands while the sink settles successfully still wins (re-check after the await)', async () => {
    const cwd = await openDir('tecera-vl-cancel2-');
    try {
      const leader = stuckLeader(unusedPid());
      const ac = new AbortController();
      const runner = new ProcessVerifyRunner({
        ...anyIdent,
        containment: weak,
        allowWeakContainment: true,
        testSpawn: leader.spawn,
        onEvidence: async () => {
          ac.abort(); // abort happens inside the sink, which then resolves normally
        },
      });
      const r = await runner.run({ cwd, command: 'exit 0', timeoutSec: 5, envAllowlist: ['PATH'] }, ac.signal);
      expect(leader.calls()).toBe(0);
      expect(r.exitCode).toBe(VERIFY_CANCEL_EXIT);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('mocked: an abort between spawn and gate release never opens the gate', async () => {
    const cwd = await openDir('tecera-vl-cancel3-');
    try {
      const ac = new AbortController();
      let gateWrites = '';
      const fake = ((..._a: unknown[]) => {
        const c = new EventEmitter() as unknown as ChildProcess;
        const stdin = new PassThrough();
        stdin.on('data', (b: Buffer) => (gateWrites += b.toString()));
        Object.assign(c, { pid: unusedPid(), stdin, stdout: new PassThrough(), stderr: new PassThrough(), unref: () => undefined });
        ac.abort(); // the cancel arrives right after the spawn
        return c;
      }) as unknown as typeof spawn;
      const runner = new ProcessVerifyRunner({ ...anyIdent, containment: weak, allowWeakContainment: true, drainMs: 100, reapMs: 100, testSpawn: fake });
      const r = await runner.run({ cwd, command: 'exit 0', timeoutSec: 5, envAllowlist: ['PATH'] }, ac.signal);
      await sleep(20);
      expect(gateWrites).toBe('');
      expect(r.exitCode === VERIFY_CANCEL_EXIT || r.exitCode === null).toBe(true);
      expect(r.cancelled).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('a sink that never settles refuses the degraded run (bounded), the command never runs', async () => {
    const cwd = await openDir('tecera-vl-cancel4-');
    try {
      const leader = stuckLeader(unusedPid());
      const runner = new ProcessVerifyRunner({ ...anyIdent, containment: weak, allowWeakContainment: true, evidenceTimeoutMs: 150, testSpawn: leader.spawn, onEvidence: () => new Promise<void>(() => undefined) });
      const r = await runner.run({ cwd, command: 'exit 0', timeoutSec: 5, envAllowlist: ['PATH'] });
      expect(r.exitCode).toBe(VERIFY_SPAWN_EXIT);
      expect(r.reason).toMatch(/degraded verify refused: evidence sink did not settle/);
      expect(leader.calls()).toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it.skipIf(!isRoot || !probe.setpriv)('real process: abort during a slow sink; the command never writes its marker', async () => {
    const cwd = await openDir('tecera-vl-cancel5-');
    try {
      const ac = new AbortController();
      const runner = new ProcessVerifyRunner({
        allowRoot: true,
        containment: weak,
        allowWeakContainment: true,
        onEvidence: async () => {
          setTimeout(() => ac.abort(), 30);
          await sleep(300);
        },
      });
      const r = await runner.run({ cwd, command: 'echo ran > ran.txt', timeoutSec: 5, envAllowlist: ['PATH'] }, ac.signal);
      await sleep(300);
      expect(r.exitCode).toBe(VERIFY_CANCEL_EXIT);
      expect(existsSync(join(cwd, 'ran.txt'))).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!canDrop)('output interrupted by the kill between encoded-secret chunks (sprint-3 finding 2, real streams)', () => {
  const SECRET = 'cutoff-REGISTERED-secret-0123456789abcdef';
  const encs = [SECRET, Buffer.from(SECRET).toString('base64'), Buffer.from(SECRET).toString('hex'), [...Buffer.from(SECRET)].map((b) => '%' + b.toString(16).padStart(2, '0')).join('')];
  const redactor = makeRedactor([SECRET]);
  let cwd: string;
  beforeAll(async () => {
    cwd = await openDir('tecera-vl-int-');
  });
  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });
  const leaksIn = (out: string): string[] => encs.flatMap((e) => windows(e, 8)).filter((w) => out.includes(w));

  it('output cap: 980 ordinary + 30 encoded chars, the rest would come later but the kill stops it (stdout and stderr)', async () => {
    for (const [i, enc] of encs.entries()) {
      writeFileSync(join(cwd, `part1-${i}.txt`), 'a'.repeat(980) + enc.slice(0, 30));
      writeFileSync(join(cwd, `part2-${i}.txt`), enc.slice(30) + '\n');
      chmodSync(join(cwd, `part1-${i}.txt`), 0o644);
      chmodSync(join(cwd, `part2-${i}.txt`), 0o644);
      for (const fd of ['', ' >&2']) {
        const r = await new ProcessVerifyRunner({ runAs, netns, redactor, maxOutputBytes: 1000 }).run({ cwd, command: `cat part1-${i}.txt${fd}; sleep 2; cat part2-${i}.txt${fd}`, timeoutSec: 10, envAllowlist: ['PATH'] });
        expect(r.reason).toBe(VERIFY_OUTPUT_CAP);
        expect(leaksIn(r.stdout), `stdout enc ${i}${fd}`).toEqual([]);
        expect(leaksIn(r.stderr), `stderr enc ${i}${fd}`).toEqual([]);
      }
    }
  }, 60_000);

  it('timeout: a partial encoded secret printed just before the kill (under the cap) is suppressed; earlier lines survive', async () => {
    for (const [i, enc] of encs.entries()) {
      writeFileSync(join(cwd, `t-${i}.txt`), `ok line\nkey ${enc.slice(0, 24)}`);
      chmodSync(join(cwd, `t-${i}.txt`), 0o644);
      const r = await new ProcessVerifyRunner({ runAs, netns, redactor }).run({ cwd, command: `cat t-${i}.txt; sleep 30`, timeoutSec: 0.5, envAllowlist: ['PATH'] });
      expect(r.exitCode).toBe(VERIFY_TIMEOUT_EXIT);
      expect(leaksIn(r.stdout), `enc ${i}`).toEqual([]);
      expect(r.stdout.startsWith('ok line\nkey ')).toBe(true);
    }
  }, 30_000);

  it('a normal exit is not interrupted: complete output passes untouched', async () => {
    const r = await new ProcessVerifyRunner({ runAs, netns, redactor }).run({ cwd, command: 'printf "all good token123"', timeoutSec: 5, envAllowlist: ['PATH'] });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('all good token123');
  });
});

describe.skipIf(!canDrop)('concurrent verification under the same uid (sprint-3 finding 5)', () => {
  let cwd: string;
  beforeAll(async () => {
    cwd = await openDir('tecera-vl-conc-');
  });
  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const layers: Array<[string, ContainmentProbe, boolean]> = [['host containment', probe, false]];
  layers.push(['session + uid only', weak, true]);
  if (probe.cgroupBase && probe.pidns) layers.push(['cgroup only', { ...probe, pidns: null, cgroupns: null }, false]);

  for (const [name, containment, allowWeak] of layers) {
    it(`${name}: run A finishing never claims or kills run B's live descendants`, async () => {
      const tag = name.replace(/\W/g, '');
      const mk = () => new ProcessVerifyRunner({ runAs, netns, containment, allowWeakContainment: allowWeak, cgroupTag: TAG });
      // B forks a child after A started and keeps it running past A's reap; the child writes B's marker.
      const pb = mk().run({ cwd, command: `sleep 0.2; sh -c 'sleep 1.2; echo ok > b-${tag}.txt'; exit 0`, timeoutSec: 10, envAllowlist: ['PATH'] });
      await sleep(400); // B's child exists now; A opens and finishes while it runs
      const ra = await mk().run({ cwd, command: 'sleep 0.2; exit 0', timeoutSec: 10, envAllowlist: ['PATH'] });
      const rb = await pb;
      expect(ra.reason).toBeUndefined();
      expect(ra).toMatchObject({ exitCode: 0, escaped: 0, gone: true });
      expect(rb.reason).toBeUndefined();
      expect(rb).toMatchObject({ exitCode: 0, escaped: 0, gone: true });
      expect(existsSync(join(cwd, `b-${tag}.txt`))).toBe(true);
    }, 30_000);
  }

  it('a real escapee of B is still caught by B (scoping does not blind the scan)', async () => {
    const runner = new ProcessVerifyRunner({ runAs, netns, containment: weak, allowWeakContainment: true, cgroupTag: TAG });
    const other = new ProcessVerifyRunner({ runAs, netns, cgroupTag: TAG });
    const pa = other.run({ cwd, command: 'sleep 1', timeoutSec: 10, envAllowlist: ['PATH'] });
    const e = await runner.run({ cwd, command: "setsid sh -c 'sleep 0.6; echo late > conc-escaped.txt' </dev/null >/dev/null 2>&1 & sleep 0.2; exit 0", timeoutSec: 5, envAllowlist: ['PATH'] });
    const a = await pa;
    expect(e.exitCode).toBeNull();
    expect(e.reason).toMatch(/escaped containment/);
    expect(a).toMatchObject({ exitCode: 0, escaped: 0 });
    await sleep(800);
    expect(existsSync(join(cwd, 'conc-escaped.txt'))).toBe(false);
  }, 20_000);

  it('an unrelated, pre-existing process of the verify uid is never killed; the run refuses beside it', async () => {
    const bystander = spawn(probe.setpriv!, [`--reuid=${VUID}`, `--regid=${VUID}`, '--clear-groups', '--', '/bin/sleep', '30'], { detached: true, stdio: 'ignore' });
    try {
      await sleep(200);
      expect(existsSync(`/proc/${bystander.pid}`)).toBe(true);
      for (const containment of [probe, weak]) {
        const r = await new ProcessVerifyRunner({ runAs, netns, containment, allowWeakContainment: true, cgroupTag: TAG }).run({ cwd, command: 'echo ran > bystander-ran.txt', timeoutSec: 5, envAllowlist: ['PATH'] });
        expect(r.exitCode).toBeNull();
        expect(r.reason).toMatch(/not exclusive/);
        expect(existsSync(join(cwd, 'bystander-ran.txt'))).toBe(false);
      }
      await sleep(100);
      expect(bystander.exitCode).toBeNull();
      expect(bystander.signalCode).toBeNull();
    } finally {
      bystander.kill('SIGKILL');
    }
  }, 20_000);
});

describe.skipIf(!canDrop || !probe.cgroupBase)('different owner, group-writable cgroup: writability is tested, not inferred (sprint-3 finding 6)', () => {
  let cwd: string;
  let gw: string;
  const nonce = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const setMode = (dirMode: number, procsMode: number) => {
    chmodSync(gw, dirMode);
    chmodSync(join(gw, 'cgroup.procs'), procsMode);
  };
  /**
   * The control, by an independent shell: can the verify identity, starting INSIDE a cgroup below gw (like
   * the command inside its run cgroup), really move itself out into gw?
   */
  const realMigration = (): boolean => {
    const ctl = join(gw, `ctl-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(ctl);
    try {
      const r = spawnSync('/bin/sh', ['-c', `echo $$ > ${ctl}/cgroup.procs && exec ${probe.setpriv} --reuid=${VUID} --regid=${VUID} --clear-groups -- /bin/sh -c 'echo $$ > ${gw}/cgroup.procs && grep -qx "0::${gw.replace('/sys/fs/cgroup', '')}" /proc/$$/cgroup'`], { cwd: '/', stdio: 'ignore' });
      return r.status === 0;
    } finally {
      for (let i = 0; i < 20; i++) {
        try {
          rmdirSync(ctl);
          break;
        } catch {
          /* populated for a moment */
        }
      }
    }
  };

  beforeAll(async () => {
    cwd = await openDir('tecera-vl-gw-');
    gw = join(probe.cgroupBase!, `tecera-test-gw-${nonce}`);
    mkdirSync(gw);
    // Owned by root (NOT the verify uid), group = the verify gid.
    for (const f of ['', 'cgroup.procs', 'cgroup.threads', 'cgroup.subtree_control']) chownSync(join(gw, f), 0, VUID);
  });
  afterAll(async () => {
    for (let i = 0; i < 20; i++) {
      try {
        rmdirSync(gw);
        break;
      } catch {
        await sleep(50);
      }
    }
    await rm(cwd, { recursive: true, force: true });
  });

  it('group-writable (0664 procs, 0775 dir): the probe finds it migratable, the real attack works, the cgroup does not own', async () => {
    setMode(0o775, 0o664);
    const m = probeCgroupMigration(gw, { uid: VUID, gid: VUID, setpriv: probe.setpriv! });
    expect(m.migratable).toBe(true);
    expect(m.writable).toContain(join(gw, 'cgroup.procs'));
    expect(realMigration()).toBe(true);
    const containment: ContainmentProbe = { ...probe, cgroupBase: gw, pidns: null, cgroupns: null };
    expect(() => new ProcessVerifyRunner({ runAs, netns, containment })).toThrow(/cannot own/);
    const a = admitVerifyProfile({ runAs, netns }, { containment });
    expect(a.admitted).toBe(false);
    if (probe.pidns) {
      const r = new ProcessVerifyRunner({ runAs, netns, containment: { ...containment, pidns: probe.pidns } });
      expect(r.owning).toEqual(['pidns']);
      expect(r.degraded?.missing).toContain('cgroup');
    }
  });

  it('only owner-writable (0644 procs, 0755 dir), same owner/group: the probe finds it not migratable, the attack fails, the cgroup owns', async () => {
    setMode(0o755, 0o644);
    const m = probeCgroupMigration(gw, { uid: VUID, gid: VUID, setpriv: probe.setpriv! });
    expect(m.migratable).toBe(false);
    expect(m.writable).toEqual([]);
    expect(m.subgroup).toBe(false);
    expect(realMigration()).toBe(false);
    const containment: ContainmentProbe = { ...probe, cgroupBase: gw, pidns: null, cgroupns: null };
    const r = new ProcessVerifyRunner({ runAs, netns, containment, cgroupTag: TAG });
    expect(r.owning).toEqual(['cgroup']);
    const out = await r.run({ cwd, command: `sh -c 'echo $$ > ${gw}/cgroup.procs 2>/dev/null; exec setsid sh -c "sleep 0.6; echo late > gw-migrated.txt"' </dev/null >/dev/null 2>&1 & sleep 0.2; exit 0`, timeoutSec: 5, envAllowlist: ['PATH'] });
    if (out.exitCode === 0) expect(out.gone && out.escaped === 0).toBe(true);
    await sleep(800);
    expect(existsSync(join(cwd, 'gw-migrated.txt'))).toBe(false);
  }, 15_000);

  it('a writable directory alone (subgroup creatable, procs not writable) is treated as delegated: not owning', () => {
    setMode(0o775, 0o644);
    const m = probeCgroupMigration(gw, { uid: VUID, gid: VUID, setpriv: probe.setpriv! });
    expect(m.subgroup).toBe(true);
    expect(m.migratable).toBe(true);
    expect(readdirSync(gw).filter((d) => d.startsWith('tecera-wprobe-'))).toEqual([]); // the probe cleaned up
  });
});

describe('admitVerifyProfile: the one admission rule set (next step 7)', () => {
  const full: ContainmentProbe = { cgroupBase: '/sys/fs/cgroup/x', pidns: ['/usr/bin/unshare', '-pf', '--kill-child'], cgroupns: ['/usr/bin/unshare', '-C'], nsdelegate: true, setpriv: '/usr/bin/setpriv' };
  const netnsIso = { netns: ['/usr/bin/unshare', '-n'] } as unknown as ReturnType<typeof detectIsolation>;

  it('refusals are values, never throws', () => {
    expect(admitVerifyProfile({}, { euid: 0, containment: full, cgroupOwnerUid: 0 })).toMatchObject({ admitted: false, reason: expect.stringMatching(/would run as root/) });
    expect(admitVerifyProfile({ runAs: { uid: 0, gid: 0 } }, { euid: 0, containment: full })).toMatchObject({ admitted: false, reason: expect.stringMatching(/non-root uid/) });
    expect(admitVerifyProfile({ runAs }, { euid: 1000, containment: full })).toMatchObject({ admitted: false, reason: expect.stringMatching(/root supervisor/) });
    expect(admitVerifyProfile({ runAs, netns: true }, { euid: 0, containment: full, isolation: { netns: null } as unknown as ReturnType<typeof detectIsolation> })).toMatchObject({ admitted: false, reason: expect.stringMatching(/netns/) });
    expect(admitVerifyProfile({ runAs: { uid: Number.NaN, gid: 1 } }, { euid: 0, containment: full }).admitted).toBe(false);
  });

  it('no owning layer is refused unless allowWeakContainment; then admitted degraded', () => {
    const none: ContainmentProbe = { ...full, cgroupns: null, pidns: null };
    expect(admitVerifyProfile({ runAs }, { euid: 0, containment: none, cgroupOwnerUid: 0, cgroupMigratable: true })).toMatchObject({ admitted: false, reason: expect.stringMatching(/cannot own/) });
    const a = admitVerifyProfile({ runAs, allowWeakContainment: true }, { euid: 0, containment: none, cgroupOwnerUid: 0, cgroupMigratable: true });
    expect(a.admitted).toBe(true);
    if (a.admitted) {
      expect(a.owning).toEqual([]);
      expect(a.degraded?.missing).toEqual(expect.arrayContaining(['cgroup', 'pidns', 'netns']));
    }
  });

  it('a fully contained profile is admitted with every control and no degradation', () => {
    const a = admitVerifyProfile({ runAs, netns: true }, { euid: 0, containment: full, isolation: netnsIso, cgroupOwnerUid: 0, cgroupMigratable: false });
    expect(a).toMatchObject({ admitted: true, identity: 'dropped', owning: ['cgroup', 'pidns'], missing: [] });
    if (a.admitted) expect(a.degraded).toBeUndefined();
  });

  it('the runner applies exactly this: it constructs iff admission admits (matrix on this host)', () => {
    const profiles = [{}, { allowRoot: true }, { runAs }, { runAs, netns: true }, { allowRoot: true, allowWeakContainment: true }, { runAs, allowWeakContainment: true }];
    const hosts: ContainmentProbe[] = [probe, weak, { ...probe, pidns: null }, { ...probe, cgroupBase: null }];
    for (const p of profiles) {
      for (const h of hosts) {
        const a = admitVerifyProfile(p, { containment: h });
        let built = true;
        let msg = '';
        try {
          new ProcessVerifyRunner({ ...p, containment: h });
        } catch (e) {
          built = false;
          msg = (e as Error).message;
          expect(e).toBeInstanceOf(IsolationUnavailable);
        }
        expect(built, JSON.stringify({ p, h, msg })).toBe(a.admitted);
        if (!a.admitted) expect(msg).toBe(a.reason);
      }
    }
  });
});
