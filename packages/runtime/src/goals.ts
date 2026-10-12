import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalEnvelope, contractHash, contractProblem, type AcceptanceContract, type Budget, type Commitment, type Criterion, type Manifest } from '@tecera/contracts';
import { envelopeDraftIssues } from '@tecera/planner';
import { FrontMatterError, splitFrontMatter } from './util/frontmatter.js';
import { safeReadFile, UnsafePathError } from './util/safefs.js';

/**
 * Goal files: `.tecera/goals/<id>.goal.md` = front matter (what is checked, commitment, budget, and optionally
 * the acceptance criteria) + the statement. The goal id on the ledger is the file id (it names the work
 * branch `tecera/<id>` too, so the gates' goal and branch always agree; `g_<id>` is still accepted as a
 * reference). Unknown front-matter keys are rejected. A run given a free-form statement gets an ad hoc goal whose check is the manifest's verify
 * command: done is always an environmental check, never a model's opinion. Its id is the statement's slug,
 * the same on the first run and on every resume (the work branch is `tecera/<slug>`).
 *
 * `criteria:` (D8) is a one-line flow list of maps, each `{id, statement, verify | ask, timeoutSec?,
 * requires?}`: `verify` is a command criterion (exit 0 passes, run by the verify gate on the final
 * candidate), `ask` a human criterion (the question a human other than the requester answers at the PR hold),
 * `requires` the capability ids it rests on (manifest `connections` keys or needs the run must provision or
 * mock). `envelope:` is the contract's change-path envelope, a one-line flow list of `{path, ops}` (ops:
 * create, modify, delete): the only paths the delivered change may touch. It needs `criteria:`, is part of the
 * contract hash, and must lie inside repo.allowedChanges and off the protected paths. Without it the
 * manifest's allowedChanges is the envelope, as before. A goal file with criteria carries its own acceptance contract (no sign-off under
 * `acceptance.signoff: statement`); one without keeps the single-check path (its check alone).
 */

export const GOALS_DIR = '.tecera/goals';

const budgetKeys = ['usd', 'tokens', 'wallClockSec', 'maxDepth', 'maxIterations', 'maxAttempts', 'maxChangedFiles'] as const;

const CriterionFrontSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    statement: z.string().min(1),
    verify: z.string().min(1).optional(),
    ask: z.string().min(1).optional(),
    timeoutSec: z.number().int().positive().optional(),
    requires: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)).optional(),
  })
  .strict()
  .refine((k) => (k.verify === undefined) !== (k.ask === undefined), { message: 'a criterion has exactly one of verify (a command) or ask (a human question)' })
  .refine((k) => k.ask === undefined || k.timeoutSec === undefined, { message: 'timeoutSec belongs to a verify criterion' });

const GoalFrontSchema = z
  .object({
    // `g_<id>` is a reference to the goal file <id> (and the ledger id of runs before wave 6): never a file id.
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]*$/)
      .refine((id) => !id.startsWith('g_'), { message: 'the g_ prefix is reserved (g_<id> refers to the goal file <id>)' }),
    kind: z.literal('achievement'),
    verify: z.string().min(1).optional(),
    timeoutSec: z.number().int().positive().optional(),
    commitment: z.enum(['blind', 'single-minded', 'open-minded']).optional(),
    budget: z.object(Object.fromEntries(budgetKeys.map((k) => [k, z.number().positive().optional()])) as Record<(typeof budgetKeys)[number], z.ZodOptional<z.ZodNumber>>).strict().optional(),
    'on-violation': z.enum(['wake-human', 'demote', 'drop']).optional(),
    criteria: z.array(CriterionFrontSchema).min(1).optional(),
    // The change-path envelope of the contract: [{"path": "src/slug.js", "ops": ["modify"]}, …]
    envelope: z.array(z.object({ path: z.string().min(1), ops: z.array(z.enum(['create', 'modify', 'delete'])).min(1) }).strict()).min(1).optional(),
  })
  .strict();

export interface GoalSpec {
  /** File id (`fix-failing-test`); the statement's slug for an ad hoc statement. */
  id: string;
  /** Ledger goal id: the file id or the statement's slug (`fix-failing-test`); runs before wave 6 used `g_<id>`. */
  goalId: string;
  statement: string;
  check: { command: string; timeoutSec: number };
  commitment: Commitment;
  budget: Partial<Budget>;
  onViolation: 'wake-human' | 'demote' | 'drop';
  source: 'file' | 'statement';
  path?: string;
  /**
   * The goal file's acceptance contract (front matter `criteria:`) and its hash. Absent: the single-check
   * path (a goal file without criteria), or a statement whose contract the planner drafts at run time.
   */
  contract?: AcceptanceContract;
  contractHash?: string;
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
  const check = { command: d.verify ?? m.verify.command, timeoutSec: d.timeoutSec ?? m.verify.timeoutSec };
  let contract: AcceptanceContract | undefined;
  if (d.criteria) {
    const criteria: Criterion[] = d.criteria.map((k) => ({
      id: k.id,
      statement: k.statement,
      check: k.verify !== undefined ? { kind: 'command' as const, command: k.verify, timeoutSec: k.timeoutSec ?? check.timeoutSec } : { kind: 'human' as const, prompt: k.ask! },
      ...(k.requires?.length ? { requires: [...k.requires] } : {}),
    }));
    contract = { goalId: d.id, statement: fm.body, criteria, outOfScope: [], assumptions: [], ...(d.envelope ? { envelope: canonicalEnvelope(d.envelope) } : {}) };
    const why = contractProblem(contract);
    if (why) throw new GoalError(`${path ?? 'goal'}: criteria: ${why}`);
    // The manifest stays the outer boundary: an envelope cannot name what repo.allowedChanges or the protected paths exclude.
    const outside = envelopeDraftIssues(contract.envelope, { allowedChanges: m.repo.allowedChanges, protectedPaths: m.policy.protectedPaths });
    if (outside.length) throw new GoalError(`${path ?? 'goal'}: envelope: ${outside.join('; ')}`);
  } else if (d.envelope) {
    throw new GoalError(`${path ?? 'goal'}: envelope: a change-path envelope is part of an acceptance contract; the goal needs criteria`);
  }
  return {
    id: d.id,
    goalId: d.id,
    statement: fm.body,
    check,
    commitment: d.commitment ?? m.commitment,
    budget: Object.fromEntries(Object.entries(d.budget ?? {}).filter(([, v]) => v !== undefined)) as Partial<Budget>,
    onViolation: d['on-violation'] ?? 'wake-human',
    source: 'file',
    path,
    ...(contract ? { contract, contractHash: contractHash(contract) } : {}),
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
  // One canonical slug for the goal id and the work branch, on the first run and on every resume (L5-F1).
  const name = slug(statement);
  return {
    id: name,
    goalId: name,
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
