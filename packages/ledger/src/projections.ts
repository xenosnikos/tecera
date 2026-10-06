import type { AchievementGoal, Belief, BeliefProjection, Intention, Json, Ledger, TeceraEvent } from '@tecera/contracts';

/**
 * Projections fold the event log into current state. They are rebuilt from the log on demand and can
 * be compared against a live copy to prove the log is the source of truth.
 */

export class BeliefMap implements BeliefProjection {
  private readonly beliefs = new Map<string, Belief>();
  private readonly history: Belief[] = [];

  apply(e: TeceraEvent): void {
    if (e.kind === 'belief.added') {
      const p = e.payload as { key?: string; value?: Json; provenance?: Belief['provenance'] };
      if (typeof p.key !== 'string') return;
      const prev = this.beliefs.get(p.key);
      if (prev) {
        prev.invalidatedAt = e.at;
        this.history.push(prev);
      }
      this.beliefs.set(p.key, {
        id: e.id,
        key: p.key,
        value: (p.value ?? null) as Json,
        provenance: p.provenance ?? { src: `event:${e.actor.id}`, trust: 'trusted' },
        at: e.at,
      });
    } else if (e.kind === 'belief.removed') {
      const p = e.payload as { key?: string };
      if (typeof p.key !== 'string') return;
      const prev = this.beliefs.get(p.key);
      if (prev) {
        prev.invalidatedAt = e.at;
        this.history.push(prev);
        this.beliefs.delete(p.key);
      }
    }
  }

  get(key: string): Belief | undefined {
    return this.beliefs.get(key);
  }

  all(): Belief[] {
    return [...this.beliefs.values()];
  }

  /** Beliefs that were replaced or removed, for audit. */
  invalidated(): Belief[] {
    return [...this.history];
  }

  match(pattern: { key: string; equals?: Json; exists?: boolean }): boolean {
    const b = this.beliefs.get(pattern.key);
    if (pattern.exists === false) return b === undefined;
    if (!b) return false;
    if (pattern.equals !== undefined) return JSON.stringify(b.value) === JSON.stringify(pattern.equals);
    return true;
  }

  snapshot(): Record<string, Json> {
    const out: Record<string, Json> = {};
    for (const [k, b] of this.beliefs) out[k] = b.value;
    return out;
  }
}

/** Latest goal and intention snapshots carried in event payloads (`payload.goal`, `payload.intention`). */
export class BoardProjection {
  readonly goals = new Map<string, AchievementGoal>();
  readonly intentions = new Map<string, Intention>();

  apply(e: TeceraEvent): void {
    const p = e.payload as { goal?: AchievementGoal; intention?: Intention };
    if (e.kind.startsWith('goal.') && p.goal?.id) this.goals.set(p.goal.id, p.goal);
    if (e.kind.startsWith('intention.') && p.intention?.id) this.intentions.set(p.intention.id, p.intention);
    if (e.kind.startsWith('step.') && p.intention?.id) this.intentions.set(p.intention.id, p.intention);
  }
}

export async function projectBeliefs(ledger: Ledger, runId?: string): Promise<BeliefMap> {
  const m = new BeliefMap();
  for await (const e of ledger.events({ kinds: ['belief.added', 'belief.removed'], ...(runId ? { runId } : {}) })) m.apply(e);
  return m;
}

export async function projectBoard(ledger: Ledger, runId?: string): Promise<BoardProjection> {
  const b = new BoardProjection();
  for await (const e of ledger.events(runId ? { runId } : {})) b.apply(e);
  return b;
}

/** Walk the why-chain for an event: the events that share its step, then intention, then goal, oldest first. */
export async function whyChain(ledger: Ledger, eventId: string): Promise<TeceraEvent[]> {
  let target: TeceraEvent | undefined;
  const all: TeceraEvent[] = [];
  for await (const e of ledger.events()) {
    all.push(e);
    if (e.id === eventId) target = e;
  }
  if (!target) return [];
  const t = target.trace;
  return all.filter((e) => {
    if (e.id === eventId) return true;
    if (t.stepId && e.trace.stepId === t.stepId) return true;
    if (t.intentionId && e.trace.intentionId === t.intentionId && !e.trace.stepId) return true;
    if (t.goalId && e.trace.goalId === t.goalId && !e.trace.intentionId) return true;
    if (t.planId && e.trace.planId === t.planId && e.kind.startsWith('plan.')) return true;
    return false;
  });
}
