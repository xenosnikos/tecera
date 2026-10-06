import { containsSecret } from '@tecera/contracts';

/**
 * Environment construction for every process the sandbox starts (REPL child and verify command).
 *
 * The env is the INTERSECTION of the manifest allowlist with a supervisor-owned SAFE_ENV list. Nothing is
 * inherited implicitly. An allowlisted name outside SAFE_ENV is dropped (and reported by name). A
 * dangerous name (credential-shaped, loader or shell startup hook) is REFUSED with an error even when the
 * manifest allowlists it: a manifest that asks for one is a configuration error, not something to paper
 * over. A SAFE_ENV value that contains a secret pattern (key shape, JWT, Tecera canary) is refused too.
 */

/** The only names that may ever cross into a sandbox or verify env. */
export const SANDBOX_SAFE_ENV: readonly string[] = Object.freeze(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CI', 'TERM', 'NO_COLOR']);

const DANGEROUS: readonly RegExp[] = [
  /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i,
  /^NODE_OPTIONS$/i,
  /^LD_PRELOAD$/i,
  /^LD_LIBRARY_PATH$/i,
  /^LD_/,
  /^DYLD_/,
  /^NODE_PATH$/,
  /^BASH_ENV$/,
  /^ENV$/,
  /^BASH_FUNC_/,
  /^PROMPT_COMMAND$/,
];

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class EnvRefused extends Error {
  constructor(
    message: string,
    /** Offending names (never values). */
    public readonly names: string[],
  ) {
    super(message);
    this.name = 'EnvRefused';
  }
}

export interface ScrubbedEnv {
  env: Record<string, string>;
  /** Allowlisted names that are not in SANDBOX_SAFE_ENV and were dropped (names only, never values). */
  dropped: string[];
}

/** True for names that are refused outright (credential-shaped, loader/startup hooks, malformed). */
export function isDeniedEnvName(name: string): boolean {
  return typeof name !== 'string' || !NAME_RE.test(name) || DANGEROUS.some((re) => re.test(name));
}

/** Throws EnvRefused when the allowlist names any dangerous variable. */
export function assertEnvAllowlist(allowlist: readonly string[]): void {
  const bad = [...new Set(allowlist)].filter((n) => isDeniedEnvName(n));
  if (bad.length) throw new EnvRefused(`env allowlist names refused variables: ${bad.join(', ')}`, bad);
}

/**
 * Build `allowlist ∩ SANDBOX_SAFE_ENV` from `source`, then apply `forced` (supervisor-owned values, which
 * win and are not subject to the allowlist; their names must still be in SANDBOX_SAFE_ENV).
 * Throws EnvRefused for a dangerous allowlisted name or a value carrying a secret pattern.
 */
export function scrubEnv(allowlist: readonly string[], source: NodeJS.ProcessEnv = process.env, forced: Record<string, string> = {}): ScrubbedEnv {
  assertEnvAllowlist(allowlist);
  const env: Record<string, string> = {};
  const dropped: string[] = [];
  for (const name of new Set(allowlist)) {
    if (!SANDBOX_SAFE_ENV.includes(name)) {
      dropped.push(name);
      continue;
    }
    const v = source[name];
    if (typeof v === 'string') env[name] = v;
  }
  for (const [k, v] of Object.entries(forced)) {
    if (!SANDBOX_SAFE_ENV.includes(k)) throw new EnvRefused(`forced env name ${k} is not in SANDBOX_SAFE_ENV`, [k]);
    env[k] = v;
  }
  const leaking = Object.entries(env)
    .filter(([, v]) => containsSecret(v, []) !== null)
    .map(([k]) => k);
  if (leaking.length) throw new EnvRefused(`env values carry secret patterns: ${leaking.join(', ')}`, leaking);
  return { env, dropped };
}
