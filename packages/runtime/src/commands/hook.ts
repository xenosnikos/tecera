import { dirname } from 'node:path';
import type { Command, CommandContext } from '../cli/context.js';
import type { Json } from '@tecera/contracts';
import { CliError, EXIT } from '../errors.js';
import { listGoalIds, loadGoal } from '../goals.js';
import { decidePreTool, parseHookInput, stopReminder, type HookInput } from '../hook.js';
import { loadManifest, loadPermissions, locateManifest, ManifestLoadError } from '../manifest/load.js';
import { Runtime } from '../runtime.js';
import { provenOptionsOf } from '../proof.js';
import { evaluateStop, hardenedStopRuns } from '../stopHook.js';
import { loadHardenedConfig, type HardenedConfig } from '../hardened/config.js';
import { openRunsElsewhere } from '../hardened/context.js';
import { hostGitExecHazards } from '../util/proc.js';

/**
 * `tecera hook pre-tool|stop`, called by the host with the hook JSON on stdin. pre-tool: exit 0 allows,
 * exit 2 blocks with the reason on stderr (Claude Code feeds it back to the model); any error blocks.
 * stop (D4): exit 2 with `goal not achieved: <what is missing>` while a run of this business case is active
 * and not proven achieved (stopHook.ts; a provisional goal always blocks), exit 0 otherwise; budget is never
 * considered. Each decision is recorded as stop.blocked / stop.allowed. A business case whose ledger cannot be
 * read, or whose hash chain does not verify, blocks.
 *
 * Hardened mode: the open runs come from the run registry (stopHook.ts hardenedStopRuns), the chain is
 * compared with the head checkpoint, a registered run whose ledger is missing blocks, and an open run of any
 * other business case on the host blocks too. The hook usually runs as the agent identity, which cannot
 * write the ledger: its decisions are then not recorded (they are printed).
 */
export const hookCommand: Command = async (c) => {
  const which = c.args.positionals[0];
  if ((which !== 'pre-tool' && which !== 'stop') || c.args.positionals.length > 1) throw new CliError('usage: tecera hook pre-tool|stop', EXIT.usage);
  let text = '';
  try {
    text = await c.io.readStdin();
  } catch {
    text = '';
  }
  if (which === 'stop') return stopHook(c, text);
  try {
    const input = parseHookInput(text);
    const from = typeof input.cwd === 'string' && input.cwd ? input.cwd : c.opts.cwd;
    const loaded = loadManifest(from, c.args.values.manifest);
    const permissions = loadPermissions(dirname(loaded.path)).doc;
    const checkCommands: string[] = [];
    for (const id of listGoalIds(loaded.root)) {
      try {
        checkCommands.push(loadGoal(loaded.root, id, loaded.manifest).check.command);
      } catch {
        /* an invalid goal contributes no command */
      }
    }
    let hazards: string[] | null = null;
    const gitHazards = (): string[] => (hazards ??= hostGitExecHazards(loaded.root, c.opts.env));
    const d = decidePreTool(input, { root: loaded.root, manifest: loaded.manifest, permissions, cwd: c.opts.cwd, checkCommands, gitHazards });
    if (d.allow) return EXIT.ok;
    c.out.error(d.reason);
    c.out.set('reason', d.reason);
    return 2;
  } catch (e) {
    c.out.error(`tecera: pre-tool hook failed closed: ${(e as Error).message}`);
    return 2;
  }
};

/** `tecera hook stop` (D4). */
async function stopHook(c: CommandContext, text: string): Promise<number> {
  const block = (reason: string): number => {
    c.out.error(`tecera: ${reason}`);
    c.out.set('decision', 'block');
    c.out.set('reason', reason);
    return 2;
  };
  let input: HookInput & { stop_hook_active?: unknown; session_id?: unknown } = {};
  try {
    input = text.trim() ? parseHookInput(text) : {};
  } catch (e) {
    return block(`stop hook failed closed: unreadable hook payload (${(e as Error).message})`);
  }
  const from = typeof input.cwd === 'string' && input.cwd ? input.cwd : c.opts.cwd;
  let hard: HardenedConfig | null;
  try {
    hard = loadHardenedConfig(c.opts.env);
  } catch (e) {
    return block(`stop hook failed closed: ${(e as Error).message}`);
  }
  /** Hardened: an open run of another business case on this host (or of any, outside one) blocks. */
  const elsewhere = (exceptCaseId: string | null): number | null => {
    if (!hard) return null;
    let open: ReturnType<typeof openRunsElsewhere>;
    try {
      open = openRunsElsewhere(hard, exceptCaseId, c.opts.now);
    } catch (e) {
      return block(`stop hook failed closed: ${(e as Error).message}`);
    }
    if (!open.length) return null;
    const o = open[0]!;
    return block(`goal not achieved: the run registry holds run ${o.runId} (${o.state}) of the business case at ${o.root ?? `state ${o.caseId}`} open${open.length > 1 ? ` (and ${open.length - 1} more)` : ''}. A Tecera run on this host is not finished: resume it there or hand it back to the operator — do not stop yet.`);
  };
  try {
    locateManifest(from, c.args.values.manifest);
  } catch (e) {
    // A manifest named with --manifest that is gone is a broken hook, not the absence of a business case.
    if (e instanceof ManifestLoadError && c.args.values.manifest) return block(`stop hook failed closed: ${e.message}`);
    if (e instanceof ManifestLoadError) {
      // Not a Tecera business case (no tecera.json from the payload's cwd upward): there is no run to protect.
      // A manifest that exists but cannot be read or validated blocks below (new Runtime throws).
      const other = elsewhere(null);
      if (other !== null) return other;
      c.out.say('tecera: no business case here; nothing to prove');
      c.out.set('decision', 'allow');
      return EXIT.ok;
    }
    throw e;
  }
  let goals: string[] = [];
  let rt: Runtime | null = null;
  try {
    // The business case of the hook payload's cwd (Claude Code runs hooks for its project directory).
    rt = new Runtime({ cwd: from, manifestPath: c.args.values.manifest, env: c.opts.env, now: c.opts.now, ...(c.opts.ids ? { ids: c.opts.ids } : {}), ...(c.opts.envSecrets ? { extraSecrets: c.opts.envSecrets } : {}) });
    c.out.useRedactor(rt.redactor);
    goals = listGoalIds(rt.root);
    const h = rt.hardened;
    const other = h ? elsewhere(h.caseId) : null;
    if (other !== null) return other;
    const registered = h ? h.registry.open() : [];
    if (!rt.ledgerExists()) {
      if (registered.length) return block(`goal not achieved: the run registry holds run ${registered[0]!.runId} (${registered[0]!.state}) open but this business case has no ledger: it was deleted or moved. Hand back to the operator — do not stop yet.`);
      c.out.say('tecera: no ledger yet; no run is active');
      c.out.set('decision', 'allow');
      return EXIT.ok;
    }
    const ledger = rt.ledger();
    // The clock approvals expire against is the run's own (injected in tests), never a second one.
    const ev = await evaluateStop(ledger, { ...provenOptionsOf(rt.manifest, rt.redactor), now: c.opts.now(), ...(h ? { registry: hardenedStopRuns(registered, c.opts.now()) } : {}) });
    const runId = ev.activeRun?.runId ?? ev.provedRunId;
    const payload: Record<string, Json> = {
      reason: ev.decision.reason,
      activeRun: (ev.activeRun as unknown as Json) ?? null,
      stopHookActive: input.stop_hook_active === true,
      ...(typeof input.session_id === 'string' ? { hostSession: input.session_id.slice(0, 128) } : {}),
      ...(ev.proof ? { proof: ev.proof as unknown as Json } : {}),
      ...(ev.missing ? { missing: ev.missing } : {}),
      ...(ev.provisional ? { provisional: true } : {}),
    };
    if (h && !h.writer) {
      // Hardened, as the agent identity: the ledger is read-only to this process. Printed, not recorded.
      c.out.set('recorded', false);
    } else {
      try {
        await rt.append(ev.decision.decision === 'block' ? 'stop.blocked' : 'stop.allowed', { ...(runId ? { runId } : {}), payload, actor: { kind: 'system', id: 'hook.stop' } });
      } catch (e) {
        if (ev.decision.decision === 'allow') return block(`stop hook failed closed: the decision could not be recorded (${(e as Error).message})`);
      }
    }
    if (ev.decision.decision === 'block') return block(`goal not achieved: ${ev.missing} — ${ev.decision.reason}`);
    c.out.say(`tecera: ${ev.decision.reason}`);
    if (!ev.activeRun && !ev.proof) c.out.info(stopReminder(goals));
    c.out.set('decision', 'allow');
    c.out.set('reason', ev.decision.reason);
    return EXIT.ok;
  } catch (e) {
    return block(`stop hook failed closed: ${(e as Error).message}`);
  } finally {
    rt?.close();
  }
}
