import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * Process-wide worktree quarantine (Codex sprint-3 sandbox missing test: worktree reuse through a fresh
 * REPL after taint). A REPL instance's quarantine dies with the instance, but the writer it abandoned keeps
 * the worktree unsafe. When a REPL (constructed with `worktree`) or a verify run (its cwd) leaves work
 * unresolved, the path is recorded here; every later REPL exec on that worktree and every verify run whose
 * cwd is inside it (or contains it) refuses before running anything.
 *
 * Only the supervisor clears an entry (`releaseWorktreeQuarantine`), and only after it has proven the abandoned
 * operations settled AND re-checked or restored the tree. This registry is in-memory: across a restart the
 * caller must persist the taint itself (ExecOutput.tainted / VerifyOutcomeExt.tainted and the
 * 'sandbox.tainted' / 'verify.tainted' evidence), so it is a second line, never the only one.
 */

export interface WorktreeQuarantine {
  path: string;
  source: 'repl' | 'verify';
  reason: string;
  outstanding: string[];
  processes: number[];
  since: number;
  /** The path as given, when it differs from its real path. */
  lexical?: string;
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

/** Record that `path` may still be written by something unresolved. Merges with an existing entry. */
export function quarantineWorktree(path: string, t: Omit<WorktreeQuarantine, 'path' | 'since'>): void {
  if (typeof path !== 'string' || !path) return;
  const key = norm(path);
  const prev = registry.get(key);
  const lexical = resolve(path);
  registry.set(key, {
    path: key,
    ...(lexical !== key ? { lexical } : {}),
    source: prev?.source ?? t.source,
    reason: prev ? `${prev.reason}; ${t.reason}` : t.reason,
    outstanding: [...new Set([...(prev?.outstanding ?? []), ...t.outstanding])],
    processes: [...new Set([...(prev?.processes ?? []), ...t.processes])],
    since: prev?.since ?? Date.now(),
  });
}

/** The taint that applies to `path` (the path itself, an ancestor or a descendant of it), if any. */
export function worktreeQuarantine(path: string | undefined): WorktreeQuarantine | undefined {
  if (typeof path !== 'string' || !path) return undefined;
  const keys = forms(path);
  for (const t of registry.values()) if (keys.some((k) => related(k, t.path) || (t.lexical !== undefined && related(k, t.lexical)))) return { ...t, outstanding: [...t.outstanding], processes: [...t.processes] };
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
