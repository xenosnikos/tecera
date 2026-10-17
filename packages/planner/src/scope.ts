import { envelopePathMatches, READ_ONLY_TOOLS, type Json, type JsonObject, type Manifest } from '@tecera/contracts';
import { normalizePath, writesWithin } from '@tecera/policy';
import { renderCall, renderDeclared } from './apiSurface.js';
import type { RepoFacts } from './repoFacts.js';
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
 * `facts`) are kept beside them. Read steps keep their own schema. A writing step also gets runVerify (when
 * the tool catalog has it), added to its tools and the plan's, so the worker can run the tests before it
 * returns instead of meeting every failure at the verify gate.
 *
 * Keep-lists. Every writing step carries `inputs.keep`: what must stay as it is in the files it changes.
 * The model's own entries come first; the host adds, from the repository facts, every tested module the
 * step's declared changes cover (every module when it declared none): its exported names, how the tests
 * call them, the exact values those tests assert, and the interfaces its comments document (keepListFor).
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

/**
 * Bounds on a writing step's keep-list: entries in all, the model's own entries among them (the rest of the
 * room is the repository's, so a verbose plan cannot crowd its facts out), entries reserved for the values
 * the tests assert (the most exact facts, added last), and characters per entry.
 */
const MAX_KEEP = 40;
const MAX_KEEP_OWN = 12;
const MIN_KEEP_ASSERTED = 8;
const MAX_KEEP_CHARS = 300;

export interface KeepList {
  keep: string[];
  /** Entries the bounds left out: the model's own, and the repository's (truncation is reported, never silent). */
  dropped: { own: number; repository: number };
}

/**
 * The keep-list of a writing step (see the module comment): the model's own `inputs.keep` strings, then the
 * host's entries from the repository facts for the tested modules the step's changes cover (exports, call
 * shapes, documented lines, then the asserted values). Bounded (MAX_KEEP and its reservations), deduplicated.
 */
export function keepListFor(step: Pick<DocStep, 'inputs' | 'changes'>, repo: RepoFacts | undefined): KeepList {
  const own = step.inputs && typeof step.inputs === 'object' && !Array.isArray(step.inputs) ? (step.inputs as JsonObject)['keep'] : undefined;
  const out: string[] = [];
  const dropped = { own: 0, repository: 0 };
  const add = (s: string, cap: number, kind: 'own' | 'repository'): void => {
    const t = s.trim().slice(0, MAX_KEEP_CHARS);
    if (!t || out.includes(t)) return;
    if (out.length < cap) out.push(t);
    else dropped[kind]++;
  };
  if (Array.isArray(own)) for (const x of own) if (typeof x === 'string') add(x, MAX_KEEP_OWN, 'own');
  const changes = Array.isArray(step.changes) && step.changes.length ? step.changes : null;
  const covered = (module: string): boolean => !changes || changes.some((c) => envelopePathMatches(c.path, module));
  const tests = new Set<string>();
  const facts: string[] = [];
  for (const t of repo?.testedApi ?? []) {
    if (!covered(t.module)) continue;
    for (const x of t.tests) tests.add(x);
    facts.push(`${t.module} exports ${t.names.map((n) => `\`${n}\``).join(', ')} (used by ${t.tests.slice(0, 2).join(', ')})`);
    for (const c of t.calls ?? []) {
      const parts = [
        c.params ? `declared \`${renderDeclared(c.name, c.params)}\`` : '',
        c.signatures.length ? `called as ${c.signatures.slice(0, 3).map((x) => `\`${renderCall(c.name, x)}\``).join(', ')}` : '',
        c.methods.length ? `then ${c.methods.slice(0, 8).map((m) => `\`.${m}()\``).join(', ')} on its result` : '',
        c.resultCalled ? `its result is called as a function${c.resultArgKeys?.length ? ` with ${c.resultArgKeys.slice(0, 2).map((k) => `\`{ ${k.slice(0, 8).join(', ')} }\``).join(' or ')}` : ''}${c.resultProps?.length ? `, read through ${c.resultProps.slice(0, 8).map((x) => `\`.${x}\``).join(', ')}` : ''}` : '',
      ].filter(Boolean);
      if (parts.length) facts.push(`${t.module}: \`${c.name}\` ${parts.join('; ')}`);
    }
    for (const line of (t.documented ?? []).slice(0, 6)) facts.push(`${t.module} documents: ${line}`);
  }
  const asserted = (repo?.assertions ?? []).filter((a) => tests.has(a.test)).map((a) => `\`${a.actual}\` is \`${a.value}\` (${a.test})`);
  // Exports, calls and documented lines leave room for the asserted values; whatever room is left afterwards goes back to them.
  for (const f of facts) add(f, Math.max(out.length, MAX_KEEP - Math.min(MIN_KEEP_ASSERTED, asserted.length)), 'repository');
  for (const a of asserted) add(a, MAX_KEEP, 'repository');
  if (dropped.repository && out.length < MAX_KEEP) {
    dropped.repository = 0;
    for (const f of facts) add(f, MAX_KEEP, 'repository');
  }
  return { keep: out, dropped };
}

/** A writing step's inputs with its keep-list, and `keepDropped` when the bounds left entries out. */
function keepInputs(inputs: JsonObject | undefined, k: KeepList): JsonObject {
  const { keepDropped: _d, ...rest } = inputs ?? {};
  return { ...rest, keep: k.keep as Json, ...(k.dropped.own || k.dropped.repository ? { keepDropped: k.dropped } : {}) };
}

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
  /** The tools the host wires; runVerify is added to writing steps only when it is one. Default: it is. */
  toolCatalog?: readonly string[];
  /** The repository facts the keep-lists are built from (none: a writing step keeps the model's own list). */
  repo?: RepoFacts;
}

/**
 * The document with its write scope settled (a copy; the document itself is unchanged when nothing applies)
 * and every file-changing worker step's output under WRITING_STEP_OUTPUT. See the module comment.
 */
export function settlePlanDocument(doc: PlanDocument, i: WriteScopeInput): PlanDocument {
  const verify = !i.toolCatalog || i.toolCatalog.includes('runVerify');
  const writing = doc.steps.filter((s) => stepChangesFiles(doc, s));
  const steps = doc.steps.map((s) =>
    writing.includes(s)
      ? { ...s, inputs: keepInputs(s.inputs as JsonObject | undefined, keepListFor(s, i.repo)), output: writingStepOutput(s.output), ...(verify && Array.isArray(s.tools) && !s.tools.includes('runVerify') ? { tools: [...s.tools, 'runVerify'] } : {}) }
      : s,
  );
  const tools = verify && writing.length && Array.isArray(doc.permissions.tools) && !doc.permissions.tools.includes('runVerify') ? [...doc.permissions.tools, 'runVerify'] : doc.permissions.tools;
  const out: PlanDocument = { ...doc, steps, permissions: { ...doc.permissions, tools, write: [...doc.permissions.write] } };
  const allowed = [...(i.manifest.repo?.allowedChanges ?? [])];
  const own = doc.permissions.write;
  const changes = own.length > 0 || steps.some((s) => stepChangesFiles(doc, s));
  if (!changes || allowed.length === 0) return out;
  // A glob outside the manifest stays for policy validation to refuse (a repair round names it).
  if (writesWithin(own, allowed).length) return out;
  out.permissions.write = allowed;
  return out;
}
