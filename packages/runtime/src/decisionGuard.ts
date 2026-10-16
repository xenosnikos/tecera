import { isatty } from 'node:tty';
import type { Json, OsDecisionIdentity } from '@tecera/contracts';
import { SANDBOX_MARKER_ENV } from '@tecera/worker';
import type { CommandContext } from './cli/context.js';
import { EXIT } from './errors.js';
import { callerIdentity, operatorRefusal } from './hardened/authority.js';
import { HardenedError, loadHardenedConfig } from './hardened/config.js';
import type { Env } from './util/proc.js';

/**
 * Accident guard for the human decision commands (`approve`, `deny`, `criteria accept|amend`,
 * `plans|memory graduate|reject|retract`, `resources release|transfer`).
 *
 * THIS IS NOT AUTHENTICATION. It stops a decision from being made by accident from inside an agent host or
 * a script: it refuses when the environment carries a known agent-host marker or when stdin is not a
 * terminal. It does not stop a process that wants to get past it: anything with a shell can allocate a
 * pseudo-terminal and unset variables. The approver stays what principal.ts says it is, a recorded name.
 *
 * A person who really runs a decision without a terminal (their own script, CI they control) sets
 * TECERA_DECISION_NONINTERACTIVE=1. An agent host that scrubs or deny-lists its tools' environment should
 * cover that variable, so an agent does not inherit the opt-out.
 *
 * Hardened mode is different, and checked first: the command refuses (exit 8) unless the process's real and
 * effective uid are the configured operator's and not an agent's (hardened/authority.ts). That check reads
 * the process credentials only; no variable, flag or terminal changes its answer. A configuration that cannot
 * be trusted refuses too (exit 3). The OS identity is recorded with the guard (`os`).
 */

/** Set to exactly `1` to run a decision command without a terminal or under an agent-host marker. */
export const DECISION_NONINTERACTIVE_ENV = 'TECERA_DECISION_NONINTERACTIVE';

/**
 * Environment markers of an agent host: the ONE list. Exact names, and prefixes that match any variable.
 * - CLAUDECODE, CLAUDE_CODE_ENTRYPOINT: set by Claude Code for the commands it runs.
 * - CODEX_*: set by Codex hosts (CODEX_SANDBOX, CODEX_SANDBOX_NETWORK_DISABLED, …).
 * - TECERA_SANDBOX: Tecera's own; the worker sandbox sets it for the REPL child and for verify commands.
 */
export const AGENT_HOST_MARKERS: { readonly names: readonly string[]; readonly prefixes: readonly string[] } = Object.freeze({
  names: Object.freeze(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', SANDBOX_MARKER_ENV]),
  prefixes: Object.freeze(['CODEX_']),
});

/** The conditions the guard saw, as recorded on a decision's audit event (names only, never values). */
export interface DecisionGuardRecord {
  /** stdin of the deciding process was a terminal. */
  stdinTty: boolean;
  /** Agent-host markers present in its environment (sorted names). */
  agentMarkers: string[];
  /** TECERA_DECISION_NONINTERACTIVE=1 was set: the checks above were waived by the operator. */
  nonInteractiveOptOut: boolean;
  /** Hardened mode: the operator identity the decision was authorized on (process credentials). */
  os?: OsDecisionIdentity;
}

export interface DecisionGuardVerdict extends DecisionGuardRecord {
  refused: boolean;
}

/** Where the guard reads the terminal from (an object so tests can stand in a terminal). */
export const decisionTerminal = {
  stdinIsTTY(): boolean {
    try {
      return isatty(0);
    } catch {
      return false;
    }
  },
};

/** Names of the agent-host markers set in `env` (a set-but-empty variable counts: it was put there). */
export function agentMarkersIn(env: Env): string[] {
  const hit = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (AGENT_HOST_MARKERS.names.includes(name) || AGENT_HOST_MARKERS.prefixes.some((p) => name.startsWith(p))) hit.add(name);
  }
  return [...hit].sort();
}

/** Pure decision: refuse on a marker or without a terminal, unless the operator opted out explicitly. */
export function decisionGuard(env: Env, stdinTty: boolean): DecisionGuardVerdict {
  const agentMarkers = agentMarkersIn(env);
  const nonInteractiveOptOut = env[DECISION_NONINTERACTIVE_ENV] === '1';
  return { stdinTty, agentMarkers, nonInteractiveOptOut, refused: !nonInteractiveOptOut && (agentMarkers.length > 0 || !stdinTty) };
}

export function guardJson(g: DecisionGuardRecord): Json {
  return { stdinTty: g.stdinTty, agentMarkers: [...g.agentMarkers], nonInteractiveOptOut: g.nonInteractiveOptOut, ...(g.os ? { os: { ...g.os } as unknown as Json } : {}) };
}

/** Why a verdict refused, for the message (markers by name; values are never printed). */
function refusalReasons(g: DecisionGuardVerdict): string {
  const why: string[] = [];
  if (g.agentMarkers.length) why.push(`agent-host marker${g.agentMarkers.length > 1 ? 's' : ''} in the environment: ${g.agentMarkers.slice(0, 8).join(', ')}${g.agentMarkers.length > 8 ? ', …' : ''}`);
  if (!g.stdinTty) why.push('stdin is not a terminal');
  return why.join('; ');
}

/**
 * Run the guard for one decision command. Returns the conditions to record, or the exit code (8) after
 * printing why it refused. Call it before anything is read or written for the decision.
 */
export function guardDecision(c: Pick<CommandContext, 'opts' | 'out'>, what: string): DecisionGuardRecord | number {
  let os: OsDecisionIdentity | undefined;
  try {
    const cfg = loadHardenedConfig(c.opts.env);
    if (cfg) {
      os = callerIdentity();
      const refused = operatorRefusal(cfg, os);
      if (refused) {
        c.out.error(`${what}: refused. Hardened mode: ${refused}. Run it as the operator. (--as only labels who decided; it does not change who may.)`);
        c.out.set('error', 'hardened mode: not the operator identity');
        c.out.set('os', { ...os } as unknown as Json);
        return EXIT.policy;
      }
    }
  } catch (e) {
    if (!(e instanceof HardenedError)) throw e;
    c.out.error(`${what}: refused. ${e.message}`);
    c.out.set('error', e.message);
    return e.exitCode;
  }
  const g = decisionGuard(c.opts.env, decisionTerminal.stdinIsTTY());
  const record: DecisionGuardRecord = { stdinTty: g.stdinTty, agentMarkers: g.agentMarkers, nonInteractiveOptOut: g.nonInteractiveOptOut, ...(os ? { os } : {}) };
  if (!g.refused) return record;
  c.out.error(
    `${what}: refused. This is a human decision, and this does not look like a person at a terminal (${refusalReasons(g)}). ` +
      `Run it yourself in a terminal. For deliberate non-interactive use by a human (your own script, CI you control) set ${DECISION_NONINTERACTIVE_ENV}=1. ` +
      'This check prevents accidents; it is not authentication.',
  );
  c.out.set('error', 'decision guard: not a person at a terminal');
  c.out.set('guard', guardJson(record));
  return EXIT.policy;
}
