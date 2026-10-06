import { describe, expect, it } from 'vitest';
import { HANDLE_RE } from '@tecera/contracts';
import { ExecHandleTable, HandleLimitError, HandleMint, isHandleRef, promoteStrings } from './handles.js';

describe('handles', () => {
  const key = Buffer.alloc(32, 7);

  it('mints h1.<runId>.<seq>.<hmac16> and verifies only its own', () => {
    const m = new HandleMint('run_1', key);
    const h = m.mint();
    expect(h).toMatch(HANDLE_RE);
    expect(h.startsWith('h1.run_1.1.')).toBe(true);
    expect(m.verify(h)).toBe(true);
    expect(m.verify(h.slice(0, -1) + (h.endsWith('0') ? '1' : '0'))).toBe(false);
    expect(m.verify('h1.run_1.2.0123456789abcdef')).toBe(false);
    expect(new HandleMint('run_2', key).verify(h)).toBe(false);
    expect(new HandleMint('run_1', Buffer.alloc(32, 8)).verify(h)).toBe(false);
    expect(() => new HandleMint('bad id!', key)).toThrow();
  });

  it('stale handles across reconstruction: a new mint with the SAME run id and key never verifies an old handle', () => {
    const a = new HandleMint('run_1', key);
    const t1 = new ExecHandleTable(a, 1);
    const old = t1.add({ kind: 'text', text: 'old secret-free value', provenance: { src: 'x', trust: 'untrusted' } });
    const b = new HandleMint('run_1', key);
    const t2 = new ExecHandleTable(b, 1);
    const fresh = t2.add({ kind: 'text', text: 'new value', provenance: { src: 'x', trust: 'untrusted' } });
    // Same seq, same run id, same key material: still different handles, and the old one resolves to nothing.
    expect(old.split('.')[2]).toBe(fresh.split('.')[2]);
    expect(old).not.toBe(fresh);
    expect(b.verify(old)).toBe(false);
    expect(t2.get(old)).toBeUndefined();
    expect(t2.get(fresh)).toMatchObject({ text: 'new value' });
  });

  it('tables are exec-scoped: a handle from a previous exec fails lookup', () => {
    const m = new HandleMint('r', key);
    const t1 = new ExecHandleTable(m, 1);
    const h = t1.add({ kind: 'tool', tool: 'files', methods: ['read'], description: '' });
    expect(t1.get(h)).toBeDefined();
    const t2 = new ExecHandleTable(m, 2);
    expect(t2.get(h)).toBeUndefined();
  });

  it('caps live handles per exec', () => {
    const t = new ExecHandleTable(new HandleMint('r', key), 1, 3);
    for (let i = 0; i < 3; i++) t.add({ kind: 'list', items: [], provenance: { src: 's', trust: 'untrusted' } });
    expect(() => t.add({ kind: 'list', items: [], provenance: { src: 's', trust: 'untrusted' } })).toThrow(HandleLimitError);
  });

  it('promotes long strings to handle refs anywhere in a value', () => {
    const t = new ExecHandleTable(new HandleMint('r', key), 1);
    const long = 'y'.repeat(10);
    const out = promoteStrings({ a: [long, 'short'], ['__proto__']: long } as never, t, { src: 's', trust: 'untrusted' }, 5) as Record<string, unknown>;
    const a = out.a as unknown[];
    expect(isHandleRef(a[0] as never)).toBe(true);
    expect(a[1]).toBe('short');
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(t.size).toBe(1 + (Object.prototype.hasOwnProperty.call(out, '__proto__') ? 1 : 0));
  });
});
