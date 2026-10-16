import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { compileFunction, createContext } from 'node:vm';
import { ToolInputError } from './common.js';

/**
 * Content checks on edits of JavaScript/TypeScript-family files, run on the host before a write lands
 * (edit.ts calls checkEdit from the write's content step, so a refusal changes nothing). Nothing here
 * executes the content:
 * - syntax: .cjs compiles as a CommonJS function body in a fresh vm context (compile only, never called);
 *   .mjs is checked by `node --check --input-type=module` on stdin (a parse, no linking, empty env);
 *   .js passes when it parses under either goal; .ts/.mts/.cts go through node's own TypeScript parser
 *   (module.stripTypeScriptTypes; its output is discarded). .jsx/.tsx are not checked: there is no JSX
 *   parser without a new dependency.
 * - exports: the top-level exported names (export declarations and lists, export default, export * from,
 *   TS export =, module.exports / exports.x assignments, Object.defineProperty(exports, ...)) are found by a
 *   small lexer (static analysis only). An edit of an existing module whose result drops a name it exported
 *   is refused unless the request declares that name in removeExports.
 */

export type CodeKind = 'js' | 'esm' | 'cjs' | 'ts' | 'cts';

/** The checked kind of a worktree-relative path, or null for a file these checks do not apply to. */
export function codeKindOf(rel: string): CodeKind | null {
  const m = /\.([cm]?[jt]s)$/i.exec(rel);
  switch (m?.[1]!.toLowerCase()) {
    case 'js':
      return 'js';
    case 'mjs':
      return 'esm';
    case 'cjs':
      return 'cjs';
    case 'ts':
    case 'mts':
      return 'ts';
    case 'cts':
      return 'cts';
    default:
      return null;
  }
}

// ---------------------------------------------------------------- syntax

export interface SyntaxProblem {
  line: number | null;
  message: string;
}

const MODULE_CHECK_TIMEOUT_MS = 15_000;

function firstLine(s: string): string {
  return (s.split('\n')[0] ?? '').trim();
}

/** name, message and stack of a thrown value; duck-typed, since errors from a vm context are not this realm's Error. */
function errorParts(e: unknown): { name: string; message: string; stack: string } {
  const o = (e !== null && typeof e === 'object' ? e : {}) as { name?: unknown; message?: unknown; stack?: unknown };
  return {
    name: typeof o.name === 'string' && o.name ? o.name : 'Error',
    message: typeof o.message === 'string' ? o.message : String(e),
    stack: typeof o.stack === 'string' ? o.stack : '',
  };
}

/** Line of a V8/swc SyntaxError: the first stack line ends in ":<line>". */
function lineOfStack(e: unknown): number | null {
  const { stack } = errorParts(e);
  const m = /^[^\n]*:(\d+)\s*$/m.exec(stack.split('\n')[0] ?? '');
  return m ? Number(m[1]) : null;
}

function checkCommonJs(content: string, filename: string): SyntaxProblem | null {
  try {
    // Compile only: the returned function is never called, and the context is fresh.
    compileFunction(content, ['exports', 'require', 'module', '__filename', '__dirname'], { filename, parsingContext: createContext({}) });
    return null;
  } catch (e) {
    const err = errorParts(e);
    return { line: lineOfStack(e), message: `${err.name}: ${firstLine(err.message)}` };
  }
}

/** Parse as an ES module in a separate node with --check (no execution, no linking). Fails closed. */
function checkModule(content: string): Promise<SyntaxProblem | null> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ['--check', '--input-type=module', '-'],
      { env: {}, cwd: '/', timeout: MODULE_CHECK_TIMEOUT_MS, maxBuffer: 256 * 1024, windowsHide: true },
      (err, _stdout, stderr) => {
        if (!err) return resolve(null);
        const text = String(stderr);
        const syn = /^(\w*Error): (.*)$/m.exec(text);
        const at = /^\[stdin\]:(\d+)\s*$/m.exec(text);
        if (syn && (err as { code?: unknown }).code === 1) return resolve({ line: at ? Number(at[1]) : null, message: `${syn[1]}: ${syn[2]!.trim()}` });
        // The check itself did not run to a verdict (spawn failure, timeout, crash): refuse, never assume it parses.
        resolve({ line: null, message: `the module syntax check could not run (${firstLine(err.message)})` });
      },
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(content);
  });
}

type StripTypes = (code: string, o?: { mode?: 'strip' | 'transform' }) => string;
let stripTypes: StripTypes | null | undefined;
function stripper(): StripTypes | null {
  if (stripTypes === undefined) {
    const fn = (createRequire(import.meta.url)('node:module') as { stripTypeScriptTypes?: unknown }).stripTypeScriptTypes;
    stripTypes = typeof fn === 'function' ? (fn as StripTypes) : null;
  }
  return stripTypes;
}

function checkTypeScript(content: string): SyntaxProblem | null {
  const strip = stripper();
  // Fail closed: a TS file is never written unchecked because this node lacks the parser.
  if (!strip) return { line: null, message: 'TypeScript syntax cannot be checked on this node (module.stripTypeScriptTypes is unavailable)' };
  const run = (mode: 'strip' | 'transform'): unknown => {
    try {
      strip(content, { mode });
      return null;
    } catch (e) {
      return e;
    }
  };
  let e = run('strip');
  // Strip-only mode refuses valid syntax it cannot erase (enum, namespace, import =); transform parses it.
  if ((e as { code?: unknown } | null)?.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') e = run('transform');
  if (e === null) return null;
  return { line: lineOfStack(e), message: `SyntaxError: ${firstLine(errorParts(e).message)}` };
}

/** null when the content parses as the given kind, else the parser's message and line. */
export async function syntaxProblem(kind: CodeKind, content: string, filename: string): Promise<SyntaxProblem | null> {
  switch (kind) {
    case 'cjs':
      return checkCommonJs(content, filename);
    case 'esm':
      return checkModule(content);
    case 'js': {
      const asScript = checkCommonJs(content, filename);
      if (asScript === null) return null;
      const asModule = await checkModule(content);
      if (asModule === null) return null;
      // Report the goal the file looks like it is written for.
      return scan(content).esm ? asModule : asScript;
    }
    case 'ts':
    case 'cts':
      return checkTypeScript(content);
  }
}

// ---------------------------------------------------------------- exports

interface Tok {
  k: 'id' | 'p' | 's' | 'n' | 'x';
  v: string;
  /** Nesting depth of (, [, { and template ${ before this token. */
  d: number;
  /** A line break precedes this token. */
  nl: boolean;
}

const REGEX_AFTER_KEYWORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];
const ID_START = /[A-Za-z_$\u0080-￿]/;
const ID_PART = /[A-Za-z0-9_$\u0080-￿]/;

/**
 * A tolerant JS/TS tokenizer: skips comments, strings, template literals (with nested ${}) and regex
 * literals, and records nesting depth. It never throws; on input it cannot follow it degrades to fewer
 * tokens, never to invented code.
 */
function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  /** Open brackets; '`' marks a template ${ whose } resumes the template. */
  const stack: string[] = [];
  let i = 0;
  let nl = false;
  const push = (k: Tok['k'], v: string): void => {
    out.push({ k, v, d: stack.length, nl });
    nl = false;
  };
  const regexAllowed = (): boolean => {
    const p = out[out.length - 1];
    if (!p) return true;
    if (p.k === 'id') return REGEX_AFTER_KEYWORD.has(p.v);
    if (p.k === 'p') return p.v !== ')' && p.v !== ']' && p.v !== '}';
    return false;
  };
  /** Scan template text from i (just after ` or a resuming }); stops after the closing ` or an opening ${. */
  const template = (): void => {
    while (i < src.length) {
      const c = src[i]!;
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        i++;
        push('s', '`');
        return;
      }
      if (c === '$' && src[i + 1] === '{') {
        i += 2;
        push('s', '`');
        stack.push('`');
        return;
      }
      i++;
    }
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\n' || c === '\r' || c === ' ' || c === ' ') {
      nl = true;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\f' || c === '\v' || c === '﻿' || c === ' ') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const body = src.slice(i, end === -1 ? src.length : end);
      if (/[\n\r]/.test(body)) nl = true;
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === '#' && i === 0 && src[1] === '!') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let v = '';
      while (j < src.length && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') {
          v += src[j + 1] ?? '';
          j += 2;
          continue;
        }
        v += src[j];
        j++;
      }
      i = j + 1;
      push('s', v);
      continue;
    }
    if (c === '`') {
      i++;
      template();
      continue;
    }
    if (c === '/' && regexAllowed()) {
      // A regex literal never spans a line; if no terminator is found on this line it was a division.
      let j = i + 1;
      let cls = false;
      let closed = false;
      while (j < src.length && src[j] !== '\n' && src[j] !== '\r') {
        const r = src[j]!;
        if (r === '\\') {
          j += 2;
          continue;
        }
        if (r === '[') cls = true;
        else if (r === ']') cls = false;
        else if (r === '/' && !cls) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        j++;
        while (j < src.length && ID_PART.test(src[j]!)) j++;
        i = j;
        push('x', '/re/');
        continue;
      }
    }
    if (ID_START.test(c) || (c === '\\' && src[i + 1] === 'u')) {
      let j = i + 1;
      while (j < src.length && (ID_PART.test(src[j]!) || src[j] === '\\')) j++;
      push('id', src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '#' && i + 1 < src.length && ID_START.test(src[i + 1]!)) {
      let j = i + 1;
      while (j < src.length && ID_PART.test(src[j]!)) j++;
      push('id', src.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < src.length && /[0-9A-Za-z_.]/.test(src[j]!)) j++;
      push('n', src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      push('p', c);
      stack.push(c);
      i++;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      const top = stack.pop();
      if (c === '}' && top === '`') {
        i++;
        template();
        continue;
      }
      push('p', c);
      i++;
      continue;
    }
    const multi = PUNCT.find((p) => src.startsWith(p, i));
    const v = multi ?? c;
    push('p', v);
    i += v.length;
  }
  return out;
}

const DECL_KEYWORDS = new Set(['interface', 'type', 'enum', 'namespace', 'module']);
const STATEMENT_START = new Set(['export', 'import', 'const', 'let', 'var', 'function', 'class', 'if', 'for', 'while', 'do', 'switch', 'try', 'return', 'throw']);

interface Scan {
  names: Set<string>;
  /** Top-level import/export syntax was seen (the file is written as an ES module). */
  esm: boolean;
}

function scan(src: string): Scan {
  const t = tokenize(src);
  const names = new Set<string>();
  let esm = false;
  const at = (i: number): Tok | undefined => t[i];
  const isId = (i: number, v?: string): boolean => t[i]?.k === 'id' && (v === undefined || t[i]!.v === v);
  const isP = (i: number, v: string): boolean => t[i]?.k === 'p' && t[i]!.v === v;
  const afterDot = (i: number): boolean => isP(i - 1, '.') || isP(i - 1, '?.');

  /** Index just past the bracket opened at i (matching by depth). */
  const close = (i: number): number => {
    const d = t[i]!.d;
    let j = i + 1;
    while (j < t.length && !(t[j]!.d === d && t[j]!.k === 'p' && (t[j]!.v === '}' || t[j]!.v === ')' || t[j]!.v === ']'))) j++;
    return j + 1;
  };

  /** Names bound by a binding pattern starting at i; returns the index after it. */
  const pattern = (i: number, into: Set<string>): number => {
    const tk = at(i);
    if (!tk) return i;
    if (tk.k === 'id') {
      into.add(tk.v);
      return i + 1;
    }
    if (isP(i, '{') || isP(i, '[')) {
      const end = close(i);
      const inner = tk.d + 1;
      let j = i + 1;
      const obj = tk.v === '{';
      while (j < end - 1) {
        // One element: [...]rest | key[: pattern][= default] | pattern[= default]
        if (isP(j, ',')) {
          j++;
          continue;
        }
        if (isP(j, '...')) {
          j = pattern(j + 1, into);
        } else if (obj) {
          const keyIsId = isId(j);
          const keyEnd = isP(j, '[') ? close(j) : j + 1;
          if (isP(keyEnd, ':')) j = pattern(keyEnd + 1, into);
          else {
            if (keyIsId) into.add(t[j]!.v);
            j = keyEnd;
          }
        } else j = pattern(j, into);
        // Skip a default value to the next element separator at this depth.
        while (j < end - 1 && !(t[j]!.d === inner && isP(j, ','))) j++;
      }
      return end;
    }
    return i + 1;
  };

  /** export const|let|var a = ..., {b, c: d} = ...; returns the index after the declaration. */
  const declarators = (i: number): number => {
    const d = t[i - 1]!.d;
    let j = i;
    for (;;) {
      j = pattern(j, names);
      // Type annotation and initializer, up to the next declarator or the end of the statement.
      let angle = 0;
      while (j < t.length) {
        const tk = t[j]!;
        if (tk.d < d) return j;
        if (tk.d === d) {
          if (tk.k === 'p' && tk.v === ';') return j + 1;
          if (tk.k === 'p' && tk.v === '<') angle++;
          else if (tk.k === 'p' && tk.v === '>') angle = Math.max(0, angle - 1);
          else if (tk.k === 'p' && tk.v === '>>') angle = Math.max(0, angle - 2);
          else if (tk.k === 'p' && tk.v === '=') angle = 0;
          else if (tk.k === 'p' && tk.v === ',' && angle === 0) break;
          else if (tk.nl && tk.k === 'id' && STATEMENT_START.has(tk.v) && j > i) return j;
        }
        j++;
      }
      if (j >= t.length) return j;
      j++; // the ','
    }
  };

  /** export { a, b as c, type d } [from '...'] */
  const exportList = (i: number): number => {
    const end = close(i);
    let j = i + 1;
    while (j < end - 1) {
      if (isP(j, ',')) {
        j++;
        continue;
      }
      let first = j;
      if (isId(j, 'type') && (at(j + 1)?.k === 'id' || at(j + 1)?.k === 's') && !isId(j + 1, 'as')) first = j + 1;
      let name = at(first)?.v;
      j = first + 1;
      if (isId(j, 'as')) {
        name = at(j + 1)?.v;
        j += 2;
      }
      if (name !== undefined) names.add(name);
      while (j < end - 1 && !isP(j, ',')) j++;
    }
    return end;
  };

  /** module.exports = { a, b: 1, c() {}, 'd': 2, ...e } */
  const objectKeys = (i: number): void => {
    const end = close(i);
    const inner = t[i]!.d + 1;
    let j = i + 1;
    while (j < end - 1) {
      if (isP(j, '...')) {
        if (at(j + 1)) names.add(`...${at(j + 1)!.v}`);
      } else {
        let k = j;
        while ((isId(k, 'async') || isId(k, 'get') || isId(k, 'set') || isP(k, '*')) && (at(k + 1)?.k === 'id' || at(k + 1)?.k === 's' || at(k + 1)?.k === 'n' || isP(k + 1, '*'))) k++;
        const key = at(k);
        if (key && (key.k === 'id' || key.k === 's' || key.k === 'n')) names.add(key.v);
      }
      while (j < end - 1 && !(t[j]!.d === inner && isP(j, ','))) j++;
      j++;
    }
  };

  for (let i = 0; i < t.length; i++) {
    const tk = t[i]!;
    if (tk.k !== 'id' || afterDot(i)) continue;
    if (tk.d === 0 && tk.v === 'import' && !isP(i + 1, '(') && !isP(i + 1, '.')) esm = true;
    if (tk.d === 0 && tk.v === 'export') {
      esm = true;
      let j = i + 1;
      if (isId(j, 'declare')) j++;
      const nx = at(j);
      if (!nx) continue;
      if (nx.k === 'id' && nx.v === 'default') names.add('default');
      else if (nx.k === 'p' && nx.v === '*') {
        if (isId(j + 1, 'as') && at(j + 2)) names.add(at(j + 2)!.v);
        else {
          const from = isId(j + 1, 'from') && at(j + 2)?.k === 's' ? at(j + 2)!.v : '?';
          names.add(`* from '${from}'`);
        }
      } else if (nx.k === 'p' && nx.v === '{') i = exportList(j) - 1;
      else if (nx.k === 'p' && nx.v === '=') names.add('export=');
      else if (nx.k === 'id') {
        if (nx.v === 'const' && isId(j + 1, 'enum') && isId(j + 2)) names.add(at(j + 2)!.v);
        else if (nx.v === 'const' || nx.v === 'let' || nx.v === 'var') i = declarators(j + 1) - 1;
        else if (nx.v === 'type' && isP(j + 1, '{')) i = exportList(j + 1) - 1;
        else if (nx.v === 'import' && isId(j + 1)) names.add(at(j + 1)!.v);
        else {
          let k = j;
          while (isId(k, 'async') || isId(k, 'abstract')) k++;
          if (isId(k, 'function')) {
            k++;
            if (isP(k, '*')) k++;
            if (isId(k)) names.add(at(k)!.v);
          } else if (isId(k, 'class') && isId(k + 1) && !isId(k + 1, 'extends') && !isId(k + 1, 'implements')) names.add(at(k + 1)!.v);
          else if (DECL_KEYWORDS.has(at(k)!.v) && (isId(k + 1) || at(k + 1)?.k === 's')) names.add(at(k + 1)!.v);
        }
      }
      continue;
    }
    // CommonJS, at any depth (assignments under a condition still define the module's surface).
    const assign = (j: number): boolean => isP(j, '=');
    if (tk.v === 'exports') {
      if (isP(i + 1, '.') && isId(i + 2) && assign(i + 3)) names.add(at(i + 2)!.v);
      else if (isP(i + 1, '[') && at(i + 2)?.k === 's' && isP(i + 3, ']') && assign(i + 4)) names.add(at(i + 2)!.v);
    } else if (tk.v === 'module' && isP(i + 1, '.') && isId(i + 2, 'exports')) {
      if (assign(i + 3)) {
        names.add('module.exports');
        if (isP(i + 4, '{')) objectKeys(i + 4);
      } else if (isP(i + 3, '.') && isId(i + 4) && assign(i + 5)) names.add(at(i + 4)!.v);
      else if (isP(i + 3, '[') && at(i + 4)?.k === 's' && isP(i + 5, ']') && assign(i + 6)) names.add(at(i + 4)!.v);
    } else if (tk.v === 'Object' && isP(i + 1, '.') && isId(i + 2, 'defineProperty') && isP(i + 3, '(')) {
      let j = i + 4;
      if (isId(j, 'module') && isP(j + 1, '.') && isId(j + 2, 'exports')) j += 3;
      else if (isId(j, 'exports')) j += 1;
      else continue;
      if (isP(j, ',') && at(j + 1)?.k === 's') names.add(at(j + 1)!.v);
    }
  }
  return { names, esm };
}

/** The module's exported names (static analysis; see scan). Exported for tests. */
export function exportedNames(src: string): string[] {
  return [...scan(src).names].sort();
}

// ---------------------------------------------------------------- the edit check

export interface EditCheck {
  /** 'parsed' when the result was syntax-checked; 'not-checked' for a file outside the checked kinds. */
  syntax: 'parsed' | 'not-checked' | 'already-broken';
  /** Exported names the edit removed (all declared in removeExports). */
  removedExports: string[];
}

export interface EditCheckInput {
  rel: string;
  /** The current content (null for a new file). */
  before: string | null;
  after: string;
  /** 'replace' = an oldText/newText edit; 'write' = a whole-file write. */
  mode: 'replace' | 'write';
  /** Exported names the request declares it removes. */
  removeExports: readonly string[];
}

function located(rel: string, p: SyntaxProblem): string {
  return `${rel}${p.line !== null ? ` line ${p.line}` : ''}: ${p.message}`;
}

/**
 * Throws ToolInputError (nothing is written) when the resulting content of a JS/TS-family file does not
 * parse, or when it drops an exported name of the existing file that removeExports does not declare.
 * A partial edit of a file that already did not parse is not refused for that breakage alone (it was not
 * introduced by this edit, and fixing it may take several edits); a whole-file write must always parse.
 */
export async function checkEdit(i: EditCheckInput): Promise<EditCheck> {
  const kind = codeKindOf(i.rel);
  if (kind === null) return { syntax: 'not-checked', removedExports: [] };
  let syntax: EditCheck['syntax'] = 'parsed';
  const problem = await syntaxProblem(kind, i.after, i.rel);
  if (problem) {
    const preexisting = i.mode === 'replace' && i.before !== null && (await syntaxProblem(kind, i.before, i.rel)) !== null;
    if (!preexisting) throw new ToolInputError(`refused: the new content of ${located(i.rel, problem)}. Nothing was written; fix the code and write it again`);
    syntax = 'already-broken';
  }
  if (i.before === null) return { syntax, removedExports: [] };
  const kept = new Set(exportedNames(i.after));
  const removed = exportedNames(i.before).filter((n) => !kept.has(n));
  const undeclared = removed.filter((n) => !i.removeExports.includes(n));
  if (undeclared.length) {
    throw new ToolInputError(
      `refused: this edit of ${i.rel} removes exported name(s) ${undeclared.map((n) => JSON.stringify(n)).join(', ')} that other code may use. ` +
        'Nothing was written. Keep them (prefer a targeted {path, oldText, newText} edit over rewriting the file), or, if the removal is intended, declare it with removeExports: [names]',
    );
  }
  return { syntax, removedExports: removed };
}
