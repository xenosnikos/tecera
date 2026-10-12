import type { Json, TeceraEvent } from '@tecera/contracts';
import { whyChain } from '@tecera/ledger';
import type { Command } from '../cli/context.js';
import { pad } from '../cli/io.js';
import { CliError, EXIT } from '../errors.js';

/**
 * `tecera why <eventId>`: accountability walk. The ledger's whyChain returns the events sharing the
 * target's step, intention, goal and plan; this groups them as action → step → intention → goal → event
 * (the event that adopted the goal), oldest first. Under an acceptance contract the walk also names the
 * contract the goal was held to and who accepted it (the latest criteria.accepted / amended of the goal).
 */

export interface WhyReport {
  action: TeceraEvent;
  step: TeceraEvent[];
  intention: TeceraEvent[];
  plan: TeceraEvent[];
  goal: TeceraEvent[];
  origin: TeceraEvent | null;
}

export function groupChain(chain: ReadonlyArray<TeceraEvent>, eventId: string): WhyReport | null {
  const action = chain.find((e) => e.id === eventId);
  if (!action) return null;
  const t = action.trace;
  const step = t.stepId ? chain.filter((e) => e.trace.stepId === t.stepId) : [];
  const intention = t.intentionId ? chain.filter((e) => e.trace.intentionId === t.intentionId && !e.trace.stepId) : [];
  const plan = t.planId ? chain.filter((e) => e.kind.startsWith('plan.') && e.trace.planId === t.planId) : [];
  const goal = t.goalId ? chain.filter((e) => e.trace.goalId === t.goalId && !e.trace.intentionId && !e.kind.startsWith('plan.')) : [];
  const origin = goal.find((e) => e.kind === 'goal.adopted') ?? null;
  return { action, step, intention, plan, goal, origin };
}

const kinds = (xs: TeceraEvent[]): string => xs.map((e) => e.kind).join(' → ') || '(none)';

export const whyCommand: Command = async (c) => {
  const id = c.args.positionals[0];
  if (!id || c.args.positionals.length > 1) throw new CliError('usage: tecera why <eventId>', EXIT.usage);
  const rt = c.runtime();
  if (!rt.ledgerExists()) throw new CliError('no ledger yet', EXIT.error);
  const chain = await whyChain(rt.ledger(), id);
  const r = groupChain(chain, id);
  if (!r) {
    c.out.error(`why: no event ${id} in the ledger`);
    return EXIT.error;
  }
  const t = r.action.trace;
  c.out.say(`${pad('action', 11)}${r.action.kind}  ${r.action.id}  by ${r.action.actor.kind}:${r.action.actor.id}  ${new Date(r.action.at).toISOString()}`);
  if (t.stepId) c.out.say(`${pad('step', 11)}${t.stepId}  ${kinds(r.step)}`);
  if (t.intentionId) c.out.say(`${pad('intention', 11)}${t.intentionId}  ${kinds(r.intention)}`);
  if (t.planId) c.out.say(`${pad('plan', 11)}${t.planId}  ${kinds(r.plan)}`);
  if (t.goalId) c.out.say(`${pad('goal', 11)}${t.goalId}  ${kinds(r.goal)}`);
  const contract = [...r.goal].reverse().find((e) => e.kind === 'criteria.accepted' || e.kind === 'criteria.amended' || e.kind === 'criteria.drafted');
  if (contract) {
    const p = contract.payload as { hash?: unknown; to?: unknown; via?: unknown; approver?: { id?: unknown } };
    const hash = String(p.hash ?? p.to ?? '').slice(0, 12);
    const how = contract.kind === 'criteria.accepted' ? `accepted via ${String(p.via ?? '?')}${p.approver?.id ? ` by ${String(p.approver.id)}` : ''}` : contract.kind === 'criteria.amended' ? `amended by ${contract.actor.kind}:${contract.actor.id}, not yet accepted` : 'drafted, not yet accepted';
    c.out.say(`${pad('contract', 11)}${hash}  ${how}  (${contract.kind} ${contract.id})`);
    c.out.set('contract', { id: contract.id, kind: contract.kind, hash: String(p.hash ?? p.to ?? '') });
  }
  if (r.origin) c.out.say(`${pad('event', 11)}${r.origin.kind}  ${r.origin.id}  by ${r.origin.actor.kind}:${r.origin.actor.id}  "${String(((r.origin.payload as { goal?: { statement?: string } }).goal?.statement ?? '')).split('\n')[0]}"`);
  else c.out.say(`${pad('event', 11)}(no goal.adopted in the chain)`);
  const ids = (xs: TeceraEvent[]): Json => xs.map((e) => ({ id: e.id, kind: e.kind }));
  c.out.set('action', { id: r.action.id, kind: r.action.kind, trace: r.action.trace as unknown as Json });
  c.out.set('step', ids(r.step));
  c.out.set('intention', ids(r.intention));
  c.out.set('plan', ids(r.plan));
  c.out.set('goal', ids(r.goal));
  c.out.set('origin', r.origin ? { id: r.origin.id, kind: r.origin.kind } : null);
  return EXIT.ok;
};
