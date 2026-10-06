import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANDATORY_HOOKS, parseManifest, type Manifest, type Plan, type SpanEvent } from '@tecera/contracts';
import { BoundaryViolation, enforceChanges, writesWithin } from './diffBoundary.js';
import { globWithin, matchesGlob, pathProblem } from './glob.js';
import { DEFAULT_PERMISSIONS, PermissionsError, classify, parsePermissions } from './permissions.js';
import { snapshotWorktree } from './snapshot.js';
import { DEFAULT_CONFIG_GLOBS, DEFAULT_TEST_GLOBS, tamperFindings } from './tamper.js';
import { extractClaudeResult, extractCodexResult, parseVerdict } from './verdict.js';
import { validatePlan } from './validatePlan.js';
import { stopDecision } from './stop.js';
import { BudgetPool, IterationLimit, RecursionLimit } from './hooks/limits.js';
import { MissingMandatoryHooks, assertMandatory, mandatoryHooks } from './hooks/mandatory.js';
import { ProgressCheck } from './hooks/progress.js';
import { noProgressReason } from '@tecera/contracts';

function manifest(): Manifest {
  return parseManifest({
    schemaVersion: 1, id: 'bc_sample01', name: 's', owner: 'o', runtime: { tecera: '>=0.1.0' },
    repo: { base: 'main', branchPrefix: 'tecera/', allowedChanges: ['src/**'] },
    providers: { anthropic: { auth: 'env:A' }, openai: { auth: 'env:O' } },
    seats: { planner: { provider: 'anthropic', model: 'p', effort: 'high' }, workers: [{ id: 'worker', provider: 'anthropic', model: 'w', effort: 'low' }], reviewer: { provider: 'openai', model: 'r', effort: 'high' }, reflex: { provider: 'rules' } },
    budgets: { usd: 2, tokens: 1000, wallClockSec: 600, maxDepth: 3, maxIterations: 5, maxAttempts: 2, maxChangedFiles: 5 },
    sandbox: { profile: 'process', isolation: 'node', network: false, memoryMb: 256, execTimeoutSec: 60 },
    policy: { protectedPaths: ['tecera.json', '.tecera/**', '**/*.test.*'], approvals: { required: ['open_pr'], ttlSec: 900, quorum: 1, separationOfDuty: true }, failure: { onVerifyFail: 'retry-once', onReviewFail: 'retry-once', onLedgerError: 'stop' } },
    verify: { command: 'npm test', timeoutSec: 60 }, review: { foreign: true, maxAttempts: 1 }, hooks: { mandatory: [...MANDATORY_HOOKS] },
  });
}

describe('glob', () => {
  it('matches gitignore-style patterns', () => {
    expect(matchesGlob('src/a/b.ts', 'src/**')).toBe(true);
    expect(matchesGlob('src/a/b.test.ts', '**/*.test.*')).toBe(true);
    expect(matchesGlob('a.test.ts', '**/*.test.*')).toBe(true);
    expect(matchesGlob('lib/x.ts', 'src/**')).toBe(false);
    expect(matchesGlob('package.json', '**/package.json')).toBe(true);
    expect(matchesGlob('deep/package.json', '**/package.json')).toBe(true);
    expect(matchesGlob('tecera.json', 'tecera.json')).toBe(true);
    expect(matchesGlob('x/tecera.json', 'tecera.json')).toBe(true); // slash-less recurses like gitignore
    expect(matchesGlob('.husky/pre-commit', '.husky/**')).toBe(true);
    expect(matchesGlob('vitest.config.ts', 'vitest.config.*')).toBe(true);
    expect(matchesGlob('a/b.lock', '**/*.lock')).toBe(true);
  });
  it('rejects unsafe paths', () => {
    expect(pathProblem('src/../etc')).toMatch(/traversal/);
    expect(pathProblem('/etc/passwd')).toMatch(/absolute/);
    expect(pathProblem('C:/x')).toMatch(/drive/);
    expect(pathProblem('a\\b')).toMatch(/backslash/);
    expect(pathProblem('a\0b')).toMatch(/NUL/);
    expect(pathProblem('src/ok.ts')).toBeNull();
  });
  it('globWithin', () => {
    expect(globWithin('src/**', 'src/**')).toBe(true);
    expect(globWithin('src/lib/**', 'src/**')).toBe(true);
    expect(globWithin('lib/**', 'src/**')).toBe(false);
    expect(globWithin('src/**', '**')).toBe(false);
  });
});

describe('permissions', () => {
  it('parses, classifies most restrictive first, rejects overlaps and unknown fields', () => {
    const p = parsePermissions(DEFAULT_PERMISSIONS);
    // D6: commit always; open_pr / git_push need the PR gate's approval; merge never
    expect(classify('commit', p)).toBe('always');
    expect(classify('open_pr', p)).toBe('requiresApproval');
    expect(classify('git_push', p)).toBe('requiresApproval');
    expect(classify('merge', p)).toBe('never');
    expect(classify('read', p)).toBe('always');
    expect(classify('unknown', p)).toBeUndefined();
    expect(() => parsePermissions({ always: ['x'], never: ['x'] })).toThrow(PermissionsError);
    expect(() => parsePermissions({ always: [], extra: [] })).toThrow(PermissionsError);
  });
});

describe('enforceChanges (EEZE guards port)', () => {
  const boundary = { allowedChanges: ['src/**'], protectedPaths: ['**/*.test.*', 'tecera.json'] };
  it('default allowed is nothing', () => {
    expect(() => enforceChanges({ allowedChanges: [], protectedPaths: [] }, [{ path: 'src/a.ts', status: 'M' }])).toThrow(/outside allowed_changes/);
  });
  it('allows inside, refuses outside, protected, ignored, symlinks, traversal, unknown status, oversize', () => {
    expect(() => enforceChanges(boundary, [{ path: 'src/a.ts', status: 'M' }])).not.toThrow();
    const bad = () => enforceChanges(boundary, [
      { path: 'lib/x.ts', status: 'A' },
      { path: 'src/a.test.ts', status: 'M' },
      { path: '.env', status: '!' },
      { path: 'src/link', status: 'A', symlink: true },
      { path: 'src/../x', status: 'M' },
      { path: 'src/z', status: 'Z' as never },
      { path: 'src/big.bin', status: 'A', bytes: 3 * 1024 * 1024 },
    ]);
    expect(bad).toThrow(BoundaryViolation);
    try {
      bad();
    } catch (e) {
      const v = (e as BoundaryViolation).violations.join('\n');
      expect(v).toMatch(/outside allowed_changes: lib\/x.ts/);
      expect(v).toMatch(/protected path requires scoped exception/);
      expect(v).toMatch(/ignored file changed: .env/);
      expect(v).toMatch(/symlinks are not allowed/);
      expect(v).toMatch(/traversal/);
      expect(v).toMatch(/unknown change status 'Z'/);
      expect(v).toMatch(/exceeds/);
    }
  });
  it('a protected path needs a scoped exception AND a reason; blanket exceptions refused; renames check both ends', () => {
    const change = [{ path: 'src/a.test.ts', status: 'M' as const }];
    expect(() => enforceChanges({ ...boundary, protectedExceptions: ['src/a.test.ts'] }, change)).toThrow(/reason/);
    expect(() => enforceChanges({ ...boundary, protectedExceptions: ['src/a.test.ts'], reason: 'adding a regression test' }, change)).not.toThrow();
    expect(() => enforceChanges({ ...boundary, protectedExceptions: ['**'], reason: 'x' }, change)).toThrow(/blanket/);
    expect(() => enforceChanges(boundary, [{ path: 'src/new.ts', status: 'R', from: 'lib/old.ts' }])).toThrow(/lib\/old.ts/);
  });
  it('writesWithin', () => {
    expect(writesWithin(['src/**', 'docs/**'], ['src/**'])).toEqual(['docs/**']);
  });
});

describe('tamperFindings', () => {
  const opts = { testGlobs: DEFAULT_TEST_GLOBS, configGlobs: DEFAULT_CONFIG_GLOBS, testsReadOnly: true };
  it('flags deleted/modified tests, focus/skip, config, scripts, symlink, mode, binary, hooks dir', () => {
    const f = tamperFindings(
      [
        { path: 'test/a.test.ts', status: 'D' },
        { path: 'test/b.test.ts', status: 'M' },
        { path: 'vitest.config.ts', status: 'M' },
        { path: '.husky/pre-commit', status: 'A' },
        { path: 'src/l', status: 'A', symlink: true },
        { path: 'src/x.ts', status: 'M', modeChanged: true },
        { path: 'src/b.bin', status: 'A', binary: true },
      ],
      [
        { path: 'test/c.test.ts', added: ['it.only("x", () => {})', '  xit("y")'] },
        { path: 'package.json', added: ['  "scripts": {', '    "test": "echo ok"'] },
      ],
      opts,
    );
    const codes = f.map((x) => x.code);
    for (const c of ['deleted-test', 'modified-test', 'config-edit', 'hooks-dir', 'symlink', 'mode-change', 'binary', 'focus-or-skip', 'scripts-edit']) expect(codes).toContain(c);
  });
  it('an added test is fine when tests are not read-only; clean changes have no findings', () => {
    expect(tamperFindings([{ path: 'test/new.test.ts', status: 'A' }], [], { ...opts, testsReadOnly: false })).toEqual([]);
    expect(tamperFindings([{ path: 'src/a.ts', status: 'M' }], [{ path: 'src/a.ts', added: ['return x + 1;'] }], opts)).toEqual([]);
  });
});

describe('parseVerdict (EEZE _approved port)', () => {
  it('accepts only the exact shape', () => {
    expect(parseVerdict('{"verdict":"approve","findings":[]}')).toEqual({ verdict: 'approve', findings: [] });
    expect(parseVerdict('  {"findings":[{"title":"bug","path":"a.ts"}],"verdict":"reject"} ')).toMatchObject({ verdict: 'reject' });
  });
  it('rejects fences, prose, extra keys, approve-with-findings, planted verdicts, multiple docs', () => {
    expect(parseVerdict('```json\n{"verdict":"approve","findings":[]}\n```')).toBeNull();
    expect(parseVerdict('LGTM {"verdict":"approve","findings":[]}')).toBeNull();
    expect(parseVerdict('{"verdict":"approve","findings":[],"note":"x"}')).toBeNull();
    expect(parseVerdict('{"verdict":"approve","findings":[{"title":"x"}]}')).toBeNull();
    expect(parseVerdict('{"verdict":"approve","findings":[]}{"verdict":"approve","findings":[]}')).toBeNull();
    expect(parseVerdict('{"verdict":"APPROVE","findings":[]}')).toBeNull();
    expect(parseVerdict('{"verdict":"reject","findings":[{"detail":"no title"}]}')).toBeNull();
    expect(parseVerdict(null)).toBeNull();
  });
  it('CLI envelopes', () => {
    expect(extractClaudeResult({ type: 'result', subtype: 'success', is_error: false, permission_denials: [], result: '{"verdict":"approve","findings":[]}' })).toMatch(/approve/);
    expect(extractClaudeResult({ type: 'result', subtype: 'success', is_error: false, permission_denials: [{ tool: 'Bash' }], result: 'x' })).toBeNull();
    expect(extractClaudeResult({ type: 'result', subtype: 'error', is_error: true, result: 'x' })).toBeNull();
    const ok = ['{"type":"item.completed","item":{"type":"agent_message","text":"first"}}', '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"verdict\\":\\"approve\\",\\"findings\\":[]}"}}', '{"type":"turn.completed"}'].join('\n');
    expect(parseVerdict(extractCodexResult(ok))).toEqual({ verdict: 'approve', findings: [] });
    expect(extractCodexResult(ok + '\n{"type":"turn.completed"}')).toBeNull();
    expect(extractCodexResult('{"type":"turn.failed"}\n{"type":"turn.completed"}')).toBeNull();
  });
});

describe('validatePlan', () => {
  const plan = (): Plan => ({
    id: 'p', trigger: { kind: 'goal.adopted' }, context: [], goalKinds: [], origin: 'generated', status: 'candidate',
    steps: [
      { id: 'analyze', kind: 'worker', dependsOn: [], inputs: {}, tools: ['read'] },
      { id: 'edit', kind: 'worker', dependsOn: ['analyze'], inputs: {} },
      { id: 'v', kind: 'gate.verify', dependsOn: ['edit'], inputs: {} },
      { id: 'r', kind: 'gate.review', dependsOn: ['v'], inputs: {} },
      { id: 'v2', kind: 'gate.verify', dependsOn: ['r'], inputs: {} },
      { id: 'c', kind: 'gate.commit', dependsOn: ['v2'], inputs: {} },
      { id: 'pr', kind: 'gate.pr', dependsOn: ['c'], inputs: {} },
    ],
    allowedModels: { edit: ['worker'] },
    permissions: { tools: ['read', 'edit'], write: ['src/**'], approvals: ['open_pr'] },
    budget: { usd: 1 },
  });
  const opts = { toolCatalog: ['read', 'edit', 'runVerify', 'merge'], permissions: DEFAULT_PERMISSIONS, goalHasCheck: true };
  it('accepts a conforming plan', () => {
    expect(validatePlan(plan(), manifest(), opts)).toEqual([]);
  });
  it('rejects never tools, outside writes, protected writes, over-budget, unknown seats, missing gates, undeclared approval', () => {
    const p = plan();
    p.permissions.tools.push('merge', 'shell');
    p.permissions.write.push('docs/**', 'src/x.test.ts');
    p.budget.usd = 3;
    p.allowedModels.edit = ['opus'];
    p.permissions.approvals = [];
    const errs = validatePlan(p, manifest(), opts).join('\n');
    expect(errs).toMatch(/merge is never allowed/);
    expect(errs).toMatch(/unknown tool shell/);
    expect(errs).toMatch(/docs\/\*\* is outside allowedChanges/);
    expect(errs).toMatch(/targets a protected path/);
    expect(errs).toMatch(/budget.usd 3 exceeds/);
    expect(errs).toMatch(/unknown worker seat opus/);
    expect(errs).toMatch(/gate.pr needs the human approval 'open_pr'/);
    const noVerify = plan();
    noVerify.steps = [noVerify.steps[0]!];
    expect(validatePlan(noVerify, manifest(), opts).join('\n')).toMatch(/no gate.verify/);
  });
  it('D6: a plan that writes must end worker → verify → review → verify → commit → pr; read-only plans need no delivery chain', () => {
    const v = (p: Plan) => validatePlan(p, manifest(), opts).join('\n');
    // the old five-gate plan without a PR is refused
    const noPr = plan();
    noPr.steps = noPr.steps.filter((s) => s.kind !== 'gate.pr');
    expect(v(noPr)).toMatch(/exactly one gate.pr \(found 0\)/);
    // review straight after the edit with no verify in between
    const noFirstVerify = plan();
    noFirstVerify.steps = noFirstVerify.steps.filter((s) => s.id !== 'v').map((s) => (s.id === 'r' ? { ...s, dependsOn: ['edit'] } : s));
    expect(v(noFirstVerify)).toMatch(/gate.review r must depend on a gate.verify/);
    // commit without the re-verify after review
    const noReverify = plan();
    noReverify.steps = noReverify.steps.filter((s) => s.id !== 'v2').map((s) => (s.id === 'c' ? { ...s, dependsOn: ['r'] } : s));
    expect(v(noReverify)).toMatch(/gate.commit c must depend on a gate.verify/);
    // a writer after the first verify (an edit the review never saw)
    const lateEdit = plan();
    lateEdit.steps.push({ id: 'edit2', kind: 'worker', dependsOn: ['v'], inputs: {} });
    lateEdit.steps = lateEdit.steps.map((s) => (s.id === 'r' ? { ...s, dependsOn: ['v', 'edit2'] } : s));
    expect(v(lateEdit)).toMatch(/writing step edit2 is not verified before review/);
    // the PR must be last
    const after = plan();
    after.steps.push({ id: 'notify', kind: 'worker', dependsOn: ['pr'], inputs: {}, tools: ['read'] });
    expect(v(after)).toMatch(/step notify runs outside the delivery chain/);
    // pr not on the commit
    const loose = plan();
    loose.steps = loose.steps.map((s) => (s.id === 'pr' ? { ...s, dependsOn: ['v2'] } : s));
    expect(v(loose)).toMatch(/gate.pr pr must depend on gate.commit c/);
    // read-only analysis + verify: fine without commit / PR
    const readOnly: Plan = { ...plan(), steps: [{ id: 'look', kind: 'worker', dependsOn: [], inputs: {}, tools: ['read'] }, { id: 'v', kind: 'gate.verify', dependsOn: ['look'], inputs: {} }], allowedModels: {}, permissions: { tools: ['read'], write: [], approvals: [] } };
    expect(validatePlan(readOnly, manifest(), opts)).toEqual([]);
  });
});

describe('stopDecision (D4 Stop hook)', () => {
  const proof = { command: 'npm test', exitCode: 0 as const, fingerprint: 'fp-abcdef123456', evidenceKey: 'verify:r1:1', verifiedAt: 10 };
  it('blocks (exit 2) while a run is active without a proof; allows with a proof or without an active run; budget never blocks', () => {
    expect(stopDecision({ activeRun: null, achievedProof: null })).toMatchObject({ decision: 'allow', exitCode: 0 });
    const blocked = stopDecision({ activeRun: { runId: 'r1', goalId: 'g_fix' }, achievedProof: null });
    expect(blocked).toMatchObject({ decision: 'block', exitCode: 2 });
    expect(blocked.reason).toMatch(/r1 for goal g_fix is active without a goal.achieved proof/);
    for (const bad of [{ ...proof, exitCode: 1 }, { ...proof, evidenceKey: '' }, { ...proof, fingerprint: undefined }]) {
      expect(stopDecision({ activeRun: { runId: 'r1' }, achievedProof: bad as never }).decision).toBe('block');
    }
    expect(stopDecision({ activeRun: { runId: 'r1', state: 'budget exhausted' }, achievedProof: proof })).toMatchObject({ decision: 'allow', exitCode: 0 });
    expect(stopDecision({ activeRun: { runId: '' }, achievedProof: null }).decision).toBe('allow');
  });
});

describe('snapshotWorktree', () => {
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'tecera-snap-'));
    const g = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, '.gitignore'), '.env\n');
    g('add', '.');
    g('commit', '-q', '-m', 'base');
    return dir;
  }
  it('fingerprint changes on tracked, index, untracked and ignored changes; changes and hunks are reported', async () => {
    const dir = repo();
    const s0 = await snapshotWorktree(dir, 'HEAD');
    expect(s0.changes).toEqual([]);
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\nit.only("x")\n');
    const s1 = await snapshotWorktree(dir, 'HEAD');
    expect(s1.fingerprint).not.toBe(s0.fingerprint);
    expect(s1.changes).toMatchObject([{ path: 'src/a.ts', status: 'M' }]);
    expect(s1.hunks[0]!.added.join('\n')).toMatch(/it.only/);
    writeFileSync(join(dir, 'src/new.ts'), 'new');
    const s2 = await snapshotWorktree(dir, 'HEAD');
    expect(s2.fingerprint).not.toBe(s1.fingerprint);
    expect(s2.changes.find((c) => c.path === 'src/new.ts')?.status).toBe('?');
    expect(s2.packet).toMatch(/\+\+\+ src\/new.ts \(new\)\nnew/);
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    const s3 = await snapshotWorktree(dir, 'HEAD');
    expect(s3.fingerprint).not.toBe(s2.fingerprint);
    expect(s3.changes.find((c) => c.path === '.env')?.status).toBe('!');
    execFileSync('git', ['-C', dir, 'add', 'src/new.ts']);
    const s4 = await snapshotWorktree(dir, 'HEAD');
    expect(s4.fingerprint).not.toBe(s3.fingerprint);
    try {
      symlinkSync('../../etc', join(dir, 'src/link'));
      const s5 = await snapshotWorktree(dir, 'HEAD');
      expect(s5.changes.find((c) => c.path === 'src/link')?.symlink).toBe(true);
    } catch {
      // symlinks may be unavailable on this filesystem
    }
  });
});

describe('limit hooks and mandatory set', () => {
  const run = { runId: 'r', invokeId: 'i', depth: 0 };
  const ev = (span: SpanEvent['span'], stage: SpanEvent['stage'], extra: Partial<SpanEvent> = {}): SpanEvent => ({ span, stage, spanId: 's', run, attempt: 1, input: {}, ...extra });
  it('BudgetPool reserves per call and aborts when exhausted (budgets.enforce true)', () => {
    const b = new BudgetPool({ usd: 0.05, tokens: 100000, calls: 3, wallMs: 60000 }, { usdPerCall: 0.02, tokensPerCall: 10 });
    expect(b.handle(ev('LLMQuery', 'Send')).map((e) => e.type)).toEqual(['ReserveBudget', 'ReserveBudget', 'ReserveBudget']);
    b.handle(ev('LLMQuery', 'Complete', { output: { usage: { usd: 0.04, inputTokens: 5, outputTokens: 5 } } }));
    expect(b.handle(ev('LLMQuery', 'Send'))[0]).toMatchObject({ type: 'Abort', code: 'budget' });
    expect(b.snapshot().usd).toBeCloseTo(0.04);
  });
  it('D3: BudgetPool with enforce false never aborts: it records budget.exhausted once per pool and keeps reserving', () => {
    const b = new BudgetPool({ usd: 0.05, tokens: 100000, calls: 1, wallMs: 60000 }, { usdPerCall: 0.02, tokensPerCall: 10 }, { enforce: false });
    b.handle(ev('LLMQuery', 'Send'));
    b.handle(ev('LLMQuery', 'Complete', { output: { usage: { usd: 0.06, inputTokens: 5, outputTokens: 5 } } }));
    const enter = b.handle(ev('LLMQuery', 'Enter'));
    expect(enter).toMatchObject([{ type: 'AppendEvidence', kind: 'budget.exhausted', body: { pool: 'usd', enforced: false } }]);
    expect(b.handle(ev('LLMQuery', 'Enter'))).toEqual([]);
    const send = b.handle(ev('LLMQuery', 'Send'));
    expect(send.some((x) => x.type === 'Abort')).toBe(false);
    expect(send.filter((x) => x.type === 'ReserveBudget')).toHaveLength(3);
    expect(send.filter((x) => x.type === 'AppendEvidence').map((x) => (x as { body: { pool: string } }).body.pool)).toEqual(['calls']);
    expect(b.describe().config).toMatchObject({ enforce: false });
    // the manifest default (enforce false) reaches the mandatory hook
    const hook = mandatoryHooks(manifest(), { permissions: DEFAULT_PERMISSIONS }).find((h) => h.id === 'budgetPool')!;
    expect(hook.describe().config).toMatchObject({ enforce: false });
  });
  it('RecursionLimit and IterationLimit', () => {
    const r = new RecursionLimit(2);
    expect(r.handle(ev('Invoke', 'Enter', { run: { ...run, depth: 1 } }))).toEqual([]);
    expect(r.handle(ev('Invoke', 'Enter', { run: { ...run, depth: 2 } }))[0]).toMatchObject({ code: 'recursion' });
    const it5 = new IterationLimit(3);
    expect(it5.handle(ev('LLMQuery', 'Enter'))).toEqual([]);
    expect(it5.handle(ev('LLMQuery', 'Enter'))[0]).toMatchObject({ type: 'PatchInput', path: 'nudge' });
    it5.handle(ev('LLMQuery', 'Enter'));
    expect(it5.handle(ev('LLMQuery', 'Enter'))[0]).toMatchObject({ type: 'Abort', code: 'iterations' });
  });
  it('mandatoryHooks produces the full set; assertMandatory refuses a missing one', () => {
    const hooks = mandatoryHooks(manifest(), { permissions: DEFAULT_PERMISSIONS, secretValues: ['sk-ant-api03-verysecretvalue'] });
    expect(hooks.map((h) => h.id).sort()).toEqual([...MANDATORY_HOOKS].sort());
    expect(() => assertMandatory(hooks, manifest())).not.toThrow();
    expect(() => assertMandatory(hooks.filter((h) => h.id !== 'verifyGate'), manifest())).toThrow(MissingMandatoryHooks);
    const view = { capabilities: { tools: ['read', 'edit'], paths: { read: ['**'], write: ['src/**'], protected: ['**/*.test.*'] }, network: 'none' as const, limits: { usd: 1, tokens: 1, calls: 1, wallMs: 1, depth: 1, iterations: 1 } }, blackboard: {}, hooks: [] };
    const byId = Object.fromEntries(hooks.map((h) => [h.id, h]));
    expect(byId.toolAllowlist!.handle(ev('ToolCall', 'Enter', { input: { tool: 'shell' } }), view)).toMatchObject([{ code: 'allowlist' }]);
    expect(byId.protectedPaths!.handle(ev('ToolCall', 'Enter', { input: { tool: 'edit', method: 'write', path: 'src/a.test.ts' } }), view)).toMatchObject([{ code: 'protected' }]);
    expect(byId.protectedPaths!.handle(ev('ToolCall', 'Enter', { input: { tool: 'edit', method: 'write', path: 'lib/a.ts' } }), view)).toMatchObject([{ code: 'protected' }]);
    expect(byId.protectedPaths!.handle(ev('ToolCall', 'Enter', { input: { tool: 'edit', method: 'write', path: 'src/a.ts' } }), view)).toEqual([]);
    // D6: commit is 'always'; push / PR are only the gate.pr's; merge never; writes need no approval
    expect(byId.approvalGate!.handle(ev('ToolCall', 'Send', { input: { tool: 'git', method: 'commit' } }), view)).toEqual([]);
    expect(byId.approvalGate!.handle(ev('ToolCall', 'Send', { input: { tool: 'git', method: 'push' } }), view)).toMatchObject([{ type: 'Abort', code: 'policy', reason: expect.stringMatching(/only at the gate.pr step/) }]);
    expect(byId.approvalGate!.handle(ev('ToolCall', 'Send', { input: { tool: 'open_pr' } }), view)).toMatchObject([{ type: 'Abort', code: 'policy' }]);
    expect(byId.approvalGate!.handle(ev('ToolCall', 'Send', { input: { tool: 'git', method: 'merge' } }), view)).toMatchObject([{ type: 'Abort', code: 'policy', reason: expect.stringMatching(/never merges/) }]);
    expect(byId.approvalGate!.handle(ev('ToolCall', 'Send', { input: { tool: 'edit', method: 'write', path: 'src/a.ts' } }), view)).toEqual([]);
    expect(byId.approvalGate!.handle(ev('ToolCall', 'Send', { input: { tool: 'externalWrite' } }), view)).toMatchObject([{ type: 'Suspend' }]);
    const strict = mandatoryHooks(manifest(), { permissions: { always: [], requiresApproval: ['edit'], never: [] } }).find((h) => h.id === 'approvalGate')!;
    expect(strict.handle(ev('ToolCall', 'Send', { input: { tool: 'edit', method: 'write', path: 'src/a.ts' } }), view)).toEqual([]);
    expect(byId.secretCanary!.handle(ev('LLMQuery', 'Enter', { input: { prompt: 'key is sk-ant-api03-verysecretvalue' } }), view)).toMatchObject([{ code: 'policy' }]);
    expect(byId.secretCanary!.handle(ev('LLMQuery', 'Enter', { input: { prompt: 'AKIAABCDEFGHIJKLMNOP leaked' } }), view)).toMatchObject([{ code: 'policy' }]);
    expect(byId.evidenceRecorder!.handle(ev('Invoke', 'Enter'), view)).toMatchObject([{ type: 'AppendEvidence', kind: 'governance' }]);
  });
});

describe('progressCheck (ADV-8): equal candidate fingerprints across attempts abort for a human', () => {
  const run = { runId: 'r', invokeId: 'i', depth: 0 };
  const enter = (input: Record<string, unknown> = {}): SpanEvent => ({ span: 'Invoke', stage: 'Enter', spanId: 's', run, attempt: 1, input: input as SpanEvent['input'] });
  it('the mandatory hook compares fingerprints from the fingerprintOf callback', () => {
    const fps: Record<number, string | undefined> = { 1: 'fp-a', 2: 'fp-a' };
    let attempt = 1;
    const hooks = mandatoryHooks(manifest(), { permissions: DEFAULT_PERMISSIONS, fingerprintOf: (a) => fps[a], attempt: () => attempt });
    const h = hooks.find((x) => x.id === 'progressCheck')!;
    expect(h.mandatory).toBe(true);
    const view = { capabilities: { tools: [], paths: { read: [], write: [], protected: [] }, network: 'none' as const, limits: { usd: 1, tokens: 1, calls: 1, wallMs: 1, depth: 1, iterations: 1 } }, blackboard: {}, hooks: [] };
    expect(h.handle(enter(), view)).toEqual([]); // attempt 1 alone
    attempt = 2;
    expect(h.handle(enter(), view)).toMatchObject([{ type: 'Abort', code: 'policy', reason: expect.stringMatching(/^no progress: attempts 1 and 2/) }]);
    fps[2] = 'fp-b';
    expect(h.handle(enter(), view)).toEqual([]);
    attempt = 3;
    fps[3] = 'fp-a'; // back to an earlier candidate is no progress either
    expect(h.handle(enter(), view)).toMatchObject([{ code: 'policy' }]);
  });
  it('reads span-input fingerprints; nulls, one attempt or same-attempt repeats are progress', () => {
    const h = new ProgressCheck();
    expect(h.handle(enter({ progress: { fingerprints: [{ attempt: 1, fingerprint: 'x' }, { attempt: 1, fingerprint: 'x' }] } }))).toEqual([]);
    expect(h.handle(enter({ progress: { fingerprints: [{ attempt: 1, fingerprint: null }, { attempt: 2, fingerprint: null }] } }))).toEqual([]);
    expect(h.handle(enter({ progress: { fingerprints: [{ attempt: 1, fingerprint: 'x' }, { attempt: 2, fingerprint: 'x' }] } }))).toMatchObject([{ code: 'policy' }]);
    expect(h.handle({ ...enter({ progress: { fingerprints: [{ attempt: 1, fingerprint: 'x' }, { attempt: 2, fingerprint: 'x' }] } }), stage: 'Exit' })).toEqual([]);
    expect(noProgressReason([{ attempt: 1, fingerprint: 'a' }, { attempt: 2, fingerprint: 'b' }])).toBeNull();
  });
  it('ADV-8 precision: only candidates of DIFFERENT worker executions are compared (history source and span input)', () => {
    const view = { capabilities: { tools: [], paths: { read: [], write: [], protected: [] }, network: 'none' as const, limits: { usd: 1, tokens: 1, calls: 1, wallMs: 1, depth: 1, iterations: 1 } }, blackboard: {}, hooks: [] };
    let hist: Array<{ attempt: number; fingerprint: string; exec: number }> = [{ attempt: 1, fingerprint: 'fp', exec: 2 }, { attempt: 2, fingerprint: 'fp', exec: 2 }];
    const h = mandatoryHooks(manifest(), { permissions: DEFAULT_PERMISSIONS, progressHistory: () => hist, fingerprintOf: () => 'fp', attempt: () => 2 }).find((x) => x.id === 'progressCheck')!;
    expect(h.handle(enter(), view)).toEqual([]); // two verifies of one worker execution: not no-progress (history wins over fingerprintOf)
    hist = [...hist, { attempt: 3, fingerprint: 'fp', exec: 3 }];
    expect(h.handle(enter(), view)).toMatchObject([{ type: 'Abort', code: 'policy', reason: expect.stringMatching(/worker executions 2 and 3/) }]);
    const p = new ProgressCheck();
    expect(p.handle(enter({ progress: { fingerprints: [{ attempt: 1, fingerprint: 'x', exec: 5 }, { attempt: 2, fingerprint: 'x', exec: 5 }] } }))).toEqual([]);
    expect(p.handle(enter({ progress: { fingerprints: [{ attempt: 1, fingerprint: 'x', exec: 5 }, { attempt: 2, fingerprint: 'x', exec: 6 }] } }))).toMatchObject([{ code: 'policy' }]);
  });
  it('a throwing source surfaces as a hook error (the worker fails closed), never as progress', () => {
    const h = new ProgressCheck({ fingerprintOf: () => { throw new Error('ledger down'); }, attempt: () => 2 });
    expect(() => h.handle(enter())).toThrow(/ledger down/);
  });
});
