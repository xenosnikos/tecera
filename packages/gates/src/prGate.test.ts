import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GateApproval, Ledger } from '@tecera/contracts';
import { createGates, type CreateGatesOptions } from './index.js';
import { findOnPath } from './prGate.js';
import { ctx, FakeReviewer, FakeRunner, GIT_TEST_ENV, HUMAN, LEDGERS, makeRepo, manifest, NOW, prGrant, WRITERS, type Repo } from './testkit/fixtures.js';

/**
 * PR gate (owner decision D6) on temp git repositories, with a bare 'origin' remote where a push matters.
 * The commit lands on tecera/g1 without approval; gate.pr is the approval point: it consumes a human grant
 * bound to prActionHash of the committed sha, pushes the work branch when origin exists, opens a PR with gh
 * when gh is available and authenticated, else records a patch bundle. It never merges.
 */

interface Setup {
  repo: Repo;
  ledger: Ledger;
  gates: ReturnType<typeof createGates>;
  sha: string;
  d1: string;
  commitKey: string;
  runsDir: string;
  origin: string | null;
  prCtx(approval?: GateApproval, o?: { sha?: string; d1?: string }): ReturnType<typeof ctx>;
  fresh(extra?: Partial<CreateGatesOptions>): ReturnType<typeof createGates>;
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

async function committed(o: { ledger?: Ledger; origin?: boolean; extra?: Partial<CreateGatesOptions> } = {}): Promise<Setup> {
  const repo = makeRepo();
  const origin = o.origin ? bareOrigin(repo) : null;
  repo.write('src/a.ts', 'export const a = 2;\n');
  const ledger = o.ledger ?? LEDGERS[0]![1]();
  const runsDir = mkdtempSync(join(tmpdir(), 'tecera-gates-runs-'));
  const make = (extra: Partial<CreateGatesOptions> = {}) =>
    createGates({ manifest: manifest(), ledger, verifyRunner: new FakeRunner(), reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1', runsDir, gh: null, ...o.extra, ...extra });
  const gates = make();
  const v = await gates.verify(ctx('v', { worktree: repo.dir }));
  const r = await gates.review(ctx('r', { worktree: repo.dir, candidate: { d1: v.fingerprint } }));
  expect(r.verdict).toBe('approve');
  // D6: the commit to the work branch needs no approval.
  const c = await gates.commit(ctx('c', { worktree: repo.dir, candidate: { d1: v.fingerprint, d2: r.fingerprint } }));
  expect(c).toMatchObject({ exitCode: 0, terminal: false });
  const s: Setup = {
    repo,
    ledger,
    gates,
    sha: c.sha!,
    d1: v.fingerprint,
    commitKey: c.evidenceKey,
    runsDir,
    origin,
    prCtx: (approval, x = {}) => ctx('pr', { worktree: repo.dir, ...(approval ? { approval } : {}), commit: { sha: x.sha ?? s.sha, d1: x.d1 ?? s.d1, evidenceKey: c.evidenceKey } }),
    fresh: make,
  };
  return s;
}

/** A stand-in gh: `auth status` exits AUTH; `pr create` logs its args and stdin and prints a PR url. */
function fakeGh(o: { auth?: number; create?: number } = {}): { path: string; log: string; body: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tecera-fake-gh-'));
  const log = join(dir, 'args.log');
  const body = join(dir, 'body.md');
  const path = join(dir, 'gh');
  writeFileSync(
    path,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
if [ "$1" = "auth" ]; then exit ${o.auth ?? 0}; fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then cat > '${body}'; if [ ${o.create ?? 0} -ne 0 ]; then echo 'boom' >&2; exit ${o.create ?? 0}; fi; echo 'https://github.com/acme/widget/pull/7'; exit 0; fi
exit 3
`,
  );
  chmodSync(path, 0o755);
  return { path, log, body };
}

const patchOf = (s: Setup) => join(s.runsDir, 'run1', 'pr', `${s.sha}.patch`);

describe('PrGate: no remote → pr.requested with a patch bundle', () => {
  it('consumes the PR grant, writes format-patch + body + request.json under <runsDir>/<run>/pr/, exit 0 with no url', async () => {
    const s = await committed();
    const ap = await prGrant(s.ledger, { sha: s.sha });
    const r = await s.gates.pr(s.prCtx(ap));
    expect(r).toMatchObject({ exitCode: 0, terminal: false, outcome: 'requested', reason: 'pr-requested', sha: s.sha, branch: 'tecera/g1', base: 'main', pushed: false });
    expect(r.url).toBeUndefined();
    expect(r.bundle).toBe(join(s.runsDir, 'run1', 'pr'));
    expect((await s.ledger.getApproval('pr1'))!.state).toBe('consumed');
    // The patch is the committed change, applicable on the base by a human.
    const patch = readFileSync(patchOf(s), 'utf8');
    expect(patch).toMatch(/^From [0-9a-f]{40} /);
    expect(patch).toContain('+export const a = 2;');
    s.repo.g('checkout', '-q', 'main');
    s.repo.g('apply', '--check', patchOf(s));
    const request = JSON.parse(readFileSync(join(r.bundle!, 'request.json'), 'utf8')) as Record<string, unknown>;
    expect(request).toMatchObject({ sha: s.sha, branch: 'tecera/g1', base: 'main', goalId: 'g1' });
    const body = readFileSync(join(r.bundle!, 'body.md'), 'utf8');
    expect(body).toContain('make a two');
    expect(body).toMatch(/check: `node --test` exited 0/);
    expect(body).toContain('verdict: approve');
    expect(body).toMatch(/never merges/);
    const ev = (await s.ledger.getEvidence(r.evidenceKey))!.body as Record<string, any>;
    expect(ev).toMatchObject({ outcome: 'requested', sha: s.sha, pushed: false, approval: { requestId: 'pr1' }, review: { verdict: 'approve' } });
    expect(ev.proof).toMatchObject({ command: 'node --test', exitCode: 0, fingerprint: s.d1 });
    // main never moved: Tecera never merges.
    expect(s.repo.g('rev-parse', 'main').trim()).not.toBe(s.sha);
  });

  it('a second call for the same step returns the recorded outcome: no second consume, nothing new written', async () => {
    const s = await committed();
    const ap = await prGrant(s.ledger, { sha: s.sha });
    const a = await s.gates.pr(s.prCtx(ap));
    const b = await s.fresh().pr(s.prCtx(ap));
    expect(b).toMatchObject({ exitCode: 0, sha: s.sha, evidenceKey: a.evidenceKey, reused: true, reason: 'pr-requested' });
  });
});

describe('PrGate: bare origin remote', () => {
  it('push lands the work branch at exactly the committed sha (gh disabled → pr.requested, pushed)', async () => {
    const s = await committed({ origin: true });
    const ap = await prGrant(s.ledger, { sha: s.sha });
    const r = await s.gates.pr(s.prCtx(ap));
    expect(r).toMatchObject({ exitCode: 0, outcome: 'requested', pushed: true, reason: 'pr-requested' });
    expect(remoteRef(s.origin!, 'refs/heads/tecera/g1')).toBe(s.sha);
    // The base on the remote is untouched: never merged, never pushed to.
    expect(remoteRef(s.origin!, 'refs/heads/main')).toBe(s.repo.g('rev-parse', 'main').trim());
    expect(existsSync(patchOf(s))).toBe(true);
  });

  it('gh absent from PATH → pr.requested after the push', async () => {
    const s = await committed({ origin: true, extra: { gh: undefined, ghEnv: { PATH: mkdtempSync(join(tmpdir(), 'tecera-empty-path-')) } } });
    const r = await s.gates.pr(s.prCtx(await prGrant(s.ledger, { sha: s.sha })));
    expect(r).toMatchObject({ exitCode: 0, outcome: 'requested', pushed: true });
    expect(((await s.ledger.getEvidence(r.evidenceKey))!.body as { note: string }).note).toBe('gh not found');
    expect(findOnPath('gh', '/definitely/not/here')).toBeNull();
  });

  it('gh present and authenticated → gh pr create --base main --head tecera/g1 with an evidence body; pr opened with its url; never merges', async () => {
    const gh = fakeGh();
    const s = await committed({ origin: true, extra: { gh: gh.path, ghEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, costLine: () => 'usd 0.0420 of 2 (not enforced)' } });
    const r = await s.gates.pr(s.prCtx(await prGrant(s.ledger, { sha: s.sha })));
    expect(r).toMatchObject({ exitCode: 0, outcome: 'opened', url: 'https://github.com/acme/widget/pull/7', pushed: true, sha: s.sha, terminal: false });
    expect(r.reason).toBeUndefined();
    const calls = readFileSync(gh.log, 'utf8').trim().split('\n');
    expect(calls[0]).toBe('auth status');
    expect(calls[1]).toMatch(/^pr create --base main --head tecera\/g1 --title tecera: make a two --body-file -$/);
    expect(calls.join('\n')).not.toMatch(/merge/);
    const body = readFileSync(gh.body, 'utf8');
    expect(body).toContain('## Goal');
    expect(body).toContain(`candidate: ${s.d1}`);
    expect(body).toContain('verdict: approve (foreign reviewer openai / gpt-review)');
    expect(body).toContain(`commit: ${s.sha} on tecera/g1 (base main)`);
    expect(body).toContain('cost: usd 0.0420 of 2 (not enforced)');
    expect((await s.ledger.getEvidence(r.evidenceKey))!.body).toMatchObject({ outcome: 'opened', url: 'https://github.com/acme/widget/pull/7', sha: s.sha });
    expect(existsSync(patchOf(s))).toBe(false);
  });

  it('gh present but not authenticated → pr.requested (pushed), pr create never runs', async () => {
    const gh = fakeGh({ auth: 1 });
    const s = await committed({ origin: true, extra: { gh: gh.path, ghEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin' } } });
    const r = await s.gates.pr(s.prCtx(await prGrant(s.ledger, { sha: s.sha })));
    expect(r).toMatchObject({ exitCode: 0, outcome: 'requested', pushed: true });
    expect(readFileSync(gh.log, 'utf8').trim()).toBe('auth status');
  });

  it('a push that cannot complete without interaction fails closed (9, push-failed) and leaves the human a bundle', async () => {
    const s = await committed();
    // An https remote nobody answers on, no credential helper, no prompts: the push must fail, never ask.
    s.repo.g('remote', 'add', 'origin', 'https://127.0.0.1:9/nobody/x.git');
    const r = await s.gates.pr(s.prCtx(await prGrant(s.ledger, { sha: s.sha })));
    expect(r).toMatchObject({ exitCode: 9, reason: 'push-failed', terminal: true, failure: 'human' });
    expect(existsSync(patchOf(s))).toBe(true);
  });

  it('a transport outside file/ssh/https (ext::) is refused by git, never run', async () => {
    const s = await committed();
    const marker = join(mkdtempSync(join(tmpdir(), 'tecera-ext-')), 'ran');
    s.repo.g('remote', 'add', 'origin', `ext::sh -c touch% ${marker}`);
    const r = await s.gates.pr(s.prCtx(await prGrant(s.ledger, { sha: s.sha })));
    expect(r).toMatchObject({ exitCode: 9, reason: 'push-failed' });
    expect(existsSync(marker)).toBe(false);
  });
});

describe.each(LEDGERS)('PrGate approvals (%s) → exit 8, nothing pushed, nothing bundled', (_n, mk) => {
  const refuse = async (setup: (s: Setup) => Promise<GateApproval | undefined>, reason = 'approval', tick?: (s: Setup) => void) => {
    const s = await committed({ ledger: mk(), origin: true });
    const ap = await setup(s);
    tick?.(s);
    const r = await s.gates.pr(s.prCtx(ap));
    expect(r).toMatchObject({ exitCode: 8, reason, terminal: true, failure: 'policy' });
    expect(remoteRef(s.origin!, 'refs/heads/tecera/g1')).toBeNull();
    expect(existsSync(patchOf(s))).toBe(false);
    return { s, r };
  };

  it('no approval at all', async () => {
    await refuse(async () => undefined, 'approval-missing');
  });
  it('replayed (already consumed elsewhere)', async () => {
    const { s, r } = await refuse(async (x) => {
      const ap = await prGrant(x.ledger, { sha: x.sha });
      await x.ledger.consume(ap.requestId, ap.actionHash, 's1', 'earlier-use', NOW);
      return ap;
    });
    expect(JSON.stringify((await s.ledger.getEvidence(r.evidenceKey))!.body)).toMatch(/consumed/);
  });
  it('self-approved (approver === requester)', async () => {
    await refuse((x) => prGrant(x.ledger, { sha: x.sha, requester: HUMAN, approver: HUMAN }));
  });
  it('agent approver', async () => {
    await refuse((x) => prGrant(x.ledger, { sha: x.sha, approver: { kind: 'agent', id: 'other' } }));
  });
  it('granted for another sha', async () => {
    await refuse((x) => prGrant(x.ledger, { sha: 'f'.repeat(40) }));
  });
  it('a commit approval (commitActionHash with the D1) is not a PR approval', async () => {
    await refuse(async (x) => prGrant(x.ledger, { sha: x.d1 }));
  });
  it('granted for another step or attempt', async () => {
    await refuse((x) => prGrant(x.ledger, { sha: x.sha, stepId: 'c' }));
  });
  it('wrong session', async () => {
    await refuse(async (x) => ({ ...(await prGrant(x.ledger, { sha: x.sha })), sessionId: 's2' }));
  });
  it('approval of another run', async () => {
    await refuse((x) => prGrant(x.ledger, { sha: x.sha, runId: 'run2' }));
  });
  it('requested but never granted', async () => {
    await refuse(async (x) => {
      const ap = await prGrant(x.ledger, { sha: x.sha, approver: { kind: 'agent', id: 'not-a-human' } });
      expect((await x.ledger.getApproval(ap.requestId))!.state).toBe('pending');
      return ap;
    });
  });
  it('expired', async () => {
    const gates = { now: NOW + 120_000 };
    const s = await committed({ ledger: mk(), extra: { now: () => gates.now } });
    const ap = await prGrant(s.ledger, { sha: s.sha, ttl: 60_000 });
    expect(await s.gates.pr(s.prCtx(ap))).toMatchObject({ exitCode: 8, reason: 'approval' });
  });
  it('the grant consumed through the PR gate cannot be spent again (other step)', async () => {
    const s = await committed({ ledger: mk() });
    const ap = await prGrant(s.ledger, { sha: s.sha });
    expect((await s.gates.pr(s.prCtx(ap))).exitCode).toBe(0);
    const other = { ...s.prCtx(ap), intention: { ...s.prCtx(ap).intention, attempt: 1 } };
    expect(await s.gates.pr(other)).toMatchObject({ exitCode: 8, reason: 'approval' });
  });
});

describe('PrGate binds the PR to the reviewed, verified commit → 9', () => {
  it('the work branch moved after the commit (someone amended it): 9 branch-moved, grant untouched', async () => {
    const s = await committed();
    s.repo.write('src/a.ts', 'export const a = 666;\n');
    s.repo.g('commit', '-q', '-am', 'sneaky');
    const ap = await prGrant(s.ledger, { sha: s.sha });
    expect(await s.gates.pr(s.prCtx(ap))).toMatchObject({ exitCode: 9, reason: 'branch-moved', terminal: true, failure: 'human' });
    expect((await s.ledger.getApproval('pr1'))!.state).toBe('granted');
  });

  it('a worktree mutation after the commit never reaches the PR: the patch is the committed bytes', async () => {
    const s = await committed();
    s.repo.write('src/a.ts', 'export const a = 666;\n');
    const r = await s.gates.pr(s.prCtx(await prGrant(s.ledger, { sha: s.sha })));
    expect(r.exitCode).toBe(0);
    const patch = readFileSync(patchOf(s), 'utf8');
    expect(patch).toContain('+export const a = 2;');
    expect(patch).not.toContain('666');
  });

  it('GateContext naming another sha or D1 than the commit evidence is refused', async () => {
    const s = await committed();
    const other = 'e'.repeat(40);
    expect(await s.gates.pr(s.prCtx(await prGrant(s.ledger, { sha: other }), { sha: other }))).toMatchObject({ exitCode: 9, reason: 'no-commit-evidence' });
    expect(await s.gates.pr(s.prCtx(await prGrant(s.ledger, { sha: s.sha, requestId: 'pr2' }), { d1: 'f'.repeat(64) }))).toMatchObject({ exitCode: 9, reason: 'commit-d1-mismatch' });
    expect(await s.gates.pr({ ...s.prCtx(), commit: undefined })).toMatchObject({ exitCode: 8, reason: 'no-commit' });
  });

  it('no review.passed for the committed D1 → 9, grant untouched', async () => {
    const ledger = LEDGERS[0]![1]();
    let hideReview = false;
    const get = ledger.getEvidence.bind(ledger);
    ledger.getEvidence = async (k) => (hideReview && k.startsWith('review:') ? null : get(k));
    const s = await committed({ ledger });
    hideReview = true;
    const ap = await prGrant(s.ledger, { sha: s.sha });
    expect(await s.gates.pr(s.prCtx(ap))).toMatchObject({ exitCode: 9, reason: 'no-review-for-commit' });
    expect((await s.ledger.getApproval('pr1'))!.state).toBe('granted');
  });

  it('a rejected review on record for the D1 → 9 review-not-passed', async () => {
    const ledger = LEDGERS[0]![1]();
    let reject = false;
    const get = ledger.getEvidence.bind(ledger);
    ledger.getEvidence = async (k) => {
      const rec = await get(k);
      return reject && rec && k.startsWith('review:') ? { ...rec, body: { ...(rec.body as object), verdict: 'reject' } } : rec;
    };
    const s = await committed({ ledger });
    reject = true;
    expect(await s.gates.pr(s.prCtx(await prGrant(s.ledger, { sha: s.sha })))).toMatchObject({ exitCode: 9, reason: 'review-not-passed' });
  });

  it('no passing verify of the goal check on the committed D1 → 9 no-verify-proof', async () => {
    const ledger = LEDGERS[0]![1]();
    let hide = false;
    const get = ledger.getEvidence.bind(ledger);
    ledger.getEvidence = async (k) => (hide && k.startsWith('verify:') ? null : get(k));
    const s = await committed({ ledger });
    hide = true;
    expect(await s.gates.pr(s.prCtx(await prGrant(s.ledger, { sha: s.sha })))).toMatchObject({ exitCode: 9, reason: 'no-verify-proof' });
    // And a verify of another command than the goal check is no proof either.
    hide = false;
    const c = s.prCtx(await prGrant(s.ledger, { sha: s.sha, requestId: 'pr2' }));
    expect(await s.gates.pr({ ...c, goal: { ...c.goal, check: { command: 'node --test other', timeoutSec: 60 } } })).toMatchObject({ exitCode: 9, reason: 'no-verify-proof' });
  });

  it('a hostile repository config added after the commit is refused before anything runs (9 unsafe-repo)', async () => {
    const s = await committed();
    s.repo.g('config', 'core.sshCommand', 'touch /tmp/never');
    const ap = await prGrant(s.ledger, { sha: s.sha });
    expect(await s.gates.pr(s.prCtx(ap))).toMatchObject({ exitCode: 9, reason: 'unsafe-repo' });
    expect((await s.ledger.getApproval('pr1'))!.state).toBe('granted');
  });

  it("refuses '' and foreign worktrees, and non-PR steps", async () => {
    const s = await committed();
    const ap = await prGrant(s.ledger, { sha: s.sha });
    expect(await s.gates.pr({ ...s.prCtx(ap), worktree: '' })).toMatchObject({ exitCode: 9, reason: 'no-worktree' });
    expect(await s.gates.pr({ ...s.prCtx(ap), worktree: '/tmp/elsewhere' })).toMatchObject({ exitCode: 9, reason: 'no-worktree' });
    const c = s.prCtx(ap);
    expect(await s.gates.pr({ ...c, step: { ...c.step, kind: 'gate.commit' } })).toMatchObject({ exitCode: 8, reason: 'not-a-pr-step' });
    expect((await s.ledger.getApproval('pr1'))!.state).toBe('granted');
  });

  it('an interrupted delivery (claimed, never recorded) is a human matter, never a second push', async () => {
    const s = await committed();
    const ap = await prGrant(s.ledger, { sha: s.sha });
    await s.ledger.evidence({ key: 'pr-intent:run1:i1:pr:0', kind: 'gate.pr.intent', runId: 'run1', body: { sha: s.sha, claimNonce: 'x' } });
    expect(await s.gates.pr(s.prCtx(ap))).toMatchObject({ exitCode: 9, reason: 'pr-interrupted' });
  });
});
