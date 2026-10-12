import { requireWriteGuard, type Json, type ToolContext, type ToolRequest, type ToolResult, type WriteGuard } from '@tecera/contracts';
import { assertLease, assertMethod, assertWorktree, authorizeWriteVia, fail, ok, signalOf, ToolInputError, type AuthorizingTool, type ChangeAuthorizer } from './common.js';
import { matchesAny, matchesProtected } from './glob.js';
import { deleteInWorktree, resolveInWorktree, type DeleteOptions, type Resolved } from './paths.js';

/**
 * delete: removes one file from the worktree. It exists so that a worker can take back a file that should
 * not be part of the change (its own stray file, or one the contract says to remove); edit can only write.
 *
 * Same rules as edit: refused without a worktree or a lease fencing token, outside capabilities.paths.write,
 * inside capabilities.paths.protected (so a protected test or configuration file cannot be deleted), through
 * any symlink, on a hardlinked target and under .git/ or .tecera/; the directory chain is opened by
 * descriptor and identity-checked, the worktree lock is held, and a quarantined worktree refuses.
 *
 * Bound to what the worker read: {path, digest} (the digest readFile returned) or {path, content}, or
 * deleteFile(path, digest). The file is removed only while it still holds exactly that content, so a
 * deletion can never take a file the worker has not seen, or one that changed since. Only regular files:
 * a directory is refused, and nothing is deleted recursively.
 *
 * Fencing: without a guard every deletion is refused; the guard is checked immediately before the entry is
 * moved, and the exact deletion is authorized through guard.authorizeWrite first. Like a write, a deletion
 * inside paths.write needs no approval and never suspends the step: a guard that answers anything but
 * 'allowed' is refused.
 */

export interface DeleteToolOptions {
  /** Largest file the tool removes (it reads the content to compare it). Default 1 MiB. */
  maxBytes?: number;
  /** A further check on the resolved path of every deletion (the step's declared change paths). Throws to refuse. */
  authorizeChange?: ChangeAuthorizer;
  /** Test seam: runs after the path check, before the directory chain is opened (race tests). */
  beforeOpen?: (r: Resolved) => Promise<void>;
  /** Test seam: runs after the content was read through the verified descriptor and matched (race tests). */
  afterRead?: (r: Resolved) => Promise<void>;
  /** Test seam: runs synchronously immediately before the removal. */
  beforeCommit?: (r: Resolved) => void;
  /** Test seam: behave as on a platform without /proc/self/fd. */
  assumeNoProcFd?: boolean;
}

type DeleteArgs = { path: unknown; digest?: unknown; content?: unknown };

const DIGEST = /^[0-9a-f]{64}$/;

function parseArgs(args: Json[]): DeleteArgs {
  const [a, b] = args;
  if (typeof a === 'string') return { path: a, digest: b };
  if (a && typeof a === 'object' && !Array.isArray(a)) return a as DeleteArgs;
  throw new ToolInputError('delete expects {path, digest} or {path, content}');
}

function authorizeRel(rel: string, ctx: ToolContext, extra?: ChangeAuthorizer): void {
  const prot = matchesProtected(rel, ctx.capabilities.paths.protected);
  if (prot) throw new ToolInputError(`${rel} is protected by ${prot}`);
  if (!matchesAny(rel, ctx.capabilities.paths.write)) throw new ToolInputError(`${rel} is outside the write allowlist`);
  extra?.(rel, 'delete', ctx);
}

function preconditions(req: ToolRequest, ctx: ToolContext): { path: unknown; expected: DeleteOptions['expected'] } {
  assertMethod(req, ['call']);
  assertWorktree(ctx);
  assertLease(ctx, 'delete');
  const a = parseArgs(req.args);
  if ((a as { recursive?: unknown }).recursive !== undefined) throw new ToolInputError('delete removes one file; there is no recursive deletion');
  if (a.content !== undefined && a.digest !== undefined) throw new ToolInputError('use either digest or content, not both');
  if (a.content !== undefined) {
    if (typeof a.content !== 'string') throw new ToolInputError('content must be a string');
    return { path: a.path, expected: { content: a.content } };
  }
  if (typeof a.digest !== 'string' || !DIGEST.test(a.digest)) throw new ToolInputError('delete needs the digest (sha256, as readFile returns it) or the exact content of the file it removes: read the file first');
  return { path: a.path, expected: { digest: a.digest } };
}

export function createDeleteTool(o: DeleteToolOptions = {}): AuthorizingTool {
  const maxBytes = o.maxBytes ?? 1024 * 1024;
  return {
    name: 'delete',
    methods: ['call'],
    risk: 'write',
    schema: {
      oneOf: [
        { type: 'object', properties: { path: { type: 'string' }, digest: { type: 'string' } }, required: ['path', 'digest'] },
        { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
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
        const signal = signalOf(ctx);
        const d = await deleteInWorktree(ctx.worktree, a.path, {
          maxBytes,
          guard: g,
          expected: a.expected,
          authorize: (rel) => authorizeRel(rel, ctx, o.authorizeChange),
          beforeDelete: (w) => authorizeWriteVia(g, ctx, w),
          ...(signal ? { signal } : {}),
          ...(o.beforeOpen ? { beforeOpen: o.beforeOpen } : {}),
          ...(o.afterRead ? { afterRead: o.afterRead } : {}),
          ...(o.beforeCommit ? { beforeCommit: o.beforeCommit } : {}),
          ...(o.assumeNoProcFd ? { assumeNoProcFd: true } : {}),
        });
        return ok(req, 'delete', { path: d.rel, deleted: true, bytes: d.bytes, digest: d.contentDigest, fencingToken: ctx.fencingToken! }, { path: d.rel });
      } catch (e) {
        return fail(req, 'delete', e);
      }
    },
  };
}
