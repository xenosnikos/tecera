import type { Limits } from '@tecera/contracts';

/**
 * Worker configuration: which seat answers LLM queries, execution limits, and REPL execution settings.
 * Overrides can be local (one invoke), scoped (every invoke under a scope), or by depth (routing seats
 * inside recursive sub-invokes: depth 0 planner-grade, depth ≥ 1 cheap). A child may never raise limits.
 */
export interface WorkerConfig {
  seatId: string;
  limits: Limits;
  exec: { timeoutMs: number; memoryMb: number; maxOutputBytes: number };
  protocol: { maxInputChars: number; maxOutputChars: number; prefixRatio: number };
}

export type ConfigOverride = Partial<{ seatId: string; limits: Partial<Limits>; exec: Partial<WorkerConfig['exec']>; protocol: Partial<WorkerConfig['protocol']> }> & {
  byDepth?: Record<number | 'default', Partial<{ seatId: string; limits: Partial<Limits>; exec: Partial<WorkerConfig['exec']> }>>;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const DEFAULT_CONFIG: WorkerConfig = {
  seatId: 'worker',
  limits: { usd: 1, tokens: 100_000, calls: 200, wallMs: 10 * 60_000, depth: 3, iterations: 20 },
  exec: { timeoutMs: 60_000, memoryMb: 256, maxOutputBytes: 1024 * 1024 },
  protocol: { maxInputChars: 50_000, maxOutputChars: 50_000, prefixRatio: 0.5 },
};

export class ConfigStack {
  constructor(
    private readonly base: WorkerConfig = DEFAULT_CONFIG,
    private readonly overrides: ConfigOverride[] = [],
  ) {}

  push(o: ConfigOverride): ConfigStack {
    return new ConfigStack(this.base, [...this.overrides, o]);
  }

  /** Resolve the effective config at a recursion depth. Throws if any layer tries to raise a limit. */
  resolve(depth: number): WorkerConfig {
    let cfg: WorkerConfig = structuredClone(this.base);
    for (const o of this.overrides) {
      cfg = applyLayer(cfg, o);
      const byDepth = o.byDepth?.[depth] ?? o.byDepth?.default;
      if (byDepth) cfg = applyLayer(cfg, byDepth);
    }
    return cfg;
  }
}

function applyLayer(cfg: WorkerConfig, o: Partial<{ seatId: string; limits: Partial<Limits>; exec: Partial<WorkerConfig['exec']>; protocol: Partial<WorkerConfig['protocol']> }>): WorkerConfig {
  const next = structuredClone(cfg);
  if (o.seatId) next.seatId = o.seatId;
  if (o.limits) {
    for (const k of Object.keys(o.limits) as Array<keyof Limits>) {
      const v = o.limits[k];
      if (typeof v !== 'number') continue;
      if (v > cfg.limits[k]) throw new ConfigError(`override may not raise limit ${k} from ${cfg.limits[k]} to ${v}`);
      next.limits[k] = v;
    }
  }
  if (o.exec) {
    for (const k of Object.keys(o.exec) as Array<keyof WorkerConfig['exec']>) {
      const v = o.exec[k];
      if (typeof v !== 'number') continue;
      if (v > cfg.exec[k]) throw new ConfigError(`override may not raise exec.${k} from ${cfg.exec[k]} to ${v}`);
      next.exec[k] = v;
    }
  }
  if (o.protocol) Object.assign(next.protocol, o.protocol);
  return next;
}
