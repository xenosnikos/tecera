import { randomBytes } from 'node:crypto';
import {
  canonicalJson,
  digest,
  FencedWriteGuard,
  fenceOf,
  HANDLE_RE,
  HOST_FUNCTIONS,
  jsonDepth,
  makeRedactor,
  narrow,
  requireWriteGuard,
  RPC_LIMITS,
  sha256,
  type ApprovalGrant,
  type CapabilitySet,
  type Inputs,
  type Json,
  type JsonObject,
  type Outcome,
  type Redactor,
  type SuspendRequest,
  type Tool,
  type ToolBridge,
  type ToolContext,
  type ToolRequest,
  type ToolResult,
  type WriteGuard,
  type WriteIntent,
} from '@tecera/contracts';
import type { History } from '../invoke/history.js';
import { HISTORY_METHODS } from '../invoke/history.js';
import { applyPatches, isFatalCode, type AbortReason, type SpanRunner } from '../invoke/span.js';
import { CHECKPOINT_KEY_RE, STANDARD_STUBS } from '../protocol/prompts.js';
import { toSafeJson } from '../protocol/serializer.js';
import { canAuthorize, type WorkerToolContext } from '../tools/common.js';
import { markWorktreeTainted, worktreeTaint } from '../tools/paths.js';
import { HandleError, HandleTable } from './handles.js';

/**
 * The broker: the only path from generated code to tools. It implements the ToolBridge port. Authority
 * comes only from (handle, method, args) plus capabilities and hooks; text inside arguments or results
 * is never read for authority.
 *
 * Per call: handle lookup (fail closed) → method check → capability check → ToolCall Enter → journal
 * replay (re-authorized under the CURRENT scope) or Send (Suspend unless a grant is bound to exactly this
 * actionHash) → liveness re-check immediately before the tool runs → tool → provenance re-tag (always
 * untrusted) → redaction of everything handed back to the program → Complete → settle → Exit.
 *
 * Exec lifecycle: every exec has a generation. beginExec opens it; endExec closes it, cancels nested
 * invokes, and DRAINS every call still in flight before returning, so nothing a program started can run
 * after the exec ended or after a suspension/abort was recorded. A call admitted before the exec stopped
 * is refused at the liveness check (`tool.discarded` evidence); a tool that was already running when the
 * exec stopped completes, is journalled (it happened) and its result is withheld from the program
 * (`tool.late` evidence).
 *
 * Quarantine: a call that does not drain within drainMs is an UNRESOLVED WRITER. The exec, the whole
 * invoke tree (shared state) and the worktree are TAINTED: `exec.tainted` evidence, report.tainted, a
 * fatal 'cancelled' reason prefixed `tainted:`, the worktree in the taint registry (every later file or
 * verify tool on it refuses), and beginExec refuses from then on. A tool commit that fails its
 * post-commit verification (TaintError) taints the same way. A completion arriving after the taint is
 * discarded with `tool.late` evidence ({tainted, discarded}) and never journalled. Timeout is never
 * treated as completed cleanup: the invoke turns any outcome into an aborted, tainted one.
 * The quarantine is TREE-WIDE and immediate: it bumps the tree's quarantine generation and stops every
 * exec open on any broker of the tree (already-open sibling and child brokers included: their own
 * `exec.tainted` evidence, fatal reason and REPL abort). Liveness — checked at admission, immediately
 * before a tool runs, and by the exec's write guard immediately before every mutation — includes the tree
 * taint and the generation, so a call admitted earlier (or paused in its hooks) never executes, an
 * in-flight built-in tool refuses its next mutation, and every post-quarantine result is withheld.
 *
 * Write fence (contracts WriteGuard): BrokerOptions.guard is the step's live fence (absent = every write
 * refused). Each exec wraps it in an exec guard that also fails when the exec stopped or the tree is
 * quarantined; tools receive it as Tool.call's third argument and ToolContext.fence = fenceOf(guard).
 * Owner decision D6 (2026-10-05): writes inside paths.write on the leased work branch proceed without
 * approval under ANY isolation (fenced, logged, protected paths and tamper rules unchanged). There are no
 * per-write approvals: a guard answer other than 'allowed' refuses the write (tools/common.ts), and a
 * Suspend that names a write (SuspendRequest.write) is refused, never held.
 *
 * Host gates: pushing, opening a PR (HOST_GATE_ACTIONS) and merging are never worker tool calls. The
 * gate.pr step does them on the human approval it consumes; Tecera never merges. A program that calls a
 * tool whose action is one of them is refused (E_DENIED, code 'policy') before any hook runs, so a hook
 * cannot turn it into a suspension and the tool never runs.
 *
 * Redaction: one redactor for the whole tree (BrokerOptions.redactor, plus whatever invoke adopts from
 * its secret list). It is applied to everything handed back to the program (values, error names and
 * messages, provenance, history, checkpoint values) and passed to tools in the ToolContext so they can
 * redact complete outputs before cutting them.
 *
 * Journal: completed non-read calls are journalled under idemKey = sha256(runId, invokeId, execNo,
 * callSeq, actionHash); invokeIds and execNos are unique across one invoke tree, so a nested invoke can
 * never replay its parent's (or a sibling's) result. Read calls are never journalled: they re-run under
 * the current scope. Journal entries hold only the redacted result the program already saw.
 */

export const BROKER_LIMITS = {
  maxCallsPerExec: RPC_LIMITS.maxCallsPerExec,
  maxCheckpointBytes: 256 * 1024,
  maxCheckpointKeys: 64,
  /** A reply whose inline size (strings over maxInlineString count as a view handle) exceeds this is refused. */
  maxReplyBytes: RPC_LIMITS.maxFrameBytes - 16 * 1024,
  drainMs: 120_000,
} as const;

/** @deprecated use HOST_FUNCTIONS.invoke from @tecera/contracts */
export const INVOKE_TOOL = HOST_FUNCTIONS.invoke;
/** @deprecated use HOST_FUNCTIONS.checkpoint from @tecera/contracts */
export const CHECKPOINT_TOOL = HOST_FUNCTIONS.checkpoint;

/**
 * Actions only the host performs (D6): gate.pr pushes and opens the PR on the human approval it consumes,
 * and nobody in Tecera merges. Kept in step with @tecera/policy PR_GATE_ACTIONS and MERGE_ACTIONS (the
 * worker depends on contracts only). A tool call is matched by `<tool>_<method>`, the method and the tool.
 */
export const HOST_GATE_ACTIONS: ReadonlySet<string> = new Set([
  'open_pr',
  'git_push',
  'gh_pr',
  'pr_create',
  'gh_pr_create',
  'merge',
  'git_merge',
  'gh_merge',
  'pr_merge',
  'gh_pr_merge',
]);

/** The host-gate action a tool call would perform, or undefined. */
export function hostGateActionOf(tool: string, method: string): string | undefined {
  const names = [method && method !== 'call' ? `${tool}_${method}` : tool, method, tool].filter((a) => typeof a === 'string' && a !== '');
  return names.find((a) => HOST_GATE_ACTIONS.has(a));
}

export type BrokerErrorCode = 'E_HANDLE' | 'E_DENIED' | 'E_LIMIT' | 'E_SUSPENDED' | 'E_ABORTED' | 'E_TOOL' | 'E_FRAME';

/** Kept for compatibility: brokered results are plain ToolResults (the REPL host promotes large strings). */
export type BrokeredResult = ToolResult;

export interface SubInvokeRequest {
  args: Json[];
  spanId: string;
  execNo: number;
  callSeq: number;
  /** Aborted when the parent exec stops or ends. */
  signal: AbortSignal;
}

/** A nested invoke's outcome plus, when suspended, every request it is waiting on and its identity. */
export type SubInvokeResult = Outcome & { pendingRequests?: SuspendRequest[]; childInvokeId?: string };

export interface ExecSession {
  execNo: number;
  invokeId: string;
  capabilities: CapabilitySet;
  spans: SpanRunner;
  history: History;
  /** Values saved with checkpoint(key, value); they survive to later execs. */
  checkpoints: Map<string, Json>;
  /** Nested invoke; omitted → invoke requests are refused. Throw SubInvokeDenied to refuse one. */
  subInvoke?: (req: SubInvokeRequest) => Promise<SubInvokeResult>;
  /** Called once when the exec must stop (suspension or fatal abort); invoke aborts the REPL. */
  onStop?: () => void;
}

export interface Suspension {
  /** Every request this exec is waiting on; each must be granted independently. */
  requests: SuspendRequest[];
  /** The first suspended tool request (diagnostics). */
  pending?: ToolRequest;
  spanIds: string[];
  /** Nested invokes that suspended (their own checkpoints hold their state). */
  children: Array<{ invokeId: string; token: string }>;
  /** Requests a nested invoke already recorded in the ledger (the parent must not request them again). */
  childRequestIds: string[];
}

export interface ExecReport {
  suspension?: Suspension;
  fatal?: AbortReason[];
  denied: Array<{ spanId: string; tool: string; method: string; reasons: AbortReason[] }>;
  /** Tools that completed after the exec stopped: journalled, result withheld from the program. */
  late: Array<{ spanId: string; tool: string; ok: boolean }>;
  /** Calls admitted before the exec stopped and refused at the liveness check (never executed). */
  discarded: Array<{ spanId: string; tool: string }>;
  calls: number;
  /** Set when the exec (and its tree and worktree) is quarantined: an unresolved writer or an unverifiable commit. */
  tainted?: TaintInfo;
}

/** Why an invoke tree and its worktree are quarantined. */
export interface TaintInfo {
  reason: string;
  /** Tools (or 'invoke') still running when the quarantine was declared. */
  unresolved: string[];
  worktree: string;
}

/**
 * A tool call that completed: a non-read effect (it happened), or a read dependency (`read: true`, with the
 * read scope it ran under). Both are re-authorized under the current scope before a completed child's
 * result is replayed: a child whose data the current scope can no longer read is never replayed.
 */
export interface EffectRecord {
  invokeId: string;
  tool: string;
  method: string;
  args: Json[];
  idemKey: string;
  read?: boolean;
  /** Read dependencies: capabilities.paths.read when the read ran. */
  readScope?: string[];
}

export class SubInvokeDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubInvokeDenied';
  }
}

export interface BrokerOptions {
  tools: Tool[];
  runId: string;
  /** Absolute worktree; '' = not configured (file and verify tools refuse). */
  worktree: string;
  capabilities: CapabilitySet;
  /** Lease fencing token; absent = writes are refused by the edit tool. */
  fencingToken?: number;
  key?: Uint8Array;
  maxCallsPerExec?: number;
  maxReplyBytes?: number;
  /** How long endExec waits for in-flight calls before the exec is made fatal. */
  drainMs?: number;
  /** Redacts everything handed back to the program (results, errors, history, checkpoints). */
  redactor?: Redactor;
  /**
   * The step's live mutation-time fence (WorkerStepRequest.guard / Worker.resume's guard). Absent = every
   * write-class tool refuses (requireWriteGuard).
   */
  guard?: WriteGuard;
  /** tool name → program binding name (default: read→readFile, edit→writeFile, listFiles, runVerify). */
  stubNames?: Record<string, string>;
}

type Entry = { kind: 'tool'; tool: Tool } | { kind: 'history' };

interface Shared {
  key: Uint8Array;
  grants: Map<string, ApprovalGrant[]>;
  journal: Map<string, ToolResult>;
  execSeq: { n: number };
  /** One redactor for the whole tree (adoptRedactor composes into it). */
  red: { r: Redactor };
  taint: TaintInfo | null;
  effects: Map<string, EffectRecord>;
  /** Quarantine generation of the tree: bumped by every quarantine; an exec opened under another one is dead. */
  qgen: { n: number };
  /** Every exec open on any broker of the tree (a quarantine stops them all). */
  execs: Set<{ broker: Broker; live: Live }>;
}

/** Apply `a` then `b` (both secret lists are honoured). */
export function composeRedactors(a: Redactor, b: Redactor): Redactor {
  if (a === b) return a;
  return {
    redactText: (t, o) => b.redactText(a.redactText(t), o),
    redactJson: (v, o) => b.redactJson(a.redactJson(v, o), o),
    containsSecret: (x) => a.containsSecret(x) ?? b.containsSecret(x),
  };
}

interface Live {
  gen: number;
  session: ExecSession;
  report: ExecReport;
  inflight: Set<Promise<ToolResult>>;
  ac: AbortController;
  closing: boolean;
  stopped: boolean;
  callSeq: number;
  /** callSeq → tool name, while the tool itself is executing. */
  running: Map<number, string>;
  /** Quarantine generation the exec was opened under. */
  qgen: number;
  /** The exec's write fence (the step guard + this exec's liveness + the tree quarantine). */
  guard: WriteGuard;
}

const err = (callId: string, code: BrokerErrorCode, message: string): ToolResult => ({
  callId,
  ok: false,
  error: { name: code, message },
  provenance: { src: 'broker', trust: 'trusted' },
  truncated: false,
});

const emptyReport = (): ExecReport => ({ denied: [], late: [], discarded: [], calls: 0 });

export function actionHashOf(tool: string, method: string, args: Json[], worktree: string): string {
  const scrub = (v: Json): Json =>
    typeof v === 'string' && HANDLE_RE.test(v) ? `handle:${sha256(v).slice(0, 16)}` : Array.isArray(v) ? v.map(scrub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)])) : v;
  return sha256(canonicalJson({ tool, method, args: scrub(args), worktree }));
}

/** Idempotency key of one tool call: namespaced by invoke so nested invokes never share journal entries. */
export function idemKeyOf(runId: string, invokeId: string, execNo: number, callSeq: number, actionHash: string): string {
  return sha256(canonicalJson([runId, invokeId, execNo, callSeq, actionHash]));
}

function pathOf(args: Json[]): string | undefined {
  const a = args[0];
  if (typeof a === 'string') return a;
  if (a && typeof a === 'object' && !Array.isArray(a) && typeof (a as JsonObject).path === 'string') return (a as JsonObject).path as string;
  return undefined;
}

/** True when a value nests deeper than `max` (checked on the raw value, before any normalization). */
function tooDeep(v: unknown, max: number): boolean {
  const stack: Array<[unknown, number]> = [[v, 0]];
  const seen = new Set<object>();
  while (stack.length) {
    const [x, d] = stack.pop()!;
    if (x === null || typeof x !== 'object') continue;
    if (d + 1 > max) return true;
    if (seen.has(x)) continue;
    seen.add(x);
    // Own data properties only: never run a getter while checking.
    for (const desc of Object.values(Object.getOwnPropertyDescriptors(x))) if ('value' in desc) stack.push([desc.value, d + 1]);
  }
  return false;
}

/** Inline size of a reply after the REPL host promotes long strings to view handles. */
function replyBytes(v: Json): number {
  if (typeof v === 'string') return v.length > RPC_LIMITS.maxInlineString ? 96 : Buffer.byteLength(JSON.stringify(v), 'utf8');
  if (Array.isArray(v)) return 2 + v.reduce<number>((n, x) => n + replyBytes(x) + 1, 0);
  if (v && typeof v === 'object') return 2 + Object.entries(v).reduce<number>((n, [k, x]) => n + Buffer.byteLength(JSON.stringify(k), 'utf8') + 1 + replyBytes(x) + 1, 0);
  return JSON.stringify(v).length;
}

export class Broker {
  readonly bridge: ToolBridge = (req) => this.handle(req);
  private readonly tools: Map<string, Tool>;
  private readonly shared: Shared;
  private readonly handles: HandleTable<Entry>;
  private readonly adopted = new Set<Redactor>();
  private gen = 0;
  private live?: Live;

  constructor(private readonly o: BrokerOptions, shared?: Shared) {
    this.tools = new Map(o.tools.map((t) => [t.name, t]));
    this.shared = shared ?? { key: o.key ?? randomBytes(32), grants: new Map(), journal: new Map(), execSeq: { n: 0 }, red: { r: o.redactor ?? makeRedactor([]) }, taint: null, effects: new Map(), qgen: { n: 0 }, execs: new Set() };
    this.handles = new HandleTable<Entry>(o.runId, this.shared.key);
  }

  /** The tree's redactor (shared with child brokers). */
  private get red(): Redactor {
    return this.shared.red.r;
  }

  get capabilities(): CapabilitySet {
    return this.o.capabilities;
  }

  get runId(): string {
    return this.o.runId;
  }

  get worktree(): string {
    return this.o.worktree;
  }

  get redactor(): Redactor {
    return this.red;
  }

  /**
   * Make `r` part of the tree's redactor (composed with what is there; idempotent per instance). invoke
   * calls it with the redactor built from InvokeOptions.secrets so the broker, its tools and every child
   * broker redact with the same secret list.
   */
  adoptRedactor(r: Redactor): void {
    if (r === this.shared.red.r || this.adopted.has(r)) return;
    this.adopted.add(r);
    this.shared.red.r = composeRedactors(this.shared.red.r, r);
  }

  /** Quarantine state of this invoke tree (null when clean). */
  get tainted(): TaintInfo | null {
    return this.shared.taint ?? (worktreeTaint(this.o.worktree) !== null ? { reason: worktreeTaint(this.o.worktree)!, unresolved: [], worktree: this.o.worktree } : null);
  }

  /** Completed non-read effects of an invoke and its descendants. */
  effectsOf(invokeId: string): EffectRecord[] {
    return [...this.shared.effects.values()].filter((e) => e.invokeId === invokeId || e.invokeId.startsWith(`${invokeId}/`));
  }

  exportEffects(): EffectRecord[] {
    return [...this.shared.effects.values()];
  }

  preloadEffects(list: unknown): void {
    if (!Array.isArray(list)) return;
    for (const e of list as EffectRecord[]) {
      if (e && typeof e === 'object' && typeof e.idemKey === 'string' && typeof e.tool === 'string' && typeof e.invokeId === 'string' && typeof e.method === 'string' && Array.isArray(e.args)) {
        const read = e.read === true ? { read: true, readScope: Array.isArray(e.readScope) ? e.readScope.filter((x): x is string => typeof x === 'string') : [] } : {};
        this.shared.effects.set(e.idemKey, { invokeId: e.invokeId, tool: e.tool, method: e.method, args: e.args, idemKey: e.idemKey, ...read });
      }
    }
  }

  /**
   * Re-authorize recorded effects AND read dependencies under `caps` without performing them (null = all
   * still authorized). Used before a completed nested invoke's result is replayed to a resumed parent. A
   * read is re-authorized by the tool's authorize() (path-specific), or — for a read tool without one —
   * only when every read glob it ran under is still in the current read scope.
   */
  async reauthorize(effects: EffectRecord[], caps: CapabilitySet): Promise<string | null> {
    for (const e of effects) {
      const tool = this.tools.get(e.tool);
      if (!tool) return `tool ${e.tool} is no longer available`;
      if (!caps.tools.includes(e.tool)) return `tool ${e.tool} is outside the current capabilities`;
      if (e.read === true && !canAuthorize(tool)) {
        const now = new Set(caps.paths.read);
        const lost = (e.readScope ?? ['<unknown>']).filter((g) => !now.has(g));
        if (lost.length) return this.red.redactText(`${e.tool}: the read scope it ran under (${lost.join(', ')}) is no longer granted`);
        continue;
      }
      if (!canAuthorize(tool)) return `a ${e.tool} effect cannot be re-authorized`;
      try {
        await tool.authorize({ callId: 'reauthorize', tool: e.tool, method: e.method, args: e.args, idemKey: e.idemKey }, this.ctxFor(caps));
      } catch (x) {
        return this.red.redactText(`${e.tool}: ${(x as Error)?.message ?? 'refused'}`);
      }
    }
    return null;
  }

  toolNames(): string[] {
    return [...this.tools.keys()];
  }

  /** A broker for a nested invoke: same tools, key, grants, journal and exec counter; capabilities narrowed. */
  child(capabilities: CapabilitySet): Broker {
    const c = new Broker({ ...this.o, capabilities: narrow(this.o.capabilities, capabilities) }, this.shared);
    for (const r of this.adopted) c.adopted.add(r);
    return c;
  }

  /** Next exec number, unique across the whole invoke tree (and across resumes once restored). */
  nextExecNo(): number {
    return ++this.shared.execSeq.n;
  }

  get execSeq(): number {
    return this.shared.execSeq.n;
  }

  restoreExecSeq(n: number): void {
    if (Number.isInteger(n) && n > this.shared.execSeq.n) this.shared.execSeq.n = n;
  }

  /** Bind one approval grant to one actionHash: the next Suspend for exactly that action is lifted once. */
  grant(actionHash: string, g: ApprovalGrant): void {
    const list = this.shared.grants.get(actionHash) ?? [];
    list.push(g);
    this.shared.grants.set(actionHash, list);
  }

  /** Take one grant per request hash (one use each); undefined, taking nothing, unless every request is covered. */
  takeGrants(hashes: string[]): ApprovalGrant[] | undefined {
    if (hashes.length === 0) return undefined;
    const need = new Map<string, number>();
    for (const h of hashes) need.set(h, (need.get(h) ?? 0) + 1);
    for (const [h, n] of need) if ((this.shared.grants.get(h)?.length ?? 0) < n) return undefined;
    const out: ApprovalGrant[] = [];
    for (const [h, n] of need) {
      const list = this.shared.grants.get(h)!;
      out.push(...list.splice(0, n));
      if (!list.length) this.shared.grants.delete(h);
    }
    return out;
  }

  exportJournal(): Array<[string, ToolResult]> {
    return [...this.shared.journal.entries()];
  }

  preloadJournal(entries: Array<[string, ToolResult]>): void {
    if (!Array.isArray(entries)) return;
    for (const e of entries) if (Array.isArray(e) && typeof e[0] === 'string' && e[1] && typeof e[1] === 'object') this.shared.journal.set(e[0], e[1]);
  }

  /** Program binding name for a tool. */
  stubName(tool: string): string {
    return this.o.stubNames?.[tool] ?? STANDARD_STUBS[tool]?.binding ?? tool;
  }

  /**
   * Start an exec: revoke every earlier handle and mint fresh ones for the tools in the session's
   * capabilities and for __history__. Invoke/checkpoint are host functions of the REPL that arrive as
   * HOST_FUNCTIONS requests.
   */
  beginExec(s: ExecSession): Inputs {
    if (this.live) throw new Error('an exec is already open on this broker; call endExec() first');
    const taint = this.tainted;
    if (taint) throw new Error(`the invoke tree is quarantined (tainted: ${this.red.redactText(taint.reason)}); no exec may start`);
    this.handles.revokeAll();
    const ac = new AbortController();
    const L: Live = { gen: ++this.gen, session: s, report: emptyReport(), inflight: new Set(), ac, closing: false, stopped: false, callSeq: 0, running: new Map(), qgen: this.shared.qgen.n, guard: undefined as unknown as WriteGuard };
    L.guard = this.execGuard(L);
    this.live = L;
    this.shared.execs.add({ broker: this, live: L });
    const out: Inputs = {};
    for (const t of this.tools.values()) {
      if (!s.capabilities.tools.includes(t.name)) continue;
      out[this.stubName(t.name)] = { kind: 'handle', id: this.handles.mint(s.execNo, { kind: 'tool', tool: t }), methods: [...t.methods], description: `tool ${t.name} (risk ${t.risk})` };
    }
    out.__history__ = { kind: 'handle', id: this.handles.mint(s.execNo, { kind: 'history' }), methods: [...HISTORY_METHODS], description: 'earlier turns of this step (untrusted data)' };
    return out;
  }

  /** True while an exec is open and has not stopped. */
  get active(): boolean {
    return !!this.live && this.isLive(this.live);
  }

  /**
   * End the exec: refuse anything not yet executing, cancel nested invokes, drain every call still in
   * flight, then revoke the exec's handles. Only after this resolves may a checkpoint be written.
   */
  async endExec(): Promise<ExecReport> {
    const L = this.live;
    if (!L) return emptyReport();
    L.closing = true;
    L.ac.abort();
    const drainMs = this.o.drainMs ?? BROKER_LIMITS.drainMs;
    const deadline = Date.now() + drainMs;
    while (L.inflight.size) {
      const left = deadline - Date.now();
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        Promise.allSettled([...L.inflight]).then(() => false),
        new Promise<boolean>((r) => {
          timer = setTimeout(() => r(true), Math.max(0, left));
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (timedOut) {
        // An unresolved writer: never treated as completed cleanup.
        await this.quarantine(L, `${L.inflight.size} call(s) still running ${drainMs} ms after the exec ended (unresolved writer)`);
        break;
      }
    }
    this.handles.revokeAll();
    if (this.live === L) this.live = undefined;
    for (const e of this.shared.execs) if (e.live === L) this.shared.execs.delete(e);
    return L.report;
  }

  /**
   * The exec's write fence: fails (FenceLost) once the exec stopped or ended, the tree was quarantined (any
   * generation change), the worktree is in the taint registry, or the step's own guard fails. Its signal
   * aborts with the exec's or the step guard's.
   */
  private execGuard(L: Live): WriteGuard {
    const base = requireWriteGuard(this.o.guard);
    return new FencedWriteGuard({
      signal: AbortSignal.any([L.ac.signal, base.signal]),
      live: () => {
        if (this.shared.taint) return `the invoke tree is quarantined (tainted: ${this.red.redactText(this.shared.taint.reason)})`;
        if (this.shared.qgen.n !== L.qgen) return 'the invoke tree was quarantined';
        if (!this.isLive(L)) return L.report.suspension && !L.report.fatal ? 'the exec is suspended' : 'the exec stopped';
        const wt = worktreeTaint(this.o.worktree);
        if (wt !== null) return `the worktree is quarantined (${this.red.redactText(wt)})`;
        try {
          base.check();
        } catch (e) {
          return this.red.redactText((e as Error)?.message ?? 'the step fence failed');
        }
        return null;
      },
      authorizeWrite: (w: WriteIntent) => (typeof base.authorizeWrite === 'function' ? base.authorizeWrite(w) : { kind: 'allowed' }),
    });
  }

  /** Entry for REPL host callbacks: the call must come from the exec that is live on THIS broker. */
  hostCall(execNo: number, req: ToolRequest): Promise<ToolResult> {
    const L = this.live;
    if (!L || L.session.execNo !== execNo) return Promise.resolve(err(typeof req?.callId === 'string' ? req.callId : '', 'E_HANDLE', `host call from exec ${execNo} does not belong to the live exec of this invoke`));
    return this.handle(req);
  }

  /** Live = open on this broker, not closing/stopped/suspended/fatal, and the TREE is not quarantined. */
  private isLive(L: Live): boolean {
    return this.live === L && !L.closing && !L.stopped && !L.report.suspension && !L.report.fatal && !this.shared.taint && this.shared.qgen.n === L.qgen;
  }

  private stop(L: Live): void {
    if (L.stopped) return;
    L.stopped = true;
    L.ac.abort();
    L.session.onStop?.();
  }

  private fatal(L: Live, reasons: AbortReason[]): void {
    if (!reasons.length) return;
    L.report.fatal = [...(L.report.fatal ?? []), ...reasons.map((r) => ({ ...r, reason: this.red.redactText(r.reason) }))];
    this.stop(L);
  }

  /**
   * Quarantine the exec, the tree and the worktree. Writes `exec.tainted` evidence; a failed write adds a
   * ledger fatal. Idempotent per exec.
   */
  private async quarantine(L: Live, reason: string): Promise<void> {
    const r = this.red.redactText(reason);
    let first = false;
    if (!this.shared.taint) {
      first = true;
      const unresolved = [...this.shared.execs].flatMap((e) => [...e.live.running.values(), ...(e.live.inflight.size > e.live.running.size ? ['call'] : [])]);
      this.shared.taint = { reason: r, unresolved: unresolved.length ? unresolved : [...L.running.values()], worktree: this.o.worktree };
      this.shared.qgen.n++;
      markWorktreeTainted(this.o.worktree, r);
    }
    const own = this.taintExec(L);
    // Tree-wide: every exec open on any broker of this tree (siblings and children already open) stops now.
    const others = first ? [...this.shared.execs].filter((e) => e.live !== L).map((e) => e.broker.taintExec(e.live)) : [];
    await Promise.allSettled([own, ...others]);
  }

  /** Mark one exec of the tree quarantined: report, fatal reason, stop (REPL abort), `exec.tainted` evidence. */
  private async taintExec(L: Live): Promise<void> {
    const t = this.shared.taint;
    if (!t || L.report.tainted) return;
    L.report.tainted = t;
    this.fatal(L, [{ code: 'cancelled', reason: `tainted: ${t.reason}`, hookId: 'quarantine' }]);
    const s = L.session;
    try {
      await s.spans.evidence(`taint:${this.o.runId}:${s.invokeId}:e${s.execNo}:g${s.spans.attempt}`, 'exec.tainted', { reason: t.reason, unresolved: t.unresolved, worktree: this.o.worktree, execNo: s.execNo, invokeId: s.invokeId });
    } catch (e) {
      this.fatal(L, [{ code: 'ledger', reason: `evidence not written: ${(e as Error).message}`, hookId: 'broker' }]);
    }
  }

  private stoppedError(L: Live, callId: string): ToolResult {
    return L.report.suspension && !L.report.fatal ? err(callId, 'E_SUSPENDED', 'the exec is suspended awaiting approval') : err(callId, 'E_ABORTED', 'the exec was stopped');
  }

  /** Redact a value handed back to the program. */
  private clean(v: Json): Json {
    return this.red.redactJson(v);
  }

  private handle(req: ToolRequest): Promise<ToolResult> {
    const L = this.live;
    if (!req || typeof req !== 'object') return Promise.resolve(err('', 'E_FRAME', 'malformed tool request'));
    const callId = typeof req.callId === 'string' ? req.callId.slice(0, 128) : '';
    if (!L || L.closing) return Promise.resolve(err(callId, 'E_HANDLE', 'no exec in progress'));
    const callSeq = ++L.callSeq;
    const p = this.dispatch(L, { ...req, callId }, callSeq).catch((e) => err(callId, 'E_TOOL', `broker fault: ${this.red.redactText((e as Error)?.message ?? 'error')}`));
    L.inflight.add(p);
    void p.finally(() => L.inflight.delete(p));
    return p;
  }

  private async dispatch(L: Live, req: ToolRequest, callSeq: number): Promise<ToolResult> {
    const s = L.session;
    if (!this.isLive(L)) return this.stoppedError(L, req.callId);
    if (++L.report.calls > (this.o.maxCallsPerExec ?? BROKER_LIMITS.maxCallsPerExec)) return this.refuseRpc(L, req, 'E_LIMIT', 'too many calls in this exec');
    if (typeof req.method !== 'string' || !Array.isArray(req.args)) return this.refuseRpc(L, req, 'E_FRAME', 'malformed tool request');
    if (tooDeep(req.args, RPC_LIMITS.maxDepth)) return this.refuseRpc(L, req, 'E_FRAME', 'arguments nested too deeply');
    const args = toSafeJson(req.args) as Json[];
    if (jsonDepth(args) > RPC_LIMITS.maxDepth) return this.refuseRpc(L, req, 'E_FRAME', 'arguments nested too deeply');
    if (Buffer.byteLength(JSON.stringify(args), 'utf8') > RPC_LIMITS.maxFrameBytes) return this.refuseRpc(L, req, 'E_FRAME', 'arguments exceed the frame limit');

    let entry: Entry | { kind: 'invoke' } | { kind: 'checkpoint' };
    if (req.tool === HOST_FUNCTIONS.invoke) {
      if (!s.subInvoke) return this.refuseRpc(L, req, 'E_DENIED', 'invoke is not available at this depth');
      entry = { kind: 'invoke' };
    } else if (req.tool === HOST_FUNCTIONS.checkpoint) {
      entry = { kind: 'checkpoint' };
    } else {
      try {
        entry = this.handles.resolve(req.tool, s.execNo);
      } catch (e) {
        return this.refuseRpc(L, req, e instanceof HandleError ? e.code : 'E_HANDLE', (e as Error).message);
      }
    }
    const call: ToolRequest = { ...req, args };
    switch (entry.kind) {
      case 'history':
        return this.local(L, call, () => s.history.call(req.method, args, this.red), 'history');
      case 'checkpoint':
        return this.local(L, call, () => this.saveCheckpoint(s, req.method, args), 'checkpoint');
      case 'invoke':
        return this.invoke(L, call, callSeq);
      case 'tool':
        return this.toolCall(L, entry.tool, call, callSeq);
    }
  }

  private async refuseRpc(L: Live, req: ToolRequest, code: BrokerErrorCode, message: string): Promise<ToolResult> {
    const s = L.session;
    try {
      await s.spans.evidence(`rpc:${this.o.runId}:${s.invokeId}:${s.execNo}:${L.report.calls}:${s.spans.attempt}`, 'rpc.refused', { code, message, method: typeof req?.method === 'string' ? this.red.redactText(req.method).slice(0, 64) : null });
    } catch (e) {
      this.fatal(L, [{ code: 'ledger', reason: `evidence not written: ${(e as Error).message}`, hookId: 'broker' }]);
    }
    return err(req.callId, code, this.red.redactText(message));
  }

  private async local(L: Live, req: ToolRequest, fn: () => Json, src: string): Promise<ToolResult> {
    try {
      const value = this.clean(fn());
      if (!this.isLive(L)) return this.stoppedError(L, req.callId);
      return { callId: req.callId, ok: true, value, provenance: { src, trust: 'untrusted', digest: digest(value) }, truncated: false };
    } catch (e) {
      return this.refuseRpc(L, req, 'E_DENIED', (e as Error).message);
    }
  }

  private saveCheckpoint(s: ExecSession, method: string, args: Json[]): Json {
    if (method !== 'call') throw new Error(`checkpoint has no method ${method}`);
    const [key, value] = args;
    if (typeof key !== 'string' || !CHECKPOINT_KEY_RE.test(key)) throw new Error(`checkpoint key must match ${CHECKPOINT_KEY_RE.source}`);
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('checkpoint key not allowed');
    if (this.red.containsSecret(key)) throw new Error('checkpoint key carries secret material; refused');
    if (!s.checkpoints.has(key) && s.checkpoints.size >= BROKER_LIMITS.maxCheckpointKeys) throw new Error('too many checkpoint keys');
    const v = this.clean((value ?? null) as Json);
    if (Buffer.byteLength(JSON.stringify(v), 'utf8') > BROKER_LIMITS.maxCheckpointBytes) throw new Error('checkpoint value too large');
    s.checkpoints.set(key, v);
    return true;
  }

  private mergeSuspension(L: Live, add: Partial<Suspension> & { requests: SuspendRequest[] }): void {
    const cur = L.report.suspension ?? { requests: [], spanIds: [], children: [], childRequestIds: [] };
    for (const r of add.requests) if (!cur.requests.some((x) => x.requestId === r.requestId)) cur.requests.push(r);
    cur.spanIds.push(...(add.spanIds ?? []));
    cur.children.push(...(add.children ?? []));
    cur.childRequestIds.push(...(add.childRequestIds ?? []));
    if (!cur.pending && add.pending) cur.pending = add.pending;
    L.report.suspension = cur;
  }

  private async invoke(L: Live, req: ToolRequest, callSeq: number): Promise<ToolResult> {
    const s = L.session;
    const spanId = `invoke:${s.invokeId}:e${s.execNo}:c${callSeq}:g${s.spans.attempt}`;
    if (req.method !== 'call' && req.method !== 'invoke') return this.refuseRpc(L, req, 'E_DENIED', `invoke has no method ${req.method}`);
    if (!this.isLive(L)) return this.stoppedError(L, req.callId);
    let outcome: SubInvokeResult;
    try {
      outcome = await s.subInvoke!({ args: req.args, spanId, execNo: s.execNo, callSeq, signal: L.ac.signal });
    } catch (e) {
      return this.refuseRpc(L, req, 'E_DENIED', (e as Error).message);
    }
    const prov = { src: 'invoke', trust: 'untrusted' as const };
    // A record the nested invoke could not write is a ledger failure of the whole tree: terminal here too,
    // whether or not this exec is still live (checked BEFORE the late-result branch).
    if (outcome.kind === 'aborted') {
      const ledger = outcome.reasons.filter((r) => r.code === 'ledger');
      if (ledger.length) this.fatal(L, ledger.map((r) => ({ ...r, reason: `nested invoke: ${r.reason}` })));
    }
    if (this.shared.taint && !L.report.tainted) await this.quarantine(L, `nested invoke: ${this.shared.taint.reason}`);
    if (outcome.kind === 'suspended') {
      // A nested suspension always joins this exec's suspension (even when it arrives late): its approval
      // requests exist and must each be granted before anything resumes.
      if (!L.report.fatal) {
        const requests = outcome.pendingRequests ?? [outcome.request];
        this.mergeSuspension(L, { requests, spanIds: [spanId], children: outcome.childInvokeId ? [{ invokeId: outcome.childInvokeId, token: outcome.resumeToken }] : [], childRequestIds: requests.map((r) => r.requestId) });
        this.stop(L);
      }
      return err(req.callId, 'E_SUSPENDED', `sub-invoke suspended: ${this.red.redactText(outcome.request.reason)}`);
    }
    if (!this.isLive(L)) {
      L.report.late.push({ spanId, tool: 'invoke', ok: outcome.kind === 'returned' });
      try {
        await s.spans.evidence(`late:${this.o.runId}:${spanId}`, 'invoke.late', { outcome: outcome.kind });
      } catch (e) {
        this.fatal(L, [{ code: 'ledger', reason: `evidence not written: ${(e as Error).message}`, hookId: 'broker' }]);
      }
      return this.stoppedError(L, req.callId);
    }
    switch (outcome.kind) {
      case 'returned': {
        const value = this.clean({ kind: 'returned', value: outcome.value });
        return { callId: req.callId, ok: true, value, provenance: { ...prov, digest: digest(value) }, truncated: false };
      }
      case 'aborted': {
        return { callId: req.callId, ok: false, error: { name: 'E_ABORTED', message: this.red.redactText(outcome.reasons.map((r) => `${r.code}: ${r.reason}`).join('; ')) }, provenance: prov, truncated: false };
      }
      case 'failed':
        return { callId: req.callId, ok: false, error: { name: this.red.redactText(String(outcome.error.name)).slice(0, 64), message: this.red.redactText(String(outcome.error.message)) }, provenance: prov, truncated: false };
    }
  }

  private async deny(L: Live, spanId: string, input: JsonObject, caps: CapabilitySet, req: ToolRequest, tool: string, reasons: AbortReason[]): Promise<ToolResult> {
    const s = L.session;
    L.report.denied.push({ spanId, tool, method: req.method, reasons });
    try {
      await s.spans.evidence(`deny:${this.o.runId}:${spanId}`, 'tool.denied', { tool, method: req.method, path: (input.path as Json) ?? null, reasons: reasons as unknown as Json });
    } catch (e) {
      reasons = [...reasons, { code: 'ledger', reason: `evidence not written: ${(e as Error).message}`, hookId: 'broker' }];
    }
    const exit = await s.spans.emit('ToolCall', 'Exit', spanId, input, caps, { outcome: 'Aborted' });
    const fatal = [...reasons.filter((r) => isFatalCode(r.code)), ...(exit.abort?.reasons ?? [])];
    if (fatal.length) this.fatal(L, fatal);
    return err(req.callId, 'E_DENIED', this.red.redactText(reasons.map((r) => `${r.code}: ${r.reason}`).join('; ')));
  }

  /**
   * Tool context: the contract fields (fence = fenceOf(exec guard)) plus the tree's redactor and the exec's
   * signal (WorkerToolContext). Without an exec (re-authorization only) the fence is always false.
   */
  private ctxFor(caps: CapabilitySet, L?: Live): ToolContext {
    const ctx: WorkerToolContext = {
      runId: this.o.runId,
      worktree: this.o.worktree,
      capabilities: caps,
      ...(this.o.fencingToken !== undefined ? { fencingToken: this.o.fencingToken } : {}),
      fence: L ? fenceOf(L.guard) : () => false,
      redactor: this.red,
      ...(L ? { signal: L.ac.signal } : {}),
    };
    return ctx;
  }

  /** Exit after the call ran or was replayed; any Exit abort or settlement failure is fatal for the exec. */
  private async finishCall(L: Live, spanId: string, input: JsonObject, caps: CapabilitySet, output: JsonObject | undefined, outcome: 'Completed' | 'Failed' | 'Aborted'): Promise<void> {
    const s = L.session;
    const settle = await s.spans.settle(spanId);
    const exit = await s.spans.emit('ToolCall', 'Exit', spanId, input, caps, { outcome, ...(output ? { output } : {}) });
    this.fatal(L, [...settle, ...(exit.abort?.reasons ?? [])]);
  }

  private async toolCall(L: Live, tool: Tool, req: ToolRequest, callSeq: number): Promise<ToolResult> {
    const s = L.session;
    const spanId = `tool:${s.invokeId}:e${s.execNo}:c${callSeq}:g${s.spans.attempt}`;
    let caps = s.capabilities;
    let args = req.args;
    let actionHash = actionHashOf(tool.name, req.method, args, this.o.worktree);
    let idemKey = idemKeyOf(this.o.runId, s.invokeId, s.execNo, callSeq, actionHash);
    const mkInput = (): JsonObject => {
      const p = pathOf(args);
      return { tool: tool.name, method: req.method, args, actionHash, idemKey, callSeq, risk: tool.risk, ...(p !== undefined ? { path: p } : {}) };
    };
    let input = mkInput();

    if (!tool.methods.includes(req.method)) return this.deny(L, spanId, input, caps, req, tool.name, [{ code: 'allowlist', reason: `tool ${tool.name} has no method ${req.method}`, hookId: 'broker' }]);
    if (!caps.tools.includes(tool.name)) return this.deny(L, spanId, input, caps, req, tool.name, [{ code: 'allowlist', reason: `tool ${tool.name} is not in the capability set`, hookId: 'broker' }]);
    // D6: push / PR / merge are host gates, never worker tool calls: refused before any hook can hold them.
    const hostGate = hostGateActionOf(tool.name, req.method);
    if (hostGate) return this.deny(L, spanId, input, caps, req, tool.name, [{ code: 'policy', reason: `${hostGate} is a host gate (gate.pr on its human approval; Tecera never merges); a worker program cannot perform it`, hookId: 'broker' }]);

    // Enter
    let c = await s.spans.emit('ToolCall', 'Enter', spanId, input, caps);
    if (c.abort) return this.deny(L, spanId, input, caps, req, tool.name, c.abort.reasons);
    if (c.restrict) {
      caps = narrow(caps, c.restrict);
      if (!caps.tools.includes(tool.name)) return this.deny(L, spanId, input, caps, req, tool.name, [{ code: 'allowlist', reason: `capabilities restricted: ${tool.name} removed`, hookId: 'broker' }]);
    }
    if (c.patchInput.size) {
      const bad = [...c.patchInput.keys()].filter((p) => p !== 'args' && !p.startsWith('args.'));
      if (bad.length) return this.deny(L, spanId, input, caps, req, tool.name, [{ code: 'conflict', reason: `ToolCall PatchInput may only touch args (got ${bad.join(', ')})`, hookId: 'broker' }]);
      const patched = applyPatches(input, c.patchInput);
      args = Array.isArray(patched.args) ? (patched.args as Json[]) : args;
      actionHash = actionHashOf(tool.name, req.method, args, this.o.worktree);
      idemKey = idemKeyOf(this.o.runId, s.invokeId, s.execNo, callSeq, actionHash);
      input = mkInput();
    }
    const call: ToolRequest = { callId: req.callId, tool: tool.name, method: req.method, args, idemKey };

    // Journal replay: the action already happened in an earlier generation of this exact call. It is
    // re-authorized under the CURRENT scope before its (already redacted) result is handed back.
    const replay = this.shared.journal.get(idemKey);
    if (replay) {
      if (!canAuthorize(tool)) return this.deny(L, spanId, input, caps, req, tool.name, [{ code: 'policy', reason: `a journalled ${tool.name} call cannot be re-authorized; refusing to replay or re-run it`, hookId: 'broker' }]);
      try {
        await tool.authorize(call, this.ctxFor(caps, L));
      } catch (e) {
        return this.deny(L, spanId, input, caps, req, tool.name, [{ code: 'policy', reason: `replay refused under the current scope: ${(e as Error).message}`, hookId: 'broker' }]);
      }
      try {
        await s.spans.evidence(`replay:${this.o.runId}:${spanId}`, 'tool.replayed', { tool: tool.name, idemKey });
      } catch (e) {
        return this.deny(L, spanId, input, caps, req, tool.name, [{ code: 'ledger', reason: `evidence not written: ${(e as Error).message}`, hookId: 'broker' }]);
      }
      if (replay.ok && tool.risk !== 'read') this.shared.effects.set(idemKey, { invokeId: s.invokeId, tool: tool.name, method: req.method, args: this.red.redactJson(args) as Json[], idemKey });
      const output: JsonObject = { ok: replay.ok, value: replay.value ?? null, error: null, truncated: replay.truncated, provenance: replay.provenance as unknown as Json, replayed: true };
      const cr = await s.spans.emit('ToolCall', 'Complete', spanId, input, caps, { output });
      if (cr.abort) return this.deny(L, spanId, input, caps, req, tool.name, cr.abort.reasons);
      await this.finishCall(L, spanId, input, caps, output, 'Completed');
      if (!this.isLive(L)) return this.stoppedError(L, req.callId);
      return { ...replay, callId: req.callId };
    }

    // Send
    c = await s.spans.emit('ToolCall', 'Send', spanId, input, caps);
    if (c.abort) return this.deny(L, spanId, input, caps, req, tool.name, c.abort.reasons);
    if (c.suspend) {
      // D6: a write is never held for its own approval; a Suspend naming one is refused.
      const perWrite = c.suspend.find((r) => r && typeof r === 'object' && r.write !== undefined);
      if (perWrite) return this.deny(L, spanId, input, caps, req, tool.name, [{ code: 'policy', reason: `Suspend request ${perWrite.requestId} names a write: per-write approvals were removed (D6)`, hookId: 'broker' }]);
      const unbound = c.suspend.filter((r) => r.actionHash !== actionHash);
      if (unbound.length) return this.deny(L, spanId, input, caps, req, tool.name, [{ code: 'conflict', reason: `Suspend request ${unbound[0]!.requestId} is not bound to this call's actionHash`, hookId: 'broker' }]);
      const grants = this.takeGrants(c.suspend.map((x) => x.actionHash));
      if (!grants) {
        if (!L.report.fatal) {
          this.mergeSuspension(L, { requests: c.suspend, pending: call, spanIds: [spanId] });
          this.stop(L);
        }
        const exit = await s.spans.emit('ToolCall', 'Exit', spanId, input, caps, { outcome: 'Suspended' });
        this.fatal(L, exit.abort?.reasons ?? []);
        return err(req.callId, 'E_SUSPENDED', `approval required: ${this.red.redactText(c.suspend.map((x) => x.reason).join('; '))}`);
      }
      try {
        await s.spans.evidence(`grant:${this.o.runId}:${spanId}`, 'approval.applied', { requestIds: grants.map((g) => g.requestId), actionHash, approvers: grants.map((g) => g.approver) as unknown as Json });
      } catch (e) {
        return this.deny(L, spanId, input, caps, req, tool.name, [{ code: 'ledger', reason: `evidence not written: ${(e as Error).message}`, hookId: 'broker' }]);
      }
      const refused = await s.spans.reserve(spanId, spanId, 'Send', c);
      if (refused.length) return this.deny(L, spanId, input, caps, req, tool.name, refused);
    }

    // Liveness re-check immediately before anything runs: a suspension, an abort or the end of the exec
    // that happened while this call was in its hooks means it never executes.
    if (!this.isLive(L)) {
      L.report.discarded.push({ spanId, tool: tool.name });
      await s.spans.settle(spanId, Object.fromEntries([...c.reserve.keys()].map((k) => [k, 0])));
      try {
        await s.spans.evidence(`discard:${this.o.runId}:${spanId}`, 'tool.discarded', { tool: tool.name, idemKey, why: L.report.fatal ? 'aborted' : L.report.suspension ? 'suspended' : 'exec ended' });
      } catch (e) {
        this.fatal(L, [{ code: 'ledger', reason: `evidence not written: ${(e as Error).message}`, hookId: 'broker' }]);
      }
      const exit = await s.spans.emit('ToolCall', 'Exit', spanId, input, caps, { outcome: 'Aborted' });
      this.fatal(L, exit.abort?.reasons ?? []);
      return this.stoppedError(L, req.callId);
    }

    let result: ToolResult;
    let executed = false;
    if (c.replaceOutput !== undefined) {
      result = { callId: req.callId, ok: true, value: c.replaceOutput, provenance: { src: `tool:${tool.name}`, trust: 'untrusted' }, truncated: false };
    } else {
      executed = true;
      L.running.set(callSeq, tool.name);
      try {
        result = await tool.call(call, this.ctxFor(caps, L), L.guard);
        if (!result || typeof result !== 'object') throw new Error('tool returned no result');
      } catch (e) {
        result = { callId: req.callId, ok: false, error: { name: 'E_TOOL', message: (e as Error)?.message ?? 'tool failed' }, provenance: { src: `tool:${tool.name}`, trust: 'untrusted' }, truncated: false };
      } finally {
        L.running.delete(callSeq);
      }
    }
    // A commit that could not be verified (TaintError) quarantines the exec, the tree and the worktree.
    const wtTaint = executed ? worktreeTaint(this.o.worktree) : null;
    const taintedNow = !!this.shared.taint;
    if (!taintedNow && (wtTaint !== null || (result.ok === false && result.error?.name === 'TaintError'))) await this.quarantine(L, `${tool.name}: ${wtTaint ?? String(result.error?.message ?? 'unverifiable commit')}`);

    // Provenance re-tag (tools never mint trust) and redaction of everything the program will see.
    const ok = result.ok === true;
    const value = ok ? this.clean(toSafeJson(result.value ?? null) as Json) : undefined;
    const path = typeof result.provenance?.path === 'string' ? result.provenance.path : typeof input.path === 'string' ? input.path : undefined;
    let out: ToolResult = {
      callId: req.callId,
      ok,
      ...(value !== undefined ? { value } : {}),
      ...(ok ? {} : { error: { name: this.red.redactText(String(result.error?.name ?? 'E_TOOL')).slice(0, 64), message: this.red.redactText(String(result.error?.message ?? 'tool failed')) } }),
      provenance: { src: `tool:${tool.name}`, trust: 'untrusted', ...(path ? { path: this.red.redactText(path) } : {}), ...(value !== undefined ? { digest: digest(value) } : {}) },
      truncated: result.truncated === true,
    };
    const effect = executed && out.ok && tool.risk !== 'read';
    // A completion after the quarantine is discarded: never journalled (it must not be replayed as done).
    const journalled = effect && !taintedNow && !this.shared.taint;
    if (journalled) this.shared.journal.set(idemKey, out);
    if (effect) this.shared.effects.set(idemKey, { invokeId: s.invokeId, tool: tool.name, method: req.method, args: this.red.redactJson(args) as Json[], idemKey });
    // A read that returned data is a dependency: a completed child is replayed only while it is still readable.
    if (executed && out.ok && tool.risk === 'read') this.shared.effects.set(idemKey, { invokeId: s.invokeId, tool: tool.name, method: req.method, args: this.red.redactJson(args) as Json[], idemKey, read: true, readScope: [...caps.paths.read] });

    if (!this.isLive(L)) {
      // The tool was already running when the exec stopped: it happened (journalled above unless the tree
      // is quarantined), but its result is withheld from a program that is no longer allowed to act on it.
      L.report.late.push({ spanId, tool: tool.name, ok: out.ok });
      try {
        await s.spans.evidence(`late:${this.o.runId}:${spanId}`, 'tool.late', { tool: tool.name, idemKey, ok: out.ok, journalled, ...(taintedNow || this.shared.taint ? { tainted: true, discarded: true } : {}) });
      } catch (e) {
        this.fatal(L, [{ code: 'ledger', reason: `evidence not written: ${(e as Error).message}`, hookId: 'broker' }]);
      }
      await this.finishCall(L, spanId, input, caps, undefined, out.ok ? 'Completed' : 'Failed');
      return this.stoppedError(L, req.callId);
    }

    if (out.ok && replyBytes(out.value ?? null) > (this.o.maxReplyBytes ?? BROKER_LIMITS.maxReplyBytes)) {
      out = { callId: req.callId, ok: false, error: { name: 'E_LIMIT', message: `the ${tool.name} result exceeds the reply limit; ask for less (a narrower glob, a smaller file)` }, provenance: out.provenance, truncated: false };
    }

    // Complete
    const output: JsonObject = { ok: out.ok, value: out.value ?? null, error: (out.error as unknown as Json) ?? null, truncated: out.truncated, provenance: out.provenance as unknown as Json };
    c = await s.spans.emit('ToolCall', 'Complete', spanId, input, caps, { output });
    if (c.abort) {
      this.fatal(L, await s.spans.settle(spanId));
      return this.deny(L, spanId, input, caps, req, tool.name, c.abort.reasons);
    }
    if (c.patchOutput.size) {
      const patched = applyPatches(output, c.patchOutput);
      const pv = this.clean(patched.value ?? null);
      out = { ...out, value: pv, provenance: { ...out.provenance, digest: digest(pv) } };
    }
    await this.finishCall(L, spanId, input, caps, output, out.ok ? 'Completed' : 'Failed');
    if (!this.isLive(L) && L.report.fatal) return this.stoppedError(L, req.callId);
    return out;
  }
}
