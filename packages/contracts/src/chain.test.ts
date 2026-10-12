import { describe, expect, it } from 'vitest';
import { GENESIS_HASH, chainHash, eventsChainProblem } from './chain.js';
import { event, type TeceraEvent } from './events.js';

/**
 * The pure verifier offline replay uses. The event hash does not cover `seq`, so a chain whose rows were
 * renumbered still links hash to hash: contiguous numbering (1..N) is a check of its own, and both ledgers'
 * verifyChain apply the same rule.
 */

const sys = { kind: 'system' as const, id: 's' };

function chain(n: number): Array<TeceraEvent & { seq: number; hash: string }> {
  const out: Array<TeceraEvent & { seq: number; hash: string }> = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const e = event('belief.added', { id: `e${i}`, at: i, actor: sys, payload: { key: 'k', value: i } });
    const hash = chainHash(prev, e);
    out.push({ ...e, seq: i, hash });
    prev = hash;
  }
  return out;
}

describe('eventsChainProblem', () => {
  it('accepts a contiguous chain in any input order, and the empty chain', () => {
    expect(eventsChainProblem([])).toBeNull();
    expect(eventsChainProblem(chain(4))).toBeNull();
    expect(eventsChainProblem([...chain(4)].reverse())).toBeNull();
  });

  it('renumbered rows are reported even though every hash still links', () => {
    const shifted = chain(3).map((e) => ({ ...e, seq: e.seq + 10 }));
    expect(eventsChainProblem(shifted)).toBe('events chain has a gap at seq 1 (found 11)');
    const tail = chain(3).map((e) => (e.seq === 3 ? { ...e, seq: 7 } : e));
    expect(eventsChainProblem(tail)).toBe('events chain has a gap at seq 3 (found 7)');
    const zeroBased = chain(3).map((e) => ({ ...e, seq: e.seq - 1 }));
    expect(eventsChainProblem(zeroBased)).toBe('events chain has a gap at seq 1 (found 0)');
  });

  it('a deleted middle row, a deleted first row and a duplicated number are reported', () => {
    expect(eventsChainProblem(chain(4).filter((e) => e.seq !== 2))).toBe('events chain has a gap at seq 2 (found 3)');
    expect(eventsChainProblem(chain(4).filter((e) => e.seq !== 1))).toBe('events chain has a gap at seq 1 (found 2)');
    const dup = chain(3).map((e) => (e.seq === 3 ? { ...e, seq: 2 } : e));
    expect(eventsChainProblem(dup)).toBe('events chain has a gap at seq 3 (found 2)');
  });

  it('a filtered list (one run of several) cannot be verified: it reports a gap, never a pass', () => {
    expect(eventsChainProblem(chain(5).filter((e) => e.seq % 2 === 1))).toMatch(/gap at seq 2/);
  });

  it('a rewritten event in a correctly numbered chain is reported at its seq', () => {
    const c = chain(3);
    c[1] = { ...c[1]!, payload: { key: 'k', value: 99 } };
    expect(eventsChainProblem(c)).toBe('events chain broken at seq 2');
  });
});
