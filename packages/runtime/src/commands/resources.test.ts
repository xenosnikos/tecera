import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { makeRedactor, type ProvisionedResource, type TeceraEvent } from '@tecera/contracts';
import { SqliteLedger } from '@tecera/ledger';
import { resourceProvisionedEvent, resourceTransferredEvent } from '../capabilities/events.js';
import { LocalProvisioner, RESOURCES_ENV, stopStub, TEARDOWN_REFUSED } from '../capabilities/provisioner.js';
import { parseArgs } from '../cli/args.js';
import { makeContext } from '../cli/context.js';
import { Out } from '../cli/io.js';
import { resourcesCommand, type ResourcesCommandOptions } from './resources.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(HERE, '../../../../samples/fix-failing-test');

const temps: string[] = [];
const stubs: string[] = [];
afterEach(async () => {
  for (const d of stubs.splice(0)) await stopStub(d);
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

const ALLOW = { scope: 'local' as const, kinds: ['tmpdir', 'git-remote', 'sqlite', 'http-stub'], maxResources: 4, ttlSec: 3600 };

function project() {
  const dir = tmp('tecera-resources-cmd-');
  cpSync(SAMPLE, dir, { recursive: true, filter: (src) => !/node_modules|ledger\.sqlite|[\\/]runs([\\/]|$)/.test(src) });
  const root = join(tmp('tecera-resources-root-'), 'resources');
  return { dir, root, env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: 'tester', [RESOURCES_ENV]: root } as Record<string, string | undefined> };
}

let n = 0;
async function run(p: ReturnType<typeof project>, argv: string[], now = Date.now(), opts: ResourcesCommandOptions = {}): Promise<{ code: number; out: string; err: string; data: Record<string, unknown> }> {
  let out = '';
  let err = '';
  const args = parseArgs(argv);
  const io = { stdout: (s: string) => (out += s), stderr: (s: string) => (err += s), readStdin: async () => '', isTTY: false };
  const o = new Out(io, args, p.env, makeRedactor([]));
  const c = makeContext(args, o, io, { cwd: p.dir, env: { ...p.env }, now: () => now, ids: (x) => `${x}_c${++n}` });
  try {
    const code = await resourcesCommand(opts)(c);
    return { code, out, err, data: o.data };
  } finally {
    c.dispose();
  }
}

/** Provision `kind` under the project's root for run_1 and record it in the project's ledger. */
async function provisioned(p: ReturnType<typeof project>, kind: string, at = Date.now()): Promise<ProvisionedResource> {
  const prov = new LocalProvisioner({ root: p.root, repoRoot: p.dir, allowance: ALLOW, runId: 'run_1', now: () => at, ids: (x) => `${x}_p${++n}` });
  const r = await prov.provision({ capability: `cap-${kind}`, kind, goalId: 'g1' });
  if (kind === 'http-stub') stubs.push(join(p.root, r.id));
  const l = new SqliteLedger(join(p.dir, '.tecera/ledger.sqlite'));
  await l.append(resourceProvisionedEvent(r, { id: `ev_p${++n}`, at, actor: { kind: 'system', id: 'tecera-cli' }, runId: 'run_1', allowance: ALLOW }));
  l.close();
  return r;
}

async function ledgerEvents(p: ReturnType<typeof project>): Promise<TeceraEvent[]> {
  const l = new SqliteLedger(join(p.dir, '.tecera/ledger.sqlite'));
  const out: TeceraEvent[] = [];
  for await (const e of l.events()) out.push(e);
  l.close();
  return out;
}

describe('tecera resources list|release|transfer', () => {
  it('list shows each resource with kind, transfer state, locator and expiry, from the ledger', async () => {
    const p = project();
    expect((await run(p, ['list'])).out).toContain('no ledger yet');
    const a = await provisioned(p, 'tmpdir', 1_000_000);
    const b = await provisioned(p, 'git-remote', 1_000_000);
    const r = await run(p, ['list'], 1_000_000 + 3_600_000);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`${a.id}  tmpdir  pending  ${a.locator}  expired ${new Date(a.expiresAt).toISOString()}`);
    expect(r.out).toContain(`${b.id}  git-remote  pending  ${b.locator}`);
    expect(r.data.pending).toEqual([a.id, b.id]);
    expect(r.data.resources).toEqual([
      expect.objectContaining({ id: a.id, kind: 'tmpdir', locator: a.locator, transfer: 'pending', expiresAt: a.expiresAt, expired: true, runId: 'run_1', goalId: 'g1' }),
      expect.objectContaining({ id: b.id, kind: 'git-remote', expired: true }),
    ]);
    expect((await run(p, [], 1_000_000)).data.resources).toHaveLength(2);
    expect((await run(p, ['list', '--run', 'run_other'])).data.resources).toEqual([]);
  });

  it('release runs the recorded teardown and records resource.released by the human; a second release is a no-op', async () => {
    const p = project();
    const r = await provisioned(p, 'http-stub');
    const rel = await run(p, ['release', r.id, '--as', 'ana', '--reason', 'done with it']);
    expect(rel.code).toBe(0);
    expect(rel.out).toContain(`released ${r.id} (http-stub) as ana`);
    expect(existsSync(join(p.root, r.id))).toBe(false);
    await expect(fetch(`${r.locator}/x`)).rejects.toThrow();
    const evs = (await ledgerEvents(p)).filter((e) => e.kind === 'resource.released');
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ actor: { kind: 'human', id: 'ana' }, runId: 'run_1', payload: { resourceId: r.id, teardownExit: 0, reason: 'done with it', by: { kind: 'human', id: 'ana' } } });
    const again = await run(p, ['release', r.id]);
    expect(again.code).toBe(0);
    expect(again.out).toContain('already released');
    expect((await ledgerEvents(p)).filter((e) => e.kind === 'resource.released')).toHaveLength(1);
    expect((await run(p, ['list'])).out).toContain(`${r.id}  http-stub  released`);
  });

  it('transfer records resource.transferred by the human; Tecera then refuses to tear it down', async () => {
    const p = project();
    const r = await provisioned(p, 'sqlite');
    const t = await run(p, ['transfer', r.id, '--to', 'ops-team', '--as', 'ana', '--reason', 'keep for staging']);
    expect(t.code).toBe(0);
    const ev = (await ledgerEvents(p)).find((e) => e.kind === 'resource.transferred');
    expect(ev).toMatchObject({ actor: { kind: 'human', id: 'ana' }, payload: { resourceId: r.id, to: { kind: 'human', id: 'ops-team' }, note: 'keep for staging' } });
    const rel = await run(p, ['release', r.id, '--as', 'ana']);
    expect(rel.code).toBe(1);
    expect(rel.err).toMatch(/transferred to a human/);
    expect(existsSync(r.locator)).toBe(true);
    expect((await run(p, ['transfer', r.id, '--as', 'ana'])).code).toBe(1);
    expect((await run(p, ['list'])).data.pending).toEqual([]);
  });

  it('transfer re-reads the ledger under the resource lock: a transfer that landed first wins and nothing is reported twice', async () => {
    const p = project();
    const r = await provisioned(p, 'tmpdir');
    // Another human's transfer lands between this command's first read and its lock.
    class Racing extends LocalProvisioner {
      override async exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
        const l = new SqliteLedger(join(p.dir, '.tecera/ledger.sqlite'));
        await l.append({ ...resourceTransferredEvent({ resourceId: id, to: { kind: 'human', id: 'bob' } }, { id: 'ev_bob', at: 1, actor: { kind: 'human', id: 'bob' }, runId: 'run_1' }), idemKey: `resource.transferred:${id}` });
        l.close();
        return super.exclusive(id, fn);
      }
    }
    const t = await run(p, ['transfer', r.id, '--to', 'ops-team', '--as', 'ana'], Date.now(), { provisioner: () => new Racing({ root: p.root, repoRoot: p.dir, allowance: ALLOW, runId: 'cli' }) });
    expect(t.code).toBe(1);
    expect(t.err).toMatch(/already transferred/);
    expect(t.data.eventId).toBeUndefined();
    const evs = (await ledgerEvents(p)).filter((e) => e.kind === 'resource.transferred');
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ id: 'ev_bob', payload: { to: { kind: 'human', id: 'bob' } } });
  });

  it('transfer and release refuse while another process holds the resource lock', async () => {
    const p = project();
    const r = await provisioned(p, 'tmpdir');
    writeFileSync(join(p.root, '.records', `${r.id}.lock`), String(process.pid));
    const t = await run(p, ['transfer', r.id, '--as', 'ana']);
    expect([t.code, t.data.error]).toEqual([1, 'busy']);
    const rel = await run(p, ['release', r.id, '--as', 'ana']);
    expect(rel.code).toBe(1);
    expect(rel.err).toMatch(/another process/);
    expect(existsSync(r.locator)).toBe(true);
    expect((await ledgerEvents(p)).filter((e) => e.kind !== 'resource.provisioned')).toEqual([]);
  });

  it('transfer defaults `to` to the principal ($USER)', async () => {
    const p = project();
    const r = await provisioned(p, 'tmpdir');
    expect((await run(p, ['transfer', r.id])).code).toBe(0);
    expect((await ledgerEvents(p)).find((e) => e.kind === 'resource.transferred')).toMatchObject({ actor: { kind: 'human', id: 'tester' }, payload: { to: { kind: 'human', id: 'tester' } } });
  });

  it('a teardown edited in the ledger is refused: nothing runs, nothing is recorded, the debt stays pending', async () => {
    const p = project();
    const victim = tmp('tecera-victim-');
    const r = await provisioned(p, 'tmpdir');
    const forged = { ...r, id: 'res_forged', teardown: `rm -rf -- '${victim}'` };
    const l = new SqliteLedger(join(p.dir, '.tecera/ledger.sqlite'));
    await l.append(resourceProvisionedEvent(forged, { id: 'ev_forged', at: r.createdAt, actor: { kind: 'system', id: 'tecera-cli' }, runId: 'run_1' }));
    l.close();
    const rel = await run(p, ['release', 'res_forged', '--as', 'ana']);
    expect(rel.code).toBe(1);
    expect(rel.data.teardownExit).toBe(TEARDOWN_REFUSED);
    expect(existsSync(victim)).toBe(true);
    expect((await ledgerEvents(p)).filter((e) => e.kind === 'resource.released')).toEqual([]);
    expect((await run(p, ['list'])).data.pending).toEqual([r.id, 'res_forged']);
  });

  it('unknown resources, bad usage and a missing principal are refused', async () => {
    const p = project();
    await provisioned(p, 'tmpdir');
    expect((await run(p, ['release', 'res_nope', '--as', 'ana'])).code).toBe(1);
    await expect(run(p, ['release'])).rejects.toThrow(/usage/);
    await expect(run(p, ['frobnicate'])).rejects.toThrow(/usage/);
    const r = (await run(p, ['list'])).data.pending as string[];
    const noUser = { ...p, env: { ...p.env, USER: undefined, USERNAME: undefined } };
    expect((await run(noUser, ['release', r[0]!])).code).toBe(2);
    expect((await ledgerEvents(p)).filter((e) => e.kind === 'resource.released')).toEqual([]);
  });

  it('list exits 8 when the ledger records a resource outside the allowance or past maxResources', async () => {
    const p = project();
    const r = await provisioned(p, 'tmpdir');
    const l = new SqliteLedger(join(p.dir, '.tecera/ledger.sqlite'));
    for (let i = 0; i < 4; i++) await l.append(resourceProvisionedEvent({ ...r, id: `res_extra${i}` }, { id: `ev_extra${i}`, at: r.createdAt, actor: { kind: 'system', id: 'tecera-cli' }, runId: 'run_1' }));
    l.close();
    const out = await run(p, ['list']);
    expect(out.code).toBe(8);
    expect(out.data.overAllowance).toEqual(['res_extra3']);
    expect(out.err).toMatch(/past the run's allowance/);
  });
});
