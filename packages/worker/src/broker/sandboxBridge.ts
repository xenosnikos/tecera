import { HOST_FUNCTIONS, type CapabilitySet, type InvokeFrameOptions, type Json } from '@tecera/contracts';
import type { Broker } from './broker.js';

/**
 * Adapters from the sandbox REPL's host-function callbacks (ChildProcessReplOptions.onInvoke /
 * onCheckpoint) to ONE broker: the broker of the invoke that owns the REPL. Each invoke (root and every
 * nested one) builds its own REPL with these callbacks, so a nested invoke's frames can never reach its
 * parent's broker; the broker additionally refuses a host call whose execNo is not its live exec (exec
 * numbers are unique across the invoke tree). Structural types only: the invoke lane does not import
 * the sandbox. The sandbox has already intersected the requested capabilities with its own; the broker
 * re-checks them against the live exec's capabilities and refuses any widening.
 */

export interface SandboxSubInvoke {
  execNo: number;
  callId: string;
  inputs: Record<string, Json>;
  output?: Json;
  capabilities: CapabilitySet;
}

export interface SandboxCheckpoint {
  execNo: number;
  key: string;
  value: Json;
}

export interface SandboxCallbacks {
  onInvoke: (req: SandboxSubInvoke, signal?: AbortSignal) => Promise<Json>;
  onCheckpoint: (cp: SandboxCheckpoint) => Promise<void>;
}

export function sandboxCallbacks(broker: Broker): SandboxCallbacks {
  return {
    async onInvoke(req) {
      const c = req.capabilities;
      const opts: InvokeFrameOptions = { output: req.output ?? {}, narrow: { tools: [...c.tools], limits: { ...c.limits } } };
      const r = await broker.hostCall(req.execNo, { callId: String(req.callId), tool: HOST_FUNCTIONS.invoke, method: 'invoke', args: [req.inputs as Json, opts as unknown as Json], idemKey: '' });
      if (!r.ok) throw new Error(`${r.error?.name ?? 'E_DENIED'}: ${r.error?.message ?? 'sub-invoke refused'}`);
      return r.value ?? null;
    },
    async onCheckpoint(cp) {
      const r = await broker.hostCall(cp.execNo, { callId: `cp${cp.execNo}`, tool: HOST_FUNCTIONS.checkpoint, method: 'call', args: [cp.key, cp.value], idemKey: '' });
      if (!r.ok) throw new Error(`${r.error?.name ?? 'E_DENIED'}: ${r.error?.message ?? 'checkpoint refused'}`);
    },
  };
}
