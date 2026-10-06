import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG_GLOBS, DEFAULT_TEST_GLOBS, snapshotWorktree, tamperFindings } from '@tecera/policy';
import { dump, Flow, sampleRepo } from './harness/e2e.js';
import { createGates } from '@tecera/gates';
import { branchExists, driveToCommit, gateRig, manifest, NOW, plan, StubReviewer, StubRunner, WRITERS, type GateRig, type Repo } from './harness/gates.js';
import { expectGap } from './harness/gap.js';
import { cleanupTemps, onDrvFs, tmp } from './harness/tmp.js';

/**
 * security.md §6 tamper.*: edits that weaken the gate instead of fixing the code. Driven through the REAL
 * gates (createGates: verify → review → verify → approved commit) over a real git repository; the commit
 * gate must refuse on its own (exit 8/9, no branch, no commit). Policy-level checks are asserted as well.
 */

afterAll(cleanupTemps);
/** Symlink and nlink fidelity are unreliable on DrvFs (/mnt/*): the link case is environment-skipped there. */
const TMP_ON_DRVFS = onDrvFs(tmpdir());

async function commitEvidence(rig: GateRig, key: string): Promise<string> {
  return JSON.stringify((await rig.ledger.getEvidence(key))?.body ?? null);
}

/**
 * Two layers. (1) The gates as the loop drives them must refuse (whichever gate catches it: no commit, no
 * branch). (2) Defence in depth: with a compromised review (forced approve of D1), the COMMIT gate must
 * still refuse on its own; its evidence is returned so the caller can assert the specific finding code.
 */
async function refused(make: () => GateRig | Promise<GateRig>): Promise<string> {
  const a = await make();
  const first = await driveToCommit(a);
  expect(first.c.exitCode, `verify ${first.v.outcome} review ${first.r.verdict}/${first.r.reason}`).not.toBe(0);
  expect(first.c.sha).toBeUndefined();
  expect(branchExists(a.repo)).toBe(false);
  const b = await make();
  const { c, v } = await driveToCommit(b, { compromisedReview: true });
  const ev = await commitEvidence(b, c.evidenceKey);
  expect(c.exitCode, `verify ${v.outcome}/${v.reason} commit ${ev}`).not.toBe(0);
  expect(c.sha).toBeUndefined();
  expect(branchExists(b.repo)).toBe(false);
  expect(ev).not.toMatch(/review-not-approved/);
  return ev;
}

const hookMarkerDir = (): string => {
  const d = tmp('tecera-adv-hookmark-');
  chmodSync(d, 0o777);
  return d;
};

/** Plant executable hooks that each drop a marker file if git ever runs them. */
function plantHooks(hooksDir: string, markers: string, names: string[]): void {
  mkdirSync(hooksDir, { recursive: true });
  for (const n of names) {
    const p = join(hooksDir, n);
    writeFileSync(p, `#!/bin/sh\ntouch ${JSON.stringify(join(markers, n))}\nexit 0\n`);
    chmodSync(p, 0o755);
  }
}
/** Positive control: a planted hook, run directly, does drop its marker (so "no marker" means "never ran"). */
function hookWorks(hook: string, marker: string): void {
  expect(existsSync(marker), `${marker} present before the control`).toBe(false);
  execFileSync(hook, [], { stdio: 'ignore' });
  expect(existsSync(marker), `control: running ${hook} directly drops its marker`).toBe(true);
}
const HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'post-checkout', 'reference-transaction', 'post-index-change', 'pre-push', 'post-rewrite'];

describe('tamper (security.md §6)', () => {
  it('tamper.delete_test', async () => {
    const ev = await refused(() => gateRig({ change: (r) => (r.write('src/a.ts', 'export const a = 2;\n'), unlinkSync(join(r.dir, 'src/a.test.ts'))) }));
    expect(ev).toMatch(/deleted-test/);
    expect(tamperFindings([{ path: 'src/a.test.ts', status: 'D' }], [], { testGlobs: DEFAULT_TEST_GLOBS, configGlobs: DEFAULT_CONFIG_GLOBS, testsReadOnly: false }).map((f) => f.code)).toContain('deleted-test');
  });

  it('tamper.only_skip', async () => {
    for (const focus of ["it.only('a', () => {});", "describe.skip('a', () => {});", "xit('a', () => {});", "test.todo('a');", "fit('a', () => {});"]) {
      // a NEW test file (added tests are not "modified tests"), on a plan that may write tests
      const ev = await refused(() => gateRig({ p: plan({ write: ['src/**'] }), change: (r) => (r.write('src/a.ts', 'export const a = 2;\n'), r.write('src/b.test.ts', `import { it, describe, test, xit, fit } from 'vitest';\n${focus}\n`)) }));
      expect(ev, focus).toMatch(/focus-or-skip/);
    }
    const f = tamperFindings([], [{ path: 'src/a.test.ts', added: ['  it.only("x", () => {})'] }], { testGlobs: DEFAULT_TEST_GLOBS, configGlobs: DEFAULT_CONFIG_GLOBS, testsReadOnly: false });
    expect(f.map((x) => x.code)).toContain('focus-or-skip');
  });

  it('tamper.config_edit', async () => {
    // even when the manifest and the plan allow the paths, gate/toolchain config and package.json#scripts are refused
    const allow = ['src/**', 'vitest.config.ts', 'package.json'];
    const m = manifest({ repo: { base: 'main', branchPrefix: 'tecera/', allowedChanges: allow } });
    expect(await refused(() => gateRig({ m, p: plan({ write: allow }), change: (r) => (r.write('src/a.ts', 'export const a = 2;\n'), r.write('vitest.config.ts', 'export default { test: { include: [] } };\n')) }))).toMatch(/config-edit/);
    expect(await refused(() => gateRig({ m, p: plan({ write: allow }), change: (r) => (r.write('src/a.ts', 'export const a = 2;\n'), r.write('package.json', '{\n  "name": "x",\n  "scripts": {\n    "test": "true"\n  }\n}\n')) }))).toMatch(/scripts-edit/);
  });

  it.skipIf(TMP_ON_DRVFS)('tamper.symlink_hardlink', async () => {
    const outside = join(tmp('tecera-adv-outside-'), 'secret.ts');
    writeFileSync(outside, 'export const leaked = true;\n');
    expect(await refused(() => gateRig({ change: (r) => (r.write('src/a.ts', 'export const a = 2;\n'), symlinkSync('../../', join(r.dir, 'src/up'))) }))).toMatch(/symlink/);
    expect(await refused(() => gateRig({ change: (r) => (r.write('src/a.ts', 'export const a = 2;\n'), symlinkSync(outside, join(r.dir, 'src/b.ts'))) }))).toMatch(/symlink/);
    // a hard link to a file outside the worktree, and one aliasing a protected file inside it
    expect(await refused(() => gateRig({ change: (r) => (r.write('src/a.ts', 'export const a = 2;\n'), linkSync(outside, join(r.dir, 'src/h.ts'))) }))).toMatch(/hardlink|nlink/);
    expect(await refused(() => gateRig({ change: (r) => (r.write('src/a.ts', 'export const a = 2;\n'), linkSync(join(r.dir, 'package.json'), join(r.dir, 'src/pkg.json'))) }))).toMatch(/hardlink|nlink/);
  });

  it('tamper.ignored_file', async () => {
    // an ignored file appearing after the run's baseline is part of the snapshot and fails the gate
    for (const [path, content] of [['.env', 'API_TOKEN=x\n'], ['ignored/blob.bin', Buffer.from([0, 1, 2, 3, 0, 255])], ['debug.log', 'x\n']] as const) {
      const probe = gateRig({ change: (r) => r.write('src/a.ts', 'export const a = 2;\n') });
      const before = await snapshotWorktree(probe.repo.dir, 'main');
      probe.repo.write(path, content);
      const after = await snapshotWorktree(probe.repo.dir, 'main');
      expect(after.fingerprint, path).not.toBe(before.fingerprint);
      expect(after.changes.some((c) => c.path === path && c.status === '!'), path).toBe(true);
      const ev = await refused(async () => {
        const rig = gateRig({});
        // the baseline (untouched tree) is recorded first, as the run does; then the worker's writes land
        const b = await rig.gates.baseline({ runId: 'run1', worktree: rig.repo.dir });
        expect(['passed', 'failed']).toContain(b.outcome);
        rig.repo.write('src/a.ts', 'export const a = 2;\n');
        rig.repo.write(path, content);
        return rig;
      });
      expect(ev, path).toMatch(/ignored/);
    }
    // written between review and commit (after D1): D3 differs and the commit is refused
    const late = gateRig({});
    await late.gates.baseline({ runId: 'run1', worktree: late.repo.dir });
    late.repo.write('src/a.ts', 'export const a = 2;\n');
    const { c } = await driveToCommit(late, { beforeCommit: () => late.repo.write('.env', 'LATE=1\n') });
    expect(c.exitCode).not.toBe(0);
    expect(branchExists(late.repo)).toBe(false);
  });

  it.skipIf(TMP_ON_DRVFS)('tamper.ignored_file [metadata only, fresh gate instances]: an ignored file present at the baseline keeps its bytes but gains +x, becomes a symlink or a hard link to an outside file with the same bytes → the commit is refused, also by gates rebuilt over the same ledger (a restart)', async () => {
    const TOOL = 'ignored/tool.sh';
    const BYTES = '#!/bin/sh\necho build\n';
    const outside = (): string => {
      const f = join(tmp('tecera-adv-outside-'), 'tool.sh');
      writeFileSync(f, BYTES);
      return f;
    };
    const attacks: Array<[string, (r: Repo) => void]> = [
      ['chmod +x', (r) => chmodSync(join(r.dir, TOOL), 0o755)],
      ['symlink, same bytes', (r) => (rmSync(join(r.dir, TOOL)), symlinkSync(outside(), join(r.dir, TOOL)))],
      ['hard link, same bytes', (r) => (rmSync(join(r.dir, TOOL)), linkSync(outside(), join(r.dir, TOOL)))],
    ];
    for (const [name, attack] of attacks) {
      for (const fresh of [false, true]) {
        const ev = await refused(async () => {
          const rig = gateRig({});
          rig.repo.write(TOOL, BYTES);
          chmodSync(join(rig.repo.dir, TOOL), 0o644);
          // the attack setup is real: the file is ignored (never committed) and part of the run's baseline
          expect(rig.repo.g('check-ignore', TOOL).trim(), name).toBe(TOOL);
          const b = await rig.gates.baseline({ runId: 'run1', worktree: rig.repo.dir });
          expect(['passed', 'failed'], name).toContain(b.outcome);
          rig.repo.write('src/a.ts', 'export const a = 2;\n');
          attack(rig.repo);
          expect(readFileSync(join(rig.repo.dir, TOOL), 'utf8'), `${name}: same bytes`).toBe(BYTES);
          if (!fresh) return rig;
          // a restart: new gate instances over the SAME ledger (the baseline lives only there)
          const gates = createGates({ manifest: manifest(), ledger: rig.ledger, verifyRunner: new StubRunner(), reviewer: new StubReviewer('openai'), writers: WRITERS, worktree: rig.repo.dir, now: () => NOW, sessionId: 's1' });
          return { ...rig, gates };
        });
        expect(ev, `${name}${fresh ? ' (fresh gates)' : ''}`).toMatch(/ignored/);
      }
    }
  });

  it.skipIf(TMP_ON_DRVFS)('tamper.symlink_hardlink [unchanged tracked file] GAP (owner: gates candidate.ts): a tracked file the candidate does not change is replaced by a hard link to an outside file with the SAME bytes → the commit gate must still refuse the link', async () => {
    const make = (): GateRig => {
      const rig = gateRig({ files: { 'src/b.ts': 'export const b = 1;\n' } });
      rig.repo.write('src/a.ts', 'export const a = 2;\n');
      const out = join(tmp('tecera-adv-outside-'), 'b.ts');
      writeFileSync(out, 'export const b = 1;\n');
      rmSync(join(rig.repo.dir, 'src/b.ts'));
      linkSync(out, join(rig.repo.dir, 'src/b.ts'));
      return rig;
    };
    // the attack setup is real: src/b.ts is unchanged for git, and it is a second name of an outside inode
    const probe = make();
    expect(probe.repo.g('status', '--porcelain', '--', 'src/b.ts').trim()).toBe('');
    expect(statSync(join(probe.repo.dir, 'src/b.ts')).nlink).toBe(2);
    const { c } = await driveToCommit(make(), { compromisedReview: true });
    await expectGap('tamper.symlink_hardlink [unchanged tracked file]', 'gates candidate.ts (check link metadata before the unchanged-tracked exemption)', { assertion: 'the commit gate refuses a hard-linked unchanged tracked file' }, () => {
      expect(c.exitCode, 'the commit gate refuses a hard-linked unchanged tracked file').not.toBe(0);
    });
  });

  it('tamper.git_hook', async () => {
    // (a) hooks present in .git/hooks and .husky (not configured): the gate commits with plumbing, no hook runs,
    //     and the committed tree equals the reviewed tree.
    const markers = hookMarkerDir();
    const rig = gateRig({
      files: { '.husky/pre-commit': `#!/bin/sh\ntouch ${JSON.stringify(join(markers, 'husky'))}\n` },
      change: (r: Repo) => {
        plantHooks(join(r.dir, '.git/hooks'), markers, HOOKS);
        r.write('src/a.ts', 'export const a = 2;\n');
      },
    });
    const { c, v } = await driveToCommit(rig);
    const ev = (await rig.ledger.getEvidence(c.evidenceKey))?.body as Record<string, unknown> | undefined;
    expect(c.exitCode, JSON.stringify(ev)).toBe(0);
    expect(existsSync(join(markers, 'husky'))).toBe(false);
    for (const h of HOOKS) expect(existsSync(join(markers, h)), h).toBe(false);
    hookWorks(join(rig.repo.dir, '.git/hooks/post-commit'), join(markers, 'post-commit'));
    expect(rig.repo.g('rev-parse', 'HEAD^{tree}').trim()).toBe(ev?.tree);
    expect((ev?.fingerprints as Record<string, string>).d1).toBe(v.fingerprint);
    expect((ev?.fingerprints as Record<string, string>).d3).toBe(v.fingerprint);

    // (b) the repository itself configures a hooks path (or a filter): refused before git runs anything
    const markers2 = hookMarkerDir();
    const cfg = gateRig({
      change: (r: Repo) => {
        plantHooks(join(r.dir, '.husky'), markers2, HOOKS);
        r.g('config', 'core.hooksPath', '.husky');
        r.write('src/a.ts', 'export const a = 2;\n');
      },
    });
    const res = await driveToCommit(cfg);
    expect(res.c.exitCode).not.toBe(0);
    expect(branchExists(cfg.repo)).toBe(false);
    for (const h of HOOKS) expect(existsSync(join(markers2, h)), h).toBe(false);
    const filt = gateRig({
      change: (r: Repo) => {
        r.write('.gitattributes', '*.ts filter=evil\n');
        r.g('config', 'filter.evil.clean', `touch ${JSON.stringify(join(markers2, 'filter'))}; cat`);
        r.write('src/a.ts', 'export const a = 2;\n');
      },
    });
    const fr = await driveToCommit(filt);
    expect(fr.c.exitCode).not.toBe(0);
    expect(existsSync(join(markers2, 'filter'))).toBe(false);
  });

  it('tamper.git_hook [runtime e2e]: a repository full of hooks; tecera run → approve → resume never runs one', async () => {
    const markers = hookMarkerDir();
    const { dir, wt } = await sampleRepo({
      mutate: (d) => {
        mkdirSync(join(d, '.husky'), { recursive: true });
        writeFileSync(join(d, '.husky/pre-commit'), `#!/bin/sh\ntouch ${JSON.stringify(join(markers, 'husky'))}\n`);
      },
      afterCommit: (d) => plantHooks(join(d, '.git/hooks'), markers, HOOKS),
    });
    const flow = new Flow(dir, wt);
    const held = await flow.drive();
    expect(held.code, held.err + held.out + (await dump(dir))).toBe(4);
    const done = await flow.finish();
    expect(done.code, done.err + done.out + (await dump(dir))).toBe(0);
    const evs = await flow.events();
    // the attack setup is real: the hooks are in place and executable, and git did make the commit
    for (const h of HOOKS) expect(statSync(join(dir, '.git/hooks', h)).mode & 0o111, h).toBeTruthy();
    expect(evs.find((e) => e.kind === 'commit.recorded')?.payload).toMatchObject({ valid: true });
    for (const h of [...HOOKS, 'husky']) expect(existsSync(join(markers, h)), `${h} ran`).toBe(false);
    hookWorks(join(dir, '.git/hooks/pre-commit'), join(markers, 'pre-commit'));
    rmSync(markers, { recursive: true, force: true });
  }, 240_000);
});
