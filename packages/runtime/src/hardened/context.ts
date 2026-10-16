import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { HeadStore } from '@tecera/ledger';
import type { VerifyOutcome, VerifyRequest, VerifyRunner } from '@tecera/contracts';
import { verifyIdentity, VerifyContainmentError } from '../containment.js';
import type { Env } from '../util/proc.js';
import { processCredentials } from './authority.js';
import { HardenedError, loadHardenedConfig, trustProblems, type HardenedConfig } from './config.js';
import { RunRegistry } from './registry.js';

/**
 * The hardened state of one business case: `<stateDir>/cases/<caseId>/` holds the ledger
 * (ledger.sqlite, rollback journal), its head checkpoint (head.json, head.pending.<n>.json), the run
 * registry (runs/<runId>.json) and case.json (the business case root it belongs to). The case id is derived
 * from the real path of the business case root. The manifest's `ledger.path` is not used.
 *
 * Opening it checks, before anything is read (stateProblems): the state directory and every directory above
 * it are owned by root or the operator and writable by nobody else; everything inside it is owned by root or
 * the operator, not a link, not writable by group or others, and a file has one link. Any problem refuses
 * the command (HardenedError, exit 3), whoever runs it. ACLs and mandatory access control are not inspected.
 *
 * The process writes the state only when it runs as the operator (`writer`); any other identity opens the
 * ledger read-only.
 */

export interface HardenedContext {
  config: HardenedConfig;
  caseId: string;
  caseDir: string;
  ledgerPath: string;
  head: HeadStore;
  registry: RunRegistry;
  /** This process runs as the operator identity and may write the state. */
  writer: boolean;
  dirMode: number;
  fileMode: number;
}

export const CASES_DIR = 'cases';
export const LEDGER_FILE = 'ledger.sqlite';

/** The case id of a business case root (its real path, hashed). */
export function caseIdOf(root: string): string {
  let real = resolve(root);
  try {
    real = realpathSync(root);
  } catch {
    /* a root that cannot be resolved is hashed as given */
  }
  return createHash('sha256').update(real).digest('hex').slice(0, 24);
}

const inside = (outer: string, p: string): boolean => {
  const r = relative(outer, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

/** Every problem with the state directory and its contents (empty when the agent identity cannot write any of it). */
export function stateProblems(cfg: HardenedConfig): string[] {
  const trusted = new Set([0, cfg.operator.uid]);
  const problems = trustProblems(cfg.stateDir, trusted, 'state');
  if (problems.length) return problems;
  let st;
  try {
    st = lstatSync(cfg.stateDir);
  } catch (e) {
    return [`state: ${cfg.stateDir} cannot be checked (${(e as Error).message})`];
  }
  if (!st.isDirectory()) return [`state: ${cfg.stateDir} is not a directory`];
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (e) {
      problems.push(`state: ${dir} cannot be listed (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      let s;
      try {
        s = lstatSync(p);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // removed while listing (a temp file renamed)
        problems.push(`state: ${p} cannot be checked (${(e as Error).message})`);
        continue;
      }
      if (s.isSymbolicLink()) problems.push(`state: ${p} is a symbolic link`);
      else if (!trusted.has(s.uid)) problems.push(`state: ${p} is owned by uid ${s.uid}, not by root or the operator`);
      else if ((s.mode & 0o022) !== 0) problems.push(`state: ${p} is writable by group or others (mode ${(s.mode & 0o7777).toString(8)})`);
      else if (s.isFile() && s.nlink !== 1) problems.push(`state: ${p} has ${s.nlink} hard links`);
      else if (s.isDirectory()) {
        if (depth < 4) walk(p, depth + 1);
        else problems.push(`state: ${p} is nested deeper than expected`);
      } else if (!s.isFile()) problems.push(`state: ${p} is not a regular file or directory`);
    }
  };
  walk(cfg.stateDir, 0);
  return problems;
}

/** The worktrees directory runs use ($TECERA_WORKTREES, default ~/.tecera/worktrees). */
function worktreesDir(env: Env): string {
  const w = env.TECERA_WORKTREES;
  return w && isAbsolute(w) ? w : join(env.HOME || homedir(), '.tecera', 'worktrees');
}

/** Why the state is not separate from the repository and the worktrees (null when it is). */
export function placementProblem(cfg: HardenedConfig, root: string, env: Env): string | null {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const state = real(cfg.stateDir);
  const caseRoot = real(root);
  if (inside(caseRoot, state) || inside(state, caseRoot)) return `the state directory ${cfg.stateDir} and the business case ${root} overlap; the state must live outside the repository`;
  const wt = real(worktreesDir(env));
  if (inside(wt, state) || inside(state, wt)) return `the state directory ${cfg.stateDir} and the worktrees directory ${wt} overlap`;
  return null;
}

/**
 * The hardened context of the business case at `root`, or null in single-user mode. Throws HardenedError when
 * the configuration or the state cannot be trusted (fail closed: hardened mode was asked for).
 */
export function resolveHardened(env: Env, root: string, now: () => number = Date.now): HardenedContext | null {
  const config = loadHardenedConfig(env);
  if (!config) return null;
  stateOrThrow(config);
  const placed = placementProblem(config, root, env);
  if (placed) throw new HardenedError(`refusing to start: ${placed}`);
  const uid = processCredentials.euid();
  const writer = uid === config.operator.uid && processCredentials.uid() === config.operator.uid;
  const mode = lstatSync(config.stateDir).mode;
  const dirMode = mode & 0o755;
  const fileMode = mode & 0o644;
  const caseId = caseIdOf(root);
  const caseDir = join(config.stateDir, CASES_DIR, caseId);
  return {
    config,
    caseId,
    caseDir,
    ledgerPath: join(caseDir, LEDGER_FILE),
    head: new HeadStore(caseDir, { now, fileMode }),
    registry: new RunRegistry(join(caseDir, 'runs'), { caseId, now, fileMode, dirMode, uid }),
    writer,
    dirMode,
    fileMode,
  };
}

/** Create the case directory (operator only) and record which business case it belongs to. */
export function ensureCaseDir(h: HardenedContext, root: string): void {
  if (!h.writer) throw new HardenedError(`the state of this business case does not exist yet and this process (uid ${processCredentials.uid()}) is not the operator`);
  mkdirSync(join(h.config.stateDir, CASES_DIR), { recursive: true, mode: h.dirMode });
  mkdirSync(h.caseDir, { recursive: true, mode: h.dirMode });
  mkdirSync(join(h.caseDir, 'runs'), { recursive: true, mode: h.dirMode });
  const meta = join(h.caseDir, 'case.json');
  if (existsSync(meta)) return;
  const tmp = `${meta}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'wx', h.fileMode);
  try {
    writeSync(fd, `${JSON.stringify({ caseId: h.caseId, root: resolve(root), createdAt: Date.now() }, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, meta);
}

/** Every business case under the state directory, with its registry (read-only use: the Stop hook and status). */
export function allCases(config: HardenedConfig, now: () => number = Date.now): Array<{ caseId: string; root: string | null; registry: RunRegistry }> {
  const dir = join(config.stateDir, CASES_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new HardenedError(`${dir} cannot be listed (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
  }
  return names
    .filter((n) => /^[0-9a-f]{24}$/.test(n))
    .sort()
    .map((caseId) => {
      let root: string | null = null;
      try {
        root = (JSON.parse(readFileSync(join(dir, caseId, 'case.json'), 'utf8')) as { root?: unknown }).root as string;
        if (typeof root !== 'string') root = null;
      } catch {
        root = null;
      }
      return { caseId, root, registry: new RunRegistry(join(dir, caseId, 'runs'), { caseId, now }) };
    });
}

/**
 * The open runs of every business case on this host other than `exceptCaseId`. The Stop hook blocks on them
 * too: an agent that removes tecera.json or works from another directory must not stop over a run it left
 * open elsewhere. Throws HardenedError when a registry cannot be read (fail closed).
 */
export function openRunsElsewhere(config: HardenedConfig, exceptCaseId: string | null, now: () => number = Date.now): Array<{ caseId: string; root: string | null; runId: string; state: string }> {
  stateOrThrow(config);
  const out: Array<{ caseId: string; root: string | null; runId: string; state: string }> = [];
  for (const c of allCases(config, now)) {
    if (c.caseId === exceptCaseId) continue;
    for (const e of c.registry.open()) out.push({ caseId: c.caseId, root: c.root, runId: e.runId, state: e.state });
  }
  return out;
}

/** stateProblems as a refusal. */
export function stateOrThrow(config: HardenedConfig): void {
  const problems = stateProblems(config);
  if (problems.length) throw new HardenedError(`refusing to start: the agent identity may be able to change the state (${problems.slice(0, 4).join('; ')}${problems.length > 4 ? `; ${problems.length - 4} more` : ''})`);
}

/**
 * Why a check would run as an identity that can change the state (null when it would not). A check runs
 * repository code, and the agent writes the repository: run as the operator (or as root) it could rewrite
 * the ledger, the registry and the checkpoint. The identity is TECERA_VERIFY_UID/GID when set (switching to
 * it needs a root supervisor), root under TECERA_VERIFY_ALLOW_ROOT=1, else this process.
 */
export function checkIdentityProblem(cfg: HardenedConfig, env: Env): string | null {
  let as: number;
  try {
    const ident = verifyIdentity(env);
    as = ident.runAs ? ident.runAs.uid : ident.allowRoot ? 0 : processCredentials.euid();
    if (ident.runAs && ident.runAs.gid === 0) return 'hardened mode: TECERA_VERIFY_GID is root\'s group';
  } catch (e) {
    return (e as Error).message;
  }
  if (as !== 0 && as !== cfg.operator.uid) return null;
  return `hardened mode: a check runs repository code, which the agent can write, so it must not run as ${as === 0 ? 'root' : `the operator (uid ${as})`}; set TECERA_VERIFY_UID/TECERA_VERIFY_GID to another unprivileged identity that can read the worktree (switching to it needs a root supervisor)`;
}

/** The runtime's verify runner under hardened mode: refuses (nothing spawns) when checkIdentityProblem says so. */
export class HardenedVerifyRunner implements VerifyRunner {
  constructor(
    private readonly inner: VerifyRunner,
    private readonly cfg: HardenedConfig,
    private readonly env: Env,
  ) {}

  async run(req: VerifyRequest, signal?: AbortSignal): Promise<VerifyOutcome> {
    const why = checkIdentityProblem(this.cfg, this.env);
    if (why) throw new VerifyContainmentError(why);
    return this.inner.run(req, signal);
  }
}
