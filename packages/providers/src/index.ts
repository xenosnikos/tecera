/**
 * @tecera/providers — model providers (Anthropic, OpenAI, OpenRouter) behind the LLM port, the SecretStore, pricing, the doctor
 * probe, and offline test doubles. Providers never throw from complete() and never surface a
 * credential: every outgoing field and warning goes through the shared contracts redactor built from
 * the SecretStore; secret-bearing requests are refused before sending and secret-bearing output is
 * refused ('secret-bearing output refused'); only an unambiguous final assistant answer is 'stop'.
 */
export { SecretStore, SecretHandle, SecretError, UnsupportedRefError, type SecretStoreOptions } from './secrets.js';
export {
  makeRedactor,
  redactText,
  redactJson,
  containsSecret,
  secretNeedles,
  sha8,
  redactionMarker,
  RedactionError,
  MIN_SECRET_CHARS,
  patternRedactor,
  type Redactor,
  type SecretInput,
} from './redact.js';
export { PRICES, OPENROUTER_PRICES, DEFAULT_PRICE, CONSERVATIVE_PRICE, priceFor, isPriced, costUsd, costAt, estimateUsd, type Price, type TokenCounts, type WarningSink } from './pricing.js';
export { postJson, postPayload, backoffDelay, abortableSleep, providerMessage, DEFAULT_RETRY, type FetchLike, type RetryOptions, type HttpResult } from './http.js';
export { SECRET_OUTPUT_REFUSED, REDACTION_FAILED, INPUT_OVERHEAD_TOKENS, usageBound, settleUsage, type ProviderOptions, type ProviderRequest, type ProviderUsage, type UsageBound } from './base.js';
export { openAIStrictSchemaProblems, anthropicSchemaProblems } from './schemaCompat.js';
export { inertSnapshot, serializeInert, UnsafeBodyError, MAX_BODY_DEPTH } from './inert.js';
export { scanDecoded, scanJsonDeep, sanitizeDecodedJson, decodeLayer, unescapeAll, withheldMarker, UNSCANNABLE, MAX_DECODE_LAYERS, MAX_ESCAPE_LAYERS, MAX_TOKENS, type DecodedLayer } from './decode.js';
export { AnthropicLLM, buildAnthropicBody, anthropicProfile, ANTHROPIC_VERSION, SCHEMA_TOOL, THINKING_BUDGET, type AnthropicOptions, type AnthropicModelProfile } from './anthropic.js';
export { OpenAILLM, buildOpenAIBody, isReasoningModel, type OpenAIOptions } from './openai.js';
export { OpenRouterLLM, buildOpenRouterBody, openRouterReasoning, OPENROUTER_BASE_URL, MIN_THINKING_BUDGET, THINKING_SHARE, type OpenRouterOptions } from './openrouter.js';
export { createProvider, foreignCheck, seatVendorOf, ForeignCheckError, type SeatLike, type CreateProviderOptions } from './factory.js';
export { inferKind, requireKind, authScheme, isEffort, isProviderKind, openRouterVendor, vendorOf, toOpenRouterModel, EFFORTS, PROVIDER_KINDS, KEY_ENV, ProviderConfigError, type ProviderKind, type Effort } from './kinds.js';
export { doctorProbe, type DoctorResult } from './doctor.js';
export { ScriptedLLM, type ScriptItem, type ScriptResponse, type Matcher, type ScriptedLLMOptions } from './testing/scripted.js';
export { RecordingLLM, type RecordingOptions } from './testing/recording.js';
export { FixtureFetch, loadFixture, fixtureNames, type FixtureSpec, type FixtureCall } from './testing/fixtureFetch.js';
