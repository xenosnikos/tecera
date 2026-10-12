import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FIXTURES_DIR, globRegExp, hiddenFilesOf, loadScenario, loadScenarios, matchesAnyGlob, parseScenario, ScenarioError, scenarioProblems, type ScenarioSpec } from './scenario.js';

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

const fixture = (name: string): string => join(FIXTURES_DIR, name);
const raw = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(fixture(name), 'scenario.json'), 'utf8')) as Record<string, unknown>;

/** A copy of a fixture whose scenario.json (or files) a test may break. */
function copyOf(name: string, edit?: (doc: Record<string, unknown>, dir: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'bench-sc-'));
  temps.push(root);
  const dir = join(root, name);
  cpSync(fixture(name), dir, { recursive: true });
  if (edit) {
    const doc = raw(name);
    edit(doc, dir);
    writeFileSync(join(dir, 'scenario.json'), JSON.stringify(doc));
  }
  return dir;
}

describe('scenario schema', () => {
  it('parses every shipped scenario.json and fills defaults', () => {
    const s = parseScenario(raw('01-fix-failing-test'));
    expect(s).toMatchObject({ id: '01-fix-failing-test', number: 1, axis: 'autonomy', traps: [], interventions: [], connections: { declared: [], needs: [] } });
    expect(s.hidden[0]).toMatchObject({ requires: [], fidelity: 'real', failsAtBase: true });
  });

  it.each([
    ['an unknown top-level key', (d: Record<string, unknown>) => void (d.extra = 1), /Unrecognized key/],
    ['an unknown key in a hidden criterion', (d: Record<string, unknown>) => void ((d.hidden as Array<Record<string, unknown>>)[0]!.weight = 2), /Unrecognized key/],
    ['an unknown pass rule', (d: Record<string, unknown>) => void (d.pass = [{ rule: 'vibes' }]), /pass\.0/],
    ['a canary that is not a TECERA_CANARY_ string', (d: Record<string, unknown>) => void (d.traps = [{ kind: 'canary-secret', plantedIn: 'README.md', canary: 'sk-live-123' }]), /canary/],
    ['a trap path escaping the repository', (d: Record<string, unknown>) => void (d.traps = [{ kind: 'protected-file', path: '../x', why: 'w' }]), /inside the repository/],
    ['no hidden criterion', (d: Record<string, unknown>) => void (d.hidden = []), /hidden/],
    ['an unknown fidelity', (d: Record<string, unknown>) => void ((d.hidden as Array<Record<string, unknown>>)[0]!.fidelity = 'simulated'), /fidelity/],
    ['an unknown intervention', (d: Record<string, unknown>) => void (d.interventions = [{ kind: 'reboot', atStep: 1 }]), /interventions\.0/],
  ])('refuses %s', (_name, edit, why) => {
    const d = raw('01-fix-failing-test');
    edit(d);
    expect(() => parseScenario(d)).toThrow(ScenarioError);
    expect(() => parseScenario(d)).toThrow(why);
  });
});

describe('scenario cross-checks against the manifest', () => {
  const s4 = (): ScenarioSpec & { policy: ReturnType<typeof loadScenario>['policy'] } => loadScenario(fixture('04-needs-db'));

  it('the shipped fixtures have none', () => {
    for (const s of loadScenarios()) expect(scenarioProblems(s, s.policy), s.id).toEqual([]);
  });

  it('a need the gap ladder resolves differently is refused (sqlite outside the allowance would be mocked, not provisioned)', () => {
    const s = s4();
    expect(scenarioProblems(s, { ...s.policy, allowance: { ...s.policy.allowance, kinds: ['tmpdir'] } })).toEqual(['need db (sqlite) resolves to mock under the manifest, the scenario expects provision']);
    expect(scenarioProblems(s, { ...s.policy, allowance: { ...s.policy.allowance, scope: 'none' } })[0]).toMatch(/resolves to mock/);
  });

  it('declared connections must be exactly the manifest\'s', () => {
    const s = s4();
    expect(scenarioProblems(s, { ...s.policy, connections: { db: { kind: 'sqlite', mockable: true } } })[0]).toMatch(/declared connections \[\] are not the manifest's \[db\]/);
  });

  it('pass rules and interventions must name what the scenario declares; a protected-file trap must be protected', () => {
    const s = s4();
    const bad: ScenarioSpec = {
      ...s,
      pass: [...s.pass, { rule: 'criterionFidelity', tag: 'nope', fidelity: 'real' }, { rule: 'resourcePending', kind: 'sqlite', capability: 'cache' }, { rule: 'auditAnswered' }],
      interventions: [{ kind: 'amend', criterion: 'ghost', afterStep: 1, statement: 's', check: { command: 'true', timeoutSec: 1 }, reason: 'r' }],
      traps: [{ kind: 'protected-file', path: 'src/sessions.js', why: 'w' }],
    };
    expect(scenarioProblems(bad, s.policy)).toEqual([
      'pass rule criterionFidelity names unknown tag nope',
      'pass rule resourcePending names cache, which is not a need',
      'pass rule auditAnswered without audit questions',
      'intervention amends ghost, which is not a hidden criterion',
      'trap src/sessions.js is not a protected path in the manifest',
    ]);
  });
});

describe('loadScenario', () => {
  it('loads a fixture with its manifest policy and paths', () => {
    const s = loadScenario(fixture('06-tempting-test'));
    expect(s.policy.protectedPaths).toContain('**/test/**');
    expect(s.policy.allowedChanges).toEqual(['src/**']);
    expect(s.policy.verify).toEqual({ command: 'node --test', timeoutSec: 300 });
    expect(s.repoDir).toBe(join(fixture('06-tempting-test'), 'repo'));
  });

  it.each([
    ['an id that is not the directory name', (d: Record<string, unknown>) => void (d.id = '06-other'), /is not its directory name/],
    ['a number that does not match the id', (d: Record<string, unknown>) => void (d.number = 7), /does not match id/],
    ['a missing goal file', (d: Record<string, unknown>) => void (d.request = { kind: 'goal', id: 'nope' }), /goal file .*nope\.goal\.md is missing/],
    ['a hidden check whose file is not in hidden/', (d: Record<string, unknown>) => void ((d.hidden as Array<{ check: { command: string } }>)[1]!.check.command = 'node --test bench-hidden/missing.test.js'), /runs bench-hidden\/missing\.test\.js/],
    ['a missing reference patch', (d: Record<string, unknown>) => void (d.reference = { expect: 'pass', patches: ['nope.patch'] }), /reference patch nope\.patch is missing/],
    ['a trap file that does not exist', (d: Record<string, unknown>) => void (d.traps = [{ kind: 'protected-file', path: 'test/gone.test.js', why: 'w' }]), /trap file test\/gone\.test\.js is missing/],
  ])('refuses %s', (_name, edit, why) => {
    const dir = copyOf('06-tempting-test', (d) => edit(d));
    expect(() => loadScenario(dir)).toThrow(why);
  });

  it('refuses a planted canary or instruction that is not in the planted file', () => {
    const dir = copyOf('07-planted');
    writeFileSync(join(dir, 'repo', 'README.md'), '# thermo\n');
    expect(() => loadScenario(dir)).toThrow(/does not carry the planted instruction marker.*does not carry the canary/);
  });

  it('refuses a manifest that does not parse', () => {
    const dir = copyOf('06-tempting-test');
    writeFileSync(join(dir, 'repo', 'tecera.json'), JSON.stringify({ schemaVersion: 1 }));
    expect(() => loadScenario(dir)).toThrow(/repo\/tecera\.json/);
  });
});

describe('globs and hidden files', () => {
  it('follow gitignore semantics: a pattern without a slash matches at any depth, ** spans directories', () => {
    expect(matchesAnyGlob('package.json', ['**/package.json'])).toBe('**/package.json');
    expect(matchesAnyGlob('a/b/package.json', ['**/package.json'])).toBe('**/package.json');
    expect(matchesAnyGlob('test/calendar.test.js', ['**/*.test.*'])).toBe('**/*.test.*');
    expect(matchesAnyGlob('./src/a/b.js', ['src/**'])).toBe('src/**');
    expect(matchesAnyGlob('srcx/a.js', ['src/**'])).toBeNull();
    expect(matchesAnyGlob('.tecera/goals/x.goal.md', ['.tecera/**'])).toBe('.tecera/**');
    expect(matchesAnyGlob('nested/tecera.json', ['tecera.json'])).toBe('tecera.json');
    expect(matchesAnyGlob('src/x.lock', ['**/*.{lock,lockb}'])).toBe('**/*.{lock,lockb}');
    expect(globRegExp('a?.js').test('ab.js')).toBe(true);
    expect(globRegExp('a?.js').test('a/.js')).toBe(false);
  });

  it('hiddenFilesOf names the bench-hidden files a command runs', () => {
    expect(hiddenFilesOf('node --test bench-hidden/a.test.js bench-hidden/sub/b.test.js test/c.test.js')).toEqual(['a.test.js', 'sub/b.test.js']);
    expect(hiddenFilesOf('node --test test/x.js')).toEqual([]);
  });
});
