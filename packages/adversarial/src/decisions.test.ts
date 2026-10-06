import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  chainHash,
  deriveGoalStatus,
  GENESIS_HASH,
  event,
  IllegalTransition,
  ManifestError,
  parseManifest,
  REFLEX_OFF_REMOVED,
  REFLEX_SETTINGS,
  transitionGoal,
  type AchievementGoal,
  type DecisionRecord,
  type EvidenceRecord,
  type Plan,
  type ReflexFrontier,
  type ReflexQuestions,
  type ReflexResult,
  type ReflexSeam,
} from '@tecera/contracts';
import { SqliteLedger } from '@tecera/ledger';
import { deliveryChainProblems, DELIVERY_CHAIN } from '@tecera/policy';
import { ReflexRouter } from '@tecera/reflex';
import { replayRun } from '@tecera/runtime';
import { expectGap } from './harness/gap.js';
import { cli, dump, fixturePlan, fixtureReplies, Flow, git, KEYS, ledgerEvents, requestIdOf, sampleRepo, stopHook, type Ev } from './harness/e2e.js';
import { manifestInput, StubReviewer, WRITERS } from './harness/gates.js';
import { environ } from './harness/procs.js';
import { sandboxNodes } from './harness/sandbox.js';
import { cleanupTemps, PACKAGES, tmp } from './harness/tmp.js';
import { assertForeign, SameProviderReview } from '@tecera/gates';

/**
 * The owner decisions of 2026-10-05 (D1–D7) as adversarial cases (DECISION_INDEX in index.ts). Each case
 * attacks the decision through the REAL components: contracts/policy/reflex units where the rule lives, and
 * `tecera run` end to end with scripted models (real ledger, sandbox, verify runner, gates, git) where the
 * decision is a property of a whole run.
 */

afterAll(cleanupTemps);

const BRANCH = 'tecera/fix-failing-test';
const KERNEL = ['contracts', 'ledger', 'reflex', 'policy', 'worker', 'loop', 'brain', 'providers', 'planner', 'gates', 'runtime'];
const PRIVATE_FORKS = ['@tecera/auth', '@tecera/core', '@tecera/intent'];

const kinds = (evs: Ev[]): string[] => evs.map((e) => e.kind);

/** Rewrite the copy's tecera.json before `tecera init` and the base commit. */
const editManifest = (f: (m: Record<string, any>) => void) => (d: string) => {
  const p = join(d, 'tecera.json');
  const m = JSON.parse(readFileSync(p, 'utf8')) as Record<string, any>;
  f(m);
  writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`);
};

function walkFiles(dir: string, keep: (rel: string) => boolean, rel = ''): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const n of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${n.name}` : n.name;
    if (n.isDirectory()) {
      if (n.name !== 'node_modules') out.push(...walkFiles(dir, keep, r));
    } else if (keep(r)) out.push(r);
  }
  return out;
}

/** A run of the sample held at its PR, with the events and the adopted goal. */
async function heldAtPr(o: { mutate?: (d: string) => void } = {}) {
  const { dir, wt } = await sampleRepo(o.mutate ? { mutate: o.mutate } : {});
  const flow = new Flow(dir, wt);
  const seg = await flow.drive();
  expect(seg.code, seg.err + seg.out + (await dump(dir))).toBe(4);
  expect((await flow.pending())?.trace.stepId).toBe('pr');
  const evs = await flow.events();
  const adopted = evs.find((e) => e.kind === 'goal.adopted')!;
  return { dir, wt, flow, evs, goalId: adopted.trace.goalId!, goal: (adopted.payload as unknown as { goal: AchievementGoal }).goal };
}

let forged = 0;
/** Append an event out of band (a compromised component with ledger access). */
async function appendForged(dir: string, kind: Parameters<typeof event>[0], runId: string, trace: Record<string, string>, payload: Record<string, unknown>): Promise<void> {
  const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
  try {
    await l.append(event(kind, { id: `forged_${++forged}`, at: Date.now(), actor: { kind: 'agent', id: 'loop' }, runId, trace, payload: payload as never }));
  } finally {
    l.close();
  }
}

describe('owner decisions D1–D7 (2026-10-05)', () => {
  it('decision.d1_local_principal: no kernel package depends on or imports the private forks (@tecera/auth, core, intent); the runtime ships no token ingress; approvals come only from the local human principal', async () => {
    const offenders: string[] = [];
    for (const pkg of KERNEL) {
      const pj = JSON.parse(readFileSync(join(PACKAGES, pkg, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) for (const dep of Object.keys(pj[field] ?? {})) if (PRIVATE_FORKS.includes(dep)) offenders.push(`${pkg}/package.json ${field}: ${dep}`);
      const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](@tecera\/(?:auth|core|intent))(?:\/[^'"]*)?['"]/;
      for (const f of walkFiles(join(PACKAGES, pkg, 'src'), (r) => /\.(ts|mts|js|mjs)$/.test(r))) if (re.test(readFileSync(join(PACKAGES, pkg, 'src', f), 'utf8'))) offenders.push(`${pkg}/src/${f}`);
      for (const f of walkFiles(join(PACKAGES, pkg, 'dist'), (r) => /\.(js|mjs)$/.test(r))) if (re.test(readFileSync(join(PACKAGES, pkg, 'dist', f), 'utf8'))) offenders.push(`${pkg}/dist/${f}`);
    }
    expect(offenders, 'kernel references to a private fork').toEqual([]);
    // this suite's own package does not depend on them either
    const own = JSON.parse(readFileSync(join(PACKAGES, 'adversarial/package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    expect(Object.keys(own.dependencies ?? {}).filter((d) => PRIVATE_FORKS.includes(d))).toEqual([]);
    // no JWT approval ingress is shipped (the coverage: the runtime dist is there and was walked above)
    expect(existsSync(join(PACKAGES, 'runtime/dist/index.js'))).toBe(true);
    expect(walkFiles(join(PACKAGES, 'runtime/dist'), (r) => /(^|\/)ingress\.js$/.test(r)), 'a token ingress module in the runtime dist').toEqual([]);

    // behaviour: on a real PR hold, a token is no ingress; the local human principal ($USER) is, audited
    const h = await heldAtPr();
    const rid = requestIdOf(await h.flow.pending())!;
    const tok = await cli(h.dir, ['approve', rid, '--token', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJyb290In0.', '--yes'], { env: { ...h.flow.env, USER: '', USERNAME: '' } });
    expect(tok.code).not.toBe(0);
    const ok = await cli(h.dir, ['approve', rid, '--yes'], { env: { ...h.flow.env, USER: 'local-owner' } });
    expect(ok.code, ok.err).toBe(0);
    const granted = (await h.flow.events()).filter((e) => e.kind === 'approval.granted' && requestIdOf(e) === rid);
    expect(granted).toHaveLength(1);
    expect(granted[0]!.payload).toMatchObject({ approver: { kind: 'human', id: 'local-owner' } });
    expect(JSON.stringify(granted[0]!.payload)).toMatch(/"method":"local"/);
    expect((await h.flow.segment()).code).toBe(0);
  }, 240_000);

  it('decision.d2_reflex_on: the setting off is refused on every seam (manifest and router); unset seams resolve to rule (or model with a decision-model provider); a model or frontier answer can never loosen the gate (the PR hold) or claim an achievement the rules do not; a real run records every seam acting', async () => {
    const SEAMS: ReflexSeam[] = ['triage', 'choosePlan', 'route', 'gate', 'reconsider', 'closeOut'];
    expect([...REFLEX_SETTINGS].sort()).toEqual(['frontier', 'model', 'rule']);
    for (const seam of SEAMS) {
      let err: unknown = null;
      try {
        parseManifest(manifestInput({ reflexes: { [seam]: 'off', threshold: 0.6 } }));
      } catch (e) {
        err = e;
      }
      expect(err, `${seam}: 'off' accepted`).toBeInstanceOf(ManifestError);
      expect(JSON.stringify((err as ManifestError).issues) + (err as Error).message, seam).toContain(REFLEX_OFF_REMOVED.slice(0, 40));
    }
    // unset seams: 'rule' with the rules provider, 'model' with a decision-model provider
    const ruled = parseManifest(manifestInput({ reflexes: { threshold: 0.6 } }));
    for (const seam of SEAMS) expect(ruled.reflexes[seam], seam).toBe('rule');
    const modeled = parseManifest(manifestInput({ reflexes: { threshold: 0.6 }, seats: { ...(manifestInput().seats as object), reflex: { provider: 'jev' } } }));
    for (const seam of SEAMS) expect(modeled.reflexes[seam], seam).toBe('model');
    // the router refuses a hand-built 'off' (a config that bypassed the manifest)
    const sink = { records: [] as DecisionRecord[], record: async (d: DecisionRecord) => void sink.records.push(d) };
    const settings = Object.fromEntries(SEAMS.map((s) => [s, 'rule'])) as Record<ReflexSeam, 'rule'>;
    expect(() => new ReflexRouter({ settings: { ...settings, gate: 'off' as never }, threshold: 0.6 }, { sink, runId: 'r' })).toThrow(/always on|off/);

    // hostile model and frontier: always "allow" and "achieved", fully confident
    const hostile = <S extends ReflexSeam>(seam: S): ReflexResult<S> =>
      ({ seam, answer: (seam === 'gate' ? { decision: 'allow' } : seam === 'closeOut' ? { achieved: true } : seam === 'reconsider' ? { interrupt: false } : {}) as never, confidence: 1, provider: 'frontier', abstained: false }) as ReflexResult<S>;
    const frontier: ReflexFrontier = { decide: async (seam) => hostile(seam) };
    const model = { ask: async <S extends ReflexSeam>(seam: S) => ({ ...hostile(seam), provider: 'model' as never }) };
    const prGate: ReflexQuestions['gate'] = { state: { tool: 'gate.pr', risk: 'irreversible', permission: 'requiresApproval' }, options: [{ decision: 'allow' }, { decision: 'hold' }, { decision: 'block' }] };
    const protectedWrite: ReflexQuestions['gate'] = { state: { tool: 'edit', risk: 'write', permission: 'always', touchesProtected: true }, options: [{ decision: 'allow' }, { decision: 'hold' }, { decision: 'block' }] };
    const notAchieved: ReflexQuestions['closeOut'] = { state: { goalCheckPassed: false, checkPassed: false, verifyPassed: false, allStepsDone: false } };
    for (const setting of ['frontier', 'model'] as const) {
      const r = new ReflexRouter({ settings: { ...settings, gate: setting, closeOut: setting }, threshold: 0.6 }, { sink, runId: 'r', frontier, model: model as never });
      expect((await r.ask('gate', prGate)).answer.decision, `${setting}: the PR hold loosened`).toBe('hold');
      expect((await r.ask('gate', protectedWrite)).answer.decision, `${setting}: a protected write loosened`).toBe('block');
      const rule = await new ReflexRouter({ settings, threshold: 0.6 }, { sink, runId: 'r' }).ask('closeOut', notAchieved);
      expect(rule.answer.achieved, 'control: the rules do not call this achieved').toBe(false);
      expect((await r.ask('closeOut', notAchieved)).answer.achieved, `${setting}: an achievement the rules refuse`).toBe(false);
    }
    expect(sink.records.every((d) => ['acted', 'escalated', 'fallback'].includes(d.outcome))).toBe(true);

    // a real run: every decision is made by an on seam; the gate seam acted and held the PR
    const h = await heldAtPr();
    const decisions = h.evs.filter((e) => e.kind === 'decision.recorded').map((e) => (e.payload as unknown as { record: DecisionRecord }).record);
    expect(decisions.length).toBeGreaterThan(0);
    for (const d of decisions) {
      expect(REFLEX_SETTINGS as readonly string[], JSON.stringify(d)).toContain(d.setting);
      expect(['acted', 'escalated', 'fallback'], JSON.stringify(d)).toContain(d.outcome);
    }
    const gates = decisions.filter((d) => d.seam === 'gate');
    expect(gates.length).toBeGreaterThan(0);
    expect(gates.at(-1)!.answer).toMatchObject({ decision: 'hold' });
  }, 240_000);

  it('decision.d3_budget_soft: the same over-cap run (worker and reviewer report more tokens than the run may spend) is recorded and reported but goes on to a delivered PR with budgets.enforce false (the default), and stops as a budget failure (exit 7, nothing committed or delivered) with budgets.enforce true; budget never holds the assistant', async () => {
    const fx = fixtureReplies();
    const over = { worker: [{ ...fx.worker[0]!, usage: { input: 400_000, output: 1_000 } }, fx.worker[1]!], reviewer: [{ ...fx.reviewer[0]!, usage: { input: 300_000, output: 40 } }] };

    // the default: soft pools
    const soft = await sampleRepo();
    expect(JSON.parse(readFileSync(join(soft.dir, 'tecera.json'), 'utf8')).budgets.enforce ?? false, 'the sample keeps the default').toBe(false);
    const sf = new Flow(soft.dir, soft.wt, over);
    const held = await sf.drive();
    expect(held.code, held.err + held.out + (await dump(soft.dir))).toBe(4);
    expect((await sf.pending())?.trace.stepId).toBe('pr');
    let evs = await sf.events();
    const ex = evs.filter((e) => e.kind === 'budget.exhausted');
    expect(ex.some((e) => (e.payload as { pool?: string }).pool === 'tokens'), kinds(evs).join(' ')).toBe(true);
    for (const e of ex) {
      expect(e.payload, 'exhaustion is reported with its numbers, not enforced').toMatchObject({ enforced: false });
      const p = e.payload as { used?: number; cap?: number };
      if (p.used !== undefined && p.cap !== undefined) expect(p.used).toBeGreaterThan(p.cap);
    }
    expect(evs.some((e) => (e.payload as { failure?: string }).failure === 'budget')).toBe(false);
    expect(held.out, 'the cost line reports usage over the cap').toMatch(/not enforced/);
    const done = await sf.finish();
    expect(done.code, done.err + done.out + (await dump(soft.dir))).toBe(0);
    evs = await sf.events();
    expect(evs.filter((e) => e.kind === 'pr.requested' || e.kind === 'pr.opened')).toHaveLength(1);
    expect(evs.filter((e) => e.kind === 'goal.achieved')).toHaveLength(1);
    expect((await stopHook(soft.dir)).code).toBe(0);

    // enforced: the same replies stop the run
    const hard = await sampleRepo({ mutate: editManifest((m) => void (m.budgets.enforce = true)) });
    const hf = new Flow(hard.dir, hard.wt, over);
    const stopped = await hf.drive();
    expect(stopped.code, stopped.err + stopped.out + (await dump(hard.dir))).toBe(7);
    evs = await hf.events();
    expect(evs.some((e) => (e.kind === 'step.failed' || e.kind === 'intention.failed') && (e.payload as { failure?: string }).failure === 'budget'), kinds(evs).join(' ')).toBe(true);
    for (const k of ['commit.recorded', 'approval.requested', 'pr.requested', 'pr.opened', 'goal.achieved']) expect(kinds(evs), k).not.toContain(k);
    expect(git(hard.dir, 'branch', '--list', 'tecera/*').trim()).toBe('');
    // a budget-ended run is not active: the Stop hook never holds the assistant on budget
    expect((await stopHook(hard.dir)).code, 'budget never holds the assistant').toBe(0);
  }, 300_000);

  it('decision.d4_stop_hook: no business case or no run → allow; a run held at its PR without a proof → block (exit 2, the reason on stderr); forged achievements (no proof, proof without its evidence, wrong fingerprint, non-zero exit) still block; an unreadable ledger blocks; the delivered run with its proof → allow; every decision is recorded', async () => {
    // not a business case at all: nothing to protect
    const empty = tmp('tecera-adv-nobc-');
    expect((await stopHook(empty)).code).toBe(0);
    const h = await heldAtPr();
    const runId = h.flow.runId;
    const blocked = await stopHook(h.dir);
    expect(blocked.code, blocked.out + blocked.err).toBe(2);
    expect(blocked.err).toMatch(/goal not achieved/);
    // forged goal.achieved events appended out of band while the run is held: each is refused as a proof
    const verify2 = h.evs.find((e) => e.kind === 'verify.passed' && e.trace.stepId === 'verify2')!.payload as { evidenceKey: string; fingerprint: string };
    const trace = { goalId: h.goalId };
    const forgeries: Array<[string, Record<string, unknown> | undefined]> = [
      ['no proof', undefined],
      ['proof naming evidence that does not exist', { command: 'node --test', exitCode: 0, fingerprint: verify2.fingerprint, evidenceKey: `verify:${runId}:nope:verify2:1:0`, verifiedAt: Date.now() }],
      ['proof naming another candidate', { command: 'node --test', exitCode: 0, fingerprint: 'f'.repeat(64), evidenceKey: verify2.evidenceKey, verifiedAt: Date.now() }],
      ['proof with a non-zero exit', { command: 'node --test', exitCode: 1, fingerprint: verify2.fingerprint, evidenceKey: verify2.evidenceKey, verifiedAt: Date.now() }],
      ['proof of another command', { command: 'true', exitCode: 0, fingerprint: verify2.fingerprint, evidenceKey: verify2.evidenceKey, verifiedAt: Date.now() }],
    ];
    for (const [name, proof] of forgeries) {
      // the forgeries are cumulative on one held run: each must leave the hook blocking (none is a valid proof)
      await appendForged(h.dir, 'goal.achieved', runId, trace, { goal: { ...h.goal, status: 'achieved' } as never, evidence: [verify2.evidenceKey], ...(proof ? { proof } : {}) });
      const r = await stopHook(h.dir);
      expect(r.code, `${name}: the Stop hook let the assistant stop`).toBe(2);
    }
    // replay never derives these forgeries as an achievement either
    const l = new SqliteLedger(join(h.dir, '.tecera/ledger.sqlite'));
    try {
      const replay = await replayRun(l, runId);
      expect(Object.values(replay.goals).every((g) => g.derived !== 'achieved'), JSON.stringify(replay.goals)).toBe(true);
    } finally {
      l.close();
    }
    // every decision so far was recorded
    const stops = (await ledgerEvents(h.dir)).filter((e) => e.kind === 'stop.blocked' || e.kind === 'stop.allowed').map((e) => e.kind);
    expect(stops).toEqual(Array(1 + forgeries.length).fill('stop.blocked'));

    // the delivered run with its proof: allow
    const g = await heldAtPr();
    expect((await g.flow.finish()).code).toBe(0);
    const allowed = await stopHook(g.dir);
    expect(allowed.code, allowed.out + allowed.err).toBe(0);
    expect((await ledgerEvents(g.dir)).filter((e) => e.kind === 'stop.allowed').length).toBeGreaterThan(0);

    // an unreadable ledger fails closed
    const c = await heldAtPr();
    writeFileSync(join(c.dir, '.tecera/ledger.sqlite'), 'this is not a database');
    for (const f of readdirSync(join(c.dir, '.tecera')).filter((n) => /^ledger\.sqlite-(wal|shm)$/.test(n))) writeFileSync(join(c.dir, '.tecera', f), '');
    const broken = await stopHook(c.dir);
    expect(broken.code, broken.out + broken.err).toBe(2);
  }, 300_000);

  it('decision.d4_stop_hook [forged achievement while held] GAP (owner: runtime stopHook.ts): a well-formed goal.achieved appended out of band while the run is still held at its PR (nothing delivered, so the run does not derive as achieved) does not let the assistant stop', async () => {
    const h = await heldAtPr();
    const runId = h.flow.runId;
    const verify2 = h.evs.find((e) => e.kind === 'verify.passed' && e.trace.stepId === 'verify2')!.payload as { evidenceKey: string; fingerprint: string };
    const l0 = new SqliteLedger(join(h.dir, '.tecera/ledger.sqlite'));
    let verifiedAt = Date.now();
    try {
      const rec = await l0.getEvidence(verify2.evidenceKey);
      expect(rec?.body, 'the referenced verify evidence is real').toMatchObject({ exitCode: 0, fingerprint: verify2.fingerprint });
      const b = rec!.body as { startedAt?: number; finishedAt?: number };
      verifiedAt = b.finishedAt ?? b.startedAt ?? verifiedAt;
    } finally {
      l0.close();
    }
    await appendForged(h.dir, 'goal.achieved', runId, { goalId: h.goalId }, { goal: { ...h.goal, status: 'achieved' } as never, evidence: [verify2.evidenceKey], proof: { command: 'node --test', exitCode: 0, fingerprint: verify2.fingerprint, evidenceKey: verify2.evidenceKey, verifiedAt } });
    // the attack state: still held at the PR, nothing delivered, and replay refuses the achievement
    const evs = await ledgerEvents(h.dir);
    expect(evs.some((e) => e.kind === 'pr.requested' || e.kind === 'pr.opened')).toBe(false);
    expect(evs.filter((e) => e.kind === 'run.ended' && e.runId === runId).at(-1)!.payload).toMatchObject({ exitCode: 4 });
    const l = new SqliteLedger(join(h.dir, '.tecera/ledger.sqlite'));
    try {
      const replay = await replayRun(l, runId);
      expect(Object.values(replay.goals).every((g) => g.derived !== 'achieved'), JSON.stringify(replay.goals)).toBe(true);
    } finally {
      l.close();
    }
    const r = await stopHook(h.dir);
    await expectGap('decision.d4_stop_hook [forged achievement while held]', 'runtime stopHook.ts (accept a proof only for a run whose achievement derives: deriveGoalStatus with the PR delivered)', { assertion: 'the Stop hook blocks on an underived achievement' }, () => {
      expect(r.code, 'the Stop hook blocks on an underived achievement').toBe(2);
    });
  }, 240_000);

  it('decision.d4_achieved_proof: every goal.achieved carries a proof bound to the passing final verify of the committed candidate; contracts refuse an achievement without evidence or with a malformed proof; derivation refuses a proof-less achievement', async () => {
    // contracts
    const goal: AchievementGoal = { id: 'g1', statement: 's', check: { command: 'node --test', timeoutSec: 60 }, commitment: 'single-minded', status: 'open', evidence: [] } as unknown as AchievementGoal;
    expect(() => transitionGoal(goal, 'achieved')).toThrow(IllegalTransition);
    expect(() => transitionGoal(goal, 'achieved', [''])).toThrow(IllegalTransition);
    expect(() => transitionGoal(goal, 'achieved', ['ev1'], { command: 'node --test', exitCode: 1 as 0, fingerprint: 'f', evidenceKey: 'ev1', verifiedAt: 1 })).toThrow(IllegalTransition);
    expect(() => transitionGoal(goal, 'achieved', ['ev1'], { command: 'other', exitCode: 0, fingerprint: 'f', evidenceKey: 'ev1', verifiedAt: 1 })).toThrow(IllegalTransition);
    expect(transitionGoal(goal, 'achieved', ['ev1'], { command: 'node --test', exitCode: 0, fingerprint: 'f', evidenceKey: 'ev1', verifiedAt: 1 }).status).toBe('achieved');

    // a real delivered run: the proof names the final verify of the committed candidate
    const h = await heldAtPr();
    expect(kinds(h.evs), 'no achievement before the PR is delivered').not.toContain('goal.achieved');
    expect((await h.flow.finish()).code).toBe(0);
    const evs = await h.flow.events();
    const achieved = evs.filter((e) => e.kind === 'goal.achieved');
    expect(achieved).toHaveLength(1);
    const proof = (achieved[0]!.payload as { proof?: Record<string, unknown> }).proof;
    const commit = evs.find((e) => e.kind === 'commit.recorded')!.payload as { d1: string; sha: string };
    const lastVerify = evs.filter((e) => e.kind === 'verify.passed').at(-1)!.payload as { evidenceKey: string; fingerprint: string };
    expect(proof).toMatchObject({ command: h.goal.check.command, exitCode: 0, fingerprint: commit.d1, evidenceKey: lastVerify.evidenceKey });
    expect(lastVerify.fingerprint).toBe(commit.d1);
    expect(typeof proof!.verifiedAt).toBe('number');
    const l = new SqliteLedger(join(h.dir, '.tecera/ledger.sqlite'));
    let evidence: EvidenceRecord[] = [];
    try {
      const rec = await l.getEvidence(String(proof!.evidenceKey));
      expect(rec, 'the proof names evidence in the ledger').toBeTruthy();
      expect(rec).toMatchObject({ runId: h.flow.runId, kind: 'gate.verify' });
      expect(rec!.body).toMatchObject({ exitCode: 0, fingerprint: commit.d1 });
      evidence = await l.listEvidence!(h.flow.runId);
    } finally {
      l.close();
    }
    // derivation: the real events derive achieved; the same events with the proof stripped (and the hash chain
    // recomputed, so the chain is valid and the missing proof is the only difference) do not
    const all = (await ledgerEvents(h.dir)).sort((a, b) => a.seq - b.seq);
    const real = deriveGoalStatus(all, evidence);
    expect(real.chainValid, real.problems.join(' | ')).toBe(true);
    expect(real.goals[h.goalId]?.status, JSON.stringify(real.goals)).toBe('achieved');
    let prev = GENESIS_HASH;
    const stripped = all.map((e) => {
      const { proof: _p, ...rest } = e.payload as Record<string, unknown>;
      const x = (e.kind === 'goal.achieved' ? { ...e, payload: rest } : { ...e }) as Ev;
      x.hash = chainHash(prev, x);
      prev = x.hash;
      return x;
    });
    const derived = deriveGoalStatus(stripped, evidence);
    expect(derived.chainValid, derived.problems.join(' | ')).toBe(true);
    expect(derived.goals[h.goalId]?.status, JSON.stringify(derived.goals)).not.toBe('achieved');
    expect(derived.goals[h.goalId]?.reasons.join(' | ')).toMatch(/proof/);
  }, 240_000);

  it('decision.d5_review_foreign: review.foreign false is refused (parse, `tecera validate`, `tecera run` before any seat); the foreign check compares provider AND key fingerprint', async () => {
    let err: unknown = null;
    try {
      parseManifest(manifestInput({ review: { foreign: false, maxAttempts: 1 } }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ManifestError);
    expect(JSON.stringify((err as ManifestError).issues)).toMatch(/foreign/);
    // gate level: same vendor on another key, another vendor on a writer key, no key: all refused
    expect(() => assertForeign(new StubReviewer('anthropic', undefined, 'kf-reviewer'), WRITERS)).toThrow(SameProviderReview);
    expect(() => assertForeign(new StubReviewer('openai', undefined, 'kf-anthropic'), WRITERS)).toThrow(SameProviderReview);
    expect(() => assertForeign(new StubReviewer('openai', undefined, null), WRITERS)).toThrow(SameProviderReview);
    expect(() => assertForeign(new StubReviewer('openai', undefined, 'kf-openai'), WRITERS)).not.toThrow();
    // runtime
    const { dir, wt } = await sampleRepo({ mutate: editManifest((m) => void (m.review.foreign = false)) }).catch(async (e: unknown) => {
      // `tecera init` itself may refuse the manifest: then build the copy with a valid manifest and break it after
      expect(String(e)).toMatch(/init|foreign|manifest/);
      const r = await sampleRepo();
      editManifest((m) => void (m.review.foreign = false))(r.dir);
      return r;
    });
    expect((await cli(dir, ['validate'])).code).not.toBe(0);
    const asked: string[] = [];
    const flow = new Flow(dir, wt);
    const r = await flow.segment({ tap: (seat) => void asked.push(seat) });
    expect([0, 4]).not.toContain(r.code);
    expect(asked, 'a seat was asked under a non-foreign review manifest').toEqual([]);
  }, 240_000);

  it('decision.d6_plan_requires_pr: a code-changing plan that does not end worker → verify → review → verify → commit → pr (with the open_pr approval) is refused by policy and by `tecera run` before any seat is asked; nothing is committed or delivered', async () => {
    const base = fixturePlan() as unknown as Plan;
    expect(deliveryChainProblems(base), 'control: the shipped plan is a valid delivery chain').toEqual([]);
    expect([...DELIVERY_CHAIN]).toEqual(['worker', 'gate.verify', 'gate.review', 'gate.verify', 'gate.commit', 'gate.pr']);
    const variants: Array<[string, (p: Plan) => Plan]> = [
      ['no gate.pr', (p) => ({ ...p, steps: p.steps.filter((s) => s.kind !== 'gate.pr') })],
      ['no gate.pr nor gate.commit', (p) => ({ ...p, steps: p.steps.filter((s) => s.kind !== 'gate.pr' && s.kind !== 'gate.commit') })],
      ['gate.pr not after the commit', (p) => ({ ...p, steps: p.steps.map((s) => (s.kind === 'gate.pr' ? { ...s, dependsOn: ['verify2'] } : s)) })],
      ['no final verify', (p) => ({ ...p, steps: p.steps.filter((s) => s.id !== 'verify2').map((s) => (s.kind === 'gate.commit' ? { ...s, dependsOn: ['review'] } : s)) })],
      ['open_pr not in the approvals', (p) => ({ ...p, permissions: { ...p.permissions, approvals: [] } })],
    ];
    for (const [name, change] of variants) {
      const plan = change(structuredClone(base));
      const problems = deliveryChainProblems(plan);
      // the approvals variant is a plan-validation rule, not a chain shape: it is proven by the run below
      if (name !== 'open_pr not in the approvals') expect(problems.length, `${name}: policy accepted the plan`).toBeGreaterThan(0);
      const { dir, wt } = await sampleRepo();
      const asked: string[] = [];
      const flow = new Flow(dir, wt, fixtureReplies(), {}, plan);
      const r = await flow.segment({ tap: (seat) => void asked.push(seat) });
      expect([0, 4], `${name}: exit ${r.code}\n${r.err}`).not.toContain(r.code);
      expect(asked, `${name}: a seat was asked`).toEqual([]);
      const evs = await flow.events();
      for (const k of ['step.started', 'commit.recorded', 'approval.requested', 'pr.requested', 'pr.opened', 'goal.achieved']) expect(kinds(evs), `${name}: ${k}`).not.toContain(k);
      expect(git(dir, 'branch', '--list', 'tecera/*').trim(), name).toBe('');
    }
  }, 300_000);

  it('decision.d7_openrouter_canary: the OpenRouter key (the sample planner and worker seats are OpenRouter seats) never appears in a model request body, a sandbox child or its environment, the verify environment, the ledger bytes, the run export or PR bundle, or any CLI output, through a whole delivered run', async () => {
    const KEY = KEYS.OPENROUTER_API_KEY;
    const dumpDir = tmp('tecera-adv-orenv-');
    chmodSync(dumpDir, 0o777);
    const verifyEnvFile = join(dumpDir, 'env.jsonl');
    const { dir, wt } = await sampleRepo({
      mutate: (d) => writeFileSync(join(d, 'test/env.test.js'), `import { test } from 'node:test';\nimport { appendFileSync } from 'node:fs';\ntest('env probe', () => { appendFileSync(${JSON.stringify(verifyEnvFile)}, JSON.stringify(process.env) + '\\n'); });\n`),
    });
    const requests: Array<{ seat: string; url: string; body: string }> = [];
    const child: string[] = [];
    const envs: string[] = [];
    const unreadable: number[] = [];
    const wire = {
      tap: (seat: string, url: string, body: string) => void requests.push({ seat, url, body }),
      childTap: (_kind: 'exec' | 'result', data: string) => {
        child.push(data);
        for (const pid of sandboxNodes()) {
          const e = environ(pid);
          if (e === null) unreadable.push(pid);
          else envs.push(e);
        }
      },
    };
    const saved = { ...process.env };
    Object.assign(process.env, KEYS);
    const outs: string[] = [];
    const flow = new Flow(dir, wt);
    try {
      const held = await flow.drive({ wire });
      expect(held.code, held.err + held.out + (await dump(dir))).toBe(4);
      const done = await flow.finish(wire);
      expect(done.code, done.err + done.out + (await dump(dir))).toBe(0);
      for (const s of flow.segments) outs.push(s.out, s.err);
      for (const argv of [['evidence', flow.runId], ['status', '--run', flow.runId, '--json'], ['status', '--run', flow.runId]]) {
        const r = await cli(dir, argv, { env: flow.env });
        expect(r.code, r.err).toBe(0);
        outs.push(r.out, r.err);
      }
      outs.push((await stopHook(dir)).err);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    // coverage: the OpenRouter seats were really used, the children and the verify env were really read
    const routed = requests.filter((r) => /openrouter\.ai/.test(r.url));
    expect(routed.length, requests.map((r) => `${r.seat} ${r.url}`).join('\n')).toBeGreaterThan(1);
    expect(routed.some((r) => r.seat === 'worker')).toBe(true);
    expect(unreadable, 'unreadable sandbox environments').toEqual([]);
    expect(envs.length).toBeGreaterThan(0);
    expect(existsSync(verifyEnvFile)).toBe(true);
    const ledgerFiles = readdirSync(join(dir, '.tecera')).filter((n) => n.startsWith('ledger.sqlite'));
    expect(ledgerFiles.length).toBeGreaterThan(0);
    const runFiles = walkFiles(join(dir, '.tecera/runs', flow.runId), () => true);
    expect(runFiles.some((f) => f.startsWith('pr/')), 'the PR bundle').toBe(true);
    const evs = await flow.events();
    expect(JSON.stringify(evs.filter((e) => e.kind === 'evidence.appended').map((e) => e.payload))).toMatch(/"provider":"openrouter"/);
    // zero hits
    const needles = [KEY, Buffer.from(KEY).toString('base64'), Buffer.from(KEY).toString('hex'), encodeURIComponent(KEY), KEY.slice(-20)];
    const hits: string[] = [];
    const scan = (where: string, t: string) => {
      for (const n of needles) if (t.includes(n)) hits.push(`${where}: ${n.slice(0, 12)}…`);
    };
    for (const r of requests) scan(`model request ${r.seat}`, r.body + r.url);
    for (const c of child) scan('sandbox traffic', c);
    for (const e of envs) scan('sandbox env', e);
    scan('verify env', readFileSync(verifyEnvFile, 'utf8'));
    for (const f of ledgerFiles) scan(f, readFileSync(join(dir, '.tecera', f)).toString('latin1'));
    for (const f of runFiles) scan(`run file ${f}`, readFileSync(join(dir, '.tecera/runs', flow.runId, f)).toString('latin1'));
    for (const o of outs) scan('cli output', o);
    expect(hits).toEqual([]);
    // the sandbox and verify environments never even carry the variable's name
    for (const e of envs) expect(e.split('\0').some((kv) => kv.startsWith('OPENROUTER_API_KEY='))).toBe(false);
    for (const line of readFileSync(verifyEnvFile, 'utf8').trim().split('\n')) expect(Object.keys(JSON.parse(line) as object)).not.toContain('OPENROUTER_API_KEY');
  }, 300_000);
});
