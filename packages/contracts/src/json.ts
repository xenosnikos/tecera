import { createHash } from 'node:crypto';

/** JSON-serializable value. Everything that crosses a process or ledger boundary is Json. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** Values JSON.stringify omits from objects and renders as null inside arrays. */
function isOmitted(v: unknown): boolean {
  return v === undefined || typeof v === 'function' || typeof v === 'symbol';
}

function canon(value: unknown, stack: object[]): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      // JSON semantics: NaN and ±Infinity become null.
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'bigint':
      throw new TypeError('canonicalJson: bigint is not JSON');
    case 'undefined':
    case 'function':
    case 'symbol':
      throw new TypeError(`canonicalJson: a top-level ${typeof value} is not JSON`);
  }
  const obj = value as object;
  if (stack.includes(obj)) throw new TypeError('canonicalJson: cyclic value');
  stack.push(obj);
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (let i = 0; i < obj.length; i++) {
        const v: unknown = obj[i];
        parts.push(isOmitted(v) ? 'null' : canon(v, stack));
      }
      return `[${parts.join(',')}]`;
    }
    const rec = obj as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = rec[k];
      if (isOmitted(v)) continue;
      parts.push(`${JSON.stringify(k)}:${canon(v, stack)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    stack.pop();
  }
}

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace. Used for hashes, idempotency keys and
 * every ledger row. Follows JSON.stringify for values Json does not allow, so the output always parses:
 * object fields whose value is undefined (or a function/symbol) are dropped; inside arrays they become
 * null; non-finite numbers become null. A bigint, a cycle or a top-level undefined throws TypeError.
 * `JSON.parse(canonicalJson(v))` is therefore the normal form a store returns for `v`.
 */
export function canonicalJson(value: Json): string {
  return canon(value, []);
}

/** The value a JSON store hands back for `value`: undefined fields dropped, key order canonical. */
export function normalizeJson<T extends Json>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Digest of a Json value under canonical serialization. */
export function digest(value: Json): string {
  return sha256(canonicalJson(value));
}

/** Walk every string leaf of a Json value (used by secret scans). */
export function* stringLeaves(value: Json, path: string[] = []): Generator<{ path: string; value: string }> {
  if (typeof value === 'string') {
    yield { path: path.join('.'), value };
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* stringLeaves(value[i]!, [...path, String(i)]);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) yield* stringLeaves(v, [...path, k]);
  }
}
