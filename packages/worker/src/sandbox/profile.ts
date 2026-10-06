import { spawnSync, type SpawnOptions } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { assertEnvAllowlist, scrubEnv } from './env.js';
import { IsolationUnavailable } from './errors.js';

/**
 * The restricted child-process profile (docs/security.md §2). Node flags close code generation,
 * prototype mutation, addons, require and websockets and confine fs reads to the entry directory; the
 * env is `manifest allowlist ∩ SANDBOX_SAFE_ENV` with PATH empty and NODE_OPTIONS absent; cwd is an empty
 * scratch dir under os.tmpdir() (never a worktree, never /mnt/*).
 *
 * OS controls. Three controls make up OS isolation, and `mode: 'os'` is reported ONLY when all three are
 * applied:
 *   - netns:  a fresh network namespace (`unshare -n`, or `-rn` for an unprivileged supervisor);
 *   - cgroup: memory and task limits in a transient cgroup (`systemd-run --scope -p MemoryMax -p TasksMax`);
 *   - uid:    the child runs as an unprivileged uid distinct from the supervisor's
 *             (`setpriv --reuid --regid --clear-groups --no-new-privs`, root supervisors only).
 * isolation 'os' with any control missing throws IsolationUnavailable naming the missing controls (fail
 * closed; security.md §2 "refuses to start without cgroup+ns"). isolation 'node' applies whatever controls
 * the host has (defence in depth), records EXACTLY which of the three are missing, and is always
 * `degraded`. prlimit (RLIMIT_AS/NOFILE/CORE) is applied when present but is not one of the three controls.
 */

/** The manifest's `sandbox` block (contracts ManifestSchema.sandbox), restated so callers can pass a subset. */
export interface SandboxSettings {
  profile: 'process' | 'bwrap' | 'docker';
  isolation: 'os' | 'node';
  network?: false;
  memoryMb: number;
  execTimeoutSec: number;
  envAllowlist: string[];
}

export type IsolationControl = 'netns' | 'cgroup' | 'uid';
export const ISOLATION_CONTROLS: readonly IsolationControl[] = Object.freeze(['netns', 'cgroup', 'uid']);

export interface IsolationProbe {
  /** argv prefix that runs the rest in a fresh network namespace, e.g. ['/usr/bin/unshare', '-n']. */
  netns: string[] | null;
  /** Absolute path to prlimit. */
  prlimit: string | null;
  /** Absolute path to systemd-run when a systemd manager is running (the cgroup control). */
  systemdRun: string | null;
  /** argv prefix that drops to an unprivileged uid/gid, e.g. ['/usr/bin/setpriv', '--reuid=65534', ...]. */
  uidDrop?: string[] | null;
  /** The uid/gid `uidDrop` switches to (the scratch dir is chowned to it). */
  dropUid?: { uid: number; gid: number } | null;
  /** argv prefix that runs the rest as init of a fresh pid namespace (verify containment). */
  pidns?: string[] | null;
  /** Writable cgroup v2 directory under which per-run cgroups can be created (verify containment). */
  cgroupBase?: string | null;
  /** argv prefix for a fresh cgroup namespace (`unshare -C`, root supervisors only; verify containment). */
  cgroupns?: string[] | null;
  /** Absolute path to a working setpriv (verify identity and capability drop). */
  setpriv?: string | null;
}

export interface ResolvedIsolation {
  mode: 'os' | 'node';
  /** argv prefix placed before the node binary (absolute paths only). */
  prefix: string[];
  wrappers: Array<'systemd-run' | 'prlimit' | 'netns' | 'uid'>;
  /** Controls that are applied. */
  applied: IsolationControl[];
  /** Controls (of netns, cgroup, uid) that are NOT applied. Non-empty implies mode 'node' and `degraded`. */
  missing: IsolationControl[];
  /** uid/gid the child runs as when the uid control is applied. */
  dropUid?: { uid: number; gid: number };
  degraded?: { reason: string; missing: IsolationControl[] };
}

export interface ChildProfile {
  isolation: ResolvedIsolation;
  scratchDir: string;
  childDir: string;
  entryPath: string;
  homeDir: string;
  /** Executable actually spawned (a wrapper or process.execPath). */
  command: string;
  args: string[];
  nodeFlags: string[];
  env: Record<string, string>;
  envDropped: string[];
  spawnOptions: SpawnOptions;
  memoryMb: number;
  execTimeoutMs: number;
}

function findOnPath(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const d of [...dirs, '/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    const p = join(d, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

function runs(argv: string[]): boolean {
  try {
    const r = spawnSync(argv[0]!, argv.slice(1), { stdio: 'ignore', timeout: 3_000, env: { PATH: '/usr/bin:/bin' } });
    return r.status === 0;
  } catch {
    return false;
  }
}

const NOBODY = { uid: 65534, gid: 65534 };

let cachedProbe: IsolationProbe | undefined;

/** Probe the host once for OS isolation tools. Every probe actually runs the tool; presence is not enough. */
export function detectIsolation(refresh = false): IsolationProbe {
  if (cachedProbe && !refresh) return cachedProbe;
  const probe: IsolationProbe = { netns: null, prlimit: null, systemdRun: null, uidDrop: null, dropUid: null, pidns: null, cgroupBase: null, cgroupns: null, setpriv: null };
  if (process.platform === 'linux') {
    const unshare = findOnPath('unshare');
    const trueBin = findOnPath('true') ?? '/bin/true';
    if (unshare) {
      if (runs([unshare, '-n', trueBin])) probe.netns = [unshare, '-n'];
      else if (runs([unshare, '-rn', trueBin])) probe.netns = [unshare, '-rn'];
      if (runs([unshare, '-pf', '--kill-child', trueBin])) probe.pidns = [unshare, '-pf', '--kill-child'];
      else if (runs([unshare, '-rpf', '--kill-child', trueBin])) probe.pidns = [unshare, '-rpf', '--kill-child'];
      if (typeof process.getuid === 'function' && process.getuid() === 0 && runs([unshare, '-C', trueBin])) probe.cgroupns = [unshare, '-C'];
    }
    const prlimit = findOnPath('prlimit');
    if (prlimit && runs([prlimit, '--nofile=64', trueBin])) probe.prlimit = prlimit;
    const systemdRun = findOnPath('systemd-run');
    if (systemdRun && existsSync('/run/systemd/system') && runs([systemdRun, '--scope', '--quiet', '--collect', trueBin])) probe.systemdRun = systemdRun;
    const setpriv = findOnPath('setpriv');
    if (setpriv && runs([setpriv, '--no-new-privs', '--', trueBin])) probe.setpriv = setpriv;
    if (setpriv && typeof process.getuid === 'function' && process.getuid() === 0) {
      const drop = [setpriv, `--reuid=${NOBODY.uid}`, `--regid=${NOBODY.gid}`, '--clear-groups', '--no-new-privs', '--'];
      if (runs([...drop, trueBin])) {
        probe.uidDrop = drop;
        probe.dropUid = { ...NOBODY };
      }
    }
    probe.cgroupBase = null; // filled lazily by the verify runner's containment probe (contain.ts)
  }
  cachedProbe = probe;
  return probe;
}

export function resolveIsolation(sandbox: SandboxSettings, probe: IsolationProbe = detectIsolation()): ResolvedIsolation {
  if (sandbox.profile !== 'process') throw new IsolationUnavailable(`sandbox profile '${sandbox.profile}' is not implemented; use 'process'`);
  if (sandbox.network !== undefined && sandbox.network !== false) throw new IsolationUnavailable('network must be false');
  if (sandbox.isolation !== 'os' && sandbox.isolation !== 'node') throw new IsolationUnavailable(`unknown isolation '${String(sandbox.isolation)}'`);
  const mem = sandbox.memoryMb;
  const prefix: string[] = [];
  const wrappers: ResolvedIsolation['wrappers'] = [];
  const applied: IsolationControl[] = [];
  const available = {
    cgroup: Boolean(probe.systemdRun),
    netns: Boolean(probe.netns && probe.netns.length),
    uid: Boolean(probe.uidDrop && probe.uidDrop.length && probe.dropUid),
  };
  const missing = ISOLATION_CONTROLS.filter((c) => !available[c]);
  if (sandbox.isolation === 'os' && missing.length) {
    throw new IsolationUnavailable(
      `isolation 'os' requires the netns, cgroup and uid controls; missing on this host: ${missing.join(', ')}. Set sandbox.isolation to 'node' to run degraded`,
    );
  }
  // Order: cgroup scope (outermost, so every later wrapper is inside it), rlimits, network namespace (needs
  // privilege), then the uid drop (innermost, right before node).
  if (available.cgroup) {
    prefix.push(probe.systemdRun!, '--scope', '--quiet', '--collect', '-p', `MemoryMax=${mem + 256}M`, '-p', 'TasksMax=64', '--');
    wrappers.push('systemd-run');
    applied.push('cgroup');
  }
  if (probe.prlimit) {
    // V8 reserves ~1 GiB of address space up front; RLIMIT_AS is a backstop for native allocations.
    prefix.push(probe.prlimit, `--as=${(mem + 2048) * 1024 * 1024}`, '--nofile=64', '--core=0', '--');
    wrappers.push('prlimit');
  }
  if (available.netns) {
    prefix.push(...probe.netns!);
    wrappers.push('netns');
    applied.push('netns');
  }
  let dropUid: ResolvedIsolation['dropUid'];
  if (available.uid) {
    prefix.push(...probe.uidDrop!);
    wrappers.push('uid');
    applied.push('uid');
    dropUid = { ...probe.dropUid! };
  }
  const resolved: ResolvedIsolation = { mode: missing.length === 0 && sandbox.isolation === 'os' ? 'os' : 'node', prefix, wrappers, applied, missing };
  if (dropUid) resolved.dropUid = dropUid;
  if (resolved.mode !== 'os') {
    resolved.degraded = {
      reason: `isolation 'node': --permission and vm realm${applied.length ? ` plus ${applied.join(', ')}` : ''}; missing ${missing.length ? missing.join(', ') : 'nothing, but os isolation was not requested'}`,
      missing: [...missing],
    };
  }
  return resolved;
}

export function nodeFlags(childDir: string, memoryMb: number): string[] {
  return [
    '--permission',
    `--allow-fs-read=${childDir}`,
    '--disallow-code-generation-from-strings',
    '--frozen-intrinsics',
    '--disable-proto=throw',
    '--no-addons',
    '--no-experimental-require-module',
    '--no-experimental-websocket',
    `--max-old-space-size=${memoryMb}`,
    '--stack-size=984',
    '--disable-warning=ExperimentalWarning',
  ];
}

/** Refuse scratch locations that are not plain local temp space. */
export function assertScratchDir(dir: string): void {
  if (!isAbsolute(dir)) throw new Error(`scratch dir must be absolute: ${dir}`);
  const r = resolve(dir);
  if (r.startsWith('/mnt/') || /^[A-Za-z]:[\\/]/.test(r)) throw new Error(`scratch dir must not be on a Windows mount: ${dir}`);
  if (/[\s,]/.test(r)) throw new Error(`scratch dir must not contain whitespace or commas: ${dir}`);
}

/** Validate the settings a profile is built from; throws (EnvRefused / Error) on a bad manifest block. */
export function assertSandboxSettings(sandbox: SandboxSettings): void {
  if (!Number.isInteger(sandbox.memoryMb) || sandbox.memoryMb < 16) throw new Error('sandbox.memoryMb must be an integer >= 16');
  if (!(sandbox.execTimeoutSec > 0)) throw new Error('sandbox.execTimeoutSec must be > 0');
  if (!Array.isArray(sandbox.envAllowlist)) throw new Error('sandbox.envAllowlist must be an array');
  assertEnvAllowlist(sandbox.envAllowlist);
}

/** Build the spawn profile for one exec. `scratchDir` must already exist; the host creates child/ and home/ in it. */
export function buildChildProfile(sandbox: SandboxSettings, scratchDir: string, isolation: ResolvedIsolation): ChildProfile {
  assertScratchDir(scratchDir);
  assertSandboxSettings(sandbox);
  const childDir = join(scratchDir, 'child');
  const homeDir = join(scratchDir, 'home');
  const entryPath = join(childDir, 'entry.mjs');
  const flags = nodeFlags(childDir, sandbox.memoryMb);
  // The REPL child gets PATH empty and HOME/TMPDIR in scratch whatever the allowlist says.
  const { env, dropped } = scrubEnv(sandbox.envAllowlist, process.env, { PATH: '', HOME: homeDir, TMPDIR: homeDir, LANG: 'C.UTF-8' });
  const argv = [...isolation.prefix, process.execPath, ...flags, entryPath];
  return {
    isolation,
    scratchDir,
    childDir,
    entryPath,
    homeDir,
    command: argv[0]!,
    args: argv.slice(1),
    nodeFlags: flags,
    env,
    envDropped: dropped,
    spawnOptions: { cwd: homeDir, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    memoryMb: sandbox.memoryMb,
    execTimeoutMs: Math.round(sandbox.execTimeoutSec * 1000),
  };
}
