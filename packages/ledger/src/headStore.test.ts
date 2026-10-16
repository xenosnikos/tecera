import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { approvalGrantedEvent, event, type LedgerHead } from '@tecera/contracts';
import { HeadStore, type HeadBarrierPoint } from './headStore.js';
import { SqliteLedger } from './sqlite.js';

/**
 * The head checkpoint (hardened mode). Every tamper below is one an unkeyed chain cannot see: the database
 * stays internally consistent (a positive control opens the same file without the checkpoint and verifies
 * it), and only the checkpoint kept outside the database tells the acknowledged head from the one on disk.
 * The crash cases run the write in a child process that SIGKILLs itself at each step of the transition
 * (headStore.crash.fixture.mjs; it loads dist, so rebuild after changing the sources).
 */

vi.setConfig({ testTimeout: 60_000 });
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'headStore.crash.fixture.mjs');

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fresh(): { db: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tecera-head-'));
  temps.push(dir);
  return { db: join(dir, 'ledger.sqlite'), dir };
}

const ev = (id: string, i = 0) => event('belief.added', { id, at: 1000 + i, actor: { kind: 'system', id: 'test' }, runId: 'r1', trace: {}, payload: { key: id, value: i } });

function open(db: string, dir: string): SqliteLedger {
  return new SqliteLedger(db, { head: new HeadStore(dir), journalMode: 'delete' });
}

/** An enrolled genesis ledger with `events` events and `evidence` evidence rows. */
async function seeded(events = 3, evidence = 2): Promise<{ db: string; dir: string }> {
  const f = fresh();
  const l = open(f.db, f.dir);
  await l.enroll('genesis', 'ledger-test-0001');
  for (let i = 0; i < events; i++) await l.append(ev(`e${i}`, i));
  for (let i = 0; i < evidence; i++) await l.evidence({ key: `k${i}`, kind: 'gate.verify', runId: 'r1', body: { exitCode: 0, i } });
  l.close();
  return f;
}

const head = (dir: string): LedgerHead => JSON.parse(readFileSync(join(dir, 'head.json'), 'utf8')) as LedgerHead;
const journals = (dir: string): string[] => readdirSync(dir).filter((n) => n.startsWith('head.pending.'));

/** Raw SQL on the file with the append-only triggers dropped (an attacker with write access to the database). */
function tamper(db: string, sql: string): void {
  const d = new DatabaseSync(db);
  d.exec('DROP TRIGGER IF EXISTS events_no_delete; DROP TRIGGER IF EXISTS events_no_update; DROP TRIGGER IF EXISTS evidence_no_delete; DROP TRIGGER IF EXISTS evidence_no_update;');
  d.exec(sql);
  d.close();
}

/** The same file, opened without the checkpoint, still verifies: the chain alone cannot see the tamper. */
async function chainAloneVerifies(db: string): Promise<boolean> {
  const plain = new SqliteLedger(db, { journalMode: 'delete' });
  try {
    return (await plain.verifyChain()).ok;
  } finally {
    plain.close();
  }
}

describe('ledger head checkpoint', () => {
  it('genesis enrollment; every acknowledged write that changes a chain moves the checkpoint by one generation; nothing is left pending', async () => {
    const f = fresh();
    const l = open(f.db, f.dir);
    const h0 = await l.enroll('genesis', 'ledger-test-0001');
    expect(h0).toMatchObject({ ledgerId: 'ledger-test-0001', formatVersion: 1, eventCount: 0, evidenceCount: 0, generation: 0, baseline: 'genesis' });
    await l.append(ev('a'));
    await l.append(ev('a')); // duplicate: no write, no generation
    await l.evidence({ key: 'k', kind: 'gate.verify', runId: 'r1', body: { exitCode: 0 } });
    await l.openBudget('r1', 'usd', 1); // no chain change: admitted, not moved
    await l.requestApproval({ requestId: 'ap1', runId: 'r1', sessionId: 's1', actionHash: 'h1', requester: { kind: 'agent', id: 'loop' }, reason: 'pr', expiresAt: 10_000_000_000_000 });
    const audit = approvalGrantedEvent({ id: 'g1', at: 2000, requestId: 'ap1', runId: 'r1', sessionId: 's1', actionHash: 'h1', approver: { kind: 'human', id: 'bob' }, trace: { goalId: 'g1', intentionId: 'i1', stepId: 'pr' } });
    await l.approve('ap1', { kind: 'human', id: 'bob' }, 's1', 2000, audit);
    const h = head(f.dir);
    expect(h).toMatchObject({ eventCount: 2, evidenceCount: 1, generation: 3 });
    expect(h).toMatchObject({ eventHeadHash: l.headState().eventHeadHash, evidenceHeadHash: l.headState().evidenceHeadHash });
    expect(journals(f.dir)).toEqual([]);
    expect(await l.verifyChain()).toEqual({ ok: true, length: 2 });
    l.close();
  });

  it('deleting the last event is detected; the chain alone does not see it; the next write is refused', async () => {
    const f = await seeded(3, 0);
    tamper(f.db, 'DELETE FROM events WHERE seq = 3');
    expect(await chainAloneVerifies(f.db)).toBe(true);
    const l = open(f.db, f.dir);
    const v = await l.verifyChain();
    expect(v.ok).toBe(false);
    expect(v.ok ? '' : v.reason).toMatch(/ledger head checkpoint: .*1 acknowledged event\(s\) are missing/);
    await expect(l.append(ev('after'))).rejects.toThrow(/does not match the checkpoint.*refusing to write/);
    l.close();
  });

  it('deleting only the last evidence row is detected (both chains are pinned)', async () => {
    const f = await seeded(2, 2);
    tamper(f.db, `DELETE FROM evidence WHERE n = 2`);
    expect(await chainAloneVerifies(f.db)).toBe(true);
    const l = open(f.db, f.dir);
    const v = await l.verifyChain();
    expect(v.ok ? '' : v.reason).toMatch(/1 acknowledged evidence row\(s\) are missing/);
    l.close();
  });

  it('restoring an older copy of the database is detected', async () => {
    const f = await seeded(2, 1);
    const old = join(f.dir, 'old.sqlite');
    copyFileSync(f.db, old);
    const l = open(f.db, f.dir);
    await l.append(ev('later', 9));
    await l.evidence({ key: 'later', kind: 'gate.verify', runId: 'r1', body: { exitCode: 0 } });
    l.close();
    copyFileSync(old, f.db);
    expect(await chainAloneVerifies(f.db)).toBe(true);
    const r = open(f.db, f.dir);
    const v = await r.verifyChain();
    expect(v.ok ? '' : v.reason).toMatch(/1 acknowledged event\(s\) are missing; 1 acknowledged evidence row\(s\) are missing/);
    r.close();
  });

  it('renumbering the events is detected', async () => {
    const f = await seeded(4, 0);
    // drop the last event and move the rest up so the numbering stays contiguous
    tamper(f.db, 'DELETE FROM events WHERE seq = 4; UPDATE events SET seq = seq + 10; UPDATE events SET seq = seq - 10');
    const l = open(f.db, f.dir);
    const v = await l.verifyChain();
    expect(v.ok).toBe(false);
    expect(v.ok ? '' : v.reason).toMatch(/ledger head checkpoint/);
    l.close();
    // a gap in the middle is reported by the chain itself, before the checkpoint is consulted
    const g = await seeded(4, 0);
    tamper(g.db, 'DELETE FROM events WHERE seq = 2');
    const lg = open(g.db, g.dir);
    const vg = await lg.verifyChain();
    expect(vg.ok ? '' : vg.reason).toMatch(/events sequence has a gap/);
    lg.close();
  });

  it('replacing the database with another ledger, enrolled or not, is detected', async () => {
    const f = await seeded(2, 1);
    // another enrolled ledger with exactly the same rows: only its id differs
    const other = await seeded(2, 1);
    const od = new DatabaseSync(other.db);
    od.exec(`DROP TRIGGER ledger_meta_no_update; UPDATE ledger_meta SET value = 'ledger-other-002' WHERE key = 'ledgerId'`);
    od.close();
    copyFileSync(other.db, f.db);
    expect(await chainAloneVerifies(f.db)).toBe(true);
    const l = open(f.db, f.dir);
    expect(((await l.verifyChain()) as { reason?: string }).reason).toMatch(/is not the enrolled ledger .*ledger-other-002.*replaced/);
    l.close();
    // a database that was never enrolled
    const plain = fresh();
    const p = new SqliteLedger(plain.db, { journalMode: 'delete' });
    await p.append(ev('x'));
    p.close();
    copyFileSync(plain.db, f.db);
    const l2 = open(f.db, f.dir);
    expect(((await l2.verifyChain()) as { reason?: string }).reason).toMatch(/has no ledger id/);
    l2.close();
  });

  it('anything but the recorded transition fails closed: a foreign pending journal, a malformed or missing checkpoint, a second enrollment', async () => {
    const f = await seeded(1, 0);
    const h = head(f.dir);
    // a journal that matches neither the database nor the checkpoint
    const bogus = { from: { ...h, eventCount: 7, generation: h.generation + 4 }, to: { ...h, eventCount: 8, generation: h.generation + 5 } };
    writeFileSync(join(f.dir, `head.pending.${h.generation + 5}.json`), JSON.stringify(bogus));
    const l = open(f.db, f.dir);
    expect(((await l.verifyChain()) as { reason?: string }).reason).toMatch(/matches neither the database nor the checkpoint/);
    await expect(l.append(ev('y'))).rejects.toThrow(/matches neither/);
    rmSync(join(f.dir, `head.pending.${h.generation + 5}.json`));
    // a checkpoint that does not parse
    writeFileSync(join(f.dir, 'head.json'), '{"formatVersion": 1');
    expect(((await l.verifyChain()) as { reason?: string }).reason).toMatch(/not readable JSON/);
    // a missing checkpoint of an enrolled ledger: an error, never a reason to enroll again
    rmSync(join(f.dir, 'head.json'));
    expect(((await l.verifyChain()) as { reason?: string }).reason).toMatch(/enrolled but its checkpoint is missing/);
    await expect(l.append(ev('z'))).rejects.toThrow(/checkpoint is missing; refusing to write/);
    await expect(l.enroll('legacy', 'ledger-again-001')).rejects.toThrow(/was enrolled before and its checkpoint is missing/);
    l.close();
    // a checkpoint that exists already: enrolled once
    const g = await seeded(0, 0);
    const lg = open(g.db, g.dir);
    await expect(lg.enroll('genesis', 'ledger-test-0002')).rejects.toThrow(/already exists|enrolled before/);
    lg.close();
  });

  it('legacy enrollment: an existing ledger is verified and its current head becomes the baseline; a broken one is refused', async () => {
    const f = fresh();
    const plain = new SqliteLedger(f.db, { journalMode: 'delete' });
    for (let i = 0; i < 3; i++) await plain.append(ev(`old${i}`, i));
    await plain.evidence({ key: 'old', kind: 'gate.verify', runId: 'r1', body: {} });
    plain.close();
    const l = open(f.db, f.dir);
    await expect(l.append(ev('before'))).rejects.toThrow(/not enrolled/);
    await expect(l.enroll('genesis', 'ledger-test-0003')).rejects.toThrow(/legacy baseline, not as genesis/);
    const h = await l.enroll('legacy', 'ledger-test-0003');
    expect(h).toMatchObject({ baseline: 'legacy', eventCount: 3, evidenceCount: 1, generation: 0 });
    await l.append(ev('new'));
    expect(head(f.dir)).toMatchObject({ eventCount: 4, generation: 1 });
    expect((await l.verifyChain()).ok).toBe(true);
    l.close();
    const b = fresh();
    const pb = new SqliteLedger(b.db, { journalMode: 'delete' });
    for (let i = 0; i < 3; i++) await pb.append(ev(`b${i}`, i));
    pb.close();
    tamper(b.db, `UPDATE events SET payload = '{"key":"b1","value":42}' WHERE seq = 2`);
    const lb = open(b.db, b.dir);
    await expect(lb.enroll('legacy', 'ledger-test-0004')).rejects.toThrow(/does not verify .*refusing to enroll/);
    expect(existsSync(join(b.dir, 'head.json'))).toBe(false);
    lb.close();
  });

  it('a read-only connection verifies against the checkpoint and cannot write', async () => {
    const f = await seeded(2, 1);
    const r = new SqliteLedger(f.db, { readonly: true, head: new HeadStore(f.dir) });
    expect(await r.verifyChain()).toEqual({ ok: true, length: 2 });
    await expect(r.append(ev('w'))).rejects.toThrow(/readonly|read-only/i);
    r.close();
  });

  describe('a crash at every step of a transition recovers to exactly the recorded transition', () => {
    const points: HeadBarrierPoint[] = ['admitted', 'journal-written', 'head-written', 'committed', 'settled'];
    const ops = ['event', 'evidence', 'approve'] as const;
    for (const op of ops) {
      for (const point of points) {
        it(`${op} killed at ${point}`, async () => {
          const f = await seeded(2, 1);
          if (op === 'approve') {
            const l0 = open(f.db, f.dir);
            await l0.requestApproval({ requestId: 'ap1', runId: 'r1', sessionId: 's1', actionHash: 'h1', requester: { kind: 'agent', id: 'loop' }, reason: 'pr', expiresAt: 10_000_000_000_000 });
            l0.close();
          }
          const before = head(f.dir);
          const r = spawnSync(process.execPath, [FIXTURE, f.db, f.dir, point, op], { encoding: 'utf8', timeout: 30_000 });
          expect(r.signal, r.stderr).toBe('SIGKILL');
          expect(r.stdout).not.toContain('done');
          const committed = point === 'committed' || point === 'settled';
          // a reader (no recovery) accepts the state the crash left
          const reader = new SqliteLedger(f.db, { readonly: true, head: new HeadStore(f.dir) });
          expect(await reader.verifyChain(), `reader after ${point}`).toMatchObject({ ok: true });
          const d = reader.headState();
          reader.close();
          const expectEvents = before.eventCount + (committed && op !== 'evidence' ? 1 : 0);
          const expectEvidence = before.evidenceCount + (committed && op === 'evidence' ? 1 : 0);
          expect(d).toMatchObject({ eventCount: expectEvents, evidenceCount: expectEvidence });
          // the next writer settles it and moves on from exactly that state
          const w = open(f.db, f.dir);
          await w.append(ev('next', 99));
          const after = head(f.dir);
          expect(after.eventCount).toBe(expectEvents + 1);
          expect(after.evidenceCount).toBe(expectEvidence);
          expect(after.generation).toBe(before.generation + (committed ? 2 : 1));
          expect(journals(f.dir)).toEqual([]);
          expect(await w.verifyChain()).toMatchObject({ ok: true });
          if (op === 'approve') expect((await w.getApproval('ap1'))?.state).toBe(committed ? 'granted' : 'pending');
          w.close();
        });
      }
    }
  });
});
