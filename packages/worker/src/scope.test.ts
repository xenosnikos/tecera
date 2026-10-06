import { describe, expect, it } from 'vitest';
import type { CapabilitySet, Hook } from '@tecera/contracts';
import { ConfigError, ConfigStack, DEFAULT_CONFIG } from './config.js';
import { ScopeError, currentScope, resolveInputs, scope } from './scope.js';

const caps = (): CapabilitySet => ({ tools: ['read', 'edit'], paths: { read: ['**'], write: ['src/**'], protected: [] }, network: 'none', limits: { usd: 2, tokens: 100, calls: 10, wallMs: 1000, depth: 3, iterations: 5 } });
const h = (id: string, mandatory = false): Hook => ({ id, mandatory, spans: new Set(['Invoke']), handle: () => [], describe: () => ({ id, mandatory, config: {} }) });

describe('scope', () => {
  it('precedence: explicit inputs > nearest scope > ancestors; hooks accumulate; depth increments', async () => {
    await scope({ vars: { a: { kind: 'value', value: 'outer', provenance: { src: 't', trust: 'trusted' } }, b: { kind: 'value', value: 'outer-b', provenance: { src: 't', trust: 'trusted' } } }, hooks: [h('h1')] }, async () => {
      await scope({ vars: { a: { kind: 'value', value: 'inner', provenance: { src: 't', trust: 'trusted' } } }, hooks: [h('h2')] }, async () => {
        const inputs = resolveInputs({ b: { kind: 'value', value: 'explicit', provenance: { src: 't', trust: 'trusted' } } });
        expect((inputs.a as { value: string }).value).toBe('inner');
        expect((inputs.b as { value: string }).value).toBe('explicit');
        expect(currentScope().hooks.map((x) => x.id)).toEqual(['h1', 'h2']);
        expect(currentScope().depth).toBe(2);
      });
    });
    expect(currentScope().depth).toBe(0);
  });

  it('reserved bindings are rejected in scopes and explicit inputs', async () => {
    await expect(scope({ vars: { __history__: { kind: 'hidden', value: [] } } }, async () => {})).rejects.toThrow(ScopeError);
    expect(() => resolveInputs({ __depth__: { kind: 'hidden', value: 1 } })).toThrow(ScopeError);
  });

  it('nested scopes narrow capabilities and refuse widening', async () => {
    await scope({ capabilities: caps() }, async () => {
      await scope({ capabilities: { tools: ['read'], limits: { usd: 1 } as never } }, async () => {
        expect(currentScope().capabilities?.tools).toEqual(['read']);
        expect(currentScope().capabilities?.limits.usd).toBe(1);
        expect(currentScope().capabilities?.limits.tokens).toBe(100);
      });
      await expect(scope({ capabilities: { tools: ['shell'] } }, async () => {})).rejects.toThrow(/widen/);
      await expect(scope({ capabilities: { limits: { usd: 5 } as never } }, async () => {})).rejects.toThrow(/widen/);
    });
  });

  it('a mandatory hook cannot be replaced by a nested scope', async () => {
    await scope({ hooks: [h('budgetPool', true)] }, async () => {
      await expect(scope({ hooks: [h('budgetPool')] }, async () => {})).rejects.toThrow(/mandatory hook/);
    });
  });
});

describe('ConfigStack', () => {
  it('resolves layered overrides and by-depth seats', () => {
    const s = new ConfigStack(DEFAULT_CONFIG).push({ seatId: 'planner', byDepth: { 0: { seatId: 'planner' }, default: { seatId: 'cheap', limits: { tokens: 1000 } } } });
    expect(s.resolve(0).seatId).toBe('planner');
    expect(s.resolve(1).seatId).toBe('cheap');
    expect(s.resolve(1).limits.tokens).toBe(1000);
    expect(s.resolve(0).limits.tokens).toBe(DEFAULT_CONFIG.limits.tokens);
  });

  it('refuses to raise any limit or exec cap', () => {
    const s = new ConfigStack(DEFAULT_CONFIG).push({ limits: { usd: 0.5 } });
    expect(s.resolve(0).limits.usd).toBe(0.5);
    expect(() => s.push({ limits: { usd: 0.75 } }).resolve(0)).toThrow(ConfigError);
    expect(() => new ConfigStack(DEFAULT_CONFIG).push({ exec: { timeoutMs: DEFAULT_CONFIG.exec.timeoutMs + 1 } }).resolve(0)).toThrow(ConfigError);
    expect(() => new ConfigStack(DEFAULT_CONFIG).push({ byDepth: { default: { limits: { depth: 9 } } } }).resolve(2)).toThrow(ConfigError);
  });
});
