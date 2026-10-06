import {
  makeRedactor,
  type AchievementGoal,
  type Belief,
  type BeliefProjection,
  type Intention,
  type LLM,
  type LLMEffort,
  type LLMMessage,
  type LLMResponse,
  type LLMUsage,
  type Manifest,
  type Plan,
  type Planner,
  type Redactor,
  type SecretInput,
  type TeceraEvent,
  type UsageMeter,
} from '@tecera/contracts';
import { DEFAULT_PERMISSIONS, type PermissionsDoc } from '@tecera/policy';
import { materializeBudget } from './budget.js';
import { DEFAULT_TOOL_CATALOG, sanitizeDiagnostics, validateCandidate } from './checks.js';
import { decodedSecretKind, inertRedacted } from './hygiene.js';
import { parseDeliberationOutput, parsePlanOutput } from './parse.js';
import { buildDeliberationPrompt, buildPlannerPrompt, buildRepairMessage, echoAssistant, type PromptNote, type PromptSeat } from './prompt.js';
import { newNonce, safeLine } from './render.js';
import { PLAN_WIRE_JSON_SCHEMA, toPlan } from './schema.js';

/**
 * The planner seat. write(): prompt → one completion → parse → effective budget materialisation → shape +
 * policy + planner checks + goal ceilings + secret scan; on any issue exactly one repair round that feeds
 * the (sanitised) issues back; still invalid → PlanRejected {issues, plan?}. The returned plan is a
 * candidate (origin 'generated', status 'candidate', host-stamped id and trigger, every budget field set)
 * that the loop validates again and stages.
 *
 * deliberate(): choose by plan id; a provider (transport) failure, a non-'stop' (e.g. truncated) answer or
 * an unparseable one falls back to the first option, and a truncated answer's text is never used.
 *
 * Structured output: the request carries PLAN_WIRE_JSON_SCHEMA (closed, all-required, valid for OpenAI
 * strict json_schema and Anthropic output_config.format); the answer is converted back to a plan document
 * and fully validated (parsePlanOutput). The plan-document format is accepted too (scripted doubles).
 *
 * Accounting is never a fallback. Every completion's usage is recorded on the loop's UsageMeter (when the
 * loop passes one) and reported through an awaited onUsage before anything else happens; a failing or
 * missing settlement throws PlannerAccountingError. A response without valid usage, and a call that threw
 * after it may have been billed, are recorded as malformed usage so the loop charges the full reservation.
 * Usage a provider flags `unknown` is recorded with the flag (zero amounts are charged at the reservation)
 * and reported to onUsage with `unknown: true`; without a meter it refuses to continue (PlannerAccountingError).
 * A budget failure (code 'budget' anywhere in the cause chain, from onUsage, the meter or the LLM port)
 * becomes a PlannerAccountingError with code 'budget', which the loop treats as budget exhaustion.
 *
 * Cancellation: every call gets the options' signal combined with the meter's (run deadline, lease loss,
 * loop stop). Aborted before a call → nothing is sent; aborted during one → its usage is recorded, then
 * PlannerCancelled is thrown: never a repair round, a deliberation fallback or a returned plan.
 *
 * Secret hygiene: one contracts redactor (built from `secrets`; a secret shorter than 8 chars throws at
 * construction) covers prompts, repair diagnostics, issues, rejected plans, error messages, usage records
 * and deliberation records. Text is always redacted and decoded-checked BEFORE it is flattened or cut. A
 * candidate carrying a secret-shaped string at any depth or in any decoded form is rejected, never returned.
 */

export class PlanRejected extends Error {
  constructor(
    /** Sanitised issues (redacted, single-line, bounded). The loop emits them in plan.rejected. */
    public readonly issues: readonly string[],
    /** The last candidate that parsed, redacted, if any (for the plan.rejected event); id is the host-stamped one. */
    public readonly plan?: Plan,
    public readonly attempts: number = 2,
  ) {
    super(`planner output rejected after ${attempts} attempt(s): ${issues.length} issue(s)${issues.length ? `\n- ${issues.slice(0, 20).join('\n- ')}` : ''}`);
    this.name = 'PlanRejected';
  }
}

/** The provider failed (transport/HTTP). The message is redacted; the raw error is not kept. */
export class PlannerProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlannerProviderError';
  }
}

/**
 * Usage settlement or decision recording failed, or a response carried no valid usage. Never a fallback.
 * `code` is 'budget' when the underlying failure was budget exhaustion (the loop's isBudgetError reads it).
 */
export class PlannerAccountingError extends Error {
  readonly code?: 'budget';
  constructor(
    message: string,
    public readonly sink: 'usage' | 'deliberation',
    budget = false,
  ) {
    super(message);
    this.name = 'PlannerAccountingError';
    if (budget) this.code = 'budget';
  }
}

/**
 * The call was cancelled: the options' signal or the loop meter's signal (run deadline, lease loss, loop
 * stop) aborted. Never a deliberation fallback, never a plan rejection. Usage of any call already made has
 * been recorded before this is thrown.
 */
export class PlannerCancelled extends Error {
  readonly code = 'cancelled';
  constructor(reason: string) {
    super(`planner call cancelled: ${reason}`);
    this.name = 'PlannerCancelled';
  }
}

/** True when `err` (or its cause chain) is a budget failure: code 'budget', BudgetExhausted, or its message. */
export function isBudgetFailure(err: unknown): boolean {
  let e: unknown = err;
  for (let d = 0; e && typeof e === 'object' && d < 6; d++) {
    try {
      const x = e as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
      if (x.code === 'budget' || x.name === 'BudgetExhausted') return true;
      if (typeof x.message === 'string' && /budget (exceeded|exhausted)|no budget opened|deadline exceeded/i.test(x.message)) return true;
      e = x.cause;
    } catch {
      return false;
    }
  }
  return false;
}

/** Recorded on the meter when real usage is unknown: the loop charges the full reservation for it. */
const UNKNOWN_USAGE: LLMUsage = Object.freeze({ inputTokens: Number.NaN, outputTokens: Number.NaN, usd: Number.NaN }) as LLMUsage;

export type PlannerCallPurpose = 'write' | 'repair' | 'deliberate';

export interface PlannerUsage {
  seatId: string;
  model: string;
  purpose: PlannerCallPurpose;
  usage: LLMUsage;
  finishReason: LLMResponse['finishReason'];
  /**
   * True when the provider flagged the usage unknown (the call may have been billed by an amount it did
   * not report): `usage` is then an upper bound or zero, and must be settled at least at the reservation.
   */
  unknown?: boolean;
}

export interface DeliberationRecord {
  planId: string;
  /** Sanitised one-line reason (redacted, bounded); never a raw provider error. */
  reason: string;
  /** True when the model's answer was unusable and the first option was taken. */
  fallback: boolean;
}

type NotesSource = readonly PromptNote[] | ((goal: AchievementGoal, e: TeceraEvent) => readonly PromptNote[] | Promise<readonly PromptNote[]>);

export interface LLMPlannerOptions {
  llm: LLM;
  manifest: Manifest;
  permissions?: PermissionsDoc;
  toolCatalog?: readonly string[];
  /** Seat id sent on every request. Default 'planner'. */
  seatId?: string;
  /** Model id. Default manifest.seats.planner.model. */
  model?: string;
  /** Reasoning effort. Default manifest.seats.planner.effort when it is low/medium/high. */
  effort?: LLMEffort;
  maxTokens?: number;
  temperature?: number;
  /** Worker seats shown to the model and allowed in allowedModels (intersected with the manifest). Default manifest.seats.workers. */
  seats?: readonly PromptSeat[];
  lessons?: NotesSource;
  skills?: NotesSource;
  /** Exact secret values to redact (>= 8 chars each, else the constructor throws RedactionError). */
  secrets?: readonly SecretInput[];
  /** A prepared redactor (overrides `secrets`). */
  redactor?: Redactor;
  /** Awaited after every completion (write, repair, deliberate). A throw/rejection aborts the call. */
  onUsage?: (u: PlannerUsage) => void | Promise<void>;
  /** Awaited for every deliberation decision. A throw/rejection aborts the call. */
  onDeliberation?: (d: DeliberationRecord) => void | Promise<void>;
  signal?: AbortSignal;
  /** Envelope nonce generator (tests). */
  nonce?: () => string;
}

type Attempt = { ok: true; plan: Plan } | { ok: false; issues: string[]; plan?: Plan };

const EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high']);
const MODEL_ID_RE = /^[A-Za-z0-9._:/@-]{1,128}$/;
const FINISH: ReadonlySet<string> = new Set(['stop', 'length', 'error']);

function liveBeliefs(b: BeliefProjection): Belief[] {
  try {
    const all = b.all();
    return Array.isArray(all) ? all : [];
  } catch {
    return [];
  }
}

const finiteNonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Copy only the numeric usage fields; null when the provider gave no valid usage. */
function cleanUsage(u: unknown): LLMUsage | null {
  if (!u || typeof u !== 'object') return null;
  const x = u as Record<string, unknown>;
  if (!finiteNonNeg(x.inputTokens) || !finiteNonNeg(x.outputTokens) || !finiteNonNeg(x.usd)) return null;
  const out: LLMUsage = { inputTokens: x.inputTokens, outputTokens: x.outputTokens, usd: x.usd };
  if (finiteNonNeg(x.cacheReadTokens)) out.cacheReadTokens = x.cacheReadTokens;
  if (finiteNonNeg(x.cacheWriteTokens)) out.cacheWriteTokens = x.cacheWriteTokens;
  return out;
}

export class LLMPlanner implements Planner {
  private readonly seatId: string;
  private readonly model: string;
  private readonly effort: LLMEffort | undefined;
  private readonly redactor: Redactor;
  private readonly workerSeats: string[];

  constructor(private readonly o: LLMPlannerOptions) {
    // Fail closed at construction: a short or malformed secret throws RedactionError here, not mid-run.
    this.redactor = o.redactor ?? makeRedactor(o.secrets ?? []);
    this.seatId = o.seatId ?? 'planner';
    this.model = o.model ?? o.manifest.seats.planner.model;
    const eff = o.effort ?? (o.manifest.seats.planner as { effort?: unknown }).effort;
    this.effort = typeof eff === 'string' && EFFORTS.has(eff) ? (eff as LLMEffort) : undefined;
    const manifestSeats = o.manifest.seats.workers.map((w) => w.id);
    this.workerSeats = o.seats ? manifestSeats.filter((s) => o.seats!.some((x) => x.id === s)) : manifestSeats;
  }

  async write(e: TeceraEvent, beliefs: BeliefProjection, goal: AchievementGoal, meter?: UsageMeter): Promise<Plan> {
    const nonce = this.o.nonce?.() ?? newNonce();
    const [lessons, skills] = await Promise.all([this.notes(this.o.lessons, goal, e), this.notes(this.o.skills, goal, e)]);
    const messages = buildPlannerPrompt({
      manifest: this.o.manifest,
      goal,
      event: e,
      beliefs: liveBeliefs(beliefs),
      seats: this.o.seats,
      lessons,
      skills,
      permissions: this.o.permissions,
      toolCatalog: this.o.toolCatalog,
      redactor: this.redactor,
      nonce,
    });

    const first = await this.complete(messages, 'write', meter);
    const a1 = this.evaluate(first, e, goal);
    if (a1.ok) return a1.plan;
    this.throwIfCancelled(meter);

    const repair: LLMMessage[] = [
      ...messages,
      echoAssistant(first?.content, { redactor: this.redactor, nonce }),
      buildRepairMessage(a1.issues, { redactor: this.redactor, nonce }),
    ];
    const second = await this.complete(repair, 'repair', meter);
    let a2 = this.evaluate(second, e, goal);
    // Validation is deterministic, so the same id fails the same way; say so first in the diagnostics.
    if (a2.ok) return a2.plan;
    if (a1.plan && a2.plan && a1.plan.id === a2.plan.id) a2 = { ...a2, issues: [`repair round returned the rejected plan ${a1.plan.id} unchanged`, ...a2.issues] };
    const last = a2.plan ?? a1.plan;
    throw new PlanRejected(this.sanitizeIssues(a2.issues), last ? this.redactPlan(last) : undefined, 2);
  }

  async deliberate(options: Plan[], intentions: Intention[], beliefs: BeliefProjection, meter?: UsageMeter): Promise<Plan> {
    const first = options[0];
    if (!first) throw new Error('deliberate called with no options');
    if (options.length === 1) return first;
    const pick = async (planId: string, reason: string, fallback: boolean): Promise<Plan> => {
      const chosen = options.find((p) => p.id === planId) ?? first;
      // The model's reason is redacted and decoded-checked over its WHOLE length, then flattened, and only
      // then cut to 300 characters: a cut never leaves part of a raw or encoded secret behind.
      await this.record({ planId: chosen.id, reason: safeLine(reason, this.redactor, '', 300, true), fallback });
      return chosen;
    };
    const messages = buildDeliberationPrompt({ options, intentions, beliefs: liveBeliefs(beliefs), redactor: this.redactor, nonce: this.o.nonce?.() });
    let res: LLMResponse;
    try {
      res = await this.call(messages, 'deliberate', meter);
    } catch (err) {
      if (err instanceof PlannerAccountingError || err instanceof PlannerCancelled) throw err;
      this.throwIfCancelled(meter);
      // Transport failure only: the reason never carries the provider's message.
      return pick(first.id, `fallback: provider error (${err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'Error'})`, true);
    }
    await this.settle(res, 'deliberate', meter);
    // A cancelled call's answer (usually an 'aborted' error) is never a fallback choice.
    this.throwIfCancelled(meter);
    if (res.finishReason === 'length') return pick(first.id, 'fallback: truncated deliberation output (never used)', true);
    const choice = res.finishReason !== 'stop' || typeof res.content !== 'string' ? null : parseDeliberationOutput(res.content, options.map((p) => p.id));
    if (!choice) return pick(first.id, 'fallback: unparseable deliberation output', true);
    return pick(choice.planId, choice.reason, false);
  }

  // ---------- internals ----------

  private async notes(src: NotesSource | undefined, goal: AchievementGoal, e: TeceraEvent): Promise<readonly PromptNote[]> {
    if (!src) return [];
    return typeof src === 'function' ? await src(goal, e) : src;
  }

  private async record(d: DeliberationRecord): Promise<void> {
    if (!this.o.onDeliberation) return;
    try {
      await this.o.onDeliberation(d);
    } catch (err) {
      throw new PlannerAccountingError(`deliberation record failed: ${this.errText(err)}`, 'deliberation', isBudgetFailure(err));
    }
  }

  /** Record usage on the loop's meter. A throwing meter is an accounting failure, never ignored. */
  private meterRecord(meter: UsageMeter | undefined, usage: LLMUsage, purpose: PlannerCallPurpose): void {
    if (!meter) return;
    try {
      meter.record(usage);
    } catch (err) {
      throw new PlannerAccountingError(`usage meter failed (${purpose}): ${this.errText(err)}`, 'usage', isBudgetFailure(err));
    }
  }

  /**
   * One provider call. Errors become PlannerProviderError with a redacted message, except a budget failure,
   * which becomes PlannerAccountingError {code:'budget'} so it is never mistaken for a transport fallback. A
   * call that threw may still have been billed: it is recorded as unknown usage (charged at the reservation).
   */
  private async call(messages: LLMMessage[], purpose: PlannerCallPurpose, meter?: UsageMeter): Promise<LLMResponse> {
    // Cancelled before the call: nothing is sent and nothing is billed.
    this.throwIfCancelled(meter);
    const signal = this.signalFor(meter);
    try {
      const res = await this.o.llm.complete(
        {
          seatId: this.seatId,
          model: this.model,
          messages,
          maxTokens: this.o.maxTokens ?? 4096,
          temperature: this.o.temperature ?? 0,
          ...(this.effort ? { effort: this.effort } : {}),
          ...(purpose === 'deliberate' ? {} : { schema: PLAN_WIRE_JSON_SCHEMA }),
        },
        signal,
      );
      if (!res || typeof res !== 'object') throw new PlannerProviderError('provider returned no response');
      return res;
    } catch (err) {
      this.meterRecord(meter, UNKNOWN_USAGE, purpose);
      if (isBudgetFailure(err)) throw new PlannerAccountingError(`planner ${purpose} call refused: budget exhausted`, 'usage', true);
      this.throwIfCancelled(meter);
      if (err instanceof PlannerProviderError) throw err;
      throw new PlannerProviderError(`planner provider call failed (${purpose}): ${this.errText(err)}`);
    }
  }

  /** The signal every call gets: the options' signal and the loop meter's (deadline, lease loss, stop). */
  private signalFor(meter?: UsageMeter): AbortSignal | undefined {
    let ms: AbortSignal | undefined;
    try {
      ms = meter?.signal;
    } catch {
      ms = undefined;
    }
    const all = [this.o.signal, ms].filter((x): x is AbortSignal => x instanceof AbortSignal);
    return all.length === 0 ? undefined : all.length === 1 ? all[0] : AbortSignal.any(all);
  }

  private throwIfCancelled(meter?: UsageMeter): void {
    const sig = this.signalFor(meter);
    if (!sig?.aborted) return;
    const r: unknown = sig.reason;
    throw new PlannerCancelled(r instanceof Error ? this.errText(r) : typeof r === 'string' ? safeLine(r, this.redactor, '', 200) : 'aborted');
  }

  /** Record usage on the meter, report it and wait for settlement. Missing/invalid usage or a failing sink throws. */
  private async settle(res: LLMResponse, purpose: PlannerCallPurpose, meter?: UsageMeter): Promise<void> {
    const usage = cleanUsage(res.usage);
    if (!usage) {
      this.meterRecord(meter, UNKNOWN_USAGE, purpose);
      throw new PlannerAccountingError(`provider response for ${purpose} carried no valid usage; refusing to continue unaccounted`, 'usage');
    }
    // Usage the provider flagged unknown (a malformed answer, a timeout or abort after dispatch, an
    // unpriced model) is never settled as confirmed: its numbers are an upper bound or zero, and the
    // loop's meter charges zero amounts at the reservation. Without a meter nothing can settle it
    // conservatively, so the planner refuses to continue.
    const unknown = (res.usage as { unknown?: unknown } | undefined)?.unknown === true;
    if (unknown && !meter) throw new PlannerAccountingError(`provider usage for ${purpose} is unknown and no usage meter can settle it conservatively; refusing to continue unaccounted`, 'usage');
    // The flag travels with the recorded usage so the meter (contracts chargeOf) never reads it as confirmed.
    this.meterRecord(meter, unknown ? ({ ...usage, unknown: true } as LLMUsage) : usage, purpose);
    if (!this.o.onUsage) return;
    const model = typeof res.model === 'string' && MODEL_ID_RE.test(res.model) && decodedSecretKind(res.model, this.redactor) === null ? res.model : this.model;
    const finishReason = (FINISH.has(res.finishReason as string) ? res.finishReason : 'error') as LLMResponse['finishReason'];
    try {
      await this.o.onUsage({ seatId: this.seatId, model, purpose, usage, finishReason, ...(unknown ? { unknown: true } : {}) });
    } catch (err) {
      throw new PlannerAccountingError(`usage settlement failed (${purpose}): ${this.errText(err)}`, 'usage', isBudgetFailure(err));
    }
  }

  private async complete(messages: LLMMessage[], purpose: PlannerCallPurpose, meter?: UsageMeter): Promise<LLMResponse> {
    const res = await this.call(messages, purpose, meter);
    await this.settle(res, purpose, meter);
    // A cancelled call's answer is never evaluated or repaired.
    this.throwIfCancelled(meter);
    return res;
  }

  private errText(err: unknown): string {
    const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : 'non-error thrown';
    return safeLine(raw, this.redactor, '', 300);
  }

  private sanitizeIssues(issues: readonly string[]): string[] {
    return sanitizeDiagnostics(issues, this.redactor);
  }

  /** The rejected plan for plan.rejected: redacted, decoded-checked (withheld strings), inert. */
  private redactPlan(p: Plan): Plan {
    return inertRedacted(p, this.redactor) as unknown as Plan;
  }

  private evaluate(res: LLMResponse, e: TeceraEvent, goal: AchievementGoal): Attempt {
    if (typeof res.content !== 'string') return { ok: false, issues: ['model returned no content'] };
    if (res.finishReason === 'error') {
      const why = typeof res.error === 'string' && res.error ? `: ${safeLine(res.error, this.redactor, '', 200)}` : '';
      return { ok: false, issues: [`model returned an error instead of a plan${why}`] };
    }
    const parsed = parsePlanOutput(res.content);
    if (!parsed.ok) {
      const issues = res.finishReason === 'length' ? ['output hit the token limit (truncated)', ...parsed.issues] : parsed.issues;
      return { ok: false, issues: this.sanitizeIssues(issues) };
    }
    const { budget, issues: budgetIssues } = materializeBudget(parsed.plan.budget, this.o.manifest, goal);
    const plan = toPlan(parsed.plan, { trigger: { kind: e.kind }, origin: 'generated', status: 'candidate', budget });
    const issues = [
      ...budgetIssues,
      ...validateCandidate(plan, {
        manifest: this.o.manifest,
        goal,
        permissions: this.o.permissions ?? DEFAULT_PERMISSIONS,
        toolCatalog: this.o.toolCatalog ?? DEFAULT_TOOL_CATALOG,
        workerSeats: this.workerSeats,
        redactor: this.redactor,
        requireCompleteBudget: true,
      }),
    ];
    if (res.finishReason === 'length') issues.push('output hit the token limit (truncated); a truncated answer is never used');
    const clean = this.sanitizeIssues(issues);
    return clean.length ? { ok: false, issues: clean, plan } : { ok: true, plan };
  }
}

