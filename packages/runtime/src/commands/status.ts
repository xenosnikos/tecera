import { acceptedContractOf, requireApproval, resourceRegistryOf, type Json, type TeceraEvent } from '@tecera/contracts';
import { BoardProjection } from '@tecera/ledger';
import type { Command } from '../cli/context.js';
import { EXIT } from '../errors.js';
import { PlanRegistry } from '../plans.js';
import { provenOptionsOf } from '../proof.js';
import { runVerdict } from './run.js';

/**
 * `tecera status [--run id]`: the last run (or the one named), open goals and live intentions from the
 * ledger's BoardProjection, held approvals still pending (and what each waits for: a criteria sign-off, a
 * capability, a human criterion, the PR), the run's acceptance contract (state, criteria and the fidelity
 * each was proven at; provisional when one rests on a mock), the resources pending transfer, and the
 * review queues (plan candidates). Reads only.
 */

export interface PendingApproval {
  requestId: string;
  runId?: string;
  stepId?: string;
  /** The approval action when the request names one (accept_criteria, provide_capability, answer_criterion). */
  action?: string;
  eventId: string;
  /** Ledger state of the approval (getApproval), when known. */
  state?: string;
}

export function pendingApprovals(events: ReadonlyArray<TeceraEvent>): PendingApproval[] {
  const pending = new Map<string, PendingApproval>();
  for (const e of events) {
    const rid = (e.payload as { requestId?: string }).requestId;
    if (!rid) continue;
    if (e.kind === 'approval.requested' || e.kind === 'step.held') {
      const action = (e.payload as { action?: unknown }).action;
      if (!pending.has(rid)) pending.set(rid, { requestId: rid, runId: e.runId, stepId: e.trace.stepId, ...(typeof action === 'string' ? { action } : {}), eventId: e.id });
    } else if (e.kind === 'approval.denied' || e.kind === 'approval.consumed' || e.kind === 'approval.expired') pending.delete(rid);
  }
  return [...pending.values()];
}

export const statusCommand: Command = async (c) => {
  const rt = c.runtime();
  if (!rt.ledgerExists()) {
    c.out.say('no ledger yet (run `tecera init`)');
    return EXIT.ok;
  }
  const ledger = rt.ledger();
  const all: TeceraEvent[] = [];
  for await (const e of ledger.events()) all.push(e);
  const runs = all.filter((e) => e.kind === 'run.started');
  const runId = c.args.values.run ?? runs[runs.length - 1]?.runId;
  const board = new BoardProjection();
  for (const e of all) if (!c.args.values.run || e.runId === runId) board.apply(e);
  const runEvents = runId ? all.filter((e) => e.runId === runId) : [];
  const ended = [...runEvents].reverse().find((e) => e.kind === 'run.ended');
  const candidates = pendingApprovals(all).filter((p) => !c.args.values.run || p.runId === runId);
  const pending: PendingApproval[] = [];
  for (const p of candidates) {
    const view = await requireApproval(ledger, p.requestId);
    const state = view?.state ?? 'unknown';
    if (state === 'pending' || state === 'granted' || state === 'unknown') pending.push({ ...p, state });
  }
  const plans = new PlanRegistry();
  for (const e of all) plans.apply(e);

  if (runId) {
    const started = runEvents.find((e) => e.kind === 'run.started');
    c.out.say(`run        ${runId}  ${started ? new Date(started.at).toISOString() : ''}  ${runEvents.length} event(s)  ${ended ? `ended: ${(ended.payload as { reason?: string }).reason ?? ''} (exit ${(ended.payload as { exitCode?: number }).exitCode})` : 'not ended'}`);
    const cost = (ended?.payload as { cost?: { usd?: number; inputTokens?: number; outputTokens?: number; calls?: number } } | undefined)?.cost;
    if (cost) c.out.say(`cost       $${Number(cost.usd ?? 0).toFixed(4)} · ${(cost.inputTokens ?? 0) + (cost.outputTokens ?? 0)} tokens · ${cost.calls ?? 0} model call(s) (tecera evidence ${runId} for per step / per model)`);
  } else c.out.say('run        none yet');
  const goals = [...board.goals.values()];
  const open = goals.filter((g) => g.status === 'open' || g.status === 'demoted');
  c.out.say(`goals      ${goals.length ? goals.map((g) => `${g.id} ${g.status}`).join(' · ') : 'none'}`);
  const live = [...board.intentions.values()].filter((i) => i.status === 'committed' || i.status === 'running' || i.status === 'held');
  for (const i of live) c.out.say(`intention  ${i.id}  ${i.status}  plan ${i.planId}  ${Object.entries(i.stepStatus).map(([s, st]) => `${s}:${st}`).join(' ')}`);
  for (const p of pending) {
    const what = p.action === 'accept_criteria' ? 'criteria sign-off' : p.action === 'provide_capability' ? 'capability' : p.action === 'answer_criterion' ? `criterion ${String(p.stepId ?? '').replace(/^answer:/, '')}` : `step ${p.stepId ?? '-'}`;
    const how = p.action === 'accept_criteria' ? `tecera criteria accept ${p.runId ?? '<run>'}` : `tecera approve ${p.requestId}`;
    c.out.say(p.state === 'granted' ? `held       ${p.requestId}  ${what}  granted → tecera run --resume ${p.runId ?? '<run>'}` : `held       ${p.requestId}  ${what}  ${p.state} → ${how}`);
  }
  // D8–D12: the contract of the run's goal, the fidelity of its proofs, and what Tecera still owes.
  const opts = provenOptionsOf(rt.manifest, rt.redactor);
  const contracts: Json[] = [];
  let transfers: Json[] = [];
  if (runId) {
    const signoffAlways = rt.manifest.acceptance.signoff === 'always';
    const verdict = await runVerdict(rt, { ledger, runId });
    for (const goalId of [...new Set(runEvents.filter((e) => e.kind === 'goal.adopted').map((e) => e.trace.goalId).filter((g): g is string => !!g))]) {
      const view = acceptedContractOf(runEvents, goalId, { runId, ...(signoffAlways ? { requireApproval: true } : {}) });
      if (view.state === 'none' || !view.contract) continue;
      const g = verdict?.goals[goalId];
      const provisional = !g?.achieved && runEvents.some((e) => e.kind === 'goal.provisional' && e.trace.goalId === goalId);
      const fid = g?.achieved ? (g.proof?.fidelity ?? 'real') : provisional ? 'mocked' : null;
      c.out.say(`criteria   ${goalId}  ${view.state}  ${view.contract.criteria.length} criteria${fid ? ` · fidelity ${fid}` : ''}${provisional ? ' · PROVISIONAL (rests on a mock; never achieved)' : ''}  (tecera criteria show ${runId})`);
      contracts.push({ goalId, state: view.state, hash: view.current ?? null, criteria: view.contract.criteria.length, fidelity: fid, provisional });
    }
    const reg = resourceRegistryOf(runEvents, { runId, ...(opts.allowance ? { allowance: opts.allowance } : {}), ...(opts.secrets ? { secrets: opts.secrets } : {}) });
    for (const r of reg.pending) c.out.say(`transfer   ${r.id}  ${r.kind}  ${r.locator}  expires ${new Date(r.expiresAt).toISOString()} → tecera resources transfer|release ${r.id}`);
    for (const p of reg.problems) c.out.error(`resources: ${p}`);
    transfers = reg.pending.map((r) => ({ id: r.id, capability: r.capability, kind: r.kind, locator: r.locator, expiresAt: r.expiresAt }));
  }
  c.out.say(`plans      ${plans.accepted().length} accepted · ${plans.candidates().length} candidate(s) awaiting review`);
  c.out.set('runId', runId ?? null);
  c.out.set('goals', goals as unknown as Json);
  c.out.set('openGoals', open.map((g) => g.id));
  c.out.set('intentions', live as unknown as Json);
  c.out.set('pending', pending as unknown as Json);
  c.out.set('contracts', contracts);
  c.out.set('pendingTransfer', transfers);
  return EXIT.ok;
};
