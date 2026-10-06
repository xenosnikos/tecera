import { Brain, GraduationError } from '@tecera/brain';
import type { Json } from '@tecera/contracts';
import type { Command, CommandContext } from '../cli/context.js';
import { pad } from '../cli/io.js';
import { CliError, EXIT } from '../errors.js';
import { PlanDecisionError, PlanRegistry, type PlanVerdict } from '../plans.js';
import { localPrincipal, PrincipalError, type HumanIdentity } from '../principal.js';
import { safeWriteFile } from '../util/safefs.js';

/**
 * `tecera plans|memory candidates|graduate|reject|retract <id> --rationale <text> [--as <id>]`.
 * Learning goes through humans only: a decision needs a non-empty rationale (exit 2 without) and the local
 * human principal (principal.ts, D1: `--as` or $USER), recorded with the decision. Plans are a projection of plan.* events (PlanRegistry); memory is @tecera/brain over
 * the same ledger. Graduated plans are also rendered to `.tecera/plans/<id>.json` as a view.
 */

const VERBS = ['candidates', 'graduate', 'reject', 'retract'] as const;
type Verb = (typeof VERBS)[number];

function parseVerb(c: CommandContext, noun: string): { verb: Verb; id?: string; rationale: string } {
  const [verb, id, ...rest] = c.args.positionals;
  if (!verb || !(VERBS as readonly string[]).includes(verb) || rest.length) throw new CliError(`usage: tecera ${noun} candidates | ${noun} graduate|reject|retract <id> --rationale <text>`, EXIT.usage);
  if (verb !== 'candidates' && !id) throw new CliError(`usage: tecera ${noun} ${verb} <id> --rationale <text>`, EXIT.usage);
  return { verb: verb as Verb, id, rationale: c.args.values.rationale?.trim() ?? '' };
}

async function needDecider(c: CommandContext, verb: Verb, rationale: string): Promise<HumanIdentity> {
  if (!rationale) throw new CliError(`${verb}: --rationale is required (learning is a human decision with a reason)`, EXIT.usage);
  try {
    return localPrincipal(c.runtime(), { as: c.args.values.as });
  } catch (e) {
    if (e instanceof PrincipalError) throw new CliError(`${verb}: ${e.message}`, e.exitCode);
    throw e;
  }
}

export const plansCommand: Command = async (c) => {
  const { verb, id, rationale } = parseVerb(c, 'plans');
  const rt = c.runtime();
  const ledger = rt.ledger();
  const reg = await PlanRegistry.load(ledger);
  if (verb === 'candidates') {
    const cands = reg.candidates();
    if (cands.length === 0) c.out.say('no plan candidates');
    for (const r of cands) c.out.say(`${pad(r.plan.id, 16)}${r.plan.steps.map((s) => s.id).join(' → ')}  goals: ${r.plan.goalKinds.join(',') || '-'}  origin ${r.plan.origin}`);
    c.out.say(`${reg.accepted().length} accepted plan(s) in the library`);
    c.out.set('candidates', cands.map((r) => r.plan) as unknown as Json);
    return EXIT.ok;
  }
  const who = await needDecider(c, verb, rationale);
  const by = { kind: 'human' as const, id: who.id };
  const v: PlanVerdict = verb === 'graduate' ? 'graduate' : verb === 'reject' ? 'reject' : 'retract';
  try {
    const r = await reg.decide(ledger, id!, { verdict: v, by, rationale, identity: who }, { now: rt.now, id: () => rt.ids('ev') });
    if (v === 'graduate' || v === 'retract') {
      safeWriteFile(rt.root, `.tecera/plans/${r.plan.id.replace(/[^A-Za-z0-9._-]/g, '_')}.json`, `${JSON.stringify(rt.redactor.redactJson({ ...r.plan, decisions: r.decisions }), null, 2)}\n`);
    }
    c.out.say(`plan ${id} → ${r.plan.status} by ${by.id}: ${rationale}`);
    c.out.set('plan', r.plan as unknown as Json);
    return EXIT.ok;
  } catch (e) {
    if (e instanceof PlanDecisionError) {
      c.out.error(`plans ${verb}: ${e.message}`);
      return EXIT.invalid;
    }
    throw e;
  }
};

export const memoryCommand: Command = async (c) => {
  const { verb, id, rationale } = parseVerb(c, 'memory');
  const rt = c.runtime();
  const ledger = rt.ledger();
  const ident = verb === 'candidates' ? null : await needDecider(c, verb, rationale);
  const who = ident ? { kind: 'human' as const, id: ident.id } : null;
  const brain = await Brain.load(ledger, {
    runId: 'cli',
    budgetTokens: rt.manifest.memory.contextBudgetTokens,
    now: rt.now,
    ids: () => rt.ids('ev'),
    actor: who ?? { kind: 'system', id: 'tecera-cli' },
  });
  if (verb === 'candidates') {
    const cands = brain.all().filter((e) => e.state === 'candidate');
    if (cands.length === 0) c.out.say('no memory candidates');
    for (const e of cands) c.out.say(`${pad(e.id, 16)}[${e.tier}/${e.kind}] ${e.content.split('\n')[0]}`);
    c.out.set('candidates', cands as unknown as Json);
    return EXIT.ok;
  }
  const verdict = verb === 'graduate' ? 'promote' : verb === 'reject' ? 'reject' : 'retract';
  try {
    const e = await brain.graduate(id!, { by: who!, verdict, rationale });
    safeWriteFile(rt.root, '.tecera/memory/semantic/LESSONS.md', rt.redact(`# Lessons (rendered from the ledger; do not edit)\n\n${brain.render('semantic').split('\n').slice(2).join('\n')}`));
    c.out.say(`memory ${id} → ${e.state} by ${who!.id} (local principal): ${rationale}`);
    c.out.set('entry', e as unknown as Json);
    return EXIT.ok;
  } catch (err) {
    if (err instanceof GraduationError) {
      c.out.error(`memory ${verb}: ${err.message}`);
      return EXIT.invalid;
    }
    throw err;
  }
};
