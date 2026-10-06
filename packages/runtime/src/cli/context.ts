import type { SecretInput, VerifyRunner } from '@tecera/contracts';
import { Runtime } from '../runtime.js';
import type { IdGen } from '../util/ids.js';
import type { Env } from '../util/proc.js';
import type { SeatProbe, WireFn } from '../wiring.js';
import type { ParsedArgs } from './args.js';
import type { CliIO, Out } from './io.js';

/** What every command receives. The runtime (manifest + ledger) is loaded lazily: init/hook work without it. */

export interface ResolvedOptions {
  cwd: string;
  env: Env;
  now: () => number;
  ids?: IdGen;
  verifyRunner?: VerifyRunner;
  probe?: SeatProbe;
  wire?: WireFn;
  /** Directory holding `templates/` and `samples/`; resolved from the package location by default. */
  assetsRoot?: string;
  signal?: AbortSignal;
  /** Secret values captured from the environment at CLI start (before any were deleted). */
  envSecrets?: readonly SecretInput[];
}

export interface CommandContext {
  args: ParsedArgs;
  out: Out;
  io: CliIO;
  opts: ResolvedOptions;
  /** Load (once) the business case found from cwd or --manifest. Throws ManifestLoadError. */
  runtime(): Runtime;
}

export type Command = (c: CommandContext) => Promise<number>;

export function makeContext(args: ParsedArgs, out: Out, io: CliIO, opts: ResolvedOptions): CommandContext & { dispose(): void } {
  let rt: Runtime | null = null;
  return {
    args,
    out,
    io,
    opts,
    runtime(): Runtime {
      if (!rt) {
        rt = new Runtime({
          cwd: opts.cwd,
          manifestPath: args.values.manifest,
          env: opts.env,
          now: opts.now,
          ids: opts.ids,
          verifyRunner: opts.verifyRunner,
          probe: opts.probe,
          wire: opts.wire,
          extraSecrets: opts.envSecrets,
        });
        out.useRedactor(rt.redactor);
      }
      return rt;
    },
    dispose(): void {
      rt?.close();
      rt = null;
    },
  };
}
