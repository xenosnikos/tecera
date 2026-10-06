import { randomBytes } from 'node:crypto';
import { constants as C, existsSync, fstatSync, linkSync, lstatSync, readlinkSync, realpathSync, renameSync, unlinkSync, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, readlink, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { requireWriteGuard, sha256, type WriteGuard, type WriteIntent } from '@tecera/contracts';

/**
 * Worktree confinement (docs/security.md, tamper.symlink_hardlink).
 *
 * Reads: the path is resolved against the worktree's realpath; `..`, NUL, backslashes, absolute paths
 * outside the worktree and anything that resolves (through a symlink at any level) outside it are refused.
 * In-worktree symlinks may be read through, but the caller authorizes BOTH the lexical and the resolved
 * worktree-relative path; the opened descriptor is re-checked against the worktree (its /proc/self/fd
 * path, or its dev/ino against the authorized lstat), and hardlinked files (nlink > 1) are refused.
 *
 * Writes (writeInWorktree) close the check-to-mutation window instead of narrowing it:
 *  - Exclusive: every mutation of a worktree in this process (writes and verification runs) holds the
 *    worktree's lock, so no concurrent tool call can move, link or replace anything mid-write.
 *  - Identity-pinned authorization: no symlink anywhere in the path, never into .git/ or .tecera/
 *    (case-insensitive); the resolved path is authorized, and the (dev, ino) of the root, of every existing
 *    directory segment and of an existing target (which must have nlink = 1) is recorded.
 *  - Open-then-verify: the directory chain is opened one segment at a time relative to the previous
 *    directory descriptor (/proc/self/fd/<n>/<seg>, O_DIRECTORY|O_NOFOLLOW); each opened descriptor is
 *    fstat'ed and must have the authorized (dev, ino) (a parent directory replaced or moved between
 *    authorization and open is refused); its /proc/self/fd readlink must be the authorized path. An existing
 *    target is opened O_NOFOLLOW and must be the authorized inode, a regular file, nlink = 1.
 *  - Fenced: the step's WriteGuard (contracts) is checked immediately before EVERY mutation syscall —
 *    mkdir, temp-file create, the first data write (after the temp descriptor was fstat-verified) and the
 *    commit — and the exact write (path + sha256 of the bytes) is authorized (beforeWrite → the guard's
 *    authorizeWrite) before anything is created. No guard = every write refused.
 *  - Authorized by descriptor: before a directory entry is created (mkdir, temp file) the parent descriptor
 *    is re-verified to be the authorized directory at its authorized path (identity of every chain
 *    segment); a parent swapped or moved after open is refused BEFORE anything is written into it.
 *  - No in-place mutation: the new content is written to a fresh O_CREAT|O_EXCL|O_NOFOLLOW temp file in
 *    the verified directory, fsync'ed, and then committed with synchronous calls only (no await, so nothing
 *    in this process interleaves): re-verify (target identity, nlink, directory path and identity, signal,
 *    guard) → keep a backup link of the original → rename over the target (or link(2) for a new file, which
 *    can never overwrite) → post-commit verify. The original inode is never written, so a hardlink or a
 *    move of the target after the checks can never carry the write into a protected file.
 *  - Post-commit verification with rollback: if the directory chain or the committed entry is not what was
 *    authorized after the commit (an outside process raced the synchronous window), the commit is undone
 *    in the same directory inode (the original inode goes back under its name; a new entry is removed), so
 *    a directory moved into a protected path or out of the worktree ends with its original content; then
 *    the worktree is TAINTED: a TaintError is thrown, the worktree is recorded in the taint registry and
 *    every later file and verify tool on it refuses. A tainted worktree must never be reused, checkpointed
 *    or gated. Residual: an outside process that can rename directories in the worktree can make the new
 *    bytes briefly visible in the moved directory between the commit and the rollback (microseconds);
 *    excluding outside writers needs kernel confinement (sandbox/runtime lanes).
 *  - Platforms without /proc/self/fd (no descriptor path verification) refuse every write. There is no
 *    path-based fallback.
 */

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

/** The write may have landed somewhere it was not authorized: the worktree is quarantined. */
export class TaintError extends PathError {
  readonly tainted = true;
  constructor(message: string) {
    super(message);
    this.name = 'TaintError';
  }
}

/** Filesystem identity of one path segment at authorization time (bigint dev/ino as decimal strings). */
export interface FsIdentity {
  dev: string;
  ino: string;
}

export interface Resolved {
  /** Absolute real path (for a file that does not exist yet: the real parent + remaining segments). */
  abs: string;
  /** Resolved worktree-relative path with forward slashes (what policy must be evaluated against). */
  rel: string;
  /** The worktree-relative path as given (normalized). Differs from `rel` only through an in-worktree symlink (reads). */
  lexicalRel: string;
  exists: boolean;
  /**
   * Writes only: identities recorded at authorization. `dirs[0]` is the worktree root, `dirs[i]` the i-th
   * directory segment (only those that existed); `target` the existing file.
   */
  identity?: { dirs: FsIdentity[]; target?: FsIdentity };
}

const within = (root: string, p: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
const toRel = (root: string, p: string): string => relative(root, p).split(sep).join('/');
const idOf = (st: BigIntStats): FsIdentity => ({ dev: String(st.dev), ino: String(st.ino) });
const sameId = (a: FsIdentity | undefined, st: BigIntStats): boolean => !!a && a.dev === String(st.dev) && a.ino === String(st.ino);

/** Never written, whatever the capabilities say. Matched case-insensitively. */
export const HARD_PROTECTED = [/^\.git(\/|$)/i, /^\.tecera(\/|$)/i];

export const isHardProtected = (rel: string): boolean => HARD_PROTECTED.some((re) => re.test(rel));

function errno(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException)?.code;
}

// ---------------------------------------------------------------- taint registry

const TAINTED = new Map<string, string>();

function keysOf(path: string): string[] {
  const keys = new Set<string>([resolve(path)]);
  try {
    keys.add(realpathSync(path));
  } catch {
    /* the worktree may be gone: the lexical key still matches */
  }
  return [...keys];
}

/** Quarantine a worktree: every later file and verify tool on it refuses (this process). */
export function markWorktreeTainted(worktree: string, reason: string): void {
  if (typeof worktree !== 'string' || !worktree) return;
  for (const k of keysOf(worktree)) if (!TAINTED.has(k)) TAINTED.set(k, reason);
}

/** Why the worktree is quarantined, or null. */
export function worktreeTaint(worktree: string): string | null {
  if (typeof worktree !== 'string' || !worktree) return null;
  for (const k of keysOf(worktree)) {
    const r = TAINTED.get(k);
    if (r !== undefined) return r;
  }
  return null;
}

function assertNotTainted(worktree: string): void {
  const t = worktreeTaint(worktree);
  if (t !== null) throw new TaintError(`the worktree is quarantined (tainted: ${t}); it must not be reused`);
}

// ---------------------------------------------------------------- exclusive worktree lock

const LOCKS = new Map<string, Promise<void>>();

/**
 * Run `fn` holding the worktree's exclusive mutation lock (this process). Writes and verification runs
 * take it, so no tool call can move, link or replace files while another one is writing or verifying.
 */
export async function withWorktreeLock<T>(worktree: string, fn: () => Promise<T>): Promise<T> {
  const key = await rootOf(worktree);
  const prev = LOCKS.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => mine);
  LOCKS.set(key, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (LOCKS.get(key) === chained) LOCKS.delete(key);
  }
}

// ---------------------------------------------------------------- resolution

async function rootOf(worktree: unknown): Promise<string> {
  if (typeof worktree !== 'string' || worktree.length === 0) throw new PathError('no worktree is configured for this step; file tools are refused');
  try {
    return await realpath(worktree);
  } catch {
    throw new PathError('the worktree does not exist');
  }
}

/** Validate the input and return the lexical worktree-relative segments. */
function segmentsOf(worktree: string, root: string, input: unknown): string[] {
  if (typeof input !== 'string' || input.length === 0) throw new PathError('path must be a non-empty string');
  if (input.length > 4096) throw new PathError('path too long');
  if (input.includes('\0')) throw new PathError('path contains NUL');
  if (input.includes('\\')) throw new PathError('path contains a backslash');
  let relPath: string;
  if (isAbsolute(input)) {
    const lexical = resolve(input);
    if (within(root, lexical)) relPath = relative(root, lexical);
    else if (within(resolve(worktree), lexical)) relPath = relative(resolve(worktree), lexical);
    else throw new PathError(`absolute path outside the worktree: ${input}`);
    relPath = relPath.split(sep).join('/');
  } else {
    relPath = input;
  }
  const raw = relPath.split('/');
  if (raw.some((s) => s === '..')) throw new PathError(`path traversal (..) refused: ${input}`);
  const segs = raw.filter((s) => s !== '' && s !== '.');
  for (const s of segs) if (s.length > 255) throw new PathError('path segment too long');
  return segs;
}

export async function resolveInWorktree(worktree: string, input: unknown, opts: { forWrite?: boolean } = {}): Promise<Resolved> {
  const root = await rootOf(worktree);
  const segs = segmentsOf(worktree, root, input);
  const lexicalRel = segs.join('/');
  if (opts.forWrite && isHardProtected(lexicalRel)) throw new PathError(`writes under ${segs[0]} are never allowed`);
  const candidate = segs.length ? join(root, ...segs) : root;
  if (!within(root, candidate)) throw new PathError(`path escapes the worktree: ${String(input)}`);
  const dirs: FsIdentity[] = [];
  let target: FsIdentity | undefined;
  if (opts.forWrite) dirs.push(idOf(await lstat(root, { bigint: true })));

  // Walk every existing segment without following anything.
  let existing = root;
  let missingFrom = segs.length;
  for (let i = 0; i < segs.length; i++) {
    const p = join(root, ...segs.slice(0, i + 1));
    let st: BigIntStats;
    try {
      st = await lstat(p, { bigint: true });
    } catch (e) {
      if (errno(e) === 'ENOENT') {
        missingFrom = i;
        break;
      }
      if (errno(e) === 'ENOTDIR') throw new PathError(`not a directory: ${segs.slice(0, i).join('/')}`);
      throw new PathError(`cannot inspect ${segs.slice(0, i + 1).join('/')}`);
    }
    if (st.isSymbolicLink()) {
      if (opts.forWrite) throw new PathError(`refusing to write through a symlink: ${segs.slice(0, i + 1).join('/')}`);
      let real: string;
      try {
        real = await realpath(p);
      } catch {
        throw new PathError(`dangling symlink: ${segs.slice(0, i + 1).join('/')}`);
      }
      if (!within(root, real)) throw new PathError(`path resolves outside the worktree (symlink escape): ${String(input)}`);
    } else if (i < segs.length - 1 && !st.isDirectory()) {
      throw new PathError(`not a directory: ${segs.slice(0, i + 1).join('/')}`);
    }
    if (opts.forWrite) {
      if (i < segs.length - 1) dirs.push(idOf(st));
      else {
        if (!st.isFile()) throw new PathError(`not a regular file: ${lexicalRel}`);
        if (st.nlink !== 1n) throw new PathError(`refusing to write a hardlinked file (nlink=${st.nlink}): ${lexicalRel}`);
        target = idOf(st);
      }
    }
    existing = p;
  }
  const identity = opts.forWrite ? { identity: { dirs, ...(target ? { target } : {}) } } : {};

  if (missingFrom === segs.length) {
    // The whole path exists.
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      throw new PathError(`cannot resolve ${lexicalRel}`);
    }
    if (!within(root, real)) throw new PathError(`path resolves outside the worktree (symlink escape): ${String(input)}`);
    if (opts.forWrite && real !== candidate) throw new PathError(`path resolves through an alias: ${lexicalRel}`);
    return { abs: real, rel: toRel(root, real), lexicalRel, exists: true, ...identity };
  }
  // Does not exist: authorize realpath(deepest existing ancestor) + the remaining segments.
  let realAncestor: string;
  try {
    realAncestor = await realpath(existing);
  } catch {
    throw new PathError(`cannot resolve the parent of ${lexicalRel}`);
  }
  if (!within(root, realAncestor)) throw new PathError(`parent resolves outside the worktree (symlink escape): ${String(input)}`);
  if (opts.forWrite && realAncestor !== existing) throw new PathError(`parent resolves through an alias: ${lexicalRel}`);
  const abs = join(realAncestor, ...segs.slice(missingFrom));
  if (!within(root, abs)) throw new PathError(`path escapes the worktree: ${String(input)}`);
  return { abs, rel: toRel(root, abs), lexicalRel, exists: false, ...identity };
}

// ---------------------------------------------------------------- descriptor-relative opens

const PROC_FD = existsSync('/proc/self/fd');
const O_NOFOLLOW = C.O_NOFOLLOW ?? 0;
const O_DIRECTORY = C.O_DIRECTORY ?? 0;

/** True when descriptor paths can be verified here (/proc/self/fd); writes refuse otherwise. */
export function fdVerificationSupported(): boolean {
  return PROC_FD;
}

const fdPath = (fh: FileHandle, name: string): string => `/proc/self/fd/${fh.fd}/${name}`;

async function fdReal(fh: FileHandle): Promise<string | null> {
  if (!PROC_FD) return null;
  try {
    return await readlink(`/proc/self/fd/${fh.fd}`);
  } catch {
    return null;
  }
}

function fdRealSync(fd: number): string | null {
  try {
    return readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return null;
  }
}

/** Read a regular file through an O_NOFOLLOW descriptor that is re-checked against the worktree. */
export async function readInWorktree(worktree: string, r: Resolved, maxBytes: number): Promise<Buffer> {
  const root = await rootOf(worktree);
  assertNotTainted(root);
  let before: BigIntStats | null = null;
  if (!PROC_FD) before = await lstat(r.abs, { bigint: true }).catch(() => null);
  let fh: FileHandle;
  try {
    fh = await open(r.abs, C.O_RDONLY | O_NOFOLLOW);
  } catch (e) {
    if (errno(e) === 'ELOOP') throw new PathError(`path changed into a symlink: ${r.rel}`);
    if (errno(e) === 'ENOENT') throw new PathError(`no such file: ${r.rel}`);
    throw new PathError(`cannot open ${r.rel}`);
  }
  try {
    const st = await fh.stat({ bigint: true });
    if (PROC_FD) {
      const real = await fdReal(fh);
      if (real === null || real !== r.abs || !within(root, real)) throw new PathError(`path changed while opening: ${r.rel}`);
    } else if (!before || before.dev !== st.dev || before.ino !== st.ino) {
      throw new PathError(`path changed while opening: ${r.rel}`);
    }
    if (!st.isFile()) throw new PathError(`not a regular file: ${r.rel}`);
    if (st.nlink !== 1n) throw new PathError(`refusing to read a hardlinked file (nlink=${st.nlink}): ${r.rel}`);
    const size = Number(st.size);
    if (size > maxBytes) throw new PathError(`file too large (${size} > ${maxBytes} bytes): ${r.rel}`);
    return await readAllBuf(fh, size);
  } finally {
    await fh.close().catch(() => undefined);
  }
}

export interface WriteOptions {
  maxBytes: number;
  /** Policy check on the resolved worktree-relative path; throw to refuse. Runs before anything is created. */
  authorize: (rel: string) => void;
  /** 'replace' requires an existing file; 'write' creates or overwrites. */
  mode: 'replace' | 'write';
  /**
   * The mutation-time fence (contracts WriteGuard). check() runs immediately before EVERY mutation syscall
   * (mkdir, temp-file create, the first data write on the fstat-verified temp descriptor, the commit rename
   * or link); FenceLost refuses the write. Absent = every write is refused (requireWriteGuard).
   */
  guard?: WriteGuard;
  /**
   * Authorization of the exact write (path + sha256 of the bytes), after the new content is known and
   * before anything is created: the edit tool calls guard.authorizeWrite here (only 'allowed' writes; D6
   * removed per-write approvals). Throw to refuse; nothing has been created yet.
   */
  beforeWrite?: (w: WriteIntent) => Promise<void>;
  /** Cancellation: checked synchronously immediately before the commit; an aborted write changes nothing. */
  signal?: AbortSignal;
  /** Test seam: runs after the path was authorized and before the directory chain is opened. */
  beforeOpen?: (r: Resolved) => Promise<void>;
  /** Test seam: runs after the current content was read (and the descriptor verified), before the temp file is written. */
  afterRead?: (r: Resolved) => Promise<void>;
  /** Test seam: runs after the temp file was created and verified, immediately before its data is written. */
  beforeData?: (r: Resolved) => Promise<void>;
  /** Test seam: runs synchronously after the pre-commit verification, immediately before the commit. */
  beforeCommit?: (r: Resolved) => void;
  /** Test seam: pretend /proc/self/fd is unavailable (unsupported platform). */
  assumeNoProcFd?: boolean;
}

export interface WriteResult {
  rel: string;
  created: boolean;
  bytes: number;
  content: string;
  /** sha256 of the written content (what authorizeWrite was asked about). */
  contentDigest: string;
}

/**
 * Write a file inside the worktree. `next(current)` gets the current UTF-8 content (null for a new file)
 * and returns the new content; the content it sees comes from the verified descriptor of the authorized
 * inode. Holds the worktree lock throughout. Throws PathError (refused, nothing changed), FenceLost /
 * WriteRefused from the guard (refused, nothing changed) or TaintError (the commit could not be verified:
 * it was rolled back where possible and the worktree is quarantined).
 */
export async function writeInWorktree(worktree: string, input: unknown, next: (current: string | null) => string, o: WriteOptions): Promise<WriteResult> {
  const guard = requireWriteGuard(o.guard);
  const root = await rootOf(worktree);
  if (!PROC_FD || o.assumeNoProcFd) throw new PathError('writes are refused on this platform: descriptor paths (/proc/self/fd) cannot be verified, and there is no path-based fallback');
  assertNotTainted(root);
  guard.check();
  return withWorktreeLock(root, async () => {
    assertNotTainted(root);
    const r = await resolveInWorktree(worktree, input, { forWrite: true });
    if (r.rel === '' || r.abs === root) throw new PathError('cannot write the worktree root');
    o.authorize(r.rel);
    if (o.mode === 'replace' && !r.exists) throw new PathError(`no such file: ${r.rel}`);
    await o.beforeOpen?.(r);
    return writeViaFds(root, r, next, o, guard);
  });
}

/** The content to write, checked against the size cap and authorized (authorizeWrite) before any mutation. */
async function prepare(r: Resolved, current: string | null, next: (current: string | null) => string, o: WriteOptions): Promise<{ content: string; buf: Buffer; contentDigest: string }> {
  const content = next(current);
  if (typeof content !== 'string') throw new PathError('the new content must be a string');
  const buf = Buffer.from(content, 'utf8');
  if (buf.length > o.maxBytes) throw new PathError(`content too large (${buf.length} > ${o.maxBytes} bytes)`);
  const contentDigest = sha256(content);
  await o.beforeWrite?.({ path: r.rel, contentDigest });
  return { content, buf, contentDigest };
}

async function writeViaFds(root: string, r: Resolved, next: (current: string | null) => string, o: WriteOptions, guard: WriteGuard): Promise<WriteResult> {
  const ids = r.identity;
  if (!ids || ids.dirs.length === 0) throw new PathError('write was not authorized with identities; refused');
  const segs = r.rel.split('/');
  const name = segs.pop()!;
  const expectedDir = segs.length ? join(root, ...segs) : root;
  const expectedFile = join(expectedDir, name);
  // A new file has no current content: its exact bytes are authorized BEFORE any directory is created.
  let prepared = r.exists ? null : await prepare(r, null, next, o);
  /** Identity of every directory of the chain once opened (authorized, or created by this write). */
  const chain: FsIdentity[] = [];
  let dir: FileHandle = await open(root, C.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    const rootSt = await dir.stat({ bigint: true });
    if (!sameId(ids.dirs[0], rootSt)) throw new PathError('the worktree root was replaced between authorization and open; refused');
    chain.push(idOf(rootSt));
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      const authorized = ids.dirs[i + 1];
      let child: FileHandle | undefined;
      try {
        child = await open(fdPath(dir, seg), C.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      } catch (e) {
        const code = errno(e);
        if (code === 'ENOENT' && !authorized) {
          // The parent descriptor must still be the authorized directory at its path before anything is created in it.
          verifyChainSync(root, segs.length ? join(root, ...segs.slice(0, i)) : root, dir.fd, chain, (m) => new PathError(`${m}; refused before creating ${seg}`));
          guard.check();
          try {
            await mkdir(fdPath(dir, seg), { mode: 0o755 });
          } catch (m) {
            if (errno(m) !== 'EEXIST') throw new PathError(`cannot create directory ${seg}`);
            throw new PathError(`directory ${seg} appeared between authorization and open; refused`);
          }
          try {
            child = await open(fdPath(dir, seg), C.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
          } catch {
            throw new PathError(`cannot open directory ${seg}`);
          }
        } else if (code === 'ENOENT') throw new PathError(`a directory in ${r.rel} was moved or removed between authorization and open; refused`);
        else if (code === 'ELOOP' || code === 'ENOTDIR') throw new PathError(`refusing to write through a symlink or non-directory: ${seg}`);
        else throw new PathError(`cannot open directory ${seg}`);
      }
      const st = await child.stat({ bigint: true });
      await dir.close().catch(() => undefined);
      dir = child;
      if (!st.isDirectory()) throw new PathError(`not a directory: ${segs.slice(0, i + 1).join('/')}`);
      if (authorized && !sameId(authorized, st)) throw new PathError(`directory ${segs.slice(0, i + 1).join('/')} was replaced between authorization and open (inode changed); refused`);
      chain.push(idOf(st));
    }
    const dirReal = await fdReal(dir);
    if (dirReal === null || dirReal !== expectedDir) throw new PathError(`a directory in ${r.rel} was moved or replaced during the write; refused`);

    // Current content, from the verified authorized inode.
    let mode = 0o644;
    if (r.exists) {
      let fh: FileHandle;
      try {
        fh = await open(fdPath(dir, name), C.O_RDONLY | O_NOFOLLOW);
      } catch (e) {
        if (errno(e) === 'ELOOP') throw new PathError(`refusing to write through a symlink: ${r.rel}`);
        if (errno(e) === 'ENOENT') throw new PathError(`no such file: ${r.rel} (it moved after authorization)`);
        throw new PathError(`cannot open ${r.rel}`);
      }
      let current: string;
      try {
        const st = await fh.stat({ bigint: true });
        if (!st.isFile()) throw new PathError(`not a regular file: ${r.rel}`);
        if (!sameId(ids.target, st)) throw new PathError(`${r.rel} was replaced between authorization and open (inode changed); refused`);
        if (st.nlink !== 1n) throw new PathError(`refusing to write a hardlinked file (nlink=${st.nlink}): ${r.rel}`);
        if ((await fdReal(fh)) !== expectedFile) throw new PathError(`path changed during the write: ${r.rel}`);
        if (Number(st.size) > o.maxBytes) throw new PathError(`file too large to edit: ${r.rel}`);
        mode = Number(st.mode & 0o777n);
        current = (await readAllBuf(fh, Number(st.size))).toString('utf8');
      } finally {
        await fh.close().catch(() => undefined);
      }
      await o.afterRead?.(r);
      prepared = await prepare(r, current, next, o);
    } else {
      await o.afterRead?.(r);
    }
    const { content, buf, contentDigest } = prepared!;

    // Fresh temp inode in the verified directory: authorized by descriptor immediately before it is created.
    const tmpName = `.tecera-tmp-${randomBytes(8).toString('hex')}`;
    verifyChainSync(root, expectedDir, dir.fd, chain, (m) => new PathError(`${m}; refused before writing ${r.rel}`));
    guard.check();
    let tmp: FileHandle;
    try {
      tmp = await open(fdPath(dir, tmpName), C.O_WRONLY | C.O_CREAT | C.O_EXCL | O_NOFOLLOW, 0o600);
    } catch {
      throw new PathError(`cannot create a temporary file next to ${r.rel}`);
    }
    let committed = false;
    try {
      // The temp descriptor is fstat-verified (a fresh, empty, unlinked-elsewhere regular file in the
      // authorized directory, at the authorized path) and the fence re-checked before any data is written.
      await o.beforeData?.(r);
      const tst = await tmp.stat({ bigint: true });
      if (!tst.isFile() || tst.nlink !== 1n || tst.size !== 0n) throw new PathError(`the temporary file next to ${r.rel} is not the one just created; refused`);
      if ((await fdReal(tmp)) !== join(expectedDir, tmpName)) throw new PathError(`a directory in ${r.rel} moved before the data was written; refused`);
      verifyChainSync(root, expectedDir, dir.fd, chain, (m) => new PathError(`${m}; refused before writing ${r.rel}`));
      guard.check();
      let off = 0;
      while (off < buf.length) off += (await tmp.write(buf, off, buf.length - off, off)).bytesWritten;
      await tmp.chmod(mode).catch(() => undefined); // mode copy is best effort (some filesystems ignore it)
      await tmp.sync();
      commitSync(root, r, dir.fd, tmp.fd, tmpName, name, expectedDir, chain, o, guard);
      committed = true;
      await dir.sync().catch(() => undefined);
      return { rel: r.rel, created: !r.exists, bytes: buf.length, content, contentDigest };
    } finally {
      await tmp.close().catch(() => undefined);
      // The tool's own temporary name is always removed (cleanup restores, it never adds content).
      if (!committed) unlinkQuiet(dir.fd, tmpName);
    }
  } finally {
    await dir.close().catch(() => undefined);
  }
}

function unlinkQuiet(dirFd: number, n: string): boolean {
  try {
    unlinkSync(`/proc/self/fd/${dirFd}/${n}`);
    return true;
  } catch {
    return false;
  }
}

const NO_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

/**
 * The commit: synchronous from the last verification to the post-commit verification, so nothing in this
 * process can interleave. Pre-commit failures refuse (nothing changed). A post-commit failure (an outside
 * process moved a directory or linked the inode inside the synchronous window) is ROLLED BACK in the same
 * directory inode the commit used — the original inode is put back under its name (it was kept under a
 * backup link), or the new entry is removed — and only then is the worktree tainted. Whatever directory
 * the racer moved (into a protected path or out of the worktree) therefore ends with its original content.
 */
function commitSync(root: string, r: Resolved, dirFd: number, tmpFd: number, tmpName: string, name: string, expectedDir: string, chain: FsIdentity[], o: WriteOptions, guard: WriteGuard): void {
  const at = (n: string): string => `/proc/self/fd/${dirFd}/${n}`;
  if (o.signal?.aborted) throw new PathError(`write cancelled before commit: ${r.rel}`);
  verifyChainSync(root, expectedDir, dirFd, chain, (m) => new PathError(`${m}; refused before commit: ${r.rel}`));
  if (r.exists) {
    let st: BigIntStats;
    try {
      st = lstatSync(at(name), { bigint: true });
    } catch {
      throw new PathError(`${r.rel} moved or vanished before commit; refused`);
    }
    if (!st.isFile() || !sameId(r.identity!.target, st)) throw new PathError(`${r.rel} was replaced before commit; refused`);
    if (st.nlink !== 1n) throw new PathError(`refusing to write a hardlinked file (nlink=${st.nlink}, a link was added during the write): ${r.rel}`);
  } else {
    try {
      lstatSync(at(name));
      throw new PathError(`${r.rel} appeared between authorization and commit; refused`);
    } catch (e) {
      if (e instanceof PathError) throw e;
    }
  }
  const tmpSt = fstatSync(tmpFd, { bigint: true });
  // Backup of the original inode (same directory), so a commit that turns out to have landed in a moved
  // directory can be undone. Filesystems without hard links move the original aside instead.
  const bakName = `.tecera-bak-${randomBytes(8).toString('hex')}`;
  let backup: 'link' | 'moved' | null = null;
  guard.check();
  o.beforeCommit?.(r);
  if (r.exists) {
    try {
      linkSync(at(name), at(bakName));
      backup = 'link';
    } catch (e) {
      if (!NO_LINK.has(errno(e) ?? '')) throw new PathError(`cannot keep a backup of ${r.rel}; refused`);
      try {
        renameSync(at(name), at(bakName));
        backup = 'moved';
      } catch {
        throw new PathError(`cannot keep a backup of ${r.rel}; refused`);
      }
    }
    try {
      renameSync(at(tmpName), at(name));
    } catch {
      if (backup === 'moved') renameSync(at(bakName), at(name));
      else unlinkQuiet(dirFd, bakName);
      throw new PathError(`cannot commit ${r.rel}; refused`);
    }
  } else {
    let linked = false;
    try {
      linkSync(at(tmpName), at(name));
      linked = true;
    } catch (e) {
      const code = errno(e);
      if (code === 'EEXIST') throw new PathError(`${r.rel} appeared during the commit; refused`);
      // Filesystems without hard links: rename into the (verified-absent) name. Confinement is unchanged
      // (same verified directory); the post-commit verification below still applies.
      if (!NO_LINK.has(code ?? '')) throw new PathError(`cannot create ${r.rel}`);
    }
    if (linked) unlinkQuiet(dirFd, tmpName);
    else renameSync(at(tmpName), at(name));
  }
  // Post-commit verification: anything unexpected now means the write may have landed elsewhere.
  const problem = postCommitProblem(root, expectedDir, dirFd, chain, at(name), tmpSt, tmpFd);
  if (problem === null) {
    if (backup) unlinkQuiet(dirFd, bakName);
    return;
  }
  // Roll back in the directory inode the commit used (wherever a racer moved it).
  let rolledBack = false;
  try {
    if (backup) {
      renameSync(at(bakName), at(name));
      rolledBack = true;
    } else {
      const now = lstatSync(at(name), { bigint: true });
      if (now.dev === tmpSt.dev && now.ino === tmpSt.ino) unlinkSync(at(name));
      rolledBack = true;
    }
  } catch {
    rolledBack = false;
  }
  unlinkQuiet(dirFd, tmpName);
  const reason = `post-commit verification failed for ${r.rel}: ${problem}; ${rolledBack ? 'the commit was rolled back' : 'the rollback FAILED'}`;
  markWorktreeTainted(root, reason);
  throw new TaintError(`${reason}; the worktree is quarantined`);
}

/** Why the committed entry is not exactly the written inode in the authorized directory, or null. */
function postCommitProblem(root: string, expectedDir: string, dirFd: number, chain: FsIdentity[], entry: string, tmpSt: BigIntStats, tmpFd: number): string | null {
  let now: BigIntStats;
  try {
    now = lstatSync(entry, { bigint: true });
  } catch {
    return 'the committed entry is missing';
  }
  if (now.dev !== tmpSt.dev || now.ino !== tmpSt.ino) return 'the committed entry is not the written inode';
  const after = fstatSync(tmpFd, { bigint: true });
  if (after.nlink !== 1n) return `the written inode has ${after.nlink} links`;
  try {
    verifyChainSync(root, expectedDir, dirFd, chain, (m) => new Error(m));
  } catch (e) {
    return (e as Error).message;
  }
  return null;
}

/** The opened directory is still the authorized one, at the authorized path, through the authorized chain. */
function verifyChainSync(root: string, expectedDir: string, dirFd: number, chain: FsIdentity[], fail: (m: string) => Error): void {
  if (fdRealSync(dirFd) !== expectedDir) throw fail('the target directory moved');
  const rel = toRel(root, expectedDir);
  const segs = rel ? rel.split('/') : [];
  for (let i = 0; i <= segs.length; i++) {
    const p = i === 0 ? root : join(root, ...segs.slice(0, i));
    let st: BigIntStats;
    try {
      st = lstatSync(p, { bigint: true });
    } catch {
      throw fail(`${toRel(root, p) || '.'} vanished`);
    }
    if (st.isSymbolicLink() || !sameId(chain[i], st)) throw fail(`${toRel(root, p) || '.'} was replaced`);
  }
}

async function readAllBuf(fh: FileHandle, size: number): Promise<Buffer> {
  const buf = Buffer.alloc(size);
  let off = 0;
  while (off < size) {
    const { bytesRead } = await fh.read(buf, off, size - off, off);
    if (bytesRead === 0) break;
    off += bytesRead;
  }
  return buf.subarray(0, off);
}

