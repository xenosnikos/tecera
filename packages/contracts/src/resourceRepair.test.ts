import { describe, expect, it } from 'vitest';
import { capabilityInventoryOf, event, locatorProblem, resourceProblem, resourceRegistryOf, type JsonObject, type ProvisionedResource, type ProvisioningAllowance, type TeceraEvent } from './index.js';

/**
 * Review findings on the resource rules, requested by the planner, policy and runtime lanes: a credential
 * encoded more than once (or next to a malformed escape) is still found in a locator; a teardown may not
 * carry a known secret; a resource counts against the run its event was recorded in, never one its payload
 * names.
 */

const ALLOW: ProvisioningAllowance = { scope: 'local', kinds: ['tmpdir', 'git-remote', 'sqlite', 'http-stub'], maxResources: 2, ttlSec: 3600 };
const sys = { kind: 'system' as const, id: 'loop' };

const resource = (o: Partial<ProvisionedResource> = {}): ProvisionedResource => ({
  id: 'res1',
  capability: 'db',
  kind: 'sqlite',
  provider: 'local',
  locator: '/tmp/tecera-res/res1/db.sqlite',
  teardown: "rm -rf -- '/tmp/tecera-res/res1'",
  createdAt: 1000,
  expiresAt: 1000 + 3_600_000,
  transfer: 'pending',
  ...o,
});

let n = 0;
const provisioned = (r: ProvisionedResource, runId: string, goalId = 'g'): TeceraEvent =>
  event('resource.provisioned', { id: `rp${++n}`, at: n, actor: sys, runId, trace: { goalId }, payload: { resource: r as unknown as JsonObject } });

describe('locator: every percent-decoded form, to a fixed point', () => {
  it('a double- or triple-encoded secret-named parameter or userinfo is refused; a plain path is fine', () => {
    expect(locatorProblem('http://127.0.0.1:4000/x?token%3Dabc')).toMatch(/secret-named/);
    expect(locatorProblem('http://127.0.0.1:4000/x?token%253Dabc')).toMatch(/secret-named/);
    expect(locatorProblem('http://127.0.0.1:4000/x?token%25253Dabc')).toMatch(/secret-named/);
    expect(locatorProblem('http:%252F%252Fuser:pw%2540127.0.0.1/x')).toMatch(/userinfo/);
    expect(locatorProblem('/tmp/tecera-res/res1/db.sqlite')).toBeNull();
    expect(locatorProblem('/tmp/a%20b/c')).toBeNull();
  });
  it('a malformed escape elsewhere does not stop the valid ones from being decoded', () => {
    expect(locatorProblem('/tmp/%ZZ?password%3Dsecret')).toMatch(/secret-named/);
    expect(locatorProblem('/tmp/%E0%A4%A?x=%73ession%3D1')).toMatch(/secret-named/);
    expect(locatorProblem('/tmp/%ZZ/plain')).toBeNull();
  });
  it('a known secret encoded twice is found', () => {
    const secrets = (v: string) => v.includes('hunter2-secret-value');
    expect(locatorProblem('/tmp/hunter2%252Dsecret%252Dvalue', secrets)).toMatch(/known secret/);
  });
});

describe('locator: a local place only (review repair)', () => {
  it('an absolute path or a loopback URL is a locator; a remote host, a network path, a scheme-less or relative form is not', () => {
    for (const ok of ['/tmp/tecera-res/r.git', 'http://127.0.0.1:8123/', 'http://127.0.0.9/x', 'http://localhost:5000/api', 'http://[::1]:7000/', 'file:///tmp/r.git', 'postgres://127.0.0.1:5432/db']) expect(locatorProblem(ok), ok).toBeNull();
    for (const bad of ['https://attacker.example/x.git', 'ssh://github.com/o/r.git', 'git@github.com:o/r.git', '//attacker.example/share', 'ext::sh -c touch% /tmp/pwned', 'file://attacker.example/x', 'http://127.0.0.1.attacker.example/', 'relative/path', 'C:\\x']) {
      const why = locatorProblem(bad);
      expect(why, bad).toMatch(/neither an absolute path nor a loopback URL/);
      expect(why).not.toContain(bad);
    }
    // the registry never lists such a resource as a pending debt the runtime would push to
    const reg = resourceRegistryOf([provisioned(resource({ kind: 'git-remote', capability: 'origin', locator: 'https://attacker.example/x.git' }), 'r1')], { runId: 'r1', allowance: ALLOW });
    expect(reg.pending).toEqual([]);
    expect(reg.problems.join(' ')).toMatch(/neither an absolute path nor a loopback URL/);
  });
  it('decoding runs to the fixed point: a value encoded six times is still found', () => {
    let v = 'token=abc';
    for (let i = 0; i < 6; i++) v = encodeURIComponent(v);
    expect(locatorProblem(`/tmp/x?${v}`)).toMatch(/secret-named/);
    const secrets = (s: string) => s.includes('hunter2-secret-value');
    let k = 'hunter2-secret-value';
    for (let i = 0; i < 6; i++) k = encodeURIComponent(k).replace(/-/g, '%2D');
    expect(locatorProblem(`/tmp/${k}`, secrets)).toMatch(/known secret/);
  });
});

describe('teardown: the same credential rules as the locator (review repair)', () => {
  it('an encoded known secret, a credential shape or a control character in the teardown makes the resource unrecordable', () => {
    const secrets = (v: string) => v.includes('TOPSECRET-123456');
    expect(resourceProblem(resource({ teardown: 'rm -rf /tmp/TOPSECRET%252D123456' }), ALLOW, secrets)).toMatch(/teardown carries a known secret/);
    expect(resourceProblem(resource({ teardown: 'curl -H "Authorization: Bearer abcdefgh1234" -X DELETE http://127.0.0.1:9/x' }), ALLOW)).toMatch(/teardown carries an authorization value/);
    expect(resourceProblem(resource({ teardown: 'curl http://127.0.0.1:9/x?api%5Fkey%3Dabc' }), ALLOW)).toMatch(/teardown carries a secret-named parameter/);
    expect(resourceProblem(resource({ teardown: 'rm -rf /tmp/x\nrm -rf ~' }), ALLOW)).toMatch(/teardown carries control characters/);
    // what the local provisioner records stays recordable
    expect(resourceProblem(resource({ kind: 'http-stub', locator: 'http://127.0.0.1:4100', teardown: `kill -TERM "$(cat '/tmp/tecera-res/res1/stub.pid')"; rm -rf -- '/tmp/tecera-res/res1'` }), ALLOW, secrets)).toBeNull();
  });
});

describe('teardown: no known secret', () => {
  it('a teardown carrying a known secret makes the resource unrecordable; without the predicate it is unchecked', () => {
    const secrets = (v: string) => v.includes('TOPSECRET-123456');
    expect(resourceProblem(resource({ teardown: 'curl -H "auth: TOPSECRET-123456" -X DELETE http://127.0.0.1:9/x' }), ALLOW, secrets)).toMatch(/teardown carries a known secret/);
    expect(resourceProblem(resource(), ALLOW, secrets)).toBeNull();
    // the inventory and the registry use the same rule
    const evs = [provisioned(resource({ teardown: 'rm -rf TOPSECRET-123456' }), 'r1')];
    expect(capabilityInventoryOf(evs, { runId: 'r1', allowance: ALLOW, secrets }).byId.db).toBeUndefined();
    expect(resourceRegistryOf(evs, { runId: 'r1', allowance: ALLOW, secrets }).problems.join(' ')).toMatch(/teardown carries a known secret/);
  });
});

describe('a resource counts against the run its event was recorded in', () => {
  it('payload runIds that differ from the event cannot spread one run past maxResources (registry)', () => {
    const evs = [1, 2, 3].map((i) => provisioned(resource({ id: `res${i}`, runId: `elsewhere${i}` }), 'r1'));
    const reg = resourceRegistryOf(evs, { runId: 'r1', allowance: ALLOW });
    expect(reg.resources.map((r) => r.runId)).toEqual(['r1', 'r1', 'r1']);
    expect(reg.overAllowance).toEqual(['res3']);
    expect(reg.problems.join(' ')).toMatch(/names run elsewhere1 but was recorded in run r1/);
    expect(reg.problems.join(' ')).toMatch(/provisioned more than 2 resources/);
    // a goal the payload names differently is reported, and the event's goal is the one listed
    const g = resourceRegistryOf([provisioned(resource({ goalId: 'other' }), 'r1', 'g')], { runId: 'r1', allowance: ALLOW });
    expect(g.resources[0]!.goalId).toBe('g');
    expect(g.problems.join(' ')).toMatch(/names goal other but was recorded for goal g/);
  });
  it('the inventory never takes a resource whose payload names another run as provisioning anything', () => {
    const inv = capabilityInventoryOf([provisioned(resource({ runId: 'elsewhere' }), 'r1')], { runId: 'r1', allowance: ALLOW });
    expect(inv.byId.db).toBeUndefined();
    expect(inv.problems.join(' ')).toMatch(/names run elsewhere but was recorded in run r1/);
    // the same resource, consistent with its event, is provisioned
    expect(capabilityInventoryOf([provisioned(resource({ runId: 'r1' }), 'r1')], { runId: 'r1', allowance: ALLOW }).byId.db).toMatchObject({ state: 'provisioned', resourceId: 'res1' });
    // and past maxResources in the event's run, the third is not
    const three = [1, 2, 3].map((i) => provisioned(resource({ id: `res${i}`, capability: `c${i}`, runId: 'r1' }), 'r1'));
    expect(Object.keys(capabilityInventoryOf(three, { runId: 'r1', allowance: ALLOW }).byId)).toEqual(['c1', 'c2']);
  });
});

describe('a refused resource is still a debt (sweep repair)', () => {
  it('a resource without a teardown, out of the allowance or with a credential in its locator stays listed (refused), never pending, and never repeats what was refused', () => {
    const evs = [
      provisioned(resource({ id: 'res_nt', teardown: '' }), 'rd'),
      provisioned(resource({ id: 'res_kind', kind: 'postgres' }), 'rd'),
      provisioned(resource({ id: 'res_cred', locator: 'http://admin:hunter2@127.0.0.1:9/' }), 'rd'),
      provisioned(resource({ id: 'res_ok' }), 'rd'),
    ];
    const reg = resourceRegistryOf(evs, { runId: 'rd', allowance: ALLOW });
    expect(reg.resources.map((r) => r.id)).toEqual(['res_nt', 'res_kind', 'res_cred', 'res_ok']);
    expect(reg.refused).toEqual(['res_nt', 'res_kind', 'res_cred']);
    expect(reg.pending.map((r) => r.id)).toEqual(['res_ok']);
    expect(reg.byId.res_nt).toMatchObject({ teardown: '', transfer: 'pending', runId: 'rd', goalId: 'g' });
    expect(reg.byId.res_kind).toMatchObject({ kind: 'postgres', locator: '/tmp/tecera-res/res1/db.sqlite' });
    expect(reg.byId.res_cred!.locator).toBe('');
    expect(JSON.stringify(reg)).not.toContain('hunter2');
    expect(reg.problems).toHaveLength(3);
    // a human or the system can still settle the debt; it never counts as provisioned
    const released = event('resource.released', { id: 'rr1', at: 99, actor: sys, runId: 'rd', trace: {}, payload: { resourceId: 'res_nt', teardownExit: 0, reason: 'x' } });
    expect(resourceRegistryOf([...evs, released], { runId: 'rd', allowance: ALLOW }).byId.res_nt!.transfer).toBe('released');
    expect(capabilityInventoryOf(evs.slice(0, 3), { runId: 'rd', allowance: ALLOW }).byId.db).toBeUndefined();
  });
});
