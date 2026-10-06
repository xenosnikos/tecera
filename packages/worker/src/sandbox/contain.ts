import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, mkdirSync, readdirSync, readFileSync, readlinkSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { detectIsolation } from './profile.js';

/**
 * Containment for processes that are allowed to spawn (the verify command). A verify command is hostile
 * input: it can fork, `setsid`, double-fork, redirect its stdio, move itself to another cgroup or create
 * nested cgroups so a descendant outlives the shell and keeps editing the candidate tree after a "passing"
 * exit. Layers, strongest first, all applied when available:
 *
 *  - cgroup: a fresh cgroup v2 directory per run. The command is admitted BEFORE it runs (a gate shell
 *    blocks on stdin until the supervisor has written its pid into cgroup.procs), so every descendant is
 *    born inside it whatever session or group it creates. Kill = `cgroup.kill` (whole subtree, nested
 *    cgroups included) + SIGKILL of every listed pid; gone = `cgroup.events` reports `populated 0` AND no
 *    cgroup.procs anywhere in the subtree lists a pid. Whether the command can LEAVE the cgroup depends on
 *    its identity; the verify runner decides whether this layer "owns" descendants (see verifyRunner.ts).
 *  - pidns: the command runs as init of a fresh pid namespace (`unshare -pf --kill-child`); when that init
 *    dies the kernel SIGKILLs every process in the namespace, including setsid'd ones. setns can only
 *    enter a descendant namespace, never the parent.
 *  - session: the command is a session and group leader (spawn detached = setsid); kill = SIGKILL to the
 *    group plus every process whose session or group id matches, found by scanning /proc.
 *  - uid scan (when the command runs under a dedicated uid): a live process with that real or effective
 *    uid is attributed to this run only when no other run can own it (Codex sprint-3 sandbox finding 5):
 *    it is not a structural member (cgroup subtree, session/group, pid namespace, or already-seen pid) of
 *    any other live jail of this supervisor, and it is not inside another run's `tecera-verify-*` cgroup
 *    (other supervisors). Processes of that uid that already exist when the jail opens and that no run
 *    claims are `foreign`: they are never killed; the verify runner refuses to run beside them (the uid is
 *    not exclusive, so the scan could not tell their descendants from this run's).
 *
 * Escape detection: a process found by the session, namespace or uid scan that is NOT in the cgroup
 * subtree (when the cgroup layer is present), or found only by the uid scan, has left containment. It is
 * killed and reported in `escaped`; the verify runner turns any escape into a non-passing outcome.
 *
 * Unreadable state is never "empty": a cgroup.procs / cgroup.events read error is a ContainmentStateError,
 * and reap() then reports `gone: false` (fail closed).
 */

export type ContainmentLayer = 'cgroup' | 'pidns' | 'session' | 'uid';

export interface ContainmentProbe {
  /** Writable cgroup v2 directory to create per-run cgroups under, or null. */
  cgroupBase: string | null;
  /** argv prefix that makes the rest init of a new pid namespace, or null. */
  pidns: string[] | null;
  /** argv prefix that puts the rest in a new cgroup namespace rooted at the run's cgroup (root only), or null/absent. */
  cgroupns?: string[] | null;
  /** The cgroup2 hierarchy is mounted with nsdelegate (a cgroup namespace then bounds cgroup migration). */
  nsdelegate?: boolean;
  /** Absolute path to setpriv (identity and capability drop), or null/absent. */
  setpriv?: string | null;
}

export interface ReapResult {
  /** True only when no process of the run remains (cgroup empty, no session/group/namespace/uid member). */
  gone: boolean;
  /** Pids still present at the deadline. */
  survivors: number[];
  /** Number of processes that had to be killed. */
  killed: number;
  /** Pids that had left containment (outside the cgroup subtree, or found only by the uid scan). */
  escaped?: number[];
  /** Why `gone` is false when there are no survivors to name (e.g. unreadable containment state). */
  reason?: string;
}

export class ContainmentStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContainmentStateError';
  }
}

interface ProcStat {
  pid: number;
  ppid: number;
  pgrp: number;
  session: number;
  /** Start time in clock ticks since boot (field 22): (pid, start) identifies a process across pid reuse. */
  start: string;
}

const CGROUP_FS = '/sys/fs/cgroup';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Parse /proc/<pid>/stat (comm may contain spaces and parens: split after the LAST ')'). */
export function readProcStat(pid: number): ProcStat | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    if (close < 0) return null;
    const f = raw.slice(close + 2).split(' ');
    // f[0]=state f[1]=ppid f[2]=pgrp f[3]=session
    if (f[0] === 'Z' || f[0] === 'X') return null; // zombie: no longer runs (its parent reaps it)
    return { pid, ppid: Number(f[1]), pgrp: Number(f[2]), session: Number(f[3]), start: f[19] ?? '' };
  } catch {
    return null;
  }
}

/** Real and effective uid of a live process, or null when it is gone. */
export function readProcUids(pid: number): { real: number; effective: number } | null {
  try {
    const raw = readFileSync(`/proc/${pid}/status`, 'utf8');
    const line = raw.split('\n').find((l) => l.startsWith('Uid:'));
    if (!line) return null;
    const [real, effective] = line.slice(4).trim().split(/\s+/).map(Number);
    if (!Number.isInteger(real) || !Number.isInteger(effective)) return null;
    return { real: real!, effective: effective! };
  } catch {
    return null;
  }
}

export function listPids(): number[] {
  if (process.platform !== 'linux') return [];
  try {
    return readdirSync('/proc')
      .filter((d) => /^\d+$/.test(d))
      .map(Number);
  } catch {
    return [];
  }
}

/** Live (non-zombie) processes whose session id or process group id is `id`. */
export function sessionMembers(id: number): number[] {
  if (!Number.isInteger(id) || id <= 1) return [];
  const out: number[] = [];
  for (const pid of listPids()) {
    const s = readProcStat(pid);
    if (s && (s.session === id || s.pgrp === id)) out.push(pid);
  }
  return out;
}

/** Live processes running with real or effective uid `uid`. */
export function uidMembers(uid: number): number[] {
  if (!Number.isInteger(uid) || uid <= 0) return [];
  const out: number[] = [];
  for (const pid of listPids()) {
    const u = readProcUids(pid);
    if (u && (u.real === uid || u.effective === uid) && readProcStat(pid)) out.push(pid);
  }
  return out;
}

function nsLink(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/ns/pid`);
  } catch {
    return null;
  }
}

/** Live processes in the pid namespace identified by `link` (e.g. 'pid:[4026532218]'). */
export function namespaceMembers(link: string): number[] {
  const out: number[] = [];
  for (const pid of listPids()) {
    if (nsLink(pid) === link && readProcStat(pid)) out.push(pid);
  }
  return out;
}

/** Absolute cgroup v2 directory of a live process, or null when it is gone/unreadable. */
export function procCgroup(pid: number): string | null {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('0::'));
    return line ? join(CGROUP_FS, line.slice(3).trim()) : null;
  } catch {
    return null;
  }
}

/** Name prefix of every per-run verify cgroup (any supervisor). */
export const VERIFY_CGROUP_PREFIX = 'tecera-verify-';

/** Every pid listed in cgroup.procs of `dir` and of every nested cgroup below it. Throws when unreadable. */
export function cgroupTreePids(dir: string): number[] {
  const out: number[] = [];
  const visit = (d: string, depth: number): void => {
    if (depth > 32) throw new ContainmentStateError(`cgroup nesting below ${dir} exceeds 32 levels`);
    let raw: string;
    try {
      raw = readFileSync(join(d, 'cgroup.procs'), 'utf8');
    } catch (e) {
      throw new ContainmentStateError(`cannot read ${join(d, 'cgroup.procs')}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
    for (const s of raw.split('\n')) {
      const n = Number(s);
      if (s && Number.isInteger(n) && n > 0) out.push(n);
    }
    let entries: string[];
    try {
      entries = readdirSync(d, { withFileTypes: true })
        .filter((x) => x.isDirectory())
        .map((x) => x.name);
    } catch (e) {
      throw new ContainmentStateError(`cannot list ${d}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
    for (const sub of entries) visit(join(d, sub), depth + 1);
  };
  visit(dir, 0);
  return out;
}

/** `populated` from cgroup.events (covers the whole subtree). Throws when unreadable. */
export function cgroupPopulated(dir: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(join(dir, 'cgroup.events'), 'utf8');
  } catch (e) {
    throw new ContainmentStateError(`cannot read ${join(dir, 'cgroup.events')}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  const line = raw.split('\n').find((l) => l.startsWith('populated '));
  if (!line) throw new ContainmentStateError(`${join(dir, 'cgroup.events')} has no populated field`);
  return line.trim().endsWith(' 1');
}

/** Nested cgroup directories below `dir`, deepest first (for removal). Never throws. */
function nestedDirs(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string, depth: number): void => {
    if (depth > 32) return;
    let subs: string[] = [];
    try {
      subs = readdirSync(d, { withFileTypes: true })
        .filter((x) => x.isDirectory())
        .map((x) => join(d, x.name));
    } catch {
      return;
    }
    for (const s of subs) {
      visit(s, depth + 1);
      out.push(s);
    }
  };
  visit(dir, 0);
  return out;
}

function nsdelegateMounted(): boolean {
  try {
    return readFileSync('/proc/mounts', 'utf8')
      .split('\n')
      .some((l) => {
        const f = l.split(' ');
        return f[2] === 'cgroup2' && f[1] === CGROUP_FS && (f[3] ?? '').split(',').includes('nsdelegate');
      });
  } catch {
    return false;
  }
}

let cached: ContainmentProbe | undefined;

/** Probe once: a writable cgroup v2 base (our own cgroup), pid/cgroup namespace wrappers and setpriv. */
export function detectContainment(refresh = false): ContainmentProbe {
  if (cached && !refresh) return cached;
  const iso = detectIsolation(refresh);
  const probe: ContainmentProbe = { cgroupBase: null, pidns: iso.pidns ?? null, cgroupns: iso.cgroupns ?? null, nsdelegate: false, setpriv: iso.setpriv ?? null };
  if (process.platform === 'linux') {
    try {
      const line = readFileSync('/proc/self/cgroup', 'utf8')
        .split('\n')
        .find((l) => l.startsWith('0::'));
      if (line) {
        const rel = line.slice(3).trim();
        const base = join(CGROUP_FS, rel);
        const probeDir = join(base, `tecera-probe-${randomBytes(6).toString('hex')}`);
        mkdirSync(probeDir);
        try {
          readFileSync(join(probeDir, 'cgroup.procs'), 'utf8');
          readFileSync(join(probeDir, 'cgroup.events'), 'utf8');
          probe.cgroupBase = base;
        } finally {
          rmdirSync(probeDir);
        }
      }
    } catch {
      probe.cgroupBase = null;
    }
    probe.nsdelegate = nsdelegateMounted();
  }
  cached = probe;
  return probe;
}

/** Owner uid of a cgroup directory (who may migrate processes within it), or null when unknown. */
export function cgroupOwner(dir: string): number | null {
  try {
    return statSync(join(dir, 'cgroup.procs')).uid;
  } catch {
    return null;
  }
}

/** Result of probing whether an identity can move processes out of (or create cgroups in) a cgroup base. */
export interface CgroupMigrationProbe {
  /** True when the identity can (or might: unknown is treated as yes) migrate a process out of the run cgroup. */
  migratable: boolean;
  /** cgroup.procs files (base and every ancestor) the identity could write. */
  writable: string[];
  /** The identity could create a subgroup directly under the base (delegation). */
  subgroup: boolean;
  /** Why; 'unknown' results say what could not be established. */
  reason: string;
}

/** The identity whose migration rights are probed: a dropped uid/gid (via setpriv), or this process itself. */
export type MigrationIdentity = { uid: number; gid: number; setpriv: string } | { self: true };

/** base/cgroup.procs and every ancestor's cgroup.procs up to the cgroup2 root (or the filesystem root). */
function procsChain(base: string): string[] {
  const out: string[] = [];
  for (let d = base; ; d = dirname(d)) {
    out.push(join(d, 'cgroup.procs'));
    if (d === CGROUP_FS || dirname(d) === d || out.length > 64) break;
  }
  return out;
}

const PROBE_SCRIPT = [
  'd=$1; shift',
  'if mkdir "$d" 2>/dev/null; then echo S; rmdir "$d" 2>/dev/null; fi',
  'for f in "$@"; do',
  '  if [ ! -e "$f" ]; then echo "M $f"; continue; fi',
  // The probe sits in a cgroup BELOW the base, so the file opened for f is the common ancestor's own
  // cgroup.procs: an open refused with EACCES/EPERM is exactly "may not migrate there". Anything else
  // (moved, EBUSY, I/O error, ...) counts as writable (fail closed).
  '  if e=$( { echo $$ > "$f"; } 2>&1 ); then echo "W $f"; continue; fi',
  '  case "$e" in *"cannot create"*"Permission denied"*|*"cannot create"*"Operation not permitted"*) echo "D $f";; *) echo "W $f";; esac',
  'done',
  'echo END',
].join('\n');

/** Admit the root probe shell to a cgroup, then exec the rest (the identity drop). */
const PROBE_GATE = 'cg=$1; shift; echo $$ > "$cg/cgroup.procs" || exit 97; exec "$@"';

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function rmdirRetry(dir: string, attempts = 20): void {
  for (let i = 0; i < attempts; i++) {
    try {
      rmdirSync(dir);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      sleepSync(10);
    }
  }
}

/**
 * Establish, by trying, whether `who` can migrate a process out of a per-run cgroup created under `base`
 * (Codex sprint-3 sandbox finding 6: owner inequality is not non-writability; mode bits, the gid and ACLs
 * decide). Moving a process from the run cgroup to any cgroup outside it needs write access to the
 * cgroup.procs of their common ancestor, which is `base` or one of its ancestors. For a dropped identity a
 * short probe shell is admitted (as root) to a fresh probe cgroup under `base`, drops to exactly the verify
 * identity (uid/gid, no supplementary groups, no capabilities), and then actually writes its own pid into
 * each of those files and tries to create a subgroup under `base`. Only an open refused with "Permission
 * denied"/"Operation not permitted" counts as not writable; every other outcome (moved, EBUSY, a missing
 * file, a probe that could not be placed or did not complete) counts as migratable (fail closed). A
 * subgroup the identity can create means the base is delegated to it: also migratable.
 */
export function probeCgroupMigration(base: string, who: MigrationIdentity): CgroupMigrationProbe {
  const files = procsChain(base);
  if ('self' in who) {
    const writable: string[] = [];
    let missing = '';
    for (const f of files) {
      try {
        statSync(f);
      } catch {
        missing ||= f;
        continue;
      }
      try {
        accessSync(f, fsConstants.W_OK);
        writable.push(f);
      } catch {
        /* not writable */
      }
    }
    let subgroup = false;
    try {
      accessSync(base, fsConstants.W_OK);
      subgroup = true;
    } catch {
      /* not writable */
    }
    const migratable = writable.length > 0 || subgroup || missing !== '';
    return { migratable, writable, subgroup, reason: missing ? `unknown: ${missing} is missing` : migratable ? `writable: ${[...writable, ...(subgroup ? [`mkdir ${base}`] : [])].join(', ')}` : 'no cgroup.procs from the base up is writable' };
  }
  const nonce = randomBytes(6).toString('hex');
  const probeCg = join(base, `tecera-wprobe-${nonce}`);
  const subDir = join(base, `tecera-wsub-${nonce}`);
  try {
    mkdirSync(probeCg);
  } catch (e) {
    return { migratable: true, writable: [], subgroup: false, reason: `unknown: cannot create a probe cgroup under ${base} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})` };
  }
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync(
      '/bin/sh',
      ['-c', PROBE_GATE, 'sh', probeCg, who.setpriv, `--reuid=${who.uid}`, `--regid=${who.gid}`, '--clear-groups', '--no-new-privs', '--inh-caps=-all', '--bounding-set=-all', '--', '/bin/sh', '-c', PROBE_SCRIPT, 'sh', subDir, ...files],
      { cwd: '/', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' }, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } finally {
    rmdirRetry(subDir, 1);
    rmdirRetry(probeCg);
  }
  const lines = typeof r.stdout === 'string' ? r.stdout.split('\n') : [];
  if (r.error || r.status !== 0 || !lines.includes('END')) {
    return { migratable: true, writable: [], subgroup: false, reason: `unknown: the migration probe did not complete (${r.error?.message ?? `status ${r.status}`})` };
  }
  const writable = lines.filter((l) => l.startsWith('W ')).map((l) => l.slice(2));
  const missing = lines.filter((l) => l.startsWith('M ')).map((l) => l.slice(2));
  const subgroup = lines.includes('S');
  const migratable = writable.length > 0 || missing.length > 0 || subgroup;
  return {
    migratable,
    writable,
    subgroup,
    reason: missing.length ? `unknown: ${missing.join(', ')} missing` : migratable ? `writable by uid ${who.uid}: ${[...writable, ...(subgroup ? [`mkdir ${base}`] : [])].join(', ')}` : `uid ${who.uid}/gid ${who.gid} cannot write any cgroup.procs from ${base} up, nor create a subgroup`,
  };
}

/** Every live jail of this supervisor (the uid scan never claims another run's processes). */
const liveJails = new Set<Jail>();

/**
 * One run's containment. Create with `open()`, admit the gate pid with `admit()` BEFORE releasing the
 * gate, `reap()` after the command is done (or to cancel it), then `release()`.
 */
export class Jail {
  readonly layers: ContainmentLayer[];
  private cgroupDir: string | null = null;
  private rootPid = 0;
  private ns: string | null = null;
  private readonly known = new Set<number>();
  private readonly escapedSeen = new Set<number>();
  /** Last reap left survivors: the jail stays registered (quarantined) so no other run claims them. */
  private survived = false;
  /** Processes of the uid that existed at open and that no run claims (never killed by this jail). */
  readonly foreign: number[] = [];

  private constructor(
    private readonly probe: ContainmentProbe,
    layers: ContainmentLayer[],
    private readonly uid: number | null,
  ) {
    this.layers = layers;
  }

  /**
   * Create the per-run cgroup when the cgroup layer is available. Throws when creation fails.
   * `opts.uid`: the dedicated uid the command runs as (enables the uid scan); never 0.
   */
  static open(probe: ContainmentProbe, opts: { uid?: number; tag?: string } = {}): Jail {
    const layers: ContainmentLayer[] = [];
    if (probe.cgroupBase) layers.push('cgroup');
    if (probe.pidns && probe.pidns.length) layers.push('pidns');
    layers.push('session');
    const uid = opts.uid !== undefined && Number.isInteger(opts.uid) && opts.uid > 0 ? opts.uid : null;
    if (uid !== null) layers.push('uid');
    if (opts.tag !== undefined && !/^[a-z0-9]{1,24}$/.test(opts.tag)) throw new Error('jail tag must be 1-24 lowercase alphanumerics');
    const j = new Jail(probe, layers, uid);
    if (probe.cgroupBase) {
      const dir = join(probe.cgroupBase, `${VERIFY_CGROUP_PREFIX}${opts.tag ? `${opts.tag}-` : ''}${randomBytes(8).toString('hex')}`);
      mkdirSync(dir);
      j.cgroupDir = dir;
    }
    if (uid !== null) for (const p of uidMembers(uid)) if (!j.claimedElsewhere(p) && p !== process.pid) j.foreign.push(p);
    liveJails.add(j);
    return j;
  }

  /** The run's cgroup directory (null without the cgroup layer or after release). */
  get cgroupPath(): string | null {
    return this.cgroupDir;
  }

  /** argv prefix that runs the command as init of a fresh pid namespace ([] without that layer). */
  get prefix(): string[] {
    return this.layers.includes('pidns') ? [...this.probe.pidns!] : [];
  }

  /** Structural containment: a cgroup or a pid namespace. 'session' alone is degraded. */
  get strong(): boolean {
    return this.layers.includes('cgroup') || this.layers.includes('pidns');
  }

  /** Put the (gated, not yet running) root process into the cgroup. Throws if that fails. */
  admit(pid: number): void {
    this.rootPid = pid;
    this.known.add(pid);
    if (!this.cgroupDir) return;
    writeFileSync(join(this.cgroupDir, 'cgroup.procs'), `${pid}\n`);
    if (!cgroupTreePids(this.cgroupDir).includes(pid)) throw new Error(`pid ${pid} is not in ${this.cgroupDir} after admission`);
  }

  /** Best effort: remember the pid namespace of the command's init so its members can be scanned. */
  async captureNamespace(timeoutMs = 300): Promise<void> {
    if (!this.layers.includes('pidns') || !this.rootPid) return;
    const own = nsLink(process.pid);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !this.ns) {
      for (const pid of listPids()) {
        const s = readProcStat(pid);
        if (s && s.ppid === this.rootPid) {
          const l = nsLink(pid);
          if (l && l !== own) this.ns = l;
        }
      }
      if (!this.ns) await sleep(10);
    }
  }

  /**
   * Structural membership of `pid` in this jail, established now (not from earlier scans): the cgroup
   * subtree, the session/group, the pid namespace, or a pid already seen as a member.
   */
  holds(pid: number): boolean {
    if (this.known.has(pid)) return true;
    if (this.cgroupDir) {
      const cg = procCgroup(pid);
      if (cg && (cg === this.cgroupDir || cg.startsWith(this.cgroupDir + '/'))) return true;
    }
    if (this.ns && nsLink(pid) === this.ns) return true;
    if (this.rootPid > 1) {
      const s = readProcStat(pid);
      if (s && (s.session === this.rootPid || s.pgrp === this.rootPid)) return true;
    }
    return false;
  }

  /** Another run owns `pid`: a structural member of another live jail, or inside another run's verify cgroup. */
  private claimedElsewhere(pid: number): boolean {
    for (const j of liveJails) if (j !== this && j.holds(pid)) return true;
    const cg = procCgroup(pid);
    if (cg && !(this.cgroupDir && (cg === this.cgroupDir || cg.startsWith(this.cgroupDir + '/')))) {
      if (cg.split('/').some((seg) => seg.startsWith(VERIFY_CGROUP_PREFIX))) return true;
    }
    return false;
  }

  /**
   * Every live process of this run (excluding zombies), and which of them have left containment.
   * Throws ContainmentStateError when the cgroup state cannot be read.
   */
  census(): { members: number[]; escaped: number[] } {
    const inCgroup = new Set<number>();
    if (this.cgroupDir) for (const p of cgroupTreePids(this.cgroupDir)) if (readProcStat(p)) inCgroup.add(p);
    const structural = new Set<number>(inCgroup);
    if (this.rootPid) for (const p of sessionMembers(this.rootPid)) structural.add(p);
    if (this.ns) for (const p of namespaceMembers(this.ns)) structural.add(p);
    const all = new Set<number>(structural);
    const escaped = new Set<number>();
    if (this.uid !== null) {
      for (const p of uidMembers(this.uid)) {
        if (structural.has(p)) continue;
        // Uid-only: attribute to this run only if no other run owns it right now, and it is not a
        // process that predates this run (foreign: never killed by this jail).
        if (this.foreign.includes(p) || this.claimedElsewhere(p)) continue;
        all.add(p);
        if (!this.structurallyInside(p)) escaped.add(p);
      }
    }
    // A process forked after the cgroup.procs read shows up in the scans but not in inCgroup: confirm with
    // its own /proc/<pid>/cgroup before calling it an escape.
    if (this.cgroupDir) for (const p of all) if (!inCgroup.has(p) && this.outsideCgroup(p)) escaped.add(p);
    all.delete(process.pid);
    escaped.delete(process.pid);
    for (const p of all) this.known.add(p);
    for (const p of escaped) this.escapedSeen.add(p);
    return { members: [...all], escaped: [...escaped] };
  }

  /** Re-check one pid against the structural layers (it may have been born after the scans). */
  private structurallyInside(pid: number): boolean {
    if (this.cgroupDir && !this.outsideCgroup(pid)) return true;
    if (this.ns && nsLink(pid) === this.ns) return true;
    const s = readProcStat(pid);
    if (!s) return true; // gone: nothing escaped
    return this.rootPid > 1 && (s.session === this.rootPid || s.pgrp === this.rootPid);
  }

  /** True when `pid` is alive and its cgroup is not this jail's cgroup or below it. */
  private outsideCgroup(pid: number): boolean {
    if (!this.cgroupDir) return false;
    let raw: string;
    try {
      raw = readFileSync(`/proc/${pid}/cgroup`, 'utf8');
    } catch {
      return false; // gone
    }
    const line = raw.split('\n').find((l) => l.startsWith('0::'));
    if (!line || !readProcStat(pid)) return false;
    const path = join(CGROUP_FS, line.slice(3).trim());
    return !(path === this.cgroupDir || path.startsWith(this.cgroupDir + '/'));
  }

  /** Every live process of this run (excluding zombies). Throws ContainmentStateError when unreadable. */
  members(): number[] {
    return this.census().members;
  }

  /** Pids seen outside containment so far. */
  get escaped(): number[] {
    return [...this.escapedSeen];
  }

  private killAll(): number {
    let n = 0;
    if (this.cgroupDir) {
      try {
        writeFileSync(join(this.cgroupDir, 'cgroup.kill'), '1');
      } catch {
        /* older kernels: per-pid kill below */
      }
    }
    if (this.rootPid > 1) {
      try {
        process.kill(-this.rootPid, 'SIGKILL');
      } catch {
        /* group gone */
      }
    }
    let pids: number[] = [];
    try {
      pids = this.members();
    } catch {
      /* unreadable: reap reports it */
    }
    for (const p of pids) {
      try {
        process.kill(p, 'SIGKILL');
        n++;
      } catch {
        /* raced */
      }
    }
    return n;
  }

  /** True when the cgroup subtree is empty (or there is no cgroup layer). Throws when unreadable. */
  private cgroupEmpty(): boolean {
    if (!this.cgroupDir) return true;
    return !cgroupPopulated(this.cgroupDir) && cgroupTreePids(this.cgroupDir).length === 0;
  }

  /** SIGKILL everything of this run and wait until nothing remains or the deadline passes. */
  async reap(timeoutMs = 3_000): Promise<ReapResult> {
    const deadline = Date.now() + timeoutMs;
    const killed = new Set<number>();
    let stateError: string | undefined;
    const look = (): number[] | null => {
      try {
        const c = this.census();
        stateError = undefined;
        return c.members;
      } catch (e) {
        stateError = (e as Error).message;
        return null;
      }
    };
    for (const p of look() ?? []) killed.add(p);
    this.killAll();
    for (;;) {
      const left = look();
      let empty = false;
      if (left) {
        for (const p of left) killed.add(p);
        try {
          empty = left.length === 0 && this.cgroupEmpty();
        } catch (e) {
          stateError = (e as Error).message;
        }
      }
      const escaped = this.escaped;
      if (left && empty && !stateError) {
        this.survived = false;
        return { gone: true, survivors: [], killed: killed.size, escaped };
      }
      if (Date.now() >= deadline) {
        this.survived = true;
        return { gone: false, survivors: left ?? [], killed: killed.size, escaped, reason: stateError ? `containment state unreadable: ${stateError}` : 'processes survived SIGKILL' };
      }
      this.killAll();
      await sleep(15);
    }
  }

  /** The last reap could not prove every process gone (the jail stays registered after release). */
  get quarantined(): boolean {
    return this.survived;
  }

  /**
   * Remove the cgroup directory and any nested cgroups (only possible once empty). A jail whose last reap
   * left survivors stays registered, so no other run's uid scan ever claims (or kills) its processes as
   * its own and they stay attributed to this run.
   */
  async release(timeoutMs = 1_000): Promise<boolean> {
    if (!this.survived) liveJails.delete(this);
    if (!this.cgroupDir) return true;
    const dir = this.cgroupDir;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        for (const d of nestedDirs(dir)) {
          try {
            rmdirSync(d);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          }
        }
        rmdirSync(dir);
        this.cgroupDir = null;
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          this.cgroupDir = null;
          return true;
        }
        if (Date.now() >= deadline) return false;
        await sleep(20);
      }
    }
  }
}
