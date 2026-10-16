import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseHardenedConfig } from './config.js';
import { HEARTBEAT_STALE_MS, RunRegistry, stateForExit, stopStateOf } from './registry.js';

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function registry(now = () => 1_000): { reg: RunRegistry; dir: string } {
  const dir = join(mkdtempSync(join(tmpdir(), 'tecera-reg-')), 'runs');
  temps.push(dir.slice(0, -5));
  return { reg: new RunRegistry(dir, { caseId: 'c'.repeat(24), now }), dir };
}

describe('run registry', () => {
  it('exit codes map to states; only the end of a segment makes a run terminal', () => {
    expect([4, 130, 10, 0, 5, 8, 9, 1].map(stateForExit)).toEqual(['held', 'interrupted', 'provisional', 'terminal', 'terminal', 'terminal', 'terminal', 'terminal']);
    const { reg } = registry();
    expect(reg.begin('r1', 'g1', { resume: false }).entry).toMatchObject({ state: 'registered', generation: 1 });
    expect(() => reg.begin('r1', 'g1', { resume: false })).toThrow(/already registered/);
    reg.running('r1');
    expect(reg.end('r1', 4, 'held for PR approval')).toMatchObject({ state: 'held', exitCode: 4, terminalReason: null });
    expect(reg.begin('r1', 'g1', { resume: true }).entry).toMatchObject({ state: 'running', generation: 2 });
    expect(reg.end('r1', 5, 'verify exit 1')).toMatchObject({ state: 'terminal', terminalReason: 'exit 5: verify exit 1' });
    expect(() => reg.begin('r1', 'g1', { resume: true })).toThrow(/a terminal run is not resumed/);
    expect(reg.open()).toEqual([]);
  });

  it('a segment that never started is put back; an unknown outcome stays open; an achieved run supersedes provisional runs of its goal', () => {
    const { reg } = registry();
    reg.begin('r1', 'g1', { resume: false });
    reg.end('r1', 4, 'held');
    const { prior } = reg.begin('r1', 'g1', { resume: true });
    reg.restore('r1', prior, 'exit 3: no worktree');
    expect(reg.get('r1')).toMatchObject({ state: 'held', generation: 1 });
    reg.begin('r2', 'g2', { resume: false });
    reg.restore('r2', null, 'exit 3: no worktree');
    expect(reg.get('r2')).toMatchObject({ state: 'terminal', terminalReason: 'not started: exit 3: no worktree' });
    reg.begin('r3', 'g1', { resume: false });
    reg.unknown('r3');
    expect(reg.get('r3')?.state).toBe('interrupted');
    reg.begin('r4', 'g1', { resume: false });
    reg.end('r4', 10, 'provisional');
    reg.begin('r5', 'g1', { resume: false });
    reg.end('r5', 0, 'achieved');
    expect(reg.get('r4')).toMatchObject({ state: 'terminal', terminalReason: 'superseded: run r5 achieved goal g1' });
    expect(reg.get('r1')?.state).toBe('held'); // not provisional: untouched
  });

  it('a missed heartbeat reads as interrupted, never finished', () => {
    let t = 1_000;
    const { reg } = registry(() => t);
    const e = reg.begin('r1', 'g1', { resume: false }).entry;
    expect(stopStateOf(e, t).state).toBe('running');
    t += HEARTBEAT_STALE_MS + 1;
    expect(stopStateOf(e, t)).toMatchObject({ state: 'interrupted', note: expect.stringMatching(/heartbeat missed/) });
  });

  it('anything that is not a well-formed entry fails closed: malformed JSON, a wrong file name, a link, a terminal entry without a reason', () => {
    const { reg, dir } = registry();
    reg.begin('r1', 'g1', { resume: false });
    writeFileSync(join(dir, 'r2.json'), '{"formatVersion":1');
    expect(() => reg.list()).toThrow(/not readable JSON/);
    rmSync(join(dir, 'r2.json'));
    writeFileSync(join(dir, 'r3.json'), JSON.stringify({ ...reg.get('r1'), runId: 'r1' }));
    expect(() => reg.list()).toThrow(/r3.json holds run r1/);
    rmSync(join(dir, 'r3.json'));
    writeFileSync(join(dir, 'r4.json'), JSON.stringify({ ...reg.get('r1'), runId: 'r4', state: 'terminal', terminalReason: '' }));
    expect(() => reg.list()).toThrow(/terminal without a reason/);
    rmSync(join(dir, 'r4.json'));
    symlinkSync(join(dir, 'r1.json'), join(dir, 'r5.json'));
    expect(() => reg.list()).toThrow(/not a regular file/);
    rmSync(join(dir, 'r5.json'));
    writeFileSync(join(dir, 'notes.txt'), 'x');
    expect(() => reg.list()).toThrow(/unexpected file/);
  });

  it('the configuration: identities distinct, no root agent, an absolute normalized state directory, no unknown fields', () => {
    const ok = { version: 1, stateDir: '/var/lib/tecera/', operator: { uid: 1000, name: 'nick' }, agents: [{ uid: 1001 }] };
    expect(parseHardenedConfig(ok, 'cfg', 'system')).toMatchObject({ stateDir: '/var/lib/tecera', operator: { uid: 1000 }, agents: [{ uid: 1001 }] });
    for (const [bad, re] of [
      [{ ...ok, agents: [{ uid: 1000 }] }, /both the operator and an agent/],
      [{ ...ok, agents: [{ uid: 0 }] }, /cannot be root/],
      [{ ...ok, agents: [] }, /at least one/],
      [{ ...ok, stateDir: 'state' }, /absolute/],
      [{ ...ok, stateDir: '/var/../tmp' }, /normalized/],
      [{ ...ok, stateDir: '/' }, /other than \//],
      [{ ...ok, mode: 'single' }, /unknown field/],
      [{ ...ok, operator: { uid: '1000' } }, /numeric uid/],
      [{ ...ok, version: 2 }, /version must be 1/],
    ] as const)
      expect(() => parseHardenedConfig(bad, 'cfg', 'system')).toThrow(re);
  });
});
