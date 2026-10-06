import { readdirSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Inputs, ToolBridge } from '@tecera/contracts';
import { ChildProcessRepl, groupAlive } from './index.js';

const files: Inputs = { fs: { kind: 'handle', id: 'files', methods: ['read'], description: 'repo files' } };

/** Bridge that records the child's pid by finding its entry.mjs under a unique tmp root. */
function pidSpy(root: string) {
  const pids: number[] = [];
  const bridge: ToolBridge = async (rq) => {
    for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      try {
        if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(root)) pids.push(Number(pid));
      } catch {
        /* raced */
      }
    }
    return { callId: rq.callId, ok: true, value: 'ok', provenance: { src: 'tool:files', trust: 'untrusted' }, truncated: false };
  };
  return { pids, bridge };
}

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'tecera-dos-'));
  await chmod(root, 0o711); // the child may run under a dropped uid
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('dos', () => {
  it('dos.infinite_loop: killed at the wall timeout and the process group is gone', async () => {
    await withRoot(async (root) => {
      const spy = pidSpy(root);
      const repl = new ChildProcessRepl({ runId: 'run_dos', sandbox: { profile: 'process', isolation: 'node', memoryMb: 64, execTimeoutSec: 30, envAllowlist: [] }, tmpRoot: root });
      const t0 = Date.now();
      const r = await repl.exec({ execNo: 1, code: "await fs.read('x'); while (true) {}", bindings: files, timeoutMs: 1_000 }, spy.bridge);
      expect(Date.now() - t0).toBeLessThan(4_000);
      expect(r.kind).toBe('raise');
      if (r.kind === 'raise') expect(r.exception.name).toBe('E_TIMEOUT');
      expect(r.trace.killed).toEqual({ cause: 'timeout', gone: true });
      expect(spy.pids).toHaveLength(1);
      expect(groupAlive(spy.pids[0]!)).toBe(false);
      expect(readdirSync(root)).toEqual([]);
    });
  });

  it('the manifest execTimeoutSec caps a larger per-exec timeout', async () => {
    const repl = new ChildProcessRepl({ runId: 'run_dos', sandbox: { profile: 'process', isolation: 'node', memoryMb: 64, execTimeoutSec: 1, envAllowlist: [] } });
    const t0 = Date.now();
    const r = await repl.exec({ execNo: 1, code: 'while (true) {}', bindings: {}, timeoutMs: 60_000 }, async () => {
      throw new Error('unused');
    });
    expect(r.kind).toBe('raise');
    expect(Date.now() - t0).toBeLessThan(4_000);
  });

  it('dos.oom: growing the heap past memoryMb kills the child and raises E_OOM', async () => {
    await withRoot(async (root) => {
      const spy = pidSpy(root);
      const repl = new ChildProcessRepl({ runId: 'run_dos', sandbox: { profile: 'process', isolation: 'node', memoryMb: 32, execTimeoutSec: 30, envAllowlist: [] }, tmpRoot: root });
      const r = await repl.exec(
        { execNo: 1, code: "await fs.read('x'); const keep = []; while (true) keep.push(new Array(1e5).fill({ x: Math.random() }));", bindings: files, timeoutMs: 9_000 },
        spy.bridge,
      );
      expect(r.kind).toBe('raise');
      if (r.kind === 'raise') expect(r.exception.name).toBe('E_OOM');
      expect(spy.pids).toHaveLength(1);
      expect(groupAlive(spy.pids[0]!)).toBe(false);
    });
  }, 15_000);

  it('dos.output_flood: 10 MB of console output is capped at 1 MiB and the group is killed', async () => {
    const repl = new ChildProcessRepl({ runId: 'run_dos', sandbox: { profile: 'process', isolation: 'node', memoryMb: 128, execTimeoutSec: 30, envAllowlist: [] } });
    const r = await repl.exec({ execNo: 1, code: "const s = 'x'.repeat(100000); for (let i = 0; i < 100; i++) console.log(s); return 'finished'", bindings: {}, timeoutMs: 9_000 }, async () => {
      throw new Error('unused');
    });
    expect(r.kind).toBe('raise');
    if (r.kind === 'raise') expect(r.exception.name).toBe('E_OUTPUT');
    expect(Buffer.byteLength(r.printed)).toBe(1024 * 1024);
    expect(r.trace.killed).toEqual({ cause: 'output-flood', gone: true });
  });

  it('a small printed cap is honoured too', async () => {
    const repl = new ChildProcessRepl({ runId: 'run_dos', sandbox: { profile: 'process', isolation: 'node', memoryMb: 64, execTimeoutSec: 30, envAllowlist: [] }, maxPrintedBytes: 1000 });
    const r = await repl.exec({ execNo: 1, code: "for (let i = 0; i < 1000; i++) console.log('line ' + i); return 1", bindings: {}, timeoutMs: 5_000 }, async () => {
      throw new Error('unused');
    });
    expect(r.kind).toBe('raise');
    expect(r.printed.length).toBe(1000);
  });
});
