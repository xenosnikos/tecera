import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, openSync, renameSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { type Json, type LedgerHead, type TeceraEvent } from '@tecera/contracts';
import { HeadStore, SqliteLedger } from '@tecera/ledger';
import { activeRunsOf } from '@tecera/policy';
import type { Command, CommandContext } from '../cli/context.js';
import { guardDecision } from '../decisionGuard.js';
import { CliError, EXIT } from '../errors.js';
import { localPrincipal, PrincipalError } from '../principal.js';
import type { Runtime } from '../runtime.js';
import { accountName, accountUid, processCredentials } from './authority.js';
import { HARDENED_CONFIG_PATH, loadHardenedConfig } from './config.js';
import { allCases, ensureCaseDir, type HardenedContext } from './context.js';

/**
 * `tecera hardened init|enroll|status|abandon`.
 *
 * - init [--operator <name|uid>] [--agent <name|uid>] [--state <dir>]: prints the commands an administrator
 *   runs to set hardened mode up (agent account, state directory, configuration, host hooks). It changes
 *   nothing on the host itself.
 * - enroll [--import <ledger>]: once per business case, as the operator. Creates an empty ledger in the
 *   protected state (genesis), or enrolls the one already there, or copies a single-user ledger in
 *   (--import), as a legacy baseline: its chain must verify, its current head is pinned, and its earlier
 *   history is recorded as not authenticated. Runs that ledger shows open are entered in the run registry.
 * - status: the configuration, this process's identity, the head checkpoint and the run registry.
 * - abandon <runId> --reason <text>: the operator closes a run explicitly (records run.ended, exit 9, then
 *   the terminal registry transition). It is the only way, other than the run's own end, to make a run
 *   terminal.
 *
 * enroll and abandon are decisions: operator identity only (decisionGuard), whatever the terminal or `--as`.
 */

const ENROLLING = 'ledger.sqlite.enrolling';

function need(rt: Runtime, what: string): HardenedContext {
  if (!rt.hardened) throw new CliError(`hardened ${what}: not in hardened mode (no ${HARDENED_CONFIG_PATH} and no TECERA_HARDENED_CONFIG); see \`tecera hardened init\``, EXIT.usage);
  if (!rt.hardened.writer) throw new CliError(`hardened ${what}: only the operator identity (uid ${rt.hardened.config.operator.uid}) writes the protected state; this process is uid ${processCredentials.uid()}`, EXIT.policy);
  return rt.hardened;
}

function resolveIdentity(v: string | undefined, fallback: { uid: number | null; name: string }): { uid: number | null; name: string } {
  if (!v) return fallback;
  if (/^\d+$/.test(v)) return { uid: Number(v), name: accountName(Number(v)) ?? v };
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/.test(v)) throw new CliError(`hardened init: ${v} is not an account name or uid`, EXIT.usage);
  return { uid: accountUid(v), name: v };
}

const initCommand: Command = async (c) => {
  const me = processCredentials.uid();
  const operator = resolveIdentity(c.args.values.operator, { uid: me, name: accountName(me) ?? String(me) });
  const agent = resolveIdentity(c.args.values.agent, { uid: null, name: 'tecera-agent' });
  const state = c.args.values.state ?? '/var/lib/tecera';
  if (!isAbsolute(state)) throw new CliError('hardened init: --state must be an absolute directory', EXIT.usage);
  if (operator.uid === 0) c.out.info('note: the operator is root; prefer the account of the person who approves (root defeats hardened mode in any case)');
  const uidOf = (i: { uid: number | null; name: string }): string => (i.uid === null ? `$(id -u ${i.name})` : String(i.uid));
  const lines = [
    '# Hardened mode setup. Review, then run as root. Tecera has not run any of this.',
    '',
    `# 1. The agent identity: the host assistant (Claude Code, Codex) runs as ${agent.name}, never as ${operator.name}.`,
    ...(agent.uid === null ? [`useradd --create-home --shell /bin/bash ${agent.name}`] : [`# ${agent.name} exists (uid ${agent.uid})`]),
    `# It must not be in sudoers, in ${operator.name}'s groups, or able to read ${operator.name}'s provider keys.`,
    '',
    `# 2. The protected state: owned by ${operator.name}, readable by the agent (the Stop hook reads it), writable by nobody else.`,
    `install -d -o ${operator.name} -g ${operator.name} -m 0755 ${state}`,
    '',
    '# 3. The configuration, at the fixed path (root-owned; the agent cannot remove it).',
    'install -d -o root -g root -m 0755 /etc/tecera',
    `cat > ${HARDENED_CONFIG_PATH} <<EOF`,
    `{"version": 1, "stateDir": "${state}", "operator": {"uid": ${uidOf(operator)}, "name": "${operator.name}"}, "agents": [{"uid": ${uidOf(agent)}, "name": "${agent.name}"}]}`,
    'EOF',
    `chown root:root ${HARDENED_CONFIG_PATH} && chmod 0644 ${HARDENED_CONFIG_PATH}`,
    '',
    '# 4. The repository: both identities work in it. One shared group, for example:',
    `groupadd -f tecera-work && usermod -aG tecera-work ${operator.name} && usermod -aG tecera-work ${agent.name}`,
    '# chgrp -R tecera-work <repo> && chmod -R g+rwX <repo> && find <repo> -type d -exec chmod g+s {} +',
    `# Keep Tecera's installation and the node binary owned by root or ${operator.name} and not writable by that group.`,
    '',
    '# 5. Claude Code: install the hooks in managed settings, which the agent cannot edit:',
    '#    /etc/claude-code/managed-settings.json with hooks.Stop and hooks.PreToolUse running `tecera hook stop` / `tecera hook pre-tool`',
    '#    (the same entries `tecera adapters install claude-code` writes into the repository).',
    '#    Codex: no hooks; the decision commands still refuse the agent identity, nothing enforces stopping.',
    '',
    `# 6. Start the assistant as the agent, for example: sudo -u ${agent.name} -H claude`,
    '',
    `# 7. As ${operator.name}, in each business case: tecera hardened enroll   (or: --import .tecera/ledger.sqlite)`,
    '#    then: tecera doctor',
  ];
  for (const l of lines) c.out.say(l);
  c.out.set('operator', { uid: operator.uid, name: operator.name });
  c.out.set('agent', { uid: agent.uid, name: agent.name });
  c.out.set('stateDir', state);
  c.out.set('commands', lines.filter((l) => l && !l.startsWith('#')));
  return EXIT.ok;
};

/** Runs the ledger shows open at enrollment, with the registry state each enters as. */
async function openRunsOf(ledger: SqliteLedger, now: number): Promise<Array<{ runId: string; goalId: string | null; state: 'running' | 'held' | 'interrupted' | 'provisional' }>> {
  const events: TeceraEvent[] = [];
  for await (const e of ledger.events()) events.push(e);
  const out = new Map<string, { runId: string; goalId: string | null; state: 'running' | 'held' | 'interrupted' | 'provisional' }>();
  for (const r of activeRunsOf(events)) out.set(r.runId, { runId: r.runId, goalId: r.goalId ?? null, state: r.state === 'provisional' ? 'provisional' : r.state });
  const last = new Map<string, number>();
  const goals = new Map<string, string>();
  const requests = new Map<string, string[]>();
  for (const e of events) {
    if (!e.runId) continue;
    if (e.kind === 'run.ended') last.set(e.runId, Number((e.payload as { exitCode?: unknown }).exitCode));
    if (e.kind === 'goal.adopted' && e.trace.goalId && !goals.has(e.runId)) goals.set(e.runId, e.trace.goalId);
    if (e.kind === 'approval.requested') requests.set(e.runId, [...(requests.get(e.runId) ?? []), String((e.payload as { requestId?: unknown }).requestId)]);
  }
  for (const [runId, exit] of last) {
    if (out.has(runId)) continue;
    if (exit === 10) out.set(runId, { runId, goalId: goals.get(runId) ?? null, state: 'provisional' });
    else
      for (const rid of requests.get(runId) ?? []) {
        const row = await ledger.getApproval(rid);
        if (row && row.runId === runId && (row.state === 'pending' || row.state === 'granted') && row.expiresAt > now) out.set(runId, { runId, goalId: goals.get(runId) ?? null, state: 'held' });
      }
  }
  return [...out.values()];
}

const enrollCommand: Command = async (c) => {
  const guard = guardDecision(c, 'hardened enroll');
  if (typeof guard === 'number') return guard;
  const rt = c.runtime();
  const h = need(rt, 'enroll');
  ensureCaseDir(h, rt.root);
  const enrolling = join(h.caseDir, ENROLLING);
  const ledgerId = `l_${randomUUID().replace(/-/g, '')}`;
  let head: LedgerHead;
  let imported = 0;
  if (h.head.exists()) {
    // Only the one crash enrollment itself can leave: a genesis checkpoint and its database not yet in place.
    const cur = h.head.read();
    if (!existsSync(h.ledgerPath) && existsSync(enrolling) && cur?.baseline === 'genesis' && cur.generation === 0 && cur.eventCount === 0) {
      const probe = new SqliteLedger(enrolling, { readonly: true, head: new HeadStore(h.caseDir) });
      const ok = (await probe.verifyChain()).ok;
      probe.close();
      if (ok) {
        renameSync(enrolling, h.ledgerPath);
        c.out.say(`enrolled   ledger ${cur.ledgerId} (genesis; completed an interrupted enrollment)`);
        return EXIT.ok;
      }
    }
    c.out.error(`hardened enroll: this business case is enrolled already (checkpoint ${h.head.headPath}); a ledger is enrolled once`);
    return EXIT.error;
  }
  if (existsSync(h.ledgerPath)) {
    if (c.args.values.import) throw new CliError('hardened enroll: a ledger is already in the protected state; --import would replace it', EXIT.usage);
    const l = new SqliteLedger(h.ledgerPath, { head: h.head, journalMode: 'delete' });
    try {
      head = await l.enroll('legacy', ledgerId);
      for (const r of await openRunsOf(l, rt.now())) if (h.registry.enrolled(r.runId, r.goalId, r.state)) imported++;
    } finally {
      l.close();
    }
  } else if (c.args.values.import) {
    const src = isAbsolute(c.args.values.import) ? c.args.values.import : resolve(c.opts.cwd, c.args.values.import);
    const st = lstatSync(src);
    if (!st.isFile() || st.nlink !== 1) throw new CliError(`hardened enroll: ${src} is not a regular file with one link`, EXIT.usage);
    // Fold the write-ahead log into the file, then copy it in and switch it to the rollback journal.
    const s = new SqliteLedger(src);
    const chain = await s.verifyChain();
    s.rawExec('PRAGMA wal_checkpoint(TRUNCATE)');
    s.close();
    if (!chain.ok) throw new CliError(`hardened enroll: ${src} does not verify (seq ${chain.brokenAtSeq}${chain.reason ? `: ${chain.reason}` : ''})`, EXIT.ledger);
    rmSync(enrolling, { force: true });
    copyFileSync(src, enrolling);
    chmodSync(enrolling, h.fileMode);
    const l = new SqliteLedger(enrolling, { head: h.head, journalMode: 'delete' });
    try {
      head = await l.enroll('legacy', ledgerId);
      for (const r of await openRunsOf(l, rt.now())) if (h.registry.enrolled(r.runId, r.goalId, r.state)) imported++;
    } finally {
      l.close();
    }
    renameSync(enrolling, h.ledgerPath);
  } else {
    rmSync(enrolling, { force: true });
    closeSync(openSync(enrolling, 'wx', h.fileMode));
    const l = new SqliteLedger(enrolling, { head: h.head, journalMode: 'delete' });
    try {
      head = await l.enroll('genesis', ledgerId);
    } finally {
      l.close();
    }
    renameSync(enrolling, h.ledgerPath);
  }
  c.out.say(`enrolled   ledger ${head.ledgerId} (${head.baseline}${head.baseline === 'legacy' ? ': its history before now is accepted as it is, not authenticated' : ''}) · ${head.eventCount} events · ${head.evidenceCount} evidence rows`);
  if (imported) c.out.say(`registry   ${imported} open run(s) entered from the ledger`);
  c.out.say(`state      ${h.caseDir}`);
  c.out.set('head', head as unknown as Json);
  c.out.set('imported', imported);
  c.out.set('guard', { os: (guard.os ?? null) as unknown as Json });
  return EXIT.ok;
};

const statusCommand: Command = async (c) => {
  const cfg = loadHardenedConfig(c.opts.env);
  if (!cfg) {
    c.out.say(`mode       single-user (no ${HARDENED_CONFIG_PATH}, no TECERA_HARDENED_CONFIG)`);
    c.out.set('mode', 'single-user');
    return EXIT.ok;
  }
  const rt = c.runtime();
  const h = rt.hardened!;
  c.out.say(`mode       hardened · configuration ${cfg.source}`);
  c.out.say(`identity   this process uid ${processCredentials.uid()} · ${h.writer ? 'operator' : 'reads only'} · operator uid ${cfg.operator.uid} · agents ${cfg.agents.map((a) => a.uid).join(', ')}`);
  c.out.say(`state      ${h.caseDir}`);
  const head = h.head.read();
  c.out.say(head ? `head       ledger ${head.ledgerId} · generation ${head.generation} · ${head.eventCount} events · ${head.evidenceCount} evidence rows · ${head.baseline} baseline` : 'head       not enrolled (`tecera hardened enroll`)');
  const entries = h.registry.list();
  for (const e of entries) c.out.say(`run        ${e.runId}  ${e.state}${e.terminalReason ? ` (${e.terminalReason})` : ''} · generation ${e.generation}${e.goalId ? ` · goal ${e.goalId}` : ''}`);
  const others = allCases(cfg, c.opts.now).filter((x) => x.caseId !== h.caseId).flatMap((x) => x.registry.open().map((e) => ({ caseId: x.caseId, root: x.root, runId: e.runId, state: e.state })));
  for (const o of others) c.out.say(`elsewhere  ${o.runId} ${o.state} · ${o.root ?? o.caseId}`);
  c.out.set('mode', 'hardened');
  c.out.set('caseId', h.caseId);
  c.out.set('head', (head ?? null) as unknown as Json);
  c.out.set('runs', entries as unknown as Json);
  c.out.set('elsewhere', others as unknown as Json);
  return EXIT.ok;
};

const abandonCommand: Command = async (c) => {
  const runId = c.args.positionals[1];
  const reason = c.args.values.reason?.trim();
  if (!runId || !reason || c.args.positionals.length > 2) throw new CliError('usage: tecera hardened abandon <runId> --reason <text> [--as you]', EXIT.usage);
  const guard = guardDecision(c, 'hardened abandon');
  if (typeof guard === 'number') return guard;
  const rt = c.runtime();
  const h = need(rt, 'abandon');
  const entry = h.registry.get(runId);
  if (!entry) {
    c.out.error(`hardened abandon: run ${runId} is not in the run registry`);
    return EXIT.error;
  }
  let who;
  try {
    who = localPrincipal(rt, { as: c.args.values.as });
  } catch (e) {
    if (e instanceof PrincipalError) {
      c.out.error(`hardened abandon: ${e.message}`);
      return e.exitCode;
    }
    throw e;
  }
  // The event first: if the registry write then fails the run stays open, which is the safe side.
  await rt.append('run.ended', { runId, actor: { kind: 'human', id: who.id }, payload: { exitCode: EXIT.ledger, reason: `abandoned by the operator: ${reason}`, goalId: entry.goalId ?? '', abandoned: true, os: (who.os ?? null) as unknown as Json } });
  const e = h.registry.abandon(runId, reason);
  c.out.say(`abandoned  run ${runId} as ${who.id} (uid ${who.os?.uid ?? '?'}): ${e.terminalReason}`);
  c.out.set('entry', e as unknown as Json);
  return EXIT.ok;
};

export const hardenedCommand: Command = async (c: CommandContext) => {
  const sub = c.args.positionals[0];
  const subs: Record<string, Command> = { init: initCommand, enroll: enrollCommand, status: statusCommand, abandon: abandonCommand };
  const cmd = sub && Object.prototype.hasOwnProperty.call(subs, sub) ? subs[sub] : undefined;
  if (!cmd) throw new CliError('usage: tecera hardened init|enroll|status|abandon', EXIT.usage);
  return cmd(c);
};
