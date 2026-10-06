/**
 * Exit codes and error types of the CLI (docs/design/dx.md §4). Exit codes are stable public API:
 * every command maps its outcome onto this table and nothing else. `NotWired` marks a seam whose
 * implementation lands in a later wave; it is never caught and turned into success.
 */

export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  invalid: 2,
  notReady: 3,
  held: 4,
  verifyFailed: 5,
  reviewRejected: 6,
  budget: 7,
  policy: 8,
  ledger: 9,
  notWired: 9,
  interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A seam that is declared and typed but not implemented yet. */
export class NotWired extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'NotWired';
  }
}

/** A failure the CLI reports as one line with a fixed exit code. */
export class CliError extends Error {
  constructor(message: string, public readonly exitCode: number, public readonly issues: string[] = []) {
    super(message);
    this.name = 'CliError';
  }
}

export const RUNTIME_VERSION = '0.1.0';
