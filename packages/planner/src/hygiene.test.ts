import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { makeRedactor, type LLMUsage, type Manifest, type Plan, type UsageMeter } from '@tecera/contracts';
import { createPlanValidator, validateCandidate } from './checks.js';
import { FakeBeliefs, FakeLLM, adopted, belief, goal, goodDoc, sampleManifest, samplePermissions } from './fixtures.testkit.js';
import { MAX_PLAN_DEPTH, unescapeAll } from './hygiene.js';
import { LLMPlanner, PlanRejected, PlannerAccountingError, PlannerProviderError, type DeliberationRecord } from './llmPlanner.js';
import { parsePlanOutput } from './parse.js';
import { buildDeliberationPrompt, buildPlannerPrompt, buildRepairMessage, echoAssistant } from './prompt.js';
import { safeLine } from './render.js';
import { sampleFixFailingTestPlan } from './scripted.js';

/**
 * Sprint-2 Codex planner findings (wave 3 item 4, planner half):
 *   N1 deliberation reasons are redacted (and decoded-checked) BEFORE they are flattened and cut; truncated
 *      deliberation output is never used;
 *   N2 nesting is bounded and secret scans are complete at every depth (generated and reused plans);
 *   N3 every diagnostic (validator, PlanRejected, repair round, exception-derived) is sanitized.
 * Plus: deep prompt inputs, UsageMeter recording and budget-coded accounting errors.
 */

const m = sampleManifest();
const permissions = samplePermissions();
const SECRET = 'hunter2-' + randomBytes(12).toString('hex');
const SPACED = 'correct horse battery ' + randomBytes(6).toString('hex');
const redactor = makeRedactor([{ kind: 'key', value: SECRET }, { kind: 'phrase', value: SPACED }]);
const beliefs = new FakeBeliefs([belief('baseline', { exitCode: 1 })]);
const caught = (pr: Promise<unknown>) => pr.then(() => null, (e: unknown) => e);

const uEscape = (s: string) => [...s].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
/** Every encoding the tests plant. */
const forms = (s: string): string[] => {
  const b = Buffer.from(s);
  return [s, b.toString('hex'), b.toString('hex').toUpperCase(), b.toString('base64').replace(/=+$/, ''), b.toString('base64url'), uEscape(s), JSON.stringify(s).slice(1, -1), encodeURIComponent(s)];
};

/** No 10-character fragment of any encoded form appears, in the text or in up to three unescaped layers of it. */
function expectNoFragment(x: unknown, ...secrets: string[]): void {
  let text = typeof x === 'string' ? x : JSON.stringify(x);
  const layers = [text];
  for (let i = 0; i < 3; i++) layers.push((text = unescapeAll(text)));
  for (const s of secrets) {
    for (const f of forms(s)) {
      for (let i = 0; i + 10 <= f.length; i += 3) {
        const frag = f.slice(i, i + 10);
        for (const t of layers) expect(t.includes(frag), `fragment of an encoded secret leaked`).toBe(false);
      }
    }
  }
}

function nestedValue(depth: number, leaf: unknown): unknown {
  let v: unknown = leaf;
  for (let i = 0; i < depth; i++) v = { n: v };
  return v;
}

function planner(llm: FakeLLM, extra: Partial<ConstructorParameters<typeof LLMPlanner>[0]> = {}) {
  const decisions: DeliberationRecord[] = [];
  const p = new LLMPlanner({ llm, manifest: m, permissions, redactor, onUsage: () => {}, onDeliberation: (d) => void decisions.push(d), nonce: () => 'n1n1n1', ...extra });
  return { p, decisions };
}

function twoOptions(): Plan[] {
  const a = { ...sampleFixFailingTestPlan(), id: 'p_aaaaaaaa' };
  const b = { ...sampleFixFailingTestPlan(), id: 'p_bbbbbbbb' };
  return [a, b];
}

// ---------------------------------------------------------------------------------------------------------

describe('N1: deliberation reasons are redacted before they are cut (every encoding, at the 300-char boundary)', () => {
  for (const [name, enc] of [
    ['raw', (s: string) => s],
    ['hex', (s: string) => Buffer.from(s).toString('hex')],
    ['HEX', (s: string) => Buffer.from(s).toString('hex').toUpperCase()],
    ['base64', (s: string) => Buffer.from(s).toString('base64')],
    ['base64url', (s: string) => Buffer.from(s).toString('base64url')],
    ['JSON \\u-escaped (decoded once by the parser)', (s: string) => uEscape(s)],
    ['double-escaped (literal \\u text)', (s: string) => uEscape(s).replace(/\\/g, '\\\\')],
    ['URL-encoded', (s: string) => encodeURIComponent(s)],
  ] as const) {
    for (const pad of [280, 290, 295, 299]) {
      it(`${name} secret after ${pad} padding chars leaks no fragment into onDeliberation`, async () => {
        const reason = `${'x'.repeat(pad)}${enc(SECRET)} tail`;
        const out = `{"planId":"p_bbbbbbbb","reason":"${reason}"}`;
        const { p, decisions } = planner(new FakeLLM([out]));
        const chosen = await p.deliberate(twoOptions(), [], beliefs);
        expect(chosen.id).toBe('p_bbbbbbbb');
        expect(decisions).toHaveLength(1);
        expect(decisions[0]!.fallback).toBe(false);
        expectNoFragment(decisions[0], SECRET);
        expect(decisions[0]!.reason.length).toBeLessThanOrEqual(300 + 40);
      });
    }
  }

  it('a secret containing whitespace, split across lines by the model, is still redacted after flattening', async () => {
    const out = JSON.stringify({ planId: 'p_bbbbbbbb', reason: SPACED.replace(/ /g, '\n') });
    const { p, decisions } = planner(new FakeLLM([out]));
    await p.deliberate(twoOptions(), [], beliefs);
    expect(decisions[0]!.reason).not.toContain(SPACED);
    expect(decisions[0]!.reason).toContain('[REDACTED:phrase:');
  });

  it('a truncated (length) deliberation answer is never used: first option, fixed reason, no raw tail', async () => {
    const out = `{"planId":"p_bbbbbbbb","reason":"${'y'.repeat(290)}${Buffer.from(SECRET).toString('hex').slice(0, 20)}`;
    const { p, decisions } = planner(new FakeLLM([{ content: `${out}"}`, finishReason: 'length' }]));
    const chosen = await p.deliberate(twoOptions(), [], beliefs);
    expect(chosen.id).toBe('p_aaaaaaaa');
    expect(decisions).toEqual([{ planId: 'p_aaaaaaaa', reason: 'fallback: truncated deliberation output (never used)', fallback: true }]);
  });

  it('safeLine bounds only after redaction and the decoded check', () => {
    const line = safeLine(`${'z'.repeat(295)}${uEscape(SECRET).replace(/\\/g, '\\\\')}`, redactor, '', 300);
    expectNoFragment(line, SECRET);
    expect(line).toMatch(/^\[REDACTED:key:decoded\]$/);
  });
});

describe('N2: nesting is bounded and secret scans are complete (generated and reused plans)', () => {
  const deepDoc = (depth: number, leaf: unknown) => JSON.stringify({ ...goodDoc(), steps: goodDoc().steps.map((s) => (s.id === 'edit' ? { ...s, inputs: { v: nestedValue(depth, leaf) } } : s)) });

  it('write(): a canary beneath 70 nested objects in worker inputs is never returned (Codex probe)', async () => {
    const canary = 'TECERA_CANARY_deep_1234';
    const doc = deepDoc(70, canary);
    expect(parsePlanOutput(doc)).toEqual({ ok: false, issues: [`plan document nests deeper than ${MAX_PLAN_DEPTH} levels; flatten inputs/output`] });
    const llm = new FakeLLM([doc, doc]);
    const err = (await caught(new LLMPlanner({ llm, manifest: m, permissions }).write(adopted, beliefs, goal))) as PlanRejected;
    expect(err).toBeInstanceOf(PlanRejected);
    expect(err.issues.join('\n')).toMatch(/nests deeper than/);
    expect(JSON.stringify([err.issues, err.plan ?? null, err.message])).not.toContain(canary);
    expect(llm.requests).toHaveLength(2);
    expectNoFragment(llm.requests[1]!.messages, canary);
  });

  it('write(): a secret at an allowed depth, raw or escaped, is rejected; the rejected plan carries no decodable form', async () => {
    for (const leaf of [SECRET, uEscape(SECRET), Buffer.from(uEscape(SECRET)).toString('base64')]) {
      const doc = deepDoc(20, leaf);
      const err = (await caught(planner(new FakeLLM([doc, doc])).p.write(adopted, beliefs, goal))) as PlanRejected;
      expect(err).toBeInstanceOf(PlanRejected);
      expect(err.issues.join('\n')).toMatch(/secret-shaped content \(key\)/);
      expectNoFragment([err.issues, err.plan, err.message], SECRET);
    }
  });

  it('the loop validator rejects reused plans that are too deep, carry escaped secrets, accessors or Proxies', () => {
    const v = createPlanValidator({ permissions, redactor });
    const base = sampleFixFailingTestPlan();
    const withInputs = (inputs: unknown): Plan => ({ ...base, steps: base.steps.map((s, i) => (i === 0 ? { ...s, inputs: inputs as Plan['steps'][number]['inputs'] } : s)) });

    expect(v.validatePlan(withInputs({ v: nestedValue(70, 'TECERA_CANARY_deep_1234') }), m, goal)).toEqual([`plan nests deeper than ${MAX_PLAN_DEPTH} levels; refusing`]);
    expect(v.validatePlan({ ...base, rationale: `see ${uEscape(SECRET)}` }, m, goal).join('\n')).toMatch(/secret-shaped content \(key\)/);
    expect(v.validatePlan(withInputs({ blob: Buffer.from(JSON.stringify({ k: uEscape(SECRET) })).toString('base64') }), m, goal).join('\n')).toMatch(/secret-shaped content/);

    let reads = 0;
    const getter = withInputs({});
    Object.defineProperty(getter.steps[0]!.inputs, 'x', { enumerable: true, get: () => (reads++, SECRET) });
    expect(v.validatePlan(getter, m, goal)).toEqual(['plan is not plain inert data (an accessor, Proxy, non-plain object or nesting beyond the limit); refusing']);
    expect(reads).toBe(0);

    let traps = 0;
    const proxied = withInputs(new Proxy({}, { ownKeys: () => (traps++, []), get: () => (traps++, SECRET) }));
    expect(v.validatePlan(proxied, m, goal)[0]).toMatch(/not plain inert data/);
    expect(traps).toBe(0);
  });

  it('shared references are not mistaken for cycles; a cycle is refused', () => {
    const v = createPlanValidator({ permissions, redactor });
    const base = sampleFixFailingTestPlan();
    const shared = { note: 'same object twice' };
    const plan: Plan = { ...base, steps: base.steps.map((s) => (s.kind === 'worker' ? { ...s, inputs: { shared } } : s)) };
    expect(v.validatePlan(plan, m, goal)).toEqual([]);
    const cyc: Record<string, unknown> = {};
    cyc['self'] = cyc;
    const cyclic: Plan = { ...base, steps: base.steps.map((s, i) => (i === 0 ? { ...s, inputs: cyc as never } : s)) };
    expect(v.validatePlan(cyclic, m, goal)[0]).toMatch(/refusing/);
  });

  it('a validator without a redactor still scans every depth for SECRET_PATTERNS (canaries, key shapes)', () => {
    const v = createPlanValidator({ permissions });
    const base = sampleFixFailingTestPlan();
    const plan: Plan = { ...base, steps: base.steps.map((s, i) => (i === 0 ? { ...s, inputs: { v: nestedValue(25, 'TECERA_CANARY_nored_1') } } : s)) };
    const issues = v.validatePlan(plan, m, goal);
    expect(issues.join('\n')).toMatch(/secret-shaped content \(canary\)/);
    expect(issues.join('\n')).not.toContain('TECERA_CANARY_nored_1');
  });
});

describe('N3: loop-facing diagnostics are sanitized', () => {
  it('createPlanValidator({redactor}): a secret-named seat never appears in the returned diagnostics (Codex probe)', () => {
    const base = sampleFixFailingTestPlan();
    const withSeat = (seat: string): Plan => ({ ...base, allowedModels: { ...base.allowedModels, [base.steps[0]!.id]: [seat] } });
    // Pattern-shaped canary: sanitized with the supplied redactor AND by the SECRET_PATTERNS default.
    for (const v of [createPlanValidator({ permissions, redactor }), createPlanValidator({ permissions })]) {
      const issues = v.validatePlan(withSeat('TECERA_CANARY_diag_1234'), m, goal);
      expect(issues.join('\n')).toMatch(/\[REDACTED:canary:/);
      expect(issues.join('\n')).not.toContain('TECERA_CANARY_diag_1234');
      for (const line of issues) {
        expect(line).not.toMatch(/[\n\r]/);
        expect(line.length).toBeLessThanOrEqual(300 + 40);
      }
    }
    // A registered (non-pattern) secret: sanitized with the supplied redactor.
    const issues = createPlanValidator({ permissions, redactor }).validatePlan(withSeat(SECRET), m, goal);
    expect(issues.join('\n')).toMatch(/\[REDACTED:key:/);
    expectNoFragment(issues, SECRET);
  });

  it('exception-derived diagnostics are sanitized too', () => {
    const boom = new Error('x');
    boom.name = 'TECERA_CANARY_exc_1234';
    const hostile = { ...m } as Manifest;
    Object.defineProperty(hostile, 'seats', {
      get() {
        throw boom;
      },
    });
    const issues = validateCandidate(sampleFixFailingTestPlan(), { manifest: hostile, goal, permissions, redactor });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^plan validation failed: \[REDACTED:canary:/);
  });

  it('long diagnostics carrying an encoded secret past the cut leak no fragment (validator, repair round)', () => {
    const issue = `${'d'.repeat(290)}${Buffer.from(SECRET).toString('hex')} and ${uEscape(SECRET).replace(/\\/g, '\\\\')}`;
    const msg = buildRepairMessage([issue], { redactor, nonce: 'NN' });
    expectNoFragment(msg.content, SECRET);
    const echoed = echoAssistant(`${'e'.repeat(15_990)}${uEscape(SECRET).replace(/\\/g, '\\\\')}`, { redactor, nonce: 'NN' });
    expectNoFragment(echoed.content, SECRET);
  });

  it('PlanRejected.issues and message carry no decodable secret', async () => {
    const doc = JSON.stringify({ ...goodDoc(), permissions: { ...goodDoc().permissions, tools: ['read', 'edit', 'merge'] }, rationale: `x ${uEscape(SECRET)}` });
    const err = (await caught(planner(new FakeLLM([doc, doc])).p.write(adopted, beliefs, goal))) as PlanRejected;
    expect(err).toBeInstanceOf(PlanRejected);
    expect(err.issues.join('\n')).toMatch(/merge/);
    expectNoFragment([err.issues, err.message, err.plan], SECRET);
  });
});

describe('deep and encoded prompt inputs (beliefs, lessons, skills, rationales) are scanned before rendering', () => {
  it('escaped, encoded and deeply nested secrets never reach the planner prompt', () => {
    const deepBeliefs = [
      belief('deep', nestedValue(10, { v: uEscape(SECRET).replace(/\\/g, '\\\\') }) as never),
      belief('veryDeep', nestedValue(80, SECRET) as never),
      belief('edge', `${'p'.repeat(1990)}${uEscape(SECRET)}`),
    ];
    const lessons = [{ src: 'lesson-1', text: `use ${Buffer.from(uEscape(SECRET)).toString('base64')}` }];
    const skills = [{ src: 'skill-1', text: `${'s'.repeat(3990)}${Buffer.from(SECRET).toString('hex')}` }];
    const msgs = buildPlannerPrompt({ manifest: m, goal, event: adopted, beliefs: deepBeliefs, lessons, skills, permissions, redactor, nonce: 'NONCE' });
    expectNoFragment(msgs, SECRET);
    expect(msgs[1]!.content).toContain(':decoded]');
  });

  it('a plan rationale with an escaped secret is withheld from the deliberation prompt', () => {
    const [a, b] = twoOptions();
    const msgs = buildDeliberationPrompt({ options: [a!, { ...b!, rationale: `pick me ${uEscape(SECRET).replace(/\\/g, '\\\\')}` }], intentions: [], beliefs: [], redactor, nonce: 'NONCE' });
    expectNoFragment(msgs, SECRET);
  });
});

describe('UsageMeter and budget-coded accounting', () => {
  const meter = () => {
    const recorded: LLMUsage[] = [];
    const mtr: UsageMeter = { record: (u) => void recorded.push(u) };
    return { recorded, mtr };
  };

  it('write records every completion (write and repair) on the loop meter', async () => {
    const { recorded, mtr } = meter();
    const llm = new FakeLLM(['not a plan', JSON.stringify(goodDoc())]);
    await planner(llm).p.write(adopted, beliefs, goal, mtr);
    expect(recorded).toEqual([
      { inputTokens: 100, outputTokens: 50, usd: 0.001 },
      { inputTokens: 100, outputTokens: 50, usd: 0.001 },
    ]);
  });

  it('deliberate records its completion; missing usage and a throwing call are recorded as unknown (charged at the reservation)', async () => {
    const a = meter();
    await planner(new FakeLLM(['{"planId":"p_bbbbbbbb"}'])).p.deliberate(twoOptions(), [], beliefs, a.mtr);
    expect(a.recorded).toEqual([{ inputTokens: 100, outputTokens: 50, usd: 0.001 }]);

    const b = meter();
    const err = await caught(planner(new FakeLLM([{ content: 'x', usage: undefined as never }])).p.write(adopted, beliefs, goal, b.mtr));
    expect(err).toBeInstanceOf(PlannerAccountingError);
    expect(b.recorded).toHaveLength(1);
    expect(Number.isNaN(b.recorded[0]!.usd)).toBe(true);

    const c = meter();
    const t = await caught(planner(new FakeLLM([new Error('socket hang up')])).p.write(adopted, beliefs, goal, c.mtr));
    expect(t).toBeInstanceOf(PlannerProviderError);
    expect(c.recorded).toHaveLength(1);
    expect(Number.isNaN(c.recorded[0]!.usd)).toBe(true);
  });

  it('a throwing meter is an accounting failure, never ignored', async () => {
    const mtr: UsageMeter = {
      record: () => {
        throw new Error('meter broke');
      },
    };
    const err = await caught(planner(new FakeLLM([JSON.stringify(goodDoc())])).p.write(adopted, beliefs, goal, mtr));
    expect(err).toBeInstanceOf(PlannerAccountingError);
  });

  it('a budget failure from the LLM port or the usage sink is PlannerAccountingError {code: budget}, never a fallback', async () => {
    const budgetErr = Object.assign(new Error('budget exhausted for usd'), { code: 'budget' });
    const w = await caught(planner(new FakeLLM([budgetErr])).p.write(adopted, beliefs, goal));
    expect(w).toBeInstanceOf(PlannerAccountingError);
    expect((w as PlannerAccountingError).code).toBe('budget');
    const d = planner(new FakeLLM([budgetErr]));
    const de = await caught(d.p.deliberate(twoOptions(), [], beliefs));
    expect(de).toBeInstanceOf(PlannerAccountingError);
    expect((de as PlannerAccountingError).code).toBe('budget');
    expect(d.decisions).toHaveLength(0);
    const s = await caught(
      planner(new FakeLLM([JSON.stringify(goodDoc())]), {
        onUsage: () => {
          throw Object.assign(new Error('ledger refused'), { cause: { code: 'budget' } });
        },
      }).p.write(adopted, beliefs, goal),
    );
    expect((s as PlannerAccountingError).code).toBe('budget');
    const other = await caught(planner(new FakeLLM([JSON.stringify(goodDoc())]), { onUsage: () => Promise.reject(new Error('disk full')) }).p.write(adopted, beliefs, goal));
    expect(other).toBeInstanceOf(PlannerAccountingError);
    expect((other as PlannerAccountingError).code).toBeUndefined();
  });
});
