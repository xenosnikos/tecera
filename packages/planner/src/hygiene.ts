import { types } from 'node:util';
import { makeRedactor, type Json, type Redactor } from '@tecera/contracts';
import { sanitizeDecodedJson, scanBudget, scanDecoded, UNSCANNABLE, MAX_JSON_SCAN_DEPTH } from './decode.js';

/**
 * Planner output hygiene beyond the shared redactor (sprint-2 Codex planner findings).
 *
 * Decoded views (src/decode.ts, a verbatim copy of @tecera/providers src/decode.ts; planner does not
 * depend on providers, and a test fails when the copies drift). The contracts redactor finds known secrets
 * raw and in the encodings it enumerates. A model (or a hostile belief) can still carry one in a form it
 * does not enumerate: every character `\uXXXX`-escaped, `\xHH`, HTML numeric entities, base64/hex of an
 * escaped form. `scanDecoded` checks a string and its escape and token (base64/hex) decodings. A scan that
 * cannot be completed (more than MAX_TOKENS decodable tokens, a view still decodable at the last escape or
 * token layer, the work budget) reports UNSCANNABLE, which every caller treats as a hit.
 *
 * Complete scans. contracts containsSecret stops at depth 64 and skips accessors, so an incomplete walk
 * reads as clean. `deepSecretKind` walks EVERY depth iteratively, never invokes getters, and reports
 * UNSCANNABLE for anything it cannot inspect (an accessor, a Proxy, a non-plain value), so an incomplete
 * scan fails closed.
 */

export {
  MAX_DECODE_LAYERS,
  MAX_ESCAPE_LAYERS,
  MAX_TOKENS,
  MAX_JSON_SCAN_DEPTH,
  UNSCANNABLE,
  scanBudget,
  unescapeAll,
  decodeLayer,
  scanDecoded,
  scanJsonDeep,
  withheldMarker,
  sanitizeDecodedJson,
  type ScanBudget,
  type Check,
  type DecodedLayer,
} from './decode.js';

// ---------------------------------------------------------------------------------------------------------
// planner-specific helpers

/** A redactor that knows no values: SECRET_PATTERNS (key shapes, JWTs, TECERA_CANARY_*) only. */
let patternsOnly: Redactor | null = null;
export function patternRedactor(): Redactor {
  return (patternsOnly ??= makeRedactor([]));
}

/** Maximum nesting of a plan (Plan → steps → step → inputs → …). Deeper plans are rejected. */
export const MAX_PLAN_DEPTH = 32;

/** First secret kind in a string or any decoded view of it, using `r`; UNSCANNABLE if unbounded; else null. */
export function decodedSecretKind(s: string, r: Redactor): string | null {
  return scanDecoded(s, (t) => r.containsSecret(t), scanBudget(s.length));
}

/**
 * Nesting depth of a value (0 for a primitive), iterative, without invoking getters. Shared references are
 * measured along every path; a cycle therefore exceeds `limit` (the walk stops at limit + 1). Infinity for an accessor,
 * a Proxy or a non-plain object (it cannot be measured safely).
 */
export function inertDepth(value: unknown, limit = 10_000): number {
  let max = 0;
  const todo: Array<[unknown, number]> = [[value, 0]];
  let visited = 0;
  while (todo.length) {
    const [x, d] = todo.pop()!;
    if (x === null || typeof x !== 'object') {
      if (typeof x === 'function' || typeof x === 'symbol') return Infinity;
      continue;
    }
    if (++visited > 1_000_000 || types.isProxy(x)) return Infinity;
    const level = d + 1;
    if (level > max) max = level;
    if (max > limit) return max; // over the limit (a cycle ends here too)
    const proto: unknown = Object.getPrototypeOf(x);
    if (Array.isArray(x) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return Infinity;
    const descs = Object.getOwnPropertyDescriptors(x) as Record<string, PropertyDescriptor>;
    for (const k of Object.keys(descs)) {
      const desc = descs[k]!;
      if (desc.get || desc.set) return Infinity;
      if (Array.isArray(x) && k === 'length') continue;
      todo.push([desc.value, level]);
    }
  }
  return max;
}

/**
 * Kind of the first secret anywhere in `value` (strings and keys, at EVERY depth, each through its decoded
 * views), or UNSCANNABLE when part of it cannot be inspected safely (accessor, Proxy, non-plain object,
 * function, cycle, work bound). Never invokes getters or toJSON. Null only for a complete, clean scan.
 */
export function deepSecretKind(value: unknown, r: Redactor): string | null {
  const budget = scanBudget(0);
  const check = (t: string) => r.containsSecret(t);
  const todo: unknown[] = [value];
  const seen = new Set<object>();
  let visited = 0;
  while (todo.length) {
    const x = todo.pop();
    if (typeof x === 'string') {
      const h = scanDecoded(x, check, budget);
      if (h !== null) return h;
      continue;
    }
    if (x === null || x === undefined || typeof x === 'number' || typeof x === 'boolean') continue;
    if (typeof x !== 'object' || ++visited > 1_000_000 || types.isProxy(x)) return UNSCANNABLE;
    if (seen.has(x)) continue; // a shared reference or a cycle: its content is scanned once
    seen.add(x);
    const proto: unknown = Object.getPrototypeOf(x);
    if (Array.isArray(x) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return UNSCANNABLE;
    const descs = Object.getOwnPropertyDescriptors(x) as Record<string | symbol, PropertyDescriptor>;
    for (const k of Reflect.ownKeys(descs)) {
      if (typeof k === 'symbol') continue;
      const desc = descs[k]!;
      if (desc.get || desc.set) return UNSCANNABLE;
      if (Array.isArray(x) && k === 'length') continue;
      if (!Array.isArray(x)) {
        const h = scanDecoded(k, check, budget);
        if (h !== null) return h;
      }
      todo.push(desc.value);
    }
  }
  return null;
}

/**
 * Inert, redacted copy for display: redactJson over the WHOLE value (no truncation yet), then any string or
 * key whose decoded views still carry a secret is withheld, and only THEN each string is cut to `perString`.
 */
export function inertRedacted(value: unknown, r: Redactor, perString?: number): Json {
  const full = r.redactJson(value);
  const clean = sanitizeDecodedJson(full, (t) => r.containsSecret(t), scanBudget(0));
  return perString === undefined ? clean : capStrings(clean, perString);
}

function capStrings(v: Json, max: number, depth = 0): Json {
  if (typeof v === 'string') return v.length <= max ? v : `${v.slice(0, max)}…[truncated:${v.length - max}]`;
  if (v === null || typeof v !== 'object' || depth > MAX_JSON_SCAN_DEPTH) return v;
  if (Array.isArray(v)) return v.map((x) => capStrings(x, max, depth + 1));
  const out: { [k: string]: Json } = {};
  for (const k of Object.keys(v)) Object.defineProperty(out, k, { value: capStrings((v as { [k: string]: Json })[k]!, max, depth + 1), enumerable: true, writable: true, configurable: true });
  return out;
}
