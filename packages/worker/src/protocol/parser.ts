import { Script } from 'node:vm';

/**
 * The never-raising program parser. Model output is hostile text; this module extracts exactly one JS
 * function body (one ```js / ```javascript / bare ``` fence, or the raw text when there is no fence),
 * enforces a size cap, rejects escape vocabulary and syntax errors, and returns {ok, code} or
 * {ok:false, reason}. It never throws and never runs the code: the syntax check compiles a wrapper with
 * vm.Script and discards it. The checks are defence in depth; the sandbox flags are the real boundary.
 */

export type ParseResult = { ok: true; code: string } | { ok: false; reason: string };

export const PARSER_LIMITS = { maxChars: 64 * 1024 } as const;

const JS_LANGS = new Set(['', 'js', 'javascript', 'mjs', 'node']);
const RESERVED = '(?:__history__|__depth__|__capabilities__)';

/** Rules over code with comments and string contents removed. */
const CODE_RULES: Array<{ re: RegExp; why: string }> = [
  { re: /\bimport\b/, why: 'import is not available' },
  { re: /\brequire\b/, why: 'require is not available' },
  { re: /\bwith\s*\(/, why: 'with statements are not allowed' },
  { re: /\beval\b/, why: 'eval is not available' },
  { re: /\bFunction\b/, why: 'the Function constructor is not available' },
  { re: /\bprocess\b/, why: 'process is not available' },
  { re: /\bglobalThis\b/, why: 'globalThis is not available' },
  { re: /\bReflect\s*\.\s*construct\b/, why: 'Reflect.construct is not available' },
  { re: /\bconstructor\s*\.\s*constructor\b/, why: 'constructor.constructor is not allowed' },
  { re: /\b__proto__\b/, why: '__proto__ is not allowed' },
  { re: new RegExp(`\\b${RESERVED}\\s*(?:=(?!=)|\\+\\+|--|[-+*/%&|^]=|\\?\\?=|\\|\\|=|&&=)`), why: 'reserved bindings cannot be reassigned' },
  { re: new RegExp(`\\b(?:let|const|var|function|class)\\s+${RESERVED}\\b`), why: 'reserved bindings cannot be redeclared' },
];

/** Rules over the raw text (strings and comments included): spellings that have no legitimate use. */
const RAW_RULES: Array<{ re: RegExp; why: string }> = [
  { re: /__proto__/, why: '__proto__ is not allowed' },
  { re: /constructor\s*["'`]?\s*\]?\s*(?:\.|\[)\s*["'`]?\s*constructor/, why: 'constructor.constructor is not allowed' },
  { re: /\bReflect\s*(?:\.|\[\s*["'`])\s*construct\b/, why: 'Reflect.construct is not available' },
  { re: /\bawait\s+import\b/, why: 'dynamic import is not available' },
  { re: /\bimport\s*\(/, why: 'dynamic import is not available' },
];

/** String literals whose whole content is one of these are computed-member escapes (x["constructor"]). */
const FORBIDDEN_STRINGS = new Set(['constructor', '__proto__', 'globalThis', 'process', 'eval', 'Function', 'require', 'import', 'prototype', 'mainModule', '__defineGetter__', '__defineSetter__', '__lookupGetter__']);

interface Lexed {
  code: string;
  strings: string[];
}

const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const REGEX_AFTER_PAREN_OF = new Set(['if', 'while', 'for', 'with']);
const IDENT_CHAR = /[A-Za-z0-9_$\\]/;

/**
 * Split source into code (strings, comments and, when regexAware, regex literals blanked) and string
 * literal contents. Never throws. Two lexings run: one that never sees regex literals and one that
 * classifies `/` by the preceding token; a forbidden identifier hidden from one (a quote inside a regex,
 * a regex-looking division) is visible to the other, and the program is rejected if EITHER finds it.
 */
function lex(src: string, regexAware: boolean): Lexed {
  let code = '';
  const strings: string[] = [];
  const braces: number[] = []; // template-expression brace depth stack
  const parens: string[] = []; // word before each open paren (regexAware)
  let lastSig = '';
  let lastWord = '';
  let lastParenWord = '';
  let i = 0;
  const n = src.length;
  let prevIdent = false;
  const emit = (s: string): void => {
    code += s;
    for (const ch of s) {
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        prevIdent = false;
        continue;
      }
      if (IDENT_CHAR.test(ch)) {
        lastWord = prevIdent ? lastWord + ch : ch;
        prevIdent = true;
      } else {
        lastWord = '';
        prevIdent = false;
      }
      lastSig = ch;
    }
  };
  const readTemplate = (): void => {
    // i points just past the opening backtick (or the closing brace of an expression).
    let buf = '';
    while (i < n) {
      const c = src[i]!;
      if (c === '\\') {
        buf += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '`') {
        strings.push(buf);
        emit('``');
        i++;
        return;
      }
      if (c === '$' && src[i + 1] === '{') {
        strings.push(buf);
        emit('`${');
        i += 2;
        braces.push(0);
        return;
      }
      buf += c;
      i++;
    }
    strings.push(buf);
  };
  const regexAllowed = (): boolean => {
    if (lastSig === '') return true;
    if (lastWord) return REGEX_AFTER_WORD.has(lastWord);
    if (lastSig === ')') return REGEX_AFTER_PAREN_OF.has(lastParenWord);
    if (lastSig === ']') return false;
    return true; // operators, punctuation, `}`
  };
  /** Try to read a regex literal at i (src[i] === '/'). Returns false when no closing slash on the line. */
  const readRegex = (): boolean => {
    let j = i + 1;
    let inClass = false;
    while (j < n) {
      const c = src[j]!;
      if (c === '\n' || c === '\r') return false;
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (inClass) {
        if (c === ']') inClass = false;
      } else if (c === '[') inClass = true;
      else if (c === '/') break;
      j++;
    }
    if (j >= n) return false;
    j++;
    while (j < n && /[A-Za-z]/.test(src[j]!)) j++;
    i = j;
    emit(' 0 ');
    return true;
  };
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      code += ' ';
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      code += ' ';
      continue;
    }
    if (regexAware && c === '/' && regexAllowed() && readRegex()) continue;
    if (c === '"' || c === "'") {
      let buf = '';
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') {
          buf += src.slice(i, i + 2);
          i += 2;
        } else buf += src[i++];
      }
      i++;
      strings.push(buf);
      emit('""');
      continue;
    }
    if (c === '`') {
      i++;
      readTemplate();
      continue;
    }
    if (braces.length) {
      if (c === '{') braces[braces.length - 1]!++;
      else if (c === '}') {
        if (braces[braces.length - 1] === 0) {
          braces.pop();
          emit('}');
          i++;
          readTemplate();
          continue;
        }
        braces[braces.length - 1]!--;
      }
    }
    if (regexAware) {
      if (c === '(') parens.push(lastWord);
      else if (c === ')') lastParenWord = parens.pop() ?? '';
    }
    emit(c);
    i++;
  }
  return { code, strings };
}

/** Decode identifier escapes (`ev\\u0061l`, `\\u{65}val`) so the vocabulary rules see the real names. */
function normalizeIdentifiers(code: string): string {
  return code.replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g, (_m, a: string | undefined, b: string | undefined) => {
    const v = parseInt((a ?? b)!, 16);
    return v <= 0x10ffff ? String.fromCodePoint(v) : '';
  });
}

function unescapeLiteral(s: string): string {
  return s.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})|\\(.)/g, (_m, a: string, b: string, x: string, ch: string) => {
    const cp = a ?? b ?? x;
    if (cp) {
      const v = parseInt(cp, 16);
      return v <= 0x10ffff ? String.fromCodePoint(v) : '';
    }
    return ch ?? '';
  });
}

/** Pull the single JS body out of a model reply. */
function extract(raw: string): ParseResult {
  const fence = /```[ \t]*([A-Za-z0-9_+-]*)[^\n]*\n([\s\S]*?)```/g;
  const blocks: Array<{ lang: string; body: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = fence.exec(raw)) !== null) blocks.push({ lang: (m[1] ?? '').toLowerCase(), body: m[2] ?? '' });
  if (blocks.length) {
    const js = blocks.filter((b) => JS_LANGS.has(b.lang));
    if (js.length === 0) return { ok: false, reason: `no js code block (found ${blocks.map((b) => b.lang || 'plain').join(', ')})` };
    if (js.length > 1) return { ok: false, reason: `expected exactly one js code block, found ${js.length}` };
    return { ok: true, code: js[0]!.body.trim() };
  }
  const open = /^\s*```[ \t]*([A-Za-z0-9_+-]*)[^\n]*\n/.exec(raw);
  if (open) {
    if (!JS_LANGS.has((open[1] ?? '').toLowerCase())) return { ok: false, reason: 'unterminated non-js code block' };
    return { ok: true, code: raw.slice(open[0].length).trim() };
  }
  if (raw.includes('```')) return { ok: false, reason: 'malformed code fence' };
  return { ok: true, code: raw.trim() };
}

export function parseProgram(raw: unknown, opts: { maxChars?: number } = {}): ParseResult {
  try {
    const max = opts.maxChars ?? PARSER_LIMITS.maxChars;
    if (typeof raw !== 'string') return { ok: false, reason: 'model output is not text' };
    if (raw.length > max * 4) return { ok: false, reason: `model output exceeds ${max * 4} chars` };
    const ex = extract(raw);
    if (!ex.ok) return ex;
    const code = ex.code;
    if (code.length === 0) return { ok: false, reason: 'empty program' };
    if (code.length > max) return { ok: false, reason: `program exceeds ${max} chars` };
    if (code.includes('\0')) return { ok: false, reason: 'program contains NUL' };
    for (const r of RAW_RULES) if (r.re.test(code)) return { ok: false, reason: r.why };
    for (const regexAware of [false, true]) {
      const lx = lex(code, regexAware);
      const idents = normalizeIdentifiers(lx.code);
      for (const r of CODE_RULES) if (r.re.test(idents)) return { ok: false, reason: r.why };
      for (const s of lx.strings) {
        const u = unescapeLiteral(s).trim();
        if (FORBIDDEN_STRINGS.has(u)) return { ok: false, reason: `string literal "${u}" is not allowed (computed member escape)` };
        if (u.includes('__proto__')) return { ok: false, reason: '__proto__ is not allowed' };
      }
    }
    try {
      // Compile only (never run): the child compiles the same body as an async function.
      new Script(`(async function __tecera_program__() {\n${code}\n})`, { filename: 'program.js' });
    } catch (e) {
      return { ok: false, reason: `syntax error: ${(e as Error).message}` };
    }
    return { ok: true, code };
  } catch (e) {
    return { ok: false, reason: `parser failure: ${e instanceof Error ? e.message : 'unknown'}` };
  }
}
