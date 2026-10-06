import { RedactionError, type VerifyRunner } from '@tecera/contracts';
import { PermissionsError } from '@tecera/policy';
import { adaptersCommand } from '../commands/adapters.js';
import { approveCommand, denyCommand } from '../commands/approve.js';
import { doctorCommand } from '../commands/doctor.js';
import { evidenceCommand } from '../commands/evidence.js';
import { gateCommand, migrateCommand } from '../commands/gate.js';
import { hookCommand } from '../commands/hook.js';
import { initCommand } from '../commands/init.js';
import { memoryCommand, plansCommand } from '../commands/learning.js';
import { preflightCommand } from '../commands/preflight.js';
import { runCommand } from '../commands/run.js';
import { statusCommand } from '../commands/status.js';
import { validateCommand } from '../commands/validate.js';
import { whyCommand } from '../commands/why.js';
import { CliError, EXIT, RUNTIME_VERSION } from '../errors.js';
import { UnsafeEnvError } from '../env.js';
import { PrincipalError } from '../principal.js';
import { ManifestLoadError } from '../manifest/load.js';
import { envRedactor, envSecretInputs } from '../secrets.js';
import { UnsafePathError } from '../util/safefs.js';
import type { IdGen } from '../util/ids.js';
import type { Env } from '../util/proc.js';
import type { SeatProbe, WireFn } from '../wiring.js';
import { parseArgs, UsageError } from './args.js';
import { makeContext, type Command } from './context.js';
import { Out, type CliIO } from './io.js';

/**
 * `tecera` entry point: parse global flags, route to a subcommand, map every failure onto the exit-code
 * table (dx.md §4). Never throws: unexpected errors print one line and exit 1. Everything the process
 * would read from globals (cwd, env, stdio, clock, ids, verify runner, seat probe, run wiring) is
 * injectable through MainOptions for tests and embedding.
 */

export interface MainOptions {
  cwd?: string;
  env?: Env;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Hook payload for `tecera hook`; default reads process.stdin. */
  stdin?: string | (() => Promise<string>);
  isTTY?: boolean;
  now?: () => number;
  ids?: IdGen;
  verifyRunner?: VerifyRunner;
  probe?: SeatProbe;
  wire?: WireFn;
  assetsRoot?: string;
  signal?: AbortSignal;
}

export const COMMANDS: Record<string, { run: Command; summary: string }> = {
  init: { run: initCommand, summary: 'init [dir] [--sample --dry-run --interactive --profile p --writer p/m --reviewer p/m]' },
  validate: { run: validateCommand, summary: 'validate [--strict]                      offline checks; exit 2 on issues' },
  doctor: { run: doctorCommand, summary: 'doctor [--skip-live --fix]               readiness; exit 3 when something is missing' },
  preflight: { run: preflightCommand, summary: 'preflight <goal> [--skip-live]           doctor + goal, worktree, base, baseline, budget' },
  run: { run: runCommand, summary: 'run <goal|statement> [--dry-run --budget-usd n --max-depth n --scripted dir] | run --resume <runId>' },
  approve: { run: approveCommand, summary: 'approve <request> [--as <you>] [--reason] explicit human approval (default $USER)' },
  deny: { run: denyCommand, summary: 'deny <request> [--as <you>] --reason <text>' },
  status: { run: statusCommand, summary: 'status [--run id]                        last run, goals, intentions, held approvals' },
  evidence: { run: evidenceCommand, summary: 'evidence <run> [--export dir]             write the redacted evidence bundle' },
  why: { run: whyCommand, summary: 'why <event>                              action → step → intention → goal → event' },
  gate: { run: gateCommand, summary: 'gate <goal>                              re-run the check; failure demotes (exit 5)' },
  plans: { run: plansCommand, summary: 'plans candidates|graduate|reject|retract <id> --rationale <text> [--as id]' },
  memory: { run: memoryCommand, summary: 'memory candidates|graduate|reject|retract <id> --rationale <text> [--as id]' },
  adapters: { run: adaptersCommand, summary: 'adapters install|upgrade|doctor <host> [--force]' },
  hook: { run: hookCommand, summary: 'hook pre-tool|stop                       host hooks (JSON on stdin)' },
  migrate: { run: migrateCommand, summary: 'migrate [--to v]                         nothing to migrate in v1' },
};

export function helpText(): string {
  return [
    `tecera ${RUNTIME_VERSION}`,
    '',
    'usage: tecera <command> [args] [--json --quiet --manifest <path> --no-color --yes]',
    '',
    ...Object.values(COMMANDS).map((c) => `  ${c.summary}`),
    '',
    'exit: 0 ok · 1 error · 2 invalid/usage · 3 not ready · 4 held · 5 verify failed · 6 review rejected',
    '      7 budget · 8 policy · 9 ledger/not wired · 130 interrupted',
    '--yes never approves anything; approvals are always an explicit `tecera approve`.',
  ].join('\n');
}

async function readProcessStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(argv: string[], options: MainOptions = {}): Promise<number> {
  const io: CliIO = {
    stdout: options.stdout ?? ((s) => void process.stdout.write(s)),
    stderr: options.stderr ?? ((s) => void process.stderr.write(s)),
    readStdin: typeof options.stdin === 'string' ? async () => options.stdin as string : options.stdin ?? readProcessStdin,
    isTTY: options.isTTY ?? (!options.stdout && !!process.stdout.isTTY),
  };
  const env = options.env ?? process.env;
  const envSecrets = envSecretInputs(env);
  const baseRedactor = envRedactor(env);
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.stderr(baseRedactor.redactText(`tecera: ${(e as Error).message}\n${helpText()}\n`));
    return EXIT.usage;
  }
  const out = new Out(io, args, env, baseRedactor);
  if (args.bools.version) {
    out.say(RUNTIME_VERSION);
    out.set('version', RUNTIME_VERSION);
    out.flushJson('version', EXIT.ok);
    return EXIT.ok;
  }
  const name = args.positionals.shift();
  if (!name || args.bools.help) {
    if (name && COMMANDS[name]) out.say(`usage: tecera ${COMMANDS[name]!.summary}`);
    else out.say(helpText());
    return name && !COMMANDS[name] ? EXIT.usage : EXIT.ok;
  }
  const cmd = COMMANDS[name];
  if (!cmd) {
    out.error(`tecera: unknown command ${name}\n${helpText()}`);
    return EXIT.usage;
  }
  const ctx = makeContext(args, out, io, {
    cwd: options.cwd ?? process.cwd(),
    env,
    now: options.now ?? Date.now,
    ids: options.ids,
    verifyRunner: options.verifyRunner,
    probe: options.probe,
    wire: options.wire,
    assetsRoot: options.assetsRoot,
    signal: options.signal,
    envSecrets,
  });
  let code: number;
  try {
    code = await cmd.run(ctx);
  } catch (e) {
    code = mapError(e, out, name);
  } finally {
    ctx.dispose();
  }
  out.flushJson(name, code);
  return code;
}

function mapError(e: unknown, out: Out, name: string): number {
  if (e instanceof CliError) {
    out.error(`${name}: ${e.message}`);
    for (const i of e.issues) out.error(`  ${i}`);
    out.set('error', e.message);
    return e.exitCode;
  }
  if (e instanceof ManifestLoadError) {
    out.error(`${name}: ${e.message}`);
    for (const i of e.issues) out.error(`  ${i}`);
    out.set('error', e.message);
    out.set('issues', e.issues);
    return name === 'doctor' || name === 'preflight' ? EXIT.notReady : EXIT.invalid;
  }
  if (e instanceof PermissionsError || e instanceof UnsafeEnvError) {
    out.error(`${name}: ${e.message}`);
    out.set('error', e.message);
    return EXIT.invalid;
  }
  if (e instanceof UnsafePathError || e instanceof PrincipalError) {
    out.error(`${name}: ${e.message}`);
    out.set('error', e.message);
    return e instanceof PrincipalError ? e.exitCode : EXIT.policy;
  }
  if (e instanceof RedactionError) {
    out.error(`${name}: ${e.message}`);
    out.set('error', e.message);
    return EXIT.notReady;
  }
  out.error(`${name}: ${(e as Error)?.message ?? String(e)}`);
  out.set('error', (e as Error)?.message ?? String(e));
  return EXIT.error;
}
