import type { Redactor } from '@tecera/contracts';
import type { Env } from './util/proc.js';

/**
 * The verify environment. A repository's `sandbox.envAllowlist` is a REQUEST; the supervisor grants only
 * its intersection with SAFE_ENV, and refuses outright (validate exit 2, and again before every spawn) any
 * requested name that looks like a credential or a loader/shell injection point. A granted name whose
 * value contains a known secret is dropped too. Nothing is inherited implicitly.
 */

/** The only names a verify child may ever receive. */
export const SAFE_ENV: readonly string[] = [
  'PATH',
  'HOME',
  'CI',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TERM',
  'TZ',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'NODE_ENV',
  'NO_COLOR',
  'FORCE_COLOR',
];

const UNSAFE: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i, why: 'looks like a credential' },
  { re: /^TECERA_CANARY_/i, why: 'is a canary' },
  { re: /^NODE_OPTIONS$/i, why: 'injects code into node' },
  { re: /^NODE_PATH$/i, why: 'redirects module loading' },
  { re: /^LD_/, why: 'injects a dynamic loader setting' },
  { re: /^DYLD_/, why: 'injects a dynamic loader setting' },
  { re: /^(BASH_ENV|ENV|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|PS4|IFS)$/, why: 'runs shell code at startup' },
  { re: /^BASH_FUNC_/, why: 'defines exported shell functions' },
  { re: /^(PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PERL5LIB|PERL5OPT|PERLLIB|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS)$/, why: 'injects code into an interpreter' },
  { re: /^(GIT_|SSH_|GPG_|GNUPG)/, why: 'controls git, ssh or gpg' },
  { re: /^npm_config_/i, why: 'controls npm (scripts, registry credentials)' },
];

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Why `name` must never reach a verify child, or null when it is not inherently unsafe. */
export function unsafeEnvName(name: string): string | null {
  if (!NAME.test(name)) return 'is not a valid variable name';
  for (const u of UNSAFE) if (u.re.test(name)) return u.why;
  return null;
}

export class UnsafeEnvError extends Error {
  constructor(readonly names: Array<{ name: string; why: string }>) {
    super(`sandbox.envAllowlist requests unsafe variables: ${names.map((n) => `${n.name} (${n.why})`).join(', ')}; remove them from tecera.json`);
    this.name = 'UnsafeEnvError';
  }
}

export interface AllowlistReview {
  /** Requested names refused outright (configuration error). */
  unsafe: Array<{ name: string; why: string }>;
  /** Requested names that are not on SAFE_ENV and will not be passed. */
  ignored: string[];
  /** Names that will be passed when set. */
  granted: string[];
}

export function reviewAllowlist(allowlist: readonly string[]): AllowlistReview {
  const out: AllowlistReview = { unsafe: [], ignored: [], granted: [] };
  for (const name of new Set(allowlist)) {
    const why = unsafeEnvName(name);
    if (why) out.unsafe.push({ name, why });
    else if (SAFE_ENV.includes(name)) out.granted.push(name);
    else out.ignored.push(name);
  }
  return out;
}

export interface VerifyEnv {
  env: Record<string, string>;
  /** Names requested but not passed (not on SAFE_ENV, or the value carried a known secret). Names only. */
  dropped: string[];
}

/** The env a verify child receives. Throws UnsafeEnvError if the allowlist requests an unsafe name. */
export function buildVerifyEnv(source: Env, allowlist: readonly string[], redactor?: Redactor): VerifyEnv {
  const review = reviewAllowlist(allowlist);
  if (review.unsafe.length) throw new UnsafeEnvError(review.unsafe);
  const env: Record<string, string> = {};
  const dropped = [...review.ignored];
  for (const name of review.granted) {
    const v = source[name];
    if (typeof v !== 'string') continue;
    if (redactor && redactor.containsSecret(v)) {
      dropped.push(name);
      continue;
    }
    env[name] = v;
  }
  return { env, dropped };
}
