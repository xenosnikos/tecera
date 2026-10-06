import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { event, type Json, type JsonObject, type Ledger, type Manifest, type Principal, type Redactor, type SecretInput, type TeceraEvent, type Trace, type VerifyRunner } from '@tecera/contracts';
import { MemoryLedger, SqliteLedger } from '@tecera/ledger';
import type { SecretStore } from '@tecera/providers';
import type { PermissionsDoc } from '@tecera/policy';
import { loadManifest, loadPermissions } from './manifest/load.js';
import { RedactingLedger } from './redactingLedger.js';
import { RuntimeSecrets, type SecretStatus } from './secrets.js';
import { defaultIds, type IdGen } from './util/ids.js';
import { inspectPath, realRoot, safeMkdirp, UnsafePathError } from './util/safefs.js';
import type { Env } from './util/proc.js';
import { ContainedVerifyRunner } from './containment.js';
import { defaultProbe, wireRunPorts, type SeatProbe, type WireFn } from './wiring.js';

/**
 * The composition root's state for one CLI invocation: the loaded business case, the resolved secrets and
 * the one redactor built over them, a lazily opened ledger wrapped in RedactingLedger, and the injectable
 * seams (verify runner, seat probe, run wiring, clock, ids). Commands get everything through this object.
 *
 * Construction resolves the manifest's credential references through the providers SecretStore, which
 * deletes them from `env` (process.env in the real CLI), and lifts the approver signing key out of `env`.
 * A configured secret too short to redact reliably fails construction (RedactionError → exit 3).
 */

export interface RuntimeOptions {
  cwd: string;
  manifestPath?: string;
  env?: Env;
  now?: () => number;
  ids?: IdGen;
  verifyRunner?: VerifyRunner;
  probe?: SeatProbe;
  wire?: WireFn;
  /** Secret values seen before this runtime existed (e.g. env values captured at CLI start). */
  extraSecrets?: readonly SecretInput[];
}

export class Runtime {
  readonly root: string;
  readonly manifestPath: string;
  readonly manifest: Manifest;
  readonly manifestHash: string;
  readonly permissions: PermissionsDoc;
  readonly permissionsPresent: boolean;
  readonly env: Env;
  readonly now: () => number;
  readonly ids: IdGen;
  readonly verifyRunner: VerifyRunner;
  readonly probe: SeatProbe;
  readonly wire: WireFn;
  readonly secrets: RuntimeSecrets;
  /** The shared contracts redactor over every known secret. */
  readonly redactor: Redactor;
  /** Text redaction shorthand (redactor.redactText). */
  readonly redact: (text: string) => string;
  private opened: (Ledger & { close?: () => void }) | null = null;

  constructor(opts: RuntimeOptions) {
    const loaded = loadManifest(opts.cwd, opts.manifestPath);
    this.root = loaded.root;
    this.manifestPath = loaded.path;
    this.manifest = loaded.manifest;
    this.manifestHash = loaded.hash;
    const perms = loadPermissions(this.root);
    this.permissions = perms.doc;
    this.permissionsPresent = perms.present;
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? Date.now;
    this.ids = opts.ids ?? defaultIds;
    this.secrets = RuntimeSecrets.load(this.manifest, this.env, { cwd: this.root, extra: opts.extraSecrets });
    this.redactor = this.secrets.redactor;
    this.redact = (t) => this.redactor.redactText(t);
    // Repository code runs only contained (containment.ts): the same admission as `tecera run`, never a host shell.
    this.verifyRunner = opts.verifyRunner ?? new ContainedVerifyRunner(this.env, this.redactor);
    this.probe = opts.probe ?? defaultProbe;
    this.wire = opts.wire ?? wireRunPorts;
  }

  get secretStore(): SecretStore {
    return this.secrets.store;
  }

  get secretStatus(): SecretStatus[] {
    return this.secrets.status;
  }

  get ledgerPath(): string {
    const p = this.manifest.ledger.path;
    return isAbsolute(p) ? p : join(this.root, p);
  }

  ledgerExists(): boolean {
    return this.manifest.ledger.driver === 'memory' || existsSync(this.ledgerPath);
  }

  /**
   * Open (and create) the ledger behind the redaction boundary. One per invocation; closed by close().
   * The database path and its SQLite sidecars are checked before opening and again after (assertLedgerPath).
   */
  ledger(): Ledger {
    if (!this.opened) {
      if (this.manifest.ledger.driver === 'memory') this.opened = new RedactingLedger(new MemoryLedger(), this.redactor);
      else {
        assertLedgerPath(this.root, this.ledgerPath, true);
        const db = new SqliteLedger(this.ledgerPath);
        try {
          assertLedgerPath(this.root, this.ledgerPath, false);
        } catch (e) {
          db.close();
          throw e;
        }
        this.opened = new RedactingLedger(db, this.redactor);
      }
    }
    return this.opened;
  }

  /** Append one event as `actor` (default: the CLI as a system principal). */
  async append(kind: TeceraEvent['kind'], args: { payload: JsonObject; trace?: Trace; runId?: string; actor?: Principal; idemKey?: string }): Promise<TeceraEvent & { duplicate: boolean }> {
    const e = event(kind, {
      id: this.ids('ev'),
      at: this.now(),
      actor: args.actor ?? { kind: 'system', id: 'tecera-cli' },
      trace: args.trace ?? {},
      payload: stripUndefined(args.payload) as JsonObject,
      runId: args.runId,
      idemKey: args.idemKey,
    });
    const r = await this.ledger().append(e);
    return { ...e, duplicate: r.duplicate };
  }

  close(): void {
    this.opened?.close?.();
    this.opened = null;
  }
}

export async function createRuntime(opts: RuntimeOptions): Promise<Runtime> {
  return new Runtime(opts);
}

/** Drop undefined fields so a payload is valid canonical JSON. */
export function stripUndefined(v: unknown): Json {
  return JSON.parse(JSON.stringify(v ?? null)) as Json;
}

const SQLITE_SIDECARS = ['', '-wal', '-shm', '-journal'] as const;

/**
 * Confinement for the ledger database (it is opened by SQLite, which follows links): under the business
 * case every segment of the path is lstat'ed (no symlinked parent, no symlink anywhere) and created through
 * safeMkdirp; outside it (an absolute path the operator configured) the parent directory and the files
 * themselves must not be links. The database file and each sidecar (-wal, -shm, -journal), when present,
 * must be a regular file with exactly one link: a symlink or hard link could point the ledger, or its
 * write-ahead log, at another file. Throws UnsafePathError (exit 8).
 */
export function assertLedgerPath(root: string, abs: string, create: boolean): void {
  const rootReal = realRoot(root) ?? root;
  const rel = relative(rootReal, abs);
  const lexRel = relative(root, abs);
  const inside = [rel, lexRel].find((r) => r !== '' && !r.startsWith('..') && !isAbsolute(r));
  if (inside !== undefined) {
    const parts = inside.split(sep).join('/');
    const parent = parts.split('/').slice(0, -1).join('/');
    if (parent) {
      if (create) safeMkdirp(root, parent);
      else {
        const p = inspectPath(root, parent);
        if (!p.exists || p.kind !== 'dir') throw new UnsafePathError(`ledger directory ${parent} is missing or not a directory`, parent);
      }
    }
    for (const s of SQLITE_SIDECARS) {
      const info = inspectPath(root, `${parts}${s}`);
      if (!info.exists) continue;
      if (info.kind !== 'file') throw new UnsafePathError(`ledger file ${parts}${s} is not a regular file; refusing to open the ledger`, `${parts}${s}`);
      if ((info.nlink ?? 1) > 1) throw new UnsafePathError(`ledger file ${parts}${s} has ${info.nlink} hard links; refusing to open the ledger`, `${parts}${s}`);
    }
    return;
  }
  const dir = dirname(abs);
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  let d;
  try {
    d = lstatSync(dir);
  } catch (e) {
    throw new UnsafePathError(`ledger directory ${dir} cannot be checked (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`, dir);
  }
  if (d.isSymbolicLink() || !d.isDirectory()) throw new UnsafePathError(`ledger directory ${dir} is a link or not a directory`, dir);
  for (const s of SQLITE_SIDECARS) {
    const f = `${abs}${s}`;
    let st;
    try {
      st = lstatSync(f);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new UnsafePathError(`ledger file ${f} cannot be checked (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`, f);
    }
    if (st.isSymbolicLink() || !st.isFile()) throw new UnsafePathError(`ledger file ${f} is a link or not a regular file; refusing to open the ledger`, f);
    if (st.nlink > 1) throw new UnsafePathError(`ledger file ${f} has ${st.nlink} hard links; refusing to open the ledger`, f);
  }
}
