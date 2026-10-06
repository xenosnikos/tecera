import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { LedgerError, approvalGrantedEvent, event } from '@tecera/contracts';
import { grantAudited, ledgerConformance } from './conformance.js';
import { MemoryLedger } from './memory.js';
import { SqliteLedger } from './sqlite.js';

ledgerConformance('MemoryLedger', () => new MemoryLedger());
ledgerConformance('SqliteLedger', () => new SqliteLedger(join(mkdtempSync(join(tmpdir(), 'tecera-ledger-')), 'l.sqlite')));

describe('SqliteLedger specifics', () => {
  it('triggers forbid UPDATE and DELETE on events and evidence', async () => {
    const l = new SqliteLedger(join(mkdtempSync(join(tmpdir(), 'tecera-ledger-')), 'l.sqlite'));
    await l.append(event('run.started', { id: 'e1', at: 1, actor: { kind: 'system', id: 's' }, payload: {} }));
    await l.evidence({ key: 'k', kind: 'x', runId: 'r', body: { a: 1 } });
    expect(() => l.rawExec(`UPDATE events SET kind = 'run.ended'`)).toThrow(/append-only/);
    expect(() => l.rawExec(`DELETE FROM events`)).toThrow(/append-only/);
    expect(() => l.rawExec(`UPDATE evidence SET body = '{}'`)).toThrow(/append-only/);
    expect(() => l.rawExec(`DELETE FROM evidence`)).toThrow(/append-only/);
    expect(await l.verifyChain()).toEqual({ ok: true, length: 1 });
    l.close();
  });

  it('reopening continues the chain', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tecera-ledger-')), 'l.sqlite');
    const a = new SqliteLedger(path);
    await a.append(event('run.started', { id: 'e1', at: 1, actor: { kind: 'system', id: 's' }, payload: {} }));
    a.close();
    const b = new SqliteLedger(path);
    await b.append(event('run.ended', { id: 'e2', at: 2, actor: { kind: 'system', id: 's' }, payload: {} }));
    expect(await b.verifyChain()).toEqual({ ok: true, length: 2 });
    b.close();
  });

  it('two connections on one file cannot both grant one approval', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tecera-ledger-')), 'l.sqlite');
    const a = new SqliteLedger(path);
    const b = new SqliteLedger(path);
    await a.requestApproval({ requestId: 'x', runId: 'r', sessionId: 's', actionHash: 'h', requester: { kind: 'agent', id: 'w' }, reason: 'r', expiresAt: 1000 });
    const rs = await Promise.allSettled([
      grantAudited(a, 'x', { kind: 'human', id: 'h1' }, 's', 10, { actionHash: 'h' }),
      grantAudited(b, 'x', { kind: 'human', id: 'h2' }, 's', 10, { actionHash: 'h' }),
      b.deny('x', { kind: 'human', id: 'h3' }, 'no', 10),
    ]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await b.getApproval('x'))!.state).toBe('granted');
    await a.consume('x', 'h', 's', 'c1', 20);
    await expect(b.consume('x', 'h', 's', 'c2', 20)).rejects.toThrow(/state is consumed/);
    a.close();
    b.close();
  });
});

const tmpDb = (): string => join(mkdtempSync(join(tmpdir(), 'tecera-ledger-')), 'l.sqlite');
const sys = { kind: 'system' as const, id: 's' };

describe('ADV-2: INSERT OR REPLACE cannot rewrite append-only rows', () => {
  it('SqliteLedger: REPLACE/INSERT OR REPLACE/UPSERT on events (seq, id, idem_key, hash), evidence (key, n) and checkpoints abort; the chain stays intact', async () => {
    const l = new SqliteLedger(tmpDb());
    await l.append(event('run.started', { id: 'e1', at: 1, actor: sys, payload: { a: 1 }, idemKey: 'ik1' }));
    await l.append(event('run.ended', { id: 'e2', at: 2, actor: sys, payload: {} }));
    await l.evidence({ key: 'k', kind: 'x', runId: 'r', body: { a: 1 } });
    const cp = await l.checkpoint('r', 'c', { v: 1 });
    const cols = `(seq, id, kind, at, actor_kind, actor_id, payload, idem_key, prev_hash, hash)`;
    const attacks = [
      `INSERT OR REPLACE INTO events ${cols} VALUES (1, 'e1', 'run.ended', 1, 'system', 's', '{"a":2}', 'ik1', '${'0'.repeat(64)}', 'forged')`,
      `REPLACE INTO events ${cols} VALUES (1, 'other', 'run.ended', 1, 'system', 's', '{}', NULL, 'p', 'forged2')`,
      `INSERT OR REPLACE INTO events (id, kind, at, actor_kind, actor_id, payload, prev_hash, hash) VALUES ('e2', 'run.ended', 9, 'system', 's', '{}', 'p', 'forged3')`,
      `INSERT OR REPLACE INTO events (id, kind, at, actor_kind, actor_id, payload, idem_key, prev_hash, hash) VALUES ('new', 'run.ended', 9, 'system', 's', '{}', 'ik1', 'p', 'forged4')`,
      `INSERT OR IGNORE INTO events (id, kind, at, actor_kind, actor_id, payload, prev_hash, hash) VALUES ('e1', 'run.ended', 9, 'system', 's', '{}', 'p', 'forged5')`,
      `INSERT INTO events (id, kind, at, actor_kind, actor_id, payload, prev_hash, hash) VALUES ('e1', 'run.ended', 9, 'system', 's', '{}', 'p', 'x') ON CONFLICT(id) DO UPDATE SET payload = '{"z":1}'`,
      `INSERT OR REPLACE INTO evidence (key, kind, run_id, digest, body, seq, n, prev_hash, hash, event_hash) VALUES ('k', 'x', 'r', 'd', '{"a":2}', 0, 1, 'p', 'h', 'e')`,
      `REPLACE INTO evidence (key, kind, run_id, digest, body, seq, n, prev_hash, hash, event_hash) VALUES ('k2', 'x', 'r', 'd', '{}', 0, 1, 'p', 'h', 'e')`,
      `INSERT OR REPLACE INTO checkpoints (id, run_id, key, state, digest, at) VALUES ('${cp}', 'r', 'c', '{"v":2}', 'd', 0)`,
      `UPDATE checkpoints SET state = '{}'`,
      `DELETE FROM checkpoints`,
    ];
    for (const sql of attacks) expect(() => l.rawExec(sql), sql).toThrow(/append-only/);
    // an unchained evidence row cannot be inserted either
    expect(() => l.rawExec(`INSERT INTO evidence (key, kind, run_id, digest, body, seq) VALUES ('k3', 'x', 'r', 'd', '{}', 0)`)).toThrow(/hash-chained/);
    expect(await l.verifyChain()).toEqual({ ok: true, length: 2 });
    expect((await l.getEvidence('k'))!.body).toEqual({ a: 1 });
    expect(await l.loadCheckpoint(cp)).toEqual({ v: 1 });
    l.close();
  });

  it('a second raw connection (no recursive_triggers) cannot REPLACE either', async () => {
    const path = tmpDb();
    const l = new SqliteLedger(path);
    await l.append(event('run.started', { id: 'e1', at: 1, actor: sys, payload: { a: 1 } }));
    await l.evidence({ key: 'k', kind: 'x', runId: 'r', body: { a: 1 } });
    const raw = new Database(path);
    raw.pragma('recursive_triggers = OFF');
    expect(() => raw.prepare(`INSERT OR REPLACE INTO events (seq, id, kind, at, actor_kind, actor_id, payload, prev_hash, hash) VALUES (1, 'e1', 'run.ended', 1, 'system', 's', '{}', 'p', 'h')`).run()).toThrow(/append-only/);
    expect(() => raw.prepare(`INSERT OR REPLACE INTO evidence (key, kind, run_id, digest, body, seq, n, prev_hash, hash, event_hash) VALUES ('k', 'x', 'r', 'd', '{}', 0, 9, 'p', 'h', 'e')`).run()).toThrow(/append-only/);
    raw.close();
    expect(await l.verifyChain()).toEqual({ ok: true, length: 1 });
    l.close();
  });

  it('MemoryLedger: the guarded insert refuses an existing seq, id, idemKey or evidence key', async () => {
    const l = new MemoryLedger();
    await l.append(event('run.started', { id: 'e1', at: 1, actor: sys, payload: {}, idemKey: 'ik' }));
    await l.evidence({ key: 'k', kind: 'x', runId: 'r', body: { a: 1 } });
    expect(() => l.rawInsert('events', { ...event('run.ended', { id: 'e1', at: 2, actor: sys, payload: {} }) })).toThrow(LedgerError);
    expect(() => l.rawInsert('events', { ...event('run.ended', { id: 'n1', at: 2, actor: sys, payload: {}, idemKey: 'ik' }) })).toThrow(/append-only/);
    expect(() => l.rawInsert('events', { ...event('run.ended', { id: 'n2', at: 2, actor: sys, payload: {} }), seq: 1 })).toThrow(/append-only/);
    expect(() => l.rawInsert('evidence', { key: 'k', kind: 'x', runId: 'r', body: { a: 2 } })).toThrow(/append-only/);
    expect((await l.getEvidence('k'))!.body).toEqual({ a: 1 });
    expect(await l.verifyChain()).toEqual({ ok: true, length: 1 });
  });
});

describe('evidence rewrites are detected by verifyChain', () => {
  it('SqliteLedger: with the triggers bypassed, a rewritten evidence body, digest or link is reported with its key', async () => {
    const l = new SqliteLedger(tmpDb());
    await l.append(event('run.started', { id: 'e1', at: 1, actor: sys, payload: {} }));
    await l.evidence({ key: 'a', kind: 'x', runId: 'r', body: { v: 1 } });
    await l.evidence({ key: 'b', kind: 'x', runId: 'r', body: { v: 2 } });
    expect(await l.verifyChain()).toEqual({ ok: true, length: 1 });
    l.rawExec('DROP TRIGGER evidence_no_update');
    l.rawExec(`UPDATE evidence SET body = '{"v":9}' WHERE key = 'b'`);
    expect(await l.verifyChain()).toMatchObject({ ok: false, brokenEvidenceKey: 'b', reason: /digest/ });
    // recomputing the digest too is still caught by the row hash
    const { digest } = await import('@tecera/contracts');
    l.rawExec(`UPDATE evidence SET digest = '${digest({ v: 9 })}' WHERE key = 'b'`);
    expect(await l.verifyChain()).toMatchObject({ ok: false, brokenEvidenceKey: 'b', reason: /hash mismatch/ });
    l.close();
  });

  it('SqliteLedger: an event rewrite is reported at its seq', async () => {
    const l = new SqliteLedger(tmpDb());
    await l.append(event('run.started', { id: 'e1', at: 1, actor: sys, payload: { a: 1 } }));
    await l.append(event('run.ended', { id: 'e2', at: 2, actor: sys, payload: {} }));
    l.rawExec('DROP TRIGGER events_no_update');
    l.rawExec(`UPDATE events SET payload = '{"a":2}' WHERE seq = 1`);
    expect(await l.verifyChain()).toEqual({ ok: false, brokenAtSeq: 1 }); // unchanged shape for an events break
    l.close();
  });

  it('MemoryLedger: a tampered evidence body is reported', async () => {
    const l = new MemoryLedger();
    await l.evidence({ key: 'a', kind: 'x', runId: 'r', body: { v: 1 } });
    l.tamperEvidenceForTest('a', { v: 2 });
    expect(await l.verifyChain()).toMatchObject({ ok: false, brokenEvidenceKey: 'a' });
  });
});

describe('SqliteLedger multi-connection chain and migration', () => {
  it('two connections appending alternately keep one valid chain (the head is read inside the transaction)', async () => {
    const path = tmpDb();
    const a = new SqliteLedger(path);
    const b = new SqliteLedger(path);
    for (let i = 0; i < 6; i++) {
      await (i % 2 ? b : a).append(event('belief.added', { id: `x${i}`, at: i, actor: sys, payload: { key: 'k', value: i } }));
      await (i % 2 ? a : b).evidence({ key: `ev${i}`, kind: 'x', runId: 'r', body: { i } });
    }
    expect(await a.verifyChain()).toEqual({ ok: true, length: 6 });
    expect(await b.verifyChain()).toEqual({ ok: true, length: 6 });
    a.close();
    b.close();
  });

  it('a ledger written before the evidence chain is migrated: columns added, rows chained, triggers installed', async () => {
    const path = tmpDb();
    const old = new Database(path);
    old.exec(`CREATE TABLE evidence (key TEXT PRIMARY KEY, kind TEXT NOT NULL, run_id TEXT NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL, seq INTEGER NOT NULL);
      CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
      CREATE TABLE approvals (request_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, session_id TEXT NOT NULL, action_hash TEXT NOT NULL, requester_kind TEXT NOT NULL, requester_id TEXT NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL, approver_kind TEXT, approver_id TEXT, granted_at INTEGER, denied_reason TEXT, consumed_at INTEGER, consume_idem TEXT UNIQUE);`);
    const { digest } = await import('@tecera/contracts');
    old.prepare('INSERT INTO evidence VALUES (?, ?, ?, ?, ?, ?)').run('old1', 'x', 'r', digest({ a: 1 }), '{"a":1}', 0);
    old.prepare('INSERT INTO evidence VALUES (?, ?, ?, ?, ?, ?)').run('old2', 'x', 'r', digest({ a: 2 }), '{"a":2}', 0);
    old.close();
    const l = new SqliteLedger(path);
    expect(await l.verifyChain()).toEqual({ ok: true, length: 0 });
    await l.evidence({ key: 'new', kind: 'x', runId: 'r', body: { a: 3 } });
    expect(await l.verifyChain()).toEqual({ ok: true, length: 0 });
    expect(() => l.rawExec(`UPDATE evidence SET body = '{}'`)).toThrow(/append-only/);
    expect(() => l.rawExec(`INSERT OR REPLACE INTO evidence (key, kind, run_id, digest, body, seq, n, prev_hash, hash, event_hash) VALUES ('old1', 'x', 'r', 'd', '{}', 0, 1, 'p', 'h', 'e')`)).toThrow(/append-only/);
    await l.requestApproval({ requestId: 'm', runId: 'r', sessionId: 's', actionHash: 'h', requester: { kind: 'agent', id: 'w' }, reason: 'x', expiresAt: 1000 });
    await grantAudited(l, 'm', { kind: 'human', id: 'h' }, 's', 10, { actionHash: 'h' });
    await l.consume('m', 'h', 's', 'cm', 20);
    l.close();
  });

  it('D3: a ledger whose budgets table predates soft pools gains enforce = 1 (its pools stay enforced)', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tecera-ledger-')), 'l.sqlite');
    const raw = new Database(path);
    raw.exec('CREATE TABLE budgets (run_id TEXT NOT NULL, pool TEXT NOT NULL, cap REAL NOT NULL, PRIMARY KEY (run_id, pool))');
    raw.prepare('INSERT INTO budgets (run_id, pool, cap) VALUES (?, ?, ?)').run('r', 'usd', 1);
    raw.close();
    const l = new SqliteLedger(path);
    expect(await l.budgetUsage('r')).toEqual([{ pool: 'usd', cap: 1, used: 0, enforce: true, reservations: 0 }]);
    await expect(l.reserve('usd', 2, 'r', 'k')).rejects.toThrow(/budget exceeded/);
    l.close();
  });

  it('a checkpoint whose stored state no longer matches its digest is refused', async () => {
    const l = new SqliteLedger(tmpDb());
    const id = await l.checkpoint('r', 'c', { v: 1 });
    l.rawExec('DROP TRIGGER checkpoints_no_update');
    l.rawExec(`UPDATE checkpoints SET state = '{"v":2}'`);
    await expect(l.loadCheckpoint(id)).rejects.toThrow(/digest/);
    l.close();
  });

  it('two connections: an audited grant on one is consumable on the other; a concurrent duplicate audit event is refused', async () => {
    const path = tmpDb();
    const a = new SqliteLedger(path);
    const b = new SqliteLedger(path);
    await a.requestApproval({ requestId: 'q', runId: 'r', sessionId: 's', actionHash: 'h', requester: { kind: 'agent', id: 'w' }, reason: 'r', expiresAt: 1000 });
    const audit = approvalGrantedEvent({ id: 'gq', at: 10, requestId: 'q', runId: 'r', sessionId: 's', actionHash: 'h', approver: { kind: 'human', id: 'h1' }, trace: { goalId: 'g', intentionId: 'i', stepId: 's' } });
    await a.approve('q', { kind: 'human', id: 'h1' }, 's', 10, audit);
    await b.consume('q', 'h', 's', 'cq', 20);
    expect((await a.getApproval('q'))!.state).toBe('consumed');
    expect(await b.verifyChain()).toEqual({ ok: true, length: 1 });
    a.close();
    b.close();
  });
});
