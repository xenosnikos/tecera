import { spawnSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeRedactor } from '@tecera/contracts';
import {
  detectContainment,
  detectIsolation,
  IsolationUnavailable,
  Jail,
  ProcessVerifyRunner,
  releaseWorktreeQuarantine,
  resolveVerifyPolicy,
  VERIFY_CANCEL_EXIT,
  worktreeQuarantine,
  VERIFY_OUTPUT_CAP,
  VERIFY_SPAWN_EXIT,
  VERIFY_TIMEOUT_EXIT,
  type ContainmentProbe,
  type VerifyEvidence,
} from './index.js';

/**
 * Verify containment (Codex sprint-2 sandbox finding 2 + wave-3 item 7): privilege model (root refused
 * unless explicitly allowed, unprivileged identity cannot leave its cgroup), escape detection (cgroup
 * migration, nested cgroups, same-uid delegation, namespace escape), output overflow kills the run and
 * never passes (ADV-1), failed cleanup never passes, unreadable containment state is never "empty", and
 * truthful degraded reporting.
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const probe = detectContainment();
const iso = detectIsolation();
const isRoot = typeof process.geteuid === 'function' && process.geteuid() === 0;
const strong = Boolean(probe.cgroupBase || probe.pidns);
/** Dedicated verify uid for these tests (the REPL tests use 65534). */
const VUID = 65533;
const runAs = { uid: VUID, gid: VUID };
const canDrop = isRoot && Boolean(probe.setpriv) && strong;
const netns = Boolean(iso.netns);
/** Per-file nonce in this file's cgroup names: assertions count only cgroups this file created (other lanes run concurrently). */
const TAG = `vr${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const windows = (s: string, n: number): string[] => Array.from({ length: Math.max(0, s.length - n + 1) }, (_, i) => s.slice(i, i + n));

async function openDir(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  chmodSync(d, 0o777);
  return d;
}

describe('resolveVerifyPolicy: identity, owning layers and missing controls (pure)', () => {
  const full: ContainmentProbe = { cgroupBase: '/sys/fs/cgroup/x', pidns: ['/usr/bin/unshare', '-pf', '--kill-child'], cgroupns: ['/usr/bin/unshare', '-C'], nsdelegate: true, setpriv: '/usr/bin/setpriv' };

  it('root without runAs is refused unless allowRoot; allowed root is degraded with uid missing', () => {
    expect(() => resolveVerifyPolicy(full, { netns: true, euid: 0, cgroupOwnerUid: 0 })).toThrow(/would run as root/);
    const p = resolveVerifyPolicy(full, { netns: true, euid: 0, cgroupOwnerUid: 0, allowRoot: true });
    expect(p.identity).toBe('root');
    expect(p.missing).toEqual(['uid']);
    expect(p.owning).toEqual(['cgroup', 'pidns']); // caps dropped + cgroupns under nsdelegate
    expect(p.idPrefix).toEqual(['/usr/bin/setpriv', '--no-new-privs', '--inh-caps=-all', '--bounding-set=-all', '--']);
  });

  it('root keeping its capabilities (no setpriv) owns nothing: cgroup and pid namespace are both leavable', () => {
    const p = resolveVerifyPolicy({ ...full, setpriv: null }, { netns: true, euid: 0, cgroupOwnerUid: 0, allowRoot: true });
    expect(p.owning).toEqual([]);
    expect(p.missing).toEqual(['uid', 'caps', 'cgroup', 'pidns']);
  });

  it('dropped identity owns the root-owned cgroup and the pid namespace; every control applies', () => {
    const p = resolveVerifyPolicy(full, { netns: true, euid: 0, cgroupOwnerUid: 0, cgroupMigratable: false, runAs });
    expect(p.identity).toBe('dropped');
    expect(p.owning).toEqual(['cgroup', 'pidns']);
    expect(p.missing).toEqual([]);
    expect(p.idPrefix).toEqual(['/usr/bin/setpriv', `--reuid=${VUID}`, `--regid=${VUID}`, '--clear-groups', '--no-new-privs', '--inh-caps=-all', '--bounding-set=-all', '--']);
  });

  it('different owner is not enough (sprint-3 finding 6): a migratable cgroup does not own; an unprobeable one fails closed', () => {
    const noNs = { ...full, cgroupns: null };
    // Owner root, but the probe established the command uid CAN migrate (group/ACL-writable): not owning.
    const w = resolveVerifyPolicy(noNs, { netns: true, euid: 0, cgroupOwnerUid: 0, cgroupMigratable: true, runAs });
    expect(w.owning).toEqual(['pidns']);
    expect(w.missing).toEqual(['cgroup']);
    expect(w.notes.join(' ')).toMatch(/can migrate out of it/);
    // Owner root and the probe established it cannot: owning.
    expect(resolveVerifyPolicy(noNs, { netns: true, euid: 0, cgroupOwnerUid: 0, cgroupMigratable: false, runAs }).owning).toEqual(['cgroup', 'pidns']);
    // Nothing injected and the base does not exist: the real probe cannot establish anything -> migratable.
    const u = resolveVerifyPolicy({ ...noNs, cgroupBase: '/sys/fs/cgroup/tecera-does-not-exist-xyz' }, { netns: true, euid: 0, cgroupOwnerUid: 0, runAs });
    expect(u.owning).toEqual(['pidns']);
    expect(u.notes.join(' ')).toMatch(/unknown/);
  });

  it('same-uid delegation: a cgroup owned by the command uid does not own descendants (without a cgroup namespace)', () => {
    const p = resolveVerifyPolicy({ ...full, cgroupns: null }, { netns: true, euid: 0, cgroupOwnerUid: VUID, runAs });
    expect(p.owning).toEqual(['pidns']);
    expect(p.missing).toEqual(['cgroup']);
    const none = resolveVerifyPolicy({ ...full, cgroupns: null, pidns: null }, { netns: true, euid: 0, cgroupOwnerUid: VUID, runAs });
    expect(none.owning).toEqual([]);
  });

  it('non-root supervisor: same uid as the supervisor (uid missing), its delegated cgroup is migratable, the pid namespace owns', () => {
    const p = resolveVerifyPolicy({ ...full, cgroupns: null, pidns: ['/usr/bin/unshare', '-rpf', '--kill-child'] }, { netns: false, euid: 1000, cgroupOwnerUid: 1000 });
    expect(p.identity).toBe('supervisor');
    expect(p.owning).toEqual(['pidns']);
    expect(p.missing).toEqual(['uid', 'cgroup', 'netns']);
    expect(() => resolveVerifyPolicy(full, { netns: false, euid: 1000, runAs })).toThrow(/root supervisor/);
  });

  it('runAs is validated: uid 0, the supervisor uid and a host without setpriv are refused', () => {
    expect(() => resolveVerifyPolicy(full, { netns: true, euid: 0, runAs: { uid: 0, gid: 0 } })).toThrow(IsolationUnavailable);
    expect(() => resolveVerifyPolicy({ ...full, setpriv: null }, { netns: true, euid: 0, runAs })).toThrow(/setpriv/);
  });
});

describe.skipIf(!isRoot || !strong)('ProcessVerifyRunner refuses root by default', () => {
  it('constructing without runAs or allowRoot on a root supervisor throws IsolationUnavailable', () => {
    expect(() => new ProcessVerifyRunner()).toThrow(IsolationUnavailable);
    expect(() => new ProcessVerifyRunner({ netns })).toThrow(/would run as root/);
  });
});

describe.skipIf(!canDrop)('ProcessVerifyRunner (dropped identity)', () => {
  let cwd: string;
  let runner: ProcessVerifyRunner;
  const allow = ['PATH', 'HOME'];

  beforeAll(async () => {
    // Constructed here, not in the describe body: on a host without the controls the suite is skipped
    // before anything throws.
    runner = new ProcessVerifyRunner({ runAs, netns, cgroupTag: TAG });
    cwd = await openDir('tecera-verify-');
    await writeFile(join(cwd, 'marker.txt'), 'here');
  });
  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('exit 0 with output, in the given cwd, as the unprivileged uid without capabilities, contained and proven gone', async () => {
    const r = await runner.run({ cwd, command: 'cat marker.txt; echo; id -u; grep CapEff /proc/self/status; echo err >&2', timeoutSec: 10, envAllowlist: allow });
    expect(r).toMatchObject({ exitCode: 0, signal: null, timedOut: false, stderr: 'err\n', truncated: false, gone: true, stragglers: 0, escaped: 0, identity: 'dropped' });
    expect(r.stdout).toBe(`here\n${VUID}\nCapEff:\t0000000000000000\n`);
    expect(r.containment).toContain('uid');
    expect(r.owning.length).toBeGreaterThan(0);
    if (netns) expect(r.degraded).toBeUndefined();
  });

  it('exit 1 is reported, not interpreted', async () => {
    const r = await runner.run({ cwd, command: 'echo failing; exit 1', timeoutSec: 10, envAllowlist: allow });
    expect(r).toMatchObject({ exitCode: 1, timedOut: false, stdout: 'failing\n' });
  });

  it('a cwd the verify uid cannot read is refused (127) before anything runs', async () => {
    const closed = await mkdtemp(join(tmpdir(), 'tecera-verify-closed-'));
    try {
      const r = await runner.run({ cwd: closed, command: 'true', timeoutSec: 5, envAllowlist: allow });
      expect(r.exitCode).toBe(VERIFY_SPAWN_EXIT);
      expect(r.reason).toMatch(/not accessible to the verify identity/);
    } finally {
      await rm(closed, { recursive: true, force: true });
    }
  });

  it('timeout kills everything of the run and reports 124; a background writer never writes', async () => {
    const t0 = Date.now();
    const r = await runner.run({ cwd, command: '(sleep 1; echo late > late-timeout.txt) & sleep 30', timeoutSec: 0.5, envAllowlist: allow });
    expect(r).toMatchObject({ exitCode: VERIFY_TIMEOUT_EXIT, timedOut: true, gone: true });
    expect(Date.now() - t0).toBeLessThan(5_000);
    await sleep(1_200);
    expect(existsSync(join(cwd, 'late-timeout.txt'))).toBe(false);
  });

  it('a background straggler holding stdout open is killed, counted, and does not hang the runner', async () => {
    const t0 = Date.now();
    const r = await new ProcessVerifyRunner({ runAs, netns, drainMs: 300 }).run({ cwd, command: 'sleep 20 & echo started', timeoutSec: 10, envAllowlist: allow });
    expect(r.exitCode).toBe(0);
    expect(r.gone).toBe(true);
    expect(r.stdout).toContain('started');
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('escaped descendant: setsid + double fork + cgroup migration attempt never writes its marker, under every owning layer', async () => {
    const layers: Array<[string, ContainmentProbe]> = [['all', probe]];
    if (probe.cgroupBase) layers.push(['cgroup only', { ...probe, pidns: null }]);
    if (probe.pidns) layers.push(['pidns only', { ...probe, cgroupBase: null }]);
    for (const [name, containment] of layers) {
      const tag = name.replace(/\W/g, '');
      const cmd = [
        `setsid sh -c 'sleep 1; echo late > escaped-${tag}.txt' </dev/null >/dev/null 2>&1 &`,
        `env -i /usr/bin/setsid /bin/sh -c '( /bin/sleep 1; echo late > escaped2-${tag}.txt ) & exit 0' </dev/null >/dev/null 2>&1 &`,
        probe.cgroupBase ? `sh -c 'echo $$ > ${probe.cgroupBase}/cgroup.procs 2>/dev/null; sleep 1; echo late > migrated-${tag}.txt' </dev/null >/dev/null 2>&1 &` : 'true',
        'sleep 0.2; exit 0',
      ].join('\n');
      const r = await new ProcessVerifyRunner({ runAs, netns, containment }).run({ cwd, command: cmd, timeoutSec: 10, envAllowlist: allow });
      // Either the run is not a pass, or it is a pass AND every descendant was proven killed.
      if (r.exitCode === 0) expect(r.gone && r.escaped === 0, name).toBe(true);
      await sleep(1_500);
      for (const m of [`escaped-${tag}.txt`, `escaped2-${tag}.txt`, `migrated-${tag}.txt`]) expect(existsSync(join(cwd, m)), `${name}: ${m}`).toBe(false);
    }
  }, 40_000);

  it('failed cleanup is never a pass: surviving descendants make the outcome exitCode null, cancelled, reason', async () => {
    const r = await new ProcessVerifyRunner({ runAs, netns, testReapOverride: (k) => ({ ...k, gone: false, survivors: [999_999] }) }).run({ cwd, command: 'exit 0', timeoutSec: 5, envAllowlist: allow });
    expect(r).toMatchObject({ exitCode: null, cancelled: true, gone: false });
    expect(r.reason).toMatch(/descendants survived/);
    // Survivors taint the cwd (sprint-3): the next verify there refuses until the supervisor releases it.
    expect(r.tainted?.processes).toContain(999_999);
    expect(worktreeQuarantine(cwd)?.source).toBe('verify');
    const again = await runner.run({ cwd, command: 'exit 0', timeoutSec: 5, envAllowlist: allow });
    expect(again).toMatchObject({ exitCode: null, cancelled: true });
    expect(again.reason).toMatch(/worktree tainted/);
    expect(releaseWorktreeQuarantine(cwd, { by: 'test', reason: 'simulated survivors; nothing was alive' })).toBe(true);
  });

  it('cancel kills the run and reports 130', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await runner.run({ cwd, command: 'sleep 30', timeoutSec: 10, envAllowlist: allow }, ac.signal);
    expect(r).toMatchObject({ exitCode: VERIFY_CANCEL_EXIT, cancelled: true, timedOut: false, gone: true });
  });

  it('output under the cap passes through untouched', async () => {
    const r = await new ProcessVerifyRunner({ runAs, netns, maxOutputBytes: 1000 }).run({ cwd, command: 'yes | head -c 900; yes e | head -c 300 >&2', timeoutSec: 10, envAllowlist: allow });
    expect(r).toMatchObject({ exitCode: 0, truncated: false, stdoutTruncated: false, stderrTruncated: false });
    expect(r.stdout.length).toBe(900);
    expect(r.stderr.length).toBe(300);
  });

  it('ADV-1: going over the cap kills the process group and the cgroup at once; the outcome is {exitCode null, truncated, cancelled, reason output-cap}, never exit 0', async () => {
    const t0 = Date.now();
    const r = await new ProcessVerifyRunner({ runAs, netns, maxOutputBytes: 1000 }).run({ cwd, command: 'yes | head -c 50000; sleep 3; echo after > after-cap.txt; exit 0', timeoutSec: 20, envAllowlist: allow });
    expect(r).toMatchObject({ exitCode: null, truncated: true, cancelled: true, reason: VERIFY_OUTPUT_CAP, stdoutTruncated: true, gone: true });
    expect(r.stdout.length).toBeLessThanOrEqual(1000);
    expect(Date.now() - t0).toBeLessThan(2_500);
    await sleep(3_200);
    expect(existsSync(join(cwd, 'after-cap.txt'))).toBe(false);
  }, 15_000);

  it('ADV-1 at scale: a 10 MB flood that would then exit 0 is killed at the default 1 MiB cap and never passes', async () => {
    const t0 = Date.now();
    const r = await runner.run({ cwd, command: 'head -c 10000000 /dev/zero | tr "\\0" x; sleep 3; exit 0', timeoutSec: 60, envAllowlist: allow });
    expect(r.exitCode).toBeNull();
    expect(r).toMatchObject({ truncated: true, cancelled: true, reason: VERIFY_OUTPUT_CAP });
    expect(r.stdout.length).toBeLessThanOrEqual(1024 * 1024);
    expect(Date.now() - t0).toBeLessThan(2_500);
  }, 15_000);

  it('a secret (raw, base64, hex) straddling the output cap never leaves a fragment; under the cap it is redacted', async () => {
    const SECRET = 'verify-REGISTERED-secret-0123456789abcdef';
    const encs = [SECRET, Buffer.from(SECRET).toString('base64'), Buffer.from(SECRET).toString('hex')];
    const redactor = makeRedactor([SECRET]);
    for (const [i, enc] of encs.entries()) {
      writeFileSync(join(cwd, `flood-${i}.txt`), 'a'.repeat(990) + enc + 'b'.repeat(20_000));
      writeFileSync(join(cwd, `small-${i}.txt`), `x ${enc} y`);
      chmodSync(join(cwd, `flood-${i}.txt`), 0o644);
      chmodSync(join(cwd, `small-${i}.txt`), 0o644);
      const r = await new ProcessVerifyRunner({ runAs, netns, maxOutputBytes: 1000, redactor }).run({ cwd, command: `cat flood-${i}.txt; cat flood-${i}.txt >&2`, timeoutSec: 10, envAllowlist: allow });
      expect(r.reason).toBe(VERIFY_OUTPUT_CAP);
      for (const e of encs) for (const w of windows(e, 10)) {
        expect(r.stdout.includes(w), `stdout ${i}: ${w}`).toBe(false);
        expect(r.stderr.includes(w), `stderr ${i}: ${w}`).toBe(false);
      }
      const s = await new ProcessVerifyRunner({ runAs, netns, redactor }).run({ cwd, command: `cat small-${i}.txt`, timeoutSec: 10, envAllowlist: allow });
      expect(s.exitCode).toBe(0);
      expect(s.stdout).toMatch(/^x \[REDACTED:secret:[0-9a-f]{8}\] y$/);
    }
  }, 30_000);

  it('secret.canary: the verify env is allowlist ∩ SAFE_ENV; canaries are absent and canary-shaped output is redacted', async () => {
    const value = `canary-${Math.random().toString(36).slice(2)}`;
    process.env.TECERA_CANARY_VERIFY = value;
    process.env.SOME_OTHER_VAR = 'other';
    try {
      const r = await runner.run({ cwd, command: 'env; echo TECERA_CANARY_PRINTED_xyz', timeoutSec: 10, envAllowlist: ['PATH', 'TECERA_CANARY_VERIFY', 'SOME_OTHER_VAR'] });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain(value);
      expect(r.stdout).not.toContain('SOME_OTHER_VAR');
      expect(r.stdout).toContain('PATH=');
      expect(r.stdout).not.toContain('TECERA_CANARY_PRINTED_xyz');
      expect(r.envDropped.sort()).toEqual(['SOME_OTHER_VAR', 'TECERA_CANARY_VERIFY']);
    } finally {
      delete process.env.TECERA_CANARY_VERIFY;
      delete process.env.SOME_OTHER_VAR;
    }
  });

  it('dangerous env names are refused even when allowlisted: the command never runs', async () => {
    for (const name of ['GITHUB_TOKEN', 'NODE_OPTIONS', 'LD_PRELOAD', 'AWS_SECRET_ACCESS_KEY']) {
      const r = await runner.run({ cwd, command: 'echo ran > refused.txt', timeoutSec: 5, envAllowlist: ['PATH', name] });
      expect(r.exitCode, name).toBe(VERIFY_SPAWN_EXIT);
      expect(r.reason, name).toMatch(/env refused/);
    }
    expect(existsSync(join(cwd, 'refused.txt'))).toBe(false);
  });

  it('missing tooling and bad requests report 127 instead of throwing', async () => {
    expect((await runner.run({ cwd: join(cwd, 'nope'), command: 'true', timeoutSec: 5, envAllowlist: allow })).exitCode).toBe(VERIFY_SPAWN_EXIT);
    expect((await runner.run({ cwd: 'relative', command: 'true', timeoutSec: 5, envAllowlist: allow })).exitCode).toBe(VERIFY_SPAWN_EXIT);
    expect((await runner.run({ cwd, command: '   ', timeoutSec: 5, envAllowlist: allow })).exitCode).toBe(VERIFY_SPAWN_EXIT);
    expect((await runner.run({ cwd, command: 'definitely-not-a-command-xyz', timeoutSec: 5, envAllowlist: allow })).exitCode).toBe(127);
  });

  it('leaves no cgroup behind after a run', async () => {
    const r = await runner.run({ cwd, command: 'true', timeoutSec: 5, envAllowlist: allow });
    expect(r.gone).toBe(true);
    if (probe.cgroupBase) expect(readdirSync(probe.cgroupBase).filter((d) => d.startsWith(`tecera-verify-${TAG}-`))).toEqual([]);
  });
});

describe.skipIf(!canDrop || !probe.cgroupBase)('same-uid cgroup delegation (the command owns the base cgroup)', () => {
  let cwd: string;
  let deleg: string;
  beforeAll(async () => {
    cwd = await openDir('tecera-verify-deleg-');
    deleg = join(probe.cgroupBase!, `tecera-test-deleg-${process.pid}`);
    mkdirSync(deleg);
    for (const f of ['', 'cgroup.procs', 'cgroup.threads', 'cgroup.subtree_control']) chownSync(join(deleg, f), VUID, VUID);
  });
  afterAll(async () => {
    try {
      rmdirSync(deleg);
    } catch {
      /* best effort */
    }
    await rm(cwd, { recursive: true, force: true });
  });

  const migrateAndEscape = (tag: string) =>
    `sh -c 'echo $$ > DELEG/cgroup.procs && exec setsid sh -c "sleep 1; echo late > ${tag}.txt"' </dev/null >/dev/null 2>&1 & sleep 0.3; exit 0`;

  it('without a pid namespace the delegated cgroup owns nothing: refused by default', () => {
    const containment: ContainmentProbe = { ...probe, cgroupBase: deleg, pidns: null, cgroupns: null };
    expect(() => new ProcessVerifyRunner({ runAs, netns, containment })).toThrow(/cannot own/);
  });

  it('a descendant that migrates into the delegated parent and leaves the session is detected by the uid scan, killed, and the run fails closed', async () => {
    const containment: ContainmentProbe = { ...probe, cgroupBase: deleg, pidns: null, cgroupns: null };
    const runner = new ProcessVerifyRunner({ runAs, netns, containment, allowWeakContainment: true });
    expect(runner.owning).toEqual([]);
    const r = await runner.run({ cwd, command: migrateAndEscape('deleg-escape').replace('DELEG', deleg), timeoutSec: 10, envAllowlist: ['PATH'] });
    expect(r.exitCode).toBeNull();
    expect(r.reason).toMatch(/escaped containment/);
    expect(r.escaped).toBeGreaterThanOrEqual(1);
    expect(r.degraded?.missing).toContain('cgroup');
    await sleep(1_500);
    expect(existsSync(join(cwd, 'deleg-escape.txt'))).toBe(false);
  }, 20_000);

  it.skipIf(!probe.pidns)('with a pid namespace the run is allowed (pidns owns), reported degraded (cgroup missing), and the migrated writer still dies', async () => {
    const containment: ContainmentProbe = { ...probe, cgroupBase: deleg, cgroupns: null };
    const runner = new ProcessVerifyRunner({ runAs, netns, containment });
    expect(runner.owning).toEqual(['pidns']);
    expect(runner.degraded?.missing).toEqual(netns ? ['cgroup'] : ['cgroup', 'netns']);
    const r = await runner.run({ cwd, command: migrateAndEscape('deleg-pidns').replace('DELEG', deleg), timeoutSec: 10, envAllowlist: ['PATH'] });
    if (r.exitCode === 0) expect(r.gone).toBe(true);
    await sleep(1_500);
    expect(existsSync(join(cwd, 'deleg-pidns.txt'))).toBe(false);
  }, 20_000);
});

describe.skipIf(!isRoot || !strong || !probe.setpriv)('allowRoot (explicit, degraded)', () => {
  let cwd: string;
  beforeAll(async () => {
    cwd = await openDir('tecera-verify-root-');
  });
  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('is degraded with uid missing, records verify.degraded evidence BEFORE the command runs, and a failing sink refuses the run', async () => {
    const ev: VerifyEvidence[] = [];
    const runner = new ProcessVerifyRunner({ allowRoot: true, netns, onEvidence: (e) => void ev.push(e) });
    expect(runner.identity).toBe('root');
    expect(runner.degraded?.missing).toContain('uid');
    const r = await runner.run({ cwd, command: 'id -u; grep CapEff /proc/self/status', timeoutSec: 10, envAllowlist: ['PATH'] });
    expect(r).toMatchObject({ exitCode: 0, identity: 'root' });
    expect(r.stdout).toBe('0\nCapEff:\t0000000000000000\n');
    expect(r.degraded?.missing).toContain('uid');
    expect(ev.map((e) => e.kind)).toEqual(['verify.degraded']);
    expect(ev[0]!.body).toMatchObject({ identity: 'root', missing: expect.arrayContaining(['uid']) });

    const refusing = new ProcessVerifyRunner({ allowRoot: true, netns, onEvidence: () => Promise.reject(new Error('ledger down')) });
    const x = await refusing.run({ cwd, command: 'echo ran > ran-root.txt', timeoutSec: 5, envAllowlist: ['PATH'] });
    expect(x.exitCode).toBe(VERIFY_SPAWN_EXIT);
    expect(x.reason).toMatch(/degraded verify refused/);
    expect(existsSync(join(cwd, 'ran-root.txt'))).toBe(false);
  });

  it.skipIf(!probe.cgroupBase || !probe.cgroupns || !probe.nsdelegate)('root cgroup migration: the attack works for a plain root process, but not for the contained command (cgroupns + nsdelegate + no capabilities)', async () => {
    // Control: an uncontained root shell CAN move itself out of a fresh cgroup into the base.
    const ctl = join(probe.cgroupBase!, `tecera-test-ctl-${process.pid}`);
    mkdirSync(ctl);
    try {
      const c = spawnSync('/bin/sh', ['-c', `echo $$ > ${ctl}/cgroup.procs && echo $$ > ${probe.cgroupBase}/cgroup.procs && echo moved`], { encoding: 'utf8' });
      expect(c.stdout.trim()).toBe('moved');
    } finally {
      rmdirSync(ctl);
    }
    const runner = new ProcessVerifyRunner({ allowRoot: true, netns, containment: { ...probe, pidns: null } });
    expect(runner.owning).toEqual(['cgroup']);
    const r = await runner.run({
      cwd,
      command: `sh -c 'echo $$ > ${probe.cgroupBase}/cgroup.procs; exec setsid sh -c "sleep 1; echo late > root-migrated.txt"' </dev/null >/dev/null 2>&1 & sleep 0.3; exit 0`,
      timeoutSec: 10,
      envAllowlist: ['PATH'],
    });
    if (r.exitCode === 0) expect(r.gone && r.escaped === 0).toBe(true);
    await sleep(1_500);
    expect(existsSync(join(cwd, 'root-migrated.txt'))).toBe(false);
  }, 20_000);

  it.skipIf(!probe.pidns)('root namespace escape: nsenter to the host pid namespace fails without capabilities; the writer dies with the namespace', async () => {
    const runner = new ProcessVerifyRunner({ allowRoot: true, netns, containment: { ...probe, cgroupBase: null } });
    expect(runner.owning).toEqual(['pidns']);
    const r = await runner.run({
      cwd,
      command: `(nsenter -t 1 -p -- setsid sh -c 'sleep 1; echo late > root-nsenter.txt' || setsid sh -c 'sleep 1; echo late > root-nsenter2.txt') </dev/null >/dev/null 2>&1 & sleep 0.3; exit 0`,
      timeoutSec: 10,
      envAllowlist: ['PATH'],
    });
    if (r.exitCode === 0) expect(r.gone).toBe(true);
    await sleep(1_500);
    expect(existsSync(join(cwd, 'root-nsenter.txt'))).toBe(false);
    expect(existsSync(join(cwd, 'root-nsenter2.txt'))).toBe(false);
  }, 20_000);

  it.skipIf(!probe.cgroupBase || !probe.cgroupns || !probe.nsdelegate)('nested cgroups: a writer moved into a sub-cgroup it created is still found, killed and the subtree removed', async () => {
    const runner = new ProcessVerifyRunner({ allowRoot: true, netns, containment: { ...probe, pidns: null }, cgroupTag: TAG });
    const r = await runner.run({
      cwd,
      command: `J=$(ls -d ${probe.cgroupBase}/tecera-verify-${TAG}-* | head -n 1); mkdir "$J/nest" && sh -c 'echo $$ > '"$J"'/nest/cgroup.procs && exec setsid sh -c "sleep 1; echo late > nested.txt"' </dev/null >/dev/null 2>&1 & sleep 0.3; exit 0`,
      timeoutSec: 10,
      envAllowlist: ['PATH'],
    });
    expect(r.gone).toBe(true);
    await sleep(1_500);
    expect(existsSync(join(cwd, 'nested.txt'))).toBe(false);
    expect(readdirSync(probe.cgroupBase!).filter((d) => d.startsWith(`tecera-verify-${TAG}-`))).toEqual([]);
  }, 20_000);
});

describe('session-only containment (no owning layer)', () => {
  const weak: ContainmentProbe = { cgroupBase: null, pidns: null, cgroupns: null, setpriv: probe.setpriv ?? null };

  it('refuses to construct unless weak containment is explicitly allowed', () => {
    if (isRoot) expect(() => new ProcessVerifyRunner({ containment: weak, allowRoot: true })).toThrow(IsolationUnavailable);
    else expect(() => new ProcessVerifyRunner({ containment: weak })).toThrow(IsolationUnavailable);
  });

  it.skipIf(!isRoot || !probe.setpriv)('control: as root, session-only containment really cannot see a setsid escapee (why it is refused by default)', async () => {
    const dir = await openDir('tecera-verify-weak-');
    try {
      const runner = new ProcessVerifyRunner({ containment: weak, allowRoot: true, allowWeakContainment: true });
      const r = await runner.run({ cwd: dir, command: 'sleep 20 & echo hi', timeoutSec: 5, envAllowlist: ['PATH'] });
      expect(r).toMatchObject({ exitCode: 0, containment: ['session'], gone: true, stragglers: 1 });
      expect(r.degraded?.missing).toEqual(expect.arrayContaining(['uid', 'cgroup', 'pidns']));
      const e = await runner.run({ cwd: dir, command: "setsid sh -c 'sleep 0.5; echo late > escaped-weak.txt' </dev/null >/dev/null 2>&1 & sleep 0.2; exit 0", timeoutSec: 5, envAllowlist: ['PATH'] });
      expect(e.exitCode).toBe(0);
      await sleep(1_200);
      expect(existsSync(join(dir, 'escaped-weak.txt'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it.skipIf(!canDrop)('with a dedicated uid, the uid scan catches the same setsid escapee: killed, reported, never a pass', async () => {
    const dir = await openDir('tecera-verify-weakuid-');
    try {
      const runner = new ProcessVerifyRunner({ containment: weak, runAs, allowWeakContainment: true });
      const e = await runner.run({ cwd: dir, command: "setsid sh -c 'sleep 0.5; echo late > escaped-weak.txt' </dev/null >/dev/null 2>&1 & sleep 0.2; exit 0", timeoutSec: 5, envAllowlist: ['PATH'] });
      expect(e.exitCode).toBeNull();
      expect(e.reason).toMatch(/escaped containment/);
      await sleep(1_200);
      expect(existsSync(join(dir, 'escaped-weak.txt'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe.skipIf(!isRoot || !probe.cgroupBase)('unreadable containment state is never "empty"', () => {
  it('a jail whose cgroup state cannot be read reaps as gone: false with a reason', async () => {
    const j = Jail.open(probe);
    const dir = j.cgroupPath!;
    rmdirSync(dir); // the cgroup vanishes underneath the jail: cgroup.procs / cgroup.events are unreadable
    const r = await j.reap(200);
    expect(r.gone).toBe(false);
    expect(r.reason).toMatch(/containment state unreadable/);
    expect(await j.release()).toBe(true);
  });
});
