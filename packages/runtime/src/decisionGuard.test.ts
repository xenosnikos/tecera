import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { event, type TeceraEvent } from '@tecera/contracts';
import { SqliteLedger } from '@tecera/ledger';
import { SANDBOX_MARKER_ENV } from '@tecera/worker';
import { main } from './cli/main.js';
import { AGENT_HOST_MARKERS, DECISION_NONINTERACTIVE_ENV, agentMarkersIn, decisionGuard, decisionTerminal } from './decisionGuard.js';

/**
 * The accident guard of the human decision commands. It is not authentication, and the tests say what it
 * does and no more: under an agent-host marker, or without a terminal on stdin, every decision command
 * refuses with exit 8 before it reads anything; TECERA_DECISION_NONINTERACTIVE=1 waives both; the conditions
 * are recorded on the approval's audit event.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(HERE, '../../../samples/fix-failing-test');

const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

type Env = Record<string, string | undefined>;
const BASE: Env = { PATH: process.env.PATH, HOME: process.env.HOME, USER: 'tester' };

async function cli(cwd: string, argv: string[], env: Env): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await main(argv, { cwd, env, stdout: (s) => (out += s), stderr: (s) => (err += s), isTTY: false });
  return { code, out, err };
}

/** Stand a terminal in (or take it away) for the guard's stdin probe. */
const terminal = (isTty: boolean) => vi.spyOn(decisionTerminal, 'stdinIsTTY').mockReturnValue(isTty);

/** Every decision command, with arguments that pass its usage check. */
const DECISIONS: Array<[label: string, argv: string[]]> = [
  ['approve', ['approve', 'ap_1', '--as', 'ana']],
  ['deny', ['deny', 'ap_1', '--as', 'ana', '--reason', 'no']],
  ['criteria accept', ['criteria', 'accept', 'run_1', '--as', 'ana']],
  ['criteria amend', ['criteria', 'amend', 'run_1', '--file', 'contract.json', '--reason', 'tighter', '--as', 'ana']],
  ['plans graduate', ['plans', 'graduate', 'p_1', '--rationale', 'worked', '--as', 'ana']],
  ['plans reject', ['plans', 'reject', 'p_1', '--rationale', 'no', '--as', 'ana']],
  ['plans retract', ['plans', 'retract', 'p_1', '--rationale', 'no', '--as', 'ana']],
  ['memory graduate', ['memory', 'graduate', 'm_1', '--rationale', 'held up', '--as', 'ana']],
  ['memory reject', ['memory', 'reject', 'm_1', '--rationale', 'no', '--as', 'ana']],
  ['memory retract', ['memory', 'retract', 'm_1', '--rationale', 'no', '--as', 'ana']],
  ['resources release', ['resources', 'release', 'res_1', '--as', 'ana']],
  ['resources transfer', ['resources', 'transfer', 'res_1', '--as', 'ana']],
];

/** One variable per marker rule: the exact names, and one name under each prefix. */
const MARKERS: string[] = [...AGENT_HOST_MARKERS.names, ...AGENT_HOST_MARKERS.prefixes.map((p) => `${p}SANDBOX`)];

const REFUSAL = /refused\. This is a human decision.*This check prevents accidents; it is not authentication\./;

describe('decisionGuard (pure)', () => {
  it('lists the markers in one place: Claude Code, Codex (by prefix) and the sandbox\'s own', () => {
    expect(AGENT_HOST_MARKERS.names).toEqual(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'TECERA_SANDBOX']);
    expect(AGENT_HOST_MARKERS.prefixes).toEqual(['CODEX_']);
    expect(SANDBOX_MARKER_ENV).toBe('TECERA_SANDBOX');
    expect(agentMarkersIn({ CODEX_HOME: '/x', CLAUDECODE: '', CODEX: 'not-a-marker', XCODEX_Y: '1', claudecode: '1', PATH: '/bin', GONE: undefined })).toEqual(['CLAUDECODE', 'CODEX_HOME']);
  });

  it('a terminal and no marker passes; a marker or no terminal refuses; only the exact opt-out waives it', () => {
    expect(decisionGuard({}, true)).toEqual({ stdinTty: true, agentMarkers: [], nonInteractiveOptOut: false, refused: false });
    expect(decisionGuard({}, false)).toMatchObject({ stdinTty: false, refused: true });
    for (const m of MARKERS) expect(decisionGuard({ [m]: '1' }, true), m).toEqual({ stdinTty: true, agentMarkers: [m], nonInteractiveOptOut: false, refused: true });
    expect(decisionGuard({ CLAUDECODE: '1', [DECISION_NONINTERACTIVE_ENV]: '1' }, false)).toEqual({ stdinTty: false, agentMarkers: ['CLAUDECODE'], nonInteractiveOptOut: true, refused: false });
    for (const v of ['', '0', 'true', 'yes', ' 1']) expect(decisionGuard({ [DECISION_NONINTERACTIVE_ENV]: v }, false).refused, JSON.stringify(v)).toBe(true);
  });
});

describe('every human decision command runs the guard before it reads anything', () => {
  // The cwd holds no business case: a command that got past the guard fails on the missing manifest instead.
  for (const [label, argv] of DECISIONS) {
    it(`${label}: refuses (exit 8) without a terminal on stdin`, async () => {
      terminal(false);
      const r = await cli(tmp('tecera-guard-'), argv, BASE);
      expect(r.code, r.err).toBe(8);
      expect(r.err).toMatch(REFUSAL);
      expect(r.err).toContain('stdin is not a terminal');
      expect(r.err).toContain(`${DECISION_NONINTERACTIVE_ENV}=1`);
      expect(r.err).not.toMatch(/agent-host marker/);
    });

    it(`${label}: refuses (exit 8) under each agent-host marker, even at a terminal, naming the marker and never its value`, async () => {
      terminal(true);
      for (const m of MARKERS) {
        const r = await cli(tmp('tecera-guard-'), argv, { ...BASE, [m]: 'marker-value-xyz' });
        expect(r.code, `${m}: ${r.err}`).toBe(8);
        expect(r.err, m).toMatch(REFUSAL);
        expect(r.err, m).toContain(`agent-host marker in the environment: ${m}`);
        expect(r.err, m).not.toContain('marker-value-xyz');
        expect(r.err, m).not.toContain('stdin is not a terminal');
      }
    });

    it(`${label}: passes the guard at a terminal with no marker, and with the opt-out under a marker and no terminal`, async () => {
      terminal(true);
      const atTerminal = await cli(tmp('tecera-guard-'), argv, BASE);
      expect(atTerminal.code).not.toBe(8);
      expect(atTerminal.err).not.toMatch(/This is a human decision/);
      terminal(false);
      const optedOut = await cli(tmp('tecera-guard-'), argv, { ...BASE, CLAUDECODE: '1', CODEX_SANDBOX: 'seatbelt', [DECISION_NONINTERACTIVE_ENV]: '1' });
      expect(optedOut.code).not.toBe(8);
      expect(optedOut.err).not.toMatch(/This is a human decision/);
      // both got as far as loading the business case, which this directory does not have
      expect(atTerminal.err + optedOut.err).toMatch(/tecera\.json|manifest|business case/i);
    });
  }

  it('a usage error is still a usage error (exit 2) without a terminal: the guard runs on a well-formed decision only', async () => {
    terminal(false);
    for (const argv of [
      ['approve'],
      ['deny', 'ap_1'],
      ['criteria', 'accept'],
      ['criteria', 'amend', 'run_1'],
      ['plans', 'graduate', 'p_1'],
      ['memory', 'reject', 'm_1'],
      ['resources', 'release'],
      ['resources', 'transfer'],
    ]) {
      const r = await cli(tmp('tecera-guard-'), argv, { ...BASE, CLAUDECODE: '1' });
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.err, argv.join(' ')).not.toMatch(/This is a human decision/);
    }
  });

  it('the read-only forms are not guarded: plans/memory candidates, criteria show, resources list', async () => {
    terminal(false);
    for (const argv of [['plans', 'candidates'], ['memory', 'candidates'], ['criteria', 'show', 'run_1'], ['resources', 'list']]) {
      const r = await cli(tmp('tecera-guard-'), argv, { ...BASE, CLAUDECODE: '1' });
      expect(r.code, argv.join(' ')).not.toBe(8);
      expect(r.err, argv.join(' ')).not.toMatch(/This is a human decision/);
    }
  });
});

describe('the approval audit event records which guard conditions held', () => {
  function project(): string {
    const dir = tmp('tecera-guard-case-');
    cpSync(SAMPLE, dir, { recursive: true, filter: (src) => !/node_modules|ledger\.sqlite|[\\/]runs([\\/]|$)/.test(src) });
    return dir;
  }

  async function pending(dir: string, requestId: string): Promise<void> {
    const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
    const trace = { goalId: 'g1', intentionId: 'i1', stepId: 's1' };
    await l.requestApproval({ requestId, runId: 'run_1', sessionId: 'sess', actionHash: 'hash', requester: { kind: 'agent', id: 'loop' }, reason: 'open the PR', expiresAt: Date.now() + 3_600_000 });
    await l.append(event('approval.requested', { id: `ev_req_${requestId}`, at: Date.now(), actor: { kind: 'system', id: 'loop' }, runId: 'run_1', trace, payload: { requestId, actionHash: 'hash', sessionId: 'sess' } }));
    l.close();
  }

  async function decisionEvents(dir: string, kind: string): Promise<TeceraEvent[]> {
    const l = new SqliteLedger(join(dir, '.tecera/ledger.sqlite'));
    const out: TeceraEvent[] = [];
    for await (const e of l.events()) if (e.kind === kind) out.push(e);
    const state = await l.verifyChain();
    l.close();
    expect(state.ok).toBe(true);
    return out;
  }

  it('approve under a marker and without a terminal, opted out: granted, and the event says exactly that', async () => {
    const dir = project();
    await pending(dir, 'ap_1');
    terminal(false);
    const refused = await cli(dir, ['approve', 'ap_1', '--as', 'ana'], { ...BASE, CLAUDECODE: '1' });
    expect(refused.code).toBe(8);
    expect(await decisionEvents(dir, 'approval.granted')).toEqual([]); // nothing was granted or recorded
    const ok = await cli(dir, ['approve', 'ap_1', '--as', 'ana', '--json'], { ...BASE, CLAUDECODE: '1', CODEX_SANDBOX: 'seatbelt', [DECISION_NONINTERACTIVE_ENV]: '1' });
    expect(ok.code, ok.err).toBe(0);
    const [ev] = await decisionEvents(dir, 'approval.granted');
    expect(ev!.actor).toEqual({ kind: 'human', id: 'ana' });
    expect((ev!.payload as { guard?: unknown }).guard).toEqual({ stdinTty: false, agentMarkers: ['CLAUDECODE', 'CODEX_SANDBOX'], nonInteractiveOptOut: true });
    expect(JSON.parse(ok.out).guard).toEqual({ stdinTty: false, agentMarkers: ['CLAUDECODE', 'CODEX_SANDBOX'], nonInteractiveOptOut: true });
    expect(JSON.stringify(ev)).not.toContain('seatbelt'); // names only
  });

  it('approve and deny at a terminal with no marker: the event records a terminal, no markers, no opt-out', async () => {
    const dir = project();
    await pending(dir, 'ap_2');
    await pending(dir, 'ap_3');
    terminal(true);
    expect((await cli(dir, ['approve', 'ap_2', '--as', 'ana'], BASE)).code).toBe(0);
    expect((await cli(dir, ['deny', 'ap_3', '--as', 'ana', '--reason', 'not this one'], BASE)).code).toBe(0);
    const clean = { stdinTty: true, agentMarkers: [], nonInteractiveOptOut: false };
    expect(((await decisionEvents(dir, 'approval.granted'))[0]!.payload as { guard?: unknown }).guard).toEqual(clean);
    expect(((await decisionEvents(dir, 'approval.denied'))[0]!.payload as { guard?: unknown }).guard).toEqual(clean);
  });
});
