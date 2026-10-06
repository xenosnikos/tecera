import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENV } from './e2e.js';
import { alive, cmdline } from './procs.js';
import { PACKAGES, sleep, tmp } from './tmp.js';

/**
 * Crash injection for security.md §4's recovery matrix. One segment of `tecera run` (normally a
 * `--resume`) executes in a CHILD process (the supervisor) whose wiring carries a fault injector. At the
 * chosen step the supervisor records where it is and its descendants, then FREEZES (its event loop is
 * blocked, so nothing after the injection point can run); this process checks the attack state (the step
 * really was in flight; for S4/S6 the verify command itself is alive) and SIGKILLs it from outside: no
 * cleanup, no run.ended, the worktree lease left to expire, sandbox/verify children orphaned.
 *
 * Injection points:
 *  S2 exec child   - the edit step's exec, right after its src write landed (the edit tool result is ok)
 *  S3 freeze (D1)  - the first verify gate is entered, before it snapshots anything
 *  S4 verify       - the first verify gate's COMMAND is running: the repo's slow test wrote its pid to the
 *                    marker and sleeps; the supervisor freezes only once the marker exists
 *  S5 review       - the reviewer request leaves the host (the provider answer is lost)
 *  S6 final verify - as S4, for the second verify gate
 *  S7 approval     - approval.requested for the PR step (D6: the only approval point) is durable, step.held
 *                    is not
 *  S8 commit       - git commit/update-ref done (gate.commit evidence 'committed' about to be written), the
 *                    final record not written (D6: the commit takes no approval)
 *  S9 PR delivery  - the PR gate consumed its human grant (ledger.consume returned), nothing delivered or
 *                    recorded yet
 */

export type CrashPoint = 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8' | 'S9';

const CHILD = String.raw`
import { readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { main, createWiring } = await import(cfg.runtimeIndex);

function ppidOf(pid) {
  try { const s = readFileSync('/proc/' + pid + '/stat', 'utf8'); return Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]); } catch { return -1; }
}
function descendants(root) {
  const kids = new Map();
  for (const d of readdirSync('/proc')) { if (!/^\d+$/.test(d)) continue; const p = Number(d); const pp = ppidOf(p); if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(p); }
  const out = []; const stack = [root];
  while (stack.length) { const p = stack.pop(); for (const k of kids.get(p) || []) { out.push(k); stack.push(k); } }
  return out;
}
const asked = {};
function freeze(where, extra) {
  writeFileSync(cfg.readyFile + '.tmp', JSON.stringify({ where, pid: process.pid, pids: descendants(process.pid), asked, ...(extra || {}) }));
  // atomic publish, then block the event loop until the test kills this process (nothing else may run)
  writeFileSync(cfg.readyFile, readFileSync(cfg.readyFile + '.tmp'));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
function abandon(error) {
  writeFileSync(cfg.readyFile, JSON.stringify({ where: null, error, asked }));
  process.exit(97);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let verifies = 0;
const inner = createWiring({
  leaseTtlMs: cfg.leaseTtlMs,
  tap: (seat) => { asked[seat] = (asked[seat] || 0) + 1; if (cfg.at === 'S5' && seat === 'reviewer') freeze('S5'); },
  childTap: (kind, data) => { if (cfg.at === 'S2' && kind === 'result' && data.includes('tool:edit') && data.includes('"ok":true')) freeze('S2'); },
});
const wire = async (ctx) => {
  const l = ctx.ledger;
  const append = l.append.bind(l);
  const evidence = l.evidence.bind(l);
  l.append = async (e) => { const r = await append(e); if (cfg.at === 'S7' && e.kind === 'approval.requested' && e.trace && e.trace.stepId === 'pr') freeze('S7', { requestId: e.payload.requestId }); return r; };
  const consume = l.consume.bind(l);
  l.consume = async (...a) => { const r = await consume(...a); if (cfg.at === 'S9' && String(a[3]).startsWith('gate.pr:')) freeze('S9', { requestId: a[0] }); return r; };
  l.evidence = async (e) => { if (cfg.at === 'S8' && e.kind === 'gate.commit' && String(e.key).startsWith('commit:' + ctx.runId + ':') && e.body && e.body.outcome === 'committed') freeze('S8', { key: e.key }); return evidence(e); };
  const ports = await inner(ctx);
  const gates = ports.gates;
  ports.gates = {
    ...gates,
    verify: async (g) => {
      verifies++;
      if (cfg.at === 'S3' && verifies === 1) freeze('S3');
      if ((cfg.at === 'S4' && verifies === 1) || (cfg.at === 'S6' && verifies === 2)) {
        if (existsSync(cfg.marker)) rmSync(cfg.marker);
        const p = gates.verify(g);
        for (let i = 0; i < 1200 && !existsSync(cfg.marker); i++) await sleep(25);
        if (!existsSync(cfg.marker)) abandon('the verify command never ran (no marker)');
        // the marker holds the command's pid inside its own pid namespace; the host pid is found from outside
        freeze(cfg.at, { nsPid: Number(readFileSync(cfg.marker, 'utf8').trim()) });
        return p;
      }
      return gates.verify(g);
    },
  };
  return ports;
};
const code = await main(cfg.argv, { cwd: cfg.cwd, env: cfg.env, stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s), isTTY: false, wire });
writeFileSync(cfg.readyFile, JSON.stringify({ where: null, exitCode: code, asked }));
process.exit(code);
`;

export interface CrashResult {
  /** The injection point that fired, or null when the segment ended without reaching it (a gap). */
  where: string | null;
  /** Why the injection was abandoned (e.g. the verify command never ran). */
  error?: string;
  /** Descendants of the supervisor when it froze. */
  pids: number[];
  /** Scripted model requests per seat made by the supervisor before it died. */
  asked: Record<string, number>;
  /** S4/S6: host pid of the running verify command (a descendant whose command line names the slow test). */
  livePid?: number;
  /** S4/S6: that process was alive, and a descendant of the supervisor, when the supervisor was killed. */
  liveAtKill?: boolean;
  /** S7: the PR approval request that was durable at the crash; S9: the PR grant consumed at the crash. */
  requestId?: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

export const LEASE_TTL_MS = 1_500;

export async function crashRun(o: { cwd: string; argv: string[]; env: Record<string, string>; at: CrashPoint; marker?: string; liveNeedle?: string; timeoutMs?: number }): Promise<CrashResult> {
  const d = tmp('tecera-adv-crash-');
  const script = join(d, 'supervisor.mjs');
  const cfgPath = join(d, 'cfg.json');
  const readyFile = join(d, 'ready.json');
  writeFileSync(script, CHILD);
  writeFileSync(
    cfgPath,
    JSON.stringify({
      // the public barrel only (main, createWiring): never a private dist path
      runtimeIndex: pathToFileURL(join(PACKAGES, 'runtime/dist/index.js')).href,
      argv: o.argv,
      cwd: o.cwd,
      env: { ...ENV, ...o.env },
      at: o.at,
      readyFile,
      marker: o.marker ?? join(d, 'no-marker'),
      leaseTtlMs: LEASE_TTL_MS,
    }),
  );
  const child: ChildProcess = spawn(process.execPath, [script, cfgPath], { cwd: d, env: { PATH: ENV.PATH!, HOME: ENV.HOME! }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (b) => (stdout += b));
  child.stderr!.on('data', (b) => (stderr += b));
  const closed = new Promise<[number | null, string | null]>((res) => child.on('close', (c, s) => res([c, s])));
  let exited = false;
  void closed.then(() => (exited = true));
  const until = Date.now() + (o.timeoutMs ?? 240_000);
  let rec: Omit<CrashResult, 'exitCode' | 'signal' | 'stdout' | 'stderr'> | null = null;
  while (Date.now() < until) {
    if (existsSync(readyFile)) {
      try {
        rec = JSON.parse(readFileSync(readyFile, 'utf8'));
        break;
      } catch {
        /* being written */
      }
    }
    if (exited) break;
    await sleep(20);
  }
  if (rec?.where) {
    // the attack state is checked from OUTSIDE the frozen supervisor, right before the kill
    if (o.liveNeedle) {
      const live = rec.pids.filter((p) => alive(p) && (cmdline(p) ?? '').includes(o.liveNeedle!));
      rec.liveAtKill = live.length > 0;
      if (live.length) rec.livePid = live[0];
    }
    child.kill('SIGKILL');
  } else if (!exited) {
    child.kill('SIGKILL');
  }
  const [exitCode, signal] = await closed;
  if (!rec && existsSync(readyFile)) rec = JSON.parse(readFileSync(readyFile, 'utf8'));
  return { where: rec?.where ?? null, pids: rec?.pids ?? [], asked: rec?.asked ?? {}, ...(rec?.error ? { error: rec.error } : {}), ...(o.liveNeedle ? { liveAtKill: rec?.liveAtKill ?? false, ...(rec?.livePid !== undefined ? { livePid: rec.livePid } : {}) } : {}), ...(rec?.requestId ? { requestId: rec.requestId } : {}), exitCode, signal, stdout, stderr };
}
