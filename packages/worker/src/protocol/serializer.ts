import { randomBytes } from 'node:crypto';
import { makeRedactor, type Binding, type Inputs, type Json, type Redactor, type SecretInput } from '@tecera/contracts';

/**
 * The redacting serializer. Renders bindings for the worker prompt and is the only path from host
 * values to model-visible text. Rules:
 *   - value bindings render as JSON; handle bindings render as a method list; hidden bindings never render;
 *   - values are walked through own enumerable *data* properties only: getters, toJSON and inspect hooks
 *     are never called (a getter renders as "[getter]");
 *   - untrusted-provenance values are wrapped in <untrusted src nonce> with a per-exec random nonce, and
 *     the nonce and any (closing) untrusted tag are escaped out of the content so data cannot end the wrapper;
 *   - each value is capped at 50,000 chars and the whole input prefix at prefixRatio × the model budget;
 *   - every rendered value is redacted BEFORE it is truncated, with the shared contracts redactor (exact
 *     secrets and their encoded forms, cut secrets, SECRET_PATTERNS, TECERA_CANARY_*) → [REDACTED:<kind>:<sha8>];
 *   - provenance (`src`) is redacted in full BEFORE it is normalized to attribute characters or cut to 200.
 */

export const SERIALIZER_LIMITS = {
  perValueChars: 50_000,
  prefixRatio: 0.5,
  modelBudgetChars: 200_000,
  maxDepth: 32,
  maxArrayItems: 10_000,
} as const;

export interface SerializeView {
  /** Per-exec random nonce (newNonce()). */
  nonce: string;
  perValueChars?: number;
  modelBudgetChars?: number;
  prefixRatio?: number;
  /** Secret values resolved by the supervisor; redacted from the output. Ignored when `redactor` is given. */
  secrets?: readonly SecretInput[];
  redactor?: Redactor;
}

export interface Serialized {
  text: string;
  /** Binding names whose rendering was cut. */
  truncated: string[];
  /** Binding names not rendered: hidden, or dropped because the prefix budget ran out. */
  omitted: string[];
  chars: number;
}

export function newNonce(): string {
  return randomBytes(8).toString('hex');
}

// ---------------------------------------------------------------- safe walk

/**
 * Convert any value to Json without invoking user code: no getters, no toJSON, no Symbol.toPrimitive.
 * Cycles render as "[circular]", accessors as "[getter]", functions as "[function]".
 */
export function toSafeJson(v: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): Json {
  if (v === null) return null;
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v;
    case 'number':
      return Number.isFinite(v) ? v : String(v);
    case 'bigint':
      return `${v.toString()}n`;
    case 'undefined':
      return null;
    case 'function':
      return '[function]';
    case 'symbol':
      return '[symbol]';
  }
  const o = v as object;
  if (seen.has(o)) return '[circular]';
  if (depth >= SERIALIZER_LIMITS.maxDepth) return '[depth]';
  seen.add(o);
  try {
    if (Array.isArray(o)) {
      const lenDesc = Object.getOwnPropertyDescriptor(o, 'length');
      const len = lenDesc && 'value' in lenDesc && typeof lenDesc.value === 'number' ? lenDesc.value : 0;
      const out: Json[] = [];
      for (let i = 0; i < Math.min(len, SERIALIZER_LIMITS.maxArrayItems); i++) {
        const d = Object.getOwnPropertyDescriptor(o, String(i));
        out.push(!d ? null : 'value' in d ? toSafeJson(d.value, depth + 1, seen) : '[getter]');
      }
      if (len > SERIALIZER_LIMITS.maxArrayItems) out.push(`[${len - SERIALIZER_LIMITS.maxArrayItems} more items]`);
      return out;
    }
    const out: { [k: string]: Json } = {};
    for (const k of Object.keys(o)) {
      const d = Object.getOwnPropertyDescriptor(o, k);
      if (!d || !d.enumerable) continue;
      out[k] = 'value' in d ? toSafeJson(d.value, depth + 1, seen) : '[getter]';
    }
    return out;
  } finally {
    seen.delete(o);
  }
}

/** JSON text of any value without invoking user code. */
export function safeStringify(v: unknown): string {
  return JSON.stringify(toSafeJson(v));
}

// ---------------------------------------------------------------- untrusted wrapper

/** Escape content so it cannot reproduce the nonce or open/close an untrusted wrapper. */
export function escapeUntrusted(content: string, nonce: string): string {
  let out = nonce ? content.replace(new RegExp(escapeRe(nonce), 'gi'), '[nonce]') : content;
  out = out.replace(/<(\s*\/?\s*untrusted)/gi, '&lt;$1');
  return out;
}

/**
 * Wrap untrusted content. `src` is provenance (it can carry data: a path, a URL, an invoke id): with a
 * redactor it is redacted IN FULL before it is normalized to attribute characters and cut to 200 chars, so
 * a secret crossing the cut, or one the normalization would alter, is still recognized whole.
 */
export function wrapUntrusted(content: string, src: string, nonce: string, red?: Redactor): string {
  return `<untrusted src="${attr(red ? red.redactText(String(src)) : String(src))}" nonce="${nonce}">\n${escapeUntrusted(content, nonce)}\n</untrusted>`;
}

const attr = (s: string): string => s.replace(/[^A-Za-z0-9_.:/@+-]/g, '_').slice(0, 200);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function truncate(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  return { text: `${text.slice(0, Math.max(0, max))}…[truncated ${text.length - max} chars]`, cut: true };
}

// ---------------------------------------------------------------- inputs

function renderBinding(name: string, b: Binding, nonce: string, perValue: number, r: Redactor): { text: string; cut: boolean } | null {
  if (b.kind === 'hidden') return null;
  if (b.kind === 'handle') {
    const methods = b.methods.map((m) => `${m}()`).join(', ');
    return { text: r.redactText(`### ${name} (handle)\nmethods: ${methods}${b.description ? `\n${b.description}` : ''}`), cut: false };
  }
  // Redact first, then cut: a cut can never leave half a secret behind.
  const t = truncate(r.redactText(safeStringify(b.value)), perValue);
  const trust = b.provenance?.trust === 'trusted' ? 'trusted' : 'untrusted';
  // Provenance is redacted whole BEFORE it is normalized or cut (attr), never after.
  const src = r.redactText(String(b.provenance?.src ?? 'unknown'));
  const body = trust === 'untrusted' ? wrapUntrusted(t.text, src, nonce, r) : t.text;
  return { text: `### ${r.redactText(name)} (value, src=${attr(src)}, ${trust})\n${body}`, cut: t.cut };
}

/** Render the inputs for the prompt prefix. Handles first (small), then values in insertion order. */
export function serializeInputs(inputs: Inputs, view: SerializeView): Serialized {
  const perValue = view.perValueChars ?? SERIALIZER_LIMITS.perValueChars;
  const budget = Math.floor((view.modelBudgetChars ?? SERIALIZER_LIMITS.modelBudgetChars) * (view.prefixRatio ?? SERIALIZER_LIMITS.prefixRatio));
  const red = view.redactor ?? redactorFor(view.secrets ?? []);
  const entries = Object.keys(inputs).map((k) => [k, inputs[k]!] as const);
  entries.sort((a, b) => (a[1].kind === 'handle' ? 0 : 1) - (b[1].kind === 'handle' ? 0 : 1));
  const parts: string[] = [];
  const truncated: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const [name, b] of entries) {
    const r = renderBinding(name, b, view.nonce, perValue, red);
    if (!r) {
      omitted.push(name);
      continue;
    }
    let text = red.redactText(r.text);
    const remaining = budget - used;
    if (remaining <= 64) {
      omitted.push(name);
      continue;
    }
    if (text.length > remaining) {
      // Cut whole bindings at the budget; keep the wrapper closed so the boundary stays intact.
      const head = truncate(text, remaining - 64).text;
      text = b.kind === 'value' && b.provenance?.trust !== 'trusted' && !head.endsWith('</untrusted>') ? `${head}\n</untrusted>` : head;
      truncated.push(name);
    } else if (r.cut) truncated.push(name);
    parts.push(text);
    used += text.length + 2;
  }
  if (omitted.some((n) => inputs[n]?.kind !== 'hidden')) parts.push(`[omitted for budget: ${omitted.filter((n) => inputs[n]?.kind !== 'hidden').join(', ')}]`);
  const text = parts.join('\n\n');
  return { text, truncated, omitted, chars: text.length };
}

// ---------------------------------------------------------------- redaction

const cache = new WeakMap<readonly SecretInput[], Redactor>();
const EMPTY: readonly SecretInput[] = Object.freeze([]);

/**
 * The shared contracts redactor for a secrets list (cached per array instance). Throws RedactionError for
 * a secret shorter than 8 characters: such a value cannot be redacted reliably, so callers must fail closed.
 */
export function redactorFor(secrets: readonly SecretInput[] = EMPTY): Redactor {
  const hit = cache.get(secrets);
  if (hit) return hit;
  const r = makeRedactor(secrets);
  cache.set(secrets, r);
  return r;
}

/** Replace secrets (every encoded form), credential-shaped strings and canaries with markers. */
export function redact(text: string, secrets: readonly SecretInput[] = EMPTY): string {
  if (typeof text !== 'string') return '';
  return redactorFor(secrets).redactText(text);
}

/** Redact every string leaf (and key) of a value without invoking getters or toJSON. */
export function redactJson(v: unknown, secrets: readonly SecretInput[] = EMPTY): Json {
  return redactorFor(secrets).redactJson(v);
}
