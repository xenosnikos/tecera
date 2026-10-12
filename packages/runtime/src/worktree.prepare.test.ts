import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ignoredPathKey } from '@tecera/gates';
import { LeaseLost, prepareWorktreeBranch } from './worktree.js';

/**
 * prepareWorktreeBranch on temp repositories: the worktree of a superseded intention (a commit on its own
 * branch, uncommitted edits, untracked and ignored files) is put on a new branch at the base, with nothing
 * carried over and the old branch untouched; a fence that fails stops it before the next mutation.
 */

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args], { env: { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null' } }).toString('utf8');
}

/** A repository whose HEAD sits on tecera/g with one commit on the base, plus leftovers of that intention. */
function leftByA(): { dir: string; base: string; a: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tecera-prep-'));
  temps.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/a.js'), 'export const a = 1;\n');
  writeFileSync(join(dir, '.gitignore'), 'cache/\n*.log\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD').trim();
  git(dir, 'checkout', '-q', '-b', 'tecera/g');
  writeFileSync(join(dir, 'src/a.js'), 'export const a = 2;\n');
  writeFileSync(join(dir, 'src/config.js'), 'export default {};\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'A');
  const a = git(dir, 'rev-parse', 'HEAD').trim();
  // after the commit: an uncommitted edit, an untracked file, an ignored file of the baseline and a newer one
  writeFileSync(join(dir, 'src/a.js'), 'export const a = 3;\n');
  writeFileSync(join(dir, 'src/extra.js'), 'x\n');
  mkdirSync(join(dir, 'cache'));
  writeFileSync(join(dir, 'cache/kept.bin'), 'baseline');
  writeFileSync(join(dir, 'cache/new.bin'), 'left by A');
  writeFileSync(join(dir, 'debug.log'), 'left by A');
  return { dir, base, a };
}

const keep = (k: string): boolean => k === ignoredPathKey('cache/kept.bin');
const held = (): void => undefined;

describe('prepareWorktreeBranch', () => {
  it('puts the worktree on the new branch at the base: the old commit, uncommitted edits, untracked files and ignored files outside the baseline are gone from it; the old branch keeps its commit', async () => {
    const { dir, base, a } = leftByA();
    const r = await prepareWorktreeBranch(dir, base, { branch: 'tecera/g.2', keepIgnored: keep }, held);
    expect(r).toEqual({ branch: 'tecera/g.2', baseSha: base, created: true, removedIgnored: 2 });
    expect(git(dir, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/tecera/g.2');
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(base);
    expect(git(dir, 'rev-parse', 'tecera/g').trim()).toBe(a);
    expect(git(dir, 'rev-parse', 'main').trim()).toBe(base);
    expect(readFileSync(join(dir, 'src/a.js'), 'utf8')).toBe('export const a = 1;\n');
    expect(existsSync(join(dir, 'src/config.js'))).toBe(false);
    expect(existsSync(join(dir, 'src/extra.js'))).toBe(false);
    expect(existsSync(join(dir, 'cache/new.bin'))).toBe(false);
    expect(existsSync(join(dir, 'debug.log'))).toBe(false);
    expect(readFileSync(join(dir, 'cache/kept.bin'), 'utf8')).toBe('baseline');
    expect(git(dir, 'status', '--porcelain').trim()).toBe('');
    // idempotent: a second call finds the branch at the base and changes nothing
    expect(await prepareWorktreeBranch(dir, base, { branch: 'tecera/g.2', keepIgnored: keep }, held)).toEqual({ branch: 'tecera/g.2', baseSha: base, created: false, removedIgnored: 0 });
    expect(git(dir, 'rev-parse', 'tecera/g').trim()).toBe(a);
  });

  it('a fence that fails before the first mutation leaves everything exactly as it was', async () => {
    const { dir, base, a } = leftByA();
    let lost = false;
    const fence = (): void => {
      if (lost) throw new LeaseLost('worktree lease lost');
    };
    await expect(prepareWorktreeBranch(dir, base, { branch: 'tecera/g.2', keepIgnored: keep, beforeMutation: () => void (lost = true) }, fence)).rejects.toThrow(LeaseLost);
    expect(() => git(dir, 'rev-parse', '--verify', '--quiet', 'refs/heads/tecera/g.2')).toThrow();
    expect(git(dir, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/tecera/g');
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(a);
    expect(readFileSync(join(dir, 'src/a.js'), 'utf8')).toBe('export const a = 3;\n');
    expect(existsSync(join(dir, 'src/extra.js'))).toBe(true);
    expect(existsSync(join(dir, 'cache/new.bin'))).toBe(true);
  });

  it('a fence that fails between the mutations stops at that point; a later call completes it', async () => {
    const { dir, base, a } = leftByA();
    let n = 0;
    // 1st check: before the branch is created; 2nd: before HEAD moves
    const fence = (): void => {
      if (++n === 2) throw new LeaseLost('worktree lease lost');
    };
    await expect(prepareWorktreeBranch(dir, base, { branch: 'tecera/g.2', keepIgnored: keep }, fence)).rejects.toThrow(LeaseLost);
    expect(git(dir, 'rev-parse', 'tecera/g.2').trim()).toBe(base);
    expect(git(dir, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/tecera/g');
    expect(existsSync(join(dir, 'src/extra.js'))).toBe(true);
    const r = await prepareWorktreeBranch(dir, base, { branch: 'tecera/g.2', keepIgnored: keep }, held);
    expect(r.created).toBe(false);
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(base);
    expect(git(dir, 'rev-parse', 'tecera/g').trim()).toBe(a);
    expect(existsSync(join(dir, 'src/extra.js'))).toBe(false);
  });

  it('refuses a branch that already exists anywhere but at the base, and a name git would not accept, before touching anything', async () => {
    const { dir, base, a } = leftByA();
    git(dir, 'branch', 'tecera/g.2', a);
    await expect(prepareWorktreeBranch(dir, base, { branch: 'tecera/g.2' }, held)).rejects.toThrow(/already exists at/);
    await expect(prepareWorktreeBranch(dir, base, { branch: 'tecera/g..3' }, held)).rejects.toThrow();
    expect(git(dir, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/tecera/g');
    expect(readFileSync(join(dir, 'src/a.js'), 'utf8')).toBe('export const a = 3;\n');
  });

  it('an ignored link is removed as a link: what it points at outside the worktree is not touched', async () => {
    const { dir, base } = leftByA();
    const outside = mkdtempSync(join(tmpdir(), 'tecera-prep-out-'));
    temps.push(outside);
    writeFileSync(join(outside, 'victim.txt'), 'keep me');
    symlinkSync(outside, join(dir, 'link.log'));
    await prepareWorktreeBranch(dir, base, { branch: 'tecera/g.2', keepIgnored: keep }, held);
    expect(existsSync(join(dir, 'link.log'))).toBe(false);
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('keep me');
  });
});
