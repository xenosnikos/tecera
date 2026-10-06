import type { Json } from './json.js';
import type { Provenance } from './bdi.js';
import type { ExecResult, SerializedError } from './worker.js';

/**
 * Child ↔ supervisor frames. See docs/design/security.md §3. This is the ONE supported dialect:
 *
 * - Transport: newline-delimited JSON (NDJSON) on the child's stdio, one frame per line, never Node IPC.
 *   Every frame is bounded by RPC_LIMITS BEFORE it is parsed (maxFrameBytes per line) and validated after
 *   (maxDepth, maxInlineString); an oversized or malformed frame is a protocol error (E_FRAME) that ends
 *   the exec. maxLiveHandles and maxCallsPerExec bound one exec.
 * - Bindings: a 'value' binding is plain JSON. A 'handle' binding exposes the handle's methods as an
 *   object (`readFile.call(path)`); a handle binding whose methods are exactly ['call'] is exposed BOTH as
 *   a callable function (`readFile(path)`) and as that method object.
 * - Host functions: generated code reaches the supervisor's invoke/checkpoint through the reserved tool
 *   names in HOST_FUNCTIONS. An 'invoke' frame's options are {output?, narrow?: {tools?, limits?, depth?}};
 *   narrow can only narrow the owning invocation's capabilities, never widen them.
 * - Handles inside values: a reference to a handle anywhere inside a JSON value is the object
 *   {"$handle": h} (h matches HANDLE_RE). View handles (truncated/promoted values) expose len(), slice(a, b)
 *   and search(text). A promoted (truncated) value lives until the exec that produced it ends; using its
 *   handle afterwards is E_HANDLE.
 * - Errors: an 'error' frame code is one of E_HANDLE (unknown/expired handle), E_DENIED (capability or
 *   policy refusal), E_LIMIT (an RPC_LIMITS bound), E_FRAME (malformed frame), E_TOOL (the tool itself
 *   failed), E_INTERNAL (supervisor fault).
 */

/** Reserved ToolRequest.tool names for REPL host functions; shared by the sandbox and the broker. */
export const HOST_FUNCTIONS = { invoke: '__invoke__', checkpoint: '__checkpoint__' } as const;
export type HostFunction = (typeof HOST_FUNCTIONS)[keyof typeof HOST_FUNCTIONS];

/** An in-value handle reference. */
export interface HandleRef {
  $handle: string;
}

export function isHandleRef(v: unknown): v is HandleRef {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as { $handle?: unknown }).$handle === 'string' && HANDLE_RE.test((v as HandleRef).$handle);
}

export type RpcErrorCode = 'E_HANDLE' | 'E_DENIED' | 'E_LIMIT' | 'E_FRAME' | 'E_TOOL' | 'E_INTERNAL';

/** Options of an 'invoke' frame (child → supervisor). */
export interface InvokeFrameOptions {
  output?: Json;
  narrow?: { tools?: string[]; limits?: Partial<Record<string, number>>; depth?: number };
}

export const RPC_PROTOCOL_VERSION = 1 as const;
export const RPC_LIMITS = {
  maxFrameBytes: 1024 * 1024,
  maxDepth: 32,
  maxInlineString: 50_000,
  maxLiveHandles: 256,
  maxCallsPerExec: 200,
} as const;

/** `h1.<runId>.<seq>.<hmac16>` */
export const HANDLE_RE = /^h1\.[A-Za-z0-9_-]+\.\d+\.[a-f0-9]{16}$/;

export interface BindingFrame {
  name: string;
  kind: 'value' | 'handle';
  value?: Json;
  handle?: string;
  methods?: string[];
  description?: string;
  provenance: Provenance;
}

export type SupervisorToChild =
  | { t: 'program'; execNo: number; code: string; bindings: BindingFrame[]; timeoutMs: number }
  | { t: 'reply'; callId: string; ok: true; value?: Json; handle?: string; provenance: Provenance; truncated: boolean; bytes: number }
  | { t: 'error'; callId: string; code: RpcErrorCode; message: string }
  | { t: 'cancel'; reason: string };

export type ChildToSupervisor =
  | { t: 'hello'; protocolVersion: typeof RPC_PROTOCOL_VERSION }
  | { t: 'call'; callId: string; handle: string; method: string; args: Json[] }
  | { t: 'invoke'; callId: string; inputs: Record<string, Json>; output?: Json; narrow?: { tools?: string[]; limits?: Partial<Record<string, number>>; depth?: number } }
  | { t: 'checkpoint'; key: string; value: Json }
  | { t: 'log'; level: 'log' | 'warn' | 'error'; text: string }
  | { t: 'result'; execNo: number; result: ExecResult; printed: string }
  | { t: 'crash'; error: SerializedError };

export function frameSizeOk(frame: unknown): boolean {
  const s = JSON.stringify(frame);
  return Buffer.byteLength(s, 'utf8') <= RPC_LIMITS.maxFrameBytes;
}

export function jsonDepth(value: Json, depth = 0): number {
  if (value === null || typeof value !== 'object') return depth;
  const children = Array.isArray(value) ? value : Object.values(value);
  let max = depth + 1;
  for (const c of children) max = Math.max(max, jsonDepth(c, depth + 1));
  return max;
}
