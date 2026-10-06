import { readySteps, type Intention, type Plan, type Step } from '@tecera/contracts';

/**
 * The task list is a set of intentions, not a queue. Steps inside one intention run in dependency
 * order; separate intentions and independent steps run concurrently up to a concurrency cap.
 */
export class IntentionSet {
  private readonly intentions = new Map<string, Intention>();
  private readonly plans = new Map<string, Plan>();

  constructor(private readonly concurrencyCap: number) {}

  add(i: Intention, plan: Plan): void {
    this.intentions.set(i.id, i);
    this.plans.set(i.id, plan);
  }

  update(i: Intention): void {
    if (!this.intentions.has(i.id)) throw new Error(`unknown intention ${i.id}`);
    this.intentions.set(i.id, i);
  }

  get(id: string): Intention | undefined {
    return this.intentions.get(id);
  }

  planOf(id: string): Plan {
    const p = this.plans.get(id);
    if (!p) throw new Error(`no plan for intention ${id}`);
    return p;
  }

  all(): Intention[] {
    return [...this.intentions.values()];
  }

  active(): Intention[] {
    return this.all().filter((i) => i.status === 'committed' || i.status === 'running' || i.status === 'held');
  }

  runningSteps(): number {
    let n = 0;
    for (const i of this.intentions.values()) for (const s of Object.values(i.stepStatus)) if (s === 'running') n++;
    return n;
  }

  /** Steps that may be dispatched now: ready by dependency, intention not held/terminal, under the cap. */
  dispatchable(): Array<{ intention: Intention; plan: Plan; step: Step }> {
    const out: Array<{ intention: Intention; plan: Plan; step: Step }> = [];
    let slots = Math.max(0, this.concurrencyCap - this.runningSteps());
    for (const i of this.intentions.values()) {
      if (i.status !== 'committed' && i.status !== 'running') continue;
      const plan = this.planOf(i.id);
      for (const s of readySteps(plan, i)) {
        if (slots === 0) return out;
        out.push({ intention: i, plan, step: s });
        slots--;
      }
    }
    return out;
  }

  allStepsDone(i: Intention): boolean {
    return Object.values(i.stepStatus).every((s) => s === 'done');
  }

  quiescent(): boolean {
    return this.active().every((i) => i.status === 'held') && this.runningSteps() === 0 && this.dispatchable().length === 0;
  }
}
