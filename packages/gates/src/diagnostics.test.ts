import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Redactor } from '@tecera/contracts';
import { safeText } from './evidence.js';
import { createGates } from './index.js';
import { ctx, FakeReviewer, FakeRunner, GIT_TEST_ENV, LEDGERS, makeRepo, manifest, NOW, WRITERS } from './testkit/fixtures.js';

/**
 * Codex sprint-3 gates finding 2 (verifyGate.ts:267, :150, :210): returned gate results carried raw
 * diagnostics (runner exceptions, snapshot and repository errors) while only the evidence was redacted.
 * Every string in a returned result, and in its evidence, must pass the shared redactor. Each case scans
 * the COMPLETE returned object and the stored evidence for the known secret in raw and encoded forms and
 * for canaries.
 */

const KNOWN = 'hunter2-gates-diag-secret-0077';
const CANARY = 'TECERA_CANARY_gates_wave4_diag';
const enc = (v: string) => [v, Buffer.from(v).toString('hex'), Buffer.from(v).toString('base64'), Buffer.from(v).toString('base64url')];
const NEEDLES = [...enc(KNOWN), CANARY, 'TECERA_CANARY_'];

function leaks(x: unknown): string[] {
  const text = JSON.stringify(x);
  return NEEDLES.filter((n) => text.includes(n)).map((n) => (n === KNOWN ? 'the known secret' : `${n.slice(0, 14)}…`));
}

const secretError = () => new Error(`spawn failed: token=${KNOWN} b64=${Buffer.from(KNOWN).toString('base64')} ${CANARY}`);

/** A git repo whose absolute path itself carries the secret (so path-bearing errors carry it too). */
function secretPathRepo(): { dir: string; g: (...a: string[]) => string } {
  const dir = join(mkdtempSync(join(tmpdir(), 'tecera-gates-diag-')), `wt-${KNOWN}-${CANARY}`);
  mkdirSync(dir, { recursive: true });
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { env: GIT_TEST_ENV, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  execFileSync('sh', ['-c', `mkdir -p src && printf 'export const a = 1;\\n' > src/a.ts && printf 'ignored/\\n' > .gitignore`], { cwd: dir });
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  return { dir, g };
}

describe.each(LEDGERS)('returned gate results carry no secrets (%s)', (_n, mk) => {
  it('verify: a runner exception with the secret → the returned reason and the evidence are redacted (tooling 127)', async () => {
    const repo = makeRepo();
    repo.write('src/a.ts', 'export const a = 2;\n');
    const ledger = mk();
    const g = createGates({ manifest: manifest(), ledger, verifyRunner: new FakeRunner(() => { throw secretError(); }), reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, secrets: [KNOWN] });
    const r = await g.verify(ctx('v', { worktree: repo.dir }));
    expect(r).toMatchObject({ exitCode: 127, outcome: 'tooling', terminal: true, failure: 'human' });
    expect(r.reason).toMatch(/verify runner failed/);
    expect(r.reason).toMatch(/\[REDACTED:/);
    expect(leaks(r)).toEqual([]);
    expect(leaks((await ledger.getEvidence(r.evidenceKey))!.body)).toEqual([]);
  });

  it('baseline: the same runner exception → the returned baseline result and its evidence are redacted', async () => {
    const repo = makeRepo();
    const ledger = mk();
    const g = createGates({ manifest: manifest(), ledger, verifyRunner: new FakeRunner(() => { throw secretError(); }), reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, secrets: [KNOWN] });
    const r = await g.baseline({ runId: 'run1' });
    expect(r.exitCode).toBe(127);
    expect(leaks(r)).toEqual([]);
    expect(leaks((await ledger.getEvidence(r.evidenceKey))!.body)).toEqual([]);
  });

  it('verify and baseline: snapshot / repository errors naming a secret-bearing path or config key are redacted', async () => {
    const ledger = mk();
    // (a) the worktree path carries the secret and is not a repository: "cannot fingerprint worktree: …<path>…"
    const notRepo = join(mkdtempSync(join(tmpdir(), 'tecera-gates-diag-')), `plain-${KNOWN}-${CANARY}`);
    mkdirSync(notRepo, { recursive: true });
    const g1 = createGates({ manifest: manifest(), ledger, verifyRunner: new FakeRunner(), reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: notRepo, now: () => NOW, secrets: [KNOWN] });
    const a = await g1.verify(ctx('v', { worktree: notRepo }));
    expect(a.exitCode).not.toBe(0);
    expect(a.terminal).toBe(true);
    expect(leaks(a)).toEqual([]);
    const ab = await g1.baseline({ runId: 'run1' });
    expect(leaks(ab)).toEqual([]);
    // (b) an unsafe repository whose refused config key names the secret: "config key filter.<secret>.clean …"
    const repo = makeRepo();
    repo.g('config', `filter.${KNOWN}.clean`, 'cat');
    const g2 = createGates({ manifest: manifest(), ledger, verifyRunner: new FakeRunner(), reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, secrets: [KNOWN] });
    const b = await g2.verify(ctx('v', { worktree: repo.dir, intentionId: 'i2' }));
    expect(b).toMatchObject({ exitCode: 9, outcome: 'refused', terminal: true, failure: 'human' });
    expect(b.reason).toMatch(/unsafe repository/);
    expect(leaks(b)).toEqual([]);
    expect(leaks((await ledger.getEvidence(b.evidenceKey))!.body)).toEqual([]);
  });

  it('review: a reviewer exception and an unreadable after-snapshot never reach the returned result (fingerprint is a sentinel, not the error)', async () => {
    const repo = secretPathRepo();
    execFileSync('sh', ['-c', `printf 'export const a = 2;\\n' > src/a.ts`], { cwd: repo.dir });
    const ledger = mk();
    // The reviewer breaks the repository while it "thinks", then throws with the secret.
    const reviewer = new FakeReviewer('openai', () => {
      rmSync(join(repo.dir, '.git'), { recursive: true, force: true });
      throw secretError();
    });
    const g = createGates({ manifest: manifest(), ledger, verifyRunner: new FakeRunner(), reviewer, writers: WRITERS, worktree: repo.dir, now: () => NOW, secrets: [KNOWN] });
    const r = await g.review(ctx('r', { worktree: repo.dir }));
    expect(r).toMatchObject({ verdict: 'reject', reason: 'mutated', terminal: true, fingerprint: 'unreadable', failure: 'human' });
    expect(leaks(r)).toEqual([]);
    const body = (await ledger.getEvidence(r.evidenceKey))!.body as Record<string, unknown>;
    expect(leaks(body)).toEqual([]);
    expect(String(body.error)).toMatch(/\[REDACTED:/);
  });

  it('commit: refusal results (unsafe repo) carry codes only, and nothing secret', async () => {
    const repo = makeRepo();
    repo.write('src/a.ts', 'export const a = 2;\n');
    const ledger = mk();
    const g = createGates({ manifest: manifest(), ledger, verifyRunner: new FakeRunner(), reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: repo.dir, now: () => NOW, sessionId: 's1', secrets: [KNOWN] });
    const v = await g.verify(ctx('v', { worktree: repo.dir }));
    const rv = await g.review(ctx('r', { worktree: repo.dir, candidate: { d1: v.fingerprint } }));
    repo.g('config', `filter.${KNOWN}.clean`, 'cat');
    const c = await g.commit(ctx('c', { worktree: repo.dir, candidate: { d1: v.fingerprint, d2: rv.fingerprint } }));
    expect(c).toMatchObject({ exitCode: 9, reason: 'unsafe-repo', terminal: true, failure: 'human' });
    expect(leaks(c)).toEqual([]);
    expect(leaks((await ledger.getEvidence(c.evidenceKey))!.body)).toEqual([]);
  });
});

describe('safeText', () => {
  it('redacts, and withholds the text when the redactor itself fails (never returns it raw)', () => {
    const ok: Redactor = { redactText: (t) => t.replace(KNOWN, '[REDACTED:x]'), redactJson: (v) => v as never, containsSecret: () => null };
    expect(safeText(ok, `a ${KNOWN}`)).toBe('a [REDACTED:x]');
    const broken: Redactor = { redactText: () => { throw new Error(KNOWN); }, redactJson: (v) => v as never, containsSecret: () => null };
    expect(safeText(broken, `a ${KNOWN}`)).toBe('[diagnostic withheld: redaction failed]');
  });
});
