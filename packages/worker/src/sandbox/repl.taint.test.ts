import { describe, expect, it } from 'vitest';
import { makeRedactor, type ExecRequest, type Inputs, type Json, type ToolBridge, type ToolRequest, type ToolResult } from '@tecera/contracts';
import { ChildProcessRepl, ReplTainted, type ChildProcessReplOptions, type CheckpointRecord, type SandboxEvidence } from './index.js';

/**
 * Codex sprint-2 sandbox findings: new 1 (disposal does not establish that writers stopped), 3 (batched
 * calls share call ids / idempotency keys), 4 (checkpoint keys bypass redaction), 5 (output caps cut
 * secrets before the redactor), and the missing tests for materialization overflow and hostile history.
 */

const sandbox = { profile: 'process' as const, isolation: 'node' as const, memoryMb: 128, execTimeoutSec: 10, envAllowlist: ['PATH', 'HOME'] };
const files: Inputs = { fs: { kind: 'handle', id: 'files', methods: ['read', 'write'], description: 'repo files' } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ok = (rq: ToolRequest, value: Json): ToolResult => ({ callId: rq.callId, ok: true, value, provenance: { src: `tool:${rq.tool}`, trust: 'untrusted' }, truncated: false });
let execNo = 0;
const req = (code: string, bindings: Inputs = files, timeoutMs = 5_000): ExecRequest => ({ execNo: ++execNo, code, bindings, timeoutMs });
const repl = (extra: Partial<ChildProcessReplOptions> = {}) => new ChildProcessRepl({ runId: 'run_t', sandbox, ...extra });

/** Every substring of `s` of length `n` (to prove no fragment of an encoded secret survives). */
const windows = (s: string, n: number): string[] => Array.from({ length: Math.max(0, s.length - n + 1) }, (_, i) => s.slice(i, i + n));

describe('quarantine: unresolved writers taint the exec, the REPL and its disposal (new finding 1)', () => {
  it('a delayed write beyond drainMs: E_TAINTED naming the call, the REPL refuses reuse, dispose is never clean while it runs, late settle is recorded', async () => {
    const evidence: SandboxEvidence[] = [];
    const mutations: number[] = [];
    let calls = 0;
    const bridge = (async (rq: ToolRequest) => {
      calls++;
      if (rq.method === 'write') {
        await sleep(900); // ignores the abort signal: a broker that keeps writing
        mutations.push(Date.now());
      }
      return ok(rq, 'done');
    }) as ToolBridge;
    const r0 = repl({ drainMs: 150, onEvidence: (e) => void evidence.push(e) });
    const r = await r0.exec(req("fs.write('src/a.ts', 'x'); return 1"), bridge);
    const resolvedAt = Date.now();
    expect(r.kind).toBe('raise');
    if (r.kind === 'raise') {
      expect(r.exception.name).toBe('E_TAINTED');
      expect(r.exception.message).toContain(`x${execNo}-c1`);
    }
    expect(r.tainted).toEqual({ reason: expect.stringMatching(/did not terminate within 150 ms/), outstanding: [`x${execNo}-c1`], processes: [], recorded: true });
    expect(r.trace.tainted?.outstanding).toEqual([`x${execNo}-c1`]);
    expect(mutations).toEqual([]); // the write is still running after the exec reported
    expect(r0.tainted?.outstanding).toEqual([`x${execNo}-c1`]);

    // Reuse is refused: the program never runs and the bridge is never called.
    const before = calls;
    const again = await r0.exec(req("await fs.read('x'); return 2"), bridge);
    expect(again.kind).toBe('raise');
    if (again.kind === 'raise') expect(again.exception.name).toBe('E_TAINTED');
    expect(again.tainted?.outstanding).toEqual([`x${execNo - 1}-c1`]);
    expect(calls).toBe(before);

    // Disposal while the writer still runs: never clean, and dispose() rejects.
    const rep = await r0.shutdown();
    expect(rep).toEqual({ clean: false, tainted: true, outstanding: [`x${execNo - 1}-c1`], processes: [] });
    await expect(r0.dispose()).rejects.toBeInstanceOf(ReplTainted);

    // The delayed mutation lands after the exec resolved; it is recorded, and the REPL stays tainted.
    await sleep(900);
    expect(mutations.length).toBe(1);
    expect(mutations[0]!).toBeGreaterThan(resolvedAt);
    expect(evidence.some((e) => e.kind === 'sandbox.tainted')).toBe(true);
    expect(evidence.find((e) => e.kind === 'sandbox.late_settle')?.body).toMatchObject({ id: `x${execNo - 1}-c1`, kind: 'call' });
    const later = await r0.shutdown();
    expect(later).toEqual({ clean: true, tainted: true, outstanding: [], processes: [] });
    await expect(r0.dispose()).rejects.toThrow(/was tainted/);
  }, 20_000);

  it('dispose during an exec whose call ignores the abort beyond drainMs: the exec is E_TAINTED and dispose rejects (not clean)', async () => {
    const bridge: ToolBridge = () => new Promise<ToolResult>(() => undefined);
    const r0 = repl({ drainMs: 200 });
    let entered!: () => void;
    const inBridge = new Promise<void>((res) => (entered = res));
    const p = r0.exec(req("return await fs.write('src/a.ts', 'x')"), ((rq: ToolRequest) => {
      entered();
      return bridge(rq);
    }) as ToolBridge);
    await inBridge;
    const disposed = r0.dispose().then(
      () => 'resolved',
      (e: unknown) => e,
    );
    const out = await p;
    expect(out.kind).toBe('raise');
    if (out.kind === 'raise') expect(out.exception.name).toBe('E_TAINTED');
    const d = await disposed;
    expect(d).toBeInstanceOf(ReplTainted);
    expect((d as ReplTainted).report).toMatchObject({ clean: false, tainted: true, outstanding: [`x${execNo}-c1`] });
  }, 15_000);

  it('a checkpoint sink still running past sinkTimeoutMs taints the exec (the ledger write may still land)', async () => {
    const r = await repl({ onCheckpoint: () => new Promise<void>(() => undefined), sinkTimeoutMs: 200 }).exec(req("checkpoint('k', 1); return 1"), async (rq) => ok(rq, 1));
    expect(r.kind).toBe('raise');
    if (r.kind === 'raise') expect(r.exception.name).toBe('E_TAINTED');
    expect(r.tainted?.outstanding).toEqual([`x${execNo}-sink:checkpoint:k#1`]);
  });

  it('calls that finish inside the drain bound are not taint: E_OUTSTANDING, no taint, and dispose resolves clean', async () => {
    const bridge = (async (rq: ToolRequest) => {
      await sleep(200);
      return ok(rq, 'done');
    }) as ToolBridge;
    const r0 = repl({ drainMs: 2_000 });
    const r = await r0.exec(req("fs.write('src/a.ts', 'x'); return 1"), bridge);
    if (r.kind === 'raise') expect(r.exception.name).toBe('E_OUTSTANDING');
    expect(r.tainted).toBeUndefined();
    expect(r0.tainted).toBeUndefined();
    expect(await r0.shutdown()).toEqual({ clean: true, tainted: false, outstanding: [], processes: [] });
  });
});

describe('call identity (new finding 3)', () => {
  it('calls batched in one tick get distinct call ids and idempotency keys, even for identical requests', async () => {
    const seen: ToolRequest[] = [];
    const bridge: ToolBridge = async (rq) => {
      seen.push(rq);
      await sleep(20);
      return ok(rq, 'x');
    };
    const r = await repl().exec(req("await Promise.all([fs.read('same'), fs.read('same'), fs.read('same'), fs.write('src/a', 'v'), fs.write('src/a', 'v')]); return 1"), bridge);
    expect(r.kind).toBe('return');
    expect(seen).toHaveLength(5);
    expect(new Set(seen.map((s) => s.callId)).size).toBe(5);
    expect(new Set(seen.map((s) => s.idemKey)).size).toBe(5);
    expect(seen.map((s) => s.callId).sort()).toEqual([1, 2, 3, 4, 5].map((n) => `x${execNo}-c${n}`).sort());
    expect(r.trace.calls.map((c) => c.callId).sort()).toEqual(seen.map((s) => s.callId).sort());
  });
});

describe('checkpoint keys cross the redaction boundary (new finding 4)', () => {
  it('a canary or known-secret checkpoint key is refused before the sink; nothing carries it', async () => {
    const KNOWN = 'known_secret_value_77aa';
    for (const key of ['TECERA_CANARY_CHECKPOINT_KEY', `k.${KNOWN}`]) {
      const cps: CheckpointRecord[] = [];
      const evidence: SandboxEvidence[] = [];
      const r = await repl({ onCheckpoint: (c) => void cps.push(c), onEvidence: (e) => void evidence.push(e), redactor: makeRedactor([KNOWN]) }).exec(req(`checkpoint('ok', 1); checkpoint(${JSON.stringify(key)}, 2); return 1`), async (rq) => ok(rq, 1));
      expect(r.kind, key).toBe('raise');
      if (r.kind === 'raise') {
        expect(r.exception.name).toBe('E_DENIED');
        expect(r.exception.message).toMatch(/checkpoint key carries secret material/);
      }
      await sleep(20);
      expect(cps.map((c) => c.key)).toEqual(['ok']);
      const all = JSON.stringify({ r, cps, evidence });
      expect(all).not.toContain('TECERA_CANARY_CHECKPOINT_KEY');
      expect(all).not.toContain(KNOWN);
    }
  });
});

describe('output caps cut after redaction (new finding 5)', () => {
  const SECRET = 'sk-test-REGISTERED-secret-0123456789abcdef';
  const b64 = Buffer.from(SECRET).toString('base64');
  const hex = Buffer.from(SECRET).toString('hex');

  it('printed cap: a base64/hex/raw secret straddling the cap never leaves a fragment (single call and chunked call)', async () => {
    const redactor = makeRedactor([SECRET]);
    const cases: Array<[string, number, string]> = [
      ['base64 at the cap', 1_000, `'a'.repeat(990) + ${JSON.stringify(b64)} + 'b'.repeat(50)`],
      ['hex at the cap', 1_000, `'a'.repeat(985) + ${JSON.stringify(hex)}`],
      ['raw at the cap', 1_000, `'a'.repeat(995) + ${JSON.stringify(SECRET)}`],
      ['base64 at the cap of a chunked 250k call', 50_000, `'a'.repeat(49_990) + ${JSON.stringify(b64)} + 'c'.repeat(200_000)`],
    ];
    for (const [name, cap, expr] of cases) {
      const r = await repl({ redactor, maxPrintedBytes: cap }).exec(req(`console.log(${expr}); return 1`, {}, 8_000), async (rq) => ok(rq, 1));
      expect(r.kind, name).toBe('raise');
      if (r.kind === 'raise') expect(r.exception.name, name).toBe('E_OUTPUT');
      expect(Buffer.byteLength(r.printed), name).toBeLessThanOrEqual(cap);
      for (const enc of [SECRET, b64, hex]) for (const w of windows(enc, 10)) expect(r.printed.includes(w), `${name}: ${w}`).toBe(false);
    }
  }, 30_000);

  it('exception messages: a secret straddling the 8000-char cut is redacted, not cut', async () => {
    const redactor = makeRedactor([SECRET]);
    for (const [name, enc] of [
      ['raw', SECRET],
      ['base64', b64],
      ['hex', hex],
    ] as const) {
      const r = await repl({ redactor }).exec(req(`throw new Error('m'.repeat(7990) + ${JSON.stringify(enc)} + 'n'.repeat(20000))`, {}), async (rq) => ok(rq, 1));
      expect(r.kind, name).toBe('raise');
      if (r.kind !== 'raise') continue;
      expect(r.exception.message.length, name).toBeLessThanOrEqual(8000);
      for (const e of [SECRET, b64, hex]) for (const w of windows(e, 10)) expect(r.exception.message.includes(w), `${name}: ${w}`).toBe(false);
      for (const e of [SECRET, b64, hex]) for (const w of windows(e, 10)) expect((r.exception.stack ?? '').includes(w), `${name} stack: ${w}`).toBe(false);
    }
  }, 30_000);
});

describe('materialization and history (missing tests)', () => {
  it('materialization overflow: returning more promoted text than maxMaterializeChars is E_LIMIT, not a partial value', async () => {
    const big = 'q'.repeat(60_000);
    const cps: CheckpointRecord[] = [];
    const r = await repl({ maxMaterializeChars: 100_000, onCheckpoint: (c) => void cps.push(c) }).exec(req("const a = await fs.read('a'); const b = await fs.read('b'); return [a, b]"), async (rq) => ok(rq, big));
    expect(r.kind).toBe('raise');
    if (r.kind === 'raise') {
      expect(r.exception.name).toBe('E_LIMIT');
      expect(r.exception.message).toMatch(/exceed 100000 characters/);
    }
    const c = await repl({ maxMaterializeChars: 100_000, onCheckpoint: (x) => void cps.push(x) }).exec(req("const a = await fs.read('a'); const b = await fs.read('b'); checkpoint('both', [a, b]); return 1"), async (rq) => ok(rq, big));
    expect(c.kind).toBe('raise');
    if (c.kind === 'raise') expect(c.exception.name).toBe('E_LIMIT');
    expect(cps).toEqual([]);
  });

  it('hostile history mutation: writes to __history__ and to a returned slice never change what a fresh read returns', async () => {
    const hist = [{ turn: 1, output: 'first' }, { turn: 2, output: 'second' }];
    const r = await repl().exec(
      req(
        `try { __history__.slice = async () => ['evil']; } catch (e) {}
         try { __history__.len = async () => 7; } catch (e) {}
         try { delete __history__.search; } catch (e) {}
         try { Object.defineProperty(__history__, 'slice', { value: async () => ['evil'] }); } catch (e) {}
         const s1 = await __history__.slice(0, 2);
         try { s1[0].output = 'mutated'; } catch (e) {}
         try { s1.push({ turn: 9 }); } catch (e) {}
         const s2 = await __history__.slice(0, 2);
         return [Object.isFrozen(__history__), s2, await __history__.len(), typeof __history__.search]`,
        { ...files, __history__: { kind: 'value', value: hist as unknown as Json, provenance: { src: 'history', trust: 'untrusted' } } },
      ),
      async (rq) => ok(rq, 1),
    );
    expect(r).toMatchObject({ kind: 'return', value: [true, hist, 2, 'function'] });
  });
});
