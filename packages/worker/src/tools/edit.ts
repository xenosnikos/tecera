import { requireWriteGuard, type Json, type ToolContext, type ToolRequest, type ToolResult, type WriteGuard } from '@tecera/contracts';
import { assertLease, assertMethod, assertWorktree, authorizeWriteVia, fail, ok, signalOf, ToolInputError, type AuthorizingTool } from './common.js';
import { matchesAny, matchesProtected } from './glob.js';
import { resolveInWorktree, writeInWorktree, type Resolved, type WriteOptions } from './paths.js';

/**
 * edit: the only repo-writing tool. Refuses without a worktree or a lease fencing token, refuses paths
 * outside capabilities.paths.write or inside capabilities.paths.protected (evaluated on the RESOLVED
 * worktree-relative path, protected globs case-insensitively), refuses any symlink in the path, hardlinked
 * targets and .git/.tecera, and writes through descriptor-relative O_NOFOLLOW opens (see paths.ts).
 * Two forms: {path, oldText, newText} replaces exactly one occurrence (zero or many is an error, never a
 * guess); {path, content} (or writeFile(path, content)) writes the whole file.
 *
 * Fencing (contracts WriteGuard, Tool.call's third argument): without a guard every write is refused.
 * The guard is checked immediately before every mutation syscall (see writeInWorktree), and the exact write
 * ({path, sha256 of the bytes}) is authorized through guard.authorizeWrite before anything is created:
 * only 'allowed' writes. D6: writes inside paths.write proceed without approval under any isolation, so a
 * guard answering 'needs-approval' or 'approved' is refused (WriteRefused; nothing is written).
 */

export interface EditToolOptions {
  maxBytes?: number;
  /** Test seam: runs after the path check, before the directory chain is opened (race tests). */
  beforeOpen?: (r: Resolved) => Promise<void>;
  /** Test seam: runs after the current content was read through the verified descriptor (race tests). */
  afterRead?: (r: Resolved) => Promise<void>;
  /** Test seam: runs after the temp file was created and verified, before its data is written. */
  beforeData?: (r: Resolved) => Promise<void>;
  /** Test seam: runs synchronously immediately before the commit (post-commit verification tests). */
  beforeCommit?: (r: Resolved) => void;
  /** Test seam: behave as on a platform without /proc/self/fd. */
  assumeNoProcFd?: boolean;
}

type EditArgs = { path: unknown; oldText?: unknown; newText?: unknown; content?: unknown };

function parseArgs(args: Json[]): EditArgs {
  const [a, b] = args;
  if (typeof a === 'string') {
    if (typeof b !== 'string') throw new ToolInputError('writeFile(path, content) needs string content');
    return { path: a, content: b };
  }
  if (a && typeof a === 'object' && !Array.isArray(a)) return a as EditArgs;
  throw new ToolInputError('edit expects {path, oldText, newText} or {path, content}');
}

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

function authorizeRel(rel: string, ctx: ToolContext): void {
  const prot = matchesProtected(rel, ctx.capabilities.paths.protected);
  if (prot) throw new ToolInputError(`${rel} is protected by ${prot}`);
  if (!matchesAny(rel, ctx.capabilities.paths.write)) throw new ToolInputError(`${rel} is outside the write allowlist`);
}

function preconditions(req: ToolRequest, ctx: ToolContext): EditArgs {
  assertMethod(req, ['call']);
  assertWorktree(ctx);
  assertLease(ctx, 'edit');
  const a = parseArgs(req.args);
  if (a.content !== undefined) {
    if (typeof a.content !== 'string') throw new ToolInputError('content must be a string');
    if (a.oldText !== undefined || a.newText !== undefined) throw new ToolInputError('use either content or oldText/newText, not both');
  } else {
    if (typeof a.oldText !== 'string' || typeof a.newText !== 'string') throw new ToolInputError('oldText and newText must be strings');
    if (a.oldText.length === 0) throw new ToolInputError('oldText must not be empty');
  }
  return a;
}

function writeOptions(maxBytes: number, mode: 'replace' | 'write', ctx: ToolContext, guard: WriteGuard, o: EditToolOptions): WriteOptions {
  const signal = signalOf(ctx);
  return {
    maxBytes,
    mode,
    guard,
    authorize: (rel) => authorizeRel(rel, ctx),
    beforeWrite: (w) => authorizeWriteVia(guard, ctx, w),
    ...(signal ? { signal } : {}),
    ...(o.beforeOpen ? { beforeOpen: o.beforeOpen } : {}),
    ...(o.afterRead ? { afterRead: o.afterRead } : {}),
    ...(o.beforeData ? { beforeData: o.beforeData } : {}),
    ...(o.beforeCommit ? { beforeCommit: o.beforeCommit } : {}),
    ...(o.assumeNoProcFd ? { assumeNoProcFd: true } : {}),
  };
}

export function createEditTool(o: EditToolOptions = {}): AuthorizingTool {
  const maxBytes = o.maxBytes ?? 1024 * 1024;
  return {
    name: 'edit',
    methods: ['call'],
    risk: 'write',
    schema: {
      oneOf: [
        { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } }, required: ['path', 'oldText', 'newText'] },
        { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      ],
    },
    async authorize(req: ToolRequest, ctx: ToolContext): Promise<void> {
      const a = preconditions(req, ctx);
      const r = await resolveInWorktree(ctx.worktree, a.path, { forWrite: true });
      authorizeRel(r.rel, ctx);
    },
    async call(req: ToolRequest, ctx: ToolContext, guard?: WriteGuard): Promise<ToolResult> {
      try {
        const g = requireWriteGuard(guard);
        const a = preconditions(req, ctx);
        const mode: 'replace' | 'write' = a.content !== undefined ? 'write' : 'replace';
        const w = await writeInWorktree(
          ctx.worktree,
          a.path,
          (cur) => {
            if (mode === 'write') return a.content as string;
            const old = a.oldText as string;
            const n = countOccurrences(cur ?? '', old);
            if (n !== 1) throw new ToolInputError(`oldText must occur exactly once in ${String(a.path)}; found ${n}`);
            const at = (cur ?? '').indexOf(old);
            return (cur ?? '').slice(0, at) + (a.newText as string) + (cur ?? '').slice(at + old.length);
          },
          writeOptions(maxBytes, mode, ctx, g, o),
        );
        return ok(req, 'edit', { path: w.rel, bytes: w.bytes, digest: w.contentDigest, mode, created: w.created, fencingToken: ctx.fencingToken! }, { path: w.rel });
      } catch (e) {
        return fail(req, 'edit', e);
      }
    },
  };
}
