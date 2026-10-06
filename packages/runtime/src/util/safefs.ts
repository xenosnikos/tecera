import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, unlinkSync, writeSync, type Stats } from 'node:fs';
import { join, sep } from 'node:path';
import { pathProblem } from '@tecera/policy';

/**
 * Filesystem containment for every read and write the runtime makes inside a business-case root.
 *
 * - Paths are repo-relative POSIX strings, checked by policy.pathProblem (no absolute, no `..`, no NUL).
 * - The root itself is resolved once with realpath (a symlinked checkout location is fine). Below the root
 *   every segment is lstat'ed: a symbolic link (live or dangling) anywhere in the path is refused, a
 *   non-directory in the middle is refused, and any lstat failure other than "does not exist" is refused.
 *   Nothing ever falls back to the lexical path.
 * - Reads AND writes refuse a target with more than one hard link (checked on the opened descriptor for
 *   reads): a hard link can alias a file outside the root or a protected file under another name. A new file is created with
 *   O_CREAT|O_EXCL|O_NOFOLLOW (an attacker-planted name, link or not, makes the create fail). An existing
 *   file is replaced by writing a sibling temp file (O_EXCL|O_NOFOLLOW) and renaming it over the target:
 *   rename replaces the directory entry and never writes through a link. The parent chain is re-checked
 *   after the write and before the rename.
 * - Residual race: Node has no openat/O_PATH, so a directory in the chain swapped for a symlink between the
 *   re-check and the rename is not detectable here. Callers run with the repo under the supervisor's lease.
 */

export class UnsafePathError extends Error {
  constructor(message: string, readonly path: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export interface PathInfo {
  /** Absolute path under the real root. */
  abs: string;
  exists: boolean;
  kind?: 'file' | 'dir' | 'other';
  nlink?: number;
  ino?: number;
  mode?: number;
}

function code(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

/** realpath of the root, or null when it does not exist. Any other failure is refused. */
export function realRoot(root: string): string | null {
  try {
    return realpathSync(root);
  } catch (err) {
    if (code(err) === 'ENOENT') return null;
    throw new UnsafePathError(`cannot resolve root ${root}: ${code(err) ?? (err as Error).message}`, root);
  }
}

function segments(rel: string): string[] {
  const bad = pathProblem(rel);
  if (bad) throw new UnsafePathError(`${rel}: ${bad}`, rel);
  const parts = rel.split('/').filter((s) => s !== '' && s !== '.');
  if (parts.length === 0) throw new UnsafePathError(`${rel}: empty path`, rel);
  return parts;
}

function kindOf(st: Stats): 'file' | 'dir' | 'other' {
  return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
}

/** Walk `rel` below the real root segment by segment with lstat. Throws UnsafePathError on any link or failure. */
export function inspectPath(root: string, rel: string): PathInfo {
  const parts = segments(rel);
  const base = realRoot(root);
  if (base === null) return { abs: join(root, ...parts), exists: false };
  let cur = base;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]!);
    const shown = parts.slice(0, i + 1).join('/');
    let st: Stats;
    try {
      st = lstatSync(cur);
    } catch (err) {
      if (code(err) === 'ENOENT') return { abs: join(base, ...parts), exists: false };
      throw new UnsafePathError(`${shown}: cannot be resolved (${code(err) ?? (err as Error).message}); refusing`, shown);
    }
    if (st.isSymbolicLink()) throw new UnsafePathError(`${shown} is a symbolic link; refusing to follow it`, shown);
    if (i < parts.length - 1 && !st.isDirectory()) throw new UnsafePathError(`${shown} is not a directory`, shown);
    if (i === parts.length - 1) return { abs: cur, exists: true, kind: kindOf(st), nlink: st.nlink, ino: st.ino, mode: st.mode };
  }
  /* c8 ignore next */
  throw new UnsafePathError(`${rel}: unreachable`, rel);
}

/** Read a regular file under root, or undefined when absent. Links, hard links and non-files are refused. */
export function safeReadFile(root: string, rel: string): Buffer | undefined {
  const info = inspectPath(root, rel);
  if (!info.exists) return undefined;
  if (info.kind !== 'file') throw new UnsafePathError(`${rel} is not a regular file`, rel);
  if ((info.nlink ?? 1) > 1) throw new UnsafePathError(`${rel} has ${info.nlink} hard links; refusing to read through a hard link`, rel);
  let fd: number;
  try {
    fd = openSync(info.abs, constants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    throw new UnsafePathError(`${rel}: cannot open (${code(err) ?? (err as Error).message})`, rel);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.ino !== info.ino) throw new UnsafePathError(`${rel} changed while it was opened`, rel);
    if (st.nlink > 1) throw new UnsafePathError(`${rel} has ${st.nlink} hard links; refusing to read through a hard link`, rel);
    const out = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, out, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return out.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

/** True when `rel` exists (any kind). Unsafe paths throw. */
export function safeExists(root: string, rel: string): boolean {
  return inspectPath(root, rel).exists;
}

/** Create the directory chain `relDir` below root, one checked segment at a time. */
export function safeMkdirp(root: string, relDir: string): void {
  const base = realRoot(root);
  if (base === null) throw new UnsafePathError(`root ${root} does not exist`, root);
  const parts = segments(relDir);
  for (let i = 1; i <= parts.length; i++) {
    const rel = parts.slice(0, i).join('/');
    const info = inspectPath(root, rel);
    if (info.exists) {
      if (info.kind !== 'dir') throw new UnsafePathError(`${rel} is not a directory`, rel);
      continue;
    }
    try {
      mkdirSync(info.abs);
    } catch (err) {
      if (code(err) !== 'EEXIST') throw new UnsafePathError(`${rel}: cannot create directory (${code(err) ?? (err as Error).message})`, rel);
    }
    const again = inspectPath(root, rel);
    if (!again.exists || again.kind !== 'dir') throw new UnsafePathError(`${rel} was replaced while being created`, rel);
  }
}

function writeAll(fd: number, data: Buffer): void {
  let off = 0;
  while (off < data.length) off += writeSync(fd, data, off, data.length - off);
}

/** Write `rel` under root without following links or writing through hard links. */
export function safeWriteFile(root: string, rel: string, content: string | Buffer): void {
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const parts = segments(rel);
  const parentRel = parts.slice(0, -1).join('/');
  if (parentRel) safeMkdirp(root, parentRel);
  else if (realRoot(root) === null) throw new UnsafePathError(`root ${root} does not exist`, root);
  const info = inspectPath(root, rel);
  if (info.exists) {
    if (info.kind !== 'file') throw new UnsafePathError(`${rel} is not a regular file`, rel);
    if ((info.nlink ?? 1) > 1) throw new UnsafePathError(`${rel} has ${info.nlink} hard links; refusing to write through a hard link`, rel);
  }
  if (!info.exists) {
    let fd: number;
    try {
      fd = openSync(info.abs, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o644);
    } catch (err) {
      throw new UnsafePathError(`${rel}: cannot create (${code(err) ?? (err as Error).message}); something appeared at the path`, rel);
    }
    try {
      writeAll(fd, data);
    } finally {
      closeSync(fd);
    }
    return;
  }
  const parentAbs = info.abs.slice(0, info.abs.length - parts[parts.length - 1]!.length - 1) || sep;
  const tmp = join(parentAbs, `.${parts[parts.length - 1]}.tecera-${randomBytes(6).toString('hex')}.tmp`);
  let fd: number;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, (info.mode ?? 0o644) & 0o777);
  } catch (err) {
    throw new UnsafePathError(`${rel}: cannot create a temp file (${code(err) ?? (err as Error).message})`, rel);
  }
  try {
    writeAll(fd, data);
  } finally {
    closeSync(fd);
  }
  try {
    if (parentRel) {
      const p = inspectPath(root, parentRel);
      if (!p.exists || p.kind !== 'dir') throw new UnsafePathError(`${parentRel} changed during the write`, parentRel);
    }
    const now = inspectPath(root, rel);
    if (now.exists && (now.kind !== 'file' || (now.nlink ?? 1) > 1)) throw new UnsafePathError(`${rel} changed during the write`, rel);
    renameSync(tmp, info.abs);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err instanceof UnsafePathError ? err : new UnsafePathError(`${rel}: write failed (${code(err) ?? (err as Error).message})`, rel);
  }
}

export interface TreeWalk {
  /** Regular files, relative to the walked directory, sorted. */
  files: string[];
  /** Symbolic links (never followed). */
  links: string[];
  /** Entries that are neither files, directories nor links (sockets, fifos, devices). */
  special: string[];
  /** Directories or entries that could not be read, with the error code. */
  errors: Array<{ path: string; error: string }>;
  /** Listed exclusions that were NOT skipped because they are not a single-link regular file. */
  refusedSkips: Array<{ path: string; why: string }>;
}

/**
 * lstat-based recursive walk that never follows links and reports every failure. Missing dir = empty.
 * `skip` holds EXACT paths relative to `dir` (never basenames, never directories): an entry is skipped only
 * when its relative path is listed AND it is a regular file with a single link. A listed path that is a
 * directory, a link, a special file or a hard-linked file is reported in `refusedSkips` (and walked/listed as
 * usual), so an exclusion can never hide content.
 */
export function walkTree(dir: string, skip: ReadonlySet<string> = new Set()): TreeWalk {
  const out: TreeWalk = { files: [], links: [], special: [], errors: [], refusedSkips: [] };
  const visit = (abs: string, rel: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch (err) {
      if (rel === '' && code(err) === 'ENOENT') return;
      out.errors.push({ path: rel || '.', error: code(err) ?? (err as Error).message });
      return;
    }
    for (const name of entries.sort()) {
      const p = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      let st: Stats;
      try {
        st = lstatSync(p);
      } catch (err) {
        out.errors.push({ path: r, error: code(err) ?? (err as Error).message });
        continue;
      }
      if (skip.has(r)) {
        if (st.isFile() && !st.isSymbolicLink() && st.nlink === 1) continue;
        out.refusedSkips.push({ path: r, why: st.isSymbolicLink() ? 'is a symbolic link' : st.isDirectory() ? 'is a directory' : !st.isFile() ? 'is not a regular file' : `has ${st.nlink} hard links` });
      }
      if (st.isSymbolicLink()) out.links.push(r);
      else if (st.isDirectory()) visit(p, r);
      else if (st.isFile()) out.files.push(r);
      else out.special.push(r);
    }
  };
  visit(dir, '');
  out.files.sort();
  return out;
}
