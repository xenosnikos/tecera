import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { approvalGrantedEvent, event, prActionHash, verifyCommandDigest, type Json, type JsonObject, type LLM, type LLMRequest, type LLMResponse, type RunVerdict, type TeceraEvent } from '@tecera/contracts';
import { MemoryLedger } from '@tecera/ledger';
import { applyManagedBlock, BLOCK_END, BLOCK_START, jsonContains, jsonMerge, MergeError, securityConflicts } from './adapters/merge.js';
import { parseArgs, UsageError } from './cli/args.js';
import { exitCodeForRun } from './commands/run.js';
import { EXIT } from './errors.js';
import { RuntimeSecrets } from './secrets.js';
import { splitFrontMatter } from './util/frontmatter.js';
import { satisfies } from './util/semver.js';
import { costLine, costMarkdown, costRecordingLLM, costReport, COST_KIND } from './cost.js';
import { activeRunForStop, evaluateStop } from './stopHook.js';
import { providerOptions, providerSetup, withIdentity, wireOf } from './providerSetup.js';
import { scriptedFetch } from './scripted.js';
import { exhaustionRecorder } from './wiring.js';
import { localPrincipal, PrincipalError } from './principal.js';
import { diffTrees, repoFileView, snapshotTree } from './worktree.js';

describe('argv parsing', () => {
  it('parses value flags, inline values, booleans, short flags and --', () => {
    const a = parseArgs(['approve', 'ap_1', '--as', 'bob', '--reason=ok', '--json', '-q', '--', '--not-a-flag']);
    expect(a.positionals).toEqual(['approve', 'ap_1', '--not-a-flag']);
    expect(a.values).toEqual({ as: 'bob', reason: 'ok' });
    expect(a.bools).toEqual({ json: true, quiet: true });
  });
  it('rejects unknown flags, missing values and values on booleans', () => {
    expect(() => parseArgs(['--nope'])).toThrow(UsageError);
    expect(() => parseArgs(['--as'])).toThrow(/requires a value/);
    expect(() => parseArgs(['--as', '--json'])).toThrow(/requires a value/);
    expect(() => parseArgs(['--json=1'])).toThrow(/does not take a value/);
  });
});

describe('semver ranges', () => {
  it.each([
    ['0.1.0', '>=0.1.0 <0.2.0', true],
    ['0.2.0', '>=0.1.0 <0.2.0', false],
    ['0.1.5', '^0.1.0', true],
    ['0.2.0', '^0.1.0', false],
    ['1.4.0', '^1.2.0', true],
    ['0.1.9', '~0.1.2', true],
    ['0.1.0', '0.1.x', true],
    ['0.1.0', '*', true],
    ['0.1.0', '>=1.0.0 || 0.1.0', true],
    ['0.1.0', '0.0.1 - 0.1.0', true],
    ['0.1.0', 'garbage', false],
  ])('%s satisfies %s → %s', (v, r, want) => expect(satisfies(v, r)).toBe(want));
});

describe('front matter', () => {
  it('parses scalars, flow maps, comments; rejects junk', () => {
    const fm = splitFrontMatter('---\nid: x\nverify: npm test   # comment\nbudget: { usd: 2, wallClockSec: 1200 }\ntags: [a, "b c"]\n---\nBody line\n');
    expect(fm.data).toEqual({ id: 'x', verify: 'npm test', budget: { usd: 2, wallClockSec: 1200 }, tags: ['a', 'b c'] });
    expect(fm.body).toBe('Body line');
    expect(() => splitFrontMatter('no fence')).toThrow(/front matter/);
    expect(() => splitFrontMatter('---\nnot a pair\n---\n')).toThrow(/key: value/);
  });
});

describe('merge policies', () => {
  it('managed block: append once, replace in place, idempotent, refuses malformed files', () => {
    const user = '# My notes\n\nkeep me\n';
    const once = applyManagedBlock(user, 'v1');
    expect(once.startsWith(user.trimEnd())).toBe(true);
    expect(once).toContain(`${BLOCK_START}\nv1\n${BLOCK_END}`);
    const twice = applyManagedBlock(once, 'v1');
    expect(twice).toBe(once);
    const replaced = applyManagedBlock(`${once}\ntrailer\n`, 'v2');
    expect(replaced).toContain('keep me');
    expect(replaced).toContain('trailer');
    expect(replaced).toContain('v2');
    expect(replaced).not.toContain('v1');
    expect(() => applyManagedBlock(`${BLOCK_START}\nx\n`, 'v')).toThrow(MergeError);
    expect(applyManagedBlock(undefined, `inner ${BLOCK_END} sneaky`)).toBe(`${BLOCK_START}\ninner  sneaky\n${BLOCK_END}\n`);
  });
  it('jsonContains compares types and scalars: a conflicting security setting is not "installed"', () => {
    const patch = { permissions: { deny: ['Edit(tecera.json)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'tecera hook stop' }] }] } };
    expect(jsonContains({ permissions: { deny: false }, hooks: false } as never, patch)).toBe(false);
    expect(jsonContains({ permissions: { deny: 'Edit(tecera.json)' }, hooks: patch.hooks } as never, patch)).toBe(false);
    expect(jsonContains({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonContains({ a: 1, ...patch }, patch)).toBe(true);
    const r = jsonMerge({ permissions: { deny: false }, hooks: false } as never, patch);
    expect(securityConflicts(r.conflicts)).toHaveLength(2);
    expect(securityConflicts(jsonMerge(false as never, patch).conflicts)).toHaveLength(1);
    expect(securityConflicts(jsonMerge({ theme: 'dark' }, { theme: 'light' }).conflicts)).toHaveLength(0);
  });
  it('json-merge never clobbers user scalars, unions arrays, and is idempotent', () => {
    const user = { theme: 'dark', permissions: { deny: ['Bash(rm:*)'], defaultMode: 'plan' } };
    const patch = { theme: 'light', permissions: { deny: ['Edit(tecera.json)', 'Bash(rm:*)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'tecera hook stop' }] }] } };
    const r = jsonMerge(user, patch);
    expect(r.value).toEqual({ theme: 'dark', permissions: { deny: ['Bash(rm:*)', 'Edit(tecera.json)'], defaultMode: 'plan' }, hooks: patch.hooks });
    expect(r.conflicts).toHaveLength(1);
    expect(jsonMerge(r.value, patch).value).toEqual(r.value);
    const { theme: _t, ...security } = patch;
    expect(jsonContains(r.value, security)).toBe(true);
    expect(jsonContains(r.value, patch)).toBe(false); // the kept user scalar differs: reported, not "installed"
    expect(jsonContains(user, security)).toBe(false);
  });
});

describe('redaction', () => {
  it('resolves manifest credentials, deletes them from env, and redacts every encoding plus patterns and canaries', () => {
    const secret = 'super-secret-value-123';
    const env: Record<string, string | undefined> = { MY_PROVIDER_KEY: secret, TECERA_CANARY_ENVX: 'TECERA_CANARY_ENVX_value_1234', PATH: '/usr/bin' };
    const s = RuntimeSecrets.load({ providers: { anthropic: { auth: 'env:MY_PROVIDER_KEY' } } }, env, { cwd: '/' });
    expect(env.MY_PROVIDER_KEY).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(s.status).toEqual([{ provider: 'anthropic', ref: 'env:MY_PROVIDER_KEY', envName: 'MY_PROVIDER_KEY', resolved: true }]);
    const r = s.redactor;
    const text = `key sk-ant-abcdefghijklmnop and ${secret} and ${Buffer.from(secret).toString('base64')} TECERA_CANARY_xyz Authorization: Bearer ${secret} ${encodeURIComponent(secret)} ${JSON.stringify(JSON.stringify(secret))}`;
    const out = r.redactText(text);
    for (const leak of ['sk-ant-abcdefghijklmnop', secret, Buffer.from(secret).toString('base64'), 'TECERA_CANARY_xyz']) expect(out).not.toContain(leak);
    expect(out).toMatch(/\[REDACTED:anthropic:[0-9a-f]{8}\]/);
    expect(r.containsSecret(out)).toBeNull();
  });
  it('fails closed on a configured credential too short to redact', () => {
    expect(() => RuntimeSecrets.load({ providers: {} }, {}, { cwd: '/', extra: [{ kind: 'x', value: 'short' }] })).toThrow(/shorter than 8/);
    // A short provider credential is either refused by the store (unresolved, unusable) or fails startup.
    let s: RuntimeSecrets | null = null;
    try {
      s = RuntimeSecrets.load({ providers: { anthropic: { auth: 'env:K' } } }, { K: 'short' }, { cwd: '/' });
    } catch (e) {
      expect(String(e)).toMatch(/shorter than 8|at least 8/);
    }
    if (s) expect(s.status[0]!.resolved).toBe(false);
  });
  it('a missing credential is reported by name, never by value', () => {
    const s = RuntimeSecrets.load({ providers: { openai: { auth: 'env:NOPE_KEY' } } }, {}, { cwd: '/' });
    expect(s.status[0]).toMatchObject({ provider: 'openai', envName: 'NOPE_KEY', resolved: false });
  });
});

describe('run outcome from the ledger', () => {
  let n = 0;
  const ev = (kind: TeceraEvent['kind'], payload: Record<string, unknown> = {}, trace: TeceraEvent['trace'] = { goalId: 'g' }): TeceraEvent =>
    ({ id: `e${++n}`, kind, at: n, actor: { kind: 'system', id: 't' }, trace, payload } as TeceraEvent);
  const proof = { command: 'node --test', exitCode: 0, fingerprint: 'f', evidenceKey: 'k', verifiedAt: 1 };
  const verdict = (o: { achieved?: boolean; provisional?: boolean; why?: string | null } = {}): RunVerdict => {
    const achieved = o.achieved ?? true;
    const provisional = o.provisional ?? false;
    const why = o.why ?? (achieved ? null : 'not proven');
    return { runId: 'r', achieved, provisional, why, goals: { g: { goalId: 'g', runId: 'r', achieved, provisional, why, ...(achieved || provisional ? { proof } : {}) } } };
  };
  it('exit 0 only on a proven verdict; a goal.achieved event alone proves nothing; provisional is 10, never 0', () => {
    expect(exitCodeForRun([ev('goal.achieved')], 'g', undefined, verdict()).exitCode).toBe(EXIT.ok);
    // the same event without a verdict, or with one that does not prove it: not achieved (and said so)
    const bare = exitCodeForRun([ev('goal.achieved')], 'g');
    expect(bare.exitCode).toBe(EXIT.ledger);
    expect(bare.reason).toMatch(/recorded but not proven/);
    expect(exitCodeForRun([ev('goal.achieved')], 'g', undefined, verdict({ achieved: false, why: 'the verify evidence carries no digest' })).reason).toMatch(/no digest/);
    // every criterion proven, one on a mock: provisional (10)
    const prov = exitCodeForRun([ev('goal.provisional')], 'g', undefined, verdict({ achieved: false, provisional: true, why: 'mail is mocked' }));
    expect(prov.exitCode).toBe(EXIT.provisional);
    expect(EXIT.provisional).not.toBe(EXIT.ok);
    // holds name what they wait for
    const signoff = ev('approval.requested', { requestId: 's', action: 'accept_criteria' }, { goalId: 'g', intentionId: 'signoff:g', stepId: 'accept_criteria' });
    expect(exitCodeForRun([signoff], 'g')).toMatchObject({ exitCode: EXIT.held, reason: expect.stringMatching(/criteria sign-off approval s/) });
    const ask = ev('approval.requested', { requestId: 'c', action: 'provide_capability' }, { goalId: 'g', intentionId: 'capability:g', stepId: 'provide_capability' });
    expect(exitCodeForRun([ask], 'g').reason).toMatch(/a capability the run lacks/);
    const answer = ev('approval.requested', { requestId: 'a', action: 'answer_criterion' }, { goalId: 'g', intentionId: 'i', stepId: 'answer:k' });
    expect(exitCodeForRun([answer], 'g').reason).toMatch(/human criterion answer/);
  });
  it('maps events to the exit-code table', () => {
    expect(exitCodeForRun([ev('goal.achieved')], 'g', undefined, verdict()).exitCode).toBe(EXIT.ok);
    expect(exitCodeForRun([ev('approval.requested', { requestId: 'a' }), ev('step.held', { requestId: 'a' })], 'g').exitCode).toBe(EXIT.held);
    expect(exitCodeForRun([ev('step.failed', { reason: 'verify exit 1' }), ev('goal.dropped')], 'g').exitCode).toBe(EXIT.verifyFailed);
    expect(exitCodeForRun([ev('step.failed', { reason: 'review reject' }), ev('goal.dropped')], 'g').exitCode).toBe(EXIT.reviewRejected);
    expect(exitCodeForRun([ev('step.failed', { reason: 'aborted: budget' })], 'g').exitCode).toBe(EXIT.budget);
    expect(exitCodeForRun([ev('step.failed', { reason: 'aborted: protected' })], 'g').exitCode).toBe(EXIT.policy);
    expect(exitCodeForRun([ev('step.failed', { reason: 'blocked by gate', blocked: true })], 'g').exitCode).toBe(EXIT.policy);
    expect(exitCodeForRun([ev('plan.rejected', {}, { goalId: 'g', planId: 'p' }), ev('goal.dropped')], 'g').exitCode).toBe(EXIT.policy);
    expect(exitCodeForRun([ev('run.interrupted')], 'g').exitCode).toBe(EXIT.interrupted);
    expect(exitCodeForRun([], 'g').exitCode).toBe(EXIT.error);
    expect(exitCodeForRun([ev('goal.achieved')], 'g', { state: 'stopped', stopReason: 'ledger append failed' }).exitCode).toBe(EXIT.ledger);
    expect(exitCodeForRun([ev('step.failed', { reason: 'approval ap_1 could not be consumed: x', terminal: true })], 'g').exitCode).toBe(EXIT.policy);
    const held = ev('approval.requested', { requestId: 'a' }, { goalId: 'g', intentionId: 'i', stepId: 'commit' });
    expect(exitCodeForRun([held, ev('approval.granted', { requestId: 'a' })], 'g').exitCode).toBe(EXIT.held);
    expect(exitCodeForRun([held, ev('approval.consumed', { requestId: 'a' }), ev('goal.achieved')], 'g', undefined, verdict()).exitCode).toBe(EXIT.ok);
  });
});

// ---------- owner decisions: pure parts (D3 cost, D4 stop hook, D7 providers) ----------


const evt = (kind: TeceraEvent['kind'], i: number, runId: string | undefined, payload: Record<string, unknown> = {}, trace: TeceraEvent['trace'] = {}): TeceraEvent =>
  event(kind, { id: `u${i}`, at: i, actor: { kind: 'system', id: 't' }, ...(runId ? { runId } : {}), trace, payload: payload as never });

describe('D4: the active run of a business case (Stop hook)', () => {
  it('a started run without run.ended, or whose last segment ended held (4) or interrupted (130), is active; any other end is not; the latest run decides', () => {
    expect(activeRunForStop([])).toBeNull();
    const g = { goalId: 'g' };
    expect(activeRunForStop([evt('run.started', 1, 'r1'), evt('goal.adopted', 2, 'r1', {}, g)])).toEqual({ runId: 'r1', goalId: 'g', state: 'running' });
    expect(activeRunForStop([evt('run.started', 1, 'r1'), evt('run.ended', 2, 'r1', { exitCode: 4 })])).toMatchObject({ runId: 'r1', state: 'held' });
    expect(activeRunForStop([evt('run.started', 1, 'r1'), evt('run.ended', 2, 'r1', { exitCode: 130 })])).toMatchObject({ state: 'interrupted' });
    for (const x of [0, 3, 5, 6, 7, 8, 9]) expect(activeRunForStop([evt('run.started', 1, 'r1'), evt('run.ended', 2, 'r1', { exitCode: x })]), `exit ${x}`).toBeNull();
    // a held segment resumed to success is over; a later held run is the active one
    expect(activeRunForStop([evt('run.started', 1, 'r1'), evt('run.ended', 2, 'r1', { exitCode: 4 }), evt('run.ended', 3, 'r1', { exitCode: 0 })])).toBeNull();
    expect(activeRunForStop([evt('run.started', 1, 'r1'), evt('run.ended', 2, 'r1', { exitCode: 7 }), evt('run.started', 3, 'r2'), evt('run.ended', 4, 'r2', { exitCode: 4 })])).toMatchObject({ runId: 'r2', state: 'held' });
  });

  it('only a run ledgerProvenRun proves lets the assistant stop: a well-formed proof whose verify evidence is missing, of another run, not exit 0, without its digest or without its verify.passed blocks', async () => {
    const CHECK = { command: 'node --test', timeoutSec: 60 };
    const body = (o: Record<string, Json> = {}): JsonObject => ({ command: CHECK.command, commandDigest: verifyCommandDigest(CHECK.command), timeoutSec: 30, exitCode: 0, outcome: 'passed', fingerprint: 'f', runId: 'r1', ...o });
    const prHash = prActionHash({ intentionId: 'i1', stepId: 'pr', attempt: 0, sha: 'c1' });
    type Delivered = 'consumed' | 'granted' | 'pending' | 'none';
    const build = async (o: { key?: string; body?: JsonObject; rid?: string; passed?: boolean; held?: boolean; delivered?: Delivered; pr?: Record<string, Json> | null } = {}): Promise<MemoryLedger> => {
      const l = new MemoryLedger();
      await l.evidence({ key: 'vk', kind: 'gate.verify', runId: o.rid ?? 'r1', body: o.body ?? body() });
      // the PR the achievement follows: the approval the PR gate consumed and the gate.pr record it wrote (or,
      // for the refused cases, an approval that is only granted or still pending, or no delivery record)
      const delivered = o.delivered ?? 'consumed';
      if (delivered !== 'none') {
        await l.requestApproval({ requestId: 'ap_pr', runId: 'r1', sessionId: 's', actionHash: prHash, requester: { kind: 'system', id: 'loop' }, reason: 'open_pr', expiresAt: Date.now() + 60_000 });
        const ana = { kind: 'human' as const, id: 'ana' };
        if (delivered !== 'pending') await l.approve('ap_pr', ana, 's', Date.now(), approvalGrantedEvent({ id: 'grant-pr', at: 1, requestId: 'ap_pr', runId: 'r1', sessionId: 's', actionHash: prHash, approver: ana, trace: { goalId: 'g', intentionId: 'i1', stepId: 'pr' } }));
        if (delivered === 'consumed') await l.consume('ap_pr', prHash, 's', 'gate.pr:r1:ap_pr', Date.now());
      }
      if (o.pr !== null) {
        await l.evidence({ key: 'pk', kind: 'gate.pr', runId: 'r1', body: { intentionId: 'i1', stepId: 'pr', goalId: 'g', attempt: 0, sha: 'c1', outcome: 'requested', exitCode: 0, approval: { requestId: 'ap_pr', sessionId: 's', actionHash: prHash }, ...(o.pr ?? {}) } });
      }
      const g = { goalId: 'g' };
      const it1 = { goalId: 'g', intentionId: 'i1', planId: 'p', stepId: 'verify' };
      const goal = { id: 'g', statement: 's', check: CHECK, commitment: 'single-minded', status: 'open', evidence: [] };
      let n = 0;
      const list: TeceraEvent[] = [evt('run.started', ++n, 'r1'), evt('goal.adopted', ++n, 'r1', { goal }, g), evt('intention.pushed', ++n, 'r1', { intention: { id: 'i1' } }, it1)];
      if (o.passed !== false) list.push(evt('verify.passed', ++n, 'r1', { evidenceKey: o.key ?? 'vk', fingerprint: 'f', exitCode: 0 }, it1));
      if (delivered !== 'none') list.push(evt('pr.requested', ++n, 'r1', { step: 'pr', sha: 'c1', evidenceKey: 'pk', approvalRequestId: 'ap_pr' }, { ...it1, stepId: 'pr' }));
      list.push(evt('intention.done', ++n, 'r1', { intention: { id: 'i1' } }, it1), evt('goal.achieved', ++n, 'r1', { goal, proof: { command: CHECK.command, exitCode: 0, fingerprint: 'f', evidenceKey: o.key ?? 'vk', verifiedAt: 5 } }, g));
      if (o.held !== false) list.push(evt('run.ended', ++n, 'r1', { exitCode: 4 }));
      for (const e of list) await l.append(e);
      return l;
    };
    const ok = await evaluateStop(await build());
    expect(ok.decision).toMatchObject({ decision: 'allow', exitCode: 0 });
    expect(ok.proof).toMatchObject({ evidenceKey: 'vk', fingerprint: 'f' });
    for (const [name, l] of [
      ['missing evidence', await build({ key: 'vk-missing' })],
      ['not exit 0', await build({ body: body({ exitCode: 1, outcome: 'failed' }) })],
      ['another run', await build({ rid: 'r-other', body: body({ runId: 'r-other' }) })],
      ['another candidate', await build({ body: body({ fingerprint: 'g' }) })],
      ['no verify.passed', await build({ passed: false })],
    ] as const) {
      const s = await evaluateStop(l);
      expect(s.decision.exitCode, name).toBe(2);
      expect(s.missing, name).toMatch(/run r1 \(goal g\) is held for a human decision; its goal.achieved is not proven/);
    }
    // a proven goal.achieved of a run that never delivered its PR does not let the assistant stop: no PR
    // event, an approval that is pending, or granted but never consumed by the PR gate (a pr.requested appended
    // between `tecera approve` and the resume), or a consumed approval without the PR gate's delivery record
    for (const [name, o, why] of [
      ['no PR', { delivered: 'none' }, /claims its goal achieved before delivering it: no PR was delivered/],
      ['PR approval not granted', { delivered: 'pending' }, /claims its goal achieved before delivering it: its PR names no approval a human granted/],
      ['PR approval granted, never consumed', { delivered: 'granted' }, /its PR approval ap_pr is granted in the approvals table, not consumed/],
      ['no delivery record', { pr: null }, /no delivery record of the PR gate \(evidence pk is not in the ledger\)/],
      ['a refused delivery', { pr: { outcome: 'refused', exitCode: 8 } }, /evidence pk does not record a delivery/],
      ['a delivery of another commit', { pr: { sha: 'c2' } }, /evidence pk is of another commit/],
      ['a delivery on another approval', { pr: { approval: { requestId: 'ap_other', sessionId: 's', actionHash: prHash } } }, /delivered on another approval/],
      ['an approval that is not this PR\'s', { pr: { attempt: 1 } }, /approval ap_pr is not the PR approval of this commit/],
    ] as const) {
      const s = await evaluateStop(await build(o as never));
      expect(s.decision.exitCode, name).toBe(2);
      expect(s.missing, name).toMatch(why);
    }
    // a ledger that reads once and then fails (or fails part-way) is never decided on a partial view
    const flaky = await build();
    const read = flaky.events.bind(flaky);
    let reads = 0;
    flaky.events = ((...a: Parameters<typeof read>) => {
      if (++reads > 1) throw new Error('disk went away');
      return read(...a);
    }) as typeof flaky.events;
    const fl = await evaluateStop(flaky);
    expect(reads).toBeGreaterThan(1);
    expect(fl.decision).toMatchObject({ decision: 'block', exitCode: 2 });
    expect(fl.missing).toMatch(/could not be read \(disk went away\)/);
    // budget never matters: a budget.exhausted run with a proven goal may stop
    const l = await build();
    await l.append(evt('budget.exhausted', 99, 'r1', { pool: 'usd', enforced: false }));
    expect((await evaluateStop(l)).decision.decision).toBe('allow');
    // a run that ended (exit 0) is not active: the hook allows and names the proof of the latest run
    const ended = await build({ held: false });
    await ended.append(evt('run.ended', 98, 'r1', { exitCode: 0 }));
    expect(await evaluateStop(ended)).toMatchObject({ decision: { decision: 'allow' }, activeRun: null, provedRunId: 'r1' });
  });

  it('a provisional run (exit 10) blocks until it or a LATER run proves the same goal; a later run of another goal, or one that proves nothing, does not settle it', async () => {
    const prov = (goalId: string): TeceraEvent[] => [evt('run.started', 101, 'r0'), evt('goal.adopted', 102, 'r0', { goal: { id: goalId } }, { goalId }), evt('goal.provisional', 103, 'r0', {}, { goalId }), evt('run.ended', 104, 'r0', { exitCode: 10 })];
    const CHECK = { command: 'node --test', timeoutSec: 60 };
    const goal = { id: 'g', statement: 's', check: CHECK, commitment: 'single-minded', status: 'open', evidence: [] };
    const it1 = { goalId: 'g', intentionId: 'i1', planId: 'p', stepId: 'verify' };
    const later = async (o: { goalId?: string; proven?: boolean } = {}): Promise<MemoryLedger> => {
      const l = new MemoryLedger();
      for (const e of prov('g')) await l.append(e);
      const gid = o.goalId ?? 'g';
      const g = { ...goal, id: gid };
      const tr = { ...it1, goalId: gid };
      await l.evidence({ key: 'vk', kind: 'gate.verify', runId: 'r1', body: { command: CHECK.command, commandDigest: verifyCommandDigest(CHECK.command), timeoutSec: 30, exitCode: 0, outcome: 'passed', fingerprint: 'f', runId: 'r1' } });
      let n = 200;
      const list: TeceraEvent[] = [evt('run.started', ++n, 'r1'), evt('goal.adopted', ++n, 'r1', { goal: g }, { goalId: gid }), evt('intention.pushed', ++n, 'r1', { intention: { id: 'i1' } }, tr)];
      if (o.proven !== false) list.push(evt('verify.passed', ++n, 'r1', { evidenceKey: 'vk', fingerprint: 'f', exitCode: 0 }, tr));
      list.push(evt('intention.done', ++n, 'r1', { intention: { id: 'i1' } }, tr), evt('goal.achieved', ++n, 'r1', { goal: g, proof: { command: CHECK.command, exitCode: 0, fingerprint: 'f', evidenceKey: 'vk', verifiedAt: 5 } }, { goalId: gid }), evt('run.ended', ++n, 'r1', { exitCode: 0 }));
      for (const e of list) await l.append(e);
      return l;
    };
    const alone = new MemoryLedger();
    for (const e of prov('g')) await alone.append(e);
    expect(await evaluateStop(alone)).toMatchObject({ decision: { decision: 'block' }, provisional: true });
    // a later run proves goal g: the provisional run is superseded
    expect(await evaluateStop(await later())).toMatchObject({ decision: { decision: 'allow' }, provedRunId: 'r1' });
    // a later run of another goal, or one whose achievement is not proven, settles nothing
    expect((await evaluateStop(await later({ goalId: 'other' }))).decision.decision).toBe('block');
    expect((await evaluateStop(await later({ proven: false }))).decision.decision).toBe('block');
  });
});

describe('D3: cost per run, per step and per model', () => {
  it('cost.call events aggregate by seat, model and step; the line and the markdown report the pools and unknown usage', () => {
    const call = (i: number, seat: string, model: string, usd: number, trace: TeceraEvent['trace'] = {}, unknown = false) => evt('evidence.appended', i, 'r', { kind: COST_KIND, seat, provider: seat === 'reviewer' ? 'openai' : 'openrouter', model, inputTokens: 1000, outputTokens: 100, usd, unknown }, trace);
    const evs = [
      call(1, 'planner', 'anthropic/claude-sonnet-4.5', 0.02),
      call(2, 'worker', 'anthropic/claude-haiku-4.5', 0.005, { stepId: 'edit', intentionId: 'i' }),
      call(3, 'worker', 'anthropic/claude-haiku-4.5', 0.005, { stepId: 'edit', intentionId: 'i' }, true),
      call(4, 'reviewer', 'gpt-5.6-terra', 0.004, { stepId: 'review', intentionId: 'i' }),
      evt('evidence.appended', 5, 'r', { kind: 'tool.denied' }),
    ];
    const r = costReport(evs, [{ pool: 'usd', cap: 2, used: 0.05, enforce: false, reservations: 6 }]);
    expect(r.total).toMatchObject({ calls: 4, inputTokens: 4000, outputTokens: 400, usd: 0.034, unknown: 1 });
    expect(r.byModel.map((m) => [m.key, m.calls])).toEqual([['openrouter/anthropic/claude-sonnet-4.5', 1], ['openrouter/anthropic/claude-haiku-4.5', 2], ['openai/gpt-5.6-terra', 1]]);
    expect(r.byStep.find((x) => x.key === 'edit@i')).toMatchObject({ calls: 2, usd: 0.01 });
    expect(r.byStep.find((x) => x.key === '(planner)')).toMatchObject({ calls: 1 });
    expect(r.enforce).toBe(false);
    const line = costLine(r, 2);
    expect(line).toMatch(/^cost {7}\$0\.0340 · 4,400 tokens · 4 model call\(s\) · 1 with unknown usage \(charged at reservation\) · usd pool \$0\.0500\/\$2\.0000 incl\. reservations \(not enforced\) · by model: /);
    expect(line).toMatch(/INCOMPLETE: 2 call\(s\) could not be recorded/);
    expect(costMarkdown(r)).toMatch(/\| edit@i \| 2 \(1 unknown\) \| 2,000 \| 200 \| \$0\.0100 \|/);
  });

  it('costRecordingLLM reports each completed call with the step trace and never fails the call when the record cannot be written', async () => {
    const llm: LLM = { id: 'x', provider: 'anthropic', model: 'anthropic/claude-haiku-4.5', keyFingerprint: 'k', complete: async (req: LLMRequest): Promise<LLMResponse> => ({ content: 'ok', model: req.model, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 2, usd: 0.001 } }) } as unknown as LLM;
    const seen: Array<{ seat: string; provider: string; stepId?: string }> = [];
    const w = costRecordingLLM(llm, { seat: 'worker', provider: 'openrouter', sink: async (c, t) => void seen.push({ seat: c.seat, provider: c.provider, ...(t.stepId ? { stepId: t.stepId } : {}) }), trace: () => ({ stepId: 'edit' }) });
    expect((await w.complete({ seatId: 'worker', model: 'anthropic/claude-haiku-4.5', messages: [] } as unknown as LLMRequest)).content).toBe('ok');
    expect(seen).toEqual([{ seat: 'worker', provider: 'openrouter', stepId: 'edit' }]);
    expect(w.provider).toBe('anthropic'); // identity fields pass through (foreign review sees the real seat)
    let lost = 0;
    const broken = costRecordingLLM(llm, { seat: 'worker', provider: 'openrouter', sink: async () => { throw new Error('disk gone'); }, onUnrecorded: () => void lost++ });
    expect((await broken.complete({ seatId: 'worker', model: 'm', messages: [] } as unknown as LLMRequest)).content).toBe('ok');
    expect(lost).toBe(1);
  });

  it('budget.exhausted is recorded once per pool and only for soft pools', async () => {
    const l = new MemoryLedger();
    let n = 0;
    const rec = exhaustionRecorder(l, 'r', { ids: () => `x${++n}`, now: () => n, enforce: false });
    await rec({ pool: 'usd', used: 3, cap: 2, amount: 1, purpose: 'reviewer review' });
    await rec({ pool: 'usd', used: 4, cap: 2, amount: 1, purpose: 'reviewer review' });
    await rec({ pool: 'tokens', used: 9, cap: 2, amount: 1, purpose: 'frontier gate' });
    // another process (a resume) does not repeat what the ledger already has
    await exhaustionRecorder(l, 'r', { ids: () => `y${++n}`, now: () => n, enforce: false })({ pool: 'usd', used: 5, cap: 2, amount: 1, purpose: 'x' });
    await exhaustionRecorder(l, 'r', { ids: () => `z${++n}`, now: () => n, enforce: true })({ pool: 'calls', used: 5, cap: 2, amount: 1, purpose: 'x' });
    const kinds: string[] = [];
    for await (const e of l.events()) kinds.push(`${e.kind}:${(e.payload as { pool: string }).pool}`);
    expect(kinds).toEqual(['budget.exhausted:usd', 'budget.exhausted:tokens']);
  });
});

describe('D7: provider setup and the scripted transport', () => {
  it('OpenRouter is resolved by the installed providers package (no override); the fallback maps it onto the OpenAI wire at openrouter.ai with its own identity', () => {
    const m = { providers: { openrouter: { auth: 'env:OPENROUTER_API_KEY' }, openai: { auth: 'env:OPENAI_API_KEY' } } };
    const s = providerSetup(m);
    // either the providers package knows OpenRouter itself (nothing overridden) or the fallback is complete
    if (Object.keys(s.kinds).length) {
      expect(s).toEqual({ kinds: { openrouter: 'openai' }, baseUrls: { openrouter: 'https://openrouter.ai/api' }, identities: { openrouter: 'openrouter' } });
    } else expect(s).toEqual({ kinds: {}, baseUrls: {}, identities: {} });
    const fake = { kinds: { openrouter: 'openai' as const }, baseUrls: { openrouter: 'https://openrouter.ai/api' }, identities: { openrouter: 'openrouter' } };
    expect(providerOptions(fake, { maxRetries: 0 })).toEqual({ maxRetries: 0, kinds: { openrouter: 'openai' }, baseUrls: { openrouter: 'https://openrouter.ai/api' } });
    const llm = { provider: 'openai', keyFingerprint: 'k', complete: async () => ({}) } as unknown as LLM;
    expect(withIdentity(llm, fake, 'openrouter').provider).toBe('openrouter');
    expect(withIdentity(llm, fake, 'openai')).toBe(llm);
  });

  it('the scripted transport answers in the wire format of the request URL (Anthropic messages, OpenAI responses, OpenAI-compatible chat completions)', async () => {
    expect(wireOf('https://api.anthropic.com/v1/messages')).toBe('anthropic');
    expect(wireOf('https://openrouter.ai/api/v1/chat/completions')).toBe('openai-chat');
    expect(wireOf('https://api.openai.com/v1/responses')).toBe('openai-responses');
    const f = scriptedFetch('worker', 'auto', [{ text: 'one', usage: { input: 10, output: 2 } }]);
    const r = await f('https://openrouter.ai/api/v1/chat/completions' as never, { method: 'POST', body: JSON.stringify({ model: 'anthropic/claude-haiku-4.5' }) } as never);
    const b = (await r.json()) as { choices: Array<{ message: { content: string }; finish_reason: string }>; usage: { prompt_tokens: number; completion_tokens: number }; model: string };
    expect(b.choices[0]!.message.content).toBe('one');
    expect(b.choices[0]!.finish_reason).toBe('stop');
    expect(b.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 2 });
    expect(b.model).toBe('anthropic/claude-haiku-4.5');
  });
});

describe('D1: the local principal', () => {
  it('--as wins, then $USER, then $USERNAME; none, or a non-plain id, is a usage error (exit 2)', () => {
    expect(localPrincipal({ env: { USER: 'nick' } }, {})).toEqual({ kind: 'human', id: 'nick', method: 'local', authenticated: false, source: 'env:USER' });
    expect(localPrincipal({ env: { USER: 'nick' } }, { as: 'dana' })).toMatchObject({ id: 'dana', source: 'as' });
    expect(localPrincipal({ env: { USERNAME: 'win' } }, {})).toMatchObject({ id: 'win', source: 'env:USERNAME' });
    expect(() => localPrincipal({ env: {} }, {})).toThrow(PrincipalError);
    try {
      localPrincipal({ env: { USER: 'a b' } }, {});
    } catch (e) {
      expect((e as PrincipalError).exitCode).toBe(EXIT.usage);
    }
    expect(() => localPrincipal({ env: {} }, { as: '$(id)' })).toThrow(/plain identifier/);
  });
});

describe('closeOut change summary and the planner repository view (worktree)', () => {
  const gitRepo = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'tecera-diff-'));
    const g = (...a: string[]) => execFileSync('git', ['-C', d, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...a], { env: { PATH: process.env.PATH ?? '', HOME: d, GIT_CONFIG_GLOBAL: '/dev/null' } });
    g('init', '-q', '-b', 'main');
    mkdirSync(join(d, 'src'));
    writeFileSync(join(d, 'src/a.js'), 'one\ntwo\nthree\n');
    writeFileSync(join(d, 'gone.txt'), 'x\ny\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    return d;
  };

  it('diffTrees: paths and line counts between two checkpoints (added, modified, deleted, binary as 0); a malformed id throws', async () => {
    const d = gitRepo();
    try {
      const from = await snapshotTree(d);
      expect(await diffTrees(d, from, from)).toEqual([]);
      writeFileSync(join(d, 'src/a.js'), 'one\nTWO\nthree\nfour\n');
      rmSync(join(d, 'gone.txt'));
      writeFileSync(join(d, 'src/new file.js'), 'n\n');
      writeFileSync(join(d, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255]));
      const to = await snapshotTree(d);
      const files = await diffTrees(d, from, to);
      expect([...files].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
        { path: 'blob.bin', added: 0, removed: 0 },
        { path: 'gone.txt', added: 0, removed: 2 },
        { path: 'src/a.js', added: 2, removed: 1 },
        { path: 'src/new file.js', added: 1, removed: 0 },
      ]);
      await expect(diffTrees(d, 'base', to)).rejects.toThrow(/not a worktree checkpoint/);
      await expect(diffTrees(d, from, 'tree:--output=/tmp/x')).rejects.toThrow(/not a worktree checkpoint/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('repoFileView: a repository-relative file that exists; absolute, climbing or link-escaping paths are absent', () => {
    const d = gitRepo();
    const outside = mkdtempSync(join(tmpdir(), 'tecera-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 's');
      symlinkSync(outside, join(d, 'out'));
      const has = repoFileView(d);
      expect(has('src/a.js')).toBe(true);
      expect(has('./src/a.js')).toBe(true);
      expect(has('src/missing.js')).toBe(false);
      expect(has('')).toBe(false);
      expect(has(join(d, 'src/a.js'))).toBe(false);
      expect(has('src/../src/a.js')).toBe(false);
      expect(has('../' + d.split('/').pop() + '/src/a.js')).toBe(false);
      expect(has('out/secret.txt')).toBe(false);
    } finally {
      rmSync(d, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
