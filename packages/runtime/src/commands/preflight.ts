import type { Json } from '@tecera/contracts';
import type { Command } from '../cli/context.js';
import { CliError, EXIT } from '../errors.js';
import { GoalError, loadGoal, type GoalSpec } from '../goals.js';
import { executionReadiness } from '../readiness.js';
import { gitSync, repoExecHazards } from '../util/proc.js';
import { VerifyContainmentError } from '../containment.js';
import { tail, toolingProblem } from '../verify.js';
import { doctorChecks, liveSeatChecks, printChecks, summarize, type Check } from './doctor.js';

/**
 * `tecera preflight <goal> [--skip-live]`: doctor, then the goal-specific checks — the goal file resolves,
 * the worktree is clean, the base is reachable, the baseline check runs (recorded as evidence and as
 * preflight.ran: a failing baseline is the job, a passing one is a note), a budget reservation succeeds.
 * Any missing → exit 3. The baseline runs repository code, so it runs only when the execution-readiness
 * checks pass (validation incl. secret scan, lock, ledger chain) and the repository's git config cannot run
 * programs; otherwise it is reported as skipped (missing) and nothing executes. Live seat probes (model
 * calls) run LAST, only when every offline check above passed.
 */
export const preflightCommand: Command = async (c) => {
  const ref = c.args.positionals[0];
  if (!ref || c.args.positionals.length > 1) throw new CliError('usage: tecera preflight <goal>', EXIT.usage);
  const skipLive = !!c.args.bools['skip-live'];
  // Offline doctor checks first; the live probes wait until the goal-specific readiness below has passed.
  const { checks, rt } = await doctorChecks(c, { skipLive: true, fix: false, appendEvent: false });
  if (!skipLive) {
    const i = checks.findIndex((k) => k.name === 'seats' && /--skip-live/.test(k.detail));
    if (i >= 0) checks.splice(i, 1);
  }
  const add = (name: string, status: Check['status'], detail: string): void => void checks.push({ name, status, detail });
  if (!rt) {
    printChecks(c, checks);
    c.out.say('manifest does not load → exit 3');
    c.out.set('checks', checks as unknown as Json);
    return EXIT.notReady;
  }
  const env = c.opts.env;
  const m = rt.manifest;

  let goal: GoalSpec | null = null;
  try {
    goal = loadGoal(rt.root, ref, m);
    add('goal', 'ok', `${goal.goalId} · check \`${goal.check.command}\` · ${goal.commitment}`);
  } catch (e) {
    if (e instanceof GoalError) add('goal', 'missing', e.message);
    else throw e;
  }

  const inside = gitSync(rt.root, ['rev-parse', '--is-inside-work-tree'], { env });
  const hazards = inside.code === 0 ? repoExecHazards(rt.root, env) : [];
  if (hazards.length) {
    add('worktree', 'missing', `repository config can run programs (${hazards.join(', ')}); git status not run`);
    add('base', 'missing', 'skipped (unsafe repository config)');
  } else if (inside.code !== 0) {
    add('worktree', 'missing', 'not a git repository');
    add('base', 'missing', 'not a git repository');
  } else {
    const st = gitSync(rt.root, ['status', '--porcelain'], { env });
    const dirty = st.stdout.split('\n').filter(Boolean);
    add('worktree', st.code === 0 && dirty.length === 0 ? 'ok' : 'missing', st.code !== 0 ? 'git status failed' : dirty.length ? `dirty: ${dirty.slice(0, 5).map((l) => l.slice(3)).join(', ')}${dirty.length > 5 ? ' …' : ''}` : 'clean');
    const base = gitSync(rt.root, ['rev-parse', '--verify', '--quiet', `${m.repo.base}^{commit}`], { env });
    add('base', base.code === 0 ? 'ok' : 'missing', base.code === 0 ? `${m.repo.base}@${base.stdout.trim().slice(0, 7)}` : `base ${m.repo.base} is not reachable`);
  }

  const runId = rt.ids('pf');
  let baseline: Json = null;
  let evidenceKey: string | null = null;
  const readiness = await executionReadiness(rt, { needCredentials: false });
  const blocked = readiness.length > 0 || hazards.length > 0;
  for (const p of readiness) add(`ready:${p.check}`, 'missing', p.detail);
  if (goal && blocked) add('baseline', 'missing', 'skipped: not ready to execute repository code (see above)');
  let contained: Awaited<ReturnType<typeof rt.verifyRunner.run>> | null = null;
  if (goal && !blocked) {
    // The baseline runs repository code: only through the contained runner (same admission as `run`).
    try {
      contained = await rt.verifyRunner.run({ cwd: rt.root, command: goal.check.command, timeoutSec: goal.check.timeoutSec, envAllowlist: m.sandbox.envAllowlist }, c.opts.signal);
    } catch (e) {
      if (!(e instanceof VerifyContainmentError)) throw e;
      add('baseline', 'missing', `not run: ${e.message}`);
    }
    const deg = (contained as { degraded?: { reason?: string } } | null)?.degraded;
    if (deg) add('verify', 'note', `baseline ran degraded: ${deg.reason ?? 'containment incomplete'}`);
  }
  if (goal && contained) {
    const o = contained;
    const problem = toolingProblem(o);
    const state = problem ? 'unknown' : o.exitCode === 0 ? 'passing' : 'failing';
    baseline = { command: goal.check.command, exitCode: o.exitCode, timedOut: o.timedOut, durationMs: o.durationMs, state };
    evidenceKey = `preflight:${runId}:baseline`;
    try {
      await rt.ledger().evidence({
        key: evidenceKey,
        kind: 'verify.baseline',
        runId,
        body: { ...baseline, stdoutTail: rt.redact(tail(o.stdout)), stderrTail: rt.redact(tail(o.stderr)) },
      });
    } catch (e) {
      add('evidence', 'missing', `could not record baseline evidence: ${(e as Error).message}`);
    }
    if (problem) add('baseline', 'missing', `\`${goal.check.command}\` ${problem} — tooling missing or interrupted`);
    else if (o.exitCode === 0) add('baseline', 'note', `\`${goal.check.command}\` → exit 0: the check already passes; nothing to fix?`);
    else add('baseline', 'ok', `\`${goal.check.command}\` → exit ${o.exitCode} (failing, as expected: this is the job) ${o.durationMs}ms`);
  }

  try {
    const l = rt.ledger();
    await l.openBudget(runId, 'usd', m.budgets.usd, { enforce: m.budgets.enforce });
    const r = await l.reserve('usd', Math.min(0.01, m.budgets.usd), runId, `${runId}:probe`);
    await l.settle(r.id, 0);
    add('budget', 'ok', `reservation against $${m.budgets.usd} succeeded · ${m.budgets.enforce ? 'enforced: exhaustion ends a run (exit 7)' : 'not enforced (budgets.enforce false): usage is recorded and reported, exhaustion never ends a run'}`);
  } catch (e) {
    add('budget', 'missing', `reservation failed: ${(e as Error).message}`);
  }
  if (m.policy.approvals.required.length) add('approvers', 'note', `approvals required for ${m.policy.approvals.required.join(', ')}; approver must differ from requester`);
  if (skipLive) add('seats', 'note', 'live probes skipped (--skip-live)');
  else await liveSeatChecks(c, rt, checks);

  const s = summarize(checks);
  const code = s.missing ? EXIT.notReady : EXIT.ok;
  if (goal) {
    await rt.append('preflight.ran', {
      runId,
      trace: { goalId: goal.goalId },
      payload: { goal: goal.id, baseline, evidenceKey, ...s, checks: checks as unknown as Json, manifestHash: rt.manifestHash, exitCode: code },
    });
  }
  printChecks(c, checks);
  c.out.say(`${s.ok} ok · ${s.notes} note(s) · ${s.missing} missing → exit ${code}`);
  c.out.set('checks', checks as unknown as Json);
  c.out.set('baseline', baseline);
  c.out.set('summary', s);
  return code;
};
