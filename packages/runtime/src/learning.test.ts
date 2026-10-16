import { describe, expect, it } from 'vitest';
import { Brain } from '@tecera/brain';
import { event, makeRedactor, type Json, type TeceraEvent } from '@tecera/contracts';
import { MemoryLedger } from '@tecera/ledger';
import { MAX_EPISODE_CHARS, recordRunLearning } from './learning.js';

/** The learning projector over a run's ledger: deterministic, redacted, bounded, idempotent per source event. */

const SECRET = 'learning-' + 'known-secret-value-77';
const redactor = makeRedactor([SECRET]);
const human = { kind: 'human' as const, id: 'ana' };
const trace = (stepId: string) => ({ goalId: 'g1', intentionId: 'i1', planId: 'p1', stepId });
let n = 0;
const put = (l: MemoryLedger, kind: TeceraEvent['kind'], payload: Record<string, unknown>, t: TeceraEvent['trace'] = {}, runId = 'r1') =>
  l.append(event(kind, { id: `e${++n}`, at: 1000 + n, actor: { kind: 'system', id: 'loop' }, runId, trace: t, payload: payload as Record<string, Json> }));
const memoryEvents = async (l: MemoryLedger) => {
  const out: TeceraEvent[] = [];
  for await (const e of l.events({ kinds: ['evidence.appended', 'lesson.staged'] })) if ((e.payload as { entry?: unknown }).entry) out.push(e);
  return out;
};

async function segmentOne(l: MemoryLedger): Promise<void> {
  await put(l, 'step.completed', { step: 'analyze', result: { outcome: 'returned' } }, trace('analyze'));
  await put(l, 'step.failed', { step: 'edit', reason: `edit refused: token ${SECRET} ${'x'.repeat(2000)}`, terminal: false }, trace('edit'));
  await put(l, 'run.ended', { exitCode: 4, reason: 'held for approval' });
}

describe('recordRunLearning', () => {
  it('one redacted, bounded episode per step completion, step failure and run outcome; a candidate per verified recovery; nothing twice', async () => {
    const l = new MemoryLedger();
    await segmentOne(l);
    const opts = { redactor, now: () => 5000 };
    const first = await recordRunLearning(l, 'r1', opts);
    expect(first).toMatchObject({ episodes: 3, candidates: 0 });
    // the resumed segment: the retried edit completes and verification passes, then the run ends
    await put(l, 'step.completed', { step: 'edit', result: { outcome: 'returned' } }, trace('edit'));
    await put(l, 'verify.passed', { exitCode: 0 }, trace('verify'));
    await put(l, 'run.ended', { exitCode: 0, reason: 'goal achieved' });
    await put(l, 'step.failed', { step: 'other', reason: 'another run' }, trace('other'), 'r2');
    const second = await recordRunLearning(l, 'r1', opts);
    expect(second).toMatchObject({ episodes: 2, candidates: 1 });
    // projecting again (after a reload, a resume, or twice in a row) writes nothing
    const before = (await memoryEvents(l)).length;
    expect(await recordRunLearning(l, 'r1', opts)).toMatchObject({ episodes: 0, candidates: 0, notes: [] });
    expect(await recordRunLearning(l, 'r1', opts)).toMatchObject({ episodes: 0, candidates: 0 });
    expect((await memoryEvents(l)).length).toBe(before);

    const b = await Brain.load(l, { runId: 'x', budgetTokens: 10_000 });
    const eps = b.all('episodic');
    expect(eps.map((e) => e.kind)).toEqual(['step.completed', 'step.failed', 'run.outcome', 'step.completed', 'run.outcome']);
    // exactly one entry per source event, and each names its source
    const sources = eps.map((e) => e.provenance.source);
    expect(new Set(sources).size).toBe(sources.length);
    const all = JSON.stringify(b.all());
    expect(all).not.toContain(SECRET);
    for (const e of b.all()) expect(e.content.length).toBeLessThanOrEqual(MAX_EPISODE_CHARS + 40);
    expect(eps.some((e) => /another run/.test(e.content))).toBe(false);
    const [lesson] = b.all('semantic');
    expect(lesson).toMatchObject({ state: 'candidate', kind: 'lesson' });
    expect(lesson!.content).toMatch(/goal g1: after 1 failed attempt\(s\), a later attempt passed verification/);
    expect(lesson!.provenance.evidenceKey).toBe(eps[1]!.id);
    // a candidate is not retrievable until a human graduates it
    expect(b.recall({ query: 'edit', tiers: ['semantic'], k: 5 })).toEqual([]);
    const fresh = await Brain.load(l, { runId: 'cli', budgetTokens: 10_000, actor: human });
    await fresh.graduate(lesson!.id, { by: human, verdict: 'promote', rationale: 'retrying the edit after reading the file works' });
    expect((await Brain.load(l, { runId: 'x', budgetTokens: 10_000 })).recall({ query: 'edit', tiers: ['semantic'], k: 5 }).map((r) => r.entry.id)).toEqual([lesson!.id]);
  });

  it('never throws: a ledger that fails becomes a note', async () => {
    const l = new MemoryLedger();
    await segmentOne(l);
    const broken = new Proxy(l, {
      get(t, p) {
        if (p === 'append') return async () => {
          throw new Error(`disk full ${SECRET}`);
        };
        const v = Reflect.get(t, p, t) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const r = await recordRunLearning(broken, 'r1', { redactor, now: () => 1 });
    expect(r.episodes).toBe(0);
    expect(r.notes.join()).toMatch(/learning {2}projection failed \(disk full \[REDACTED/);
  });
});
