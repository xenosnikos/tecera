import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { gateRig } from './harness/gates.js';
import { expectGap } from './harness/gap.js';
import { cli, dump, fixturePlan, fixtureReplies, Flow, git, js, KEYS, requestIdOf, sampleRepo } from './harness/e2e.js';
import { environ } from './harness/procs.js';
import { sandboxNodes } from './harness/sandbox.js';
import { cleanupTemps, tmp } from './harness/tmp.js';

/**
 * security.md §6 secret.canary_* / §7: plant TECERA_CANARY_<rand> in the supervisor env, a repo file, a tool
 * result (verify output) and __history__ (a child's printed output); add provider keys and a credential-
 * named env value whose characters are not URI-safe; plant ENCODED forms of registered secrets (base64, hex,
 * percent-encoding) and auth headers (Bearer, Basic — including the OpenRouter key the sample's planner and
 * worker seats use, D7) in the repo file; run the full first job (scripted models, real everything else)
 * through commit → PR hold → local human approval → PR delivery (patch bundle) → evidence export; byte-scan
 * every boundary for the raw values and their encoded forms.
 *
 * A scan that finds nothing proves nothing unless it saw the boundary: every scanned boundary also asserts its
 * coverage — the redaction marker where a planted value was legitimately referenced, or (for process
 * environments, where values are dropped rather than redacted) a successful read carrying a known benign
 * variable. An unreadable environment fails the test; it is never an empty, clean scan.
 */

afterAll(cleanupTemps);

const rand = (): string => randomBytes(6).toString('hex');
const MARK = /\[REDACTED:[a-z_-]+:[0-9a-f]{8}\]/;
const b64 = (s: string): string => Buffer.from(s).toString('base64');
const hex = (s: string): string => Buffer.from(s).toString('hex');

describe('secret (security.md §6, §7)', () => {
  it('secret.canary_*', async () => {
    const C_ENV = `TECERA_CANARY_env_${rand()}`;
    const C_REPO = `TECERA_CANARY_repo_${rand()}`;
    const toolSuffix = `tool_${rand()}`;
    const histSuffix = `hist_${rand()}`;
    const C_TOOL = `TECERA_CANARY_${toolSuffix}`;
    const C_HIST = `TECERA_CANARY_${histSuffix}`;
    // not URI-safe: encodeURIComponent(PLAIN) is a distinct form
    const PLAIN = `plain/secret+value=${rand()}`;
    expect(encodeURIComponent(PLAIN)).not.toBe(PLAIN);
    const BASIC = b64(`svc:${KEYS.ANTHROPIC_API_KEY}`);
    const dumpDir = tmp('tecera-adv-verifyenv-');
    chmodSync(dumpDir, 0o777);
    const verifyEnvFile = join(dumpDir, 'env.jsonl');

    // encoded forms planted as INPUTS (in the repo file the worker reads and the reviewer sees)
    const planted = {
      b64: b64(PLAIN),
      hex: hex(PLAIN).toUpperCase(),
      pct: encodeURIComponent(PLAIN),
      bearer: `Authorization: Bearer ${KEYS.OPENAI_API_KEY}`,
      basic: `Authorization: Basic ${BASIC}`,
      orBearer: `Authorization: Bearer ${KEYS.OPENROUTER_API_KEY}`,
    };
    const { dir, wt } = await sampleRepo({
      mutate: (d) => {
        const p = join(d, 'src/slugify.js');
        const header = [`// build ${C_REPO} token ${PLAIN}`, `// b64 ${planted.b64} hex ${planted.hex} pct ${planted.pct}`, `// ${planted.bearer}`, `// ${planted.basic}`, `// router ${planted.orBearer}`].join('\n');
        writeFileSync(p, `${header}\n${readFileSync(p, 'utf8')}`);
        // (a registered secret in the goal STATEMENT is the [planner seat] variant: the planner sees only the marker,
        // `tecera status --json` shows only the marker, and the worker refuses the goal before its sandbox)
        // a test that records the verify process env and prints a canary into the verify output (a tool result)
        writeFileSync(
          join(d, 'test/env.test.js'),
          `import { test } from 'node:test';\nimport { appendFileSync } from 'node:fs';\ntest('env probe', () => {\n  appendFileSync(${JSON.stringify(verifyEnvFile)}, JSON.stringify(process.env) + '\\n');\n  console.log('probe ' + 'TECERA_CAN' + 'ARY_${toolSuffix}');\n});\n`,
        );
      },
    });

    // __history__: a first worker turn whose printed output (and checkpoint) carries a canary built in the child
    const replies = fixtureReplies();
    const histTurn = { expect: 'Run verify and read the failing assertion', text: js(`const c = 'TECERA_CAN' + 'ARY_${histSuffix}';\nconsole.log('history note', c);\ncheckpoint('note', { c });`) };
    replies.worker = [histTurn, ...replies.worker];

    const modelOut: Array<{ seat: string; body: string }> = [];
    const childIn: Array<{ kind: string; data: string }> = [];
    const childEnv: Array<{ pid: number; env: string }> = [];
    const unreadable: number[] = [];
    const wire = {
      tap: (seat: string, _url: string, body: string) => void modelOut.push({ seat, body }),
      childTap: (kind: 'exec' | 'result', data: string) => {
        childIn.push({ kind, data });
        if (kind === 'result') {
          for (const pid of sandboxNodes()) {
            const env = environ(pid);
            if (env === null) unreadable.push(pid);
            else childEnv.push({ pid, env });
          }
        }
      },
    };
    const flow = new Flow(dir, wt, replies, { TECERA_CANARY_ENV: C_ENV, MY_SERVICE_KEY: PLAIN });
    // the supervisor's own process env carries them too (children are spawned from it)
    const saved = { ...process.env };
    Object.assign(process.env, { TECERA_CANARY_ENV: C_ENV, MY_SERVICE_KEY: PLAIN, ...KEYS });
    let out = '';
    let statusJson = '';
    try {
      const held = await flow.drive({ wire });
      expect(held.code, held.err + held.out + (await dump(dir))).toBe(4);
      expect((await flow.pending())?.trace.stepId).toBe('pr');
      const done = await flow.finish(wire);
      expect(done.code, done.err + done.out + (await dump(dir))).toBe(0);
      const evs = await flow.events();
      const ex = await cli(dir, ['evidence', flow.runId], { env: flow.env });
      expect(ex.code, ex.err).toBe(0);
      const why = await cli(dir, ['why', evs.find((e) => e.kind === 'commit.recorded')!.id], { env: flow.env });
      expect(why.code, why.err).toBe(0);
      const st = await cli(dir, ['status', '--run', flow.runId], { env: flow.env });
      const stj = await cli(dir, ['status', '--run', flow.runId, '--json'], { env: flow.env });
      expect(stj.code, stj.err).toBe(0);
      statusJson = stj.out;
      out = [...flow.segments.flatMap((s) => [s.out, s.err]), ex.out, ex.err, why.out, why.err, st.out, st.err, stj.out, stj.err].join('\n');
      expect(requestIdOf(evs.find((e) => e.kind === 'approval.requested' && e.trace.stepId === 'pr'))).toBeTruthy();
      expect(evs.some((e) => e.kind === 'pr.requested'), 'the PR was delivered as a bundle (no remote)').toBe(true);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }

    // ---- the planted values really flowed through the run (each boundary was exercised) ----
    expect(modelOut.some((m) => m.seat === 'reviewer')).toBe(true);
    expect(modelOut.filter((m) => m.seat === 'worker').length).toBeGreaterThan(1);
    expect(childIn.filter((c) => c.kind === 'exec').length).toBeGreaterThan(1);
    expect(childIn.filter((c) => c.kind === 'result').length).toBeGreaterThan(3);
    expect(unreadable, 'sandbox child environments that could not be read (an unread boundary is not a clean scan)').toEqual([]);
    expect(childEnv.length, 'sandbox child environments read').toBeGreaterThan(0);
    expect(existsSync(verifyEnvFile), 'the verify process recorded its env').toBe(true);

    // ---- zero hits: raw value, its encoded forms, and the planted encodings, at every boundary ----
    const secrets = [C_ENV, C_REPO, C_TOOL, C_HIST, PLAIN, KEYS.ANTHROPIC_API_KEY, KEYS.OPENAI_API_KEY, KEYS.OPENROUTER_API_KEY];
    const needles = [...secrets.flatMap((v) => [v, b64(v), hex(v), hex(v).toUpperCase(), encodeURIComponent(v)]), planted.b64, planted.hex, planted.pct, BASIC];
    const hits: string[] = [];
    const scan = (where: string, text: string): void => {
      for (const n of needles) if (text.includes(n)) hits.push(`${where}: ${n.slice(0, 24)}…`);
    };
    for (const m of modelOut) scan(`model request (${m.seat})`, m.body);
    for (const c of childIn) scan(`sandbox child ${c.kind}`, c.data);
    for (const e of childEnv) scan(`sandbox child env ${e.pid}`, e.env);
    const verifyEnvText = readFileSync(verifyEnvFile, 'utf8');
    scan('verify env', verifyEnvText);
    const ledgerFiles = readdirSync(join(dir, '.tecera')).filter((n) => n.startsWith('ledger.sqlite'));
    const ledgerBytes = ledgerFiles.map((f) => readFileSync(join(dir, '.tecera', f)).toString('latin1'));
    ledgerBytes.forEach((b, i) => scan(ledgerFiles[i]!, b));
    const exported: string[] = [];
    const prDir = join(dir, '.tecera/runs', flow.runId, 'pr');
    const walk = (d: string): void => {
      for (const n of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, n.name);
        // the PR delivery bundle (D6) carries repository lines verbatim: it is scanned by the [PR bundle] variant
        if (n.isDirectory()) {
          if (p !== prDir) walk(p);
        } else {
          const t = readFileSync(p).toString('latin1');
          exported.push(t);
          scan(`export ${n.name}`, t);
        }
      }
    };
    walk(join(dir, '.tecera/runs', flow.runId));
    expect(existsSync(prDir) && readdirSync(prDir).length > 0, 'the PR bundle was written').toBe(true);
    scan('cli output', out);
    const db = new DatabaseSync(join(dir, '.tecera/ledger.sqlite'), { readOnly: true });
    const checkpoints = (db.prepare('SELECT state FROM checkpoints').all() as Array<{ state: string }>).map((r) => r.state);
    const decisions = (db.prepare("SELECT payload FROM events WHERE kind = 'decision.recorded'").all() as Array<{ payload: string }>).map((r) => r.payload);
    const evidence = db.prepare('SELECT kind, body FROM evidence').all() as Array<{ kind: string; body: string }>;
    db.close();
    for (const c of checkpoints) scan('checkpoint row', c);
    for (const d of decisions) scan('decision record', d);
    for (const e of evidence) scan(`evidence ${e.kind}`, e.body);
    expect(hits).toEqual([]);

    // ---- coverage: every scanned boundary shows it saw the planted values (marker) or was really read ----
    // process environments: values are dropped by the allowlist, never redacted. Coverage = a successful read
    // carrying the allowlisted PATH; and no credential/canary NAME at all.
    for (const e of childEnv) {
      const names = e.env.split('\0').filter(Boolean).map((kv) => kv.split('=')[0]!);
      expect(names, `sandbox child ${e.pid} env read`).toContain('PATH');
      expect(names.filter((n) => /KEY|TOKEN|SECRET|CANARY|API|NODE_OPTIONS/i.test(n))).toEqual([]);
    }
    const verifyEnvs = verifyEnvText.trim().split('\n').map((l) => JSON.parse(l) as Record<string, string>);
    expect(verifyEnvs.length).toBeGreaterThan(0);
    for (const v of verifyEnvs) {
      expect(Object.keys(v), 'verify env read').toContain('PATH');
      expect(Object.keys(v).filter((n) => /KEY|TOKEN|SECRET|CANARY|API/i.test(n))).toEqual([]);
    }
    // model requests: repo file → review packet; __history__ → next worker prompt
    const reviewer = modelOut.filter((m) => m.seat === 'reviewer').map((m) => m.body).join('\n');
    // (the packet is a diff: the planted header lines nearest the fix are in its context)
    expect(reviewer).toMatch(new RegExp(`(build |Bearer |Basic [A-Za-z0-9+/=]{0,8})${MARK.source}`));
    const workerPrompts = modelOut.filter((m) => m.seat === 'worker').map((m) => m.body);
    expect(workerPrompts.some((b) => /history note \[REDACTED:/.test(b)), 'history turn reached the next prompt').toBe(true);
    // child traffic: repo file (raw AND every planted encoding) → read tool result; verify output → runVerify result;
    // checkpoint → later exec
    const readResults = childIn.filter((c) => c.kind === 'result' && c.data.includes('src/slugify.js')).map((c) => c.data).join('\n');
    expect(readResults).toMatch(new RegExp(`build ${MARK.source}`));
    expect(readResults, 'base64 of a registered secret').toMatch(new RegExp(`b64 ${MARK.source}`));
    expect(readResults, 'hex of a registered secret').toMatch(new RegExp(`hex ${MARK.source}`));
    expect(readResults, 'percent-encoded registered secret').toMatch(new RegExp(`pct ${MARK.source}`));
    expect(readResults, 'Bearer header').toMatch(new RegExp(`Bearer ${MARK.source}`));
    expect(readResults, 'Basic header').toMatch(new RegExp(`Basic [A-Za-z0-9+/=]{0,8}${MARK.source}`));
    expect(readResults, 'the OpenRouter key in a Bearer header (D7)').toMatch(new RegExp(`router Authorization: Bearer ${MARK.source}`));
    const verifyResults = childIn.filter((c) => c.kind === 'result' && c.data.includes('probe ')).map((c) => c.data).join('\n');
    expect(verifyResults, 'verify output reached the child').toMatch(new RegExp(`probe ${MARK.source}`));
    const laterExecs = childIn.filter((c) => c.kind === 'exec').map((c) => c.data).join('\n');
    expect(laterExecs, 'checkpoint value handed back to a later exec').toMatch(/\\?"c\\?":\\?"\[REDACTED:[a-z_-]+:[0-9a-f]{8}\]/);
    // ledger: the redacted values are what was persisted (rows, the raw file bytes, the export)
    const verifyEvidence = evidence.filter((e) => e.kind === 'gate.verify').map((e) => e.body).join('\n');
    expect(verifyEvidence).toMatch(MARK);
    // (this run never suspends a worker mid-program, so no checkpoint rows are written here; the
    // [checkpoint rows] variant below forces a suspension and scans the persisted rows)
    expect(decisions.length, 'decision rows exist').toBeGreaterThan(0);
    expect(ledgerBytes.some((b) => MARK.test(b)), 'ledger file bytes hold markers').toBe(true);
    expect(exported.length, 'evidence export files').toBeGreaterThan(0);
    expect(exported.some((t) => MARK.test(t)), 'the export holds markers').toBe(true);
    // cli output: all segments, evidence export, why and status were captured for this run
    expect(out).toContain(flow.runId);
    expect(statusJson).toContain(flow.runId);
  }, 300_000);

  it('secret.canary_* [planner seat]: an inline canary in a goal file is refused before any model call; a registered secret (raw and base64) in the goal statement reaches the planner request and `tecera status --json` only as the marker, and the worker refuses that goal before its model or sandbox sees it', async () => {
    const plannerDoc = (): Record<string, unknown> => {
      const { id: _id, trigger: _t, origin: _o, status: _s, ...doc } = fixturePlan() as Record<string, unknown>;
      return doc;
    };
    const withGoal = (extra: string) => (d: string) => {
      const g = join(d, '.tecera/goals/fix-failing-test.goal.md');
      writeFileSync(g, `${readFileSync(g, 'utf8').trimEnd()}\n${extra}\n`);
    };
    // (a) a canary-shaped credential written into a goal file: refused at validation, nothing runs, no seat asked
    const C_GOAL = `TECERA_CANARY_goal_${rand()}`;
    const a = await sampleRepo({ mutate: withGoal(`Context: build ${C_GOAL}.`) });
    const askedA: string[] = [];
    const flowA = new Flow(a.dir, a.wt, { ...fixtureReplies(), planner: [{ text: JSON.stringify(plannerDoc()) }] }, {}, null);
    const segA = await flowA.segment({ tap: (seat) => void askedA.push(seat) });
    expect(segA.code, segA.err).toBe(3);
    expect(segA.err).toMatch(/canary/);
    expect(askedA).toEqual([]);
    expect(segA.out + segA.err).not.toContain(C_GOAL);

    // (b) a registered secret (env MY_SERVICE_KEY) and its base64 in the goal statement
    const PLAIN = `plain/goal+secret=${rand()}`;
    const { dir, wt } = await sampleRepo({ mutate: withGoal(`Context: token ${PLAIN} b64 ${b64(PLAIN)}.`) });
    const asked: Array<{ seat: string; body: string }> = [];
    const flow = new Flow(dir, wt, { ...fixtureReplies(), planner: [{ text: JSON.stringify(plannerDoc()) }] }, { MY_SERVICE_KEY: PLAIN }, null);
    const execs: string[] = [];
    const seg = await flow.segment({ tap: (seat, _u, body) => void asked.push({ seat, body }), childTap: (kind, data) => void (kind === 'exec' && execs.push(data)) });
    const planner = asked.filter((x) => x.seat === 'planner').map((x) => x.body);
    // coverage: the planner seat was really asked, and its plan was adopted
    expect(planner.length, `${seg.code} ${seg.err}\n${await dump(dir)}`).toBeGreaterThan(0);
    const evs = await flow.events();
    expect(evs.some((e) => e.kind === 'plan.generated')).toBe(true);
    const body = planner.join('\n');
    const needles = [PLAIN, b64(PLAIN), hex(PLAIN), encodeURIComponent(PLAIN), KEYS.ANTHROPIC_API_KEY, KEYS.OPENAI_API_KEY, KEYS.OPENROUTER_API_KEY];
    for (const n of needles) expect(body.includes(n), `planner request carries ${n.slice(0, 20)}…`).toBe(false);
    expect(body).toMatch(new RegExp(`token ${MARK.source}`));
    expect(body).toMatch(new RegExp(`b64 ${MARK.source}`));
    // the worker boundary fails closed: a goal carrying secret material is refused before the worker's model or
    // sandbox sees it (the step aborts on policy; nothing is written, committed or delivered)
    expect(seg.code, seg.err + seg.out + (await dump(dir))).toBe(8);
    const workerBodies = asked.filter((x) => x.seat === 'worker').map((x) => x.body).join('\n');
    for (const n of needles) expect(workerBodies.includes(n), `worker request carries ${n.slice(0, 20)}…`).toBe(false);
    for (const n of needles) expect(execs.join('\n').includes(n), `sandbox exec carries ${n.slice(0, 20)}…`).toBe(false);
    for (const k of ['commit.recorded', 'approval.requested', 'pr.requested', 'goal.achieved']) expect(evs.map((e) => e.kind), k).not.toContain(k);
    // `tecera status --json` prints the goal statement with the registered secret only as its marker
    const stj = await cli(dir, ['status', '--run', flow.runId, '--json'], { env: flow.env });
    expect(stj.code, stj.err).toBe(0);
    for (const n of needles) expect(stj.out.includes(n), `status --json carries ${n.slice(0, 20)}…`).toBe(false);
    expect(stj.out, 'status --json shows the goal statement with the secret redacted').toMatch(new RegExp(`token ${MARK.source}`));
  }, 300_000);

  it('secret.canary_* [checkpoint rows]: a worker suspended mid-program persists its checkpoint row with the canary redacted (rows exist, zero hits, marker present) while the worker is held mid-program', async () => {
    const C_CK = `ck_${rand()}`;
    const tail = rand();
    const PLAIN = `plain/ck+secret=${tail}`;
    const { dir, wt } = await sampleRepo({
      mutate: (d) => {
        // D6: writes never suspend any more; a NON-write action the human requires approval for still does.
        // Here runVerify: the worker suspends mid-program on it and checkpoints.
        const p = join(d, '.tecera/protocols/permissions.json');
        const perms = JSON.parse(readFileSync(p, 'utf8')) as { always: string[]; requiresApproval: string[]; never: string[] };
        perms.always = perms.always.filter((a) => a !== 'runVerify');
        perms.requiresApproval = [...new Set([...perms.requiresApproval, 'runVerify'])];
        writeFileSync(p, `${JSON.stringify(perms, null, 2)}\n`);
      },
    });
    const fx = fixtureReplies();
    // the first step records a canary (built in the child) and a registered secret in its checkpoints, then calls
    // runVerify; both values are BUILT in the child (split literals): the model output never carries them
    const noteTurn = { expect: 'Run verify and read the failing assertion', text: js(`const c = 'TECERA_CAN' + 'ARY_${C_CK}';\nconst token = 'plain/ck' + '+secret=' + '${tail}';\ncheckpoint('note', { c, token });\nconsole.log('noted');\nconst v = await runVerify();\nreturn { facts: [{ key: 'baselineVerifyExit', value: v.exitCode }] };`) };
    const replies = { ...fx, worker: [noteTurn, ...fx.worker] };
    const plan = fixturePlan() as { permissions: { approvals: string[] } };
    plan.permissions.approvals = [...plan.permissions.approvals, 'runVerify'];
    const flow = new Flow(dir, wt, replies, { MY_SERVICE_KEY: PLAIN }, plan);
    let held = await flow.drive();
    // the loop may hold the step up front (its tools need an approval): grant that, then the program runs
    for (let i = 0; i < 2 && held.code === 4; i++) {
      const p = await flow.pending();
      if (!p || (p.payload as { owner?: string }).owner === 'worker' || p.trace.stepId !== 'analyze') break;
      await flow.approvePending('analyze');
      held = await flow.segment();
    }
    expect(held.code, held.err + held.out + (await dump(dir))).toBe(4);
    const evs = await flow.events();
    // the attack ran: the worker suspended inside the step on the runVerify approval
    const suspended = evs.filter((e) => e.kind === 'step.held' && e.trace.stepId === 'analyze' && (e.payload as { owner?: string }).owner === 'worker' && /runVerify requires approval/.test(JSON.stringify(e.payload)));
    expect(suspended.length, `${held.code} ${held.err}\n${await dump(dir)}`).toBeGreaterThan(0);
    const db = new DatabaseSync(join(dir, '.tecera/ledger.sqlite'), { readOnly: true });
    const rows = (db.prepare('SELECT key, state FROM checkpoints').all() as Array<{ key: string; state: string }>);
    db.close();
    expect(rows.length, 'checkpoint rows were persisted').toBeGreaterThan(0);
    const C = `TECERA_CANARY_${C_CK}`;
    const needles = [C, PLAIN, b64(C), b64(PLAIN), hex(C), hex(PLAIN), encodeURIComponent(PLAIN), KEYS.ANTHROPIC_API_KEY, KEYS.OPENAI_API_KEY, KEYS.OPENROUTER_API_KEY];
    const hits = rows.flatMap((r) => needles.filter((n) => r.state.includes(n) || r.key.includes(n)).map((n) => `${r.key}: ${n.slice(0, 20)}…`));
    expect(hits).toEqual([]);
    // coverage: the suspended invoke's checkpoint row holds the note, both values redacted to markers
    const notes = rows.map((r) => (JSON.parse(r.state) as { checkpoints?: { note?: { c?: string; token?: string } } }).checkpoints?.note).filter((n) => n !== undefined);
    expect(notes.length, rows.map((r) => r.state.slice(0, 200)).join('\n')).toBeGreaterThan(0);
    for (const n of notes) {
      expect(n!.c).toMatch(new RegExp(`^${MARK.source}$`));
      expect(n!.token).toMatch(new RegExp(`^${MARK.source}$`));
    }
  }, 300_000);

  it('secret.canary_* [decoder exhaustion]: a worker reply carrying 512 distinct decodable tokens and then a registered secret as token 513 (base64 of its \\u-escaped form) is refused at the provider boundary: the program never reaches the sandbox, nothing is written, the ledger never stores it; control: 512 harmless tokens alone pass and the program runs', async () => {
    const harmless = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => b64(`harmless note ${tag}${i}`)).join(' ');
    const uEscape = (x: string): string => [...x].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    const SECRET = `plain/exhaust+secret=${rand()}`;
    const fx = fixtureReplies();
    // the fixture's edit program with a comment line in front of it
    const withComment = (comment: string) => ({ ...fx.worker[1]!, text: fx.worker[1]!.text.replace('```js\n', `\`\`\`js\n// ${comment}\n`) });
    const runWith = async (comment: string) => {
      const { dir, wt } = await sampleRepo();
      const execs: string[] = [];
      const requests: Array<{ seat: string; body: string }> = [];
      const flow = new Flow(dir, wt, { ...fx, worker: [fx.worker[0]!, withComment(comment)] }, { MY_SERVICE_KEY: SECRET });
      const wire = {
        childTap: (kind: 'exec' | 'result', data: string) => void (kind === 'exec' && execs.push(data)),
        tap: (seat: string, _u: string, body: string) => void requests.push({ seat, body }),
      };
      // one segment (D6: nothing holds before the PR): analyze, then the edit step whose reply is under test
      const seg = await flow.segment(wire);
      return { dir, wt, flow, seg, execs, after: requests.filter((r) => r.seat === 'worker' && r.body.includes('Fix the root cause')).map((r) => r.body) };
    };
    // control: the boundary is real — 512 distinct tokens are scanned completely; the program reaches the sandbox
    const tag = rand();
    const control = await runWith(harmless(512, tag));
    expect(control.execs.some((x) => x.includes(b64(`harmless note ${tag}511`))), `the control program (512 tokens) reached the sandbox\n${await dump(control.dir)}`).toBe(true);
    // attack: token 513 is the registered secret, base64 of its \u-escaped form (the Codex probe)
    const probe = b64(uEscape(SECRET));
    const atk = await runWith(`${harmless(512, rand())} ${probe}`);
    const evs = await atk.flow.events();
    expect(evs.some((e) => e.kind === 'step.started' && e.trace.stepId === 'edit'), 'the edit step started (the worker seat was asked)').toBe(true);
    expect(atk.execs.filter((x) => x.includes(probe) || x.includes('harmless note')), 'the unscannable program reached the sandbox').toEqual([]);
    expect(readFileSync(join(atk.wt, atk.flow.runId, 'src/slugify.js'), 'utf8'), 'nothing was written').toBe(readFileSync(join(atk.dir, 'src/slugify.js'), 'utf8'));
    expect(evs.filter((e) => e.kind === 'step.held'), 'nothing held: the reply never ran').toEqual([]);
    const all = [atk.seg.out, atk.seg.err, ...atk.execs, ...atk.after].join('\n');
    const ledgerBytes = readdirSync(join(atk.dir, '.tecera')).filter((n) => n.startsWith('ledger.sqlite')).map((f) => readFileSync(join(atk.dir, '.tecera', f)).toString('latin1')).join('\n');
    for (const n of [SECRET, probe, b64(SECRET), uEscape(SECRET), hex(SECRET), encodeURIComponent(SECRET)]) {
      expect(all.includes(n), `output carries ${n.slice(0, 16)}…`).toBe(false);
      expect(ledgerBytes.includes(n), `ledger holds ${n.slice(0, 16)}…`).toBe(false);
    }
    // coverage: the attack reply really was served (the seat was asked for it and the step did not complete on it)
    expect(atk.after.length, 'the worker seat was asked for the edit program in this segment').toBeGreaterThan(0);
    expect(atk.flow.segments.at(-1)!.asked.worker ?? 0).toBeGreaterThan(1);
    expect(evs.some((e) => e.kind === 'step.completed' && e.trace.stepId === 'edit'), 'the edit step never completed on the refused reply').toBe(false);
  }, 300_000);

  it('secret.canary_* [PR bundle] GAP (owner: gates prGate.ts): a registered secret that sits in the repository file next to the fix (here the OpenRouter provider key, D7) never appears raw in the PR delivery bundle under .tecera/runs/<run>/pr/ (patch, body, request)', async () => {
    const PLAIN = `plain/bundle+secret=${rand()}`;
    const { dir, wt } = await sampleRepo({
      mutate: (d) => {
        const p = join(d, 'src/slugify.js');
        // the lines right above the fixed line: inside the patch's diff context
        writeFileSync(p, `// router Authorization: Bearer ${KEYS.OPENROUTER_API_KEY}\n// token ${PLAIN}\n${readFileSync(p, 'utf8')}`);
      },
    });
    const asked: Array<{ seat: string; body: string }> = [];
    const flow = new Flow(dir, wt, fixtureReplies(), { MY_SERVICE_KEY: PLAIN });
    const wire = { tap: (seat: string, _u: string, body: string) => void asked.push({ seat, body }) };
    const held = await flow.drive({ wire });
    expect(held.code, held.err + held.out + (await dump(dir))).toBe(4);
    const done = await flow.finish(wire);
    expect(done.code, done.err + done.out + (await dump(dir))).toBe(0);
    const evs = await flow.events();
    expect(evs.some((e) => e.kind === 'pr.requested'), 'the PR was delivered as a bundle (no remote)').toBe(true);
    const sha = (evs.find((e) => e.kind === 'commit.recorded')!.payload as { sha: string }).sha;
    // the attack setup is real: the committed file carries the values (they were in the repository already)
    expect(git(dir, 'show', `${sha}:src/slugify.js`)).toContain(KEYS.OPENROUTER_API_KEY);
    const needles = [KEYS.OPENROUTER_API_KEY, PLAIN, b64(KEYS.OPENROUTER_API_KEY), b64(PLAIN), encodeURIComponent(PLAIN)];
    // every other boundary of this run holds: model requests (the review packet shows the context as the marker) and the ledger
    const reviewer = asked.filter((x) => x.seat === 'reviewer').map((x) => x.body).join('\n');
    expect(reviewer.length).toBeGreaterThan(0);
    for (const n of needles) expect(asked.some((x) => x.body.includes(n)), `model request carries ${n.slice(0, 16)}…`).toBe(false);
    const ledgerBytes = readdirSync(join(dir, '.tecera')).filter((n) => n.startsWith('ledger.sqlite')).map((f) => readFileSync(join(dir, '.tecera', f)).toString('latin1')).join('\n');
    for (const n of needles) expect(ledgerBytes.includes(n), `ledger holds ${n.slice(0, 16)}…`).toBe(false);
    // the bundle exists and holds the fix (coverage: the scanned files are the delivery)
    const prDir = join(dir, '.tecera/runs', flow.runId, 'pr');
    const files = readdirSync(prDir);
    expect(files.length).toBeGreaterThan(0);
    const bundle = files.map((f) => ({ f, t: readFileSync(join(prDir, f)).toString('latin1') }));
    expect(bundle.some((b) => b.t.includes("'-'")), 'the bundle carries the fix').toBe(true);
    await expectGap('secret.canary_* [PR bundle]', 'gates prGate.ts (redact the bundle or refuse delivery of a patch that carries a registered secret)', { assertion: 'no registered secret raw in the PR bundle' }, () => {
      const exposed = bundle.flatMap((b) => needles.filter((n) => b.t.includes(n)).map((n) => `${b.f}: ${n.slice(0, 16)}…`));
      expect(exposed, 'no registered secret raw in the PR bundle').toEqual([]);
    });
  }, 300_000);

  it('secret.canary_* [gate evidence keys] GAP (owner: gates evidence.ts keys): a registered secret that ends up in a run/intention identifier never appears raw in a gate result, an evidence body or an evidence KEY', async () => {
    const SECRET = `idsecret_${rand()}${rand()}`;
    const rig = gateRig({ extra: { secrets: [SECRET] }, change: (r) => r.write('src/a.ts', 'export const a = 2;\n') });
    // the identifier the loop would pass carries the secret (e.g. an intention id derived from untrusted text)
    const intentionId = `i-${SECRET}`;
    await rig.ready;
    const v = await rig.gates.verify(rig.ctx('v', { intentionId }));
    const r = await rig.gates.review(rig.ctx('r', { intentionId, candidate: { d1: v.fingerprint } }));
    // the attack reached the gates: each returned a result with an evidence record
    expect(v.evidenceKey).toBeTruthy();
    expect(r.evidenceKey).toBeTruthy();
    const ledger = rig.ledger as unknown as { listEvidence(runId: string): Promise<Array<{ key: string; body: unknown }>> };
    const recs = await ledger.listEvidence('run1');
    expect(recs.length).toBeGreaterThan(0);
    // bodies: the identifier is referenced and redacted to the marker
    const bodies = recs.map((x) => JSON.stringify(x.body)).join('\n');
    expect(bodies.includes(SECRET), 'raw secret in an evidence body').toBe(false);
    expect(bodies, 'the identifier is referenced in evidence bodies only as the marker').toMatch(MARK);
    await expectGap('secret.canary_* [gate evidence keys]', 'gates evidence.ts / verifyGate.ts / commitGate.ts (digest-based key components or refuse secret-bearing identifiers)', { assertion: 'no raw secret in a returned result or an evidence key' }, () => {
      const exposed = [JSON.stringify(v), JSON.stringify(r), ...recs.map((x) => x.key)].filter((t) => t.includes(SECRET));
      expect(exposed.length, 'no raw secret in a returned result or an evidence key').toBe(0);
    });
  }, 120_000);
});
