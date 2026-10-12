import type { JsonObject } from './json.js';
import type { AchievementGoal, AchievementProof, Principal } from './bdi.js';
import type { AcceptanceContract, CapabilityNeed, CapabilityRecord, GapResolution, ProvisionedResource } from './acceptance.js';

/**
 * Payload shapes of the acceptance, capability and provisioning event kinds. validateEvent stays
 * structural (kind, trace, object payload); these types document what writers put in and what the pure
 * projections (projections.ts) read back. Build a payload with `payloadOf(kind, p)`.
 */

/** goal.provisional: every criterion is proven, at least one on a mock. The goal stays open. */
export interface GoalProvisionalPayload {
  /** The goal with status unchanged and `provisional: true` (markProvisional). */
  goal: AchievementGoal;
  /** Well formed, resting on a mock (provisionalProofProblem). */
  proof: AchievementProof;
  /** Ids of the criteria proven only against a stand-in. */
  mocked: string[];
  reason: string;
}

/** criteria.drafted: a contract proposed for the goal. `hash` = contractHash(contract). */
export interface CriteriaDraftedPayload {
  contract: AcceptanceContract;
  hash: string;
  needs: CapabilityNeed[];
  /** 'planner' (drafted from a statement) or 'goal-file' (criteria front matter). */
  source: 'planner' | 'goal-file';
}

/**
 * criteria.accepted: the contract with `hash` is accepted; work may start.
 * via 'approval': `requestId` names an accept_criteria approval (acceptCriteriaActionHash, signoffTrace)
 * granted by a human who is not the requester and consumed before this event; `approver` is that human.
 * via 'goal-file': the goal was adopted with exactly this contractHash and the manifest skips sign-off.
 */
export interface CriteriaAcceptedPayload {
  hash: string;
  via: 'approval' | 'goal-file';
  requestId?: string;
  approver?: Principal;
}

/** criteria.amended: the contract changed (`from` → `to` = contractHash(contract)). Any earlier acceptance is stale. */
export interface CriteriaAmendedPayload {
  from: string;
  to: string;
  contract: AcceptanceContract;
  reason: string;
}

/** capability.probed: a declared connection was probed for real. record.state is 'available' or 'missing'. */
export interface CapabilityProbedPayload {
  capability: CapabilityRecord;
}

/** capability.missing: a need the inventory cannot serve, with the gap-ladder rung chosen for it. */
export interface CapabilityMissingPayload {
  capability: CapabilityRecord;
  criteria: string[];
  resolution: GapResolution;
}

/** capability.mocked: a stand-in started serving the capability (first use). Never for an available capability. */
export interface CapabilityMockedPayload {
  capability: string;
  kind: string;
  tool: string;
  mockId: string;
  reason: string;
}

/** resource.provisioned: a resource in Tecera's own space (resourceProblem must be null). */
export interface ResourceProvisionedPayload {
  resource: ProvisionedResource;
}

/** resource.released: the recorded teardown ran (exit code), by a human or on expiry. */
export interface ResourceReleasedPayload {
  resourceId: string;
  teardownExit: number;
  reason: string;
  by?: Principal;
}

/** resource.transferred: a human took the resource over; Tecera no longer tears it down. */
export interface ResourceTransferredPayload {
  resourceId: string;
  to: Principal;
  note?: string;
}

export interface AcceptanceEventPayloads {
  'goal.provisional': GoalProvisionalPayload;
  'criteria.drafted': CriteriaDraftedPayload;
  'criteria.accepted': CriteriaAcceptedPayload;
  'criteria.amended': CriteriaAmendedPayload;
  'capability.probed': CapabilityProbedPayload;
  'capability.missing': CapabilityMissingPayload;
  'capability.mocked': CapabilityMockedPayload;
  'resource.provisioned': ResourceProvisionedPayload;
  'resource.released': ResourceReleasedPayload;
  'resource.transferred': ResourceTransferredPayload;
}

/** Type-checked payload for one of the kinds above, as the JsonObject an event carries. */
export function payloadOf<K extends keyof AcceptanceEventPayloads>(kind: K, p: AcceptanceEventPayloads[K]): JsonObject {
  void kind;
  return JSON.parse(JSON.stringify(p)) as JsonObject;
}
