import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Installed-package check, MANDATORY (never skipped): compile the current src/ afresh with the repo's
 * TypeScript compiler (invoked directly through node; no npm/npx) into a temp dir under os.tmpdir(), lay the
 * package out the way a consumer gets it (package.json plus the compiled dist only, under
 * node_modules/@tecera/providers, no checkout `src/`), then run the bundled fixtures and the exact-bytes and
 * decoded-output boundaries through the providers in a separate node process. A stale or missing checkout
 * dist cannot make this pass or skip.
 */

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgDir, '..', '..');
const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

describe('installed package (fresh build)', () => {
  it('bundled fixtures and providers work without the checkout src/ directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'tecera-providers-installed-'));
    const dest = join(root, 'node_modules', '@tecera', 'providers');
    mkdirSync(dest, { recursive: true });
    expect(existsSync(tsc)).toBe(true);
    execFileSync(process.execPath, [tsc, '-p', join(pkgDir, 'tsconfig.json'), '--outDir', join(dest, 'dist'), '--declarationMap', 'false'], { cwd: pkgDir, stdio: 'pipe', encoding: 'utf8' });
    expect(existsSync(join(dest, 'dist', 'index.js'))).toBe(true);
    expect(existsSync(join(dest, 'dist', 'testing', 'fixtures', 'anthropic.js'))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { files: string[] };
    cpSync(join(pkgDir, 'package.json'), join(dest, 'package.json'));
    for (const f of pkg.files) if (f !== 'dist' && existsSync(join(pkgDir, f))) cpSync(join(pkgDir, f), join(dest, f), { recursive: true });
    expect(existsSync(join(dest, 'src'))).toBe(false);
    symlinkSync(join(repoRoot, 'packages', 'contracts'), join(root, 'node_modules', '@tecera', 'contracts'), 'dir');
    symlinkSync(join(repoRoot, 'node_modules', 'zod'), join(root, 'node_modules', 'zod'), 'dir');
    const probe = join(root, 'probe.mjs');
    writeFileSync(
      probe,
      `import { AnthropicLLM, OpenAILLM, SecretHandle, FixtureFetch, fixtureNames, SECRET_OUTPUT_REFUSED } from '@tecera/providers';
const aKey = 'sk-ant-api03-' + 'x'.repeat(40);
const a = new SecretHandle('anthropic', 'env:A', 'anthropic', aKey);
const o = new SecretHandle('openai', 'env:O', 'openai', 'sk-proj-' + 'y'.repeat(40));
const fa = new FixtureFetch(['anthropic/ok']);
const fo = new FixtureFetch(['openai/user-role']);
const msg = { seatId: 's', model: '', messages: [{ role: 'user', content: 'hi' }] };
const ra = await new AnthropicLLM({ auth: a, model: 'claude-sonnet-5', fetch: fa.fetch }).complete(msg);
const ro = await new OpenAILLM({ auth: o, model: 'gpt-6', fetch: fo.fetch }).complete(msg);
let reads = 0;
const getterSchema = { type: 'object', get description() { reads++; return aKey; } };
const fg = new FixtureFetch(['anthropic/ok']);
const rg = await new AnthropicLLM({ auth: a, model: 'claude-sonnet-5', fetch: fg.fetch }).complete({ ...msg, schema: getterSchema });
const esc = [...aKey].map((c) => '\\\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
const fe = new FixtureFetch([{ status: 200, body: { type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: '{"v":"' + esc + '"}' }], stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 3 } } }]);
const re = await new AnthropicLLM({ auth: a, model: 'claude-sonnet-5', fetch: fe.fetch }).complete({ ...msg, schema: { type: 'object' } });
const harmless = Array.from({ length: 512 }, (_, i) => Buffer.from('note' + String(i).padStart(5, '0')).toString('base64')).join(' ');
const probeText = harmless + ' ' + Buffer.from(esc).toString('base64');
const fx = new FixtureFetch(['anthropic/ok']);
const rx = await new AnthropicLLM({ auth: a, model: 'claude-sonnet-5', fetch: fx.fetch }).complete({ ...msg, messages: [{ role: 'user', content: probeText }] });
const fm = new FixtureFetch([{ status: 200, body: { type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: null, stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } } }]);
const rm = await new AnthropicLLM({ auth: a, model: 'claude-sonnet-5', fetch: fm.fetch, maxRetries: 0 }).complete(msg);
const fu = new FixtureFetch([{ status: 200, body: { object: 'response', model: 'gpt-6', status: 'completed', output: [] } }]);
const ru = await new OpenAILLM({ auth: o, model: 'gpt-6', fetch: fu.fetch, maxRetries: 0 }).complete(msg);
console.log(JSON.stringify({
  a: [ra.finishReason, ra.content], o: [ro.finishReason, ro.error], n: fixtureNames().length,
  getter: [rg.finishReason, fg.calls.length, reads], sentText: typeof fa.calls[0].bodyText,
  escaped: [re.error === SECRET_OUTPUT_REFUSED, re.usage.inputTokens, JSON.stringify(re).includes(esc)],
  exhausted: [rx.finishReason, fx.calls.length, /unscannable/.test(rx.error)],
  malformed: [rm.finishReason, rm.usage.inputTokens, rm.usage.outputTokens, rm.usage.usd > 0, rm.usage.unknown === undefined],
  noUsage: [ru.finishReason, ru.usage.unknown === true, ru.usage.usd > 0],
}));
`,
    );
    const out = execFileSync(process.execPath, [probe], { cwd: root, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } });
    const r = JSON.parse(out.trim()) as {
      a: [string, string];
      o: [string, string];
      n: number;
      getter: [string, number, number];
      sentText: string;
      escaped: [boolean, number, boolean];
      exhausted: [string, number, boolean];
      malformed: [string, number, number, boolean, boolean];
      noUsage: [string, boolean, boolean];
    };
    expect(r.a).toEqual(['stop', 'Hello from Claude.']);
    expect(r.o[0]).toBe('error');
    expect(r.o[1]).toMatch(/non-assistant/);
    expect(r.n).toBeGreaterThan(30);
    expect(r.getter).toEqual(['error', 0, 0]);
    expect(r.sentText).toBe('string');
    expect(r.escaped).toEqual([true, 7, false]);
    // wave 4: decoder exhaustion refuses before sending; malformed answers keep billed usage; missing usage is unknown.
    expect(r.exhausted).toEqual(['error', 0, true]);
    expect(r.malformed).toEqual(['error', 100, 20, true, true]);
    expect(r.noUsage).toEqual(['error', true, true]);
  }, 180_000);
});
