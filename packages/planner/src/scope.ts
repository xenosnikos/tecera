import { READ_ONLY_TOOLS, type JsonObject, type Manifest } from '@tecera/contracts';
import { normalizePath, writesWithin } from '@tecera/policy';
import type { PlanDocument } from './schema.js';

/**
 * Host-settled parts of a generated plan (the model's plan document, before the host stamps it).
 *
 * Write scope. A plan that changes files writes where the manifest allows (repo.allowedChanges): a model that
 * names fewer globs would deny its own worker an edit the request needs (the command that imports a file the
 * request names may be named nowhere). What the request or the contract happens to name never narrows it: the
 * diff boundary and the foreign review already bound what lands. A glob outside allowedChanges is left for
 * policy validation to refuse: the host never widens past the manifest.
 *
 * Writing steps. A worker step meant to change files (an effective tool outside READ_ONLY_TOOLS and
 * runVerify) returns `{changed: [paths…], summary}` with at least one path: a return that changed nothing
 * fails the step's schema instead of passing as an exploration object. Properties the model asked for (e.g.
 * `facts`) are kept beside them. Read steps keep their own schema.
 */

/** Tools that never change files on their own (runVerify runs the tests; it is not an edit). */
const NON_EDITING: ReadonlySet<string> = new Set([...READ_ONLY_TOOLS, 'runVerify']);

/** The output schema every file-changing worker step returns. */
export const WRITING_STEP_OUTPUT: Readonly<JsonObject> = Object.freeze({
  type: 'object',
  required: ['changed', 'summary'],
  properties: {
    changed: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'Repository paths this step changed (at least one).' },
    summary: { type: 'string', minLength: 1, description: 'What changed and why, in one or two sentences.' },
  },
}) as JsonObject;

type DocStep = PlanDocument['steps'][number];

/** True when a worker step of `doc` is meant to change files: an effective tool that can edit. */
export function stepChangesFiles(doc: Pick<PlanDocument, 'permissions'>, step: Pick<DocStep, 'kind' | 'tools'>): boolean {
  if (step.kind !== 'worker') return false;
  const plan = Array.isArray(doc.permissions?.tools) ? doc.permissions.tools : [];
  const tools = Array.isArray(step.tools) ? step.tools.filter((t) => plan.includes(t)) : plan;
  return tools.some((t) => !NON_EDITING.has(t));
}

/** `own` merged under the writing schema: changed and summary always the host's, required always both. */
export function writingStepOutput(own: JsonObject | undefined): JsonObject {
  const host = WRITING_STEP_OUTPUT as { required: string[]; properties: JsonObject };
  const o = own && typeof own === 'object' && !Array.isArray(own) && (own['type'] === undefined || own['type'] === 'object') ? own : {};
  const props = o['properties'] && typeof o['properties'] === 'object' && !Array.isArray(o['properties']) ? (o['properties'] as JsonObject) : {};
  const req = Array.isArray(o['required']) ? (o['required'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  return {
    ...o,
    type: 'object',
    required: [...new Set([...host.required, ...req])],
    properties: { ...props, ...host.properties },
  };
}

/** Why a writing step's output schema would accept a return that changed nothing (null when it would not). */
export function writingOutputProblem(output: JsonObject | undefined): string | null {
  const o = output as { type?: unknown; required?: unknown; properties?: Record<string, { type?: unknown; minItems?: unknown }> } | undefined;
  if (!o || o.type !== 'object') return 'output is not an object schema';
  if (!Array.isArray(o.required) || !o.required.includes('changed') || !o.required.includes('summary')) return 'output does not require changed and summary';
  const ch = o.properties?.['changed'];
  if (!ch || ch.type !== 'array' || typeof ch.minItems !== 'number' || ch.minItems < 1) return 'output accepts an empty changed list';
  return null;
}

// ---------- named paths ----------

/** Path-like tokens (a slash or a file extension), not preceded by a scheme or another path character. */
const PATH_TOKEN = /(?<![\w:./@-])(?:\.\/)?((?:[A-Za-z0-9_.-]+\/)+(?:[A-Za-z0-9_.-]+)?|[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.[A-Za-z][A-Za-z0-9]{0,7})(?![\w/-])/g;

/** Repository paths a text names (normalised; a directory as `dir/`). */
export function namedPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text).matchAll(PATH_TOKEN)) {
    const p = normalizePath(m[1]!);
    if (p && !p.startsWith('/') && !p.split('/').includes('..')) out.add(p);
  }
  return [...out];
}

// ---------- write scope ----------

export interface WriteScopeInput {
  manifest: Manifest;
}

/**
 * The document with its write scope settled (a copy; the document itself is unchanged when nothing applies)
 * and every file-changing worker step's output under WRITING_STEP_OUTPUT. See the module comment.
 */
export function settlePlanDocument(doc: PlanDocument, i: WriteScopeInput): PlanDocument {
  const steps = doc.steps.map((s) => (stepChangesFiles(doc, s) ? { ...s, output: writingStepOutput(s.output) } : s));
  const out: PlanDocument = { ...doc, steps, permissions: { ...doc.permissions, write: [...doc.permissions.write] } };
  const allowed = [...(i.manifest.repo?.allowedChanges ?? [])];
  const own = doc.permissions.write;
  const changes = own.length > 0 || steps.some((s) => stepChangesFiles(doc, s));
  if (!changes || allowed.length === 0) return out;
  // A glob outside the manifest stays for policy validation to refuse (a repair round names it).
  if (writesWithin(own, allowed).length) return out;
  out.permissions.write = allowed;
  return out;
}
