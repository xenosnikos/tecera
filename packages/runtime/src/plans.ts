import { event, type BeliefProjection, type Json, type Ledger, type Plan, type PlanLibrary, type Principal, type TeceraEvent } from '@tecera/contracts';
import { triggerMatches } from '@tecera/loop';

/**
 * The plan library as a projection of the ledger (procedural memory). `plan.generated` makes a plan known;
 * `plan.staged` (written after its goal was achieved, staging.ts) makes it a candidate; `plan.graduated`
 * accepts a candidate; `plan.rejected`/`plan.retracted` take it out. Only accepted plans match: a generated
 * plan is reused only after its goal was achieved AND a human graduated it with a rationale.
 * Decisions are append-only events; the registry is rebuilt from the log on every load. A match is a
 * candidate for reuse only: the Loop re-validates every library plan against the current (effective)
 * manifest, permissions and goal before it is selected (PlanValidator), so an accepted plan never runs with
 * authority the current policy no longer grants.
 */

export type PlanVerdict = 'graduate' | 'reject' | 'retract';

export interface PlanDecision {
  by: Principal;
  verdict: PlanVerdict;
  rationale: string;
  at: number;
  /** How the human was identified (D1: the local principal, `--as` or $USER). */
  identity?: { authenticated: boolean; method: string; jti?: string };
}

export interface RegisteredPlan {
  plan: Plan;
  decisions: PlanDecision[];
  /** Event id that introduced the plan. */
  sourceEventId: string;
  /** A plan.staged was recorded (the plan's goal was achieved): only then is it a candidate for graduation. */
  staged: boolean;
}

export class PlanDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanDecisionError';
  }
}

const PLAN_KINDS: TeceraEvent['kind'][] = ['plan.generated', 'plan.staged', 'plan.graduated', 'plan.rejected', 'plan.retracted'];

export class PlanRegistry implements PlanLibrary {
  private readonly plans = new Map<string, RegisteredPlan>();

  static async load(ledger: Ledger): Promise<PlanRegistry> {
    const r = new PlanRegistry();
    for await (const e of ledger.events({ kinds: PLAN_KINDS })) r.apply(e);
    return r;
  }

  apply(e: TeceraEvent): void {
    const p = e.payload as { plan?: Plan; planId?: string; decision?: PlanDecision };
    const id = e.trace.planId ?? p.planId ?? p.plan?.id;
    if (!id) return;
    const cur = this.plans.get(id);
    switch (e.kind) {
      case 'plan.generated':
        if (p.plan && !cur) this.plans.set(id, { plan: { ...p.plan, status: 'candidate' }, decisions: [], sourceEventId: e.id, staged: false });
        else if (p.plan && cur && cur.plan.status === 'candidate') this.plans.set(id, { ...cur, plan: { ...p.plan, status: 'candidate' } });
        return;
      case 'plan.staged':
        if (cur) this.plans.set(id, { ...cur, staged: true, ...(p.plan && cur.plan.status === 'candidate' ? { plan: { ...p.plan, status: 'candidate' } } : {}) });
        else if (p.plan) this.plans.set(id, { plan: { ...p.plan, status: 'candidate' }, decisions: [], sourceEventId: e.id, staged: true });
        return;
      case 'plan.graduated':
        if (cur) this.plans.set(id, { ...cur, plan: { ...cur.plan, status: 'accepted' }, decisions: p.decision ? [...cur.decisions, p.decision] : cur.decisions });
        return;
      case 'plan.rejected':
        // The loop rejects invalid generated plans with the plan in the payload; humans reject candidates.
        if (cur) this.plans.set(id, { ...cur, plan: { ...cur.plan, status: 'rejected' }, decisions: p.decision ? [...cur.decisions, p.decision] : cur.decisions });
        else if (p.plan) this.plans.set(id, { plan: { ...p.plan, status: 'rejected' }, decisions: [], sourceEventId: e.id, staged: false });
        return;
      case 'plan.retracted':
        if (cur) this.plans.set(id, { ...cur, plan: { ...cur.plan, status: 'retracted' }, decisions: p.decision ? [...cur.decisions, p.decision] : cur.decisions });
        return;
      default:
        return;
    }
  }

  all(): RegisteredPlan[] {
    return [...this.plans.values()];
  }

  /** Staged candidates (their goal was achieved), awaiting a human decision. */
  candidates(): RegisteredPlan[] {
    return this.all().filter((r) => r.plan.status === 'candidate' && r.staged);
  }

  accepted(): RegisteredPlan[] {
    return this.all().filter((r) => r.plan.status === 'accepted');
  }

  entry(id: string): RegisteredPlan | undefined {
    return this.plans.get(id);
  }

  // ---- PlanLibrary ----

  async match(e: TeceraEvent, beliefs: BeliefProjection): Promise<Plan[]> {
    return this.accepted()
      .map((r) => r.plan)
      .filter((p) => triggerMatches(p, e) && p.context.every((c) => beliefs.match(c)));
  }

  async get(id: string): Promise<Plan | undefined> {
    return this.plans.get(id)?.plan;
  }

  /**
   * In-memory only: the loop registers a generated plan here before emitting plan.generated. It is not a
   * candidate until its goal is achieved and plan.staged is recorded (staging.ts).
   */
  async stage(p: Plan): Promise<void> {
    if (!this.plans.has(p.id)) this.plans.set(p.id, { plan: { ...p, status: 'candidate' }, decisions: [], sourceEventId: '', staged: false });
  }

  /**
   * A human decision. graduate/reject apply to candidates, retract to accepted plans. Appends the
   * decision event and updates the projection.
   */
  async decide(
    ledger: Ledger,
    id: string,
    d: { verdict: PlanVerdict; by: Principal; rationale: string; identity?: { authenticated: boolean; method: string; jti?: string } },
    clock: { now: () => number; id: () => string },
  ): Promise<RegisteredPlan> {
    const cur = this.plans.get(id);
    if (!cur) throw new PlanDecisionError(`unknown plan ${id}`);
    if (d.by.kind !== 'human') throw new PlanDecisionError('only a human principal can graduate, reject or retract a plan');
    if (!d.rationale.trim()) throw new PlanDecisionError('a rationale is required');
    if ((d.verdict === 'graduate' || d.verdict === 'reject') && cur.plan.status !== 'candidate') throw new PlanDecisionError(`plan ${id} is ${cur.plan.status}, not a candidate`);
    if (d.verdict === 'graduate' && !cur.staged) throw new PlanDecisionError(`plan ${id} was never staged: its goal was not achieved, so it cannot be graduated`);
    if (d.verdict === 'retract' && cur.plan.status !== 'accepted') throw new PlanDecisionError(`only an accepted plan can be retracted (plan ${id} is ${cur.plan.status})`);
    const decision: PlanDecision = {
      by: { kind: d.by.kind, id: d.by.id },
      verdict: d.verdict,
      rationale: d.rationale.trim(),
      at: clock.now(),
      ...(d.identity ? { identity: { authenticated: d.identity.authenticated, method: d.identity.method, ...(d.identity.jti ? { jti: d.identity.jti } : {}) } } : {}),
    };
    const kind = d.verdict === 'graduate' ? 'plan.graduated' : d.verdict === 'reject' ? 'plan.rejected' : 'plan.retracted';
    const e = event(kind, {
      id: clock.id(),
      at: decision.at,
      actor: d.by,
      trace: { planId: id },
      payload: { planId: id, decision: decision as unknown as Json },
    });
    await ledger.append(e);
    this.apply(e);
    return this.plans.get(id)!;
  }
}
