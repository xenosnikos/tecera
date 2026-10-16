import { describe, expect, it } from 'vitest';
import { GETTER_MARKER, RedactionError, containsSecret, makeRedactor, redactJson, redactText, secretNeedles, sha8 } from './redact.js';

const SECRET = 'sk-test-Zq81_lm/+=Hx"\\é-key';
const PLAIN = ['Pl41n', 'S3cret', 'Value99'].join('');
const MARK = `[REDACTED:secret:${sha8(PLAIN)}]`;

describe('redactText', () => {
  it('redacts the exact value and every encoded form', () => {
    const bytes = Buffer.from(PLAIN, 'utf8');
    const forms = [
      PLAIN,
      bytes.toString('base64'),
      bytes.toString('base64').replace(/=+$/, ''),
      bytes.toString('base64url'),
      Buffer.concat([Buffer.from('xx'), bytes, Buffer.from('yy')]).toString('base64'), // embedded at another alignment
      bytes.toString('hex'),
      bytes.toString('hex').toUpperCase(),
      encodeURIComponent(PLAIN),
      [...bytes].map((b) => '%' + b.toString(16).padStart(2, '0')).join(''),
      [...bytes].map((b) => '%' + b.toString(16).padStart(2, '0').toUpperCase()).join(''),
    ];
    for (const f of forms) {
      const out = redactText(`before ${f} after`, [PLAIN]);
      expect(out, f).not.toContain(PLAIN);
      expect(out, f).toContain('[REDACTED:secret:');
      for (const n of secretNeedles(PLAIN)) expect(out, f).not.toContain(n);
    }
  });

  it('redacts JSON-escaped (single and double) and URL forms of a secret with special characters', () => {
    const r = makeRedactor([{ kind: 'anthropic', value: SECRET }]);
    const once = JSON.stringify({ k: SECRET });
    const twice = JSON.stringify({ wrapped: once });
    const ascii = JSON.stringify(SECRET).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    for (const t of [once, twice, ascii, encodeURIComponent(SECRET), encodeURIComponent(SECRET).replace(/%20/g, '+')]) {
      const out = r.redactText(t);
      expect(out).toContain(`[REDACTED:anthropic:${sha8(SECRET)}]`);
      expect(r.containsSecret(out)).toBeNull();
    }
  });

  it('refuses secrets shorter than 8 characters at construction, without echoing them', () => {
    expect(() => makeRedactor(['short7!'])).toThrow(RedactionError);
    expect(() => redactText('x', ['abc'])).toThrow(/shorter than 8/);
    try {
      makeRedactor(['hunter2']);
    } catch (e) {
      expect((e as Error).message).not.toContain('hunter2');
    }
    expect(() => makeRedactor([''])).toThrow(RedactionError);
    expect(() => makeRedactor([42 as unknown as string])).toThrow(RedactionError);
    expect(() => makeRedactor(['exactly8'])).not.toThrow();
  });

  it('redacts SECRET_PATTERNS and the TECERA_CANARY_ pattern (underscores included) without known secrets', () => {
    const out = redactText('a TECERA_CANARY_ab_12_Z b ' + 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123 c', []);
    expect(out).not.toMatch(/TECERA_CANARY_/);
    expect(out).not.toMatch(/ab_12_Z/);
    expect(out).toContain(`[REDACTED:canary:${sha8('TECERA_CANARY_ab_12_Z')}]`);
    expect(out).toMatch(/\[REDACTED:github:[0-9a-f]{8}\]/);
  });

  it('redacts before truncating, and redacts a secret cut at either edge', () => {
    const t = `${'x'.repeat(10)}${PLAIN}${'y'.repeat(10)}`;
    const cut = redactText(t, [PLAIN], { maxChars: 15 });
    expect(cut.startsWith('x'.repeat(10))).toBe(true);
    expect(cut).not.toContain(PLAIN.slice(0, 5));
    expect(cut).toMatch(/…\[truncated:\d+\]$/);
    expect(redactText(`log tail ${PLAIN.slice(0, 10)}`, [PLAIN])).toBe(`log tail ${MARK}`);
    expect(redactText(`${PLAIN.slice(6)} head`, [PLAIN])).toBe(`${MARK} head`);
  });

  it('is idempotent and the marker is stable', () => {
    const t = `k=${PLAIN} v=${Buffer.from(PLAIN).toString('hex')} c=TECERA_CANARY_zz9`;
    const once = redactText(t, [PLAIN]);
    expect(redactText(once, [PLAIN])).toBe(once);
    expect(redactText(PLAIN, [PLAIN])).toBe(MARK);
    expect(redactText(PLAIN, [PLAIN, 'otherSecret123'])).toBe(MARK);
    expect(redactText(`${PLAIN}`, [{ kind: 'openai', value: PLAIN }])).toBe(`[REDACTED:openai:${sha8(PLAIN)}]`);
  });
});

describe('redactJson', () => {
  it('walks nested arrays and objects, redacting values and keys', () => {
    const v = { a: [[PLAIN, { deep: [1, `x${PLAIN}`] }]], [PLAIN]: 'key-was-secret', n: null, b: true };
    const out = redactJson(v, [PLAIN]);
    expect(JSON.stringify(out)).not.toContain(PLAIN);
    expect(out).toEqual({ a: [[MARK, { deep: [1, `x${MARK}`] }]], [MARK]: 'key-was-secret', n: null, b: true });
  });

  it('never calls getters, toJSON or valueOf', () => {
    let called = 0;
    const o: Record<string, unknown> = { plain: 'ok' };
    Object.defineProperty(o, 'leak', { enumerable: true, get: () => (called++, PLAIN) });
    (o as { toJSON?: () => unknown }).toJSON = () => (called++, PLAIN);
    (o as { valueOf?: () => unknown }).valueOf = () => (called++, PLAIN);
    const arr: unknown[] = [1];
    Object.defineProperty(arr, '1', { enumerable: true, get: () => (called++, PLAIN) });
    const out = redactJson({ o, arr }, [PLAIN]) as { o: Record<string, unknown>; arr: unknown[] };
    expect(called).toBe(0);
    expect(out.o.leak).toBe(GETTER_MARKER);
    expect(out.o.plain).toBe('ok');
    expect('toJSON' in out.o).toBe(false); // functions are dropped like JSON.stringify
    expect(out.arr).toEqual([1, GETTER_MARKER]);
  });

  it('a secret held in a Buffer, typed array, ArrayBuffer or boxed String is redacted and reported, never emitted as an index map', () => {
    const utf8 = Buffer.from(`token ${PLAIN} end`, 'utf8');
    const utf16 = Buffer.from(PLAIN, 'utf16le');
    const ab = utf8.buffer.slice(utf8.byteOffset, utf8.byteOffset + utf8.byteLength);
    const cases: Record<string, unknown> = { buffer: utf8, u8: new Uint8Array(utf8), view: new DataView(ab), ab, utf16, u16: new Uint16Array(utf16.buffer.slice(utf16.byteOffset, utf16.byteOffset + utf16.byteLength)), boxed: new String(PLAIN), nested: [{ x: Buffer.from(PLAIN) }] };
    for (const [name, v] of Object.entries(cases)) {
      expect(containsSecret({ v }, [PLAIN]), name).toBe('secret');
      const out = JSON.stringify(redactJson({ v }, [PLAIN]));
      expect(out, name).not.toContain(PLAIN);
      expect(out, name).not.toContain('"0":');
      expect(out, name).not.toContain(PLAIN.split('').join('\\u0000'));
    }
    expect(redactJson({ v: utf8 }, [PLAIN])).toEqual({ v: `token ${MARK} end` });
    expect(redactJson({ v: utf16 }, [PLAIN])).toEqual({ v: `[binary:${utf16.byteLength}]` });
    expect(redactJson({ s: new String('plain'), n: new Number(3), b: new Boolean(false), t: Buffer.from('text') }, [PLAIN])).toEqual({ s: 'plain', n: 3, b: false, t: 'text' });
    expect(containsSecret({ t: Buffer.from('text'), s: new String('plain') }, [PLAIN])).toBeNull();
  });

  it('containsSecret never calls a value clean when part of it was not scanned (too deep, or unreadable)', () => {
    let deep: unknown = PLAIN;
    for (let i = 0; i < 70; i++) deep = { d: deep };
    expect(containsSecret(deep, [PLAIN])).toBe('unscanned');
    let ok: unknown = 'leaf';
    for (let i = 0; i < 20; i++) ok = { d: ok };
    expect(containsSecret(ok, [PLAIN])).toBeNull();
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error('boom'); } });
    expect(containsSecret({ h: hostile }, [PLAIN])).toBe('unscanned');
    expect(containsSecret({ h: hostile, s: PLAIN }, [PLAIN])).toBe('secret');
  });

  it('bounds depth, survives cycles and throwing proxies, follows JSON semantics for undefined', () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    expect(redactJson(cyc, [PLAIN])).toEqual({ a: 1, self: '[unserializable:cycle]' });
    let deep: unknown = 'leaf';
    for (let i = 0; i < 100; i++) deep = [deep];
    expect(JSON.stringify(redactJson(deep, [PLAIN], { maxDepth: 5 }))).toContain('[truncated:depth]');
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error('boom'); } });
    expect(redactJson({ h: hostile }, [PLAIN])).toEqual({ h: '[unserializable:error]' });
    expect(redactJson({ u: undefined, arr: [undefined, NaN] }, [PLAIN])).toEqual({ arr: [null, null] });
  });
});

describe('containsSecret', () => {
  it('reports the kind hit in text or json, never the value', () => {
    expect(containsSecret(`x ${Buffer.from(PLAIN).toString('base64')} y`, [PLAIN])).toBe('secret');
    expect(containsSecret({ a: [{ b: `TECERA_CANARY_q1` }] }, [PLAIN])).toBe('canary');
    expect(containsSecret({ [PLAIN]: 1 }, [{ kind: 'openai', value: PLAIN }])).toBe('openai');
    expect(containsSecret({ a: 'clean' }, [PLAIN])).toBeNull();
    let called = false;
    const o = {};
    Object.defineProperty(o, 'g', { enumerable: true, get: () => ((called = true), PLAIN) });
    expect(containsSecret(o, [PLAIN])).toBeNull();
    expect(called).toBe(false);
  });
});
