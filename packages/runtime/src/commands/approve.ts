import { approvalGrantedEvent, LedgerError, requireApproval, type ApprovalView, type Json, type TeceraEvent, type Trace } from '@tecera/contracts';
import type { Command, CommandContext } from '../cli/context.js';
import { CliError, EXIT } from '../errors.js';
import { identityJson, localPrincipal, PrincipalError, type HumanIdentity } from '../principal.js';
import type { Runtime } from '../runtime.js';

/**
 * `tecera approve|deny <requestId> [--as <principal>] [--reason text]`: an explicit human decision on a held
 * request (D1: the local human principal, `--as` or $USER; no tokens, no auth package).
 *
 * - The approval's state, session, action hash and requester come from the ledger (`getApproval`), never
 *   from caller input; there is no session override.
 * - A grant and its `approval.granted` audit event are recorded ATOMICALLY: the event travels with
 *   Ledger.approve(…, audit) and the ledger writes both or neither. The event carries the principal
 *   ({kind:'human', id, method:'local', source}) and an identity evidence key. A grant recorded without its
 *   event (an older ledger, or a crash between them) is UNAUDITED: the ledger's consume() refuses it and
 *   `tecera run --resume` does not resume it; re-running the same decision by the same human records the
 *   missing event (repair) instead of failing. A denial is recorded, then its event appended.
 * - Separation of duty stays: requester = approver, or a non-human approver, is a policy failure (exit 8);
 *   an unknown, expired or already-decided request is exit 1. `--yes` never approves anything.
 * - Under D6 the only approval point is the PR gate: the request names the committed sha it opens a PR for.
 */

const SOD = /requester cannot approve their own request|only a human principal can approve/;

export async function decisionEvent(rt: Runtime, requestId: string, kind: 'approval.granted' | 'approval.denied'): Promise<TeceraEvent | null> {
  for await (const e of rt.ledger().events({ kinds: [kind] })) if ((e.payload as { requestId?: string }).requestId === requestId) return e;
  return null;
}

async function requestEvent(rt: Runtime, view: ApprovalView): Promise<TeceraEvent | null> {
  let found: TeceraEvent | null = null;
  for await (const e of rt.ledger().events({ runId: view.runId, kinds: ['approval.requested', 'step.held'] })) {
    if ((e.payload as { requestId?: string }).requestId === view.requestId && (!found || e.kind === 'approval.requested')) found = e;
  }
  return found;
}

function traceOf(req: TeceraEvent | null): Trace {
  return req ? { ...(req.trace.goalId ? { goalId: req.trace.goalId } : {}), ...(req.trace.intentionId ? { intentionId: req.trace.intentionId } : {}), ...(req.trace.stepId ? { stepId: req.trace.stepId } : {}), ...(req.trace.planId ? { planId: req.trace.planId } : {}) } : {};
}

/** The approval.granted audit event for this decision (identity and evidence key carried in the payload). */
function grantedEvent(rt: Runtime, view: ApprovalView, who: HumanIdentity, reason: string, trace: Trace, evidenceKey: string): TeceraEvent {
  return approvalGrantedEvent({
    id: rt.ids('ev'),
    at: rt.now(),
    requestId: view.requestId,
    runId: view.runId,
    sessionId: view.sessionId,
    actionHash: view.actionHash,
    approver: { kind: 'human', id: who.id },
    trace,
    reason,
    extra: { identity: identityJson(who) as unknown as Json, evidenceKey },
  }) as TeceraEvent;
}

const identityKey = (view: ApprovalView, evKind: string, who: HumanIdentity): string => `approval:${view.requestId}:${evKind}:identity:local-${who.id}`;

async function identityEvidence(rt: Runtime, view: ApprovalView, evKind: string, who: HumanIdentity): Promise<string> {
  const evidenceKey = identityKey(view, evKind, who);
  await rt.ledger().evidence({ key: evidenceKey, kind: 'approval.identity', runId: view.runId, body: { requestId: view.requestId, decision: evKind, identity: identityJson(who), actionHash: view.actionHash, sessionId: view.sessionId } });
  return evidenceKey;
}

function reportDecision(c: CommandContext, kind: 'approve' | 'deny', view: ApprovalView, who: HumanIdentity, trace: Trace, ev: TeceraEvent): number {
  c.out.say(`${kind === 'approve' ? 'approved' : 'denied'} ${view.requestId} as ${who.id} (local principal, ${who.source === 'as' ? '--as' : who.source}) (step ${trace.stepId ?? '-'}, run ${view.runId}) · event ${ev.id}`);
  if (kind === 'approve') c.out.info(`resume the run with \`tecera run --resume ${view.runId}\``);
  c.out.set('requestId', view.requestId);
  c.out.set('eventId', ev.id);
  c.out.set('identity', identityJson(who));
  return EXIT.ok;
}

/** Append the decision event for a decision the ledger already holds (denials; repair of an unaudited grant). */
async function recordDecision(
  c: CommandContext,
  rt: Runtime,
  kind: 'approve' | 'deny',
  view: ApprovalView,
  who: HumanIdentity,
  reason: string,
  req: TeceraEvent | null,
): Promise<number> {
  const evKind = kind === 'approve' ? 'approval.granted' : 'approval.denied';
  const trace = traceOf(req);
  let ev: TeceraEvent;
  try {
    const evidenceKey = await identityEvidence(rt, view, evKind, who);
    if (kind === 'approve') {
      ev = grantedEvent(rt, view, who, reason, trace, evidenceKey);
      await rt.ledger().append(ev);
    } else {
      ev = await rt.append(evKind, {
        runId: view.runId,
        trace,
        actor: { kind: 'human', id: who.id },
        idemKey: `${evKind}:${view.requestId}`,
        payload: { requestId: view.requestId, approver: { kind: 'human', id: who.id }, identity: identityJson(who), reason, sessionId: view.sessionId, actionHash: view.actionHash, evidenceKey },
      });
    }
  } catch (e) {
    c.out.error(`${kind}: the ledger recorded the decision but its ${evKind} event could not be written (${(e as Error).message}); it is not usable until recorded — run the same \`tecera ${kind}\` again`);
    c.out.set('error', 'event append failed');
    return EXIT.ledger;
  }
  return reportDecision(c, kind, view, who, trace, ev);
}

function decision(kind: 'approve' | 'deny'): Command {
  return async (c) => {
    const requestId = c.args.positionals[0];
    if (!requestId || c.args.positionals.length > 1) throw new CliError(`usage: tecera ${kind} <requestId> [--as <principal>] [--reason text]`, EXIT.usage);
    if (c.args.values.session !== undefined) throw new CliError(`${kind}: --session is not accepted; the session comes from the ledger`, EXIT.usage);
    const reason = c.args.values.reason?.trim() ?? '';
    if (kind === 'deny' && !reason) throw new CliError('deny: --reason is required', EXIT.usage);
    if (c.args.bools.yes) c.out.info('note: --yes never approves; this decision is the explicit command you ran');
    const rt = c.runtime();
    if (!rt.ledgerExists()) {
      c.out.error(`${kind}: no ledger yet`);
      return EXIT.error;
    }
    const ledger = rt.ledger();
    const view = await requireApproval(ledger, requestId);
    if (!view) {
      c.out.error(`${kind}: no approval request ${requestId} in the ledger`);
      return EXIT.error;
    }
    let who: HumanIdentity;
    try {
      who = localPrincipal(rt, { as: c.args.values.as });
    } catch (e) {
      if (e instanceof PrincipalError) {
        c.out.error(`${kind}: ${e.message}`);
        c.out.set('error', e.message);
        return e.exitCode;
      }
      throw e;
    }
    const req = await requestEvent(rt, view);
    const want = kind === 'approve' ? 'granted' : 'denied';
    if (view.state === want && view.approver?.kind === 'human' && view.approver.id === who.id && !(await decisionEvent(rt, requestId, kind === 'approve' ? 'approval.granted' : 'approval.denied'))) {
      c.out.info(`${kind}: ${requestId} is already ${want} by ${who.id} but its event is missing; recording it now`);
      return recordDecision(c, rt, kind, view, who, reason, req);
    }
    const refused = (e: unknown): number | null => {
      if (e instanceof LedgerError && e.code === 'approval') {
        const policy = SOD.test(e.message);
        c.out.error(`${kind}: ${e.message}`);
        c.out.set('error', e.message);
        return policy ? EXIT.policy : EXIT.error;
      }
      return null;
    };
    if (kind === 'deny') {
      try {
        await ledger.deny(requestId, { kind: 'human', id: who.id }, reason, rt.now());
      } catch (e) {
        const code = refused(e);
        if (code !== null) return code;
        throw e;
      }
      const after = await requireApproval(ledger, requestId);
      c.out.set('state', (after?.state ?? 'unknown') as Json);
      return recordDecision(c, rt, kind, after ?? view, who, reason, req);
    }
    // approve: the identity evidence first, then the grant and its audit event in one ledger transaction.
    const trace = traceOf(req);
    let audit: TeceraEvent;
    try {
      audit = grantedEvent(rt, view, who, reason, trace, await identityEvidence(rt, view, 'approval.granted', who));
    } catch (e) {
      c.out.error(`approve: could not record the approver's identity evidence (${(e as Error).message}); nothing was granted`);
      return EXIT.ledger;
    }
    try {
      await ledger.approve(requestId, { kind: 'human', id: who.id }, view.sessionId, rt.now(), audit);
    } catch (e) {
      const code = refused(e);
      if (code !== null) return code;
      if (e instanceof LedgerError) {
        c.out.error(`approve: the ledger refused the grant (${e.message}); nothing was granted`);
        return EXIT.ledger;
      }
      throw e;
    }
    const after = await requireApproval(ledger, requestId);
    c.out.set('state', (after?.state ?? 'unknown') as Json);
    return reportDecision(c, kind, after ?? view, who, trace, audit);
  };
}

export const approveCommand = decision('approve');
export const denyCommand = decision('deny');
