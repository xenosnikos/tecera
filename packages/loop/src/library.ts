import type { BeliefProjection, Plan, PlanLibrary, TeceraEvent } from '@tecera/contracts';

/**
 * In-memory plan library (procedural memory). Matching is trigger kind + optional payload equality +
 * every context pattern holding in the belief projection. Candidates (status 'candidate') are not
 * matched unless `includeCandidates` is set: a generated plan must graduate before it is reused.
 */
export class MemoryPlanLibrary implements PlanLibrary {
  private readonly plans = new Map<string, Plan>();

  constructor(private readonly opts: { includeCandidates?: boolean } = {}) {}

  async match(e: TeceraEvent, beliefs: BeliefProjection): Promise<Plan[]> {
    const out: Plan[] = [];
    for (const p of this.plans.values()) {
      if (p.status === 'rejected' || p.status === 'retracted') continue;
      if (p.status === 'candidate' && !this.opts.includeCandidates) continue;
      if (!triggerMatches(p, e)) continue;
      if (!p.context.every((c) => beliefs.match(c))) continue;
      out.push(p);
    }
    return out;
  }

  async get(id: string): Promise<Plan | undefined> {
    return this.plans.get(id);
  }

  async stage(p: Plan): Promise<void> {
    this.plans.set(p.id, { ...p, status: 'candidate' });
  }

  /** Seed or graduate a plan so it matches. */
  accept(p: Plan): void {
    this.plans.set(p.id, { ...p, status: 'accepted' });
  }

  all(): Plan[] {
    return [...this.plans.values()];
  }
}

export function triggerMatches(p: Plan, e: TeceraEvent): boolean {
  if (p.trigger.kind !== e.kind) return false;
  if (!p.trigger.where) return true;
  for (const [k, v] of Object.entries(p.trigger.where)) {
    if (JSON.stringify((e.payload as Record<string, unknown>)[k]) !== JSON.stringify(v)) return false;
  }
  return true;
}
