/**
 * The ledger's hash chains. The single definition lives in @tecera/contracts (chain.ts) so offline replay
 * (deriveGoalStatus) verifies with exactly the same functions; these are re-exports, not copies.
 */
export { GENESIS_HASH, chainHash, evidenceHash, eventsChainProblem } from '@tecera/contracts';
export type { EvidenceLink } from '@tecera/contracts';
