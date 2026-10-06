import { describe, expect, it } from 'vitest';
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { VerifyRequest } from '@tecera/contracts';
import { MemoryLedger } from '@tecera/ledger';
import { memLedger, ctx, FakeRunner, makeRepo, manifest } from './testkit/fixtures.js';
import { baselineVerify, scrubbedAllowlist, VerifyGate } from './verifyGate.js';
import { ignoredPathKey, ignoredStamp } from './candidate.js';
import { commandDigest } from './evidence.js';

const SECRET = 'hunter2-super-secret-value';

function setup(runner: FakeRunner, m = manifest()) {
  const repo = makeRepo();
  repo.write('src/a.ts', 'export const a = 2;\n');
  const ledger = memLedger();
  const gate = new VerifyGate({ ledger, manifest: m, runner, worktree: repo.dir, secrets: [SECRET] });
  return { repo, ledger, gate, c: ctx('v', { worktree: repo.dir }) };
}

describe('VerifyGate', () => {
  it('pass: exit 0, D1 fingerprint + per-file content record, redacted tails', async () => {
    const runner = new FakeRunner(() => ({ stdout: `all good ${SECRET}`, durationMs: 42 }));
    const { ledger, gate, repo, c } = setup(runner);
    const r = await gate.verify(c);
    expect(r).toMatchObject({ exitCode: 0, outcome: 'passed', terminal: false });
    expect(runner.calls[0]).toMatchObject({ cwd: repo.dir, command: 'node --test', timeoutSec: 60 });
    const ev = (await ledger.getEvidence(r.evidenceKey))!.body as Record<string, any>;
    expect(ev).toMatchObject({ exitCode: 0, timedOut: false, outcome: 'passed', durationMs: 42, humanNeeded: false });
    expect(ev.stdoutTail).toMatch(/^all good \[REDACTED:secret:[0-9a-f]{8}\]$/);
    expect(JSON.stringify(ev)).not.toContain(SECRET);
    expect(ev.fingerprint).toBe(r.fingerprint);
    expect(ev.fingerprintAfter).toBe(r.fingerprint);
    expect(ev.files).toEqual([{ path: 'src/a.ts', pathKey: ignoredPathKey('src/a.ts'), status: 'M', mode: '100644', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), oid: repo.g('hash-object', 'src/a.ts').trim(), bytes: 20 }]);
    expect(ev).toMatchObject({ command: 'node --test', checkSource: 'goal', manifestCommand: 'node --test', commandDigest: commandDigest('node --test') });
    expect(gate.memo.verify.get('run1:i1')?.evidenceKey).toBe(r.evidenceKey);
  });

  it('fail: a nonzero exit is a retryable failure normalised to 1, even when the runner exits 8 or 9', async () => {
    for (const code of [1, 8, 9, 2]) {
      const { ledger, gate, c } = setup(new FakeRunner(() => ({ exitCode: code, stderr: 'boom' })));
      const r = await gate.verify(c);
      expect(r).toMatchObject({ exitCode: 1, outcome: 'failed', terminal: false });
      expect((await ledger.getEvidence(r.evidenceKey))!.body).toMatchObject({ retryable: true, humanNeeded: false, stderrTail: 'boom', runnerExitCode: code });
    }
  });

  it.each([124, 126, 127])('tooling: exit %i is terminal and needs a human', async (code) => {
    const { ledger, gate, c } = setup(new FakeRunner(() => ({ exitCode: code })));
    const r = await gate.verify(c);
    expect(r).toMatchObject({ exitCode: code, outcome: 'tooling', terminal: true });
    expect((await ledger.getEvidence(r.evidenceKey))!.body).toMatchObject({ retryable: false, humanNeeded: true });
  });

  it('tooling: timeout, signal and cancellation map to 124; a runner that throws maps to 127', async () => {
    const timeout = setup(new FakeRunner(() => ({ exitCode: null, timedOut: true })));
    expect(await timeout.gate.verify(timeout.c)).toMatchObject({ exitCode: 124, outcome: 'tooling', terminal: true });
    const killed = setup(new FakeRunner(() => ({ exitCode: null, signal: 'SIGKILL' })));
    expect(await killed.gate.verify(killed.c)).toMatchObject({ exitCode: 124, outcome: 'tooling' });
    const cancelled = setup(new FakeRunner(() => ({ exitCode: 0, cancelled: true })));
    expect(await cancelled.gate.verify(cancelled.c)).toMatchObject({ exitCode: 124, outcome: 'tooling', terminal: true });
    const thrower = new FakeRunner(() => {
      throw new Error(`spawn ENOENT ${SECRET}`);
    });
    const t = setup(thrower);
    const r = await t.gate.verify(t.c);
    expect(r).toMatchObject({ exitCode: 127, outcome: 'tooling', terminal: true });
    expect(JSON.stringify((await t.ledger.getEvidence(r.evidenceKey))!.body)).not.toContain(SECRET);
  });

  it('passes the GateContext signal to the runner', async () => {
    let seen: AbortSignal | undefined;
    class SignalRunner extends FakeRunner {
      override run(req: VerifyRequest, signal?: AbortSignal) {
        seen = signal;
        return super.run(req);
      }
    }
    const s = setup(new SignalRunner());
    const ac = new AbortController();
    await s.gate.verify({ ...s.c, signal: ac.signal });
    expect(seen).toBe(ac.signal);
  });

  it('mutated: a verify run that changes the tree fails even with exit 0 (terminal)', async () => {
    let dir = '';
    const runner = new FakeRunner(() => {
      writeFileSync(join(dir, 'src/a.ts'), 'export const a = 3;\n');
      return { exitCode: 0 };
    });
    const s = setup(runner);
    dir = s.repo.dir;
    const r = await s.gate.verify(s.c);
    expect(r).toMatchObject({ exitCode: 9, outcome: 'mutated', terminal: true });
    const ev = (await s.ledger.getEvidence(r.evidenceKey))!.body as Record<string, unknown>;
    expect(ev.fingerprint).not.toBe(ev.fingerprintAfter);
    expect(ev.humanNeeded).toBe(true);
  });

  it('mutated: a file written into an IGNORED directory by tests counts too', async () => {
    let dir = '';
    const s = setup(
      new FakeRunner(() => {
        mkdirSync(join(dir, 'ignored'), { recursive: true });
        writeFileSync(join(dir, 'ignored/coverage.json'), '{}');
        return {};
      }),
    );
    dir = s.repo.dir;
    expect(s.repo.g('check-ignore', 'ignored/coverage.json').trim()).toBe('ignored/coverage.json');
    expect((await s.gate.verify(s.c)).outcome).toBe('mutated');
  });

  it("refuses an empty GateContext worktree ('' = not configured) without running anything", async () => {
    const runner = new FakeRunner();
    const s = setup(runner);
    const r = await s.gate.verify(ctx('v', { worktree: '' }));
    expect(r).toMatchObject({ exitCode: 9, outcome: 'refused', terminal: true });
    expect(runner.calls).toHaveLength(0);
    const other = await s.gate.verify(ctx('v', { worktree: '/tmp/some-other-worktree' }));
    expect(other).toMatchObject({ exitCode: 9, outcome: 'refused' });
  });

  it('refuses a repository with a hostile local config before running verify', async () => {
    const runner = new FakeRunner();
    const s = setup(runner);
    s.repo.g('config', 'core.fsmonitor', 'touch /tmp/never');
    const r = await s.gate.verify(s.c);
    expect(r).toMatchObject({ exitCode: 9, outcome: 'refused', terminal: true });
    expect(runner.calls).toHaveLength(0);
  });

  it('env allowlist is scrubbed of provider refs and secret-looking names', async () => {
    const m = manifest({ sandbox: { profile: 'process', isolation: 'node', network: false, memoryMb: 256, execTimeoutSec: 60, envAllowlist: ['PATH', 'HOME', 'OPENAI_API_KEY', 'MY_TOKEN', 'CI', 'ANTHROPIC_API_KEY'] } });
    expect(scrubbedAllowlist(m)).toEqual(['CI', 'HOME', 'PATH']);
    const runner = new FakeRunner();
    const s = setup(runner, m);
    await s.gate.verify(s.c);
    expect(runner.calls[0]!.envAllowlist).toEqual(['CI', 'HOME', 'PATH']);
  });

  it('caps tails AFTER redaction: a secret crossing the cut never leaves a fragment', async () => {
    const big = 'x'.repeat(100_000) + SECRET + 'y'.repeat(8 * 1024 - 10);
    const { ledger, gate, c } = setup(new FakeRunner(() => ({ exitCode: 1, stderr: big })));
    const r = await gate.verify(c);
    const ev = (await ledger.getEvidence(r.evidenceKey))!.body as { stderrTail: string };
    expect(ev.stderrTail.length).toBeLessThan(9 * 1024);
    expect(ev.stderrTail).toMatch(/elided/);
    for (let n = 8; n < SECRET.length; n++) expect(ev.stderrTail).not.toContain(SECRET.slice(SECRET.length - n));
  });

  it('baseline records the run baseline and the ignored-file baseline on the untouched tree', async () => {
    const repo = makeRepo();
    repo.write('ignored/dep.js', 'module.exports = 1;\n');
    const ledger = memLedger();
    const r = await baselineVerify({ ledger, manifest: manifest(), runner: new FakeRunner(), worktree: repo.dir }, { runId: 'run1' });
    expect(r.exitCode).toBe(0);
    const rec = await ledger.getEvidence(r.evidenceKey);
    expect(rec).toMatchObject({ kind: 'gate.verify.baseline', runId: 'run1' });
    expect(rec!.body).toMatchObject({ baseline: true, outcome: 'passed' });
    const body = (await ledger.getEvidence('verify-baseline-ignored:run1'))!.body as { entries: Record<string, string> };
    expect(body).toMatchObject({ v: 3, count: 1, entries: { [ignoredPathKey('ignored/dep.js')]: expect.stringMatching(/^[0-9a-f]{64}$/) }, names: { [ignoredPathKey('ignored/dep.js')]: 'ignored/dep.js' } });
    // v3 entries are stamps (content + type + permission bits + link identity), never the bare content hash.
    const st = lstatSync(join(repo.dir, 'ignored/dep.js'));
    const contentSha = createHash('sha256').update('module.exports = 1;\n').digest('hex');
    expect(body.entries[ignoredPathKey('ignored/dep.js')]).not.toBe(contentSha);
    expect(body.entries[ignoredPathKey('ignored/dep.js')]).toBe(ignoredStamp(contentSha, { kind: 'file', perm: st.mode & 0o7777, link: null }));
  });

  it('baseline does not record an ignored baseline when the tree already has changes', async () => {
    const repo = makeRepo();
    repo.write('src/a.ts', 'changed\n');
    const ledger = memLedger();
    await baselineVerify({ ledger, manifest: manifest(), runner: new FakeRunner(), worktree: repo.dir }, { runId: 'run1' });
    expect(await ledger.getEvidence('verify-baseline-ignored:run1')).toBeNull();
  });

  it('a worktree that is not a git repo is refused, not a pass', async () => {
    const ledger = memLedger();
    const r = await new VerifyGate({ ledger, manifest: manifest(), runner: new FakeRunner() }).verify(ctx('v', { worktree: '/nonexistent-tecera-dir' }));
    expect(r.exitCode).not.toBe(0);
    expect(r.terminal).toBe(true);
  });
});

describe('VerifyGate runs the adopted goal check (wave 3)', () => {
  const m = () => manifest({ verify: { command: 'node --test manifest-suite', timeoutSec: 120 } });

  it('GateContext.goal.check wins over the manifest command; evidence records both and which ran', async () => {
    const runner = new FakeRunner();
    const s = setup(runner, m());
    const goalCtx = { ...s.c, goal: { ...s.c.goal, check: { command: 'node --test goal-suite', timeoutSec: 30 } } };
    const r = await s.gate.verify(goalCtx);
    expect(r.exitCode).toBe(0);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({ command: 'node --test goal-suite', timeoutSec: 30 });
    expect((await s.ledger.getEvidence(r.evidenceKey))!.body).toMatchObject({
      command: 'node --test goal-suite',
      checkSource: 'goal',
      manifestCommand: 'node --test manifest-suite',
      commandDigest: commandDigest('node --test goal-suite'),
      timeoutCapped: false,
    });
    expect(s.gate.memo.verify.get('run1:i1')!.commandDigest).toBe(commandDigest('node --test goal-suite'));
  });

  it("the goal's timeout is capped by the manifest's", async () => {
    const runner = new FakeRunner();
    const s = setup(runner, m());
    const r = await s.gate.verify({ ...s.c, goal: { ...s.c.goal, check: { command: 'node --test slow', timeoutSec: 9999 } } });
    expect(runner.calls[0]!.timeoutSec).toBe(120);
    expect((await s.ledger.getEvidence(r.evidenceKey))!.body).toMatchObject({ timeoutCapped: true, timeoutSec: 120 });
  });

  it('a malformed goal check is refused (9) and nothing runs; the manifest command is not substituted', async () => {
    for (const check of [{ command: '', timeoutSec: 30 }, { command: '   ', timeoutSec: 30 }, { command: 'node --test', timeoutSec: 0 }, null]) {
      const runner = new FakeRunner();
      const s = setup(runner, m());
      const r = await s.gate.verify({ ...s.c, goal: { ...s.c.goal, check: check as never } });
      expect(r).toMatchObject({ exitCode: 9, outcome: 'refused', terminal: true });
      expect(runner.calls).toHaveLength(0);
    }
  });

  it('no goal check in the context at all → the manifest command runs and is recorded as such', async () => {
    const runner = new FakeRunner();
    const s = setup(runner, m());
    const { check: _drop, ...goal } = s.c.goal;
    const r = await s.gate.verify({ ...s.c, goal: goal as never });
    expect(runner.calls[0]!.command).toBe('node --test manifest-suite');
    expect((await s.ledger.getEvidence(r.evidenceKey))!.body).toMatchObject({ checkSource: 'manifest' });
  });

  it('baseline runs the check it is given (the goal check) and records it', async () => {
    const repo = makeRepo();
    const ledger = memLedger();
    const runner = new FakeRunner();
    const r = await baselineVerify({ ledger, manifest: m(), runner, worktree: repo.dir }, { runId: 'run1', check: { command: 'node --test goal-suite', timeoutSec: 30 } });
    expect(runner.calls[0]!.command).toBe('node --test goal-suite');
    expect((await ledger.getEvidence(r.evidenceKey))!.body).toMatchObject({ checkSource: 'goal', baseline: true });
  });
});

describe('VerifyGate: truncated or incomplete output never passes (wave 3)', () => {
  it.each([
    ['truncated', { truncated: true }],
    ['stdout truncated', { truncated: false, stdoutTruncated: true }],
    ['stderr truncated', { truncated: false, stderrTruncated: true }],
    ['runner cannot say (truncated missing)', { truncated: undefined as unknown as boolean }],
  ])('exit 0 with %s output is a failure (1), not a pass', async (_n, extra) => {
    const s = setup(new FakeRunner(() => ({ exitCode: 0, ...extra })));
    const r = await s.gate.verify(s.c);
    expect(r).toMatchObject({ exitCode: 1, outcome: 'failed' });
    expect(r.reason).toMatch(/truncated/);
    expect((await s.ledger.getEvidence(r.evidenceKey))!.body).toMatchObject({ outputTruncated: true, outcome: 'failed' });
  });

  it('a cancelled run is terminal even with exit 0 and complete output', async () => {
    const s = setup(new FakeRunner(() => ({ exitCode: 0, cancelled: true, truncated: false })));
    expect(await s.gate.verify(s.c)).toMatchObject({ exitCode: 124, outcome: 'tooling', terminal: true });
    const ac = new AbortController();
    ac.abort();
    const t = setup(new FakeRunner(() => ({ exitCode: 0 })));
    expect(await t.gate.verify({ ...t.c, signal: ac.signal })).toMatchObject({ terminal: true });
  });

  it('a runner outcome without a numeric exit code is tooling, never a pass', async () => {
    const s = setup(new FakeRunner(() => ({ exitCode: '0' as unknown as number })));
    expect(await s.gate.verify(s.c)).toMatchObject({ exitCode: 127, outcome: 'tooling', terminal: true });
  });
});
