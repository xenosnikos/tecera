import { makeRedactor, MIN_SECRET_CHARS, RedactionError, type Manifest, type Redactor, type SecretInput } from '@tecera/contracts';
import { SecretStore } from '@tecera/providers';
import { providerSetup } from './providerSetup.js';
import type { Env } from './util/proc.js';

/**
 * The runtime's secret boundary (docs/security.md §7). At startup the supervisor:
 *
 * 1. resolves every `providers.<name>.auth` reference through @tecera/providers' SecretStore, which deletes
 *    each resolved `env:` variable from the environment it was given (process.env in the real CLI);
 * 2. builds ONE contracts redactor over: every resolved credential, every
 *    `TECERA_CANARY_*` value, and every other environment value whose NAME looks like a credential
 *    (KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL/AUTH). Encoded forms and SECRET_PATTERNS come from contracts.
 *
 * A manifest-referenced credential shorter than 8 characters cannot be redacted reliably: startup fails
 * closed (RedactionError). Heuristic environment values shorter than 8 characters are skipped (they are not
 * referenced by the manifest and are never handed to anything).
 */

export const CREDENTIAL_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
export const CANARY_NAME = /^TECERA_CANARY_/;

export interface SecretStatus {
  provider: string;
  ref: string;
  /** env var name for `env:` refs (names only, never values). */
  envName?: string;
  resolved: boolean;
  /** Why resolution failed (never contains the value). */
  error?: string;
}

/** Secrets visible in an environment by name: canaries and credential-shaped names. Values only go to the redactor. */
export function envSecretInputs(env: Env): SecretInput[] {
  const out: SecretInput[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.length < MIN_SECRET_CHARS) continue;
    if (CANARY_NAME.test(name)) out.push({ kind: 'canary', value });
    else if (CREDENTIAL_NAME.test(name)) out.push({ kind: 'env-secret', value });
  }
  return out;
}

function dedupe(inputs: readonly SecretInput[]): SecretInput[] {
  const seen = new Set<string>();
  const out: SecretInput[] = [];
  for (const i of inputs) {
    const v = typeof i === 'string' ? i : i.value;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(i);
  }
  return out;
}

export class RuntimeSecrets {
  /** Resolved provider credentials (SecretHandle objects; values never leave except through authorize()). */
  readonly store: SecretStore;
  readonly status: SecretStatus[];
  readonly redactor: Redactor;
  readonly #inputs: readonly SecretInput[];

  private constructor(store: SecretStore, status: SecretStatus[], redactor: Redactor, inputs: readonly SecretInput[]) {
    this.store = store;
    this.status = status;
    this.redactor = redactor;
    this.#inputs = inputs;
  }

  /**
   * Resolve the manifest's provider references from `env` (deleting what was resolved) and build the
   * redactor. `extra` adds values known to the caller (e.g. secrets seen in
   * the environment before an earlier component deleted them).
   */
  static load(manifest: Pick<Manifest, 'providers'>, env: Env, opts: { cwd: string; extra?: readonly SecretInput[]; deleteFromEnv?: boolean }): RuntimeSecrets {
    const seen = envSecretInputs(env);
    // The kinds map must match the one createProvider gets (providerSetup: OpenRouter on older providers builds).
    const kinds = providerSetup(manifest).kinds;
    const store = new SecretStore({ env, cwd: opts.cwd, deleteFromEnv: opts.deleteFromEnv ?? true, ...(Object.keys(kinds).length ? { kinds } : {}) });
    const status: SecretStatus[] = [];
    for (const [name, p] of Object.entries(manifest.providers)) {
      const m = /^env:([A-Z_][A-Z0-9_]*)$/.exec(p.auth);
      try {
        store.resolve(name, p.auth);
        status.push({ provider: name, ref: p.auth, ...(m ? { envName: m[1]! } : {}), resolved: true });
      } catch (err) {
        status.push({ provider: name, ref: p.auth, ...(m ? { envName: m[1]! } : {}), resolved: false, error: (err as Error).message });
      }
    }
    const inputs: SecretInput[] = [];
    for (const v of store.canaryValues()) inputs.push({ kind: 'credential', value: v });
    inputs.push(...seen, ...(opts.extra ?? []));
    for (const i of inputs) {
      const v = typeof i === 'string' ? i : i.value;
      if (v.length < MIN_SECRET_CHARS) throw new RedactionError(`a configured secret (${typeof i === 'string' ? 'secret' : i.kind}) is shorter than ${MIN_SECRET_CHARS} characters and cannot be redacted reliably; refusing to start`);
    }
    const all = dedupe(inputs);
    return new RuntimeSecrets(store, status, makeRedactor(all), all);
  }

  /**
   * Every secret the redactor knows (credentials, canaries, credential-named env values), as
   * contracts SecretInput. For components that build their own redactor or canary (worker, policy hooks):
   * they must see the same set as the ledger boundary. Never log, persist or render the result.
   */
  secretInputs(): SecretInput[] {
    return [...this.#inputs];
  }

  toJSON(): { providers: string[] } {
    return { providers: this.store.names() };
  }
}

/** A redactor over values seen in an environment only (CLI output before the business case loads). */
export function envRedactor(env: Env): Redactor {
  return makeRedactor(dedupe(envSecretInputs(env)));
}
