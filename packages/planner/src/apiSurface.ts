import { posix } from 'node:path';

/**
 * Call shapes of a repository's exported API, read from JavaScript text the host holds (the repository's own
 * tests, a drafted criterion's inline script). Coarse and static: a call is `name(` on a name the text imports
 * from a relative module (a named or default import, a member of a namespace import or of a dynamic import
 * bound to a variable, or a variable that aliases one of those), its arguments split at the top level and each
 * classified by its literal form (an identifier takes the kind every `x = <literal>` in the same text gives
 * it; `String(…)`, a call of a local arrow function and the like take the kind of what they produce); the
 * methods called on what it returns are the `x.m(` calls on a variable it was assigned to and `name(…).m(`.
 * A module's own text gives each exported function's declared parameters (declaredExports): a destructured or
 * defaulted parameter's kind, and the members the module reads from it (`deps.mailer`).
 * Nothing is evaluated. Pure functions; never throw.
 */

/** What an argument is, by its literal form ('unknown' for anything not read from the text). */
export type ArgKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'function' | 'nullish' | 'instance' | 'unknown';

/** How a text uses one imported name. */
export interface NameUse {
  /** Repository-relative module path the name is imported from. */
  module: string;
  /** The exported name (`default` for a default import). */
  name: string;
  /** The argument kinds of each call, in text order. */
  calls: ArgKind[][];
  /** Methods called on what a call returns. */
  methods: string[];
  /** True when the text calls what a call returns as a function (`const app = createApp(); app(req)`). */
  resultCalled: boolean;
  /** The keys of the object literal passed to that returned function, per call (`app({ ip, path })` → ip, path). */
  resultArgKeys?: string[][];
  /** Properties read on what that returned function returns (`app(req).status` → status). */
  resultProps?: string[];
}

/** One declared parameter of an exported function. */
export interface DeclaredParam {
  /** The parameter's name (`{…}` or `[…]` for a destructuring pattern). */
  name: string;
  /** Its kind when the declaration says ('object' for `{…}` or `= {}`), else 'unknown'. */
  kind: ArgKind;
  /** True with a default value (the caller may leave it out). */
  optional: boolean;
  /** True for a rest parameter. */
  rest: boolean;
  /** Members the module reads from it (`deps.mailer` → `mailer`; a destructuring pattern's keys). */
  members: string[];
}

/** An exported function a module declares. */
export interface DeclaredExport {
  /** The exported name (`default` for a default export). */
  name: string;
  params: DeclaredParam[];
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
const MAX_CALLS = 32;

/** Imports from relative modules: `{ module (resolved), name, local }`. `resolve` maps a relative specifier to a repository path (or null). */
export function importedBindings(text: string, resolve: (spec: string) => string | null): Array<{ module: string; name: string; local: string }> {
  const out: Array<{ module: string; name: string; local: string }> = [];
  try {
    const add = (spec: string, name: string, local: string) => {
      if (!spec.startsWith('./') && !spec.startsWith('../')) return;
      const module = resolve(spec);
      if (module && IDENT.test(local) && (name === 'default' || IDENT.test(name))) out.push({ module, name, local });
    };
    const list = (spec: string, l: string) => {
      for (const part of l.split(',')) {
        const p = part.trim().replace(/^type\s+/, '');
        if (!p) continue;
        const [name, local] = p.split(/\s+as\s+|\s*:\s*/).map((x) => x.trim());
        add(spec, name!, local || name!);
      }
    };
    for (const m of text.matchAll(/\bimport\s+(?:([A-Za-z_$][\w$]*)\s*,\s*)?\{([^}]*)\}\s*from\s*["'`]([^"'`]+)["'`]/g)) {
      if (m[1]) add(m[3]!, 'default', m[1]);
      list(m[3]!, m[2]!);
    }
    for (const m of text.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*["'`]([^"'`]+)["'`]/g)) add(m[2]!, 'default', m[1]!);
    for (const m of text.matchAll(/\{([^}]*)\}\s*=\s*(?:await\s+)?(?:require|import)\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) list(m[2]!, m[1]!);
    // import("./m.js").then(({ a }) => …)
    for (const m of text.matchAll(/\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)\s*\.\s*then\(\s*(?:async\s*)?\(\s*\{([^}]*)\}\s*\)\s*=>/g)) list(m[1]!, m[2]!);
    // const { a } = ns, for a namespace bound in the same text.
    for (const ns of namespaceBindings(text, resolve)) {
      for (const m of text.matchAll(new RegExp(`\\{([^}]*)\\}\\s*=\\s*${rx(ns.local)}(?![\\w$])`, 'g'))) {
        for (const part of m[1]!.split(',')) {
          const [name, local] = part.trim().split(/\s*:\s*/).map((x) => x.trim());
          if (name && IDENT.test(name) && IDENT.test(local || name)) out.push({ module: ns.module, name, local: local || name });
        }
      }
    }
  } catch {
    // Unreadable text binds nothing.
  }
  return out;
}

const rx = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Variables that hold a whole relative module: `import * as ns from`, `const ns = [await] import(…)` or
 * `require(…)`, and the parameter of `import(…).then((ns) => …)`.
 */
export function namespaceBindings(text: string, resolve: (spec: string) => string | null): Array<{ module: string; local: string }> {
  const out: Array<{ module: string; local: string }> = [];
  try {
    const add = (spec: string, local: string) => {
      if (!spec.startsWith('./') && !spec.startsWith('../')) return;
      const module = resolve(spec);
      if (module && IDENT.test(local)) out.push({ module, local });
    };
    for (const m of text.matchAll(/\bimport\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*["'`]([^"'`]+)["'`]/g)) add(m[2]!, m[1]!);
    for (const m of text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:require|import)\(\s*["'`]([^"'`]+)["'`]\s*\)(?!\s*\.)/g)) add(m[2]!, m[1]!);
    for (const m of text.matchAll(/\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)\s*\.\s*then\(\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>/g)) add(m[1]!, m[2]!);
  } catch {
    // Unreadable text binds nothing.
  }
  return out;
}

/** The index just past the bracket that closes the one at `open` (quotes and nesting respected), or -1. */
function closing(text: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (pairs[c]) stack.push(pairs[c]);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i + 1;
    }
  }
  return -1;
}

/** Split an argument list at its top-level commas (a trailing comma adds nothing). */
function splitArgs(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (quote) {
      if (c === '\\') {
        cur += c + (inner[i + 1] ?? '');
        i++;
        continue;
      }
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** What a call of a well-known conversion produces. */
const PRODUCES: ReadonlyArray<readonly [RegExp, ArgKind]> = [
  [/^(?:String|JSON\s*\.\s*stringify|encodeURIComponent|decodeURIComponent)\s*\(/, 'string'],
  [/^(?:Number|parseInt|parseFloat|Date\s*\.\s*now)\s*\(/, 'number'],
  [/^Boolean\s*\(/, 'boolean'],
  [/^(?:Object\s*\.\s*(?:assign|freeze|fromEntries|create)|structuredClone\s*\(\s*\{)/, 'object'],
  [/^Array\s*\.\s*(?:from|of)\s*\(/, 'array'],
];

/** The expression that starts `rest`: a bracketed one whole, else up to the statement's end. */
function expressionAt(rest: string): string {
  const end = /^[{[(]/.test(rest) ? closing(rest, 0) : -1;
  return end > 0 ? rest.slice(0, end) : rest.split(/[;\n]/)[0]!;
}

/** The kind a local function `name` returns (`const f = () => <expr>`, `function f() { return <expr> }`), or 'unknown'. */
function returnKind(name: string, text: string, depth: number): ArgKind {
  const n = rx(name);
  const arrow = new RegExp(`(?<![\\w$.])${n}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>\\s*`).exec(text);
  const fn = arrow ? null : new RegExp(`\\bfunction\\s+${n}\\s*\\([^)]*\\)\\s*`).exec(text);
  const hit = arrow ?? fn;
  if (!hit) return 'unknown';
  const body = text.slice(hit.index + hit[0].length);
  if (!body.startsWith('{')) return kindOf(expressionAt(body), text, depth + 1);
  const end = closing(body, 0);
  const returns = [...(end > 0 ? body.slice(0, end) : body).matchAll(/\breturn\s+/g)];
  if (returns.length !== 1) return 'unknown';
  return kindOf(expressionAt(body.slice(returns[0]!.index! + returns[0]![0].length)), text, depth + 1);
}

/**
 * The kind of an argument's text. An identifier takes the kind its assignments in `text` agree on (`const x =
 * <literal>`, or `let x; x = <literal>`); a call of a local function takes the kind that function returns.
 */
function kindOf(arg: string, text: string, depth = 0): ArgKind {
  let a = arg.replace(/^await\s+/, '').trim();
  while (a.startsWith('(') && closing(a, 0) === a.length && !/^\([^)]*\)\s*=>/.test(a)) a = a.slice(1, -1).replace(/^await\s+/, '').trim();
  if (a.startsWith('{')) return 'object';
  if (a.startsWith('[')) return 'array';
  if (/^["'`]/.test(a)) return 'string';
  if (/^-?\d/.test(a)) return 'number';
  if (a === 'true' || a === 'false') return 'boolean';
  if (a === 'null' || a === 'undefined') return 'nullish';
  if (/^(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(a)) return 'function';
  if (/^new\s/.test(a)) return 'instance';
  // An environment variable is a string (or absent), never an options object.
  if (/^process\s*\.\s*env\b/.test(a)) return 'string';
  for (const [re, kind] of PRODUCES) if (re.test(a)) return kind;
  if (depth >= 3) return 'unknown';
  if (IDENT.test(a)) {
    const kinds = new Set<ArgKind>();
    for (const b of text.matchAll(new RegExp(`(?<![\\w$.])${rx(a)}\\s*=(?![=>])\\s*`, 'g'))) kinds.add(kindOf(expressionAt(text.slice(b.index! + b[0].length)), text, depth + 1));
    return kinds.size === 1 ? [...kinds][0]! : 'unknown';
  }
  const called = /^([A-Za-z_$][\w$]*)\s*\(/.exec(a);
  if (called && closing(a, called[0].length - 1) === a.length) return returnKind(called[1]!, text, depth);
  return 'unknown';
}

/** A way `text` refers to one exported name: a regular expression source that matches the callee. */
interface Callee {
  module: string;
  name: string;
  pattern: string;
}

const QUOTE = `["'\`]`;
const bare = (local: string): string => `(?<![\\w$.])(?<!function\\s+)${rx(local)}`;

/** Every callee of an imported name in `text`: the bindings, namespace members, inline dynamic imports and their aliases. */
function calleesOf(text: string, resolve: (spec: string) => string | null): Callee[] {
  const out: Callee[] = [];
  for (const b of importedBindings(text, resolve)) out.push({ module: b.module, name: b.name, pattern: bare(b.local) });
  for (const ns of namespaceBindings(text, resolve)) {
    const n = rx(ns.local);
    const seen = new Set<string>();
    for (const m of text.matchAll(new RegExp(`(?<![\\w$.])${n}\\s*(?:\\??\\.\\s*([A-Za-z_$][\\w$]*)|\\[\\s*${QUOTE}([A-Za-z_$][\\w$]*)${QUOTE}\\s*\\])`, 'g'))) {
      const name = m[1] ?? m[2]!;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ module: ns.module, name, pattern: `(?<![\\w$.])${n}\\s*(?:\\??\\.\\s*${rx(name)}(?![\\w$])|\\[\\s*${QUOTE}${rx(name)}${QUOTE}\\s*\\])` });
    }
  }
  // (await import("./m.js")).name
  for (const m of text.matchAll(new RegExp(`\\(\\s*await\\s+import\\(\\s*${QUOTE}([^"'\`]+)${QUOTE}\\s*\\)\\s*\\)\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g'))) {
    const module = m[1]!.startsWith('./') || m[1]!.startsWith('../') ? resolve(m[1]!) : null;
    if (module) out.push({ module, name: m[2]!, pattern: `\\(\\s*await\\s+import\\(\\s*${QUOTE}${rx(m[1]!)}${QUOTE}\\s*\\)\\s*\\)\\s*\\.\\s*${rx(m[2]!)}(?![\\w$])` });
  }
  // x = <callee> (not a call of it): x is another name for the same function. Two rounds follow an alias of an alias.
  for (let round = 0, from = 0; round < 2; round++) {
    const upto = out.length;
    for (let k = from; k < upto && out.length < 96; k++) {
      const c = out[k]!;
      for (const m of text.matchAll(new RegExp(`(?<![\\w$.])([A-Za-z_$][\\w$]*)\\s*=\\s*${c.pattern}\\s*(?:\\.\\s*bind\\s*\\([^)]*\\)\\s*)?(?=[;,\\n)]|$)`, 'g'))) out.push({ module: c.module, name: c.name, pattern: bare(m[1]!) });
    }
    from = upto;
  }
  return out;
}

/** How `text` calls each name it imports from a relative module (see the module comment). */
export function nameUses(text: string, resolve: (spec: string) => string | null): NameUse[] {
  const out: NameUse[] = [];
  try {
    const by = new Map<string, { use: NameUse; methods: Set<string> }>();
    for (const c of calleesOf(text, resolve)) {
      const key = `${c.module}\0${c.name}`;
      let e = by.get(key);
      if (!e) {
        e = { use: { module: c.module, name: c.name, calls: [], methods: [], resultCalled: false }, methods: new Set<string>() };
        by.set(key, e);
        out.push(e.use);
      }
      const { use, methods } = e;
      const argKeys = new Map<string, string[]>();
      const props = new Set<string>(use.resultProps ?? []);
      for (const k of use.resultArgKeys ?? []) argKeys.set(k.join(','), k);
      // name(…), and name.call(this, …) with the receiver dropped.
      for (const m of text.matchAll(new RegExp(`${c.pattern}\\s*(\\.\\s*call\\s*)?\\(`, 'g'))) {
        const open = m.index! + m[0].length - 1;
        const end = closing(text, open);
        if (end < 0) continue;
        const args = splitArgs(text.slice(open + 1, end - 1)).map((x) => kindOf(x, text));
        if (use.calls.length < MAX_CALLS) use.calls.push(m[1] ? args.slice(1) : args);
        // name(…).m( chained on the call.
        const chained = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(text.slice(end));
        if (chained) methods.add(chained[1]!);
        // x = [await] name(…): every x.m( in the text.
        const before = text.slice(Math.max(0, m.index! - 120), m.index!);
        const v = /(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/.exec(before);
        if (v && !/^(?:const|let|var)$/.test(v[1]!)) {
          const x = rx(v[1]!);
          for (const k of text.matchAll(new RegExp(`(?<![\\w$.])${x}\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g'))) methods.add(k[1]!);
          if (new RegExp(`(?<![\\w$.])(?<!function\\s+)${x}\\s*\\(`).test(text)) {
            use.resultCalled = true;
            const r = resultShape(text, v[1]!);
            for (const k of r.keys) argKeys.set(k.join(','), k);
            for (const p of r.props) props.add(p);
          }
        }
      }
      if (argKeys.size) use.resultArgKeys = [...argKeys.values()].slice(0, MAX_SHAPES);
      if (props.size) use.resultProps = [...props].sort().slice(0, MAX_MEMBERS);
    }
    for (const e of by.values()) e.use.methods = [...e.methods].sort();
    return out;
  } catch {
    // Unreadable text calls nothing.
  }
  return out;
}

const MAX_SHAPES = 6;

/** The keys of an object literal's text (`{ ip: 'a', path }` → ip, path); spreads and computed keys are skipped. */
export function objectKeys(literal: string): string[] {
  const t = literal.trim();
  if (!t.startsWith('{')) return [];
  const end = closing(t, 0);
  if (end < 0) return [];
  return splitArgs(t.slice(1, end - 1))
    .map((p) => p.trim())
    .filter((p) => !p.startsWith('...') && !p.startsWith('['))
    .map((p) => p.replace(/^(?:async\s+)?(?:get\s+|set\s+)?/, '').split(/\s*[:(=]\s*|\s+/)[0]!.replace(/^["']|["']$/g, ''))
    .filter((k) => IDENT.test(k));
}

/**
 * How `text` calls the function held in variable `fn` (what a factory returned): the keys of the object it is
 * passed, and the properties read on what it returns (chained `fn(…).p`, or `r = fn(…)` then `r.p`).
 */
function resultShape(text: string, fn: string): { keys: string[][]; props: string[] } {
  const keys: string[][] = [];
  const props = new Set<string>();
  const x = rx(fn);
  for (const m of text.matchAll(new RegExp(`(?<![\\w$.])(?<!function\\s+)${x}\\s*\\(`, 'g'))) {
    const open = m.index! + m[0].length - 1;
    const end = closing(text, open);
    if (end < 0) continue;
    const first = splitArgs(text.slice(open + 1, end - 1))[0];
    if (first && keys.length < MAX_SHAPES) {
      const k = objectKeys(first);
      if (k.length) keys.push(k);
    }
    const chained = /^\s*\??\.\s*([A-Za-z_$][\w$]*)(?!\s*\()/.exec(text.slice(end));
    if (chained) props.add(chained[1]!);
    const before = text.slice(Math.max(0, m.index! - 80), m.index!);
    const v = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/.exec(before);
    if (v) for (const k of text.matchAll(new RegExp(`(?<![\\w$.])${rx(v[1]!)}\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)(?!\\s*\\()`, 'g'))) props.add(k[1]!);
  }
  return { keys, props: [...props].filter((p) => !BUILTIN_MEMBERS.has(p)) };
}

/** One assertion of an exact value: what is asserted (its text, whitespace removed) and the literal it must equal. */
export interface AssertedValue {
  /** The asserted expression without whitespace (`s.get('a')`). */
  actual: string;
  /** The expected literal as written (`undefined`, `null`, `200`, `'text'`). */
  value: string;
  /** The method or function the expression ends with a call of (`get`), when it does. */
  callee?: string;
}

const LITERAL = /^(?:null|undefined|true|false|-?\d[\d_.eE+-]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`$]*`)$/;
const MAX_ASSERTIONS = 64;

/**
 * The exact values `text` asserts (`assert.equal(x, 1)`, `assert.strictEqual`, `assert.deepEqual`,
 * `assert.deepStrictEqual`, with or without the `assert.` prefix of a strict import): the expression and the
 * literal. Only literal expectations count; nothing is evaluated. Never throws.
 */
export function assertedValues(text: string): AssertedValue[] {
  const out: AssertedValue[] = [];
  try {
    for (const m of text.matchAll(/(?<![\w$])(?:assert\s*\.\s*)?(?:strictEqual|equal|deepStrictEqual|deepEqual)\s*\(/g)) {
      if (out.length >= MAX_ASSERTIONS) break;
      const open = m.index! + m[0].length - 1;
      const end = closing(text, open);
      if (end < 0) continue;
      const [actual, expected] = splitArgs(text.slice(open + 1, end - 1));
      if (!actual || !expected || !LITERAL.test(expected.trim())) continue;
      const a = actual.replace(/^await\s+/, '').replace(/\s+/g, '');
      const callee = /(?:^|\.)([A-Za-z_$][\w$]*)\((?:[^()]|\([^()]*\))*\)$/.exec(a)?.[1];
      out.push({ actual: a, value: expected.trim(), ...(callee ? { callee } : {}) });
    }
  } catch {
    // Unreadable text asserts nothing.
  }
  return out;
}

/** An object shape a comment documents for a call (`send({ to, subject, text })`): the called name and its keys. */
export interface DocumentedShape {
  /** The called name, its last segment (`options.rateLimit ({ … })` → rateLimit). */
  name: string;
  keys: string[];
}

/** The comment text of a module (line and block comments), one entry per line, trimmed. */
export function commentLines(text: string): string[] {
  const out: string[] = [];
  try {
    for (const m of text.matchAll(/\/\*([\s\S]*?)\*\/|(?<![:"'`\\])\/\/([^\n]*)/g)) {
      for (const l of (m[1] ?? m[2] ?? '').split('\n')) {
        const t = l.replace(/^\s*\*?\s?/, '').trim();
        if (t) out.push(t);
      }
    }
  } catch {
    // Unreadable text documents nothing.
  }
  return out;
}

/** The call shapes a module's comments document: `name({ a, b })`, `name ({ a, b })`. */
export function documentedShapes(text: string): DocumentedShape[] {
  const out: DocumentedShape[] = [];
  for (const line of commentLines(text)) {
    for (const m of line.matchAll(/([A-Za-z_$][\w$.]*)\s*\(\s*(\{[^{}]*\})/g)) {
      const name = m[1]!.split('.').pop()!;
      const keys = objectKeys(m[2]!);
      if (IDENT.test(name) && keys.length && !out.some((d) => d.name === name)) out.push({ name, keys });
    }
  }
  return out.slice(0, MAX_SHAPES * 2);
}

/** The relative modules a text imports or requires (resolved by `resolve`). */
export function relativeImports(text: string, resolve: (spec: string) => string | null): string[] {
  const out = new Set<string>();
  try {
    for (const m of text.matchAll(/\b(?:import|export)\s[^"'`;]*?\bfrom\s*["'`]([^"'`]+)["'`]|\bimport\s*["'`]([^"'`]+)["'`]|\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)|\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4]!;
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
      const p = resolve(spec);
      if (p) out.add(p);
    }
  } catch {
    // Unreadable text imports nothing.
  }
  return [...out].sort();
}

/** The index of the first top-level `=` of a parameter (its default), or -1. */
function defaultAt(param: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < param.length; i++) {
    const c = param[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '=' && depth === 0 && param[i + 1] !== '>' && param[i + 1] !== '=') return i;
  }
  return -1;
}

const MAX_MEMBERS = 8;
/** Members every array or string has: reading one says nothing about what the caller passes. */
const BUILTIN_MEMBERS = new Set(['length', 'map', 'filter', 'forEach', 'reduce', 'push', 'join', 'slice', 'trim', 'split', 'includes', 'toString', 'sort', 'find', 'some', 'every', 'keys', 'values', 'entries', 'concat', 'indexOf', 'replace', 'match', 'test', 'then', 'catch']);

/** One parameter's declaration, with the members `text` reads from it. */
function declaredParam(raw: string, text: string): DeclaredParam {
  const rest = raw.startsWith('...');
  const p = rest ? raw.slice(3).trim() : raw;
  const eq = defaultAt(p);
  const pattern = (eq < 0 ? p : p.slice(0, eq)).trim();
  const fallback = eq < 0 ? null : p.slice(eq + 1).trim();
  if (pattern.startsWith('{')) {
    const keys = splitArgs(pattern.slice(1, pattern.lastIndexOf('}'))).map((k) => k.replace(/^\.\.\./, '').split(/[:=]/)[0]!.trim()).filter((k) => IDENT.test(k));
    return { name: '{…}', kind: 'object', optional: fallback !== null, rest, members: keys.slice(0, MAX_MEMBERS) };
  }
  if (pattern.startsWith('[')) return { name: '[…]', kind: 'array', optional: fallback !== null, rest, members: [] };
  const members = new Set<string>();
  if (IDENT.test(pattern)) for (const m of text.matchAll(new RegExp(`(?<![\\w$.])${rx(pattern)}\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)`, 'g'))) if (!BUILTIN_MEMBERS.has(m[1]!)) members.add(m[1]!);
  return { name: IDENT.test(pattern) ? pattern : 'x', kind: rest ? 'array' : fallback === null ? 'unknown' : kindOf(fallback, ''), optional: fallback !== null, rest, members: [...members].sort().slice(0, MAX_MEMBERS) };
}

/**
 * The functions a module's text exports with their declared parameters: `export [default] [async] function
 * name(…)` and `export const name = [async] (…) =>` or `= [async] function (…)`. A parameter's members are
 * read from the whole text, comments included (a seam the module documents counts). Never throws.
 */
export function declaredExports(text: string): DeclaredExport[] {
  const out: DeclaredExport[] = [];
  try {
    const add = (name: string, open: number) => {
      const end = closing(text, open);
      if (end < 0 || out.some((e) => e.name === name)) return;
      out.push({ name, params: splitArgs(text.slice(open + 1, end - 1)).map((p) => declaredParam(p, text)) });
    };
    for (const m of text.matchAll(/\bexport\s+(default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/g)) {
      const name = m[1] ? 'default' : m[2];
      if (name) add(name, m.index! + m[0].length - 1);
    }
    for (const m of text.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*)?\(/g)) add(m[1]!, m.index! + m[0].length - 1);
  } catch {
    // Unreadable text declares nothing.
  }
  return out;
}

/** A declaration as its source would read (`signup(user, deps = {})`). */
export function renderDeclared(name: string, params: readonly DeclaredParam[]): string {
  const show: Partial<Record<ArgKind, string>> = { object: '{}', array: '[]', string: '"…"', number: '0', boolean: 'false', nullish: 'undefined', function: '() => …' };
  return `${name}(${params.map((p) => `${p.rest ? '...' : ''}${p.name}${p.optional && !/^[{[]/.test(p.name) ? ` = ${show[p.kind] ?? '…'}` : ''}`).join(', ')})`;
}

/** Resolve a relative specifier in a file at `from` (repository-relative) to a repository path, or null outside it. */
export function resolveFrom(from: string): (spec: string) => string | null {
  return (spec) => {
    const p = posix.normalize(posix.join(posix.dirname(from), spec));
    return p.startsWith('..') || p.startsWith('/') ? null : p;
  };
}

/** A call's argument kinds as a short example (`signup({…}, x)`). */
export function renderCall(name: string, args: readonly ArgKind[]): string {
  const show: Record<ArgKind, string> = { object: '{…}', array: '[…]', string: '"…"', number: '0', boolean: 'true', function: '() => …', nullish: 'undefined', instance: 'new …', unknown: 'x' };
  return `${name}(${args.map((a) => show[a]).join(', ')})`;
}
