import { mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { sha256, type EvidenceRecord, type Json, type PoolUsage, type Redactor, type TeceraEvent } from '@tecera/contracts';
import type { Command } from '../cli/context.js';
import { costMarkdown, costReport } from '../cost.js';
import { CliError, EXIT } from '../errors.js';
import { toPosix } from '../util/fs.js';
import { safeWriteFile } from '../util/safefs.js';

/**
 * `tecera evidence <run> [--export dir]`: write the run's evidence bundle — summary.md, events.jsonl,
 * decisions.jsonl, index.json and evidence/<name>.json for every evidence key the run's events reference —
 * to `.tecera/runs/<run>/` (or the export dir). Everything written passes through the redactor and the
 * contained writer (no symlinks, no hard links).
 *
 * Supported references (anywhere in an event payload): a string under `evidenceKey`; every string in an
 * array under `evidence` or `evidenceKeys` that is not the id of an event of the run (goal.achieved lists
 * the verify.passed events it rests on). A reference whose record is not in the ledger is listed in
 * index.json and printed, and the command exits 1 (an incomplete bundle is never reported as complete).
 * File names are `<sanitised key prefix>.<sha8(key)>.json`, so different keys never share a file.
 */

export function evidenceKeys(v: Json, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) evidenceKeys(x, out);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'evidenceKey' && typeof x === 'string') out.add(x);
      else if ((k === 'evidence' || k === 'evidenceKeys') && Array.isArray(x)) {
        for (const y of x) if (typeof y === 'string') out.add(y);
        evidenceKeys(x, out);
      } else evidenceKeys(x, out);
    }
  }
  return out;
}

export function evidenceFileName(key: string): string {
  return `${key.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)}.${sha256(key).slice(0, 8)}.json`;
}

export function renderSummary(runId: string, events: ReadonlyArray<TeceraEvent>, evidence: ReadonlyArray<EvidenceRecord>, missing: ReadonlyArray<string>, redactor: Redactor, pools: PoolUsage[] = []): string {
  const lines: string[] = [`# Run ${runId}`, ''];
  const started = events.find((e) => e.kind === 'run.started');
  const ended = [...events].reverse().find((e) => e.kind === 'run.ended');
  if (started) lines.push(`- started: ${new Date(started.at).toISOString()} · manifest ${String((started.payload as { manifestHash?: string }).manifestHash ?? '').slice(0, 12)}`);
  if (ended) lines.push(`- outcome: ${(ended.payload as { reason?: string }).reason ?? '?'} (exit ${(ended.payload as { exitCode?: number }).exitCode ?? '?'})`);
  const goals = new Map<string, string>();
  for (const e of events) if (e.kind.startsWith('goal.') && e.trace.goalId) goals.set(e.trace.goalId, e.kind.slice(5));
  for (const [g, s] of goals) lines.push(`- goal ${g}: ${s}`);
  lines.push(`- events: ${events.length} · evidence records: ${evidence.length}${missing.length ? ` · MISSING: ${missing.length}` : ''}`, '', '## Gates', '');
  const achieved = [...events].reverse().find((e) => e.kind === 'goal.achieved');
  const proof = (achieved?.payload as { proof?: { command?: string; fingerprint?: string; evidenceKey?: string } } | undefined)?.proof;
  if (proof) lines.push(`- proof: \`${proof.command ?? '?'}\` exit 0 on ${String(proof.fingerprint ?? '?').slice(0, 12)} · evidence ${proof.evidenceKey ?? '?'}`);
  for (const e of events.filter((x) => x.kind === 'pr.opened' || x.kind === 'pr.requested')) {
    const p = e.payload as { url?: string; branch?: string; base?: string; bundle?: string; sha?: string };
    lines.push(`- ${e.kind === 'pr.opened' ? `PR opened: ${p.url ?? '?'}` : `PR requested (no remote or gh): ${p.branch ?? '?'} → ${p.base ?? '?'}${p.bundle ? ` · bundle ${p.bundle}` : ''}`} · ${String(p.sha ?? '').slice(0, 12)}`);
  }
  const gates = events.filter((e) => /^(verify|review)\.(passed|failed|rejected)$|^commit\.recorded$|^pr\.(opened|requested|failed)$|^approval\.(granted|denied|consumed)$/.test(e.kind));
  if (gates.length === 0) lines.push('- (no gate ran)');
  for (const e of gates) {
    const key = (e.payload as { evidenceKey?: string }).evidenceKey;
    const rec = key ? evidence.find((r) => r.key === key) : undefined;
    lines.push(`- ${e.kind} · step ${e.trace.stepId ?? '-'}${key ? ` · evidence ${key}` : ''}${rec ? ` sha256:${rec.digest.slice(0, 12)}` : key ? ' (MISSING)' : ''}`);
  }
  lines.push('', '## Steps', '');
  for (const e of events.filter((x) => x.kind === 'step.completed' || x.kind === 'step.failed' || x.kind === 'step.held')) {
    lines.push(`- ${e.kind} · ${e.trace.stepId}${(e.payload as { reason?: string }).reason ? ` · ${(e.payload as { reason?: string }).reason}` : ''}`);
  }
  lines.push('', costMarkdown(costReport(events, pools)));
  if (missing.length) lines.push('', '## Missing evidence', '', ...missing.map((k) => `- ${k}`));
  return redactor.redactText(`${lines.join('\n')}\n`);
}

export const evidenceCommand: Command = async (c) => {
  const runId = c.args.positionals[0];
  if (!runId || c.args.positionals.length > 1) throw new CliError('usage: tecera evidence <run> [--export dir]', EXIT.usage);
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new CliError(`not a run id: ${runId}`, EXIT.usage);
  const rt = c.runtime();
  if (!rt.ledgerExists()) throw new CliError('no ledger yet', EXIT.error);
  const ledger = rt.ledger();
  const events: TeceraEvent[] = [];
  for await (const e of ledger.events({ runId })) events.push(e);
  if (events.length === 0) {
    c.out.error(`evidence: no events for run ${runId}`);
    return EXIT.error;
  }
  const keys = new Set<string>();
  for (const e of events) evidenceKeys(e.payload, keys);
  // goal.achieved's `evidence` lists the verify.passed EVENTS it rests on; those are events of this run
  // (exported in events.jsonl), not evidence records.
  const eventIds = new Set(events.map((e) => e.id));
  for (const k of [...keys]) if (eventIds.has(k)) keys.delete(k);
  const records: EvidenceRecord[] = [];
  const missing: string[] = [];
  for (const k of [...keys].sort()) {
    const r = await ledger.getEvidence(k);
    if (r) records.push(r);
    else missing.push(k);
  }

  // Where to write: inside the business case (contained from its root) or an explicit export dir (contained from it).
  const dirArg = c.args.values.export;
  const dir = dirArg ? (isAbsolute(dirArg) ? dirArg : join(c.opts.cwd, dirArg)) : join(rt.root, '.tecera', 'runs', runId);
  const relToRoot = relative(rt.root, dir);
  const inside = relToRoot === '' || (!relToRoot.startsWith('..') && !isAbsolute(relToRoot));
  const base = inside ? rt.root : dir;
  const prefix = inside ? toPosix(relToRoot) : '';
  if (!inside) mkdirSync(dir, { recursive: true });
  const write = (name: string, content: string): void => safeWriteFile(base, prefix ? `${prefix}/${name}` : name, content);

  const r = rt.redactor;
  const jsonl = (xs: ReadonlyArray<unknown>): string => xs.map((x) => JSON.stringify(r.redactJson(x))).join('\n') + (xs.length ? '\n' : '');
  write('events.jsonl', jsonl(events));
  write('decisions.jsonl', jsonl(events.filter((e) => e.kind === 'decision.recorded').map((e) => (e.payload as { record?: Json }).record ?? e.payload)));
  const index: Record<string, Json> = {};
  for (const rec of records) {
    const file = `evidence/${evidenceFileName(rec.key)}`;
    write(file, `${JSON.stringify(r.redactJson(rec), null, 2)}\n`);
    index[rec.key] = { file, kind: rec.kind, digest: rec.digest };
  }
  write('index.json', `${JSON.stringify(r.redactJson({ runId, events: events.length, evidence: index, missing }), null, 2)}\n`);
  let pools: PoolUsage[] = [];
  try {
    pools = typeof ledger.budgetUsage === 'function' ? await ledger.budgetUsage(runId) : [];
  } catch {
    pools = [];
  }
  write('summary.md', renderSummary(runId, events, records, missing, r, pools));
  const shown = toPosix(relative(rt.root, dir)) || '.';
  await rt.append('evidence.exported', { runId, payload: { dir: shown.startsWith('..') ? dir.split(sep).join('/') : shown, events: events.length, evidence: records.length, missing } });
  c.out.say(`evidence ${runId} → ${shown}/ (summary.md, events.jsonl ${events.length}, decisions.jsonl, index.json, evidence/ ${records.length})`);
  for (const k of missing) c.out.error(`evidence: referenced record ${k} is not in the ledger`);
  c.out.set('dir', dir);
  c.out.set('events', events.length);
  c.out.set('evidence', records.length);
  c.out.set('missing', missing);
  return missing.length ? EXIT.error : EXIT.ok;
};
