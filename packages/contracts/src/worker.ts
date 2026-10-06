import { canonicalJson, sha256, type Json, type JsonObject } from './json.js';
import type { Provenance } from './bdi.js';

/**
 * Worker-side types: the JAZ-shaped invoke runtime that executes one step. Spans, stages, effects,
 * outcomes, bindings, capabilities. The loop never sees these directly; it talks to the Worker port.
 */

export type SpanKind = 'Invoke' | 'LLMQuery' | 'REPLExec' | 'ToolCall';
export type Stage = 'Enter' | 'Send' | 'Complete' | 'Exit' | 'Retry';
export type SpanOutcome = 'Completed' | 'Aborted' | 'Failed' | 'Suspended';

export interface Limits {
  usd: number;
  tokens: number;
  calls: number;
  wallMs: number;
  depth: number;
  iterations: number;
}

export interface CapabilitySet {
  tools: string[];
  paths: { read: string[]; write: string[]; protected: string[] };
  network: 'none';
  limits: Limits;
}

/** Intersection of two capability sets. A child can only narrow. */
export function narrow(parent: CapabilitySet, child: Partial<CapabilitySet>): CapabilitySet {
  const tools = child.tools ? parent.tools.filter((t) => child.tools!.includes(t)) : parent.tools;
  const read = child.paths?.read ? parent.paths.read.filter((p) => child.paths!.read!.includes(p)) : parent.paths.read;
  const write = child.paths?.write ? parent.paths.write.filter((p) => child.paths!.write!.includes(p)) : parent.paths.write;
  const protectedPaths = [...new Set([...parent.paths.protected, ...(child.paths?.protected ?? [])])];
  const limits: Limits = { ...parent.limits };
  if (child.limits) {
    for (const k of Object.keys(limits) as Array<keyof Limits>) {
      const v = child.limits[k];
      if (typeof v === 'number') limits[k] = Math.min(limits[k], v);
    }
  }
  return { tools, paths: { read, write, protected: protectedPaths }, network: 'none', limits };
}

/** True when `child` would grant anything `parent` does not. Used to refuse widening requests. */
export function widens(parent: CapabilitySet, child: Partial<CapabilitySet>): boolean {
  if (child.tools?.some((t) => !parent.tools.includes(t))) return true;
  if (child.paths?.read?.some((p) => !parent.paths.read.includes(p))) return true;
  if (child.paths?.write?.some((p) => !parent.paths.write.includes(p))) return true;
  if (child.limits) {
    for (const k of Object.keys(child.limits) as Array<keyof Limits>) {
      const v = child.limits[k];
      if (typeof v === 'number' && v > parent.limits[k]) return true;
    }
  }
  return false;
}

export type AbortCode = 'budget' | 'recursion' | 'iterations' | 'protected' | 'allowlist' | 'conflict' | 'hookError' | 'ledger' | 'schema' | 'policy' | 'cancelled';

export type Effect =
  | { type: 'PatchInput'; path: string; value: Json }
  | { type: 'ReplaceOutput'; value: Json }
  | { type: 'PatchOutput'; path: string; value: Json }
  | { type: 'Abort'; code: AbortCode; reason: string }
  | { type: 'Suspend'; request: SuspendRequest }
  | { type: 'RestrictCapabilities'; to: Partial<CapabilitySet> }
  | { type: 'ReserveBudget'; pool: keyof Limits; amount: number }
  | { type: 'AppendEvidence'; key: string; kind: string; body: Json }
  | { type: 'BlackboardCAS'; key: string; expected: Json | undefined; value: Json };

export interface SuspendRequest {
  requestId: string;
  action: string;
  actionHash: string;
  reason: string;
  requester: string;
  /**
   * The concrete write this request asks to perform (degraded isolation: one approval per distinct write).
   * When present, actionHash MUST equal writeActionHash({runId, intentionId, stepId, ...write}); the loop
   * refuses the hold otherwise, and a grant for it authorizes exactly this one write, once.
   */
  write?: WriteIntent;
}

// ---------- mutation-time fencing (security.md §4: "every repo write carries the token") ----------

/** One concrete worktree write: the repo-relative path and the sha256 of the exact bytes to be written. */
export interface WriteIntent {
  path: string;
  contentDigest: string;
}

/** What an approval for one degraded-isolation write is bound to. */
export interface WriteActionInput extends WriteIntent {
  runId: string;
  intentionId: string;
  stepId: string;
}

/**
 * Action hash of one write under degraded isolation:
 * sha256(canonicalJson({runId, intentionId, stepId, path, contentDigest})). The worker requests the approval
 * under it and consumes the grant with it; the loop recomputes it before holding and before resuming. Two
 * different writes (path or bytes) never share an approval.
 */
export function writeActionHash(a: WriteActionInput): string {
  return sha256(canonicalJson({ runId: a.runId, intentionId: a.intentionId, stepId: a.stepId, path: a.path, contentDigest: a.contentDigest }));
}

/** Thrown by WriteGuard.check() when the lease / fencing token is no longer live, the step was cancelled or the exec is tainted. */
export class FenceLost extends Error {
  readonly code = 'fence-lost';
  constructor(reason: string) {
    super(`fence lost: ${reason}`);
    this.name = 'FenceLost';
  }
}

/** Thrown by WriteGuard.authorizeWrite() for a write that may never happen (e.g. a grant already spent on it). */
export class WriteRefused extends Error {
  readonly code = 'write-refused';
  constructor(reason: string) {
    super(`write refused: ${reason}`);
    this.name = 'WriteRefused';
  }
}

/**
 * Answer of WriteGuard.authorizeWrite():
 * - 'allowed': isolation is not degraded; write now (check() already passed).
 * - 'approved': the step was resumed with a grant bound to exactly this write; the tool consumes
 *   `requestId` with `actionHash` (Ledger.consume) and writes. A second identical write throws WriteRefused.
 * - 'needs-approval': degraded isolation and no grant for this write; the tool must request an approval
 *   under `actionHash` with a NEW request id and suspend with SuspendRequest.write set. It must not write.
 */
export type WriteAuthorization =
  | { kind: 'allowed' }
  | { kind: 'approved'; requestId: string; actionHash: string }
  | { kind: 'needs-approval'; actionHash: string };

/**
 * Mutation-time fence handed to every tool call (Tool.call's third argument) and to the commit gate
 * (GateContext.guard). Supplied by the loop / runtime and live for the whole call:
 *
 * - `check()` throws FenceLost when the worktree lease or fencing token is no longer the one this step was
 *   dispatched under, the loop stopped, the step was cancelled (deadline, intention dropped) or the exec is
 *   tainted. A tool MUST call it immediately before EACH mutation (every write, rename, unlink, chmod, git
 *   ref/index update) — not only on entry — and must not mutate when it throws.
 * - `signal` aborts on the same conditions; long operations must stop on it.
 * - `authorizeWrite(w)`, when present, MUST be called before each file write (after check()); see
 *   WriteAuthorization. It is how degraded isolation gets one approval per distinct write.
 *
 * Fail closed: a write-class tool called without a guard refuses (see requireWriteGuard).
 */
export interface WriteGuard {
  check(): void;
  readonly signal: AbortSignal;
  authorizeWrite?(w: WriteIntent): WriteAuthorization;
}

/**
 * A WriteGuard over a liveness callback. `live()` returns null while writes are allowed, else the reason
 * they are not. Methods live on the prototype and state in private fields, so the guard survives spread,
 * JSON and structuredClone of the object that carries it (it clones to {} rather than throwing).
 */
export class FencedWriteGuard implements WriteGuard {
  readonly #live: () => string | null;
  readonly #signal: AbortSignal;
  readonly #authorize: ((w: WriteIntent) => WriteAuthorization) | undefined;

  constructor(o: { live: () => string | null; signal: AbortSignal; authorizeWrite?: (w: WriteIntent) => WriteAuthorization }) {
    this.#live = o.live;
    this.#signal = o.signal;
    this.#authorize = o.authorizeWrite;
  }

  get signal(): AbortSignal {
    return this.#signal;
  }

  check(): void {
    if (this.#signal.aborted) throw new FenceLost(reasonOf(this.#signal.reason) ?? 'the step was cancelled');
    let why: string | null;
    try {
      why = this.#live();
    } catch (err) {
      throw new FenceLost(`liveness check failed (${err instanceof Error ? err.message : String(err)})`);
    }
    if (why !== null) throw new FenceLost(why);
  }

  authorizeWrite(w: WriteIntent): WriteAuthorization {
    this.check();
    if (!w || typeof w.path !== 'string' || !w.path || typeof w.contentDigest !== 'string' || !w.contentDigest) throw new WriteRefused('a write must name its path and content digest');
    return this.#authorize ? this.#authorize(w) : { kind: 'allowed' };
  }
}

function reasonOf(r: unknown): string | undefined {
  if (r === undefined) return undefined;
  return r instanceof Error ? r.message : String(r);
}

/** A guard that refuses every mutation (what a tool must assume when it was given none). */
export function refusingWriteGuard(reason = 'no write guard was supplied'): WriteGuard {
  const ac = new AbortController();
  ac.abort(new FenceLost(reason));
  return new FencedWriteGuard({ live: () => reason, signal: ac.signal });
}

/** The guard to use for a call: the one given, or one that refuses every mutation (fail closed). */
export function requireWriteGuard(guard: WriteGuard | undefined | null): WriteGuard {
  return guard && typeof guard.check === 'function' && guard.signal ? guard : refusingWriteGuard();
}

/** ToolContext.fence from a guard: true while check() passes. */
export function fenceOf(guard: WriteGuard | undefined | null): () => boolean {
  const g = requireWriteGuard(guard);
  return () => {
    try {
      g.check();
      return true;
    } catch {
      return false;
    }
  };
}

export interface RunRef {
  runId: string;
  invokeId: string;
  depth: number;
  parentInvokeId?: string;
  checkpointId?: string;
}

export type Outcome<T = Json> =
  | { kind: 'returned'; value: T; run: RunRef }
  | { kind: 'suspended'; request: SuspendRequest; resumeToken: string; run: RunRef }
  | { kind: 'aborted'; reasons: Array<{ code: AbortCode; reason: string; hookId: string }>; run: RunRef }
  | { kind: 'failed'; error: SerializedError; run: RunRef };

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

export type ExecResult =
  | { kind: 'continue'; output: string; exception?: SerializedError }
  | { kind: 'return'; value: Json; output: string }
  | { kind: 'raise'; exception: SerializedError }
  | { kind: 'suspended'; pending: ToolRequest };

export type Binding =
  | { kind: 'value'; value: Json; provenance: Provenance }
  | { kind: 'handle'; id: string; methods: string[]; description: string }
  | { kind: 'hidden'; value: Json };

export type Inputs = Record<string, Binding>;

/** Names generated code may never rebind. */
export const RESERVED_BINDINGS = ['__history__', '__depth__', '__capabilities__'] as const;

export interface ToolRequest {
  callId: string;
  tool: string;
  method: string;
  args: Json[];
  idemKey: string;
}

export interface ToolResult {
  callId: string;
  ok: boolean;
  value?: Json;
  error?: SerializedError;
  provenance: Provenance;
  truncated: boolean;
  /**
   * Handles to the truncated remainders of `value` (see rpc.ts: in-value references are {"$handle": h};
   * view handles expose len/slice/search). `path` is the JSON path inside value that was cut.
   */
  handles?: Array<{ path: string; handle: string; methods: string[]; totalChars: number }>;
}

export interface HistoryEntry {
  turn: number;
  code: string;
  /** Untruncated REPL output; the serializer truncates when rendering. */
  output: string;
  result: ExecResult['kind'];
}

export interface SpanEvent {
  span: SpanKind;
  stage: Stage;
  spanId: string;
  run: RunRef;
  attempt: number;
  input: JsonObject;
  output?: JsonObject;
  outcome?: SpanOutcome;
}

export interface HookDescriptor {
  id: string;
  mandatory: boolean;
  config: JsonObject;
}
