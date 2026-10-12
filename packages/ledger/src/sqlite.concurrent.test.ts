import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { approvalGrantedEvent, type Lease, type Principal } from '@tecera/contracts';
import { SqliteLedger } from './sqlite.js';

/**
 * Two processes, one WAL database, each with its own SqliteLedger (sqlite.concurrent.fixture.mjs). The
 * ledger's test barrier stops the first process right after its write lock is taken and before it reads the
 * row it decides on; the second process then starts the competing operation and blocks on the lock. The first
 * is released over its pipe. Who wins is decided by the lock, never by a sleep: the only timed waits are
 * deadlines for a failing test and a short window in which the blocked process must NOT be seen inside its
 * own transaction. Every race runs in both orders.
 *
 * The children load the built ledger (dist): rebuild the package after changing sqlite.ts.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'sqlite.concurrent.fixture.mjs');
const DEADLINE_MS = 30_000;
// Starting two node processes per test takes seconds on a loaded host; each wait inside is bounded by DEADLINE_MS.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });
/** How long a blocked process is watched for entering its transaction while the other holds the lock. */
const EXCLUSION_WINDOW_MS = 250;

type Reply = { ok: true; value: unknown } | { ok: false; error: string; code: string | null };

class Proc {
  private readonly reports: string[] = [];
  private readonly waiters: Array<() => void> = [];
  private readonly pending = new Map<number, (r: Reply) => void>();
  private seq = 0;

  private constructor(
    readonly name: string,
    private readonly child: ChildProcess,
  ) {
    let buf = '';
    child.stdio[4]!.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        this.reports.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      for (const w of this.waiters.splice(0)) w();
    });
    child.on('message', (m: { id?: number } & Reply) => {
      if (typeof m.id !== 'number') return;
      this.pending.get(m.id)?.(m);
      this.pending.delete(m.id);
    });
  }

  static async start(db: string, name: string): Promise<Proc> {
    const child = fork(FIXTURE, [db, name], { stdio: ['ignore', 'inherit', 'inherit', 'pipe', 'pipe', 'ipc'] });
    const ready = new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('exit', (code) => reject(new Error(`${name} exited ${String(code)} before it was ready`)));
    });
    await bounded(ready, `${name} to start`);
    return new Proc(name, child);
  }

  /** Start an operation; resolves with its reply. `holdAt` names the barrier points this call stops at. */
  call(cmd: string, args: Record<string, unknown>, o: { holdAt?: string[]; clock?: number } = {}): Promise<Reply> {
    const id = ++this.seq;
    const p = new Promise<Reply>((resolve) => this.pending.set(id, resolve));
    this.child.send({ id, cmd, args, holdAt: o.holdAt ?? [], ...(o.clock !== undefined ? { clock: o.clock } : {}) });
    return bounded(p, `${this.name} ${cmd} to reply`);
  }

  /** How many times `line` was reported so far. */
  count(line: string): number {
    return this.reports.filter((r) => r === line).length;
  }

  /** Resolves once `line` has been reported more than `seen` times. */
  async reported(line: string, seen = 0): Promise<void> {
    const wait = async (): Promise<void> => {
      while (this.count(line) <= seen) await new Promise<void>((r) => this.waiters.push(r));
    };
    await bounded(wait(), `${this.name} to report "${line}"`);
  }

  /** Release the barrier this process waits at; `clock` moves its injected clock first. */
  release(clock?: number): void {
    (this.child.stdio[3] as Writable).write(clock === undefined ? 'go\n' : `clock=${clock}\n`);
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const gone = new Promise<void>((r) => this.child.once('exit', () => r()));
    try {
      this.child.send({ cmd: 'exit' });
    } catch {
      /* already gone */
    }
    const t = setTimeout(() => this.child.kill('SIGKILL'), 2_000);
    await gone;
    clearTimeout(t);
  }
}

function bounded<T>(p: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${DEADLINE_MS} ms waiting for ${what}`)), DEADLINE_MS);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e as Error);
      },
    );
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Rig {
  db: string;
  a: Proc;
  b: Proc;
  /** A third connection, in this process: setup and what an uninvolved reader sees. */
  ledger: SqliteLedger;
}

const rigs: Array<{ dir: string; rig: Rig }> = [];

async function rig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'tecera-ledger-conc-'));
  const db = join(dir, 'l.sqlite');
  const ledger = new SqliteLedger(db);
  const [a, b] = await Promise.all([Proc.start(db, 'A'), Proc.start(db, 'B')]);
  const r = { db, a, b, ledger };
  rigs.push({ dir, rig: r });
  return r;
}

afterEach(async () => {
  for (const { dir, rig: r } of rigs.splice(0)) {
    await Promise.all([r.a.stop(), r.b.stop()]);
    r.ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * `first` runs its operation and is held at `point` with the write lock; `second` then starts its own and
 * must not get past its lock until `first` is released. Returns both replies.
 */
async function race(
  first: Proc,
  op1: { cmd: string; args: Record<string, unknown>; clock?: number },
  point: string,
  second: Proc,
  op2: { cmd: string; args: Record<string, unknown>; clock?: number },
  o: { whileHeld?: () => Promise<void>; releaseClock?: number } = {},
): Promise<[Reply, Reply]> {
  const held = first.count(`at ${point}`);
  const p1 = first.call(op1.cmd, op1.args, { holdAt: [point], ...(op1.clock !== undefined ? { clock: op1.clock } : {}) });
  await first.reported(`at ${point}`, held);
  const attempts = second.count(`attempting ${op2.cmd}`);
  const inside = second.count(`at ${op2.cmd}:locked`);
  const p2 = second.call(op2.cmd, op2.args, op2.clock !== undefined ? { clock: op2.clock } : {});
  await second.reported(`attempting ${op2.cmd}`, attempts);
  await sleep(EXCLUSION_WINDOW_MS);
  expect(second.count(`at ${op2.cmd}:locked`), `${second.name} entered its ${op2.cmd} transaction while ${first.name} held the write lock`).toBe(inside);
  if (o.whileHeld) await o.whileHeld();
  first.release(o.releaseClock);
  const r1 = await p1;
  const r2 = await p2;
  expect(second.count(`at ${op2.cmd}:locked`)).toBe(inside + 1);
  return [r1, r2];
}

const orders = (r: Rig): Array<[string, Proc, Proc]> => [
  ['A first', r.a, r.b],
  ['B first', r.b, r.a],
];

const agent: Principal = { kind: 'agent', id: 'worker' };
const h1: Principal = { kind: 'human', id: 'h1' };
const h2: Principal = { kind: 'human', id: 'h2' };

async function grantedEvents(l: SqliteLedger, requestId: string): Promise<Array<{ actor: Principal; seq: number }>> {
  const out: Array<{ actor: Principal; seq: number }> = [];
  for await (const e of l.events({ kinds: ['approval.granted'] })) if ((e.payload as { requestId?: string }).requestId === requestId) out.push({ actor: e.actor, seq: e.seq });
  return out;
}

const approveArgs = (requestId: string, approver: Principal, auditId: string) => ({ requestId, approver, sessionId: 's', at: 10, runId: 'r', actionHash: 'h', auditId });

beforeAll(() => {
  // The children run the built ledger: a stale build would test yesterday's code.
  const built = statSync(join(HERE, '..', 'dist', 'sqlite.js'), { throwIfNoEntry: false });
  if (!built || built.mtimeMs < statSync(join(HERE, 'sqlite.ts')).mtimeMs) throw new Error('packages/ledger/dist is missing or older than src/sqlite.ts: rebuild @tecera/ledger before running this file');
});

describe('two processes on one WAL database', () => {
  it('reserve: two reservations of 7 against a cap of 10, exactly one succeeds and usage is 7 (both orders)', async () => {
    const r = await rig();
    for (const [label, first, second] of orders(r)) {
      const run = `run-${label.replace(' ', '-')}`;
      await r.ledger.openBudget(run, 'usd', 10);
      const [r1, r2] = await race(first, { cmd: 'reserve', args: { pool: 'usd', amount: 7, runId: run, idemKey: `${run}:1` } }, 'reserve:locked', second, { cmd: 'reserve', args: { pool: 'usd', amount: 7, runId: run, idemKey: `${run}:2` } });
      expect(r1.ok, label).toBe(true);
      expect(r2, label).toMatchObject({ ok: false, code: 'budget', error: expect.stringMatching(/budget exceeded for pool usd: used 7 \+ 7 > cap 10/) });
      expect(await r.ledger.budgetUsage(run), label).toEqual([{ pool: 'usd', cap: 10, used: 7, enforce: true, reservations: 1 }]);
    }
  });

  it('reserve: the same idempotency key from both processes is one reservation (both orders)', async () => {
    const r = await rig();
    for (const [label, first, second] of orders(r)) {
      const run = `idem-${label.replace(' ', '-')}`;
      await r.ledger.openBudget(run, 'usd', 10);
      const args = { pool: 'usd', amount: 7, runId: run, idemKey: `${run}:same` };
      const [r1, r2] = await race(first, { cmd: 'reserve', args }, 'reserve:locked', second, { cmd: 'reserve', args });
      expect(r1.ok && r2.ok, label).toBe(true);
      if (r1.ok && r2.ok) expect((r2.value as { id: string }).id, label).toBe((r1.value as { id: string }).id);
      expect(await r.ledger.budgetUsage(run), label).toEqual([{ pool: 'usd', cap: 10, used: 7, enforce: true, reservations: 1 }]);
    }
  });

  it('approve: two grants give one winning approver and exactly one audit event (both orders)', async () => {
    const r = await rig();
    for (const [label, first, second] of orders(r)) {
      const id = `q-${label.replace(' ', '-')}`;
      await r.ledger.requestApproval({ requestId: id, runId: 'r', sessionId: 's', actionHash: 'h', requester: agent, reason: 'x', expiresAt: 1_000 });
      const [r1, r2] = await race(first, { cmd: 'approve', args: approveArgs(id, h1, `${id}-a1`) }, 'approve:locked', second, { cmd: 'approve', args: approveArgs(id, h2, `${id}-a2`) });
      expect(r1.ok, label).toBe(true);
      expect(r2, label).toMatchObject({ ok: false, code: 'approval', error: expect.stringMatching(/is granted/) });
      expect(await r.ledger.getApproval(id), label).toMatchObject({ state: 'granted', approver: h1 });
      const audits = await grantedEvents(r.ledger, id);
      expect(audits.map((e) => e.actor), label).toEqual([h1]);
    }
    expect(await r.ledger.verifyChain()).toEqual({ ok: true, length: 2 });
  });

  it('approve: a forced audit insertion failure leaves the request pending with no event; a forced grant failure rolls the audit event back', async () => {
    const r = await rig();
    await r.ledger.requestApproval({ requestId: 'q', runId: 'r', sessionId: 's', actionHash: 'h', requester: agent, reason: 'x', expiresAt: 1_000 });
    // 1. the audit event cannot be inserted: nothing is granted
    expect((await r.a.call('rawExec', { sql: `CREATE TRIGGER test_no_audit BEFORE INSERT ON events WHEN NEW.kind = 'approval.granted' BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END;` })).ok).toBe(true);
    expect(await r.a.call('approve', approveArgs('q', h1, 'a1'))).toMatchObject({ ok: false, error: expect.stringMatching(/forced audit failure/) });
    expect(await r.b.call('approve', approveArgs('q', h2, 'a2'))).toMatchObject({ ok: false, error: expect.stringMatching(/forced audit failure/) });
    expect((await r.ledger.getApproval('q'))!.state).toBe('pending');
    expect(await grantedEvents(r.ledger, 'q')).toEqual([]);
    expect((await r.a.call('rawExec', { sql: 'DROP TRIGGER test_no_audit' })).ok).toBe(true);
    // 2. the audit event is inserted, then the grant itself fails: the event must not survive
    expect((await r.a.call('rawExec', { sql: `CREATE TRIGGER test_no_grant BEFORE UPDATE ON approvals WHEN NEW.state = 'granted' BEGIN SELECT RAISE(ABORT, 'forced grant failure'); END;` })).ok).toBe(true);
    const audited = r.b.count('at approve:audited');
    expect(await r.b.call('approve', approveArgs('q', h2, 'a3'))).toMatchObject({ ok: false, error: expect.stringMatching(/forced grant failure/) });
    expect(r.b.count('at approve:audited')).toBe(audited + 1); // the audit event really was inserted first
    expect((await r.ledger.getApproval('q'))!.state).toBe('pending');
    expect(await grantedEvents(r.ledger, 'q')).toEqual([]);
    expect((await r.a.call('rawExec', { sql: 'DROP TRIGGER test_no_grant' })).ok).toBe(true);
    // 3. afterwards the request is still grantable, once, and the numbering has no hole
    expect((await r.b.call('approve', approveArgs('q', h2, 'a4'))).ok).toBe(true);
    expect((await grantedEvents(r.ledger, 'q')).map((e) => [e.actor.id, e.seq])).toEqual([['h2', 1]]);
    expect(await r.ledger.verifyChain()).toEqual({ ok: true, length: 1 });
  });

  it('consume: two consumes of one grant, exactly one succeeds (both orders)', async () => {
    const r = await rig();
    for (const [label, first, second] of orders(r)) {
      const id = `c-${label.replace(' ', '-')}`;
      await r.ledger.requestApproval({ requestId: id, runId: 'r', sessionId: 's', actionHash: 'h', requester: agent, reason: 'x', expiresAt: 1_000 });
      await r.ledger.approve(id, h1, 's', 10, approvalGrantedEvent({ id: `${id}-audit`, at: 10, requestId: id, runId: 'r', sessionId: 's', actionHash: 'h', approver: h1, trace: { goalId: 'g', intentionId: 'i', stepId: 's' } }));
      const [r1, r2] = await race(first, { cmd: 'consume', args: { requestId: id, actionHash: 'h', sessionId: 's', idemKey: `${id}:1`, at: 20 } }, 'consume:locked', second, { cmd: 'consume', args: { requestId: id, actionHash: 'h', sessionId: 's', idemKey: `${id}:2`, at: 20 } });
      expect(r1.ok, label).toBe(true);
      expect(r2, label).toMatchObject({ ok: false, code: 'approval', error: expect.stringMatching(/state is consumed/) });
      expect((await r.ledger.getApproval(id))!.state, label).toBe('consumed');
    }
  });

  it('consume: a wrong action hash or session in either process leaves the grant unspent', async () => {
    const r = await rig();
    await r.ledger.requestApproval({ requestId: 'w', runId: 'r', sessionId: 's', actionHash: 'h', requester: agent, reason: 'x', expiresAt: 1_000 });
    await r.ledger.approve('w', h1, 's', 10, approvalGrantedEvent({ id: 'w-audit', at: 10, requestId: 'w', runId: 'r', sessionId: 's', actionHash: 'h', approver: h1, trace: { goalId: 'g', intentionId: 'i', stepId: 's' } }));
    const [r1, r2] = await race(r.a, { cmd: 'consume', args: { requestId: 'w', actionHash: 'other', sessionId: 's', idemKey: 'w:1', at: 20 } }, 'consume:locked', r.b, { cmd: 'consume', args: { requestId: 'w', actionHash: 'h', sessionId: 'other', idemKey: 'w:2', at: 20 } });
    expect(r1).toMatchObject({ ok: false, error: expect.stringMatching(/action hash mismatch/) });
    expect(r2).toMatchObject({ ok: false, error: expect.stringMatching(/session mismatch/) });
    expect((await r.ledger.getApproval('w'))!.state).toBe('granted');
    // a refused consume burned neither the grant nor its idempotency key
    expect((await r.b.call('consume', { requestId: 'w', actionHash: 'h', sessionId: 's', idemKey: 'w:1', at: 20 })).ok).toBe(true);
    expect((await r.ledger.getApproval('w'))!.state).toBe('consumed');
  });

  it('grant then consume: while the audit event is written but the grant is not, nobody sees either; the consumer then sees both', async () => {
    const r = await rig();
    await r.ledger.requestApproval({ requestId: 'g', runId: 'r', sessionId: 's', actionHash: 'h', requester: agent, reason: 'x', expiresAt: 1_000 });
    const [r1, r2] = await race(r.a, { cmd: 'approve', args: approveArgs('g', h1, 'g-audit') }, 'approve:audited', r.b, { cmd: 'consume', args: { requestId: 'g', actionHash: 'h', sessionId: 's', idemKey: 'g:1', at: 20 } }, {
      whileHeld: async () => {
        // An uninvolved reader, mid-grant: the request is still pending and its audit event does not exist.
        expect((await r.ledger.getApproval('g'))!.state).toBe('pending');
        expect(await grantedEvents(r.ledger, 'g')).toEqual([]);
        expect(await r.ledger.verifyChain()).toEqual({ ok: true, length: 0 });
      },
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok, JSON.stringify(r2)).toBe(true); // the consumer waited for the whole grant: row AND audit event
    expect((await r.ledger.getApproval('g'))!.state).toBe('consumed');
    expect((await grantedEvents(r.ledger, 'g')).map((e) => e.actor)).toEqual([h1]);
  });

  it('consume then grant: a consumer that holds the lock first refuses the still-pending request; the grant lands unspent', async () => {
    const r = await rig();
    await r.ledger.requestApproval({ requestId: 'g2', runId: 'r', sessionId: 's', actionHash: 'h', requester: agent, reason: 'x', expiresAt: 1_000 });
    const [r1, r2] = await race(r.b, { cmd: 'consume', args: { requestId: 'g2', actionHash: 'h', sessionId: 's', idemKey: 'g2:1', at: 20 } }, 'consume:locked', r.a, { cmd: 'approve', args: approveArgs('g2', h1, 'g2-audit') });
    expect(r1).toMatchObject({ ok: false, code: 'approval', error: expect.stringMatching(/state is pending/) });
    expect(r2.ok).toBe(true);
    expect((await r.ledger.getApproval('g2'))!.state).toBe('granted');
    expect(await grantedEvents(r.ledger, 'g2')).toHaveLength(1);
  });

  it('lease: time is read after the write lock is held (a lease that expires while a process waits is taken over; a renewal that waited past the expiry is refused)', async () => {
    const r = await rig();
    const l1 = (await r.a.call('lease', { resource: 'wt', holder: 'a', ttlMs: 100 }, { clock: 1_000 })) as { ok: true; value: Lease };
    expect(l1.value).toMatchObject({ fencingToken: 1, expiresAt: 1_100 });
    // B asks at 1050 (the lease is live), is held inside its transaction, and its clock moves to 1200 there.
    const pB = r.b.call('lease', { resource: 'wt', holder: 'b', ttlMs: 100 }, { clock: 1_050, holdAt: ['lease:locked'] });
    await r.b.reported('at lease:locked');
    r.b.release(1_200);
    const l2 = (await pB) as { ok: true; value: Lease };
    expect(l2.value).toMatchObject({ holder: 'b', fencingToken: 2, expiresAt: 1_300 });
    // B renews at 1250 (live), is held, and its clock passes the expiry before it reads the row: refused.
    const pR = r.b.call('renew', { lease: l2.value, ttlMs: 100 }, { clock: 1_250, holdAt: ['renew:locked'] });
    await r.b.reported('at renew:locked');
    r.b.release(1_300);
    expect(await pR).toMatchObject({ ok: false, code: 'lease', error: expect.stringMatching(/no longer held by b: it expired before the renewal/) });
    // Nobody acquired it in between, and it still cannot be renewed.
    expect(await r.b.call('renew', { lease: l2.value, ttlMs: 100 }, { clock: 1_300 })).toMatchObject({ ok: false, code: 'lease' });
  });

  it('lease takeover: the token strictly increases, the old token can neither renew nor release the new lease, and it never restarts (both orders)', async () => {
    const r = await rig();
    for (const [label, first, second] of orders(r)) {
      const res = `wt-${label.replace(' ', '-')}`;
      const old = ((await first.call('lease', { resource: res, holder: 'old', ttlMs: 100 }, { clock: 1_000 })) as { ok: true; value: Lease }).value;
      expect(old.fencingToken, label).toBe(1);
      await second.call('getApproval', { requestId: 'none' }, { clock: 1_200 }); // moves the second process's clock past the expiry
      // The expired holder's renewal races the takeover; whoever holds the lock first, the takeover wins.
      const [r1, r2] = await race(first, { cmd: 'renew', args: { lease: old, ttlMs: 100 }, clock: 1_200 }, 'renew:locked', second, { cmd: 'lease', args: { resource: res, holder: 'new', ttlMs: 100 } });
      expect(r1, label).toMatchObject({ ok: false, code: 'lease' });
      expect(r2.ok, label).toBe(true);
      const cur = (r2 as { ok: true; value: Lease }).value;
      expect(cur, label).toMatchObject({ holder: 'new', fencingToken: 2, expiresAt: 1_300 });
      // The other way round: the takeover holds the lock while the old holder tries to renew and release.
      const res2 = `${res}-2`;
      const old2 = ((await first.call('lease', { resource: res2, holder: 'old', ttlMs: 100 }, { clock: 1_000 })) as { ok: true; value: Lease }).value;
      await first.call('getApproval', { requestId: 'none' }, { clock: 1_200 });
      const [t1, t2] = await race(second, { cmd: 'lease', args: { resource: res2, holder: 'new', ttlMs: 100 }, clock: 1_200 }, 'lease:locked', first, { cmd: 'renew', args: { lease: old2, ttlMs: 100 } });
      expect(t1.ok, label).toBe(true);
      const cur2 = (t1 as { ok: true; value: Lease }).value;
      expect(cur2.fencingToken, label).toBe(2);
      expect(t2, label).toMatchObject({ ok: false, code: 'lease', error: expect.stringMatching(/no longer held by old/) });
      // The old token releases nothing: the new lease is still exclusive and still renewable by its owner.
      expect((await first.call('release', { lease: old2 })).ok, label).toBe(true);
      expect(await first.call('lease', { resource: res2, holder: 'third', ttlMs: 100 }), label).toMatchObject({ ok: true, value: null });
      expect(await second.call('renew', { lease: cur2, ttlMs: 100 }), label).toMatchObject({ ok: true, value: { fencingToken: 2 } });
      // Release and reacquire: the token moves on, it does not restart.
      expect((await second.call('release', { lease: cur2 })).ok, label).toBe(true);
      expect(await second.call('renew', { lease: cur2, ttlMs: 100 }), label).toMatchObject({ ok: false, code: 'lease' });
      expect(await second.call('lease', { resource: res2, holder: 'new', ttlMs: 100 }), label).toMatchObject({ ok: true, value: { fencingToken: 3 } });
      expect(await first.call('lease', { resource: res2, holder: 'old', ttlMs: 100 }, { clock: 5_000 }), label).toMatchObject({ ok: true, value: { fencingToken: 4 } });
    }
  });
});
