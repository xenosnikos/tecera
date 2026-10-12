import type { AcceptanceContract } from '@tecera/contracts';
import { matchesAny, matchesGlob, normalizePath } from './glob.js';

/**
 * The accepted contract and every criterion's check command are the requestor's, not the worker's. A worker
 * edit to the file holding the contract, to a file a criterion's command runs, or to the package.json script
 * it invokes changes what "done" means: tampering, refused by the tamperCheck hook and the tamper gate.
 */

/** Where contracts live by default (goal files with criteria, run state). */
export const DEFAULT_CONTRACT_GLOBS: readonly string[] = ['.tecera/**'];

export interface ContractGuard {
  contract?: AcceptanceContract | null;
  /** Globs of files that hold the contract (default DEFAULT_CONTRACT_GLOBS). */
  contractPaths?: readonly string[];
}

/** What criterion commands depend on: repository paths they name and package scripts they run. */
export interface CriterionTargets {
  paths: string[];
  scripts: string[];
}

const RUNNERS = new Set(['npm', 'yarn', 'pnpm', 'bun']);
const RUNNER_VERBS = new Set(['run', 'run-script', 'exec', 'dlx', 'x']);
const NPM_LIFECYCLE: Record<string, string> = { test: 'test', t: 'test', tst: 'test', start: 'start', stop: 'stop', restart: 'restart' };
/** Runner options whose value is the next word (`npm --workspace api run x`, `pnpm --filter api x`). */
const RUNNER_VALUE_FLAGS = new Set(['--workspace', '-w', '--prefix', '--filter', '-F', '-C', '--cwd', '--dir', '--scope']);
/** Commands that run the rest of their words as a command (`env CI=1 npm test`, `time make`). */
const WRAPPERS = new Set(['env', 'time', 'nice', 'nohup', 'exec', 'command']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const SEPARATORS = ['&&', '||', ';', '|', '&', '\n', '(', ')'];

/**
 * A command line split into simple commands, each a list of words with shell quoting removed. Quotes keep a
 * separator inside them (`sh -c 'a && b'` is one command whose last word is `a && b`). Never executes.
 */
function shellCommands(line: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'" || c === '"') {
      const close = line.indexOf(c, i + 1);
      const end = close === -1 ? line.length : close;
      word += line.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[++i]!;
      inWord = true;
    } else if (/\s/.test(c) && c !== '\n') {
      endWord();
    } else {
      const sep = SEPARATORS.find((x) => line.startsWith(x, i));
      if (sep) {
        endCommand();
        i += sep.length - 1;
      } else {
        word += c;
        inWord = true;
      }
    }
  }
  endCommand();
  return out;
}

/** Collect what one simple command runs into `paths` / `scripts`; `depth` bounds `sh -c` nesting. */
function collectTargets(input: readonly string[], paths: Set<string>, scripts: Set<string>, depth: number): void {
  let words = input.filter((w) => w.length > 0);
  // Strip environment assignments and wrapper commands, and descend into `sh -c '<command>'`.
  for (;;) {
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words = words.slice(1);
    const head = words[0];
    if (head && WRAPPERS.has(head)) {
      words = words.slice(1);
      while (words.length && words[0]!.startsWith('-')) words = words.slice(1);
      continue;
    }
    if (head && SHELLS.has(head)) {
      const c = words.findIndex((w, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
      if (c > 0 && words[c + 1] !== undefined) {
        if (depth < 4) for (const cmd of shellCommands(words[c + 1]!)) collectTargets(cmd, paths, scripts, depth + 1);
        return;
      }
    }
    break;
  }
  const [cmd, ...rest] = words;
  if (!cmd) return;
  if (RUNNERS.has(cmd)) {
    const args: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i]!;
      if (w === '--') break;
      if (w.startsWith('-')) {
        if (RUNNER_VALUE_FLAGS.has(w)) i++;
        continue;
      }
      args.push(w);
    }
    // `yarn workspace <name> <script>`, `yarn workspaces foreach run <script>`
    if (cmd === 'yarn' && args[0] === 'workspace') args.splice(0, 2);
    else if (cmd === 'yarn' && args[0] === 'workspaces' && args[1] === 'foreach') args.splice(0, 2);
    const first = args[0];
    if (first && RUNNER_VERBS.has(first) && args[1]) scripts.add(args[1]);
    else if (first && cmd === 'npm' && NPM_LIFECYCLE[first]) scripts.add(NPM_LIFECYCLE[first]!);
    else if (first && cmd !== 'npm') scripts.add(first);
  }
  if (cmd === 'make') paths.add('Makefile');
  for (const w of words) {
    const v = w.includes('=') && w.startsWith('-') ? w.slice(w.indexOf('=') + 1) : w;
    // Absolute paths and URLs are outside the work tree a worker can write (protectedPaths refuses them).
    if (v.startsWith('-') || v.includes('://') || v.startsWith('/') || v.startsWith('$')) continue;
    if (v.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(v)) {
      const p = normalizePath(v.replace(/^\.\//, '')).replace(/\/+$/, '');
      if (p && p !== '.' && !p.startsWith('..')) paths.add(p);
    }
  }
}

/**
 * Paths and package scripts the contract's command criteria run: the program of each check (script files,
 * package scripts, Makefile), not the code it checks. Over-approximates; never executes anything.
 */
export function criterionTargets(contract: AcceptanceContract | null | undefined): CriterionTargets {
  const paths = new Set<string>();
  const scripts = new Set<string>();
  for (const k of contract?.criteria ?? []) {
    if (k.check?.kind !== 'command' || typeof k.check.command !== 'string') continue;
    for (const words of shellCommands(k.check.command)) collectTargets(words, paths, scripts, 0);
  }
  for (const s of [...scripts]) scripts.add(`pre${s}`).add(`post${s}`);
  return { paths: [...paths], scripts: [...scripts] };
}

/** Whether a change to `path` is contract tampering: the contract's own file, or a file a criterion runs. */
export function contractTouch(path: string, guard: ContractGuard, targets: CriterionTargets = criterionTargets(guard.contract)): { code: 'contract-edit' | 'criterion-edit'; detail: string } | null {
  const p = normalizePath(path).replace(/^\.\//, '');
  const held = matchesAny(p, guard.contractPaths ?? DEFAULT_CONTRACT_GLOBS);
  if (held) return { code: 'contract-edit', detail: `${p} holds the acceptance contract (${held})` };
  for (const t of targets.paths) {
    if (t.includes('*') ? matchesGlob(p, t) : p === t || p.startsWith(`${t}/`)) return { code: 'criterion-edit', detail: `${p} is run by a criterion's check command` };
  }
  return null;
}

/** Why a change to `path` is contract tampering (null when it is not). */
export function contractPathProblem(path: string, guard: ContractGuard, targets?: CriterionTargets): string | null {
  return contractTouch(path, guard, targets)?.detail ?? null;
}

/** Whether `path` names a package.json (at any depth): the file whose scripts a criterion may run. */
export function isPackageJson(path: string): boolean {
  const p = normalizePath(path);
  return p === 'package.json' || p.endsWith('/package.json');
}

const scriptKey = (line: string): string | undefined => /^\s*"([^"]+)"\s*:/.exec(line)?.[1];

/**
 * Why package.json lines added or removed by a change redefine or drop a script a criterion runs (null when
 * they do not). A removed definition counts: deleting or renaming the script changes what the check runs.
 */
export function criterionScriptProblem(path: string, added: readonly string[], targets: CriterionTargets, removed: readonly string[] = []): string | null {
  if (!isPackageJson(path) || targets.scripts.length === 0) return null;
  for (const [lines, what] of [[added, 'redefined'], [removed, 'removed']] as const) {
    for (const line of lines) {
      const k = scriptKey(line);
      if (k !== undefined && targets.scripts.includes(k)) return `package.json script ${k} is run by a criterion's check command (${what})`;
    }
  }
  return null;
}

/**
 * Why a worker's write or delete of a package.json, seen at ToolCall/Enter before anything is read, may
 * change a script a criterion runs (null when it cannot). The hook cannot see the file, so: a delete or a
 * whole-file write is refused outright; a targeted edit ({oldText, newText}) is refused when either text
 * names a protected script. A targeted edit of a script's value alone is left to the tamper gate, which
 * diffs the scripts the commit would land.
 */
export function packageScriptWriteProblem(input: { method?: string; path?: string; args?: unknown }, targets: CriterionTargets): string | null {
  if (!input.path || !isPackageJson(input.path) || targets.scripts.length === 0) return null;
  const p = normalizePath(input.path).replace(/^\.\//, '');
  const names = targets.scripts.join(', ');
  if (input.method === 'delete') return `deleting ${p} removes the package scripts a criterion's check command runs (${names})`;
  const args = Array.isArray(input.args) ? input.args : [];
  const a = args[0];
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    const { oldText, newText, content } = a as { oldText?: unknown; newText?: unknown; content?: unknown };
    if (content === undefined && typeof oldText === 'string' && typeof newText === 'string') {
      const hit = targets.scripts.find((k) => oldText.includes(`"${k}"`) || newText.includes(`"${k}"`));
      return hit ? `${p} script ${hit} is run by a criterion's check command` : null;
    }
  }
  return `a whole-file write of ${p} cannot be shown to keep the package scripts a criterion's check command runs (${names}); edit it with {oldText, newText}`;
}
