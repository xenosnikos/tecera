import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilityInventoryOf, type CapabilityRecord, type VerifyOutcome, type VerifyRequest, type VerifyRunner } from '@tecera/contracts';
import { admitVerify } from '../containment.js';
import { capabilityProbedEvent } from './events.js';
import { ConnectionProbe, PROBE_TIMEOUT_EXIT, PROBE_UNTRUSTED_EXIT, storeAuthResolver, type Connections } from './probe.js';

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'tecera-probe-'));
  chmodSync(d, 0o755);
  temps.push(d);
  return d;
}

const conn = (o: Partial<Connections[string]> & { kind?: string }): Connections[string] => ({ kind: o.kind ?? 'database', mockable: o.mockable ?? true, ...(o.probe ? { probe: o.probe } : {}), ...(o.auth ? { auth: o.auth } : {}) });

class FakeRunner implements VerifyRunner {
  calls: VerifyRequest[] = [];
  constructor(private readonly reply: (req: VerifyRequest) => Partial<VerifyOutcome> & Record<string, unknown>) {}
  async run(req: VerifyRequest): Promise<VerifyOutcome> {
    this.calls.push(req);
    // The contained runner's attestation (gone, no stragglers, nothing escaped) unless a reply overrides it.
    return { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', durationMs: 1, truncated: false, gone: true, stragglers: 0, escaped: 0, ...this.reply(req) } as VerifyOutcome;
  }
}

const VERIFY_ENV = { TECERA_VERIFY_UID: process.env.TECERA_VERIFY_UID ?? '65534', TECERA_VERIFY_GID: process.env.TECERA_VERIFY_GID ?? '65534', PATH: process.env.PATH };

function contained(): VerifyRunner | null {
  try {
    return admitVerify(VERIFY_ENV, undefined).runner;
  } catch {
    return null;
  }
}
const RUNNER = contained();

/** Pids whose command line carries `marker` (a probe's leftover would). */
function processesWith(marker: string): number[] {
  const out: number[] = [];
  for (const n of readdirSync('/proc')) {
    if (!/^\d+$/.test(n)) continue;
    try {
      if (readFileSync(`/proc/${n}/cmdline`, 'utf8').includes(marker)) out.push(Number(n));
    } catch {
      /* gone */
    }
  }
  return out;
}

describe.skipIf(!RUNNER)('capability probe through the contained verify runner', () => {
  const probeOf = (connections: Connections, timeoutSec = 10) => new ConnectionProbe({ connections, runner: RUNNER!, cwd: tmp(), envAllowlist: ['PATH'], timeoutSec });

  it('a probe that exits 0 makes the connection available, recorded with its command and exit code', async () => {
    const r = await probeOf({ db: conn({ probe: 'true' }) }).probe('db');
    expect(r).toEqual({ id: 'db', kind: 'database', state: 'available', probe: { command: 'true', exitCode: 0 } });
  });

  it('a probe that exits non-zero leaves it missing with that exit code', async () => {
    const d = await probeOf({ db: conn({ probe: 'exit 3' }) }).detail('db');
    expect(d.record).toEqual({ id: 'db', kind: 'database', state: 'missing', probe: { command: 'exit 3', exitCode: 3 } });
    expect(d.reason).toBe('probe exited 3');
  });

  it('a probe that runs past its timeout is missing (exit 124) and is killed', async () => {
    const marker = `${7000 + Math.floor(Math.random() * 999)}.25`;
    const d = await probeOf({ db: conn({ probe: `sleep ${marker}` }) }, 1).detail('db');
    expect(d.record.state).toBe('missing');
    expect(d.record.probe?.exitCode).toBe(PROBE_TIMEOUT_EXIT);
    expect(d.reason).toMatch(/timed out/);
    expect(processesWith(`sleep${'\0'}${marker}`)).toEqual([]);
  });

  it('a probe that backgrounds a process leaves no descendant behind (the run is reaped with it)', async () => {
    const marker = `${8000 + Math.floor(Math.random() * 999)}.5`;
    const d = await probeOf({ db: conn({ probe: `sleep ${marker} & exit 4` }) }).detail('db');
    expect(d.record).toMatchObject({ state: 'missing', probe: { exitCode: 4 } });
    expect(processesWith(`sleep${'\0'}${marker}`)).toEqual([]);
  });

  it('the probe runs with a scrubbed environment: a credential in the supervisor env never reaches it', async () => {
    process.env.TECERA_PROBE_TEST_TOKEN = 'probe-scrub-check-0123456789';
    try {
      const r = await new ConnectionProbe({ connections: { db: conn({ probe: '[ -z "$TECERA_PROBE_TEST_TOKEN" ] && [ -n "$PATH" ]' }) }, runner: RUNNER!, cwd: tmp(), envAllowlist: ['PATH'] }).probe('db');
      expect(r.state).toBe('available');
    } finally {
      delete process.env.TECERA_PROBE_TEST_TOKEN;
    }
  });
});

describe('capability probe decisions', () => {
  it('runs the declared probe command in the given cwd with the allowlist and timeout', async () => {
    const runner = new FakeRunner(() => ({ exitCode: 0 }));
    await new ConnectionProbe({ connections: { db: conn({ probe: 'pg_isready' }) }, runner, cwd: '/w', envAllowlist: ['PATH', 'HOME'], timeoutSec: 7 }).probe('db');
    expect(runner.calls).toEqual([{ cwd: '/w', command: 'pg_isready', timeoutSec: 7, envAllowlist: ['PATH', 'HOME'] }]);
  });

  it('exit 0 on an untrustworthy completion (stragglers, escape, unproven reap, cap) is missing with a non-zero exit', async () => {
    for (const bad of [{ stragglers: 1 }, { escaped: 1 }, { gone: false }, { truncated: true }, { cancelled: true }]) {
      const d = await new ConnectionProbe({ connections: { db: conn({ probe: 'true' }) }, runner: new FakeRunner(() => ({ exitCode: 0, ...bad })), cwd: '/w', envAllowlist: [] }).detail('db');
      expect(d.record.state, JSON.stringify(bad)).toBe('missing');
      expect(d.record.probe?.exitCode).toBe(PROBE_UNTRUSTED_EXIT);
    }
  });

  it('exit 0 without an attestation that the run left nothing behind is missing (fail-closed); the host runner attests by descendantsSurvived', async () => {
    const bare: VerifyRunner = { run: async () => ({ exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', durationMs: 1, truncated: false }) };
    const d = await new ConnectionProbe({ connections: { db: conn({ probe: 'true' }) }, runner: bare, cwd: '/w', envAllowlist: [] }).detail('db');
    expect(d.record).toMatchObject({ state: 'missing', probe: { exitCode: PROBE_UNTRUSTED_EXIT } });
    expect(d.reason).toMatch(/did not attest/);
    for (const [extra, state] of [[{ gone: undefined, descendantsSurvived: false }, 'available'], [{ gone: undefined, descendantsSurvived: true }, 'missing'], [{ gone: undefined }, 'missing']] as const) {
      const r = await new ConnectionProbe({ connections: { db: conn({ probe: 'true' }) }, runner: new FakeRunner(() => ({ ...extra })), cwd: '/w', envAllowlist: [] }).probe('db');
      expect(r.state, JSON.stringify(extra)).toBe(state);
    }
  });

  it('an auth resolver that throws leaves the connection missing; its message is not kept', async () => {
    const secret = 'resolver-threw-secret-0123456789';
    const p = new ConnectionProbe({ connections: { mail: conn({ kind: 'mail', auth: 'env:MAIL_KEY' }), ok: conn({ kind: 'mail', auth: 'env:OK' }) }, runner: new FakeRunner(() => ({})), cwd: '/w', envAllowlist: [], authResolves: (ref) => {
      if (ref === 'env:MAIL_KEY') throw new Error(`bad value ${secret}`);
      return true;
    } });
    const all = await p.probeAll();
    expect(all.map((d) => [d.record.id, d.record.state])).toEqual([
      ['mail', 'missing'],
      ['ok', 'available'],
    ]);
    expect(JSON.stringify(all)).not.toContain(secret);
  });

  it('a runner that refuses (no containment) leaves the connection missing; nothing is assumed', async () => {
    const runner: VerifyRunner = { run: async () => Promise.reject(new Error('verify containment unavailable')) };
    const d = await new ConnectionProbe({ connections: { db: conn({ probe: 'true' }) }, runner, cwd: '/w', envAllowlist: [] }).detail('db');
    expect(d.record).toMatchObject({ state: 'missing', probe: { exitCode: PROBE_UNTRUSTED_EXIT } });
    expect(d.reason).toMatch(/containment unavailable/);
  });

  it('a connection without a probe is available only when its auth reference resolves, and the value never appears', async () => {
    const secret = 'conn-secret-value-abcdef0123456789';
    const env = { MAIL_API_KEY: secret };
    const runner = new FakeRunner(() => ({ exitCode: 0 }));
    const p = new ConnectionProbe({ connections: { mail: conn({ kind: 'mail', auth: 'env:MAIL_API_KEY' }), other: conn({ kind: 'mail', auth: 'env:NOT_SET_ANYWHERE' }) }, runner, cwd: '/w', envAllowlist: [], authResolves: storeAuthResolver(env, '/w') });
    const ok = await p.detail('mail');
    expect(ok.record).toEqual({ id: 'mail', kind: 'mail', state: 'available', probe: { command: 'auth:env:MAIL_API_KEY', exitCode: 0 } });
    const no = await p.detail('other');
    expect(no.record.state).toBe('missing');
    expect(no.reason).toBe('auth reference env:NOT_SET_ANYWHERE does not resolve');
    expect(JSON.stringify([ok, no])).not.toContain(secret);
    expect(env.MAIL_API_KEY).toBe(secret);
    expect(runner.calls).toEqual([]);
  });

  it('without an auth resolver, or with neither probe nor auth, or undeclared: missing, nothing runs', async () => {
    const runner = new FakeRunner(() => ({ exitCode: 0 }));
    const p = new ConnectionProbe({ connections: { mail: conn({ auth: 'env:X_KEY' }), bare: conn({}) }, runner, cwd: '/w', envAllowlist: [] });
    expect((await p.probe('mail')).state).toBe('missing');
    expect(await p.detail('bare')).toMatchObject({ record: { id: 'bare', state: 'missing' }, reason: 'connection bare declares neither a probe nor an auth reference' });
    expect(await p.detail('nope')).toMatchObject({ record: { id: 'nope', kind: 'undeclared', state: 'missing' } });
    expect(await p.detail('constructor')).toMatchObject({ record: { kind: 'undeclared', state: 'missing' } });
    expect(runner.calls).toEqual([]);
  });

  it('probeAll probes every declared connection in id order; its capability.probed events project to the same inventory', async () => {
    const runner = new FakeRunner((req) => ({ exitCode: req.command === 'ok' ? 0 : 2 }));
    const p = new ConnectionProbe({ connections: { zeta: conn({ probe: 'bad' }), alpha: conn({ probe: 'ok' }) }, runner, cwd: '/w', envAllowlist: [] });
    const all = await p.probeAll();
    expect(all.map((d) => [d.record.id, d.record.state])).toEqual([
      ['alpha', 'available'],
      ['zeta', 'missing'],
    ]);
    const evs = all.map((d, n) => ({ ...capabilityProbedEvent(d.record, { id: `ev${n}`, at: n, actor: { kind: 'system', id: 'tecera-cli' }, runId: 'r1' }), seq: n + 1 }));
    const inv = capabilityInventoryOf(evs, { runId: 'r1' });
    expect(inv.byId.alpha?.state).toBe('available');
    expect(inv.byId.zeta?.state).toBe('missing');
    expect(inv.problems).toEqual([]);
    expect(() => capabilityProbedEvent(all[0]!.record as CapabilityRecord, { id: 'x', at: 0, actor: { kind: 'agent', id: 'w' } })).toThrow(/never an agent/);
  });

  it('a probe command carrying a known secret is recorded redacted', async () => {
    const secret = 'probe-cmd-secret-0123456789abcdef';
    const redactor = { redactText: (t: string) => t.split(secret).join('[REDACTED]'), redactJson: (v: unknown) => v, containsSecret: (v: unknown) => (String(v).includes(secret) ? 'x' : null) };
    const r = await new ConnectionProbe({ connections: { db: conn({ probe: `check --token ${secret}` }) }, runner: new FakeRunner(() => ({ exitCode: 0 })), cwd: '/w', envAllowlist: [], redactor: redactor as never }).probe('db');
    expect(JSON.stringify(r)).not.toContain(secret);
  });
});
