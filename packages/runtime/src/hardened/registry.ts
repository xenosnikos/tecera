import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { RunRegistryEntry, RunRegistryState } from '@tecera/contracts';
import { HardenedError } from './config.js';

/**
 * The run registry (hardened mode): one file per run in the protected state, separate from the ledger,
 * written only by the supervisor (`tecera run` as the operator identity). It is what the Stop hook
 * enumerates: a run is open from the moment it is registered (before any work is dispatched) until the
 * supervisor records it terminal. Events in the ledger never close it: an appended run.ended, a denied or an
 * expired approval changes nothing here. A running entry whose heartbeat stopped is interrupted (unknown),
 * never finished.
 *
 * Exit codes map to states as the Stop hook reads them: 4 held, 130 interrupted, 10 provisional, anything
 * else terminal with the exit code and reason recorded. A provisional entry becomes terminal when a later run
 * of the same goal ends achieved (exit 0), which is what superseding means in single-user mode as well.
 */

export const REGISTRY_FORMAT = 1;
/** How often a running segment refreshes its heartbeat, and after how long a silent one counts as interrupted. */
export const HEARTBEAT_MS = 10_000;
export const HEARTBEAT_STALE_MS = 60_000;

const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const STATES: readonly RunRegistryState[] = ['registered', 'running', 'held', 'interrupted', 'provisional', 'terminal'];

export interface RunRegistryOptions {
  caseId: string;
  now?: () => number;
  fileMode?: number;
  dirMode?: number;
  uid?: number;
}

/** The state a segment that ended with `exitCode` leaves its run in. */
export function stateForExit(exitCode: number): RunRegistryState {
  return exitCode === 4 ? 'held' : exitCode === 130 ? 'interrupted' : exitCode === 10 ? 'provisional' : 'terminal';
}

function parseEntry(raw: unknown, where: string): RunRegistryEntry {
  const r = raw as Partial<RunRegistryEntry> | null;
  const num = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n);
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new HardenedError(`run registry: ${where} is not an object`);
  if (r.formatVersion !== REGISTRY_FORMAT) throw new HardenedError(`run registry: ${where} has format ${String(r.formatVersion)}`);
  if (typeof r.runId !== 'string' || !RUN_ID.test(r.runId)) throw new HardenedError(`run registry: ${where} names no run`);
  if (!STATES.includes(r.state as RunRegistryState)) throw new HardenedError(`run registry: ${where} has state ${String(r.state)}`);
  if (!num(r.generation) || !num(r.registeredAt) || !num(r.updatedAt) || !num(r.heartbeatAt) || typeof r.caseId !== 'string') throw new HardenedError(`run registry: ${where} is incomplete`);
  if (r.state === 'terminal' && (typeof r.terminalReason !== 'string' || !r.terminalReason)) throw new HardenedError(`run registry: ${where} is terminal without a reason`);
  return r as RunRegistryEntry;
}

export class RunRegistry {
  private readonly now: () => number;
  private readonly fileMode: number;
  private readonly dirMode: number;
  private readonly uid: number;

  constructor(
    readonly dir: string,
    private readonly opts: RunRegistryOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.fileMode = opts.fileMode ?? 0o644;
    this.dirMode = opts.dirMode ?? 0o755;
    this.uid = opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : -1);
  }

  private file(runId: string): string {
    if (!RUN_ID.test(runId)) throw new HardenedError(`run registry: not a run id: ${runId}`);
    return join(this.dir, `${runId}.json`);
  }

  /** Every entry. A file that is not a well-formed entry (or a link, or not a regular file) throws: fail closed. */
  list(): RunRegistryEntry[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new HardenedError(`run registry: ${this.dir} cannot be listed (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
    }
    const out: RunRegistryEntry[] = [];
    for (const n of names.sort()) {
      if (n.startsWith('.')) continue; // a temporary file of a write in progress (renamed into place when done)
      if (!n.endsWith('.json')) throw new HardenedError(`run registry: unexpected file ${n}`);
      const e = this.read(join(this.dir, n), n);
      if (`${e.runId}.json` !== n) throw new HardenedError(`run registry: ${n} holds run ${e.runId}`);
      out.push(e);
    }
    return out.sort((a, b) => a.registeredAt - b.registeredAt || a.runId.localeCompare(b.runId));
  }

  /** The entries the Stop hook must treat as open: every one that is not terminal. */
  open(): RunRegistryEntry[] {
    return this.list().filter((e) => e.state !== 'terminal');
  }

  get(runId: string): RunRegistryEntry | null {
    const f = this.file(runId);
    try {
      lstatSync(f);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    return this.read(f, `${runId}.json`);
  }

  private read(path: string, where: string): RunRegistryEntry {
    const st = lstatSync(path);
    if (!st.isFile() || st.nlink !== 1) throw new HardenedError(`run registry: ${where} is not a regular file with one link`);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      throw new HardenedError(`run registry: ${where} is not readable JSON (${(e as Error).message})`);
    }
    return parseEntry(raw, where);
  }

  private write(e: RunRegistryEntry): RunRegistryEntry {
    mkdirSync(this.dir, { recursive: true, mode: this.dirMode });
    const tmp = join(this.dir, `.${e.runId}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
    const fd = openSync(tmp, 'wx', this.fileMode);
    try {
      writeSync(fd, `${JSON.stringify(e, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file(e.runId));
    let dfd: number | undefined;
    try {
      dfd = openSync(this.dir, 'r');
      fsyncSync(dfd);
    } catch {
      /* best effort */
    } finally {
      if (dfd !== undefined) closeSync(dfd);
    }
    return e;
  }

  /**
   * A segment starts: a new run is registered (refused when the id exists), a resumed one moves to running
   * with the next generation. Returns the entry as it was before (null for a new run) so a segment that
   * could not start can put it back.
   */
  begin(runId: string, goalId: string | null, opts: { resume: boolean }): { entry: RunRegistryEntry; prior: RunRegistryEntry | null } {
    const prior = this.get(runId);
    const at = this.now();
    if (!opts.resume) {
      if (prior) throw new HardenedError(`run registry: run ${runId} is already registered`);
      const entry = this.write({ formatVersion: REGISTRY_FORMAT, runId, goalId, caseId: this.opts.caseId, generation: 1, state: 'registered', terminalReason: null, exitCode: null, registeredAt: at, updatedAt: at, heartbeatAt: at, pid: process.pid, uid: this.uid, source: 'run' });
      return { entry, prior: null };
    }
    if (prior?.state === 'terminal') throw new HardenedError(`run registry: run ${runId} ended (${prior.terminalReason}); a terminal run is not resumed`);
    const base: RunRegistryEntry = prior ?? { formatVersion: REGISTRY_FORMAT, runId, goalId, caseId: this.opts.caseId, generation: 0, state: 'registered', terminalReason: null, exitCode: null, registeredAt: at, updatedAt: at, heartbeatAt: at, pid: process.pid, uid: this.uid, source: 'run' };
    const entry = this.write({ ...base, goalId: base.goalId ?? goalId, generation: base.generation + 1, state: 'running', exitCode: null, updatedAt: at, heartbeatAt: at, pid: process.pid, uid: this.uid });
    return { entry, prior };
  }

  /** The segment is past registration and doing work. */
  running(runId: string): RunRegistryEntry {
    const e = this.require(runId);
    const at = this.now();
    return this.write({ ...e, state: 'running', updatedAt: at, heartbeatAt: at });
  }

  heartbeat(runId: string): void {
    const e = this.require(runId);
    if (e.state !== 'running' && e.state !== 'registered') return;
    this.write({ ...e, heartbeatAt: this.now() });
  }

  /** The segment ended with `exitCode`. Achieved (0) also closes earlier provisional runs of the same goal. */
  end(runId: string, exitCode: number, reason: string): RunRegistryEntry {
    const e = this.require(runId);
    const at = this.now();
    const state = stateForExit(exitCode);
    const out = this.write({ ...e, state, exitCode, terminalReason: state === 'terminal' ? `exit ${exitCode}: ${reason}`.slice(0, 500) : null, updatedAt: at });
    if (exitCode === 0 && e.goalId) {
      for (const p of this.list()) if (p.runId !== runId && p.state === 'provisional' && p.goalId === e.goalId) this.write({ ...p, state: 'terminal', terminalReason: `superseded: run ${runId} achieved goal ${e.goalId}`, updatedAt: at });
    }
    return out;
  }

  /** A segment that never started work: put the entry back as it was (a resumed run stays where it was). */
  restore(runId: string, prior: RunRegistryEntry | null, reason: string): void {
    if (prior) this.write({ ...prior, updatedAt: this.now() });
    else {
      const e = this.require(runId);
      this.write({ ...e, state: 'terminal', terminalReason: `not started: ${reason}`.slice(0, 500), updatedAt: this.now() });
    }
  }

  /** The supervisor died or threw mid-segment: the outcome is unknown, so the run stays open (interrupted). */
  unknown(runId: string): void {
    const e = this.get(runId);
    if (e && e.state !== 'terminal') this.write({ ...e, state: 'interrupted', updatedAt: this.now() });
  }

  /** The operator closes a run explicitly (it can then never be resumed). */
  abandon(runId: string, reason: string): RunRegistryEntry {
    const e = this.require(runId);
    if (e.state === 'terminal') throw new HardenedError(`run registry: run ${runId} is already terminal (${e.terminalReason})`);
    return this.write({ ...e, state: 'terminal', terminalReason: `abandoned by the operator: ${reason}`.slice(0, 500), updatedAt: this.now() });
  }

  /** Enrollment: record a run the ledger shows open, unless the registry has it already. */
  enrolled(runId: string, goalId: string | null, state: Exclude<RunRegistryState, 'terminal' | 'registered'>): RunRegistryEntry | null {
    if (this.get(runId)) return null;
    const at = this.now();
    return this.write({ formatVersion: REGISTRY_FORMAT, runId, goalId, caseId: this.opts.caseId, generation: 1, state, terminalReason: null, exitCode: null, registeredAt: at, updatedAt: at, heartbeatAt: at, pid: process.pid, uid: this.uid, source: 'enrolled' });
  }

  private require(runId: string): RunRegistryEntry {
    const e = this.get(runId);
    if (!e) throw new HardenedError(`run registry: run ${runId} is not registered`);
    return e;
  }
}

/** How the Stop hook reads an open entry: a running one whose heartbeat stopped is interrupted. */
export function stopStateOf(e: RunRegistryEntry, now: number): { state: 'running' | 'held' | 'interrupted' | 'provisional'; note: string } {
  const gen = `generation ${e.generation}`;
  if (e.state === 'held') return { state: 'held', note: `held, ${gen}` };
  if (e.state === 'provisional') return { state: 'provisional', note: `provisional, ${gen}` };
  if (e.state === 'interrupted') return { state: 'interrupted', note: `interrupted, ${gen}` };
  const stale = now - e.heartbeatAt > HEARTBEAT_STALE_MS;
  if (stale) return { state: 'interrupted', note: `${e.state}, heartbeat missed for ${Math.round((now - e.heartbeatAt) / 1000)}s: interrupted or unknown, never finished` };
  return { state: 'running', note: `${e.state === 'registered' ? 'registered, no work recorded yet' : 'running'}, ${gen}` };
}
