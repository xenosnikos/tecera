import { resolve } from 'node:path';
import {
  capabilityInventoryOf,
  criterionEvidenceKey,
  describeUnexpected,
  LedgerError,
  resourceRegistryOf,
  type AcceptanceContract,
  type CapabilityRecord,
  type Criterion,
  type CriterionProof,
  type EnvironmentalCheck,
  type Fidelity,
  type Json,
  type Ledger,
  type Manifest,
  type ProvisionedResource,
  type Redactor,
  type SecretInput,
  type TeceraEvent,
  type VerifyOutcome,
  type VerifyRunner,
} from '@tecera/contracts';
import { fileManifest, snapshotCandidate, type Candidate } from './candidate.js';
import { commandCriteria, commandUsesResource, contractOf, criterionFidelity, inventoryById, LOCATED_KINDS, NETWORK_KINDS, resourceEnvName, shellExports, withLedgerMocks } from './criteria.js';
import { commandDigest, defaultIds, errMsg, GateMemo, IGNORED_BASELINE_VERSION, ignoredBaseline, ignoredBaselineKey, ignoredBaselineOf, keyPart, obj, redactorFrom, safeText, tail, writeEvidence } from './evidence.js';
import { UnsafeRepo } from './gitx.js';
import { envelopeView, type EnvelopeView } from './envelope.js';
import { workBranchOf } from './intentionBranch.js';
import { EXIT, TOOLING_EXITS, type StepContext, type VerifyOutcomeKind, type VerifyResult } from './types.js';

/**
 * Verify gate (security.md §5, recovery S4/S6). The candidate is snapshotted by the host before and after
 * the check command runs in a separate scrubbed process; the "before" snapshot is the freeze (D1): its
 * fingerprint is returned to the loop and its per-file {path, status, mode, sha256, oid} record is stored
 * in evidence.
 *
 * Which command: the adopted goal's check (GateContext.goal.check) wins over the manifest's verify command
 * when they differ; its timeout is capped by the manifest's. Evidence records both commands, which one
 * ran (checkSource) and its digest, and the commit gate refuses a verify whose digest is not the goal's.
 * A goal check that is present but malformed is refused (9), never replaced by the manifest's.
 *
 * Outcomes: a changed fingerprint is 'mutated' (9, terminal) even when the command exited 0. Exit
 * 124/126/127, a timeout, a signal, a cancellation or a runner that cannot start are tooling (terminal).
 * Truncated output (either stream hit its cap, or the runner cannot say) never passes: exit 0 with
 * truncated output is a failure (1). A failing command returns exit 1 (retryable) whatever code the test
 * runner used, so a runner exiting 8 or 9 is never mistaken for a gate refusal. A missing worktree ('' in
 * GateContext) or an unsafe repository is refused (9, terminal) before anything runs.
 *
 * Interrupted verify (S4): before the command runs, a start record {D1} is written under a deterministic
 * key per (run, intention, step, attempt, n); the result is written under the matching key. A later verify
 * of the same step that finds a start without a result (the process died mid-verify, ctx.recovered or not)
 * re-snapshots and must see D1 again: a different tree is 'mutated' (9, terminal, human), never re-run.
 *
 * Acceptance contract (D8, D11): with GateContext.contract every command criterion runs in the same contained
 * process against the same frozen candidate, after the start record and before the goal check, which stays
 * the final verify of the step. Each criterion gets its own gate.verify evidence (criterionEvidenceKey on
 * a pass) and, when it exits 0 on D1, one CriterionProof whose fidelity is fidelityOf over the capabilities
 * it requires in GateContext.inventory. A capability GateContext lists as missing counts as mocked when the run's
 * ledger inventory records a stand-in for it (capability.mocked after the context was built). A required
 * capability that is missing proves nothing: the gate refuses (9) before anything runs and names the criterion.
 * A criterion that requires a provisioned sqlite / tmpdir gets its locator in TECERA_RESOURCE_<ID>
 * (resourceEnvName) inside the contained process, and is proven at fidelity provisioned only when its command
 * names that variable or the locator; one that ignores the resource (its own :memory: or temp database) proves
 * nothing about it and is recorded mocked. A provisioned http-stub is out of a criterion's reach (criteria run
 * without network, NETWORK_KINDS): no locator is handed over and the criterion is recorded mocked. A criterion that exits non-zero fails the step
 * (1, retryable, named in failedCriteria) and the goal check does not run; a criterion that mutates the
 * tree, times out or cannot start is terminal like the goal check. A goal that names a contract while
 * GateContext carries none is refused (9).
 *
 * Diagnostics: every string a result carries (`reason`, built from runner exceptions, snapshot and
 * repository errors) is redacted with the shared redactor when it is built, before it reaches either the
 * returned result or the evidence; a terminal result carries `failure: 'human'`.
 */

export interface VerifyGateOptions {
  ledger: Ledger;
  manifest: Manifest;
  runner: VerifyRunner;
  /** Expected worktree. When set, a GateContext naming a different worktree is refused. */
  worktree?: string;
  /** Diff base for fingerprints. Defaults to manifest.repo.base. */
  base?: string;
  redactor?: Redactor;
  secrets?: readonly SecretInput[];
  now?: () => number;
  ids?: () => string;
  memo?: GateMemo;
  /** Cap for stdout/stderr tails in evidence (chars, after redaction). Default 8 KiB. */
  tailCap?: number;
}

/** Env names that must never reach a test process, whatever the manifest allowlist says. */
const SECRETISH = /(KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE)/i;

export function scrubbedAllowlist(m: Manifest): string[] {
  const providerRefs = new Set(
    Object.values(m.providers)
      .map((p) => /^env:([A-Z_][A-Z0-9_]*)$/.exec(p.auth)?.[1])
      .filter((x): x is string => !!x),
  );
  return [...new Set(m.sandbox.envAllowlist)].filter((n) => !providerRefs.has(n) && !SECRETISH.test(n)).sort();
}

/** The worktree a gate may act on: GateContext's, which must be set and match the configured one. */
export function gateWorktree(ctxWorktree: unknown, configured: string | undefined): { ok: true; dir: string } | { ok: false; reason: string } {
  if (typeof ctxWorktree !== 'string' || ctxWorktree === '') return { ok: false, reason: 'no worktree in GateContext (refusing)' };
  if (configured !== undefined && resolve(configured) !== resolve(ctxWorktree)) return { ok: false, reason: 'GateContext worktree differs from the gate worktree' };
  return { ok: true, dir: ctxWorktree };
}

/** The check a verify runs, and where it came from. */
export interface ResolvedCheck {
  command: string;
  timeoutSec: number;
  source: 'goal' | 'manifest' | 'criterion';
  manifestCommand: string;
  /** The goal asked for a longer timeout than the manifest allows; the manifest's applies. */
  timeoutCapped: boolean;
  /** Variables exported for the command (provisioned resource locators); evidence records their names only. */
  env?: Readonly<Record<string, string>>;
}

/** What a verify step's criteria run against (see VerifyGate.runView). */
interface RunView {
  inv: { byId: Record<string, CapabilityRecord> };
  /** Usable pending resources of the run by resource id. */
  resources: Map<string, ProvisionedResource>;
}

/**
 * The adopted goal's check wins; the manifest's verify command applies only when the context carries no
 * goal check at all. A goal check that is present but malformed is refused (fail closed).
 */
export function resolveCheck(goal: { check?: unknown } | undefined, m: Manifest): { ok: true; check: ResolvedCheck } | { ok: false; reason: string } {
  const mc = m.verify.command;
  const mt = m.verify.timeoutSec;
  const gc = goal?.check as Partial<EnvironmentalCheck> | undefined | null;
  if (gc === undefined) return { ok: true, check: { command: mc, timeoutSec: mt, source: 'manifest', manifestCommand: mc, timeoutCapped: false } };
  if (!gc || typeof gc !== 'object' || typeof gc.command !== 'string' || gc.command.trim() === '') return { ok: false, reason: 'the goal check has no command (refusing rather than running another check)' };
  if (typeof gc.timeoutSec !== 'number' || !Number.isFinite(gc.timeoutSec) || gc.timeoutSec <= 0) return { ok: false, reason: 'the goal check has no positive timeoutSec' };
  return { ok: true, check: { command: gc.command, timeoutSec: Math.min(gc.timeoutSec, mt), source: 'goal', manifestCommand: mc, timeoutCapped: gc.timeoutSec > mt } };
}

/** What a beforeRun hook may stop the goal check with (the candidate it saw is still D1). */
interface Stop {
  outcome: 'mutated' | 'failed' | 'tooling' | 'refused';
  reason: string;
  exitCode?: number;
}

interface RunOnce {
  outcome: VerifyOutcomeKind;
  exitCode: number;
  fingerprint: string;
  terminal: boolean;
  reason: string;
  before?: Candidate;
  body: Record<string, Json>;
}

export class VerifyGate {
  private readonly base: string;
  private readonly redactor: Redactor;
  private readonly now: () => number;
  private readonly ids: () => string;
  readonly memo: GateMemo;

  constructor(private readonly o: VerifyGateOptions) {
    this.base = o.base ?? o.manifest.repo.base;
    this.redactor = redactorFrom(o);
    this.now = o.now ?? Date.now;
    this.ids = o.ids ?? defaultIds();
    this.memo = o.memo ?? new GateMemo();
  }

  /** Gate step: verify the frozen candidate for this intention. */
  async verify(ctx: StepContext): Promise<VerifyResult> {
    const stepMeta: Record<string, Json> = { intentionId: ctx.intention.id, stepId: ctx.step.id, attempt: ctx.intention.attempt, recovered: ctx.recovered === true };
    const wt = gateWorktree(ctx.worktree, this.o.worktree);
    const chk = resolveCheck(ctx.goal, this.o.manifest);
    const con = contractOf(ctx);
    const view = con.ok && con.contract ? await this.runView(ctx) : null;
    const gaps = con.ok && con.contract ? this.capabilityGaps(con.contract, view!.inv) : [];
    let r: RunOnce;
    let evidenceKey: string | undefined;
    let envelope: EnvelopeView | undefined;
    const proofs: CriterionProof[] = [];
    const failed: string[] = [...gaps];
    // Criterion and review records are found under keys every reader derives from the run id (and the
    // criterion id) as they are; an id carrying a registered secret cannot be keyed without leaking it.
    const idSecret = this.secretId(ctx.runId, con.ok && con.contract ? commandCriteria(con.contract).map((k) => k.id) : []);
    // The intention's own branch (when it was prepared onto one) is bound into every fingerprint below.
    const wb = await workBranchOf(this.o.ledger, this.redactor, this.o.manifest.repo.branchPrefix, ctx);
    const scope = wb.ok && wb.prepared ? wb.branch : undefined;
    if (!wt.ok || !chk.ok || !con.ok || gaps.length || idSecret || !wb.ok) {
      evidenceKey = `verify-refused:${keyPart(this.redactor, `${ctx.runId}:${ctx.intention.id}:${ctx.step.id}`)}:${this.ids()}`;
      const why = !wt.ok ? wt.reason : !chk.ok ? chk.reason : !con.ok ? con.reason : gaps.length ? `criteria ${gaps.join(', ')} require a capability the inventory lacks: nothing can prove them` : idSecret ? idSecret : `work branch: ${(wb as { reason: string }).reason}`;
      r = this.refused(why, { startedAt: this.now(), ...(con.ok && con.hash ? { contractHash: con.hash } : {}) });
    } else {
      const contract = con.contract;
      const slot = keyPart(this.redactor, `${ctx.runId}:${ctx.intention.id}:${ctx.step.id}:${ctx.intention.attempt}`);
      const prior = await this.interrupted(slot);
      r = await this.runOnce(wt.dir, ctx.runId, chk.check, ctx.signal, true, async (before) => {
        // S4: a verify of this step died after freezing D1. The tree must still be D1, else a human looks.
        if (prior && prior.d1 !== before.fingerprint) {
          // The interrupted start stays open: every later verify of this slot refuses the same way.
          evidenceKey = `verify-recovered:${slot}:${this.ids()}`;
          return { outcome: 'mutated', reason: `interrupted verify ${prior.key}: the candidate changed since its D1 (security.md S4); not re-running` };
        }
        const n = await this.start(slot, ctx.runId, { ...stepMeta, d1: before.fingerprint, commandDigest: commandDigest(chk.check.command), ...(prior ? { recoveredFrom: prior.key } : {}) });
        if (prior) {
          // Same D1: close the interrupted run (it never produced a result) and re-run under the new start.
          await writeEvidence(this.o.ledger, this.redactor, { key: `verify:${slot}:${prior.n}`, kind: 'gate.verify', runId: ctx.runId, body: { ...stepMeta, outcome: 'interrupted', fingerprint: prior.d1, terminal: false, supersededBy: `verify:${slot}:${n}` } });
        }
        evidenceKey = `verify:${slot}:${n}`;
        // The change-path envelope first: a candidate with a path outside it is refused before any check
        // runs, and no verdict about its content can change that. The worker may take the path back and retry.
        envelope = envelopeView(ctx, before);
        if (envelope.unexpected.length) return { outcome: 'failed', reason: `changed paths outside the accepted change-path envelope: ${describeUnexpected(envelope.unexpected)}`, exitCode: EXIT.failed };
        // The contract's command criteria run on this same frozen candidate; the goal check runs last.
        if (!contract) return null;
        return this.criteria(ctx, contract, con.hash!, before.fingerprint, evidenceKey, proofs, failed, view!, scope);
      }, scope);
      evidenceKey ??= `verify-refused:${keyPart(this.redactor, `${ctx.runId}:${ctx.intention.id}:${ctx.step.id}`)}:${this.ids()}`;
      if (prior) r.body.interruptedVerify = { key: prior.key, d1: prior.d1 };
      if (contract) {
        r.body.contractHash = con.hash!;
        r.body.criteria = proofs.map((p) => ({ criterionId: p.criterionId, evidenceKey: p.evidenceKey, fidelity: p.fidelity }));
      }
    }
    if (failed.length) r.body.failedCriteria = [...failed];
    // (assigned inside the run callback above)
    const env = envelope as EnvelopeView | undefined;
    if (env) r.body.envelope = { source: env.source, paths: env.entries.length, unexpected: env.unexpected.map((c) => ({ path: c.path, op: c.op })) };
    await writeEvidence(this.o.ledger, this.redactor, { key: evidenceKey!, kind: 'gate.verify', runId: ctx.runId, body: { ...r.body, ...stepMeta } });
    this.memo.verify.set(`${ctx.runId}:${ctx.intention.id}`, { evidenceKey: evidenceKey!, fingerprint: r.fingerprint, outcome: r.outcome, files: r.body.files, ...(typeof r.body.commandDigest === 'string' ? { commandDigest: r.body.commandDigest } : {}) });
    const out: VerifyResult = { ...this.result(r, evidenceKey!), ...(env?.unexpected.length ? { unexpected: env.unexpected } : {}) };
    // Proofs only for a step that passed as a whole: one per command criterion, all on `fingerprint`.
    if (con.ok && con.contract) return { ...out, criteria: r.outcome === 'passed' ? proofs : [], ...(failed.length ? { failedCriteria: [...failed] } : {}) };
    return out;
  }

  /** Why the run id or a criterion id cannot appear in an evidence key (it carries a registered secret), or null. */
  private secretId(runId: string, criterionIds: readonly string[]): string | null {
    if (keyPart(this.redactor, runId) !== runId) return 'the run id carries a registered secret: its evidence cannot be keyed without leaking it (fail closed)';
    if (criterionIds.some((id) => keyPart(this.redactor, id) !== id)) return 'a criterion id carries a registered secret: its evidence cannot be keyed without leaking it (fail closed)';
    return null;
  }

  /** Command criteria whose required capabilities the inventory cannot back (fidelityFor null). */
  private capabilityGaps(contract: AcceptanceContract, inv: { byId: Record<string, CapabilityRecord> }): string[] {
    return commandCriteria(contract)
      .filter((k) => criterionFidelity(k.requires, [inv]) === null)
      .map((k) => k.id);
  }

  /**
   * What the criteria run against: GateContext's inventory with the ledger's stand-ins (withLedgerMocks) and the
   * usable provisioned resources of the run by id (none while the registry reports a problem or a resource past
   * the allowance). A ledger that cannot be read adds nothing (missing stays missing; a provisioned criterion
   * then has no locator and proves nothing about its resource).
   */
  private async runView(ctx: StepContext): Promise<RunView> {
    const own = inventoryById(ctx.inventory);
    const events: TeceraEvent[] = [];
    try {
      for await (const e of this.o.ledger.events({ runId: ctx.runId })) events.push(e);
    } catch {
      return { inv: own, resources: new Map() };
    }
    const secrets = (v: string) => this.redactor.containsSecret(v) !== null;
    const allowance = this.o.manifest.provisioning;
    const inv = withLedgerMocks(own, capabilityInventoryOf(events, { runId: ctx.runId, allowance, secrets }));
    const reg = resourceRegistryOf(events, { runId: ctx.runId, allowance, secrets });
    const usable = reg.problems.length || reg.overAllowance.length ? [] : reg.pending;
    return { inv, resources: new Map(usable.map((r) => [r.id, r])) };
  }

  /**
   * One criterion's fidelity and the resource variables its process gets. A required capability that is
   * provisioned as a located kind is exported as resourceEnvName(id); the criterion keeps fidelity provisioned
   * for it only when its command uses it (commandUsesResource), else it is mocked (it never touched the resource).
   */
  private criterionUse(k: Criterion & { check: { command: string } }, view: RunView): { fidelity: Fidelity | null; env: Record<string, string>; unused: string[] } {
    let fidelity = criterionFidelity(k.requires, [view.inv]);
    const env: Record<string, string> = {};
    const unused: string[] = [];
    for (const id of k.requires ?? []) {
      const rec = view.inv.byId[id];
      if (rec?.state !== 'provisioned' || !LOCATED_KINDS.has(rec.kind)) continue;
      const res = rec.resourceId ? view.resources.get(rec.resourceId) : undefined;
      // A resource behind the network is out of a criterion's reach (NETWORK_KINDS): no locator, never used.
      const reachable = !NETWORK_KINDS.has(rec.kind);
      if (res && reachable) env[resourceEnvName(id)] = res.locator;
      if (!res || !reachable || !commandUsesResource(k.check.command, id, res.locator)) unused.push(id);
    }
    if (unused.length && fidelity !== null) fidelity = 'mocked';
    return { fidelity, env, unused };
  }

  /**
   * Run every command criterion on the frozen candidate `d1` (inside the goal check's start record) and
   * record one gate.verify evidence each. Pushes a proof per criterion that exited 0 on d1 and the id of
   * every one that did not. Returns a Stop for the goal check (failed or terminal), or null to run it.
   */
  private async criteria(ctx: StepContext, contract: AcceptanceContract, hash: string, d1: string, verifyKey: string, proofs: CriterionProof[], failed: string[], view: RunView, scope?: string): Promise<Stop | null> {
    const mt = this.o.manifest.verify.timeoutSec;
    for (const k of commandCriteria(contract)) {
      const use = this.criterionUse(k, view);
      const fidelity = use.fidelity as Fidelity;
      const check: ResolvedCheck = { command: k.check.command, timeoutSec: Math.min(k.check.timeoutSec, mt), source: 'criterion', manifestCommand: this.o.manifest.verify.command, timeoutCapped: k.check.timeoutSec > mt, ...(Object.keys(use.env).length ? { env: use.env } : {}) };
      const c = await this.runOnce(ctx.worktree, ctx.runId, check, ctx.signal, true, undefined, scope);
      // The criterion must have seen exactly the frozen candidate, before and after its command.
      const drift = c.outcome !== 'refused' && c.outcome !== 'tooling' && c.fingerprint !== d1;
      const outcome = drift ? 'mutated' : c.outcome;
      const meta: Record<string, Json> = { criterionId: k.id, runId: ctx.runId, contractHash: hash, fidelity, requires: [...(k.requires ?? [])], verifyKey, intentionId: ctx.intention.id, stepId: ctx.step.id, attempt: ctx.intention.attempt, ...(use.unused.length ? { resourceUnused: use.unused } : {}) };
      const { files: _files, ...body } = c.body;
      void _files;
      if (outcome === 'passed') {
        const key = await this.recordCriterion(ctx.runId, criterionEvidenceKey(ctx.runId, k.id, d1), { ...body, ...meta }, check.command, d1);
        if (key) {
          const at = typeof c.body.startedAt === 'number' ? c.body.startedAt + (typeof c.body.durationMs === 'number' ? c.body.durationMs : 0) : this.now();
          proofs.push({ criterionId: k.id, fidelity, via: 'command', command: k.check.command, exitCode: 0, fingerprint: d1, evidenceKey: key, verifiedAt: at });
          continue;
        }
        failed.push(k.id);
        return { outcome: 'refused', reason: `criterion ${k.id}: its evidence key already holds another record`, exitCode: EXIT.human };
      }
      const why = drift ? `criterion ${k.id} saw another candidate than D1 (the tree changed)` : `criterion ${k.id}: ${c.reason}`;
      await writeEvidence(this.o.ledger, this.redactor, { key: `verify-criterion:${keyPart(this.redactor, `${ctx.runId}:${k.id}`)}:${this.ids()}`, kind: 'gate.verify', runId: ctx.runId, body: { ...body, ...meta, outcome, ...(drift ? { exitCode: EXIT.human, terminal: true } : {}), reason: this.diag(why) } });
      failed.push(k.id);
      if (outcome !== 'failed') return { outcome, reason: why, exitCode: drift ? EXIT.human : c.exitCode };
    }
    if (failed.length) return { outcome: 'failed', reason: `criteria failed: ${failed.join(', ')}`, exitCode: EXIT.failed };
    return null;
  }

  /**
   * Record a passing criterion under its deterministic key (create-if-absent). A key already holding a
   * passing record of the same criterion command on the same candidate is that proof again (a second
   * verify step on an unchanged candidate); anything else under the key is refused (null).
   */
  private async recordCriterion(runId: string, key: string, body: Record<string, Json>, command: string, d1: string): Promise<string | null> {
    const same = (b: Record<string, Json> | null) => !!b && b.outcome === 'passed' && b.exitCode === 0 && b.fingerprint === d1 && b.commandDigest === commandDigest(command) && b.criterionId === body.criterionId;
    const existing = await this.o.ledger.getEvidence(key);
    if (existing) return existing.kind === 'gate.verify' && existing.runId === runId && same(obj(existing.body)) ? key : null;
    try {
      await writeEvidence(this.o.ledger, this.redactor, { key, kind: 'gate.verify', runId, body });
      return key;
    } catch (err) {
      if (!(err instanceof LedgerError && err.code === 'evidence')) throw err;
      const won = await this.o.ledger.getEvidence(key);
      return won && won.kind === 'gate.verify' && same(obj(won.body)) ? key : null;
    }
  }

  /** The returned result: diagnostics redacted (again, idempotently), terminal results classified. */
  private result(r: RunOnce, evidenceKey: string): VerifyResult {
    return { exitCode: r.exitCode, evidenceKey, outcome: r.outcome, fingerprint: r.fingerprint, terminal: r.terminal, reason: this.diag(r.reason), ...(r.terminal ? { failure: 'human' as const } : {}) };
  }

  /** A diagnostic string as it may leave the gate. */
  private diag(text: string): string {
    return safeText(this.redactor, text);
  }

  /** The last start record of this step slot that has no result, if any (an interrupted verify). */
  private async interrupted(slot: string): Promise<{ key: string; n: number; d1: string } | null> {
    let last: { key: string; n: number; d1: string } | null = null;
    for (let n = 0; n < MAX_SLOTS; n++) {
      const start = await this.o.ledger.getEvidence(`verify-start:${slot}:${n}`);
      if (!start) break;
      const done = await this.o.ledger.getEvidence(`verify:${slot}:${n}`);
      const d1 = obj(start.body)?.d1;
      if (!done) last = { key: `verify-start:${slot}:${n}`, n, d1: typeof d1 === 'string' ? d1 : '' };
    }
    return last;
  }

  /** Write the start record at the first free n of this slot (create-if-absent; a race moves on). */
  private async start(slot: string, runId: string, body: Record<string, Json>): Promise<number> {
    for (let n = 0; n < MAX_SLOTS; n++) {
      const key = `verify-start:${slot}:${n}`;
      if (await this.o.ledger.getEvidence(key)) continue;
      try {
        await writeEvidence(this.o.ledger, this.redactor, { key, kind: 'gate.verify.start', runId, body: { ...body, n, at: this.now(), nonce: this.ids() } });
        return n;
      } catch (err) {
        if (err instanceof LedgerError && err.code === 'evidence') continue;
        throw err;
      }
    }
    throw new Error(`verify slot ${slot} has more than ${MAX_SLOTS} runs`);
  }

  /**
   * Preflight: run verify on the untouched base tree and record it as the run's baseline. When the tree
   * has no committable change, its ignored files (dependencies, build output) are recorded as the run's
   * ignored baseline (path keys + redacted names): later snapshots treat them as unchanged only while
   * their bytes are identical, and a baselined file that disappears is a change. `check` is the adopted
   * goal's check when the run has one (else the manifest's verify command runs).
   */
  async baseline(ctx: { runId: string; worktree?: string; signal?: AbortSignal; check?: EnvironmentalCheck }): Promise<VerifyResult> {
    const evidenceKey = `verify-baseline:${keyPart(this.redactor, ctx.runId)}:${this.ids()}`;
    const wt = gateWorktree(ctx.worktree ?? this.o.worktree, this.o.worktree);
    const chk = resolveCheck(ctx.check !== undefined ? { check: ctx.check } : undefined, this.o.manifest);
    const idSecret = this.secretId(ctx.runId, []);
    const r = idSecret ? this.refused(idSecret, { startedAt: this.now() }) : !wt.ok ? this.refused(wt.reason, { startedAt: this.now() }) : !chk.ok ? this.refused(chk.reason, { startedAt: this.now() }) : await this.runOnce(wt.dir, ctx.runId, chk.check, ctx.signal, false);
    if (r.before && r.outcome !== 'mutated' && r.outcome !== 'refused' && r.before.files.every((f) => f.status === '!')) {
      const existing = await ignoredBaseline(this.o.ledger, this.memo, ctx.runId);
      if (!existing) {
        const b = ignoredBaselineOf(r.before.ignored, this.redactor);
        const body: Json = { v: IGNORED_BASELINE_VERSION, entries: b.entries, names: b.names as Record<string, string>, count: Object.keys(b.entries).length, fingerprint: r.fingerprint };
        try {
          await writeEvidence(this.o.ledger, this.redactor, { key: ignoredBaselineKey(ctx.runId), kind: 'gate.verify.baseline.ignored', runId: ctx.runId, body });
          this.memo.ignoredBaseline.set(ctx.runId, b);
        } catch (err) {
          // A concurrent baseline won the key: use what is on the ledger (never our unrecorded view).
          if (!(err instanceof LedgerError && err.code === 'evidence')) throw err;
          await ignoredBaseline(this.o.ledger, this.memo, ctx.runId);
        }
      }
    }
    await writeEvidence(this.o.ledger, this.redactor, { key: evidenceKey, kind: 'gate.verify.baseline', runId: ctx.runId, body: { ...r.body, baseline: true } });
    return this.result(r, evidenceKey);
  }

  /**
   * Snapshot (D1), optionally let `beforeRun` refuse or record a start, run the check, snapshot again.
   * `beforeRun` returning {outcome:'mutated'} stops before the command runs.
   */
  private async runOnce(
    worktree: string,
    runId: string,
    check: ResolvedCheck,
    signal?: AbortSignal,
    useBaseline = true,
    beforeRun?: (before: Candidate) => Promise<Stop | null>,
    scope?: string,
  ): Promise<RunOnce> {
    const { manifest } = this.o;
    const cap = this.o.tailCap ?? 8 * 1024;
    const command = check.command;
    const envAllowlist = scrubbedAllowlist(manifest);
    const startedAt = this.now();
    const meta: Record<string, Json> = {
      command,
      commandDigest: commandDigest(command),
      checkSource: check.source,
      manifestCommand: check.manifestCommand,
      timeoutSec: check.timeoutSec,
      timeoutCapped: check.timeoutCapped,
      envAllowlist,
      startedAt,
      ...(check.env && Object.keys(check.env).length ? { resourceEnv: Object.keys(check.env).sort() } : {}),
    };
    const baseline = useBaseline ? await ignoredBaseline(this.o.ledger, this.memo, runId) : undefined;

    let before: Candidate;
    try {
      before = await snapshotCandidate(worktree, this.base, { ignoredBaseline: baseline, signal, ...(scope !== undefined ? { branch: scope } : {}) });
    } catch (err) {
      if (err instanceof UnsafeRepo) return this.refused(`unsafe repository: ${err.problems.join('; ')}`, meta);
      return this.tooling('', EXIT.notExecutable, `cannot fingerprint worktree: ${errMsg(err)}`, meta);
    }

    const stop = beforeRun ? await beforeRun(before) : null;
    if (stop) {
      // The goal check never ran: a failed criterion is retryable (1), anything else is terminal.
      const reason = this.diag(stop.reason);
      const terminal = stop.outcome !== 'failed';
      const exitCode = stop.exitCode ?? (terminal ? EXIT.human : EXIT.failed);
      return {
        outcome: stop.outcome,
        exitCode,
        fingerprint: before.fingerprint,
        terminal,
        reason,
        before,
        body: { ...meta, outcome: stop.outcome, exitCode, reason, humanNeeded: terminal, retryable: !terminal, terminal, fingerprint: before.fingerprint, files: fileManifest(before), ran: false, stdoutTail: '', stderrTail: '', durationMs: 0 },
      };
    }

    let out: VerifyOutcome;
    try {
      // Resource locators are exported in the same shell; the evidence binds the criterion's own command.
      const run = check.env ? `${shellExports(check.env)}${command}` : command;
      out = await this.o.runner.run({ cwd: worktree, command: run, timeoutSec: check.timeoutSec, envAllowlist }, signal);
    } catch (err) {
      return this.tooling(before.fingerprint, signal?.aborted ? EXIT.timeout : EXIT.notFound, `verify runner failed: ${errMsg(err)}`, { ...meta, files: fileManifest(before) });
    }
    if (!out || typeof out !== 'object') return this.tooling(before.fingerprint, EXIT.notFound, 'verify runner returned no outcome', { ...meta, files: fileManifest(before) });

    let after: string;
    try {
      after = (await snapshotCandidate(worktree, this.base, { ignoredBaseline: baseline, ...(scope !== undefined ? { branch: scope } : {}) })).fingerprint;
    } catch (err) {
      after = `unreadable: ${this.diag(errMsg(err))}`;
    }

    // Redact the whole stream first, then keep the tail: a cut can never leave half a secret behind.
    const clean = (s: unknown) => tail(this.redactor.redactText(typeof s === 'string' ? s : ''), cap);
    // Output the runner capped (or cannot vouch for) is incomplete: it can never certify a pass.
    const truncated = out.truncated === true || out.stdoutTruncated === true || out.stderrTruncated === true || typeof out.truncated !== 'boolean';
    const common: Record<string, Json> = {
      ...meta,
      ran: true,
      runnerExitCode: typeof out.exitCode === 'number' ? out.exitCode : null,
      signal: typeof out.signal === 'string' ? out.signal : null,
      timedOut: out.timedOut === true,
      cancelled: out.cancelled === true,
      stdoutTail: clean(out.stdout),
      stderrTail: clean(out.stderr),
      outputTruncated: truncated,
      stdoutTruncated: out.stdoutTruncated ?? null,
      stderrTruncated: out.stderrTruncated ?? null,
      fingerprint: before.fingerprint,
      fingerprintAfter: after,
      files: fileManifest(before),
      durationMs: typeof out.durationMs === 'number' && Number.isFinite(out.durationMs) ? out.durationMs : null,
    };

    let outcome: VerifyOutcomeKind;
    let exitCode: number;
    let reason: string;
    if (after !== before.fingerprint) {
      outcome = 'mutated';
      exitCode = EXIT.human;
      reason = 'verify command mutated the candidate tree (D_after != D_before)';
    } else if (out.cancelled === true || signal?.aborted) {
      outcome = 'tooling';
      exitCode = EXIT.timeout;
      reason = 'verify cancelled';
    } else if (out.timedOut === true || out.exitCode === null) {
      outcome = 'tooling';
      exitCode = EXIT.timeout;
      reason = out.timedOut === true ? 'verify timed out' : `verify interrupted by signal ${out.signal ?? 'unknown'}`;
    } else if (typeof out.exitCode !== 'number' || !Number.isInteger(out.exitCode)) {
      outcome = 'tooling';
      exitCode = EXIT.notFound;
      reason = 'verify runner reported no exit code';
    } else if (TOOLING_EXITS.has(out.exitCode)) {
      outcome = 'tooling';
      exitCode = out.exitCode;
      reason = 'tooling missing or interrupted';
    } else if (out.exitCode === 0 && truncated) {
      outcome = 'failed';
      exitCode = EXIT.failed;
      reason = 'verify output was truncated at its cap: an incomplete run never passes';
    } else if (out.exitCode === 0) {
      outcome = 'passed';
      exitCode = EXIT.ok;
      reason = 'verify passed';
    } else {
      outcome = 'failed';
      exitCode = EXIT.failed;
      reason = `verify exited ${out.exitCode}`;
    }
    const terminal = outcome === 'mutated' || outcome === 'tooling';
    reason = this.diag(reason);
    return { outcome, exitCode, fingerprint: before.fingerprint, terminal, reason, before, body: { ...common, outcome, exitCode, reason, humanNeeded: terminal, retryable: outcome === 'failed', terminal } };
  }

  private tooling(fingerprint: string, exitCode: number, rawReason: string, extra: Record<string, Json>): RunOnce {
    const reason = this.diag(rawReason);
    return {
      outcome: 'tooling',
      exitCode,
      fingerprint,
      terminal: true,
      reason,
      body: { ...extra, outcome: 'tooling', exitCode, reason, humanNeeded: true, retryable: false, terminal: true, fingerprint, timedOut: false, stdoutTail: '', stderrTail: '', durationMs: 0 },
    };
  }

  private refused(rawReason: string, extra: Record<string, Json>): RunOnce {
    const reason = this.diag(rawReason);
    return {
      outcome: 'refused',
      exitCode: EXIT.human,
      fingerprint: '',
      terminal: true,
      reason,
      body: { ...extra, outcome: 'refused', exitCode: EXIT.human, reason, humanNeeded: true, retryable: false, terminal: true, fingerprint: '', stdoutTail: '', stderrTail: '', durationMs: 0 },
    };
  }
}

/** Start records probed per verify step slot. */
const MAX_SLOTS = 1000;

/** Preflight helper: baseline verify without constructing a gate runner. */
export function baselineVerify(o: VerifyGateOptions, ctx: { runId: string; worktree?: string; signal?: AbortSignal; check?: EnvironmentalCheck }): Promise<VerifyResult> {
  return new VerifyGate(o).baseline(ctx);
}
