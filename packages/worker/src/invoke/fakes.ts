import { randomUUID } from 'node:crypto';
import {
  approvalAuditProblem,
  approvalGrantedEvent,
  digest,
  FencedWriteGuard,
  HOST_FUNCTIONS,
  LedgerError,
  type AppendResult,
  type ApprovalGrant,
  type ApprovalRequest,
  type ApprovalView,
  type EvidenceRecord,
  type ExecRequest,
  type ExecResult,
  type Json,
  type JsonObject,
  type Lease,
  type Ledger,
  type LLM,
  type LLMRequest,
  type LLMResponse,
  type Principal,
  type Repl,
  type Reservation,
  type TeceraEvent,
  type ToolBridge,
  type WriteAuthorization,
  type WriteIntent,
} from '@tecera/contracts';

/**
 * Test doubles for the invoke loop, exported for other packages' tests. FakeRepl is NOT a sandbox: it
 * evaluates the program in-process (or runs scripted execs) so tests exercise the real broker path;
 * never wire it into a run. FakeLLM replays scripted replies. FakeLedger is a minimal in-memory Ledger
 * with the approval/budget/evidence semantics the worker relies on, including the production audit rule:
 * approve(…, audit) records the grant and its approval.granted event together, and consume() refuses a
 * grant without a matching audit event (grantAudited() is the test shortcut that approves with one).
 */

export type ExecReply = ExecResult & { printed: string };
export type ScriptedExec = (req: ExecRequest, bridge: ToolBridge, signal?: AbortSignal) => ExecReply | Promise<ExecReply>;

const IDENT = /^[A-Za-z_$][\w$]*$/;
// eslint-disable-next-line @typescript-eslint/no-empty-function
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

export class FakeRepl implements Repl {
  readonly execs: ExecRequest[] = [];
  private readonly script: ScriptedExec[];
  private n = 0;

  constructor(o: { script?: ScriptedExec[] } = {}) {
    this.script = [...(o.script ?? [])];
  }

  async exec(req: ExecRequest, bridge: ToolBridge, signal?: AbortSignal): Promise<ExecReply> {
    this.execs.push(req);
    const s = this.script.shift();
    if (s) return s(req, bridge, signal);
    return this.evaluate(req, bridge, signal);
  }

  async dispose(): Promise<void> {}

  private async evaluate(req: ExecRequest, bridge: ToolBridge, signal?: AbortSignal): Promise<ExecReply> {
    const lines: string[] = [];
    const fmt = (args: unknown[]): string => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    const con = { log: (...a: unknown[]) => lines.push(fmt(a)), warn: (...a: unknown[]) => lines.push(fmt(a)), error: (...a: unknown[]) => lines.push(fmt(a)) };
    const names: string[] = [];
    const values: unknown[] = [];
    for (const [name, b] of Object.entries(req.bindings)) {
      if (!IDENT.test(name)) continue;
      names.push(name);
      if (b.kind === 'handle') {
        const call = async (method: string, args: unknown[]): Promise<unknown> => {
          const r = await bridge({ callId: `c${++this.n}`, tool: b.id, method, args: JSON.parse(JSON.stringify(args ?? [])) as Json[], idemKey: '' });
          if (!r.ok) {
            const e = new Error(r.error?.message ?? 'tool failed');
            e.name = r.error?.name ?? 'Error';
            throw e;
          }
          return r.value;
        };
        if (b.methods.length === 1 && b.methods[0] === 'call') {
          // Callable stub (`readFile(p)`) that also answers the method form (`readFile.call(p)`).
          const fn = (...args: unknown[]) => call('call', args);
          Object.defineProperty(fn, 'call', { value: (...args: unknown[]) => call('call', args) });
          values.push(fn);
        } else values.push(Object.fromEntries(b.methods.map((m) => [m, (...args: unknown[]) => call(m, args)])));
      } else if (b.kind === 'value') values.push(structuredClone(b.value));
      else values.push(undefined); // hidden bindings never reach a program
    }
    // Host functions, as the sandbox child provides them: routed to the bridge by reserved tool names.
    const host = async (tool: string, method: string, args: unknown[]): Promise<unknown> => {
      const r = await bridge({ callId: `c${++this.n}`, tool, method, args: JSON.parse(JSON.stringify(args)) as Json[], idemKey: '' });
      if (!r.ok) {
        const e = new Error(r.error?.message ?? 'refused');
        e.name = r.error?.name ?? 'Error';
        throw e;
      }
      return r.value;
    };
    for (const [name, fn] of [
      ['invoke', (inputs: unknown, opts: unknown) => host(HOST_FUNCTIONS.invoke, 'invoke', [inputs ?? {}, opts ?? {}])],
      ['checkpoint', (key: unknown, value: unknown) => host(HOST_FUNCTIONS.checkpoint, 'call', [key, value ?? null])],
    ] as const) {
      if (names.includes(name)) continue;
      names.push(name);
      values.push(fn);
    }
    const printed = (): string => lines.join('\n');
    try {
      const fn = new AsyncFunction(...names, 'console', req.code);
      const v = await fn(...values, con);
      if (signal?.aborted) return { kind: 'raise', exception: { name: 'Cancelled', message: 'exec cancelled' }, printed: printed() };
      if (v === undefined) return { kind: 'continue', output: printed(), printed: printed() };
      return { kind: 'return', value: JSON.parse(JSON.stringify(v)) as Json, output: printed(), printed: printed() };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      return { kind: 'raise', exception: { name: err.name, message: err.message }, printed: printed() };
    }
  }
}

export type FakeReply = string | Error | ((req: LLMRequest, n: number) => string | Promise<string>);

export class FakeLLM implements LLM {
  readonly requests: LLMRequest[] = [];
  private readonly replies: FakeReply[];

  constructor(replies: FakeReply[], readonly id = 'fake-model', readonly provider = 'fake') {
    this.replies = [...replies];
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(structuredClone(req));
    const r = this.replies.shift();
    if (r === undefined) throw new Error('FakeLLM: no scripted reply left');
    if (r instanceof Error) throw r;
    const content = typeof r === 'function' ? await r(req, this.requests.length) : r;
    const inChars = req.messages.reduce((n, m) => n + m.content.length, 0);
    return { content, usage: { inputTokens: Math.ceil(inChars / 4), outputTokens: Math.ceil(content.length / 4), usd: 0 }, model: this.id, finishReason: 'stop' };
  }
}

/** Minimal in-memory Ledger (the worker does not depend on @tecera/ledger). */
export class FakeLedger implements Ledger {
  readonly log: Array<TeceraEvent & { seq: number; hash: string }> = [];
  readonly ev = new Map<string, EvidenceRecord>();
  readonly checkpoints = new Map<string, JsonObject>();
  readonly approvals = new Map<string, ApprovalRequest & { state: 'pending' | 'granted' | 'denied' | 'consumed' | 'expired'; approver?: Principal }>();
  private readonly budgets = new Map<string, number>();
  private readonly reservations = new Map<string, Reservation & { state: 'reserved' | 'charged'; actual?: number; idem: string }>();
  private readonly leases = new Map<string, Lease>();
  private token = 0;

  async append(e: TeceraEvent): Promise<AppendResult> {
    const dup = e.idemKey ? this.log.find((x) => x.idemKey === e.idemKey) : undefined;
    if (dup) return { seq: dup.seq, hash: dup.hash, duplicate: true };
    const seq = this.log.length + 1;
    const hash = digest({ seq, e: e as unknown as Json });
    this.log.push({ ...e, seq, hash });
    return { seq, hash, duplicate: false };
  }
  async *events(): AsyncIterable<TeceraEvent & { seq: number; hash: string }> {
    for (const e of this.log) yield e;
  }
  async verifyChain(): Promise<{ ok: true; length: number }> {
    return { ok: true, length: this.log.length };
  }
  async evidence(e: { key: string; kind: string; runId: string; body: Json }): Promise<EvidenceRecord> {
    const d = digest(e.body);
    const cur = this.ev.get(e.key);
    if (cur) {
      if (cur.digest !== d) throw new LedgerError(`evidence key ${e.key} already exists with a different body`, 'evidence');
      return cur;
    }
    const rec: EvidenceRecord = { key: e.key, kind: e.kind, runId: e.runId, digest: d, body: structuredClone(e.body), seq: this.ev.size };
    this.ev.set(e.key, rec);
    return rec;
  }
  async getEvidence(key: string): Promise<EvidenceRecord | null> {
    return this.ev.get(key) ?? null;
  }
  /** Evidence of a run in write order, optionally only kinds starting with `kindPrefix` (literal). */
  async listEvidence(runId: string, kindPrefix?: string): Promise<EvidenceRecord[]> {
    return [...this.ev.values()].filter((r) => r.runId === runId && (kindPrefix === undefined || r.kind.startsWith(kindPrefix))).sort((a, b) => a.seq - b.seq).map((r) => structuredClone(r));
  }
  async openBudget(runId: string, pool: string, cap: number): Promise<void> {
    this.budgets.set(`${runId}:${pool}`, cap);
  }
  async reserve(pool: string, amount: number, runId: string, idemKey: string): Promise<Reservation> {
    for (const r of this.reservations.values()) if (r.idem === idemKey) return { id: r.id, pool: r.pool, amount: r.amount, runId: r.runId };
    const cap = this.budgets.get(`${runId}:${pool}`);
    if (cap === undefined) throw new LedgerError(`no budget opened for pool ${pool}`, 'budget');
    let used = 0;
    for (const r of this.reservations.values()) if (r.runId === runId && r.pool === pool) used += r.state === 'charged' ? (r.actual ?? r.amount) : r.amount;
    if (used + amount > cap) throw new LedgerError(`budget exceeded for pool ${pool}`, 'budget');
    const id = randomUUID();
    this.reservations.set(id, { id, pool, amount, runId, state: 'reserved', idem: idemKey });
    return { id, pool, amount, runId };
  }
  async settle(reservationId: string, actual: number): Promise<void> {
    const r = this.reservations.get(reservationId);
    if (!r || r.state !== 'reserved') throw new LedgerError('reservation not reserved', 'budget');
    r.state = 'charged';
    r.actual = actual;
  }
  async lease(resource: string, holder: string, ttlMs: number): Promise<Lease | null> {
    const cur = this.leases.get(resource);
    if (cur && cur.expiresAt > Date.now() && cur.holder !== holder) return null;
    const l = { resource, holder, fencingToken: ++this.token, expiresAt: Date.now() + ttlMs };
    this.leases.set(resource, l);
    return { ...l };
  }
  async renew(lease: Lease, ttlMs: number): Promise<Lease> {
    return { ...lease, expiresAt: Date.now() + ttlMs };
  }
  async release(lease: Lease): Promise<void> {
    this.leases.delete(lease.resource);
  }
  async requestApproval(r: ApprovalRequest): Promise<ApprovalRequest> {
    if (this.approvals.has(r.requestId)) throw new LedgerError(`approval ${r.requestId} already exists`, 'approval');
    this.approvals.set(r.requestId, { ...r, state: 'pending' });
    return r;
  }
  async getApproval(requestId: string): Promise<ApprovalView | null> {
    const a = this.approvals.get(requestId);
    if (!a) return null;
    return { requestId: a.requestId, runId: a.runId, sessionId: a.sessionId, actionHash: a.actionHash, requester: a.requester, state: a.state, expiresAt: a.expiresAt, ...(a.approver ? { approver: a.approver } : {}) };
  }
  private auditTarget(requestId: string): { requestId: string; runId: string; sessionId: string; actionHash: string; approver: Principal } | null {
    const a = this.approvals.get(requestId);
    return a?.approver ? { requestId, runId: a.runId, sessionId: a.sessionId, actionHash: a.actionHash, approver: a.approver } : null;
  }

  /** Approve with the matching approval.granted audit event (what production callers do). */
  async grantAudited(requestId: string, approver: Principal, sessionId: string, at: number): Promise<ApprovalGrant> {
    const a = this.approvals.get(requestId);
    const audit = approvalGrantedEvent({ id: randomUUID(), at, requestId, runId: a?.runId ?? 'unknown', sessionId, actionHash: a?.actionHash ?? '', approver, trace: {} });
    return this.approve(requestId, approver, sessionId, at, audit);
  }

  async approve(requestId: string, approver: Principal, sessionId: string, at: number, audit?: TeceraEvent): Promise<ApprovalGrant> {
    const a = this.approvals.get(requestId);
    if (!a || a.state !== 'pending') throw new LedgerError(`approval ${requestId} is not pending`, 'approval');
    if (a.expiresAt <= at) {
      a.state = 'expired';
      throw new LedgerError(`approval ${requestId} has expired`, 'approval');
    }
    if (a.sessionId !== sessionId) throw new LedgerError('session mismatch', 'approval');
    if (a.requester.kind === approver.kind && a.requester.id === approver.id) throw new LedgerError('self approval', 'approval');
    if (approver.kind !== 'human') throw new LedgerError('only humans approve', 'approval');
    if (audit) {
      const why = approvalAuditProblem(audit, { requestId, runId: a.runId, sessionId: a.sessionId, actionHash: a.actionHash, approver });
      if (why) throw new LedgerError(`audit event refused: ${why}`, 'approval');
      await this.append(audit);
    }
    a.state = 'granted';
    a.approver = approver;
    return { requestId, approver, grantedAt: at, expiresAt: a.expiresAt };
  }
  async deny(requestId: string): Promise<void> {
    const a = this.approvals.get(requestId);
    if (!a || a.state !== 'pending') throw new LedgerError('not pending', 'approval');
    a.state = 'denied';
  }
  readonly consumed: string[] = [];
  async consume(requestId: string, actionHash: string, sessionId: string, _idemKey: string, at: number): Promise<void> {
    const a = this.approvals.get(requestId);
    const target = this.auditTarget(requestId);
    const audited = !!target && this.log.some((e) => approvalAuditProblem(e, target) === null);
    const why = !a ? 'unknown request' : a.state !== 'granted' ? `state is ${a.state}` : a.actionHash !== actionHash ? 'action hash mismatch' : a.sessionId !== sessionId ? 'session mismatch' : a.expiresAt <= at ? 'expired' : !audited ? 'the grant is unaudited (no matching approval.granted event)' : null;
    if (why) throw new LedgerError(`cannot consume approval ${requestId}: ${why}`, 'approval');
    a!.state = 'consumed';
    this.consumed.push(requestId);
  }
  async checkpoint(runId: string, _key: string, state: JsonObject): Promise<string> {
    const id = `${runId}:${randomUUID()}`;
    this.checkpoints.set(id, structuredClone(state));
    return id;
  }
  async loadCheckpoint(id: string): Promise<JsonObject | null> {
    const s = this.checkpoints.get(id);
    return s ? structuredClone(s) : null;
  }
}

/**
 * A test WriteGuard with the loop's semantics (D6, 2026-10-05): live until revoke(); every write that
 * passes the fence is 'allowed' under any isolation (no per-write approvals). `answer` overrides the
 * authorization (to prove the tools refuse anything but 'allowed'). `checks` counts check() calls,
 * `authorized` records every write the tools asked about.
 */
export class FakeWriteGuard {
  readonly guard: FencedWriteGuard;
  readonly authorized: WriteIntent[] = [];
  checks = 0;
  private revoked: string | null = null;
  private readonly ac = new AbortController();

  constructor(private readonly o: { answer?: (w: WriteIntent) => WriteAuthorization } = {}) {
    this.guard = new FencedWriteGuard({
      signal: this.ac.signal,
      live: () => {
        this.checks++;
        return this.revoked;
      },
      authorizeWrite: (w: WriteIntent): WriteAuthorization => {
        this.authorized.push({ path: w.path, contentDigest: w.contentDigest });
        return this.o.answer ? this.o.answer(w) : { kind: 'allowed' };
      },
    });
  }

  /** Lose the fence (lease lost, loop stopped): every later check() throws FenceLost. */
  revoke(reason = 'lease lost', abort = false): void {
    this.revoked = reason;
    if (abort) this.ac.abort(new Error(reason));
  }
}

/** A guard that is always live and allows every write. */
export const liveWriteGuard = (): FencedWriteGuard => new FakeWriteGuard().guard;
