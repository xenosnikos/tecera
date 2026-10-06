import { types } from 'node:util';
import type { Json } from '@tecera/contracts';

/**
 * The outgoing request boundary (security.md §6–7): the body that is scanned is the body that is sent.
 *
 * `inertSnapshot` copies a value into plain, host-owned JSON and REFUSES anything whose serialization could
 * differ from what a structural scan sees: accessor properties (getters/setters), `toJSON` hooks (own or
 * inherited), Proxies, non-plain objects (class instances, Date, Map, Buffer, boxed primitives), functions,
 * symbols, bigints, non-finite numbers, cycles, nesting deeper than `maxDepth`, and oversized bodies. It never
 * invokes a getter, `toJSON`, `valueOf` or `toString` on the caller's objects.
 *
 * `serializeInert` then produces the exact bytes from that snapshot (no reserialization of caller-owned
 * objects, no `JSON.stringify` on objects, so a polluted `Object.prototype.toJSON` cannot run either). The
 * provider scans that string and sends that same string.
 */

export const MAX_BODY_DEPTH = 64;
export const MAX_BODY_NODES = 200_000;

export class UnsafeBodyError extends Error {
  constructor(readonly why: string) {
    super(`outgoing body is not inert JSON (${why})`);
    this.name = 'UnsafeBodyError';
  }
}

const OMIT = Symbol('omit');

export function inertSnapshot(value: unknown, maxDepth = MAX_BODY_DEPTH): Json {
  let nodes = 0;
  const stack = new Set<object>();
  const snap = (v: unknown, depth: number): Json | typeof OMIT => {
    if (++nodes > MAX_BODY_NODES) throw new UnsafeBodyError(`more than ${MAX_BODY_NODES} values`);
    if (v === null) return null;
    switch (typeof v) {
      case 'string':
      case 'boolean':
        return v;
      case 'number':
        if (!Number.isFinite(v)) throw new UnsafeBodyError('non-finite number');
        return Object.is(v, -0) ? 0 : v;
      case 'undefined':
        return OMIT;
      case 'bigint':
      case 'symbol':
      case 'function':
        throw new UnsafeBodyError(`a ${typeof v} value`);
    }
    const obj = v as object;
    if (types.isProxy(obj)) throw new UnsafeBodyError('a Proxy');
    if (depth >= maxDepth) throw new UnsafeBodyError(`nested deeper than ${maxDepth} levels`);
    if (stack.has(obj)) throw new UnsafeBodyError('a cycle');
    const isArr = Array.isArray(obj);
    const proto: unknown = Object.getPrototypeOf(obj);
    if (isArr ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new UnsafeBodyError('a non-plain object');
    if ('toJSON' in obj) throw new UnsafeBodyError('a toJSON serialization hook');
    const descs = Object.getOwnPropertyDescriptors(obj) as Record<string | symbol, PropertyDescriptor>;
    for (const k of Reflect.ownKeys(descs)) {
      const d = descs[k as string]!;
      if (d.get || d.set || !('value' in d)) throw new UnsafeBodyError('an accessor property');
    }
    stack.add(obj);
    try {
      if (isArr) {
        const len = descs['length']?.value;
        if (typeof len !== 'number') throw new UnsafeBodyError('an array without a length');
        const out: Json[] = [];
        for (let i = 0; i < len; i++) {
          const d = descs[String(i)];
          const r = d ? snap(d.value, depth + 1) : null;
          out.push(r === OMIT ? null : r);
        }
        return out;
      }
      const out = Object.create(null) as { [k: string]: Json };
      for (const k of Object.keys(obj)) {
        const d = descs[k]!;
        if (!d.enumerable) continue;
        const r = snap(d.value, depth + 1);
        if (r === OMIT) continue;
        Object.defineProperty(out, k, { value: r, enumerable: true, writable: true, configurable: true });
      }
      return out;
    } finally {
      stack.delete(obj);
    }
  };
  const r = snap(value, 0);
  if (r === OMIT) throw new UnsafeBodyError('an undefined body');
  return r;
}

/** Exact JSON text of an inert snapshot (same bytes JSON.stringify gives for plain data). */
export function serializeInert(v: Json): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
    case 'number':
    case 'boolean':
      return JSON.stringify(v); // primitives: no toJSON lookup
  }
  if (Array.isArray(v)) return `[${v.map((x) => serializeInert(x)).join(',')}]`;
  const o = v as { [k: string]: Json };
  return `{${Object.keys(o)
    .map((k) => `${JSON.stringify(k)}:${serializeInert(o[k]!)}`)
    .join(',')}}`;
}

/** Every string (keys included) of an inert snapshot, iteratively. Returns the first non-null `fn` result. */
export function firstInStrings(v: Json, fn: (s: string) => string | null): string | null {
  const todo: Json[] = [v];
  while (todo.length) {
    const x = todo.pop()!;
    if (typeof x === 'string') {
      const h = fn(x);
      if (h !== null) return h;
    } else if (Array.isArray(x)) todo.push(...x);
    else if (x !== null && typeof x === 'object') {
      for (const k of Object.keys(x)) {
        const h = fn(k);
        if (h !== null) return h;
        todo.push((x as { [k: string]: Json })[k]!);
      }
    }
  }
  return null;
}
