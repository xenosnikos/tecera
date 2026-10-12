import { posix } from 'node:path';
import { declaredExports, nameUses, resolveFrom, type ArgKind, type DeclaredParam } from './apiSurface.js';

/**
 * What the drafting seat may rely on in the repository, read by the host (never by the model): the package
 * names package.json lists (nothing else is installed: a criterion importing any other package can never
 * pass), and the exported names the repository's own tests import from its modules, with the call shapes the
 * tests use and, when the host also read the modules, the parameters each function declares (the API a contract
 * must keep working instead of inventing a replacement). Pure functions over text the caller read; never throws.
 */

/** How the tests call one exported name. */
export interface TestedCall {
  name: string;
  /** The distinct argument-kind lists the tests call it with (at most 6). */
  signatures: ArgKind[][];
  /** Methods the tests call on what it returns (a factory's result). */
  methods: string[];
  /** True when the tests call what it returns as a function. */
  resultCalled?: boolean;
  /** The parameters the module declares for it (only when the host read the module's text). */
  params?: DeclaredParam[];
}

export interface TestedModule {
  /** Repository-relative module path (`src/sessions.js`). */
  module: string;
  /** Names the tests import from it (`default` for a default import). */
  names: string[];
  /** The test files that import them. */
  tests: string[];
  /** How the tests call the names they call, and what the module declares for them (a name only imported, with no declaration read, is not listed). */
  calls: TestedCall[];
}

export interface RepoFacts {
  /** Package names package.json lists (dependencies, devDependencies, optionalDependencies, peerDependencies). */
  dependencies: readonly string[];
  /** Exported names the repository's tests import, per module. */
  testedApi: readonly TestedModule[];
}

const NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
const IDENT = /^[A-Za-z_$][\w$]*$/;
const MAX_MODULES = 24;
const MAX_NAMES = 24;
const MAX_SIGNATURES = 6;

/** Package names a package.json lists; [] when it cannot be read. */
export function dependencyNames(packageJson: string): string[] {
  try {
    const p = JSON.parse(packageJson) as Record<string, unknown>;
    const out = new Set<string>();
    for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const d = p[k];
      if (d && typeof d === 'object' && !Array.isArray(d)) for (const n of Object.keys(d)) if (NAME.test(n)) out.add(n);
    }
    return [...out].sort();
  } catch {
    return [];
  }
}

/** True for a path that looks like a test file (`*.test.js`, `*.spec.ts`, `test/…`, `tests/…`, `__tests__/…`). */
export function isTestPath(p: string): boolean {
  return /(^|\/)(test|tests|__tests__)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
}

const IMPORT_NAMED = /\bimport\s+(?:([A-Za-z_$][\w$]*)\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const IMPORT_DEFAULT = /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*["']([^"']+)["']/g;
const REQUIRE_NAMED = /\{([^}]*)\}\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g;

/** The names a list like `a, b as c, type D` imports (the exported name, before `as`). */
function names(list: string): string[] {
  return list
    .split(',')
    .map((x) => x.trim().replace(/^type\s+/, '').split(/\s+as\s+|\s*:\s*/)[0]!.trim())
    .filter((x) => IDENT.test(x));
}

/**
 * The repository modules the tests import, with the names they import. Only relative specifiers count (a
 * package import is not the repository's API); paths are resolved against the test file and must stay inside
 * the repository. Bounded: at most 24 modules, 24 names each. Each module also carries how the tests call
 * its names (apiSurface nameUses): the argument kinds of each distinct call and the methods called on the result.
 * `sources` are the texts of the modules themselves when the caller read them: each imported name a module
 * declares as an exported function then carries its declared parameters (apiSurface declaredExports).
 */
export function testedApiOf(files: ReadonlyArray<{ path: string; text: string }>, sources: ReadonlyArray<{ path: string; text: string }> = []): TestedModule[] {
  type Use = { signatures: Map<string, ArgKind[]>; methods: Set<string>; resultCalled: boolean; params?: DeclaredParam[] };
  const by = new Map<string, { names: Set<string>; tests: Set<string> }>();
  const calls = new Map<string, Map<string, Use>>();
  try {
    for (const f of files) {
      if (typeof f?.path !== 'string' || typeof f.text !== 'string') continue;
      const add = (spec: string, ns: string[]) => {
        if (!spec.startsWith('./') && !spec.startsWith('../')) return;
        const mod = posix.normalize(posix.join(posix.dirname(f.path), spec));
        if (mod.startsWith('..') || mod.startsWith('/') || !ns.length) return;
        const e = by.get(mod) ?? { names: new Set<string>(), tests: new Set<string>() };
        for (const n of ns) e.names.add(n);
        e.tests.add(f.path);
        by.set(mod, e);
      };
      for (const m of f.text.matchAll(IMPORT_NAMED)) add(m[3]!, [...(m[1] ? ['default'] : []), ...names(m[2]!)]);
      for (const m of f.text.matchAll(IMPORT_DEFAULT)) add(m[2]!, ['default']);
      for (const m of f.text.matchAll(REQUIRE_NAMED)) add(m[2]!, names(m[1]!));
      for (const u of nameUses(f.text, resolveFrom(f.path))) {
        if (!u.calls.length && !u.methods.length) continue;
        const mod = calls.get(u.module) ?? new Map<string, Use>();
        const e = mod.get(u.name) ?? { signatures: new Map<string, ArgKind[]>(), methods: new Set<string>(), resultCalled: false };
        for (const c of u.calls) e.signatures.set(c.join(','), c);
        for (const x of u.methods) e.methods.add(x);
        e.resultCalled ||= u.resultCalled;
        mod.set(u.name, e);
        calls.set(u.module, mod);
      }
    }
    for (const src of Array.isArray(sources) ? sources : []) {
      const names = typeof src?.path === 'string' && typeof src.text === 'string' ? by.get(posix.normalize(src.path))?.names : undefined;
      if (!names) continue;
      const module = posix.normalize(src.path);
      for (const d of declaredExports(src.text)) {
        if (!names.has(d.name)) continue;
        const mod = calls.get(module) ?? new Map<string, Use>();
        const e = mod.get(d.name) ?? { signatures: new Map<string, ArgKind[]>(), methods: new Set<string>(), resultCalled: false };
        e.params = d.params.slice(0, MAX_SIGNATURES);
        mod.set(d.name, e);
        calls.set(module, mod);
      }
    }
  } catch {
    // Unreadable input names nothing.
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, MAX_MODULES)
    .map(([module, e]) => ({
      module,
      names: [...e.names].sort().slice(0, MAX_NAMES),
      tests: [...e.tests].sort().slice(0, 4),
      calls: [...(calls.get(module) ?? new Map<string, Use>()).entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, MAX_NAMES)
        .map(([name, c]) => ({
          name,
          signatures: [...c.signatures.values()].slice(0, MAX_SIGNATURES),
          methods: [...c.methods].sort().slice(0, MAX_NAMES),
          ...(c.resultCalled ? { resultCalled: true } : {}),
          ...(c.params ? { params: c.params } : {}),
        })),
    }));
}
