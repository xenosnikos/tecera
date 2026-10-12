import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  capabilityInventoryOf,
  effectiveStepTools,
  narrow,
  requireListEvidence,
  RESERVED_BINDINGS,
  type ApprovalGrant,
  type CapabilityMockedPayload,
  type CapabilityRecord,
  type CapabilitySet,
  type Hook,
  type Inputs,
  type JsonObject,
  type Ledger,
  type LLM,
  type MockToolDeclaration,
  type Outcome,
  type Repl,
  type RunRef,
  type SecretInput,
  type TeceraEvent,
  type Tool,
  type VerifyRunner,
  type Worker,
  type WorkerStepRequest,
  type WriteGuard,
} from '@tecera/contracts';
import type { ConfigOverride } from '../config.js';
import { Broker, type SimulatedUse } from '../broker/broker.js';
import { MockRegistrationError, type StandIn } from '../mocks/admit.js';
import { standInFor } from '../mocks/standins.js';
import { redactorFor } from '../protocol/serializer.js';
import { createRunVerifyTool } from '../tools/runVerify.js';
import { worktreeTaint } from '../tools/paths.js';
import { invoke, loadInvokeCheckpoint, nextPendingRequest, resume, sanitizeOutcome, type ReplContext, type ReplFactory } from './invoke.js';
import type { TraceEntry } from './span.js';

export type { ReplContext, ReplFactory } from './invoke.js';

/**
 * StepWorker: the Worker port over invoke. One run = one root invoke at depth 0 for one plan step: the
 * LLM is the seat the loop routed to, the output schema is the step's, capabilities are the request's
 * narrowed by effectiveStepTools(plan, step) (the broker, the hooks and the tools all see the same set).
 *
 * Worktree and lease come from the request (contracts WorkerStepRequest): worktree '' makes every file
 * and verify tool refuse; an absent fencingToken makes writes refuse. A REPL factory is called per exec of
 * every invoke (root and nested) so the sandbox's host callbacks are bound to that invoke's broker.
 *
 * Suspension and resume: a suspended outcome carries a resume token; the loop persists it in
 * Intention.resumeToken / heldRequestId. If the loop re-dispatches a held step (run() with an intention
 * that already has a resumeToken), the worker does NOT start the step again: it answers with the same
 * suspension (or fails closed when the checkpoint is gone). resume(token, grant) verifies and consumes the
 * grant (the worker owns consumption), binds it to exactly one pending request, and continues.
 *
 * Quarantine: a step whose invoke tree was tainted (an unresolved writer at drain timeout, or an
 * unverifiable commit) returns `aborted` with a `tainted:` reason and a `tainted` field, never `returned`
 * or `suspended`. The worktree is in the taint registry: run() and resume() refuse it from then on, and
 * the caller must not checkpoint, gate or reuse it (see TaintedOutcome). The quarantine is DURABLE: the
 * broker records `exec.tainted` evidence in the ledger, and run()/resume() look it up (Ledger.listEvidence)
 * before anything starts, so a restarted process refuses a worktree an earlier process quarantined (an
 * orphan writer may still be running in it). A ledger that cannot enumerate evidence refuses (fail closed).
 *
 * Write fence: WorkerStepRequest.guard (run) and resume()'s guard are handed to the broker, which gives
 * every tool call an exec guard and ToolContext.fence. No guard = every write refused.
 *
 * Stand-ins (WorkerStepRequest.mocks): each declaration gets a host-side stand-in (options.standIns, default
 * the generic store / message sink of mocks/standins.ts), admitted by the broker against the capability
 * inventory (options.inventory, else capabilityInventoryOf over the ledger's events; neither → refused).
 * A refused stand-in aborts the step (code 'policy') before anything runs. A stand-in serves only when its
 * tool is in the step's capabilities, like any tool. The declarations are checkpointed so resume() serves
 * the same stand-ins (the same in-memory instance within this process). An outcome whose tree used a
 * stand-in carries `simulated` (SimulatedOutcome): whatever it returns may rest on simulated data.
 */

export interface StepWorkerOptions {
  seats: Record<string, LLM>;
  /** A REPL factory (production: ChildProcessRepl per exec) or a shared in-process test double. */
  repl: Repl | ReplFactory;
  tools: Tool[];
  hooks: Hook[];
  ledger?: Ledger;
  /** When given and no runVerify tool is supplied, a runVerify tool bound to the goal's check is added. */
  verifyRunner?: VerifyRunner;
  /**
   * Current lease of a run, used ONLY by resume() (which gets no request). Absent → the checkpointed
   * worktree is reused and the fencing token is absent, so writes after resume are refused (fail closed).
   */
  resumeLease?: (runId: string) => { worktree: string; fencingToken?: number } | undefined;
  sessionId?: string;
  secrets?: readonly SecretInput[];
  config?: ConfigOverride;
  envAllowlist?: string[];
  /** Consume grants in the ledger on resume (default true: the worker owns consumption). */
  consumeGrants?: boolean;
  now?: () => number;
  ids?: () => string;
  trace?: TraceEntry[];
  /** Host-side stand-in for a mock declaration (default standInFor). Throw to refuse one. */
  standIns?: (decl: MockToolDeclaration) => Tool;
  /** The run's capability inventory the stand-ins are admitted against (default: projected from the ledger). */
  inventory?: (runId: string) => readonly CapabilityRecord[] | Promise<readonly CapabilityRecord[]>;
  /** Manifest connections by capability id (`mockable: false` refuses a stand-in). */
  connections?: Readonly<Record<string, { mockable?: boolean }>>;
  /** The host's record of a stand-in's first use (it appends the `capability.mocked` event). A throw refuses the call. */
  onMocked?: (runId: string, p: CapabilityMockedPayload) => void | Promise<void>;
}

/** An outcome of a step whose invoke tree used a stand-in: everything it returns may rest on simulated data. */
export type SimulatedOutcome = Outcome & { simulated?: SimulatedUse };

/** What stand-ins a step's outcome rests on, or null when none served it. */
export function simulationOf(o: Outcome | null | undefined): SimulatedUse | null {
  const s = (o as SimulatedOutcome | null | undefined)?.simulated;
  return s && Array.isArray(s.mockIds) && s.mockIds.length > 0 ? s : null;
}

interface BrokerArgs {
  runId: string;
  capabilities: CapabilitySet;
  worktree: string;
  fencingToken: number | undefined;
  check: { command: string; timeoutSec: number } | undefined;
  guard: WriteGuard | undefined;
}

interface StepExtra {
  seatId: string;
  capabilities: CapabilitySet;
  runId: string;
  worktree: string;
  check: { command: string; timeoutSec: number };
  stepId: string;
  planId: string;
  intentionId: string;
  attempt: number;
  mocks?: MockToolDeclaration[];
}

export class StepWorker implements Worker {
  /** Stand-in instances by run and mock id, so a resumed step is served by the same in-memory state. */
  private readonly standInCache = new Map<string, Tool>();

  constructor(private readonly o: StepWorkerOptions) {}

  /** Stand-ins and the inventory to admit them against; a factory refusal is returned as a problem. */
  private async standIns(runId: string, mocks: readonly MockToolDeclaration[] | undefined): Promise<{ standIns: StandIn[]; inventory?: readonly CapabilityRecord[] } | { problem: string }> {
    if (!mocks || mocks.length === 0) return { standIns: [] };
    let inventory: readonly CapabilityRecord[] | undefined;
    try {
      if (this.o.inventory) inventory = await this.o.inventory(runId);
      else if (this.o.ledger) {
        const events: TeceraEvent[] = [];
        for await (const e of this.o.ledger.events()) events.push(e);
        inventory = capabilityInventoryOf(events).records;
      }
    } catch (e) {
      return { problem: `the capability inventory cannot be read (${(e as Error)?.message ?? 'error'}); stand-ins are refused` };
    }
    const standIns: StandIn[] = [];
    for (const d of mocks) {
      const key = `${runId}\0${String(d?.mockId)}`;
      let tool = this.standInCache.get(key);
      if (!tool) {
        try {
          tool = (this.o.standIns ?? standInFor)(d);
        } catch (e) {
          return { problem: `no stand-in for ${String(d?.capability)}: ${(e as Error)?.message ?? 'refused'}` };
        }
        this.standInCache.set(key, tool);
      }
      standIns.push({ declaration: d, tool });
    }
    return { standIns, ...(inventory ? { inventory } : {}) };
  }

  private toolsFor(check: { command: string; timeoutSec: number } | undefined): Tool[] {
    const tools = [...this.o.tools];
    if (this.o.verifyRunner && check && !tools.some((t) => t.name === 'runVerify')) {
      tools.push(createRunVerifyTool({ runner: this.o.verifyRunner, command: check.command, timeoutSec: check.timeoutSec, ...(this.o.envAllowlist ? { envAllowlist: this.o.envAllowlist } : {}) }));
    }
    return tools;
  }

  private broker({ runId, capabilities, worktree, fencingToken, check, guard }: BrokerArgs, mocks: { standIns: StandIn[]; inventory?: readonly CapabilityRecord[] }): Broker {
    const onMocked = this.o.onMocked;
    return new Broker({
      tools: this.toolsFor(check),
      runId,
      worktree,
      capabilities,
      redactor: redactorFor(this.o.secrets ?? []),
      ...(typeof fencingToken === 'number' && Number.isFinite(fencingToken) ? { fencingToken } : {}),
      ...(guard ? { guard } : {}),
      ...(mocks.standIns.length ? { standIns: mocks.standIns } : {}),
      ...(mocks.inventory ? { inventory: mocks.inventory } : {}),
      ...(this.o.connections ? { connections: this.o.connections } : {}),
      ...(onMocked ? { onMocked: (p: CapabilityMockedPayload) => onMocked(runId, p) } : {}),
    });
  }

  /** The broker, or the step's refusal when a stand-in is not admitted. */
  private async brokerOrRefusal(run: RunRef, b: BrokerArgs, mocks: readonly MockToolDeclaration[] | undefined): Promise<Broker | Outcome> {
    const m = await this.standIns(b.runId, mocks);
    if ('problem' in m) return { kind: 'aborted', reasons: [{ code: 'policy', reason: m.problem, hookId: 'stepWorker' }], run };
    try {
      return this.broker(b, m);
    } catch (e) {
      if (e instanceof MockRegistrationError) return { kind: 'aborted', reasons: [{ code: 'policy', reason: e.message, hookId: 'stepWorker' }], run };
      throw e;
    }
  }

  /**
   * Why this worktree is quarantined for the run: the in-process registry, or `exec.tainted` evidence the
   * ledger holds for the run (a quarantine recorded by an earlier process). null = clean.
   */
  private async quarantineOf(runId: string, worktree: string): Promise<string | null> {
    const local = worktreeTaint(worktree);
    if (local !== null) return local;
    if (!this.o.ledger || !worktree) return null;
    let rows;
    try {
      rows = await requireListEvidence(this.o.ledger, runId, 'exec.tainted');
    } catch (e) {
      return `the ledger cannot show whether this worktree was quarantined (${(e as Error)?.message ?? 'listEvidence failed'}); refusing to run on it`;
    }
    const mine = keysOf(worktree);
    for (const r of rows) {
      if (r.kind !== 'exec.tainted') continue;
      const body = (r.body ?? {}) as { worktree?: unknown; reason?: unknown };
      if (typeof body.worktree !== 'string' || !body.worktree) continue;
      if (keysOf(body.worktree).some((k) => mine.includes(k))) return `recorded by an earlier exec: ${typeof body.reason === 'string' ? body.reason : 'tainted'}`;
    }
    return null;
  }

  async run(req: WorkerStepRequest, signal?: AbortSignal): Promise<Outcome> {
    const invokeId = this.o.ids?.() ?? `inv_${randomUUID()}`;
    const run: RunRef = { runId: req.runId, invokeId, depth: 0 };
    const llm = this.o.seats[req.seatId];
    if (!llm) return { kind: 'failed', error: { name: 'SeatError', message: `no LLM for seat ${req.seatId}` }, run };
    if (req.step.kind !== 'worker') return { kind: 'failed', error: { name: 'StepError', message: `step ${req.step.id} is ${req.step.kind}, not a worker step` }, run };
    let red;
    try {
      red = redactorFor(this.o.secrets ?? []);
    } catch (e) {
      return { kind: 'failed', error: { name: 'RedactionError', message: (e as Error).message }, run };
    }
    if (req.intention.resumeToken) return this.redispatch(req, run);
    const worktreeIn = typeof req.worktree === 'string' ? req.worktree : '';
    const taint = await this.quarantineOf(req.runId, worktreeIn);
    if (taint !== null) return sanitizeOutcome(quarantined(run, worktreeIn, taint), red);
    for (const k of Object.keys(req.inputs ?? {})) {
      if ((RESERVED_BINDINGS as readonly string[]).includes(k)) return { kind: 'aborted', reasons: [{ code: 'policy', reason: `binding ${k} is reserved`, hookId: 'stepWorker' }], run };
    }
    // Per-step narrowing: the step's own tool list (contracts effectiveStepTools) on top of the request's set.
    const stepTools = effectiveStepTools(req.plan, req.step);
    const capabilities = narrow(req.capabilities, { tools: req.capabilities.tools.filter((t) => stepTools.includes(t)) });
    const inputs: Inputs = {
      goal: { kind: 'value', value: { id: req.goal.id, statement: req.goal.statement, check: req.goal.check.command }, provenance: { src: 'goal', trust: 'trusted' } },
      step: { kind: 'value', value: { id: req.step.id, kind: req.step.kind, instruction: req.step.instruction ?? '', inputs: req.step.inputs, output: req.step.output ?? null }, provenance: { src: 'plan', trust: 'trusted' } },
      ...(req.inputs ?? {}),
    };
    const output: JsonObject = req.step.output ?? { type: 'object' };
    const check = { command: req.goal.check.command, timeoutSec: req.goal.check.timeoutSec };
    const worktree = typeof req.worktree === 'string' ? req.worktree : '';
    const mocks = Array.isArray(req.mocks) && req.mocks.length ? structuredClone([...req.mocks]) : undefined;
    const extra: StepExtra = { seatId: req.seatId, capabilities, runId: req.runId, worktree, check, stepId: req.step.id, planId: req.plan.id, intentionId: req.intention.id, attempt: req.intention.attempt, ...(mocks ? { mocks } : {}) };
    const broker = await this.brokerOrRefusal(run, { runId: req.runId, capabilities, worktree, fencingToken: req.fencingToken, check, guard: req.guard }, mocks);
    if (!(broker instanceof Broker)) return sanitizeOutcome(broker, red);
    const out = await invoke(inputs, {
      output,
      hooks: this.o.hooks,
      llm,
      llms: this.o.seats,
      repl: this.o.repl,
      broker,
      ...(this.o.ledger ? { ledger: this.o.ledger } : {}),
      run,
      ...(signal ? { signal } : {}),
      capabilities,
      ...(this.o.secrets ? { secrets: this.o.secrets } : {}),
      ...(this.o.sessionId ? { sessionId: this.o.sessionId } : {}),
      ...(this.o.now ? { now: this.o.now } : {}),
      ...(this.o.trace ? { trace: this.o.trace } : {}),
      config: { ...(this.o.config ?? {}), seatId: req.seatId },
      checkpointExtra: extra as unknown as JsonObject,
    });
    return withSimulation(sanitizeOutcome(out, red), broker);
  }

  /** A held step dispatched again: answer with its existing suspension, never start it a second time. */
  private async redispatch(req: WorkerStepRequest, run: RunRef): Promise<Outcome> {
    const token = req.intention.resumeToken!;
    const cp = await loadInvokeCheckpoint(token, this.o.ledger).catch(() => null);
    const extra = (cp?.extra ?? null) as Partial<StepExtra> | null;
    const fail = (message: string): Outcome => ({ kind: 'failed', error: { name: 'ResumeError', message }, run: { ...run, checkpointId: token } });
    if (!cp || !extra) return fail('the step is held but its checkpoint is missing; refusing to run it again');
    if (extra.runId !== req.runId || extra.intentionId !== req.intention.id || extra.stepId !== req.step.id) return fail('the resume token belongs to another step');
    const next = nextPendingRequest(cp);
    if (!next) return fail('the held step has no pending approval request');
    if (req.intention.heldRequestId && req.intention.heldRequestId !== next.requestId && !(cp.pending as { requests?: Array<{ requestId: string }> }).requests?.some((r) => r.requestId === req.intention.heldRequestId)) {
      return fail('the held request does not belong to this checkpoint');
    }
    return { kind: 'suspended', request: next, resumeToken: token, run: { ...(cp.run as unknown as RunRef), checkpointId: token } };
  }

  async resume(resumeToken: string, grant: ApprovalGrant, signal?: AbortSignal, guard?: WriteGuard): Promise<Outcome> {
    const cp = await loadInvokeCheckpoint(resumeToken, this.o.ledger).catch(() => null);
    const extra = (cp?.extra ?? null) as Partial<StepExtra> | null;
    const fallback = { runId: extra?.runId ?? 'unknown', invokeId: 'unknown', depth: 0, checkpointId: resumeToken };
    if (!cp || !extra?.seatId || !extra.capabilities || !extra.runId || !extra.check) return { kind: 'failed', error: { name: 'ResumeError', message: 'no resumable step checkpoint for this token' }, run: fallback };
    const llm = this.o.seats[extra.seatId];
    if (!llm) return { kind: 'failed', error: { name: 'SeatError', message: `no LLM for seat ${extra.seatId}` }, run: fallback };
    let red;
    try {
      red = redactorFor(this.o.secrets ?? []);
    } catch (e) {
      return { kind: 'failed', error: { name: 'RedactionError', message: (e as Error).message }, run: fallback };
    }
    const lease = this.o.resumeLease?.(extra.runId);
    const worktree = lease ? lease.worktree : (extra.worktree ?? '');
    const taint = await this.quarantineOf(extra.runId, worktree);
    if (taint !== null) return sanitizeOutcome(quarantined(fallback, worktree, taint), red);
    const broker = await this.brokerOrRefusal(fallback, { runId: extra.runId, capabilities: extra.capabilities, worktree, fencingToken: lease?.fencingToken, check: extra.check, guard }, extra.mocks);
    if (!(broker instanceof Broker)) return sanitizeOutcome(broker, red);
    const out = await resume(resumeToken, grant, {
      hooks: this.o.hooks,
      llm,
      llms: this.o.seats,
      repl: this.o.repl,
      broker,
      ...(this.o.ledger ? { ledger: this.o.ledger } : {}),
      capabilities: extra.capabilities,
      ...(signal ? { signal } : {}),
      ...(this.o.secrets ? { secrets: this.o.secrets } : {}),
      ...(this.o.sessionId ? { sessionId: this.o.sessionId } : {}),
      ...(this.o.now ? { now: this.o.now } : {}),
      ...(this.o.trace ? { trace: this.o.trace } : {}),
      consume: this.o.consumeGrants !== false,
    });
    return withSimulation(sanitizeOutcome(out, red), broker);
  }
}

/** The outcome, marked `simulated` when its invoke tree used a stand-in. */
function withSimulation(o: Outcome, broker: Broker): Outcome {
  const uses = broker.simulatedUses();
  return uses.mockIds.length ? ({ ...o, simulated: uses } as SimulatedOutcome) : o;
}

/** Lexical and real path of a worktree (the real one may be gone). */
function keysOf(p: string): string[] {
  const out = new Set<string>([resolve(p)]);
  try {
    out.add(realpathSync(p));
  } catch {
    /* gone: the lexical key still matches */
  }
  return [...out];
}

/** The outcome for a step refused because its worktree is quarantined. */
function quarantined(run: RunRef, worktree: string, reason: string): Outcome {
  return { kind: 'aborted', reasons: [{ code: 'cancelled', reason: `tainted: the worktree is quarantined (${reason}); refusing to run on it`, hookId: 'quarantine' }], run, tainted: { reason, unresolved: [], worktree } } as Outcome;
}
