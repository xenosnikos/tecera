#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBench, type BenchMode, type BenchResult, type RunnerOptions } from './runner.js';

/**
 * `node packages/bench/dist/cli.js run --mode scripted|live [--scenarios 1,2,..] [--out <dir>]
 * [--baseline "<command>"] [--baseline-name <name>] [--timeout-sec <n>] [--keep]`
 *
 * Runs the scenarios, writes scorecard.json and scorecard.md to `--out` (default ./bench-out), and prints
 * one line per scenario. Exit 0 when every scenario met its pass rule, 1 when one did not, 2 on a usage
 * error. Live mode reads the provider keys the fixtures' manifests name from the environment; it never
 * prints them.
 */

export const USAGE = 'usage: bench run --mode scripted|live [--scenarios 1,2,..] [--out dir] [--baseline "<command>"] [--baseline-name name] [--timeout-sec n] [--keep]';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const VALUE_FLAGS = new Set(['--mode', '--scenarios', '--out', '--baseline', '--baseline-name', '--timeout-sec']);

/** Parse `run ...` into runner options (throws UsageError). */
export function parseCli(argv: readonly string[]): RunnerOptions & { out: string } {
  const [cmd, ...rest] = argv;
  if (cmd !== 'run') throw new UsageError(cmd ? `unknown command ${cmd}` : 'missing command');
  const v: Record<string, string> = {};
  let keep = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const eq = a.indexOf('=');
    const [flag, inline] = a.startsWith('--') && eq > 0 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, undefined];
    if (flag === '--keep') keep = true;
    else if (VALUE_FLAGS.has(flag)) {
      const val = inline ?? rest[++i];
      if (val === undefined) throw new UsageError(`${flag} needs a value`);
      v[flag] = val;
    } else throw new UsageError(`unknown argument ${a}`);
  }
  const mode = v['--mode'];
  if (mode !== 'scripted' && mode !== 'live') throw new UsageError('--mode must be scripted or live');
  let scenarios: number[] | undefined;
  if (v['--scenarios'] !== undefined) {
    const list = v['--scenarios'].split(',').map((s) => s.trim());
    if (list.some((s) => !/^\d{1,2}$/.test(s))) throw new UsageError('--scenarios is a comma-separated list of scenario numbers');
    scenarios = list.map(Number);
  }
  let timeoutSec: number | undefined;
  if (v['--timeout-sec'] !== undefined) {
    timeoutSec = Number(v['--timeout-sec']);
    if (!Number.isInteger(timeoutSec) || timeoutSec <= 0) throw new UsageError('--timeout-sec must be a positive integer');
  }
  if (v['--baseline'] !== undefined && !v['--baseline'].trim()) throw new UsageError('--baseline needs a command');
  return {
    mode: mode as BenchMode,
    out: resolve(v['--out'] ?? 'bench-out'),
    ...(scenarios ? { scenarios } : {}),
    ...(v['--baseline'] !== undefined ? { baseline: v['--baseline'] } : {}),
    ...(v['--baseline-name'] !== undefined ? { baselineName: v['--baseline-name'] } : {}),
    ...(timeoutSec !== undefined ? { timeoutSec } : {}),
    ...(keep ? { keep } : {}),
  };
}

/** One line per scenario, then the headline. */
export function summaryLines(r: BenchResult): string[] {
  const lines = r.runs.map((x) => {
    const s = x.score;
    const failed = s.rules.filter((y) => !y.ok).map((y) => y.rule);
    const base = x.baseline ? ` · baseline ${x.baseline.passed ? 'pass' : 'fail'}` : '';
    return `${s.passed ? 'pass' : 'FAIL'}  ${x.scenario.id}  touches ${x.touches.length}${failed.length ? `  failed: ${failed.join(', ')}` : ''}${x.stopped ? `  (${x.stopped})` : ''}${base}`;
  });
  const t = r.card.totals;
  lines.push(`${t.passed}/${t.scenarios} scenarios passed`);
  if (r.files) lines.push(`wrote ${r.files.json} and ${r.files.md}`);
  return lines;
}

export async function main(argv: readonly string[], io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => void process.stdout.write(s), err: (s) => void process.stderr.write(s) }): Promise<number> {
  let opts: RunnerOptions & { out: string };
  try {
    opts = parseCli(argv);
  } catch (e) {
    io.err(`bench: ${(e as Error).message}\n${USAGE}\n`);
    return 2;
  }
  try {
    const r = await runBench({ ...opts, log: (l) => io.err(`${l}\n`) });
    for (const l of summaryLines(r)) io.out(`${l}\n`);
    return r.runs.every((x) => x.score.passed) ? 0 : 1;
  } catch (e) {
    io.err(`bench: ${(e as Error).message}\n`);
    return 1;
  }
}

const invoked = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) process.exitCode = await main(process.argv.slice(2));
