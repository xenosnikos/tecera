import { describe, expect, it } from 'vitest';
import { MemoryLedger } from '@tecera/ledger';
import { Brain, GraduationError, salience } from './index.js';

const human = { kind: 'human' as const, id: 'nick' };
const DAY = 86_400_000;

describe('salience', () => {
  it('matches the agentic-stack golden values', () => {
    const now = 100 * DAY;
    const e = (ageDays: number, pain: number, importance: number, recurrence: number) => ({ salience: { createdAt: now - ageDays * DAY, pain, importance, recurrence } });
    expect(salience(e(0, 10, 10, 1), now)).toBeCloseTo(10);
    expect(salience(e(10, 10, 10, 1), now)).toBeCloseTo(7);
    expect(salience(e(0, 5, 5, 5), now)).toBeCloseTo(7.5); // recurrence capped at 3
    expect(salience(e(40, 10, 10, 1), now)).toBe(0);
  });
});

describe('Brain', () => {
  it('records episodes, stages lessons, graduates only with a human and a rationale, keeps rejection history, rebuilds from the log', async () => {
    const ledger = new MemoryLedger();
    let t = 1;
    const b = new Brain(ledger, { runId: 'r', budgetTokens: 1000, now: () => t++ });
    const ep = await b.record({ kind: 'verify', content: 'npm test failed on slugify separators', pain: 7 });
    const cand = await b.stage({ content: 'Collapse repeated separators before trimming', sourceEpisodes: [ep.id] });
    expect(cand.state).toBe('candidate');
    await expect(b.graduate(cand.id, { by: { kind: 'agent', id: 'w' }, verdict: 'promote', rationale: 'x' })).rejects.toThrow(GraduationError);
    await expect(b.graduate(cand.id, { by: human, verdict: 'promote', rationale: '  ' })).rejects.toThrow(/rationale/);
    const rejected = await b.graduate(cand.id, { by: human, verdict: 'reject', rationale: 'too specific' });
    expect(rejected.state).toBe('rejected');
    expect(rejected.decisions).toHaveLength(1);
    await expect(b.graduate(cand.id, { by: human, verdict: 'promote', rationale: 'changed my mind' })).rejects.toThrow(/not a candidate/);
    const again = await b.stage({ content: 'Trim before slugifying', sourceEpisodes: [ep.id] });
    const active = await b.graduate(again.id, { by: human, verdict: 'promote', rationale: 'held across three runs' });
    expect(active.state).toBe('active');
    const dup = await b.stage({ content: 'Trim before slugifying', sourceEpisodes: [] });
    expect(dup.salience.recurrence).toBe(2);
    const reloaded = await Brain.load(ledger, { runId: 'r', budgetTokens: 1000 });
    expect(reloaded.all('semantic').map((e) => [e.id, e.state])).toEqual([[cand.id, 'rejected'], [again.id, 'active']]);
    expect(reloaded.all('episodic')).toHaveLength(1);
    const retracted = await reloaded.graduate(again.id, { by: human, verdict: 'retract', rationale: 'obsolete' });
    expect(retracted.state).toBe('retracted');
    expect(retracted.decisions).toHaveLength(2);
  });

  it('recall ranks by salience × relevance; assembleContext respects budget and never drops always-on', async () => {
    const ledger = new MemoryLedger();
    const now = 100 * DAY;
    const b = new Brain(ledger, { runId: 'r', budgetTokens: 60, now: () => now });
    const a = await b.stage({ content: 'slugify must collapse separators', sourceEpisodes: [] });
    const c = await b.stage({ content: 'deploy requires approval', sourceEpisodes: [] });
    await b.graduate(a.id, { by: human, verdict: 'promote', rationale: 'ok' });
    await b.graduate(c.id, { by: human, verdict: 'promote', rationale: 'ok' });
    const r = b.recall({ query: 'collapse slugify separators', k: 2 });
    expect(r[0]!.entry.id).toBe(a.id);
    expect(r[0]!.score).toBeGreaterThan(r[1]!.score);
    const ctx = b.assembleContext({ query: 'slugify', alwaysOn: { prefs: { kind: 'value', value: 'x'.repeat(400), provenance: { src: 'personal', trust: 'trusted' } } } });
    expect(ctx.inputs.prefs).toBeDefined();
    expect(ctx.dropped).toContain('lessons');
    expect(b.render('semantic')).toMatch(/status=active/);
  });
});
