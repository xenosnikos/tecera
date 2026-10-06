import { appendFileSync } from 'node:fs';

/**
 * Known gaps, scoped to ONE known failing assertion.
 *
 * A gap test is a plain `it` whose name carries "GAP (owner: …)". Everything before `expectGap` (building the
 * repo, running the attack, proving the injection fired, orphan checks) and every guarantee the components
 * ALREADY meet (e.g. S5's at-most-once reviewer call) are ordinary assertions OUTSIDE the gap: if any of them
 * fails, the test fails. Only `check`, the single §6 expected outcome the components do not meet yet, goes
 * inside `expectGap`, together with the exact failure it is known to produce:
 *
 *  - `known.assertion`: the message label of the one `expect(value, label)` that fails today. The failure is
 *    accepted ONLY when it is a vitest/chai `AssertionError` whose message starts with `<label>: ` (and, when
 *    given, also matches `known.detail`). Anything else thrown inside `check` — a TypeError, a harness or setup
 *    error, a different assertion (another guarantee regressing), a timeout — is NOT the known gap and fails
 *    the test as "UNEXPECTED failure inside gap", with the original error as its cause.
 *  - default: `check` must throw exactly the known failure (the gap is still open). If it passes, the test fails
 *    with "GAP CLOSED" so the case is turned into a plain assertion and its CASE_INDEX/ACCEPTANCE_INDEX status
 *    updated in the same change.
 *  - TECERA_ADV_STRICT=1: `check` runs as a plain assertion (shows the real failure, raw).
 *
 * Keep `check` minimal: put ONLY the gap assertion (and the steps it needs) in it. Assertions after the known
 * one never run while the gap is open, so nothing that is already guaranteed may sit behind it.
 *
 * Every open gap's failing assertion is printed (and appended to $TECERA_ADV_GAP_REPORT when set) so a report
 * can quote it exactly. acceptance.no_gaps (src/acceptance.test.ts) fails while any CASE_INDEX or
 * ACCEPTANCE_INDEX entry is a gap, unless TECERA_PHASE1_OPEN=1.
 */

export const STRICT = process.env.TECERA_ADV_STRICT === '1';

export interface KnownFailure {
  /** The label of the failing `expect(value, label)`: the accepted failure's message starts with `${assertion}: `. */
  assertion: string;
  /** Optional further constraint on the full failure message (e.g. the exact actual value seen today). */
  detail?: RegExp;
}

export interface GapRecord {
  id: string;
  owner: string;
  assertion: string;
}

export const openGaps: GapRecord[] = [];

/** True when `e` is exactly the known failing assertion. */
export function isKnownFailure(e: unknown, known: KnownFailure): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name !== 'AssertionError') return false;
  if (!e.message.startsWith(`${known.assertion}: `)) return false;
  return known.detail ? known.detail.test(e.message) : true;
}

export async function expectGap(id: string, owner: string, known: KnownFailure, check: () => unknown | Promise<unknown>): Promise<void> {
  if (!known || typeof known.assertion !== 'string' || !known.assertion) throw new Error(`expectGap(${id}): the known failing assertion must be named`);
  let failure: unknown = null;
  let failed = false;
  try {
    await check();
  } catch (e) {
    failure = e;
    failed = true;
  }
  if (STRICT) {
    if (failed) throw failure;
    return;
  }
  if (!failed) throw new Error(`GAP CLOSED: ${id} now meets its §6 outcome (owner ${owner}). Make it a plain assertion and update CASE_INDEX/ACCEPTANCE_INDEX.`);
  if (!isKnownFailure(failure, known)) {
    const msg = failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure);
    throw new Error(`UNEXPECTED failure inside gap ${id} (owner ${owner}): only "${known.assertion}"${known.detail ? ` matching ${known.detail}` : ''} is the known gap.\n${msg}`, { cause: failure });
  }
  const assertion = (failure as Error).message.split('\n').slice(0, 12).join('\n').slice(0, 1500);
  const rec = { id, owner, assertion };
  openGaps.push(rec);
  console.log(`[adversarial gap] ${id} (owner: ${owner})\n${assertion}`);
  const out = process.env.TECERA_ADV_GAP_REPORT;
  if (out) {
    try {
      appendFileSync(out, `${JSON.stringify(rec)}\n`);
    } catch {
      /* the report file is a convenience; the console line above is the record */
    }
  }
}
