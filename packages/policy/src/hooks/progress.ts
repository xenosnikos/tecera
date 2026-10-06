import { noProgressReason, type AttemptFingerprint, type Effect, type Hook, type HookDescriptor, type SpanEvent } from '@tecera/contracts';

/**
 * Where the progress check reads the candidate fingerprints (verify D1) of earlier attempts:
 * - `fingerprintOf(attempt)`: callback wired by the runtime from the loop/ledger (the attempt's latest verify
 *   fingerprint), for attempts 1..`attempt()`;
 * - and/or `input.progress.fingerprints` on the Invoke span ([{attempt, fingerprint}]), when the caller
 *   forwards them with the step.
 */
export interface ProgressSource {
  /**
   * Preferred: every recorded candidate with the worker execution that produced it (the loop's verify
   * events carry `attempt`, `fingerprint` and `workerExec`). Only candidates of DIFFERENT worker executions
   * are compared (ADV-8: two verifies of one execution are not "no progress").
   */
  history?: () => AttemptFingerprint[];
  fingerprintOf?: (attempt: number) => string | null | undefined;
  /** Current attempt of the intention this invoke works for; defaults to the highest attempt seen. */
  attempt?: () => number;
}

function fromInput(e: SpanEvent): AttemptFingerprint[] {
  const p = (e.input as { progress?: { fingerprints?: unknown } }).progress;
  const list = p && typeof p === 'object' ? p.fingerprints : undefined;
  if (!Array.isArray(list)) return [];
  const out: AttemptFingerprint[] = [];
  for (const x of list) {
    if (!x || typeof x !== 'object') continue;
    const { attempt, fingerprint, exec } = x as { attempt?: unknown; fingerprint?: unknown; exec?: unknown };
    if (typeof attempt === 'number' && Number.isInteger(attempt) && (typeof fingerprint === 'string' || fingerprint === null)) {
      out.push({ attempt, fingerprint, ...(typeof exec === 'number' || typeof exec === 'string' ? { exec } : {}) });
    }
  }
  return out;
}

/**
 * Mandatory progressCheck: two different attempts that produced the same candidate fingerprint made no
 * progress → Abort 'policy' with a 'no progress' reason (the loop turns this into a terminal 'human'
 * failure). Checked when an invoke starts, before any model call. A throwing source is a hook error (the
 * worker fails closed on it).
 */
export class ProgressCheck implements Hook {
  readonly id = 'progressCheck';
  readonly mandatory = true;
  readonly spans = new Set<SpanEvent['span']>(['Invoke']);

  constructor(private readonly src: ProgressSource = {}) {}

  history(e: SpanEvent): AttemptFingerprint[] {
    const out = fromInput(e);
    if (this.src.history) {
      for (const h of this.src.history()) out.push({ ...h });
    } else if (this.src.fingerprintOf) {
      const n = this.src.attempt?.() ?? Math.max(1, ...out.map((h) => h.attempt));
      for (let a = 1; a <= n; a++) out.push({ attempt: a, fingerprint: this.src.fingerprintOf(a) ?? null });
    }
    return out;
  }

  handle(e: SpanEvent): Effect[] {
    if (e.span !== 'Invoke' || e.stage !== 'Enter') return [];
    const reason = noProgressReason(this.history(e));
    return reason ? [{ type: 'Abort', code: 'policy', reason }] : [];
  }

  describe(): HookDescriptor {
    return { id: this.id, mandatory: true, config: { rule: 'equal-candidate-fingerprint-across-worker-executions', source: this.src.history ? 'history+span-input' : this.src.fingerprintOf ? 'callback+span-input' : 'span-input' } };
  }
}
