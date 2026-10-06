import type { Effect, Hook, HookDescriptor, Limits, SpanEvent } from '@tecera/contracts';

/**
 * Scoped limit hooks, ports of JAZ BudgetPool / RecursionLimit / IterationLimit. They are shared across
 * the whole invoke tree (one instance under a scope), so a sub-tree cannot escape the cap. Liveness
 * enforcement sits at LLMQuery/Enter, the one boundary that fires every turn.
 */

export class BudgetPool implements Hook {
  readonly id = 'budgetPool';
  readonly mandatory = true;
  readonly spans = new Set<SpanEvent['span']>(['LLMQuery', 'ToolCall', 'Invoke']);
  private spent: Record<'usd' | 'tokens' | 'calls', number> = { usd: 0, tokens: 0, calls: 0 };
  private readonly startedAt = Date.now();
  private readonly enforce: boolean;
  /** Pools already reported exhausted (soft mode reports each once per invoke tree). */
  private readonly reported = new Set<string>();

  /**
   * `opts.enforce` (default true; the manifest's budgets.enforce, default false, D3): when false an exhausted
   * pool records a budget.exhausted evidence row once and the call proceeds (reservations still happen);
   * when true it aborts with code 'budget'.
   */
  constructor(
    private readonly caps: Pick<Limits, 'usd' | 'tokens' | 'calls' | 'wallMs'>,
    private readonly estimate: { usdPerCall: number; tokensPerCall: number } = { usdPerCall: 0.01, tokensPerCall: 2000 },
    opts: { enforce?: boolean } = {},
  ) {
    this.enforce = opts.enforce !== false;
  }

  /** Abort when enforced; else one informational budget.exhausted evidence row per pool. */
  private exhausted(e: SpanEvent, pool: 'usd' | 'tokens' | 'calls' | 'wallClock', reason: string): Effect[] {
    if (this.enforce) return [{ type: 'Abort', code: 'budget', reason }];
    if (this.reported.has(pool)) return [];
    this.reported.add(pool);
    return [{ type: 'AppendEvidence', key: `budget.exhausted:${e.run.runId}:${e.run.invokeId}:${pool}`, kind: 'budget.exhausted', body: { pool, reason, enforced: false, spent: { ...this.spent } } }];
  }

  handle(e: SpanEvent): Effect[] {
    if (e.stage === 'Enter' && e.span === 'LLMQuery') {
      if (Date.now() - this.startedAt > this.caps.wallMs) return this.exhausted(e, 'wallClock', `wall clock exceeded ${this.caps.wallMs}ms`);
      if (this.spent.usd >= this.caps.usd) return this.exhausted(e, 'usd', `usd budget exhausted (${this.spent.usd.toFixed(4)} >= ${this.caps.usd})`);
      if (this.spent.tokens >= this.caps.tokens) return this.exhausted(e, 'tokens', `token budget exhausted`);
    }
    if (e.stage === 'Send' && (e.span === 'LLMQuery' || e.span === 'ToolCall')) {
      const effects: Effect[] = [];
      if (this.spent.calls + 1 > this.caps.calls) {
        const x = this.exhausted(e, 'calls', `call budget exhausted (${this.caps.calls})`);
        if (this.enforce) return x;
        effects.push(...x);
      }
      effects.push({ type: 'ReserveBudget', pool: 'calls', amount: 1 });
      if (e.span === 'LLMQuery') {
        if (this.spent.usd + this.estimate.usdPerCall > this.caps.usd) {
          const x = this.exhausted(e, 'usd', 'next LLM call would exceed the usd budget');
          if (this.enforce) return x;
          effects.push(...x);
        }
        effects.push({ type: 'ReserveBudget', pool: 'usd', amount: this.estimate.usdPerCall }, { type: 'ReserveBudget', pool: 'tokens', amount: this.estimate.tokensPerCall });
      }
      this.spent.calls++;
      return effects;
    }
    if (e.stage === 'Complete' && e.span === 'LLMQuery') {
      const usage = (e.output as { usage?: { usd?: number; inputTokens?: number; outputTokens?: number } } | undefined)?.usage;
      if (usage) {
        this.spent.usd += usage.usd ?? 0;
        this.spent.tokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      }
    }
    return [];
  }

  snapshot(): Record<'usd' | 'tokens' | 'calls', number> {
    return { ...this.spent };
  }

  describe(): HookDescriptor {
    return { id: this.id, mandatory: true, config: { ...this.caps, enforce: this.enforce } };
  }
}

export class RecursionLimit implements Hook {
  readonly id = 'recursionLimit';
  readonly mandatory = true;
  readonly spans = new Set<SpanEvent['span']>(['Invoke']);
  constructor(private readonly maxDepth: number) {}
  handle(e: SpanEvent): Effect[] {
    if (e.stage === 'Enter' && e.run.depth >= this.maxDepth) return [{ type: 'Abort', code: 'recursion', reason: `recursion depth ${e.run.depth} reached the limit ${this.maxDepth}` }];
    return [];
  }
  describe(): HookDescriptor {
    return { id: this.id, mandatory: true, config: { maxDepth: this.maxDepth } };
  }
}

export class IterationLimit implements Hook {
  readonly id = 'iterationLimit';
  readonly mandatory = true;
  readonly spans = new Set<SpanEvent['span']>(['LLMQuery']);
  private readonly counts = new Map<string, number>();
  constructor(private readonly maxIterations: number, private readonly warnAt = Math.max(1, Math.floor(maxIterations * 0.8))) {}
  handle(e: SpanEvent): Effect[] {
    if (e.stage !== 'Enter') return [];
    const n = (this.counts.get(e.run.invokeId) ?? 0) + 1;
    this.counts.set(e.run.invokeId, n);
    if (n > this.maxIterations) return [{ type: 'Abort', code: 'iterations', reason: `iteration ${n} exceeds the limit ${this.maxIterations}` }];
    if (n >= this.warnAt) return [{ type: 'PatchInput', path: 'nudge', value: `You have used ${n} of ${this.maxIterations} turns. Finish and return soon.` }];
    return [];
  }
  describe(): HookDescriptor {
    return { id: this.id, mandatory: true, config: { maxIterations: this.maxIterations } };
  }
}
