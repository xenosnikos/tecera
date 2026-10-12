import { SecretStore } from '@tecera/providers';
import type { CapabilityProbe, CapabilityRecord, Manifest, Redactor, VerifyOutcome, VerifyRunner } from '@tecera/contracts';
import { toolingProblem } from '../verify.js';
import type { Env } from '../util/proc.js';

/**
 * The capability probe (D9): every declared connection is probed for real before a plan may rely on it.
 *
 * - A connection with a `probe` command runs it through the runtime's verify runner (the contained process of
 *   containment.ts in production: scrubbed env, timeout, no network, whole tree reaped). Only exit 0 on a
 *   run that completed cleanly is `available`; a timeout, a cancel, a capped stream, a surviving or escaped
 *   descendant or a fail-closed outcome is `missing`, recorded with a non-zero exit code.
 * - A connection without a probe is `available` only when its `auth` reference resolves. The value is read
 *   inside a throwaway SecretStore and dropped; nothing prints or returns it. The record carries the
 *   reference (`auth:env:NAME`), never what it resolved to. No probe and no auth: nothing establishes it.
 * - An undeclared id is `missing` (kind 'undeclared') without running anything.
 *
 * The probe never passes a credential to the command: the env is the manifest allowlist intersected with
 * SAFE_ENV, as for every verify.
 */

export type Connections = Manifest['connections'];

/** Exit recorded when the probe did not run to a trustworthy completion (VERIFY_TIMEOUT_EXIT for a timeout). */
export const PROBE_UNTRUSTED_EXIT = 125;
export const PROBE_TIMEOUT_EXIT = 124;
export const DEFAULT_PROBE_TIMEOUT_SEC = 30;

/** Resolves a secret reference without exposing it: true when it resolves to a value. */
export type AuthResolver = (ref: string) => boolean;

/** An AuthResolver over `env` and `file:` references relative to `cwd`; the env is never modified. */
export function storeAuthResolver(env: Env, cwd: string): AuthResolver {
  return (ref) => {
    try {
      new SecretStore({ env: { ...env }, cwd, deleteFromEnv: false }).resolve('connection-probe', ref);
      return true;
    } catch {
      return false;
    }
  };
}

export interface ProbeDetail {
  record: CapabilityRecord;
  /** Why the capability is missing (null when available). Never carries a secret value. */
  reason: string | null;
  durationMs: number;
}

export interface ConnectionProbeOptions {
  connections: Connections;
  /** The contained verify runner (Runtime.verifyRunner). */
  runner: VerifyRunner;
  /** Directory the probe runs in (readable by the verify identity). */
  cwd: string;
  /** The manifest's sandbox.envAllowlist (intersected with SAFE_ENV by the runner). */
  envAllowlist: readonly string[];
  timeoutSec?: number;
  /** How a probe-less connection's auth reference is checked; default: never resolves (missing). */
  authResolves?: AuthResolver;
  redactor?: Redactor;
  signal?: AbortSignal;
}

/**
 * Why a verify outcome is not a clean completion (null when it is). Fail-closed: the runner must attest that
 * the run's processes are gone (the contained runner's `gone: true`, or the host runner's
 * `descendantsSurvived: false`); an outcome that says nothing about it is not trusted.
 */
export function untrustedProbe(o: VerifyOutcome): string | null {
  const t = toolingProblem(o);
  if (t) return t;
  const x = o as VerifyOutcome & { gone?: boolean; stragglers?: number; escaped?: number; descendantsSurvived?: boolean; tainted?: unknown };
  if (x.gone === false || x.tainted) return 'processes of the probe could not be proven gone';
  if ((x.stragglers ?? 0) > 0) return 'the probe left processes behind';
  if ((x.escaped ?? 0) > 0) return 'the probe escaped containment';
  if (x.gone !== true && x.descendantsSurvived !== false) return 'the runner did not attest that the probe left nothing behind';
  return null;
}

export class ConnectionProbe implements CapabilityProbe {
  constructor(private readonly o: ConnectionProbeOptions) {}

  ids(): string[] {
    return Object.keys(this.o.connections).sort();
  }

  async probe(id: string): Promise<CapabilityRecord> {
    return (await this.detail(id)).record;
  }

  /** Probe every declared connection, in id order (one at a time: each is a contained process). */
  async probeAll(): Promise<ProbeDetail[]> {
    const out: ProbeDetail[] = [];
    for (const id of this.ids()) out.push(await this.detail(id));
    return out;
  }

  async detail(id: string): Promise<ProbeDetail> {
    const c = Object.prototype.hasOwnProperty.call(this.o.connections, id) ? this.o.connections[id] : undefined;
    if (!c) return { record: { id, kind: 'undeclared', state: 'missing' }, reason: `connection ${id} is not declared in the manifest`, durationMs: 0 };
    const clean = (s: string): string => (this.o.redactor ? this.o.redactor.redactText(s) : s);
    if (!c.probe) {
      if (!c.auth) return { record: { id, kind: c.kind, state: 'missing' }, reason: `connection ${id} declares neither a probe nor an auth reference`, durationMs: 0 };
      let ok = false;
      try {
        ok = (this.o.authResolves ?? (() => false))(c.auth) === true;
      } catch {
        // A resolver that throws establishes nothing; its message may carry the value, so it is not kept.
        ok = false;
      }
      return {
        record: { id, kind: c.kind, state: ok ? 'available' : 'missing', probe: { command: `auth:${c.auth}`, exitCode: ok ? 0 : 1 } },
        reason: ok ? null : `auth reference ${c.auth} does not resolve`,
        durationMs: 0,
      };
    }
    const command = clean(c.probe);
    const timeoutSec = this.o.timeoutSec ?? DEFAULT_PROBE_TIMEOUT_SEC;
    let o: VerifyOutcome;
    try {
      o = await this.o.runner.run({ cwd: this.o.cwd, command: c.probe, timeoutSec, envAllowlist: [...this.o.envAllowlist] }, this.o.signal);
    } catch (e) {
      return { record: { id, kind: c.kind, state: 'missing', probe: { command, exitCode: PROBE_UNTRUSTED_EXIT } }, reason: clean(`probe could not run: ${(e as Error)?.message ?? String(e)}`), durationMs: 0 };
    }
    const untrusted = untrustedProbe(o);
    if (untrusted) {
      const exitCode = o.timedOut ? PROBE_TIMEOUT_EXIT : o.exitCode !== null && o.exitCode !== 0 ? o.exitCode : PROBE_UNTRUSTED_EXIT;
      return { record: { id, kind: c.kind, state: 'missing', probe: { command, exitCode } }, reason: `probe ${untrusted}`, durationMs: o.durationMs };
    }
    const exitCode = o.exitCode as number;
    return {
      record: { id, kind: c.kind, state: exitCode === 0 ? 'available' : 'missing', probe: { command, exitCode } },
      reason: exitCode === 0 ? null : `probe exited ${exitCode}`,
      durationMs: o.durationMs,
    };
  }
}
