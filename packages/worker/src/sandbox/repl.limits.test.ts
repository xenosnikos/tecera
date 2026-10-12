import { describe, expect, it } from 'vitest';
import type { CapabilitySet, ExecRequest, Inputs, ToolBridge } from '@tecera/contracts';
import { ChildProcessRepl, limitProblem, type ChildSubInvokeRequest, type SandboxEvidence } from './index.js';

/**
 * The sandbox host's side of sub-invoke narrowing: a real child's `invoke` frame whose limits are negative
 * or (for a count) fractional is a violation, refused before the sub-invoke callback is reached. The invoke
 * loop applies the same rule (limits.ts) to the narrow option it is handed.
 */

const sandbox = { profile: 'process' as const, isolation: 'node' as const, memoryMb: 128, execTimeoutSec: 10, envAllowlist: ['PATH', 'HOME'] };
const files: Inputs = { fs: { kind: 'handle', id: 'files', methods: ['read'], description: 'repo files' } };
const caps: CapabilitySet = { tools: ['files'], paths: { read: ['**'], write: [], protected: [] }, network: 'none', limits: { usd: 1, tokens: 1000, calls: 10, wallMs: 60_000, depth: 3, iterations: 5 } };
const bridge: ToolBridge = async (rq) => ({ callId: rq.callId, ok: true, value: 1, provenance: { src: 'tool', trust: 'untrusted' }, truncated: false });
let execNo = 2000;
const req = (code: string): ExecRequest => ({ execNo: ++execNo, code, bindings: files, timeoutMs: 8_000 });

function rig() {
  const seen: ChildSubInvokeRequest[] = [];
  const evidence: SandboxEvidence[] = [];
  const repl = new ChildProcessRepl({ runId: 'run_lim', sandbox, capabilities: caps, onEvidence: (e) => void evidence.push(e), onInvoke: async (r) => (seen.push(r), { kind: 'returned', value: 'child ran' }) });
  return { repl, seen, evidence };
}

describe('limitProblem', () => {
  it('accepts whole counts and fractional amounts; refuses unknown names, non-numbers, non-finite, negative and fractional counts', () => {
    for (const [k, v] of [['iterations', 0], ['iterations', 3], ['depth', 2], ['calls', 10], ['tokens', 1000], ['usd', 0.25], ['wallMs', 1500.5]] as const) expect(limitProblem(k, v), `${k}=${v}`).toBeNull();
    expect(limitProblem('turns', 1)).toMatch(/unknown limit/);
    for (const v of [Number.NaN, Infinity, -Infinity, '3', null, undefined]) expect(limitProblem('iterations', v), String(v)).toMatch(/finite number/);
    for (const k of ['usd', 'tokens', 'calls', 'wallMs', 'depth', 'iterations']) expect(limitProblem(k, -1), k).toMatch(/must not be negative/);
    for (const k of ['tokens', 'calls', 'depth', 'iterations']) expect(limitProblem(k, 1.5), k).toMatch(/must be an integer/);
  });
});

describe('the child\'s invoke frame', () => {
  it('a valid narrowing reaches the callback with parent ∩ requested', async () => {
    const r = rig();
    const out = await r.repl.exec(req("return await invoke({ q: 1 }, { narrow: { limits: { iterations: 2, usd: 0.5 }, depth: 2 } })"), bridge);
    expect(out).toMatchObject({ kind: 'return', value: { kind: 'returned', value: 'child ran' } });
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0]!.capabilities.limits).toEqual({ usd: 0.5, tokens: 1000, calls: 10, wallMs: 60_000, depth: 2, iterations: 2 });
  }, 20_000);

  it('negative and fractional count limits are violations: the exec ends, the callback never runs, nothing is clamped', async () => {
    const bad: Array<[string, RegExp]> = [
      ['{ limits: { iterations: -1 } }', /invalid limit: limit iterations must not be negative/],
      ['{ limits: { iterations: 1.5 } }', /invalid limit: limit iterations counts whole things/],
      ['{ limits: { calls: 2.5 } }', /invalid limit: limit calls counts whole things/],
      ['{ limits: { depth: -2 } }', /invalid limit: limit depth must not be negative/],
      ['{ limits: { usd: -1 } }', /invalid limit: limit usd must not be negative/],
      ['{ limits: { turns: 1 } }', /unknown limit turns/],
    ];
    for (const [narrow, why] of bad) {
      const r = rig();
      const out = await r.repl.exec(req(`try { return await invoke({}, { narrow: ${narrow} }); } catch (e) { return 'caught ' + e.message; }`), bridge);
      expect(out.kind, narrow).toBe('raise');
      if (out.kind === 'raise') {
        expect(out.exception.name, narrow).toBe('E_DENIED');
        expect(out.exception.message, narrow).toMatch(why);
      }
      expect(r.seen, narrow).toEqual([]);
      expect(out.trace.settlement?.cause, narrow).toBe('violation:E_DENIED');
      expect(r.evidence.some((e) => e.kind === 'sandbox.violation'), narrow).toBe(true);
    }
  }, 60_000);
});
