import { createHash } from 'node:crypto';
import { mkdtemp, rm, lstat, readFile, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { digest, type Json } from '@tecera/contracts';
import { pathProblem, type Change, type Hunk } from '@tecera/policy';
import { assertSafeRepo, DANGEROUS_ATTR, DANGEROUS_MODULES, hostGit, safeRev, UnsafeRepo, type RepoSafety } from './gitx.js';

/**
 * The candidate as the host sees it (security.md §5 "_snapshot", rebuilt so git never reads worktree
 * content). The base tree comes from `git ls-tree` (objects only); the worktree is listed with `git
 * ls-files` (names only) and every file is read by the host. Each changed file is recorded as {path,
 * status, mode, sha256, oid}; the fingerprint is the digest of HEAD, the base commit, every change and
 * every ignored file's stamp, so equal fingerprints mean equal bytes and modes, not equal names.
 *
 * Ignored files are compared against the run's ignored baseline (recorded on the untouched tree) by a
 * stable path key (ignoredPathKey), never by the raw name, so the baseline can be persisted redacted and
 * still match after a restart. The comparison covers baseline ∪ present: an ignored file that is new,
 * changed, OR missing (deleted after the baseline) is a '!' change, which the commit gate refuses.
 *
 * An ignored file is compared by its STAMP (ignoredStamp), never by its bytes alone: the stamp binds the
 * content hash to the entry type (file or symlink), the permission bits (st_mode & 0o7777) and the link
 * identity (for a file with st_nlink > 1: whether it is hardlinked and to which inode). The stamp is taken
 * BEFORE the baseline exemption, so an executable-bit change, a same-content hardlink or a same-hash
 * file → symlink swap on an ignored path is a '!' change; and the fingerprint covers every present ignored
 * file's stamp, so the change also moves D1/D2/D3 and survives a fresh instance (the baseline persists
 * stamps, not names).
 */

export type CandidateStatus = 'A' | 'M' | 'D' | '!';

export interface FileRecord {
  path: string;
  status: CandidateStatus;
  /** Git mode now ('100644' | '100755' | '120000'); absent when deleted. */
  mode?: string;
  /** Mode in the base tree, when tracked. */
  baseMode?: string;
  baseOid?: string;
  /** sha256 of the bytes now (for a symlink: of its target). Absent when deleted or unreadable. */
  sha256?: string;
  /** Git blob id of the bytes now in the repository's object format. */
  oid?: string;
  bytes?: number;
  symlink?: boolean;
  nlink?: number;
  /** NUL byte or not valid UTF-8. */
  binary?: boolean;
  /** Why the content could not be read (not a regular file, nested repository, I/O error). */
  unreadable?: string;
  /** An ignored file recorded by the run's ignored baseline is gone ('!' with deleted: true). */
  deleted?: boolean;
  /** Stable path key (ignoredPathKey). Set on a deleted baseline entry, whose `path` is only a display name. */
  pathKey?: string;
  /** Ignored entries only: the ignoredStamp (content + type + permission bits + link identity). */
  stamp?: string;
}

export interface Candidate {
  fingerprint: string;
  head: string;
  baseCommit: string;
  baseTree: string;
  safety: RepoSafety;
  /** Every change against the base, sorted by path (committable A/M/D and ignored '!'). */
  files: FileRecord[];
  /** Stamp of every readable ignored file present (path → ignoredStamp: content, type, mode, links). */
  ignored: Record<string, string>;
  /** Host-read bytes of every A/M file, exactly the bytes the fingerprint covers. */
  content: Map<string, Buffer>;
  /** Base tree entries (path → {mode, oid}). */
  baseEntries: Map<string, { mode: string; oid: string }>;
}

/**
 * The run's ignored-file baseline, keyed by ignoredPathKey(path) so it never needs the raw name:
 * entries: key → ignoredStamp on the untouched tree (a pre-v3 record's content-only hash is read as
 * `legacy:<sha>`, which never matches a stamp: every legacy-baselined file is then a change, fail closed);
 * names: key → display name (redacted when it was persisted), used only to name a baseline file that has
 * gone missing.
 */
export interface IgnoredBaseline {
  entries: Readonly<Record<string, string>>;
  names?: Readonly<Record<string, string>>;
}

export interface SnapshotOptions {
  /** Ignored files recorded on the untouched tree. Unchanged ones are not changes; missing ones are. */
  ignoredBaseline?: IgnoredBaseline;
  signal?: AbortSignal;
}

/** Stable, name-free key of a repository path (sha256 with a domain prefix). */
export function ignoredPathKey(path: string): string {
  return createHash('sha256').update('tecera.path\0').update(path, 'utf8').digest('hex');
}

/** What an ignored file is, besides its bytes (see ignoredStamp). */
export interface IgnoredMeta {
  kind: 'file' | 'symlink';
  /** Permission bits, st_mode & 0o7777 (exec, setuid/setgid, sticky, group/other write). */
  perm: number;
  /** null when st_nlink is 1; else `<dev>:<ino>` (a hardlinked file is bound to its inode). */
  link: string | null;
}

/**
 * Stamp of an ignored file: sha256 over (content sha256, entry type, permission bits, link identity).
 * Two stamps are equal only when the bytes AND the metadata that decides what the path does are equal.
 */
export function ignoredStamp(contentSha256: string, m: IgnoredMeta): string {
  return createHash('sha256')
    .update('tecera.ignored.v3\0')
    .update(`${contentSha256}\0${m.kind}\0${(m.perm & 0o7777).toString(8)}\0${m.link ?? '-'}`)
    .digest('hex');
}

export function gitOid(format: 'sha1' | 'sha256', bytes: Buffer): string {
  return createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export function isBinary(buf: Buffer): boolean {
  if (buf.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return false;
  } catch {
    return true;
  }
}

function zsplit(s: string): string[] {
  return s.split('\0').filter((x) => x.length > 0);
}

export async function lsTree(dir: string, treeish: string, signal?: AbortSignal): Promise<Map<string, { mode: string; type: string; oid: string }>> {
  const out = new Map<string, { mode: string; type: string; oid: string }>();
  for (const rec of zsplit(await hostGit(dir, ['ls-tree', '-r', '-z', '--full-tree', treeish], { signal }))) {
    const tab = rec.indexOf('\t');
    const [mode, type, oid] = rec.slice(0, tab).split(' ');
    out.set(rec.slice(tab + 1), { mode: mode!, type: type!, oid: oid! });
  }
  return out;
}

/** Take the candidate snapshot. Throws UnsafeRepo for hostile/unsupported repositories. */
export async function snapshotCandidate(dir: string, base: string, o: SnapshotOptions = {}): Promise<Candidate> {
  const safety = await assertSafeRepo(dir, o.signal);
  if (!safeRev(base)) throw new UnsafeRepo([`base ref ${JSON.stringify(base)} is not an acceptable ref name`]);
  const signal = o.signal;
  const head = (await hostGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { signal })).trim();
  const baseCommit = (await hostGit(dir, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { signal })).trim();
  const baseTree = (await hostGit(dir, ['rev-parse', '--verify', '--quiet', `${baseCommit}^{tree}`], { signal })).trim();

  const problems: string[] = [];
  const baseEntries = new Map<string, { mode: string; oid: string }>();
  for (const [p, e] of await lsTree(dir, baseCommit, signal)) {
    if (e.type !== 'blob') problems.push(`base tree entry ${p} is a ${e.type} (submodules are not supported)`);
    baseEntries.set(p, { mode: e.mode, oid: e.oid });
  }

  const listed = zsplit(await hostGit(dir, ['ls-files', '-z', '--cached', '--others'], { signal }));
  const ignoredSet = new Set(zsplit(await hostGit(dir, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'], { signal })));
  const paths = [...new Set([...baseEntries.keys(), ...listed, ...ignoredSet])].sort();

  const files: FileRecord[] = [];
  const ignored: Record<string, string> = {};
  /** Path keys of every ignored path that is present now (readable or not). */
  const presentIgnored = new Set<string>();
  const content = new Map<string, Buffer>();
  const attrTexts: Array<{ path: string; text: string }> = [];

  for (const p of paths) {
    const b = baseEntries.get(p);
    const ign = !b && ignoredSet.has(p);
    if (ign) presentIgnored.add(ignoredPathKey(p.endsWith('/') ? p.slice(0, -1) : p));
    if (p.endsWith('/')) {
      files.push({ path: p, status: ign ? '!' : 'A', unreadable: 'nested repository or directory' });
      continue;
    }
    const bad = pathProblem(p);
    if (bad) {
      files.push({ path: p, status: ign ? '!' : 'A', unreadable: bad });
      continue;
    }
    const abs = join(dir, p);
    const st = await lstat(abs).catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' || err.code === 'ENOTDIR' ? null : err));
    if (st === null) {
      if (b) files.push({ path: p, status: 'D', baseMode: b.mode, baseOid: b.oid });
      if (ign) presentIgnored.delete(ignoredPathKey(p));
      continue;
    }
    if (st instanceof Error) {
      files.push({ path: p, status: b ? 'M' : ign ? '!' : 'A', ...(b ? { baseMode: b.mode, baseOid: b.oid } : {}), unreadable: `lstat failed: ${st.code ?? st.message}` });
      continue;
    }
    let bytes: Buffer;
    let mode: string;
    let symlink = false;
    try {
      if (st.isSymbolicLink()) {
        bytes = Buffer.from(await readlink(abs, { encoding: 'buffer' }));
        mode = '120000';
        symlink = true;
      } else if (st.isFile()) {
        bytes = await readFile(abs);
        const exec = (st.mode & 0o100) !== 0;
        mode = safety.fileMode ? (exec ? '100755' : '100644') : (b && (b.mode === '100755' || b.mode === '100644') ? b.mode : '100644');
      } else {
        files.push({ path: p, status: b ? 'M' : ign ? '!' : 'A', ...(b ? { baseMode: b.mode, baseOid: b.oid } : {}), unreadable: 'not a regular file or symlink' });
        continue;
      }
    } catch (err) {
      files.push({ path: p, status: b ? 'M' : ign ? '!' : 'A', ...(b ? { baseMode: b.mode, baseOid: b.oid } : {}), unreadable: `read failed: ${(err as NodeJS.ErrnoException).code ?? 'error'}` });
      continue;
    }
    const oid = gitOid(safety.objectFormat, bytes);
    const sha = sha256(bytes);
    if (basename(p) === '.gitattributes' || p === '.gitmodules') attrTexts.push({ path: p, text: bytes.toString('utf8') });
    if (b && b.mode === mode && b.oid === oid) continue;
    let stamp: string | undefined;
    if (ign) {
      // The metadata is stamped BEFORE the baseline exemption: same bytes with another type, mode or link
      // identity is not the baselined file.
      stamp = ignoredStamp(sha, { kind: symlink ? 'symlink' : 'file', perm: st.mode & 0o7777, link: st.nlink > 1 ? `${st.dev}:${st.ino}` : null });
      ignored[p] = stamp;
      if (o.ignoredBaseline && o.ignoredBaseline.entries[ignoredPathKey(p)] === stamp) continue;
    }
    const rec: FileRecord = {
      path: p,
      status: b ? 'M' : ign ? '!' : 'A',
      mode,
      ...(b ? { baseMode: b.mode, baseOid: b.oid } : {}),
      sha256: sha,
      oid,
      bytes: bytes.length,
      ...(symlink ? { symlink } : {}),
      ...(st.nlink > 1 ? { nlink: st.nlink } : {}),
      binary: !symlink && isBinary(bytes),
      ...(stamp ? { stamp } : {}),
    };
    files.push(rec);
    if (rec.status !== '!') content.set(p, bytes);
  }

  // Base-tree attribute files are checked too: they apply even when unchanged.
  for (const [p, e] of baseEntries) {
    if ((basename(p) === '.gitattributes' || p === '.gitmodules') && !attrTexts.some((a) => a.path === p)) {
      attrTexts.push({ path: p, text: await hostGit(dir, ['cat-file', 'blob', e.oid], { signal }) });
    }
  }
  for (const a of attrTexts) {
    if (a.path === '.gitmodules' ? DANGEROUS_MODULES.test(a.text) : DANGEROUS_ATTR.test(a.text)) problems.push(`${a.path} sets attributes that make git transform content or run commands`);
  }
  if (problems.length) throw new UnsafeRepo(problems);

  // Baseline ∪ present: a baselined ignored file that is no longer there is a change too.
  if (o.ignoredBaseline) {
    for (const key of Object.keys(o.ignoredBaseline.entries).sort()) {
      if (presentIgnored.has(key)) continue;
      const name = o.ignoredBaseline.names?.[key];
      files.push({ path: typeof name === 'string' && name ? name : `<ignored ${key.slice(0, 16)}>`, status: '!', deleted: true, pathKey: key });
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  const fingerprint = digest({
    v: 4,
    head,
    baseCommit,
    // A deleted baseline entry is fingerprinted by its key, never by its (display) name.
    files: files.map((f) => [f.deleted ? `<deleted ${f.pathKey}>` : f.path, f.status, f.mode ?? null, f.oid ?? null, f.sha256 ?? null, f.unreadable ?? null, f.stamp ?? null]),
    ignored: Object.keys(ignored)
      .sort()
      .map((k) => [k, ignored[k]!]),
  });
  return { fingerprint, head, baseCommit, baseTree, safety, files, ignored, content, baseEntries };
}

const recordKey = (f: FileRecord): string => f.pathKey ?? ignoredPathKey(f.path);

/**
 * The per-file record that evidence stores and the commit gate compares (content digests, not names).
 * `pathKey` is the stable key the comparison uses, so a name the redactor rewrote in persisted evidence
 * still matches after a restart; `path` is for display only.
 */
export function fileManifest(c: Candidate): Json {
  return c.files.map((f) => ({ path: f.path, pathKey: recordKey(f), status: f.status, mode: f.mode ?? null, sha256: f.sha256 ?? null, oid: f.oid ?? null, bytes: f.bytes ?? null, ...(f.deleted ? { deleted: true } : {}), ...(f.stamp ? { stamp: f.stamp } : {}) }));
}

/**
 * Paths whose {status, mode, sha256, oid, stamp} differ between a recorded manifest and the candidate now
 * (compared by pathKey; a record without one is compared by its path). null = not a manifest.
 */
export function manifestMismatch(recorded: Json | undefined, c: Candidate): string[] | null {
  if (!Array.isArray(recorded)) return null;
  const now = new Map(c.files.map((f) => [recordKey(f), f]));
  const seen = new Set<string>();
  const bad: string[] = [];
  for (const r of recorded) {
    if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.path !== 'string') return null;
    const key = typeof r.pathKey === 'string' && /^[0-9a-f]{64}$/.test(r.pathKey) ? r.pathKey : ignoredPathKey(r.path);
    if (seen.has(key)) return null;
    seen.add(key);
    const f = now.get(key);
    const stamp = typeof r.stamp === 'string' ? r.stamp : null;
    if (!f || f.status !== r.status || (f.mode ?? null) !== r.mode || (f.sha256 ?? null) !== r.sha256 || (f.oid ?? null) !== r.oid || (f.deleted === true) !== (r.deleted === true) || (f.stamp ?? null) !== stamp) bad.push(f?.path ?? r.path);
  }
  for (const [k, f] of now) if (!seen.has(k)) bad.push(f.path);
  return bad;
}

/** policy's Change shape for enforceChanges / tamperFindings. New files are 'A', ignored '!'. */
export function policyChanges(c: Candidate): Change[] {
  // A deleted baseline entry stays '!' (enforceChanges refuses every ignored change).
  return c.files.map((f) => ({
    path: f.path,
    status: f.status,
    ...(f.symlink ? { symlink: true } : {}),
    ...(f.bytes !== undefined ? { bytes: f.bytes } : {}),
    ...(f.baseMode && f.mode && f.baseMode !== f.mode ? { modeChanged: true } : {}),
    ...(f.binary ? { binary: true } : {}),
  }));
}

/** Added lines per changed text file: new files entirely, modified files as a line-multiset difference. */
export async function addedLines(dir: string, c: Candidate, signal?: AbortSignal): Promise<Hunk[]> {
  const out: Hunk[] = [];
  for (const f of c.files) {
    if ((f.status !== 'A' && f.status !== 'M') || f.binary || f.symlink || f.unreadable) continue;
    const now = c.content.get(f.path)!.toString('utf8').split('\n');
    if (f.status === 'A' || !f.baseOid) {
      out.push({ path: f.path, added: now });
      continue;
    }
    const before = (await hostGit(dir, ['cat-file', 'blob', f.baseOid], { signal })).split('\n');
    const pool = new Map<string, number>();
    for (const l of before) pool.set(l, (pool.get(l) ?? 0) + 1);
    const added: string[] = [];
    for (const l of now) {
      const n = pool.get(l) ?? 0;
      if (n > 0) pool.set(l, n - 1);
      else added.push(l);
    }
    out.push({ path: f.path, added });
  }
  return out;
}

export interface BuiltTree {
  tree: string;
  /** Full expected tree (path → {mode, oid}): base entries patched with every committable change. */
  entries: Map<string, { mode: string; oid: string }>;
}

/**
 * Build the candidate tree from the host-read bytes only (`beforeWrite`, when given, runs right before
 * each object write, e.g. WriteGuard.check): a private index seeded from the base tree,
 * every A/M blob written with `hash-object -w --no-filters --stdin` (its oid must equal the recorded
 * one), deletions removed, `write-tree`, and the written tree listed back and compared entry by entry.
 * Ignored files are never part of it. Throws on any mismatch.
 */
export async function buildCandidateTree(dir: string, c: Candidate, signal?: AbortSignal, beforeWrite?: () => void): Promise<BuiltTree> {
  const entries = new Map(c.baseEntries);
  const info: string[] = [];
  const zero = c.safety.objectFormat === 'sha256' ? '0'.repeat(64) : '0'.repeat(40);
  for (const f of c.files) {
    if (f.status === '!') continue;
    if (f.unreadable) throw new Error(`cannot stage ${f.path}: ${f.unreadable}`);
    if (f.status === 'D') {
      entries.delete(f.path);
      info.push(`0 ${zero}\t${f.path}`);
      continue;
    }
    const bytes = c.content.get(f.path);
    if (!bytes || !f.oid || !f.mode) throw new Error(`no recorded content for ${f.path}`);
    // Object writes are repository mutations: the caller's fence is checked right before each one.
    beforeWrite?.();
    const oid = (await hostGit(dir, ['hash-object', '-w', '--no-filters', '--stdin'], { input: bytes, signal })).trim();
    if (oid !== f.oid) throw new Error(`blob for ${f.path} hashed to ${oid}, recorded ${f.oid}`);
    entries.set(f.path, { mode: f.mode, oid });
    info.push(`${f.mode} ${oid}\t${f.path}`);
  }
  const tmp = await mkdtemp(join(tmpdir(), 'tecera-gates-index-'));
  const env = { GIT_INDEX_FILE: join(tmp, 'index') };
  try {
    await hostGit(dir, ['read-tree', c.baseTree], { env, signal });
    if (info.length) await hostGit(dir, ['update-index', '-z', '--index-info'], { env, input: info.join('\0') + '\0', signal });
    beforeWrite?.();
    const tree = (await hostGit(dir, ['write-tree'], { env, signal })).trim();
    const written = await lsTree(dir, tree, signal);
    const diff: string[] = [];
    for (const [p, e] of entries) {
      const w = written.get(p);
      if (!w || w.mode !== e.mode || w.oid !== e.oid) diff.push(p);
    }
    for (const p of written.keys()) if (!entries.has(p)) diff.push(p);
    if (diff.length) throw new Error(`written tree differs from the recorded candidate at: ${diff.slice(0, 20).join(', ')}`);
    return { tree, entries };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Equal full trees (path → {mode, oid}). */
export function sameEntries(a: Map<string, { mode: string; oid: string }>, b: Map<string, { mode: string; oid: string }>): boolean {
  if (a.size !== b.size) return false;
  for (const [p, e] of a) {
    const x = b.get(p);
    if (!x || x.mode !== e.mode || x.oid !== e.oid) return false;
  }
  return true;
}
