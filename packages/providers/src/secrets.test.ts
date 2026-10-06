import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretError, SecretHandle, SecretStore, UnsupportedRefError } from './secrets.js';
import { sha256 } from '@tecera/contracts';
import { sha8 } from './redact.js';

const fakeKey = (p = 'sk-ant-api03-') => p + randomBytes(24).toString('hex');

function leaks(fn: () => unknown, secret: string): 'threw' | boolean {
  try {
    const out = fn();
    return typeof out === 'string' ? out.includes(secret) : JSON.stringify(out ?? null).includes(secret);
  } catch (e) {
    expect(String((e as Error).message)).not.toContain(secret);
    return 'threw';
  }
}

describe('SecretHandle', () => {
  const key = fakeKey();
  const h = new SecretHandle('anthropic', 'env:X', 'anthropic', key);

  it('never yields its value through generic paths', () => {
    expect(leaks(() => JSON.stringify(h), key)).toBe('threw');
    expect(leaks(() => JSON.stringify({ nested: [h] }), key)).toBe('threw');
    expect(leaks(() => String(h), key)).toBe('threw');
    expect(leaks(() => `${h}`, key)).toBe('threw');
    expect(leaks(() => '' + (h as unknown as string), key)).toBe('threw');
    expect(leaks(() => inspect(h), key)).toBe('threw');
    expect(leaks(() => inspect({ h }, { depth: 5, showHidden: true }), key)).toBe('threw');
    expect(Object.keys(h)).toEqual(['name', 'ref', 'kind', 'fingerprint']);
    expect(Object.getOwnPropertyNames(h).some((k) => JSON.stringify((h as unknown as Record<string, unknown>)[k] ?? null).includes(key))).toBe(false);
    expect(JSON.stringify({ ...h })).not.toContain(key);
    expect(Object.values(h).join('|')).not.toContain(key);
  });

  it('structuredClone does not carry the value', () => {
    let clone: unknown;
    try {
      clone = structuredClone(h);
    } catch {
      clone = null;
    }
    expect(JSON.stringify(clone)).not.toContain(key);
    if (clone) expect(() => (clone as SecretHandle).authorize({})).toThrow();
  });

  it('authorize adds the provider header and redact scrubs the value', () => {
    expect(h.authorize({ a: 'b' })).toEqual({ a: 'b', 'x-api-key': key });
    const oa = new SecretHandle('openai', 'env:Y', 'openai', 'sk-proj-abcdefghijklmnopqrstuv');
    expect(oa.authorize()).toEqual({ authorization: 'Bearer sk-proj-abcdefghijklmnopqrstuv' });
    expect(h.redact(`x ${key} y`)).toBe(`x [REDACTED:anthropic:${sha8(key)}] y`);
    expect(h.fingerprint).toBe(sha256(key).slice(0, 16));
  });

  it('a non-provider secret cannot authorize', () => {
    const c = new SecretHandle('canary', 'env:Z', null, 'TECERA_CANARY_abc123');
    expect(() => c.authorize()).toThrow(SecretError);
  });
});

describe('SecretStore', () => {
  it('resolves env refs and deletes the variable from process.env', () => {
    const key = fakeKey();
    process.env['TECERA_TEST_ANTHROPIC_KEY'] = key;
    const s = SecretStore.fromManifest({ providers: { anthropic: { auth: 'env:TECERA_TEST_ANTHROPIC_KEY' } } });
    expect(process.env['TECERA_TEST_ANTHROPIC_KEY']).toBeUndefined();
    expect('TECERA_TEST_ANTHROPIC_KEY' in process.env).toBe(false);
    expect(s.get('anthropic').authorize()['x-api-key']).toBe(key);
    expect(s.canaryValues()).toEqual([key]);
    expect(JSON.stringify(s)).not.toContain(key);
    expect(inspect(s)).not.toContain(key);
  });

  it('fails closed on missing env, unknown scheme, keychain', () => {
    const s = new SecretStore({ env: {} });
    expect(() => s.resolve('anthropic', 'env:NOPE')).toThrow(SecretError);
    expect(() => s.resolve('anthropic', 'vault:x')).toThrow(SecretError);
    expect(() => s.resolve('anthropic', 'keychain:tecera/anthropic')).toThrow(UnsupportedRefError);
    expect(() => s.get('anthropic')).toThrow(SecretError);
  });

  it('resolves file:path#KEY from JSON and dotenv files, relative to cwd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tecera-secrets-'));
    const a = fakeKey();
    const o = fakeKey('sk-proj-');
    writeFileSync(join(dir, 'keys.json'), JSON.stringify({ ANTHROPIC: a }));
    writeFileSync(join(dir, '.keys.env'), `# comment\nexport OPENAI_KEY="${o}"\nOTHER=1 # trailing\n`);
    writeFileSync(join(dir, 'single.txt'), `${a}\n`);
    const s = new SecretStore({ cwd: dir, env: {} });
    expect(s.resolve('anthropic', 'file:keys.json#ANTHROPIC').authorize()['x-api-key']).toBe(a);
    expect(s.resolve('openai', `file:${join(dir, '.keys.env')}#OPENAI_KEY`).authorize()['authorization']).toBe(`Bearer ${o}`);
    expect(s.resolve('claude-single', 'file:single.txt').authorize()['x-api-key']).toBe(a);
    expect(() => s.resolve('x-anthropic', 'file:keys.json#MISSING')).toThrow(/MISSING not found/);
    expect(() => s.resolve('y-anthropic', 'file:keys.json')).toThrow(SecretError);
    expect(() => s.resolve('z-anthropic', 'file:nope.json#K')).toThrow(SecretError);
    try {
      s.resolve('w-anthropic', 'file:keys.json#NOPE');
    } catch (e) {
      expect((e as Error).message).not.toContain(a);
    }
  });

  it('redacts exact, base64 (any alignment), hex and URL-encoded forms plus key-shaped strings', () => {
    const key = 'sk-ant-api03-Zx9+/Qa b&c=d_' + randomBytes(12).toString('hex');
    const s = new SecretStore({ env: { K: key } });
    s.resolve('anthropic', 'env:K');
    const mark = `[REDACTED:anthropic:${sha8(key)}]`;
    const b = Buffer.from(key);
    const forms = [
      key,
      b.toString('base64'),
      b.toString('base64url'),
      b.toString('hex'),
      b.toString('hex').toUpperCase(),
      encodeURIComponent(key),
      [...b].map((x) => '%' + x.toString(16).padStart(2, '0')).join(''),
    ];
    for (const f of forms) {
      const out = s.redact(`before ${f} after`);
      expect(out, f).toContain(mark);
      expect(out).not.toContain(f);
    }
    for (const pre of ['', 'a', 'ab', 'abc']) {
      const blob = Buffer.from(`Authorization header: ${pre}${key} trailing`).toString('base64');
      const out = s.redact(blob);
      expect(out).not.toBe(blob);
      expect(out).toContain(mark);
    }
    const auth = 'Basic ' + Buffer.from(`user:${key}`).toString('base64');
    expect(s.redact(auth)).toContain('[REDACTED:');
    expect(s.redact('stray sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX here')).toMatch(/\[REDACTED:openai:[0-9a-f]{8}\]/);
    s.addSecret('canary', 'TECERA_CANARY_deadbeef01');
    expect(s.redact('x TECERA_CANARY_deadbeef01 y')).toBe(`x [REDACTED:canary:${sha8('TECERA_CANARY_deadbeef01')}] y`);
    expect(s.canaryValues()).toContain('TECERA_CANARY_deadbeef01');
    // short values are refused, never silently left unredacted
    expect(() => s.addSecret('canary', 'abc')).toThrow(SecretError);
    expect(() => s.addSecret('canary', '')).toThrow(SecretError);
  });
});
