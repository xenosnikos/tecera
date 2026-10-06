import { spawn, type ChildProcess } from 'node:child_process';
import { chown, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  HOST_FUNCTIONS,
  RPC_LIMITS,
  canonicalJson,
  digest,
  makeRedactor,
  narrow,
  sha256,
  widens,
  type BindingFrame,
  type CapabilitySet,
  type ChildToSupervisor,
  type ExecRequest,
  type ExecResult,
  type Json,
  type Limits,
  type Provenance,
  type Redactor,
  type Repl,
  type RpcErrorCode,
  type SupervisorToChild,
  type ToolBridge,
  type ToolRequest,
  type ToolResult,
} from '@tecera/contracts';
import { redactCapped, REDACT_LOOKAHEAD_CHARS } from './capture.js';
import { CHILD_LIMITS, CHILD_SOURCE } from './child/entry.js';
import { SuspendExec, sandboxError, type SandboxCode } from './errors.js';
import { FrameError, FrameReader, decodeFrame, scanDepth } from './frames.js';
import { ExecHandleTable, HandleLimitError, HandleMint, VIEW_METHODS, isHandleRef, promoteStrings, type HandleEntry } from './handles.js';
import { groupAlive, killTree, type KillTreeResult } from './killTree.js';
import { quarantineWorktree, worktreeQuarantine } from './quarantine.js';
import { assertSandboxSettings, assertScratchDir, buildChildProfile, resolveIsolation, type IsolationControl, type IsolationProbe, type ResolvedIsolation, type SandboxSettings } from './profile.js';

/**
 * ChildProcessRepl: one fresh restricted Node child per exec (docs/security.md §2–3). The host
 * is the only party that holds authority: it mints HMAC handles into an exec-scoped table, validates
 * every frame before parsing it, routes tool calls to the ToolBridge, sub-invokes to onInvoke (after
 * refusing any widening), and turns every violation, limit, timeout, cancel or crash into an
 * ExecResult `raise` naming the cause after the whole process group is gone. It never decides whether
 * the work is done; `return` only means the program returned.
 *
 * Settlement rules (the freeze boundary):
 *  - Every bridge call and sub-invoke is tracked. An exec never settles while one is in flight: on any
 *    termination the host aborts the exec signal (passed to the bridge and onInvoke), kills the child,
 *    then waits (bounded by `drainMs`) for every in-flight call to finish.
 *  - Taint (the quarantine rule): a call, sub-invoke or checkpoint/evidence sink that has NOT settled after
 *    the drain bound, or a process group that survived SIGKILL, means a writer may still be running. The
 *    exec raises E_TAINTED and its output carries `tainted: {reason, outstanding: [ids], processes}` (also
 *    on the trace); the REPL keeps every unresolved operation in its own registry, becomes quarantined
 *    (every later exec raises E_TAINTED without running), records 'sandbox.tainted' evidence, and records
 *    'sandbox.late_settle' when an abandoned operation finally settles. The caller must mark the worktree
 *    tainted: it must not be verified, committed or reused. `dispose()` terminates live execs, waits
 *    (bounded) for the registry to drain and reports `{clean, tainted, outstanding, processes}`; it never
 *    reports `clean: true` while an operation or process is unresolved.
 *  - A program result that arrives while calls are in flight is NOT a success: the exec raises
 *    E_OUTSTANDING ('calls outstanding'), unless a call suspended, in which case it is `suspended`. A
 *    suspension always dominates a program result.
 *  - Every callback (bridge, onInvoke, onCheckpoint, onEvidence) has its rejection handled at the moment
 *    the promise is created. A thrown bridge or a failing checkpoint or evidence sink terminates the exec
 *    as raise E_INTERNAL (fail closed); a sink that does not settle within `sinkTimeoutMs` taints it.
 *  - Each call's sequence number (callId x<execNo>-c<seq>, idempotency key) is fixed when its frame is
 *    accepted, so frames batched in one stdout chunk get distinct ids.
 *  - Checkpoint keys that carry secret material are refused (violation E_DENIED) before the sink.
 *  - Output caps cut AFTER redaction with lookahead (capture.ts), so a cap never leaves a secret fragment.
 *  - Everything that crosses to the child (bindings, tool replies, error messages) and everything that
 *    leaves the sandbox (printed output, return value, exceptions, checkpoints, evidence, trace) passes
 *    the supervisor-owned redactor first. Secret patterns are always redacted; known secrets via `redactor`.
 *  - A returned or checkpointed value never carries a dead handle: view handles of this exec are
 *    materialized into their values (bounded by `maxMaterializeChars`), tool handles become '[tool:<id>]'.
 */

export interface SubInvokeRequest {
  execNo: number;
  callId: string;
  inputs: Record<string, Json>;
  output?: Json;
  /** Effective capabilities: parent ∩ requested. Widening requests never reach the callback. */
  capabilities: CapabilitySet;
}

export interface CheckpointRecord {
  execNo: number;
  key: string;
  value: Json;
}

export interface SandboxEvidence {
  kind: 'isolation.degraded' | 'sandbox.violation' | 'sandbox.kill' | 'sandbox.env_dropped' | 'sandbox.outstanding' | 'sandbox.tainted' | 'sandbox.late_settle';
  execNo?: number;
  body: Json;
}

export interface ChildProcessReplOptions {
  runId: string;
  sandbox: SandboxSettings;
  /** Capabilities of the invoke that owns this REPL. Without them every sub-invoke is refused. */
  capabilities?: CapabilitySet;
  /** Sub-invoke host function. Throw SuspendExec to suspend; any other throw is a catchable E_TOOL in the program. */
  onInvoke?: (req: SubInvokeRequest, signal: AbortSignal) => Promise<Json>;
  /** Durable checkpoint sink. A throw or a hang terminates the exec (fail closed). */
  onCheckpoint?: (cp: CheckpointRecord) => void | Promise<void>;
  /** Evidence sink (ledger). A throw or a hang terminates the exec (fail closed). */
  onEvidence?: (e: SandboxEvidence) => void | Promise<void>;
  /**
   * Per-run HMAC key material for handles (>= 16 bytes). Default: 32 random bytes. Each REPL instance
   * derives its own MAC key from it, so handles never survive REPL reconstruction.
   */
  handleKey?: Buffer;
  /** Supervisor-owned redactor (known secrets). Default: pattern-only redaction (key shapes, JWTs, canaries). */
  redactor?: Redactor;
  /** Injected isolation probe (tests). Default: detectIsolation(). */
  probe?: IsolationProbe;
  /** Parent of per-exec scratch dirs. Default os.tmpdir(). Never /mnt/*. */
  tmpRoot?: string;
  maxPrintedBytes?: number;
  maxStderrBytes?: number;
  cancelGraceMs?: number;
  /** Bound on waiting for in-flight calls after termination. Default 5 s. */
  drainMs?: number;
  /** Bound on waiting for checkpoint/evidence sinks. Default 5 s. */
  sinkTimeoutMs?: number;
  /** Max characters materialized from handles into a returned or checkpointed value. Default 4 Mi. */
  maxMaterializeChars?: number;
  /**
   * The worktree this REPL's bridge writes. When set, a taint is also recorded in the process-wide worktree
   * quarantine (quarantine.ts): a fresh REPL (or a verify run) on the same worktree refuses until the
   * supervisor clears it. Strongly recommended.
   */
  worktree?: string;
  /** Test seam: rewrite the process-group kill result (e.g. a group that survives SIGKILL). Never set in production. */
  testKillOverride?: (r: KillTreeResult) => KillTreeResult;
  /** Test seam: replace child_process.spawn (e.g. a scripted child). Never set in production. */
  testSpawn?: typeof spawn;
}

export interface CallTrace {
  callId: string;
  tool: string;
  method: string;
  ok: boolean;
  code?: string;
  provenance?: Provenance;
  truncated?: boolean;
  bytes?: number;
}

export interface ExecTrace {
  execNo: number;
  durationMs: number;
  calls: CallTrace[];
  invokes: Array<{ callId: string; ok: boolean; tools: string[]; code?: string }>;
  checkpoints: string[];
  handles: number;
  violations: Array<{ code: string; message: string }>;
  killed?: { cause: string; gone: boolean };
  /** In-flight calls when the program finished, and calls that did not terminate within drainMs. */
  outstanding?: { atResult: number; abandoned: number };
  /** Set when the exec left something unresolved (see TaintReport). */
  tainted?: TaintReport;
  /** Callback failures that terminated the exec. */
  handlerFailures: string[];
  isolation: { mode: 'os' | 'node'; wrappers: string[]; applied: IsolationControl[]; missing: IsolationControl[]; degraded?: string };
  envDropped: string[];
  exit?: { code: number | null; signal: string | null };
}

/**
 * An exec (or the REPL) left work unresolved: the worktree it could write must be treated as tainted
 * (not verified, committed or reused) until the operations are proven settled AND the tree re-checked.
 */
export interface TaintReport {
  reason: string;
  /** Ids of operations still unresolved: host call ids (x<execNo>-c<seq>) and sinks (x<execNo>-sink:<what>). */
  outstanding: string[];
  /** Process group ids that survived SIGKILL. */
  processes: number[];
  /** The 'sandbox.tainted' evidence reached the sink within sinkTimeoutMs (false: the caller must persist it). */
  recorded?: boolean;
}

export type ExecOutput = ExecResult & { printed: string; trace: ExecTrace; tainted?: TaintReport };

/** Result of `ChildProcessRepl.dispose()`. `clean` is true only when nothing is unresolved and no process survives. */
export interface DisposeReport {
  clean: boolean;
  /** Sticky: some exec of this REPL left work unresolved past its drain bound. */
  tainted: boolean;
  /** Operation ids still unresolved when dispose returned. */
  outstanding: string[];
  /** Process groups still alive when dispose returned. */
  processes: number[];
}

/** dispose() of a REPL that is not clean or was tainted. */
export class ReplTainted extends Error {
  constructor(readonly report: DisposeReport) {
    super(
      `sandbox repl ${report.clean ? 'was tainted' : 'is not clean'}: ${report.outstanding.length} operation(s) unresolved${report.outstanding.length ? ` (${report.outstanding.join(', ')})` : ''}, ${report.processes.length} process group(s) alive; the worktree must not be reused`,
    );
    this.name = 'ReplTainted';
  }
}

/** One operation the REPL could not prove finished when its exec ended. */
interface UnresolvedOp {
  id: string;
  execNo: number;
  kind: 'call' | 'invoke' | 'sink';
  label: string;
  since: number;
  settled: Promise<void>;
}

/** What an exec session reports to its REPL. Resolves true when the taint evidence was recorded. */
interface SessionOwner {
  taint(report: TaintReport, ops: UnresolvedOp[]): Promise<boolean>;
}

/** ToolBridge with the exec's cancellation signal (proposed contracts change: ToolBridge gains `signal?`). */
type SignalledBridge = (req: ToolRequest, signal?: AbortSignal) => Promise<ToolResult>;

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const METHOD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HOST_NAMES = new Set(['invoke', 'checkpoint', 'console']);
const RESERVED_TOOLS = new Set<string>(Object.values(HOST_FUNCTIONS));
const LIMIT_KEYS: ReadonlyArray<keyof Limits> = ['usd', 'tokens', 'calls', 'wallMs', 'depth', 'iterations'];
const VIEW_DESCRIPTION = 'large value served by the supervisor: len(), slice(start, end), search(text)';
const MAX_SEARCH_HITS = 100;
const CHILD_VIOLATION_CODES = new Set(['E_LIMIT', 'E_FRAME', 'E_HANDLE']);

class BindingError extends Error {}
class MaterializeError extends Error {}

function waitExit(child: ChildProcess, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** Resolves true when `p` settles within `ms`, false otherwise. Never rejects. */
function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), Math.max(0, ms));
    p.then(
      () => {
        clearTimeout(t);
        resolve(true);
      },
      () => {
        clearTimeout(t);
        resolve(true);
      },
    );
  });
}

/** The uid-dropped child must be able to reach its scratch dir: every ancestor needs o+x (or to be its own). */
async function assertTraversable(dir: string, uid: number): Promise<void> {
  for (let d = dir; ; d = dirname(d)) {
    const st = await stat(d);
    if (st.uid !== uid && (st.mode & 0o001) === 0) throw new Error(`scratch ancestor ${d} is not traversable by the sandbox uid ${uid} (needs o+x)`);
    if (dirname(d) === d) return;
  }
}

function errMessage(e: unknown): string {
  try {
    if (e instanceof Error) return `${e.name}: ${e.message}`;
    return String(e);
  } catch {
    return 'unprintable error';
  }
}

export class ChildProcessRepl implements Repl {
  readonly isolation: ResolvedIsolation;
  private readonly mint: HandleMint;
  private readonly redactor: Redactor;
  private readonly live = new Map<ExecSession, Promise<ExecOutput>>();
  private disposed = false;
  private degradedReported = false;
  /** Operations that outlived their exec (quarantine registry). */
  private readonly unresolved = new Map<string, UnresolvedOp>();
  /** Process groups that survived SIGKILL. */
  private readonly survivors = new Set<number>();
  private taintReport: TaintReport | undefined;
  private readonly owner: SessionOwner = { taint: (r, ops) => this.onTaint(r, ops) };

  constructor(private readonly opts: ChildProcessReplOptions) {
    assertSandboxSettings(opts.sandbox);
    this.isolation = resolveIsolation(opts.sandbox, opts.probe);
    this.mint = new HandleMint(opts.runId, opts.handleKey);
    this.redactor = opts.redactor ?? makeRedactor([]);
    assertScratchDir(opts.tmpRoot ?? tmpdir());
  }

  get degraded(): { reason: string; missing: IsolationControl[] } | undefined {
    return this.isolation.degraded;
  }

  /** Sticky quarantine state: set once any exec left work unresolved. Later execs refuse to run. */
  get tainted(): TaintReport | undefined {
    if (!this.taintReport) return undefined;
    return { reason: this.taintReport.reason, outstanding: [...this.unresolved.keys()], processes: this.aliveSurvivors() };
  }

  private aliveSurvivors(): number[] {
    return [...this.survivors].filter((g) => groupAlive(g));
  }

  private onTaint(report: TaintReport, ops: UnresolvedOp[]): Promise<boolean> {
    if (!this.taintReport) this.taintReport = { reason: report.reason, outstanding: [], processes: [] };
    if (this.opts.worktree) quarantineWorktree(this.opts.worktree, { source: 'repl', reason: report.reason, outstanding: [...report.outstanding], processes: [...report.processes] });
    for (const g of report.processes) this.survivors.add(g);
    for (const op of ops) {
      if (this.unresolved.has(op.id)) continue;
      this.unresolved.set(op.id, op);
      void op.settled.then(() => {
        this.unresolved.delete(op.id);
        void this.lateEvidence({ kind: 'sandbox.late_settle', execNo: op.execNo, body: { id: op.id, kind: op.kind, label: op.label, afterMs: Date.now() - op.since } });
      });
    }
    // The taint record is awaited (bounded, by the session) so it is durable before the exec reports.
    return this.lateEvidence({ kind: 'sandbox.tainted', execNo: ops[0]?.execNo, body: { reason: report.reason, outstanding: [...report.outstanding], processes: [...report.processes], ...(this.opts.worktree ? { worktree: this.opts.worktree } : {}) } });
  }

  /** Evidence outside an exec's lifetime: never rejects. Resolves true when the sink accepted it. */
  private lateEvidence(e: SandboxEvidence): Promise<boolean> {
    const sink = this.opts.onEvidence;
    if (!sink) return Promise.resolve(false);
    try {
      const safe: SandboxEvidence = { ...e, body: this.redactor.redactJson(e.body) };
      return Promise.resolve()
        .then(() => sink(safe))
        .then(
          () => true,
          () => false,
        );
    } catch {
      return Promise.resolve(false);
    }
  }

  async exec(req: ExecRequest, bridge: ToolBridge, signal?: AbortSignal): Promise<ExecOutput> {
    let session: ExecSession;
    try {
      session = new ExecSession(this.opts, this.isolation, this.mint, this.redactor, req, bridge, signal, this.owner);
    } catch (e) {
      return {
        kind: 'raise',
        exception: sandboxError('E_INTERNAL', this.redactor.redactText(`sandbox setup failed: ${errMessage(e)}`)),
        printed: '',
        trace: emptyTrace(req?.execNo ?? -1, this.isolation),
      };
    }
    // Every exit below goes through the session's one finalizer (settle -> finalize): it kills, drains
    // in-flight calls, waits (bounded) for sinks and hands anything unresolved to the quarantine registry.
    // Refusals before the program runs (disposed, quarantined) included (Codex sprint-3 sandbox finding 1).
    if (this.disposed) return session.refuse('E_DISPOSED', 'repl disposed', 'disposed');
    // A fresh REPL on a worktree an earlier REPL or verify run left tainted refuses too.
    const wt = worktreeQuarantine(this.opts.worktree);
    if (wt) {
      const out = await session.refuse('E_TAINTED', `worktree quarantined: ${wt.source} work on it was left unresolved (${wt.reason}); the supervisor must prove it settled and re-check the tree first`, 'quarantined');
      const report: TaintReport = { reason: wt.reason, outstanding: [...wt.outstanding], processes: [...wt.processes] };
      return { ...out, tainted: report, trace: { ...out.trace, tainted: report } };
    }
    const t = this.tainted;
    if (t) {
      const out = await session.refuse('E_TAINTED', `repl quarantined: an earlier exec left work unresolved (${t.reason}); still outstanding: ${t.outstanding.join(', ') || 'none'}; the worktree must not be reused`, 'quarantined');
      const merged: TaintReport = out.tainted
        ? { reason: `${t.reason}; ${out.tainted.reason}`, outstanding: [...new Set([...t.outstanding, ...out.tainted.outstanding])], processes: [...new Set([...t.processes, ...out.tainted.processes])] }
        : t;
      return { ...out, tainted: merged, trace: { ...out.trace, tainted: merged } };
    }
    if (this.isolation.degraded && !this.degradedReported) {
      this.degradedReported = true;
      session.evidence({ kind: 'isolation.degraded', execNo: req.execNo, body: { reason: this.isolation.degraded.reason, missing: [...this.isolation.degraded.missing] } });
    }
    const p = session.run();
    this.live.set(session, p);
    try {
      return await p;
    } finally {
      this.live.delete(session);
    }
  }

  /**
   * Repl port: terminate everything (see shutdown()). Resolves only when the REPL is clean AND was never
   * tainted; otherwise rejects with ReplTainted carrying the DisposeReport (fail closed: a caller that
   * awaits dispose() can never mistake abandoned work for a clean shutdown).
   */
  async dispose(): Promise<void> {
    const r = await this.shutdown();
    if (!r.clean || r.tainted) throw new ReplTainted(r);
  }

  /**
   * Terminate every live exec, wait for their in-flight calls (bounded) and cleanup, wait (bounded by
   * drainMs) for operations earlier execs abandoned, then refuse new execs. Never reports `clean` while an
   * operation or a process group is unresolved. Never rejects.
   */
  async shutdown(): Promise<DisposeReport> {
    this.disposed = true;
    const running = [...this.live.entries()];
    for (const [s] of running) s.terminate('E_DISPOSED', 'repl disposed', 'dispose');
    await Promise.allSettled(running.map(([, p]) => p));
    if (this.unresolved.size) await within(Promise.allSettled([...this.unresolved.values()].map((o) => o.settled)), this.opts.drainMs ?? 5_000);
    // A settled op is removed by a .then() continuation: let those run before reading the registry.
    await new Promise<void>((r) => setImmediate(r));
    const outstanding = [...this.unresolved.keys()];
    const processes = this.aliveSurvivors();
    return { clean: outstanding.length === 0 && processes.length === 0, tainted: this.taintReport !== undefined, outstanding, processes };
  }
}

function emptyTrace(execNo: number, isolation: ResolvedIsolation): ExecTrace {
  return {
    execNo,
    durationMs: 0,
    calls: [],
    invokes: [],
    checkpoints: [],
    handles: 0,
    violations: [],
    handlerFailures: [],
    isolation: {
      mode: isolation.mode,
      wrappers: [...isolation.wrappers],
      applied: [...isolation.applied],
      missing: [...isolation.missing],
      ...(isolation.degraded ? { degraded: isolation.degraded.reason } : {}),
    },
    envDropped: [],
  };
}

type SettleCause = 'result' | 'suspended' | string;

class ExecSession {
  private readonly table: ExecHandleTable;
  private readonly ac = new AbortController();
  private readonly started = Date.now();
  private readonly trace: ExecTrace;
  private readonly sinks = new Map<Promise<void>, string>();
  private readonly inflight = new Map<number, { id: string; kind: 'call' | 'invoke'; label: string; p: Promise<void> }>();
  private sinkSeq = 0;
  private checkpointChain: Promise<void> = Promise.resolve();
  private handlerFailure: string | undefined;
  private suspension: ToolRequest | undefined;
  private outstandingAtResult = 0;
  private child: ChildProcess | undefined;
  private reader: FrameReader | undefined;
  private printed = '';
  private printedBytes = 0;
  /** The printed stream was cut mid-text by the cap (its tail is uncertain for redaction). */
  private printedOverflow = false;
  /** The last log frame was a full chunk of a longer console call (more chunks may never arrive). */
  private lastLogChunked = false;
  private stderr: Buffer[] = [];
  private stderrBytes = 0;
  private calls = 0;
  private checkpoints = 0;
  private helloSeen = false;
  private cancelRequested = false;
  private finished = false;
  private timers: NodeJS.Timeout[] = [];
  private programLine = '';
  private resolveDone!: (o: ExecOutput) => void;
  private readonly done = new Promise<ExecOutput>((r) => (this.resolveDone = r));
  private readonly maxPrinted: number;
  private readonly maxStderr: number;
  private readonly drainMs: number;
  private readonly sinkTimeoutMs: number;
  private readonly maxMaterialize: number;
  private readonly onAbort = () => this.cancel();

  constructor(
    private readonly opts: ChildProcessReplOptions,
    private readonly isolation: ResolvedIsolation,
    mint: HandleMint,
    private readonly redactor: Redactor,
    private readonly req: ExecRequest,
    private readonly bridge: ToolBridge,
    private readonly signal: AbortSignal | undefined,
    private readonly owner: SessionOwner,
  ) {
    this.table = new ExecHandleTable(mint, Number.isInteger(req?.execNo) ? req.execNo : -1);
    this.maxPrinted = opts.maxPrintedBytes ?? 1024 * 1024;
    this.maxStderr = opts.maxStderrBytes ?? 1024 * 1024;
    this.drainMs = opts.drainMs ?? 5_000;
    this.sinkTimeoutMs = opts.sinkTimeoutMs ?? 5_000;
    this.maxMaterialize = opts.maxMaterializeChars ?? 4 * 1024 * 1024;
    this.trace = emptyTrace(req.execNo, isolation);
  }

  // ---- callbacks: every promise gets its rejection handler where it is created ----

  evidence(e: SandboxEvidence): void {
    const sink = this.opts.onEvidence;
    if (!sink) return;
    const safe: SandboxEvidence = { ...e, body: this.redactor.redactJson(e.body) };
    this.trackSink(
      Promise.resolve().then(() => sink(safe)),
      `evidence sink failed (${e.kind})`,
      `evidence:${e.kind}`,
    );
  }

  private trackSink(work: Promise<unknown>, what: string, label: string): Promise<void> {
    const p: Promise<void> = work.then(
      () => undefined,
      (err: unknown) => this.handlerFailed(`${what}: ${errMessage(err)}`),
    );
    this.sinks.set(p, `x${this.req.execNo}-sink:${label}#${++this.sinkSeq}`);
    void p.finally(() => this.sinks.delete(p));
    return p;
  }

  /** Any callback failure terminates the exec as a raise (or is recorded when it is already finishing). */
  private handlerFailed(message: string): void {
    const m = this.redactor.redactText(message, { maxChars: 2000 });
    this.trace.handlerFailures.push(m);
    if (!this.handlerFailure) this.handlerFailure = m;
    this.stop('E_INTERNAL', m, 'handler-failure');
  }

  /** Host call id for the call accepted as number `seq` of this exec. */
  private callId(seq: number): string {
    return `x${this.req.execNo}-c${seq}`;
  }

  private track(seq: number, kind: 'call' | 'invoke', label: string, work: () => Promise<void>): void {
    const p = Promise.resolve()
      .then(work)
      .then(
        () => undefined,
        (err: unknown) => this.handlerFailed(`host call handler failed: ${errMessage(err)}`),
      )
      .finally(() => this.inflight.delete(seq));
    this.inflight.set(seq, { id: this.callId(seq), kind, label, p });
  }

  private suspend(pending: ToolRequest): void {
    if (!this.suspension) this.suspension = pending;
    this.settle({ kind: 'suspended', pending }, 'suspended');
  }

  /**
   * End the exec before (or instead of) running the program, through the same finalizer as every other
   * exit: sinks already started (e.g. degraded-isolation evidence) are awaited, bounded, and anything
   * still open taints the exec and stays in the REPL's quarantine registry. Never a shortcut return.
   */
  refuse(code: SandboxCode, message: string, cause: string): Promise<ExecOutput> {
    this.stop(code, message, cause);
    return this.done;
  }

  /** Public termination (dispose). The exec's run() promise settles after drain and cleanup. */
  terminate(code: SandboxCode, message: string, cause: string): void {
    this.stop(code, message, cause);
  }

  async run(): Promise<ExecOutput> {
    // Early refusals still run the one finalizer (refuse -> settle -> finalize): never a bare return.
    if (this.finished) return this.done;
    if (this.signal?.aborted) return this.refuse('E_CANCELLED', 'cancelled before start', 'cancel');
    if (!Number.isInteger(this.req.execNo) || this.req.execNo < 0) return this.refuse('E_FRAME', 'execNo must be a non-negative integer', 'invalid-request');
    try {
      this.programLine = this.buildProgram();
    } catch (e) {
      const code: SandboxCode = e instanceof HandleLimitError ? 'E_LIMIT' : e instanceof BindingError ? 'E_FRAME' : 'E_INTERNAL';
      let m = 'bad program';
      try {
        m = (e as Error)?.message ?? m;
      } catch {
        /* hostile error */
      }
      return this.refuse(code, m, 'invalid-program');
    }
    let scratch: string | undefined;
    try {
      const root = this.opts.tmpRoot ?? tmpdir();
      scratch = await mkdtemp(join(root, 'tecera-sbx-'));
      const profile = buildChildProfile(this.opts.sandbox, scratch, this.isolation);
      this.trace.envDropped = profile.envDropped;
      if (profile.envDropped.length) this.evidence({ kind: 'sandbox.env_dropped', execNo: this.req.execNo, body: { names: profile.envDropped } });
      await mkdir(profile.childDir, { mode: 0o700 });
      await mkdir(profile.homeDir, { mode: 0o700 });
      await writeFile(profile.entryPath, CHILD_SOURCE, { mode: 0o400 });
      if (this.isolation.dropUid) {
        const { uid, gid } = this.isolation.dropUid;
        await assertTraversable(dirname(scratch), uid);
        for (const p of [scratch, profile.childDir, profile.homeDir, profile.entryPath]) await chown(p, uid, gid);
      }
      const limitMs = Math.min(this.req.timeoutMs > 0 ? this.req.timeoutMs : profile.execTimeoutMs, profile.execTimeoutMs);
      if (this.finished) return await this.done;
      this.signal?.addEventListener('abort', this.onAbort, { once: true });
      if (this.signal?.aborted) {
        this.stop('E_CANCELLED', 'cancelled before start', 'cancel');
        return await this.done;
      }
      this.spawnChild(profile.command, profile.args, profile.spawnOptions);
      this.timers.push(setTimeout(() => this.stop('E_TIMEOUT', `exec exceeded ${limitMs} ms wall clock; process group killed`, 'timeout'), limitMs));
      return await this.done;
    } catch (e) {
      // Setup failures (scratch, profile, env, spawn) become a named raise; never a rejection.
      this.stop('E_SPAWN', `sandbox setup failed: ${errMessage(e)}`, 'spawn');
      return await this.done;
    } finally {
      this.signal?.removeEventListener('abort', this.onAbort);
      if (this.child?.pid && this.child.exitCode === null && this.child.signalCode === null) await killTree(this.child.pid, { child: this.child }).catch(() => undefined);
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ---- program frame ----

  private clean(v: Json): Json {
    return this.redactor.redactJson(v);
  }

  private buildProgram(): string {
    const frames: BindingFrame[] = [];
    const bindings = this.req.bindings ?? {};
    let history: BindingFrame | undefined;
    for (const [name, b] of Object.entries(bindings)) {
      if (!IDENT_RE.test(name) || HOST_NAMES.has(name) || RESERVED_TOOLS.has(name) || name.startsWith('__tecera_')) throw new BindingError(`binding name not allowed: ${name}`);
      if (name === '__history__') {
        history = this.historyFrame(b);
        continue;
      }
      if (b.kind === 'hidden') continue;
      if (b.kind === 'value') frames.push(this.valueFrame(name, b.value, b.provenance));
      else if (b.kind === 'handle') frames.push(this.toolFrame(name, b, 'trusted'));
      else throw new BindingError(`unknown binding kind for ${name}`);
    }
    frames.push(history ?? this.listFrame('__history__', [], { src: 'history', trust: 'untrusted' }));
    const program: SupervisorToChild = { t: 'program', execNo: this.req.execNo, code: String(this.req.code ?? ''), bindings: frames, timeoutMs: this.req.timeoutMs };
    const line = JSON.stringify(program);
    if (Buffer.byteLength(line, 'utf8') > RPC_LIMITS.maxFrameBytes) throw new HandleLimitError(`program frame exceeds ${RPC_LIMITS.maxFrameBytes} bytes`);
    if (scanDepth(line) > RPC_LIMITS.maxDepth) throw new HandleLimitError(`program frame nesting exceeds ${RPC_LIMITS.maxDepth}`);
    return line;
  }

  private toolFrame(name: string, b: Extract<ExecRequest['bindings'][string], { kind: 'handle' }>, trust: Provenance['trust']): BindingFrame {
    if (typeof b.id !== 'string' || !b.id || !Array.isArray(b.methods) || !b.methods.every((m) => typeof m === 'string' && METHOD_RE.test(m) && m !== 'toJSON' && m !== 'constructor' && m !== 'prototype')) {
      throw new BindingError(`bad handle binding: ${name}`);
    }
    if (RESERVED_TOOLS.has(b.id)) throw new BindingError(`handle binding ${name} names a reserved host function (${b.id}); host functions are reached only through invoke/checkpoint`);
    const description = this.redactor.redactText(String(b.description ?? ''), { maxChars: 2000 });
    const h = this.table.add({ kind: 'tool', tool: b.id, methods: [...b.methods], description });
    return { name, kind: 'handle', handle: h, methods: [...b.methods], description, provenance: { src: `tool:${b.id}`, trust } };
  }

  private historyFrame(b: ExecRequest['bindings'][string]): BindingFrame {
    if (b.kind === 'handle') return this.toolFrame('__history__', b, 'untrusted');
    if (b.kind === 'hidden') return this.listFrame('__history__', [], { src: 'history', trust: 'untrusted' });
    if (!Array.isArray(b.value)) throw new BindingError('__history__ value binding must be an array');
    return this.listFrame('__history__', this.clean(b.value) as Json[], { ...this.cleanProvenance(b.provenance), trust: 'untrusted' });
  }

  private listFrame(name: string, items: Json[], provenance: Provenance): BindingFrame {
    const h = this.table.add({ kind: 'list', items, provenance });
    return { name, kind: 'handle', handle: h, methods: [...VIEW_METHODS], description: 'read-only history: len(), slice(start, end), search(text)', provenance };
  }

  private cleanProvenance(p: Provenance): Provenance {
    return this.clean((p ?? { src: 'unknown', trust: 'untrusted' }) as unknown as Json) as unknown as Provenance;
  }

  private valueFrame(name: string, value: Json, rawProvenance: Provenance): BindingFrame {
    const provenance = this.cleanProvenance(rawProvenance);
    const cleaned = this.clean(value);
    const promoted = promoteStrings(cleaned, this.table, provenance);
    if (typeof cleaned === 'string' && isHandleRef(promoted)) {
      return { name, kind: 'handle', handle: promoted.$handle, methods: [...VIEW_METHODS], description: VIEW_DESCRIPTION, provenance };
    }
    return { name, kind: 'value', value: promoted, provenance };
  }

  // ---- process ----

  private spawnChild(command: string, args: string[], options: Parameters<typeof spawn>[2]): void {
    const child = (this.opts.testSpawn ?? spawn)(command, args, options);
    this.child = child;
    child.on('error', (e) => this.stop('E_SPAWN', `spawn failed: ${e.message}`, 'spawn'));
    child.stdin?.on('error', () => undefined);
    this.reader = new FrameReader(
      (line) => this.onLine(line),
      (e) => this.violation(e.code, e.message),
    );
    child.stdout?.on('data', (c: Buffer) => this.reader?.push(c));
    child.stderr?.on('data', (c: Buffer) => this.onStderr(c));
    child.on('close', (code, sig) => this.onClose(code, sig));
  }

  private onStderr(c: Buffer): void {
    if (this.finished) return;
    const room = this.maxStderr - this.stderrBytes;
    if (c.length > room) {
      this.stderr.push(c.subarray(0, Math.max(0, room)));
      this.stderrBytes = this.maxStderr;
      this.stop('E_OUTPUT', `child stderr exceeded ${this.maxStderr} bytes; process group killed`, 'stderr-flood');
      return;
    }
    this.stderr.push(c);
    this.stderrBytes += c.length;
  }

  private onClose(code: number | null, sig: NodeJS.Signals | null): void {
    this.trace.exit = { code, signal: sig };
    if (this.finished) return;
    if (this.cancelRequested) return this.stop('E_CANCELLED', 'exec cancelled', 'cancel');
    const err = Buffer.concat(this.stderr).toString('utf8');
    if (/heap limit|out of memory|Allocation failed/i.test(err)) {
      return this.stop('E_OOM', `child exceeded its ${this.opts.sandbox.memoryMb} MB heap and was killed`, 'oom');
    }
    // Redact the whole stderr first, then take the tail: a cut never splits a secret. The child died on its
    // own, possibly mid-write: its trailing token is uncertain (interrupted) and is suppressed.
    const tail = redactCapped(this.redactor, err, Number.MAX_SAFE_INTEGER, { interrupted: true }).text.slice(-500).trim();
    this.stop('E_CRASH', `child exited (code=${code}, signal=${sig}) before returning a result${tail ? `: ${tail}` : ''}`, 'crash');
  }

  /** Encode and write a frame. A reply that cannot be framed (size, depth, serialization) becomes an error frame. */
  private send(frame: SupervisorToChild): void {
    if (this.finished || !this.child?.stdin?.writable) return;
    let line: string | undefined;
    let problem: string | undefined;
    try {
      line = JSON.stringify(frame);
      if (typeof line !== 'string') problem = 'not serializable';
      else if (Buffer.byteLength(line, 'utf8') > RPC_LIMITS.maxFrameBytes) problem = `exceeds ${RPC_LIMITS.maxFrameBytes} bytes`;
      else if (scanDepth(line) > RPC_LIMITS.maxDepth) problem = `nesting exceeds ${RPC_LIMITS.maxDepth}`;
    } catch (e) {
      problem = `not serializable (${errMessage(e)})`;
    }
    if (problem) {
      if (frame.t !== 'reply') return this.stop('E_INTERNAL', `supervisor frame ${frame.t} ${problem}`, 'frame');
      line = JSON.stringify({ t: 'error', callId: frame.callId, code: 'E_LIMIT', message: `reply ${problem}` } satisfies SupervisorToChild);
    }
    this.child.stdin.write(line + '\n');
  }

  private sendError(callId: string, code: RpcErrorCode, message: string): void {
    this.send({ t: 'error', callId, code, message: this.redactor.redactText(message, { maxChars: 4000 }) });
  }

  // ---- frames ----

  private onLine(line: Buffer): void {
    if (this.finished) return;
    let f: ChildToSupervisor;
    try {
      f = decodeFrame(line);
    } catch (e) {
      const fe = e instanceof FrameError ? e : new FrameError('E_FRAME', 'bad frame');
      return this.violation(fe.code, fe.message);
    }
    if (!this.helloSeen) {
      if (f.t !== 'hello') return this.violation('E_FRAME', `expected hello, got ${f.t}`);
      this.helloSeen = true;
      this.child?.stdin?.write(this.programLine + '\n');
      return;
    }
    switch (f.t) {
      case 'hello':
        return this.violation('E_FRAME', 'duplicate hello');
      case 'call': {
        if (!this.countCall()) return;
        // The sequence is fixed NOW, when the frame is accepted: frames batched in one chunk get distinct ids.
        const seq = this.calls;
        return this.track(seq, 'call', 'tool call', () => this.onCall(f, seq));
      }
      case 'invoke': {
        if (!this.countCall()) return;
        const seq = this.calls;
        return this.track(seq, 'invoke', HOST_FUNCTIONS.invoke, () => this.onInvoke(f, seq));
      }
      case 'checkpoint':
        return this.onCheckpoint(f);
      case 'log':
        return this.onLog(f.text);
      case 'result':
        if (f.execNo !== this.req.execNo) return this.violation('E_FRAME', `result for exec ${f.execNo}, expected ${this.req.execNo}`);
        this.outstandingAtResult = this.inflight.size;
        return this.settle(f.result, 'result');
      case 'crash': {
        const msg = this.boundedText(String(f.error.message), 2000, CHILD_LIMITS.crashChars);
        if (CHILD_VIOLATION_CODES.has(f.error.name)) return this.violation(f.error.name as SandboxCode, `child latched a limit violation: ${msg}`);
        return this.stop('E_CRASH', `child crashed: ${this.redactor.redactText(String(f.error.name), { maxChars: 200 })}: ${msg}`, 'crash');
      }
    }
  }

  private countCall(): boolean {
    if (++this.calls > RPC_LIMITS.maxCallsPerExec) {
      this.violation('E_LIMIT', `more than ${RPC_LIMITS.maxCallsPerExec} calls in exec ${this.req.execNo}`);
      return false;
    }
    return true;
  }

  /** Redact then bound text that the child may itself have cut at `childCut` characters. */
  private boundedText(text: string, maxChars: number, childCut: number): string {
    return redactCapped(this.redactor, text, maxChars, text.length >= childCut).text;
  }

  private async onCall(f: Extract<ChildToSupervisor, { t: 'call' }>, callSeq: number): Promise<void> {
    const entry = this.table.get(f.handle);
    if (!entry) return this.violation('E_HANDLE', `unknown, forged or expired handle in exec ${this.req.execNo}`);
    if (entry.kind !== 'tool') return this.serveView(f.callId, entry, f.method, f.args);
    if (!entry.methods.includes(f.method)) {
      this.trace.calls.push({ callId: f.callId, tool: entry.tool, method: f.method, ok: false, code: 'E_DENIED' });
      return this.sendError(f.callId, 'E_DENIED', `${entry.tool} has no method ${f.method}`);
    }
    let resolved: { args: Json[]; forHash: Json[] };
    try {
      resolved = this.resolveArgs(f.args);
    } catch (e) {
      if (e instanceof FrameError) return this.violation('E_HANDLE', e.message);
      return this.sendError(f.callId, 'E_DENIED', (e as Error).message);
    }
    const actionHash = digest({ tool: entry.tool, method: f.method, args: resolved.forHash });
    const request: ToolRequest = {
      callId: this.callId(callSeq),
      tool: entry.tool,
      method: f.method,
      args: resolved.args,
      idemKey: sha256(canonicalJson([this.opts.runId, this.req.execNo, callSeq, actionHash])),
    };
    let result: ToolResult;
    try {
      result = await (this.bridge as SignalledBridge)(request, this.ac.signal);
    } catch (e) {
      if (e instanceof SuspendExec) return this.suspend(e.pending);
      // A throwing bridge is a supervisor fault (ledger, broker), not a tool failure: terminate.
      this.trace.calls.push({ callId: request.callId, tool: entry.tool, method: f.method, ok: false, code: 'E_INTERNAL' });
      return this.handlerFailed(`tool bridge failed on ${entry.tool}.${f.method}: ${errMessage(e)}`);
    }
    if (this.finished) return;
    // Everything below handles untrusted, possibly huge or deep data: any failure is an E_TOOL reply.
    try {
      const provenance = this.provenanceOf(result?.provenance, entry.tool);
      if (!result || typeof result !== 'object' || !result.ok) {
        const err = result?.error;
        const code: RpcErrorCode = err?.name === 'E_DENIED' ? 'E_DENIED' : 'E_TOOL';
        this.trace.calls.push({ callId: request.callId, tool: entry.tool, method: f.method, ok: false, code, provenance });
        return this.sendError(f.callId, code, `${entry.tool}.${f.method} failed: ${err ? `${String(err.name)}: ${String(err.message)}` : 'no result'}`);
      }
      this.reply(f.callId, result.value ?? null, provenance, Boolean(result.truncated), { tool: entry.tool, method: f.method, hostCallId: request.callId });
    } catch (e) {
      if (e instanceof HandleLimitError) return this.violation('E_LIMIT', e.message);
      this.trace.calls.push({ callId: request.callId, tool: entry.tool, method: f.method, ok: false, code: 'E_TOOL' });
      this.sendError(f.callId, 'E_TOOL', `${entry.tool}.${f.method} returned a result the sandbox cannot carry: ${errMessage(e)}`);
    }
  }

  private provenanceOf(p: unknown, tool: string): Provenance {
    const cleaned = this.clean((p && typeof p === 'object' ? p : {}) as Json) as Record<string, Json>;
    const out: Provenance = { src: typeof cleaned.src === 'string' && cleaned.src ? cleaned.src : `tool:${tool}`, trust: 'untrusted' };
    for (const k of ['digest', 'path', 'runId'] as const) if (typeof cleaned[k] === 'string') out[k] = cleaned[k] as string;
    return out;
  }

  /** Replace `{ $handle }` arguments with the host-held value; tool handles cannot be passed as data. */
  private resolveArgs(args: Json[]): { args: Json[]; forHash: Json[] } {
    const walk = (v: Json, depth: number): [Json, Json] => {
      if (depth > RPC_LIMITS.maxDepth) throw new FrameError('E_FRAME', 'argument nesting too deep');
      if (v === null || typeof v !== 'object') return [v, v];
      if (isHandleRef(v)) {
        const e = this.table.get(v.$handle);
        if (!e) throw new FrameError('E_HANDLE', 'unknown, forged or expired handle passed as an argument');
        if (e.kind === 'tool') throw new Error('tool handles cannot be passed as arguments');
        const real: Json = e.kind === 'text' ? e.text : e.items;
        return [real, { $digest: digest(real) }];
      }
      if (Array.isArray(v)) {
        const a: Json[] = [];
        const h: Json[] = [];
        for (const x of v) {
          const [r, d] = walk(x, depth + 1);
          a.push(r);
          h.push(d);
        }
        return [a, h];
      }
      const a: Record<string, Json> = {};
      const h: Record<string, Json> = {};
      for (const [k, x] of Object.entries(v)) {
        const [r, d] = walk(x, depth + 1);
        Object.defineProperty(a, k, { value: r, enumerable: true, writable: true, configurable: true });
        Object.defineProperty(h, k, { value: d, enumerable: true, writable: true, configurable: true });
      }
      return [a, h];
    };
    const out: Json[] = [];
    const forHash: Json[] = [];
    for (const x of args) {
      const [r, d] = walk(x, 1);
      out.push(r);
      forHash.push(d);
    }
    return { args: out, forHash };
  }

  /** Redact, promote long strings to view handles, frame. Throws on values the sandbox cannot carry. */
  private reply(callId: string, raw: Json, provenance: Provenance, truncated: boolean, t: { tool: string; method: string; hostCallId: string }): void {
    const value = this.clean(raw);
    const bytes = Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
    let frame: SupervisorToChild;
    if (typeof value === 'string' && value.length > RPC_LIMITS.maxInlineString) {
      const handle = this.table.add({ kind: 'text', text: value, provenance });
      frame = { t: 'reply', callId, ok: true, handle, provenance, truncated, bytes };
    } else {
      frame = { t: 'reply', callId, ok: true, value: promoteStrings(value, this.table, provenance), provenance, truncated, bytes };
    }
    this.trace.calls.push({ callId: t.hostCallId, tool: t.tool, method: t.method, ok: true, provenance, truncated, bytes });
    this.send(frame);
  }

  private serveView(callId: string, entry: Exclude<HandleEntry, { kind: 'tool' }>, method: string, args: Json[]): void {
    const subject = entry.kind === 'text' ? entry.text : entry.items;
    const fail = (message: string) => {
      this.trace.calls.push({ callId, tool: `view:${entry.kind}`, method, ok: false, code: 'E_DENIED' });
      this.sendError(callId, 'E_DENIED', message);
    };
    const int = (v: Json | undefined, dflt: number): number | null => (v === undefined || v === null ? dflt : typeof v === 'number' && Number.isInteger(v) ? v : null);
    let value: Json;
    let truncated = false;
    if (method === 'len') value = subject.length;
    else if (method === 'slice') {
      const start = int(args[0], 0);
      const end = int(args[1], subject.length);
      if (start === null || end === null) return fail('slice(start, end) takes integers');
      if (entry.kind === 'text') {
        let s = entry.text.slice(start, end);
        if (s.length > RPC_LIMITS.maxInlineString) {
          s = s.slice(0, RPC_LIMITS.maxInlineString);
          truncated = true;
        }
        value = s;
      } else value = entry.items.slice(start, end);
    } else if (method === 'search') {
      const q = args[0];
      if (typeof q !== 'string' || q.length === 0) return fail('search(text) takes a non-empty string');
      const hits: number[] = [];
      if (entry.kind === 'text') {
        for (let i = entry.text.indexOf(q); i !== -1 && hits.length < MAX_SEARCH_HITS; i = entry.text.indexOf(q, i + 1)) hits.push(i);
      } else {
        for (let i = 0; i < entry.items.length && hits.length < MAX_SEARCH_HITS; i++) if (JSON.stringify(entry.items[i]).includes(q)) hits.push(i);
      }
      value = hits;
    } else return fail(`no method ${method}`);
    try {
      this.reply(callId, value, { ...entry.provenance, trust: 'untrusted' }, truncated, { tool: `view:${entry.kind}`, method, hostCallId: callId });
    } catch (e) {
      if (e instanceof HandleLimitError) return this.violation('E_LIMIT', e.message);
      this.sendError(callId, 'E_TOOL', `view reply failed: ${errMessage(e)}`);
    }
  }

  private async onInvoke(f: Extract<ChildToSupervisor, { t: 'invoke' }>, _seq: number): Promise<void> {
    const parent = this.opts.capabilities;
    const requestedTools = f.narrow?.tools;
    const tool = HOST_FUNCTIONS.invoke;
    if (!parent || !this.opts.onInvoke) {
      this.trace.invokes.push({ callId: f.callId, ok: false, tools: requestedTools ?? [], code: 'E_DENIED' });
      return this.violation('E_DENIED', 'sub-invoke is not available in this exec');
    }
    const limits: Partial<Limits> = {};
    for (const [k, v] of Object.entries(f.narrow?.limits ?? {})) {
      if (!LIMIT_KEYS.includes(k as keyof Limits) || typeof v !== 'number') {
        this.trace.invokes.push({ callId: f.callId, ok: false, tools: requestedTools ?? [], code: 'E_DENIED' });
        return this.violation('E_DENIED', `sub-invoke requested unknown limit ${k}`);
      }
      limits[k as keyof Limits] = v;
    }
    if (f.narrow?.depth !== undefined) limits.depth = f.narrow.depth;
    const requested: Partial<CapabilitySet> = { ...(requestedTools ? { tools: requestedTools } : {}), ...(Object.keys(limits).length ? { limits: limits as Limits } : {}) };
    if (widens(parent, requested)) {
      const extra = (requestedTools ?? []).filter((t) => !parent.tools.includes(t));
      this.trace.invokes.push({ callId: f.callId, ok: false, tools: requestedTools ?? [], code: 'E_DENIED' });
      return this.violation('E_DENIED', `sub-invoke requested capabilities wider than its parent${extra.length ? ` (tools: ${extra.join(', ')})` : ''}; rejected, not clamped`);
    }
    const capabilities = narrow(parent, requested);
    let value: Json;
    try {
      value = await this.opts.onInvoke(
        { execNo: this.req.execNo, callId: f.callId, inputs: f.inputs, ...(f.output !== undefined ? { output: f.output } : {}), capabilities },
        this.ac.signal,
      );
    } catch (e) {
      if (e instanceof SuspendExec) return this.suspend(e.pending);
      if (this.finished) return;
      this.trace.invokes.push({ callId: f.callId, ok: false, tools: capabilities.tools, code: 'E_TOOL' });
      return this.sendError(f.callId, 'E_TOOL', `sub-invoke failed: ${errMessage(e)}`);
    }
    if (this.finished) return;
    try {
      this.trace.invokes.push({ callId: f.callId, ok: true, tools: capabilities.tools });
      this.reply(f.callId, value ?? null, { src: tool, trust: 'untrusted' }, false, { tool, method: 'invoke', hostCallId: f.callId });
    } catch (e) {
      if (e instanceof HandleLimitError) return this.violation('E_LIMIT', e.message);
      this.sendError(f.callId, 'E_TOOL', `sub-invoke returned a result the sandbox cannot carry: ${errMessage(e)}`);
    }
  }

  private onCheckpoint(f: Extract<ChildToSupervisor, { t: 'checkpoint' }>): void {
    if (++this.checkpoints > CHILD_LIMITS.maxCheckpoints) return this.violation('E_LIMIT', `more than ${CHILD_LIMITS.maxCheckpoints} checkpoints in one exec`);
    // Keys reach the durable sink (and the ledger's checkpoint metadata) verbatim: a key that carries secret
    // material is refused before anything is recorded. The message never repeats the key.
    const keyKind = this.redactor.containsSecret(f.key);
    if (keyKind !== null) return this.violation('E_DENIED', `checkpoint key carries secret material (${keyKind}); refused`);
    this.trace.checkpoints.push(f.key);
    const sink = this.opts.onCheckpoint;
    if (!sink) return;
    let value: Json;
    try {
      value = this.clean(this.materialize(f.value));
    } catch (e) {
      return this.violation('E_LIMIT', `checkpoint ${f.key}: ${errMessage(e)}`);
    }
    const rec: CheckpointRecord = { execNo: this.req.execNo, key: f.key, value };
    const prev = this.checkpointChain;
    const work = prev.then(() => (this.handlerFailure ? undefined : sink(rec)));
    this.checkpointChain = this.trackSink(work, `checkpoint sink failed (${f.key})`, `checkpoint:${f.key}`);
  }

  private onLog(text: string): void {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (this.printedBytes + bytes > this.maxPrinted) {
      // Keep redaction lookahead past the cap; the cut happens after redaction (finalize).
      const room = this.maxPrinted + REDACT_LOOKAHEAD_CHARS - this.printed.length;
      if (room > 0) this.printed += text.slice(0, room);
      this.printedBytes = this.maxPrinted;
      // The tail is uncertain when this frame was not kept whole, or when it is one chunk of a longer
      // console call (the child splits at logChunkChars, so the rest of that text was never seen).
      this.printedOverflow = room < text.length || text.length >= CHILD_LIMITS.logChunkChars;
      return this.stop('E_OUTPUT', `printed output exceeded ${this.maxPrinted} bytes; process group killed`, 'output-flood');
    }
    this.printed += text;
    this.printedBytes += bytes;
    this.lastLogChunked = text.length >= CHILD_LIMITS.logChunkChars;
  }

  /** Replace this exec's view-handle refs with their values and tool-handle refs with '[tool:<id>]'. */
  private materialize(v: Json): Json {
    let budget = this.maxMaterialize;
    const walk = (x: Json, depth: number): Json => {
      if (depth > RPC_LIMITS.maxDepth + 2) throw new MaterializeError('value nesting too deep');
      if (x === null || typeof x !== 'object') return x;
      if (isHandleRef(x)) {
        const e = this.table.get(x.$handle);
        if (!e) return x; // not ours: plain (untrusted) data that only looks like a handle
        if (e.kind === 'tool') return `[tool:${e.tool}]`;
        const real: Json = e.kind === 'text' ? e.text : e.items;
        budget -= e.kind === 'text' ? e.text.length : JSON.stringify(e.items).length;
        if (budget < 0) throw new MaterializeError(`materialized handles exceed ${this.maxMaterialize} characters`);
        return real;
      }
      if (Array.isArray(x)) return x.map((y) => walk(y, depth + 1));
      const out: Record<string, Json> = {};
      for (const [k, y] of Object.entries(x)) Object.defineProperty(out, k, { value: walk(y, depth + 1), enumerable: true, writable: true, configurable: true });
      return out;
    };
    return walk(v, 0);
  }

  // ---- termination ----

  private violation(code: SandboxCode, message: string): void {
    if (this.finished) return;
    this.trace.violations.push({ code, message: this.redactor.redactText(message, { maxChars: 2000 }) });
    this.evidence({ kind: 'sandbox.violation', execNo: this.req.execNo, body: { code, message } });
    this.stop(code, message, `violation:${code}`);
  }

  private cancel(): void {
    if (this.finished || this.cancelRequested) return;
    this.cancelRequested = true;
    this.send({ t: 'cancel', reason: 'cancelled by supervisor' });
    this.timers.push(setTimeout(() => this.stop('E_CANCELLED', 'exec cancelled; grace expired, process group killed', 'cancel'), this.opts.cancelGraceMs ?? 500));
  }

  private stop(code: SandboxCode, message: string, cause: string): void {
    this.settle({ kind: 'raise', exception: sandboxError(code, message) }, cause);
  }

  private settle(result: ExecResult, cause: SettleCause): void {
    if (this.finished) return;
    this.finished = true;
    this.ac.abort();
    for (const t of this.timers) clearTimeout(t);
    this.reader?.stop();
    this.finalize(result, cause).catch((e: unknown) => {
      this.trace.durationMs = Date.now() - this.started;
      this.table.clear();
      this.resolveDone({
        kind: 'raise',
        exception: sandboxError('E_INTERNAL', this.redactor.redactText(`sandbox finalization failed: ${errMessage(e)}`)),
        printed: '',
        trace: this.trace,
      });
    });
  }

  private async finalize(result: ExecResult, cause: SettleCause): Promise<void> {
    let out: ExecResult = result;
    const child = this.child;
    let gone = true;
    if (child?.pid) {
      // A child that delivered its result exits on its own; give it a moment so the trace shows a clean exit.
      if (cause === 'result' && child.exitCode === null && child.signalCode === null) await waitExit(child, 250);
      const k0 = await killTree(child.pid, { child }).catch((): KillTreeResult => ({ gone: false, signalled: false }));
      const k = this.opts.testKillOverride ? this.opts.testKillOverride(k0) : k0;
      gone = k.gone;
      if (cause !== 'result') {
        this.trace.killed = { cause, gone: k.gone };
        this.evidence({ kind: 'sandbox.kill', execNo: this.req.execNo, body: { cause, gone: k.gone } });
      }
    }
    // Drain: no exec settles while a bridge call or sub-invoke is still running.
    const drained = await within(Promise.allSettled([...this.inflight.values()].map((x) => x.p)), this.drainMs);
    const abandonedCalls = drained ? [] : [...this.inflight.values()];
    const abandoned = abandonedCalls.length;
    if (this.outstandingAtResult || abandoned) {
      this.trace.outstanding = { atResult: this.outstandingAtResult, abandoned };
      this.evidence({ kind: 'sandbox.outstanding', execNo: this.req.execNo, body: { atResult: this.outstandingAtResult, abandoned, ids: abandonedCalls.map((x) => x.id) } });
    }
    // Sinks (checkpoints, evidence including the kill/outstanding records above), bounded.
    const sinksDone = await within(Promise.allSettled([this.checkpointChain, ...this.sinks.keys()]), this.sinkTimeoutMs);
    const openSinks = sinksDone ? [] : [...this.sinks.entries()];
    if (!sinksDone) {
      const m = `checkpoint/evidence sink did not settle within ${this.sinkTimeoutMs} ms`;
      this.trace.handlerFailures.push(m);
      if (!this.handlerFailure) this.handlerFailure = m;
    }

    // Taint: anything still unresolved now may still be writing. The REPL takes over tracking it.
    let tainted: TaintReport | undefined;
    if (!gone || abandoned || openSinks.length) {
      const now = Date.now();
      const ops: UnresolvedOp[] = [
        ...abandonedCalls.map((x): UnresolvedOp => ({ id: x.id, execNo: this.req.execNo, kind: x.kind, label: x.label, since: now, settled: x.p.then(() => undefined, () => undefined) })),
        ...openSinks.map(([p, id]): UnresolvedOp => ({ id, execNo: this.req.execNo, kind: 'sink', label: id, since: now, settled: p.then(() => undefined, () => undefined) })),
      ];
      const reasons: string[] = [];
      if (!gone) reasons.push(`process group ${child?.pid} survived SIGKILL (${cause})`);
      if (abandoned) reasons.push(`${abandoned} tool call(s) or sub-invoke(s) did not terminate within ${this.drainMs} ms after the exec ended`);
      if (openSinks.length) reasons.push(`${openSinks.length} checkpoint/evidence sink(s) did not settle within ${this.sinkTimeoutMs} ms`);
      tainted = { reason: reasons.join('; '), outstanding: ops.map((o) => o.id), processes: !gone && child?.pid ? [child.pid] : [] };
      // Durable before the exec reports: the taint record is awaited, bounded by sinkTimeoutMs.
      let recorded = false;
      const rec = this.owner.taint(tainted, ops).then((ok) => (recorded = ok));
      await within(rec, this.sinkTimeoutMs);
      tainted.recorded = recorded;
      if (!recorded && this.opts.onEvidence) this.trace.handlerFailures.push('taint evidence was not recorded within sinkTimeoutMs; the caller must persist ExecOutput.tainted');
      this.trace.tainted = tainted;
    }

    const programFinished = cause === 'result' || cause === 'suspended';
    if (tainted) {
      out = { kind: 'raise', exception: sandboxError('E_TAINTED', `worktree tainted: ${tainted.reason}; outstanding: ${[...tainted.outstanding, ...tainted.processes.map((p) => `pgid:${p}`)].join(', ')}`) };
    } else if (this.handlerFailure) {
      out = { kind: 'raise', exception: sandboxError('E_INTERNAL', this.handlerFailure) };
    } else if (this.suspension && programFinished) {
      out = { kind: 'suspended', pending: this.suspension };
    } else if (cause === 'result' && this.outstandingAtResult > 0) {
      out = { kind: 'raise', exception: sandboxError('E_OUTSTANDING', `calls outstanding: ${this.outstandingAtResult} tool call(s) or sub-invoke(s) were still in flight when the program finished; they were cancelled`) };
    }

    if (out.kind === 'return') {
      try {
        out = { kind: 'return', value: this.clean(this.materialize(out.value)), output: '' };
      } catch (e) {
        out = { kind: 'raise', exception: sandboxError('E_LIMIT', `return value: ${errMessage(e)}`) };
      }
    }
    // Redact first, then cut (with lookahead when the cap cut the stream).
    // A console call split into chunks whose rest never arrived (the exec was killed) is interrupted too.
    const interrupted = this.printedOverflow || (!programFinished && this.lastLogChunked);
    let printed = redactCapped(this.redactor, this.printed, this.maxPrinted, { cut: this.printedOverflow, interrupted }).text;
    // The cap is in bytes: cutting the already-redacted text is safe (it holds no secret to split).
    const pb = Buffer.from(printed, 'utf8');
    if (pb.length > this.maxPrinted) printed = pb.subarray(0, this.maxPrinted).toString('utf8').replace(/\uFFFD+$/, '');
    if (out.kind === 'return') out = { ...out, output: printed };
    else if (out.kind === 'continue') out = { kind: 'continue', output: printed, ...(out.exception ? { exception: this.cleanError(out.exception) } : {}) };
    else if (out.kind === 'raise') out = { kind: 'raise', exception: this.cleanError(out.exception) };
    this.trace.handles = this.table.size;
    this.trace.durationMs = Date.now() - this.started;
    this.table.clear();
    const trace = this.redactor.redactJson(this.trace) as unknown as ExecTrace;
    this.resolveDone({ ...out, printed, trace, ...(tainted ? { tainted: { reason: tainted.reason, outstanding: [...tainted.outstanding], processes: [...tainted.processes], recorded: tainted.recorded === true } } : {}) });
  }

  /** Redact BEFORE cutting; the child may have cut message/stack at CHILD_LIMITS.errorChars (lookahead). */
  private cleanError(e: { name: string; message: string; stack?: string }): { name: string; message: string; stack?: string } {
    const name = this.redactor.redactText(String(e.name), { maxChars: 200 });
    const message = this.boundedText(String(e.message), 8000, CHILD_LIMITS.errorChars);
    return e.stack !== undefined ? { name, message, stack: this.boundedText(String(e.stack), 8000, CHILD_LIMITS.errorChars) } : { name, message };
  }
}
