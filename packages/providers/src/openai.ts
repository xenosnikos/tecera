import { z } from 'zod';
import type { Json, JsonObject, LLM, LLMRequest, LLMResponse, LLMUsage } from '@tecera/contracts';
import {
  defaultFetch,
  errorResponse,
  finalize,
  parseStructured,
  readRequest,
  prepareBody,
  redactionFailure,
  resolveEffort,
  retryOptions,
  safeWarn,
  Sanitizer,
  settleUsage,
  splitSystem,
  usageBound,
  isPlainObject,
  type ProviderOptions,
  type ProviderUsage,
  type UsageBound,
} from './base.js';
import { postPayload } from './http.js';
import { ProviderConfigError, type Effort } from './kinds.js';
import { estimateUsd, type WarningSink } from './pricing.js';

/**
 * OpenAI Responses API (POST /v1/responses) behind the LLM port. Chosen over chat/completions
 * because reasoning effort and json_schema output are first-class there for the gpt-5.x / gpt-6
 * reasoning models. System messages become `instructions`; the rest go to `input` in order.
 * Reasoning models (gpt-5*, gpt-6*, o*) get `reasoning.effort` (per call `req.effort`, else the seat
 * effort) and never `temperature`; other models get temperature and no reasoning block. Schema →
 * `text.format = {type: json_schema, strict: true}`. `store: false` always.
 *
 * Final output is enforced, fail closed: object must be 'response'; response status 'completed' → stop; 'incomplete' with reason
 * max_output_tokens → length (content dropped in schema mode); anything else (in_progress, queued,
 * failed, cancelled, other incomplete) → error. Output items: 'reasoning' is ignored; at most ONE
 * 'message' item, which must have role 'assistant' and status 'completed' (or 'incomplete' on length);
 * its parts must be 'output_text' (concatenated) — a 'refusal' part, any other part type, any other item
 * type (function_call, web_search_call, ...) is an error. Schema mode requires exactly one output_text
 * part that parses as JSON. Empty output is an error.
 */

export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|gpt-6|o\d)/.test(model);
}

export interface OpenAIOptions extends ProviderOptions {
  /** json_schema strict flag. Default true (schema must then be strict-compatible). */
  strictSchema?: boolean;
}

/**
 * Pure request-body mapping (exported for snapshot tests). `redact` is applied to every message text.
 * Returns a reason string when the request is malformed.
 */
export function buildOpenAIBody(
  req: LLMRequest,
  o: { model: string; effort: Effort; defaultMaxTokens: number; strictSchema: boolean; redact?: (t: string) => string },
): JsonObject | string {
  const split = splitSystem(req, o.redact ?? ((t) => t));
  if (typeof split === 'string') return split;
  const { system, turns } = split;
  const maxTokens = req.maxTokens ?? o.defaultMaxTokens;
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) return 'maxTokens must be a positive integer';
  const body: JsonObject = { model: o.model };
  if (system !== undefined) body['instructions'] = system;
  body['input'] = turns.map((t) => ({ role: t.role, content: t.content }));
  body['max_output_tokens'] = maxTokens;
  body['store'] = false;
  if (isReasoningModel(o.model)) body['reasoning'] = { effort: o.effort };
  else if (req.temperature !== undefined) body['temperature'] = req.temperature;
  if (req.schema) body['text'] = { format: { type: 'json_schema', name: 'tecera_output', schema: req.schema, strict: o.strictSchema } };
  return body;
}

const UsageShape = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    input_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().nullish() }).passthrough().nullish(),
  })
  .passthrough();
const Part = z.object({ type: z.string() }).passthrough();
const Item = z.object({ type: z.string(), role: z.string().optional(), status: z.string().optional(), content: z.array(Part).optional() }).passthrough();
const ResponseShape = z
  .object({
    object: z.string(),
    model: z.string(),
    status: z.string(),
    output: z.array(Item),
    incomplete_details: z.object({ reason: z.string().nullish() }).passthrough().nullish(),
    error: z.object({ message: z.string().nullish() }).passthrough().nullish(),
    usage: UsageShape,
  })
  .passthrough();

export class OpenAILLM implements LLM {
  readonly id: string;
  readonly provider = 'openai';
  readonly model: string;
  readonly keyFingerprint: string;
  readonly #o: OpenAIOptions;
  readonly #san: Sanitizer;
  readonly #warn: WarningSink | undefined;

  constructor(o: OpenAIOptions) {
    if (!o || typeof o.model !== 'string' || !o.model) throw new ProviderConfigError('openai: a model is required');
    this.#san = new Sanitizer(o.auth, o.redactor);
    if (o.auth.kind !== 'openai') throw new ProviderConfigError(`openai: credential "${o.auth.name}" is not an openai key`);
    this.#o = o;
    this.model = o.model;
    this.id = `${o.name ?? 'openai'}/${o.model}`;
    this.keyFingerprint = o.auth.fingerprint;
    this.#warn = safeWarn(o.onWarning, this.#san);
  }

  async complete(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    // Read the caller's request once; everything below uses this host-owned copy.
    const req = readRequest(request);
    const model = (typeof req === 'object' && typeof req.model === 'string' && req.model) || this.model;
    // Set once a request has been dispatched: any later failure still carries what it may have billed.
    let dispatched: ProviderUsage | undefined;
    try {
      if (typeof req === 'string') return errorResponse(model, `openai: request refused: ${req}`, this.#san);
      if (signal?.aborted) return errorResponse(model, 'openai: request refused: aborted before sending', this.#san);
      const effort = resolveEffort(req, this.#o.effort);
      if (!effort) return errorResponse(model, 'openai: request refused: effort must be low, medium or high', this.#san);
      const prepared = prepareBody(
        (redact) =>
          buildOpenAIBody(req, {
            model,
            effort,
            defaultMaxTokens: this.#o.defaultMaxTokens ?? 16000,
            strictSchema: this.#o.strictSchema ?? true,
            redact,
          }),
        this.#san,
      );
      if (!prepared.ok) return errorResponse(model, `openai: ${prepared.reason}`, this.#san);
      if (signal?.aborted) return errorResponse(model, 'openai: request refused: aborted before sending', this.#san);
      const maxOut = isPlainObject(prepared.body) && typeof prepared.body['max_output_tokens'] === 'number' ? prepared.body['max_output_tokens'] : Number.NaN;
      const boundFor = (models: readonly string[]): UsageBound => usageBound(models, prepared.payload, maxOut, (m, t) => estimateUsd([m], t).usd);
      const bound = boundFor([model]);
      const headers = this.#o.auth.authorize({ 'content-type': 'application/json' });
      const url = `${(this.#o.baseUrl ?? 'https://api.openai.com').replace(/\/+$/, '')}/v1/responses`;
      // Until the result is read, the request counts as possibly billed (one attempt at the bound).
      dispatched = settleUsage(null, 1, bound);
      // The bytes sent are exactly the bytes scanned.
      const r = await postPayload(this.#o.fetch ?? defaultFetch(), url, headers, prepared.payload, retryOptions(this.#o), signal);
      if (r.kind === 'error') {
        // A non-2xx answer is not billed; attempts that timed out, failed after dispatch, were aborted in
        // flight or returned an unreadable 2xx body may have been.
        const usage = settleUsage(null, r.uncertain, bound);
        dispatched = usage;
        let response: Json | undefined;
        try {
          response = r.body !== undefined ? this.#san.json(r.body) : undefined;
        } catch {
          return redactionFailure(usage);
        }
        return errorResponse(model, `openai: ${r.message}`, this.#san, {
          usage,
          ...(r.status !== undefined ? { status: r.status } : {}),
          ...(response !== undefined ? { response } : {}),
        });
      }
      dispatched = settleUsage(null, r.uncertain + 1, bound);
      return this.#parse(r.json, model, !!req.schema, boundFor, r.uncertain);
    } catch {
      try {
        return errorResponse(model, 'openai: internal error', this.#san, dispatched ? { usage: dispatched } : {});
      } catch {
        return redactionFailure(dispatched);
      }
    }
  }

  /**
   * Usage from the body, read BEFORE (and independently of) the response shape: a malformed response
   * still carries what it billed. Priced at the dearer of the reported and the requested model. Null when
   * the body carries no valid usage. Never throws.
   */
  #reportedUsage(json: unknown, requested: string): LLMUsage | null {
    try {
      if (!isPlainObject(json)) return null;
      const u = UsageShape.safeParse(json['usage']);
      if (!u.success) return null;
      const counts = { inputTokens: u.data.input_tokens, outputTokens: u.data.output_tokens };
      const reportedModel = typeof json['model'] === 'string' ? json['model'] : requested;
      // Priced at the dearer of the reported and the requested model; either one unpriced → unknown.
      const est = estimateUsd([reportedModel, requested], counts, this.#warn);
      const cached = u.data.input_tokens_details?.cached_tokens;
      return { inputTokens: counts.inputTokens, outputTokens: counts.outputTokens, usd: est.usd, ...(cached != null ? { cacheReadTokens: cached } : {}), ...(est.known ? {} : { unknown: true as const }) };
    } catch {
      return null;
    }
  }

  #parse(json: unknown, requested: string, wantSchema: boolean, boundFor: (models: readonly string[]) => UsageBound, uncertain: number): LLMResponse {
    // Usage first: the answer was received, so it is billed whether or not the rest of it is well formed.
    const reported = this.#reportedUsage(json, requested);
    // Unreported attempts are bounded by the dearer of the requested and the reported model.
    const reportedModel = isPlainObject(json) && typeof json['model'] === 'string' && json['model'] ? json['model'] : requested;
    const usage = settleUsage(reported, uncertain + (reported ? 0 : 1), boundFor([requested, reportedModel]));
    const p = ResponseShape.safeParse(json);
    if (!p.success) {
      let response: Json;
      try {
        response = this.#san.json(json);
      } catch {
        return redactionFailure(usage);
      }
      return errorResponse(requested, 'openai: response did not match the Responses API shape', this.#san, { usage, response });
    }
    const r = p.data;
    // From here on any failure (a throwing or misbehaving response redactor included) is the fixed
    // REDACTION_FAILED envelope WITH the billed usage, so budgets still settle.
    try {
      return this.#interpret(r, usage, json, wantSchema);
    } catch {
      return redactionFailure(usage);
    }
  }

  #interpret(r: z.infer<typeof ResponseShape>, usage: ProviderUsage, json: unknown, wantSchema: boolean): LLMResponse {
    const raw: Json = this.#san.json(json);
    const fail = (msg: string): LLMResponse => errorResponse(r.model, `openai: ${msg}`, this.#san, { usage, response: raw });

    if (r.object !== 'response') return fail(`unexpected object ${r.object}`);
    let finishReason: 'stop' | 'length';
    if (r.status === 'completed') finishReason = 'stop';
    else if (r.status === 'incomplete' && r.incomplete_details?.reason === 'max_output_tokens') finishReason = 'length';
    else if (r.status === 'failed') return fail(`response failed${r.error?.message ? `: ${r.error.message}` : ''}`);
    else return fail(`response ${r.status}${r.incomplete_details?.reason ? ` (${r.incomplete_details.reason})` : ''}`);

    const messages: Array<z.infer<typeof Item>> = [];
    for (const item of r.output) {
      if (item.type === 'reasoning') continue;
      if (item.type !== 'message') return fail(`unsupported output item type ${item.type}`);
      if (item.role !== 'assistant') return fail(`non-assistant message item (role ${String(item.role)})`);
      const okStatus = item.status === 'completed' || (finishReason === 'length' && item.status === 'incomplete');
      if (!okStatus) return fail(`message item is not final (status ${String(item.status)})`);
      messages.push(item);
    }
    if (messages.length > 1) return fail(`ambiguous output: ${messages.length} message items`);
    const texts: string[] = [];
    for (const part of messages[0]?.content ?? []) {
      if (part.type === 'refusal') return fail('model refused the request');
      if (part.type !== 'output_text') return fail(`unsupported content part type ${part.type}`);
      if (typeof part['text'] !== 'string') return fail('output_text part without a string text');
      texts.push(part['text']);
    }
    let content: string;
    if (wantSchema) {
      if (finishReason === 'length') content = '';
      else {
        if (texts.length !== 1) return fail(`expected exactly one structured result, got ${texts.length} output_text parts`);
        content = texts[0]!;
      }
    } else {
      content = texts.join('');
    }
    if (finishReason === 'stop' && content.trim() === '') return fail('empty output');
    let structured: { value: unknown } | undefined;
    if (wantSchema && finishReason === 'stop') {
      // Parse once and scan the DECODED result (an escaped secret inside the JSON text is caught here).
      structured = parseStructured(content);
      if (!structured) return fail('structured output was not valid JSON');
    }
    return finalize({ content, model: r.model, finishReason, usage, raw, ...(structured ? { extraCheck: structured.value } : {}) }, this.#san);
  }
}
