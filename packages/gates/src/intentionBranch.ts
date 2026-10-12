import type { Json, Ledger, Redactor } from '@tecera/contracts';
import { keyPart, obj } from './evidence.js';
import { refSafe } from './gitx.js';
import type { StepContext } from './types.js';

/**
 * One work branch per intention.
 *
 * Naming rule: the first intention of a goal in a run commits to `<branchPrefix><goal>`; the n-th (n >= 2) to
 * `<branchPrefix><goal>.<n>`. A goal id never holds a dot (a goal file id is `[a-z0-9][a-z0-9_-]*`, a
 * statement's slug `[a-z0-9-]+`), so `<goal>.<n>` cannot be another goal's first branch, and it is a sibling of
 * `<goal>` in the ref namespace, never a path under it.
 *
 * A later intention never inherits the worktree of the one it replaces. Before any of its steps runs the
 * runtime prepares the leased worktree onto its branch, created at the run's pinned base commit, and persists
 * two records: the intent (written before anything moves) and the completion. The gates read the completion
 * record: an intention that has one commits to exactly the branch it names, and its candidate fingerprint is
 * bound to that branch, so no verify, criterion or review evidence of an earlier intention can stand in for it
 * even when the two candidates are byte-identical. GateContext.branch must agree with the record.
 */

/** The branch of the `ordinal`-th intention (1-based) of goal `goalName`. */
export function intentionBranchName(prefix: string, goalName: string, ordinal: number): string {
  const first = `${prefix}${refSafe(goalName)}`;
  return Number.isInteger(ordinal) && ordinal > 1 ? `${first}.${ordinal}` : first;
}

/** Evidence keys of an intention's preparation: the intent (create-once) and the completion. */
export function preparationKeys(redactor: Redactor, runId: string, intentionId: string): { intent: string; done: string } {
  const id = keyPart(redactor, `${runId}:${intentionId}`);
  return { intent: `intention-prepare:${id}`, done: `intention-prepared:${id}` };
}

/** What a preparation record binds. `fencingToken` is the lease generation the record was written under. */
export interface IntentionPreparationRecord {
  intentionId: string;
  previousIntentionId: string;
  goalId: string;
  ordinal: number;
  base: string;
  baseSha: string;
  branch: string;
  fencingToken: number;
}

/** A record body as a preparation record, or null when it is not one. */
export function preparationRecordOf(body: Json | undefined): IntentionPreparationRecord | null {
  const b = obj(body);
  if (!b) return null;
  const { intentionId, previousIntentionId, goalId, ordinal, base, baseSha, branch, fencingToken } = b;
  if (typeof intentionId !== 'string' || typeof previousIntentionId !== 'string' || typeof goalId !== 'string' || typeof base !== 'string' || typeof baseSha !== 'string' || typeof branch !== 'string') return null;
  if (typeof ordinal !== 'number' || !Number.isInteger(ordinal) || ordinal < 2 || typeof fencingToken !== 'number') return null;
  if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(baseSha) || !branch) return null;
  return { intentionId, previousIntentionId, goalId, ordinal, base, baseSha, branch, fencingToken };
}

export type WorkBranch = { ok: true; branch: string; prepared: IntentionPreparationRecord | null } | { ok: false; reason: string; detail: Json };

/**
 * The branch a gate works on for this intention. With a completion record: the branch it names (the record
 * must be for this intention, and GateContext.branch, when given, must equal it). Without one: the goal's
 * first branch, and a GateContext.branch is refused (a branch nobody prepared is never committed to).
 */
export async function workBranchOf(ledger: Ledger, redactor: Redactor, branchPrefix: string, ctx: Pick<StepContext, 'runId' | 'goal' | 'intention' | 'branch'>): Promise<WorkBranch> {
  const first = intentionBranchName(branchPrefix, ctx.goal.id, 1);
  const rec = await ledger.getEvidence(preparationKeys(redactor, ctx.runId, ctx.intention.id).done);
  if (!rec) {
    if (ctx.branch !== undefined && ctx.branch !== first) return { ok: false, reason: 'branch-not-prepared', detail: { branch: ctx.branch, note: 'GateContext names a branch no preparation record of this intention backs' } };
    return { ok: true, branch: first, prepared: null };
  }
  const p = rec.kind === 'intention.prepared' && rec.runId === ctx.runId ? preparationRecordOf(rec.body) : null;
  if (!p || p.intentionId !== ctx.intention.id) return { ok: false, reason: 'bad-preparation-record', detail: rec.key };
  if (!p.branch.startsWith(branchPrefix) || p.branch === first) return { ok: false, reason: 'bad-preparation-record', detail: { branch: p.branch, note: 'the prepared branch is not a later-intention branch under repo.branchPrefix' } };
  if (ctx.branch !== p.branch) return { ok: false, reason: 'branch-mismatch', detail: { ctx: ctx.branch ?? null, prepared: p.branch } };
  return { ok: true, branch: p.branch, prepared: p };
}
