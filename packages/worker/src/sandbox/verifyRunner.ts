import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { makeRedactor, type Json, type Redactor, type VerifyOutcome, type VerifyRequest, type VerifyRunner } from '@tecera/contracts';
import { CappedStream } from './capture.js';
import { cgroupOwner, detectContainment, Jail, probeCgroupMigration, type ContainmentLayer, type ContainmentProbe, type ReapResult } from './contain.js';
import { EnvRefused, scrubEnv } from './env.js';
import { IsolationUnavailable } from './errors.js';
import { detectIsolation, type IsolationProbe } from './profile.js';
import { quarantineWorktree, worktreeQuarantine } from './quarantine.js';

/**
 * Runs the manifest's verify command via `/bin/sh -c`, never in the REPL child and without --permission
 * (test runners need fs and child processes). The command is hostile input.
 *
 * Privilege model (Codex sprint-2 sandbox finding 2). Before anything runs the runner resolves WHO the
 * command runs as and which containment layers it cannot leave ("owning" layers):
 *  - identity 'dropped' (`runAs`, root supervisor + setpriv): the command runs as an unprivileged uid with
 *    every capability gone (`--clear-groups --no-new-privs --inh-caps=-all --bounding-set=-all`). It
 *    cannot write the root-owned per-run cgroup's or any ancestor's cgroup.procs, cannot setns, and every
 *    process with that uid is scanned (uid layer).
 *  - identity 'root': the supervisor is root and no `runAs` was given. REFUSED (IsolationUnavailable)
 *    unless `allowRoot` is set. When allowed, capabilities are dropped and the command gets a cgroup
 *    namespace rooted at its cgroup where available, but it still holds uid 0 (it can write every
 *    root-owned file, including the ledger, and ask privileged daemons to run work outside containment),
 *    so the outcome is always `degraded` with 'uid' missing.
 *  - identity 'supervisor': a non-root supervisor; the command shares its uid ('uid' missing). A cgroup
 *    owned by that same uid (delegation) is migratable and does not own descendants.
 * Owning layers: cgroup when the command can neither write the base cgroup's procs (different owner, not
 * root) nor leave a cgroup namespace (cgroupns + nsdelegate + no capabilities); pidns when the command has
 * no CAP_SYS_ADMIN over the parent namespace (dropped/non-root identity, or root with capabilities
 * dropped). No owning layer refuses construction unless `allowWeakContainment` is set.
 *
 * Degraded reporting is truthful: `degraded.missing` lists every control in VERIFY_CONTROLS that is not in
 * force for this runner (uid, caps, cgroup, pidns, netns).
 *
 * Containment (contain.ts): the command is admitted to a fresh per-run cgroup before it runs (a gate shell
 * blocks on stdin) and runs as init of a fresh pid namespace when the host has them; after the shell
 * exits, on timeout, on cancel and on output overflow, EVERYTHING of the run is SIGKILLed and the runner
 * waits until nothing remains, scanning the cgroup subtree (nested cgroups included), the session, the
 * pid namespace and (dropped identity) the uid.
 *
 * Outcomes are reported, never interpreted, except that a run is never reported as a pass when the
 * supervisor could not prove the run is over and contained. `exitCode: null, cancelled: true, reason`
 * (fail closed) when: a process survived the reap ('descendants survived'), a process escaped containment
 * ('descendant escaped containment'), containment could not be set up or released, or an output stream
 * went over its cap ('output-cap': the process group and the cgroup are killed at once, `truncated: true`).
 * A timeout reports 124 and a cancel 130 so the gate can route "tooling missing or interrupted" to a human;
 * a spawn/config/env refusal reports 127. stdout/stderr are redacted BEFORE they are cut (capture.ts).
 *
 * Sprint-3 lifecycle rules: admission is admitVerifyProfile (shared with preflight and the standalone
 * gate); cgroup ownership is established by a real migration probe, never inferred from the owner uid;
 * a cancel is observed from the first await to the gate release (a cancel during evidence recording means
 * the command never starts); a leader or process that survives SIGKILL settles the run (bounded) as
 * terminal failure with `tainted` and quarantines the cwd (quarantine.ts), and a quarantined cwd is never
 * verified; a stream whose producer was killed or stopped is rendered as interrupted (its trailing token
 * is suppressed); the uid scan never claims another run's processes, and a run refuses beside unclaimed
 * processes of its uid instead of killing them.
 */

export type VerifyControl = 'uid' | 'caps' | 'cgroup' | 'pidns' | 'netns';
export const VERIFY_CONTROLS: readonly VerifyControl[] = Object.freeze(['uid', 'caps', 'cgroup', 'pidns', 'netns']);

export type VerifyIdentity = 'dropped' | 'root' | 'supervisor';

export interface VerifyEvidence {
  kind: 'verify.degraded' | 'verify.escaped' | 'verify.output_cap' | 'verify.cleanup_failed' | 'verify.tainted' | 'verify.uid_foreign';
  body: Json;
}

export interface ProcessVerifyRunnerOptions {
  /** Bytes kept per stream. Going over it kills the run (fail closed, reason 'output-cap'). Default 1 MiB. */
  maxOutputBytes?: number;
  /** Run inside a fresh network namespace (no network, loopback down). Throws IsolationUnavailable when absent. */
  netns?: boolean;
  probe?: IsolationProbe;
  /** Injected containment probe (tests). Default: detectContainment(). */
  containment?: ContainmentProbe;
  /** Run the command as this unprivileged uid/gid (root supervisor + setpriv required). The cwd must be readable by it. */
  runAs?: { uid: number; gid: number };
  /** Explicitly permit running the command as root (root supervisor, no runAs). Always degraded ('uid' missing). */
  allowRoot?: boolean;
  /**
   * Permit a runner with no owning layer (no cgroup and no pid namespace the command cannot leave).
   * Outcomes then carry `degraded`. Default false: the constructor throws IsolationUnavailable instead.
   */
  allowWeakContainment?: boolean;
  /** Evidence sink: degraded runs are recorded before the command starts; a failing sink refuses the run. */
  onEvidence?: (e: VerifyEvidence) => void | Promise<void>;
  /** Grace after the shell exits for straggling stdout holders, after they were killed. Default 2 s. */
  drainMs?: number;
  /** Deadline for the reap (kill + wait until nothing remains). Default 3 s. */
  reapMs?: number;
  /** Redactor for stdout/stderr (secret patterns are always redacted). */
  redactor?: Redactor;
  /** Bound on waiting for the evidence sink. Default 5 s. A sink that does not settle refuses (before) or is reported (after). */
  evidenceTimeoutMs?: number;
  /**
   * Tag (1-24 lowercase alphanumerics) put into this runner's per-run cgroup names
   * (`tecera-verify-<tag>-<random>`), so a caller can find exactly the cgroups it created.
   */
  cgroupTag?: string;
  /** Test seam: rewrite the reap result (e.g. to simulate a failed cleanup). Never set in production. */
  testReapOverride?: (r: ReapResult) => ReapResult;
  /** Test seam: replace child_process.spawn (e.g. a leader that never emits 'exit'). Never set in production. */
  testSpawn?: typeof spawn;
  /** Test seams for admission (see VerifyHostEnv). Never set in production. */
  testHost?: Pick<VerifyHostEnv, 'euid' | 'cgroupOwnerUid' | 'cgroupMigratable'>;
}

export interface VerifyOutcomeExt extends VerifyOutcome {
  /** True when either stream hit the byte cap. */
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  cancelled: boolean;
  /** Allowlisted names outside SANDBOX_SAFE_ENV that were dropped (names only). */
  envDropped: string[];
  isolation: 'netns' | 'none';
  /** Containment layers that were applied. */
  containment: ContainmentLayer[];
  /** Layers the command cannot leave under its identity. */
  owning: ContainmentLayer[];
  identity: VerifyIdentity;
  /** True only when the reap proved that no process of the run remains. */
  gone: boolean;
  /** Processes of the run still alive when the shell exited (all killed before reporting, if `gone`). */
  stragglers: number;
  /** Processes found outside containment (killed; any escape makes the outcome fail closed). */
  escaped: number;
  /** Why the outcome is fail-closed (exitCode null) or refused (127). */
  reason?: string;
  /**
   * Something of the run could not be proven gone (a process, possibly the leader itself, survived SIGKILL).
   * The outcome is terminal (exitCode null, cancelled) and the worktree must be treated as tainted.
   */
  tainted?: { reason: string; processes: number[] };
  degraded?: { reason: string; missing: VerifyControl[] };
}

export const VERIFY_TIMEOUT_EXIT = 124;
export const VERIFY_CANCEL_EXIT = 130;
export const VERIFY_SPAWN_EXIT = 127;
export const VERIFY_OUTPUT_CAP = 'output-cap';

/** Gate: block until the supervisor has admitted this pid to the cgroup, then run the command. */
const GATE = 'IFS= read -r go || exit 125; [ "$go" = go ] || exit 125; exec </dev/null; exec "$0" "$@"';

export interface ResolvedVerifyPolicy {
  identity: VerifyIdentity;
  uid: number;
  idPrefix: string[];
  cgroupnsPrefix: string[];
  applied: VerifyControl[];
  missing: VerifyControl[];
  owning: ContainmentLayer[];
  notes: string[];
}

function geteuid(): number {
  return typeof process.geteuid === 'function' ? process.geteuid() : -1;
}

/** Resolve identity, controls and owning layers. Throws IsolationUnavailable for refused configurations. */
export function resolveVerifyPolicy(
  c: ContainmentProbe,
  opts: {
    runAs?: { uid: number; gid: number };
    allowRoot?: boolean;
    netns: boolean;
    euid?: number;
    /** Owner of the base cgroup.procs (injected in tests). Equal to the command uid: delegation, migratable. */
    cgroupOwnerUid?: number | null;
    /**
     * Whether the command identity can migrate out of the run cgroup (injected in tests). Default: when the
     * owner differs, established by actually trying (probeCgroupMigration), never inferred from the owner.
     */
    cgroupMigratable?: boolean;
  },
): ResolvedVerifyPolicy {
  const euid = opts.euid ?? geteuid();
  const setpriv = c.setpriv ?? null;
  const notes: string[] = [];
  let identity: VerifyIdentity;
  let uid: number;
  let gid = -1;
  let idPrefix: string[] = [];
  let capsDropped = false;
  if (opts.runAs) {
    const { uid: u, gid: g } = opts.runAs;
    if (!Number.isInteger(u) || !Number.isInteger(g) || u <= 0 || g <= 0) throw new IsolationUnavailable('verify runAs needs a non-root uid and gid (positive integers)');
    if (euid !== 0) throw new IsolationUnavailable('verify runAs needs a root supervisor to switch uid');
    if (u === euid) throw new IsolationUnavailable('verify runAs must differ from the supervisor uid');
    if (!setpriv) throw new IsolationUnavailable('verify runAs needs setpriv, which is not usable on this host');
    identity = 'dropped';
    uid = u;
    gid = g;
    idPrefix = [setpriv, `--reuid=${u}`, `--regid=${g}`, '--clear-groups', '--no-new-privs', '--inh-caps=-all', '--bounding-set=-all', '--'];
    capsDropped = true;
  } else if (euid === 0) {
    if (!opts.allowRoot) {
      throw new IsolationUnavailable(
        'verify would run as root (uid 0): a root command can leave its cgroup, rewrite supervisor files and start work outside containment. Pass runAs {uid, gid} (an unprivileged uid that can read the worktree) or allowRoot (degraded)',
      );
    }
    identity = 'root';
    uid = 0;
    if (setpriv) {
      idPrefix = [setpriv, '--no-new-privs', '--inh-caps=-all', '--bounding-set=-all', '--'];
      capsDropped = true;
    } else notes.push('setpriv unavailable: root keeps its capabilities');
  } else {
    identity = 'supervisor';
    uid = euid;
    if (setpriv) idPrefix = [setpriv, '--no-new-privs', '--'];
    capsDropped = true; // a non-root supervisor holds no capabilities; no_new_privs keeps it that way when setpriv exists
    if (!setpriv) notes.push('setpriv unavailable: no_new_privs not set');
  }
  const cgroupnsPrefix = euid === 0 && c.cgroupBase && c.cgroupns && c.cgroupns.length ? [...c.cgroupns] : [];
  const owning: ContainmentLayer[] = [];
  if (c.cgroupBase) {
    const nsBound = cgroupnsPrefix.length > 0 && c.nsdelegate === true && capsDropped;
    let cannotMigrate = false;
    if (nsBound) {
      /* the cgroup namespace bounds migration whatever the permissions */
    } else if (uid === 0) notes.push('cgroup: a root command can migrate out of it');
    else {
      const owner = opts.cgroupOwnerUid !== undefined ? opts.cgroupOwnerUid : cgroupOwner(c.cgroupBase);
      if (owner === uid) notes.push(`cgroup: owned by the command's own uid ${uid} (delegation), so the command can migrate out of it`);
      else {
        // Owner inequality proves nothing (group/other mode bits and ACLs): establish it by trying.
        const m =
          opts.cgroupMigratable !== undefined
            ? { migratable: opts.cgroupMigratable, reason: opts.cgroupMigratable ? 'migratable (given)' : 'not migratable (given)' }
            : probeCgroupMigration(c.cgroupBase, identity === 'dropped' && setpriv ? { uid, gid, setpriv } : { self: true });
        cannotMigrate = !m.migratable;
        if (m.migratable) notes.push(`cgroup: uid ${uid} can migrate out of it (${m.reason})`);
      }
    }
    if (nsBound || cannotMigrate) owning.push('cgroup');
  }
  if (c.pidns && c.pidns.length) {
    if (uid !== 0 || capsDropped) owning.push('pidns');
    else notes.push('pidns: a root command with CAP_SYS_ADMIN can act outside it');
  }
  const applied: VerifyControl[] = [];
  if (identity === 'dropped') applied.push('uid');
  if (capsDropped && (identity !== 'supervisor' || setpriv)) applied.push('caps');
  if (owning.includes('cgroup')) applied.push('cgroup');
  if (owning.includes('pidns')) applied.push('pidns');
  if (opts.netns) applied.push('netns');
  const missing = VERIFY_CONTROLS.filter((x) => !applied.includes(x));
  if (identity === 'root') notes.unshift('runs as root (uid 0): can write supervisor files and start work outside containment');
  if (identity === 'supervisor') notes.unshift(`runs as the supervisor's own uid ${uid}: can signal and rewrite the supervisor's processes and files`);
  return { identity, uid, idPrefix, cgroupnsPrefix, applied, missing, owning, notes };
}

/** What a verify configuration asks for (the manifest/runtime side of admission). */
export interface VerifyProfile {
  /** Run the command as this unprivileged uid/gid (root supervisor + setpriv required). */
  runAs?: { uid: number; gid: number };
  /** Explicitly accept a root verify (degraded, 'uid' missing). */
  allowRoot?: boolean;
  /** Require a fresh network namespace. */
  netns?: boolean;
  /** Accept a runner with no owning containment layer (degraded). */
  allowWeakContainment?: boolean;
}

/** The host side of admission. Every field defaults to what this host really offers. */
export interface VerifyHostEnv {
  euid?: number;
  /** Containment probe. Default detectContainment(). */
  containment?: ContainmentProbe;
  /** Isolation probe (netns wrapper). Default detectIsolation(). */
  isolation?: IsolationProbe;
  /** Test seams, see resolveVerifyPolicy. */
  cgroupOwnerUid?: number | null;
  cgroupMigratable?: boolean;
}

export type VerifyAdmission =
  | {
      admitted: true;
      identity: VerifyIdentity;
      owning: ContainmentLayer[];
      applied: VerifyControl[];
      missing: VerifyControl[];
      /** Present when any control in VERIFY_CONTROLS is not in force. */
      degraded?: { reason: string; missing: VerifyControl[] };
      notes: string[];
      netnsPrefix: string[];
      containment: ContainmentProbe;
      policy: ResolvedVerifyPolicy;
    }
  | { admitted: false; reason: string };

/**
 * The one set of verify admission rules (Codex sprint-3 next step 7). ProcessVerifyRunner's constructor
 * applies exactly this; preflight and the standalone gate call it to decide (and to explain) whether the
 * verify command may run on this host under `profile`, before anything runs. Never throws: a refused
 * profile is `{admitted: false, reason}`. Refused: root without runAs/allowRoot; an invalid runAs (uid 0,
 * the supervisor's uid, no setpriv, non-root supervisor); netns requested but unavailable; no owning
 * containment layer (no cgroup the identity cannot migrate out of, and no pid namespace it cannot leave)
 * unless allowWeakContainment.
 */
export function admitVerifyProfile(profile: VerifyProfile, env: VerifyHostEnv = {}): VerifyAdmission {
  try {
    let netnsPrefix: string[] = [];
    if (profile.netns) {
      const iso = env.isolation ?? detectIsolation();
      if (!iso.netns) return { admitted: false, reason: 'verify netns requested but unshare -n is not usable on this host' };
      netnsPrefix = [...iso.netns];
    }
    const containment = env.containment ?? detectContainment();
    const policy = resolveVerifyPolicy(containment, {
      ...(profile.runAs ? { runAs: profile.runAs } : {}),
      allowRoot: profile.allowRoot === true,
      netns: netnsPrefix.length > 0,
      ...(env.euid !== undefined ? { euid: env.euid } : {}),
      ...(env.cgroupOwnerUid !== undefined ? { cgroupOwnerUid: env.cgroupOwnerUid } : {}),
      ...(env.cgroupMigratable !== undefined ? { cgroupMigratable: env.cgroupMigratable } : {}),
    });
    if (policy.owning.length === 0 && profile.allowWeakContainment !== true) {
      return {
        admitted: false,
        reason: `verify containment cannot own the command's descendants under identity '${policy.identity}' (${policy.notes.join('; ') || 'no cgroup and no pid namespace'}). Pass allowWeakContainment to run degraded`,
      };
    }
    const degraded = policy.missing.length
      ? {
          reason: `verify controls missing: ${policy.missing.join(', ')}${policy.owning.length ? '' : ' (no owning containment layer: a descendant can outlive the run)'}${policy.notes.length ? `; ${policy.notes.join('; ')}` : ''}`,
          missing: [...policy.missing],
        }
      : undefined;
    return {
      admitted: true,
      identity: policy.identity,
      owning: [...policy.owning],
      applied: [...policy.applied],
      missing: [...policy.missing],
      ...(degraded ? { degraded } : {}),
      notes: [...policy.notes],
      netnsPrefix,
      containment,
      policy,
    };
  } catch (e) {
    if (e instanceof IsolationUnavailable) return { admitted: false, reason: e.message };
    return { admitted: false, reason: `verify admission failed: ${(e as Error)?.message ?? String(e)}` };
  }
}

/** Can `uid`/`gid` (no supplementary groups) traverse every ancestor of `dir` and list `dir`? */
async function accessibleTo(dir: string, uid: number, gid: number): Promise<string | null> {
  const can = (st: { uid: number; gid: number; mode: number }, bits: number): boolean => {
    const cls = st.uid === uid ? (st.mode >> 6) & 7 : st.gid === gid ? (st.mode >> 3) & 7 : st.mode & 7;
    return (cls & bits) === bits;
  };
  try {
    const own = await stat(dir);
    if (!can(own, 5)) return `${dir} is not readable by uid ${uid}`;
    for (let d = dirname(dir); ; d = dirname(d)) {
      const st = await stat(d);
      if (!can(st, 1)) return `${d} is not traversable by uid ${uid}`;
      if (dirname(d) === d) return null;
    }
  } catch (e) {
    return `cannot check access: ${(e as Error).message}`;
  }
}

type RecordResult = { ok: true } | { failed: string } | { cancelled: true };

interface RawRun {
  code: number | null;
  sig: NodeJS.Signals | null;
  spawnError?: string;
  timedOut: boolean;
  cancelled: boolean;
  overflow: boolean;
  stragglers: number;
  reap: ReapResult;
  setupFailure?: string;
  /** The pipes closed normally after the shell exited. */
  closed: boolean;
  /** The leader never reported its exit after the reap (it may still be alive). */
  leaderStuck: boolean;
}

export class ProcessVerifyRunner implements VerifyRunner {
  private readonly netnsPrefix: string[];
  private readonly containment: ContainmentProbe;
  private readonly redactor: Redactor;
  private readonly policy: ResolvedVerifyPolicy;
  /** Controls not in force, and why (undefined when every control in VERIFY_CONTROLS applies). */
  readonly degraded: { reason: string; missing: VerifyControl[] } | undefined;

  constructor(private readonly opts: ProcessVerifyRunnerOptions = {}) {
    // The same admission rules preflight and the standalone gate use (admitVerifyProfile).
    const a = admitVerifyProfile(
      {
        ...(opts.runAs ? { runAs: opts.runAs } : {}),
        allowRoot: opts.allowRoot === true,
        netns: opts.netns === true,
        allowWeakContainment: opts.allowWeakContainment === true,
      },
      { ...(opts.containment ? { containment: opts.containment } : {}), ...(opts.probe ? { isolation: opts.probe } : {}), ...(opts.testHost ?? {}) },
    );
    if (!a.admitted) throw new IsolationUnavailable(a.reason);
    if (opts.cgroupTag !== undefined && !/^[a-z0-9]{1,24}$/.test(opts.cgroupTag)) throw new IsolationUnavailable('verify cgroupTag must be 1-24 lowercase alphanumerics');
    this.netnsPrefix = a.netnsPrefix;
    this.containment = a.containment;
    this.policy = a.policy;
    this.degraded = a.degraded;
    this.redactor = opts.redactor ?? makeRedactor([]);
  }

  get identity(): VerifyIdentity {
    return this.policy.identity;
  }

  get owning(): ContainmentLayer[] {
    return [...this.policy.owning];
  }

  /**
   * Record evidence, bounded by evidenceTimeoutMs. With `signal`, a cancel during the wait is honoured: the
   * result is `cancelled` (the caller then never starts the command). Never rejects.
   */
  private record(e: VerifyEvidence, signal?: AbortSignal): Promise<RecordResult> {
    const sink = this.opts.onEvidence;
    if (!sink) return Promise.resolve({ ok: true });
    if (signal?.aborted) return Promise.resolve({ cancelled: true });
    const limit = this.opts.evidenceTimeoutMs ?? 5_000;
    return new Promise<RecordResult>((resolve) => {
      let done = false;
      const finish = (r: RecordResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(r);
      };
      const onAbort = () => finish({ cancelled: true });
      const timer = setTimeout(() => finish({ failed: `evidence sink did not settle within ${limit} ms (${e.kind})` }), limit);
      signal?.addEventListener('abort', onAbort, { once: true });
      let body: Json;
      try {
        body = this.redactor.redactJson(e.body);
      } catch (err) {
        finish({ failed: `evidence redaction failed (${e.kind})` });
        return;
      }
      Promise.resolve()
        .then(() => sink({ kind: e.kind, body }))
        .then(
          () => finish({ ok: true }),
          (err: unknown) => finish({ failed: this.redactor.redactText(`evidence sink failed (${e.kind}): ${(err as Error)?.message ?? String(err)}`, { maxChars: 500 }) }),
        );
    });
  }

  async run(req: VerifyRequest, signal?: AbortSignal): Promise<VerifyOutcomeExt> {
    const started = Date.now();
    const max = this.opts.maxOutputBytes ?? 1024 * 1024;
    const degraded = this.degraded;
    const base = {
      stdoutTruncated: false,
      stderrTruncated: false,
      cancelled: false,
      envDropped: [] as string[],
      isolation: this.netnsPrefix.length ? ('netns' as const) : ('none' as const),
      containment: [] as ContainmentLayer[],
      owning: [...this.policy.owning],
      identity: this.policy.identity,
      gone: true,
      stragglers: 0,
      escaped: 0,
      ...(degraded ? { degraded: { reason: degraded.reason, missing: [...degraded.missing] } } : {}),
    };
    const early = (reason: string, exitCode: number | null, cancelled = false): VerifyOutcomeExt => ({
      ...base,
      exitCode,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: this.redactor.redactText(reason),
      durationMs: Date.now() - started,
      truncated: false,
      cancelled,
      reason: this.redactor.redactText(reason),
    });
    const aborted = (): boolean => signal?.aborted === true;
    let env: Record<string, string>;
    try {
      const s = scrubEnv(req.envAllowlist ?? [], process.env);
      env = s.env;
      base.envDropped = s.dropped;
    } catch (e) {
      if (e instanceof EnvRefused) return early(`env refused: ${e.names.join(', ')}`, VERIFY_SPAWN_EXIT);
      return early(`env construction failed: ${(e as Error).message}`, VERIFY_SPAWN_EXIT);
    }
    if (typeof req.command !== 'string' || !req.command.trim()) return early('verify command is empty', VERIFY_SPAWN_EXIT);
    if (!isAbsolute(req.cwd ?? '')) return early(`verify cwd must be absolute: ${req.cwd}`, VERIFY_SPAWN_EXIT);
    try {
      if (!(await stat(req.cwd)).isDirectory()) return early(`verify cwd is not a directory: ${req.cwd}`, VERIFY_SPAWN_EXIT);
    } catch {
      return early(`verify cwd does not exist: ${req.cwd}`, VERIFY_SPAWN_EXIT);
    }
    if (!(req.timeoutSec > 0)) return early('verify timeoutSec must be > 0', VERIFY_SPAWN_EXIT);
    // A worktree something abandoned may still be writing is never verified (quarantine.ts).
    const wt = worktreeQuarantine(req.cwd);
    if (wt) return { ...early(`worktree tainted: ${wt.source} work on it was left unresolved (${wt.reason}); not verified`, null, true), tainted: { reason: wt.reason, processes: [...wt.processes] } };
    if (this.opts.runAs) {
      const problem = await accessibleTo(req.cwd, this.opts.runAs.uid, this.opts.runAs.gid);
      if (problem) return early(`verify cwd not accessible to the verify identity: ${problem}`, VERIFY_SPAWN_EXIT);
    }
    // Cancellation is re-checked after every await below and observed during the evidence wait itself
    // (Codex sprint-3 sandbox finding 4): a cancel can never be lost between setup and spawn.
    if (aborted()) return early('verify cancelled before start', VERIFY_CANCEL_EXIT, true);
    if (degraded) {
      const rec = await this.record({ kind: 'verify.degraded', body: { identity: this.policy.identity, missing: [...degraded.missing], owning: [...this.policy.owning], reason: degraded.reason, command: req.command, cwd: req.cwd } }, signal);
      if ('cancelled' in rec || aborted()) return early('verify cancelled while recording degraded evidence; the command never ran', VERIFY_CANCEL_EXIT, true);
      if ('failed' in rec) return early(`degraded verify refused: ${rec.failed}`, VERIFY_SPAWN_EXIT);
    }

    let jail: Jail;
    try {
      jail = Jail.open(this.containment, { ...(this.policy.identity === 'dropped' ? { uid: this.policy.uid } : {}), ...(this.opts.cgroupTag ? { tag: this.opts.cgroupTag } : {}) });
    } catch (e) {
      return early(`containment setup failed: ${(e as Error).message}`, null, true);
    }
    let released = false;
    const release = async (): Promise<boolean> => {
      released = true;
      return jail.release();
    };
    try {
      // The uid scan can only attribute processes to this run when the uid is exclusive to tecera runs:
      // refuse beside unclaimed processes of that uid (they are never killed).
      if (jail.foreign.length) {
        await release();
        await this.record({ kind: 'verify.uid_foreign', body: { uid: this.policy.uid, count: jail.foreign.length } });
        return early(`verify uid ${this.policy.uid} is not exclusive: ${jail.foreign.length} process(es) of that uid run outside any verify run (not killed); refusing`, null, true);
      }
      if (aborted()) {
        await release();
        return early('verify cancelled before start', VERIFY_CANCEL_EXIT, true);
      }
      base.containment = [...jail.layers];
      const inner = [...this.netnsPrefix, ...jail.prefix, ...this.policy.cgroupnsPrefix, ...this.policy.idPrefix, '/bin/sh', '-c', req.command];
      const out = new CappedStream(max);
      const err = new CappedStream(max);
      const raw = await this.execute(req, jail, inner, env, out, err, signal);
      // Cleanup is part of the outcome: an unremovable cgroup means something of the run may remain.
      const releasedOk = await release();
      // A producer that was killed or stopped may have been cut mid-token (capture.ts).
      const interrupted = raw.timedOut || raw.cancelled || raw.overflow || raw.stragglers !== 0 || !!raw.spawnError || !!raw.setupFailure || raw.leaderStuck || !raw.closed;
      if (interrupted) {
        out.interrupt();
        err.interrupt();
      }
      const so = out.render(this.redactor);
      const se = err.render(this.redactor);
      const k = raw.reap;
      const escaped = [...new Set([...(k.escaped ?? []), ...jail.escaped])];
      const common = {
        ...base,
        signal: raw.sig,
        timedOut: raw.timedOut,
        stdout: so.text,
        stderr: raw.spawnError ? this.redactor.redactText(`${se.text}spawn failed: ${raw.spawnError}`) : se.text,
        durationMs: Date.now() - started,
        truncated: so.truncated || se.truncated,
        stdoutTruncated: so.truncated,
        stderrTruncated: se.truncated,
        gone: k.gone && releasedOk && !raw.leaderStuck,
        stragglers: Math.max(0, raw.stragglers),
        escaped: escaped.length,
      };
      const note = (r: RecordResult): string => ('failed' in r ? ` (evidence not recorded: ${r.failed})` : '');
      const failClosed = (reason: string, extra: Partial<VerifyOutcomeExt> = {}): VerifyOutcomeExt => ({ ...common, exitCode: null, cancelled: true, ...extra, reason: this.redactor.redactText(reason) });
      if (!k.gone || raw.leaderStuck) {
        const processes = [...new Set([...k.survivors, ...(raw.leaderStuck && raw.leaderPid ? [raw.leaderPid] : [])])];
        const why = raw.leaderStuck
          ? `verify leader did not exit after SIGKILL${k.gone ? '' : ` and ${k.survivors.length} process(es) survived`}${k.reason ? ` (${k.reason})` : ''}`
          : `descendants survived: ${k.survivors.length} process(es) of the verify run could not be killed${k.reason ? ` (${k.reason})` : ''}`;
        quarantineWorktree(req.cwd, { source: 'verify', reason: why, outstanding: [], processes });
        const rec = await this.record({ kind: 'verify.tainted', body: { reason: why, processes, cgroup: jail.cgroupPath ?? null, cwd: req.cwd } });
        return failClosed(`${why}; the worktree is tainted${note(rec)}`, { tainted: { reason: why, processes } });
      }
      if (!releasedOk) {
        const rec = await this.record({ kind: 'verify.cleanup_failed', body: { cgroup: jail.cgroupPath ?? null } });
        return failClosed(`containment cleanup failed: the run cgroup could not be removed${note(rec)}`);
      }
      if (escaped.length) {
        const rec = await this.record({ kind: 'verify.escaped', body: { escaped: escaped.length, layers: [...jail.layers], identity: this.policy.identity } });
        return failClosed(`descendant escaped containment: ${escaped.length} process(es) left the run's cgroup/namespace/session (killed)${note(rec)}`);
      }
      if (raw.setupFailure) return failClosed(raw.setupFailure);
      if (raw.overflow) {
        await this.record({ kind: 'verify.output_cap', body: { maxOutputBytes: max, stdoutBytes: out.seen, stderrBytes: err.seen } });
        return { ...common, exitCode: null, cancelled: true, truncated: true, reason: VERIFY_OUTPUT_CAP };
      }
      if (raw.stragglers < 0) return failClosed('containment state unreadable after exit');
      const exitCode = raw.spawnError ? VERIFY_SPAWN_EXIT : raw.timedOut ? VERIFY_TIMEOUT_EXIT : raw.cancelled ? VERIFY_CANCEL_EXIT : raw.code;
      const reason = raw.spawnError ? 'spawn failed' : raw.timedOut ? 'timed out' : raw.cancelled ? 'cancelled' : undefined;
      return { ...common, exitCode, cancelled: raw.cancelled, ...(reason ? { reason } : {}) };
    } finally {
      if (!released) await jail.release().catch(() => false);
    }
  }

  /**
   * Spawn the gated shell, admit it, release the gate and wait for the run to end. Settles on exactly one
   * of: the shell's exit (+ pipes closed, bounded), a spawn error, or (when the leader never reports its
   * exit) a bounded wait after the reap (Codex sprint-3 sandbox finding 3). Never pending forever.
   */
  private execute(req: VerifyRequest, jail: Jail, inner: string[], env: Record<string, string>, out: CappedStream, err: CappedStream, signal: AbortSignal | undefined): Promise<RawRun & { leaderPid?: number }> {
    const drainMs = this.opts.drainMs ?? 2_000;
    const spawnFn = this.opts.testSpawn ?? spawn;
    return new Promise<RawRun & { leaderPid?: number }>((resolve) => {
      let timedOut = false;
      let cancelled = false;
      let overflow = false;
      let settled = false;
      let exited = false;
      let stragglers = 0;
      let reaping: Promise<ReapResult> | undefined;
      let setupFailure: string | undefined;
      let child: ChildProcess | undefined;
      const timers: NodeJS.Timeout[] = [];
      const reap = (): Promise<ReapResult> => {
        if (!reaping) {
          reaping = jail
            .reap(this.opts.reapMs ?? 3_000)
            .catch((e: unknown): ReapResult => ({ gone: false, survivors: [], killed: 0, reason: `reap failed: ${(e as Error)?.message ?? String(e)}` }))
            .then((r) => (this.opts.testReapOverride ? this.opts.testReapOverride(r) : r));
          // Whatever happens to the leader's events, the run settles a bounded time after the reap.
          void reaping.then((k) => {
            if (settled) return;
            // The leader's exit (if it comes) is handled by the exit handler's own bounded drain.
            timers.push(setTimeout(() => !exited && settle({ code: null, sig: null, closed: false, leaderStuck: true }, k), drainMs));
          });
        }
        return reaping;
      };
      const onAbort = () => {
        cancelled = true;
        void reap();
      };
      const cleanup = () => {
        for (const t of timers) clearTimeout(t);
        signal?.removeEventListener('abort', onAbort);
        if (child) {
          child.stdout?.removeAllListeners('data');
          child.stderr?.removeAllListeners('data');
          try {
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.stdin?.destroy();
          } catch {
            /* already closed */
          }
          child.unref?.();
        }
      };
      const settle = (r: { code: number | null; sig: NodeJS.Signals | null; spawnError?: string; closed: boolean; leaderStuck: boolean }, k: ReapResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ ...r, timedOut, cancelled, overflow, stragglers, reap: k, ...(setupFailure ? { setupFailure } : {}), ...(child?.pid ? { leaderPid: child.pid } : {}) });
      };
      const finish = (code: number | null, sig: NodeJS.Signals | null, closed: boolean, spawnError?: string) => {
        if (settled) return;
        void reap().then((k) => settle({ code, sig, closed, leaderStuck: false, ...(spawnError ? { spawnError } : {}) }, k));
      };
      // Registered before the spawn: a cancel at any point from here on reaps the run.
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        child = spawnFn('/bin/sh', ['-c', GATE, ...inner], { cwd: req.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (e) {
        finish(null, null, false, (e as Error).message);
        return;
      }
      const c = child;
      timers.push(
        setTimeout(() => {
          timedOut = true;
          void reap();
        }, Math.round(req.timeoutSec * 1000)),
      );
      const onData = (s: CappedStream) => (b: Buffer) => {
        // Output cap: kill the process group AND the cgroup at once; the outcome can never pass.
        if (s.push(b) && !overflow) {
          overflow = true;
          void reap();
        }
      };
      c.stdin?.on('error', () => undefined);
      c.stdout?.on('data', onData(out));
      c.stderr?.on('data', onData(err));
      c.stdout?.on('error', () => undefined);
      c.stderr?.on('error', () => undefined);
      c.on('error', (e) => finish(null, null, false, e.message));
      c.on('exit', (code, sig) => {
        exited = true;
        // The shell is done. Count what it left behind, kill all of it (so held-open pipes close), then
        // wait for the pipes to close, bounded.
        try {
          stragglers = jail.members().filter((p) => p !== c.pid).length;
        } catch {
          stragglers = -1; // unreadable: the reap reports it
        }
        void reap();
        const drain = setTimeout(() => finish(code, sig, false), drainMs);
        timers.push(drain);
        c.once('close', () => {
          clearTimeout(drain);
          finish(code, sig, true);
        });
      });
      if (!c.pid) return; // 'error' follows
      try {
        jail.admit(c.pid);
      } catch (e) {
        setupFailure = `containment setup failed: ${(e as Error).message}`;
        void reap();
        return;
      }
      // Last check before the gate opens: a cancel that already happened never lets the command start.
      if (signal?.aborted) {
        onAbort();
        return;
      }
      c.stdin?.end('go\n');
      void jail.captureNamespace();
    });
  }
}
