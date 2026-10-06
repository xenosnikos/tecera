import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approvalGrantedEvent, newIntention, type ApprovalGrant, type CapabilitySet, type Effect, type Hook, type Inputs, type JsonObject, type Plan, type Principal, type SpanEvent, type Tool, type WorkerStepRequest } from '@tecera/contracts';
import { SqliteLedger } from '@tecera/ledger';
import { Broker } from '../broker/broker.js';
import { createEditTool } from '../tools/edit.js';
import { createReadTool } from '../tools/read.js';
import { FakeLLM, FakeRepl, liveWriteGuard } from './fakes.js';
import { invoke, isTainted } from './invoke.js';
import { StepWorker } from './stepWorker.js';

/**
 * Production SqliteLedger coverage (Codex sprint-3 invoke Missing tests):
 *  - grant consumption followed by a checkpoint failure, then a RESTART (a new ledger connection and a new
 *    worker): the consumed grant cannot be re-presented and nothing was written;
 *  - durable quarantine across a REAL process restart while an orphan writer is still running in the
 *    worktree: the new process refuses the worktree before any model call (the in-memory taint registry of
 *    the new process knows nothing; only the ledger's exec.tainted evidence does).
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '../..');
const WORKER_DIST = join(pkg, 'dist');
const LEDGER_DIST = resolve(pkg, '../ledger/dist/index.js');
const CONTRACTS_DIST = resolve(pkg, '../contracts/dist/index.js');

const caps = (): CapabilitySet => ({ tools: ['read', 'edit', 'slow'], paths: { read: ['**'], write: ['src/**'], protected: ['test/**'] }, network: 'none', limits: { usd: 1, tokens: 100_000, calls: 50, wallMs: 60_000, depth: 3, iterations: 10 } });
const js = (body: string): string => `\`\`\`js\n${body}\n\`\`\``;
const human: Principal = { kind: 'human', id: 'alice' };
const allEdits: Hook = {
  id: 'approvalGate',
  mandatory: false,
  spans: new Set<SpanEvent['span']>(['ToolCall']),
  handle: (e): Effect[] => {
    const i = e.input as { tool: string; actionHash: string };
    return e.stage === 'Send' && i.tool === 'edit' ? [{ type: 'Suspend', request: { requestId: `ap_${e.spanId}`, action: 'edit', actionHash: i.actionHash, reason: 'edit requires approval', requester: 'worker' } }] : [];
  },
  describe: () => ({ id: 'approvalGate', mandatory: false, config: {} }),
};
const plan: Plan = {
  id: 'plan_s',
  trigger: { kind: 'goal.adopted' },
  context: [],
  steps: [{ id: 'edit', kind: 'worker', dependsOn: [], inputs: {}, instruction: 'write', output: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } } }],
  allowedModels: { edit: ['cheap'] },
  permissions: { tools: ['read', 'edit'], write: ['src/**'], approvals: [] },
  budget: {},
  origin: 'generated',
  status: 'candidate',
  goalKinds: [],
};

let root: string;
let dir: string;
const orphans: ChildProcess[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tecera-sqlite-rec-'));
  root = join(dir, 'wt');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
});
afterEach(async () => {
  for (const o of orphans.splice(0)) {
    try {
      if (o.pid) process.kill(o.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await rm(dir, { recursive: true, force: true });
});

const request = (runId: string): WorkerStepRequest => ({
  runId,
  goal: { id: 'g', statement: 's', check: { command: 'node --test', timeoutSec: 5 }, commitment: 'single-minded', status: 'open', evidence: [] },
  plan,
  intention: newIntention({ id: 'i_s', goalId: 'g', plan, commitment: 'single-minded' }),
  step: plan.steps[0]!,
  seatId: 'cheap',
  inputs: {},
  capabilities: caps(),
  worktree: root,
  fencingToken: 4,
  guard: liveWriteGuard(),
});

async function grantAudited(ledger: SqliteLedger, requestId: string, sessionId: string): Promise<ApprovalGrant> {
  const view = await ledger.getApproval(requestId);
  const at = Date.now();
  return ledger.approve(requestId, human, sessionId, at, approvalGrantedEvent({ id: randomUUID(), at, requestId, runId: view!.runId, sessionId, actionHash: view!.actionHash, approver: human, trace: { goalId: 'g', intentionId: 'i_s', stepId: 'edit' } }));
}

describe('SqliteLedger: grant consumption, checkpoint failure and restart', () => {
  it('a grant consumed before the partial-approval checkpoint failed cannot be re-presented after a restart; nothing was written', async () => {
    const db = join(dir, 'ledger.db');
    const program = js(`await Promise.all([writeFile('src/x.ts', 'X'), writeFile('src/y.ts', 'Y')]);\nreturn { summary: 'both' };`);
    const mk = (ledger: SqliteLedger) => new StepWorker({ seats: { cheap: new FakeLLM([program]) }, repl: new FakeRepl(), tools: [createReadTool(), createEditTool()], hooks: [allEdits], ledger, sessionId: 'sess', resumeLease: () => ({ worktree: root, fencingToken: 5 }) });

    const ledger1 = new SqliteLedger(db);
    const first = await mk(ledger1).run(request('run_sq'));
    if (first.kind !== 'suspended') throw new Error(`expected suspended, got ${JSON.stringify(first)}`);
    const g1 = await grantAudited(ledger1, first.request.requestId, 'sess');
    const realCheckpoint = ledger1.checkpoint.bind(ledger1);
    ledger1.checkpoint = async (runId: string, key: string, state: JsonObject) => {
      if (key.includes(':granted:')) throw new Error('disk full');
      return realCheckpoint(runId, key, state);
    };
    const r1 = await mk(ledger1).resume(first.resumeToken, g1, undefined, liveWriteGuard());
    expect(r1).toMatchObject({ kind: 'aborted', reasons: [{ code: 'ledger', reason: expect.stringMatching(/partial approval not recorded/) }] });
    expect((await ledger1.getApproval(first.request.requestId))?.state).toBe('consumed');
    ledger1.close();

    // restart: a new connection to the same file and a new worker
    const ledger2 = new SqliteLedger(db);
    try {
      const r2 = await mk(ledger2).resume(first.resumeToken, g1, undefined, liveWriteGuard());
      expect(r2).toMatchObject({ kind: 'aborted', reasons: [{ code: 'policy', reason: expect.stringMatching(/consumed/) }] });
      expect((await ledger2.getApproval(first.request.requestId))?.state).toBe('consumed');
      await expect(stat(join(root, 'src/x.ts'))).rejects.toThrow();
      await expect(stat(join(root, 'src/y.ts'))).rejects.toThrow();
      expect((await ledger2.verifyChain()).ok).toBe(true);
    } finally {
      ledger2.close();
    }
  });
});

describe('durable quarantine across a real process restart with an orphan writer still running', () => {
  it('the restarted process refuses the quarantined worktree before any model call; the orphan is still writing', async () => {
    expect(existsSync(join(WORKER_DIST, 'invoke/stepWorker.js')), 'build the worker first (tsc -p tsconfig.invoke.json)').toBe(true);
    const db = join(dir, 'ledger.db');
    const log = join(root, 'src/orphan.log');
    let orphan: ChildProcess | undefined;
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    // A writer that starts an orphan process writing into the worktree and never resolves within the drain.
    const slow: Tool = {
      name: 'slow',
      methods: ['call'],
      risk: 'write',
      schema: {},
      call: async (req) => {
        orphan = spawn(process.execPath, ['-e', `const fs = require('node:fs'); setInterval(() => fs.appendFileSync(${JSON.stringify(log)}, 'x'), 15);`], { detached: true, stdio: 'ignore' });
        orphans.push(orphan);
        orphan.unref();
        await released;
        return { callId: req.callId, ok: true, value: 1, provenance: { src: 'tool:slow', trust: 'untrusted' }, truncated: false };
      },
    };
    const ledgerA = new SqliteLedger(db);
    const goal: Inputs = { goal: { kind: 'value', value: { statement: 's' }, provenance: { src: 'goal', trust: 'trusted' } } };
    const broker = new Broker({ tools: [createEditTool(), slow], runId: 'run_rs', worktree: root, capabilities: caps(), fencingToken: 3, drainMs: 50, guard: liveWriteGuard() });
    const out = await invoke(goal, { output: { type: 'object' }, hooks: [], llm: new FakeLLM([js(`slow().catch(() => null);\nawait new Promise((r) => setTimeout(r, 20));\nreturn { summary: 'x' };`)]), repl: new FakeRepl(), broker, ledger: ledgerA, run: { runId: 'run_rs', invokeId: 'inv_rs', depth: 0 } });
    expect(isTainted(out), JSON.stringify(out)).toBe(true);
    expect((await ledgerA.listEvidence('run_rs', 'exec.tainted')).length).toBeGreaterThan(0);
    ledgerA.close();
    expect(orphan?.pid).toBeDefined();

    // A NEW process (empty in-memory taint registry) resumes work on the same worktree with the same ledger.
    const script = `
      const { StepWorker } = await import(process.env.T_WORKER + '/invoke/stepWorker.js');
      const { FakeLLM, FakeRepl, liveWriteGuard } = await import(process.env.T_WORKER + '/invoke/fakes.js');
      const { createEditTool } = await import(process.env.T_WORKER + '/tools/edit.js');
      const { worktreeTaint } = await import(process.env.T_WORKER + '/tools/paths.js');
      const { SqliteLedger } = await import(process.env.T_LEDGER);
      const { newIntention } = await import(process.env.T_CONTRACTS);
      const req = JSON.parse(process.env.T_REQ);
      const fence = '\\u0060\\u0060\\u0060';
      const llm = new FakeLLM([fence + 'js\\nawait writeFile("src/a.ts", "overwritten after restart");\\nreturn { summary: "ran" };\\n' + fence]);
      const ledger = new SqliteLedger(process.env.T_DB);
      const known = worktreeTaint(req.worktree);
      const w = new StepWorker({ seats: { cheap: llm }, repl: new FakeRepl(), tools: [createEditTool()], hooks: [], ledger, sessionId: 'sess' });
      const out = await w.run({ ...req, intention: newIntention({ id: 'i_s', goalId: 'g', plan: req.plan, commitment: 'single-minded' }), guard: liveWriteGuard() });
      ledger.close();
      process.stdout.write(JSON.stringify({ out, calls: llm.requests.length, knownInMemory: known }));
    `;
    const { guard: _g, intention: _i, ...plain } = request('run_rs');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: process.env.PATH ?? '', T_WORKER: pathToFileURL(WORKER_DIST).href, T_LEDGER: pathToFileURL(LEDGER_DIST).href, T_CONTRACTS: pathToFileURL(CONTRACTS_DIST).href, T_DB: db, T_REQ: JSON.stringify(plain) },
    });
    expect(child.status, child.stderr).toBe(0);
    const res = JSON.parse(child.stdout) as { out: { kind: string; reasons?: Array<{ reason: string; hookId: string }>; tainted?: unknown }; calls: number; knownInMemory: string | null };
    expect(res.knownInMemory).toBeNull(); // the new process learned it only from the ledger
    expect(res.out.kind).toBe('aborted');
    expect(res.out.tainted).toBeDefined();
    expect(res.out.reasons?.[0]).toMatchObject({ hookId: 'quarantine', reason: expect.stringMatching(/earlier exec/) });
    expect(res.calls).toBe(0);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    // the orphan is still alive and still writing: the refusal did not depend on it having stopped
    expect(() => process.kill(orphan!.pid!, 0)).not.toThrow();
    const before = (await stat(log)).size;
    await new Promise((r) => setTimeout(r, 80));
    expect((await stat(log)).size).toBeGreaterThan(before);
    release();
  }, 90_000);
});
