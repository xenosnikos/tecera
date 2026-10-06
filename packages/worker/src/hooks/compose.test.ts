import { describe, expect, it } from 'vitest';
import type { Effect, Hook, SpanEvent, Stage } from '@tecera/contracts';
import { composeEffects } from './compose.js';
import { Dispatcher } from './dispatcher.js';

const susp = { requestId: 'r', action: 'a', actionHash: 'h', reason: 'x', requester: 'w' };

describe('composeEffects', () => {
  const stages: Stage[] = ['Enter', 'Send', 'Complete', 'Exit', 'Retry'];
  const table: Array<{ effect: Effect; valid: Stage[] }> = [
    { effect: { type: 'PatchInput', path: 'a', value: 1 }, valid: ['Enter'] },
    { effect: { type: 'ReplaceOutput', value: 1 }, valid: ['Send'] },
    { effect: { type: 'PatchOutput', path: 'a', value: 1 }, valid: ['Complete'] },
    { effect: { type: 'Abort', code: 'policy', reason: 'r' }, valid: ['Enter', 'Send', 'Complete', 'Retry'] },
    { effect: { type: 'Suspend', request: susp }, valid: ['Send'] },
    { effect: { type: 'RestrictCapabilities', to: { tools: [] } }, valid: ['Enter'] },
    { effect: { type: 'ReserveBudget', pool: 'usd', amount: 1 }, valid: ['Send'] },
    { effect: { type: 'AppendEvidence', key: 'k', kind: 'x', body: 1 }, valid: stages },
    { effect: { type: 'BlackboardCAS', key: 'k', expected: undefined, value: 1 }, valid: stages },
  ];
  for (const row of table) {
    for (const stage of stages) {
      const valid = row.valid.includes(stage);
      it(`${row.effect.type} at ${stage} is ${valid ? 'accepted' : stage === 'Exit' ? 'ignored' : 'refused as hookError'}`, () => {
        const c = composeEffects(stage, [['h', row.effect]]);
        if (valid) {
          if (row.effect.type === 'Abort') expect(c.abort?.reasons[0]?.code).toBe('policy');
          else expect(c.abort).toBeUndefined();
        } else if (stage === 'Exit') {
          expect(c.ignored).toHaveLength(1);
          expect(c.abort).toBeUndefined();
        } else {
          expect(c.abort?.reasons[0]?.code).toBe('hookError');
        }
      });
    }
  }

  it('Abort dominates and groups reasons; Suspend survives alongside', () => {
    const c = composeEffects('Send', [
      ['a', { type: 'Abort', code: 'budget', reason: 'over' }],
      ['b', { type: 'Abort', code: 'policy', reason: 'no' }],
      ['c', { type: 'ReplaceOutput', value: 1 }],
      ['d', { type: 'Suspend', request: susp }],
    ]);
    expect(c.abort?.reasons.map((r) => r.code)).toEqual(['budget', 'policy']);
    expect(c.replaceOutput).toBe(1);
    expect(c.suspend).toHaveLength(1);
  });

  it('disjoint patches merge, identical dedupe, same-path conflict refuses', () => {
    const ok = composeEffects('Enter', [
      ['a', { type: 'PatchInput', path: 'x', value: 1 }],
      ['b', { type: 'PatchInput', path: 'y', value: 2 }],
      ['c', { type: 'PatchInput', path: 'x', value: 1 }],
    ]);
    expect([...ok.patchInput]).toEqual([['x', 1], ['y', 2]]);
    expect(ok.abort).toBeUndefined();
    const bad = composeEffects('Enter', [
      ['a', { type: 'PatchInput', path: 'x', value: 1 }],
      ['b', { type: 'PatchInput', path: 'x', value: 2 }],
    ]);
    expect(bad.abort?.reasons[0]).toMatchObject({ code: 'conflict', hookId: 'b' });
  });

  it('two distinct ReplaceOutput refuse; identical coalesce', () => {
    expect(composeEffects('Send', [['a', { type: 'ReplaceOutput', value: { v: 1 } }], ['b', { type: 'ReplaceOutput', value: { v: 1 } }]]).replaceOutput).toEqual({ v: 1 });
    expect(composeEffects('Send', [['a', { type: 'ReplaceOutput', value: 1 }], ['b', { type: 'ReplaceOutput', value: 2 }]]).abort?.reasons[0]?.code).toBe('conflict');
  });

  it('restrictions intersect, never widen; reservations sum per pool', () => {
    const c = composeEffects('Enter', [
      ['a', { type: 'RestrictCapabilities', to: { tools: ['read', 'edit'], limits: { usd: 2 } as never, paths: { read: ['src/**'], write: ['src/**'], protected: ['a'] } } }],
      ['b', { type: 'RestrictCapabilities', to: { tools: ['edit', 'shell'], limits: { usd: 1, depth: 2 } as never, paths: { read: ['src/**', 'x'], write: [], protected: ['b'] } } }],
    ]);
    expect(c.restrict).toEqual({ tools: ['edit'], paths: { read: ['src/**'], write: [], protected: ['a', 'b'] }, limits: { usd: 1, depth: 2 } });
    const r = composeEffects('Send', [['a', { type: 'ReserveBudget', pool: 'usd', amount: 0.5 }], ['b', { type: 'ReserveBudget', pool: 'usd', amount: 0.25 }], ['c', { type: 'ReserveBudget', pool: 'tokens', amount: 10 }]]);
    expect([...r.reserve]).toEqual([['usd', 0.75], ['tokens', 10]]);
  });

  it('evidence keys dedupe on identical bodies, refuse on different, and sort by key', () => {
    const ok = composeEffects('Exit', [['a', { type: 'AppendEvidence', key: 'z', kind: 'k', body: 1 }], ['b', { type: 'AppendEvidence', key: 'a', kind: 'k', body: 2 }], ['c', { type: 'AppendEvidence', key: 'z', kind: 'k', body: 1 }]]);
    expect(ok.evidence.map((e) => e.key)).toEqual(['a', 'z']);
    const bad = composeEffects('Exit', [['a', { type: 'AppendEvidence', key: 'z', kind: 'k', body: 1 }], ['b', { type: 'AppendEvidence', key: 'z', kind: 'k', body: 2 }]]);
    expect(bad.abort?.reasons[0]?.code).toBe('conflict');
  });

  it('two hooks CAS the same key → refused', () => {
    const bad = composeEffects('Enter', [['a', { type: 'BlackboardCAS', key: 'k', expected: undefined, value: 1 }], ['b', { type: 'BlackboardCAS', key: 'k', expected: undefined, value: 2 }]]);
    expect(bad.abort?.reasons[0]?.code).toBe('conflict');
  });
});

const ev = (stage: Stage): SpanEvent => ({ span: 'Invoke', stage, spanId: 's', run: { runId: 'r', invokeId: 'i', depth: 0 }, attempt: 1, input: { x: 1 } });
const view = { capabilities: { tools: [], paths: { read: [], write: [], protected: [] }, network: 'none' as const, limits: { usd: 0, tokens: 0, calls: 0, wallMs: 0, depth: 0, iterations: 0 } } };

function hook(id: string, handle: Hook['handle'], spans: Hook['spans'] = new Set(['Invoke'])): Hook {
  return { id, mandatory: false, spans, handle, describe: () => ({ id, mandatory: false, config: {} }) };
}

describe('Dispatcher', () => {
  it('every hook sees the same frozen event and cannot mutate it', async () => {
    const seen: SpanEvent[] = [];
    const d = new Dispatcher([
      hook('a', (e) => {
        seen.push(e);
        expect(() => {
          (e as { input: Record<string, unknown> }).input.x = 2;
        }).toThrow();
        return [];
      }),
      hook('b', (e) => {
        seen.push(e);
        return [];
      }),
    ]);
    await d.emit(ev('Enter'), view);
    expect(seen[0]).toBe(seen[1]);
    expect(Object.isFrozen(seen[0]!.input)).toBe(true);
  });

  it('a throwing or hanging hook becomes an Abort hookError', async () => {
    const d = new Dispatcher([hook('boom', () => { throw new Error('kaboom'); }), hook('ok', () => [{ type: 'PatchInput', path: 'y', value: 1 }])], { hookTimeoutMs: 50 });
    const c = await d.emit(ev('Enter'), view);
    expect(c.abort?.reasons[0]).toMatchObject({ code: 'hookError', hookId: 'boom' });
    expect(c.patchInput.get('y')).toBe(1);
    const slow = new Dispatcher([hook('slow', () => new Promise(() => {}))], { hookTimeoutMs: 20 });
    const s = await slow.emit(ev('Enter'), view);
    expect(s.abort?.reasons[0]?.reason).toMatch(/timed out/);
  });

  it('hooks only receive the spans they subscribe to; blackboard CAS applies when expected matches', async () => {
    let calls = 0;
    const d = new Dispatcher([
      hook('cas', () => [{ type: 'BlackboardCAS', key: 'n', expected: undefined, value: 1 }]),
      hook('other', () => { calls++; return []; }, new Set(['ToolCall'])),
    ]);
    await d.emit(ev('Enter'), view);
    expect(calls).toBe(0);
    expect(d.blackboard()).toEqual({ n: 1 });
    const again = await d.emit(ev('Enter'), view); // expected undefined but current is 1 → conflict
    expect(again.abort?.reasons[0]?.reason).toMatch(/CAS failed/);
    expect(d.blackboard()).toEqual({ n: 1 });
  });
});
