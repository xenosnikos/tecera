import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCandidateTree, fileManifest, gitOid, ignoredPathKey, isBinary, manifestMismatch, policyChanges, snapshotCandidate } from './candidate.js';
import { ignoredBaselineOf } from './evidence.js';
import { makeRedactor } from '@tecera/contracts';
import { assertSafeRepo, gitEnv, hostGit, UnsafeRepo } from './gitx.js';
import { makeRepo } from './testkit/fixtures.js';

function marker(): string {
  return join(mkdtempSync(join(tmpdir(), 'tecera-mark-')), 'ran');
}

describe('host git environment', () => {
  it('inherits nothing but PATH: no supervisor secrets reach git', () => {
    process.env.TECERA_TEST_SECRET_X = 'TECERA_CANARY_gitenv_1234';
    try {
      const env = gitEnv();
      expect(Object.values(env).join('\n')).not.toContain('TECERA_CANARY');
      expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
      expect(env.GIT_ATTR_NOSYSTEM).toBe('1');
      expect(env.GIT_NO_REPLACE_OBJECTS).toBe('1');
    } finally {
      delete process.env.TECERA_TEST_SECRET_X;
    }
  });
});

describe('assertSafeRepo', () => {
  const hostile: Array<[string, string, string]> = [
    ['filter clean', 'filter.evil.clean', 'touch MARK'],
    ['filter process', 'filter.evil.process', 'touch MARK'],
    ['diff textconv', 'diff.evil.textconv', 'touch MARK'],
    ['core.sshCommand', 'core.sshCommand', 'touch MARK'],
    ['core.fsmonitor', 'core.fsmonitor', 'touch MARK'],
    ['core.hooksPath', 'core.hooksPath', '.husky'],
    ['credential.helper', 'credential.helper', '!touch MARK'],
    ['include.path', 'include.path', '/tmp/elsewhere'],
    ['merge driver', 'merge.evil.driver', 'touch MARK'],
  ];
  for (const [name, key, value] of hostile) {
    it(`refuses local ${name}`, async () => {
      const r = makeRepo();
      const m = marker();
      r.g('config', key, value.replace('MARK', m));
      await expect(assertSafeRepo(r.dir)).rejects.toBeInstanceOf(UnsafeRepo);
      expect(existsSync(m)).toBe(false);
    });
  }

  it('accepts a plain repository and reports object format and fileMode', async () => {
    const r = makeRepo();
    expect(await assertSafeRepo(r.dir)).toEqual({ objectFormat: 'sha1', fileMode: true });
  });

  it('refuses $GIT_DIR/info/attributes with a filter', async () => {
    const r = makeRepo();
    r.write('.git/info/attributes', '*.ts filter=evil\n');
    await expect(assertSafeRepo(r.dir)).rejects.toThrow(/info\/attributes/);
  });

  it('refuses relative or empty worktree paths', async () => {
    await expect(assertSafeRepo('')).rejects.toBeInstanceOf(UnsafeRepo);
    await expect(assertSafeRepo('relative/path')).rejects.toBeInstanceOf(UnsafeRepo);
  });
});

describe('snapshotCandidate', () => {
  it('records {status, mode, sha256, oid} per changed file; oids equal git hash-object', async () => {
    const r = makeRepo();
    r.write('src/a.ts', 'export const a = 2;\n');
    r.write('src/new.ts', 'export const n = 1;\n');
    r.g('rm', '-q', 'src/a.test.ts');
    const c = await snapshotCandidate(r.dir, 'main');
    expect(c.files.map((f) => [f.path, f.status])).toEqual([
      ['src/a.test.ts', 'D'],
      ['src/a.ts', 'M'],
      ['src/new.ts', 'A'],
    ]);
    const a = c.files.find((f) => f.path === 'src/a.ts')!;
    expect(a.oid).toBe(r.g('hash-object', 'src/a.ts').trim());
    expect(a.mode).toBe('100644');
    expect(c.head).toBe(c.baseCommit);
  });

  it('the fingerprint covers bytes and modes, not just names', async () => {
    const r = makeRepo();
    r.write('src/a.ts', 'export const a = 2;\n');
    const one = await snapshotCandidate(r.dir, 'main');
    r.write('src/a.ts', 'export const a = 3;\n');
    const two = await snapshotCandidate(r.dir, 'main');
    expect(two.fingerprint).not.toBe(one.fingerprint);
    expect(manifestMismatch(fileManifest(one), two)).toEqual(['src/a.ts']);
    chmodSync(join(r.dir, 'src/a.ts'), 0o755);
    const three = await snapshotCandidate(r.dir, 'main');
    expect(three.fingerprint).not.toBe(two.fingerprint);
    expect(three.files[0]!.mode).toBe('100755');
  });

  it('a hostile clean filter in local config never runs: snapshot refuses before reading content', async () => {
    const r = makeRepo({ '.gitattributes': '' });
    const m = marker();
    r.g('config', 'filter.evil.clean', `sh -c 'echo ran > ${m}; cat'`);
    r.write('src/a.ts', 'export const a = 2;\n');
    await expect(snapshotCandidate(r.dir, 'main')).rejects.toBeInstanceOf(UnsafeRepo);
    expect(existsSync(m)).toBe(false);
  });

  it('.gitattributes with filter/export attributes in the candidate or base tree is refused', async () => {
    const r = makeRepo();
    r.write('src/.gitattributes', '*.ts filter=evil\n');
    await expect(snapshotCandidate(r.dir, 'main')).rejects.toThrow(/\.gitattributes/);
    const s = makeRepo({ '.gitattributes': '*.txt export-subst\n' });
    await expect(snapshotCandidate(s.dir, 'main')).rejects.toThrow(/\.gitattributes/);
    const t = makeRepo({ '.gitmodules': '[submodule "x"]\n\tpath = x\n\turl = ./x\n\tupdate = !touch /tmp/x\n' });
    await expect(snapshotCandidate(t.dir, 'main')).rejects.toThrow(/\.gitmodules/);
  });

  it('classifies binaries (NUL or invalid UTF-8) and untracked/ignored files', async () => {
    const r = makeRepo();
    r.write('src/blob.bin', Buffer.from([0x41, 0x00, 0x42]));
    r.write('src/latin1.ts', Buffer.from([0x63, 0xe9, 0x0a]));
    r.write('ignored/x.txt', 'x');
    r.write('debug.log', 'log');
    const c = await snapshotCandidate(r.dir, 'main');
    const by = new Map(c.files.map((f) => [f.path, f]));
    expect(by.get('src/blob.bin')).toMatchObject({ status: 'A', binary: true });
    expect(by.get('src/latin1.ts')).toMatchObject({ status: 'A', binary: true });
    expect(by.get('ignored/x.txt')).toMatchObject({ status: '!' });
    expect(by.get('debug.log')).toMatchObject({ status: '!' });
    expect(isBinary(Buffer.from('plain\n'))).toBe(false);
  });

  it('ignored files equal to the baseline are not changes but still fingerprinted', async () => {
    const r = makeRepo();
    r.write('ignored/dep.js', 'module.exports = 1;\n');
    const first = await snapshotCandidate(r.dir, 'main');
    const baseline = ignoredBaselineOf(first.ignored, makeRedactor([]));
    const second = await snapshotCandidate(r.dir, 'main', { ignoredBaseline: baseline });
    expect(second.files).toEqual([]);
    r.write('ignored/dep.js', 'module.exports = 2;\n');
    const third = await snapshotCandidate(r.dir, 'main', { ignoredBaseline: baseline });
    expect(third.files.map((f) => [f.path, f.status])).toEqual([['ignored/dep.js', '!']]);
    expect(third.fingerprint).not.toBe(second.fingerprint);
  });

  it('baseline ∪ present: deleting a baselined ignored file is a change (by key, never by name)', async () => {
    const r = makeRepo();
    r.write('ignored/dep.js', 'module.exports = 1;\n');
    r.write('ignored/keep.js', 'module.exports = 2;\n');
    const baseline = ignoredBaselineOf((await snapshotCandidate(r.dir, 'main')).ignored, makeRedactor([]));
    const untouched = await snapshotCandidate(r.dir, 'main', { ignoredBaseline: baseline });
    expect(untouched.files).toEqual([]);
    rmSync(join(r.dir, 'ignored/dep.js'));
    const gone = await snapshotCandidate(r.dir, 'main', { ignoredBaseline: baseline });
    expect(gone.files).toEqual([{ path: 'ignored/dep.js', status: '!', deleted: true, pathKey: ignoredPathKey('ignored/dep.js') }]);
    expect(gone.fingerprint).not.toBe(untouched.fingerprint);
    expect(policyChanges(gone)).toEqual([{ path: 'ignored/dep.js', status: '!' }]);
    // The display name is irrelevant to the fingerprint: a redacted name yields the same digest.
    const renamed = await snapshotCandidate(r.dir, 'main', { ignoredBaseline: { entries: baseline.entries, names: { [ignoredPathKey('ignored/dep.js')]: '[REDACTED:secret:00000000]' } } });
    expect(renamed.fingerprint).toBe(gone.fingerprint);
    expect(manifestMismatch(fileManifest(gone), renamed)).toEqual([]);
    // Re-creating it with other bytes is still a change; with the same bytes it is not.
    r.write('ignored/dep.js', 'module.exports = 3;\n');
    expect((await snapshotCandidate(r.dir, 'main', { ignoredBaseline: baseline })).files.map((f) => [f.path, f.status, f.deleted ?? false])).toEqual([['ignored/dep.js', '!', false]]);
    r.write('ignored/dep.js', 'module.exports = 1;\n');
    expect((await snapshotCandidate(r.dir, 'main', { ignoredBaseline: baseline })).fingerprint).toBe(untouched.fingerprint);
  });

  it('manifestMismatch compares by path key, so a redacted path in persisted evidence still matches', async () => {
    const r = makeRepo();
    r.write('src/a.ts', 'export const a = 2;\n');
    const c = await snapshotCandidate(r.dir, 'main');
    const persisted = makeRedactor(['src/a.ts']).redactJson(fileManifest(c));
    expect(JSON.stringify(persisted)).not.toContain('src/a.ts');
    expect(manifestMismatch(persisted, c)).toEqual([]);
  });

  it('refuses a base tree with a submodule (gitlink)', async () => {
    const r = makeRepo();
    const oid = r.g('rev-parse', 'HEAD').trim();
    r.g('update-index', '--add', '--cacheinfo', `160000,${oid},sub`);
    r.g('commit', '-q', '-m', 'sub');
    await expect(snapshotCandidate(r.dir, 'main')).rejects.toThrow(/submodule/);
  });
});

describe('buildCandidateTree', () => {
  it('builds the tree from host-read bytes with no filters and verifies every entry', async () => {
    const r = makeRepo();
    r.write('src/a.ts', 'export const a = 2;\n');
    r.write('src/b.ts', 'export const b = 1;\n');
    const c = await snapshotCandidate(r.dir, 'main');
    const t = await buildCandidateTree(r.dir, c);
    const listing = await hostGit(r.dir, ['ls-tree', '-r', '--full-tree', t.tree]);
    expect(listing).toContain(c.files.find((f) => f.path === 'src/b.ts')!.oid!);
    // The real index is untouched.
    expect(r.g('diff', '--cached', '--name-only').trim()).toBe('');
    expect(gitOid('sha1', Buffer.from('hi\n'))).toBe('45b983be36b73c0788dc9cbcb76cbb80fc7bb057');
  });

  it('refuses when recorded content no longer matches its oid', async () => {
    const r = makeRepo();
    r.write('src/a.ts', 'export const a = 2;\n');
    const c = await snapshotCandidate(r.dir, 'main');
    c.content.set('src/a.ts', Buffer.from('export const a = 666;\n'));
    await expect(buildCandidateTree(r.dir, c)).rejects.toThrow(/hashed to/);
  });
});
