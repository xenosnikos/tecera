import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Budget, Commitment, Manifest } from '@tecera/contracts';
import { FrontMatterError, splitFrontMatter } from './util/frontmatter.js';
import { safeReadFile, UnsafePathError } from './util/safefs.js';

/**
 * Goal files: `.tecera/goals/<id>.goal.md` = front matter (what is checked, commitment, budget) + the
 * statement. The goal id on the ledger is `g_<id>`. Unknown front-matter keys are rejected. A run given a
 * free-form statement gets an ad hoc goal whose check is the manifest's verify command: done is always an
 * environmental check, never a model's opinion.
 */

export const GOALS_DIR = '.tecera/goals';

const budgetKeys = ['usd', 'tokens', 'wallClockSec', 'maxDepth', 'maxIterations', 'maxAttempts', 'maxChangedFiles'] as const;

const GoalFrontSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    kind: z.literal('achievement'),
    verify: z.string().min(1).optional(),
    timeoutSec: z.number().int().positive().optional(),
    commitment: z.enum(['blind', 'single-minded', 'open-minded']).optional(),
    budget: z.object(Object.fromEntries(budgetKeys.map((k) => [k, z.number().positive().optional()])) as Record<(typeof budgetKeys)[number], z.ZodOptional<z.ZodNumber>>).strict().optional(),
    'on-violation': z.enum(['wake-human', 'demote', 'drop']).optional(),
  })
  .strict();

export interface GoalSpec {
  /** File id (`fix-failing-test`); `adhoc` for statements. */
  id: string;
  /** Ledger goal id (`g_fix-failing-test`). */
  goalId: string;
  statement: string;
  check: { command: string; timeoutSec: number };
  commitment: Commitment;
  budget: Partial<Budget>;
  onViolation: 'wake-human' | 'demote' | 'drop';
  source: 'file' | 'statement';
  path?: string;
}

export class GoalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoalError';
  }
}

export function goalPath(root: string, id: string): string {
  return join(root, GOALS_DIR, `${id}.goal.md`);
}

export function parseGoalFile(text: string, m: Manifest, path?: string): GoalSpec {
  let fm;
  try {
    fm = splitFrontMatter(text);
  } catch (err) {
    if (err instanceof FrontMatterError) throw new GoalError(`${path ?? 'goal'}: ${err.message}`);
    throw err;
  }
  const r = GoalFrontSchema.safeParse(fm.data);
  if (!r.success) throw new GoalError(`${path ?? 'goal'}: ${r.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')}`);
  if (!fm.body) throw new GoalError(`${path ?? 'goal'}: the goal statement (body) is empty`);
  const d = r.data;
  return {
    id: d.id,
    goalId: `g_${d.id}`,
    statement: fm.body,
    check: { command: d.verify ?? m.verify.command, timeoutSec: d.timeoutSec ?? m.verify.timeoutSec },
    commitment: d.commitment ?? m.commitment,
    budget: Object.fromEntries(Object.entries(d.budget ?? {}).filter(([, v]) => v !== undefined)) as Partial<Budget>,
    onViolation: d['on-violation'] ?? 'wake-human',
    source: 'file',
    path,
  };
}

/** Normalise `g_fix-failing-test` / `fix-failing-test` to the file id. */
export function goalFileId(ref: string): string {
  return ref.startsWith('g_') ? ref.slice(2) : ref;
}

/** Resolve a goal file by id. Throws GoalError when missing or invalid. */
export function loadGoal(root: string, ref: string, m: Manifest): GoalSpec {
  const id = goalFileId(ref);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new GoalError(`not a goal id: ${ref}`);
  let buf: Buffer | undefined;
  try {
    buf = safeReadFile(root, `${GOALS_DIR}/${id}.goal.md`);
  } catch (e) {
    if (e instanceof UnsafePathError) throw new GoalError(`${GOALS_DIR}/${id}.goal.md: ${e.message}`);
    throw e;
  }
  if (buf === undefined) throw new GoalError(`goal ${id} not found (${GOALS_DIR}/${id}.goal.md)`);
  const g = parseGoalFile(buf.toString('utf8'), m, `${GOALS_DIR}/${id}.goal.md`);
  if (g.id !== id) throw new GoalError(`${GOALS_DIR}/${id}.goal.md declares id ${g.id}; the file name and id must match`);
  return g;
}

export function listGoalIds(root: string): string[] {
  const dir = join(root, GOALS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.goal.md'))
    .map((f) => f.slice(0, -'.goal.md'.length))
    .sort();
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'goal';
}

/** A goal file when `arg` names one; otherwise an ad hoc goal from the statement. */
export function resolveGoal(root: string, arg: string, m: Manifest): GoalSpec {
  const id = goalFileId(arg.trim());
  if (/^[a-z0-9][a-z0-9_-]*$/.test(id) && existsSync(goalPath(root, id))) return loadGoal(root, id, m);
  const statement = arg.trim();
  if (!statement) throw new GoalError('empty goal statement');
  return {
    id: 'adhoc',
    goalId: `g_${slug(statement)}`,
    statement,
    check: { command: m.verify.command, timeoutSec: m.verify.timeoutSec },
    commitment: m.commitment,
    budget: {},
    onViolation: 'wake-human',
    source: 'statement',
  };
}

/** Effective budget: the manifest's, narrowed by the goal's and by CLI overrides. Never widened. */
export function effectiveBudget(m: Manifest, goal: GoalSpec, overrides: Partial<Budget> = {}): { budget: Budget; errors: string[] } {
  const budget: Budget = { ...m.budgets };
  const errors: string[] = [];
  for (const [src, part] of [['goal', goal.budget], ['flag', overrides]] as const) {
    for (const [k, v] of Object.entries(part) as Array<[keyof Budget, number | undefined]>) {
      if (typeof v !== 'number') continue;
      if (v > m.budgets[k]) errors.push(`${src} budget ${k}=${v} exceeds the manifest's ${m.budgets[k]}`);
      else budget[k] = Math.min(budget[k], v);
    }
  }
  return { budget, errors };
}
