import type { LLM } from '@tecera/contracts';
import { AnthropicLLM, type AnthropicModelProfile } from './anthropic.js';
import type { FetchLike, RetryOptions } from './http.js';
import { isEffort, ProviderConfigError, requireKind, vendorOf, type Effort, type ProviderKind } from './kinds.js';
import { OpenAILLM } from './openai.js';
import { OpenRouterLLM } from './openrouter.js';
import type { WarningSink } from './pricing.js';
import type { Redactor } from './redact.js';
import type { SecretStore } from './secrets.js';

/**
 * Seat → LLM. The provider name must already be resolved in the SecretStore and must map to a known
 * wire kind whose auth scheme matches the handle; otherwise construction throws (composition-time,
 * fail closed). Redaction needs no option: every provider redacts through the store that resolved its
 * handle (all keys, auth header values, extras such as canaries), whether built here or directly.
 * foreignCheck is the review gate's assertion that writer and reviewer are different vendors on
 * different keys; missing identity fails closed.
 */

export interface SeatLike {
  provider: string;
  model: string;
  effort?: Effort;
}

export interface CreateProviderOptions {
  fetch?: FetchLike;
  kinds?: Readonly<Record<string, ProviderKind>>;
  baseUrls?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: RetryOptions['sleep'];
  random?: RetryOptions['random'];
  defaultMaxTokens?: number;
  onWarning?: WarningSink;
  /** An additional redactor applied on top of (never instead of) the store's. */
  redactor?: Redactor;
  anthropic?: { schemaMode?: 'format' | 'tool'; profile?: (model: string) => AnthropicModelProfile };
  openai?: { strictSchema?: boolean };
  openrouter?: { strictSchema?: boolean; appUrl?: string; appTitle?: string };
}

export function createProvider(seat: SeatLike, store: SecretStore, opts: CreateProviderOptions = {}): LLM {
  if (!seat || typeof seat.provider !== 'string' || !seat.provider || typeof seat.model !== 'string' || !seat.model) {
    throw new ProviderConfigError('seat needs a provider and a model');
  }
  if (seat.effort !== undefined && !isEffort(seat.effort)) throw new ProviderConfigError(`seat effort must be low, medium or high`);
  const kind = requireKind(seat.provider, opts.kinds);
  const auth = store.get(seat.provider);
  if (auth.kind !== kind) throw new ProviderConfigError(`secret for "${seat.provider}" was resolved as ${auth.kind ?? 'non-provider'}, seat needs ${kind}; pass the same kinds map to SecretStore`);
  const base = {
    auth,
    model: seat.model,
    effort: seat.effort ?? 'medium',
    name: seat.provider,
    ...(opts.baseUrls?.[seat.provider] ? { baseUrl: opts.baseUrls[seat.provider]! } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    ...(opts.baseDelayMs !== undefined ? { baseDelayMs: opts.baseDelayMs } : {}),
    ...(opts.maxDelayMs !== undefined ? { maxDelayMs: opts.maxDelayMs } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.random ? { random: opts.random } : {}),
    ...(opts.defaultMaxTokens !== undefined ? { defaultMaxTokens: opts.defaultMaxTokens } : {}),
    ...(opts.onWarning ? { onWarning: opts.onWarning } : {}),
    ...(opts.redactor ? { redactor: opts.redactor } : {}),
  } as const;
  if (kind === 'anthropic') return new AnthropicLLM({ ...base, ...(opts.anthropic ?? {}) });
  if (kind === 'openrouter') return new OpenRouterLLM({ ...base, ...(opts.openrouter ?? {}) });
  return new OpenAILLM({ ...base, ...(opts.openai ?? {}) });
}

/**
 * The vendor a seat's model comes from (what foreign review separates on): the model id's prefix for an
 * OpenRouter seat (`openrouter` + `anthropic/claude-sonnet-4.5` → anthropic), else the provider's wire kind.
 * Throws ProviderConfigError for an unknown provider name or an OpenRouter id without a vendor.
 */
export function seatVendorOf(seat: SeatLike, kinds?: Readonly<Record<string, ProviderKind>>): string {
  return vendorOf(requireKind(seat.provider, kinds), seat.model);
}

export class ForeignCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForeignCheckError';
  }
}

/**
 * Throws ForeignCheckError unless `a` and `b` are different vendors on different keys. `provider` is
 * the vendor identity (the wire kind, or for OpenRouter the model id's prefix: an OpenRouter
 * `anthropic/*` seat has provider 'anthropic'), not the manifest alias, so two aliases of one vendor, or
 * one vendor reached directly and through OpenRouter, are NOT foreign. Missing or empty provider or keyFingerprint on either side fails closed (per the LLM
 * contract: missing identity = not foreign). Wrappers must forward both (RecordingLLM does).
 */
export function foreignCheck(a: LLM, b: LLM): void {
  const pa = a?.provider;
  const pb = b?.provider;
  if (typeof pa !== 'string' || !pa.trim() || typeof pb !== 'string' || !pb.trim()) throw new ForeignCheckError('both LLMs must declare a provider');
  if (pa.trim().toLowerCase() === pb.trim().toLowerCase()) throw new ForeignCheckError(`foreign review requires distinct providers; both are "${pa}"`);
  const ka = a?.keyFingerprint;
  const kb = b?.keyFingerprint;
  if (typeof ka !== 'string' || !ka || typeof kb !== 'string' || !kb) throw new ForeignCheckError('both LLMs must declare a credential fingerprint; missing identity is not foreign');
  if (ka === kb) throw new ForeignCheckError('foreign review requires distinct credentials; both LLMs use the same key');
}
