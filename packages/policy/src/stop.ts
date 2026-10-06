import { achievementProofProblem, type StopHookDecision, type StopHookInput } from '@tecera/contracts';

/**
 * The host Stop hook's decision (D4), pure. `tecera hook stop` gathers the input from the ledger
 * (contracts activeRunOf / achievedProofOf) and exits with `exitCode`, printing `reason` on block:
 *
 * - no active run on this business case → allow;
 * - an active run whose goal.achieved proof is well formed (check command ran on the final candidate and
 *   exited 0, with its verify evidence key) → allow;
 * - an active run without such a proof → block (exit 2): the assistant keeps working or hands back to a human.
 *
 * Budget never blocks stopping (D3), and neither does anything else: only the missing proof does.
 */
export function stopDecision(input: StopHookInput): StopHookDecision {
  const run = input.activeRun;
  if (!run || typeof run.runId !== 'string' || run.runId === '') return { decision: 'allow', exitCode: 0, reason: 'no active Tecera run on this business case' };
  const why = achievementProofProblem(input.achievedProof);
  if (why === null) {
    const p = input.achievedProof!;
    return { decision: 'allow', exitCode: 0, reason: `run ${run.runId} proved its goal: \`${p.command}\` exited 0 on ${p.fingerprint.slice(0, 12)} (evidence ${p.evidenceKey})` };
  }
  const goal = run.goalId ? ` for goal ${run.goalId}` : '';
  return {
    decision: 'block',
    exitCode: 2,
    reason: `Tecera run ${run.runId}${goal} is active without a goal.achieved proof (${why}). Keep working until the goal's check passes through the run (\`tecera run --resume\`, \`tecera status\`), or hand back to a human (\`tecera approve\` / \`tecera deny\`) — do not stop yet.`,
  };
}
