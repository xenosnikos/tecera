import type { Json, ProvisionedResource, ResourceRegistry, TeceraEvent } from '@tecera/contracts';
import { projectResources } from '@tecera/ledger';
import { LocalProvisioner, ProvisioningRefused, resourcesRoot } from '../capabilities/provisioner.js';
import { resourceTransferredEvent } from '../capabilities/events.js';
import { releaseRecorded } from '../capabilities/sweep.js';
import type { Command, CommandContext } from '../cli/context.js';
import { guardDecision } from '../decisionGuard.js';
import { CliError, EXIT } from '../errors.js';
import { identityJson, localPrincipal, PrincipalError, type HumanIdentity } from '../principal.js';
import type { Runtime } from '../runtime.js';

/**
 * `tecera resources list|release|transfer` (D12: provisioned resources are debts). Everything is read from
 * the ledger's resource registry (projectResources, with the manifest allowance and the redactor's secrets),
 * never from the provisioner's local files.
 *
 * - `list [--run id]`: every recorded resource with its kind, locator, expiry and transfer state; refused
 *   records and resources over the allowance are reported (exit 8 when there are any).
 * - `release <resourceId> [--as id] [--reason text]`: the local human runs the recorded teardown (only the
 *   teardown the provisioner wrote is ever run), then resource.released is recorded with them as actor. A
 *   teardown that fails records nothing (the debt stays pending, exit 1). Releasing a released resource is
 *   a no-op (exit 0); a transferred one is refused (exit 1).
 * - `transfer <resourceId> [--to id] [--as id] [--reason note]`: the local human takes the resource over
 *   (resource.transferred, actor and `to` human; `to` defaults to the principal). Tecera never tears it down
 *   afterwards. Release and transfer hold the resource's lock and read the ledger again under it, so the
 *   one that gets there first decides.
 * - release and transfer are human decisions: both go through the accident guard first (decisionGuard.ts:
 *   exit 8 under an agent-host marker or without a terminal, unless TECERA_DECISION_NONINTERACTIVE=1). It is
 *   not authentication. `list` only reads and is not guarded.
 */

export interface ResourcesCommandOptions {
  /** The provisioner whose teardowns release runs (default: the local one under resourcesRoot(env)). */
  provisioner?: (rt: Runtime) => LocalProvisioner;
}

export function defaultProvisioner(rt: Runtime): LocalProvisioner {
  return new LocalProvisioner({
    root: resourcesRoot(rt.env),
    repoRoot: rt.root,
    allowance: rt.manifest.provisioning,
    runId: 'cli',
    secrets: (v) => rt.redactor.containsSecret(v) !== null,
    now: rt.now,
    ids: rt.ids,
  });
}

async function registry(rt: Runtime, runId?: string): Promise<ResourceRegistry> {
  return projectResources(rt.ledger(), { ...(runId ? { runId } : {}), allowance: rt.manifest.provisioning, secrets: (v) => rt.redactor.containsSecret(v) !== null });
}

function principal(c: CommandContext, rt: Runtime, verb: string): HumanIdentity | number {
  try {
    return localPrincipal(rt, { as: c.args.values.as });
  } catch (e) {
    if (e instanceof PrincipalError) {
      c.out.error(`resources ${verb}: ${e.message}`);
      c.out.set('error', e.message);
      return e.exitCode;
    }
    throw e;
  }
}

function row(r: ProvisionedResource, now: number): Json {
  return { id: r.id, capability: r.capability, kind: r.kind, locator: r.locator, transfer: r.transfer, createdAt: r.createdAt, expiresAt: r.expiresAt, expired: r.transfer === 'pending' && r.expiresAt <= now, runId: r.runId ?? null, goalId: r.goalId ?? null };
}

export function resourcesListCommand(): Command {
  return async (c) => {
    if (c.args.positionals.length > 1) throw new CliError('usage: tecera resources list [--run id]', EXIT.usage);
    const rt = c.runtime();
    if (!rt.ledgerExists()) {
      c.out.say('no ledger yet');
      c.out.set('resources', []);
      return EXIT.ok;
    }
    const reg = await registry(rt, c.args.values.run);
    const now = rt.now();
    if (!reg.resources.length) c.out.say('no provisioned resources');
    for (const r of reg.resources) {
      const exp = r.transfer === 'pending' ? (r.expiresAt <= now ? `expired ${new Date(r.expiresAt).toISOString()}` : `expires ${new Date(r.expiresAt).toISOString()}`) : '';
      c.out.say(`${r.id}  ${r.kind}  ${r.transfer}  ${r.locator}  ${exp}`.trimEnd());
    }
    for (const id of reg.overAllowance) c.out.error(`resources: ${id} was provisioned past the run's allowance`);
    for (const p of reg.problems) c.out.error(`resources: ${p}`);
    c.out.set('resources', reg.resources.map((r) => row(r, now)));
    c.out.set('pending', reg.pending.map((r) => r.id));
    c.out.set('overAllowance', reg.overAllowance);
    c.out.set('problems', reg.problems);
    return reg.problems.length || reg.overAllowance.length ? EXIT.policy : EXIT.ok;
  };
}

/** The resource id of `release|transfer <resourceId>`; a usage error (exit 2) comes before everything else. */
function resourceArg(c: CommandContext, verb: string): string {
  const id = c.args.positionals[1];
  if (!id || c.args.positionals.length > 2) throw new CliError(`usage: tecera resources ${verb} <resourceId>${verb === 'transfer' ? ' [--to id]' : ''} [--as id] [--reason text]`, EXIT.usage);
  return id;
}

async function target(c: CommandContext, rt: Runtime, verb: string): Promise<{ r: ProvisionedResource } | { code: number }> {
  const id = resourceArg(c, verb);
  if (!rt.ledgerExists()) {
    c.out.error(`resources ${verb}: no ledger yet`);
    return { code: EXIT.error };
  }
  const r = (await registry(rt)).byId[id];
  if (!r) {
    c.out.error(`resources ${verb}: no recorded resource ${id}`);
    c.out.set('error', 'unknown resource');
    return { code: EXIT.error };
  }
  return { r };
}

export function resourcesReleaseCommand(o: ResourcesCommandOptions = {}): Command {
  return async (c) => {
    resourceArg(c, 'release');
    const guard = guardDecision(c, 'resources release');
    if (typeof guard === 'number') return guard;
    const rt = c.runtime();
    const t = await target(c, rt, 'release');
    if ('code' in t) return t.code;
    const { r } = t;
    c.out.set('resourceId', r.id);
    if (r.transfer === 'released') {
      c.out.say(`${r.id} is already released`);
      c.out.set('transfer', 'released');
      return EXIT.ok;
    }
    if (r.transfer === 'transferred') {
      c.out.error(`resources release: ${r.id} was transferred to a human; Tecera no longer tears it down`);
      c.out.set('error', 'transferred');
      return EXIT.error;
    }
    const who = principal(c, rt, 'release');
    if (typeof who === 'number') return who;
    let prov: LocalProvisioner;
    try {
      prov = (o.provisioner ?? defaultProvisioner)(rt);
    } catch (e) {
      if (!(e instanceof ProvisioningRefused)) throw e;
      c.out.error(`resources release: ${e.message}`);
      return EXIT.error;
    }
    const reason = c.args.values.reason?.trim() || 'released by a human';
    const res = await releaseRecorded({ ledger: rt.ledger(), provisioner: prov, actor: { kind: 'human', id: who.id }, ids: rt.ids, now: rt.now }, r, reason);
    c.out.set('teardownExit', res.teardownExit);
    if (res.teardownExit !== 0) {
      c.out.error(`resources release: the teardown of ${r.id} exited ${res.teardownExit}${res.reason ? ` (${res.reason})` : ''}; nothing was recorded, it stays pending`);
      c.out.set('error', res.reason ?? 'teardown failed');
      return EXIT.error;
    }
    if (res.unrecorded) {
      c.out.error(`resources release: ${r.id} was torn down but resource.released could not be recorded (${res.unrecorded}); run the release again to record it`);
      c.out.set('error', 'release not recorded');
      return EXIT.error;
    }
    c.out.say(`released ${r.id} (${r.kind}) as ${who.id}${res.already ? ' (it was already gone)' : ''}${res.event ? ` · event ${res.event.id}` : ''}`);
    c.out.set('transfer', 'released');
    c.out.set('identity', identityJson(who));
    if (res.event) c.out.set('eventId', res.event.id);
    return EXIT.ok;
  };
}

export function resourcesTransferCommand(o: ResourcesCommandOptions = {}): Command {
  return async (c) => {
    resourceArg(c, 'transfer');
    const guard = guardDecision(c, 'resources transfer');
    if (typeof guard === 'number') return guard;
    const rt = c.runtime();
    const t = await target(c, rt, 'transfer');
    if ('code' in t) return t.code;
    const { r } = t;
    c.out.set('resourceId', r.id);
    if (r.transfer !== 'pending') {
      c.out.error(`resources transfer: ${r.id} is already ${r.transfer}`);
      c.out.set('error', r.transfer);
      return EXIT.error;
    }
    const who = principal(c, rt, 'transfer');
    if (typeof who === 'number') return who;
    const to = c.args.values.to?.trim() || who.id;
    if (!/^[A-Za-z0-9_.@+-]{1,128}$/.test(to)) throw new CliError('resources transfer: --to must be a plain identifier', EXIT.usage);
    const note = c.args.values.reason?.trim();
    let prov: LocalProvisioner | null = null;
    try {
      prov = (o.provisioner ?? defaultProvisioner)(rt);
    } catch (e) {
      // The ledger decides (the sweep re-reads it); without a provisioner there is no local lock or mark.
      c.out.info(`note: the local record of ${r.id} cannot be reached (${(e as Error).message})`);
    }
    // Under the resource lock: the ledger is read again, so a release or transfer that got there first wins.
    const record = async (): Promise<{ ev: TeceraEvent } | { state: string }> => {
      const cur = (await registry(rt)).byId[r.id];
      if (cur?.transfer !== 'pending') return { state: cur?.transfer ?? 'gone from the ledger' };
      const ev = resourceTransferredEvent(
        { resourceId: r.id, to: { kind: 'human', id: to }, ...(note ? { note } : {}) },
        { id: rt.ids('ev'), at: rt.now(), actor: { kind: 'human', id: who.id }, ...(r.runId ? { runId: r.runId } : {}) },
      );
      const appended = await rt.ledger().append({ ...ev, idemKey: `resource.transferred:${r.id}` });
      if (appended.duplicate) return { state: 'transferred' };
      try {
        prov?.markTransferred(r.id);
      } catch (e) {
        c.out.info(`note: the local record of ${r.id} was not marked (${(e as Error).message})`);
      }
      return { ev };
    };
    let done: { ev: TeceraEvent } | { state: string };
    try {
      done = prov ? await prov.exclusive(r.id, record) : await record();
    } catch (e) {
      if (!(e instanceof ProvisioningRefused)) throw e;
      c.out.error(`resources transfer: ${e.message}`);
      c.out.set('error', 'busy');
      return EXIT.error;
    }
    if ('state' in done) {
      c.out.error(`resources transfer: ${r.id} is already ${done.state}`);
      c.out.set('error', done.state);
      return EXIT.error;
    }
    const { ev } = done;
    c.out.say(`transferred ${r.id} (${r.kind}, ${r.locator}) to ${to} as ${who.id} · event ${ev.id}`);
    c.out.set('transfer', 'transferred');
    c.out.set('to', to);
    c.out.set('identity', identityJson(who));
    c.out.set('eventId', ev.id);
    return EXIT.ok;
  };
}

/** `tecera resources <list|release|transfer> …` (list when no subcommand is given). */
export function resourcesCommand(o: ResourcesCommandOptions = {}): Command {
  const subs: Record<string, Command> = { list: resourcesListCommand(), release: resourcesReleaseCommand(o), transfer: resourcesTransferCommand(o) };
  return async (c) => {
    const sub = c.args.positionals[0] ?? 'list';
    const cmd = Object.prototype.hasOwnProperty.call(subs, sub) ? subs[sub] : undefined;
    if (!cmd) throw new CliError('usage: tecera resources list|release|transfer', EXIT.usage);
    return cmd(c.args.positionals.length ? c : { ...c, args: { ...c.args, positionals: ['list'] } });
  };
}
