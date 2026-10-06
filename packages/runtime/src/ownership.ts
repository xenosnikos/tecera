import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Process ownership of a run (security.md §4 S2: "orphan termination" on restart).
 *
 * A supervisor that drives a run records, in an append-only owner file OUTSIDE the worktree
 * (`<worktreesRoot>/<runId>.owner`), itself and every descendant process it has (sandbox children, verify
 * commands, git), each as {pid, start} where `start` is the kernel start time from /proc/<pid>/stat (so a
 * recycled pid is never mistaken for the recorded process). Descendants are re-sampled while the run lives.
 *
 * A restart (`tecera run --resume`), after it acquired the lease, reaps before anything else runs:
 *  1. every recorded process that is still alive with the recorded start time, and its whole process group
 *     and session (sandbox and verify children are session leaders: `detached`), is SIGKILLed;
 *  2. every other process whose working directory or executable lies inside the run's worktree and that has
 *     no controlling terminal is SIGKILLed with its group (a descendant that escaped the records but still
 *     works in the tree). One attached to a terminal (an operator's shell or job in the worktree) is never
 *     killed: it is reported as a survivor and the restart refuses until it is gone;
 *  3. it waits until none of them is alive. Survivors → the restart refuses (no restore, no dispatch).
 * Never this process, never its ancestors.
 *
 * Linux only (/proc). Without /proc the reap refuses (fail closed): nothing proves the prior writers stopped.
 */

export interface ProcRecord {
  role: 'supervisor' | 'descendant';
  pid: number;
  /** /proc/<pid>/stat field 22 (starttime, clock ticks since boot). */
  start: number;
  pgid: number;
  sid: number;
  /** Supervisor pid this record was written by. */
  by: number;
  at: number;
}

interface Stat {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  start: number;
  state: string;
  /** Controlling terminal (0 = none). */
  tty: number;
}

const PROC = '/proc';

export function procAvailable(): boolean {
  return existsSync(`${PROC}/self/stat`);
}

/** Parse /proc/<pid>/stat (null when the process is gone or unreadable). */
export function statOf(pid: number): Stat | null {
  try {
    const s = readFileSync(`${PROC}/${pid}/stat`, 'utf8');
    const close = s.lastIndexOf(')');
    const f = s.slice(close + 2).split(' ');
    // f[0]=state (field 3), f[1]=ppid (4), f[2]=pgrp (5), f[3]=session (6), f[19]=starttime (22)
    return { pid, state: f[0]!, ppid: Number(f[1]), pgid: Number(f[2]), sid: Number(f[3]), tty: Number(f[4]), start: Number(f[19]) };
  } catch {
    return null;
  }
}

/** Alive = has a /proc entry that is not a zombie (a zombie holds no resources and cannot write). */
function alive(pid: number, start?: number): boolean {
  const st = statOf(pid);
  if (!st || st.state === 'Z' || st.state === 'X') return false;
  return start === undefined || st.start === start;
}

function allPids(): number[] {
  try {
    return readdirSync(PROC).filter((d) => /^\d+$/.test(d)).map(Number);
  } catch {
    return [];
  }
}

/** Every live descendant of `root` (by ppid), with its stat. */
export function descendantsOf(root: number): Stat[] {
  const stats = allPids().map(statOf).filter((s): s is Stat => s !== null);
  const kids = new Map<number, Stat[]>();
  for (const s of stats) {
    const l = kids.get(s.ppid) ?? [];
    l.push(s);
    kids.set(s.ppid, l);
  }
  const out: Stat[] = [];
  const stack = [root];
  const seen = new Set<number>([root]);
  while (stack.length) {
    const p = stack.pop()!;
    for (const k of kids.get(p) ?? []) {
      if (seen.has(k.pid)) continue;
      seen.add(k.pid);
      out.push(k);
      stack.push(k.pid);
    }
  }
  return out;
}

function ancestorsOfSelf(): Set<number> {
  const out = new Set<number>([process.pid]);
  let p = process.pid;
  for (let i = 0; i < 128; i++) {
    const st = statOf(p);
    if (!st || st.ppid <= 0 || out.has(st.ppid)) break;
    out.add(st.ppid);
    p = st.ppid;
  }
  return out;
}

export function ownerFilePath(worktreesRoot: string, runId: string): string {
  return resolve(worktreesRoot, `${runId}.owner`);
}

function appendRecords(file: string, recs: ProcRecord[]): void {
  if (!recs.length) return;
  const fd = openSync(file, 'a', 0o600);
  try {
    appendFileSync(fd, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readRecords(file: string): ProcRecord[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: ProcRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as ProcRecord;
      if (Number.isInteger(r.pid) && r.pid > 1 && Number.isFinite(r.start)) out.push(r);
    } catch {
      /* a torn last line (crash mid-append) carries nothing usable */
    }
  }
  return out;
}

/**
 * Records this supervisor and, on every sample(), its new descendants. `sample()` is cheap enough to call
 * on every exec and on a short interval; `stop()` ends the interval (the records stay for the next restart).
 */
export class OwnershipRecorder {
  private readonly seen = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  start(intervalMs = 200): void {
    const self = statOf(process.pid);
    if (!self) throw new Error('process ownership cannot be recorded: /proc is unavailable');
    this.add([{ role: 'supervisor', pid: self.pid, start: self.start, pgid: self.pgid, sid: self.sid, by: process.pid, at: this.now() }]);
    this.timer = setInterval(() => this.sample(), intervalMs);
    this.timer.unref();
  }

  sample(): void {
    try {
      this.add(descendantsOf(process.pid).map((s) => ({ role: 'descendant' as const, pid: s.pid, start: s.start, pgid: s.pgid, sid: s.sid, by: process.pid, at: this.now() })));
    } catch {
      /* best effort between samples; the worktree scan at reap time is the backstop */
    }
  }

  private add(recs: ProcRecord[]): void {
    const fresh = recs.filter((r) => !this.seen.has(`${r.pid}:${r.start}`));
    if (!fresh.length) return;
    appendRecords(this.file, fresh);
    for (const r of fresh) this.seen.add(`${r.pid}:${r.start}`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

const inside = (parent: string, child: string): boolean => {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

function linkOf(pid: number, what: 'cwd' | 'exe' | 'root'): string | null {
  try {
    return readlinkSync(`${PROC}/${pid}/${what}`);
  } catch {
    return null;
  }
}

/** Processes (other than us and our ancestors) whose cwd or executable is inside `dir`. */
export function processesIn(dir: string): Stat[] {
  let real = resolve(dir);
  try {
    real = realpathSync(dir);
  } catch {
    /* gone: compare the plain path */
  }
  const mine = ancestorsOfSelf();
  const out: Stat[] = [];
  for (const pid of allPids()) {
    if (mine.has(pid)) continue;
    const cwd = linkOf(pid, 'cwd');
    const exe = linkOf(pid, 'exe');
    const hit = [cwd, exe].some((p) => p !== null && (inside(real, p.replace(/ \(deleted\)$/, '')) || inside(resolve(dir), p.replace(/ \(deleted\)$/, ''))));
    if (!hit) continue;
    const st = statOf(pid);
    if (st && st.state !== 'Z') out.push(st);
  }
  return out;
}

export interface ReapResult {
  /** Processes that were found alive and killed. */
  killed: Array<{ pid: number; why: string }>;
  /** Still alive after the deadline (or not ours to kill): the restart must refuse. */
  survivors: number[];
  /** Why each survivor was left (terminal-attached processes are never killed). */
  notes?: string[];
  /** Why the reap could not prove anything (no /proc). */
  refused?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    /* group gone */
  }
}
function killPid(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* gone */
  }
}

/**
 * Kill every prior writer of a run: recorded processes (pid + start time), their groups and sessions,
 * and anything working inside the worktree. Waits up to `deadlineMs` for all of them to be gone.
 */
export async function reapPriorProcesses(o: { ownerFile: string; worktree: string; deadlineMs?: number }): Promise<ReapResult> {
  if (!procAvailable()) return { killed: [], survivors: [], refused: 'process ownership cannot be proven without /proc' };
  const mine = ancestorsOfSelf();
  const self = statOf(process.pid);
  const ownGroups = new Set<number>([self?.pgid ?? -1, self?.sid ?? -1]);
  const killed: ReapResult['killed'] = [];
  const targets = new Map<number, number | undefined>(); // pid → expected start (undefined = any)
  const groups = new Set<number>();
  const sessions = new Set<number>();

  for (const r of readRecords(o.ownerFile)) {
    if (mine.has(r.pid) || r.by === process.pid) continue;
    if (!alive(r.pid, r.start)) continue;
    targets.set(r.pid, r.start);
    killed.push({ pid: r.pid, why: `${r.role} of the previous supervisor ${r.by}` });
    // Only groups/sessions a recorded DESCENDANT leads (sandbox and verify children are spawned detached)
    // belong to the run. The supervisor's own group/session may be the operator's shell job: never killed.
    if (r.role === 'descendant' && r.pgid === r.pid && !ownGroups.has(r.pgid)) groups.add(r.pgid);
    if (r.role === 'descendant' && r.sid === r.pid && !ownGroups.has(r.sid)) sessions.add(r.sid);
  }
  const foreign = new Map<number, number>(); // terminal-attached, unrecorded, in the worktree: refuse, never kill
  for (const s of processesIn(o.worktree)) {
    if (targets.has(s.pid)) continue;
    if (s.tty !== 0) {
      foreign.set(s.pid, s.start);
      continue;
    }
    targets.set(s.pid, s.start);
    killed.push({ pid: s.pid, why: 'works inside the run worktree' });
    if (s.pgid === s.pid && !ownGroups.has(s.pgid)) groups.add(s.pgid);
  }
  // Members of the recorded groups/sessions are prior writers too (descendants of a detached child).
  if (groups.size || sessions.size) {
    for (const pid of allPids()) {
      if (mine.has(pid) || targets.has(pid)) continue;
      const st = statOf(pid);
      if (!st || st.state === 'Z') continue;
      if (groups.has(st.pgid) || sessions.has(st.sid)) {
        targets.set(pid, st.start);
        killed.push({ pid, why: `member of process group ${st.pgid} / session ${st.sid} of the previous run` });
      }
    }
  }
  for (const g of groups) killGroup(g);
  for (const [pid] of targets) killPid(pid);

  const until = Date.now() + (o.deadlineMs ?? 5000);
  let survivors: number[] = [];
  for (;;) {
    survivors = [...targets].filter(([pid, start]) => alive(pid, start)).map(([pid]) => pid);
    // a member that appeared after the first pass (forked while being killed) is caught here
    for (const s of processesIn(o.worktree)) if (!targets.has(s.pid) && !foreign.has(s.pid)) {
      if (s.tty !== 0) {
        foreign.set(s.pid, s.start);
        continue;
      }
      targets.set(s.pid, s.start);
      killed.push({ pid: s.pid, why: 'appeared inside the run worktree during the reap' });
      if (s.pgid === s.pid && !ownGroups.has(s.pgid)) killGroup(s.pgid);
      killPid(s.pid);
      survivors.push(s.pid);
    }
    if (!survivors.length || Date.now() > until) break;
    for (const pid of survivors) killPid(pid);
    await sleep(50);
  }
  const notes: string[] = [];
  for (const [pid, start] of foreign) {
    if (!alive(pid, start)) continue;
    survivors.push(pid);
    notes.push(`pid ${pid} works inside the run worktree from a terminal; it was not started by tecera's records and is not killed — stop it, then resume`);
  }
  return { killed, survivors, ...(notes.length ? { notes } : {}) };
}
