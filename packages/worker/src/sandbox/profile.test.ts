import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EnvRefused } from './env.js';
import { IsolationUnavailable } from './errors.js';
import { buildChildProfile, detectIsolation, resolveIsolation, type IsolationProbe, type SandboxSettings } from './profile.js';

const sandbox: SandboxSettings = { profile: 'process', isolation: 'node', memoryMb: 96, execTimeoutSec: 5, envAllowlist: ['PATH', 'HOME', 'CI', 'TECERA_CANARY_PROFILE'] };
const none: IsolationProbe = { netns: null, prlimit: null, systemdRun: null, uidDrop: null, dropUid: null };
const full: IsolationProbe = {
  netns: ['/usr/bin/unshare', '-n'],
  prlimit: '/usr/bin/prlimit',
  systemdRun: '/usr/bin/systemd-run',
  uidDrop: ['/usr/bin/setpriv', '--reuid=65534', '--regid=65534', '--clear-groups', '--no-new-privs', '--'],
  dropUid: { uid: 65534, gid: 65534 },
};

describe('ChildProfile', () => {
  let scratch: string;
  beforeAll(async () => {
    process.env.TECERA_CANARY_PROFILE = 'canary-profile-value';
    scratch = await mkdtemp(join(tmpdir(), 'tecera-profile-'));
  });
  afterAll(async () => {
    delete process.env.TECERA_CANARY_PROFILE;
    await rm(scratch, { recursive: true, force: true });
  });

  it('builds the §2 node flags, a SAFE_ENV-only env and a detached, piped spawn in scratch', () => {
    const p = buildChildProfile(sandbox, scratch, resolveIsolation(sandbox, none));
    expect(p.nodeFlags).toEqual([
      '--permission',
      `--allow-fs-read=${join(scratch, 'child')}`,
      '--disallow-code-generation-from-strings',
      '--frozen-intrinsics',
      '--disable-proto=throw',
      '--no-addons',
      '--no-experimental-require-module',
      '--no-experimental-websocket',
      '--max-old-space-size=96',
      '--stack-size=984',
      '--disable-warning=ExperimentalWarning',
    ]);
    expect(p.command).toBe(process.execPath);
    expect(p.args.at(-1)).toBe(join(scratch, 'child', 'entry.mjs'));
    expect(p.env).toEqual({ PATH: '', HOME: join(scratch, 'home'), TMPDIR: join(scratch, 'home'), LANG: 'C.UTF-8', ...(process.env.CI !== undefined ? { CI: process.env.CI } : {}) });
    expect(JSON.stringify(p.env)).not.toContain('canary-profile-value');
    expect(p.envDropped).toEqual(['TECERA_CANARY_PROFILE']);
    expect(p.spawnOptions).toMatchObject({ cwd: join(scratch, 'home'), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  });

  it('dangerous allowlisted env names refuse the profile', () => {
    for (const n of ['NODE_OPTIONS', 'LD_PRELOAD', 'GITHUB_TOKEN']) {
      expect(() => buildChildProfile({ ...sandbox, envAllowlist: ['PATH', n] }, scratch, resolveIsolation(sandbox, none)), n).toThrow(EnvRefused);
    }
  });

  it("isolation 'node' records exactly which of netns, cgroup, uid are missing and is always degraded", () => {
    const iso = resolveIsolation(sandbox, none);
    expect(iso).toMatchObject({ mode: 'node', applied: [], missing: ['netns', 'cgroup', 'uid'], prefix: [] });
    expect(iso.degraded?.missing).toEqual(['netns', 'cgroup', 'uid']);
    const partial = resolveIsolation(sandbox, { ...none, netns: ['/usr/bin/unshare', '-n'], prlimit: '/usr/bin/prlimit' });
    expect(partial).toMatchObject({ mode: 'node', applied: ['netns'], missing: ['cgroup', 'uid'], wrappers: ['prlimit', 'netns'] });
    expect(partial.degraded?.reason).toMatch(/missing cgroup, uid/);
    // Even with every control present, 'node' was requested: still reported as node/degraded, never 'os'.
    const all = resolveIsolation(sandbox, full);
    expect(all.mode).toBe('node');
    expect(all.missing).toEqual([]);
    expect(all.degraded).toBeDefined();
  });

  it("isolation 'os' is reported only with netns + cgroup + uid; any missing control fails closed", () => {
    const os = { ...sandbox, isolation: 'os' as const };
    expect(() => resolveIsolation(os, none)).toThrow(IsolationUnavailable);
    // prlimit + netns alone used to count as 'os'; it no longer does.
    expect(() => resolveIsolation(os, { ...none, netns: ['/usr/bin/unshare', '-n'], prlimit: '/usr/bin/prlimit' })).toThrow(/missing on this host: cgroup, uid/);
    expect(() => resolveIsolation(os, { ...full, uidDrop: null, dropUid: null })).toThrow(/missing on this host: uid/);
    expect(() => resolveIsolation(os, { ...full, systemdRun: null })).toThrow(/missing on this host: cgroup/);
    const iso = resolveIsolation(os, full);
    expect(iso).toMatchObject({ mode: 'os', applied: ['cgroup', 'netns', 'uid'], missing: [], dropUid: { uid: 65534, gid: 65534 } });
    expect(iso.degraded).toBeUndefined();
    const p = buildChildProfile(os, scratch, iso);
    expect(p.command).toBe('/usr/bin/systemd-run');
    const n = p.args.indexOf(process.execPath);
    // uid drop is innermost (right before node), netns right before it.
    expect(p.args.slice(n - 8, n)).toEqual(['/usr/bin/unshare', '-n', '/usr/bin/setpriv', '--reuid=65534', '--regid=65534', '--clear-groups', '--no-new-privs', '--']);
    expect(p.args.slice(n + 1, -1)).toEqual(p.nodeFlags);
    expect(() => resolveIsolation({ ...sandbox, profile: 'docker' }, none)).toThrow(IsolationUnavailable);
  });

  it('refuses scratch dirs on Windows mounts', () => {
    expect(() => buildChildProfile(sandbox, '/mnt/c/tmp/x', resolveIsolation(sandbox, none))).toThrow(/Windows mount/);
  });

  it('escape.fs_read_outside / escape.child_process_via_leak: the flags deny fs reads outside child/ and spawning even with full process access', async () => {
    const p = buildChildProfile(sandbox, scratch, resolveIsolation(sandbox, none));
    await mkdir(p.childDir, { recursive: true });
    await mkdir(p.homeDir, { recursive: true });
    await writeFile(
      p.entryPath,
      [
        "import fs from 'node:fs';",
        "import cp from 'node:child_process';",
        'const out = {};',
        "try { fs.readFileSync('/etc/passwd'); out.fs = 'READ'; } catch (e) { out.fs = e.code; }",
        "try { fs.writeFileSync(process.env.HOME + '/x', 'y'); out.write = 'WROTE'; } catch (e) { out.write = e.code; }",
        "try { cp.spawnSync('/bin/sh', ['-c', 'true']); out.spawn = 'SPAWNED'; } catch (e) { out.spawn = e.code; }",
        "try { process.binding('fs'); out.binding = 'BOUND'; } catch (e) { out.binding = 'denied'; }",
        'out.canary = JSON.stringify(process.env).includes("canary-profile-value");',
        'out.nodeOptions = process.env.NODE_OPTIONS === undefined;',
        'process.stdout.write(JSON.stringify(out));',
      ].join('\n'),
    );
    const child = spawn(p.command, p.args, { ...p.spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout!.on('data', (c) => (stdout += c));
    await new Promise((r) => child.once('close', r));
    const out = JSON.parse(stdout);
    expect(out).toEqual({ fs: 'ERR_ACCESS_DENIED', write: 'ERR_ACCESS_DENIED', spawn: 'ERR_ACCESS_DENIED', binding: 'denied', canary: false, nodeOptions: true });
  });

  const probe = detectIsolation();
  it.skipIf(!probe.netns)('netns control: the child runs in a network namespace with no route out', async () => {
    const iso = resolveIsolation(sandbox, { ...probe, uidDrop: null, dropUid: null, systemdRun: null });
    expect(iso.applied).toContain('netns');
    const dir = await mkdtemp(join(tmpdir(), 'tecera-netns-'));
    try {
      const p = buildChildProfile(sandbox, dir, iso);
      await mkdir(p.childDir, { recursive: true });
      await mkdir(p.homeDir, { recursive: true });
      // Reads the interface table only: no packet leaves the host.
      await writeFile(p.entryPath, "import os from 'node:os'; process.stdout.write(JSON.stringify(Object.keys(os.networkInterfaces())));");
      const child = spawn(p.command, p.args, { ...p.spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout!.on('data', (c) => (stdout += c));
      await new Promise((r) => child.once('close', r));
      const ifaces = JSON.parse(stdout) as string[];
      expect(ifaces.filter((i) => i !== 'lo')).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
