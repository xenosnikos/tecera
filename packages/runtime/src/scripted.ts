import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { AchievementGoal, BeliefProjection, CapabilityRecord, ContractDraft, Intention, Manifest, Plan, Planner, PlanningContext, TeceraEvent, UsageMeter } from '@tecera/contracts';
import { ScriptedPlanner, type ScriptedContract } from '@tecera/planner';
import type { FetchLike } from '@tecera/providers';
import { wireOf } from './providerSetup.js';
import { WiringError } from './worktree.js';

/**
 * Scripted mode (`tecera run --scripted <dir>` or TECERA_SCRIPTED=<dir>): a run with no network and no
 * model, for tests and demos. Only the TRANSPORT is replaced: the real provider adapters (request secret
 * scan, response sanitising, usage and cost), the real worker sandbox, the real gates and the real ledger
 * all run. The directory holds:
 *
 * - `plan.json` (optional): a Plan the ScriptedPlanner returns instead of asking the planner seat. Under an
 *   accepted acceptance contract it is stamped with the contract's hash and capabilities, and every
 *   gate.verify step that lists no `inputs.criteria` is bound to the contract's command criteria (the planner
 *   lane's convention), then checked exactly like a model's plan;
 * - `contract.json` (optional): the acceptance contract the planner drafts for a statement run, as a
 *   proposal `{criteria, outOfScope?, assumptions?, needs?}` (goal id and statement are stamped by the host)
 *   or a list of them with `when` (a substring of the statement) — the scripted counterpart of the planner
 *   seat's draft. A statement run with plan.json and no matching contract is refused (fail closed);
 * - `replies.json`: `{ "<seat>": [reply, ...] }` keyed by seat id (`planner`, every worker id, `reviewer`).
 *   A reply is a string (the assistant text) or `{ text, usage?: {input, output}, expect?: <regex> }`;
 *   `expect` must match the outgoing request body or the call fails (a mis-ordered script is an error,
 *   never a silent wrong answer). Replies are served in order per seat; an exhausted seat answers HTTP 418,
 *   which the provider turns into finishReason 'error'.
 *
 * The run records `run.scripted` evidence so a scripted run is never mistaken for a live one, and a run
 * cannot switch between scripted and live across resume.
 */

export const SCRIPTED_ENV = 'TECERA_SCRIPTED';

export interface ScriptReply {
  text: string;
  usage?: { input?: number; output?: number };
  expect?: string;
}

export interface ScriptSet {
  dir: string;
  plan?: Plan;
  /** Scripted contract drafts (contract.json). */
  contracts?: ScriptedContract[];
  replies: Record<string, ScriptReply[]>;
}

/** Observer for every request a scripted seat receives (tests: canary scans of what left the host). */
export type ScriptTap = (seat: string, url: string, body: string) => void;

function readJson(path: string): unknown {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink()) throw new WiringError(`scripted: ${path} is not a regular file`);
  if (st.size > 4 * 1024 * 1024) throw new WiringError(`scripted: ${path} is larger than 4 MiB`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new WiringError(`scripted: ${path} is not valid JSON: ${(e as Error).message}`);
  }
}

export function loadScripts(dirArg: string, cwd: string): ScriptSet {
  const dir = isAbsolute(dirArg) ? dirArg : resolve(cwd, dirArg);
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) throw new WiringError(`scripted: ${dir} is not a directory`);
  const set: ScriptSet = { dir, replies: {} };
  const planPath = join(dir, 'plan.json');
  if (existsSync(planPath)) {
    const p = readJson(planPath);
    if (!p || typeof p !== 'object' || Array.isArray(p) || typeof (p as Plan).id !== 'string') throw new WiringError('scripted: plan.json must be a Plan object with an id');
    set.plan = p as Plan;
  }
  const contractPath = join(dir, 'contract.json');
  if (existsSync(contractPath)) {
    const c = readJson(contractPath);
    const list = Array.isArray(c) ? c : [c];
    if (!list.length || list.some((x) => !x || typeof x !== 'object' || Array.isArray(x) || !Array.isArray((x as ScriptedContract).criteria))) throw new WiringError('scripted: contract.json must be a contract proposal {criteria, …} or a list of them');
    for (const x of list) if ((x as { when?: unknown }).when !== undefined && typeof (x as { when?: unknown }).when !== 'string') throw new WiringError('scripted: contract.json `when` must be a string');
    set.contracts = list as ScriptedContract[];
  }
  const repliesPath = join(dir, 'replies.json');
  if (existsSync(repliesPath)) {
    const r = readJson(repliesPath);
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new WiringError('scripted: replies.json must map seat ids to reply lists');
    for (const [seat, list] of Object.entries(r as Record<string, unknown>)) {
      if (!Array.isArray(list)) throw new WiringError(`scripted: replies for ${seat} must be a list`);
      set.replies[seat] = list.map((x, i): ScriptReply => {
        if (typeof x === 'string') return { text: x };
        if (x && typeof x === 'object' && typeof (x as ScriptReply).text === 'string') {
          const y = x as ScriptReply;
          if (y.expect !== undefined) {
            try {
              new RegExp(y.expect);
            } catch {
              throw new WiringError(`scripted: replies.${seat}[${i}].expect is not a valid regex`);
            }
          }
          return { text: y.text, ...(y.usage ? { usage: y.usage } : {}), ...(y.expect !== undefined ? { expect: y.expect } : {}) };
        }
        throw new WiringError(`scripted: replies.${seat}[${i}] must be a string or {text, usage?, expect?}`);
      });
    }
  }
  if (!set.plan && !set.replies.planner) throw new WiringError('scripted: provide plan.json or replies for the planner seat');
  return set;
}

const n = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);

type Wire = 'anthropic' | 'openai-responses' | 'openai-chat';

function wireBody(kind: Wire, model: string, seq: number, r: ScriptReply): unknown {
  const input = n(r.usage?.input, 800);
  const output = n(r.usage?.output, 200);
  if (kind === 'anthropic') {
    return {
      id: `msg_scripted_${seq}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: r.text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: input, output_tokens: output },
    };
  }
  if (kind === 'openai-chat') {
    // OpenAI-compatible chat completions (OpenRouter's native shape).
    return {
      id: `gen_scripted_${seq}`,
      object: 'chat.completion',
      created: 0,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: r.text }, finish_reason: 'stop', native_finish_reason: 'stop' }],
      usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
    };
  }
  return {
    id: `resp_scripted_${seq}`,
    object: 'response',
    status: 'completed',
    model,
    output: [{ type: 'message', id: `msg_scripted_${seq}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: r.text, annotations: [] }] }],
    incomplete_details: null,
    error: null,
    usage: { input_tokens: input, output_tokens: output, total_tokens: input + output },
  };
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A FetchLike for one seat that answers from its scripted replies in the provider's wire format, read from
 * the request URL (`/v1/messages` Anthropic, `/chat/completions` OpenAI-compatible chat as OpenRouter
 * speaks it, else the OpenAI Responses API); `kind` is only a label. The request body is handed to `tap` as
 * the exact bytes the provider would have sent.
 */
export function scriptedFetch(seat: string, _kind: 'anthropic' | 'openai' | 'openrouter' | 'auto', replies: ScriptReply[], tap?: ScriptTap): FetchLike {
  const queue = [...replies];
  let seq = 0;
  return async (url, init) => {
    const body = typeof init.body === 'string' ? init.body : '';
    tap?.(seat, String(url), body);
    if (init.signal?.aborted) {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      throw e;
    }
    const next = queue.shift();
    seq++;
    if (!next) return json(418, { error: { type: 'scripted', message: `scripted seat ${seat}: no reply left (request ${seq})` } });
    if (next.expect !== undefined && !new RegExp(next.expect).test(body)) {
      return json(418, { error: { type: 'scripted', message: `scripted seat ${seat}: request ${seq} does not match the scripted expectation` } });
    }
    let model = 'scripted';
    try {
      const m = (JSON.parse(body) as { model?: unknown }).model;
      if (typeof m === 'string' && m) model = m;
    } catch {
      // keep the default
    }
    return json(200, wireBody(wireOf(String(url)), model, seq, next));
  };
}

/**
 * `plan` bound to the accepted contract in `ctx`: every gate.verify step that lists no `inputs.criteria` lists
 * the contract's command criteria. Without a contract the plan is returned unchanged.
 */
export function bindVerifyCriteria(plan: Plan, ctx?: PlanningContext): Plan {
  const contract = ctx?.contract;
  if (!contract) return plan;
  const ids = contract.criteria.filter((k) => k.check.kind === 'command').map((k) => k.id);
  return { ...plan, steps: plan.steps.map((st) => (st.kind === 'gate.verify' && (st.inputs as { criteria?: unknown } | undefined)?.criteria === undefined ? { ...st, inputs: { ...(st.inputs ?? {}), criteria: ids } } : st)) };
}

/**
 * The planner of a scripted run: @tecera/planner's ScriptedPlanner over the scripted plan (bound to the
 * accepted contract per write, see bindVerifyCriteria) and the scripted contracts. Same checks as the model's
 * path (contractPlanIssues, assembleDraft); nothing here relaxes them.
 */
export class ScriptedRunPlanner implements Planner {
  private readonly drafts: ScriptedPlanner;
  constructor(
    private readonly plan: Plan,
    private readonly o: { contracts?: readonly ScriptedContract[]; connections?: Manifest['connections']; allowedChanges?: readonly string[]; protectedPaths?: readonly string[]; fileExists?: (path: string) => boolean } = {},
  ) {
    this.drafts = new ScriptedPlanner({
      plans: [plan],
      ...(o.contracts ? { contracts: o.contracts } : {}),
      ...(o.connections ? { connections: o.connections } : {}),
      ...(o.allowedChanges ? { allowedChanges: o.allowedChanges } : {}),
      ...(o.protectedPaths ? { protectedPaths: o.protectedPaths } : {}),
      ...(o.fileExists ? { fileExists: o.fileExists } : {}),
    });
  }

  write(e: TeceraEvent, beliefs: BeliefProjection, goal: AchievementGoal, meter?: UsageMeter, ctx?: PlanningContext): Promise<Plan> {
    const inner = new ScriptedPlanner({ plans: [bindVerifyCriteria(this.plan, ctx)], ...(this.o.connections ? { connections: this.o.connections } : {}) });
    return inner.write(e, beliefs, goal, meter, ctx);
  }

  draftContract(statement: string, goal: AchievementGoal, inventory: readonly CapabilityRecord[]): Promise<ContractDraft> {
    return this.drafts.draftContract(statement, goal, inventory);
  }

  deliberate(options: Plan[], intentions: Intention[]): Promise<Plan> {
    return this.drafts.deliberate(options, intentions);
  }
}
