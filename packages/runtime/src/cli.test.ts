import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AchievementGoal, BeliefProjection, GateContext, GateRunner, Json, Ledger, Outcome, Plan, Planner, TeceraEvent, VerifyOutcome, VerifyRequest, VerifyRunner, Worker, WorkerStepRequest } from '@tecera/contracts';
import { event } from '@tecera/contracts';
import { Brain } from '@tecera/brain';
import { SqliteLedger } from '@tecera/ledger';
import { BLOCK_END, BLOCK_START } from './adapters/merge.js';
import { main, type MainOptions } from './cli/main.js';
import { resolveAssetsRoot } from './commands/init.js';
import { scriptedFetch } from './scripted.js';
import { createProbe, type WireFn, type WiringContext } from './wiring.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const SAMPLE = join(REPO, 'samples/fix-failing-test');

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'tecera-rt-'));
  temps.push(d);
  return d;
}

/** A temp copy of samples/fix-failing-test (no ledger, no runs). */
function sampleCopy(): string {
  const d = tmp();
  cpSync(SAMPLE, d, { recursive: true, filter: (src) => !/node_modules|ledger\.sqlite|[\\/]runs([\\/]|$)/.test(src) });
  return d;
}

/**
 * This host runs the tests as root: the contained verify runner (preflight, gate, run) refuses a root
 * identity unless the operator explicitly accepts a degraded root verify. The suite sets that switch, as an
 * operator would; the refusal itself is tested with it cleared.
 */
const HOST = typeof process.getuid === 'function' && process.getuid() === 0 ? { TECERA_VERIFY_ALLOW_ROOT: '1' } : {};
const ENV = { PATH: process.env.PATH, HOME: process.env.HOME, USER: 'tester', ...HOST };
/** Provider credentials for runs (resolved into the SecretStore and deleted from the env copy each call). */
const KEYS = { ANTHROPIC_API_KEY: 'test-anthropic-credential-0123456789', OPENAI_API_KEY: 'test-openai-credential-9876543210', OPENROUTER_API_KEY: 'test-openrouter-credential-5555555555' };
/** Approvals need no switch and no token (D1): the local principal (`--as`, default $USER) decides. */
const LOCAL = KEYS;

function gitRepo(dir: string): void {
  const g = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args], { env: { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null' } });
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
}

let idn = 0;
async function cli(cwd: string, argv: string[], opts: MainOptions = {}): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const { env: extraEnv, ...rest } = opts;
  const code = await main(argv, {
    cwd,
    env: { ...ENV, ...(extraEnv ?? {}) },
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    isTTY: false,
    ids: (p) => `${p}_t${++idn}`,
    ...rest,
  });
  return { code, out, err };
}

async function events(dir: string): Promise<TeceraEvent[]> {
  const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
  const out: TeceraEvent[] = [];
  for await (const e of l.events()) out.push(e);
  l.close();
  return out;
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name);
      if (n.isDirectory()) walk(p);
      else out[p.slice(dir.length + 1)] = readFileSync(p).toString('base64');
    }
  };
  walk(dir);
  return out;
}

class FakeVerify implements VerifyRunner {
  calls: VerifyRequest[] = [];
  constructor(public codes: number[] = [1]) {}
  async run(req: VerifyRequest): Promise<VerifyOutcome> {
    this.calls.push(req);
    const exitCode = this.codes.length > 1 ? this.codes.shift()! : this.codes[0]!;
    return { exitCode, signal: null, timedOut: false, stdout: exitCode ? 'not ok 2 - collapses repeated separators' : 'ok', stderr: '', durationMs: 5, truncated: false };
  }
}

// ---------- loop fakes (modelled on packages/loop/src/loop.test.ts) ----------

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
  permissions: { tools: ['read', 'edit', 'runVerify'], write: ['src/**'], approvals: ['open_pr'] },
  budget: {},
  origin: 'generated',
  status: 'candidate',
  goalKinds: ['fix-failing-test'],
});

class FakePlanner implements Planner {
  writes = 0;
  async write(_e: TeceraEvent, _b: BeliefProjection, _g: AchievementGoal): Promise<Plan> {
    this.writes++;
    return fixPlan();
  }
  async deliberate(options: Plan[]): Promise<Plan> {
    return options[0]!;
  }
}

class FakeWorker implements Worker {
  calls: WorkerStepRequest[] = [];
  async run(req: WorkerStepRequest): Promise<Outcome> {
    this.calls.push(req);
    const facts: Array<{ key: string; value: Json }> = req.step.id === 'analyze' ? [{ key: 'root.cause', value: 'separators not collapsed' }] : [];
    return { kind: 'returned', value: { facts }, run: { runId: req.runId, invokeId: `inv_${req.step.id}`, depth: 0 } };
  }
  async resume(): Promise<Outcome> {
    throw new Error('not used');
  }
}

class FakeGates implements GateRunner {
  log: string[] = [];
  ctxs: GateContext[] = [];
  ledger: Ledger | null = null;
  private async ev(key: string, kind: string, runId: string, body: Record<string, Json> = {}): Promise<string> {
    await this.ledger?.evidence({ key, kind, runId, body: { fake: true, ...body } });
    return key;
  }
  async verify(ctx: GateContext) {
    this.log.push('verify');
    this.ctxs.push(ctx);
    return { exitCode: 0, evidenceKey: await this.ev(`verify-${ctx.runId}-${this.log.length}`, 'gate.verify', ctx.runId, { exitCode: 0, outcome: 'passed', fingerprint: 'd1-fake', command: ctx.goal.check.command }), fingerprint: 'd1-fake' };
  }
  async review(ctx: GateContext) {
    this.log.push('review');
    this.ctxs.push(ctx);
    return { verdict: 'approve' as const, evidenceKey: await this.ev(`review-${ctx.runId}`, 'review', ctx.runId), fingerprint: 'd1-fake' };
  }
  /** D6: the commit goes to the work branch without approval (a commit handed an approval is a bug). */
  async commit(ctx: GateContext) {
    this.log.push('commit');
    this.ctxs.push(ctx);
    if (ctx.approval) return { exitCode: 8, evidenceKey: await this.ev(`commit-${ctx.runId}-approval`, 'commit', ctx.runId), terminal: true, reason: 'a commit needs no approval' };
    return { exitCode: 0, sha: 'abc123', evidenceKey: await this.ev(`commit-${ctx.runId}`, 'commit', ctx.runId) };
  }
  /** The PR gate owns consumption of the grant bound to the committed sha (contracts prActionHash). */
  async pr(ctx: GateContext) {
    this.log.push('pr');
    this.ctxs.push(ctx);
    const sha = ctx.commit?.sha ?? '';
    if (!ctx.approval || !sha) return { exitCode: 8, sha, evidenceKey: await this.ev(`pr-${ctx.runId}-refused`, 'gate.pr', ctx.runId), terminal: true, reason: 'no approval or no commit' };
    await this.ledger!.consume(ctx.approval.requestId, ctx.approval.actionHash, ctx.approval.sessionId, `pr:${ctx.approval.requestId}`, Date.now());
    return { exitCode: 0, sha, branch: 'tecera/fix-failing-test', base: 'main', bundle: `.tecera/runs/${ctx.runId}/pr/0001.patch`, evidenceKey: await this.ev(`pr-${ctx.runId}`, 'gate.pr', ctx.runId) };
  }
}

function fakeWire(): { wire: WireFn; planner: FakePlanner; worker: FakeWorker; gates: FakeGates; calls: number; ctx: WiringContext | null } {
  const planner = new FakePlanner();
  const worker = new FakeWorker();
  const gates = new FakeGates();
  const box = {
    planner,
    worker,
    gates,
    calls: 0,
    ctx: null as WiringContext | null,
    wire: (async (ctx) => {
      box.calls++;
      box.ctx = ctx;
      expect(ctx.sessionId).toBe(ctx.runId);
      gates.ledger = ctx.ledger;
      // fake ports own no processes: the restart's reap finds nothing to kill (a real wiring kills and proves)
      return { planner, worker, gates, seats: [{ seatId: 'worker', costPerMTok: 1 }], worktree: ctx.root, reapPrior: async () => ({ killed: [], survivors: [] }) };
    }) as WireFn,
  };
  return box;
}

/** Sample copy, init'd, committed. */
async function initialised(): Promise<string> {
  const dir = sampleCopy();
  const r = await cli(dir, ['init']);
  expect(r.code, r.err).toBe(0);
  gitRepo(dir);
  return dir;
}

/** The newest approval.requested whose request was neither granted, denied, expired nor consumed. */
function pendingRequest(evs: TeceraEvent[]): TeceraEvent | undefined {
  const closed = new Set(evs.filter((e) => ['approval.granted', 'approval.denied', 'approval.expired', 'approval.consumed'].includes(e.kind)).map((e) => (e.payload as { requestId?: string }).requestId));
  return [...evs].reverse().find((e) => e.kind === 'approval.requested' && !closed.has((e.payload as { requestId: string }).requestId));
}

/**
 * D6: under node isolation (the sample) writes proceed: the worker steps, both verifies, the review and the
 * commit to the work branch run without any approval; the run holds only at the PR (exit 4).
 */
async function heldRun(dir: string, w = fakeWire(), opts: { wire?: WireFn; verifyRunner?: VerifyRunner; env?: Record<string, string> } = {}): Promise<{ runId: string; requestId: string; evs: TeceraEvent[] }> {
  const r = await cli(dir, ['run', 'fix-failing-test'], { wire: opts.wire ?? w.wire, verifyRunner: opts.verifyRunner ?? new FakeVerify([1]), env: opts.env ?? KEYS });
  expect(r.code, r.err + r.out).toBe(4);
  expect(w.planner.writes).toBe(1);
  expect(w.worker.calls.map((c) => c.step.id)).toEqual(['analyze', 'edit']);
  expect(w.gates.log).toEqual(['verify', 'review', 'verify', 'commit']);
  const evs = await events(dir);
  const held = pendingRequest(evs)!;
  expect(held, evs.map((e) => e.kind).join(' ')).toBeTruthy();
  expect(held.trace.stepId).toBe('pr');
  expect(held.payload).toMatchObject({ owner: 'gate', sha: 'abc123' });
  // nothing held before the PR: the only approval requested is the PR's
  expect(evs.filter((e) => e.kind === 'approval.requested')).toHaveLength(1);
  return { runId: held.runId!, requestId: (held.payload as { requestId: string }).requestId, evs };
}

/** heldRun, then approve the PR and resume: the PR is requested, the goal achieved with its proof, the plan staged. */
async function achievedRun(dir: string, w = fakeWire()): Promise<{ runId: string; evs: TeceraEvent[] }> {
  const { runId, requestId } = await heldRun(dir, w);
  expect((await cli(dir, ['approve', requestId, '--as', 'bob'], { env: LOCAL })).code).toBe(0);
  const r = await cli(dir, ['run', '--resume', runId], { wire: w.wire, env: KEYS });
  expect(r.code, r.err + r.out).toBe(0);
  return { runId, evs: await events(dir) };
}

// ---------- init ----------

describe('init', () => {
  it('writes the expected files, keeps an existing manifest, and is idempotent', async () => {
    const dir = sampleCopy();
    writeFileSync(join(dir, 'CLAUDE.md'), '# House rules\n\nBe kind.\n');
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify({ model: 'opus', permissions: { deny: ['Bash(rm -rf:*)'] } }));
    const manifestBefore = readFileSync(join(dir, 'tecera.json'), 'utf8');

    const r1 = await cli(dir, ['init']);
    expect(r1.code, r1.err).toBe(0);
    expect(r1.out).toContain('tests      `npm test` (package.json scripts.test)');
    expect(r1.out).toMatch(/not a git repository/);
    for (const f of ['tecera.json', '.tecera/tecera.lock', '.tecera/protocols/permissions.json', '.tecera/skills/_index.md', '.tecera/goals/fix-failing-test.goal.md', 'CLAUDE.md', 'AGENTS.md', '.claude/settings.json', '.gitignore', '.tecera/ledger.sqlite']) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    expect(readFileSync(join(dir, 'tecera.json'), 'utf8')).toBe(manifestBefore);

    const claude = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(claude.startsWith('# House rules\n\nBe kind.')).toBe(true);
    expect(claude.split(BLOCK_START)).toHaveLength(2);
    expect(claude).toContain(BLOCK_END);
    expect(claude).toContain(`Done means \`${JSON.parse(manifestBefore).verify.command}\` exits 0`);
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('call `tecera gate <goal>` yourself');

    const settings = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'));
    expect(settings.model).toBe('opus');
    expect(settings.permissions.deny).toContain('Bash(rm -rf:*)');
    expect(settings.permissions.deny).toContain('Edit(**/*.test.*)');
    expect(settings.permissions.deny).toContain('Bash(git push:*)'); // D6: only the PR gate pushes
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(['Bash(gh pr create:*)', 'Bash(git merge:*)', 'Bash(gh pr merge:*)']));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('tecera hook pre-tool');
    expect(settings.hooks.Stop[0].hooks[0].command).toBe('tecera hook stop');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.tecera/ledger.sqlite*');

    const first = snapshot(dir);
    const r2 = await cli(dir, ['init']);
    expect(r2.code, r2.err).toBe(0);
    expect(r2.out).toContain('nothing (already initialised)');
    const second = snapshot(dir);
    for (const f of ['CLAUDE.md', 'AGENTS.md', '.claude/settings.json', '.gitignore', 'tecera.json', '.tecera/tecera.lock']) expect(second[f], f).toBe(first[f]);
    const created = (await events(dir)).filter((e) => e.kind === 'manifest.created');
    expect(created).toHaveLength(1);
  });

  it('fills a fresh manifest from the template in an empty directory', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-app', scripts: { test: 'vitest run' } }));
    writeFileSync(join(dir, 'yarn.lock'), '');
    const r = await cli(dir, ['init', '--interactive']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('wizard lands in Phase 2');
    const m = JSON.parse(readFileSync(join(dir, 'tecera.json'), 'utf8'));
    expect(m.id).toMatch(/^bc_[0-9a-f]{8}$/);
    expect(m.name).toBe('my-app');
    expect(m.verify.command).toBe('yarn test');
    expect(m.repo.allowedChanges).toEqual(['src/**']);
    expect(typeof m.owner).toBe('string');
    expect((await cli(dir, ['validate'])).code).toBe(0);
  });

  it('--sample copies the sample first; --dry-run prints the plan and writes nothing', async () => {
    const dir = tmp();
    const before = snapshot(dir);
    const r = await cli(dir, ['init', '--sample', '--dry-run']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/would write \d+ file\(s\)/);
    expect(r.out).toContain('src/slugify.js');
    expect(r.out).toContain('CLAUDE.md');
    expect(r.out).toContain('manifest.created');
    expect(snapshot(dir)).toEqual(before);
    expect(readdirSync(dir)).toEqual([]);

    const real = await cli(dir, ['init', '--sample']);
    expect(real.code, real.err).toBe(0);
    expect(existsSync(join(dir, 'test/slugify.test.js'))).toBe(true);
    expect(existsSync(join(dir, '.tecera/goals/fix-failing-test.goal.md'))).toBe(true);
  });
});

// ---------- validate ----------

describe('validate', () => {
  it('passes on an initialised sample', async () => {
    const dir = sampleCopy();
    await cli(dir, ['init']);
    const r = await cli(dir, ['validate']);
    expect(r.code, r.out).toBe(0);
  });

  it('exit 2 on an inline sk-ant- key, without printing it', async () => {
    const dir = sampleCopy();
    await cli(dir, ['init']);
    const key = 'sk-ant-api03-' + 'A'.repeat(24);
    writeFileSync(join(dir, '.tecera/memory/working/WORKSPACE.md'), `# Workspace\nkey: ${key}\n`);
    const r = await cli(dir, ['validate', '--json']);
    expect(r.code).toBe(2);
    expect(r.out + r.err).not.toContain(key);
    const j = JSON.parse(r.out);
    expect(j.issues.some((i: { where: string; message: string }) => i.where === '.tecera/memory/working/WORKSPACE.md:2' && /anthropic/.test(i.message))).toBe(true);

    const m = JSON.parse(readFileSync(join(dir, 'tecera.json'), 'utf8'));
    m.providers.openrouter.auth = key;
    writeFileSync(join(dir, 'tecera.json'), JSON.stringify(m));
    const r2 = await cli(dir, ['validate']);
    expect(r2.code).toBe(2);
    expect(r2.out + r2.err).not.toContain(key);
  });

  it('exit 2 on unknown fields and lock drift', async () => {
    const dir = sampleCopy();
    await cli(dir, ['init']);
    const m = JSON.parse(readFileSync(join(dir, 'tecera.json'), 'utf8'));
    m.surprise = true;
    writeFileSync(join(dir, 'tecera.json'), JSON.stringify(m));
    const r = await cli(dir, ['validate']);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/Unrecognized key/);

    delete m.surprise;
    m.budgets.usd = 1;
    writeFileSync(join(dir, 'tecera.json'), JSON.stringify(m));
    const r2 = await cli(dir, ['validate']);
    expect(r2.code).toBe(2);
    expect(r2.out).toMatch(/drift: tecera.json changed since lock/);
  });

  it('exit 2 when no manifest exists', async () => {
    expect((await cli(tmp(), ['validate'])).code).toBe(2);
  });
});

// ---------- doctor ----------

describe('doctor', () => {
  it('--skip-live exits 0 and appends doctor.ran', async () => {
    const dir = await initialised();
    const r = await cli(dir, ['doctor', '--skip-live']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('live probes skipped');
    expect(r.out).toMatch(/isolation "node" is degraded/);
    const ran = (await events(dir)).filter((e) => e.kind === 'doctor.ran');
    expect(ran).toHaveLength(1);
    expect((ran[0]!.payload as { missing: number }).missing).toBe(0);
  });

  it('live probes run last and only when ready (missing keys → not run, exit 3); an injected probe prints cost and never sees a key value', async () => {
    const dir = await initialised();
    const calls: string[] = [];
    const r = await cli(dir, ['doctor'], { probe: async (seat) => (calls.push(seat.id), { ok: true, latencyMs: 1, usd: 0 }) });
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/live probes not run: not ready \(providers\)/);
    expect(calls).toEqual([]);

    const seen: string[] = [];
    const env = { ...ENV, OPENROUTER_API_KEY: 'sk-or-v1-' + 'k'.repeat(30), OPENAI_API_KEY: 'sk-' + 'o'.repeat(30) };
    const ok = await cli(dir, ['doctor'], { env, probe: async (seat) => (seen.push(`${seat.role}:${seat.provider}`), { ok: true, latencyMs: 12, usd: 0.0004 }) });
    expect(ok.code, ok.out).toBe(0);
    expect(seen).toEqual(['planner:openrouter', 'worker:openrouter', 'reviewer:openai']);
    expect(ok.out).toContain('$0.0004');
    expect(ok.out).toContain('OPENROUTER_API_KEY set');
    expect(ok.out).toMatch(/reviewer\s+openai\/gpt-5\.6-terra · foreign \(vendor openai/);
    expect(ok.out).toMatch(/budgets\s+not enforced \(budgets\.enforce false\)/);
    expect(ok.out).toMatch(/policy\s+approvals: open_pr — the PR gate holds/);
    expect(ok.out).not.toContain('kkkkkkkk');
  });

  it('lock drift is missing until --fix re-pins it', async () => {
    const dir = await initialised();
    writeFileSync(join(dir, '.tecera/skills/_index.md'), '# Skills\nchanged\n');
    expect((await cli(dir, ['doctor', '--skip-live'])).code).toBe(3);
    const fixed = await cli(dir, ['doctor', '--skip-live', '--fix']);
    expect(fixed.out).toMatch(/re-pinned/);
    expect((await cli(dir, ['validate'])).code).toBe(0);
  });
});

// ---------- preflight ----------

describe('preflight', () => {
  it('records preflight.ran with the sample baseline failing (real, contained verify run on the unmodified sample)', async () => {
    // The shipped sample's check is `node --test` (never npm on this host); nothing in the copy is rewritten.
    const dir = sampleCopy();
    const goalPath = join(dir, '.tecera/goals/fix-failing-test.goal.md');
    expect(readFileSync(goalPath, 'utf8')).toMatch(/^verify: node --test$/m);
    expect((await cli(dir, ['init'])).code).toBe(0);
    gitRepo(dir);
    const r = await cli(dir, ['preflight', 'fix-failing-test', '--skip-live']);
    expect(r.out).toMatch(/`node --test` → exit 1 \(failing, as expected/);
    expect(r.code, r.out).toBe(0);
    const evs = await events(dir);
    const pf = evs.find((e) => e.kind === 'preflight.ran')!;
    expect(pf.trace.goalId).toBe('g_fix-failing-test');
    expect((pf.payload as { baseline: { state: string; exitCode: number } }).baseline).toMatchObject({ state: 'failing', exitCode: 1 });
    const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
    const ev = await l.getEvidence((pf.payload as { evidenceKey: string }).evidenceKey);
    l.close();
    expect(ev?.kind).toBe('verify.baseline');
  }, 60_000);

  it.skipIf(!(typeof process.getuid === 'function' && process.getuid() === 0))('preflight and gate run repository code ONLY through the contained runner: as root without an operator identity the check never runs (preflight baseline missing → 3, gate → 3); no host-shell fallback', async () => {
    const dir = sampleCopy();
    expect((await cli(dir, ['init'])).code).toBe(0);
    gitRepo(dir);
    // the check would leave a marker if it ran at all
    const marker = join(dir, 'ran-marker');
    const goalPath = join(dir, '.tecera/goals/fix-failing-test.goal.md');
    const noRoot = { TECERA_VERIFY_ALLOW_ROOT: '' };
    writeFileSync(join(dir, 'test/zz-marker.test.js'), `import { test } from 'node:test';\nimport { writeFileSync } from 'node:fs';\ntest('m', () => writeFileSync(${JSON.stringify(marker)}, 'ran'));\n`);
    gitRepo(dir);
    const pf = await cli(dir, ['preflight', 'fix-failing-test', '--skip-live'], { env: noRoot });
    expect(pf.code, pf.out).toBe(3);
    expect(pf.out).toMatch(/baseline\s+not run: verify containment unavailable/);
    expect(pf.out).toMatch(/TECERA_VERIFY_ALLOW_ROOT=1/);
    const gate = await cli(dir, ['gate', 'fix-failing-test'], { env: noRoot });
    expect(gate.code, gate.err).toBe(3);
    expect(gate.err).toMatch(/verify containment unavailable/);
    expect(existsSync(marker), 'the repository check never ran uncontained').toBe(false);
    expect((await events(dir)).some((e) => e.kind === 'gate.ran' || e.kind === 'goal.demoted')).toBe(false);
    expect(readFileSync(goalPath, 'utf8')).toMatch(/^verify: node --test$/m);
    // with the operator's explicit (recorded) degraded-root switch the same contained runner runs it
    const ok = await cli(dir, ['gate', 'fix-failing-test']);
    expect(ok.code).toBe(5); // the sample's failing test: demoted, but it ran (contained)
    expect(existsSync(marker)).toBe(true);
  }, 120_000);

  it('dirty worktree and unknown goal are missing → exit 3', async () => {
    const dir = await initialised();
    writeFileSync(join(dir, 'src/extra.js'), 'export {};\n');
    const r = await cli(dir, ['preflight', 'fix-failing-test', '--skip-live'], { verifyRunner: new FakeVerify([1]) });
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/dirty: src\/extra.js/);
    const r2 = await cli(dir, ['preflight', 'nope', '--skip-live'], { verifyRunner: new FakeVerify([1]) });
    expect(r2.code).toBe(3);
    expect(r2.out).toMatch(/goal nope not found/);
  });
});

// ---------- run ----------

describe('run', () => {
  it('--dry-run prints goal, budget, seats and plan match without model calls or ledger writes', async () => {
    const dir = await initialised();
    const w = fakeWire();
    const before = (await events(dir)).length;
    const r = await cli(dir, ['run', 'fix-failing-test', '--dry-run', '--budget-usd', '1.5'], { wire: w.wire, probe: async () => { throw new Error('no model calls'); } });
    expect(r.code, r.err).toBe(0);
    expect(w.calls).toBe(0);
    expect(r.out).toContain('goal       g_fix-failing-test');
    expect(r.out).toContain('budget     $1.5');
    expect(r.out).toContain('planner openrouter/anthropic/claude-sonnet-4.5');
    expect(r.out).toContain('reviewer openai/gpt-5.6-terra (foreign)');
    expect(r.out).toMatch(/match: none → the planner seat would write a plan/);
    expect((await events(dir)).length).toBe(before);
    const tooMuch = await cli(dir, ['run', 'fix-failing-test', '--dry-run', '--budget-usd', '50']);
    expect(tooMuch.code).toBe(7);
  });

  it('default wiring fails closed before anything runs: a missing scripted dir is exit 3 with no run events and no worktree', async () => {
    const dir = await initialised();
    const wt = tmp();
    const r = await cli(dir, ['run', 'make the failing test pass', '--scripted', join(dir, 'no-such-scripts')], { env: { ...KEYS, TECERA_WORKTREES: wt } });
    expect(r.code, r.err).toBe(3);
    expect(r.err).toMatch(/scripted: .* is not a directory/);
    expect((await events(dir)).some((e) => e.kind === 'run.started')).toBe(false);
    expect(readdirSync(wt)).toEqual([]);
  });

  it('with wired fakes the loop runs writes and the commit without approval and holds only at the PR (exit 4); status shows it', async () => {
    const dir = await initialised();
    const w = fakeWire();
    const { evs, requestId } = await heldRun(dir, w);
    const kinds = evs.map((e) => e.kind);
    for (const k of ['run.started', 'isolation.degraded', 'goal.adopted', 'plan.generated', 'intention.pushed', 'step.requested', 'verify.passed', 'review.passed', 'commit.recorded', 'approval.requested', 'step.held', 'decision.recorded', 'run.ended']) expect(kinds, k).toContain(k);
    expect(kinds).not.toContain('goal.achieved');
    // PLAN.md order: a plan is staged only after its goal was achieved (not while the run is held)
    expect(kinds).not.toContain('plan.staged');
    // D6: isolation 'node' is recorded, never a hold; the commit got no approval; the PR is held
    expect(evs.find((e) => e.kind === 'isolation.degraded')!.payload).toMatchObject({ isolation: 'node' });
    expect(w.gates.ctxs.find((c) => c.step.id === 'commit')!.approval).toBeUndefined();
    expect(kinds.indexOf('commit.recorded')).toBeLessThan(kinds.indexOf('approval.requested'));
    const ended = [...evs].reverse().find((e) => e.kind === 'run.ended')!;
    expect(ended.payload).toMatchObject({ exitCode: 4 });
    expect((ended.payload as { reason: string }).reason).toMatch(/held for PR approval/);
    const s = await cli(dir, ['status']);
    expect(s.code).toBe(0);
    expect(s.out).toContain(`held       ${requestId}  step pr`);
    expect(s.out).toMatch(/0 candidate\(s\) awaiting review/);
  });

  it('denying the PR fails it as policy (exit 8): nothing is pushed or requested, the goal is not achieved', async () => {
    const dir = await initialised();
    const w = fakeWire();
    const { runId, requestId } = await heldRun(dir, w);
    const d = await cli(dir, ['deny', requestId, '--as', 'carol', '--reason', 'not this change'], { env: LOCAL });
    expect(d.code, d.err).toBe(0);
    const resumed = await cli(dir, ['run', '--resume', runId], { wire: w.wire, env: KEYS });
    expect(resumed.code, resumed.err + resumed.out).toBe(8);
    expect(w.gates.log).not.toContain('pr');
    const kinds = (await events(dir)).map((e) => e.kind);
    expect(kinds).not.toContain('pr.opened');
    expect(kinds).not.toContain('pr.requested');
    expect(kinds).not.toContain('goal.achieved');
  });
});

// ---------- approve / deny ----------

describe('approve and deny', () => {
  it('round trip, and self-approval is a policy failure (exit 8)', async () => {
    const dir = await initialised();
    const { requestId, runId } = await heldRun(dir);

    const ok = await cli(dir, ['approve', requestId, '--as', 'bob', '--yes'], { env: LOCAL });
    expect(ok.code, ok.err).toBe(0);
    const again = await cli(dir, ['approve', requestId, '--as', 'bob'], { env: LOCAL });
    expect(again.code).toBe(1);
    let evs = await events(dir);
    const granted = evs.find((e) => e.kind === 'approval.granted' && (e.payload as { requestId: string }).requestId === requestId)!;
    expect(granted.actor).toEqual({ kind: 'human', id: 'bob' });
    expect(granted.trace.stepId).toBe('pr');
    expect((granted.payload as { identity: { authenticated: boolean; method: string } }).identity).toMatchObject({ kind: 'human', id: 'bob', method: 'local', source: 'as' });

    // seed two human-requested approvals on the same run
    const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
    const trace = granted.trace;
    for (const rid of ['ap_self', 'ap_deny']) {
      await l.requestApproval({ requestId: rid, runId, sessionId: runId, actionHash: 'h', requester: { kind: 'human', id: 'alice' }, reason: 'externalWrite', expiresAt: Date.now() + 60_000 });
      await l.append({ id: `ev_${rid}`, kind: 'approval.requested', at: Date.now(), actor: { kind: 'human', id: 'alice' }, runId, trace, payload: { requestId: rid } });
    }
    l.close();
    const self = await cli(dir, ['approve', 'ap_self', '--as', 'alice'], { env: LOCAL });
    expect(self.code).toBe(8);
    expect(self.err).toMatch(/requester cannot approve their own request/);

    expect((await cli(dir, ['deny', 'ap_deny', '--as', 'bob'], { env: LOCAL })).code).toBe(2);
    const denied = await cli(dir, ['deny', 'ap_deny', '--as', 'bob', '--reason', 'not now'], { env: LOCAL });
    expect(denied.code, denied.err).toBe(0);
    evs = await events(dir);
    expect(evs.some((e) => e.kind === 'approval.denied' && (e.payload as { requestId: string }).requestId === 'ap_deny')).toBe(true);
    expect((await cli(dir, ['approve', 'ap_unknown', '--as', 'bob'], { env: LOCAL })).code).toBe(1);
  });
});

// ---------- why / evidence ----------

describe('why and evidence', () => {
  it('why walks action → step → intention → goal → event', async () => {
    const dir = await initialised();
    const { evs } = await heldRun(dir);
    const verify = evs.find((e) => e.kind === 'verify.passed' && e.trace.stepId === 'verify2')!;
    const r = await cli(dir, ['why', verify.id]);
    expect(r.code, r.err).toBe(0);
    const lines = r.out.trim().split('\n');
    expect(lines[0]).toMatch(/^action\s+verify.passed/);
    expect(lines[1]).toMatch(/^step\s+verify2\s+step.requested → step.started → verify.started → verify.passed/);
    expect(lines[2]).toMatch(/^intention\s+\S+\s+intention.pushed/);
    expect(lines[3]).toMatch(/^plan\s+p_fix\s+plan.generated$/);
    expect(lines[4]).toMatch(/^goal\s+g_fix-failing-test\s+goal.adopted/);
    expect(lines[5]).toMatch(/^event\s+goal.adopted .*Make the failing test/);
    const j = JSON.parse((await cli(dir, ['why', verify.id, '--json'])).out);
    expect(j.origin.kind).toBe('goal.adopted');
    expect((await cli(dir, ['why', 'ev_missing'])).code).toBe(1);
  });

  it('evidence writes summary, events, decisions and evidence files, redacted', async () => {
    const dir = await initialised();
    const { runId } = await heldRun(dir);
    const r = await cli(dir, ['evidence', runId]);
    expect(r.code, r.err).toBe(0);
    const out = join(dir, '.tecera/runs', runId);
    for (const f of ['summary.md', 'events.jsonl', 'decisions.jsonl', 'index.json']) expect(existsSync(join(out, f)), f).toBe(true);
    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    expect(index.missing).toEqual([]);
    expect(Object.keys(index.evidence).length).toBeGreaterThanOrEqual(3);
    expect(readFileSync(join(out, 'summary.md'), 'utf8')).toMatch(/verify.passed · step verify1/);
    expect(readFileSync(join(out, 'decisions.jsonl'), 'utf8').trim().split('\n').length).toBeGreaterThan(3);
    expect((await events(dir)).some((e) => e.kind === 'evidence.exported')).toBe(true);
  });

  it('evidence export with a referenced record missing from the ledger writes what it has and exits 1', async () => {
    const dir = await initialised();
    const { runId } = await heldRun(dir);
    const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
    await l.append(event('evidence.appended', { id: 'ev_dangling', at: Date.now(), actor: { kind: 'system', id: 't' }, runId, trace: {}, payload: { kind: 'gate.verify', evidenceKey: 'verify:never-written' } }));
    l.close();
    const r = await cli(dir, ['evidence', runId]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/verify:never-written is not in the ledger/);
    expect(JSON.parse(readFileSync(join(dir, '.tecera/runs', runId, 'index.json'), 'utf8')).missing).toEqual(['verify:never-written']);
  });
});

describe('resume guards', () => {
  it('a pre-aborted resume does nothing (no wiring, no lease, no reap, no restore): exit 130, the ledger unchanged', async () => {
    const dir = await initialised();
    const w = fakeWire();
    const r = await cli(dir, ['run', 'fix-failing-test'], { wire: w.wire, verifyRunner: new FakeVerify([1]), env: KEYS });
    expect(r.code).toBe(4);
    const before = (await events(dir)).length;
    const runId = (await events(dir)).find((e) => e.kind === 'run.started')!.runId!;
    const ac = new AbortController();
    ac.abort(new Error('SIGINT'));
    const calls = w.calls;
    const res = await cli(dir, ['run', '--resume', runId], { wire: w.wire, env: KEYS, signal: ac.signal });
    expect(res.code).toBe(130);
    expect(w.calls).toBe(calls);
    expect((await events(dir)).length).toBe(before);
  });

  it('a wiring that cannot prove the previous supervisor\'s processes are gone (no reapPrior) refuses the resume before anything is restored (exit 9)', async () => {
    const dir = await initialised();
    const w = fakeWire();
    expect((await cli(dir, ['run', 'fix-failing-test'], { wire: w.wire, verifyRunner: new FakeVerify([1]), env: KEYS })).code).toBe(4);
    const runId = (await events(dir)).find((e) => e.kind === 'run.started')!.runId!;
    const noReap: WireFn = async (ctx) => {
      const p = await w.wire(ctx);
      delete (p as { reapPrior?: unknown }).reapPrior;
      return p;
    };
    const before = (await events(dir)).length;
    const res = await cli(dir, ['run', '--resume', runId], { wire: noReap, env: KEYS });
    expect(res.code, res.err + res.out).toBe(9);
    expect(res.out + res.err).toMatch(/cannot prove the previous supervisor's processes are gone/);
    const after = (await events(dir)).slice(before);
    expect(after.map((e) => e.kind)).toEqual(['run.ended']);
  });
});

// ---------- plans / memory ----------

describe('plans and memory', () => {
  it('a held run stages nothing; plans candidates (after goal.achieved) → graduate needs --rationale → accepted plan matches the next dry run', async () => {
    const dir = await initialised();
    const w = fakeWire();
    const { runId, requestId } = await heldRun(dir, w);
    expect((await cli(dir, ['plans', 'candidates'])).out).not.toMatch(/p_fix/);
    expect((await cli(dir, ['plans', 'graduate', 'p_fix', '--as', 'bob', '--rationale', 'too early'], { env: LOCAL })).code).not.toBe(0);
    expect((await cli(dir, ['approve', requestId, '--as', 'bob'], { env: LOCAL })).code).toBe(0);
    expect((await cli(dir, ['run', '--resume', runId], { wire: w.wire, env: KEYS })).code).toBe(0);
    const kinds = (await events(dir)).filter((e) => e.runId === runId).map((e) => e.kind);
    expect(kinds.indexOf('plan.staged')).toBeGreaterThan(kinds.indexOf('goal.achieved'));
    expect(kinds.indexOf('plan.staged')).toBeLessThan(kinds.lastIndexOf('run.ended'));
    const c = await cli(dir, ['plans', 'candidates']);
    expect(c.out).toMatch(/p_fix\s+analyze → edit → verify1 → review → verify2 → commit → pr/);
    expect((await cli(dir, ['plans', 'graduate', 'p_fix', '--as', 'bob'], { env: LOCAL })).code).toBe(2);
    // D1: no principal (no --as, no $USER) is a usage error; nothing is decided
    expect((await cli(dir, ['plans', 'graduate', 'p_fix', '--rationale', 'worked on the sample'], { env: { USER: '' } })).code).toBe(2);
    const g = await cli(dir, ['plans', 'graduate', 'p_fix', '--as', 'bob', '--rationale', 'worked on the sample'], { env: LOCAL });
    expect(g.code, g.err).toBe(0);
    expect(existsSync(join(dir, '.tecera/plans/p_fix.json'))).toBe(true);
    expect((await cli(dir, ['plans', 'graduate', 'p_fix', '--as', 'bob', '--rationale', 'again'], { env: LOCAL })).code).toBe(2);
    const dry = await cli(dir, ['run', 'fix-failing-test', '--dry-run']);
    expect(dry.out).toMatch(/1 accepted, 0 candidate\(s\) · match: p_fix/);
    expect((await cli(dir, ['plans', 'retract', 'p_fix', '--as', 'bob', '--rationale', 'flaky'], { env: LOCAL })).code).toBe(0);
    expect((await events(dir)).filter((e) => e.kind.startsWith('plan.')).map((e) => e.kind)).toEqual(['plan.generated', 'plan.staged', 'plan.graduated', 'plan.retracted']);
  });

  it('memory candidates → graduate with a human principal and a rationale', async () => {
    const dir = await initialised();
    const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
    const brain = await Brain.load(l, { runId: 'seed', budgetTokens: 1000, ids: () => `seed_${++idn}` });
    const lesson = await brain.stage({ content: 'read the failing assertion before the source', sourceEpisodes: ['e1'] });
    l.close();
    const c = await cli(dir, ['memory', 'candidates']);
    expect(c.out).toContain(lesson.id);
    expect((await cli(dir, ['memory', 'graduate', lesson.id], { env: LOCAL })).code).toBe(2);
    expect((await cli(dir, ['memory', 'graduate', lesson.id, '--rationale', 'held up twice'], { env: { USER: '' } })).code).toBe(2);
    const g = await cli(dir, ['memory', 'graduate', lesson.id, '--as', 'bob', '--rationale', 'held up twice'], { env: LOCAL });
    expect(g.code, g.err).toBe(0);
    expect(readFileSync(join(dir, '.tecera/memory/semantic/LESSONS.md'), 'utf8')).toContain('read the failing assertion');
    expect((await cli(dir, ['memory', 'graduate', lesson.id, '--as', 'bob', '--rationale', 'twice'], { env: LOCAL })).code).toBe(2);
    expect((await events(dir)).some((e) => e.kind === 'lesson.graduated' && e.actor.id === 'bob')).toBe(true);
  });
});

// ---------- hooks / adapters ----------

describe('host hooks', () => {
  const payload = (dir: string, tool: string, input: Record<string, unknown>) => JSON.stringify({ hook_event_name: 'PreToolUse', cwd: dir, tool_name: tool, tool_input: input });

  it('pre-tool blocks protected and out-of-bounds edits, allows src/, fails closed', async () => {
    const dir = await initialised();
    const blocked = await cli(dir, ['hook', 'pre-tool'], { stdin: payload(dir, 'Edit', { file_path: join(dir, 'test/slugify.test.js'), old_string: 'a', new_string: 'b' }) });
    expect(blocked.code).toBe(2);
    expect(blocked.err).toMatch(/test\/slugify.test.js is a protected path/);
    const allowed = await cli(dir, ['hook', 'pre-tool'], { stdin: payload(dir, 'Edit', { file_path: join(dir, 'src/slugify.js') }) });
    expect(allowed.code, allowed.err).toBe(0);
    expect((await cli(dir, ['hook', 'pre-tool'], { stdin: payload(dir, 'Write', { file_path: 'src/new.js' }) })).code).toBe(0);
    expect((await cli(dir, ['hook', 'pre-tool'], { stdin: payload(dir, 'Write', { file_path: 'README.md' }) })).err).toMatch(/outside repo.allowedChanges/);
    expect((await cli(dir, ['hook', 'pre-tool'], { stdin: payload(dir, 'Write', { file_path: '/etc/passwd' }) })).code).toBe(2);
    expect((await cli(dir, ['hook', 'pre-tool'], { stdin: payload(dir, 'Edit', { file_path: 'tecera.json' }) })).code).toBe(2);
    expect((await cli(dir, ['hook', 'pre-tool'], { stdin: payload(dir, 'Bash', { command: 'git push origin main' }) })).code).toBe(2);
    // the goal's own check command runs; npm (not the configured check, and never trusted on this host) does not
    expect((await cli(dir, ['hook', 'pre-tool'], { stdin: payload(dir, 'Bash', { command: 'node --test' }) })).code).toBe(0);
    expect((await cli(dir, ['hook', 'pre-tool'], { stdin: payload(dir, 'Bash', { command: 'npm test' }) })).code).toBe(2);
    expect((await cli(dir, ['hook', 'pre-tool'], { stdin: payload(dir, 'Read', { file_path: 'test/slugify.test.js' }) })).code).toBe(0);
    expect((await cli(dir, ['hook', 'pre-tool'], { stdin: 'not json' })).code).toBe(2);
    expect((await cli(dir, ['hook', 'pre-tool'], { stdin: payload(dir, 'Edit', {}) })).code).toBe(2);
    // no run yet: stopping is allowed, with the gate reminder
    const stop = await cli(dir, ['hook', 'stop'], { stdin: JSON.stringify({ cwd: dir, hook_event_name: 'Stop' }) });
    expect(stop.code, stop.err).toBe(0);
    expect(stop.out + stop.err).toContain('tecera gate fix-failing-test');
  });
});

describe('adapters', () => {
  it('install renders the CLAUDE.md block and the settings deny list; doctor reports staleness', async () => {
    const dir = sampleCopy();
    await cli(dir, ['init']);
    rmSync(join(dir, 'CLAUDE.md'));
    rmSync(join(dir, '.claude'), { recursive: true });
    expect((await cli(dir, ['adapters', 'doctor', 'claude-code'])).code).toBe(3);
    const r = await cli(dir, ['adapters', 'install', 'claude-code']);
    expect(r.code, r.err).toBe(0);
    const claude = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain(BLOCK_START);
    expect(claude).toContain('### Permissions');
    expect(claude).toContain('- git_push');
    expect(claude).toContain('- merge');
    expect(claude).toMatch(/hook stop` blocks stopping while a Tecera run is active without a goal.achieved proof/);
    expect(claude).toContain('Explanation style: concise');
    const settings = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'));
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(['Edit(tecera.json)', 'Edit(.tecera/**)', 'Edit(**/test/**)', 'Bash(git push:*)']));
    expect((await cli(dir, ['adapters', 'doctor', 'claude-code'])).code).toBe(0);
    writeFileSync(join(dir, '.tecera/memory/working/WORKSPACE.md'), '# Workspace\nnew focus\n');
    expect((await cli(dir, ['adapters', 'doctor', 'claude-code'])).code).toBe(3);
    expect((await cli(dir, ['adapters', 'install', 'nope'])).code).toBe(1);
  });
});

// ---------- gate / misc ----------

describe('gate, migrate, help', () => {
  it('gate passes with a passing check and demotes on failure', async () => {
    const dir = await initialised();
    expect((await cli(dir, ['gate', 'fix-failing-test'], { verifyRunner: new FakeVerify([0]) })).code).toBe(0);
    const fail = await cli(dir, ['gate', 'fix-failing-test'], { verifyRunner: new FakeVerify([1]) });
    expect(fail.code).toBe(5);
    const demoted = (await events(dir)).find((e) => e.kind === 'goal.demoted')!;
    expect(demoted.trace.goalId).toBe('g_fix-failing-test');
    expect((demoted.payload as { goal: { status: string } }).goal.status).toBe('demoted');
  });

  it('migrate exits 2; unknown command and flag exit 2; help and version exit 0', async () => {
    const dir = tmp();
    expect((await cli(dir, ['migrate'])).code).toBe(2);
    expect((await cli(dir, ['frobnicate'])).code).toBe(2);
    expect((await cli(dir, ['status', '--bogus'])).code).toBe(2);
    const h = await cli(dir, ['--help']);
    expect(h.code).toBe(0);
    expect(h.out).toContain('preflight <goal>');
    expect((await cli(dir, ['--version', '--json'])).out).toContain('"version":"0.1.0"');
    expect((await cli(dir, ['status'])).code).toBe(2);
  });
});

// =====================================================================================================
// Wave-1 repair: adversarial coverage (docs/security.md §6 names)
// =====================================================================================================

const CANARY = 'TECERA_CANARY_e2e_4b1d9c2a';

function rawLedger(dir: string): string {
  let s = '';
  for (const f of ['ledger.sqlite', 'ledger.sqlite-wal', 'ledger.sqlite-shm']) if (existsSync(join(dir, '.tecera', f))) s += readFileSync(join(dir, '.tecera', f)).toString('latin1');
  return s;
}

function filesUnder(dir: string): string {
  let s = '';
  const walk = (d: string): void => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name);
      if (n.isDirectory()) walk(p);
      else s += readFileSync(p).toString('latin1');
    }
  };
  walk(dir);
  return s;
}

describe('secret.canary_*: CLI output, adapter prompts, ledger rows, checkpoints and exported evidence', () => {
  it('CLI stdout/stderr (text and --json) never print a canary or a resolved credential', async () => {
    const dir = await initialised();
    const env = { ...KEYS, TECERA_CANARY_CLI: CANARY };
    const a = await cli(dir, ['run', `fix it ${CANARY} ${KEYS.ANTHROPIC_API_KEY}`, '--dry-run'], { env });
    expect(a.code, a.err).toBe(0);
    const b = await cli(dir, ['run', `fix it ${CANARY}`, '--dry-run', '--json'], { env });
    const c = await cli(dir, ['why', `${CANARY}${KEYS.OPENAI_API_KEY}`], { env });
    expect(c.code).toBe(1);
    const all = a.out + a.err + b.out + b.err + c.out + c.err;
    for (const leak of [CANARY, KEYS.ANTHROPIC_API_KEY, KEYS.OPENAI_API_KEY, Buffer.from(KEYS.ANTHROPIC_API_KEY).toString('base64')]) expect(all.includes(leak), leak).toBe(false);
    expect(all).toContain('[REDACTED:');
    expect(() => JSON.parse(b.out)).not.toThrow();
  });

  it('adapter install renders memory through the redactor (CLAUDE.md / AGENTS.md carry no secret)', async () => {
    const dir = await initialised();
    writeFileSync(join(dir, '.tecera/memory/working/WORKSPACE.md'), `# Workspace\ncanary ${CANARY}\nkey ${KEYS.ANTHROPIC_API_KEY}\nb64 ${Buffer.from(KEYS.ANTHROPIC_API_KEY).toString('base64')}\n`);
    for (const host of ['claude-code', 'codex']) {
      const r = await cli(dir, ['adapters', 'install', host], { env: KEYS });
      expect(r.code, r.err).toBe(0);
    }
    const text = readFileSync(join(dir, 'CLAUDE.md'), 'utf8') + readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(text).toContain('[REDACTED:');
    for (const leak of [CANARY, KEYS.ANTHROPIC_API_KEY, Buffer.from(KEYS.ANTHROPIC_API_KEY).toString('base64')]) expect(text.includes(leak), leak).toBe(false);
  });

  it('a worker and a gate that echo secrets (plain, base64, auth header) leave none in the ledger file or the evidence bundle', async () => {
    const dir = await initialised();
    const w = fakeWire();
    const leaky = `${CANARY} Authorization: Bearer ${KEYS.ANTHROPIC_API_KEY} ${Buffer.from(KEYS.OPENAI_API_KEY).toString('base64')}`;
    w.worker.run = async (req: WorkerStepRequest): Promise<Outcome> => ({ kind: 'returned', value: { facts: [{ key: 'leak', value: leaky }] }, run: { runId: req.runId, invokeId: `inv_${req.step.id}`, depth: 0 } });
    const origVerify = w.gates.verify.bind(w.gates);
    w.gates.verify = async (ctx: GateContext) => {
      const r = await origVerify(ctx);
      await w.gates.ledger!.evidence({ key: `${r.evidenceKey}:out`, kind: 'verify.output', runId: ctx.runId, body: { stdout: leaky } });
      await w.gates.ledger!.checkpoint(ctx.runId, 'cp', { history: [leaky] });
      return { ...r, evidenceKey: `${r.evidenceKey}:out` };
    };
    const env = { ...KEYS, TECERA_CANARY_RUN: CANARY };
    const r = await cli(dir, ['run', 'fix-failing-test'], { wire: w.wire, verifyRunner: new FakeVerify([1]), env });
    expect(r.code, r.err + r.out).toBe(4); // held at the PR, after the leaky worker steps and gates ran
    expect(w.gates.log).toContain('verify');
    const runId = (await events(dir)).find((e) => e.kind === 'run.started')!.runId!;
    const ex = await cli(dir, ['evidence', runId], { env: KEYS });
    expect(ex.code, ex.err).toBe(0);
    const bytes = rawLedger(dir) + filesUnder(join(dir, '.tecera/runs', runId)) + r.out + r.err;
    for (const leak of [CANARY, KEYS.ANTHROPIC_API_KEY, KEYS.OPENAI_API_KEY, Buffer.from(KEYS.OPENAI_API_KEY).toString('base64')]) expect(bytes.includes(leak), leak).toBe(false);
    expect(bytes).toContain('[REDACTED:');
  });

  it('resolved credentials are taken out of the environment handed to wiring and probes', async () => {
    const dir = await initialised();
    const w = fakeWire();
    const env = { ...ENV, ...KEYS };
    await cli(dir, ['run', 'fix-failing-test'], { wire: w.wire, verifyRunner: new FakeVerify([1]), env });
    expect(w.ctx!.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(w.ctx!.env.OPENAI_API_KEY).toBeUndefined();
    expect(w.ctx!.secrets.names().sort()).toEqual(['openai', 'openrouter']);
  });
});

describe('approvals by the local human principal (D1: no auth package, no tokens)', () => {
  it('approve defaults to $USER, --as overrides it; the audited approval.granted and its identity evidence record the principal; --token and --session are refused', async () => {
    const dir = await initialised();
    const { requestId, runId } = await heldRun(dir);
    // a second pending request on the same run (requested by the loop, an agent)
    const trace = (await events(dir)).find((e) => e.kind === 'approval.requested')!.trace;
    const l0 = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
    await l0.requestApproval({ requestId: 'ap_two', runId, sessionId: runId, actionHash: 'h2', requester: { kind: 'agent', id: 'loop' }, reason: 'externalWrite', expiresAt: Date.now() + 60_000 });
    await l0.append({ id: 'ev_ap_two', kind: 'approval.requested', at: Date.now(), actor: { kind: 'agent', id: 'loop' }, runId, trace, payload: { requestId: 'ap_two' } });
    l0.close();
    expect((await cli(dir, ['approve', requestId, '--token', 'x.y.z'])).code).toBe(2); // the flag no longer exists
    expect((await cli(dir, ['approve', requestId, '--session', 'x'])).code).toBe(2);
    expect((await cli(dir, ['approve', requestId, '--as', 'bob; rm -rf /'])).code).toBe(2);
    expect((await cli(dir, ['approve', requestId], { env: { USER: '' } })).code).toBe(2); // no principal at all
    const ok = await cli(dir, ['approve', requestId]); // $USER = tester
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toMatch(/approved \S+ as tester \(local principal, env:USER\)/);
    const evs = await events(dir);
    const granted = evs.find((e) => e.kind === 'approval.granted' && (e.payload as { requestId: string }).requestId === requestId)!;
    expect(granted.actor).toEqual({ kind: 'human', id: 'tester' });
    expect((granted.payload as { identity: Json }).identity).toEqual({ kind: 'human', id: 'tester', method: 'local', authenticated: false, source: 'env:USER' });
    const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
    const ev = await l.getEvidence((granted.payload as { evidenceKey: string }).evidenceKey);
    expect(ev?.kind).toBe('approval.identity');
    expect((ev!.body as { identity: Json }).identity).toMatchObject({ id: 'tester', method: 'local' });
    l.close();
    const two = await cli(dir, ['approve', 'ap_two', '--as', 'dana']);
    expect(two.code, two.err).toBe(0);
    expect(((await events(dir)).find((e) => e.kind === 'approval.granted' && (e.payload as { requestId: string }).requestId === 'ap_two')!.payload as { identity: Json }).identity).toMatchObject({ id: 'dana', source: 'as' });
  });

  it('separation of duty: a principal may not approve a request it made (exit 8); the loop request is granted by a human', async () => {
    const dir = await initialised();
    const { runId, requestId } = await heldRun(dir);
    const trace = (await events(dir)).find((e) => e.kind === 'approval.requested')!.trace;
    const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
    await l.requestApproval({ requestId: 'ap_mine', runId, sessionId: runId, actionHash: 'h3', requester: { kind: 'human', id: 'erin' }, reason: 'open_pr', expiresAt: Date.now() + 60_000 });
    await l.append({ id: 'ev_ap_mine', kind: 'approval.requested', at: Date.now(), actor: { kind: 'human', id: 'erin' }, runId, trace, payload: { requestId: 'ap_mine' } });
    l.close();
    const self = await cli(dir, ['approve', 'ap_mine'], { env: { USER: 'erin' } });
    expect(self.code).toBe(8);
    expect(self.err).toMatch(/requester cannot approve their own request/);
    expect((await cli(dir, ['approve', 'ap_mine', '--as', 'frank'])).code).toBe(0);
    expect((await cli(dir, ['approve', requestId, '--as', 'frank'])).code).toBe(0);
    const l2 = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
    const view = await l2.getApproval(requestId);
    l2.close();
    expect(view?.requester).toEqual({ kind: 'agent', id: 'loop' });
    expect(view?.approver).toEqual({ kind: 'human', id: 'frank' });
  });

  it('approval.replay / approval.hash_mismatch at the ledger the CLI writes: wrong hash, other session and a second consume are refused', async () => {
    const dir = await initialised();
    const { requestId, runId } = await heldRun(dir);
    expect((await cli(dir, ['approve', requestId, '--as', 'bob'], { env: LOCAL })).code).toBe(0);
    const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
    const view = (await l.getApproval(requestId))!;
    await expect(l.consume(requestId, 'not-the-hash', runId, 'c1', Date.now())).rejects.toThrow();
    await expect(l.consume(requestId, view.actionHash, 'other-session', 'c2', Date.now())).rejects.toThrow();
    await l.consume(requestId, view.actionHash, runId, 'c3', Date.now());
    await expect(l.consume(requestId, view.actionHash, runId, 'c4', Date.now())).rejects.toThrow();
    l.close();
  });
});

describe('recover.crash_each_step and approval-bound resume', () => {
  it('grant recorded without its event (crash between them) is not resumable until `tecera approve` repairs the event; then resume opens the PR once; a second resume is a no-op', async () => {
    const dir = await initialised();
    const w = fakeWire();
    const { requestId, runId } = await heldRun(dir, w);
    // crash simulation: the ledger transition happened, the audit event did not
    const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
    await l.approve(requestId, { kind: 'human', id: 'bob' }, runId, Date.now());
    // an unaudited grant is not consumable by ANY caller (the ledger boundary, not only resume)
    const view = (await l.getApproval(requestId))!;
    await expect(l.consume(requestId, view.actionHash, runId, 'direct-consume', Date.now())).rejects.toThrow(/unaudited/);
    l.close();
    const w2 = fakeWire();
    const blocked = await cli(dir, ['run', '--resume', runId], { wire: w2.wire, env: KEYS });
    expect(blocked.code, blocked.err + blocked.out).toBe(4);
    expect(blocked.out).toMatch(/approval.granted event is missing/);
    expect(w2.gates.log).not.toContain('pr');

    const repaired = await cli(dir, ['approve', requestId, '--as', 'bob'], { env: LOCAL });
    expect(repaired.code, repaired.err).toBe(0);
    expect(repaired.out).toMatch(/recording it now/);
    expect((await events(dir)).filter((e) => e.kind === 'approval.granted' && (e.payload as { requestId: string }).requestId === requestId)).toHaveLength(1);

    const w3 = fakeWire();
    const resumed = await cli(dir, ['run', '--resume', runId], { wire: w3.wire, env: KEYS });
    expect(w3.gates.log).toEqual(['pr']); // the commit is not redone: it is on the work branch already
    const prCtx = w3.gates.ctxs.find((c) => c.step.id === 'pr')!;
    expect(prCtx.approval).toMatchObject({ requestId, sessionId: runId });
    expect(prCtx.commit).toMatchObject({ sha: 'abc123' });
    expect(prCtx.worktree).toBe(dir);
    const evs = await events(dir);
    expect(evs.some((e) => e.kind === 'approval.consumed' && (e.payload as { requestId: string }).requestId === requestId)).toBe(true);
    expect(resumed.code, resumed.err + resumed.out).toBe(0);
    expect(resumed.out).toMatch(/goal achieved/);

    const before = (await events(dir)).length;
    const w4 = fakeWire();
    const again = await cli(dir, ['run', '--resume', runId], { wire: w4.wire, env: KEYS });
    expect(again.out).toMatch(/nothing to resume/);
    expect(w4.gates.log).toEqual([]);
    expect((await events(dir)).length).toBe(before);
  });

  it('a ledger that dies before execution stops the run (exit 9): no baseline, no goal adoption', async () => {
    const dir = await initialised();
    const verify = new FakeVerify([1]);
    const w = fakeWire();
    const wire: WireFn = async (ctx) => {
      const ports = await w.wire(ctx);
      (ctx.ledger as unknown as { close(): void }).close();
      return ports;
    };
    const r = await cli(dir, ['run', 'fix-failing-test'], { wire, verifyRunner: verify, env: KEYS });
    expect(r.code).toBe(9);
    expect(verify.calls).toHaveLength(0);
    expect(w.planner.writes).toBe(0);
  });

  it('interruption: the signal reaches the loop; no further step starts; run.interrupted; exit 130; ports disposed', async () => {
    const dir = await initialised();
    const ac = new AbortController();
    const w = fakeWire();
    let disposed = false;
    const origRun = w.worker.run.bind(w.worker);
    w.worker.run = async (req: WorkerStepRequest, s?: AbortSignal): Promise<Outcome> => {
      const out = await origRun(req);
      if (req.step.id === 'analyze') ac.abort();
      expect(s).toBeDefined();
      return out;
    };
    const wire: WireFn = async (ctx) => ({ ...(await w.wire(ctx)), dispose: async () => void (disposed = true) });
    const r = await cli(dir, ['run', 'fix-failing-test'], { wire, verifyRunner: new FakeVerify([1]), env: KEYS, signal: ac.signal });
    expect(r.code, r.out + r.err).toBe(130);
    expect(w.worker.calls.map((c) => c.step.id)).toEqual(['analyze']);
    expect(w.gates.log).toEqual([]);
    expect(disposed).toBe(true);
    const evs = await events(dir);
    expect(evs.some((e) => e.kind === 'run.interrupted')).toBe(true);
    // an interrupted run is resumable; resumed, it continues to the PR hold
    const resumed = await cli(dir, ['run', '--resume', evs.find((e) => e.kind === 'run.started')!.runId!], { wire, env: KEYS });
    expect(resumed.code, resumed.out + resumed.err).toBe(4);
    expect(w.worker.calls.map((c) => c.step.id)).toEqual(['analyze', 'edit']);
  });

  it('the baseline runs with the runner and worktree wiring returns, not the host runner on the repo root', async () => {
    const dir = await initialised();
    const wt = tmp();
    const host = new FakeVerify([1]);
    const sandboxed = new FakeVerify([1]);
    const w = fakeWire();
    const wire: WireFn = async (ctx) => ({ ...(await w.wire(ctx)), worktree: wt, verifyRunner: sandboxed });
    const r = await cli(dir, ['run', 'fix-failing-test'], { wire, verifyRunner: host, env: KEYS });
    expect(r.code, r.err + r.out).toBe(4);
    expect(host.calls).toHaveLength(0);
    expect(sandboxed.calls[0]!.cwd).toBe(wt);
    expect(host.calls).toHaveLength(0);
    expect(w.worker.calls[0]!.worktree).toBe(wt);
    expect(w.gates.ctxs.every((c) => c.worktree === wt)).toBe(true);
  });

  it('a baseline the tooling cannot run (timeout/127/flood) stops the run with exit 3 before the goal is adopted', async () => {
    const dir = await initialised();
    const w = fakeWire();
    const r = await cli(dir, ['run', 'fix-failing-test'], { wire: w.wire, verifyRunner: new FakeVerify([127]), env: KEYS });
    expect(r.code).toBe(3);
    expect(w.planner.writes).toBe(0);
    expect((await events(dir)).some((e) => e.kind === 'goal.adopted')).toBe(false);
  });
});

describe('execution readiness, effective budgets and plan re-validation', () => {
  it('lock drift, missing credentials or an unsafe env allowlist stop `run` with exit 3 before wiring or any verify', async () => {
    const dir = await initialised();
    const w = fakeWire();
    const verify = new FakeVerify([1]);
    const noKeys = await cli(dir, ['run', 'fix-failing-test'], { wire: w.wire, verifyRunner: verify });
    expect(noKeys.code).toBe(3);
    expect(noKeys.err).toMatch(/OPENROUTER_API_KEY not set/);
    writeFileSync(join(dir, '.tecera/skills/_index.md'), '# Skills\nchanged\n');
    const drift = await cli(dir, ['run', 'fix-failing-test'], { wire: w.wire, verifyRunner: verify, env: KEYS });
    expect(drift.code).toBe(3);
    expect(drift.err).toMatch(/drift/);
    const pf = await cli(dir, ['preflight', 'fix-failing-test', '--skip-live'], { verifyRunner: verify, env: KEYS });
    expect(pf.code).toBe(3);
    expect(pf.out).toMatch(/baseline\s+skipped: not ready/);
    expect((await cli(dir, ['doctor', '--skip-live', '--fix'], { env: KEYS })).code).toBeLessThanOrEqual(3);
    const m = JSON.parse(readFileSync(join(dir, 'tecera.json'), 'utf8'));
    m.sandbox.envAllowlist = ['PATH', 'HOME', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS'];
    writeFileSync(join(dir, 'tecera.json'), JSON.stringify(m, null, 2));
    const v = await cli(dir, ['validate'], { env: KEYS });
    expect(v.code).toBe(2);
    expect(v.out).toMatch(/ANTHROPIC_API_KEY looks like a credential/);
    expect(v.out).toMatch(/NODE_OPTIONS injects code/);
    await cli(dir, ['doctor', '--skip-live', '--fix'], { env: KEYS });
    const unsafe = await cli(dir, ['run', 'fix-failing-test'], { wire: w.wire, verifyRunner: verify, env: KEYS });
    expect(unsafe.code).toBe(3);
    expect(w.calls).toBe(0);
    expect(verify.calls).toHaveLength(0);
    const pf2 = await cli(dir, ['preflight', 'fix-failing-test', '--skip-live'], { verifyRunner: verify, env: KEYS });
    expect(pf2.code).toBe(3);
    expect(verify.calls).toHaveLength(0);
  });

  it('--max-depth / --budget-usd reach the Loop as an effective, frozen manifest: worker limits narrowed, over-budget plans rejected', async () => {
    const dir = await initialised();
    const w = fakeWire();
    const r = await cli(dir, ['run', 'fix-failing-test', '--max-depth', '1', '--budget-usd', '1'], { wire: w.wire, verifyRunner: new FakeVerify([1]), env: KEYS });
    expect(r.code, r.err + r.out).toBe(4);
    expect(w.ctx!.manifest.budgets.maxDepth).toBe(1);
    // the narrowed budget survives resume (it is read back from goal.adopted)
    const held = pendingRequest(await events(dir))!;
    expect((await cli(dir, ['approve', (held.payload as { requestId: string }).requestId, '--as', 'bob'])).code).toBe(0);
    const resumed = await cli(dir, ['run', '--resume', held.runId!], { wire: w.wire, env: KEYS });
    expect(resumed.code, resumed.err + resumed.out).toBe(0);
    expect(w.ctx!.resume).toBeDefined();
    expect(w.ctx!.manifest.budgets.maxDepth).toBe(1);
    expect(w.ctx!.manifest.budgets.usd).toBe(1);
    expect(Object.isFrozen(w.ctx!.manifest.budgets)).toBe(true);
    expect(w.worker.calls[0]!.capabilities.limits.depth).toBe(1);
    expect(w.worker.calls[0]!.capabilities.limits.usd).toBeLessThanOrEqual(1);

    const dir2 = await initialised();
    const w2 = fakeWire();
    w2.planner.write = async () => ({ ...fixPlan(), budget: { maxDepth: 2 } });
    const r2 = await cli(dir2, ['run', 'fix-failing-test', '--max-depth', '1'], { wire: w2.wire, verifyRunner: new FakeVerify([1]), env: KEYS });
    expect(r2.code, r2.err + r2.out).toBe(8);
    expect(w2.worker.calls).toHaveLength(0);
    expect((await events(dir2)).some((e) => e.kind === 'plan.rejected')).toBe(true);
  });

  it('an accepted plan that the current policy no longer allows is re-validated and rejected, never dispatched', async () => {
    const dir = await initialised();
    await achievedRun(dir);
    expect((await cli(dir, ['plans', 'graduate', 'p_fix', '--as', 'bob', '--rationale', 'worked'], { env: LOCAL })).code).toBe(0);
    const w = fakeWire();
    const inner = w.wire;
    const wire: WireFn = async (ctx) => ({ ...(await inner(ctx)), toolCatalog: ['read', 'runVerify'] }); // `edit` no longer exposed
    const r = await cli(dir, ['run', 'fix-failing-test'], { wire, verifyRunner: new FakeVerify([1]), env: KEYS });
    expect(r.code, r.err + r.out).toBe(8);
    expect(w.worker.calls).toHaveLength(0);
    const rejected = (await events(dir)).filter((e) => e.kind === 'plan.rejected' && e.runId === w.ctx!.runId);
    expect(rejected.length).toBeGreaterThan(0);
  });
});

describe('tamper.git_hook: repository git config cannot make tecera run programs', () => {
  it('a clean filter is detected (doctor missing, preflight skips the baseline) and never executes; fsmonitor and hooks are neutralised', async () => {
    const dir = await initialised();
    const marker = join(dir, '..', `pwned-${Date.now()}`);
    const g = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null' } });
    g('config', 'core.fsmonitor', `touch ${marker}-fsmonitor`);
    mkdirSync(join(dir, '.git/hooks'), { recursive: true });
    writeFileSync(join(dir, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch ${marker}-hook\n`, { mode: 0o755 });
    g('config', 'core.hooksPath', '.husky');
    const clean = await cli(dir, ['doctor', '--skip-live'], { env: KEYS });
    expect(clean.out).toMatch(/✓ git/);
    expect(existsSync(`${marker}-fsmonitor`)).toBe(false);
    g('config', 'filter.evil.clean', `sh -c 'touch ${marker}-filter; cat'`);
    writeFileSync(join(dir, '.gitattributes'), '*.js filter=evil\n');
    writeFileSync(join(dir, 'src/slugify.js'), readFileSync(join(dir, 'src/slugify.js'), 'utf8') + '\n// changed\n');
    const d = await cli(dir, ['doctor', '--skip-live'], { env: KEYS });
    expect(d.code).toBe(3);
    expect(d.out).toMatch(/filter\.evil\.clean/);
    const verify = new FakeVerify([1]);
    const pf = await cli(dir, ['preflight', 'fix-failing-test', '--skip-live'], { env: KEYS, verifyRunner: verify });
    expect(pf.code).toBe(3);
    expect(verify.calls).toHaveLength(0);
    for (const s of ['-filter', '-fsmonitor', '-hook']) expect(existsSync(`${marker}${s}`), s).toBe(false);
  });
});

describe('adapters: malformed host settings and unsafe targets', () => {
  it('settings that keep tecera deny lists or hooks out fail install (exit 3) and doctor (missing), user values preserved', async () => {
    const dir = await initialised();
    writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify({ model: 'opus', permissions: { deny: false }, hooks: false }));
    const ad = await cli(dir, ['adapters', 'doctor', 'claude-code'], { env: KEYS });
    expect(ad.code).toBe(3);
    const inst = await cli(dir, ['adapters', 'install', 'claude-code'], { env: KEYS });
    expect(inst.code).toBe(3);
    expect(inst.err).toMatch(/security conflict/);
    const s = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'));
    expect(s).toMatchObject({ model: 'opus', permissions: { deny: false }, hooks: false });
    const doc = await cli(dir, ['doctor', '--skip-live'], { env: KEYS });
    expect(doc.code).toBe(3);
    expect(doc.out).toMatch(/adapter:claude-code\s*NOT PROTECTED/);
  });

  it('symlinked CLAUDE.md or .claude/ cannot redirect init or install outside the repository', async () => {
    const dir = sampleCopy();
    const outside = tmp();
    writeFileSync(join(outside, 'victim.md'), 'original');
    symlinkSync(join(outside, 'victim.md'), join(dir, 'CLAUDE.md'));
    symlinkSync(outside, join(dir, '.claude'));
    const r = await cli(dir, ['init'], { env: KEYS });
    expect(r.code).not.toBe(0);
    expect(readFileSync(join(outside, 'victim.md'), 'utf8')).toBe('original');
    expect(existsSync(join(outside, 'settings.json'))).toBe(false);
  });

  it('hook pre-tool via the CLI: Bash writes to tests and tecera approve are blocked', async () => {
    const dir = await initialised();
    const payload = (cmd: string) => JSON.stringify({ hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Bash', tool_input: { command: cmd } });
    for (const cmd of ['printf compromised > test/slugify.test.js', 'rm test/slugify.test.js', 'tecera approve ap_1 --as bob']) {
      const r = await cli(dir, ['hook', 'pre-tool'], { stdin: payload(cmd) });
      expect(r.code, cmd).toBe(2);
    }
    expect(readFileSync(join(dir, 'test/slugify.test.js'), 'utf8')).not.toContain('compromised');
  });
});

describe('validate: scan omissions', () => {
  it('large files, runs/, links and special files under .tecera are scanned or refused, never skipped', async () => {
    const dir = await initialised();
    const key = 'sk-ant-api03-' + 'B'.repeat(24);
    writeFileSync(join(dir, '.tecera/memory/working/BIG.md'), 'x'.repeat(2 * 1024 * 1024) + `\nlate ${key}\n`);
    let r = await cli(dir, ['validate', '--json']);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).issues.some((i: { where: string }) => i.where.startsWith('.tecera/memory/working/BIG.md:'))).toBe(true);
    rmSync(join(dir, '.tecera/memory/working/BIG.md'));
    mkdirSync(join(dir, '.tecera/runs/r1'), { recursive: true });
    writeFileSync(join(dir, '.tecera/runs/r1/events.jsonl'), `{"x":"${key}"}\n`);
    r = await cli(dir, ['validate', '--json']);
    expect(JSON.parse(r.out).issues.some((i: { where: string }) => i.where.startsWith('.tecera/runs/r1/events.jsonl'))).toBe(true);
    rmSync(join(dir, '.tecera/runs'), { recursive: true });
    symlinkSync('/etc/hostname', join(dir, '.tecera/memory/link.md'));
    r = await cli(dir, ['validate', '--json']);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).issues.some((i: { where: string; message: string }) => i.where === '.tecera/memory/link.md' && /symbolic link/.test(i.message))).toBe(true);
    rmSync(join(dir, '.tecera/memory/link.md'));
    execFileSync('mkfifo', [join(dir, '.tecera/memory/pipe')]);
    r = await cli(dir, ['validate', '--json']);
    expect(r.code).toBe(2);
    expect(r.out).not.toContain(key);
  });
});

describe('installed package: init outside the checkout', () => {
  it('resolves bundled assets package-relatively and initialises a repository from them', async () => {
    const pkg = tmp();
    execFileSync(process.execPath, [join(HERE, '..', 'scripts', 'copy-assets.mjs'), join(pkg, 'assets')]);
    mkdirSync(join(pkg, 'dist', 'commands'), { recursive: true });
    const fakeModule = pathToFileURL(join(pkg, 'dist', 'commands', 'init.js')).href;
    expect(resolveAssetsRoot(undefined, fakeModule)).toBe(join(pkg, 'assets'));
    const dir = tmp();
    const r = await cli(dir, ['init', '--sample'], { assetsRoot: resolveAssetsRoot(undefined, fakeModule) });
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(dir, 'test/slugify.test.js'))).toBe(true);
    expect(existsSync(join(dir, '.tecera/goals/fix-failing-test.goal.md'))).toBe(true);
  });
});

describe('goal files are pinned and contained', () => {
  it('an edited goal check command is lock drift: gate and run refuse to execute it (exit 3); a symlinked goal file is refused', async () => {
    const dir = await initialised();
    const goalFile = join(dir, '.tecera/goals/fix-failing-test.goal.md');
    writeFileSync(goalFile, readFileSync(goalFile, 'utf8').replace(/^verify: .*$/m, 'verify: touch pwned-by-goal'));
    expect(readFileSync(goalFile, 'utf8')).toContain('verify: touch pwned-by-goal');
    const verify = new FakeVerify([0]);
    const g = await cli(dir, ['gate', 'fix-failing-test'], { verifyRunner: verify, env: KEYS });
    expect(g.code, g.err + g.out).toBe(3);
    expect(g.err).toMatch(/fix-failing-test.goal.md changed since lock/);
    expect(verify.calls).toHaveLength(0);
    const w = fakeWire();
    expect((await cli(dir, ['run', 'fix-failing-test'], { wire: w.wire, verifyRunner: verify, env: KEYS })).code).toBe(3);
    expect(verify.calls).toHaveLength(0);
    expect(existsSync(join(dir, 'pwned-by-goal'))).toBe(false);

    const outside = tmp();
    writeFileSync(join(outside, 'evil.goal.md'), '---\nid: evil\nkind: achievement\nverify: touch pwned\n---\nEvil\n');
    symlinkSync(join(outside, 'evil.goal.md'), join(dir, '.tecera/goals/evil.goal.md'));
    const e = await cli(dir, ['gate', 'evil'], { verifyRunner: verify, env: KEYS });
    expect(e.code).toBe(2);
    expect(e.err).toMatch(/symbolic link/);
    expect(verify.calls).toHaveLength(0);
  });
});

describe('wave 3: budgets, resume authority, probes and host boundaries', () => {
  it('D3 budgets off by default: a planner reservation past the usd cap is recorded (budget.exhausted) and the run goes on to the PR hold; the pools are soft and reported', async () => {
    const dir = await initialised();
    const w = fakeWire();
    const r = await cli(dir, ['run', 'fix-failing-test', '--budget-usd', '0.01'], { wire: w.wire, verifyRunner: new FakeVerify([1]), env: KEYS });
    expect(r.code, r.err + r.out).toBe(4);
    expect(w.planner.writes).toBe(1);
    const evs = await events(dir);
    expect(evs.some((e) => e.kind === 'goal.dropped')).toBe(false);
    const ex = evs.filter((e) => e.kind === 'budget.exhausted');
    expect(ex.length).toBeGreaterThan(0);
    expect(ex.every((e) => (e.payload as { enforced?: boolean }).enforced === false)).toBe(true);
    expect(ex.some((e) => (e.payload as { pool?: string }).pool === 'usd')).toBe(true);
    // the run's pools were opened soft with the narrowed cap; usage is reported, never a stop
    expect(r.out).toMatch(/^cost {7}\$\d+\.\d{4} .* usd pool \$\d+\.\d{4}\/\$0\.0100 incl\. reservations \(not enforced\)/m);
    // D4: the Stop hook blocks on the missing proof, never on the budget
    const stop = await cli(dir, ['hook', 'stop'], { stdin: JSON.stringify({ hook_event_name: 'Stop', cwd: dir }) });
    expect(stop.code).toBe(2);
    expect(stop.err).toMatch(/goal not achieved: /);
    expect(stop.err).not.toMatch(/budget/i);
  });

  it('D3 budgets.enforce true: the reservation before the planner call does not fit → goal.dropped {failure: budget} → exit 7, the planner is never called', async () => {
    const dir = sampleCopy();
    const m = JSON.parse(readFileSync(join(dir, 'tecera.json'), 'utf8'));
    m.budgets.enforce = true;
    writeFileSync(join(dir, 'tecera.json'), JSON.stringify(m, null, 2));
    expect((await cli(dir, ['init'])).code).toBe(0);
    gitRepo(dir);
    const w = fakeWire();
    const r = await cli(dir, ['run', 'fix-failing-test', '--budget-usd', '0.01'], { wire: w.wire, verifyRunner: new FakeVerify([1]), env: KEYS });
    expect(r.code, r.err + r.out).toBe(7);
    expect(w.planner.writes).toBe(0);
    const dropped = (await events(dir)).find((e) => e.kind === 'goal.dropped')!;
    expect(dropped.payload).toMatchObject({ failure: 'budget' });
    expect((await events(dir)).some((e) => e.kind === 'plan.rejected')).toBe(false);
    expect((await events(dir)).some((e) => e.kind === 'budget.exhausted')).toBe(false);
    // a run ended by its budget is not active: the Stop hook never holds the assistant on budget
    expect((await cli(dir, ['hook', 'stop'], { stdin: JSON.stringify({ hook_event_name: 'Stop', cwd: dir }) })).code).toBe(0);
  });

  it('the goal check is the check the run enforces: a goal whose verify differs from tecera.json reaches wiring (gates, worker, baseline) as the effective verify command', async () => {
    const dir = sampleCopy();
    const goalPath = join(dir, '.tecera/goals/fix-failing-test.goal.md');
    writeFileSync(goalPath, readFileSync(goalPath, 'utf8').replace(/^verify: .*$/m, 'verify: node --test test/slugify.test.js'));
    expect((await cli(dir, ['init'])).code).toBe(0);
    gitRepo(dir);
    const w = fakeWire();
    const verify = new FakeVerify([1]);
    expect((await cli(dir, ['run', 'fix-failing-test'], { wire: w.wire, verifyRunner: verify, env: KEYS })).code).toBe(4);
    expect(w.ctx!.manifest.verify.command).toBe('node --test test/slugify.test.js');
    expect(verify.calls[0]!.command).toBe('node --test test/slugify.test.js');
  });

  it('resume re-validates restored authority: a plan the tightened policy no longer allows is refused (exit 8) before anything is restored or dispatched', async () => {
    const dir = await initialised();
    const w = fakeWire();
    expect((await cli(dir, ['run', 'fix-failing-test'], { wire: w.wire, verifyRunner: new FakeVerify([1]), env: KEYS })).code).toBe(4);
    const held = pendingRequest(await events(dir))!;
    // policy tightened legitimately (edit not allowed under src/ any more) and re-pinned
    const m = JSON.parse(readFileSync(join(dir, 'tecera.json'), 'utf8'));
    m.repo.allowedChanges = ['lib/**'];
    writeFileSync(join(dir, 'tecera.json'), JSON.stringify(m, null, 2));
    expect((await cli(dir, ['doctor', '--skip-live', '--fix'], { env: KEYS })).out).toMatch(/re-pinned/);
    expect((await cli(dir, ['approve', (held.payload as { requestId: string }).requestId, '--as', 'carol'], { env: LOCAL })).code).toBe(0);
    const before = (await events(dir)).length;
    const calls = w.worker.calls.length;
    const r = await cli(dir, ['run', '--resume', held.runId!], { wire: w.wire, env: KEYS });
    expect(r.code, r.err + r.out).toBe(8);
    expect(r.out).toMatch(/resume refused: .*no longer allowed by the current policy/);
    expect(w.worker.calls).toHaveLength(calls);
    expect(w.gates.log).not.toContain('pr');
    const after = (await events(dir)).slice(before);
    expect(after.map((e) => e.kind)).toEqual(['run.ended']);
  });

  it('a held worker suspension (checkpoint capabilities) is not resumed after the policy changed (exit 8); the worker never resumes', async () => {
    const dir = await initialised();
    const w = fakeWire();
    let resumed = 0;
    w.worker.run = async (req: WorkerStepRequest): Promise<Outcome> => {
      w.worker.calls.push(req);
      if (req.step.id !== 'edit') return { kind: 'returned', value: { facts: [] }, run: { runId: req.runId, invokeId: `inv_${req.step.id}`, depth: 0 } };
      await w.gates.ledger!.requestApproval({ requestId: 'ap_worker', runId: req.runId, sessionId: req.runId, actionHash: 'h-write', requester: { kind: 'agent', id: 'worker' }, reason: 'writeFile outside allowed', expiresAt: Date.now() + 600_000 });
      return { kind: 'suspended', request: { requestId: 'ap_worker', action: 'writeFile', actionHash: 'h-write', reason: 'writeFile', requester: 'worker' }, resumeToken: 'tok-1', run: { runId: req.runId, invokeId: 'inv_edit', depth: 0 } };
    };
    w.worker.resume = async () => {
      resumed++;
      throw new Error('must not resume');
    };
    // D6: no hold before the worker runs; the worker's own (non-write) suspension holds the step
    expect((await cli(dir, ['run', 'fix-failing-test'], { wire: w.wire, verifyRunner: new FakeVerify([1]), env: KEYS })).code).toBe(4);
    const evs = await events(dir);
    const workerHold = evs.find((e) => e.kind === 'step.held' && (e.payload as { owner?: string }).owner === 'worker');
    expect(workerHold, evs.map((e) => e.kind).join(' ')).toBeTruthy();
    const runId = workerHold!.runId!;
    // the policy changes (a new never-rule), re-pinned
    const permPath = join(dir, '.tecera/protocols/permissions.json');
    const perm = JSON.parse(readFileSync(permPath, 'utf8'));
    perm.never.push('rewrite_history');
    writeFileSync(permPath, JSON.stringify(perm, null, 2));
    expect((await cli(dir, ['doctor', '--skip-live', '--fix'], { env: KEYS })).out).toMatch(/re-pinned/);
    expect((await cli(dir, ['approve', 'ap_worker', '--as', 'carol'], { env: LOCAL })).code).toBe(0);
    const r = await cli(dir, ['run', '--resume', runId], { wire: w.wire, env: KEYS });
    expect(r.code, r.err + r.out).toBe(8);
    expect(r.out).toMatch(/held worker suspension\(s\) ap_worker .* cannot be resumed/);
    expect(resumed).toBe(0);
  });

  it('live probes: the real provider adapters through doctorProbe (transport replaced, no network); keys never printed', async () => {
    const dir = await initialised();
    const replies = scriptedFetch('probe', 'auto', [{ text: 'ok' }, { text: 'ok' }, { text: 'ok' }]);
    const seen: Array<{ url: string; auth: boolean }> = [];
    const fetch = (async (url: string, init: { headers?: Record<string, string>; body?: unknown }) => {
      const h = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      seen.push({ url: String(url), auth: !!(h['x-api-key'] || h.authorization) });
      return replies(url as never, init as never);
    }) as never;
    const r = await cli(dir, ['doctor'], { env: KEYS, probe: createProbe({ fetch }) });
    expect(r.code, r.out).toBe(0);
    // D7: the Claude seats go through OpenRouter, the reviewer to OpenAI directly
    expect(r.out).toMatch(/planner\s+openrouter\/anthropic\/claude-sonnet-4\.5 — live completion ok/);
    expect(r.out).toMatch(/worker:worker\s+openrouter\/anthropic\/claude-haiku-4\.5 — live completion ok/);
    expect(r.out).toMatch(/reviewer\s+openai\/gpt-5\.6-terra — live completion ok/);
    expect(seen).toHaveLength(3);
    expect(seen.filter((x) => x.url.startsWith('https://openrouter.ai/api/'))).toHaveLength(2);
    expect(seen.filter((x) => x.url.startsWith('https://api.openai.com/'))).toHaveLength(1);
    expect(seen.every((x) => x.auth)).toBe(true);
    for (const k of Object.values(KEYS)) expect(r.out + r.err).not.toContain(k);
    // no SecretStore → not ready, nothing sent
    const bare = await createProbe({ fetch })({ role: 'planner', id: 'planner', provider: 'openrouter', model: 'm' }, { manifest: JSON.parse(readFileSync(join(dir, 'tecera.json'), 'utf8')), env: {} });
    expect(bare.ok).toBe(false);
    expect(seen).toHaveLength(3);
  });

  it('preflight with live probes enabled: lock drift (or a missing key) means NO model call, exit 3', async () => {
    const dir = await initialised();
    const probed: string[] = [];
    const probe = async (seat: { id: string }) => (probed.push(seat.id), { ok: true, latencyMs: 1, usd: 0 });
    writeFileSync(join(dir, '.tecera/skills/_index.md'), '# Skills\nchanged\n');
    const pf = await cli(dir, ['preflight', 'fix-failing-test'], { env: KEYS, verifyRunner: new FakeVerify([1]), probe });
    expect(pf.code).toBe(3);
    expect(pf.out).toMatch(/live probes not run: not ready/);
    const doc = await cli(dir, ['doctor'], { env: KEYS, probe });
    expect(doc.code).toBe(3);
    expect(probed).toEqual([]);
    await cli(dir, ['doctor', '--skip-live', '--fix'], { env: KEYS });
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qam', 'skills'], { env: { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null' } });
    const ok = await cli(dir, ['preflight', 'fix-failing-test'], { env: KEYS, verifyRunner: new FakeVerify([1]), probe });
    expect(ok.code, ok.out).toBe(0);
    expect(probed).toEqual(['planner', 'worker', 'reviewer']);
  });

  it('hook pre-tool via the CLI: host git refuses when any git config (local or env-provided) can run a program; a clean config allows read-only git', async () => {
    const dir = await initialised();
    const payload = (cmd: string) => JSON.stringify({ hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Bash', tool_input: { command: cmd } });
    const hermetic = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    expect((await cli(dir, ['hook', 'pre-tool'], { stdin: payload('git --no-pager status'), env: hermetic })).code).toBe(0);
    execFileSync('git', ['-C', dir, 'config', 'core.fsmonitor', 'touch /tmp/pwned-fsmonitor'], { env: { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null' } });
    const blocked = await cli(dir, ['hook', 'pre-tool'], { stdin: payload('git --no-pager status'), env: hermetic });
    expect(blocked.code).toBe(2);
    expect(blocked.err).toMatch(/core\.fsmonitor/);
    execFileSync('git', ['-C', dir, 'config', '--unset', 'core.fsmonitor'], { env: { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null' } });
    const envCfg = await cli(dir, ['hook', 'pre-tool'], { stdin: payload('git --no-pager diff'), env: { ...hermetic, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.external', GIT_CONFIG_VALUE_0: 'sh' } });
    expect(envCfg.code).toBe(2);
    // (the key name itself is redacted on output: it is the value of a credential-named env var, GIT_CONFIG_KEY_0)
    expect(envCfg.err, envCfg.err).toMatch(/git config can make this command run a program/);
    const attached = await cli(dir, ['hook', 'pre-tool'], { stdin: payload('sort -otest/slugify.test.js src/slugify.js'), env: hermetic });
    expect(attached.code).toBe(2);
  });
  it('the durable run deadline under budgets.enforce true: a baseline still running when it passes is cancelled → exit 7 (goal not adopted); a resume after the deadline fails the run as budget (exit 7), nothing dispatched', async () => {
    const dir = sampleCopy();
    const goalPath = join(dir, '.tecera/goals/fix-failing-test.goal.md');
    writeFileSync(goalPath, readFileSync(goalPath, 'utf8').replace(/budget: \{[^}]*\}/, 'budget: { usd: 2, wallClockSec: 2 }'));
    const m = JSON.parse(readFileSync(join(dir, 'tecera.json'), 'utf8'));
    m.budgets.enforce = true;
    writeFileSync(join(dir, 'tecera.json'), JSON.stringify(m, null, 2));
    expect((await cli(dir, ['init'])).code).toBe(0);
    gitRepo(dir);
    // a baseline that only ends when it is cancelled
    const hanging: VerifyRunner = {
      run: (_req: VerifyRequest, signal?: AbortSignal) =>
        new Promise<VerifyOutcome>((res) => {
          const done = () => res({ exitCode: 130, signal: 'SIGKILL', timedOut: false, stdout: '', stderr: '', durationMs: 1, truncated: false });
          if (signal?.aborted) done();
          else signal?.addEventListener('abort', done, { once: true });
        }),
    };
    const w = fakeWire();
    const r = await cli(dir, ['run', 'fix-failing-test'], { wire: w.wire, verifyRunner: hanging, env: KEYS });
    expect(r.code, r.err + r.out).toBe(7);
    expect(r.out).toMatch(/run deadline exceeded during the baseline/);
    expect((await events(dir)).some((e) => e.kind === 'goal.adopted')).toBe(false);

    // a held run resumed after its deadline: the deadline recorded in run.started still applies
    const w2 = fakeWire();
    expect((await cli(dir, ['run', 'fix-failing-test'], { wire: w2.wire, verifyRunner: new FakeVerify([1]), env: KEYS })).code).toBe(4);
    const held = pendingRequest(await events(dir))!;
    expect((await cli(dir, ['approve', (held.payload as { requestId: string }).requestId, '--as', 'carol'], { env: LOCAL })).code).toBe(0);
    await new Promise((res) => setTimeout(res, 2300));
    const calls = w2.worker.calls.length;
    const late = await cli(dir, ['run', '--resume', held.runId!], { wire: w2.wire, env: KEYS });
    expect(late.code, late.err + late.out).toBe(7);
    expect(w2.worker.calls).toHaveLength(calls);
    expect(w2.gates.log).not.toContain('pr');
    const failed = (await events(dir)).filter((e) => e.runId === held.runId && (e.kind === 'step.failed' || e.kind === 'goal.dropped'));
    expect(failed.some((e) => (e.payload as { failure?: string }).failure === 'budget')).toBe(true);
  });

  it('D3: with budgets.enforce false (the default) a passed run deadline is recorded (budget.exhausted wallClock) and never ends the run: the resumed PR completes (exit 0)', async () => {
    const dir = sampleCopy();
    const goalPath = join(dir, '.tecera/goals/fix-failing-test.goal.md');
    writeFileSync(goalPath, readFileSync(goalPath, 'utf8').replace(/budget: \{[^}]*\}/, 'budget: { usd: 2, wallClockSec: 1 }'));
    expect((await cli(dir, ['init'])).code).toBe(0);
    gitRepo(dir);
    const w = fakeWire();
    expect((await cli(dir, ['run', 'fix-failing-test'], { wire: w.wire, verifyRunner: new FakeVerify([1]), env: KEYS })).code).toBe(4);
    const held = pendingRequest(await events(dir))!;
    expect((await cli(dir, ['approve', (held.payload as { requestId: string }).requestId, '--as', 'carol'], { env: LOCAL })).code).toBe(0);
    await new Promise((res) => setTimeout(res, 1300));
    const late = await cli(dir, ['run', '--resume', held.runId!], { wire: w.wire, env: KEYS });
    expect(late.code, late.err + late.out).toBe(0);
    expect(w.gates.log).toContain('pr');
    const evs = (await events(dir)).filter((e) => e.runId === held.runId);
    expect(evs.some((e) => e.kind === 'budget.exhausted' && (e.payload as { pool?: string }).pool === 'wallClock')).toBe(true);
    expect(evs.some((e) => (e.payload as { failure?: string }).failure === 'budget')).toBe(false);
  });

  it('validate: the scan skips only the configured ledger file (single-link regular file); a same-named directory or a hard-linked ledger is scanned and reported', async () => {
    const dir = await initialised();
    const key = 'sk-ant-api03-' + 'C'.repeat(24);
    mkdirSync(join(dir, '.tecera/memory/ledger.sqlite'), { recursive: true });
    writeFileSync(join(dir, '.tecera/memory/ledger.sqlite/notes.md'), `hidden ${key}\n`);
    let r = await cli(dir, ['validate', '--json']);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).issues.some((i: { where: string }) => i.where.startsWith('.tecera/memory/ledger.sqlite/notes.md'))).toBe(true);
    rmSync(join(dir, '.tecera/memory/ledger.sqlite'), { recursive: true });
    expect((await cli(dir, ['validate'])).code).toBe(0);
    // the real ledger as a hard link: refused as an exclusion (and scanned)
    const other = join(tmp(), 'other.sqlite');
    writeFileSync(other, `x ${key}\n`);
    rmSync(join(dir, '.tecera/ledger.sqlite'));
    linkSync(other, join(dir, '.tecera/ledger.sqlite'));
    r = await cli(dir, ['validate', '--json']);
    expect(r.code).toBe(2);
    const issues = JSON.parse(r.out).issues as Array<{ where: string; message: string }>;
    expect(issues.some((i) => i.where === '.tecera/ledger.sqlite' && /hard links/.test(i.message))).toBe(true);
    expect(r.out).not.toContain(key);
    // and the runtime refuses to open it
    const st = await cli(dir, ['status']);
    expect(st.code).toBe(8);
    expect(st.err).toMatch(/hard links/);
  });
});

// ---------- owner decisions D2 / D4 / D5 / D6 at the CLI boundary ----------

describe('D4: the Stop hook requires a proof of achievement', () => {
  const stopPayload = (dir: string, extra: Record<string, unknown> = {}) => JSON.stringify({ hook_event_name: 'Stop', cwd: dir, session_id: 'host-session-1', stop_hook_active: false, ...extra });

  it('blocks (exit 2, "goal not achieved: …") while the run is held at the PR; allows (exit 0) once goal.achieved carries a proof backed by verify evidence; each decision is recorded', async () => {
    const dir = await initialised();
    const w = fakeWire();
    const { runId, requestId } = await heldRun(dir, w);
    const before = await cli(dir, ['hook', 'stop'], { stdin: stopPayload(dir) });
    expect(before.code).toBe(2);
    expect(before.err).toMatch(new RegExp(`goal not achieved: run ${runId} \\(goal g_fix-failing-test\\) is held for a human decision and has no goal.achieved proof`));
    expect((await cli(dir, ['approve', requestId, '--as', 'bob'])).code).toBe(0);
    // granted but not yet resumed: still no proof
    expect((await cli(dir, ['hook', 'stop'], { stdin: stopPayload(dir, { stop_hook_active: true }) })).code).toBe(2);
    const resumed = await cli(dir, ['run', '--resume', runId], { wire: w.wire, env: KEYS });
    expect(resumed.code, resumed.err + resumed.out).toBe(0);
    const after = await cli(dir, ['hook', 'stop'], { stdin: stopPayload(dir) });
    expect(after.code, after.err).toBe(0);
    expect(after.out).toMatch(/proved its goal: `node --test` exited 0 on d1-fake/);
    const evs = await events(dir);
    const achieved = evs.find((e) => e.kind === 'goal.achieved')!;
    expect((achieved.payload as { proof: Json }).proof).toMatchObject({ command: 'node --test', exitCode: 0, fingerprint: 'd1-fake' });
    const blocked = evs.filter((e) => e.kind === 'stop.blocked');
    expect(blocked).toHaveLength(2);
    expect(blocked[0]!.runId).toBe(runId);
    expect(blocked[1]!.payload).toMatchObject({ stopHookActive: true, hostSession: 'host-session-1' });
    const allowed = evs.filter((e) => e.kind === 'stop.allowed');
    expect(allowed).toHaveLength(1);
    expect((allowed[0]!.payload as { proof: { evidenceKey: string } }).proof.evidenceKey).toBe((achieved.payload as { proof: { evidenceKey: string } }).proof.evidenceKey);
  });

  it('an interrupted run blocks; a run that ended on a terminal failure does not; outside a business case or before any ledger it allows; an unreadable ledger or payload blocks (fail closed)', async () => {
    const outside = tmp();
    expect((await cli(outside, ['hook', 'stop'], { stdin: stopPayload(outside) })).code).toBe(0);
    const fresh = sampleCopy();
    expect((await cli(fresh, ['hook', 'stop'], { stdin: stopPayload(fresh) })).code).toBe(0); // no ledger yet

    const dir = await initialised();
    const ac = new AbortController();
    const w = fakeWire();
    const origRun = w.worker.run.bind(w.worker);
    w.worker.run = async (req: WorkerStepRequest, s?: AbortSignal): Promise<Outcome> => {
      const out = await origRun(req);
      if (req.step.id === 'analyze') ac.abort();
      void s;
      return out;
    };
    expect((await cli(dir, ['run', 'fix-failing-test'], { wire: w.wire, verifyRunner: new FakeVerify([1]), env: KEYS, signal: ac.signal })).code).toBe(130);
    const interrupted = await cli(dir, ['hook', 'stop'], { stdin: stopPayload(dir) });
    expect(interrupted.code).toBe(2);
    expect(interrupted.err).toMatch(/is interrupted and has no goal.achieved proof/);
    expect((await cli(dir, ['hook', 'stop'], { stdin: 'not json' })).code).toBe(2);

    // a denied PR ends the run (exit 8): nothing is active any more
    const dir2 = await initialised();
    const w2 = fakeWire();
    const { runId, requestId } = await heldRun(dir2, w2);
    expect((await cli(dir2, ['deny', requestId, '--reason', 'no'])).code).toBe(0);
    expect((await cli(dir2, ['run', '--resume', runId], { wire: w2.wire, env: KEYS })).code).toBe(8);
    expect((await cli(dir2, ['hook', 'stop'], { stdin: stopPayload(dir2) })).code).toBe(0);

    writeFileSync(join(dir2, '.tecera/ledger.sqlite'), 'this is not a database');
    rmSync(join(dir2, '.tecera/ledger.sqlite-wal'), { force: true });
    rmSync(join(dir2, '.tecera/ledger.sqlite-shm'), { force: true });
    const broken = await cli(dir2, ['hook', 'stop'], { stdin: stopPayload(dir2) });
    expect(broken.code).toBe(2);
    expect(broken.err).toMatch(/stop hook failed closed/);
  });
});

describe('D2 / D5 / D6 manifest and permissions rules', () => {
  it("reflex 'off', review.foreign false, approvals for 'commit', or a permissions.json that holds commits are refused by validate (exit 2)", async () => {
    const dir = await initialised();
    const original = readFileSync(join(dir, 'tecera.json'), 'utf8');
    const edit = (f: (m: Record<string, any>) => void): void => {
      const m = JSON.parse(original);
      f(m);
      writeFileSync(join(dir, 'tecera.json'), JSON.stringify(m, null, 2));
    };
    edit((m) => (m.reflexes.gate = 'off'));
    let v = await cli(dir, ['validate']);
    expect(v.code).toBe(2);
    expect(v.out + v.err).toMatch(/reflex setting 'off' was removed/);
    edit((m) => (m.reflexes.triage = 'off'));
    expect((await cli(dir, ['validate'])).code).toBe(2);
    edit((m) => (m.review.foreign = false));
    v = await cli(dir, ['validate']);
    expect(v.code).toBe(2);
    expect(v.out + v.err).toMatch(/review.foreign must be true/);
    edit((m) => (m.policy.approvals.required = ['commit']));
    v = await cli(dir, ['validate']);
    expect(v.code).toBe(2);
    expect(v.out + v.err).toMatch(/'commit' no longer requires approval/);
    // unset seams resolve to 'rule' (rules provider); the run never sees 'off'
    edit((m) => delete m.reflexes.gate);
    expect((await cli(dir, ['doctor', '--skip-live', '--fix'])).code).toBe(0);
    const dry = await cli(dir, ['run', 'fix-failing-test', '--dry-run']);
    expect(dry.out).toMatch(/reflexes {3}triage=rule choosePlan=rule route=rule gate=rule reconsider=rule closeOut=rule/);
    writeFileSync(join(dir, 'tecera.json'), original);
    const permPath = join(dir, '.tecera/protocols/permissions.json');
    writeFileSync(permPath, JSON.stringify({ always: ['read', 'listFiles', 'runVerify'], requiresApproval: ['commit', 'open_pr'], never: ['merge'] }));
    v = await cli(dir, ['validate']);
    expect(v.code).toBe(2);
    expect(v.out).toMatch(/'commit' must be in always/);
    writeFileSync(permPath, JSON.stringify({ always: ['read', 'commit', 'merge'], requiresApproval: ['open_pr'], never: [] }));
    v = await cli(dir, ['validate']);
    expect(v.out).toMatch(/'merge' must be in never/);
  });

  it('a run with --allow-same-vendor-review is a usage error (the flag is gone: review is always foreign)', async () => {
    const dir = await initialised();
    expect((await cli(dir, ['run', 'fix-failing-test', '--allow-same-vendor-review', '--dry-run'])).code).toBe(2);
  });
});
