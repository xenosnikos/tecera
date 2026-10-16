import type { Json, OsDecisionIdentity } from '@tecera/contracts';
import { EXIT } from './errors.js';
import { callerIdentity, operatorRefusal } from './hardened/authority.js';
import type { Runtime } from './runtime.js';

/**
 * The human principal behind an approval or a learning decision (owner decision D1: no auth package, no
 * token ingress). A decision is made by the local human running the command: `--as <id>`, else $USER
 * (then $USERNAME). The principal is recorded as {kind:'human', id, method:'local', source} in the audited
 * decision event (approval.granted / approval.denied, plan/memory decisions) and its identity evidence.
 *
 * What still holds without tokens:
 * - separation of duty: the ledger refuses an approver equal to the requester (exit 8) and any non-human
 *   approver; requests are made by the loop (an agent), so a grant is always a human other than it;
 * - a mediated agent shell cannot reach these commands: the Claude Code pre-tool hook refuses
 *   `tecera approve|deny|plans|memory` (hook.ts), and `--yes` never approves anything. Hosts without that
 *   hook have only the commands' own accident guard (decisionGuard.ts: agent-host markers, a terminal on
 *   stdin), which a process with a shell can get around. Neither is authentication: the id is a recorded
 *   claim;
 * - the approval's session, run and action hash come from the ledger, never from the caller.
 *
 * Hardened mode (hardened/authority.ts) adds the one check that is not a claim: the deciding process's real
 * and effective uid are the configured operator's. The principal then carries `method: 'operator-uid'` and
 * the OS identity (`os`: uid, euid, gid, account name) read from the process credentials. `--as` is still
 * only the label of the person, and `authenticated` stays false: the uid shows the decision came from the
 * operator identity, not which person used it.
 */

export interface HumanIdentity {
  kind: 'human';
  id: string;
  /** 'local' (D1): the person running the CLI, by name only. 'operator-uid': hardened mode, by OS identity too. */
  method: 'local' | 'operator-uid';
  /** No cryptographic authentication is involved (recorded so nobody mistakes it for a token). */
  authenticated: false;
  /** Where the id came from: the --as flag or the login environment. */
  source: 'as' | 'env:USER' | 'env:USERNAME';
  /** Hardened mode: the process credentials the decision was authorized on. */
  os?: OsDecisionIdentity;
}

export class PrincipalError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = 'PrincipalError';
  }
}

const PLAIN_ID = /^[A-Za-z0-9_.@+-]{1,128}$/;

/** The local human making a decision. Throws PrincipalError (exit 2) when there is none or it is malformed. */
export function localPrincipal(rt: Pick<Runtime, 'env'> & Partial<Pick<Runtime, 'hardened'>>, opts: { as?: string }): HumanIdentity {
  const asFlag = opts.as?.trim();
  const user = rt.env.USER?.trim();
  const username = rt.env.USERNAME?.trim();
  const [id, source]: [string | undefined, HumanIdentity['source']] = asFlag ? [asFlag, 'as'] : user ? [user, 'env:USER'] : [username, 'env:USERNAME'];
  if (!id) throw new PrincipalError('no principal: pass --as <id> (default $USER)', EXIT.usage);
  if (!PLAIN_ID.test(id)) throw new PrincipalError(`${source === 'as' ? '--as' : `$${source.slice(4)}`} must be a plain identifier`, EXIT.usage);
  if (rt.hardened) {
    // The commands checked this already (decisionGuard); checked again where the principal is made.
    const os = callerIdentity();
    const refused = operatorRefusal(rt.hardened.config, os);
    if (refused) throw new PrincipalError(`hardened mode: ${refused}`, EXIT.policy);
    return { kind: 'human', id, method: 'operator-uid', authenticated: false, source, os };
  }
  return { kind: 'human', id, method: 'local', authenticated: false, source };
}

export function identityJson(i: HumanIdentity): Json {
  return { kind: i.kind, id: i.id, method: i.method, authenticated: i.authenticated, source: i.source, ...(i.os ? { os: { ...i.os } as unknown as Json } : {}) };
}
