import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  ACCEPT_CRITERIA_ACTION,
  acceptedContractOf,
  contractHash,
  contractProblem,
  payloadOf,
  requireApproval,
  type AcceptanceContract,
  type AcceptanceView,
  type Json,
  type TeceraEvent,
} from '@tecera/contracts';
import type { Command, CommandContext } from '../cli/context.js';
import { guardDecision, guardJson } from '../decisionGuard.js';
import { CliError, EXIT } from '../errors.js';
import { identityJson, localPrincipal, PrincipalError, type HumanIdentity } from '../principal.js';
import type { Runtime } from '../runtime.js';
import { approveCommand } from './approve.js';
import { runVerdict } from './run.js';

/**
 * `tecera criteria show|accept|amend <runId>` (D8: the acceptance contract of a run's goal).
 *
 * - `show <run>`: the contract as the ledger has it (acceptedContractOf: drafted, accepted or stale), every
 *   criterion with its check and the capabilities it requires, the fidelity each was proven at (from the
 *   run's proven verdict, or the goal.provisional proof), and the pending sign-off request.
 * - `accept <run> [--as id] [--reason text]`: the requestor's sign-off. A local human approval (D1: `--as` or
 *   $USER) of the run's pending accept_criteria request, bound to the current contract hash; exactly
 *   `tecera approve <request>` (the requester, Tecera, can never grant it; separation of duty is the
 *   ledger's). `tecera run --resume <run>` then plans against the accepted contract.
 * - accept and amend refuse (exit 9) on a ledger whose hash chain does not verify.
 * - accept and amend are human decisions: both go through the accident guard first (decisionGuard.ts; exit 8
 *   under an agent-host marker or without a terminal, unless TECERA_DECISION_NONINTERACTIVE=1). It is not
 *   authentication.
 * - `amend <run> --file contract.json --reason text [--as id]`: a human replaces the contract (a full
 *   AcceptanceContract, or `{criteria, outOfScope?, assumptions?}` stamped with the goal and statement). It is
 *   recorded as criteria.amended {from, to, contract, reason} with the human as actor; any acceptance becomes
 *   stale, so the next resume drops the running intention and holds for a sign-off of the new hash before it
 *   re-plans. Nothing is accepted by amending.
 */

interface RunContract {
  runId: string;
  goalId: string;
  events: TeceraEvent[];
  view: AcceptanceView;
}

function runIdArg(c: CommandContext, verb: string): string {
  const runId = c.args.positionals[1];
  if (!runId || !/^[A-Za-z0-9_-]+$/.test(runId)) throw new CliError(`usage: tecera criteria ${verb} <runId>${verb === 'amend' ? ' --file contract.json --reason text' : ''}`, EXIT.usage);
  return runId;
}

async function runContract(c: CommandContext, rt: Runtime, verb: string): Promise<RunContract | number> {
  const runId = runIdArg(c, verb);
  if (!rt.ledgerExists()) {
    c.out.error(`criteria ${verb}: no ledger yet`);
    return EXIT.error;
  }
  // A decision is recorded only on a ledger whose hash chain holds (a tampered history decides nothing).
  if (verb !== 'show') {
    const chain = await rt.ledger().verifyChain();
    if (!chain.ok) {
      c.out.error(`criteria ${verb}: the ledger's hash chain is broken at seq ${chain.brokenAtSeq}${chain.reason ? ` (${chain.reason})` : ''}; nothing was recorded`);
      c.out.set('error', 'broken chain');
      return EXIT.ledger;
    }
  }
  const events: TeceraEvent[] = [];
  for await (const e of rt.ledger().events({ runId })) events.push(e);
  const goalId = events.find((e) => e.kind === 'goal.adopted')?.trace.goalId;
  if (!goalId) {
    c.out.error(`criteria ${verb}: run ${runId} adopted no goal`);
    return EXIT.error;
  }
  const view = acceptedContractOf(events, goalId, { runId, ...(rt.manifest.acceptance.signoff === 'always' ? { requireApproval: true } : {}) });
  return { runId, goalId, events, view };
}

/** The run's sign-off requests for `hash`, newest first, with their ledger state. */
async function signoffRequests(rt: Runtime, rc: RunContract, hash: string | undefined): Promise<Array<{ requestId: string; state: string }>> {
  const out: Array<{ requestId: string; state: string }> = [];
  for (const e of [...rc.events].reverse()) {
    const p = e.payload as { requestId?: unknown; action?: unknown; contractHash?: unknown };
    if (e.kind !== 'approval.requested' || p.action !== ACCEPT_CRITERIA_ACTION || typeof p.requestId !== 'string') continue;
    if (e.trace.goalId !== rc.goalId || (hash !== undefined && p.contractHash !== hash)) continue;
    const v = await requireApproval(rt.ledger(), p.requestId);
    out.push({ requestId: p.requestId, state: v ? (v.state === 'pending' && v.expiresAt <= rt.now() ? 'expired' : v.state) : 'unknown' });
  }
  return out;
}

function describeCheck(k: AcceptanceContract['criteria'][number]): string {
  return k.check.kind === 'command' ? `verify \`${k.check.command}\` (${k.check.timeoutSec}s)` : `ask "${k.check.prompt}"`;
}

const showCommand: Command = async (c) => {
  const rt = c.runtime();
  const rc = await runContract(c, rt, 'show');
  if (typeof rc === 'number') return rc;
  const { view } = rc;
  c.out.set('runId', rc.runId);
  c.out.set('goalId', rc.goalId);
  c.out.set('state', view.state);
  if (view.state === 'none' || !view.contract) {
    c.out.say(`criteria   run ${rc.runId} goal ${rc.goalId}: no acceptance contract (the goal's check alone decides)`);
    for (const p of view.problems) c.out.error(`criteria: ${p}`);
    c.out.set('problems', view.problems);
    return EXIT.ok;
  }
  // Fidelity per criterion: the proven verdict's proof, else the provisional proof (never proven by itself).
  const verdict = await runVerdict(rt, { ledger: rt.ledger(), runId: rc.runId });
  const proven = verdict?.goals[rc.goalId];
  const provisional = [...rc.events].reverse().find((e) => e.kind === 'goal.provisional' && e.trace.goalId === rc.goalId);
  const proofs = (proven?.achieved ? proven.proof?.criteria : (provisional?.payload as { proof?: { criteria?: Array<{ criterionId: string; fidelity: string; via: string }> } } | undefined)?.proof?.criteria) ?? [];
  const fidelity = new Map(proofs.map((p) => [p.criterionId, `${p.fidelity} (${p.via})`]));
  const pending = (await signoffRequests(rt, rc, view.current)).filter((r) => r.state === 'pending' || r.state === 'granted');
  c.out.say(`criteria   run ${rc.runId} goal ${rc.goalId} · ${view.state}${view.accepted ? ` (${view.accepted.via}${view.accepted.approver ? ` by ${view.accepted.approver.id}` : ''})` : ''} · contract ${view.current?.slice(0, 12) ?? '-'}`);
  for (const k of view.contract.criteria) {
    c.out.say(`  ${k.id}  ${k.statement}`);
    c.out.say(`      ${describeCheck(k)}${k.requires?.length ? ` · requires ${k.requires.join(', ')}` : ''} · ${fidelity.get(k.id) ?? 'not proven yet'}`);
  }
  for (const e of view.contract.envelope ?? []) c.out.say(`  may ${e.ops.join('/')}: ${e.path}`);
  for (const x of view.contract.outOfScope) c.out.say(`  out of scope: ${x}`);
  for (const x of view.contract.assumptions) c.out.say(`  assumes: ${x}`);
  if (provisional && !proven?.achieved) c.out.say('  provisional: a criterion rests on a mocked capability; the goal is never achieved this way');
  for (const r of pending) c.out.say(r.state === 'granted' ? `  sign-off ${r.requestId} granted → tecera run --resume ${rc.runId}` : `  sign-off ${r.requestId} pending → tecera criteria accept ${rc.runId}`);
  for (const p of view.problems) c.out.error(`criteria: ${p}`);
  c.out.set('contractHash', view.current ?? null);
  c.out.set('contract', view.contract as unknown as Json);
  c.out.set('accepted', view.accepted ? ({ via: view.accepted.via, approver: view.accepted.approver?.id ?? null, requestId: view.accepted.requestId ?? null } as Json) : null);
  c.out.set('fidelity', Object.fromEntries(fidelity));
  c.out.set('provisional', !!provisional && !proven?.achieved);
  c.out.set('signoff', pending as unknown as Json);
  c.out.set('problems', view.problems);
  return EXIT.ok;
};

const acceptCommand: Command = async (c) => {
  runIdArg(c, 'accept'); // usage errors first (exit 2), wherever the command is run
  const guard = guardDecision(c, 'criteria accept');
  if (typeof guard === 'number') return guard;
  const rt = c.runtime();
  const rc = await runContract(c, rt, 'accept');
  if (typeof rc === 'number') return rc;
  const { view } = rc;
  if (view.state === 'accepted') {
    c.out.say(`criteria   contract ${view.current?.slice(0, 12)} of run ${rc.runId} is already accepted`);
    c.out.set('state', 'accepted');
    return EXIT.ok;
  }
  if (!view.current) {
    c.out.error(`criteria accept: run ${rc.runId} has no drafted contract to accept`);
    return EXIT.error;
  }
  const live = (await signoffRequests(rt, rc, view.current)).find((r) => r.state === 'pending');
  if (!live) {
    c.out.error(`criteria accept: no pending sign-off for contract ${view.current.slice(0, 12)} of run ${rc.runId}; run \`tecera run --resume ${rc.runId}\` to request one`);
    c.out.set('error', 'no pending sign-off');
    return EXIT.error;
  }
  c.out.set('contractHash', view.current);
  // The same explicit human decision as `tecera approve <request>` (local principal, audited, never the requester).
  return approveCommand({ ...c, args: { ...c.args, positionals: [live.requestId] } });
};

function principal(c: CommandContext, rt: Runtime): HumanIdentity | number {
  try {
    return localPrincipal(rt, { as: c.args.values.as });
  } catch (e) {
    if (e instanceof PrincipalError) {
      c.out.error(`criteria amend: ${e.message}`);
      c.out.set('error', e.message);
      return e.exitCode;
    }
    throw e;
  }
}

const amendCommand: Command = async (c) => {
  const file = c.args.values.file;
  const reason = c.args.values.reason?.trim();
  if (!file || !reason) throw new CliError('usage: tecera criteria amend <runId> --file contract.json --reason text [--as id]', EXIT.usage);
  runIdArg(c, 'amend');
  const guard = guardDecision(c, 'criteria amend');
  if (typeof guard === 'number') return guard;
  const rt = c.runtime();
  const rc = await runContract(c, rt, 'amend');
  if (typeof rc === 'number') return rc;
  const { view } = rc;
  if (!view.current || !view.contract) {
    c.out.error(`criteria amend: run ${rc.runId} has no contract to amend`);
    return EXIT.error;
  }
  if (rc.events.some((e) => (e.kind === 'goal.achieved' || e.kind === 'goal.dropped') && e.trace.goalId === rc.goalId)) {
    c.out.error(`criteria amend: goal ${rc.goalId} of run ${rc.runId} is no longer open`);
    return EXIT.error;
  }
  let raw: unknown;
  const abs = isAbsolute(file) ? file : resolve(c.opts.cwd, file);
  try {
    const st = lstatSync(abs);
    if (!st.isFile() || st.size > 1024 * 1024) throw new CliError(`criteria amend: ${file} is not a regular file of at most 1 MiB`, EXIT.usage);
    raw = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(`criteria amend: ${file} is not a readable JSON contract (${(e as Error).message})`, EXIT.usage);
  }
  const doc = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Partial<AcceptanceContract>;
  if (doc.goalId !== undefined && doc.goalId !== rc.goalId) throw new CliError(`criteria amend: the contract names goal ${String(doc.goalId)}, not ${rc.goalId}`, EXIT.usage);
  const contract: AcceptanceContract = {
    goalId: rc.goalId,
    statement: typeof doc.statement === 'string' && doc.statement.trim() ? doc.statement : view.contract.statement,
    criteria: doc.criteria as AcceptanceContract['criteria'],
    outOfScope: doc.outOfScope ?? [],
    assumptions: doc.assumptions ?? [],
    // An amendment that states no envelope keeps the accepted one: only an explicit list changes it.
    ...((doc.envelope ?? view.contract.envelope) ? { envelope: doc.envelope ?? view.contract.envelope } : {}),
  };
  const why = contractProblem(contract);
  if (why) throw new CliError(`criteria amend: ${why}`, EXIT.usage);
  const to = contractHash(contract);
  if (to === view.current) {
    c.out.error(`criteria amend: the amendment does not change contract ${to.slice(0, 12)}`);
    return EXIT.error;
  }
  const who = principal(c, rt);
  if (typeof who === 'number') return who;
  const ev = await rt.append('criteria.amended', {
    runId: rc.runId,
    trace: { goalId: rc.goalId },
    actor: { kind: 'human', id: who.id },
    payload: { ...payloadOf('criteria.amended', { from: view.current, to, contract, reason }), guard: guardJson(guard) },
  });
  c.out.say(`amended    contract of goal ${rc.goalId} (run ${rc.runId}) ${view.current.slice(0, 12)} → ${to.slice(0, 12)} as ${who.id} · event ${ev.id}`);
  c.out.info(`the acceptance is stale: \`tecera run --resume ${rc.runId}\` drops the running plan and holds for a sign-off of the new contract (\`tecera criteria accept ${rc.runId}\`)`);
  c.out.set('from', view.current);
  c.out.set('to', to);
  c.out.set('eventId', ev.id);
  c.out.set('identity', identityJson(who));
  return EXIT.ok;
};

/** `tecera criteria <show|accept|amend> <runId> …`. */
export const criteriaCommand: Command = async (c) => {
  const sub = c.args.positionals[0];
  const subs: Record<string, Command> = { show: showCommand, accept: acceptCommand, amend: amendCommand };
  const cmd = sub && Object.prototype.hasOwnProperty.call(subs, sub) ? subs[sub] : undefined;
  if (!cmd) throw new CliError('usage: tecera criteria show|accept|amend <runId>', EXIT.usage);
  return cmd(c);
};
