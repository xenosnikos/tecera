import {
  LedgerError,
  RedactionError,
  type AppendResult,
  type ApprovalGrant,
  type ChainVerdict,
  type ApprovalRequest,
  type ApprovalView,
  type BudgetOptions,
  type EventKind,
  type EvidenceRecord,
  type Json,
  type JsonObject,
  type Ledger,
  type Lease,
  type PoolUsage,
  type Principal,
  type Redactor,
  type Reservation,
  type TeceraEvent,
} from '@tecera/contracts';

/**
 * The persistence boundary: every value the runtime, the Loop, gates, workers or the CLI hand to the
 * ledger passes through the shared contracts redactor first — event payloads, traces, actors and idempotency
 * keys; evidence keys and bodies; approval requests, approvers and denial reasons; checkpoint keys and
 * state. Redaction is deterministic, so a lookup key (evidence key, request id) is redacted the same way on
 * read. After redaction the value is checked again with containsSecret; a hit throws (fail closed: nothing
 * is written). Values the ledger stores are plain JSON (the ledger normalizes them itself).
 */
export class RedactingLedger implements Ledger {
  constructor(
    readonly inner: Ledger,
    private readonly r: Redactor,
  ) {}

  private clean<T>(value: T, what: string): T {
    const out = this.r.redactJson(value);
    const hit = this.r.containsSecret(out);
    if (hit) throw new RedactionError(`${what} still contains a ${hit} after redaction; refusing to persist it`);
    return out as unknown as T;
  }

  private text(s: string): string {
    return this.r.redactText(s);
  }

  append(e: TeceraEvent): Promise<AppendResult> {
    const red = this.clean(e, `event ${e.kind}`);
    if (red.kind !== e.kind) throw new RedactionError('event kind changed under redaction; refusing to persist it');
    return this.inner.append(red);
  }
  events(filter?: { runId?: string; kinds?: EventKind[]; sinceSeq?: number }): AsyncIterable<TeceraEvent & { seq: number; hash: string }> {
    return this.inner.events(filter);
  }
  verifyChain(): Promise<ChainVerdict> {
    return this.inner.verifyChain();
  }
  evidence(e: { key: string; kind: string; runId: string; body: Json }): Promise<EvidenceRecord> {
    return this.inner.evidence(this.clean(e, `evidence ${e.kind}`));
  }
  getEvidence(key: string): Promise<EvidenceRecord | null> {
    return this.inner.getEvidence(this.text(key));
  }
  /** Evidence enumeration (replay): forwarded; a ledger without it refuses (fail closed, never an empty list). */
  async listEvidence(runId: string, kindPrefix?: string): Promise<EvidenceRecord[]> {
    if (typeof this.inner.listEvidence !== 'function') throw new LedgerError('ledger does not support evidence enumeration (listEvidence)', 'evidence');
    return kindPrefix === undefined ? this.inner.listEvidence(runId) : this.inner.listEvidence(runId, kindPrefix);
  }
  /** The enforce flag (D3 soft pools) is forwarded unchanged: dropping it would make every pool enforced. */
  openBudget(runId: string, pool: string, cap: number, opts?: BudgetOptions): Promise<void> {
    return opts === undefined ? this.inner.openBudget(runId, pool, cap) : this.inner.openBudget(runId, pool, cap, opts);
  }
  /** Pool usage for reporting; [] when the ledger cannot report it. */
  async budgetUsage(runId: string): Promise<PoolUsage[]> {
    return typeof this.inner.budgetUsage === 'function' ? this.inner.budgetUsage(runId) : [];
  }
  reserve(pool: string, amount: number, runId: string, idemKey: string): Promise<Reservation> {
    return this.inner.reserve(pool, amount, runId, this.text(idemKey));
  }
  settle(reservationId: string, actual: number): Promise<void> {
    return this.inner.settle(reservationId, actual);
  }
  lease(resource: string, holder: string, ttlMs: number): Promise<Lease | null> {
    return this.inner.lease(resource, holder, ttlMs);
  }
  renew(lease: Lease, ttlMs: number): Promise<Lease> {
    return this.inner.renew(lease, ttlMs);
  }
  release(lease: Lease): Promise<void> {
    return this.inner.release(lease);
  }
  requestApproval(r: ApprovalRequest): Promise<ApprovalRequest> {
    return this.inner.requestApproval(this.clean(r, 'approval request'));
  }
  /**
   * The audit event (approval.granted) travels with the grant so the ledger records both atomically; it is
   * redacted like every other event and its kind must survive redaction.
   */
  approve(requestId: string, approver: Principal, sessionId: string, at: number, audit?: TeceraEvent): Promise<ApprovalGrant> {
    let red: TeceraEvent | undefined;
    if (audit !== undefined) {
      red = this.clean(audit, `event ${audit.kind}`);
      if (red.kind !== audit.kind) throw new RedactionError('event kind changed under redaction; refusing to persist it');
    }
    return red === undefined
      ? this.inner.approve(this.text(requestId), this.clean(approver, 'approver'), this.text(sessionId), at)
      : this.inner.approve(this.text(requestId), this.clean(approver, 'approver'), this.text(sessionId), at, red);
  }
  deny(requestId: string, approver: Principal, reason: string, at: number): Promise<void> {
    return this.inner.deny(this.text(requestId), this.clean(approver, 'approver'), this.text(reason), at);
  }
  consume(requestId: string, actionHash: string, sessionId: string, idemKey: string, at: number): Promise<void> {
    return this.inner.consume(this.text(requestId), actionHash, this.text(sessionId), this.text(idemKey), at);
  }
  async getApproval(requestId: string): Promise<ApprovalView | null> {
    if (typeof this.inner.getApproval !== 'function') throw new LedgerError('ledger does not support approval lookup (getApproval)', 'approval');
    return this.inner.getApproval(this.text(requestId));
  }
  checkpoint(runId: string, key: string, state: JsonObject): Promise<string> {
    return this.inner.checkpoint(runId, this.text(key), this.clean(state, 'checkpoint'));
  }
  loadCheckpoint(id: string): Promise<JsonObject | null> {
    return this.inner.loadCheckpoint(id);
  }
  close(): void {
    (this.inner as { close?: () => void }).close?.();
  }
}
