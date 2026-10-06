import { readLock } from './manifest/load.js';
import { validateBusinessCase } from './manifest/validate.js';
import type { Runtime } from './runtime.js';

/**
 * Execution readiness: what must hold before tecera runs repository code (a baseline check) or calls a
 * model. A failing test is the job; a failed readiness check is not — it stops the command with exit 3
 * before anything executes:
 *
 * - the full offline validation passes (schema, runtime range, inline-secret scan of tecera.json and every
 *   file under .tecera/, envAllowlist safety, globs, goals, adapters, lock drift);
 * - a lock file exists (validate only warns when it is missing);
 * - the ledger hash chain verifies;
 * - every provider a seat uses has a resolved credential (when `needCredentials`).
 */

export interface ReadinessProblem {
  check: string;
  detail: string;
}

export async function executionReadiness(rt: Runtime, opts: { needCredentials: boolean }): Promise<ReadinessProblem[]> {
  const out: ReadinessProblem[] = [];
  const v = validateBusinessCase(rt.manifestPath);
  for (const i of v.issues) if (i.level === 'error') out.push({ check: 'validate', detail: `${i.where}: ${i.message}` });
  try {
    if (!readLock(rt.root)) out.push({ check: 'lock', detail: 'no .tecera/tecera.lock; review the business case, then `tecera doctor --fix`' });
  } catch (e) {
    out.push({ check: 'lock', detail: (e as Error).message });
  }
  if (rt.ledgerExists()) {
    try {
      const chain = await rt.ledger().verifyChain();
      if (!chain.ok) out.push({ check: 'ledger', detail: `hash chain broken at seq ${chain.brokenAtSeq}` });
    } catch (e) {
      out.push({ check: 'ledger', detail: `cannot verify the ledger: ${(e as Error).message}` });
    }
  }
  if (opts.needCredentials) {
    const s = rt.manifest.seats;
    const used = new Set([s.planner.provider, s.reviewer.provider, ...s.workers.map((w) => w.provider)]);
    for (const st of rt.secretStatus) {
      if (used.has(st.provider) && !st.resolved) out.push({ check: 'credentials', detail: `provider ${st.provider}: ${st.envName ? `${st.envName} not set` : 'reference unresolved'}` });
    }
  }
  return out.map((p) => ({ check: p.check, detail: rt.redact(p.detail) }));
}
