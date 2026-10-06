import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { inspect } from 'node:util';
import { sha256 } from '@tecera/contracts';
import { authScheme, inferKind, KEY_ENV, PROVIDER_KINDS, type ProviderKind } from './kinds.js';
import { makeRedactor, MIN_SECRET_CHARS, type Redactor, type SecretInput } from './redact.js';

/**
 * Secrets are resolved once, in the supervisor, from manifest references (`env:NAME`,
 * `file:path#KEY`, `keychain:...`) into SecretHandle objects. A handle never yields its value through
 * any generic path: toString/toJSON/valueOf/toPrimitive/inspect throw, the value is not an own
 * property (it lives in a module-private WeakMap), so Object.keys, JSON.stringify, structuredClone
 * and spreading expose nothing. The only ways out are `authorize(headers)` (adds the provider auth
 * header for an outgoing request) and `SecretStore.canaryValues()` (raw values, for the supervisor's
 * secretCanary hook only). Resolving an `env:` reference deletes the variable from the environment
 * (once per reference: several provider aliases may share one `env:` ref; the value is cached privately).
 *
 * Redaction is the shared contracts redactor. A handle resolved by a store is linked to it, so a
 * provider built directly from such a handle still redacts every value the store knows (all provider
 * keys, their auth header values, and registered extras such as canaries), not only its own key.
 * Values shorter than MIN_SECRET_CHARS (8) are refused: they cannot be redacted reliably.
 */

export class SecretError extends Error {
  constructor(message: string, public readonly ref: string) {
    super(message);
    this.name = 'SecretError';
  }
}

export class UnsupportedRefError extends SecretError {
  constructor(ref: string) {
    super(`unsupported secret reference "${ref}": keychain references are not supported in v1; use env: or file:`, ref);
    this.name = 'UnsupportedRefError';
  }
}

const VALUES = new WeakMap<SecretHandle, string>();
const STORES = new WeakMap<SecretHandle, SecretStore>();
const LEAK = 'SecretHandle cannot be serialized, stringified or inspected; use authorize(headers)';

export class SecretHandle {
  /** Manifest provider name this secret belongs to (or the kind of a registered extra secret). */
  declare readonly name: string;
  /** The original reference, e.g. `env:ANTHROPIC_API_KEY`. Not secret. */
  declare readonly ref: string;
  /** Wire kind, decides the auth header. Null for non-provider secrets (canaries). */
  declare readonly kind: ProviderKind | null;
  /** First 16 hex chars of sha256(value); the key id compared by the foreign-review check. Never the key. */
  declare readonly fingerprint: string;

  constructor(name: string, ref: string, kind: ProviderKind | null, value: string) {
    if (typeof value !== 'string' || value.length === 0) throw new SecretError(`secret for "${name}" is empty`, ref);
    if (value.length < MIN_SECRET_CHARS) throw new SecretError(`secret for "${name}" is shorter than ${MIN_SECRET_CHARS} characters and cannot be redacted reliably; refusing`, ref);
    Object.defineProperties(this, {
      name: { value: name, enumerable: true },
      ref: { value: ref, enumerable: true },
      kind: { value: kind, enumerable: true },
      fingerprint: { value: sha256(value).slice(0, 16), enumerable: true },
    });
    VALUES.set(this, value);
    Object.freeze(this);
  }

  /** Return a copy of `headers` with this provider's auth header added. */
  authorize(headers: Readonly<Record<string, string>> = {}): Record<string, string> {
    const v = VALUES.get(this);
    if (v === undefined || !this.kind) throw new SecretError(`secret "${this.name}" is not a provider credential`, this.ref);
    const s = authScheme(this.kind);
    return { ...headers, [s.header]: s.prefix + v };
  }

  /** Redact this secret (all encodings, its auth header value) plus SECRET_PATTERNS from text. */
  redact(text: string): string {
    return makeRedactor(handleInputs(this)).redactText(text);
  }

  toString(): string {
    throw new SecretError(LEAK, this.ref);
  }
  toJSON(): never {
    throw new SecretError(LEAK, this.ref);
  }
  valueOf(): never {
    throw new SecretError(LEAK, this.ref);
  }
  [Symbol.toPrimitive](): never {
    throw new SecretError(LEAK, this.ref);
  }
  [inspect.custom](): never {
    throw new SecretError(LEAK, this.ref);
  }
}

/** Internal accessor for siblings of this module (the store). Not exported from the package. */
export function unsafeValue(h: SecretHandle): string {
  const v = VALUES.get(h);
  if (v === undefined) throw new SecretError('unknown secret handle', '<unknown>');
  return v;
}

/** Redaction kind for a handle: [A-Za-z0-9_.-]{1,40}, as the contracts redactor requires. */
function redactionKind(raw: string): string {
  const k = raw.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40);
  return k || 'secret';
}

/** Redactor inputs for one handle: its value and, for a provider credential, the full auth header value. */
function handleInputs(h: SecretHandle): SecretInput[] {
  const v = unsafeValue(h);
  const kind = redactionKind(h.kind ?? h.name);
  const out: SecretInput[] = [{ kind, value: v }];
  if (h.kind) {
    const header = authScheme(h.kind).prefix + v;
    if (header !== v) out.push({ kind, value: header });
  }
  return out;
}

/**
 * Internal (not exported from the package): the redactor a provider holding `h` must apply. When the
 * handle was resolved by a SecretStore this is the store's live redactor over every value it knows;
 * a standalone handle covers itself. Throws (never returns a weaker redactor) when it cannot be built.
 */
export function redactorFor(h: SecretHandle): Redactor {
  if (!(h instanceof SecretHandle) || !VALUES.has(h)) throw new SecretError('not a resolved SecretHandle', '<unknown>');
  const store = STORES.get(h);
  return store ? store.redactor : makeRedactor(handleInputs(h));
}
export interface SecretStoreOptions {
  /** Environment to resolve `env:` refs from. Defaults to process.env. Resolved names are deleted from it. */
  env?: Record<string, string | undefined>;
  /** Base directory for relative `file:` paths. Defaults to process.cwd(). */
  cwd?: string;
  /** Explicit provider-name → kind map (otherwise inferred from the name). */
  kinds?: Readonly<Record<string, ProviderKind>>;
  /** Set false to keep resolved variables in env (tests only). Default true. */
  deleteFromEnv?: boolean;
}

function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    const q = val[0];
    if ((q === '"' || q === "'") && val.length >= 2) {
      const end = val.indexOf(q, 1);
      val = end > 0 ? val.slice(1, end) : val.slice(1);
      if (q === '"') val = val.replace(/\\n/g, '\n');
    } else {
      const hash = val.search(/\s#/);
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    out.set(key, val);
  }
  return out;
}

export class SecretStore {
  readonly #env: Record<string, string | undefined>;
  readonly #cwd: string;
  readonly #kinds: Readonly<Record<string, ProviderKind>> | undefined;
  readonly #delete: boolean;
  readonly #handles = new Map<string, SecretHandle>();
  readonly #extras: Array<{ kind: string; value: string }> = [];
  /** ref → value, so several provider aliases can share one `env:` reference after it was deleted. */
  readonly #byRef = new Map<string, string>();
  #redactor: Redactor | null = null;
  readonly #live: Redactor;

  constructor(opts: SecretStoreOptions = {}) {
    this.#env = opts.env ?? process.env;
    this.#cwd = opts.cwd ?? process.cwd();
    this.#kinds = opts.kinds;
    this.#delete = opts.deleteFromEnv ?? true;
    const current = (): Redactor => (this.#redactor ??= makeRedactor(this.#inputs()));
    this.#live = Object.freeze({
      redactText: (text, o) => current().redactText(text, o),
      redactJson: (value, o) => current().redactJson(value, o),
      containsSecret: (input) => current().containsSecret(input),
    } satisfies Redactor);
  }

  /** Resolve every `providers.<name>.auth` reference of a manifest. Throws on the first failure. */
  static fromManifest(m: { providers: Record<string, { auth: string }> }, opts: SecretStoreOptions = {}): SecretStore {
    const s = new SecretStore(opts);
    for (const [name, p] of Object.entries(m.providers)) s.resolve(name, p.auth);
    return s;
  }

  /**
   * A store over the conventional key variables (KEY_ENV: ANTHROPIC_API_KEY, OPENAI_API_KEY,
   * OPENROUTER_API_KEY), one provider per kind named after the kind, for every listed kind whose variable
   * is set and non-empty in `opts.env` (default process.env); unset kinds are skipped, never an error.
   * Resolution deletes the variable from that env unless deleteFromEnv is false. Values never leave the store.
   */
  static fromEnv(kinds: readonly ProviderKind[] = PROVIDER_KINDS, opts: SecretStoreOptions = {}): SecretStore {
    const s = new SecretStore(opts);
    const env = opts.env ?? process.env;
    for (const k of kinds) {
      const name = KEY_ENV[k];
      if (typeof env[name] === 'string' && env[name] !== '') s.resolve(k, `env:${name}`);
    }
    return s;
  }

  /** Resolve one reference for provider `name`. Idempotent per name only if the ref is the same. */
  resolve(name: string, ref: string): SecretHandle {
    const existing = this.#handles.get(name);
    if (existing) {
      if (existing.ref !== ref) throw new SecretError(`provider "${name}" already resolved from a different reference`, ref);
      return existing;
    }
    const cached = this.#byRef.get(ref);
    const value = cached ?? this.#read(ref);
    const h = new SecretHandle(name, ref, inferKind(name, this.#kinds), value);
    if (cached === undefined) this.#byRef.set(ref, value);
    STORES.set(h, this);
    this.#handles.set(name, h);
    this.#redactor = null;
    return h;
  }

  has(name: string): boolean {
    return this.#handles.has(name);
  }

  get(name: string): SecretHandle {
    const h = this.#handles.get(name);
    if (!h) throw new SecretError(`no secret resolved for provider "${name}"`, `<${name}>`);
    return h;
  }

  names(): string[] {
    return [...this.#handles.keys()];
  }

  /**
   * Register an extra value to redact and canary-scan for (e.g. a planted TECERA_CANARY_*). Throws
   * SecretError for a non-string or a value shorter than MIN_SECRET_CHARS (fail closed: such a value
   * could not be redacted reliably, so it must not be accepted silently).
   */
  addSecret(kind: string, value: string): void {
    if (typeof value !== 'string' || value.length < MIN_SECRET_CHARS) throw new SecretError(`extra secret "${String(kind)}" must be a string of at least ${MIN_SECRET_CHARS} characters`, `<extra:${String(kind)}>`);
    this.#extras.push({ kind: redactionKind(String(kind)), value });
    this.#redactor = null;
  }

  /**
   * Raw secret values. ONLY for the supervisor's secretCanary hook, which byte-scans outgoing
   * prompts, env, ledger rows and logs for them. Never log, persist, or pass the result onward.
   */
  canaryValues(): string[] {
    return [...[...this.#handles.values()].map(unsafeValue), ...this.#extras.map((e) => e.value)];
  }

  /** Every known value in every encoding the shared redactor covers, plus SECRET_PATTERNS matches. */
  redact(text: string): string {
    return this.#live.redactText(text);
  }

  /** Redact every decoded string (and key) of a value; never calls getters or toJSON. */
  redactJson(value: unknown): ReturnType<Redactor['redactJson']> {
    return this.#live.redactJson(value);
  }

  /** Kind of the first known secret or pattern found in `input`, or null. Never returns the value. */
  containsSecret(input: unknown): string | null {
    return this.#live.containsSecret(input);
  }

  /**
   * The store's redactor (contracts Redactor). Live: it always reflects every secret resolved or added so
   * far, so it can be captured once (e.g. LoopPorts.redact = store.redactor.redactJson).
   */
  get redactor(): Redactor {
    return this.#live;
  }

  #inputs(): SecretInput[] {
    const seen = new Set<string>();
    const out: SecretInput[] = [];
    const add = (i: SecretInput) => {
      const v = typeof i === 'string' ? i : i.value;
      if (seen.has(v)) return;
      seen.add(v);
      out.push(i);
    };
    for (const h of this.#handles.values()) handleInputs(h).forEach(add);
    for (const e of this.#extras) add(e);
    return out;
  }

  toJSON(): { providers: string[] } {
    return { providers: this.names() };
  }

  [inspect.custom](): string {
    return `SecretStore { providers: [${this.names().join(', ')}] }`;
  }

  #read(ref: string): string {
    if (typeof ref !== 'string') throw new SecretError('secret reference must be a string', String(ref));
    if (ref.startsWith('keychain:')) throw new UnsupportedRefError(ref);
    if (ref.startsWith('env:')) {
      const key = ref.slice(4);
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new SecretError(`invalid env reference "${ref}"`, ref);
      const v = this.#env[key];
      if (v === undefined || v === '') throw new SecretError(`environment variable ${key} is not set`, ref);
      if (this.#delete) delete this.#env[key];
      return v;
    }
    if (ref.startsWith('file:')) {
      const body = ref.slice(5);
      const hash = body.lastIndexOf('#');
      const rawPath = hash >= 0 ? body.slice(0, hash) : body;
      const key = hash >= 0 ? body.slice(hash + 1) : null;
      if (!rawPath) throw new SecretError(`invalid file reference "${ref}"`, ref);
      const path = rawPath.startsWith('~/') ? resolvePath(homedir(), rawPath.slice(2)) : isAbsolute(rawPath) ? rawPath : resolvePath(this.#cwd, rawPath);
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        throw new SecretError(`cannot read secret file for "${ref}"`, ref);
      }
      const trimmed = text.trim();
      if (key === null) {
        if (!trimmed || /[\r\n]/.test(trimmed) || trimmed.startsWith('{')) throw new SecretError(`file reference "${ref}" needs #KEY unless the file holds a single value`, ref);
        return trimmed;
      }
      let v: unknown;
      if (trimmed.startsWith('{')) {
        try {
          v = (JSON.parse(trimmed) as Record<string, unknown>)[key];
        } catch {
          throw new SecretError(`secret file for "${ref}" is not valid JSON`, ref);
        }
      } else {
        v = parseDotenv(text).get(key);
      }
      if (typeof v !== 'string' || v.length === 0) throw new SecretError(`key ${key} not found in secret file for "${ref}"`, ref);
      return v;
    }
    throw new SecretError(`unrecognised secret reference "${ref}" (expected env:, file: or keychain:)`, ref);
  }
}
