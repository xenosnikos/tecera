import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { locatorProblem, resourceProblem, resourceRegistryOf, type Principal, type ProvisionedResource, type ProvisioningAllowance, type TeceraEvent } from '@tecera/contracts';
import { MemoryLedger, projectResources } from '@tecera/ledger';
import { resourceProvisionedEvent, resourceReleasedEvent, resourceTransferredEvent } from './events.js';
import { LocalProvisioner, ProvisioningRefused, resourcesRoot, RESOURCES_ENV, stopStub, TEARDOWN_REFUSED, teardownFor } from './provisioner.js';
import { releaseExpired, releaseRecorded } from './sweep.js';

const ALLOW: ProvisioningAllowance = { scope: 'local', kinds: ['tmpdir', 'git-remote', 'sqlite', 'http-stub'], maxResources: 4, ttlSec: 3600 };
const SYSTEM: Principal = { kind: 'system', id: 'tecera-cli' };

const temps: string[] = [];
const provisioners: LocalProvisioner[] = [];
afterEach(async () => {
  // Stubs are detached processes: stop every one this file started before removing its directory.
  for (const p of provisioners.splice(0)) for (const r of await p.list()) if (r.kind === 'http-stub') await stopStub(join(p.root, r.id));
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix = 'tecera-prov-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

let n = 0;
function setup(o: { allowance?: Partial<ProvisioningAllowance>; now?: () => number; provisionedSoFar?: number; root?: string; secrets?: (v: string) => boolean } = {}) {
  const repo = tmp('tecera-repo-');
  const root = o.root ?? join(tmp('tecera-res-'), 'resources');
  const p = new LocalProvisioner({
    root,
    repoRoot: repo,
    allowance: { ...ALLOW, ...(o.allowance ?? {}) },
    runId: 'run_1',
    ids: (prefix) => `${prefix}_t${++n}`,
    ...(o.now ? { now: o.now } : {}),
    ...(o.provisionedSoFar !== undefined ? { provisionedSoFar: o.provisionedSoFar } : {}),
    ...(o.secrets ? { secrets: o.secrets } : {}),
  });
  provisioners.push(p);
  return { p, repo, root };
}

const need = (kind: string, extra: Record<string, unknown> = {}) => ({ capability: `cap-${kind}`, kind, goalId: 'g1', ...extra });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] !== 'Z';
  } catch {
    return false;
  }
}

/** Pids whose command line carries `marker`. */
function processesWith(marker: string): number[] {
  const out: number[] = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (readFileSync(`/proc/${d}/cmdline`, 'utf8').includes(marker)) out.push(Number(d));
    } catch {
      /* gone */
    }
  }
  return out;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args], { env: { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, encoding: 'utf8' });
}

function expectRecordable(r: ProvisionedResource, root: string, repo: string): void {
  expect(r).toMatchObject({ provider: 'local', transfer: 'pending', goalId: 'g1', runId: 'run_1' });
  expect(r.expiresAt - r.createdAt).toBe(ALLOW.ttlSec * 1000);
  expect(r.teardown).toBe(teardownFor(r.kind, join(root, r.id)));
  expect(resourceProblem(r, ALLOW)).toBeNull();
  expect(locatorProblem(r.locator)).toBeNull();
  expect(r.locator.startsWith(repo)).toBe(false);
}

describe('local provisioner: each kind provisions, is usable and tears down', () => {
  it('tmpdir: a writable directory under the Tecera root, removed by release', async () => {
    const { p, root, repo } = setup();
    const r = await p.provision(need('tmpdir'));
    expectRecordable(r, root, repo);
    expect(r.locator).toBe(join(root, r.id, 'work'));
    writeFileSync(join(r.locator, 'f.txt'), 'hello');
    expect(readFileSync(join(r.locator, 'f.txt'), 'utf8')).toBe('hello');
    expect(await p.list()).toEqual([r]);
    expect(await p.releaseResource(r)).toEqual({ resourceId: r.id, teardownExit: 0, already: false });
    expect(existsSync(join(root, r.id))).toBe(false);
    expect(await p.list()).toEqual([]);
  });

  it('git-remote: a bare repository that receives the work-branch push', async () => {
    const { p, root, repo } = setup();
    const r = await p.provision(need('git-remote'));
    expectRecordable(r, root, repo);
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'work');
    git(repo, 'push', '-q', r.locator, 'HEAD:refs/heads/tecera/work');
    expect(git(r.locator, 'rev-parse', 'refs/heads/tecera/work').trim()).toBe(git(repo, 'rev-parse', 'HEAD').trim());
    expect(git(r.locator, 'rev-parse', '--is-bare-repository').trim()).toBe('true');
    expect((await p.releaseResource(r)).teardownExit).toBe(0);
    expect(existsSync(r.locator)).toBe(false);
  });

  it('sqlite: a database file that can be written and read back', async () => {
    const { p, root, repo } = setup();
    const r = await p.provision(need('sqlite'));
    expectRecordable(r, root, repo);
    const db = new DatabaseSync(r.locator);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, user TEXT)');
    db.prepare('INSERT INTO sessions VALUES (?, ?)').run('s1', 'ana');
    db.close();
    const again = new DatabaseSync(r.locator);
    expect(again.prepare('SELECT user FROM sessions WHERE id = ?').get('s1')).toEqual({ user: 'ana' });
    again.close();
    expect((await p.releaseResource(r)).teardownExit).toBe(0);
    expect(existsSync(r.locator)).toBe(false);
  });

  it('http-stub: a loopback server that answers as configured, records requests (credentials withheld) and stops on release', async () => {
    const { p, root, repo } = setup();
    const r = await p.provision(need('http-stub', { stub: { routes: [{ method: 'POST', path: '/send', status: 202, body: { queued: true } }] } }));
    expectRecordable(r, root, repo);
    expect(r.locator).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${r.locator}/send?to=a`, { method: 'POST', headers: { authorization: 'Bearer stub-should-not-record-0123456789', 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'hi' }) });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: true });
    expect((await fetch(`${r.locator}/other`)).status).toBe(404);
    p.configureStub(r.id, { routes: [{ path: '/other', body: 'now here' }] });
    const other = await fetch(`${r.locator}/other`);
    expect([other.status, await other.text()]).toEqual([200, 'now here']);
    const reqs = p.stubRequests(r.id);
    expect(reqs.map((q) => [q.method, q.path])).toEqual([
      ['POST', '/send'],
      ['GET', '/other'],
      ['GET', '/other'],
    ]);
    expect(reqs[0]).toMatchObject({ query: '?to=a', body: '{"subject":"hi"}', headers: { authorization: '[withheld]' } });
    expect(JSON.stringify(reqs)).not.toContain('stub-should-not-record');
    const pid = Number(readFileSync(join(root, r.id, 'stub.pid'), 'utf8'));
    expect(alive(pid)).toBe(true);
    expect((await p.releaseResource(r)).teardownExit).toBe(0);
    expect(alive(pid)).toBe(false);
    expect(existsSync(join(root, r.id))).toBe(false);
    await expect(fetch(`${r.locator}/send`)).rejects.toThrow();
  });

  it('http-stub: credential-named query parameters and headers are withheld, and the request log is private', async () => {
    const { p, root } = setup();
    const r = await p.provision(need('http-stub'));
    const secret = 'stub-query-secret-0123456789';
    await fetch(`${r.locator}/hook?access_token=${secret}&to=a%20b&sig=${secret}`, { headers: { 'x-goog-api-key': secret, 'x-session-id': secret, 'x-trace': 'kept' } });
    const [q] = p.stubRequests(r.id);
    expect(q).toMatchObject({ path: '/hook', query: '?access_token=[withheld]&to=a%20b&sig=[withheld]', headers: { 'x-goog-api-key': '[withheld]', 'x-session-id': '[withheld]', 'x-trace': 'kept' } });
    expect(JSON.stringify(q)).not.toContain(secret);
    expect(statSync(join(root, r.id, 'requests.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('every resource and its record live under the Tecera root, outside the repository; the records are private', async () => {
    const { p, root, repo } = setup();
    const r = await p.provision(need('tmpdir'));
    expect(r.locator.startsWith(`${root}/`)).toBe(true);
    expect(statSync(join(root, '.records')).mode & 0o777).toBe(0o700);
    expect(statSync(root).mode & 0o077).toBe(0o011);
    expect(() => new LocalProvisioner({ root: join(repo, '.tecera', 'resources'), repoRoot: repo, allowance: ALLOW, runId: 'r' })).toThrow(/outside the repository/);
    expect(() => new LocalProvisioner({ root: tmpdir(), repoRoot: join(tmpdir(), 'x', 'repo'), allowance: ALLOW, runId: 'r' })).toThrow(/outside the repository/);
    expect(() => new LocalProvisioner({ root: 'relative/dir', repoRoot: repo, allowance: ALLOW, runId: 'r' })).toThrow(/absolute/);
    expect(resourcesRoot({ [RESOURCES_ENV]: '/srv/tecera-res' })).toBe('/srv/tecera-res');
    expect(() => resourcesRoot({ [RESOURCES_ENV]: 'rel' })).toThrow(ProvisioningRefused);
  });
});

describe('local provisioner: the allowance', () => {
  it('refuses scope none, a kind outside the allowance and a kind it cannot create; nothing is created', async () => {
    const none = setup({ allowance: { scope: 'none' } });
    await expect(none.p.provision(need('tmpdir'))).rejects.toThrow(/scope is none/);
    const narrow = setup({ allowance: { kinds: ['sqlite'] } });
    await expect(narrow.p.provision(need('tmpdir'))).rejects.toThrow(/outside the allowance/);
    const odd = setup({ allowance: { kinds: ['postgres'] } });
    await expect(odd.p.provision(need('postgres'))).rejects.toThrow(/cannot be provisioned locally/);
    for (const s of [none, narrow, odd]) expect(existsSync(s.root)).toBe(false);
  });

  it('refuses past maxResources in the run, counting what the run already provisioned', async () => {
    const { p } = setup({ allowance: { maxResources: 2 }, provisionedSoFar: 1 });
    await p.provision(need('tmpdir'));
    await expect(p.provision(need('tmpdir'))).rejects.toThrow(/already provisioned 2 of 2/);
    expect(await p.list()).toHaveLength(1);
  });

  it('maxResources counts the run across provisioners of one root, and an allowance that cannot be enforced is refused', async () => {
    const { p, root, repo } = setup({ allowance: { maxResources: 1 } });
    await p.provision(need('tmpdir'));
    const second = new LocalProvisioner({ root, repoRoot: repo, allowance: { ...ALLOW, maxResources: 1 }, runId: 'run_1', ids: (x) => `${x}_t${++n}` });
    await expect(second.provision(need('tmpdir'))).rejects.toThrow(/already provisioned 1 of 1/);
    const otherRun = new LocalProvisioner({ root, repoRoot: repo, allowance: { ...ALLOW, maxResources: 1 }, runId: 'run_2', ids: (x) => `${x}_t${++n}` });
    provisioners.push(otherRun);
    await expect(otherRun.provision(need('tmpdir'))).resolves.toMatchObject({ runId: 'run_2' });
    for (const bad of [{ maxResources: Number.NaN }, { maxResources: -1 }, { ttlSec: 0 }, { ttlSec: 1.5 }, { scope: 'cloud' as never }, { kinds: 'tmpdir' as never }]) {
      expect(() => new LocalProvisioner({ root, repoRoot: repo, allowance: { ...ALLOW, ...bad }, runId: 'r' }), JSON.stringify(bad)).toThrow(ProvisioningRefused);
    }
    expect(() => new LocalProvisioner({ root, repoRoot: repo, allowance: ALLOW, runId: 'r', provisionedSoFar: Number.NaN })).toThrow(/provisionedSoFar/);
  });

  it('a root writable by others, or not owned by this process, is refused before anything is created', async () => {
    const base = tmp();
    const root = join(base, 'resources');
    mkdirSync(root, { mode: 0o777 });
    chmodSync(root, 0o777);
    const { p } = setup({ root });
    await expect(p.provision(need('tmpdir'))).rejects.toThrow(/writable by group or others/);
    chmodSync(root, 0o711);
    if (process.geteuid?.() === 0) {
      chownSync(root, 65534, 65534);
      await expect(p.provision(need('tmpdir'))).rejects.toThrow(/owned by uid 65534/);
      chownSync(root, 0, 0);
    }
    expect(readdirSync(root).filter((x) => x !== '.records')).toEqual([]);
  });

  it('a resource whose record cannot be written is torn down and refused (no undiscoverable orphan)', async () => {
    const { root, repo } = setup();
    const p = new LocalProvisioner({ root, repoRoot: repo, allowance: ALLOW, runId: 'run_1', ids: (x) => `${x}_fixed` });
    provisioners.push(p);
    mkdirSync(join(root, '.records', 'res_fixed.json'), { recursive: true, mode: 0o700 });
    await expect(p.provision(need('http-stub'))).rejects.toThrow(/could not record http-stub res_fixed/);
    expect(existsSync(join(root, 'res_fixed'))).toBe(false);
    expect(readdirSync(join(root, '.records')).filter((x) => x.endsWith('.tmp'))).toEqual([]);
    expect(processesWith(join(root, 'res_fixed', 'stub.cjs'))).toEqual([]);
  });

  it('never grants a lifetime longer than ttlSec; a shorter one is honoured', async () => {
    const { p } = setup({ allowance: { ttlSec: 60 }, now: () => 1_000_000 });
    expect((await p.provision(need('tmpdir', { ttlSec: 7200 }))).expiresAt).toBe(1_000_000 + 60_000);
    expect((await p.provision(need('tmpdir', { ttlSec: 5 }))).expiresAt).toBe(1_000_000 + 5_000);
    await expect(p.provision(need('tmpdir', { ttlSec: 0 }))).rejects.toThrow(/positive/);
  });

  it('a locator that would carry a credential or a known secret is refused and nothing is left behind', async () => {
    const canary = setup({ root: join(tmp(), 'TECERA_CANARY_x1', 'resources') });
    await expect(canary.p.provision(need('tmpdir'))).rejects.toThrow(/carries a canary/);
    const userinfo = setup({ root: join(tmp(), 'user:pass@host', 'res') });
    await expect(userinfo.p.provision(need('sqlite'))).rejects.toThrow(/userinfo/);
    const named = setup({ root: join(tmp(), 'token=abc', 'res') });
    await expect(named.p.provision(need('git-remote'))).rejects.toThrow(/secret-named/);
    const known = setup({ secrets: (v) => v.includes('tecera-res-') });
    await expect(known.p.provision(need('tmpdir'))).rejects.toThrow(/known secret/);
    for (const s of [canary, userinfo, named, known]) {
      expect(await s.p.list()).toEqual([]);
      expect(existsSync(s.root) ? readdirSync(s.root).filter((x: string) => x !== '.records') : []).toEqual([]);
    }
    expect(() => new LocalProvisioner({ root: "/tmp/it's", repoRoot: '/nonexistent-repo', allowance: ALLOW, runId: 'r' })).toThrow(/quotes/);
  });
});

describe('local provisioner: release', () => {
  it('is idempotent: a second release (or one of a resource already gone) exits 0 and says so', async () => {
    const { p, root } = setup();
    const r = await p.provision(need('tmpdir'));
    expect((await p.releaseResource(r)).already).toBe(false);
    expect(await p.releaseResource(r)).toEqual({ resourceId: r.id, teardownExit: 0, already: true });
    await expect(p.release(r.id)).resolves.toBeUndefined();
    await expect(p.release('res_unknown')).resolves.toBeUndefined();
    const s = await p.provision(need('http-stub'));
    await p.release(s.id);
    await p.release(s.id);
    expect(existsSync(join(root, s.id))).toBe(false);
  });

  it('runs only the teardown it wrote: an edited teardown is refused (126) and the resource stays', async () => {
    const { p, root } = setup();
    const victim = tmp('tecera-victim-');
    const r = await p.provision(need('tmpdir'));
    for (const teardown of [`rm -rf -- '${victim}'`, `${r.teardown}; touch /tmp/pwned`, teardownFor('http-stub', join(root, r.id))]) {
      expect(await p.releaseResource({ ...r, teardown })).toMatchObject({ teardownExit: TEARDOWN_REFUSED, already: false });
    }
    expect(await p.releaseResource({ ...r, id: '../escape', teardown: teardownFor('tmpdir', join(root, '../escape')) })).toMatchObject({ teardownExit: TEARDOWN_REFUSED });
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(r.locator)).toBe(true);
  });

  it('never tears down a resource a human took over', async () => {
    const { p } = setup();
    const r = await p.provision(need('tmpdir'));
    p.markTransferred(r.id);
    expect(await p.releaseResource(r)).toMatchObject({ teardownExit: 1, reason: expect.stringMatching(/took it over/) });
    await expect(p.release(r.id)).rejects.toThrow(ProvisioningRefused);
    expect(existsSync(r.locator)).toBe(true);
  });

  it('an http-stub whose pid file is gone or edited is still found and stopped before the release counts', async () => {
    const { p, root } = setup();
    for (const edit of [(d: string) => rmSync(join(d, 'stub.pid')), (d: string) => writeFileSync(join(d, 'stub.pid'), String(process.pid))]) {
      const r = await p.provision(need('http-stub'));
      const dir = join(root, r.id);
      const pid = Number(readFileSync(join(dir, 'stub.pid'), 'utf8'));
      edit(dir);
      expect(await p.releaseResource(r)).toMatchObject({ teardownExit: 0, already: false });
      expect(alive(pid)).toBe(false);
      await expect(fetch(`${r.locator}/x`)).rejects.toThrow();
    }
    expect(alive(process.pid)).toBe(true);
  });

  it('an http-stub that cannot be proven stopped is not released: teardown exits 1, the directory and record stay', async () => {
    const { p, root, repo } = setup();
    const r = await p.provision(need('http-stub'));
    const pid = Number(readFileSync(join(root, r.id, 'stub.pid'), 'utf8'));
    const stuck = new LocalProvisioner({ root, repoRoot: repo, allowance: ALLOW, runId: 'run_1', kill: () => undefined });
    const res = await stuck.releaseResource(r);
    expect(res).toMatchObject({ teardownExit: 1, already: false, reason: expect.stringMatching(/proven stopped/) });
    expect(alive(pid)).toBe(true);
    expect(existsSync(join(root, r.id, 'stub.pid'))).toBe(true);
    expect(p.record(r.id)).not.toBeNull();
    expect(await stopStub(join(root, r.id), { kill: () => undefined })).toBe(false);
    expect((await p.releaseResource(r)).teardownExit).toBe(0);
    expect(alive(pid)).toBe(false);
  });

  it('release is serialised per resource: a lock held by a live process refuses, a stale one is taken over', async () => {
    const { p, root } = setup();
    const r = await p.provision(need('tmpdir'));
    const lock = join(root, '.records', `${r.id}.lock`);
    writeFileSync(lock, String(process.pid));
    expect(await p.releaseResource(r)).toMatchObject({ teardownExit: 1, reason: expect.stringMatching(/another process/) });
    expect(existsSync(r.locator)).toBe(true);
    writeFileSync(lock, String(spawnSync('true').pid));
    expect(await p.releaseResource(r)).toMatchObject({ teardownExit: 0, already: false });
    expect(existsSync(lock)).toBe(false);
  });

  it('a guard run under the lock can refuse (nothing removed) or report it already released', async () => {
    const { p } = setup();
    const r = await p.provision(need('tmpdir'));
    expect(await p.releaseResource(r, { guard: async () => ({ refuse: 'transferred meanwhile' }) })).toMatchObject({ teardownExit: 1, reason: 'transferred meanwhile' });
    expect(existsSync(r.locator)).toBe(true);
    expect(await p.releaseResource(r, { guard: async () => ({ already: true }) })).toEqual({ resourceId: r.id, teardownExit: 0, already: true });
  });

  it('a symlink planted in place of a resource directory is removed, never followed', async () => {
    const { p, root } = setup();
    const victim = tmp('tecera-victim-');
    writeFileSync(join(victim, 'keep'), 'k');
    const r = await p.provision(need('tmpdir'));
    rmSync(join(root, r.id), { recursive: true });
    symlinkSync(victim, join(root, r.id));
    expect((await p.releaseResource(r)).teardownExit).toBe(0);
    expect(existsSync(join(victim, 'keep'))).toBe(true);
    expect(existsSync(join(root, r.id))).toBe(false);
  });
});

describe('resource events and the expiry sweep', () => {
  async function recorded(ledger: MemoryLedger, r: ProvisionedResource, id: string): Promise<void> {
    await ledger.append(resourceProvisionedEvent(r, { id, at: r.createdAt, actor: SYSTEM, runId: 'run_1', allowance: ALLOW }));
  }
  async function all(ledger: MemoryLedger): Promise<TeceraEvent[]> {
    const out: TeceraEvent[] = [];
    for await (const e of ledger.events()) out.push(e);
    return out;
  }

  it('resource.provisioned is refused for a resource the projections would drop', async () => {
    const { p } = setup();
    const r = await p.provision(need('tmpdir'));
    expect(() => resourceProvisionedEvent({ ...r, teardown: '' }, { id: 'e', at: 1, actor: SYSTEM, runId: 'run_1' })).toThrow(/no teardown/);
    expect(() => resourceProvisionedEvent(r, { id: 'e', at: 1, actor: SYSTEM, runId: 'run_1', allowance: { ...ALLOW, kinds: ['sqlite'] } })).toThrow(/outside the allowance/);
    expect(() => resourceProvisionedEvent(r, { id: 'e', at: 1, actor: SYSTEM, runId: 'run_other' })).toThrow(/belongs to run run_1/);
    expect(() => resourceReleasedEvent({ resourceId: r.id, teardownExit: 1, reason: 'x' }, { id: 'e', at: 1, actor: SYSTEM })).toThrow(/not released/);
    expect(() => resourceReleasedEvent({ resourceId: r.id, teardownExit: 0, reason: 'x' }, { id: 'e', at: 1, actor: { kind: 'agent', id: 'w' } })).toThrow(/agent/);
    expect(() => resourceTransferredEvent({ resourceId: r.id, to: { kind: 'human', id: 'ana' } }, { id: 'e', at: 1, actor: SYSTEM })).toThrow(/human/);
  });

  it('releases expired pending resources (system actor), leaves live and transferred ones, and sweeps unrecorded orphans', async () => {
    let now = 1_000_000;
    const { p, root } = setup({ now: () => now, allowance: { maxResources: 4 } });
    const ledger = new MemoryLedger();
    const short = await p.provision(need('tmpdir', { ttlSec: 10 }));
    const long = await p.provision(need('sqlite'));
    const given = await p.provision(need('tmpdir', { ttlSec: 10 }));
    const orphan = await p.provision(need('http-stub', { ttlSec: 10 }));
    await recorded(ledger, short, 'e1');
    await recorded(ledger, long, 'e2');
    await recorded(ledger, given, 'e3');
    await ledger.append(resourceTransferredEvent({ resourceId: given.id, to: { kind: 'human', id: 'ana' } }, { id: 'e4', at: now, actor: { kind: 'human', id: 'ana' }, runId: 'run_1' }));
    let ids = 0;
    const ctx = { ledger, provisioner: p, actor: SYSTEM, ids: (x: string) => `${x}_s${++ids}`, now: () => now, allowance: ALLOW };
    expect((await releaseExpired(ctx)).released).toEqual([]);
    now += 11_000;
    const swept = await releaseExpired(ctx);
    expect(swept.released.map((r) => r.resourceId)).toEqual([short.id]);
    expect(swept.failed).toEqual([]);
    expect(swept.orphans.map((r) => [r.resourceId, r.teardownExit])).toEqual([[orphan.id, 0]]);
    expect(existsSync(join(root, short.id))).toBe(false);
    expect(existsSync(join(root, orphan.id))).toBe(false);
    expect(existsSync(long.locator)).toBe(true);
    expect(existsSync(given.locator)).toBe(true);
    const evs = await all(ledger);
    const rel = evs.filter((e) => e.kind === 'resource.released');
    expect(rel).toHaveLength(1);
    expect(rel[0]).toMatchObject({ actor: SYSTEM, runId: 'run_1', payload: { resourceId: short.id, teardownExit: 0, reason: 'expired' } });
    const reg = resourceRegistryOf(evs, { allowance: ALLOW });
    expect(reg.problems).toEqual([]);
    expect(reg.pending.map((r) => r.id)).toEqual([long.id]);
    expect(reg.byId[short.id]?.transfer).toBe('released');
    expect(reg.byId[given.id]?.transfer).toBe('transferred');
    // A second sweep finds nothing new and records nothing twice.
    expect((await releaseExpired(ctx)).released).toEqual([]);
    expect((await all(ledger)).filter((e) => e.kind === 'resource.released')).toHaveLength(1);
  });

  it('a release holding a stale pending row does not tear down what the ledger now records as transferred', async () => {
    const { p } = setup();
    const ledger = new MemoryLedger();
    const r = await p.provision(need('tmpdir'));
    await recorded(ledger, r, 'e1');
    const stale = (await projectResources(ledger, {})).byId[r.id]!;
    expect(stale.transfer).toBe('pending');
    // The transfer lands after the row was read (its local mark not yet written).
    await ledger.append(resourceTransferredEvent({ resourceId: r.id, to: { kind: 'human', id: 'ana' } }, { id: 'e2', at: 2, actor: { kind: 'human', id: 'ana' }, runId: 'run_1' }));
    const res = await releaseRecorded({ ledger, provisioner: p, actor: SYSTEM, ids: () => 'ev_x', now: () => 3 }, stale, 'expired');
    expect(res).toMatchObject({ teardownExit: 1, reason: expect.stringMatching(/took it over/) });
    expect(res.event).toBeUndefined();
    expect(existsSync(r.locator)).toBe(true);
    expect((await all(ledger)).filter((e) => e.kind === 'resource.released')).toEqual([]);
  });

  it('a teardown whose release cannot be appended says so (unrecorded, a sweep failure); releasing again records it', async () => {
    let now = 1_000_000;
    const { p } = setup({ now: () => now });
    const ledger = new MemoryLedger();
    const r = await p.provision(need('tmpdir', { ttlSec: 10 }));
    await recorded(ledger, r, 'e1');
    let broken = true;
    const flaky = new Proxy(ledger, {
      get(t, k) {
        if (k === 'append') return (e: TeceraEvent) => (broken ? Promise.reject(new Error('disk full')) : t.append(e));
        const v: unknown = Reflect.get(t, k);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    now += 11_000;
    let ids = 0;
    const ctx = { ledger: flaky, provisioner: p, actor: SYSTEM, ids: (x: string) => `${x}_u${++ids}`, now: () => now, allowance: ALLOW };
    const swept = await releaseExpired(ctx);
    expect(swept.released).toEqual([]);
    expect(swept.failed).toMatchObject([{ resourceId: r.id, teardownExit: 0, unrecorded: 'disk full' }]);
    expect(existsSync(r.locator)).toBe(false);
    broken = false;
    const again = await releaseExpired(ctx);
    expect(again.released).toMatchObject([{ resourceId: r.id, teardownExit: 0, already: true, event: expect.objectContaining({ kind: 'resource.released' }) }]);
    expect((await projectResources(ledger, {})).byId[r.id]?.transfer).toBe('released');
  });

  it('a failed teardown records no release: the debt stays pending', async () => {
    const { p } = setup();
    const ledger = new MemoryLedger();
    const r = await p.provision(need('tmpdir'));
    const tampered = { ...r, teardown: `rm -rf -- '/'` };
    const res = await releaseRecorded({ ledger, provisioner: p, actor: SYSTEM, ids: () => 'ev_x', now: () => 1 }, tampered, 'x');
    expect(res.teardownExit).toBe(TEARDOWN_REFUSED);
    expect(res.event).toBeUndefined();
    expect(await all(ledger)).toEqual([]);
    expect(existsSync(r.locator)).toBe(true);
  });
});
