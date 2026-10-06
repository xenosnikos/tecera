import { AsyncLocalStorage } from 'node:async_hooks';
import {
  FencedWriteGuard,
  fenceOf,
  FenceLost,
  type GateContext,
  type Tool,
  type ToolContext,
  type ToolRequest,
  type ToolResult,
  type VerifyOutcome,
  type VerifyRequest,
  type VerifyRunner,
  type WriteAuthorization,
  type WriteGuard,
  type WriteIntent,
} from '@tecera/contracts';

/**
 * Live lease fencing at the mutation boundary (security.md §4: "every repo write carries the token").
 *
 * The kernel's WriteGuard (contracts) is the mutation-time fence: the loop builds one per step execution
 * (step running, intention active, loop not stopped, token unchanged) and hands it to the worker
 * (WorkerStepRequest.guard / Worker.resume's 4th argument) and to the gates (GateContext.guard). The runtime
 * composes it with the LIVE lease of this process (`leaseGuard`):
 *
 * - check() also fails once the lease is lost or its local validity lapsed (worktree.ts heldReason: a write
 *   that passes it cannot race a takeover, because the ledger cannot hand the lease to anyone else before
 *   the ttl after our last successful renewal request);
 * - signal also aborts on lease loss (every process the step started is killed through it);
 * - authorizeWrite is the loop's (one approval per distinct write under degraded isolation). A step without
 *   a loop guard gets no write authority at all (fail closed).
 *
 * Write-class tools are wrapped (`fencedTool`): the call re-proves the lease on the ledger at entry (a stale
 * token is refused), then runs with the composed guard as Tool.call's third argument and `ctx.fence`. The
 * guard of the running step also reaches the tool through an AsyncLocalStorage, for brokers that do not
 * forward the third argument; and `mutationCheck()` (handed to the edit tool's synchronous pre-commit
 * seam) re-checks it immediately before the rename that publishes a write — after every await of the call.
 */

export interface LiveLease {
  assertHeld(token?: number): Promise<number>;
  readonly lost: AbortSignal;
  /** Sync: null while writes are allowed (lease held and locally valid), else why not. */
  heldReason?(): string | null;
}

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Sync lease state (lost or locally lapsed). */
export function leaseProblem(lease: LiveLease): string | null {
  if (lease.lost.aborted) return reasonOf(lease.lost.reason ?? 'worktree lease lost');
  try {
    return lease.heldReason ? lease.heldReason() : null;
  } catch (e) {
    return `lease check failed (${reasonOf(e)})`;
  }
}

/**
 * The step's guard AND the live lease. `inner` absent → a guard that refuses every write (check() still
 * reports the lease; authorizeWrite throws). Never widens `inner`: its check, signal and authorization stand.
 */
export function leaseGuard(lease: LiveLease, inner: WriteGuard | undefined, o: { allowWithoutInner?: boolean } = {}): FencedWriteGuard {
  const signals = [lease.lost, ...(inner?.signal ? [inner.signal] : [])];
  return new FencedWriteGuard({
    signal: signals.length === 1 ? signals[0]! : AbortSignal.any(signals),
    live: () => {
      const l = leaseProblem(lease);
      if (l) return l;
      if (!inner) return o.allowWithoutInner ? null : 'no write guard was supplied for this step';
      try {
        inner.check();
      } catch (e) {
        return reasonOf(e).replace(/^fence lost: /, '');
      }
      return null;
    },
    authorizeWrite: (w: WriteIntent): WriteAuthorization => {
      if (!inner) {
        if (o.allowWithoutInner) return { kind: 'allowed' };
        throw new FenceLost('no write guard was supplied for this step');
      }
      return typeof inner.authorizeWrite === 'function' ? inner.authorizeWrite(w) : { kind: 'allowed' };
    },
  });
}

/** The composed guard of the step this async context belongs to (set by the runtime's Worker wrapper). */
export const stepGuards = new AsyncLocalStorage<{ guard: WriteGuard }>();

/**
 * Sync mutation fence for tools that call it right before publishing a write (the edit tool's pre-commit
 * seam): throws FenceLost unless the running step's composed guard passes. No step guard → refuse.
 */
export function mutationCheck(lease: LiveLease): () => void {
  return () => {
    const l = leaseProblem(lease);
    if (l) throw new FenceLost(l);
    const st = stepGuards.getStore();
    if (!st) throw new FenceLost('no write guard is bound to this tool call');
    st.guard.check();
  };
}

function refused(req: ToolRequest, tool: string, why: string): ToolResult {
  return { callId: req.callId, ok: false, error: { name: 'LeaseLost', message: `${tool} refused: ${why}` }, provenance: { src: `tool:${tool}`, trust: 'untrusted' }, truncated: false };
}

type AuthorizeFn = (req: ToolRequest, ctx: ToolContext) => Promise<void>;

/**
 * Wrap a write-class tool: entry re-proof of the lease (ledger round trip, stale token refused), the
 * composed guard checked, then the tool runs with that guard (third argument), `ctx.fence`, and the guard
 * bound in `stepGuards` for the duration of the call. Read-class tools pass through unchanged.
 */
export function fencedTool<T extends Tool>(tool: T, lease: LiveLease): Tool {
  if (tool.risk === 'read') return tool;
  const guardFor = (given: WriteGuard | undefined): WriteGuard => {
    const step = stepGuards.getStore()?.guard;
    // The broker's guard is the loop's step guard; compose it with the lease. Otherwise the step's own
    // composed guard (already lease-bound). Neither → refuse.
    if (given) return leaseGuard(lease, given);
    if (step) return step;
    return leaseGuard(lease, undefined);
  };
  const entry = async (ctx: ToolContext, g: WriteGuard): Promise<void> => {
    g.check();
    if (typeof ctx.fencingToken !== 'number' || !Number.isFinite(ctx.fencingToken)) throw new Error('no worktree lease fencing token');
    await lease.assertHeld(ctx.fencingToken);
    g.check();
  };
  const wrapped: Tool & { authorize?: AuthorizeFn } = {
    name: tool.name,
    methods: tool.methods,
    schema: tool.schema,
    risk: tool.risk,
    call: async (req, ctx, guard?: WriteGuard) => {
      const g = guardFor(guard);
      try {
        await entry(ctx, g);
      } catch (e) {
        return refused(req, tool.name, `the worktree lease is not held (${reasonOf(e)})`);
      }
      const fenced: ToolContext = { ...ctx, fence: fenceOf(g) };
      return stepGuards.run({ guard: g }, () => tool.call(req, fenced, g));
    },
  };
  const auth = (tool as { authorize?: AuthorizeFn }).authorize;
  if (typeof auth === 'function') {
    wrapped.authorize = async (req, ctx) => {
      await entry(ctx, guardFor(undefined));
      return auth.call(tool, req, ctx);
    };
  }
  return wrapped;
}

/**
 * The worker's verify runner (its runVerify tool runs repository code in the worktree, which can write it):
 * every run re-proves the lease first and runs with the lease signal (and the step guard's signal, when the
 * call carries one) merged into its own, so a lost lease refuses the next check and kills the running one.
 */
export function fencedVerifyRunner(runner: VerifyRunner, lease: LiveLease): VerifyRunner {
  return {
    run: async (req: VerifyRequest, signal?: AbortSignal): Promise<VerifyOutcome> => {
      const l = leaseProblem(lease);
      if (l) throw new Error(`verify refused: ${l}`);
      await lease.assertHeld();
      const step = stepGuards.getStore()?.guard;
      if (step) step.check();
      const signals = [lease.lost, ...(signal ? [signal] : []), ...(step ? [step.signal] : [])];
      return runner.run(req, signals.length === 1 ? signals[0]! : AbortSignal.any(signals));
    },
  };
}

/**
 * Gate context with the lease composed into its guard (verify/review/commit/reconcile). A gate the loop
 * called without a guard (reconcile at restore) gets one bound to the lease only: its git mutations still
 * stop the moment the lease is lost or lapses.
 */
export function leasedGateContext(g: GateContext, lease: LiveLease): GateContext {
  const guard = leaseGuard(lease, g.guard, { allowWithoutInner: g.guard === undefined });
  return { ...g, guard, signal: g.signal ? AbortSignal.any([g.signal, guard.signal]) : guard.signal };
}
