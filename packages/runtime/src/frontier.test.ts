import { describe, expect, it } from 'vitest';
import { makeRedactor, type LLM, type LLMRequest, type LLMResponse } from '@tecera/contracts';
import { ModelFrontier, parseAnswer } from './frontier.js';

class OneShot implements LLM {
  readonly id = 'p';
  readonly provider = 'anthropic';
  requests: LLMRequest[] = [];
  constructor(private readonly r: Partial<LLMResponse>) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    return { content: '', usage: { inputTokens: 1, outputTokens: 1, usd: 0 }, model: 'm', finishReason: 'stop', ...this.r };
  }
}
const redactor = makeRedactor([]);

/** The reply claude-sonnet-4.5 gave to the closeOut question in the live benchmark: a fenced object, then prose. */
const LIVE_SAMPLE = [
  '```json',
  '{"answer":{"achieved":false}}',
  '```',
  '',
  'The step expects a change, but `changed` is null, so there is no evidence the worktree was modified.',
  'Without that evidence I cannot confirm the step achieved its goal.',
].join('\n');

const changedWrite = { state: { stepKind: 'worker', returnValid: true, policyAborts: 0, reportsError: false, expectsChange: true, changed: true } };

describe('frontier parseAnswer: fences, prose, ambiguity', () => {
  it('reads the live sample (fenced JSON followed by prose)', () => {
    expect(parseAnswer(LIVE_SAMPLE)).toEqual({ achieved: false });
  });

  it('accepts bare JSON, a fence, and prose before or after the object', () => {
    expect(parseAnswer('{"answer":{"achieved":true}}')).toEqual({ achieved: true });
    expect(parseAnswer('```\n{"answer": {"decision": "hold"}}\n```')).toEqual({ decision: 'hold' });
    expect(parseAnswer('Here is my decision: {"answer":{"interrupt":true}} — interrupting because the goal changed.')).toEqual({ interrupt: true });
    expect(parseAnswer('Looking at it {carefully}, my answer is:\n```json\n{"answer":{"seatId":"cheap"}}\n```\nThanks.')).toEqual({ seatId: 'cheap' });
    // braces inside strings do not end the object
    expect(parseAnswer('{"answer":{"intentionId":"i_{1}"},"why":"a } in text"}')).toEqual({ intentionId: 'i_{1}' });
    expect(parseAnswer('{"answer":{"intentionId":"a\\"}b"}}')).toEqual({ intentionId: 'a"}b' });
  });

  it('takes the first object that has an answer object; the same answer twice is still one answer', () => {
    expect(parseAnswer('{"note":"thinking"} then {"answer":{"achieved":true}}')).toEqual({ achieved: true });
    expect(parseAnswer('{"answer":{"achieved":true}}\nRestated: {"answer": {"achieved": true}}')).toEqual({ achieved: true });
  });

  it('rejects two conflicting answer objects, and anything with no answer object', () => {
    expect(parseAnswer('{"answer":{"achieved":true}} or perhaps {"answer":{"achieved":false}}')).toBeNull();
    expect(parseAnswer('```json\n{"answer":{"decision":"allow"}}\n```\nOn reflection: {"answer":{"decision":"block"}}')).toBeNull();
    expect(parseAnswer('achieved: true')).toBeNull();
    expect(parseAnswer('{"achieved":true}')).toBeNull();
    expect(parseAnswer('{"answer":true}')).toBeNull();
    expect(parseAnswer('{"answer":[{"achieved":true}]}')).toBeNull();
    expect(parseAnswer('{"answer":{"achieved":true}')).toBeNull(); // unbalanced
    expect(parseAnswer('')).toBeNull();
  });
});

describe('ModelFrontier with replies that carry prose', () => {
  it('closeOut: the live sample is read (not a parse failure) and refuses; a prose-wrapped yes accepts only with the rule', async () => {
    const no = new ModelFrontier({ llm: new OneShot({ content: LIVE_SAMPLE }), model: 'm', redactor });
    // a parsed answer carries the frontier confidence (0.9); a fallback would carry 0
    expect(await no.decide('closeOut', changedWrite)).toMatchObject({ answer: { achieved: false }, confidence: 0.9, provider: 'frontier' });
    const yes = new ModelFrontier({ llm: new OneShot({ content: '```json\n{"answer":{"achieved":true}}\n```\nThe change summary shows src/slugify.js edited.' }), model: 'm', redactor });
    expect(await yes.decide('closeOut', changedWrite)).toMatchObject({ answer: { achieved: true }, confidence: 0.9 });
    // the stricter of rule and model: a model yes never accepts what the rule refused (no change on a writing step)
    expect((await yes.decide('closeOut', { state: { ...changedWrite.state, changed: false } })).answer.achieved).toBe(false);
  });

  it('gate: a prose-wrapped answer is still never looser than the rule; conflicting answers fall closed (hold)', async () => {
    const options = [{ decision: 'allow' as const }, { decision: 'hold' as const }, { decision: 'block' as const }];
    const allow = new ModelFrontier({ llm: new OneShot({ content: 'Sure.\n{"answer":{"decision":"allow"}}' }), model: 'm', redactor });
    expect((await allow.decide('gate', { state: { tool: 'x', risk: 'irreversible', permission: 'requiresApproval' }, options })).answer.decision).toBe('hold');
    const torn = new ModelFrontier({ llm: new OneShot({ content: '{"answer":{"decision":"allow"}} {"answer":{"decision":"block"}}' }), model: 'm', redactor });
    expect(await torn.decide('gate', { state: { tool: 'x', risk: 'read', permission: 'always' }, options })).toMatchObject({ answer: { decision: 'hold' }, confidence: 0 });
  });

  it('the question reaches the model whole (the closeOut evidence), with room for an answer followed by prose', async () => {
    const llm = new OneShot({ content: LIVE_SAMPLE });
    const f = new ModelFrontier({ llm, model: 'm', redactor });
    await f.decide('closeOut', { state: { ...changedWrite.state, instruction: 'fix slugify', change: { files: 1, added: 1, removed: 1, paths: [{ path: 'src/slugify.js', added: 1, removed: 1 }] } } });
    const user = JSON.parse(llm.requests[0]!.messages.at(-1)!.content as string) as { seam: string; question: { state: Record<string, unknown> } };
    expect(user).toMatchObject({ seam: 'closeOut', question: { state: { instruction: 'fix slugify', change: { files: 1, paths: [{ path: 'src/slugify.js' }] } } } });
    expect(llm.requests[0]!.maxTokens).toBeGreaterThanOrEqual(512);
  });
});
