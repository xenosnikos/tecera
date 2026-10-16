import { readFileSync } from 'node:fs';
import type { OsDecisionIdentity } from '@tecera/contracts';
import type { HardenedConfig } from './config.js';

/**
 * The decision boundary of hardened mode. A human decision (approve, deny, criteria accept|amend,
 * plans|memory graduate|reject|retract, resources release|transfer, hardened enroll|abandon) is authorized
 * only when the calling process's real AND effective uid, read from the process credentials, are the
 * configured operator's and neither is an agent's. Nothing the caller supplies takes part: not an
 * environment variable, not `--as` (which stays an audit label), not a terminal. The check is in the
 * commands themselves, so it holds the same under Claude Code, Codex or a plain shell, with or without hooks.
 *
 * What it establishes: the decision was made by a process running as the operator identity. It does not say
 * which person at that account made it, and anything that can run code as the operator (or as root) can make
 * one.
 */

/** Where the credentials are read from: the process itself. An object so in-process tests can stand in a uid. */
export const processCredentials = {
  uid(): number {
    return typeof process.getuid === 'function' ? process.getuid() : -1;
  },
  euid(): number {
    return typeof process.geteuid === 'function' ? process.geteuid() : -1;
  },
  gid(): number {
    return typeof process.getgid === 'function' ? process.getgid() : -1;
  },
};

/** The account name of `uid` in the host's user database (informational only; never used to decide). */
export function accountName(uid: number): string | undefined {
  try {
    for (const line of readFileSync('/etc/passwd', 'utf8').split('\n')) {
      const f = line.split(':');
      if (f.length >= 3 && Number(f[2]) === uid && f[0]) return f[0];
    }
  } catch {
    /* no user database: no name */
  }
  return undefined;
}

/** The uid of account `name` in the host's user database, or null. */
export function accountUid(name: string): number | null {
  try {
    for (const line of readFileSync('/etc/passwd', 'utf8').split('\n')) {
      const f = line.split(':');
      if (f.length >= 3 && f[0] === name && /^\d+$/.test(f[2]!)) return Number(f[2]);
    }
  } catch {
    /* no user database */
  }
  return null;
}

/** The calling process's identity, as recorded on a hardened decision. */
export function callerIdentity(): OsDecisionIdentity {
  const uid = processCredentials.uid();
  const user = accountName(uid);
  return { uid, euid: processCredentials.euid(), gid: processCredentials.gid(), ...(user ? { user } : {}), boundary: 'operator-uid' };
}

/** Why the caller may not decide under `cfg` (null when it may). */
export function operatorRefusal(cfg: HardenedConfig, who: Pick<OsDecisionIdentity, 'uid' | 'euid'> = callerIdentity()): string | null {
  const agents = new Set(cfg.agents.map((a) => a.uid));
  const name = (uid: number): string => `uid ${uid}${accountName(uid) ? ` (${accountName(uid)})` : ''}`;
  if (who.uid < 0 || who.euid < 0) return 'this platform does not report process credentials';
  if (agents.has(who.uid) || agents.has(who.euid)) return `this process runs as ${name(agents.has(who.uid) ? who.uid : who.euid)}, an agent identity; human decisions are made by the operator identity (${name(cfg.operator.uid)})`;
  if (who.uid !== cfg.operator.uid || who.euid !== cfg.operator.uid) return `this process runs as ${name(who.uid)}${who.euid !== who.uid ? ` with effective ${name(who.euid)}` : ''}, not as the operator identity (${name(cfg.operator.uid)})`;
  return null;
}
