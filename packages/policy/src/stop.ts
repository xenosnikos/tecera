import { ledgerOrder, ledgerProvenRun, provenRun, type ChainVerdict, type EvidenceLookup, type Ledger, type ProvenOptions, type RunVerdict, type StopHookDecision, type StopHookInput, type TeceraEvent } from '@tecera/contracts';

/**
 * The host Stop hook's decision (D4). "Proven achieved" has one source: contracts provenRun /
 * ledgerProvenRun (sprint 5 item 1). A goal.achieved event, or a well-formed proof lifted from one, never
 * unblocks anything on its own: a forged event without matching verify evidence, a goal resting on a mock
 * (goal.provisional), a stale acceptance or a broken hash chain all keep the hook blocked.
 *
 * - no active run on this business case → allow;
 * - every active run (running, held for a human, or interrupted; not only the newest) has a RunVerdict that
 *   says achieved and not provisional → allow;
 * - any active run without one → block (exit 2): the assistant keeps working or hands back to a human.
 *
 * Budget never blocks stopping (D3), and neither does anything else: only a missing proof does.
 */

/** Exit codes after which a run is still open: held for a human (4), interrupted (130). */
export const RESUMABLE_EXIT_CODES: ReadonlySet<number> = new Set([4, 130]);

export interface ActiveRunRef {
  runId: string;
  goalId?: string;
  /** 'running' (no run.ended since its last start), 'held' (last segment exit 4) or 'interrupted' (exit 130 or run.interrupted). */
  state: 'running' | 'held' | 'interrupted';
}

/** One active run and what the single-source proof said about it. `error`: its verdict could not be computed. */
export interface StopRunCheck {
  run: { runId: string; goalId?: string; state?: string };
  verdict?: RunVerdict | null;
  error?: string;
}

export interface StopEvaluation {
  decision: StopHookDecision;
  /** Every active run that was evaluated, with why it does not let the assistant stop (null when proven). */
  runs: Array<{ run: StopRunCheck['run']; achieved: boolean; provisional: boolean; why: string | null; verdict?: RunVerdict }>;
}

/**
 * Every active run of a business case's events, oldest first: started and not ended since its last start,
 * or whose last segment ended held (exit 4) or interrupted (exit 130, or a run.interrupted after its last
 * start). A run that ended any other way (achieved, failed, refused, budget) is not active.
 */
export function activeRunsOf(events: Iterable<TeceraEvent>): ActiveRunRef[] {
  const order: string[] = [];
  const state = new Map<string, ActiveRunRef['state'] | null>();
  const goals = new Map<string, string>();
  for (const e of ledgerOrder(events)) {
    if (!e.runId) continue;
    if (e.kind === 'run.started') {
      if (!state.has(e.runId)) order.push(e.runId);
      state.set(e.runId, 'running');
    } else if (!state.has(e.runId)) {
      continue;
    } else if (e.kind === 'run.ended') {
      const x = (e.payload as { exitCode?: unknown }).exitCode;
      state.set(e.runId, x === 4 ? 'held' : x === 130 ? 'interrupted' : null);
    } else if (e.kind === 'run.interrupted') {
      if (state.get(e.runId) === 'running') state.set(e.runId, 'interrupted');
    } else if (e.kind === 'goal.adopted' && e.trace.goalId && !goals.has(e.runId)) goals.set(e.runId, e.trace.goalId);
  }
  const out: ActiveRunRef[] = [];
  for (const runId of order) {
    const s = state.get(runId);
    if (!s) continue;
    const goalId = goals.get(runId);
    out.push({ runId, ...(goalId ? { goalId } : {}), state: s });
  }
  return out;
}

/** Why `verdict` does not prove `run` achieved (null when it does). */
function unproven(run: StopRunCheck['run'], verdict: RunVerdict | null | undefined): string | null {
  if (!verdict || typeof verdict !== 'object') return 'no proven verdict (contracts provenRun) for the run';
  if (verdict.runId !== run.runId) return `the verdict is for run ${String(verdict.runId)}, not ${run.runId}`;
  const goals = Object.values(verdict.goals ?? {});
  if (verdict.provisional || goals.some((g) => g.provisional)) return `goal is provisional: a criterion rests on a mock${verdict.why ? ` (${verdict.why})` : ''}`;
  if (verdict.achieved !== true || goals.length === 0) return verdict.why ?? 'the run proved no goal';
  const open = goals.find((g) => g.achieved !== true || !g.proof);
  if (open) return `goal ${open.goalId}: ${open.why ?? 'not proven'}`;
  if (run.goalId && verdict.goals[run.goalId]?.achieved !== true) return `goal ${run.goalId} is not among the run's proven goals`;
  return null;
}

/** The decision over every active run: allow only when each one is proven achieved and none is provisional. */
export function stopDecisionForRuns(checks: readonly StopRunCheck[]): StopEvaluation {
  const runs = checks.map((c) => {
    const why = c.error ? `its proof could not be evaluated (${c.error})` : unproven(c.run, c.verdict);
    const provisional = !c.error && !!c.verdict && (c.verdict.provisional || Object.values(c.verdict.goals ?? {}).some((g) => g.provisional));
    return { run: c.run, achieved: why === null, provisional, why, ...(c.verdict ? { verdict: c.verdict } : {}) };
  });
  if (runs.length === 0) return { decision: { decision: 'allow', exitCode: 0, reason: 'no active Tecera run on this business case' }, runs };
  const blocked = runs.find((r) => r.why !== null);
  if (blocked) {
    const { run } = blocked;
    const goal = run.goalId ? ` for goal ${run.goalId}` : '';
    const others = runs.filter((r) => r.why !== null).length - 1;
    const more = others > 0 ? ` (${others} more active run${others === 1 ? '' : 's'} also unproven)` : '';
    const what = blocked.provisional ? `is provisional, never achieved: ${blocked.why}` : `is active without a goal.achieved proof (${blocked.why})`;
    return {
      decision: {
        decision: 'block',
        exitCode: 2,
        reason: `Tecera run ${run.runId}${goal} ${what}${more}. Keep working until the goal's check passes through the run (\`tecera run --resume\`, \`tecera status\`), or hand back to a human (\`tecera approve\` / \`tecera deny\`) — do not stop yet.`,
      },
      runs,
    };
  }
  const proofs = runs.map((r) => {
    const p = Object.values(r.verdict!.goals).find((g) => g.proof)!.proof!;
    return `run ${r.run.runId} proved its goal: \`${p.command}\` exited 0 on ${p.fingerprint.slice(0, 12)} (evidence ${p.evidenceKey})`;
  });
  return { decision: { decision: 'allow', exitCode: 0, reason: proofs.join('; ') }, runs };
}

/**
 * The Stop decision for one active run. `verdict` is the run's provenRun / ledgerProvenRun result; without
 * it the run is unproven, whatever `achievedProof` says (a proof is shape only: a forged goal.achieved
 * carries one). `provisional` always blocks.
 */
export function stopDecision(input: StopHookInput & { verdict?: RunVerdict | null }): StopHookDecision {
  const run = input.activeRun;
  if (!run || typeof run.runId !== 'string' || run.runId === '') return { decision: 'allow', exitCode: 0, reason: 'no active Tecera run on this business case' };
  const verdict: RunVerdict | null = input.provisional
    ? { runId: run.runId, goals: {}, why: null, ...(input.verdict ?? {}), achieved: false, provisional: true }
    : (input.verdict ?? null);
  return stopDecisionForRuns([{ run, verdict }]).decision;
}

/** Why `chain` does not vouch for the events it came with (null when it does). */
function chainProblem(chain: ChainVerdict | undefined): string | null {
  if (!chain || typeof chain !== 'object') return 'the hash chain was not verified (pass Ledger.verifyChain())';
  if (chain.ok === true) return null;
  return `the hash chain is broken at seq ${String(chain.brokenAtSeq)}${chain.reason ? ` (${chain.reason})` : ''}`;
}

/** A block that names no run: the events themselves cannot be trusted to say which runs are active. */
function ledgerBlock(why: string): StopEvaluation {
  return stopDecisionForRuns([{ run: { runId: '(ledger)' }, error: why }]);
}

/**
 * Stop over events already read (pure). `opts.chain` (Ledger.verifyChain of the ledger the events came
 * from) is required: without an intact chain the active-run set itself is untrusted (a forged run.ended
 * would hide a run), so a missing or broken chain blocks even when no run looks active.
 */
export function evaluateStopEvents(events: Iterable<TeceraEvent>, evidence: EvidenceLookup, opts: ProvenOptions): StopEvaluation {
  const broken = chainProblem(opts?.chain);
  if (broken) return ledgerBlock(broken);
  const evs = [...events];
  return stopDecisionForRuns(activeRunsOf(evs).map((run) => ({ run, verdict: provenRun(evs, evidence, run.runId, opts) })));
}

/**
 * Stop over a ledger: the hash chain first (the active-run set comes from those events), then every active
 * run through ledgerProvenRun. A ledger that cannot be read or verified blocks (fail closed), with or
 * without an active run; so does any run whose verdict throws.
 */
export async function evaluateStopLedger(ledger: Pick<Ledger, 'events' | 'getEvidence' | 'verifyChain'>, opts: Omit<ProvenOptions, 'chain'> = {}): Promise<StopEvaluation> {
  const events: TeceraEvent[] = [];
  try {
    for await (const e of ledger.events()) events.push(e);
  } catch (err) {
    return ledgerBlock(`the ledger cannot be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  let chain: ChainVerdict | undefined;
  try {
    if (typeof (ledger as Partial<Ledger>).verifyChain !== 'function') return ledgerBlock('the ledger does not support chain verification (verifyChain)');
    chain = await ledger.verifyChain();
  } catch (err) {
    return ledgerBlock(`the hash chain cannot be verified: ${err instanceof Error ? err.message : String(err)}`);
  }
  const broken = chainProblem(chain);
  if (broken) return ledgerBlock(broken);
  const checks: StopRunCheck[] = [];
  for (const run of activeRunsOf(events)) {
    try {
      checks.push({ run, verdict: await ledgerProvenRun(ledger, run.runId, opts) });
    } catch (err) {
      checks.push({ run, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return stopDecisionForRuns(checks);
}
