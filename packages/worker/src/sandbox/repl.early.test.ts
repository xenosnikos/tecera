import { describe, expect, it } from 'vitest';
import type { ExecRequest, Inputs, Json, ToolBridge, ToolRequest, ToolResult } from '@tecera/contracts';
import { ChildProcessRepl, ReplTainted, type ChildProcessReplOptions, type SandboxEvidence } from './index.js';

/**
 * Codex sprint-3 sandbox finding 1 (blocker): early execution returns bypassed sink draining and taint.
 * Degraded-isolation evidence starts in exec() BEFORE run(); an already-aborted request, an invalid exec
 * number, an invalid program, a disposed or a quarantined REPL used to return at once, so a pending sink
 * left lifecycle tracking and dispose() reported clean. Every exit now runs the one finalizer.
 *
 * isolation 'node' is degraded, so the first exec of each REPL starts an 'isolation.degraded' evidence sink.
 */

const sandbox = { profile: 'process' as const, isolation: 'node' as const, memoryMb: 128, execTimeoutSec: 10, envAllowlist: ['PATH', 'HOME'] };
const files: Inputs = { fs: { kind: 'handle', id: 'files', methods: ['read', 'write'], description: 'repo files' } };
const ok = (rq: ToolRequest, value: Json): ToolResult => ({ callId: rq.callId, ok: true, value, provenance: { src: `tool:${rq.tool}`, trust: 'untrusted' }, truncated: false });
const bridge: ToolBridge = async (rq) => ok(rq, 1);
let execNo = 0;
const repl = (extra: Partial<ChildProcessReplOptions> = {}) => new ChildProcessRepl({ runId: 'run_e', sandbox, ...extra });

/** The early-exit requests: [label, request, signal]. */
function earlyCases(): Array<[string, ExecRequest, AbortSignal | undefined]> {
  const aborted = new AbortController();
  aborted.abort();
  return [
    ['pre-aborted request', { execNo: ++execNo, code: 'return 1', bindings: files, timeoutMs: 5_000 }, aborted.signal],
    ['invalid exec number', { execNo: -3, code: 'return 1', bindings: files, timeoutMs: 5_000 }, undefined],
    ['invalid binding (program)', { execNo: ++execNo, code: 'return 1', bindings: { 'bad name!': { kind: 'value', value: 1, provenance: { src: 'x', trust: 'trusted' } } } as Inputs, timeoutMs: 5_000 }, undefined],
    ['reserved host name binding', { execNo: ++execNo, code: 'return 1', bindings: { invoke: { kind: 'value', value: 1, provenance: { src: 'x', trust: 'trusted' } } } as Inputs, timeoutMs: 5_000 }, undefined],
  ];
}

describe('early exits run the one finalizer (sprint-3 finding 1)', () => {
  for (const [label] of earlyCases()) {
    it(`${label} + a never-settling evidence sink: the exec is E_TAINTED naming the sink, and dispose is never clean`, async () => {
      const [, rq, signal] = earlyCases().find(([l]) => l === label)!;
      let started = 0;
      const r0 = repl({
        sinkTimeoutMs: 150,
        drainMs: 100,
        onEvidence: () => {
          started++;
          return new Promise<void>(() => undefined);
        },
      });
      const out = await r0.exec(rq, bridge, signal);
      expect(started).toBeGreaterThanOrEqual(1); // the degraded-isolation sink really started
      expect(out.kind).toBe('raise');
      if (out.kind === 'raise') expect(out.exception.name).toBe('E_TAINTED');
      expect(out.tainted?.outstanding.some((id) => id.includes('-sink:evidence:isolation.degraded#'))).toBe(true);
      // The pending sink stays in the REPL's registry: never a clean shutdown while it is open.
      const rep = await r0.shutdown();
      expect(rep.clean).toBe(false);
      expect(rep.tainted).toBe(true);
      expect(rep.outstanding.some((id) => id.includes('-sink:evidence:isolation.degraded#'))).toBe(true);
      await expect(r0.dispose()).rejects.toBeInstanceOf(ReplTainted);
      // Later execs are refused: quarantine is sticky.
      const again = await r0.exec({ execNo: ++execNo, code: 'return 1', bindings: files, timeoutMs: 5_000 }, bridge);
      expect(again.kind).toBe('raise');
      if (again.kind === 'raise') expect(again.exception.name).toMatch(/E_TAINTED|E_DISPOSED/);
    });

    it(`${label} + a rejecting evidence sink: fail closed as E_INTERNAL (never the bare early code), dispose stays clean`, async () => {
      const [, rq, signal] = earlyCases().find(([l]) => l === label)!;
      const r0 = repl({ sinkTimeoutMs: 500, onEvidence: () => Promise.reject(new Error('ledger down')) });
      const out = await r0.exec(rq, bridge, signal);
      expect(out.kind).toBe('raise');
      if (out.kind === 'raise') {
        expect(out.exception.name).toBe('E_INTERNAL');
        expect(out.exception.message).toMatch(/evidence sink failed \(isolation\.degraded\)/);
      }
      expect(out.trace.handlerFailures.length).toBeGreaterThan(0);
      expect(await r0.shutdown()).toEqual({ clean: true, tainted: false, outstanding: [], processes: [] });
    });

    it(`${label} + a slow but settling sink: the exec waits for it (bounded) and keeps its own early code`, async () => {
      const [, rq, signal] = earlyCases().find(([l]) => l === label)!;
      const ev: SandboxEvidence[] = [];
      let settledAt = 0;
      const r0 = repl({
        sinkTimeoutMs: 2_000,
        onEvidence: async (e) => {
          await new Promise((r) => setTimeout(r, 200));
          ev.push(e);
          settledAt = Date.now();
        },
      });
      const out = await r0.exec(rq, bridge, signal);
      const returnedAt = Date.now();
      expect(ev.map((e) => e.kind)).toContain('isolation.degraded');
      expect(settledAt).toBeGreaterThan(0);
      expect(returnedAt).toBeGreaterThanOrEqual(settledAt); // the sink was drained before the exec returned
      expect(out.kind).toBe('raise');
      if (out.kind === 'raise') expect(out.exception.name).toMatch(label === 'pre-aborted request' ? /^E_CANCELLED$/ : /^E_FRAME$/);
      expect(out.tainted).toBeUndefined();
      await expect(r0.dispose()).resolves.toBeUndefined();
    });
  }

  it('a quarantined REPL refuses through the finalizer too and reports every unresolved id', async () => {
    const r0 = repl({ sinkTimeoutMs: 100, drainMs: 100, onEvidence: () => new Promise<void>(() => undefined) });
    const first = await r0.exec({ execNo: ++execNo, code: 'return 1', bindings: files, timeoutMs: 5_000 }, bridge);
    expect(first.kind === 'raise' && first.exception.name).toBe('E_TAINTED');
    const refused = await r0.exec({ execNo: ++execNo, code: 'return 2', bindings: files, timeoutMs: 5_000 }, bridge);
    expect(refused.kind === 'raise' && refused.exception.name).toBe('E_TAINTED');
    expect(refused.tainted?.outstanding.length).toBeGreaterThan(0);
    expect(refused.trace.tainted).toEqual(refused.tainted);
    await expect(r0.dispose()).rejects.toBeInstanceOf(ReplTainted);
  });

  it('a disposed REPL refuses through the finalizer (no program runs, the bridge is never called)', async () => {
    let calls = 0;
    const r0 = repl();
    await r0.dispose();
    const out = await r0.exec({ execNo: ++execNo, code: "await fs.write('a', 'b'); return 1", bindings: files, timeoutMs: 5_000 }, async (rq) => {
      calls++;
      return ok(rq, 1);
    });
    expect(out.kind === 'raise' && out.exception.name).toBe('E_DISPOSED');
    expect(calls).toBe(0);
  });
});

describe('REPL survivor-taint path (a process group that survives SIGKILL)', () => {
  it('a surviving group taints the exec (E_TAINTED naming pgid), quarantines the REPL and dispose rejects', async () => {
    const ev: SandboxEvidence[] = [];
    let pgid = 0;
    const r0 = repl({
      onEvidence: (e) => void ev.push(e),
      testKillOverride: (k) => ({ ...k, gone: false }),
    });
    const out = await r0.exec({ execNo: ++execNo, code: 'while (true) {}', bindings: files, timeoutMs: 300 }, bridge);
    expect(out.kind).toBe('raise');
    if (out.kind === 'raise') {
      expect(out.exception.name).toBe('E_TAINTED');
      expect(out.exception.message).toMatch(/survived SIGKILL \(timeout\)/);
      expect(out.exception.message).toMatch(/pgid:\d+/);
    }
    pgid = out.tainted?.processes[0] ?? 0;
    expect(pgid).toBeGreaterThan(1);
    expect(out.trace.killed).toEqual({ cause: 'timeout', gone: false });
    expect(ev.find((e) => e.kind === 'sandbox.tainted')?.body).toMatchObject({ processes: [pgid] });
    const again = await r0.exec({ execNo: ++execNo, code: 'return 1', bindings: files, timeoutMs: 5_000 }, bridge);
    expect(again.kind === 'raise' && again.exception.name).toBe('E_TAINTED');
    const rep = await r0.shutdown();
    expect(rep.tainted).toBe(true);
    await expect(r0.dispose()).rejects.toBeInstanceOf(ReplTainted);
  }, 15_000);
});
