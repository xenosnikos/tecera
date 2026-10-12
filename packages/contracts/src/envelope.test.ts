import { describe, expect, it } from 'vitest';
import {
  changeWithin,
  contractHash,
  contractProblem,
  describeUnexpected,
  envelopeAllows,
  envelopePathMatches,
  envelopeProblem,
  statedAllows,
  statedEnvelope,
  unexpectedChanges,
  validatePlanShape,
  type AcceptanceContract,
  type ChangePath,
  type Plan,
} from './index.js';

const contract = (envelope?: ChangePath[]): AcceptanceContract => ({
  goalId: 'g',
  statement: 'slugify collapses separators',
  criteria: [{ id: 'tests', statement: 'the suite passes', check: { kind: 'command', command: 'node --test', timeoutSec: 60 } }],
  outOfScope: [],
  assumptions: [],
  ...(envelope ? { envelope } : {}),
});

describe('the change-path envelope is part of the accepted contract', () => {
  const env: ChangePath[] = [{ path: 'src/slug.js', ops: ['modify'] }, { path: 'src/reports/*.js', ops: ['create', 'modify'] }];

  it('is hashed into the contract hash: adding, widening or narrowing it is another contract', () => {
    const none = contractHash(contract());
    const stated = contractHash(contract(env));
    expect(stated).not.toBe(none);
    expect(contractHash(contract([...env, { path: 'src/config.js', ops: ['create'] }]))).not.toBe(stated);
    expect(contractHash(contract([{ path: 'src/slug.js', ops: ['modify', 'delete'] }, env[1]!]))).not.toBe(stated);
    expect(contractHash(contract([env[0]!]))).not.toBe(stated);
    // the order of entries and of operations is not part of what was agreed
    expect(contractHash(contract([{ path: 'src/reports/*.js', ops: ['modify', 'create'] }, env[0]!]))).toBe(stated);
  });

  it('a contract without an envelope keeps exactly the hash it had before envelopes existed', () => {
    // sha256 of the canonical JSON of {goalId, statement, criteria, outOfScope, assumptions}: no envelope key at all
    const c = contract();
    expect(contractHash(c)).toBe(contractHash({ ...c, envelope: undefined } as AcceptanceContract));
    expect(contractProblem(c)).toBeNull();
    expect(statedEnvelope(c, null)).toBeNull();
  });

  it('a malformed envelope makes the contract malformed', () => {
    const bad = (e: unknown) => contractProblem({ ...contract(), envelope: e });
    expect(bad([])).toMatch(/lists no path/);
    expect(bad('src/**')).toMatch(/must be a list/);
    expect(bad([{ path: 'src/a.js' }])).toMatch(/allows no operation/);
    expect(bad([{ path: 'src/a.js', ops: [] }])).toMatch(/allows no operation/);
    expect(bad([{ path: 'src/a.js', ops: ['rename'] }])).toMatch(/unknown operation/);
    expect(bad([{ path: 'src/a.js', ops: ['modify', 'modify'] }])).toMatch(/twice/);
    expect(bad([{ path: 'src/a.js', ops: ['modify'] }, { path: 'src/a.js', ops: ['delete'] }])).toMatch(/listed twice/);
    expect(bad([{ path: 'src/a.js', ops: ['modify'], recursive: true }])).toMatch(/unknown field/);
    for (const p of ['/etc/passwd', '../x', 'src/../x', './src/a.js', 'src//a.js', 'src\\a.js', 'C:/x', 'src/a.js\n', '']) expect(bad([{ path: p, ops: ['modify'] }]), JSON.stringify(p)).not.toBeNull();
    // a glob must name where it applies: nothing that could cover the whole repository
    for (const p of ['**', '*', '**/*.js', '*.js', '*/a.js']) expect(bad([{ path: p, ops: ['modify'] }]), p).toMatch(/starts with a wildcard/);
    for (const p of ['src/a?.js', 'src/{a,b}.js', 'src/[ab].js']) expect(bad([{ path: p, ops: ['modify'] }]), p).toMatch(/wildcard other than/);
    expect(bad([{ path: 'src/a**.js', ops: ['modify'] }])).toMatch(/\*\* inside a segment/);
    expect(envelopeProblem(env)).toBeNull();
    expect(envelopeProblem([{ path: 'src/**', ops: ['create', 'modify', 'delete'] }])).toBeNull();
  });
});

describe('matching and the unexpected-path check', () => {
  it('an exact path matches only itself; a glob only at the depth it names', () => {
    expect(envelopePathMatches('README.md', 'README.md')).toBe(true);
    expect(envelopePathMatches('README.md', 'docs/README.md')).toBe(false);
    expect(envelopePathMatches('src/*.js', 'src/a.js')).toBe(true);
    expect(envelopePathMatches('src/*.js', 'src/deep/a.js')).toBe(false);
    expect(envelopePathMatches('src/*.js', 'src/a.json')).toBe(false);
    expect(envelopePathMatches('src/**', 'src/deep/er/a.js')).toBe(true);
    expect(envelopePathMatches('src/**', 'src')).toBe(false);
    expect(envelopePathMatches('src/**', 'srcx/a.js')).toBe(false);
    expect(envelopePathMatches('src/**/index.js', 'src/index.js')).toBe(true);
    expect(envelopePathMatches('src/**/index.js', 'src/a/b/index.js')).toBe(true);
    expect(envelopePathMatches('src/**/index.js', 'src/a/b/other.js')).toBe(false);
    expect(envelopePathMatches('src/a.b.js', 'src/aXb.js')).toBe(false);
  });

  it('operations are separate: allowed to modify is not allowed to delete or create', () => {
    const env: ChangePath[] = [{ path: 'src/slug.js', ops: ['modify'] }, { path: 'src/new/*.js', ops: ['create'] }];
    expect(envelopeAllows(env, 'src/slug.js', 'modify')).toBe(true);
    expect(envelopeAllows(env, 'src/slug.js', 'delete')).toBe(false);
    expect(envelopeAllows(env, 'src/slug.js', 'create')).toBe(false);
    expect(envelopeAllows(env, 'src/new/a.js', 'create')).toBe(true);
    expect(envelopeAllows(env, 'src/new/a.js', 'modify')).toBe(false);
    expect(envelopeAllows(env, 'src/config.js', 'create')).toBe(false);
  });

  it('unexpectedChanges lists what the envelope does not allow; both sides of a rename are judged, and an ignored file is never allowed', () => {
    const stated = statedEnvelope(contract([{ path: 'src/slug.js', ops: ['modify'] }, { path: 'src/renamed.js', ops: ['create'] }]), null)!;
    const got = unexpectedChanges(stated, [
      { path: 'src/slug.js', op: 'modify' },
      { path: 'src/config.js', op: 'create' },
      { path: 'src/old.js', op: 'delete' },
      { path: 'src/renamed.js', op: 'create' },
      { path: 'node_modules/.cache/x', op: 'ignored' },
    ]);
    expect(got).toEqual([{ path: 'src/config.js', op: 'create' }, { path: 'src/old.js', op: 'delete' }, { path: 'node_modules/.cache/x', op: 'ignored' }]);
    expect(describeUnexpected(got)).toBe('src/config.js (create), src/old.js (delete), node_modules/.cache/x (ignored)');
    expect(describeUnexpected(Array.from({ length: 12 }, (_, i) => ({ path: `f${i}`, op: 'create' as const })), 2)).toBe('f0 (create), f1 (create), and 10 more');
  });

  it('a step is held to its own declared subset AND to the contract: neither layer can make up for the other', () => {
    const c = contract([{ path: 'src/**', ops: ['modify'] }]);
    const step = { changes: [{ path: 'src/slug.js', ops: ['modify', 'delete'] as ('modify' | 'delete')[] }] };
    const stated = statedEnvelope(c, step)!;
    expect(stated.source).toBe('step');
    expect(statedAllows(stated, 'src/slug.js', 'modify')).toBe(true);
    // the step declared it, the contract did not allow it
    expect(statedAllows(stated, 'src/slug.js', 'delete')).toBe(false);
    // the contract allows it, the step did not declare it
    expect(statedAllows(stated, 'src/other.js', 'modify')).toBe(false);
    expect(statedEnvelope(c, { changes: undefined })!.source).toBe('contract');
    expect(statedEnvelope(contract(), step)!.layers).toHaveLength(1);
  });
});

describe('a plan can narrow the envelope, never widen it', () => {
  const outer: ChangePath[] = [{ path: 'src/slug.js', ops: ['modify'] }, { path: 'src/reports/**', ops: ['create', 'modify'] }];
  it('changeWithin: inside when every operation is allowed on every path the entry can match', () => {
    expect(changeWithin({ path: 'src/slug.js', ops: ['modify'] }, outer)).toBeNull();
    expect(changeWithin({ path: 'src/reports/q3.js', ops: ['create'] }, outer)).toBeNull();
    expect(changeWithin({ path: 'src/reports/2026/*.js', ops: ['create', 'modify'] }, outer)).toBeNull();
    expect(changeWithin({ path: 'src/reports/**', ops: ['modify'] }, outer)).toBeNull();
  });
  it('changeWithin: a new path, a new operation, or a wider glob is refused', () => {
    expect(changeWithin({ path: 'src/config.js', ops: ['create'] }, outer)).toMatch(/src\/config\.js \(create\) is not inside the accepted envelope/);
    expect(changeWithin({ path: 'src/slug.js', ops: ['modify', 'delete'] }, outer)).toMatch(/src\/slug\.js \(delete\)/);
    expect(changeWithin({ path: 'src/reports/q3.js', ops: ['delete'] }, outer)).toMatch(/\(delete\)/);
    expect(changeWithin({ path: 'src/**', ops: ['modify'] }, outer)).toMatch(/src\/\*\* \(modify\)/);
    expect(changeWithin({ path: 'src/*.js', ops: ['modify'] }, outer)).toMatch(/not inside/);
    expect(changeWithin({ path: 'src/reportsx/*.js', ops: ['create'] }, outer)).toMatch(/not inside/);
  });
  it('validatePlanShape: step.changes must be a well-formed envelope on a worker step', () => {
    const plan = (changes: unknown, kind: 'worker' | 'gate.verify' = 'worker'): Plan => ({
      id: 'p', trigger: { kind: 'goal.adopted' }, context: [], goalKinds: [], origin: 'generated', status: 'candidate',
      steps: [{ id: 'edit', kind, dependsOn: [], inputs: {}, changes: changes as ChangePath[] }],
      allowedModels: {}, permissions: { tools: ['edit'], write: ['src/**'], approvals: [] }, budget: {},
    });
    expect(validatePlanShape(plan([{ path: 'src/a.js', ops: ['modify'] }]))).toEqual([]);
    expect(validatePlanShape(plan([{ path: '**', ops: ['modify'] }])).join()).toMatch(/step edit changes: .*starts with a wildcard/);
    expect(validatePlanShape(plan([])).join()).toMatch(/lists no path/);
    expect(validatePlanShape(plan([{ path: 'src/a.js', ops: ['modify'] }], 'gate.verify')).join()).toMatch(/is not a worker step/);
  });
});
