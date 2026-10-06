import type { Json, JsonObject, LLMMessage, LLMRequest, LLMResponse, LLMUsage } from '@tecera/contracts';
import { scanBudget, scanDecoded, scanJsonDeep, sanitizeDecodedJson, withheldMarker } from './decode.js';
import { DEFAULT_RETRY, type FetchLike, type RetryOptions } from './http.js';
import { firstInStrings, inertSnapshot, serializeInert, UnsafeBodyError } from './inert.js';
import { isEffort, type Effort } from './kinds.js';
import type { WarningSink } from './pricing.js';
import type { Redactor } from './redact.js';
import { redactorFor, SecretHandle } from './secrets.js';

/**
 * Shared provider plumbing. The rules, all fail closed:
 *
 * - `complete()` never throws. Every failure is an LLMResponse with finishReason 'error', `error` set
 *   to a sanitized message, `content` equal to `error`, and `raw = {error, status?, response?}`.
 * - Nothing derived from a credential leaves a provider. Every outgoing field (content, model, error,
 *   raw) and every onWarning message passes through the shared contracts redactor built from the
 *   SecretStore values (all provider keys, their auth header values, registered extras such as canaries)
 *   plus SECRET_PATTERNS. Redaction works on decoded values (never on serialized JSON).
 * - Output that carries a secret is refused, not repaired: finishReason 'error', error
 *   'secret-bearing output refused', no content.
 * - The outgoing request: the caller's request is read ONCE into a host-owned copy, message text is
 *   redacted, then the body is copied into an inert snapshot (accessors, toJSON hooks, Proxies, non-plain
 *   objects, cycles and nesting deeper than MAX_BODY_DEPTH are refused), serialized once, and that exact
 *   string is scanned (containsSecret on the bytes, plus every string and key through its decoded views).
 *   Any hit refuses the request before any HTTP call; otherwise those same bytes are sent.
 * - Output is checked on decoded views too: escape sequences, entities, percent/base64/hex encodings, and
 *   structured (schema or tool) results are parsed and scanned at every depth. A hit refuses the output;
 *   `raw` keeps no string whose decoded view carries a secret.
 * - If redaction itself fails (throws, returns a non-string), the result is a fixed failure that
 *   carries no provider text at all, but still carries the billed usage once the response was parsed.
 * - Usage is read from the body BEFORE its shape is validated, so a malformed answer keeps what it billed.
 *   Usage that is missing or invalid, attempts that may have been billed without a report (timeout,
 *   network failure or abort after dispatch, an unreadable 2xx body) and unpriced models yield usage
 *   flagged `unknown: true` with a conservative upper bound (ProviderUsage); never a confirmed zero.
 * - Decoded scans are complete or they are hits: an incomplete scan (decode.ts: too many decodable tokens,
 *   a view still decodable at the last layer, the work bound) is UNSCANNABLE and refuses/withholds.
 * - A pre-aborted signal sends nothing; an abort in flight returns at once (an 'aborted' error).
 */

/** Kept for compatibility: LLMRequest now carries `effort` itself. */
export type ProviderRequest = LLMRequest;

export interface ProviderOptions {
  /** Resolved credential. Only `authorize()` is used to send; the store it came from drives redaction. */
  auth: SecretHandle;
  /** Seat model, used when a request leaves `model` empty. */
  model: string;
  /** Seat effort, used when a request carries none. Default 'medium'. */
  effort?: Effort;
  /** Manifest provider name, used in `id`. Defaults to the kind. */
  name?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: RetryOptions['sleep'];
  random?: RetryOptions['random'];
  /** Default max output tokens when a request has none. Default 16000. */
  defaultMaxTokens?: number;
  /** Called (with sanitized text) for unpriced models and other non-fatal oddities. A throwing sink is ignored. */
  onWarning?: WarningSink;
  /**
   * An additional redactor (e.g. one built over values outside the store). Applied on top of the
   * store-derived redactor, never instead of it.
   */
  redactor?: Redactor;
}

export const SECRET_OUTPUT_REFUSED = 'secret-bearing output refused';
export const REDACTION_FAILED = 'provider output withheld: redaction failed';
const MAX_ERROR_CHARS = 2000;

export function retryOptions(o: ProviderOptions): RetryOptions {
  return {
    maxRetries: o.maxRetries ?? DEFAULT_RETRY.maxRetries,
    baseDelayMs: o.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs,
    maxDelayMs: o.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs,
    timeoutMs: o.timeoutMs ?? DEFAULT_RETRY.timeoutMs,
    ...(o.sleep ? { sleep: o.sleep } : {}),
    ...(o.random ? { random: o.random } : {}),
  };
}

/**
 * Every redactor a provider must apply: the store-derived one for its handle (resolved per call, so a
 * secret added to the store later is covered) plus the optional extra. Methods throw on any failure.
 */
export class Sanitizer {
  readonly #auth: SecretHandle;
  readonly #extra: Redactor | undefined;

  constructor(auth: SecretHandle, extra?: Redactor) {
    if (!(auth instanceof SecretHandle)) throw new TypeError('provider auth must be a SecretHandle');
    this.#auth = auth;
    this.#extra = extra;
    redactorFor(auth); // fail at construction if no redactor can be built
  }

  #list(): Redactor[] {
    return this.#extra ? [redactorFor(this.#auth), this.#extra] : [redactorFor(this.#auth)];
  }

  /** Redact a string with every redactor (no decoded check, no truncation). Throws on any failure. */
  redact(s: string): string {
    let out = String(s);
    for (const r of this.#list()) {
      const next = r.redactText(out);
      if (typeof next !== 'string') throw new TypeError('redactor returned a non-string');
      out = next;
    }
    return out;
  }

  /**
   * Redact a string; if a decoded view of the result still carries a secret, withhold the whole string;
   * THEN truncate (never before). Throws if any redactor fails or misbehaves.
   */
  text(s: string, maxChars?: number): string {
    let out = this.redact(s);
    const hit = this.scan(out);
    if (hit !== null) out = withheldMarker(hit);
    if (maxChars !== undefined && out.length > maxChars) out = `${out.slice(0, maxChars)}…[truncated:${out.length - maxChars}]`;
    return out;
  }

  /**
   * Redact every decoded string of a value, then withhold any string or key whose decoded views still carry
   * a secret. Throws if any redactor fails.
   */
  json(v: unknown): Json {
    let out: Json = null;
    let first = true;
    for (const r of this.#list()) {
      out = r.redactJson(first ? v : out);
      first = false;
    }
    return sanitizeDecodedJson(out, (t) => this.contains(t), scanBudget(0));
  }

  /** Kind of the first secret or pattern in `v`, or null. Throws if any redactor fails. */
  contains(v: unknown): string | null {
    for (const r of this.#list()) {
      const k = r.containsSecret(v);
      if (k !== null) return typeof k === 'string' ? k : 'secret';
    }
    return null;
  }

  /** Kind of the first secret in a string or any decoded view of it (UNSCANNABLE when unbounded), or null. */
  scan(s: string): string | null {
    return scanDecoded(s, (t) => this.contains(t), scanBudget(s.length));
  }

  /** Kind of the first secret in any string or key of a JSON-parsed value, at every depth, decoded. */
  scanDeep(v: unknown): string | null {
    return scanJsonDeep(v, (t) => this.contains(t), scanBudget(0));
  }
}

/** A warning sink that sanitizes every message and swallows sink errors. */
export function safeWarn(sink: WarningSink | undefined, san: Sanitizer): WarningSink | undefined {
  if (!sink) return undefined;
  return (message: string) => {
    let m: string;
    try {
      m = san.text(message, 500);
    } catch {
      m = 'provider warning withheld: redaction failed';
    }
    try {
      sink(m);
    } catch {
      /* a broken sink must not break the call */
    }
  };
}

export const ZERO_USAGE: LLMUsage = Object.freeze({ inputTokens: 0, outputTokens: 0, usd: 0 }) as LLMUsage;

/**
 * Usage as a provider returns it. `unknown: true` means the call may have been billed by an amount the
 * provider did not (validly) report: a malformed response, a response without usage, a timeout, network
 * failure or abort after dispatch, an unparseable 2xx body, or an unpriced model. The numbers are then a
 * conservative UPPER BOUND where one is known (every payload byte one input token plus overhead, the full
 * output allowance, priced at the dearest input rate), else zero; callers settle at least their
 * reservation (contracts chargeOf charges zero usd/tokens at the reservation). A usage WITHOUT `unknown`
 * is confirmed: either reported by the provider or zero because nothing was sent / nothing was billed
 * (the request was refused locally, or the provider answered with a non-2xx status).
 */
export type ProviderUsage = LLMUsage & { unknown?: true };

/** Upper bound on what one dispatched attempt can bill. */
export interface UsageBound {
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

/** Fixed allowance for provider-side prompt overhead (system scaffolding, structured-output tooling). */
export const INPUT_OVERHEAD_TOKENS = 4096;

/**
 * Upper bound for one attempt: byte-level tokenizers emit at most one token per payload byte (plus a
 * fixed overhead), output is capped by the request's output allowance, and the price is the cache-write
 * rate (the dearest input rate) of the dearest of the given models. Unpriced → usd 0.
 */
export function usageBound(models: readonly string[], payload: string, maxOutputTokens: number, price: (model: string, t: { inputTokens: number; outputTokens: number; cacheWriteTokens: number }) => number): UsageBound {
  const inputTokens = Buffer.byteLength(payload, 'utf8') + INPUT_OVERHEAD_TOKENS;
  const outputTokens = Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? Math.ceil(maxOutputTokens) : 128_000;
  let usd = 0;
  for (const m of models) {
    try {
      usd = Math.max(usd, price(m, { inputTokens: 0, cacheWriteTokens: inputTokens, outputTokens }));
    } catch {
      /* unpriced */
    }
  }
  return { inputTokens, outputTokens, usd };
}

/**
 * Final usage of a call: the reported usage (null when none was valid) plus `unreported` attempts that
 * may have been billed without a report, each charged at `bound`. Confirmed (no `unknown`) only when
 * every possibly-billed attempt reported a priced usage.
 */
export function settleUsage(reported: LLMUsage | null, unreported: number, bound: UsageBound | undefined): ProviderUsage {
  const base: ProviderUsage = reported ? { ...reported } : { ...ZERO_USAGE };
  const n = Number.isFinite(unreported) && unreported > 0 ? unreported : 0;
  const unpriced = !!reported && reported.usd === 0 && reported.inputTokens + reported.outputTokens > 0;
  if (n === 0 && !unpriced) return base;
  if (n > 0 && bound) {
    base.inputTokens += n * bound.inputTokens;
    base.outputTokens += n * bound.outputTokens;
    base.usd = Math.round((base.usd + n * bound.usd) * 1e9) / 1e9;
  }
  base.unknown = true;
  return base;
}

/**
 * The one error envelope: content === error === raw.error, all sanitized. `response` is the provider
 * body, which the caller must have sanitized already (pass `san.json(body)`).
 */
export function errorResponse(
  model: string,
  message: string,
  san: Sanitizer,
  extra: { usage?: LLMUsage; status?: number; response?: Json } = {},
): LLMResponse {
  let msg: string;
  let safeModel: string;
  try {
    msg = san.text(message, MAX_ERROR_CHARS);
    safeModel = san.text(model, 200);
  } catch {
    msg = REDACTION_FAILED;
    safeModel = '';
  }
  const raw: JsonObject = { error: msg };
  if (extra.status !== undefined) raw['status'] = extra.status;
  if (extra.response !== undefined) raw['response'] = extra.response;
  return { content: msg, usage: { ...(extra.usage ?? ZERO_USAGE) }, model: safeModel, finishReason: 'error', error: msg, raw };
}

/** A fixed failure carrying no provider-derived text at all (redaction could not run). */
export function redactionFailure(usage?: LLMUsage): LLMResponse {
  return { content: REDACTION_FAILED, usage: { ...(usage ?? ZERO_USAGE) }, model: '', finishReason: 'error', error: REDACTION_FAILED, raw: { error: REDACTION_FAILED } };
}

/**
 * The success path's last step: refuse when the content or the reported model carries a secret
 * (redaction would change it), otherwise return them with the sanitized raw body.
 */
export function finalize(
  out: { content: string; model: string; finishReason: 'stop' | 'length'; usage: LLMUsage; raw: Json; extraCheck?: unknown },
  san: Sanitizer,
): LLMResponse {
  try {
    const contentHit = san.redact(out.content) !== out.content || san.scan(out.content) !== null;
    const modelHit = san.redact(out.model) !== out.model || san.scan(out.model) !== null;
    const extraHit = out.extraCheck !== undefined && san.scanDeep(out.extraCheck) !== null;
    if (contentHit || modelHit || extraHit) return errorResponse(out.model, SECRET_OUTPUT_REFUSED, san, { usage: out.usage, response: out.raw });
    return { content: out.content, usage: out.usage, model: out.model, finishReason: out.finishReason, raw: out.raw };
  } catch {
    return redactionFailure(out.usage);
  }
}

export type Turn = { role: 'user' | 'assistant'; content: string };

/**
 * Read the caller's request exactly once into a host-owned copy (each field, each message role and content
 * read once), so a getter on the request cannot hand the scan one value and the sender another. Returns a
 * reason string when the request cannot be read.
 */
export function readRequest(req: LLMRequest): LLMRequest | string {
  try {
    if (!req || typeof req !== 'object') return 'request is not an object';
    const { seatId, model, messages, schema, maxTokens, temperature, effort } = req;
    if (!Array.isArray(messages)) return 'request has no messages array';
    const msgs: LLMMessage[] = [];
    const n = messages.length;
    for (let i = 0; i < n; i++) {
      const m: unknown = messages[i];
      if (!m || typeof m !== 'object') return 'message must be an object';
      const { role, content } = m as LLMMessage;
      msgs.push({ role, content });
    }
    const out: LLMRequest = { seatId, model, messages: msgs };
    if (schema !== undefined) out.schema = schema;
    if (maxTokens !== undefined) out.maxTokens = maxTokens;
    if (temperature !== undefined) out.temperature = temperature;
    if (effort !== undefined) out.effort = effort;
    return out;
  } catch {
    return 'request could not be read';
  }
}

/**
 * Validate and split the request: system messages joined by blank lines, the rest in order, every
 * message text redacted. Returns a reason string instead when the request is malformed.
 */
export function splitSystem(req: LLMRequest, redact: (t: string) => string): { system: string | undefined; turns: Turn[] } | string {
  if (!req || typeof req !== 'object' || !Array.isArray(req.messages)) return 'request has no messages array';
  const sys: string[] = [];
  const turns: Turn[] = [];
  for (const m of req.messages) {
    if (!m || typeof m.content !== 'string') return 'message content must be a string';
    if (m.role === 'system') sys.push(redact(m.content));
    else if (m.role === 'user' || m.role === 'assistant') turns.push({ role: m.role, content: redact(m.content) });
    else return 'message role must be system, user or assistant';
  }
  if (!turns.some((t) => t.role === 'user')) return 'request has no user message';
  return { system: sys.length ? sys.join('\n\n') : undefined, turns };
}

/** Resolve the per-call effort over the seat default; null when the value is not a known effort. */
export function resolveEffort(req: LLMRequest, seat: Effort | undefined): Effort | null {
  const e = req.effort ?? seat ?? 'medium';
  return isEffort(e) ? e : null;
}

export function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function defaultFetch(): FetchLike {
  return (input, init) => globalThis.fetch(input, init);
}

/** `payload` is the exact request body text: the bytes that were scanned are the bytes that are sent. */
export type Prepared = { ok: true; payload: string; body: Json } | { ok: false; reason: string };

/**
 * Build the outgoing body, copy it into an inert snapshot, serialize it once, and scan that exact text
 * (all redactors on the bytes, then every string and key through its decoded views). Message text has
 * already been redacted while building; anything still secret-bearing (a schema description, enum,
 * default, the model name, an escaped or encoded form...) refuses the request. A failing redactor, an
 * accessor, a toJSON hook, a Proxy, a cycle or excessive nesting refuses too.
 */
export function prepareBody(build: (redact: (t: string) => string) => JsonObject | string, san: Sanitizer): Prepared {
  let body: JsonObject | string;
  try {
    body = build((t) => san.redact(t));
  } catch {
    return { ok: false, reason: 'request refused: redaction failed' };
  }
  if (typeof body === 'string') return { ok: false, reason: body };
  let snapshot: Json;
  let payload: string;
  try {
    snapshot = inertSnapshot(body);
    payload = serializeInert(snapshot);
  } catch (err) {
    if (err instanceof UnsafeBodyError) return { ok: false, reason: `request refused: ${err.message}` };
    return { ok: false, reason: 'request refused: outgoing body could not be serialized' };
  }
  let hit: string | null;
  try {
    // The exact bytes (every redactor's needles and patterns), then every string and key of the snapshot
    // through its decoded views (escapes, entities, base64/hex/percent), at every depth.
    hit = san.contains(payload) ?? firstInStrings(snapshot, (t) => san.scan(t));
  } catch {
    return { ok: false, reason: 'request refused: outgoing body could not be scanned' };
  }
  if (hit !== null) return { ok: false, reason: `request refused: outgoing request contains a secret (${hit})` };
  return { ok: true, payload, body: snapshot };
}

/** Parse structured output text once; undefined when it is not JSON. */
export function parseStructured(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}
