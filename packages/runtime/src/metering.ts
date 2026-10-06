import { randomUUID } from 'node:crypto';
import { AccountingFailure, LedgerError, meteredCall, type BudgetExhaustion, type Ledger, type LLM, type LLMRequest, type LLMResponse, type LLMUsage } from '@tecera/contracts';

/**
 * Seat accounting for model calls the loop does not meter itself (the reviewer seat inside the review gate,
 * the frontier seat answering shaky reflex questions). Same discipline as the loop (contracts meteredCall):
 *
 * 1. reserve the per-call estimate on the run's 'calls', 'usd' and 'tokens' pools BEFORE the call (an
 *    unopened or exhausted pool refuses: AccountingFailure 'budget', the call is never made);
 * 2. run the call under the run-wide cancellation signal (durable deadline, lease loss, CLI interrupt)
 *    combined with the call's own: an abort stops waiting at once and the call is charged its reservation;
 * 3. settle AFTER the call at the usage the provider reported (malformed, missing or zero usage is charged
 *    at the reservation, never as zero);
 * 4. probe the pools after settlement: a call that pushed an ENFORCED pool over its cap is exhaustion as
 *    well, and its answer is NOT used (the caller gets AccountingFailure 'budget').
 *
 * D3: with budgets.enforce false the run's pools are soft. A reservation past the cap is still recorded
 * (and settled), the call proceeds, and `onExhausted` is told (the runtime records budget.exhausted, once
 * per pool). Nothing about a soft pool ever refuses a call or discards its answer.
 *
 * Any other ledger failure is AccountingFailure 'ledger': the run terminates (exit 9), it never continues
 * unaccounted. Both are remembered (`exhausted`, `broken`) so a caller that catches provider errors (the
 * review gate turns them into verdicts) can be overruled by the runtime.
 */

export interface SeatReservation {
  usd: number;
  tokens: number;
  /** Calls reserved per call (default 1). */
  calls?: number;
}

export class SeatMeter {
  private n = 0;
  private readonly nonce = randomUUID().slice(0, 8);
  /** The first budget refusal this meter saw (null while within budget). */
  exhausted: AccountingFailure | LedgerError | null = null;
  /** The first non-budget accounting failure (the ledger could not reserve or settle). */
  broken: AccountingFailure | null = null;

  constructor(
    private readonly o: { ledger: Ledger; runId: string; seat: string; reservation: SeatReservation; signal?: () => AbortSignal | undefined; onExhausted?: (e: BudgetExhaustion) => void | Promise<void> },
  ) {}

  /** Charge one call: reserve → run (cancellable) → settle → probe. */
  async charge<T extends { usage?: LLMUsage }>(purpose: string, call: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.broken) throw this.broken;
    if (this.exhausted) throw new AccountingFailure(`${this.o.seat}: budget already exhausted (${this.exhausted.message})`, 'budget');
    const n = ++this.n;
    const run = this.o.signal?.();
    const signals = [signal, run].filter((s): s is AbortSignal => s !== undefined);
    const combined = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    const est = { usd: this.o.reservation.usd, tokens: this.o.reservation.tokens, calls: this.o.reservation.calls ?? 1 };
    let res: T;
    try {
      res = await meteredCall(
        this.o.ledger,
        { runId: this.o.runId, idemKey: `seat:${this.o.seat}:${purpose}:${this.o.runId}:${this.nonce}:${n}`, reservation: est, ...(combined ? { signal: combined } : {}), purpose: `${this.o.seat} ${purpose}`, ...(this.o.onExhausted ? { onExhausted: this.o.onExhausted } : {}) },
        async (meter) => {
          const r = await call(meter.signal);
          meter.record(r?.usage as LLMUsage); // a missing report is charged at the reservation (chargeOf)
          return r;
        },
      );
    } catch (e) {
      this.note(e);
      throw e;
    }
    // Did this call push a pool over its cap? A zero reservation is refused exactly when used > cap.
    for (const pool of ['calls', 'usd', 'tokens'] as const) {
      try {
        const p = await this.o.ledger.reserve(pool, 0, this.o.runId, `seat:${this.o.seat}:${purpose}:${this.o.runId}:${this.nonce}:${n}:probe:${pool}`);
        await this.o.ledger.settle(p.id, 0);
        // A soft pool (budgets.enforce false) past its cap: informational, the answer is used.
        if (p.exhausted) await this.o.onExhausted?.({ pool, used: p.exhausted.used, cap: p.exhausted.cap, amount: 0, purpose: `${this.o.seat} ${purpose}` });
      } catch (e) {
        const f = e instanceof LedgerError && e.code === 'budget' ? new AccountingFailure(`${this.o.seat}: the ${pool} pool is over its cap after this call`, 'budget', pool, { cause: e }) : new AccountingFailure(`${this.o.seat}: budget probe failed: ${(e as Error)?.message ?? String(e)}`, 'ledger', pool, { cause: e });
        this.note(f);
        throw f;
      }
    }
    return res;
  }

  private note(e: unknown): void {
    if (e instanceof AccountingFailure) {
      if (e.code === 'budget') this.exhausted ??= e;
      else this.broken ??= e;
    } else if (e instanceof LedgerError && e.code === 'budget') this.exhausted ??= e;
  }
}

/**
 * The seat's LLM with every complete() charged through `meter`. Identity fields (provider, keyFingerprint,
 * model, id) are read from the wrapped LLM unchanged, so foreign-review checks see the real seat.
 */
export function meteredLLM(llm: LLM, meter: SeatMeter, purpose: string): LLM {
  const complete = (req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> => meter.charge(purpose, (s) => llm.complete(req, s), signal);
  return new Proxy(llm, {
    get(target, prop) {
      if (prop === 'complete') return complete;
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/**
 * An LLM whose every call is ALSO cancelled by the run-wide signal (deadline, lease loss, interrupt), for
 * seats the loop or the worker meter themselves (planner, workers). Not metered here (never charged twice).
 */
export function cancellableLLM(llm: LLM, runSignal: () => AbortSignal | undefined, extra?: () => AbortSignal | undefined): LLM {
  const complete = (req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> => {
    const signals = [signal, runSignal(), extra?.()].filter((s): s is AbortSignal => s !== undefined);
    const combined = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    if (combined?.aborted) return Promise.reject(combined.reason instanceof Error ? combined.reason : new Error(`call cancelled: ${String(combined.reason)}`));
    return llm.complete(req, combined);
  };
  return new Proxy(llm, {
    get(target, prop) {
      if (prop === 'complete') return complete;
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** Is `e` (or anything in its cause chain) a budget refusal? */
export function isBudgetRefusal(e: unknown): boolean {
  let cur: unknown = e;
  for (let d = 0; cur && d < 6; d++) {
    if (cur instanceof AccountingFailure) return cur.code === 'budget';
    if (cur instanceof LedgerError) return cur.code === 'budget';
    if (typeof cur === 'object' && (cur as { code?: unknown }).code === 'budget') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** Is `e` (or its cause chain) an accounting failure that is NOT a budget refusal (the ledger broke)? */
export function isAccountingBroken(e: unknown): boolean {
  let cur: unknown = e;
  for (let d = 0; cur && d < 6; d++) {
    if (cur instanceof AccountingFailure) return cur.code === 'ledger';
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
