import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  acceptedContractOf,
  answerCriterionActionHash,
  approvalAuditProblem,
  capabilityInventoryOf,
  criteriaProofProblem,
  criterionEvidenceKey,
  FenceLost,
  isFidelity,
  prActionHash,
  requireApproval,
  resourceRegistryOf,
  reviewEvidenceKey,
  weakestFidelity,
  type AcceptanceContract,
  type AchievementProof,
  type CriterionProof,
  type Fidelity,
  type GateApproval,
  type Json,
  type Ledger,
  type Manifest,
  type ProvisionedResource,
  type Redactor,
  type SecretInput,
  type TeceraEvent,
  type WriteGuard,
} from '@tecera/contracts';
import { contractOf, criterionFidelity, inventoryById } from './criteria.js';
import { claim, commandDigest, commitEvidenceKey, defaultIds, errMsg, GateMemo, keyPart, obj, redactorFrom, safeText, usableGuard, verifyMemoFrom, writeEvidence } from './evidence.js';
import { assertSafeRepo, gitEnv, hostGit, refSafe, UnsafeRepo } from './gitx.js';
import { EXIT, type PrResult, type StepContext } from './types.js';
import { gateWorktree, resolveCheck } from './verifyGate.js';

/**
 * PR gate (owner decision D6): the ONLY approval point of a code-changing plan. The plan ends
 * worker → gate.verify → gate.review → gate.verify → gate.commit → gate.pr; gate.commit has already put the
 * verified, reviewed candidate on the work branch tecera/<goal> without approval. gate.pr delivers it:
 *
 *  1. GateContext carries a live write guard (9) and the gate has a session (8), names the gate's worktree,
 *     the repository cannot make git run programs, and ctx.commit names the committed sha (9 / 8);
 *  2. the commit evidence is a gate.commit 'committed' record of THIS run under the deterministic key of a
 *     gate.commit step that precedes this PR step in the plan, for this goal, intention and attempt and this
 *     sha; its branch is the work branch of this goal and still points at the sha, and the commit's tree and
 *     parent are the recorded ones (9);
 *  3. a review.passed verdict for the committed D1 exists (reviewEvidenceKey(run, D1), approve, D1 = D2),
 *     and the latest verify of the intention is an audited verify.passed event naming gate.verify evidence
 *     of this run that ran the goal check to exit 0 on D1: the proof of achievement, its verifiedAt the
 *     event's time (never synthesized) (9);
 *  4. with an acceptance contract (GateContext.contract): the run's ledger says it was accepted with this
 *     hash; every command criterion has passing gate.verify evidence under criterionEvidenceKey(run, id, D1)
 *     and every human criterion a 'yes' answer whose approval (answerCriterionActionHash, this session) a
 *     human other than its requester granted, audited; a criterion without a proof refuses the PR (9). Each
 *     proof's fidelity is the weakest of the capabilities it requires on the run's ledger inventory and in
 *     GateContext.inventory and of every fidelity already recorded for it: a mock is never reported real.
 *     Anything mocked makes the PR provisional (title, body, request.json, result). Resources provisioned
 *     for the goal and still pending are listed with locator, teardown and expiry (never a credential); a
 *     registry with problems or over the allowance refuses (9);
 *  5. the push target (`git remote get-url --push`, after any URL rewriting) is a local path, file://,
 *     ssh:// or scp-style ssh, or https:// without a password (else 8, before anything is spent);
 *  6. the title, body, patch, request and every evidence key the delivery names are free of registered
 *     secrets and canaries: a secret-bearing delivery is refused (8, pr.failed), never redacted into an
 *     invalid patch and never delivered;
 *  7. GateContext.approval is for exactly this PR — contracts prActionHash({intentionId, stepId, attempt,
 *     sha}) — granted by a human other than the requester, in this run and the gate's session, unexpired;
 *     the gate claims the delivery and consumes the grant itself, exactly once (8);
 *  8. when the worktree has an 'origin' remote, it must have exactly one push URL, on an allowed transport
 *     (8 'transport-refused' otherwise, before the grant is spent). The sha is pushed to that URL by value,
 *     `git push <url> <sha>:refs/heads/<branch>`, from an empty repository made for the push (the delivered
 *     repository's config is never read by it), with hooks off, no credential helper, no prompts, ssh in
 *     BatchMode and every transport refused but file/ssh/https (protocol.allow=never first; a push that
 *     needs interactive auth fails: 9, fail closed); the remote ref is then read back and must be the sha;
 *  9. when gh is on PATH and `gh auth status` succeeds and the branch was pushed, `gh pr create --base <base>
 *     --head <branch> --title … --body-file -` with a body built from the run evidence (goal, proof,
 *     criteria and their fidelity, pending transfers, review verdict, cost line) → url (pr.opened);
 * 10. otherwise the gate writes a patch bundle (git format-patch), the PR body and request.json under
 *     <runsDir>/<run>/pr/ and returns exit 0 with reason 'pr-requested' and no url (the loop records
 *     pr.requested). A PR step is done either way.
 * The fence is checked again right before the claim, the push, gh and every bundle write: a lost fence stops
 * delivery (9 'fence-lost'). Tecera never merges: no merge, no auto-merge flag, no push to the base branch. Every result is evidence
 * (kind 'gate.pr'); every non-zero result is terminal ('policy' for 8, 'human' for 9). A second call for
 * the same (run, intention, step, attempt) returns the recorded outcome and spends nothing.
 */

export interface PrGateOptions {
  ledger: Ledger;
  manifest: Manifest;
  /** Expected worktree; a GateContext naming another one is refused. */
  worktree?: string;
  /** The PR base; defaults to manifest.repo.base. */
  base?: string;
  /** Session approvals must belong to (LoopPorts.sessionId). Required: without it every PR is refused (8). */
  sessionId?: string;
  /**
   * Directory under which `<runId>/pr/` receives the patch bundle (the runtime passes <project>/.tecera/runs).
   * Default: `.tecera/runs` next to the main repository's git dir (git rev-parse --git-common-dir).
   */
  runsDir?: string;
  /** Path of the gh binary; undefined = look it up on PATH; null = never use gh (pr.requested). */
  gh?: string | null;
  /** Environment for gh (auth comes from its own config or GH_TOKEN). Default: a filtered process.env. */
  ghEnv?: NodeJS.ProcessEnv;
  /** Remote to push to. Default 'origin'. */
  remote?: string;
  /** Timeout for each push / gh call. Default 120 s. */
  timeoutMs?: number;
  /** Optional cost line for the PR body; default: the ledger's budgetUsage for the run when available. */
  costLine?: (runId: string) => Promise<string | null> | string | null;
  redactor?: Redactor;
  secrets?: readonly SecretInput[];
  now?: () => number;
  ids?: () => string;
  memo?: GateMemo;
}

/**
 * Transports a push may use: every protocol is refused first (protocol.allow=never, also in HOST_GIT_ARGS),
 * then file, ssh and https alone are allowed. ext::, git://, http://, fd:: and any remote helper stay refused.
 */
export const PUSH_PROTOCOLS: readonly string[] = ['-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'protocol.https.allow=always'];

/**
 * Why `url` (the effective push URL, after insteadOf / pushInsteadOf rewriting) is not a transport gate.pr
 * pushes over, or null: a local path, file://, ssh:// or scp-style ssh, or https:// without a password.
 * The git layer refuses everything else again (PUSH_PROTOCOLS); this check refuses before anything is spent.
 */
export function pushUrlProblem(url: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (!url || /[\u0000-\u001f\u007f\s]/.test(url)) return 'push URL is empty or carries whitespace or control characters';
  if (url.startsWith('-')) return 'push URL looks like an option';
  if (url.includes('::')) return `remote helper transport ${JSON.stringify(url.slice(0, url.indexOf('::')))} is not allowed`;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (scheme !== 'file' && scheme !== 'ssh' && scheme !== 'https' && scheme !== 'git+ssh' && scheme !== 'ssh+git') return `transport ${scheme} is not allowed (file, ssh, https only)`;
    const auth = /^[^:]+:\/\/([^/?#]*)@/.exec(url)?.[1];
    if (auth !== undefined && auth.includes(':')) return 'push URL carries a password';
    return null;
  }
  // No scheme: a local path, or scp-style ssh ([user@]host:path) when a colon comes before any slash.
  const colon = url.indexOf(':');
  const slash = url.indexOf('/');
  if (colon > 0 && (slash === -1 || colon < slash)) return /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:[^:]/.test(url) ? null : 'push URL is neither a path nor an ssh address';
  return null;
}
/** True when a push URL pushUrlProblem accepted is a local path (no scheme, not scp-style ssh). */
function localPath(url: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) return false;
  const colon = url.indexOf(':');
  const slash = url.indexOf('/');
  return !(colon > 0 && (slash === -1 || colon < slash));
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Variables gh may see by default: nothing from the supervisor (no model keys). */
const GH_ENV_KEYS = ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'];

interface Proc {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

function runProc(cmd: string, args: readonly string[], o: { cwd: string; env: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal }): Promise<Proc> {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal });
    } catch (err) {
      return done({ code: null, stdout: '', stderr: '', error: errMsg(err) });
    }
    const out: Buffer[] = [];
    const errb: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => {
      if (out.reduce((n, x) => n + x.length, 0) < 1024 * 1024) out.push(b);
    });
    child.stderr.on('data', (b: Buffer) => {
      if (errb.reduce((n, x) => n + x.length, 0) < 64 * 1024) errb.push(b);
    });
    let error: string | undefined;
    child.on('error', (e) => {
      error = e.message;
    });
    child.on('close', (code) => done({ code: error ? null : code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errb).toString('utf8'), ...(error ? { error } : {}) }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(o.input ?? '');
  });
}

/** Absolute path of an executable named `name` on `path`, or null. */
export function findOnPath(name: string, path: string | undefined): string | null {
  for (const d of (path ?? '').split(':')) {
    if (!d || !isAbsolute(d)) continue;
    const p = join(d, name);
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return null;
}

type Proof = AchievementProof;

export class PrGate {
  private readonly base: string;
  private readonly now: () => number;
  private readonly ids: () => string;
  private readonly redactor: Redactor;
  readonly memo: GateMemo;

  constructor(private readonly o: PrGateOptions) {
    this.base = o.base ?? o.manifest.repo.base;
    this.now = o.now ?? Date.now;
    this.ids = o.ids ?? defaultIds();
    this.redactor = redactorFrom(o);
    this.memo = o.memo ?? new GateMemo();
  }

  private keys(ctx: StepContext): { intent: string; final: string } {
    const id = `${ctx.runId}:${ctx.intention.id}:${ctx.step.id}:${ctx.intention.attempt}`;
    return { intent: `pr-intent:${id}`, final: `pr:${id}` };
  }

  private failer(ctx: StepContext, record: Record<string, Json>) {
    return async (exitCode: number, reason: string, detail: Json = null): Promise<PrResult> => {
      const evidenceKey = `pr-refused:${keyPart(this.redactor, `${ctx.runId}:${ctx.intention.id}:${ctx.step.id}`)}:${this.ids()}`;
      const failure = exitCode === EXIT.policy ? 'policy' : 'human';
      await writeEvidence(this.o.ledger, this.redactor, {
        key: evidenceKey,
        kind: 'gate.pr',
        runId: ctx.runId,
        body: { ...record, outcome: exitCode === EXIT.human ? 'human' : 'refused', exitCode, reason, detail, humanNeeded: exitCode === EXIT.human, terminal: true, failure },
      });
      return { exitCode, sha: typeof record.sha === 'string' ? record.sha : '', evidenceKey, reason: safeText(this.redactor, reason), terminal: true, failure, outcome: 'refused' };
    };
  }

  async pr(ctx: StepContext): Promise<PrResult> {
    const sha = typeof ctx.commit?.sha === 'string' ? ctx.commit.sha : '';
    const record: Record<string, Json> = { intentionId: ctx.intention.id, stepId: ctx.step.id, goalId: ctx.goal.id, attempt: ctx.intention.attempt, sha, base: this.base };
    const fail = this.failer(ctx, record);
    if (ctx.step.kind !== 'gate.pr') return fail(EXIT.policy, 'not-a-pr-step', ctx.step.kind);
    if (typeof this.o.sessionId !== 'string' || !this.o.sessionId) return fail(EXIT.policy, 'no-session', 'the PR gate has no approval session: grants of any session would be accepted, so none is');
    const guard = usableGuard(ctx.guard);
    if (!guard) return fail(EXIT.human, 'no-write-guard', 'GateContext carries no write guard: the PR gate never delivers without a live fence');
    const wt = gateWorktree(ctx.worktree, this.o.worktree);
    if (!wt.ok) return fail(EXIT.human, 'no-worktree', wt.reason);
    const dir = wt.dir;
    if (!SHA.test(sha)) return fail(EXIT.policy, 'no-commit', 'GateContext.commit names no committed sha: gate.pr delivers only a recorded commit');

    // A recorded outcome for this step and attempt: return it, spend nothing, push nothing.
    const { intent: intentKey, final: finalKey } = this.keys(ctx);
    const done = obj((await this.o.ledger.getEvidence(finalKey))?.body);
    if (done) {
      if (done.sha !== sha || (done.outcome !== 'opened' && done.outcome !== 'requested')) return fail(EXIT.human, 'recorded-for-another-commit', { recorded: done.sha ?? null });
      return this.resultOf(done, finalKey, true);
    }
    if (await this.o.ledger.getEvidence(intentKey)) {
      return fail(EXIT.human, 'pr-interrupted', 'a delivery of this step was started (grant claimed) and never recorded: a human must check the remote and the run');
    }

    const approval = ctx.approval;
    if (!approval) return fail(EXIT.policy, 'approval-missing', 'gate.pr is the approval point: GateContext carries no human approval');

    try {
      await assertSafeRepo(dir, ctx.signal);
    } catch (err) {
      return fail(EXIT.human, err instanceof UnsafeRepo ? 'unsafe-repo' : 'repo-unreadable', errMsg(err));
    }

    // ---- the commit: recorded by this run's preceding commit gate, on this goal's work branch, untouched since ----
    const commit = await this.commitEvidence(ctx, sha);
    if ('reason' in commit) return fail(EXIT.human, commit.reason, commit.detail);
    const branch = `${this.o.manifest.repo.branchPrefix}${refSafe(ctx.goal.id)}`;
    record.branch = branch;
    if (commit.branch !== branch) return fail(EXIT.human, 'not-the-work-branch', { recorded: commit.branch, expected: branch });
    if (branch === this.base || `refs/heads/${branch}` === this.base) return fail(EXIT.policy, 'branch-is-base', branch);
    const at = (await hostGit(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]).catch(() => '')).trim();
    if (at !== sha) return fail(EXIT.human, 'branch-moved', { branch, at: at || null, sha });
    const tree = (await hostGit(dir, ['rev-parse', '--verify', '--quiet', `${sha}^{tree}`]).catch(() => '')).trim();
    const parent = (await hostGit(dir, ['rev-parse', '--verify', '--quiet', `${sha}^1`]).catch(() => '')).trim();
    if (tree !== commit.tree || parent !== commit.parent) return fail(EXIT.human, 'commit-mismatch', { tree, parent, recorded: { tree: commit.tree, parent: commit.parent } });
    const d1 = commit.d1;
    record.d1 = d1;
    if (ctx.commit?.d1 !== undefined && ctx.commit.d1 !== d1) return fail(EXIT.human, 'commit-d1-mismatch', { ctx: ctx.commit.d1, evidence: d1 });

    // ---- review.passed for the committed D1, and the audited verify that proves achievement ----
    const review = await this.reviewFor(ctx.runId, d1);
    if ('reason' in review) return fail(EXIT.human, review.reason, review.detail);
    const events: TeceraEvent[] = [];
    for await (const e of this.o.ledger.events({ runId: ctx.runId })) events.push(e);
    const found = await this.proofFor(ctx, d1, events);
    if ('reason' in found) return fail(EXIT.human, found.reason, found.detail);
    let proof: Proof = found;
    record.review = { evidenceKey: review.key, verdict: 'approve', reviewer: review.reviewer };

    // ---- the acceptance contract: every criterion proven on D1, at the fidelity its capabilities allow ----
    const crit = await this.criteriaFor(ctx, d1, proof.verifiedAt, events, approval);
    if ('reason' in crit) return fail(EXIT.human, crit.reason, crit.detail);
    if (crit.contract) {
      proof = { ...proof, contractHash: crit.hash, criteria: crit.proofs, fidelity: crit.fidelity };
      Object.assign(record, { contractHash: crit.hash, fidelity: crit.fidelity, provisional: crit.fidelity === 'mocked', criteria: crit.proofs as unknown as Json });
    }
    const provisional = crit.contract !== undefined && crit.fidelity === 'mocked';
    record.proof = { ...proof } as unknown as Json;

    // ---- the debts: resources provisioned for this goal and still pending transfer ----
    const res = this.pendingFor(ctx, events);
    if ('reason' in res) return fail(EXIT.human, res.reason, res.detail);
    record.pendingTransfer = res.pending.map(transferLine) as unknown as Json;

    // ---- where the branch would go: an allowed transport, decided before anything is spent ----
    const remote = this.o.remote ?? 'origin';
    const url = await this.remoteUrl(dir, remote);
    const pushUrls = url ? await this.pushUrls(dir, remote) : [];
    // Exactly one destination: `git push <remote>` would deliver to every push URL the repository lists,
    // checked or not. The push below goes to this one URL by value, never to the remote name.
    const pushUrl = pushUrls.length === 1 ? pushUrls[0]! : null;
    if (url) {
      const why =
        pushUrls.length > 1
          ? `remote ${remote} has ${pushUrls.length} push URLs; gate.pr delivers to exactly one`
          : pushUrl
            ? pushUrlProblem(pushUrl)
            : 'the push URL cannot be read';
      if (why) return fail(EXIT.policy, 'transport-refused', { remote, why });
    }

    // ---- the approval: bound to this PR and sha, human, not self, this session (read-only here) ----
    const why = await this.checkApproval(ctx, approval, sha);
    if (why) return fail(EXIT.policy, 'approval', why);

    // ---- what would leave the machine: title, body, patch, request; refused whole if it carries a secret ----
    const title = this.title(ctx, provisional);
    const body = await this.body(ctx, { sha, branch, d1, proof, review, criteria: crit.contract ? { contract: crit.contract, hash: crit.hash, proofs: crit.proofs, fidelity: crit.fidelity } : null, pending: res.pending });
    let patch: string;
    try {
      patch = await hostGit(dir, ['format-patch', '--stdout', '--no-ext-diff', '--no-textconv', '--binary', '--no-color', `${parent}..${sha}`]);
    } catch (err) {
      return fail(EXIT.human, 'patch-failed', errMsg(err));
    }
    const request = this.request(ctx, { sha, parent, branch, title, provisional, proof, pending: res.pending });
    const keys = [commit.key, review.key, proof.evidenceKey, ...(proof.criteria ?? []).map((p) => p.evidenceKey), approval.requestId, approval.sessionId, ...res.pending.map((r) => r.id)];
    const leak = this.secretIn({ title, body, patch, request: JSON.stringify(request), branch, keys: keys.join('\n'), remote: pushUrl ?? '' });
    if (leak) return fail(EXIT.policy, 'secret-in-delivery', { where: leak.where, kind: leak.kind, note: 'the delivery would carry a registered secret or canary: nothing was pushed, opened or bundled' });

    // ---- the delivery is claimed and the grant consumed, exactly once, under the fence ----
    const now = this.now();
    try {
      guard.check();
      const won = await claim(this.o.ledger, this.redactor, intentKey, 'gate.pr.intent', ctx.runId, { ...record, approval: { requestId: approval.requestId, sessionId: approval.sessionId, actionHash: approval.actionHash }, at: now });
      if (!won.won) return fail(EXIT.policy, 'approval', 'another delivery of this step holds the claim');
      guard.check();
      await this.o.ledger.consume(approval.requestId, approval.actionHash, approval.sessionId, `gate.pr:${ctx.runId}:${approval.requestId}`, now);
    } catch (err) {
      return fail(err instanceof FenceLost ? EXIT.human : EXIT.policy, err instanceof FenceLost ? 'fence-lost' : 'approval', errMsg(err));
    }
    record.approval = { requestId: approval.requestId, sessionId: approval.sessionId, actionHash: approval.actionHash };
    const fenced = async (): Promise<PrResult | null> => {
      try {
        guard.check();
        return null;
      } catch (err) {
        return fail(EXIT.human, 'fence-lost', errMsg(err));
      }
    };

    // ---- deliver: push when there is a remote, PR when gh is ready, else the patch bundle ----
    record.remote = url ? remote : null;
    let pushed = false;
    if (url) {
      const lost = await fenced();
      if (lost) return lost;
      const p = await this.push(dir, pushUrl!, branch, sha, ctx.signal);
      if (!p.ok) {
        // Fail closed (auth needed, rejected, unreachable). Leave the human a bundle to deliver by hand.
        const lost = await fenced();
        if (lost) return lost;
        const bundle = await this.bundle(ctx, dir, { sha, patch, body, request }, guard).catch((err: unknown) => ({ error: errMsg(err) }));
        return fail(EXIT.human, 'push-failed', { remote, detail: p.detail, bundle: 'dir' in bundle ? bundle.dir : null });
      }
      pushed = true;
    }
    record.pushed = pushed;

    let ghNote: string | null = null;
    if (pushed) {
      const gh = this.o.gh === null ? null : (this.o.gh ?? findOnPath('gh', this.ghEnv().PATH));
      if (!gh) ghNote = 'gh not found';
      else {
        const lost = await fenced();
        if (lost) return lost;
        const opened = await this.openPr(gh, dir, { branch, title, body }, ctx.signal);
        if (opened.url) {
          const result = { ...record, outcome: 'opened', exitCode: 0, url: opened.url, title, terminal: false, at: this.now() };
          await writeEvidence(this.o.ledger, this.redactor, { key: finalKey, kind: 'gate.pr', runId: ctx.runId, body: result });
          return this.resultOf(result, finalKey, false);
        }
        ghNote = opened.note;
      }
    } else ghNote = url ? null : `no '${remote}' remote`;

    let bundle: { dir: string; patch: string };
    try {
      bundle = await this.bundle(ctx, dir, { sha, patch, body, request }, guard);
    } catch (err) {
      return fail(EXIT.human, err instanceof FenceLost ? 'fence-lost' : 'bundle-failed', errMsg(err));
    }
    const result = { ...record, outcome: 'requested', exitCode: 0, bundle: bundle.dir, patch: bundle.patch, title, note: ghNote, terminal: false, at: this.now() };
    await writeEvidence(this.o.ledger, this.redactor, { key: finalKey, kind: 'gate.pr', runId: ctx.runId, body: result });
    return this.resultOf(result, finalKey, false);
  }

  /** The first delivery field carrying a registered secret or a canary (where, and the kind only), or null. */
  private secretIn(fields: Record<string, string>): { where: string; kind: string } | null {
    for (const [where, text] of Object.entries(fields)) {
      let kind: string | null;
      try {
        kind = this.redactor.containsSecret(text);
      } catch {
        kind = 'unscannable';
      }
      if (kind) return { where, kind };
    }
    return null;
  }

  private resultOf(b: Record<string, Json>, evidenceKey: string, reused: boolean): PrResult {
    const opened = b.outcome === 'opened' && typeof b.url === 'string';
    return {
      exitCode: EXIT.ok,
      sha: String(b.sha),
      evidenceKey,
      terminal: false,
      outcome: opened ? 'opened' : 'requested',
      ...(opened ? { url: b.url as string } : { reason: 'pr-requested' }),
      ...(typeof b.branch === 'string' ? { branch: b.branch } : {}),
      ...(typeof b.base === 'string' ? { base: b.base } : {}),
      ...(typeof b.bundle === 'string' ? { bundle: b.bundle } : {}),
      pushed: b.pushed === true,
      ...(b.provisional === true ? { provisional: true } : {}),
      ...(reused ? { reused: true } : {}),
    };
  }

  /**
   * The gate.commit evidence for `sha`: ctx.commit.evidenceKey, else the commit.recorded event, else the plan's
   * commit steps. Whatever names it, the record must be a gate.commit of this run, for this goal, intention
   * and attempt, written by a gate.commit step this PR step depends on, under that step's deterministic key.
   */
  private async commitEvidence(ctx: StepContext, sha: string): Promise<{ branch: string; tree: string; parent: string; d1: string; key: string } | { reason: string; detail: Json }> {
    const keys: string[] = [];
    if (ctx.commit?.evidenceKey) keys.push(ctx.commit.evidenceKey);
    else {
      for await (const e of this.o.ledger.events({ runId: ctx.runId, kinds: ['commit.recorded'] })) {
        const pl = obj(e.payload as Json);
        if (e.trace.intentionId === ctx.intention.id && pl?.sha === sha && typeof pl.evidenceKey === 'string') keys.push(pl.evidenceKey);
      }
      for (const s of ctx.plan.steps) if (s.kind === 'gate.commit') keys.push(commitEvidenceKey(this.redactor, ctx.runId, ctx.intention.id, s.id, ctx.intention.attempt));
    }
    for (const key of keys) {
      const rec = await this.o.ledger.getEvidence(key);
      const b = obj(rec?.body);
      if (!rec || !b || b.outcome !== 'committed' || b.sha !== sha) continue;
      const fp = obj(b.fingerprints);
      if (rec.kind !== 'gate.commit' || rec.runId !== ctx.runId) return { reason: 'commit-of-another-run', detail: { key } };
      if (b.intentionId !== ctx.intention.id) return { reason: 'commit-of-another-intention', detail: { key } };
      if (b.goalId !== ctx.goal.id) return { reason: 'commit-of-another-goal', detail: { key } };
      if (b.attempt !== ctx.intention.attempt) return { reason: 'commit-of-another-attempt', detail: { key } };
      const step = ctx.plan.steps.find((s) => s.id === b.stepId);
      if (!step || step.kind !== 'gate.commit' || !precedes(ctx.plan.steps, step.id, ctx.step.id)) return { reason: 'commit-not-a-preceding-step', detail: { key } };
      if (key !== commitEvidenceKey(this.redactor, ctx.runId, ctx.intention.id, step.id, ctx.intention.attempt)) return { reason: 'commit-evidence-key-mismatch', detail: { key } };
      if (typeof b.branch !== 'string' || typeof b.tree !== 'string' || typeof b.parent !== 'string' || typeof fp?.d1 !== 'string' || !fp.d1) return { reason: 'commit-evidence-malformed', detail: { key } };
      if (fp.d1 !== fp.d2 || fp.d1 !== fp.d3) return { reason: 'commit-digest-drift', detail: { key } };
      return { branch: b.branch, tree: b.tree, parent: b.parent, d1: fp.d1, key };
    }
    return { reason: 'no-commit-evidence', detail: { sha, looked: keys } };
  }

  private async reviewFor(runId: string, d1: string): Promise<{ key: string; reviewer: Json } | { reason: string; detail: Json }> {
    const key = reviewEvidenceKey(runId, d1);
    const b = obj((await this.o.ledger.getEvidence(key))?.body);
    if (!b) return { reason: 'no-review-for-commit', detail: { d1 } };
    if (b.verdict !== 'approve' || b.terminal === true) return { reason: 'review-not-passed', detail: { key, verdict: b.verdict ?? null } };
    if (b.fingerprintBefore !== d1 || b.fingerprintAfter !== d1) return { reason: 'review-digest-mismatch', detail: { key } };
    const r = obj(b.reviewer);
    return { key, reviewer: r ? { provider: r.provider ?? null, model: r.model ?? null } : null };
  }

  /**
   * The verify that proves achievement: the latest verify.* event of this intention must be an audited
   * verify.passed naming gate.verify evidence of this run that ran the goal check to exit 0 on D1. Its
   * verifiedAt is that event's time; nothing is taken from the in-process memo or the clock.
   */
  private async proofFor(ctx: StepContext, d1: string, events: readonly TeceraEvent[]): Promise<Proof | { reason: string; detail: Json }> {
    const chk = resolveCheck(ctx.goal, this.o.manifest);
    if (!chk.ok) return { reason: 'goal-check-invalid', detail: chk.reason };
    const none = (note: string) => ({ reason: 'no-verify-proof', detail: { d1, note } });
    const last = [...events].reverse().find((e) => (e.kind === 'verify.passed' || e.kind === 'verify.failed') && e.trace.intentionId === ctx.intention.id);
    if (!last) return none('no audited verify.passed event for this intention');
    if (last.kind !== 'verify.passed') return none('the latest verify of this intention failed');
    if (last.trace.goalId !== undefined && last.trace.goalId !== ctx.goal.id) return none('the latest verify.passed is of another goal');
    const p = obj(last.payload as Json);
    const key = typeof p?.evidenceKey === 'string' ? p.evidenceKey : '';
    if (!key) return none('the latest verify.passed names no evidence');
    if (p!.fingerprint !== undefined && p!.fingerprint !== d1) return none('the latest verify.passed is of another candidate than the committed one');
    if (typeof last.at !== 'number' || !Number.isFinite(last.at)) return none('the latest verify.passed has no time');
    const rec = await this.o.ledger.getEvidence(key);
    if (!rec || rec.kind !== 'gate.verify' || rec.runId !== ctx.runId) return none('the evidence the latest verify.passed names is not gate.verify evidence of this run');
    const v = verifyMemoFrom(key, rec.body);
    const b = obj(rec.body)!;
    if (!v || v.outcome !== 'passed' || b.exitCode !== 0 || v.fingerprint !== d1) return none('the latest verify did not pass on the committed candidate');
    if (v.commandDigest !== commandDigest(chk.check.command)) return none('the latest verify did not run the goal check');
    return { command: chk.check.command, exitCode: 0, fingerprint: d1, evidenceKey: key, verifiedAt: last.at };
  }

  /**
   * The contract's criterion proofs on D1 (none on the single-check path), or why the PR may not open. The
   * ledger must say the contract was accepted with this hash. Command criteria are proven by their own
   * passing gate.verify evidence under criterionEvidenceKey; human criteria by a 'yes' answer whose
   * answer_criterion approval (this run, goal, contract, criterion and D1; this session) a human other than
   * the requester granted, audited. verifiedAt is the audited event's time (the verify.passed of the goal
   * check, the approval.granted of an answer). Fidelity: weakest of the ledger inventory, GateContext's
   * inventory and every fidelity recorded or reported for the criterion.
   */
  private async criteriaFor(
    ctx: StepContext,
    d1: string,
    verifiedAt: number,
    events: readonly TeceraEvent[],
    prApproval: GateApproval,
  ): Promise<{ contract?: undefined } | { contract: AcceptanceContract; hash: string; proofs: CriterionProof[]; fidelity: Fidelity } | { reason: string; detail: Json }> {
    const con = contractOf(ctx);
    if (!con.ok) return { reason: 'contract-invalid', detail: con.reason };
    if (!con.contract) return {};
    const { contract, hash } = con;
    const acceptance = acceptedContractOf(events, ctx.goal.id, { runId: ctx.runId, ...(this.o.manifest.acceptance?.signoff === 'always' ? { requireApproval: true } : {}) });
    if (acceptance.state !== 'accepted' || acceptance.accepted?.hash !== hash) {
      return { reason: 'contract-not-accepted', detail: { state: acceptance.state, accepted: acceptance.accepted?.hash ?? null, contractHash: hash } };
    }
    const secrets = (v: string) => this.redactor.containsSecret(v) !== null;
    const ledgerInv = capabilityInventoryOf(events, { runId: ctx.runId, allowance: this.o.manifest.provisioning, secrets });
    const invs = [ledgerInv, ...(ctx.inventory ? [inventoryById(ctx.inventory)] : [])];
    const reported = new Map<string, CriterionProof>();
    for (const p of ctx.criterionProofs ?? []) {
      if (!contract.criteria.some((k) => k.id === p?.criterionId)) return { reason: 'criterion-unknown', detail: { criterion: String(p?.criterionId ?? null) } };
      reported.set(p.criterionId, p);
    }
    const proofs: CriterionProof[] = [];
    const answerIds = new Set<string>();
    for (const k of contract.criteria) {
      const rp = reported.get(k.id);
      const claimed: Array<Fidelity | undefined> = [rp && isFidelity(rp.fidelity) ? rp.fidelity : rp ? 'mocked' : undefined];
      if (k.check.kind === 'command') {
        const key = criterionEvidenceKey(ctx.runId, k.id, d1);
        const rec = await this.o.ledger.getEvidence(key);
        const b = obj(rec?.body);
        const proven =
          !!rec && !!b && rec.kind === 'gate.verify' && rec.runId === ctx.runId && b.criterionId === k.id && b.outcome === 'passed' && b.exitCode === 0 && b.fingerprint === d1 &&
          b.commandDigest === commandDigest(k.check.command) && typeof b.timeoutSec === 'number' && b.timeoutSec <= k.check.timeoutSec;
        if (!proven) return { reason: 'criterion-unproven', detail: { criterion: k.id, note: 'no passing verify of this criterion on the committed candidate' } };
        if (rp && rp.evidenceKey !== key) return { reason: 'criterion-proof-mismatch', detail: { criterion: k.id } };
        claimed.push(isFidelity(b!.fidelity) ? b!.fidelity : 'mocked');
        const fidelity = criterionFidelity(k.requires, invs, claimed);
        if (fidelity === null) return { reason: 'criterion-capability-missing', detail: { criterion: k.id } };
        proofs.push({ criterionId: k.id, fidelity, via: 'command', command: k.check.command, exitCode: 0, fingerprint: d1, evidenceKey: key, verifiedAt });
      } else {
        const a = (ctx.humanAnswers ?? []).find((x) => x?.criterionId === k.id);
        if (!a) return { reason: 'criterion-unanswered', detail: { criterion: k.id } };
        if (a.verdict !== 'yes') return { reason: 'criterion-rejected', detail: { criterion: k.id, verdict: String(a.verdict ?? null) } };
        if (!a.requestId || a.requestId === prApproval.requestId || answerIds.has(a.requestId)) return { reason: 'criterion-answer-invalid', detail: { criterion: k.id, note: 'each human criterion needs its own answer approval, not the PR approval' } };
        answerIds.add(a.requestId);
        const why = await this.answerProblem(ctx, events, a.requestId, a.approver?.id, answerCriterionActionHash({ goalId: ctx.goal.id, runId: ctx.runId, contractHash: hash, criterionId: k.id, fingerprint: d1 }));
        if (typeof why === 'string') return { reason: 'criterion-answer-invalid', detail: { criterion: k.id, note: why } };
        if (rp && rp.evidenceKey !== a.requestId) return { reason: 'criterion-proof-mismatch', detail: { criterion: k.id } };
        const fidelity = criterionFidelity(k.requires, invs, claimed);
        if (fidelity === null) return { reason: 'criterion-capability-missing', detail: { criterion: k.id } };
        proofs.push({ criterionId: k.id, fidelity, via: 'human', approver: why.approver, evidenceKey: a.requestId, verifiedAt: why.at });
      }
    }
    const shape = criteriaProofProblem(contract, proofs);
    if (shape) return { reason: 'criterion-unproven', detail: shape };
    return { contract, hash, proofs, fidelity: weakestFidelity(proofs.map((p) => p.fidelity)) };
  }

  /** The audited grant behind a human criterion answer ({approver, at}), or why it is none. Read-only. */
  private async answerProblem(ctx: StepContext, events: readonly TeceraEvent[], requestId: string, approver: string | undefined, actionHash: string): Promise<string | { approver: string; at: number }> {
    try {
      const view = await requireApproval(this.o.ledger, requestId);
      if (!view) return 'unknown approval';
      if (view.runId !== ctx.runId) return 'approval belongs to another run';
      if (view.sessionId !== this.o.sessionId) return 'approval belongs to another session';
      if (view.actionHash !== actionHash) return 'approval is not bound to this criterion, contract and candidate';
      if (view.state !== 'granted' && view.state !== 'consumed') return `approval is ${view.state}, not granted`;
      if (!view.approver || view.approver.kind !== 'human') return 'approval was not granted by a human';
      if (view.approver.id !== approver) return 'the answer names another approver than the grant';
      if (view.requester.kind === view.approver.kind && view.requester.id === view.approver.id) return 'self-approval';
      const grant = events.find((e) => e.kind === 'approval.granted' && obj(e.payload as Json)?.requestId === requestId);
      if (!grant) return 'the grant was never audited (no approval.granted event)';
      const audit = approvalAuditProblem(grant, { requestId, runId: ctx.runId, sessionId: view.sessionId, actionHash, approver: view.approver });
      if (audit) return audit;
      return { approver: view.approver.id, at: grant.at };
    } catch (err) {
      return errMsg(err);
    }
  }

  /** Resources provisioned for this goal and still pending (the PR's transfer list), or why the PR may not open. */
  private pendingFor(ctx: StepContext, events: readonly TeceraEvent[]): { pending: ProvisionedResource[] } | { reason: string; detail: Json } {
    const reg = resourceRegistryOf(events, { runId: ctx.runId, goalId: ctx.goal.id, allowance: this.o.manifest.provisioning, secrets: (v) => this.redactor.containsSecret(v) !== null });
    if (reg.problems.length || reg.overAllowance.length) return { reason: 'resource-registry', detail: { problems: reg.problems.length, overAllowance: reg.overAllowance } };
    const ids = new Set(reg.pending.map((r) => r.id));
    for (const r of ctx.pendingResources ?? []) if (!ids.has(r?.id)) return { reason: 'resource-not-on-ledger', detail: { resource: String(r?.id ?? null) } };
    return { pending: reg.pending };
  }

  /** Null when the grant may be spent for exactly this PR, else why not. Read-only. */
  private async checkApproval(ctx: StepContext, a: GateApproval, sha: string): Promise<string | null> {
    if (!a || !a.requestId || !a.sessionId || !a.actionHash) return 'incomplete approval reference';
    if (!this.o.sessionId || a.sessionId !== this.o.sessionId) return 'approval session differs from the gate session';
    const expected = prActionHash({ intentionId: ctx.intention.id, stepId: ctx.step.id, attempt: ctx.intention.attempt, sha });
    if (a.actionHash !== expected) return 'action hash mismatch: the approval is not for this PR step, attempt and commit';
    try {
      const view = await requireApproval(this.o.ledger, a.requestId);
      if (!view) return 'unknown approval';
      if (view.runId !== ctx.runId) return 'approval belongs to another run';
      if (view.sessionId !== a.sessionId || view.sessionId !== this.o.sessionId) return 'approval belongs to another session';
      if (view.actionHash !== expected) return 'ledger action hash differs';
      if (view.state !== 'granted') return `approval is ${view.state}, not granted`;
      if (view.expiresAt <= this.now()) return 'approval expired';
      if (!view.approver || view.approver.kind !== 'human') return 'approval was not granted by a human';
      if (view.approver.kind === view.requester.kind && view.approver.id === view.requester.id) return 'self-approval';
    } catch (err) {
      return errMsg(err);
    }
    return null;
  }

  private async remoteUrl(dir: string, remote: string): Promise<string | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(remote)) return null;
    const u = (await hostGit(dir, ['config', '--get', `remote.${remote}.url`]).catch(() => '')).trim();
    return u || null;
  }

  /**
   * Every URL a push to `remote` would use (all of remote.<name>.pushurl, else all of its url), after
   * insteadOf / pushInsteadOf rewriting. Empty when they cannot be read.
   */
  private async pushUrls(dir: string, remote: string): Promise<string[]> {
    const out = await hostGit(dir, ['remote', 'get-url', '--push', '--all', remote]).catch(() => '');
    return out.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  }

  /**
   * Push the committed sha to the work branch at `url` (never forced, never the base). Fails closed on any
   * prompt need.
   *
   * The push does not run in the delivered repository: its config is the one thing a gate cannot switch off,
   * and it can name further destinations (several pushurl values), rewrite the URL again (url.*.insteadOf),
   * allow a transport (protocol.<name>.allow) or set transport options (http.*, push.*). It runs in an empty
   * bare repository made for this push, whose only config is git's own, with the delivered repository's
   * objects as an alternate; the destination is the one validated URL, by value. Global and system config
   * are off (gitEnv), every transport but file, ssh and https is refused (PUSH_PROTOCOLS), credential helpers
   * are cleared and ssh runs as GIT_SSH_COMMAND below (batch mode, strict host keys), which git prefers over
   * any core.sshCommand.
   */
  private async push(dir: string, url: string, branch: string, sha: string, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; detail: string }> {
    const sig = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.o.timeoutMs ?? 120_000)]);
    const ref = `refs/heads/${branch}`;
    let clean: string | null = null;
    try {
      const objects = resolve(dir, (await hostGit(dir, ['rev-parse', '--git-path', 'objects'], { signal: sig })).trim());
      const format = (await hostGit(dir, ['rev-parse', '--show-object-format'], { signal: sig })).trim();
      if (format !== 'sha1' && format !== 'sha256') return { ok: false, detail: `unsupported object format ${format}` };
      clean = await mkdtemp(join(tmpdir(), 'tecera-gates-push-'));
      await hostGit(clean, ['init', '-q', '--bare', '--template=', `--object-format=${format}`, '.'], { signal: sig });
      const env: Record<string, string> = {
        GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
        GIT_ALTERNATE_OBJECT_DIRECTORIES: objects,
        ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
      };
      // A relative local path means what it meant in the delivered repository.
      const to = localPath(url) && !isAbsolute(url) ? resolve(dir, url) : url;
      await hostGit(clean, [...PUSH_PROTOCOLS, 'push', '--no-verify', '--porcelain', to, `${sha}:${ref}`], { env, signal: sig });
      const ls = await hostGit(clean, [...PUSH_PROTOCOLS, 'ls-remote', to, ref], { env, signal: sig });
      const got = ls.split('\n').find((l) => l.endsWith(`\t${ref}`))?.split('\t')[0];
      if (got !== sha) return { ok: false, detail: `remote ${ref} is ${got ?? 'absent'} after the push, not ${sha}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: safeText(this.redactor, errMsg(err)).slice(0, 2000) };
    } finally {
      if (clean) await rm(clean, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private ghEnv(): NodeJS.ProcessEnv {
    if (this.o.ghEnv) return this.o.ghEnv;
    const env: NodeJS.ProcessEnv = {};
    for (const k of GH_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
    return env;
  }

  /** `gh auth status`, then `gh pr create`. Returns the PR url, or why not (the caller falls back to pr.requested). */
  private async openPr(gh: string, dir: string, pr: { branch: string; title: string; body: string }, signal?: AbortSignal): Promise<{ url?: string; note: string }> {
    const sig = () => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.o.timeoutMs ?? 120_000)]);
    const env: NodeJS.ProcessEnv = { ...this.ghEnv(), GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: 'cat' };
    const auth = await runProc(gh, ['auth', 'status'], { cwd: dir, env, signal: sig() });
    if (auth.code !== 0) return { note: `gh is not authenticated (gh auth status exit ${auth.code ?? auth.error ?? 'error'})` };
    const r = await runProc(gh, ['pr', 'create', '--base', this.base, '--head', pr.branch, '--title', pr.title, '--body-file', '-'], { cwd: dir, env, input: pr.body, signal: sig() });
    if (r.code !== 0) return { note: `gh pr create failed (exit ${r.code ?? r.error ?? 'error'}): ${safeText(this.redactor, r.stderr.trim()).slice(0, 500)}` };
    const url = r.stdout.match(/https?:\/\/[^\s]+/g)?.pop();
    if (!url) return { note: 'gh pr create printed no PR url' };
    return { url, note: 'opened' };
  }

  private async runsDir(dir: string): Promise<string> {
    if (this.o.runsDir) return resolve(this.o.runsDir);
    const common = (await hostGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    return basename(common) === '.git' ? join(dirname(common), '.tecera', 'runs') : join(common, 'tecera', 'runs');
  }

  /** The patch, the PR body and request.json under <runsDir>/<run>/pr/; the fence is checked before each write. */
  private async bundle(ctx: StepContext, dir: string, pr: { sha: string; patch: string; body: string; request: Record<string, Json> }, guard: WriteGuard): Promise<{ dir: string; patch: string }> {
    const out = join(await this.runsDir(dir), refSafe(ctx.runId) || 'run', 'pr');
    guard.check();
    await mkdir(out, { recursive: true });
    const patchPath = join(out, `${pr.sha}.patch`);
    guard.check();
    await writeFile(patchPath, pr.patch);
    guard.check();
    await writeFile(join(out, 'body.md'), pr.body);
    guard.check();
    await writeFile(join(out, 'request.json'), JSON.stringify(this.redactor.redactJson({ ...pr.request, patch: patchPath }), null, 2) + '\n');
    return { dir: out, patch: patchPath };
  }

  /** request.json: what a human needs to deliver the PR by hand, including how it was proven and what is owed. */
  private request(ctx: StepContext, x: { sha: string; parent: string; branch: string; title: string; provisional: boolean; proof: Proof; pending: ProvisionedResource[] }): Record<string, Json> {
    return {
      runId: ctx.runId,
      goalId: ctx.goal.id,
      intentionId: ctx.intention.id,
      sha: x.sha,
      parent: x.parent,
      branch: x.branch,
      base: this.base,
      title: x.title,
      ...(x.proof.contractHash !== undefined
        ? {
            contractHash: x.proof.contractHash,
            fidelity: x.proof.fidelity ?? null,
            provisional: x.provisional,
            criteria: (x.proof.criteria ?? []).map((p) => ({ criterionId: p.criterionId, via: p.via, fidelity: p.fidelity, evidenceKey: p.evidenceKey, ...(p.approver ? { approver: p.approver } : {}) })),
          }
        : {}),
      pendingTransfer: x.pending.map(transferLine) as unknown as Json,
      merge: 'never: a human reviews and merges',
    };
  }

  private title(ctx: StepContext, provisional: boolean): string {
    const statement = this.redactor.redactText(ctx.goal.statement);
    const subject = statement.split('\n')[0]!.replace(/\s+/g, ' ').trim().slice(0, 72) || ctx.goal.id;
    return provisional ? `tecera (provisional): ${subject}` : `tecera: ${subject}`;
  }

  private async body(
    ctx: StepContext,
    x: { sha: string; branch: string; d1: string; proof: Proof; review: { key: string; reviewer: Json }; criteria: { contract: AcceptanceContract; hash: string; proofs: CriterionProof[]; fidelity: Fidelity } | null; pending: ProvisionedResource[] },
  ): Promise<string> {
    const r = obj(x.review.reviewer);
    const who = r ? [r.provider, r.model].filter((v) => typeof v === 'string' && v).join(' / ') : '';
    let cost: string | null = null;
    try {
      cost = this.o.costLine ? await this.o.costLine(ctx.runId) : await this.defaultCost(ctx.runId);
    } catch {
      cost = null;
    }
    const lines = [
      '## Goal',
      '',
      ctx.goal.statement,
      '',
      '## Proof of achievement',
      '',
      `- check: \`${x.proof.command}\` exited 0`,
      `- candidate: ${x.d1}`,
      `- verify evidence: ${x.proof.evidenceKey} (${new Date(x.proof.verifiedAt).toISOString()})`,
      '',
      ...(x.criteria ? criteriaSection(x.criteria) : []),
      ...(x.criteria || x.pending.length ? pendingSection(x.pending) : []),
      '## Review',
      '',
      `- verdict: approve${who ? ` (foreign reviewer ${who})` : ''}`,
      `- review evidence: ${x.review.key}`,
      '',
      '## Delivery',
      '',
      `- commit: ${x.sha} on ${x.branch} (base ${this.base})`,
      `- run: ${ctx.runId}, goal ${ctx.goal.id}, intention ${ctx.intention.id}`,
      ...(cost ? [`- cost: ${cost}`] : []),
      '',
      'Opened by Tecera after a human approval. Tecera never merges: a human reviews and merges this PR.',
      '',
    ];
    return this.redactor.redactText(lines.join('\n'));
  }

  private async defaultCost(runId: string): Promise<string | null> {
    if (typeof this.o.ledger.budgetUsage !== 'function') return null;
    const pools = await this.o.ledger.budgetUsage(runId);
    const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(4));
    const parts = pools.filter((p) => ['usd', 'tokens', 'calls'].includes(p.pool)).map((p) => `${p.pool} ${fmt(p.used)} of ${fmt(p.cap)}${p.enforce ? '' : ' (not enforced)'}`);
    return parts.length ? parts.join(', ') : null;
  }
}

/** True when step `before` is a (transitive) dependency of step `after`. */
function precedes(steps: ReadonlyArray<{ id: string; dependsOn?: readonly string[] }>, before: string, after: string): boolean {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const queue = [...(byId.get(after)?.dependsOn ?? [])];
  while (queue.length) {
    const id = queue.shift()!;
    if (id === before) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(byId.get(id)?.dependsOn ?? []));
  }
  return false;
}

/** A pending resource as the PR lists it: where it is, how to tear it down, when it expires. Never a credential. */
function transferLine(r: ProvisionedResource): Record<string, Json> {
  return { id: r.id, capability: r.capability, kind: r.kind, locator: r.locator, teardown: r.teardown, expiresAt: r.expiresAt };
}

const HOW: Record<Fidelity, string> = {
  real: 'against the real capability',
  provisioned: 'against a resource Tecera provisioned in its own space',
  mocked: 'against a stand-in (mock), not the real capability',
};

/** The PR body's criteria section: every criterion, how it was proven, and its own fidelity (D11). */
function criteriaSection(c: { contract: AcceptanceContract; hash: string; proofs: CriterionProof[]; fidelity: Fidelity }): string[] {
  const mocked = c.proofs.filter((p) => p.fidelity === 'mocked').map((p) => p.criterionId);
  const lines = ['## Acceptance criteria', '', `- contract: ${c.hash}`, `- fidelity: ${c.fidelity} (the weakest criterion)`, ''];
  for (const k of c.contract.criteria) {
    const p = c.proofs.find((x) => x.criterionId === k.id)!;
    const how = p.via === 'command' ? `command \`${p.command}\` exited 0 on the candidate (evidence ${p.evidenceKey})` : `answered yes by ${p.approver} (approval ${p.evidenceKey})`;
    lines.push(`- ${k.id}: ${k.statement.replace(/\s+/g, ' ').trim()}`, `  - proven: ${how}`, `  - fidelity: ${p.fidelity}, ${HOW[p.fidelity]}`);
  }
  lines.push('');
  if (mocked.length) {
    lines.push(`**Provisional:** ${mocked.join(', ')} rest on a stand-in. This PR does not prove the goal against the real capabilities; the goal stays provisional, not achieved.`, '');
  }
  return lines;
}

/** The PR body's pending-transfer section (D12): every resource Tecera created that a human must take over or release. */
function pendingSection(pending: readonly ProvisionedResource[]): string[] {
  if (!pending.length) return ['## Pending transfer', '', '- none: Tecera provisioned nothing for this goal', ''];
  const lines = ['## Pending transfer', '', 'Tecera provisioned these in its own space. Each stays pending until a human transfers or releases it.', ''];
  for (const r of pending) lines.push(`- ${r.id} (${r.kind} for ${r.capability}): \`${r.locator}\`; teardown \`${r.teardown}\`; expires ${new Date(r.expiresAt).toISOString()}`);
  lines.push('');
  return lines;
}
