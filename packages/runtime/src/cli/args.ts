/**
 * Hand-rolled argv parsing (no dependencies). Flags are declared up front: a value flag consumes the next
 * token or `--flag=value`; a boolean flag takes no value; anything undeclared is a usage error (exit 2).
 * `--` ends flag parsing.
 */

export const VALUE_FLAGS = [
  'manifest',
  'as',
  'reason',
  'rationale',
  'run',
  'export',
  'budget-usd',
  'max-depth',
  'profile',
  'writer',
  'reviewer',
  'to',
  'session',
  'scripted',
] as const;

export const BOOL_FLAGS = [
  'json',
  'quiet',
  'no-color',
  'yes',
  'help',
  'version',
  'dry-run',
  'sample',
  'interactive',
  'strict',
  'skip-live',
  'fix',
  'force',
  'resume',
  'watch',
  'redact',
] as const;

export type ValueFlag = (typeof VALUE_FLAGS)[number];
export type BoolFlag = (typeof BOOL_FLAGS)[number];

export interface ParsedArgs {
  positionals: string[];
  values: Partial<Record<ValueFlag, string>>;
  bools: Partial<Record<BoolFlag, boolean>>;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const SHORT: Record<string, BoolFlag> = { h: 'help', v: 'version', q: 'quiet', y: 'yes' };

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { positionals: [], values: {}, bools: {} };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === '--') {
      out.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
      const inline = eq === -1 ? undefined : tok.slice(eq + 1);
      if ((VALUE_FLAGS as readonly string[]).includes(name)) {
        const v = inline ?? argv[++i];
        if (v === undefined || (inline === undefined && v.startsWith('--'))) throw new UsageError(`--${name} requires a value`);
        out.values[name as ValueFlag] = v;
      } else if ((BOOL_FLAGS as readonly string[]).includes(name)) {
        if (inline !== undefined) throw new UsageError(`--${name} does not take a value`);
        out.bools[name as BoolFlag] = true;
      } else throw new UsageError(`unknown flag --${name}`);
      continue;
    }
    if (tok.startsWith('-') && tok.length > 1 && !/^-\d/.test(tok)) {
      for (const c of tok.slice(1)) {
        const f = SHORT[c];
        if (!f) throw new UsageError(`unknown flag -${c}`);
        out.bools[f] = true;
      }
      continue;
    }
    out.positionals.push(tok);
  }
  return out;
}
