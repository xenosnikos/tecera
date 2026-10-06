import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { event, makeRedactor, parseManifest, type Manifest, type TeceraEvent } from '@tecera/contracts';
import { MemoryLedger, SqliteLedger } from '@tecera/ledger';
import { DEFAULT_PERMISSIONS } from '@tecera/policy';
import { buildVerifyEnv, reviewAllowlist, UnsafeEnvError } from './env.js';
import { decideBash, decidePreTool, type HookContext } from './hook.js';
import { RedactingLedger } from './redactingLedger.js';
import { inspectPath, safeReadFile, safeWriteFile, UnsafePathError, walkTree } from './util/safefs.js';
import { HostVerifyRunner, toolingProblem } from './verify.js';
import { PlannedFs } from './vfs.js';
import { scanSkips } from './manifest/validate.js';
import { assertLedgerPath } from './runtime.js';
import { evidenceFileName, evidenceKeys } from './commands/evidence.js';
import { readFileSync as rf } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'tecera-sec-'));
  temps.push(d);
  return d;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_MANIFEST: Manifest = parseManifest(JSON.parse(rf(resolve(HERE, '../../../samples/fix-failing-test/tecera.json'), 'utf8')));

// ---------- filesystem containment ----------

describe('tamper.symlink_hardlink: contained reads and writes (vfs, safefs)', () => {
  it('refuses symlinked targets, symlinked parents, dangling links and hard links; the outside file is untouched', () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'victim.txt'), 'original');
    symlinkSync(join(outside, 'victim.txt'), join(root, 'CLAUDE.md'));
    symlinkSync(outside, join(root, '.claude'));
    symlinkSync(join(outside, 'nope.txt'), join(root, 'AGENTS.md')); // dangling
    writeFileSync(join(root, 'real.txt'), 'x');
    linkSync(join(outside, 'victim.txt'), join(root, 'hard.txt'));

    expect(() => safeWriteFile(root, 'CLAUDE.md', 'pwned')).toThrow(UnsafePathError);
    expect(() => safeWriteFile(root, '.claude/settings.json', 'pwned')).toThrow(/symbolic link/);
    expect(() => safeWriteFile(root, 'AGENTS.md', 'pwned')).toThrow(/symbolic link/);
    expect(() => safeWriteFile(root, 'hard.txt', 'pwned')).toThrow(/hard link/);
    expect(() => safeReadFile(root, 'CLAUDE.md')).toThrow(UnsafePathError);
    expect(() => safeWriteFile(root, '../escape.txt', 'x')).toThrow(/traversal/);
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('original');
    expect(existsSync(join(outside, 'settings.json'))).toBe(false);
    expect(existsSync(join(outside, 'nope.txt'))).toBe(false);

    // PlannedFs stages, then apply refuses through the same checks
    const fs = new PlannedFs(root);
    expect(() => fs.read('CLAUDE.md')).toThrow(UnsafePathError);
    expect(() => fs.exists('.claude/settings.json')).toThrow(UnsafePathError);
    fs.write('ok/new.txt', 'fine', 'test');
    fs.apply();
    expect(readFileSync(join(root, 'ok/new.txt'), 'utf8')).toBe('fine');
    safeWriteFile(root, 'real.txt', 'replaced');
    expect(readFileSync(join(root, 'real.txt'), 'utf8')).toBe('replaced');
  });

  it('hard-linked READS are refused too (an adapter source or authority file aliased to another file)', () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'secret.txt'), 'outside the root');
    mkdirSync(join(root, '.tecera/protocols'), { recursive: true });
    linkSync(join(outside, 'secret.txt'), join(root, '.tecera/protocols/permissions.json'));
    expect(() => safeReadFile(root, '.tecera/protocols/permissions.json')).toThrow(/hard link/);
    const fs = new PlannedFs(root);
    expect(() => fs.read('.tecera/protocols/permissions.json')).toThrow(UnsafePathError);
    writeFileSync(join(root, 'plain.txt'), 'fine');
    expect(safeReadFile(root, 'plain.txt')?.toString()).toBe('fine');
  });

  it('walkTree exclusions are exact relative paths of single-link regular files: a directory, link or hard link with that name is walked and reported', () => {
    const root = tmp();
    mkdirSync(join(root, 'memory/ledger.sqlite'), { recursive: true });
    writeFileSync(join(root, 'memory/ledger.sqlite/hidden.md'), 'x');
    writeFileSync(join(root, 'ledger.sqlite'), 'db');
    writeFileSync(join(root, 'other.txt'), 'o');
    linkSync(join(root, 'other.txt'), join(root, 'ledger.sqlite-wal'));
    symlinkSync('/etc/hostname', join(root, 'ledger.sqlite-shm'));
    const w = walkTree(root, new Set(['ledger.sqlite', 'ledger.sqlite-wal', 'ledger.sqlite-shm', 'memory/ledger.sqlite']));
    expect(w.files).toContain('memory/ledger.sqlite/hidden.md'); // a same-named directory deeper is NOT skipped
    expect(w.files).not.toContain('ledger.sqlite'); // the exact single-link file is
    expect(w.files).toContain('ledger.sqlite-wal'); // hard-linked: scanned anyway
    expect(w.links).toContain('ledger.sqlite-shm');
    expect(w.refusedSkips.map((x) => x.path).sort()).toEqual(['ledger.sqlite-shm', 'ledger.sqlite-wal', 'memory/ledger.sqlite']);
    expect(scanSkips('.tecera/ledger.sqlite')).toEqual(new Set(['ledger.sqlite', 'ledger.sqlite-wal', 'ledger.sqlite-shm', 'ledger.sqlite-journal']));
    expect(scanSkips('/abs/ledger.sqlite').size).toBe(0);
    expect(scanSkips('elsewhere/ledger.sqlite').size).toBe(0);
  });

  it('the ledger database path, its parents and its sidecars must not be links or hard links (before and after open)', () => {
    const root = tmp();
    const outside = tmp();
    // symlinked parent directory
    symlinkSync(outside, join(root, '.tecera'));
    expect(() => assertLedgerPath(root, join(root, '.tecera/ledger.sqlite'), true)).toThrow(/symbolic link/);
    rmSync(join(root, '.tecera'));
    mkdirSync(join(root, '.tecera'));
    // symlinked database file
    writeFileSync(join(outside, 'victim.sqlite'), '');
    symlinkSync(join(outside, 'victim.sqlite'), join(root, '.tecera/ledger.sqlite'));
    expect(() => assertLedgerPath(root, join(root, '.tecera/ledger.sqlite'), true)).toThrow(/symbolic link/);
    rmSync(join(root, '.tecera/ledger.sqlite'));
    // hard-linked database file
    linkSync(join(outside, 'victim.sqlite'), join(root, '.tecera/ledger.sqlite'));
    expect(() => assertLedgerPath(root, join(root, '.tecera/ledger.sqlite'), true)).toThrow(/hard links/);
    rmSync(join(root, '.tecera/ledger.sqlite'));
    // symlinked WAL sidecar
    symlinkSync(join(outside, 'wal'), join(root, '.tecera/ledger.sqlite-wal'));
    expect(() => assertLedgerPath(root, join(root, '.tecera/ledger.sqlite'), true)).toThrow(/ledger.sqlite-wal/);
    rmSync(join(root, '.tecera/ledger.sqlite-wal'));
    // a directory where the database should be
    mkdirSync(join(root, '.tecera/ledger.sqlite'));
    expect(() => assertLedgerPath(root, join(root, '.tecera/ledger.sqlite'), true)).toThrow(/not a regular file/);
    rmSync(join(root, '.tecera/ledger.sqlite'), { recursive: true });
    expect(() => assertLedgerPath(root, join(root, '.tecera/ledger.sqlite'), true)).not.toThrow();
    // absolute path outside the root: the files themselves must not be links
    symlinkSync(join(outside, 'victim.sqlite'), join(outside, 'abs.sqlite'));
    expect(() => assertLedgerPath(root, join(outside, 'abs.sqlite'), true)).toThrow(/link/);
    expect(readFileSync(join(outside, 'victim.sqlite'), 'utf8')).toBe('');
  });

  it('walkTree never follows links and reports them', () => {
    const root = tmp();
    mkdirSync(join(root, 'a'));
    writeFileSync(join(root, 'a/f.txt'), 'x');
    symlinkSync('/etc', join(root, 'a/etc'));
    const w = walkTree(root);
    expect(w.files).toEqual(['a/f.txt']);
    expect(w.links).toEqual(['a/etc']);
    expect(inspectPath(root, 'a/f.txt')).toMatchObject({ exists: true, kind: 'file', nlink: 1 });
  });
});

// ---------- host hook ----------

function hookCtx(root: string, gitHazards: readonly string[] = []): HookContext {
  return { root, manifest: SAMPLE_MANIFEST, permissions: DEFAULT_PERMISSIONS, cwd: root, checkCommands: ['node --test test/slugify.test.js'], gitHazards: () => gitHazards };
}

describe('host hook: links, protected aliases and mediated Bash', () => {
  it('tamper.symlink_hardlink: a permitted src/ path that is a link (live or dangling) or a hard link is blocked', () => {
    const root = tmp();
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'test/slugify.test.js'), 'test');
    writeFileSync(join(root, 'src/ok.js'), 'ok');
    symlinkSync(join(root, 'test/slugify.test.js'), join(root, 'src/alias.js'));
    symlinkSync(join(root, 'test/new.test.js'), join(root, 'src/dangling.js'));
    symlinkSync(join(root, 'test'), join(root, 'src/dir'));
    linkSync(join(root, 'test/slugify.test.js'), join(root, 'src/hard.js'));
    const edit = (p: string) => decidePreTool({ tool_name: 'Write', tool_input: { file_path: p }, cwd: root }, hookCtx(root));
    expect(edit('src/ok.js')).toEqual({ allow: true });
    expect(edit('src/brand-new.js')).toEqual({ allow: true });
    for (const p of ['src/alias.js', 'src/dangling.js', 'src/dir/slugify.test.js', 'src/dir/new.js', 'src/hard.js']) {
      const d = edit(p);
      expect(d.allow, p).toBe(false);
    }
    expect((edit('src/dangling.js') as { reason: string }).reason).toMatch(/symbolic link/);
    expect((edit('src/hard.js') as { reason: string }).reason).toMatch(/hard links/);
  });

  it('tamper.config_edit / tamper.ignored_file: host and tecera configuration, git internals and env files are never editable', () => {
    const root = tmp();
    const m = { ...SAMPLE_MANIFEST, repo: { ...SAMPLE_MANIFEST.repo, allowedChanges: ['**'] }, policy: { ...SAMPLE_MANIFEST.policy, protectedPaths: [] } } as Manifest;
    const ctx = { ...hookCtx(root), manifest: m };
    for (const p of ['tecera.json', '.tecera/ledger.sqlite', '.tecera/protocols/permissions.json', '.claude/settings.json', 'CLAUDE.md', '.git/config', '.git/hooks/pre-commit', '.gitignore', '.env', 'src/.env.local', '.husky/pre-commit']) {
      const d = decidePreTool({ tool_name: 'Edit', tool_input: { file_path: p }, cwd: root }, ctx);
      expect(d.allow, p).toBe(false);
    }
    expect(decidePreTool({ tool_name: 'Edit', tool_input: { file_path: 'src/x.js' }, cwd: root }, ctx)).toEqual({ allow: true });
  });

  it('Bash: writes, deletes, config edits and approvals through the shell are refused; read-only and verify commands run', () => {
    const root = tmp();
    const ctx = hookCtx(root);
    const refused = [
      'printf compromised > test/slugify.test.js',
      'rm test/slugify.test.js',
      'rm -rf .tecera',
      'sed -i s/a/b/ tecera.json',
      'echo {} > .claude/settings.json',
      'tecera approve ap_1 --as bob',
      'tecera plans graduate p_1 --rationale x',
      'tecera doctor --fix',
      'TECERA_ALLOW_LOCAL_APPROVER=1 tecera approve ap_1',
      'node -e "require(\'fs\').unlinkSync(\'test/x\')"',
      'node --test && rm test/x',
      'npm test',
      'cat a | tee test/x',
      'git checkout -- test',
      'git -c core.pager=sh log',
      'git push origin main',
      'find . -name "*.test.js" -delete',
      'find . -exec rm {} ;',
      'sort -o test/x src/y',
      'rg --pre ./evil pattern',
      'git grep -Oless foo',
      'git branch -D main',
      'cp src/a test/b',
      'mv test/a src/a',
      'ls $(rm -rf test)',
      'ls `rm x`',
      "echo 'unbalanced",
      'env',
      'printenv',
    ];
    for (const cmd of refused) expect(decideBash(cmd, ctx).allow, cmd).toBe(false);
    for (const cmd of [SAMPLE_MANIFEST.verify.command, 'node --test test/slugify.test.js', 'git status --porcelain', 'git diff HEAD', 'git log --oneline -5', 'ls -la src', 'cat src/slugify.js', 'grep -rn slug src', 'find src -name "*.js"', 'tecera gate fix-failing-test', 'tecera status --json']) {
      expect(decideBash(cmd, ctx), cmd).toEqual({ allow: true });
    }
    // D6: pushing and opening PRs belong to the PR gate (requiresApproval, consumed by the gate); merging is never
    expect((decideBash('git push origin main', ctx) as { reason: string }).reason).toMatch(/git_push is done only by the PR gate/);
    expect((decideBash('gh pr create --fill', ctx) as { reason: string }).reason).toMatch(/open_pr is done only by the PR gate/);
    expect((decideBash('gh pr merge 7', ctx) as { reason: string }).reason).toMatch(/merge is in permissions.never/);
    expect((decideBash('git merge tecera/fix-failing-test', ctx) as { reason: string }).reason).toMatch(/merge is in permissions.never/);
  });

  it('Bash: attached, clustered and abbreviated options cannot write files or run programs (sort, git, rg)', () => {
    const root = tmp();
    const ctx = hookCtx(root);
    const refused = [
      // sort writes with -o in every spelling GNU getopt accepts
      'sort -otest/slugify.test.js src/slugify.js',
      'sort -uotest/slugify.test.js src/slugify.js',
      'sort -o test/x src/y',
      'sort --output=test/x src/y',
      'sort --outp=test/x src/y',
      'sort --out test/x src/y',
      'sort --compress-program=sh src/y',
      'sort --compress-prog=sh src/y',
      'sort -T /tmp src/y',
      // git: config, pager and exec-path options before the subcommand, attached or not
      'git -ccore.pager=sh --paginate log',
      'git -c core.pager=sh log',
      'git -p log',
      'git --paginate log',
      'git -C .. status',
      'git --exec-path=/tmp status',
      'git --git-dir=/tmp/x status',
      'git --config-env=core.pager=X log',
      // git: writing / program-running options after the subcommand, abbreviated
      'git log --output=test/x',
      'git log --outp=test/x',
      'git diff --ext-diff',
      'git diff --ext',
      'git show --textconv HEAD',
      'git show --textc HEAD',
      'git grep -Oless foo',
      'git grep -iO less foo',
      'git grep --open-files-in-pager=less foo',
      'git grep --open foo',
      'git branch --set-upstream-to=x',
      // rg: preprocessors and decompressors run programs
      'rg --pre ./evil pattern',
      'rg --pre=./evil pattern',
      'rg --pre-glob "*" pattern',
      'rg -z pattern',
      'rg -iz pattern',
      'rg --search-zip pattern',
      'rg --search-z pattern',
    ];
    for (const cmd of refused) expect(decideBash(cmd, ctx).allow, cmd).toBe(false);
    for (const cmd of ['sort -u src/slugify.js', 'sort -r -n src/y', 'git --no-pager log --oneline', 'git -P diff --stat', 'git log --no-ext-diff -p', 'git diff --cached --name-only', 'git grep -n -o foo', 'rg -n foo src']) {
      expect(decideBash(cmd, ctx), cmd).toEqual({ allow: true });
    }
  });

  it('Bash: host git runs with the user config, so any program-running config key (any scope) refuses git; pager keys only without --no-pager; no probe → refused', () => {
    const root = tmp();
    const fsmonitor = hookCtx(root, ['core.fsmonitor']);
    expect(decideBash('git status', fsmonitor).allow).toBe(false);
    expect((decideBash('git --no-pager status', fsmonitor) as { reason: string }).reason).toMatch(/core\.fsmonitor/);
    for (const k of ['diff.external', 'diff.evil.textconv', 'filter.x.clean', 'env:GIT_EXTERNAL_DIFF', 'gpg.program', 'git config could not be listed (exit 1)']) {
      expect(decideBash('git diff HEAD', hookCtx(root, [k])).allow, k).toBe(false);
    }
    const pager = hookCtx(root, ['core.pager', 'env:PAGER']);
    expect(decideBash('git log --oneline', pager).allow).toBe(false);
    expect(decideBash('git --no-pager log --oneline', pager)).toEqual({ allow: true });
    expect(decideBash('git -P log --oneline', pager)).toEqual({ allow: true });
    const unprobed = { ...hookCtx(root) };
    delete (unprobed as { gitHazards?: unknown }).gitHazards;
    expect(decideBash('git status', unprobed).allow).toBe(false);
    // non-git commands do not need the probe
    expect(decideBash('ls src', unprobed)).toEqual({ allow: true });
  });

  it('unknown tools (MCP, custom) are refused; read-only host tools pass', () => {
    const root = tmp();
    expect(decidePreTool({ tool_name: 'mcp__fs__write_file', tool_input: { path: 'test/x' } }, hookCtx(root)).allow).toBe(false);
    expect(decidePreTool({ tool_name: 'Read', tool_input: { file_path: 'test/x' } }, hookCtx(root)).allow).toBe(true);
    expect(decidePreTool({ tool_name: 'Grep', tool_input: { pattern: 'x' } }, hookCtx(root)).allow).toBe(true);
  });
});

// ---------- verify environment and runner ----------

describe('verify environment: SAFE_ENV only, unsafe requests refused', () => {
  it('refuses credential-like and loader-injection names; ignores names off SAFE_ENV; drops secret-bearing values', () => {
    const review = reviewAllowlist(['PATH', 'HOME', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'LD_PRELOAD', 'GITHUB_TOKEN', 'MY_FLAG', 'TECERA_CANARY_X', 'BASH_ENV']);
    expect(review.unsafe.map((u) => u.name).sort()).toEqual(['ANTHROPIC_API_KEY', 'BASH_ENV', 'GITHUB_TOKEN', 'LD_PRELOAD', 'NODE_OPTIONS', 'TECERA_CANARY_X']);
    expect(review.ignored).toEqual(['MY_FLAG']);
    expect(() => buildVerifyEnv({ ANTHROPIC_API_KEY: 'x' }, ['PATH', 'ANTHROPIC_API_KEY'])).toThrow(UnsafeEnvError);
    const secret = 'TECERA_CANARY_homeleak_0001';
    const r = makeRedactor([{ kind: 'canary', value: secret }]);
    const v = buildVerifyEnv({ PATH: '/usr/bin:/bin', HOME: `/home/${secret}`, MY_FLAG: '1', CI: 'true' }, ['PATH', 'HOME', 'MY_FLAG', 'CI'], r);
    expect(v.env).toEqual({ PATH: '/usr/bin:/bin', CI: 'true' });
    expect(v.dropped.sort()).toEqual(['HOME', 'MY_FLAG']);
  });

  it('HostVerifyRunner refuses an unsafe allowlist before spawning anything', async () => {
    const dir = tmp();
    const runner = new HostVerifyRunner({ PATH: process.env.PATH, NODE_OPTIONS: '--require ./evil.js' });
    await expect(runner.run({ cwd: dir, command: 'touch spawned', timeoutSec: 5, envAllowlist: ['PATH', 'NODE_OPTIONS'] })).rejects.toThrow(UnsafeEnvError);
    expect(existsSync(join(dir, 'spawned'))).toBe(false);
  });

  it('the verify child sees only the granted names (no credentials, no canaries)', async () => {
    const dir = tmp();
    const env = { PATH: process.env.PATH, HOME: dir, ANTHROPIC_API_KEY: 'test-anthropic-credential-0123456789', TECERA_CANARY_V: 'TECERA_CANARY_V_abcdef01', SECRET_THING: 'hidden-value-123456' };
    const o = await new HostVerifyRunner(env).run({ cwd: dir, command: 'env', timeoutSec: 10, envAllowlist: ['PATH', 'HOME', 'CI'] });
    expect(o.exitCode).toBe(0);
    const names = o.stdout.split('\n').map((l) => l.split('=')[0]).filter(Boolean).sort();
    for (const n of names) expect(['HOME', 'PATH', 'PWD', 'SHLVL', 'OLDPWD', '_']).toContain(n);
    expect(o.stdout).not.toContain('test-anthropic-credential');
    expect(o.stdout).not.toContain('TECERA_CANARY_V_abcdef01');
    expect(o.stdout).not.toContain('hidden-value');
  });
});

describe('dos.output_flood and interruption: the default verifier', () => {
  it('an already-aborted signal never spawns', async () => {
    const dir = tmp();
    const ac = new AbortController();
    ac.abort();
    const o = await new HostVerifyRunner({ PATH: process.env.PATH }).run({ cwd: dir, command: 'touch ran', timeoutSec: 5, envAllowlist: ['PATH'] }, ac.signal);
    expect(existsSync(join(dir, 'ran'))).toBe(false);
    expect(o.cancelled).toBe(true);
    expect(toolingProblem(o)).toBe('cancelled');
  });

  it('output beyond the cap kills the process group and is never a pass, even when the shell would exit 0', async () => {
    const dir = tmp();
    const started = Date.now();
    const o = await new HostVerifyRunner({ PATH: process.env.PATH }, { maxOutputBytes: 64 * 1024 }).run({ cwd: dir, command: 'yes flood; exit 0', timeoutSec: 20, envAllowlist: ['PATH'] });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(o.truncated).toBe(true);
    expect(o.stdout.length).toBeLessThanOrEqual(64 * 1024);
    expect(o.exitCode).toBeNull();
    expect(toolingProblem(o)).toMatch(/output exceeded the cap/);
  });

  it('background descendants do not outlive the check', async () => {
    const dir = tmp();
    const o = await new HostVerifyRunner({ PATH: process.env.PATH }).run({ cwd: dir, command: 'sleep 30 & echo $!; exit 0', timeoutSec: 10, envAllowlist: ['PATH'] });
    const pid = Number(o.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
    expect(o.descendantsSurvived).toBe(false);
  });

  it('a timeout kills the group and is a tooling problem', async () => {
    const o = await new HostVerifyRunner({ PATH: process.env.PATH }).run({ cwd: tmp(), command: 'sleep 20', timeoutSec: 1, envAllowlist: ['PATH'] });
    expect(o.timedOut).toBe(true);
    expect(toolingProblem(o)).toBe('timed out');
  });
});

// ---------- persistence boundary ----------

const CANARY = 'TECERA_CANARY_ledger_9f8e7d6c';
const KEY = 'test-provider-credential-55aa66bb77';

function redactingSqlite(dir: string): { l: RedactingLedger; path: string } {
  const path = join(dir, 'ledger.sqlite');
  return { l: new RedactingLedger(new SqliteLedger(path), makeRedactor([{ kind: 'credential', value: KEY }, { kind: 'canary', value: CANARY }])), path };
}

function rawBytes(dir: string): string {
  let s = '';
  for (const f of ['ledger.sqlite', 'ledger.sqlite-wal', 'ledger.sqlite-shm']) if (existsSync(join(dir, f))) s += readFileSync(join(dir, f)).toString('latin1');
  return s;
}

describe('secret.canary_ledger: RedactingLedger is the persistence boundary', () => {
  it('events, evidence, approvals and checkpoints never store a secret in any encoding; raw database bytes are clean', async () => {
    const dir = tmp();
    const { l } = redactingSqlite(dir);
    const b64 = Buffer.from(KEY).toString('base64');
    const payload = { note: `planted ${CANARY}`, header: `Authorization: Bearer ${KEY}`, encoded: b64, nested: { arr: [KEY, encodeURIComponent(KEY)] }, [`key-${KEY}`]: 1 };
    await l.append(event('belief.added', { id: 'e1', at: 1, actor: { kind: 'system', id: 't' }, trace: {}, payload, runId: 'r1' }));
    await l.evidence({ key: `ev:${KEY}`, kind: 'test', runId: 'r1', body: { stdout: `${CANARY} ${KEY}` } });
    expect((await l.getEvidence(`ev:${KEY}`))?.kind).toBe('test');
    await l.requestApproval({ requestId: 'ap1', runId: 'r1', sessionId: 'r1', actionHash: 'h', requester: { kind: 'agent', id: 'loop' }, reason: `commit ${KEY}`, expiresAt: Date.now() + 60_000 });
    await l.approve('ap1', { kind: 'human', id: 'bob' }, 'r1', Date.now());
    const cp = await l.checkpoint('r1', 'k', { history: [`${CANARY}`, KEY] });
    const loaded = await l.loadCheckpoint(cp);
    expect(JSON.stringify(loaded)).not.toContain(KEY);
    await l.requestApproval({ requestId: 'ap2', runId: 'r1', sessionId: 'r1', actionHash: 'h2', requester: { kind: 'agent', id: 'loop' }, reason: 'x', expiresAt: Date.now() + 60_000 });
    await l.deny('ap2', { kind: 'human', id: 'bob' }, `because ${KEY}`, Date.now());
    const evs: TeceraEvent[] = [];
    for await (const e of l.events()) evs.push(e);
    expect(JSON.stringify(evs)).toContain('[REDACTED:');
    expect(JSON.stringify(evs)).not.toContain(KEY);
    l.close();
    const raw = rawBytes(dir);
    for (const leak of [KEY, CANARY, b64, encodeURIComponent(KEY)]) expect(raw.includes(leak), leak).toBe(false);
  });

  it('getApproval is delegated; a ledger without it fails closed', async () => {
    const l = new RedactingLedger(new MemoryLedger(), makeRedactor([]));
    await l.requestApproval({ requestId: 'ap1', runId: 'r', sessionId: 'r', actionHash: 'h', requester: { kind: 'agent', id: 'loop' }, reason: 'x', expiresAt: Date.now() + 60_000 });
    expect((await l.getApproval('ap1'))?.state).toBe('pending');
    const bare = { ...new MemoryLedger() } as never;
    await expect(new RedactingLedger(bare, makeRedactor([])).getApproval('x')).rejects.toThrow(/getApproval/);
  });

  it('Loop-shaped payloads with undefined fields persist and read back on SqliteLedger (no SanitizingLedger needed)', async () => {
    const dir = tmp();
    const raw = new SqliteLedger(join(dir, 'raw.sqlite'));
    const intention = { id: 'i1', goalId: 'g', planId: 'p', parentIntentionId: undefined, stepStatus: { a: 'ready' }, attempt: 0 };
    await raw.append(event('intention.pushed', { id: 'x1', at: 1, actor: { kind: 'agent', id: 'loop' }, trace: { goalId: 'g', intentionId: 'i1', planId: 'p', stepId: undefined }, payload: { intention } as never, runId: 'r' }));
    await raw.checkpoint('r', 'k', { a: undefined, b: 1 } as never);
    const out: TeceraEvent[] = [];
    for await (const e of raw.events()) out.push(e);
    expect(out[0]!.payload).toEqual({ intention: { id: 'i1', goalId: 'g', planId: 'p', stepStatus: { a: 'ready' }, attempt: 0 } });
    expect((await raw.verifyChain()).ok).toBe(true);
    raw.close();
  });
});

describe('evidence references and file names', () => {
  it('collects evidenceKey, evidence[] and evidenceKeys[]; file names never collide', () => {
    const keys = evidenceKeys({ a: { evidenceKey: 'verify:1' }, evidence: ['verify:123', 'review:9'], deep: [{ evidenceKeys: ['commit:1'] }] });
    expect([...keys].sort()).toEqual(['commit:1', 'review:9', 'verify:1', 'verify:123']);
    expect(evidenceFileName('a/b')).not.toBe(evidenceFileName('a_b'));
    expect(evidenceFileName('x'.repeat(200))).not.toBe(evidenceFileName(`${'x'.repeat(199)}y`));
  });
});
