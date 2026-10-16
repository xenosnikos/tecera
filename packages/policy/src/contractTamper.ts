import type { AcceptanceContract } from '@tecera/contracts';
import { matchesAny, matchesGlob, normalizePath } from './glob.js';

/**
 * The accepted contract and every criterion's check command are the requestor's, not the worker's. A worker
 * edit to the file holding the contract, to a file a criterion's command runs, or to the package.json script
 * it invokes changes what "done" means: tampering, refused by the tamperCheck hook and the tamper gate. The
 * one exception is a product file the accepted envelope lists for modify (the request is to change it):
 * test files a criterion runs stay protected whatever the envelope says.
 */

/** Where contracts live by default (goal files with criteria, run state). */
export const DEFAULT_CONTRACT_GLOBS: readonly string[] = ['.tecera/**'];

/**
 * The scripts of the package.json files a criterion may run through, as they are on the BASE of the work
 * branch (never the worker's tree): directory ('' for the repository root, `tools` for tools/package.json)
 * → script name → body. With them a criterion `npm run check` also protects what the script body runs.
 */
export type PackageScripts = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface ContractGuard {
  contract?: AcceptanceContract | null;
  /** Globs of files that hold the contract (default DEFAULT_CONTRACT_GLOBS). */
  contractPaths?: readonly string[];
  /** Base package.json scripts (criterionScriptDirs names the directories); absent → script bodies are not followed. */
  packageScripts?: PackageScripts;
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
/** Commands that run the rest of their words as a command (`env CI=1 npm test`, `time make`, `timeout 30 sh x`). */
const WRAPPERS = new Set(['env', 'time', 'nice', 'nohup', 'exec', 'command', 'timeout', 'stdbuf', 'setsid', 'sudo']);
/** Wrapper options whose value is the next word (`timeout -k 5 30 x`, `nice -n 5 x`, `env -u V x`, `sudo -u u x`). */
const WRAPPER_VALUE_FLAGS = new Set(['-k', '--kill-after', '-s', '--signal', '-n', '--adjustment', '-u', '--unset', '-C', '--chdir', '-g', '-S']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
/** Programs whose first plain argument is the script they run, with or without an extension (`node check`, `bash run-checks`). */
const INTERPRETERS = new Set([...SHELLS, 'node', 'nodejs', 'deno', 'tsx', 'ts-node', 'python', 'python2', 'python3', 'ruby', 'perl', 'php']);
/** Interpreter options whose value is the next word (never the script). */
const INTERPRETER_VALUE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--conditions', '-C', '--env-file', '--input-type', '--test-reporter', '--test-reporter-destination', '--test-name-pattern', '-W', '-X', '-I', '-o', '-O']);
/** Options after which no script file follows: inline code (`node -e`, `python -c`) or a module name (`python -m`). */
const inlineFlag = (cmd: string, flag: string): boolean => {
  if (SHELLS.has(cmd)) return flag === '-c';
  if (cmd.startsWith('python')) return flag === '-c' || flag === '-m';
  return flag === '-e' || flag === '--eval' || flag === '-p' || flag === '--print';
};
/** Interpreter subcommands that precede the script (`deno run x`, `deno test`). */
const INTERPRETER_VERBS = new Set(['run', 'test', 'eval']);
const CD_COMMANDS = new Set(['cd', 'pushd']);
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

/** Repository-relative `rel` under directory `cwd` ('' = root); null when it leaves the repository or is not a repository path. */
function under(cwd: string, rel: string): string | null {
  // Absolute paths and URLs are outside the work tree a worker can write (protectedPaths refuses them).
  if (rel.includes('://') || rel.startsWith('/') || rel.startsWith('$') || rel.startsWith('~')) return null;
  const parts: string[] = [];
  for (const seg of normalizePath(cwd ? `${cwd}/${rel}` : rel).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

interface Collector {
  paths: Set<string>;
  scripts: Set<string>;
  /** Directories whose package.json a criterion runs a script of ('' = root). */
  dirs: Set<string>;
  packageScripts?: PackageScripts;
}

/**
 * Collect what one simple command runs. `cwd` is the directory earlier `cd` / `pushd` commands of the same
 * line moved to ('' = root); returns the directory the next command runs in. A path is recorded both under
 * `cwd` and from the root (a `cd` inside a subshell does not carry over; protecting both is the safe side).
 * `depth` bounds `sh -c` nesting and package scripts that run package scripts.
 */
function collectTargets(input: readonly string[], acc: Collector, depth: number, cwd: string): string {
  let words = input.filter((w) => w.length > 0);
  const addPath = (v: string): void => {
    for (const base of cwd ? [cwd, ''] : ['']) {
      const p = under(base, v);
      if (p) acc.paths.add(p);
    }
  };
  // Strip environment assignments and wrapper commands, and descend into `sh -c '<command>'`.
  for (;;) {
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words = words.slice(1);
    const head = words[0];
    if (head && WRAPPERS.has(head)) {
      words = words.slice(1);
      while (words.length && words[0]!.startsWith('-')) words = words.slice(WRAPPER_VALUE_FLAGS.has(words[0]!) ? 2 : 1);
      // `timeout 30 <command>`: the duration is not the command.
      if (head === 'timeout' && words.length && /^\d/.test(words[0]!)) words = words.slice(1);
      continue;
    }
    if (head && SHELLS.has(head)) {
      const c = words.findIndex((w, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
      if (c > 0 && words[c + 1] !== undefined) {
        if (depth < 4) {
          let inner = cwd;
          for (const cmd of shellCommands(words[c + 1]!)) inner = collectTargets(cmd, acc, depth + 1, inner);
        }
        return cwd;
      }
    }
    break;
  }
  const [cmd, ...rest] = words;
  if (!cmd) return cwd;
  if (CD_COMMANDS.has(cmd)) {
    const to = rest.find((w) => !w.startsWith('-'));
    // An unresolvable target (`cd "$DIR"`, `cd -`, outside the repository) leaves the directory as it was.
    return (to !== undefined && to !== '-' ? under(cwd, to) : null) ?? cwd;
  }
  if (RUNNERS.has(cmd)) {
    const args: string[] = [];
    let dir = cwd;
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i]!;
      if (w === '--') break;
      if (w.startsWith('-')) {
        const eq = w.indexOf('=');
        const name = eq === -1 ? w : w.slice(0, eq);
        const value = eq === -1 ? rest[i + 1] : w.slice(eq + 1);
        // `npm --prefix tools run check`, `yarn --cwd tools check`: the script is tools/package.json's.
        if ((name === '--prefix' || name === '-C' || name === '--cwd' || name === '--dir') && value !== undefined) dir = under(cwd, value) ?? dir;
        if (RUNNER_VALUE_FLAGS.has(w)) i++;
        continue;
      }
      args.push(w);
    }
    // `yarn workspace <name> <script>`, `yarn workspaces foreach run <script>`
    if (cmd === 'yarn' && args[0] === 'workspace') args.splice(0, 2);
    else if (cmd === 'yarn' && args[0] === 'workspaces' && args[1] === 'foreach') args.splice(0, 2);
    const first = args[0];
    let script: string | undefined;
    if (first && RUNNER_VERBS.has(first) && args[1]) script = args[1];
    else if (first && cmd === 'npm' && NPM_LIFECYCLE[first]) script = NPM_LIFECYCLE[first]!;
    else if (first && cmd !== 'npm') script = first;
    if (script !== undefined) {
      acc.scripts.add(script);
      // The script's body is what the criterion really runs: follow it (and its pre/post scripts) in the
      // package's directory, on the base package.json the caller read.
      for (const d of new Set([dir, ''])) {
        acc.dirs.add(d);
        for (const name of [script, `pre${script}`, `post${script}`]) {
          const body = acc.packageScripts?.[d]?.[name];
          if (typeof body !== 'string' || depth >= 4) continue;
          let inner = d;
          for (const c of shellCommands(body)) inner = collectTargets(c, acc, depth + 1, inner);
        }
      }
    }
  }
  if (cmd === 'make') addPath('Makefile');
  if (INTERPRETERS.has(cmd)) {
    // The first plain argument is the script, extension or not (`bash run-checks`, `node check`).
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i]!;
      if (w === '--') {
        if (rest[i + 1] !== undefined) addPath(rest[i + 1]!);
        break;
      }
      if (inlineFlag(cmd, w)) break;
      if (w.startsWith('-')) {
        if (INTERPRETER_VALUE_FLAGS.has(w)) i++;
        continue;
      }
      if (i === 0 && INTERPRETER_VERBS.has(w) && !SHELLS.has(cmd)) continue;
      addPath(w);
      break;
    }
  }
  for (const w of words) {
    const v = w.includes('=') && w.startsWith('-') ? w.slice(w.indexOf('=') + 1) : w;
    if (v.startsWith('-')) continue;
    if (v.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(v)) addPath(v.replace(/\/+$/, ''));
  }
  return cwd;
}

function collect(contract: AcceptanceContract | null | undefined, packageScripts?: PackageScripts): Collector {
  const acc: Collector = { paths: new Set(), scripts: new Set(), dirs: new Set(), ...(packageScripts ? { packageScripts } : {}) };
  for (const k of contract?.criteria ?? []) {
    if (k.check?.kind !== 'command' || typeof k.check.command !== 'string') continue;
    let cwd = '';
    for (const words of shellCommands(k.check.command)) cwd = collectTargets(words, acc, 0, cwd);
  }
  return acc;
}

/**
 * Paths and package scripts the contract's command criteria run: the program of each check (script files,
 * package scripts, Makefile), not the code it checks. Follows `cd` / `pushd`, wrapper commands, `sh -c`
 * strings, an interpreter's script argument (with or without an extension) and, when `opts.packageScripts`
 * holds the base package.json scripts, the body of every package script a criterion runs. Errs toward
 * protecting more (a path is recorded under the current directory and from the root); never executes
 * anything. A bare runner (`node --test`, `pytest`) names no program of its own: its tests are covered by the
 * test rules, not here.
 */
export function criterionTargets(contract: AcceptanceContract | null | undefined, opts: { packageScripts?: PackageScripts } = {}): CriterionTargets {
  const acc = collect(contract, opts.packageScripts);
  for (const s of [...acc.scripts]) acc.scripts.add(`pre${s}`).add(`post${s}`);
  return { paths: [...acc.paths], scripts: [...acc.scripts] };
}

/**
 * The directories ('' = root) whose package.json holds a script some criterion runs. The caller reads those
 * files from the base of the work branch and passes their scripts back as `packageScripts`. Scripts that run
 * scripts of another directory are found by calling this again with what was read (it is monotonic).
 */
export function criterionScriptDirs(contract: AcceptanceContract | null | undefined, packageScripts?: PackageScripts): string[] {
  return [...collect(contract, packageScripts).dirs];
}

/**
 * Parse package.json text into its scripts (name → body). Anything that is not an object of strings yields
 * no scripts: an unreadable manifest protects nothing more, and the script-key rules still apply.
 */
export function packageScriptsOf(text: string): Record<string, string> {
  try {
    const scripts = (JSON.parse(text) as { scripts?: unknown } | null)?.scripts;
    if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return {};
    return Object.fromEntries(Object.entries(scripts as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return {};
  }
}

/** A test file by its path (`test/…`, `tests/…`, `__tests__/…`, `*.test.*`, `*.spec.*`): always the criterion's, never the work's. */
const TEST_PATH = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Whether the accepted envelope names `p` itself (an exact path, not a glob) with `modify`: the requestor
 * signed off that the work changes this file, so a criterion running it checks the changed file. The
 * criterion's command text stays protected with the contract, and a test file is never released this way.
 */
function releasedByEnvelope(p: string, contract: AcceptanceContract | null | undefined): boolean {
  if (TEST_PATH.test(p) || isPackageJson(p)) return false;
  return (contract?.envelope ?? []).some((e) => !e.path.includes('*') && normalizePath(e.path).replace(/^\.\//, '') === p && e.ops.includes('modify'));
}

/**
 * Whether a change to `path` is contract tampering: the contract's own file, or a file a criterion runs.
 * A product file a criterion runs is not tampering when the accepted envelope lists it for modify (the
 * request is to change it, e.g. the command a criterion spawns); a test file a criterion runs always is.
 */
export function contractTouch(path: string, guard: ContractGuard, targets: CriterionTargets = criterionTargets(guard.contract, guard.packageScripts ? { packageScripts: guard.packageScripts } : {})): { code: 'contract-edit' | 'criterion-edit'; detail: string } | null {
  const p = normalizePath(path).replace(/^\.\//, '');
  const held = matchesAny(p, guard.contractPaths ?? DEFAULT_CONTRACT_GLOBS);
  if (held) return { code: 'contract-edit', detail: `${p} holds the acceptance contract (${held})` };
  for (const t of targets.paths) {
    if (t.includes('*') ? matchesGlob(p, t) : p === t || p.startsWith(`${t}/`)) {
      if (releasedByEnvelope(p, guard.contract)) continue;
      return { code: 'criterion-edit', detail: `${p} is run by a criterion's check command` };
    }
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
export function packageScriptWriteProblem(input: { tool?: string; method?: string; path?: string; args?: unknown }, targets: CriterionTargets): string | null {
  if (!input.path || !isPackageJson(input.path) || targets.scripts.length === 0) return null;
  const p = normalizePath(input.path).replace(/^\.\//, '');
  const names = targets.scripts.join(', ');
  if (input.method === 'delete' || input.tool === 'delete') return `deleting ${p} removes the package scripts a criterion's check command runs (${names})`;
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
