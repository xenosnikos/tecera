import type { JsonObject, LLM, LLMRequest, LLMResponse, PoolUsage, TeceraEvent, Trace } from '@tecera/contracts';

/**
 * What a run cost, per run, per step and per model (dx.md: every task returns result, record and cost).
 *
 * Source of truth, both in the ledger:
 * - every model call of every seat (planner, workers, reviewer, frontier) is recorded as an
 *   `evidence.appended` {kind:'cost.call'} event when it returns: seat, provider, model, input/output tokens,
 *   usd as the provider adapter priced it, `unknown` when the provider could not report what it billed;
 *   worker and gate calls carry the step's trace (goal, intention, plan, step);
 * - the run's pools (Ledger.budgetUsage: cap, used = charged actuals + open reservations, enforce), which
 *   count what was RESERVED for calls whose usage was unknown or that were aborted in flight.
 *
 * The report is informational (D3: budgets are not enforced unless budgets.enforce is true). A cost record
 * that could not be written is counted (`unrecorded`) and the line says the report is incomplete; it never
 * fails the model call it describes.
 */

export const COST_KIND = 'cost.call';

export interface CostCall {
  seat: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  unknown: boolean;
}

export type CostSink = (c: CostCall, trace: Trace) => Promise<void>;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * The seat's LLM with every completed call reported to `sink` (after the call; the answer is returned
 * unchanged). Identity fields are read from the wrapped LLM unchanged. `trace` gives the step context.
 */
export function costRecordingLLM(llm: LLM, o: { seat: string; provider: string; sink: CostSink; trace?: () => Trace | undefined; onUnrecorded?: () => void }): LLM {
  const complete = async (req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> => {
    const res = await llm.complete(req, signal);
    const u = res?.usage as (LLMResponse['usage'] & { unknown?: boolean }) | undefined;
    if (u) {
      const call: CostCall = {
        seat: o.seat,
        // the manifest's provider name (openrouter, openai, …): what the operator configured and pays
        provider: o.provider,
        model: (typeof res.model === 'string' && res.model) || req.model || llm.model || 'unknown',
        inputTokens: num(u.inputTokens),
        outputTokens: num(u.outputTokens),
        usd: num(u.usd),
        unknown: u.unknown === true,
      };
      try {
        await o.sink(call, o.trace?.() ?? {});
      } catch {
        o.onUnrecorded?.();
      }
    }
    return res;
  };
  return new Proxy(llm, {
    get(target, prop) {
      if (prop === 'complete') return complete;
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

export interface CostRow {
  key: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  /** Calls whose billed usage the provider could not report (charged at their reservation in the pools). */
  unknown: number;
}

export interface CostReport {
  total: CostRow;
  bySeat: CostRow[];
  byModel: CostRow[];
  byStep: CostRow[];
  pools: PoolUsage[];
  /** budgets.enforce of the run (from its pools); undefined when no pool was opened. */
  enforce?: boolean;
}

const row = (key: string): CostRow => ({ key, calls: 0, inputTokens: 0, outputTokens: 0, usd: 0, unknown: 0 });
function add(r: CostRow, c: CostCall): void {
  r.calls++;
  r.inputTokens += c.inputTokens;
  r.outputTokens += c.outputTokens;
  r.usd = Math.round((r.usd + c.usd) * 1e9) / 1e9;
  if (c.unknown) r.unknown++;
}

/** The cost.call payloads of a run's events, with their traces. */
export function costCalls(events: Iterable<TeceraEvent>): Array<{ call: CostCall; trace: Trace }> {
  const out: Array<{ call: CostCall; trace: Trace }> = [];
  for (const e of events) {
    if (e.kind !== 'evidence.appended') continue;
    const p = e.payload as JsonObject;
    if (p.kind !== COST_KIND) continue;
    out.push({
      call: {
        seat: String(p.seat ?? '?'),
        provider: String(p.provider ?? '?'),
        model: String(p.model ?? '?'),
        inputTokens: num(p.inputTokens),
        outputTokens: num(p.outputTokens),
        usd: num(p.usd),
        unknown: p.unknown === true,
      },
      trace: e.trace,
    });
  }
  return out;
}

export function costReport(events: Iterable<TeceraEvent>, pools: PoolUsage[] = []): CostReport {
  const total = row('run');
  const seats = new Map<string, CostRow>();
  const models = new Map<string, CostRow>();
  const steps = new Map<string, CostRow>();
  const get = (m: Map<string, CostRow>, k: string): CostRow => {
    let r = m.get(k);
    if (!r) m.set(k, (r = row(k)));
    return r;
  };
  for (const { call, trace } of costCalls(events)) {
    add(total, call);
    add(get(seats, call.seat), call);
    add(get(models, `${call.provider}/${call.model}`), call);
    add(get(steps, trace.stepId ? `${trace.stepId}${trace.intentionId ? `@${trace.intentionId}` : ''}` : `(${call.seat})`), call);
  }
  const byUsd = (a: CostRow, b: CostRow): number => b.usd - a.usd || b.calls - a.calls || a.key.localeCompare(b.key);
  const enforce = pools.length ? pools.some((p) => p.enforce) : undefined;
  return { total, bySeat: [...seats.values()].sort(byUsd), byModel: [...models.values()].sort(byUsd), byStep: [...steps.values()].sort(byUsd), pools, ...(enforce !== undefined ? { enforce } : {}) };
}

const usd = (v: number): string => `$${v.toFixed(4)}`;
const tok = (n: number): string => n.toLocaleString('en-US');

/** One line for the end of `tecera run`. */
export function costLine(r: CostReport, unrecorded = 0): string {
  const t = r.total;
  const parts = [`${usd(t.usd)} · ${tok(t.inputTokens + t.outputTokens)} tokens · ${t.calls} model call(s)`];
  if (t.unknown) parts.push(`${t.unknown} with unknown usage (charged at reservation)`);
  const pool = r.pools.find((p) => p.pool === 'usd');
  if (pool) parts.push(`usd pool ${usd(pool.used)}/${usd(pool.cap)} incl. reservations${pool.enforce ? '' : ' (not enforced)'}`);
  if (r.byModel.length) parts.push(`by model: ${r.byModel.map((m) => `${m.key} ${usd(m.usd)}`).join(', ')}`);
  if (unrecorded) parts.push(`INCOMPLETE: ${unrecorded} call(s) could not be recorded`);
  return `cost       ${parts.join(' · ')}`;
}

/** The `## Cost` section of summary.md. */
export function costMarkdown(r: CostReport): string {
  const lines = ['## Cost', ''];
  const t = r.total;
  lines.push(`- run: ${usd(t.usd)} · ${tok(t.inputTokens)} in / ${tok(t.outputTokens)} out tokens · ${t.calls} model call(s)${t.unknown ? ` · ${t.unknown} with unknown usage (charged at reservation)` : ''}`);
  for (const p of r.pools) lines.push(`- pool ${p.pool}: used ${p.pool === 'usd' ? usd(p.used) : tok(p.used)} of ${p.pool === 'usd' ? usd(p.cap) : tok(p.cap)} (${p.reservations} reservation(s)${p.enforce ? ', enforced' : ', not enforced'})`);
  const table = (title: string, rows: CostRow[]): void => {
    lines.push('', `### ${title}`, '', '| | calls | tokens in | tokens out | usd |', '|---|---:|---:|---:|---:|');
    if (!rows.length) lines.push('| (none) | 0 | 0 | 0 | $0.0000 |');
    for (const x of rows) lines.push(`| ${x.key.replace(/\|/g, '\\|')} | ${x.calls}${x.unknown ? ` (${x.unknown} unknown)` : ''} | ${tok(x.inputTokens)} | ${tok(x.outputTokens)} | ${usd(x.usd)} |`);
  };
  table('Per step', r.byStep);
  table('Per model', r.byModel);
  table('Per seat', r.bySeat);
  return lines.join('\n');
}
