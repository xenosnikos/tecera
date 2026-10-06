import type { EnvironmentalCheck, GateRunner, Ledger, LLM, LLMEffort, Manifest, Redactor, SecretInput, VerifyRunner } from '@tecera/contracts';
import { CommitGate, type CommitTestHooks } from './commitGate.js';
import { defaultIds, GateMemo, redactorFrom } from './evidence.js';
import type { GitIdentity } from './gitx.js';
import { PrGate } from './prGate.js';
import { ReviewGate, type WriterIdentity } from './reviewGate.js';
import type { CommitResult, PrResult, ReviewResult, StepContext, VerifyResult } from './types.js';
import { VerifyGate } from './verifyGate.js';

/**
 * Composition of the four host-run gate steps behind contracts' GateRunner. One shared memo carries the
 * last verify/review evidence per intention so the commit gate can compare D1 = D2 = D3 (fingerprints and
 * per-file content records); after a restart the same facts are recovered from the ledger. The gates emit
 * no events. D6: gate.commit commits to the work branch with no approval; gate.pr is the only approval
 * point and consumes GateContext.approval itself (bound to prActionHash of the committed sha). Never merges.
 */

export interface CreateGatesOptions {
  manifest: Manifest;
  ledger: Ledger;
  verifyRunner: VerifyRunner;
  reviewer: LLM;
  /** Every writer seat (planner + workers): provider AND keyFingerprint each, or construction throws. */
  writers: readonly WriterIdentity[];
  /** The leased worktree. GateContext.worktree must equal it ('' or another path is refused). */
  worktree?: string;
  /** Known secret values (>= 8 chars) for the shared redactor; or pass a ready redactor. */
  secrets?: readonly SecretInput[];
  redactor?: Redactor;
  /** Approval session (LoopPorts.sessionId); the PR gate refuses grants of other sessions. */
  sessionId?: string;
  /** Where gate.pr writes `<runId>/pr/` (patch bundle, body, request.json). The runtime passes <project>/.tecera/runs. */
  runsDir?: string;
  /** gh binary for gate.pr: undefined = look up on PATH, null = never open PRs (always pr.requested). */
  gh?: string | null;
  /** Environment for gh (default: a filtered process.env without model keys). */
  ghEnv?: NodeJS.ProcessEnv;
  /** Cost line for the PR body (default: ledger.budgetUsage of the run). */
  costLine?: (runId: string) => Promise<string | null> | string | null;
  now?: () => number;
  ids?: () => string;
  /** Diff base; defaults to manifest.repo.base. */
  base?: string;
  requireVerify?: boolean;
  /** Only tightens the derived read-only-tests rule. */
  testsReadOnly?: boolean;
  reviewModel?: string;
  reviewEffort?: LLMEffort;
  /**
   * Reviewer seat accounting (contracts meteredCall): one call plus usd and tokens reserved per review call
   * on the run's 'calls', 'usd' and 'tokens' pools (the loop/runtime opens them). Default
   * DEFAULT_REVIEW_RESERVATION (usd 0.25, tokens estimated from the prompt). null turns gate-side
   * accounting off: only for a caller that already meters the reviewer LLM itself (e.g. contracts meteredLLM).
   */
  reviewReservation?: { usd: number; tokens?: number } | null;
  identity?: GitIdentity;
  /** Fault injection for crash/recovery tests only. */
  commitTestHooks?: CommitTestHooks;
}

export interface Gates extends GateRunner {
  verify(ctx: StepContext): Promise<VerifyResult>;
  review(ctx: StepContext): Promise<ReviewResult>;
  commit(ctx: StepContext): Promise<CommitResult>;
  pr(ctx: StepContext): Promise<PrResult>;
  /**
   * Preflight baseline verify on the untouched tree; records the run's ignored-file baseline. Pass the
   * adopted goal's check as `check` when the run has one (else the manifest's verify command runs).
   */
  baseline(ctx: { runId: string; worktree?: string; signal?: AbortSignal; check?: EnvironmentalCheck }): Promise<VerifyResult>;
  /**
   * S8 (contracts GateRunner.reconcile): reconcile an interrupted commit for this step's approval. null =
   * no intent recorded; exit 0 + sha = proven (HEAD^{tree} and the index equal the recorded write-tree);
   * anything else is terminal 9. Never commits. A needed HEAD/index repair runs only under ctx.guard
   * (else 9 'reconcile-needs-guard', nothing moved); a proof that needs no repair needs no guard.
   */
  reconcile(ctx: StepContext): Promise<CommitResult | null>;
  readonly verifyGate: VerifyGate;
  readonly reviewGate: ReviewGate;
  readonly commitGate: CommitGate;
  readonly prGate: PrGate;
  readonly memo: GateMemo;
}

const EFFORTS: readonly string[] = ['low', 'medium', 'high'];

export function createGates(o: CreateGatesOptions): Gates {
  const memo = new GateMemo();
  const ids = o.ids ?? defaultIds();
  const base = o.base ?? o.manifest.repo.base;
  const redactor = redactorFrom(o);
  const seatEffort = o.manifest.seats.reviewer.effort;
  const effort = o.reviewEffort ?? (seatEffort && EFFORTS.includes(seatEffort) ? (seatEffort as LLMEffort) : undefined);
  const verifyGate = new VerifyGate({ ledger: o.ledger, manifest: o.manifest, runner: o.verifyRunner, worktree: o.worktree, base, redactor, now: o.now, ids, memo });
  const reviewGate = new ReviewGate({
    reviewer: o.reviewer,
    writers: o.writers,
    ledger: o.ledger,
    worktree: o.worktree,
    base,
    redactor,
    model: o.reviewModel ?? o.manifest.seats.reviewer.model,
    ...(effort ? { effort } : {}),
    ...(o.reviewReservation !== undefined ? { reservation: o.reviewReservation } : {}),
    maxAttempts: o.manifest.review.maxAttempts,
    seatId: 'reviewer',
    memo,
    ids,
    now: o.now,
  });
  const commitGate = new CommitGate({
    ledger: o.ledger,
    manifest: o.manifest,
    worktree: o.worktree,
    base,
    sessionId: o.sessionId,
    requireVerify: o.requireVerify,
    testsReadOnly: o.testsReadOnly,
    identity: o.identity,
    redactor,
    now: o.now,
    ids,
    memo,
    testHooks: o.commitTestHooks,
  });
  const prGate = new PrGate({
    ledger: o.ledger,
    manifest: o.manifest,
    worktree: o.worktree,
    base,
    sessionId: o.sessionId,
    redactor,
    now: o.now,
    ids,
    memo,
    ...(o.runsDir !== undefined ? { runsDir: o.runsDir } : {}),
    ...(o.gh !== undefined ? { gh: o.gh } : {}),
    ...(o.ghEnv ? { ghEnv: o.ghEnv } : {}),
    ...(o.costLine ? { costLine: o.costLine } : {}),
  });
  return {
    verify: (ctx) => verifyGate.verify(ctx),
    review: (ctx) => reviewGate.review(ctx),
    commit: (ctx) => commitGate.commit(ctx),
    pr: (ctx) => prGate.pr(ctx),
    baseline: (ctx) => verifyGate.baseline(ctx),
    reconcile: (ctx) => commitGate.reconcile(ctx),
    verifyGate,
    reviewGate,
    commitGate,
    prGate,
    memo,
  };
}

export { VerifyGate, baselineVerify, scrubbedAllowlist, gateWorktree, resolveCheck } from './verifyGate.js';
export type { VerifyGateOptions, ResolvedCheck } from './verifyGate.js';
export { ReviewGate, SameProviderReview, assertForeign, wrapUntrusted, buildPacket, DEFAULT_REVIEW_RESERVATION } from './reviewGate.js';
export type { ReviewGateOptions, WriterIdentity, ReviewPacket } from './reviewGate.js';
export { CommitGate, testsReadOnlyFor } from './commitGate.js';
export type { CommitGateOptions, CommitTestHooks } from './commitGate.js';
export { PrGate, findOnPath } from './prGate.js';
export type { PrGateOptions } from './prGate.js';
export { actionHash, commitActionHash, prActionHash } from './actionHash.js';
export type { ActionDescriptor, CommitActionInput } from './actionHash.js';
export { snapshotCandidate, buildCandidateTree, fileManifest, manifestMismatch, gitOid, isBinary, ignoredPathKey, ignoredStamp } from './candidate.js';
export type { Candidate, FileRecord, CandidateStatus, BuiltTree, SnapshotOptions, IgnoredBaseline, IgnoredMeta } from './candidate.js';
export { GateMemo, latestVerify, latestReview, claim, writeEvidence, ignoredBaseline, ignoredBaselineKey, ignoredBaselineOf, commandDigest, safeText, IGNORED_BASELINE_VERSION } from './evidence.js';
export type { VerifyMemo, ReviewMemo } from './evidence.js';
export { hostGit, gitEnv, assertSafeRepo, UnsafeRepo, GitFailed, refSafe, DEFAULT_IDENTITY, HOST_GIT_ARGS } from './gitx.js';
export type { GitIdentity, RepoSafety } from './gitx.js';
export { EXIT, TOOLING_EXITS, isTerminalExit } from './types.js';
export type { StepContext, VerifyResult, ReviewResult, CommitResult, PrResult, ReviewReason, VerifyOutcomeKind, GateFailure } from './types.js';
