import { z } from 'zod';
import type { Json, JsonObject, LLM, LLMRequest, LLMResponse, LLMUsage } from '@tecera/contracts';
import {
  defaultFetch,
  errorResponse,
  finalize,
  isPlainObject,
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
  type ProviderOptions,
  type ProviderUsage,
  type UsageBound,
} from './base.js';
import { postPayload } from './http.js';
import { ProviderConfigError, type Effort } from './kinds.js';
import { estimateUsd, type WarningSink } from './pricing.js';

/**
 * Anthropic Messages API (POST /v1/messages, anthropic-version 2023-06-01) behind the LLM port.
 *
 * Effort (per call `req.effort`, else the seat effort): current models (Sonnet 5.x, Opus 4.6+, Fable,
 * Mythos) get `thinking: {type: 'adaptive'}` plus `output_config.effort`; they reject `budget_tokens`,
 * and (except 4.6) sampling params, so temperature is dropped there and whenever thinking is on. Older
 * models (Haiku 4.5, 4.5-and-earlier) map effort to thinking budget tiers (low: none, medium: 2048,
 * high: 8192 added on top of max_tokens).
 *
 * Schema: `output_config.format = {type: json_schema}` by default (structured outputs). `schemaMode:
 * 'tool'` opts into the legacy forced tool call (`emit_output`) with thinking off; forced tool_choice
 * is a 400 on Opus 5.5 / Sonnet 5.5 / Fable 5.1, so that mode is for older models only.
 *
 * Final output is enforced, fail closed: type must be 'message' and role 'assistant'; stop_reason end_turn → stop (tool_use
 * in tool mode), max_tokens → length, anything else → error. Only text / thinking / redacted_thinking
 * blocks are accepted (plus exactly one `emit_output` tool_use in tool mode); any other block, a second
 * or conflicting tool call, text beside the tool call, or anything but exactly one text block in
 * schema mode is an error. Empty output is an error. A schema result must parse as JSON.
 */

export const ANTHROPIC_VERSION = '2023-06-01';
export const SCHEMA_TOOL = 'emit_output';
export const THINKING_BUDGET: Readonly<Record<Effort, number>> = Object.freeze({ low: 0, medium: 2048, high: 8192 });

export interface AnthropicModelProfile {
  /** 'effort': output_config.effort + adaptive thinking; 'budget': thinking.budget_tokens tiers. */
  thinking: 'effort' | 'budget';
  /** Whether temperature may be sent (only ever when thinking is off). */
  sampling: boolean;
}

export function anthropicProfile(model: string): AnthropicModelProfile {
  if (/^claude-(opus|sonnet)-4-6/.test(model)) return { thinking: 'effort', sampling: true };
  if (/^claude-(opus-4-[78]|opus-5|sonnet-5|fable|mythos)/.test(model)) return { thinking: 'effort', sampling: false };
  if (/^claude-(3|haiku-|sonnet-4|opus-4)/.test(model)) return { thinking: 'budget', sampling: true };
  return { thinking: 'effort', sampling: false };
}

export interface AnthropicOptions extends ProviderOptions {
  schemaMode?: 'format' | 'tool';
  profile?: (model: string) => AnthropicModelProfile;
}

/**
 * Pure request-body mapping (exported for snapshot tests). `redact` is applied to every message text.
 * Returns a reason string when the request is malformed.
 */
export function buildAnthropicBody(
  req: LLMRequest,
  o: { model: string; effort: Effort; defaultMaxTokens: number; schemaMode: 'format' | 'tool'; profile: AnthropicModelProfile; redact?: (t: string) => string },
): JsonObject | string {
  const split = splitSystem(req, o.redact ?? ((t) => t));
  if (typeof split === 'string') return split;
  const { system, turns } = split;
  const maxTokens = req.maxTokens ?? o.defaultMaxTokens;
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) return 'maxTokens must be a positive integer';
  const body: JsonObject = { model: o.model, max_tokens: maxTokens };
  if (system !== undefined) body['system'] = system;
  body['messages'] = turns.map((t) => ({ role: t.role, content: t.content }));
  const toolMode = !!req.schema && o.schemaMode === 'tool';
  const outputConfig: JsonObject = {};
  let thinkingOn = false;
  if (o.profile.thinking === 'effort') {
    outputConfig['effort'] = o.effort;
    if (!toolMode) {
      thinkingOn = true;
      body['thinking'] = { type: 'adaptive' };
    }
  } else if (!toolMode) {
    const budget = THINKING_BUDGET[o.effort];
    if (budget > 0) {
      thinkingOn = true;
      body['thinking'] = { type: 'enabled', budget_tokens: budget };
      body['max_tokens'] = maxTokens + budget;
    }
  }
  if (req.temperature !== undefined && o.profile.sampling && !thinkingOn) body['temperature'] = req.temperature;
  if (req.schema) {
    if (toolMode) {
      body['tools'] = [{ name: SCHEMA_TOOL, description: 'Return the final answer as this tool input.', input_schema: req.schema }];
      body['tool_choice'] = { type: 'tool', name: SCHEMA_TOOL };
    } else {
      outputConfig['format'] = { type: 'json_schema', schema: req.schema };
    }
  }
  if (Object.keys(outputConfig).length) body['output_config'] = outputConfig;
  return body;
}

const Usage = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative().nullish(),
  cache_read_input_tokens: z.number().int().nonnegative().nullish(),
});
const Block = z.object({ type: z.string() }).passthrough();
const MessageResponse = z
  .object({
    type: z.string(),
    role: z.string(),
    model: z.string(),
    content: z.array(Block),
    stop_reason: z.string().nullable(),
    usage: Usage,
  })
  .passthrough();

const IGNORED_BLOCKS = new Set(['thinking', 'redacted_thinking']);

export class AnthropicLLM implements LLM {
  readonly id: string;
  readonly provider = 'anthropic';
  readonly model: string;
  readonly keyFingerprint: string;
  readonly #o: AnthropicOptions;
  readonly #san: Sanitizer;
  readonly #warn: WarningSink | undefined;

  constructor(o: AnthropicOptions) {
    if (!o || typeof o.model !== 'string' || !o.model) throw new ProviderConfigError('anthropic: a model is required');
    this.#san = new Sanitizer(o.auth, o.redactor);
    if (o.auth.kind !== 'anthropic') throw new ProviderConfigError(`anthropic: credential "${o.auth.name}" is not an anthropic key`);
    this.#o = o;
    this.model = o.model;
    this.id = `${o.name ?? 'anthropic'}/${o.model}`;
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
      if (typeof req === 'string') return errorResponse(model, `anthropic: request refused: ${req}`, this.#san);
      if (signal?.aborted) return errorResponse(model, 'anthropic: request refused: aborted before sending', this.#san);
      const effort = resolveEffort(req, this.#o.effort);
      if (!effort) return errorResponse(model, 'anthropic: request refused: effort must be low, medium or high', this.#san);
      const schemaMode = this.#o.schemaMode ?? 'format';
      const prepared = prepareBody(
        (redact) =>
          buildAnthropicBody(req, {
            model,
            effort,
            defaultMaxTokens: this.#o.defaultMaxTokens ?? 16000,
            schemaMode,
            profile: (this.#o.profile ?? anthropicProfile)(model),
            redact,
          }),
        this.#san,
      );
      if (!prepared.ok) return errorResponse(model, `anthropic: ${prepared.reason}`, this.#san);
      if (signal?.aborted) return errorResponse(model, 'anthropic: request refused: aborted before sending', this.#san);
      // max_tokens already includes any thinking budget: it caps every billed output token.
      const maxOut = isPlainObject(prepared.body) && typeof prepared.body['max_tokens'] === 'number' ? prepared.body['max_tokens'] : Number.NaN;
      const boundFor = (models: readonly string[]): UsageBound => usageBound(models, prepared.payload, maxOut, (m, t) => estimateUsd([m], t).usd);
      const bound = boundFor([model]);
      const headers = this.#o.auth.authorize({ 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION });
      const url = `${(this.#o.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages`;
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
        return errorResponse(model, `anthropic: ${r.message}`, this.#san, {
          usage,
          ...(r.status !== undefined ? { status: r.status } : {}),
          ...(response !== undefined ? { response } : {}),
        });
      }
      dispatched = settleUsage(null, r.uncertain + 1, bound);
      return this.#parse(r.json, model, !!req.schema, schemaMode, boundFor, r.uncertain);
    } catch {
      try {
        return errorResponse(model, 'anthropic: internal error', this.#san, dispatched ? { usage: dispatched } : {});
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
      const p = Usage.safeParse(json['usage']);
      if (!p.success) return null;
      const u = p.data;
      const counts = {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
      };
      const reportedModel = typeof json['model'] === 'string' ? json['model'] : requested;
      // Priced at the dearer of the reported and the requested model; either one unpriced → unknown.
      const est = estimateUsd([reportedModel, requested], counts, this.#warn);
      const usd = est.usd;
      return {
        ...(est.known ? {} : { unknown: true as const }),
        inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        outputTokens: u.output_tokens,
        usd,
        ...(u.cache_read_input_tokens != null ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
        ...(u.cache_creation_input_tokens != null ? { cacheWriteTokens: u.cache_creation_input_tokens } : {}),
      };
    } catch {
      return null;
    }
  }

  #parse(json: unknown, requested: string, wantSchema: boolean, schemaMode: 'format' | 'tool', boundFor: (models: readonly string[]) => UsageBound, uncertain: number): LLMResponse {
    // Usage first: the answer was received, so it is billed whether or not the rest of it is well formed.
    const reported = this.#reportedUsage(json, requested);
    // Unreported attempts are bounded by the dearer of the requested and the reported model.
    const reportedModel = isPlainObject(json) && typeof json['model'] === 'string' && json['model'] ? json['model'] : requested;
    const usage = settleUsage(reported, uncertain + (reported ? 0 : 1), boundFor([requested, reportedModel]));
    const p = MessageResponse.safeParse(json);
    if (!p.success) {
      let response: Json;
      try {
        response = this.#san.json(json);
      } catch {
        return redactionFailure(usage);
      }
      return errorResponse(requested, 'anthropic: response did not match the Messages API shape', this.#san, { usage, response });
    }
    const m = p.data;
    // From here on any failure (a throwing or misbehaving response redactor included) is the fixed
    // REDACTION_FAILED envelope WITH the billed usage, so budgets still settle.
    try {
      return this.#interpret(m, usage, json, wantSchema, schemaMode);
    } catch {
      return redactionFailure(usage);
    }
  }

  #interpret(m: z.infer<typeof MessageResponse>, usage: ProviderUsage, json: unknown, wantSchema: boolean, schemaMode: 'format' | 'tool'): LLMResponse {
    const raw: Json = this.#san.json(json);
    const fail = (msg: string): LLMResponse => errorResponse(m.model, `anthropic: ${msg}`, this.#san, { usage, response: raw });

    if (m.type !== 'message') return fail(`unexpected response type ${m.type}`);
    if (m.role !== 'assistant') return fail(`response role is ${m.role}, not assistant`);
    const toolMode = wantSchema && schemaMode === 'tool';

    let finishReason: 'stop' | 'length';
    switch (m.stop_reason) {
      case 'end_turn':
        if (toolMode) return fail(`no ${SCHEMA_TOOL} tool call (stop_reason end_turn)`);
        finishReason = 'stop';
        break;
      case 'tool_use':
        if (!toolMode) return fail('unexpected tool_use stop');
        finishReason = 'stop';
        break;
      case 'max_tokens':
        finishReason = 'length';
        break;
      case 'refusal':
        return fail('model refused the request');
      default:
        return fail(`unsupported stop_reason ${String(m.stop_reason)}`);
    }

    const texts: string[] = [];
    const calls: Array<Record<string, unknown>> = [];
    for (const b of m.content) {
      if (IGNORED_BLOCKS.has(b.type)) continue;
      if (b.type === 'text') {
        if (typeof b['text'] !== 'string') return fail('text block without a string text');
        texts.push(b['text']);
      } else if (b.type === 'tool_use') {
        if (!toolMode) return fail('unexpected tool_use block');
        calls.push(b);
      } else {
        return fail(`unsupported content block type ${b.type}`);
      }
    }

    let content: string;
    let extraCheck: unknown;
    if (toolMode) {
      if (texts.some((t) => t.trim() !== '')) return fail('ambiguous output: text alongside the structured tool call');
      if (calls.some((c) => c['name'] !== SCHEMA_TOOL)) return fail('unexpected tool call (only emit_output is allowed)');
      if (finishReason === 'length') {
        content = '';
      } else {
        if (calls.length !== 1) return fail(`expected exactly one ${SCHEMA_TOOL} tool call, got ${calls.length}`);
        const input = calls[0]!['input'];
        if (!isPlainObject(input)) return fail('structured tool input is not an object');
        extraCheck = input;
        try {
          content = JSON.stringify(input);
        } catch {
          return fail('structured tool input is not serializable');
        }
      }
    } else if (wantSchema) {
      if (finishReason === 'length') content = '';
      else {
        if (texts.length !== 1) return fail(`expected exactly one structured result, got ${texts.length} text blocks`);
        content = texts[0]!;
        if (content.trim() === '') return fail('empty output');
        // Parse once and scan the DECODED result (an escaped secret inside the JSON text is caught here).
        const structured = parseStructured(content);
        if (!structured) return fail('structured output was not valid JSON');
        extraCheck = structured.value;
      }
    } else {
      content = texts.join('');
    }
    if (finishReason === 'stop' && content.trim() === '') return fail('empty output');
    return finalize({ content, model: m.model, finishReason, usage, raw, ...(extraCheck !== undefined ? { extraCheck } : {}) }, this.#san);
  }
}
