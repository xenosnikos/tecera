import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, chownSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { event, type AchievementGoal, type BeliefProjection, type GateContext, type GateRunner, type Json, type Ledger, type Outcome, type Plan, type Planner, type RunRegistryEntry, type TeceraEvent, type VerifyOutcome, type VerifyRequest, type VerifyRunner, type Worker, type WorkerStepRequest } from '@tecera/contracts';
import { HeadStore, SqliteLedger } from '@tecera/ledger';
import { main, type MainOptions } from './cli/main.js';
import { decisionTerminal, guardDecision } from './decisionGuard.js';
import { operatorRefusal, processCredentials } from './hardened/authority.js';
import { caseIdOf } from './hardened/context.js';
import { RunRegistry } from './hardened/registry.js';
import { WiringError, type WireFn, type WiringContext } from './wiring.js';

/**
 * Hardened mode, end to end through the CLI. The operator is this test process (root, uid 0); the agent is a
 * spare unprivileged uid, played by child processes started with that uid against a state directory under a
 * temp directory, so no host account is created and nothing outside the temp directories changes. Every
 * guarantee is shown against its absence: the same forged event or tamper is first shown to pass (or to be
 * possible) in single-user mode, or with the protection removed.
 */

// Agent-uid children start the CLI cold from the repository mount: minutes each on a loaded host.
vi.setConfig({ testTimeout: 1_800_000, hookTimeout: 300_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const SAMPLE = join(REPO, 'samples/fix-failing-test');
const BIN = join(REPO, 'packages/tecera/bin/tecera.js');
const ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
/** Spare uids for the agent (and a third identity that is neither operator nor agent). */
const AGENT = 65520;
const STRANGER = 65521;

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix = 'tecera-hard-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(d, 0o755);
  temps.push(d);
  return d;
}

/** A node binary the agent uid can execute (the one in use may live under a directory it cannot enter). */
let agentNode = '';
const nodeDir = mkdtempSync(join(tmpdir(), 'tecera-hard-node-'));
beforeAll(() => {
  chmodSync(nodeDir, 0o755);
  agentNode = join(nodeDir, 'node');
  copyFileSync(process.execPath, agentNode);
  chmodSync(agentNode, 0o755);
});
afterAll(() => rmSync(nodeDir, { recursive: true, force: true }));

const HOST = ROOT ? { TECERA_VERIFY_ALLOW_ROOT: '1' } : {};
const KEYS = { ANTHROPIC_API_KEY: 'test-anthropic-credential-0123456789', OPENAI_API_KEY: 'test-openai-credential-9876543210', OPENROUTER_API_KEY: 'test-openrouter-credential-5555555555' };

/** A hardened host under a temp directory: the configuration file and the state directory, both root-owned. */
function hardenedHost(opts: { operator?: number; agents?: number[] } = {}): { base: string; state: string; config: string; env: Record<string, string> } {
  const base = tmp();
  const state = join(base, 'state');
  mkdirSync(state, { mode: 0o755 });
  chmodSync(state, 0o755);
  mkdirSync(join(base, 'etc'), { mode: 0o755 });
  const config = join(base, 'etc', 'hardened.json');
  writeFileSync(config, JSON.stringify({ version: 1, stateDir: state, operator: { uid: opts.operator ?? 0 }, agents: (opts.agents ?? [AGENT]).map((uid) => ({ uid })) }), { mode: 0o644 });
  chmodSync(config, 0o644);
  // checks never run as root or as the operator in hardened mode: a spare unprivileged identity
  return { base, state, config, env: { TECERA_HARDENED_CONFIG: config, TECERA_VERIFY_UID: '65531', TECERA_VERIFY_GID: '65531' } };
}

function gitRepo(dir: string): void {
  const g = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args], { env: { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null' } });
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
}

const DECISIONS = new Set(['approve', 'deny', 'criteria', 'resources', 'plans', 'memory', 'hardened']);
let idn = 0;
async function cli(cwd: string, argv: string[], opts: MainOptions & { hardened?: Record<string, string> | null } = {}): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const { env: extraEnv, hardened, ...rest } = opts;
  const code = await main(argv, {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: 'tester', ...HOST, ...(DECISIONS.has(argv[0]!) ? { TECERA_DECISION_NONINTERACTIVE: '1' } : {}), ...(hardened ?? {}), ...(extraEnv ?? {}) },
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    isTTY: false,
    ids: (p) => `${p}_h${++idn}`,
    ...rest,
  });
  return { code, out, err };
}

// ---------- the loop fakes of cli.test.ts (a run that holds at the PR, then delivers once approved) ----------

const fixPlan = (): Plan => ({
  id: 'p_fix',
  trigger: { kind: 'goal.adopted' },
  context: [{ key: 'verify.baseline', equals: 'failing' }],
  steps: [
    { id: 'analyze', kind: 'worker', dependsOn: [], inputs: {}, instruction: 'read the failing test' },
    { id: 'edit', kind: 'worker', dependsOn: ['analyze'], inputs: {}, instruction: 'fix the implementation' },
    { id: 'verify1', kind: 'gate.verify', dependsOn: ['edit'], inputs: {} },
    { id: 'review', kind: 'gate.review', dependsOn: ['verify1'], inputs: {} },
    { id: 'verify2', kind: 'gate.verify', dependsOn: ['review'], inputs: {} },
    { id: 'commit', kind: 'gate.commit', dependsOn: ['verify2'], inputs: {} },
    { id: 'pr', kind: 'gate.pr', dependsOn: ['commit'], inputs: {} },
  ],
  allowedModels: { analyze: ['worker'], edit: ['worker'] },
  permissions: { tools: ['read', 'edit', 'runVerify'], write: ['src/**'], approvals: ['open_pr', 'git_push'] },
  budget: {},
  origin: 'generated',
  status: 'candidate',
  goalKinds: ['fix-failing-test'],
});

class FakePlanner implements Planner {
  async write(_e: TeceraEvent, _b: BeliefProjection, _g: AchievementGoal): Promise<Plan> {
    return fixPlan();
  }
  async deliberate(options: Plan[]): Promise<Plan> {
    return options[0]!;
  }
}

class FakeWorker implements Worker {
  onRun: ((req: WorkerStepRequest) => void) | null = null;
  async run(req: WorkerStepRequest): Promise<Outcome> {
    this.onRun?.(req);
    return { kind: 'returned', value: { facts: [] }, run: { runId: req.runId, invokeId: `inv_${req.step.id}`, depth: 0 } };
  }
  async resume(): Promise<Outcome> {
    throw new Error('not used');
  }
}

class FakeGates implements GateRunner {
  ledger: Ledger | null = null;
  n = 0;
  private async ev(key: string, kind: string, runId: string, body: Record<string, Json> = {}): Promise<string> {
    await this.ledger?.evidence({ key, kind, runId, body: { fake: true, ...body } });
    return key;
  }
  async verify(ctx: GateContext) {
    return { exitCode: 0, evidenceKey: await this.ev(`verify-${ctx.runId}-${++this.n}`, 'gate.verify', ctx.runId, { exitCode: 0, outcome: 'passed', fingerprint: 'd1-fake', command: ctx.goal.check.command }), fingerprint: 'd1-fake' };
  }
  async review(ctx: GateContext) {
    return { verdict: 'approve' as const, evidenceKey: await this.ev(`review-${ctx.runId}`, 'review', ctx.runId), fingerprint: 'd1-fake' };
  }
  async commit(ctx: GateContext) {
    return { exitCode: 0, sha: 'abc123', evidenceKey: await this.ev(`commit-${ctx.runId}`, 'commit', ctx.runId) };
  }
  async pr(ctx: GateContext) {
    const sha = ctx.commit?.sha ?? '';
    if (!ctx.approval || !sha) return { exitCode: 8, sha, evidenceKey: await this.ev(`pr-${ctx.runId}-refused`, 'gate.pr', ctx.runId), terminal: true, reason: 'no approval or no commit' };
    await this.ledger!.consume(ctx.approval.requestId, ctx.approval.actionHash, ctx.approval.sessionId, `pr:${ctx.approval.requestId}`, Date.now());
    return { exitCode: 0, sha, branch: 'tecera/fix-failing-test', base: 'main', bundle: `.tecera/runs/${ctx.runId}/pr/0001.patch`, evidenceKey: await this.ev(`pr-${ctx.runId}`, 'gate.pr', ctx.runId) };
  }
}

function fakeWire(onWire?: (ctx: WiringContext) => void): { wire: WireFn; worker: FakeWorker } {
  const worker = new FakeWorker();
  const gates = new FakeGates();
  const planner = new FakePlanner();
  return {
    worker,
    wire: (async (ctx) => {
      onWire?.(ctx);
      gates.ledger = ctx.ledger;
      return { planner, worker, gates, seats: [{ seatId: 'worker', costPerMTok: 1 }], worktree: ctx.root, reapPrior: async () => ({ killed: [], survivors: [] }) };
    }) as WireFn,
  };
}

class FakeVerify implements VerifyRunner {
  async run(_req: VerifyRequest): Promise<VerifyOutcome> {
    return { exitCode: 1, signal: null, timedOut: false, stdout: 'not ok', stderr: '', durationMs: 5, truncated: false };
  }
}

/** A business case (sample copy, init'd, committed), readable by the agent uid. */
async function businessCase(hardened: Record<string, string> | null): Promise<string> {
  const dir = tmp('tecera-hard-case-');
  cpSync(SAMPLE, dir, { recursive: true, filter: (src) => !/node_modules|ledger\.sqlite|[\\/]runs([\\/]|$)/.test(src) });
  const r = await cli(dir, ['init'], { hardened });
  expect(r.code, r.err).toBe(0);
  gitRepo(dir);
  execFileSync('chmod', ['-R', 'a+rX', dir]);
  if (hardened) {
    const e = await cli(dir, ['hardened', 'enroll'], { hardened });
    expect(e.code, e.err + e.out).toBe(0);
  }
  return dir;
}

async function readEvents(db: string, headDir?: string): Promise<TeceraEvent[]> {
  const l = new SqliteLedger(db, headDir ? { readonly: true, head: new HeadStore(headDir) } : {});
  const out: TeceraEvent[] = [];
  for await (const e of l.events()) out.push(e);
  l.close();
  return out;
}

function caseDirOf(state: string, dir: string): string {
  return join(state, 'cases', caseIdOf(dir));
}

/** A run held at its PR: [runId, requestId]. */
async function heldRun(dir: string, hardened: Record<string, string> | null, w = fakeWire()): Promise<{ runId: string; requestId: string }> {
  const r = await cli(dir, ['run', 'fix-failing-test'], { wire: w.wire, verifyRunner: new FakeVerify(), env: KEYS, hardened });
  expect(r.code, r.err + r.out).toBe(4);
  const runId = /run (r_h\d+)/.exec(r.out)![1]!;
  const requestId = /held for PR approval (\S+)/.exec(r.out)?.[1] ?? /approval (\S+)/.exec(r.out)![1]!;
  return { runId, requestId: requestId.replace(/[^A-Za-z0-9_-]/g, '') };
}

/** Append a well-formed run.ended through the ledger API: through the checkpoint in hardened mode (so it stays consistent). */
async function forgeEnded(db: string, runId: string, exitCode: number, headDir?: string): Promise<void> {
  const l = headDir ? new SqliteLedger(db, { head: new HeadStore(headDir), journalMode: 'delete' }) : new SqliteLedger(db);
  await l.append(event('run.ended', { id: `forged-${runId}-${exitCode}-${++idn}`, at: Date.now(), actor: { kind: 'system', id: 'tecera-cli' }, runId, trace: {}, payload: { exitCode, reason: 'goal achieved (forged)', goalId: 'fix-failing-test' } }));
  expect((await l.verifyChain()).ok).toBe(true); // the forgery is internally consistent: only the registry can refuse it
  l.close();
}

const stop = (dir: string, opts: MainOptions & { hardened?: Record<string, string> | null } = {}) => cli(dir, ['hook', 'stop'], { stdin: JSON.stringify({ hook_event_name: 'Stop', cwd: dir }), ...opts });

function registryEntry(state: string, dir: string, runId: string): RunRegistryEntry {
  return JSON.parse(readFileSync(join(caseDirOf(state, dir), 'runs', `${runId}.json`), 'utf8')) as RunRegistryEntry;
}

/** Run the CLI as `uid` in a child process (optionally inside a pseudo-terminal from script(1)). */
function asUid(uid: number, cwd: string, argv: string[], env: Record<string, string>, opts: { pty?: boolean; stdin?: string } = {}): { code: number | null; out: string; err: string } {
  const childEnv = { PATH: `${dirname(agentNode)}:/usr/bin:/bin`, HOME: cwd, ...env };
  const quoted = [agentNode, BIN, ...argv].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  const r = opts.pty
    ? spawnSync('script', ['-qec', quoted, '/dev/null'], { cwd, env: childEnv, uid, gid: uid, encoding: 'utf8', timeout: 900_000, input: opts.stdin ?? '' })
    : spawnSync(agentNode, [BIN, ...argv], { cwd, env: childEnv, uid, gid: uid, encoding: 'utf8', timeout: 900_000, input: opts.stdin ?? '' });
  return { code: r.status, out: r.stdout ?? '', err: `${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
}

describe.skipIf(!ROOT)('hardened mode', () => {
  describe('startup refuses when the agent identity could change the state', () => {
    it('accepts a correct host, then refuses each way the agent could write: modes, ownership, links, the configuration, placement, identities', async () => {
      const h = hardenedHost();
      const dir = await businessCase(h.env);
      expect((await cli(dir, ['status'], { hardened: h.env })).code).toBe(0);
      const cd = caseDirOf(h.state, dir);
      const refuse = async (what: string, re: RegExp): Promise<void> => {
        const st = await cli(dir, ['status'], { hardened: h.env });
        expect(st.code, `${what}: ${st.err}`).toBe(3);
        expect(st.err, what).toMatch(re);
        const sh = await stop(dir, { hardened: h.env });
        expect(sh.code, `${what} (stop hook)`).toBe(2);
      };
      chmodSync(h.state, 0o777);
      await refuse('state o+w', /refusing to start: .*writable by group or others/);
      chmodSync(h.state, 0o755);
      chownSync(h.state, AGENT, AGENT);
      await refuse('state owned by the agent', /owned by uid 65520/);
      chownSync(h.state, 0, 0);
      chownSync(join(cd, 'head.json'), AGENT, AGENT);
      await refuse('checkpoint owned by the agent', /head\.json is owned by uid 65520/);
      chownSync(join(cd, 'head.json'), 0, 0);
      chmodSync(join(cd, 'runs'), 0o775);
      await refuse('registry group-writable', /runs is writable by group or others/);
      chmodSync(join(cd, 'runs'), 0o755);
      symlinkSync('/tmp', join(cd, 'link'));
      await refuse('a link in the state', /is a symbolic link/);
      rmSync(join(cd, 'link'));
      chmodSync(h.base, 0o777);
      await refuse('a directory above the state is world-writable', /writable by group or others/);
      chmodSync(h.base, 0o755);
      chownSync(h.config, AGENT, AGENT);
      await refuse('configuration owned by the agent', /configuration cannot be trusted: .*owned by uid 65520/);
      chownSync(h.config, 0, 0);
      expect((await cli(dir, ['status'], { hardened: h.env })).code).toBe(0);
      // the state inside the repository it protects
      const inRepo = hardenedHost();
      const d2 = tmp('tecera-hard-case-');
      cpSync(SAMPLE, d2, { recursive: true, filter: (src) => !/node_modules|ledger\.sqlite/.test(src) });
      const cfg = JSON.parse(readFileSync(inRepo.config, 'utf8')) as Record<string, unknown>;
      mkdirSync(join(d2, 'state'), { mode: 0o755 });
      writeFileSync(inRepo.config, JSON.stringify({ ...cfg, stateDir: join(d2, 'state') }));
      chmodSync(d2, 0o755);
      const placed = await cli(d2, ['status'], { hardened: inRepo.env });
      expect(placed.code).toBe(3);
      expect(placed.err).toMatch(/overlap; the state must live outside the repository/);
      // identities: the agent cannot be the operator, nor root
      for (const bad of [{ operator: AGENT, agents: [AGENT] }, { operator: 1000, agents: [0] }]) {
        const b = hardenedHost(bad);
        const r = await cli(dir, ['status'], { hardened: b.env });
        expect(r.code).toBe(3);
        expect(r.err).toMatch(/both the operator and an agent|an agent cannot be root/);
      }
    });
  });

  describe('the agent identity cannot write the state', () => {
    it('as the agent uid: no file can be created, opened for writing, replaced or removed in the state; with the modes loosened it could', async () => {
      const h = hardenedHost();
      const dir = await businessCase(h.env);
      await heldRun(dir, h.env);
      const cd = caseDirOf(h.state, dir);
      const run = readdirSync(join(cd, 'runs')).find((n) => n.endsWith('.json'))!;
      const probe = `
        const fs = require('fs'); const p = require('path'); const cd = process.argv[1]; const out = {};
        const t = (k, f) => { try { f(); out[k] = 'ok'; } catch (e) { out[k] = e.code; } };
        t('create', () => fs.writeFileSync(p.join(cd, 'planted'), 'x'));
        t('ledgerWrite', () => fs.closeSync(fs.openSync(p.join(cd, 'ledger.sqlite'), 'r+')));
        t('headWrite', () => fs.closeSync(fs.openSync(p.join(cd, 'head.json'), 'r+')));
        t('headReplace', () => fs.renameSync(p.join(cd, 'case.json'), p.join(cd, 'head.json')));
        t('headRemove', () => fs.unlinkSync(p.join(cd, 'head.json')));
        t('registryWrite', () => fs.closeSync(fs.openSync(p.join(cd, 'runs', process.argv[2]), 'r+')));
        t('registryCreate', () => fs.writeFileSync(p.join(cd, 'runs', 'r_forged.json'), '{}'));
        t('registryRemove', () => fs.unlinkSync(p.join(cd, 'runs', process.argv[2])));
        t('read', () => fs.readFileSync(p.join(cd, 'head.json')));
        process.stdout.write(JSON.stringify(out));`;
      const r = spawnSync(agentNode, ['-e', probe, cd, run], { uid: AGENT, gid: AGENT, encoding: 'utf8' });
      const got = JSON.parse(r.stdout || '{}') as Record<string, string>;
      expect(got).toEqual({ create: 'EACCES', ledgerWrite: 'EACCES', headWrite: 'EACCES', headReplace: 'EACCES', headRemove: 'EACCES', registryWrite: 'EACCES', registryCreate: 'EACCES', registryRemove: 'EACCES', read: 'ok' });
      // positive control: the same probe succeeds once the state is world-writable (which startup then refuses)
      execFileSync('chmod', ['-R', 'a+w', cd]);
      const loose = JSON.parse(spawnSync(agentNode, ['-e', probe, cd, run], { uid: AGENT, gid: AGENT, encoding: 'utf8' }).stdout || '{}') as Record<string, string>;
      expect(loose.create).toBe('ok');
      expect((await cli(dir, ['status'], { hardened: h.env })).code).toBe(3);
    });

    it('a check never runs as root or as the operator: `tecera run` and `tecera gate` refuse before anything runs', async () => {
      const h = hardenedHost();
      const dir = await businessCase(h.env);
      const bare = { TECERA_HARDENED_CONFIG: h.env.TECERA_HARDENED_CONFIG! };
      const verify = new FakeVerify();
      let wired = 0;
      const w = fakeWire(() => void wired++);
      // this host's default accepts a degraded root verify (TECERA_VERIFY_ALLOW_ROOT=1): refused here
      const asRoot = await cli(dir, ['run', 'fix-failing-test'], { wire: w.wire, verifyRunner: verify, env: KEYS, hardened: bare });
      expect(asRoot.code).toBe(3);
      expect(asRoot.err).toMatch(/must not run as root/);
      // named as the operator (uid 0 here is also root; the operator check is the same rule)
      const asOperator = await cli(dir, ['run', 'fix-failing-test'], { wire: w.wire, verifyRunner: verify, env: { ...KEYS, TECERA_VERIFY_ALLOW_ROOT: '' }, hardened: { ...bare } });
      expect(asOperator.code).toBe(3);
      expect(asOperator.err).toMatch(/must not run as (root|the operator)/);
      expect(wired).toBe(0);
      expect(readdirSync(join(caseDirOf(h.state, dir), 'runs'))).toEqual([]);
      const gate = await cli(dir, ['gate', 'fix-failing-test'], { hardened: bare });
      expect(gate.code).not.toBe(0);
      expect(gate.out + gate.err).toMatch(/must not run as root/);
    });

    it('`tecera run` refuses unless it runs as the operator', async () => {
      const h = hardenedHost();
      const dir = await businessCase(h.env);
      const real = { uid: processCredentials.uid, euid: processCredentials.euid };
      processCredentials.uid = () => AGENT;
      processCredentials.euid = () => AGENT;
      try {
        const r = await cli(dir, ['run', 'fix-failing-test'], { wire: fakeWire().wire, verifyRunner: new FakeVerify(), env: KEYS, hardened: h.env });
        expect(r.code).toBe(8);
        expect(r.err).toMatch(/runs as the operator identity/);
      } finally {
        Object.assign(processCredentials, real);
      }
    });
  });

  describe('decisions: only the operator uid, whatever the terminal, environment or --as', () => {
    it('as the agent uid every decision command refuses (exit 8) with and without a PTY, with --as and the opt-out; the request stays pending; the operator can decide and its uid is recorded', async () => {
      const h = hardenedHost({ agents: [AGENT] });
      const dir = await businessCase(h.env);
      const { runId, requestId } = await heldRun(dir, h.env);
      const heldAt = Date.now(); // the agent attempts below can outlast the approval's lifetime on a loaded host
      const cd = caseDirOf(h.state, dir);
      const env = { ...h.env, TECERA_DECISION_NONINTERACTIVE: '1', USER: 'operator' };
      const commands: string[][] = [
        ['approve', requestId, '--as', 'operator'],
        ['deny', requestId, '--reason', 'no', '--as', 'operator'],
        ['criteria', 'accept', runId, '--as', 'operator'],
        ['criteria', 'amend', runId, '--file', 'x.json', '--reason', 'r', '--as', 'operator'],
        ['resources', 'release', 'res_1', '--as', 'operator'],
        ['plans', 'graduate', 'p_fix', '--rationale', 'r', '--as', 'operator'],
        ['memory', 'graduate', 'm_1', '--rationale', 'r', '--as', 'operator'],
        ['hardened', 'enroll'],
        ['hardened', 'abandon', runId, '--reason', 'r'],
      ];
      for (const argv of commands) {
        // every command under a pseudo-terminal; the first two also without one
        for (const pty of argv[0] === 'approve' || argv[0] === 'deny' ? [false, true] : [true]) {
          const r = asUid(AGENT, dir, argv, env, { pty });
          expect(r.code, `${argv.join(' ')} pty=${pty}: ${r.out}${r.err}`).toBe(8);
          expect(`${r.out}${r.err}`).toMatch(/Hardened mode: this process runs as uid 65520.*an agent identity/);
        }
      }
      // neither operator nor agent: refused as well
      const s = asUid(STRANGER, dir, ['approve', requestId, '--as', 'operator'], env, { pty: true });
      expect(s.code).toBe(8);
      expect(s.out + s.err).toMatch(/not as the operator identity/);
      const evs = await readEvents(join(cd, 'ledger.sqlite'), cd);
      expect(evs.some((e) => e.kind === 'approval.granted' || e.kind === 'approval.denied')).toBe(false);
      const l = new SqliteLedger(join(cd, 'ledger.sqlite'), { readonly: true, head: new HeadStore(cd) });
      expect((await l.getApproval(requestId))?.state).toBe('pending');
      l.close();
      // the operator (this process, uid 0) decides; the audit event records the OS identity, --as is the label
      const ok = await cli(dir, ['approve', requestId, '--as', 'alice'], { hardened: h.env, now: () => heldAt + 1000 });
      expect(ok.code, ok.err).toBe(0);
      const granted = (await readEvents(join(cd, 'ledger.sqlite'), cd)).find((e) => e.kind === 'approval.granted')!;
      expect(granted.actor).toEqual({ kind: 'human', id: 'alice' });
      expect(granted.payload).toMatchObject({ identity: { id: 'alice', method: 'operator-uid', authenticated: false, os: { uid: 0, euid: 0, boundary: 'operator-uid' } }, guard: { os: { uid: 0, boundary: 'operator-uid' } } });
    }, 7_200_000);

    it('in single-user mode the same agent-uid process, given a PTY and write access to the ledger, approves: the boundary is what hardened mode adds', async () => {
      const dir = await businessCase(null);
      const { requestId } = await heldRun(dir, null);
      execFileSync('chmod', ['-R', 'a+rwX', join(dir, '.tecera')]);
      const r = asUid(AGENT, dir, ['approve', requestId, '--as', 'operator'], { USER: 'operator' }, { pty: true });
      expect(r.code, r.out + r.err).toBe(0);
      const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
      expect((await l.getApproval(requestId))?.state).toBe('granted');
      l.close();
    });

    it('the uid check reads the process credentials only: an agent uid with a terminal, the opt-out and no markers is refused; a setuid-style split is refused', () => {
      const h = hardenedHost();
      const out: string[] = [];
      const c = { opts: { env: { ...h.env, TECERA_DECISION_NONINTERACTIVE: '1' } }, out: { error: (s: string) => out.push(s), set: () => undefined } } as unknown as Parameters<typeof guardDecision>[0];
      const real = { uid: processCredentials.uid, euid: processCredentials.euid, tty: decisionTerminal.stdinIsTTY };
      try {
        decisionTerminal.stdinIsTTY = () => true;
        processCredentials.uid = () => AGENT;
        processCredentials.euid = () => AGENT;
        expect(guardDecision(c, 'approve')).toBe(8);
        processCredentials.uid = () => AGENT;
        processCredentials.euid = () => 0; // real uid the agent, effective the operator
        expect(guardDecision(c, 'approve')).toBe(8);
        processCredentials.uid = () => 0;
        processCredentials.euid = () => 0;
        const ok = guardDecision(c, 'approve');
        expect(typeof ok).toBe('object');
        expect((ok as { os?: { uid: number } }).os?.uid).toBe(0);
      } finally {
        Object.assign(processCredentials, { uid: real.uid, euid: real.euid });
        decisionTerminal.stdinIsTTY = real.tty;
      }
      expect(out.join('\n')).toMatch(/an agent identity/);
      const cfg = { version: 1 as const, stateDir: h.state, operator: { uid: 1000 }, agents: [{ uid: 1001 }], source: h.config, via: 'env' as const };
      expect(operatorRefusal(cfg, { uid: 1000, euid: 1000 })).toBeNull();
      expect(operatorRefusal(cfg, { uid: 1001, euid: 1000 })).toMatch(/agent identity/);
      expect(operatorRefusal(cfg, { uid: 1000, euid: 1001 })).toMatch(/agent identity/);
      expect(operatorRefusal(cfg, { uid: 0, euid: 0 })).toMatch(/not as the operator identity/);
    });
  });

  describe('run registry and Stop hook', () => {
    it('a run is registered before anything is wired; held → resumed → achieved is the supervisor own transition; the Stop hook follows the registry', async () => {
      const h = hardenedHost();
      const dir = await businessCase(h.env);
      const cd = caseDirOf(h.state, dir);
      let atWire: RunRegistryEntry[] = [];
      const w = fakeWire((ctx) => {
        atWire = readdirSync(join(cd, 'runs')).map((n) => JSON.parse(readFileSync(join(cd, 'runs', n), 'utf8')) as RunRegistryEntry).filter((e) => e.runId === ctx.runId);
      });
      const { runId, requestId } = await heldRun(dir, h.env, w);
      expect(atWire).toHaveLength(1);
      expect(atWire[0]).toMatchObject({ runId, state: 'registered', generation: 1, goalId: 'fix-failing-test' });
      expect(registryEntry(h.state, dir, runId)).toMatchObject({ state: 'held', exitCode: 4, generation: 1, terminalReason: null });
      expect((await stop(dir, { hardened: h.env })).code).toBe(2);
      expect((await cli(dir, ['approve', requestId, '--as', 'alice'], { hardened: h.env })).code).toBe(0);
      const resumed = await cli(dir, ['run', '--resume', runId], { wire: w.wire, env: KEYS, hardened: h.env });
      expect(resumed.code, resumed.err + resumed.out).toBe(0);
      expect(atWire[0]).toMatchObject({ state: 'running', generation: 2 });
      expect(registryEntry(h.state, dir, runId)).toMatchObject({ state: 'terminal', exitCode: 0, generation: 2 });
      const allowed = await stop(dir, { hardened: h.env });
      expect(allowed.code, allowed.err).toBe(0);
      // the ledger's head checkpoint moved with every acknowledged write
      const head = JSON.parse(readFileSync(join(cd, 'head.json'), 'utf8')) as { generation: number; eventCount: number };
      expect(head.generation).toBeGreaterThan(20);
      expect(head.eventCount).toBe((await readEvents(join(cd, 'ledger.sqlite'), cd)).length);
      // a terminal run is not resumed
      expect((await cli(dir, ['run', '--resume', runId], { wire: w.wire, env: KEYS, hardened: h.env })).code).toBe(3);
    });

    it('a denial closes a run only through the resume that ends it; a segment that never started puts the entry back', async () => {
      const h = hardenedHost();
      const dir = await businessCase(h.env);
      const w = fakeWire();
      const { runId, requestId } = await heldRun(dir, h.env, w);
      expect((await cli(dir, ['deny', requestId, '--reason', 'no', '--as', 'alice'], { hardened: h.env })).code).toBe(0);
      expect(registryEntry(h.state, dir, runId).state).toBe('held');
      expect((await stop(dir, { hardened: h.env })).code).toBe(2);
      // a resume whose wiring refuses changes nothing: the entry is put back as it was
      const refused = (async () => {
        throw new WiringError('no worktree today', 3);
      }) as unknown as WireFn;
      expect((await cli(dir, ['run', '--resume', runId], { wire: refused, env: KEYS, hardened: h.env })).code).toBe(3);
      expect(registryEntry(h.state, dir, runId)).toMatchObject({ state: 'held', generation: 1 });
      // one that throws something unexpected leaves the outcome unknown: open, interrupted
      const broken = (async () => {
        throw new Error('no wiring today');
      }) as unknown as WireFn;
      expect((await cli(dir, ['run', '--resume', runId], { wire: broken, env: KEYS, hardened: h.env })).code).not.toBe(0);
      expect(registryEntry(h.state, dir, runId)).toMatchObject({ state: 'interrupted' });
      const ended = await cli(dir, ['run', '--resume', runId], { wire: w.wire, env: KEYS, hardened: h.env });
      expect(ended.code).toBe(8);
      expect(registryEntry(h.state, dir, runId)).toMatchObject({ state: 'terminal', exitCode: 8 });
      expect((await stop(dir, { hardened: h.env })).code).toBe(0);
    });

    describe('a forged terminal event never removes a run (single-user mode shown first)', () => {
      type Host = { state: string; env: Record<string, string> } | null;
      type Case = { name: string; setup: (dir: string, h: Host) => Promise<{ runId: string; now?: () => number }>; singleUserAllows: boolean };
      const later = () => Date.now() + 3 * 3600_000; // past the PR approval's expiry (ttl 3600 s)
      const cases: Case[] = [
        {
          name: 'running (its supervisor died mid-segment)',
          singleUserAllows: true,
          setup: async (dir, h) => {
            // what a SIGKILLed supervisor leaves: run.started and goal.adopted, no end; in hardened mode the
            // registry entry it wrote (registered, then running) through the supervisor's own registry API
            const runId = `r_dead${++idn}`;
            const cd = h ? caseDirOf(h.state, dir) : null;
            const l = cd ? new SqliteLedger(join(cd, 'ledger.sqlite'), { head: new HeadStore(cd), journalMode: 'delete' }) : new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
            const base = { at: Date.now(), actor: { kind: 'system' as const, id: 'tecera-cli' }, runId };
            await l.append(event('run.started', { ...base, id: `${runId}-s`, trace: {}, payload: { goalId: 'fix-failing-test' } }));
            await l.append(event('goal.adopted', { ...base, id: `${runId}-g`, actor: { kind: 'agent', id: 'loop' }, trace: { goalId: 'fix-failing-test' }, payload: { goalId: 'fix-failing-test' } }));
            l.close();
            if (cd) {
              const reg = new RunRegistry(join(cd, 'runs'), { caseId: caseIdOf(dir) });
              reg.begin(runId, 'fix-failing-test', { resume: false });
              reg.running(runId);
            }
            return { runId };
          },
        },
        {
          name: 'interrupted (exit 130)',
          singleUserAllows: true,
          setup: async (dir, h) => {
            const ac = new AbortController();
            const w = fakeWire();
            w.worker.onRun = (req) => {
              if (req.step.id === 'analyze') ac.abort();
            };
            const r = await cli(dir, ['run', 'fix-failing-test'], { wire: w.wire, verifyRunner: new FakeVerify(), env: KEYS, hardened: h?.env ?? null, signal: ac.signal });
            expect(r.code, r.err + r.out).toBe(130);
            return { runId: /run (r_h\d+)/.exec(r.out)![1]! };
          },
        },
        {
          name: 'held at the PR, approval pending',
          singleUserAllows: false, // the approvals table holds it in single-user mode too
          setup: async (dir, h) => ({ runId: (await heldRun(dir, h?.env ?? null)).runId }),
        },
        {
          name: 'held, approval denied, not resumed',
          singleUserAllows: true,
          setup: async (dir, h) => {
            const { runId, requestId } = await heldRun(dir, h?.env ?? null);
            expect((await cli(dir, ['deny', requestId, '--reason', 'no', '--as', 'alice'], { hardened: h?.env ?? null })).code).toBe(0);
            return { runId };
          },
        },
        {
          name: 'held, approval expired',
          singleUserAllows: true,
          setup: async (dir, h) => ({ runId: (await heldRun(dir, h?.env ?? null)).runId, now: later }),
        },
      ];
      for (const k of cases) {
        it(k.name, async () => {
          // single-user: the forged run.ended
          const su = await businessCase(null);
          const s = await k.setup(su, null);
          await forgeEnded(join(su, '.tecera/ledger.sqlite'), s.runId, 0);
          const suStop = await stop(su, s.now ? { now: s.now } : {});
          expect(suStop.code, `single-user: ${suStop.err}`).toBe(k.singleUserAllows ? 0 : 2);
          // hardened: the same forgery through the ledger API, checkpoint kept consistent
          const h = hardenedHost();
          const dir = await businessCase(h.env);
          const r = await k.setup(dir, h);
          const cd = caseDirOf(h.state, dir);
          expect(registryEntry(h.state, dir, r.runId).state).not.toBe('terminal');
          await forgeEnded(join(cd, 'ledger.sqlite'), r.runId, 0, cd);
          const hs = await stop(dir, { hardened: h.env, ...(r.now ? { now: r.now } : {}) });
          expect(hs.code, `hardened: ${hs.err}`).toBe(2);
          expect(hs.err).toMatch(new RegExp(`run ${r.runId}`));
          // the same as the agent identity, reading the state read-only (the clock is the host's: the
          // expired case is only decided in-process)
          if (!r.now) {
            const ag = asUid(AGENT, dir, ['hook', 'stop'], h.env, { stdin: JSON.stringify({ hook_event_name: 'Stop', cwd: dir }) });
            expect(ag.code, ag.out + ag.err).toBe(2);
            expect(ag.err).toMatch(new RegExp(`run ${r.runId}`));
          }
        });
      }
    });

    it('a supervisor that died right after registering leaves a run that blocks (no work recorded); only the operator abandons it, recorded on both', async () => {
      const h = hardenedHost();
      const dir = await businessCase(h.env);
      const cd = caseDirOf(h.state, dir);
      const reg = new RunRegistry(join(cd, 'runs'), { caseId: caseIdOf(dir) });
      reg.begin('r_lost1', 'fix-failing-test', { resume: false });
      const r = await stop(dir, { hardened: h.env });
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/run r_lost1 .*according to the run registry \(registered, no work recorded yet/);
      // it cannot be resumed (the ledger knows no adopted goal for it) and the registry is not touched
      expect((await cli(dir, ['run', '--resume', 'r_lost1'], { wire: fakeWire().wire, env: KEYS, hardened: h.env })).code).toBe(1);
      expect(registryEntry(h.state, dir, 'r_lost1').state).toBe('registered');
      const ab = await cli(dir, ['hardened', 'abandon', 'r_lost1', '--reason', 'supervisor lost before any work', '--as', 'alice'], { hardened: h.env });
      expect(ab.code, ab.err).toBe(0);
      expect(registryEntry(h.state, dir, 'r_lost1')).toMatchObject({ state: 'terminal', terminalReason: 'abandoned by the operator: supervisor lost before any work' });
      const ended = (await readEvents(join(cd, 'ledger.sqlite'), cd)).find((e) => e.kind === 'run.ended' && e.runId === 'r_lost1')!;
      expect(ended.actor).toEqual({ kind: 'human', id: 'alice' });
      expect(ended.payload).toMatchObject({ exitCode: 9, abandoned: true, os: { uid: 0, boundary: 'operator-uid' } });
      expect((await stop(dir, { hardened: h.env })).code).toBe(0);
    });

    it('a missed heartbeat reads as interrupted, never finished', async () => {
      const h = hardenedHost();
      const dir = await businessCase(h.env);
      const { runId } = await heldRun(dir, h.env);
      const cd = caseDirOf(h.state, dir);
      const entry = registryEntry(h.state, dir, runId);
      writeFileSync(join(cd, 'runs', `${runId}.json`), JSON.stringify({ ...entry, state: 'running', heartbeatAt: Date.now() - 10 * 60_000 }));
      chmodSync(join(cd, 'runs', `${runId}.json`), 0o644);
      const r = await stop(dir, { hardened: h.env });
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/heartbeat missed for \d+s: interrupted or unknown, never finished/);
    });

    it('a deleted, moved or replaced ledger with a registered run blocks; so does an open run of another business case, and one whose tecera.json was removed', async () => {
      const h = hardenedHost();
      const dir = await businessCase(h.env);
      const { runId } = await heldRun(dir, h.env);
      const cd = caseDirOf(h.state, dir);
      // moved away (its checkpoint stays)
      renameSync(join(cd, 'ledger.sqlite'), join(h.base, 'moved.sqlite'));
      let r = await stop(dir, { hardened: h.env });
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/exists but its ledger .* does not \(deleted or moved\)/);
      // replaced by another, internally valid ledger
      const fresh = join(h.base, 'fresh.sqlite');
      const fl = new SqliteLedger(fresh, { journalMode: 'delete' });
      await fl.append(event('belief.added', { id: 'x', at: 1, actor: { kind: 'system', id: 't' }, trace: {}, payload: { key: 'k', value: 1 } }));
      fl.close();
      copyFileSync(fresh, join(cd, 'ledger.sqlite'));
      chmodSync(join(cd, 'ledger.sqlite'), 0o644);
      r = await stop(dir, { hardened: h.env });
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/ledger head checkpoint: .*(not the enrolled ledger|no ledger id)/);
      // ledger and checkpoint both gone: the registry entry still blocks
      rmSync(join(cd, 'ledger.sqlite'));
      rmSync(join(cd, 'head.json'));
      r = await stop(dir, { hardened: h.env });
      expect(r.code).toBe(2);
      expect(r.err).toMatch(new RegExp(`registry holds run ${runId} \\(held\\) open but this business case has no ledger`));
      // from another business case on the host, and from a directory that is not one
      const elsewhere = await businessCase(h.env);
      r = await stop(elsewhere, { hardened: h.env });
      expect(r.code).toBe(2);
      expect(r.err).toMatch(new RegExp(`run ${runId} \\(held\\) of the business case at ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      rmSync(join(dir, 'tecera.json'));
      r = await stop(dir, { hardened: h.env });
      expect(r.code).toBe(2);
      // single-user mode, by contrast: no tecera.json, no business case, nothing to protect
      const su = await businessCase(null);
      await heldRun(su, null);
      rmSync(join(su, 'tecera.json'));
      expect((await stop(su)).code).toBe(0);
    });

    it('a truncated ledger tail blocks the Stop hook (the chain alone would allow)', async () => {
      const h = hardenedHost();
      const dir = await businessCase(h.env);
      const w = fakeWire();
      const { runId, requestId } = await heldRun(dir, h.env, w);
      await cli(dir, ['approve', requestId, '--as', 'alice'], { hardened: h.env });
      expect((await cli(dir, ['run', '--resume', runId], { wire: w.wire, env: KEYS, hardened: h.env })).code).toBe(0);
      const cd = caseDirOf(h.state, dir);
      expect((await stop(dir, { hardened: h.env })).code).toBe(0);
      const { DatabaseSync } = await import('node:sqlite');
      const d = new DatabaseSync(join(cd, 'ledger.sqlite'));
      d.exec('DROP TRIGGER events_no_delete; DELETE FROM events WHERE seq = (SELECT MAX(seq) FROM events)');
      d.close();
      const plain = new SqliteLedger(join(cd, 'ledger.sqlite'), { readonly: true });
      expect((await plain.verifyChain()).ok).toBe(true);
      plain.close();
      const r = await stop(dir, { hardened: h.env });
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/ledger head checkpoint: .*acknowledged event\(s\) are missing/);
    });
  });

  describe('enrollment, status, doctor, init', () => {
    it('a single-user ledger is imported once as a legacy baseline, with its open runs entered in the registry', async () => {
      const su = await businessCase(null);
      const { runId } = await heldRun(su, null);
      const h = hardenedHost();
      const r = await cli(su, ['hardened', 'enroll', '--import', '.tecera/ledger.sqlite'], { hardened: h.env });
      expect(r.code, r.err + r.out).toBe(0);
      expect(r.out).toMatch(/legacy: its history before now is accepted as it is, not authenticated/);
      expect(r.out).toMatch(/1 open run\(s\) entered from the ledger/);
      expect(registryEntry(h.state, su, runId)).toMatchObject({ state: 'held', source: 'enrolled' });
      expect((await stop(su, { hardened: h.env })).code).toBe(2);
      const again = await cli(su, ['hardened', 'enroll'], { hardened: h.env });
      expect(again.code).toBe(1);
      expect(again.err).toMatch(/enrolled already/);
      const st = await cli(su, ['hardened', 'status', '--json'], { hardened: h.env });
      expect(st.code).toBe(0);
      expect(JSON.parse(st.out)).toMatchObject({ mode: 'hardened', head: { baseline: 'legacy' } });
    });

    it('doctor reports the preconditions (probing as the agent uid); a single-user host gets one note; init prints commands and changes nothing', async () => {
      const h = hardenedHost();
      const dir = await businessCase(h.env);
      const d = await cli(dir, ['doctor', '--skip-live', '--json'], { hardened: h.env, env: KEYS });
      const checks = (JSON.parse(d.out) as { checks: Array<{ name: string; status: string; detail: string }> }).checks;
      const by = (n: string) => checks.find((c) => c.name === n);
      expect(by('hardened')?.status).toBe('ok');
      expect(by('hardened:state')?.status).toBe('ok');
      expect(by(`hardened:probe:${AGENT}`)).toMatchObject({ status: 'ok', detail: expect.stringMatching(/cannot create a file/) });
      expect(by('hardened:placement')?.status).toBe('ok');
      expect(by('hardened:identity')?.detail).toMatch(/the operator/);
      chmodSync(h.state, 0o777);
      const bad = await cli(dir, ['doctor', '--skip-live', '--json'], { hardened: h.env, env: KEYS });
      expect(bad.code).toBe(3);
      chmodSync(h.state, 0o755);
      const su = await businessCase(null);
      const sd = JSON.parse((await cli(su, ['doctor', '--skip-live', '--json'], { env: KEYS })).out) as { checks: Array<{ name: string; status: string }> };
      expect(sd.checks.filter((c) => c.name.startsWith('hardened'))).toEqual([expect.objectContaining({ name: 'hardened', status: 'note' })]);
      const before = readdirSync(h.state);
      const init = await cli(dir, ['hardened', 'init', '--agent', 'tecera-agent', '--state', '/var/lib/tecera'], {});
      expect(init.code).toBe(0);
      expect(init.out).toMatch(/useradd --create-home --shell \/bin\/bash tecera-agent/);
      expect(init.out).toMatch(/install -d -o \S+ -g \S+ -m 0755 \/var\/lib\/tecera/);
      expect(init.out).toMatch(/cat > \/etc\/tecera\/hardened\.json <<EOF/);
      expect(readdirSync(h.state)).toEqual(before);
      expect(existsSync('/etc/tecera/hardened.json')).toBe(false);
    });
  });
});
