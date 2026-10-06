import { canonicalJson, sha256, type Json } from './json.js';
import type { TeceraEvent } from './events.js';

/**
 * The ledger's hash chains, as pure functions, so offline replay (deriveGoalStatus) can verify a chain
 * without the ledger package. @tecera/ledger re-exports these; there is exactly one definition.
 */

export const GENESIS_HASH = '0'.repeat(64);

/** Hash of an event given the previous link. Excludes nothing: id, kind, at, actor, runId, trace, payload, idemKey. */
export function chainHash(prevHash: string, e: TeceraEvent): string {
  const body: Json = {
    id: e.id,
    kind: e.kind,
    at: e.at,
    actor: { kind: e.actor.kind, id: e.actor.id },
    runId: e.runId ?? null,
    trace: {
      goalId: e.trace.goalId ?? null,
      intentionId: e.trace.intentionId ?? null,
      stepId: e.trace.stepId ?? null,
      planId: e.trace.planId ?? null,
    },
    payload: e.payload,
    idemKey: e.idemKey ?? null,
  };
  return sha256(prevHash + canonicalJson(body));
}

/** The fields of one evidence row that its chain hash covers. */
export interface EvidenceLink {
  n: number;
  key: string;
  kind: string;
  runId: string;
  digest: string;
  seq: number;
  /** Hash of the event at `seq` when the row was written (GENESIS_HASH when seq is 0). */
  eventHash: string;
}

/** Evidence chain: each row links to the previous evidence row and to the events head at its seq. */
export function evidenceHash(prevHash: string, l: EvidenceLink): string {
  return sha256(prevHash + canonicalJson({ n: l.n, key: l.key, kind: l.kind, runId: l.runId, digest: l.digest, seq: l.seq, eventHash: l.eventHash }));
}

/**
 * Verify an events chain from its rows alone: seq must run 1..N without a gap and each hash must equal
 * chainHash(previous hash, event). Returns null when valid, else the problem. Pass the WHOLE ledger (every
 * run): the chain spans runs, so a filtered list cannot be verified (it reports a gap).
 */
export function eventsChainProblem(events: ReadonlyArray<TeceraEvent & { seq: number; hash: string }>): string | null {
  let prev = GENESIS_HASH;
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!;
    if (e.seq !== i + 1) return `events chain has a gap at seq ${i + 1} (found ${e.seq})`;
    let h: string;
    try {
      h = chainHash(prev, e);
    } catch (err) {
      return `event at seq ${e.seq} cannot be hashed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (h !== e.hash) return `events chain broken at seq ${e.seq}`;
    prev = e.hash;
  }
  return null;
}
