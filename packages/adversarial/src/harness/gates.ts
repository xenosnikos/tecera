import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  approvalGrantedEvent,
  FencedWriteGuard,
  MANDATORY_HOOKS,
  parseManifest,
  type GateApproval,
  type GateContext,
  type Ledger,
  type LLM,
  type LLMRequest,
  type LLMResponse,
  type Manifest,
  type ManifestInput,
  type Plan,
  type Principal,
  type Step,
  type VerifyOutcome,
  type VerifyRequest,
  type VerifyRunner,
  type WriteGuard,
} from '@tecera/contracts';
import { createGates, prActionHash, type CreateGatesOptions, type Gates } from '@tecera/gates';
import { MemoryLedger } from '@tecera/ledger';
import { tmp } from './tmp.js';

/** A gate-level kit: a temp git repository, a manifest, a plan and GateContexts the way the loop builds them. */

const GIT_HOME = tmp('tecera-adv-githome-');
export const GIT_TEST_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: GIT_HOME,
  LANG: 'C',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

export interface Repo {
  dir: string;
  g(...args: string[]): string;
  write(path: string, content: string | Buffer): void;
}

export function makeRepo(files: Record<string, string> = {}): Repo {
  const dir = tmp('tecera-adv-gates-');
  const g = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', ...args], { env: GIT_TEST_ENV, encoding: 'utf8' });
  const write = (path: string, content: string | Buffer) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  g('init', '-q', '-b', 'main');
  const base: Record<string, string> = {
    'src/a.ts': 'export const a = 1;\n',
    'src/a.test.ts': "import { expect, it } from 'vitest';\nimport { a } from './a';\nit('a', () => {\n  expect(a).toBe(2);\n});\n",
    'vitest.config.ts': "export default { test: { include: ['src/**/*.test.ts'] } };\n",
    'package.json': '{\n  "name": "x",\n  "scripts": {\n    "test": "vitest run"\n  }\n}\n',
    '.gitignore': 'ignored/\n*.log\n.env\n',
    ...files,
  };
  for (const [p, c] of Object.entries(base)) write(p, c);
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  return { dir, g, write };
}

/** The raw manifest document (before parsing), for cases that test what parsing accepts or refuses. */
export function manifestInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'bc_adv00001',
    name: 'adversarial',
    owner: 'owner@example.com',
    runtime: { tecera: '>=0.1.0 <0.2.0' },
    repo: { base: 'main', branchPrefix: 'tecera/', allowedChanges: ['src/**'] },
    providers: { anthropic: { auth: 'env:ANTHROPIC_API_KEY' }, openai: { auth: 'env:OPENAI_API_KEY' } },
    seats: {
      planner: { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'high' },
      workers: [{ id: 'worker', provider: 'anthropic', model: 'claude-haiku', effort: 'medium' }],
      reviewer: { provider: 'openai', model: 'gpt-review', effort: 'high' },
      reflex: { provider: 'rules' },
    },
    budgets: { usd: 2, tokens: 200000, wallClockSec: 1200, maxDepth: 3, maxIterations: 20, maxAttempts: 2, maxChangedFiles: 5 },
    sandbox: { profile: 'process', isolation: 'node', network: false, memoryMb: 256, execTimeoutSec: 60 },
    policy: {
      protectedPaths: ['tecera.json', '.tecera/**'],
      approvals: { required: ['open_pr'], ttlSec: 900, quorum: 1, separationOfDuty: true },
      failure: { onVerifyFail: 'retry-once', onReviewFail: 'retry-once', onLedgerError: 'stop' },
    },
    verify: { command: 'true', timeoutSec: 60 },
    review: { foreign: true, maxAttempts: 1 },
    hooks: { mandatory: [...MANDATORY_HOOKS] },
    ...overrides,
  };
}

export function manifest(overrides: Partial<ManifestInput> = {}): Manifest {
  return parseManifest(manifestInput(overrides as Record<string, unknown>));
}

export function plan(o: { write?: string[]; goalKinds?: string[] } = {}): Plan {
  return {
    id: 'p1',
    trigger: { kind: 'goal.adopted' },
    context: [],
    steps: [
      { id: 'w', kind: 'worker', dependsOn: [], inputs: {} },
      { id: 'v', kind: 'gate.verify', dependsOn: ['w'], inputs: {} },
      { id: 'r', kind: 'gate.review', dependsOn: ['v'], inputs: {} },
      { id: 'c', kind: 'gate.commit', dependsOn: ['r'], inputs: {} },
      { id: 'pr', kind: 'gate.pr', dependsOn: ['c'], inputs: {} },
    ],
    allowedModels: {},
    permissions: { tools: ['edit'], write: o.write ?? ['src/**'], approvals: ['open_pr'] },
    budget: {},
    origin: 'seed',
    status: 'accepted',
    goalKinds: o.goalKinds ?? ['fix'],
  };
}

export interface CtxOptions {
  runId?: string;
  intentionId?: string;
  attempt?: number;
  worktree: string;
  /** gate.pr only (D6): the human grant the PR gate consumes. */
  approval?: GateApproval;
  candidate?: { d1?: string; d2?: string };
  /** gate.pr: the commit the intention recorded. */
  commit?: { sha: string; d1?: string; evidenceKey?: string };
  plan?: Plan;
  goalId?: string;
  /** The adopted goal's check (the gates run it; default `true`). */
  check?: { command: string; timeoutSec: number };
  /**
   * The mutation-time fence the loop hands every gate (GateContext.guard). Default: a live guard (the step
   * holds the worktree), so a refusal under test is the gate's own rule and never 'no-write-guard'.
   * `null` passes none (to test the gate's fail-closed refusal).
   */
  guard?: WriteGuard | null;
}

/** A live WriteGuard: writes allowed while `live()` returns null (default: always). */
export function liveGuard(live: () => string | null = () => null, signal: AbortSignal = new AbortController().signal): FencedWriteGuard {
  return new FencedWriteGuard({ live, signal });
}

export function gateCtx(stepId: StepId, o: CtxOptions): GateContext {
  const p = o.plan ?? plan();
  const step = p.steps.find((s) => s.id === stepId) as Step;
  const goalId = o.goalId ?? 'g1';
  return {
    runId: o.runId ?? 'run1',
    goal: { id: goalId, statement: 'make a two', check: o.check ?? { command: 'true', timeoutSec: 60 }, commitment: 'single-minded', status: 'open', evidence: [] },
    plan: p,
    intention: { id: o.intentionId ?? 'i1', goalId, planId: p.id, commitment: 'single-minded', status: 'running', stepStatus: {}, attempt: o.attempt ?? 0 },
    step,
    worktree: o.worktree,
    ...(o.guard === null ? {} : { guard: o.guard ?? liveGuard() }),
    ...(o.approval ? { approval: o.approval } : {}),
    ...(o.candidate ? { candidate: o.candidate } : {}),
    ...(o.commit ? { commit: o.commit } : {}),
  };
}

export type StepId = 'v' | 'r' | 'c' | 'pr';

/** A verify runner that reports a fixed outcome (the system under test is the gate, not the test runner). */
export class StubRunner implements VerifyRunner {
  calls: VerifyRequest[] = [];
  constructor(private readonly fn: (req: VerifyRequest) => Partial<VerifyOutcome> | Promise<Partial<VerifyOutcome>> = () => ({})) {}
  async run(req: VerifyRequest): Promise<VerifyOutcome> {
    this.calls.push(req);
    const r = await this.fn(req);
    return { exitCode: 0, signal: null, timedOut: false, stdout: 'ok', stderr: '', durationMs: 5, truncated: false, ...r };
  }
}

/** A reviewer seat whose answer is computed from the request (echo, planted, fenced, mutating...). */
export class StubReviewer implements LLM {
  calls: LLMRequest[] = [];
  readonly keyFingerprint: string | undefined;
  constructor(
    public readonly provider: string,
    private readonly fn: (req: LLMRequest) => string | Promise<string> = () => '{"verdict":"approve","findings":[]}',
    keyFingerprint: string | null = `kf-${provider}`,
    public readonly id = `${provider}-reviewer`,
  ) {
    this.keyFingerprint = keyFingerprint ?? undefined;
  }
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    const content = await this.fn(req);
    return { content, usage: { inputTokens: 10, outputTokens: 5, usd: 0.001 }, model: req.model, finishReason: 'stop' };
  }
}

export const WRITERS = [{ provider: 'anthropic', keyFingerprint: 'kf-anthropic' }];
export const NOW = 1_000_000;
export const HUMAN: Principal = { kind: 'human', id: 'alice' };
export const LOOP: Principal = { kind: 'agent', id: 'loop' };

let auditN = 0;

/**
 * Grant through the ledger exactly as the CLI ingress does: the grant and its approval.granted audit event
 * are recorded atomically (an unaudited grant cannot be consumed).
 */
export async function grantAudited(ledger: Ledger, o: { requestId: string; runId: string; sessionId: string; actionHash: string; approver: Principal; at: number }): Promise<void> {
  const audit = approvalGrantedEvent({ id: `adv_audit_${++auditN}`, at: o.at, requestId: o.requestId, runId: o.runId, sessionId: o.sessionId, actionHash: o.actionHash, approver: o.approver, trace: { goalId: 'g1', intentionId: 'i1', stepId: 'c' } });
  await ledger.approve(o.requestId, o.approver, o.sessionId, o.at, audit);
}

/** Request + grant an approval exactly as the loop does for a gate.pr hold (D6): bound to prActionHash of the committed sha. */
export async function grantPr(
  ledger: Ledger,
  o: { sha: string; requestId?: string; intentionId?: string; stepId?: string; attempt?: number; sessionId?: string; runId?: string; approver?: Principal; requester?: Principal; actionHash?: string; ttlMs?: number },
): Promise<GateApproval> {
  const requestId = o.requestId ?? 'ap1';
  const actionHash = o.actionHash ?? prActionHash({ intentionId: o.intentionId ?? 'i1', stepId: o.stepId ?? 'pr', attempt: o.attempt ?? 0, sha: o.sha });
  await ledger.requestApproval({ requestId, runId: o.runId ?? 'run1', sessionId: o.sessionId ?? 's1', actionHash, requester: o.requester ?? LOOP, reason: 'gate.pr pr', expiresAt: NOW + (o.ttlMs ?? 60_000) });
  await grantAudited(ledger, { requestId, runId: o.runId ?? 'run1', sessionId: o.sessionId ?? 's1', actionHash, approver: o.approver ?? HUMAN, at: NOW });
  return { requestId, sessionId: o.sessionId ?? 's1', actionHash };
}

export interface GateRig {
  repo: Repo;
  ledger: Ledger;
  gates: Gates;
  plan: Plan;
  reviewer: StubReviewer;
  runner: StubRunner;
  /** The run budget pools are open (the review gate reserves before asking). */
  ready: Promise<void>;
  /** Where the PR gate writes `<run>/pr/` (patch bundle, body, request.json). */
  runsDir: string;
  ctx(stepId: StepId, o?: Partial<CtxOptions>): GateContext;
}

/** The run budget pools the loop opens before any seat is called (the review gate reserves against them). */
export function openRunBudgets(ledger: Ledger, runId = 'run1'): Promise<void> {
  // started together: each ledger's openBudget does its work before its first await, so the pools exist on return
  return Promise.all([ledger.openBudget(runId, 'usd', 2), ledger.openBudget(runId, 'tokens', 200_000), ledger.openBudget(runId, 'calls', 100)]).then(() => undefined);
}

/** A repository with the given change applied, and the three gates over it (no step run yet). */
export function gateRig(o: { change?: (r: Repo) => void; files?: Record<string, string>; m?: Manifest; p?: Plan; reviewer?: StubReviewer; runner?: StubRunner; ledger?: Ledger; extra?: Partial<CreateGatesOptions> } = {}): GateRig {
  const repo = makeRepo(o.files);
  o.change?.(repo);
  const ledger = o.ledger ?? new MemoryLedger();
  const ready = openRunBudgets(ledger);
  const reviewer = o.reviewer ?? new StubReviewer('openai');
  const runner = o.runner ?? new StubRunner();
  const p = o.p ?? plan();
  const runsDir = tmp('tecera-adv-runs-');
  // gh: null — the host's real gh is never invoked by this suite (no remote: the PR gate records pr.requested)
  const gates = createGates({ manifest: o.m ?? manifest(), ledger, verifyRunner: runner, reviewer, writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1', runsDir, gh: null, ...o.extra });
  return { repo, ledger, gates, plan: p, reviewer, runner, ready, runsDir, ctx: (stepId, x = {}) => gateCtx(stepId, { worktree: repo.dir, plan: p, ...x }) };
}

/**
 * verify → review → verify → commit, the way the loop drives the gate steps (D6: the commit to the work
 * branch takes no approval; the PR gate is the only approval point, see driveToPr).
 * `compromisedReview`: pretend the review approved D1 whatever the reviewer said (a compromised or buggy
 * reviewer), so the commit gate's OWN boundary/tamper/link checks are what is being tested.
 */
export async function driveToCommit(rig: GateRig, o: { beforeCommit?: () => void | Promise<void>; afterVerify?: () => void | Promise<void>; compromisedReview?: boolean } = {}) {
  await rig.ready;
  const v = await rig.gates.verify(rig.ctx('v'));
  await o.afterVerify?.();
  const r = await rig.gates.review(rig.ctx('r', { candidate: { d1: v.fingerprint } }));
  // the review gate must never refuse for want of a budget here: a refusal for another reason than the attack
  // would make every "refused" assertion below vacuous
  if (r.reason === 'budget') throw new Error(`harness: review refused for budget (run pools not open): ${JSON.stringify(r)}`);
  if (o.compromisedReview) {
    const key = 'run1:i1';
    const rv = rig.gates.memo.review.get(key);
    const vm = rig.gates.memo.verify.get(key);
    rig.gates.memo.review.set(key, { evidenceKey: rv?.evidenceKey ?? r.evidenceKey, verdict: 'approve', d1: v.fingerprint, d2: v.fingerprint, files: vm?.files });
  }
  const v2 = await rig.gates.verify(rig.ctx('v'));
  await o.beforeCommit?.();
  const d1 = v2.fingerprint || v.fingerprint;
  const c = await rig.gates.commit(rig.ctx('c', { candidate: { d1, d2: o.compromisedReview ? d1 : (r.fingerprint ?? '') } }));
  // likewise a refusal for want of a write guard would make every commit refusal below vacuous
  if (c.reason === 'no-write-guard' || c.reason === 'reconcile-needs-guard') throw new Error(`harness: commit refused for want of a write guard: ${JSON.stringify(c)}`);
  return { v, r, v2, c, d1 };
}

/**
 * driveToCommit, then the PR gate on a human grant bound to the committed sha (prActionHash), as the loop
 * holds it. `grant: false` asks the PR gate without any approval.
 */
export async function driveToPr(rig: GateRig, o: { grant?: boolean; beforePr?: (x: { sha: string; d1: string }) => void | Promise<void> } = {}) {
  const d = await driveToCommit(rig);
  if (d.c.exitCode !== 0 || !d.c.sha) throw new Error(`harness: the commit gate refused before the PR gate: ${JSON.stringify(d.c)}`);
  const sha = d.c.sha;
  const ap = o.grant === false ? undefined : await grantPr(rig.ledger, { sha });
  await o.beforePr?.({ sha, d1: d.d1 });
  const commit = { sha, d1: d.d1, evidenceKey: d.c.evidenceKey };
  const pr = await rig.gates.pr(rig.ctx('pr', { ...(ap ? { approval: ap } : {}), commit }));
  return { ...d, sha, ap, commit, pr };
}

export const branchExists = (r: Repo, name = 'tecera/g1'): boolean => {
  try {
    r.g('rev-parse', '--verify', '--quiet', `refs/heads/${name}`);
    return true;
  } catch {
    return false;
  }
};
