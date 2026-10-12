import type { Limits } from '@tecera/contracts';

/**
 * The one rule for a limit a sub-invoke asks to narrow to. Both parsing paths use it: the sandbox host (the
 * child's `invoke` frame) and the invoke loop (the `narrow` option as the broker hands it over). A value
 * that is not a number, not finite or negative is refused, and so is a fraction for a limit that counts
 * things: `min(parent, -1)` or `min(parent, 0.5)` would otherwise pass as a narrowing and then mean
 * something nobody asked for.
 */

/** Every limit name, in a fixed order. */
export const LIMIT_KEYS: ReadonlyArray<keyof Limits> = Object.freeze(['usd', 'tokens', 'calls', 'wallMs', 'depth', 'iterations'] as const);

/** Limits that count things (whole numbers only). `usd` and `wallMs` are amounts and may be fractional. */
export const COUNT_LIMITS: ReadonlySet<keyof Limits> = new Set<keyof Limits>(['tokens', 'calls', 'depth', 'iterations']);

/** Why `value` is not an acceptable value for limit `key`, or null when it is. */
export function limitProblem(key: string, value: unknown): string | null {
  if (!LIMIT_KEYS.includes(key as keyof Limits)) return `unknown limit ${key}`;
  if (typeof value !== 'number' || !Number.isFinite(value)) return `limit ${key} must be a finite number`;
  if (value < 0) return `limit ${key} must not be negative`;
  if (COUNT_LIMITS.has(key as keyof Limits) && !Number.isInteger(value)) return `limit ${key} counts whole things and must be an integer`;
  return null;
}

/** The first problem in a set of requested limits (unknown name, bad value), or null. */
export function limitsProblem(limits: Record<string, unknown> | undefined): string | null {
  for (const [k, v] of Object.entries(limits ?? {})) {
    const why = limitProblem(k, v);
    if (why) return why;
  }
  return null;
}
