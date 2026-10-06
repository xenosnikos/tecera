import { randomUUID } from 'node:crypto';
import {
  LedgerError,
  approvalAuditProblem,
  digest as digestOf,
  normalizeJson,
  validateEvent,
  type AppendResult,
  type ApprovalGrant,
  type ApprovalRequest,
  type ApprovalView,
  type ChainVerdict,
  type EventKind,
  type EvidenceRecord,
  type Json,
  type JsonObject,
  type Ledger,
  type BudgetOptions,
  type Lease,
  type PoolUsage,
  type Principal,
  type Reservation,
  type TeceraEvent,
} from '@tecera/contracts';
import { GENESIS_HASH, chainHash, evidenceHash } from './hash.js';

type StoredEvent = TeceraEvent & { seq: number; hash: string; prevHash: string };
type StoredEvidence = EvidenceRecord & { n: number; prevHash: string; hash: string; eventHash: string };
type Approval = ApprovalRequest & {
  state: 'pending' | 'granted' | 'denied' | 'consumed' | 'expired';
  approver?: Principal;
  grantedAt?: number;
  grantedSeq?: number;
  consumeIdem?: string;
};

/**
 * In-memory ledger with the same semantics as SqliteLedger. For tests and dry runs.
 *
 * Every write path goes through insertEvent / insertEvidence, the equivalent of SQLite's BEFORE INSERT
 * triggers: an existing seq, id, idemKey or hash (events) or key (evidence) is never overwritten, it throws
 * LedgerError('append-only'). Methods that read and then write do so with no await in between, so each is
 * one critical section on the event loop (approve + its audit event included).
 */
export class MemoryLedger implements Ledger {
  private readonly log: StoredEvent[] = [];
  private readonly byIdem = new Map<string, StoredEvent>();
  private readonly byId = new Map<string, StoredEvent>();
  private readonly byHash = new Set<string>();
  private readonly ev = new Map<string, StoredEvidence>();
  private readonly evLog: StoredEvidence[] = [];
  private readonly budgets = new Map<string, { cap: number; enforce: boolean }>();
  private readonly reservations = new Map<string, Reservation & { state: 'reserved' | 'charged' | 'released'; actual?: number }>();
  private readonly byResIdem = new Map<string, string>();
  private readonly leases = new Map<string, Lease>();
  private readonly approvals = new Map<string, Approval>();
  private readonly consumeIdems = new Set<string>();
  private readonly checkpoints = new Map<string, JsonObject>();

  /** The guarded insert: the only way an event enters the log. */
  private insertEvent(n: TeceraEvent, seq = this.log.length + 1): StoredEvent {
    if (seq <= this.log.length || this.byId.has(n.id) || (n.idemKey !== undefined && this.byIdem.has(n.idemKey))) {
      throw new LedgerError('events are append-only: seq, id or idemKey already exists', 'append-only');
    }
    if (seq !== this.log.length + 1) throw new LedgerError('events are append-only: seq must extend the log', 'append-only');
    const prevHash = this.log.length ? this.log[this.log.length - 1]!.hash : GENESIS_HASH;
    const hash = chainHash(prevHash, n);
    if (this.byHash.has(hash)) throw new LedgerError('events are append-only: hash already exists', 'append-only');
    const stored: StoredEvent = { ...n, seq, hash, prevHash };
    this.log.push(stored);
    this.byId.set(n.id, stored);
    this.byHash.add(hash);
    if (n.idemKey !== undefined) this.byIdem.set(n.idemKey, stored);
    return stored;
  }

  /** The guarded insert for evidence: an existing key is never overwritten. */
  private insertEvidence(rec: EvidenceRecord): StoredEvidence {
    if (this.ev.has(rec.key)) throw new LedgerError(`evidence is append-only: key ${rec.key} already exists`, 'append-only');
    const last = this.evLog[this.evLog.length - 1];
    const n = this.evLog.length + 1;
    const prevHash = last?.hash ?? GENESIS_HASH;
    const eventHash = rec.seq > 0 ? this.log[rec.seq - 1]!.hash : GENESIS_HASH;
    const hash = evidenceHash(prevHash, { n, key: rec.key, kind: rec.kind, runId: rec.runId, digest: rec.digest, seq: rec.seq, eventHash });
    const stored: StoredEvidence = { ...rec, n, prevHash, hash, eventHash };
    this.ev.set(rec.key, stored);
    this.evLog.push(stored);
    return stored;
  }

  async append(e: TeceraEvent): Promise<AppendResult> {
    validateEvent(e);
    if (e.idemKey && this.byIdem.has(e.idemKey)) {
      const d = this.byIdem.get(e.idemKey)!;
      return { seq: d.seq, hash: d.hash, duplicate: true };
    }
    if (this.byId.has(e.id)) {
      const d = this.byId.get(e.id)!;
      return { seq: d.seq, hash: d.hash, duplicate: true };
    }
    // Store exactly what a JSON store returns (undefined fields dropped), so both ledgers agree.
    let n: TeceraEvent;
    try {
      n = normalizeEvent(e);
    } catch (err) {
      throw new LedgerError(`append failed: ${(err as Error).message}`, 'io');
    }
    const stored = this.insertEvent(n);
    return { seq: stored.seq, hash: stored.hash, duplicate: false };
  }

  async *events(filter: { runId?: string; kinds?: EventKind[]; sinceSeq?: number } = {}): AsyncIterable<TeceraEvent & { seq: number; hash: string }> {
    for (const e of [...this.log]) {
      if (filter.runId && e.runId !== filter.runId) continue;
      if (filter.sinceSeq !== undefined && e.seq <= filter.sinceSeq) continue;
      if (filter.kinds?.length && !filter.kinds.includes(e.kind)) continue;
      yield structuredClone(e);
    }
  }

  async verifyChain(): Promise<ChainVerdict> {
    let prev = GENESIS_HASH;
    for (const e of this.log) {
      if (e.prevHash !== prev || chainHash(prev, e) !== e.hash) return { ok: false, brokenAtSeq: e.seq };
      prev = e.hash;
    }
    let evPrev = GENESIS_HASH;
    for (let i = 0; i < this.evLog.length; i++) {
      const r = this.evLog[i]!;
      const broken = (reason: string): ChainVerdict => ({ ok: false, brokenAtSeq: r.seq, brokenEvidenceKey: r.key, reason });
      if (r.n !== i + 1) return broken('evidence sequence has a gap');
      if (r.prevHash !== evPrev) return broken('evidence chain link broken');
      if (digestOf(r.body) !== r.digest) return broken('evidence body does not match its digest');
      const eventHash = r.seq > 0 ? this.log[r.seq - 1]?.hash : GENESIS_HASH;
      if (eventHash === undefined || r.eventHash !== eventHash) return broken('evidence is not bound to the event at its seq');
      if (evidenceHash(evPrev, { n: r.n, key: r.key, kind: r.kind, runId: r.runId, digest: r.digest, seq: r.seq, eventHash }) !== r.hash) return broken('evidence hash mismatch');
      evPrev = r.hash;
    }
    return { ok: true, length: this.log.length };
  }

  async evidence(e: { key: string; kind: string; runId: string; body: Json }): Promise<EvidenceRecord> {
    const body = normalizeJson(e.body);
    const d = digestOf(body);
    const existing = this.ev.get(e.key);
    if (existing) {
      if (existing.digest !== d) throw new LedgerError(`evidence key ${e.key} already exists with a different body`, 'evidence');
      return publicEvidence(existing);
    }
    return publicEvidence(this.insertEvidence({ key: e.key, kind: e.kind, runId: e.runId, digest: d, body, seq: this.log.length }));
  }

  async getEvidence(key: string): Promise<EvidenceRecord | null> {
    const r = this.ev.get(key);
    return r ? publicEvidence(r) : null;
  }

  /** Every evidence record of a run in chain order, optionally only kinds starting with `kindPrefix`. */
  async listEvidence(runId: string, kindPrefix?: string): Promise<EvidenceRecord[]> {
    return this.evLog.filter((r) => r.runId === runId && (kindPrefix === undefined || r.kind.startsWith(kindPrefix))).map(publicEvidence);
  }

  /** Re-opening never widens a pool (the smaller cap wins) and never relaxes it (enforced stays enforced). */
  async openBudget(runId: string, pool: string, cap: number, opts?: BudgetOptions): Promise<void> {
    if (!(cap >= 0)) throw new LedgerError(`budget cap for ${pool} must be >= 0`, 'budget');
    const enforce = opts?.enforce !== false;
    const k = `${runId}:${pool}`;
    const cur = this.budgets.get(k);
    this.budgets.set(k, cur === undefined ? { cap, enforce } : { cap: Math.min(cur.cap, cap), enforce: cur.enforce || enforce });
  }

  private poolUsed(runId: string, pool: string): { used: number; count: number } {
    let used = 0;
    let count = 0;
    for (const r of this.reservations.values()) {
      if (r.runId !== runId || r.pool !== pool) continue;
      count++;
      if (r.state !== 'released') used += r.state === 'charged' ? (r.actual ?? r.amount) : r.amount;
    }
    return { used, count };
  }

  async budgetUsage(runId: string): Promise<PoolUsage[]> {
    const out: PoolUsage[] = [];
    for (const [k, b] of this.budgets) {
      if (!k.startsWith(`${runId}:`)) continue;
      const pool = k.slice(runId.length + 1);
      const u = this.poolUsed(runId, pool);
      out.push({ pool, cap: b.cap, used: u.used, enforce: b.enforce, reservations: u.count });
    }
    return out.sort((a, b) => a.pool.localeCompare(b.pool));
  }

  async reserve(pool: string, amount: number, runId: string, idemKey: string): Promise<Reservation> {
    if (!(amount >= 0)) throw new LedgerError('reservation amount must be >= 0', 'budget');
    const dupId = this.byResIdem.get(idemKey);
    if (dupId) {
      const r = this.reservations.get(dupId)!;
      return { id: r.id, pool: r.pool, amount: r.amount, runId: r.runId };
    }
    const b = this.budgets.get(`${runId}:${pool}`);
    if (b === undefined) throw new LedgerError(`no budget opened for pool ${pool} in run ${runId}`, 'budget');
    const { used } = this.poolUsed(runId, pool);
    const over = used + amount > b.cap;
    if (over && b.enforce) throw new LedgerError(`budget exceeded for pool ${pool}: used ${used} + ${amount} > cap ${b.cap}`, 'budget');
    const id = randomUUID();
    this.reservations.set(id, { id, pool, amount, runId, state: 'reserved' });
    this.byResIdem.set(idemKey, id);
    return { id, pool, amount, runId, ...(over ? { exhausted: { used, cap: b.cap } } : {}) };
  }

  async settle(reservationId: string, actual: number): Promise<void> {
    if (!(actual >= 0)) throw new LedgerError('settled amount must be >= 0', 'budget');
    const r = this.reservations.get(reservationId);
    if (!r || r.state !== 'reserved') throw new LedgerError(`reservation ${reservationId} not in reserved state`, 'budget');
    r.state = 'charged';
    r.actual = actual;
  }

  async lease(resource: string, holder: string, ttlMs: number): Promise<Lease | null> {
    const now = Date.now();
    const cur = this.leases.get(resource);
    if (cur && cur.expiresAt > now && cur.holder !== holder) return null;
    const l: Lease = { resource, holder, fencingToken: cur ? cur.fencingToken + 1 : 1, expiresAt: now + ttlMs };
    this.leases.set(resource, l);
    return { ...l };
  }

  async renew(lease: Lease, ttlMs: number): Promise<Lease> {
    const cur = this.leases.get(lease.resource);
    if (!cur || cur.holder !== lease.holder || cur.fencingToken !== lease.fencingToken) throw new LedgerError(`lease on ${lease.resource} is no longer held by ${lease.holder}`, 'lease');
    cur.expiresAt = Date.now() + ttlMs;
    return { ...cur };
  }

  async release(lease: Lease): Promise<void> {
    const cur = this.leases.get(lease.resource);
    // Keep the entry so the fencing token stays monotonic; just expire it.
    if (cur && cur.holder === lease.holder && cur.fencingToken === lease.fencingToken) cur.expiresAt = 0;
  }

  async requestApproval(r: ApprovalRequest): Promise<ApprovalRequest> {
    if (this.approvals.has(r.requestId)) throw new LedgerError(`approval ${r.requestId} already exists`, 'approval');
    this.approvals.set(r.requestId, { ...structuredClone(r), state: 'pending' });
    return r;
  }

  async getApproval(requestId: string): Promise<ApprovalView | null> {
    const a = this.approvals.get(requestId);
    if (!a) return null;
    return {
      requestId: a.requestId,
      runId: a.runId,
      sessionId: a.sessionId,
      actionHash: a.actionHash,
      requester: { ...a.requester },
      state: a.state,
      expiresAt: a.expiresAt,
      ...(a.approver ? { approver: { ...a.approver } } : {}),
    };
  }

  // approve/deny/consume read and write with no await in between: one critical section on the event loop.
  async approve(requestId: string, approver: Principal, sessionId: string, at: number, audit?: TeceraEvent): Promise<ApprovalGrant> {
    let auditEvent: TeceraEvent | undefined;
    if (audit !== undefined) {
      try {
        validateEvent(audit);
        auditEvent = normalizeEvent(audit);
      } catch (err) {
        throw new LedgerError(`approval ${requestId}: invalid audit event: ${(err as Error).message}`, 'approval');
      }
    }
    const a = this.approvals.get(requestId);
    if (!a) throw new LedgerError(`unknown approval request ${requestId}`, 'approval');
    if (a.state !== 'pending') throw new LedgerError(`approval ${requestId} is ${a.state}`, 'approval');
    if (a.expiresAt <= at) {
      a.state = 'expired';
      throw new LedgerError(`approval ${requestId} expired`, 'approval');
    }
    if (a.sessionId !== sessionId) throw new LedgerError(`approval ${requestId} belongs to another session`, 'approval');
    if (a.requester.kind === approver.kind && a.requester.id === approver.id) throw new LedgerError('requester cannot approve their own request', 'approval');
    if (approver.kind !== 'human') throw new LedgerError('only a human principal can approve', 'approval');
    let grantedSeq: number | undefined;
    if (auditEvent) {
      const problem = approvalAuditProblem(auditEvent, { requestId, runId: a.runId, sessionId: a.sessionId, actionHash: a.actionHash, approver });
      if (problem) throw new LedgerError(`approval ${requestId}: ${problem}`, 'approval');
      if (this.byId.has(auditEvent.id) || (auditEvent.idemKey !== undefined && this.byIdem.has(auditEvent.idemKey))) throw new LedgerError(`approval ${requestId}: audit event id or idemKey already recorded`, 'approval');
      grantedSeq = this.insertEvent(auditEvent).seq; // cannot throw after the checks above
    }
    a.state = 'granted';
    a.approver = { kind: approver.kind, id: approver.id };
    a.grantedAt = at;
    if (grantedSeq !== undefined) a.grantedSeq = grantedSeq;
    return { requestId, approver, grantedAt: at, expiresAt: a.expiresAt };
  }

  async deny(requestId: string, approver: Principal, _reason: string, at: number): Promise<void> {
    const a = this.approvals.get(requestId);
    if (!a || a.state !== 'pending') throw new LedgerError(`approval ${requestId} is not pending`, 'approval');
    if (a.expiresAt <= at) {
      a.state = 'expired';
      throw new LedgerError(`approval ${requestId} expired`, 'approval');
    }
    a.state = 'denied';
    a.approver = { kind: approver.kind, id: approver.id };
    a.grantedAt = at;
  }

  /** The grant's approval.granted audit event: the atomically recorded one, else any matching later one. */
  private audited(a: Approval): boolean {
    if (!a.approver) return false;
    const target = { requestId: a.requestId, runId: a.runId, sessionId: a.sessionId, actionHash: a.actionHash, approver: a.approver };
    if (a.grantedSeq !== undefined) {
      const e = this.log[a.grantedSeq - 1];
      if (e && approvalAuditProblem(e, target) === null) return true;
    }
    return this.log.some((e) => e.kind === 'approval.granted' && approvalAuditProblem(e, target) === null);
  }

  async consume(requestId: string, actionHash: string, sessionId: string, idemKey: string, at: number): Promise<void> {
    const a = this.approvals.get(requestId);
    const why = !a
      ? 'unknown request'
      : a.state !== 'granted'
        ? `state is ${a.state}`
        : a.actionHash !== actionHash
          ? 'action hash mismatch'
          : a.sessionId !== sessionId
            ? 'session mismatch'
            : a.expiresAt <= at
              ? 'expired'
              : a.approver && a.approver.kind === a.requester.kind && a.approver.id === a.requester.id
                ? 'requester approved their own request'
                : this.consumeIdems.has(idemKey)
                  ? 'idempotency key reused'
                  : !this.audited(a)
                    ? 'unaudited grant (its approval.granted event is missing)'
                    : null;
    if (why) throw new LedgerError(`cannot consume approval ${requestId}: ${why}`, 'approval');
    a!.state = 'consumed';
    a!.consumeIdem = idemKey;
    this.consumeIdems.add(idemKey);
  }

  async checkpoint(runId: string, _key: string, state: JsonObject): Promise<string> {
    const id = `${runId}:${randomUUID()}`;
    this.checkpoints.set(id, normalizeJson(state));
    return id;
  }

  async loadCheckpoint(id: string): Promise<JsonObject | null> {
    const s = this.checkpoints.get(id);
    return s ? structuredClone(s) : null;
  }

  /**
   * Test hook, the in-memory counterpart of a raw `INSERT OR REPLACE`: write a row through the guarded
   * insert path. It must throw for any existing key.
   */
  rawInsert(table: 'events', row: TeceraEvent & { seq?: number }): void;
  rawInsert(table: 'evidence', row: { key: string; kind: string; runId: string; body: Json }): void;
  rawInsert(table: 'events' | 'evidence', row: unknown): void {
    if (table === 'events') {
      const r = row as TeceraEvent & { seq?: number };
      this.insertEvent(normalizeEvent(r), r.seq ?? this.log.length + 1);
    } else {
      const r = row as { key: string; kind: string; runId: string; body: Json };
      const body = normalizeJson(r.body);
      this.insertEvidence({ key: r.key, kind: r.kind, runId: r.runId, digest: digestOf(body), body, seq: this.log.length });
    }
  }

  /** Test hook: mutate a stored evidence body in place (what a bypassed trigger would allow), to prove verifyChain sees it. */
  tamperEvidenceForTest(key: string, body: Json): void {
    const r = this.ev.get(key);
    if (r) r.body = normalizeJson(body);
  }
}

function publicEvidence(r: StoredEvidence): EvidenceRecord {
  return { key: r.key, kind: r.kind, runId: r.runId, digest: r.digest, body: structuredClone(r.body), seq: r.seq };
}

/** The stored form of an event: payload normalized as JSON, absent trace ids removed. */
export function normalizeEvent(e: TeceraEvent): TeceraEvent {
  const trace = Object.fromEntries(Object.entries(e.trace ?? {}).filter(([, v]) => v !== undefined && v !== null)) as TeceraEvent['trace'];
  const out: TeceraEvent = { id: e.id, kind: e.kind, at: e.at, actor: { kind: e.actor.kind, id: e.actor.id }, trace, payload: normalizeJson(e.payload) };
  if (e.runId !== undefined && e.runId !== null) out.runId = e.runId;
  if (e.idemKey !== undefined && e.idemKey !== null) out.idemKey = e.idemKey;
  return out;
}
