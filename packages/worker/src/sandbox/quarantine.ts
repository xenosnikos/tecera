import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * Process-wide worktree quarantine (Codex sprint-3 sandbox missing test: worktree reuse through a fresh
 * REPL after taint). A REPL instance's quarantine dies with the instance, but the writer it abandoned keeps
 * the worktree unsafe. When a REPL (constructed with `worktree`, or run by an invoke whose broker has one)
 * or a verify run (its cwd) leaves work unresolved, the path is recorded here; every later REPL exec on
 * that worktree and every verify run whose cwd is inside it (or contains it) refuses before running anything.
 *
 * This is the ONE registry of the process. The file tools and the broker record their taints here too
 * (tools/paths.ts markWorktreeTainted, source 'tools': an unresolved writer at drain timeout, a commit that
 * could not be verified) and read it through worktreeTaint, so a taint recorded by either side refuses the
 * file tools, the verify tool, the broker's write fence, the REPL and the verify runner alike.
 *
 * Only the supervisor clears an entry (`releaseWorktreeQuarantine`), and only after it has proven the abandoned
 * operations settled AND re-checked or restored the tree. This registry is in-memory: across a restart the
 * caller must persist the taint itself (ExecOutput.tainted / VerifyOutcomeExt.tainted and the
 * 'sandbox.tainted' / 'verify.tainted' evidence), so it is a second line, never the only one.
 */

export interface WorktreeQuarantine {
  path: string;
  /** Who recorded it first: a REPL, a verify run, or the file tools / broker. */
  source: 'repl' | 'verify' | 'tools';
  reason: string;
  outstanding: string[];
  processes: number[];
  since: number;
  /** The path as given, when it differs from its real path. */
  lexical?: string;
  /** Who left the work unresolved, when the recorder knows (e.g. `run r1 exec 3`). First recorder wins. */
  origin?: string;
  /**
   * On a lookup: the recorded path that matched and how it relates to the path asked about ('ancestor' = the
   * recorded path contains it, 'descendant' = it contains the recorded path).
   */
  matched?: { path: string; relation: 'same' | 'ancestor' | 'descendant' };
}

const registry = new Map<string, WorktreeQuarantine>();

function norm(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p); // gone: the lexical path still matches
  }
}

/** Lexical and real forms of `p` (a symlinked path and its target match the same entry). */
function forms(p: string): string[] {
  return [...new Set([resolve(p), norm(p)])];
}

function related(a: string, b: string): boolean {
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep) || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

/** Record that `path` may still be written by something unresolved. Merges with an existing entry (a reason already recorded is not repeated). */
export function quarantineWorktree(path: string, t: Omit<WorktreeQuarantine, 'path' | 'since' | 'matched'>): void {
  if (typeof path !== 'string' || !path) return;
  const key = norm(path);
  const prev = registry.get(key);
  const lexical = resolve(path);
  registry.set(key, {
    path: key,
    ...(lexical !== key ? { lexical } : {}),
    source: prev?.source ?? t.source,
    reason: !prev ? t.reason : prev.reason.includes(t.reason) ? prev.reason : `${prev.reason}; ${t.reason}`,
    outstanding: [...new Set([...(prev?.outstanding ?? []), ...t.outstanding])],
    processes: [...new Set([...(prev?.processes ?? []), ...t.processes])],
    since: prev?.since ?? Date.now(),
    ...((prev?.origin ?? t.origin) ? { origin: prev?.origin ?? t.origin } : {}),
  });
}

/** The taint that applies to `path` (the path itself, an ancestor or a descendant of it), if any. */
export function worktreeQuarantine(path: string | undefined): WorktreeQuarantine | undefined {
  if (typeof path !== 'string' || !path) return undefined;
  const keys = forms(path);
  for (const t of registry.values()) {
    for (const recorded of t.lexical !== undefined ? [t.path, t.lexical] : [t.path]) {
      const k = keys.find((x) => related(x, recorded));
      if (k === undefined) continue;
      const relation = k === recorded ? 'same' : k.length > recorded.length ? 'ancestor' : 'descendant';
      return { ...t, outstanding: [...t.outstanding], processes: [...t.processes], matched: { path: recorded, relation } };
    }
  }
  return undefined;
}

/**
 * Clear the taint on exactly `path`. The caller attests that every abandoned operation settled and the tree
 * was re-checked or restored; the attestation is required so the call site documents it.
 */
export function releaseWorktreeQuarantine(path: string, attestation: { by: string; reason: string }): boolean {
  if (!attestation || typeof attestation.by !== 'string' || !attestation.by || typeof attestation.reason !== 'string' || !attestation.reason) {
    throw new Error('releaseWorktreeQuarantine needs an attestation {by, reason}');
  }
  let hit = false;
  for (const k of forms(path)) hit = registry.delete(k) || hit;
  return hit;
}

/** Every recorded taint (for diagnostics and tests). */
export function listWorktreeQuarantines(): WorktreeQuarantine[] {
  return [...registry.values()].map((t) => ({ ...t, outstanding: [...t.outstanding], processes: [...t.processes] }));
}
