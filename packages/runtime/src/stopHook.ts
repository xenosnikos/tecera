import { ledgerProvenRun, type AchievementProof, type Json, type Ledger, type ProvenOptions, type RunVerdict, type StopHookDecision, type TeceraEvent } from '@tecera/contracts';
import { activeRunsOf, evaluateStopLedger, stopDecisionForRuns } from '@tecera/policy';

/**
 * The host Stop hook (D4: `tecera hook stop`, Claude Code's Stop event). The assistant may not stop while a
 * Tecera run on this business case is active without a proof that its goal was achieved:
 *
 * - active run: the latest run that started and either has not ended or whose last segment ended held for
 *   a human (exit 4, e.g. waiting at the PR gate) or interrupted (exit 130) — it can be resumed and its goal
 *   is open. A run that ended provisional (exit 10: a criterion rests on a mock) blocks too, until it or a
 *   later run of the same goal proves the goal. A run that ended any other way (achieved, failed, refused, budget) is not active;
 * - proof: contracts ledgerProvenRun says the goal is achieved (the verify evidence with its digest, the
 *   verify.passed it follows, the accepted contract and every criterion proof, an intact hash chain). A goal
 *   resting on a mock (goal.provisional) is never achieved: the hook keeps blocking;
 * - decision: @tecera/policy evaluateStopLedger over every active run. Block = exit 2 with
 *   `goal not achieved: <what is missing>` on
 *   stderr (Claude Code keeps the assistant working); allow = exit 0. Budget is never considered: pool usage,
 *   budget.exhausted and an exit-7 run never block (a budget-ended run is not active).
 *
 * Every decision is recorded (stop.blocked / stop.allowed). A business case whose ledger cannot be read or
 * whose hash chain does not verify blocks (fail closed); a directory that is not a business case, or one with no ledger yet, has no run.
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

/** Exit code of a run whose goal rests on a mock (errors.ts EXIT.provisional). */
const PROVISIONAL_EXIT = 10;

/** Runs whose latest run.ended says provisional (exit 10), with their first adopted goal and the runs started after them. */
function provisionalRuns(events: ReadonlyArray<TeceraEvent>): Array<{ runId: string; goalId?: string; later: string[] }> {
  const order: string[] = [];
  const last = new Map<string, number | null>();
  const goals = new Map<string, string>();
  for (const e of events) {
    if (!e.runId) continue;
    if (e.kind === 'run.started') {
      if (!last.has(e.runId)) order.push(e.runId);
      last.set(e.runId, null);
    } else if (e.kind === 'run.ended') last.set(e.runId, (e.payload as { exitCode?: unknown }).exitCode === PROVISIONAL_EXIT ? PROVISIONAL_EXIT : -1);
    else if (e.kind === 'goal.adopted' && e.trace.goalId && !goals.has(e.runId)) goals.set(e.runId, e.trace.goalId);
  }
  return [...last]
    .filter(([, x]) => x === PROVISIONAL_EXIT)
    .map(([runId]) => ({ runId, ...(goals.get(runId) ? { goalId: goals.get(runId)! } : {}), later: order.slice(order.indexOf(runId) + 1) }));
}

/** Runs (among `runIds`) that adopted `goalId`. */
function runsOfGoal(events: ReadonlyArray<TeceraEvent>, runIds: readonly string[], goalId: string): string[] {
  const want = new Set(runIds);
  const out = new Set<string>();
  for (const e of events) if (e.kind === 'goal.adopted' && e.runId && want.has(e.runId) && e.trace.goalId === goalId) out.add(e.runId);
  return runIds.filter((r) => out.has(r));
}

/** The latest run that started (any state), with its first adopted goal. */
function latestRun(events: ReadonlyArray<TeceraEvent>): { runId: string; goalId?: string } | null {
  let runId: string | undefined;
  for (const e of events) if (e.kind === 'run.started' && e.runId) runId = e.runId;
  if (!runId) return null;
  const g = events.find((e) => e.kind === 'goal.adopted' && e.runId === runId)?.trace.goalId;
  return { runId, ...(g ? { goalId: g } : {}) };
}

/** Whether a run among `later` proves `goalId` achieved (contracts ledgerProvenRun). */
async function provedLater(ledger: Ledger, events: ReadonlyArray<TeceraEvent>, later: readonly string[], goalId: string, opts: Omit<ProvenOptions, 'chain'>): Promise<boolean> {
  for (const rid of runsOfGoal(events, later, goalId)) {
    try {
      const v = await ledgerProvenRun(ledger, rid, opts);
      if (v.goals[goalId]?.achieved) return true;
    } catch {
      /* an unprovable run proves nothing */
    }
  }
  return false;
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

/** A block decision naming `missing`, worded like policy's (keep working, or hand back to a human). */
function blockFor(missing: string): StopHookDecision {
  return { decision: 'block', exitCode: 2, reason: `${missing}. Keep working until the goal's check passes through the run (\`tecera run --resume\`, \`tecera status\`), or hand back to a human (\`tecera approve\` / \`tecera deny\`) — do not stop yet.` };
}

/**
 * Why the latest goal.achieved of `runId` (for `goalId` when given) is not preceded by its delivery (null when
 * it is): a pr.requested / pr.opened of the same run and goal, recorded before it, naming an approval the
 * ledger's approvals table holds as granted or consumed by a human. The approvals table is written only by
 * the approval API, never by appending an event.
 */
export async function undeliveredProblem(ledger: Pick<Ledger, 'getApproval'>, events: ReadonlyArray<TeceraEvent>, runId: string, goalId?: string): Promise<string | null> {
  const mine = (e: TeceraEvent): boolean => e.runId === runId && (goalId === undefined || e.trace.goalId === goalId);
  let achievedAt = -1;
  events.forEach((e, i) => {
    if (e.kind === 'goal.achieved' && mine(e)) achievedAt = i;
  });
  if (achievedAt < 0) return null;
  const prs = events.slice(0, achievedAt).filter((e) => (e.kind === 'pr.requested' || e.kind === 'pr.opened') && mine(e));
  if (!prs.length) return 'no PR was delivered before its goal.achieved';
  for (const pr of prs) {
    const rid = (pr.payload as { approvalRequestId?: unknown }).approvalRequestId;
    if (typeof rid !== 'string' || !rid) continue;
    let row: Awaited<ReturnType<Ledger['getApproval']>> = null;
    try {
      row = await ledger.getApproval(rid);
    } catch {
      row = null;
    }
    if (row && (row.state === 'granted' || row.state === 'consumed') && row.approver?.kind === 'human') return null;
  }
  return 'its PR names no approval a human granted in the approvals table';
}

export interface StopEvaluation {
  decision: StopHookDecision;
  activeRun: ActiveRun | null;
  proof: AchievementProof | null;
  /** What is missing (null when allowed). */
  missing: string | null;
  /** No run is active and the latest run proved its goal: that run. */
  provedRunId?: string;
  /** The blocking run's goal rests on a mock (goal.provisional): never achieved, the hook keeps blocking. */
  provisional?: boolean;
}

/**
 * Evaluate the Stop hook over a ledger. The decision is @tecera/policy evaluateStopLedger: the hash chain
 * first, then every active run through contracts ledgerProvenRun (the single source of "proven achieved"; a
 * goal.achieved event or a well-formed proof alone never allows). `opts` are the manifest's allowance,
 * requireApproval and secrets (provenOptionsOf). Never considers budget.
 */
export async function evaluateStop(ledger: Ledger, opts: Omit<ProvenOptions, 'chain'> = {}): Promise<StopEvaluation> {
  const ev = await evaluateStopLedger(ledger, opts);
  const events: TeceraEvent[] = [];
  try {
    for await (const e of ledger.events()) events.push(e);
  } catch (e) {
    // The first read may have succeeded and this one failed (or failed part-way): never decide on a partial
    // view, whatever evaluateStopLedger said.
    const missing = `the ledger could not be read (${(e as Error).message})`;
    if (ev.decision.decision === 'block') return { decision: ev.decision, activeRun: null, proof: null, missing };
    return { decision: blockFor(missing), activeRun: null, proof: null, missing };
  }
  if (ev.decision.decision === 'block') {
    const blocked = ev.runs.find((r) => r.why !== null);
    const runId = blocked?.run.runId;
    const active = runId && runId !== '(ledger)' ? (activeRunsOf(events).find((r) => r.runId === runId) ?? null) : null;
    if (!blocked || !active) return { decision: ev.decision, activeRun: null, proof: null, missing: blocked?.why ?? 'no goal.achieved proof' };
    const who = `run ${active.runId}${active.goalId ? ` (goal ${active.goalId})` : ''}`;
    const state = active.state === 'held' ? 'held for a human decision' : active.state;
    const claimed = events.some((e) => e.kind === 'goal.achieved' && e.runId === active.runId);
    const missing = blocked.provisional
      ? `${who} is provisional, never achieved: ${blocked.why}`
      : claimed
        ? `${who} is ${state}; its goal.achieved is not proven (${blocked.why})`
        : `${who} is ${state} and has no goal.achieved proof`;
    return { decision: ev.decision, activeRun: active, proof: null, missing, ...(blocked.provisional ? { provisional: true } : {}) };
  }
  // D11: a run that ended provisional (exit 10) rests on a mock; it is never achieved, so it keeps blocking
  // although it is no longer running (policy's active-run set counts only held and interrupted runs).
  for (const p of provisionalRuns(events)) {
    let verdict: RunVerdict | null = null;
    try {
      verdict = await ledgerProvenRun(ledger, p.runId, opts);
    } catch (e) {
      verdict = null;
    }
    if (verdict?.achieved) continue;
    // A later run that proves the same goal settles it: the provisional run is superseded, not resumed.
    if (p.goalId && (await provedLater(ledger, events, p.later, p.goalId, opts))) continue;
    const d = stopDecisionForRuns([{ run: { runId: p.runId, ...(p.goalId ? { goalId: p.goalId } : {}), state: 'provisional' }, verdict: verdict ? { ...verdict, provisional: true } : null }]).decision;
    const who = `run ${p.runId}${p.goalId ? ` (goal ${p.goalId})` : ''}`;
    return { decision: d, activeRun: null, proof: null, missing: `${who} is provisional, never achieved: ${verdict?.why ?? 'a criterion rests on a mocked capability'}`, provisional: true };
  }
  const proofOf = (v: RunVerdict | undefined): AchievementProof | null => (v ? (Object.values(v.goals).find((g) => g.achieved && g.proof)?.proof ?? null) : null);
  // An active run's achievement counts only once its goal was delivered: a PR the run recorded (pr.requested
  // or pr.opened) before its goal.achieved, whose approval the ledger's approvals table shows granted by a
  // human. A goal.achieved appended while the run is held at its PR proves nothing, however well formed.
  for (const r of ev.runs) {
    const why = await undeliveredProblem(ledger, events, r.run.runId, r.run.goalId);
    if (!why) continue;
    const active = activeRunsOf(events).find((a) => a.runId === r.run.runId) ?? null;
    const missing = `run ${r.run.runId}${r.run.goalId ? ` (goal ${r.run.goalId})` : ''} claims its goal achieved before delivering it: ${why}`;
    return { decision: blockFor(missing), activeRun: active, proof: null, missing };
  }
  if (ev.runs.length) {
    const last = ev.runs[ev.runs.length - 1]!;
    const active = activeRunsOf(events).find((r) => r.runId === last.run.runId) ?? null;
    return { decision: ev.decision, activeRun: active, proof: proofOf(last.verdict), missing: null };
  }
  // Nothing active. When the latest run proved its goal, say so (the decision is allow either way).
  const latest = latestRun(events);
  if (!latest) return { decision: ev.decision, activeRun: null, proof: null, missing: null };
  let verdict: RunVerdict | undefined;
  try {
    verdict = await ledgerProvenRun(ledger, latest.runId, opts);
  } catch {
    verdict = undefined;
  }
  const proof = verdict?.achieved ? proofOf(verdict) : null;
  if (!proof) return { decision: ev.decision, activeRun: null, proof: null, missing: null };
  const reason = `run ${latest.runId} proved its goal: \`${proof.command}\` exited 0 on ${proof.fingerprint.slice(0, 12)} (evidence ${proof.evidenceKey})`;
  return { decision: { decision: 'allow', exitCode: 0, reason }, activeRun: null, proof, missing: null, provedRunId: latest.runId };
}
