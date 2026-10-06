import type { LLM, Manifest } from '@tecera/contracts';
import { inferKind, type CreateProviderOptions, type ProviderKind } from '@tecera/providers';

/**
 * How manifest provider names map onto wire protocols (D7). Seats name a provider key of tecera.json
 * `providers` ({auth: env:…}); `anthropic`, `openai` and `openrouter` are the shipped ones, with keys from
 * ANTHROPIC_API_KEY, OPENAI_API_KEY and OPENROUTER_API_KEY.
 *
 * OpenRouter is a first-class provider kind in @tecera/providers (OpenAI-compatible at
 * https://openrouter.ai/api/v1, model ids like `anthropic/claude-sonnet-4.5`, usage from the response,
 * pricing from its table with unknown models priced conservatively). When the installed providers package
 * resolves `openrouter` itself, nothing is overridden here. When it does not (an older build), the name is
 * mapped onto the OpenAI wire at OpenRouter's base URL and the seat's identity is reported as `openrouter`,
 * so the review gate's foreign check (provider AND keyFingerprint) never mistakes it for OpenAI.
 *
 * The same kinds map is handed to the SecretStore (a handle's kind must match the seat's) and to
 * createProvider; the probe, the run wiring and the stop hook all go through `providerSetup`.
 */

export const OPENROUTER_PROVIDER = 'openrouter';
/** OpenRouter's OpenAI-compatible API root (the OpenAI adapter appends `/v1/…` to the fallback base below). */
export const OPENROUTER_API = 'https://openrouter.ai/api/v1';
const OPENROUTER_FALLBACK_BASE = 'https://openrouter.ai/api';

/** Environment variables the shipped manifests read provider keys from (names only; values never leave env). */
export const PROVIDER_KEY_ENV = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', openrouter: 'OPENROUTER_API_KEY' } as const;

export function isOpenRouter(name: string): boolean {
  return /openrouter/i.test(name);
}

/** True when the installed @tecera/providers resolves OpenRouter as its own kind. */
export function nativeOpenRouter(): boolean {
  const k = inferKind(OPENROUTER_PROVIDER) as string | null;
  return k !== null && k !== 'anthropic' && k !== 'openai';
}

export interface ProviderSetup {
  /** Explicit kinds for names the providers package cannot infer (SecretStore and createProvider). */
  kinds: Record<string, ProviderKind>;
  /** Base URLs per provider name (fallback OpenRouter only). */
  baseUrls: Record<string, string>;
  /** Identity (LLM.provider) to report per provider name, when it differs from the wire kind. */
  identities: Record<string, string>;
}

export function providerSetup(m: Pick<Manifest, 'providers'>): ProviderSetup {
  const out: ProviderSetup = { kinds: {}, baseUrls: {}, identities: {} };
  if (nativeOpenRouter()) return out;
  for (const name of Object.keys(m.providers)) {
    if (!isOpenRouter(name) || inferKind(name) !== null) continue;
    out.kinds[name] = 'openai';
    out.baseUrls[name] = OPENROUTER_FALLBACK_BASE;
    out.identities[name] = OPENROUTER_PROVIDER;
  }
  return out;
}

/** createProvider options for this manifest (kinds and base URLs), merged over `extra`. */
export function providerOptions(setup: ProviderSetup, extra: CreateProviderOptions = {}): CreateProviderOptions {
  const kinds = { ...(extra.kinds ?? {}), ...setup.kinds };
  const baseUrls = { ...setup.baseUrls, ...(extra.baseUrls ?? {}) };
  return { ...extra, ...(Object.keys(kinds).length ? { kinds } : {}), ...(Object.keys(baseUrls).length ? { baseUrls } : {}) };
}

/** The seat's LLM reporting `provider` as identity (fallback OpenRouter); everything else unchanged. */
export function withIdentity(llm: LLM, setup: ProviderSetup, providerName: string): LLM {
  const id = setup.identities[providerName];
  if (!id) return llm;
  return new Proxy(llm, {
    get(target, prop) {
      if (prop === 'provider') return id;
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** The wire format a provider name speaks (scripted transport): from the request URL when known. */
export function wireOf(url: string): 'anthropic' | 'openai-responses' | 'openai-chat' {
  if (/\/messages(\?|$)/.test(url)) return 'anthropic';
  if (/\/chat\/completions(\?|$)/.test(url)) return 'openai-chat';
  return 'openai-responses';
}
