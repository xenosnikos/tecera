import { z } from 'zod';
import { digest, normalizeJson, type BeliefPattern, type EventPattern, type Json, type JsonObject, type Plan, type PlanOrigin, type PlanStatus } from '@tecera/contracts';

/**
 * The plan document the planner seat must emit: exactly this shape and nothing more. Every object is
 * strict (unknown keys are rejected), every list and string is bounded, lists of names are duplicate-free.
 * The model never chooses the plan id, origin, status or trigger: the host stamps those (`toPlan`). A plan
 * document that parses is still only a candidate; authority checks run afterwards (contracts shape +
 * policy + planner checks + effective budget materialisation).
 */

/** The step kinds a plan document may use: the contracts StepKind set (D6 added gate.pr). */
export const STEP_KINDS = ['worker', 'gate.verify', 'gate.review', 'gate.commit', 'gate.pr', 'subgoal'] as const;
export const MAX_STEPS = 12;
/** Keys the host stamps; a document that carries any of them is rejected with a specific issue. */
export const HOST_STAMPED_KEYS = ['id', 'trigger', 'origin', 'status'] as const;
const STEP_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;
/** Glob characters only: no spaces, quotes, angle brackets or control characters can reach a diagnostic. */
const GLOB_RE = /^[A-Za-z0-9_.*?/{}[\],!@+=-]{1,256}$/;
const SEAT_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

const jsonValue: z.ZodType<Json> = z.lazy(() =>
  z.union([z.string().max(8000), z.number().finite(), z.boolean(), z.null(), z.array(jsonValue).max(256), z.record(jsonValue)]),
);
const jsonObject = z.record(jsonValue) as z.ZodType<JsonObject>;

const unique = <T extends z.ZodTypeAny>(arr: z.ZodArray<T>, what: string) =>
  arr.refine((xs: unknown[]) => new Set(xs.map((x) => JSON.stringify(x))).size === xs.length, { message: `${what} must not contain duplicates` });

const stepId = z.string().regex(STEP_ID_RE, 'step ids are 1-32 chars: a letter, then letters, digits, _ or -');
const toolName = z.string().regex(NAME_RE, 'tool names are identifiers');

export const StepDocSchema = z
  .object({
    id: stepId,
    kind: z.enum(STEP_KINDS),
    dependsOn: unique(z.array(stepId).max(MAX_STEPS), 'dependsOn'),
    instruction: z.string().min(1).max(4000).optional(),
    inputs: jsonObject.default({}),
    output: jsonObject.optional(),
    /** Per-step narrowing of permissions.tools (worker steps only). Absent = the plan's tools. */
    tools: unique(z.array(toolName).max(32), 'tools').optional(),
  })
  .strict();

const posNum = z.number().finite().positive();
const posInt = z.number().int().positive();

export const BudgetDocSchema = z
  .object({
    usd: posNum.optional(),
    tokens: posInt.optional(),
    wallClockSec: posInt.optional(),
    maxDepth: posInt.optional(),
    maxIterations: posInt.optional(),
    maxAttempts: posInt.optional(),
    maxChangedFiles: posInt.optional(),
  })
  .strict();

export const PermissionsDocSchema = z
  .object({
    tools: unique(z.array(toolName).max(32), 'permissions.tools'),
    write: unique(z.array(z.string().regex(GLOB_RE, 'write globs use path/glob characters only')).max(32), 'permissions.write'),
    approvals: unique(z.array(z.string().regex(NAME_RE, 'approval names are identifiers')).max(16), 'permissions.approvals'),
  })
  .strict();

export const BeliefPatternDocSchema = z
  .object({ key: z.string().min(1).max(200), equals: jsonValue.optional(), exists: z.boolean().optional() })
  .strict();

export const PlanDocumentSchema = z
  .object({
    steps: z.array(StepDocSchema).min(1).max(MAX_STEPS),
    allowedModels: z.record(stepId, unique(z.array(z.string().regex(SEAT_RE, 'seat ids are identifiers')).max(8), 'allowedModels entries')),
    permissions: PermissionsDocSchema,
    budget: BudgetDocSchema,
    goalKinds: unique(z.array(z.string().regex(NAME_RE, 'goal kinds are identifiers')).min(1).max(8), 'goalKinds'),
    rationale: z.string().min(1).max(2000),
    context: z.array(BeliefPatternDocSchema).max(16).default([]),
  })
  .strict();

export type PlanDocument = z.output<typeof PlanDocumentSchema>;
export type PlanDocumentInput = z.input<typeof PlanDocumentSchema>;

// ---------- JSON schema (for providers with structured output, and for the prompt) ----------

const str = (extra: JsonObject = {}): JsonObject => ({ type: 'string', ...extra });
const anyJsonObject: JsonObject = { type: 'object' };
const nameList = (max: number, pattern: string): JsonObject => ({ type: 'array', maxItems: max, uniqueItems: true, items: str({ pattern }) });

export const PLAN_DOCUMENT_JSON_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'TeceraPlanDocument',
  type: 'object',
  additionalProperties: false,
  required: ['steps', 'allowedModels', 'permissions', 'budget', 'goalKinds', 'rationale'],
  properties: {
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_STEPS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind', 'dependsOn'],
        properties: {
          id: str({ pattern: STEP_ID_RE.source }),
          kind: { type: 'string', enum: [...STEP_KINDS] },
          dependsOn: nameList(MAX_STEPS, STEP_ID_RE.source),
          instruction: str({ minLength: 1, maxLength: 4000 }),
          inputs: anyJsonObject,
          output: anyJsonObject,
          tools: nameList(32, NAME_RE.source),
        },
      },
    },
    allowedModels: {
      type: 'object',
      propertyNames: { pattern: STEP_ID_RE.source },
      additionalProperties: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: str({ pattern: SEAT_RE.source }) },
    },
    permissions: {
      type: 'object',
      additionalProperties: false,
      required: ['tools', 'write', 'approvals'],
      properties: {
        tools: nameList(32, NAME_RE.source),
        write: nameList(32, GLOB_RE.source),
        approvals: nameList(16, NAME_RE.source),
      },
    },
    budget: {
      type: 'object',
      additionalProperties: false,
      properties: {
        usd: { type: 'number', exclusiveMinimum: 0 },
        tokens: { type: 'integer', minimum: 1 },
        wallClockSec: { type: 'integer', minimum: 1 },
        maxDepth: { type: 'integer', minimum: 1 },
        maxIterations: { type: 'integer', minimum: 1 },
        maxAttempts: { type: 'integer', minimum: 1 },
        maxChangedFiles: { type: 'integer', minimum: 1 },
      },
    },
    goalKinds: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: str({ pattern: NAME_RE.source }) },
    rationale: str({ minLength: 1, maxLength: 2000 }),
    context: {
      type: 'array',
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key'],
        properties: { key: str({ minLength: 1 }), equals: {}, exists: { type: 'boolean' } },
      },
    },
  },
};

// ---------- wire format (what the provider's structured-output mode is asked to emit) ----------

/**
 * The plan document's own JSON schema above cannot be sent as a structured-output schema: OpenAI strict
 * mode needs every object closed and every property required, and neither vendor accepts open or dynamic
 * objects (`allowedModels` is keyed by step id, `inputs`/`output`/`equals` hold arbitrary JSON), string
 * lengths, numeric bounds or array maxima. The WIRE format is an equivalent, closed shape inside the
 * subset both vendors document (types, properties, all-required, additionalProperties false, items,
 * enum, anyOf-with-null, minItems 0/1, descriptions):
 *
 * - `allowedModels` is a list of `{step, seats}` entries instead of a record;
 * - step `inputs` / `output` and context `equals` travel as JSON text (`inputsJson`, `outputJson`,
 *   `equalsJson`), null when absent;
 * - optional fields are present and null when absent (budget fields included).
 *
 * `wireToDocument` turns a wire document back into a plan document, which then gets the full host
 * validation (PlanDocumentSchema, every bound, regex and uniqueness rule, then the planner checks). The
 * wire schema constrains shape only; it never replaces host validation.
 */

/** Longest JSON text accepted in one wire `*Json` field. */
export const MAX_WIRE_JSON_CHARS = 32_000;

const wStr = (description?: string): JsonObject => (description ? { type: 'string', description } : { type: 'string' });
const wNullable = (s: JsonObject, description?: string): JsonObject => ({ anyOf: [s, { type: 'null' }], ...(description ? { description } : {}) });
const wStrings = (description?: string): JsonObject => ({ type: 'array', items: { type: 'string' }, ...(description ? { description } : {}) });
const wClosed = (properties: Record<string, JsonObject>, description?: string): JsonObject => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
  ...(description ? { description } : {}),
});

export const PLAN_WIRE_JSON_SCHEMA: JsonObject = wClosed({
  steps: {
    type: 'array',
    minItems: 1,
    description: `The DAG, at most ${MAX_STEPS} steps.`,
    items: wClosed({
      id: wStr('Unique step id: a letter, then letters, digits, _ or -, at most 32 characters.'),
      kind: { type: 'string', enum: [...STEP_KINDS] },
      dependsOn: wStrings('Ids of earlier steps this step depends on.'),
      instruction: wNullable(wStr(), 'Worker steps: a concrete instruction. Null for gates.'),
      inputsJson: wNullable(wStr(), 'Step inputs as JSON object text (e.g. "{\"path\":\"src/a.js\"}"), or null for none.'),
      outputJson: wNullable(wStr(), 'Worker steps: the JSON schema of the return value as JSON object text, or null.'),
      tools: wNullable(wStrings(), 'Worker steps: a subset of permissions.tools to narrow to, or null for the plan tools.'),
    }),
  },
  allowedModels: {
    type: 'array',
    description: 'One entry per worker step: the seats allowed to run it.',
    items: wClosed({ step: wStr('A worker step id.'), seats: wStrings('Worker seat ids.') }),
  },
  permissions: wClosed({ tools: wStrings('Tool names.'), write: wStrings('Write globs.'), approvals: wStrings('Approval names.') }),
  budget: wClosed(
    {
      usd: wNullable({ type: 'number' }),
      tokens: wNullable({ type: 'integer' }),
      wallClockSec: wNullable({ type: 'integer' }),
      maxDepth: wNullable({ type: 'integer' }),
      maxIterations: wNullable({ type: 'integer' }),
      maxAttempts: wNullable({ type: 'integer' }),
      maxChangedFiles: wNullable({ type: 'integer' }),
    },
    'Null = the effective ceiling.',
  ),
  goalKinds: { type: 'array', minItems: 1, items: { type: 'string' } },
  rationale: wStr('One short paragraph.'),
  context: {
    type: 'array',
    description: 'Belief preconditions.',
    items: wClosed({ key: wStr(), equalsJson: wNullable(wStr(), 'Expected value as JSON text, or null.'), exists: wNullable({ type: 'boolean' }) }),
  },
});

const wireJson = z.string().max(MAX_WIRE_JSON_CHARS).nullish();
const WireStepSchema = z
  .object({
    id: z.string().max(64),
    kind: z.string().max(32),
    dependsOn: z.array(z.string().max(64)).max(64),
    instruction: z.string().max(4000).nullish(),
    inputsJson: wireJson,
    outputJson: wireJson,
    tools: z.array(z.string().max(128)).max(64).nullish(),
  })
  .strict();
const wireInt = z.number().nullish();
export const PlanWireSchema = z
  .object({
    steps: z.array(WireStepSchema).max(64),
    allowedModels: z.array(z.object({ step: z.string().max(64), seats: z.array(z.string().max(128)).max(64) }).strict()).max(64),
    permissions: z.object({ tools: z.array(z.string().max(128)).max(64), write: z.array(z.string().max(512)).max(64), approvals: z.array(z.string().max(128)).max(64) }).strict(),
    budget: z
      .object({ usd: wireInt, tokens: wireInt, wallClockSec: wireInt, maxDepth: wireInt, maxIterations: wireInt, maxAttempts: wireInt, maxChangedFiles: wireInt })
      .strict(),
    goalKinds: z.array(z.string().max(128)).max(64),
    rationale: z.string().max(4000),
    context: z.array(z.object({ key: z.string().max(400), equalsJson: wireJson, exists: z.boolean().nullish() }).strict()).max(64).nullish(),
  })
  .strict();

/** True when a parsed top-level object is in the wire format (allowedModels is a list). */
export function isWireDocument(v: unknown): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Array.isArray((v as { allowedModels?: unknown }).allowedModels);
}

function setOwn(o: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

/**
 * Wire document → plan-document input (not yet validated: the caller runs PlanDocumentSchema). Never
 * throws. Issues name the wire field; JSON text that does not parse, or parses to the wrong kind of
 * value, is an issue, never silently dropped.
 */
export function wireToDocument(v: unknown): { ok: true; doc: Record<string, unknown> } | { ok: false; issues: string[] } {
  try {
    const w = PlanWireSchema.safeParse(v);
    if (!w.success) return { ok: false, issues: formatZodIssues(w.error) };
    const d = w.data;
    const issues: string[] = [];
    const json = (text: string, where: string, object: boolean): unknown => {
      let x: unknown;
      try {
        x = JSON.parse(text);
      } catch {
        issues.push(`${where}: must be JSON text`);
        return undefined;
      }
      if (object && (!x || typeof x !== 'object' || Array.isArray(x))) {
        issues.push(`${where}: must be the JSON text of an object`);
        return undefined;
      }
      return x;
    };
    const steps = d.steps.map((s, i) => {
      const step: Record<string, unknown> = { id: s.id, kind: s.kind, dependsOn: [...s.dependsOn] };
      if (s.instruction != null) step['instruction'] = s.instruction;
      step['inputs'] = s.inputsJson != null ? json(s.inputsJson, `steps.${i}.inputsJson`, true) : {};
      if (s.outputJson != null) step['output'] = json(s.outputJson, `steps.${i}.outputJson`, true);
      if (s.tools != null) step['tools'] = [...s.tools];
      return step;
    });
    const allowedModels: Record<string, unknown> = {};
    d.allowedModels.forEach((e, i) => {
      if (Object.prototype.hasOwnProperty.call(allowedModels, e.step)) issues.push(`allowedModels.${i}: duplicate entry for step ${safeSegment(e.step)}`);
      else setOwn(allowedModels, e.step, [...e.seats]);
    });
    const budget: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(d.budget)) if (val != null) budget[k] = val;
    const context = (d.context ?? []).map((c, i) => {
      const b: Record<string, unknown> = { key: c.key };
      if (c.equalsJson != null) b['equals'] = json(c.equalsJson, `context.${i}.equalsJson`, false);
      if (c.exists != null) b['exists'] = c.exists;
      return b;
    });
    if (issues.length) return { ok: false, issues };
    return {
      ok: true,
      doc: {
        steps,
        allowedModels,
        permissions: { tools: [...d.permissions.tools], write: [...d.permissions.write], approvals: [...d.permissions.approvals] },
        budget,
        goalKinds: [...d.goalKinds],
        rationale: d.rationale,
        context,
      },
    };
  } catch (err) {
    return { ok: false, issues: [`unreadable wire document (${err instanceof Error ? err.name : 'error'})`] };
  }
}

// ---------- stamping ----------

/** `p_` + first 8 hex of sha256 over the canonical plan content (id, origin, status, rationale excluded). */
export function planId(p: Pick<Plan, 'trigger' | 'context' | 'steps' | 'allowedModels' | 'permissions' | 'budget' | 'goalKinds'>): string {
  const body = normalizeJson({
    trigger: p.trigger,
    context: p.context,
    steps: p.steps,
    allowedModels: p.allowedModels,
    permissions: p.permissions,
    budget: p.budget,
    goalKinds: p.goalKinds,
  } as unknown as Json);
  return `p_${digest(body).slice(0, 8)}`;
}

/**
 * Turn a parsed plan document into a Plan: host-stamped id, trigger, origin and status. `budget` replaces
 * the document's budget (the planner passes the materialised effective budget so the id covers it).
 */
export function toPlan(
  doc: PlanDocument,
  stamp: { trigger: EventPattern; origin?: PlanOrigin; status?: PlanStatus; budget?: Plan['budget'] },
): Plan {
  const steps = doc.steps.map((s) => {
    const step: Plan['steps'][number] = { id: s.id, kind: s.kind, dependsOn: [...s.dependsOn], inputs: s.inputs };
    if (s.output !== undefined) step.output = s.output;
    if (s.instruction !== undefined) step.instruction = s.instruction;
    if (s.tools !== undefined) step.tools = [...s.tools];
    return step;
  });
  const context: BeliefPattern[] = doc.context.map((c) => {
    const b: BeliefPattern = { key: c.key };
    if (c.equals !== undefined) b.equals = c.equals;
    if (c.exists !== undefined) b.exists = c.exists;
    return b;
  });
  const body = {
    trigger: stamp.trigger,
    context,
    steps,
    allowedModels: Object.fromEntries(Object.entries(doc.allowedModels).map(([k, v]) => [k, [...v]])),
    permissions: { tools: [...doc.permissions.tools], write: [...doc.permissions.write], approvals: [...doc.permissions.approvals] },
    budget: { ...(stamp.budget ?? doc.budget) },
    goalKinds: [...doc.goalKinds],
  };
  return {
    id: planId(body),
    ...body,
    origin: stamp.origin ?? 'generated',
    status: stamp.status ?? 'candidate',
    rationale: doc.rationale,
  };
}

// ---------- diagnostics ----------

const SAFE_SEGMENT = /^[A-Za-z0-9_.:-]{1,40}$/;

/** A path segment or key that came from model output: echoed only when it is a short identifier. */
export function safeSegment(seg: unknown): string {
  if (typeof seg === 'number' && Number.isInteger(seg)) return String(seg);
  return typeof seg === 'string' && SAFE_SEGMENT.test(seg) ? seg : '<key>';
}

/**
 * Readable zod issues: `path: message`. Model-supplied text (unknown keys, enum values received, record
 * keys in the path) is never echoed unless it is a short identifier; the caller still redacts the result.
 */
export function formatZodIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => {
    const path = i.path.length ? i.path.map(safeSegment).join('.') : '<root>';
    let msg: string;
    switch (i.code) {
      case 'unrecognized_keys': {
        const keys = i.keys.map(safeSegment);
        msg = `unknown key(s) ${keys.join(', ')}; only the documented fields are allowed`;
        break;
      }
      case 'invalid_enum_value':
        msg = `must be one of ${i.options.map((o) => String(o)).join(', ')}`;
        break;
      case 'invalid_union':
        msg = 'value does not match any allowed JSON shape';
        break;
      default:
        msg = i.message;
    }
    return `${path}: ${msg}`;
  });
}
