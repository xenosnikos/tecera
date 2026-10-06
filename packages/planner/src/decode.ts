import type { Json } from '@tecera/contracts';

/**
 * Decoded-view secret scanning. The shared redactor (contracts) finds known secrets in their raw form and
 * in the encodings it enumerates (JSON-escaped, base64, hex, URL). A model can still emit a secret in a
 * form it does not enumerate: every character `\uXXXX`-escaped inside structured JSON text, `\xHH`, HTML
 * numeric entities, base64 or hex of an already-escaped form, and so on. `scanDecoded` therefore checks a
 * string and its decoded views:
 *
 * - escape layers: escape sequences decoded (JSON / JS `\uXXXX`, `\u{…}`, `\xHH`, short escapes, `&#…;`
 *   entities) and percent-encoded runs decoded. Every escape decoding strictly shortens the string, so a
 *   chain of them is cheap; up to MAX_ESCAPE_LAYERS nested escape layers are followed.
 * - token layers: every base64 / base64url token (at all four alignments) and every hex token whose bytes
 *   decode to printable UTF-8 text. Up to MAX_DECODE_LAYERS nested token layers are followed, and at most
 *   MAX_TOKENS decodable tokens per string per layer.
 *
 * A scan is complete or it is a hit. Fail closed, never a clean result for an incomplete scan:
 * - more than MAX_TOKENS decodable tokens in one string → UNSCANNABLE (the rest would go unread);
 * - a view at the last escape layer that still decodes further → UNSCANNABLE;
 * - a view at the last token layer that still carries decodable tokens → UNSCANNABLE;
 * - the work budget (characters of decoded views) runs out → UNSCANNABLE.
 * Callers treat UNSCANNABLE like any secret kind: a request is refused, an output is refused or withheld.
 *
 * This file is shared verbatim by @tecera/providers (src/decode.ts) and @tecera/planner (src/decode.ts);
 * a planner test fails when the two copies drift. Proposed for contracts redact.ts.
 */

/** Nested token (base64 / base64url / hex) decodings that are followed. */
export const MAX_DECODE_LAYERS = 3;
/** Nested escape / entity / percent decodings that are followed. */
export const MAX_ESCAPE_LAYERS = 8;
/** Distinct decodable tokens (tokens with at least one printable decoded view) per string per layer. */
export const MAX_TOKENS = 512;
export const UNSCANNABLE = 'unscannable';
export const MAX_JSON_SCAN_DEPTH = 512;

export interface ScanBudget {
  left: number;
}

export type Check = (s: string) => string | null;

export function scanBudget(forChars: number): ScanBudget {
  return { left: 2_000_000 + 8 * forChars };
}

const ESCAPE_TEST = /\\(?:u[0-9a-fA-F]{4}|u\{[0-9a-fA-F]{1,6}\}|x[0-9a-fA-F]{2}|[\\"'/bfnrtv0])|&#(?:[xX][0-9a-fA-F]{1,6}|[0-9]{1,7});?|%[0-9a-fA-F]{2}/;
const ESCAPE_RE = /\\(?:u([0-9a-fA-F]{4})|u\{([0-9a-fA-F]{1,6})\}|x([0-9a-fA-F]{2})|([\\"'/bfnrtv0]))|&#(?:[xX]([0-9a-fA-F]{1,6})|([0-9]{1,7}));?/g;
const SHORT: Readonly<Record<string, string>> = { '\\': '\\', '"': '"', "'": "'", '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '0': '\0' };
const PCT_RUN = /(?:%[0-9a-fA-F]{2})+/g;
const B64_TOKEN = /[A-Za-z0-9+/_-]{12,}={0,2}/g;
const HEX_TOKEN = /(?:[0-9a-fA-F]{2}){6,}/g;

function cp(n: number): string {
  return n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

/** Decode escape sequences, entities and percent-encoded runs (one layer). */
export function unescapeAll(s: string): string {
  const once = s.replace(ESCAPE_RE, (_m, u4: string, ub: string, x2: string, short: string, hx: string, dec: string) => {
    if (u4) return String.fromCharCode(parseInt(u4, 16));
    if (ub) return cp(parseInt(ub, 16));
    if (x2) return String.fromCharCode(parseInt(x2, 16));
    if (short) return SHORT[short] ?? short;
    if (hx) return cp(parseInt(hx, 16));
    if (dec) return cp(parseInt(dec, 10));
    return _m;
  });
  return once.replace(PCT_RUN, (run) => {
    const bytes = Buffer.from(run.replace(/%/g, ''), 'hex');
    return textOf(bytes) ?? run;
  });
}

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Bytes as text when they are valid UTF-8 and mostly printable; otherwise null. */
function textOf(bytes: Uint8Array): string | null {
  if (bytes.length < 6) return null;
  let t: string;
  try {
    t = STRICT_UTF8.decode(bytes);
  } catch {
    return null;
  }
  let printable = 0;
  for (const ch of t) {
    const c = ch.codePointAt(0)!;
    if (c === 9 || c === 10 || c === 13 || (c >= 0x20 && c < 0x7f) || c >= 0xa0) printable++;
  }
  return printable / Math.max(1, [...t].length) >= 0.9 ? t : null;
}

/** One layer of decoded views of a string. */
export interface DecodedLayer {
  /** The escape/entity/percent decoding, when it differs from the input. */
  unescaped: string | null;
  /** Printable decodings of base64/base64url/hex tokens (each differs from the input). */
  tokens: string[];
  /** True when more than MAX_TOKENS decodable tokens were found: the views are NOT complete. */
  exhausted: boolean;
}

/** One layer of decoded views of `s`. `exhausted` means the token views are incomplete (fail closed). */
export function decodeLayer(s: string): DecodedLayer {
  let unescaped: string | null = null;
  if (ESCAPE_TEST.test(s)) {
    const u = unescapeAll(s);
    if (u !== s) unescaped = u;
  }
  const tokens: string[] = [];
  const seen = new Set<string>();
  let decodable = 0;
  for (const m of s.matchAll(B64_TOKEN)) {
    const tok = m[0].replace(/=+$/, '');
    if (seen.has(tok)) continue; // an identical token has identical views
    seen.add(tok);
    const url = /[-_]/.test(tok);
    let any = false;
    for (let k = 0; k < 4 && tok.length - k >= 12; k++) {
      const t = textOf(Buffer.from(tok.slice(k), url ? 'base64url' : 'base64'));
      if (t !== null && t !== s) {
        if (!any && ++decodable > MAX_TOKENS) return { unescaped, tokens, exhausted: true };
        any = true;
        tokens.push(t);
      }
    }
  }
  seen.clear();
  for (const m of s.matchAll(HEX_TOKEN)) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    let any = false;
    for (let k = 0; k < 2; k++) {
      const h = m[0].slice(k, m[0].length - ((m[0].length - k) % 2));
      const t = textOf(Buffer.from(h, 'hex'));
      if (t !== null && t !== s) {
        if (!any && ++decodable > MAX_TOKENS) return { unescaped, tokens, exhausted: true };
        any = true;
        tokens.push(t);
      }
    }
  }
  return { unescaped, tokens, exhausted: false };
}

/**
 * First secret kind in `s` or in any decoded view of it, else null. UNSCANNABLE (a hit) when the scan
 * cannot be completed: too many decodable tokens, a view still decodable at the last escape or token
 * layer, or the work budget exhausted. `layer` counts token layers, `escapes` escape layers.
 */
export function scanDecoded(s: string, check: Check, budget: ScanBudget = scanBudget(s.length), layer = 0, escapes = 0): string | null {
  const hit = check(s);
  if (hit !== null) return hit;
  const d = decodeLayer(s);
  if (d.exhausted) return UNSCANNABLE;
  if (d.unescaped !== null) {
    if (escapes >= MAX_ESCAPE_LAYERS) return UNSCANNABLE;
    budget.left -= d.unescaped.length + 64;
    if (budget.left < 0) return UNSCANNABLE;
    const h = scanDecoded(d.unescaped, check, budget, layer, escapes + 1);
    if (h !== null) return h;
  }
  if (d.tokens.length) {
    if (layer >= MAX_DECODE_LAYERS) return UNSCANNABLE;
    for (const v of d.tokens) {
      budget.left -= v.length + 64;
      if (budget.left < 0) return UNSCANNABLE;
      const h = scanDecoded(v, check, budget, layer + 1, escapes);
      if (h !== null) return h;
    }
  }
  return null;
}

/**
 * Scan every string and key of a JSON-parsed (inert) value at every depth, each through scanDecoded.
 * Iterative; a value nested deeper than MAX_JSON_SCAN_DEPTH, or one that is not plain JSON, is UNSCANNABLE.
 */
export function scanJsonDeep(value: unknown, check: Check, budget: ScanBudget = scanBudget(0)): string | null {
  const todo: Array<[unknown, number]> = [[value, 0]];
  const seen = new Set<object>();
  while (todo.length) {
    const [x, d] = todo.pop()!;
    if (typeof x === 'string') {
      const h = scanDecoded(x, check, budget);
      if (h !== null) return h;
      continue;
    }
    if (x === null || typeof x === 'number' || typeof x === 'boolean' || x === undefined) continue;
    if (typeof x !== 'object' || d >= MAX_JSON_SCAN_DEPTH || seen.has(x)) return UNSCANNABLE;
    seen.add(x);
    const descs = Object.getOwnPropertyDescriptors(x) as Record<string, PropertyDescriptor>;
    for (const k of Object.keys(descs)) {
      const desc = descs[k]!;
      if (desc.get || desc.set) return UNSCANNABLE;
      if (Array.isArray(x) && k === 'length') continue;
      if (!Array.isArray(x)) {
        const h = scanDecoded(k, check, budget);
        if (h !== null) return h;
      }
      todo.push([desc.value, d + 1]);
    }
  }
  return null;
}

/** Marker for a string withheld because a decoded view of it carries a secret (or could not be scanned). */
export function withheldMarker(kind: string): string {
  return `[REDACTED:${/^[A-Za-z0-9_.-]{1,40}$/.test(kind) ? kind : 'secret'}:decoded]`;
}

/**
 * Replace every string (and key) of an already-redacted JSON value whose decoded views still carry a
 * secret, or that cannot be scanned completely, with a fixed marker. Anything that is not plain JSON
 * becomes null. Depth-bounded (the input comes from redactJson, which is itself depth-bounded).
 */
export function sanitizeDecodedJson(v: Json, check: Check, budget: ScanBudget = scanBudget(0), depth = 0): Json {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const h = scanDecoded(v, check, budget);
    return h === null ? v : withheldMarker(h);
  }
  if (typeof v !== 'object' || depth > MAX_JSON_SCAN_DEPTH) return null;
  if (Array.isArray(v)) return v.map((x) => sanitizeDecodedJson(x, check, budget, depth + 1));
  const out: { [k: string]: Json } = {};
  for (const k of Object.keys(v)) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    const val = d && 'value' in d ? (d.value as Json) : null;
    const kh = scanDecoded(k, check, budget);
    let key = kh === null ? k : withheldMarker(kh);
    for (let n = 2; Object.prototype.hasOwnProperty.call(out, key); n++) key = `${kh === null ? k : withheldMarker(kh)}~${n}`;
    Object.defineProperty(out, key, { value: sanitizeDecodedJson(val, check, budget, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return out;
}
