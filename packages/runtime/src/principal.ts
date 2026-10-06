import type { Json } from '@tecera/contracts';
import { EXIT } from './errors.js';
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
 * - agents cannot reach this command: the host pre-tool hook refuses `tecera approve|deny|plans|memory`
 *   from a mediated shell (hook.ts), and `--yes` never approves anything;
 * - the approval's session, run and action hash come from the ledger, never from the caller.
 */

export interface HumanIdentity {
  kind: 'human';
  id: string;
  /** Always 'local' (D1): the principal is the person running the CLI. */
  method: 'local';
  /** No cryptographic authentication is involved (recorded so nobody mistakes it for a token). */
  authenticated: false;
  /** Where the id came from: the --as flag or the login environment. */
  source: 'as' | 'env:USER' | 'env:USERNAME';
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
export function localPrincipal(rt: Pick<Runtime, 'env'>, opts: { as?: string }): HumanIdentity {
  const asFlag = opts.as?.trim();
  const user = rt.env.USER?.trim();
  const username = rt.env.USERNAME?.trim();
  const [id, source]: [string | undefined, HumanIdentity['source']] = asFlag ? [asFlag, 'as'] : user ? [user, 'env:USER'] : [username, 'env:USERNAME'];
  if (!id) throw new PrincipalError('no principal: pass --as <id> (default $USER)', EXIT.usage);
  if (!PLAIN_ID.test(id)) throw new PrincipalError(`${source === 'as' ? '--as' : `$${source.slice(4)}`} must be a plain identifier`, EXIT.usage);
  return { kind: 'human', id, method: 'local', authenticated: false, source };
}

export function identityJson(i: HumanIdentity): Json {
  return { kind: i.kind, id: i.id, method: i.method, authenticated: i.authenticated, source: i.source };
}
