import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { LLMRequest, LLMResponse } from '@tecera/contracts';
import { AnthropicLLM } from './anthropic.js';
import { REDACTION_FAILED, SECRET_OUTPUT_REFUSED } from './base.js';
import { createProvider, foreignCheck, ForeignCheckError } from './factory.js';
import { OpenAILLM } from './openai.js';
import { makeRedactor, type Redactor } from './redact.js';
import { SecretError, SecretHandle, SecretStore } from './secrets.js';
import { FixtureFetch, type FixtureSpec } from './testing/fixtureFetch.js';
import { RecordingLLM } from './testing/recording.js';
import { ScriptedLLM } from './testing/scripted.js';

/**
 * security.md §5 (final-message review boundary) and §6–7 (secret canaries) at the provider seam:
 * secret.canary_* on every outgoing field, review.planted_verdict shapes, review.same_provider.
 */

const aKey = 'sk-ant-api03-' + randomBytes(24).toString('hex');
const oKey = 'sk-proj-' + randomBytes(24).toString('hex');
const CANARY = 'TECERA_CANARY_' + randomBytes(8).toString('hex');
const noSleep = { sleep: async () => {}, random: () => 0.5, maxRetries: 0 };
const APPROVE = '{"verdict":"approve","findings":[]}';
const SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['approve', 'reject'] }, findings: { type: 'array', items: { type: 'object' } } },
  required: ['verdict', 'findings'],
  additionalProperties: false,
};

function store(): SecretStore {
  const s = SecretStore.fromManifest({ providers: { anthropic: { auth: 'env:A' }, openai: { auth: 'env:O' } } }, { env: { A: aKey, O: oKey } });
  s.addSecret('canary', CANARY);
  return s;
}

const req = (over: Partial<LLMRequest> = {}): LLMRequest => ({ seatId: 'reviewer', model: '', messages: [{ role: 'user', content: 'Review the diff.' }], ...over });

/** Direct constructors on store-resolved handles (no redact option at all). */
function anthropic(ff: FixtureFetch, over: Partial<ConstructorParameters<typeof AnthropicLLM>[0]> = {}) {
  return new AnthropicLLM({ auth: store().get('anthropic'), model: 'claude-sonnet-5', fetch: ff.fetch, ...noSleep, ...over });
}
function openai(ff: FixtureFetch, over: Partial<ConstructorParameters<typeof OpenAILLM>[0]> = {}) {
  return new OpenAILLM({ auth: store().get('openai'), model: 'gpt-5.6-terra', fetch: ff.fetch, ...noSleep, ...over });
}

function forms(secret: string): string[] {
  const b = Buffer.from(secret);
  return [secret, JSON.stringify(secret).slice(1, -1), b.toString('base64'), b.toString('hex'), encodeURIComponent(secret)];
}

function expectClean(x: unknown, ...secrets: string[]): void {
  const text = typeof x === 'string' ? x : JSON.stringify(x);
  for (const s of secrets) for (const f of forms(s)) expect(text.includes(f), `leaked a form of a secret`).toBe(false);
}

function expectEnvelope(r: LLMResponse): void {
  expect(r.finishReason).toBe('error');
  expect(typeof r.error).toBe('string');
  expect(r.error!.length).toBeGreaterThan(0);
  expect(r.content).toBe(r.error);
  expect((r.raw as { error?: unknown }).error).toBe(r.error);
}

describe('finding 1: every outgoing response field and warning is sanitized; secret-bearing output is refused', () => {
  it('secret echoed in content: refused with a sanitized envelope (both providers)', async () => {
    for (const r of [await anthropic(new FixtureFetch(['anthropic/echo-content'])).complete(req()), await openai(new FixtureFetch(['openai/echo-content'])).complete(req())]) {
      expectEnvelope(r);
      expect(r.error).toBe(SECRET_OUTPUT_REFUSED);
      expect(r.usage.inputTokens).toBe(100); // billed tokens are still reported
      expectClean(r, aKey, oKey);
    }
  });

  it('secret echoed as the model name: refused; response.model and onWarning carry no secret', async () => {
    for (const [mk, name] of [[anthropic, 'anthropic/echo-model'], [openai, 'openai/echo-model']] as const) {
      const warnings: string[] = [];
      const r = await mk(new FixtureFetch([name]), { onWarning: (w) => warnings.push(w) }).complete(req());
      expectEnvelope(r);
      expect(r.error).toBe(SECRET_OUTPUT_REFUSED);
      expectClean(r, aKey, oKey);
      expect(warnings.length).toBeGreaterThan(0); // the "model" is unpriced
      expectClean(warnings, aKey, oKey);
      expect(warnings.join('\n')).toContain('[REDACTED:');
    }
  });

  it('secret inside a structured tool input (tool mode) is refused', async () => {
    const r = await anthropic(new FixtureFetch(['anthropic/echo-tool-input']), { model: 'claude-haiku-4-5-20251001', schemaMode: 'tool' }).complete(req({ schema: SCHEMA }));
    expectEnvelope(r);
    expect(r.error).toBe(SECRET_OUTPUT_REFUSED);
    expectClean(r, aKey);
  });

  it('a registered canary and the OTHER provider key in content are refused by a directly built provider', async () => {
    for (const text of [`note ${CANARY}`, `other key ${oKey}`]) {
      const ff = new FixtureFetch([{ status: 200, body: { type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } }]);
      const r = await anthropic(ff).complete(req());
      expectEnvelope(r);
      expect(r.error).toBe(SECRET_OUTPUT_REFUSED);
      expectClean(r, CANARY, oKey);
    }
  });

  it('a secret with JSON metacharacters echoed escaped is caught on the decoded value (content and raw)', async () => {
    const weird = 'sk-ant-api03-q"uo\\te/' + randomBytes(12).toString('hex');
    const s = new SecretStore({ env: { W: weird } });
    const auth = s.resolve('anthropic', 'env:W');
    const bodyText = JSON.stringify({ type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: `k=${weird}` }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, echo: weird });
    expect(bodyText).not.toContain(weird); // the wire form is escaped
    const r = await new AnthropicLLM({ auth, model: 'claude-sonnet-5', fetch: new FixtureFetch([{ status: 200, bodyText }]).fetch, ...noSleep }).complete(req());
    expectEnvelope(r);
    expect(r.error).toBe(SECRET_OUTPUT_REFUSED);
    expectClean(r, weird);
    expectClean(JSON.parse(JSON.stringify(r)), weird);
  });

  it('a throwing redactor yields the fixed failure and no HTTP call', async () => {
    const boom: Redactor = {
      redactText: () => {
        throw new Error(`boom ${aKey}`);
      },
      redactJson: () => null,
      containsSecret: () => null,
    };
    const ff = new FixtureFetch(['anthropic/ok']);
    const r = await anthropic(ff, { redactor: boom }).complete(req());
    expect(r).toEqual({ content: REDACTION_FAILED, error: REDACTION_FAILED, finishReason: 'error', model: '', usage: { inputTokens: 0, outputTokens: 0, usd: 0 }, raw: { error: REDACTION_FAILED } });
    expect(ff.calls).toHaveLength(0);
  });

  it('a redactor that fails only on the response side never leaks the response', async () => {
    const half: Redactor = {
      redactText: (t) => t,
      redactJson: () => {
        throw new Error('nope');
      },
      containsSecret: () => null,
    };
    const ff = new FixtureFetch(['openai/echo-content']);
    const r = await openai(ff, { redactor: half }).complete(req());
    expectEnvelope(r);
    expect(r.content).not.toContain('your key');
    expectClean(r, oKey);
  });

  it('a redactor returning a non-string fails closed', async () => {
    const bad = { redactText: () => 42, redactJson: (v: unknown) => v, containsSecret: () => null } as unknown as Redactor;
    const ff = new FixtureFetch(['anthropic/ok']);
    const r = await anthropic(ff, { redactor: bad }).complete(req());
    expect(r.error).toBe(REDACTION_FAILED);
    expect(ff.calls).toHaveLength(0);
  });

  it('a throwing onWarning sink does not break the call', async () => {
    const ff = new FixtureFetch([{ status: 200, body: { type: 'message', role: 'assistant', model: 'claude-unpriced', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } }]);
    const r = await anthropic(ff, {
      onWarning: () => {
        throw new Error('sink');
      },
    }).complete(req());
    expect(r).toMatchObject({ finishReason: 'stop', content: 'hi' });
  });

  it('HTTP error bodies are attached sanitized under raw.response, never raw', async () => {
    const r = await openai(new FixtureFetch(['openai/echo-auth'])).complete(req());
    expectEnvelope(r);
    expect((r.raw as { status?: number }).status).toBe(401);
    expect(JSON.stringify((r.raw as { response?: unknown }).response)).toContain('[REDACTED:openai:');
    expectClean(r, oKey);
  });
});

describe('finding 2: only an unambiguous final assistant answer is stop (review.planted_verdict)', () => {
  const cases: Array<[string, 'anthropic' | 'openai', boolean, RegExp]> = [
    ['openai/in-progress', 'openai', true, /response in_progress/],
    ['openai/in-progress-message', 'openai', true, /not final \(status in_progress\)/],
    ['openai/user-role', 'openai', true, /non-assistant message item \(role user\)/],
    ['openai/user-role', 'openai', false, /non-assistant/],
    ['openai/fragmented', 'openai', true, /ambiguous output: 2 message items/],
    ['openai/fragmented', 'openai', false, /ambiguous output: 2 message items/],
    ['openai/two-parts-schema', 'openai', true, /exactly one structured result, got 2/],
    ['openai/function-call', 'openai', true, /unsupported output item type function_call/],
    ['openai/unknown-part', 'openai', true, /unsupported content part type output_audio/],
    ['openai/empty', 'openai', false, /empty output/],
    ['anthropic/user-role', 'anthropic', true, /role is user/],
    ['anthropic/two-text-schema', 'anthropic', true, /exactly one structured result, got 2/],
    ['anthropic/unsupported-block', 'anthropic', false, /unsupported content block type server_tool_use/],
    ['anthropic/pause', 'anthropic', true, /unsupported stop_reason pause_turn/],
    ['anthropic/stop-sequence', 'anthropic', true, /unsupported stop_reason stop_sequence/],
    ['anthropic/empty', 'anthropic', false, /empty output/],
  ];
  for (const [fixture, kind, schema, why] of cases) {
    it(`${fixture}${schema ? ' (schema)' : ''} → error`, async () => {
      const ff = new FixtureFetch([fixture]);
      const r = kind === 'anthropic' ? await anthropic(ff).complete(req(schema ? { schema: SCHEMA } : {})) : await openai(ff).complete(req(schema ? { schema: SCHEMA } : {}));
      expectEnvelope(r);
      expect(r.error).toMatch(why);
      expect(r.content).not.toContain('"verdict"');
    });
  }

  const toolCases: Array<[string, RegExp]> = [
    ['anthropic/conflicting-tools', /exactly one emit_output tool call, got 2/],
    ['anthropic/tool-and-other', /unexpected tool call/],
    ['anthropic/tool-with-text', /text alongside the structured tool call/],
    ['anthropic/schema', /no emit_output tool call/],
  ];
  for (const [fixture, why] of toolCases) {
    it(`${fixture} in tool mode → error`, async () => {
      const r = await anthropic(new FixtureFetch([fixture]), { model: 'claude-haiku-4-5-20251001', schemaMode: 'tool' }).complete(req({ schema: SCHEMA }));
      expectEnvelope(r);
      expect(r.error).toMatch(why);
    });
  }

  it('a body without the message/response discriminator is not a final answer', async () => {
    const a = await anthropic(new FixtureFetch([{ status: 200, body: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: APPROVE }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } }])).complete(req({ schema: SCHEMA }));
    expectEnvelope(a);
    const o = await openai(new FixtureFetch([{ status: 200, body: { status: 'completed', model: 'gpt-6', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: APPROVE }] }], usage: { input_tokens: 1, output_tokens: 1 } } }])).complete(req({ schema: SCHEMA }));
    expectEnvelope(o);
  });

  it('the well-formed cases still pass', async () => {
    expect(await openai(new FixtureFetch(['openai/schema'])).complete(req({ schema: SCHEMA }))).toMatchObject({ finishReason: 'stop', content: APPROVE });
    expect(await anthropic(new FixtureFetch(['anthropic/schema'])).complete(req({ schema: SCHEMA }))).toMatchObject({ finishReason: 'stop', content: APPROVE });
    const t = await anthropic(new FixtureFetch(['anthropic/tool']), { model: 'claude-haiku-4-5-20251001', schemaMode: 'tool' }).complete(req({ schema: SCHEMA }));
    expect(t.finishReason).toBe('stop');
  });

  it('length in schema mode drops the partial structured content', async () => {
    const r = await openai(new FixtureFetch(['openai/length'])).complete(req({ schema: SCHEMA }));
    expect(r).toMatchObject({ finishReason: 'length', content: '' });
  });
});

describe('finding 3: the whole outgoing request is scanned; secret-bearing requests are refused unsent', () => {
  const withSecretInSchema = (secret: string, where: 'description' | 'enum' | 'default') => ({
    ...SCHEMA,
    properties: {
      ...SCHEMA.properties,
      note: where === 'description' ? { type: 'string', description: `use ${secret}` } : where === 'enum' ? { type: 'string', enum: [secret] } : { type: 'string', default: secret },
    },
  });

  for (const where of ['description', 'enum', 'default'] as const) {
    it(`schema ${where} carrying a store secret → refused, no HTTP call (both providers, direct constructors)`, async () => {
      for (const [mk, secret] of [[anthropic, oKey], [openai, aKey], [anthropic, CANARY]] as const) {
        const ff = new FixtureFetch(['anthropic/schema', 'openai/schema']);
        const r = await mk(ff).complete(req({ schema: withSecretInSchema(secret, where) }));
        expectEnvelope(r);
        expect(r.error).toMatch(/outgoing request contains a secret/);
        expect(ff.calls).toHaveLength(0);
        expectClean(r, secret);
      }
    });
  }

  it('a standalone handle (no store) still covers its own key in the schema', async () => {
    const auth = new SecretHandle('anthropic', 'env:X', 'anthropic', aKey);
    const ff = new FixtureFetch(['anthropic/schema']);
    const r = await new AnthropicLLM({ auth, model: 'claude-sonnet-5', fetch: ff.fetch, ...noSleep }).complete(req({ schema: withSecretInSchema(aKey, 'description') }));
    expect(r.error).toMatch(/outgoing request contains a secret/);
    expect(ff.calls).toHaveLength(0);
  });

  it('a secret as the requested model name is refused unsent', async () => {
    const ff = new FixtureFetch(['openai/ok']);
    const r = await openai(ff).complete(req({ model: aKey }));
    expect(r.error).toMatch(/outgoing request contains a secret/);
    expect(ff.calls).toHaveLength(0);
    expectClean(r, aKey);
  });

  it('message text is redacted (not refused) and the body then passes the scan; factory providers behave the same', async () => {
    const ff = new FixtureFetch(['openai/ok']);
    const llm = createProvider({ provider: 'openai', model: 'gpt-5.6-terra' }, store(), { fetch: ff.fetch, ...noSleep });
    const r = await llm.complete(req({ messages: [{ role: 'system', content: `canary ${CANARY}` }, { role: 'user', content: `keys ${aKey} ${oKey}` }] }));
    expect(r.finishReason).toBe('stop');
    expectClean(ff.calls[0]!.body, aKey, oKey, CANARY);
  });

  it('malformed requests are refused unsent', async () => {
    const ff = new FixtureFetch([]);
    const llm = anthropic(ff);
    for (const bad of [
      req({ messages: [{ role: 'tool' as 'user', content: 'x' }] }),
      req({ messages: [{ role: 'user', content: 42 as unknown as string }] }),
      req({ maxTokens: -1 }),
      { ...req(), effort: 'max' as 'high' },
    ]) {
      expectEnvelope(await llm.complete(bad));
    }
    expect(ff.calls).toHaveLength(0);
  });
});

describe('finding 4: short secrets refused; decoded-value redaction in transcripts', () => {
  it('short secrets are refused everywhere instead of being exempt', () => {
    expect(() => new SecretHandle('anthropic', 'env:S', 'anthropic', 'abc1234')).toThrow(SecretError);
    expect(() => new SecretStore({ env: { S: 'short' } }).resolve('anthropic', 'env:S')).toThrow(/shorter than 8/);
    expect(() => store().addSecret('canary', 'tiny')).toThrow(SecretError);
    expect(() => makeRedactor(['1234567'])).toThrow();
  });

  it('RecordingLLM transcripts: byte scan finds no secret form, even for a secret with JSON metacharacters', async () => {
    const weird = 'sk-ant-api03-q"uo\\te/' + randomBytes(12).toString('hex');
    const s = store();
    s.addSecret('extra', weird);
    const dir = mkdtempSync(join(tmpdir(), 'tecera-rec-sec-'));
    const inner = new ScriptedLLM({ provider: 'anthropic', script: [`echo ${weird} ${aKey} ${CANARY}`] });
    const errors: string[] = [];
    const rec = new RecordingLLM(inner, { dir, redact: s, onError: (m) => errors.push(m) });
    await rec.complete({ seatId: `seat-${CANARY}`, model: 'm', messages: [{ role: 'user', content: `k=${oKey} w=${weird}` }] });
    expect(errors).toEqual([]);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain(CANARY);
    const bytes = readFileSync(join(dir, files[0]!), 'utf8');
    expectClean(bytes, weird, aKey, oKey, CANARY);
    expect(bytes).toContain('[REDACTED:extra:');
  });

  it('RecordingLLM writes nothing when its redactor fails', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'tecera-rec-fail-')), 'out');
    const errors: string[] = [];
    const boom = { redactText: (t: string) => t, containsSecret: () => null, redactJson: () => { throw new Error('x'); } } as Redactor;
    await new RecordingLLM(new ScriptedLLM(['hi']), { dir, redact: boom, onError: (m) => errors.push(m) }).complete(req());
    expect(errors).toHaveLength(1);
    expect(() => readdirSync(dir)).toThrow();
  });
});

describe('finding 5: adaptive thinking, per-call effort, LLM identity', () => {
  it('current Anthropic models get adaptive thinking + output_config.effort; per-call effort wins over the seat', async () => {
    const ff = new FixtureFetch(['anthropic/ok', 'anthropic/ok']);
    const llm = anthropic(ff, { model: 'claude-opus-5-5', effort: 'high' });
    await llm.complete(req({ temperature: 0.3 }));
    await llm.complete(req({ effort: 'low' }));
    expect(ff.calls[0]!.body).toMatchObject({ model: 'claude-opus-5-5', thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    expect(ff.calls[0]!.body).not.toHaveProperty('temperature');
    expect(ff.calls[1]!.body).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'low' } });
  });

  it('OpenAI reasoning effort is per call over the seat default', async () => {
    const ff = new FixtureFetch(['openai/ok', 'openai/ok']);
    const llm = createProvider({ provider: 'openai', model: 'gpt-6', effort: 'low' }, store(), { fetch: ff.fetch });
    await llm.complete(req());
    await llm.complete(req({ effort: 'high' }));
    expect(ff.calls.map((c) => (c.body as { reasoning: unknown }).reasoning)).toEqual([{ effort: 'low' }, { effort: 'high' }]);
  });

  it('tool schema mode sends no thinking (forced tool_choice is incompatible with it)', async () => {
    const ff = new FixtureFetch(['anthropic/tool']);
    await anthropic(ff, { model: 'claude-sonnet-4-6', schemaMode: 'tool' }).complete(req({ schema: SCHEMA, temperature: 0.2 }));
    expect(ff.calls[0]!.body).not.toHaveProperty('thinking');
    expect(ff.calls[0]!.body).toMatchObject({ temperature: 0.2, output_config: { effort: 'medium' }, tool_choice: { type: 'tool', name: 'emit_output' } });
  });

  it('providers expose model and keyFingerprint (never the key) and refuse a credential of the wrong kind', () => {
    const s = store();
    const a = createProvider({ provider: 'anthropic', model: 'claude-sonnet-5' }, s);
    expect(a.model).toBe('claude-sonnet-5');
    expect(a.keyFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(aKey).not.toContain(a.keyFingerprint!);
    expect(() => new AnthropicLLM({ auth: s.get('openai'), model: 'claude-sonnet-5' })).toThrow(/not an anthropic key/);
    expect(() => new OpenAILLM({ auth: s.get('anthropic'), model: 'gpt-6' })).toThrow(/not an openai key/);
  });
});

describe('finding 6: live tests do not retain keys in the environment', () => {
  it('live.test.ts resolves with env deletion enabled', () => {
    const src = readFileSync(new URL('./live.test.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/deleteFromEnv:\s*false/);
  });
});

describe('finding 7 + review.same_provider: shared env refs, aliases, wrappers, missing identity', () => {
  it('two provider aliases may share one env: reference; the variable is deleted once', () => {
    const env: Record<string, string | undefined> = { K: aKey };
    const s = SecretStore.fromManifest({ providers: { anthropic: { auth: 'env:K' }, 'work-claude': { auth: 'env:K' } } }, { env });
    expect(env['K']).toBeUndefined();
    expect(s.get('anthropic').fingerprint).toBe(s.get('work-claude').fingerprint);
    expect(s.get('work-claude').authorize()['x-api-key']).toBe(aKey);
  });

  it('distinct manifest aliases of one vendor are not foreign, even on different keys', () => {
    const k2 = 'sk-ant-api03-' + randomBytes(24).toString('hex');
    const s = SecretStore.fromManifest({ providers: { anthropic: { auth: 'env:A' }, 'work-claude': { auth: 'env:B' } } }, { env: { A: aKey, B: k2 } });
    const a = createProvider({ provider: 'anthropic', model: 'claude-sonnet-5' }, s);
    const b = createProvider({ provider: 'work-claude', model: 'claude-opus-5-5' }, s);
    expect(a.provider).toBe('anthropic');
    expect(b.provider).toBe('anthropic');
    expect(() => foreignCheck(a, b)).toThrow(/distinct providers/);
  });

  it('recording wrappers forward identity; missing fingerprints fail closed', () => {
    const s = store();
    const dir = mkdtempSync(join(tmpdir(), 'tecera-rec-id-'));
    const a = createProvider({ provider: 'anthropic', model: 'claude-sonnet-5' }, s);
    const o = createProvider({ provider: 'openai', model: 'gpt-6' }, s);
    const recA = new RecordingLLM(a, { dir, redact: s });
    expect(() => foreignCheck(recA, a)).toThrow(ForeignCheckError);
    expect(() => foreignCheck(recA, o)).not.toThrow();
    expect(recA.keyFingerprint).toBe(a.keyFingerprint);
    expect(() => foreignCheck(a, new ScriptedLLM({ provider: 'openai' }))).toThrow(/missing identity is not foreign/);
    expect(() => foreignCheck(a, new ScriptedLLM({ provider: 'openai', keyFingerprint: '' }))).toThrow(ForeignCheckError);
    expect(() => foreignCheck(a, new ScriptedLLM({ provider: 'openai', keyFingerprint: a.keyFingerprint! }))).toThrow(/same key/);
    expect(() => foreignCheck(a, new ScriptedLLM({ provider: ' Anthropic ', keyFingerprint: 'ffff' }))).toThrow(/distinct providers/);
  });
});

describe('finding 8: one error envelope everywhere', () => {
  it('raw.error === error === content for HTTP, refusal, shape, request and output-refusal errors', async () => {
    const results: LLMResponse[] = [
      await anthropic(new FixtureFetch(['anthropic/echo-auth'])).complete(req()),
      await anthropic(new FixtureFetch(['anthropic/refusal'])).complete(req()),
      await anthropic(new FixtureFetch(['anthropic/wrong-shape'])).complete(req()),
      await anthropic(new FixtureFetch(['anthropic/ok'])).complete(req({ schema: SCHEMA })),
      await openai(new FixtureFetch(['openai/refusal'])).complete(req()),
      await openai(new FixtureFetch(['openai/malformed'])).complete(req()),
      await openai(new FixtureFetch([])).complete(req({ messages: [] })),
      await openai(new FixtureFetch(['openai/echo-content'])).complete(req()),
      await new ScriptedLLM([]).complete(req()),
    ];
    for (const r of results) expectEnvelope(r);
  });
});

describe('ScriptedLLM double', () => {
  it('a throwing global matcher or responder is an error response, never a throw', async () => {
    const m = new ScriptedLLM({
      match: () => {
        throw new Error(`matcher ${aKey}`);
      },
      script: ['x'],
    });
    const r = await m.complete(req());
    expectEnvelope(r);
    expect(r.error).not.toContain(aKey);
    const t = new ScriptedLLM([
      () => {
        throw new Error(`responder ${aKey}`);
      },
    ]);
    const r2 = await t.complete(req());
    expectEnvelope(r2);
    expect(r2.error).not.toContain(aKey);
  });
});

describe('fixture specs used inline', () => {
  it('FixtureFetch never records auth header values', async () => {
    const spec: FixtureSpec = { status: 200, body: { type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } };
    const ff = new FixtureFetch([spec]);
    await anthropic(ff).complete(req());
    expectClean(ff.calls, aKey);
  });
});
