/**
 * USD per million tokens. Lookups try the exact id, then the id with a trailing date stamp (`-20251001`,
 * `-2026-07-30`) removed. Prices: Anthropic first-party list prices; OpenAI list prices as of 2026-10 (the
 * promotional gpt-5.6-sol rate is not used, so budgets over-estimate rather than under-estimate). `gpt-6`
 * is priced as the flagship (Astra) tier. OpenRouter ids (`vendor/model`) carry OpenRouter's published
 * rates (https://openrouter.ai/api/v1/models, read 2026-10-05) with the long-context tier where one exists;
 * where OpenRouter's rate is promotional and below the vendor list price, the list price is used.
 *
 * Certainty is tracked apart from the amount: a model that is not in the table is UNPRICED. `costUsd`
 * prices it at 0 with a warning (kept for callers that only want a table lookup); `estimateUsd`, which the
 * providers use, prices it at CONSERVATIVE_PRICE and reports `known: false`, so the call's usage carries
 * `unknown: true` (charged at least at the reservation) instead of a confirmed figure.
 */

export interface Price {
  inputPerM: number;
  outputPerM: number;
  /** Multipliers on inputPerM for prompt-cache writes / reads. */
  cacheWriteMult?: number;
  cacheReadMult?: number;
  /** Dearer tier applied to the whole call once its prompt (input + cache reads/writes) reaches minInputTokens. */
  longContext?: { minInputTokens: number; inputPerM: number; outputPerM: number };
}

const ANTHROPIC_CACHE = { cacheWriteMult: 1.25, cacheReadMult: 0.1 } as const;
const OPENAI_CACHE = { cacheWriteMult: 1.25, cacheReadMult: 0.1 } as const;

/** OpenRouter model ids (`vendor/model`). Every one also appears in PRICES. */
export const OPENROUTER_PRICES: Readonly<Record<string, Price>> = Object.freeze({
  'anthropic/claude-sonnet-4.5': { inputPerM: 3, outputPerM: 15, ...ANTHROPIC_CACHE, longContext: { minInputTokens: 200_000, inputPerM: 6, outputPerM: 22.5 } },
  'anthropic/claude-haiku-4.5': { inputPerM: 1, outputPerM: 5, ...ANTHROPIC_CACHE },
  'anthropic/claude-sonnet-4.6': { inputPerM: 3, outputPerM: 15, ...ANTHROPIC_CACHE },
  'anthropic/claude-sonnet-5': { inputPerM: 2, outputPerM: 10, ...ANTHROPIC_CACHE },
  'anthropic/claude-sonnet-5.5': { inputPerM: 2, outputPerM: 10, ...ANTHROPIC_CACHE },
  'anthropic/claude-opus-5': { inputPerM: 5, outputPerM: 25, ...ANTHROPIC_CACHE },
  'anthropic/claude-opus-5.5': { inputPerM: 4, outputPerM: 20, ...ANTHROPIC_CACHE },
  'openai/gpt-5.6-terra': { inputPerM: 2, outputPerM: 12, ...OPENAI_CACHE, longContext: { minInputTokens: 272_000, inputPerM: 4, outputPerM: 18 } },
  // OpenRouter lists $2/$10 (promotional); the vendor list price is used so budgets over-estimate.
  'openai/gpt-5.6-sol': { inputPerM: 5, outputPerM: 30, ...OPENAI_CACHE },
  'openai/gpt-5.6-luna': { inputPerM: 0.2, outputPerM: 1.2, ...OPENAI_CACHE, longContext: { minInputTokens: 272_000, inputPerM: 0.4, outputPerM: 1.8 } },
  'google/gemini-3.1-pro': { inputPerM: 2, outputPerM: 12, cacheReadMult: 0.1, longContext: { minInputTokens: 200_000, inputPerM: 4, outputPerM: 18 } },
  'google/gemini-3.1-pro-preview': { inputPerM: 2, outputPerM: 12, cacheReadMult: 0.1, longContext: { minInputTokens: 200_000, inputPerM: 4, outputPerM: 18 } },
});

export const PRICES: Readonly<Record<string, Price>> = Object.freeze({
  'claude-opus-5-5': { inputPerM: 4, outputPerM: 20, ...ANTHROPIC_CACHE },
  'claude-opus-5': { inputPerM: 5, outputPerM: 25, ...ANTHROPIC_CACHE },
  'claude-sonnet-5-5': { inputPerM: 2, outputPerM: 10, ...ANTHROPIC_CACHE },
  'claude-sonnet-5': { inputPerM: 2, outputPerM: 10, ...ANTHROPIC_CACHE },
  'claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15, ...ANTHROPIC_CACHE },
  'claude-sonnet-4-5': { inputPerM: 3, outputPerM: 15, ...ANTHROPIC_CACHE, longContext: { minInputTokens: 200_000, inputPerM: 6, outputPerM: 22.5 } },
  'claude-haiku-4-5': { inputPerM: 1, outputPerM: 5, ...ANTHROPIC_CACHE },
  'claude-haiku-4-5-20251001': { inputPerM: 1, outputPerM: 5, ...ANTHROPIC_CACHE },
  'gpt-5.6-sol': { inputPerM: 5, outputPerM: 30 },
  'gpt-5.6-terra': { inputPerM: 2, outputPerM: 12 },
  'gpt-5.6-luna': { inputPerM: 0.2, outputPerM: 1.2 },
  'gpt-6': { inputPerM: 10, outputPerM: 50 },
  'gpt-6-astra': { inputPerM: 10, outputPerM: 50 },
  'gpt-6-sol': { inputPerM: 2, outputPerM: 10 },
  'gpt-6-luna': { inputPerM: 0.1, outputPerM: 0.5 },
  ...OPENROUTER_PRICES,
});

export const DEFAULT_PRICE: Readonly<Price> = Object.freeze({ inputPerM: 0, outputPerM: 0 });

/**
 * What an UNPRICED model is charged at by estimateUsd: dearer than every model in the table (Opus-4.1-class
 * rates, $15 / $75 per MTok), cache writes at 1.25x and cache reads at the full input rate.
 */
export const CONSERVATIVE_PRICE: Readonly<Price> = Object.freeze({ inputPerM: 15, outputPerM: 75, cacheWriteMult: 1.25, cacheReadMult: 1 });

export type WarningSink = (message: string) => void;

function lookup(model: string, table: Readonly<Record<string, Price>>): Price | undefined {
  if (typeof model !== 'string' || !model) return undefined;
  if (Object.prototype.hasOwnProperty.call(table, model)) return table[model];
  const undated = model.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '');
  return Object.prototype.hasOwnProperty.call(table, undated) ? table[undated] : undefined;
}

/** True when the model (or its undated id) has a price in the table. */
export function isPriced(model: string, table: Readonly<Record<string, Price>> = PRICES): boolean {
  return lookup(model, table) !== undefined;
}

/** Price for a model id, or DEFAULT_PRICE (0) with a warning. */
export function priceFor(model: string, onWarning?: WarningSink, table: Readonly<Record<string, Price>> = PRICES): Price {
  const p = lookup(model, table);
  if (p) return p;
  onWarning?.(`no price for model "${model}"; cost recorded as $0`);
  return DEFAULT_PRICE;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

/** USD for a call at a given price. `inputTokens` excludes cache writes/reads, which are priced with their multipliers. */
export function costAt(p: Price, t: TokenCounts): number {
  const prompt = t.inputTokens + (t.cacheWriteTokens ?? 0) + (t.cacheReadTokens ?? 0);
  const tier = p.longContext && prompt >= p.longContext.minInputTokens ? p.longContext : p;
  const inM = tier.inputPerM / 1e6;
  const usd =
    t.inputTokens * inM +
    (t.cacheWriteTokens ?? 0) * inM * (p.cacheWriteMult ?? 1) +
    (t.cacheReadTokens ?? 0) * inM * (p.cacheReadMult ?? 1) +
    t.outputTokens * (tier.outputPerM / 1e6);
  return Math.round(usd * 1e9) / 1e9;
}

/** USD for a call from the table; an unpriced model costs 0 with a warning (see estimateUsd for the safe form). */
export function costUsd(model: string, t: TokenCounts, onWarning?: WarningSink, table?: Readonly<Record<string, Price>>): number {
  return costAt(priceFor(model, onWarning, table), t);
}

/**
 * The providers' price for a call that may involve several model ids (the requested one, the one the
 * provider reports): the dearest of them, every unpriced id charged at CONSERVATIVE_PRICE (with a warning).
 * `known` is false as soon as ANY of the ids is unpriced: a known fallback price never makes the charge
 * confirmed. Empty or non-string ids are ignored; none at all is unknown.
 */
export function estimateUsd(models: readonly string[], t: TokenCounts, onWarning?: WarningSink, table: Readonly<Record<string, Price>> = PRICES): { usd: number; known: boolean } {
  const ids = [...new Set(models.filter((m) => typeof m === 'string' && m.length > 0))];
  if (ids.length === 0) return { usd: costAt(CONSERVATIVE_PRICE, t), known: false };
  let usd = 0;
  let known = true;
  for (const m of ids) {
    const p = lookup(m, table);
    if (!p) {
      known = false;
      onWarning?.(`no price for model "${m}"; charged at the conservative rate and flagged unknown`);
    }
    usd = Math.max(usd, costAt(p ?? CONSERVATIVE_PRICE, t));
  }
  return { usd, known };
}
