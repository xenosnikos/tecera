import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { approvalGrantedEvent, LedgerError, type ApprovalRequest, type Principal } from '@tecera/contracts';
import { prActionHash } from '@tecera/gates';
import { SqliteLedger } from '@tecera/ledger';
import { approve, cli, dump, fixturePlan, fixtureReplies, Flow, git, js, requestIdOf, sampleRepo, type Ev } from './harness/e2e.js';
import { branchExists, driveToCommit, driveToPr, gateRig, grantAudited, grantPr, HUMAN, NOW, StubReviewer } from './harness/gates.js';
import { cleanupTemps, tmp } from './harness/tmp.js';

/**
 * security.md §6 approval.* under the owner decisions of 2026-10-05:
 *  - D1: no auth package, no token ingress. A decision is made by the local human principal running
 *    `tecera approve <id> --as <who>` (default $USER), recorded with its audited approval.granted event;
 *    separation of duty stays (approver ≠ requester, only a human grants) and agents cannot reach the command.
 *  - D6: worker writes and the commit to the work branch need no approval; gate.pr is the ONLY approval point.
 *    Its grant is bound to prActionHash of the committed sha, one-use, consumed by the PR gate itself.
 * Against the REAL SqliteLedger (conditional UPDATE), the REAL PR gate (which consumes), and the real CLI on a
 * scripted run held at its PR.
 */

afterAll(cleanupTemps);

const AGENT: Principal = { kind: 'agent', id: 'loop' };

function ledger(): { l: SqliteLedger; path: string } {
  const path = join(tmp('tecera-adv-approval-'), 'l.sqlite');
  return { l: new SqliteLedger(path), path };
}

const req = (o: Partial<ApprovalRequest> = {}): ApprovalRequest => ({ requestId: 'ap1', runId: 'run1', sessionId: 's1', actionHash: 'h'.repeat(64), requester: AGENT, reason: 'gate.pr', expiresAt: NOW + 60_000, ...o });

/** Refused by the ledger, for the stated reason (so the refusal is the rule under test, not something else). */
async function expectLedgerRefusal(p: Promise<unknown>, why?: RegExp): Promise<void> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e, 'expected a ledger refusal').toBeInstanceOf(LedgerError);
  if (why) expect((e as Error).message).toMatch(why);
}

const H = 'h'.repeat(64);
const grant = (l: SqliteLedger, requestId: string, sessionId = 's1', approver: Principal = HUMAN) => grantAudited(l, { requestId, runId: 'run1', sessionId, actionHash: H, approver, at: NOW });

const BRANCH = 'tecera/fix-failing-test';

/** A scripted run held at its PR (D6: the only hold); the commit is already on the work branch. */
async function prHold() {
  const { dir, wt } = await sampleRepo();
  const mainSha = git(dir, 'rev-parse', 'main').trim();
  const flow = new Flow(dir, wt);
  const seg = await flow.drive();
  expect(seg.code, seg.err + seg.out + (await dump(dir))).toBe(4);
  const pending = await flow.pending();
  expect(pending?.trace.stepId).toBe('pr');
  const evs = await flow.events();
  expect(evs.filter((e) => e.kind === 'approval.requested').map((e) => e.trace.stepId), 'the PR is the only approval point').toEqual(['pr']);
  const commit = evs.find((e) => e.kind === 'commit.recorded');
  expect(commit, 'committed to the work branch without approval').toBeTruthy();
  const sha = (commit!.payload as { sha: string }).sha;
  expect(git(dir, 'rev-parse', BRANCH).trim()).toBe(sha);
  // the request is bound to the committed sha
  expect((pending!.payload as { actionHash?: string }).actionHash ?? (evs.find((e) => e.kind === 'approval.requested')!.payload as { actionHash: string }).actionHash).toBe(
    prActionHash({ intentionId: pending!.trace.intentionId!, stepId: 'pr', attempt: (evs.find((e) => e.kind === 'approval.requested')!.payload as { attempt: number }).attempt, sha }),
  );
  return { flow, dir, wt, env: flow.env, runId: flow.runId, requestId: requestIdOf(pending)!, sha, mainSha };
}

const consumedFor = (evs: Ev[], rid: string): Ev[] => evs.filter((e) => e.kind === 'approval.consumed' && requestIdOf(e) === rid);
const prEvents = (evs: Ev[]): Ev[] => evs.filter((e) => e.kind === 'pr.requested' || e.kind === 'pr.opened');
const bundleFiles = (dir: string, runId: string): string[] => {
  const d = join(dir, '.tecera/runs', runId, 'pr');
  return existsSync(d) ? readdirSync(d) : [];
};

async function approvalState(dir: string, requestId: string): Promise<string | undefined> {
  const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
  try {
    return (await l.getApproval(requestId))?.state;
  } finally {
    l.close();
  }
}

/** Nothing was delivered: no PR event, no bundle, the base branch untouched; the commit stays on the work branch. */
async function nothingDelivered(h: Awaited<ReturnType<typeof prHold>>): Promise<void> {
  const evs = await h.flow.events();
  expect(prEvents(evs), 'a PR was delivered').toEqual([]);
  expect(evs.map((e) => e.kind)).not.toContain('goal.achieved');
  expect(bundleFiles(h.dir, h.runId), 'a PR bundle was written').toEqual([]);
  expect(git(h.dir, 'rev-parse', 'main').trim(), 'the base branch moved').toBe(h.mainSha);
}

/** The host pre-tool hook (Claude Code PreToolUse) on a Bash command: exit 2 blocks. */
const preToolBash = (dir: string, command: string) => cli(dir, ['hook', 'pre-tool'], { stdin: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Bash', tool_input: { command } }) });

describe('approval (security.md §6; D1 local principal, D6 PR gate)', () => {
  it('approval.self_approve', async () => {
    const { l, path } = ledger();
    // a human requester cannot grant their own request; an agent can never grant
    await l.requestApproval(req({ requester: HUMAN }));
    await expectLedgerRefusal(grant(l, 'ap1'));
    await l.requestApproval(req({ requestId: 'ap2' }));
    await expectLedgerRefusal(grant(l, 'ap2', 's1', AGENT));
    await expectLedgerRefusal(grant(l, 'ap2', 's1', { kind: 'agent', id: 'reviewer-human' }));
    expect((await l.getApproval('ap1'))?.state).toBe('pending');
    expect((await l.getApproval('ap2'))?.state).toBe('pending');
    // even if a bug wrote a self-grant straight into the store AND its audit event, consume refuses it (conditional UPDATE)
    l.close();
    const db = new DatabaseSync(path);
    const forged = db.prepare("UPDATE approvals SET state = 'granted', approver_kind = requester_kind, approver_id = requester_id, granted_at = ? WHERE request_id = 'ap1'").run(NOW);
    db.close();
    expect(forged.changes, 'the forged self-grant was written').toBe(1);
    const l2 = new SqliteLedger(path);
    await l2.append(approvalGrantedEvent({ id: 'forged_audit', at: NOW, requestId: 'ap1', runId: 'run1', sessionId: 's1', actionHash: H, approver: HUMAN, trace: { goalId: 'g1', intentionId: 'i1', stepId: 'pr' } }));
    expect((await l2.getApproval('ap1'))?.state).toBe('granted');
    await expectLedgerRefusal(l2.consume('ap1', H, 's1', 'idem-1', NOW + 1), /own request/);
    expect((await l2.getApproval('ap1'))?.state).toBe('granted');
    l2.close();

    // PR gate: a self-approved grant and an agent "approval" bound to the right sha deliver nothing
    for (const [name, who] of [
      ['self-approved', { requester: HUMAN, approver: HUMAN }],
      ['agent approver', { approver: { kind: 'agent', id: 'reviewer-agent' } as Principal }],
    ] as const) {
      const rig = gateRig({ change: (r) => r.write('src/a.ts', 'export const a = 2;\n') });
      const { pr, sha, commit } = await driveToPr(rig, { grant: false });
      expect(pr.exitCode, `${name}: no approval at all`).not.toBe(0);
      // the ledger refuses the grant itself; a request left pending (or a forged row) is still no authority
      const ap = await grantPr(rig.ledger, { sha, requestId: 'ap-self', ...who }).catch((e: unknown) => {
        expect(e, name).toBeInstanceOf(LedgerError);
        return { requestId: 'ap-self', sessionId: 's1', actionHash: prActionHash({ intentionId: 'i1', stepId: 'pr', attempt: 0, sha }) };
      });
      expect((await rig.ledger.getApproval!('ap-self'))?.state, name).not.toBe('granted');
      const r = await rig.gates.pr(rig.ctx('pr', { approval: ap, commit }));
      expect(r.exitCode, name).not.toBe(0);
      expect(readdirSync(rig.runsDir), `${name}: a PR bundle was written`).toEqual([]);
    }

    // host: an agent cannot reach the approval command, nor push or open a PR itself (the pre-tool hook blocks)
    const h = await prHold();
    for (const cmd of [`tecera approve ${h.requestId} --as reviewer-human --yes`, `tecera approve ${h.requestId}`, `git push origin ${BRANCH}`, `gh pr create --base main --head ${BRANCH}`, `gh pr merge 1`]) {
      const r = await preToolBash(h.dir, cmd);
      expect(r.code, `pre-tool hook let an agent run: ${cmd}`).toBe(2);
    }
    expect(await approvalState(h.dir, h.requestId)).toBe('pending');
    // CLI: no principal at all (no --as, no $USER/$USERNAME) → refused; a legacy approver token is no ingress
    const anon = await approve(h.dir, h.requestId, { ...h.env, USER: '', USERNAME: '' }, null);
    expect(anon.code, anon.out + anon.err).not.toBe(0);
    expect(await approvalState(h.dir, h.requestId)).toBe('pending');
    const tok = await cli(h.dir, ['approve', h.requestId, '--token', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJyb290In0.', '--yes'], { env: { ...h.env, USER: '', USERNAME: '' } });
    expect(tok.code).not.toBe(0);
    expect(await approvalState(h.dir, h.requestId)).toBe('pending');
    // and resuming without a grant delivers nothing (the hold stays; the commit stays on the work branch only)
    const resumed = await h.flow.segment();
    expect(resumed.code).toBe(4);
    await nothingDelivered(h);
    expect(git(h.dir, 'rev-parse', BRANCH).trim()).toBe(h.sha);
    expect(await approvalState(h.dir, h.requestId)).toBe('pending');
    // the local human principal is the one and only ingress: approving as $USER (no --as) delivers once
    const ok = await approve(h.dir, h.requestId, { ...h.env, USER: 'owner-human' }, null);
    expect(ok.code, ok.err).toBe(0);
    const granted = (await h.flow.events()).find((e) => e.kind === 'approval.granted' && requestIdOf(e) === h.requestId);
    expect(granted?.payload, 'the audited grant names the local human principal').toMatchObject({ approver: { kind: 'human', id: 'owner-human' } });
    expect(JSON.stringify(granted?.payload)).toMatch(/"method":"local"/);
    const done = await h.flow.segment();
    expect(done.code, done.err + done.out + (await dump(h.dir))).toBe(0);
    expect(prEvents(await h.flow.events())).toHaveLength(1);
  }, 240_000);

  it('approval.replay', async () => {
    const { l } = ledger();
    await l.requestApproval(req());
    await expectLedgerRefusal(grant(l, 'ap1', 'other-session'));
    await grant(l, 'ap1');
    await expectLedgerRefusal(grant(l, 'ap1')); // granted twice
    await expectLedgerRefusal(l.consume('ap1', H, 'other-session', 'idem-x', NOW + 1), /session/); // cross-session
    await l.consume('ap1', H, 's1', 'idem-1', NOW + 1);
    await expectLedgerRefusal(l.consume('ap1', H, 's1', 'idem-2', NOW + 2), /consumed/); // second use
    await expectLedgerRefusal(l.consume('ap1', H, 's1', 'idem-1', NOW + 2)); // same idem key
    expect((await l.getApproval('ap1'))?.state).toBe('consumed');
    // a duplicate request id cannot reset the row
    await expectLedgerRefusal(l.requestApproval(req()));
    // expired grants cannot be consumed
    await l.requestApproval(req({ requestId: 'ap3', expiresAt: NOW + 10 }));
    await grant(l, 'ap3');
    await expectLedgerRefusal(l.consume('ap3', H, 's1', 'idem-3', NOW + 10), /expired/);
    // a grant without its approval.granted audit event cannot be consumed (it never went through the CLI)
    await l.requestApproval(req({ requestId: 'ap4' }));
    await l.approve('ap4', HUMAN, 's1', NOW);
    await expectLedgerRefusal(l.consume('ap4', H, 's1', 'idem-4', NOW + 1), /unaudited/);
    expect((await l.getApproval('ap4'))?.state).toBe('granted');
    l.close();

    // PR gate: a consumed grant is no authority for a later attempt (a different action)
    const rig = gateRig({ change: (r) => r.write('src/a.ts', 'export const a = 2;\n') });
    const { pr, ap, commit } = await driveToPr(rig);
    expect(pr.exitCode, JSON.stringify(pr)).toBe(0);
    expect((await rig.ledger.getApproval!(ap!.requestId))?.state).toBe('consumed');
    const bundle = readdirSync(join(rig.runsDir, 'run1', 'pr')).sort();
    const again = await rig.gates.pr(rig.ctx('pr', { approval: ap!, attempt: 1, commit }));
    expect(again.exitCode).not.toBe(0);
    expect(readdirSync(join(rig.runsDir, 'run1', 'pr')).sort(), 'the replay wrote nothing').toEqual(bundle);

    // runtime: after the delivered PR, approving again or resuming again changes nothing
    const h = await prHold();
    const done = await h.flow.finish();
    expect(done.code, done.err + done.out).toBe(0);
    const files = bundleFiles(h.dir, h.runId).sort();
    expect(files.length, 'the PR bundle').toBeGreaterThan(0);
    expect((await approve(h.dir, h.requestId, h.env)).code, 'a consumed grant cannot be approved again').not.toBe(0);
    await h.flow.segment();
    expect(Number(git(h.dir, 'rev-list', '--count', `main..${BRANCH}`).trim())).toBe(1);
    const evs = await h.flow.events();
    expect(evs.filter((e) => e.kind === 'commit.recorded')).toHaveLength(1);
    expect(prEvents(evs)).toHaveLength(1);
    expect(evs.filter((e) => e.kind === 'goal.achieved')).toHaveLength(1);
    expect(consumedFor(evs, h.requestId)).toHaveLength(1);
    expect(bundleFiles(h.dir, h.runId).sort()).toEqual(files);
    expect(git(h.dir, 'rev-parse', 'main').trim(), 'Tecera never merges').toBe(h.mainSha);
  }, 240_000);

  it('approval.hash_mismatch', async () => {
    const { l } = ledger();
    await l.requestApproval(req());
    await grant(l, 'ap1');
    await expectLedgerRefusal(l.consume('ap1', 'f'.repeat(64), 's1', 'idem-1', NOW + 1), /action hash/);
    expect((await l.getApproval('ap1'))?.state).toBe('granted');
    l.close();

    // PR gate, wrong sha: a grant bound to another sha (another commit, the D1 fingerprint, another step,
    // attempt or intention) is refused and never consumed
    const rig = gateRig({ change: (r) => r.write('src/a.ts', 'export const a = 2;\n') });
    const { pr: none, sha, commit, d1 } = await driveToPr(rig, { grant: false });
    expect(none.exitCode).not.toBe(0);
    const wrong: Array<[string, Parameters<typeof grantPr>[1], Partial<Parameters<typeof rig.ctx>[1]>]> = [
      ['another sha', { sha: 'f'.repeat(40), requestId: 'w1' }, {}],
      ['the D1 fingerprint (a commit-style binding)', { sha: d1, requestId: 'w2' }, {}],
      ['another step', { sha, stepId: 'c', requestId: 'w3' }, {}],
      ['another attempt', { sha, requestId: 'w4' }, { attempt: 1 }],
      ['another intention', { sha, requestId: 'w5' }, { intentionId: 'i2' }],
    ];
    for (const [name, g, x] of wrong) {
      const ap = await grantPr(rig.ledger, g);
      const r = await rig.gates.pr(rig.ctx('pr', { approval: ap, commit, ...x }));
      expect(r.exitCode, name).not.toBe(0);
      expect((await rig.ledger.getApproval!(ap.requestId))?.state, name).toBe('granted');
    }
    expect(readdirSync(rig.runsDir), 'nothing delivered on a mismatched grant').toEqual([]);
    // the work branch moves after the grant (an amended or extra commit): the grant is for the old sha → refused
    const moved = gateRig({ change: (r) => r.write('src/a.ts', 'export const a = 2;\n') });
    const m = await driveToPr(moved, {
      beforePr: () => {
        moved.repo.write('src/a.ts', 'export const a = 666;\n');
        moved.repo.g('-c', 'user.email=x@example.com', '-c', 'user.name=x', 'commit', '-q', '-am', 'sneaky');
      },
    });
    expect(m.pr.exitCode).not.toBe(0);
    expect((await moved.ledger.getApproval!(m.ap!.requestId))?.state).toBe('granted');
    expect(readdirSync(moved.runsDir)).toEqual([]);

    // runtime: approve the PR, then the work branch moves before the resume → nothing delivered, grant unspent
    const h = await prHold();
    expect((await approve(h.dir, h.requestId, h.env)).code).toBe(0);
    const tree = git(h.dir, 'rev-parse', `${h.sha}^{tree}`).trim();
    const other = git(h.dir, 'commit-tree', tree, '-p', h.sha, '-m', 'sneaky follow-up').trim();
    git(h.dir, 'update-ref', `refs/heads/${BRANCH}`, other, h.sha);
    expect(git(h.dir, 'rev-parse', BRANCH).trim()).toBe(other);
    const resumed = await h.flow.segment();
    expect(resumed.code).not.toBe(0);
    await nothingDelivered(h);
    expect(consumedFor(await h.flow.events(), h.requestId)).toHaveLength(0);
    expect(await approvalState(h.dir, h.requestId)).toBe('granted');
  }, 240_000);

  it('approval.hash_mismatch [missing review]: a PR is never delivered for a commit whose D1 has no passed review — not by the PR gate on a commit a compromised review let through, and not by a plan that skips gate.review', async () => {
    // gate level: the reviewer rejects; a compromised memo lets the commit gate commit anyway; the PR gate reads
    // the review on record for the committed D1 and refuses a valid, correctly bound human grant
    const rig = gateRig({ reviewer: new StubReviewer('openai', () => '{"verdict":"reject","findings":[{"title":"no"}]}'), change: (r) => r.write('src/a.ts', 'export const a = 2;\n') });
    const d = await driveToCommit(rig, { compromisedReview: true });
    expect(d.r.verdict, 'the reviewer really rejected').toBe('reject');
    if (d.c.exitCode === 0) {
      const ap = await grantPr(rig.ledger, { sha: d.c.sha! });
      const pr = await rig.gates.pr(rig.ctx('pr', { approval: ap, commit: { sha: d.c.sha!, d1: d.d1, evidenceKey: d.c.evidenceKey } }));
      expect(pr.exitCode, JSON.stringify(pr)).not.toBe(0);
      expect(JSON.stringify(pr)).toMatch(/review/);
      expect((await rig.ledger.getApproval!(ap.requestId))?.state, 'the grant was not spent').toBe('granted');
    } else expect(branchExists(rig.repo)).toBe(false);
    expect(readdirSync(rig.runsDir)).toEqual([]);

    // runtime: a scripted plan without the review step (worker → verify → verify → commit → pr) is refused
    // before anything runs: no worker turn, no commit, no approval request
    const { dir, wt } = await sampleRepo();
    const plan = fixturePlan() as { steps: Array<{ id: string; kind: string; dependsOn: string[] }> };
    plan.steps = plan.steps.filter((s) => s.kind !== 'gate.review').map((s) => (s.id === 'verify2' ? { ...s, dependsOn: ['verify'] } : s));
    const asked: string[] = [];
    const flow = new Flow(dir, wt, fixtureReplies(), {}, plan);
    const r = await flow.segment({ tap: (seat) => void asked.push(seat) });
    expect([0, 4]).not.toContain(r.code);
    const evs = await flow.events();
    expect(asked, 'a seat was asked on a plan without review').toEqual([]);
    for (const k of ['approval.requested', 'commit.recorded', 'pr.requested', 'pr.opened', 'goal.achieved']) expect(evs.map((e) => e.kind), k).not.toContain(k);
    expect(git(dir, 'branch', '--list', 'tecera/*').trim()).toBe('');
  }, 240_000);

  it('approval.replay [two writes, one path, degraded isolation]: no per-write approval exists to replay — both writes to ONE file land in one exec with no approval (fenced and logged), the commit needs none, and the single PR grant is spent exactly once', async () => {
    const { dir, wt } = await sampleRepo();
    const fx = fixtureReplies();
    const SRC = 'src/slugify.js';
    const twoWrites = {
      expect: 'Fix the root cause',
      text: js(`await writeFile({ path: '${SRC}', oldText: '// Turn free text into a URL slug: lower-case words joined by single dashes.', newText: '// Runs of separators collapse to one dash.' });
await writeFile({ path: '${SRC}', oldText: "(m) => '-'.repeat(m.length)", newText: "'-'" });
const v = await runVerify();
return { facts: [{ key: 'changedFiles', value: ['${SRC}'] }, { key: 'verifyExit', value: v.exitCode }] };`),
    };
    const flow = new Flow(dir, wt, { ...fx, worker: [fx.worker[0]!, twoWrites] });
    const held = await flow.drive();
    expect(held.code, held.err + held.out + (await dump(dir))).toBe(4);
    expect((await flow.pending())?.trace.stepId).toBe('pr');
    const after = readFileSync(join(wt, flow.runId, SRC), 'utf8');
    expect(after, 'both writes landed').toContain('Runs of separators collapse to one dash.');
    expect(after).not.toContain("'-'.repeat(m.length)");
    let evs = await flow.events();
    // degraded isolation is recorded, and it holds nothing: no write hold, no step hold, no approval but the PR's
    expect(evs.some((e) => e.kind === 'isolation.degraded')).toBe(true);
    expect(evs.filter((e) => e.kind === 'step.held' && (e.payload as { write?: unknown }).write !== undefined), 'a per-write hold').toEqual([]);
    expect(evs.filter((e) => e.kind === 'step.held').map((e) => e.trace.stepId)).toEqual(['pr']);
    expect(evs.filter((e) => e.kind === 'approval.requested').map((e) => e.trace.stepId)).toEqual(['pr']);
    // logged: each write is an audited tool call (span evidence naming the path), under the run's fencing
    const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
    let writes: Array<{ path?: string; tool?: string }> = [];
    try {
      writes = (await l.listEvidence!(flow.runId, 'span.ToolCall')).map((r) => (r.body as { input?: { tool?: string; args?: Array<{ path?: string }> } }).input).filter((i) => i?.tool === 'edit').map((i) => ({ tool: i!.tool, path: i!.args?.[0]?.path }));
    } finally {
      l.close();
    }
    expect(writes.filter((w) => w.path === SRC), JSON.stringify(writes)).toHaveLength(2);
    const sha = (evs.find((e) => e.kind === 'commit.recorded')!.payload as { sha: string }).sha;
    expect(createHash('sha256').update(git(dir, 'show', `${sha}:${SRC}`)).digest('hex')).toBe(createHash('sha256').update(after).digest('hex'));
    // the one grant: approved once, consumed once, never again
    const rid = await flow.approvePending('pr');
    const done = await flow.segment();
    expect(done.code, done.err + done.out + (await dump(dir))).toBe(0);
    expect((await approve(dir, rid, flow.env)).code).not.toBe(0);
    evs = await flow.events();
    expect(consumedFor(evs, rid)).toHaveLength(1);
    expect(prEvents(evs)).toHaveLength(1);
    expect(git(dir, 'rev-list', '--count', `main..${BRANCH}`).trim()).toBe('1');
  }, 300_000);
});
