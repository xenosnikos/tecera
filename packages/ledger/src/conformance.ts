import { describe, expect, it } from 'vitest';
import { LedgerError, approvalGrantedEvent, prActionHash, deriveGoalStatus, event, eventsChainProblem, verifyCommandDigest, type ApprovalGrant, type JsonObject, type Ledger, type Principal } from '@tecera/contracts';
import { projectBeliefs, whyChain } from './projections.js';

const sys: Principal = { kind: 'system', id: 'loop' };
const agent: Principal = { kind: 'agent', id: 'worker' };
const human: Principal = { kind: 'human', id: 'nick' };

let auditSeq = 0;
/** Approve with the matching approval.granted audit event (recorded atomically with the grant). */
export function grantAudited(l: Ledger, requestId: string, approver: Principal, sessionId: string, at: number, o: { runId?: string; actionHash: string; idemKey?: string }): Promise<ApprovalGrant> {
  const audit = approvalGrantedEvent({
    id: `audit_${requestId}_${++auditSeq}`,
    at,
    requestId,
    runId: o.runId ?? 'r',
    sessionId,
    actionHash: o.actionHash,
    approver,
    trace: { goalId: 'g', intentionId: 'i', stepId: 's' },
    ...(o.idemKey ? { idemKey: o.idemKey } : {}),
  });
  return l.approve(requestId, approver, sessionId, at, audit);
}

/** Shared conformance suite: every Ledger implementation must pass it. */
export function ledgerConformance(name: string, make: () => Promise<Ledger> | Ledger): void {
  describe(`${name} conformance`, () => {
    it('appends events, chains hashes, dedupes idempotency keys and ids', async () => {
      const l = await make();
      const a = await l.append(event('run.started', { id: 'e1', at: 1, actor: sys, payload: { manifestHash: 'h' }, runId: 'r1' }));
      const b = await l.append(event('belief.added', { id: 'e2', at: 2, actor: sys, payload: { key: 'k', value: 1 }, runId: 'r1', idemKey: 'ik' }));
      const dup = await l.append(event('belief.added', { id: 'e3', at: 3, actor: sys, payload: { key: 'k', value: 2 }, runId: 'r1', idemKey: 'ik' }));
      const dupId = await l.append(event('belief.added', { id: 'e2', at: 9, actor: sys, payload: { key: 'z', value: 9 }, runId: 'r1' }));
      expect(a.seq).toBe(1);
      expect(b.seq).toBe(2);
      expect(dup).toEqual({ seq: 2, hash: b.hash, duplicate: true });
      expect(dupId.duplicate).toBe(true);
      const all = [];
      for await (const e of l.events()) all.push(e);
      expect(all.map((e) => e.id)).toEqual(['e1', 'e2']);
      expect(await l.verifyChain()).toEqual({ ok: true, length: 2 });
    });

    it('rejects structurally invalid events', async () => {
      const l = await make();
      await expect(l.append({ id: 'x', kind: 'step.completed', at: 1, actor: sys, trace: {}, payload: {} })).rejects.toThrow(/requires trace/);
    });

    it('filters by run, kind and seq', async () => {
      const l = await make();
      await l.append(event('run.started', { id: 'a', at: 1, actor: sys, payload: {}, runId: 'r1' }));
      await l.append(event('run.started', { id: 'b', at: 2, actor: sys, payload: {}, runId: 'r2' }));
      await l.append(event('belief.added', { id: 'c', at: 3, actor: sys, payload: { key: 'k', value: true }, runId: 'r1' }));
      const r1 = [];
      for await (const e of l.events({ runId: 'r1' })) r1.push(e.id);
      expect(r1).toEqual(['a', 'c']);
      const beliefs = [];
      for await (const e of l.events({ kinds: ['belief.added'] })) beliefs.push(e.id);
      expect(beliefs).toEqual(['c']);
      const since = [];
      for await (const e of l.events({ sinceSeq: 2 })) since.push(e.id);
      expect(since).toEqual(['c']);
    });

    it('beliefs are a projection of the log', async () => {
      const l = await make();
      await l.append(event('belief.added', { id: '1', at: 1, actor: sys, payload: { key: 'verify.baseline', value: 'failing' } }));
      await l.append(event('belief.added', { id: '2', at: 2, actor: sys, payload: { key: 'files.changed', value: 0 } }));
      await l.append(event('belief.added', { id: '3', at: 3, actor: sys, payload: { key: 'files.changed', value: 1 } }));
      await l.append(event('belief.removed', { id: '4', at: 4, actor: sys, payload: { key: 'verify.baseline' } }));
      const p = await projectBeliefs(l);
      expect(p.snapshot()).toEqual({ 'files.changed': 1 });
      expect(p.invalidated().map((b) => `${b.key}=${JSON.stringify(b.value)}`)).toEqual(['files.changed=0', 'verify.baseline="failing"']);
      expect(p.match({ key: 'files.changed', equals: 1 })).toBe(true);
      expect(p.match({ key: 'verify.baseline', exists: false })).toBe(true);
    });

    it('evidence is idempotent on key and refuses a different body', async () => {
      const l = await make();
      const a = await l.evidence({ key: 'verify-1', kind: 'verify', runId: 'r', body: { exit: 0 } });
      const b = await l.evidence({ key: 'verify-1', kind: 'verify', runId: 'r', body: { exit: 0 } });
      expect(b.digest).toBe(a.digest);
      await expect(l.evidence({ key: 'verify-1', kind: 'verify', runId: 'r', body: { exit: 1 } })).rejects.toThrow(LedgerError);
      expect((await l.getEvidence('verify-1'))?.body).toEqual({ exit: 0 });
      expect(await l.getEvidence('nope')).toBeNull();
    });

    it('reservations never oversubscribe a pool under concurrency', async () => {
      const l = await make();
      await l.openBudget('r', 'usd', 10);
      const results = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => l.reserve('usd', 1, 'r', `k${i}`)));
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      expect(ok).toBe(10);
      for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(LedgerError);
      await expect(l.reserve('usd', 1, 'r', 'late')).rejects.toThrow(/budget exceeded/);
      const again = await l.reserve('usd', 1, 'r', 'k0'); // idempotent replay
      expect(again.pool).toBe('usd');
      await expect(l.reserve('usd', 1, 'r-other', 'x')).rejects.toThrow(/no budget opened/);
    });

    it('settling at a lower actual frees budget', async () => {
      const l = await make();
      await l.openBudget('r', 'tokens', 100);
      const res = await l.reserve('tokens', 100, 'r', 'a');
      await expect(l.reserve('tokens', 1, 'r', 'b')).rejects.toThrow(LedgerError);
      await l.settle(res.id, 40);
      await expect(l.reserve('tokens', 60, 'r', 'c')).resolves.toBeDefined();
      await expect(l.settle(res.id, 40)).rejects.toThrow(/not in reserved state/);
    });

    it('leases are exclusive, fenced and renewable only by the holder', async () => {
      const l = await make();
      const a = await l.lease('worktree', 'run-a', 60_000);
      expect(a?.fencingToken).toBe(1);
      expect(await l.lease('worktree', 'run-b', 60_000)).toBeNull();
      const renewed = await l.renew(a!, 60_000);
      expect(renewed.fencingToken).toBe(1);
      await l.release(a!);
      const b = await l.lease('worktree', 'run-b', 60_000);
      expect(b?.fencingToken).toBe(2);
      await expect(l.renew(a!, 1000)).rejects.toThrow(LedgerError);
    });

    it('approvals: self-approval, non-human, expiry, wrong session, replay, hash mismatch all fail', async () => {
      const l = await make();
      const req = { requestId: 'ap1', runId: 'r', sessionId: 's1', actionHash: 'h1', requester: agent, reason: 'commit', expiresAt: 1000 };
      await l.requestApproval(req);
      await expect(l.approve('ap1', agent, 's1', 10)).rejects.toThrow(/own request/);
      await expect(l.approve('ap1', { kind: 'agent', id: 'other' }, 's1', 10)).rejects.toThrow(/only a human/);
      await expect(l.approve('ap1', human, 's2', 10)).rejects.toThrow(/another session/);
      await expect(l.approve('nope', human, 's1', 10)).rejects.toThrow(/unknown/);
      const grant = await grantAudited(l, 'ap1', human, 's1', 10, { actionHash: 'h1' });
      expect(grant.approver).toEqual(human);
      await expect(l.approve('ap1', human, 's1', 11)).rejects.toThrow(/is granted/);
      await expect(l.consume('ap1', 'h2', 's1', 'c1', 20)).rejects.toThrow(/hash mismatch/);
      await expect(l.consume('ap1', 'h1', 's2', 'c1', 20)).rejects.toThrow(/session mismatch/);
      await expect(l.consume('ap1', 'h1', 's1', 'c1', 5000)).rejects.toThrow(/expired/);
      await l.consume('ap1', 'h1', 's1', 'c1', 20);
      await expect(l.consume('ap1', 'h1', 's1', 'c2', 21)).rejects.toThrow(/state is consumed/);
      // expired before approval
      await l.requestApproval({ ...req, requestId: 'ap2' });
      await expect(l.approve('ap2', human, 's1', 2000)).rejects.toThrow(/expired/);
      await expect(l.approve('ap2', human, 's1', 10)).rejects.toThrow(/is expired/);
      // deny
      await l.requestApproval({ ...req, requestId: 'ap3' });
      await l.deny('ap3', human, 'no', 10);
      await expect(l.consume('ap3', 'h1', 's1', 'c3', 20)).rejects.toThrow(/state is denied/);
    });

    it('getApproval reports every state transition and never invents a row', async () => {
      const l = await make();
      expect(typeof l.getApproval).toBe('function');
      expect(await l.getApproval('nope')).toBeNull();
      const req = { requestId: 'g1', runId: 'r', sessionId: 's1', actionHash: 'h1', requester: agent, reason: 'commit', expiresAt: 1000 };
      await l.requestApproval(req);
      expect(await l.getApproval('g1')).toEqual({ requestId: 'g1', runId: 'r', sessionId: 's1', actionHash: 'h1', requester: agent, state: 'pending', expiresAt: 1000 });
      await expect(l.requestApproval(req)).rejects.toThrow(LedgerError); // duplicate request id
      await grantAudited(l, 'g1', human, 's1', 10, { actionHash: 'h1' });
      expect(await l.getApproval('g1')).toMatchObject({ state: 'granted', approver: human });
      await l.consume('g1', 'h1', 's1', 'cg1', 20);
      expect((await l.getApproval('g1'))!.state).toBe('consumed');
      await l.requestApproval({ ...req, requestId: 'g2' });
      await l.deny('g2', human, 'no', 10);
      expect(await l.getApproval('g2')).toMatchObject({ state: 'denied', approver: human });
      await l.requestApproval({ ...req, requestId: 'g3' });
      await expect(l.approve('g3', human, 's1', 5000)).rejects.toThrow(/expired/);
      expect((await l.getApproval('g3'))!.state).toBe('expired');
      await l.requestApproval({ ...req, requestId: 'g4' });
      await expect(l.deny('g4', human, 'late', 5000)).rejects.toThrow(/expired/);
      expect((await l.getApproval('g4'))!.state).toBe('expired');
      // a returned view is a copy
      const v = (await l.getApproval('g1'))!;
      v.state = 'pending';
      expect((await l.getApproval('g1'))!.state).toBe('consumed');
    });

    it('approve/deny race: exactly one transition wins, the rest are refused', async () => {
      const l = await make();
      await l.requestApproval({ requestId: 'race', runId: 'r', sessionId: 's1', actionHash: 'h', requester: agent, reason: 'x', expiresAt: 1000 });
      const results = await Promise.allSettled([
        grantAudited(l, 'race', human, 's1', 10, { actionHash: 'h' }),
        grantAudited(l, 'race', { kind: 'human', id: 'other' }, 's1', 10, { actionHash: 'h' }),
        l.deny('race', human, 'no', 10),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(LedgerError);
      const consumes = await Promise.allSettled([l.consume('race', 'h', 's1', 'ca', 20), l.consume('race', 'h', 's1', 'cb', 20)]);
      const st = (await l.getApproval('race'))!.state;
      expect(consumes.filter((r) => r.status === 'fulfilled')).toHaveLength(st === 'consumed' ? 1 : 0);
      // exactly one audit event exists, whoever won
      const granted = [];
      for await (const e of l.events({ kinds: ['approval.granted'] })) granted.push(e);
      expect(granted).toHaveLength(st === 'denied' ? 0 : 1);
    });

    it('unaudited grants are never consumable: consume refuses until a matching approval.granted event exists', async () => {
      const l = await make();
      await l.requestApproval({ requestId: 'u1', runId: 'r', sessionId: 's1', actionHash: 'h1', requester: agent, reason: 'commit', expiresAt: 1000 });
      await l.approve('u1', human, 's1', 10); // no audit event
      await expect(l.consume('u1', 'h1', 's1', 'cu1', 20)).rejects.toThrow(/unaudited grant/);
      expect((await l.getApproval('u1'))!.state).toBe('granted');
      const base = { at: 11, requestId: 'u1', runId: 'r', sessionId: 's1', actionHash: 'h1', approver: human, trace: { goalId: 'g', intentionId: 'i', stepId: 's' } };
      // events that do not match the grant do not audit it: other approver, other run, other hash, other request, wrong kind
      await l.append(approvalGrantedEvent({ ...base, id: 'x1', idemKey: 'x1', approver: { kind: 'human', id: 'mallory' } }));
      await l.append(approvalGrantedEvent({ ...base, id: 'x2', idemKey: 'x2', runId: 'other-run' }));
      await l.append(approvalGrantedEvent({ ...base, id: 'x3', idemKey: 'x3', actionHash: 'h-other' }));
      await l.append(approvalGrantedEvent({ ...base, id: 'x4', idemKey: 'x4', requestId: 'u2' }));
      await l.append(event('approval.denied', { id: 'x5', at: 11, actor: human, runId: 'r', trace: base.trace, payload: { requestId: 'u1' } }));
      await expect(l.consume('u1', 'h1', 's1', 'cu1', 20)).rejects.toThrow(/unaudited grant/);
      // the matching audit event (appended later, the CLI repair path) makes it consumable exactly once
      await l.append(approvalGrantedEvent({ ...base, id: 'ok' }));
      await l.consume('u1', 'h1', 's1', 'cu1', 20);
      expect((await l.getApproval('u1'))!.state).toBe('consumed');
      await expect(l.consume('u1', 'h1', 's1', 'cu2', 21)).rejects.toThrow(/state is consumed/);
    });

    it('approve(…, audit) records the grant and its event atomically; a mismatched or clashing audit event changes nothing', async () => {
      const l = await make();
      const req = { requestId: 'a1', runId: 'r', sessionId: 's1', actionHash: 'h1', requester: agent, reason: 'commit', expiresAt: 1000 };
      await l.requestApproval(req);
      const count = async () => {
        let n = 0;
        for await (const _ of l.events()) n++;
        return n;
      };
      const mk = (o: Partial<Parameters<typeof approvalGrantedEvent>[0]> = {}) =>
        approvalGrantedEvent({ id: 'ga', at: 10, requestId: 'a1', runId: 'r', sessionId: 's1', actionHash: 'h1', approver: human, trace: { goalId: 'g', intentionId: 'i', stepId: 's' }, ...o });
      // wrong approver in the event, wrong request, wrong kind, invalid trace: refused, still pending, nothing written
      await expect(l.approve('a1', human, 's1', 10, mk({ approver: { kind: 'human', id: 'eve' } }))).rejects.toThrow(/actor is not the approver/);
      await expect(l.approve('a1', human, 's1', 10, mk({ requestId: 'zz' }))).rejects.toThrow(/another request/);
      await expect(l.approve('a1', human, 's1', 10, { ...mk(), kind: 'approval.denied' })).rejects.toThrow(/not approval.granted/);
      await expect(l.approve('a1', human, 's1', 10, { ...mk(), trace: {} })).rejects.toThrow(LedgerError);
      // an audit event whose idemKey is already taken: refused before anything changes
      await l.append(event('belief.added', { id: 'pre', at: 1, actor: human, payload: { key: 'k', value: 1 }, idemKey: 'approval.granted:a1' }));
      await expect(l.approve('a1', human, 's1', 10, mk())).rejects.toThrow(/already recorded/);
      expect(await count()).toBe(1);
      expect((await l.getApproval('a1'))!.state).toBe('pending');
      // a good one: grant + event together
      await l.approve('a1', human, 's1', 10, mk({ idemKey: 'approval.granted:a1:v2' }));
      expect((await l.getApproval('a1'))!.state).toBe('granted');
      const granted = [];
      for await (const e of l.events({ kinds: ['approval.granted'] })) granted.push(e);
      expect(granted).toHaveLength(1);
      expect(granted[0]!.payload).toMatchObject({ requestId: 'a1', actionHash: 'h1', sessionId: 's1', approver: human });
      expect(await l.verifyChain()).toMatchObject({ ok: true });
      await l.consume('a1', 'h1', 's1', 'ca1', 20);
    });

    it('evidence is hash-chained and bound to the events head; the chain verifies across interleaved writes', async () => {
      const l = await make();
      await l.evidence({ key: 'e0', kind: 'k', runId: 'r', body: { a: 0 } });
      await l.append(event('run.started', { id: 'c1', at: 1, actor: sys, payload: {}, runId: 'r' }));
      const e1 = await l.evidence({ key: 'e1', kind: 'k', runId: 'r', body: { a: 1 } });
      await l.append(event('run.ended', { id: 'c2', at: 2, actor: sys, payload: {}, runId: 'r' }));
      await l.evidence({ key: 'e2', kind: 'k', runId: 'r', body: { a: [1, 2] } });
      expect(e1.seq).toBe(1);
      expect(await l.verifyChain()).toEqual({ ok: true, length: 2 });
    });

    it('listEvidence enumerates a run\'s evidence in chain order, filters by a literal kind prefix, and matches getEvidence', async () => {
      const l = await make();
      await l.evidence({ key: 'a', kind: 'gate.verify', runId: 'r', body: { n: 1 } });
      await l.evidence({ key: 'b', kind: 'gate.review', runId: 'r', body: { n: 2 } });
      await l.evidence({ key: 'x', kind: 'gate.verify', runId: 'other', body: { n: 3 } });
      await l.append(event('run.started', { id: 'le1', at: 1, actor: sys, payload: {}, runId: 'r' }));
      await l.evidence({ key: 'c', kind: 'step.interrupted', runId: 'r', body: { n: 4 } });
      await l.evidence({ key: 'd', kind: 'gate_verify%', runId: 'r', body: { n: 5 } });
      const all = await l.listEvidence!('r');
      expect(all.map((e) => e.key)).toEqual(['a', 'b', 'c', 'd']);
      for (const e of all) expect(e).toEqual(await l.getEvidence(e.key));
      expect((await l.listEvidence!('r', 'gate.')).map((e) => e.key)).toEqual(['a', 'b']);
      expect((await l.listEvidence!('r', 'gate_')).map((e) => e.key)).toEqual(['d']); // literal, not a LIKE pattern
      expect(await l.listEvidence!('nope')).toEqual([]);
    });

    it('the contracts chain functions verify this ledger\'s rows, and deriveGoalStatus replays an achieved run from events + listEvidence', async () => {
      const l = await make();
      const check = { command: 'node --test', timeoutSec: 30 };
      const tr = (stepId?: string) => ({ goalId: 'g', intentionId: 'i1', planId: 'p', ...(stepId ? { stepId } : {}) });
      const ah = prActionHash({ intentionId: 'i1', stepId: 'pr', attempt: 1, sha: 'abc' });
      let n = 0;
      const put = (kind: Parameters<typeof event>[0], payload: JsonObject, trace = {}, actor: Principal = sys) => l.append(event(kind, { id: `dg${++n}`, at: n, actor, payload, trace, runId: 'r1' }));
      await put('goal.adopted', { goal: { id: 'g', statement: 's', check, commitment: 'single-minded', status: 'open', evidence: [] } }, { goalId: 'g' });
      await put('intention.pushed', { intention: { id: 'i1', goalId: 'g', planId: 'p', commitment: 'single-minded', status: 'committed', stepStatus: {}, attempt: 1 } }, tr());
      await l.evidence({ key: 'v1', kind: 'gate.verify', runId: 'r1', body: { command: check.command, commandDigest: verifyCommandDigest(check.command), timeoutSec: 30, exitCode: 0, outcome: 'passed', fingerprint: 'fp1' } });
      const vp = await put('verify.passed', { evidenceKey: 'v1', fingerprint: 'fp1', attempt: 1 }, tr('verify'));
      await put('commit.recorded', { sha: 'abc', valid: true, d1: 'fp1' }, tr('commit'));
      await l.requestApproval({ requestId: 'ap1', runId: 'r1', sessionId: 's', actionHash: ah, requester: agent, reason: 'gate.pr', expiresAt: 1e12 });
      await put('approval.requested', { requestId: 'ap1', actionHash: ah, sessionId: 's', candidateD1: 'abc', attempt: 1 }, tr('pr'));
      await l.approve('ap1', human, 's', 10, approvalGrantedEvent({ id: 'dg-grant', at: 10, requestId: 'ap1', runId: 'r1', sessionId: 's', actionHash: ah, approver: human, trace: tr('pr') }));
      await l.consume('ap1', ah, 's', 'c-ap1', 11);
      await put('approval.consumed', { requestId: 'ap1', by: 'gate.pr' }, tr('pr'));
      await put('pr.requested', { sha: 'abc', approvalRequestId: 'ap1', branch: 'tecera/g', base: 'main', bundle: '.tecera/runs/r1/pr/abc.bundle' }, tr('pr'));
      await put('intention.done', { intention: { id: 'i1', goalId: 'g', planId: 'p', commitment: 'single-minded', status: 'done', stepStatus: {}, attempt: 1 } }, tr());
      await put('goal.achieved', { goal: { id: 'g', check }, proof: { command: check.command, exitCode: 0, fingerprint: 'fp1', evidenceKey: 'v1', verifiedAt: vp.seq } }, { goalId: 'g' });
      const events = [];
      for await (const e of l.events()) events.push(e);
      expect(eventsChainProblem(events)).toBeNull();
      const evidence = await l.listEvidence!('r1');
      const approval = (await l.getApproval('ap1'))!;
      const d = deriveGoalStatus(events, evidence, { chain: await l.verifyChain(), approvals: [approval] });
      expect(d.goals.g).toMatchObject({ status: 'achieved', agrees: true });
      // the same run with the verify evidence of another command: never achieved
      const wrong = evidence.map((e) => (e.key === 'v1' ? { ...e, body: { ...(e.body as JsonObject), commandDigest: verifyCommandDigest('true') } } : e));
      expect(deriveGoalStatus(events, wrong).goals.g!.status).toBe('open');
    });

    it('D3 soft pools: a reservation past the cap is recorded and flagged, never refused; budgetUsage reports it; re-opening never relaxes an enforced pool', async () => {
      const l = await make();
      await l.openBudget('r', 'usd', 1, { enforce: false });
      const a = await l.reserve('usd', 0.75, 'r', 's1');
      expect(a.exhausted).toBeUndefined();
      const b = await l.reserve('usd', 0.5, 'r', 's2');
      expect(b.exhausted).toEqual({ used: 0.75, cap: 1 });
      await l.settle(b.id, 0.6);
      expect(await l.budgetUsage!('r')).toEqual([{ pool: 'usd', cap: 1, used: 1.35, enforce: false, reservations: 2 }]);
      // an enforced re-open tightens it: the next over-cap reservation is refused
      await l.openBudget('r', 'usd', 5);
      await l.openBudget('r', 'usd', 5, { enforce: false });
      await expect(l.reserve('usd', 4, 'r', 's3')).rejects.toThrow(/budget exceeded/);
      expect((await l.budgetUsage!('r'))[0]).toMatchObject({ enforce: true, cap: 1 });
      // default pools are enforced
      await l.openBudget('r', 'tokens', 10);
      await expect(l.reserve('tokens', 11, 'r', 't1')).rejects.toThrow(/budget exceeded/);
      expect(await l.budgetUsage!('nope')).toEqual([]);
    });

    it('openBudget never widens a pool cap', async () => {
      const l = await make();
      await l.openBudget('r', 'usd', 1);
      await l.openBudget('r', 'usd', 100);
      await expect(l.reserve('usd', 2, 'r', 'w')).rejects.toThrow(/budget exceeded/);
      await l.openBudget('r', 'usd', 0.5);
      await expect(l.reserve('usd', 0.75, 'r', 'w2')).rejects.toThrow(/budget exceeded/);
      await expect(l.openBudget('r', 'tokens', -1)).rejects.toThrow(LedgerError);
    });

    it('accepts payloads with undefined fields (as JSON.stringify would) and reads back valid JSON', async () => {
      const l = await make();
      const payload = { intention: { id: 'i', parentIntentionId: undefined, steps: [1, undefined] } } as unknown as JsonObject;
      await l.append(event('run.started', { id: 'u1', at: 1, actor: sys, payload, runId: 'r1' }));
      const got = [];
      for await (const e of l.events()) got.push(e);
      expect(got[0]!.payload).toEqual({ intention: { id: 'i', steps: [1, null] } });
      expect('parentIntentionId' in (got[0]!.payload.intention as object)).toBe(false);
      expect(await l.verifyChain()).toEqual({ ok: true, length: 1 });
      const ev = await l.evidence({ key: 'eu', kind: 'k', runId: 'r1', body: { a: undefined, b: 1 } as unknown as JsonObject });
      expect(ev.body).toEqual({ b: 1 });
      expect((await l.getEvidence('eu'))!.body).toEqual({ b: 1 });
      const cp = await l.checkpoint('r1', 'k', { a: undefined, b: [undefined] } as unknown as JsonObject);
      expect(await l.loadCheckpoint(cp)).toEqual({ b: [null] });
    });

    it('checkpoints round-trip', async () => {
      const l = await make();
      const id = await l.checkpoint('r', 'exec-1', { vars: { a: 1 }, history: [{ turn: 1 }] });
      expect(await l.loadCheckpoint(id)).toEqual({ vars: { a: 1 }, history: [{ turn: 1 }] });
      expect(await l.loadCheckpoint('missing')).toBeNull();
    });

    it('why-chain walks step → intention → goal', async () => {
      const l = await make();
      const trace = { goalId: 'g', intentionId: 'i', planId: 'p', stepId: 's' };
      await l.append(event('goal.adopted', { id: 'g1', at: 1, actor: human, payload: {}, trace: { goalId: 'g' } }));
      await l.append(event('plan.generated', { id: 'p1', at: 2, actor: sys, payload: {}, trace: { goalId: 'g', planId: 'p' } }));
      await l.append(event('intention.pushed', { id: 'i1', at: 3, actor: sys, payload: {}, trace: { goalId: 'g', intentionId: 'i', planId: 'p' } }));
      await l.append(event('step.requested', { id: 's1', at: 4, actor: sys, payload: {}, trace }));
      await l.append(event('step.completed', { id: 's2', at: 5, actor: agent, payload: {}, trace }));
      await l.append(event('goal.adopted', { id: 'other', at: 6, actor: human, payload: {}, trace: { goalId: 'g2' } }));
      const chain = await whyChain(l, 's2');
      expect(chain.map((e) => e.id)).toEqual(['g1', 'p1', 'i1', 's1', 's2']);
    });
  });
}
