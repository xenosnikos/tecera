import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TeceraEvent } from '@tecera/contracts';
import { SqliteLedger } from '@tecera/ledger';
import { createWiring, main, type MainOptions, type WireFn, type WiringOptions } from '@tecera/runtime';
import { RUNTIME_FIXTURES, SAMPLE, tmp } from './tmp.js';

/**
 * Drive `tecera run` end to end on a temp copy of samples/fix-failing-test with scripted models: the
 * real ledger, provider adapters (scripted transport), sandbox child, verify runner, gates and git. Reuses
 * the runtime lane's shipped fixtures (packages/runtime/test-fixtures/fix-failing-test).
 *
 * Owner decisions D1/D6: the sample runs under `isolation: 'node'` (degraded), yet worker writes inside
 * repo.allowedChanges proceed with no approval (fenced and logged) and gate.commit commits to the work branch
 * tecera/<goal> with no approval. The ONLY approval point is gate.pr: the run holds there (exit 4), a local
 * human principal approves (`tecera approve <id> --as <who>`; no tokens), and the resume delivers the PR
 * (pr.opened / pr.requested with a patch bundle) and records goal.achieved with its proof (D4). Scripted
 * replies restart with each process, so a whole run is segments (run → approve → resume); `Flow` drives them
 * and hands each segment only the replies not yet used.
 */

export { createWiring };
export type { WireFn, WiringOptions };

/** This host runs as root and its node binary is unreadable to an unprivileged uid: the operator opt-in to a degraded (recorded) root verify. */
export const HOST_ENV: Record<string, string> = typeof process.getuid === 'function' && process.getuid() === 0 ? { TECERA_VERIFY_ALLOW_ROOT: '1' } : {};
export const ENV: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/root', USER: 'tester', ...HOST_ENV };
/**
 * Test-only provider credentials (never the host's live keys: /root/.config/tecera/live.env is never read by
 * this suite). The sample's planner and worker seats are OpenRouter seats (D7), its reviewer an OpenAI seat.
 */
export const KEYS = { ANTHROPIC_API_KEY: 'test-anthropic-credential-0123456789', OPENAI_API_KEY: 'test-openai-credential-9876543210', OPENROUTER_API_KEY: 'sk-or-v1-test-openrouter-credential-5a5a5a5a' };
/** The check every adversarial copy must end up with (never npm: this host's global npm is untrusted). */
export const CHECK = 'node --test';
/** A verify command that would run npm or npx (refused before anything executes). */
export const NPM_RE = /(^|[\s;&|(`])(npm|npx)(\s|$)/;

export type Ev = TeceraEvent & { seq: number; hash: string };

export function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  }).toString('utf8');
}

let idn = 0;
export async function cli(cwd: string, argv: string[], opts: MainOptions = {}): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const { env: extraEnv, ...rest } = opts;
  const code = await main(argv, {
    cwd,
    env: { ...ENV, ...(extraEnv ?? {}) },
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    isTTY: false,
    ids: (p) => `${p}_a${++idn}`,
    ...rest,
  });
  return { code, out, err };
}

export async function ledgerEvents(dir: string): Promise<Ev[]> {
  const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
  const out: Ev[] = [];
  try {
    for await (const e of l.events()) out.push(e);
  } finally {
    l.close();
  }
  return out;
}

export async function dump(dir: string): Promise<string> {
  if (!existsSync(join(dir, '.tecera/ledger.sqlite'))) return '(no ledger)';
  const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
  const lines: string[] = [];
  try {
    for await (const e of l.events()) lines.push(`${e.seq} ${e.kind} ${e.trace.stepId ?? ''} ${JSON.stringify(e.payload).slice(0, 400)}`);
  } finally {
    l.close();
  }
  return lines.join('\n');
}

/** Every verify command a copy of the sample would run: manifest, goal files, package.json#scripts.test. */
export function checkCommands(dir: string): Array<{ where: string; command: string }> {
  const out: Array<{ where: string; command: string }> = [];
  const m = JSON.parse(readFileSync(join(dir, 'tecera.json'), 'utf8')) as { verify?: { command?: string } };
  if (m.verify?.command !== undefined) out.push({ where: 'tecera.json verify.command', command: m.verify.command });
  const goal = join(dir, '.tecera/goals/fix-failing-test.goal.md');
  if (existsSync(goal)) for (const g of readFileSync(goal, 'utf8').matchAll(/^verify:\s*(.*)$/gm)) out.push({ where: 'goal verify', command: g[1]!.trim() });
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts?: { test?: string } };
  if (pkg.scripts?.test !== undefined) out.push({ where: 'package.json scripts.test', command: pkg.scripts.test });
  return out;
}

export interface SampleOptions {
  /** Edit the copy before `tecera init` and the base commit. */
  mutate?: (dir: string) => void;
  /** Called after the base commit (e.g. to plant hooks or repo config that is not committed). */
  afterCommit?: (dir: string) => void;
  /**
   * Leave the copy exactly as shipped (no rewrite at all). The caller must then prove it is npm-free before
   * running anything (see checkCommands).
   */
  asIs?: boolean;
}

/**
 * A temp copy of the sample, initialised and committed on `main`; plus an empty worktrees root.
 *
 * Unless `asIs`, the only rewrite is a stale `verify: npm test` goal line (the sample's own file, owned by
 * another lane) → `node --test`. Every check command of the copy is then asserted npm-free, so this suite can
 * never run npm whatever the sample says.
 */
export async function sampleRepo(o: SampleOptions = {}): Promise<{ dir: string; wt: string }> {
  const dir = tmp('tecera-adv-e2e-');
  cpSync(SAMPLE, dir, { recursive: true, filter: (src) => !/node_modules|ledger\.sqlite|[\\/]runs([\\/]|$)/.test(src) });
  if (!o.asIs) {
    const goalPath = join(dir, '.tecera/goals/fix-failing-test.goal.md');
    writeFileSync(goalPath, readFileSync(goalPath, 'utf8').replace(/^verify:\s*npm test\s*$/m, `verify: ${CHECK}`));
  }
  o.mutate?.(dir);
  const npm = checkCommands(dir).filter((c) => NPM_RE.test(c.command));
  if (npm.length) throw new Error(`refusing to run a copy whose check runs npm/npx: ${npm.map((c) => `${c.where}: ${c.command}`).join('; ')}`);
  const r = await cli(dir, ['init']);
  if (r.code !== 0) throw new Error(`tecera init failed (${r.code}): ${r.err}`);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  o.afterCommit?.(dir);
  const wt = tmp('tecera-adv-wt-');
  return { dir, wt };
}

export interface Reply {
  text: string;
  expect?: string;
  usage?: { input?: number; output?: number };
}
export interface Replies {
  worker: Reply[];
  reviewer: Reply[];
  [seat: string]: Reply[];
}

export const fixtureReplies = (): Replies => JSON.parse(readFileSync(join(RUNTIME_FIXTURES, 'replies.json'), 'utf8'));

/**
 * A scripts dir: the shipped sample plan plus the given replies (default: the shipped fixture). `plan: null`
 * writes no plan.json, so the planner SEAT is asked (scripted replies.planner) through the real LLMPlanner.
 */
export function scripts(replies?: Partial<Replies>, plan?: unknown): string {
  const d = tmp('tecera-adv-scripts-');
  if (plan === null) {
    /* no scripted plan: the planner seat plans */
  } else if (plan) writeFileSync(join(d, 'plan.json'), JSON.stringify(plan));
  else cpSync(join(RUNTIME_FIXTURES, 'plan.json'), join(d, 'plan.json'));
  writeFileSync(join(d, 'replies.json'), JSON.stringify(replies ?? fixtureReplies()));
  return d;
}

export const fixturePlan = (): Record<string, unknown> => JSON.parse(readFileSync(join(RUNTIME_FIXTURES, 'plan.json'), 'utf8'));

export const js = (body: string): string => `\`\`\`js\n${body}\n\`\`\``;

export const runIdOf = (evs: readonly Ev[]): string => {
  const e = evs.find((x) => x.kind === 'run.started');
  if (!e?.runId) throw new Error('no run.started event');
  return e.runId;
};

const CLOSED = new Set(['approval.granted', 'approval.denied', 'approval.expired', 'approval.consumed']);

/**
 * The newest approval request that is neither granted, denied, expired nor consumed: a loop hold
 * (approval.requested) or a worker suspended mid-program (step.held carrying the worker's request id).
 */
export function pendingRequest(evs: readonly Ev[]): Ev | undefined {
  const closed = new Set(evs.filter((e) => CLOSED.has(e.kind)).map((e) => (e.payload as { requestId?: string }).requestId));
  return [...evs].reverse().find((e) => (e.kind === 'approval.requested' || e.kind === 'step.held') && typeof (e.payload as { requestId?: unknown }).requestId === 'string' && !closed.has((e.payload as { requestId: string }).requestId));
}

export const requestIdOf = (e: Ev | undefined): string | undefined => (e?.payload as { requestId?: string } | undefined)?.requestId;

/** The PR step's approval request (D6: the only approval point of a delivery plan). */
export const prRequest = (evs: readonly Ev[]): Ev | undefined => evs.find((e) => e.kind === 'approval.requested' && e.trace.stepId === 'pr');

/** The approver this suite acts as: a local human principal (D1: `tecera approve --as <id>`, no tokens). */
export const APPROVER = 'reviewer-human';

/** Approve as the local human principal `as` (D1). No opt-in env var, no token: the CLI's only ingress. */
export async function approve(dir: string, requestId: string, env: Record<string, string> = {}, as: string | null = APPROVER): Promise<{ code: number; out: string; err: string }> {
  return cli(dir, ['approve', requestId, ...(as === null ? [] : ['--as', as]), '--yes'], { env: { ...KEYS, ...env } });
}

/** `tecera hook stop` as Claude Code calls it (D4): exit 2 blocks with the reason on stderr, exit 0 allows. */
export async function stopHook(dir: string, extra: Record<string, unknown> = {}): Promise<{ code: number; out: string; err: string }> {
  return cli(dir, ['hook', 'stop'], { stdin: JSON.stringify({ hook_event_name: 'Stop', cwd: dir, session_id: 'cc-adv', stop_hook_active: false, ...extra }) });
}

/** Per-segment wiring options: the runtime's WiringOptions, plus an optional wrapper around the real wiring. */
export type SegmentWire = Omit<WiringOptions, 'tap'> & { tap?: WiringOptions['tap']; wrap?: (inner: WireFn) => WireFn };

export interface Segment {
  code: number;
  out: string;
  err: string;
  /** Requests per scripted seat in this segment. */
  asked: Record<string, number>;
}

/**
 * A scripted run driven across its segments. Each segment gets a fresh scripts dir holding only the replies
 * the earlier segments did not consume (a scripted seat shifts one reply per request).
 */
export class Flow {
  readonly env: Record<string, string>;
  runId = '';
  readonly segments: Segment[] = [];
  private queue: Record<string, Reply[]>;

  constructor(
    readonly dir: string,
    readonly wt: string,
    replies: Partial<Replies> = fixtureReplies(),
    extraEnv: Record<string, string> = {},
    private readonly plan?: unknown,
  ) {
    this.env = { ...KEYS, TECERA_WORKTREES: wt, ...extraEnv };
    this.queue = Object.fromEntries(Object.entries(replies).map(([k, v]) => [k, [...(v ?? [])]]));
  }

  /** Replies not used yet (per seat). */
  remaining(): Record<string, Reply[]> {
    return Object.fromEntries(Object.entries(this.queue).map(([k, v]) => [k, [...v]]));
  }

  /** Replace what the next segments are answered with (e.g. a different program for a restarted step). */
  setReplies(replies: Partial<Replies>): void {
    this.queue = Object.fromEntries(Object.entries(replies).map(([k, v]) => [k, [...(v ?? [])]]));
  }

  /** Account for requests made outside this process (a crashed supervisor's segment). */
  consumed(asked: Record<string, number>): void {
    for (const [seat, n] of Object.entries(asked)) this.queue[seat] = (this.queue[seat] ?? []).slice(n);
  }

  scriptsDir(): string {
    return scripts(this.remaining(), this.plan);
  }

  /** argv for the next segment: the first run, or a resume. */
  argv(): string[] {
    return this.runId ? ['run', '--resume', this.runId, '--scripted', this.scriptsDir()] : ['run', 'fix-failing-test', '--scripted', this.scriptsDir()];
  }

  /**
   * Run one segment in this process (run or resume). `wrap` lets an attack wrap the real wiring (e.g. hold
   * the ledger, replace a gate port); it must call the inner wiring and keep every port it does not replace.
   */
  async segment(o: SegmentWire = {}): Promise<Segment> {
    const asked: Record<string, number> = {};
    const { tap, wrap, ...rest } = o;
    const inner = createWiring({
      ...rest,
      tap: (seat, url, body) => {
        asked[seat] = (asked[seat] ?? 0) + 1;
        tap?.(seat, url, body);
      },
    });
    const wire = wrap ? wrap(inner) : inner;
    const r = await cli(this.dir, this.argv(), { env: this.env, wire });
    this.consumed(asked);
    if (!this.runId) {
      const evs = existsSync(join(this.dir, '.tecera/ledger.sqlite')) ? await ledgerEvents(this.dir) : [];
      this.runId = evs.find((e) => e.kind === 'run.started')?.runId ?? '';
    }
    const seg = { ...r, asked };
    this.segments.push(seg);
    return seg;
  }

  /** The run's worktree, also while its first segment is still running (the runId is not known here yet). */
  worktree(): string {
    if (this.runId) return join(this.wt, this.runId);
    const dirs = readdirSync(this.wt, { withFileTypes: true }).filter((d) => d.isDirectory());
    if (dirs.length !== 1) throw new Error(`expected one run worktree under ${this.wt}, found ${dirs.map((d) => d.name).join(', ') || 'none'}`);
    return join(this.wt, dirs[0]!.name);
  }

  async events(): Promise<Ev[]> {
    return (await ledgerEvents(this.dir)).filter((e) => !this.runId || e.runId === this.runId || e.runId === undefined);
  }

  async pending(): Promise<Ev | undefined> {
    return pendingRequest(await this.events());
  }

  /** Approve the pending request; when `step` is given it must be that step's. Returns its request id. */
  async approvePending(step?: string): Promise<string> {
    const p = await this.pending();
    if (!p) throw new Error(`no pending approval\n${await dump(this.dir)}`);
    if (step !== undefined && p.trace.stepId !== step) throw new Error(`pending approval is for ${p.trace.stepId}, expected ${step}\n${await dump(this.dir)}`);
    const rid = requestIdOf(p)!;
    const a = await approve(this.dir, rid, this.env);
    if (a.code !== 0) throw new Error(`approve ${rid} failed (${a.code}): ${a.err}`);
    return rid;
  }

  /**
   * Run (or resume) ONE segment and return where it stopped: under D6 nothing holds before the PR, so a
   * healthy run stops at the PR hold (exit 4 with the 'pr' step pending), a failure, or the end. No hold is
   * ever approved on the way: a hold of any other step is returned to the caller as it is (the tests assert
   * there is none).
   */
  async drive(o: { wire?: SegmentWire } = {}): Promise<Segment> {
    return this.segment(o.wire);
  }

  /** From the PR hold: approve it as the local human principal and resume to the end. */
  async finish(wire?: SegmentWire): Promise<Segment> {
    await this.approvePending('pr');
    return this.segment(wire);
  }
}
