import { AsyncLocalStorage } from 'node:async_hooks';
import { RESERVED_BINDINGS, narrow, widens, type Binding, type CapabilitySet, type Hook } from '@tecera/contracts';
import type { ConfigOverride } from './config.js';

/**
 * Dynamic scoping (JAZ §3): variables, hooks, config overrides and capabilities declared in a scope
 * apply to every invoke started inside it, including recursive sub-invokes. Nesting only narrows:
 * hooks accumulate, capabilities intersect, config overrides stack. Reserved bindings cannot be set.
 */
export interface ScopeSpec {
  vars?: Record<string, Binding>;
  hooks?: Hook[];
  config?: ConfigOverride;
  capabilities?: Partial<CapabilitySet>;
}

export interface ScopeFrame {
  vars: Record<string, Binding>;
  hooks: Hook[];
  configs: ConfigOverride[];
  capabilities?: CapabilitySet;
  depth: number;
}

const als = new AsyncLocalStorage<ScopeFrame>();

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeError';
  }
}

export function currentScope(): ScopeFrame {
  return als.getStore() ?? { vars: {}, hooks: [], configs: [], depth: 0 };
}

export async function scope<R>(spec: ScopeSpec, body: () => Promise<R>): Promise<R> {
  const parent = currentScope();
  for (const k of Object.keys(spec.vars ?? {})) {
    if ((RESERVED_BINDINGS as readonly string[]).includes(k)) throw new ScopeError(`binding ${k} is reserved`);
  }
  let capabilities = parent.capabilities;
  if (spec.capabilities) {
    if (parent.capabilities) {
      if (widens(parent.capabilities, spec.capabilities)) throw new ScopeError('a nested scope may not widen capabilities');
      capabilities = narrow(parent.capabilities, spec.capabilities);
    } else {
      capabilities = asFull(spec.capabilities);
    }
  }
  for (const h of spec.hooks ?? []) {
    if (parent.hooks.some((p) => p.mandatory && p.id === h.id)) throw new ScopeError(`mandatory hook ${h.id} cannot be replaced in a nested scope`);
  }
  const frame: ScopeFrame = {
    vars: { ...parent.vars, ...(spec.vars ?? {}) }, // explicit inner vars win over outer (nearest scope first)
    hooks: [...parent.hooks, ...(spec.hooks ?? [])],
    configs: spec.config ? [...parent.configs, spec.config] : parent.configs,
    capabilities,
    depth: parent.depth + 1,
  };
  return als.run(frame, body);
}

/** Resolve the inputs an invoke sees: explicit inputs > nearest scope > ancestors. */
export function resolveInputs(explicit: Record<string, Binding>): Record<string, Binding> {
  for (const k of Object.keys(explicit)) {
    if ((RESERVED_BINDINGS as readonly string[]).includes(k)) throw new ScopeError(`binding ${k} is reserved`);
  }
  return { ...currentScope().vars, ...explicit };
}

function asFull(c: Partial<CapabilitySet>): CapabilitySet {
  return {
    tools: c.tools ?? [],
    paths: { read: c.paths?.read ?? [], write: c.paths?.write ?? [], protected: c.paths?.protected ?? [] },
    network: 'none',
    limits: { usd: 0, tokens: 0, calls: 0, wallMs: 0, depth: 0, iterations: 0, ...(c.limits ?? {}) },
  };
}
