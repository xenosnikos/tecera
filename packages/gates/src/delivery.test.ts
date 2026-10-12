import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { GateApproval, Ledger } from '@tecera/contracts';
import { CommitGate, type CommitGateOptions } from './commitGate.js';
import { assertSafeRepo, hostGit } from './gitx.js';
import { createGates, type CreateGatesOptions } from './index.js';
import { PUSH_PROTOCOLS, pushUrlProblem } from './prGate.js';
import { ctx, FakeReviewer, FakeRunner, GIT_TEST_ENV, LEDGERS, liveGuard, makeRepo, manifest, NOW, prGrant, recordVerify, WRITERS, type Repo } from './testkit/fixtures.js';

/**
 * gate.pr delivery hardening (sprint 5 gates findings): a mandatory session, a live fence through the whole
 * delivery, commit evidence bound to this run's preceding gate.commit, verifiedAt from the audited
 * verify.passed event, no requireVerify bypass, default-deny git transports, and no secret ever leaving the
 * machine in a PR, a patch or an evidence key.
 */

const KNOWN = 'hunter2-delivery-known-secret-0077';
const CANARY = 'TECERA_CANARY_delivery_w6_1';

interface Setup {
  repo: Repo;
  ledger: Ledger;
  gates: ReturnType<typeof createGates>;
  sha: string;
  d1: string;
  verifyKey: string;
  commitKey: string;
  runsDir: string;
  prCtx(approval?: GateApproval, x?: Partial<ReturnType<typeof ctx>>): ReturnType<typeof ctx>;
}

function bareOrigin(repo: Repo): string {
  const dir = mkdtempSync(join(tmpdir(), 'tecera-gates-origin-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', dir], { env: GIT_TEST_ENV });
  repo.g('remote', 'add', 'origin', dir);
  repo.g('push', '-q', 'origin', 'main');
  return dir;
}

const remoteRef = (origin: string, ref: string): string | null => {
  try {
    return execFileSync('git', ['-C', origin, 'rev-parse', '--verify', '--quiet', ref], { env: GIT_TEST_ENV, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};

async function committed(o: { ledger?: Ledger; extra?: Partial<CreateGatesOptions>; files?: Record<string, string>; change?: (r: Repo) => void; verified?: boolean } = {}): Promise<Setup> {
  const repo = makeRepo(o.files);
  if (o.change) o.change(repo);
  else repo.write('src/a.ts', 'export const a = 2;\n');
  const ledger = o.ledger ?? LEDGERS[0]![1]();
  const runsDir = mkdtempSync(join(tmpdir(), 'tecera-gates-runs-'));
  const gates = createGates({ manifest: manifest(), ledger, verifyRunner: new FakeRunner(), reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1', runsDir, gh: null, secrets: [KNOWN], ...o.extra });
  const v = await gates.verify(ctx('v', { worktree: repo.dir }));
  if (o.verified !== false) await recordVerify(ledger, v, { at: NOW - 7 });
  const r = await gates.review(ctx('r', { worktree: repo.dir, candidate: { d1: v.fingerprint } }));
  const c = await gates.commit(ctx('c', { worktree: repo.dir, candidate: { d1: v.fingerprint, d2: r.fingerprint } }));
  expect(c).toMatchObject({ exitCode: 0 });
  return {
    repo,
    ledger,
    gates,
    sha: c.sha!,
    d1: v.fingerprint,
    verifyKey: v.evidenceKey,
    commitKey: c.evidenceKey,
    runsDir,
    prCtx: (approval, x = {}) => ({ ...ctx('pr', { worktree: repo.dir, ...(approval ? { approval } : {}), commit: { sha: c.sha!, d1: v.fingerprint, evidenceKey: c.evidenceKey } }), ...x }),
  };
}

const bundleDir = (s: Setup) => join(s.runsDir, 'run1', 'pr');

describe('gate.pr session binding is mandatory', () => {
  it('a PR gate without a session refuses every grant (8 no-session), the grant untouched', async () => {
    const s = await committed();
    const noSession = createGates({ manifest: manifest(), ledger: s.ledger, verifyRunner: new FakeRunner(), reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: s.repo.dir, now: () => NOW, runsDir: s.runsDir, gh: null });
    const ap = await prGrant(s.ledger, { sha: s.sha });
    expect(await noSession.pr(s.prCtx(ap))).toMatchObject({ exitCode: 8, reason: 'no-session', terminal: true });
    expect((await s.ledger.getApproval(ap.requestId))!.state).toBe('granted');
    expect(existsSync(bundleDir(s))).toBe(false);
  });

  it('a grant of another session is refused even when the reference and the ledger row agree with each other', async () => {
    const s = await committed();
    const ap = await prGrant(s.ledger, { sha: s.sha, sessionId: 's2' });
    expect(ap.sessionId).toBe('s2');
    expect(await s.gates.pr(s.prCtx(ap))).toMatchObject({ exitCode: 8, reason: 'approval' });
    expect((await s.ledger.getApproval(ap.requestId))!.state).toBe('granted');
  });
});

describe('gate.pr needs a live fence through delivery', () => {
  it('no write guard → 9 no-write-guard before anything is read or spent', async () => {
    const s = await committed();
    const ap = await prGrant(s.ledger, { sha: s.sha });
    expect(await s.gates.pr({ ...s.prCtx(ap), guard: undefined })).toMatchObject({ exitCode: 9, reason: 'no-write-guard', terminal: true });
    expect((await s.ledger.getApproval(ap.requestId))!.state).toBe('granted');
  });

  it('a fence lost before the claim spends nothing; lost after the consume, nothing is pushed or bundled', async () => {
    for (const at of [1, 3]) {
      const s = await committed();
      const origin = bareOrigin(s.repo);
      const g = liveGuard();
      g.onCheck = () => {
        if (g.checks === at) g.revoke('lease lost');
      };
      const ap = await prGrant(s.ledger, { sha: s.sha, requestId: `pr-${at}` });
      const r = await s.gates.pr({ ...s.prCtx(ap), guard: g.guard });
      expect(r, `check ${at}`).toMatchObject({ exitCode: 9, reason: 'fence-lost', terminal: true });
      expect(remoteRef(origin, 'refs/heads/tecera/g1')).toBeNull();
      expect(existsSync(bundleDir(s))).toBe(false);
      // Before the claim (check 1) the grant is untouched; after it (check 3 is the push) it was spent once.
      expect((await s.ledger.getApproval(ap.requestId))!.state).toBe(at === 1 ? 'granted' : 'consumed');
    }
  });

  it('a fence lost between bundle writes stops the bundle (no request.json is written)', async () => {
    const s = await committed();
    const g = liveGuard();
    // checks: 1 claim, 2 consume, 3 mkdir, 4 patch, 5 body, 6 request.json
    g.onCheck = () => {
      if (g.checks === 5) g.revoke('lease lost');
    };
    const r = await s.gates.pr({ ...s.prCtx(await prGrant(s.ledger, { sha: s.sha })), guard: g.guard });
    expect(r).toMatchObject({ exitCode: 9, reason: 'fence-lost' });
    expect(existsSync(join(bundleDir(s), `${s.sha}.patch`))).toBe(true);
    expect(existsSync(join(bundleDir(s), 'body.md'))).toBe(false);
    expect(existsSync(join(bundleDir(s), 'request.json'))).toBe(false);
  });
});

describe('gate.pr binds the commit evidence to this run and its preceding gate.commit', () => {
  const copy = async (s: Setup, key: string, o: { runId?: string; kind?: string; body?: Record<string, unknown> } = {}) => {
    const rec = (await s.ledger.getEvidence(s.commitKey))!;
    await s.ledger.evidence({ key, kind: o.kind ?? 'gate.commit', runId: o.runId ?? 'run1', body: { ...(rec.body as object), ...o.body } as never });
    return key;
  };
  let n = 0;
  const refuse = async (s: Setup, key: string, reason: string) => {
    const ap = await prGrant(s.ledger, { sha: s.sha, requestId: `pr-${reason}-${++n}` });
    expect(await s.gates.pr(s.prCtx(ap, { commit: { sha: s.sha, d1: s.d1, evidenceKey: key } }))).toMatchObject({ exitCode: 9, reason });
    expect((await s.ledger.getApproval(ap.requestId))!.state).toBe('granted');
  };

  it('evidence of another run, of another kind, of another goal, under a foreign key, or of a step that is not a preceding commit', async () => {
    const s = await committed();
    await refuse(s, await copy(s, 'commit:run2:i1:c:0', { runId: 'run2' }), 'commit-of-another-run');
    await refuse(s, await copy(s, 'review-forged:run1', { kind: 'gate.review' }), 'commit-of-another-run');
    await refuse(s, await copy(s, 'commit-forged-goal:run1', { body: { goalId: 'g2' } }), 'commit-of-another-goal');
    await refuse(s, await copy(s, 'commit-copy:run1:i1:c:0'), 'commit-evidence-key-mismatch');
    await refuse(s, await copy(s, 'commit:run1:i1:v:0', { body: { stepId: 'v' } }), 'commit-not-a-preceding-step');
    await refuse(s, await copy(s, 'commit:run1:i1:c:1', { body: { attempt: 1 } }), 'commit-of-another-attempt');
    // A gate.commit step that comes AFTER this PR step in the plan is not the commit it delivers.
    const later = { id: 'c9', kind: 'gate.commit' as const, dependsOn: ['pr'], inputs: {} };
    const key = await copy(s, 'commit:run1:i1:c9:0', { body: { stepId: 'c9' } });
    const base = s.prCtx(await prGrant(s.ledger, { sha: s.sha, requestId: 'pr-later' }), {});
    const r = await s.gates.pr({ ...base, plan: { ...base.plan, steps: [...base.plan.steps, later] }, commit: { sha: s.sha, d1: s.d1, evidenceKey: key } });
    expect(r).toMatchObject({ exitCode: 9, reason: 'commit-not-a-preceding-step' });
    // The real record still delivers.
    expect((await s.gates.pr(s.prCtx(await prGrant(s.ledger, { sha: s.sha })))).exitCode).toBe(0);
  });
});

describe('gate.pr proves with the audited verify.passed event, never a synthesized time', () => {
  it('no verify.passed event for the intention → 9 no-verify-proof, even though the gate remembers a passing verify', async () => {
    const s = await committed({ verified: false });
    const ap = await prGrant(s.ledger, { sha: s.sha });
    expect(await s.gates.pr(s.prCtx(ap))).toMatchObject({ exitCode: 9, reason: 'no-verify-proof' });
    expect((await s.ledger.getApproval(ap.requestId))!.state).toBe('granted');
  });

  it('verifiedAt is the verify.passed event time; a later verify.failed of the intention is no proof', async () => {
    const s = await committed();
    const r = await s.gates.pr(s.prCtx(await prGrant(s.ledger, { sha: s.sha })));
    expect(r.exitCode).toBe(0);
    const ev = (await s.ledger.getEvidence(r.evidenceKey))!.body as { proof: { verifiedAt: number } };
    expect(ev.proof.verifiedAt).toBe(NOW - 7);
    expect(readFileSync(join(r.bundle!, 'body.md'), 'utf8')).toContain(`(${new Date(NOW - 7).toISOString()})`);

    const t = await committed();
    // the later verify.failed even names the passing evidence: the latest verify of the intention failed
    await recordVerify(t.ledger, { exitCode: 1, evidenceKey: t.verifyKey, fingerprint: t.d1 }, { at: NOW - 1 });
    expect(await t.gates.pr(t.prCtx(await prGrant(t.ledger, { sha: t.sha })))).toMatchObject({ exitCode: 9, reason: 'no-verify-proof' });
  });
});

describe('gate.commit has no verify bypass', () => {
  it('requireVerify: false is gone: a reviewed candidate without passing verify evidence is never committed', async () => {
    const repo = makeRepo();
    repo.write('src/a.ts', 'export const a = 2;\n');
    const ledger = LEDGERS[0]![1]();
    const opts = { manifest: manifest(), ledger, verifyRunner: new FakeRunner(), reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1', requireVerify: false } as unknown as CreateGatesOptions;
    const g = createGates(opts);
    const r = await g.review(ctx('r', { worktree: repo.dir }));
    expect(r.verdict).toBe('approve');
    expect(await g.commit(ctx('c', { worktree: repo.dir, candidate: { d2: r.fingerprint } }))).toMatchObject({ exitCode: 9, reason: 'no-verify-evidence' });
    // Nor when the commit gate is built directly with it.
    const direct = new CommitGate({ ledger, manifest: manifest(), worktree: repo.dir, now: () => NOW, memo: g.memo, requireVerify: false } as unknown as CommitGateOptions);
    expect(await direct.commit(ctx('c', { worktree: repo.dir, candidate: { d2: r.fingerprint } }))).toMatchObject({ exitCode: 9, reason: 'no-verify-evidence' });
  });
});

describe('git transports are default-deny: only file, ssh and https', () => {
  const tryRemote = async (url: string | ((marker: string) => string), configure?: (r: Repo, marker: string) => void) => {
    const s = await committed();
    const marker = join(mkdtempSync(join(tmpdir(), 'tecera-transport-')), 'ran');
    s.repo.g('remote', 'add', 'origin', typeof url === 'string' ? url : url(marker));
    configure?.(s.repo, marker);
    const ap = await prGrant(s.ledger, { sha: s.sha });
    const r = await s.gates.pr(s.prCtx(ap));
    expect(r, String(url)).toMatchObject({ exitCode: 8, reason: 'transport-refused', terminal: true });
    expect(existsSync(marker)).toBe(false);
    expect((await s.ledger.getApproval(ap.requestId))!.state).toBe('granted');
    expect(existsSync(bundleDir(s))).toBe(false);
  };

  it('git:// is refused', () => tryRemote('git://127.0.0.1:9/acme/widget.git'));
  it('plain http:// is refused', () => tryRemote('http://127.0.0.1:9/acme/widget.git'));
  it('ext:: is refused and never runs its command', () => tryRemote((m) => `ext::sh -c touch% ${m}`));
  it('a remote helper (<helper>::<address>) is refused and the helper never runs', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'tecera-helper-'));
    let marker = '';
    await tryRemote((m) => {
      marker = m;
      writeFileSync(join(bin, 'git-remote-evil'), `#!/bin/sh\ntouch '${m}'\nexit 1\n`);
      chmodSync(join(bin, 'git-remote-evil'), 0o755);
      return 'evil::whatever';
    });
    expect(existsSync(marker)).toBe(false);
  });
  it('a URL rewritten by insteadOf to ext:: is refused (the effective URL is checked)', () =>
    tryRemote('https://example.invalid/acme/widget.git', (r, m) => r.g('config', `url.ext::sh -c touch% ${m} #.insteadOf`, 'https://example.invalid/')));
  it('a push URL rewritten by pushInsteadOf to plain http is refused', () => tryRemote('https://example.invalid/acme/widget.git', (r) => r.g('config', 'url.http://plain.invalid/.pushInsteadOf', 'https://example.invalid/')));
  it('an https URL carrying a password is refused', () => tryRemote('https://user:hunter2@127.0.0.1:9/acme/widget.git'));

  it('a second push URL is refused before the grant is spent: gate.pr never pushes to a remote name', async () => {
    for (const allowExt of [false, true]) {
      const s = await committed();
      const origin = bareOrigin(s.repo);
      const marker = join(mkdtempSync(join(tmpdir(), 'tecera-transport-')), 'ran');
      // `git push origin` would go to both: the checked bare repository and the program behind ext::
      s.repo.g('config', '--add', 'remote.origin.pushurl', origin);
      s.repo.g('config', '--add', 'remote.origin.pushurl', `ext::sh -c touch% ${marker}`);
      if (allowExt) s.repo.g('config', 'protocol.ext.allow', 'always');
      const ap = await prGrant(s.ledger, { sha: s.sha, requestId: `pr-two-${allowExt}` });
      const r = await s.gates.pr(s.prCtx(ap));
      expect(r, `protocol.ext.allow=${allowExt}`).toMatchObject({ exitCode: allowExt ? 9 : 8, reason: allowExt ? 'unsafe-repo' : 'transport-refused', terminal: true });
      expect(existsSync(marker)).toBe(false);
      expect((await s.ledger.getApproval(ap.requestId))!.state).toBe('granted');
      expect(remoteRef(origin, 'refs/heads/tecera/g1')).toBeNull();
      expect(existsSync(bundleDir(s))).toBe(false);
    }
    // two plain url values are two push destinations as well
    const s = await committed();
    const origin = bareOrigin(s.repo);
    const other = mkdtempSync(join(tmpdir(), 'tecera-gates-origin-'));
    execFileSync('git', ['init', '-q', '--bare', other], { env: GIT_TEST_ENV });
    s.repo.g('config', '--add', 'remote.origin.url', other);
    const ap = await prGrant(s.ledger, { sha: s.sha, requestId: 'pr-two-urls' });
    expect(await s.gates.pr(s.prCtx(ap))).toMatchObject({ exitCode: 8, reason: 'transport-refused' });
    expect((await s.ledger.getApproval(ap.requestId))!.state).toBe('granted');
    expect(remoteRef(origin, 'refs/heads/tecera/g1')).toBeNull();
    expect(remoteRef(other, 'refs/heads/tecera/g1')).toBeNull();
  });

  it('a repository-level protocol.<name>.allow is refused outright (it would beat protocol.allow=never)', async () => {
    for (const key of ['protocol.ext.allow', 'protocol.evil.allow', 'protocol.allow']) {
      const repo = makeRepo();
      repo.g('config', key, 'always');
      await expect(assertSafeRepo(repo.dir), key).rejects.toThrow(new RegExp(`config key ${key.replace(/\./g, '\\.')} \\(local\\) is not allowed`));
    }
    await expect(assertSafeRepo(makeRepo().dir)).resolves.toMatchObject({ objectFormat: 'sha1' });
  });

  it('the push reads no repository config: it goes to the one validated URL, by value, from an empty repository', async () => {
    const s = await committed();
    const origin = bareOrigin(s.repo);
    const marker = join(mkdtempSync(join(tmpdir(), 'tecera-transport-')), 'ran');
    // A second rewrite that applies only to the already-rewritten URL: a push run inside this repository
    // would follow it to ext::, although the effective URL the gate checked is the bare repository.
    s.repo.g('config', 'remote.origin.url', 'https://example.invalid/acme/widget.git');
    s.repo.g('config', `url.${origin}.insteadOf`, 'https://example.invalid/acme/widget.git');
    s.repo.g('config', `url.ext::sh -c touch% ${marker} #.insteadOf`, origin);
    // Transport options a repository could set for its own pushes.
    s.repo.g('config', 'push.pushOption', 'ci.skip');
    s.repo.g('config', 'http.sslVerify', 'false');
    const ap = await prGrant(s.ledger, { sha: s.sha, requestId: 'pr-clean' });
    const r = await s.gates.pr(s.prCtx(ap));
    expect(r).toMatchObject({ exitCode: 0, pushed: true, outcome: 'requested' });
    expect(existsSync(marker)).toBe(false);
    expect(remoteRef(origin, 'refs/heads/tecera/g1')).toBe(s.sha);
    expect((await s.ledger.getApproval(ap.requestId))!.state).toBe('consumed');
    // nothing was left behind in the delivered repository's config by the push
    expect(s.repo.g('config', '--local', '--list')).not.toMatch(/^branch\.tecera\/g1\./m);
  });

  it('a relative local push URL still means a path next to the delivered repository', async () => {
    const s = await committed();
    const origin = bareOrigin(s.repo);
    s.repo.g('config', 'remote.origin.url', relative(s.repo.dir, origin));
    const ap = await prGrant(s.ledger, { sha: s.sha, requestId: 'pr-relative' });
    expect(await s.gates.pr(s.prCtx(ap))).toMatchObject({ exitCode: 0, pushed: true });
    expect(remoteRef(origin, 'refs/heads/tecera/g1')).toBe(s.sha);
  });

  it('the git layer itself refuses every other transport (protocol.allow=never before file/ssh/https)', async () => {
    const repo = makeRepo();
    expect(PUSH_PROTOCOLS.slice(0, 2)).toEqual(['-c', 'protocol.allow=never']);
    const bin = mkdtempSync(join(tmpdir(), 'tecera-helper-'));
    const marker = join(bin, 'ran');
    writeFileSync(join(bin, 'git-remote-evil'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(join(bin, 'git-remote-evil'), 0o755);
    const env = { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` };
    for (const [url, transport] of [
      ['git://127.0.0.1:9/x', 'git'],
      ['http://127.0.0.1:9/x', 'http'],
      [`ext::sh -c touch% ${marker}`, 'ext'],
      ['evil::whatever', 'evil'],
      ['fd::3', 'fd'],
    ] as const) {
      await expect(hostGit(repo.dir, [...PUSH_PROTOCOLS, 'push', '--porcelain', url, 'refs/heads/main:refs/heads/x'], { env }), url).rejects.toThrow(new RegExp(`transport '${transport}' not allowed`));
    }
    expect(existsSync(marker)).toBe(false);
    // file is allowed: a local bare remote receives the push.
    const origin = mkdtempSync(join(tmpdir(), 'tecera-gates-origin-'));
    execFileSync('git', ['init', '-q', '--bare', origin], { env: GIT_TEST_ENV });
    await hostGit(repo.dir, [...PUSH_PROTOCOLS, 'push', '--porcelain', origin, 'refs/heads/main:refs/heads/x']);
    expect(remoteRef(origin, 'refs/heads/x')).toBe(repo.g('rev-parse', 'main').trim());
  });

  it('pushUrlProblem: local paths, file://, ssh:// and scp-style ssh, https without a password', () => {
    for (const ok of ['/srv/git/widget.git', './origin.git', 'file:///srv/git/widget.git', 'ssh://git@github.com/acme/widget.git', 'git@github.com:acme/widget.git', 'github.com:acme/widget.git', 'https://github.com/acme/widget.git', 'https://token@github.com/acme/widget.git']) {
      expect(pushUrlProblem(ok), ok).toBeNull();
    }
    for (const bad of ['git://h/x', 'http://h/x', 'ext::sh -c x', 'evil::x', 'fd::3', 'ftp://h/x', 'https://u:p@h/x', '-uhack', 'https://h/x y', '']) {
      expect(pushUrlProblem(bad), bad).not.toBeNull();
    }
  });
});

describe.each(LEDGERS)('a secret-bearing delivery fails closed (%s)', (_n, mk) => {
  it('a canary in a diff CONTEXT line refuses the delivery (8 secret-in-delivery): nothing pushed, opened or bundled', async () => {
    // The base file already holds the canary; the change edits the line next to it, so the canary is only context.
    const s = await committed({
      ledger: mk(),
      files: { 'src/cfg.ts': `export const a = 1;\n// ${CANARY}\nexport const b = 1;\n` },
      change: (r) => r.write('src/cfg.ts', `export const a = 2;\n// ${CANARY}\nexport const b = 1;\n`),
    });
    const origin = bareOrigin(s.repo);
    const ap = await prGrant(s.ledger, { sha: s.sha });
    const r = await s.gates.pr(s.prCtx(ap));
    expect(r).toMatchObject({ exitCode: 8, reason: 'secret-in-delivery', terminal: true, failure: 'policy' });
    expect(remoteRef(origin, 'refs/heads/tecera/g1')).toBeNull();
    expect(existsSync(bundleDir(s))).toBe(false);
    expect((await s.ledger.getApproval(ap.requestId))!.state).toBe('granted');
    // The refusal names where and what kind, never the value.
    const ev = JSON.stringify((await s.ledger.getEvidence(r.evidenceKey))!.body);
    expect(ev).toMatch(/"where":"patch"/);
    expect(ev).not.toContain(CANARY);
  });

  it('a registered secret in a context line refuses the delivery too', async () => {
    const s = await committed({
      ledger: mk(),
      files: { 'src/cfg.ts': `export const a = 1;\nexport const k = '${KNOWN}';\n` },
      change: (r) => r.write('src/cfg.ts', `export const a = 2;\nexport const k = '${KNOWN}';\n`),
    });
    expect(await s.gates.pr(s.prCtx(await prGrant(s.ledger, { sha: s.sha })))).toMatchObject({ exitCode: 8, reason: 'secret-in-delivery' });
    expect(existsSync(bundleDir(s))).toBe(false);
  });

  it('an evidence key the delivery names (the approval request id) carrying a canary refuses it', async () => {
    const s = await committed({ ledger: mk() });
    const ap = await prGrant(s.ledger, { sha: s.sha, requestId: `pr-${CANARY}` });
    const r = await s.gates.pr(s.prCtx(ap));
    expect(r).toMatchObject({ exitCode: 8, reason: 'secret-in-delivery' });
    expect(JSON.stringify((await s.ledger.getEvidence(r.evidenceKey))!.body)).toMatch(/"where":"keys"/);
    expect((await s.ledger.getApproval(ap.requestId))!.state).toBe('granted');
  });

  it('a clean delivery is unaffected (control)', async () => {
    const s = await committed({ ledger: mk() });
    expect((await s.gates.pr(s.prCtx(await prGrant(s.ledger, { sha: s.sha })))).exitCode).toBe(0);
  });
});
