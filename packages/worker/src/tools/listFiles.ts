import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Json, Tool, ToolContext, ToolRequest, ToolResult } from '@tecera/contracts';
import { assertMethod, assertWorktree, fail, ok, ToolInputError } from './common.js';
import { hasGlobChars, matchesAny, matchesGlob, normalizeRel } from './glob.js';
import { resolveInWorktree } from './paths.js';

/**
 * listFiles: walk the worktree without following symlinks, skipping node_modules, .git and .tecera,
 * filtered by a prefix or a glob and by capabilities.paths.read. Bounded by maxEntries.
 */

export const LIST_IGNORES = new Set(['node_modules', '.git', '.tecera']);

export interface ListFilesOptions {
  maxEntries?: number;
}

function filterArg(args: Json[]): { pattern?: string; limit?: number } {
  const a = args[0];
  if (a === undefined || a === null) return {};
  if (typeof a === 'string') return { pattern: a };
  if (typeof a === 'object' && !Array.isArray(a)) {
    const o = a as { prefix?: Json; glob?: Json; limit?: Json };
    const pattern = typeof o.glob === 'string' ? o.glob : typeof o.prefix === 'string' ? o.prefix : undefined;
    return { pattern, limit: typeof o.limit === 'number' ? o.limit : undefined };
  }
  throw new ToolInputError('listFiles expects a prefix/glob string or {prefix|glob, limit}');
}

export function createListFilesTool(o: ListFilesOptions = {}): Tool {
  const maxEntries = o.maxEntries ?? 5000;
  return {
    name: 'listFiles',
    methods: ['call'],
    risk: 'read',
    schema: { type: 'object', properties: { prefix: { type: 'string' }, glob: { type: 'string' }, limit: { type: 'number' } } },
    async call(req: ToolRequest, ctx: ToolContext): Promise<ToolResult> {
      try {
        assertMethod(req, ['call']);
        assertWorktree(ctx);
        const { pattern, limit } = filterArg(req.args);
        const cap = Math.max(1, Math.min(limit ?? maxEntries, maxEntries));
        if (pattern !== undefined) {
          if (pattern.includes('..') || pattern.includes('\0') || pattern.startsWith('/')) throw new ToolInputError(`bad pattern: ${pattern}`);
        }
        const root = await resolveInWorktree(ctx.worktree, '.');
        const want = pattern === undefined ? null : normalizeRel(pattern);
        const files: string[] = [];
        let truncated = false;
        const walk = async (absDir: string, relDir: string): Promise<void> => {
          if (truncated) return;
          let entries;
          try {
            entries = await readdir(absDir, { withFileTypes: true });
          } catch {
            return;
          }
          entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
          for (const e of entries) {
            if (truncated) return;
            if (LIST_IGNORES.has(e.name)) continue;
            const rel = relDir ? `${relDir}/${e.name}` : e.name;
            if (e.isSymbolicLink()) continue;
            if (e.isDirectory()) {
              // Prune: a plain prefix that cannot match below this directory.
              if (want && !hasGlobChars(want) && !(want.startsWith(`${rel}/`) || rel.startsWith(want) || want === rel)) continue;
              await walk(join(absDir, e.name), rel);
            } else if (e.isFile()) {
              if (want && (hasGlobChars(want) ? !matchesGlob(rel, want) : !rel.startsWith(want))) continue;
              if (!matchesAny(rel, ctx.capabilities.paths.read)) continue;
              if (files.length >= cap) {
                truncated = true;
                return;
              }
              files.push(rel);
            }
          }
        };
        await walk(root.abs, '');
        return ok(req, 'listFiles', { files, truncated });
      } catch (e) {
        return fail(req, 'listFiles', e);
      }
    },
  };
}
