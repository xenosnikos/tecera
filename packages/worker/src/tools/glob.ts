/**
 * Minimal gitignore-style glob matching for worktree-relative paths (`**`, `*`, `?`, `{a,b}`). A pattern
 * without a slash matches at any depth; a pattern with a slash is anchored at the worktree root. Kept
 * local to the worker (policy has its own copy; siblings never import each other).
 */

export function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+/g, '/').replace(/\/$/, '');
}

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string, caseInsensitive = false): RegExp {
  const ck = `${caseInsensitive ? 'i' : 's'}:${glob}`;
  const hit = cache.get(ck);
  if (hit) return hit;
  let g = normalizeRel(glob);
  const anchored = g.includes('/');
  if (g.startsWith('/')) g = g.slice(1);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slashAfter = g[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end === -1) re += '\\{';
      else {
        re += `(?:${g
          .slice(i + 1, end)
          .split(',')
          .map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
          .join('|')})`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  const full = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}$`, caseInsensitive ? 'i' : '');
  cache.set(ck, full);
  return full;
}

export function matchesGlob(path: string, glob: string, caseInsensitive = false): boolean {
  return globToRegExp(glob, caseInsensitive).test(normalizeRel(path));
}

/** First glob that matches, or null. */
export function matchesAny(path: string, globs: readonly string[]): string | null {
  for (const g of globs) if (matchesGlob(path, g)) return g;
  return null;
}

/**
 * Protected-path match: case-insensitive, so `TEST/a.test.ts` on a case-insensitive filesystem (DrvFs,
 * APFS, NTFS) cannot slip past `test/**`. Over-matching here only refuses more writes (fail closed).
 */
export function matchesProtected(path: string, globs: readonly string[]): string | null {
  for (const g of globs) if (matchesGlob(path, g, true)) return g;
  return null;
}

export const hasGlobChars = (s: string): boolean => /[*?{]/.test(s);
