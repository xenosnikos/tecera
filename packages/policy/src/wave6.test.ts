import { describe, expect, it } from 'vitest';
import {
  MANDATORY_HOOKS,
  contractHash,
  digest,
  event,
  parseManifest,
  provenRun,
  verifyCommandDigest,
  type AcceptanceContract,
  type AchievementGoal,
  type CapabilityRecord,
  type EvidenceRecord,
  type Json,
  type JsonObject,
  type Manifest,
  type MockToolDeclaration,
  type Plan,
  type ProvisionedResource,
  type SpanEvent,
  type TeceraEvent,
} from '@tecera/contracts';
import { MemoryLedger } from '@tecera/ledger';
import { DEFAULT_PERMISSIONS, PermissionsError, classify, parsePermissions, permissionsProblems } from './permissions.js';
import { validatePlan } from './validatePlan.js';
import { activeRunsOf, evaluateStopEvents, evaluateStopLedger, stopDecision, stopDecisionForRuns } from './stop.js';
import { allowanceOf, mockDeclarationProblem, provisionRequestProblem, provisionedResourceProblem } from './provisioning.js';
import { DEFAULT_CONFIG_GLOBS, DEFAULT_TEST_GLOBS, tamperFindings } from './tamper.js';
import { criterionScriptProblem, criterionTargets, packageScriptWriteProblem } from './contractTamper.js';
import { parseHunks } from './snapshot.js';
import { mandatoryHooks } from './hooks/mandatory.js';

function manifest(extra: Record<string, unknown> = {}): Manifest {
  return parseManifest({
    schemaVersion: 1, id: 'bc_sample01', name: 's', owner: 'o', runtime: { tecera: '>=0.1.0' },
    repo: { base: 'main', branchPrefix: 'tecera/', allowedChanges: ['src/**'] },
    providers: { anthropic: { auth: 'env:A' }, openai: { auth: 'env:O' } },
    seats: { planner: { provider: 'anthropic', model: 'p', effort: 'high' }, workers: [{ id: 'worker', provider: 'anthropic', model: 'w', effort: 'low' }], reviewer: { provider: 'openai', model: 'r', effort: 'high' }, reflex: { provider: 'rules' } },
    budgets: { usd: 2, tokens: 1000, wallClockSec: 600, maxDepth: 3, maxIterations: 5, maxAttempts: 2, maxChangedFiles: 5 },
    sandbox: { profile: 'process', isolation: 'node', network: false, memoryMb: 256, execTimeoutSec: 60 },
    policy: { protectedPaths: ['tecera.json', '.tecera/**', '**/*.test.*'], approvals: { required: ['open_pr'], ttlSec: 900, quorum: 1, separationOfDuty: true }, failure: { onVerifyFail: 'retry-once', onReviewFail: 'retry-once', onLedgerError: 'stop' } },
    verify: { command: 'npm test', timeoutSec: 60 }, review: { foreign: true, maxAttempts: 1 }, hooks: { mandatory: [...MANDATORY_HOOKS] },
    ...extra,
  });
}

const deliveryPlan = (o: Partial<Plan> = {}): Plan => ({
  id: 'p', trigger: { kind: 'goal.adopted' }, context: [], goalKinds: [], origin: 'generated', status: 'candidate',
  steps: [
    { id: 'edit', kind: 'worker', dependsOn: [], inputs: {} },
    { id: 'v', kind: 'gate.verify', dependsOn: ['edit'], inputs: {} },
    { id: 'r', kind: 'gate.review', dependsOn: ['v'], inputs: {} },
    { id: 'v2', kind: 'gate.verify', dependsOn: ['r'], inputs: {} },
    { id: 'c', kind: 'gate.commit', dependsOn: ['v2'], inputs: {} },
    { id: 'pr', kind: 'gate.pr', dependsOn: ['c'], inputs: {} },
  ],
  allowedModels: { edit: ['worker'] },
  permissions: { tools: ['read', 'edit'], write: ['src/**'], approvals: ['open_pr', 'git_push'] },
  budget: { usd: 1 },
  ...o,
});
const readOnlyPlan = (o: Partial<Plan> = {}): Plan => ({ ...deliveryPlan(), steps: [{ id: 'look', kind: 'worker', dependsOn: [], inputs: {}, tools: ['read'] }], allowedModels: {}, permissions: { tools: ['read'], write: [], approvals: [] }, ...o });
const opts = { toolCatalog: ['read', 'edit', 'runVerify', 'git_push', 'accept_criteria'], permissions: DEFAULT_PERMISSIONS, goalHasCheck: true };

const contract = (o: Partial<AcceptanceContract> = {}): AcceptanceContract => ({
  goalId: 'g',
  statement: 'persist sessions',
  criteria: [
    { id: 'tests', statement: 'tests pass', check: { kind: 'command', command: 'node --test', timeoutSec: 60 } },
    { id: 'db', statement: 'sessions survive a restart', check: { kind: 'command', command: 'bash scripts/check-db.sh', timeoutSec: 60 }, requires: ['db'] },
    { id: 'rate', statement: 'rate limited', check: { kind: 'command', command: 'npm run check:rate -- --quiet', timeoutSec: 60 } },
  ],
  outOfScope: [],
  assumptions: [],
  ...o,
});

describe('validatePlan under wave 6 (D6 approvals, D8 contract, D9/D10 capabilities)', () => {
  const v = (p: Plan, ctx?: Parameters<typeof validatePlan>[2]['context'], m = manifest(), goal?: AchievementGoal) => validatePlan(p, m, { ...opts, ...(ctx ? { context: ctx } : {}), ...(goal ? { goal } : {}) }).join('\n');

  it('sprint 5 item 5: a gate.pr plan declares open_pr AND git_push; neither is a worker tool', () => {
    expect(v(deliveryPlan())).toBe('');
    expect(v(deliveryPlan({ permissions: { tools: ['read', 'edit'], write: ['src/**'], approvals: ['open_pr'] } }))).toMatch(/gate.pr needs the human approval 'git_push'/);
    expect(v(deliveryPlan({ permissions: { tools: ['read', 'edit'], write: ['src/**'], approvals: ['git_push'] } }))).toMatch(/gate.pr needs the human approval 'open_pr'/);
    expect(v(deliveryPlan({ permissions: { tools: ['read', 'edit', 'git_push'], write: ['src/**'], approvals: ['open_pr', 'git_push'] } }))).toMatch(/tool git_push happens only at the gate.pr step/);
  });

  it('obsolete approval requirements on in-bounds writes and commits are refused; accept_criteria is never a plan approval or tool', () => {
    for (const a of ['edit', 'write', 'commit']) {
      expect(v(deliveryPlan({ permissions: { tools: ['read', 'edit'], write: ['src/**'], approvals: ['open_pr', 'git_push', a] } }))).toMatch(new RegExp(`approval ${a} is obsolete`));
    }
    expect(v(deliveryPlan({ permissions: { tools: ['read', 'edit'], write: ['src/**'], approvals: ['open_pr', 'git_push', 'accept_criteria'] } }))).toMatch(/approval accept_criteria is the requestor's/);
    expect(v(deliveryPlan({ permissions: { tools: ['read', 'edit', 'accept_criteria'], write: ['src/**'], approvals: ['open_pr', 'git_push'] } }))).toMatch(/tool accept_criteria is a human approval/);
  });

  it('a plan for another contractHash (or none) is refused; the accepted one passes', () => {
    const c = contract();
    const h = contractHash(c);
    const ctx = { contract: c, contractHash: h, inventory: [{ id: 'db', kind: 'sqlite', state: 'available', probe: { command: 'true', exitCode: 0 } }] as CapabilityRecord[] };
    expect(v(deliveryPlan({ contractHash: h, capabilities: ['db'] }), ctx)).toBe('');
    expect(v(deliveryPlan({ capabilities: ['db'] }), ctx)).toMatch(/plan names no contractHash/);
    expect(v(deliveryPlan({ contractHash: contractHash(contract({ assumptions: ['weaker'] })), capabilities: ['db'] }), ctx)).toMatch(/not the accepted/);
    expect(v(deliveryPlan({ contractHash: h, capabilities: ['db'] }), { ...ctx, contractHash: 'f'.repeat(64) })).toMatch(/another contract hash than its contract/);
    // a plan written for a contract when none is accepted (single-check run)
    expect(v(deliveryPlan({ contractHash: h }))).toMatch(/no contract is accepted for this goal/);
    // a goal file's criteria count when the loop passes no context
    const goal: AchievementGoal = { id: 'g', statement: 's', check: { command: 'node --test', timeoutSec: 60 }, commitment: 'single-minded', status: 'open', evidence: [], criteria: c.criteria, contractHash: h };
    expect(v(deliveryPlan({ capabilities: ['db'] }), undefined, manifest({ connections: { db: { kind: 'sqlite' } } }), goal)).toMatch(/plan names no contractHash/);
  });

  it('a command criterion without gate.verify coverage is refused; so is a required capability the plan does not name', () => {
    const c = contract();
    const ctx = { contract: c, contractHash: contractHash(c), inventory: [{ id: 'db', kind: 'sqlite', state: 'available', probe: { command: 'true', exitCode: 0 } }] as CapabilityRecord[] };
    const noVerify = readOnlyPlan({ contractHash: ctx.contractHash, capabilities: ['db'] });
    expect(validatePlan(noVerify, manifest(), { ...opts, goalHasCheck: false, context: ctx }).join('\n')).toMatch(/no gate.verify step to prove command criteria tests, db, rate/);
    const withVerify = readOnlyPlan({ contractHash: ctx.contractHash, capabilities: ['db'], steps: [...readOnlyPlan().steps, { id: 'v', kind: 'gate.verify', dependsOn: ['look'], inputs: {} }] });
    expect(validatePlan(withVerify, manifest(), { ...opts, goalHasCheck: false, context: ctx })).toEqual([]);
    expect(v(deliveryPlan({ contractHash: ctx.contractHash }), ctx)).toMatch(/criterion db requires capability db, which the plan does not name/);
  });

  it('capabilities: undeclared refused; missing that resolves to ask refused; provision / mock / available pass', () => {
    const c = contract({ criteria: contract().criteria.filter((k) => k.id !== 'db') });
    const h = contractHash(c);
    const m = manifest({ connections: { mail: { kind: 'smtp', mockable: false }, mailstub: { kind: 'smtp' }, db: { kind: 'sqlite', mockable: false } } });
    const plan = (caps: string[]) => deliveryPlan({ contractHash: h, capabilities: caps });
    const ctx = (inventory: CapabilityRecord[], extra: Record<string, unknown> = {}) => ({ contract: c, contractHash: h, inventory, ...extra });
    expect(v(plan(['jira']), ctx([]), m)).toMatch(/capability jira, which is neither declared in the manifest connections nor in the run's inventory/);
    // smtp is not a provisionable kind and the connection is not mockable: ask
    expect(v(plan(['mail']), ctx([{ id: 'mail', kind: 'smtp', state: 'missing' }]), m)).toMatch(/plan uses capability mail, which is missing and can be neither provisioned/);
    // declared but never probed counts as missing
    expect(v(plan(['mail']), ctx([]), m)).toMatch(/capability mail, which is missing/);
    // mockable: the broker serves a stand-in (the goal can only be provisional)
    expect(v(plan(['mailstub']), ctx([{ id: 'mailstub', kind: 'smtp', state: 'missing' }]), m)).toBe('');
    // provisionable sqlite inside the allowance
    expect(v(plan(['db']), ctx([{ id: 'db', kind: 'sqlite', state: 'missing' }]), m)).toBe('');
    // allowance spent (manifest max 4): sqlite cannot be provisioned and db is not mockable → ask
    expect(v(plan(['db']), ctx([{ id: 'db', kind: 'sqlite', state: 'missing' }], { provisionedSoFar: 4 }), m)).toMatch(/capability db, which is missing/);
    // a narrower allowance from the loop wins; a wider one never widens the manifest
    expect(v(plan(['db']), ctx([{ id: 'db', kind: 'sqlite', state: 'missing' }], { allowance: { scope: 'local', kinds: ['tmpdir'], maxResources: 4, ttlSec: 3600 } }), m)).toMatch(/capability db, which is missing/);
    expect(v(plan(['db']), ctx([{ id: 'db', kind: 'sqlite', state: 'missing' }], { allowance: { scope: 'local', kinds: ['sqlite'], maxResources: 16, ttlSec: 99999 } }), manifest({ connections: { db: { kind: 'sqlite', mockable: false } }, provisioning: { scope: 'none' } }))).toMatch(/capability db, which is missing/);
    expect(v(plan(['db']), ctx([{ id: 'db', kind: 'sqlite', state: 'provisioned', resourceId: 'res1' }]), m)).toBe('');
    expect(v(plan(['mail']), ctx([{ id: 'mail', kind: 'smtp', state: 'mocked' }]), m)).toMatch(/mail is mocked, but its connection is not mockable/);
  });

  it('existing single-check plans validate exactly as before (no context, no criteria)', () => {
    expect(validatePlan(deliveryPlan(), manifest(), opts)).toEqual([]);
    expect(validatePlan(readOnlyPlan(), manifest(), { ...opts, goalHasCheck: false })).toEqual([]);
  });
});

describe('permissions: approval-only actions and D6 placement', () => {
  it('accept_criteria / answer_criterion are approval-only: never always, classified requiresApproval when unlisted', () => {
    expect(classify('accept_criteria', DEFAULT_PERMISSIONS)).toBe('requiresApproval');
    expect(classify('answer_criterion', { always: [], requiresApproval: [], never: [] })).toBe('requiresApproval');
    expect(() => parsePermissions({ always: ['accept_criteria'] })).toThrow(PermissionsError);
    expect(() => parsePermissions({ always: ['read'], requiresApproval: ['accept_criteria'] })).not.toThrow();
  });
  it('permissionsProblems: the default is in order; misplaced D6 actions and obsolete write approvals are named', () => {
    expect(permissionsProblems(DEFAULT_PERMISSIONS)).toEqual([]);
    const out = permissionsProblems({ always: ['read'], requiresApproval: ['open_pr', 'edit', 'commit'], never: ['merge', 'git_push'] }).join('\n');
    expect(out).toMatch(/commit must be listed in always only \(found requiresApproval\)/);
    expect(out).toMatch(/git_push must be listed in requiresApproval only \(found never\)/);
    expect(out).toMatch(/requiresApproval lists edit: obsolete/);
    expect(out).not.toMatch(/open_pr|merge/);
  });
  it('the approvalGate hook refuses a worker performing or requesting accept_criteria (it would pick what the human grants)', () => {
    const view = { capabilities: { tools: ['accept_criteria'], paths: { read: ['**'], write: ['src/**'], protected: [] }, network: 'none' as const, limits: { usd: 1, tokens: 1, calls: 1, wallMs: 1, depth: 1, iterations: 1 } }, blackboard: {}, hooks: [] };
    const gate = mandatoryHooks(manifest(), { permissions: DEFAULT_PERMISSIONS }).find((h) => h.id === 'approvalGate')!;
    const send = (input: Record<string, unknown>): SpanEvent => ({ span: 'ToolCall', stage: 'Send', spanId: 's', run: { runId: 'r', invokeId: 'i', depth: 0 }, attempt: 1, input: input as SpanEvent['input'] });
    for (const input of [{ tool: 'accept_criteria' }, { tool: 'approvals', method: 'accept_criteria' }, { tool: 'answer_criterion', actionHash: 'x' }]) {
      expect(gate.handle(send(input), view)).toMatchObject([{ type: 'Abort', code: 'policy', reason: expect.stringMatching(/is a human approval/) }]);
    }
  });
});

describe('provisioning inside the allowance, mocks never over a real capability', () => {
  const allow = allowanceOf(manifest());
  const resource = (o: Partial<ProvisionedResource> = {}): ProvisionedResource => ({ id: 'res1', capability: 'db', kind: 'sqlite', provider: 'local', locator: '/tmp/tecera-res/db.sqlite', teardown: 'rm -f /tmp/tecera-res/db.sqlite', createdAt: 1000, expiresAt: 1000 + 3600_000, transfer: 'pending', ...o });
  it('allowanceOf: the manifest default; no section allows nothing', () => {
    expect(allow).toEqual({ scope: 'local', kinds: ['tmpdir', 'git-remote', 'sqlite', 'http-stub'], maxResources: 4, ttlSec: 3600 });
    expect(allowanceOf({} as never).scope).toBe('none');
  });
  it('provisionRequestProblem refuses scope, kind, count and lifetime outside the allowance', () => {
    expect(provisionRequestProblem({ capability: 'db', kind: 'sqlite' }, allow, 0)).toBeNull();
    expect(provisionRequestProblem({ capability: 'db', kind: 'sqlite', ttlSec: 3600 }, allow, 3)).toBeNull();
    expect(provisionRequestProblem({ capability: 'db', kind: 'postgres' }, allow, 0)).toMatch(/kind postgres is outside the allowance/);
    expect(provisionRequestProblem({ capability: 'db', kind: 'sqlite' }, allow, 4)).toMatch(/already provisioned 4 of at most 4/);
    expect(provisionRequestProblem({ capability: 'db', kind: 'sqlite', ttlSec: 7200 }, allow, 0)).toMatch(/lifetime of 7200s is outside/);
    expect(provisionRequestProblem({ capability: 'db', kind: 'sqlite', scope: 'cloud' }, allow, 0)).toMatch(/scope "cloud" is outside/);
    expect(provisionRequestProblem({ capability: 'db', kind: 'sqlite' }, allowanceOf(manifest({ provisioning: { scope: 'none' } })), 0)).toMatch(/scope is none/);
  });
  it('provisionedResourceProblem: resourceProblem with the allowance plus the run count', () => {
    expect(provisionedResourceProblem(resource(), allow, 0)).toBeNull();
    expect(provisionedResourceProblem(resource({ expiresAt: 1000 + 7200_000 }), allow, 0)).toMatch(/lives longer than the allowance/);
    expect(provisionedResourceProblem(resource({ kind: 'postgres' }), allow, 0)).toMatch(/outside the allowance/);
    expect(provisionedResourceProblem(resource(), allow, 4)).toMatch(/at most 4/);
    expect(provisionedResourceProblem(resource({ locator: 'postgres://u:p@localhost/db' }), allow, 0)).toMatch(/userinfo/);
    expect(provisionedResourceProblem(resource({ teardown: '' }), allow, 0)).toMatch(/no teardown/);
  });
  it('mockDeclarationProblem: never for an available or provisioned capability, nor a connection that is not mockable', () => {
    const decl: MockToolDeclaration = { capability: 'mail', kind: 'smtp', tool: 'mail', methods: ['send'], schema: {}, mockId: 'mock-mail', reason: 'no sender' } as MockToolDeclaration;
    const m = manifest({ connections: { mail: { kind: 'smtp' }, pay: { kind: 'stripe', mockable: false } } });
    expect(mockDeclarationProblem(decl, [{ id: 'mail', kind: 'smtp', state: 'missing' }], m)).toBeNull();
    expect(mockDeclarationProblem(decl, [{ id: 'mail', kind: 'smtp', state: 'available', probe: { command: 'true', exitCode: 0 } }], m)).toMatch(/available: it may not be mocked/);
    expect(mockDeclarationProblem(decl, [{ id: 'mail', kind: 'smtp', state: 'provisioned' }], m)).toMatch(/provisioned: it may not be mocked/);
    expect(mockDeclarationProblem({ ...decl, capability: 'pay' }, [], m)).toMatch(/not mockable/);
  });
});

describe('contract tampering: a worker edit to the contract or a criterion check is tampering', () => {
  const c = contract();
  const tOpts = { testGlobs: DEFAULT_TEST_GLOBS, configGlobs: DEFAULT_CONFIG_GLOBS, testsReadOnly: false };
  it('criterionTargets: the files and package scripts the check commands run', () => {
    const t = criterionTargets(c);
    expect(t.paths).toContain('scripts/check-db.sh');
    expect(t.scripts).toEqual(expect.arrayContaining(['check:rate', 'precheck:rate', 'postcheck:rate']));
    expect(criterionTargets(contract({ criteria: [{ id: 'a', statement: 'a', check: { kind: 'command', command: 'npm test && node ./tools/verify.mjs --dir=fixtures/', timeoutSec: 5 } }] }))).toMatchObject({ paths: expect.arrayContaining(['tools/verify.mjs', 'fixtures']), scripts: expect.arrayContaining(['test', 'pretest']) });
  });
  it('tamperFindings flags contract-edit and criterion-edit only under a contract', () => {
    const changes = [{ path: '.tecera/goals/persist.md', status: 'M' as const }, { path: 'scripts/check-db.sh', status: 'M' as const }, { path: 'src/session.ts', status: 'M' as const }, { path: 'package.json', status: 'M' as const }];
    const hunks = [{ path: 'package.json', added: ['    "check:rate": "true",'] }, { path: 'src/session.ts', added: ['export const x = 1;'] }];
    const f = tamperFindings(changes, hunks, { ...tOpts, contract: c });
    expect(f.filter((x) => x.code === 'contract-edit').map((x) => x.path)).toEqual(['.tecera/goals/persist.md']);
    expect(f.filter((x) => x.code === 'criterion-edit').map((x) => x.path).sort()).toEqual(['package.json', 'scripts/check-db.sh']);
    expect(f.some((x) => x.path === 'src/session.ts')).toBe(false);
    // a rename away from the check script is caught on its source
    expect(tamperFindings([{ path: 'scripts/old.sh', from: 'scripts/check-db.sh', status: 'R' }], [], { ...tOpts, contract: c }).map((x) => x.code)).toContain('criterion-edit');
    // no contract: exactly the old findings
    expect(tamperFindings(changes, hunks, tOpts).filter((x) => x.code === 'contract-edit' || x.code === 'criterion-edit')).toEqual([]);
  });
  it('the tamperCheck hook aborts a worker write to the contract or a criterion check, and only under a contract', () => {
    const view = { capabilities: { tools: ['edit'], paths: { read: ['**'], write: ['**'], protected: [] }, network: 'none' as const, limits: { usd: 1, tokens: 1, calls: 1, wallMs: 1, depth: 1, iterations: 1 } }, blackboard: {}, hooks: [] };
    const enter = (input: Record<string, unknown>): SpanEvent => ({ span: 'ToolCall', stage: 'Enter', spanId: 's', run: { runId: 'r', invokeId: 'i', depth: 0 }, attempt: 1, input: input as SpanEvent['input'] });
    const hook = mandatoryHooks(manifest(), { permissions: DEFAULT_PERMISSIONS, contract: () => c }).find((h) => h.id === 'tamperCheck')!;
    expect(hook.mandatory).toBe(true);
    expect(hook.handle(enter({ tool: 'edit', method: 'write', path: 'scripts/check-db.sh' }), view)).toMatchObject([{ type: 'Abort', code: 'policy', reason: expect.stringMatching(/^tampering: scripts\/check-db.sh is run by a criterion's check command/) }]);
    expect(hook.handle(enter({ tool: 'edit', method: 'write', path: '.tecera/contract.json' }), view)).toMatchObject([{ type: 'Abort', reason: expect.stringMatching(/holds the acceptance contract/) }]);
    expect(hook.handle(enter({ tool: 'fs', method: 'delete', path: './scripts/check-db.sh' }), view)).toMatchObject([{ type: 'Abort' }]);
    expect(hook.handle(enter({ tool: 'edit', method: 'write', path: 'src/session.ts' }), view)).toEqual([]);
    expect(hook.handle(enter({ tool: 'fs', method: 'read', path: 'scripts/check-db.sh' }), view)).toEqual([]);
    const none = mandatoryHooks(manifest(), { permissions: DEFAULT_PERMISSIONS }).find((h) => h.id === 'tamperCheck')!;
    expect(none.handle(enter({ tool: 'edit', method: 'write', path: 'scripts/check-db.sh' }), view)).toEqual([]);
  });
});

describe('review repairs: script tampering, shell forms, contract binding, PR approval placement', () => {
  const c = contract();
  const tOpts = { testGlobs: DEFAULT_TEST_GLOBS, configGlobs: DEFAULT_CONFIG_GLOBS, testsReadOnly: false };
  const one = (command: string) => criterionTargets(contract({ criteria: [{ id: 'a', statement: 'a', check: { kind: 'command', command, timeoutSec: 5 } }] }));

  it('criterionTargets: runner flags with values, yarn workspaces, sh -c nesting and wrapper commands', () => {
    expect(one('npm --workspace api run contract-check').scripts).toContain('contract-check');
    expect(one('npm -w api test').scripts).toContain('test');
    expect(one('pnpm --filter api run lint').scripts).toContain('lint');
    expect(one('yarn workspace api contract-check').scripts).toContain('contract-check');
    expect(one('yarn workspaces foreach run build').scripts).toContain('build');
    expect(one('npm --workspace api run contract-check').scripts).not.toContain('api');
    const nested = one(`sh -c 'npm run check:rate && node tools/verify.mjs'`);
    expect(nested.scripts).toEqual(expect.arrayContaining(['check:rate', 'precheck:rate']));
    expect(nested.paths).toContain('tools/verify.mjs');
    expect(one('bash -lc "env CI=1 npm run smoke"').scripts).toContain('smoke');
    expect(one('env CI=1 time npm run smoke').scripts).toContain('smoke');
    // a quoted separator stays inside its word: the script name is not cut at '&&'
    expect(one(`node "scripts/a b.js"`).paths).toContain('scripts/a b.js');
  });

  it('criterionScriptProblem and tamperFindings see a removed script and a deleted or renamed package.json', () => {
    const t = criterionTargets(c);
    expect(criterionScriptProblem('package.json', [], t, ['    "check:rate": "node scripts/rate.js",'])).toMatch(/script check:rate is run by a criterion's check command \(removed\)/);
    expect(criterionScriptProblem('package.json', ['    "lint": "eslint ."'], t, ['    "build": "tsc"'])).toBeNull();
    expect(criterionScriptProblem('not-package.json', ['    "check:rate": "true"'], t)).toBeNull();
    const removed = tamperFindings([{ path: 'package.json', status: 'M' }], [{ path: 'package.json', added: [], removed: ['    "check:rate": "node scripts/rate.js",'] }], { ...tOpts, contract: c });
    expect(removed.filter((f) => f.code === 'criterion-edit').map((f) => f.path)).toEqual(['package.json']);
    expect(tamperFindings([{ path: 'package.json', status: 'D' }], [], { ...tOpts, contract: c }).map((f) => f.code)).toContain('criterion-edit');
    expect(tamperFindings([{ path: 'pkg.json', from: 'package.json', status: 'R' }], [], { ...tOpts, contract: c }).map((f) => f.code)).toContain('criterion-edit');
    // without a contract, or with no script among the criteria, a package.json deletion is not criterion-edit
    expect(tamperFindings([{ path: 'package.json', status: 'D' }], [], tOpts).map((f) => f.code)).not.toContain('criterion-edit');
    const noScripts = contract({ criteria: [{ id: 'a', statement: 'a', check: { kind: 'command', command: 'node --test', timeoutSec: 5 } }] });
    expect(tamperFindings([{ path: 'package.json', status: 'D' }], [], { ...tOpts, contract: noScripts }).map((f) => f.code)).not.toContain('criterion-edit');
  });

  it('parseHunks records removed lines, keeps a deleted file under its old path, and never takes a "-- x" line for a header', () => {
    const diff = [
      'diff --git a/package.json b/package.json',
      '--- a/package.json',
      '+++ b/package.json',
      '@@ -1,3 +1,3 @@',
      '-    "check:rate": "node scripts/rate.js",',
      '+    "check:rate": "true",',
      'diff --git a/db.sql b/db.sql',
      '--- a/db.sql',
      '+++ b/db.sql',
      '@@ -1,2 +1,2 @@',
      '--- old comment',
      '+it.only("x")',
      'diff --git a/gone.txt b/gone.txt',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
    ].join('\n');
    const h = parseHunks(diff);
    expect(h.find((x) => x.path === 'package.json')).toMatchObject({ added: ['    "check:rate": "true",'], removed: ['    "check:rate": "node scripts/rate.js",'] });
    expect(h.find((x) => x.path === 'db.sql')).toMatchObject({ added: ['it.only("x")'], removed: ['-- old comment'] });
    expect(h.find((x) => x.path === 'gone.txt')).toMatchObject({ added: [], removed: ['bye'] });
  });

  it('the tamperCheck hook refuses a package.json delete, a whole-file rewrite, or a targeted edit of a script a criterion runs', () => {
    const view = { capabilities: { tools: ['edit', 'fs'], paths: { read: ['**'], write: ['**'], protected: [] }, network: 'none' as const, limits: { usd: 1, tokens: 1, calls: 1, wallMs: 1, depth: 1, iterations: 1 } }, blackboard: {}, hooks: [] };
    const enter = (input: Record<string, unknown>): SpanEvent => ({ span: 'ToolCall', stage: 'Enter', spanId: 's', run: { runId: 'r', invokeId: 'i', depth: 0 }, attempt: 1, input: input as SpanEvent['input'] });
    const hook = mandatoryHooks(manifest(), { permissions: DEFAULT_PERMISSIONS, contract: () => c }).find((h) => h.id === 'tamperCheck')!;
    const abort = [{ type: 'Abort', code: 'policy', reason: expect.stringMatching(/^tampering: /) }];
    expect(hook.handle(enter({ tool: 'fs', method: 'delete', path: 'package.json' }), view)).toMatchObject(abort);
    expect(hook.handle(enter({ tool: 'edit', method: 'call', path: 'package.json', args: [{ path: 'package.json', content: '{}' }] }), view)).toMatchObject([{ type: 'Abort', reason: expect.stringMatching(/whole-file write of package.json/) }]);
    expect(hook.handle(enter({ tool: 'edit', method: 'call', path: 'package.json', args: ['package.json', '{}'] }), view)).toMatchObject(abort);
    expect(hook.handle(enter({ tool: 'edit', method: 'call', path: 'package.json', args: [{ path: 'package.json', oldText: '"check:rate": "node scripts/rate.js"', newText: '"check:rate": "true"' }] }), view)).toMatchObject([{ type: 'Abort', reason: expect.stringMatching(/script check:rate is run by a criterion/) }]);
    expect(hook.handle(enter({ tool: 'edit', method: 'call', path: 'apps/web/package.json', args: [{ path: 'apps/web/package.json', oldText: '"precheck:rate": "x",', newText: '' }] }), view)).toMatchObject(abort);
    // a targeted edit that names no protected script passes the hook (the tamper gate still diffs the scripts)
    expect(hook.handle(enter({ tool: 'edit', method: 'call', path: 'package.json', args: [{ path: 'package.json', oldText: '"dependencies": {', newText: '"dependencies": {\n    "zod": "^3.0.0",' }] }), view)).toEqual([]);
    // no script among the criteria: package.json is an ordinary file
    const plain = mandatoryHooks(manifest(), { permissions: DEFAULT_PERMISSIONS, contract: () => contract({ criteria: [{ id: 'a', statement: 'a', check: { kind: 'command', command: 'node --test', timeoutSec: 5 } }] }) }).find((h) => h.id === 'tamperCheck')!;
    expect(plain.handle(enter({ tool: 'fs', method: 'delete', path: 'package.json' }), view)).toEqual([]);
    expect(packageScriptWriteProblem({ method: 'call', path: 'src/package.json.bak', args: [] }, criterionTargets(c))).toBeNull();
  });

  it('validatePlan: a goal file contract must be complete; a context hash needs its contract; PR approvals may not be in always', () => {
    const v = (p: Plan, o: Partial<Parameters<typeof validatePlan>[2]> = {}) => validatePlan(p, manifest(), { ...opts, ...o }).join('\n');
    const goal = (o: Partial<AchievementGoal>): AchievementGoal => ({ id: 'g', statement: 's', check: { command: 'node --test', timeoutSec: 60 }, commitment: 'single-minded', status: 'open', evidence: [], ...o });
    expect(v(deliveryPlan(), { goal: goal({ criteria: contract().criteria.filter((k) => !k.requires) }) })).toMatch(/incomplete contract/);
    expect(v(deliveryPlan({ contractHash: 'a'.repeat(64) }), { goal: goal({ contractHash: 'a'.repeat(64) }) })).toMatch(/incomplete contract/);
    expect(v(deliveryPlan(), { goal: goal({}) })).toBe('');
    expect(v(deliveryPlan({ contractHash: 'a'.repeat(64) }), { context: { contractHash: 'a'.repeat(64) } })).toMatch(/contract hash without the contract/);
    const loose = { always: ['read', 'edit', 'commit', 'git_push'], requiresApproval: ['open_pr'], never: ['merge'] };
    expect(v(deliveryPlan(), { permissions: loose })).toMatch(/git_push is listed in always/);
    expect(v(deliveryPlan(), { permissions: loose })).not.toMatch(/open_pr is listed in always/);
  });
});

// ── Stop (sprint 5 item 1) ────────────────────────────────────────────────────────────────────────────

const sys = { kind: 'system' as const, id: 'loop' };
const CHECK = { command: 'node --test', timeoutSec: 60 };
const goalOf = (id: string): AchievementGoal => ({ id, statement: 's', check: CHECK, commitment: 'single-minded', status: 'open', evidence: [] });
const body = (fingerprint: string, runId: string): Json => ({ command: CHECK.command, commandDigest: verifyCommandDigest(CHECK.command), timeoutSec: 30, exitCode: 0, outcome: 'passed', fingerprint, runId });

interface RunOpts {
  /** 'proven': verify.passed + evidence + goal.achieved. 'forged': goal.achieved with a well-formed proof and nothing behind it. */
  outcome?: 'proven' | 'forged' | 'open' | 'provisional';
  exit?: number | null;
  interrupted?: boolean;
}

function runEvents(runId: string, o: RunOpts = {}): { events: TeceraEvent[]; evidence: EvidenceRecord[] } {
  const events: TeceraEvent[] = [];
  let n = 0;
  const add = (kind: TeceraEvent['kind'], payload: JsonObject, trace: TeceraEvent['trace'] = {}) => events.push(event(kind, { id: `${runId}-e${++n}`, at: n, actor: sys, payload, trace, runId }));
  const g = { goalId: `g_${runId}` };
  const it1 = (stepId?: string) => ({ ...g, intentionId: `i_${runId}`, planId: 'p', ...(stepId ? { stepId } : {}) });
  const goal = goalOf(g.goalId);
  const key = `verify:${runId}:v:1`;
  const proof = { command: CHECK.command, exitCode: 0, fingerprint: 'fp1', evidenceKey: key, verifiedAt: 5 };
  add('run.started', { manifestHash: 'm' });
  add('goal.adopted', { goal: goal as unknown as JsonObject }, g);
  add('intention.pushed', { intention: { id: it1().intentionId } }, it1());
  const outcome = o.outcome ?? 'proven';
  if (outcome === 'proven' || outcome === 'provisional') add('verify.passed', { evidenceKey: key, fingerprint: 'fp1', exitCode: 0 }, it1('verify'));
  if (outcome === 'proven' || outcome === 'forged') {
    add('intention.done', { intention: { id: it1().intentionId } }, it1());
    add('goal.achieved', { goal: goal as unknown as JsonObject, proof }, g);
  }
  if (outcome === 'provisional') add('goal.provisional', { goal: { ...goal, provisional: true } as unknown as JsonObject, proof: { ...proof, fidelity: 'mocked' }, mocked: ['mail'], reason: 'mail is mocked' }, g);
  if (o.interrupted) add('run.interrupted', {});
  if (o.exit !== undefined && o.exit !== null) add('run.ended', { exitCode: o.exit });
  const b = body('fp1', runId);
  const evidence = outcome === 'proven' || outcome === 'provisional' ? [{ key, kind: 'gate.verify', runId, digest: digest(b), body: b, seq: 0 } as EvidenceRecord] : [];
  return { events, evidence };
}

/** An intact hash chain, as Ledger.verifyChain() reports it. */
const INTACT = { chain: { ok: true as const, length: 1 } };

const merge = (...xs: Array<{ events: TeceraEvent[]; evidence: EvidenceRecord[] }>) => ({ events: xs.flatMap((x) => x.events), evidence: xs.flatMap((x) => x.evidence) });

describe('Stop decision through the single-source proof (sprint 5 item 1)', () => {
  it('the fixture is genuinely proven: provenRun says achieved, Stop allows', () => {
    const r = runEvents('r1', { exit: 4 });
    expect(provenRun(r.events, r.evidence, 'r1')).toMatchObject({ achieved: true });
    const s = evaluateStopEvents(r.events, r.evidence, INTACT);
    expect(s.decision).toMatchObject({ decision: 'allow', exitCode: 0 });
    expect(s.decision.reason).toMatch(/run r1 proved its goal: `node --test` exited 0/);
  });

  it('a forged goal.achieved (well-formed proof, no verify evidence, no verify.passed) keeps Stop blocked', () => {
    const forged = runEvents('r1', { outcome: 'forged', exit: 4 });
    const s = evaluateStopEvents(forged.events, forged.evidence, INTACT);
    expect(s.decision).toMatchObject({ decision: 'block', exitCode: 2 });
    expect(s.decision.reason).toMatch(/Tecera run r1 for goal g_r1 is active without a goal.achieved proof/);
    // the evidence alone, without the verify.passed it must follow, still does not prove it
    const real = runEvents('r1', { exit: 4 });
    expect(evaluateStopEvents(forged.events, real.evidence, INTACT).decision.decision).toBe('block');
    // and the proof lifted from that event, handed to stopDecision without a verdict, never allows
    const proof = (forged.events.find((e) => e.kind === 'goal.achieved')!.payload as { proof: never }).proof;
    expect(stopDecision({ activeRun: { runId: 'r1', goalId: 'g_r1' }, achievedProof: proof }).decision).toBe('block');
  });

  it('goal.provisional keeps Stop blocked, and so does the provisional flag over any verdict', () => {
    const p = runEvents('r1', { outcome: 'provisional', exit: 4 });
    const s = evaluateStopEvents(p.events, p.evidence, INTACT);
    expect(s.decision.decision).toBe('block');
    expect(s.runs[0]!.achieved).toBe(false);
    const ok = runEvents('r1', { exit: 4 });
    const verdict = provenRun(ok.events, ok.evidence, 'r1');
    expect(stopDecision({ activeRun: { runId: 'r1' }, achievedProof: verdict.goals.g_r1!.proof, verdict })).toMatchObject({ decision: 'allow' });
    const blocked = stopDecision({ activeRun: { runId: 'r1' }, achievedProof: verdict.goals.g_r1!.proof, verdict, provisional: true });
    expect(blocked).toMatchObject({ decision: 'block', exitCode: 2 });
    expect(blocked.reason).toMatch(/provisional, never achieved/);
    expect(stopDecisionForRuns([{ run: { runId: 'r1' }, verdict: { ...verdict, provisional: true } }]).decision.decision).toBe('block');
  });

  it('every active run is evaluated: an older held run without proof blocks although the newest is proven', () => {
    const both = merge(runEvents('r1', { outcome: 'open', exit: 4 }), runEvents('r2', { exit: 4 }));
    expect(activeRunsOf(both.events).map((r) => [r.runId, r.state])).toEqual([['r1', 'held'], ['r2', 'held']]);
    const s = evaluateStopEvents(both.events, both.evidence, INTACT);
    expect(s.decision.decision).toBe('block');
    expect(s.decision.reason).toMatch(/run r1 for goal g_r1/);
    expect(s.runs.map((r) => [r.run.runId, r.achieved])).toEqual([['r1', false], ['r2', true]]);
    // interrupted (run.interrupted or exit 130) and still-running runs count; a run that ended otherwise does not
    const mixed = merge(runEvents('r1', { outcome: 'open', interrupted: true }), runEvents('r2', { outcome: 'open', exit: 130 }), runEvents('r3', { outcome: 'open', exit: 1 }), runEvents('r4', { exit: null }));
    expect(activeRunsOf(mixed.events).map((r) => [r.runId, r.state])).toEqual([['r1', 'interrupted'], ['r2', 'interrupted'], ['r4', 'running']]);
    expect(evaluateStopEvents(mixed.events, mixed.evidence, INTACT).runs.filter((r) => !r.achieved).map((r) => r.run.runId)).toEqual(['r1', 'r2']);
    // a failed old run is not active: the proven newest one alone decides
    const done = merge(runEvents('r1', { outcome: 'open', exit: 1 }), runEvents('r2', { exit: 4 }));
    expect(evaluateStopEvents(done.events, done.evidence, INTACT).decision.decision).toBe('allow');
    expect(evaluateStopEvents([], [], INTACT).decision).toMatchObject({ decision: 'allow', reason: 'no active Tecera run on this business case' });
  });

  it('a verdict for another run, or a broken hash chain, proves nothing', () => {
    const r = runEvents('r1', { exit: 4 });
    const verdict = provenRun(r.events, r.evidence, 'r1');
    expect(stopDecisionForRuns([{ run: { runId: 'r2' }, verdict }]).decision.decision).toBe('block');
    expect(evaluateStopEvents(r.events, r.evidence, { chain: { ok: false, brokenAtSeq: 2 } as never }).decision.decision).toBe('block');
  });

  it('evaluateStopLedger: ledgerProvenRun per active run over a real ledger; forged blocks; an unreadable ledger blocks', async () => {
    const load = async (x: { events: TeceraEvent[]; evidence: EvidenceRecord[] }) => {
      const l = new MemoryLedger();
      for (const ev of x.evidence) await l.evidence({ key: ev.key, kind: ev.kind, runId: ev.runId, body: ev.body });
      for (const e of x.events) await l.append(e);
      return l;
    };
    await expect(evaluateStopLedger(await load(runEvents('r1', { exit: 4 })))).resolves.toMatchObject({ decision: { decision: 'allow' } });
    await expect(evaluateStopLedger(await load(runEvents('r1', { outcome: 'forged', exit: 4 })))).resolves.toMatchObject({ decision: { decision: 'block', exitCode: 2 } });
    await expect(evaluateStopLedger(await load(merge(runEvents('r1', { outcome: 'open', exit: 4 }), runEvents('r2', { exit: 4 }))))).resolves.toMatchObject({ decision: { decision: 'block' } });
    const broken = {
      events: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('disk gone')) }) }),
      getEvidence: async () => null,
      verifyChain: async () => ({ ok: true as const, length: 0 }),
    };
    const s = await evaluateStopLedger(broken as never);
    expect(s.decision).toMatchObject({ decision: 'block', exitCode: 2 });
    expect(s.decision.reason).toMatch(/the ledger cannot be read: disk gone/);
    // a ledger without verifyChain fails closed per run
    const l = await load(runEvents('r1', { exit: 4 }));
    const noChain = { events: l.events.bind(l), getEvidence: l.getEvidence.bind(l) };
    await expect(evaluateStopLedger(noChain as never)).resolves.toMatchObject({ decision: { decision: 'block' } });
  });

  it('the chain is checked before the active-run set: a forged run.ended or an unverifiable ledger blocks with no run left active', async () => {
    const l = new MemoryLedger();
    const open = runEvents('r1', { outcome: 'open', exit: 4 });
    for (const e of open.events) await l.append(e);
    // a run.ended rewritten in place to exit 1 makes the open run look finished
    const log = (l as unknown as { log: Array<TeceraEvent & { payload: JsonObject }> }).log;
    log.find((e) => e.kind === 'run.ended')!.payload = { exitCode: 1 };
    const tampered: TeceraEvent[] = [];
    for await (const e of l.events()) tampered.push(e);
    expect(activeRunsOf(tampered)).toEqual([]);
    const s = await evaluateStopLedger(l);
    expect(s.decision).toMatchObject({ decision: 'block', exitCode: 2 });
    expect(s.decision.reason).toMatch(/hash chain is broken at seq/);
    // the same events, pure: a broken or absent chain blocks although no run looks active
    expect(evaluateStopEvents(tampered, [], { chain: { ok: false, brokenAtSeq: 4 } }).decision.decision).toBe('block');
    expect(evaluateStopEvents(tampered, [], {} as never).decision.reason).toMatch(/hash chain was not verified/);
    expect(evaluateStopEvents(tampered, [], INTACT).decision.decision).toBe('allow');
    // a ledger without verifyChain, or whose verifyChain throws, blocks even when nothing is active
    const empty = new MemoryLedger();
    await expect(evaluateStopLedger(empty)).resolves.toMatchObject({ decision: { decision: 'allow' } });
    await expect(evaluateStopLedger({ events: empty.events.bind(empty), getEvidence: empty.getEvidence.bind(empty) } as never)).resolves.toMatchObject({ decision: { decision: 'block', reason: expect.stringMatching(/does not support chain verification/) } });
    const throwing = { events: empty.events.bind(empty), getEvidence: empty.getEvidence.bind(empty), verifyChain: async () => Promise.reject(new Error('io')) };
    await expect(evaluateStopLedger(throwing as never)).resolves.toMatchObject({ decision: { decision: 'block', reason: expect.stringMatching(/cannot be verified: io/) } });
  });
});
