import { randomUUID } from 'node:crypto';
import {
  digest,
  narrow,
  requireApproval,
  RESERVED_BINDINGS,
  sha256,
  widens,
  type AbortCode,
  type ApprovalGrant,
  type CapabilitySet,
  type ExecResult,
  type Hook,
  type HistoryEntry,
  type Inputs,
  type Json,
  type JsonObject,
  type Ledger,
  type Limits,
  type LLM,
  type LLMMessage,
  type LLMResponse,
  type Outcome,
  type Principal,
  type Provenance,
  type Redactor,
  type Repl,
  type RunRef,
  type SecretInput,
  type SerializedError,
  type SuspendRequest,
  type ToolRequest,
  type ToolResult,
} from '@tecera/contracts';
import { ConfigStack, DEFAULT_CONFIG, type ConfigOverride, type WorkerConfig } from '../config.js';
import type { Composed } from '../hooks/compose.js';
import { Dispatcher } from '../hooks/dispatcher.js';
import { currentScope, scope } from '../scope.js';
import { SubInvokeDenied, type Broker, type EffectRecord, type ExecReport, type SubInvokeRequest, type SubInvokeResult, type TaintInfo } from '../broker/broker.js';
import { sandboxCallbacks, type SandboxCallbacks } from '../broker/sandboxBridge.js';
import { parseProgram } from '../protocol/parser.js';
import { renderTask, STANDARD_STUBS, workerSystemPrompt, type StubDoc } from '../protocol/prompts.js';
import { newNonce, redactorFor, SERIALIZER_LIMITS, serializeInputs, truncate, wrapUntrusted } from '../protocol/serializer.js';
import { History, HISTORY_METHODS } from './history.js';
import { validateSchema } from './schema.js';
import { applyPatches, SpanRunner, type AbortReason, type TraceEntry } from './span.js';

/**
 * invoke: the worker loop inside one step (JAZ port). Invoke/Enter → per turn: LLMQuery span → parse →
 * REPLExec span around repl.exec(bridge) → continue (output to history) | raise (error to history) |
 * return (validated against the output schema; failure goes back to the model) | suspended (checkpoint,
 * approval requests, Outcome suspended). `returned` never means the goal is done.
 *
 * Fail-closed rules this file owns:
 * - Every Exit stage is checked: an Abort or a ledger failure there (evidence, settlement) makes the
 *   outcome `aborted` and nothing further runs; persistence failures are sticky in the SpanRunner.
 * - Effects are honoured or refused, never ignored: Invoke/REPLExec/LLMQuery Enter RestrictCapabilities
 *   narrow what follows; PatchInput applies where the stage has a meaning for it and otherwise aborts
 *   with 'conflict'. Scope variables are inputs (explicit inputs win).
 * - Write fence: the broker carries the step's WriteGuard (InvokeOptions/ResumeDeps via the Broker); every
 *   mutation is checked against it. D6 (2026-10-05): writes inside paths.write proceed without approval
 *   under any isolation; there are no per-write approvals, so a Suspend that names a write
 *   (SuspendRequest.write) is never recorded and a checkpoint held on one is never resumed.
 * - Approvals: every Suspend request is persisted (checkpoint + one ledger approval request each) and must
 *   be granted independently. resume(token, grant) binds ONE grant to ONE pending request by requestId and
 *   actionHash (verified against the ledger's approval row, then consumed: the worker owns consumption);
 *   while other requests remain, resume returns `suspended` with the next one and a new token. Only when
 *   all are granted does the program re-run, each grant lifting exactly one Suspend for its actionHash.
 * - Nested invokes: tree-unique invokeIds (`<parent>/e<execNo>c<callSeq>`) and exec numbers; a suspended
 *   child keeps its own checkpoint and is RESUMED from it (not re-planned) when the parent re-runs. A child
 *   that COMPLETED before the parent suspended is recorded (outcome, argument digest, the non-read effects
 *   AND the read dependencies of its subtree) in the parent's checkpoint and REPLAYED when the parent
 *   re-runs: never re-planned, never re-executed; its effects and reads are re-authorized under the
 *   current scope first (a child whose data the current scope can no longer read is not replayed), and a
 *   refusal (or changed arguments) refuses the call instead of running the child again.
 * - Quarantine: when the broker reports the tree tainted (an unresolved writer at drain timeout, or an
 *   unverifiable commit), no checkpoint is written and every outcome becomes `aborted` with a
 *   `tainted:` reason and a `tainted` field (TaintedOutcome). The worktree must not be reused or gated.
 * - Secrets: value inputs carrying secret material are refused at Invoke/Enter; everything handed to the
 *   child, persisted (checkpoints, journal), traced or returned in an Outcome passes the contracts redactor.
 *   The redactor built from InvokeOptions.secrets is adopted by the broker, so the broker, its tools and
 *   every descendant use the same secret list. Text is redacted in full before it is cut.
 */

/** An aborted outcome of a quarantined invoke tree (contracts Outcome plus the `tainted` field). */
export type TaintedOutcome = Extract<Outcome, { kind: 'aborted' }> & { tainted: TaintInfo };

export const isTainted = (o: Outcome): o is TaintedOutcome => o.kind === 'aborted' && !!(o as Partial<TaintedOutcome>).tainted;

/** A nested invoke that completed: replayed (never re-run) when its parent re-runs after a resume. */
interface ChildRecord {
  invokeId: string;
  argsDigest: string;
  outcome: Json;
  effects: EffectRecord[];
}

/** Per-invoke REPL construction context: callbacks are bound to THIS invoke's broker. */
export interface ReplContext {
  runId: string;
  invokeId: string;
  depth: number;
  execNo: number;
  capabilities: CapabilitySet;
  broker: Broker;
  /** Wire into ChildProcessReplOptions.onInvoke / onCheckpoint. */
  callbacks: SandboxCallbacks;
}
export type ReplFactory = (ctx: ReplContext) => Repl;

export interface InvokeOptions {
  /** JSON schema the return value must satisfy. */
  output: JsonObject;
  config?: ConfigOverride;
  hooks: Hook[];
  /** Default LLM; `llms[config.seatId]` wins when present (by-depth routing). */
  llm: LLM;
  llms?: Record<string, LLM>;
  /**
   * A factory called for every exec of every invoke in the tree (root and nested) so the REPL's host
   * callbacks and capabilities belong to that exec; the REPL is disposed after the exec. A plain Repl is
   * accepted for in-process test doubles that route host functions through the bridge they are given.
   */
  repl: Repl | ReplFactory;
  broker: Broker;
  ledger?: Ledger;
  run: RunRef;
  signal?: AbortSignal;
  /** Defaults to the broker's capabilities; always narrowed by the enclosing scope. */
  capabilities?: CapabilitySet;
  /** Secret values (>= 8 chars) to redact from every boundary; inputs carrying them are refused. */
  secrets?: readonly SecretInput[];
  /** Session the approval requests belong to (ledger approvals are session-bound). Default 'local'. */
  sessionId?: string;
  approvalTtlMs?: number;
  modelBudgetChars?: number;
  maxTokens?: number;
  llmRetries?: number;
  now?: () => number;
  trace?: TraceEntry[];
  /** Shared across nested invokes so hooks and blackboard are the same instances. */
  dispatcher?: Dispatcher;
  /** Opaque caller data stored (redacted) in the suspension checkpoint (StepWorker uses it to rebuild deps). */
  checkpointExtra?: JsonObject;
}

export interface ResumeDeps extends Omit<InvokeOptions, 'output' | 'run'> {
  /** Consume the grant in the ledger (default true: the worker owns consumption of its requests). */
  consume?: boolean;
  /**
   * Without a ledger a grant cannot be verified, so resume refuses by default. Tests of the in-process
   * (`mem:`) path set this to accept the grant on its own fields. Never set it in a run.
   */
  allowUnverifiedGrants?: boolean;
}

interface GrantRecord {
  requestId: string;
  actionHash: string;
  approver: Principal;
  grantedAt: number;
  expiresAt: number;
}

interface Pending {
  phase: 'turn' | 'exec';
  code?: string;
  execNo?: number;
  /** Every request this suspension waits on, in order. */
  requests: SuspendRequest[];
  /** Grants applied so far (each verified and consumed). */
  granted: GrantRecord[];
  /** Suspended nested invokes and their own checkpoints. */
  children: Array<{ invokeId: string; token: string }>;
  toolRequest?: ToolRequest;
}

interface State {
  inputs: Inputs;
  history: History;
  turn: number;
  checkpoints: Map<string, Json>;
  generation: number;
  /** Completed nested invokes of this invoke, by child invokeId. */
  children: Map<string, ChildRecord>;
}

export interface InvokeCheckpoint extends JsonObject {
  v: 2;
  kind: 'tecera.invoke';
  run: Json;
  sessionId: string;
  output: JsonObject;
  inputs: Json;
  history: Json;
  turn: number;
  execSeq: number;
  checkpoints: Json;
  generation: number;
  pending: Json;
  journal: Json;
  config: Json;
  extra: Json;
  /** Completed nested invokes (ChildRecord[]); absent (undefined at runtime) in older checkpoints. */
  children: Json;
  /** Completed non-read effects of the tree (EffectRecord[]); absent in older checkpoints. */
  effects: Json;
}

interface Internal extends InvokeOptions {
  red: Redactor;
  /** Child invokeId → its checkpoint token: nested invokes to resume instead of starting fresh. */
  resumeChildren?: Map<string, string>;
}

const MEMORY_CHECKPOINT_CAP = 1000;
const memoryCheckpoints = new Map<string, JsonObject>();
function memPut(state: JsonObject): string {
  const token = `mem:${randomUUID()}`;
  memoryCheckpoints.set(token, structuredClone(state));
  while (memoryCheckpoints.size > MEMORY_CHECKPOINT_CAP) memoryCheckpoints.delete(memoryCheckpoints.keys().next().value!);
  return token;
}

export class InvokeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvokeError';
  }
}

const isReserved = (k: string): boolean => (RESERVED_BINDINGS as readonly string[]).includes(k);
const serr = (e: unknown): SerializedError => (e instanceof Error ? { name: e.name || 'Error', message: e.message } : { name: 'Error', message: String(e) });
const outcomeOf = (o: Outcome): 'Completed' | 'Aborted' | 'Failed' | 'Suspended' => (o.kind === 'returned' ? 'Completed' : o.kind === 'aborted' ? 'Aborted' : o.kind === 'failed' ? 'Failed' : 'Suspended');
const isFactory = (r: Repl | ReplFactory): r is ReplFactory => typeof r === 'function';

function dedupe(reasons: AbortReason[]): AbortReason[] {
  const seen = new Set<string>();
  return reasons.filter((r) => {
    const k = `${r.code}\u0000${r.reason}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Redact everything an Outcome carries (values, reasons, messages); never return a stack. */
export function sanitizeOutcome<T extends Outcome>(o: T, red: Redactor): T {
  switch (o.kind) {
    case 'returned':
      return { ...o, value: red.redactJson(o.value) };
    case 'aborted': {
      const t = (o as Partial<TaintedOutcome>).tainted;
      return { ...o, reasons: o.reasons.map((r) => ({ code: r.code, reason: red.redactText(String(r.reason)), hookId: red.redactText(String(r.hookId)) })), ...(t ? { tainted: red.redactJson(t) as unknown as TaintInfo } : {}) };
    }
    case 'failed':
      return { ...o, error: { name: red.redactText(String(o.error.name)).slice(0, 128), message: red.redactText(String(o.error.message)) } };
    case 'suspended':
      return { ...o, request: sanitizeRequest(o.request, red) };
  }
  return o;
}

/**
 * A SuspendRequest as it may leave the worker: every text field redacted. It never carries `write`: per-write
 * approvals were removed (D6), and suspend() refuses a request that names one before it gets here.
 */
function sanitizeRequest(r: SuspendRequest, red: Redactor): SuspendRequest {
  return { requestId: r.requestId, action: red.redactText(String(r.action)), actionHash: r.actionHash, reason: red.redactText(String(r.reason)), requester: red.redactText(String(r.requester)) };
}

function redactorOrFail(secrets: readonly SecretInput[] | undefined): Redactor | SerializedError {
  try {
    return redactorFor(secrets ?? []);
  } catch (e) {
    return { name: 'RedactionError', message: (e as Error).message };
  }
}

export async function invoke(inputs: Inputs, opts: InvokeOptions): Promise<Outcome> {
  const own = redactorOrFail(opts.secrets);
  if (!('redactText' in own)) return { kind: 'failed', error: own, run: opts.run };
  // One redactor for invoke, broker, tools and descendants: the broker adopts this secret list.
  opts.broker.adoptRedactor(own);
  const red = opts.broker.redactor;
  const st: State = { inputs, history: new History([], red), turn: 0, checkpoints: new Map(), generation: 1, children: new Map() };
  return strip(await runInvoke(st, { ...opts, red }));
}

/** Drop the internal fields of a nested-invoke result before it leaves the module. */
function strip(o: SubInvokeResult): Outcome {
  const { pendingRequests: _p, childInvokeId: _c, ...rest } = o as SubInvokeResult & Record<string, unknown>;
  return rest as Outcome;
}

/** Load a suspension checkpoint (ledger, or the in-process store for `mem:` tokens). */
export async function loadInvokeCheckpoint(token: string, ledger?: Ledger): Promise<InvokeCheckpoint | null> {
  if (typeof token !== 'string' || !token) return null;
  let s: JsonObject | null = null;
  if (token.startsWith('mem:')) s = memoryCheckpoints.get(token) ?? null;
  else if (ledger) s = await ledger.loadCheckpoint(token);
  if (!s || s.v !== 2 || s.kind !== 'tecera.invoke') return null;
  return structuredClone(s) as InvokeCheckpoint;
}

/** The request a suspended checkpoint waits on next (the first one not yet granted), or null. */
export function nextPendingRequest(cp: InvokeCheckpoint): SuspendRequest | null {
  const p = cp.pending as unknown as Pending;
  return p.requests.find((r) => !p.granted.some((g) => g.requestId === r.requestId)) ?? null;
}

/**
 * Resume a suspended invoke with ONE approval grant for ONE of its pending requests. The grant must name
 * a pending request, be unexpired and human, match the ledger's approval row (granted, same run, same
 * session, same actionHash, same approver) and is then consumed. While other requests are still pending
 * the result is `suspended` again (the next request, a new token). When the last request is granted the
 * program re-runs: calls that completed before the suspension replay from the journal (re-authorized),
 * each grant lifts exactly one Suspend for its actionHash, suspended nested invokes resume from their
 * own checkpoints.
 */
export async function resume(token: string, grant: ApprovalGrant, deps: ResumeDeps): Promise<Outcome> {
  const now = deps.now ?? Date.now;
  const own = redactorOrFail(deps.secrets);
  const fallbackRun: RunRef = { runId: deps.broker.runId, invokeId: 'unknown', depth: 0, checkpointId: String(token) };
  if (!('redactText' in own)) return { kind: 'failed', error: own, run: fallbackRun };
  deps.broker.adoptRedactor(own);
  const red = deps.broker.redactor;
  const cp = await loadInvokeCheckpoint(token, deps.ledger).catch(() => null);
  if (!cp) return { kind: 'failed', error: { name: 'ResumeError', message: 'no invoke checkpoint for this token' }, run: fallbackRun };
  const run = { ...(cp.run as unknown as RunRef), checkpointId: token };
  const pending = cp.pending as unknown as Pending;
  const deny = (code: AbortCode, reason: string): Outcome => sanitizeOutcome({ kind: 'aborted', reasons: [{ code, reason, hookId: 'resume' }], run }, red);
  const session = deps.sessionId ?? 'local';

  const req = grant && typeof grant === 'object' ? pending.requests.find((r) => r.requestId === grant.requestId) : undefined;
  if (!req) return deny('policy', 'grant does not match any pending approval request of this checkpoint');
  if (pending.granted.some((g) => g.requestId === req.requestId)) return deny('policy', `grant ${req.requestId} was already applied`);
  // D6: a hold for one write (an older worker's per-write approval) is never resumed; nothing is consumed.
  if (pending.requests.some((r) => r && typeof r === 'object' && (r as { write?: unknown }).write !== undefined)) return deny('policy', 'this hold is a per-write approval; per-write approvals were removed (D6): re-run the step');
  if (!(typeof grant.expiresAt === 'number' && grant.expiresAt > now())) return deny('policy', 'grant has expired');
  if (grant.approver?.kind !== 'human' || typeof grant.approver.id !== 'string' || !grant.approver.id) return deny('policy', 'only a human principal can approve');
  if (cp.sessionId !== session) return deny('policy', 'the grant belongs to another session');
  if (!deps.ledger && deps.allowUnverifiedGrants !== true) return deny('policy', 'no ledger: the grant cannot be verified; refusing to resume');
  if (deps.ledger) {
    let view;
    try {
      view = await requireApproval(deps.ledger, req.requestId);
    } catch (e) {
      return deny('policy', `approval cannot be verified: ${(e as Error).message}`);
    }
    const why = !view
      ? 'unknown approval request'
      : view.state !== 'granted'
        ? `approval is ${view.state}`
        : view.runId !== run.runId
          ? 'approval belongs to another run'
          : view.sessionId !== session
            ? 'approval belongs to another session'
            : view.actionHash !== req.actionHash
              ? 'approval is for another action'
              : !(view.expiresAt > now())
                ? 'approval has expired'
                : !view.approver || view.approver.kind !== grant.approver.kind || view.approver.id !== grant.approver.id
                  ? 'grant approver does not match the ledger'
                  : null;
    if (why) return deny('policy', why);
    if (deps.consume !== false) {
      try {
        await deps.ledger.consume(req.requestId, req.actionHash, session, `consume:${req.requestId}`, now());
      } catch (e) {
        return deny('policy', `grant could not be consumed: ${(e as Error).message}`);
      }
    }
  }
  const granted: GrantRecord[] = [...pending.granted, { requestId: req.requestId, actionHash: req.actionHash, approver: { kind: grant.approver.kind, id: grant.approver.id }, grantedAt: grant.grantedAt, expiresAt: grant.expiresAt }];
  const remaining = pending.requests.filter((r) => !granted.some((g) => g.requestId === r.requestId));
  if (token.startsWith('mem:')) memoryCheckpoints.delete(token);
  if (remaining.length) {
    const next: InvokeCheckpoint = { ...cp, pending: { ...pending, granted } as unknown as Json };
    let t2: string;
    try {
      t2 = deps.ledger ? await deps.ledger.checkpoint(run.runId, `invoke:${run.invokeId}:granted:${granted.length}`, next) : memPut(next);
    } catch (e) {
      return deny('ledger', `partial approval not recorded: ${(e as Error).message}`);
    }
    return sanitizeOutcome({ kind: 'suspended', request: remaining[0]!, resumeToken: t2, run: { ...run, checkpointId: t2 } }, red);
  }
  if (granted.some((g) => !(g.expiresAt > now()))) return deny('policy', 'an earlier grant of this suspension has expired');
  for (const g of granted) deps.broker.grant(g.actionHash, { requestId: g.requestId, approver: g.approver, grantedAt: g.grantedAt, expiresAt: g.expiresAt });
  const out = await resumeFromCheckpoint(cp, token, { ...deps, output: cp.output, run, red });
  return strip(out);
}

/** Re-run a checkpointed invoke (grants are already bound to the broker by the caller). */
async function resumeFromCheckpoint(cp: InvokeCheckpoint, token: string, opts: Internal): Promise<SubInvokeResult> {
  const pending = cp.pending as unknown as Pending;
  if (token.startsWith('mem:')) memoryCheckpoints.delete(token);
  opts.broker.preloadJournal(cp.journal as unknown as Array<[string, ToolResult]>);
  opts.broker.preloadEffects(cp.effects);
  opts.broker.restoreExecSeq(cp.execSeq);
  const st: State = {
    inputs: cp.inputs as unknown as Inputs,
    history: new History(Array.isArray(cp.history) ? (cp.history as unknown as HistoryEntry[]) : [], opts.red),
    turn: cp.turn,
    checkpoints: new Map(Object.entries((cp.checkpoints as JsonObject) ?? {})),
    generation: cp.generation + 1,
    children: new Map(childRecords(cp.children).map((c) => [c.invokeId, c] as const)),
  };
  const children = new Map((pending.children ?? []).map((c) => [c.invokeId, c.token] as const));
  const o: Internal = { ...opts, ...(cp.config ? { config: cp.config as unknown as ConfigOverride } : {}), ...(cp.extra ? { checkpointExtra: cp.extra as JsonObject } : {}), resumeChildren: children };
  return runInvoke(st, o, pending.phase === 'exec' && typeof pending.code === 'string' && typeof pending.execNo === 'number' ? { code: pending.code, execNo: pending.execNo } : undefined);
}

async function runInvoke(st: State, opts: Internal, rerun?: { code: string; execNo: number }): Promise<SubInvokeResult> {
  const run = opts.run;
  const red = opts.red;
  const now = opts.now ?? Date.now;
  const frame = currentScope();
  const hooks = [...new Set([...frame.hooks, ...opts.hooks])];
  const dispatcher = opts.dispatcher ?? new Dispatcher(hooks);
  const spans = new SpanRunner({ dispatcher, run, ...(opts.ledger ? { ledger: opts.ledger } : {}), redactor: red, ...(opts.trace ? { trace: opts.trace } : {}), attempt: st.generation });
  const invokeSpan = `inv:${run.invokeId}:g${st.generation}`;
  const sessionId = opts.sessionId ?? 'local';
  const aborted = (reasons: AbortReason[]): Outcome => ({ kind: 'aborted', reasons, run });

  let config: WorkerConfig;
  try {
    config = new ConfigStack(DEFAULT_CONFIG, [...frame.configs, ...(opts.config ? [opts.config] : [])]).resolve(run.depth);
  } catch (e) {
    return sanitizeOutcome({ kind: 'failed', error: serr(e), run }, red);
  }
  let caps = opts.capabilities ?? opts.broker.capabilities;
  if (frame.capabilities) {
    if (widens(frame.capabilities, caps)) return sanitizeOutcome(aborted([{ code: 'policy', reason: 'capabilities exceed the enclosing scope', hookId: 'invoke' }]), red);
    caps = narrow(frame.capabilities, caps);
  }
  // Scope variables are inputs; explicit inputs win (nearest first). Reserved names are refused.
  st.inputs = { ...frame.vars, ...st.inputs };
  for (const k of Object.keys(st.inputs)) if (isReserved(k)) return sanitizeOutcome(aborted([{ code: 'policy', reason: `binding ${k} is reserved`, hookId: 'invoke' }]), red);
  const llm = opts.llms?.[config.seatId] ?? opts.llm;

  const kinds = (): Json => Object.fromEntries(Object.entries(st.inputs).map(([k, b]) => [k, b.kind]));
  let invokeInput: JsonObject = { depth: run.depth, seatId: config.seatId, inputs: kinds(), output: opts.output, resumed: st.generation > 1 };

  const finish = async (o: Outcome, pendingRequests?: SuspendRequest[]): Promise<SubInvokeResult> => {
    const c = await spans.emit('Invoke', 'Exit', invokeSpan, invokeInput, caps, { outcome: outcomeOf(o), output: { kind: o.kind } });
    const settled = await spans.settle(invokeSpan);
    for (const k of spans.openReservations()) settled.push(...(await spans.settle(k)));
    const failures = dedupe([...(c.abort?.reasons ?? []), ...settled, ...(spans.fatal ?? [])]);
    let out: Outcome = o;
    // A final record or settlement that failed overrides every outcome kind, `failed` included.
    if (failures.length && o.kind === 'aborted') out = aborted(dedupe([...o.reasons, ...failures]));
    else if (failures.length) out = aborted(dedupe([...failures, ...(o.kind === 'failed' ? [{ code: 'ledger' as const, reason: `the invoke had failed (${o.error.name}: ${o.error.message}) and its final record could not be completed`, hookId: 'invoke' }] : [])]));
    // A quarantined tree never reports anything but an aborted, tainted outcome.
    const taint = opts.broker.tainted;
    if (taint) {
      const prior = out.kind === 'aborted' ? out.reasons : [];
      out = { kind: 'aborted', reasons: dedupe([{ code: 'cancelled', reason: `tainted: ${taint.reason}`, hookId: 'quarantine' }, ...prior]), run, tainted: { ...taint, unresolved: [...taint.unresolved] } } as TaintedOutcome;
    }
    const clean = sanitizeOutcome(out, red) as SubInvokeResult;
    if (clean.kind === 'suspended') return { ...clean, pendingRequests: (pendingRequests ?? [clean.request]).map((r) => sanitizeRequest(r, red)), childInvokeId: run.invokeId };
    return clean;
  };

  // ---- suspension: checkpoint + one approval request per own request, then Outcome suspended
  const suspend = async (requests: SuspendRequest[], base: Omit<Pending, 'requests' | 'granted' | 'children'> & { children?: Pending['children'] }, childRequestIds: readonly string[] = []): Promise<SubInvokeResult> => {
    // A quarantined tree is never checkpointed (nothing may resume on a tainted worktree).
    if (opts.broker.tainted) return finish(aborted([]));
    const byId = new Map<string, SuspendRequest>();
    for (const r of requests) {
      if (!r || typeof r.requestId !== 'string' || !r.requestId || typeof r.actionHash !== 'string' || !r.actionHash) return finish(aborted([{ code: 'conflict', reason: 'malformed Suspend request', hookId: 'invoke' }]));
      const prev = byId.get(r.requestId);
      if (prev && prev.actionHash !== r.actionHash) return finish(aborted([{ code: 'conflict', reason: `two Suspend requests share id ${r.requestId} with different actions`, hookId: 'invoke' }]));
      if (r.write !== undefined) return finish(aborted([{ code: 'policy', reason: `Suspend request ${r.requestId} names a write: per-write approvals were removed (D6)`, hookId: 'invoke' }]));
      byId.set(r.requestId, r);
    }
    const list = [...byId.values()];
    if (!list.length) return finish(aborted([{ code: 'conflict', reason: 'suspension without a request', hookId: 'invoke' }]));
    const pending: Pending = { ...base, requests: list.map((r) => sanitizeRequest(r, red)), granted: [], children: base.children ?? [] };
    const state: InvokeCheckpoint = {
      v: 2,
      kind: 'tecera.invoke',
      run: red.redactJson(run),
      sessionId,
      output: red.redactJson(opts.output) as JsonObject,
      inputs: red.redactJson(st.inputs),
      history: red.redactJson(st.history.all()),
      turn: st.turn,
      execSeq: opts.broker.execSeq,
      checkpoints: red.redactJson(Object.fromEntries(st.checkpoints)),
      generation: st.generation,
      pending: red.redactJson(pending),
      journal: red.redactJson(opts.broker.exportJournal()),
      config: red.redactJson(opts.config ?? null),
      extra: red.redactJson(opts.checkpointExtra ?? null),
      children: red.redactJson([...st.children.values()]),
      effects: red.redactJson(opts.broker.exportEffects()),
    };
    let token: string;
    try {
      token = opts.ledger ? await opts.ledger.checkpoint(run.runId, `invoke:${run.invokeId}:g${st.generation}`, state) : memPut(state);
      if (opts.ledger) {
        for (const r of pending.requests) {
          if (childRequestIds.includes(r.requestId)) continue; // the nested invoke already requested it
          await requestOnce(opts.ledger, { requestId: r.requestId, runId: run.runId, sessionId, actionHash: r.actionHash, requester: { kind: 'agent', id: r.requester || 'worker' }, reason: r.reason, expiresAt: now() + (opts.approvalTtlMs ?? 60 * 60_000) });
        }
      }
    } catch (e) {
      return finish(aborted([{ code: 'ledger', reason: `suspension not recorded: ${(e as Error).message}`, hookId: 'invoke' }]));
    }
    return finish({ kind: 'suspended', request: pending.requests[0]!, resumeToken: token, run: { ...run, checkpointId: token } }, pending.requests);
  };

  /** Lift a Suspend with bound grants (one per request); reserve for the now-running operation. */
  const lift = async (c: Composed, resKey: string, spanId: string, stage: 'Send'): Promise<'lifted' | 'suspend' | AbortReason[]> => {
    const grants = opts.broker.takeGrants(c.suspend!.map((r) => r.actionHash));
    if (!grants) return 'suspend';
    try {
      await spans.evidence(`grant:${run.runId}:${spanId}`, 'approval.applied', { requestIds: grants.map((g) => g.requestId), actionHashes: c.suspend!.map((r) => r.actionHash) });
    } catch (e) {
      return [{ code: 'ledger', reason: `evidence not written: ${(e as Error).message}`, hookId: 'invoke' }];
    }
    const refused = await spans.reserve(resKey, spanId, stage, c);
    return refused.length ? refused : 'lifted';
  };

  const finishReturned = async (value: Json): Promise<SubInvokeResult> => {
    let out: JsonObject = { kind: 'returned', value };
    const c = await spans.emit('Invoke', 'Complete', invokeSpan, invokeInput, caps, { output: out });
    if (c.abort) return finish(aborted(c.abort.reasons));
    if (c.patchOutput.size) {
      out = applyPatches(out, c.patchOutput);
      const errs = validateSchema(out.value, opts.output);
      if (errs.length) return finish(aborted([{ code: 'schema', reason: `patched output violates the schema: ${errs.join('; ')}`, hookId: 'invoke' }]));
    }
    return finish({ kind: 'returned', value: out.value ?? null, run });
  };

  // ---- Invoke Enter / Send
  let c = await spans.emit('Invoke', 'Enter', invokeSpan, invokeInput, caps);
  if (c.abort) return finish(aborted(c.abort.reasons));
  if (c.restrict) caps = narrow(caps, c.restrict);
  if (c.patchInput.size) {
    for (const [path, value] of c.patchInput) {
      const m = /^inputs\.([A-Za-z_$][\w$]*)$/.exec(path);
      if (!m || isReserved(m[1]!)) return finish(aborted([{ code: 'conflict', reason: `Invoke PatchInput may only set inputs.<name> (got ${path})`, hookId: 'invoke' }]));
      st.inputs = { ...st.inputs, [m[1]!]: { kind: 'value', value, provenance: { src: 'hook', trust: 'trusted' } } };
    }
    invokeInput = { ...invokeInput, inputs: kinds() };
  }
  // Secret-bearing value inputs never reach the child (or the prompt): refuse, do not redact-and-continue.
  for (const [k, b] of Object.entries(st.inputs)) {
    if (b.kind !== 'value') continue;
    const hit = red.containsSecret(b.value);
    if (hit) return finish(aborted([{ code: 'policy', reason: `input ${k} carries secret material (${hit}); refused before it reaches the sandbox`, hookId: 'invoke' }]));
  }
  c = await spans.emit('Invoke', 'Send', invokeSpan, invokeInput, caps, { resKey: invokeSpan });
  if (c.abort) return finish(aborted(c.abort.reasons));
  if (c.suspend) {
    const l = await lift(c, invokeSpan, invokeSpan, 'Send');
    if (l === 'suspend') return suspend(c.suspend, { phase: 'turn' });
    if (l !== 'lifted') return finish(aborted(l));
  }
  if (c.replaceOutput !== undefined) {
    const errs = validateSchema(c.replaceOutput, opts.output);
    if (errs.length) return finish(aborted([{ code: 'schema', reason: `ReplaceOutput violates the schema: ${errs.join('; ')}`, hookId: 'invoke' }]));
    return finishReturned(c.replaceOutput);
  }

  return scope({ capabilities: caps }, async () => {
    // ---- one exec of a parsed program; returns an Outcome to stop, or null to take another turn
    const execProgram = async (code0: string, execNo: number): Promise<SubInvokeResult | null> => {
      const execSpan = `exec:${run.invokeId}:e${execNo}:g${st.generation}`;
      let code = code0;
      const input: JsonObject = { execNo, turn: st.turn, code, codeDigest: sha256(code) };
      let execCaps = caps;
      let execValues: Inputs = {};
      /** Exit for an exec that did not complete; returns the outcome to report (Exit failures override). */
      const exitWith = async (outcome: 'Aborted' | 'Suspended', then: () => Promise<SubInvokeResult>): Promise<SubInvokeResult> => {
        const settled = await spans.settle(execSpan);
        const x = await spans.emit('REPLExec', 'Exit', execSpan, input, execCaps, { outcome });
        const extra = [...settled, ...(x.abort?.reasons ?? [])];
        if (extra.length) return finish(aborted(extra));
        return then();
      };
      let ce = await spans.emit('REPLExec', 'Enter', execSpan, input, execCaps);
      if (ce.abort) return exitWith('Aborted', () => finish(aborted(ce.abort!.reasons)));
      if (ce.restrict) execCaps = narrow(execCaps, ce.restrict);
      if (ce.patchInput.size) {
        for (const [path, value] of ce.patchInput) {
          const m = /^inputs\.([A-Za-z_$][\w$]*)$/.exec(path);
          if (path === 'code') {
            if (typeof value !== 'string') return exitWith('Aborted', () => finish(aborted([{ code: 'conflict', reason: 'REPLExec PatchInput code must be a string', hookId: 'invoke' }])));
            const p = parseProgram(value);
            if (!p.ok) return exitWith('Aborted', () => finish(aborted([{ code: 'conflict', reason: `patched code refused: ${p.reason}`, hookId: 'invoke' }])));
            code = p.code;
            input.code = code;
            input.codeDigest = sha256(code);
          } else if (m && !isReserved(m[1]!)) {
            if (red.containsSecret(value)) return exitWith('Aborted', () => finish(aborted([{ code: 'policy', reason: `patched input ${m[1]} carries secret material`, hookId: 'invoke' }])));
            execValues = { ...execValues, [m[1]!]: { kind: 'value', value, provenance: { src: 'hook', trust: 'trusted' } } };
          } else {
            return exitWith('Aborted', () => finish(aborted([{ code: 'conflict', reason: `REPLExec PatchInput cannot be honoured at ${path} (only code and inputs.<name>)`, hookId: 'invoke' }])));
          }
        }
      }
      ce = await spans.emit('REPLExec', 'Send', execSpan, input, execCaps, { resKey: execSpan });
      if (ce.abort) return exitWith('Aborted', () => finish(aborted(ce.abort!.reasons)));
      if (ce.suspend) {
        const l = await lift(ce, execSpan, execSpan, 'Send');
        if (l === 'suspend') return exitWith('Suspended', () => suspend(ce.suspend!, { phase: 'exec', code, execNo }));
        if (l !== 'lifted') return exitWith('Aborted', () => finish(aborted(l)));
      }

      let res: ExecResult & { printed: string };
      if (ce.replaceOutput !== undefined) res = coerceExec(ce.replaceOutput);
      else {
        const ac = new AbortController();
        const onAbort = (): void => ac.abort();
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        if (opts.signal?.aborted) ac.abort();
        const canInvoke = run.depth + 1 < config.limits.depth;
        let bindings: Inputs;
        try {
          bindings = opts.broker.beginExec({
            execNo,
            invokeId: run.invokeId,
            capabilities: execCaps,
            spans,
            history: st.history,
            checkpoints: st.checkpoints,
            ...(canInvoke ? { subInvoke: (r: SubInvokeRequest) => subInvoke(r, execCaps) } : {}),
            onStop: () => ac.abort(),
          });
        } catch (e) {
          opts.signal?.removeEventListener('abort', onAbort);
          return exitWith('Aborted', () => finish(aborted([{ code: 'conflict', reason: `exec could not start: ${(e as Error).message}`, hookId: 'invoke' }])));
        }
        let report: ExecReport;
        let repl: Repl | undefined;
        try {
          repl = isFactory(opts.repl) ? opts.repl({ runId: run.runId, invokeId: run.invokeId, depth: run.depth, execNo, capabilities: execCaps, broker: opts.broker, callbacks: sandboxCallbacks(opts.broker) }) : opts.repl;
          const valueBindings = childBindings({ ...st.inputs, ...execValues }, red);
          res = await repl.exec({ execNo, code, bindings: { ...valueBindings, ...execBindings(st, run, execCaps, red), ...bindings }, timeoutMs: config.exec.timeoutMs }, opts.broker.bridge, ac.signal);
          if (!res || typeof res !== 'object' || typeof res.kind !== 'string') throw new InvokeError('REPL returned no result');
        } catch (e) {
          res = { kind: 'raise', exception: serr(e), printed: '' };
        } finally {
          // Drain every call the program started BEFORE anything is checkpointed or reported.
          report = await opts.broker.endExec();
          opts.signal?.removeEventListener('abort', onAbort);
          if (repl && isFactory(opts.repl)) await repl.dispose().catch(() => undefined);
        }
        // Quarantine dominates: no suspension checkpoint, no further turn.
        if (report.tainted || opts.broker.tainted) return exitWith('Aborted', () => finish(aborted(report.fatal ?? [])));
        if (report.fatal?.length) return exitWith('Aborted', () => finish(aborted(report.fatal!)));
        if (report.suspension) {
          const s = report.suspension;
          return exitWith('Suspended', () => suspend(s.requests, { phase: 'exec', code, execNo, ...(s.pending ? { toolRequest: s.pending } : {}), children: s.children }, s.childRequestIds));
        }
        if (res.kind === 'suspended') res = { kind: 'raise', exception: { name: 'SuspendError', message: 'the REPL reported a suspension the broker did not issue' }, printed: res.printed ?? '' };
        if (opts.signal?.aborted) return exitWith('Aborted', () => finish(aborted([{ code: 'cancelled', reason: 'invoke cancelled', hookId: 'signal' }])));
      }

      let output: JsonObject = {
        kind: res.kind,
        printed: truncate(red.redactText(res.printed ?? ''), config.protocol.maxOutputChars).text,
        ...(res.kind === 'return' ? { value: red.redactJson(res.value) } : {}),
        ...(res.kind === 'raise' || (res.kind === 'continue' && res.exception) ? { exception: red.redactJson(res.exception) } : {}),
      };
      ce = await spans.emit('REPLExec', 'Complete', execSpan, input, execCaps, { output });
      if (ce.abort) return exitWith('Aborted', () => finish(aborted(ce.abort!.reasons)));
      if (ce.patchOutput.size) output = applyPatches(output, ce.patchOutput);
      const settled = await spans.settle(execSpan);
      const cx = await spans.emit('REPLExec', 'Exit', execSpan, input, execCaps, { outcome: res.kind === 'raise' ? 'Failed' : 'Completed', output });
      const exitFail = [...settled, ...(cx.abort?.reasons ?? [])];
      if (exitFail.length) return finish(aborted(exitFail));

      const printed = typeof output.printed === 'string' ? output.printed : '';
      if (res.kind === 'return') {
        const value = (output.value ?? null) as Json;
        const errs = validateSchema(value, opts.output);
        if (errs.length) {
          st.history.push({ turn: st.turn, code, output: `${printed}${printed ? '\n' : ''}ReturnSchemaError: the return value does not match the output schema: ${errs.join('; ')}`, result: 'raise' });
          return null;
        }
        st.history.push({ turn: st.turn, code, output: printed, result: 'return' });
        return finishReturned(value);
      }
      const exc = (output.exception ?? undefined) as { name?: string; message?: string } | undefined;
      st.history.push({ turn: st.turn, code, output: `${printed}${exc ? `${printed ? '\n' : ''}${exc.name ?? 'Error'}: ${exc.message ?? ''}` : ''}`, result: res.kind });
      return null;
    };

    // ---- nested invoke from the program: narrow, never widen; depth + 1; same hooks; own REPL per exec
    const subInvoke = async (r: SubInvokeRequest, parentCaps: CapabilitySet): Promise<SubInvokeResult> => {
      const [rawInputs, rawOpts] = r.args;
      if (!rawInputs || typeof rawInputs !== 'object' || Array.isArray(rawInputs)) throw new SubInvokeDenied('invoke(inputs, opts): inputs must be an object');
      const o = (rawOpts && typeof rawOpts === 'object' && !Array.isArray(rawOpts) ? rawOpts : {}) as JsonObject;
      const unknown = Object.keys(o).filter((k) => k !== 'output' && k !== 'narrow');
      if (unknown.length) throw new SubInvokeDenied(`invoke options are {output, narrow: {tools, limits, depth}}; refusing unknown option(s) ${unknown.join(', ')} instead of ignoring them`);
      const requested = parseNarrow(o.narrow);
      if (widens(parentCaps, requested)) {
        await spans.evidence(`widen:${run.runId}:${r.spanId}`, 'capability.widen.refused', { requested: requested as unknown as Json, parentTools: parentCaps.tools, parentLimits: parentCaps.limits as unknown as Json });
        throw new SubInvokeDenied('sub-invoke requested capabilities beyond its parent: refused');
      }
      const childCaps = narrow(parentCaps, requested);
      const childInputs: Inputs = {};
      for (const [k, v] of Object.entries(rawInputs as JsonObject)) {
        if (isReserved(k) || !/^[A-Za-z_$][\w$]*$/.test(k)) throw new SubInvokeDenied(`binding ${k} is not allowed`);
        childInputs[k] = { kind: 'value', value: v, provenance: { src: `invoke:${run.invokeId}`, trust: 'untrusted' } };
      }
      const childOutput = o.output && typeof o.output === 'object' && !Array.isArray(o.output) ? (o.output as JsonObject) : {};
      const childId = `${run.invokeId}/e${r.execNo}c${r.callSeq}`;
      const argsDigest = digest(red.redactJson(r.args));
      // A child that already completed (before this parent suspended) is replayed, never re-run.
      const done = st.children.get(childId);
      if (done) {
        const why = done.argsDigest !== argsDigest ? 'its arguments changed since it completed' : await opts.broker.reauthorize(done.effects, childCaps);
        if (why) {
          await spans.evidence(`child-replay:${run.runId}:${childId}:g${st.generation}`, 'invoke.replay.refused', { childId, reason: why });
          throw new SubInvokeDenied(`completed sub-invoke ${childId} cannot be replayed (${why}); it is not run again`);
        }
        await spans.evidence(`child-replay:${run.runId}:${childId}:g${st.generation}`, 'invoke.replayed', { childId, effects: done.effects.length });
        return done.outcome as unknown as SubInvokeResult;
      }
      const record = (out: SubInvokeResult): SubInvokeResult => {
        // Record every completion, live or late: its effects happened and must never be repeated.
        if (out.kind !== 'suspended') st.children.set(childId, { invokeId: childId, argsDigest, outcome: red.redactJson(strip(out)), effects: opts.broker.effectsOf(childId) });
        return out;
      };
      const childRun: RunRef = { runId: run.runId, invokeId: childId, depth: run.depth + 1, parentInvokeId: run.invokeId };
      const signal = opts.signal ? AbortSignal.any([r.signal, opts.signal]) : r.signal;
      const childOpts: Internal = { ...opts, output: childOutput, run: childRun, broker: opts.broker.child(childCaps), capabilities: childCaps, dispatcher, signal, red };
      delete childOpts.checkpointExtra;
      delete childOpts.resumeChildren;
      const token = opts.resumeChildren?.get(childId);
      if (token) {
        opts.resumeChildren!.delete(childId);
        const cp = await loadInvokeCheckpoint(token, opts.ledger).catch(() => null);
        if (!cp || (cp.run as unknown as RunRef)?.invokeId !== childId) return sanitizeOutcome({ kind: 'failed', error: { name: 'ResumeError', message: `no checkpoint for suspended sub-invoke ${childId}` }, run: childRun }, red);
        return record(await scope({ capabilities: childCaps }, () => resumeFromCheckpoint(cp, token, childOpts)));
      }
      return record(await scope({ capabilities: childCaps }, () => runInvoke({ inputs: childInputs, history: new History([], red), turn: 0, checkpoints: new Map(), generation: 1, children: new Map() }, childOpts)));
    };

    if (rerun) {
      const r = await execProgram(rerun.code, rerun.execNo);
      if (r) return r;
    }

    const backstop = config.limits.iterations;
    const retries = opts.llmRetries ?? 2;
    for (;;) {
      if (opts.signal?.aborted) return finish(aborted([{ code: 'cancelled', reason: 'invoke cancelled', hookId: 'signal' }]));
      if (st.turn >= backstop) return finish(aborted([{ code: 'iterations', reason: `iteration backstop ${backstop} reached`, hookId: 'invoke' }]));
      st.turn++;
      const llmSpan = `llm:${run.invokeId}:t${st.turn}:g${st.generation}`;
      let messages = buildMessages(st, opts, config, caps, run);
      let input: JsonObject = { seatId: config.seatId, model: llm.model ?? llm.id, turn: st.turn, messages: messages as unknown as Json };
      const resKeys: string[] = [];
      const llmExit = async (outcome: 'Aborted' | 'Suspended' | 'Failed', then: () => Promise<SubInvokeResult>): Promise<SubInvokeResult> => {
        const settled: AbortReason[] = [];
        for (const k of resKeys) settled.push(...(await spans.settle(k)));
        const x = await spans.emit('LLMQuery', 'Exit', llmSpan, input, caps, { outcome });
        const extra = [...settled, ...(x.abort?.reasons ?? [])];
        if (extra.length) return finish(aborted(extra));
        return then();
      };
      let cl = await spans.emit('LLMQuery', 'Enter', llmSpan, input, caps);
      if (cl.abort) return llmExit('Aborted', () => finish(aborted(cl.abort!.reasons)));
      if (cl.restrict) {
        caps = narrow(caps, cl.restrict);
        messages = buildMessages(st, opts, config, caps, run);
        input = { ...input, messages: messages as unknown as Json };
      }
      if (cl.patchInput.size) input = applyPatches(input, cl.patchInput);
      let attempt = 1;
      const resKey = (a: number): string => `${llmSpan}#${a}`;
      resKeys.push(resKey(1));
      cl = await spans.emit('LLMQuery', 'Send', llmSpan, input, caps, { attempt, resKey: resKey(1) });
      if (cl.abort) return llmExit('Aborted', () => finish(aborted(cl.abort!.reasons)));
      if (cl.suspend) {
        const l = await lift(cl, resKey(1), llmSpan, 'Send');
        if (l === 'suspend') {
          st.turn--;
          return llmExit('Suspended', () => suspend(cl.suspend!, { phase: 'turn' }));
        }
        if (l !== 'lifted') return llmExit('Aborted', () => finish(aborted(l)));
      }
      let resp: LLMResponse;
      if (cl.replaceOutput !== undefined) {
        const v = cl.replaceOutput;
        const content = typeof v === 'string' ? v : v && typeof v === 'object' && !Array.isArray(v) && typeof v.content === 'string' ? v.content : JSON.stringify(v);
        resp = { content, usage: { inputTokens: 0, outputTokens: 0, usd: 0 }, model: 'hook', finishReason: 'stop' };
        const f = await spans.settle(resKey(1), { usd: 0, tokens: 0, calls: 0 });
        if (f.length) return llmExit('Aborted', () => finish(aborted(f)));
      } else {
        const req = { seatId: config.seatId, model: llm.model ?? llm.id, messages: requestMessages(input, messages), maxTokens: opts.maxTokens ?? 4096 };
        for (;;) {
          try {
            resp = await llm.complete(req, opts.signal);
            if (!resp || typeof resp.content !== 'string' || resp.finishReason === 'error') throw new InvokeError(`LLM returned an error response${resp?.error ? `: ${resp.error}` : ''}`);
            break;
          } catch (e) {
            // A failed physical attempt is charged at its reservation.
            const f = await spans.settle(resKey(attempt));
            if (f.length) return llmExit('Aborted', () => finish(aborted(f)));
            if (opts.signal?.aborted) return llmExit('Aborted', () => finish(aborted([{ code: 'cancelled', reason: 'invoke cancelled', hookId: 'signal' }])));
            if (attempt > retries) return llmExit('Failed', () => finish({ kind: 'failed', error: { name: 'LLMError', message: red.redactText((e as Error)?.message ?? 'LLM failed') }, run }));
            attempt++;
            const cr = await spans.emit('LLMQuery', 'Retry', llmSpan, { ...input, error: red.redactText((e as Error)?.message ?? 'error'), retry: attempt }, caps, { attempt });
            if (cr.abort) return llmExit('Aborted', () => finish(aborted(cr.abort!.reasons)));
            // Every physical retry is a new request: it goes through Send (and its reservation) again.
            resKeys.push(resKey(attempt));
            const cs = await spans.emit('LLMQuery', 'Send', llmSpan, input, caps, { attempt, resKey: resKey(attempt) });
            if (cs.abort) return llmExit('Aborted', () => finish(aborted(cs.abort!.reasons)));
            if (cs.suspend) {
              const l = await lift(cs, resKey(attempt), llmSpan, 'Send');
              if (l === 'suspend') {
                st.turn--;
                return llmExit('Suspended', () => suspend(cs.suspend!, { phase: 'turn' }));
              }
              if (l !== 'lifted') return llmExit('Aborted', () => finish(aborted(l)));
            }
          }
        }
        const f = await spans.settle(resKey(attempt), { usd: resp.usage?.usd ?? 0, tokens: (resp.usage?.inputTokens ?? 0) + (resp.usage?.outputTokens ?? 0), calls: 1 });
        if (f.length) return llmExit('Aborted', () => finish(aborted(f)));
      }
      let output: JsonObject = { content: resp.content, usage: resp.usage as unknown as Json, model: resp.model, finishReason: resp.finishReason };
      cl = await spans.emit('LLMQuery', 'Complete', llmSpan, input, caps, { output, attempt });
      if (cl.abort) return llmExit('Aborted', () => finish(aborted(cl.abort!.reasons)));
      if (cl.patchOutput.size) output = applyPatches(output, cl.patchOutput);
      const lx = await spans.emit('LLMQuery', 'Exit', llmSpan, input, caps, { outcome: 'Completed', output, attempt });
      if (lx.abort) return finish(aborted(lx.abort.reasons));

      const content = typeof output.content === 'string' ? output.content : '';
      const parsed = parseProgram(content);
      if (!parsed.ok) {
        st.history.push({ turn: st.turn, code: truncate(red.redactText(content), 2000).text, output: `ParseError: ${parsed.reason}. Reply with exactly one \`\`\`js block containing a function body.`, result: 'raise' });
        continue;
      }
      const r = await execProgram(parsed.code, opts.broker.nextExecNo());
      if (r) return r;
    }
  });
}

/** requestApproval, tolerating only an exact duplicate of a still-pending request (crash between writes). */
async function requestOnce(ledger: Ledger, r: Parameters<Ledger['requestApproval']>[0]): Promise<void> {
  try {
    await ledger.requestApproval(r);
  } catch (e) {
    const view = typeof ledger.getApproval === 'function' ? await ledger.getApproval(r.requestId).catch(() => null) : null;
    if (view && view.state === 'pending' && view.actionHash === r.actionHash && view.sessionId === r.sessionId && view.runId === r.runId) return;
    throw e;
  }
}

// ---------------------------------------------------------------- helpers

function childRecords(v: Json | undefined): ChildRecord[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown as ChildRecord[]).filter((c) => c && typeof c === 'object' && typeof c.invokeId === 'string' && typeof c.argsDigest === 'string' && Array.isArray(c.effects) && c.outcome && typeof c.outcome === 'object');
}

function parseNarrow(v: Json | undefined): Partial<CapabilitySet> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new SubInvokeDenied('narrow must be an object {tools?, limits?, depth?}');
  const o = v as JsonObject;
  const unknown = Object.keys(o).filter((k) => !['tools', 'limits', 'depth', 'paths'].includes(k));
  if (unknown.length) throw new SubInvokeDenied(`unknown narrow option(s): ${unknown.join(', ')}`);
  const out: Partial<CapabilitySet> = {};
  if (o.tools !== undefined) {
    if (!Array.isArray(o.tools) || !o.tools.every((t) => typeof t === 'string')) throw new SubInvokeDenied('narrow.tools must be a list of tool names');
    out.tools = o.tools as string[];
  }
  const l: Partial<Limits> = {};
  if (o.limits !== undefined) {
    if (!o.limits || typeof o.limits !== 'object' || Array.isArray(o.limits)) throw new SubInvokeDenied('narrow.limits must be an object');
    for (const [k, x] of Object.entries(o.limits)) {
      if (!(k in DEFAULT_CONFIG.limits) || typeof x !== 'number' || !Number.isFinite(x)) throw new SubInvokeDenied(`unknown or invalid limit ${k}`);
      l[k as keyof Limits] = x;
    }
  }
  if (o.depth !== undefined) {
    if (typeof o.depth !== 'number' || !Number.isFinite(o.depth)) throw new SubInvokeDenied('narrow.depth must be a number');
    l.depth = Math.min(l.depth ?? Infinity, o.depth);
  }
  if (Object.keys(l).length) out.limits = l as Limits;
  if (o.paths !== undefined) {
    if (!o.paths || typeof o.paths !== 'object' || Array.isArray(o.paths)) throw new SubInvokeDenied('narrow.paths must be an object');
    const p = o.paths as JsonObject;
    const list = (x: Json | undefined): string[] | undefined => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : undefined);
    const paths: Partial<CapabilitySet['paths']> = { protected: list(p.protected) ?? [] };
    if (list(p.read)) paths.read = list(p.read)!;
    if (list(p.write)) paths.write = list(p.write)!;
    out.paths = paths as CapabilitySet['paths'];
  }
  return out;
}

function capsSummary(caps: CapabilitySet): Json {
  return { tools: caps.tools, write: caps.paths.write, protected: caps.paths.protected, limits: caps.limits as unknown as Json };
}

/** Value bindings for the child: hidden bindings never leave the supervisor; values are redacted once more. */
function childBindings(inputs: Inputs, red: Redactor): Inputs {
  const out: Inputs = {};
  for (const [k, b] of Object.entries(inputs)) {
    if (b.kind === 'hidden') continue;
    out[k] = b.kind === 'value' ? { kind: 'value', value: red.redactJson(b.value), provenance: red.redactJson(b.provenance) as unknown as Provenance } : b;
  }
  return out;
}

function execBindings(st: State, run: RunRef, caps: CapabilitySet, red: Redactor): Inputs {
  return {
    checkpoints: { kind: 'value', value: red.redactJson(Object.fromEntries(st.checkpoints)), provenance: { src: 'checkpoint', trust: 'untrusted' } },
    __depth__: { kind: 'value', value: run.depth, provenance: { src: 'system', trust: 'trusted' } },
    __capabilities__: { kind: 'value', value: capsSummary(caps), provenance: { src: 'system', trust: 'trusted' } },
  };
}

function coerceExec(v: Json): ExecResult & { printed: string } {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as JsonObject;
    const printed = typeof o.printed === 'string' ? o.printed : '';
    if (o.kind === 'return') return { kind: 'return', value: (o.value ?? null) as Json, output: printed, printed };
    if (o.kind === 'continue') return { kind: 'continue', output: printed, printed };
    if (o.kind === 'raise') return { kind: 'raise', exception: { name: 'Error', message: String((o.exception as JsonObject | undefined)?.message ?? 'raised') }, printed };
  }
  return { kind: 'return', value: v, output: '', printed: '' };
}

function requestMessages(input: JsonObject, fallback: LLMMessage[]): LLMMessage[] {
  const raw = input.messages;
  const ok = Array.isArray(raw) && raw.every((m) => m && typeof m === 'object' && !Array.isArray(m) && typeof (m as JsonObject).content === 'string' && ['system', 'user', 'assistant'].includes((m as JsonObject).role as string));
  const msgs = ok ? (raw as unknown as LLMMessage[]).map((m) => ({ ...m })) : fallback.map((m) => ({ ...m }));
  if (typeof input.nudge === 'string' && msgs.length) {
    const last = msgs[msgs.length - 1]!;
    if (last.role === 'user') last.content += `\n\n[harness] ${input.nudge}`;
    else msgs.push({ role: 'user', content: `[harness] ${input.nudge}` });
  }
  return msgs;
}

function stubsFor(broker: Broker, caps: CapabilitySet): StubDoc[] {
  return broker
    .toolNames()
    .filter((t) => caps.tools.includes(t))
    .map((t) => STANDARD_STUBS[t] ?? { binding: broker.stubName(t), tool: t, signature: `await ${broker.stubName(t)}(...args)`, description: `tool ${t}` });
}

/** System + task prefix, then as many of the newest turns as fit; older turns stay behind __history__. */
function buildMessages(st: State, opts: Internal, config: WorkerConfig, caps: CapabilitySet, run: RunRef): LLMMessage[] {
  const red = opts.red;
  const nonce = newNonce();
  const budget = opts.modelBudgetChars ?? SERIALIZER_LIMITS.modelBudgetChars;
  const system = red.redactText(workerSystemPrompt({ stubs: stubsFor(opts.broker, caps), outputSchema: opts.output, maxIterations: config.limits.iterations, depth: run.depth, canInvoke: run.depth + 1 < config.limits.depth }));
  const promptInputs: Inputs = {
    ...st.inputs,
    __history__: { kind: 'handle', id: '__history__', methods: [...HISTORY_METHODS], description: `${st.history.len()} earlier turns of this step` },
    __depth__: { kind: 'value', value: run.depth, provenance: { src: 'system', trust: 'trusted' } },
    __capabilities__: { kind: 'value', value: capsSummary(caps), provenance: { src: 'system', trust: 'trusted' } },
    ...(st.checkpoints.size ? { checkpoints: { kind: 'value', value: Object.fromEntries(st.checkpoints), provenance: { src: 'checkpoint', trust: 'untrusted' } } } : {}),
  };
  const ser = serializeInputs(promptInputs, { nonce, perValueChars: config.protocol.maxInputChars, modelBudgetChars: budget, prefixRatio: config.protocol.prefixRatio, redactor: red });
  const pairs: LLMMessage[][] = [];
  let used = system.length + ser.chars + 400;
  const all = st.history.all();
  let omitted = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i]!;
    const a = red.redactText(`\`\`\`js\n${truncate(red.redactText(e.code), config.protocol.maxOutputChars).text}\n\`\`\``);
    const u = red.redactText(`Result of turn ${e.turn} (${e.result}):\n${wrapUntrusted(truncate(red.redactText(e.output), config.protocol.maxOutputChars).text, 'repl', nonce, red)}`);
    if (used + a.length + u.length > budget) {
      omitted = i + 1;
      break;
    }
    used += a.length + u.length;
    pairs.unshift([{ role: 'assistant', content: a }, { role: 'user', content: u }]);
  }
  const notes = omitted ? [`${omitted} earlier turn(s) are not shown; read them with __history__.slice(start, end) or __history__.search(text).`] : [];
  return [{ role: 'system', content: system }, { role: 'user', content: renderTask(ser.text, notes) }, ...pairs.flat()];
}
