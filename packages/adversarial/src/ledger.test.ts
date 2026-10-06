import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { event, verifyCommandDigest, type GateContext } from '@tecera/contracts';
import { SqliteLedger } from '@tecera/ledger';
import { replayRun } from '@tecera/runtime';
import { dump, Flow, sampleRepo, type SegmentWire } from './harness/e2e.js';
import { cleanupTemps, tmp } from './harness/tmp.js';

/**
 * security.md §6 ledger.append_only: UPDATE/DELETE on the events (and evidence) tables of the REAL SQLite
 * ledger file abort in the database itself (triggers), whoever opens the file; and if someone strips the
 * triggers and rewrites history anyway, the hash chain names the first broken link.
 */

afterAll(cleanupTemps);

async function seeded(): Promise<string> {
  const path = join(tmp('tecera-adv-ledger-'), 'ledger.sqlite');
  const l = new SqliteLedger(path);
  for (let i = 0; i < 5; i++) {
    await l.append(event('belief.added', { id: `e${i}`, at: 1000 + i, actor: { kind: 'system', id: 'adv' }, runId: 'run1', trace: {}, payload: { key: `k${i}`, value: i } }));
  }
  await l.evidence({ key: 'ev1', kind: 'gate.verify', runId: 'run1', body: { outcome: 'passed' } });
  l.close();
  return path;
}

describe('ledger (security.md §6)', () => {
  it('ledger.append_only', async () => {
    const path = await seeded();
    const db = new DatabaseSync(path);
    const before = (db.prepare('SELECT count(*) AS c FROM events').get() as { c: number }).c;
    expect(before).toBe(5);
    for (const sql of [
      "UPDATE events SET payload = '{\"key\":\"k0\",\"value\":999}' WHERE seq = 1",
      "UPDATE events SET kind = 'goal.achieved' WHERE seq = 5",
      'DELETE FROM events WHERE seq = 3',
      'DELETE FROM events',
      "UPDATE evidence SET body = '{\"outcome\":\"failed\"}' WHERE key = 'ev1'",
      "DELETE FROM evidence WHERE key = 'ev1'",
    ]) {
      expect(() => db.exec(sql), sql).toThrow(/append-only/);
    }
    db.close();
    const l = new SqliteLedger(path);
    expect(await l.verifyChain()).toEqual({ ok: true, length: 5 });
    expect((await l.getEvidence('ev1'))?.body).toEqual({ outcome: 'passed' });
    l.close();

    // with the triggers stripped and history rewritten, the chain detects the edit
    const db2 = new DatabaseSync(path);
    db2.exec('DROP TRIGGER events_no_update');
    db2.exec("UPDATE events SET payload = '{\"key\":\"k2\",\"value\":42}' WHERE seq = 3");
    db2.close();
    const l2 = new SqliteLedger(path);
    expect(await l2.verifyChain()).toEqual({ ok: false, brokenAtSeq: 3 });
    l2.close();
  });

  // SQLite REPLACE conflict resolution deletes the conflicting row WITHOUT firing DELETE triggers, so the
  // append-only guarantee needs BEFORE INSERT no-replace triggers. The attack replays each FULL row (every
  // column, chain columns included) with only the payload/body changed, so the only possible refusal is the
  // no-replace trigger; a positive control proves the same statements do rewrite once the triggers are gone,
  // and that verifyChain then names the broken event and the broken evidence row.
  it('ledger.append_only [REPLACE]: INSERT OR REPLACE / REPLACE of an event or an evidence row aborts in the database; without the triggers verifyChain names the rewrite', async () => {
    const path = await seeded();
    const evCols = 'seq, id, kind, at, actor_kind, actor_id, run_id, goal_id, intention_id, step_id, plan_id, payload, idem_key, prev_hash, hash';
    const rewriteEvent = `INSERT OR REPLACE INTO events (${evCols}) SELECT seq, id, kind, at, actor_kind, actor_id, run_id, goal_id, intention_id, step_id, plan_id, '{"key":"k1","value":"rewritten"}', idem_key, prev_hash, hash FROM events WHERE seq = 2`;
    const eviCols = 'key, kind, run_id, digest, body, seq, n, prev_hash, hash, event_hash';
    const rewriteEvidence = `REPLACE INTO evidence (${eviCols}) SELECT key, kind, run_id, digest, '{"outcome":"failed"}', seq, n, prev_hash, hash, event_hash FROM evidence WHERE key = 'ev1'`;
    const db = new DatabaseSync(path);
    // the rows to rewrite exist and carry their chain columns (so the statements are well-formed replays)
    expect(db.prepare('SELECT count(*) AS c FROM events WHERE seq = 2').get()).toEqual({ c: 1 });
    const evRow = db.prepare("SELECT n, prev_hash, hash, event_hash FROM evidence WHERE key = 'ev1'").get() as Record<string, unknown>;
    for (const c of ['n', 'prev_hash', 'hash', 'event_hash']) expect(evRow[c], c).not.toBeNull();
    expect(() => db.exec(rewriteEvent)).toThrow(/events are append-only: seq, id, idem_key or hash already exists/);
    expect(() => db.exec(rewriteEvidence)).toThrow(/evidence is append-only: key or n already exists/);
    expect(() => db.exec(rewriteEvent.replace('INSERT OR REPLACE', 'REPLACE'))).toThrow(/append-only/);
    expect((db.prepare('SELECT payload FROM events WHERE seq = 2').get() as { payload: string }).payload).not.toContain('rewritten');
    expect((db.prepare("SELECT body FROM evidence WHERE key = 'ev1'").get() as { body: string }).body).not.toContain('failed');
    db.close();
    const l = new SqliteLedger(path);
    expect(await l.verifyChain()).toEqual({ ok: true, length: 5 });
    l.close();

    // positive control: with every trigger dropped the same statements DO rewrite, and the chains name the edits
    const db2 = new DatabaseSync(path);
    for (const t of db2.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>) db2.exec(`DROP TRIGGER ${t.name}`);
    db2.exec(rewriteEvidence);
    expect((db2.prepare("SELECT body FROM evidence WHERE key = 'ev1'").get() as { body: string }).body).toContain('failed');
    db2.close();
    const l2 = new SqliteLedger(path);
    expect(await l2.verifyChain()).toMatchObject({ ok: false, brokenEvidenceKey: 'ev1' });
    l2.close();
    const db3 = new DatabaseSync(path);
    for (const t of db3.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>) db3.exec(`DROP TRIGGER ${t.name}`);
    db3.exec(rewriteEvent);
    expect((db3.prepare('SELECT payload FROM events WHERE seq = 2').get() as { payload: string }).payload).toContain('rewritten');
    db3.close();
    const l3 = new SqliteLedger(path);
    expect(await l3.verifyChain()).toMatchObject({ ok: false, brokenAtSeq: 2 });
    l3.close();
  });

  it('ledger.append_only [replay binding]: a run whose gates certified ANOTHER command than the goal check (a substituted check in the same run) never replays as achieved, whatever the loop recorded', async () => {
    const { dir, wt } = await sampleRepo();
    const OTHER = 'node -e "process.exit(0)"';
    const seen: string[] = [];
    const swap = (g: GateContext): GateContext => ({ ...g, goal: { ...g.goal, check: { ...g.goal.check, command: OTHER } } });
    // a compromised wiring: every gate is handed the goal with its check swapped for a command that always passes
    const wire: SegmentWire = {
      wrap: (inner) => async (ctx) => {
        const ports = await inner(ctx);
        const gates = ports.gates;
        ports.gates = {
          verify: (g) => (seen.push(g.goal.check.command), gates.verify(swap(g))),
          review: (g) => gates.review(swap(g)),
          commit: (g) => gates.commit(swap(g)),
          pr: (g) => gates.pr(swap(g)),
          ...(gates.reconcile ? { reconcile: (g: GateContext) => gates.reconcile!(swap(g)) } : {}),
        };
        return ports;
      },
    };
    const flow = new Flow(dir, wt);
    const held = await flow.drive({ wire });
    const finished = held.code === 4 && (await flow.pending())?.trace.stepId === 'pr' ? await flow.finish(wire) : held;
    const evs = await flow.events();
    // the attack ran: the goal's own check is node --test, the gates ran OTHER
    const adopted = evs.find((e) => e.kind === 'goal.adopted')!.payload as { goal: { id: string; check: { command: string } } };
    expect(adopted.goal.check.command).toBe('node --test');
    expect(seen.length, await dump(dir)).toBeGreaterThan(0);
    const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
    try {
      // the run's own baseline check is recorded by the runtime directly (not through the gate port): leave it out
      const verifyEv = (await l.listEvidence!(flow.runId, 'gate.verify')).map((r) => r.body as { command?: string; commandDigest?: string; baseline?: boolean }).filter((b) => typeof b.command === 'string' && b.baseline !== true);
      expect(verifyEv.length).toBeGreaterThan(0);
      expect(verifyEv.every((b) => b.command === OTHER || b.commandDigest === verifyCommandDigest(OTHER)), JSON.stringify(verifyEv).slice(0, 600)).toBe(true);
      const replay = await replayRun(l, flow.runId);
      const g = replay.goals[adopted.goal.id];
      expect(g, JSON.stringify(replay)).toBeTruthy();
      expect(g!.derived, `same-run evidence of another command derived the goal achieved\n${JSON.stringify(g)}`).not.toBe('achieved');
      // D4: an achievement needs a proof whose command is the goal's check. Either the online path refuses too
      // (no goal.achieved), or what it recorded disagrees with replay, which names the command binding.
      const achieved = evs.filter((e) => e.kind === 'goal.achieved');
      console.log(`[ledger replay binding] online path: ${achieved.length ? 'recorded goal.achieved' : 'refused the achievement'} (exit ${finished.code})`);
      if (achieved.length) {
        expect(g!.recorded).toBe('achieved');
        expect(g!.agrees).toBe(false);
        expect(g!.why.join(' | '), 'replay names the command binding').toMatch(/command|check/i);
        const proof = (achieved[0]!.payload as { proof?: { command?: string } }).proof;
        expect(proof?.command, 'a recorded proof never claims the goal check for evidence of another command').not.toBe('node --test');
      } else {
        expect(finished.code, `exit ${finished.code}\n${await dump(dir)}`).not.toBe(0);
        expect(g!.recorded).not.toBe('achieved');
      }
    } finally {
      l.close();
    }
  }, 300_000);
});
