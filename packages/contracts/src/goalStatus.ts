import { digest, type Json, type JsonObject } from './json.js';
import { achievementProofProblem, type AchievementGoal, type AchievementProof, type Plan, type Principal } from './bdi.js';
import type { TeceraEvent } from './events.js';
import { eventsChainProblem } from './chain.js';
import { approvalAuditProblem, prActionHash, verifyCommandDigest, type ApprovalView, type ChainVerdict, type EvidenceRecord } from './ports.js';

/**
 * Offline goal derivation for replay (pure: no ledger, no worktree, no model). A goal is derived
 * `achieved` only when ALL of these hold for one of its intentions, in this run:
 *
 * 1. the hash chain is valid: the events given form an unbroken chain 1..N (pass the whole ledger) and,
 *    when the ledger's own ChainVerdict is supplied, it is ok; evidence bodies match their digests;
 * 2. the intention reached intention.done, and its latest verify before the commit is a verify.passed
 *    whose evidence record (kind 'gate.verify', same run, digest intact) ran the SAME command as the goal
 *    check (commandDigest = verifyCommandDigest(goal.check.command); a record without commandDigest must
 *    carry the identical command), within the goal's timeout, exit 0, outcome 'passed' when stated, with a
 *    fingerprint equal to the one the event reported;
 * 3. as the plan says (its plan.generated in the run; unknown plan = the strictest chain): a plan with a
 *    gate.commit needs a valid commit.recorded (with a sha) after that verify (commits need no approval,
 *    D6); a plan with a gate.pr needs, after the commit and before intention.done, a pr.opened or
 *    pr.requested for exactly that sha, preceded by the PR's approval.requested (same run, intention and pr
 *    step, actionHash = prActionHash(intention, step, attempt, sha), candidateD1 = sha), an AUDITED
 *    approval.granted (approvalAuditProblem against the request, approver a human other than the requester)
 *    and an approval.consumed — each request used by one PR only; when approval rows are supplied, the row
 *    must be 'consumed' and match the request;
 * 4. the run recorded goal.achieved for the goal with a proof (D4) that names exactly that verify: the
 *    goal's check command, exit 0, the verified fingerprint, the verify evidence key and a verification time.
 *
 * Anything missing or contradictory derives `dropped` (when the goal was dropped) or `open`, with reasons.
 */

export interface DeriveGoalOptions {
  /** Result of Ledger.verifyChain(); not ok → nothing is achieved. */
  chain?: ChainVerdict;
  /** Ledger approval rows (Ledger.getApproval) of the run; when given, a commit's row must be consumed and match. */
  approvals?: ReadonlyArray<ApprovalView>;
  /** When the plan is unknown, or has a gate.commit: a recorded commit is required (default true). */
  requireCommit?: boolean;
  /** When the plan is unknown, or has a gate.pr: a pr.opened / pr.requested for the commit is required (default true). */
  requirePr?: boolean;
  /** The PR must carry a consumed, audited human approval bound to the committed sha (default true). */
  requirePrApproval?: boolean;
  /** Deprecated alias of requirePrApproval (the approval moved from the commit to the PR, D6). */
  requireCommitApproval?: boolean;
  /** The run's goal.achieved must carry a matching proof (default true, D4). */
  requireProof?: boolean;
}

export interface DerivedGoal {
  goalId: string;
  runId: string;
  status: 'achieved' | 'dropped' | 'open';
  /** Status the loop recorded last (goal.* event): open | achieved | dropped | demoted. */
  recorded: string;
  agrees: boolean;
  /** Why it is not achieved (per intention), or what proved it. */
  reasons: string[];
  proof?: {
    intentionId: string;
    verifyEventId: string;
    verifyEvidenceKey: string;
    commitEventId?: string;
    sha?: string;
    prEventId?: string;
    prUrl?: string;
    approvalRequestId?: string;
    /** The goal.achieved proof that matched (D4). */
    achievement?: AchievementProof;
  };
}

export interface DerivedRun {
  chainValid: boolean;
  problems: string[];
  goals: Record<string, DerivedGoal>;
}

type Ev = TeceraEvent & { seq: number; hash: string };
const obj = (v: unknown): Record<string, Json> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Json>) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

export function deriveGoalStatus(events: ReadonlyArray<Ev>, evidence: ReadonlyArray<EvidenceRecord>, opts: DeriveGoalOptions = {}): DerivedRun {
  const requireCommit = opts.requireCommit !== false;
  const requirePr = opts.requirePr !== false;
  const requireApproval = opts.requirePrApproval !== undefined ? opts.requirePrApproval !== false : opts.requireCommitApproval !== false;
  const requireProof = opts.requireProof !== false;
  const problems: string[] = [];
  const chainProblem = eventsChainProblem(events);
  if (chainProblem) problems.push(chainProblem);
  if (opts.chain && !opts.chain.ok) problems.push(`ledger chain verdict: broken at seq ${opts.chain.brokenAtSeq}${opts.chain.brokenEvidenceKey ? ` (evidence ${opts.chain.brokenEvidenceKey})` : ''}`);
  const maxSeq = events.reduce((m, e) => Math.max(m, e.seq), 0);
  const ev = new Map<string, EvidenceRecord>();
  for (const r of evidence) {
    let ok = false;
    try {
      ok = digest(r.body) === r.digest;
    } catch {
      ok = false;
    }
    if (!ok) {
      problems.push(`evidence ${r.key} does not match its digest`);
      continue;
    }
    if (!(r.seq >= 0 && r.seq <= maxSeq)) {
      problems.push(`evidence ${r.key} is bound to seq ${r.seq}, beyond the events given`);
      continue;
    }
    if (ev.has(r.key)) {
      problems.push(`evidence key ${r.key} appears twice`);
      ev.delete(r.key);
      continue;
    }
    ev.set(r.key, r);
  }
  const chainValid = problems.length === 0;
  const sorted = [...events].sort((a, b) => a.seq - b.seq);

  // Goals with the check they were adopted with (the first adoption wins; a different later check is a conflict).
  const goals = new Map<string, { goal: AchievementGoal; runId: string; conflict?: string }>();
  const recorded = new Map<string, string>();
  const plans = new Map<string, Plan>();
  for (const e of sorted) {
    if (e.kind === 'plan.generated') {
      const pl = obj(e.payload).plan as unknown as Plan | undefined;
      if (pl && typeof pl.id === 'string' && Array.isArray(pl.steps) && e.runId) plans.set(`${e.runId}:${pl.id}`, pl);
    }
    const gid = e.trace.goalId;
    if (!gid) continue;
    if (e.kind === 'goal.adopted') {
      const g = obj(e.payload).goal as unknown as AchievementGoal | undefined;
      if (!g || g.id !== gid || !e.runId) continue;
      const cur = goals.get(gid);
      if (!cur) goals.set(gid, { goal: g, runId: e.runId });
      else if (cur.runId !== e.runId || cur.goal.check?.command !== g.check?.command || cur.goal.check?.timeoutSec !== g.check?.timeoutSec) cur.conflict = 'the goal was adopted twice with different checks or runs';
      recorded.set(gid, 'open');
    } else if (e.kind.startsWith('goal.')) recorded.set(gid, e.kind.slice(5));
  }

  const out: Record<string, DerivedGoal> = {};
  for (const [gid, { goal, runId, conflict }] of goals) {
    const rec = recorded.get(gid) ?? 'open';
    const reasons: string[] = [];
    let proof: DerivedGoal['proof'];
    const runEvents = sorted.filter((e) => e.runId === runId);
    const dropped = runEvents.some((e) => e.kind === 'goal.dropped' && e.trace.goalId === gid);
    if (!chainValid) reasons.push('the hash chain is not valid: nothing is achieved');
    if (conflict) reasons.push(conflict);
    const check = goal.check;
    if (!check || typeof check.command !== 'string' || !check.command) reasons.push('the goal has no check command');
    if (reasons.length === 0) {
      const intentionIds = [...new Set(runEvents.filter((e) => e.kind.startsWith('intention.') && e.trace.goalId === gid && e.trace.intentionId).map((e) => e.trace.intentionId!))];
      if (intentionIds.length === 0) reasons.push('no intention for the goal');
      for (const iid of intentionIds) {
        const planId = runEvents.find((e) => e.trace.intentionId === iid && e.trace.planId)?.trace.planId;
        const plan = planId ? plans.get(`${runId}:${planId}`) : undefined;
        const r = proveIntention(runEvents, ev, goal, runId, iid, { requireCommit, requirePr, requireApproval, requireProof, approvals: opts.approvals, plan });
        if (r.ok) {
          proof = r.proof;
          break;
        }
        reasons.push(`${iid}: ${r.why}`);
      }
    }
    const status: DerivedGoal['status'] = proof ? 'achieved' : dropped ? 'dropped' : 'open';
    out[gid] = { goalId: gid, runId, status, recorded: rec, agrees: status === rec, reasons: proof ? [`achieved by ${proof.intentionId}`] : reasons, ...(proof ? { proof } : {}) };
  }
  return { chainValid, problems, goals: out };
}

function proveIntention(
  evs: Ev[],
  evidence: Map<string, EvidenceRecord>,
  goal: AchievementGoal,
  runId: string,
  iid: string,
  o: { requireCommit: boolean; requirePr: boolean; requireApproval: boolean; requireProof: boolean; approvals?: ReadonlyArray<ApprovalView>; plan?: Plan },
): { ok: true; proof: NonNullable<DerivedGoal['proof']> } | { ok: false; why: string } {
  const mine = evs.filter((e) => e.trace.intentionId === iid && e.trace.goalId === goal.id);
  const done = mine.find((e) => e.kind === 'intention.done');
  if (!done) return { ok: false, why: 'the intention never reached intention.done' };
  const kinds = o.plan ? new Set(o.plan.steps.map((s) => s.kind)) : undefined;
  const needCommit = o.requireCommit && (kinds ? kinds.has('gate.commit') : true);
  const needPr = o.requirePr && (kinds ? kinds.has('gate.pr') : true);

  /** The verify the commit (or the end) rests on: the latest verify.* before `beforeSeq`, which must pass and match the goal check. */
  const verifiedBefore = (beforeSeq: number): { ok: true; event: Ev; key: string; fingerprint: string } | { ok: false; why: string } => {
    const last = [...mine].reverse().find((e) => (e.kind === 'verify.passed' || e.kind === 'verify.failed') && e.seq < beforeSeq);
    if (!last) return { ok: false, why: 'no verify ran before it' };
    if (last.kind !== 'verify.passed') return { ok: false, why: 'the latest verify before it failed' };
    const p = obj(last.payload);
    const key = str(p.evidenceKey);
    if (!key) return { ok: false, why: 'verify.passed names no evidence' };
    const rec = evidence.get(key);
    if (!rec) return { ok: false, why: `verify evidence ${key} is missing or invalid` };
    if (rec.runId !== runId) return { ok: false, why: `verify evidence ${key} belongs to run ${rec.runId}` };
    if (rec.kind !== 'gate.verify') return { ok: false, why: `verify evidence ${key} has kind ${rec.kind}, not gate.verify` };
    if (rec.seq > last.seq) return { ok: false, why: `verify evidence ${key} was written after its verify.passed` };
    const b = obj(rec.body);
    const want = verifyCommandDigest(goal.check.command);
    if (typeof b.commandDigest === 'string') {
      if (b.commandDigest !== want) return { ok: false, why: `verify evidence ${key} ran another command than the goal check` };
    } else if (b.command !== goal.check.command) return { ok: false, why: `verify evidence ${key} does not prove the goal check command ran` };
    if (typeof b.timeoutSec === 'number' && b.timeoutSec > goal.check.timeoutSec) return { ok: false, why: `verify evidence ${key} ran with a longer timeout than the goal check` };
    if (b.exitCode !== 0) return { ok: false, why: `verify evidence ${key} records exit ${JSON.stringify(b.exitCode ?? null)}` };
    if (b.outcome !== undefined && b.outcome !== 'passed') return { ok: false, why: `verify evidence ${key} records outcome ${JSON.stringify(b.outcome)}` };
    const fp = str(b.fingerprint);
    if (!fp) return { ok: false, why: `verify evidence ${key} has no fingerprint` };
    if (typeof p.fingerprint === 'string' && p.fingerprint !== fp) return { ok: false, why: `verify.passed fingerprint differs from its evidence ${key}` };
    if (b.runId !== undefined && b.runId !== runId) return { ok: false, why: `verify evidence ${key} body names another run` };
    return { ok: true, event: last, key, fingerprint: fp };
  };

  /** D4: the run's goal.achieved must carry a proof naming exactly this verify. */
  const achievedProof = (v: { key: string; fingerprint: string }): { ok: true; proof?: AchievementProof } | { ok: false; why: string } => {
    if (!o.requireProof) return { ok: true };
    const achieved = evs.filter((e) => e.kind === 'goal.achieved' && e.trace.goalId === goal.id && e.runId === runId);
    if (achieved.length === 0) return { ok: false, why: 'no goal.achieved with a proof was recorded' };
    let why = 'goal.achieved carries no proof';
    for (const a of achieved) {
      const pr = obj(a.payload).proof as unknown as AchievementProof | undefined;
      const problem = achievementProofProblem(pr, goal.check);
      if (problem) {
        why = `goal.achieved proof: ${problem}`;
        continue;
      }
      if (pr!.evidenceKey !== v.key || pr!.fingerprint !== v.fingerprint) {
        why = `goal.achieved proof names verify ${pr!.evidenceKey} / ${pr!.fingerprint}, not the final verify ${v.key} / ${v.fingerprint}`;
        continue;
      }
      return { ok: true, proof: pr! };
    }
    return { ok: false, why };
  };

  const finish = (base: NonNullable<DerivedGoal['proof']>, v: { key: string; fingerprint: string }): { ok: true; proof: NonNullable<DerivedGoal['proof']> } | { ok: false; why: string } => {
    const a = achievedProof(v);
    if (!a.ok) return a;
    return { ok: true, proof: { ...base, ...(a.proof ? { achievement: a.proof } : {}) } };
  };

  if (!needCommit) {
    const v = verifiedBefore(done.seq);
    return v.ok ? finish({ intentionId: iid, verifyEventId: v.event.id, verifyEvidenceKey: v.key }, v) : { ok: false, why: v.why };
  }
  const commits = mine.filter((e) => e.kind === 'commit.recorded' && obj(e.payload).valid !== false && str(obj(e.payload).sha) && e.seq < done.seq);
  if (commits.length === 0) return { ok: false, why: 'no valid commit.recorded' };
  const usedRequests = new Map<string, number>();
  for (const c of evs) {
    const rid = c.kind === 'pr.opened' || c.kind === 'pr.requested' ? str(obj(c.payload).approvalRequestId) : undefined;
    if (rid) usedRequests.set(rid, (usedRequests.get(rid) ?? 0) + 1);
  }
  let lastWhy = 'no commit could be proven';
  for (const c of commits) {
    const cp = obj(c.payload);
    const sha = String(cp.sha);
    const v = verifiedBefore(c.seq);
    if (!v.ok) {
      lastWhy = `commit ${sha}: ${v.why}`;
      continue;
    }
    const base = { intentionId: iid, verifyEventId: v.event.id, verifyEvidenceKey: v.key, commitEventId: c.id, sha };
    if (!needPr) {
      const f = finish(base, v);
      if (f.ok) return f;
      lastWhy = `commit ${sha}: ${f.why}`;
      continue;
    }
    const prs = mine.filter((e) => (e.kind === 'pr.opened' || e.kind === 'pr.requested') && e.seq > c.seq && e.seq < done.seq && str(obj(e.payload).sha) === sha);
    if (prs.length === 0) {
      lastWhy = `commit ${sha}: no pr.opened or pr.requested for it`;
      continue;
    }
    for (const pr of prs) {
      const pp = obj(pr.payload);
      const prBase = { ...base, prEventId: pr.id, ...(str(pp.url) ? { prUrl: str(pp.url)! } : {}) };
      if (!o.requireApproval) {
        const f = finish(prBase, v);
        if (f.ok) return f;
        lastWhy = `commit ${sha}: ${f.why}`;
        continue;
      }
      const a = approvalBefore(evs, pr, sha, runId, iid, usedRequests, o.approvals);
      if (!a.ok) {
        lastWhy = `commit ${sha}: ${a.why}`;
        continue;
      }
      const f = finish({ ...prBase, approvalRequestId: a.requestId }, v);
      if (f.ok) return f;
      lastWhy = `commit ${sha}: ${f.why}`;
    }
  }
  return { ok: false, why: lastWhy };
}

/** The PR event `c` rests on an audited human approval bound to the committed sha (D6), consumed before it. */
function approvalBefore(
  evs: Ev[],
  c: Ev,
  sha: string,
  runId: string,
  iid: string,
  used: Map<string, number>,
  rows?: ReadonlyArray<ApprovalView>,
): { ok: true; requestId: string } | { ok: false; why: string } {
  const rid = str(obj(c.payload).approvalRequestId);
  if (!rid) return { ok: false, why: 'the PR names no approval' };
  if ((used.get(rid) ?? 0) > 1) return { ok: false, why: `approval ${rid} is claimed by more than one PR` };
  const before = evs.filter((e) => e.seq < c.seq && obj(e.payload).requestId === rid);
  const req = before.find((e) => e.kind === 'approval.requested');
  if (!req) return { ok: false, why: `approval ${rid} was never requested before the PR` };
  if (req.runId !== runId || req.trace.intentionId !== iid || req.trace.stepId !== c.trace.stepId) return { ok: false, why: `approval ${rid} was requested for another run, intention or step` };
  const rp = obj(req.payload);
  const actionHash = str(rp.actionHash);
  const sessionId = str(rp.sessionId);
  if (!actionHash || !sessionId) return { ok: false, why: `approval request ${rid} lacks its action hash or session` };
  const bound = rp.candidateD1 === undefined ? null : rp.candidateD1;
  if (bound !== sha) return { ok: false, why: `approval ${rid} is bound to ${String(bound)}, not the committed ${sha}` };
  const attempt = typeof rp.attempt === 'number' ? rp.attempt : attemptAt(evs, iid, req.seq);
  if (attempt === undefined || prActionHash({ intentionId: iid, stepId: c.trace.stepId!, attempt, sha }) !== actionHash) return { ok: false, why: `approval ${rid} action hash is not bound to this PR` };
  const grants = before.filter((e) => e.kind === 'approval.granted' && e.seq > req.seq);
  const requester = req.actor;
  const audited = grants.find((g) => {
    if (g.actor?.kind !== 'human' || sameActor(g.actor, requester)) return false;
    return approvalAuditProblem(g, { requestId: rid, runId, sessionId, actionHash, approver: g.actor }) === null;
  });
  if (!audited) return { ok: false, why: `approval ${rid} has no audited human grant before the PR` };
  const consumed = before.find((e) => e.kind === 'approval.consumed' && e.seq > audited.seq);
  if (!consumed) return { ok: false, why: `approval ${rid} was not consumed before the PR` };
  if (rows) {
    const row = rows.find((r) => r.requestId === rid);
    if (!row) return { ok: false, why: `approval ${rid} has no ledger row` };
    if (row.state !== 'consumed') return { ok: false, why: `approval ${rid} row is ${row.state}, not consumed` };
    if (row.runId !== runId || row.sessionId !== sessionId || row.actionHash !== actionHash) return { ok: false, why: `approval ${rid} row does not match its request` };
    if (!row.approver || !sameActor(row.approver, audited.actor)) return { ok: false, why: `approval ${rid} row approver differs from the audited grant` };
  }
  return { ok: true, requestId: rid };
}

function sameActor(a: Principal | undefined, b: Principal | undefined): boolean {
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}

/** The intention's attempt as of `seq`: from the latest intention.* snapshot before it. */
function attemptAt(evs: Ev[], iid: string, seq: number): number | undefined {
  let attempt: number | undefined;
  for (const e of evs) {
    if (e.seq >= seq) break;
    if (!e.kind.startsWith('intention.') || e.trace.intentionId !== iid) continue;
    const it = obj(e.payload).intention as JsonObject | undefined;
    if (it && typeof it.attempt === 'number') attempt = it.attempt;
  }
  return attempt;
}

// ---------- stop hook inputs (D4) ----------

/**
 * The latest run that started and has not ended (no run.ended for it), from a ledger's events in order;
 * null when there is none. A run that was interrupted (run.interrupted) still counts as active: it can be
 * resumed and its goal is not achieved.
 */
export function activeRunOf(events: Iterable<TeceraEvent>): { runId: string; goalId?: string } | null {
  const started: string[] = [];
  const ended = new Set<string>();
  const goalOf = new Map<string, string>();
  for (const e of events) {
    if (!e.runId) continue;
    if (e.kind === 'run.started') started.push(e.runId);
    else if (e.kind === 'run.ended') ended.add(e.runId);
    else if (e.kind === 'goal.adopted' && e.trace.goalId && !goalOf.has(e.runId)) goalOf.set(e.runId, e.trace.goalId);
  }
  for (let n = started.length - 1; n >= 0; n--) {
    const runId = started[n]!;
    if (ended.has(runId)) continue;
    const goalId = goalOf.get(runId);
    return { runId, ...(goalId ? { goalId } : {}) };
  }
  return null;
}

/**
 * The proof of the latest goal.achieved of `runId` (optionally of one goal) that is well formed and not
 * followed by a demotion or drop of that goal in the run; null when there is none, or when any goal the run
 * adopted (in scope) has no such proof.
 */
export function achievedProofOf(events: Iterable<TeceraEvent>, runId: string, goalId?: string): AchievementProof | null {
  const proofs = new Map<string, AchievementProof | null>();
  for (const e of events) {
    if (e.runId !== runId || !e.trace.goalId || (goalId !== undefined && e.trace.goalId !== goalId)) continue;
    if (e.kind === 'goal.achieved') {
      const p = obj(e.payload).proof as unknown;
      const goal = obj(e.payload).goal as unknown as Partial<AchievementGoal> | undefined;
      proofs.set(e.trace.goalId, achievementProofProblem(p, goal?.check) === null ? (p as AchievementProof) : null);
    } else if (e.kind === 'goal.demoted' || e.kind === 'goal.dropped' || e.kind === 'goal.adopted') proofs.set(e.trace.goalId, null);
  }
  let out: AchievementProof | null = null;
  for (const p of proofs.values()) {
    if (!p) return null;
    out = p;
  }
  return out;
}
