import { mockRegistrationProblem, resourceProblem, type CapabilityRecord, type Manifest, type MockToolDeclaration, type ProvisioningAllowance } from '@tecera/contracts';

/**
 * Provisioning and mocks (D10): Tecera creates resources only in its own space and only inside the manifest
 * allowance; a stand-in never serves a capability that is really there. These are the policy answers the
 * runtime's Provisioner and the worker's broker ask before acting; each returns why not (null = allowed).
 */

const NOTHING: ProvisioningAllowance = { scope: 'none', kinds: [], maxResources: 0, ttlSec: 1 };

/** The manifest's provisioning allowance. A manifest without one allows nothing (fail closed). */
export function allowanceOf(m: Pick<Manifest, 'provisioning'> | { provisioning?: ProvisioningAllowance }): ProvisioningAllowance {
  const p = (m as { provisioning?: Partial<ProvisioningAllowance> }).provisioning;
  if (!p || (p.scope !== 'local' && p.scope !== 'none') || !Array.isArray(p.kinds)) return NOTHING;
  const max = typeof p.maxResources === 'number' && Number.isInteger(p.maxResources) && p.maxResources >= 0 ? p.maxResources : 0;
  const ttl = typeof p.ttlSec === 'number' && Number.isFinite(p.ttlSec) && p.ttlSec > 0 ? p.ttlSec : 1;
  return { scope: p.scope, kinds: [...p.kinds], maxResources: max, ttlSec: ttl };
}

/** A request to provision: the capability it serves, the resource kind and how long it should live. */
export interface ProvisionRequest {
  capability: string;
  kind: string;
  /** Requested lifetime; absent = the allowance's ttl. */
  ttlSec?: number;
  /** Where it would be created: only Tecera's own local space is ever allowed. */
  scope?: string;
}

/**
 * Why a provisioning request is outside the allowance (null when it is inside): scope local, a listed kind,
 * fewer than maxResources already provisioned in the run, and a lifetime no longer than ttl.
 */
export function provisionRequestProblem(req: ProvisionRequest, allowance: ProvisioningAllowance, provisionedSoFar: number): string | null {
  if (!req || typeof req.capability !== 'string' || !req.capability) return 'a provisioning request names no capability';
  if (typeof req.kind !== 'string' || !req.kind) return `provisioning for ${req.capability} names no resource kind`;
  if (allowance.scope !== 'local') return `provisioning scope is ${allowance.scope}: nothing may be provisioned`;
  if (req.scope !== undefined && req.scope !== 'local') return `provisioning in scope ${JSON.stringify(req.scope)} is outside the allowance (local only)`;
  if (!allowance.kinds.includes(req.kind)) return `resource kind ${req.kind} is outside the allowance (${allowance.kinds.join(', ') || 'none'})`;
  if (!Number.isInteger(provisionedSoFar) || provisionedSoFar < 0) return 'the run\'s provisioned count is unknown; refusing';
  if (provisionedSoFar >= allowance.maxResources) return `the run already provisioned ${provisionedSoFar} of at most ${allowance.maxResources} resources`;
  if (req.ttlSec !== undefined && (!Number.isFinite(req.ttlSec) || req.ttlSec <= 0 || req.ttlSec > allowance.ttlSec)) return `a lifetime of ${String(req.ttlSec)}s is outside the allowance (${allowance.ttlSec}s)`;
  return null;
}

/**
 * Why a provisioned resource may not be recorded (null when it may): contracts resourceProblem with the
 * allowance (provider, teardown, expiry, locator that is no credential, scope, kind, lifetime) plus the run's
 * maxResources. `secrets` are known secret values the locator must not carry.
 */
export function provisionedResourceProblem(r: unknown, allowance: ProvisioningAllowance, provisionedSoFar: number, secrets?: (value: string) => boolean): string | null {
  const shape = resourceProblem(r, allowance, secrets);
  if (shape) return shape;
  if (!Number.isInteger(provisionedSoFar) || provisionedSoFar < 0) return 'the run\'s provisioned count is unknown; refusing';
  if (provisionedSoFar >= allowance.maxResources) return `the run already provisioned ${provisionedSoFar} of at most ${allowance.maxResources} resources`;
  return null;
}

/**
 * Why a mock may not be declared (null when it may): contracts mockRegistrationProblem against the run's
 * inventory record and the manifest connection. A capability that is available or provisioned is never
 * mocked; nor is a connection the manifest marks not mockable.
 */
export function mockDeclarationProblem(decl: MockToolDeclaration, inventory: readonly CapabilityRecord[], m: Pick<Manifest, 'connections'> | { connections?: Record<string, { mockable?: boolean }> }): string | null {
  const record = (inventory ?? []).find((r) => r.id === decl?.capability);
  const conns = ((m as { connections?: Record<string, { mockable?: boolean }> }).connections ?? {}) as Record<string, { mockable?: boolean }>;
  const connection = decl && Object.prototype.hasOwnProperty.call(conns, decl.capability) ? conns[decl.capability] : undefined;
  return mockRegistrationProblem(decl, record, connection);
}
