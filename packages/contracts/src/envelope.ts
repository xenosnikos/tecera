import { CHANGE_OPS, type AcceptanceContract, type ChangeOp, type ChangePath } from './acceptance.js';
import type { Step } from './bdi.js';

/**
 * The change-path envelope check, shared by every place that enforces it: the worker's write tools (through
 * the runtime), the loop's step close-out, and the verify and commit gates. Pure: paths and operations in,
 * the unexpected ones out.
 *
 * An envelope entry matches a path exactly, or as an anchored glob: `*` stays inside one segment, a `**`
 * segment spans any number of segments. Unlike the manifest's allow globs, a pattern never matches at
 * another depth than it names. Operations are relative to the base commit: a path absent there is created,
 * a path present there is modified or deleted. Removing a file the base does not have changes nothing
 * against the base and is never an envelope question.
 */

/** One path the host found changed and what that amounts to against the base. `ignored`: a git-ignored file. */
export interface PathChange {
  path: string;
  op: ChangeOp | 'ignored';
}

const cache = new Map<string, RegExp>();

function patternRegExp(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  const segs = pattern.split('/');
  let re = '';
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const last = i === segs.length - 1;
    if (s === '**') {
      // any number of whole segments (at the end: at least one, the file itself)
      re += last ? '.+' : '(?:[^/]+/)*';
      continue;
    }
    re += s.replace(/[.+^$()|[\]\\{}?]/g, '\\$&').replace(/\*/g, '[^/]*');
    if (!last) re += '/';
  }
  const out = new RegExp(`^${re}$`);
  cache.set(pattern, out);
  return out;
}

/** True when envelope pattern `pattern` covers `path` (exact, or an anchored glob). */
export function envelopePathMatches(pattern: string, path: string): boolean {
  return pattern.includes('*') ? patternRegExp(pattern).test(path) : pattern === path;
}

/** True when some entry covering `path` allows `op`. */
export function envelopeAllows(entries: readonly ChangePath[], path: string, op: ChangeOp): boolean {
  return entries.some((e) => e.ops.includes(op) && envelopePathMatches(e.path, path));
}

/**
 * The envelope that was stated for a step: the accepted contract's and, inside it, the step's declared
 * subset. A change must be allowed by every layer. null = nothing was stated: repo.allowedChanges is the
 * only boundary, enforced where it always was (the write tools and the commit gate).
 */
export interface StatedEnvelope {
  /** 'contract': the contract's envelope alone; 'step': the step's declared subset (inside the contract's, when it has one). */
  source: 'contract' | 'step';
  layers: ChangePath[][];
}

export function statedEnvelope(contract: Pick<AcceptanceContract, 'envelope'> | null | undefined, step?: Pick<Step, 'changes'> | null): StatedEnvelope | null {
  const c = Array.isArray(contract?.envelope) && contract!.envelope!.length ? contract!.envelope! : null;
  const s = Array.isArray(step?.changes) && step!.changes!.length ? step!.changes! : null;
  if (!c && !s) return null;
  return { source: s ? 'step' : 'contract', layers: [...(s ? [s] : []), ...(c ? [c] : [])] };
}

/** True when every layer allows `op` on `path`. */
export function statedAllows(env: StatedEnvelope, path: string, op: ChangeOp): boolean {
  return env.layers.every((l) => envelopeAllows(l, path, op));
}

/** The changes the envelope does not allow, in the order given. An ignored-file change is never allowed. */
export function unexpectedChanges(env: StatedEnvelope, changes: readonly PathChange[]): PathChange[] {
  return changes.filter((c) => c.op === 'ignored' || !CHANGE_OPS.includes(c.op) || !statedAllows(env, c.path, c.op));
}

/** `path (op), path (op), …`, at most `max` entries. */
export function describeUnexpected(list: readonly PathChange[], max = 10): string {
  const shown = list.slice(0, max).map((c) => `${c.path} (${c.op})`);
  return shown.join(', ') + (list.length > max ? `, and ${list.length - max} more` : '');
}

/**
 * Why envelope entry `inner` is not within `outer` (null when it is): for each of its operations some outer
 * entry that allows the operation must cover every path `inner` can match. A literal path is covered by
 * any outer entry that matches it; a glob only by the same glob, or by an outer `dir/**` it lies under.
 * Anything this cannot prove is refused: narrowing is always possible by naming the paths.
 */
export function changeWithin(inner: ChangePath, outer: readonly ChangePath[]): string | null {
  const covers = (o: ChangePath): boolean => {
    if (!inner.path.includes('*')) return envelopePathMatches(o.path, inner.path);
    if (o.path === inner.path) return true;
    return o.path.endsWith('/**') && !o.path.slice(0, -3).includes('*') && inner.path.startsWith(o.path.slice(0, -2));
  };
  for (const op of inner.ops) {
    if (!outer.some((o) => o.ops.includes(op) && covers(o))) return `${inner.path} (${op}) is not inside the accepted envelope`;
  }
  return null;
}
