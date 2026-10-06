import { requireWriteGuard, type Redactor, type ToolContext, type ToolRequest, type ToolResult, type VerifyOutcome, type VerifyRunner, type WriteGuard } from '@tecera/contracts';
import { assertLease, assertMethod, assertWorktree, combinedSignal, fail, ok, redactorOf, type AuthorizingTool } from './common.js';
import { withWorktreeLock } from './paths.js';

/**
 * runVerify: run the goal's check command through the injected VerifyRunner (a separate scrubbed
 * process, never the REPL child) with cwd = worktree. The command is fixed at construction: the model
 * can trigger a run but never choose what runs.
 *
 * Fail-closed rules:
 * - It runs repository scripts, which can mutate the tree: it is write-class. It refuses without a
 *   worktree, on a quarantined worktree, and without a lease fencing token (exactly like edit), and holds
 *   the worktree's exclusive lock for the whole run so no edit interleaves with it.
 * - Fenced (contracts WriteGuard, Tool.call's third argument): without a guard it refuses; guard.check()
 *   runs immediately before the runner starts (under the lock). The exec's AbortSignal and the guard's
 *   signal are forwarded to the runner; a fence lost while it ran makes the result a failure.
 * - `passed` is true only for a COMPLETE result (every contract field present and well typed: integer or
 *   null exitCode, string or null signal, boolean timedOut, string stdout/stderr, finite durationMs >= 0,
 *   boolean truncated; optional stdoutTruncated/stderrTruncated/cancelled boolean when present) with exit
 *   code 0, no timeout, not cancelled, no signal, and no truncated stream. A missing `truncated` flag is
 *   not evidence of complete output: it fails.
 * - Output is redacted in full (the step's redactor, when the broker supplies it) BEFORE the tail is taken,
 *   and the cut is reported in a separate field, so a tail can never start mid-secret behind a prefix
 *   that defeats later redaction.
 */

export interface RunVerifyOptions {
  runner: VerifyRunner;
  command: string;
  timeoutSec: number;
  envAllowlist?: string[];
  maxTailChars?: number;
  /** Redactor for the output when the context carries none (the broker's always wins). */
  redactor?: Redactor;
}

/** Last `n` chars of an already redacted text, and how many chars were cut before it. */
function tailOf(s: string, n: number): { text: string; cut: number } {
  return s.length > n ? { text: s.slice(-n), cut: s.length - n } : { text: s, cut: 0 };
}

/** Why a runner result is not a complete VerifyOutcome (null when it is). Never trusts a missing field. */
export function verifyOutcomeProblem(r: unknown): string | null {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'no result';
  const o = r as Record<string, unknown>;
  if (!(o.exitCode === null || (typeof o.exitCode === 'number' && Number.isInteger(o.exitCode)))) return 'exitCode is missing or not an integer/null';
  if (!(o.signal === null || typeof o.signal === 'string')) return 'signal is missing or not a string/null';
  if (typeof o.timedOut !== 'boolean') return 'timedOut is missing or not a boolean';
  if (typeof o.stdout !== 'string') return 'stdout is missing or not a string';
  if (typeof o.stderr !== 'string') return 'stderr is missing or not a string';
  if (typeof o.durationMs !== 'number' || !Number.isFinite(o.durationMs) || o.durationMs < 0) return 'durationMs is missing or not a finite non-negative number';
  if (typeof o.truncated !== 'boolean') return 'truncated is missing or not a boolean (output completeness is unproven)';
  for (const k of ['stdoutTruncated', 'stderrTruncated', 'cancelled'] as const) if (o[k] !== undefined && typeof o[k] !== 'boolean') return `${k} is not a boolean`;
  if (o.exitCode === null && o.timedOut !== true && o.cancelled !== true && o.signal === null) return 'no exit code, yet no timeout, cancellation or signal';
  return null;
}

export function createRunVerifyTool(o: RunVerifyOptions): AuthorizingTool {
  const n = o.maxTailChars ?? 20_000;
  const preconditions = (req: ToolRequest, ctx: ToolContext): void => {
    assertMethod(req, ['call']);
    assertWorktree(ctx);
    assertLease(ctx, 'runVerify');
  };
  return {
    name: 'runVerify',
    methods: ['call'],
    risk: 'write',
    schema: { type: 'object', properties: {} },
    async authorize(req: ToolRequest, ctx: ToolContext): Promise<void> {
      preconditions(req, ctx);
    },
    async call(req: ToolRequest, ctx: ToolContext, guard?: WriteGuard): Promise<ToolResult> {
      try {
        const g = requireWriteGuard(guard);
        preconditions(req, ctx);
        const signal = combinedSignal(ctx, g);
        g.check();
        if (signal.aborted) throw new Error('runVerify cancelled before it started');
        const red = redactorOf(ctx) ?? o.redactor;
        const r = await withWorktreeLock(ctx.worktree, async () => {
          assertWorktree(ctx); // re-check under the lock: a quarantine may have happened while waiting
          g.check(); // immediately before the run (repository scripts can mutate the tree)
          return o.runner.run({ cwd: ctx.worktree, command: o.command, timeoutSec: o.timeoutSec, envAllowlist: o.envAllowlist ?? ['PATH', 'HOME', 'CI'] }, signal);
        });
        let fenceLost: string | null = null;
        try {
          g.check();
        } catch (e) {
          fenceLost = (e as Error).message;
        }
        const problem = verifyOutcomeProblem(r);
        const whole = problem === null;
        const clean = (s: unknown): string => {
          const text = typeof s === 'string' ? s : '';
          return red ? red.redactText(text) : text;
        };
        const out = tailOf(clean(r?.stdout), n);
        const err = tailOf(clean(r?.stderr), n);
        const truncated = r?.truncated !== false || r?.stdoutTruncated === true || r?.stderrTruncated === true;
        const cancelled = r?.cancelled === true || signal.aborted;
        const passed = whole && fenceLost === null && r.exitCode === 0 && r.timedOut === false && !cancelled && !truncated && r.signal === null;
        return ok(req, 'runVerify', {
          command: o.command,
          exitCode: whole ? r.exitCode : null,
          signal: typeof r?.signal === 'string' ? r.signal : null,
          timedOut: r?.timedOut === true,
          cancelled,
          durationMs: typeof r?.durationMs === 'number' && Number.isFinite(r.durationMs) ? r.durationMs : 0,
          stdout: out.text,
          stdoutCut: out.cut,
          stderr: err.text,
          stderrCut: err.cut,
          truncated,
          complete: whole,
          passed,
          ...(fenceLost !== null ? { fenceLost: red ? red.redactText(fenceLost) : fenceLost } : {}),
          ...(passed ? {} : { why: !whole ? `incomplete verification result: ${problem}` : fenceLost !== null ? 'the write fence was lost during the run' : truncated ? 'output exceeded the cap (truncated): never a pass' : cancelled ? 'cancelled' : r.timedOut ? 'timed out' : r.signal ? `killed by ${r.signal}` : `exit code ${r.exitCode}` }),
        });
      } catch (e) {
        return fail(req, 'runVerify', e);
      }
    },
  };
}
