import { describe, expect, it } from 'vitest';
import type { AcceptanceContract, CapabilityRecord, ProvisioningAllowance } from '@tecera/contracts';
import { buildInventory, requiredCapabilities } from './inventory.js';
import type { Connections } from './probe.js';

const ALLOW: ProvisioningAllowance = { scope: 'local', kinds: ['tmpdir', 'git-remote', 'sqlite', 'http-stub'], maxResources: 4, ttlSec: 3600 };

const CONNECTIONS: Connections = {
  db: { kind: 'sqlite', probe: 'test -f db', mockable: true },
  mail: { kind: 'mail', auth: 'env:MAIL_KEY', mockable: true },
  payments: { kind: 'payments', probe: 'curl -f https://pay', mockable: false },
  tracker: { kind: 'tracker', probe: 'gh auth status', mockable: true },
};

const contract: AcceptanceContract = {
  goalId: 'g1',
  statement: 'persist sessions and send a welcome email',
  criteria: [
    { id: 'persists', statement: 'sessions persist', check: { kind: 'command', command: 'npm test -- sessions', timeoutSec: 60 }, requires: ['db'] },
    { id: 'welcomes', statement: 'a welcome mail goes out', check: { kind: 'command', command: 'npm test -- mail', timeoutSec: 60 }, requires: ['mail', 'db'] },
    { id: 'charges', statement: 'payment taken', check: { kind: 'command', command: 'npm test -- pay', timeoutSec: 60 }, requires: ['payments'] },
  ],
  outOfScope: [],
  assumptions: [],
};

const probed = (id: string, kind: string, exitCode: number): CapabilityRecord => ({ id, kind, state: exitCode === 0 ? 'available' : 'missing', probe: { command: 'p', exitCode } });

describe('inventory builder: the gap ladder per need', () => {
  it('requiredCapabilities lists the ids the criteria require, once each, sorted', () => {
    expect(requiredCapabilities(contract)).toEqual(['db', 'mail', 'payments']);
  });

  it('use when the probe exited 0; provision a missing provisionable kind; mock a missing mockable one; ask otherwise', () => {
    const inv = buildInventory({ connections: CONNECTIONS, allowance: ALLOW, required: requiredCapabilities(contract), probes: [probed('db', 'sqlite', 0), probed('mail', 'mail', 1), probed('payments', 'payments', 7)], contract });
    expect(inv.decisions.map((d) => [d.id, d.state, d.resolution])).toEqual([
      ['db', 'available', 'use'],
      ['mail', 'missing', 'mock'],
      ['payments', 'missing', 'ask'],
    ]);
    expect(inv.decisions.find((d) => d.id === 'db')?.criteria).toEqual(['persists', 'welcomes']);
    expect(inv.asks).toEqual(['payments']);
    expect(inv.records.map((r) => [r.id, r.state])).toEqual([
      ['db', 'available'],
      ['mail', 'missing'],
      ['payments', 'missing'],
    ]);
  });

  it('a missing sqlite connection is provisioned while the run has room; past maxResources it falls to mock', () => {
    const one = buildInventory({ connections: CONNECTIONS, allowance: ALLOW, required: ['db'], probes: [probed('db', 'sqlite', 1)] });
    expect(one.decisions[0]).toMatchObject({ resolution: 'provision', reason: 'probe exited 1: provision a local sqlite' });
    const full = buildInventory({ connections: CONNECTIONS, allowance: ALLOW, required: ['db'], probes: [probed('db', 'sqlite', 1)], provisionedSoFar: 4 });
    expect(full.decisions[0]?.resolution).toBe('mock');
    const none = buildInventory({ connections: CONNECTIONS, allowance: { ...ALLOW, scope: 'none' }, required: ['db'], probes: [] });
    expect(none.decisions[0]).toMatchObject({ resolution: 'mock', reason: 'not probed: serve a stand-in (fidelity mocked)' });
  });

  it('each provision decision uses a slot: the needs beyond maxResources are not promised a resource', () => {
    const inv = buildInventory({
      connections: {},
      allowance: { ...ALLOW, maxResources: 1 },
      required: [
        { id: 'a', kind: 'tmpdir', criteria: [], mockable: false },
        { id: 'b', kind: 'tmpdir', criteria: [], mockable: false },
      ],
      probes: [],
    });
    expect(inv.decisions.map((d) => d.resolution)).toEqual(['provision', 'ask']);
  });

  it('a kind the provisioner cannot create is not provisioned even when the allowance names it', () => {
    const inv = buildInventory({ connections: CONNECTIONS, allowance: { ...ALLOW, kinds: [...ALLOW.kinds, 'payments'] }, required: ['payments'], probes: [], provisionable: ['tmpdir', 'git-remote', 'sqlite', 'http-stub'] });
    expect(inv.decisions[0]?.resolution).toBe('ask');
    const loose = buildInventory({ connections: CONNECTIONS, allowance: { ...ALLOW, kinds: [...ALLOW.kinds, 'payments'] }, required: ['payments'], probes: [] });
    expect(loose.decisions[0]?.resolution).toBe('provision');
  });

  it('an available record without a probe that exited 0 is not used', () => {
    const forged: CapabilityRecord = { id: 'tracker', kind: 'tracker', state: 'available' };
    const failed: CapabilityRecord = { id: 'tracker', kind: 'tracker', state: 'available', probe: { command: 'p', exitCode: 2 } };
    for (const r of [forged, failed]) expect(buildInventory({ connections: CONNECTIONS, allowance: ALLOW, required: ['tracker'], probes: [r] }).decisions[0]?.resolution).toBe('mock');
  });

  it('the manifest mockable:false wins over a planner need that says mockable; an undeclared need takes the planner word', () => {
    const inv = buildInventory({
      connections: CONNECTIONS,
      allowance: ALLOW,
      required: [
        { id: 'payments', kind: 'payments', criteria: ['charges'], mockable: true },
        { id: 'sms', kind: 'sms', criteria: ['texts'], mockable: false },
        { id: 'queue', kind: 'queue', criteria: [], mockable: true },
      ],
      probes: [],
    });
    expect(inv.decisions.map((d) => [d.id, d.declared, d.mockable, d.resolution])).toEqual([
      ['payments', true, false, 'ask'],
      ['queue', false, true, 'mock'],
      ['sms', false, false, 'ask'],
    ]);
    expect(inv.decisions.find((d) => d.id === 'sms')?.kind).toBe('sms');
    expect(inv.decisions.find((d) => d.id === 'queue')?.reason).toMatch(/^not declared in the manifest/);
  });

  it('a provisioned row is used; a mocked row stays mock (or ask when the connection forbids stand-ins); the latest fact wins', () => {
    const inv = buildInventory({
      connections: CONNECTIONS,
      allowance: ALLOW,
      required: ['db', 'mail', 'payments'],
      probes: [probed('db', 'sqlite', 1), { id: 'db', kind: 'sqlite', state: 'provisioned', resourceId: 'res_1' }, { id: 'mail', kind: 'mail', state: 'mocked' }, { id: 'payments', kind: 'payments', state: 'mocked' }],
    });
    expect(inv.decisions.map((d) => [d.id, d.state, d.resolution])).toEqual([
      ['db', 'provisioned', 'use'],
      ['mail', 'mocked', 'mock'],
      ['payments', 'mocked', 'ask'],
    ]);
  });

  it('a provisioned row naming no resource is not used; a later available row never overrides a probe that failed', () => {
    const inv = buildInventory({
      connections: CONNECTIONS,
      allowance: ALLOW,
      required: ['db', 'tracker'],
      probes: [{ id: 'db', kind: 'sqlite', state: 'provisioned' }, probed('tracker', 'tracker', 4), probed('tracker', 'tracker', 0)],
    });
    expect(inv.decisions.map((d) => [d.id, d.state, d.resolution])).toEqual([
      ['db', 'missing', 'provision'],
      ['tracker', 'missing', 'mock'],
    ]);
    expect(inv.decisions.find((d) => d.id === 'tracker')?.reason).toMatch(/^probe exited 4/);
  });

  it('the contract drives the scope: a requirement the caller left out of `required` is still decided', () => {
    const inv = buildInventory({ connections: CONNECTIONS, allowance: ALLOW, required: ['db'], probes: [probed('db', 'sqlite', 0)], contract });
    expect(inv.decisions.map((d) => [d.id, d.resolution])).toEqual([
      ['db', 'use'],
      ['mail', 'mock'],
      ['payments', 'ask'],
    ]);
    expect(inv.asks).toEqual(['payments']);
  });
});
