import { requireWriteGuard, type Json, type ToolContext, type ToolRequest, type ToolResult, type WriteGuard } from '@tecera/contracts';
import { assertLease, assertMethod, assertWorktree, authorizeWriteVia, fail, ok, signalOf, ToolInputError, type AuthorizingTool, type ChangeAuthorizer } from './common.js';
import { checkEdit, type EditCheck } from './codeCheck.js';
import { matchesAny, matchesProtected } from './glob.js';
import { resolveInWorktree, writeInWorktree, type Resolved, type WriteOptions } from './paths.js';

/**
 * edit: writes files (delete.ts removes them; no other tool changes the repository). Refuses without a worktree or a lease fencing token, refuses paths
 * outside capabilities.paths.write or inside capabilities.paths.protected (evaluated on the RESOLVED
 * worktree-relative path, protected globs case-insensitively), refuses any symlink in the path, hardlinked
 * targets and .git/.tecera, and writes through descriptor-relative O_NOFOLLOW opens (see paths.ts).
 * Two forms: {path, oldText, newText} replaces exactly one occurrence (zero or many is an error, never a
 * guess); {path, content} (or writeFile(path, content)) writes the whole file.
 *
 * Content checks (codeCheck.ts) run on the resulting content of every edit of a JS/TS-family file, before
 * the write is authorized or anything is created: content that does not parse is refused with the
 * parser's message and line, and an edit of an existing module that drops one of its exported names is
 * refused unless the request lists that name in removeExports (recorded in the result). Both are host-side
 * static checks; the content is never executed.
 *
 * Fencing (contracts WriteGuard, Tool.call's third argument): without a guard every write is refused.
 * The guard is checked immediately before every mutation syscall (see writeInWorktree), and the exact write
 * ({path, sha256 of the bytes}) is authorized through guard.authorizeWrite before anything is created:
 * only 'allowed' writes. D6: writes inside paths.write proceed without approval under any isolation, so a
 * guard answering 'needs-approval' or 'approved' is refused (WriteRefused; nothing is written).
 */

export interface EditToolOptions {
  maxBytes?: number;
  /** A further check on the resolved path of every write (the step's declared change paths). Throws to refuse. */
  authorizeChange?: ChangeAuthorizer;
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

type EditArgs = { path: unknown; oldText?: unknown; newText?: unknown; content?: unknown; removeExports?: unknown };

const MAX_REMOVE_EXPORTS = 200;

function parseArgs(args: Json[]): EditArgs {
  const [a, b, c] = args;
  if (typeof a === 'string') {
    if (typeof b !== 'string') throw new ToolInputError('writeFile(path, content) needs string content');
    if (c === undefined) return { path: a, content: b };
    if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some((k) => k !== 'removeExports')) throw new ToolInputError('writeFile(path, content, options): options may only hold removeExports');
    return { path: a, content: b, removeExports: (c as { removeExports?: Json }).removeExports };
  }
  if (a && typeof a === 'object' && !Array.isArray(a)) return a as EditArgs;
  throw new ToolInputError('edit expects {path, oldText, newText} or {path, content}');
}

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

function authorizeRel(rel: string, ctx: ToolContext, extra?: ChangeAuthorizer): void {
  const prot = matchesProtected(rel, ctx.capabilities.paths.protected);
  if (prot) throw new ToolInputError(`${rel} is protected by ${prot}`);
  if (!matchesAny(rel, ctx.capabilities.paths.write)) throw new ToolInputError(`${rel} is outside the write allowlist`);
  extra?.(rel, 'write', ctx);
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
  if (a.removeExports !== undefined) {
    const r = a.removeExports;
    if (!Array.isArray(r) || r.length > MAX_REMOVE_EXPORTS || r.some((n) => typeof n !== 'string' || n.length === 0 || n.length > 256)) {
      throw new ToolInputError(`removeExports must be an array of at most ${MAX_REMOVE_EXPORTS} non-empty export names`);
    }
  }
  return a;
}

function writeOptions(maxBytes: number, mode: 'replace' | 'write', ctx: ToolContext, guard: WriteGuard, o: EditToolOptions): WriteOptions {
  const signal = signalOf(ctx);
  return {
    maxBytes,
    mode,
    guard,
    authorize: (rel) => authorizeRel(rel, ctx, o.authorizeChange),
    beforeWrite: (w) => authorizeWriteVia(guard, ctx, w),
    ...(signal ? { signal } : {}),
    ...(o.beforeOpen ? { beforeOpen: o.beforeOpen } : {}),
    ...(o.afterRead ? { afterRead: o.afterRead } : {}),
    ...(o.beforeData ? { beforeData: o.beforeData } : {}),
    ...(o.beforeCommit ? { beforeCommit: o.beforeCommit } : {}),
    ...(o.assumeNoProcFd ? { assumeNoProcFd: true } : {}),
  };
}

/** Exported names the edit intentionally removes from an existing JS/TS module (see codeCheck.ts). */
const REMOVE_EXPORTS_SCHEMA = { type: 'array', items: { type: 'string' }, maxItems: MAX_REMOVE_EXPORTS };

export function createEditTool(o: EditToolOptions = {}): AuthorizingTool {
  const maxBytes = o.maxBytes ?? 1024 * 1024;
  return {
    name: 'edit',
    methods: ['call'],
    risk: 'write',
    schema: {
      oneOf: [
        { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' }, removeExports: REMOVE_EXPORTS_SCHEMA }, required: ['path', 'oldText', 'newText'] },
        { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, removeExports: REMOVE_EXPORTS_SCHEMA }, required: ['path', 'content'] },
      ],
    },
    async authorize(req: ToolRequest, ctx: ToolContext): Promise<void> {
      const a = preconditions(req, ctx);
      const r = await resolveInWorktree(ctx.worktree, a.path, { forWrite: true });
      authorizeRel(r.rel, ctx, o.authorizeChange);
    },
    async call(req: ToolRequest, ctx: ToolContext, guard?: WriteGuard): Promise<ToolResult> {
      try {
        const g = requireWriteGuard(guard);
        const a = preconditions(req, ctx);
        const mode: 'replace' | 'write' = a.content !== undefined ? 'write' : 'replace';
        const removeExports = (a.removeExports as string[] | undefined) ?? [];
        let check: EditCheck | undefined;
        const w = await writeInWorktree(
          ctx.worktree,
          a.path,
          async (cur, rel) => {
            let next: string;
            if (mode === 'write') next = a.content as string;
            else {
              const old = a.oldText as string;
              const n = countOccurrences(cur ?? '', old);
              if (n !== 1) throw new ToolInputError(`oldText must occur exactly once in ${String(a.path)}; found ${n}`);
              const at = (cur ?? '').indexOf(old);
              next = (cur ?? '').slice(0, at) + (a.newText as string) + (cur ?? '').slice(at + old.length);
            }
            check = await checkEdit({ rel, before: cur, after: next, mode, removeExports });
            return next;
          },
          writeOptions(maxBytes, mode, ctx, g, o),
        );
        // writeInWorktree computes (and so checks) the content before anything is written.
        const c = check as EditCheck;
        const evidence: Record<string, Json> = { path: w.rel, bytes: w.bytes, digest: w.contentDigest, mode, created: w.created, fencingToken: ctx.fencingToken!, syntax: c.syntax };
        if (a.removeExports !== undefined) {
          evidence.removeExports = removeExports;
          evidence.removedExports = c.removedExports;
        }
        return ok(req, 'edit', evidence, { path: w.rel });
      } catch (e) {
        return fail(req, 'edit', e);
      }
    },
  };
}
