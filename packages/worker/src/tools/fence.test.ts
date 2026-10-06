import { renameSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FenceLost, sha256, writeActionHash, type CapabilitySet, type WriteAuthorization, type Json, type ToolContext, type ToolRequest, type VerifyOutcome, type VerifyRunner } from '@tecera/contracts';
import { FakeWriteGuard } from '../invoke/fakes.js';
import { createEditTool } from './edit.js';
import { fdVerificationSupported, worktreeTaint, writeInWorktree } from './paths.js';
import { createRunVerifyTool, verifyOutcomeProblem } from './runVerify.js';

/**
 * Wave 4, lane I4 (Codex sprint-3 invoke New findings 1 and 5, next steps 4/5/8): the mutation-time write
 * fence (contracts WriteGuard) inside the tools, rollback of a commit raced by an outside process, and the
 * completeness of verification results.
 */

const caps = (): CapabilitySet => ({
  tools: ['read', 'edit', 'runVerify'],
  paths: { read: ['**'], write: ['src/**'], protected: ['test/**'] },
  network: 'none',
  limits: { usd: 1, tokens: 1000, calls: 10, wallMs: 1000, depth: 2, iterations: 5 },
});
const req = (...args: Json[]): ToolRequest => ({ callId: 'c1', tool: 't', method: 'call', args, idemKey: 'k' });
const ORIGINAL = 'export const f = 1;\n';

let root: string;
let outside: string;
let ctx: ToolContext;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tecera-fence-'));
  outside = await mkdtemp(join(tmpdir(), 'tecera-fence-out-'));
  await mkdir(join(root, 'src/d'), { recursive: true });
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'src/d/f.ts'), ORIGINAL);
  ctx = { runId: 'r1', worktree: root, capabilities: caps(), fencingToken: 7 };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const strays = async (dir: string): Promise<string[]> => (await readdir(dir)).filter((n) => n.startsWith('.tecera-'));

describe('the write guard is required and checked at every mutation (contracts WriteGuard)', () => {
  it('without a guard edit refuses and runVerify never starts the runner; nothing is written', async () => {
    const r = await createEditTool().call(req('src/a.ts', 'x'), ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/fence lost: no write guard/);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    let ran = false;
    const v = await createRunVerifyTool({ runner: { run: async () => ((ran = true), { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', durationMs: 1, truncated: false }) }, command: 'node --test', timeoutSec: 5 }).call(req(), ctx);
    expect(v.ok).toBe(false);
    expect(ran).toBe(false);
  });

  it('check() runs before the temp file is created, again after it is opened and fstat-verified, and before the commit', async () => {
    const g = new FakeWriteGuard();
    expect((await createEditTool().call(req('src/a.ts', 'y'), ctx, g.guard)).ok).toBe(true);
    // entry, authorizeWrite, temp create, first data write, commit
    expect(g.checks).toBeGreaterThanOrEqual(5);
  });

  for (const [stage, seam] of [
    ['after the current content was read (before the temp file exists)', 'afterRead'],
    ['after the temp file was opened and verified, before its data is written', 'beforeData'],
  ] as const) {
    it(`a fence lost ${stage}: FenceLost, nothing written, no temp file left`, async () => {
      const g = new FakeWriteGuard();
      const edit = createEditTool({ [seam]: async () => g.revoke('lease taken over') });
      const r = await edit.call(req('src/a.ts', 'after revocation'), ctx, g.guard);
      expect(r.ok).toBe(false);
      expect(r.error?.name).toBe('FenceLost');
      expect(r.error?.message).toMatch(/lease taken over/);
      expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
      expect(await strays(join(root, 'src'))).toEqual([]);
    });
  }

  it('D6: with the loop guard (always allowed after the fence) every write proceeds without a hold, each authorized with its exact bytes', async () => {
    const g = new FakeWriteGuard();
    expect((await createEditTool().call(req('src/a.ts', 'one'), ctx, g.guard)).ok).toBe(true);
    expect((await createEditTool().call(req('src/n/m/x.ts', 'new'), ctx, g.guard)).ok).toBe(true);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('one');
    expect(await readFile(join(root, 'src/n/m/x.ts'), 'utf8')).toBe('new');
    expect(g.authorized).toEqual([
      { path: 'src/a.ts', contentDigest: sha256('one') },
      { path: 'src/n/m/x.ts', contentDigest: sha256('new') },
    ]);
  });

  const step = { runId: 'r1', intentionId: 'i', stepId: 's' };
  for (const [label, answer] of [
    ['needs-approval', (w) => ({ kind: 'needs-approval', actionHash: writeActionHash({ ...step, ...w }) })],
    ['approved', (w) => ({ kind: 'approved', requestId: 'wr_1', actionHash: writeActionHash({ ...step, ...w }) })],
    ['an unknown answer', () => ({ kind: 'maybe' }) as unknown as WriteAuthorization],
  ] as const satisfies ReadonlyArray<readonly [string, (w: { path: string; contentDigest: string }) => WriteAuthorization]>) {
    it(`D6: a guard answering ${label} (per-write approvals were removed) refuses the write: WriteRefused, nothing written, no directory created`, async () => {
      const g = new FakeWriteGuard({ answer });
      const r = await createEditTool().call(req('src/n/m/x.ts', 'new'), ctx, g.guard);
      expect(r.ok).toBe(false);
      expect(r.error?.name).toBe('WriteRefused');
      await expect(stat(join(root, 'src/n'))).rejects.toThrow();
      expect(g.authorized).toEqual([{ path: 'src/n/m/x.ts', contentDigest: sha256('new') }]);
      const old = await createEditTool().call(req('src/a.ts', 'over'), ctx, g.guard);
      expect(old.error?.name).toBe('WriteRefused');
      expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
      expect(await strays(join(root, 'src'))).toEqual([]);
    });
  }

  it('runVerify checks the guard immediately before the run and forwards its signal; a fence lost during the run is never a pass', async () => {
    const g = new FakeWriteGuard();
    let seen: AbortSignal | undefined;
    const runner: VerifyRunner = {
      run: async (_r, signal) => {
        seen = signal;
        g.revoke('lease lost mid-run', true);
        return { exitCode: 0, signal: null, timedOut: false, stdout: 'ok', stderr: '', durationMs: 1, truncated: false };
      },
    };
    const r = await createRunVerifyTool({ runner, command: 'node --test', timeoutSec: 5 }).call(req(), ctx, g.guard);
    expect(seen?.aborted).toBe(true);
    expect(r.value).toMatchObject({ passed: false, fenceLost: expect.stringMatching(/lease lost mid-run/) });
    const revoked = new FakeWriteGuard();
    revoked.revoke('gone');
    let ran = false;
    const r2 = await createRunVerifyTool({ runner: { run: async () => ((ran = true), { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', durationMs: 1, truncated: false }) }, command: 'node --test', timeoutSec: 5 }).call(req(), ctx, revoked.guard);
    expect(r2.ok).toBe(false);
    expect(ran).toBe(false);
  });

  it('writeInWorktree refuses without a guard even when called directly', async () => {
    await expect(writeInWorktree(root, 'src/a.ts', () => 'x', { maxBytes: 100, mode: 'write', authorize: () => undefined })).rejects.toBeInstanceOf(FenceLost);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });
});

describe.skipIf(!fdVerificationSupported())('external rename race inside the commit window (Codex sprint-3 invoke New finding 1)', () => {
  it('the parent directory moved into a protected path after the descriptors were verified: refused before ANYTHING is created in it', async () => {
    const g = new FakeWriteGuard();
    const edit = createEditTool({ afterRead: async () => rename(join(root, 'src/d'), join(root, 'test/d')) });
    const r = await edit.call(req('src/d/f.ts', 'pwned'), ctx, g.guard);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/refused before writing/);
    expect(await readFile(join(root, 'test/d/f.ts'), 'utf8')).toBe(ORIGINAL);
    expect(await strays(join(root, 'test/d'))).toEqual([]); // not even a temp file landed in the protected directory
    expect(worktreeTaint(root)).toBeNull();
  });

  it('a directory relocated into a protected path INSIDE the synchronous commit window: rolled back, the protected destination keeps its original content, the worktree is quarantined', async () => {
    const g = new FakeWriteGuard();
    const edit = createEditTool({ beforeCommit: () => renameSync(join(root, 'src/d'), join(root, 'test/d')) });
    const r = await edit.call(req('src/d/f.ts', 'landed elsewhere'), ctx, g.guard);
    expect(r.ok).toBe(false);
    expect(r.error?.name).toBe('TaintError');
    expect(r.error?.message).toMatch(/rolled back/);
    expect(await readFile(join(root, 'test/d/f.ts'), 'utf8')).toBe(ORIGINAL);
    expect(await strays(join(root, 'test/d'))).toEqual([]);
    expect(worktreeTaint(root)).toMatch(/post-commit verification failed/);
  });

  it('a directory relocated OUT of the worktree inside the commit window: the outside destination keeps its original content', async () => {
    const g = new FakeWriteGuard();
    const edit = createEditTool({ beforeCommit: () => renameSync(join(root, 'src/d'), join(outside, 'd')) });
    const r = await edit.call(req('src/d/f.ts', 'escaped'), ctx, g.guard);
    expect(r.error?.name).toBe('TaintError');
    expect(await readFile(join(outside, 'd/f.ts'), 'utf8')).toBe(ORIGINAL);
    expect(await strays(join(outside, 'd'))).toEqual([]);
  });

  it('a NEW file whose directory is relocated inside the commit window: the moved directory ends without the file', async () => {
    const g = new FakeWriteGuard();
    const edit = createEditTool({ beforeCommit: () => renameSync(join(root, 'src/d'), join(root, 'test/d')) });
    const r = await edit.call(req('src/d/new.ts', 'planted'), ctx, g.guard);
    expect(r.error?.name).toBe('TaintError');
    await expect(stat(join(root, 'test/d/new.ts'))).rejects.toThrow();
    expect((await readdir(join(root, 'test/d'))).sort()).toEqual(['f.ts']);
  });

  it('an unraced commit leaves no backup or temp names behind', async () => {
    const g = new FakeWriteGuard();
    expect((await createEditTool().call(req('src/d/f.ts', 'v2'), ctx, g.guard)).ok).toBe(true);
    expect(await readFile(join(root, 'src/d/f.ts'), 'utf8')).toBe('v2');
    expect(await strays(join(root, 'src/d'))).toEqual([]);
  });
});

describe('verification completeness (Codex sprint-3 invoke New finding 5)', () => {
  const full: VerifyOutcome = { exitCode: 0, signal: null, timedOut: false, stdout: 'PASS', stderr: '', durationMs: 3, truncated: false };
  const run = async (r: unknown) => {
    const g = new FakeWriteGuard();
    return (await createRunVerifyTool({ runner: { run: async () => r as VerifyOutcome }, command: 'node --test', timeoutSec: 5 }).call(req(), ctx, g.guard)).value as { passed: boolean; complete: boolean; truncated: boolean; why?: string };
  };

  it('the Codex probe {exitCode: 0, stdout, stderr, timedOut} (no truncated/signal/durationMs) is incomplete and fails', async () => {
    const v = await run({ exitCode: 0, stdout: 'PASS', stderr: '', timedOut: false });
    expect(v).toMatchObject({ complete: false, passed: false, truncated: true });
    expect(v.why).toMatch(/incomplete/);
  });

  const broken: Array<[string, Record<string, unknown>]> = [
    ['missing truncated', { truncated: undefined }],
    ['truncated as a string', { truncated: 'false' }],
    ['missing signal', { signal: undefined }],
    ['signal as a number', { signal: 9 }],
    ['missing durationMs', { durationMs: undefined }],
    ['NaN durationMs', { durationMs: Number.NaN }],
    ['negative durationMs', { durationMs: -1 }],
    ['missing timedOut', { timedOut: undefined }],
    ['timedOut as a string', { timedOut: 'false' }],
    ['fractional exitCode', { exitCode: 0.5 }],
    ['string exitCode', { exitCode: '0' }],
    ['missing stdout', { stdout: undefined }],
    ['stderr as an array', { stderr: [] }],
    ['stdoutTruncated as a string', { stdoutTruncated: 'no' }],
    ['cancelled as a number', { cancelled: 0 }],
    ['null exitCode without timeout, cancellation or signal', { exitCode: null }],
  ];
  for (const [label, over] of broken) {
    it(`${label}: never a pass`, async () => {
      const r = { ...full, ...over };
      for (const [k, v] of Object.entries(over)) if (v === undefined) delete (r as Record<string, unknown>)[k];
      expect(verifyOutcomeProblem(r)).not.toBeNull();
      expect(await run(r)).toMatchObject({ complete: false, passed: false });
    });
  }

  it('a complete clean result passes; the same with any failure flag does not', async () => {
    expect(verifyOutcomeProblem(full)).toBeNull();
    expect(await run(full)).toMatchObject({ complete: true, passed: true });
    expect(await run({ ...full, exitCode: null, timedOut: true })).toMatchObject({ complete: true, passed: false });
    expect(await run({ ...full, stderrTruncated: true })).toMatchObject({ passed: false });
  });
});
