import type { Manifest, ProvenOptions, Redactor } from '@tecera/contracts';
import { allowanceOf } from '@tecera/policy';

/**
 * The options every "proven achieved" decision of the runtime passes to contracts provenAchievement /
 * provenRun / ledgerProvenRun (Stop hook, exit status, status, replay): the manifest's provisioning
 * allowance (a resource outside it never raises a criterion's fidelity), sign-off 'always' as
 * requireApproval, and the run's known secrets (a locator carrying one proves nothing).
 */
export function provenOptionsOf(m: Manifest, redactor?: Redactor): Omit<ProvenOptions, 'chain'> {
  return {
    allowance: allowanceOf(m),
    ...(m.acceptance?.signoff === 'always' ? { requireApproval: true } : {}),
    ...(redactor ? { secrets: (v: string) => redactor.containsSecret(v) !== null } : {}),
  };
}
