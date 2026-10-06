import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Host-controlled git for every gate (security.md §1 attack 8, §5). No gate ever lets git read worktree
 * content: listings come from `ls-files`/`ls-tree` (names and objects only), file bytes are read by the
 * host and written with `hash-object --no-filters --stdin`, the index is built with `update-index
 * --index-info` in a private GIT_INDEX_FILE, and commits are made with `commit-tree` + `update-ref`.
 * On top of that every invocation runs with:
 *  - an explicit environment (nothing inherited but PATH): no global/system config, no system attributes,
 *    no XDG config, no replace objects, no optional locks, no prompts;
 *  - command-line overrides that disable hooks, fsmonitor, attribute files, external diff, pagers,
 *    signing, credential helpers, ssh commands and every transport protocol.
 * And `assertSafeRepo` refuses (before any other git call) a repository whose own config could still name
 * a program: filter/textconv/merge drivers, hooksPath, fsmonitor, sshCommand, credential helpers, includes.
 */

export interface GitIdentity {
  name: string;
  email: string;
}

export const DEFAULT_IDENTITY: GitIdentity = { name: 'tecera', email: 'tecera@localhost' };

let isolatedHome: string | null = null;
function home(): string {
  if (!isolatedHome) isolatedHome = mkdtempSync(join(tmpdir(), 'tecera-gates-home-'));
  return isolatedHome;
}

/** The only environment a gate's git ever sees. */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const h = home();
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: h,
    XDG_CONFIG_HOME: join(h, 'xdg'),
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_PROTOCOL_FROM_USER: '0',
    GIT_ADVICE: '0',
    ...extra,
  };
}

/** Overrides applied to every gate git call (command-line config beats repository config). */
export const HOST_GIT_ARGS: readonly string[] = [
  '--no-replace-objects',
  '--literal-pathspecs',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.attributesFile=/dev/null',
  '-c', 'core.untrackedCache=false',
  '-c', 'core.pager=cat',
  '-c', 'core.askPass=',
  '-c', 'core.sshCommand=',
  '-c', 'diff.external=',
  '-c', 'commit.gpgSign=false',
  '-c', 'tag.gpgSign=false',
  '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=false',
  '-c', 'credential.helper=',
  '-c', 'protocol.allow=never',
];

export class GitFailed extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'GitFailed';
  }
}

export interface HostGitOptions {
  input?: Buffer | string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  maxBuffer?: number;
}

/** Run git in `dir` under the host-controlled environment. Rejects with GitFailed on non-zero exit. */
export function hostGit(dir: string, args: readonly string[], o: HostGitOptions = {}): Promise<string> {
  const max = o.maxBuffer ?? 256 * 1024 * 1024;
  return new Promise((resolveP, reject) => {
    const child = spawn('git', ['-C', dir, ...HOST_GIT_ARGS, ...args], { env: gitEnv(o.env), stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let overflow = false;
    child.stdout.on('data', (b: Buffer) => {
      size += b.length;
      if (size > max) {
        overflow = true;
        child.kill('SIGKILL');
      } else out.push(b);
    });
    child.stderr.on('data', (b: Buffer) => {
      if (err.reduce((n, x) => n + x.length, 0) < 64 * 1024) err.push(b);
    });
    child.on('error', (e) => reject(new GitFailed(`git ${args[0] ?? ''}: ${e.message}`, null)));
    child.on('close', (code) => {
      if (overflow) return reject(new GitFailed(`git ${args[0] ?? ''}: output exceeded ${max} bytes`, code));
      if (code !== 0) return reject(new GitFailed(`git ${args[0] ?? ''} exited ${code}: ${Buffer.concat(err).toString('utf8').trim().slice(0, 2000)}`, code));
      resolveP(Buffer.concat(out).toString('utf8'));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(o.input ?? '');
  });
}

// ---------------------------------------------------------------------------------------------------------
// Repository safety preflight

export class UnsafeRepo extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`repository can make git run programs or is unsupported:\n- ${problems.join('\n- ')}`);
    this.name = 'UnsafeRepo';
  }
}

/** Config keys (lower-cased) that can name a program, pull in other config, or redirect the repository. */
const DANGEROUS_KEYS: readonly RegExp[] = [
  /^filter\./,
  /^diff\.[^.]*\.?(textconv|command)$/,
  /^diff\.external$/,
  /^merge\..*\.driver$/,
  /^core\.(sshcommand|fsmonitor|hookspath|pager|editor|askpass|gitproxy|attributesfile|worktree|alternaterefscommand)$/,
  /^credential\./,
  /^gpg\./,
  /^include\./,
  /^includeif\./,
  /^sequence\.editor$/,
  /^submodule\..*\.update$/,
  /^uploadpack\./,
  /^receive\./,
  /^remote\..*\.(uploadpack|receivepack|vcs)$/,
  /^pager\./,
  /^trace2\./,
  /^extensions\.(partialclone|refstorage)$/,
];

/** Attribute settings that would make git transform content on its own. */
export const DANGEROUS_ATTR = /(?:^|\s)(?:filter=|working-tree-encoding=|ident(?=\s|$)|export-subst(?=\s|$)|export-ignore(?=\s|$))/m;
/** .gitmodules `update = !cmd` (or any update strategy) is refused outright. */
export const DANGEROUS_MODULES = /^\s*update\s*=/im;

export interface RepoSafety {
  objectFormat: 'sha1' | 'sha256';
  /** core.fileMode (default true). When false the executable bit on disk is ignored, like git. */
  fileMode: boolean;
}

/**
 * Refuse a repository whose local/worktree config (or `$GIT_DIR/info/attributes`) could execute a program
 * or transform content. Runs before any other git call of a gate.
 */
export async function assertSafeRepo(dir: string, signal?: AbortSignal): Promise<RepoSafety> {
  if (!dir || !isAbsolute(dir)) throw new UnsafeRepo([`worktree must be an absolute path (got ${JSON.stringify(dir)})`]);
  const problems: string[] = [];
  // `--show-scope -z` emits alternating records: scope NUL key[LF value] NUL. Our own -c overrides have
  // scope 'command' and are skipped; everything else (local, worktree, included files) is the repository's.
  const parts = (await hostGit(dir, ['config', '--list', '--show-scope', '-z'], { signal })).split('\0');
  let fileMode = true;
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i]!;
    const kv = parts[i + 1]!;
    if (scope === 'command') continue;
    const nl = kv.indexOf('\n');
    const key = (nl === -1 ? kv : kv.slice(0, nl)).toLowerCase();
    const value = nl === -1 ? 'true' : kv.slice(nl + 1);
    if (key === 'core.filemode') fileMode = !/^(false|no|off|0)$/i.test(value.trim());
    if (DANGEROUS_KEYS.some((re) => re.test(key))) problems.push(`config key ${key} (${scope}) is not allowed in a gated repository`);
  }
  const fmt = (await hostGit(dir, ['rev-parse', '--show-object-format'], { signal })).trim();
  if (fmt !== 'sha1' && fmt !== 'sha256') problems.push(`unsupported object format ${fmt}`);
  const attrPath = (await hostGit(dir, ['rev-parse', '--git-path', 'info/attributes'], { signal })).trim();
  const abs = isAbsolute(attrPath) ? attrPath : resolve(dir, attrPath);
  const attrs = await readFile(abs, 'utf8').catch(() => '');
  if (DANGEROUS_ATTR.test(attrs)) problems.push('$GIT_DIR/info/attributes sets filter/ident/export/encoding attributes');
  if (problems.length) throw new UnsafeRepo([...new Set(problems)]);
  return { objectFormat: fmt as 'sha1' | 'sha256', fileMode };
}

/** Turn an id into a git-ref-safe branch suffix. Final validity is still checked with check-ref-format. */
export function refSafe(id: string): string {
  return id
    .replace(/[^A-Za-z0-9._/-]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/\/{2,}/g, '/')
    .replace(/(^[-./]+)|([./]+$)/g, '')
    .replace(/\.lock(\/|$)/g, '-lock$1')
    .slice(0, 100);
}

/** A rev argument we are willing to pass to git (never an option, never a range or pathspec). */
export function safeRev(rev: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(rev) && !rev.includes('..') && !rev.endsWith('.lock');
}
