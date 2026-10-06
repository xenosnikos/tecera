import type { Json, JsonObject, Redactor } from '@tecera/contracts';
import type { ParsedArgs } from './args.js';

/**
 * Output for one CLI invocation. Text goes through `say` (suppressed by --json), `info` (suppressed by
 * --json and --quiet) and `error` (stderr, always). With --json the command's result object is printed
 * once at the end instead of text. Colour only on a TTY without --no-color/NO_COLOR.
 *
 * Every byte printed goes through the redactor: at start one built from the environment (canaries and
 * credential-shaped variables), replaced by the runtime's (resolved credentials too) once the business case
 * loads. There is no unredacted print path.
 */

export interface CliIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  readStdin: () => Promise<string>;
  isTTY: boolean;
}

export class Out {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly color: boolean;
  readonly data: JsonObject = {};
  private redactor: Redactor;

  constructor(private readonly io: CliIO, args: ParsedArgs, env: Record<string, string | undefined>, redactor: Redactor) {
    this.json = !!args.bools.json;
    this.quiet = !!args.bools.quiet;
    this.color = io.isTTY && !args.bools['no-color'] && !env.NO_COLOR && !this.json;
    this.redactor = redactor;
  }

  /** Switch to a redactor that knows more secrets (the runtime's). */
  useRedactor(r: Redactor): void {
    this.redactor = r;
  }

  private clean(s: string): string {
    return this.redactor.redactText(s);
  }

  say(line = ''): void {
    if (!this.json) this.io.stdout(this.clean(`${line}\n`));
  }

  info(line = ''): void {
    if (!this.json && !this.quiet) this.io.stdout(this.clean(`${line}\n`));
  }

  error(line: string): void {
    this.io.stderr(this.clean(`${line}\n`));
  }

  set(key: string, value: Json): void {
    this.data[key] = value;
  }

  flushJson(command: string, exitCode: number): void {
    if (this.json) this.io.stdout(`${JSON.stringify(this.redactor.redactJson({ command, exitCode, ...this.data }))}\n`);
  }

  mark(status: 'ok' | 'note' | 'missing'): string {
    const sym = status === 'ok' ? '✓' : status === 'note' ? '!' : '✗';
    if (!this.color) return sym;
    const code = status === 'ok' ? 32 : status === 'note' ? 33 : 31;
    return `\u001b[${code}m${sym}\u001b[0m`;
  }
}

export function pad(s: string, n: number): string {
  return s.length >= n ? `${s} ` : s + ' '.repeat(n - s.length);
}
