import { describe, expect, it } from 'vitest';
import { canonicalJson, digest, normalizeJson, type Json } from './json.js';

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined object fields like JSON.stringify', () => {
    const v = { b: 1, a: { d: undefined, c: [1, 'x'] }, e: undefined } as unknown as Json;
    expect(canonicalJson(v)).toBe('{"a":{"c":[1,"x"]},"b":1}');
    expect(JSON.parse(canonicalJson(v))).toEqual(JSON.parse(JSON.stringify(v)));
  });

  it('arrays keep JSON semantics: undefined/function become null; non-finite numbers become null', () => {
    const v = [undefined, () => 1, NaN, Infinity, 2] as unknown as Json;
    expect(canonicalJson(v)).toBe('[null,null,null,null,2]');
    expect(canonicalJson(v)).toBe(JSON.stringify(v));
  });

  it('always parses and is stable under normalization', () => {
    const v = { intention: { id: 'i', parentIntentionId: undefined, stepStatus: { a: 'done' } } } as unknown as Json;
    const s = canonicalJson(v);
    expect(() => JSON.parse(s)).not.toThrow();
    expect(s).not.toContain('undefined');
    expect(canonicalJson(normalizeJson(v))).toBe(s);
    expect(digest(v)).toBe(digest(normalizeJson(v)));
  });

  it('throws on cycles, bigint and a top-level undefined', () => {
    const c: Record<string, unknown> = {};
    c.c = c;
    expect(() => canonicalJson(c as unknown as Json)).toThrow(/cyclic/);
    expect(() => canonicalJson({ n: 1n } as unknown as Json)).toThrow(/bigint/);
    expect(() => canonicalJson(undefined as unknown as Json)).toThrow(TypeError);
  });

  it('a shared (non-cyclic) reference is fine', () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });
});
