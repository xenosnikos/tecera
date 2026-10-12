import { isBuiltin } from 'node:module';
import type { AchievementGoal, CapabilityRecord, ContractDraft, Criterion, Manifest } from '@tecera/contracts';
import { nameUses, renderCall, renderDeclared, resolveFrom, type ArgKind } from './apiSurface.js';
import type { TestedCall, TestedModule } from './repoFacts.js';
import { safeSegment } from './schema.js';
import { namedPaths } from './scope.js';
import { base, readShell } from './shell.js';

/**
 * Drafted-contract quality (the model's draft only; scripted contracts and goal files are the requestor's).
 *
 * A contract is accepted by a human who may sign off whatever is put in front of them, so the planner refuses
 * the drafts that prove nothing about the request before they reach sign-off:
 * - a command criterion that only searches the repository text or checks a file exists (grep, rg, ls,
 *   test -f, …): it passes on a keyword, not on the behaviour;
 * - a command criterion that runs nothing able to fail on the behaviour (echo, true, `node --version`, an
 *   inline script that neither imports nor runs the repository's code, or one that never asserts, throws or
 *   exits non-zero), read through the prefixes the host knows (`timeout 5 true` is `true`);
 * - a command criterion that runs a program the host does not know as a check or as shell plumbing: only an
 *   inline script, a test runner, an interpreter handed a script file, a package script, a make target or a
 *   repository file counts as running the behaviour, and what follows an unknown word is screened by nothing;
 * - a command criterion that runs a file the repository does not hold yet, when the host can say (a worker
 *   may never write a file a criterion runs), including a file an inline script spawns;
 * - an inline script that imports a repository module the repository does not hold and the request does not
 *   name (an invented path), or a package that is neither a Node built-in nor listed in package.json (nothing
 *   else is installed, so the criterion can never pass), when the host can say;
 * - a command criterion that cannot run in the verify sandbox or whose exit status is not the check's: one
 *   that starts a server, reaches the network (fetch, http.request, curl, wget, a loopback address, a port),
 *   runs a command in the background (`&`), waits and kills (sleep, kill, wait, a timer of a second or more)
 *   or detaches a process, also inside a nested shell (`bash -lc '…'`, `eval`). The sandbox has no network,
 *   and `check & sleep 1 && kill %1` exits as kill does: the code is called in-process instead. The same for
 *   a check whose status is dropped or replaced by the line around it (`check | tail`, `check || echo`,
 *   `check; echo done`, `! check`, `exit`, `trap`, control flow): see commandStatusProblems;
 * - a script handed to an interpreter on standard input (a pipe or a here-document): the host reads only
 *   `-e` scripts, so nothing below could be checked on it;
 * - an inline script that calls a function the repository's tests already use with another call shape (fewer
 *   arguments than the tests ever pass, an argument of another kind than the tests pass and the module
 *   declares, a non-object argument to a function the tests only ever call with none, or only methods the
 *   tests never call on what it returns), imports an existing exported name from a module the repository
 *   does not hold (a second function of the same name), or imports a tested module in a form the host cannot
 *   read the calls from, when the host read the tests: the existing-tests criterion would contradict it. An
 *   added trailing argument or an added method is not a conflict, and a request that says outright that the
 *   function's inputs change ("change signup to accept …") is exempt;
 * - a contract whose command criteria are all generic (the repository's whole test command, or a test
 *   runner nothing narrows to a file or a test name): it cannot fail on a change that breaks nothing old and
 *   adds nothing new;
 * - fewer distinct focused criteria than behaviours the statement names (clauses joined by "and" or ";",
 *   prohibitions included; a "do not change …" constraint may rest on the existing suite);
 * - a capability the statement implies (persist/session/store → a database, send/notify/email → a message
 *   sender, a declared connection named by id or kind) that no focused criterion requires, or a focused
 *   criterion about it that does not require it.
 * These are coarse static screens, not proof: nothing here runs a command.
 * Requestor criteria are exempt from the per-criterion checks: they are agreed already and kept verbatim.
 *
 * Criterion tags are short lowercase names of what a criterion checks (`http-429`, `retry-after`,
 * `sessions-persist`). The model proposes them; the host normalises them and adds the ones the statement
 * names outright (an HTTP status and its reason phrase, header names), so a draft can be matched against
 * reference criteria deterministically, without a model. Tags are descriptive only: they are not part of the
 * contract hash and nothing decides on them.
 */

/** A criterion with the descriptive tags the planner adds (outside the contract hash). */
export type TaggedCriterion = Criterion & { tags?: string[] };

/** Kinds the local provisioner can create, in the order the drafting prompt lists them. */
export const PROVISIONABLE_KINDS = ['tmpdir', 'git-remote', 'sqlite', 'http-stub'] as const;

/** A capability the statement implies, with the id and kind the draft should use for it. */
export interface ImpliedNeed {
  id: string;
  kind: string;
  /** What in the statement implies it (for diagnostics and the prompt). */
  because: string;
}

const DB_KINDS = new Set(['sqlite', 'postgres', 'postgresql', 'mysql', 'mariadb', 'database', 'db', 'sql', 'mongodb', 'redis', 'kv']);
const MESSAGE_KINDS = new Set(['smtp', 'mail', 'email', 'sms', 'message', 'messages', 'notification', 'notifications', 'queue']);
const REMOTE_KINDS = new Set(['git-remote', 'git']);
const HTTP_KINDS = new Set(['http-stub', 'http', 'api', 'webhook']);

interface Family {
  name: string;
  words: RegExp;
  kinds: ReadonlySet<string>;
  fallback: { id: string; kind: string };
}

const FAMILIES: readonly Family[] = [
  { name: 'a database', words: /\b(persist\w*|sessions?|stores?|stored|storage|database|db|sqlite|durabl[ey]|save[sd]?)\b/i, kinds: DB_KINDS, fallback: { id: 'db', kind: 'sqlite' } },
  { name: 'a message sender', words: /\b(send|sends|sending|sent|notify|notifies|notifications?|e-?mails?|mail|mails|sms)\b/i, kinds: MESSAGE_KINDS, fallback: { id: 'mail', kind: 'smtp' } },
  { name: 'a git remote', words: /\b(git remote|push(?:es)? to (?:a |the )?remote|mirror(?:s|ed)?)\b/i, kinds: REMOTE_KINDS, fallback: { id: 'remote', kind: 'git-remote' } },
  { name: 'an external HTTP service', words: /\b(webhooks?|external api|third[- ]party api)\b/i, kinds: HTTP_KINDS, fallback: { id: 'api', kind: 'http-stub' } },
];

const wordIn = (text: string, w: string): boolean => {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const x = w.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return x.length > 0 && t.includes(` ${x} `);
};

/**
 * The capabilities `statement` implies, deterministic: every declared connection the statement names (by id or
 * kind), then one per family whose words appear (a declared connection or inventory row of that family's kind
 * if there is one, else the family's default id and kind: `db`/sqlite, `mail`/smtp, `remote`/git-remote,
 * `api`/http-stub). Never throws.
 */
export function impliedNeeds(statement: string, connections: Manifest['connections'] = {}, inventory: readonly CapabilityRecord[] = []): ImpliedNeed[] {
  try {
    const text = typeof statement === 'string' ? statement : '';
    const out: ImpliedNeed[] = [];
    const add = (n: ImpliedNeed) => {
      if (!out.some((x) => x.id === n.id)) out.push(n);
    };
    const conns = Object.entries(connections ?? {});
    for (const [id, c] of conns) if (wordIn(text, id) || wordIn(text, c.kind)) add({ id, kind: c.kind, because: `the request names the ${id} connection` });
    for (const f of FAMILIES) {
      const hit = f.words.exec(text);
      if (!hit) continue;
      const because = `"${hit[0].toLowerCase()}" implies ${f.name}`;
      const conn = conns.find(([, c]) => f.kinds.has(c.kind.toLowerCase()));
      const rec = (Array.isArray(inventory) ? inventory : []).find((r) => f.kinds.has(String(r.kind).toLowerCase()));
      if (conn) add({ id: conn[0], kind: conn[1].kind, because });
      else if (rec) add({ id: rec.id, kind: rec.kind, because });
      else add({ ...f.fallback, because });
    }
    return out;
  } catch {
    return [];
  }
}

/** The family a kind belongs to (for matching a need the model named differently), or the kind itself. */
function familyOf(kind: string): string {
  const k = kind.toLowerCase();
  for (const f of FAMILIES) if (f.kinds.has(k)) return f.name;
  return k;
}

// ---------- commands ----------

/** Programs that only read the repository's text, its file list or its history: they cannot run the behaviour. */
const INSPECT = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'findstr', 'ls', 'test', '[', '[[', 'cat', 'head', 'tail', 'wc', 'find', 'stat', 'file', '!', 'diff', 'cmp', 'git']);
/** Programs that exit the same way whatever the repository holds, or only move around: no check rests on them. */
const NOOP = new Set(['true', ':', 'false', 'echo', 'printf', 'exit', 'sleep', 'cd', 'pwd', 'export', 'set', 'unset', 'which', 'type', 'env', 'printenv', 'trap', 'read', 'local', 'declare', 'readonly', 'shift', 'umask', 'date', 'hostname', 'whoami', 'id', 'uname', 'nproc', 'seq', 'yes', 'hash', 'return']);
/** File and text plumbing: it prepares or passes data along and proves nothing about the behaviour. */
const PLUMBING = new Set(['mkdir', 'rmdir', 'rm', 'cp', 'mv', 'touch', 'ln', 'chmod', 'mktemp', 'dirname', 'basename', 'realpath', 'readlink', 'tee', 'tr', 'cut', 'sed', 'awk', 'sort', 'uniq', 'nl', 'jq', 'tac', 'rev', 'paste', 'column', 'base64', 'sha256sum', 'md5sum', 'du']);
/** Interpreters and the flags whose argument is an inline script. */
const INLINE: Readonly<Record<string, readonly string[]>> = { node: ['-e', '--eval', '-p', '--print'], bun: ['-e', '--eval', '-p', '--print'], deno: ['eval'], python: ['-c'], python3: ['-c'], ruby: ['-e'], perl: ['-e', '-E'], php: ['-r'] };
/** Interpreters whose first operand is a script file they run. */
const SCRIPT_RUNNERS = new Set(['node', 'python', 'python3', 'sh', 'bash', 'tsx', 'ts-node', 'bun', 'deno', 'ruby', 'perl', 'php']);
/** Runner flags that take a separate value (skipped when looking for operands). */
const VALUE_FLAGS = new Set(['--reporter', '--test-reporter', '--test-reporter-destination', '--config', '-c', '--maxWorkers', '-j', '--jobs', '-n', '--timeout', '--workspace', '-w', '-p', '--package', '--features', '--test-concurrency', '--import', '--require', '-r', '--loader', '--input-type', '--cwd', '--prefix', '-C']);
/** Runner flags that select tests by name: a run with one is focused. */
const FILTER_FLAGS = new Set(['-t', '-k', '-g', '-m', '--grep', '--testNamePattern', '--test-name-pattern', '-run', '--run', '--filter', '--spec', '--testPathPattern', '--test-only', '--tests']);
/** Test runner invocations that run the whole suite when nothing after them names a file or a test. */
const RUNNER_HEADS: readonly (readonly string[])[] = [
  ['npm', 'run', 'test'], ['npm', 'test'], ['npm', 't'], ['pnpm', 'run', 'test'], ['pnpm', 'test'], ['yarn', 'run', 'test'], ['yarn', 'test'], ['bun', 'run', 'test'], ['bun', 'test'],
  ['npx', 'vitest', 'run'], ['npx', 'vitest'], ['npx', 'jest'], ['npx', 'mocha'], ['vitest', 'run'], ['vitest'], ['jest'], ['mocha'], ['make', 'test'], ['make', 'check'],
  ['python3', '-m', 'pytest'], ['python', '-m', 'pytest'], ['python3', '-m', 'unittest'], ['python', '-m', 'unittest'], ['pytest'], ['go', 'test'], ['cargo', 'test'],
  ['playwright', 'test'], ['deno', 'test'], ['dotnet', 'test'], ['gradle', 'test'], ['rspec'], ['bundle', 'exec', 'rspec'], ['phpunit'], ['mix', 'test'], ['swift', 'test'],
];
/** Operands that still mean "everything". */
const WHOLE_TREE = new Set(['.', './', './...', '...']);
/** Options that make a runner or an interpreter answer a question, list or skip instead of running: nothing is checked. */
const ASKS = new Set(['--version', '--help', '-h', '--listTests', '--list-tests', '--list', '--collect-only', '--co', '--dry-run', '--no-run', '--if-present', '--passWithNoTests', '--pass-with-no-tests']);
/** The same for make, plus the options that ignore a failing recipe. */
const MAKE_ASKS = new Set(['-n', '--dry-run', '--just-print', '--recon', '-q', '--question', '-p', '--print-data-base', '-i', '--ignore-errors', '--version', '-v', '-h', '--help']);
/** Package-manager options (before the subcommand) that take a separate value. */
const PM_VALUE_FLAGS = new Set(['-w', '--workspace', '--prefix', '--cwd', '-C', '--dir', '--filter', '-F']);

/** A package manager's words with the options before its subcommand removed (`npm --prefix api test` → `npm test`). */
function normalised(w: readonly string[]): readonly string[] {
  const prog = base(w[0]!);
  if (!/^(npm|pnpm|yarn|bun)$/.test(prog)) return w;
  let i = 1;
  while (i < w.length && w[i]!.startsWith('-')) i += !w[i]!.includes('=') && PM_VALUE_FLAGS.has(w[i]!) ? 2 : 1;
  // `yarn workspace api test` runs `test` in one workspace.
  if (prog === 'yarn' && w[i] === 'workspace') i += 2;
  return i === 1 ? w : [w[0]!, ...w.slice(i)];
}

/**
 * Every simple command of `cmd` as the words of the program it really runs: assignments and known prefixes
 * (`timeout 5`, `env -u X`, `nice -n 5`, `npx`, …) stripped, nested shell scripts and command substitutions
 * expanded (shell.ts).
 */
function segments(cmd: string): string[][] {
  return readShell(cmd).segments.map((s) => s.words);
}

/** A repository path for a diagnostic: echoed only when it is a plain relative path. */
const safePath = (p: string): string => (/^[A-Za-z0-9_.@/-]{1,120}$/.test(p) ? p : '<path>');

/** The inline script a segment hands its interpreter (`node -e '…'`), or null. */
function inlineScript(w: readonly string[]): string | null {
  const flags = INLINE[base(w[0]!)];
  if (!flags) return null;
  for (let i = 1; i < w.length; i++) {
    const a = w[i]!;
    for (const f of flags) {
      if (a === f) return w[i + 1] ?? '';
      if (f.startsWith('--') && a.startsWith(`${f}=`)) return a.slice(f.length + 1);
    }
  }
  return null;
}

/** A repository file a script names as a string literal. */
const REACHES_REPO = /["'`]\.{1,2}\/[^"'`\s]+["'`]|["'`](?:[\w@.-]+\/)+[\w.-]+\.(?:m?[jt]sx?|cjs|py|sh|json)["'`]/;
/** A Python import of something other than the standard modules a check uses to drive the code. */
const PY_REPO_IMPORT = /\b(?:from\s+(?!(?:sys|os|json|re|subprocess|pathlib|tempfile|unittest|time)\b)[A-Za-z_][\w.]*\s+import|import\s+(?!(?:sys|os|json|re|subprocess|pathlib|tempfile|unittest|time)\b)[A-Za-z_][\w.]*)/;
/** The script starts another process (which may then run a repository file it names). */
const SPAWNS = /\bchild_process\b|\b(?:spawn|exec|execFile|fork)(?:Sync)?\s*\(|\bsubprocess\b|\bos\s*\.\s*(?:system|popen)\s*\(|\bBun\s*\.\s*spawn|\bDeno\s*\.\s*(?:Command|run)\b/;
/** The script can fail: an assertion, a throw, or an exit with anything but 0. */
const CAN_FAIL = /\bassert\w*\b|\bthrow\b|\braise\b|\bexit\(\s*(?!0?\s*\))|\bexitCode\s*=\s*(?!0\b)/;

type SegmentKind = 'inspect' | 'noop' | 'generic' | 'inert' | 'behaviour' | 'unknown';

/** What follows a test runner invocation (`node --test`, a RUNNER_HEADS entry), or null when `w` is not one. */
function runnerArgs(w: readonly string[]): readonly string[] | null {
  if (base(w[0]!) === 'node' && w.includes('--test')) return w.slice(1).filter((x) => x !== '--test');
  const head = RUNNER_HEADS.find((h) => h.length <= w.length && h.every((x, i) => (i === 0 ? base(w[0]!) === x : w[i] === x)));
  return head ? w.slice(head.length) : null;
}

/** A runner's positional operands (files, packages, name filters): its options and their values left out. */
function runnerOperands(rest: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--') continue;
    if (a.startsWith('-')) {
      if (!a.includes('=') && (VALUE_FLAGS.has(a) || FILTER_FLAGS.has(a))) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** True when the segment is a test runner with no operand or option that narrows it to particular tests. */
function bareRunner(w: readonly string[]): boolean {
  const rest = runnerArgs(w);
  if (!rest) return false;
  if (rest.some((a) => a.startsWith('-') && FILTER_FLAGS.has(a.includes('=') ? a.slice(0, a.indexOf('=')) : a))) return false;
  return runnerOperands(rest).every((a) => WHOLE_TREE.has(a));
}

/** The files a script runner is handed to run: its first operand, or every operand of `node --test`. */
function scriptOperands(w: readonly string[]): string[] {
  const prog = base(w[0]!);
  if (!SCRIPT_RUNNERS.has(prog) || (prog.startsWith('python') && w.includes('-m'))) return [];
  const all = prog === 'node' && w.includes('--test');
  const out: string[] = [];
  const args = w.slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--test' || a === '--') continue;
    if (a.startsWith('-')) {
      if (!a.includes('=') && VALUE_FLAGS.has(a)) i++;
      continue;
    }
    if ((prog === 'deno' || prog === 'bun') && (a === 'run' || a === 'test')) continue;
    out.push(a);
    if (!all) break;
  }
  return out;
}

/** True when an interpreter is only asked for its version or help: an option of its own, before any script. */
function interpreterAsks(w: readonly string[]): boolean {
  const inline = INLINE[base(w[0]!)] ?? [];
  for (let i = 1; i < w.length; i++) {
    const a = w[i]!;
    if (a === '--version' || a === '-v' || a === '-V' || a === '--help' || a === '-h') return true;
    if (!a.startsWith('-') || inline.includes(a)) return false;
    if (!a.includes('=') && VALUE_FLAGS.has(a)) i++;
  }
  return false;
}

/**
 * Whether an inline script reaches the repository's code: it imports or requires a relative module, or starts
 * a process and names a repository file. A path it only reads (`readFileSync("./src/app.js")`) is a text
 * search, not a run.
 */
function scriptReaches(prog: string, script: string): boolean {
  if (/^(node|bun|deno)$/.test(prog)) return specifiersOf(script).some((x) => x.startsWith('./') || x.startsWith('../')) || (SPAWNS.test(script) && REACHES_REPO.test(script));
  if (prog.startsWith('python')) return PY_REPO_IMPORT.test(script) || (SPAWNS.test(script) && REACHES_REPO.test(script));
  return REACHES_REPO.test(script);
}

/** True when an operand points outside the repository or is not known until the shell runs (`/dev/null`, `~/x`, `../x`, `$F`). */
const foreign = (p: string): boolean => /^(?:\/|~|\.\.(?:\/|$))/.test(p) || /[$`]/.test(p);
/** True when the program word is a file of the repository (`./check.sh`, `bin/report.js`), not a program on the path or an installed package's. */
const repositoryFile = (p: string): boolean => p.includes('/') && !foreign(p) && !/[*?]/.test(p) && !/(?:^|\/)node_modules\//.test(p);

/**
 * What one simple command is to a check. Only what the host recognises counts as running the behaviour: an
 * inline script that reaches the repository and can fail, a test runner, an interpreter handed a script file,
 * a package script (`npm run <name>`), a make target, or a file of the repository run directly. A program the
 * host does not know is 'unknown', never 'behaviour': `foo --flag` is no evidence that anything was checked.
 */
function segmentKind(words: readonly string[]): SegmentKind {
  const w = normalised(words);
  const prog = base(w[0]!);
  // `find … -exec prog` runs a program the screens below never see.
  if (prog === 'find' && w.some((a) => /^-(?:exec|execdir|ok|okdir)$/.test(a))) return 'unknown';
  if (INSPECT.has(prog)) return 'inspect';
  if (NOOP.has(prog) || PLUMBING.has(prog) || JOB_CONTROL.has(prog) || NETWORK_PROGRAMS.has(prog)) return 'noop';
  if ((INLINE[prog] || SCRIPT_RUNNERS.has(prog)) && interpreterAsks(w)) return 'noop';
  const script = inlineScript(w);
  if (script !== null) return scriptReaches(prog, script) && CAN_FAIL.test(script) ? 'behaviour' : 'inert';
  const pm = /^(npm|pnpm|yarn|bun)$/.test(prog);
  // `npm --version test`, `npm -v`: an option before the subcommand that answers instead of running.
  if (pm && words.slice(1, words.length - w.length + 1).some((a) => a === '-v' || ASKS.has(a))) return 'noop';
  if (prog === 'make') {
    if (w.some((a) => MAKE_ASKS.has(a))) return 'noop';
    // A makefile given on the command line is not the repository's.
    if (w.some((a) => /^(?:-f|--file|--makefile|--eval)/.test(a))) return 'unknown';
  }
  const runner = runnerArgs(w);
  if (runner) {
    if (words.some((a) => ASKS.has(a))) return 'noop';
    if (runnerOperands(runner).some(foreign)) return 'unknown';
    return bareRunner(w) ? 'generic' : 'behaviour';
  }
  if (SCRIPT_RUNNERS.has(prog)) {
    // `node --check file` only parses it.
    if (prog === 'node' && (w.includes('--check') || w.includes('-c'))) return 'inspect';
    const files = scriptOperands(w);
    if (files.length) return files.some(foreign) ? 'unknown' : 'behaviour';
    return prog.startsWith('python') && w.includes('-m') ? 'unknown' : 'noop';
  }
  if (pm && (w[1] === 'run' || w[1] === 'run-script')) return w[2] && !w[2].startsWith('-') && !words.some((a) => ASKS.has(a)) ? 'behaviour' : 'noop';
  if (prog === 'make') return w.slice(1).some((a) => !a.startsWith('-') && !a.includes('=')) ? 'behaviour' : 'unknown';
  return repositoryFile(words[0]!) ? 'behaviour' : 'unknown';
}

/** The kinds of the simple commands that make up the line itself (a command substitution only feeds a word). */
function kindsOf(cmd: string): SegmentKind[] {
  return readShell(cmd)
    .segments.filter((x) => !x.substituted)
    .map((x) => segmentKind(x.words));
}

/**
 * How much a criterion command can tell about the work (a coarse screen; the requestor's sign-off stays the
 * authority on what each criterion checks):
 * - 'inspect': it only searches the repository text or checks that files exist (grep/rg/ls/test -f/cat …,
 *   `git grep`, through shell wrappers and pipes);
 * - 'generic': it runs the repository's whole test command (`verify`) or a test runner nothing narrows to
 *   particular tests (no file, no test-name filter; options like `--runInBand` or `-q` do not narrow);
 * - 'inert': nothing in it can fail on the behaviour (echo, true, `node --version`, an inline script that does
 *   not import or run the repository's code, or one with no assertion, throw or non-zero exit), or nothing in
 *   it is a program the host recognises as a check (commandUnknownPrograms);
 * - 'focused': some part of it runs the repository's code in a way that can fail.
 * Known prefixes and nested shells are read through first (`timeout 5 true` is `true`).
 */
export type CommandFocus = 'inspect' | 'generic' | 'inert' | 'focused';

export function commandFocus(cmd: string, verify?: string): CommandFocus {
  try {
    const c = String(cmd).trim().replace(/\s+/g, ' ');
    const v = verify?.trim().replace(/\s+/g, ' ');
    if (v && (c === v || (c.startsWith(`${v} `) && c.slice(v.length + 1).split(' ').every((a) => a.startsWith('-'))))) return 'generic';
    const kinds = kindsOf(c);
    if (!kinds.length) return 'inert';
    if (kinds.includes('behaviour')) return 'focused';
    if (kinds.every((k) => k === 'inspect')) return 'inspect';
    if (kinds.includes('generic')) return 'generic';
    return 'inert';
  } catch {
    return 'inert';
  }
}

/** True when `cmd` only searches the repository text or checks that files exist (see commandFocus). */
export function commandOnlyInspectsText(cmd: string): boolean {
  try {
    const kinds = kindsOf(String(cmd));
    return kinds.length > 0 && kinds.every((k) => k === 'inspect');
  } catch {
    return false;
  }
}

/**
 * Programs `cmd` runs that the host knows neither as a way to run a check nor as shell plumbing (in order,
 * unique): a prefix it cannot read through (`sudo …`, `chronic …`), a tool it has no rule for, a program named
 * by a variable. Whatever follows such a word is screened by nothing, so a drafted criterion may not carry one.
 */
export function commandUnknownPrograms(cmd: string): string[] {
  try {
    const out = new Set<string>();
    for (const x of readShell(String(cmd)).segments) if (segmentKind(x.words) === 'unknown') out.add(base(x.words[0]!));
    return [...out];
  } catch {
    return ['<unreadable>'];
  }
}

/**
 * Why the exit status of `cmd` is not the check's own (empty when it is). The verify gate runs the line in a
 * plain shell (no errexit, no pipefail) and takes its exit status, so the status is the check's only when
 * every command that can fail reaches it: one command, or commands joined with `&&`. Reported:
 * - a `||` fallback (`check || echo failed`, `check && echo PASS || echo FAIL`, `check || true`);
 * - a command that is not shell plumbing in a place whose status is dropped: before a `|` (`check | tail`,
 *   `check | tee log`, `check | grep -q pass`), before a `;` or a newline (`check; echo done`), or inside a
 *   command substitution (`echo $(check)`). Plumbing there is fine (`cd pkg; check`, `cat in.json | check`);
 * - a `!` negation, `exit`, `trap`, `set +e`;
 * - control flow (`if`, `for`, `while`) and syntax the host cannot read (a function, `case`, an unclosed
 *   quote): whose status the line ends with cannot be told.
 * All of it is read through known prefixes, subshells, brace groups and nested shells (`sh -c '…'`). A
 * background job (`&`) is reported by commandSandboxProblems. Never throws.
 */
export function commandStatusProblems(cmd: string): string[] {
  const out = new Set<string>();
  try {
    const read = readShell(String(cmd));
    if (read.marks.has('unreadable')) out.add('has shell syntax the host cannot read');
    if (read.marks.has('control')) out.add('uses shell control flow');
    if (read.marks.has('or')) out.add('falls back with ||');
    if (read.marks.has('negation')) out.add('negates with !');
    for (const x of read.segments) {
      const prog = base(x.words[0]!);
      const kind = segmentKind(x.words);
      if (x.dropped && !x.background && kind !== 'inspect' && kind !== 'noop') out.add(`drops the exit status of ${safeSegment(prog)} (${x.substituted ? 'inside $(…)' : 'before | or ;'})`);
      if (prog === 'exit') out.add('calls exit');
      if (prog === 'trap') out.add('sets a trap');
      if (prog === 'set' && x.words.some((a, i) => i > 0 && (/^\+[A-Za-z]*e/.test(a) || (a === '+o' && x.words[i + 1] === 'errexit')))) out.add('turns errexit off');
    }
  } catch {
    out.add('cannot be read');
  }
  return [...out];
}

/** True when `cmd` runs only the repository's whole test command (`verify`) or a bare test runner. */
export function commandIsGeneric(cmd: string, verify?: string): boolean {
  return commandFocus(cmd, verify) === 'generic';
}

/** Script files an inline script names as string literals outside its import specifiers (what it spawns or runs). */
const SCRIPT_LITERAL = /["'`]((?:\.\/)?(?:[\w@.-]+\/)+[\w.-]+\.(?:m?[jt]sx?|cjs|py|sh))["'`]/g;
/** Module specifiers an inline script imports: static and dynamic import, export … from, require. */
const SPECIFIER = /\b(?:import|export)\s[^"'`;]*?\bfrom\s*["'`]([^"'`]+)["'`]|\bimport\s*["'`]([^"'`]+)["'`]|\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)|\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

/** The module specifiers a JavaScript inline script imports, in order, unique. */
function specifiersOf(script: string): string[] {
  const out = new Set<string>();
  for (const m of script.matchAll(SPECIFIER)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (spec) out.add(spec);
  }
  return [...out];
}

/** Repository files an inline script spawns or runs (script-file literals that are not import specifiers). */
function spawnedFiles(script: string): string[] {
  const imported = new Set(specifiersOf(script));
  const out: string[] = [];
  for (const m of script.matchAll(SCRIPT_LITERAL)) if (!imported.has(m[1]!)) out.push(m[1]!);
  return out;
}

/** What the inline scripts of `cmd` import: repository modules (relative, normalised) and packages (bare names). */
export function commandImports(cmd: string): { modules: string[]; packages: string[] } {
  const modules = new Set<string>();
  const packages = new Set<string>();
  try {
    for (const w of segments(String(cmd))) {
      const script = inlineScript(w);
      if (script === null || !base(w[0]!).match(/^(node|bun|deno)$/)) continue;
      for (const spec of specifiersOf(script)) {
        if (spec.startsWith('./') || spec.startsWith('../')) {
          const n = spec.replace(/^(\.\/)+/, '');
          if (!n.startsWith('..')) modules.add(n);
        } else if (!spec.startsWith('/') && !spec.includes('://')) packages.add(spec);
      }
    }
  } catch {
    // A command that cannot be read imports nothing we can name.
  }
  return { modules: [...modules], packages: [...packages] };
}

/** The package a bare specifier names (`csv-parse/sync` → `csv-parse`, `@a/b/c` → `@a/b`). */
export function packageOf(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

/** True when a bare specifier needs nothing installed: a Node built-in (`node:sqlite`, `assert`). */
export function isNodeBuiltin(spec: string): boolean {
  try {
    return isBuiltin(spec);
  } catch {
    return false;
  }
}

/**
 * Repository files `cmd` runs directly: a script handed to an interpreter, the files `node --test` runs, a
 * `./tool`, and the script files an inline script spawns (`spawnSync("node", ["bin/cli.js"])`). A worker may
 * never write a file a criterion runs (policy contractTamper), so each must exist before the work starts.
 * Globs, absolute paths and the modules an inline script imports (commandImports) are left out.
 */
export function commandRunsFiles(cmd: string): string[] {
  const out = new Set<string>();
  const add = (p: string) => {
    if (!p || p.startsWith('-') || p.startsWith('/') || p.startsWith('$') || p.includes('://') || /[*?{}]/.test(p) || WHOLE_TREE.has(p)) return;
    const n = p.replace(/^\.\//, '').replace(/\/+$/, '');
    if (n && !n.startsWith('..')) out.add(n);
  };
  try {
    for (const w of segments(String(cmd))) {
      if (w[0]!.includes('/')) add(w[0]!);
      const script = inlineScript(w);
      if (script !== null) {
        for (const f of spawnedFiles(script)) add(f);
        continue;
      }
      for (const f of scriptOperands(w)) add(f);
    }
  } catch {
    // A command that cannot be read names no file.
  }
  return [...out];
}

// ---------- what the verify sandbox cannot run ----------

/** True when a shell line puts a command in the background: a lone `&` outside quotes (not `&&`, `>&`, `&>`, `|&`). */
function runsInBackground(line: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '&') {
      if (line[i + 1] === '&') i++;
      else if (line[i - 1] !== '>' && line[i - 1] !== '<' && line[i - 1] !== '|' && line[i + 1] !== '>') return true;
    }
  }
  return false;
}

/** Programs that wait for or signal other jobs: the exit status is theirs, not the check's. */
const JOB_CONTROL = new Set(['sleep', 'kill', 'pkill', 'killall', 'wait', 'nohup', 'disown', 'setsid', 'bg', 'fg', 'jobs']);
/** Programs that only reach the network. */
const NETWORK_PROGRAMS = new Set(['curl', 'wget', 'nc', 'ncat', 'netcat', 'telnet', 'ssh', 'scp', 'ping', 'http', 'https']);
/** A network client in a script: usable only against a capability the criterion requires. */
const NETWORK_CLIENT: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bfetch\s*\(|\bglobalThis\s*(?:\.\s*|\[\s*["'`])fetch\b|=\s*fetch\s*[;,)]/, 'calls fetch()'],
  [/\bhttps?\s*\.\s*(?:request|get)\s*\(/, 'calls http.request'],
  [/\b(?:XMLHttpRequest|WebSocket|EventSource)\b/, 'uses a network client'],
  [/\b(?:urllib|http\.client|socket\.socket)\b|\brequests\s*\.\s*(?:get|post|put|delete|request)\s*\(/, 'uses a network client'],
];
/** A server started, or a loopback address or port named as one: nothing in the sandbox answers it. */
const NETWORK_LOCAL: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bcreateServer\s*\(|\.\s*listen\s*\(|\b(?:Bun|Deno)\s*\.\s*serve\s*\(/, 'starts a server'],
  [/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`](?:node:)?(?:http|https|http2|net|dgram|tls)["'`]/, 'imports a network module'],
  [/(?:\/\/|@)(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])|\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\s*:\s*[\d$]|\bhost(?:name)?\s*[:=]\s*["'`]?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b/, 'names a loopback address'],
  [/(?:^|\s)PORT=|--port\b|\bport\s*[:=]\s*\d/i, 'names a port'],
];
/** Waiting inside a script: a timer of a second or more, a spawned sleep, a process left running. */
const TIMER_CALL = /\bset(?:Timeout|Interval)\b([^;]*)/g;
/** A delay as a timer's last argument: a number, a named constant, or their product or sum (`61 * 1000`, `WINDOW_MS`). */
const DELAY_LAST = /,\s*([\w.$ \t*+]+?)\s*\)/g;
/** Another name for the promise timer (`import { setTimeout as sleep } from "node:timers/promises"`, `{ setTimeout: sleep }`). */
const TIMER_ALIAS = /\bset(?:Timeout|Interval)\s*(?:\bas\b|:)\s*([A-Za-z_$][\w$]*)/g;
const SCRIPT_WAITS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bdetached\s*:\s*true\b/, 'detaches a process'],
  [/["'`]\s*sleep(?:\s+[\d.]|["'`])|\bAtomics\s*\.\s*wait\s*\(/, 'uses sleep'],
];

/**
 * The milliseconds a delay expression names, NaN when the host cannot tell: numeric literals (`61000`,
 * `61_000`, `61e3`), constants the script sets to one (`const WINDOW = 61 * 1000`), and their products and sums.
 */
function delayMs(expr: string, text: string, depth = 0): number {
  const factor = (f: string): number => {
    const x = f.trim();
    const n = x.replace(/_/g, '');
    if (/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(n)) return Number(n);
    if (depth > 2 || !/^[A-Za-z_$][\w$]*$/.test(x)) return NaN;
    const set = new RegExp(`\\b(?:const|let|var)\\s+${esc(x)}\\s*=\\s*([\\w.$ \\t*+]+?)\\s*(?:[;,\\n]|$)`).exec(text);
    return set ? delayMs(set[1]!, text, depth + 1) : NaN;
  };
  return expr.split('+').reduce((sum, term) => sum + term.split('*').reduce((product, f) => product * factor(f), 1), 0);
}

/** True when `text` waits on a timer of a second or more (`setTimeout(r, 61000)`, `setTimeout(r, 61 * 1000)`, `await sleep(WINDOW)`). */
function waitsOnTimer(text: string): boolean {
  for (const m of text.matchAll(TIMER_CALL)) for (const d of m[1]!.matchAll(DELAY_LAST)) if (delayMs(d[1]!, text) >= 1000) return true;
  // The promise form takes the delay first: setTimeout(1000), or the same under another name.
  const names = ['setTimeout', 'scheduler\\s*\\.\\s*wait', ...[...text.matchAll(TIMER_ALIAS)].map((m) => esc(m[1]!))];
  for (const m of text.matchAll(new RegExp(`(?<![\\w$.])(?:${names.join('|')})\\s*\\(\\s*([\\w.$ \\t*+]+?)\\s*[,)]`, 'g'))) if (delayMs(m[1]!, text) >= 1000) return true;
  return false;
}

/**
 * What in `cmd` the verify sandbox cannot run or what makes its exit status someone else's (empty when
 * nothing): a background job, sleep/kill/wait, a timer of a second or more, a detached process, a network
 * program, a server, a loopback address or port, a network client. `reachesHttp` is true when the criterion
 * requires an HTTP capability and reads its location from the environment: its client calls are then the
 * point of the check, a URL written into the command is still reported (it is not the capability's), and so
 * is the rest. A loopback address passed as plain data (`{ ip: "127.0.0.1" }`) is not an address anything
 * connects to and is left alone. Never throws.
 */
export function commandSandboxProblems(cmd: string, reachesHttp = false): string[] {
  const out = new Set<string>();
  try {
    const line = String(cmd);
    const read = readShell(line);
    if (read.marks.has('background') || read.texts.some(runsInBackground)) out.add('backgrounds a command (&)');
    // A prefix the reader strips is a program too (`nohup node …`, `timeout 70 sleep 61`).
    for (const prog of [...read.segments.map((x) => base(x.words[0]!)), ...read.wrappers]) {
      if (JOB_CONTROL.has(prog)) out.add(`uses ${prog}`);
      if (NETWORK_PROGRAMS.has(prog)) out.add(`runs ${prog}`);
    }
    if (waitsOnTimer(line)) out.add('waits on a timer');
    for (const [re, what] of SCRIPT_WAITS) if (re.test(line)) out.add(what);
    for (const [re, what] of NETWORK_LOCAL) if (re.test(line)) out.add(what);
    const clients = NETWORK_CLIENT.filter(([re]) => re.test(line)).map(([, what]) => what);
    if (!reachesHttp) for (const what of clients) out.add(what);
    else if (clients.length && /\bhttps?:\/\/[A-Za-z0-9[]/.test(line)) out.add("reaches an address that is not the capability's");
  } catch {
    out.add('cannot be read');
  }
  return [...out];
}

/** Interpreter options that are not a script to run. */
const NO_SCRIPT = new Set(['--test', '--version', '-v', '--help', '-h', '--check', '-m']);

/**
 * True when `cmd` hands an interpreter its script on standard input: a here-document or here-string, or
 * node/bun/deno/python with no `-e` script and no file to run (`echo '…' | node --input-type=module`, `node -`).
 * The host reads only the scripts a command carries after `-e`, so such a script is screened by nothing.
 */
export function commandReadsScriptFromStdin(cmd: string): boolean {
  try {
    const hereDoc = (line: string): boolean => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i]!;
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === "'" || c === '"') quote = c;
        else if (c === '<' && line[i + 1] === '<') return true;
      }
      return false;
    };
    const read = readShell(String(cmd));
    if (read.texts.some(hereDoc)) return true;
    for (const { words: w } of read.segments) {
      if (!INLINE[base(w[0]!)] || inlineScript(w) !== null || w.some((a) => NO_SCRIPT.has(a))) continue;
      let operand: string | null = null;
      for (let i = 1; i < w.length && operand === null; i++) {
        const a = w[i]!;
        if (a === '-' || a === '/dev/stdin') return true;
        if (!a.startsWith('-')) operand = a;
        else if (!a.includes('=') && VALUE_FLAGS.has(a)) i++;
      }
      if (operand === null) return true;
    }
    return false;
  } catch {
    return true;
  }
}

// ---------- the existing tested API ----------

const KIND_NAMES: Readonly<Record<ArgKind, string>> = { object: 'an object', array: 'an array', string: 'a string', number: 'a number', boolean: 'a boolean', function: 'a function', nullish: 'undefined', instance: 'a class instance', unknown: 'a value' };
const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NEGATION = /\b(?:do not|don't|dont|never|without|must not|should not|shall not|cannot|can't|no|not)\b/i;

/**
 * True when the request says outright that the inputs of function `name` change: "change signup to accept …",
 * "signup now takes …", "change the arguments of signup", "rename signup", "replace signup". The function's
 * name next to an unrelated change word ("send an email on signup instead of nothing"), or the phrase under a
 * negation ("do not change what signup accepts"), does not count.
 */
export function asksToChange(statement: string, name: string): boolean {
  try {
    const fn = `\`?${esc(name)}(?:\\(\\))?\`?`;
    const asks = [
      new RegExp(`\\b(?:chang|modif|alter|rework|redefin|updat|refactor|extend|mak|let|allow|hav)\\w*\\s+(?:the\\s+)?(?:function\\s+)?${fn}\\s+(?:(?:so|that|it|to|should|must|now|will|can)\\s+)*(?:accept|tak|receiv)\\w*`, 'i'),
      new RegExp(`(?<![\\w$.])${fn}\\s+(?:(?:should|must|now|will|shall|can|has to|is to)\\s+)*(?:accepts?|takes?|receives?)\\b`, 'i'),
      new RegExp(`\\b(?:chang|modif|alter|replac|rework|updat|new|different)\\w*\\s+(?:the\\s+)?(?:call\\s+)?(?:signature|arguments?|parameters?|call shape)\\s+(?:of|for|to)\\s+(?:the\\s+)?(?:function\\s+)?${fn}(?![\\w$])`, 'i'),
      new RegExp(`\\b(?:renam|replac)\\w*\\s+(?:the\\s+)?(?:function\\s+)?${fn}(?![\\w$])`, 'i'),
    ];
    for (const sentence of String(statement).split(/(?<=[.!?;])\s+|\n+/)) {
      for (const re of asks) {
        const m = re.exec(sentence);
        if (m && !NEGATION.test(sentence.slice(0, m.index))) return true;
      }
    }
  } catch {
    // An unreadable statement asks for nothing.
  }
  return false;
}

/**
 * How a call with `args` differs from how the existing code is called (null when it fits): fewer arguments
 * than the tests ever pass and the declaration requires, or an argument whose kind is neither one the tests
 * pass in that position nor the one the module declares. An unknown kind fits anything; an added trailing
 * argument fits (new behaviour behind what exists). When the host read no declaration and the tests only ever
 * call the function with no arguments, a first argument that is plainly not an object does not fit: options
 * are the one addition that leaves the tested call working.
 */
export function callShapeConflict(args: readonly ArgKind[], tested: Pick<TestedCall, 'signatures' | 'params'>): string | null {
  const sigs = tested.signatures ?? [];
  const params = tested.params;
  if (!sigs.length && !params) return null;
  const required = params ? (params.findIndex((p) => p.optional || p.rest) < 0 ? params.length : params.findIndex((p) => p.optional || p.rest)) : Infinity;
  const least = Math.min(required, ...sigs.map((s) => s.length));
  if (args.length < least) return `${args.length} argument${args.length === 1 ? '' : 's'}, the existing code is always given at least ${least}`;
  const first = args[0];
  if (!params && sigs.every((x) => x.length === 0) && first && first !== 'unknown' && first !== 'nullish' && first !== 'object') return `argument 1 is ${KIND_NAMES[first]}, the existing tests call it with no arguments (only an options object can be added)`;
  for (let i = 0; i < args.length; i++) {
    const actual = args[i]!;
    if (actual === 'unknown' || actual === 'nullish') continue;
    const expected = new Set<ArgKind>();
    for (const s of sigs) if (s[i] && s[i] !== 'unknown' && s[i] !== 'nullish') expected.add(s[i]!);
    const declared = params?.[i];
    if (declared && !declared.rest && declared.kind !== 'unknown' && declared.kind !== 'nullish') expected.add(declared.kind);
    if (expected.size && !expected.has(actual)) return `argument ${i + 1} is ${KIND_NAMES[actual]}, the existing code takes ${[...expected].map((k) => KIND_NAMES[k]).join(' or ')}`;
  }
  return null;
}

/** The existing call shape of a tested name in `module`, for a diagnostic: the declaration when the host read it, and how the tests call it. */
function existingShape(t: TestedCall, module: string): string {
  const used = t.signatures.slice(0, 2).map((s) => renderCall(t.name, s)).join(', ');
  if (!t.params) return `${used} in ${safePath(module)}`;
  return `${renderDeclared(t.name, t.params)} in ${safePath(module)}${used ? ` (tests call ${used})` : ''}`;
}

/**
 * Why a criterion's inline script contradicts the API the repository's tests already use (see the module
 * comment). Needs the tested API; the new-module check also needs the repository view.
 */
function apiIssues(k: Criterion, c: QualityContext): string[] {
  if (k.check.kind !== 'command' || !c.testedApi?.length) return [];
  const out: string[] = [];
  const api: readonly TestedModule[] = c.testedApi;
  for (const w of segments(k.check.command)) {
    const script = inlineScript(w);
    if (script === null || !/^(node|bun|deno)$/.test(base(w[0]!))) continue;
    const resolve = resolveFrom('inline.mjs');
    const uses = nameUses(script, resolve);
    // A tested module the script imports with no name the host can follow: its calls cannot be compared.
    for (const spec of specifiersOf(script)) {
      const module = spec.startsWith('./') || spec.startsWith('../') ? resolve(spec) : null;
      const own = module ? api.find((t) => t.module === module) : undefined;
      if (own?.calls.length && !uses.some((u) => u.module === module)) out.push(`criterion ${safeSegment(k.id)} imports ${safePath(own.module)} in a form the host cannot read the calls from; import the names it calls (import { ${safeSegment(own.calls[0]!.name)} } from "./${safePath(own.module)}") and call them directly`);
    }
    for (const u of uses) {
      if (u.name === 'default') continue;
      const own = api.find((t) => t.module === u.module);
      if (!own) {
        const holder = api.find((t) => t.names.includes(u.name));
        if (holder && c.fileExists && !exists(c.fileExists, u.module)) out.push(`criterion ${safeSegment(k.id)} imports ${safeSegment(u.name)} from ${safePath(u.module)}, a module the repository does not hold, but ${safePath(holder.module)} already exports ${safeSegment(u.name)} (used by ${holder.tests.slice(0, 2).map(safePath).join(', ')}); extend the existing function instead of defining a second one`);
        continue;
      }
      const tested = own.calls.find((t) => t.name === u.name);
      if (!tested || asksToChange(c.statement, u.name)) continue;
      // Kept short: diagnostics are bounded, and the existing shape is the part the repair round needs.
      const bad = u.calls.map((args) => ({ args, why: callShapeConflict(args, tested) })).find((x) => x.why);
      if (bad) {
        out.push(`criterion ${safeSegment(k.id)} calls ${renderCall(safeSegment(u.name), bad.args)}: ${bad.why}. Existing: ${existingShape(tested, own.module)}. Keep that call shape; add an option or a new function instead`);
        continue;
      }
      // Only methods the tests never call on the result: the returned object was replaced, not extended.
      if (tested.methods.length && u.methods.length && !u.methods.some((m) => tested.methods.includes(m))) {
        const dot = (ms: readonly string[]) => ms.slice(0, 4).map((m) => `.${safeSegment(m)}()`).join(', ');
        out.push(`criterion ${safeSegment(k.id)} calls only ${dot(u.methods)} on what ${safeSegment(u.name)} returns; the existing tests call ${dot(tested.methods)} (${safePath(own.module)}). Keep those methods working and check the behaviour through them; add a method, never replace them`);
      }
    }
  }
  return out;
}

/** A negative clause that only forbids breaking what exists: the existing suite (or a focused check) covers it. */
const PRESERVE = /\b(?:chang\w*|break\w*|alter\w*|modif\w*|touch\w*|remov\w*|renam\w*|regress\w*|dependenc\w*|existing|unchanged|backward\w*)\b/i;
const NEGATIVE = /^(?:do not|don't|dont|never|without|no|must not|should not)\b/i;

/** Behaviours the statement names, split by what can check them. */
export interface BehaviourShape {
  /** Behaviours (and prohibitions) only a focused criterion checks. */
  focused: number;
  /** Negative constraints on breaking what exists ("do not change the API"): the existing suite may cover them. */
  preserve: number;
}

/**
 * The statement's clauses (sentences split on "and", "then", "plus" and ";", two words at least). A clause of a
 * sentence starting "do not"/"never"/"without"/"no" is a prohibition ("Do not expose stack traces": focused)
 * unless it only forbids breaking what exists (preserve).
 */
export function statementBehaviourShape(statement: string): BehaviourShape {
  let focused = 0;
  let preserve = 0;
  const sentences = String(statement)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of sentences) {
    const clauses = s.split(/\s*(?:;|\band\b|\bthen\b|\bplus\b)\s*/i).filter((p) => p.split(/\s+/).filter(Boolean).length >= 2);
    if (!NEGATIVE.test(s)) focused += clauses.length;
    else for (const cl of clauses) PRESERVE.test(cl) ? preserve++ : focused++;
  }
  return focused + preserve === 0 ? { focused: 1, preserve: 0 } : { focused, preserve };
}

/** How many behaviours the statement names (see statementBehaviourShape). */
export function statementBehaviours(statement: string): number {
  const b = statementBehaviourShape(statement);
  return b.focused + b.preserve;
}

export interface QualityContext {
  statement: string;
  goal: AchievementGoal;
  /** The repository's own test command (manifest verify.command): generic on its own. */
  verifyCommand?: string;
  connections?: Manifest['connections'];
  inventory?: readonly CapabilityRecord[];
  /** Whether a repository-relative file exists now (read-only). Absent: files a criterion runs are not checked. */
  fileExists?: (path: string) => boolean;
  /** Package names the repository's package.json lists. Absent: imported packages are not checked. */
  dependencies?: readonly string[];
  /** The API the repository's tests use (repoFacts testedApiOf). Absent: call shapes are not checked. */
  testedApi?: readonly TestedModule[];
}

/** Whether `p` exists in the repository view; a throwing view counts as absent. */
function exists(view: (path: string) => boolean, p: string): boolean {
  try {
    return view(p) === true;
  } catch {
    return false;
  }
}

/**
 * Why a drafted contract proves too little about the request (empty when it is concrete enough). See the
 * module comment. Never throws.
 */
export function contractQualityIssues(draft: ContractDraft, c: QualityContext): string[] {
  try {
    const issues: string[] = [];
    const criteria = draft.contract.criteria;
    const agreed = new Set((c.goal.criteria ?? []).map((k) => k.id));
    const focusedOf = new Map<string, Criterion>();
    const distinct = new Set<string>();
    let generic = 0;
    const kinds = new Map(draft.needs.map((n) => [n.id, n.kind]));
    const httpKind = (id: string) => HTTP_KINDS.has(String(kinds.get(id) ?? c.connections?.[id]?.kind ?? c.inventory?.find((r) => r.id === id)?.kind ?? '').toLowerCase());
    for (const k of criteria) {
      if (k.check.kind !== 'command') continue;
      const own = !agreed.has(k.id);
      if (own) {
        // The client calls are the check only when the criterion reads the capability's location from the environment.
        const reads = (id: string) => k.check.kind === 'command' && k.check.command.includes(`TECERA_RESOURCE_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`);
        const cannot = commandSandboxProblems(k.check.command, (k.requires ?? []).some((id) => httpKind(id) && reads(id)));
        if (cannot.length) issues.push(`criterion ${safeSegment(k.id)} ${cannot.slice(0, 6).join(', ')}: the verify sandbox has no network and no background jobs; import the code and call it in-process, as the existing tests do (fake the time instead of waiting)`);
      }
      if (own) {
        const masked = commandStatusProblems(k.check.command);
        if (masked.length) issues.push(`criterion ${safeSegment(k.id)} ${masked.slice(0, 3).join(', ')}: its exit status must be the check's own. Write one check (an inline node assertion, or node --test <file>), setup joined with && only: no |, ||, ;, !, exit or trap`);
      }
      const unknown = own ? commandUnknownPrograms(k.check.command) : [];
      if (unknown.length) issues.push(`criterion ${safeSegment(k.id)} runs ${unknown.slice(0, 3).map(safeSegment).join(', ')} in a form the host does not know as a check; run the behaviour with an inline node assertion (node -e), a test runner on a test file or a repository script (it reads through env, timeout, nice, time and sh -c)`);
      if (own && commandReadsScriptFromStdin(k.check.command)) issues.push(`criterion ${safeSegment(k.id)} hands an interpreter its script on standard input (a pipe or a here-document); pass the script with -e (node --input-type=module -e '…') so the host can read what it calls`);
      const focus = commandFocus(k.check.command, c.verifyCommand);
      if (focus === 'inspect') {
        if (own) issues.push(`criterion ${safeSegment(k.id)} only searches the repository text or checks that a file exists; run the behaviour instead (an inline node assertion that imports the code and calls it, or a focused test) so it fails before the change and passes after`);
        continue;
      }
      if (focus === 'inert') {
        if (own && !unknown.length) issues.push(`criterion ${safeSegment(k.id)} runs nothing that can fail on the behaviour; an inline script must import or run the repository's code and assert (assert, throw or a non-zero exit)`);
        continue;
      }
      if (own && c.fileExists) {
        for (const f of commandRunsFiles(k.check.command)) {
          if (!exists(c.fileExists, f)) issues.push(`criterion ${safeSegment(k.id)} runs ${safePath(f)}, which is not in the repository; a worker may never write a file a criterion runs, so check new code through an inline assertion that imports it or an existing test`);
        }
      }
      if (own) issues.push(...importIssues(k, c), ...apiIssues(k, c));
      if (focus === 'generic') {
        generic++;
        continue;
      }
      focusedOf.set(k.id, k);
      distinct.add(k.check.command.trim().replace(/\s+/g, ' '));
    }
    const shape = statementBehaviourShape(c.statement);
    if (distinct.size === 0) {
      issues.push('the contract has only generic criteria (the whole test suite, a text search or a human judgment); add one focused, behavioural command criterion per behaviour the request names');
    } else {
      // A duplicated command checks one behaviour, however many criteria carry it.
      const want = shape.focused + (generic > 0 ? 0 : shape.preserve);
      if (distinct.size < want) issues.push(`the request names ${shape.focused + shape.preserve} behaviours but the contract has ${distinct.size} distinct focused command criteria${shape.preserve && !generic ? ' and none runs the existing suite' : ''}; add one per behaviour`);
    }
    for (const need of impliedNeeds(c.statement, c.connections, c.inventory)) {
      const fam = familyOf(need.kind);
      const family = FAMILIES.find((f) => f.name === fam);
      const meets = (k: Criterion) => (k.requires ?? []).some((r) => r === need.id || familyOf(kinds.get(r) ?? '') === fam);
      // The need sits on a criterion that runs the behaviour, not on the suite or a human question.
      if (![...focusedOf.values()].some(meets)) {
        issues.push(`${need.because}: a criterion that exercises it must require capability ${safeSegment(need.id)} (kind ${safeSegment(need.kind)})`);
        continue;
      }
      // And every focused criterion whose statement is about it requires it too.
      for (const k of focusedOf.values()) {
        if (agreed.has(k.id) || meets(k)) continue;
        const hit = family ? family.words.exec(k.statement) : wordIn(k.statement, need.id) ? [need.id] : null;
        if (hit) issues.push(`criterion ${safeSegment(k.id)} is about ${family?.name ?? `the ${need.id} connection`} ("${safeSegment(hit[0].toLowerCase())}") but does not require capability ${safeSegment(need.id)} (kind ${safeSegment(need.kind)})`);
      }
    }
    return [...new Set(issues)];
  } catch (err) {
    return [`contract quality check failed (${err instanceof Error ? err.name : 'error'}); refusing`];
  }
}

/**
 * Why a criterion's inline script imports something that cannot be there: a repository module the repository
 * does not hold and the request does not name (with a repository view), or a package that is neither a Node
 * built-in nor listed in package.json (with the dependency list).
 */
function importIssues(k: Criterion, c: QualityContext): string[] {
  if (k.check.kind !== 'command') return [];
  const out: string[] = [];
  const { modules, packages } = commandImports(k.check.command);
  if (c.fileExists) {
    const asked = new Set(namedPaths(c.statement));
    for (const m of modules) {
      if (!exists(c.fileExists, m) && !asked.has(m)) out.push(`criterion ${safeSegment(k.id)} imports ${safePath(m)}, which is not in the repository and the request does not name it; import the module that holds the behaviour today`);
    }
  }
  if (c.dependencies) {
    const listed = new Set(c.dependencies);
    for (const spec of packages) {
      const pkg = packageOf(spec);
      if (isNodeBuiltin(spec) || listed.has(pkg)) continue;
      out.push(`criterion ${safeSegment(k.id)} imports package ${safePath(pkg)}, which the repository does not install (installed: ${c.dependencies.length ? c.dependencies.slice(0, 12).map(safePath).join(', ') : 'none'}); use a Node built-in (node:sqlite, node:test, node:assert, node:child_process) or a listed package`);
    }
  }
  return out;
}

// ---------- tags ----------

/** The tag shape (the bench's scenario tags use the same). */
export const TAG_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
/** Most tags one criterion carries. */
export const MAX_TAGS = 8;

const REASONS: Record<string, string> = {
  '400': 'bad-request',
  '401': 'unauthorized',
  '403': 'forbidden',
  '404': 'not-found',
  '405': 'method-not-allowed',
  '409': 'conflict',
  '410': 'gone',
  '413': 'payload-too-large',
  '415': 'unsupported-media-type',
  '422': 'unprocessable-entity',
  '429': 'too-many-requests',
  '500': 'internal-server-error',
  '502': 'bad-gateway',
  '503': 'service-unavailable',
  '504': 'gateway-timeout',
};

/** A proposed tag in the canonical shape, or null. */
export function normalizeTag(t: unknown): string | null {
  if (typeof t !== 'string') return null;
  const s = t
    .toLowerCase()
    .replace(/[^a-z0-9_.]+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');
  return TAG_RE.test(s) ? s : null;
}

/** Tags the statement names outright: an HTTP error status (and its reason phrase) and header names. */
export function derivedTags(statement: string): string[] {
  const out: string[] = [];
  const s = String(statement);
  for (const m of s.matchAll(/\b([45]\d\d)\b/g)) {
    out.push(`http-${m[1]}`);
    const r = REASONS[m[1]!];
    if (r) out.push(r);
  }
  for (const m of s.matchAll(/\b((?:X-)?[A-Z][A-Za-z0-9]*(?:-[A-Z][A-Za-z0-9]*)+)\b/g)) {
    const t = normalizeTag(m[1]);
    if (t) out.push(t);
  }
  return out;
}

/** The criterion's tags: its own (normalised) then the derived ones; unique, bounded, never its id alone. */
export function criterionTags(k: { id: string; statement: string; tags?: unknown }): string[] {
  const own = Array.isArray(k.tags) ? k.tags.map(normalizeTag).filter((t): t is string => t !== null) : [];
  const all = [...new Set([...own, ...derivedTags(k.statement)])].filter((t) => t !== k.id);
  return all.slice(0, MAX_TAGS);
}

/** The draft with every criterion's tags normalised and completed (a copy; the hash is unaffected). */
export function withTags(draft: ContractDraft): ContractDraft {
  const criteria = draft.contract.criteria.map((k) => {
    const tags = criterionTags(k as TaggedCriterion);
    const { tags: _old, ...rest } = k as TaggedCriterion;
    return (tags.length ? { ...rest, tags } : rest) as Criterion;
  });
  return { ...draft, contract: { ...draft.contract, criteria } };
}
