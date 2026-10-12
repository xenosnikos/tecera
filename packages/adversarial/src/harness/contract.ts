import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { event, ledgerProvenRun, type EvidenceRecord, type Principal, type ProvenOptions, type RunVerdict } from '@tecera/contracts';
import { SqliteLedger } from '@tecera/ledger';
import { cli, dump, fixturePlan, fixtureReplies, KEYS, ledgerEvents, pendingRequest, requestIdOf, runIdOf, sampleRepo, stopHook, type Ev, type Replies } from './e2e.js';
import { tmp } from './tmp.js';

/**
 * Acceptance contracts, the capability inventory and provisioning (owner decisions D8–D12) under attack:
 * `tecera run` end to end on a copy of the sample with scripted models (real ledger, sandbox, verify runner,
 * gates, git, local provisioner), with the business case's goal file carrying criteria, a free-text request
 * whose drafted contract holds for sign-off, connections in the manifest, and a scripts dir that may carry
 * the planner's contract draft (contract.json). Attacks append events out of band (a compromised component
 * with ledger access), edit files, or script the models; the refusal is read back from the ledger.
 */

export const GOAL_FILE = (dir: string): string => join(dir, '.tecera/goals/fix-failing-test.goal.md');
export const GOAL_ID = 'fix-failing-test';
/** The local human principals of these cases (D1): the requestor signs contracts off, the reviewer approves PRs. */
export const REQUESTOR = 'requestor-human';
export const REVIEWER = 'reviewer-human';

export interface CriterionLine {
  id: string;
  statement: string;
  verify?: string;
  ask?: string;
  requires?: string[];
  timeoutSec?: number;
}

/** Add `criteria:` to the sample goal file (one front-matter line, JSON flow style). */
export const withCriteria = (criteria: CriterionLine[]) => (dir: string): void => {
  const text = readFileSync(GOAL_FILE(dir), 'utf8');
  writeFileSync(GOAL_FILE(dir), text.replace(/^on-violation: wake-human$/m, `on-violation: wake-human\ncriteria: ${JSON.stringify(criteria)}`));
};

/** Rewrite the copy's tecera.json before `tecera init` and the base commit. */
export const editManifest = (f: (m: Record<string, any>) => void) => (dir: string): void => {
  const p = join(dir, 'tecera.json');
  const m = JSON.parse(readFileSync(p, 'utf8')) as Record<string, any>;
  f(m);
  writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`);
};

export const both = (...fs: Array<(dir: string) => void>) => (dir: string): void => {
  for (const f of fs) f(dir);
};

/** A scripts dir: plan.json (default: the shipped sample plan; null: none), replies.json and, when given, the planner's contract.json. */
export function contractScripts(o: { plan?: unknown; replies?: Partial<Replies>; contract?: unknown } = {}): string {
  const d = tmp('tecera-adv-cscripts-');
  if (o.plan !== null) writeFileSync(join(d, 'plan.json'), JSON.stringify(o.plan ?? fixturePlan()));
  writeFileSync(join(d, 'replies.json'), JSON.stringify(o.replies ?? fixtureReplies()));
  if (o.contract !== undefined) writeFileSync(join(d, 'contract.json'), JSON.stringify(o.contract));
  return d;
}

/** A run of the copy: the env every segment shares (test keys, its own worktrees and resources roots). */
export interface ContractRun {
  dir: string;
  env: Record<string, string>;
  runId: string;
}

export async function contractRepo(mutate?: (dir: string) => void): Promise<{ dir: string; env: Record<string, string> }> {
  const { dir, wt } = await sampleRepo(mutate ? { mutate } : {});
  return { dir, env: { ...KEYS, TECERA_WORKTREES: wt, TECERA_RESOURCES: join(tmp('tecera-adv-res-'), 'resources') } };
}

/** One segment: `tecera run <request>` or `tecera run --resume <run>`. */
export async function segment(dir: string, env: Record<string, string>, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  return cli(dir, argv, { env });
}

/** Run `request` (a goal name or a statement) to its first stop; returns the run with its id. */
export async function start(dir: string, env: Record<string, string>, request: string, scripts: string): Promise<ContractRun & { code: number; out: string; err: string }> {
  const r = await segment(dir, env, ['run', request, '--scripted', scripts]);
  const evs = await ledgerEvents(dir);
  return { ...r, dir, env, runId: evs.length ? runIdOf(evs) : '' };
}

export const resume = (run: ContractRun, scripts: string) => segment(run.dir, run.env, ['run', '--resume', run.runId, '--scripted', scripts]);

export async function runEvents(run: ContractRun): Promise<Ev[]> {
  return (await ledgerEvents(run.dir)).filter((e) => e.runId === run.runId || e.runId === undefined);
}

/** Approve the pending request as a local human (D1). */
export async function approvePending(run: ContractRun, as = REVIEWER): Promise<string> {
  const p = pendingRequest(await runEvents(run));
  if (!p) throw new Error(`no pending approval\n${await dump(run.dir)}`);
  const rid = requestIdOf(p)!;
  const a = await cli(run.dir, ['approve', rid, '--as', as, '--yes'], { env: run.env });
  if (a.code !== 0) throw new Error(`approve ${rid} failed (${a.code}): ${a.err}`);
  return rid;
}

let forged = 0;
/** Append an event out of band, chain-valid (a compromised component with ledger access). */
export async function forge(dir: string, kind: Parameters<typeof event>[0], o: { runId?: string; trace?: Record<string, string>; payload: Record<string, unknown>; actor?: Principal; at?: number }): Promise<string> {
  const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
  const id = `forged_c${++forged}`;
  try {
    await l.append(event(kind, { id, at: o.at ?? Date.now(), actor: o.actor ?? { kind: 'agent', id: 'worker' }, ...(o.runId ? { runId: o.runId } : {}), trace: o.trace ?? {}, payload: o.payload as never }));
  } finally {
    l.close();
  }
  return id;
}

/** Evidence of a run, read from its ledger. */
export async function runEvidence(dir: string, runId: string): Promise<EvidenceRecord[]> {
  const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
  try {
    return await l.listEvidence(runId);
  } finally {
    l.close();
  }
}

/** contracts ledgerProvenRun over the case's ledger (the single source of "achieved"). */
export async function verdictOf(dir: string, runId: string, opts: Omit<ProvenOptions, 'chain'> = {}): Promise<RunVerdict> {
  const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
  try {
    return await ledgerProvenRun(l, runId, opts);
  } finally {
    l.close();
  }
}

/**
 * A copy of a business case (repository and its ledger) at its current state, so one finished run serves
 * several out-of-band attacks, each on its own ledger. Only reads (the Stop hook, status, projections) run
 * on a copy: the worktree stays the original's.
 */
export function copyCase(dir: string): string {
  const to = tmp('tecera-adv-case-');
  cpSync(dir, to, { recursive: true, filter: (src) => !/[\\/]node_modules([\\/]|$)/.test(src) });
  if (!existsSync(join(to, '.tecera/ledger.sqlite'))) throw new Error('the copied case has no ledger');
  return to;
}

/** `tecera hook stop` and the stop.* event it recorded (D4: every decision is on the ledger). */
export async function stopDecision(dir: string): Promise<{ code: number; err: string; recorded: Ev | undefined }> {
  const before = (await ledgerEvents(dir)).length;
  const r = await stopHook(dir);
  const after = await ledgerEvents(dir);
  return { code: r.code, err: r.err, recorded: after.slice(before).find((e) => e.kind === 'stop.blocked' || e.kind === 'stop.allowed') };
}

export { dump, ledgerEvents, pendingRequest, requestIdOf };
