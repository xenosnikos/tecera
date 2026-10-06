import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LLMRequest, LLMResponse } from '@tecera/contracts';
import { AnthropicLLM, buildAnthropicBody, anthropicProfile } from './anthropic.js';
import { INPUT_OVERHEAD_TOKENS, SECRET_OUTPUT_REFUSED, settleUsage, usageBound, type ProviderUsage } from './base.js';
import { decodeLayer, MAX_DECODE_LAYERS, MAX_ESCAPE_LAYERS, MAX_TOKENS, scanDecoded, UNSCANNABLE } from './decode.js';
import { OpenAILLM, buildOpenAIBody } from './openai.js';
import { OpenRouterLLM } from './openrouter.js';
import { costUsd } from './pricing.js';
import { makeRedactor } from './redact.js';
import { anthropicSchemaProblems, openAIStrictSchemaProblems } from './schemaCompat.js';
import { SecretStore } from './secrets.js';
import { FixtureFetch, type FixtureSpec } from './testing/fixtureFetch.js';
import { RecordingLLM } from './testing/recording.js';
import { ScriptedLLM } from './testing/scripted.js';

/**
 * Sprint-3 Codex models findings, providers half (wave 4, next steps 3, 12 and 13):
 *   F1 decoder exhaustion: token 512/513, the token-layer and escape-layer boundaries; requests,
 *      plain/structured responses and transcripts refuse/withhold on an incomplete scan;
 *   F3 a malformed response keeps its billed usage; unknown usage is flagged and bounded, never a
 *      confirmed zero; timeouts, aborts and unreadable 2xx bodies count as possibly billed;
 *   cancellation: a pre-aborted signal sends nothing; an in-flight abort returns promptly;
 *   schema compatibility checkers for both adapters' default structured-output modes.
 */

const aKey = 'sk-ant-api03-' + randomBytes(24).toString('hex');
const oKey = 'sk-proj-' + randomBytes(24).toString('hex');
const rKey = 'sk-or-v1-' + randomBytes(32).toString('hex');
const CANARY = 'TECERA_CANARY_' + randomBytes(8).toString('hex');
const noSleep = { sleep: async () => {}, random: () => 0.5, maxRetries: 0 };

function store(): SecretStore {
  const s = SecretStore.fromManifest({ providers: { anthropic: { auth: 'env:A' }, openai: { auth: 'env:O' }, openrouter: { auth: 'env:R' } } }, { env: { A: aKey, O: oKey, R: rKey } });
  s.addSecret('canary', CANARY);
  return s;
}

type Kind = 'anthropic' | 'openai' | 'openrouter';
const KINDS: Kind[] = ['anthropic', 'openai', 'openrouter'];
const MODEL: Record<Kind, string> = { anthropic: 'claude-sonnet-5', openai: 'gpt-5.6-terra', openrouter: 'anthropic/claude-sonnet-4.5' };

function provider(kind: Kind, ff: FixtureFetch, over: Record<string, unknown> = {}) {
  const s = store();
  if (kind === 'openrouter') return new OpenRouterLLM({ auth: s.get('openrouter'), model: MODEL.openrouter, fetch: ff.fetch, ...noSleep, ...over });
  return kind === 'anthropic'
    ? new AnthropicLLM({ auth: s.get('anthropic'), model: MODEL.anthropic, fetch: ff.fetch, ...noSleep, ...over })
    : new OpenAILLM({ auth: s.get('openai'), model: MODEL.openai, fetch: ff.fetch, ...noSleep, ...over });
}

const req = (over: Partial<LLMRequest> = {}): LLMRequest => ({ seatId: 'reviewer', model: '', messages: [{ role: 'user', content: 'Review the diff.' }], maxTokens: 1000, ...over });

const uEscape = (s: string) => [...s].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
const b64 = (s: string) => Buffer.from(s).toString('base64');
const b64n = (s: string, n: number) => {
  let t = s;
  for (let i = 0; i < n; i++) t = b64(t);
  return t;
};
/** n escape layers: one \u layer, then the backslashes doubled (JSON-escaped) n-1 more times. */
const escN = (s: string, n: number) => {
  let t = uEscape(s);
  for (let i = 1; i < n; i++) t = t.replace(/\\/g, '\\\\');
  return t;
};
/** n DISTINCT harmless tokens, each decoding (base64) to printable text. */
const harmless = (n: number, tag = 'h') => Array.from({ length: n }, (_, i) => b64(`harmless note ${tag}${i}`)).join(' ');
/** The Codex probe: base64 of the \u-escaped secret after `n` harmless decodable tokens. */
const probe = (secret: string, n = MAX_TOKENS) => `${harmless(n)} ${b64(uEscape(secret))}`;

function okBody(kind: Kind, text: string, usage: unknown = { input_tokens: 100, output_tokens: 20 }): FixtureSpec {
  if (kind === 'openrouter') {
    // The same token counts in OpenRouter's field names; any other usage value is passed through as given.
    const u = usage as { input_tokens?: unknown; output_tokens?: unknown } | null | undefined;
    const mapped = u && typeof u === 'object' && 'input_tokens' in u ? { prompt_tokens: u.input_tokens, completion_tokens: u.output_tokens } : usage;
    return { status: 200, body: { object: 'chat.completion', model: MODEL.openrouter, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text, refusal: null } }], usage: mapped } };
  }
  return kind === 'anthropic'
    ? { status: 200, body: { type: 'message', role: 'assistant', model: MODEL.anthropic, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage } }
    : { status: 200, body: { object: 'response', model: MODEL.openai, status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }], usage } };
}
const billed = (kind: Kind) => costUsd(MODEL[kind], { inputTokens: 100, outputTokens: 20 });

describe('F1 decoder exhaustion: the decoder itself', () => {
  const r = makeRedactor([aKey, oKey, CANARY]);
  const check = (t: string) => r.containsSecret(t);

  it(`token ${MAX_TOKENS}: exactly ${MAX_TOKENS} distinct decodable tokens are scanned completely (clean)`, () => {
    expect(MAX_TOKENS).toBe(512);
    const d = decodeLayer(harmless(512));
    expect(d.exhausted).toBe(false);
    expect(d.tokens.length).toBeGreaterThanOrEqual(512);
    expect(scanDecoded(harmless(512), check)).toBeNull();
  });

  it(`token ${MAX_TOKENS + 1}: one more decodable token is an incomplete scan → UNSCANNABLE, never clean`, () => {
    expect(decodeLayer(harmless(513)).exhausted).toBe(true);
    expect(scanDecoded(harmless(513), check)).toBe(UNSCANNABLE);
  });

  it('the Codex probe (base64(\\u-escaped secret) after 512 harmless tokens) is never clean', () => {
    for (const s of [aKey, oKey, CANARY]) {
      expect(scanDecoded(probe(s, 511), check)).not.toBeNull(); // token 512 is the secret: decoded and found
      expect(scanDecoded(probe(s, 511), check)).not.toBe(UNSCANNABLE);
      expect(scanDecoded(probe(s, 512), check)).toBe(UNSCANNABLE); // token 513 is the secret: refused unread
      expect(scanDecoded(probe(s, 2000), check)).toBe(UNSCANNABLE);
    }
  });

  it('repeated identical tokens count once (no false refusal), and the secret behind them is still found', () => {
    const same = Array.from({ length: 2000 }, () => b64('harmless note x')).join(' ');
    expect(scanDecoded(same, check)).toBeNull();
    const k = scanDecoded(`${same} ${b64(uEscape(CANARY))}`, check);
    expect(k).not.toBeNull();
    expect(k).not.toBe(UNSCANNABLE);
  });

  it('hex tokens: 512 decodable → clean, 513 → UNSCANNABLE', () => {
    const hex = (n: number) => Array.from({ length: n }, (_, i) => Buffer.from(`harmless hex ${i}`).toString('hex')).join(' ');
    expect(scanDecoded(hex(512), check)).toBeNull();
    expect(scanDecoded(hex(513), check)).toBe(UNSCANNABLE);
  });

  it('ordinary text with thousands of long identifiers that do not decode is not refused', () => {
    const code = Array.from({ length: 3000 }, (_, i) => `const someLongIdentifierName${i} = anotherLongIdentifier${i}(packages/planner/src/file${i});`).join('\n');
    expect(scanDecoded(code, check)).toBeNull();
  });

  it(`token-layer boundary: ${MAX_DECODE_LAYERS} nested base64 layers are read; one more is UNSCANNABLE`, () => {
    expect(MAX_DECODE_LAYERS).toBe(3);
    const text = 'harmless nested text';
    expect(scanDecoded(b64n(text, 3), check)).toBeNull();
    expect(scanDecoded(b64n(text, 4), check)).toBe(UNSCANNABLE);
    const k3 = scanDecoded(b64n(CANARY, 3), check);
    expect(k3).not.toBeNull();
    expect(k3).not.toBe(UNSCANNABLE);
    // A 4th layer is never clean: either the redactor's own base64 needle recognises the secret at the last
    // layer read, or the scan is incomplete. Both are hits.
    expect(scanDecoded(b64n(CANARY, 4), check)).not.toBeNull();
    expect(scanDecoded(b64n(uEscape(CANARY), 4), check)).not.toBeNull();
    expect(scanDecoded(b64n(uEscape(CANARY), 5), check)).not.toBeNull();
  });

  it(`escape-layer boundary: ${MAX_ESCAPE_LAYERS} nested escape layers are read; one more is UNSCANNABLE`, () => {
    expect(MAX_ESCAPE_LAYERS).toBe(8);
    const k8 = scanDecoded(escN(CANARY, 8), check);
    expect(k8).not.toBeNull();
    expect(k8).not.toBe(UNSCANNABLE);
    expect(scanDecoded(escN(CANARY, 9), check)).toBe(UNSCANNABLE);
    expect(scanDecoded(escN('harmless escaped text', 8), check)).toBeNull();
    expect(scanDecoded(escN('harmless escaped text', 9), check)).toBe(UNSCANNABLE);
  });

  it('mixed: escape layers do not consume token layers (JSON-in-JSON text holding base64 is read)', () => {
    const k = scanDecoded(JSON.stringify(JSON.stringify({ v: b64n(uEscape(aKey), 3) })), check);
    expect(k).not.toBeNull();
    expect(k).not.toBe(UNSCANNABLE);
  });
});

describe('F1 decoder exhaustion: requests are refused before any HTTP call (both providers)', () => {
  for (const kind of KINDS) {
    it(`${kind}: the Codex probe in a message → refused, nothing sent`, async () => {
      for (const s of [aKey, oKey, CANARY]) {
        const ff = new FixtureFetch([okBody(kind, 'ok')]);
        const r = await provider(kind, ff).complete(req({ messages: [{ role: 'user', content: probe(s) }] }));
        expect(r.finishReason).toBe('error');
        expect(r.error).toMatch(/request refused: outgoing request contains a secret/);
        expect(ff.calls).toHaveLength(0);
        expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0, usd: 0 });
        expect(JSON.stringify(r)).not.toContain(b64(uEscape(s)));
      }
    });

    it(`${kind}: token 512 is sent; token 513 is refused as unscannable`, async () => {
      const ok = new FixtureFetch([okBody(kind, 'ok')]);
      expect((await provider(kind, ok).complete(req({ messages: [{ role: 'user', content: harmless(512) }] }))).finishReason).toBe('stop');
      expect(ok.calls).toHaveLength(1);
      const no = new FixtureFetch([okBody(kind, 'ok')]);
      const r = await provider(kind, no).complete(req({ messages: [{ role: 'user', content: harmless(513) }] }));
      expect(r.error).toMatch(/contains a secret \(unscannable\)/);
      expect(no.calls).toHaveLength(0);
    });

    it(`${kind}: the token-layer and escape-layer boundaries hold in a schema description too`, async () => {
      for (const [text, sent] of [
        [b64n('harmless nested text', 3), true],
        [b64n('harmless nested text', 4), false],
        [escN('harmless escaped text', 8), true],
        [escN('harmless escaped text', 9), false],
      ] as const) {
        const ff = new FixtureFetch([okBody(kind, '{"v":"x"}')]);
        const schema = { type: 'object', additionalProperties: false, required: ['v'], properties: { v: { type: 'string', description: text } } };
        const r = await provider(kind, ff).complete(req({ schema }));
        expect(ff.calls.length).toBe(sent ? 1 : 0);
        if (!sent) expect(r.error).toMatch(/unscannable/);
      }
    });
  }
});

describe('F1 decoder exhaustion: responses are refused, raw is withheld (both providers)', () => {
  for (const kind of KINDS) {
    it(`${kind}: the Codex probe in plain content → SECRET_OUTPUT_REFUSED with billed usage; no encoded form in content or raw`, async () => {
      for (const s of [aKey, oKey, CANARY]) {
        const r = await provider(kind, new FixtureFetch([okBody(kind, probe(s))])).complete(req());
        expect(r.finishReason).toBe('error');
        expect(r.error).toBe(SECRET_OUTPUT_REFUSED);
        expect(r.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, usd: billed(kind) });
        const all = JSON.stringify(r);
        expect(all).not.toContain(b64(uEscape(s)));
        expect(all).toContain('[REDACTED:unscannable:decoded]');
      }
    });

    it(`${kind}: the Codex probe inside structured output → refused`, async () => {
      const schema = { type: 'object', additionalProperties: false, required: ['v'], properties: { v: { type: 'string' } } };
      const r = await provider(kind, new FixtureFetch([okBody(kind, JSON.stringify({ v: probe(CANARY) }))])).complete(req({ schema }));
      expect(r.error).toBe(SECRET_OUTPUT_REFUSED);
      expect(JSON.stringify(r)).not.toContain(b64(uEscape(CANARY)));
    });

    it(`${kind}: 513 harmless tokens or a 4th base64 layer in the output → refused (incomplete scan is never clean)`, async () => {
      for (const text of [harmless(513), `see ${b64n('harmless nested text', 4)}`, `see ${escN('harmless escaped text', 9)}`]) {
        const r = await provider(kind, new FixtureFetch([okBody(kind, text)])).complete(req());
        expect(r.error).toBe(SECRET_OUTPUT_REFUSED);
      }
      for (const text of [harmless(512), `see ${b64n('harmless nested text', 3)}`]) {
        const r = await provider(kind, new FixtureFetch([okBody(kind, text)])).complete(req());
        expect(r.finishReason).toBe('stop');
        expect(r.content).toBe(text);
      }
    });

    it(`${kind}: an error body carrying the probe is withheld from raw.response`, async () => {
      const r = await provider(kind, new FixtureFetch([{ status: 400, body: { error: { message: probe(oKey) } } }])).complete(req());
      expect(r.finishReason).toBe('error');
      expect(JSON.stringify(r)).not.toContain(b64(uEscape(oKey)));
    });
  }
});

describe('F1 decoder exhaustion: transcripts withhold incomplete scans', () => {
  it('RecordingLLM writes no string whose scan is incomplete (request and response)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tecera-wave4-rec-'));
    const inner = new ScriptedLLM([probe(CANARY), harmless(513)]);
    const rec = new RecordingLLM(inner, { dir, redact: store() });
    await rec.complete(req({ messages: [{ role: 'user', content: probe(aKey) }] }));
    await rec.complete(req());
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    const t1 = readFileSync(join(dir, files[0]!), 'utf8');
    const t2 = readFileSync(join(dir, files[1]!), 'utf8');
    for (const s of [aKey, CANARY]) expect(t1).not.toContain(b64(uEscape(s)));
    expect(t1).toContain('[REDACTED:unscannable:decoded]');
    expect(t2).toContain('[REDACTED:unscannable:decoded]');
    expect(t2).not.toContain(harmless(513));
  });
});

describe('F3 malformed responses keep billed usage; unknown usage is never a confirmed zero (both providers)', () => {
  const malformed: Record<Kind, Array<[string, Record<string, unknown>]>> = {
    openai: [
      ['output: null', { object: 'response', model: MODEL.openai, status: 'completed', output: null, usage: { input_tokens: 100, output_tokens: 20 } }],
      ['status missing', { object: 'response', model: MODEL.openai, output: [], usage: { input_tokens: 100, output_tokens: 20 } }],
    ],
    openrouter: [
      ['choices: null', { object: 'chat.completion', model: MODEL.openrouter, choices: null, usage: { prompt_tokens: 100, completion_tokens: 20 } }],
      ['message missing', { object: 'chat.completion', model: MODEL.openrouter, choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }],
    ],
    anthropic: [
      ['content: null', { type: 'message', role: 'assistant', model: MODEL.anthropic, content: null, stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }],
      ['role missing', { type: 'message', model: MODEL.anthropic, content: [], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }],
    ],
  };
  for (const kind of KINDS) {
    for (const [name, body] of malformed[kind]) {
      it(`${kind}: ${name} with valid usage 100/20 → finishReason error carrying the billed usage (confirmed)`, async () => {
        const r = await provider(kind, new FixtureFetch([{ status: 200, body }])).complete(req());
        expect(r.finishReason).toBe('error');
        expect(r.error).toMatch(/did not match/);
        expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20, usd: billed(kind) });
      });
    }

    const bodyFor = (usage: unknown) => ({ ...(okBody(kind, 'hi').body as Record<string, unknown>), usage });
    for (const [name, usage] of [
      ['missing', undefined],
      ['negative output', { input_tokens: 100, output_tokens: -1 }],
      ['string tokens', { input_tokens: '100', output_tokens: '20' }],
      ['null', null],
    ] as const) {
      it(`${kind}: usage ${name} → error with usage flagged unknown and bounded (never $0 confirmed)`, async () => {
        const ff = new FixtureFetch([{ status: 200, body: bodyFor(usage) }]);
        const r = await provider(kind, ff).complete(req({ maxTokens: 1000 }));
        expect(r.finishReason).toBe('error');
        const u = r.usage as ProviderUsage;
        expect(u.unknown).toBe(true);
        const sent = Buffer.byteLength(ff.calls[0]!.bodyText!, 'utf8');
        expect(u.inputTokens).toBe(sent + INPUT_OVERHEAD_TOKENS);
        expect(u.outputTokens).toBeGreaterThanOrEqual(1000);
        expect(u.usd).toBeGreaterThan(billed(kind));
      });
    }

    it(`${kind}: a body that is not an object, or an unparseable 2xx body → unknown usage`, async () => {
      for (const spec of [{ status: 200, body: [1, 2] }, { status: 200, body: 'text' }, { status: 200, bodyText: '{"truncated": ' }] as FixtureSpec[]) {
        const r = await provider(kind, new FixtureFetch([spec])).complete(req());
        expect(r.finishReason).toBe('error');
        expect((r.usage as ProviderUsage).unknown).toBe(true);
        expect(r.usage.usd).toBeGreaterThan(0);
      }
    });

    it(`${kind}: a non-2xx answer is not billed (confirmed zero); a request refused locally is confirmed zero`, async () => {
      const r = await provider(kind, new FixtureFetch([{ status: 400, body: { error: { message: 'bad' } } }])).complete(req());
      expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0, usd: 0 });
      const refused = await provider(kind, new FixtureFetch([okBody(kind, 'x')])).complete(req({ messages: [{ role: 'user', content: `k ${uEscape(oKey)}` }] }));
      expect(refused.usage).toEqual({ inputTokens: 0, outputTokens: 0, usd: 0 });
    });

    it(`${kind}: a timeout after dispatch is possibly billed → unknown; a retried timeout adds its bound to the final usage`, async () => {
      const hang: FixtureSpec = { status: 200, body: {}, delayMs: 10_000 };
      const t = await provider(kind, new FixtureFetch([hang]), { timeoutMs: 20 }).complete(req());
      expect(t.error).toMatch(/timed out/);
      expect((t.usage as ProviderUsage).unknown).toBe(true);
      expect(t.usage.inputTokens).toBeGreaterThan(INPUT_OVERHEAD_TOKENS);
      const ff = new FixtureFetch([hang, okBody(kind, 'hi')]);
      const r = await provider(kind, ff, { timeoutMs: 20, maxRetries: 1 }).complete(req());
      expect(r.finishReason).toBe('stop');
      expect((r.usage as ProviderUsage).unknown).toBe(true);
      expect(r.usage.inputTokens).toBe(100 + Buffer.byteLength(ff.calls[0]!.bodyText!, 'utf8') + INPUT_OVERHEAD_TOKENS);
      expect(r.usage.usd).toBeGreaterThan(billed(kind));
    });

    it(`${kind}: cancellation — a pre-aborted signal sends nothing (confirmed zero); an in-flight abort returns promptly, possibly billed`, async () => {
      const pre = new FixtureFetch([okBody(kind, 'hi')]);
      const p = await provider(kind, pre).complete(req(), AbortSignal.abort(new Error('lease lost')));
      expect(p.finishReason).toBe('error');
      expect(p.error).toMatch(/aborted/);
      expect(pre.calls).toHaveLength(0);
      expect(p.usage).toEqual({ inputTokens: 0, outputTokens: 0, usd: 0 });

      const ff = new FixtureFetch([{ status: 200, body: {}, delayMs: 60_000 }]);
      const ctl = new AbortController();
      setTimeout(() => ctl.abort(new Error('deadline')), 20);
      const t0 = Date.now();
      const r = await provider(kind, ff, { maxRetries: 3 }).complete(req(), ctl.signal);
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(r.error).toMatch(/aborted/);
      expect(ff.calls).toHaveLength(1);
      expect((r.usage as ProviderUsage).unknown).toBe(true);
    });
  }

  it('settleUsage: a reported usage is confirmed only when every possibly-billed attempt reported a priced usage', () => {
    const bound = { inputTokens: 10, outputTokens: 20, usd: 0.5 };
    expect(settleUsage({ inputTokens: 1, outputTokens: 2, usd: 0.1 }, 0, bound)).toEqual({ inputTokens: 1, outputTokens: 2, usd: 0.1 });
    expect(settleUsage({ inputTokens: 1, outputTokens: 2, usd: 0.1 }, 2, bound)).toEqual({ inputTokens: 21, outputTokens: 42, usd: 1.1, unknown: true });
    expect(settleUsage(null, 0, bound)).toEqual({ inputTokens: 0, outputTokens: 0, usd: 0 });
    expect(settleUsage(null, 1, undefined)).toEqual({ inputTokens: 0, outputTokens: 0, usd: 0, unknown: true });
    expect(settleUsage({ inputTokens: 5, outputTokens: 5, usd: 0 }, 0, bound)).toEqual({ inputTokens: 5, outputTokens: 5, usd: 0, unknown: true });
    const b = usageBound(['claude-opus-5-5', 'unpriced-x'], 'x'.repeat(1000), 500, (m, t) => costUsd(m, t));
    expect(b.inputTokens).toBe(1000 + INPUT_OVERHEAD_TOKENS);
    expect(b.usd).toBeCloseTo(((1000 + INPUT_OVERHEAD_TOKENS) * 4 * 1.25 + 500 * 20) / 1e6, 9);
  });
});

describe('schema compatibility checkers (default structured-output modes)', () => {
  const good = {
    type: 'object',
    additionalProperties: false,
    required: ['a', 'b'],
    properties: { a: { type: 'string' }, b: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] } },
  };
  it('a closed, all-required, unconstrained-shape schema passes both', () => {
    expect(openAIStrictSchemaProblems(good)).toEqual([]);
    expect(anthropicSchemaProblems(good)).toEqual([]);
  });
  it('flags what each vendor rejects', () => {
    expect(openAIStrictSchemaProblems({ type: 'object' }).join('\n')).toMatch(/additionalProperties: false/);
    expect(openAIStrictSchemaProblems({ ...good, required: ['a'] }).join('\n')).toMatch(/"b" must be required/);
    expect(openAIStrictSchemaProblems({ ...good, properties: { ...good.properties, a: { type: 'string', maxLength: 3 } } }).join('\n')).toMatch(/maxLength/);
    expect(openAIStrictSchemaProblems({ ...good, properties: { ...good.properties, a: {} } }).join('\n')).toMatch(/no type/);
    expect(openAIStrictSchemaProblems({ type: 'object', additionalProperties: false, propertyNames: { pattern: 'x' }, properties: {}, required: [] }).join('\n')).toMatch(/propertyNames/);
    expect(anthropicSchemaProblems({ ...good, required: ['a'] })).toEqual([]);
    expect(anthropicSchemaProblems({ ...good, properties: { ...good.properties, a: { type: 'integer', minimum: 1 } } }).join('\n')).toMatch(/minimum/);
    expect(anthropicSchemaProblems({ ...good, properties: { ...good.properties, a: { type: 'array', items: { type: 'string' }, maxItems: 3 } } }).join('\n')).toMatch(/maxItems/);
    expect(anthropicSchemaProblems({ ...good, properties: { ...good.properties, a: { type: 'array', items: { type: 'string' }, minItems: 2 } } }).join('\n')).toMatch(/minItems must be 0 or 1/);
    expect(anthropicSchemaProblems({ type: 'object', additionalProperties: { type: 'string' }, properties: {} }).join('\n')).toMatch(/additionalProperties: false/);
  });
  it('the real request builders carry the schema unchanged into each default mode', () => {
    const r: LLMRequest = req({ schema: good });
    const o = buildOpenAIBody(r, { model: 'gpt-6', effort: 'high', defaultMaxTokens: 100, strictSchema: true }) as { text: { format: { strict: boolean; schema: unknown } } };
    expect(o.text.format.strict).toBe(true);
    expect(openAIStrictSchemaProblems(o.text.format.schema)).toEqual([]);
    const a = buildAnthropicBody(r, { model: 'claude-opus-5-5', effort: 'high', defaultMaxTokens: 100, schemaMode: 'format', profile: anthropicProfile('claude-opus-5-5') }) as { output_config: { format: { type: string; schema: unknown } } };
    expect(a.output_config.format.type).toBe('json_schema');
    expect(anthropicSchemaProblems(a.output_config.format.schema)).toEqual([]);
  });
});

// keep the LLMResponse import meaningful for readers of the envelope type
export type _Envelope = LLMResponse;
