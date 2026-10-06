import type { GateCommitResult, GateContext, GatePrResult, GateReviewResult, GateVerifyResult } from '@tecera/contracts';

/**
 * Gate results are the contracts' GateRunner results (packages/contracts/src/ports.ts) plus diagnostic
 * fields the loop ignores. `terminal: true` means never retry: policy refusal, human needed, tooling
 * missing, unsafe repository, mutated candidate.
 */

/** The loop's step context (contracts GateContext). Kept under the old name for callers. */
export type StepContext = GateContext;

export type VerifyOutcomeKind = 'passed' | 'failed' | 'tooling' | 'mutated' | 'refused';

export interface VerifyResult extends GateVerifyResult {
  outcome: VerifyOutcomeKind;
  fingerprint: string;
}

export type ReviewReason =
  | 'approved'
  | 'rejected'
  | 'unparseable'
  | 'mutated'
  | 'reviewer-error'
  | 'incomplete'
  | 'incomplete-packet'
  | 'unsafe-repo'
  | 'no-worktree'
  | 'not-foreign'
  | 'claimed'
  | 'reused'
  | 'budget'
  /** The reviewer seat's accounting failed (a reserve or settle the ledger could not do): the run must end. */
  | 'ledger'
  /** A recovered review (GateContext.recovered) with no recorded verdict for (run, D1) and no review attempt left. */
  | 'interrupted';

/** Classification of a terminal gate result (contracts GateResultBase.failure). */
export type GateFailure = 'budget' | 'human' | 'policy' | 'ledger';

export interface ReviewResult extends GateReviewResult {
  reason?: ReviewReason;
  reused?: boolean;
  /** Set on every terminal result: 'budget' (seat could not reserve), 'ledger' (accounting broke), else 'human'. */
  failure?: GateFailure;
}

export interface CommitResult extends GateCommitResult {
  /** Set when the result came from S8 reconciliation of an interrupted commit. */
  reconciled?: boolean;
}

export interface PrResult extends GatePrResult {
  /** opened: pushed and a PR opened (url); requested: patch bundle recorded (no remote / no authenticated gh); refused: terminal. */
  outcome: 'opened' | 'requested' | 'refused';
  /** The recorded outcome of an earlier call for the same step and attempt (nothing spent again). */
  reused?: boolean;
}

/**
 * Exit codes. 0 ok; 1 verify failed (retryable); 8 policy refusal (approval, boundary, tamper, binary):
 * never commit; 9 human needed (digest drift, tree mismatch, mutation, unsafe repo): never retry;
 * 124/126/127 tooling missing or interrupted: never retry.
 */
export const EXIT = { ok: 0, failed: 1, policy: 8, human: 9, timeout: 124, notExecutable: 126, notFound: 127 } as const;
export const TOOLING_EXITS: ReadonlySet<number> = new Set([124, 126, 127]);

/** Exit codes the loop must not retry. */
export function isTerminalExit(code: number): boolean {
  return code === EXIT.policy || code === EXIT.human || TOOLING_EXITS.has(code);
}
