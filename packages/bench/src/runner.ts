import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptedContractOf, parseManifest, type AcceptanceContract, type EvidenceRecord, type TeceraEvent } from '@tecera/contracts';
import { SqliteLedger } from '@tecera/ledger';
import { HIDDEN_MOUNT, loadScenarios, type Intervention, type Scenario } from './scenario.js';
import { score, type LedgerRow, type RepoChange, type RepoState, type ScenarioScore } from './scorer.js';
import { buildScorecard, LEDGER_ONLY_METRICS, writeScorecard, type LedgerlessScore, type Scorecard } from './scorecard.js';

/**
 * The benchmark runner. For each scenario it copies the fixture's `repo/` (never scenario.json, hidden/ or
 * the patches) into a fresh temp directory, pins it with `tecera init`, commits it on `main`, and drives the
 * real CLI entry (packages/tecera/bin/tecera.js, spawned as a child process; nothing of the loop is imported)
 * through the human steps the scenario needs:
 *
 * - a held criteria sign-off is accepted by a local human who is not the requester (`tecera criteria accept`);
 * - a held PR (or a human criterion) is approved by a second local human (`tecera approve`);
 * - interventions: `kill` stops the run's process (SIGTERM, what kill(1) sends; the CLI records
 *   run.interrupted) when its n-th step.started is recorded, then resumes it. A SIGKILL would leave the dead
 *   process's worktree lease held until its TTL runs out, and every resume would be refused until then.
 *   `amend`: once the n-th step.started is recorded, at the run's next hold a human records the amendment
 *   (`tecera criteria amend`) instead of answering the hold, then the run resumes. A live loop reads an
 *   amendment appended by another process only at restore, so it is never written under a running segment.
 *
 * Every one of those that the CLI accepted is a human touch and is counted. The ledger and the delivered
 * repository (the commit of the last PR a human approved, nothing else) are then handed to the scorer,
 * which reads nothing else.
 *
 * Modes:
 * - `scripted` (offline, deterministic, what CI runs): every `tecera run` segment gets `--scripted <dir>`
 *   built from the fixture's `scripted/` directory (plan.json, contract.json, replies.json; a
 *   `replies.<k>.json` replaces replies.json for the k-th segment, because each segment serves its
 *   replies from the start). Provider credentials are fixed dummies: no request leaves the host.
 * - `live`: real models through the manifest's seats; the provider keys the manifest references are passed
 *   from the environment by name (never printed, never written); every scenario has a wall-clock limit.
 *
 * Baseline (`baseline`): an arbitrary agent command runs through `sh -c` in a fresh copy of the same
 * fixture, and the resulting repository is scored by the same scorer. It leaves no ledger, so ledger
 * metrics are reported as not available (`ledger: false`), never as zero.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** The repository root (packages/bench/{src,dist} → ../../..). */
export const REPO_ROOT = resolve(HERE, '..', '..', '..');
/** The tecera CLI entry the runner spawns. */
export const TECERA_BIN = join(REPO_ROOT, 'packages', 'tecera', 'bin', 'tecera.js');

/** The local humans the runner acts as. The requester starts runs; the others decide, and are never the requester. */
export const HUMANS = { requester: 'bench-requester', acceptor: 'bench-acceptor', reviewer: 'bench-reviewer' } as const;

/** Exit codes of the CLI the runner reacts to (dx.md §4). */
const EXIT_HELD = 4;
/** The CLI refused to start here (readiness, or the baseline check's tooling): the host, not the scenario. */
const EXIT_NOT_READY = 3;

/** The last line of a CLI's output that says something (its own reason for an exit), bounded. */
export function lastReason(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !/ExperimentalWarning|--trace-warnings/.test(l));
  return (lines.at(-1) ?? '').slice(0, 300);
}

export type BenchMode = 'scripted' | 'live';

export interface RunnerOptions {
  mode: BenchMode;
  /** Scenario numbers to run (default: all). */
  scenarios?: number[];
  /** Where scorecard.json / scorecard.md go (none written when absent). */
  out?: string;
  /** A baseline agent command, run per scenario in a fresh copy of the fixture. */
  baseline?: string;
  /** Name of the baseline agent on the scorecard (default: the command's first word). */
  baselineName?: string;
  /** Fixtures root (default: the package's fixtures). */
  fixtures?: string;
  /** CLI entry (default TECERA_BIN). */
  bin?: string;
  /** Wall-clock limit per scenario, seconds (default 600 scripted, 1800 live). */
  timeoutSec?: number;
  /** Environment the runner reads host settings and live keys from (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Keep each scenario's work directory (default: removed after scoring). */
  keep?: boolean;
  /** Progress lines (never carry an environment value). */
  log?: (line: string) => void;
  /** Clock for the scorecard's generatedAt (default Date.now). */
  now?: () => number;
  /** Scenarios driven at once (default 1). Each has its own repository, ledger, worktrees and resources. */
  concurrency?: number;
}

/** One human decision or intervention the runner performed. */
export interface Touch {
  kind: 'signoff' | 'approval' | 'answer' | 'amend' | 'kill';
  as?: string;
  ref?: string;
  exitCode: number;
}

export interface Segment {
  argv: string[];
  exitCode: number | null;
  /** Set when the runner stopped the process for an intervention. */
  stoppedBy?: Intervention['kind'];
  ms: number;
}

/**
 * A baseline's score: the same scorer, but it left no ledger, so the ledger-only metrics are null (not
 * available, never zero). `stopped` is set when the agent passed the wall-clock limit (its partial work is
 * still scored, but the baseline does not pass); `exitCode` is the agent command's own.
 */
export type BaselineScore = LedgerlessScore & { exitCode: number | null; stopped?: string };

export { LEDGER_ONLY_METRICS };

export interface ScenarioRun {
  scenario: Scenario;
  score: ScenarioScore;
  baseline?: BaselineScore;
  /** Every human touch the runner performed (approvals, sign-offs, amendments, kills). */
  touches: Touch[];
  segments: Segment[];
  runId?: string;
  /** Why the drive stopped early (a hold nobody may answer, the wall-clock limit, a CLI error), if it did. */
  stopped?: string;
  /** The kept work directory (only with `keep`): `<workDir>/repo` is the business case, `base` its first commit. */
  workDir?: string;
  base?: string;
}

export interface BenchResult {
  card: Scorecard;
  runs: ScenarioRun[];
  files?: { json: string; md: string };
}

// ── processes ────────────────────────────────────────────────────────────────────────────────────────

interface Proc {
  code: number | null;
  signal: NodeJS.Signals | null;
  out: string;
  err: string;
  timedOut: boolean;
}

const MAX_CAPTURE = 4 * 1024 * 1024;

/**
 * Spawn `cmd args` in its own process group, capture its output (bounded), stop the whole group at the
 * deadline. `watch` is polled while it runs; returning a signal stops the process with it.
 */
function launch(cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; deadline: number; watch?: () => NodeJS.Signals | null; stopGroup?: boolean }): Promise<Proc & { watched: NodeJS.Signals | null }> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    let err = '';
    let timedOut = false;
    let watched: NodeJS.Signals | null = null;
    child.stdout.on('data', (d: Buffer) => {
      if (out.length < MAX_CAPTURE) out += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < MAX_CAPTURE) err += d.toString('utf8');
    });
    const kill = (sig: NodeJS.Signals, group: boolean): void => {
      try {
        if (group && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // already gone
      }
    };
    const timer = setInterval(() => {
      if (Date.now() >= o.deadline && !timedOut) {
        timedOut = true;
        kill('SIGKILL', true);
        return;
      }
      if (o.watch && watched === null) {
        const sig = o.watch();
        if (sig) {
          watched = sig;
          // a crash takes the whole tree down; a graceful stop goes to the CLI, which stops its own children
          kill(sig, sig === 'SIGKILL' || o.stopGroup === true);
        }
      }
    }, 50);
    child.on('error', (e) => {
      err += String(e);
    });
    child.on('close', (code, signal) => {
      clearInterval(timer);
      // whatever the run left in its group (a sandboxed step after a SIGKILL) goes with it
      if (watched === 'SIGKILL' || timedOut) kill('SIGKILL', true);
      done({ code, signal, out, err, timedOut, watched });
    });
  });
}

function git(dir: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.email=bench@example.invalid', '-c', 'user.name=bench', '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new RunnerError(`git ${args[0]} failed: ${(r.stderr ?? '').trim().slice(0, 400)}`);
  return r.stdout;
}

export class RunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerError';
  }
}

// ── environment ──────────────────────────────────────────────────────────────────────────────────────

/** Host settings passed through to the CLI by name (the verify sandbox's identity). */
const HOST_PASSTHROUGH = ['TECERA_VERIFY_UID', 'TECERA_VERIFY_GID', 'TECERA_VERIFY_ALLOW_ROOT', 'LANG', 'TZ'];

/** Names the runner sets itself: a manifest's `env:NAME` may not name one (it would replace the requester, the roots or the verify identity). */
const RESERVED_ENV = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'NODE_OPTIONS', 'TECERA_WORKTREES', 'TECERA_RESOURCES', ...HOST_PASSTHROUGH]);

/** Dummy credentials of a scripted run: the scripted transport never sends them anywhere. */
const SCRIPTED_KEYS: Record<string, string> = {
  OPENROUTER_API_KEY: 'bench-scripted-openrouter-credential-000',
  OPENAI_API_KEY: 'bench-scripted-openai-credential-00000000',
  ANTHROPIC_API_KEY: 'bench-scripted-anthropic-credential-0000',
};

/** The environment variable names a manifest's providers authenticate with (`env:NAME`). */
export function providerEnvNames(manifest: unknown): string[] {
  const m = parseManifest(manifest);
  const out: string[] = [];
  for (const p of Object.values(m.providers)) {
    const ref = (p as { auth?: unknown }).auth;
    if (typeof ref === 'string' && ref.startsWith('env:') && !out.includes(ref.slice(4))) out.push(ref.slice(4));
  }
  return out;
}

/**
 * The CLI's environment: a minimal base (PATH, HOME, USER = the requester), the run's own worktree and
 * resources roots, the host's verify identity, and the provider credentials: dummies when scripted, the
 * referenced variables copied by name from `source` when live. Nothing else of the parent leaks in.
 */
export function cliEnv(mode: BenchMode, source: NodeJS.ProcessEnv, roots: { worktrees: string; resources: string }, keyNames: readonly string[]): NodeJS.ProcessEnv {
  const reserved = keyNames.filter((k) => RESERVED_ENV.has(k) || k.startsWith('TECERA_'));
  if (reserved.length) throw new RunnerError(`the manifest's provider auth names ${reserved.join(', ')}, which the runner sets itself`);
  const env: NodeJS.ProcessEnv = { PATH: source.PATH ?? '/usr/bin:/bin', HOME: source.HOME ?? tmpdir(), USER: HUMANS.requester, TECERA_WORKTREES: roots.worktrees, TECERA_RESOURCES: roots.resources };
  for (const k of HOST_PASSTHROUGH) if (typeof source[k] === 'string') env[k] = source[k];
  if (mode === 'scripted') Object.assign(env, SCRIPTED_KEYS);
  else for (const k of keyNames) if (typeof source[k] === 'string' && source[k]) env[k] = source[k];
  return env;
}

/** Live mode needs every provider key the fixture's manifest references; the names that are missing. */
export function missingLiveKeys(keyNames: readonly string[], source: NodeJS.ProcessEnv): string[] {
  return keyNames.filter((k) => !source[k]);
}

/** `text` with the value of every named variable of `env` replaced by its name (a diagnostic never carries a key). */
export function redactEnv(text: string, env: NodeJS.ProcessEnv, names: readonly string[]): string {
  let out = text;
  for (const k of names) {
    const v = env[k];
    if (typeof v === 'string' && v.length >= 4) out = out.split(v).join(`[${k}]`);
  }
  return out;
}

// ── scripted inputs ──────────────────────────────────────────────────────────────────────────────────

/** The fixture's scripted directory (plan.json, contract.json, replies.json, replies.<k>.json). */
export const SCRIPTED_DIR = 'scripted';

/** The scripts dir for the k-th `tecera run` segment (1-based): the fixture's files, with replies.<k>.json as replies.json when present. */
export function segmentScripts(s: Scenario, k: number, into: string): string {
  const src = join(s.dir!, SCRIPTED_DIR);
  if (!existsSync(src)) throw new RunnerError(`${s.id}: no ${SCRIPTED_DIR}/ directory for scripted mode`);
  const dir = join(into, `scripts-${k}`);
  mkdirSync(dir, { recursive: true });
  for (const f of ['plan.json', 'contract.json']) if (existsSync(join(src, f))) cpSync(join(src, f), join(dir, f));
  const own = join(src, `replies.${k}.json`);
  const replies = existsSync(own) ? own : join(src, 'replies.json');
  writeFileSync(join(dir, 'replies.json'), existsSync(replies) ? readFileSync(replies) : '{}');
  return dir;
}

// ── the ledger ───────────────────────────────────────────────────────────────────────────────────────

const LEDGER = join('.tecera', 'ledger.sqlite');

/** Every event (with seq and hash) and every run's evidence, read after the CLI exited. */
export async function readLedger(dir: string): Promise<{ events: LedgerRow[]; evidence: EvidenceRecord[] }> {
  const path = join(dir, LEDGER);
  if (!existsSync(path)) return { events: [], evidence: [] };
  const l = new SqliteLedger(path);
  try {
    const events: LedgerRow[] = [];
    for await (const e of l.events()) events.push(e);
    const runs = [...new Set(events.map((e) => e.runId).filter((r): r is string => !!r))];
    const evidence: EvidenceRecord[] = [];
    for (const r of runs) evidence.push(...(await l.listEvidence(r)));
    return { events, evidence };
  } finally {
    l.close();
  }
}

type ReadOnlyDb = { prepare(sql: string): { get(...a: unknown[]): unknown }; close(): void };
let sqliteModule: Promise<{ DatabaseSync: new (path: string, o: { readOnly: boolean }) => ReadOnlyDb }> | null = null;

/** A read-only counter of step.started rows while another process writes the ledger (WAL). */
async function stepCounter(dir: string): Promise<() => number> {
  sqliteModule ??= import('node:sqlite') as unknown as Promise<{ DatabaseSync: new (path: string, o: { readOnly: boolean }) => ReadOnlyDb }>;
  const { DatabaseSync } = await sqliteModule;
  const path = join(dir, LEDGER);
  return () => {
    if (!existsSync(path)) return 0;
    let db: ReadOnlyDb | null = null;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const row = db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'step.started'").get() as { n?: number } | undefined;
      return Number(row?.n ?? 0);
    } catch {
      return 0;
    } finally {
      db?.close();
    }
  };
}

/** Approval requests still open (requested, never granted, denied, expired or consumed), oldest first. */
export function openRequests(events: ReadonlyArray<TeceraEvent>): TeceraEvent[] {
  const closed = new Set<string>();
  for (const e of events) {
    const rid = (e.payload as { requestId?: unknown }).requestId;
    if (typeof rid === 'string' && ['approval.granted', 'approval.denied', 'approval.expired', 'approval.consumed'].includes(e.kind)) closed.add(rid);
  }
  return events.filter((e) => e.kind === 'approval.requested' && !closed.has(String((e.payload as { requestId?: unknown }).requestId)));
}

/** Open requests of intentions still alive: a request of a dropped or failed intention is never answered. */
export function liveRequests(events: ReadonlyArray<TeceraEvent>): TeceraEvent[] {
  const gone = new Set(events.filter((e) => (e.kind === 'intention.dropped' || e.kind === 'intention.failed') && e.trace.intentionId).map((e) => e.trace.intentionId!));
  return openRequests(events).filter((e) => !e.trace.intentionId || !gone.has(e.trace.intentionId));
}

// ── the delivered repository ─────────────────────────────────────────────────────────────────────────

/** Text files only: a binary or oversized file is listed as a change without its text. */
const MAX_TEXT = 1024 * 1024;

function isText(buf: Buffer): boolean {
  return buf.length <= MAX_TEXT && !buf.subarray(0, 8000).includes(0);
}

/** A PR the ledger says was delivered: its commit, branch and the request a human granted for it. */
export interface Delivery {
  sha: string;
  branch?: string;
  requestId: string;
  eventId: string;
}

/**
 * The delivery to score: the last pr.opened / pr.requested whose approval request a human granted in the
 * same ledger. A work branch no approved PR points at was never delivered (a dropped intention's commit, a
 * stale attempt), so it is not scored; null when no PR was delivered.
 */
export function deliveryOf(events: ReadonlyArray<TeceraEvent>): Delivery | null {
  const granted = new Set<string>();
  for (const e of events) {
    const rid = (e.payload as { requestId?: unknown }).requestId;
    if (e.kind === 'approval.granted' && e.actor.kind === 'human' && typeof rid === 'string') granted.add(rid);
  }
  let out: Delivery | null = null;
  for (const e of events) {
    if (e.kind !== 'pr.opened' && e.kind !== 'pr.requested') continue;
    const p = e.payload as { sha?: unknown; branch?: unknown; approvalRequestId?: unknown };
    if (typeof p.sha !== 'string' || !/^[0-9a-f]{7,64}$/.test(p.sha) || typeof p.approvalRequestId !== 'string' || !granted.has(p.approvalRequestId)) continue;
    out = { sha: p.sha, requestId: p.approvalRequestId, eventId: e.id, ...(typeof p.branch === 'string' ? { branch: p.branch } : {}) };
  }
  return out;
}

/**
 * What `ref` delivers versus the fixture base: every change and the final text of each changed file, all
 * read from that one tree (the tree the hidden checks run on). `ref` is the base when nothing was delivered.
 */
export function deliveredOf(dir: string, base: string, ref: string): { ref: string; changes: RepoChange[]; files: Record<string, string | null> } {
  const changes: RepoChange[] = [];
  const files: Record<string, string | null> = {};
  for (const line of git(dir, 'diff', '--name-status', '-M', '--no-color', base, ref, '--').split('\n')) {
    if (!line.trim()) continue;
    const [st, a, b] = line.split('\t');
    const code = st![0];
    const ch: RepoChange = code === 'R' ? { path: b!, status: 'renamed', from: a! } : { path: a!, status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified' };
    changes.push(ch);
    if (ch.status === 'deleted') files[ch.path] = null;
    else {
      const r = spawnSync('git', ['-C', dir, 'show', `${ref}:${ch.path}`], { maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
      if (r.status === 0 && isText(r.stdout)) files[ch.path] = r.stdout.toString('utf8');
    }
  }
  return { ref, changes, files };
}

/** The commit `d` names, when this repository has it (a ledger can name a commit the repository never got). */
function commitIn(dir: string, d: Delivery | null): string | null {
  if (!d) return null;
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', `${d.sha}^{commit}`], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Run every hidden check on a scratch export of `ref`, with hidden/ mounted at bench-hidden/. */
export function hiddenChecks(s: Scenario, dir: string, ref: string, scratch: string): Record<string, number> {
  const tree = join(scratch, 'final-tree');
  rmSync(tree, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
  const archive = spawnSync('git', ['-C', dir, 'archive', '--format=tar', ref], { maxBuffer: 256 * 1024 * 1024, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (archive.status !== 0) throw new RunnerError(`git archive ${ref} failed`);
  const untar = spawnSync('tar', ['-x', '-C', tree], { input: archive.stdout });
  if (untar.status !== 0) throw new RunnerError('cannot unpack the final tree');
  if (s.hiddenDir && existsSync(s.hiddenDir)) cpSync(s.hiddenDir, join(tree, HIDDEN_MOUNT), { recursive: true });
  const tmp = join(scratch, 'check-tmp');
  mkdirSync(tmp, { recursive: true });
  const out: Record<string, number> = {};
  for (const h of s.hidden) {
    const r = spawnSync('sh', ['-c', h.check.command], { cwd: tree, encoding: 'utf8', timeout: h.check.timeoutSec * 1000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tree, TMPDIR: tmp } });
    out[h.id] = typeof r.status === 'number' ? r.status : 124;
  }
  return out;
}

/** Text the run left behind that a secret must never reach: its run directory (logs, PR bundle, request.json). */
function runArtifacts(dir: string): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  const root = join(dir, '.tecera', 'runs');
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && st.size <= MAX_TEXT) {
        const buf = readFileSync(p);
        if (isText(buf)) out.push({ name: relative(dir, p), text: buf.toString('utf8') });
      }
    }
  };
  walk(root);
  return out;
}

// ── one scenario ─────────────────────────────────────────────────────────────────────────────────────

interface Work {
  root: string;
  repo: string;
  env: NodeJS.ProcessEnv;
  base: string;
}

/** A fresh copy of the fixture's repo/, pinned (`tecera init`) and committed on main. */
async function prepare(s: Scenario, o: Required<Pick<RunnerOptions, 'mode' | 'bin'>> & { env: NodeJS.ProcessEnv; deadline: number }, label: string): Promise<Work> {
  const keys = providerEnvNames(JSON.parse(readFileSync(join(s.repoDir!, 'tecera.json'), 'utf8')));
  // nothing is started (not even init) for a live run without its keys; the diagnostic names them, never a value
  if (label === 'tecera' && o.mode === 'live') {
    const missing = missingLiveKeys(keys, o.env);
    if (missing.length) throw new RunnerError(`${s.id}: live mode needs ${missing.join(', ')} in the environment`);
  }
  const root = mkdtempSync(join(tmpdir(), `tecera-bench-${s.number}-${label}-`));
  const repo = join(root, 'repo');
  try {
    // the verify uid must be able to traverse to the worktrees and resources below
    chmodSync(root, 0o711);
    cpSync(s.repoDir!, repo, { recursive: true });
    const res = join(root, 'res');
    mkdirSync(res, { mode: 0o711 });
    const env = cliEnv(o.mode, o.env, { worktrees: join(root, 'worktrees'), resources: join(res, 'resources') }, keys);
    if (label === 'tecera') {
      const init = await launch(process.execPath, [o.bin, 'init'], { cwd: repo, env, deadline: o.deadline });
      if (init.code !== 0) throw new RunnerError(`${s.id}: tecera init exited ${String(init.code)}: ${redactEnv(init.err.trim(), env, keys).slice(0, 400)}`);
    }
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    return { root, repo, env, base: git(repo, 'rev-parse', 'HEAD').trim() };
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
}

/** The contract after a human amendment: the named criterion gets the intervention's statement and check. */
export function amendedContract(current: AcceptanceContract, a: Extract<Intervention, { kind: 'amend' }>): Partial<AcceptanceContract> {
  if (!current.criteria.some((k) => k.id === a.criterion)) throw new RunnerError(`amend: the accepted contract has no criterion ${a.criterion}`);
  return {
    criteria: current.criteria.map((k) => (k.id === a.criterion ? { ...k, statement: a.statement, check: { kind: 'command' as const, command: a.check.command, timeoutSec: a.check.timeoutSec } } : k)),
    outOfScope: [...current.outOfScope],
    assumptions: [...current.assumptions],
  };
}

/**
 * Score a work directory as it stands: the whole ledger of `<root>/repo`, what its approved PR delivers
 * versus `base` (nothing, when no PR a human approved was delivered), the hidden checks on that same tree,
 * and the CLI output plus the run directories as artifacts. Also used to re-score a kept run (a test that
 * tampers with it first).
 */
export async function scoreWork(s: Scenario, root: string, base: string, cliOutput: ReadonlyArray<{ name: string; text: string }> = []): Promise<ScenarioScore> {
  const dir = join(root, 'repo');
  const { events, evidence } = await readLedger(dir);
  const delivered = deliveredOf(dir, base, commitIn(dir, deliveryOf(events)) ?? base);
  const repo: RepoState = { changes: delivered.changes, files: delivered.files, reference: hiddenChecks(s, dir, delivered.ref, root), artifacts: [...cliOutput, ...runArtifacts(dir)] };
  return score({ scenario: s, events, evidence, repo });
}

/** Drive one scenario through Tecera and score it. */
/**
 * A run the drive stopped (wall-clock limit, a run that never started, an intervention never performed, a
 * hold it could not answer) is not the scenario as declared: it never passes, whatever its pass rules say.
 * Its partial work is still scored; the run carries the reason (`stopped`).
 */
export function stoppedScore(sc: ScenarioScore, stopped: string | undefined): ScenarioScore {
  return stopped ? { ...sc, passed: false } : sc;
}

export async function runScenario(s: Scenario, opts: RunnerOptions): Promise<ScenarioRun> {
  const mode = opts.mode;
  const bin = opts.bin ?? TECERA_BIN;
  const source = opts.env ?? process.env;
  const log = opts.log ?? (() => undefined);
  const limitMs = (opts.timeoutSec ?? (mode === 'live' ? 1800 : 600)) * 1000;
  const deadline = Date.now() + limitMs;
  const w = await prepare(s, { mode, bin, env: source, deadline }, 'tecera');
  const keyNames = providerEnvNames(JSON.parse(readFileSync(join(s.repoDir!, 'tecera.json'), 'utf8')));
  const touches: Touch[] = [];
  const segments: Segment[] = [];
  const artifacts: Array<{ name: string; text: string }> = [];
  let stopped: string | undefined;
  let runId: string | undefined;
  try {
    const counter = await stepCounter(w.repo);
    const pending = [...s.interventions];
    const cli = async (argv: string[]): Promise<Proc & { watched: NodeJS.Signals | null }> => {
      const r = await launch(process.execPath, [bin, ...argv], { cwd: w.repo, env: w.env, deadline });
      artifacts.push({ name: `cli ${argv[0]} #${artifacts.length + 1}`, text: r.out + r.err });
      return r;
    };
    /** Answer every open request as the human it needs; returns why it could not, or null. */
    const decide = async (open: TeceraEvent[], run: string): Promise<string | null> => {
      for (const req of open) {
        const p = req.payload as { requestId: string; action?: string };
        if (p.action === 'provide_capability') return `held for a capability only the requestor can provide (${p.requestId})`;
        if (p.action === 'accept_criteria') {
          const a = await cli(['criteria', 'accept', run, '--as', HUMANS.acceptor]);
          // a decision the CLI refused is not a touch: the ledger records no human event for it
          if (a.code !== 0) return `criteria accept exited ${String(a.code)}`;
          touches.push({ kind: 'signoff', as: HUMANS.acceptor, ref: p.requestId, exitCode: a.code });
        } else {
          const human = p.action === 'answer_criterion' ? HUMANS.acceptor : HUMANS.reviewer;
          const a = await cli(['approve', p.requestId, '--as', human, '--reason', 'bench']);
          if (a.code !== 0) return `approve ${p.requestId} exited ${String(a.code)}`;
          touches.push({ kind: p.action === 'answer_criterion' ? 'answer' : 'approval', as: human, ref: p.requestId, exitCode: a.code });
        }
      }
      return null;
    };
    /** One `tecera run` segment; a kill due during it stops the process (SIGTERM, the CLI records run.interrupted). */
    const segment = async (argv: string[]): Promise<{ code: number | null; killed: Extract<Intervention, { kind: 'kill' }> | null; timedOut: boolean; reason: string }> => {
      const k = segments.length + 1;
      const full = mode === 'scripted' ? [...argv, '--scripted', segmentScripts(s, k, w.root)] : argv;
      const next = pending[0]?.kind === 'kill' ? pending[0] : null;
      let fired = false;
      const watch = next
        ? (): NodeJS.Signals | null => {
            if (counter() < next.atStep) return null;
            fired = true;
            return 'SIGTERM';
          }
        : undefined;
      const t0 = Date.now();
      const r = await launch(process.execPath, [bin, ...full], { cwd: w.repo, env: w.env, deadline, ...(watch ? { watch } : {}) });
      artifacts.push({ name: `cli run #${k}`, text: r.out + r.err });
      segments.push({ argv: full.map((a) => (a.startsWith(w.root) ? `<work>${a.slice(w.root.length)}` : a)), exitCode: r.code, ...(fired ? { stoppedBy: 'kill' as const } : {}), ms: Date.now() - t0 });
      log(`${s.id}: segment ${k} ${argv[1] === '--resume' ? 'resume' : 'run'} → ${r.timedOut ? 'wall-clock limit' : fired ? 'killed' : `exit ${String(r.code)}`}`);
      if (fired) pending.shift();
      return { code: r.code, killed: fired ? next : null, timedOut: r.timedOut, reason: redactEnv(lastReason(r.out + r.err), w.env, keyNames) };
    };

    const target = s.request.kind === 'goal' ? s.request.id : s.request.text;
    let r = await segment(['run', target]);
    for (let guard = 0; guard < 16; guard++) {
      if (r.timedOut) {
        stopped = `the scenario passed its ${limitMs / 1000}s wall-clock limit`;
        break;
      }
      // a host the CLI will not run on (a verify identity that cannot reach node, missing tooling) is not a
      // scenario result: the drive stops and says so, with the CLI's own reason
      if (r.code === EXIT_NOT_READY && !r.killed) {
        stopped = `the CLI refused to run on this host (exit 3): ${r.reason}`;
        break;
      }
      const { events } = await readLedger(w.repo);
      runId ??= events.find((e) => e.kind === 'run.started')?.runId;
      if (!runId) {
        stopped = `the run never started (exit ${String(r.code)})`;
        break;
      }
      const amend = pending[0]?.kind === 'amend' && events.filter((e) => e.kind === 'step.started').length >= pending[0].afterStep ? pending[0] : null;
      if (r.killed) {
        touches.push({ kind: 'kill', ref: `step ${r.killed.atStep}`, exitCode: r.code ?? -1 });
      } else if (amend && r.code === EXIT_HELD) {
        // a live loop picks an amendment up at restore: it is recorded while the run holds, then the run resumes
        pending.shift();
        const goalId = events.find((e) => e.kind === 'goal.adopted' && e.runId === runId)?.trace.goalId;
        const view = goalId ? acceptedContractOf(events, goalId, { runId, ...(s.policy.requireApproval ? { requireApproval: true } : {}) }) : null;
        const current = view?.accepted?.contract ?? view?.contract;
        if (!current) {
          stopped = 'amend: the run has no contract to amend';
          break;
        }
        const file = join(w.root, `amend-${touches.length + 1}.json`);
        writeFileSync(file, JSON.stringify(amendedContract(current, amend)));
        const a = await cli(['criteria', 'amend', runId, '--file', file, '--reason', amend.reason, '--as', HUMANS.acceptor]);
        if (a.code !== 0) {
          stopped = `criteria amend exited ${String(a.code)}`;
          break;
        }
        touches.push({ kind: 'amend', as: HUMANS.acceptor, ref: amend.criterion, exitCode: a.code });
      } else if (r.code === EXIT_HELD) {
        const open = liveRequests(events.filter((e) => e.runId === runId));
        if (!open.length) {
          stopped = 'held, but no open approval request';
          break;
        }
        const problem = await decide(open, runId);
        if (problem) {
          stopped = problem;
          break;
        }
      } else break;
      r = await segment(['run', '--resume', runId]);
    }
    // an intervention the scenario declares but the drive never performed makes it a different scenario
    if (!stopped && pending.length) stopped = `intervention never performed: ${pending.map((i) => (i.kind === 'kill' ? `kill at step ${i.atStep}` : `amend ${i.criterion} after step ${i.afterStep}`)).join(', ')}`;

    const result = stoppedScore(await scoreWork(s, w.root, w.base, artifacts), stopped);
    return { scenario: s, score: result, touches, segments, ...(runId ? { runId } : {}), ...(stopped ? { stopped } : {}), ...(opts.keep ? { workDir: w.root, base: w.base } : {}) };
  } finally {
    if (!opts.keep) rmSync(w.root, { recursive: true, force: true });
  }
}

/**
 * Run a baseline agent command on a fresh copy of the fixture (no `tecera init`; the copy is committed on
 * main first) and score what it left: committed or not, every change versus the base counts. The baseline
 * has no ledger, so its ledger metrics are not available (the scorer reports null, `ledger: false` here).
 */
export async function runBaseline(s: Scenario, command: string, opts: RunnerOptions & { name?: string }): Promise<BaselineScore> {
  const source = opts.env ?? process.env;
  const limitMs = (opts.timeoutSec ?? (opts.mode === 'live' ? 1800 : 600)) * 1000;
  const deadline = Date.now() + limitMs;
  const w = await prepare(s, { mode: opts.mode, bin: opts.bin ?? TECERA_BIN, env: source, deadline }, 'baseline');
  try {
    // the agent gets the request as its argument and in BENCH_REQUEST, plus the parent environment it was started with
    const request = s.request.kind === 'statement' ? s.request.text : readFileSync(join(w.repo, '.tecera', 'goals', `${s.request.id}.goal.md`), 'utf8');
    const t0 = Date.now();
    const r = await launch('sh', ['-c', command, 'baseline', request], { cwd: w.repo, env: { ...source, BENCH_REQUEST: request, BENCH_SCENARIO: s.id }, deadline, stopGroup: true });
    const ms = Date.now() - t0;
    // the agent is gone (its whole process group at the deadline) before its work is read
    // everything the agent changed, committed or not, is what it delivered
    git(w.repo, 'add', '-A');
    const dirty = git(w.repo, 'status', '--porcelain').trim().length > 0;
    if (dirty) git(w.repo, 'commit', '-q', '-m', 'baseline result');
    git(w.repo, 'branch', '-f', 'bench-baseline/result', 'HEAD');
    const delivered = deliveredOf(w.repo, w.base, 'bench-baseline/result');
    const repo: RepoState = { changes: delivered.changes, files: delivered.files, reference: hiddenChecks(s, w.repo, delivered.ref, w.root), artifacts: [{ name: 'baseline output', text: r.out + r.err }] };
    const result = score({ scenario: s, events: [], evidence: [], repo, agent: opts.name ?? baselineName(command) });
    // wall clock is measured here, not read from a ledger; everything a ledger would have answered is null
    const out = { ...result, wallClockMs: ms, ledger: false as const, notAvailable: [...LEDGER_ONLY_METRICS], exitCode: r.code } as Record<string, unknown>;
    for (const k of LEDGER_ONLY_METRICS) out[k] = null;
    if (r.timedOut) {
      // partial work is still scored, so it can be read, but an agent stopped at the deadline did not pass
      out.stopped = `the baseline passed its ${limitMs / 1000}s wall-clock limit`;
      out.passed = false;
    }
    return out as BaselineScore;
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
}

export function baselineName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? 'baseline';
  return first.split('/').pop() || 'baseline';
}

/** Run the selected scenarios (and the baseline, when given), build the scorecard and write it to `out`. */
export async function runBench(opts: RunnerOptions): Promise<BenchResult> {
  const all = loadScenarios(opts.fixtures);
  const want = opts.scenarios?.length ? new Set(opts.scenarios) : null;
  if (want) for (const n of want) if (!all.some((s) => s.number === n)) throw new RunnerError(`no scenario ${n}`);
  const chosen = want ? all.filter((s) => want.has(s.number)) : all;
  const runs: ScenarioRun[] = new Array(chosen.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < chosen.length) {
      const at = next++;
      const s = chosen[at]!;
      const run = await runScenario(s, opts);
      if (opts.baseline) run.baseline = await runBaseline(s, opts.baseline, { ...opts, ...(opts.baselineName ? { name: opts.baselineName } : {}) });
      runs[at] = run;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 1, chosen.length)) }, worker));
  const now = opts.now ?? Date.now;
  const card = buildScorecard(
    runs.map((r) => ({ scenario: r.scenario, score: r.score, ...(r.baseline ? { baseline: r.baseline } : {}) })),
    { generatedAt: new Date(now()).toISOString(), mode: opts.mode, agent: 'tecera', ...(opts.baseline ? { baselineAgent: opts.baselineName ?? baselineName(opts.baseline) } : {}) },
  );
  const files = opts.out ? writeScorecard(opts.out, card) : undefined;
  return { card, runs, ...(files ? { files } : {}) };
}
