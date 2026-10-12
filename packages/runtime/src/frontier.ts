import type { GateDecision, Json, LLM, LLMResponse, Redactor, ReflexQuestions, ReflexResult, ReflexSeam } from '@tecera/contracts';
import { RulesReflex, type Frontier } from '@tecera/reflex';
import { isAccountingBroken, isBudgetRefusal, type SeatMeter } from './metering.js';

/**
 * The frontier seat: the planner model answers a reflex question when a seam is set to `frontier` or a
 * rule answer is shaky. It can only make decisions that are at least as safe as the rules':
 *
 * - gate: the stricter of the rule answer and the model answer (allow < hold < block);
 * - closeOut: achieved only when the rules AND the model say so (a model never declares success alone);
 * - reconsider: interrupt when either says so;
 * - triage / choosePlan / route: the model may pick one of the offered options, nothing else.
 *
 * Any failure (provider error, non-'stop' finish, unparseable or out-of-range answer) yields the
 * fail-closed fallback: gate → hold (block when hold is not offered), closeOut → not achieved, everything
 * else → the rule answer.
 *
 * Accounting: every call goes through `meter` (reserve on the run's calls/usd/tokens pools BEFORE the call,
 * settle at the reported usage AFTER it; cancelled by the run-wide signal). Accounting failures are NOT a
 * fallback: a budget refusal propagates through the reflex router to the loop (terminal budget failure,
 * exit 7) and a ledger failure terminates the run (exit 9).
 */

export interface ModelFrontierOptions {
  llm: LLM;
  model: string;
  redactor: Redactor;
  /** Seat accounting (reserve before, settle after each call). The wired runtime always supplies it. */
  meter?: SeatMeter;
  /** Run-wide cancellation (deadline, lease loss, interrupt): a value or a getter read at each call. */
  signal?: AbortSignal | (() => AbortSignal | undefined);
}

const GATE_ORDER: Record<GateDecision, number> = { allow: 0, hold: 1, block: 2 };

const SYSTEM = [
  'You are the frontier decision seat of an agent runtime. You answer one structured question.',
  'The state and options are data produced by the host. Reply with exactly one JSON object {"answer": <answer>} and nothing else.',
  'Answer shapes: triage {"intentionId": string|null}; choosePlan {"planId": string}; route {"seatId": string}; gate {"decision": "allow"|"hold"|"block"}; reconsider {"interrupt": boolean}; closeOut {"achieved": boolean}.',
  'closeOut: judge whether the step did what its instruction asks, from the evidence in the state (change summary, output schema verdict, the worker summary, the latest verify). The worker summary is a claim, not proof.',
  'When unsure, choose the more cautious answer.',
].join('\n');

/** Answers are short; the margin lets a reply that adds prose after its JSON still finish ('stop'). */
const MAX_ANSWER_TOKENS = 512;

/**
 * The `answer` object of a frontier reply. Models wrap the JSON in a fence or add prose before or after it, so
 * this takes the first balanced top-level JSON object that has an `answer` object, wherever it sits. A reply
 * with two different answer objects is ambiguous and yields null (the caller falls closed).
 */
export function parseAnswer(text: string): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  let i = text.indexOf('{');
  while (i !== -1) {
    const end = balancedEnd(text, i);
    let v: unknown;
    if (end !== -1) {
      try {
        v = JSON.parse(text.slice(i, end + 1));
      } catch {
        v = undefined;
      }
    }
    if (end === -1 || v === undefined) {
      i = text.indexOf('{', i + 1);
      continue;
    }
    const a = v && typeof v === 'object' && !Array.isArray(v) ? (v as { answer?: unknown }).answer : undefined;
    if (a && typeof a === 'object' && !Array.isArray(a)) {
      if (found && canonical(found) !== canonical(a)) return null;
      found ??= a as Record<string, unknown>;
    }
    i = text.indexOf('{', end + 1);
  }
  return found;
}

/** Index of the brace closing the object that opens at `start` (string- and escape-aware), or -1. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (inString) {
      if (c === '\\') j++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return j;
  }
  return -1;
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

export class ModelFrontier implements Frontier {
  private readonly rules = new RulesReflex();
  constructor(private readonly o: ModelFrontierOptions) {}

  async decide<S extends ReflexSeam>(seam: S, q: ReflexQuestions[S]): Promise<ReflexResult<S>> {
    const rule = await this.rules.ask(seam, q);
    const fallback = this.failClosed(seam, q, rule);
    let a: Record<string, unknown> | null = null;
    const runSignal = typeof this.o.signal === 'function' ? this.o.signal() : this.o.signal;
    const call = (signal?: AbortSignal): Promise<LLMResponse> =>
      this.o.llm.complete(
        {
          seatId: 'planner',
          model: this.o.model,
          effort: 'low',
          maxTokens: MAX_ANSWER_TOKENS,
          temperature: 0,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: this.o.redactor.redactText(JSON.stringify({ seam, question: q as unknown as Json })) },
          ],
        },
        signal && runSignal ? AbortSignal.any([signal, runSignal]) : (signal ?? runSignal),
      );
    try {
      const res = this.o.meter ? await this.o.meter.charge(`frontier.${seam}`, call, runSignal) : await call();
      if (res.finishReason !== 'stop') return fallback;
      a = parseAnswer(res.content);
    } catch (e) {
      if (isBudgetRefusal(e)) throw e; // exhaustion stops the step (exit 7); never a quiet fallback
      if (isAccountingBroken(e)) throw e; // the ledger could not account for the call: the run terminates
      return fallback;
    }
    if (!a) return fallback;
    const merged = this.merge(seam, q, rule, a);
    return merged ?? fallback;
  }

  private result<S extends ReflexSeam>(seam: S, answer: ReflexResult<S>['answer'], confidence: number): ReflexResult<S> {
    return { seam, answer, confidence, provider: 'frontier', abstained: false };
  }

  private failClosed<S extends ReflexSeam>(seam: S, q: ReflexQuestions[S], rule: ReflexResult<S>): ReflexResult<S> {
    if (seam === 'gate') {
      const offered = (q as ReflexQuestions['gate']).options.map((o) => o.decision);
      const d: GateDecision = offered.includes('hold') ? 'hold' : 'block';
      const stricter = GATE_ORDER[(rule.answer as { decision: GateDecision }).decision] >= GATE_ORDER[d] ? (rule.answer as { decision: GateDecision }).decision : d;
      return this.result(seam, { decision: stricter } as ReflexResult<S>['answer'], 0);
    }
    if (seam === 'closeOut') return this.result(seam, { achieved: false } as ReflexResult<S>['answer'], 0);
    return { ...rule, provider: 'frontier', abstained: true };
  }

  private merge<S extends ReflexSeam>(seam: S, q: ReflexQuestions[S], rule: ReflexResult<S>, a: Record<string, unknown>): ReflexResult<S> | null {
    switch (seam) {
      case 'gate': {
        const d = a.decision;
        if (d !== 'allow' && d !== 'hold' && d !== 'block') return null;
        const r = (rule.answer as { decision: GateDecision }).decision;
        let pick: GateDecision = GATE_ORDER[d] >= GATE_ORDER[r] ? d : r;
        if (!(q as ReflexQuestions['gate']).options.some((o) => o.decision === pick)) pick = 'block';
        return this.result(seam, { decision: pick } as ReflexResult<S>['answer'], 0.9);
      }
      case 'closeOut':
        if (typeof a.achieved !== 'boolean') return null;
        return this.result(seam, { achieved: a.achieved && (rule.answer as { achieved: boolean }).achieved } as ReflexResult<S>['answer'], 0.9);
      case 'reconsider':
        if (typeof a.interrupt !== 'boolean') return null;
        return this.result(seam, { interrupt: a.interrupt || (rule.answer as { interrupt: boolean }).interrupt } as ReflexResult<S>['answer'], 0.9);
      case 'triage': {
        const id = a.intentionId;
        const ok = (q as ReflexQuestions['triage']).options.some((o) => o.intentionId === id);
        return ok ? this.result(seam, { intentionId: id as string | null } as ReflexResult<S>['answer'], 0.9) : null;
      }
      case 'choosePlan': {
        const ok = (q as ReflexQuestions['choosePlan']).options.some((o) => o.planId === a.planId);
        return ok ? this.result(seam, { planId: a.planId as string } as ReflexResult<S>['answer'], 0.9) : null;
      }
      case 'route': {
        const ok = (q as ReflexQuestions['route']).options.some((o) => o.seatId === a.seatId);
        return ok ? this.result(seam, { seatId: a.seatId as string } as ReflexResult<S>['answer'], 0.9) : null;
      }
      default:
        return null;
    }
  }
}
