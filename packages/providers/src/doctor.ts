import type { LLM, LLMRequest } from '@tecera/contracts';

/**
 * `tecera doctor` probe: one tiny completion per seat. Never throws; ok means the provider answered
 * with stop or length (a reply was produced and billed), anything else is not ok.
 */

export interface DoctorResult {
  ok: boolean;
  latencyMs: number;
  usd: number;
  model: string;
  finishReason: 'stop' | 'length' | 'error';
  error?: string;
  /** The provider could not report what the probe billed: `usd` is an upper bound or zero, not confirmed. */
  usageUnknown?: boolean;
}

export async function doctorProbe(llm: LLM, opts: { model?: string; signal?: AbortSignal; now?: () => number } = {}): Promise<DoctorResult> {
  const now = opts.now ?? (() => performance.now());
  const model = opts.model ?? llm.model ?? '';
  const req: LLMRequest = {
    seatId: 'doctor',
    model,
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    maxTokens: 512,
    effort: 'low',
  };
  const t0 = now();
  try {
    const r = await llm.complete(req, opts.signal);
    const latencyMs = Math.max(0, Math.round(now() - t0));
    const ok = r.finishReason === 'stop' || r.finishReason === 'length';
    const usageUnknown = (r.usage as { unknown?: unknown } | undefined)?.unknown === true;
    return {
      ok,
      latencyMs,
      usd: r.usage?.usd ?? 0,
      model: r.model || model,
      finishReason: r.finishReason,
      ...(ok ? {} : { error: r.error || r.content || 'provider error' }),
      ...(usageUnknown ? { usageUnknown: true } : {}),
    };
  } catch (err) {
    return { ok: false, latencyMs: Math.max(0, Math.round(now() - t0)), usd: 0, model, finishReason: 'error', error: `probe threw (${err instanceof Error ? err.name : 'unknown'})` };
  }
}
