import { makeRedactor, type AbortCode, type CapabilitySet, type Json, type JsonObject, type Ledger, type Redactor, type RunRef, type SpanEvent, type SpanKind, type SpanOutcome, type Stage } from '@tecera/contracts';
import type { Composed } from '../hooks/compose.js';
import type { Dispatcher } from '../hooks/dispatcher.js';

/**
 * One place where spans are emitted and the side-effecting part of composed effects is applied:
 * AppendEvidence → ledger.evidence (redacted), ReserveBudget → ledger.reserve before the operation,
 * settlement after it. Everything else (patches, replace, suspend, restrict) is interpreted by the caller
 * that owns the operation.
 *
 * Failure semantics (fail closed): an evidence write or a settlement that fails is TERMINAL. It is
 * recorded as a sticky fatal reason (code 'ledger'); every later emit() of this runner carries those
 * reasons as an Abort, and the invoke turns any outcome into `aborted`. A reservation that is refused is an
 * Abort 'budget' at that stage.
 *
 * Budget semantics: reservations are made only when the operation will run, i.e. when the composed
 * result has neither an Abort nor a Suspend (Suspend dominates ReserveBudget). A caller that lifts a
 * Suspend with an approval grant reserves explicitly with reserve(). Each physical attempt reserves under
 * its own key (`resKey`), so an LLM retry is a new reservation.
 *
 * Without a ledger, evidence goes to the trace only and reservations are recorded but not charged.
 */

export type AbortReason = { code: AbortCode; reason: string; hookId: string };

export type TraceEntry =
  | { type: 'span'; span: SpanKind; stage: Stage; spanId: string; attempt: number; outcome?: SpanOutcome; aborted?: AbortReason[]; suspended?: boolean }
  | { type: 'evidence'; key: string; kind: string; body: Json }
  | { type: 'reserve'; spanId: string; pool: string; amount: number; key: string }
  | { type: 'settle'; key: string; pool: string; amount: number };

export interface SpanRunnerOptions {
  dispatcher: Dispatcher;
  run: RunRef;
  ledger?: Ledger;
  /** Redactor for evidence bodies and trace reasons. Default: patterns and canaries only. */
  redactor?: Redactor;
  trace?: TraceEntry[];
  /** Generation of this run (1 + number of resumes); used as the span attempt so evidence keys stay unique. */
  attempt?: number;
}

export interface EmitExtra {
  output?: JsonObject;
  outcome?: SpanOutcome;
  /** SpanEvent.attempt (physical attempt); default = the runner's generation. */
  attempt?: number;
  /** Reservation key for this stage's ReserveBudget effects; default = spanId. */
  resKey?: string;
}

const DEFAULT_REDACTOR = makeRedactor([]);

export class SpanRunner {
  private readonly reservations = new Map<string, Array<{ id: string | null; pool: string; amount: number }>>();
  private fatalReasons: AbortReason[] = [];
  private readonly red: Redactor;

  constructor(readonly p: SpanRunnerOptions) {
    this.red = p.redactor ?? DEFAULT_REDACTOR;
  }

  get run(): RunRef {
    return this.p.run;
  }

  get attempt(): number {
    return this.p.attempt ?? 1;
  }

  get redactor(): Redactor {
    return this.red;
  }

  /** Terminal persistence failures recorded so far (sticky). */
  get fatal(): AbortReason[] | undefined {
    return this.fatalReasons.length ? [...this.fatalReasons] : undefined;
  }

  /** Record a terminal failure (sticky): every later emit() aborts with it. */
  markFatal(reasons: AbortReason[]): void {
    for (const r of reasons) this.fatalReasons.push({ ...r, reason: this.red.redactText(r.reason) });
  }

  async emit(span: SpanKind, stage: Stage, spanId: string, input: JsonObject, capabilities: CapabilitySet, extra: EmitExtra = {}): Promise<Composed> {
    const attempt = extra.attempt ?? this.attempt;
    const event: SpanEvent = { span, stage, spanId, run: this.p.run, attempt, input, ...(extra.output ? { output: extra.output } : {}), ...(extra.outcome ? { outcome: extra.outcome } : {}) };
    let composed: Composed;
    try {
      composed = await this.p.dispatcher.emit(event, { capabilities });
    } catch (e) {
      composed = { abort: { reasons: [{ code: 'hookError', reason: `dispatcher failed: ${(e as Error).message}`, hookId: 'dispatcher' }] }, patchInput: new Map(), patchOutput: new Map(), reserve: new Map(), evidence: [], cas: [], ignored: [] };
    }
    const failures: AbortReason[] = [];
    for (const ev of composed.evidence) {
      try {
        await this.evidence(ev.key, ev.kind, ev.body);
      } catch (e) {
        failures.push({ code: 'ledger', reason: `evidence ${ev.key} not written: ${(e as Error).message}`, hookId: ev.hookId });
      }
    }
    if (this.fatalReasons.length) failures.push(...this.fatalReasons.filter((r) => !failures.some((f) => f.reason === r.reason)));
    if (failures.length) composed.abort = { reasons: [...(composed.abort?.reasons ?? []), ...failures] };
    if (!composed.abort && !composed.suspend && composed.reserve.size) {
      const refused = await this.reserve(extra.resKey ?? spanId, spanId, stage, composed, attempt);
      if (refused.length) composed.abort = { reasons: refused };
    }
    this.p.trace?.push({
      type: 'span',
      span,
      stage,
      spanId,
      attempt,
      ...(extra.outcome ? { outcome: extra.outcome } : {}),
      ...(composed.abort ? { aborted: composed.abort.reasons.map((r) => ({ ...r, reason: this.red.redactText(r.reason) })) } : {}),
      ...(composed.suspend ? { suspended: true } : {}),
    });
    return composed;
  }

  /**
   * Make the reservations of a composed stage under `resKey`. Returns the refusal reasons (Abort 'budget',
   * or 'ledger' for a ledger fault); empty on success. Used by emit() and by callers lifting a Suspend.
   */
  async reserve(resKey: string, spanId: string, stage: Stage, composed: Composed, attempt = this.attempt): Promise<AbortReason[]> {
    for (const [pool, amount] of composed.reserve) {
      try {
        let id: string | null = null;
        if (this.p.ledger) id = (await this.p.ledger.reserve(pool, amount, this.p.run.runId, `${resKey}:${stage}:g${this.attempt}:a${attempt}:${pool}`)).id;
        const list = this.reservations.get(resKey) ?? [];
        list.push({ id, pool, amount });
        this.reservations.set(resKey, list);
        this.p.trace?.push({ type: 'reserve', spanId, pool, amount, key: resKey });
      } catch (e) {
        return [{ code: 'budget', reason: `reservation of ${amount} ${pool} refused: ${(e as Error).message}`, hookId: 'ledger' }];
      }
    }
    return [];
  }

  /**
   * Settle the reservations made under `resKey`: actuals per pool when known, else the reserved amount.
   * A failed settlement is terminal: it is returned AND recorded as a sticky fatal reason.
   */
  async settle(resKey: string, actual: Partial<Record<string, number>> = {}): Promise<AbortReason[]> {
    const list = this.reservations.get(resKey);
    if (!list) return [];
    this.reservations.delete(resKey);
    const failures: AbortReason[] = [];
    for (const r of list) {
      const amount = actual[r.pool] ?? r.amount;
      try {
        if (this.p.ledger && r.id !== null) await this.p.ledger.settle(r.id, amount);
        this.p.trace?.push({ type: 'settle', key: resKey, pool: r.pool, amount });
      } catch (e) {
        failures.push({ code: 'ledger', reason: `settlement of ${r.pool} for ${resKey} failed: ${(e as Error).message}`, hookId: 'ledger' });
      }
    }
    if (failures.length) this.markFatal(failures);
    return failures;
  }

  /** Reservation keys not settled yet (a clean exit has none). */
  openReservations(): string[] {
    return [...this.reservations.keys()];
  }

  /**
   * Write one evidence record (redacted). Throws on ledger failure so callers can fail closed; the failure
   * is also recorded as a sticky fatal reason.
   */
  async evidence(key: string, kind: string, body: Json): Promise<void> {
    const clean = this.red.redactJson(body);
    this.p.trace?.push({ type: 'evidence', key, kind, body: clean });
    if (!this.p.ledger) return;
    try {
      await this.p.ledger.evidence({ key, kind, runId: this.p.run.runId, body: clean });
    } catch (e) {
      this.markFatal([{ code: 'ledger', reason: `evidence ${key} not written: ${(e as Error).message}`, hookId: 'ledger' }]);
      throw e;
    }
  }
}

/** Apply a dotted-path patch to a JSON object (copy). Array indices are numeric segments. */
export function applyPatches(target: JsonObject, patches: Map<string, Json>): JsonObject {
  const out = structuredClone(target) as JsonObject;
  for (const [path, value] of patches) {
    const segs = path.split('.').filter(Boolean);
    if (segs.length === 0 || segs.some((s) => s === '__proto__' || s === 'constructor' || s === 'prototype')) continue;
    let cur: { [k: string]: Json } | Json[] = out;
    for (let i = 0; i < segs.length - 1; i++) {
      const k = segs[i]!;
      const next: Json | undefined = (cur as Record<string, Json>)[k];
      if (next === null || typeof next !== 'object') (cur as Record<string, Json>)[k] = {};
      cur = (cur as Record<string, Json>)[k] as { [k: string]: Json };
    }
    (cur as Record<string, Json>)[segs[segs.length - 1]!] = value;
  }
  return out;
}

export const isFatalCode = (code: AbortCode): boolean => code === 'budget' || code === 'recursion' || code === 'iterations' || code === 'cancelled' || code === 'ledger';
