import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  approvalGrantedEvent,
  FencedWriteGuard,
  MANDATORY_HOOKS,
  parseManifest,
  type GateApproval,
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
import { MemoryLedger, SqliteLedger } from '@tecera/ledger';
import { commitActionHash, prActionHash } from '../actionHash.js';
import type { StepContext } from '../types.js';

/** Test-only helpers (excluded from the build). Every repo lives under os.tmpdir(), never /mnt/c. */

const TEST_HOME = mkdtempSync(join(tmpdir(), 'tecera-gates-testhome-'));

/** Explicit minimal environment for test git: no supervisor variables (keys, canaries) leak into hooks. */
export const GIT_TEST_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: TEST_HOME,
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
  const dir = mkdtempSync(join(tmpdir(), 'tecera-gates-'));
  const g = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: GIT_TEST_ENV, encoding: 'utf8' });
  const write = (path: string, content: string | Buffer) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  g('init', '-q', '-b', 'main');
  const base: Record<string, string> = {
    'src/a.ts': 'export const a = 1;\n',
    'src/a.test.ts': "import { expect, it } from 'vitest';\nimport { a } from './a';\nit('a', () => {\n  expect(a).toBe(2);\n});\n",
    'package.json': '{\n  "name": "x",\n  "scripts": {\n    "test": "vitest run"\n  }\n}\n',
    '.gitignore': 'ignored/\n*.log\n',
    ...files,
  };
  for (const [p, c] of Object.entries(base)) write(p, c);
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  return { dir, g, write };
}

export function manifest(overrides: Partial<ManifestInput> = {}): Manifest {
  return parseManifest({
    schemaVersion: 1,
    id: 'bc_8f1e2a9c',
    name: 'sample',
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
    verify: { command: 'node --test', timeoutSec: 300 },
    review: { foreign: true, maxAttempts: 1 },
    hooks: { mandatory: [...MANDATORY_HOOKS] },
    ...overrides,
  });
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
  worktree?: string;
  approval?: GateApproval;
  candidate?: { d1?: string; d2?: string };
  /** gate.pr: the commit the intention recorded. */
  commit?: { sha: string; d1?: string; evidenceKey?: string };
  plan?: Plan;
  goalId?: string;
  signal?: AbortSignal;
  /** The mutation-time fence the loop hands to gates. Default: a live guard; null: none (the gate must refuse). */
  guard?: WriteGuard | null;
}

/** A guard that stays live until `revoke(reason)`; `checks` counts check() calls. */
export function liveGuard(): { guard: WriteGuard; revoke(reason?: string): void; readonly checks: number; onCheck?: () => void } {
  const ac = new AbortController();
  let revoked: string | null = null;
  const state = {
    checks: 0,
    onCheck: undefined as undefined | (() => void),
    revoke(reason = 'lease lost') {
      revoked = reason;
      ac.abort(new Error(reason));
    },
    guard: undefined as unknown as WriteGuard,
  };
  state.guard = new FencedWriteGuard({
    signal: ac.signal,
    live: () => {
      state.checks++;
      state.onCheck?.();
      return revoked;
    },
  });
  return state;
}

export function ctx(stepId: 'v' | 'r' | 'c' | 'pr', o: CtxOptions = {}): StepContext {
  const p = o.plan ?? plan();
  const step = p.steps.find((s) => s.id === stepId) as Step;
  const goalId = o.goalId ?? 'g1';
  return {
    runId: o.runId ?? 'run1',
    goal: { id: goalId, statement: 'make a two', check: { command: 'node --test', timeoutSec: 60 }, commitment: 'single-minded', status: 'open', evidence: [] },
    plan: p,
    intention: { id: o.intentionId ?? 'i1', goalId, planId: p.id, commitment: 'single-minded', status: 'running', stepStatus: {}, attempt: o.attempt ?? 0 },
    step,
    worktree: o.worktree ?? '',
    ...(o.approval ? { approval: o.approval } : {}),
    ...(o.candidate ? { candidate: o.candidate } : {}),
    ...(o.commit ? { commit: o.commit } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.guard === null ? {} : { guard: o.guard ?? liveGuard().guard }),
  };
}

export class FakeRunner implements VerifyRunner {
  calls: VerifyRequest[] = [];
  constructor(private readonly fn: (req: VerifyRequest) => Partial<VerifyOutcome> | Promise<Partial<VerifyOutcome>> = () => ({})) {}
  async run(req: VerifyRequest): Promise<VerifyOutcome> {
    this.calls.push(req);
    const r = await this.fn(req);
    return { exitCode: 0, signal: null, timedOut: false, stdout: 'ok', stderr: '', durationMs: 5, truncated: false, ...r };
  }
}

export class FakeReviewer implements LLM {
  calls: LLMRequest[] = [];
  readonly keyFingerprint: string | undefined;
  constructor(
    public readonly provider: string,
    private readonly fn: (req: LLMRequest) => string | Promise<string> = () => '{"verdict":"approve","findings":[]}',
    public readonly id = `${provider}-reviewer`,
    keyFingerprint: string | null = `kf-${provider}`,
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

/** Open the run's calls/usd/tokens pools as the runtime does before the loop starts (the reviewer seat reserves on them). */
export function withBudget<L extends Ledger>(ledger: L, runId = 'run1', o: { usd?: number; tokens?: number; calls?: number } = {}): L {
  void ledger.openBudget(runId, 'calls', o.calls ?? 1000);
  void ledger.openBudget(runId, 'usd', o.usd ?? 100);
  void ledger.openBudget(runId, 'tokens', o.tokens ?? 10_000_000);
  return ledger;
}

/** A MemoryLedger with run1's pools open. */
export function memLedger(): MemoryLedger {
  return withBudget(new MemoryLedger());
}

export function sqlitePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'tecera-gates-ledger-')), 'l.sqlite');
}

export const LEDGERS: Array<[string, () => Ledger]> = [
  ['MemoryLedger', () => memLedger()],
  ['SqliteLedger', () => withBudget(new SqliteLedger(sqlitePath()))],
];

export const NOW = 1_000_000;
export const HUMAN: Principal = { kind: 'human', id: 'alice' };
export const LOOP: Principal = { kind: 'agent', id: 'loop' };

/** Request + grant an approval exactly as the loop would for a gate.commit hold. */
export async function grant(
  ledger: Ledger,
  o: { d1: string; requestId?: string; intentionId?: string; stepId?: string; attempt?: number; actionHash?: string; requester?: Principal; approver?: Principal; sessionId?: string; grantSession?: string; ttl?: number; runId?: string },
): Promise<GateApproval> {
  const requestId = o.requestId ?? 'ap1';
  const runId = o.runId ?? 'run1';
  const actionHash = o.actionHash ?? commitActionHash({ intentionId: o.intentionId ?? 'i1', stepId: o.stepId ?? 'c', attempt: o.attempt ?? 0, candidateD1: o.d1 });
  await ledger.requestApproval({ requestId, runId, sessionId: o.sessionId ?? 's1', actionHash, requester: o.requester ?? LOOP, reason: 'gate.commit c', expiresAt: NOW + (o.ttl ?? 60_000) });
  await grantAudited(ledger, { requestId, runId, sessionId: o.grantSession ?? o.sessionId ?? 's1', actionHash, approver: o.approver ?? HUMAN, intentionId: o.intentionId ?? 'i1', stepId: o.stepId ?? 'c' });
  return { requestId, sessionId: o.sessionId ?? 's1', actionHash };
}

/** Request + grant an approval exactly as the loop would for a gate.pr hold (D6): bound to prActionHash of the committed sha. */
export async function prGrant(
  ledger: Ledger,
  o: { sha: string; requestId?: string; intentionId?: string; stepId?: string; attempt?: number; actionHash?: string; requester?: Principal; approver?: Principal; sessionId?: string; ttl?: number; runId?: string },
): Promise<GateApproval> {
  const requestId = o.requestId ?? 'pr1';
  const runId = o.runId ?? 'run1';
  const sessionId = o.sessionId ?? 's1';
  const actionHash = o.actionHash ?? prActionHash({ intentionId: o.intentionId ?? 'i1', stepId: o.stepId ?? 'pr', attempt: o.attempt ?? 0, sha: o.sha });
  await ledger.requestApproval({ requestId, runId, sessionId, actionHash, requester: o.requester ?? LOOP, reason: 'gate.pr pr', expiresAt: NOW + (o.ttl ?? 60_000) });
  await grantAudited(ledger, { requestId, runId, sessionId, actionHash, approver: o.approver ?? HUMAN, intentionId: o.intentionId ?? 'i1', stepId: o.stepId ?? 'pr' });
  return { requestId, sessionId, actionHash };
}

/** Grant through approve(…, audit) exactly as authenticated ingress does: grant and approval.granted event atomically. */
export async function grantAudited(
  ledger: Ledger,
  o: { requestId: string; runId: string; sessionId: string; actionHash: string; approver?: Principal; intentionId?: string; stepId?: string; at?: number },
): Promise<void> {
  const approver = o.approver ?? HUMAN;
  const audit = approvalGrantedEvent({
    id: `ev-grant-${o.requestId}`,
    at: o.at ?? NOW,
    requestId: o.requestId,
    runId: o.runId,
    sessionId: o.sessionId,
    actionHash: o.actionHash,
    approver,
    trace: { goalId: 'g1', intentionId: o.intentionId ?? 'i1', stepId: o.stepId ?? 'c' },
  });
  try {
    await ledger.approve(o.requestId, approver, o.sessionId, o.at ?? NOW, audit);
  } catch {
    // self-approval, agent approvers and similar are refused at grant time; consume must refuse too
  }
}
