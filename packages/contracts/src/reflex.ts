import type { Json } from './json.js';

/**
 * The six reflex seams from the article. Each is a typed question with a constrained answer and a
 * confidence; the loop acts on confident answers, escalates shaky ones to the planner seat, and records
 * every decision as evidence. Providers: rules (always available), a decision model (Jev, OpenAI
 * Decisions, Strands), or the frontier itself.
 */

export const REFLEX_SEAMS = ['triage', 'choosePlan', 'route', 'gate', 'reconsider', 'closeOut'] as const;
export type ReflexSeam = (typeof REFLEX_SEAMS)[number];
/**
 * How a seam answers. There is no 'off' (owner decision D2, 2026-10-05): every seam always answers, a
 * shaky answer escalates to the frontier (the planner seat) when one is wired, and the gate seam can never
 * be disabled. 'model' uses the decision-model provider (seats.reflex) and falls back to the rules.
 */
export const REFLEX_SETTINGS = ['rule', 'model', 'frontier'] as const;
export type ReflexSetting = (typeof REFLEX_SETTINGS)[number];
export type ReflexProvider = 'rules' | 'jev' | 'openai-decisions' | 'strands' | 'frontier';

export type GateDecision = 'allow' | 'hold' | 'block';

export interface ReflexQuestions {
  triage: { state: Json; options: Array<{ intentionId: string | null; label: string }> };
  choosePlan: { state: Json; options: Array<{ planId: string; label: string }> };
  route: { state: Json; options: Array<{ seatId: string; costPerMTok: number }> };
  gate: { state: Json; options: Array<{ decision: GateDecision }> };
  reconsider: { state: Json };
  closeOut: { state: Json };
}

export interface ReflexAnswers {
  triage: { intentionId: string | null };
  choosePlan: { planId: string };
  route: { seatId: string };
  gate: { decision: GateDecision };
  reconsider: { interrupt: boolean };
  closeOut: { achieved: boolean };
}

export interface ReflexResult<S extends ReflexSeam> {
  seam: S;
  answer: ReflexAnswers[S];
  confidence: number; // 0..1; flat distributions are low, a single peak is high
  probabilities?: Record<string, number>;
  provider: ReflexProvider;
  /** True when the provider declined to answer (confidence below its own floor). The loop escalates. */
  abstained: boolean;
}

export interface DecisionRecord {
  id: string;
  seam: ReflexSeam;
  stateDigest: string;
  answer: Json;
  probabilities?: Record<string, number>;
  confidence: number;
  provider: ReflexProvider;
  setting: ReflexSetting;
  /**
   * What happened: 'acted' = the configured provider answered confidently; 'escalated' = the frontier was
   * actually called and answered; 'fallback' = escalation was wanted (shaky / abstained answer, or a 'model'
   * / 'frontier' seam) but no such provider was wired, so the rule answer stands.
   */
  outcome: 'acted' | 'escalated' | 'fallback';
  runId: string;
  at: number;
}
