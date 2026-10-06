import { sha256, type ToolContext, type ToolRequest, type ToolResult } from '@tecera/contracts';
import { assertMethod, assertWorktree, fail, ok, pathArg, ToolInputError, type AuthorizingTool } from './common.js';
import { matchesAny } from './glob.js';
import { readInWorktree, resolveInWorktree, type Resolved } from './paths.js';

/**
 * read: one UTF-8 file inside the worktree. Confined by realpath; an in-worktree symlink may be read
 * through only when BOTH the lexical and the resolved path are inside capabilities.paths.read (an empty
 * read list denies everything); the file is read through an O_NOFOLLOW descriptor re-checked against the
 * worktree; capped in size. Content is returned as untrusted data.
 */

export interface ReadToolOptions {
  maxBytes?: number;
}

async function authorized(req: ToolRequest, ctx: ToolContext): Promise<Resolved> {
  assertMethod(req, ['call']);
  assertWorktree(ctx);
  const r = await resolveInWorktree(ctx.worktree, pathArg(req.args));
  for (const p of new Set([r.lexicalRel, r.rel])) if (!matchesAny(p, ctx.capabilities.paths.read)) throw new ToolInputError(`${p} is outside the read allowlist`);
  return r;
}

export function createReadTool(o: ReadToolOptions = {}): AuthorizingTool {
  const maxBytes = o.maxBytes ?? 1024 * 1024;
  return {
    name: 'read',
    methods: ['call'],
    risk: 'read',
    schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async authorize(req: ToolRequest, ctx: ToolContext): Promise<void> {
      await authorized(req, ctx);
    },
    async call(req: ToolRequest, ctx: ToolContext): Promise<ToolResult> {
      try {
        const r = await authorized(req, ctx);
        if (!r.exists) throw new ToolInputError(`no such file: ${r.lexicalRel}`);
        const buf = await readInWorktree(ctx.worktree, r, maxBytes);
        const binary = buf.includes(0);
        const content = binary ? '' : buf.toString('utf8');
        return ok(req, 'read', { path: r.rel, content, bytes: buf.length, digest: sha256(content), binary }, { path: r.rel });
      } catch (e) {
        return fail(req, 'read', e);
      }
    },
  };
}
