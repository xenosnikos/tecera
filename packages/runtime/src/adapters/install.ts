import { z } from 'zod';
import type { Json } from '@tecera/contracts';
import { matchesAny, pathProblem } from '@tecera/policy';
import type { PlannedFs } from '../vfs.js';
import { UnsafePathError } from '../util/safefs.js';
import { applyManagedBlock, jsonContains, jsonMerge, MergeError, readManagedBlock, securityConflicts, stripMarkers } from './merge.js';
import { renderBrainSummary, renderPermissionsSettings, type RenderSource } from './render.js';

/**
 * `tecera adapters install|doctor <host>`: read `.tecera/adapters/<host>/adapter.json`, render each file's
 * source and merge it into its target with the declared policy. Every target is a repo-relative path
 * checked by policy.pathProblem and kept out of tecera's own state and git internals; reads and writes go
 * through PlannedFs, which refuses symlinks, dangling links and hard links, so a target cannot redirect a
 * write outside the business-case root. Rendered and copied content is redacted. A json-merge that keeps a
 * user value over tecera's deny list or hooks is a SECURITY conflict: install reports it as a failure and
 * doctor reports the target as not installed. Install stages writes; doctor computes the same plan.
 */

/** Adapter targets may never point into tecera's own state or git internals. */
export const FORBIDDEN_TARGETS = ['tecera.json', '.tecera/**', '.git/**', '.git'];

export const MERGE_POLICIES = ['managed-block', 'json-merge', 'owned', 'create-only'] as const;
export type MergePolicy = (typeof MERGE_POLICIES)[number];

const AdapterSchema = z
  .object({
    harness: z.string().min(1),
    version: z.literal(1),
    files: z
      .array(
        z
          .object({
            target: z.string().min(1),
            from: z.string().min(1),
            merge: z.enum(MERGE_POLICIES),
          })
          .strict(),
      )
      .min(1),
    postInstall: z.array(z.string()).optional(),
  })
  .strict();

export type AdapterSpec = z.infer<typeof AdapterSchema>;

export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterError';
  }
}

export function adapterPath(host: string): string {
  return `.tecera/adapters/${host}/adapter.json`;
}

export function readAdapter(fs: PlannedFs, host: string): AdapterSpec {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(host)) throw new AdapterError(`not a host name: ${host}`);
  const text = fs.read(adapterPath(host));
  if (text === undefined) throw new AdapterError(`${adapterPath(host)} not found`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new AdapterError(`${adapterPath(host)} is not valid JSON: ${(err as Error).message}`);
  }
  const r = AdapterSchema.safeParse(raw);
  if (!r.success) throw new AdapterError(`${adapterPath(host)}: ${r.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')}`);
  for (const f of r.data.files) {
    const bad = pathProblem(f.target);
    if (bad) throw new AdapterError(`${adapterPath(host)}: target ${f.target}: ${bad}`);
    const forbidden = matchesAny(f.target, FORBIDDEN_TARGETS);
    if (forbidden) throw new AdapterError(`${adapterPath(host)}: target ${f.target} is inside ${forbidden}; adapters write host files only`);
    if (!f.from.startsWith('render:')) {
      const badFrom = pathProblem(f.from);
      if (badFrom) throw new AdapterError(`${adapterPath(host)}: from ${f.from}: ${badFrom}`);
    }
  }
  return r.data;
}

function source(from: string, src: RenderSource, host: string, fs: PlannedFs): { text?: string; json?: Json; security: boolean } {
  if (from === 'render:brain-summary') return { text: renderBrainSummary(src, host), security: false };
  if (from === 'render:permissions') return { json: renderPermissionsSettings(src), security: true };
  if (from.startsWith('render:')) throw new AdapterError(`unknown renderer ${from}`);
  const text = fs.read(from);
  if (text === undefined) throw new AdapterError(`source ${from} not found`);
  return { text: src.redactor.redactText(text), security: false };
}

/** Read a target through the contained fs; a link or unreadable target is an adapter error. */
function readTarget(fs: PlannedFs, target: string): string | undefined {
  try {
    return fs.read(target);
  } catch (e) {
    if (e instanceof UnsafePathError) throw new AdapterError(`target ${target}: ${e.message}`);
    throw e;
  }
}

export interface FileResult {
  target: string;
  merge: MergePolicy;
  status: 'written' | 'unchanged' | 'kept';
  conflicts: string[];
  /** Conflicts that leave tecera's deny list or hooks uninstalled (the user value was kept). */
  securityConflicts: string[];
}

/** Stage the adapter's writes. `force` lets owned/create-only overwrite. */
export function installAdapter(fs: PlannedFs, host: string, src: RenderSource, opts: { force?: boolean } = {}): FileResult[] {
  const spec = readAdapter(fs, host);
  const results: FileResult[] = [];
  for (const f of spec.files) {
    const s = source(f.from, src, host, fs);
    const cur = readTarget(fs, f.target);
    let next: string | undefined;
    let conflicts: string[] = [];
    switch (f.merge) {
      case 'managed-block': {
        const body = s.text ?? `\`\`\`json\n${JSON.stringify(s.json, null, 2)}\n\`\`\``;
        try {
          next = applyManagedBlock(cur, body);
        } catch (err) {
          if (err instanceof MergeError) throw new AdapterError(`${f.target}: ${err.message}`);
          throw err;
        }
        break;
      }
      case 'json-merge': {
        const patch = s.json ?? parseJson(s.text!, f.from);
        const base = cur === undefined || cur.trim() === '' ? undefined : parseJson(cur, f.target);
        const r = jsonMerge(base, patch);
        conflicts = r.conflicts;
        next = `${JSON.stringify(r.value, null, 2)}\n`;
        break;
      }
      case 'owned':
        next = s.text ?? `${JSON.stringify(s.json, null, 2)}\n`;
        if (cur !== undefined && cur !== next && !opts.force) {
          results.push({ target: f.target, merge: f.merge, status: 'kept', conflicts: ['differs from the rendered file; use --force to overwrite'], securityConflicts: s.security ? ['differs from the rendered settings'] : [] });
          continue;
        }
        break;
      case 'create-only':
        if (cur !== undefined && !opts.force) {
          results.push({ target: f.target, merge: f.merge, status: 'kept', conflicts: [], securityConflicts: [] });
          continue;
        }
        next = s.text ?? `${JSON.stringify(s.json, null, 2)}\n`;
        break;
    }
    let op;
    try {
      op = fs.write(f.target, next!, `adapter:${host}:${f.merge}`);
    } catch (e) {
      if (e instanceof UnsafePathError) throw new AdapterError(`target ${f.target}: ${e.message}`);
      throw e;
    }
    results.push({ target: f.target, merge: f.merge, status: op ? 'written' : 'unchanged', conflicts, securityConflicts: s.security ? securityConflicts(conflicts) : [] });
  }
  return results;
}

export interface StaleReport {
  target: string;
  merge: MergePolicy;
  ok: boolean;
  detail: string;
  /** The target carries tecera's enforcement (deny list, hooks); not ok here means not protected. */
  security: boolean;
}

/** What `adapters doctor` reports: each target is current, or what is stale. Reads only. */
export function checkAdapter(fs: PlannedFs, host: string, src: RenderSource): StaleReport[] {
  const spec = readAdapter(fs, host);
  return spec.files.map((f): StaleReport => {
    const s = source(f.from, src, host, fs);
    const r = (ok: boolean, detail: string): StaleReport => ({ target: f.target, merge: f.merge, ok, detail, security: s.security });
    let cur: string | undefined;
    try {
      cur = readTarget(fs, f.target);
    } catch (e) {
      return r(false, (e as Error).message);
    }
    if (cur === undefined) return r(false, 'missing');
    switch (f.merge) {
      case 'managed-block': {
        const want = stripMarkers(s.text ?? '').trim();
        const have = readManagedBlock(cur);
        if (have === null) return r(false, 'no tecera block');
        return r(s.text === undefined || have === want, have === want ? 'current' : 'block is stale');
      }
      case 'json-merge': {
        let base: Json;
        try {
          base = parseJson(cur, f.target);
        } catch (err) {
          return r(false, (err as Error).message);
        }
        const ok = jsonContains(base, s.json ?? parseJson(s.text!, f.from));
        return r(ok, ok ? 'current' : s.security ? 'tecera deny list or hooks missing or overridden' : 'missing tecera entries');
      }
      case 'owned': {
        const want = s.text ?? `${JSON.stringify(s.json, null, 2)}\n`;
        return r(cur === want, cur === want ? 'current' : 'differs');
      }
      case 'create-only':
        return r(true, 'present');
    }
  });
}

function parseJson(text: string, where: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch (err) {
    throw new AdapterError(`${where} is not valid JSON (${(err as Error).message}); refusing to merge`);
  }
}

/** Hosts whose adapter is enabled in the manifest and present on disk/staged. */
export function enabledHosts(fs: PlannedFs, adapters: Record<string, { enabled: boolean }>): string[] {
  return Object.entries(adapters)
    .filter(([h, a]) => a.enabled && fs.exists(adapterPath(h)))
    .map(([h]) => h)
    .sort();
}
