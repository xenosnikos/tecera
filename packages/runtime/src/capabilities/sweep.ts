import { expiredResources, type Ledger, type Principal, type ProvisionedResource, type ProvisioningAllowance, type TeceraEvent } from '@tecera/contracts';
import { projectResources } from '@tecera/ledger';
import type { IdGen } from '../util/ids.js';
import { resourceReleasedEvent } from './events.js';
import type { LocalProvisioner, ReleaseResult } from './provisioner.js';

/**
 * Releasing recorded resources: run the teardown, then record resource.released (only when the teardown
 * exited 0: a resource that may still exist stays a pending debt). The ledger registry is the source of
 * truth; the provisioner's local records only add orphans (created, never recorded) to the expiry sweep.
 */

export interface ReleaseContext {
  ledger: Ledger;
  provisioner: LocalProvisioner;
  /** A system principal (expiry) or the human who asked. Never an agent. */
  actor: Principal;
  ids: IdGen;
  now: () => number;
}

export interface Released extends ReleaseResult {
  /** The resource.released event (absent when the teardown failed). */
  event?: TeceraEvent;
  /**
   * The teardown exited 0 but resource.released could not be appended (why): the ledger still says pending.
   * Releasing again repairs it (the resource is already gone, so the retry only records).
   */
  unrecorded?: string;
}

/**
 * Tear down one recorded resource and record its release. Under the resource lock the ledger is read again:
 * a resource transferred since `r` was read is refused, one released since is a no-op.
 */
export async function releaseRecorded(c: ReleaseContext, r: ProvisionedResource, reason: string): Promise<Released> {
  const guard = async (): Promise<null | { already: true } | { refuse: string }> => {
    const now = (await projectResources(c.ledger, {})).byId[r.id];
    if (now?.transfer === 'transferred') return { refuse: 'a human took it over; Tecera no longer tears it down' };
    if (now?.transfer === 'released') return { already: true };
    return null;
  };
  const res = await c.provisioner.releaseResource(r, { guard });
  if (res.teardownExit !== 0) return res;
  const ev = resourceReleasedEvent(
    { resourceId: r.id, teardownExit: 0, reason, ...(c.actor.kind === 'human' ? { by: c.actor } : {}) },
    { id: c.ids('ev'), at: c.now(), actor: c.actor, ...(r.runId ? { runId: r.runId } : {}) },
  );
  try {
    const appended = await c.ledger.append({ ...ev, idemKey: `resource.released:${r.id}` });
    return { ...res, ...(appended.duplicate ? {} : { event: ev }) };
  } catch (e) {
    return { ...res, unrecorded: (e as Error)?.message ?? String(e) };
  }
}

export interface SweepResult {
  released: Released[];
  /** Recorded resources whose teardown failed or whose release could not be recorded (still pending debts). */
  failed: Released[];
  /** Expired local resources the ledger never recorded, torn down without an event. */
  orphans: ReleaseResult[];
}

/**
 * Release every pending resource whose expiry has passed (the runtime calls it at the start of each run).
 * Transferred resources are never touched. Pass the manifest allowance and the redactor's containsSecret.
 */
export async function releaseExpired(c: ReleaseContext & { allowance?: ProvisioningAllowance; secrets?: (value: string) => boolean }): Promise<SweepResult> {
  const now = c.now();
  const reg = await projectResources(c.ledger, { ...(c.allowance ? { allowance: c.allowance } : {}), ...(c.secrets ? { secrets: c.secrets } : {}) });
  const out: SweepResult = { released: [], failed: [], orphans: [] };
  for (const r of expiredResources(reg, now)) {
    const res = await releaseRecorded(c, r, 'expired');
    (res.teardownExit === 0 && !res.unrecorded ? out.released : out.failed).push(res);
  }
  for (const r of await c.provisioner.list()) {
    const known = reg.byId[r.id];
    if (known?.transfer === 'transferred') {
      c.provisioner.markTransferred(r.id);
      continue;
    }
    if (r.transfer !== 'pending' || r.expiresAt > now || known?.transfer === 'pending') continue;
    // Never recorded (or recorded released while something was left behind): tear down without an event.
    out.orphans.push(await c.provisioner.releaseResource(r));
  }
  return out;
}
