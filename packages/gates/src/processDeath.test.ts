import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileVerdict } from '@tecera/contracts';
import { SqliteLedger } from '@tecera/ledger';
import { createGates } from './index.js';
import { ctx, FakeReviewer, FakeRunner, liveGuard, makeRepo, manifest, NOW, sqlitePath, WRITERS } from './testkit/fixtures.js';

/**
 * Real process death (Codex sprint-3 'Missing tests': the earlier recovery fixtures only abandoned promises
 * or threw). A separate node process runs verify → review → commit (no approval, D6) against a SqliteLedger
 * file and the real repository, and is SIGKILLed while parked at a commit crash window. A fresh process
 * (this one, new connection, empty memo) then reconciles. The child imports the BUILT gates (dist), so the
 * dist must be current: the test refuses to run against a stale build rather than test old code.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DIST = join(HERE, '..', 'dist');
const url = (rel: string) => new URL(rel, import.meta.url).href;

function assertFreshDist(): void {
  for (const f of readdirSync(HERE)) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts') || f.endsWith('.d.ts')) continue;
    const js = join(DIST, f.replace(/\.ts$/, '.js'));
    if (!existsSync(js) || statSync(js).mtimeMs + 1 < statSync(join(HERE, f)).mtimeMs) {
      throw new Error(`packages/gates/dist is stale for ${f}: build the gates package (tsc) before this test`);
    }
  }
}

const CHILD = `
import { readFileSync, writeFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { createGates } = await import(cfg.gates);
const { SqliteLedger } = await import(cfg.ledger);
const C = await import(cfg.contracts);
const ledger = new SqliteLedger(cfg.db);
const runner = { async run() { return { exitCode: 0, signal: null, timedOut: false, stdout: 'ok', stderr: '', durationMs: 1, truncated: false }; } };
const reviewer = { id: 'openai-reviewer', provider: 'openai', keyFingerprint: 'kf-openai',
  async complete(req) { return { content: '{"verdict":"approve","findings":[]}', usage: { inputTokens: 10, outputTokens: 5, usd: 0.001 }, model: req.model, finishReason: 'stop' }; } };
// Parked for good: a live timer keeps the process up until the SIGKILL (an unsettled top-level await alone would exit 13).
const park = () => { setInterval(() => {}, 1000); writeFileSync(cfg.marker, 'parked:' + cfg.crashAt); return new Promise(() => {}); };
const gates = createGates({ manifest: cfg.manifest, ledger, verifyRunner: runner, reviewer, writers: [{ provider: 'anthropic', keyFingerprint: 'kf-anthropic' }],
  worktree: cfg.repo, now: () => cfg.now, sessionId: 's1', commitTestHooks: { [cfg.crashAt]: park } });
const guard = new C.FencedWriteGuard({ live: () => null, signal: new AbortController().signal });
const at = (step, extra = {}) => ({ ...cfg.ctx[step], ...extra, guard });
const v = await gates.verify(at('v'));
const r = await gates.review(at('r', { candidate: { d1: v.fingerprint } }));
writeFileSync(cfg.state, JSON.stringify({ d1: v.fingerprint, d2: r.fingerprint }));
// D6: the commit to the work branch takes no approval.
const c = await gates.commit(at('c', { candidate: { d1: v.fingerprint, d2: r.fingerprint } }));
writeFileSync(cfg.marker, 'finished:' + JSON.stringify(c));
`;

interface Crashed {
  repo: ReturnType<typeof makeRepo>;
  db: string;
  state: { d1: string; d2: string };
}

async function killAt(crashAt: 'beforeCommit' | 'afterUpdateRef' | 'afterHead' | 'afterRef'): Promise<Crashed> {
  assertFreshDist();
  const work = mkdtempSync(join(tmpdir(), 'tecera-gates-death-'));
  const repo = makeRepo();
  repo.write('src/a.ts', 'export const a = 2;\n');
  const db = sqlitePath();
  const setup = new SqliteLedger(db);
  for (const [pool, cap] of [['calls', 100], ['usd', 100], ['tokens', 10_000_000]] as const) await setup.openBudget('run1', pool, cap);
  setup.close();
  const strip = (step: 'v' | 'r' | 'c') => ctx(step, { worktree: repo.dir, guard: null });
  const cfg = {
    gates: url('../dist/index.js'),
    ledger: url('../../ledger/dist/index.js'),
    contracts: url('../../contracts/dist/index.js'),
    db,
    repo: repo.dir,
    now: NOW,
    crashAt,
    marker: join(work, 'marker'),
    state: join(work, 'state.json'),
    manifest: manifest(),
    ctx: { v: strip('v'), r: strip('r'), c: strip('c') },
  };
  writeFileSync(join(work, 'cfg.json'), JSON.stringify(cfg));
  writeFileSync(join(work, 'child.mjs'), CHILD);
  const child = spawn(process.execPath, [join(work, 'child.mjs'), join(work, 'cfg.json')], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: work } });
  let stderr = '';
  child.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  try {
    const deadline = Date.now() + 60_000;
    while (!existsSync(cfg.marker)) {
      if (child.exitCode !== null) throw new Error(`child exited early (${child.exitCode}): ${stderr}`);
      if (Date.now() > deadline) throw new Error(`child never reached ${crashAt}: ${stderr}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(readFileSync(cfg.marker, 'utf8')).toBe(`parked:${crashAt}`);
    child.kill('SIGKILL');
    const end = await exited;
    expect(end.signal).toBe('SIGKILL');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  return { repo, db, state: JSON.parse(readFileSync(cfg.state, 'utf8')) as Crashed['state'] };
}

/** The restarted process: new connection, new gates, empty memo. */
function restarted(c: Crashed) {
  const ledger = new SqliteLedger(c.db);
  const gates = createGates({ manifest: manifest(), ledger, verifyRunner: new FakeRunner(), reviewer: new FakeReviewer('openai'), writers: WRITERS, worktree: c.repo.dir, now: () => NOW, sessionId: 's1' });
  const commitCtx = (guard = liveGuard().guard as ReturnType<typeof liveGuard>['guard'] | null) => ({ ...ctx('c', { worktree: c.repo.dir, candidate: { d1: c.state.d1, d2: c.state.d2 }, guard }), recovered: true });
  return { ledger, gates, commitCtx };
}

const headRef = (c: Crashed) => c.repo.g('symbolic-ref', 'HEAD').trim();
const indexTree = (c: Crashed) => c.repo.g('write-tree').trim();
const headTree = (c: Crashed) => c.repo.g('rev-parse', 'HEAD^{tree}').trim();

describe('S8 across a real process death (SIGKILL, SqliteLedger file reopened)', () => {
  // Only a file ledger survives a process, so this matrix is SqliteLedger only.
  it('killed after the intent, before commit-tree: nothing to reconcile into a commit; 9 reconcile-no-commit; never committed again', async () => {
    const c = await killAt('beforeCommit');
    const r = restarted(c);
    const out = await r.gates.reconcile(r.commitCtx());
    expect(out).toMatchObject({ exitCode: 9, reason: 'reconcile-no-commit', terminal: true, failure: 'human' });
    expect(() => c.repo.g('rev-parse', '--verify', '--quiet', 'refs/heads/tecera/g1')).toThrow();
    // commit() on the restarted process reconciles too: it never commits again.
    expect(await r.gates.commit(r.commitCtx())).toMatchObject({ exitCode: 9, reason: 'reconcile-no-commit' });
    expect(() => c.repo.g('rev-parse', '--verify', '--quiet', 'refs/heads/tecera/g1')).toThrow();
  });

  it('killed after update-ref (branch moved, HEAD and index not): reconcile under the new guard moves HEAD, repairs the index, records once', async () => {
    const c = await killAt('afterUpdateRef');
    expect(headRef(c)).toBe('refs/heads/main');
    const sha = c.repo.g('rev-parse', 'refs/heads/tecera/g1').trim();
    const r = restarted(c);
    expect(await r.gates.reconcile(r.commitCtx(null))).toMatchObject({ exitCode: 9, reason: 'reconcile-needs-guard' });
    expect(headRef(c)).toBe('refs/heads/main');
    const out = await r.gates.reconcile(r.commitCtx());
    expect(reconcileVerdict(out)).toMatchObject({ recorded: true, sha });
    expect(headRef(c)).toBe('refs/heads/tecera/g1');
    expect(indexTree(c)).toBe(headTree(c));
    expect((await r.ledger.getEvidence(out!.evidenceKey))!.body).toMatchObject({ outcome: 'committed', reconciled: true, repaired: ['head', 'index'] });
    expect(reconcileVerdict(await r.gates.reconcile(r.commitCtx()))).toMatchObject({ recorded: true, sha });
    expect(c.repo.g('rev-list', '--count', 'main..tecera/g1').trim()).toBe('1');
  });

  it('killed after HEAD moved, before the index update: reconcile repairs the index only, records once', async () => {
    const c = await killAt('afterHead');
    expect(headRef(c)).toBe('refs/heads/tecera/g1');
    expect(indexTree(c)).not.toBe(headTree(c));
    const r = restarted(c);
    const out = await r.gates.reconcile(r.commitCtx());
    expect(out).toMatchObject({ exitCode: 0, reconciled: true });
    expect(indexTree(c)).toBe(headTree(c));
    expect((await r.ledger.getEvidence(out!.evidenceKey))!.body).toMatchObject({ repaired: ['index'] });
    expect(c.repo.g('rev-list', '--count', 'main..tecera/g1').trim()).toBe('1');
  });

  it('killed after HEAD and index, before the final record: proven read-only (no guard needed), recorded once, never committed again', async () => {
    const c = await killAt('afterRef');
    const sha = c.repo.g('rev-parse', 'refs/heads/tecera/g1').trim();
    const r = restarted(c);
    expect(await r.ledger.getEvidence('commit:run1:i1:c:0')).toBeNull();
    const out = await r.gates.reconcile(r.commitCtx(null));
    expect(reconcileVerdict(out)).toMatchObject({ recorded: true, sha });
    expect((await r.ledger.getEvidence(out!.evidenceKey))!.body).toMatchObject({ repaired: [] });
    expect(await r.gates.commit(r.commitCtx())).toMatchObject({ exitCode: 0, sha, reconciled: true });
    expect(c.repo.g('rev-list', '--count', 'main..tecera/g1').trim()).toBe('1');
  });
});
