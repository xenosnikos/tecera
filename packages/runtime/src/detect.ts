import { basename } from 'node:path';
import { gitSync, onPath, repoExecHazards, type Env } from './util/proc.js';

/**
 * What `init` detects instead of asking: the git repo (via a git subprocess; "not a repo" is reported and
 * init continues), the test command from package.json, which provider keys are present (names only, a
 * value is never read into output), and sandbox prerequisites on PATH.
 */

export const KNOWN_PROVIDER_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'] as const;

export interface GitInfo {
  repo: boolean;
  branch?: string;
  head?: string;
  clean?: boolean;
  /** Repository config entries that could run programs; when present `git status` is not run. */
  hazards?: string[];
}

export interface Detection {
  git: GitInfo;
  test: { command: string | null; source: string };
  keys: Record<string, boolean>;
  sandbox: Record<string, boolean>;
  owner: string;
  name: string;
}

export function detectGit(dir: string, env: Env): GitInfo {
  const top = gitSync(dir, ['rev-parse', '--show-toplevel'], { env });
  if (top.code !== 0) return { repo: false };
  const branch = gitSync(dir, ['symbolic-ref', '--short', 'HEAD'], { env });
  const head = gitSync(dir, ['rev-parse', '--short', 'HEAD'], { env });
  const hazards = repoExecHazards(dir, env);
  const status = hazards.length ? null : gitSync(dir, ['status', '--porcelain'], { env });
  return {
    repo: true,
    branch: branch.code === 0 ? branch.stdout.trim() : undefined,
    head: head.code === 0 ? head.stdout.trim() : undefined,
    clean: status && status.code === 0 ? status.stdout.trim() === '' : undefined,
    ...(hazards.length ? { hazards } : {}),
  };
}

export function detectTestCommand(read: (rel: string) => string | undefined, exists: (rel: string) => boolean): { command: string | null; source: string } {
  const text = read('package.json');
  if (text === undefined) return { command: null, source: 'no package.json' };
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(text) as typeof pkg;
  } catch {
    return { command: null, source: 'package.json is not valid JSON' };
  }
  const script = pkg.scripts?.test;
  if (!script || /no test specified/.test(script)) return { command: null, source: 'package.json has no test script' };
  const pm = exists('yarn.lock') ? 'yarn' : exists('pnpm-lock.yaml') ? 'pnpm' : 'npm';
  return { command: `${pm} test`, source: 'package.json scripts.test' };
}

export function detectOwner(dir: string, env: Env): string {
  const email = gitSync(dir, ['config', 'user.email'], { env, userConfig: true });
  if (email.code === 0 && email.stdout.trim()) return email.stdout.trim();
  return env.USER?.trim() || env.USERNAME?.trim() || 'owner';
}

export function detectName(dir: string, read: (rel: string) => string | undefined): string {
  const text = read('package.json');
  if (text) {
    try {
      const n = (JSON.parse(text) as { name?: unknown }).name;
      if (typeof n === 'string' && n.trim()) return n.trim();
    } catch {
      /* fall through */
    }
  }
  return basename(dir) || 'business-case';
}

export function detect(dir: string, read: (rel: string) => string | undefined, exists: (rel: string) => boolean, env: Env): Detection {
  return {
    git: detectGit(dir, env),
    test: detectTestCommand(read, exists),
    keys: Object.fromEntries(KNOWN_PROVIDER_KEYS.map((k) => [k, !!env[k]])),
    sandbox: Object.fromEntries(['bwrap', 'unshare', 'systemd-run'].map((t) => [t, onPath(t, env)])),
    owner: detectOwner(dir, env),
    name: detectName(dir, read),
  };
}
