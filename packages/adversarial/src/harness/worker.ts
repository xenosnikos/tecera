import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CapabilitySet, ExecRequest, Inputs, JsonObject, LLM, Outcome, Repl } from '@tecera/contracts';
import { DEFAULT_PERMISSIONS, mandatoryHooks } from '@tecera/policy';
import { Broker, ChildProcessRepl, createEditTool, createListFilesTool, createReadTool, invoke, type ExecOutput, type ReplFactory, type TraceEntry } from '@tecera/worker';
import { manifest } from './gates.js';
import { SANDBOX } from './sandbox.js';
import { tmp } from './tmp.js';

/**
 * Worker kit: the real invoke loop over the real sandbox child (ChildProcessRepl per exec), the real
 * broker and file tools, and the fourteen real mandatory hooks. Every exec request and output is captured.
 */

export interface WorkerRig {
  root: string;
  caps: CapabilitySet;
  execs: Array<{ req: ExecRequest; out: ExecOutput }>;
  trace: TraceEntry[];
  run(llm: LLM, inputs?: Inputs, o?: { secrets?: string[]; output?: JsonObject }): Promise<Outcome>;
}

export function workerRig(files: Record<string, string>, o: { protectedPaths?: string[]; write?: string[] } = {}): WorkerRig {
  const root = tmp('tecera-adv-worker-');
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  const replRoot = tmp('tecera-adv-worker-repl-');
  chmodSync(replRoot, 0o711);
  const caps: CapabilitySet = {
    tools: ['read', 'edit', 'listFiles'],
    paths: { read: ['**'], write: o.write ?? ['src/**'], protected: o.protectedPaths ?? ['test/**', '**/*.test.*'] },
    network: 'none',
    limits: { usd: 1, tokens: 100_000, calls: 50, wallMs: 60_000, depth: 2, iterations: 6 },
  };
  const execs: WorkerRig['execs'] = [];
  const trace: TraceEntry[] = [];
  const factory: ReplFactory = (ctx) => {
    const repl = new ChildProcessRepl({ runId: ctx.runId, sandbox: SANDBOX, capabilities: ctx.capabilities, onInvoke: ctx.callbacks.onInvoke, onCheckpoint: ctx.callbacks.onCheckpoint, tmpRoot: replRoot });
    const wrapped: Repl = {
      exec: async (req, bridge, signal) => {
        const out = (await repl.exec(req, bridge, signal)) as ExecOutput;
        execs.push({ req, out });
        return out;
      },
      dispose: () => repl.dispose(),
    };
    return wrapped;
  };
  const m = manifest({ policy: { protectedPaths: caps.paths.protected, approvals: { required: ['open_pr'], ttlSec: 900, quorum: 1, separationOfDuty: true }, failure: { onVerifyFail: 'retry-once', onReviewFail: 'retry-once', onLedgerError: 'stop' } } });
  return {
    root,
    caps,
    execs,
    trace,
    run: (llm, inputs = {}, x = {}) => {
      const hooks = mandatoryHooks(m, { permissions: DEFAULT_PERMISSIONS, secretValues: x.secrets ?? [] });
      const broker = new Broker({ tools: [createReadTool(), createEditTool(), createListFilesTool()], runId: 'run_w', worktree: root, capabilities: caps, fencingToken: 1 });
      const goal: Inputs = { goal: { kind: 'value', value: { statement: 'probe' }, provenance: { src: 'goal', trust: 'trusted' } }, ...inputs };
      return invoke(goal, { output: x.output ?? ({ type: 'object' } as JsonObject), hooks, llm, repl: factory, broker, run: { runId: 'run_w', invokeId: 'inv_w', depth: 0 }, capabilities: caps, trace, ...(x.secrets ? { secrets: x.secrets } : {}) });
    },
  };
}

export const js = (body: string): string => `\`\`\`js\n${body}\n\`\`\``;

export function count(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}
