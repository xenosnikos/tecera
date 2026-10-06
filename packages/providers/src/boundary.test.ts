import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LLMRequest, LLMResponse } from '@tecera/contracts';
import { AnthropicLLM } from './anthropic.js';
import { REDACTION_FAILED, SECRET_OUTPUT_REFUSED } from './base.js';
import { scanDecoded, unescapeAll, UNSCANNABLE } from './decode.js';
import { inertSnapshot, serializeInert, UnsafeBodyError } from './inert.js';
import { OpenAILLM } from './openai.js';
import { OpenRouterLLM } from './openrouter.js';
import { costUsd } from './pricing.js';
import { makeRedactor, type Redactor } from './redact.js';
import { SecretStore } from './secrets.js';
import { FixtureFetch, type FixtureSpec } from './testing/fixtureFetch.js';
import { RecordingLLM } from './testing/recording.js';
import { ScriptedLLM } from './testing/scripted.js';

/**
 * Sprint-2 Codex providers findings (wave 3 item 3):
 *   N1 the outgoing scan covers the exact bytes sent (deep nesting, getters, toJSON, Proxies, TOCTOU getters);
 *   N2 structured output is decoded before it is scanned (\u-escaped, double-escaped, base64, entities);
 *   N3 a response-side redaction failure keeps the billed usage in the fixed REDACTION_FAILED envelope.
 * Plus the missing ScriptedLLM tests (throwing per-item matcher, uncloneable request).
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

function provider(kind: Kind, ff: FixtureFetch, over: Record<string, unknown> = {}) {
  const s = store();
  if (kind === 'openrouter') return new OpenRouterLLM({ auth: s.get('openrouter'), model: 'anthropic/claude-sonnet-4.5', fetch: ff.fetch, ...noSleep, ...over });
  return kind === 'anthropic'
    ? new AnthropicLLM({ auth: s.get('anthropic'), model: 'claude-sonnet-5', fetch: ff.fetch, ...noSleep, ...over })
    : new OpenAILLM({ auth: s.get('openai'), model: 'gpt-5.6-terra', fetch: ff.fetch, ...noSleep, ...over });
}

const req = (over: Partial<LLMRequest> = {}): LLMRequest => ({ seatId: 'reviewer', model: '', messages: [{ role: 'user', content: 'Review the diff.' }], ...over });

/** Every character as a \uXXXX escape: a form the shared redactor does not enumerate. */
const uEscape = (s: string) => [...s].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');

/** Encodings the redactor already covers, plus three layers of escape decoding over the whole JSON text. */
function expectNoSecret(x: unknown, ...secrets: string[]): void {
  let text = typeof x === 'string' ? x : JSON.stringify(x);
  const layers = [text];
  for (let i = 0; i < 3; i++) layers.push((text = unescapeAll(text)));
  for (const s of secrets) {
    const b = Buffer.from(s);
    for (const t of layers) {
      for (const f of [s, b.toString('base64'), b.toString('hex'), uEscape(s), uEscape(s).replace(/\\/g, '\\\\')]) expect(t.includes(f), 'a form of a secret leaked').toBe(false);
    }
  }
}

function expectEnvelope(r: LLMResponse): void {
  expect(r.finishReason).toBe('error');
  expect(r.content).toBe(r.error);
  expect((r.raw as { error?: unknown }).error).toBe(r.error);
}

function okBody(kind: Kind, text: string, usage = { input: 100, output: 20 }): FixtureSpec {
  if (kind === 'openrouter') {
    return {
      status: 200,
      body: {
        object: 'chat.completion',
        model: 'anthropic/claude-sonnet-4.5',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text, refusal: null } }],
        usage: { prompt_tokens: usage.input, completion_tokens: usage.output },
      },
    };
  }
  return kind === 'anthropic'
    ? { status: 200, body: { type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: usage.input, output_tokens: usage.output } } }
    : {
        status: 200,
        body: {
          object: 'response',
          model: 'gpt-5.6-terra',
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }],
          usage: { input_tokens: usage.input, output_tokens: usage.output },
        },
      };
}

const BILLED_MODEL: Record<Kind, string> = { anthropic: 'claude-sonnet-5', openai: 'gpt-5.6-terra', openrouter: 'anthropic/claude-sonnet-4.5' };
const billed = (kind: Kind) => costUsd(BILLED_MODEL[kind], { inputTokens: 100, outputTokens: 20 });

function nested(depth: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let s: Record<string, unknown> = leaf;
  for (let i = 0; i < depth; i++) s = { type: 'object', properties: { x: s } };
  return s;
}

// ---------------------------------------------------------------------------------------------------------

describe('N1: the scanned bytes are the sent bytes (both providers)', () => {
  for (const kind of KINDS) {
    it(`${kind}: a secret beneath 140 nested schema levels is refused unsent`, async () => {
      for (const secret of [aKey, oKey, CANARY]) {
        const ff = new FixtureFetch([okBody(kind, '{}')]);
        const r = await provider(kind, ff).complete(req({ schema: nested(70, { type: 'string', description: `use ${secret}` }) }));
        expectEnvelope(r);
        expect(r.error).toMatch(/request refused/);
        expect(ff.calls).toHaveLength(0);
        expectNoSecret(r, secret);
      }
    });

    it(`${kind}: nesting beyond the body depth limit is refused even without a secret; a benign deep schema within it is sent`, async () => {
      const ff = new FixtureFetch([okBody(kind, '{"a":1}')]);
      const deep = await provider(kind, ff).complete(req({ schema: nested(40, { type: 'string' }) }));
      expect(deep.error).toMatch(/nested deeper than 64 levels/);
      expect(ff.calls).toHaveLength(0);
      const ok = await provider(kind, ff).complete(req({ schema: nested(25, { type: 'string' }) }));
      expect(ok.finishReason).toBe('stop');
      expect(ff.calls).toHaveLength(1);
    });

    it(`${kind}: a schema getter is refused and never invoked`, async () => {
      let reads = 0;
      const schema = {
        type: 'object',
        properties: {
          note: {
            type: 'string',
            get description() {
              reads++;
              return `use ${CANARY}`;
            },
          },
        },
      };
      const ff = new FixtureFetch([okBody(kind, '{}')]);
      const r = await provider(kind, ff).complete(req({ schema }));
      expect(r.error).toMatch(/accessor property/);
      expect(ff.calls).toHaveLength(0);
      expect(reads).toBe(0);
      expectNoSecret(r, CANARY);
    });

    it(`${kind}: own, inherited and prototype-polluted toJSON hooks are refused and never invoked`, async () => {
      let calls = 0;
      const own = { type: 'object', toJSON: () => (calls++, { description: aKey }) };
      class Schema {
        type = 'object';
        toJSON() {
          calls++;
          return { description: aKey };
        }
      }
      for (const schema of [own, new Schema()]) {
        const ff = new FixtureFetch([okBody(kind, '{}')]);
        const r = await provider(kind, ff).complete(req({ schema: schema as unknown as Record<string, unknown> }));
        expect(r.error).toMatch(/toJSON|non-plain/);
        expect(ff.calls).toHaveLength(0);
      }
      const proto = Object.prototype as unknown as { toJSON?: () => unknown };
      proto.toJSON = () => (calls++, { leaked: oKey });
      try {
        const ff = new FixtureFetch([okBody(kind, '{}')]);
        const r = await provider(kind, ff).complete(req({ schema: { type: 'object' } }));
        expect(r.error).toMatch(/toJSON/);
        expect(ff.calls).toHaveLength(0);
      } finally {
        delete proto.toJSON;
      }
      expect(calls).toBe(0);
    });

    it(`${kind}: a Proxy schema is refused without running a trap`, async () => {
      let traps = 0;
      const handler: ProxyHandler<object> = new Proxy({}, { get: () => (..._a: unknown[]) => (traps++, undefined) });
      const schema = new Proxy({ type: 'object' }, handler);
      const ff = new FixtureFetch([okBody(kind, '{}')]);
      const r = await provider(kind, ff).complete(req({ schema: schema as Record<string, unknown> }));
      expect(r.error).toMatch(/Proxy/);
      expect(ff.calls).toHaveLength(0);
      expect(traps).toBe(0);
    });

    it(`${kind}: request getters are read once (no scan-one-value, send-another)`, async () => {
      let schemaReads = 0;
      let contentReads = 0;
      const msg = {
        role: 'user' as const,
        get content() {
          contentReads++;
          return contentReads === 1 ? 'benign question' : `leak ${aKey}`;
        },
      };
      const r0 = {
        seatId: 's',
        model: '',
        messages: [msg],
        get schema() {
          schemaReads++;
          return schemaReads === 1 ? { type: 'object' } : { type: 'object', description: oKey };
        },
      } as unknown as LLMRequest;
      const ff = new FixtureFetch([okBody(kind, '{"ok":true}')]);
      const r = await provider(kind, ff).complete(r0);
      expect(r.finishReason).toBe('stop');
      expect(schemaReads).toBe(1);
      expect(contentReads).toBe(1);
      expectNoSecret(ff.calls[0]!.bodyText, aKey, oKey);
      expect(ff.calls[0]!.bodyText).toContain('benign question');
    });

    it(`${kind}: escaped or encoded secrets anywhere in the body are refused unsent (schema and message text)`, async () => {
      const b64OfEscaped = Buffer.from(JSON.stringify({ k: uEscape(oKey) })).toString('base64');
      for (const over of [
        { schema: { type: 'object', description: `x ${uEscape(aKey)}` } },
        { schema: { type: 'object', enum: [b64OfEscaped] } },
        { schema: { type: 'object', default: [...CANARY].map((c) => `&#${c.charCodeAt(0)};`).join('') } },
        { messages: [{ role: 'user' as const, content: `token ${uEscape(oKey)}` }] },
      ]) {
        const ff = new FixtureFetch([okBody(kind, '{}')]);
        const r = await provider(kind, ff).complete(req(over));
        expect(r.error).toMatch(/outgoing request contains a secret/);
        expect(ff.calls).toHaveLength(0);
        expectNoSecret(r, aKey, oKey, CANARY);
      }
    });

    it(`${kind}: the sent bytes are the canonical serialization of the host's inert snapshot`, async () => {
      const ff = new FixtureFetch([okBody(kind, '{"ok":true}')]);
      const schema = { type: 'object', properties: { a: { type: 'string', description: 'quote " backslash \\ newline \n unicode é' } } };
      await provider(kind, ff).complete(req({ schema, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: `k=${aKey}` }] }));
      const sent = ff.calls[0]!.bodyText!;
      expect(typeof sent).toBe('string');
      expect(sent).toBe(JSON.stringify(JSON.parse(sent)));
      expect(sent).toBe(serializeInert(inertSnapshot(JSON.parse(sent))));
      expectNoSecret(sent, aKey);
      expect(sent).toContain('[REDACTED:anthropic:');
    });
  }

  it('inertSnapshot refuses every non-inert shape and serializes like JSON.stringify for plain data', () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc['self'] = cyc;
    for (const bad of [cyc, { d: new Date(0) }, { m: new Map() }, { f: () => 1 }, { b: 1n }, { n: Number.NaN }, { s: Symbol('x') }, { buf: Buffer.from('x') }]) {
      expect(() => inertSnapshot(bad)).toThrow(UnsafeBodyError);
    }
    const plain = { z: 1, a: [1, 'two', null, { b: false }], '10': 'n', '2': 'm', u: undefined, arr: [undefined] };
    expect(serializeInert(inertSnapshot(plain))).toBe(JSON.stringify(plain));
  });
});

describe('N2: structured output is decoded before it is scanned (both providers)', () => {
  const SCHEMA = { type: 'object', properties: { value: { type: 'string' } } };
  const encodings: Array<[string, (s: string) => string]> = [
    ['\\u-escaped JSON string', (s) => JSON.stringify({ value: '@' }).replace('@', uEscape(s))],
    ['double-escaped (\\\\u) JSON string', (s) => JSON.stringify({ value: '@' }).replace('@', uEscape(s).replace(/\\/g, '\\\\'))],
    ['base64 of escaped JSON', (s) => JSON.stringify({ value: Buffer.from(JSON.stringify({ k: '@' }).replace('@', uEscape(s))).toString('base64') })],
    ['HTML entities', (s) => JSON.stringify({ value: [...s].map((c) => `&#x${c.charCodeAt(0).toString(16)};`).join('') })],
    ['escaped beneath 70 nested levels', (s) => '{"a":'.repeat(70) + JSON.stringify({ value: '@' }).replace('@', uEscape(s)) + '}'.repeat(70)],
  ];
  for (const kind of KINDS) {
    for (const [name, enc] of encodings) {
      it(`${kind}: ${name} → refused with billed usage; raw keeps no decodable form`, async () => {
        for (const secret of [aKey, oKey, CANARY]) {
          const text = enc(secret);
          expect(text).not.toContain(secret);
          const r = await provider(kind, new FixtureFetch([okBody(kind, text)])).complete(req({ schema: SCHEMA }));
          expectEnvelope(r);
          expect(r.error).toBe(SECRET_OUTPUT_REFUSED);
          expect(r.usage.inputTokens).toBe(100);
          expect(r.usage.outputTokens).toBe(20);
          expect(r.usage.usd).toBe(billed(kind));
          expectNoSecret(r, secret);
        }
      });
    }

    it(`${kind}: plain-text mode applies the same decoded check to content`, async () => {
      const r = await provider(kind, new FixtureFetch([okBody(kind, `the key is ${uEscape(CANARY)}`)])).complete(req());
      expect(r.error).toBe(SECRET_OUTPUT_REFUSED);
      expectNoSecret(r, CANARY);
    });

    it(`${kind}: an escaped secret in an HTTP error body never reaches error or raw.response`, async () => {
      const spec: FixtureSpec = { status: 400, body: { error: { message: `bad input ${uEscape(oKey)}` }, echo: { deep: [`${Buffer.from(uEscape(aKey)).toString('base64')}`] } } };
      const r = await provider(kind, new FixtureFetch([spec])).complete(req());
      expectEnvelope(r);
      expect((r.raw as { status?: number }).status).toBe(400);
      expectNoSecret(r, oKey, aKey);
      expect(JSON.stringify(r)).toContain(':decoded]');
    });

    it(`${kind}: ordinary structured output still passes`, async () => {
      const r = await provider(kind, new FixtureFetch([okBody(kind, '{"value":"fine \\u00e9 text","n":[1,2]}')])).complete(req({ schema: SCHEMA }));
      expect(r.finishReason).toBe('stop');
      expect(JSON.parse(r.content)).toEqual({ value: 'fine é text', n: [1, 2] });
    });
  }

  it('anthropic tool mode: an escaped secret inside the tool input is refused', async () => {
    const spec: FixtureSpec = {
      status: 200,
      body: {
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'tool_use', id: 't', name: 'emit_output', input: { verdict: 'approve', findings: [{ note: uEscape(oKey) }] } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    };
    const r = await provider('anthropic', new FixtureFetch([spec]), { model: 'claude-haiku-4-5-20251001', schemaMode: 'tool' }).complete(req({ schema: { type: 'object' } }));
    expect(r.error).toBe(SECRET_OUTPUT_REFUSED);
    expect(r.usage.inputTokens).toBe(100);
    expectNoSecret(r, oKey);
  });

  it('scanDecoded fails closed when its work bound is exhausted', () => {
    const r = makeRedactor([aKey]);
    const big = Array.from({ length: 200 }, () => Buffer.from(`${'x'.repeat(40)} ${uEscape('y'.repeat(20))}`).toString('base64')).join(' ');
    expect(scanDecoded(big, (t) => r.containsSecret(t), { left: 10 })).toBe(UNSCANNABLE);
  });
});

describe('N3: response-side redaction failures keep the billed usage (both providers)', () => {
  for (const kind of KINDS) {
    it(`${kind}: a throwing response redactor → fixed REDACTION_FAILED envelope with the billed tokens and usd`, async () => {
      const half: Redactor = {
        redactText: (t) => t,
        redactJson: () => {
          throw new Error(`nope ${aKey}`);
        },
        containsSecret: () => null,
      };
      const ff = new FixtureFetch([okBody(kind, `secret ${oKey}`)]);
      const r = await provider(kind, ff, { redactor: half }).complete(req());
      expect(ff.calls).toHaveLength(1);
      expect(r).toEqual({
        content: REDACTION_FAILED,
        error: REDACTION_FAILED,
        finishReason: 'error',
        model: '',
        usage: { inputTokens: 100, outputTokens: 20, usd: billed(kind) },
        raw: { error: REDACTION_FAILED },
      });
      expect(billed(kind)).toBeGreaterThan(0);
    });

    it(`${kind}: a scanner that throws only on the response → REDACTION_FAILED with the billed usage`, async () => {
      const flaky: Redactor = {
        redactText: (t) => t,
        redactJson: (v) => JSON.parse(JSON.stringify(v ?? null)),
        containsSecret: (v) => {
          if (typeof v === 'string' && v.includes('MODEL-REPLY')) throw new Error('scanner broke');
          return null;
        },
      };
      const r = await provider(kind, new FixtureFetch([okBody(kind, 'MODEL-REPLY')]), { redactor: flaky }).complete(req());
      expect(r.error).toBe(REDACTION_FAILED);
      expect(r.content).toBe(REDACTION_FAILED);
      expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20, usd: billed(kind) });
    });

    it(`${kind}: a secret-bearing refusal keeps the billed usd too`, async () => {
      const r = await provider(kind, new FixtureFetch([okBody(kind, `echo ${CANARY}`)])).complete(req());
      expect(r.error).toBe(SECRET_OUTPUT_REFUSED);
      expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20, usd: billed(kind) });
    });

    it(`${kind}: a redactor failing on an HTTP error body gives the fixed envelope (nothing billed)`, async () => {
      const half: Redactor = { redactText: (t) => t, redactJson: () => { throw new Error('x'); }, containsSecret: () => null };
      const r = await provider(kind, new FixtureFetch([{ status: 400, body: { error: { message: `bad ${oKey}` } } }]), { redactor: half }).complete(req());
      expect(r).toEqual({ content: REDACTION_FAILED, error: REDACTION_FAILED, finishReason: 'error', model: '', usage: { inputTokens: 0, outputTokens: 0, usd: 0 }, raw: { error: REDACTION_FAILED } });
    });
  }
});

describe('ScriptedLLM double (Codex missing tests)', () => {
  it('a throwing per-item matcher is an error response, never a throw, and carries no secret', async () => {
    const llm = new ScriptedLLM([
      {
        match: () => {
          throw new Error(`item matcher ${aKey}`);
        },
        respond: 'never',
      },
    ]);
    const r = await llm.complete(req());
    expectEnvelope(r);
    expect(r.error).toMatch(/responder threw|matcher/);
    expect(r.error).not.toContain(aKey);
    expect(llm.remaining).toBe(0);
  });

  it('a per-item matcher that rejects reports the reason; a throwing per-item responder too', async () => {
    const llm = new ScriptedLLM([
      { match: () => 'wrong seat', respond: 'x' },
      {
        match: () => true,
        respond: () => {
          throw new Error(`respond ${oKey}`);
        },
      },
    ]);
    const a = await llm.complete(req());
    expect(a.error).toMatch(/rejected by item matcher: wrong seat/);
    const b = await llm.complete(req());
    expectEnvelope(b);
    expect(b.error).not.toContain(oKey);
  });

  it('an uncloneable request is an error response and consumes no script item', async () => {
    const llm = new ScriptedLLM(['answer']);
    const bad = { ...req(), extra: () => 1 } as unknown as LLMRequest;
    const r = await llm.complete(bad);
    expectEnvelope(r);
    expect(r.error).toMatch(/not cloneable/);
    expect(llm.remaining).toBe(1);
    expect(llm.requests).toHaveLength(0);
    expect((await llm.complete(req())).content).toBe('answer');
  });
});

describe('RecordingLLM transcripts are decoded-checked', () => {
  it('an escaped or base64-of-escaped secret in a request or response is withheld from the transcript', async () => {
    const s = store();
    const dir = mkdtempSync(join(tmpdir(), 'tecera-rec-decoded-'));
    const inner = new ScriptedLLM({ provider: 'anthropic', script: [`answer ${uEscape(aKey)} and ${Buffer.from(uEscape(CANARY)).toString('base64')}`] });
    const errors: string[] = [];
    const rec = new RecordingLLM(inner, { dir, redact: s, onError: (m) => errors.push(m) });
    const r = await rec.complete(req({ messages: [{ role: 'user', content: `q ${uEscape(oKey).replace(/\\/g, '\\\\')}` }] }));
    expect(r.finishReason).toBe('stop'); // the response itself is passed through unchanged (providers sanitize their own)
    expect(errors).toEqual([]);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const bytes = readFileSync(join(dir, files[0]!), 'utf8');
    expectNoSecret(bytes, aKey, oKey, CANARY);
    expect(bytes).toContain(':decoded]');
  });
});
