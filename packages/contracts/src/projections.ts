import type { Json } from './json.js';
import type { AchievementGoal, Principal } from './bdi.js';
import type { TeceraEvent } from './events.js';
import { approvalAuditProblem } from './ports.js';
import {
  acceptCriteriaActionHash,
  contractHash,
  contractProblem,
  credentialProblem,
  fidelityOf,
  locatorProblem,
  resourceProblem,
  type AcceptanceContract,
  type CapabilityRecord,
  type CapabilityState,
  type Fidelity,
  type ProvisionedResource,
  type ProvisioningAllowance,
} from './acceptance.js';

/**
 * Pure projections over events (no ledger, no database): the accepted contract of a goal, the capability
 * inventory of a run and the provisioned-resource registry. The runtime, the loop, the gates and the bench
 * fold the same events with the same functions, so they cannot disagree about what was accepted, what is
 * available or what is still owed. Events are folded in seq order; events without a seq (a candidate not yet
 * appended) come after every ledger event, in the order given. Caller order never reorders ledger events.
 */

type Ev = TeceraEvent & { seq?: number };
const obj = (v: unknown): Record<string, Json> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Json>) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** Ledger order: by seq; events without a seq last, in the order given (Array.prototype.sort is stable). */
export function ledgerOrder<E extends TeceraEvent>(events: Iterable<E>, runId?: string): Array<E & { seq?: number }> {
  const out: Array<E & { seq?: number }> = [];
  for (const e of events) if (runId === undefined || e.runId === runId) out.push(e);
  const at = (e: { seq?: number }): number => (typeof e.seq === 'number' && Number.isFinite(e.seq) ? e.seq : Number.POSITIVE_INFINITY);
  out.sort((a, b) => (at(a) === at(b) ? 0 : at(a) < at(b) ? -1 : 1));
  return out;
}

const ordered = (events: Iterable<TeceraEvent>, runId?: string): Ev[] => ledgerOrder(events, runId);

/** The actor may decide for Tecera or a person (system or human); a missing actor or an agent may not. */
const notAgent = (a: Principal | undefined): boolean => !!a && (a.kind === 'human' || a.kind === 'system');

function sameActor(a: Principal | undefined, b: Principal | undefined): boolean {
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}

// ── accepted contract ───────────────────────────────────────────────────────────────────────────────

export type AcceptanceState = 'none' | 'drafted' | 'accepted' | 'stale';

export interface AcceptedContract {
  hash: string;
  contract: AcceptanceContract;
  eventId: string;
  via: 'approval' | 'goal-file';
  /** How the contract reached this hash: a fresh draft or an explicit amendment. */
  origin: 'drafted' | 'amended';
  approver?: Principal;
  requestId?: string;
}

export interface AcceptanceView {
  goalId: string;
  /**
   * none: no valid draft. drafted: a contract awaits sign-off. accepted: the current contract is accepted.
   * stale: it was accepted, then amended; the amendment awaits a new sign-off.
   */
  state: AcceptanceState;
  /** Hash of the latest valid draft or amendment: the contract a sign-off must name. */
  current?: string;
  contract?: AcceptanceContract;
  /** Set only when state is 'accepted'. */
  accepted?: AcceptedContract;
  /** The acceptance an amendment made stale (state 'stale'). */
  staleAcceptance?: { hash: string; eventId: string };
  /** Events that were ignored and why (a forged acceptance, a draft whose hash does not match, ...). */
  problems: string[];
}

export interface AcceptanceOptions {
  /** Only this run's events. */
  runId?: string;
  /** Refuse goal-file acceptances (manifest acceptance.signoff 'always'). */
  requireApproval?: boolean;
}

/**
 * The contract of `goalId` and whether it is accepted, from criteria.drafted / accepted / amended:
 * - a draft or amendment counts only when its contract is well formed (contractProblem), names the goal and
 *   hashes to the hash it carries; it becomes `current`;
 * - an acceptance counts only for the current hash, and only when backed: via 'approval', an accept_criteria
 *   request of this run and goal bound to acceptCriteriaActionHash, an audited grant by a human who is not
 *   the requester, consumed before the acceptance, each request accepting once; via 'goal-file', the goal
 *   was adopted in the run with exactly this contractHash, the event is a system's or a human's (never an
 *   agent's, never actorless), and approval is not required;
 * - any amendment, or a draft of another hash, after an acceptance makes it stale (latest accepted hash wins
 *   only until the contract changes).
 */
export function acceptedContractOf(events: Iterable<TeceraEvent>, goalId: string, opts: AcceptanceOptions = {}): AcceptanceView {
  const evs = ordered(events, opts.runId);
  const problems: string[] = [];
  const contracts = new Map<string, AcceptanceContract>();
  const origin = new Map<string, 'drafted' | 'amended'>();
  let current: string | undefined;
  let accepted: AcceptedContract | undefined;
  let stale: { hash: string; eventId: string } | undefined;
  const usedRequests = new Set<string>();
  const adoptedHash = new Map<string, string | undefined>();
  for (let n = 0; n < evs.length; n++) {
    const e = evs[n]!;
    if (e.trace.goalId !== goalId) continue;
    const p = obj(e.payload);
    if (e.kind === 'goal.adopted' && e.runId && !adoptedHash.has(e.runId)) {
      adoptedHash.set(e.runId, str((obj(p.goal) as unknown as Partial<AchievementGoal>).contractHash));
    } else if (e.kind === 'criteria.drafted' || e.kind === 'criteria.amended') {
      const c = p.contract as unknown;
      const claimed = e.kind === 'criteria.drafted' ? str(p.hash) : str(p.to);
      const why = contractProblem(c);
      if (why) {
        problems.push(`${e.kind} ${e.id}: ${why}`);
        continue;
      }
      const contract = c as unknown as AcceptanceContract;
      if (contract.goalId !== goalId) {
        problems.push(`${e.kind} ${e.id}: the contract names goal ${contract.goalId}`);
        continue;
      }
      const h = contractHash(contract);
      if (claimed !== h) {
        problems.push(`${e.kind} ${e.id}: carries hash ${String(claimed)}, the contract hashes to ${h}`);
        continue;
      }
      contracts.set(h, contract);
      origin.set(h, e.kind === 'criteria.amended' ? 'amended' : 'drafted');
      current = h;
      if (accepted && (e.kind === 'criteria.amended' || h !== accepted.hash)) {
        stale = { hash: accepted.hash, eventId: accepted.eventId };
        accepted = undefined;
      }
    } else if (e.kind === 'criteria.accepted') {
      const hash = str(p.hash);
      if (!hash || hash !== current) {
        problems.push(`criteria.accepted ${e.id}: accepts ${String(hash)}, not the current contract ${String(current)}`);
        continue;
      }
      const via = p.via;
      if (via === 'goal-file') {
        if (opts.requireApproval) {
          problems.push(`criteria.accepted ${e.id}: sign-off is required, a goal file does not accept`);
          continue;
        }
        if (!notAgent(e.actor)) {
          problems.push(`criteria.accepted ${e.id}: ${e.actor?.kind === 'agent' ? 'an agent cannot accept criteria' : 'names no system or human actor'}`);
          continue;
        }
        if (!e.runId || adoptedHash.get(e.runId) !== hash) {
          problems.push(`criteria.accepted ${e.id}: the goal was not adopted with contract ${hash}`);
          continue;
        }
        accepted = { hash, contract: contracts.get(hash)!, eventId: e.id, via: 'goal-file', origin: origin.get(hash)! };
        stale = undefined;
      } else if (via === 'approval') {
        const backed = signoffProblem(evs.slice(0, n), e, goalId, hash, usedRequests);
        if (typeof backed === 'string') {
          problems.push(`criteria.accepted ${e.id}: ${backed}`);
          continue;
        }
        usedRequests.add(backed.requestId);
        accepted = { hash, contract: contracts.get(hash)!, eventId: e.id, via: 'approval', origin: origin.get(hash)!, approver: backed.approver, requestId: backed.requestId };
        stale = undefined;
      } else {
        problems.push(`criteria.accepted ${e.id}: unknown acceptance route ${JSON.stringify(via ?? null)}`);
      }
    }
  }
  const state: AcceptanceState = accepted ? 'accepted' : stale ? 'stale' : current ? 'drafted' : 'none';
  return {
    goalId,
    state,
    ...(current ? { current, contract: contracts.get(current)! } : {}),
    ...(accepted ? { accepted } : {}),
    ...(stale && !accepted ? { staleAcceptance: stale } : {}),
    problems,
  };
}

/** The accept_criteria approval behind `acc` (events before it), or why there is none. */
function signoffProblem(before: Ev[], acc: Ev, goalId: string, hash: string, used: Set<string>): { requestId: string; approver: Principal } | string {
  const p = obj(acc.payload);
  const rid = str(p.requestId);
  if (!rid) return 'names no approval';
  if (used.has(rid)) return `approval ${rid} already accepted a contract`;
  if (!acc.runId) return 'belongs to no run';
  const req = before.find((e) => e.kind === 'approval.requested' && obj(e.payload).requestId === rid);
  if (!req) return `approval ${rid} was never requested`;
  if (req.runId !== acc.runId || req.trace.goalId !== goalId) return `approval ${rid} was requested for another run or goal`;
  if (!req.actor || !str(req.actor.id)) return `approval ${rid} names no requester`;
  const rp = obj(req.payload);
  const actionHash = str(rp.actionHash);
  const sessionId = str(rp.sessionId);
  if (!actionHash || !sessionId) return `approval ${rid} lacks its action hash or session`;
  if (actionHash !== acceptCriteriaActionHash({ goalId, runId: acc.runId, contractHash: hash })) return `approval ${rid} is not bound to contract ${hash}`;
  const afterReq = before.slice(before.indexOf(req) + 1);
  const grant = afterReq.find(
    (g) =>
      g.kind === 'approval.granted' &&
      g.actor?.kind === 'human' &&
      !sameActor(g.actor, req.actor) &&
      approvalAuditProblem(g, { requestId: rid, runId: acc.runId!, sessionId, actionHash, approver: g.actor }) === null,
  );
  if (!grant) return `approval ${rid} has no audited grant by a human other than the requester`;
  const consumed = afterReq.slice(afterReq.indexOf(grant) + 1).some((e) => consumedProblem(e, rid, acc.runId!, goalId, actionHash, sessionId) === null);
  if (!consumed) return `approval ${rid} was not consumed before the acceptance`;
  const claimed = p.approver as { kind?: unknown; id?: unknown } | undefined;
  if (claimed !== undefined && (claimed === null || claimed.kind !== grant.actor.kind || claimed.id !== grant.actor.id)) return `approval ${rid}: the acceptance names another approver than the grant`;
  return { requestId: rid, approver: { kind: grant.actor.kind, id: grant.actor.id } };
}

/**
 * Why `e` is not the approval.consumed of request `rid` in `runId` for `goalId` (null when it is): by Tecera
 * itself (a system actor), and when it states the action hash or session, the request's.
 */
export function consumedProblem(e: TeceraEvent, rid: string, runId: string, goalId: string, actionHash: string, sessionId: string): string | null {
  if (e.kind !== 'approval.consumed') return `${e.kind} is not approval.consumed`;
  const p = obj(e.payload);
  if (p.requestId !== rid) return 'names another request';
  if (e.runId !== runId || e.trace.goalId !== goalId) return 'belongs to another run or goal';
  if (e.actor?.kind !== 'system') return 'is not recorded by Tecera';
  if (p.actionHash !== undefined && p.actionHash !== actionHash) return 'names another action hash';
  if (p.sessionId !== undefined && p.sessionId !== sessionId) return 'names another session';
  return null;
}

// ── capability inventory ────────────────────────────────────────────────────────────────────────────

export interface CapabilityInventory {
  records: CapabilityRecord[];
  byId: Record<string, CapabilityRecord>;
  problems: string[];
}

export interface InventoryOptions {
  /** Only this run's events. */
  runId?: string;
  /** The manifest's provisioning allowance: a resource outside it (or past maxResources) never counts. */
  allowance?: ProvisioningAllowance;
  /** Known secret values (containsSecret): a resource whose locator carries one never counts. */
  secrets?: (value: string) => boolean;
}

/**
 * What stands behind each capability in a run, from capability.probed / missing / mocked and
 * resource.provisioned / released. The latest fact wins, except: a probe says 'available' only with its
 * probe command and exit 0 (otherwise it counts as missing); a resource counts as 'provisioned' only when
 * resourceProblem accepts it (inside `allowance` when given, within maxResources per run, its id recorded
 * once), exactly as resourceRegistryOf records it; a mock never replaces an available or provisioned
 * capability (recorded as a problem); releasing a resource returns its capability to 'missing'.
 * Capabilities never mentioned are absent (callers treat absent as 'missing').
 */
export function capabilityInventoryOf(events: Iterable<TeceraEvent>, opts: InventoryOptions = {}): CapabilityInventory {
  const by = new Map<string, CapabilityRecord>();
  const problems: string[] = [];
  const seenResources = new Set<string>();
  const perRun = new Map<string, number>();
  for (const e of ordered(events, opts.runId)) {
    const p = obj(e.payload);
    if (e.kind === 'capability.probed' || e.kind === 'capability.missing') {
      const r = obj(p.capability) as unknown as Partial<CapabilityRecord>;
      const id = str(r.id);
      if (!id || !str(r.kind)) {
        problems.push(`${e.kind} ${e.id}: names no capability`);
        continue;
      }
      const probe = r.probe && typeof r.probe.command === 'string' && r.probe.command.trim() && typeof r.probe.exitCode === 'number' ? { command: r.probe.command, exitCode: r.probe.exitCode } : undefined;
      let state: CapabilityState = e.kind === 'capability.missing' ? 'missing' : r.state === 'available' ? 'available' : 'missing';
      if (state === 'available' && probe?.exitCode !== 0) {
        problems.push(`capability.probed ${e.id}: capability ${id} claims available without a probe that exited 0`);
        state = 'missing';
      }
      const prev = by.get(id);
      // A probe never downgrades what Tecera stands up itself; it only (re)establishes the real state.
      if (prev && (prev.state === 'provisioned' || prev.state === 'mocked') && state === 'missing') continue;
      by.set(id, { id, kind: r.kind!, state, ...(probe ? { probe } : {}) });
    } else if (e.kind === 'resource.provisioned') {
      const r = obj(p.resource) as unknown as Partial<ProvisionedResource>;
      const id = str(r.capability);
      if (!id || !str(r.id) || !str(r.kind)) {
        problems.push(`resource.provisioned ${e.id}: names no capability or resource`);
        continue;
      }
      const why = resourceProblem(p.resource, opts.allowance, opts.secrets);
      if (why) {
        problems.push(`resource.provisioned ${e.id}: ${why}; capability ${id} is not provisioned by it`);
        continue;
      }
      if (seenResources.has(r.id!)) {
        problems.push(`resource.provisioned ${e.id}: resource ${r.id} is recorded twice`);
        continue;
      }
      seenResources.add(r.id!);
      if (r.runId !== undefined && e.runId !== undefined && r.runId !== e.runId) {
        problems.push(`resource.provisioned ${e.id}: resource ${r.id} names run ${r.runId} but was recorded in run ${e.runId}; capability ${id} is not provisioned by it`);
        continue;
      }
      const runId = e.runId ?? r.runId;
      if (runId && opts.allowance) {
        const n = (perRun.get(runId) ?? 0) + 1;
        perRun.set(runId, n);
        if (n > opts.allowance.maxResources) {
          problems.push(`resource.provisioned ${e.id}: run ${runId} is past ${opts.allowance.maxResources} resources; capability ${id} is not provisioned by it`);
          continue;
        }
      }
      if (by.get(id)?.state === 'available') {
        problems.push(`resource.provisioned ${e.id}: capability ${id} is available; the real one is used`);
        continue;
      }
      by.set(id, { id, kind: r.kind!, state: 'provisioned', resourceId: r.id! });
    } else if (e.kind === 'capability.mocked') {
      const id = str(p.capability);
      if (!id) {
        problems.push(`capability.mocked ${e.id}: names no capability`);
        continue;
      }
      const prev = by.get(id);
      if (prev && (prev.state === 'available' || prev.state === 'provisioned')) {
        problems.push(`capability.mocked ${e.id}: capability ${id} is ${prev.state}; a mock may not stand in for it`);
        continue;
      }
      by.set(id, { id, kind: str(p.kind) ?? prev?.kind ?? 'unknown', state: 'mocked', ...(str(p.mockId) ? { resourceId: str(p.mockId)! } : {}) });
    } else if (e.kind === 'resource.released') {
      const rid = str(p.resourceId);
      // Any recorded release ends what the resource proves, even one the registry refuses as a transfer.
      for (const [id, r] of by) if (r.state === 'provisioned' && r.resourceId === rid) by.set(id, { id, kind: r.kind, state: 'missing' });
    }
  }
  const records = [...by.values()];
  return { records, byId: Object.fromEntries(records.map((r) => [r.id, r])), problems };
}

/** The state of each id in the inventory ('missing' when absent). */
export function capabilityStates(inv: Pick<CapabilityInventory, 'byId'>, ids: readonly string[]): CapabilityState[] {
  return ids.map((id) => inv.byId[id]?.state ?? 'missing');
}

/** The fidelity a criterion requiring `requires` can claim on this inventory (fidelityOf); null = cannot be proven. */
export function fidelityFor(inv: Pick<CapabilityInventory, 'byId'>, requires: readonly string[] | undefined): Fidelity | null {
  return fidelityOf(capabilityStates(inv, requires ?? []));
}

// ── provisioned-resource registry ───────────────────────────────────────────────────────────────────

export interface ResourceRegistry {
  /** Every recorded resource with its current transfer state (released and transferred included). */
  resources: ProvisionedResource[];
  byId: Record<string, ProvisionedResource>;
  /** The debts: resources still 'pending' (listed in the PR until a human transfers or releases them). */
  pending: ProvisionedResource[];
  /** Ids of resources past allowance.maxResources in their run: listed debts that should never have been made. */
  overAllowance: string[];
  /**
   * Ids of recorded resources resourceProblem refuses (no teardown, out of the allowance, a credential in the
   * locator, …): listed in `resources` / `byId`, because whatever the event created may exist and is owed a
   * teardown, but never in `pending` (nothing uses, pushes to or transfers a refused resource). A refused
   * record keeps no locator or teardown that is not itself clean ('' instead).
   */
  refused: string[];
  problems: string[];
}

/**
 * Resources from resource.provisioned / released / transferred. A provisioned resource is recorded only when
 * resourceProblem accepts it (a teardown, an expiry, a locator that is no credential nor a known secret,
 * inside `allowance` when given; problems never echo the locator); ids are unique. pending → released (by a
 * human or the system, never an agent or an actorless event) or pending → transferred (by a human only).
 * Nothing leaves those end states. Resources past allowance.maxResources in one run are a problem: they stay
 * listed (they exist and are owed a teardown) and are named in `overAllowance`; callers treat a non-empty
 * `overAllowance` or `problems` as a refusal. Without an allowance, scope, kind and lifetime are unchecked:
 * pass the manifest's whenever there is one.
 */
export function resourceRegistryOf(events: Iterable<TeceraEvent>, opts: { runId?: string; goalId?: string; allowance?: ProvisioningAllowance; secrets?: (value: string) => boolean } = {}): ResourceRegistry {
  const by = new Map<string, ProvisionedResource>();
  const problems: string[] = [];
  const perRun = new Map<string, number>();
  const overAllowance: string[] = [];
  const refused: string[] = [];
  for (const e of ordered(events, opts.runId)) {
    const p = obj(e.payload);
    if (e.kind === 'resource.provisioned') {
      const why = resourceProblem(p.resource, opts.allowance, opts.secrets);
      if (why) {
        problems.push(`resource.provisioned ${e.id}: ${why}`);
        // A refused record is still a debt: list it (once, by id) so it is never silently forgotten.
        const d = refusedDebt(e, p.resource, opts.secrets);
        if (d && !by.has(d.id) && (opts.goalId === undefined || d.goalId === opts.goalId)) {
          by.set(d.id, d);
          refused.push(d.id);
        }
        continue;
      }
      const r = p.resource as unknown as ProvisionedResource;
      if (by.has(r.id)) {
        problems.push(`resource.provisioned ${e.id}: resource ${r.id} is recorded twice`);
        continue;
      }
      // The event's run and goal are the authority; a payload naming others is a problem, never a way to
      // count a resource against another run's allowance.
      const goalId = e.trace.goalId ?? r.goalId;
      const runId = e.runId ?? r.runId;
      if (r.runId !== undefined && e.runId !== undefined && r.runId !== e.runId) problems.push(`resource.provisioned ${e.id}: resource ${r.id} names run ${r.runId} but was recorded in run ${e.runId}`);
      if (r.goalId !== undefined && e.trace.goalId !== undefined && r.goalId !== e.trace.goalId) problems.push(`resource.provisioned ${e.id}: resource ${r.id} names goal ${r.goalId} but was recorded for goal ${e.trace.goalId}`);
      if (opts.goalId !== undefined && goalId !== opts.goalId) continue;
      by.set(r.id, { ...r, ...(goalId ? { goalId } : {}), ...(runId ? { runId } : {}) });
      if (runId) {
        const n = (perRun.get(runId) ?? 0) + 1;
        perRun.set(runId, n);
        if (opts.allowance && n > opts.allowance.maxResources) {
          overAllowance.push(r.id);
          if (n === opts.allowance.maxResources + 1) problems.push(`run ${runId} provisioned more than ${opts.allowance.maxResources} resources`);
        }
      }
    } else if (e.kind === 'resource.released' || e.kind === 'resource.transferred') {
      const rid = str(p.resourceId);
      const r = rid ? by.get(rid) : undefined;
      if (!r) {
        if (opts.goalId === undefined) problems.push(`${e.kind} ${e.id}: unknown resource ${String(rid ?? null)}`);
        continue;
      }
      if (r.transfer !== 'pending') {
        problems.push(`${e.kind} ${e.id}: resource ${r.id} is already ${r.transfer}`);
        continue;
      }
      if (e.kind === 'resource.transferred') {
        const to = obj(p.to) as unknown as Partial<Principal>;
        if (e.actor?.kind !== 'human' || to.kind !== 'human' || !str(to.id)) {
          problems.push(`resource.transferred ${e.id}: only a human takes a resource over`);
          continue;
        }
        by.set(r.id, { ...r, transfer: 'transferred' });
      } else {
        if (!notAgent(e.actor)) {
          problems.push(`resource.released ${e.id}: ${e.actor?.kind === 'agent' ? 'an agent cannot release a resource' : 'names no system or human actor'}`);
          continue;
        }
        by.set(r.id, { ...r, transfer: 'released' });
      }
    }
  }
  const resources = [...by.values()];
  const out = new Set(refused);
  return { resources, byId: Object.fromEntries(resources.map((r) => [r.id, r])), pending: resources.filter((r) => r.transfer === 'pending' && !out.has(r.id)), overAllowance, refused, problems };
}

/**
 * The debt a refused resource.provisioned still records (null when it names no resource id): its id,
 * capability, kind and times as given, the event's run and goal, and its locator and teardown only when
 * they carry no credential or known secret (otherwise ''), so listing the debt never repeats what was refused.
 */
function refusedDebt(e: TeceraEvent, raw: unknown, secrets?: (value: string) => boolean): ProvisionedResource | null {
  const o = obj(raw);
  const id = str(o.id);
  if (!id) return null;
  const locator = typeof o.locator === 'string' && locatorProblem(o.locator, secrets) === null ? o.locator : '';
  const teardown = typeof o.teardown === 'string' && o.teardown.trim() && credentialProblem(o.teardown, 'its teardown', secrets) === null ? o.teardown : '';
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const goalId = e.trace.goalId ?? str(o.goalId);
  const runId = e.runId ?? str(o.runId);
  return {
    id,
    capability: str(o.capability) ?? '',
    kind: str(o.kind) ?? '',
    provider: 'local',
    locator,
    teardown,
    createdAt: num(o.createdAt),
    expiresAt: num(o.expiresAt),
    transfer: 'pending',
    ...(goalId ? { goalId } : {}),
    ...(runId ? { runId } : {}),
  } as ProvisionedResource;
}

/** Pending resources whose expiry has passed at `now` (the runtime releases them on the next run). */
export function expiredResources(reg: Pick<ResourceRegistry, 'pending'>, now: number): ProvisionedResource[] {
  return reg.pending.filter((r) => r.expiresAt <= now);
}
