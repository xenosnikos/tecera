import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { GIT_ENV, GIT_SAFE_ARGS } from '@tecera/policy';

/**
 * Subprocess helpers. Every child gets an explicit environment (never the parent's by default), a
 * timeout and a process-group kill. Git runs with hooks disabled and no global or system config.
 */

export type Env = Record<string, string | undefined>;

export interface ProcResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  /** Either stream hit the byte cap; the process group was killed. */
  truncated: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** The signal was aborted (before the spawn: nothing ran). */
  cancelled: boolean;
  /** Members of the process group were still alive after the final SIGKILL sweep. */
  survivors: boolean;
}

export const OUTPUT_CAP_BYTES = 256 * 1024;

class Capped {
  private parts: Buffer[] = [];
  private bytes = 0;
  truncated = false;
  constructor(private readonly max: number) {}
  /** Returns false once the cap is hit. */
  push(c: Buffer): boolean {
    const room = this.max - this.bytes;
    if (c.length > room) {
      if (room > 0) this.parts.push(c.subarray(0, room));
      this.bytes = this.max;
      this.truncated = true;
      return false;
    }
    this.parts.push(c);
    this.bytes += c.length;
    return true;
  }
  text(): string {
    return Buffer.concat(this.parts).toString('utf8');
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** SIGKILL the group until it is gone (zombies are reaped by init); true when members survive ~1 s. */
async function sweep(pgid: number | undefined): Promise<boolean> {
  if (!pgid || process.platform === 'win32') return false;
  for (let i = 0; i < 20; i++) {
    if (!groupAlive(pgid)) return false;
    killGroup(pgid);
    await new Promise((r) => setTimeout(r, 50));
  }
  return groupAlive(pgid);
}

function killGroup(pgid: number | undefined): void {
  if (!pgid || process.platform === 'win32') return;
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/**
 * Run `file args` in its own process group with an explicit env. Refuses an already-aborted signal without
 * spawning. Kills the whole group on timeout, abort, or when either stream exceeds `maxOutputBytes`, and
 * always sweeps the group after the leader exits so background descendants do not outlive the check.
 */
export function runProcess(
  file: string,
  args: string[],
  opts: { cwd: string; env: Env; timeoutMs: number; signal?: AbortSignal; maxOutputBytes?: number; drainMs?: number },
): Promise<ProcResult> {
  const started = Date.now();
  const base = { stdoutTruncated: false, stderrTruncated: false, truncated: false, cancelled: false, survivors: false, timedOut: false, signal: null };
  if (opts.signal?.aborted) return Promise.resolve({ ...base, code: 130, stdout: '', stderr: 'cancelled before start', durationMs: 0, cancelled: true });
  return new Promise((resolvePromise) => {
    const out = new Capped(opts.maxOutputBytes ?? OUTPUT_CAP_BYTES);
    const err = new Capped(opts.maxOutputBytes ?? OUTPUT_CAP_BYTES);
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let exited: { code: number | null; signal: string | null } | null = null;
    const env = Object.fromEntries(Object.entries(opts.env).filter(([, v]) => v !== undefined)) as NodeJS.ProcessEnv;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { cwd: opts.cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolvePromise({ ...base, code: 127, stdout: '', stderr: (e as Error).message, durationMs: 0 });
      return;
    }
    const pgid = child.pid;
    const kill = (): void => {
      if (pgid && process.platform !== 'win32') killGroup(pgid);
      else child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = (): void => {
      cancelled = true;
      kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (c: Buffer) => {
      if (!out.push(c)) kill();
    });
    child.stderr?.on('data', (c: Buffer) => {
      if (!err.push(c)) kill();
    });
    let drainTimer: NodeJS.Timeout | undefined;
    const finish = (code: number | null, signal: string | null, extraErr = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      // Final sweep: nothing in the group may outlive the check.
      killGroup(pgid);
      void sweep(pgid).then((survivors) =>
        resolvePromise({
        code,
        signal,
        stdout: out.text(),
        stderr: err.text() + extraErr,
        timedOut,
        durationMs: Date.now() - started,
        truncated: out.truncated || err.truncated,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        cancelled,
        survivors,
      }),
      );
    };
    child.on('error', (e) => finish(127, null, (e as Error).message));
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      // Descendants may hold stdout open: kill the group, then give the pipes a short drain window.
      killGroup(pgid);
      drainTimer = setTimeout(() => finish(exited!.code, exited!.signal), opts.drainMs ?? 2000);
    });
    child.on('close', (code, signal) => finish(exited?.code ?? code, exited?.signal ?? signal));
  });
}

/** True when an executable named `bin` is on PATH. */
export function onPath(bin: string, env: Env): boolean {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, bin), constants.X_OK);
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git with hooks disabled and no user config. `userConfig` lets read-only config lookups see the user's identity. */
export function gitSync(cwd: string, args: string[], opts: { env?: Env; userConfig?: boolean } = {}): GitResult {
  const env = opts.userConfig
    ? { PATH: opts.env?.PATH ?? process.env.PATH ?? '', HOME: opts.env?.HOME ?? process.env.HOME ?? '', GIT_TERMINAL_PROMPT: '0', LANG: 'C.UTF-8' }
    : { ...GIT_ENV, PATH: opts.env?.PATH ?? GIT_ENV.PATH };
  const r = spawnSync('git', ['-C', cwd, ...GIT_SAFE_ARGS, ...args], { env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 15_000 });
  if (r.error) return { code: 127, stdout: '', stderr: r.error.message };
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Repository-local git config keys that make read-only git commands (status, diff) execute programs. The
 * hooks path, fsmonitor and pager are neutralised on every call by GIT_SAFE_ARGS and are not listed.
 */
export const GIT_EXEC_CONFIG = /^(filter\..+\.(clean|smudge|process)|diff\..+\.(textconv|command)|merge\..+\.driver|core\.(sshcommand|editor|askpass|gitproxy|alternaterefscommand)|include\.path|includeif\..+\.path|credential\..*helper|gpg\..*program|sequence\.editor)$/i;

/**
 * Names of repository-local config entries that could run a program during `git status`/`diff` (clean
 * filters, textconv, includes that could add them). `git config --local --list` reads the file without
 * following includes or executing anything. A non-zero exit (no repo) yields [].
 */
export function repoExecHazards(cwd: string, env: Env): string[] {
  const r = gitSync(cwd, ['config', '--local', '--name-only', '--list'], { env });
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((k) => k.length > 0 && GIT_EXEC_CONFIG.test(k));
}

/**
 * Config keys that make a READ-ONLY git command run a program when the HOST runs it (the Claude Code Bash
 * tool runs git with the user's full config, none of GIT_SAFE_ARGS): everything in GIT_EXEC_CONFIG plus the
 * fsmonitor hook, external diff, pagers and signature verification programs.
 */
export const HOST_GIT_EXEC_CONFIG = /^(core\.fsmonitor|core\.pager|pager\..+|diff\.external|interactive\.difffilter|log\.showsignature|gpg\..+)$/i;
/** Pager keys: harmless when the command disables the pager itself (`git --no-pager …` / `git -P …`). */
export const HOST_GIT_PAGER_CONFIG = /^(core\.pager|pager\..+|env:GIT_PAGER|env:PAGER)$/i;

/**
 * Names of git config entries in ANY scope (system, global, local, worktree; includes resolved by git while
 * reading, never executed) that would make the host's git run a program. Listing config runs nothing. A
 * failure to list is itself reported (fail closed: the caller refuses git).
 */
export function hostGitExecHazards(cwd: string, env: Env): string[] {
  // The listing sees what the host's git would: the user's HOME/XDG config and any env-provided config.
  const pass: Record<string, string> = { PATH: env.PATH ?? process.env.PATH ?? '', HOME: env.HOME ?? process.env.HOME ?? '', GIT_TERMINAL_PROMPT: '0', LANG: 'C.UTF-8' };
  for (const [k, v] of Object.entries(env)) if (v !== undefined && (k === 'XDG_CONFIG_HOME' || k.startsWith('GIT_CONFIG'))) pass[k] = v;
  const out: string[] = [];
  // Environment variables the host's git honours that run programs.
  for (const k of ['GIT_EXTERNAL_DIFF', 'GIT_PAGER', 'PAGER', 'GIT_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_EDITOR']) if (env[k]) out.push(`env:${k}`);
  const r = spawnSync('git', ['-C', cwd, 'config', '--name-only', '--list'], { env: pass as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 15_000 });
  if (r.error || r.status !== 0) return [...out, `git config could not be listed (${r.error?.message ?? `exit ${r.status}`})`];
  return [...new Set([...out, ...(r.stdout ?? '').split('\n').map((l) => l.trim()).filter((k) => k.length > 0 && (GIT_EXEC_CONFIG.test(k) || HOST_GIT_EXEC_CONFIG.test(k)))])];
}
