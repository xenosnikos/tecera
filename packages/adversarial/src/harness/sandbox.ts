import { chmodSync, readdirSync } from 'node:fs';
import type { CapabilitySet, ExecRequest, Inputs, ToolBridge, ToolRequest, ToolResult } from '@tecera/contracts';
import { ChildProcessRepl, type ChildProcessReplOptions, type SandboxEvidence } from '@tecera/worker';
import { alive, cmdline, descendants, exeOf, ppid } from './procs.js';
import { tmp } from './tmp.js';

/** REPL kit: the real ChildProcessRepl with a recording bridge. */

export const SANDBOX = { profile: 'process' as const, isolation: 'node' as const, memoryMb: 128, execTimeoutSec: 20, envAllowlist: ['PATH', 'HOME'] };

export const FILES: Inputs = { fs: { kind: 'handle', id: 'files', methods: ['read', 'write'], description: 'repo files' } };

export const CAPS: CapabilitySet = {
  tools: ['files'],
  paths: { read: ['**'], write: ['src/**'], protected: ['test/**'] },
  network: 'none',
  limits: { usd: 1, tokens: 1000, calls: 10, wallMs: 60_000, depth: 2, iterations: 5 },
};

export interface Recorder {
  bridge: ToolBridge;
  calls: ToolRequest[];
  /** pids of sandbox children seen while a call was in flight (children of this process running entry.mjs). */
  childPids: number[];
}

/** A bridge that echoes, records every request and the live sandbox child pid. */
export function recorder(reply: (req: ToolRequest) => Partial<ToolResult> = () => ({})): Recorder {
  const calls: ToolRequest[] = [];
  const childPids: number[] = [];
  const bridge: ToolBridge = async (req) => {
    calls.push(req);
    for (const pid of sandboxChildren()) if (!childPids.includes(pid)) childPids.push(pid);
    return { callId: req.callId, ok: true, value: { echo: req.args, method: req.method }, provenance: { src: `tool:${req.tool}`, trust: 'untrusted' }, truncated: false, ...reply(req) };
  };
  return { bridge, calls, childPids };
}

/** Live sandbox children of this process (entry.mjs under a scratch dir). */
export function sandboxChildren(): number[] {
  const out: number[] = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const pid = Number(d);
    if (ppid(pid) !== process.pid) continue;
    if ((cmdline(pid) ?? '').includes('entry.mjs')) out.push(pid);
  }
  return out;
}

/**
 * The sandbox NODE processes under this process (any depth: OS wrappers such as unshare/setpriv sit in between):
 * the process whose executable is this node binary and whose command line runs entry.mjs.
 */
export function sandboxNodes(): number[] {
  const node = exeOf(process.pid);
  return descendants(process.pid).filter((p) => alive(p) && (cmdline(p) ?? '').includes('entry.mjs') && node !== null && exeOf(p) === node);
}

export interface ReplRig {
  repl: ChildProcessRepl;
  evidence: SandboxEvidence[];
  root: string;
}

/** A REPL whose scratch dirs live under a private tmp root (o+x so a uid-dropped child can reach it). */
export function replRig(extra: Partial<ChildProcessReplOptions> = {}): ReplRig {
  const root = tmp('tecera-adv-repl-');
  chmodSync(root, 0o711);
  const evidence: SandboxEvidence[] = [];
  const repl = new ChildProcessRepl({ runId: 'run_adv', sandbox: SANDBOX, tmpRoot: root, onEvidence: (e) => void evidence.push(e), ...extra });
  return { repl, evidence, root };
}

let execNo = 0;
export function execReq(code: string, bindings: Inputs = FILES, timeoutMs = 8_000): ExecRequest {
  return { execNo: ++execNo, code, bindings, timeoutMs };
}
