import { randomUUID } from 'node:crypto';
import type { Manifest } from './manifest.js';
import { LedgerError, type Ledger, type LLM, type LLMRequest, type LLMResponse, type Reservation, type UsageMeter } from './ports.js';

/**
 * Seat accounting for every LLM call (planner, workers, reviewer, frontier, model-backed reflex seams):
 * reserve the run's 'calls', 'usd' and 'tokens' pools BEFORE the call, settle AFTER it. Fail closed:
 *
 * - an unopened or exhausted pool refuses the call before it is made (AccountingFailure 'budget');
 * - any other reserve or settle failure is AccountingFailure 'ledger' — the caller must terminate the run,
 *   never continue unaccounted (a settle failure discards an otherwise successful result);
 * - malformed or unknown usage (missing, non-finite, negative, zero, or flagged `unknown: true`) settles at
 *   least at the RESERVED amount, never at zero; no report at all settles at the reservation;
 * - budgets.enforce false (D3): pools are soft; a reservation past a cap is still recorded and reported
 *   through `onExhausted` (the run records budget.exhausted and continues).
 * - cancellation (deadline, lease loss, loop stop) aborts the call's signal, stops waiting for it at once
 *   and settles at least the reservation (the request may still be billed).
 */

export const LLM_POOLS = ['calls', 'usd', 'tokens'] as const;
export type LlmPool = (typeof LLM_POOLS)[number];

export interface LlmCallReservation {
  usd: number;
  tokens: number;
  /** Calls reserved for this metered unit (default 1). Settled at max(reserved, usage reports). */
  calls?: number;
}

export const DEFAULT_CALL_RESERVATION: Readonly<Required<LlmCallReservation>> = Object.freeze({ usd: 0.05, tokens: 8000, calls: 1 });

/** A seat's accounting could not be done. 'budget' = refused by a cap / unopened pool; 'ledger' = the ledger failed. */
export class AccountingFailure extends Error {
  constructor(
    message: string,
    public readonly code: 'budget' | 'ledger',
    public readonly pool?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AccountingFailure';
  }
}

/** The call was cancelled through its signal before it settled. */
export class CallCancelled extends Error {
  readonly code = 'cancelled';
  constructor(reason: string) {
    super(`call cancelled: ${reason}`);
    this.name = 'CallCancelled';
  }
}

/**
 * Chargeable amounts of one usage report, with the reservation substituted for anything unknown:
 * a malformed report (not an object, a field missing, non-finite or negative) is charged the full
 * reservation; a zero usd or a zero token count is unknown and charged the reserved amount of that pool;
 * a report flagged `unknown: true` (an estimate) is charged at least the reservation and stays unknown.
 */
export function chargeOf(u: unknown, reserved: { usd: number; tokens: number }): { usd: number; tokens: number; known: boolean } {
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!u || typeof u !== 'object') return { ...reserved, known: false };
  const r = u as Record<string, unknown>;
  if (!ok(r.usd) || !ok(r.inputTokens) || !ok(r.outputTokens)) return { ...reserved, known: false };
  const tokens = r.inputTokens + r.outputTokens;
  if (r.unknown === true) return { usd: Math.max(r.usd, reserved.usd), tokens: Math.max(tokens, reserved.tokens), known: false };
  const usdKnown = r.usd > 0;
  const tokensKnown = tokens > 0;
  return { usd: usdKnown ? r.usd : reserved.usd, tokens: tokensKnown ? tokens : reserved.tokens, known: usdKnown && tokensKnown };
}

function isBudgetRefusal(err: unknown): boolean {
  return err instanceof LedgerError ? err.code === 'budget' : typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'budget';
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function abortError(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  return r instanceof Error ? r : new CallCancelled(r === undefined ? 'aborted' : String(r));
}

/** Settle when `p` settles or reject as soon as `signal` aborts (the call is abandoned, not awaited). */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      p.catch(() => undefined);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

export interface MeteredCallOptions {
  runId: string;
  /** Unique per call (reservation idempotency keys are `${idemKey}:${pool}`). */
  idemKey: string;
  reservation: LlmCallReservation;
  /** Deadline / lease-loss / stop signal: aborts the call and stops waiting for it. */
  signal?: AbortSignal;
  purpose?: string;
  /**
   * Called once per pool a reservation took past its cap on a SOFT pool (budgets.enforce false). The call
   * still runs and settles. Awaited after settlement; a throw is ignored here (the caller owns its state).
   */
  onExhausted?: (e: BudgetExhaustion) => void | Promise<void>;
}

/** A soft pool passed its cap (D3). Informational: the run continues. */
export interface BudgetExhaustion {
  pool: string;
  used: number;
  cap: number;
  amount: number;
  purpose: string;
}

/**
 * Meter one LLM call (or one metered unit that may make several calls, each reporting on the meter):
 * reserve calls/usd/tokens, run `call` with a meter whose `signal` is the cancellation signal, settle.
 * Throws AccountingFailure on any accounting problem (after settling what it reserved), the abort reason
 * (or CallCancelled) on cancellation, else whatever the call threw.
 */
export async function meteredCall<T>(ledger: Ledger, o: MeteredCallOptions, call: (meter: UsageMeter & { readonly signal: AbortSignal }) => Promise<T>): Promise<T> {
  const purpose = o.purpose ?? 'llm call';
  const res = { calls: o.reservation.calls ?? 1, usd: o.reservation.usd, tokens: o.reservation.tokens };
  for (const pool of LLM_POOLS) {
    if (!(Number.isFinite(res[pool]) && res[pool] >= 0)) throw new AccountingFailure(`${purpose}: invalid ${pool} reservation ${String(res[pool])}`, 'ledger', pool);
  }
  if (res.calls < 1) throw new AccountingFailure(`${purpose}: a call must reserve at least one call`, 'ledger', 'calls');
  if (o.signal?.aborted) throw abortError(o.signal);

  const reserved: Array<{ id: string; pool: LlmPool }> = [];
  const exhausted: BudgetExhaustion[] = [];
  const settleAll = async (amount: (pool: LlmPool) => number): Promise<unknown> => {
    let failure: unknown;
    for (const r of reserved) {
      try {
        await ledger.settle(r.id, amount(r.pool));
      } catch (err) {
        failure ??= err;
      }
    }
    return failure;
  };
  for (const pool of LLM_POOLS) {
    try {
      const r: Reservation = await ledger.reserve(pool, res[pool], o.runId, `${o.idemKey}:${pool}`);
      reserved.push({ id: r.id, pool });
      if (r.exhausted) exhausted.push({ pool, used: r.exhausted.used, cap: r.exhausted.cap, amount: res[pool], purpose });
    } catch (err) {
      // Nothing was called: release what was reserved at zero.
      const settleFailure = await settleAll(() => 0);
      if (settleFailure !== undefined) throw new AccountingFailure(`${purpose}: could not release reservations after ${pool} was refused: ${msg(settleFailure)}`, 'ledger', pool, { cause: settleFailure });
      throw new AccountingFailure(`${purpose} could not reserve ${pool}: ${msg(err)}`, isBudgetRefusal(err) ? 'budget' : 'ledger', pool, { cause: err });
    }
  }

  const ac = new AbortController();
  const ext = o.signal;
  const onExt = () => ac.abort(ext!.reason);
  if (ext) {
    if (ext.aborted) ac.abort(ext.reason);
    else ext.addEventListener('abort', onExt, { once: true });
  }
  const reports: unknown[] = [];
  const meter: UsageMeter & { readonly signal: AbortSignal } = {
    record: (u) => void reports.push(u),
    signal: ac.signal,
  };
  let result: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    result = { ok: true, value: await raceAbort(Promise.resolve().then(() => call(meter)), ac.signal) };
  } catch (error) {
    result = { ok: false, error };
  } finally {
    ext?.removeEventListener('abort', onExt);
  }
  const cancelled = ac.signal.aborted;
  let usd = 0;
  let tokens = 0;
  for (const u of reports) {
    const c = chargeOf(u, res);
    usd += c.usd;
    tokens += c.tokens;
  }
  const charged: Record<LlmPool, number> = {
    calls: Math.max(res.calls, reports.length),
    usd: reports.length === 0 || cancelled ? Math.max(usd, res.usd) : usd,
    tokens: reports.length === 0 || cancelled ? Math.max(tokens, res.tokens) : tokens,
  };
  const settleFailure = await settleAll((pool) => charged[pool]);
  if (settleFailure !== undefined) throw new AccountingFailure(`${purpose}: the ledger could not settle the call: ${msg(settleFailure)}`, 'ledger', undefined, { cause: settleFailure });
  if (o.onExhausted) {
    for (const e of exhausted) {
      try {
        await o.onExhausted(e);
      } catch {
        // informational only
      }
    }
  }
  if (!result.ok) throw result.error;
  return result.value;
}

/** The pools every run opens: usd, tokens, calls and wallMs (wall clock), all with the manifest's enforce flag. */
export const RUN_POOLS = ['usd', 'tokens', 'calls', 'wallMs'] as const;

/**
 * Open a run's pools from the manifest (D3): caps from budgets (calls from `callsCap`), soft unless
 * budgets.enforce is true. Re-opening never widens nor relaxes a pool, so call it once before the run starts.
 */
export async function openRunPools(ledger: Ledger, runId: string, m: Manifest, o: { callsCap: number }): Promise<void> {
  const enforce = m.budgets.enforce === true;
  const caps: Record<(typeof RUN_POOLS)[number], number> = { usd: m.budgets.usd, tokens: m.budgets.tokens, calls: o.callsCap, wallMs: m.budgets.wallClockSec * 1000 };
  for (const pool of RUN_POOLS) await ledger.openBudget(runId, pool, caps[pool], { enforce });
}

export interface MeteredLLMOptions {
  ledger: Ledger;
  runId: string;
  /** Per-call reservation, or a function of the request (e.g. from maxTokens). */
  reservation?: LlmCallReservation | ((req: LLMRequest) => LlmCallReservation);
  /** Run-wide cancellation (deadline, lease loss), combined with each call's own signal. */
  signal?: AbortSignal | (() => AbortSignal | undefined);
  idemPrefix?: string;
}

/**
 * Wrap an LLM seat so every complete() is metered on the run's calls/usd/tokens pools and cancelled by
 * the run-wide signal as well as its own. The response's usage settles the call (unknown → reserved).
 */
export function meteredLLM(llm: LLM, o: MeteredLLMOptions): LLM {
  let n = 0;
  const nonce = randomUUID().slice(0, 8);
  const wrapped: LLM = {
    id: llm.id,
    provider: llm.provider,
    ...(llm.model !== undefined ? { model: llm.model } : {}),
    ...(llm.keyFingerprint !== undefined ? { keyFingerprint: llm.keyFingerprint } : {}),
    complete: async (req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> => {
      const run = typeof o.signal === 'function' ? o.signal() : o.signal;
      const signals = [signal, run].filter((s): s is AbortSignal => s !== undefined);
      const combined = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
      const reservation = typeof o.reservation === 'function' ? o.reservation(req) : (o.reservation ?? DEFAULT_CALL_RESERVATION);
      return meteredCall(
        o.ledger,
        { runId: o.runId, idemKey: `${o.idemPrefix ?? 'llm'}:${llm.id}:${req.seatId}:${nonce}:${++n}`, reservation, ...(combined ? { signal: combined } : {}), purpose: `${req.seatId} call` },
        async (meter) => {
          const r = await llm.complete(req, meter.signal);
          meter.record(r?.usage);
          return r;
        },
      );
    },
  };
  return wrapped;
}
