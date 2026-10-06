/**
 * Minimal gitignore-style glob matching for repo-relative paths. Supports `**`, `*`, `?`, `{a,b}`.
 * A pattern without a slash matches at any depth (like gitignore); a pattern with a slash is
 * anchored to the repo root. Paths are normalised with forward slashes and no leading `./`.
 */

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

/** Why a path is unsafe to touch, or null. Port of EEZE guards._path. */
export function pathProblem(p: string): string | null {
  if (p.length === 0) return 'empty path';
  if (p.includes('\0')) return 'path contains NUL';
  if (p.includes('\\')) return 'path contains a backslash';
  if (p.startsWith('/')) return 'absolute path';
  if (/^[A-Za-z]:/.test(p)) return 'drive-letter path';
  const parts = p.split('/');
  if (parts.some((s) => s === '..')) return 'path traversal (..)';
  return null;
}

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let g = normalizePath(glob);
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
  const full = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}$`);
  cache.set(glob, full);
  return full;
}

export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(normalizePath(path));
}

export function matchesAny(path: string, globs: readonly string[]): string | null {
  for (const g of globs) if (matchesGlob(path, g)) return g;
  return null;
}

/** True when `inner` can only match paths that `outer` also matches, for the simple prefix forms we allow. */
export function globWithin(inner: string, outer: string): boolean {
  if (inner === outer) return true;
  const o = normalizePath(outer);
  const i = normalizePath(inner);
  if (o === '**' || o === '**/*') return false; // blanket outer is never a boundary
  if (o.endsWith('/**')) {
    const prefix = o.slice(0, -3);
    return i === prefix || i.startsWith(prefix + '/');
  }
  return i === o;
}
