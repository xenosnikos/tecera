import { renameSync, linkSync } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeRedactor, type CapabilitySet, type Json, type ToolContext, type ToolRequest, type VerifyOutcome, type VerifyRequest, type VerifyRunner } from '@tecera/contracts';
import type { WorkerToolContext } from './common.js';
import { createEditTool as rawEditTool, type EditToolOptions } from './edit.js';
import { createListFilesTool } from './listFiles.js';
import { fdVerificationSupported, withWorktreeLock, worktreeTaint } from './paths.js';
import { createReadTool } from './read.js';
import { createRunVerifyTool as rawRunVerifyTool, type RunVerifyOptions } from './runVerify.js';
import { liveWriteGuard } from '../invoke/fakes.js';
import type { AuthorizingTool } from './common.js';

/** Write-class tools get a live step guard unless a test passes its own (Tool.call's third argument). */
const G = liveWriteGuard();
const guarded = (t: AuthorizingTool): AuthorizingTool => ({ ...t, call: (r, c, g) => t.call(r, c, g ?? G) });
const createEditTool = (o?: EditToolOptions): AuthorizingTool => guarded(rawEditTool(o));
const createRunVerifyTool = (o: RunVerifyOptions): AuthorizingTool => guarded(rawRunVerifyTool(o));

/**
 * tamper.symlink_hardlink after descriptor validation (Codex sprint-2 invoke New finding 1 / Missing tests):
 * every race below happens AFTER the path was authorized and the descriptors were opened and verified.
 */

const caps = (): CapabilitySet => ({
  tools: ['read', 'edit', 'listFiles', 'runVerify'],
  paths: { read: ['**'], write: ['src/**'], protected: ['test/**'] },
  network: 'none',
  limits: { usd: 1, tokens: 1000, calls: 10, wallMs: 1000, depth: 2, iterations: 5 },
});
const req = (...args: Json[]): ToolRequest => ({ callId: 'c1', tool: 't', method: 'call', args, idemKey: 'k' });
const PROTECTED = 'it("protected", () => {});\n';

let root: string;
let ctx: ToolContext;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tecera-race-'));
  await mkdir(join(root, 'src/d'), { recursive: true });
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'src/d/f.ts'), 'export const f = 1;\n');
  await writeFile(join(root, 'test/p.test.ts'), PROTECTED);
  ctx = { runId: 'r1', worktree: root, capabilities: caps(), fencingToken: 7 };
});
afterEach(async () => rm(root, { recursive: true, force: true }));

describe.skipIf(!fdVerificationSupported())('writes after descriptor validation (open-then-verify, temp-file commit)', () => {
  it('the target moved into a protected location while its content was being read: refused, the protected copy is untouched (Codex probe)', async () => {
    const racing = createEditTool({ afterRead: async () => rename(join(root, 'src/a.ts'), join(root, 'test/a.ts')) });
    const r = await racing.call(req({ path: 'src/a.ts', oldText: 'a = 1', newText: 'a = 2' }), ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/moved|vanished|refused/);
    expect(await readFile(join(root, 'test/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    await expect(stat(join(root, 'src/a.ts'))).rejects.toThrow();
    expect(worktreeTaint(root)).toBeNull();
  });

  it('a hardlink into a protected path added after the descriptor checks: refused, nothing written through it', async () => {
    const racing = createEditTool({ afterRead: async () => link(join(root, 'src/a.ts'), join(root, 'test/hl.test.ts')) });
    const r = await racing.call(req('src/a.ts', 'pwned'), ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/hardlink/);
    expect(await readFile(join(root, 'test/hl.test.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  it('a hardlink added inside the synchronous commit window never carries the write: the original inode is never mutated', async () => {
    const racing = createEditTool({ beforeCommit: () => linkSync(join(root, 'src/a.ts'), join(root, 'test/late.test.ts')) });
    const r = await racing.call(req('src/a.ts', 'new content'), ctx);
    expect(r.ok).toBe(true);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('new content');
    // the protected link still points at the OLD inode with the OLD bytes
    expect(await readFile(join(root, 'test/late.test.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  it('a parent directory replaced between authorization and open (inode changed) is refused; neither copy is written', async () => {
    const racing = createEditTool({
      beforeOpen: async () => {
        await rename(join(root, 'src/d'), join(root, 'src/d.old'));
        await mkdir(join(root, 'src/d'));
        await writeFile(join(root, 'src/d/f.ts'), 'decoy');
      },
    });
    const r = await racing.call(req('src/d/f.ts', 'pwned'), ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/inode changed|replaced/);
    expect(await readFile(join(root, 'src/d/f.ts'), 'utf8')).toBe('decoy');
    expect(await readFile(join(root, 'src/d.old/f.ts'), 'utf8')).toBe('export const f = 1;\n');
  });

  it('the parent directory moved into a protected location after the descriptors were verified: refused before commit', async () => {
    const racing = createEditTool({ afterRead: async () => rename(join(root, 'src/d'), join(root, 'test/d')) });
    const r = await racing.call(req('src/d/f.ts', 'pwned'), ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/refused before commit|moved/);
    expect(await readFile(join(root, 'test/d/f.ts'), 'utf8')).toBe('export const f = 1;\n');
    expect(worktreeTaint(root)).toBeNull();
  });

  it('a file that appears at a new path between authorization and commit is never overwritten', async () => {
    const racing = createEditTool({ afterRead: async () => writeFile(join(root, 'src/new.ts'), 'someone else') });
    const r = await racing.call(req('src/new.ts', 'mine'), ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/appeared/);
    expect(await readFile(join(root, 'src/new.ts'), 'utf8')).toBe('someone else');
  });

  it('a move inside the synchronous commit window is detected after the commit: TaintError, the worktree is quarantined and every later tool refuses', async () => {
    const racing = createEditTool({ beforeCommit: () => renameSync(join(root, 'src/d'), join(root, 'test/d')) });
    const r = await racing.call(req('src/d/f.ts', 'landed elsewhere'), ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.name).toBe('TaintError');
    expect(worktreeTaint(root)).toMatch(/post-commit verification failed/);
    // the commit was rolled back in the moved directory: the protected destination keeps its original bytes
    expect(await readFile(join(root, 'test/d/f.ts'), 'utf8')).toBe('export const f = 1;\n');
    // quarantine: no later read, write, listing or verification on this worktree
    expect((await createReadTool().call(req('src/a.ts'), ctx)).error?.message).toMatch(/quarantined/);
    expect((await createEditTool().call(req('src/a.ts', 'x'), ctx)).error?.message).toMatch(/quarantined/);
    expect((await createListFilesTool().call(req(), ctx)).error?.message).toMatch(/quarantined/);
    let ran = false;
    const runner: VerifyRunner = { run: async () => ((ran = true), { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', durationMs: 1, truncated: false }) };
    expect((await createRunVerifyTool({ runner, command: 'node --test', timeoutSec: 5 }).call(req(), ctx)).error?.message).toMatch(/quarantined/);
    expect(ran).toBe(false);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  it('a write cancelled through the exec signal changes nothing', async () => {
    const ac = new AbortController();
    const cancelling = createEditTool({ afterRead: async () => ac.abort() });
    const r = await cancelling.call(req('src/a.ts', 'cancelled'), { ...ctx, signal: ac.signal } as WorkerToolContext);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/cancelled/);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  it('the temp-file commit keeps the file mode and leaves no temp file behind', async () => {
    await chmod(join(root, 'src/a.ts'), 0o750);
    expect((await createEditTool().call(req('src/a.ts', 'y'), ctx)).ok).toBe(true);
    expect((await stat(join(root, 'src/a.ts'))).mode & 0o777).toBe(0o750);
    const failing = createEditTool({ afterRead: async () => rename(join(root, 'src/a.ts'), join(root, 'src/gone.ts')) });
    expect((await failing.call(req('src/a.ts', 'z'), ctx)).ok).toBe(false);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(join(root, 'src'))).filter((n) => n.startsWith('.tecera-tmp-'))).toEqual([]);
  });

  it('concurrent edits of one worktree are serialized by the worktree lock (no interleaving)', async () => {
    const edit = createEditTool();
    const results = await Promise.all([
      edit.call(req({ path: 'src/a.ts', oldText: 'a = 1', newText: 'a = 2' }), ctx),
      edit.call(req({ path: 'src/a.ts', oldText: 'a = 2', newText: 'a = 3' }), ctx),
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 3;\n');
  });

  it('a verification run holds the worktree lock: an edit issued during it waits until it ends', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runner: VerifyRunner = {
      run: async () => {
        order.push('verify:start');
        await gate;
        order.push('verify:end');
        return { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', durationMs: 1, truncated: false };
      },
    };
    const verify = createRunVerifyTool({ runner, command: 'node --test', timeoutSec: 5 }).call(req(), ctx);
    await new Promise((r) => setTimeout(r, 10));
    const editing = createEditTool()
      .call(req('src/a.ts', 'after verify'), ctx)
      .then((r) => (order.push('edit'), r));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['verify:start']);
    release();
    await Promise.all([verify, editing]);
    expect(order).toEqual(['verify:start', 'verify:end', 'edit']);
  });
});

describe('unsupported platforms and hardlinked reads', () => {
  it('without /proc/self/fd every write is refused (no path-based fallback)', async () => {
    const r = await createEditTool({ assumeNoProcFd: true }).call(req('src/a.ts', 'x'), ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/refused on this platform/);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  it('a hardlinked file is never read (it may alias a file outside the worktree)', async () => {
    await link(join(root, 'test/p.test.ts'), join(root, 'src/alias.ts'));
    const r = await createReadTool().call(req('src/alias.ts'), ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/hardlinked/);
  });

  it('withWorktreeLock refuses an unconfigured worktree', async () => {
    await expect(withWorktreeLock('', async () => 1)).rejects.toThrow(/no worktree/);
  });
});

describe('runVerify fail-closed (Codex sprint-2 invoke New finding 7)', () => {
  const ok = (over: Partial<VerifyOutcome> = {}): VerifyOutcome => ({ exitCode: 0, signal: null, timedOut: false, stdout: 'PASS', stderr: '', durationMs: 1, truncated: false, ...over });

  it('refuses without a lease fencing token (it runs repository scripts: write-class) and never starts the runner', async () => {
    let ran = false;
    const tool = createRunVerifyTool({ runner: { run: async () => ((ran = true), ok()) }, command: 'node --test', timeoutSec: 5 });
    const { fencingToken: _f, ...noLease } = ctx;
    const r = await tool.call(req(), noLease);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/fencing token/);
    await expect(tool.authorize(req(), noLease)).rejects.toThrow(/fencing token/);
    expect(ran).toBe(false);
  });

  it('truncated output never passes, even with exit code 0', async () => {
    for (const over of [{ truncated: true }, { stdoutTruncated: true }, { stderrTruncated: true }] as Partial<VerifyOutcome>[]) {
      const r = await createRunVerifyTool({ runner: { run: async () => ok(over) }, command: 'node --test', timeoutSec: 5 }).call(req(), ctx);
      expect(r.value).toMatchObject({ exitCode: 0, truncated: true, passed: false, why: expect.stringMatching(/truncated/) });
    }
  });

  it('cancellation is forwarded to the runner and a cancelled run never passes', async () => {
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const runner: VerifyRunner = {
      run: async (_r: VerifyRequest, signal?: AbortSignal) => {
        seen = signal;
        ac.abort();
        return ok({ cancelled: true });
      },
    };
    const r = await createRunVerifyTool({ runner, command: 'node --test', timeoutSec: 5 }).call(req(), { ...ctx, signal: ac.signal } as WorkerToolContext);
    // the runner gets the exec signal combined with the guard's: aborting the exec aborts what it sees
    expect(seen?.aborted).toBe(true);
    expect(r.value).toMatchObject({ cancelled: true, passed: false });
    const pre = new AbortController();
    pre.abort();
    let ran = false;
    const r2 = await createRunVerifyTool({ runner: { run: async () => ((ran = true), ok()) }, command: 'node --test', timeoutSec: 5 }).call(req(), { ...ctx, signal: pre.signal } as WorkerToolContext);
    expect(r2.ok).toBe(false);
    expect(ran).toBe(false);
  });

  it('an incomplete or malformed runner result never passes; a killed process never passes', async () => {
    const bad = await createRunVerifyTool({ runner: { run: async () => ({ exitCode: 0 }) as unknown as VerifyOutcome }, command: 'node --test', timeoutSec: 5 }).call(req(), ctx);
    expect(bad.value).toMatchObject({ complete: false, passed: false });
    const killed = await createRunVerifyTool({ runner: { run: async () => ok({ signal: 'SIGKILL' }) }, command: 'node --test', timeoutSec: 5 }).call(req(), ctx);
    expect(killed.value).toMatchObject({ passed: false });
  });

  it('redacts the complete output before taking the tail: an ordinary registered secret cut by the tail never survives', async () => {
    const SECRET = 'plain-ordinary-password-0042';
    const red = makeRedactor([SECRET]);
    for (const tailChars of [6, 12, 20, 27, 40]) {
      const runner: VerifyRunner = { run: async () => ok({ stdout: `${'x'.repeat(30)}${SECRET}`, stderr: `${SECRET}\nend` }) };
      const r = await createRunVerifyTool({ runner, command: 'node --test', timeoutSec: 5, maxTailChars: tailChars }).call(req(), { ...ctx, redactor: red } as WorkerToolContext);
      const text = JSON.stringify(r.value);
      for (let i = 0; i + 8 <= SECRET.length; i++) expect(text, `tail ${tailChars}`).not.toContain(SECRET.slice(i, i + 8));
      expect((r.value as { stdoutCut: number }).stdoutCut).toBeGreaterThan(0);
    }
  });
});
