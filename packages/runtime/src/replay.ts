import { achievementProofProblem, approvalAuditProblem, commitActionHash, deriveGoalStatus, verifyCommandDigest, requireListEvidence, type AchievementGoal, type ApprovalView, type DerivedRun, type EvidenceRecord, type Json, type Ledger, type Plan, type TeceraEvent } from '@tecera/contracts';

/**
 * Offline replay: re-derive every goal's status of a run from the ledger alone (events + evidence), with
 * no model, no worktree and no loop, and compare it with what the loop recorded. A goal is derived
 * `achieved` only when one of its intentions completed EVERY step of its plan and:
 *
 * - every `gate.verify` step completed on a `verify.passed` whose evidence record says outcome 'passed',
 *   exit 0, and an unchanged tree (fingerprint = fingerprintAfter);
 * - every `gate.review` step completed on a `review.passed` whose evidence says verdict 'approve' with
 *   no findings, on the tree verify saw (fingerprintBefore = fingerprintAfter = the verify fingerprint);
 * - every `gate.commit` step completed on a valid `commit.recorded` whose evidence says outcome
 *   'committed' with D1 = D2 = D3 = the verified fingerprint (D6: commits to the work branch need no
 *   approval);
 * - every `gate.pr` step completed on a `pr.opened` or `pr.requested` for exactly the committed sha, whose
 *   approval is fully accounted for (default): an approval.requested for that step in this run, an audited
 *   approval.granted (approvalAuditProblem against the ledger's approval row: same request, run, session,
 *   action hash and approver), an approval.consumed, the ledger row in state 'consumed', and the action
 *   hash bound to this exact PR (prActionHash of intention, step, attempt and the committed sha);
 * - the goal.achieved the loop recorded carries a proof (D4) naming the goal's check, exit 0, the verified
 *   fingerprint and the verify evidence the derivation rests on;
 * - every evidence record used belongs to this run and has the gate's kind (foreign evidence is refused);
 * - the hash chain of the ledger (events and evidence) verifies. A broken chain derives NOTHING achieved;
 * - AND the kernel's offline derivation agrees (contracts deriveGoalStatus over the WHOLE ledger's events,
 *   this run's evidence and approval rows, and the ledger's chain verdict): the verify the commit rests on
 *   must have run the goal's OWN check command (commandDigest = verifyCommandDigest(goal.check.command)),
 *   within its timeout, exit 0, with a fingerprint matching its event; the commit must carry a consumed,
 *   audited human approval bound to that fingerprint. Same-run evidence of another command, another
 *   intention or another attempt cannot prove the goal.
 *
 * Otherwise it is `dropped` (an intention failed or the goal was dropped without a successful intention)
 * or `open`. `agrees` compares with the last goal.* event the loop wrote.
 */

export interface ReplayedGoal {
  derived: 'achieved' | 'dropped' | 'open';
  recorded: string;
  agrees: boolean;
  /** Why the goal is not derived achieved (per intention). */
  why: string[];
}

export interface ReplayReport {
  runId: string;
  chainValid: boolean;
  events: number;
  goals: Record<string, ReplayedGoal>;
  problems: string[];
}

type Ev = TeceraEvent & { seq?: number };
const obj = (v: Json | undefined): Record<string, Json> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Json>) : {});

export interface ReplayOptions {
  /** PRs must carry a consumed, audited human approval bound to the committed sha (D6). Default true. */
  requirePrApproval?: boolean;
  /** Deprecated alias of requirePrApproval (the approval moved from the commit to the PR, D6). */
  requireCommitApproval?: boolean;
}

export async function replayRun(ledger: Ledger, runId: string, opts: ReplayOptions = {}): Promise<ReplayReport> {
  const requireApproval = (opts.requirePrApproval ?? opts.requireCommitApproval) !== false;
  const chain = await ledger.verifyChain();
  const events: Ev[] = [];
  const plans = new Map<string, Plan>();
  const all: Array<TeceraEvent & { seq: number; hash: string }> = [];
  for await (const e of ledger.events()) {
    all.push(e);
    if (e.kind === 'plan.generated') {
      const p = (e.payload as { plan?: Plan }).plan;
      if (p?.id) plans.set(p.id, p);
    }
    if (e.runId === runId) events.push(e);
  }
  const problems: string[] = [];
  if (!chain.ok) problems.push(`hash chain broken at seq ${chain.brokenAtSeq}${chain.brokenEvidenceKey ? ` (evidence ${chain.brokenEvidenceKey})` : ''}`);
  /** Evidence of this run, of the expected kind; anything else is treated as absent. */
  const own = async (key: unknown, kind: string): Promise<EvidenceRecord | null> => {
    if (typeof key !== 'string' || !key) return null;
    const rec = await ledger.getEvidence(key);
    return rec && rec.runId === runId && rec.kind === kind ? rec : null;
  };

  const goals = new Map<string, AchievementGoal>();
  const recorded = new Map<string, string>();
  const intentions = new Map<string, { goalId: string; planId: string }>();
  for (const e of events) {
    if (e.kind === 'goal.adopted') {
      const g = (e.payload as { goal?: AchievementGoal }).goal;
      if (g?.id) {
        goals.set(g.id, g);
        recorded.set(g.id, 'open');
      }
    } else if (e.kind.startsWith('goal.') && e.trace.goalId) recorded.set(e.trace.goalId, e.kind.slice(5));
    if (e.kind === 'intention.pushed') {
      const i = (e.payload as { intention?: { id?: string; goalId?: string; planId?: string } }).intention;
      if (i?.id && i.goalId && i.planId) intentions.set(i.id, { goalId: i.goalId, planId: i.planId });
    }
  }
  const consumed = new Set(events.filter((e) => e.kind === 'approval.consumed').map((e) => String(obj(e.payload as Json).requestId ?? '')));
  const requestedFor = new Map<string, Ev>();
  for (const e of events) if (e.kind === 'approval.requested') requestedFor.set(String(obj(e.payload as Json).requestId ?? ''), e);
  const grantedFor = new Map<string, Ev>();
  for (const e of events) if (e.kind === 'approval.granted') grantedFor.set(String(obj(e.payload as Json).requestId ?? ''), e);

  /** Why the PR approval is not accounted for (null when it is). `d1` is what the grant must bind: the committed sha. */
  const approvalProblem = async (approval: string | null, iid: string, stepId: string, d1: string | null): Promise<string | null> => {
    if (approval === null) return requireApproval ? 'carries no approval request id' : null;
    const req = requestedFor.get(approval);
    if (!req || req.trace.intentionId !== iid || req.trace.stepId !== stepId) return `approval ${approval} was never requested for this step in this run`;
    const view = typeof ledger.getApproval === 'function' ? await ledger.getApproval(approval) : null;
    if (!view) return `approval ${approval} is unknown to the ledger`;
    if (view.runId !== runId) return `approval ${approval} belongs to another run`;
    if (view.state !== 'consumed') return `approval ${approval} is ${view.state}, not consumed`;
    if (!view.approver) return `approval ${approval} has no approver`;
    const granted = grantedFor.get(approval);
    if (!granted) return `approval ${approval} has no approval.granted event`;
    const audit = approvalAuditProblem(granted, { requestId: approval, runId, sessionId: view.sessionId, actionHash: view.actionHash, approver: view.approver });
    if (audit) return `approval ${approval}: ${audit}`;
    if (!consumed.has(approval)) return `approval ${approval} was never consumed`;
    const reqHash = obj(req.payload as Json).actionHash;
    if (reqHash !== view.actionHash) return `approval ${approval}: the requested action hash differs from the ledger row`;
    // The grant must bind exactly this PR: this intention's attempt when it was requested, and the sha the
    // commit put on the work branch (prActionHash = commitActionHash with candidateD1 = sha).
    const reqD1 = obj(req.payload as Json).candidateD1;
    if (typeof reqD1 !== 'string' || reqD1 !== d1) return `approval ${approval} was requested for another tree (${String(reqD1)} != ${String(d1)})`;
    const idx = events.indexOf(req);
    let attempt: number | null = null;
    for (const e of events.slice(0, idx)) {
      const it = obj(obj(e.payload as Json).intention);
      if (e.kind.startsWith('intention.') && it.id === iid && typeof it.attempt === 'number') attempt = it.attempt;
    }
    if (attempt === null || commitActionHash({ intentionId: iid, stepId, attempt, candidateD1: reqD1 }) !== view.actionHash) return `approval ${approval} is bound to another action than this PR of the committed sha`;
    return null;
  };

  // The kernel's derivation (contracts): whole chain, this run's evidence, its approval rows.
  let derivedRun: DerivedRun | null = null;
  try {
    const evidence = await requireListEvidence(ledger, runId);
    const approvals: ApprovalView[] = [];
    for (const rid of requestedFor.keys()) {
      if (!rid) continue;
      const v = typeof ledger.getApproval === 'function' ? await ledger.getApproval(rid) : null;
      if (v) approvals.push(v);
    }
    derivedRun = deriveGoalStatus(all, evidence, { chain, approvals, requirePrApproval: requireApproval });
    for (const p of derivedRun.problems) problems.push(`derivation: ${p}`);
  } catch (e) {
    problems.push(`derivation unavailable: ${(e as Error)?.message ?? String(e)}`);
  }

  const out: Record<string, ReplayedGoal> = {};
  for (const [goalId] of goals) {
    const why: string[] = [];
    let achieved = false;
    let failed = false;
    for (const [iid, meta] of intentions) {
      if (meta.goalId !== goalId) continue;
      const plan = plans.get(meta.planId);
      if (!plan) {
        why.push(`${iid}: plan ${meta.planId} not in the ledger`);
        continue;
      }
      const mine = events.filter((e) => e.trace.intentionId === iid);
      if (mine.some((e) => e.kind === 'intention.failed' || e.kind === 'intention.dropped')) failed = true;
      let ok = true;
      let d1: string | null = null;
      let verifyKey: string | null = null;
      let sha: string | null = null;
      for (const step of plan.steps) {
        const stepEvents = mine.filter((e) => e.trace.stepId === step.id);
        const done = [...stepEvents].reverse().find((e) => e.kind === 'step.completed' || e.kind === 'step.failed');
        if (!done || done.kind !== 'step.completed') {
          ok = false;
          why.push(`${iid}: step ${step.id} did not complete`);
          continue;
        }
        const before = stepEvents.slice(0, stepEvents.indexOf(done));
        if (step.kind === 'gate.verify') {
          const v = [...before].reverse().find((e) => e.kind === 'verify.passed' || e.kind === 'verify.failed');
          const rec = v?.kind === 'verify.passed' ? await own(obj(v.payload as Json).evidenceKey, 'gate.verify') : null;
          const b = obj(rec?.body);
          const vp = obj(v?.payload as Json);
          const goal = goals.get(goalId);
          const binding = rec ? verifyBindingProblem(b, vp, iid, goal) : null;
          if (!rec || b.outcome !== 'passed' || b.exitCode !== 0 || typeof b.fingerprint !== 'string' || b.fingerprint !== b.fingerprintAfter) {
            ok = false;
            why.push(`${iid}: verify step ${step.id} has no passing, unmutated verify evidence`);
          } else if (binding) {
            ok = false;
            why.push(`${iid}: verify step ${step.id}: ${binding}`);
          } else if (d1 !== null && d1 !== b.fingerprint) {
            ok = false;
            why.push(`${iid}: verify step ${step.id} saw another tree (${String(b.fingerprint)} != ${d1})`);
          } else {
            d1 = b.fingerprint as string;
            verifyKey = rec.key;
          }
        } else if (step.kind === 'gate.review') {
          const r = [...before].reverse().find((e) => e.kind === 'review.passed' || e.kind === 'review.rejected');
          const rec = r?.kind === 'review.passed' ? await own(obj(r.payload as Json).evidenceKey, 'gate.review') : null;
          const b = obj(rec?.body);
          const findings = Array.isArray(b.findings) ? b.findings.length : -1;
          if (!rec || b.verdict !== 'approve' || findings !== 0 || b.fingerprintBefore !== b.fingerprintAfter || (d1 !== null && b.fingerprintBefore !== d1)) {
            ok = false;
            why.push(`${iid}: review step ${step.id} has no approving review of the verified tree`);
          }
        } else if (step.kind === 'gate.commit') {
          const c = [...before].reverse().find((e) => e.kind === 'commit.recorded');
          const p = obj(c?.payload as Json);
          const rec = c ? await own(p.evidenceKey, 'gate.commit') : null;
          const b = obj(rec?.body);
          let fp = obj(b.fingerprints);
          // A commit reconciled after a crash (S8) is recorded from its durable intent: the D1/D2/D3 binding
          // is the intent's, and the reconciled tree must be the tree the intent named.
          if (!fp.d1 && b.reconciled === true && typeof b.intentKey === 'string') {
            const intent = await own(b.intentKey, 'gate.commit.intent');
            const ib = obj(intent?.body);
            if (intent && typeof ib.expectedTree === 'string' && ib.expectedTree === (b.tree ?? b.expectedTree) && ib.branch === b.branch) fp = obj(ib.fingerprints);
          }
          if (!c || p.valid !== true || !rec || b.outcome !== 'committed' || typeof b.sha !== 'string' || b.sha !== p.sha || !(fp.d1 && fp.d1 === fp.d2 && fp.d2 === fp.d3) || (d1 !== null && fp.d1 !== d1)) {
            ok = false;
            why.push(`${iid}: commit step ${step.id} has no valid commit of the verified and reviewed tree`);
          } else sha = b.sha;
        } else if (step.kind === 'gate.pr') {
          // D6: the PR delivers exactly the committed sha, on a consumed, audited human grant bound to it.
          const pr = [...before].reverse().find((e) => e.kind === 'pr.opened' || e.kind === 'pr.requested');
          const p = obj(pr?.payload as Json);
          const approval = typeof p.approvalRequestId === 'string' && p.approvalRequestId ? p.approvalRequestId : null;
          if (!pr || sha === null || p.sha !== sha) {
            ok = false;
            why.push(`${iid}: pr step ${step.id} has no pr.opened or pr.requested for the committed sha`);
          } else {
            const problem = await approvalProblem(approval, iid, step.id, sha);
            if (problem) {
              ok = false;
              why.push(`${iid}: pr step ${step.id} ${problem}`);
            }
          }
        }
      }
      if (!plan.steps.some((s) => s.kind === 'gate.verify')) {
        ok = false;
        why.push(`${iid}: plan has no environmental check`);
      }
      // D4: the loop's goal.achieved must carry the proof of exactly the verify this derivation rests on.
      if (ok) {
        const ach = [...events].reverse().find((e) => e.kind === 'goal.achieved' && e.trace.goalId === goalId);
        const raw = obj(ach?.payload as Json).proof;
        const proof = obj(raw);
        const bad = ach ? achievementProofProblem(raw, goals.get(goalId)?.check) : 'no goal.achieved was recorded';
        if (bad || proof.evidenceKey !== verifyKey || proof.fingerprint !== d1) {
          ok = false;
          why.push(`${iid}: the goal.achieved proof does not name the verify it rests on (${bad ?? 'another evidence key or fingerprint'})`);
        }
      }
      if (ok && !chain.ok) why.push(`${iid}: the ledger's hash chain is broken; nothing it records can be derived achieved`);
      else if (ok) achieved = true;
    }
    // Both derivations must agree on achievement; the kernel's binds the evidence to the goal's own check.
    const kernel = derivedRun?.goals[goalId];
    if (achieved && (!kernel || kernel.status !== 'achieved' || kernel.runId !== runId)) {
      achieved = false;
      why.push(...(kernel ? (kernel.runId !== runId ? [`the goal's derivation is bound to run ${kernel.runId}`] : kernel.reasons.map((r) => `derivation: ${r}`)) : ['derivation: the goal could not be derived from the ledger']));
    }
    const derived: ReplayedGoal['derived'] = achieved ? 'achieved' : failed || recorded.get(goalId) === 'dropped' ? 'dropped' : 'open';
    const rec = recorded.get(goalId) ?? 'open';
    out[goalId] = { derived, recorded: rec, agrees: derived === rec, why: achieved ? [] : why };
    if (derived !== rec) problems.push(`goal ${goalId}: replay derives ${derived}, the ledger recorded ${rec}`);
  }
  return { runId, chainValid: chain.ok, events: events.length, goals: out, problems };
}

/**
 * The verify evidence must prove THIS goal's check for THIS intention: the goal's own command (by digest
 * or literally), no longer timeout, the intention and attempt it names (when it names them) equal to the
 * verify event's, and the fingerprint the event reported.
 */
function verifyBindingProblem(b: Record<string, Json>, vp: Record<string, Json>, iid: string, goal: AchievementGoal | undefined): string | null {
  const check = goal?.check;
  if (!check || typeof check.command !== 'string' || !check.command) return 'the goal has no check command';
  if (typeof b.commandDigest === 'string') {
    if (b.commandDigest !== verifyCommandDigest(check.command)) return 'its evidence ran another command than the goal check';
  } else if (b.command !== check.command) return 'its evidence does not prove the goal check command ran';
  if (typeof b.timeoutSec === 'number' && typeof check.timeoutSec === 'number' && b.timeoutSec > check.timeoutSec) return 'its evidence ran with a longer timeout than the goal check';
  if (b.intentionId !== undefined && b.intentionId !== iid) return `its evidence belongs to intention ${String(b.intentionId)}`;
  if (typeof b.attempt === 'number' && typeof vp.attempt === 'number' && b.attempt !== vp.attempt) return `its evidence is of attempt ${b.attempt}, the event of attempt ${vp.attempt}`;
  if (typeof vp.fingerprint === 'string' && vp.fingerprint !== b.fingerprint) return 'the event reports another fingerprint than its evidence';
  return null;
}
