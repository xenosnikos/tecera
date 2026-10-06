import { mkdirSync } from 'node:fs';
import { seatVendor, type Json } from '@tecera/contracts';
import { checkAdapter, enabledHosts } from '../adapters/install.js';
import type { CommandContext, Command } from '../cli/context.js';
import { pad } from '../cli/io.js';
import { EXIT, NotWired } from '../errors.js';
import { listGoalIds } from '../goals.js';
import { computeLock, locateManifest, lockDrift, ManifestLoadError, readLock, writeLock } from '../manifest/load.js';
import { hasErrors, validateBusinessCase } from '../manifest/validate.js';
import type { Runtime } from '../runtime.js';
import { reviewAllowlist } from '../env.js';
import { gitSync, onPath, repoExecHazards } from '../util/proc.js';
import { PlannedFs } from '../vfs.js';
import type { SeatRef } from '../wiring.js';

/**
 * `tecera doctor [--skip-live] [--fix]`: is this machine and business case ready? Node and git, the
 * manifest (full validate), provider keys (names only), live seat probes with cost (injectable; not
 * wired until wave 2, which counts as missing), sandbox prerequisites, isolation, ledger writable
 * (appends doctor.ran), adapters current, lock pinned. Any missing → exit 3. `--fix` re-pins the lock.
 * Provider credentials are reported by name from the runtime's SecretStore resolution (the values were
 * taken out of the environment); probe results and errors are redacted before they are printed or recorded.
 * Ordering: live probes (real model calls, real cost) run LAST and only when every offline check passed —
 * manifest, credentials, ledger chain, adapters, lock. A drifted or corrupt business case never reaches a
 * model; the probes are reported as not run instead.
 * A repository whose local git config can run programs (filters, textconv, includes) is reported missing
 * and `git status` is not run on it.
 */

export type CheckStatus = 'ok' | 'note' | 'missing';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export const SANDBOX_TOOLS = ['bwrap', 'unshare', 'systemd-run'] as const;

export function sandboxPrereqs(env: Record<string, string | undefined>): Record<string, boolean> {
  return Object.fromEntries(SANDBOX_TOOLS.map((t) => [t, onPath(t, env)]));
}

export function envKeyName(auth: string): string | null {
  const m = /^env:([A-Z_][A-Z0-9_]*)$/.exec(auth);
  return m ? m[1]! : null;
}

export function seatRefs(rt: Runtime): SeatRef[] {
  const s = rt.manifest.seats;
  return [
    { role: 'planner', id: 'planner', provider: s.planner.provider, model: s.planner.model },
    ...s.workers.map((w) => ({ role: 'worker' as const, id: w.id, provider: w.provider, model: w.model })),
    { role: 'reviewer', id: 'reviewer', provider: s.reviewer.provider, model: s.reviewer.model },
  ];
}

/** Run every doctor check. `rt` is null when the manifest does not load; machine checks still run. */
export async function doctorChecks(c: CommandContext, opts: { skipLive: boolean; fix: boolean; appendEvent: boolean }): Promise<{ checks: Check[]; rt: Runtime | null }> {
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string): void => void checks.push({ name, status, detail });
  const env = c.opts.env;

  // manifest
  let rt: Runtime | null = null;
  try {
    const path = locateManifest(c.opts.cwd, c.args.values.manifest);
    const v = validateBusinessCase(path);
    const errors = v.issues.filter((i) => i.level === 'error');
    const lockErrors = errors.filter((i) => i.where === '.tecera/tecera.lock');
    if (hasErrors(v) && errors.length !== lockErrors.length) {
      add('manifest', 'missing', `${errors.length} validation error(s): ${errors.slice(0, 3).map((i) => `${i.where}: ${i.message}`).join('; ')}`);
    } else {
      rt = c.runtime();
      add('manifest', 'ok', `tecera.json schema v1 · no inline secrets · hash ${rt.manifestHash.slice(0, 12)}`);
    }
  } catch (e) {
    if (e instanceof ManifestLoadError) add('manifest', 'missing', e.message);
    else throw e;
  }

  // node / git
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 20 ? 'ok' : 'missing', `v${process.versions.node}${major >= 20 ? '' : ' (need >= 20)'}`);
  const gv = gitSync(c.opts.cwd, ['--version'], { env });
  if (gv.code !== 0) add('git', 'missing', 'git not found');
  else {
    const root = rt?.root ?? c.opts.cwd;
    const inside = gitSync(root, ['rev-parse', '--is-inside-work-tree'], { env });
    const ver = gv.stdout.trim().replace(/^git version /, '');
    const hazards = inside.code === 0 ? repoExecHazards(root, env) : [];
    if (inside.code !== 0) add('git', 'note', `${ver} · not a git repository (commit gates need one)`);
    else if (hazards.length) add('git', 'missing', `${ver} · repository config can run programs (${hazards.join(', ')}); remove them — tecera does not run git status here`);
    else {
      const dirty = gitSync(root, ['status', '--porcelain'], { env }).stdout.trim();
      const head = gitSync(root, ['rev-parse', '--short', 'HEAD'], { env });
      add('git', 'ok', `${ver} · ${dirty ? 'dirty' : 'clean'} · HEAD ${head.code === 0 ? head.stdout.trim() : '(no commits)'}`);
    }
  }

  if (rt) {
    // providers (names only, never values): resolved by the runtime's SecretStore, then removed from env
    const keyNotes: string[] = [];
    let keysMissing = false;
    for (const st of rt.secretStatus) {
      const label = st.envName ?? `${st.ref.split(':')[0]} reference`;
      if (st.resolved) keyNotes.push(`${st.provider}: ${label} set`);
      else {
        keysMissing = true;
        keyNotes.push(`${st.provider}: ${st.envName ? `${st.envName} not set` : `${label} unresolved (${rt.redact(st.error ?? 'error')})`}`);
      }
    }
    add('providers', keysMissing ? (opts.skipLive ? 'note' : 'missing') : 'ok', keyNotes.join(' · '));

    // verify environment: the repository's request against the supervisor's SAFE_ENV
    const review = reviewAllowlist(rt.manifest.sandbox.envAllowlist);
    if (review.unsafe.length) add('verify-env', 'missing', `sandbox.envAllowlist requests unsafe names: ${review.unsafe.map((u) => `${u.name} (${u.why})`).join(', ')}`);
    else add('verify-env', review.ignored.length ? 'note' : 'ok', `passes ${review.granted.join(', ') || 'nothing'}${review.ignored.length ? ` · not on SAFE_ENV, dropped: ${review.ignored.join(', ')}` : ''}`);

    // D5: review is always foreign (the manifest refuses anything else); the gate re-checks provider AND key.
    const s = rt.manifest.seats;
    const writers = [s.planner, ...s.workers].map((w) => `${w.provider}/${seatVendor(w)}`);
    add('reviewer', 'ok', `${s.reviewer.provider}/${s.reviewer.model} · foreign (vendor ${seatVendor(s.reviewer)}, credential ${rt.manifest.providers[s.reviewer.provider]?.auth ?? '?'}) to writers ${[...new Set(writers)].join(', ')}`);
    add('budgets', 'note', rt.manifest.budgets.enforce ? `enforced: $${rt.manifest.budgets.usd} · ${rt.manifest.budgets.tokens} tokens · ${rt.manifest.budgets.wallClockSec}s end a run (exit 7)` : `not enforced (budgets.enforce false): $${rt.manifest.budgets.usd} · ${rt.manifest.budgets.tokens} tokens · ${rt.manifest.budgets.wallClockSec}s are recorded and reported, never a stop`);
  }

  // sandbox
  const pre = sandboxPrereqs(env);
  const present = Object.entries(pre).filter(([, v]) => v).map(([k]) => k);
  const profile = rt?.manifest.sandbox.profile ?? 'process';
  if (profile === 'bwrap' && !pre.bwrap) add('sandbox', 'missing', 'profile "bwrap" but bwrap is not on PATH');
  else add('sandbox', pre.bwrap ? 'ok' : 'note', `profile "${profile}" · found: ${present.join(', ') || 'none'}${pre.bwrap ? '' : ' · install bubblewrap for OS isolation'}`);
  if (rt?.manifest.sandbox.isolation === 'node') add('isolation', 'note', 'isolation "node" is degraded (no OS isolation); runs record isolation.degraded; work-branch writes proceed fenced, the PR gate is the approval point');

  // ledger
  if (rt) {
    try {
      if (opts.appendEvent) mkdirSync(rt.root, { recursive: true });
      const l = rt.ledger();
      const chain = await l.verifyChain();
      if (!chain.ok) add('ledger', 'missing', `hash chain broken at seq ${chain.brokenAtSeq}`);
      else add('ledger', 'ok', `${rt.manifest.ledger.driver} writable · ${chain.length} events · chain valid`);
    } catch (e) {
      add('ledger', 'missing', `not writable: ${(e as Error).message}`);
    }

    // adapters
    const fs = new PlannedFs(rt.root);
    const hosts = enabledHosts(fs, rt.manifest.adapters);
    if (hosts.length === 0) add('adapters', 'note', 'no adapters enabled');
    for (const h of hosts) {
      try {
        const rep = checkAdapter(fs, h, { manifest: rt.manifest, permissions: rt.permissions, read: (p) => fs.read(p), goals: listGoalIds(rt.root), redactor: rt.redactor });
        const stale = rep.filter((r) => !r.ok);
        const unprotected = stale.filter((r) => r.security);
        add(
          `adapter:${h}`,
          unprotected.length ? 'missing' : stale.length ? 'note' : 'ok',
          stale.length ? `${unprotected.length ? 'NOT PROTECTED — ' : ''}stale: ${stale.map((s) => `${s.target} (${s.detail})`).join(', ')} → tecera adapters install ${h}` : rep.map((r) => r.target).join(' · '),
        );
      } catch (e) {
        add(`adapter:${h}`, 'missing', (e as Error).message);
      }
    }

    // lock
    try {
      const pinned = readLock(rt.root);
      const current = computeLock(rt.root, rt.manifestHash);
      const drift = pinned ? lockDrift(pinned, current) : ['no lock file'];
      if (drift.length && opts.fix) {
        writeLock(rt.root, current);
        add('lock', 'ok', `re-pinned (${drift.length} change(s) accepted)`);
      } else if (drift.length) add('lock', 'missing', `${drift.join('; ')} → review, then tecera doctor --fix`);
      else add('lock', 'ok', 'manifest, permissions, skills and adapters match tecera.lock');
    } catch (e) {
      add('lock', 'missing', (e as Error).message);
    }

    // D6: commits land on the work branch without approval; the PR is the approval point (D1: local principal).
    add('policy', 'note', `approvals: ${rt.manifest.policy.approvals.required.join(', ')} — the PR gate holds (exit 4) until \`tecera approve <request> [--as <you>]\` (default $USER, never the requester); Tecera never merges`);

    // live seats: last, and only when everything offline is ready
    if (opts.skipLive) add('seats', 'note', 'live probes skipped (--skip-live)');
    else await liveSeatChecks(c, rt, checks);
  }
  return { checks, rt };
}

/** Ceiling on what one doctor's live probes may spend before the remaining seats are skipped. */
export const PROBE_COST_CAP_USD = 0.05;

/**
 * Live seat probes (one real completion per seat, through @tecera/providers doctorProbe). Run only when no check so far is missing: otherwise one
 * 'seats' entry reports them as not run (missing), and no model is called.
 */
export async function liveSeatChecks(c: CommandContext, rt: Runtime, checks: Check[]): Promise<void> {
  const add = (name: string, status: CheckStatus, detail: string): void => void checks.push({ name, status, detail });
  const blocking = checks.filter((k) => k.status === 'missing');
  if (blocking.length) {
    add('seats', 'missing', `live probes not run: not ready (${blocking.map((k) => k.name).join(', ')}); no model was called`);
    return;
  }
  let spent = 0;
  for (const seat of seatRefs(rt)) {
    // Probes are tiny; a probe set that somehow costs more than the cap stops before the next seat.
    if (spent > PROBE_COST_CAP_USD) {
      add(`${seat.role}${seat.role === 'worker' ? `:${seat.id}` : ''}`, 'missing', `not probed: live probes already cost $${spent.toFixed(4)} (cap $${PROBE_COST_CAP_USD})`);
      continue;
    }
    try {
      const r = await rt.probe(seat, { manifest: rt.manifest, env: rt.env, secrets: rt.secretStore, redactor: rt.redactor, signal: c.opts.signal });
      spent += Number(r.usd) || 0;
      add(`${seat.role}${seat.role === 'worker' ? `:${seat.id}` : ''}`, r.ok ? 'ok' : 'missing', rt.redact(`${seat.provider}/${seat.model} — ${r.ok ? 'live completion ok' : `failed${r.detail ? `: ${r.detail}` : ''}`} (${r.latencyMs}ms, $${Number(r.usd).toFixed(4)}${r.usageUnknown ? ' or less: usage not reported' : ''})`));
    } catch (e) {
      add(`${seat.role}${seat.role === 'worker' ? `:${seat.id}` : ''}`, 'missing', rt.redact(`${seat.provider}/${seat.model} — ${e instanceof NotWired ? `not wired: ${e.message}` : (e as Error)?.message ?? String(e)}`));
    }
  }
}

export function summarize(checks: Check[]): { ok: number; notes: number; missing: number } {
  return {
    ok: checks.filter((c) => c.status === 'ok').length,
    notes: checks.filter((c) => c.status === 'note').length,
    missing: checks.filter((c) => c.status === 'missing').length,
  };
}

export function printChecks(c: CommandContext, checks: Check[]): void {
  for (const k of checks) c.out.say(`${c.out.mark(k.status)} ${pad(k.name, 11)}${k.detail}`);
}

export const doctorCommand: Command = async (c) => {
  const { checks, rt } = await doctorChecks(c, { skipLive: !!c.args.bools['skip-live'], fix: !!c.args.bools.fix, appendEvent: true });
  const s = summarize(checks);
  if (rt && checks.find((k) => k.name === 'ledger')?.status === 'ok') {
    await rt.append('doctor.ran', { payload: { ...s, skipLive: !!c.args.bools['skip-live'], checks: checks as unknown as Json, manifestHash: rt.manifestHash } });
  }
  printChecks(c, checks);
  const code = s.missing ? EXIT.notReady : EXIT.ok;
  c.out.say(`${s.ok} ok · ${s.notes} note(s) · ${s.missing} missing → exit ${code}`);
  c.out.set('checks', checks as unknown as Json);
  c.out.set('summary', s);
  return code;
};
