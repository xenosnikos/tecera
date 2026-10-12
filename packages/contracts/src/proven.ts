import { digest, type Json } from './json.js';
import { achievementProofProblem, type AchievementGoal, type AchievementProof, type Principal } from './bdi.js';
import type { TeceraEvent } from './events.js';
import { approvalAuditProblem, LedgerError, verifyCommandDigest, type ChainVerdict, type EvidenceRecord, type Ledger } from './ports.js';
import { answerCriterionActionHash, criteriaProofProblem, isFidelity, weakestFidelity, type CriterionProof, type Fidelity, type ProvisioningAllowance } from './acceptance.js';
import { acceptedContractOf, capabilityInventoryOf, consumedProblem, fidelityFor, ledgerOrder } from './projections.js';

/**
 * The one decision "is this goal proven achieved on this ledger". The Stop hook, the run's exit status, the
 * loop's settle and replay (deriveGoalStatus) all call it, so a goal.achieved event alone (forged, stale or
 * resting on a mock) can never unblock anything. A goal is proven achieved in a run when ALL hold:
 *
 * 0. the hash chain stands: when a ChainVerdict is given (ledgerProvenRun always fetches one) it is ok;
 * 1. the goal was adopted in the run (its check is the adopted one, never the one a goal.achieved carries);
 * 2. the latest goal.achieved of the goal in the run carries a proof that passes achievementProofProblem
 *    against that check (so a proof resting on a mock never passes) with a non-empty fingerprint;
 * 3. the proof's evidenceKey names a gate.verify evidence record of this run that carries a digest its
 *    body matches, exit 0, outcome passed when stated, the goal check's command (commandDigest or command),
 *    no longer timeout, not simulated, and a non-empty fingerprint equal to the proof's;
 * 4. the latest verify.passed / verify.failed of the goal before goal.achieved is a verify.passed of this run
 *    naming that evidence key and that fingerprint;
 * 5. when the goal has a contract (criteria.* events, or criteria / contractHash on the adopted goal): the
 *    contract is accepted now (acceptedContractOf: not drafted only, not stale), the proof carries its hash
 *    and passes criteriaProofProblem; every command criterion proof ran on the proof's fingerprint and names
 *    gate.verify evidence of this run for that criterion's command, exit 0; every human criterion proof
 *    names its own answer_criterion approval of this run and goal (answerCriterionActionHash over the
 *    contract hash, the criterion and the proof's fingerprint), requested by a named actor, then an audited
 *    grant by that human who is not the requester, then consumed by Tecera, before goal.achieved; no
 *    criterion claims a fidelity stronger than the run's capability inventory (with the allowance) allows;
 *    the proof's fidelity is the weakest;
 * 6. nothing after that goal.achieved demotes, drops, re-adopts or marks the goal provisional, changes its
 *    criteria, starts new work for it (intention.pushed, step.started) or verifies another candidate.
 *
 * `provisional` is true when the latest outcome of the goal is goal.provisional (status stays open).
 * Events are folded in seq order (events without a seq, such as a candidate about to be appended, last).
 */

export type EvidenceLookup = ReadonlyMap<string, EvidenceRecord> | ReadonlyArray<EvidenceRecord> | ((key: string) => EvidenceRecord | null | undefined);

export interface AchievementVerdict {
  goalId: string;
  runId: string;
  achieved: boolean;
  /** The latest outcome of the goal is goal.provisional: every criterion proven, one on a mock. Not achieved. */
  provisional: boolean;
  /** Why it is not achieved (null when it is). */
  why: string | null;
  proof?: AchievementProof;
  achievedEventId?: string;
  verifyEventId?: string;
}

export interface ProvenOptions {
  /** Manifest acceptance.signoff 'always': a goal-file acceptance does not count. */
  requireApproval?: boolean;
  /** Ledger.verifyChain() of the ledger the events come from; not ok → nothing is achieved. */
  chain?: ChainVerdict;
  /** The manifest's provisioning allowance: a resource outside it never raises a criterion's fidelity. */
  allowance?: ProvisioningAllowance;
  /** Known secret values (containsSecret): a resource whose locator carries one never counts. */
  secrets?: (value: string) => boolean;
}

type Ev = TeceraEvent & { seq?: number };
const obj = (v: unknown): Record<string, Json> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Json>) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const FIDELITY_RANK: Record<Fidelity, number> = { real: 0, provisioned: 1, mocked: 2 };

function lookupOf(evidence: EvidenceLookup): (key: string) => EvidenceRecord | undefined {
  if (typeof evidence === 'function') return (k) => evidence(k) ?? undefined;
  if (evidence instanceof Map) return (k) => evidence.get(k);
  const m = new Map<string, EvidenceRecord>();
  for (const r of evidence as ReadonlyArray<EvidenceRecord>) m.set(r.key, r);
  return (k) => m.get(k);
}

/** Why `rec` is not intact gate.verify evidence of `runId` that ran `command` to exit 0 on `fingerprint`. */
function verifyRecordProblem(rec: EvidenceRecord | undefined, key: string, runId: string, command: string, fingerprint: string, timeoutSec?: number): string | null {
  if (!rec) return `verify evidence ${key} is not in the ledger`;
  let intact = false;
  try {
    intact = typeof rec.digest === 'string' && digest(rec.body) === rec.digest;
  } catch {
    intact = false;
  }
  if (!intact) return `verify evidence ${key} does not match its digest`;
  if (rec.runId !== runId) return `verify evidence ${key} belongs to run ${rec.runId}`;
  if (rec.kind !== 'gate.verify') return `verify evidence ${key} has kind ${rec.kind}, not gate.verify`;
  const b = obj(rec.body);
  if (typeof b.commandDigest === 'string') {
    if (b.commandDigest !== verifyCommandDigest(command)) return `verify evidence ${key} ran another command`;
  } else if (b.command !== command) return `verify evidence ${key} does not prove its command ran`;
  if (timeoutSec !== undefined && typeof b.timeoutSec === 'number' && b.timeoutSec > timeoutSec) return `verify evidence ${key} ran with a longer timeout than the check`;
  if (b.exitCode !== 0) return `verify evidence ${key} records exit ${JSON.stringify(b.exitCode ?? null)}`;
  if (b.outcome !== undefined && b.outcome !== 'passed') return `verify evidence ${key} records outcome ${JSON.stringify(b.outcome)}`;
  const fp = str(b.fingerprint);
  if (!fp) return `verify evidence ${key} names no candidate fingerprint`;
  if (fp !== fingerprint) return `verify evidence ${key} is of candidate ${fp}, not ${fingerprint}`;
  if (b.runId !== undefined && b.runId !== runId) return `verify evidence ${key} body names another run`;
  if (b.simulated !== undefined || obj(b.provenance).simulated !== undefined || String(obj(b.provenance).src ?? '').startsWith('simulated:')) return `verify evidence ${key} is simulated`;
  return null;
}

const AFTER_ACHIEVED_RESETS = new Set<string>(['goal.demoted', 'goal.dropped', 'goal.provisional', 'goal.adopted', 'criteria.drafted', 'criteria.amended', 'criteria.accepted', 'intention.pushed', 'step.started']);

export function provenAchievement(events: Iterable<TeceraEvent>, evidence: EvidenceLookup, q: { runId: string; goalId: string } & ProvenOptions): AchievementVerdict {
  const { runId, goalId } = q;
  const evs: Ev[] = ledgerOrder(events, runId);
  const lookup = lookupOf(evidence);
  const mine = evs.filter((e) => e.trace.goalId === goalId);
  let provisional = false;
  for (const e of mine) {
    if (e.kind === 'goal.provisional') provisional = true;
    else if (e.kind === 'goal.achieved' || e.kind === 'goal.demoted' || e.kind === 'goal.dropped' || e.kind === 'goal.adopted') provisional = false;
  }
  const no = (why: string, extra: Partial<AchievementVerdict> = {}): AchievementVerdict => ({ goalId, runId, achieved: false, provisional, why, ...extra });
  if (q.chain && !q.chain.ok) return no(`the ledger's hash chain is broken at seq ${q.chain.brokenAtSeq}${q.chain.brokenEvidenceKey ? ` (evidence ${q.chain.brokenEvidenceKey})` : ''}: nothing is achieved`);

  const adoptedEv = mine.find((e) => e.kind === 'goal.adopted');
  const goal = adoptedEv ? (obj(adoptedEv.payload).goal as unknown as AchievementGoal | undefined) : undefined;
  if (!goal || goal.id !== goalId || !goal.check || typeof goal.check.command !== 'string' || !goal.check.command) return no(`goal ${goalId} was not adopted with a check in run ${runId}`);

  let at = -1;
  for (let n = mine.length - 1; n >= 0; n--) if (mine[n]!.kind === 'goal.achieved') {
    at = n;
    break;
  }
  if (at < 0) return no(provisional ? `goal ${goalId} is provisional: a criterion rests on a mock` : `no goal.achieved for goal ${goalId} in run ${runId}`);
  const achievedEv = mine[at]!;
  const raw = obj(achievedEv.payload).proof as unknown;
  const shape = achievementProofProblem(raw, goal.check);
  if (shape) return no(`goal.achieved proof: ${shape}`, { achievedEventId: achievedEv.id });
  const proof = raw as AchievementProof;
  const base = { achievedEventId: achievedEv.id };

  const recWhy = verifyRecordProblem(lookup(proof.evidenceKey), proof.evidenceKey, runId, goal.check.command, proof.fingerprint, goal.check.timeoutSec);
  if (recWhy) return no(`the proof's ${recWhy}`, base);

  const lastVerify = [...mine.slice(0, at)].reverse().find((e) => e.kind === 'verify.passed' || e.kind === 'verify.failed');
  if (!lastVerify) return no('no verify ran for the goal before goal.achieved', base);
  const vp = obj(lastVerify.payload);
  if (lastVerify.kind !== 'verify.passed') return no('the latest verify before goal.achieved failed', base);
  if (vp.evidenceKey !== proof.evidenceKey) return no(`the latest verify.passed names evidence ${String(vp.evidenceKey ?? null)}, not the proof's ${proof.evidenceKey}`, base);
  if (vp.fingerprint !== proof.fingerprint) return no(`the latest verify.passed is of candidate ${String(vp.fingerprint ?? null)}, not the proof's ${proof.fingerprint}`, base);
  const rec = lookup(proof.evidenceKey)!;
  if (typeof lastVerify.seq === 'number' && rec.seq > lastVerify.seq) return no(`verify evidence ${proof.evidenceKey} was written after its verify.passed`, base);
  const verified = { ...base, verifyEventId: lastVerify.id };

  for (const e of mine.slice(at + 1)) {
    if (AFTER_ACHIEVED_RESETS.has(e.kind)) return no(`${e.kind} after goal.achieved`, verified);
    if ((e.kind === 'verify.passed' || e.kind === 'verify.failed') && obj(e.payload).fingerprint !== proof.fingerprint) return no(`${e.kind} of another candidate after goal.achieved`, verified);
  }

  const acceptance = acceptedContractOf(evs, goalId, { runId, ...(q.requireApproval ? { requireApproval: true } : {}) });
  // Any criteria.* event for the goal makes it contractual, even one acceptedContractOf ignores as malformed:
  // a broken contract fails closed, never back to the single-check path.
  const criteriaEvents = mine.some((e) => e.kind === 'criteria.drafted' || e.kind === 'criteria.accepted' || e.kind === 'criteria.amended');
  const hasContract = criteriaEvents || acceptance.state !== 'none' || (Array.isArray(goal.criteria) && goal.criteria.length > 0) || typeof goal.contractHash === 'string';
  if (hasContract) {
    if (acceptance.state !== 'accepted' || !acceptance.accepted) return no(`the goal's contract is ${acceptance.state === 'none' ? 'not drafted' : acceptance.state}, not accepted`, verified);
    const { contract, hash } = acceptance.accepted;
    // A goal file's contract is replaced only by an explicit, signed-off amendment, never by a fresh draft.
    if (typeof goal.contractHash === 'string' && goal.contractHash !== hash && acceptance.accepted.origin !== 'amended') return no(`the accepted contract ${hash} is not the goal file's ${goal.contractHash}`, verified);
    if (proof.contractHash !== hash) return no(`the proof is for contract ${String(proof.contractHash ?? null)}, the accepted one is ${hash}`, verified);
    const cp = criteriaProofProblem(contract, proof.criteria);
    if (cp) return no(cp, verified);
    const inventory = capabilityInventoryOf(evs, { runId, ...(q.allowance ? { allowance: q.allowance } : {}), ...(q.secrets ? { secrets: q.secrets } : {}) });
    const proofs = proof.criteria as CriterionProof[];
    const answered = new Set<string>();
    for (const k of contract.criteria) {
      const p = proofs.find((x) => x.criterionId === k.id)!;
      const allowed = fidelityFor(inventory, k.requires);
      if (allowed === null) return no(`criterion ${k.id} requires a capability the run lacks`, verified);
      if (FIDELITY_RANK[p.fidelity] < FIDELITY_RANK[allowed]) return no(`criterion ${k.id} claims ${p.fidelity}, the inventory allows at best ${allowed}`, verified);
      if (k.check.kind === 'command') {
        if (p.fingerprint !== proof.fingerprint) return no(`criterion ${k.id} was proven on another candidate`, verified);
        const why = verifyRecordProblem(lookup(p.evidenceKey), p.evidenceKey, runId, k.check.command, proof.fingerprint, k.check.timeoutSec);
        if (why) return no(`criterion ${k.id}: ${why}`, verified);
        const body = obj(lookup(p.evidenceKey)!.body);
        const cid = body.criterionId;
        if (cid !== undefined && cid !== k.id) return no(`criterion ${k.id}: its evidence is for criterion ${String(cid)}`, verified);
        // The fidelity the verify gate measured when the criterion ran is a ceiling: a capability relabelled
        // afterwards (a later probe, a later resource) never makes a mocked run real.
        if (isFidelity(body.fidelity) && FIDELITY_RANK[p.fidelity] < FIDELITY_RANK[body.fidelity]) return no(`criterion ${k.id} claims ${p.fidelity}, its verify evidence recorded ${body.fidelity}`, verified);
      } else {
        if (answered.has(p.evidenceKey)) return no(`criterion ${k.id}: approval ${p.evidenceKey} already answers another criterion`, verified);
        answered.add(p.evidenceKey);
        const actionHash = answerCriterionActionHash({ goalId, runId, contractHash: hash, criterionId: k.id, fingerprint: proof.fingerprint });
        const why = humanProofProblem(mine.slice(0, at), evs.slice(0, evs.indexOf(achievedEv)), p.evidenceKey, p.approver, { runId, goalId, actionHash });
        if (why) return no(`criterion ${k.id}: ${why}`, verified);
      }
    }
    const weakest = weakestFidelity(proofs.map((p) => p.fidelity));
    if (proof.fidelity !== undefined && proof.fidelity !== weakest) return no(`the proof claims fidelity ${proof.fidelity}, its criteria rest on ${weakest}`, verified);
  }
  return { goalId, runId, achieved: true, provisional: false, why: null, proof, ...verified };
}

/**
 * A human criterion proof names an answer_criterion approval of this run and goal bound to `actionHash`,
 * requested by a named actor, then granted (audited: approvalAuditProblem) by that human, who is not the
 * requester, then consumed by Tecera; all before goal.achieved (`before` holds only the events before it).
 */
function humanProofProblem(goalBefore: Ev[], before: Ev[], requestId: string, approver: string | undefined, a: { runId: string; goalId: string; actionHash: string }): string | null {
  const req = goalBefore.find((e) => e.kind === 'approval.requested' && obj(e.payload).requestId === requestId);
  if (!req) return `approval ${requestId} was never requested for the goal before goal.achieved`;
  const rp = obj(req.payload);
  const sessionId = str(rp.sessionId);
  if (rp.actionHash !== a.actionHash || !sessionId) return `approval ${requestId} is not an answer_criterion approval bound to this criterion, contract and candidate`;
  const requester: Principal | undefined = req.actor;
  if (!requester || !str(requester.id)) return `approval ${requestId} names no requester`;
  const after = before.slice(before.indexOf(req) + 1);
  const grant = after.find((e) => e.kind === 'approval.granted' && obj(e.payload).requestId === requestId);
  if (!grant) return `approval ${requestId} was never granted after its request`;
  if (grant.actor?.kind !== 'human' || grant.actor.id !== approver) return `approval ${requestId} was not granted by ${String(approver ?? null)}`;
  if (requester.kind === grant.actor.kind && requester.id === grant.actor.id) return `approval ${requestId} was granted by its requester`;
  const audit = approvalAuditProblem(grant, { requestId, runId: a.runId, sessionId, actionHash: a.actionHash, approver: grant.actor });
  if (audit) return `approval ${requestId}: ${audit}`;
  const consumed = after.slice(after.indexOf(grant) + 1).some((e) => consumedProblem(e, requestId, a.runId, a.goalId, a.actionHash, sessionId) === null);
  if (!consumed) return `approval ${requestId} was not consumed before goal.achieved`;
  return null;
}

export interface RunVerdict {
  runId: string;
  /** True when the run adopted at least one goal and every adopted goal is proven achieved. */
  achieved: boolean;
  /** True when some goal is provisional and none is unproven for another reason. */
  provisional: boolean;
  goals: Record<string, AchievementVerdict>;
  /** The first reason a goal is not achieved (null when achieved). */
  why: string | null;
}

/** provenAchievement for every goal the run adopted. Stop decisions and run exit status use this. */
export function provenRun(events: Iterable<TeceraEvent>, evidence: EvidenceLookup, runId: string, opts: ProvenOptions = {}): RunVerdict {
  const evs = [...events];
  const goalIds: string[] = [];
  for (const e of evs) if (e.runId === runId && e.kind === 'goal.adopted' && e.trace.goalId && !goalIds.includes(e.trace.goalId)) goalIds.push(e.trace.goalId);
  const goals: Record<string, AchievementVerdict> = {};
  for (const g of goalIds) goals[g] = provenAchievement(evs, evidence, { runId, goalId: g, ...opts });
  const verdicts = Object.values(goals);
  const achieved = verdicts.length > 0 && verdicts.every((v) => v.achieved);
  const open = verdicts.filter((v) => !v.achieved);
  const provisional = open.length > 0 && open.every((v) => v.provisional);
  const why = achieved ? null : verdicts.length === 0 ? `run ${runId} adopted no goal` : `goal ${open[0]!.goalId}: ${open[0]!.why}`;
  return { runId, achieved, provisional, goals, why };
}

/**
 * provenRun over a ledger: the ledger's own chain verdict (verifyChain: a broken events or evidence chain
 * proves nothing), the run's events, and the evidence every goal.achieved proof of the run names (fetched
 * with getEvidence). A ledger that cannot be read or verified throws (LedgerError); callers fail closed.
 */
export async function ledgerProvenRun(ledger: Pick<Ledger, 'events' | 'getEvidence' | 'verifyChain'>, runId: string, opts: Omit<ProvenOptions, 'chain'> = {}): Promise<RunVerdict> {
  if (typeof (ledger as Partial<Ledger>).verifyChain !== 'function') throw new LedgerError('ledger does not support chain verification (verifyChain)', 'chain');
  const chain = await ledger.verifyChain();
  const events: TeceraEvent[] = [];
  for await (const e of ledger.events({ runId })) events.push(e);
  const keys = new Set<string>();
  for (const e of events) {
    if (e.kind !== 'goal.achieved') continue;
    const p = obj(obj(e.payload).proof);
    if (str(p.evidenceKey)) keys.add(p.evidenceKey as string);
    if (Array.isArray(p.criteria)) for (const c of p.criteria) if (str(obj(c).evidenceKey) && obj(c).via !== 'human') keys.add(obj(c).evidenceKey as string);
  }
  const found = new Map<string, EvidenceRecord>();
  for (const k of keys) {
    const r = await ledger.getEvidence(k);
    if (r) found.set(k, r);
  }
  return provenRun(events, found, runId, { ...opts, chain });
}
