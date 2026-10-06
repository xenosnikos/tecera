import { mkdirSync } from 'node:fs';
import { inspectPath, safeReadFile, safeWriteFile, UnsafePathError, walkTree } from './util/safefs.js';

/**
 * A write plan over the real tree. Commands that write several files (init, adapters install) stage every
 * write here first; reads see staged content, so later steps build on earlier ones. `--dry-run` prints
 * `ops` and never calls `apply`. Unchanged content is not a write.
 *
 * Containment (util/safefs.ts): every read, existence check, listing and write resolves below the real root
 * segment by segment and refuses symbolic links (live or dangling), resolution failures and hard-linked
 * targets. A refused path throws UnsafePathError; nothing falls back to the lexical path.
 */

export type OpAction = 'create' | 'update' | 'skip';

export interface FileOp {
  path: string;
  action: OpAction;
  kind: string;
  note?: string;
}

export class PlannedFs {
  readonly ops: FileOp[] = [];
  private readonly staged = new Map<string, Buffer>();

  constructor(readonly root: string) {}

  readBuffer(rel: string): Buffer | undefined {
    const s = this.staged.get(rel);
    if (s) return s;
    return safeReadFile(this.root, rel);
  }

  read(rel: string): string | undefined {
    return this.readBuffer(rel)?.toString('utf8');
  }

  exists(rel: string): boolean {
    return this.staged.has(rel) || inspectPath(this.root, rel).exists;
  }

  /** Files under `dir` (relative to root), staged or on disk. A link or unreadable entry under `dir` throws. */
  list(dir: string): string[] {
    const info = inspectPath(this.root, dir);
    const out = new Set<string>();
    if (info.exists) {
      if (info.kind !== 'dir') throw new UnsafePathError(`${dir} is not a directory`, dir);
      const w = walkTree(info.abs);
      if (w.links.length) throw new UnsafePathError(`${dir}/${w.links[0]} is a symbolic link; refusing to follow it`, `${dir}/${w.links[0]}`);
      if (w.special.length) throw new UnsafePathError(`${dir}/${w.special[0]} is not a regular file`, `${dir}/${w.special[0]}`);
      if (w.errors.length) throw new UnsafePathError(`${dir}/${w.errors[0]!.path}: cannot be read (${w.errors[0]!.error})`, `${dir}/${w.errors[0]!.path}`);
      for (const f of w.files) out.add(`${dir}/${f}`);
    }
    for (const k of this.staged.keys()) if (k.startsWith(`${dir}/`)) out.add(k);
    return [...out].sort();
  }

  write(rel: string, content: string | Buffer, kind: string, note?: string): FileOp | null {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const cur = this.readBuffer(rel);
    if (cur && cur.equals(buf)) return null;
    const op: FileOp = { path: rel, action: cur === undefined ? 'create' : 'update', kind, note };
    this.staged.set(rel, buf);
    const prev = this.ops.findIndex((o) => o.path === rel);
    if (prev >= 0) this.ops[prev] = { ...op, action: this.ops[prev]!.action === 'create' ? 'create' : op.action };
    else this.ops.push(op);
    return op;
  }

  skip(rel: string, kind: string, note: string): void {
    this.ops.push({ path: rel, action: 'skip', kind, note });
  }

  changes(): FileOp[] {
    return this.ops.filter((o) => o.action !== 'skip');
  }

  /** Write every staged file through the contained writer. Re-checks each path at write time. */
  apply(): void {
    mkdirSync(this.root, { recursive: true });
    for (const [rel, buf] of this.staged) safeWriteFile(this.root, rel, buf);
    this.staged.clear();
  }
}

