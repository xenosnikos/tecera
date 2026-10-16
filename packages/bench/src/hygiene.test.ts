import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECRET_PATTERNS } from '@tecera/contracts';
import { REPO_ROOT } from './runner.js';

/**
 * Tests and fixtures hold no literal a secret scanner would report. A value that must look like a vendor
 * key (to exercise a redaction pattern) or like a random credential (the registered secret) is assembled
 * at run time from parts, so the test still sees the same value and the source carries none.
 */

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const TEXT = /\.(ts|js|mjs|cjs|json|md|txt|ya?ml|sh|patch|env)$/;

/** Test sources, test helpers and fixtures across packages/, samples/ and templates/. */
function scanned(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (SKIP_DIRS.has(n)) continue;
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (TEXT.test(n)) {
        const rel = relative(REPO_ROOT, p);
        const fixtureLike = /(^|\/)(samples|templates)\//.test(rel) || /(^|\/)(fixtures|test-fixtures|testing|harness|scripted)\//.test(rel);
        if (fixtureLike || /\.test\.[cm]?[jt]s$/.test(n)) out.push(rel);
      }
    }
  };
  for (const top of ['packages', 'samples', 'templates']) walk(join(REPO_ROOT, top));
  return out;
}

const charClass = (c: string): string => (/[0-9]/.test(c) ? 'd' : /[A-Z]/.test(c) ? 'u' : /[a-z]/.test(c) ? 'l' : 's');

/** Digit/lower/upper alternations inside a token: random credentials alternate often, words and ids rarely. */
export function alternations(s: string): number {
  let n = 0;
  for (let i = 1; i < s.length; i++) {
    const a = charClass(s[i - 1]!);
    const b = charClass(s[i]!);
    if (a !== 's' && b !== 's' && a !== b) n++;
  }
  return n;
}

/** Quoted literals that look like a random credential. Digests (40 or 64 lowercase hex) are golden vectors, not secrets. */
export function randomLooking(text: string): string[] {
  const hits: string[] = [];
  for (const m of text.matchAll(/['"`]([A-Za-z0-9_-]{16,})['"`]/g)) {
    const s = m[1]!;
    if (s.startsWith('TECERA_CANARY_')) continue;
    if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(s)) continue;
    if (alternations(s) >= 8) hits.push(s);
  }
  return hits;
}

describe('secret-scanner hygiene of tests and fixtures', () => {
  it('the detectors catch what they are meant to catch', () => {
    expect(randomLooking(`x = '${['m4kq7h', 'x2p9w3ndt', '8bq5zr1cvya'].join('-')}'`)).toHaveLength(1);
    expect(randomLooking(`id: '${'gen-1791195101-' + ['Gzgs', 'LQkH', 'vvJG', '5s1m', 'jWPe'].join('')}'`)).toHaveLength(1);
    expect(randomLooking("'test-anthropic-credential-0123456789' 'f51f7f9ee322d84b28fa74e27fe52fefb4aa0a0362f35afce933109860ce425c'")).toEqual([]);
  });

  it('no test or fixture holds a vendor-key-shaped or random-looking literal', () => {
    const files = scanned();
    expect(files.length).toBeGreaterThan(50);
    const found: string[] = [];
    for (const f of files) {
      const text = readFileSync(join(REPO_ROOT, f), 'utf8');
      for (const p of SECRET_PATTERNS) {
        if (p.kind === 'canary') continue; // canaries are meant to be found
        const m = new RegExp(p.re.source, 'g');
        for (const hit of text.matchAll(m)) found.push(`${f}: ${p.kind} ${hit[0].slice(0, 12)}…`);
      }
      for (const s of randomLooking(text)) found.push(`${f}: random-looking ${s.slice(0, 12)}…`);
    }
    expect(found).toEqual([]);
  });
});
