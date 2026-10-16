import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Lease, Ledger } from '@tecera/contracts';
import { assertSafeRepo, hostGit, ignoredPathKey, UnsafeRepo } from '@tecera/gates';
import type { Env } from './util/proc.js';

/**
 * The run's worktree and its lease (security.md §4: a worker writes only into a leased worktree, never into
 * the developer's checkout).
 *
 * - Location: `<worktreesRoot>/<runId>`, where worktreesRoot is `$TECERA_WORKTREES` or `~/.tecera/worktrees`.
 *   It must lie outside the business case (a worktree inside it would be scanned, copied and committed). The
 *   verify identity (an unprivileged uid) runs the check inside the worktree, so the root is created 0711
 *   (others traverse, never list) and the default moves to `<tmpdir>/tecera-<uid>/worktrees` when the home
 *   directory does not let others traverse it (root's 0700 home); that directory must be owned by this uid
 *   and writable by nobody else.
 * - Git repository whose top level is the business-case root: `git worktree add --detach <dir> <base>` under
 *   the gates' host-controlled git (no hooks, no filters, no user config) after `assertSafeRepo`. HEAD is the
 *   base commit, which the commit gate requires; the commit lands on `<branchPrefix><goal>` in the same repo.
 * - Not a git repository: a plain copy (ledger files and runs excluded) turned into a fresh one-commit
 *   repository on `<base>`, recorded as `worktree.no-git` evidence: the commit lands in the copy, not in the
 *   developer's directory.
 * - Lease: `ledger.lease('worktree:<runId>', holder)` with a TTL that is renewed (every sixth of it) while the run lives; the
 *   fencing token goes to every worker step. A lease held by a live holder refuses the run (two processes
 *   never drive one worktree). Losing the lease REVOKES authority in this process: the token is dropped,
 *   `lost` (an AbortSignal) fires so the loop stops and every running step/gate is aborted, and
 *   `assertHeld()` (called by the fenced tools and gate wrappers right before each mutation) re-proves the
 *   lease against the ledger itself (renew with the same holder and token), not against a copied number.
 * - Resume reuses the run's worktree and must find it intact (same path, a worktree of this repository).
 * - A later intention of the goal gets its own branch (`prepareBranch`): the branch is created at the pinned
 *   base commit, HEAD is pointed at it and the working tree and index are made equal to the base tree. What
 *   the previous intention left (its commit on its own branch, uncommitted and ignored files) is not carried
 *   over; its branch is not touched. Every step re-checks the lease.
 *
 * Every failure is a WiringError: the run does not start.
 */

export class WiringError extends Error {
  constructor(message: string, public readonly exitCode: number = 3) {
    super(message);
    this.name = 'WiringError';
  }
}

export const WORKTREES_ENV = 'TECERA_WORKTREES';

export function worktreesRoot(env: Env, o: { home?: string; tmp?: string } = {}): string {
  const v = env[WORKTREES_ENV];
  if (v !== undefined && v !== '') {
    if (!isAbsolute(v)) throw new WiringError(`${WORKTREES_ENV} must be an absolute path`);
    return resolve(v);
  }
  const home = o.home ?? homedir();
  if (othersTraverse(home)) return join(home, '.tecera', 'worktrees');
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : 'user';
  return join(o.tmp ?? tmpdir(), `tecera-${uid}`, 'worktrees');
}

/** Every existing directory from `/` down to `p` lets others traverse it (o+x): the verify uid can reach below. */
export function othersTraverse(p: string): boolean {
  let cur = resolve(p);
  for (;;) {
    try {
      const st = lstatSync(cur);
      if (st.isDirectory() && (st.mode & 0o001) === 0) return false;
    } catch {
      /* not created yet: it will be created traversable */
    }
    const up = dirname(cur);
    if (up === cur) return true;
    cur = up;
  }
}

/**
 * Create the worktrees root traversable by the verify identity (0711). Under a shared temp directory the
 * per-uid parent must be a real directory owned by this uid and writable by nobody else, or the run is refused.
 */
function ensureWorktreesRoot(wtRoot: string): void {
  mkdirSync(wtRoot, { recursive: true, mode: 0o711 });
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : null;
  for (const d of [wtRoot, dirname(wtRoot)].filter((x) => /[\\/]tecera-[^\\/]+$/.test(x) || x === wtRoot)) {
    const st = lstatSync(d);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new WiringError(`worktrees root ${d} is not a directory`);
    if (uid !== null && st.uid !== uid) throw new WiringError(`worktrees root ${d} is owned by uid ${st.uid}, not by this process (uid ${uid})`);
    if (st.mode & 0o022) throw new WiringError(`worktrees root ${d} is writable by group or others`);
  }
}

export interface LeasedWorktree {
  /** Absolute path of the worktree every gate and worker step uses. */
  path: string;
  /** Whether the business case is a git repository (false: the worktree is a private copy). */
  git: boolean;
  base: string;
  baseSha: string;
  /** Current fencing token; undefined once the lease is lost or released (writes are then refused). */
  fencingToken(): number | undefined;
  /** Aborted (with the reason) when renewal fails, the token changes, or the lease is released. */
  readonly lost: AbortSignal;
  /**
   * Prove the lease is still held right now: renew it on the ledger (same holder, same fencing token) and
   * compare the token with the one this process was granted. Any failure revokes the lease (`lost` fires)
   * and throws LeaseLost. `token`, when given, must equal the current token (a stale copy is refused).
   */
  assertHeld(token?: number): Promise<number>;
  /**
   * Synchronous mutation-time fence: null while this process may still write, else why not. Besides `lost`,
   * the lease is treated as gone once its LOCAL validity lapsed (last successful renewal request + ttl minus a
   * safety margin): the ledger cannot hand the worktree to another holder before the ttl after that renewal,
   * so a write that passes this check cannot race a takeover. A lapse revokes (`lost` fires).
   */
  heldReason(): string | null;
  /** Snapshot the worktree (tracked + untracked, not ignored) as a git tree: `tree:<oid>`. */
  checkpoint(signal?: AbortSignal): Promise<string>;
  /**
   * Restore the worktree to a checkpoint (`tree:<oid>` from checkpoint(), or 'base' = the base commit's tree):
   * the working tree is made equal to it (files outside it removed, ignored files kept), the index reset to
   * HEAD, and the result re-snapshotted and compared (a mismatch throws: nothing is confirmed).
   */
  restore(checkpointId: string, signal?: AbortSignal): Promise<string>;
  /**
   * Put the worktree on `branch` at the base commit (see prepareWorktreeBranch). The lease is re-checked right
   * before every mutation; LeaseLost leaves whatever was not yet moved exactly as it was. Idempotent.
   */
  prepareBranch(a: PrepareBranchOptions): Promise<PreparedBranch>;
  release(): Promise<void>;
}

export interface PrepareBranchOptions {
  branch: string;
  /** Ignored files to keep, by ignoredPathKey (the run's ignored baseline). Every other ignored file is removed. */
  keepIgnored?: (pathKey: string) => boolean;
  signal?: AbortSignal;
  /** Fault injection for crash and fence tests only: runs after the entry checks, before the first mutation. */
  beforeMutation?: () => void | Promise<void>;
}

export interface PreparedBranch {
  branch: string;
  baseSha: string;
  /** False when the branch already existed at the base (an earlier, interrupted preparation created it). */
  created: boolean;
  /** Ignored files removed because the run's baseline does not hold them. */
  removedIgnored: number;
}

export class LeaseLost extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseLost';
  }
}

export interface LeaseOptions {
  root: string;
  runId: string;
  base: string;
  ledger: Ledger;
  worktreesRoot: string;
  resume: boolean;
  /** Lease TTL; renewed every ttl/6 while the run lives. */
  ttlMs: number;
  holder: string;
  signal?: AbortSignal;
}

const inside = (parent: string, child: string): boolean => {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

async function gitTopLevel(dir: string, signal?: AbortSignal): Promise<string | null> {
  try {
    return (await hostGit(dir, ['rev-parse', '--show-toplevel'], { signal })).trim() || null;
  } catch {
    return null;
  }
}

async function commonDir(dir: string, signal?: AbortSignal): Promise<string> {
  const out = (await hostGit(dir, ['rev-parse', '--git-common-dir'], { signal })).trim();
  return real(isAbsolute(out) ? out : resolve(dir, out));
}

export async function leaseWorktree(o: LeaseOptions): Promise<LeasedWorktree> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(o.runId)) throw new WiringError(`not a run id: ${o.runId}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(o.base) || o.base.includes('..')) throw new WiringError(`repo.base ${JSON.stringify(o.base)} is not a usable ref`);
  const rootAbs = real(o.root);
  const wtRoot = resolve(o.worktreesRoot);
  if (inside(rootAbs, real(wtRoot)) || inside(rootAbs, wtRoot)) throw new WiringError(`the worktrees directory ${wtRoot} is inside the business case; set ${WORKTREES_ENV} to a directory outside it`);
  const path = join(wtRoot, o.runId);

  // Lease first: nothing is created or reused unless this process holds the worktree.
  let lease: Lease | null;
  const leaseRequestedAt = Date.now();
  try {
    lease = await o.ledger.lease(`worktree:${o.runId}`, o.holder, o.ttlMs);
  } catch (e) {
    throw new WiringError(`ledger refused the worktree lease: ${(e as Error).message}`, 9);
  }
  if (!lease) throw new WiringError(`worktree of run ${o.runId} is leased by another live process; refusing to drive it twice`);
  let current: Lease | null = lease;
  const granted = lease.fencingToken;
  let timer: NodeJS.Timeout | null = null;
  let watchdog: NodeJS.Timeout | null = null;
  const lostCtl = new AbortController();
  // Local validity: a renewal REQUESTED at t keeps the lease ours on the ledger until at least t + ttl; we stop
  // writing a margin earlier (clock steps, scheduling), so no write of ours can land after a takeover.
  // The margin is an eighth of the ttl (at most 30 s) and renewals go out every sixth of it, so a renewal that
  // is late (a stalled event loop, a slow disk) but still lands inside the validity keeps the lease: only
  // several missed renewals in a row lose it.
  const margin = Math.min(Math.max(Math.floor(o.ttlMs / 8), 1), 30_000);
  let validUntil = leaseRequestedAt + o.ttlMs - margin;
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
  };
  /** Revoke: no token, timer stopped, `lost` fired. Idempotent. */
  const revoke = (why: string): void => {
    current = null;
    stop();
    if (!lostCtl.signal.aborted) lostCtl.abort(new LeaseLost(`worktree lease of run ${o.runId} lost: ${why}`));
  };
  const release = async (): Promise<void> => {
    const l = current;
    revoke('released');
    if (l) await o.ledger.release(l).catch(() => undefined);
  };
  let renewing: Promise<number> | null = null;
  const renewOnce = async (): Promise<number> => {
    const l = current;
    if (!l || lostCtl.signal.aborted) throw new LeaseLost(lostCtl.signal.aborted ? String((lostCtl.signal.reason as Error)?.message ?? 'lease lost') : `worktree lease of run ${o.runId} is not held`);
    let n: Lease;
    const sentAt = Date.now();
    try {
      // A renewal that hangs past the local validity is abandoned when the lease is revoked (never awaited forever).
      n = await new Promise<Lease>((res, rej) => {
        const onLost = (): void => rej(new Error(String((lostCtl.signal.reason as Error)?.message ?? 'lease revoked while renewing')));
        if (lostCtl.signal.aborted) return onLost();
        lostCtl.signal.addEventListener('abort', onLost, { once: true });
        o.ledger.renew(l, o.ttlMs).then(
          (v) => {
            lostCtl.signal.removeEventListener('abort', onLost);
            res(v);
          },
          (e: unknown) => {
            lostCtl.signal.removeEventListener('abort', onLost);
            rej(e);
          },
        );
      });
    } catch (e) {
      revoke(`renewal refused (${(e as Error)?.message ?? String(e)})`);
      throw new LeaseLost(`worktree lease of run ${o.runId} lost: renewal refused`);
    }
    if (!n || n.fencingToken !== granted || n.holder !== l.holder) {
      revoke(`fencing token changed ${granted} → ${n?.fencingToken ?? 'none'}`);
      throw new LeaseLost(`worktree lease of run ${o.runId} lost: fencing token changed`);
    }
    if (current === l) current = n;
    // A revocation that happened while the renewal was in flight (validity lapsed, released) stands.
    if (lostCtl.signal.aborted) throw new LeaseLost(String((lostCtl.signal.reason as Error)?.message ?? `worktree lease of run ${o.runId} lost`));
    validUntil = Math.max(validUntil, sentAt + o.ttlMs - margin);
    arm();
    return n.fencingToken;
  };
  /** Sync fence: lost, released, or past local validity (which revokes). */
  const heldReason = (): string | null => {
    if (lostCtl.signal.aborted) return String((lostCtl.signal.reason as Error)?.message ?? 'worktree lease lost');
    if (!current) return `worktree lease of run ${o.runId} is not held`;
    if (Date.now() >= validUntil) {
      revoke(`no successful renewal within the lease validity (${o.ttlMs - margin}ms)`);
      return String((lostCtl.signal.reason as Error)?.message ?? 'worktree lease lost');
    }
    return null;
  };
  /** Revoke at the end of local validity unless a renewal extends it first (kills running processes in time). */
  const arm = (): void => {
    if (lostCtl.signal.aborted) return;
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => void heldReason(), Math.max(0, validUntil - Date.now()) + 1);
    watchdog.unref();
  };
  /** One renewal in flight at a time; concurrent callers share it. */
  const renewShared = (): Promise<number> => {
    if (!renewing) renewing = renewOnce().finally(() => (renewing = null));
    return renewing;
  };

  // Renew from the moment the lease is granted, not from the end of the setup: creating or checking the
  // worktree runs several git commands, which on a loaded host can take longer than the lease's validity.
  arm();
  timer = setInterval(() => {
    if (!current) return;
    // A failed renewal revokes (inside renewOnce): no further writes, gates or steps in this process.
    renewShared().catch(() => undefined);
  }, Math.max(25, Math.floor(o.ttlMs / 6)));
  timer.unref();

  try {
    const top = await gitTopLevel(rootAbs, o.signal);
    const isGit = top !== null && real(top) === rootAbs;
    if (top !== null && !isGit) throw new WiringError(`the business case ${rootAbs} is inside the git repository ${top} but is not its top level; run tecera from the repository root`);

    let baseSha: string;
    if (o.resume) {
      if (!existsSync(path) || !lstatSync(path).isDirectory()) throw new WiringError(`the worktree of run ${o.runId} is missing (${path}); it cannot be resumed`);
      if (lstatSync(path).isSymbolicLink()) throw new WiringError(`the worktree of run ${o.runId} is a symlink; refusing`);
      const wtTop = await gitTopLevel(path, o.signal);
      if (wtTop === null || real(wtTop) !== real(path)) throw new WiringError(`the worktree of run ${o.runId} is not a git worktree any more; refusing to resume`);
      if (isGit && (await commonDir(path, o.signal)) !== (await commonDir(rootAbs, o.signal))) throw new WiringError(`the worktree of run ${o.runId} belongs to another repository; refusing to resume`);
      await assertSafeRepo(path, o.signal);
      baseSha = (await hostGit(path, ['rev-parse', '--verify', `${o.base}^{commit}`], { signal: o.signal })).trim();
    } else {
      if (existsSync(path)) throw new WiringError(`a worktree for run ${o.runId} already exists (${path}); refusing to reuse it for a new run`);
      ensureWorktreesRoot(wtRoot);
      if (isGit) {
        await assertSafeRepo(rootAbs, o.signal);
        baseSha = (await hostGit(rootAbs, ['rev-parse', '--verify', `${o.base}^{commit}`], { signal: o.signal })).trim();
        await hostGit(rootAbs, ['worktree', 'add', '--detach', path, baseSha], { signal: o.signal });
      } else {
        cpSync(rootAbs, path, {
          recursive: true,
          dereference: false,
          filter: (src) => {
            const r = relative(rootAbs, src).split('\\').join('/');
            return !(r === '.git' || r.startsWith('.git/') || /^\.tecera\/(ledger\.sqlite[^/]*|runs(\/|$))/.test(r));
          },
        });
        const ident = { GIT_AUTHOR_NAME: 'tecera', GIT_AUTHOR_EMAIL: 'tecera@localhost', GIT_COMMITTER_NAME: 'tecera', GIT_COMMITTER_EMAIL: 'tecera@localhost' };
        await hostGit(path, ['init', '-q', '-b', o.base], { signal: o.signal });
        await hostGit(path, ['add', '-A'], { signal: o.signal });
        await hostGit(path, ['commit', '-q', '--no-verify', '--allow-empty', '-m', 'tecera: base snapshot (business case is not a git repository)'], { env: ident, signal: o.signal });
        baseSha = (await hostGit(path, ['rev-parse', '--verify', 'HEAD^{commit}'], { signal: o.signal })).trim();
      }
      await assertSafeRepo(path, o.signal);
    }

    return {
      path,
      git: isGit,
      base: o.base,
      baseSha,
      fencingToken: () => (heldReason() !== null ? undefined : current?.fencingToken),
      lost: lostCtl.signal,
      assertHeld: async (token?: number): Promise<number> => {
        if (token !== undefined && token !== granted) throw new LeaseLost(`stale fencing token ${token} (this process holds ${granted})`);
        const why = heldReason();
        if (why !== null) throw new LeaseLost(why);
        return renewShared();
      },
      heldReason,
      checkpoint: (signal?: AbortSignal) => snapshotTree(path, signal),
      restore: (checkpointId: string, signal?: AbortSignal) => restoreTree(path, baseSha, checkpointId, signal),
      prepareBranch: (a: PrepareBranchOptions) =>
        prepareWorktreeBranch(path, baseSha, a, () => {
          const why = heldReason();
          if (why !== null) throw new LeaseLost(why);
        }),
      release,
    };
  } catch (e) {
    await release();
    if (e instanceof WiringError) throw e;
    if (e instanceof UnsafeRepo) throw new WiringError(e.message);
    throw new WiringError(`worktree setup failed: ${(e as Error).message}`);
  }
}

// ---------- worktree checkpoints (S2: discard uncheckpointed writes) ----------

const TREE_ID = /^tree:([0-9a-f]{40}|[0-9a-f]{64})$/;

/** Snapshot tracked + untracked (not ignored) files of the worktree into a tree object, through a private index. */
export async function snapshotTree(dir: string, signal?: AbortSignal): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), 'tecera-cp-index-'));
  const env = { GIT_INDEX_FILE: join(tmp, 'index') };
  try {
    await hostGit(dir, ['read-tree', 'HEAD'], { env, signal });
    await hostGit(dir, ['add', '-A'], { env, signal });
    const tree = (await hostGit(dir, ['write-tree'], { env, signal })).trim();
    if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(tree)) throw new Error(`write-tree returned ${JSON.stringify(tree.slice(0, 80))}`);
    return `tree:${tree}`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * A read-only existence test for repository-relative paths under `root` (the planner's repository view). A path
 * that is absolute, climbs out with `..`, or resolves (through a link) outside the root is reported absent.
 */
export function repoFileView(root: string): (path: string) => boolean {
  const real = realpathSync(root);
  return (p) => {
    if (typeof p !== 'string' || p === '' || isAbsolute(p) || p.split(/[\\/]/).includes('..')) return false;
    try {
      const r = realpathSync(join(real, p));
      return r === real || r.startsWith(real + sep);
    } catch {
      return false;
    }
  };
}

/**
 * Files that differ between two checkpoints (`tree:<oid>` each), with added/removed line counts (binary: 0).
 * Paths and counts only; no file content leaves this function. Throws on a malformed id or a git failure.
 */
export async function diffTrees(dir: string, from: string, to: string, signal?: AbortSignal): Promise<{ path: string; added: number; removed: number }[]> {
  const oid = (id: string): string => {
    const m = TREE_ID.exec(id);
    if (!m) throw new Error(`not a worktree checkpoint: ${JSON.stringify(id)}`);
    return m[1]!;
  };
  const out = await hostGit(dir, ['diff-tree', '-r', '--no-renames', '--numstat', '-z', oid(from), oid(to)], { signal, maxBuffer: 16 * 1024 * 1024 });
  const files: { path: string; added: number; removed: number }[] = [];
  // -z numstat without renames: "<added>\t<removed>\t<path>\0" per file; '-' counts mark a binary file
  for (const rec of out.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(rec);
    if (!m) continue;
    files.push({ path: m[3]!, added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]) });
  }
  return files;
}

/**
 * Every path that differs between two checkpoints (`tree:<oid>` each; `from` may be 'base' when `baseSha` is
 * given) and whether it is gone in the second.
 * Renames are not paired: the old name is listed as deleted and the new one as present. Names only.
 */
export async function changedPaths(dir: string, from: string, to: string, signal?: AbortSignal, baseSha?: string): Promise<{ path: string; deleted: boolean }[]> {
  const oid = (id: string): string => {
    const m = TREE_ID.exec(id);
    if (!m) throw new Error(`not a worktree checkpoint: ${JSON.stringify(id)}`);
    return m[1]!;
  };
  // 'base': the tree of the run's base commit
  const first = from === 'base' && baseSha ? (await hostGit(dir, ['rev-parse', '--verify', `${baseSha}^{tree}`], { signal })).trim() : oid(from);
  const out = await hostGit(dir, ['diff-tree', '-r', '--no-renames', '--name-status', '-z', first, oid(to)], { signal, maxBuffer: 16 * 1024 * 1024 });
  // -z name-status without renames: "<status>\0<path>\0" per file
  const parts = out.split('\0');
  const files: { path: string; deleted: boolean }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!;
    const path = parts[i + 1]!;
    if (!status || !path) continue;
    files.push({ path, deleted: status.startsWith('D') });
  }
  return files;
}

/**
 * Make the worktree equal to `checkpointId` ('base' or tree:<oid>), reset the index to HEAD, and prove it by
 * re-snapshotting. Returns the restored checkpoint id. Throws when the id is malformed or the proof fails.
 */
export async function restoreTree(dir: string, baseSha: string, checkpointId: string, signal?: AbortSignal): Promise<string> {
  let tree: string;
  if (checkpointId === 'base') tree = (await hostGit(dir, ['rev-parse', '--verify', `${baseSha}^{tree}`], { signal })).trim();
  else {
    const m = TREE_ID.exec(checkpointId);
    if (!m) throw new Error(`not a worktree checkpoint: ${JSON.stringify(checkpointId)}`);
    tree = m[1]!;
    const type = (await hostGit(dir, ['cat-file', '-t', tree], { signal })).trim();
    if (type !== 'tree') throw new Error(`checkpoint ${checkpointId} is a ${type}, not a tree`);
  }
  // working tree + index := tree (overwrites local changes), then remove what the tree does not have
  await hostGit(dir, ['read-tree', '--reset', '-u', tree], { signal });
  await hostGit(dir, ['clean', '-f', '-d', '-q'], { signal });
  // the index goes back to the base commit (workers never stage; the gates build their own trees)
  await hostGit(dir, ['read-tree', 'HEAD'], { signal });
  const now = await snapshotTree(dir, signal);
  if (now !== `tree:${tree}`) throw new Error(`worktree restore to ${checkpointId} did not converge (now ${now})`);
  return checkpointId;
}

// ---------- a fresh work branch per intention ----------

/**
 * Put the worktree `dir` on `branch` at `baseSha`, carrying nothing over:
 *  1. the branch must not exist, or exist at the base (an interrupted preparation); anything else is refused;
 *  2. `fence()` (throws when the lease is gone), then the branch is created at the base;
 *  3. `fence()`, then HEAD is pointed at the branch (the previous intention's branch keeps its commit);
 *  4. `fence()`, then the working tree and index are made equal to the base tree (restoreTree, proven by a
 *     re-snapshot), and ignored files the run's baseline does not hold are removed;
 *  5. the result is read back: HEAD is the branch, the branch is the base.
 * No step runs after a failed fence, so a lost lease before step 2 leaves the repository untouched.
 */
export async function prepareWorktreeBranch(dir: string, baseSha: string, a: PrepareBranchOptions, fence: () => void): Promise<PreparedBranch> {
  const signal = a.signal;
  const ref = `refs/heads/${a.branch}`;
  await hostGit(dir, ['check-ref-format', '--branch', a.branch], { signal });
  const oidOf = async (r: string): Promise<string | null> => (await hostGit(dir, ['rev-parse', '--verify', '--quiet', `${r}^{commit}`], { signal }).catch(() => '')).trim() || null;
  const at = await oidOf(ref);
  if (at !== null && at !== baseSha) throw new Error(`branch ${a.branch} already exists at ${at}, not at the base ${baseSha}; refusing to reuse it`);
  await a.beforeMutation?.();
  fence();
  if (at === null) await hostGit(dir, ['update-ref', '-m', 'tecera: prepare intention branch', ref, baseSha, '0'.repeat(baseSha.length)], { signal });
  fence();
  await hostGit(dir, ['symbolic-ref', '-m', 'tecera: prepare intention branch', 'HEAD', ref], { signal });
  fence();
  await restoreTree(dir, baseSha, 'base', signal);
  fence();
  const removedIgnored = removeIgnored(dir, (await hostGit(dir, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'], { signal, maxBuffer: 64 * 1024 * 1024 })).split('\0'), a.keepIgnored);
  const headRef = (await hostGit(dir, ['symbolic-ref', '-q', 'HEAD'], { signal }).catch(() => '')).trim();
  const head = await oidOf('HEAD');
  if (headRef !== ref || head !== baseSha) throw new Error(`the worktree is not on ${a.branch} at the base after its preparation (HEAD ${headRef || 'detached'} at ${head ?? 'nothing'})`);
  return { branch: a.branch, baseSha, created: at === null, removedIgnored };
}

/** Remove the listed ignored paths unless kept. A path that leaves the worktree (a link on the way) is refused. */
function removeIgnored(dir: string, listed: readonly string[], keep?: (pathKey: string) => boolean): number {
  const root = realpathSync(dir);
  let n = 0;
  for (const raw of listed) {
    if (!raw) continue;
    const rel = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    if (keep?.(ignoredPathKey(rel))) continue;
    if (isAbsolute(rel) || rel.split('/').includes('..')) throw new Error(`ignored path ${JSON.stringify(rel)} is not inside the worktree`);
    const abs = join(root, rel);
    let parent: string;
    try {
      parent = realpathSync(dirname(abs));
    } catch {
      continue; // already gone with a directory removed above
    }
    if (!inside(root, parent)) throw new Error(`ignored path ${JSON.stringify(rel)} resolves outside the worktree; refusing to remove it`);
    // rmSync removes a link itself, never what it points at
    rmSync(join(parent, abs.slice(dirname(abs).length + 1)), { recursive: true, force: true });
    n++;
  }
  return n;
}
