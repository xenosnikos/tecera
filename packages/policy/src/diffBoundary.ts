import { globWithin, matchesAny, normalizePath, pathProblem } from './glob.js';

/**
 * Port of EEZE guards.enforce_changes. Task configuration is trusted orchestration input; the writer's
 * diff is not. Defaults are fail-closed: no allowed_changes means no change is allowed. A protected path
 * may only change under a scoped exception with a human-written reason. Blanket exceptions are refused.
 * Unknown change kinds abort. Renames check both ends. Symlinks are refused outright in Phase 1.
 */

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'T' | 'C' | '?' | '!';

export interface Change {
  path: string;
  status: ChangeStatus;
  /** Rename/copy source. */
  from?: string;
  symlink?: boolean;
  bytes?: number;
  modeChanged?: boolean;
  binary?: boolean;
}

export interface ChangeBoundary {
  allowedChanges: readonly string[];
  protectedPaths: readonly string[];
  /** Scoped globs under which a protected path may change, only with `reason`. */
  protectedExceptions?: readonly string[];
  reason?: string;
  maxFileBytes?: number;
}

export class BoundaryViolation extends Error {
  constructor(public readonly violations: readonly string[]) {
    super(`change boundary violated:\n- ${violations.join('\n- ')}`);
    this.name = 'BoundaryViolation';
  }
}

const BLANKET = new Set(['*', '**', '**/*', '/**']);
const KNOWN: ReadonlySet<string> = new Set(['A', 'M', 'D', 'R', 'T', 'C', '?', '!']);

export function enforceChanges(boundary: ChangeBoundary, changes: readonly Change[]): void {
  const v: string[] = [];
  const exceptions = boundary.protectedExceptions ?? [];
  if (exceptions.some((e) => BLANKET.has(normalizePath(e)))) throw new BoundaryViolation(['protected_path_exceptions must be scoped, not blanket']);
  const hasReason = typeof boundary.reason === 'string' && boundary.reason.trim().length > 0;
  const allowed = boundary.allowedChanges;
  const maxBytes = boundary.maxFileBytes ?? 2 * 1024 * 1024;

  for (const c of changes) {
    if (!KNOWN.has(c.status)) {
      v.push(`unknown change status '${c.status}' for ${c.path}`);
      continue;
    }
    const paths = c.from ? [c.from, c.path] : [c.path];
    for (const raw of paths) {
      const p = normalizePath(raw);
      const problem = pathProblem(p);
      if (problem) {
        v.push(`${problem}: ${raw}`);
        continue;
      }
      const prot = matchesAny(p, boundary.protectedPaths);
      if (prot) {
        const exc = matchesAny(p, exceptions);
        if (!exc || !hasReason) {
          v.push(`protected path requires scoped exception and reason: ${p} (protected by ${prot})`);
          continue;
        }
      }
      if (!matchesAny(p, allowed)) v.push(`change is outside allowed_changes: ${p}`);
    }
    if (c.symlink) v.push(`symlinks are not allowed: ${c.path}`);
    if (c.bytes !== undefined && c.bytes > maxBytes) v.push(`file exceeds ${maxBytes} bytes: ${c.path}`);
    if (c.status === '!') v.push(`ignored file changed: ${c.path}`);
  }
  if (v.length) throw new BoundaryViolation(v);
}

/** Every write glob a plan asks for must sit inside the manifest's allowedChanges. */
export function writesWithin(writeGlobs: readonly string[], allowedChanges: readonly string[]): string[] {
  const bad: string[] = [];
  for (const w of writeGlobs) if (!allowedChanges.some((a) => globWithin(w, a))) bad.push(w);
  return bad;
}
