import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteLedger } from '@tecera/ledger';
import type { TeceraEvent } from '@tecera/contracts';
import { main, type MainOptions } from './cli/main.js';
import { PROBE_COST_CAP_USD } from './commands/doctor.js';

/**
 * Live (D7): real provider calls through the shipped sample's seats — the Claude seats through OpenRouter,
 * the reviewer through OpenAI. Runs only when OPENROUTER_API_KEY is in the test process's environment
 * (source /root/.config/tecera/live.env into the test process; never print or copy the values). Each probe is
 * one tiny completion; the whole file is capped at a few cents and asserts the cap.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(resolve(HERE, '../../..'), 'samples/fix-failing-test');
const LIVE = process.env.OPENROUTER_API_KEY;
const keys = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const k of ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) if (process.env[k]) out[k] = process.env[k]!;
  return out;
};

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function cli(cwd: string, argv: string[], opts: MainOptions = {}): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const { env: extraEnv, ...rest } = opts;
  const code = await main(argv, { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: 'tester', ...(extraEnv ?? {}) }, stdout: (s) => (out += s), stderr: (s) => (err += s), isTTY: false, ...rest });
  return { code, out, err };
}

async function sample(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'tecera-live-'));
  temps.push(dir);
  cpSync(SAMPLE, dir, { recursive: true, filter: (src) => !/node_modules|ledger\.sqlite|[\\/]runs([\\/]|$)/.test(src) });
  expect((await cli(dir, ['init'])).code).toBe(0);
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { env: { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null' } });
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  return dir;
}

describe.skipIf(!LIVE)('live (D7): doctor probes the sample seats through the real providers, under a cost cap', () => {
  it('planner and worker answer through OpenRouter (anthropic/claude-*), the reviewer through OpenAI when its key is present; cost is reported and capped; no key is printed', async () => {
    const dir = await sample();
    const env = keys();
    const r = await cli(dir, ['doctor'], { env });
    const text = r.out + r.err;
    for (const v of Object.values(env)) expect(text.includes(v), 'a provider key was printed').toBe(false);
    expect(r.out, r.out).toMatch(/planner\s+openrouter\/anthropic\/claude-sonnet-4\.5 — live completion ok \(\d+ms, \$\d+\.\d{4}/);
    expect(r.out, r.out).toMatch(/worker:worker\s+openrouter\/anthropic\/claude-haiku-4\.5 — live completion ok \(\d+ms, \$\d+\.\d{4}/);
    if (env.OPENAI_API_KEY) {
      expect(r.out, r.out).toMatch(/reviewer\s+openai\/gpt-5\.6-terra — live completion ok/);
      expect(r.code, r.out).toBe(0);
    }
    const spent = [...r.out.matchAll(/live completion ok \(\d+ms, \$(\d+\.\d{4})/g)].reduce((a, m) => a + Number(m[1]), 0);
    expect(spent).toBeGreaterThan(0); // usage came back from the providers and was priced
    expect(spent).toBeLessThanOrEqual(PROBE_COST_CAP_USD);
  }, 180_000);
});

async function events(dir: string): Promise<TeceraEvent[]> {
  const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
  const out: TeceraEvent[] = [];
  for await (const e of l.events()) out.push(e);
  l.close();
  return out;
}

/** Live end to end costs a few cents (one plan, one or two worker turns, one review); capped by --budget-usd and asserted. */
const LIVE_RUN_CAP_USD = 0.5;

describe.skipIf(!LIVE || !process.env.OPENAI_API_KEY)('live (D7): the shipped sample runs end to end through real models', () => {
  it('the planner (Claude via OpenRouter) writes the plan, the worker fixes src/, the foreign reviewer (OpenAI) approves, the commit lands on the work branch, the run holds at the PR and the Stop hook blocks; a local approval delivers the PR (pr.requested, no remote), goal.achieved carries its proof and the Stop hook allows', async () => {
    const dir = await sample();
    const wt = mkdtempSync(join(tmpdir(), 'tecera-live-wt-'));
    temps.push(wt);
    const root = typeof process.getuid === 'function' && process.getuid() === 0 ? { TECERA_VERIFY_ALLOW_ROOT: '1' } : {};
    const env = { ...keys(), TECERA_WORKTREES: wt, ...root };
    const run = await cli(dir, ['run', 'fix-failing-test', '--budget-usd', String(LIVE_RUN_CAP_USD)], { env });
    for (const v of Object.values(keys())) expect((run.out + run.err).includes(v), 'a provider key was printed').toBe(false);
    expect(run.code, run.out + run.err).toBe(4);
    const cost = /^cost {7}\$(\d+\.\d{4}) /m.exec(run.out);
    expect(cost, run.out).toBeTruthy();
    expect(Number(cost![1])).toBeGreaterThan(0);
    expect(Number(cost![1])).toBeLessThanOrEqual(LIVE_RUN_CAP_USD);
    let evs = await events(dir);
    const held = [...evs].reverse().find((e) => e.kind === 'approval.requested')!;
    const runId = held.runId!;
    expect(evs.find((e) => e.kind === 'plan.generated' && e.runId === runId)!.payload).toMatchObject({ plan: { steps: expect.arrayContaining([expect.objectContaining({ kind: 'gate.pr' })]) } });
    expect(evs.filter((e) => e.kind === 'approval.requested')).toHaveLength(1);
    expect(evs.some((e) => e.kind === 'review.passed')).toBe(true);
    const sha = (evs.find((e) => e.kind === 'commit.recorded')!.payload as { sha: string }).sha;
    expect((held.payload as { sha?: string }).sha).toBe(sha);
    const payload = JSON.stringify({ hook_event_name: 'Stop', cwd: dir });
    expect((await cli(dir, ['hook', 'stop'], { stdin: payload })).code).toBe(2);
    expect((await cli(dir, ['approve', (held.payload as { requestId: string }).requestId], { env })).code).toBe(0);
    const resumed = await cli(dir, ['run', '--resume', runId], { env });
    expect(resumed.code, resumed.out + resumed.err).toBe(0);
    evs = await events(dir);
    expect(evs.find((e) => e.kind === 'pr.requested')!.payload).toMatchObject({ sha, branch: 'tecera/fix-failing-test' });
    expect((evs.find((e) => e.kind === 'goal.achieved')!.payload as { proof: unknown }).proof).toMatchObject({ command: 'node --test', exitCode: 0 });
    const after = await cli(dir, ['hook', 'stop'], { stdin: payload });
    expect(after.code, after.err).toBe(0);
    expect(after.out).toMatch(/proved its goal/);
  }, 900_000);
});
