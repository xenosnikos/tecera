import type { SerializedError, ToolRequest } from '@tecera/contracts';

/**
 * Sandbox failure vocabulary. Every kill or limit becomes an ExecResult `raise` whose exception names
 * one of these codes, so the caller can tell a hostile program from a host bug without parsing prose.
 */
export type SandboxCode =
  | 'E_HANDLE'
  | 'E_DENIED'
  | 'E_LIMIT'
  | 'E_FRAME'
  | 'E_INTERNAL'
  | 'E_TIMEOUT'
  | 'E_OOM'
  | 'E_OUTPUT'
  | 'E_CANCELLED'
  | 'E_CRASH'
  | 'E_SPAWN'
  | 'E_DISPOSED'
  /** Tool calls or sub-invokes were still in flight when the program finished; they were cancelled and drained. */
  | 'E_OUTSTANDING'
  /**
   * Something the exec started is still unresolved after the drain bound (a bridge call, sub-invoke or
   * sink that did not settle, or a process that survived SIGKILL). The exec's worktree must be treated as
   * tainted: ExecOutput.tainted lists the outstanding operation ids, and the REPL refuses further execs.
   */
  | 'E_TAINTED';

export function sandboxError(code: SandboxCode, message: string): SerializedError {
  return { name: code, message };
}

/** Thrown when the manifest asks for OS isolation the host cannot provide. Fail closed: no degraded fallback. */
export class IsolationUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IsolationUnavailable';
  }
}

/**
 * Thrown by a ToolBridge or onInvoke callback to suspend the exec (approval needed). The host kills the
 * child, cancels and drains every other in-flight call, and returns `{ kind: 'suspended', pending }`;
 * a suspension dominates a program result that arrived while calls were pending. Resumption is a fresh
 * exec from checkpoints. `pending` is passed through unchanged: carry the real approval metadata
 * (SuspendRequest) in the caller's own state, do not cast it to a ToolRequest.
 */
export class SuspendExec extends Error {
  constructor(public readonly pending: ToolRequest, message = 'exec suspended pending approval') {
    super(message);
    this.name = 'SuspendExec';
  }
}
