import { canonicalJson, type Json } from '@tecera/contracts';

/**
 * Merge policies for host files (dx.md §3). `managed-block`: tecera owns only the text between
 * `<!-- tecera:start -->` and `<!-- tecera:end -->`; the block is replaced in place, or appended once.
 * `json-merge`: objects merge recursively, arrays union, and an existing scalar the user set is never
 * overwritten (reported as a conflict). Both are idempotent: applying twice equals applying once.
 */

export const BLOCK_START = '<!-- tecera:start -->';
export const BLOCK_END = '<!-- tecera:end -->';

export class MergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeError';
  }
}

/** Strip marker strings from included content so a rendered block can never close itself early. */
export function stripMarkers(text: string): string {
  return text.split(BLOCK_START).join('').split(BLOCK_END).join('');
}

export function applyManagedBlock(existing: string | undefined, body: string): string {
  const block = `${BLOCK_START}\n${stripMarkers(body).trim()}\n${BLOCK_END}`;
  if (existing === undefined || existing.trim() === '') return `${block}\n`;
  const starts = existing.split(BLOCK_START).length - 1;
  const ends = existing.split(BLOCK_END).length - 1;
  if (starts === 0 && ends === 0) return `${existing.replace(/\s*$/, '')}\n\n${block}\n`;
  if (starts !== 1 || ends !== 1) throw new MergeError(`found ${starts} start and ${ends} end markers; fix the file by hand (expected exactly one tecera block)`);
  const s = existing.indexOf(BLOCK_START);
  const e = existing.indexOf(BLOCK_END);
  if (e < s) throw new MergeError('tecera:end appears before tecera:start');
  return existing.slice(0, s) + block + existing.slice(e + BLOCK_END.length);
}

/** The body currently inside the managed block, or null when there is none. */
export function readManagedBlock(existing: string | undefined): string | null {
  if (!existing) return null;
  const s = existing.indexOf(BLOCK_START);
  const e = existing.indexOf(BLOCK_END);
  if (s === -1 || e === -1 || e < s) return null;
  return existing.slice(s + BLOCK_START.length, e).trim();
}

const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);

export function jsonMerge(base: Json | undefined, patch: Json, path = ''): { value: Json; conflicts: string[] } {
  if (base === undefined) return { value: patch, conflicts: [] };
  if (isObj(base) && isObj(patch)) {
    const out: Record<string, Json> = { ...base };
    const conflicts: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const r = jsonMerge(base[k], v, path ? `${path}.${k}` : k);
      out[k] = r.value;
      conflicts.push(...r.conflicts);
    }
    return { value: out, conflicts };
  }
  if (Array.isArray(base) && Array.isArray(patch)) {
    const seen = new Set(base.map((x) => canonicalJson(x)));
    const out = [...base];
    for (const item of patch) {
      const k = canonicalJson(item);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(item);
      }
    }
    return { value: out, conflicts: [] };
  }
  if (canonicalJson(base) === canonicalJson(patch)) return { value: base, conflicts: [] };
  const t = (v: Json): string => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
  const what = t(base) === t(patch) ? `tecera wanted ${canonicalJson(patch)}` : `your ${t(base)} where tecera needs ${t(patch) === 'object' ? 'an object' : `a ${t(patch)}`}`;
  return { value: base, conflicts: [`${path || '<root>'}: kept your value; ${what}`] };
}

/**
 * True when json-merge would add or change nothing: every object key of `patch` is present with a value of
 * the same JSON type, every array item of `patch` is present in the base array, and every scalar equals.
 * A user value of a different type (`{"hooks": false}` where tecera wants an object) is NOT installed.
 */
export function jsonContains(base: Json | undefined, patch: Json): boolean {
  if (base === undefined) return false;
  if (isObj(patch)) return isObj(base) && Object.entries(patch).every(([k, v]) => jsonContains(base[k], v));
  if (Array.isArray(patch)) {
    if (!Array.isArray(base)) return false;
    const have = new Set(base.map((x) => canonicalJson(x)));
    return patch.every((x) => have.has(canonicalJson(x)));
  }
  return canonicalJson(base) === canonicalJson(patch);
}

/** Top-level keys of a host settings file that carry tecera's enforcement (deny lists and hooks). */
export const SECURITY_KEYS = ['permissions', 'hooks'] as const;

/** Conflicts reported by jsonMerge that sit under a security key (the user value was kept, tecera's lost). */
export function securityConflicts(conflicts: readonly string[]): string[] {
  return conflicts.filter((c) => c.startsWith('<root>') || SECURITY_KEYS.some((k) => c === k || c.startsWith(`${k}.`) || c.startsWith(`${k}:`)));
}
