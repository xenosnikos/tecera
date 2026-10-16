import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { event, type TeceraEvent } from '@tecera/contracts';
import { HeadStore, SqliteLedger } from '@tecera/ledger';
import { caseIdOf } from '@tecera/runtime';
import { cli, Flow, KEYS, ledgerEvents, prRequest, requestIdOf, sampleRepo } from './harness/e2e.js';
import { cleanupTemps, PACKAGES, tmp } from './harness/tmp.js';

/**
 * Hardened mode (HARDENED_INDEX in index.ts): the three attacks single-user mode documents as open, run
 * against real scripted runs (real ledger, sandbox, verify runner, gates, git) under a hardened host built in
 * a temp directory: the operator is this process (root), the agent is a spare unprivileged uid played by
 * child processes. Each case first shows the attack succeeding in single-user mode, then failing hardened.
 */

vi.setConfig({ testTimeout: 1_800_000, hookTimeout: 300_000 });
afterAll(cleanupTemps);

const ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const AGENT = 65524;
const BIN = join(PACKAGES, 'tecera/bin/tecera.js');

let agentNode = '';
beforeAll(() => {
  if (!ROOT) return;
  const d = tmp('tecera-adv-hard-node-');
  chmodSync(d, 0o755);
  agentNode = join(d, 'node');
  copyFileSync(process.execPath, agentNode);
  chmodSync(agentNode, 0o755);
});

/** A hardened host: root-owned configuration and state under a temp directory, the agent a spare uid. */
function hardenedHost(): { state: string; env: Record<string, string> } {
  const base = tmp('tecera-adv-hard-');
  chmodSync(base, 0o755);
  const state = join(base, 'state');
  mkdirSync(state, { mode: 0o755 });
  chmodSync(state, 0o755);
  mkdirSync(join(base, 'etc'), { mode: 0o755 });
  const config = join(base, 'etc', 'hardened.json');
  writeFileSync(config, JSON.stringify({ version: 1, stateDir: state, operator: { uid: 0 }, agents: [{ uid: AGENT }] }), { mode: 0o644 });
  chmodSync(config, 0o644);
  return { state, env: { TECERA_HARDENED_CONFIG: config } };
}

/** A sample business case and its run, single-user or hardened (its single-user ledger imported as the legacy baseline). */
async function setup(hardened: boolean): Promise<{ dir: string; flow: Flow; env: Record<string, string>; caseDir: string | null }> {
  const { dir, wt } = await sampleRepo();
  const h = hardened ? hardenedHost() : null;
  if (h) {
    const e = await cli(dir, ['hardened', 'enroll', '--import', '.tecera/ledger.sqlite'], { env: { ...h.env, TECERA_DECISION_NONINTERACTIVE: '1' } });
    expect(e.code, e.err + e.out).toBe(0);
    execFileSync('chmod', ['-R', 'a+rX', dir]);
  }
  // hardened: checks run as a spare unprivileged identity, never as root or the operator (it must read the worktrees)
  const ident = { TECERA_VERIFY_UID: process.env.TECERA_VERIFY_UID ?? '65531', TECERA_VERIFY_GID: process.env.TECERA_VERIFY_GID ?? process.env.TECERA_VERIFY_UID ?? '65531' };
  if (h) chmodSync(wt, 0o755);
  const env = h ? { ...h.env, ...ident } : {};
  return { dir, flow: new Flow(dir, wt, undefined, env), env, caseDir: h ? join(h.state, 'cases', caseIdOf(dir)) : null };
}

const ledgerFile = (s: { dir: string; caseDir: string | null }): string => (s.caseDir ? join(s.caseDir, 'ledger.sqlite') : join(s.dir, '.tecera/ledger.sqlite'));

async function events(s: { dir: string; caseDir: string | null }): Promise<TeceraEvent[]> {
  if (!s.caseDir) return ledgerEvents(s.dir);
  const l = new SqliteLedger(ledgerFile(s), { readonly: true, head: new HeadStore(s.caseDir) });
  const out: TeceraEvent[] = [];
  for await (const e of l.events()) out.push(e);
  l.close();
  return out;
}

/** Drive the first segment to its PR hold: [runId, PR request id]. */
async function heldAtPr(s: { dir: string; flow: Flow; caseDir: string | null }): Promise<{ runId: string; requestId: string }> {
  const seg = await s.flow.drive();
  expect(seg.code, seg.err + seg.out).toBe(4);
  const evs = await events(s);
  const runId = evs.find((e) => e.kind === 'run.started')!.runId!;
  s.flow.runId = runId;
  const requestId = requestIdOf(prRequest(evs as never))!;
  expect(requestId).toBeTruthy();
  return { runId, requestId };
}

const stop = (dir: string, env: Record<string, string>) => cli(dir, ['hook', 'stop'], { env, stdin: JSON.stringify({ hook_event_name: 'Stop', cwd: dir, session_id: 'cc-adv' }) });

/** A chain-valid run.ended(0), appended through the ledger API (through the checkpoint in hardened mode). */
async function forgeEnded(s: { dir: string; caseDir: string | null }, runId: string): Promise<void> {
  const l = s.caseDir ? new SqliteLedger(ledgerFile(s), { head: new HeadStore(s.caseDir), journalMode: 'delete' }) : new SqliteLedger(ledgerFile(s));
  await l.append(event('run.ended', { id: `forged-${runId}`, at: Date.now(), actor: { kind: 'system', id: 'tecera-cli' }, runId, trace: {}, payload: { exitCode: 0, reason: 'goal achieved', goalId: 'fix-failing-test' } }));
  expect((await l.verifyChain()).ok, 'the forged event leaves the chain (and the checkpoint) intact').toBe(true);
  l.close();
}

describe.skipIf(!ROOT)('hardened mode (HARDENED_INDEX)', () => {
  it('hardened.forged_run_ended: a chain-valid run.ended after a denied PR hides the run in single-user mode; hardened, the run registry keeps it open and the agent cannot append at all', async () => {
    // single-user: the attack works (the approval row is denied, so nothing holds the run any more)
    const su = await setup(false);
    const a = await heldAtPr(su);
    expect((await cli(su.dir, ['deny', a.requestId, '--reason', 'no', '--as', 'reviewer-human'], { env: KEYS })).code).toBe(0);
    await forgeEnded(su, a.runId);
    expect((await stop(su.dir, {})).code, 'single-user: the forged end hides the run').toBe(0);

    const hd = await setup(true);
    const b = await heldAtPr(hd);
    expect((await cli(hd.dir, ['deny', b.requestId, '--reason', 'no', '--as', 'reviewer-human'], { env: { ...KEYS, ...hd.env } })).code).toBe(0);
    await forgeEnded(hd, b.runId);
    const blocked = await stop(hd.dir, hd.env);
    expect(blocked.code, blocked.err).toBe(2);
    expect(blocked.err).toMatch(new RegExp(`run ${b.runId}.*according to the run registry`));
    // the agent identity cannot append in the first place: the database is read-only to it
    const ledgerModule = join(PACKAGES, 'ledger/dist/index.js');
    const r = spawnSync(agentNode, ['--input-type=module', '-e', `import { SqliteLedger } from ${JSON.stringify(ledgerModule)}; try { new SqliteLedger(process.argv[1]); console.log('opened'); } catch (e) { console.log('refused', e.code ?? e.message); }`, ledgerFile(hd)], { uid: AGENT, gid: AGENT, encoding: 'utf8' });
    expect(r.stdout, r.stderr).toMatch(/^refused/);
    // the run is closed by the supervisor's own end: resuming it ends it (exit 8, the PR was denied)
    const end = await hd.flow.drive();
    expect(end.code, end.err + end.out).toBe(8);
    expect((await stop(hd.dir, hd.env)).code).toBe(0);
  });

  it('hardened.agent_approve: the agent uid, with a pseudo-terminal, no agent markers, the opt-out and --as, cannot approve; the operator then can, and the run delivers', async () => {
    const hd = await setup(true);
    const { requestId } = await heldAtPr(hd);
    const env = { PATH: `${dirname(agentNode)}:/usr/bin:/bin`, HOME: hd.dir, USER: 'reviewer-human', TECERA_DECISION_NONINTERACTIVE: '1', ...hd.env };
    const cmd = [agentNode, BIN, 'approve', requestId, '--as', 'reviewer-human', '--yes'].map((x) => `'${x}'`).join(' ');
    const r = spawnSync('script', ['-qec', cmd, '/dev/null'], { cwd: hd.dir, env, uid: AGENT, gid: AGENT, encoding: 'utf8', timeout: 900_000 }); // a cold start from the repository mount can take minutes on a loaded host
    expect(r.status, r.stdout + r.stderr).toBe(8);
    expect(r.stdout + r.stderr).toMatch(/Hardened mode: this process runs as uid 65524.*an agent identity/);
    const l = new SqliteLedger(ledgerFile(hd), { readonly: true, head: new HeadStore(hd.caseDir!) });
    expect((await l.getApproval(requestId))?.state).toBe('pending');
    l.close();
    expect((await events(hd)).some((e) => e.kind === 'approval.granted')).toBe(false);
    // the operator approves (this process) and the resume delivers
    expect((await cli(hd.dir, ['approve', requestId, '--as', 'reviewer-human', '--yes'], { env: { ...KEYS, ...hd.env } })).code).toBe(0);
    const done = await hd.flow.drive();
    expect(done.code, done.err + done.out).toBe(0);
    const granted = (await events(hd)).find((e) => e.kind === 'approval.granted')!;
    expect(granted.payload).toMatchObject({ identity: { method: 'operator-uid', os: { uid: 0 } } });
  }, 1_800_000);

  it('hardened.truncated_tail: deleting the tail of a delivered run verifies as a chain and passes the Stop hook in single-user mode; hardened, the head checkpoint names it and nothing more is written', async () => {
    const truncate = (file: string): void => {
      const d = new DatabaseSync(file);
      d.exec('DROP TRIGGER events_no_delete; DROP TRIGGER evidence_no_delete;');
      d.exec('DELETE FROM events WHERE seq = (SELECT MAX(seq) FROM events); DELETE FROM evidence WHERE n = (SELECT MAX(n) FROM evidence)');
      d.close();
    };
    const deliver = async (s: Awaited<ReturnType<typeof setup>>): Promise<void> => {
      const { requestId } = await heldAtPr(s);
      expect((await cli(s.dir, ['approve', requestId, '--as', 'reviewer-human', '--yes'], { env: { ...KEYS, ...s.env } })).code).toBe(0);
      const done = await s.flow.drive();
      expect(done.code, done.err + done.out).toBe(0);
      expect((await stop(s.dir, s.env)).code).toBe(0);
    };
    const su = await setup(false);
    await deliver(su);
    truncate(ledgerFile(su));
    const plain = new SqliteLedger(ledgerFile(su));
    expect((await plain.verifyChain()).ok, 'single-user: the truncated chain still verifies').toBe(true);
    plain.close();
    expect((await stop(su.dir, {})).code, 'single-user: the Stop hook does not see it').toBe(0);

    const hd = await setup(true);
    await deliver(hd);
    truncate(ledgerFile(hd));
    const blocked = await stop(hd.dir, hd.env);
    expect(blocked.code, blocked.err).toBe(2);
    expect(blocked.err).toMatch(/ledger head checkpoint: .*1 acknowledged event\(s\) are missing; 1 acknowledged evidence row\(s\) are missing/);
    // the supervisor refuses to start on top of it (readiness verifies the chain, which includes the checkpoint)
    const before = (await events(hd)).length;
    const next = await cli(hd.dir, ['run', 'fix-failing-test'], { env: { ...KEYS, ...hd.env } });
    expect(next.code, next.err).toBe(3);
    expect(next.err).toMatch(/hash chain broken.*nothing was executed/s);
    expect((await events(hd)).length).toBe(before);
  });
});
