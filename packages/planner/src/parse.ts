import { inertDepth, MAX_PLAN_DEPTH } from './hygiene.js';
import { HOST_STAMPED_KEYS, PlanDocumentSchema, formatZodIssues, isWireDocument, wireToDocument, type PlanDocument } from './schema.js';

/**
 * Model output is hostile text. These parsers never throw: they strip code fences, take the first
 * balanced top-level JSON object that actually parses, and zod-validate it. Anything else is an issue
 * list. Size is capped before any scanning.
 */

export const MAX_OUTPUT_CHARS = 200_000;
const MAX_CANDIDATES = 64;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };
export type PlanParseResult = { ok: true; plan: PlanDocument } | { ok: false; issues: string[] };

/** Remove markdown fence lines (``` or ```json) so the JSON inside is reachable. */
export function stripFences(raw: string): string {
  return raw.replace(/^[ \t]*```[A-Za-z0-9_-]*[ \t]*$/gm, '');
}

/** End index (exclusive) of the balanced `{...}` starting at `start`, or -1 when it never closes. String-aware. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** The first balanced top-level JSON object in `raw` that JSON.parse accepts. Never throws. */
export function extractFirstJsonObject(raw: unknown): ParseResult<Record<string, unknown>> {
  if (typeof raw !== 'string') return { ok: false, issues: ['model output is not a string'] };
  if (raw.length > MAX_OUTPUT_CHARS) return { ok: false, issues: [`model output exceeds ${MAX_OUTPUT_CHARS} characters`] };
  const text = stripFences(raw);
  let sawOpen = false;
  let sawUnclosed = false;
  let pos = 0;
  for (let n = 0; n < MAX_CANDIDATES; n++) {
    const start = text.indexOf('{', pos);
    if (start === -1) break;
    sawOpen = true;
    const end = balancedEnd(text, start);
    if (end === -1) {
      sawUnclosed = true;
      // An opener that looks like JSON (`{"` or `{}`) and never closes is truncated output: stop here
      // rather than mistake a nested object for the document. A stray `{` in prose is skipped.
      if (/^\{\s*["}]/.test(text.slice(start, start + 64))) break;
      pos = start + 1;
      continue;
    }
    try {
      const v: unknown = JSON.parse(text.slice(start, end));
      if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: v as Record<string, unknown> };
    } catch {
      // not JSON; try the next top-level candidate after this one
    }
    pos = end;
  }
  if (!sawOpen) return { ok: false, issues: ['no JSON object found in model output'] };
  if (sawUnclosed) return { ok: false, issues: ['JSON object never closes (output truncated?)'] };
  return { ok: false, issues: ['no parseable JSON object found in model output'] };
}

/**
 * Parse the planner's output into a plan document. Never throws. Accepts the wire format (what the
 * structured-output schema asks for: allowedModels as a list, inputs/output/equals as JSON text) and the
 * plan-document format; a wire document is converted first, and either way the result gets the full
 * PlanDocumentSchema validation, with nesting bounded before and after conversion.
 */
export function parsePlanOutput(raw: string): PlanParseResult {
  try {
    const obj = extractFirstJsonObject(raw);
    if (!obj.ok) return obj;
    // Bound nesting before anything (zod, the secret scan) walks the document: a deep value would otherwise
    // sit below what a structural scan inspects.
    const tooDeep = { ok: false as const, issues: [`plan document nests deeper than ${MAX_PLAN_DEPTH} levels; flatten inputs/output`] };
    if (inertDepth(obj.value, MAX_PLAN_DEPTH + 1) > MAX_PLAN_DEPTH) return tooDeep;
    const stamped = HOST_STAMPED_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(obj.value, k));
    const issues = stamped.map((k) => `${k}: is host-stamped; a plan document must not carry it (a reused or invented plan id is never honoured)`);
    let candidate: unknown = obj.value;
    if (isWireDocument(obj.value)) {
      if (issues.length) return { ok: false, issues };
      const w = wireToDocument(obj.value);
      if (!w.ok) return { ok: false, issues: w.issues };
      // JSON text fields can carry nesting the wire walk never saw: bound it again.
      if (inertDepth(w.doc, MAX_PLAN_DEPTH + 1) > MAX_PLAN_DEPTH) return tooDeep;
      candidate = w.doc;
    }
    const r = PlanDocumentSchema.safeParse(candidate);
    if (!r.success) return { ok: false, issues: [...issues, ...formatZodIssues(r.error)] };
    if (issues.length) return { ok: false, issues };
    return { ok: true, plan: r.data };
  } catch (err) {
    return { ok: false, issues: [`unparseable model output (${err instanceof Error ? err.name : 'error'})`] };
  }
}

export interface DeliberationChoice {
  planId: string;
  /**
   * The model's reason, decoded but UNREDACTED and UNTRUNCATED (bounded only by MAX_OUTPUT_CHARS). It is
   * model output: callers must redact it before they flatten or cut it (LLMPlanner uses safeLine), so a cut
   * can never leave part of a secret, raw or encoded, behind.
   */
  reason: string;
}

/** Parse `{"planId": "...", "reason": "..."}` and accept it only if planId is one of `ids`. Never throws. */
export function parseDeliberationOutput(raw: string, ids: readonly string[]): DeliberationChoice | null {
  try {
    const obj = extractFirstJsonObject(raw);
    if (!obj.ok) return null;
    const { planId, reason } = obj.value;
    if (typeof planId !== 'string' || !ids.includes(planId)) return null;
    return { planId, reason: typeof reason === 'string' ? reason : '' };
  } catch {
    return null;
  }
}
