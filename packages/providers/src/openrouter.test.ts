import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { LLMRequest, LLMResponse } from '@tecera/contracts';
import { seatVendor } from '@tecera/contracts';
import { AnthropicLLM } from './anthropic.js';
import { INPUT_OVERHEAD_TOKENS, SECRET_OUTPUT_REFUSED, type ProviderUsage } from './base.js';
import { createProvider, ForeignCheckError, foreignCheck, seatVendorOf } from './factory.js';
import { authScheme, inferKind, KEY_ENV, openRouterVendor, ProviderConfigError, requireKind, toOpenRouterModel, vendorOf } from './kinds.js';
import { OpenAILLM } from './openai.js';
import { buildOpenRouterBody, MIN_THINKING_BUDGET, OpenRouterLLM, openRouterReasoning, THINKING_SHARE } from './openrouter.js';
import { CONSERVATIVE_PRICE, costAt, costUsd, estimateUsd, isPriced, OPENROUTER_PRICES, PRICES } from './pricing.js';
import { SecretStore } from './secrets.js';
import { FixtureFetch, fixtureNames, type FixtureSpec } from './testing/fixtureFetch.js';

/**
 * D7: OpenRouter as a first-class provider kind (OpenAI-compatible chat/completions at
 * https://openrouter.ai/api/v1, vendor/model ids, usage and cost from the response, a pricing table with
 * unknown → conservative), its vendor identity for foreign review (D5), SecretStore.fromEnv, and the
 * Sprint-4 Codex models findings 1 and 2 (pricing certainty tracked apart from the amount; missing-usage
 * bounds include the reported model) for every adapter.
 */

const aKey = 'sk-ant-api03-' + randomBytes(24).toString('hex');
const oKey = 'sk-proj-' + randomBytes(24).toString('hex');
const rKey = 'sk-or-v1-' + randomBytes(32).toString('hex');
const noSleep = { sleep: async () => {}, random: () => 0.5, maxRetries: 0 };

function store(): SecretStore {
  return SecretStore.fromManifest(
    { providers: { anthropic: { auth: 'env:A' }, openai: { auth: 'env:O' }, openrouter: { auth: 'env:R' } } },
    { env: { A: aKey, O: oKey, R: rKey } },
  );
}

const SONNET = 'anthropic/claude-sonnet-4.5';
const or = (ff: FixtureFetch, over: Record<string, unknown> = {}) => new OpenRouterLLM({ auth: store().get('openrouter'), model: SONNET, fetch: ff.fetch, ...noSleep, ...over });
const req = (over: Partial<LLMRequest> = {}): LLMRequest => ({ seatId: 'reviewer', model: '', messages: [{ role: 'user', content: 'Review the diff.' }], maxTokens: 1000, ...over });
const SCHEMA = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } };

function expectEnvelope(r: LLMResponse): void {
  expect(r.finishReason).toBe('error');
  expect(r.content).toBe(r.error);
  expect((r.raw as { error?: unknown }).error).toBe(r.error);
}

function expectNoKey(x: unknown): void {
  const t = JSON.stringify(x);
  for (const k of [aKey, oKey, rKey]) {
    expect(t).not.toContain(k);
    expect(t).not.toContain(Buffer.from(k).toString('base64'));
  }
}

describe('kinds: openrouter', () => {
  it('infers openrouter from the name, before anthropic/claude or openai/gpt', () => {
    expect(inferKind('openrouter')).toBe('openrouter');
    expect(inferKind('openrouter-claude')).toBe('openrouter');
    expect(inferKind('work-OpenRouter-gpt')).toBe('openrouter');
    expect(inferKind('anthropic')).toBe('anthropic');
    expect(inferKind('mystery', { mystery: 'openrouter' })).toBe('openrouter');
    expect(() => requireKind('claude-gpt')).toThrow(ProviderConfigError);
    expect(authScheme('openrouter')).toEqual({ header: 'authorization', prefix: 'Bearer ' });
    expect(KEY_ENV).toEqual({ anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', openrouter: 'OPENROUTER_API_KEY' });
  });

  it('vendor = the model id prefix on OpenRouter, else the kind; matches the manifest seatVendor', () => {
    expect(openRouterVendor('anthropic/claude-sonnet-4.5')).toBe('anthropic');
    expect(openRouterVendor('OpenAI/gpt-5.6-terra')).toBe('openai');
    expect(openRouterVendor('claude-sonnet-4-5')).toBeNull();
    expect(openRouterVendor('a/b/c')).toBeNull();
    expect(vendorOf('openrouter', 'google/gemini-3.1-pro')).toBe('google');
    expect(vendorOf('anthropic', 'claude-sonnet-5')).toBe('anthropic');
    expect(() => vendorOf('openrouter', 'claude-sonnet-4-5')).toThrow(ProviderConfigError);
    for (const seat of [
      { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' },
      { provider: 'openrouter', model: 'openai/gpt-5.6-terra' },
      { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
      { provider: 'openai', model: 'gpt-5.6-terra' },
    ]) {
      expect(seatVendorOf(seat)).toBe(seatVendor(seat));
    }
  });

  it('maps first-party ids to OpenRouter ids (Claude routed through OpenRouter)', () => {
    expect(toOpenRouterModel('claude-sonnet-4-5')).toBe('anthropic/claude-sonnet-4.5');
    expect(toOpenRouterModel('claude-haiku-4-5-20251001')).toBe('anthropic/claude-haiku-4.5');
    expect(toOpenRouterModel('claude-opus-5-5')).toBe('anthropic/claude-opus-5.5');
    expect(toOpenRouterModel('claude-sonnet-5')).toBe('anthropic/claude-sonnet-5');
    expect(toOpenRouterModel('gpt-5.6-terra')).toBe('openai/gpt-5.6-terra');
    expect(toOpenRouterModel('anthropic/claude-sonnet-4.5')).toBe('anthropic/claude-sonnet-4.5');
    expect(toOpenRouterModel('mystery')).toBeNull();
    for (const m of ['claude-sonnet-4-5', 'claude-haiku-4-5-20251001', 'claude-opus-5-5', 'claude-sonnet-5', 'gpt-5.6-terra']) expect(isPriced(toOpenRouterModel(m)!)).toBe(true);
  });
});

describe('pricing table: OpenRouter ids, long-context tiers, unknown → conservative', () => {
  it('prices the five required models (USD per MTok) and keeps the list price where OpenRouter is promotional', () => {
    expect(OPENROUTER_PRICES['anthropic/claude-sonnet-4.5']).toMatchObject({ inputPerM: 3, outputPerM: 15 });
    expect(OPENROUTER_PRICES['anthropic/claude-haiku-4.5']).toMatchObject({ inputPerM: 1, outputPerM: 5 });
    expect(OPENROUTER_PRICES['openai/gpt-5.6-terra']).toMatchObject({ inputPerM: 2, outputPerM: 12 });
    expect(OPENROUTER_PRICES['openai/gpt-5.6-sol']).toMatchObject({ inputPerM: 5, outputPerM: 30 });
    expect(OPENROUTER_PRICES['google/gemini-3.1-pro']).toMatchObject({ inputPerM: 2, outputPerM: 12 });
    for (const k of Object.keys(OPENROUTER_PRICES)) expect(PRICES[k]).toEqual(OPENROUTER_PRICES[k]);
  });

  it('long-context tier applies to the whole call once the prompt reaches the threshold', () => {
    expect(costUsd(SONNET, { inputTokens: 199_999, outputTokens: 1000 })).toBeCloseTo(199_999 * 3e-6 + 1000 * 15e-6, 9);
    expect(costUsd(SONNET, { inputTokens: 200_000, outputTokens: 1000 })).toBeCloseTo(200_000 * 6e-6 + 1000 * 22.5e-6, 9);
    expect(costUsd(SONNET, { inputTokens: 100_000, cacheReadTokens: 100_000, outputTokens: 0 })).toBeCloseTo(100_000 * 6e-6 + 100_000 * 6e-6 * 0.1, 9);
  });

  it('estimateUsd: dearest of the ids, unpriced ids at CONSERVATIVE_PRICE and known:false (never a confirmed charge)', () => {
    const t = { inputTokens: 1000, outputTokens: 500 };
    expect(estimateUsd(['claude-sonnet-5'], t)).toEqual({ usd: costUsd('claude-sonnet-5', t), known: true });
    expect(estimateUsd(['claude-haiku-4-5', 'claude-sonnet-5'], t)).toEqual({ usd: costUsd('claude-sonnet-5', t), known: true });
    const warn: string[] = [];
    const u = estimateUsd(['claude-sonnet-5', 'claude-new-x'], t, (w) => warn.push(w));
    expect(u).toEqual({ usd: costAt(CONSERVATIVE_PRICE, t), known: false });
    expect(warn).toHaveLength(1);
    expect(estimateUsd([], t).known).toBe(false);
    for (const p of Object.values(PRICES)) {
      expect(CONSERVATIVE_PRICE.inputPerM).toBeGreaterThanOrEqual(p.longContext?.inputPerM ?? p.inputPerM);
      expect(CONSERVATIVE_PRICE.outputPerM).toBeGreaterThanOrEqual(p.longContext?.outputPerM ?? p.outputPerM);
    }
  });
});

describe('OpenRouterLLM: construction and identity', () => {
  it('createProvider builds it; provider is the vendor, keyFingerprint the OpenRouter key', () => {
    const s = store();
    const llm = createProvider({ provider: 'openrouter', model: SONNET, effort: 'high' }, s);
    expect(llm).toBeInstanceOf(OpenRouterLLM);
    expect(llm.provider).toBe('anthropic');
    expect((llm as OpenRouterLLM).route).toBe('openrouter');
    expect(llm.id).toBe(`openrouter/${SONNET}`);
    expect(llm.keyFingerprint).toBe(s.get('openrouter').fingerprint);
    expect(llm.keyFingerprint).not.toBe(s.get('anthropic').fingerprint);
    expect(createProvider({ provider: 'openrouter', model: 'openai/gpt-5.6-terra' }, s).provider).toBe('openai');
  });

  it('fails closed: no vendor prefix, router aliases, a non-openrouter credential, kind mismatch', () => {
    const s = store();
    expect(() => createProvider({ provider: 'openrouter', model: 'claude-sonnet-4-5' }, s)).toThrow(ProviderConfigError);
    expect(() => createProvider({ provider: 'openrouter', model: 'openrouter/auto' }, s)).toThrow(/hide the vendor/);
    expect(() => new OpenRouterLLM({ auth: s.get('openai'), model: SONNET })).toThrow(/not an openrouter key/);
    expect(() => createProvider({ provider: 'openrouter', model: SONNET }, s, { kinds: { openrouter: 'openai' } })).toThrow(ProviderConfigError);
  });

  it('a request naming another vendor than the seat is refused before sending', async () => {
    const ff = new FixtureFetch(['openrouter/ok']);
    const r = await or(ff).complete(req({ model: 'openai/gpt-5.6-terra' }));
    expectEnvelope(r);
    expect(r.error).toMatch(/model must be a anthropic\/\* id/);
    expect(ff.calls).toHaveLength(0);
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0, usd: 0 });
    const ok = new FixtureFetch(['openrouter/ok']);
    expect((await or(ok).complete(req({ model: 'anthropic/claude-haiku-4.5' }))).finishReason).toBe('stop');
  });
});

describe('OpenRouterLLM: wire request', () => {
  it('POSTs chat/completions with Bearer auth, X-Title and optional HTTP-Referer; the key is never recorded', async () => {
    const ff = new FixtureFetch(['openrouter/ok', 'openrouter/ok']);
    await or(ff).complete(req());
    expect(ff.calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(ff.calls[0]!.method).toBe('POST');
    expect(ff.calls[0]!.headers).toMatchObject({ authorization: '<present>', 'content-type': 'application/json', 'x-title': 'tecera' });
    expect(ff.calls[0]!.headers['http-referer']).toBeUndefined();
    await or(ff, { appUrl: 'https://example.invalid/tecera', appTitle: '', baseUrl: 'https://proxy.invalid/v1/' }).complete(req());
    expect(ff.calls[1]!.url).toBe('https://proxy.invalid/v1/chat/completions');
    expect(ff.calls[1]!.headers['http-referer']).toBe('https://example.invalid/tecera');
    expect(ff.calls[1]!.headers['x-title']).toBeUndefined();
    expectNoKey(ff.calls);
  });

  it('body: system joined first, turns in order, max_tokens, budget reasoning for anthropic/*, effort for others', () => {
    const r = req({
      messages: [
        { role: 'system', content: 'S1' },
        { role: 'user', content: 'U1' },
        { role: 'system', content: 'S2' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'U2' },
      ],
      maxTokens: 8000,
      temperature: 0,
    });
    const a = buildOpenRouterBody(r, { model: SONNET, effort: 'high', defaultMaxTokens: 16000, strictSchema: true });
    expect(a).toEqual({
      model: SONNET,
      messages: [
        { role: 'system', content: 'S1\n\nS2' },
        { role: 'user', content: 'U1' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'U2' },
      ],
      max_tokens: 8000,
      reasoning: { max_tokens: Math.floor(8000 * THINKING_SHARE.high), exclude: true },
    });
    const o = buildOpenRouterBody(r, { model: 'openai/gpt-5.6-terra', effort: 'low', defaultMaxTokens: 16000, strictSchema: true }) as Record<string, unknown>;
    expect(o['reasoning']).toEqual({ effort: 'low', exclude: true });
    expect(o['temperature']).toBeUndefined();
    // Below Anthropic's minimum thinking budget: no reasoning block, temperature passes through.
    const small = buildOpenRouterBody({ ...r, maxTokens: 64 }, { model: SONNET, effort: 'high', defaultMaxTokens: 16000, strictSchema: true }) as Record<string, unknown>;
    expect(small['reasoning']).toBeUndefined();
    expect(small['temperature']).toBe(0);
    expect(openRouterReasoning('anthropic', 'low', Math.ceil(MIN_THINKING_BUDGET / THINKING_SHARE.low))).toMatchObject({ max_tokens: MIN_THINKING_BUDGET });
    expect(openRouterReasoning('google', 'medium', 64)).toEqual({ effort: 'medium', exclude: true });
  });

  it('schema → response_format json_schema strict + provider.require_parameters', () => {
    const b = buildOpenRouterBody(req({ schema: SCHEMA }), { model: 'openai/gpt-5.6-terra', effort: 'medium', defaultMaxTokens: 16000, strictSchema: true }) as Record<string, unknown>;
    expect(b['response_format']).toEqual({ type: 'json_schema', json_schema: { name: 'tecera_output', strict: true, schema: SCHEMA } });
    expect(b['provider']).toEqual({ require_parameters: true });
    expect(buildOpenRouterBody(req({ maxTokens: 0 }), { model: SONNET, effort: 'low', defaultMaxTokens: 1, strictSchema: true })).toBe('maxTokens must be a positive integer');
    expect(buildOpenRouterBody(req({ messages: [{ role: 'system', content: 'x' }] }), { model: SONNET, effort: 'low', defaultMaxTokens: 1, strictSchema: true })).toBe('request has no user message');
  });

  it('per-call effort overrides the seat effort; a bad effort is refused unsent', async () => {
    const ff = new FixtureFetch(['openrouter/ok', 'openrouter/ok']);
    const llm = or(ff, { model: 'openai/gpt-5.6-terra', effort: 'high' });
    await llm.complete(req({ model: '' }));
    await llm.complete(req({ effort: 'low' }));
    expect(ff.calls.map((c) => (c.body as { reasoning: unknown }).reasoning)).toEqual([
      { effort: 'high', exclude: true },
      { effort: 'low', exclude: true },
    ]);
    const bad = await llm.complete(req({ effort: 'max' as never }));
    expect(bad.error).toMatch(/effort must be/);
    expect(ff.calls).toHaveLength(2);
  });

  it('message text is redacted before sending; a secret elsewhere in the request is refused unsent', async () => {
    for (const k of [aKey, oKey, rKey]) {
      const ff = new FixtureFetch(['openrouter/ok']);
      const r = await or(ff, { model: 'anthropic/claude-haiku-4.5' }).complete(req({ messages: [{ role: 'user', content: `token ${Buffer.from(k).toString('base64')}` }] }));
      expect(r.finishReason).toBe('stop');
      expect(ff.calls).toHaveLength(1);
      expect(ff.calls[0]!.bodyText).toContain('[REDACTED:');
      expectNoKey(ff.calls);
      const s = new FixtureFetch(['openrouter/ok']);
      const rs = await or(s).complete(req({ schema: { type: 'object', description: k } }));
      expect(rs.error).toMatch(/request refused/);
      expect(s.calls).toHaveLength(0);
      expectNoKey([r, rs]);
    }
  });
});

describe('OpenRouterLLM: responses (fail closed)', () => {
  it('ok: content, model, stop, usage priced from the table and the reported cost', async () => {
    const r = await or(new FixtureFetch(['openrouter/ok']), { model: 'anthropic/claude-haiku-4.5' }).complete(req());
    expect(r).toMatchObject({ content: 'ok', model: 'anthropic/claude-haiku-4.5', finishReason: 'stop' });
    // 18 in x $1 + 4 out x $5 per MTok = $0.000038, which is also OpenRouter's reported cost.
    expect(r.usage).toEqual({ inputTokens: 18, outputTokens: 4, usd: 0.000038, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect((r.usage as ProviderUsage).unknown).toBeUndefined();
  });

  it('schema: JSON content passes; non-JSON content is an error with billed usage', async () => {
    const r = await or(new FixtureFetch(['openrouter/schema'])).complete(req({ schema: SCHEMA }));
    expect(r.finishReason).toBe('stop');
    expect(JSON.parse(r.content)).toEqual({ ok: true });
    expect(r.usage.usd).toBeCloseTo(0.000594, 9);
    const bad = await or(new FixtureFetch(['openrouter/not-json-schema'])).complete(req({ schema: SCHEMA }));
    expectEnvelope(bad);
    expect(bad.error).toMatch(/not valid JSON/);
    expect(bad.usage.inputTokens).toBe(1000);
  });

  it('length: finishReason length; null content allowed; content dropped in schema mode', async () => {
    const r = await or(new FixtureFetch(['openrouter/length']), { model: 'google/gemini-3.1-pro-preview' }).complete(req());
    expect(r).toMatchObject({ finishReason: 'length', content: '' });
    expect(r.usage.outputTokens).toBe(61);
    const s = await or(new FixtureFetch([{ status: 200, body: { object: 'chat.completion', model: SONNET, choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{"ok": tr' } }], usage: { prompt_tokens: 5, completion_tokens: 5 } } }])).complete(req({ schema: SCHEMA }));
    expect(s).toMatchObject({ finishReason: 'length', content: '' });
  });

  const failures: Array<[string, RegExp]> = [
    ['refusal', /refused/],
    ['tool-calls', /tool calls/],
    ['content-filter', /finish_reason content_filter/],
    ['finish-null', /finish_reason null/],
    ['empty', /empty output/],
    ['two-choices', /exactly one choice, got 2/],
    ['user-role', /non-assistant message \(role user\)/],
    ['error-200', /upstream error: Upstream provider returned an error/],
    ['choice-error', /choice carries an error/],
    ['wrong-shape', /did not match the chat completions shape/],
  ];
  for (const [name, re] of failures) {
    it(`${name} → error envelope (usage kept when reported)`, async () => {
      const r = await or(new FixtureFetch([`openrouter/${name}`])).complete(req());
      expectEnvelope(r);
      expect(r.error).toMatch(re);
      if (!['error-200'].includes(name)) expect(r.usage.inputTokens).toBeGreaterThan(0);
    });
  }

  it('HTTP errors: 400 not billed and not retried; 429 retried then ok; echoed auth is redacted', async () => {
    const ff400 = new FixtureFetch(['openrouter/400-model', 'openrouter/ok']);
    const r400 = await or(ff400, { maxRetries: 2 }).complete(req());
    expectEnvelope(r400);
    expect(r400.error).toMatch(/HTTP 400: nonexistent\/model-x is not a valid model ID/);
    expect(ff400.calls).toHaveLength(1);
    expect(r400.usage).toEqual({ inputTokens: 0, outputTokens: 0, usd: 0 });
    const ff = new FixtureFetch(['openrouter/429', 'openrouter/ok']);
    const r = await or(ff, { maxRetries: 2, model: 'anthropic/claude-haiku-4.5' }).complete(req());
    expect(r.finishReason).toBe('stop');
    expect(ff.calls).toHaveLength(2);
    const e = await or(new FixtureFetch(['openrouter/echo-auth'])).complete(req());
    expect((e.raw as { status?: number }).status).toBe(401);
    expect(JSON.stringify(e)).toContain('[REDACTED:openrouter:');
    expectNoKey(e);
  });

  it('a secret in content or model is refused, never returned', async () => {
    for (const name of ['echo-content', 'echo-model']) {
      const r = await or(new FixtureFetch([`openrouter/${name}`])).complete(req());
      expectEnvelope(r);
      expect(r.error).toBe(SECRET_OUTPUT_REFUSED);
      expectNoKey(r);
    }
  });

  it('malformed 2xx body → unknown usage bounded at the payload, never a confirmed zero', async () => {
    const ff = new FixtureFetch(['openrouter/malformed']);
    const r = await or(ff).complete(req({ maxTokens: 1000 }));
    expectEnvelope(r);
    const u = r.usage as ProviderUsage;
    expect(u.unknown).toBe(true);
    expect(u.inputTokens).toBe(Buffer.byteLength(ff.calls[0]!.bodyText!, 'utf8') + INPUT_OVERHEAD_TOKENS);
    expect(u.outputTokens).toBe(1000);
    expect(u.usd).toBeGreaterThan(0);
  });
});

describe('OpenRouterLLM: usage and cost', () => {
  it('OpenRouter reported cost above the table wins (never under-charge)', async () => {
    const r = await or(new FixtureFetch(['openrouter/cost-above-table'])).complete(req());
    expect(r.usage.usd).toBe(1.25);
    expect((r.usage as ProviderUsage).unknown).toBeUndefined();
  });

  it('an unpriced reported model → conservative price and unknown:true even though the requested model is priced', async () => {
    const warnings: string[] = [];
    const r = await or(new FixtureFetch(['openrouter/unpriced']), { onWarning: (w: string) => warnings.push(w) }).complete(req());
    expect(r.finishReason).toBe('stop');
    expect((r.usage as ProviderUsage).unknown).toBe(true);
    expect(r.usage.usd).toBe(costAt(CONSERVATIVE_PRICE, { inputTokens: 1000, outputTokens: 500 }));
    expect(r.usage.usd).toBeGreaterThan(costUsd(SONNET, { inputTokens: 1000, outputTokens: 500 }));
    expect(warnings.join('\n')).toMatch(/claude-mystery-9/);
  });

  it('an unpriced requested model is unknown too', async () => {
    const ff = new FixtureFetch([{ status: 200, body: { object: 'chat.completion', model: 'anthropic/claude-next', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.00001 } } }]);
    const r = await or(ff, { model: 'anthropic/claude-next' }).complete(req());
    expect((r.usage as ProviderUsage).unknown).toBe(true);
    expect(r.usage.usd).toBe(costAt(CONSERVATIVE_PRICE, { inputTokens: 10, outputTokens: 10 }));
  });

  it('cache reads and writes inside prompt_tokens are priced with their multipliers', async () => {
    const r = await or(new FixtureFetch(['openrouter/cached'])).complete(req());
    // 10,000 prompt = 1,000 plain + 8,000 cache reads (x0.1) + 1,000 cache writes (x1.25), at $3/MTok; 100 out at $15.
    expect(r.usage).toMatchObject({ inputTokens: 10_000, outputTokens: 100, cacheReadTokens: 8000, cacheWriteTokens: 1000 });
    expect(r.usage.usd).toBeCloseTo(1000 * 3e-6 + 8000 * 3e-6 * 0.1 + 1000 * 3e-6 * 1.25 + 100 * 15e-6, 9);
  });

  it('missing usage with a dearer reported model → the bound uses the dearer model (Codex models finding 2)', async () => {
    const body = { object: 'chat.completion', model: 'openai/gpt-5.6-sol', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }] };
    const ffr = new FixtureFetch([{ status: 200, body }]);
    // The seat is openai/gpt-5.6-luna; the answer claims openai/gpt-5.6-sol and carries no usage.
    const r = await or(ffr, { model: 'openai/gpt-5.6-luna' }).complete(req({ maxTokens: 1000 }));
    const u = r.usage as ProviderUsage;
    expect(u.unknown).toBe(true);
    const sent = Buffer.byteLength(ffr.calls[0]!.bodyText!, 'utf8') + INPUT_OVERHEAD_TOKENS;
    expect(u.usd).toBeCloseTo(costUsd('openai/gpt-5.6-sol', { inputTokens: 0, cacheWriteTokens: sent, outputTokens: 1000 }), 9);
  });
});

describe('foreign review across routes (D5)', () => {
  it('OpenRouter anthropic/* vs direct Anthropic: same vendor → not foreign; vs direct OpenAI → foreign', () => {
    const s = store();
    const direct = createProvider({ provider: 'anthropic', model: 'claude-sonnet-5' }, s);
    const viaOr = createProvider({ provider: 'openrouter', model: SONNET }, s);
    const gpt = createProvider({ provider: 'openai', model: 'gpt-5.6-terra' }, s);
    expect(() => foreignCheck(direct, viaOr)).toThrow(/distinct providers/);
    expect(() => foreignCheck(gpt, viaOr)).not.toThrow();
    expect(direct).toBeInstanceOf(AnthropicLLM);
    expect(gpt).toBeInstanceOf(OpenAILLM);
  });

  it('two OpenRouter seats of different vendors share one key → not foreign (credential)', () => {
    const s = store();
    const a = createProvider({ provider: 'openrouter', model: SONNET }, s);
    const b = createProvider({ provider: 'openrouter', model: 'openai/gpt-5.6-terra' }, s);
    expect(() => foreignCheck(a, b)).toThrow(ForeignCheckError);
    expect(() => foreignCheck(a, b)).toThrow(/distinct credentials/);
  });
});

describe('SecretStore.fromEnv', () => {
  it('resolves every conventional key that is set, skips the rest, deletes resolved variables', () => {
    const env: Record<string, string | undefined> = { OPENROUTER_API_KEY: rKey, OPENAI_API_KEY: '', OTHER: 'x' };
    const s = SecretStore.fromEnv(undefined, { env });
    expect(s.names()).toEqual(['openrouter']);
    expect(s.get('openrouter').kind).toBe('openrouter');
    expect(env['OPENROUTER_API_KEY']).toBeUndefined();
    expect(env['OTHER']).toBe('x');
    expect(s.redact(`k=${rKey}`)).not.toContain(rKey);
    expect(s.get('openrouter').authorize({})).toEqual({ authorization: `Bearer ${rKey}` });
    const t = SecretStore.fromEnv(['anthropic'], { env: { ANTHROPIC_API_KEY: aKey, OPENROUTER_API_KEY: rKey }, deleteFromEnv: false });
    expect(t.names()).toEqual(['anthropic']);
  });
});

describe('fixtures', () => {
  it('bundles the openrouter fixtures', () => {
    const names = fixtureNames().filter((n) => n.startsWith('openrouter/'));
    expect(names).toEqual(expect.arrayContaining(['openrouter/ok', 'openrouter/schema', 'openrouter/length', 'openrouter/unpriced']));
  });
});

describe('Codex models finding 1: pricing certainty in the first-party adapters', () => {
  const body = (model: string): FixtureSpec => ({ status: 200, body: { type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } } });
  const oBody = (model: string): FixtureSpec => ({
    status: 200,
    body: { object: 'response', model, status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hi' }] }], usage: { input_tokens: 5, output_tokens: 5 } },
  });
  const t = { inputTokens: 5, outputTokens: 5 };
  const cases: Array<[string, string, boolean]> = [
    ['priced', 'priced', true],
    ['priced', 'unpriced', false],
    ['unpriced', 'priced', false],
    ['unpriced', 'unpriced', false],
  ];
  for (const [rq, rp, known] of cases) {
    it(`requested ${rq} / reported ${rp} → ${known ? 'confirmed' : 'unknown, conservative'} (both adapters)`, async () => {
      const s = store();
      const aReq = rq === 'priced' ? 'claude-sonnet-5' : 'claude-new-x';
      const aRep = rp === 'priced' ? 'claude-sonnet-5' : 'claude-new-y';
      const a = await new AnthropicLLM({ auth: s.get('anthropic'), model: aReq, fetch: new FixtureFetch([body(aRep)]).fetch, ...noSleep }).complete(req());
      const oReq = rq === 'priced' ? 'gpt-5.6-terra' : 'gpt-next-x';
      const oRep = rp === 'priced' ? 'gpt-5.6-terra' : 'gpt-next-y';
      const o = await new OpenAILLM({ auth: s.get('openai'), model: oReq, fetch: new FixtureFetch([oBody(oRep)]).fetch, ...noSleep }).complete(req());
      for (const [r, priced] of [
        [a, 'claude-sonnet-5'],
        [o, 'gpt-5.6-terra'],
      ] as const) {
        expect(r.finishReason).toBe('stop');
        if (known) {
          expect((r.usage as ProviderUsage).unknown).toBeUndefined();
          expect(r.usage.usd).toBe(costUsd(priced, t));
        } else {
          expect((r.usage as ProviderUsage).unknown).toBe(true);
          expect(r.usage.usd).toBe(costAt(CONSERVATIVE_PRICE, t));
        }
      }
    });
  }
});

describe('Codex models finding 2: missing-usage bounds include the reported model (first-party adapters)', () => {
  it('openai: requested gpt-6-luna, reported gpt-6, no usage → bounded at gpt-6', async () => {
    const ff = new FixtureFetch([{ status: 200, body: { object: 'response', model: 'gpt-6', status: 'completed', output: [] } }]);
    const r = await new OpenAILLM({ auth: store().get('openai'), model: 'gpt-6-luna', fetch: ff.fetch, ...noSleep }).complete(req({ maxTokens: 1000 }));
    const sent = Buffer.byteLength(ff.calls[0]!.bodyText!, 'utf8') + INPUT_OVERHEAD_TOKENS;
    expect((r.usage as ProviderUsage).unknown).toBe(true);
    expect(r.usage.usd).toBeCloseTo(costUsd('gpt-6', { inputTokens: 0, cacheWriteTokens: sent, outputTokens: 1000 }), 9);
    expect(r.usage.usd).toBeGreaterThan(costUsd('gpt-6-luna', { inputTokens: 0, cacheWriteTokens: sent, outputTokens: 1000 }));
  });

  it('anthropic: requested haiku, reported opus, no usage → bounded at opus', async () => {
    const ff = new FixtureFetch([{ status: 200, body: { type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' } }]);
    const r = await new AnthropicLLM({ auth: store().get('anthropic'), model: 'claude-haiku-4-5', fetch: ff.fetch, ...noSleep }).complete(req({ maxTokens: 1000 }));
    const sent = Buffer.byteLength(ff.calls[0]!.bodyText!, 'utf8') + INPUT_OVERHEAD_TOKENS;
    // max_tokens as sent (it includes any thinking budget the haiku profile adds).
    const out = (ff.calls[0]!.body as { max_tokens: number }).max_tokens;
    expect((r.usage as ProviderUsage).unknown).toBe(true);
    expect(r.usage.usd).toBeCloseTo(costUsd('claude-opus-5', { inputTokens: 0, cacheWriteTokens: sent, outputTokens: out }), 9);
    expect(r.usage.usd).toBeGreaterThan(costUsd('claude-haiku-4-5', { inputTokens: 0, cacheWriteTokens: sent, outputTokens: out }));
  });
});
