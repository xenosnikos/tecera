import { event, type AppendResult, type Ledger, type Principal, type TeceraEvent } from '@tecera/contracts';

/**
 * Plan staging in the documented order (docs/architecture.md, "first job trace"): a generated plan becomes a
 * library candidate only AFTER its goal was achieved — `… → host commits → goal.achieved{evidence} → the plan
 * is staged (plan.staged) as a candidate`. A plan whose run failed, was rejected, or is still held is never a
 * candidate for graduation.
 *
 * The loop (kernel) stages a generated plan right after validating it. The runtime owns the plan library,
 * so it owns that decision: the loop's early `plan.staged` is deferred (not written; the loop still sees its
 * own event delivered) and `stageAchievedPlans` writes `plan.staged {planId, goalId, after:'goal.achieved'}`
 * for every achieved goal of the run whose plan was generated in it. It is idempotent (idemKey
 * `plan.staged:<planId>`) and re-run at the end of every run segment, so a crash between goal.achieved and
 * staging is repaired by the next `tecera run --resume`.
 */

export const STAGED_AFTER = 'goal.achieved';

/** True for the loop's early plan.staged (the one the runtime defers). */
export function isEarlyStaging(e: TeceraEvent, loopActor: Principal): boolean {
  if (e.kind !== 'plan.staged') return false;
  if ((e.payload as { after?: unknown }).after === STAGED_AFTER) return false;
  return e.actor.kind === loopActor.kind && e.actor.id === loopActor.id;
}

/**
 * The loop's ledger: every call delegates to `inner` (so wrappers on the run's ledger, including test fault
 * injectors, still see every write), except the loop's early plan.staged, which is not written.
 */
export function deferStaging(inner: Ledger, loopActor: Principal): Ledger {
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'append') {
        return async (e: TeceraEvent): Promise<AppendResult> => {
          if (isEarlyStaging(e, loopActor)) return { seq: -1, hash: '', duplicate: false };
          return target.append(e);
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** Stage the generated plan of every achieved goal of `runId` (after its goal.achieved). Returns the staged plan ids. */
export async function stageAchievedPlans(ledger: Ledger, runId: string, clock: { ids: () => string; now: () => number }): Promise<string[]> {
  const events: TeceraEvent[] = [];
  for await (const e of ledger.events({ runId })) events.push(e);
  const generated = new Set<string>();
  const staged = new Set<string>();
  const out: string[] = [];
  let lastDone: { goalId: string; planId: string } | null = null;
  const toStage: Array<{ planId: string; goalId: string }> = [];
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    if (e.kind === 'plan.generated') {
      const id = (p.plan as { id?: unknown } | undefined)?.id;
      if (typeof id === 'string') generated.add(id);
    } else if (e.kind === 'plan.staged' && p.after === STAGED_AFTER && typeof p.planId === 'string') staged.add(p.planId);
    else if (e.kind === 'intention.done') {
      const i = p.intention as { goalId?: unknown; planId?: unknown } | undefined;
      if (typeof i?.goalId === 'string' && typeof i.planId === 'string') lastDone = { goalId: i.goalId, planId: i.planId };
    } else if (e.kind === 'goal.achieved' && e.trace.goalId && lastDone && lastDone.goalId === e.trace.goalId) {
      toStage.push({ planId: lastDone.planId, goalId: lastDone.goalId });
    }
  }
  for (const t of toStage) {
    if (!generated.has(t.planId) || staged.has(t.planId)) continue;
    await ledger.append(
      event('plan.staged', {
        id: clock.ids(),
        at: clock.now(),
        actor: { kind: 'system', id: 'runtime' },
        runId,
        trace: { planId: t.planId, goalId: t.goalId },
        idemKey: `plan.staged:${t.planId}`,
        payload: { planId: t.planId, goalId: t.goalId, after: STAGED_AFTER },
      }),
    );
    staged.add(t.planId);
    out.push(t.planId);
  }
  return out;
}
