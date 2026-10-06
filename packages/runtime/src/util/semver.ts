/**
 * Minimal semver range check for `runtime.tecera` (dx.md §2: a mismatch fails startup). Supports
 * comparators (>, >=, <, <=, =), caret, tilde, x-ranges, hyphen ranges and `||`. Anything it cannot
 * parse is treated as not satisfied (fail closed).
 */

type V = [number, number, number];

function parseVersion(v: string): V | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a: V, b: V): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

/** Partial version like `1`, `1.2`, `1.x`, `*` → lower bound and the number of fixed parts. */
function partial(p: string): { v: V; fixed: number } | null {
  const s = p.trim().replace(/^v/, '');
  if (s === '*' || s === 'x' || s === 'X' || s === '') return { v: [0, 0, 0], fixed: 0 };
  const parts = s.split('.');
  const nums: number[] = [];
  for (const part of parts.slice(0, 3)) {
    if (part === 'x' || part === 'X' || part === '*') break;
    if (!/^\d+$/.test(part)) return null;
    nums.push(Number(part));
  }
  const fixed = nums.length;
  while (nums.length < 3) nums.push(0);
  return { v: nums as V, fixed };
}

function bump(v: V, idx: number): V {
  const out: V = [...v] as V;
  out[idx]! += 1;
  for (let i = idx + 1; i < 3; i++) out[i] = 0;
  return out;
}

type Test = (v: V) => boolean;

function comparator(tok: string): Test[] | null {
  const m = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(tok)!;
  const op = m[1] ?? '';
  const p = partial(m[2]!);
  if (!p) return null;
  const { v, fixed } = p;
  if (op === '^') {
    const idx = v[0] > 0 || fixed <= 1 ? 0 : v[1] > 0 || fixed <= 2 ? 1 : 2;
    const hi = bump(v, idx);
    return [(x) => cmp(x, v) >= 0, (x) => cmp(x, hi) < 0];
  }
  if (op === '~') {
    const hi = bump(v, fixed >= 2 ? 1 : 0);
    return [(x) => cmp(x, v) >= 0, (x) => cmp(x, hi) < 0];
  }
  if (op === '' || op === '=') {
    if (fixed === 0) return [() => true];
    if (fixed === 3) return [(x) => cmp(x, v) === 0];
    const hi = bump(v, fixed - 1);
    return [(x) => cmp(x, v) >= 0, (x) => cmp(x, hi) < 0];
  }
  if (op === '>=') return [(x) => cmp(x, v) >= 0];
  if (op === '<') return [(x) => cmp(x, v) < 0];
  if (op === '>') return fixed === 3 ? [(x) => cmp(x, v) > 0] : [(x) => cmp(x, bump(v, Math.max(fixed - 1, 0))) >= 0];
  if (op === '<=') return fixed === 3 ? [(x) => cmp(x, v) <= 0] : [(x) => cmp(x, bump(v, Math.max(fixed - 1, 0))) < 0];
  return null;
}

export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  return range.split('||').some((set) => {
    const s = set.trim();
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(s);
    const toks = hyphen ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`] : s.split(/\s+/).filter(Boolean);
    if (toks.length === 0) return true;
    const tests: Test[] = [];
    for (const t of toks) {
      const c = comparator(t);
      if (!c) return false;
      tests.push(...c);
    }
    return tests.every((t) => t(v));
  });
}
