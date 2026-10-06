import type { Json, JsonObject } from './json.js';
import type { Principal } from './bdi.js';

/**
 * Event catalog. Every event is a ledger row and carries the trace ids that let `tecera why` walk
 * action → step → intention → goal → event. Kinds are closed; adding one means adding it here and to
 * TRACE_REQUIREMENTS.
 */

export const EVENT_KINDS = [
  'run.started',
  'run.ended',
  'run.interrupted',
  'manifest.created',
  'doctor.ran',
  'preflight.ran',
  'belief.added',
  'belief.removed',
  'goal.adopted',
  'goal.achieved',
  'goal.demoted',
  'goal.dropped',
  'plan.generated',
  'plan.staged',
  'plan.graduated',
  'plan.rejected',
  'plan.retracted',
  'intention.pushed',
  'intention.advanced',
  'intention.held',
  'intention.done',
  'intention.dropped',
  'intention.failed',
  'step.requested',
  'step.held',
  'step.started',
  'step.completed',
  'step.failed',
  'step.cancelled',
  'step.interrupted',
  'approval.requested',
  'approval.granted',
  'approval.denied',
  'approval.consumed',
  'approval.expired',
  'verify.started',
  'verify.passed',
  'verify.failed',
  'verify.interrupted',
  'review.started',
  'review.passed',
  'review.rejected',
  'commit.recorded',
  'pr.requested',
  'pr.opened',
  'pr.failed',
  'budget.exhausted',
  'stop.blocked',
  'stop.allowed',
  'decision.recorded',
  'evidence.appended',
  'isolation.degraded',
  'gate.ran',
  'evidence.exported',
  'adapters.installed',
  'manifest.migrated',
  'lesson.staged',
  'lesson.graduated',
  'lesson.rejected',
  'lesson.retracted',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface Trace {
  goalId?: string;
  intentionId?: string;
  stepId?: string;
  planId?: string;
}

export interface TeceraEvent<P extends JsonObject = JsonObject> {
  id: string;
  kind: EventKind;
  at: number;
  actor: Principal;
  runId?: string;
  trace: Trace;
  payload: P;
  /** Deduplication key for at-least-once transports. */
  idemKey?: string;
}

type TraceField = keyof Trace;

/** Which trace ids each kind must carry. Enforced by validateEvent and by the ledger on append. */
export const TRACE_REQUIREMENTS: Record<EventKind, ReadonlyArray<TraceField>> = {
  'run.started': [],
  'run.ended': [],
  'run.interrupted': [],
  'manifest.created': [],
  'doctor.ran': [],
  'preflight.ran': ['goalId'],
  'belief.added': [],
  'belief.removed': [],
  'goal.adopted': ['goalId'],
  'goal.achieved': ['goalId'],
  'goal.demoted': ['goalId'],
  'goal.dropped': ['goalId'],
  'plan.generated': ['goalId', 'planId'],
  'plan.staged': ['planId'],
  'plan.graduated': ['planId'],
  'plan.rejected': ['planId'],
  'plan.retracted': ['planId'],
  'intention.pushed': ['goalId', 'intentionId', 'planId'],
  'intention.advanced': ['goalId', 'intentionId', 'planId'],
  'intention.held': ['goalId', 'intentionId', 'planId'],
  'intention.done': ['goalId', 'intentionId', 'planId'],
  'intention.dropped': ['goalId', 'intentionId', 'planId'],
  'intention.failed': ['goalId', 'intentionId', 'planId'],
  'step.requested': ['goalId', 'intentionId', 'planId', 'stepId'],
  'step.held': ['goalId', 'intentionId', 'planId', 'stepId'],
  'step.started': ['goalId', 'intentionId', 'planId', 'stepId'],
  'step.completed': ['goalId', 'intentionId', 'planId', 'stepId'],
  'step.failed': ['goalId', 'intentionId', 'planId', 'stepId'],
  'step.cancelled': ['goalId', 'intentionId', 'planId', 'stepId'],
  /** A step found 'running' when a restarted loop restored the run (the process died mid-step). */
  'step.interrupted': ['goalId', 'intentionId', 'planId', 'stepId'],
  'approval.requested': ['goalId', 'intentionId', 'stepId'],
  'approval.granted': ['goalId', 'intentionId', 'stepId'],
  'approval.denied': ['goalId', 'intentionId', 'stepId'],
  'approval.consumed': ['goalId', 'intentionId', 'stepId'],
  'approval.expired': ['goalId', 'intentionId', 'stepId'],
  'verify.started': ['goalId', 'intentionId', 'stepId'],
  'verify.passed': ['goalId', 'intentionId', 'stepId'],
  'verify.failed': ['goalId', 'intentionId', 'stepId'],
  /** A verify gate found running at restore time: recorded, then re-run (security.md §4 S4/S6). */
  'verify.interrupted': ['goalId', 'intentionId', 'stepId'],
  'review.started': ['goalId', 'intentionId', 'stepId'],
  'review.passed': ['goalId', 'intentionId', 'stepId'],
  'review.rejected': ['goalId', 'intentionId', 'stepId'],
  'commit.recorded': ['goalId', 'intentionId', 'stepId'],
  /** gate.pr: no PR could be opened here (no remote / no gh); the branch, base and a patch bundle are recorded. */
  'pr.requested': ['goalId', 'intentionId', 'stepId'],
  /** gate.pr: the work branch was pushed and a PR opened (payload.url). Tecera never merges. */
  'pr.opened': ['goalId', 'intentionId', 'stepId'],
  'pr.failed': ['goalId', 'intentionId', 'stepId'],
  /** Informational (D3): a usd/tokens/calls/wallClock pool passed its cap while budgets.enforce is false. */
  'budget.exhausted': [],
  /** The host's Stop hook refused to let the assistant stop (active run without a goal.achieved proof). */
  'stop.blocked': [],
  'stop.allowed': [],
  'decision.recorded': [],
  'evidence.appended': [],
  'isolation.degraded': [],
  'gate.ran': [],
  'evidence.exported': [],
  'adapters.installed': [],
  'manifest.migrated': [],
  'lesson.staged': [],
  'lesson.graduated': [],
  'lesson.rejected': [],
  'lesson.retracted': [],
};

export class InvalidEvent extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEvent';
  }
}

export function isEventKind(k: string): k is EventKind {
  return (EVENT_KINDS as readonly string[]).includes(k);
}

/** Structural validation: known kind, required trace ids present, payload is an object. */
export function validateEvent(e: TeceraEvent): void {
  if (!isEventKind(e.kind)) throw new InvalidEvent(`unknown event kind ${e.kind}`);
  if (!e.id || !e.actor?.id || typeof e.at !== 'number') throw new InvalidEvent('event missing id, actor or at');
  if (e.payload === null || typeof e.payload !== 'object' || Array.isArray(e.payload)) throw new InvalidEvent('payload must be an object');
  for (const f of TRACE_REQUIREMENTS[e.kind]) {
    if (!e.trace[f]) throw new InvalidEvent(`event ${e.kind} requires trace.${f}`);
  }
}

/** Helper for building events in tests and runtimes. Does not assign ids or timestamps. */
export function event<P extends JsonObject>(
  kind: EventKind,
  args: { id: string; at: number; actor: Principal; trace?: Trace; payload: P; runId?: string; idemKey?: string },
): TeceraEvent<P> {
  const e: TeceraEvent<P> = { id: args.id, kind, at: args.at, actor: args.actor, trace: args.trace ?? {}, payload: args.payload, runId: args.runId, idemKey: args.idemKey };
  validateEvent(e);
  return e;
}

export type EventPayloadOf = Json;
