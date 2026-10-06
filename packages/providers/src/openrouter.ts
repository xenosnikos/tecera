import { z } from 'zod';
import type { Json, JsonObject, LLM, LLMRequest, LLMResponse, LLMUsage } from '@tecera/contracts';
import {
  defaultFetch,
  errorResponse,
  finalize,
  isPlainObject,
  parseStructured,
  prepareBody,
  readRequest,
  redactionFailure,
  resolveEffort,
  retryOptions,
  safeWarn,
  Sanitizer,
  settleUsage,
  splitSystem,
  usageBound,
  type ProviderOptions,
  type ProviderUsage,
  type UsageBound,
} from './base.js';
import { postPayload } from './http.js';
import { openRouterVendor, ProviderConfigError, type Effort } from './kinds.js';
import { estimateUsd, type WarningSink } from './pricing.js';

/**
 * OpenRouter (https://openrouter.ai/api/v1, POST /chat/completions, OpenAI-compatible) behind the LLM port.
 * Model ids are `vendor/model` (`anthropic/claude-sonnet-4.5`, `openai/gpt-5.6-terra`,
 * `google/gemini-3.1-pro-preview`). The wire format was checked against the live API on 2026-10-05.
 *
 * Identity. `provider` is the VENDOR (the model id's prefix: `anthropic` for anthropic/*), not `openrouter`,
 * so foreign review compares the vendor that actually answers: a Claude worker on the Anthropic API and a
 * Claude reviewer through OpenRouter are not foreign. `keyFingerprint` is the OpenRouter key's. A request
 * whose model names another vendor than the seat's is refused before sending (the identity would lie).
 *
 * Request. System messages are joined into one `system` message, then the turns in order; `max_tokens`;
 * `reasoning` from the effort (per call, else the seat): for vendors whose thinking is a token budget carved
 * out of max_tokens (anthropic/*) a bounded `reasoning.max_tokens` (a share of max_tokens, omitted below
 * Anthropic's 1024 minimum) so the answer keeps most of the allowance; for every other vendor
 * `reasoning.effort`. Reasoning text is never returned (`exclude: true`). `temperature` only without a
 * reasoning block. Schema → `response_format = {type: json_schema, json_schema: {name, strict, schema}}`
 * plus `provider.require_parameters: true` so OpenRouter never routes to an upstream that would ignore it.
 * `HTTP-Referer` / `X-Title` are sent when configured (default title `tecera`).
 *
 * Response, fail closed: `object` must be 'chat.completion'; exactly one choice; its message role
 * 'assistant'; a non-empty `refusal`, any `tool_calls`, a choice `error` or a top-level `error` is an error;
 * finish_reason 'stop' → stop, 'length' → length (content dropped in schema mode), anything else
 * (content_filter, tool_calls, error, null) → error. Content must be a string (null only on length). Schema
 * mode requires content that parses as JSON. Empty output is an error.
 *
 * Usage is read before the shape is validated: `prompt_tokens` (which includes cached reads and cache
 * writes), `completion_tokens`, `prompt_tokens_details.cached_tokens` / `cache_write_tokens`, and
 * `usage.cost` (OpenRouter's own charge, USD). The charge is the dearest of the table price of the requested
 * and the reported model and OpenRouter's reported cost; an unpriced model is charged at CONSERVATIVE_PRICE
 * and flagged `unknown`. Missing usage, timeouts and unreadable bodies are bounded as in every provider.
 */

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
/** Anthropic's minimum extended-thinking budget; a smaller share sends no reasoning block. */
export const MIN_THINKING_BUDGET = 1024;
/** Share of max_tokens a budget-style reasoning block may take, per effort. */
export const THINKING_SHARE: Readonly<Record<Effort, number>> = Object.freeze({ low: 0.15, medium: 0.25, high: 0.4 });
/** Vendors whose reasoning on OpenRouter is a token budget taken out of max_tokens. */
const BUDGET_REASONING_VENDORS: ReadonlySet<string> = new Set(['anthropic']);

export interface OpenRouterOptions extends ProviderOptions {
  /** json_schema strict flag. Default true. */
  strictSchema?: boolean;
  /** Sent as `HTTP-Referer` (OpenRouter app attribution). Optional. */
  appUrl?: string;
  /** Sent as `X-Title`. Default 'tecera'; '' sends none. */
  appTitle?: string;
}

/** The reasoning block for a vendor, effort and output allowance (undefined = none). */
export function openRouterReasoning(vendor: string, effort: Effort, maxTokens: number): JsonObject | undefined {
  if (BUDGET_REASONING_VENDORS.has(vendor)) {
    const budget = Math.floor(maxTokens * THINKING_SHARE[effort]);
    return budget >= MIN_THINKING_BUDGET ? { max_tokens: budget, exclude: true } : undefined;
  }
  return { effort, exclude: true };
}

/**
 * Pure request-body mapping (exported for tests). `redact` is applied to every message text. Returns a
 * reason string when the request is malformed.
 */
export function buildOpenRouterBody(
  req: LLMRequest,
  o: { model: string; effort: Effort; defaultMaxTokens: number; strictSchema: boolean; redact?: (t: string) => string },
): JsonObject | string {
  const split = splitSystem(req, o.redact ?? ((t) => t));
  if (typeof split === 'string') return split;
  const { system, turns } = split;
  const maxTokens = req.maxTokens ?? o.defaultMaxTokens;
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) return 'maxTokens must be a positive integer';
  const vendor = openRouterVendor(o.model);
  if (!vendor) return `openrouter model ids are "vendor/model"`;
  const messages: JsonObject[] = [];
  if (system !== undefined) messages.push({ role: 'system', content: system });
  for (const t of turns) messages.push({ role: t.role, content: t.content });
  const body: JsonObject = { model: o.model, messages, max_tokens: maxTokens };
  const reasoning = openRouterReasoning(vendor, o.effort, maxTokens);
  if (reasoning) body['reasoning'] = reasoning;
  else if (req.temperature !== undefined) body['temperature'] = req.temperature;
  if (req.schema) {
    body['response_format'] = { type: 'json_schema', json_schema: { name: 'tecera_output', strict: o.strictSchema, schema: req.schema } };
    body['provider'] = { require_parameters: true };
  }
  return body;
}

const Int = z.number().int().nonnegative();
const UsageShape = z
  .object({
    prompt_tokens: Int,
    completion_tokens: Int,
    cost: z.number().finite().nonnegative().nullish(),
    prompt_tokens_details: z.object({ cached_tokens: Int.nullish(), cache_write_tokens: Int.nullish() }).passthrough().nullish(),
  })
  .passthrough();
const Message = z
  .object({
    role: z.string(),
    content: z.string().nullable(),
    refusal: z.string().nullish(),
    tool_calls: z.array(z.unknown()).nullish(),
  })
  .passthrough();
const Choice = z
  .object({
    finish_reason: z.string().nullable(),
    message: Message,
    error: z.unknown().optional(),
  })
  .passthrough();
const ResponseShape = z
  .object({
    object: z.string(),
    model: z.string(),
    choices: z.array(Choice),
    usage: UsageShape,
  })
  .passthrough();

export class OpenRouterLLM implements LLM {
  readonly id: string;
  /** The vendor (model id prefix), e.g. 'anthropic' for anthropic/claude-sonnet-4.5. */
  readonly provider: string;
  /** How the vendor is reached. */
  readonly route = 'openrouter' as const;
  readonly model: string;
  readonly keyFingerprint: string;
  readonly #o: OpenRouterOptions;
  readonly #san: Sanitizer;
  readonly #warn: WarningSink | undefined;

  constructor(o: OpenRouterOptions) {
    if (!o || typeof o.model !== 'string' || !o.model) throw new ProviderConfigError('openrouter: a model is required');
    this.#san = new Sanitizer(o.auth, o.redactor);
    if (o.auth.kind !== 'openrouter') throw new ProviderConfigError(`openrouter: credential "${o.auth.name}" is not an openrouter key`);
    const vendor = openRouterVendor(o.model);
    if (!vendor) throw new ProviderConfigError(`openrouter: model ids are "vendor/model" (e.g. anthropic/claude-sonnet-4.5), got "${o.model}"`);
    if (vendor === 'openrouter') throw new ProviderConfigError('openrouter: router aliases (openrouter/auto, ...) hide the vendor; name a vendor/model id');
    this.#o = o;
    this.model = o.model;
    this.provider = vendor;
    this.id = `${o.name ?? 'openrouter'}/${o.model}`;
    this.keyFingerprint = o.auth.fingerprint;
    this.#warn = safeWarn(o.onWarning, this.#san);
  }

  async complete(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    const req = readRequest(request);
    const model = (typeof req === 'object' && typeof req.model === 'string' && req.model) || this.model;
    let dispatched: ProviderUsage | undefined;
    try {
      if (typeof req === 'string') return errorResponse(model, `openrouter: request refused: ${req}`, this.#san);
      if (signal?.aborted) return errorResponse(model, 'openrouter: request refused: aborted before sending', this.#san);
      if (openRouterVendor(model) !== this.provider) {
        return errorResponse(model, `openrouter: request refused: model must be a ${this.provider}/* id on this seat (vendor identity is fixed per seat)`, this.#san);
      }
      const effort = resolveEffort(req, this.#o.effort);
      if (!effort) return errorResponse(model, 'openrouter: request refused: effort must be low, medium or high', this.#san);
      const prepared = prepareBody(
        (redact) => buildOpenRouterBody(req, { model, effort, defaultMaxTokens: this.#o.defaultMaxTokens ?? 16000, strictSchema: this.#o.strictSchema ?? true, redact }),
        this.#san,
      );
      if (!prepared.ok) return errorResponse(model, `openrouter: ${prepared.reason}`, this.#san);
      if (signal?.aborted) return errorResponse(model, 'openrouter: request refused: aborted before sending', this.#san);
      const maxOut = isPlainObject(prepared.body) && typeof prepared.body['max_tokens'] === 'number' ? prepared.body['max_tokens'] : Number.NaN;
      const boundFor = (models: readonly string[]): UsageBound => usageBound(models, prepared.payload, maxOut, (m, t) => estimateUsd([m], t).usd);
      const bound = boundFor([model]);
      const extra: Record<string, string> = { 'content-type': 'application/json' };
      if (this.#o.appUrl) extra['http-referer'] = this.#o.appUrl;
      const title = this.#o.appTitle ?? 'tecera';
      if (title) extra['x-title'] = title;
      const headers = this.#o.auth.authorize(extra);
      const url = `${(this.#o.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, '')}/chat/completions`;
      dispatched = settleUsage(null, 1, bound);
      const r = await postPayload(this.#o.fetch ?? defaultFetch(), url, headers, prepared.payload, retryOptions(this.#o), signal);
      if (r.kind === 'error') {
        const usage = settleUsage(null, r.uncertain, bound);
        dispatched = usage;
        let response: Json | undefined;
        try {
          response = r.body !== undefined ? this.#san.json(r.body) : undefined;
        } catch {
          return redactionFailure(usage);
        }
        return errorResponse(model, `openrouter: ${r.message}`, this.#san, {
          usage,
          ...(r.status !== undefined ? { status: r.status } : {}),
          ...(response !== undefined ? { response } : {}),
        });
      }
      dispatched = settleUsage(null, r.uncertain + 1, bound);
      return this.#parse(r.json, model, !!req.schema, boundFor, r.uncertain);
    } catch {
      try {
        return errorResponse(model, 'openrouter: internal error', this.#san, dispatched ? { usage: dispatched } : {});
      } catch {
        return redactionFailure(dispatched);
      }
    }
  }

  /**
   * Usage from the body, read before (and independently of) the response shape. The dearest of the table
   * price of the reported and requested model and OpenRouter's own `cost`; unknown when either model is
   * unpriced. Null when the body carries no valid usage. Never throws.
   */
  #reportedUsage(json: unknown, requested: string): LLMUsage | null {
    try {
      if (!isPlainObject(json)) return null;
      const u = UsageShape.safeParse(json['usage']);
      if (!u.success) return null;
      const d = u.data;
      const cacheRead = d.prompt_tokens_details?.cached_tokens ?? 0;
      const cacheWrite = d.prompt_tokens_details?.cache_write_tokens ?? 0;
      // prompt_tokens includes cache reads and writes; never let the split go negative.
      const plain = Math.max(0, d.prompt_tokens - cacheRead - cacheWrite);
      const counts = { inputTokens: plain, outputTokens: d.completion_tokens, cacheReadTokens: Math.min(cacheRead, d.prompt_tokens), cacheWriteTokens: Math.min(cacheWrite, Math.max(0, d.prompt_tokens - cacheRead)) };
      const reportedModel = typeof json['model'] === 'string' && json['model'] ? json['model'] : requested;
      const est = estimateUsd([reportedModel, requested], counts, this.#warn);
      const usd = Math.round(Math.max(est.usd, d.cost ?? 0) * 1e9) / 1e9;
      return {
        inputTokens: d.prompt_tokens,
        outputTokens: d.completion_tokens,
        usd,
        ...(d.prompt_tokens_details?.cached_tokens != null ? { cacheReadTokens: d.prompt_tokens_details.cached_tokens } : {}),
        ...(d.prompt_tokens_details?.cache_write_tokens != null ? { cacheWriteTokens: d.prompt_tokens_details.cache_write_tokens } : {}),
        ...(est.known ? {} : { unknown: true as const }),
      };
    } catch {
      return null;
    }
  }

  #parse(json: unknown, requested: string, wantSchema: boolean, boundFor: (models: readonly string[]) => UsageBound, uncertain: number): LLMResponse {
    const reported = this.#reportedUsage(json, requested);
    const reportedModel = isPlainObject(json) && typeof json['model'] === 'string' && json['model'] ? json['model'] : requested;
    const usage = settleUsage(reported, uncertain + (reported ? 0 : 1), boundFor([requested, reportedModel]));
    // A 200 that carries an error object (OpenRouter reports some upstream failures this way).
    if (isPlainObject(json) && json['error'] !== undefined && json['error'] !== null && !Array.isArray(json['choices'])) {
      let response: Json;
      try {
        response = this.#san.json(json);
      } catch {
        return redactionFailure(usage);
      }
      const em = isPlainObject(json['error']) && typeof json['error']['message'] === 'string' ? `: ${json['error']['message']}` : '';
      return errorResponse(requested, `openrouter: upstream error${em}`, this.#san, { usage, response });
    }
    const p = ResponseShape.safeParse(json);
    if (!p.success) {
      let response: Json;
      try {
        response = this.#san.json(json);
      } catch {
        return redactionFailure(usage);
      }
      return errorResponse(requested, 'openrouter: response did not match the chat completions shape', this.#san, { usage, response });
    }
    try {
      return this.#interpret(p.data, usage, json, wantSchema);
    } catch {
      return redactionFailure(usage);
    }
  }

  #interpret(r: z.infer<typeof ResponseShape>, usage: ProviderUsage, json: unknown, wantSchema: boolean): LLMResponse {
    const raw: Json = this.#san.json(json);
    const fail = (msg: string): LLMResponse => errorResponse(r.model, `openrouter: ${msg}`, this.#san, { usage, response: raw });

    if (r.object !== 'chat.completion') return fail(`unexpected object ${r.object}`);
    if (isPlainObject(json) && json['error'] != null) return fail('response carries an error');
    if (r.choices.length !== 1) return fail(`expected exactly one choice, got ${r.choices.length}`);
    const c = r.choices[0]!;
    if (c.error !== undefined && c.error !== null) return fail('choice carries an error');
    if (c.message.role !== 'assistant') return fail(`non-assistant message (role ${c.message.role})`);
    if (typeof c.message.refusal === 'string' && c.message.refusal.trim() !== '') return fail('model refused the request');
    if (Array.isArray(c.message.tool_calls) && c.message.tool_calls.length > 0) return fail('unexpected tool calls');
    let finishReason: 'stop' | 'length';
    if (c.finish_reason === 'stop') finishReason = 'stop';
    else if (c.finish_reason === 'length') finishReason = 'length';
    else return fail(`finish_reason ${String(c.finish_reason)}`);
    if (c.message.content === null && finishReason === 'stop') return fail('empty output');
    let content = c.message.content ?? '';
    if (wantSchema && finishReason === 'length') content = '';
    if (finishReason === 'stop' && content.trim() === '') return fail('empty output');
    let structured: { value: unknown } | undefined;
    if (wantSchema && finishReason === 'stop') {
      structured = parseStructured(content);
      if (!structured) return fail('structured output was not valid JSON');
    }
    return finalize({ content, model: r.model, finishReason, usage, raw, ...(structured ? { extraCheck: structured.value } : {}) }, this.#san);
  }
}
