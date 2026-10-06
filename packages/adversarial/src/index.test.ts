import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACCEPTANCE_INDEX, CASE_INDEX, DECISION_INDEX, SECTION6_IDS, type CaseEntry } from './index.js';
import { PACKAGES, REPO } from './harness/tmp.js';
import { expectGap, isKnownFailure, openGaps, STRICT } from './harness/gap.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const sources = (): Map<string, string> => new Map(readdirSync(HERE).filter((f) => f.endsWith('.test.ts')).map((f) => [`src/${f}`, readFileSync(join(HERE, f), 'utf8')]));

/** Test names (the first string literal of each `it(` / `it.skipIf(...)(`) in a source file. */
function testNames(src: string): string[] {
  return [...src.matchAll(/\bit(?:\.skipIf\([^)]*\))?\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]!);
}

const startsWithId = (name: string, id: string): boolean => name === id || name.startsWith(`${id} `) || name.startsWith(`${id}:`);

describe('CASE_INDEX', () => {
  it('covers every security.md §6 id (≥ 35 entries), once each', () => {
    expect(CASE_INDEX.length).toBeGreaterThanOrEqual(35);
    const ids = CASE_INDEX.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of SECTION6_IDS) expect(ids, id).toContain(id);
  });

  it('SECTION6_IDS is exactly the §6 table of docs/design/security.md', () => {
    const doc = readFileSync(join(REPO, 'docs/design/security.md'), 'utf8');
    const section = doc.slice(doc.indexOf('## 6.'), doc.indexOf('## 7.'));
    const rows = [...section.matchAll(/^\| `([a-z_]+\.[a-z_*]+)` \|/gm)].map((m) => m[1]);
    expect(rows).toEqual([...SECTION6_IDS]);
  });

  it('every entry names a test file with a test named by its id; status matches its GAP variants; gaps name an owner', () => {
    const files = sources();
    const check = (c: CaseEntry): void => {
      const src = files.get(c.file);
      expect(src, `${c.id}: ${c.file}`).toBeDefined();
      const names = testNames(src!).filter((n) => startsWithId(n, c.id));
      expect(names.length, `${c.id}: no test named by its id in ${c.file}`).toBeGreaterThan(0);
      expect(['passing', 'environment-skipped', 'gap']).toContain(c.status);
      const gapTests = names.filter((n) => /\bGAP\b/.test(n));
      if (gapTests.length) expect(c.status, `${c.id} has GAP variants (${gapTests.join(' | ')}) but status ${c.status}`).toBe('gap');
      if (c.status === 'gap') {
        expect(gapTests.length, `${c.id} is a gap but no test variant is named GAP`).toBeGreaterThan(0);
        expect(c.findings?.length, c.id).toBeGreaterThan(0);
        for (const f of c.findings!) expect(f, c.id).toMatch(/\(owner: [^)]+\)/);
      }
      // every GAP test asserts through expectGap, and names its owner
      for (const n of gapTests) expect(n, n).toMatch(/GAP \(owner: [^)]+\)/);
    };
    for (const c of [...CASE_INDEX, ...ACCEPTANCE_INDEX, ...DECISION_INDEX]) check(c);
  });

  it('DECISION_INDEX covers every owner decision D1–D7 of 2026-10-05, once per id, in src/decisions.test.ts', () => {
    const ids = DECISION_INDEX.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(ids.some((id) => id.startsWith(`decision.d${n}_`)), `D${n}`).toBe(true);
    for (const c of DECISION_INDEX) expect(c.file, c.id).toBe('src/decisions.test.ts');
    // the cases the 2026-10-05 brief names explicitly
    for (const id of ['decision.d4_stop_hook', 'decision.d4_achieved_proof', 'decision.d6_plan_requires_pr', 'decision.d3_budget_soft', 'decision.d5_review_foreign', 'decision.d2_reflex_on', 'decision.d7_openrouter_canary']) expect(ids).toContain(id);
  });

  it('no expected-failure wrappers: no it.fails / itFinding anywhere (a swallowed attack setup cannot pass as an expected failure)', () => {
    for (const [f, src] of sources()) {
      if (f === 'src/index.test.ts') continue;
      expect(src, f).not.toMatch(/\bit\.fails\b|\bitFinding\b|\btest\.fails\b/);
      // every expectGap names the ONE known failing assertion (id, owner, { assertion: … }, check)
      const calls = [...src.matchAll(/expectGap\(/g)].length;
      const precise = [...src.matchAll(/expectGap\(\s*'[^']+',\s*'[^']+',\s*\{\s*assertion:\s*'[^']+'/g)].length;
      expect(precise, `${f}: an expectGap without its known failing assertion`).toBe(calls);
      // a GAP test without expectGap would be an ordinary failing test, and expectGap outside a GAP test hides one
      for (const m of src.matchAll(/expectGap\(\s*'([^']+)'/g)) {
        const id = m[1]!;
        expect(testNames(src).some((n) => /\bGAP\b/.test(n) && n.startsWith(id.split(/[ -]/)[0]!)), `${f}: expectGap('${id}') outside a GAP test`).toBe(true);
      }
    }
  });
});

describe('harness/gap.ts: only the ONE known failure is accepted', () => {
  const KNOWN = { assertion: 'the known gap assertion' };
  it.skipIf(STRICT)('accepts exactly the known AssertionError (by its label)', async () => {
    const report = process.env.TECERA_ADV_GAP_REPORT;
    delete process.env.TECERA_ADV_GAP_REPORT; // a self-test is not an open gap of the suite
    try {
      await expectGap('harness.self', 'adversarial', KNOWN, () => {
        expect(1, 'the known gap assertion').toBe(2);
      });
    } finally {
      if (report !== undefined) process.env.TECERA_ADV_GAP_REPORT = report;
      openGaps.splice(openGaps.findIndex((g) => g.id === 'harness.self'), 1);
    }
  });
  it.skipIf(STRICT)('rejects any other failure inside the callback: another assertion, a TypeError, a setup error, a rejection', async () => {
    const others: Array<() => unknown> = [
      () => expect(1, 'another guarantee').toBe(2),
      () => expect(1).toBe(2),
      () => (null as unknown as { x: number }).x,
      () => {
        throw new Error('the known gap assertion: but not an AssertionError');
      },
      async () => Promise.reject(new Error('setup failed')),
    ];
    for (const f of others) await expect(expectGap('harness.self', 'adversarial', KNOWN, f)).rejects.toThrow(/UNEXPECTED failure inside gap/);
  });
  it.skipIf(STRICT)('a gap that no longer fails reports GAP CLOSED; a detail constraint narrows the match', async () => {
    await expect(expectGap('harness.self', 'adversarial', KNOWN, () => undefined)).rejects.toThrow(/GAP CLOSED/);
    await expect(
      expectGap('harness.self', 'adversarial', { ...KNOWN, detail: /exit 1 to be 9/ }, () => {
        expect(2, 'the known gap assertion').toBe(9);
      }),
    ).rejects.toThrow(/UNEXPECTED/);
    let caught: unknown = null;
    try {
      expect(1, 'the known gap assertion').toBe(9);
    } catch (e) {
      caught = e;
    }
    expect(isKnownFailure(caught, { ...KNOWN, detail: /expected 1 to be 9/ })).toBe(true);
    await expect(expectGap('harness.self', 'adversarial', { assertion: '' }, () => undefined)).rejects.toThrow(/must be named/);
  });
});

/**
 * The suite drives every package through its built dist (`@tecera/*` resolve to dist/index.js, the crash
 * supervisor imports runtime/dist). A dist older than its sources means the results describe other code:
 * fail closed. TECERA_ALLOW_STALE_DIST=1 skips this while a sibling package is being rebuilt.
 */
describe('dependency dists', () => {
  const PKGS = ['contracts', 'ledger', 'reflex', 'policy', 'worker', 'loop', 'brain', 'providers', 'planner', 'gates', 'runtime'];
  it.skipIf(process.env.TECERA_ALLOW_STALE_DIST === '1')('every @tecera dist this suite runs is at least as new as its sources', () => {
    const stale: string[] = [];
    const walk = (pkg: string, rel: string): void => {
      for (const n of readdirSync(join(PACKAGES, pkg, 'src', rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${n.name}` : n.name;
        if (n.isDirectory()) {
          if (n.name !== 'testkit' && n.name !== '__fixtures__') walk(pkg, r);
          continue;
        }
        if (!n.name.endsWith('.ts') || n.name.endsWith('.test.ts') || n.name.endsWith('.d.ts')) continue;
        const out = join(PACKAGES, pkg, 'dist', r.replace(/\.ts$/, '.js'));
        if (!existsSync(out)) continue; // not part of this package's build (e.g. a test helper)
        if (statSync(join(PACKAGES, pkg, 'src', r)).mtimeMs > statSync(out).mtimeMs) stale.push(`${pkg}: src/${r} is newer than dist`);
      }
    };
    for (const p of PKGS) {
      expect(existsSync(join(PACKAGES, p, 'dist/index.js')), `${p}/dist/index.js`).toBe(true);
      walk(p, '');
    }
    expect(stale, 'rebuild these packages (tsc) before running the adversarial suite').toEqual([]);
  });
});
