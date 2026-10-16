import { describe, expect, it } from 'vitest';
import { event, type ApprovalView, type EvidenceLookup, type TeceraEvent } from '@tecera/contracts';
import { evaluateStopEvents, withRegistry, type ActiveRunRef } from './stop.js';

/**
 * Hardened mode's Stop decision over the run registry: a run the registry holds open is active whatever the
 * events say (an appended run.ended, a denied or expired approval), and the event-derived runs still count.
 * Each case is shown first without the registry, where the same events let the assistant stop.
 */

const at = 1_700_000_000_000;
let n = 0;
const ev = (kind: TeceraEvent['kind'], runId: string, payload: Record<string, unknown> = {}, trace: TeceraEvent['trace'] = {}): TeceraEvent =>
  event(kind, { id: `e${++n}`, at: at + n, actor: { kind: 'system', id: 't' }, runId, trace, payload: payload as never });
const started = (runId: string): TeceraEvent[] => [ev('run.started', runId), ev('goal.adopted', runId, { goalId: 'g1' }, { goalId: 'g1' })];
const noEvidence: EvidenceLookup = [];
const chain = { ok: true as const, length: 1 };
const opts = (extra: Record<string, unknown> = {}) => ({ chain, now: at + 1_000_000, ...extra });

describe('Stop over the run registry (hardened mode)', () => {
  const registry: ActiveRunRef[] = [{ runId: 'r1', goalId: 'g1', state: 'held', note: 'held, generation 1' }];

  it('a forged run.ended(0) after a held run hides it from the events alone; the registry keeps it active', () => {
    const evs = [...started('r1'), ev('run.ended', 'r1', { exitCode: 4 }), ev('run.ended', 'r1', { exitCode: 0 })];
    expect(evaluateStopEvents(evs, noEvidence, opts()).decision.decision).toBe('allow');
    const d = evaluateStopEvents(evs, noEvidence, opts({ registry }));
    expect(d.decision).toMatchObject({ decision: 'block', exitCode: 2 });
    expect(d.decision.reason).toMatch(/run r1 for goal g1 is active according to the run registry \(held, generation 1\), whatever its events say/);
  });

  it('a denied or an expired approval does not end a registered run', () => {
    const evs = [...started('r1'), ev('approval.requested', 'r1', { requestId: 'ap1' }, { goalId: 'g1', intentionId: 'i1', stepId: 'pr' }), ev('run.ended', 'r1', { exitCode: 0 })];
    const row = (state: ApprovalView['state'], expiresAt: number): ApprovalView => ({ requestId: 'ap1', runId: 'r1', sessionId: 'r1', actionHash: 'h', requester: { kind: 'agent', id: 'loop' }, state, expiresAt });
    for (const r of [row('denied', at + 9e9), row('pending', at)]) {
      expect(evaluateStopEvents(evs, noEvidence, opts({ approvals: [r] })).decision.decision, r.state).toBe('allow');
      expect(evaluateStopEvents(evs, noEvidence, opts({ approvals: [r], registry })).decision.decision, r.state).toBe('block');
    }
  });

  it('a registered run the ledger does not know (deleted or replaced history) cannot be proven: it blocks', () => {
    expect(evaluateStopEvents([], noEvidence, opts()).decision.decision).toBe('allow');
    expect(evaluateStopEvents([], noEvidence, opts({ registry })).decision.decision).toBe('block');
  });

  it('the union: registry runs first with their state, event-derived runs it does not name after them; an empty registry adds nothing', () => {
    const fromEvents: ActiveRunRef[] = [
      { runId: 'r1', state: 'running', goalId: 'g1', openApprovals: ['ap1'] },
      { runId: 'r2', state: 'interrupted' },
    ];
    expect(withRegistry(registry, fromEvents)).toEqual([
      { runId: 'r1', goalId: 'g1', state: 'held', note: 'held, generation 1', source: 'registry', openApprovals: ['ap1'] },
      { runId: 'r2', state: 'interrupted', source: 'events' },
    ]);
    expect(withRegistry([], fromEvents).map((r) => r.runId)).toEqual(['r1', 'r2']);
    expect(withRegistry(undefined, fromEvents)).toEqual(fromEvents);
    const evs = [...started('r2')];
    expect(evaluateStopEvents(evs, noEvidence, opts({ registry: [] })).decision.decision).toBe('block');
  });
});
