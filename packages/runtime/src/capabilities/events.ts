import { event, payloadOf, resourceProblem, type CapabilityRecord, type Principal, type ProvisionedResource, type ProvisioningAllowance, type TeceraEvent, type Trace } from '@tecera/contracts';

/**
 * Builders for the capability and resource events the runtime appends. Each goes through `event()` (the
 * structural check, required trace ids) and `payloadOf` (the payload shape). Nothing here appends: the
 * caller owns the ledger, the actor and the ids.
 */

export interface EventBase {
  id: string;
  at: number;
  actor: Principal;
  runId?: string;
}

/** capability.probed: the record a probe produced. Agents never probe. */
export function capabilityProbedEvent(record: CapabilityRecord, base: EventBase): TeceraEvent {
  if (base.actor.kind === 'agent') throw new Error('capability.probed is recorded by the system, never an agent');
  return event('capability.probed', { ...base, trace: {}, payload: payloadOf('capability.probed', { capability: record }) }) as TeceraEvent;
}

/**
 * resource.provisioned for `r` (goal trace from r.goalId or `trace`). Throws when resourceProblem refuses it,
 * so a resource the projections would drop is never written.
 */
export function resourceProvisionedEvent(
  r: ProvisionedResource,
  base: EventBase & { trace?: Trace; allowance?: ProvisioningAllowance; secrets?: (value: string) => boolean },
): TeceraEvent {
  const why = resourceProblem(r, base.allowance, base.secrets);
  if (why) throw new Error(`resource.provisioned refused: ${why}`);
  const goalId = r.goalId ?? base.trace?.goalId;
  if (!goalId) throw new Error(`resource.provisioned refused: resource ${r.id} names no goal`);
  if (r.runId && base.runId && r.runId !== base.runId) throw new Error(`resource.provisioned refused: resource ${r.id} belongs to run ${r.runId}, not ${base.runId}`);
  const { allowance: _a, secrets: _s, trace, ...rest } = base;
  return event('resource.provisioned', { ...rest, trace: { ...(trace ?? {}), goalId }, payload: payloadOf('resource.provisioned', { resource: r }) }) as TeceraEvent;
}

/** resource.released: the recorded teardown ran with `teardownExit` (0 only: a failed teardown is no release). */
export function resourceReleasedEvent(a: { resourceId: string; teardownExit: number; reason: string; by?: Principal }, base: EventBase): TeceraEvent {
  if (base.actor.kind === 'agent') throw new Error('an agent cannot release a resource');
  if (a.teardownExit !== 0) throw new Error(`resource ${a.resourceId}: the teardown exited ${a.teardownExit}; it is not released`);
  return event('resource.released', { ...base, trace: {}, payload: payloadOf('resource.released', a) }) as TeceraEvent;
}

/** resource.transferred: a human takes the resource over (the actor and `to` are humans). */
export function resourceTransferredEvent(a: { resourceId: string; to: Principal; note?: string }, base: EventBase): TeceraEvent {
  if (base.actor.kind !== 'human' || a.to.kind !== 'human') throw new Error('only a human takes a resource over');
  return event('resource.transferred', { ...base, trace: {}, payload: payloadOf('resource.transferred', a) }) as TeceraEvent;
}
