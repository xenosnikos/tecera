import type { Commitment, GateDecision, Json, Reflex, ReflexQuestions, ReflexResult, ReflexSeam, StepKind } from '@tecera/contracts';

/**
 * Rule-based reflexes: the always-available fallback for every seam. Deterministic, explainable,
 * fail-closed. A decision model (Jev, OpenAI Decisions, Strands) can replace any seam; these rules
 * remain the baseline it is measured against (ROUTING §8: measure first, route second, delete gladly).
 */

export interface TriageState {
  trace?: { intentionId?: string; goalId?: string };
  eventKind: string;
}

export interface ChoosePlanState {
  /** Optional precomputed scores (e.g. graduated plans rank above candidates). */
  scores?: Record<string, number>;
}

export interface GateState {
  tool: string;
  method?: string;
  risk: 'read' | 'write' | 'irreversible';
  /** Resolved from permissions.json: which bucket the action falls in, if any. */
  permission?: 'always' | 'requiresApproval' | 'never';
  isolationDegraded?: boolean;
  /** True when a protected path is touched; always blocks. */
  touchesProtected?: boolean;
}

export interface ReconsiderState {
  commitment: Commitment;
  eventKind: string;
  /** The new event invalidates a belief the running plan's context depends on. */
  invalidatesContext: boolean;
  /** The goal of the running intention changed or was dropped. */
  goalChanged: boolean;
}

export interface CloseOutState {
  stepKind: StepKind;
  exitCode?: number;
  returnValid?: boolean;
  policyAborts?: number;
  verdict?: 'approve' | 'reject';
}

function answer<S extends ReflexSeam>(seam: S, a: ReflexResult<S>['answer'], confidence = 1, probabilities?: Record<string, number>): ReflexResult<S> {
  return { seam, answer: a, confidence, probabilities, provider: 'rules', abstained: false };
}

function abstain<S extends ReflexSeam>(seam: S, a: ReflexResult<S>['answer']): ReflexResult<S> {
  return { seam, answer: a, confidence: 0, provider: 'rules', abstained: true };
}

export class RulesReflex implements Reflex {
  async ask<S extends ReflexSeam>(seam: S, q: ReflexQuestions[S]): Promise<ReflexResult<S>> {
    switch (seam) {
      case 'triage':
        return this.triage(q as ReflexQuestions['triage']) as ReflexResult<S>;
      case 'choosePlan':
        return this.choosePlan(q as ReflexQuestions['choosePlan']) as ReflexResult<S>;
      case 'route':
        return this.route(q as ReflexQuestions['route']) as ReflexResult<S>;
      case 'gate':
        return this.gate(q as ReflexQuestions['gate']) as ReflexResult<S>;
      case 'reconsider':
        return this.reconsider(q as ReflexQuestions['reconsider']) as ReflexResult<S>;
      case 'closeOut':
        return this.closeOut(q as ReflexQuestions['closeOut']) as ReflexResult<S>;
      default:
        throw new Error(`unknown seam ${String(seam)}`);
    }
  }

  /** An event with a known intention id goes there; otherwise it starts a new intention. */
  triage(q: ReflexQuestions['triage']): ReflexResult<'triage'> {
    const s = q.state as unknown as TriageState;
    const id = s.trace?.intentionId;
    if (id && q.options.some((o) => o.intentionId === id)) return answer('triage', { intentionId: id });
    return answer('triage', { intentionId: null });
  }

  /** One option is certain. Several options: use scores if given, otherwise abstain so the frontier decides. */
  choosePlan(q: ReflexQuestions['choosePlan']): ReflexResult<'choosePlan'> {
    if (q.options.length === 0) throw new Error('choosePlan requires at least one option');
    if (q.options.length === 1) return answer('choosePlan', { planId: q.options[0]!.planId });
    const s = q.state as unknown as ChoosePlanState;
    const scores = s.scores;
    if (!scores) return abstain('choosePlan', { planId: q.options[0]!.planId });
    const ranked = [...q.options].map((o) => ({ id: o.planId, score: scores[o.planId] ?? 0 })).sort((a, b) => b.score - a.score);
    const total = ranked.reduce((n, r) => n + Math.max(r.score, 0), 0);
    const probabilities: Record<string, number> = {};
    for (const r of ranked) probabilities[r.id] = total > 0 ? Math.max(r.score, 0) / total : 1 / ranked.length;
    const top = ranked[0]!;
    const confidence = total > 0 ? probabilities[top.id]! : 0;
    if (ranked.length > 1 && ranked[1]!.score === top.score) return abstain('choosePlan', { planId: top.id });
    return answer('choosePlan', { planId: top.id }, confidence, probabilities);
  }

  /** Cheapest allowed seat. */
  route(q: ReflexQuestions['route']): ReflexResult<'route'> {
    if (q.options.length === 0) throw new Error('route requires at least one allowed seat');
    const cheapest = [...q.options].sort((a, b) => a.costPerMTok - b.costPerMTok)[0]!;
    return answer('route', { seatId: cheapest.seatId });
  }

  /**
   * Fail closed: never → block; protected → block; requiresApproval or irreversible → hold; else allow.
   * Writes on the leased work branch are allowed under any isolation (D6: the PR is the approval point;
   * writes stay confined by allowedChanges, protected paths, tamper rules and the write guard), so
   * isolationDegraded is recorded, not a reason to hold.
   */
  gate(q: ReflexQuestions['gate']): ReflexResult<'gate'> {
    const s = q.state as unknown as GateState;
    let d: GateDecision;
    if (s.permission === 'never' || s.touchesProtected) d = 'block';
    else if (s.permission === 'requiresApproval' || s.risk === 'irreversible') d = 'hold';
    else if (s.permission === 'always' || s.risk === 'read' || s.risk === 'write') d = 'allow';
    else d = 'hold';
    if (!q.options.some((o) => o.decision === d)) d = 'block';
    return answer('gate', { decision: d });
  }

  /** Apply the commitment policy. */
  reconsider(q: ReflexQuestions['reconsider']): ReflexResult<'reconsider'> {
    const s = q.state as unknown as ReconsiderState;
    let interrupt = false;
    if (s.commitment === 'single-minded') interrupt = s.invalidatesContext;
    else if (s.commitment === 'open-minded') interrupt = s.invalidatesContext || s.goalChanged;
    return answer('reconsider', { interrupt });
  }

  /** Gates: exit code or verdict. Worker steps: schema-valid return and no policy aborts. Never a model's opinion. */
  closeOut(q: ReflexQuestions['closeOut']): ReflexResult<'closeOut'> {
    const s = q.state as unknown as CloseOutState;
    let achieved: boolean;
    switch (s.stepKind) {
      case 'gate.verify':
      case 'gate.commit':
      case 'gate.pr':
        achieved = s.exitCode === 0;
        break;
      case 'gate.review':
        achieved = s.verdict === 'approve';
        break;
      case 'worker':
      case 'subgoal':
        achieved = s.returnValid === true && (s.policyAborts ?? 0) === 0;
        break;
      default:
        achieved = false;
    }
    return answer('closeOut', { achieved });
  }
}

export function asState(v: unknown): Json {
  return v as Json;
}
