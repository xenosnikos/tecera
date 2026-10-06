import { describe, expect, it } from 'vitest';
import type { LLM, LLMResponse } from '@tecera/contracts';
import type { ProviderUsage } from './base.js';
import { createProvider } from './factory.js';
import { costUsd } from './pricing.js';
import { SecretStore } from './secrets.js';

/**
 * Live provider checks (D7). Each block is skipped unless its key variable is set (source
 * /root/.config/tecera/live.env into the test process only; values are never printed). A key is resolved
 * with the default deleteFromEnv (true): it leaves process.env at resolution and only the handle is used.
 * The skip conditions are evaluated at collection time, before resolution.
 *
 * One tiny completion per provider, at most 64 output tokens each, asserting the wire format for real
 * (finishReason, content, the reported model), usage (token counts > 0, confirmed, not `unknown`) and cost
 * (> 0, equal to the table price of the reported model; on OpenRouter never below OpenRouter's own
 * reported cost). One structured-output call per provider verifies the json_schema mapping.
 */

const ANTHROPIC_MODEL = process.env['TECERA_LIVE_ANTHROPIC_MODEL'] ?? 'claude-haiku-4-5-20251001';
const OPENAI_MODEL = process.env['TECERA_LIVE_OPENAI_MODEL'] ?? 'gpt-5.6-terra';
const OPENROUTER_MODEL = process.env['TECERA_LIVE_OPENROUTER_MODEL'] ?? 'anthropic/claude-sonnet-4.5';
const MAX_OUT = 64;
const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };

async function tiny(llm: LLM, model: string): Promise<LLMResponse> {
  return llm.complete({ seatId: 'live', model, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], maxTokens: MAX_OUT, effort: 'low' });
}

function expectBilled(r: LLMResponse): void {
  expect(r.finishReason, r.error).toBe('stop');
  expect(r.content.toLowerCase()).toContain('ok');
  expect(r.usage.inputTokens).toBeGreaterThan(0);
  expect(r.usage.outputTokens).toBeGreaterThan(0);
  expect(r.usage.outputTokens).toBeLessThanOrEqual(MAX_OUT);
  expect((r.usage as ProviderUsage).unknown).toBeUndefined();
  expect(r.usage.usd).toBeGreaterThan(0);
}

async function structured(llm: LLM, model: string): Promise<LLMResponse> {
  return llm.complete({ seatId: 'live', model, messages: [{ role: 'user', content: 'Return {"ok": true}.' }], maxTokens: MAX_OUT, effort: 'low', schema: SCHEMA });
}

describe.skipIf(!process.env['ANTHROPIC_API_KEY'])('live anthropic (api.anthropic.com)', () => {
  it('one tiny completion: wire format, usage and cost; structured output', async () => {
    const store = new SecretStore();
    store.resolve('anthropic', 'env:ANTHROPIC_API_KEY');
    expect(process.env['ANTHROPIC_API_KEY']).toBeUndefined();
    const llm = createProvider({ provider: 'anthropic', model: ANTHROPIC_MODEL, effort: 'low' }, store, { maxRetries: 1 });
    const r = await tiny(llm, ANTHROPIC_MODEL);
    expectBilled(r);
    expect(r.model).toMatch(/^claude-/);
    const cache = { cacheReadTokens: r.usage.cacheReadTokens ?? 0, cacheWriteTokens: r.usage.cacheWriteTokens ?? 0 };
    expect(r.usage.usd).toBeCloseTo(costUsd(r.model, { inputTokens: r.usage.inputTokens - cache.cacheReadTokens - cache.cacheWriteTokens, outputTokens: r.usage.outputTokens, ...cache }), 9);
    const s = await structured(llm, ANTHROPIC_MODEL);
    expect(s.finishReason, s.error).toBe('stop');
    expect(JSON.parse(s.content)).toEqual({ ok: true });
  }, 120_000);
});

describe.skipIf(!process.env['OPENAI_API_KEY'])('live openai (api.openai.com)', () => {
  it('one tiny completion: wire format, usage and cost; structured output', async () => {
    const store = new SecretStore();
    store.resolve('openai', 'env:OPENAI_API_KEY');
    expect(process.env['OPENAI_API_KEY']).toBeUndefined();
    const llm = createProvider({ provider: 'openai', model: OPENAI_MODEL, effort: 'low' }, store, { maxRetries: 1 });
    const r = await tiny(llm, OPENAI_MODEL);
    expectBilled(r);
    expect(r.model).toMatch(/^gpt-/);
    expect(r.usage.usd).toBeCloseTo(costUsd(r.model, { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens }), 9);
    const s = await structured(llm, OPENAI_MODEL);
    expect(s.finishReason, s.error).toBe('stop');
    expect(JSON.parse(s.content)).toEqual({ ok: true });
  }, 120_000);
});

describe.skipIf(!process.env['OPENROUTER_API_KEY'])('live openrouter (openrouter.ai/api/v1)', () => {
  it('one tiny completion: wire format, usage and cost (never below OpenRouter\'s reported cost); structured output', async () => {
    const store = new SecretStore();
    store.resolve('openrouter', 'env:OPENROUTER_API_KEY');
    expect(process.env['OPENROUTER_API_KEY']).toBeUndefined();
    const llm = createProvider({ provider: 'openrouter', model: OPENROUTER_MODEL, effort: 'low' }, store, { maxRetries: 1 });
    expect(llm.provider).toBe(OPENROUTER_MODEL.split('/')[0]);
    const r = await tiny(llm, OPENROUTER_MODEL);
    expectBilled(r);
    expect(r.model.split('/')[0]).toBe(llm.provider);
    const reported = (r.raw as { usage?: { cost?: number } }).usage?.cost;
    expect(typeof reported).toBe('number');
    expect(r.usage.usd).toBeGreaterThanOrEqual(reported!);
    expect(r.usage.usd).toBeGreaterThanOrEqual(costUsd(r.model, { inputTokens: r.usage.inputTokens - (r.usage.cacheReadTokens ?? 0) - (r.usage.cacheWriteTokens ?? 0), outputTokens: r.usage.outputTokens, cacheReadTokens: r.usage.cacheReadTokens ?? 0, cacheWriteTokens: r.usage.cacheWriteTokens ?? 0 }) - 1e-9);
    const s = await structured(llm, OPENROUTER_MODEL);
    expect(s.finishReason, s.error).toBe('stop');
    expect(JSON.parse(s.content)).toEqual({ ok: true });
  }, 120_000);

});
