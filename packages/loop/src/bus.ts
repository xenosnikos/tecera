import type { AppendResult, Bus, EventKind, Ledger, TeceraEvent } from '@tecera/contracts';

type Handler = (e: TeceraEvent) => Promise<void>;

/**
 * In-process bus over the ledger: publish = append to the log, then deliver to subscribers in order.
 * The log is the source of truth; delivery is at-least-once (a duplicate idemKey is appended as a
 * duplicate and not redelivered). Replace with the Mosaic LocalEventBus or NATS adapter in Phase 3.
 */
export class LedgerBus implements Bus {
  private readonly subs: Array<{ kinds: Set<EventKind> | '*'; handler: Handler }> = [];
  private readonly errors: Array<{ event: TeceraEvent; error: unknown }> = [];

  constructor(private readonly ledger: Ledger) {}

  async publish(e: TeceraEvent): Promise<void> {
    await this.publishResult(e);
  }

  /** publish() that returns the append result, so a caller can treat a duplicate id as a fault. */
  async publishResult(e: TeceraEvent): Promise<AppendResult> {
    const r = await this.ledger.append(e);
    if (r.duplicate) return r;
    for (const s of this.subs) {
      if (s.kinds !== '*' && !s.kinds.has(e.kind)) continue;
      try {
        await s.handler(e);
      } catch (error) {
        this.errors.push({ event: e, error });
      }
    }
    return r;
  }

  subscribe(kinds: EventKind[] | '*', handler: Handler): () => void {
    const entry = { kinds: kinds === '*' ? ('*' as const) : new Set(kinds), handler };
    this.subs.push(entry);
    return () => {
      const i = this.subs.indexOf(entry);
      if (i >= 0) this.subs.splice(i, 1);
    };
  }

  /** Handler failures never block the log; they are collected here for the loop to turn into events. */
  drainErrors(): Array<{ event: TeceraEvent; error: unknown }> {
    return this.errors.splice(0);
  }
}
