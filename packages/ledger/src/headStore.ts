import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { LEDGER_HEAD_FORMAT, LedgerError, type LedgerHead, type LedgerHeadState, type LedgerHeadTransition } from '@tecera/contracts';

/**
 * The ledger head checkpoint (hardened mode): the latest acknowledged head of both hash chains, kept in a
 * directory the agent identity cannot write, next to a small journal of the one transition in flight.
 *
 * A write that changes either chain goes through these steps while it holds the database's write lock:
 *
 *   1. the database is compared with the checkpoint (admit): it must be exactly the acknowledged head, or
 *      the `from` of an abandoned transition whose `to` is the checkpoint (a writer that died before its
 *      commit); that case is rolled back to `from`. Anything else refuses the write;
 *   2. the rows are written (not yet committed);
 *   3. the journal `{from, to}` is written (head.pending.<generation>.json);
 *   4. the checkpoint is replaced by `to`;
 *   5. the database commits;
 *   6. the journal is removed.
 *
 * Steps 3 and 4 happen before the commit, inside the lock, so no other writer can interleave and every
 * reader holding a read transaction sees one of: database = checkpoint; or database = `from` and
 * checkpoint = `to` of a journal (in flight, or abandoned before its commit). A crash at any step leaves one
 * of those states, and recovery accepts exactly that recorded transition and nothing else. A database that
 * is shorter, longer, renumbered or another ledger than the checkpoint says is reported, never learned.
 *
 * Every file is written to a temporary name, synced and renamed into place (then the directory is synced),
 * so a file is either the old or the new one. Files are created with `fileMode` (default 0644).
 */

export type HeadBarrierPoint = 'admitted' | 'journal-written' | 'head-written' | 'committed' | 'settled';

export interface HeadStoreOptions {
  now?: () => number;
  /** Mode of the files written (default 0o644: readable by the agent identity, writable only by the owner). */
  fileMode?: number;
  /** Test seam: called at each step of a transition (a crash test kills the process there). Never set in production. */
  barrier?: (point: HeadBarrierPoint) => void;
}

const HEAD_FILE = 'head.json';
const JOURNAL = /^head\.pending\.(\d+)\.json$/;
const HASH = /^[0-9a-f]{64}$/;

export class HeadError extends LedgerError {
  constructor(message: string) {
    super(`ledger head checkpoint: ${message}`, 'chain');
    this.name = 'HeadError';
  }
}

/** The database-derived fields of `h` equal `d`. */
export function headMatches(h: LedgerHead, d: LedgerHeadState): boolean {
  return h.ledgerId === d.ledgerId && h.eventCount === d.eventCount && h.eventHeadHash === d.eventHeadHash && h.evidenceCount === d.evidenceCount && h.evidenceHeadHash === d.evidenceHeadHash;
}

function sameHead(a: LedgerHead, b: LedgerHead): boolean {
  return headMatches(a, b) && a.generation === b.generation && a.formatVersion === b.formatVersion;
}

function describe(d: LedgerHeadState | LedgerHead): string {
  return `${d.eventCount} event(s) ending ${d.eventHeadHash.slice(0, 12)}, ${d.evidenceCount} evidence row(s) ending ${d.evidenceHeadHash.slice(0, 12)}, ledger ${d.ledgerId ?? '(not enrolled)'}`;
}

/** Parse and validate a head; throws HeadError on anything but a well-formed head of this format. */
export function parseHead(raw: unknown, where: string): LedgerHead {
  const h = raw as Partial<LedgerHead> | null;
  const count = (n: unknown): boolean => typeof n === 'number' && Number.isInteger(n) && n >= 0;
  if (!h || typeof h !== 'object' || Array.isArray(h)) throw new HeadError(`${where} is not an object`);
  if (h.formatVersion !== LEDGER_HEAD_FORMAT) throw new HeadError(`${where} has format ${String(h.formatVersion)}, expected ${LEDGER_HEAD_FORMAT}`);
  if (typeof h.ledgerId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(h.ledgerId)) throw new HeadError(`${where} names no ledger id`);
  if (!count(h.eventCount) || !count(h.evidenceCount) || !count(h.generation)) throw new HeadError(`${where} has an invalid count or generation`);
  if (typeof h.eventHeadHash !== 'string' || !HASH.test(h.eventHeadHash) || typeof h.evidenceHeadHash !== 'string' || !HASH.test(h.evidenceHeadHash)) throw new HeadError(`${where} has an invalid head hash`);
  if (h.baseline !== 'genesis' && h.baseline !== 'legacy') throw new HeadError(`${where} has no baseline`);
  if (typeof h.enrolledAt !== 'number' || typeof h.at !== 'number') throw new HeadError(`${where} has no timestamps`);
  return { ledgerId: h.ledgerId, formatVersion: h.formatVersion, eventCount: h.eventCount!, eventHeadHash: h.eventHeadHash, evidenceCount: h.evidenceCount!, evidenceHeadHash: h.evidenceHeadHash, generation: h.generation!, baseline: h.baseline, enrolledAt: h.enrolledAt, at: h.at };
}

export class HeadStore {
  private readonly now: () => number;
  private readonly mode: number;
  private readonly barrier: (p: HeadBarrierPoint) => void;

  constructor(
    readonly dir: string,
    opts: HeadStoreOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.mode = opts.fileMode ?? 0o644;
    this.barrier = opts.barrier ?? (() => undefined);
  }

  get headPath(): string {
    return join(this.dir, HEAD_FILE);
  }

  /** Whether a checkpoint file exists (a link or anything but a regular file counts, and is refused on read). */
  exists(): boolean {
    try {
      lstatSync(this.headPath);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new HeadError(`${this.headPath} cannot be checked (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
    }
  }

  private readJson(path: string, where: string): unknown {
    let st;
    try {
      st = lstatSync(path);
    } catch (e) {
      throw new HeadError(`${where} cannot be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
    }
    if (!st.isFile() || st.nlink !== 1) throw new HeadError(`${where} is not a regular file with one link`);
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      throw new HeadError(`${where} is not readable JSON (${(e as Error).message})`);
    }
  }

  /** The acknowledged head, or null when there is no checkpoint file. A malformed one throws. */
  read(): LedgerHead | null {
    if (!this.exists()) return null;
    return parseHead(this.readJson(this.headPath, HEAD_FILE), HEAD_FILE);
  }

  /** The journals of transitions in flight (normally none; at most one outside a write). Malformed ones throw. */
  pending(): Array<{ file: string; t: LedgerHeadTransition }> {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (e) {
      throw new HeadError(`${this.dir} cannot be listed (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
    }
    const out: Array<{ file: string; t: LedgerHeadTransition }> = [];
    for (const n of names.sort()) {
      const m = JOURNAL.exec(n);
      if (!m) continue;
      const raw = this.readJson(join(this.dir, n), n) as { from?: unknown; to?: unknown } | null;
      if (!raw || typeof raw !== 'object') throw new HeadError(`${n} is not a transition`);
      const t = { from: parseHead(raw.from, `${n} (from)`), to: parseHead(raw.to, `${n} (to)`) };
      if (t.to.generation !== t.from.generation + 1 || String(t.to.generation) !== m[1] || t.to.ledgerId !== t.from.ledgerId) throw new HeadError(`${n} is not a transition of one generation`);
      out.push({ file: join(this.dir, n), t });
    }
    return out;
  }

  /** Write `body` to `name` atomically (temp file, fsync, rename, fsync of the directory). */
  private writeAtomic(name: string, body: unknown): void {
    const tmp = join(this.dir, `.${name}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
    const fd = openSync(tmp, 'wx', this.mode);
    try {
      writeSync(fd, `${JSON.stringify(body, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, join(this.dir, name));
    this.syncDir();
  }

  private syncDir(): void {
    let fd: number | undefined;
    try {
      fd = openSync(this.dir, 'r');
      fsyncSync(fd);
    } catch {
      /* a directory fsync is best effort on filesystems that refuse it */
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private remove(file: string): void {
    try {
      unlinkSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    this.syncDir();
  }

  /**
   * Reader's check (no writes): null when `d`, read inside one read transaction of the database, is the
   * acknowledged head or the `from` of a journalled transition whose `to` is the checkpoint; else why not.
   */
  check(d: LedgerHeadState): string | null {
    let head: LedgerHead | null;
    let journals: Array<{ file: string; t: LedgerHeadTransition }>;
    try {
      head = this.read();
      journals = this.pending();
    } catch (e) {
      return (e as Error).message.replace(/^ledger head checkpoint: /, '');
    }
    if (!head) return d.ledgerId ? `the ledger ${d.ledgerId} is enrolled but its checkpoint is missing` : 'the ledger is not enrolled (no checkpoint)';
    if (headMatches(head, d)) {
      const junk = journals.find((j) => !headMatches(j.t.from, d) && !headMatches(j.t.to, d));
      return junk ? `a pending transition (${junk.file}) matches neither the database nor the checkpoint` : null;
    }
    if (journals.some((j) => sameHead(j.t.to, head!) && headMatches(j.t.from, d))) return null;
    return mismatch(head, d);
  }

  /**
   * Writer's admission, called with the database write lock held: settles what an earlier writer left (a
   * committed transition whose journal was not removed; one abandoned before its commit, rolled back to its
   * `from`), then returns the acknowledged head, which equals `d`. Throws HeadError otherwise.
   */
  admit(d: LedgerHeadState): LedgerHead {
    const head = this.read();
    if (!head) throw new HeadError(d.ledgerId ? `the ledger ${d.ledgerId} is enrolled but its checkpoint is missing; refusing to write` : 'the ledger is not enrolled (no checkpoint); enroll it first');
    const journals = this.pending();
    if (headMatches(head, d)) {
      for (const j of journals) {
        if (!headMatches(j.t.from, d) && !headMatches(j.t.to, d)) throw new HeadError(`a pending transition (${j.file}) matches neither the database nor the checkpoint; refusing to write`);
        this.remove(j.file);
      }
      this.barrier('admitted');
      return head;
    }
    const abandoned = journals.find((j) => sameHead(j.t.to, head) && headMatches(j.t.from, d));
    if (!abandoned) throw new HeadError(`${mismatch(head, d)}; refusing to write`);
    // A writer died after moving the checkpoint and before its commit: the database is at `from`.
    this.writeAtomic(HEAD_FILE, abandoned.t.from);
    for (const j of journals) this.remove(j.file);
    this.barrier('admitted');
    return abandoned.t.from;
  }

  /**
   * Steps 3 and 4 for a write that took the database from `from` to `d` (not yet committed). Null when
   * neither chain changed (nothing to record).
   */
  stage(from: LedgerHead, d: LedgerHeadState): LedgerHeadTransition | null {
    if (headMatches(from, d)) return null;
    if (d.ledgerId !== from.ledgerId) throw new HeadError('the ledger id changed inside a write');
    const to: LedgerHead = { ...from, eventCount: d.eventCount, eventHeadHash: d.eventHeadHash, evidenceCount: d.evidenceCount, evidenceHeadHash: d.evidenceHeadHash, generation: from.generation + 1, at: this.now() };
    const t = { from, to };
    this.writeAtomic(`head.pending.${to.generation}.json`, t);
    this.barrier('journal-written');
    this.writeAtomic(HEAD_FILE, to);
    this.barrier('head-written');
    return t;
  }

  /** Step 6, after the commit. */
  settle(t: LedgerHeadTransition): void {
    this.barrier('committed');
    this.remove(join(this.dir, `head.pending.${t.to.generation}.json`));
    this.barrier('settled');
  }

  /** The commit failed: put the checkpoint back to `from`. If this fails too, the next writer recovers it. */
  abort(t: LedgerHeadTransition): void {
    try {
      this.writeAtomic(HEAD_FILE, t.from);
      this.remove(join(this.dir, `head.pending.${t.to.generation}.json`));
    } catch {
      /* left for admit() */
    }
  }

  /** Write the first checkpoint for `d` (enrollment). Refuses when one exists. */
  enroll(d: LedgerHeadState, baseline: LedgerHead['baseline']): LedgerHead {
    if (this.exists()) throw new HeadError('a checkpoint already exists; a ledger is enrolled once');
    if (!d.ledgerId) throw new HeadError('the ledger has no id to enroll');
    const at = this.now();
    const head: LedgerHead = { ledgerId: d.ledgerId, formatVersion: LEDGER_HEAD_FORMAT, eventCount: d.eventCount, eventHeadHash: d.eventHeadHash, evidenceCount: d.evidenceCount, evidenceHeadHash: d.evidenceHeadHash, generation: 0, baseline, enrolledAt: at, at };
    this.writeAtomic(HEAD_FILE, head);
    return head;
  }
}

function mismatch(head: LedgerHead, d: LedgerHeadState): string {
  if (d.ledgerId !== head.ledgerId) return `the database is not the enrolled ledger (database ${d.ledgerId ?? 'has no ledger id'}, checkpoint ${head.ledgerId}): replaced`;
  const what: string[] = [];
  if (d.eventCount < head.eventCount) what.push(`${head.eventCount - d.eventCount} acknowledged event(s) are missing`);
  else if (d.eventCount > head.eventCount) what.push(`${d.eventCount - head.eventCount} event(s) were never acknowledged`);
  else if (d.eventHeadHash !== head.eventHeadHash) what.push('the last event is not the acknowledged one');
  if (d.evidenceCount < head.evidenceCount) what.push(`${head.evidenceCount - d.evidenceCount} acknowledged evidence row(s) are missing`);
  else if (d.evidenceCount > head.evidenceCount) what.push(`${d.evidenceCount - head.evidenceCount} evidence row(s) were never acknowledged`);
  else if (d.evidenceHeadHash !== head.evidenceHeadHash) what.push('the last evidence row is not the acknowledged one');
  return `the database (${describe(d)}) does not match the checkpoint at generation ${head.generation} (${describe(head)}): ${what.join('; ') || 'mismatch'}`;
}
