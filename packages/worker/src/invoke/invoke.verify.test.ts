import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newIntention, type CapabilitySet, type Effect, type Hook, type JsonObject, type Plan, type SpanEvent, type Tool, type ToolResult, type VerifyRunner, type WorkerStepRequest } from '@tecera/contracts';
import { Broker } from '../broker/broker.js';
import { createEditTool } from '../tools/edit.js';
import { createReadTool } from '../tools/read.js';
import { createRunVerifyTool } from '../tools/runVerify.js';
import { STANDARD_STUBS, workerSystemPrompt } from '../protocol/prompts.js';
import { FakeLedger, FakeLLM, FakeRepl, liveWriteGuard } from './fakes.js';
import { invoke, RETURN_REFUSALS, type TurnedOutcome } from './invoke.js';
import { StepWorker } from './stepWorker.js';

/**
 * The verify precondition on returns: a program of a step that changed files may return only after
 * runVerify passed since its last edit, as the broker recorded the tools. The decision is host-owned
 * (nothing the program returns counts), covers every completion route, survives a resume, is capped, and
 * never loosens the iteration backstop.
 */

const js = (body: string): string => `\`\`\`js\n${body}\n\`\`\``;
const caps = (tools: string[] = ['read', 'edit', 'runVerify']): CapabilitySet => ({ tools, paths: { read: ['**'], write: ['src/**'], protected: ['test/**'] }, network: 'none', limits: { usd: 1, tokens: 100_000, calls: 50, wallMs: 60_000, depth: 3, iterations: 8 } });
const output: JsonObject = { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } };

let root: string;
let verifyRuns = 0;
/** Passes exactly when src/sum.js adds. */
const runner: VerifyRunner = {
  run: async (r) => {
    verifyRuns++;
    const pass = (await readFile(join(r.cwd, 'src/sum.js'), 'utf8')).includes('a + b');
    return { exitCode: pass ? 0 : 1, signal: null, timedOut: false, stdout: pass ? 'ok' : 'not ok 1 - sum', stderr: '', durationMs: 2, truncated: false };
  },
};
const tools = (): Tool[] => [createReadTool(), createEditTool(), createRunVerifyTool({ runner, command: 'node --test', timeoutSec: 30 })];

beforeEach(async () => {
  verifyRuns = 0;
  root = await mkdtemp(join(tmpdir(), 'tecera-verify-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/sum.js'), 'export const sum = (a, b) => a - b;\n');
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const BREAK = "await readFile('src/sum.js');\nawait writeFile({ path: 'src/sum.js', oldText: 'a - b', newText: 'a * b' });";
const FIX = "await writeFile({ path: 'src/sum.js', oldText: /a . b/.exec((await readFile('src/sum.js')).content)[0], newText: 'a + b' });";
/** The same fix with fixed arguments: on a resume the journal replays it instead of running it again. */
const FIX_PLAIN = "await readFile('src/sum.js');\nawait writeFile({ path: 'src/sum.js', oldText: 'a - b', newText: 'a + b' });";
const VERIFY = 'const v = await runVerify();';
const RETURN = "return { summary: 'done' };";

async function run(replies: string[], o: { verifyBeforeReturn?: boolean; hooks?: Hook[]; iterations?: number; ledger?: FakeLedger; toolSet?: string[] } = {}) {
  const ledger = o.ledger ?? new FakeLedger();
  const llm = new FakeLLM(replies);
  const c = caps(o.toolSet);
  if (o.iterations !== undefined) c.limits.iterations = o.iterations;
  const broker = new Broker({ tools: tools(), runId: 'run_v', worktree: root, capabilities: c, fencingToken: 1, guard: liveWriteGuard() });
  const out = (await invoke({}, { output, hooks: o.hooks ?? [], llm, repl: new FakeRepl(), broker, ledger, run: { runId: 'run_v', invokeId: 'inv_v', depth: 0 }, verifyBeforeReturn: o.verifyBeforeReturn ?? true })) as TurnedOutcome;
  const decisions = (await ledger.listEvidence('run_v', 'worker.return')).map((e) => (e.body as JsonObject).decision);
  return { out, llm, ledger, decisions, broker };
}

/** The result text the model saw in its n-th request (1-based), the latest turn's. */
const shown = (llm: FakeLLM, n: number): string => String(llm.requests[n - 1]!.messages[llm.requests[n - 1]!.messages.length - 1]!.content);

describe('the verify precondition on returns', () => {
  it('a return after a failing runVerify is refused with the reason and another turn; the fix, a passing runVerify and the return are then accepted', async () => {
    const { out, llm, decisions, ledger } = await run([js(`${BREAK}\n${VERIFY}\n${RETURN}`), js(`${FIX}\n${VERIFY}\n${RETURN}`)]);
    expect(out).toMatchObject({ kind: 'returned', value: { summary: 'done' }, turns: 2 });
    expect(llm.requests).toHaveLength(2);
    expect(shown(llm, 2)).toMatch(/VerifyRequired: this step changed files \(1 edit\(s\)\) and the last runVerify did not pass \(exit code 1\)/);
    expect(shown(llm, 2)).toMatch(/refused return 1 of 3/);
    expect(decisions).toEqual(['refused', 'accepted']);
    const refused = (await ledger.listEvidence('run_v', 'worker.return'))[0]!.body as JsonObject;
    expect(refused).toMatchObject({ decision: 'refused', route: 'return', turn: 1, edits: 1, editsSinceVerify: 1, lastVerify: { passed: false, why: 'exit code 1' }, refusals: 1 });
    expect(await readFile(join(root, 'src/sum.js'), 'utf8')).toContain('a + b');
    expect(verifyRuns).toBe(2);
  });

  it('a return without any runVerify is refused; so is a return after an edit that followed a passing runVerify', async () => {
    const none = await run([js(`${BREAK}\n${RETURN}`), js(`${FIX}\n${VERIFY}\n${RETURN}`)]);
    expect(none.out.kind).toBe('returned');
    expect(shown(none.llm, 2)).toMatch(/and runVerify was not run/);
    expect(none.decisions).toEqual(['refused', 'accepted']);

    await writeFile(join(root, 'src/sum.js'), 'export const sum = (a, b) => a - b;\n');
    const after = await run([js(`${FIX}\n${VERIFY}\n${BREAK.replace('a - b', 'a + b')}\n${RETURN}`), js(`${FIX}\n${VERIFY}\n${RETURN}`)]);
    expect(after.out.kind).toBe('returned');
    expect(shown(after.llm, 2)).toMatch(/1 edit\(s\) were made after runVerify last passed/);
    expect(after.decisions).toEqual(['refused', 'accepted']);
  });

  it("the program's own word counts for nothing: a return claiming passed, or one that swallowed the tool's result, is refused the same", async () => {
    const forged = await run([js(`${BREAK}\ntry { await runVerify(); } catch {}\nreturn { summary: 'done', passed: true, verified: true };`), js(`${FIX}\n${VERIFY}\n${RETURN}`)]);
    expect(forged.decisions).toEqual(['refused', 'accepted']);
    expect(forged.out).toMatchObject({ kind: 'returned', turns: 2 });
  });

  it('after RETURN_REFUSALS refused returns the next one is accepted as a fallback and recorded so: the gate decides', async () => {
    const prog = js(`${BREAK.replace("'a - b'", "(await readFile('src/sum.js')).content.includes('a - b') ? 'a - b' : 'a * b'").replace("'a * b'", "'a * b'")}\n${RETURN}`);
    // every turn edits (the first changes the operator, later ones rewrite the same text) and returns without a check
    const edit = js(`const c = (await readFile('src/sum.js')).content;\nawait writeFile('src/sum.js', c.includes('a - b') ? c.replace('a - b', 'a * b') : c + '// again\\n');\n${RETURN}`);
    void prog;
    const { out, decisions, llm } = await run([edit, edit, edit, edit, edit]);
    expect(out).toMatchObject({ kind: 'returned', value: { summary: 'done' }, turns: RETURN_REFUSALS + 1 });
    expect(decisions).toEqual(['refused', 'refused', 'refused', 'fallback']);
    expect(llm.requests).toHaveLength(RETURN_REFUSALS + 1);
    expect(shown(llm, RETURN_REFUSALS + 1)).toMatch(/refused return 3 of 3/);
    expect(verifyRuns).toBe(0);
  });

  it('the iteration backstop stays hard: refusals spend turns and never reset it', async () => {
    const edit = js(`const c = (await readFile('src/sum.js')).content;\nawait writeFile('src/sum.js', c + '// again\\n');\n${RETURN}`);
    const { out, decisions } = await run([edit, edit, edit], { iterations: 2 });
    expect(out).toMatchObject({ kind: 'aborted', reasons: [{ code: 'iterations' }] });
    expect(decisions).toEqual(['refused', 'refused']);
  });

  it('a step that changed nothing returns freely; so does an edit-and-return when the precondition was not set (an earlier writer) or runVerify is not among its tools', async () => {
    const read = await run([js(`const f = await readFile('src/sum.js');\nreturn { summary: f.path };`)]);
    expect(read.out).toMatchObject({ kind: 'returned', value: { summary: 'src/sum.js' }, turns: 1 });
    expect(read.decisions).toEqual([]);
    const notSet = await run([js(`${BREAK}\n${RETURN}`)], { verifyBeforeReturn: false });
    expect(notSet.out).toMatchObject({ kind: 'returned', turns: 1 });
    expect(notSet.decisions).toEqual([]);
    await writeFile(join(root, 'src/sum.js'), 'export const sum = (a, b) => a - b;\n');
    const noTool = await run([js(`${BREAK}\n${RETURN}`)], { toolSet: ['read', 'edit'] });
    expect(noTool.out).toMatchObject({ kind: 'returned', turns: 1 });
    expect(noTool.decisions).toEqual([]);
  });

  it('a pass is bound to the tree the check ran on: a check that rewrote a file did not pass, and a runner that throws leaves no earlier pass standing', async () => {
    // the check asserts, then rewrites the product file (Astra's probe): the first run reports no pass, naming the path
    let mutating = true;
    const sneaky: VerifyRunner = {
      run: async (r) => {
        verifyRuns++;
        if (mutating) {
          mutating = false;
          await writeFile(join(r.cwd, 'src/sum.js'), 'export const sum = () => 0;\n');
        }
        return { exitCode: 0, signal: null, timedOut: false, stdout: 'ok', stderr: '', durationMs: 2, truncated: false };
      },
    };
    const tools = [createReadTool(), createEditTool(), createRunVerifyTool({ runner: sneaky, command: 'node --test', timeoutSec: 30 })];
    const ledger = new FakeLedger();
    const llm = new FakeLLM([js(`${FIX}\nconst v = await runVerify();\nconsole.log(JSON.stringify([v.passed, v.why, v.treeChanged]));\n${RETURN}`), js(`await readFile('src/sum.js');\nawait writeFile('src/sum.js', 'export const sum = (a, b) => a + b;\\n');\n${VERIFY}\n${RETURN}`)]);
    const broker = new Broker({ tools, runId: 'run_v', worktree: root, capabilities: caps(), fencingToken: 1, guard: liveWriteGuard() });
    const out = await invoke({}, { output, hooks: [], llm, repl: new FakeRepl(), broker, ledger, run: { runId: 'run_v', invokeId: 'inv_v', depth: 0 }, verifyBeforeReturn: true });
    expect(out).toMatchObject({ kind: 'returned', turns: 2 });
    expect(shown(llm, 2)).toMatch(/\[false,"the check changed the tree \(src\/sum\.js\): no pass on a candidate it rewrote",\["src\/sum\.js"\]\]/);
    expect(shown(llm, 2)).toMatch(/VerifyRequired: .*the last runVerify did not pass \(the check changed the tree/);
    expect((await ledger.listEvidence('run_v', 'worker.return')).map((e) => (e.body as JsonObject).decision)).toEqual(['refused', 'accepted']);
    expect(await readFile(join(root, 'src/sum.js'), 'utf8')).toBe('export const sum = (a, b) => a + b;\n');

    // a pass, then a runner that throws: the earlier pass does not survive the failed run
    await writeFile(join(root, 'src/sum.js'), 'export const sum = (a, b) => a - b;\n');
    let calls = 0;
    const flaky: VerifyRunner = {
      run: async (r) => {
        if (++calls === 2) throw new Error('runner exploded');
        return runner.run(r, undefined as never);
      },
    };
    const t2 = [createReadTool(), createEditTool(), createRunVerifyTool({ runner: flaky, command: 'node --test', timeoutSec: 30 })];
    const llm2 = new FakeLLM([js(`${FIX}\n${VERIFY}\ntry { await runVerify(); } catch {}\n${RETURN}`), js(`${VERIFY}\n${RETURN}`)]);
    const b2 = new Broker({ tools: t2, runId: 'run_v', worktree: root, capabilities: caps(), fencingToken: 1, guard: liveWriteGuard() });
    const l2 = new FakeLedger();
    const out2 = await invoke({}, { output, hooks: [], llm: llm2, repl: new FakeRepl(), broker: b2, ledger: l2, run: { runId: 'run_v', invokeId: 'inv_v', depth: 0 }, verifyBeforeReturn: true });
    expect(out2).toMatchObject({ kind: 'returned', turns: 2 });
    expect(shown(llm2, 2)).toMatch(/the last runVerify did not pass \(the last runVerify did not complete\)/);
    expect((await l2.listEvidence('run_v', 'worker.return')).map((e) => (e.body as JsonObject).decision)).toEqual(['refused', 'accepted']);
    expect(calls).toBe(3);
  });

  it('a tree changed behind the tools\' back after the pass is not the candidate that passed: the return is refused until the check runs again', async () => {
    const touch: Hook = {
      id: 'toucher',
      mandatory: false,
      spans: new Set<SpanEvent['span']>(['REPLExec']),
      handle: (e): Effect[] => {
        if (e.stage === 'Exit' && (e.input as { execNo: number }).execNo === 1) writeFileSync(join(root, 'src/sum.js'), 'export const sum = (a, b) => a + b; // touched\n');
        return [];
      },
      describe: () => ({ id: 'toucher', mandatory: false, config: {} }),
    };
    // turn 1 fixes and passes, then only prints (no return); the tree is touched after the exec; turn 2 returns
    const { out, llm, decisions } = await run([js(`${FIX}\n${VERIFY}\nconsole.log('passed', v.passed);`), js(RETURN), js(`${VERIFY}\n${RETURN}`)], { hooks: [touch] });
    expect(out).toMatchObject({ kind: 'returned', turns: 3 });
    expect(shown(llm, 3)).toMatch(/VerifyRequired: .*the tree changed since runVerify passed on it/);
    expect(decisions).toEqual(['refused', 'accepted']);
    expect(verifyRuns).toBe(2);
  });

  it('a hook that replaces an exec output with a return goes through the same precondition', async () => {
    const replace: Hook = {
      id: 'replacer',
      mandatory: false,
      spans: new Set<SpanEvent['span']>(['REPLExec']),
      handle: (e): Effect[] => (e.stage === 'Send' && (e.input as { execNo: number }).execNo === 2 ? [{ type: 'ReplaceOutput', value: { kind: 'return', value: { summary: 'hooked' }, printed: '' } }] : []),
      describe: () => ({ id: 'replacer', mandatory: false, config: {} }),
    };
    const { out, decisions, llm } = await run([js(`${BREAK}\nconsole.log('edited');`), js('console.log("ignored");'), js(`${FIX}\n${VERIFY}\n${RETURN}`)], { hooks: [replace] });
    expect(out).toMatchObject({ kind: 'returned', value: { summary: 'done' } });
    expect(decisions).toEqual(['refused', 'accepted']);
    expect(shown(llm, 3)).toMatch(/VerifyRequired/);
  });
});

// ---------------------------------------------------------------- through the StepWorker: the request flag, resume, the Invoke-level ReplaceOutput route

const plan: Plan = {
  id: 'plan_v',
  trigger: { kind: 'goal.adopted' },
  context: [],
  steps: [{ id: 'edit', kind: 'worker', dependsOn: [], inputs: {}, instruction: 'fix sum', output }],
  allowedModels: { edit: ['cheap'] },
  permissions: { tools: ['read', 'edit', 'runVerify', 'notify'], write: ['src/**'], approvals: [] },
  budget: {},
  origin: 'generated',
  status: 'candidate',
  goalKinds: [],
};
const request = (over: Partial<WorkerStepRequest> = {}): WorkerStepRequest => ({
  runId: 'run_v',
  goal: { id: 'g', statement: 'fix sum', check: { command: 'node --test', timeoutSec: 30 }, commitment: 'single-minded', status: 'open', evidence: [] },
  plan,
  intention: newIntention({ id: 'i', goalId: 'g', plan, commitment: 'single-minded' }),
  step: plan.steps[0]!,
  seatId: 'cheap',
  inputs: {},
  capabilities: caps(['read', 'edit', 'runVerify', 'notify']),
  worktree: root,
  fencingToken: 3,
  guard: liveWriteGuard(),
  verifyBeforeReturn: true,
  ...over,
});
const notify: Tool = { name: 'notify', methods: ['call'], risk: 'irreversible', schema: {}, call: async (r): Promise<ToolResult> => ({ callId: r.callId, ok: true, value: 'ok', provenance: { src: 'tool:notify', trust: 'untrusted' }, truncated: false }) };
const holdNotify: Hook = {
  id: 'approvalGate',
  mandatory: true,
  spans: new Set<SpanEvent['span']>(['ToolCall']),
  handle: (e): Effect[] => {
    const i = e.input as { tool: string; actionHash: string };
    return e.stage === 'Send' && i.tool === 'notify' ? [{ type: 'Suspend', request: { requestId: `ap_${e.spanId}`, action: 'notify', actionHash: i.actionHash, reason: 'notify requires approval', requester: 'worker' } }] : [];
  },
  describe: () => ({ id: 'approvalGate', mandatory: true, config: {} }),
};

describe('the verify precondition through the StepWorker', () => {
  it('the request flag reaches the invoke; a step without it returns after an unchecked edit', async () => {
    const mk = (replies: string[]) => new StepWorker({ seats: { cheap: new FakeLLM(replies) }, repl: new FakeRepl(), tools: [createReadTool(), createEditTool()], hooks: [], verifyRunner: runner });
    const held = await mk([js(`${BREAK}\n${RETURN}`), js(`${FIX}\n${VERIFY}\n${RETURN}`)]).run(request());
    expect(held).toMatchObject({ kind: 'returned', turns: 2 });
    await writeFile(join(root, 'src/sum.js'), 'export const sum = (a, b) => a - b;\n');
    const free = await mk([js(`${BREAK}\n${RETURN}`)]).run(request({ verifyBeforeReturn: undefined }));
    expect(free).toMatchObject({ kind: 'returned', turns: 1 });
  });

  it('a pass before a suspension is carried through the checkpoint: the resumed return is accepted without running the check again', async () => {
    const ledger = new FakeLedger();
    const program = js(`${FIX_PLAIN}\n${VERIFY}\nawait notify('ops');\n${RETURN}`);
    const worker = new StepWorker({ seats: { cheap: new FakeLLM([program]) }, repl: new FakeRepl(), tools: [createReadTool(), createEditTool(), notify], hooks: [holdNotify], ledger, verifyRunner: runner, sessionId: 'sess', resumeLease: () => ({ worktree: root, fencingToken: 3 }) });
    const first = await worker.run(request());
    if (first.kind !== 'suspended') throw new Error(`expected suspended, got ${JSON.stringify(first)}`);
    expect(verifyRuns).toBe(1);
    const cp = (await ledger.loadCheckpoint(first.resumeToken)) as JsonObject;
    expect(cp.verify).toMatchObject({ edits: 1, editsSinceVerify: 0, lastVerify: { passed: true, candidate: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(cp.refusedReturns).toBe(0);
    // the record of what the step read and wrote travels with it
    const { sha256 } = await import('@tecera/contracts');
    expect(cp.known).toEqual([['src/sum.js', sha256(await readFile(join(root, 'src/sum.js'), 'utf8'))]]);
    const grant = await ledger.grantAudited(first.request.requestId, { kind: 'human', id: 'alice' }, 'sess', Date.now());
    const done = await worker.resume(first.resumeToken, grant, undefined, liveWriteGuard());
    expect(done, JSON.stringify(done)).toMatchObject({ kind: 'returned', value: { summary: 'done' } });
    expect(verifyRuns).toBe(1);
    expect((await ledger.listEvidence('run_v', 'worker.return')).map((e) => (e.body as JsonObject).decision)).toEqual(['accepted']);
  });

  it('a tree changed while the step was suspended is not the candidate the recorded pass names: the resumed return is refused until the check runs again', async () => {
    const ledger = new FakeLedger();
    const program = js(`${FIX_PLAIN}\n${VERIFY}\nawait notify('ops');\n${RETURN}`);
    const worker = new StepWorker({ seats: { cheap: new FakeLLM([program, js(`${VERIFY}\n${RETURN}`)]) }, repl: new FakeRepl(), tools: [createReadTool(), createEditTool(), notify], hooks: [holdNotify], ledger, verifyRunner: runner, sessionId: 'sess', resumeLease: () => ({ worktree: root, fencingToken: 3 }) });
    const first = await worker.run(request());
    if (first.kind !== 'suspended') throw new Error('expected suspended');
    expect(verifyRuns).toBe(1);
    // someone edits the product file while the approval is pending (the check still passes on it)
    await writeFile(join(root, 'src/sum.js'), 'export const sum = (a, b) => a + b; // touched while held\n');
    const grant = await ledger.grantAudited(first.request.requestId, { kind: 'human', id: 'alice' }, 'sess', Date.now());
    const done = await worker.resume(first.resumeToken, grant, undefined, liveWriteGuard());
    expect(done, JSON.stringify(done)).toMatchObject({ kind: 'returned', value: { summary: 'done' } });
    const records = (await ledger.listEvidence('run_v', 'worker.return')).map((e) => e.body as JsonObject);
    expect(records.map((r) => r.decision)).toEqual(['refused', 'accepted']);
    expect(records[0]!.reason).toMatch(/the tree changed since runVerify passed on it/);
    expect(verifyRuns).toBe(2);
  });

  it('what the step read and wrote before a suspension is remembered across the resume: a later edit of that file is not refused as unread', async () => {
    const ledger = new FakeLedger();
    // turn 1 reads (never replayed: a finished turn); turn 2 edits, is held, and edits the same file again once resumed
    const turn1 = js(`const f = await readFile('src/sum.js');\nconsole.log(f.bytes);`);
    const turn2 = js(`await writeFile({ path: 'src/sum.js', oldText: 'a - b', newText: 'a + b' });\nawait notify('ops');\nawait writeFile({ path: 'src/sum.js', oldText: 'a + b', newText: 'a + b + 0' });\n${VERIFY}\n${RETURN}`);
    const worker = new StepWorker({ seats: { cheap: new FakeLLM([turn1, turn2]) }, repl: new FakeRepl(), tools: [createReadTool(), createEditTool(), notify], hooks: [holdNotify], ledger, verifyRunner: runner, sessionId: 'sess', resumeLease: () => ({ worktree: root, fencingToken: 3 }) });
    const first = await worker.run(request());
    if (first.kind !== 'suspended') throw new Error(`expected suspended, got ${JSON.stringify(first)}`);
    const { sha256 } = await import('@tecera/contracts');
    expect(((await ledger.loadCheckpoint(first.resumeToken)) as JsonObject).known).toEqual([['src/sum.js', sha256('export const sum = (a, b) => a + b;\n')]]);
    const grant = await ledger.grantAudited(first.request.requestId, { kind: 'human', id: 'alice' }, 'sess', Date.now());
    const done = await worker.resume(first.resumeToken, grant, undefined, liveWriteGuard());
    expect(done, JSON.stringify(done)).toMatchObject({ kind: 'returned', value: { summary: 'done' }, turns: 2 });
    expect(await readFile(join(root, 'src/sum.js'), 'utf8')).toContain('a + b + 0');
    expect((await ledger.listEvidence('run_v', 'worker.return')).map((e) => (e.body as JsonObject).decision)).toEqual(['accepted']);
    expect(verifyRuns).toBe(1);
  });

  it('a checkpoint without a verify record restores as unknown: the resumed return is refused until the check passes', async () => {
    const ledger = new FakeLedger();
    const program = js(`${FIX_PLAIN}\n${VERIFY}\nawait notify('ops');\n${RETURN}`);
    const worker = new StepWorker({ seats: { cheap: new FakeLLM([program, js(`${VERIFY}\n${RETURN}`)]) }, repl: new FakeRepl(), tools: [createReadTool(), createEditTool(), notify], hooks: [holdNotify], ledger, verifyRunner: runner, sessionId: 'sess', resumeLease: () => ({ worktree: root, fencingToken: 3 }) });
    const first = await worker.run(request());
    if (first.kind !== 'suspended') throw new Error('expected suspended');
    // an older checkpoint: no verify state recorded
    const cp = (await ledger.loadCheckpoint(first.resumeToken)) as JsonObject;
    delete cp.verify;
    delete cp.refusedReturns;
    ledger.checkpoints.set(first.resumeToken, cp);
    const grant = await ledger.grantAudited(first.request.requestId, { kind: 'human', id: 'alice' }, 'sess', Date.now());
    const done = await worker.resume(first.resumeToken, grant, undefined, liveWriteGuard());
    expect(done).toMatchObject({ kind: 'returned', value: { summary: 'done' } });
    expect((await ledger.listEvidence('run_v', 'worker.return')).map((e) => (e.body as JsonObject).decision)).toEqual(['refused', 'accepted']);
    expect(verifyRuns).toBe(2);
  });

  it('an output a hook replaces at the invoke level while the precondition is unmet ends the step (no turn to repair it)', async () => {
    const ledger = new FakeLedger();
    const replaceOnResume: Hook = {
      id: 'replacer',
      mandatory: false,
      spans: new Set<SpanEvent['span']>(['Invoke']),
      handle: (e): Effect[] => (e.stage === 'Send' && (e.input as { resumed?: boolean }).resumed === true ? [{ type: 'ReplaceOutput', value: { summary: 'replaced' } }] : []),
      describe: () => ({ id: 'replacer', mandatory: false, config: {} }),
    };
    const program = js(`${BREAK}\nawait notify('ops');\n${RETURN}`);
    const worker = new StepWorker({ seats: { cheap: new FakeLLM([program]) }, repl: new FakeRepl(), tools: [createReadTool(), createEditTool(), notify], hooks: [holdNotify, replaceOnResume], ledger, verifyRunner: runner, sessionId: 'sess', resumeLease: () => ({ worktree: root, fencingToken: 3 }) });
    const first = await worker.run(request());
    if (first.kind !== 'suspended') throw new Error('expected suspended');
    const grant = await ledger.grantAudited(first.request.requestId, { kind: 'human', id: 'alice' }, 'sess', Date.now());
    const done = await worker.resume(first.resumeToken, grant, undefined, liveWriteGuard());
    expect(done.kind).toBe('aborted');
    if (done.kind === 'aborted') expect(done.reasons[0]).toMatchObject({ code: 'policy', reason: expect.stringMatching(/ReplaceOutput refused: VerifyRequired/) });
    expect((await ledger.listEvidence('run_v', 'worker.return')).map((e) => [(e.body as JsonObject).decision, (e.body as JsonObject).route])).toEqual([['refused', 'replaceOutput']]);
  });
});

describe('the stale-read check through the broker', () => {
  it('a file the program read, changed behind its back, cannot be edited until it is read again; its own edits keep it current', async () => {
    const turn1 = js(`const f = await readFile('src/sum.js');\nconsole.log(f.digest);`);
    const turn2 = js(`let m = 'edited';\ntry { await writeFile({ path: 'src/sum.js', oldText: 'a - b', newText: 'a + b' }); } catch (e) { m = e.message; }\nconsole.log(m);`);
    const turn3 = js(`await readFile('src/sum.js');\nawait writeFile({ path: 'src/sum.js', oldText: 'a - b', newText: 'a + b' });\nawait writeFile({ path: 'src/sum.js', oldText: 'a + b', newText: 'a + b + 0' });\n${VERIFY}\n${RETURN}`);
    const llm = new FakeLLM([turn1, turn2, turn3]);
    const broker = new Broker({ tools: tools(), runId: 'run_v', worktree: root, capabilities: caps(), fencingToken: 1, guard: liveWriteGuard() });
    const hook: Hook = {
      id: 'mutator',
      mandatory: false,
      spans: new Set<SpanEvent['span']>(['REPLExec']),
      handle: (e): Effect[] => {
        // someone else changes the file between the first and the second turn
        if (e.stage === 'Enter' && (e.input as { execNo: number }).execNo === 2) writeFileSync(join(root, 'src/sum.js'), 'export const sum = (a, b) => a - b; // touched\n');
        return [];
      },
      describe: () => ({ id: 'mutator', mandatory: false, config: {} }),
    };
    const out = await invoke({}, { output, hooks: [hook], llm, repl: new FakeRepl(), broker, ledger: new FakeLedger(), run: { runId: 'run_v', invokeId: 'inv_s', depth: 0 } });
    expect(out.kind).toBe('returned');
    expect(shown(llm, 3)).toMatch(/src\/sum\.js changed since this step last read or wrote it; read it again/);
    expect(await readFile(join(root, 'src/sum.js'), 'utf8')).toContain('a + b + 0');
  });
});

describe('the turns an outcome reports', () => {
  it('count the nested invokes too: a parent turn whose child takes two turns reports three', async () => {
    const parent = js(`const r = await invoke({}, { output: { type: 'object' } });\nreturn { summary: 'child: ' + JSON.stringify(r.value) };`);
    const { out, llm } = await run([parent, js(`console.log('thinking');`), js(`return { ok: true };`)], { verifyBeforeReturn: false });
    expect(out).toMatchObject({ kind: 'returned', value: { summary: 'child: {"ok":true}' }, turns: 3 });
    expect(llm.requests).toHaveLength(3);
  });
});

describe('what the worker is told about runVerify', () => {
  it('the stub names passed and why, and the system prompt carries the rule', () => {
    expect(STANDARD_STUBS.runVerify!.signature).toContain('{passed, why?, exitCode, timedOut, stdout, stderr');
    expect(STANDARD_STUBS.runVerify!.description).toMatch(/`passed` is true only when it exited 0/);
    expect(STANDARD_STUBS.runVerify!.description).toMatch(/never return on a failing result/);
    const prompt = workerSystemPrompt({ stubs: [STANDARD_STUBS.runVerify!], outputSchema: output });
    expect(prompt).toContain('the host refuses such a return');
    expect(prompt).not.toContain('{exitCode, timedOut, stdout, stderr}');
  });
});
