import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { LLMRequest } from '@tecera/contracts';
import { AnthropicLLM, anthropicProfile } from './anthropic.js';
import { OpenAILLM } from './openai.js';
import { SecretHandle, SecretStore } from './secrets.js';
import { FixtureFetch, type FixtureSpec } from './testing/fixtureFetch.js';
import { backoffDelay } from './http.js';
import { CONSERVATIVE_PRICE, costAt, costUsd, priceFor } from './pricing.js';

const aKey = 'sk-ant-api03-' + randomBytes(24).toString('hex');
const oKey = 'sk-proj-' + randomBytes(24).toString('hex');
const aAuth = new SecretHandle('anthropic', 'env:A', 'anthropic', aKey);
const oAuth = new SecretHandle('openai', 'env:O', 'openai', oKey);

const SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['approve', 'reject'] }, findings: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } } },
  required: ['verdict', 'findings'],
  additionalProperties: false,
};

const req = (over: Partial<LLMRequest> = {}): LLMRequest => ({
  seatId: 'planner',
  model: '',
  messages: [
    { role: 'system', content: 'You are a planner.' },
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'Fix the failing test.' },
    { role: 'assistant', content: 'Which test?' },
    { role: 'user', content: 'math.test.ts' },
  ],
  ...over,
});

const noSleep = { sleep: async () => {}, random: () => 0.5 };

function anthropic(ff: FixtureFetch, over: Partial<ConstructorParameters<typeof AnthropicLLM>[0]> = {}) {
  return new AnthropicLLM({ auth: aAuth, model: 'claude-sonnet-5', effort: 'high', fetch: ff.fetch, ...noSleep, ...over });
}
function openai(ff: FixtureFetch, over: Partial<ConstructorParameters<typeof OpenAILLM>[0]> = {}) {
  return new OpenAILLM({ auth: oAuth, model: 'gpt-5.6-terra', effort: 'high', fetch: ff.fetch, ...noSleep, ...over });
}

describe('Anthropic request mapping', () => {
  it('maps system, messages, max_tokens, effort and schema (effort-profile model)', async () => {
    const ff = new FixtureFetch(['anthropic/schema']);
    const r = await anthropic(ff).complete(req({ maxTokens: 1000, temperature: 0.2, schema: SCHEMA }));
    expect(r.finishReason).toBe('stop');
    expect(ff.calls).toHaveLength(1);
    const call = ff.calls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.method).toBe('POST');
    expect(call.headers).toEqual({ 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': '<present>' });
    expect(call.body).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: 1000,
      system: 'You are a planner.\n\nBe terse.',
      messages: [
        { role: 'user', content: 'Fix the failing test.' },
        { role: 'assistant', content: 'Which test?' },
        { role: 'user', content: 'math.test.ts' },
      ],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
    });
    expect(JSON.parse(r.content)).toEqual({ verdict: 'approve', findings: [] });
  });

  it('maps effort to thinking budget tiers on budget-profile models (haiku 4.5)', async () => {
    const bodies: unknown[] = [];
    for (const effort of ['low', 'medium', 'high'] as const) {
      const ff = new FixtureFetch(['anthropic/ok']);
      await anthropic(ff, { model: 'claude-haiku-4-5-20251001', effort }).complete(req({ maxTokens: 1000, temperature: 0.3 }));
      bodies.push(ff.calls[0]!.body);
    }
    expect(bodies[0]).toMatchObject({ max_tokens: 1000, temperature: 0.3 });
    expect(bodies[0]).not.toHaveProperty('thinking');
    expect(bodies[1]).toMatchObject({ max_tokens: 3048, thinking: { type: 'enabled', budget_tokens: 2048 } });
    expect(bodies[1]).not.toHaveProperty('temperature');
    expect(bodies[2]).toMatchObject({ max_tokens: 9192, thinking: { type: 'enabled', budget_tokens: 8192 } });
    for (const b of bodies) expect(b).not.toHaveProperty('output_config');
  });

  it('per-request effort overrides the seat; tool schema mode forces emit_output without thinking', async () => {
    const ff = new FixtureFetch(['anthropic/tool']);
    const llm = anthropic(ff, { model: 'claude-haiku-4-5-20251001', effort: 'high', schemaMode: 'tool' });
    const r = await llm.complete({ ...req({ maxTokens: 500, schema: SCHEMA }), effort: 'medium' } as LLMRequest);
    expect(ff.calls[0]!.body).toMatchObject({
      max_tokens: 500,
      tools: [{ name: 'emit_output', input_schema: SCHEMA }],
      tool_choice: { type: 'tool', name: 'emit_output' },
    });
    expect(ff.calls[0]!.body).not.toHaveProperty('thinking');
    expect(r.finishReason).toBe('stop');
    expect(JSON.parse(r.content)).toEqual({ verdict: 'reject', findings: [{ title: 'x' }] });
  });

  it('profiles', () => {
    expect(anthropicProfile('claude-opus-5-5')).toEqual({ thinking: 'effort', sampling: false });
    expect(anthropicProfile('claude-sonnet-5')).toEqual({ thinking: 'effort', sampling: false });
    expect(anthropicProfile('claude-sonnet-4-6')).toEqual({ thinking: 'effort', sampling: true });
    expect(anthropicProfile('claude-haiku-4-5-20251001')).toEqual({ thinking: 'budget', sampling: true });
  });
});

describe('Anthropic response mapping, usage and cost', () => {
  it('ok: text blocks only, usage and usd', async () => {
    const r = await anthropic(new FixtureFetch(['anthropic/ok'])).complete(req());
    expect(r).toMatchObject({ content: 'Hello from Claude.', finishReason: 'stop', model: 'claude-sonnet-5' });
    expect(r.usage).toEqual({ inputTokens: 1200, outputTokens: 300, usd: 0.0054 });
    expect(r.raw).toMatchObject({ id: 'msg_fixture_ok' });
  });
  it('cache tokens are counted and priced with multipliers', async () => {
    const r = await anthropic(new FixtureFetch(['anthropic/cached']), { model: 'claude-opus-5-5' }).complete(req());
    // 1000*4 + 2000*4*1.25 + 10000*4*0.1 + 1000*20 = 4000 + 10000 + 4000 + 20000 = 38000 per 1e6
    expect(r.usage).toEqual({ inputTokens: 13000, outputTokens: 1000, usd: 0.038, cacheReadTokens: 10000, cacheWriteTokens: 2000 });
  });
  it('length, refusal, wrong shape, malformed', async () => {
    const len = await anthropic(new FixtureFetch(['anthropic/length'])).complete(req());
    expect(len).toMatchObject({ finishReason: 'length', content: 'partial' });
    const ref = await anthropic(new FixtureFetch(['anthropic/refusal'])).complete(req());
    expect(ref.finishReason).toBe('error');
    expect(ref.content).toMatch(/refused/);
    expect(ref.usage.inputTokens).toBe(50);
    const ws = await anthropic(new FixtureFetch(['anthropic/wrong-shape'])).complete(req());
    expect(ws.finishReason).toBe('error');
    const mf = new FixtureFetch(['anthropic/malformed']);
    const bad = await anthropic(mf).complete(req());
    expect(bad.finishReason).toBe('error');
    expect(bad.content).toMatch(/malformed JSON/);
    expect(mf.calls).toHaveLength(1);
  });
  it('schema requested but model returned non-JSON → error', async () => {
    const r = await anthropic(new FixtureFetch(['anthropic/ok'])).complete(req({ schema: SCHEMA }));
    expect(r.finishReason).toBe('error');
    expect(r.content).toMatch(/not valid JSON/);
  });
  it('no user message → error without calling fetch', async () => {
    const ff = new FixtureFetch([]);
    const r = await anthropic(ff).complete(req({ messages: [{ role: 'system', content: 'x' }] }));
    expect(r.finishReason).toBe('error');
    expect(ff.calls).toHaveLength(0);
  });
});

describe('OpenAI request mapping', () => {
  it('maps instructions, input, max_output_tokens, reasoning effort and json_schema', async () => {
    const ff = new FixtureFetch(['openai/schema']);
    const r = await openai(ff).complete(req({ maxTokens: 800, temperature: 0.2, schema: SCHEMA }));
    expect(r.finishReason).toBe('stop');
    const call = ff.calls[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/responses');
    expect(call.headers).toEqual({ 'content-type': 'application/json', authorization: '<present>' });
    expect(call.body).toEqual({
      model: 'gpt-5.6-terra',
      instructions: 'You are a planner.\n\nBe terse.',
      input: [
        { role: 'user', content: 'Fix the failing test.' },
        { role: 'assistant', content: 'Which test?' },
        { role: 'user', content: 'math.test.ts' },
      ],
      max_output_tokens: 800,
      store: false,
      reasoning: { effort: 'high' },
      text: { format: { type: 'json_schema', name: 'tecera_output', schema: SCHEMA, strict: true } },
    });
  });
  it('non-reasoning models get temperature and no reasoning block', async () => {
    const ff = new FixtureFetch(['openai/ok']);
    await openai(ff, { model: 'gpt-4.1' }).complete(req({ temperature: 0.4 }));
    expect(ff.calls[0]!.body).toMatchObject({ temperature: 0.4, max_output_tokens: 16000 });
    expect(ff.calls[0]!.body).not.toHaveProperty('reasoning');
  });
});

describe('OpenAI response mapping, usage and cost', () => {
  it('ok: output_text only, usage and usd', async () => {
    const r = await openai(new FixtureFetch(['openai/ok'])).complete(req());
    expect(r).toMatchObject({ content: 'Hello from GPT.', finishReason: 'stop', model: 'gpt-5.6-terra' });
    expect(r.usage).toEqual({ inputTokens: 1000, outputTokens: 500, usd: 0.008 });
  });
  it('incomplete(max_output_tokens) → length; refusal → error; malformed → error', async () => {
    const len = await openai(new FixtureFetch(['openai/length'])).complete(req());
    expect(len).toMatchObject({ finishReason: 'length', content: 'partial', model: 'gpt-5.6-sol' });
    expect(len.usage.usd).toBeCloseTo((10 * 5 + 16 * 30) / 1e6, 12);
    expect((await openai(new FixtureFetch(['openai/refusal'])).complete(req())).finishReason).toBe('error');
    expect((await openai(new FixtureFetch(['openai/malformed'])).complete(req())).finishReason).toBe('error');
    expect((await openai(new FixtureFetch(['openai/wrong-shape'])).complete(req())).finishReason).toBe('error');
  });
});

describe('pricing', () => {
  it('table, undated lookup, unpriced default 0 with warning', () => {
    expect(priceFor('claude-haiku-4-5-20251001')).toMatchObject({ inputPerM: 1, outputPerM: 5 });
    expect(priceFor('claude-sonnet-5-20260101')).toMatchObject({ inputPerM: 2, outputPerM: 10 });
    for (const m of ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-opus-5-5', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6']) expect(priceFor(m).inputPerM).toBeGreaterThan(0);
    const warnings: string[] = [];
    expect(costUsd('mystery-1', { inputTokens: 1e6, outputTokens: 1e6 }, (w) => warnings.push(w))).toBe(0);
    expect(warnings[0]).toMatch(/mystery-1/);
    expect(costUsd('claude-opus-5-5', { inputTokens: 1e6, outputTokens: 1e6 })).toBe(24);
  });
  it('an unpriced REPORTED model warns, is charged at the conservative rate and stays unknown (Codex models finding 1)', async () => {
    const warnings: string[] = [];
    const ff = new FixtureFetch([{ status: 200, body: { type: 'message', role: 'assistant', model: 'claude-new-x', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } } }]);
    const r = await anthropic(ff, { onWarning: (w) => warnings.push(w) }).complete(req());
    // A known price for the requested model (claude-sonnet-5) never makes the charge confirmed.
    expect(r.usage.usd).toBe(costAt(CONSERVATIVE_PRICE, { inputTokens: 5, outputTokens: 5 }));
    expect(r.usage.usd).toBeGreaterThan((5 * 2 + 5 * 10) / 1e6);
    expect((r.usage as { unknown?: boolean }).unknown).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  it('a call whose requested and reported models are both unpriced is charged conservatively and flagged unknown (never confirmed)', async () => {
    const warnings: string[] = [];
    const ff = new FixtureFetch([{ status: 200, body: { type: 'message', role: 'assistant', model: 'claude-new-x', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } } }]);
    const r = await anthropic(ff, { model: 'claude-new-x', onWarning: (w) => warnings.push(w) }).complete(req());
    expect(r.finishReason).toBe('stop');
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 5, usd: costAt(CONSERVATIVE_PRICE, { inputTokens: 5, outputTokens: 5 }), unknown: true });
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });
});

describe('retries, timeouts, abort', () => {
  it('retries 429 then succeeds, honouring retry-after up to the cap', async () => {
    const delays: number[] = [];
    const ff = new FixtureFetch(['anthropic/429', 'anthropic/529', 'anthropic/ok']);
    const r = await anthropic(ff, { sleep: async (ms) => void delays.push(ms), baseDelayMs: 100, maxDelayMs: 5000 }).complete(req());
    expect(r.finishReason).toBe('stop');
    expect(ff.calls).toHaveLength(3);
    expect(delays[0]).toBe(1000); // retry-after: 1
    expect(delays[1]).toBe(150); // 100*2^1*(0.5+0.25)
  });
  it('gives up after maxRetries (3 retries = 4 attempts)', async () => {
    const ff = new FixtureFetch(['openai/500', 'openai/500', 'openai/429', 'openai/500', 'openai/ok']);
    const r = await openai(ff).complete(req());
    expect(r.finishReason).toBe('error');
    expect(r.content).toMatch(/HTTP 500.*gave up after 4 attempts/);
    expect(ff.calls).toHaveLength(4);
    expect(ff.remaining).toBe(1);
  });
  it('does not retry 400', async () => {
    const ff = new FixtureFetch(['anthropic/400', 'anthropic/ok']);
    const r = await anthropic(ff).complete(req());
    expect(r.finishReason).toBe('error');
    expect(r.content).toMatch(/HTTP 400: max_tokens/);
    expect(ff.calls).toHaveLength(1);
  });
  it('backoff is exponential, jittered and capped', () => {
    const o = { baseDelayMs: 500, maxDelayMs: 3000 };
    expect(backoffDelay(0, o, () => 0)).toBe(250);
    expect(backoffDelay(0, o, () => 0.999999)).toBe(500);
    expect(backoffDelay(2, o, () => 0.999999)).toBe(2000);
    expect(backoffDelay(5, o, () => 0.999999)).toBe(3000);
    expect(backoffDelay(0, o, () => 0, 60_000)).toBe(3000);
  });
  it('request timeout is retried then reported', async () => {
    const ff = new FixtureFetch(['anthropic/hang', 'anthropic/hang']);
    const r = await anthropic(ff, { timeoutMs: 30, maxRetries: 1 }).complete(req());
    expect(r.finishReason).toBe('error');
    expect(r.content).toMatch(/timed out after 30ms/);
    expect(ff.calls).toHaveLength(2);
  });
  it('abort signal aborts an in-flight request quickly', async () => {
    const ff = new FixtureFetch(['openai/hang']);
    const ctl = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ctl.abort(), 20);
    const r = await openai(ff).complete(req(), ctl.signal);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.finishReason).toBe('error');
    expect(r.content).toMatch(/aborted/);
  });
  it('abort during backoff stops retrying (real sleep)', async () => {
    const ff = new FixtureFetch(['anthropic/429', 'anthropic/ok']);
    const ctl = new AbortController();
    const llm = new AnthropicLLM({ auth: aAuth, model: 'claude-sonnet-5', fetch: ff.fetch, baseDelayMs: 10_000, maxDelayMs: 10_000 });
    setTimeout(() => ctl.abort(), 20);
    const t0 = Date.now();
    const r = await llm.complete(req(), ctl.signal);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.finishReason).toBe('error');
    expect(r.content).toMatch(/aborted/);
    expect(ff.calls).toHaveLength(1);
  });
  it('pre-aborted signal makes no request', async () => {
    const ff = new FixtureFetch(['openai/ok']);
    const r = await openai(ff).complete(req(), AbortSignal.abort());
    expect(r.finishReason).toBe('error');
    expect(ff.calls).toHaveLength(0);
  });
  it('a throwing fetch never throws upward', async () => {
    const llm = new OpenAILLM({ auth: oAuth, model: 'gpt-6', fetch: async () => { throw new TypeError(`connect failed ${oKey}`); }, ...noSleep, maxRetries: 1 });
    const r = await llm.complete(req());
    expect(r.finishReason).toBe('error');
    expect(r.content).toMatch(/network error/);
    expect(JSON.stringify(r)).not.toContain(oKey);
  });
});

describe('error scrubbing', () => {
  it('provider echoing the auth header never leaks the key (both providers)', async () => {
    const a = await anthropic(new FixtureFetch(['anthropic/echo-auth'])).complete(req());
    expect(a.finishReason).toBe('error');
    expect(a.content).toMatch(/HTTP 401: invalid x-api-key: \[REDACTED:anthropic:[0-9a-f]{8}\]/);
    expect(JSON.stringify(a)).not.toContain(aKey);
    const o = await openai(new FixtureFetch(['openai/echo-auth'])).complete(req());
    expect(o.finishReason).toBe('error');
    expect(o.content).toContain('[REDACTED:openai:');
    expect(JSON.stringify(o)).not.toContain(oKey);
    expect(JSON.stringify(o)).not.toContain(oKey.slice(8));
  });
  it('a successful raw body that echoes the key is scrubbed too', async () => {
    const spec: FixtureSpec = { status: 200, bodyText: JSON.stringify({ type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, echo: '{{AUTH}}' }) };
    const r = await anthropic(new FixtureFetch([spec])).complete(req());
    expect(r.finishReason).toBe('stop');
    expect(JSON.stringify(r)).not.toContain(aKey);
  });
  it('outgoing prompts are redacted through the store of a directly constructed provider', async () => {
    const store = new SecretStore({ env: { K: aKey, O: oKey } });
    const auth = store.resolve('anthropic', 'env:K');
    store.resolve('openai', 'env:O');
    const ff = new FixtureFetch(['anthropic/ok']);
    // direct constructor, no redact option: the store-derived redactor still covers the OTHER provider's key
    await anthropic(ff, { auth }).complete(req({ messages: [{ role: 'user', content: `my keys are ${aKey} and ${oKey}` }] }));
    const sent = JSON.stringify(ff.calls[0]!.body);
    expect(sent).not.toContain(aKey);
    expect(sent).not.toContain(oKey);
    expect(sent).toContain('[REDACTED:anthropic:');
    expect(sent).toContain('[REDACTED:openai:');
  });
});
