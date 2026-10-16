import { posix } from 'node:path';
import { assertedValues, commentLines, declaredExports, documentedShapes, nameUses, relativeImports, resolveFrom, type ArgKind, type AssertedValue, type DeclaredParam, type DocumentedShape } from './apiSurface.js';

/**
 * What the drafting seat may rely on in the repository, read by the host (never by the model): the package
 * names package.json lists (nothing else is installed: a criterion importing any other package can never
 * pass), and the exported names the repository's own tests import from its modules, with the call shapes the
 * tests use and, when the host also read the modules, the parameters each function declares (the API a contract
 * must keep working instead of inventing a replacement), what a returned handler is given and gives back, the
 * interfaces the modules document in comments, the exact values the tests assert (null and undefined kept
 * apart), and the repository's commands with the modules they import. Pure functions over text the caller
 * read; never throws.
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
  /** The keys of the object the tests pass to that returned function (`app({ ip, path })`). */
  resultArgKeys?: string[][];
  /** The properties the tests read on what that returned function returns (`.status`, `.body`). */
  resultProps?: string[];
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
  /** The module's own comment lines that document an interface (a call or an object shape), when the host read it. */
  documented?: string[];
  /** The object shapes those comments document for a call (`send({ to, subject, text })`). */
  shapes?: DocumentedShape[];
}

/** An exact value a repository test asserts, and the test file. */
export interface TestAssertion extends AssertedValue {
  test: string;
}

/** A command of the repository (package.json `bin`, a file under bin/, a file a test spawns) and the modules it imports. */
export interface EntryPoint {
  path: string;
  imports: string[];
  /** Comment lines of the entry point that document its usage. */
  documented?: string[];
}

export interface RepoFacts {
  /** Package names package.json lists (dependencies, devDependencies, optionalDependencies, peerDependencies). */
  dependencies: readonly string[];
  /** Exported names the repository's tests import, per module. */
  testedApi: readonly TestedModule[];
  /** Exact values the repository's tests assert (null and undefined kept apart). */
  assertions?: readonly TestAssertion[];
  /** The repository's commands and what they import. */
  entryPoints?: readonly EntryPoint[];
}

const MAX_DOC_LINES = 6;
/** A comment line documents an interface when it shows a call or an object shape. */
const DOCUMENTS = /[A-Za-z_$][\w$.]*\s*\(|\{\s*[A-Za-z_$][\w$]*\s*[,}]|=>|\breturns?\b/;

/** The comment lines of `text` that document an interface, bounded. */
export function documentedLines(text: string): string[] {
  return commentLines(text)
    .filter((l) => DOCUMENTS.test(l))
    .slice(0, MAX_DOC_LINES)
    .map((l) => l.slice(0, 240));
}

/** Every exact value the tests assert, bounded (assertedValues per test file). */
export function assertionsOf(files: ReadonlyArray<{ path: string; text: string }>): TestAssertion[] {
  const out: TestAssertion[] = [];
  for (const f of files) {
    if (typeof f?.path !== 'string' || typeof f.text !== 'string') continue;
    for (const a of assertedValues(f.text)) if (out.length < 64 && a.actual.length <= 200 && a.value.length <= 200) out.push({ ...a, test: f.path });
  }
  return out;
}

/** Files the tests spawn by a literal path (`new URL('../bin/report.js', import.meta.url)`, `spawnSync('node', ['bin/x.js'])`). */
export function spawnedByTests(files: ReadonlyArray<{ path: string; text: string }>): string[] {
  const out = new Set<string>();
  for (const f of files) {
    if (typeof f?.path !== 'string' || typeof f.text !== 'string' || !/\b(?:spawn|exec|execFile|fork)(?:Sync)?\b/.test(f.text)) continue;
    for (const m of f.text.matchAll(/new\s+URL\(\s*["'`](\.{1,2}\/[^"'`]+\.[cm]?[jt]s)["'`]\s*,\s*import\.meta\.url\s*\)/g)) {
      const p = resolveFrom(f.path)(m[1]!);
      if (p) out.add(p);
    }
    for (const m of f.text.matchAll(/["'`]((?:\.\/)?(?:bin|scripts|cli)\/[\w./-]+\.[cm]?[jt]s)["'`]/g)) out.add(m[1]!.replace(/^\.\//, ''));
  }
  return [...out].sort();
}

/** Paths package.json lists under `bin` (a string or an object of them). */
export function packageBins(packageJson: string): string[] {
  try {
    const b = (JSON.parse(packageJson) as { bin?: unknown }).bin;
    const list = typeof b === 'string' ? [b] : b && typeof b === 'object' && !Array.isArray(b) ? Object.values(b as Record<string, unknown>) : [];
    return list.filter((x): x is string => typeof x === 'string').map((x) => posix.normalize(x).replace(/^\.\//, '')).filter((x) => !x.startsWith('..') && !x.startsWith('/'));
  } catch {
    return [];
  }
}

/** Each entry point's relative imports and usage comments (files the caller read). Bounded: 8. */
export function entryPointsOf(files: ReadonlyArray<{ path: string; text: string }>): EntryPoint[] {
  const out: EntryPoint[] = [];
  for (const f of files) {
    if (out.length >= 8 || typeof f?.path !== 'string' || typeof f.text !== 'string') continue;
    const doc = documentedLines(f.text);
    out.push({ path: posix.normalize(f.path), imports: relativeImports(f.text, resolveFrom(f.path)).slice(0, 12), ...(doc.length ? { documented: doc } : {}) });
  }
  return out;
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
  type Use = { signatures: Map<string, ArgKind[]>; methods: Set<string>; resultCalled: boolean; resultArgKeys: Map<string, string[]>; resultProps: Set<string>; params?: DeclaredParam[] };
  const fresh = (): Use => ({ signatures: new Map<string, ArgKind[]>(), methods: new Set<string>(), resultCalled: false, resultArgKeys: new Map<string, string[]>(), resultProps: new Set<string>() });
  const docs = new Map<string, { documented: string[]; shapes: DocumentedShape[] }>();
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
        const e = mod.get(u.name) ?? fresh();
        for (const c of u.calls) e.signatures.set(c.join(','), c);
        for (const x of u.methods) e.methods.add(x);
        e.resultCalled ||= u.resultCalled;
        for (const k of u.resultArgKeys ?? []) e.resultArgKeys.set(k.join(','), k);
        for (const p of u.resultProps ?? []) e.resultProps.add(p);
        mod.set(u.name, e);
        calls.set(u.module, mod);
      }
    }
    for (const src of Array.isArray(sources) ? sources : []) {
      const names = typeof src?.path === 'string' && typeof src.text === 'string' ? by.get(posix.normalize(src.path))?.names : undefined;
      if (!names) continue;
      const module = posix.normalize(src.path);
      const documented = documentedLines(src.text);
      const shapes = documentedShapes(src.text);
      if (documented.length || shapes.length) docs.set(module, { documented, shapes });
      for (const d of declaredExports(src.text)) {
        if (!names.has(d.name)) continue;
        const mod = calls.get(module) ?? new Map<string, Use>();
        const e = mod.get(d.name) ?? fresh();
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
          ...(c.resultArgKeys.size ? { resultArgKeys: [...c.resultArgKeys.values()].slice(0, MAX_SIGNATURES) } : {}),
          ...(c.resultProps.size ? { resultProps: [...c.resultProps].sort().slice(0, MAX_NAMES) } : {}),
          ...(c.params ? { params: c.params } : {}),
        })),
      ...(docs.get(module)?.documented.length ? { documented: docs.get(module)!.documented } : {}),
      ...(docs.get(module)?.shapes.length ? { shapes: docs.get(module)!.shapes } : {}),
    }));
}
