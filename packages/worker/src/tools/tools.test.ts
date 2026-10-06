import { link, lstat, mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CapabilitySet, Json, ToolContext, ToolRequest, VerifyRequest, VerifyRunner } from '@tecera/contracts';
import { createEditTool as rawEditTool, type EditToolOptions } from './edit.js';
import { createListFilesTool } from './listFiles.js';
import { createReadTool } from './read.js';
import { createRunVerifyTool as rawRunVerifyTool, type RunVerifyOptions } from './runVerify.js';
import { liveWriteGuard } from '../invoke/fakes.js';
import type { AuthorizingTool } from './common.js';

/** Write-class tools get a live step guard unless a test passes its own (Tool.call's third argument). */
const G = liveWriteGuard();
const guarded = (t: AuthorizingTool): AuthorizingTool => ({ ...t, call: (r, c, g) => t.call(r, c, g ?? G) });
const createEditTool = (o?: EditToolOptions): AuthorizingTool => guarded(rawEditTool(o));
const createRunVerifyTool = (o: RunVerifyOptions): AuthorizingTool => guarded(rawRunVerifyTool(o));

const caps = (over: Partial<CapabilitySet['paths']> = {}): CapabilitySet => ({
  tools: ['read', 'edit', 'listFiles', 'runVerify'],
  paths: { read: ['**'], write: ['src/**'], protected: ['test/**', '**/*.test.ts'], ...over },
  network: 'none',
  limits: { usd: 1, tokens: 1000, calls: 10, wallMs: 1000, depth: 2, iterations: 5 },
});
const req = (...args: Json[]): ToolRequest => ({ callId: 'c1', tool: 't', method: 'call', args, idemKey: 'k' });

let root: string;
let outside: string;
let ctx: ToolContext;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tecera-tools-'));
  outside = await mkdtemp(join(tmpdir(), 'tecera-outside-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'test'), { recursive: true });
  await mkdir(join(root, 'node_modules/pkg'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(root, '.tecera'), { recursive: true });
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\nexport const b = 1;\n');
  await writeFile(join(root, 'test/a.test.ts'), 'it("x", () => {});\n');
  await writeFile(join(root, 'node_modules/pkg/index.js'), '');
  await writeFile(join(root, '.git/HEAD'), 'ref');
  await writeFile(join(root, '.tecera/x.json'), '{}');
  await writeFile(join(outside, 'secret.txt'), 'TOP SECRET');
  ctx = { runId: 'r1', worktree: root, capabilities: caps(), fencingToken: 7 };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('read', () => {
  const read = createReadTool();
  it('reads a file as untrusted content', async () => {
    const r = await read.call(req('src/a.ts'), ctx);
    expect(r.ok).toBe(true);
    expect((r.value as { content: string }).content).toContain('export const a');
    expect(r.provenance).toMatchObject({ src: 'tool:read', trust: 'untrusted', path: 'src/a.ts' });
  });
  it('refuses ../, absolute paths outside and symlink escapes', async () => {
    expect((await read.call(req('../etc/passwd'), ctx)).error?.message).toMatch(/traversal/);
    expect((await read.call(req('src/../../x'), ctx)).error?.message).toMatch(/traversal/);
    expect((await read.call(req(join(outside, 'secret.txt')), ctx)).error?.message).toMatch(/outside the worktree/);
    await symlink(join(outside, 'secret.txt'), join(root, 'src/link.txt'));
    const r = await read.call(req('src/link.txt'), ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/symlink escape/);
    await symlink(outside, join(root, 'src/dirlink'));
    expect((await read.call(req('src/dirlink/secret.txt'), ctx)).error?.message).toMatch(/symlink escape/);
  });
  it('enforces the read allowlist and size cap', async () => {
    expect((await read.call(req('src/a.ts'), { ...ctx, capabilities: caps({ read: [] }) })).error?.message).toMatch(/read allowlist/);
    await writeFile(join(root, 'src/big.txt'), 'z'.repeat(2000));
    expect((await createReadTool({ maxBytes: 100 }).call(req('src/big.txt'), ctx)).error?.message).toMatch(/too large/);
  });
});

describe('edit', () => {
  const edit = createEditTool();
  it('replaces exactly one occurrence', async () => {
    const r = await edit.call(req({ path: 'src/a.ts', oldText: 'const a = 1', newText: 'const a = 2' }), ctx);
    expect(r.ok).toBe(true);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toContain('const a = 2');
    const many = await edit.call(req({ path: 'src/a.ts', oldText: '= 1', newText: '= 3' }), ctx);
    expect(many.ok).toBe(true); // only one "= 1" left
    const none = await edit.call(req({ path: 'src/a.ts', oldText: 'nope', newText: 'x' }), ctx);
    expect(none.error?.message).toMatch(/exactly once.*found 0/);
    await writeFile(join(root, 'src/d.ts'), 'x x');
    expect((await edit.call(req({ path: 'src/d.ts', oldText: 'x', newText: 'y' }), ctx)).error?.message).toMatch(/found 2/);
    expect(await readFile(join(root, 'src/d.ts'), 'utf8')).toBe('x x');
  });
  it('writes whole files (writeFile(path, content) form) and creates parents', async () => {
    const r = await edit.call(req('src/new/b.ts', 'export {}'), ctx);
    expect(r.ok).toBe(true);
    expect((r.value as { created: boolean }).created).toBe(true);
    expect(await readFile(join(root, 'src/new/b.ts'), 'utf8')).toBe('export {}');
  });
  it('refuses without a fencing token', async () => {
    const { fencingToken: _f, ...noToken } = ctx;
    const r = await edit.call(req('src/a.ts', 'x'), noToken);
    expect(r.error?.message).toMatch(/fencing token/);
  });
  it('refuses paths outside the write globs, protected paths, .git/.tecera, and symlinks', async () => {
    expect((await edit.call(req('README.md', 'x'), ctx)).error?.message).toMatch(/write allowlist/);
    expect((await edit.call(req('test/a.test.ts', 'x'), ctx)).error?.message).toMatch(/protected/);
    expect((await edit.call(req('src/x.test.ts', 'x'), ctx)).error?.message).toMatch(/protected/);
    expect((await edit.call(req('.git/HEAD', 'x'), { ...ctx, capabilities: caps({ write: ['**'] }) })).error?.message).toMatch(/never allowed/);
    expect((await edit.call(req('../escape.ts', 'x'), ctx)).error?.message).toMatch(/traversal/);
    await symlink(join(outside, 'secret.txt'), join(root, 'src/link.ts'));
    expect((await edit.call(req('src/link.ts', 'pwned'), ctx)).error?.message).toMatch(/symlink/);
    await symlink(outside, join(root, 'src/out'));
    expect((await edit.call(req('src/out/new.ts', 'pwned'), ctx)).error?.message).toMatch(/symlink/);
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('TOP SECRET');
  });
});

describe('tamper.symlink_hardlink', () => {
  const edit = createEditTool();
  const read = createReadTool();

  it('refuses a new file written through an in-worktree directory symlink into a protected path', async () => {
    await symlink(join(root, 'test'), join(root, 'src/link'));
    for (const p of ['src/link/new.test.ts', 'src/link/innocent.ts']) {
      const r = await edit.call(req(p, 'pwned'), ctx);
      expect(r.ok, p).toBe(false);
      expect(r.error?.message, p).toMatch(/symlink/);
    }
    await expect(stat(join(root, 'test/new.test.ts'))).rejects.toThrow();
    await expect(stat(join(root, 'test/innocent.ts'))).rejects.toThrow();
    // replace form too
    expect((await edit.call(req({ path: 'src/link/a.test.ts', oldText: 'it', newText: 'xx' }), ctx)).ok).toBe(false);
    expect(await readFile(join(root, 'test/a.test.ts'), 'utf8')).toBe('it("x", () => {});\n');
  });

  it('refuses .git and .tecera aliases (symlinked directory, case variants)', async () => {
    const wide = { ...ctx, capabilities: caps({ write: ['**'], protected: [] }) };
    await symlink(join(root, '.git'), join(root, 'src/g'));
    expect((await edit.call(req('src/g/hooks/pre-commit', '#!/bin/sh\nexit 0'), wide)).error?.message).toMatch(/symlink/);
    await expect(stat(join(root, '.git/hooks/pre-commit'))).rejects.toThrow();
    for (const p of ['.GIT/config', '.Git/HEAD', '.TECERA/x.json', './.git/HEAD']) expect((await edit.call(req(p, 'x'), wide)).error?.message, p).toMatch(/never allowed/);
    expect(await readFile(join(root, '.git/HEAD'), 'utf8')).toBe('ref');
  });

  it('matches protected globs case-insensitively on the resolved path', async () => {
    const r = await edit.call(req('TEST/a.test.ts', 'x'), { ...ctx, capabilities: caps({ write: ['**'] }) });
    expect(r.error?.message).toMatch(/protected/);
    expect((await edit.call(req('src/A.TEST.TS', 'x'), ctx)).error?.message).toMatch(/protected/);
  });

  it('refuses to write a hardlinked file (a write would land in the protected target)', async () => {
    await link(join(root, 'test/a.test.ts'), join(root, 'src/h.ts'));
    const whole = await edit.call(req('src/h.ts', 'pwned'), ctx);
    expect(whole.error?.message).toMatch(/hardlink/);
    const rep = await edit.call(req({ path: 'src/h.ts', oldText: 'it', newText: 'xx' }), ctx);
    expect(rep.error?.message).toMatch(/hardlink/);
    expect(await readFile(join(root, 'test/a.test.ts'), 'utf8')).toBe('it("x", () => {});\n');
  });

  it('a directory swapped for a symlink after the check (replacement race) is refused and nothing escapes', async () => {
    await mkdir(join(root, 'src/dir'), { recursive: true });
    const racing = createEditTool({
      beforeOpen: async () => {
        await rename(join(root, 'src/dir'), join(root, 'src/dir.bak'));
        await symlink(outside, join(root, 'src/dir'));
      },
    });
    const r = await racing.call(req('src/dir/new.ts', 'pwned'), ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/symlink|moved|changed/);
    await expect(stat(join(outside, 'new.ts'))).rejects.toThrow();
    // existing-file form: file replaced by a symlink to outside after the check
    await writeFile(join(root, 'src/victim.ts'), 'v');
    const racing2 = createEditTool({
      beforeOpen: async () => {
        await rm(join(root, 'src/victim.ts'));
        await symlink(join(outside, 'secret.txt'), join(root, 'src/victim.ts'));
      },
    });
    const r2 = await racing2.call(req('src/victim.ts', 'pwned'), ctx);
    expect(r2.ok).toBe(false);
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('TOP SECRET');
  });

  it('a directory moved out of the worktree after the check never receives the write', async () => {
    await mkdir(join(root, 'src/mv'), { recursive: true });
    const moving = createEditTool({ beforeOpen: async () => rename(join(root, 'src/mv'), join(outside, 'mv')) });
    await moving.call(req('src/mv/new.ts', 'payload'), ctx);
    await expect(stat(join(outside, 'mv/new.ts'))).rejects.toThrow();
  });

  it('reads through an in-worktree symlink only when the resolved path is readable too', async () => {
    await mkdir(join(root, 'secret'), { recursive: true });
    await writeFile(join(root, 'secret/key.txt'), 'k');
    await symlink(join(root, 'secret/key.txt'), join(root, 'src/l.txt'));
    const narrow = { ...ctx, capabilities: caps({ read: ['src/**'] }) };
    expect((await read.call(req('src/l.txt'), narrow)).error?.message).toMatch(/secret\/key.txt is outside the read allowlist/);
    expect((await read.call(req('src/l.txt'), ctx)).ok).toBe(true);
  });

  it('refuses every file and verify tool when the worktree is not configured', async () => {
    const none = { ...ctx, worktree: '' };
    expect((await read.call(req('src/a.ts'), none)).error?.message).toMatch(/no worktree/);
    expect((await edit.call(req('src/a.ts', 'x'), none)).error?.message).toMatch(/no worktree/);
    expect((await createListFilesTool().call(req(), none)).error?.message).toMatch(/no worktree/);
    const runner: VerifyRunner = { run: async () => ({ exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', durationMs: 1, truncated: false }) };
    expect((await createRunVerifyTool({ runner, command: 'node --test', timeoutSec: 5 }).call(req(), none)).error?.message).toMatch(/no worktree/);
  });

  it('authorize() re-checks a request without performing it', async () => {
    await expect(edit.authorize(req('src/a.ts', 'x'), ctx)).resolves.toBeUndefined();
    await expect(edit.authorize(req('test/a.test.ts', 'x'), ctx)).rejects.toThrow(/protected/);
    await expect(read.authorize(req('src/a.ts'), { ...ctx, capabilities: caps({ read: ['docs/**'] }) })).rejects.toThrow(/read allowlist/);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toContain('export const a = 1');
  });
});

describe('listFiles', () => {
  const list = createListFilesTool();
  it('ignores node_modules, .git and .tecera, and filters by prefix or glob', async () => {
    const all = (await list.call(req(), ctx)).value as { files: string[] };
    expect(all.files).toEqual(['src/a.ts', 'test/a.test.ts']);
    expect(((await list.call(req('src/'), ctx)).value as { files: string[] }).files).toEqual(['src/a.ts']);
    expect(((await list.call(req({ glob: '**/*.test.ts' }), ctx)).value as { files: string[] }).files).toEqual(['test/a.test.ts']);
    expect((await list.call(req('../'), ctx)).ok).toBe(false);
  });
  it('does not follow symlinks and honours limits', async () => {
    await symlink(outside, join(root, 'src/out'));
    expect(((await list.call(req(), ctx)).value as { files: string[] }).files).not.toContain('src/out/secret.txt');
    const r = (await createListFilesTool({ maxEntries: 1 }).call(req(), ctx)).value as { files: string[]; truncated: boolean };
    expect(r).toEqual({ files: ['src/a.ts'], truncated: true });
  });
});

describe('runVerify', () => {
  it('delegates to the VerifyRunner with cwd = worktree and a fixed command', async () => {
    const calls: VerifyRequest[] = [];
    const runner: VerifyRunner = { run: async (r) => (calls.push(r), { exitCode: 1, signal: null, timedOut: false, stdout: 'FAIL', stderr: '', durationMs: 5, truncated: false }) };
    const tool = createRunVerifyTool({ runner, command: 'node --test', timeoutSec: 30 });
    const r = await tool.call(req('rm -rf /'), ctx);
    expect(calls).toEqual([{ cwd: root, command: 'node --test', timeoutSec: 30, envAllowlist: ['PATH', 'HOME', 'CI'] }]);
    expect(r.value).toMatchObject({ exitCode: 1, passed: false, stdout: 'FAIL' });
    expect(r.provenance.trust).toBe('untrusted');
  });
});
