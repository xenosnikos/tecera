import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Change, ChangeStatus } from './diffBoundary.js';
import type { Hunk } from './tamper.js';

const run = promisify(execFile);

/** Git invocations never run repository hooks or read user config (security.md §1 attack 8). */
export const GIT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  LANG: 'C.UTF-8',
};

export const GIT_SAFE_ARGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.pager=cat'];

export async function git(dir: string, args: string[], opts: { maxBuffer?: number } = {}): Promise<string> {
  const { stdout } = await run('git', ['-C', dir, ...GIT_SAFE_ARGS, ...args], { env: GIT_ENV, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024 });
  return stdout;
}

export interface Snapshot {
  /** sha256 over head, tracked diff, index diff, and every untracked/ignored file's name:hash. */
  fingerprint: string;
  head: string;
  changes: Change[];
  hunks: Hunk[];
  /** Redacted later by the serializer; here it is the raw diff plus new-file contents, capped. */
  packet: string;
  truncated: boolean;
}

const PACKET_CAP = 200 * 1024;

/**
 * Port of EEZE runtime._snapshot: the fingerprint covers tracked changes, the index, and untracked AND
 * ignored files (the EEZE guard omitted ignored files; the snapshot did not; we feed both everywhere).
 */
export async function snapshotWorktree(dir: string, base: string): Promise<Snapshot> {
  const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  const diff = await git(dir, ['diff', '--binary', '--no-ext-diff', base, '--']);
  const index = await git(dir, ['diff', '--cached', '--binary', '--no-ext-diff', base, '--']);
  const nameStatus = await git(dir, ['diff', '--name-status', '--no-renames', base, '--']);
  const numstat = await git(dir, ['diff', '--numstat', base, '--']);
  const summary = await git(dir, ['diff', '--summary', base, '--']);
  const status = await git(dir, ['status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=all']);

  const binaryPaths = new Set(numstat.split('\n').filter((l) => l.startsWith('-\t-\t')).map((l) => l.split('\t')[2]!));
  const modeChanged = new Set([...summary.matchAll(/mode change .* (\S+)$/gm)].map((m) => m[1]!));

  const changes: Change[] = [];
  for (const line of nameStatus.split('\n')) {
    if (!line.trim()) continue;
    const [st, ...rest] = line.split('\t');
    const path = rest[rest.length - 1]!;
    const status = (st![0] as ChangeStatus) ?? '?';
    const c: Change = { path, status, binary: binaryPaths.has(path), modeChanged: modeChanged.has(path) };
    await enrich(dir, c);
    changes.push(c);
  }

  const extra: Array<{ path: string; status: '?' | '!' }> = [];
  for (const entry of status.split('\0')) {
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code === '??') extra.push({ path, status: '?' });
    else if (code === '!!') extra.push({ path, status: '!' });
  }
  extra.sort((a, b) => (a.path < b.path ? -1 : 1));
  const extraHashes: string[] = [];
  let packet = diff + (index ? `\n--- index ---\n${index}` : '');
  let truncated = false;
  for (const e of extra) {
    const c: Change = { path: e.path, status: e.status };
    await enrich(dir, c);
    changes.push(c);
    const h = await hashPath(dir, e.path, c.symlink);
    extraHashes.push(`${e.path}:${h}`);
    if (e.status === '?' && !c.symlink && (c.bytes ?? 0) <= PACKET_CAP) {
      const content = await readFile(join(dir, e.path)).catch(() => Buffer.alloc(0));
      if (!looksBinary(content)) packet += `\n+++ ${e.path} (new)\n${content.toString('utf8')}`;
    }
  }
  if (packet.length > PACKET_CAP) {
    packet = packet.slice(0, PACKET_CAP) + `\n[...packet truncated at ${PACKET_CAP} chars...]`;
    truncated = true;
  }
  const fingerprint = createHash('sha256').update([head, diff, index, extraHashes.join('\n')].join('\n\x00\n')).digest('hex');
  return { fingerprint, head, changes, hunks: parseHunks(diff), packet, truncated };
}

async function enrich(dir: string, c: Change): Promise<void> {
  try {
    const st = await lstat(join(dir, c.path));
    c.symlink = st.isSymbolicLink();
    c.bytes = st.size;
  } catch {
    // deleted paths have no stat
  }
}

async function hashPath(dir: string, path: string, symlink?: boolean): Promise<string> {
  try {
    if (symlink) return 'link:' + createHash('sha256').update(await readlink(join(dir, path))).digest('hex');
    return createHash('sha256').update(await readFile(join(dir, path))).digest('hex');
  } catch {
    return 'unreadable';
  }
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Added lines per file from a unified diff. */
export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^b\//, '');
      current = { path: p === '/dev/null' ? '' : p, added: [] };
      hunks.push(current);
    } else if (current && line.startsWith('+') && !line.startsWith('+++')) current.added.push(line.slice(1));
  }
  return hunks.filter((h) => h.path);
}
