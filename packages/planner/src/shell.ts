/**
 * The shell structure of a criterion command, read statically (nothing here runs a command).
 *
 * A criterion is one shell line whose exit status decides whether the work is accepted, so the screens over it
 * need two things a word list cannot give: which program each simple command really runs (behind `timeout 5`,
 * `env -u X`, `nice -n 5`, `sh -c '…'`, `npx`, an absolute path), and whose exit status the line ends with
 * (`check | tail`, `check || echo`, `check; echo` all end with someone else's). The reader therefore:
 * - splits the line into words and operators the way a POSIX shell does (single and double quotes, backslash
 *   escapes, `$(…)` and backticks, redirections, comments);
 * - parses the operators into a tree (lists of `;`/`&`/newline, `&&`/`||` chains, pipelines, `!`, subshells and
 *   brace groups);
 * - strips the wrappers it knows from every simple command, with their own flags and operands, and replaces a
 *   command that hands a script to a nested shell (`bash -lc '…'`, `eval '…'`, `env -S '…'`, `npx -c '…'`) with
 *   that script's own tree;
 * - marks what it cannot follow instead of guessing: control flow (`if`, `for`, `while`, …) is marked `control`
 *   and its commands are still listed; a function, `case`, process substitution, an unclosed quote or a script
 *   nested too deep is marked `unreadable`.
 * Callers decide what a mark means; a reader that guessed would be a screen that can be talked past.
 */

/** A simple command after unwrapping: the program first. `wrappers` are the prefixes stripped to reach it. */
export interface ShellCommand {
  kind: 'command';
  words: string[];
  wrappers: string[];
  /** The command substitutions its words carry (`$(…)`, backticks), each parsed. */
  subs: ShellNode[];
}

export type ShellNode =
  | ShellCommand
  /** A subshell, a brace group, or the script a command hands a nested shell (then `wrappers` name the way in). */
  | { kind: 'group'; body: ShellNode; wrappers: string[]; subs: ShellNode[] }
  | { kind: 'pipeline'; stages: ShellNode[]; negated: boolean }
  | { kind: 'and' | 'or'; left: ShellNode; right: ShellNode }
  /** Commands separated by `;`, `&` or a newline. `errexit`: the script runs under `sh -e`. */
  | { kind: 'list'; items: ShellNode[]; background: boolean[]; errexit: boolean };

/** What the reader saw and does not follow further. */
export type ShellMark = 'or' | 'negation' | 'background' | 'control' | 'unreadable';

/** One simple command of the line, flattened out of the tree. */
export interface ShellSegment {
  words: string[];
  wrappers: string[];
  /** Its exit status never reaches the line's: it is not the last of a `;` list or of a pipeline, runs in the background, or sits in a command substitution. */
  dropped: boolean;
  /** It sits inside a command substitution. */
  substituted: boolean;
  /** It runs in the background (`cmd &`). */
  background: boolean;
}

export interface ShellRead {
  tree: ShellNode;
  /** Every simple command with a program, in order, nested scripts and substitutions included. */
  segments: ShellSegment[];
  /** The line and every nested script inside it, as written (for screens that scan characters). */
  texts: string[];
  /** Every prefix stripped on the way to a program or a nested script (`timeout`, `nohup`, `bash`). */
  wrappers: string[];
  marks: ReadonlySet<ShellMark>;
}

/** Nested scripts and substitutions are followed this deep; deeper is unreadable. */
const MAX_DEPTH = 4;

export const base = (w: string): string => w.replace(/^.*\//, '');

// ---------- words and operators ----------

type Token = { op: string } | { word: string; bare: boolean; subs: string[] };

/** The index of the `)` closing the `(` at `open`, quotes and nesting respected; -1 when it never closes. */
function closingParen(line: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\\') i++;
    else if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Split a line into words (quotes removed, substitutions kept as written and listed) and operators; null when it cannot be read. */
function tokenize(line: string): Token[] | null {
  const out: Token[] = [];
  let text = '';
  let bare = true;
  let started = false;
  let subs: string[] = [];
  // The next word is a redirection's target, not an argument.
  let target = false;
  const n = line.length;
  let i = 0;
  const push = () => {
    if (started && !target) out.push({ word: text, bare, subs });
    if (started) target = false;
    text = '';
    bare = true;
    started = false;
    subs = [];
  };
  const op = (o: string) => {
    push();
    target = false;
    out.push({ op: o });
  };
  /** Consume a `$…` or backtick expansion at `i` into the current word; false when it never closes. */
  const expansion = (): boolean => {
    started = true;
    if (line[i] === '`') {
      let j = i + 1;
      while (j < n && line[j] !== '`') j += line[j] === '\\' ? 2 : 1;
      if (j >= n) return false;
      subs.push(line.slice(i + 1, j));
      text += line.slice(i, j + 1);
      i = j + 1;
      return true;
    }
    if (line[i + 1] === '(') {
      const end = closingParen(line, i + 1);
      if (end < 0) return false;
      // `$((…))` is arithmetic: nothing runs in it.
      if (line[i + 2] !== '(') subs.push(line.slice(i + 2, end));
      text += line.slice(i, end + 1);
      i = end + 1;
      return true;
    }
    if (line[i + 1] === '{') {
      const end = line.indexOf('}', i);
      if (end < 0) return false;
      text += line.slice(i, end + 1);
      i = end + 1;
      return true;
    }
    text += line[i];
    i++;
    return true;
  };
  while (i < n) {
    const c = line[i]!;
    if (c === '\n') {
      op(';');
      i++;
    } else if (/\s/.test(c)) {
      push();
      i++;
    } else if (c === '#' && !started) {
      while (i < n && line[i] !== '\n') i++;
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return null;
      text += line.slice(i + 1, end);
      bare = false;
      started = true;
      i = end + 1;
    } else if (c === '"') {
      bare = false;
      started = true;
      i++;
      for (;;) {
        if (i >= n) return null;
        const d = line[i]!;
        if (d === '"') {
          i++;
          break;
        }
        if (d === '\\' && i + 1 < n && '"\\$`\n'.includes(line[i + 1]!)) {
          if (line[i + 1] !== '\n') text += line[i + 1];
          i += 2;
        } else if (d === '`' || (d === '$' && (line[i + 1] === '(' || line[i + 1] === '{'))) {
          if (!expansion()) return null;
        } else {
          text += d;
          i++;
        }
      }
    } else if (c === '\\') {
      if (i + 1 < n && line[i + 1] !== '\n') {
        text += line[i + 1];
        bare = false;
        started = true;
      }
      i += 2;
    } else if (c === '$' || c === '`') {
      if (!expansion()) return null;
    } else if (c === '<' || c === '>' || (c === '&' && line[i + 1] === '>')) {
      // A redirection (`2>&1`, `> out`, `&> out`, `<<EOF`): its descriptor and its target are not words.
      if (started && bare && /^\d+$/.test(text)) {
        text = '';
        started = false;
      }
      push();
      if (c === '&') i++;
      const from = i;
      while (i < n && (line[i] === '<' || line[i] === '>')) i++;
      if (line[i] === '&' || line[i] === '|' || (line[i] === '-' && line.slice(from, i) === '<<')) i++;
      // `<(…)` and `>(…)` run a command the reader does not follow.
      if (line[i] === '(') return null;
      target = true;
    } else if (c === '&') {
      if (line[i + 1] === '&') {
        op('&&');
        i += 2;
      } else {
        op('&');
        i++;
      }
    } else if (c === '|') {
      if (line[i + 1] === '|') {
        op('||');
        i += 2;
      } else {
        op('|');
        i += line[i + 1] === '&' ? 2 : 1;
      }
    } else if (c === ';') {
      // `;;` belongs to `case`, which is not followed.
      if (line[i + 1] === ';') return null;
      op(';');
      i++;
    } else if (c === '(' || c === ')') {
      // `name()` or `x=(…)`: a function or an array, not a subshell.
      if (c === '(' && started) return null;
      op(c);
      i++;
    } else {
      text += c;
      started = true;
      i++;
    }
  }
  push();
  return out;
}

// ---------- wrappers ----------

const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
/** Package-manager front ends that run the program named after them (`npx vitest`, `pnpm exec jest`). */
const PM_EXEC = new Set(['exec', 'dlx', 'x']);
/** Programs a package manager is asked to run without `exec` (`yarn vitest run`, `pnpm jest`). */
const PM_BINARIES = new Set(['node', 'vitest', 'jest', 'mocha', 'tsx', 'ts-node', 'playwright', 'ava', 'tap', 'pytest']);

interface WrapperSpec {
  /** Flags that take the next word as their value. */
  value?: readonly string[];
  /** Operands before the command (`timeout DURATION command`). */
  operands?: number;
}

/**
 * Prefix commands whose remaining arguments are the command to run. Any other flag of theirs is one word
 * (`--foreground`, `-n5`, `--signal=KILL`).
 */
const WRAPPERS: Readonly<Record<string, WrapperSpec>> = {
  env: { value: ['-u', '--unset', '-C', '--chdir'] },
  time: { value: ['-f', '--format', '-o', '--output'] },
  nice: { value: ['-n', '--adjustment'] },
  command: {},
  exec: { value: ['-a'] },
  timeout: { value: ['-s', '--signal', '-k', '--kill-after'], operands: 1 },
  stdbuf: { value: ['-i', '-o', '-e', '--input', '--output', '--error'] },
  nohup: {},
  setsid: {},
  ionice: { value: ['-c', '--class', '-n', '--classdata'] },
  busybox: {},
  xargs: { value: ['-n', '--max-args', '-I', '-L', '--max-lines', '-P', '--max-procs', '-d', '--delimiter', '-s', '--max-chars', '-E', '-a', '--arg-file'] },
  npx: { value: ['-p', '--package'] },
  bunx: { value: ['-p', '--package'] },
  pnpx: { value: ['-p', '--package'] },
};

interface Unwrapped {
  words: string[];
  wrappers: string[];
  /** The script the command hands a nested shell, when it does. */
  script?: string;
  errexit?: boolean;
}

/** The script a shell invocation carries after a flag cluster with `c` (`bash -lc`, `sh -ec`), or null. */
function shellScript(w: readonly string[]): { script: string; errexit: boolean } | null {
  let errexit = false;
  for (let i = 1; i < w.length; i++) {
    const a = w[i]!;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) return w[i + 1] === undefined ? null : { script: w[i + 1]!, errexit: errexit || a.includes('e') };
    if (a === '-o' || a === '+o' || a === '--rcfile' || a === '--init-file') {
      if (a === '-o' && w[i + 1] === 'errexit') errexit = true;
      i++;
    } else if (/^-[A-Za-z]+$/.test(a)) errexit = errexit || a.includes('e');
    else if (!a.startsWith('-') && !a.startsWith('+')) return null;
  }
  return null;
}

/**
 * Strip assignments and every known wrapper from a simple command's words, down to the program it runs or the
 * script it hands a nested shell. A wrapper with nothing after it is left as the program (it runs nothing).
 */
function unwrap(input: readonly string[]): Unwrapped {
  let w = [...input];
  const wrappers: string[] = [];
  for (let round = 0; round < 16; round++) {
    while (w.length && ASSIGNMENT.test(w[0]!)) w = w.slice(1);
    if (!w.length) break;
    const prog = base(w[0]!);
    if (prog === 'eval') return w.length > 1 ? { words: [], wrappers: [...wrappers, prog], script: w.slice(1).join(' ') } : { words: w, wrappers };
    if (SHELLS.has(prog)) {
      const nested = shellScript(w);
      return nested ? { words: [], wrappers: [...wrappers, prog], ...nested } : { words: w, wrappers };
    }
    // `command -v node` asks where a program is; it runs nothing.
    if (prog === 'command' && (w[1] === '-v' || w[1] === '-V')) return { words: ['which', ...w.slice(2)], wrappers };
    let rest: string[] | null = null;
    const spec = Object.prototype.hasOwnProperty.call(WRAPPERS, prog) ? WRAPPERS[prog]! : undefined;
    if (spec) {
      let i = 1;
      let script: string | null = null;
      for (; i < w.length; i++) {
        const a = w[i]!;
        if (a === '--') {
          i++;
          break;
        }
        // `env -S 'cmd'`, `npx -c 'cmd'`: the string is a command line.
        if (prog === 'env' ? a === '-S' || a === '--split-string' : /^(npx|bunx|pnpx)$/.test(prog) && (a === '-c' || a === '--call')) {
          script = w.slice(i + 1).join(' ');
          break;
        }
        if (prog === 'env' && /^(-S.|--split-string=)/.test(a)) {
          script = [a.replace(/^(-S|--split-string=)/, ''), ...w.slice(i + 1)].join(' ');
          break;
        }
        if (prog === 'env' && ASSIGNMENT.test(a)) continue;
        if (!a.startsWith('-') || a === '-') {
          if (prog === 'env' && a === '-') continue;
          break;
        }
        if (spec.value?.includes(a)) i++;
      }
      if (script !== null) return { words: [], wrappers: [...wrappers, prog], script };
      rest = w.slice(i + (spec.operands ?? 0));
    } else if (/^(npm|pnpm|yarn|bun)$/.test(prog) && w.length > 2 && PM_EXEC.has(w[1]!)) {
      let i = 2;
      while (i < w.length && w[i]!.startsWith('-') && w[i] !== '-c' && w[i] !== '--call') i++;
      if (w[i] === '-c' || w[i] === '--call') return { words: [], wrappers: [...wrappers, prog], script: w.slice(i + 1).join(' ') };
      rest = w.slice(i);
    } else if (/^(pnpm|yarn)$/.test(prog) && w.length > 1 && PM_BINARIES.has(w[1]!)) {
      rest = w.slice(1);
    }
    if (rest === null) break;
    // xargs with no command runs echo.
    if (!rest.length && prog === 'xargs') rest = ['echo'];
    if (!rest.length) break;
    wrappers.push(prog);
    w = rest;
  }
  return { words: w, wrappers };
}

// ---------- structure ----------

/** Reserved words that open or continue control flow; the commands after them are still read. */
const CONTROL = new Set(['if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done']);
/** Reserved words whose header is not a command (`for x in a b`), or that the reader does not follow at all. */
const CONTROL_HEADER = new Set(['for', 'select']);
const NOT_FOLLOWED = new Set(['case', 'esac', 'function', 'coproc']);

interface State {
  marks: Set<ShellMark>;
  texts: string[];
  wrappers: string[];
}

const EMPTY: ShellCommand = { kind: 'command', words: [], wrappers: [], subs: [] };

function parse(line: string, depth: number, st: State): ShellNode {
  st.texts.push(line);
  const toks = depth > MAX_DEPTH ? null : tokenize(line);
  if (toks === null) {
    st.marks.add('unreadable');
    return { kind: 'list', items: [], background: [], errexit: false };
  }
  let pos = 0;
  const peek = (): Token | undefined => toks[pos];
  const isOp = (t: Token | undefined, o: string): boolean => !!t && 'op' in t && t.op === o;
  const isBare = (t: Token | undefined, w: string): boolean => !!t && 'word' in t && t.bare && t.word === w;

  const list = (stop: ')' | '}' | null): ShellNode => {
    const items: ShellNode[] = [];
    const background: boolean[] = [];
    for (;;) {
      while (isOp(peek(), ';')) pos++;
      const t = peek();
      if (!t || (stop === ')' && isOp(t, ')')) || (stop === '}' && isBare(t, '}'))) break;
      const before = pos;
      const node = andOr();
      const bg = isOp(peek(), '&');
      if (bg) {
        st.marks.add('background');
        pos++;
      }
      items.push(node);
      background.push(bg);
      // Nothing was consumed (a stray operator): stop rather than loop.
      if (pos === before) {
        st.marks.add('unreadable');
        break;
      }
    }
    return { kind: 'list', items, background, errexit: false };
  };

  const andOr = (): ShellNode => {
    let left = pipeline();
    for (;;) {
      const t = peek();
      const kind = isOp(t, '&&') ? 'and' : isOp(t, '||') ? 'or' : null;
      if (!kind) return left;
      pos++;
      if (kind === 'or') st.marks.add('or');
      left = { kind, left, right: pipeline() };
    }
  };

  const pipeline = (): ShellNode => {
    let negated = false;
    while (isBare(peek(), '!')) {
      negated = !negated;
      st.marks.add('negation');
      pos++;
    }
    const stages = [command()];
    while (isOp(peek(), '|')) {
      pos++;
      stages.push(command());
    }
    return stages.length === 1 && !negated ? stages[0]! : { kind: 'pipeline', stages, negated };
  };

  const substitutions = (words: readonly Token[]): ShellNode[] => words.flatMap((t) => ('word' in t ? t.subs.map((s) => parse(s, depth + 1, st)) : []));

  const command = (): ShellNode => {
    const t = peek();
    if (!t) {
      st.marks.add('unreadable');
      return EMPTY;
    }
    if ('op' in t) {
      if (t.op !== '(') {
        st.marks.add('unreadable');
        return EMPTY;
      }
      pos++;
      const body = list(')');
      if (isOp(peek(), ')')) pos++;
      else st.marks.add('unreadable');
      return { kind: 'group', body, wrappers: [], subs: [] };
    }
    if (t.bare && t.word === '{') {
      pos++;
      const body = list('}');
      if (isBare(peek(), '}')) pos++;
      else st.marks.add('unreadable');
      return { kind: 'group', body, wrappers: [], subs: [] };
    }
    if (t.bare && (CONTROL.has(t.word) || CONTROL_HEADER.has(t.word) || NOT_FOLLOWED.has(t.word))) {
      st.marks.add(NOT_FOLLOWED.has(t.word) ? 'unreadable' : 'control');
      pos++;
      if (!CONTROL.has(t.word)) while (peek() && 'word' in peek()!) pos++;
      const next = peek();
      return next && ('word' in next || isOp(next, '(')) ? command() : EMPTY;
    }
    const words: Array<Extract<Token, { word: string }>> = [];
    for (let x = peek(); x && 'word' in x; x = peek()) {
      words.push(x);
      pos++;
    }
    // `name ( )`: a function definition.
    if (isOp(peek(), '(')) {
      st.marks.add('unreadable');
      pos++;
    }
    const subs = substitutions(words);
    const u = unwrap(words.map((x) => x.word));
    st.wrappers.push(...u.wrappers);
    if (u.script === undefined) return { kind: 'command', words: u.words, wrappers: u.wrappers, subs };
    const body = parse(u.script, depth + 1, st);
    if (body.kind === 'list') body.errexit = u.errexit === true;
    return { kind: 'group', body, wrappers: u.wrappers, subs };
  };

  const tree = list(null);
  if (pos < toks.length) st.marks.add('unreadable');
  return tree;
}

type Place = Omit<ShellSegment, 'words' | 'wrappers'>;

function flatten(node: ShellNode, at: Place, out: ShellSegment[]): void {
  switch (node.kind) {
    case 'command':
      if (node.words.length) out.push({ words: node.words, wrappers: node.wrappers, ...at });
      for (const s of node.subs) flatten(s, { ...at, dropped: true, substituted: true }, out);
      return;
    case 'group':
      for (const s of node.subs) flatten(s, { ...at, dropped: true, substituted: true }, out);
      flatten(node.body, at, out);
      return;
    case 'pipeline':
      node.stages.forEach((s, i) => flatten(s, i < node.stages.length - 1 ? { ...at, dropped: true } : at, out));
      return;
    case 'and':
    case 'or':
      flatten(node.left, at, out);
      flatten(node.right, at, out);
      return;
    case 'list':
      node.items.forEach((s, i) => {
        const bg = node.background[i] === true;
        flatten(s, bg || i < node.items.length - 1 ? { ...at, dropped: true, background: at.background || bg } : at, out);
      });
      return;
  }
}

/** Read `line` (see the module comment). Never throws: a line that cannot be read comes back marked `unreadable`. */
export function readShell(line: string): ShellRead {
  const st: State = { marks: new Set(), texts: [], wrappers: [] };
  try {
    const tree = parse(String(line), 0, st);
    const segments: ShellSegment[] = [];
    flatten(tree, { dropped: false, substituted: false, background: false }, segments);
    return { tree, segments, texts: st.texts, wrappers: st.wrappers, marks: st.marks };
  } catch {
    st.marks.add('unreadable');
    return { tree: { kind: 'list', items: [], background: [], errexit: false }, segments: [], texts: [String(line)], wrappers: [], marks: st.marks };
  }
}
