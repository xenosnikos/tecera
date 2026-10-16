import { z } from 'zod';
import {
  canonicalEnvelope,
  canonicalJson,
  contractHash,
  contractProblem,
  resolveGap,
  type AcceptanceContract,
  type AchievementGoal,
  type CapabilityNeed,
  type CapabilityRecord,
  type ChangePath,
  type ContractDraft,
  type Criterion,
  type Json,
  type JsonObject,
  type Manifest,
  type Plan,
  type PlanningContext,
  type ProvisioningAllowance,
  type Redactor,
} from '@tecera/contracts';
import { globWithin, matchesAny, matchesProtected } from '@tecera/policy';
import { deepSecretKind, inertDepth, MAX_PLAN_DEPTH, patternRedactor, UNSCANNABLE } from './hygiene.js';
import { extractFirstJsonObject } from './parse.js';
import { MAX_TAGS, normalizeTag, type ImpliedNeed } from './quality.js';
import { CAPABILITY_ID_RE, formatZodIssues, safeSegment } from './schema.js';
import { base, readShell, type ShellNode } from './shell.js';

/**
 * Acceptance contracts at the planner seat (owner decision D8).
 *
 * Drafting. The model turns a free-text request into criteria (each with its own check), out-of-scope items,
 * assumptions and the capabilities the criteria need. Its answer is hostile text: it is decoded strictly
 * (CONTRACT_WIRE_JSON_SCHEMA, closed objects, bounded lists and strings), then the host stamps the goal id and
 * the requestor's statement, builds the needs from the criteria's `requires` (a declared connection's kind and
 * mockable always win over the model's), and validates the result: contracts contractProblem (at least one
 * command criterion, so a contract of human judgments alone is refused), bounds, a complete secret scan, no
 * check that cannot fail, and no requestor criterion dropped or loosened. Anything else is an issue.
 *
 * Plans. A plan written for an accepted contract carries its contractHash, a gate.verify that runs after
 * every worker step and lists every command criterion in `inputs.criteria`, and in `capabilities` every
 * capability it uses (at least every one the contract requires). The verify the commit rests on lists them
 * all. A capability nobody declared, or one whose gap resolves to `ask`, is refused.
 */

/** Most criteria one contract may carry. */
export const MAX_CRITERIA = 16;
/** Most out-of-scope items, assumptions or needs one contract may carry. */
export const MAX_CONTRACT_NOTES = 16;
/** Longest check a criterion may run, in seconds. */
export const MAX_CRITERION_TIMEOUT_SEC = 3600;
const MAX_COMMAND_CHARS = 1000;
const MAX_STATEMENT_CHARS = 1000;
const MAX_NOTE_CHARS = 500;
const CRITERION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Commands that exit 0 whatever the repository holds: they check nothing. */
const TRIVIAL_COMMAND = /^\s*(?:true|:|exit(?:\s+0)?|echo(?:\s.*)?|printf(?:\s.*)?|test\s+1|\[\s+1\s+\]|!\s*false)\s*;?\s*$/i;
/** A shell wrapper around one quoted command (`sh -c '…'`, `bash -c "…"`, `env bash -c …`): the inner command decides. */
const SHELL_WRAPPER = /^\s*(?:(?:\/usr)?\/bin\/)?(?:env\s+)?(?:(?:\/usr)?\/bin\/)?(?:sh|bash|dash|zsh)\s+-c\s+(['"])([\s\S]*)\1\s*;?\s*$/;
/** Interpreter one-liners that do nothing but exit 0. */
const TRIVIAL_INTERPRETER = /^\s*(?:node|python3?)\s+(?:-e|-c)\s+(['"])\s*(?:process\.exit\(\s*0?\s*\)|pass|exit\(\s*0?\s*\)|(?:import\s+sys\s*;\s*)?sys\.exit\(\s*0?\s*\))?\s*;?\s*\1\s*;?\s*$/;
/** A head, tail or branch that forces success: `true || …`, `… || true`, `…; exit 0`, `… | true`, `… || exit 0 …`. */
const FORCED_SUCCESS = [/^\s*(?:true|:|!\s*false)\s*\|\|/, /(?:\|\||;|\|)\s*(?:true|:|exit\s+0)\s*;?\s*$/, /(?:^|;|\|\|)\s*exit\s+0\b/];

/** Programs that exit 0 whatever they are given. */
const EXITS_ZERO = new Set(['true', ':', 'echo', 'printf', 'tee', 'tr', 'pwd', 'export', 'unset', 'set']);
/** Filters that exit 0 on anything piped to them, when they are handed no file of their own. */
const PASSES_THROUGH = new Set(['tail', 'head', 'cat', 'wc', 'sort', 'uniq', 'cut', 'nl']);

/** True when a simple command (unwrapped words) exits 0 whatever the repository holds. `piped`: it reads a pipe. */
function exitsZero(w: readonly string[], piped: boolean): boolean {
  const prog = base(w[0]!);
  const args = w.slice(1);
  if (EXITS_ZERO.has(prog)) return true;
  if (PASSES_THROUGH.has(prog)) return piped && args.every((a) => a.startsWith('-') || /^\+?\d+$/.test(a));
  if (prog === 'exit') return args.length === 1 && /^0+$/.test(args[0]!);
  // `test 1`, `[ ok ]`: a constant.
  const operand = prog === 'test' ? args : prog === '[' && args[args.length - 1] === ']' ? args.slice(0, -1) : null;
  return operand !== null && operand.length === 1 && /^[A-Za-z0-9_.-]+$/.test(operand[0]!);
}

const programOf = (n: ShellNode): string => (n.kind === 'command' && n.words.length ? base(n.words[0]!) : '');

/**
 * Whether a parsed command line can exit non-zero at all, by the shell's own rules: a pipeline exits as its
 * last stage, `a || b` fails only when both can, `a && b` when either can, a `;` list exits as its last
 * command (as any of them under `set -e`), a background job always exits 0.
 */
function canFail(n: ShellNode, piped = false): boolean {
  switch (n.kind) {
    case 'command':
      // Assignments alone exit 0, unless one runs a command substitution.
      return n.words.length ? !exitsZero(n.words, piped) : n.subs.length > 0;
    case 'group':
      return canFail(n.body);
    case 'pipeline': {
      const last = n.stages[n.stages.length - 1]!;
      if (n.negated) return programOf(last) !== 'false';
      return canFail(last, n.stages.length > 1);
    }
    case 'and':
      return canFail(n.left) || canFail(n.right);
    case 'or':
      return canFail(n.left) && canFail(n.right);
    case 'list': {
      let errexit = n.errexit;
      let earlier = false;
      for (let i = 0; i < n.items.length; i++) {
        const item = n.items[i]!;
        const last = i === n.items.length - 1;
        const stops = item.kind === 'command' && programOf(item) === 'exit' && exitsZero(item.words, false);
        if (stops || (last && n.background[i])) return earlier;
        if (n.background[i]) continue;
        if (last) return earlier || canFail(item);
        if (errexit && canFail(item)) earlier = true;
        if (item.kind === 'command' && programOf(item) === 'set') {
          const a = item.words.slice(1);
          if (a.some((x, j) => /^-[A-Za-z]*e/.test(x) || (x === '-o' && a[j + 1] === 'errexit'))) errexit = true;
          if (a.some((x, j) => /^\+[A-Za-z]*e/.test(x) || (x === '+o' && a[j + 1] === 'errexit'))) errexit = false;
        }
      }
      return earlier;
    }
  }
}

/**
 * True when the shell structure of `cmd` leaves it no way to exit non-zero: the check's status is replaced by
 * a command that always succeeds (`check || echo failed`, `check && echo PASS || echo FAIL`, `check | tail -5`,
 * `check | tee log`, `check; echo done`, `check || /bin/true`, `check || (exit 0)`, `check &`), also behind
 * known prefixes and inside nested shells (`timeout 5 true`, `sh -c 'check; echo ok'`). A line the reader
 * cannot follow (control flow, unreadable syntax) is not judged here.
 */
function cannotFail(cmd: string): boolean {
  try {
    const read = readShell(cmd);
    if (read.marks.has('unreadable') || read.marks.has('control')) return false;
    return !canFail(read.tree);
  } catch {
    return false;
  }
}

/**
 * True when `cmd` exits 0 whatever the repository holds. A coarse screen, not a proof: it catches the plain
 * no-ops, their shell and interpreter wrappers, and a success forced by the shell around the check (a
 * fallback, a pipe into a filter, a trailing command: cannotFail); a disguised no-op still reaches the
 * requestor, whose sign-off is the authority on what each criterion checks. The stricter screen over a
 * drafted criterion's exit status is quality commandStatusProblems.
 */
export function commandAlwaysPasses(cmd: string): boolean {
  let c = cmd;
  for (let i = 0; i < 4; i++) {
    const w = SHELL_WRAPPER.exec(c);
    if (!w) break;
    c = w[2]!;
  }
  if (TRIVIAL_COMMAND.test(c) || TRIVIAL_INTERPRETER.test(c)) return true;
  return FORCED_SUCCESS.some((re) => re.test(c)) || cannotFail(cmd);
}

/** The draft was refused after every attempt. `issues` are sanitised (redacted, single-line, bounded). */
export class ContractRejected extends Error {
  constructor(
    public readonly issues: readonly string[],
    public readonly attempts: number = 2,
  ) {
    super(`acceptance contract draft rejected after ${attempts} attempt(s): ${issues.length} issue(s)${issues.length ? `\n- ${issues.slice(0, 20).join('\n- ')}` : ''}`);
    this.name = 'ContractRejected';
  }
}

// ---------- wire format ----------

const wStr = (description?: string): JsonObject => (description ? { type: 'string', description } : { type: 'string' });
const wNullable = (s: JsonObject, description?: string): JsonObject => ({ anyOf: [s, { type: 'null' }], ...(description ? { description } : {}) });
const wStrings = (description?: string): JsonObject => ({ type: 'array', items: { type: 'string' }, ...(description ? { description } : {}) });
const wClosed = (properties: Record<string, JsonObject>, description?: string): JsonObject => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
  ...(description ? { description } : {}),
});

/**
 * What the planner seat answers when drafting a contract: closed, all-required, inside the structured-output
 * subset both vendors document (like PLAN_WIRE_JSON_SCHEMA). The goal id and the statement are never the
 * model's: the host stamps them.
 */
export const CONTRACT_WIRE_JSON_SCHEMA: JsonObject = wClosed({
  criteria: {
    type: 'array',
    minItems: 1,
    description: `At most ${MAX_CRITERIA} criteria; at least one of kind "command".`,
    items: wClosed({
      id: wStr('Unique criterion id: lowercase letters, digits, _ or -, starting with a letter or digit.'),
      statement: wStr('What must be true, in one sentence.'),
      kind: { type: 'string', enum: ['command', 'human'] },
      command: wNullable(wStr(), 'kind "command": a shell command run in the repository that exits 0 exactly when the criterion holds. Null for "human".'),
      timeoutSec: wNullable({ type: 'integer' }, 'kind "command": seconds the command may run. Null for "human".'),
      prompt: wNullable(wStr(), 'kind "human": the yes/no question a human reviewer answers. Null for "command".'),
      requires: wStrings('Capability ids this criterion depends on (connections or new needs); empty when it needs only the repository.'),
      tags: wStrings('Short lowercase kebab-case names of what the criterion checks (e.g. http-404, the header name in lowercase, orders-persist, report-unchanged); empty when none fits.'),
    }),
  },
  outOfScope: wStrings('Things the request does not ask for.'),
  assumptions: wStrings('What the contract assumes without checking.'),
  envelope: {
    type: 'array',
    minItems: 1,
    description: 'The change-path envelope: every repository path the work may touch and how. Existing files it must modify or delete, new files the criteria imply. Never empty: a contract without one is refused.',
    items: wClosed({
      path: wStr('A repository-relative path, or a narrow glob whose first segment is a literal directory (src/reports/*.js).'),
      ops: { type: 'array', items: { type: 'string', enum: ['create', 'modify', 'delete'] }, description: 'The operations allowed on it.' },
    }),
  },
  needs: {
    type: 'array',
    description: 'One entry per capability id named in any criterion requires.',
    items: wClosed({
      id: wStr('The capability id.'),
      kind: wStr('What it is (e.g. sqlite, git-remote, http-stub, mail, tmpdir).'),
      mockable: wNullable({ type: 'boolean' }, 'Whether a stand-in may serve it; null for the default.'),
    }),
  },
});

const ContractWireSchema = z
  .object({
    criteria: z
      .array(
        z
          .object({
            id: z.string().max(64),
            statement: z.string().max(MAX_STATEMENT_CHARS),
            kind: z.enum(['command', 'human']),
            command: z.string().max(MAX_COMMAND_CHARS).nullish(),
            timeoutSec: z.number().nullish(),
            prompt: z.string().max(MAX_STATEMENT_CHARS).nullish(),
            requires: z.array(z.string().max(64)).max(16).nullish(),
            tags: z.array(z.string().max(64)).max(16).nullish(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_CRITERIA),
    outOfScope: z.array(z.string().max(MAX_NOTE_CHARS)).max(MAX_CONTRACT_NOTES).nullish(),
    assumptions: z.array(z.string().max(MAX_NOTE_CHARS)).max(MAX_CONTRACT_NOTES).nullish(),
    envelope: z.array(z.object({ path: z.string().max(400), ops: z.array(z.enum(['create', 'modify', 'delete'])).max(3) }).strict()).max(200).nullish(),
    needs: z
      .array(z.object({ id: z.string().max(64), kind: z.string().max(64), mockable: z.boolean().nullish() }).strict())
      .max(MAX_CONTRACT_NOTES)
      .nullish(),
  })
  .strict();

/** A contract as the seat (or a script) proposes it: no goal id and no statement, those are host-stamped. */
export interface ContractProposal {
  criteria: Criterion[];
  outOfScope?: string[];
  assumptions?: string[];
  /** The change-path envelope (contracts AcceptanceContract.envelope); absent or empty = none stated. */
  envelope?: ChangePath[];
  /** The kind (and mockable) of each capability a criterion requires; a declared connection overrides it. */
  needs?: Array<{ id: string; kind: string; mockable?: boolean }>;
}

/** Keys a contract answer must not carry: the host stamps them. */
const CONTRACT_STAMPED_KEYS = ['goalId', 'statement'] as const;

/**
 * Parse the seat's contract answer into a proposal. Never throws. The first balanced JSON object is taken,
 * nesting is bounded, the wire shape is checked strictly, and each criterion must fill exactly the fields
 * of its kind.
 */
export function parseContractOutput(raw: string): { ok: true; proposal: ContractProposal } | { ok: false; issues: string[] } {
  try {
    const obj = extractFirstJsonObject(raw);
    if (!obj.ok) return obj;
    if (inertDepth(obj.value, MAX_PLAN_DEPTH + 1) > MAX_PLAN_DEPTH) return { ok: false, issues: [`contract document nests deeper than ${MAX_PLAN_DEPTH} levels`] };
    const stamped = CONTRACT_STAMPED_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(obj.value, k));
    if (stamped.length) return { ok: false, issues: stamped.map((k) => `${k}: is host-stamped; a contract document must not carry it`) };
    const w = ContractWireSchema.safeParse(obj.value);
    if (!w.success) return { ok: false, issues: formatZodIssues(w.error) };
    const issues: string[] = [];
    const criteria: Criterion[] = w.data.criteria.map((c, i) => {
      const at = `criteria.${i}`;
      const requires = [...(c.requires ?? [])];
      // Descriptive only (outside the contract hash): kept in canonical shape, anything else dropped.
      const tags = (c.tags ?? []).map(normalizeTag).filter((t): t is string => t !== null);
      const tagged = (k: Criterion): Criterion => (tags.length ? ({ ...k, tags: [...new Set(tags)].slice(0, MAX_TAGS) } as Criterion) : k);
      if (c.kind === 'command') {
        if (c.command == null) issues.push(`${at}.command: a command criterion needs a command`);
        if (c.timeoutSec == null) issues.push(`${at}.timeoutSec: a command criterion needs a timeout`);
        if (c.prompt != null) issues.push(`${at}.prompt: must be null for a command criterion`);
        return tagged({ id: c.id, statement: c.statement, check: { kind: 'command', command: c.command ?? '', timeoutSec: c.timeoutSec ?? 0 }, requires });
      }
      if (c.prompt == null) issues.push(`${at}.prompt: a human criterion needs a question`);
      if (c.command != null || c.timeoutSec != null) issues.push(`${at}: command and timeoutSec must be null for a human criterion`);
      return tagged({ id: c.id, statement: c.statement, check: { kind: 'human', prompt: c.prompt ?? '' }, requires });
    });
    if (issues.length) return { ok: false, issues };
    const needs = (w.data.needs ?? []).map((n) => ({ id: n.id, kind: n.kind, ...(n.mockable != null ? { mockable: n.mockable } : {}) }));
    const envelope = (w.data.envelope ?? []).map((e) => ({ path: e.path, ops: [...e.ops] }));
    return { ok: true, proposal: { criteria, outOfScope: [...(w.data.outOfScope ?? [])], assumptions: [...(w.data.assumptions ?? [])], ...(envelope.length ? { envelope } : {}), needs } };
  } catch (err) {
    return { ok: false, issues: [`unparseable contract output (${err instanceof Error ? err.name : 'error'})`] };
  }
}

// ---------- assembly and validation ----------

export interface DraftContext {
  /** The requestor's statement, stamped verbatim as the contract statement. */
  statement: string;
  /** The goal: its id is stamped; its `criteria` (a goal file's) must survive unweakened. */
  goal: AchievementGoal;
  inventory?: readonly CapabilityRecord[];
  /** Declared connections (manifest.connections): their kind and mockable override the proposal's. */
  connections?: Manifest['connections'];
  /** Known secrets to scan for; default SECRET_PATTERNS only. */
  redactor?: Redactor;
  /** Capabilities the statement implies (impliedNeeds): the last source of a required capability's kind. */
  implied?: readonly ImpliedNeed[];
  /**
   * What a drafted change-path envelope is screened against: the manifest's repo.allowedChanges (every entry
   * must lie inside it) and policy.protectedPaths (none may name one), and the repository as it is (a path
   * that may only be modified or deleted must exist; one that may only be created must not).
   */
  allowedChanges?: readonly string[];
  protectedPaths?: readonly string[];
  fileExists?: (path: string) => boolean;
  /**
   * The draft must state an envelope (both planners set it: a drafted contract is always signed off with
   * an explicit path list). A goal file's contract is not drafted and keeps the manifest boundary without one.
   */
  requireEnvelope?: boolean;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * A proposal → a ContractDraft, or the issues that refuse it. The goal id and statement are stamped; every
 * capability a criterion requires gets a need (kind and mockable from the declared connection, else the
 * inventory's kind, else the proposal's, else the kind the statement implies); a proposed need no criterion requires is an issue. The draft is
 * then checked by contractDraftIssues.
 */
export function assembleDraft(p: ContractProposal, c: DraftContext): { ok: true; draft: ContractDraft } | { ok: false; issues: string[] } {
  try {
    const criteria = clone(p.criteria ?? []);
    const contract: AcceptanceContract = {
      goalId: c.goal.id,
      statement: c.statement,
      criteria,
      outOfScope: [...(p.outOfScope ?? [])],
      assumptions: [...(p.assumptions ?? [])],
      ...(Array.isArray(p.envelope) && p.envelope.length ? { envelope: canonicalEnvelope(clone(p.envelope)) } : {}),
    };
    const issues: string[] = [];
    const proposed = new Map<string, { kind: string; mockable?: boolean }>();
    for (const n of p.needs ?? []) {
      if (proposed.has(n.id)) issues.push(`need ${safeSegment(n.id)} appears twice`);
      proposed.set(n.id, n);
    }
    const required = new Map<string, string[]>();
    for (const k of criteria) for (const r of Array.isArray(k.requires) ? k.requires : []) required.set(r, [...(required.get(r) ?? []), k.id]);
    for (const id of proposed.keys()) if (!required.has(id)) issues.push(`need ${safeSegment(id)} is required by no criterion`);
    const needs: CapabilityNeed[] = [];
    for (const [id, crit] of [...required].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const conn = c.connections && Object.prototype.hasOwnProperty.call(c.connections, id) ? c.connections[id] : undefined;
      const rec = c.inventory?.find((r) => r.id === id);
      const prop = proposed.get(id);
      const kind = conn?.kind ?? rec?.kind ?? prop?.kind ?? c.implied?.find((n) => n.id === id)?.kind;
      if (!kind) {
        issues.push(`capability ${safeSegment(id)} is required (by ${crit.map(safeSegment).join(', ')}) but no need says what kind it is`);
        continue;
      }
      needs.push({ id, kind, criteria: [...new Set(crit)], mockable: conn ? conn.mockable !== false : prop?.mockable ?? true });
    }
    if (issues.length) return { ok: false, issues };
    const draft: ContractDraft = { contract, needs };
    const more = contractDraftIssues(draft, c);
    return more.length ? { ok: false, issues: more } : { ok: true, draft };
  } catch (err) {
    return { ok: false, issues: [`contract assembly failed (${err instanceof Error ? err.name : 'error'})`] };
  }
}

/**
 * Why a drafted envelope may not go to sign-off (empty when it may, or when there is none): inside
 * repo.allowedChanges (the outer boundary stays the manifest's), off every protected path, and consistent
 * with the repository: a literal path that may only be modified or deleted exists, one that may only be
 * created does not. Shape is contracts envelopeProblem (already checked by contractProblem).
 */
export function envelopeDraftIssues(envelope: readonly ChangePath[] | undefined, c: Pick<DraftContext, 'allowedChanges' | 'protectedPaths' | 'fileExists'>): string[] {
  if (!envelope) return [];
  const issues: string[] = [];
  envelope.forEach((e, i) => {
    // A path is echoed only when it is short and made of plain path characters (it is model output).
    const p = /^[A-Za-z0-9_.*/-]{1,80}$/.test(e.path) ? `${i} (${e.path})` : String(i);
    const glob = e.path.includes('*');
    if (c.allowedChanges && !(glob ? c.allowedChanges.some((a) => globWithin(e.path, a)) : matchesAny(e.path, c.allowedChanges) !== null)) issues.push(`envelope path ${p} is outside repo.allowedChanges`);
    const prot = c.protectedPaths ? matchesProtected(e.path, c.protectedPaths) : null;
    if (prot) issues.push(`envelope path ${p} is a protected path`);
    if (glob || !c.fileExists) return;
    const exists = c.fileExists(e.path);
    if (!exists && !e.ops.includes('create')) issues.push(`envelope path ${p} allows only ${e.ops.join(' and ')} but does not exist in the repository; allow create, or name the existing file`);
    if (exists && e.ops.length === 1 && e.ops[0] === 'create') issues.push(`envelope path ${p} allows only create but already exists in the repository; allow modify`);
  });
  return issues;
}

/**
 * Why `draft` may not go to sign-off (empty when it may): contracts contractProblem, goal id and statement
 * as stamped, bounds, capability ids, commands that can fail, needs that match the criteria, a complete
 * secret scan, and every requestor criterion of the goal kept (requestorCriteriaIssues). Never throws.
 */
export function contractDraftIssues(draft: ContractDraft, c: Pick<DraftContext, 'goal' | 'statement' | 'redactor' | 'allowedChanges' | 'protectedPaths' | 'fileExists' | 'requireEnvelope'>): string[] {
  try {
    const issues: string[] = [];
    const k = draft?.contract;
    const problem = contractProblem(k);
    if (problem) return [problem];
    if (k.goalId !== c.goal.id) issues.push('contract names another goal');
    if (k.statement !== c.statement) issues.push("contract statement is not the requestor's statement");
    if (k.criteria.length > MAX_CRITERIA) issues.push(`contract has ${k.criteria.length} criteria; at most ${MAX_CRITERIA}`);
    if (k.outOfScope.length > MAX_CONTRACT_NOTES || k.assumptions.length > MAX_CONTRACT_NOTES) issues.push(`outOfScope and assumptions hold at most ${MAX_CONTRACT_NOTES} items each`);
    for (const x of [...k.outOfScope, ...k.assumptions]) if (x.length > MAX_NOTE_CHARS) issues.push(`an outOfScope or assumptions item is longer than ${MAX_NOTE_CHARS} characters`);
    if (c.requireEnvelope && !k.envelope?.length) issues.push('the contract states no change-path envelope: list every repository path the work may create, modify or delete (existing files with modify or delete, new files with create)');
    issues.push(...envelopeDraftIssues(k.envelope, c));
    for (const x of k.criteria) {
      const id = safeSegment(x.id);
      if (!CRITERION_ID_RE.test(x.id)) issues.push(`criterion ${id}: ids are at most 64 characters`);
      if (x.statement.length > MAX_STATEMENT_CHARS) issues.push(`criterion ${id}: statement is longer than ${MAX_STATEMENT_CHARS} characters`);
      for (const r of x.requires ?? []) if (!CAPABILITY_ID_RE.test(r)) issues.push(`criterion ${id}: requires ${safeSegment(r)} is not a capability id`);
      if (new Set(x.requires ?? []).size !== (x.requires ?? []).length) issues.push(`criterion ${id}: requires names a capability twice`);
      if (x.check.kind === 'command') {
        const cmd = x.check.command;
        if (cmd.length > MAX_COMMAND_CHARS) issues.push(`criterion ${id}: command is longer than ${MAX_COMMAND_CHARS} characters`);
        // eslint-disable-next-line no-control-regex
        if (/[\u0000-\u001f\u007f]/.test(cmd)) issues.push(`criterion ${id}: command must be one line without control characters`);
        if (commandAlwaysPasses(cmd)) issues.push(`criterion ${id}: command exits 0 whatever the repository holds; it checks nothing (the exit status must be the check's own: no "|| …", "| tail", "; echo" or "exit 0" around it)`);
        if (x.check.timeoutSec > MAX_CRITERION_TIMEOUT_SEC) issues.push(`criterion ${id}: timeout ${x.check.timeoutSec}s exceeds ${MAX_CRITERION_TIMEOUT_SEC}s`);
      } else if (x.check.prompt.length > MAX_STATEMENT_CHARS) {
        issues.push(`criterion ${id}: prompt is longer than ${MAX_STATEMENT_CHARS} characters`);
      }
    }
    const required = new Map<string, Set<string>>();
    for (const x of k.criteria) for (const r of x.requires ?? []) required.set(r, (required.get(r) ?? new Set()).add(x.id));
    const needs = Array.isArray(draft.needs) ? draft.needs : [];
    const named = new Set<string>();
    for (const n of needs) {
      if (named.has(n.id)) issues.push(`need ${safeSegment(n.id)} appears twice`);
      named.add(n.id);
      const by = required.get(n.id);
      if (!by) issues.push(`need ${safeSegment(n.id)} is required by no criterion`);
      else if (n.criteria.length !== by.size || n.criteria.some((x) => !by.has(x))) issues.push(`need ${safeSegment(n.id)} does not list exactly the criteria that require it`);
      if (typeof n.kind !== 'string' || !n.kind.trim() || n.kind.length > 64) issues.push(`need ${safeSegment(n.id)} has no kind`);
      if (typeof n.mockable !== 'boolean') issues.push(`need ${safeSegment(n.id)} does not say whether a stand-in may serve it`);
    }
    for (const r of required.keys()) if (!named.has(r)) issues.push(`capability ${safeSegment(r)} is required but has no need`);
    issues.push(...requestorCriteriaIssues(c.goal.criteria, k));
    const secret = deepSecretKind(draft as unknown as Json, c.redactor ?? patternRedactor());
    if (secret === UNSCANNABLE) issues.push('contract could not be completely scanned for secrets; refusing');
    else if (secret !== null) issues.push(`contract contains secret-shaped content (${secret}); a contract never carries secrets`);
    return [...new Set(issues)];
  } catch (err) {
    return [`contract validation failed (${err instanceof Error ? err.name : 'error'})`];
  }
}

/**
 * Why `contract` weakens the requestor's criteria (empty when it does not): a drafted or amended contract may
 * add criteria and may add capabilities a criterion requires, but every requestor criterion stays with the
 * same id, the same statement and exactly the same check. Never throws.
 */
export function requestorCriteriaIssues(requestor: readonly Criterion[] | undefined, contract: Pick<AcceptanceContract, 'criteria'>): string[] {
  if (!requestor || requestor.length === 0) return [];
  try {
    const issues: string[] = [];
    const byId = new Map((Array.isArray(contract?.criteria) ? contract.criteria : []).map((x) => [x.id, x]));
    for (const base of requestor) {
      const id = safeSegment(base.id);
      const got = byId.get(base.id);
      if (!got) {
        issues.push(`requestor criterion ${id} was dropped; a contract may add criteria, never remove one`);
        continue;
      }
      if (got.statement !== base.statement) issues.push(`requestor criterion ${id}: statement was changed`);
      if (canonicalJson(got.check as unknown as Json) !== canonicalJson(base.check as unknown as Json)) issues.push(`requestor criterion ${id}: check was changed or loosened`);
      const has = new Set(got.requires ?? []);
      if ((base.requires ?? []).some((r) => !has.has(r))) issues.push(`requestor criterion ${id}: a required capability was dropped`);
    }
    return issues;
  } catch {
    return ['requestor criteria could not be compared; refusing'];
  }
}

// ---------- plans against an accepted contract ----------

/** The criteria a gate.verify step declares it runs: `inputs.criteria` (null when it states none or not a list of ids). */
export function verifyStepCriteria(step: Plan['steps'][number]): string[] | null {
  const v = step.inputs && typeof step.inputs === 'object' ? (step.inputs as Record<string, unknown>)['criteria'] : undefined;
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
}

/** The contract a plan must answer to: the context's accepted contract, else the goal's own criteria. */
function boundContract(goal: AchievementGoal | undefined, ctx: PlanningContext | undefined): { hash: string; criteria: readonly Criterion[] } | { issue: string } | null {
  if (ctx?.contract) {
    const problem = contractProblem(ctx.contract);
    if (problem) return { issue: `the accepted contract is malformed (${problem}); refusing` };
    const hash = contractHash(ctx.contract);
    if (ctx.contractHash !== undefined && ctx.contractHash !== hash) return { issue: 'the planning context hash is not the accepted contract hash; refusing' };
    if (goal && goal.id !== ctx.contract.goalId) return { issue: 'the accepted contract names another goal; refusing' };
    return { hash, criteria: ctx.contract.criteria };
  }
  if (ctx?.contractHash !== undefined) return { issue: 'the planning context names a contract hash without the contract; refusing' };
  if (goal && (Array.isArray(goal.criteria) || goal.contractHash !== undefined)) {
    if (!Array.isArray(goal.criteria) || goal.criteria.length === 0 || typeof goal.contractHash !== 'string' || !goal.contractHash) return { issue: 'the goal carries an incomplete contract (criteria and contractHash go together); refusing' };
    // The goal's hash is never taken on trust: it must be the hash of the contract its own fields make (a goal
    // file's contract). One with out-of-scope items or assumptions, or an amended one, comes as ctx.contract.
    const own: AcceptanceContract = { goalId: goal.id, statement: goal.statement, criteria: goal.criteria, outOfScope: [], assumptions: [] };
    const problem = contractProblem(own);
    if (problem) return { issue: `the goal's contract is malformed (${problem}); refusing` };
    if (contractHash(own) !== goal.contractHash) return { issue: "the goal's contractHash is not the hash of its criteria; plan against the accepted contract (planning context)" };
    return { hash: goal.contractHash, criteria: goal.criteria };
  }
  return null;
}

function ancestorsOf(plan: Plan): Map<string, Set<string>> {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const memo = new Map<string, Set<string>>();
  const visit = (id: string, stack: Set<string>): Set<string> => {
    const hit = memo.get(id);
    if (hit) return hit;
    const out = new Set<string>();
    if (stack.has(id)) return out;
    stack.add(id);
    for (const d of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(d)) continue;
      out.add(d);
      for (const a of visit(d, stack)) out.add(a);
    }
    stack.delete(id);
    memo.set(id, out);
    return out;
  };
  for (const s of plan.steps) visit(s.id, new Set());
  return memo;
}

const NO_PROVISIONING: ProvisioningAllowance = { scope: 'none', kinds: [], maxResources: 0, ttlSec: 0 };

export interface ContractPlanOptions {
  goal?: AchievementGoal;
  /** Declared connections: their ids are known capabilities and their mockable feeds the gap ladder. */
  connections?: Manifest['connections'];
}

/**
 * Why `plan` does not answer to its contract (empty when it does, or when there is no contract and the plan
 * names no capability). The contract is `ctx.contract` (its hash must equal `ctx.contractHash` when given),
 * else the goal's own `criteria` + `contractHash` (the hash must be theirs). Refused: another or no
 * plan.contractHash; a command criterion no gate.verify after every worker step lists in `inputs.criteria`;
 * a last verify before the commit (through any gates between) that does not list every command criterion or
 * that a worker step the commit rests on runs after; a listed id that is not a command criterion; a
 * capability the contract requires missing from plan.capabilities; a capability nobody declared (not in the
 * inventory, a connection or a contract requirement); a capability the inventory does not show available,
 * provisioned or mocked whose gap resolves to `ask` (no inventory: none is available; no allowance: none
 * may be provisioned; each one provisioned counts against the allowance). Never throws.
 */
export function contractPlanIssues(plan: Plan, ctx: PlanningContext | undefined, o: ContractPlanOptions = {}): string[] {
  try {
    const issues: string[] = [];
    const bound = boundContract(o.goal, ctx);
    if (bound && 'issue' in bound) return [bound.issue];
    const caps = plan.capabilities;
    if (caps !== undefined && (!Array.isArray(caps) || caps.some((x) => typeof x !== 'string'))) return ['plan.capabilities must be a list of capability ids'];
    const named = new Set(caps ?? []);
    const required = new Set<string>();

    if (bound) {
      if (plan.contractHash === undefined) issues.push('plan carries no contractHash; a plan for an accepted contract records it');
      else if (plan.contractHash !== bound.hash) issues.push('plan was written for another contract (contractHash differs from the accepted one)');
      const commands = bound.criteria.filter((k) => k.check.kind === 'command').map((k) => k.id);
      const known = new Set(commands);
      const humans = new Set(bound.criteria.filter((k) => k.check.kind === 'human').map((k) => k.id));
      const anc = ancestorsOf(plan);
      const workers = plan.steps.filter((s) => s.kind === 'worker').map((s) => s.id);
      const covered = new Set<string>();
      for (const s of plan.steps) {
        if (s.kind !== 'gate.verify') continue;
        const raw = s.inputs && typeof s.inputs === 'object' ? (s.inputs as Record<string, unknown>)['criteria'] : undefined;
        const listed = verifyStepCriteria(s);
        if (raw !== undefined && listed === null) {
          issues.push(`verify step ${safeSegment(s.id)}: inputs.criteria must be a list of criterion ids`);
          continue;
        }
        for (const id of listed ?? []) {
          if (humans.has(id)) issues.push(`verify step ${safeSegment(s.id)} lists human criterion ${safeSegment(id)}; a human answers it at the PR hold`);
          else if (!known.has(id)) issues.push(`verify step ${safeSegment(s.id)} lists ${safeSegment(id)}, which is no criterion of the accepted contract`);
        }
        const afterWork = workers.every((w) => anc.get(s.id)?.has(w));
        if (afterWork) for (const id of listed ?? []) covered.add(id);
      }
      for (const id of commands) if (!covered.has(id)) issues.push(`command criterion ${safeSegment(id)} has no gate.verify after every worker step listing it in inputs.criteria`);
      // The verify the commit rests on: every last gate.verify among the commit's ancestors (one no other
      // verify ancestor of the commit follows), however many other gates lie between it and the commit.
      for (const c of plan.steps.filter((s) => s.kind === 'gate.commit')) {
        const before = anc.get(c.id) ?? new Set<string>();
        const verifies = plan.steps.filter((s) => s.kind === 'gate.verify' && before.has(s.id));
        if (verifies.length === 0 && commands.length) issues.push(`commit ${safeSegment(c.id)} rests on no gate.verify; one listing every command criterion must precede it`);
        const last = verifies.filter((v) => !verifies.some((o) => o.id !== v.id && anc.get(o.id)?.has(v.id)));
        for (const v of last) {
          const listed = new Set(verifyStepCriteria(v) ?? []);
          const miss = commands.filter((id) => !listed.has(id));
          if (miss.length) issues.push(`verify step ${safeSegment(v.id)} before commit ${safeSegment(c.id)} must list every command criterion (missing: ${miss.map(safeSegment).join(', ')})`);
          const late = workers.filter((w) => before.has(w) && !anc.get(v.id)?.has(w));
          if (late.length) issues.push(`worker step(s) ${late.map(safeSegment).join(', ')} run after verify step ${safeSegment(v.id)}, the last before commit ${safeSegment(c.id)}; the commit must rest on a verify of all the work`);
        }
      }
      for (const k of bound.criteria) for (const r of k.requires ?? []) required.add(r);
      for (const r of required) if (!named.has(r)) issues.push(`plan.capabilities omits ${safeSegment(r)}, which criteria of the accepted contract require`);
    }

    if (named.size > 0) {
      const inv = new Map((ctx?.inventory ?? []).map((r) => [r.id, r]));
      const conns = o.connections ?? {};
      const declared = (id: string) => inv.has(id) || Object.prototype.hasOwnProperty.call(conns, id) || required.has(id);
      // Without an allowance nothing may be provisioned; without an inventory nothing is known available.
      // Each capability the ladder provisions counts against the allowance for the next one.
      const allowance = ctx?.allowance ?? NO_PROVISIONING;
      let provisioned = typeof ctx?.provisionedSoFar === 'number' ? ctx.provisionedSoFar : 0;
      for (const id of [...named].sort()) {
        if (!CAPABILITY_ID_RE.test(id)) {
          issues.push(`plan.capabilities: ${safeSegment(id)} is not a capability id`);
          continue;
        }
        if (!declared(id)) {
          issues.push(`plan uses capability ${safeSegment(id)}, which no connection, inventory row or contract requirement declares`);
          continue;
        }
        const rec = inv.get(id);
        if (rec && rec.state !== 'missing') continue;
        const conn = Object.prototype.hasOwnProperty.call(conns, id) ? conns[id] : undefined;
        const kind = rec?.kind ?? conn?.kind ?? '';
        const gap = resolveGap({ kind, available: false, mockable: conn ? conn.mockable !== false : true }, allowance, provisioned);
        if (gap === 'provision') provisioned++;
        if (gap === 'ask') issues.push(`capability ${safeSegment(id)} is missing and can be neither provisioned nor mocked; the requestor must provide it`);
      }
    }
    return [...new Set(issues)];
  } catch (err) {
    return [`contract check failed (${err instanceof Error ? err.name : 'error'}); refusing`];
  }
}

/** The capabilities a plan for `ctx` records: its own plus every one the accepted contract requires, sorted. */
export function planCapabilities(own: readonly string[] | undefined, ctx: PlanningContext | undefined, goal?: AchievementGoal): string[] | undefined {
  const criteria = ctx?.contract?.criteria ?? goal?.criteria ?? [];
  const all = new Set(own ?? []);
  for (const k of criteria) for (const r of k.requires ?? []) all.add(r);
  if (own === undefined && all.size === 0 && !ctx?.contract && !goal?.criteria) return undefined;
  return [...all].sort();
}

/** The contract hash a plan for `ctx` (or for a goal that carries its own criteria) records; undefined without one. */
export function planContractHash(ctx: PlanningContext | undefined, goal?: AchievementGoal): string | undefined {
  if (ctx?.contract) return contractHash(ctx.contract);
  if (ctx?.contractHash !== undefined) return ctx.contractHash;
  return goal?.contractHash;
}
