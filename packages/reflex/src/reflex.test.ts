import { describe, expect, it } from 'vitest';
import type { DecisionRecord, Reflex, ReflexAskOptions, ReflexQuestions, ReflexResult, ReflexSeam } from '@tecera/contracts';
import { RulesReflex, UNCHECKED_CHANGE_CONFIDENCE, asState, type GateState } from './rules.js';
import { ReflexRouter, type Frontier } from './router.js';

const rules = new RulesReflex();

describe('RulesReflex', () => {
  it('triage routes to a known intention, else new', async () => {
    const opts = [{ intentionId: 'i1', label: 'a' }, { intentionId: null, label: 'new' }];
    expect((await rules.ask('triage', { state: asState({ eventKind: 'belief.added', trace: { intentionId: 'i1' } }), options: opts })).answer).toEqual({ intentionId: 'i1' });
    expect((await rules.ask('triage', { state: asState({ eventKind: 'goal.adopted' }), options: opts })).answer).toEqual({ intentionId: null });
  });

  it('choosePlan: single option certain; ties and missing scores abstain; scores rank', async () => {
    const one = await rules.ask('choosePlan', { state: asState({}), options: [{ planId: 'p1', label: '' }] });
    expect(one).toMatchObject({ answer: { planId: 'p1' }, confidence: 1, abstained: false });
    const two = await rules.ask('choosePlan', { state: asState({}), options: [{ planId: 'p1', label: '' }, { planId: 'p2', label: '' }] });
    expect(two.abstained).toBe(true);
    const scored = await rules.ask('choosePlan', { state: asState({ scores: { p1: 1, p2: 3 } }), options: [{ planId: 'p1', label: '' }, { planId: 'p2', label: '' }] });
    expect(scored.answer).toEqual({ planId: 'p2' });
    expect(scored.confidence).toBeCloseTo(0.75);
    const tie = await rules.ask('choosePlan', { state: asState({ scores: { p1: 2, p2: 2 } }), options: [{ planId: 'p1', label: '' }, { planId: 'p2', label: '' }] });
    expect(tie.abstained).toBe(true);
  });

  it('route picks the cheapest allowed seat', async () => {
    const r = await rules.ask('route', { state: asState({}), options: [{ seatId: 'opus', costPerMTok: 15 }, { seatId: 'haiku', costPerMTok: 1 }, { seatId: 'sonnet', costPerMTok: 3 }] });
    expect(r.answer).toEqual({ seatId: 'haiku' });
  });

  it('gate fails closed', async () => {
    const opts = [{ decision: 'allow' as const }, { decision: 'hold' as const }, { decision: 'block' as const }];
    const g = (s: GateState) => rules.ask('gate', { state: asState(s), options: opts }).then((r) => r.answer.decision);
    expect(await g({ tool: 'read', risk: 'read', permission: 'always' })).toBe('allow');
    expect(await g({ tool: 'edit', risk: 'write' })).toBe('allow');
    // D6: a work-branch write proceeds under degraded isolation too (the PR is the approval point)
    expect(await g({ tool: 'edit', risk: 'write', isolationDegraded: true })).toBe('allow');
    expect(await g({ tool: 'gate.commit', risk: 'write', permission: 'always' })).toBe('allow');
    expect(await g({ tool: 'gate.pr', risk: 'irreversible', permission: 'requiresApproval' })).toBe('hold');
    expect(await g({ tool: 'git', method: 'commit', risk: 'irreversible' })).toBe('hold');
    expect(await g({ tool: 'edit', risk: 'write', permission: 'requiresApproval' })).toBe('hold');
    expect(await g({ tool: 'edit', risk: 'write', touchesProtected: true })).toBe('block');
    expect(await g({ tool: 'git', method: 'push', risk: 'irreversible', permission: 'never' })).toBe('block');
    // option set without 'allow' forces block
    const noAllow = await rules.ask('gate', { state: asState({ tool: 'read', risk: 'read', permission: 'always' }), options: [{ decision: 'block' }] });
    expect(noAllow.answer.decision).toBe('block');
  });

  it('reconsider applies the commitment policy', async () => {
    const ask = (commitment: 'blind' | 'single-minded' | 'open-minded', invalidatesContext: boolean, goalChanged: boolean) =>
      rules.ask('reconsider', { state: asState({ commitment, eventKind: 'belief.added', invalidatesContext, goalChanged }) }).then((r) => r.answer.interrupt);
    expect(await ask('blind', true, true)).toBe(false);
    expect(await ask('single-minded', true, false)).toBe(true);
    expect(await ask('single-minded', false, true)).toBe(false);
    expect(await ask('open-minded', false, true)).toBe(true);
    expect(await ask('open-minded', false, false)).toBe(false);
  });

  it('reconsider: an amended acceptance contract interrupts under every commitment, blind included', async () => {
    for (const commitment of ['blind', 'single-minded', 'open-minded'] as const) {
      const r = await rules.ask('reconsider', { state: asState({ commitment, eventKind: 'criteria.amended', invalidatesContext: false, goalChanged: false, contractChanged: true }) });
      expect(r.answer.interrupt).toBe(true);
    }
  });

  it('closeOut (L5-F2): a worker return reporting an error, or a writing step that changed nothing, is never accepted', async () => {
    const c = (s: Record<string, unknown>) => rules.ask('closeOut', { state: asState({ stepKind: 'worker', returnValid: true, policyAborts: 0, ...s }) });
    expect((await c({ reportsError: true })).answer.achieved).toBe(false);
    expect((await c({ reportsError: true, expectsChange: true, changed: true })).answer.achieved).toBe(false);
    expect((await c({ expectsChange: true, changed: false })).answer).toEqual({ achieved: false });
    expect((await c({ expectsChange: true, changed: false })).confidence).toBe(1);
    expect(await c({ expectsChange: true, changed: true })).toMatchObject({ answer: { achieved: true }, confidence: 1 });
    // a read-only step need not change anything
    expect(await c({ expectsChange: false, changed: false })).toMatchObject({ answer: { achieved: true }, confidence: 1 });
    // a writing step whose change could not be checked is accepted below the default threshold (it escalates)
    const unchecked = await c({ expectsChange: true, changed: null });
    expect(unchecked).toMatchObject({ answer: { achieved: true }, confidence: UNCHECKED_CHANGE_CONFIDENCE, abstained: false });
    expect(unchecked.confidence).toBeLessThan(0.6);
    // no snapshot port at all: the old rule (valid return, no aborts)
    expect(await c({ expectsChange: true })).toMatchObject({ answer: { achieved: true }, confidence: 1 });
  });

  it('closeOut decides on the facts, never on the evidence a model decider reads (a worker summary is a claim)', async () => {
    const c = (s: Record<string, unknown>) => rules.ask('closeOut', { state: asState({ stepKind: 'worker', returnValid: true, policyAborts: 0, reportsError: false, expectsChange: true, ...s }) });
    const evidence = { instruction: 'fix slugify', outputSchema: 'satisfied', workerSummary: 'done, all tests pass', verify: { exitCode: 0, passed: true, attempt: 1 } };
    // the first writing step, checked against its baseline: certain, so it never escalates
    expect(await c({ ...evidence, changed: true, change: { files: 1, added: 1, removed: 1, paths: [{ path: 'src/slugify.js', added: 1, removed: 1 }] } })).toMatchObject({ answer: { achieved: true }, confidence: 1, abstained: false });
    // a summary claiming success does not rescue a step that changed nothing, nor one that reported an error
    expect(await c({ ...evidence, changed: false, change: { files: 0, added: 0, removed: 0, paths: [] } })).toMatchObject({ answer: { achieved: false }, confidence: 1 });
    expect((await c({ ...evidence, changed: true, reportsError: true })).answer.achieved).toBe(false);
    // an unknown change state escalates (below threshold) instead of deciding with confidence 0
    const unknown = await c({ ...evidence, changed: null, change: { files: null } });
    expect(unknown.answer.achieved).toBe(true);
    expect(unknown.confidence).toBe(UNCHECKED_CHANGE_CONFIDENCE);
  });

  it('closeOut never trusts a model opinion', async () => {
    const c = (s: Record<string, unknown>) => rules.ask('closeOut', { state: asState(s) }).then((r) => r.answer.achieved);
    expect(await c({ stepKind: 'gate.verify', exitCode: 0 })).toBe(true);
    expect(await c({ stepKind: 'gate.verify', exitCode: 1 })).toBe(false);
    expect(await c({ stepKind: 'gate.review', verdict: 'approve' })).toBe(true);
    expect(await c({ stepKind: 'gate.pr', exitCode: 0 })).toBe(true);
    expect(await c({ stepKind: 'gate.pr', exitCode: 9 })).toBe(false);
    expect(await c({ stepKind: 'gate.review', verdict: 'reject' })).toBe(false);
    expect(await c({ stepKind: 'worker', returnValid: true, policyAborts: 0 })).toBe(true);
    expect(await c({ stepKind: 'worker', returnValid: true, policyAborts: 1 })).toBe(false);
    expect(await c({ stepKind: 'worker', returnValid: false })).toBe(false);
  });
});

class RecordingSink {
  records: DecisionRecord[] = [];
  async record(d: DecisionRecord) {
    this.records.push(d);
  }
}

class FakeModel implements Reflex {
  seen: Array<ReflexAskOptions | undefined> = [];
  constructor(private readonly confidence: number, private readonly abstained = false, private readonly fixed?: unknown) {}
  async ask<S extends ReflexSeam>(seam: S, q: ReflexQuestions[S], opts?: ReflexAskOptions): Promise<ReflexResult<S>> {
    this.seen.push(opts);
    const options = (q as { options?: Array<Record<string, unknown>> }).options ?? [];
    const first = this.fixed ?? options[options.length - 1] ?? {};
    return { seam, answer: first as never, confidence: this.confidence, provider: 'jev', abstained: this.abstained };
  }
}

let frontierCalls = 0;
const frontier: Frontier = {
  async decide(seam, q) {
    frontierCalls++;
    const opts = (q as { options?: Array<Record<string, unknown>> }).options ?? [];
    return { seam, answer: opts[0] as never, confidence: 0.99, provider: 'frontier', abstained: false };
  },
};

const allRule = { triage: 'rule', choosePlan: 'rule', route: 'rule', gate: 'rule', reconsider: 'rule', closeOut: 'rule' } as const;

describe('ReflexRouter', () => {
  const routeQ = { state: asState({}), options: [{ seatId: 'cheap', costPerMTok: 1 }, { seatId: 'pricey', costPerMTok: 9 }] };

  it('rule setting uses rules and records acted', async () => {
    const sink = new RecordingSink();
    const r = new ReflexRouter({ settings: allRule, threshold: 0.6 }, { sink, runId: 'r', now: () => 5 });
    const out = await r.route('route', routeQ);
    expect(out).toMatchObject({ outcome: 'acted', setting: 'rule' });
    expect(out.result.answer).toEqual({ seatId: 'cheap' });
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({ seam: 'route', provider: 'rules', outcome: 'acted', runId: 'r', at: 5 });
  });

  it('model setting uses the model when confident, escalates when shaky, falls back to rules when it abstains', async () => {
    const sink = new RecordingSink();
    const confident = new ReflexRouter({ settings: { ...allRule, route: 'model' }, threshold: 0.6 }, { sink, runId: 'r', model: new FakeModel(0.9), frontier });
    expect((await confident.route('route', routeQ))).toMatchObject({ outcome: 'acted', result: { provider: 'jev', answer: { seatId: 'pricey' } } });
    const shaky = new ReflexRouter({ settings: { ...allRule, route: 'model' }, threshold: 0.6 }, { sink, runId: 'r', model: new FakeModel(0.3), frontier });
    expect((await shaky.route('route', routeQ))).toMatchObject({ outcome: 'escalated', result: { provider: 'frontier', answer: { seatId: 'cheap' } } });
    const abstaining = new ReflexRouter({ settings: { ...allRule, route: 'model' }, threshold: 0.6 }, { sink, runId: 'r', model: new FakeModel(0.9, true) });
    expect(await abstaining.route('route', routeQ)).toMatchObject({ outcome: 'fallback', result: { provider: 'rules' } });
  });

  it('D2: the decision model is used when present (and receives signal and meter); a model seam without one falls back to rules, recorded as fallback', async () => {
    const sink = new RecordingSink();
    const model = new FakeModel(0.9);
    const opts: ReflexAskOptions = { signal: new AbortController().signal, meter: { record: () => undefined } };
    const r = new ReflexRouter({ settings: { ...allRule, route: 'model' }, threshold: 0.6 }, { sink, runId: 'r', model });
    expect(await r.ask('route', routeQ, opts)).toMatchObject({ provider: 'jev' });
    expect(model.seen[0]).toBe(opts);
    const none = new ReflexRouter({ settings: { ...allRule, route: 'model' }, threshold: 0.6 }, { sink, runId: 'r' });
    expect(await none.route('route', routeQ)).toMatchObject({ outcome: 'fallback', result: { provider: 'rules', answer: { seatId: 'cheap' } } });
  });

  it('frontier setting asks the frontier; the gate answer is never looser than the rules', async () => {
    const sink = new RecordingSink();
    const f = new ReflexRouter({ settings: { ...allRule, gate: 'frontier' }, threshold: 0.6 }, { sink, runId: 'r', frontier });
    const gateQ = { state: asState({ tool: 'x', risk: 'read' }), options: [{ decision: 'hold' as const }, { decision: 'allow' as const }] };
    expect(await f.route('gate', gateQ)).toMatchObject({ outcome: 'escalated', result: { provider: 'frontier', answer: { decision: 'hold' } } });
    // a frontier (or model) that says allow where the rules hold cannot loosen the gate
    const loose: Frontier = { decide: async (seam) => ({ seam, answer: { decision: 'allow' } as never, confidence: 1, provider: 'frontier', abstained: false }) };
    const g = new ReflexRouter({ settings: { ...allRule, gate: 'frontier' }, threshold: 0.6 }, { sink, runId: 'r', frontier: loose });
    const irreversible = { state: asState({ tool: 'gate.pr', risk: 'irreversible', permission: 'requiresApproval' }), options: [{ decision: 'allow' as const }, { decision: 'hold' as const }, { decision: 'block' as const }] };
    expect((await g.route('gate', irreversible)).result.answer.decision).toBe('hold');
    const m = new ReflexRouter({ settings: { ...allRule, gate: 'model' }, threshold: 0.6 }, { sink, runId: 'r', model: new FakeModel(0.95, false, { decision: 'allow' }) });
    expect((await m.route('gate', irreversible)).result.answer.decision).toBe('hold');
    // closeOut: a model never declares success alone; reconsider: either may interrupt
    const yes = new ReflexRouter({ settings: { ...allRule, closeOut: 'model' }, threshold: 0.6 }, { sink, runId: 'r', model: new FakeModel(0.95, false, { achieved: true }) });
    expect((await yes.route('closeOut', { state: asState({ stepKind: 'gate.verify', exitCode: 1 }) })).result.answer.achieved).toBe(false);
    const stop = new ReflexRouter({ settings: { ...allRule, reconsider: 'model' }, threshold: 0.6 }, { sink, runId: 'r', model: new FakeModel(0.95, false, { interrupt: false }) });
    expect((await stop.route('reconsider', { state: asState({ commitment: 'single-minded', eventKind: 'belief.added', invalidatesContext: true, goalChanged: false }) })).result.answer.interrupt).toBe(true);
  });

  it('D2/L5-F2: a rule closeOut below threshold (unchecked change) escalates to the frontier, which may only refuse it', async () => {
    const sink = new RecordingSink();
    const asked: string[] = [];
    const refuse: Frontier = { decide: async (seam) => (asked.push(seam), { seam, answer: { achieved: false } as never, confidence: 0.9, provider: 'frontier', abstained: false }) };
    const accept: Frontier = { decide: async (seam) => (asked.push(seam), { seam, answer: { achieved: true } as never, confidence: 0.9, provider: 'frontier', abstained: false }) };
    const unchecked = { state: asState({ stepKind: 'worker', returnValid: true, policyAborts: 0, expectsChange: true, changed: null }) };
    const r = new ReflexRouter({ settings: allRule, threshold: 0.6 }, { sink, runId: 'r', frontier: refuse });
    expect(await r.route('closeOut', unchecked)).toMatchObject({ outcome: 'escalated', setting: 'rule', result: { provider: 'frontier', answer: { achieved: false } } });
    expect(sink.records.at(-1)).toMatchObject({ seam: 'closeOut', provider: 'frontier', outcome: 'escalated', setting: 'rule' });
    const ok = new ReflexRouter({ settings: allRule, threshold: 0.6 }, { sink, runId: 'r', frontier: accept });
    expect((await ok.route('closeOut', unchecked)).result.answer.achieved).toBe(true);
    // a frontier can never accept what the rule refused (a reported error), and a certain rule answer does not escalate
    const err = { state: asState({ stepKind: 'worker', returnValid: true, policyAborts: 0, reportsError: true }) };
    expect(await ok.route('closeOut', err)).toMatchObject({ outcome: 'acted', result: { provider: 'rules', answer: { achieved: false } } });
    expect(asked).toEqual(['closeOut', 'closeOut']);
    // without a frontier the shaky answer stands and is recorded as fallback
    const none = new ReflexRouter({ settings: allRule, threshold: 0.6 }, { sink, runId: 'r' });
    expect(await none.route('closeOut', unchecked)).toMatchObject({ outcome: 'fallback', result: { provider: 'rules', answer: { achieved: true } } });
  });

  it("D2: 'off' is gone: a router configured with it (or any unknown setting) refuses to start", () => {
    const sink = new RecordingSink();
    for (const bad of ['off', undefined, 'disabled']) {
      expect(() => new ReflexRouter({ settings: { ...allRule, gate: bad } as never, threshold: 0.6 }, { sink, runId: 'r' })).toThrow(/always on/);
    }
  });

  it("escalation is on by default: 'escalated' only when the frontier was actually called, else 'fallback' with the shaky answer surfaced", async () => {
    const sink = new RecordingSink();
    const before = frontierCalls;
    const r = new ReflexRouter({ settings: allRule, threshold: 0.6 }, { sink, runId: 'r' });
    const two = { state: asState({}), options: [{ planId: 'a', label: '' }, { planId: 'b', label: '' }] };
    const out = await r.route('choosePlan', two);
    expect(out.outcome).toBe('fallback');
    expect(out.result.abstained).toBe(true);
    expect(sink.records.at(-1)).toMatchObject({ seam: 'choosePlan', outcome: 'fallback', provider: 'rules' });
    const withF = new ReflexRouter({ settings: allRule, threshold: 0.6 }, { sink, runId: 'r', frontier });
    expect(await withF.route('choosePlan', two)).toMatchObject({ outcome: 'escalated', result: { provider: 'frontier', answer: { planId: 'a' } } });
    expect(frontierCalls).toBe(before + 1);
    const noF = new ReflexRouter({ settings: { ...allRule, gate: 'frontier' }, threshold: 0.6 }, { sink, runId: 'r' });
    expect(await noF.route('gate', { state: asState({ tool: 'x', risk: 'read' }), options: [{ decision: 'allow' as const }] })).toMatchObject({ outcome: 'fallback', result: { provider: 'rules' } });
  });
});
