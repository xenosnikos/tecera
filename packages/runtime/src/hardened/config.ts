import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, normalize } from 'node:path';
import { EXIT } from '../errors.js';
import type { Env } from '../util/proc.js';

/**
 * Hardened mode's configuration: which identity owns Tecera's authoritative state (the operator), which
 * identities are agents, and where that state lives. It is a host file, not part of the business case:
 *
 * - the manifest (tecera.json) lives in the repository the agent edits, so a switch there could be removed
 *   by the agent and the mode downgraded. The host file is owned by root or the operator and cannot be;
 * - the fixed path (/etc/tecera/hardened.json) always wins when it exists. TECERA_HARDENED_CONFIG names
 *   another file only when there is none at the fixed path; it is for hosts without a writable /etc and for
 *   tests, and is only as strong as whatever sets that environment (an agent that controls the environment
 *   of the Stop hook can unset it, it cannot remove the fixed file);
 * - the file, and every directory above it, must be owned by root or the operator and writable by nobody
 *   else (the same rule as the state itself). A file that fails it is refused, never ignored: hardened mode
 *   that was asked for and cannot be established fails closed.
 *
 *   { "version": 1, "stateDir": "/var/lib/tecera",
 *     "operator": { "uid": 1000, "name": "nick" }, "agents": [{ "uid": 1001, "name": "tecera-agent" }] }
 */

export const HARDENED_CONFIG_PATH = '/etc/tecera/hardened.json';
export const HARDENED_CONFIG_ENV = 'TECERA_HARDENED_CONFIG';

export interface HardenedIdentity {
  uid: number;
  /** The account name (informational; the uid is what is checked). */
  name?: string;
}

export interface HardenedConfig {
  version: 1;
  /** Absolute directory that holds the state of every business case (one subdirectory each). */
  stateDir: string;
  /** Owns the state, runs the supervisor (`tecera run`) and makes the human decisions. */
  operator: HardenedIdentity;
  /** The identities a host assistant runs as: they may read the state, never write it or decide. */
  agents: HardenedIdentity[];
  /** The file this was read from. */
  source: string;
  /** How it was found: the fixed path, or the environment variable. */
  via: 'system' | 'env';
}

/** Hardened mode was configured but cannot be established (exit 3: not ready, fail closed). */
export class HardenedError extends Error {
  readonly exitCode: number = EXIT.notReady;
  constructor(message: string) {
    super(`hardened mode: ${message}`);
    this.name = 'HardenedError';
  }
}

/** Where the configuration is looked up; an object so a test can point the fixed path elsewhere. */
export const hardenedPaths = { system: HARDENED_CONFIG_PATH };

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new HardenedError(`${path} cannot be checked (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
  }
}

/** The configuration file in effect, or null in single-user mode. */
export function hardenedConfigPath(env: Env): { path: string; via: HardenedConfig['via'] } | null {
  if (present(hardenedPaths.system)) return { path: hardenedPaths.system, via: 'system' };
  const named = env[HARDENED_CONFIG_ENV];
  if (named === undefined || named === '') return null;
  if (!isAbsolute(named)) throw new HardenedError(`${HARDENED_CONFIG_ENV} must be an absolute path`);
  if (!present(named)) throw new HardenedError(`${HARDENED_CONFIG_ENV} names ${named}, which does not exist`);
  return { path: named, via: 'env' };
}

const uidOk = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 2 ** 32 - 1;

function identity(raw: unknown, where: string): HardenedIdentity {
  const r = raw as { uid?: unknown; name?: unknown } | null;
  if (!r || typeof r !== 'object' || Array.isArray(r) || !uidOk(r.uid)) throw new HardenedError(`${where} needs a numeric uid`);
  if (r.name !== undefined && (typeof r.name !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(r.name))) throw new HardenedError(`${where}.name must be a plain account name`);
  return { uid: r.uid, ...(typeof r.name === 'string' ? { name: r.name } : {}) };
}

/** Parse and check a configuration document (not its file's ownership; see loadHardenedConfig). */
export function parseHardenedConfig(raw: unknown, source: string, via: HardenedConfig['via']): HardenedConfig {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new HardenedError(`${source} is not a JSON object`);
  const extra = Object.keys(r).filter((k) => !['version', 'stateDir', 'operator', 'agents'].includes(k));
  if (extra.length) throw new HardenedError(`${source}: unknown field(s) ${extra.join(', ')}`);
  if (r.version !== 1) throw new HardenedError(`${source}: version must be 1`);
  const stateDir = typeof r.stateDir === 'string' ? r.stateDir.replace(/\/+$/, '') : '';
  if (!stateDir || !isAbsolute(stateDir) || normalize(stateDir) !== stateDir) throw new HardenedError(`${source}: stateDir must be a normalized absolute directory other than /`);
  const operator = identity(r.operator, `${source}: operator`);
  if (!Array.isArray(r.agents) || r.agents.length === 0) throw new HardenedError(`${source}: agents must list at least one identity`);
  const agents = r.agents.map((a, i) => identity(a, `${source}: agents[${i}]`));
  for (const a of agents) {
    if (a.uid === operator.uid) throw new HardenedError(`${source}: uid ${a.uid} is both the operator and an agent`);
    if (a.uid === 0) throw new HardenedError(`${source}: an agent cannot be root (uid 0)`);
  }
  return { version: 1, stateDir, operator, agents, source, via };
}

/**
 * Why `path` (and every directory above it) could be changed by someone other than `trusted` (empty when
 * nothing): each must be owned by a trusted uid, not a link, and not writable by group or others. A
 * directory above may be world-writable only with the sticky bit and owned by root (/tmp): others can add
 * entries there but not replace one they do not own.
 */
export function trustProblems(path: string, trusted: ReadonlySet<number>, what: string): string[] {
  const problems: string[] = [];
  let p = path;
  let leaf = true;
  for (;;) {
    let st;
    try {
      st = lstatSync(p);
    } catch (e) {
      problems.push(`${what}: ${p} cannot be checked (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
      break;
    }
    if (st.isSymbolicLink()) problems.push(`${what}: ${p} is a symbolic link`);
    else if (!trusted.has(st.uid)) problems.push(`${what}: ${p} is owned by uid ${st.uid}, not by root or the operator`);
    else if ((st.mode & 0o022) !== 0 && !(!leaf && st.isDirectory() && (st.mode & 0o1000) !== 0 && st.uid === 0)) problems.push(`${what}: ${p} is writable by group or others (mode ${(st.mode & 0o7777).toString(8)})`);
    const up = dirname(p);
    if (up === p) break;
    p = up;
    leaf = false;
  }
  return problems;
}

/** The hardened configuration in effect (checked: content and file trust), or null in single-user mode. */
export function loadHardenedConfig(env: Env): HardenedConfig | null {
  const found = hardenedConfigPath(env);
  if (!found) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(found.path, 'utf8'));
  } catch (e) {
    throw new HardenedError(`${found.path} is not readable JSON (${(e as Error).message})`);
  }
  const cfg = parseHardenedConfig(raw, found.path, found.via);
  const problems = trustProblems(found.path, new Set([0, cfg.operator.uid]), 'configuration');
  if (problems.length) throw new HardenedError(`the configuration cannot be trusted: ${problems.join('; ')}`);
  return cfg;
}
