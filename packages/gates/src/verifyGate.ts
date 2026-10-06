import { resolve } from 'node:path';
import { LedgerError, type EnvironmentalCheck, type Json, type Ledger, type Manifest, type Redactor, type SecretInput, type VerifyOutcome, type VerifyRunner } from '@tecera/contracts';
import { fileManifest, snapshotCandidate, type Candidate } from './candidate.js';
import { commandDigest, defaultIds, errMsg, GateMemo, IGNORED_BASELINE_VERSION, ignoredBaseline, ignoredBaselineKey, ignoredBaselineOf, obj, redactorFrom, safeText, tail, writeEvidence } from './evidence.js';
import { UnsafeRepo } from './gitx.js';
import { EXIT, TOOLING_EXITS, type StepContext, type VerifyOutcomeKind, type VerifyResult } from './types.js';

/**
 * Verify gate (security.md §5, recovery S4/S6). The candidate is snapshotted by the host before and after
 * the check command runs in a separate scrubbed process; the "before" snapshot is the freeze (D1): its
 * fingerprint is returned to the loop and its per-file {path, status, mode, sha256, oid} record is stored
 * in evidence.
 *
 * Which command: the adopted goal's check (GateContext.goal.check) wins over the manifest's verify command
 * when they differ; its timeout is capped by the manifest's. Evidence records both commands, which one
 * ran (checkSource) and its digest, and the commit gate refuses a verify whose digest is not the goal's.
 * A goal check that is present but malformed is refused (9), never replaced by the manifest's.
 *
 * Outcomes: a changed fingerprint is 'mutated' (9, terminal) even when the command exited 0. Exit
 * 124/126/127, a timeout, a signal, a cancellation or a runner that cannot start are tooling (terminal).
 * Truncated output (either stream hit its cap, or the runner cannot say) never passes: exit 0 with
 * truncated output is a failure (1). A failing command returns exit 1 (retryable) whatever code the test
 * runner used, so a runner exiting 8 or 9 is never mistaken for a gate refusal. A missing worktree ('' in
 * GateContext) or an unsafe repository is refused (9, terminal) before anything runs.
 *
 * Interrupted verify (S4): before the command runs, a start record {D1} is written under a deterministic
 * key per (run, intention, step, attempt, n); the result is written under the matching key. A later verify
 * of the same step that finds a start without a result (the process died mid-verify, ctx.recovered or not)
 * re-snapshots and must see D1 again: a different tree is 'mutated' (9, terminal, human), never re-run.
 *
 * Diagnostics: every string a result carries (`reason`, built from runner exceptions, snapshot and
 * repository errors) is redacted with the shared redactor when it is built, before it reaches either the
 * returned result or the evidence; a terminal result carries `failure: 'human'`.
 */

export interface VerifyGateOptions {
  ledger: Ledger;
  manifest: Manifest;
  runner: VerifyRunner;
  /** Expected worktree. When set, a GateContext naming a different worktree is refused. */
  worktree?: string;
  /** Diff base for fingerprints. Defaults to manifest.repo.base. */
  base?: string;
  redactor?: Redactor;
  secrets?: readonly SecretInput[];
  now?: () => number;
  ids?: () => string;
  memo?: GateMemo;
  /** Cap for stdout/stderr tails in evidence (chars, after redaction). Default 8 KiB. */
  tailCap?: number;
}

/** Env names that must never reach a test process, whatever the manifest allowlist says. */
const SECRETISH = /(KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE)/i;

export function scrubbedAllowlist(m: Manifest): string[] {
  const providerRefs = new Set(
    Object.values(m.providers)
      .map((p) => /^env:([A-Z_][A-Z0-9_]*)$/.exec(p.auth)?.[1])
      .filter((x): x is string => !!x),
  );
  return [...new Set(m.sandbox.envAllowlist)].filter((n) => !providerRefs.has(n) && !SECRETISH.test(n)).sort();
}

/** The worktree a gate may act on: GateContext's, which must be set and match the configured one. */
export function gateWorktree(ctxWorktree: unknown, configured: string | undefined): { ok: true; dir: string } | { ok: false; reason: string } {
  if (typeof ctxWorktree !== 'string' || ctxWorktree === '') return { ok: false, reason: 'no worktree in GateContext (refusing)' };
  if (configured !== undefined && resolve(configured) !== resolve(ctxWorktree)) return { ok: false, reason: 'GateContext worktree differs from the gate worktree' };
  return { ok: true, dir: ctxWorktree };
}

/** The check a verify runs, and where it came from. */
export interface ResolvedCheck {
  command: string;
  timeoutSec: number;
  source: 'goal' | 'manifest';
  manifestCommand: string;
  /** The goal asked for a longer timeout than the manifest allows; the manifest's applies. */
  timeoutCapped: boolean;
}

/**
 * The adopted goal's check wins; the manifest's verify command applies only when the context carries no
 * goal check at all. A goal check that is present but malformed is refused (fail closed).
 */
export function resolveCheck(goal: { check?: unknown } | undefined, m: Manifest): { ok: true; check: ResolvedCheck } | { ok: false; reason: string } {
  const mc = m.verify.command;
  const mt = m.verify.timeoutSec;
  const gc = goal?.check as Partial<EnvironmentalCheck> | undefined | null;
  if (gc === undefined) return { ok: true, check: { command: mc, timeoutSec: mt, source: 'manifest', manifestCommand: mc, timeoutCapped: false } };
  if (!gc || typeof gc !== 'object' || typeof gc.command !== 'string' || gc.command.trim() === '') return { ok: false, reason: 'the goal check has no command (refusing rather than running another check)' };
  if (typeof gc.timeoutSec !== 'number' || !Number.isFinite(gc.timeoutSec) || gc.timeoutSec <= 0) return { ok: false, reason: 'the goal check has no positive timeoutSec' };
  return { ok: true, check: { command: gc.command, timeoutSec: Math.min(gc.timeoutSec, mt), source: 'goal', manifestCommand: mc, timeoutCapped: gc.timeoutSec > mt } };
}

interface RunOnce {
  outcome: VerifyOutcomeKind;
  exitCode: number;
  fingerprint: string;
  terminal: boolean;
  reason: string;
  before?: Candidate;
  body: Record<string, Json>;
}

export class VerifyGate {
  private readonly base: string;
  private readonly redactor: Redactor;
  private readonly now: () => number;
  private readonly ids: () => string;
  readonly memo: GateMemo;

  constructor(private readonly o: VerifyGateOptions) {
    this.base = o.base ?? o.manifest.repo.base;
    this.redactor = redactorFrom(o);
    this.now = o.now ?? Date.now;
    this.ids = o.ids ?? defaultIds();
    this.memo = o.memo ?? new GateMemo();
  }

  /** Gate step: verify the frozen candidate for this intention. */
  async verify(ctx: StepContext): Promise<VerifyResult> {
    const stepMeta: Record<string, Json> = { intentionId: ctx.intention.id, stepId: ctx.step.id, attempt: ctx.intention.attempt, recovered: ctx.recovered === true };
    const wt = gateWorktree(ctx.worktree, this.o.worktree);
    const chk = resolveCheck(ctx.goal, this.o.manifest);
    let r: RunOnce;
    let evidenceKey: string | undefined;
    if (!wt.ok || !chk.ok) {
      evidenceKey = `verify-refused:${ctx.runId}:${ctx.intention.id}:${ctx.step.id}:${this.ids()}`;
      r = this.refused(!wt.ok ? wt.reason : (chk as { reason: string }).reason, { startedAt: this.now() });
    } else {
      const slot = `${ctx.runId}:${ctx.intention.id}:${ctx.step.id}:${ctx.intention.attempt}`;
      const prior = await this.interrupted(slot);
      r = await this.runOnce(wt.dir, ctx.runId, chk.check, ctx.signal, true, async (before) => {
        // S4: a verify of this step died after freezing D1. The tree must still be D1, else a human looks.
        if (prior && prior.d1 !== before.fingerprint) {
          // The interrupted start stays open: every later verify of this slot refuses the same way.
          evidenceKey = `verify-recovered:${slot}:${this.ids()}`;
          return { outcome: 'mutated', reason: `interrupted verify ${prior.key}: the candidate changed since its D1 (security.md S4); not re-running` };
        }
        const n = await this.start(slot, ctx.runId, { ...stepMeta, d1: before.fingerprint, commandDigest: commandDigest(chk.check.command), ...(prior ? { recoveredFrom: prior.key } : {}) });
        if (prior) {
          // Same D1: close the interrupted run (it never produced a result) and re-run under the new start.
          await writeEvidence(this.o.ledger, this.redactor, { key: `verify:${slot}:${prior.n}`, kind: 'gate.verify', runId: ctx.runId, body: { ...stepMeta, outcome: 'interrupted', fingerprint: prior.d1, terminal: false, supersededBy: `verify:${slot}:${n}` } });
        }
        evidenceKey = `verify:${slot}:${n}`;
        return null;
      });
      evidenceKey ??= `verify-refused:${ctx.runId}:${ctx.intention.id}:${ctx.step.id}:${this.ids()}`;
      if (prior) r.body.interruptedVerify = { key: prior.key, d1: prior.d1 };
    }
    await writeEvidence(this.o.ledger, this.redactor, { key: evidenceKey!, kind: 'gate.verify', runId: ctx.runId, body: { ...r.body, ...stepMeta } });
    this.memo.verify.set(`${ctx.runId}:${ctx.intention.id}`, { evidenceKey: evidenceKey!, fingerprint: r.fingerprint, outcome: r.outcome, files: r.body.files, ...(typeof r.body.commandDigest === 'string' ? { commandDigest: r.body.commandDigest } : {}) });
    return this.result(r, evidenceKey!);
  }

  /** The returned result: diagnostics redacted (again, idempotently), terminal results classified. */
  private result(r: RunOnce, evidenceKey: string): VerifyResult {
    return { exitCode: r.exitCode, evidenceKey, outcome: r.outcome, fingerprint: r.fingerprint, terminal: r.terminal, reason: this.diag(r.reason), ...(r.terminal ? { failure: 'human' as const } : {}) };
  }

  /** A diagnostic string as it may leave the gate. */
  private diag(text: string): string {
    return safeText(this.redactor, text);
  }

  /** The last start record of this step slot that has no result, if any (an interrupted verify). */
  private async interrupted(slot: string): Promise<{ key: string; n: number; d1: string } | null> {
    let last: { key: string; n: number; d1: string } | null = null;
    for (let n = 0; n < MAX_SLOTS; n++) {
      const start = await this.o.ledger.getEvidence(`verify-start:${slot}:${n}`);
      if (!start) break;
      const done = await this.o.ledger.getEvidence(`verify:${slot}:${n}`);
      const d1 = obj(start.body)?.d1;
      if (!done) last = { key: `verify-start:${slot}:${n}`, n, d1: typeof d1 === 'string' ? d1 : '' };
    }
    return last;
  }

  /** Write the start record at the first free n of this slot (create-if-absent; a race moves on). */
  private async start(slot: string, runId: string, body: Record<string, Json>): Promise<number> {
    for (let n = 0; n < MAX_SLOTS; n++) {
      const key = `verify-start:${slot}:${n}`;
      if (await this.o.ledger.getEvidence(key)) continue;
      try {
        await writeEvidence(this.o.ledger, this.redactor, { key, kind: 'gate.verify.start', runId, body: { ...body, n, at: this.now(), nonce: this.ids() } });
        return n;
      } catch (err) {
        if (err instanceof LedgerError && err.code === 'evidence') continue;
        throw err;
      }
    }
    throw new Error(`verify slot ${slot} has more than ${MAX_SLOTS} runs`);
  }

  /**
   * Preflight: run verify on the untouched base tree and record it as the run's baseline. When the tree
   * has no committable change, its ignored files (dependencies, build output) are recorded as the run's
   * ignored baseline (path keys + redacted names): later snapshots treat them as unchanged only while
   * their bytes are identical, and a baselined file that disappears is a change. `check` is the adopted
   * goal's check when the run has one (else the manifest's verify command runs).
   */
  async baseline(ctx: { runId: string; worktree?: string; signal?: AbortSignal; check?: EnvironmentalCheck }): Promise<VerifyResult> {
    const evidenceKey = `verify-baseline:${ctx.runId}:${this.ids()}`;
    const wt = gateWorktree(ctx.worktree ?? this.o.worktree, this.o.worktree);
    const chk = resolveCheck(ctx.check !== undefined ? { check: ctx.check } : undefined, this.o.manifest);
    const r = !wt.ok ? this.refused(wt.reason, { startedAt: this.now() }) : !chk.ok ? this.refused(chk.reason, { startedAt: this.now() }) : await this.runOnce(wt.dir, ctx.runId, chk.check, ctx.signal, false);
    if (r.before && r.outcome !== 'mutated' && r.outcome !== 'refused' && r.before.files.every((f) => f.status === '!')) {
      const existing = await ignoredBaseline(this.o.ledger, this.memo, ctx.runId);
      if (!existing) {
        const b = ignoredBaselineOf(r.before.ignored, this.redactor);
        const body: Json = { v: IGNORED_BASELINE_VERSION, entries: b.entries, names: b.names as Record<string, string>, count: Object.keys(b.entries).length, fingerprint: r.fingerprint };
        try {
          await writeEvidence(this.o.ledger, this.redactor, { key: ignoredBaselineKey(ctx.runId), kind: 'gate.verify.baseline.ignored', runId: ctx.runId, body });
          this.memo.ignoredBaseline.set(ctx.runId, b);
        } catch (err) {
          // A concurrent baseline won the key: use what is on the ledger (never our unrecorded view).
          if (!(err instanceof LedgerError && err.code === 'evidence')) throw err;
          await ignoredBaseline(this.o.ledger, this.memo, ctx.runId);
        }
      }
    }
    await writeEvidence(this.o.ledger, this.redactor, { key: evidenceKey, kind: 'gate.verify.baseline', runId: ctx.runId, body: { ...r.body, baseline: true } });
    return this.result(r, evidenceKey);
  }

  /**
   * Snapshot (D1), optionally let `beforeRun` refuse or record a start, run the check, snapshot again.
   * `beforeRun` returning {outcome:'mutated'} stops before the command runs.
   */
  private async runOnce(
    worktree: string,
    runId: string,
    check: ResolvedCheck,
    signal?: AbortSignal,
    useBaseline = true,
    beforeRun?: (before: Candidate) => Promise<{ outcome: 'mutated'; reason: string } | null>,
  ): Promise<RunOnce> {
    const { manifest } = this.o;
    const cap = this.o.tailCap ?? 8 * 1024;
    const command = check.command;
    const envAllowlist = scrubbedAllowlist(manifest);
    const startedAt = this.now();
    const meta: Record<string, Json> = {
      command,
      commandDigest: commandDigest(command),
      checkSource: check.source,
      manifestCommand: check.manifestCommand,
      timeoutSec: check.timeoutSec,
      timeoutCapped: check.timeoutCapped,
      envAllowlist,
      startedAt,
    };
    const baseline = useBaseline ? await ignoredBaseline(this.o.ledger, this.memo, runId) : undefined;

    let before: Candidate;
    try {
      before = await snapshotCandidate(worktree, this.base, { ignoredBaseline: baseline, signal });
    } catch (err) {
      if (err instanceof UnsafeRepo) return this.refused(`unsafe repository: ${err.problems.join('; ')}`, meta);
      return this.tooling('', EXIT.notExecutable, `cannot fingerprint worktree: ${errMsg(err)}`, meta);
    }

    const stop = beforeRun ? await beforeRun(before) : null;
    if (stop) {
      const reason = this.diag(stop.reason);
      return {
        outcome: 'mutated',
        exitCode: EXIT.human,
        fingerprint: before.fingerprint,
        terminal: true,
        reason,
        before,
        body: { ...meta, outcome: 'mutated', exitCode: EXIT.human, reason, humanNeeded: true, retryable: false, terminal: true, fingerprint: before.fingerprint, files: fileManifest(before), ran: false, stdoutTail: '', stderrTail: '', durationMs: 0 },
      };
    }

    let out: VerifyOutcome;
    try {
      out = await this.o.runner.run({ cwd: worktree, command, timeoutSec: check.timeoutSec, envAllowlist }, signal);
    } catch (err) {
      return this.tooling(before.fingerprint, signal?.aborted ? EXIT.timeout : EXIT.notFound, `verify runner failed: ${errMsg(err)}`, { ...meta, files: fileManifest(before) });
    }
    if (!out || typeof out !== 'object') return this.tooling(before.fingerprint, EXIT.notFound, 'verify runner returned no outcome', { ...meta, files: fileManifest(before) });

    let after: string;
    try {
      after = (await snapshotCandidate(worktree, this.base, { ignoredBaseline: baseline })).fingerprint;
    } catch (err) {
      after = `unreadable: ${this.diag(errMsg(err))}`;
    }

    // Redact the whole stream first, then keep the tail: a cut can never leave half a secret behind.
    const clean = (s: unknown) => tail(this.redactor.redactText(typeof s === 'string' ? s : ''), cap);
    // Output the runner capped (or cannot vouch for) is incomplete: it can never certify a pass.
    const truncated = out.truncated === true || out.stdoutTruncated === true || out.stderrTruncated === true || typeof out.truncated !== 'boolean';
    const common: Record<string, Json> = {
      ...meta,
      ran: true,
      runnerExitCode: typeof out.exitCode === 'number' ? out.exitCode : null,
      signal: typeof out.signal === 'string' ? out.signal : null,
      timedOut: out.timedOut === true,
      cancelled: out.cancelled === true,
      stdoutTail: clean(out.stdout),
      stderrTail: clean(out.stderr),
      outputTruncated: truncated,
      stdoutTruncated: out.stdoutTruncated ?? null,
      stderrTruncated: out.stderrTruncated ?? null,
      fingerprint: before.fingerprint,
      fingerprintAfter: after,
      files: fileManifest(before),
      durationMs: typeof out.durationMs === 'number' && Number.isFinite(out.durationMs) ? out.durationMs : null,
    };

    let outcome: VerifyOutcomeKind;
    let exitCode: number;
    let reason: string;
    if (after !== before.fingerprint) {
      outcome = 'mutated';
      exitCode = EXIT.human;
      reason = 'verify command mutated the candidate tree (D_after != D_before)';
    } else if (out.cancelled === true || signal?.aborted) {
      outcome = 'tooling';
      exitCode = EXIT.timeout;
      reason = 'verify cancelled';
    } else if (out.timedOut === true || out.exitCode === null) {
      outcome = 'tooling';
      exitCode = EXIT.timeout;
      reason = out.timedOut === true ? 'verify timed out' : `verify interrupted by signal ${out.signal ?? 'unknown'}`;
    } else if (typeof out.exitCode !== 'number' || !Number.isInteger(out.exitCode)) {
      outcome = 'tooling';
      exitCode = EXIT.notFound;
      reason = 'verify runner reported no exit code';
    } else if (TOOLING_EXITS.has(out.exitCode)) {
      outcome = 'tooling';
      exitCode = out.exitCode;
      reason = 'tooling missing or interrupted';
    } else if (out.exitCode === 0 && truncated) {
      outcome = 'failed';
      exitCode = EXIT.failed;
      reason = 'verify output was truncated at its cap: an incomplete run never passes';
    } else if (out.exitCode === 0) {
      outcome = 'passed';
      exitCode = EXIT.ok;
      reason = 'verify passed';
    } else {
      outcome = 'failed';
      exitCode = EXIT.failed;
      reason = `verify exited ${out.exitCode}`;
    }
    const terminal = outcome === 'mutated' || outcome === 'tooling';
    reason = this.diag(reason);
    return { outcome, exitCode, fingerprint: before.fingerprint, terminal, reason, before, body: { ...common, outcome, exitCode, reason, humanNeeded: terminal, retryable: outcome === 'failed', terminal } };
  }

  private tooling(fingerprint: string, exitCode: number, rawReason: string, extra: Record<string, Json>): RunOnce {
    const reason = this.diag(rawReason);
    return {
      outcome: 'tooling',
      exitCode,
      fingerprint,
      terminal: true,
      reason,
      body: { ...extra, outcome: 'tooling', exitCode, reason, humanNeeded: true, retryable: false, terminal: true, fingerprint, timedOut: false, stdoutTail: '', stderrTail: '', durationMs: 0 },
    };
  }

  private refused(rawReason: string, extra: Record<string, Json>): RunOnce {
    const reason = this.diag(rawReason);
    return {
      outcome: 'refused',
      exitCode: EXIT.human,
      fingerprint: '',
      terminal: true,
      reason,
      body: { ...extra, outcome: 'refused', exitCode: EXIT.human, reason, humanNeeded: true, retryable: false, terminal: true, fingerprint: '', stdoutTail: '', stderrTail: '', durationMs: 0 },
    };
  }
}

/** Start records probed per verify step slot. */
const MAX_SLOTS = 1000;

/** Preflight helper: baseline verify without constructing a gate runner. */
export function baselineVerify(o: VerifyGateOptions, ctx: { runId: string; worktree?: string; signal?: AbortSignal; check?: EnvironmentalCheck }): Promise<VerifyResult> {
  return new VerifyGate(o).baseline(ctx);
}
