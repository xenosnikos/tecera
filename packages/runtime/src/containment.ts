import type { Redactor, VerifyOutcome, VerifyRequest, VerifyRunner } from '@tecera/contracts';
import { IsolationUnavailable, ProcessVerifyRunner } from '@tecera/worker';
import type { Env } from './util/proc.js';

/**
 * The ONE admission point for running repository code as a verification check (security.md §5): `tecera
 * run` (baseline, worker runVerify, verify gates), `tecera preflight` (baseline) and `tecera gate` all get
 * their runner here, under the same rules:
 *
 * - the sandbox lane's ProcessVerifyRunner: the command is admitted to an owned containment (cgroup / pid
 *   namespace) before it runs, its whole tree is reaped, its env is the scrubbed allowlist, no network
 *   (fresh network namespace), output capped, timeout enforced;
 * - never as root unless the operator names an unprivileged identity (TECERA_VERIFY_UID/GID) or explicitly
 *   accepts a degraded root verify (TECERA_VERIFY_ALLOW_ROOT=1; the degradation is reported and recorded);
 * - when containment is unavailable the command does NOT run: VerifyContainmentError (exit 3, not ready).
 *
 * There is no fallback to an uncontained host shell.
 */

/** Operator switches for the verify identity when tecera runs as root (never read from the manifest). */
export const VERIFY_UID_ENV = 'TECERA_VERIFY_UID';
export const VERIFY_GID_ENV = 'TECERA_VERIFY_GID';
export const VERIFY_ALLOW_ROOT_ENV = 'TECERA_VERIFY_ALLOW_ROOT';

export type VerifyIdentity = { runAs?: { uid: number; gid: number }; allowRoot?: boolean };

/** Containment could not be established: the check must not run. */
export class VerifyContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifyContainmentError';
  }
}

/**
 * Who runs the verify command: an explicit unprivileged uid/gid (TECERA_VERIFY_UID/GID), or, only when the
 * operator says so (TECERA_VERIFY_ALLOW_ROOT=1), root with capabilities dropped (degraded, recorded). Without
 * either a root supervisor is refused by the runner (fail closed). Invalid numbers refuse.
 */
export function verifyIdentity(env: Env, o: { verifyIdentity?: VerifyIdentity } = {}): VerifyIdentity {
  if (o.verifyIdentity) return o.verifyIdentity;
  const u = env[VERIFY_UID_ENV];
  const g = env[VERIFY_GID_ENV];
  if (u !== undefined || g !== undefined) {
    const uid = Number(u);
    const gid = Number(g ?? u);
    if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0) throw new VerifyContainmentError(`${VERIFY_UID_ENV}/${VERIFY_GID_ENV} must be positive integers (an unprivileged identity)`);
    return { runAs: { uid, gid } };
  }
  if (env[VERIFY_ALLOW_ROOT_ENV] === '1') return { allowRoot: true };
  return {};
}

export interface AdmittedVerify {
  runner: VerifyRunner;
  /** Why the runner is degraded (root identity, missing controls), or null. */
  degraded: string | null;
}

/** Admit the contained verify runner for this host and operator env, or throw VerifyContainmentError. */
export function admitVerify(env: Env, redactor: Redactor | undefined, o: { verifyIdentity?: VerifyIdentity } = {}): AdmittedVerify {
  const ident = verifyIdentity(env, o);
  let r: ProcessVerifyRunner;
  try {
    r = new ProcessVerifyRunner({ ...(redactor ? { redactor } : {}), netns: true, ...ident });
  } catch (e) {
    if (e instanceof IsolationUnavailable) {
      const root = typeof process.geteuid === 'function' && process.geteuid() === 0 && !ident.runAs && !ident.allowRoot;
      const hint = root ? ` — set ${VERIFY_UID_ENV}/${VERIFY_GID_ENV} to an unprivileged uid/gid that can read the worktree and run the check, or ${VERIFY_ALLOW_ROOT_ENV}=1 to accept a degraded root verify (recorded)` : '';
      throw new VerifyContainmentError(`verify containment unavailable on this host: ${e.message}${hint}`);
    }
    throw e;
  }
  const deg = (r as { degraded?: { reason: string } }).degraded;
  return { runner: r, degraded: deg ? deg.reason : null };
}

/**
 * A runner admitted on first use (commands that never run a check never probe the host). Admission failure
 * rejects every run with VerifyContainmentError: nothing spawns. `degraded()` reports the admitted state.
 */
export class ContainedVerifyRunner implements VerifyRunner {
  private admitted: AdmittedVerify | null = null;
  private refusal: VerifyContainmentError | null = null;

  constructor(
    private readonly env: Env,
    private readonly redactor?: Redactor,
    private readonly o: { verifyIdentity?: VerifyIdentity } = {},
  ) {}

  admit(): AdmittedVerify {
    if (this.admitted) return this.admitted;
    if (this.refusal) throw this.refusal;
    try {
      this.admitted = admitVerify(this.env, this.redactor, this.o);
      return this.admitted;
    } catch (e) {
      this.refusal = e instanceof VerifyContainmentError ? e : new VerifyContainmentError(`verify containment unavailable: ${(e as Error)?.message ?? String(e)}`);
      throw this.refusal;
    }
  }

  degraded(): string | null {
    return this.admitted?.degraded ?? null;
  }

  async run(req: VerifyRequest, signal?: AbortSignal): Promise<VerifyOutcome> {
    return this.admit().runner.run(req, signal);
  }
}
