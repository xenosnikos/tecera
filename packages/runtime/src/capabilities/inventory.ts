import { resolveGap, type AcceptanceContract, type CapabilityNeed, type CapabilityRecord, type GapResolution, type ProvisioningAllowance } from '@tecera/contracts';
import type { Connections } from './probe.js';

/**
 * The inventory a plan is written against (D9, D10): for every capability the accepted contract requires,
 * what stands behind it in this run and which rung of the gap ladder resolves it.
 *
 * - `use`: a probe of the declared connection exited 0 (or a resource / stand-in is already serving it);
 * - `provision`: missing, and the allowance (scope local, kind allowed, room left in the run) and the
 *   provisioner's kinds let Tecera create one in its own space;
 * - `mock`: missing, not provisionable, and the connection allows a stand-in (manifest `mockable`, default
 *   true; an undeclared need is mockable unless the planner said otherwise);
 * - `ask`: none of the above; the plan that needs it is refused.
 *
 * Pure: the same inputs give the same decisions in the runtime, the validator and the benchmark.
 */

export interface InventoryDecision {
  id: string;
  kind: string;
  /** Declared in the manifest's `connections`. */
  declared: boolean;
  mockable: boolean;
  /** What stands behind it now ('missing' when nothing does). */
  state: CapabilityRecord['state'];
  resolution: GapResolution;
  /** Criteria that rest on it (from the contract or the planner's need). */
  criteria: string[];
  reason: string;
}

export interface InventoryInput {
  connections: Connections;
  allowance: ProvisioningAllowance;
  /** The capability ids the contract requires, or the planner's needs (which carry kind and mockable). */
  required: ReadonlyArray<string | CapabilityNeed>;
  /** Probe results and any other facts of this run (provisioned / mocked rows); the latest per id wins (see factsOf). */
  probes: readonly CapabilityRecord[];
  /** Resources already provisioned in this run (counts toward maxResources). */
  provisionedSoFar?: number;
  /** Kinds the provisioner can create (default: the allowance alone decides). */
  provisionable?: readonly string[];
  /** The contract: its required capabilities are always needs, and its criteria fill `criteria`. */
  contract?: AcceptanceContract;
}

export interface Inventory {
  records: CapabilityRecord[];
  decisions: InventoryDecision[];
  /** Ids resolving to `ask`: a plan needing them is refused. */
  asks: string[];
}

/** The capability ids an acceptance contract's criteria require (sorted, unique). */
export function requiredCapabilities(contract: Pick<AcceptanceContract, 'criteria'>): string[] {
  return [...new Set(contract.criteria.flatMap((k) => k.requires ?? []))].sort();
}

function usable(r: CapabilityRecord | undefined): boolean {
  if (!r) return false;
  if (r.state === 'available') return !!r.probe && !!r.probe.command.trim() && r.probe.exitCode === 0;
  return r.state === 'provisioned' && !!r.resourceId?.trim();
}

/**
 * The fact per id: the latest row wins, except that a later 'available' never overrides a probe that
 * failed in this run (only a resource or a stand-in, which name what replaced it, supersede a failed probe).
 */
function factsOf(rows: readonly CapabilityRecord[]): Map<string, CapabilityRecord> {
  const out = new Map<string, CapabilityRecord>();
  for (const p of rows) {
    const prev = out.get(p.id);
    if (prev?.state === 'missing' && prev.probe && p.state === 'available') continue;
    out.set(p.id, p);
  }
  return out;
}

export function buildInventory(i: InventoryInput): Inventory {
  const latest = factsOf(i.probes);
  const needs = new Map<string, CapabilityNeed | { id: string }>();
  // The contract's requirements are always in scope; the planner's needs add to them, never replace them.
  for (const n of [...i.required, ...(i.contract ? requiredCapabilities(i.contract) : [])]) {
    const need = typeof n === 'string' ? { id: n } : n;
    if (!needs.has(need.id)) needs.set(need.id, need);
  }
  const byCriterion = (id: string): string[] => (i.contract ? i.contract.criteria.filter((k) => (k.requires ?? []).includes(id)).map((k) => k.id) : []);
  let soFar = i.provisionedSoFar ?? 0;
  const decisions: InventoryDecision[] = [];
  const records: CapabilityRecord[] = [];
  for (const id of [...needs.keys()].sort()) {
    const need = needs.get(id)!;
    const conn = Object.prototype.hasOwnProperty.call(i.connections, id) ? i.connections[id] : undefined;
    const planned = 'kind' in need ? need : undefined;
    const kind = conn?.kind ?? planned?.kind ?? 'undeclared';
    // The manifest's word wins: a connection declared not mockable is never stood in for.
    const mockable = conn ? conn.mockable !== false && (planned?.mockable ?? true) : (planned?.mockable ?? true);
    const fact = latest.get(id);
    const criteria = [...new Set([...(planned?.criteria ?? []), ...byCriterion(id)])].sort();
    const base = { id, kind, declared: !!conn, mockable, criteria };
    if (usable(fact)) {
      records.push(fact!);
      decisions.push({ ...base, state: fact!.state, resolution: 'use', reason: fact!.state === 'available' ? `probe exited 0` : `resource ${fact!.resourceId ?? ''} serves it`.trim() });
      continue;
    }
    if (fact?.state === 'mocked') {
      records.push(fact);
      decisions.push({ ...base, state: 'mocked', resolution: mockable ? 'mock' : 'ask', reason: mockable ? 'a stand-in already serves it' : 'a stand-in serves it but the connection is not mockable' });
      continue;
    }
    const missing: CapabilityRecord = { id, kind, state: 'missing', ...(fact?.probe ? { probe: fact.probe } : {}) };
    records.push(missing);
    const provisionable = !i.provisionable || i.provisionable.includes(kind);
    const allowance = provisionable ? i.allowance : { ...i.allowance, kinds: [] };
    const resolution = resolveGap({ kind, available: false, mockable }, allowance, soFar);
    if (resolution === 'provision') soFar++;
    const why = !conn
      ? 'not declared in the manifest'
      : fact?.probe
        ? `probe exited ${fact.probe.exitCode}`
        : fact
          ? 'not available'
          : 'not probed';
    const how = resolution === 'provision' ? `provision a local ${kind}` : resolution === 'mock' ? 'serve a stand-in (fidelity mocked)' : 'ask the requestor (not provisionable within the allowance, not mockable)';
    decisions.push({ ...base, state: 'missing', resolution, reason: `${why}: ${how}` });
  }
  return { records, decisions, asks: decisions.filter((d) => d.resolution === 'ask').map((d) => d.id) };
}
