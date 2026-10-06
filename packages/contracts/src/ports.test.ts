import { approvalAuditProblem, approvalGrantedEvent, reconcileVerdict } from './ports.js';
import { noProgressReason } from './bdi.js';
import { validateEvent } from './events.js';
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256 } from './json.js';
import { LedgerError, commitActionHash, requireApproval, type Ledger } from './ports.js';
import { HOST_FUNCTIONS, isHandleRef, type RpcErrorCode } from './rpc.js';
import { EVENT_KINDS } from './events.js';

describe('commitActionHash', () => {
  it('is sha256(canonicalJson({intentionId, stepId, attempt, candidateD1})) with null for unknown D1', () => {
    expect(commitActionHash({ intentionId: 'i', stepId: 'c', attempt: 2, candidateD1: 'd1' })).toBe(sha256(canonicalJson({ intentionId: 'i', stepId: 'c', attempt: 2, candidateD1: 'd1' })));
    expect(commitActionHash({ intentionId: 'i', stepId: 'c', attempt: 2 })).toBe(sha256('{"attempt":2,"candidateD1":null,"intentionId":"i","stepId":"c"}'));
    expect(commitActionHash({ intentionId: 'i', stepId: 'c', attempt: 2, candidateD1: 'd1' })).not.toBe(commitActionHash({ intentionId: 'i', stepId: 'c', attempt: 2, candidateD1: 'd2' }));
    expect(commitActionHash({ intentionId: 'i', stepId: 'c', attempt: 1, candidateD1: 'd1' })).not.toBe(commitActionHash({ intentionId: 'i', stepId: 'c', attempt: 2, candidateD1: 'd1' }));
  });
});

describe('requireApproval', () => {
  it('fails closed when the ledger has no getApproval', async () => {
    await expect(requireApproval({} as Ledger, 'ap')).rejects.toThrow(LedgerError);
  });
});

describe('rpc dialect constants', () => {
  it('host functions, E_TOOL and handle refs', () => {
    expect(HOST_FUNCTIONS).toEqual({ invoke: '__invoke__', checkpoint: '__checkpoint__' });
    const code: RpcErrorCode = 'E_TOOL';
    expect(code).toBe('E_TOOL');
    expect(isHandleRef({ $handle: 'h1.run_1.3.0123456789abcdef' })).toBe(true);
    expect(isHandleRef({ $handle: 'h1.run_1.3.0123456789abcdef', x: 1 })).toBe(false);
    expect(isHandleRef({ $handle: 'nope' })).toBe(false);
  });

  it('event catalog has the wave-2 kinds and no plan.accepted', () => {
    for (const k of ['gate.ran', 'evidence.exported', 'adapters.installed', 'manifest.migrated', 'plan.graduated', 'isolation.degraded']) expect(EVENT_KINDS).toContain(k);
    expect(EVENT_KINDS as readonly string[]).not.toContain('plan.accepted');
  });
});

describe('K3 wave 3 contract additions', () => {
  const target = { requestId: 'ap1', runId: 'r', sessionId: 's', actionHash: 'h', approver: { kind: 'human' as const, id: 'nick' } };
  const ev = () => approvalGrantedEvent({ ...target, id: 'e1', at: 1, trace: { goalId: 'g', intentionId: 'i', stepId: 's' } });

  it('approvalGrantedEvent builds a valid, matching audit event with the CLI idempotency key', () => {
    const e = ev();
    expect(() => validateEvent(e)).not.toThrow();
    expect(e).toMatchObject({ kind: 'approval.granted', idemKey: 'approval.granted:ap1', actor: target.approver, runId: 'r' });
    expect(approvalAuditProblem(e, target)).toBeNull();
  });

  it('approvalAuditProblem rejects every mismatch', () => {
    expect(approvalAuditProblem({ ...ev(), kind: 'approval.denied' }, target)).toMatch(/not approval.granted/);
    expect(approvalAuditProblem({ ...ev(), payload: { ...ev().payload, requestId: 'x' } }, target)).toMatch(/another request/);
    expect(approvalAuditProblem({ ...ev(), runId: 'other' }, target)).toMatch(/another run/);
    expect(approvalAuditProblem({ ...ev(), runId: undefined }, target)).toMatch(/another run/);
    expect(approvalAuditProblem({ ...ev(), actor: { kind: 'human', id: 'eve' } }, target)).toMatch(/actor/);
    expect(approvalAuditProblem({ ...ev(), payload: { ...ev().payload, sessionId: 'z' } }, target)).toMatch(/session/);
    expect(approvalAuditProblem({ ...ev(), payload: { ...ev().payload, actionHash: 'z' } }, target)).toMatch(/action hash/);
    expect(approvalAuditProblem({ ...ev(), payload: { ...ev().payload, approver: { kind: 'human', id: 'eve' } } }, target)).toMatch(/approver/);
    expect(approvalAuditProblem({ ...ev(), payload: { ...ev().payload, approver: null } }, target)).toMatch(/approver/);
  });

  it('noProgressReason: equal non-empty fingerprints from different attempts only', () => {
    expect(noProgressReason([])).toBeNull();
    expect(noProgressReason([{ attempt: 1, fingerprint: 'a' }, { attempt: 1, fingerprint: 'a' }])).toBeNull();
    expect(noProgressReason([{ attempt: 1, fingerprint: null }, { attempt: 2, fingerprint: null }])).toBeNull();
    expect(noProgressReason([{ attempt: 1, fingerprint: '' }, { attempt: 2, fingerprint: '' }])).toBeNull();
    expect(noProgressReason([{ attempt: 1, fingerprint: 'a' }, { attempt: 2, fingerprint: 'b' }, { attempt: 3, fingerprint: 'a' }])).toMatch(/^no progress: attempts 1 and 3/);
  });

  it('reconcileVerdict accepts only a proven commit with a sha', () => {
    expect(reconcileVerdict({ recorded: true, sha: 'abc' })).toEqual({ recorded: true, sha: 'abc' });
    expect(reconcileVerdict({ recorded: true })).toMatchObject({ recorded: false });
    expect(reconcileVerdict({ recorded: false, sha: 'abc', reason: 'tree' })).toMatchObject({ recorded: false, reason: 'tree' });
    expect(reconcileVerdict({ exitCode: 0, sha: 'abc', evidenceKey: 'k' })).toEqual({ recorded: true, sha: 'abc', evidenceKey: 'k' });
    expect(reconcileVerdict({ exitCode: 0, evidenceKey: 'k' })).toMatchObject({ recorded: false });
    expect(reconcileVerdict({ exitCode: 0, sha: 'abc', evidenceKey: 'k', terminal: true })).toMatchObject({ recorded: false });
    expect(reconcileVerdict({ exitCode: 9, sha: 'abc', evidenceKey: 'k', reason: 'reconcile-tree-mismatch' })).toMatchObject({ recorded: false, reason: 'reconcile-tree-mismatch' });
    expect(reconcileVerdict(null)).toMatchObject({ recorded: false, reason: /no commit intent/ });
  });

  it('the interrupted event kinds exist with trace requirements', () => {
    expect(EVENT_KINDS).toContain('step.interrupted');
    expect(EVENT_KINDS).toContain('verify.interrupted');
    expect(() => validateEvent({ id: 'x', kind: 'step.interrupted', at: 1, actor: { kind: 'system', id: 'l' }, trace: { goalId: 'g', intentionId: 'i', stepId: 's' }, payload: {} })).toThrow(/planId/);
  });
});
