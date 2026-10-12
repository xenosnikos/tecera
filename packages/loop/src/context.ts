import type { AchievementGoal, BeliefProjection, Binding, Inputs, Json, Plan, Step } from '@tecera/contracts';

/**
 * The BDI context filter: a worker sees the goal, its step, why its previous attempt failed (on a retry), the
 * outputs of the worker steps it depends on, and only the beliefs the plan's context conditions mention (plus
 * any the step explicitly asks for), under a token budget. Nothing else.
 * `__history__` is bound by the worker itself, by reference.
 */
export interface ContextOptions {
  budgetTokens: number;
  /** Extra belief keys the step wants, beyond the plan context. */
  extraKeys?: string[];
  /** Always-on bindings (preferences, permissions summary) that are never dropped. */
  alwaysOn?: Record<string, Binding>;
  /**
   * Return values of the completed worker steps upstream of this one, by step id (L5-F2: a step sees what the
   * steps it depends on found). Worker output, so untrusted; offered before the beliefs under the budget.
   */
  dependencies?: Record<string, Json>;
  /**
   * Why the previous attempt's candidate was refused (contracts FailureContext): the failed criteria or the
   * review findings, from gate evidence, already redacted and bounded by the loop. Untrusted data; never
   * dropped under the budget, since a retry without it repeats the refused attempt.
   */
  failureContext?: Json;
}

export interface AssembledContext {
  inputs: Inputs;
  tokens: number;
  dropped: string[];
}

const estimateTokens = (v: Json): number => Math.ceil(JSON.stringify(v).length / 4);

export function assembleStepContext(goal: AchievementGoal, plan: Plan, step: Step, beliefs: BeliefProjection, opts: ContextOptions): AssembledContext {
  const inputs: Inputs = {};
  let tokens = 0;
  const dropped: string[] = [];

  const put = (name: string, b: Binding, mandatory: boolean): void => {
    const cost = b.kind === 'handle' ? 8 : estimateTokens(b.value);
    if (!mandatory && tokens + cost > opts.budgetTokens) {
      dropped.push(name);
      return;
    }
    inputs[name] = b;
    tokens += cost;
  };

  put('goal', { kind: 'value', value: { id: goal.id, statement: goal.statement, check: goal.check.command }, provenance: { src: 'goal', trust: 'trusted' } }, true);
  put('step', { kind: 'value', value: { id: step.id, kind: step.kind, instruction: step.instruction ?? '', inputs: step.inputs, output: step.output ?? null }, provenance: { src: 'plan', trust: 'trusted' } }, true);
  if (opts.failureContext !== undefined) put('failureContext', { kind: 'value', value: opts.failureContext, provenance: { src: 'gates', trust: 'untrusted' } }, true);
  for (const [name, b] of Object.entries(opts.alwaysOn ?? {})) put(name, b, true);
  if (opts.dependencies && Object.keys(opts.dependencies).length) put('dependencies', { kind: 'value', value: opts.dependencies, provenance: { src: 'steps', trust: 'untrusted' } }, false);

  const keys = new Set<string>([...plan.context.map((c) => c.key), ...(opts.extraKeys ?? [])]);
  const facts: Record<string, Json> = {};
  const provenances: Record<string, string> = {};
  for (const k of keys) {
    const b = beliefs.get(k);
    if (!b) continue;
    facts[k] = b.value;
    provenances[k] = `${b.provenance.src}:${b.provenance.trust}`;
  }
  put('beliefs', { kind: 'value', value: facts, provenance: { src: 'beliefs', trust: 'trusted' } }, false);
  put('beliefProvenance', { kind: 'value', value: provenances, provenance: { src: 'beliefs', trust: 'trusted' } }, false);

  return { inputs, tokens, dropped };
}
