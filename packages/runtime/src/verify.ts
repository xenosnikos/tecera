import type { Redactor, VerifyOutcome, VerifyRequest, VerifyRunner } from '@tecera/contracts';
import { buildVerifyEnv } from './env.js';
import { runProcess, type Env } from './util/proc.js';

/**
 * NOT a production runner (nothing in the CLI defaults to it: preflight, gate and run go through the contained
 * runner of containment.ts). Kept for its environment-scrubbing and process-group tests and as an injected
 * runner in tests on hosts without containment. The check command via /bin/sh in its own process group; the env is the
 * manifest allowlist intersected with SAFE_ENV (unsafe names throw UnsafeEnvError before anything spawns;
 * values carrying a known secret are dropped); a wall timeout; an output cap that kills the group; a final
 * group sweep so background descendants die with the check. An aborted signal never spawns.
 * Exit codes 124/126/127, a timeout, a cancel, a capped stream or surviving descendants all mean "tooling
 * missing or interrupted", never "the goal passed".
 */

export interface HostVerifyOutcome extends VerifyOutcome {
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  cancelled: boolean;
  /** Process-group members still alive after the final sweep. */
  descendantsSurvived: boolean;
  /** Requested env names that were not passed (names only). */
  envDropped: string[];
}

export class HostVerifyRunner implements VerifyRunner {
  constructor(
    private readonly env: Env,
    private readonly opts: { redactor?: Redactor; maxOutputBytes?: number } = {},
  ) {}

  async run(req: VerifyRequest, signal?: AbortSignal): Promise<HostVerifyOutcome> {
    const { env, dropped } = buildVerifyEnv(this.env, req.envAllowlist, this.opts.redactor);
    const r = await runProcess('/bin/sh', ['-c', req.command], {
      cwd: req.cwd,
      env,
      timeoutMs: req.timeoutSec * 1000,
      signal,
      maxOutputBytes: this.opts.maxOutputBytes,
    });
    return {
      exitCode: r.timedOut || r.truncated ? null : r.code,
      signal: r.signal,
      timedOut: r.timedOut,
      stdout: r.stdout,
      stderr: r.stderr,
      durationMs: r.durationMs,
      truncated: r.truncated,
      stdoutTruncated: r.stdoutTruncated,
      stderrTruncated: r.stderrTruncated,
      cancelled: r.cancelled,
      descendantsSurvived: r.survivors,
      envDropped: dropped,
    };
  }
}

/** Non-null when the outcome means the check did not run to a trustworthy completion. */
export function toolingProblem(o: VerifyOutcome): string | null {
  if (o.cancelled) return 'cancelled';
  if (o.timedOut) return 'timed out';
  if (o.truncated || o.stdoutTruncated || o.stderrTruncated) return 'output exceeded the cap (process group killed)';
  if ((o as Partial<HostVerifyOutcome>).descendantsSurvived) return 'descendant processes survived the check';
  if (o.exitCode === null) return `killed by ${o.signal ?? 'signal'}`;
  if (o.exitCode === 124) return 'interrupted (exit 124)';
  if (o.exitCode === 126) return 'command not executable (exit 126)';
  if (o.exitCode === 127) return 'command not found (exit 127)';
  if (o.exitCode === 130) return 'interrupted (exit 130)';
  return null;
}

export function tail(text: string, lines = 20): string {
  const all = text.trimEnd().split('\n');
  return all.slice(-lines).join('\n');
}
