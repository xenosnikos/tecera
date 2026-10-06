import { describe, expect, it } from 'vitest';
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { makeRedactor, type Ledger } from '@tecera/contracts';
import { ignoredPathKey, snapshotCandidate, type IgnoredBaseline } from './candidate.js';
import { GateMemo, ignoredBaseline, ignoredBaselineKey, ignoredBaselineOf } from './evidence.js';
import { createGates } from './index.js';
import { ctx, FakeReviewer, FakeRunner, LEDGERS, makeRepo, manifest, NOW, WRITERS, type Repo } from './testkit/fixtures.js';

/**
 * Codex sprint-3 gates finding 1 (candidate.ts:193/238): an ignored file whose bytes match the baseline
 * used to be exempted BEFORE its type, mode or link identity was looked at, and the fingerprint kept only
 * its content hash. Now the stamp (content + type + permission bits + link identity) is taken first and
 * fingerprinted, so each of these swaps is a '!' change, moves the fingerprint, survives a fresh instance
 * and is refused at commit.
 */

const DEP = 'ignored/dep.js';
const TARGET = 'module.exports = 1;\n';

/** The repo with one ignored file whose content equals a plausible symlink target string. */
function repoWithIgnored(content = TARGET): Repo {
  const repo = makeRepo();
  repo.write(DEP, content);
  chmodSync(join(repo.dir, DEP), 0o644);
  return repo;
}

async function baselineOf(repo: Repo): Promise<IgnoredBaseline> {
  const s = await snapshotCandidate(repo.dir, 'main');
  expect(s.files.every((f) => f.status === '!')).toBe(true);
  return ignoredBaselineOf(s.ignored, makeRedactor([]));
}

type Swap = [string, (repo: Repo) => void];
const SWAPS: Swap[] = [
  ['executable bit set, same bytes', (r) => chmodSync(join(r.dir, DEP), 0o755)],
  ['group/other write set, same bytes', (r) => chmodSync(join(r.dir, DEP), 0o666)],
  [
    'replaced by a hardlink to an outside file with the same bytes',
    (r) => {
      const outside = join(mkdtempSync(join(tmpdir(), 'tecera-gates-outside-')), 'same.js');
      writeFileSync(outside, TARGET);
      chmodSync(outside, 0o644);
      rmSync(join(r.dir, DEP));
      linkSync(outside, join(r.dir, DEP));
    },
  ],
  [
    'gains a second hardlink inside the worktree (same inode, nlink 2)',
    (r) => linkSync(join(r.dir, DEP), join(r.dir, 'ignored/alias.js')),
  ],
];

describe('ignored-file metadata is stamped before the baseline exemption (unit)', () => {
  it('unchanged ignored files are exempt and the fingerprint is stable', async () => {
    const repo = repoWithIgnored();
    const b = await baselineOf(repo);
    const a1 = await snapshotCandidate(repo.dir, 'main', { ignoredBaseline: b });
    const a2 = await snapshotCandidate(repo.dir, 'main', { ignoredBaseline: b });
    expect(a1.files).toEqual([]);
    expect(a1.fingerprint).toBe(a2.fingerprint);
  });

  for (const [name, swap] of SWAPS) {
    it(`${name}: a '!' change with a new stamp, and a new fingerprint`, async () => {
      const repo = repoWithIgnored();
      const b = await baselineOf(repo);
      const before = await snapshotCandidate(repo.dir, 'main', { ignoredBaseline: b });
      swap(repo);
      const after = await snapshotCandidate(repo.dir, 'main', { ignoredBaseline: b });
      const rec = after.files.find((f) => f.path === DEP);
      expect(rec, JSON.stringify(after.files)).toMatchObject({ status: '!' });
      expect(rec!.stamp).toMatch(/^[0-9a-f]{64}$/);
      expect(rec!.stamp).not.toBe(b.entries[ignoredPathKey(DEP)]);
      // The bytes did not change; only the metadata did.
      expect(rec!.sha256).toBe(createHash('sha256').update(TARGET).digest('hex'));
      expect(after.fingerprint).not.toBe(before.fingerprint);
    });
  }

  it('same-hash file → symlink swap (link target string == old file bytes) is a change', async () => {
    const target = 'node_modules/real/index.js';
    const repo = repoWithIgnored(target);
    const b = await baselineOf(repo);
    const before = await snapshotCandidate(repo.dir, 'main', { ignoredBaseline: b });
    rmSync(join(repo.dir, DEP));
    symlinkSync(target, join(repo.dir, DEP));
    const after = await snapshotCandidate(repo.dir, 'main', { ignoredBaseline: b });
    const rec = after.files.find((f) => f.path === DEP)!;
    // Same sha256 (a symlink is hashed over its target), different stamp.
    expect(rec).toMatchObject({ status: '!', symlink: true, mode: '120000' });
    expect(rec.stamp).not.toBe(b.entries[ignoredPathKey(DEP)]);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('a file hardlinked AT baseline stays exempt while unchanged, but a different inode with the same bytes is a change', async () => {
    const repo = repoWithIgnored();
    linkSync(join(repo.dir, DEP), join(repo.dir, 'ignored/alias.js'));
    const b = await baselineOf(repo);
    expect((await snapshotCandidate(repo.dir, 'main', { ignoredBaseline: b })).files).toEqual([]);
    // Replace alias.js with a fresh file (new inode, nlink 1) — and dep.js drops to nlink 1 too.
    rmSync(join(repo.dir, 'ignored/alias.js'));
    writeFileSync(join(repo.dir, 'ignored/alias.js'), TARGET);
    chmodSync(join(repo.dir, 'ignored/alias.js'), 0o644);
    const after = await snapshotCandidate(repo.dir, 'main', { ignoredBaseline: b });
    expect(after.files.map((f) => f.path).sort()).toEqual(['ignored/alias.js', DEP]);
  });

  it('a pre-v3 (content-only) persisted baseline matches nothing: every file it names is a change (fail closed); deletion is still seen', async () => {
    const repo = repoWithIgnored();
    const ledger = LEDGERS[0]![1]();
    const contentSha = (await snapshotCandidate(repo.dir, 'main')).files.find((f) => f.path === DEP)!.sha256!;
    await ledger.evidence({ key: ignoredBaselineKey('run1'), kind: 'gate.verify.baseline.ignored', runId: 'run1', body: { v: 2, entries: { [ignoredPathKey(DEP)]: contentSha }, names: { [ignoredPathKey(DEP)]: DEP } } });
    const legacy = await ignoredBaseline(ledger, new GateMemo(), 'run1');
    expect(legacy!.entries[ignoredPathKey(DEP)]).toBe(`legacy:${contentSha}`);
    expect((await snapshotCandidate(repo.dir, 'main', { ignoredBaseline: legacy })).files.map((f) => f.status)).toEqual(['!']);
    rmSync(join(repo.dir, DEP));
    expect((await snapshotCandidate(repo.dir, 'main', { ignoredBaseline: legacy })).files).toMatchObject([{ status: '!', deleted: true }]);
  });
});

describe.each(LEDGERS)('ignored-file metadata changes across fresh instances and at commit (%s)', (_n, mk) => {
  const make = (ledger: Ledger, repo: Repo) => createGates({ manifest: manifest(), ledger, verifyRunner: new FakeRunner(), reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1' });
  const allSwaps: Swap[] = [
    ...SWAPS,
    [
      'same-hash file → symlink',
      (r) => {
        rmSync(join(r.dir, DEP));
        symlinkSync(TARGET, join(r.dir, DEP));
      },
    ],
  ];

  for (const [name, swap] of allSwaps) {
    it(`${name} BEFORE verify: a fresh instance sees it against the persisted baseline and the commit is refused (8 boundary)`, async () => {
      const repo = repoWithIgnored();
      const ledger = mk();
      expect((await make(ledger, repo).baseline({ runId: 'run1' })).exitCode).toBe(0);
      repo.write('src/a.ts', 'export const a = 2;\n');
      swap(repo);
      // A fresh instance: empty memo, the baseline comes back from the ledger (stamps, not names).
      const g = make(ledger, repo);
      const v = await g.verify(ctx('v', { worktree: repo.dir }));
      expect(v.exitCode).toBe(0);
      const r = await g.review(ctx('r', { worktree: repo.dir, candidate: { d1: v.fingerprint } }));
      const c = await g.commit(ctx('c', { worktree: repo.dir, candidate: { d1: v.fingerprint, d2: r.fingerprint } }));
      // Either the review already refused the ignored change or the commit's boundary check did; never a commit.
      expect(c.exitCode, JSON.stringify(c)).not.toBe(0);
      expect(c.terminal).toBe(true);
      if (r.verdict === 'approve') expect(c).toMatchObject({ exitCode: 8, reason: 'boundary' });
      expect(() => repo.g('rev-parse', '--verify', '--quiet', 'refs/heads/tecera/g1')).toThrow();
    });

    it(`${name} AFTER verify and review: D3 differs, a fresh instance refuses the commit (9)`, async () => {
      const repo = repoWithIgnored();
      const ledger = mk();
      const first = make(ledger, repo);
      expect((await first.baseline({ runId: 'run1' })).exitCode).toBe(0);
      repo.write('src/a.ts', 'export const a = 2;\n');
      const v = await first.verify(ctx('v', { worktree: repo.dir }));
      const r = await first.review(ctx('r', { worktree: repo.dir, candidate: { d1: v.fingerprint } }));
      expect(r.verdict).toBe('approve');
      swap(repo);
      const fresh = make(ledger, repo);
      // The fresh instance finds D1/D2 the way a restarted process does: from the memo the loop events would give.
      fresh.memo.verify.set('run1:i1', first.memo.verify.get('run1:i1')!);
      fresh.memo.review.set('run1:i1', first.memo.review.get('run1:i1')!);
      const c = await fresh.commit(ctx('c', { worktree: repo.dir, candidate: { d1: v.fingerprint, d2: r.fingerprint } }));
      expect(c).toMatchObject({ exitCode: 9, reason: 'digest-drift', terminal: true, failure: 'human' });
    });
  }

  it('control: an untouched ignored file does not block the commit through a fresh instance', async () => {
    const repo = repoWithIgnored();
    const ledger = mk();
    expect((await make(ledger, repo).baseline({ runId: 'run1' })).exitCode).toBe(0);
    repo.write('src/a.ts', 'export const a = 2;\n');
    const g = make(ledger, repo);
    const v = await g.verify(ctx('v', { worktree: repo.dir }));
    const r = await g.review(ctx('r', { worktree: repo.dir, candidate: { d1: v.fingerprint } }));
    expect((await g.commit(ctx('c', { worktree: repo.dir, candidate: { d1: v.fingerprint, d2: r.fingerprint } }))).exitCode).toBe(0);
  });
});
