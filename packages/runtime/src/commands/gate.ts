import { transitionGoal, type AchievementGoal, type Json } from '@tecera/contracts';
import { projectBoard } from '@tecera/ledger';
import type { Command } from '../cli/context.js';
import { CliError, EXIT } from '../errors.js';
import { GoalError, loadGoal } from '../goals.js';
import { executionReadiness } from '../readiness.js';
import { VerifyContainmentError } from '../containment.js';
import { tail, toolingProblem } from '../verify.js';

/**
 * `tecera gate <goal>`: re-run the goal's environmental check now. Pass → evidence + exit 0. Fail →
 * `goal.demoted` (a standing goal that no longer holds) + exit 5. Tooling problems (timeout, 126, 127) also
 * demote: an unverifiable goal is not achieved. The check runs repository code, so the execution-readiness
 * checks (validation incl. secret scan and env allowlist, pinned lock incl. goal files, ledger chain) must
 * pass first; otherwise nothing runs and the exit is 3.
 */
export const gateCommand: Command = async (c) => {
  const ref = c.args.positionals[0];
  if (!ref || c.args.positionals.length > 1) throw new CliError('usage: tecera gate <goal>', EXIT.usage);
  const rt = c.runtime();
  let goal;
  try {
    goal = loadGoal(rt.root, ref, rt.manifest);
  } catch (e) {
    if (e instanceof GoalError) throw new CliError(e.message, EXIT.usage);
    throw e;
  }
  const problems = await executionReadiness(rt, { needCredentials: false });
  if (problems.length) {
    for (const p of problems) c.out.error(`  ${p.check}: ${p.detail}`);
    c.out.error(`gate ${goal.id}: not ready; the check was not run → exit 3`);
    c.out.set('notReady', problems as unknown as Json);
    return EXIT.notReady;
  }
  // Repository code runs only through the contained runner (same admission as `run`); no containment → not ready.
  let o: Awaited<ReturnType<typeof rt.verifyRunner.run>>;
  try {
    o = await rt.verifyRunner.run({ cwd: rt.root, command: goal.check.command, timeoutSec: goal.check.timeoutSec, envAllowlist: rt.manifest.sandbox.envAllowlist }, c.opts.signal);
  } catch (e) {
    if (!(e instanceof VerifyContainmentError)) throw e;
    c.out.error(`gate ${goal.id}: ${e.message}; the check was not run → exit 3`);
    c.out.set('notReady', [{ check: 'verify-containment', detail: e.message }] as unknown as Json);
    return EXIT.notReady;
  }
  const problem = toolingProblem(o);
  const passed = !problem && o.exitCode === 0;
  const ledger = rt.ledger();
  const gateId = rt.ids('gate');
  const evidenceKey = `gate:${goal.id}:${gateId}`;
  await ledger.evidence({ key: evidenceKey, kind: 'gate.ran', runId: gateId, body: { command: goal.check.command, exitCode: o.exitCode, timedOut: o.timedOut, truncated: o.truncated, problem, durationMs: o.durationMs, stdoutTail: rt.redact(tail(o.stdout)), stderrTail: rt.redact(tail(o.stderr)) } });
  await rt.append('gate.ran', { runId: gateId, trace: { goalId: goal.goalId }, payload: { goal: goal.id, exitCode: o.exitCode, passed, problem, evidenceKey } });
  c.out.set('evidenceKey', evidenceKey);
  c.out.set('exitCode', o.exitCode);
  if (passed) {
    c.out.say(`gate ${goal.id}: \`${goal.check.command}\` → exit 0 (${o.durationMs}ms) ✓`);
    return EXIT.ok;
  }
  const board = await projectBoard(ledger);
  const known = board.goals.get(goal.goalId);
  let demoted: AchievementGoal;
  if (known && known.status === 'achieved') demoted = transitionGoal(known, 'demoted', [evidenceKey]);
  else {
    const base: AchievementGoal = known ?? { id: goal.goalId, statement: goal.statement, check: goal.check, commitment: goal.commitment, budget: goal.budget, status: 'open', evidence: [] };
    demoted = { ...base, status: 'demoted', evidence: [...base.evidence, evidenceKey] };
  }
  await rt.append('goal.demoted', { runId: gateId, trace: { goalId: goal.goalId }, payload: { goal: demoted as unknown as Json, previous: known?.status ?? 'unknown', exitCode: o.exitCode, reason: problem ?? `check exit ${o.exitCode}`, evidenceKey } });
  c.out.say(`gate ${goal.id}: \`${goal.check.command}\` → ${problem ?? `exit ${o.exitCode}`} ✗ goal demoted → exit 5`);
  return EXIT.verifyFailed;
};

export const migrateCommand: Command = async (c) => {
  c.out.error('migrate: nothing to migrate (tecera.json schemaVersion 1 is current)');
  return EXIT.invalid;
};
