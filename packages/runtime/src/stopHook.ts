import { achievedProofOf, achievementProofProblem, type AchievementProof, type Json, type Ledger, type StopHookDecision, type TeceraEvent } from '@tecera/contracts';
import { stopDecision } from '@tecera/policy';

/**
 * The host Stop hook (D4: `tecera hook stop`, Claude Code's Stop event). The assistant may not stop while a
 * Tecera run on this business case is active without a proof that its goal was achieved:
 *
 * - active run: the latest run that started and either has not ended or whose last segment ended held for
 *   a human (exit 4, e.g. waiting at the PR gate) or interrupted (exit 130) — it can be resumed and its goal
 *   is open. A run that ended any other way (achieved, failed, refused, budget) is not active;
 * - proof: the run's goal.achieved carries {command, exitCode 0, fingerprint, evidenceKey, verifiedAt}
 *   (contracts achievedProofOf: well formed, matching the goal's check, not followed by a demotion) AND the
 *   evidence it names is in the ledger: this run's gate.verify record, exit 0, on that fingerprint;
 * - decision: @tecera/policy stopDecision. Block = exit 2 with `goal not achieved: <what is missing>` on
 *   stderr (Claude Code keeps the assistant working); allow = exit 0. Budget is never considered: pool usage,
 *   budget.exhausted and an exit-7 run never block (a budget-ended run is not active).
 *
 * Every decision is recorded (stop.blocked / stop.allowed). A business case whose ledger cannot be read
 * blocks (fail closed); a directory that is not a business case, or one with no ledger yet, has no run.
 */

/** Exit codes after which a run is still open: held for a human (4), interrupted (130). */
export const RESUMABLE_EXITS: ReadonlySet<number> = new Set([4, 130]);

export interface ActiveRun {
  runId: string;
  goalId?: string;
  /** 'running' (no run.ended), 'held' (last segment exit 4) or 'interrupted' (exit 130). */
  state: 'running' | 'held' | 'interrupted';
}

/** The active run of a business case's events (see above), or null. */
export function activeRunForStop(events: Iterable<TeceraEvent>): ActiveRun | null {
  const order: string[] = [];
  const lastExit = new Map<string, number | null>();
  const goals = new Map<string, string>();
  for (const e of events) {
    if (!e.runId) continue;
    if (e.kind === 'run.started' && !lastExit.has(e.runId)) {
      order.push(e.runId);
      lastExit.set(e.runId, null);
    } else if (e.kind === 'run.ended' && lastExit.has(e.runId)) {
      const x = (e.payload as { exitCode?: unknown }).exitCode;
      lastExit.set(e.runId, typeof x === 'number' ? x : -1);
    } else if (e.kind === 'goal.adopted' && e.trace.goalId && !goals.has(e.runId)) goals.set(e.runId, e.trace.goalId);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const runId = order[i]!;
    const x = lastExit.get(runId);
    const state: ActiveRun['state'] | null = x === null || x === undefined ? 'running' : x === 4 ? 'held' : x === 130 ? 'interrupted' : null;
    if (!state) continue;
    const goalId = goals.get(runId);
    return { runId, ...(goalId ? { goalId } : {}), state };
  }
  return null;
}

/** The latest run that started (any state), with its first adopted goal. */
function latestRun(events: ReadonlyArray<TeceraEvent>): { runId: string; goalId?: string } | null {
  let runId: string | undefined;
  for (const e of events) if (e.kind === 'run.started' && e.runId) runId = e.runId;
  if (!runId) return null;
  const g = events.find((e) => e.kind === 'goal.adopted' && e.runId === runId)?.trace.goalId;
  return { runId, ...(g ? { goalId: g } : {}) };
}

/** Why `proof` is not backed by the ledger's evidence (null when it is). */
export async function proofEvidenceProblem(ledger: Pick<Ledger, 'getEvidence'>, runId: string, proof: AchievementProof): Promise<string | null> {
  const rec = await ledger.getEvidence(proof.evidenceKey);
  if (!rec) return `the proof's verify evidence ${proof.evidenceKey} is not in the ledger`;
  if (rec.runId !== runId) return `the proof's verify evidence belongs to run ${rec.runId}`;
  if (rec.kind !== 'gate.verify') return `the proof's evidence is ${rec.kind}, not a verify gate record`;
  const b = (rec.body && typeof rec.body === 'object' && !Array.isArray(rec.body) ? rec.body : {}) as Record<string, Json>;
  if (b.exitCode !== 0) return `the proof's verify evidence records exit ${JSON.stringify(b.exitCode ?? null)}`;
  if (typeof b.fingerprint === 'string' && b.fingerprint !== proof.fingerprint) return 'the proof names another candidate than its verify evidence';
  return null;
}

export interface StopEvaluation {
  decision: StopHookDecision;
  activeRun: ActiveRun | null;
  proof: AchievementProof | null;
  /** What is missing (null when allowed). */
  missing: string | null;
  /** No run is active and the latest run proved its goal: that run. */
  provedRunId?: string;
}

/** Evaluate the Stop hook over a ledger. Never considers budget. */
export async function evaluateStop(ledger: Ledger): Promise<StopEvaluation> {
  const events: TeceraEvent[] = [];
  for await (const e of ledger.events()) events.push(e);
  const run = activeRunForStop(events);
  if (!run) {
    // Nothing active. When the latest run proved its goal, say so (the decision is allow either way).
    const latest = latestRun(events);
    const proof = latest ? achievedProofOf(events, latest.runId, latest.goalId) : null;
    const backed = latest && proof && !achievementProofProblem(proof) && !(await proofEvidenceProblem(ledger, latest.runId, proof)) ? proof : null;
    const decision = backed && latest ? stopDecision({ activeRun: { runId: latest.runId, ...(latest.goalId ? { goalId: latest.goalId } : {}), state: 'ended' }, achievedProof: backed }) : stopDecision({ activeRun: null, achievedProof: null });
    return { decision, activeRun: null, proof: backed, missing: null, ...(backed && latest ? { provedRunId: latest.runId } : {}) };
  }
  let proof = achievedProofOf(events, run.runId, run.goalId);
  let missing: string | null = proof ? null : `run ${run.runId}${run.goalId ? ` (goal ${run.goalId})` : ''} is ${run.state === 'held' ? 'held for a human decision' : run.state} and has no goal.achieved proof`;
  if (proof) {
    const why = achievementProofProblem(proof) ?? (await proofEvidenceProblem(ledger, run.runId, proof));
    if (why) {
      missing = why;
      proof = null;
    }
  }
  const decision = stopDecision({ activeRun: { runId: run.runId, ...(run.goalId ? { goalId: run.goalId } : {}), state: run.state }, achievedProof: proof });
  return { decision, activeRun: run, proof, missing: decision.decision === 'block' ? (missing ?? 'no goal.achieved proof') : null };
}
