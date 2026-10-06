import { FenceLost, type Json, type Ledger, type Manifest, type Redactor, type SecretInput, type WriteGuard } from '@tecera/contracts';
import { BoundaryViolation, DEFAULT_CONFIG_GLOBS, DEFAULT_TEST_GLOBS, enforceChanges, matchesAny, tamperFindings } from '@tecera/policy';
import { addedLines, buildCandidateTree, fileManifest, lsTree, manifestMismatch, policyChanges, sameEntries, snapshotCandidate, type BuiltTree, type Candidate } from './candidate.js';
import { claim, commandDigest, defaultIds, errMsg, GateMemo, ignoredBaseline, latestReview, latestVerify, obj, redactorFrom, safeText, writeEvidence, type ReviewMemo, type VerifyMemo } from './evidence.js';
import { assertSafeRepo, DEFAULT_IDENTITY, hostGit, refSafe, UnsafeRepo, type GitIdentity } from './gitx.js';
import { EXIT, type CommitResult, type StepContext } from './types.js';
import { gateWorktree, resolveCheck } from './verifyGate.js';

/**
 * Commit gate (security.md §4 S7–S8, §5). Nothing is committed unless, in order:
 *  1. the GateContext names the gate's worktree and the repository cannot make git run programs (9);
 *  2. HEAD is the base commit, verify passed on D1 running the adopted goal's check (its command digest),
 *     review approved D2, and the host snapshot now (D3) equals both: fingerprints AND per-file {status,
 *     mode, sha256, oid} records (else 9);
 *  3. every change is readable UTF-8 text (binary/unreadable 8), inside allowedChanges and the plan's
 *     write globs, outside protectedPaths, under maxChangedFiles, free of tamper findings, with tests
 *     read-only unless the plan explicitly grants test writes and the goal is not fix-failing-test (8);
 *  4. the candidate tree is built from the exact host-read bytes (hash-object --no-filters, private index)
 *     and the worktree is re-snapshotted unchanged (9);
 *  5. no approval (owner decision D6): the commit lands on the WORK branch tecera/<goal>, never on the
 *     base, and the PR gate is the only approval point. A GateContext approval handed to gate.commit is
 *     ignored, never consumed. Exactly-once per (run, intention, step, attempt) comes from a claim on the
 *     intent record (one writer wins; a loser reconciles);
 *  6. an intent record {expectedTree, parent, branch, headRef, indexTree, D1, D2, D3, files} is
 *     persisted: it names BOTH end states, HEAD on the branch and the worktree index at expectedTree;
 *  7. `commit-tree` + `update-ref` (no hooks, no signing, no porcelain), HEAD moved to the branch, the index
 *     set to the tree, and the result verified: HEAD^{tree} = expected tree, the index writes exactly the
 *     expected tree, and `ls-tree -r` oids/modes = the recorded set (9).
 * Every result is evidence; every non-zero result is terminal (failure 'policy' for 8, 'human' for 9). A
 * call that finds an intent record for its step and attempt reconciles (S8) instead of committing again: the branch
 * commit's tree must be expectedTree on the recorded parent; HEAD is moved to the branch if it still sits
 * on the parent (the 'branch moved, HEAD not moved' window, whether or not the index was already updated),
 * the index is rewritten to expectedTree when it differs (the 'HEAD moved, index not updated' window), and
 * both are verified before anything is recorded; any disagreement is 9 (human).
 *
 * Mutation-time fence (contracts GateContext.guard / WriteGuard): commit() refuses (9 'no-write-guard')
 * without a guard, and calls guard.check() immediately before EACH repository mutation — every object
 * write (hash-object, write-tree, commit-tree), the intent claim, update-ref, symbolic-ref and the index
 * update. A lost fence is 9 'fence-lost' and nothing after it runs. reconcile() proves read-only
 * without a guard; a repair (HEAD or index) needs a guard and is otherwise refused (9
 * 'reconcile-needs-guard') with nothing moved.
 */

export interface CommitGateOptions {
  ledger: Ledger;
  manifest: Manifest;
  /** Expected worktree; a GateContext naming another one is refused. */
  worktree?: string;
  /** Diff base; defaults to manifest.repo.base. */
  base?: string;
  /** Kept for callers; the commit gate takes no approval (D6). */
  sessionId?: string;
  /** Require passing verify evidence on D1. Default true. */
  requireVerify?: boolean;
  /** Only tightens: true forces tests read-only; the derived rule (testsReadOnlyFor) cannot be relaxed. */
  testsReadOnly?: boolean;
  protectedExceptions?: string[];
  exceptionReason?: string;
  maxFileBytes?: number;
  identity?: GitIdentity;
  redactor?: Redactor;
  secrets?: readonly SecretInput[];
  now?: () => number;
  ids?: () => string;
  memo?: GateMemo;
  /** Fault injection for crash/recovery tests only. A throw simulates a crash at that point. */
  testHooks?: CommitTestHooks;
}

export interface CommitTestHooks {
  /** After the candidate tree is built, before the late-writer re-snapshot. */
  afterStage?: () => void | Promise<void>;
  /** After the intent is persisted, before commit-tree. */
  beforeCommit?: () => void | Promise<void>;
  /** After update-ref/HEAD moved, before the post-commit check and the final record. */
  afterRef?: () => void | Promise<void>;
  /** Right before the intent record is claimed. */
  afterConsume?: () => void | Promise<void>;
  /** After HEAD moved to the branch, before the index is updated (the index-recovery window). */
  afterHead?: () => void | Promise<void>;
  /** After update-ref moved the branch, before HEAD is pointed at it (the HEAD-recovery window). */
  afterUpdateRef?: () => void | Promise<void>;
}

/** A usable guard, or null (a guard without check() or signal is no guard). */
function usableGuard(g: WriteGuard | undefined): WriteGuard | null {
  return g && typeof g.check === 'function' && g.signal ? g : null;
}

interface Finding {
  code: string;
  path: string;
  detail: string;
}

/**
 * Tests are read-only unless the plan's write permission names tests explicitly AND the goal is not a
 * fix-failing-test goal (goal id, plan id or plan goalKinds). `override: true` forces read-only.
 */
export function testsReadOnlyFor(ctx: Pick<StepContext, 'goal' | 'plan'>, override?: boolean): boolean {
  if (override === true) return true;
  const kinds = [...(ctx.plan.goalKinds ?? []), ctx.goal.id, ctx.plan.id].join(' ').toLowerCase();
  if (/fix[-_ ]?failing[-_ ]?tests?/.test(kinds)) return true;
  const explicit = (ctx.plan.permissions?.write ?? []).some(
    (g) => matchesAny(g, DEFAULT_TEST_GLOBS) !== null || /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\./.test(g),
  );
  return !explicit;
}

interface Intent {
  expectedTree: string;
  parent: string;
  branch: string;
  /** The tree the worktree index must hold afterwards (= expectedTree). */
  indexTree: string;
}

export class CommitGate {
  private readonly base: string;
  private readonly now: () => number;
  private readonly ids: () => string;
  private readonly redactor: Redactor;
  readonly memo: GateMemo;

  constructor(private readonly o: CommitGateOptions) {
    this.base = o.base ?? o.manifest.repo.base;
    this.now = o.now ?? Date.now;
    this.ids = o.ids ?? defaultIds();
    this.redactor = redactorFrom(o);
    this.memo = o.memo ?? new GateMemo();
  }

  private keys(ctx: StepContext): { intent: string; final: string } {
    const id = `${ctx.intention.id}:${ctx.step.id}:${ctx.intention.attempt}`;
    return { intent: `commit-intent:${ctx.runId}:${id}`, final: `commit:${ctx.runId}:${id}` };
  }

  private failer(ctx: StepContext, record: Record<string, Json>) {
    return async (exitCode: number, reason: string, detail: Json = null): Promise<CommitResult> => {
      const evidenceKey = `commit-refused:${ctx.runId}:${ctx.intention.id}:${ctx.step.id}:${this.ids()}`;
      await writeEvidence(this.o.ledger, this.redactor, {
        key: evidenceKey,
        kind: 'gate.commit',
        runId: ctx.runId,
        body: { ...record, outcome: exitCode === EXIT.human ? 'human' : 'refused', exitCode, reason, detail, humanNeeded: exitCode === EXIT.human, terminal: true, failure: exitCode === EXIT.policy ? 'policy' : 'human' },
      });
      return { exitCode, evidenceKey, reason: safeText(this.redactor, reason), terminal: true, failure: exitCode === EXIT.policy ? 'policy' : 'human' };
    };
  }

  async commit(ctx: StepContext): Promise<CommitResult> {
    const record: Record<string, Json> = { intentionId: ctx.intention.id, stepId: ctx.step.id, goalId: ctx.goal.id, attempt: ctx.intention.attempt };
    const fail = this.failer(ctx, record);
    const guard = usableGuard(ctx.guard);
    if (!guard) return fail(EXIT.human, 'no-write-guard', 'GateContext carries no write guard: the commit gate never mutates the repository without a live fence');
    /** Throws FenceLost when the fence is gone; called right before every mutation below. */
    const fence = () => guard.check();
    const wt = gateWorktree(ctx.worktree, this.o.worktree);
    if (!wt.ok) return fail(EXIT.human, 'no-worktree', wt.reason);
    const dir = wt.dir;
    // D6: no approval here. A grant handed to gate.commit is not ours to spend (the PR gate consumes its own).
    record.approvalIgnored = ctx.approval ? ctx.approval.requestId : null;

    // S8/S9: a recorded intent for this action means a commit may already exist. Reconcile, never redo.
    const rec = await this.reconcile(ctx);
    if (rec) return rec;

    // ---- D3 and the recorded digests ----
    const baseline = await ignoredBaseline(this.o.ledger, this.memo, ctx.runId);
    let snap: Candidate;
    try {
      snap = await snapshotCandidate(dir, this.base, { ignoredBaseline: baseline, signal: ctx.signal });
    } catch (err) {
      return fail(EXIT.human, err instanceof UnsafeRepo ? 'unsafe-repo' : 'snapshot-failed', errMsg(err));
    }
    const d3 = snap.fingerprint;
    record.d3 = d3;
    if (snap.head !== snap.baseCommit) return fail(EXIT.human, 'head-not-base', { head: snap.head, base: snap.baseCommit });

    const bound = await this.boundDigests(ctx, snap);
    if (typeof bound === 'object' && 'exitCode' in bound) return fail(bound.exitCode, bound.reason, bound.detail);
    const { d1, d2 } = bound;
    record.fingerprints = { d1, d2, d3 };

    // ---- classification, boundary and tamper ----
    const committable = snap.files.filter((f) => f.status !== '!');
    if (committable.length === 0) return fail(EXIT.human, 'empty-change');
    const unreadable = snap.files.filter((f) => f.unreadable).map((f) => ({ path: f.path, detail: f.unreadable! }));
    if (unreadable.length) return fail(EXIT.policy, 'unreadable', unreadable);
    const binary = snap.files.filter((f) => f.status !== 'D' && f.binary).map((f) => f.path);
    if (binary.length) return fail(EXIT.policy, 'binary', binary);
    const limit = Math.min(this.o.manifest.budgets.maxChangedFiles, ctx.plan.budget?.maxChangedFiles ?? Infinity, ctx.goal.budget?.maxChangedFiles ?? Infinity);
    if (snap.files.length > limit) return fail(EXIT.policy, 'max-changed-files', { changed: snap.files.length, limit });
    const changes = policyChanges(snap);
    try {
      enforceChanges(
        {
          allowedChanges: this.o.manifest.repo.allowedChanges,
          protectedPaths: this.o.manifest.policy.protectedPaths,
          protectedExceptions: this.o.protectedExceptions,
          reason: this.o.exceptionReason,
          maxFileBytes: this.o.maxFileBytes,
        },
        changes,
      );
    } catch (err) {
      return fail(EXIT.policy, 'boundary', err instanceof BoundaryViolation ? [...err.violations] : errMsg(err));
    }
    const planWrite = ctx.plan.permissions?.write ?? [];
    const outsidePlan = committable.filter((f) => matchesAny(f.path, planWrite) === null).map((f) => f.path);
    if (outsidePlan.length) return fail(EXIT.policy, 'outside-plan-write', outsidePlan);
    const testsReadOnly = testsReadOnlyFor(ctx, this.o.testsReadOnly);
    record.testsReadOnly = testsReadOnly;
    let findings: Finding[];
    try {
      findings = [
        ...tamperFindings(changes, await addedLines(dir, snap, ctx.signal), { testGlobs: DEFAULT_TEST_GLOBS, configGlobs: DEFAULT_CONFIG_GLOBS, testsReadOnly, maxFileBytes: this.o.maxFileBytes }),
        ...(await this.localFindings(dir, snap)),
      ];
    } catch (err) {
      return fail(EXIT.human, 'tamper-check-failed', errMsg(err));
    }
    if (findings.length) return fail(EXIT.policy, 'tamper', findings as unknown as Json);

    // ---- build the tree from the recorded bytes; the worktree must not have moved meanwhile ----
    let built: BuiltTree;
    try {
      built = await buildCandidateTree(dir, snap, ctx.signal, fence);
    } catch (err) {
      if (err instanceof FenceLost) return fail(EXIT.human, 'fence-lost', errMsg(err));
      return fail(EXIT.human, 'stage-failed', errMsg(err));
    }
    record.expectedTree = built.tree;
    await this.o.testHooks?.afterStage?.();
    const recheck = await snapshotCandidate(dir, this.base, { ignoredBaseline: baseline }).then(
      (s) => s.fingerprint,
      () => 'unreadable',
    );
    if (recheck !== d3) return fail(EXIT.human, 'digest-drift-before-commit', { d3, now: recheck });

    const branch = `${this.o.manifest.repo.branchPrefix}${refSafe(ctx.goal.id)}`;
    record.branch = branch;
    try {
      await hostGit(dir, ['check-ref-format', '--branch', branch]);
    } catch {
      return fail(EXIT.policy, 'bad-branch-name', branch);
    }
    const existing = await this.refOid(dir, `refs/heads/${branch}`);
    if (existing && existing !== snap.head) return fail(EXIT.human, 'branch-exists', { branch, at: existing });
    if (ctx.signal?.aborted) return fail(EXIT.human, 'cancelled');

    try {
      fence();
    } catch (err) {
      return fail(EXIT.human, 'fence-lost', errMsg(err));
    }
    await this.o.testHooks?.afterConsume?.();

    // ---- S8: durable intent before anything moves; it names both end states (HEAD and index) ----
    // Claimed (create-if-absent with a nonce): of two concurrent calls for one step exactly one proceeds.
    const { intent: intentKey, final: finalKey } = this.keys(ctx);
    const message = this.message(ctx, d1);
    const intent: Record<string, Json> = {
      ...record,
      expectedTree: built.tree,
      parent: snap.head,
      branch,
      headRef: `refs/heads/${branch}`,
      indexTree: built.tree,
      steps: ['commit-tree', 'update-ref', 'symbolic-ref HEAD', 'read-tree (index)'],
      files: fileManifest(snap),
      message,
      at: this.now(),
    };
    try {
      fence();
      const won = await claim(this.o.ledger, this.redactor, intentKey, 'gate.commit.intent', ctx.runId, intent);
      if (!won.won) {
        // Another call for this step claimed the intent first: never commit twice; prove its commit instead.
        const rec = await this.reconcile(ctx);
        return rec ?? fail(EXIT.human, 'intent-claimed', 'another commit of this step holds the intent');
      }
    } catch (err) {
      return fail(EXIT.human, err instanceof FenceLost ? 'fence-lost' : 'intent-not-recorded', errMsg(err));
    }
    await this.o.testHooks?.beforeCommit?.();

    // ---- commit with plumbing only ----
    const id = this.o.identity ?? DEFAULT_IDENTITY;
    const env = { GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email };
    let sha: string;
    try {
      fence();
      sha = (await hostGit(dir, ['commit-tree', '--no-gpg-sign', built.tree, '-p', snap.head, '-F', '-'], { input: message, env })).trim();
      const zero = snap.safety.objectFormat === 'sha256' ? '0'.repeat(64) : '0'.repeat(40);
      fence();
      await hostGit(dir, ['update-ref', '-m', `tecera: commit ${ctx.goal.id}`, `refs/heads/${branch}`, sha, existing ?? zero]);
      await this.o.testHooks?.afterUpdateRef?.();
      fence();
      await hostGit(dir, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    } catch (err) {
      return fail(EXIT.human, err instanceof FenceLost ? 'fence-lost' : 'commit-failed', errMsg(err));
    }
    await this.o.testHooks?.afterHead?.();
    try {
      fence();
      await hostGit(dir, ['read-tree', built.tree]);
    } catch (err) {
      return fail(EXIT.human, err instanceof FenceLost ? 'fence-lost' : 'index-update-failed', errMsg(err));
    }
    await this.o.testHooks?.afterRef?.();
    return this.verifyAndRecord(ctx, dir, { expectedTree: built.tree, parent: snap.head, branch, indexTree: built.tree }, finalKey, sha, built.entries, record, false);
  }

  /**
   * S8 reconciliation for this action (run, intention, step, attempt). Returns
   * null when no intent was recorded (nothing to reconcile); otherwise the recorded result: exit 0 when the
   * branch head commit has exactly the expected tree on the recorded parent, else 9.
   */
  async reconcile(ctx: StepContext): Promise<CommitResult | null> {
    const { intent: intentKey, final: finalKey } = this.keys(ctx);
    const record: Record<string, Json> = { intentionId: ctx.intention.id, stepId: ctx.step.id, goalId: ctx.goal.id, attempt: ctx.intention.attempt, reconcile: true };
    const fail = this.failer(ctx, record);
    const ib = obj((await this.o.ledger.getEvidence(intentKey))?.body);
    if (!ib) return null;
    if (typeof ib.expectedTree !== 'string' || typeof ib.parent !== 'string' || typeof ib.branch !== 'string') return fail(EXIT.human, 'reconcile-bad-intent', intentKey);
    if (ib.indexTree !== undefined && ib.indexTree !== ib.expectedTree) return fail(EXIT.human, 'reconcile-bad-intent', 'intent index tree differs from its expected tree');
    const intent: Intent = { expectedTree: ib.expectedTree, parent: ib.parent, branch: ib.branch, indexTree: ib.expectedTree };
    // The intent must be for exactly this action: same intention, step and attempt.
    if (ib.intentionId !== ctx.intention.id || ib.stepId !== ctx.step.id || ib.attempt !== ctx.intention.attempt) {
      return fail(EXIT.human, 'reconcile-action-mismatch', 'the intent under this key was recorded for a different action');
    }
    const final = obj((await this.o.ledger.getEvidence(finalKey))?.body);
    if (final && final.outcome === 'committed' && typeof final.sha === 'string') return { exitCode: EXIT.ok, sha: final.sha, evidenceKey: finalKey, reconciled: true, terminal: false };
    // Carry the bound digests (D1 = D2 = D3) onto the reconciled record: the PR gate reads them from it.
    Object.assign(record, { intentKey, expectedTree: intent.expectedTree, branch: intent.branch, ...(obj(ib.fingerprints) ? { fingerprints: ib.fingerprints! } : {}) });
    const wt = gateWorktree(ctx.worktree, this.o.worktree);
    if (!wt.ok) return fail(EXIT.human, 'no-worktree', wt.reason);
    const dir = wt.dir;
    try {
      await assertSafeRepo(dir, ctx.signal);
    } catch (err) {
      return fail(EXIT.human, 'unsafe-repo', errMsg(err));
    }
    const sha = await this.refOid(dir, `refs/heads/${intent.branch}`);
    if (!sha || sha === intent.parent) return fail(EXIT.human, 'reconcile-no-commit', 'intent recorded but the branch has no commit for it (interrupted before update-ref); a human must look');
    const tree = (await hostGit(dir, ['rev-parse', '--verify', '--quiet', `${sha}^{tree}`]).catch(() => '')).trim();
    if (tree !== intent.expectedTree) return fail(EXIT.human, 'reconcile-tree-mismatch', { expectedTree: intent.expectedTree, branchTree: tree, sha });
    let expected: Map<string, { mode: string; oid: string }>;
    const guard = usableGuard(ctx.guard);
    const repaired: string[] = [];
    try {
      expected = new Map([...(await lsTree(dir, intent.expectedTree))].map(([p, e]) => [p, { mode: e.mode, oid: e.oid }]));
      // Which end states are missing? Read-only first; a repair needs the fence.
      const headRef = (await hostGit(dir, ['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim();
      const needHead = headRef !== `refs/heads/${intent.branch}`;
      if (needHead) {
        // HEAD may not have been moved yet: finish that step only if HEAD still sits on the recorded parent.
        const head = await this.refOid(dir, 'HEAD');
        if (head !== intent.parent) return fail(EXIT.human, 'reconcile-head-moved', { head, parent: intent.parent, headRef });
      }
      // A crash after symbolic-ref (or anything since) can leave another index behind.
      const needIndex = !indexEquals(await indexEntries(dir), expected);
      if ((needHead || needIndex) && !guard) {
        return fail(EXIT.human, 'reconcile-needs-guard', { note: 'the commit is proven but HEAD or the index must be repaired, and GateContext carries no write guard; nothing was moved', needHead, needIndex, sha });
      }
      if (needHead) {
        guard!.check();
        await hostGit(dir, ['symbolic-ref', 'HEAD', `refs/heads/${intent.branch}`]);
        repaired.push('head');
      }
      if (needIndex) {
        guard!.check();
        await hostGit(dir, ['read-tree', intent.indexTree]);
        repaired.push('index');
      }
    } catch (err) {
      return fail(EXIT.human, err instanceof FenceLost ? 'fence-lost' : 'reconcile-repair-failed', errMsg(err));
    }
    record.repaired = repaired;
    return this.verifyAndRecord(ctx, dir, intent, finalKey, sha, expected, record, true);
  }

  private async verifyAndRecord(ctx: StepContext, dir: string, intent: Intent, finalKey: string, sha: string, entries: Map<string, { mode: string; oid: string }>, record: Record<string, Json>, reconciled: boolean): Promise<CommitResult> {
    const fail = this.failer(ctx, { ...record, sha });
    let headTree: string;
    let headRef: string;
    let headSha: string;
    let parent: string;
    let index: Map<string, { mode: string; oid: string; stage: string }>;
    let committed: Map<string, { mode: string; oid: string }>;
    try {
      headRef = (await hostGit(dir, ['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim();
      headSha = (await hostGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).trim();
      headTree = (await hostGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{tree}'])).trim();
      parent = (await hostGit(dir, ['rev-parse', '--verify', '--quiet', `${sha}^1`])).trim();
      committed = new Map([...(await lsTree(dir, sha))].map(([p, e]) => [p, { mode: e.mode, oid: e.oid }]));
      // The worktree index, read-only (`ls-files --stage` lists index entries; no worktree read, no write).
      index = await indexEntries(dir);
    } catch (err) {
      return fail(EXIT.human, 'post-commit-check-failed', errMsg(err));
    }
    if (headRef !== `refs/heads/${intent.branch}` || headSha !== sha) return fail(EXIT.human, 'head-mismatch', { headRef, headSha, branch: intent.branch, sha });
    if (headTree !== intent.expectedTree) return fail(EXIT.human, 'tree-mismatch', { expectedTree: intent.expectedTree, headTree, sha });
    if (parent !== intent.parent) return fail(EXIT.human, 'parent-mismatch', { expected: intent.parent, parent, sha });
    if (!sameEntries(committed, entries)) return fail(EXIT.human, 'committed-entries-mismatch', { sha });
    const indexBad = [...index].filter(([p, e]) => e.stage !== '0' || entries.get(p)?.mode !== e.mode || entries.get(p)?.oid !== e.oid).map(([p]) => p);
    for (const p of entries.keys()) if (!index.has(p)) indexBad.push(p);
    if (indexBad.length) return fail(EXIT.human, 'index-mismatch', { expectedTree: intent.indexTree, paths: indexBad.slice(0, 20), sha });
    const indexTree = intent.indexTree;
    await writeEvidence(this.o.ledger, this.redactor, {
      key: finalKey,
      kind: 'gate.commit',
      runId: ctx.runId,
      body: { ...record, outcome: 'committed', exitCode: 0, sha, tree: intent.expectedTree, indexTree, parent: intent.parent, branch: intent.branch, reconciled, terminal: false },
    });
    return { exitCode: EXIT.ok, sha, evidenceKey: finalKey, terminal: false, ...(reconciled ? { reconciled: true } : {}) };
  }

  /** D1 (verify), D2 (review) from evidence, checked against GateContext and the snapshot now (D3). */
  private async boundDigests(ctx: StepContext, snap: Candidate): Promise<{ d1: string; d2: string } | { exitCode: number; reason: string; detail: Json }> {
    const h = (reason: string, detail: Json = null) => ({ exitCode: EXIT.human, reason, detail });
    const p = (reason: string, detail: Json = null) => ({ exitCode: EXIT.policy, reason, detail });
    const d3 = snap.fingerprint;
    const verify: VerifyMemo | null = await latestVerify(this.o.ledger, this.memo, ctx.runId, ctx.intention.id);
    const review: ReviewMemo | null = await latestReview(this.o.ledger, this.memo, ctx.runId, ctx.intention.id);
    if (!review) return h('no-reviewed-digest');
    if (review.verdict !== 'approve') return p('review-not-approved');
    if (review.d1 !== review.d2) return h('review-digest-drift', { d1: review.d1, d2: review.d2 });
    const d2 = review.d2;
    if (ctx.candidate?.d2 !== undefined && ctx.candidate.d2 !== d2) return h('review-digest-mismatch', { ctx: ctx.candidate.d2, evidence: d2 });
    let d1: string;
    if (verify) {
      if (verify.outcome !== 'passed') return p('verify-not-passed');
      // The verify that passed must have run the adopted goal's check, not another command.
      const chk = resolveCheck(ctx.goal, this.o.manifest);
      if (!chk.ok) return h('goal-check-invalid', chk.reason);
      if (verify.commandDigest !== commandDigest(chk.check.command)) return h('verify-check-mismatch', { expected: chk.check.source, note: 'the passing verify did not run the goal check' });
      d1 = verify.fingerprint;
    } else if (this.o.requireVerify === false) d1 = review.d1;
    else return h('no-verify-evidence');
    if (ctx.candidate?.d1 !== undefined && ctx.candidate.d1 !== d1) return h('verify-digest-mismatch', { ctx: ctx.candidate.d1, evidence: d1 });
    if (!d1) return p('null-d1', 'refusing to commit a candidate with no verified fingerprint');
    if (d1 !== d2 || d1 !== d3) return h('digest-drift', { d1, d2, d3 });
    const vm = verify ? manifestMismatch(verify.files, snap) : [];
    const rm = manifestMismatch(review.files, snap);
    if (vm === null || rm === null) return h('no-content-record', 'verify or review evidence lacks the per-file content record');
    if (vm.length || rm.length) return h('content-mismatch', { verify: vm, review: rm });
    return { d1, d2 };
  }

  /** Checks policy's tamperFindings does not cover: hardlinks, new executables, any package.json scripts diff. */
  private async localFindings(dir: string, snap: Candidate): Promise<Finding[]> {
    const out: Finding[] = [];
    for (const f of snap.files) {
      if (f.nlink !== undefined && f.nlink > 1) out.push({ code: 'hardlink', path: f.path, detail: `st_nlink=${f.nlink}` });
      if (f.status === 'A' && f.mode === '100755') out.push({ code: 'mode-change', path: f.path, detail: 'new executable file' });
      if (f.path === 'package.json' || f.path.endsWith('/package.json')) {
        const now = f.status === 'D' ? undefined : scriptsOf(snap.content.get(f.path)?.toString('utf8'));
        const before = f.baseOid ? scriptsOf(await hostGit(dir, ['cat-file', 'blob', f.baseOid])) : undefined;
        if (now === null || before === null) out.push({ code: 'scripts-edit', path: f.path, detail: 'package.json is not parseable JSON' });
        else if (JSON.stringify(now ?? {}) !== JSON.stringify(before ?? {})) out.push({ code: 'scripts-edit', path: f.path, detail: 'package.json scripts changed' });
      }
    }
    return out;
  }

  private async refOid(dir: string, ref: string): Promise<string | null> {
    const out = await hostGit(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch(() => '');
    return out.trim() || null;
  }

  private message(ctx: StepContext, d1: string): string {
    const statement = this.redactor.redactText(ctx.goal.statement);
    const subject = statement.split('\n')[0]!.replace(/\s+/g, ' ').trim().slice(0, 72) || ctx.goal.id;
    return [
      `tecera: ${subject}`,
      '',
      `Tecera-Run: ${ctx.runId}`,
      `Tecera-Goal: ${ctx.goal.id}`,
      `Tecera-Intention: ${ctx.intention.id}`,
      `Tecera-Candidate: ${d1}`,
      '',
    ].join('\n');
  }
}

/** True when the index holds exactly `entries` at stage 0. */
function indexEquals(index: Map<string, { mode: string; oid: string; stage: string }>, entries: Map<string, { mode: string; oid: string }>): boolean {
  if (index.size !== entries.size) return false;
  for (const [p, e] of index) {
    const x = entries.get(p);
    if (e.stage !== '0' || !x || x.mode !== e.mode || x.oid !== e.oid) return false;
  }
  return true;
}

/** Index entries (path → {mode, oid, stage}) from `ls-files -z --stage`: names and objects only. */
async function indexEntries(dir: string): Promise<Map<string, { mode: string; oid: string; stage: string }>> {
  const out = new Map<string, { mode: string; oid: string; stage: string }>();
  for (const rec of (await hostGit(dir, ['ls-files', '-z', '--stage'])).split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, oid, stage] = rec.slice(0, tab).split(' ');
    const path = rec.slice(tab + 1);
    // A path listed twice (conflict stages) can never equal a tree: keep a non-zero stage to fail on it.
    const prev = out.get(path);
    if (!prev || stage !== '0') out.set(path, { mode: mode!, oid: oid!, stage: prev && prev.stage !== '0' ? prev.stage : stage! });
  }
  return out;
}

/** Canonical scripts object of a package.json text; undefined = no file; null = unparseable. */
function scriptsOf(text: string | undefined): Record<string, unknown> | undefined | null {
  if (text === undefined) return undefined;
  try {
    const v = JSON.parse(text) as { scripts?: unknown };
    const s = v && typeof v === 'object' ? v.scripts : undefined;
    if (s === undefined) return {};
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    return Object.fromEntries(Object.entries(s as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)));
  } catch {
    return null;
  }
}
