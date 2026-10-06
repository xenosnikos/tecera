import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LLM, LLMRequest, LLMResponse, LLMUsage, Plan, TeceraEvent, UsageMeter } from '@tecera/contracts';
import { MemoryLedger } from '@tecera/ledger';
import { Loop, MemoryPlanLibrary } from '@tecera/loop';
import {
  AnthropicLLM,
  FixtureFetch,
  OpenAILLM,
  SecretStore,
  anthropicProfile,
  anthropicSchemaProblems,
  buildAnthropicBody,
  buildOpenAIBody,
  openAIStrictSchemaProblems,
  type FixtureSpec,
} from '@tecera/providers';
import { ReflexRouter } from '@tecera/reflex';
import { createPlanValidator } from './checks.js';
import { FakeBeliefs, FakeLLM, adopted, belief, goal, goodDoc, sampleManifest, samplePermissions } from './fixtures.testkit.js';
import { MAX_DECODE_LAYERS, MAX_ESCAPE_LAYERS, MAX_PLAN_DEPTH, MAX_TOKENS, UNSCANNABLE, deepSecretKind, patternRedactor } from './hygiene.js';
import { LLMPlanner, PlanRejected, PlannerAccountingError, PlannerCancelled, type PlannerUsage } from './llmPlanner.js';
import { parsePlanOutput } from './parse.js';
import { PLAN_DOCUMENT_JSON_SCHEMA, PLAN_WIRE_JSON_SCHEMA, type PlanDocumentInput } from './schema.js';
import { sampleFixFailingTestPlan } from './scripted.js';

/**
 * Sprint-3 Codex models findings, planner half (wave 4, next steps 3, 12 and 13):
 *   F1 decoder exhaustion on generated and reused plans (token 512/513, token- and escape-layer boundary);
 *   F2 the planner's REAL wire schema is valid for both adapters' default structured-output modes, through
 *      the real request builders, and a wire answer round-trips through each real provider into a plan;
 *   F3 unknown usage settles at the reservation through the planner meter, never as confirmed zero;
 *   cancellation: the loop meter's signal reaches the LLM; an abort never yields a repair, a fallback or a plan;
 *   the decoder is one algorithm: planner/src/decode.ts is byte-identical to providers/src/decode.ts.
 */

const m = sampleManifest();
const permissions = samplePermissions();
const beliefs = new FakeBeliefs([belief('baseline', { exitCode: 1 })]);
const CANARY = 'TECERA_CANARY_wave4_planner_77';
const caught = (pr: Promise<unknown>) => pr.then(() => null, (e: unknown) => e);

const uEscape = (s: string) => [...s].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
const b64 = (s: string) => Buffer.from(s).toString('base64');
const b64n = (s: string, n: number) => {
  let t = s;
  for (let i = 0; i < n; i++) t = b64(t);
  return t;
};
const escN = (s: string, n: number) => {
  let t = uEscape(s);
  for (let i = 1; i < n; i++) t = t.replace(/\\/g, '\\\\');
  return t;
};
/** n distinct TWELVE-character tokens that decode (base64) to printable text: fits the 8000-char plan string limit. */
const harmless = (n: number) => Array.from({ length: n }, (_, i) => b64(`note${String(i).padStart(5, '0')}`)).join(' ');
/** The Codex probe: base64(\u-escaped secret) after n harmless twelve-character tokens. */
const probe = (n = MAX_TOKENS) => `${harmless(n)} ${b64(uEscape(CANARY))}`;

const withEditInputs = (inputs: Record<string, unknown>): PlanDocumentInput => ({ ...goodDoc(), steps: goodDoc().steps.map((s) => (s.id === 'edit' ? { ...s, inputs: inputs as never } : s)) });

/** Plan document → the wire format the structured-output schema asks for. */
function toWire(d: PlanDocumentInput): Record<string, unknown> {
  return {
    steps: d.steps.map((s) => ({
      id: s.id,
      kind: s.kind,
      dependsOn: s.dependsOn,
      instruction: s.instruction ?? null,
      inputsJson: s.inputs ? JSON.stringify(s.inputs) : null,
      outputJson: s.output ? JSON.stringify(s.output) : null,
      tools: s.tools ?? null,
    })),
    allowedModels: Object.entries(d.allowedModels).map(([step, seats]) => ({ step, seats })),
    permissions: d.permissions,
    budget: Object.fromEntries(['usd', 'tokens', 'wallClockSec', 'maxDepth', 'maxIterations', 'maxAttempts', 'maxChangedFiles'].map((k) => [k, (d.budget as Record<string, unknown>)[k] ?? null])),
    goalKinds: d.goalKinds,
    rationale: d.rationale,
    context: (d.context ?? []).map((c) => ({ key: c.key, equalsJson: c.equals === undefined ? null : JSON.stringify(c.equals), exists: c.exists ?? null })),
  };
}

describe('the decoder is one algorithm', () => {
  it('planner/src/decode.ts is byte-identical to providers/src/decode.ts', () => {
    const mine = readFileSync(new URL('./decode.ts', import.meta.url), 'utf8');
    const theirs = readFileSync(new URL('../../providers/src/decode.ts', import.meta.url), 'utf8');
    expect(mine).toBe(theirs);
  });
});

describe('F1 decoder exhaustion: generated plans (LLMPlanner.write) and reused plans (the loop validator)', () => {
  const r = patternRedactor();

  it(`token ${MAX_TOKENS}/${MAX_TOKENS + 1} on a plan value: 512 harmless tokens scan clean, 513 are UNSCANNABLE`, () => {
    expect(harmless(513).length).toBeLessThan(8000);
    expect(deepSecretKind({ v: harmless(512) }, r)).toBeNull();
    expect(deepSecretKind({ v: harmless(513) }, r)).toBe(UNSCANNABLE);
  });

  it('write(): the Codex probe in worker inputs is never returned (both attempts rejected)', async () => {
    const doc = JSON.stringify(withEditInputs({ note: probe() }));
    expect(doc.length).toBeLessThan(20_000);
    const llm = new FakeLLM([doc, doc]);
    const err = (await caught(new LLMPlanner({ llm, manifest: m, permissions }).write(adopted, beliefs, goal))) as PlanRejected;
    expect(err).toBeInstanceOf(PlanRejected);
    expect(err.issues.join('\n')).toMatch(/could not be completely scanned for secrets|secret-shaped/);
    expect(JSON.stringify(err.plan ?? null)).not.toContain(b64(uEscape(CANARY)));
    expect(JSON.stringify(err.issues)).not.toContain(b64(uEscape(CANARY)));
  });

  it('write(): the same probe through the WIRE format (inside inputsJson text) is rejected too', async () => {
    const doc = JSON.stringify(toWire(withEditInputs({ note: probe() })));
    const err = await caught(new LLMPlanner({ llm: new FakeLLM([doc, doc]), manifest: m, permissions }).write(adopted, beliefs, goal));
    expect(err).toBeInstanceOf(PlanRejected);
  });

  it('write(): token 512 is accepted, token 513 rejected; token-layer and escape-layer boundaries hold', async () => {
    const run = async (note: string) => caught(new LLMPlanner({ llm: new FakeLLM([JSON.stringify(withEditInputs({ note }))]), manifest: m, permissions }).write(adopted, beliefs, goal));
    expect(await run(harmless(512))).toBeNull();
    expect(await run(harmless(513))).toBeInstanceOf(PlanRejected);
    expect(MAX_DECODE_LAYERS).toBe(3);
    expect(await run(b64n('harmless nested text', MAX_DECODE_LAYERS))).toBeNull();
    expect(await run(b64n('harmless nested text', MAX_DECODE_LAYERS + 1))).toBeInstanceOf(PlanRejected);
    expect(await run(escN('harmless escaped text', MAX_ESCAPE_LAYERS))).toBeNull();
    expect(await run(escN('harmless escaped text', MAX_ESCAPE_LAYERS + 1))).toBeInstanceOf(PlanRejected);
    expect(await run(b64n(uEscape(CANARY), MAX_DECODE_LAYERS + 1))).toBeInstanceOf(PlanRejected);
  });

  it('reused plans: the loop validator refuses a library plan carrying the probe or an over-deep encoding', () => {
    const v = createPlanValidator({ permissions });
    const base = sampleFixFailingTestPlan();
    const withNote = (note: string): Plan => ({ ...base, steps: base.steps.map((s, i) => (i === 0 ? { ...s, inputs: { note } } : s)) });
    expect(v.validatePlan(withNote(harmless(512)), m, goal).join('\n')).not.toMatch(/scanned|secret/);
    for (const note of [probe(), harmless(513), b64n('harmless nested text', 4), escN('harmless escaped text', 9)]) {
      expect(v.validatePlan(withNote(note), m, goal).join('\n')).toMatch(/could not be completely scanned for secrets|secret-shaped/);
    }
  });
});

describe('F2 the real planner wire schema is valid for both adapters (real request builders)', () => {
  const plannerRequest = async (): Promise<LLMRequest> => {
    const llm = new FakeLLM([JSON.stringify(goodDoc())]);
    await new LLMPlanner({ llm, manifest: m, permissions }).write(adopted, beliefs, goal);
    return llm.requests[0]!;
  };

  it('the request LLMPlanner sends carries PLAN_WIRE_JSON_SCHEMA, and the prompt shows the same schema', async () => {
    const r = await plannerRequest();
    expect(r.schema).toEqual(PLAN_WIRE_JSON_SCHEMA);
    expect(r.messages[0]!.content).toContain(JSON.stringify(PLAN_WIRE_JSON_SCHEMA));
  });

  it('OpenAI: buildOpenAIBody(strict: true) with the planner request → no strict-mode problems', async () => {
    const body = buildOpenAIBody(await plannerRequest(), { model: 'gpt-6', effort: 'high', defaultMaxTokens: 4096, strictSchema: true }) as { text: { format: { type: string; strict: boolean; name: string; schema: unknown } } };
    expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true, name: 'tecera_output' });
    expect(openAIStrictSchemaProblems(body.text.format.schema)).toEqual([]);
  });

  it('Anthropic: buildAnthropicBody(format mode, the default) with the planner request → no structured-output problems', async () => {
    const body = buildAnthropicBody(await plannerRequest(), { model: 'claude-opus-5-5', effort: 'high', defaultMaxTokens: 4096, schemaMode: 'format', profile: anthropicProfile('claude-opus-5-5') }) as { output_config: { format: { type: string; schema: unknown } } };
    expect(body.output_config.format.type).toBe('json_schema');
    expect(anthropicSchemaProblems(body.output_config.format.schema)).toEqual([]);
  });

  it('the old document schema would have been rejected by both (why the wire format exists)', () => {
    expect(openAIStrictSchemaProblems(PLAN_DOCUMENT_JSON_SCHEMA).length).toBeGreaterThan(0);
    expect(anthropicSchemaProblems(PLAN_DOCUMENT_JSON_SCHEMA).length).toBeGreaterThan(0);
  });

  it('wire ↔ document: a wire answer parses to exactly the document it encodes; bad wire fields are issues', () => {
    const doc = { ...goodDoc(), context: [{ key: 'baseline', equals: { exitCode: 1 } }] };
    const viaDoc = parsePlanOutput(JSON.stringify(doc));
    const viaWire = parsePlanOutput(JSON.stringify(toWire(doc)));
    expect(viaDoc.ok).toBe(true);
    expect(viaWire).toEqual(viaDoc);
    const w = toWire(goodDoc()) as { steps: Array<Record<string, unknown>>; allowedModels: Array<Record<string, unknown>> };
    const bad = (patch: (x: typeof w) => void) => {
      const c = structuredClone(w);
      patch(c);
      return parsePlanOutput(JSON.stringify(c));
    };
    expect(bad((c) => (c.steps[1]!['inputsJson'] = '{not json'))).toEqual({ ok: false, issues: ['steps.1.inputsJson: must be JSON text'] });
    expect(bad((c) => (c.steps[1]!['inputsJson'] = '[1,2]'))).toEqual({ ok: false, issues: ['steps.1.inputsJson: must be the JSON text of an object'] });
    expect(bad((c) => c.allowedModels.push({ step: 'edit', seats: ['worker'] })).ok).toBe(false);
    expect(bad((c) => c.allowedModels.push({ step: '__proto__', seats: ['worker'] })).ok).toBe(false);
    expect(bad((c) => (c.steps[0]!['extra'] = 1)).ok).toBe(false);
    expect(bad((c) => (c.steps[1]!['inputsJson'] = JSON.stringify({ v: JSON.parse('{"n":'.repeat(40) + '1' + '}'.repeat(40)) })))).toEqual({
      ok: false,
      issues: [`plan document nests deeper than ${MAX_PLAN_DEPTH} levels; flatten inputs/output`],
    });
    const stamped = parsePlanOutput(JSON.stringify({ ...toWire(goodDoc()), id: 'p_00000000' }));
    expect(stamped.ok).toBe(false);
  });

  const aKey = 'sk-ant-api03-' + 'k'.repeat(40);
  const oKey = 'sk-proj-' + 'o'.repeat(40);
  const secrets = () => SecretStore.fromManifest({ providers: { anthropic: { auth: 'env:A' }, openai: { auth: 'env:O' } } }, { env: { A: aKey, O: oKey } });
  const wireText = JSON.stringify(toWire(goodDoc()));
  const fixtures: Record<'anthropic' | 'openai', FixtureSpec> = {
    anthropic: { status: 200, body: { type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: wireText }], stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 300 } } },
    openai: { status: 200, body: { object: 'response', model: 'gpt-6', status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: wireText }] }], usage: { input_tokens: 900, output_tokens: 300 } } },
  };
  for (const kind of ['anthropic', 'openai'] as const) {
    it(`${kind}: LLMPlanner → real ${kind} adapter (default schema mode) → wire answer → a valid plan; the sent schema is compatible`, async () => {
      const ff = new FixtureFetch([fixtures[kind]]);
      const s = secrets();
      const llm: LLM = kind === 'anthropic' ? new AnthropicLLM({ auth: s.get('anthropic'), model: 'claude-opus-5-5', fetch: ff.fetch, maxRetries: 0 }) : new OpenAILLM({ auth: s.get('openai'), model: 'gpt-6', fetch: ff.fetch, maxRetries: 0 });
      const usage: PlannerUsage[] = [];
      const plan = await new LLMPlanner({ llm, manifest: m, permissions, model: kind === 'anthropic' ? 'claude-opus-5-5' : 'gpt-6', onUsage: (u) => void usage.push(u) }).write(adopted, beliefs, goal);
      expect(plan.id).toMatch(/^p_[0-9a-f]{8}$/);
      expect(plan.allowedModels).toEqual(goodDoc().allowedModels);
      expect(ff.calls).toHaveLength(1);
      const sent = ff.calls[0]!.body as Record<string, any>;
      const schema = kind === 'anthropic' ? sent['output_config']['format']['schema'] : sent['text']['format']['schema'];
      expect(schema).toEqual(PLAN_WIRE_JSON_SCHEMA);
      expect(kind === 'anthropic' ? anthropicSchemaProblems(schema) : openAIStrictSchemaProblems(schema)).toEqual([]);
      if (kind === 'openai') expect(sent['text']['format']['strict']).toBe(true);
      expect(usage).toHaveLength(1);
      expect(usage[0]!.usage.inputTokens).toBe(900);
      expect(usage[0]!.unknown).toBeUndefined();
    });
  }
});

/** Records every request and the signal it was given; answers from a script. */
class SignalLLM implements LLM {
  readonly id = 'sig';
  readonly provider = 'fake';
  readonly requests: LLMRequest[] = [];
  readonly signals: Array<AbortSignal | undefined> = [];
  constructor(private readonly answer: (req: LLMRequest, signal?: AbortSignal) => Promise<LLMResponse>) {}
  async complete(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    this.requests.push(req);
    this.signals.push(signal);
    return this.answer(req, signal);
  }
}
const ok = (content: string, usage: LLMUsage = { inputTokens: 100, outputTokens: 50, usd: 0.001 }): LLMResponse => ({ content, usage, model: 'claude-sonnet-5', finishReason: 'stop' });
/** Behaves like a real provider on abort: an 'aborted' error response, possibly billed (unknown usage). */
const hangUntilAbort = (_req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> =>
  new Promise((resolve) => {
    const done = () => resolve({ content: 'aborted', error: 'aborted', finishReason: 'error', model: 'x', usage: { inputTokens: 0, outputTokens: 0, usd: 0, unknown: true } as LLMUsage });
    if (signal?.aborted) done();
    else signal?.addEventListener('abort', done, { once: true });
  });

describe('cancellation: every planner call path honours the loop meter signal and its own', () => {
  const meterWith = (signal: AbortSignal, reports: unknown[] = []): UsageMeter => ({ record: (u) => void reports.push(u), signal });

  it('write(): the meter signal is passed to the LLM; a pre-aborted meter sends nothing and throws PlannerCancelled', async () => {
    const llm = new SignalLLM(async () => ok(JSON.stringify(goodDoc())));
    const ac = new AbortController();
    await new LLMPlanner({ llm, manifest: m, permissions }).write(adopted, beliefs, goal, meterWith(ac.signal));
    expect(llm.signals[0]).toBeInstanceOf(AbortSignal);
    ac.abort(new Error('lease lost'));
    expect(llm.signals[0]!.aborted).toBe(true); // the signal the LLM got follows the meter's
    const llm2 = new SignalLLM(async () => ok(JSON.stringify(goodDoc())));
    const err = await caught(new LLMPlanner({ llm: llm2, manifest: m, permissions }).write(adopted, beliefs, goal, meterWith(AbortSignal.abort(new Error('deadline')))));
    expect(err).toBeInstanceOf(PlannerCancelled);
    expect(llm2.requests).toHaveLength(0);
  });

  it('write(): an abort mid-call records the (unknown) usage and never runs the repair round', async () => {
    const ac = new AbortController();
    const reports: unknown[] = [];
    const llm = new SignalLLM(hangUntilAbort);
    setTimeout(() => ac.abort(new Error('lease lost')), 10);
    const err = await caught(new LLMPlanner({ llm, manifest: m, permissions }).write(adopted, beliefs, goal, meterWith(ac.signal, reports)));
    expect(err).toBeInstanceOf(PlannerCancelled);
    expect((err as Error).message).toMatch(/lease lost/);
    expect(llm.requests).toHaveLength(1);
    expect(reports).toHaveLength(1);
    expect((reports[0] as { unknown?: boolean }).unknown).toBe(true);
  });

  it('write(): the options signal alone also cancels', async () => {
    const ac = new AbortController();
    const llm = new SignalLLM(hangUntilAbort);
    setTimeout(() => ac.abort(), 10);
    const reports: unknown[] = [];
    const err = await caught(new LLMPlanner({ llm, manifest: m, permissions, signal: ac.signal }).write(adopted, beliefs, goal, { record: (u) => void reports.push(u) }));
    expect(err).toBeInstanceOf(PlannerCancelled);
    expect(reports).toHaveLength(1);
    expect(llm.requests).toHaveLength(1);
  });

  it('deliberate(): an abort is never a fallback choice', async () => {
    const a = { ...sampleFixFailingTestPlan(), id: 'p_aaaaaaaa' };
    const b = { ...sampleFixFailingTestPlan(), id: 'p_bbbbbbbb' };
    const ac = new AbortController();
    const decisions: unknown[] = [];
    const llm = new SignalLLM(hangUntilAbort);
    setTimeout(() => ac.abort(), 10);
    const err = await caught(new LLMPlanner({ llm, manifest: m, permissions, onDeliberation: (d) => void decisions.push(d) }).deliberate([a, b], [], beliefs, meterWith(ac.signal)));
    expect(err).toBeInstanceOf(PlannerCancelled);
    expect(decisions).toHaveLength(0);
    const thrown = new SignalLLM(async (_r, s) => {
      await new Promise((res) => setTimeout(res, 20));
      if (s?.aborted) throw new Error('fetch aborted');
      return ok('{"planId":"p_bbbbbbbb","reason":"x"}');
    });
    const ac2 = new AbortController();
    setTimeout(() => ac2.abort(), 5);
    const err2 = await caught(new LLMPlanner({ llm: thrown, manifest: m, permissions, onDeliberation: (d) => void decisions.push(d) }).deliberate([a, b], [], beliefs, meterWith(ac2.signal)));
    expect(err2).toBeInstanceOf(PlannerCancelled);
    expect(decisions).toHaveLength(0);
  });
});

describe('F3 unknown usage is never settled as confirmed zero', () => {
  it('without a meter, unknown usage refuses to continue (PlannerAccountingError, not a plan)', async () => {
    const llm = new FakeLLM([{ content: JSON.stringify(goodDoc()), usage: { inputTokens: 0, outputTokens: 0, usd: 0, unknown: true } as LLMUsage }]);
    const err = await caught(new LLMPlanner({ llm, manifest: m, permissions }).write(adopted, beliefs, goal));
    expect(err).toBeInstanceOf(PlannerAccountingError);
    expect((err as PlannerAccountingError).code).toBeUndefined();
  });

  it('onUsage is told the usage is unknown', async () => {
    const usage: PlannerUsage[] = [];
    const llm = new FakeLLM([{ content: JSON.stringify(goodDoc()), usage: { inputTokens: 5000, outputTokens: 4096, usd: 0.2, unknown: true } as LLMUsage }]);
    const reports: unknown[] = [];
    await new LLMPlanner({ llm, manifest: m, permissions, onUsage: (u) => void usage.push(u) }).write(adopted, beliefs, goal, { record: (u) => void reports.push(u) });
    expect(usage[0]!.unknown).toBe(true);
    expect(reports).toEqual([{ inputTokens: 5000, outputTokens: 4096, usd: 0.2, unknown: true }]);
  });

  async function loopWith(llm: LLM) {
    const ledger = new MemoryLedger();
    await ledger.openBudget('r', 'calls', 100);
    await ledger.openBudget('r', 'usd', 100);
    await ledger.openBudget('r', 'tokens', 10_000_000);
    const settled: number[] = [];
    const settle = ledger.settle.bind(ledger);
    ledger.settle = async (id: string, actual: number) => {
      settled.push(actual);
      return settle(id, actual);
    };
    let t = 0;
    const loop = new Loop({
      manifest: m,
      ledger,
      library: new MemoryPlanLibrary(),
      planner: new LLMPlanner({ llm, manifest: m, permissions }),
      reflex: new ReflexRouter({ settings: m.reflexes, threshold: m.reflexes.threshold }, { sink: { async record() {} }, runId: 'r', now: () => ++t }),
      worker: { run: async () => Promise.reject(new Error('no')), resume: async () => Promise.reject(new Error('no')) },
      gates: { verify: async () => Promise.reject(new Error('no')), review: async () => Promise.reject(new Error('no')), commit: async () => Promise.reject(new Error('no')) },
      validator: createPlanValidator({ permissions }),
      seats: [{ seatId: 'worker', costPerMTok: 1 }],
      runId: 'r',
      sessionId: 'r',
      worktree: '/nonexistent-worktree',
      now: () => ++t,
    });
    return { loop, ledger, settled };
  }
  const kinds = async (ledger: MemoryLedger) => {
    const out: TeceraEvent[] = [];
    for await (const e of ledger.events()) out.push(e);
    return out.map((e) => e.kind);
  };

  it('in the real loop: a zero usage flagged unknown is charged the reservation (calls 1, usd 0.05, tokens 8000)', async () => {
    const llm = new FakeLLM([{ content: JSON.stringify(goodDoc()), usage: { inputTokens: 0, outputTokens: 0, usd: 0, unknown: true } as LLMUsage }]);
    const { loop, ledger, settled } = await loopWith(llm);
    await loop.adoptGoal({ id: goal.id, statement: goal.statement, check: goal.check, budget: goal.budget });
    expect(await kinds(ledger)).toContain('plan.staged');
    expect(settled).toEqual([1, 0.05, 8000]);
  });

  it('in the real loop: a POSITIVE usage below the reservation flagged unknown is charged the reservation, not the small figure (Codex models finding 3)', async () => {
    const llm = new FakeLLM([{ content: JSON.stringify(goodDoc()), usage: { inputTokens: 2, outputTokens: 0, usd: 0.000001, unknown: true } as LLMUsage }]);
    const { loop, ledger, settled } = await loopWith(llm);
    await loop.adoptGoal({ id: goal.id, statement: goal.statement, check: goal.check, budget: goal.budget });
    expect(await kinds(ledger)).toContain('plan.staged');
    expect(settled).toEqual([1, 0.05, 8000]);
  });

  it('in the real loop through the REAL provider: a malformed answer keeps billed usage, a missing usage is bounded, then the repair succeeds', async () => {
    const aKey = 'sk-ant-api03-' + 'q'.repeat(40);
    const s = SecretStore.fromManifest({ providers: { anthropic: { auth: 'env:A' } } }, { env: { A: aKey } });
    const good = JSON.stringify(toWire(goodDoc()));
    const ff = new FixtureFetch([
      // usage missing: possibly billed, bounded and flagged unknown
      { status: 200, body: { type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: good }], stop_reason: 'end_turn' } },
      { status: 200, body: { type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: good }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 500 } } },
    ]);
    const llm = new AnthropicLLM({ auth: s.get('anthropic'), model: 'claude-sonnet-5', fetch: ff.fetch, maxRetries: 0 });
    const { loop, ledger, settled } = await loopWith(llm);
    await loop.adoptGoal({ id: goal.id, statement: goal.statement, check: goal.check, budget: goal.budget });
    expect(await kinds(ledger)).toContain('plan.staged');
    expect(ff.calls).toHaveLength(2);
    const sentBytes = Buffer.byteLength(ff.calls[0]!.bodyText!, 'utf8');
    const [calls, usd, tokens] = settled as [number, number, number];
    expect(calls).toBe(2);
    // first call: the bound (payload bytes + overhead, plus the full output allowance); second: as reported
    expect(tokens).toBeGreaterThanOrEqual(sentBytes + 4096 + 1500);
    expect(usd).toBeGreaterThan((1000 * 2 + 500 * 10) / 1e6);
  });
});
