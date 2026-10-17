import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkerToolContext } from './common.js';
import type { CapabilitySet, Json, ToolContext, ToolRequest } from '@tecera/contracts';
import { checkEdit, codeKindOf, declaredNames, exportedNames, syntaxProblem } from './codeCheck.js';
import { createEditTool as rawEditTool } from './edit.js';
import { markWorktreeTainted } from './paths.js';
import { liveWriteGuard, seenOnDisk } from '../invoke/fakes.js';
import { EDIT_DESCRIPTION, STANDARD_STUBS } from '../protocol/prompts.js';

const G = liveWriteGuard();
const raw = rawEditTool();
const edit = { ...raw, call: (r: ToolRequest, c: ToolContext) => raw.call(r, c, G) };

const caps = (): CapabilitySet => ({
  tools: ['read', 'edit'],
  paths: { read: ['**'], write: ['src/**', 'docs/**'], protected: ['**/*.test.js'] },
  network: 'none',
  limits: { usd: 1, tokens: 1000, calls: 10, wallMs: 1000, depth: 2, iterations: 5 },
});
const req = (...args: Json[]): ToolRequest => ({ callId: 'c1', tool: 'edit', method: 'call', args, idemKey: 'k' });

const REPORT = [
  '// Sales report.',
  'export function summarize(rows) {',
  '  return rows.length;',
  '}',
  '',
  'export function formatText(summary) {',
  '  return String(summary);',
  '}',
  '',
].join('\n');

let root: string;
let ctx: WorkerToolContext;
const text = (rel: string): Promise<string> => readFile(join(root, rel), 'utf8');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tecera-codecheck-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/report.js'), REPORT);
  await writeFile(join(root, 'src/mail.cjs'), "function send() {}\nfunction validEmail(s) { return s.includes('@'); }\nmodule.exports = { send, validEmail };\n");
  await writeFile(join(root, 'src/math.ts'), 'export const add = (a: number, b: number): number => a + b;\nexport enum Op { Add }\n');
  ctx = { runId: 'r1', worktree: root, capabilities: caps(), fencingToken: 7, knownDigest: seenOnDisk(root) };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('edit refuses content that does not parse', () => {
  it('a whole-file write of non-parsing JS is refused with the parser message and line; nothing changes', async () => {
    const broken = REPORT.replace('  return String(summary);', '  return String(summary;');
    const r = await edit.call(req('src/report.js', broken), ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/src\/report\.js line 7: SyntaxError/);
    expect(r.error?.message).toMatch(/Nothing was written/);
    expect(await text('src/report.js')).toBe(REPORT);
  });

  it('checks .mjs as a module, .cjs as CommonJS and .ts with the TypeScript parser', async () => {
    const mjs = await edit.call(req('src/new.mjs', 'export const a = 1;\nexport const b = ;\n'), ctx);
    expect(mjs.error?.message).toMatch(/src\/new\.mjs line 2: SyntaxError: Unexpected token ';'/);
    // A module-only construct is not valid CommonJS.
    expect((await edit.call(req('src/new.cjs', 'const a = 1;\nexport { a };\n'), ctx)).error?.message).toMatch(/src\/new\.cjs line 2: SyntaxError/);
    const ts = await edit.call(req({ path: 'src/math.ts', oldText: 'a + b;', newText: '(a + b;' }), ctx);
    expect(ts.error?.message).toMatch(/src\/math\.ts line 1: SyntaxError/);
    expect(await text('src/math.ts')).toContain('a + b;');
    // Valid code in each kind is written (TS syntax that strip-only mode cannot erase included).
    for (const [p, c] of [
      ['src/ok.mjs', 'export const a = await Promise.resolve(1);\n'],
      ['src/ok.cjs', 'if (require.main === module) return;\nmodule.exports = 1;\n'],
      ['src/ok.ts', 'export enum E { A }\nexport namespace N { export const x: number = 1; }\n'],
      ['src/ok.js', 'export default function f() {}\n'],
    ] as const) {
      const w = await edit.call(req(p, c), ctx);
      expect(w.ok, `${p}: ${w.error?.message}`).toBe(true);
      expect(w.value).toMatchObject({ syntax: 'parsed' });
    }
    // Neither a new file nor its directory is created for refused content.
    expect((await edit.call(req('src/fresh/dir/x.js', 'function (') , ctx)).ok).toBe(false);
    await expect(stat(join(root, 'src/fresh'))).rejects.toThrow();
  });

  it('a partial edit that breaks the syntax is refused with the line', async () => {
    const r = await edit.call(req({ path: 'src/report.js', oldText: '  return rows.length;\n}', newText: '  return rows.length;\n' }), ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/src\/report\.js line \d+: SyntaxError/);
    expect(await text('src/report.js')).toBe(REPORT);
  });

  it('a partial edit of a file that already did not parse is not blamed for it; a whole-file write must parse', async () => {
    await writeFile(join(root, 'src/broken.js'), 'export const a = (1;\nexport const b = (2;\n');
    const step = await edit.call(req({ path: 'src/broken.js', oldText: 'a = (1;', newText: 'a = (1);' }), ctx);
    expect(step.ok, step.error?.message).toBe(true);
    expect(step.value).toMatchObject({ syntax: 'already-broken' });
    expect((await edit.call(req({ path: 'src/broken.js', oldText: 'b = (2;', newText: 'b = (2);' }), ctx)).value).toMatchObject({ syntax: 'parsed' });
    await writeFile(join(root, 'src/broken.js'), 'export const a = (1;\n');
    expect((await edit.call(req('src/broken.js', 'export const a = (1;\nexport const c = 3;\n'), ctx)).error?.message).toMatch(/SyntaxError/);
  });

  it('never executes the content it checks', async () => {
    const marker = join(root, 'executed');
    const side = (s: string): string => `${s}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');\nwhile (true) {}\n`;
    expect((await edit.call(req('src/side.cjs', side("'use strict';")), ctx)).ok).toBe(true);
    const esm = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'x');\nexport {};\n`;
    expect((await edit.call(req('src/side.mjs', esm), ctx)).ok).toBe(true);
    expect((await edit.call(req('src/side.ts', side('const n: number = 1;')), ctx)).ok).toBe(true);
    await expect(stat(marker)).rejects.toThrow();
  });

  it('files outside the JS/TS family are unaffected', async () => {
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs/a.md'), 'export const a = 1;\n');
    for (const [p, c] of [
      ['docs/a.md', 'export const = (\n'],
      ['src/data.json', '{ "not": json'],
      ['src/view.jsx', 'export const V = () => <div>(</div>;\n'],
      ['src/notes.txt', 'function ('],
    ] as const) {
      const w = await edit.call(req(p, c), ctx);
      expect(w.ok, `${p}: ${w.error?.message}`).toBe(true);
      expect(w.value).toMatchObject({ syntax: 'not-checked' });
      expect(w.value).not.toHaveProperty('removedExports');
      expect(await text(p)).toBe(c);
    }
  });
});

describe('edit refuses removing exports unless declared', () => {
  it('a whole-file rewrite that drops exports is refused, naming them; nothing changes', async () => {
    const rewrite = 'export function formatCsv(summary) {\n  return summary.join(",");\n}\n';
    const r = await edit.call(req('src/report.js', rewrite), ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/removes exported name\(s\) "formatText", "summarize"/);
    expect(r.error?.message).toMatch(/removeExports/);
    expect(await text('src/report.js')).toBe(REPORT);
    // Adding next to what is kept is fine.
    const added = await edit.call(req('src/report.js', REPORT + rewrite), ctx);
    expect(added.ok, added.error?.message).toBe(true);
    expect(added.value).toMatchObject({ syntax: 'parsed' });
    expect(added.value).not.toHaveProperty('removedExports');
  });

  it('the same rewrite with removeExports declared is written and the removal is recorded', async () => {
    const rewrite = 'export function formatCsv(summary) {\n  return summary.join(",");\n}\n';
    const partial = await edit.call(req({ path: 'src/report.js', content: rewrite, removeExports: ['summarize'] }), ctx);
    expect(partial.error?.message).toMatch(/removes exported name\(s\) "formatText"/);
    expect(partial.error?.message).not.toMatch(/"summarize"/);
    expect(await text('src/report.js')).toBe(REPORT);
    const r = await edit.call(req({ path: 'src/report.js', content: rewrite, removeExports: ['summarize', 'formatText'] }), ctx);
    expect(r.ok, r.error?.message).toBe(true);
    expect(r.value).toMatchObject({ mode: 'write', syntax: 'parsed', removeExports: ['summarize', 'formatText'], removedExports: ['formatText', 'summarize'] });
    expect(await text('src/report.js')).toBe(rewrite);
    // writeFile(path, content, {removeExports}) is the same request.
    const back = await edit.call(req('src/report.js', 'export const x = 1;\n', { removeExports: ['formatCsv'] }), ctx);
    expect(back.value).toMatchObject({ removeExports: ['formatCsv'], removedExports: ['formatCsv'] });
  });

  it('partial edits and CommonJS modules are checked on the resulting content', async () => {
    const rename = await edit.call(req({ path: 'src/report.js', oldText: 'function formatText(', newText: 'function formatPlain(' }), ctx);
    expect(rename.error?.message).toMatch(/"formatText"/);
    const ok = await edit.call(req({ path: 'src/report.js', oldText: 'function formatText(', newText: 'function formatPlain(', removeExports: ['formatText'] }), ctx);
    expect(ok.value).toMatchObject({ mode: 'replace', removedExports: ['formatText'] });
    // A rewrite that drops validEmail from module.exports (the live-run failure shape).
    const cjs = await edit.call(req('src/mail.cjs', 'function send() {}\nmodule.exports = { send };\n'), ctx);
    expect(cjs.error?.message).toMatch(/"validEmail"/);
    expect(await text('src/mail.cjs')).toContain('validEmail');
    expect((await edit.call(req('src/mail.cjs', 'exports.send = () => {};\nexports.validEmail = (s) => s.includes("@");\nmodule.exports.extra = 1;\n'), ctx)).error?.message).toMatch(/"module\.exports"/);
    // TypeScript exports too.
    expect((await edit.call(req({ path: 'src/math.ts', oldText: 'export enum Op { Add }\n', newText: '' }), ctx)).error?.message).toMatch(/"Op"/);
  });

  it('removeExports must be a list of names', async () => {
    for (const bad of ['summarize', [1], [''], Array.from({ length: 201 }, (_, i) => `n${i}`)] as Json[]) {
      expect((await edit.call(req({ path: 'src/report.js', content: REPORT, removeExports: bad }), ctx)).error?.message).toMatch(/removeExports must be an array/);
    }
    expect((await edit.call(req('src/report.js', REPORT, { other: true }), ctx)).error?.message).toMatch(/options may only hold removeExports/);
    expect(await text('src/report.js')).toBe(REPORT);
  });

  it('the input schema declares removeExports on both forms', () => {
    const forms = (raw.schema as { oneOf: Array<{ properties: Record<string, unknown> }> }).oneOf;
    for (const f of forms) expect(f.properties.removeExports).toMatchObject({ type: 'array', items: { type: 'string' } });
  });
});

describe('edit refuses removing top-level declarations unless declared (removeNames; removeExports means the same)', () => {
  const SIGNUP = [
    '// signup(user, deps) registers a user and returns its record.',
    'const users = [];',
    'let nextId = 1;',
    'function validEmail(s) { return /^[^@\\s]+@[^@\\s]+$/.test(s); }',
    '',
    'export async function signup(user, deps = {}) {',
    "  if (!user || !validEmail(user.email)) throw new Error('a valid email is required');",
    "  const record = { id: nextId++, email: user.email, name: user.name ?? '' };",
    '  users.push(record);',
    "  await deps.mailer?.send({ to: user.email, subject: 'Welcome', text: 'hi' });",
    '  return record;',
    '}',
    '',
  ].join('\n');
  beforeEach(async () => writeFile(join(root, 'src/signup.js'), SIGNUP));

  it('a rewrite that keeps the export but drops the store, the counter and a helper behind it is refused, naming them; nothing changes', async () => {
    const rewrite = "export async function signup(user, deps = {}) {\n  if (!user || typeof user.email !== 'string') throw new Error('a valid email is required');\n  await deps.mailer.send({ to: user.email, subject: 'Welcome', text: 'hi' });\n  return { email: user.email };\n}\n";
    const r = await edit.call(req('src/signup.js', rewrite), ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/removes top-level name\(s\) "nextId", "users", "validEmail" that the module's own code or other code may use/);
    expect(r.error?.message).toMatch(/removeNames: \[names\] \(removeExports means the same\)/);
    expect(await text('src/signup.js')).toBe(SIGNUP);
    // the same rewrite as a whole-file oldText/newText replacement is checked on the result too
    const asReplace = await edit.call(req({ path: 'src/signup.js', oldText: SIGNUP, newText: rewrite }), ctx);
    expect(asReplace.error?.message).toMatch(/"users"/);
    expect(await text('src/signup.js')).toBe(SIGNUP);
  });

  it('a targeted edit that keeps every top-level name passes; a rename of a module-level helper is refused until declared', async () => {
    const ok = await edit.call(req({ path: 'src/signup.js', oldText: "  users.push(record);\n", newText: "  users.push(record);\n  if (!deps.mailer) throw new Error('no mailer');\n" }), ctx);
    expect(ok.ok, ok.error?.message).toBe(true);
    expect(ok.value).toMatchObject({ mode: 'replace', syntax: 'parsed' });
    expect(ok.value).not.toHaveProperty('removedNames');
    const renamed = await edit.call(req({ path: 'src/signup.js', oldText: 'function validEmail(', newText: 'function isEmail(' }), ctx);
    expect(renamed.error?.message).toMatch(/removes top-level name\(s\) "validEmail"/);
    const declared = await edit.call(req({ path: 'src/signup.js', oldText: 'function validEmail(', newText: 'function isEmail(', removeNames: ['validEmail'] }), ctx);
    expect(declared.ok, declared.error?.message).toBe(true);
    expect(declared.value).toMatchObject({ removeNames: ['validEmail'], removedNames: ['validEmail'] });
    expect(declared.value).not.toHaveProperty('removedExports');
    // a binding inside a function is not top-level: it may go
    const inner = await edit.call(req({ path: 'src/signup.js', oldText: "  const record = { id: nextId++, email: user.email, name: user.name ?? '' };\n  users.push(record);\n  if (!deps.mailer) throw new Error('no mailer');\n", newText: "  users.push({ id: nextId++, email: user.email, name: user.name ?? '' });\n" }), ctx);
    expect(inner.ok, inner.error?.message).toBe(true);
  });

  it('dropping an exported and a module-level name together names both and says which is exported; removeExports declares either', async () => {
    const both = 'const users = [];\nlet nextId = 1;\n';
    const r = await edit.call(req('src/signup.js', both), ctx);
    expect(r.error?.message).toMatch(/removes top-level name\(s\) \(exported: "signup"\) "signup", "validEmail" that/);
    const partial = await edit.call(req('src/signup.js', 'export async function signup() {}\n', { removeExports: ['users', 'nextId'] }), ctx);
    expect(partial.error?.message).toMatch(/removes top-level name\(s\) "validEmail"/);
    const w = await edit.call(req('src/signup.js', 'export async function signup() {}\n', { removeExports: ['users', 'nextId', 'validEmail'] }), ctx);
    expect(w.ok, w.error?.message).toBe(true);
    expect(w.value).toMatchObject({ removeNames: ['users', 'nextId', 'validEmail'], removedNames: ['nextId', 'users', 'validEmail'], removeExports: ['users', 'nextId', 'validEmail'], removedExports: [] });
    expect((await edit.call(req('src/signup.js', 'export const x = 1;\n', { removeNames: ['signup'], removeExports: ['y'] }), ctx)).value).toMatchObject({ removeNames: ['signup', 'y'], removedNames: ['signup'], removedExports: ['signup'] });
  });

  it('TypeScript declarations are top-level names too; removeNames must be a list of names', async () => {
    await writeFile(join(root, 'src/types.ts'), 'interface Row { a: number }\ntype Id = string;\nconst MAX = 3;\nexport function f(r: Row, id: Id): number { return r.a + MAX + id.length; }\n');
    const r = await edit.call(req('src/types.ts', 'export function f(r: { a: number }, id: string): number { return r.a + 3 + id.length; }\n'), ctx);
    expect(r.error?.message).toMatch(/"Id", "MAX", "Row"/);
    for (const bad of ['users', [1], [''], Array.from({ length: 201 }, (_, i) => `n${i}`)] as Json[]) {
      expect((await edit.call(req({ path: 'src/signup.js', content: SIGNUP, removeNames: bad }), ctx)).error?.message).toMatch(/removeNames must be an array/);
    }
    expect((await edit.call(req('src/signup.js', SIGNUP, { removeNames: ['a'], other: 1 }), ctx)).error?.message).toMatch(/options may only hold removeExports or removeNames/);
  });
});

describe('the stale-read check', () => {
  it('an existing file the step never read, or that changed since it read it, cannot be edited; one read as it is now can; a new file needs no read', async () => {
    const seen = new Map<string, string>();
    const known = { ...ctx, knownDigest: (rel: string) => seen.get(rel) };
    const unread = await edit.call(req({ path: 'src/report.js', oldText: 'return rows.length;', newText: 'return rows.length + 0;' }), known);
    expect(unread.ok).toBe(false);
    expect(unread.error?.message).toMatch(/src\/report\.js was not read by this step; read it before editing it/);
    expect((await edit.call(req('src/report.js', REPORT + '// whole\n'), known)).error?.message).toMatch(/was not read by this step/);
    seen.set('src/report.js', 'sha256:not-what-is-there');
    const stale = await edit.call(req({ path: 'src/report.js', oldText: 'return rows.length;', newText: 'return rows.length + 0;' }), known);
    expect(stale.ok).toBe(false);
    expect(stale.error?.message).toMatch(/src\/report\.js changed since this step last read or wrote it; read it again/);
    expect(await text('src/report.js')).toBe(REPORT);
    const { sha256 } = await import('@tecera/contracts');
    seen.set('src/report.js', sha256(REPORT));
    expect((await edit.call(req({ path: 'src/report.js', oldText: 'return rows.length;', newText: 'return rows.length + 0;' }), known)).ok).toBe(true);
    // the record moves with the step's own writes (the broker keeps it); a stale record is refused again
    expect((await edit.call(req({ path: 'src/report.js', oldText: 'rows.length + 0', newText: 'rows.length + 1' }), known)).error?.message).toMatch(/changed since/);
    seen.set('src/report.js', sha256(await text('src/report.js')));
    expect((await edit.call(req({ path: 'src/report.js', oldText: 'rows.length + 0', newText: 'rows.length + 1' }), known)).ok).toBe(true);
    // a context without a record has seen nothing
    expect((await edit.call(req({ path: 'src/report.js', oldText: 'rows.length + 1', newText: 'rows.length + 2' }), { ...ctx, knownDigest: undefined })).error?.message).toMatch(/was not read by this step/);
    // a new file has nothing to be stale against
    expect((await edit.call(req('src/new.js', 'export const n = 1;\n'), known)).ok).toBe(true);
  });
});

describe('exports and declarations are compared independently', () => {
  it('an export demoted to a local declaration is refused (the binding stays, the interface goes); a local promoted to an export passes', async () => {
    await writeFile(join(root, 'src/demote.js'), 'export function f() {}\nfunction g() {}\n');
    const demoted = await edit.call(req('src/demote.js', 'function f() {}\nfunction g() {}\n'), ctx);
    expect(demoted.ok).toBe(false);
    expect(demoted.error?.message).toMatch(/removes exported name\(s\) "f" that the module's own code or other code may use \("f" still declared, but no longer exported\)/);
    expect(await text('src/demote.js')).toBe('export function f() {}\nfunction g() {}\n');
    expect(await checkEdit({ rel: 'src/demote.js', before: 'export function f() {}\n', after: 'function f() {}\n', mode: 'write', removeNames: [] }).catch((e: Error) => e.message)).toMatch(/"f"/);
    const declared = await checkEdit({ rel: 'src/demote.js', before: 'export function f() {}\n', after: 'function f() {}\n', mode: 'write', removeNames: ['f'] });
    expect(declared).toEqual({ syntax: 'parsed', removedNames: [], removedExports: ['f'] });
    const promoted = await edit.call(req('src/demote.js', 'export function f() {}\nexport function g() {}\n'), ctx);
    expect(promoted.ok, promoted.error?.message).toBe(true);
    expect(promoted.value).not.toHaveProperty('removedNames');
    // CommonJS: a name dropped from module.exports but kept as a function is a lost export too
    await writeFile(join(root, 'src/both.cjs'), 'function a() {}\nfunction b() {}\nmodule.exports = { a, b };\n');
    const cjs = await edit.call(req('src/both.cjs', 'function a() {}\nfunction b() {}\nmodule.exports = { a };\n'), ctx);
    expect(cjs.error?.message).toMatch(/removes exported name\(s\) "b" .*\("b" still declared, but no longer exported\)/);
  });

  it('a declaration without a semicolon does not hide the CommonJS exports after it, nor the ones inside its initializer', async () => {
    expect(exportedNames('const x = 1\nmodule.exports = { f() {} };')).toEqual(['f', 'module.exports']);
    expect(exportedNames('const x = 1\nexports.g = () => 1\nlet y = 2\nObject.defineProperty(exports, "h", { value: 1 })')).toEqual(['g', 'h']);
    expect(exportedNames('const y = exports.z = 1\nlet w = (module.exports.q = 2)')).toEqual(['q', 'z']);
    expect(declaredNames('const x = 1\nmodule.exports = { f() {} };')).toEqual(['f', 'module.exports', 'x']);
    // a line break that cannot end the statement keeps the initializer going
    expect(declaredNames('const t = a\n  .b()\nconst u = 1 +\n  2\nconst v = fn\n(3)\nfunction k() {}')).toEqual(['k', 't', 'u', 'v']);
    expect(exportedNames('const t = x as\n  Foo\nmodule.exports = 1')).toContain('module.exports');
    const before = 'const x = 1\nmodule.exports = { f() {} };\n';
    await expect(checkEdit({ rel: 'src/m.cjs', before, after: 'const x = 1;\n', mode: 'write', removeNames: [] })).rejects.toThrow(/"f", "module\.exports"/);
    await expect(checkEdit({ rel: 'src/m.cjs', before: 'const y = exports.z = 1\n', after: 'const y = 1\n', mode: 'write', removeNames: [] })).rejects.toThrow(/"z"/);
  });
});

describe('declaredNames (static analysis)', () => {
  it('lists exports and the top-level bindings, functions, classes and TS declarations, never nested or exported-twice ones', () => {
    const src = [
      "import { x } from './x';",
      'const a = 1, { b, c: d } = o;',
      'let e;',
      'var f = 2;',
      'async function g() { const inner = 1; function h() {} }',
      'function* k() {}',
      'class C {}',
      'export const m = 1;',
      'export default class D {}',
      'if (f) { const notTop = 1; }',
      'for (const i of []) {}',
      'declare const z: number;',
      'interface I {}',
      'type T = { a: 1 };',
      'enum E { A }',
      'const enum F { B }',
      'namespace N {}',
      'abstract class Q {}',
      'type = 1;',
    ].join('\n');
    expect(declaredNames(src)).toEqual(['C', 'E', 'F', 'I', 'N', 'Q', 'T', 'a', 'b', 'd', 'default', 'e', 'f', 'g', 'k', 'm', 'z']);
    expect(exportedNames(src)).toEqual(['default', 'm']);
    expect(declaredNames("const s = 1;\nmodule.exports = { s };\nexports.t = 2;")).toEqual(['module.exports', 's', 't']);
  });
});

describe('the existing refusals come first and are unchanged', () => {
  it('protected paths, the write allowlist, a missing lease and quarantine refuse before any content check', async () => {
    const broken = 'function (';
    expect((await edit.call(req('src/a.test.js', broken), ctx)).error?.message).toMatch(/protected/);
    expect((await edit.call(req('lib/x.js', broken), ctx)).error?.message).toMatch(/write allowlist/);
    const { fencingToken: _f, ...noLease } = ctx;
    expect((await edit.call(req('src/report.js', broken), noLease)).error?.message).toMatch(/fencing token/);
    markWorktreeTainted(root, 'test');
    expect((await edit.call(req('src/report.js', REPORT), ctx)).error?.message).toMatch(/quarantined/);
  });

  it('a refused check leaves no temporary file behind', async () => {
    await edit.call(req('src/report.js', 'export const = ;'), ctx);
    expect((await readdir(join(root, 'src'))).filter((n) => n.startsWith('.tecera-tmp-'))).toEqual([]);
  });
});

describe('exportedNames (static analysis)', () => {
  it('finds declarations, lists, defaults, re-exports and TS declarations', () => {
    expect(exportedNames('export const a = 1, b = f(1, 2), {c, d: e, ...g} = o, [h, , i = 3] = arr;\nexport let j: Map<string, number> = new Map(), k = 2;')).toEqual(['a', 'b', 'c', 'e', 'g', 'h', 'i', 'j', 'k']);
    expect(exportedNames('export function f() {}\nexport async function g() {}\nexport function* h() {}\nexport class C {}\nexport default function () {}')).toEqual(['C', 'default', 'f', 'g', 'h']);
    expect(exportedNames("export { a, b as c, d as default } from './x';\nexport * from './y';\nexport * as ns from './z';\nexport type { U };")).toEqual(["* from './y'", 'U', 'a', 'c', 'default', 'ns']);
    expect(exportedNames('export interface I {}\nexport type T = { a: 1 };\nexport enum E { A }\nexport const enum F { B }\nexport declare const z: number;\nexport abstract class Q {}\nexport namespace N {}')).toEqual(['E', 'F', 'I', 'N', 'Q', 'T', 'z']);
    expect(exportedNames('import x = require("y");\nexport = x;')).toEqual(['export=']);
  });
  it('finds CommonJS exports', () => {
    const cjs = "module.exports = { a, b: 1, c() {}, 'd': 2, async e() {}, get f() { return 1; }, ...g };\nexports.h = 1; module.exports.i = 2; exports['j'] = 3;\nObject.defineProperty(exports, 'k', {});\nif (x) { exports.l = 1; }\na.exports.m = 1; exports.n == 2;";
    expect(exportedNames(cjs)).toEqual(['...g', 'a', 'b', 'c', 'd', 'e', 'f', 'h', 'i', 'j', 'k', 'l', 'module.exports']);
    expect(exportedNames('module.exports = factory();')).toEqual(['module.exports']);
  });
  it('ignores strings, comments, templates, regex literals and nested scopes', () => {
    const src = [
      "const s = `${'export const no1 = 1'} ${ { a: 1 }.a } export const no2`;",
      '// export const no3 = 1',
      '/* export const no4 = 1 */',
      "const q = 'export const no5'; const r = /export const no6/g; const d = a / b / 2;",
      'function f() { const exports = {}; return { export: 1 }; }',
      'export const yes = 1;',
    ].join('\n');
    expect(exportedNames(src)).toEqual(['yes']);
  });
});

describe('codeKindOf and syntaxProblem', () => {
  it('classifies by extension; JSX is not checked', () => {
    expect(['a.js', 'a.MJS', 'a.cjs', 'a.ts', 'a.mts', 'a.cts', 'a.d.ts', 'a.jsx', 'a.tsx', 'a.json', 'a'].map(codeKindOf)).toEqual(['js', 'esm', 'cjs', 'ts', 'ts', 'cts', 'ts', null, null, null, null]);
  });
  it('a .js file parses under either goal; the reported error follows the goal it is written for', async () => {
    expect(await syntaxProblem('js', 'return 1;\n', 'x.js')).toBeNull();
    expect(await syntaxProblem('js', 'export const a = await 1;\n', 'x.js')).toBeNull();
    expect(await syntaxProblem('js', 'import a from "a";\nconst b = ;\n', 'x.js')).toMatchObject({ line: 2 });
    expect(await syntaxProblem('js', 'const a = 1;\n\nconst b = ;\n', 'x.js')).toMatchObject({ line: 3, message: "SyntaxError: Unexpected token ';'" });
  });
});

describe('the worker is told about the checks', () => {
  it('the edit tool documentation names the checks, removeNames (and removeExports as the same) and the preference for targeted edits', () => {
    expect(STANDARD_STUBS.edit!.description).toBe(EDIT_DESCRIPTION);
    expect(EDIT_DESCRIPTION).toMatch(/does not parse is refused/);
    expect(EDIT_DESCRIPTION).toMatch(/removeNames/);
    expect(EDIT_DESCRIPTION).toMatch(/removeExports is accepted as the same/);
    expect(EDIT_DESCRIPTION).toMatch(/top-level name of an existing module/);
    expect(EDIT_DESCRIPTION).toMatch(/Prefer targeted \{path, oldText, newText\} edits/);
    expect(STANDARD_STUBS.edit!.signature).toContain('removeNames');
  });
});
