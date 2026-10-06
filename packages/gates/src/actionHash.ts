import { commitActionHash, digest, prActionHash, type CommitActionInput, type JsonObject } from '@tecera/contracts';

/**
 * Approval binding hashes. A grant is only consumable for the exact action it was requested for.
 *
 * - `prActionHash` (D6) is the contracts function the loop requests gate.pr approvals with:
 *   commitActionHash({intentionId, stepId, attempt, candidateD1: committed sha}). The PR gate recomputes it
 *   from GateContext (intention.id, step.id, intention.attempt, commit.sha). Commits take no approval.
 * - `actionHash` is the security.md §4 tool form, sha256(canonicalJSON({tool, method, args, worktree,
 *   candidateDigest})), for tool-level approvals.
 */

export { commitActionHash, prActionHash };
export type { CommitActionInput };

export interface ActionDescriptor {
  tool: string;
  method: string;
  worktree: string;
  candidateDigest: string;
  /** Tool args with handles already replaced by digests. Defaults to {}. */
  args?: JsonObject;
}

export function actionHash(a: ActionDescriptor): string {
  if (!a.tool || !a.method || !a.worktree || !a.candidateDigest) throw new Error('actionHash: tool, method, worktree and candidateDigest are required');
  return digest({ tool: a.tool, method: a.method, args: a.args ?? {}, worktree: a.worktree, candidateDigest: a.candidateDigest });
}
