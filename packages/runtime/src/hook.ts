import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Manifest } from '@tecera/contracts';
import { matchesAny, matchesProtected, normalizePath, pathProblem, type PermissionsDoc } from '@tecera/policy';
import { EDIT_TOOLS } from './adapters/render.js';
import { parseArgs, type BoolFlag, type ParsedArgs, type ValueFlag } from './cli/args.js';
import { HOST_GIT_PAGER_CONFIG } from './util/proc.js';
import { inspectPath, UnsafePathError } from './util/safefs.js';

/**
 * Host hook decisions (Claude Code PreToolUse). Fail closed everywhere:
 *
 * - Edit tools: the path must resolve inside the business-case root through real directories only. Every
 *   segment is lstat'ed: a symbolic link (live or dangling), a resolution failure, a hard-linked target or a
 *   non-regular file blocks. Then host-owned files (tecera config, host settings, git internals, env files)
 *   block, then `policy.protectedPaths`, then anything outside `repo.allowedChanges`.
 * - Bash is mediated, not trusted: only the manifest's verify command or a goal's check command (exact
 *   text), a small set of read-only commands, and `tecera gate|status|why|validate` run. Redirection, pipes,
 *   chaining, substitution, subshells and escapes are refused outright, and the command word must itself be
 *   on the list (no environment prefix, no path, no interpreter), so a shell command cannot write a protected
 *   file, delete a test, edit configuration or call `tecera approve`. A `tecera` command line is read with the
 *   CLI's own argument parser (decideTecera): default deny, the subcommand first, and only the flags each
 *   read-only subcommand is listed with.
 * - Read-only host tools are allowed; any other tool (including MCP tools) is refused.
 */

export interface HookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  hook_event_name?: string;
}

export type HookDecision = { allow: true } | { allow: false; reason: string };

export interface HookContext {
  root: string;
  manifest: Manifest;
  permissions: PermissionsDoc;
  cwd: string;
  /** Goal check commands (`.tecera/goals/*.goal.md` verify lines); allowed verbatim like verify.command. */
  checkCommands?: readonly string[];
  /**
   * Git config keys (any scope) that would make the HOST's git run a program (util/proc
   * hostGitExecHazards). Asked only for git commands. Absent → git is refused (fail closed: the host runs
   * git with the user's full config, so a read-only subcommand is only read-only when no such key exists).
   */
  gitHazards?: () => readonly string[];
}

/** Host tools that read or plan but cannot write the repository. */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'TodoRead', 'Task', 'Agent', 'ExitPlanMode', 'WebSearch', 'WebFetch', 'BashOutput', 'KillShell', 'KillBash', 'AskUserQuestion'] as const;

/** Files no agent edits whatever the manifest says: tecera's own state, host settings, git internals, env files. */
export const HOST_PROTECTED = ['tecera.json', '.tecera/**', 'CLAUDE.md', 'AGENTS.md', '.claude/**', '.codex/**', '.git/**', '.git', '.gitignore', '.gitattributes', '.husky/**', '**/.env', '**/.env.*', '.npmrc', '.yarnrc*'];

const NEVER_COMMANDS: Record<string, RegExp> = {
  git_push: /(^|[\s;&|()])git\s+(?:-[^\s]+\s+)*push\b/,
  open_pr: /(^|[\s;&|()])gh\s+(?:-[^\s]+\s+)*pr\s+create\b/,
  merge: /(^|[\s;&|()])(?:git\s+(?:-[^\s]+\s+)*merge\b|gh\s+(?:-[^\s]+\s+)*pr\s+merge\b)/,
};

/** Actions only the PR gate performs, on the human grant it consumes (D6): never an agent's shell. */
const PR_GATE_ONLY: ReadonlySet<string> = new Set(['git_push', 'open_pr']);

/** Read-only commands a mediated shell may run (no writes, no code execution, no environment dump). */
const READ_ONLY_COMMANDS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'pwd', 'echo', 'true', 'false', 'which', 'stat', 'diff', 'du', 'realpath', 'basename', 'dirname', 'find', 'git', 'tecera', 'sort', 'cut', 'nl', 'test']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'grep', 'describe', 'shortlog', 'cat-file', 'ls-tree', 'branch']);
/**
 * Git options before the subcommand: an allowlist (everything else, including `-c`, `-ckey=value`, `-C`,
 * `-p`/`--paginate`, `--exec-path`, `--git-dir`, `--config-env`, is refused in every spelling).
 */
const GIT_GLOBAL_OK = new Set(['--no-pager', '-P', '--no-optional-locks', '--literal-pathspecs', '--no-replace-objects', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs']);
/**
 * Long options after a git subcommand that write files, run programs or open a pager. git's option parser
 * accepts any unambiguous PREFIX of a long option (`--outp=x` is `--output=x`), so a word is refused when it
 * is a prefix of (or equal to) one of these. `--no-<opt>` forms are harmless and allowed.
 */
const GIT_DANGEROUS_LONG = ['output', 'output-directory', 'ext-diff', 'textconv', 'open-files-in-pager', 'paginate', 'exec', 'upload-pack', 'receive-pack', 'config-env', 'git-dir', 'work-tree', 'namespace', 'filters', 'run', 'tool', 'extcmd', 'config', 'edit-description', 'set-upstream-to', 'unset-upstream', 'copy', 'move', 'delete', 'create-reflog', 'track', 'force'];
/** Short options after a git subcommand that are refused in any cluster or attached form (grep -O<pager>). */
const GIT_DANGEROUS_SHORT = new Set(['O']);
const FIND_FORBIDDEN = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;
/**
 * The `tecera` subcommands an agent may run, each with the only flags it may carry and how many arguments
 * it takes. Everything else is refused: approvals, sign-off, learning, resources, runs, hooks, adapters,
 * init, doctor, evidence export, and every flag that names a principal, a reason, a file or a manifest.
 */
const TECERA_READ: Readonly<Record<string, { bools: readonly BoolFlag[]; values: readonly ValueFlag[]; positionals: number }>> = {
  gate: { bools: ['json', 'quiet', 'no-color'], values: [], positionals: 1 },
  status: { bools: ['json', 'quiet', 'no-color'], values: ['run'], positionals: 0 },
  why: { bools: ['json', 'quiet', 'no-color'], values: [], positionals: 1 },
  validate: { bools: ['json', 'quiet', 'no-color', 'strict'], values: [], positionals: 0 },
};
/** Characters the shell expands into other words (globs, tilde, history): never part of a tecera argument. */
const TECERA_EXPANDING = /[*?[\]~^#]/;
/** sort long options that write (`--output`) or run a program (`--compress-program`), as GNU prefixes. */
const SORT_DANGEROUS_LONG = ['output', 'compress-program', 'temporary-directory'];
/** sort short options taking an argument that writes (`-o FILE`, `-oFILE`, `-uoFILE`) or picks a temp dir. */
const SORT_DANGEROUS_SHORT = new Set(['o', 'T']);
/** ripgrep: `--pre`/`--pre-glob` run a program per file; `-z`/`--search-zip` run decompressors. */
const RG_DANGEROUS_LONG = ['pre', 'pre-glob', 'search-zip'];
const RG_DANGEROUS_SHORT = new Set(['z']);

/** `--name[=value]` → 'name' (lower-case); null for anything else. */
function longName(arg: string): string | null {
  if (!arg.startsWith('--') || arg === '--') return null;
  return arg.slice(2).split('=')[0]!.toLowerCase();
}

/** True when a long-option word abbreviates (or equals) one of `dangerous` (GNU / git prefix matching). */
function abbreviates(arg: string, dangerous: readonly string[]): string | null {
  const n = longName(arg);
  if (n === null || n === '' || n.startsWith('no-')) return null;
  return dangerous.find((d) => d.startsWith(n)) ?? null;
}

/**
 * True when a short-option word (`-x`, a cluster `-abc`, or an attached argument `-ofile`) contains one of
 * `letters` as an option letter. Every letter of a cluster is checked, so an attached argument that merely
 * contains the letter is refused too (fail closed).
 */
function hasShort(arg: string, letters: ReadonlySet<string>): string | null {
  if (!arg.startsWith('-') || arg.startsWith('--') || arg.length < 2) return null;
  for (const ch of arg.slice(1)) if (letters.has(ch)) return ch;
  return null;
}
/** Shell metacharacters that redirect, chain, substitute, background, expand or escape. */
const SHELL_META = /[;&|<>`$(){}\\\n\r!]/;

export function parseHookInput(text: string): HookInput {
  const v = JSON.parse(text) as unknown;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('hook payload is not a JSON object');
  return v as HookInput;
}

/** Split a command into words honouring simple quotes. Null when the quoting is unbalanced. */
export function shellWords(cmd: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (quote) return null;
  if (has || cur) out.push(cur);
  return out;
}

const deny = (reason: string): HookDecision => ({ allow: false, reason: `tecera: ${reason}` });

const BASH_HELP = 'Bash is mediated: only the verify/check command, read-only commands (ls, cat, grep, find, git status|diff|log|show, …) and `tecera gate|status|why|validate` run; redirection, pipes, chaining and substitution are refused. Use the Edit/Write tools for changes';

export function decideBash(cmdRaw: unknown, ctx: HookContext): HookDecision {
  if (typeof cmdRaw !== 'string' || !cmdRaw.trim()) return deny('Bash without a command (fail closed)');
  const cmd = cmdRaw.trim();
  for (const [action, re] of Object.entries(NEVER_COMMANDS)) {
    if (!re.test(cmd)) continue;
    if (ctx.permissions.never.includes(action)) return deny(`${action} is in permissions.never`);
    if (PR_GATE_ONLY.has(action)) return deny(`${action} is done only by the PR gate, on a human approval (\`tecera approve\`); agents never push or open PRs`);
  }
  const checks = new Set([ctx.manifest.verify.command.trim(), ...(ctx.checkCommands ?? []).map((c) => c.trim())]);
  if (checks.has(cmd)) return { allow: true };
  if (SHELL_META.test(cmd)) return deny(`${BASH_HELP} (found a shell metacharacter)`);
  const words = shellWords(cmd);
  if (!words || words.length === 0) return deny(`${BASH_HELP} (unbalanced quotes)`);
  const [bin, ...args] = words;
  if (!READ_ONLY_COMMANDS.has(bin!)) return deny(`${BASH_HELP} (\`${bin}\` is not a read-only command)`);
  if (bin === 'git') {
    let i = 0;
    while (i < args.length && args[i]!.startsWith('-')) {
      if (!GIT_GLOBAL_OK.has(args[i]!)) return deny(`${BASH_HELP} (git option ${args[i]} is refused before the subcommand)`);
      i++;
    }
    const sub = args[i];
    if (!sub || !GIT_READ.has(sub)) return deny(`${BASH_HELP} (git ${sub ?? ''} is not read-only)`);
    if (!ctx.gitHazards) return deny(`${BASH_HELP} (git config could not be checked for programs; fail closed)`);
    const noPager = args.slice(0, i).some((a) => a === '--no-pager' || a === '-P');
    const hazards = ctx.gitHazards().filter((k) => !(noPager && HOST_GIT_PAGER_CONFIG.test(k)));
    if (hazards.length) return deny(`${BASH_HELP} (git config can make this command run a program: ${hazards.slice(0, 4).join(', ')}${hazards.some((k) => HOST_GIT_PAGER_CONFIG.test(k)) ? '; pass --no-pager for pager settings' : ''})`);
    for (const a of args.slice(i + 1)) {
      if (a === '--') break;
      const long = abbreviates(a, GIT_DANGEROUS_LONG);
      if (long) return deny(`${BASH_HELP} (git option ${a} (--${long}) is refused)`);
      const short = hasShort(a, GIT_DANGEROUS_SHORT);
      if (short) return deny(`${BASH_HELP} (git option ${a} (-${short}) is refused)`);
    }
    if (sub === 'branch' && args.slice(i + 1).some((a) => !/^(-a|-r|-v|-vv|--list|--all|--show-current|--contains|--merged|--no-merged)$/.test(a))) return deny(`${BASH_HELP} (git branch may only list)`);
  }
  if (bin === 'find' && args.some((a) => FIND_FORBIDDEN.test(a))) return deny(`${BASH_HELP} (find actions that write or execute are refused)`);
  if (bin === 'sort') {
    for (const a of args) {
      if (a === '--') break;
      if (abbreviates(a, SORT_DANGEROUS_LONG) || hasShort(a, SORT_DANGEROUS_SHORT)) return deny(`${BASH_HELP} (sort ${a}: -o/--output writes a file, --compress-program runs one)`);
    }
  }
  if (bin === 'rg') {
    for (const a of args) {
      if (a === '--') break;
      if (abbreviates(a, RG_DANGEROUS_LONG) || /^--pre/.test(a) || hasShort(a, RG_DANGEROUS_SHORT)) return deny(`${BASH_HELP} (rg ${a} executes a program)`);
    }
  }
  if (bin === 'tecera') {
    const why = teceraProblem(args);
    if (why) return deny(`${BASH_HELP} (${why})`);
  }
  return { allow: true };
}

/**
 * Why a `tecera` argument list (the words after the command) is not one an agent may run, or null. Default
 * deny, decided on what the CLI itself would do with these words:
 *
 * - the first word is the subcommand, spelled out, and it is on TECERA_READ. The CLI lets a value flag take
 *   the next word wherever it stands (`tecera --reason gate approve <id>` runs `approve`), so nothing may
 *   come before the subcommand, and the words are then read with the CLI's parser (parseArgs) to check that
 *   the subcommand it would dispatch is the same one;
 * - every flag is one the subcommand is listed with; a flag the parser does not know, or a list it rejects,
 *   is refused;
 * - the number of arguments is the subcommand's, and no word carries a character the shell would expand
 *   into other words.
 */
export function teceraProblem(args: readonly string[]): string | null {
  const refused = (what: string): string => `\`tecera ${what}\` is not available to agents; approvals, sign-off and learning are human decisions`;
  const sub = args[0];
  if (sub === undefined || !Object.prototype.hasOwnProperty.call(TECERA_READ, sub)) return refused(sub === undefined || sub.startsWith('-') ? '<flag first>' : sub.slice(0, 40));
  const allowed = TECERA_READ[sub]!;
  if (args.some((a) => TECERA_EXPANDING.test(a))) return 'a tecera argument carries a character the shell expands';
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (e) {
    return `tecera arguments refused: ${(e as Error).message}`;
  }
  if (parsed.positionals[0] !== sub) return refused(String(parsed.positionals[0] ?? '').slice(0, 40));
  if (parsed.positionals.length !== 1 + allowed.positionals) return `\`tecera ${sub}\` takes ${allowed.positionals} argument(s) here`;
  for (const f of Object.keys(parsed.bools)) if (!(allowed.bools as readonly string[]).includes(f)) return `tecera flag --${f} is refused with ${sub}`;
  for (const f of Object.keys(parsed.values)) if (!(allowed.values as readonly string[]).includes(f)) return `tecera flag --${f} is refused with ${sub}`;
  return null;
}

/** Repo-relative path of `abs` against the root (lexical or real), or null when outside both. */
function underRoot(abs: string, rootLex: string, rootReal: string): string | null {
  for (const r of [rootReal, rootLex]) {
    if (abs === r) return '';
    if (abs.startsWith(r.endsWith(sep) ? r : r + sep)) return relative(r, abs).split(sep).join('/');
  }
  return null;
}

export function decidePreTool(input: HookInput, ctx: HookContext): HookDecision {
  const tool = input.tool_name;
  if (typeof tool !== 'string' || !tool) return deny('hook payload has no tool_name (fail closed)');
  if (ctx.permissions.never.includes(tool)) return deny(`tool ${tool} is in permissions.never`);
  if (tool === 'Bash') return decideBash(input.tool_input?.command, ctx);
  if ((READ_ONLY_TOOLS as readonly string[]).includes(tool)) return { allow: true };
  if (!(EDIT_TOOLS as readonly string[]).includes(tool)) return deny(`tool ${tool} is not mediated by tecera and may write; refused (fail closed)`);

  const ti = input.tool_input ?? {};
  const raw = [ti.file_path, ti.notebook_path, ti.path].find((x) => typeof x === 'string' && x.length > 0) as string | undefined;
  if (!raw) return deny(`${tool} without a file path (fail closed)`);
  if (raw.includes('\0')) return deny(`${tool}: path contains NUL`);
  const base = typeof input.cwd === 'string' && input.cwd ? input.cwd : ctx.cwd;
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
  const rootLex = resolve(ctx.root);
  let rootReal: string;
  try {
    rootReal = realpathSync(rootLex);
  } catch (e) {
    return deny(`cannot resolve the business-case root (${(e as NodeJS.ErrnoException).code ?? 'error'}); fail closed`);
  }
  const relRaw = underRoot(abs, rootLex, rootReal);
  if (relRaw === null) return deny(`${raw} is outside the business case (${ctx.root})`);
  const relPath = normalizePath(relRaw);
  if (!relPath) return deny(`${raw} is the business-case root itself`);
  const bad = pathProblem(relPath);
  if (bad) return deny(`${relPath}: ${bad}`);
  try {
    const info = inspectPath(rootReal, relPath);
    if (info.exists && info.kind !== 'file') return deny(`${relPath} is not a regular file`);
    if (info.exists && (info.nlink ?? 1) > 1) return deny(`${relPath} has ${info.nlink} hard links; a hard link can alias a protected file`);
  } catch (e) {
    if (e instanceof UnsafePathError) return deny(`${e.message} (symlinks and unresolvable paths are refused)`);
    return deny(`${relPath}: cannot be checked (${(e as Error).message}); fail closed`);
  }
  const host = matchesAny(relPath, HOST_PROTECTED);
  if (host) return deny(`${relPath} is tecera/host configuration (${host}); agents never edit it`);
  const prot = matchesProtected(relPath, ctx.manifest.policy.protectedPaths);
  if (prot) return deny(`${relPath} is a protected path (${prot}); tests, configs and tecera files are not edited by agents`);
  if (!matchesAny(relPath, ctx.manifest.repo.allowedChanges)) return deny(`${relPath} is outside repo.allowedChanges (${ctx.manifest.repo.allowedChanges.join(', ') || 'none'})`);
  return { allow: true };
}

export function stopReminder(goals: string[]): string {
  const g = goals.length ? goals.join(', ') : '<goal>';
  return `tecera: a returned answer is not done. Before you stop, run \`tecera gate ${goals[0] ?? '<goal>'}\` (goals: ${g}); done means the check exits 0.`;
}
