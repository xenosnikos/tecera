import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '../util/proc.js';
import { accountName, processCredentials } from './authority.js';
import { hardenedConfigPath, HARDENED_CONFIG_PATH, loadHardenedConfig, trustProblems, type HardenedConfig } from './config.js';
import { checkIdentityProblem, placementProblem, stateProblems, type HardenedContext } from './context.js';

/**
 * `tecera doctor`'s hardened section: whether this host meets hardened mode's preconditions. In single-user
 * mode it only notes the mode (nothing is missing: single-user mode is a supported mode with documented
 * limits). With a hardened configuration every unmet precondition is `missing` (exit 3):
 *
 * - the configuration is found, well formed and owned by root or the operator;
 * - the operator and the agents are distinct, no agent is root;
 * - the state directory, everything in it and every directory above it cannot be written by an agent
 *   (ownership and modes; when this runs as root it also tries, as each agent uid, to create a file there and
 *   expects to be refused); the state lives outside the business case and the worktrees;
 * - Tecera's own installation and the Node binary cannot be written by an agent (a supervisor running code
 *   the agent can change is not a boundary);
 * - checks (repository code) do not run as root or as the operator: TECERA_VERIFY_UID/GID names another
 *   identity, which a root supervisor switches to;
 * - which identity this process is (operator: may run and decide; agent: reads only);
 * - the host's enforcement: for Claude Code the Stop and pre-tool hooks must come from the host's managed
 *   settings, not from the repository the agent edits (reported as a note when they are not found there);
 *   Codex installs no hooks, so the decision boundary holds there but stopping is not enforced.
 */

export type HardenedCheck = { name: string; status: 'ok' | 'note' | 'missing'; detail: string };

/** Where Claude Code reads managed (administrator) settings on Linux. */
export const CLAUDE_MANAGED_SETTINGS = '/etc/claude-code/managed-settings.json';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** As root: try to create a file in `dir` as `uid`; true when that was refused. */
function agentRefused(dir: string, uid: number): boolean | null {
  if (processCredentials.euid() !== 0) return null;
  const probe = join(dir, `.tecera-doctor-probe-${process.pid}`);
  const r = spawnSync('/bin/sh', ['-c', ': > "$1"', 'sh', probe], { uid, gid: uid, timeout: 10_000, stdio: 'ignore' });
  if (r.error) return null;
  if (existsSync(probe)) {
    rmSync(probe, { force: true });
    return false;
  }
  return r.status !== 0;
}

function identities(cfg: HardenedConfig): string {
  const n = (uid: number, name?: string): string => `${name ?? accountName(uid) ?? '?'} (uid ${uid})`;
  return `operator ${n(cfg.operator.uid, cfg.operator.name)} · agent${cfg.agents.length > 1 ? 's' : ''} ${cfg.agents.map((a) => n(a.uid, a.name)).join(', ')}`;
}

export function hardenedChecks(env: Env, root: string | null, h: HardenedContext | null): HardenedCheck[] {
  const out: HardenedCheck[] = [];
  const add = (name: string, status: HardenedCheck['status'], detail: string): void => void out.push({ name, status, detail });
  let cfg: HardenedConfig | null;
  try {
    cfg = loadHardenedConfig(env);
  } catch (e) {
    add('hardened', 'missing', (e as Error).message);
    return out;
  }
  if (!cfg) {
    add('hardened', 'note', `single-user mode (no ${HARDENED_CONFIG_PATH}): Tecera, the host assistant and the ledger share one OS identity, so the ledger records but does not authenticate; see \`tecera hardened init\` to separate them`);
    return out;
  }
  const found = hardenedConfigPath(env);
  add('hardened', 'ok', `configuration ${cfg.source}${found?.via === 'env' ? ' (named by TECERA_HARDENED_CONFIG: only as strong as whatever sets the environment; install it at ' + HARDENED_CONFIG_PATH + ')' : ''} · ${identities(cfg)}`);
  const state = stateProblems(cfg);
  add('hardened:state', state.length ? 'missing' : 'ok', state.length ? state.slice(0, 5).join('; ') : `${cfg.stateDir}: owned by root or the operator, writable by nobody else`);
  for (const a of cfg.agents) {
    const r = state.length ? null : agentRefused(cfg.stateDir, a.uid);
    if (r === false) add(`hardened:probe:${a.uid}`, 'missing', `uid ${a.uid} could create a file in ${cfg.stateDir}`);
    else if (r === true) add(`hardened:probe:${a.uid}`, 'ok', `uid ${a.uid} cannot create a file in ${cfg.stateDir}`);
  }
  if (root) {
    const placed = placementProblem(cfg, root, env);
    add('hardened:placement', placed ? 'missing' : 'ok', placed ?? `the state is outside the business case and the worktrees${h ? ` · case ${h.caseId}` : ''}`);
  }
  const trusted = new Set([0, cfg.operator.uid]);
  const install = [...trustProblems(PKG_ROOT, trusted, 'installation'), ...trustProblems(process.execPath, trusted, 'node')];
  add('hardened:install', install.length ? 'missing' : 'ok', install.length ? `${install.slice(0, 3).join('; ')}${install.length > 3 ? `; ${install.length - 3} more` : ''} — the supervisor must not run code an agent can change` : `${PKG_ROOT} and ${process.execPath} cannot be written by an agent`);
  const checkAs = checkIdentityProblem(cfg, env);
  add('hardened:checks', checkAs ? 'missing' : 'ok', checkAs ?? 'checks run as an identity that is neither root nor the operator');
  const uid = processCredentials.uid();
  const role = uid === cfg.operator.uid && processCredentials.euid() === uid ? 'the operator: may run, resume and decide' : cfg.agents.some((a) => a.uid === uid) ? 'an agent: reads the state, cannot write it or decide' : 'neither operator nor agent: reads the state at most, cannot decide';
  add('hardened:identity', 'note', `this process is uid ${uid}${accountName(uid) ? ` (${accountName(uid)})` : ''}, ${role}`);
  let managed = '';
  try {
    managed = readFileSync(CLAUDE_MANAGED_SETTINGS, 'utf8');
  } catch {
    managed = '';
  }
  add('hardened:claude-code', /tecera hook stop/.test(managed) ? 'ok' : 'note', /tecera hook stop/.test(managed) ? `Stop hook installed in ${CLAUDE_MANAGED_SETTINGS}` : `no Tecera Stop hook in ${CLAUDE_MANAGED_SETTINGS}: hooks from the repository's own settings can be removed by the agent; install them in managed settings`);
  add('hardened:codex', 'note', 'Codex installs no hooks: the decision commands still refuse the agent identity, but nothing stops a Codex session over an open run');
  return out;
}
