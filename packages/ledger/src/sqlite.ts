import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  LedgerError,
  approvalAuditProblem,
  canonicalJson,
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
import { normalizeEvent } from './memory.js';
import { SCHEMA_POST_SQL, SCHEMA_SQL } from './schema.js';

type Row = Record<string, unknown>;

/**
 * SQLite-backed ledger. Every mutation runs in an IMMEDIATE transaction (the write lock is taken before the
 * read), so several connections on one file never interleave a read-then-write: the chain head is read from
 * the database inside the transaction, never from a per-connection cache. Events, evidence and checkpoints
 * are append-only at the schema level (UPDATE/DELETE/REPLACE triggers). Events and evidence are hash-chained.
 */
export class SqliteLedger implements Ledger {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec(SCHEMA_SQL);
    this.migrate();
    this.db.exec(SCHEMA_POST_SQL);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Older ledgers: add the evidence chain columns and approvals.granted_seq, then chain the existing
   * evidence rows once (in their insertion order) inside one transaction. Rows written before this version
   * were never chained, so the migration cannot vouch for them; it only makes later rewrites detectable. The evidence UPDATE trigger is
   * dropped and recreated in that same transaction, so no other connection ever sees it missing.
   */
  private migrate(): void {
    const cols = (t: string): Set<string> => new Set((this.db.prepare(`PRAGMA table_info(${t})`).all() as Row[]).map((r) => r.name as string));
    const ap = cols('approvals');
    if (!ap.has('granted_seq')) this.db.exec('ALTER TABLE approvals ADD COLUMN granted_seq INTEGER');
    // D3: pools opened before soft pools existed were all enforced.
    if (!cols('budgets').has('enforce')) this.db.exec('ALTER TABLE budgets ADD COLUMN enforce INTEGER NOT NULL DEFAULT 1');
    const ev = cols('evidence');
    const missing = ['n', 'prev_hash', 'hash', 'event_hash'].filter((c) => !ev.has(c));
    // Only a ledger written before the chain existed is chained here. In a current ledger an unchained row
    // can only come from tampering (the evidence_chained trigger refuses it); it is left for verifyChain.
    if (missing.length === 0) return;
    const tx = this.db.transaction(() => {
      for (const c of missing) this.db.exec(`ALTER TABLE evidence ADD COLUMN ${c} ${c === 'n' ? 'INTEGER' : 'TEXT'}`);
      this.db.exec('DROP TRIGGER IF EXISTS evidence_no_update');
      let prev = GENESIS_HASH;
      let n = 0;
      const rows = this.db.prepare('SELECT rowid AS rid, * FROM evidence ORDER BY (n IS NULL), n, rowid').all() as Row[];
      const upd = this.db.prepare('UPDATE evidence SET n = ?, prev_hash = ?, hash = ?, event_hash = ? WHERE rowid = ?');
      for (const r of rows) {
        n++;
        const seq = r.seq as number;
        const eventHash = seq > 0 ? (((this.db.prepare('SELECT hash FROM events WHERE seq = ?').get(seq) as Row | undefined)?.hash as string | undefined) ?? GENESIS_HASH) : GENESIS_HASH;
        const hash = evidenceHash(prev, { n, key: r.key as string, kind: r.kind as string, runId: r.run_id as string, digest: r.digest as string, seq, eventHash });
        upd.run(n, prev, hash, eventHash, r.rid);
        prev = hash;
      }
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS evidence_no_update BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;`);
    });
    tx.immediate();
  }

  private head(): string {
    const last = this.db.prepare('SELECT hash FROM events ORDER BY seq DESC LIMIT 1').get() as Row | undefined;
    return (last?.hash as string | undefined) ?? GENESIS_HASH;
  }

  /** Insert one normalized event at the head of the chain. Must run inside a write transaction. */
  private insertEvent(e: TeceraEvent): { seq: number; hash: string } {
    const prev = this.head();
    const hash = chainHash(prev, e);
    const info = this.db
      .prepare(
        `INSERT INTO events (id, kind, at, actor_kind, actor_id, run_id, goal_id, intention_id, step_id, plan_id, payload, idem_key, prev_hash, hash)
         VALUES (@id, @kind, @at, @actorKind, @actorId, @runId, @goalId, @intentionId, @stepId, @planId, @payload, @idemKey, @prevHash, @hash)`,
      )
      .run({
        id: e.id,
        kind: e.kind,
        at: e.at,
        actorKind: e.actor.kind,
        actorId: e.actor.id,
        runId: e.runId ?? null,
        goalId: e.trace.goalId ?? null,
        intentionId: e.trace.intentionId ?? null,
        stepId: e.trace.stepId ?? null,
        planId: e.trace.planId ?? null,
        payload: canonicalJson(e.payload),
        idemKey: e.idemKey ?? null,
        prevHash: prev,
        hash,
      });
    return { seq: Number(info.lastInsertRowid), hash };
  }

  async append(raw: TeceraEvent): Promise<AppendResult> {
    validateEvent(raw);
    let e: TeceraEvent;
    try {
      e = normalizeEvent(raw);
    } catch (err) {
      throw new LedgerError(`append failed: ${(err as Error).message}`, 'io');
    }
    const tx = this.db.transaction((): AppendResult => {
      if (e.idemKey) {
        const dup = this.db.prepare('SELECT seq, hash FROM events WHERE idem_key = ?').get(e.idemKey) as Row | undefined;
        if (dup) return { seq: dup.seq as number, hash: dup.hash as string, duplicate: true };
      }
      const dupId = this.db.prepare('SELECT seq, hash FROM events WHERE id = ?').get(e.id) as Row | undefined;
      if (dupId) return { seq: dupId.seq as number, hash: dupId.hash as string, duplicate: true };
      return { ...this.insertEvent(e), duplicate: false };
    });
    try {
      return tx.immediate();
    } catch (err) {
      throw new LedgerError(`append failed: ${(err as Error).message}`, 'io');
    }
  }

  async *events(filter: { runId?: string; kinds?: EventKind[]; sinceSeq?: number } = {}): AsyncIterable<TeceraEvent & { seq: number; hash: string }> {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.runId) {
      where.push('run_id = @runId');
      params.runId = filter.runId;
    }
    if (filter.sinceSeq !== undefined) {
      where.push('seq > @since');
      params.since = filter.sinceSeq;
    }
    if (filter.kinds?.length) {
      where.push(`kind IN (${filter.kinds.map((_, i) => `@k${i}`).join(',')})`);
      filter.kinds.forEach((k, i) => (params[`k${i}`] = k));
    }
    const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq ASC`;
    for (const row of this.db.prepare(sql).all(params) as Row[]) yield rowToEvent(row);
  }

  async verifyChain(): Promise<ChainVerdict> {
    let prev = GENESIS_HASH;
    let n = 0;
    const hashes = new Map<number, string>();
    for (const row of this.db.prepare('SELECT * FROM events ORDER BY seq ASC').all() as Row[]) {
      const e = rowToEvent(row);
      if (row.prev_hash !== prev || chainHash(prev, e) !== row.hash) return { ok: false, brokenAtSeq: row.seq as number };
      prev = row.hash as string;
      hashes.set(row.seq as number, prev);
      n++;
    }
    let evPrev = GENESIS_HASH;
    let expectN = 0;
    for (const row of this.db.prepare('SELECT * FROM evidence ORDER BY (n IS NULL), n, rowid').all() as Row[]) {
      expectN++;
      const key = row.key as string;
      const seq = row.seq as number;
      const broken = (reason: string): ChainVerdict => ({ ok: false, brokenAtSeq: seq, brokenEvidenceKey: key, reason });
      if (row.n !== expectN) return broken('evidence sequence has a gap or an unchained row');
      if (row.prev_hash !== evPrev) return broken('evidence chain link broken');
      let body: Json;
      try {
        body = JSON.parse(row.body as string) as Json;
      } catch {
        return broken('evidence body is not JSON');
      }
      if (digestOf(body) !== row.digest) return broken('evidence body does not match its digest');
      const eventHash = seq > 0 ? hashes.get(seq) : GENESIS_HASH;
      if (eventHash === undefined || row.event_hash !== eventHash) return broken('evidence is not bound to the event at its seq');
      if (evidenceHash(evPrev, { n: expectN, key, kind: row.kind as string, runId: row.run_id as string, digest: row.digest as string, seq, eventHash }) !== row.hash) return broken('evidence hash mismatch');
      evPrev = row.hash as string;
    }
    return { ok: true, length: n };
  }

  async evidence(e: { key: string; kind: string; runId: string; body: Json }): Promise<EvidenceRecord> {
    const body = normalizeJson(e.body);
    const d = digestOf(body);
    const tx = this.db.transaction((): EvidenceRecord | string => {
      const existing = this.db.prepare('SELECT * FROM evidence WHERE key = ?').get(e.key) as Row | undefined;
      if (existing) return existing.digest !== d ? `evidence key ${e.key} already exists with a different body` : rowToEvidence(existing);
      const headRow = this.db.prepare('SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1').get() as Row | undefined;
      const seq = (headRow?.seq as number | undefined) ?? 0;
      const eventHash = (headRow?.hash as string | undefined) ?? GENESIS_HASH;
      const last = this.db.prepare('SELECT n, hash FROM evidence ORDER BY n DESC LIMIT 1').get() as Row | undefined;
      const n = ((last?.n as number | undefined) ?? 0) + 1;
      const prev = (last?.hash as string | undefined) ?? GENESIS_HASH;
      const hash = evidenceHash(prev, { n, key: e.key, kind: e.kind, runId: e.runId, digest: d, seq, eventHash });
      this.db
        .prepare('INSERT INTO evidence (key, kind, run_id, digest, body, seq, n, prev_hash, hash, event_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(e.key, e.kind, e.runId, d, canonicalJson(body), seq, n, prev, hash, eventHash);
      return { key: e.key, kind: e.kind, runId: e.runId, digest: d, body, seq };
    });
    let r: EvidenceRecord | string;
    try {
      r = tx.immediate();
    } catch (err) {
      throw new LedgerError(`evidence write failed: ${(err as Error).message}`, 'io');
    }
    if (typeof r === 'string') throw new LedgerError(r, 'evidence');
    return r;
  }

  async getEvidence(key: string): Promise<EvidenceRecord | null> {
    const row = this.db.prepare('SELECT * FROM evidence WHERE key = ?').get(key) as Row | undefined;
    return row ? rowToEvidence(row) : null;
  }

  /**
   * Every evidence record of a run in chain order (n), optionally only kinds starting with `kindPrefix`
   * (compared as a literal prefix, never as a LIKE pattern).
   */
  async listEvidence(runId: string, kindPrefix?: string): Promise<EvidenceRecord[]> {
    try {
      const rows = this.db.prepare('SELECT * FROM evidence WHERE run_id = ? ORDER BY (n IS NULL), n, rowid').all(runId) as Row[];
      return rows.filter((r) => kindPrefix === undefined || (r.kind as string).startsWith(kindPrefix)).map(rowToEvidence);
    } catch (err) {
      throw new LedgerError(`evidence listing failed: ${(err as Error).message}`, 'io');
    }
  }

  /** Declare a pool's cap. Re-opening never widens it (the smaller cap wins) nor relaxes it (enforced stays enforced). */
  async openBudget(runId: string, pool: string, cap: number, opts?: BudgetOptions): Promise<void> {
    if (!(cap >= 0)) throw new LedgerError(`budget cap for ${pool} must be >= 0`, 'budget');
    const enforce = opts?.enforce === false ? 0 : 1;
    const tx = this.db.transaction(() => {
      const cur = this.db.prepare('SELECT cap, enforce FROM budgets WHERE run_id = ? AND pool = ?').get(runId, pool) as Row | undefined;
      if (!cur) this.db.prepare('INSERT INTO budgets (run_id, pool, cap, enforce) VALUES (?, ?, ?, ?)').run(runId, pool, cap, enforce);
      else {
        const next = Math.min(cur.cap as number, cap);
        const nextEnforce = (cur.enforce as number) === 1 || enforce === 1 ? 1 : 0;
        if (next !== cur.cap || nextEnforce !== cur.enforce) this.db.prepare('UPDATE budgets SET cap = ?, enforce = ? WHERE run_id = ? AND pool = ?').run(next, nextEnforce, runId, pool);
      }
    });
    tx.immediate();
  }

  async budgetUsage(runId: string): Promise<PoolUsage[]> {
    try {
      const rows = this.db
        .prepare(
          `SELECT b.pool AS pool, b.cap AS cap, b.enforce AS enforce,
             COALESCE((SELECT SUM(CASE WHEN r.state = 'charged' THEN r.actual WHEN r.state = 'reserved' THEN r.amount ELSE 0 END) FROM reservations r WHERE r.run_id = b.run_id AND r.pool = b.pool), 0) AS used,
             (SELECT COUNT(*) FROM reservations r WHERE r.run_id = b.run_id AND r.pool = b.pool) AS n
           FROM budgets b WHERE b.run_id = ? ORDER BY b.pool`,
        )
        .all(runId) as Row[];
      return rows.map((r) => ({ pool: r.pool as string, cap: r.cap as number, used: r.used as number, enforce: (r.enforce as number) === 1, reservations: r.n as number }));
    } catch (err) {
      throw new LedgerError(`budget usage failed: ${(err as Error).message}`, 'io');
    }
  }

  async reserve(pool: string, amount: number, runId: string, idemKey: string): Promise<Reservation> {
    if (!(amount >= 0)) throw new LedgerError('reservation amount must be >= 0', 'budget');
    const tx = this.db.transaction((): Reservation => {
      const dup = this.db.prepare('SELECT * FROM reservations WHERE idem_key = ?').get(idemKey) as Row | undefined;
      if (dup) return { id: dup.id as string, pool: dup.pool as string, amount: dup.amount as number, runId: dup.run_id as string };
      const cap = this.db.prepare('SELECT cap, enforce FROM budgets WHERE run_id = ? AND pool = ?').get(runId, pool) as Row | undefined;
      if (!cap) throw new LedgerError(`no budget opened for pool ${pool} in run ${runId}`, 'budget');
      const used = this.db
        .prepare(`SELECT COALESCE(SUM(CASE WHEN state = 'charged' THEN actual ELSE amount END), 0) AS used FROM reservations WHERE run_id = ? AND pool = ? AND state <> 'released'`)
        .get(runId, pool) as Row;
      const over = (used.used as number) + amount > (cap.cap as number);
      if (over && (cap.enforce as number) !== 0) throw new LedgerError(`budget exceeded for pool ${pool}: used ${used.used} + ${amount} > cap ${cap.cap}`, 'budget');
      const id = randomUUID();
      this.db.prepare(`INSERT INTO reservations (id, run_id, pool, amount, state, idem_key) VALUES (?, ?, ?, ?, 'reserved', ?)`).run(id, runId, pool, amount, idemKey);
      return { id, pool, amount, runId, ...(over ? { exhausted: { used: used.used as number, cap: cap.cap as number } } : {}) };
    });
    return tx.immediate();
  }

  async settle(reservationId: string, actual: number): Promise<void> {
    if (!(actual >= 0)) throw new LedgerError('settled amount must be >= 0', 'budget');
    const r = this.db.prepare(`UPDATE reservations SET state = 'charged', actual = ? WHERE id = ? AND state = 'reserved'`).run(actual, reservationId);
    if (r.changes !== 1) throw new LedgerError(`reservation ${reservationId} not in reserved state`, 'budget');
  }

  async lease(resource: string, holder: string, ttlMs: number): Promise<Lease | null> {
    const now = Date.now();
    const tx = this.db.transaction((): Lease | null => {
      const cur = this.db.prepare('SELECT * FROM leases WHERE resource = ?').get(resource) as Row | undefined;
      if (cur && (cur.expires_at as number) > now && cur.holder !== holder) return null;
      const token = cur ? (cur.fencing_token as number) + 1 : 1;
      const expiresAt = now + ttlMs;
      this.db.prepare('INSERT OR REPLACE INTO leases (resource, holder, fencing_token, expires_at) VALUES (?, ?, ?, ?)').run(resource, holder, token, expiresAt);
      return { resource, holder, fencingToken: token, expiresAt };
    });
    return tx.immediate();
  }

  async renew(lease: Lease, ttlMs: number): Promise<Lease> {
    const expiresAt = Date.now() + ttlMs;
    const r = this.db.prepare('UPDATE leases SET expires_at = ? WHERE resource = ? AND holder = ? AND fencing_token = ?').run(expiresAt, lease.resource, lease.holder, lease.fencingToken);
    if (r.changes !== 1) throw new LedgerError(`lease on ${lease.resource} is no longer held by ${lease.holder}`, 'lease');
    return { ...lease, expiresAt };
  }

  async release(lease: Lease): Promise<void> {
    // Keep the row so the fencing token stays monotonic across holders; just expire it.
    this.db.prepare('UPDATE leases SET expires_at = 0 WHERE resource = ? AND holder = ? AND fencing_token = ?').run(lease.resource, lease.holder, lease.fencingToken);
  }

  async requestApproval(r: ApprovalRequest): Promise<ApprovalRequest> {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO approvals (request_id, run_id, session_id, action_hash, requester_kind, requester_id, reason, state, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(r.requestId, r.runId, r.sessionId, r.actionHash, r.requester.kind, r.requester.id, r.reason, r.expiresAt);
    if (info.changes !== 1) throw new LedgerError(`approval ${r.requestId} already exists`, 'approval');
    return r;
  }

  async getApproval(requestId: string): Promise<ApprovalView | null> {
    const row = this.db.prepare('SELECT * FROM approvals WHERE request_id = ?').get(requestId) as Row | undefined;
    if (!row) return null;
    return {
      requestId: row.request_id as string,
      runId: row.run_id as string,
      sessionId: row.session_id as string,
      actionHash: row.action_hash as string,
      requester: { kind: row.requester_kind as Principal['kind'], id: row.requester_id as string },
      state: row.state as ApprovalView['state'],
      expiresAt: row.expires_at as number,
      ...(row.approver_kind ? { approver: { kind: row.approver_kind as Principal['kind'], id: row.approver_id as string } } : {}),
    };
  }

  /**
   * Read and write the row inside one IMMEDIATE transaction (write lock taken before the read), so two
   * connections cannot both see 'pending' and both grant. Expiry is committed, then reported. With `audit`
   * the approval.granted event is appended in the same transaction: both are recorded or neither.
   */
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
    const tx = this.db.transaction((): { grant: ApprovalGrant } | { error: string } => {
      const row = this.db.prepare('SELECT * FROM approvals WHERE request_id = ?').get(requestId) as Row | undefined;
      if (!row) return { error: `unknown approval request ${requestId}` };
      if (row.state !== 'pending') return { error: `approval ${requestId} is ${row.state}` };
      if ((row.expires_at as number) <= at) {
        this.db.prepare(`UPDATE approvals SET state = 'expired' WHERE request_id = ? AND state = 'pending'`).run(requestId);
        return { error: `approval ${requestId} expired` };
      }
      if (row.session_id !== sessionId) return { error: `approval ${requestId} belongs to another session` };
      if (row.requester_kind === approver.kind && row.requester_id === approver.id) return { error: 'requester cannot approve their own request' };
      if (approver.kind !== 'human') return { error: 'only a human principal can approve' };
      let grantedSeq: number | null = null;
      if (auditEvent) {
        const problem = approvalAuditProblem(auditEvent, { requestId, runId: row.run_id as string, sessionId: row.session_id as string, actionHash: row.action_hash as string, approver });
        if (problem) return { error: `approval ${requestId}: ${problem}` };
        const clash = this.db.prepare('SELECT 1 FROM events WHERE id = ? OR (? IS NOT NULL AND idem_key = ?)').get(auditEvent.id, auditEvent.idemKey ?? null, auditEvent.idemKey ?? null);
        if (clash) return { error: `approval ${requestId}: audit event id or idemKey already recorded` };
        grantedSeq = this.insertEvent(auditEvent).seq;
      }
      const u = this.db
        .prepare(`UPDATE approvals SET state = 'granted', approver_kind = ?, approver_id = ?, granted_at = ?, granted_seq = ? WHERE request_id = ? AND state = 'pending'`)
        .run(approver.kind, approver.id, at, grantedSeq, requestId);
      if (u.changes !== 1) throw new LedgerError(`approval ${requestId} changed concurrently`, 'approval'); // rolls the audit event back
      return { grant: { requestId, approver, grantedAt: at, expiresAt: row.expires_at as number } };
    });
    let r: { grant: ApprovalGrant } | { error: string };
    try {
      r = tx.immediate();
    } catch (err) {
      if (err instanceof LedgerError) throw err;
      throw new LedgerError(`approval ${requestId}: store error: ${(err as Error).message}`, 'io');
    }
    if ('error' in r) throw new LedgerError(r.error, 'approval');
    return r.grant;
  }

  async deny(requestId: string, approver: Principal, reason: string, at: number): Promise<void> {
    const tx = this.db.transaction((): string | null => {
      const row = this.db.prepare('SELECT state, expires_at FROM approvals WHERE request_id = ?').get(requestId) as Row | undefined;
      if (!row || row.state !== 'pending') return `approval ${requestId} is not pending`;
      if ((row.expires_at as number) <= at) {
        this.db.prepare(`UPDATE approvals SET state = 'expired' WHERE request_id = ? AND state = 'pending'`).run(requestId);
        return `approval ${requestId} expired`;
      }
      const u = this.db
        .prepare(`UPDATE approvals SET state = 'denied', approver_kind = ?, approver_id = ?, granted_at = ?, denied_reason = ? WHERE request_id = ? AND state = 'pending'`)
        .run(approver.kind, approver.id, at, reason, requestId);
      return u.changes === 1 ? null : `approval ${requestId} is not pending`;
    });
    const err = tx.immediate();
    if (err) throw new LedgerError(err, 'approval');
  }

  /** The grant's approval.granted audit event: the one recorded atomically, else any matching one appended later. */
  private auditOf(row: Row): TeceraEvent | null {
    const target = {
      requestId: row.request_id as string,
      runId: row.run_id as string,
      sessionId: row.session_id as string,
      actionHash: row.action_hash as string,
      approver: { kind: row.approver_kind as Principal['kind'], id: row.approver_id as string },
    };
    const candidates: Row[] = [];
    if (typeof row.granted_seq === 'number') {
      const r = this.db.prepare('SELECT * FROM events WHERE seq = ?').get(row.granted_seq) as Row | undefined;
      if (r) candidates.push(r);
    }
    candidates.push(...(this.db.prepare(`SELECT * FROM events WHERE kind = 'approval.granted' AND run_id = ? AND json_extract(payload, '$.requestId') = ? ORDER BY seq`).all(target.runId, target.requestId) as Row[]));
    for (const c of candidates) {
      const e = rowToEvent(c);
      if (approvalAuditProblem(e, target) === null) return e;
    }
    return null;
  }

  async consume(requestId: string, actionHash: string, sessionId: string, idemKey: string, at: number): Promise<void> {
    const tx = this.db.transaction((): string | null => {
      const row = this.db.prepare('SELECT * FROM approvals WHERE request_id = ?').get(requestId) as Row | undefined;
      const why = !row
        ? 'unknown request'
        : row.state !== 'granted'
          ? `state is ${row.state}`
          : row.action_hash !== actionHash
            ? 'action hash mismatch'
            : row.session_id !== sessionId
              ? 'session mismatch'
              : (row.expires_at as number) <= at
                ? 'expired'
                : row.approver_kind === row.requester_kind && row.approver_id === row.requester_id
                  ? 'requester approved their own request'
                  : this.db.prepare('SELECT 1 FROM approvals WHERE consume_idem = ?').get(idemKey)
                    ? 'idempotency key reused'
                    : !this.auditOf(row)
                      ? 'unaudited grant (its approval.granted event is missing)'
                      : null;
      if (why) return why;
      const u = this.db
        .prepare(
          `UPDATE approvals SET state = 'consumed', consumed_at = ?, consume_idem = ?
           WHERE request_id = ? AND state = 'granted' AND expires_at > ? AND action_hash = ? AND session_id = ?
             AND NOT (approver_kind = requester_kind AND approver_id = requester_id)`,
        )
        .run(at, idemKey, requestId, at, actionHash, sessionId);
      return u.changes === 1 ? null : 'refused';
    });
    let why: string | null;
    try {
      why = tx.immediate();
    } catch (err) {
      // consume_idem is UNIQUE: a reused idempotency key is a refusal, not an I/O fault.
      throw new LedgerError(`cannot consume approval ${requestId}: ${/UNIQUE/i.test((err as Error).message) ? 'idempotency key reused' : 'store error'}`, 'approval');
    }
    if (why) throw new LedgerError(`cannot consume approval ${requestId}: ${why}`, 'approval');
  }

  async checkpoint(runId: string, key: string, state: JsonObject): Promise<string> {
    const id = randomUUID();
    const normalized = normalizeJson(state);
    this.db.prepare('INSERT INTO checkpoints (id, run_id, key, state, digest, at) VALUES (?, ?, ?, ?, ?, ?)').run(id, runId, key, canonicalJson(normalized), digestOf(normalized), Date.now());
    return id;
  }

  /** A checkpoint whose state no longer matches its digest is refused (fail closed), never returned. */
  async loadCheckpoint(id: string): Promise<JsonObject | null> {
    const row = this.db.prepare('SELECT state, digest FROM checkpoints WHERE id = ?').get(id) as Row | undefined;
    if (!row) return null;
    let state: JsonObject;
    try {
      state = JSON.parse(row.state as string) as JsonObject;
    } catch {
      throw new LedgerError(`checkpoint ${id} is corrupt`, 'chain');
    }
    if (digestOf(state) !== row.digest) throw new LedgerError(`checkpoint ${id} does not match its digest`, 'chain');
    return state;
  }

  /** Test hook: attempt a raw mutation to prove the triggers. */
  rawExec(sql: string): void {
    this.db.exec(sql);
  }
}

function rowToEvent(row: Row): TeceraEvent & { seq: number; hash: string } {
  return {
    seq: row.seq as number,
    hash: row.hash as string,
    id: row.id as string,
    kind: row.kind as EventKind,
    at: row.at as number,
    actor: { kind: row.actor_kind as Principal['kind'], id: row.actor_id as string },
    runId: (row.run_id as string | null) ?? undefined,
    trace: {
      goalId: (row.goal_id as string | null) ?? undefined,
      intentionId: (row.intention_id as string | null) ?? undefined,
      stepId: (row.step_id as string | null) ?? undefined,
      planId: (row.plan_id as string | null) ?? undefined,
    },
    payload: JSON.parse(row.payload as string) as JsonObject,
    idemKey: (row.idem_key as string | null) ?? undefined,
  };
}

function rowToEvidence(row: Row): EvidenceRecord {
  return { key: row.key as string, kind: row.kind as string, runId: row.run_id as string, digest: row.digest as string, body: JSON.parse(row.body as string) as Json, seq: row.seq as number };
}
