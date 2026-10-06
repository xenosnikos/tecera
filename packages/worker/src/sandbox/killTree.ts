import type { ChildProcess } from 'node:child_process';

/**
 * Process-group kill with a reap check. Sandbox and verify processes are spawned detached, so the
 * child is its own group leader (pgid = pid) and every descendant that did not escape with setsid
 * shares the group. SIGKILL goes to the negative pgid; the call resolves only after the leader has been
 * reaped and `kill(-pgid, 0)` reports the group empty, or reports `gone: false` at the deadline.
 */

export interface KillTreeResult {
  /** True when the group no longer exists. */
  gone: boolean;
  /** True when a signal was actually delivered (the group still existed). */
  signalled: boolean;
}

/** True while any process in the group exists (zombies included until reaped). */
export function groupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function waitExit(child: ChildProcess, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function killTree(pgid: number, opts: { child?: ChildProcess; timeoutMs?: number } = {}): Promise<KillTreeResult> {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error(`refusing to kill invalid pgid ${pgid}`);
  const deadline = Date.now() + (opts.timeoutMs ?? 3_000);
  let signalled = false;
  try {
    process.kill(-pgid, 'SIGKILL');
    signalled = true;
  } catch {
    // ESRCH: group already gone. EPERM: not ours; the reap check below reports it.
  }
  if (opts.child) await waitExit(opts.child, Math.max(0, deadline - Date.now()));
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return { gone: false, signalled };
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      /* raced with exit */
    }
    await sleep(10);
  }
  return { gone: true, signalled };
}
