import type { AchievementGoal, Budget, Manifest, Plan } from '@tecera/contracts';

/**
 * Effective budgets. A plan's budget is bounded by min(manifest.budgets, goal.budget) per field. The
 * planner materialises every field into the plan it returns (an omitted field becomes the ceiling, never
 * "unlimited" and never the larger manifest default the loop would otherwise apply), so the plan id
 * covers the limits the run actually gets. A goal budget field that is not a finite positive number fails
 * closed (issue), it is never ignored.
 */

export const BUDGET_KEYS: ReadonlyArray<keyof Budget> = ['usd', 'tokens', 'wallClockSec', 'maxDepth', 'maxIterations', 'maxAttempts', 'maxChangedFiles'];
const INT_KEYS: ReadonlySet<keyof Budget> = new Set(['tokens', 'wallClockSec', 'maxDepth', 'maxIterations', 'maxAttempts', 'maxChangedFiles']);

const validLimit = (k: keyof Budget, v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && (!INT_KEYS.has(k) || Number.isInteger(v));

export interface Ceilings {
  ceilings: Budget;
  /** Which source bounds each field ('manifest' or 'goal'). */
  source: Record<keyof Budget, 'manifest' | 'goal'>;
  issues: string[];
}

/** Per-field min(manifest.budgets, goal.budget). Invalid goal or manifest values are issues. */
export function effectiveCeilings(m: Manifest, goal?: Pick<AchievementGoal, 'budget'> | null): Ceilings {
  const issues: string[] = [];
  const ceilings = {} as Budget;
  const source = {} as Record<keyof Budget, 'manifest' | 'goal'>;
  const gb = (goal?.budget ?? {}) as Record<string, unknown>;
  if (goal && goal.budget !== undefined && (goal.budget === null || typeof goal.budget !== 'object' || Array.isArray(goal.budget))) {
    issues.push('goal budget is not an object; refusing to plan without a valid ceiling');
  }
  for (const k of BUDGET_KEYS) {
    const mv = m.budgets?.[k];
    if (!validLimit(k, mv)) {
      issues.push(`manifest budgets.${k} is not a valid limit; refusing`);
      ceilings[k] = 0;
      source[k] = 'manifest';
      continue;
    }
    ceilings[k] = mv;
    source[k] = 'manifest';
    if (Object.prototype.hasOwnProperty.call(gb, k) && gb[k] !== undefined) {
      const gv = gb[k];
      if (!validLimit(k, gv)) issues.push(`goal budget.${k} is not a valid limit; refusing`);
      else if (gv < mv) {
        ceilings[k] = gv;
        source[k] = 'goal';
      }
    }
  }
  return { ceilings, source, issues };
}

/**
 * Materialise a plan budget: every field present, each <= its ceiling. An explicit value above the
 * ceiling is an issue (rejected, not trimmed); an omitted field is set to the ceiling.
 */
export function materializeBudget(requested: Partial<Budget>, m: Manifest, goal?: Pick<AchievementGoal, 'budget'> | null): { budget: Budget; issues: string[] } {
  const { ceilings, source, issues } = effectiveCeilings(m, goal);
  const budget = {} as Budget;
  for (const k of BUDGET_KEYS) {
    const v = (requested as Record<string, unknown>)[k];
    if (v === undefined) {
      budget[k] = ceilings[k];
      continue;
    }
    if (!validLimit(k, v)) {
      issues.push(`budget.${k} is not a valid limit`);
      budget[k] = ceilings[k];
      continue;
    }
    if (v > ceilings[k]) issues.push(`budget.${k} ${v} exceeds ${source[k] === 'goal' ? 'goal budget' : 'manifest'} ${ceilings[k]}`);
    budget[k] = v;
  }
  return { budget, issues };
}

export interface BudgetCheckOptions {
  /** Every field must be stated (plans the planner generated are always materialised). Default false. */
  requireComplete?: boolean;
}

/**
 * Budget check for a plan about to run (generated or reused). An omitted field means the loop will apply
 * the manifest default; that is only acceptable when the manifest value is itself within the goal ceiling.
 */
export function budgetIssues(plan: Pick<Plan, 'budget'>, m: Manifest, goal?: Pick<AchievementGoal, 'budget'> | null, o: BudgetCheckOptions = {}): string[] {
  const { ceilings, source, issues } = effectiveCeilings(m, goal);
  const b = (plan.budget && typeof plan.budget === 'object' ? plan.budget : {}) as Record<string, unknown>;
  if (!plan.budget || typeof plan.budget !== 'object' || Array.isArray(plan.budget)) issues.push('plan budget is not an object');
  for (const k of BUDGET_KEYS) {
    const v = b[k];
    if (v === undefined) {
      if (o.requireComplete) issues.push(`budget.${k} is missing; a generated plan states every budget field`);
      else if (m.budgets[k] > ceilings[k]) issues.push(`budget.${k} is omitted, so the run would get manifest ${m.budgets[k]}, which exceeds goal budget ${ceilings[k]}`);
      continue;
    }
    if (!validLimit(k, v)) issues.push(`budget.${k} is not a valid limit`);
    else if (v > ceilings[k]) issues.push(`budget.${k} ${v} exceeds ${source[k] === 'goal' ? 'goal budget' : 'manifest'} ${ceilings[k]}`);
  }
  return issues;
}
