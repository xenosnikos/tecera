import { digest, WriteRefused, type Json, type Provenance, type Redactor, type Tool, type ToolContext, type ToolRequest, type ToolResult, type WriteGuard, type WriteIntent } from '@tecera/contracts';
import { worktreeTaint } from './paths.js';

/**
 * Shared shapes for worker tools. Tools never claim trust: every result is tagged untrusted with the
 * tool as source; the broker re-tags anyway. Errors are values (ok:false), never thrown across the port.
 */

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export function ok(req: ToolRequest, tool: string, value: Json, extra: Partial<Provenance> = {}): ToolResult {
  return { callId: req.callId, ok: true, value, provenance: { src: `tool:${tool}`, trust: 'untrusted', digest: digest(value), ...extra }, truncated: false };
}

export function fail(req: ToolRequest, tool: string, e: unknown): ToolResult {
  const err = e instanceof Error ? e : new Error(String(e));
  return { callId: req.callId, ok: false, error: { name: err.name || 'Error', message: err.message }, provenance: { src: `tool:${tool}`, trust: 'untrusted' }, truncated: false };
}

/** First positional arg as a path string, or the `path` field of an object arg. */
export function pathArg(args: Json[]): unknown {
  const a = args[0];
  if (typeof a === 'string') return a;
  if (a && typeof a === 'object' && !Array.isArray(a)) return (a as { path?: Json }).path;
  return undefined;
}

export function assertMethod(req: ToolRequest, methods: readonly string[]): void {
  if (!methods.includes(req.method)) throw new ToolInputError(`unknown method ${req.method}`);
}

/**
 * Local extension of the Tool port (not in contracts): re-check a request's authority under the CURRENT
 * capabilities without performing it. The broker calls it before returning a journalled (replayed)
 * result, so a replay can never hand back data or confirm an action the current scope would refuse.
 * A write-class tool without it is never replayed (the call is refused instead of being re-run).
 */
export interface AuthorizingTool extends Tool {
  authorize(req: ToolRequest, ctx: ToolContext): Promise<void>;
}

export function canAuthorize(t: Tool): t is AuthorizingTool {
  return typeof (t as Partial<AuthorizingTool>).authorize === 'function';
}

/**
 * Local extension of ToolContext (not in contracts): the broker passes the step's redactor (built from
 * the step's secret list, the same instance that redacts everything else) and the exec's AbortSignal.
 * Tools that cut or summarise output redact the complete text first; tools that can stop honour the
 * signal. Both optional: a plain ToolContext still works (and is redacted later by the broker).
 */
export interface WorkerToolContext extends ToolContext {
  redactor?: Redactor;
  signal?: AbortSignal;
}

/**
 * Authorize one concrete write (path + sha256 of the exact bytes) through the step's guard: check(), then
 * authorizeWrite when the guard has it. Resolves when the write may happen now; throws FenceLost or
 * WriteRefused otherwise.
 *
 * Owner decision D6 (2026-10-05): writes inside capabilities.paths.write on the leased work branch proceed
 * without approval under ANY isolation; the PR gate is the only approval point. There are no per-write
 * approvals any more, so the only answer that lets a write happen is 'allowed'. A guard that still answers
 * 'needs-approval' or 'approved' (an older loop) is refused, fail closed: nothing is written and the step
 * is never suspended for a write. Fencing, protected paths and tamper rules are unchanged.
 */
export async function authorizeWriteVia(guard: WriteGuard, _ctx: ToolContext, w: WriteIntent): Promise<void> {
  guard.check();
  if (typeof guard.authorizeWrite !== 'function') return;
  const auth = guard.authorizeWrite(w);
  switch (auth?.kind) {
    case 'allowed':
      return;
    case 'approved':
    case 'needs-approval':
      throw new WriteRefused(`${w.path}: the guard answered '${auth.kind}', but per-write approvals were removed (D6); only 'allowed' writes`);
    default:
      throw new WriteRefused('unknown write authorization');
  }
}

export const redactorOf = (ctx: ToolContext): Redactor | undefined => (ctx as WorkerToolContext).redactor;
export const signalOf = (ctx: ToolContext): AbortSignal | undefined => (ctx as WorkerToolContext).signal;

/** The exec signal and the guard's signal combined (either one stops a long operation). */
export function combinedSignal(ctx: ToolContext, guard: WriteGuard): AbortSignal {
  const s = signalOf(ctx);
  return s ? AbortSignal.any([s, guard.signal]) : guard.signal;
}

/** Refuse when the step has no worktree (contract: '' = refuse every file and verify tool) or it is quarantined. */
export function assertWorktree(ctx: ToolContext): void {
  if (typeof ctx.worktree !== 'string' || ctx.worktree.length === 0) throw new ToolInputError('no worktree is configured for this step; file and verify tools are refused');
  const t = worktreeTaint(ctx.worktree);
  if (t !== null) throw new ToolInputError(`the worktree is quarantined (tainted: ${t}); file and verify tools are refused`);
}

/** Refuse a write-class tool without a lease fencing token (absent lease = no mutation). */
export function assertLease(ctx: ToolContext, tool: string): void {
  if (typeof ctx.fencingToken !== 'number' || !Number.isFinite(ctx.fencingToken)) throw new ToolInputError(`${tool} refused: no worktree lease fencing token`);
}
