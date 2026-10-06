import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** Small synchronous filesystem helpers. Paths returned as repo-relative use forward slashes. */

export function toPosix(p: string): string {
  return p.split(sep).join('/');
}

export function rel(root: string, abs: string): string {
  return toPosix(relative(root, abs));
}

/** Walk up from `start` until `name` exists; return its absolute path or null. */
export function findUp(start: string, name: string): string | null {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readTextIf(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

export function sha256Bytes(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Every regular file under `dir` (recursive), as paths relative to `dir`, sorted. Skips names in `skip`. */
export function walkFiles(dir: string, skip: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  const visit = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      if (skip.has(name)) continue;
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(p);
      else if (st.isFile()) out.push(rel(dir, p));
    }
  };
  visit(dir);
  return out.sort();
}

/** Heuristic: a file is text when it has no NUL byte in its first 8 KiB. */
export function isText(buf: Buffer): boolean {
  return !buf.subarray(0, 8192).includes(0);
}
