import { describe, expect, it } from 'vitest';
import { event, type Json, type LLM, type LLMRequest, type LLMResponse, type TeceraEvent } from '@tecera/contracts';
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
  it('maps events to the exit-code table', () => {
    expect(exitCodeForRun([ev('goal.achieved')], 'g').exitCode).toBe(EXIT.ok);
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
    expect(exitCodeForRun([held, ev('approval.consumed', { requestId: 'a' }), ev('goal.achieved')], 'g').exitCode).toBe(EXIT.ok);
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

  it('a well-formed proof whose verify evidence is missing, of another run, or not exit 0 does not let the assistant stop; a backed proof does', async () => {
    const proofFor = (key: string) => ({ command: 'node --test', exitCode: 0, fingerprint: 'f', evidenceKey: key, verifiedAt: 3 });
    const build = async (key: string, body: Json, rid = 'r1'): Promise<MemoryLedger> => {
      const l = new MemoryLedger();
      await l.evidence({ key: 'vk', kind: 'gate.verify', runId: rid, body });
      const g = { goalId: 'g' };
      let n = 0;
      for (const e of [
        evt('run.started', ++n, 'r1'),
        evt('goal.adopted', ++n, 'r1', { goal: { id: 'g', statement: 's', check: { command: 'node --test', timeoutSec: 60 } } }, g),
        evt('goal.achieved', ++n, 'r1', { goal: { id: 'g', check: { command: 'node --test', timeoutSec: 60 } }, proof: proofFor(key) }, g),
      ])
        await l.append(e);
      return l;
    };
    const ok = await evaluateStop(await build('vk', { exitCode: 0, fingerprint: 'f' }));
    expect(ok.decision).toMatchObject({ decision: 'allow', exitCode: 0 });
    const missing = await evaluateStop(await build('vk-missing', { exitCode: 0, fingerprint: 'f' }));
    expect(missing.decision.exitCode).toBe(2);
    expect(missing.missing).toMatch(/verify evidence vk-missing is not in the ledger/);
    const failed = await evaluateStop(await build('vk', { exitCode: 1, fingerprint: 'f' }));
    expect(failed.missing).toMatch(/records exit 1/);
    const other = await evaluateStop(await build('vk', { exitCode: 0, fingerprint: 'f' }, 'r-other'));
    expect(other.missing).toMatch(/belongs to run r-other/);
    const otherTree = await evaluateStop(await build('vk', { exitCode: 0, fingerprint: 'g' }));
    expect(otherTree.missing).toMatch(/another candidate/);
    // budget never matters: a budget.exhausted run with a backed proof may stop
    const l = await build('vk', { exitCode: 0, fingerprint: 'f' });
    await l.append(evt('budget.exhausted', 9, 'r1', { pool: 'usd', enforced: false }));
    expect((await evaluateStop(l)).decision.decision).toBe('allow');
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
