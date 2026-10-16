import { digest, ledgerProvenRun, prActionHash, type AchievementProof, type Json, type Ledger, type ProvenOptions, type RunRegistryEntry, type RunVerdict, type StopHookDecision, type TeceraEvent } from '@tecera/contracts';
import { evaluateStopLedger, stopDecisionForRuns, type ActiveRunRef } from '@tecera/policy';
import { stopStateOf } from './hardened/registry.js';

/**
 * The host Stop hook (D4: `tecera hook stop`, Claude Code's Stop event). The assistant may not stop while a
 * Tecera run on this business case is active without a proof that its goal was achieved:
 *
 * - active run: the latest run that started and either has not ended or whose last segment ended held for
 *   a human (exit 4, e.g. waiting at the PR gate) or interrupted (exit 130) — it can be resumed and its goal
 *   is open. A run that ended provisional (exit 10: a criterion rests on a mock) blocks too, until it or a
 *   later run of the same goal proves the goal. A run that ended any other way (achieved, failed, refused, budget) is not active,
 *   unless the approvals table still holds an open request of it: a run.ended event appended while the run
 *   waits for a human never hides it (policy heldByOpenApprovals);
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
 *
 * Hardened mode: `registry` carries the runs the run registry holds open (hardenedStopRuns). Each is an
 * active run whatever the events say, so a run.ended event, a denied or an expired approval cannot remove it;
 * the hash chain is also compared with the head checkpoint, so a truncated, restored or replaced ledger
 * blocks. The runs the events call active still count as well.
 */

/** The open registry entries as the Stop policy's active runs (a missed heartbeat reads as interrupted). */
export function hardenedStopRuns(entries: readonly RunRegistryEntry[], now: number): ActiveRunRef[] {
  return entries
    .filter((e) => e.state !== 'terminal')
    .map((e) => {
      const s = stopStateOf(e, now);
      return { runId: e.runId, ...(e.goalId ? { goalId: e.goalId } : {}), state: s.state, source: 'registry' as const, note: s.note };
    });
}

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
 * it is). Events alone prove nothing here (a pr.requested can be appended like a goal.achieved); the delivery
 * is what the PR gate itself left in the two places an appended event cannot write:
 *
 * - the approvals table: the approval the PR event names belongs to this run, was granted by a human who is
 *   not its requester, and is CONSUMED (only the PR gate consumes it, right before it delivers; a grant that
 *   is merely granted has delivered nothing);
 * - the evidence table: the gate.pr record the PR event names is intact (digest), of this run, says the
 *   delivery succeeded (opened or requested, exit 0) for the same commit, and carries that approval with the
 *   row's action hash, which is the PR action hash of the record's intention, step, attempt and commit.
 */
export async function undeliveredProblem(ledger: Pick<Ledger, 'getApproval' | 'getEvidence'>, events: ReadonlyArray<TeceraEvent>, runId: string, goalId?: string): Promise<string | null> {
  const mine = (e: TeceraEvent): boolean => e.runId === runId && (goalId === undefined || e.trace.goalId === goalId);
  let achievedAt = -1;
  events.forEach((e, i) => {
    if (e.kind === 'goal.achieved' && mine(e)) achievedAt = i;
  });
  if (achievedAt < 0) return null;
  const prs = events.slice(0, achievedAt).filter((e) => (e.kind === 'pr.requested' || e.kind === 'pr.opened') && mine(e));
  if (!prs.length) return 'no PR was delivered before its goal.achieved';
  let why = 'its PR names no approval a human granted in the approvals table';
  for (const pr of prs) {
    const p = pr.payload as { approvalRequestId?: unknown; evidenceKey?: unknown; sha?: unknown };
    const rid = p.approvalRequestId;
    if (typeof rid !== 'string' || !rid) continue;
    let row: Awaited<ReturnType<Ledger['getApproval']>> = null;
    try {
      row = await ledger.getApproval(rid);
    } catch {
      row = null;
    }
    if (!row || row.runId !== runId || row.approver?.kind !== 'human') continue;
    if (row.approver.kind === row.requester.kind && row.approver.id === row.requester.id) continue;
    if (row.state !== 'consumed') {
      why = `its PR approval ${rid} is ${row.state} in the approvals table, not consumed: the PR gate delivered nothing on it`;
      continue;
    }
    const problem = await deliveryRecordProblem(ledger, runId, { requestId: rid, actionHash: row.actionHash }, p.evidenceKey, p.sha);
    if (problem === null) return null;
    why = `its PR has no delivery record of the PR gate (${problem})`;
  }
  return why;
}

/** Why `key` is not the gate.pr evidence of a successful delivery of `sha` on `approval` in `runId` (null when it is). */
async function deliveryRecordProblem(ledger: Pick<Ledger, 'getEvidence'>, runId: string, approval: { requestId: string; actionHash: string }, key: unknown, sha: unknown): Promise<string | null> {
  if (typeof key !== 'string' || !key) return 'the PR event names no evidence';
  if (typeof sha !== 'string' || !sha) return 'the PR event names no commit';
  let rec: Awaited<ReturnType<Ledger['getEvidence']>> = null;
  try {
    rec = await ledger.getEvidence(key);
  } catch {
    rec = null;
  }
  if (!rec) return `evidence ${key} is not in the ledger`;
  if (rec.kind !== 'gate.pr' || rec.runId !== runId) return `evidence ${key} is not a gate.pr record of this run`;
  let intact = false;
  try {
    intact = digest(rec.body) === rec.digest;
  } catch {
    intact = false;
  }
  if (!intact) return `evidence ${key} does not match its digest`;
  const b = (rec.body && typeof rec.body === 'object' && !Array.isArray(rec.body) ? rec.body : {}) as Record<string, Json>;
  if ((b.outcome !== 'opened' && b.outcome !== 'requested') || b.exitCode !== 0) return `evidence ${key} does not record a delivery`;
  if (b.sha !== sha) return `evidence ${key} is of another commit`;
  const a = (b.approval && typeof b.approval === 'object' && !Array.isArray(b.approval) ? b.approval : {}) as Record<string, Json>;
  if (a.requestId !== approval.requestId || a.actionHash !== approval.actionHash) return `evidence ${key} was delivered on another approval`;
  if (typeof b.intentionId !== 'string' || typeof b.stepId !== 'string' || typeof b.attempt !== 'number') return `evidence ${key} names no intention, step or attempt`;
  if (prActionHash({ intentionId: b.intentionId, stepId: b.stepId, attempt: b.attempt, sha }) !== approval.actionHash) return `approval ${approval.requestId} is not the PR approval of this commit`;
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
  /** The blocking run's goal rests on a mock (goal.provisional): never achieved, the hook keeps blocking. */
  provisional?: boolean;
}

/**
 * Evaluate the Stop hook over a ledger. The decision is @tecera/policy evaluateStopLedger: the hash chain
 * first, then every active run through contracts ledgerProvenRun (the single source of "proven achieved"; a
 * goal.achieved event or a well-formed proof alone never allows). `opts` are the manifest's allowance,
 * requireApproval and secrets (provenOptionsOf). Never considers budget.
 */
export async function evaluateStop(ledger: Ledger, opts: Omit<ProvenOptions, 'chain'> & { now?: number; registry?: ActiveRunRef[] } = {}): Promise<StopEvaluation> {
  const { now: _now, registry: _registry, ...proven } = opts;
  void _now;
  void _registry;
  const ev = await evaluateStopLedger(ledger, opts);
  // The runs policy evaluated: the active ones by their events, and the ones an open approval still holds.
  const activeOf = (runId: string | undefined): ActiveRun | null => {
    const r = ev.runs.find((x) => x.run.runId === runId)?.run as ActiveRunRef | undefined;
    return r && (r.state === 'running' || r.state === 'held' || r.state === 'interrupted') ? { runId: r.runId, ...(r.goalId ? { goalId: r.goalId } : {}), state: r.state } : null;
  };
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
    const active = runId && runId !== '(ledger)' ? activeOf(runId) : null;
    if (!blocked || !active) return { decision: ev.decision, activeRun: null, proof: null, missing: blocked?.why ?? 'no goal.achieved proof' };
    const who = `run ${active.runId}${active.goalId ? ` (goal ${active.goalId})` : ''}`;
    const state = active.state === 'held' ? 'held for a human decision' : active.state;
    const claimed = events.some((e) => e.kind === 'goal.achieved' && e.runId === active.runId);
    const open = (blocked.run as ActiveRunRef).openApprovals;
    const missing = open?.length
      ? `${who} ended on its events but approval ${open.join(', ')} is still open in the approvals table: it is held for a human decision${claimed ? `; its goal.achieved is not proven (${blocked.why})` : ' and has no goal.achieved proof'}`
      : blocked.provisional
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
      verdict = await ledgerProvenRun(ledger, p.runId, proven);
    } catch (e) {
      verdict = null;
    }
    if (verdict?.achieved) continue;
    // A later run that proves the same goal settles it: the provisional run is superseded, not resumed.
    if (p.goalId && (await provedLater(ledger, events, p.later, p.goalId, proven))) continue;
    const d = stopDecisionForRuns([{ run: { runId: p.runId, ...(p.goalId ? { goalId: p.goalId } : {}), state: 'provisional' }, verdict: verdict ? { ...verdict, provisional: true } : null }]).decision;
    const who = `run ${p.runId}${p.goalId ? ` (goal ${p.goalId})` : ''}`;
    return { decision: d, activeRun: null, proof: null, missing: `${who} is provisional, never achieved: ${verdict?.why ?? 'a criterion rests on a mocked capability'}`, provisional: true };
  }
  const proofOf = (v: RunVerdict | undefined): AchievementProof | null => (v ? (Object.values(v.goals).find((g) => g.achieved && g.proof)?.proof ?? null) : null);
  // An active run's achievement counts only once its goal was delivered: a PR the run recorded (pr.requested
  // or pr.opened) before its goal.achieved, whose approval the approvals table shows consumed and whose
  // gate.pr evidence records the delivery (undeliveredProblem). A goal.achieved, or a PR event, appended
  // while the run is held at its PR proves nothing, however well formed.
  for (const r of ev.runs) {
    const why = await undeliveredProblem(ledger, events, r.run.runId, r.run.goalId);
    if (!why) continue;
    const active = activeOf(r.run.runId);
    const missing = `run ${r.run.runId}${r.run.goalId ? ` (goal ${r.run.goalId})` : ''} claims its goal achieved before delivering it: ${why}`;
    return { decision: blockFor(missing), activeRun: active, proof: null, missing };
  }
  if (ev.runs.length) {
    const last = ev.runs[ev.runs.length - 1]!;
    const active = activeOf(last.run.runId);
    return { decision: ev.decision, activeRun: active, proof: proofOf(last.verdict), missing: null };
  }
  // Nothing active. When the latest run proved its goal, say so (the decision is allow either way).
  const latest = latestRun(events);
  if (!latest) return { decision: ev.decision, activeRun: null, proof: null, missing: null };
  let verdict: RunVerdict | undefined;
  try {
    verdict = await ledgerProvenRun(ledger, latest.runId, proven);
  } catch {
    verdict = undefined;
  }
  const proof = verdict?.achieved ? proofOf(verdict) : null;
  if (!proof) return { decision: ev.decision, activeRun: null, proof: null, missing: null };
  const reason = `run ${latest.runId} proved its goal: \`${proof.command}\` exited 0 on ${proof.fingerprint.slice(0, 12)} (evidence ${proof.evidenceKey})`;
  return { decision: { decision: 'allow', exitCode: 0, reason }, activeRun: null, proof, missing: null, provedRunId: latest.runId };
}
