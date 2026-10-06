import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { FenceLost, prActionHash, requireApproval, reviewEvidenceKey, type AchievementProof, type GateApproval, type Json, type Ledger, type Manifest, type Redactor, type SecretInput } from '@tecera/contracts';
import { claim, commandDigest, defaultIds, errMsg, GateMemo, obj, redactorFrom, safeText, verifyMemoFrom, writeEvidence } from './evidence.js';
import { assertSafeRepo, gitEnv, hostGit, refSafe, UnsafeRepo } from './gitx.js';
import { EXIT, type PrResult, type StepContext } from './types.js';
import { gateWorktree, resolveCheck } from './verifyGate.js';

/**
 * PR gate (owner decision D6): the ONLY approval point of a code-changing plan. The plan ends
 * worker → gate.verify → gate.review → gate.verify → gate.commit → gate.pr; gate.commit has already put the
 * verified, reviewed candidate on the work branch tecera/<goal> without approval. gate.pr delivers it:
 *
 *  1. GateContext names the gate's worktree, the repository cannot make git run programs, and ctx.commit
 *     names the committed sha (9 / 8);
 *  2. the commit evidence (gate.commit 'committed') is for this sha, its branch is the work branch of this
 *     goal and still points at the sha, and the commit's tree and parent are the recorded ones (9);
 *  3. a review.passed verdict for the committed D1 exists (reviewEvidenceKey(run, D1), approve, D1 = D2),
 *     and a verify that passed on D1 running the goal check gives the proof of achievement (9);
 *  4. GateContext.approval is for exactly this PR — contracts prActionHash({intentionId, stepId, attempt,
 *     sha}) — granted by a human other than the requester, in this run and session, unexpired; the gate
 *     claims the delivery and consumes the grant itself, exactly once (8);
 *  5. when the worktree has an 'origin' remote, `git push -u origin refs/heads/<branch>` with hooks off, no
 *     credential helper, no prompts, ssh in BatchMode and only file/ssh/https transports (a push that needs
 *     interactive auth fails: 9, fail closed); the remote ref is then read back and must be the sha;
 *  6. when gh is on PATH and `gh auth status` succeeds and the branch was pushed, `gh pr create --base <base>
 *     --head <branch> --title … --body-file -` with a body built from the run evidence (goal, proof,
 *     review verdict, cost line) → url (the loop records pr.opened);
 *  7. otherwise the gate writes a patch bundle (git format-patch), the PR body and request.json under
 *     <runsDir>/<run>/pr/ and returns exit 0 with reason 'pr-requested' and no url (the loop records
 *     pr.requested). A PR step is done either way.
 * Tecera never merges: no merge, no auto-merge flag, no push to the base branch. Every result is evidence
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
  /** Session approvals must belong to (LoopPorts.sessionId). When set, other sessions are refused. */
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

/** Transports a push may use. Everything else (ext::, git://, http://, fd::) stays refused. */
const PUSH_PROTOCOLS = ['-c', 'protocol.file.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'protocol.https.allow=always'];
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
      const evidenceKey = `pr-refused:${ctx.runId}:${ctx.intention.id}:${ctx.step.id}:${this.ids()}`;
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

    // ---- the commit: recorded by the commit gate, on this goal's work branch, untouched since ----
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

    // ---- review.passed for the committed D1, and the verify that proves achievement ----
    const review = await this.reviewFor(ctx.runId, d1);
    if ('reason' in review) return fail(EXIT.human, review.reason, review.detail);
    const proof = await this.proofFor(ctx, d1);
    if ('reason' in proof) return fail(EXIT.human, proof.reason, proof.detail);
    record.review = { evidenceKey: review.key, verdict: 'approve', reviewer: review.reviewer };
    record.proof = { ...proof };

    // ---- the approval: bound to this PR and sha, human, not self; checked, then claimed and consumed ----
    const why = await this.checkApproval(ctx, approval, sha);
    if (why) return fail(EXIT.policy, 'approval', why);
    const now = this.now();
    try {
      ctx.guard?.check();
      const won = await claim(this.o.ledger, this.redactor, intentKey, 'gate.pr.intent', ctx.runId, { ...record, approval: { requestId: approval.requestId, sessionId: approval.sessionId, actionHash: approval.actionHash }, at: now });
      if (!won.won) return fail(EXIT.policy, 'approval', 'another delivery of this step holds the claim');
      await this.o.ledger.consume(approval.requestId, approval.actionHash, approval.sessionId, `gate.pr:${ctx.runId}:${approval.requestId}`, now);
    } catch (err) {
      return fail(err instanceof FenceLost ? EXIT.human : EXIT.policy, err instanceof FenceLost ? 'fence-lost' : 'approval', errMsg(err));
    }
    record.approval = { requestId: approval.requestId, sessionId: approval.sessionId, actionHash: approval.actionHash };

    // ---- deliver: push when there is a remote, PR when gh is ready, else the patch bundle ----
    const title = this.title(ctx);
    const body = await this.body(ctx, { sha, branch, d1, proof, review });
    const remote = this.o.remote ?? 'origin';
    const url = await this.remoteUrl(dir, remote);
    record.remote = url ? remote : null;
    let pushed = false;
    if (url) {
      const p = await this.push(dir, remote, branch, sha, ctx.signal);
      if (!p.ok) {
        // Fail closed (auth needed, rejected, unreachable). Leave the human a bundle to deliver by hand.
        const bundle = await this.bundle(ctx, dir, { sha, parent, branch, title, body }).catch((err: unknown) => ({ error: errMsg(err) }));
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
      bundle = await this.bundle(ctx, dir, { sha, parent, branch, title, body });
    } catch (err) {
      return fail(EXIT.human, 'bundle-failed', errMsg(err));
    }
    const result = { ...record, outcome: 'requested', exitCode: 0, bundle: bundle.dir, patch: bundle.patch, title, note: ghNote, terminal: false, at: this.now() };
    await writeEvidence(this.o.ledger, this.redactor, { key: finalKey, kind: 'gate.pr', runId: ctx.runId, body: result });
    return this.resultOf(result, finalKey, false);
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
      ...(reused ? { reused: true } : {}),
    };
  }

  /** The gate.commit evidence for `sha`: ctx.commit.evidenceKey, else the commit.recorded event, else the plan's commit steps. */
  private async commitEvidence(ctx: StepContext, sha: string): Promise<{ branch: string; tree: string; parent: string; d1: string; key: string } | { reason: string; detail: Json }> {
    const keys: string[] = [];
    if (ctx.commit?.evidenceKey) keys.push(ctx.commit.evidenceKey);
    else {
      for await (const e of this.o.ledger.events({ runId: ctx.runId, kinds: ['commit.recorded'] })) {
        const pl = obj(e.payload as Json);
        if (e.trace.intentionId === ctx.intention.id && pl?.sha === sha && typeof pl.evidenceKey === 'string') keys.push(pl.evidenceKey);
      }
      for (const s of ctx.plan.steps) if (s.kind === 'gate.commit') keys.push(`commit:${ctx.runId}:${ctx.intention.id}:${s.id}:${ctx.intention.attempt}`);
    }
    for (const key of keys) {
      const b = obj((await this.o.ledger.getEvidence(key))?.body);
      if (!b || b.outcome !== 'committed' || b.sha !== sha) continue;
      const fp = obj(b.fingerprints);
      if (b.intentionId !== ctx.intention.id) return { reason: 'commit-of-another-intention', detail: { key } };
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

  /** The verify that passed on D1 running the goal check: the memo's latest, else the run's verify.passed events. */
  private async proofFor(ctx: StepContext, d1: string): Promise<Proof | { reason: string; detail: Json }> {
    const chk = resolveCheck(ctx.goal, this.o.manifest);
    if (!chk.ok) return { reason: 'goal-check-invalid', detail: chk.reason };
    const keys: string[] = [];
    const m = this.memo.verify.get(`${ctx.runId}:${ctx.intention.id}`);
    if (m) keys.push(m.evidenceKey);
    const evs: string[] = [];
    for await (const e of this.o.ledger.events({ runId: ctx.runId, kinds: ['verify.passed'] })) {
      const k = (e.payload as { evidenceKey?: unknown }).evidenceKey;
      if (e.trace.intentionId === ctx.intention.id && typeof k === 'string') evs.push(k);
    }
    keys.push(...evs.reverse());
    for (const key of keys) {
      const rec = await this.o.ledger.getEvidence(key);
      if (!rec) continue;
      const v = verifyMemoFrom(key, rec.body);
      const b = obj(rec.body)!;
      if (!v || v.outcome !== 'passed' || b.exitCode !== 0 || v.fingerprint !== d1) continue;
      if (v.commandDigest !== commandDigest(chk.check.command)) continue;
      const startedAt = typeof b.startedAt === 'number' ? b.startedAt : this.now();
      const verifiedAt = startedAt + (typeof b.durationMs === 'number' ? b.durationMs : 0);
      return { command: chk.check.command, exitCode: 0, fingerprint: d1, evidenceKey: key, verifiedAt };
    }
    return { reason: 'no-verify-proof', detail: { d1, note: 'no passing verify of the goal check on the committed candidate' } };
  }

  /** Null when the grant may be spent for exactly this PR, else why not. Read-only. */
  private async checkApproval(ctx: StepContext, a: GateApproval, sha: string): Promise<string | null> {
    if (!a || !a.requestId || !a.sessionId || !a.actionHash) return 'incomplete approval reference';
    if (this.o.sessionId !== undefined && a.sessionId !== this.o.sessionId) return 'approval session differs from the gate session';
    const expected = prActionHash({ intentionId: ctx.intention.id, stepId: ctx.step.id, attempt: ctx.intention.attempt, sha });
    if (a.actionHash !== expected) return 'action hash mismatch: the approval is not for this PR step, attempt and commit';
    try {
      const view = await requireApproval(this.o.ledger, a.requestId);
      if (!view) return 'unknown approval';
      if (view.runId !== ctx.runId) return 'approval belongs to another run';
      if (view.sessionId !== a.sessionId) return 'approval belongs to another session';
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

  /** Push the work branch (never forced, never the base). Fails closed on any prompt need. */
  private async push(dir: string, remote: string, branch: string, sha: string, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; detail: string }> {
    const sig = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.o.timeoutMs ?? 120_000)]);
    const env: Record<string, string> = {
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
      ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
    };
    const ref = `refs/heads/${branch}`;
    try {
      await hostGit(dir, [...PUSH_PROTOCOLS, 'push', '--no-verify', '--porcelain', '-u', remote, `${ref}:${ref}`], { env, signal: sig });
      const ls = await hostGit(dir, [...PUSH_PROTOCOLS, 'ls-remote', remote, ref], { env, signal: sig });
      const got = ls.split('\n').find((l) => l.endsWith(`\t${ref}`))?.split('\t')[0];
      if (got !== sha) return { ok: false, detail: `remote ${ref} is ${got ?? 'absent'} after the push, not ${sha}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: safeText(this.redactor, errMsg(err)).slice(0, 2000) };
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

  /** git format-patch of the commit, the PR body and request.json under <runsDir>/<run>/pr/. */
  private async bundle(ctx: StepContext, dir: string, pr: { sha: string; parent: string; branch: string; title: string; body: string }): Promise<{ dir: string; patch: string }> {
    const out = join(await this.runsDir(dir), refSafe(ctx.runId) || 'run', 'pr');
    await mkdir(out, { recursive: true });
    const patch = await hostGit(dir, ['format-patch', '--stdout', '--no-ext-diff', '--no-textconv', '--binary', '--no-color', `${pr.parent}..${pr.sha}`]);
    const patchPath = join(out, `${pr.sha}.patch`);
    await writeFile(patchPath, patch);
    await writeFile(join(out, 'body.md'), pr.body);
    const request = { runId: ctx.runId, goalId: ctx.goal.id, intentionId: ctx.intention.id, sha: pr.sha, parent: pr.parent, branch: pr.branch, base: this.base, title: pr.title, patch: patchPath, merge: 'never: a human reviews and merges' };
    await writeFile(join(out, 'request.json'), JSON.stringify(this.redactor.redactJson(request), null, 2) + '\n');
    return { dir: out, patch: patchPath };
  }

  private title(ctx: StepContext): string {
    const statement = this.redactor.redactText(ctx.goal.statement);
    const subject = statement.split('\n')[0]!.replace(/\s+/g, ' ').trim().slice(0, 72) || ctx.goal.id;
    return `tecera: ${subject}`;
  }

  private async body(ctx: StepContext, x: { sha: string; branch: string; d1: string; proof: Proof; review: { key: string; reviewer: Json } }): Promise<string> {
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
