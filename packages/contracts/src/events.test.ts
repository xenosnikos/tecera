import { describe, expect, it } from 'vitest';
import { EVENT_KINDS, InvalidEvent, TRACE_REQUIREMENTS, event, validateEvent, type TeceraEvent } from './events.js';

const actor = { kind: 'system' as const, id: 'test' };

describe('event catalog', () => {
  it('every kind has a trace requirement entry', () => {
    for (const k of EVENT_KINDS) expect(TRACE_REQUIREMENTS[k]).toBeDefined();
    expect(Object.keys(TRACE_REQUIREMENTS).sort()).toEqual([...EVENT_KINDS].sort());
  });

  it('step events require the full chain goal → intention → plan → step', () => {
    expect(() => event('step.completed', { id: 'e1', at: 1, actor, payload: {}, trace: { goalId: 'g' } })).toThrow(/requires trace.intentionId/);
    const ok = event('step.completed', { id: 'e1', at: 1, actor, payload: { facts: [] }, trace: { goalId: 'g', intentionId: 'i', planId: 'p', stepId: 's' } });
    expect(ok.kind).toBe('step.completed');
  });

  it('rejects unknown kinds and malformed payloads', () => {
    const bad = { id: 'x', kind: 'belief.exploded', at: 1, actor, trace: {}, payload: {} } as unknown as TeceraEvent;
    expect(() => validateEvent(bad)).toThrow(InvalidEvent);
    const arr = { id: 'x', kind: 'run.started', at: 1, actor, trace: {}, payload: [] } as unknown as TeceraEvent;
    expect(() => validateEvent(arr)).toThrow(/payload must be an object/);
  });

  it('PR, budget and stop-hook kinds exist (D3/D4/D6): pr.* need goal, intention and step; the rest none', () => {
    for (const k of ['pr.requested', 'pr.opened', 'pr.failed'] as const) {
      expect(TRACE_REQUIREMENTS[k]).toEqual(['goalId', 'intentionId', 'stepId']);
      expect(() => event(k, { id: 'p', at: 1, actor, payload: {}, trace: { goalId: 'g', intentionId: 'i' } })).toThrow(/requires trace.stepId/);
    }
    for (const k of ['budget.exhausted', 'stop.blocked', 'stop.allowed'] as const) {
      expect(TRACE_REQUIREMENTS[k]).toEqual([]);
      expect(() => event(k, { id: 'b', at: 1, actor, payload: { pool: 'usd' } })).not.toThrow();
    }
  });

  it('run and belief events carry no mandatory trace', () => {
    expect(() => event('run.started', { id: 'r', at: 1, actor, payload: { manifestHash: 'h' } })).not.toThrow();
    expect(() => event('belief.added', { id: 'b', at: 1, actor, payload: { key: 'k', value: 1 } })).not.toThrow();
  });
});
