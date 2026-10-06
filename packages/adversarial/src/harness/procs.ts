import { readdirSync, readFileSync, readlinkSync } from 'node:fs';

/** /proc helpers: find processes by command line, parent or working directory, and test liveness. */

export function allPids(): number[] {
  return readdirSync('/proc')
    .filter((d) => /^\d+$/.test(d))
    .map(Number);
}

export function cmdline(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
  } catch {
    return null;
  }
}

export function environ(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8');
  } catch {
    return null;
  }
}

export function ppid(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(rest[1]);
  } catch {
    return null;
  }
}

export function cwdOf(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/** A process is alive when it exists and is not a zombie. */
export function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
    return state !== 'Z' && state !== 'X';
  } catch {
    return false;
  }
}

/** Every descendant of `root` (not including root). */
export function descendants(root: number): number[] {
  const kids = new Map<number, number[]>();
  for (const p of allPids()) {
    const pp = ppid(p);
    if (pp === null) continue;
    const l = kids.get(pp) ?? [];
    l.push(p);
    kids.set(pp, l);
  }
  const out: number[] = [];
  const stack = [root];
  while (stack.length) {
    const p = stack.pop()!;
    for (const k of kids.get(p) ?? []) {
      out.push(k);
      stack.push(k);
    }
  }
  return out;
}

/** The executable of a process (null when it is gone or unreadable). */
export function exeOf(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return null;
  }
}

/** Live processes whose cwd is inside `dir`. */
export function processesUnder(dir: string): number[] {
  return allPids().filter((p) => {
    const c = cwdOf(p);
    return c !== null && (c === dir || c.startsWith(`${dir}/`)) && alive(p);
  });
}

/** Live processes whose command line contains `needle`. */
export function processesMatching(needle: string): number[] {
  return allPids().filter((p) => p !== process.pid && (cmdline(p) ?? '').includes(needle) && alive(p));
}
