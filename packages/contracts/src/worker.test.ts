import { describe, expect, it } from 'vitest';
import { narrow, widens, type CapabilitySet } from './worker.js';
import { canonicalJson, digest, stringLeaves } from './json.js';
import { HANDLE_RE, RPC_LIMITS, frameSizeOk, jsonDepth } from './rpc.js';

const parent = (): CapabilitySet => ({
  tools: ['read', 'edit', 'runVerify'],
  paths: { read: ['src/**', 'test/**'], write: ['src/**'], protected: ['tecera.json'] },
  network: 'none',
  limits: { usd: 2, tokens: 1000, calls: 100, wallMs: 60000, depth: 3, iterations: 20 },
});

describe('narrow', () => {
  it('intersects tools and paths, unions protected, mins limits', () => {
    const c = narrow(parent(), {
      tools: ['edit', 'shell'],
      paths: { read: ['src/**'], write: ['src/**', 'docs/**'], protected: ['.env'] },
      limits: { usd: 5, tokens: 10, calls: 100, wallMs: 1, depth: 9, iterations: 20 },
    });
    expect(c.tools).toEqual(['edit']);
    expect(c.paths.read).toEqual(['src/**']);
    expect(c.paths.write).toEqual(['src/**']);
    expect(c.paths.protected.sort()).toEqual(['.env', 'tecera.json']);
    expect(c.limits).toEqual({ usd: 2, tokens: 10, calls: 100, wallMs: 1, depth: 3, iterations: 20 });
  });

  it('never widens, for random children (property)', () => {
    const p = parent();
    for (let n = 0; n < 200; n++) {
      const child: Partial<CapabilitySet> = {
        tools: ['read', 'edit', 'runVerify', 'shell', 'net'].filter(() => Math.random() < 0.5),
        paths: { read: ['src/**', 'etc/**'].filter(() => Math.random() < 0.5), write: ['src/**', '/'].filter(() => Math.random() < 0.5), protected: [] },
        limits: { usd: Math.random() * 10, tokens: Math.random() * 5000, calls: 100, wallMs: 60000, depth: Math.floor(Math.random() * 10), iterations: 20 },
      };
      const c = narrow(p, child);
      for (const t of c.tools) expect(p.tools).toContain(t);
      for (const r of c.paths.read) expect(p.paths.read).toContain(r);
      for (const w of c.paths.write) expect(p.paths.write).toContain(w);
      for (const k of Object.keys(c.limits) as Array<keyof typeof c.limits>) expect(c.limits[k]).toBeLessThanOrEqual(p.limits[k]);
    }
  });

  it('widens() detects any escalation', () => {
    expect(widens(parent(), { tools: ['shell'] })).toBe(true);
    expect(widens(parent(), { paths: { read: [], write: ['/'], protected: [] } })).toBe(true);
    expect(widens(parent(), { limits: { usd: 3 } as never })).toBe(true);
    expect(widens(parent(), { tools: ['read'], limits: { usd: 1 } as never })).toBe(false);
  });
});

describe('json helpers', () => {
  it('canonicalJson sorts keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
    expect(digest({ a: 1 })).toBe(digest({ a: 1 }));
  });
  it('stringLeaves walks nested values with paths', () => {
    expect([...stringLeaves({ a: ['x', { b: 'y' }], c: 1 })]).toEqual([
      { path: 'a.0', value: 'x' },
      { path: 'a.1.b', value: 'y' },
    ]);
  });
});

describe('rpc bounds', () => {
  it('handle format', () => {
    expect(HANDLE_RE.test('h1.run_1.7.0123456789abcdef')).toBe(true);
    expect(HANDLE_RE.test('h1.run_1.7.nothex')).toBe(false);
  });
  it('frame size and depth', () => {
    expect(frameSizeOk({ t: 'hello' })).toBe(true);
    expect(frameSizeOk({ t: 'call', args: ['x'.repeat(RPC_LIMITS.maxFrameBytes)] })).toBe(false);
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(jsonDepth(deep as never)).toBeGreaterThan(RPC_LIMITS.maxDepth);
  });
});
