/**
 * Hardened mode: the types shared by the ledger (head checkpoint) and the runtime (run registry, operator
 * boundary). Hardened mode puts Tecera's authoritative state (ledger, run registry, head checkpoint) in a
 * directory owned by an operator identity that the agent identity cannot write. Nothing here is used in
 * single-user mode.
 */

/** Format of a head checkpoint (and of the pending-transition journal that carries two of them). */
export const LEDGER_HEAD_FORMAT = 1;

/** What a ledger's database says about its own head: derivable from the database alone. */
export interface LedgerHeadState {
  /** The id written into the database when it was enrolled (null: never enrolled). */
  ledgerId: string | null;
  /** Highest event seq (the events are numbered 1..N without a gap; verifyChain checks it). */
  eventCount: number;
  /** Hash of the last event (GENESIS when there is none). */
  eventHeadHash: string;
  /** Highest evidence n. */
  evidenceCount: number;
  /** Hash of the last evidence row (GENESIS when there is none). */
  evidenceHeadHash: string;
}

/**
 * The checkpoint kept outside the database, in the protected state: the latest acknowledged head of both
 * chains. `generation` grows by one on every acknowledged write that changed either chain.
 */
export interface LedgerHead {
  ledgerId: string;
  formatVersion: number;
  eventCount: number;
  eventHeadHash: string;
  evidenceCount: number;
  evidenceHeadHash: string;
  generation: number;
  /**
   * How the ledger was enrolled: 'genesis' (created empty under hardened mode) or 'legacy' (an existing
   * ledger whose current head was accepted once, explicitly; its earlier history is not authenticated).
   */
  baseline: 'genesis' | 'legacy';
  /** When the ledger was enrolled (ms). */
  enrolledAt: number;
  /** When this head was written (ms). */
  at: number;
}

/** One write in flight: the head before it and the head it will be once committed. */
export interface LedgerHeadTransition {
  from: LedgerHead;
  to: LedgerHead;
}

/**
 * A run's state in the run registry. Only the supervisor writes the registry. `terminal` is the only state
 * that lets the Stop hook ignore a run; every other state keeps it open whatever the ledger's events say.
 * A `running` entry whose heartbeat is stale is reported as interrupted, never as finished.
 */
export type RunRegistryState = 'registered' | 'running' | 'held' | 'interrupted' | 'provisional' | 'terminal';

export interface RunRegistryEntry {
  formatVersion: number;
  runId: string;
  goalId: string | null;
  /** The business case the run belongs to (hardened state directory name). */
  caseId: string;
  /** 1 for the first segment, +1 for every resume. */
  generation: number;
  state: RunRegistryState;
  /** Why the run is terminal (null while it is not). */
  terminalReason: string | null;
  /** The exit code of the segment that last ended (null while one is running). */
  exitCode: number | null;
  registeredAt: number;
  updatedAt: number;
  /** Last heartbeat of the running segment (ms). */
  heartbeatAt: number;
  /** The supervising process (informational). */
  pid: number;
  /** uid of the process that wrote the entry. */
  uid: number;
  /** 'run': registered by `tecera run`; 'enrolled': imported from the ledger when it was enrolled. */
  source: 'run' | 'enrolled';
}

/** The OS identity a hardened decision was authorized on (from the process credentials). */
export interface OsDecisionIdentity {
  uid: number;
  euid: number;
  gid: number;
  /** The login name of the uid, when the host's user database names it (informational). */
  user?: string;
  /** Always 'operator-uid': the caller's real and effective uid are the configured operator identity. */
  boundary: 'operator-uid';
}
