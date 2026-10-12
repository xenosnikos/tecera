import { contractHash, contractProblem, fidelityFor, weakestFidelity, type AcceptanceContract, type CapabilityRecord, type Criterion, type Fidelity } from '@tecera/contracts';
import type { StepContext } from './types.js';

/**
 * Acceptance contracts at the gates (owner decisions D8, D11). GateContext.contract is the accepted contract
 * the goal is held to; absent, the gates keep the single-check path (goal.check alone). A goal that names a
 * contract (criteria or contractHash on the adopted goal) without GateContext carrying one is refused: a
 * gate never silently falls back to the single check for a goal that was promised criteria.
 *
 * Fidelity is never stronger than the capabilities a criterion requires allow (fidelityFor over the
 * inventory); every source the gate is handed is folded with weakestFidelity, so a mock stays a mock.
 */

export type ContractResolution = { ok: true; contract?: undefined; hash?: undefined } | { ok: true; contract: AcceptanceContract; hash: string } | { ok: false; reason: string };

/** The contract GateContext holds the goal to, checked for shape, goal and hash; or the single-check path. */
export function contractOf(ctx: Pick<StepContext, 'contract' | 'contractHash' | 'goal'>): ContractResolution {
  if (ctx.contract === undefined || ctx.contract === null) {
    const g = ctx.goal as { criteria?: unknown; contractHash?: unknown };
    if ((Array.isArray(g.criteria) && g.criteria.length > 0) || typeof g.contractHash === 'string') return { ok: false, reason: 'the goal is held to an acceptance contract and GateContext carries none' };
    if (ctx.contractHash !== undefined) return { ok: false, reason: 'GateContext names a contract hash but carries no contract' };
    return { ok: true };
  }
  const why = contractProblem(ctx.contract);
  if (why) return { ok: false, reason: `GateContext contract: ${why}` };
  const contract = ctx.contract;
  if (contract.goalId !== ctx.goal.id) return { ok: false, reason: `GateContext contract is for goal ${contract.goalId}, not ${ctx.goal.id}` };
  const hash = contractHash(contract);
  if (ctx.contractHash !== undefined && ctx.contractHash !== hash) return { ok: false, reason: 'GateContext contractHash is not the hash of its contract' };
  return { ok: true, contract, hash };
}

/** The command criteria of a contract, in contract order. */
export function commandCriteria(c: AcceptanceContract): Array<Criterion & { check: { kind: 'command'; command: string; timeoutSec: number } }> {
  return c.criteria.filter((k): k is Criterion & { check: { kind: 'command'; command: string; timeoutSec: number } } => k.check.kind === 'command');
}

/** byId view of an inventory list (the shape fidelityFor reads). */
export function inventoryById(records: readonly CapabilityRecord[] | undefined): { byId: Record<string, CapabilityRecord> } {
  const byId: Record<string, CapabilityRecord> = {};
  for (const r of records ?? []) if (r && typeof r.id === 'string') byId[r.id] = r;
  return { byId };
}

/**
 * The fidelity a criterion can claim: the weakest over every inventory given (null = a required
 * capability is missing in one of them, so the criterion cannot be proven) and every fidelity already
 * claimed for it (a recorded or reported 'mocked' is never upgraded).
 */
export function criterionFidelity(requires: readonly string[] | undefined, inventories: ReadonlyArray<{ byId: Record<string, CapabilityRecord> }>, claimed: ReadonlyArray<Fidelity | undefined> = []): Fidelity | null {
  const out: Fidelity[] = [];
  for (const inv of inventories) {
    const f = fidelityFor(inv, requires);
    if (f === null) return null;
    out.push(f);
  }
  for (const c of claimed) if (c !== undefined) out.push(c);
  return weakestFidelity(out);
}

/**
 * The inventory a verify step holds criteria to: GateContext's, where a capability it lists as missing (or not
 * at all) is mocked when the run's ledger inventory says a stand-in served it (capability.mocked recorded after
 * the loop built the context). Nothing else is taken from the ledger: a mock never raises a missing capability
 * above mocked, and an available or provisioned row is never replaced by one.
 */
export function withLedgerMocks(inv: { byId: Record<string, CapabilityRecord> }, ledger: { byId: Record<string, CapabilityRecord> }): { byId: Record<string, CapabilityRecord> } {
  const byId = { ...inv.byId };
  for (const [id, r] of Object.entries(ledger.byId)) if (r.state === 'mocked' && (byId[id]?.state ?? 'missing') === 'missing') byId[id] = r;
  return { byId };
}

/** Provisioned resource kinds a criterion's own process opens by locator (a git remote serves the PR delivery instead). */
export const LOCATED_KINDS: ReadonlySet<string> = new Set(['sqlite', 'tmpdir', 'http-stub']);

/**
 * Located kinds a criterion's process cannot reach: a criterion runs without network (its own network
 * namespace, loopback down), and an http-stub listens on the host's loopback. Its locator is not handed to
 * the criterion, and a criterion that requires it never touched it: it counts as mocked (provisional), not
 * as proven against the stub. Only the worker's brokered tool reaches the stub.
 */
export const NETWORK_KINDS: ReadonlySet<string> = new Set(['http-stub']);

/** The environment variable a contained criterion reads a provisioned resource's locator from. */
export function resourceEnvName(capability: string): string {
  return `TECERA_RESOURCE_${capability.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/** True when a criterion command uses the provisioned resource: it names its variable or its locator. */
export function commandUsesResource(command: string, capability: string, locator: string): boolean {
  return command.includes(resourceEnvName(capability)) || (locator.length > 0 && command.includes(locator));
}

/** `export NAME='value'; ` for each entry, single-quoted for /bin/sh (names are checked, values never expand). */
export function shellExports(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .filter(([k]) => /^[A-Z_][A-Z0-9_]*$/.test(k))
    .map(([k, v]) => `export ${k}='${v.replace(/'/g, `'\\''`)}'; `)
    .join('');
}
