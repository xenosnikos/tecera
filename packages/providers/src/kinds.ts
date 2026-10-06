import type { LLMEffort } from '@tecera/contracts';

/**
 * Provider kinds. A manifest names providers freely (`anthropic`, `work-openai`, `openrouter`, ...); every
 * name must resolve to exactly one wire protocol or nothing is constructed. Inference is by name only, and
 * an explicit `kinds` map always wins. A name containing `openrouter` is OpenRouter whatever else it says
 * (`openrouter-claude`); otherwise anthropic/claude vs openai/gpt, and an ambiguous or unknown name fails
 * closed.
 *
 * `openrouter` is OpenRouter's OpenAI-compatible chat/completions API (https://openrouter.ai/api/v1) with
 * `vendor/model` ids; its vendor (for foreign review) is the model id's prefix, never `openrouter`.
 */

export type ProviderKind = 'anthropic' | 'openai' | 'openrouter';

export const PROVIDER_KINDS: readonly ProviderKind[] = Object.freeze(['anthropic', 'openai', 'openrouter'] as const);

export function isProviderKind(v: unknown): v is ProviderKind {
  return v === 'anthropic' || v === 'openai' || v === 'openrouter';
}

/** The environment variable each kind's key conventionally lives in (manifest `auth: "env:<NAME>"`). */
export const KEY_ENV: Readonly<Record<ProviderKind, string>> = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
});
export type Effort = LLMEffort;

export const EFFORTS: readonly Effort[] = Object.freeze(['low', 'medium', 'high'] as const);

export function isEffort(v: unknown): v is Effort {
  return v === 'low' || v === 'medium' || v === 'high';
}

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

/** Resolve a manifest provider name to its wire kind, or null when it cannot be inferred. */
export function inferKind(name: string, kinds?: Readonly<Record<string, ProviderKind>>): ProviderKind | null {
  const explicit = kinds?.[name];
  if (isProviderKind(explicit)) return explicit;
  const n = name.toLowerCase();
  if (/openrouter/.test(n)) return 'openrouter';
  const isAnthropic = /anthropic|claude/.test(n);
  const isOpenAI = /openai|gpt/.test(n);
  if (isAnthropic && !isOpenAI) return 'anthropic';
  if (isOpenAI && !isAnthropic) return 'openai';
  return null;
}

/** Same as inferKind but throws ProviderConfigError when the name is ambiguous or unknown. */
export function requireKind(name: string, kinds?: Readonly<Record<string, ProviderKind>>): ProviderKind {
  const k = inferKind(name, kinds);
  if (!k) throw new ProviderConfigError(`cannot infer provider kind for "${name}"; pass kinds: { "${name}": "anthropic" | "openai" | "openrouter" }`);
  return k;
}

/** The header each kind authenticates with. */
export function authScheme(kind: ProviderKind): { header: string; prefix: string } {
  return kind === 'anthropic' ? { header: 'x-api-key', prefix: '' } : { header: 'authorization', prefix: 'Bearer ' };
}

/** `vendor/model` → vendor (lowercase), or null when the id has no vendor prefix. */
export function openRouterVendor(model: string): string | null {
  if (typeof model !== 'string') return null;
  const m = /^([a-z0-9][a-z0-9._-]{0,63})\/[^/\s]+$/i.exec(model.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * The vendor a seat's model comes from, for foreign-review separation: the model id's prefix on
 * OpenRouter (`anthropic/claude-sonnet-4.5` → anthropic), else the wire kind. Same rule as the manifest's
 * seatVendor for a seat whose provider key names its kind.
 */
export function vendorOf(kind: ProviderKind, model: string): string {
  if (kind !== 'openrouter') return kind;
  const v = openRouterVendor(model);
  if (!v) throw new ProviderConfigError(`openrouter model ids are "vendor/model" (e.g. anthropic/claude-sonnet-4.5), got "${model}"`);
  return v;
}

/**
 * The OpenRouter id for a first-party model id, for routing Claude (or GPT) seats through OpenRouter when
 * the vendor API is unreachable: `claude-sonnet-4-5` → `anthropic/claude-sonnet-4.5`,
 * `claude-haiku-4-5-20251001` → `anthropic/claude-haiku-4.5`, `gpt-5.6-terra` → `openai/gpt-5.6-terra`.
 * An id that already has a vendor prefix is returned unchanged; anything else is null.
 */
export function toOpenRouterModel(model: string): string | null {
  if (typeof model !== 'string' || !model) return null;
  if (openRouterVendor(model)) return model;
  const undated = model.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '');
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(undated);
  if (claude) return `anthropic/claude-${claude[1]}-${claude[2]}${claude[3] !== undefined ? `.${claude[3]}` : ''}`;
  if (/^(gpt-|o\d)/.test(undated)) return `openai/${undated}`;
  return null;
}
