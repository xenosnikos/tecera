import {
  REFLEX_SEAMS,
  REFLEX_SETTINGS,
  digest,
  type DecisionRecord,
  type DecisionSink,
  type GateDecision,
  type Json,
  type Reflex,
  type ReflexAskOptions,
  type ReflexFrontier,
  type ReflexQuestions,
  type ReflexResult,
  type ReflexSeam,
  type ReflexSetting,
} from '@tecera/contracts';
import { RulesReflex } from './rules.js';

export interface ReflexConfig {
  settings: Record<ReflexSeam, ReflexSetting>;
  threshold: number;
}

/** The frontier seat (the planner model). Called when a seam is set to 'frontier' or an answer is shaky. */
export type Frontier = ReflexFrontier;

export interface Routed<S extends ReflexSeam> {
  result: ReflexResult<S>;
  outcome: DecisionRecord['outcome'];
  setting: ReflexSetting;
}

const GATE_ORDER: Record<GateDecision, number> = { allow: 0, hold: 1, block: 2 };

/**
 * Applies the manifest's per-seam setting (D2: reflexes are always on, there is no 'off'):
 * - `rule` answers with the rules; `model` asks the decision model (seats.reflex) and falls back to the
 *   rules when it is absent or abstains; `frontier` asks the frontier (the planner seat).
 * - Frontier escalation is on by default: an abstained or shaky answer (confidence below threshold) goes to
 *   the frontier when one is wired. The record says 'escalated' only when the frontier was actually called;
 *   'fallback' when the configured provider or the wanted escalation was unavailable; else 'acted'.
 * - A model or frontier answer is never less safe than the rules: gate takes the stricter decision (the
 *   gate seam can never be disabled), closeOut needs both to say achieved, reconsider interrupts when
 *   either does.
 * Every decision is recorded. `opts` (signal, meter) reaches the model and the frontier.
 */
export class ReflexRouter implements Reflex {
  private readonly rules = new RulesReflex();
  private seq = 0;

  constructor(
    private readonly config: ReflexConfig,
    private readonly deps: { model?: Reflex; frontier?: Frontier; sink: DecisionSink; runId: string; now?: () => number },
  ) {
    for (const seam of REFLEX_SEAMS) {
      const v = (config.settings as Record<string, unknown>)?.[seam];
      if (!(REFLEX_SETTINGS as readonly unknown[]).includes(v)) {
        throw new Error(`reflex seam ${seam} has setting ${JSON.stringify(v ?? null)}; reflexes are always on: use 'rule', 'model' or 'frontier'`);
      }
    }
  }

  async ask<S extends ReflexSeam>(seam: S, q: ReflexQuestions[S], opts?: ReflexAskOptions): Promise<ReflexResult<S>> {
    return (await this.route(seam, q, opts)).result;
  }

  async route<S extends ReflexSeam>(seam: S, q: ReflexQuestions[S], opts?: ReflexAskOptions): Promise<Routed<S>> {
    const setting = this.config.settings[seam];
    const rule = await this.rules.ask(seam, q);
    let result: ReflexResult<S>;
    let outcome: DecisionRecord['outcome'] = 'acted';

    if (setting === 'frontier') {
      if (this.deps.frontier) {
        result = { ...(await this.deps.frontier.decide(seam, q, opts)), provider: 'frontier' };
        outcome = 'escalated';
      } else {
        result = rule;
        outcome = 'fallback';
      }
    } else {
      let first = rule;
      if (setting === 'model') {
        if (this.deps.model) {
          first = await this.deps.model.ask(seam, q, opts);
          if (first.abstained) {
            first = rule;
            outcome = 'fallback';
          }
        } else outcome = 'fallback';
      }
      result = first;
      if (first.abstained || first.confidence < this.config.threshold) {
        if (this.deps.frontier) {
          result = { ...(await this.deps.frontier.decide(seam, q, opts)), provider: 'frontier' };
          outcome = 'escalated';
        } else {
          // No frontier wired: act on the fallback but never hide that it was shaky.
          outcome = 'fallback';
        }
      }
    }
    result = this.noLessSafe(seam, rule, result);

    await this.deps.sink.record(this.record(seam, q, result, setting, outcome));
    return { result, outcome, setting };
  }

  /** A model / frontier answer may tighten the rules' answer, never loosen it, on the safety seams. */
  private noLessSafe<S extends ReflexSeam>(seam: S, rule: ReflexResult<S>, r: ReflexResult<S>): ReflexResult<S> {
    if (r === rule || r.provider === 'rules') return r;
    if (seam === 'gate') {
      const a = (rule.answer as ReflexResult<'gate'>['answer']).decision;
      const b = (r.answer as ReflexResult<'gate'>['answer'])?.decision;
      const decision = b !== undefined && GATE_ORDER[b] !== undefined && GATE_ORDER[b] >= GATE_ORDER[a] ? b : a;
      return { ...r, answer: { decision } as ReflexResult<S>['answer'] };
    }
    if (seam === 'closeOut') {
      const achieved = (rule.answer as ReflexResult<'closeOut'>['answer']).achieved && (r.answer as ReflexResult<'closeOut'>['answer'])?.achieved === true;
      return { ...r, answer: { achieved } as ReflexResult<S>['answer'] };
    }
    if (seam === 'reconsider') {
      const interrupt = (rule.answer as ReflexResult<'reconsider'>['answer']).interrupt || (r.answer as ReflexResult<'reconsider'>['answer'])?.interrupt === true;
      return { ...r, answer: { interrupt } as ReflexResult<S>['answer'] };
    }
    return r;
  }

  private record<S extends ReflexSeam>(seam: S, q: ReflexQuestions[S], r: ReflexResult<S>, setting: ReflexSetting, outcome: DecisionRecord['outcome']): DecisionRecord {
    const now = this.deps.now ?? Date.now;
    return {
      id: `d_${this.deps.runId}_${++this.seq}`,
      seam,
      stateDigest: digest((q as { state: Json }).state),
      answer: r.answer as unknown as Json,
      probabilities: r.probabilities,
      confidence: r.confidence,
      provider: r.provider,
      setting,
      outcome,
      runId: this.deps.runId,
      at: now(),
    };
  }
}
