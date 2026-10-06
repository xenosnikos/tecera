import { sha256, type Json } from './json.js';
import { SECRET_PATTERNS } from './manifest.js';

/**
 * The one shared redaction implementation (docs/design/security.md §7). Pure: no I/O, no globals.
 *
 * - Known secrets are replaced in their exact form and in every encoding a prompt, log or ledger row is
 *   likely to carry them in: JSON-escaped (once and twice), base64 and base64url (padded, unpadded, and the
 *   cores at all three byte alignments so a value embedded in a larger blob is caught), hex (both cases),
 *   URL encoding (encodeURIComponent, `+` for space, full per-byte percent encoding in both cases). A text
 *   that ends with a prefix, or starts with a suffix, of a raw secret (>= 8 chars) is treated as a cut
 *   secret and redacted too.
 * - Then every SECRET_PATTERNS match (key shapes, JWTs, TECERA_CANARY_[A-Za-z0-9_]+), known or not.
 * - Marker: `[REDACTED:<kind>:<sha8>]`, sha8 = first 8 hex chars of sha256(original value or match). It is
 *   stable for a given value and never itself matches a needle or pattern, so redaction is idempotent.
 * - Secrets shorter than MIN_SECRET_CHARS are refused at construction (throw) so they cannot silently
 *   pass unredacted. Error messages never contain a secret.
 * - Redaction runs BEFORE truncation (`maxChars`), so a cut can never leave a partial secret behind.
 * - redactJson walks own enumerable data properties only. It never invokes getters, setters, toJSON,
 *   valueOf or toString; an accessor property becomes '[unserializable:getter]'. Depth is bounded.
 */

export const MIN_SECRET_CHARS = 8;
export const DEFAULT_REDACT_DEPTH = 64;
export const GETTER_MARKER = '[unserializable:getter]';
export const CYCLE_MARKER = '[unserializable:cycle]';
export const ERROR_MARKER = '[unserializable:error]';
export const DEPTH_MARKER = '[truncated:depth]';

export type SecretInput = string | { kind: string; value: string };

export interface RedactTextOptions {
  /** Truncate the REDACTED text to this many characters (plus a `…[truncated:<n>]` suffix). */
  maxChars?: number;
}

export interface RedactJsonOptions extends RedactTextOptions {
  /** Maximum nesting depth; deeper values become '[truncated:depth]'. Default 64. */
  maxDepth?: number;
}

export interface Redactor {
  redactText(text: string, opts?: RedactTextOptions): string;
  redactJson(value: unknown, opts?: RedactJsonOptions): Json;
  /** Kind of the first secret or pattern found (for canary scans), or null. Never returns the value. */
  containsSecret(input: unknown): string | null;
}

export class RedactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedactionError';
  }
}

export function sha8(value: string): string {
  return sha256(value).slice(0, 8);
}

export function redactionMarker(kind: string, digest8: string): string {
  return `[REDACTED:${kind}:${digest8}]`;
}

const GLOBAL_PATTERNS = SECRET_PATTERNS.map((p) => ({ kind: p.kind, re: new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : `${p.re.flags}g`) }));
/** Canary pattern with the underscore-inclusive tail, applied even if SECRET_PATTERNS is narrower. */
const CANARY_RE = /TECERA_CANARY_[A-Za-z0-9_]+/g;

function base64Cores(bytes: Buffer, url: boolean): string[] {
  const out: string[] = [];
  for (let k = 0; k < 3; k++) {
    const enc = Buffer.concat([Buffer.alloc(k), bytes]).toString(url ? 'base64url' : 'base64');
    const start = Math.ceil((8 * k) / 6);
    const end = Math.floor((8 * (k + bytes.length)) / 6);
    out.push(enc.slice(start, end));
  }
  return out;
}

function asciiEscaped(v: string): string {
  return JSON.stringify(v)
    .slice(1, -1)
    .replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Every encoded form of `value` the redactor searches for. */
export function secretNeedles(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8');
  const hex = bytes.toString('hex');
  const pct = [...bytes].map((b) => '%' + b.toString(16).padStart(2, '0')).join('');
  const uri = encodeURIComponent(value);
  const json1 = JSON.stringify(value).slice(1, -1);
  const json2 = JSON.stringify(JSON.stringify(value)).slice(1, -1);
  const b64 = bytes.toString('base64');
  const set = new Set<string>([
    value,
    json1,
    json2,
    asciiEscaped(value),
    b64,
    b64.replace(/=+$/, ''),
    bytes.toString('base64url'),
    ...base64Cores(bytes, false),
    ...base64Cores(bytes, true),
    hex,
    hex.toUpperCase(),
    uri,
    uri.replace(/%20/g, '+'),
    uri.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
    pct,
    pct.toUpperCase(),
  ]);
  return [...set].filter((n) => n.length >= MIN_SECRET_CHARS);
}

interface Entry {
  kind: string;
  value: string;
  mark: string;
}

function normalizeSecrets(secrets: readonly SecretInput[]): Entry[] {
  if (!Array.isArray(secrets)) throw new RedactionError('secrets must be an array');
  const out: Entry[] = [];
  secrets.forEach((s, i) => {
    const kind = typeof s === 'string' ? 'secret' : s?.kind;
    const value = typeof s === 'string' ? s : s?.value;
    if (typeof kind !== 'string' || !/^[A-Za-z0-9_.-]{1,40}$/.test(kind)) throw new RedactionError(`secret #${i} has an invalid kind`);
    if (typeof value !== 'string') throw new RedactionError(`secret #${i} (${kind}) is not a string`);
    if (value.length < MIN_SECRET_CHARS) throw new RedactionError(`secret #${i} (${kind}) is shorter than ${MIN_SECRET_CHARS} characters and cannot be redacted reliably; refusing`);
    out.push({ kind, value, mark: redactionMarker(kind, sha8(value)) });
  });
  return out;
}

const OMIT = Symbol('omit');

class Impl implements Redactor {
  private readonly pairs: Array<{ needle: string; mark: string; kind: string }>;
  private readonly entries: Entry[];

  constructor(secrets: readonly SecretInput[]) {
    this.entries = normalizeSecrets(secrets);
    const pairs: Array<{ needle: string; mark: string; kind: string }> = [];
    for (const e of this.entries) for (const n of secretNeedles(e.value)) pairs.push({ needle: n, mark: e.mark, kind: e.kind });
    pairs.sort((a, b) => b.needle.length - a.needle.length);
    this.pairs = pairs;
  }

  redactText(text: string, opts: RedactTextOptions = {}): string {
    if (typeof text !== 'string') throw new RedactionError('redactText expects a string');
    let out = text;
    for (const p of this.pairs) if (out.includes(p.needle)) out = out.split(p.needle).join(p.mark);
    out = this.redactCutEdges(out);
    for (const p of GLOBAL_PATTERNS) out = out.replace(p.re, (m) => redactionMarker(p.kind, sha8(m)));
    out = out.replace(CANARY_RE, (m) => redactionMarker('canary', sha8(m)));
    return truncate(out, opts.maxChars);
  }

  /** A text cut mid-secret upstream: a tail that is a secret prefix, or a head that is a secret suffix. */
  private redactCutEdges(text: string): string {
    let out = text;
    for (const e of this.entries) {
      const v = e.value;
      for (let n = Math.min(v.length - 1, out.length); n >= MIN_SECRET_CHARS; n--) {
        if (out.endsWith(v.slice(0, n))) {
          out = out.slice(0, out.length - n) + e.mark;
          break;
        }
      }
      for (let n = Math.min(v.length - 1, out.length); n >= MIN_SECRET_CHARS; n--) {
        if (out.startsWith(v.slice(v.length - n))) {
          out = e.mark + out.slice(n);
          break;
        }
      }
    }
    return out;
  }

  redactJson(value: unknown, opts: RedactJsonOptions = {}): Json {
    const maxDepth = opts.maxDepth ?? DEFAULT_REDACT_DEPTH;
    const r = walk(value, 0, maxDepth, [], (s) => this.redactText(s, { maxChars: opts.maxChars }), (k) => this.redactText(k));
    return r === OMIT ? null : r;
  }

  containsSecret(input: unknown): string | null {
    let hit: string | null = null;
    const check = (s: string): string => {
      if (hit === null) hit = this.kindIn(s);
      return s;
    };
    if (typeof input === 'string') return this.kindIn(input);
    walk(input, 0, DEFAULT_REDACT_DEPTH, [], check, check);
    return hit;
  }

  private kindIn(s: string): string | null {
    for (const p of this.pairs) if (s.includes(p.needle)) return p.kind;
    for (const e of this.entries) {
      const v = e.value;
      for (let n = Math.min(v.length - 1, s.length); n >= MIN_SECRET_CHARS; n--) {
        if (s.endsWith(v.slice(0, n)) || s.startsWith(v.slice(v.length - n))) return e.kind;
      }
    }
    for (const p of GLOBAL_PATTERNS) {
      p.re.lastIndex = 0;
      if (p.re.test(s)) {
        p.re.lastIndex = 0;
        return p.kind;
      }
    }
    CANARY_RE.lastIndex = 0;
    const canary = CANARY_RE.test(s);
    CANARY_RE.lastIndex = 0;
    return canary ? 'canary' : null;
  }
}

function truncate(s: string, maxChars: number | undefined): string {
  if (maxChars === undefined || !(maxChars >= 0) || s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}…[truncated:${s.length - maxChars}]`;
}

/** Safe structural walk: own enumerable data properties only; no getters, toJSON, valueOf or toString. */
function walk(v: unknown, depth: number, maxDepth: number, stack: object[], onString: (s: string) => string, onKey: (k: string) => string): Json | typeof OMIT {
  try {
    if (v === null) return null;
    switch (typeof v) {
      case 'string':
        return onString(v);
      case 'number':
        return Number.isFinite(v) ? v : null;
      case 'boolean':
        return v;
      case 'bigint':
        return '[unserializable:bigint]';
      case 'undefined':
      case 'function':
      case 'symbol':
        return OMIT;
    }
    const obj = v as object;
    if (depth >= maxDepth) return DEPTH_MARKER;
    if (stack.includes(obj)) return CYCLE_MARKER;
    stack.push(obj);
    try {
      if (Array.isArray(obj)) {
        const lenDesc = Object.getOwnPropertyDescriptor(obj, 'length');
        const len = lenDesc && 'value' in lenDesc && typeof lenDesc.value === 'number' ? lenDesc.value : 0;
        const out: Json[] = [];
        for (let i = 0; i < len; i++) {
          const d = Object.getOwnPropertyDescriptor(obj, String(i));
          if (!d) {
            out.push(null);
            continue;
          }
          if (d.get || d.set || !('value' in d)) {
            out.push(GETTER_MARKER);
            continue;
          }
          const r = walk(d.value, depth + 1, maxDepth, stack, onString, onKey);
          out.push(r === OMIT ? null : r);
        }
        return out;
      }
      const out: { [k: string]: Json } = {};
      for (const k of Object.keys(obj)) {
        const d = Object.getOwnPropertyDescriptor(obj, k);
        if (!d || !d.enumerable) continue;
        let r: Json | typeof OMIT;
        if (d.get || d.set || !('value' in d)) r = GETTER_MARKER;
        else r = walk(d.value, depth + 1, maxDepth, stack, onString, onKey);
        if (r === OMIT) continue;
        let key = onKey(k);
        for (let n = 2; Object.prototype.hasOwnProperty.call(out, key); n++) key = `${onKey(k)}~${n}`;
        Object.defineProperty(out, key, { value: r, enumerable: true, writable: true, configurable: true });
      }
      return out;
    } finally {
      stack.pop();
    }
  } catch {
    return ERROR_MARKER;
  }
}

/** Build a redactor over `secrets`. Throws RedactionError for any secret shorter than 8 characters. */
export function makeRedactor(secrets: readonly SecretInput[]): Redactor {
  return new Impl(secrets);
}

export function redactText(text: string, secrets: readonly SecretInput[], opts?: RedactTextOptions): string {
  return makeRedactor(secrets).redactText(text, opts);
}

export function redactJson(value: unknown, secrets: readonly SecretInput[], opts?: RedactJsonOptions): Json {
  return makeRedactor(secrets).redactJson(value, opts);
}

export function containsSecret(input: unknown, secrets: readonly SecretInput[]): string | null {
  return makeRedactor(secrets).containsSecret(input);
}
