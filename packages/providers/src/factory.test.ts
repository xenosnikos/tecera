import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { LLM, LLMRequest } from '@tecera/contracts';
import { AnthropicLLM } from './anthropic.js';
import { doctorProbe } from './doctor.js';
import { createProvider, ForeignCheckError, foreignCheck } from './factory.js';
import { ProviderConfigError } from './kinds.js';
import { OpenAILLM } from './openai.js';
import { SecretStore } from './secrets.js';
import { FixtureFetch } from './testing/fixtureFetch.js';
import { RecordingLLM } from './testing/recording.js';
import { ScriptedLLM } from './testing/scripted.js';

const aKey = 'sk-ant-api03-' + randomBytes(24).toString('hex');
const oKey = 'sk-proj-' + randomBytes(24).toString('hex');
const store = () => SecretStore.fromManifest({ providers: { anthropic: { auth: 'env:A' }, openai: { auth: 'env:O' } } }, { env: { A: aKey, O: oKey } });

describe('createProvider / foreignCheck', () => {
  it('builds the right client per seat and calls through the injected fetch', async () => {
    const s = store();
    const ff = new FixtureFetch(['anthropic/ok', 'openai/ok']);
    const planner = createProvider({ provider: 'anthropic', model: 'claude-sonnet-5', effort: 'high' }, s, { fetch: ff.fetch });
    const reviewer = createProvider({ provider: 'openai', model: 'gpt-5.6-terra' }, s, { fetch: ff.fetch });
    expect(planner).toBeInstanceOf(AnthropicLLM);
    expect(reviewer).toBeInstanceOf(OpenAILLM);
    expect(planner.id).toBe('anthropic/claude-sonnet-5');
    expect((await planner.complete({ seatId: 'planner', model: '', messages: [{ role: 'user', content: 'hi' }] })).finishReason).toBe('stop');
    expect(ff.calls[0]!.body).toMatchObject({ model: 'claude-sonnet-5', output_config: { effort: 'high' } });
    expect((await reviewer.complete({ seatId: 'reviewer', model: 'gpt-5.6-terra', messages: [{ role: 'user', content: 'hi' }] })).finishReason).toBe('stop');
    expect(ff.calls[1]!.body).toMatchObject({ reasoning: { effort: 'medium' } });
    expect(() => foreignCheck(planner, reviewer)).not.toThrow();
    expect(() => foreignCheck(planner, planner)).toThrow(ForeignCheckError);
  });

  it('fails closed on unknown provider name, unresolved secret, kind mismatch', () => {
    const s = store();
    expect(() => createProvider({ provider: 'mystery', model: 'm' }, s)).toThrow(ProviderConfigError);
    expect(() => createProvider({ provider: 'anthropic-2', model: 'm' }, s)).toThrow(/no secret/);
    expect(() => createProvider({ provider: 'anthropic', model: 'm' }, s, { kinds: { anthropic: 'openai' } })).toThrow(ProviderConfigError);
    expect(() => createProvider({ provider: 'anthropic', model: '' }, s)).toThrow(ProviderConfigError);
  });

  it('foreignCheck rejects same provider, same key, and missing providers', () => {
    const a = new ScriptedLLM({ provider: 'anthropic' });
    const b = new ScriptedLLM({ provider: 'Anthropic' });
    expect(() => foreignCheck(a, b)).toThrow(/distinct providers/);
    const k1 = Object.assign(new ScriptedLLM({ provider: 'x' }), { keyFingerprint: 'abcd1234' });
    const k2 = Object.assign(new ScriptedLLM({ provider: 'y' }), { keyFingerprint: 'abcd1234' });
    expect(() => foreignCheck(k1, k2)).toThrow(/distinct credentials/);
    expect(() => foreignCheck({ id: 'x', provider: '', complete: async () => ({}) as never } as LLM, a)).toThrow(ForeignCheckError);
  });
});

describe('ScriptedLLM', () => {
  it('serves canned responses in order, records requests, never throws', async () => {
    const llm = new ScriptedLLM({ script: ['first', { content: '{"a":1}', usage: { inputTokens: 3, outputTokens: 4, usd: 0.01 }, model: 'm', finishReason: 'stop' }] });
    const r1 = await llm.complete({ seatId: 's', model: 'x', messages: [{ role: 'user', content: 'q1' }] });
    const r2 = await llm.complete({ seatId: 's', model: 'x', messages: [{ role: 'user', content: 'q2' }] });
    const r3 = await llm.complete({ seatId: 's', model: 'x', messages: [{ role: 'user', content: 'q3' }] });
    expect(r1).toMatchObject({ content: 'first', finishReason: 'stop', model: 'x' });
    expect(r2.usage.usd).toBe(0.01);
    expect(r3.finishReason).toBe('error');
    expect(llm.requests.map((r) => r.messages[0]!.content)).toEqual(['q1', 'q2', 'q3']);
  });
  it('global and per-item matchers', async () => {
    const llm = new ScriptedLLM({
      match: (req) => req.seatId === 'planner' || 'wrong seat',
      script: [{ match: (req: LLMRequest) => !!req.schema, respond: '{}' }, 'x'],
    });
    expect((await llm.complete({ seatId: 'worker', model: '', messages: [] })).content).toMatch(/wrong seat/);
    expect((await llm.complete({ seatId: 'planner', model: '', messages: [] })).finishReason).toBe('error');
    expect(llm.remaining).toBe(1);
  });
});

describe('RecordingLLM', () => {
  it('writes redacted JSON transcripts', async () => {
    const s = store();
    const dir = mkdtempSync(join(tmpdir(), 'tecera-rec-'));
    const inner = new ScriptedLLM({ provider: 'anthropic', script: [`echo ${aKey}`] });
    const rec = new RecordingLLM(inner, { dir, redact: s, now: () => 1000 });
    const r = await rec.complete({ seatId: 'planner', model: 'claude-sonnet-5', messages: [{ role: 'user', content: `key=${oKey}` }] });
    expect(r.content).toContain(aKey); // passthrough is untouched; only the transcript is redacted
    const files = readdirSync(dir);
    expect(files).toEqual(['0001-planner.json']);
    const text = readFileSync(join(dir, files[0]!), 'utf8');
    expect(text).not.toContain(aKey);
    expect(text).not.toContain(oKey);
    const doc = JSON.parse(text);
    expect(doc).toMatchObject({ seq: 1, llm: { provider: 'anthropic' }, latencyMs: 0, request: { seatId: 'planner' } });
    expect(rec.provider).toBe('anthropic');
  });
});

describe('doctorProbe', () => {
  it('reports ok, latency, usd and model', async () => {
    const s = store();
    const ff = new FixtureFetch(['anthropic/ok']);
    let t = 0;
    const llm = createProvider({ provider: 'anthropic', model: 'claude-sonnet-5', effort: 'high' }, s, { fetch: ff.fetch });
    const r = await doctorProbe(llm as AnthropicLLM, { now: () => (t += 42) });
    expect(r).toEqual({ ok: true, latencyMs: 42, usd: 0.0054, model: 'claude-sonnet-5', finishReason: 'stop' });
    expect(ff.calls[0]!.body).toMatchObject({ max_tokens: 512, output_config: { effort: 'low' } });
  });
  it('reports not ok with a scrubbed error', async () => {
    const s = store();
    const llm = createProvider({ provider: 'openai', model: 'gpt-6' }, s, { fetch: new FixtureFetch(['openai/echo-auth']).fetch });
    const r = await doctorProbe(llm);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/401/);
    expect(JSON.stringify(r)).not.toContain(oKey);
  });
});
