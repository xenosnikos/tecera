import { renameSync } from 'node:fs';
import { link, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256, type CapabilitySet, type Json, type ToolContext, type ToolRequest } from '@tecera/contracts';
import { FakeWriteGuard } from '../invoke/fakes.js';
import { createDeleteTool } from './delete.js';
import { createEditTool } from './edit.js';
import { createReadTool } from './read.js';
import { deletionDigest, fdVerificationSupported, markWorktreeTainted, worktreeTaint } from './paths.js';

/**
 * The delete tool: one file, bound to the content the worker read, under the same lock, path checks,
 * authorization, fencing and quarantine rules as edit.
 */

const caps = (over: Partial<CapabilitySet['paths']> = {}): CapabilitySet => ({
  tools: ['read', 'edit', 'delete'],
  paths: { read: ['**'], write: ['src/**', 'test/**'], protected: ['test/**', '**/*.test.ts'], ...over },
  network: 'none',
  limits: { usd: 1, tokens: 1000, calls: 10, wallMs: 1000, depth: 2, iterations: 5 },
});
const req = (...args: Json[]): ToolRequest => ({ callId: 'c1', tool: 'delete', method: 'call', args, idemKey: 'k' });
const EXTRA = 'export default { planted: true };\n';
const D = sha256(EXTRA);

let root: string;
let outside: string;
let ctx: ToolContext;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tecera-del-'));
  outside = await mkdtemp(join(tmpdir(), 'tecera-del-out-'));
  await mkdir(join(root, 'src/d'), { recursive: true });
  await mkdir(join(root, 'test'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'src/config.js'), EXTRA);
  await writeFile(join(root, 'src/d/f.ts'), EXTRA);
  await writeFile(join(root, 'test/a.test.ts'), EXTRA);
  await writeFile(join(root, '.git/HEAD'), EXTRA);
  await writeFile(join(outside, 'secret.txt'), EXTRA);
  ctx = { runId: 'r1', worktree: root, capabilities: caps(), fencingToken: 7 };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const exists = async (p: string): Promise<boolean> => stat(p).then(() => true, () => false);
const strays = async (dir: string): Promise<string[]> => (await readdir(dir)).filter((n) => n.startsWith('.tecera-'));
const del = createDeleteTool();

describe.skipIf(!fdVerificationSupported())('delete: a valid deletion', () => {
  it('removes the file the worker read, by the digest readFile returned; the result is untrusted and names the path; nothing else is touched', async () => {
    const g = new FakeWriteGuard();
    const seen = await createReadTool().call(req('src/config.js'), ctx);
    const digest = (seen.value as { digest: string }).digest;
    expect(digest).toBe(D);
    const r = await del.call(req('src/config.js', digest), ctx, g.guard);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.value).toEqual({ path: 'src/config.js', deleted: true, bytes: EXTRA.length, digest: D, fencingToken: 7 });
    expect(r.provenance).toMatchObject({ src: 'tool:delete', trust: 'untrusted', path: 'src/config.js' });
    expect(await exists(join(root, 'src/config.js'))).toBe(false);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(await strays(join(root, 'src'))).toEqual([]);
    // the exact deletion was authorized through the guard, under a digest no write of those bytes has
    expect(g.authorized).toEqual([{ path: 'src/config.js', contentDigest: deletionDigest(D) }]);
    expect(deletionDigest(D)).not.toBe(D);
    expect(g.checks).toBeGreaterThanOrEqual(2);
  });

  it('the object form with the exact content works; the tool is write-risk with one method', async () => {
    expect(del.risk).toBe('write');
    expect(del.methods).toEqual(['call']);
    expect(del.name).toBe('delete');
    const r = await del.call(req({ path: 'src/d/f.ts', content: EXTRA }), ctx, new FakeWriteGuard().guard);
    expect(r.ok).toBe(true);
    expect(await exists(join(root, 'src/d/f.ts'))).toBe(false);
    expect(await exists(join(root, 'src/d'))).toBe(true); // the directory stays
  });
});

describe('delete: bound to the expected content', () => {
  it('a file that does not hold what the worker read is not deleted (wrong digest, wrong content, changed since)', async () => {
    const g = new FakeWriteGuard().guard;
    expect((await del.call(req('src/config.js', sha256('something else')), ctx, g)).error?.message).toMatch(/does not hold the expected content/);
    expect((await del.call(req({ path: 'src/config.js', content: 'something else' }), ctx, g)).error?.message).toMatch(/does not hold the expected content/);
    await writeFile(join(root, 'src/config.js'), 'changed after the read\n');
    expect((await del.call(req('src/config.js', D), ctx, g)).error?.message).toMatch(/does not hold the expected content/);
    expect(await readFile(join(root, 'src/config.js'), 'utf8')).toBe('changed after the read\n');
  });

  it('a deletion that names no content is refused: the worker must have read the file', async () => {
    const g = new FakeWriteGuard().guard;
    for (const args of [['src/config.js'], [{ path: 'src/config.js' }], ['src/config.js', 'not-a-digest'], [{ path: 'src/config.js', digest: D, content: EXTRA }], [{ path: 'src/config.js', content: 5 }]] as Json[][]) {
      const r = await del.call(req(...args), ctx, g);
      expect(r.ok, JSON.stringify(args)).toBe(false);
      expect(r.error?.name).toBe('ToolInputError');
    }
    expect(await exists(join(root, 'src/config.js'))).toBe(true);
  });

  it('no directory and nothing recursive: a directory, a recursive flag and the worktree root are refused', async () => {
    const g = new FakeWriteGuard().guard;
    expect((await del.call(req('src/d', D), ctx, g)).error?.message).toMatch(/not a regular file/);
    expect((await del.call(req({ path: 'src/d', digest: D, recursive: true } as unknown as Json), ctx, g)).error?.message).toMatch(/no recursive deletion/);
    expect((await del.call(req('.', D), { ...ctx, capabilities: caps({ write: ['**'] }) }, g)).ok).toBe(false);
    expect(await exists(join(root, 'src/d/f.ts'))).toBe(true);
    expect((await del.call(req('src/missing.js', D), ctx, g)).error?.message).toMatch(/no such file/);
  });
});

describe('delete: the same path checks and authorization as edit', () => {
  it('a protected test cannot be deleted, although its path is inside the write allowlist', async () => {
    const r = await del.call(req('test/a.test.ts', D), ctx, new FakeWriteGuard().guard);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/test\/a\.test\.ts is protected by test\/\*\*/);
    expect(await readFile(join(root, 'test/a.test.ts'), 'utf8')).toBe(EXTRA);
    // the replay authorization refuses it as well
    await expect(del.authorize(req('test/a.test.ts', D), ctx)).rejects.toThrow(/protected/);
  });

  it('outside the write allowlist, under .git or .tecera: refused', async () => {
    const g = new FakeWriteGuard().guard;
    expect((await del.call(req('src/config.js', D), { ...ctx, capabilities: caps({ write: ['lib/**'] }) }, g)).error?.message).toMatch(/outside the write allowlist/);
    expect((await del.call(req('.git/HEAD', D), { ...ctx, capabilities: caps({ write: ['**'], protected: [] }) }, g)).error?.message).toMatch(/never allowed/);
    expect(await exists(join(root, '.git/HEAD'))).toBe(true);
    expect(await exists(join(root, 'src/config.js'))).toBe(true);
  });

  it('traversal and absolute paths outside the worktree are refused; the outside file stays', async () => {
    const g = new FakeWriteGuard().guard;
    const wide = { ...ctx, capabilities: caps({ write: ['**'], protected: [] }) };
    expect((await del.call(req('../secret.txt', D), wide, g)).error?.message).toMatch(/traversal/);
    expect((await del.call(req('src/../../secret.txt', D), wide, g)).error?.message).toMatch(/traversal/);
    expect((await del.call(req(join(outside, 'secret.txt'), D), wide, g)).error?.message).toMatch(/outside the worktree/);
    expect((await del.call(req('src\\config.js', D), wide, g)).error?.message).toMatch(/backslash/);
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe(EXTRA);
  });

  it('a symlink is never deleted through, as the target or as a directory on the way; what it points at stays', async () => {
    const g = new FakeWriteGuard().guard;
    await symlink(join(outside, 'secret.txt'), join(root, 'src/link.js'));
    await symlink(outside, join(root, 'src/dirlink'));
    await symlink(join(root, 'test/a.test.ts'), join(root, 'src/alias.js'));
    expect((await del.call(req('src/link.js', D), ctx, g)).error?.message).toMatch(/symlink/);
    expect((await del.call(req('src/dirlink/secret.txt', D), ctx, g)).error?.message).toMatch(/symlink/);
    expect((await del.call(req('src/alias.js', D), ctx, g)).error?.message).toMatch(/symlink/);
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe(EXTRA);
    expect(await readFile(join(root, 'test/a.test.ts'), 'utf8')).toBe(EXTRA);
  });

  it('a hardlinked file is refused: its other name may be a protected file', async () => {
    await link(join(root, 'test/a.test.ts'), join(root, 'src/hard.js'));
    const r = await del.call(req('src/hard.js', D), ctx, new FakeWriteGuard().guard);
    expect(r.error?.message).toMatch(/hardlinked/);
    expect(await exists(join(root, 'src/hard.js'))).toBe(true);
  });

  it('the host\'s extra check sees the resolved path and the kind, and its refusal deletes nothing', async () => {
    const seen: Array<[string, string]> = [];
    const guarded = createDeleteTool({ authorizeChange: (rel, kind) => { seen.push([rel, kind]); if (rel === 'src/a.ts') throw new Error(`${rel} (delete) is outside the step's declared changes`); } });
    const g = new FakeWriteGuard().guard;
    expect((await guarded.call(req('./src/a.ts', sha256('export const a = 1;\n')), ctx, g)).error?.message).toMatch(/outside the step's declared changes/);
    expect(await exists(join(root, 'src/a.ts'))).toBe(true);
    expect((await guarded.call(req('src/config.js', D), ctx, g)).ok).toBe(true);
    expect(seen).toEqual([['src/a.ts', 'delete'], ['src/config.js', 'delete']]);
  });

  it('refused without a worktree, without a lease token, with an unknown method, and on a quarantined worktree', async () => {
    const g = new FakeWriteGuard().guard;
    expect((await del.call(req('src/config.js', D), { ...ctx, worktree: '' }, g)).error?.message).toMatch(/no worktree/);
    expect((await del.call(req('src/config.js', D), { runId: 'r1', worktree: root, capabilities: caps() }, g)).error?.message).toMatch(/no worktree lease fencing token/);
    expect((await del.call({ ...req('src/config.js', D), method: 'purge' }, ctx, g)).error?.message).toMatch(/unknown method/);
    markWorktreeTainted(root, 'test taint');
    expect((await del.call(req('src/config.js', D), ctx, g)).error?.message).toMatch(/quarantined/);
    expect(await exists(join(root, 'src/config.js'))).toBe(true);
  });
});

describe.skipIf(!fdVerificationSupported())('delete: fencing', () => {
  it('without a guard nothing is deleted', async () => {
    const r = await del.call(req('src/config.js', D), ctx);
    expect(r.error?.message).toMatch(/fence lost: no write guard/);
    expect(await exists(join(root, 'src/config.js'))).toBe(true);
  });

  it('a stale fence at entry, and a fence lost after the content was read and matched, both delete nothing', async () => {
    const stale = new FakeWriteGuard();
    stale.revoke('stale fencing token 6 (this process holds 7)');
    const a = await del.call(req('src/config.js', D), ctx, stale.guard);
    expect(a.error?.name).toBe('FenceLost');
    expect(a.error?.message).toMatch(/stale fencing token/);
    const late = new FakeWriteGuard();
    const b = await createDeleteTool({ afterRead: async () => late.revoke('lease lost') }).call(req('src/config.js', D), ctx, late.guard);
    expect(b.error?.name).toBe('FenceLost');
    expect(await readFile(join(root, 'src/config.js'), 'utf8')).toBe(EXTRA);
    expect(await strays(join(root, 'src'))).toEqual([]);
  });

  it('a fence lost inside the synchronous removal window (after the last verification) deletes nothing', async () => {
    const g = new FakeWriteGuard();
    const r = await createDeleteTool({ beforeCommit: () => g.revoke('lease lost') }).call(req('src/config.js', D), ctx, g.guard);
    expect(r.error?.name).toBe('FenceLost');
    expect(await readFile(join(root, 'src/config.js'), 'utf8')).toBe(EXTRA);
    expect(await strays(join(root, 'src'))).toEqual([]);
  });

  it('never suspends for approval: a guard that answers anything but allowed refuses the deletion (WriteRefused)', async () => {
    for (const kind of ['needs-approval', 'approved'] as const) {
      const g = new FakeWriteGuard({ answer: () => ({ kind, requestId: 'ap_1', actionHash: 'h', reason: 'x' }) as never });
      const r = await del.call(req('src/config.js', D), ctx, g.guard);
      expect(r.ok).toBe(false);
      expect(r.error?.name).toBe('WriteRefused');
    }
    expect(await exists(join(root, 'src/config.js'))).toBe(true);
  });

  it('a cancelled exec deletes nothing', async () => {
    const ac = new AbortController();
    const r = await createDeleteTool({ afterRead: async () => ac.abort() }).call(req('src/config.js', D), { ...ctx, signal: ac.signal } as ToolContext, new FakeWriteGuard().guard);
    expect(r.error?.message).toMatch(/cancelled/);
    expect(await exists(join(root, 'src/config.js'))).toBe(true);
  });
});

describe.skipIf(!fdVerificationSupported())('delete: swaps between the check and the removal', () => {
  it('the target replaced by a symlink to a protected file after authorization: refused, the protected file stays', async () => {
    const swap = createDeleteTool({ beforeOpen: async () => { await rm(join(root, 'src/config.js')); await symlink(join(root, 'test/a.test.ts'), join(root, 'src/config.js')); } });
    const r = await swap.call(req('src/config.js', D), ctx, new FakeWriteGuard().guard);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/symlink/);
    expect(await readFile(join(root, 'test/a.test.ts'), 'utf8')).toBe(EXTRA);
  });

  it('the target replaced by another file with the same content after authorization (inode changed): refused', async () => {
    const swap = createDeleteTool({ beforeOpen: async () => { await rename(join(root, 'src/config.js'), join(root, 'src/moved.js')); await writeFile(join(root, 'src/config.js'), EXTRA); } });
    const r = await swap.call(req('src/config.js', D), ctx, new FakeWriteGuard().guard);
    expect(r.error?.message).toMatch(/replaced between authorization and open/);
    expect(await exists(join(root, 'src/config.js'))).toBe(true);
    expect(await exists(join(root, 'src/moved.js'))).toBe(true);
  });

  it('a parent directory swapped for a symlink into a protected directory after authorization: refused, nothing there is deleted', async () => {
    await writeFile(join(root, 'test/f.ts'), EXTRA);
    const swap = createDeleteTool({ beforeOpen: async () => { await rename(join(root, 'src/d'), join(root, 'src/d-real')); await symlink(join(root, 'test'), join(root, 'src/d')); } });
    const r = await swap.call(req('src/d/f.ts', D), ctx, new FakeWriteGuard().guard);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/symlink or non-directory|replaced between authorization and open/);
    expect(await readFile(join(root, 'test/f.ts'), 'utf8')).toBe(EXTRA);
    expect(await readFile(join(root, 'src/d-real/f.ts'), 'utf8')).toBe(EXTRA);
  });

  it('a hardlink into a protected path added after the content was read: refused before anything moves', async () => {
    const swap = createDeleteTool({ afterRead: async () => link(join(root, 'src/config.js'), join(root, 'test/kept.js')) });
    const r = await swap.call(req('src/config.js', D), ctx, new FakeWriteGuard().guard);
    expect(r.error?.message).toMatch(/hardlinked/);
    expect(await exists(join(root, 'src/config.js'))).toBe(true);
  });

  it('the directory moved into a protected path after its descriptor was verified: refused before the removal', async () => {
    const swap = createDeleteTool({ afterRead: async () => rename(join(root, 'src/d'), join(root, 'test/d')) });
    const r = await swap.call(req('src/d/f.ts', D), ctx, new FakeWriteGuard().guard);
    expect(r.error?.message).toMatch(/refused before deleting/);
    expect(await readFile(join(root, 'test/d/f.ts'), 'utf8')).toBe(EXTRA);
    expect(worktreeTaint(root)).toBeNull();
  });

  it('the directory moved into a protected path INSIDE the synchronous removal window: the file is put back there and the worktree is quarantined', async () => {
    const swap = createDeleteTool({ beforeCommit: () => renameSync(join(root, 'src/d'), join(root, 'test/d')) });
    const r = await swap.call(req('src/d/f.ts', D), ctx, new FakeWriteGuard().guard);
    expect(r.error?.name).toBe('TaintError');
    expect(r.error?.message).toMatch(/put back/);
    expect(await readFile(join(root, 'test/d/f.ts'), 'utf8')).toBe(EXTRA);
    expect(await strays(join(root, 'test/d'))).toEqual([]);
    expect(worktreeTaint(root)).toMatch(/post-deletion verification failed/);
    // a quarantined worktree refuses every later file tool
    expect((await createEditTool().call(req('src/a.ts', 'x'), ctx, new FakeWriteGuard().guard)).error?.message).toMatch(/quarantined/);
  });

  it('without /proc/self/fd every deletion is refused (no path-based fallback)', async () => {
    const r = await createDeleteTool({ assumeNoProcFd: true }).call(req('src/config.js', D), ctx, new FakeWriteGuard().guard);
    expect(r.error?.message).toMatch(/deletions are refused on this platform/);
    expect(await exists(join(root, 'src/config.js'))).toBe(true);
  });
});
