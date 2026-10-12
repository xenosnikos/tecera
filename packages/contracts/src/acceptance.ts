import { canonicalJson, sha256, type Json } from './json.js';

/**
 * Acceptance contracts, the capability inventory and provisioning.
 *
 * A request becomes an acceptance contract (criteria, each with its own check) that the requestor accepts
 * before work starts. The capabilities the criteria need are inventoried; a missing one is provisioned in
 * Tecera's own space, mocked behind the broker, or asked for (resolveGap). Every criterion proof records
 * how it was met (Fidelity); a goal resting on a mock is never `achieved`, only `goal.provisional`.
 */

export type CriterionCheck =
  /** Runs in the verify gate against the final candidate; exit 0 passes. */
  | { kind: 'command'; command: string; timeoutSec: number }
  /** A named human judgment, answered by an approver who is not the requester. */
  | { kind: 'human'; prompt: string };

export interface Criterion {
  id: string;
  statement: string;
  check: CriterionCheck;
  /** Capability ids (manifest `connections` keys, or needs the planner names) this criterion depends on. */
  requires?: string[];
}

/** What may happen to a path: it is created (absent on the base), modified, or deleted (present on the base). */
export type ChangeOp = 'create' | 'modify' | 'delete';

export const CHANGE_OPS: readonly ChangeOp[] = ['create', 'modify', 'delete'];

/**
 * One entry of a change-path envelope: a repository-relative path, or a narrow glob (`*` within a segment,
 * `**` across segments; its first segment is always literal), and the operations allowed on what it matches.
 */
export interface ChangePath {
  path: string;
  ops: ChangeOp[];
}

export interface AcceptanceContract {
  goalId: string;
  statement: string;
  criteria: Criterion[];
  outOfScope: string[];
  assumptions: string[];
  /**
   * The change-path envelope the requestor signs off with the criteria: the only paths the delivered change
   * may create, modify or delete. It is part of the contract hash, so only an amendment can widen it. Absent
   * = no envelope was stated: the manifest's repo.allowedChanges is the envelope, with every operation, and
   * the hash is the one the contract had before envelopes existed.
   */
  envelope?: ChangePath[];
}

const ID = /^[a-z0-9][a-z0-9_-]*$/;

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0);
}

/**
 * Why `v` is not a change-path envelope (null when it is): a non-empty list of {path, ops}; every path
 * repository-relative with forward slashes, no `.` or `..` segment, no control character, at most 400
 * characters, a literal first segment (so `**` or `*.js` alone, which would cover the whole repository, is
 * refused); every ops list a non-empty set of create / modify / delete; no path listed twice.
 */
export function envelopeProblem(v: unknown): string | null {
  if (!Array.isArray(v)) return 'the envelope must be a list of {path, ops}';
  if (v.length === 0) return 'the envelope lists no path (omit it to use repo.allowedChanges)';
  if (v.length > 200) return 'the envelope lists more than 200 paths';
  const seen = new Set<string>();
  for (const raw of v as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'an envelope entry is not an object';
    const e = raw as Record<string, unknown>;
    const extra = Object.keys(e).filter((k) => k !== 'path' && k !== 'ops');
    if (extra.length) return `an envelope entry has an unknown field ${extra[0]}`;
    const p = e.path;
    if (typeof p !== 'string' || !p) return 'an envelope entry names no path';
    if (p.length > 400) return 'an envelope path is too long';
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f\\]/.test(p)) return `envelope path ${JSON.stringify(p)} carries a control character or a backslash`;
    if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return `envelope path ${p} is not repository-relative`;
    const segs = p.split('/');
    if (segs.some((x) => x === '' || x === '.' || x === '..')) return `envelope path ${p} is not normalized`;
    if (/[*?[\]{}]/.test(segs[0]!)) return `envelope path ${p} starts with a wildcard: name at least its first directory or file`;
    if (/[?[\]{}]/.test(p)) return `envelope path ${p} uses a wildcard other than * and **`;
    if (segs.some((x) => x.includes('**') && x !== '**')) return `envelope path ${p} uses ** inside a segment`;
    if (seen.has(p)) return `envelope path ${p} is listed twice`;
    seen.add(p);
    const ops = e.ops;
    if (!Array.isArray(ops) || ops.length === 0) return `envelope path ${p} allows no operation`;
    if (ops.some((o) => !CHANGE_OPS.includes(o as ChangeOp))) return `envelope path ${p} names an unknown operation`;
    if (new Set(ops).size !== ops.length) return `envelope path ${p} names an operation twice`;
  }
  return null;
}

/** The envelope in the order the hash uses: entries by path, operations in create / modify / delete order. */
export function canonicalEnvelope(list: readonly ChangePath[]): ChangePath[] {
  return [...list].map((e) => ({ path: e.path, ops: CHANGE_OPS.filter((o) => e.ops.includes(o)) })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Why `c` is not a well-formed acceptance contract (null when it is). Shape only. */
export function contractProblem(c: unknown): string | null {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 'no acceptance contract';
  const o = c as Record<string, unknown>;
  if (typeof o.goalId !== 'string' || !o.goalId) return 'contract names no goal';
  if (typeof o.statement !== 'string' || !o.statement.trim()) return 'contract has no statement';
  if (!Array.isArray(o.criteria) || o.criteria.length === 0) return 'contract has no criteria';
  if (!isStringList(o.outOfScope ?? [])) return 'outOfScope must be a list of strings';
  if (!isStringList(o.assumptions ?? [])) return 'assumptions must be a list of strings';
  if (o.envelope !== undefined) {
    const env = envelopeProblem(o.envelope);
    if (env) return env;
  }
  const seen = new Set<string>();
  let commands = 0;
  for (const raw of o.criteria as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'criterion is not an object';
    const k = raw as Record<string, unknown>;
    if (typeof k.id !== 'string' || !ID.test(k.id)) return `criterion id ${JSON.stringify(k.id ?? null)} is not an id`;
    if (seen.has(k.id)) return `criterion ${k.id} appears twice`;
    seen.add(k.id);
    if (typeof k.statement !== 'string' || !k.statement.trim()) return `criterion ${k.id} has no statement`;
    if (k.requires !== undefined && !isStringList(k.requires)) return `criterion ${k.id}: requires must be a list of capability ids`;
    const chk = k.check as Record<string, unknown> | undefined;
    if (!chk || typeof chk !== 'object') return `criterion ${k.id} has no check`;
    if (chk.kind === 'command') {
      if (typeof chk.command !== 'string' || !chk.command.trim()) return `criterion ${k.id} names no check command`;
      if (typeof chk.timeoutSec !== 'number' || !Number.isInteger(chk.timeoutSec) || chk.timeoutSec <= 0) return `criterion ${k.id} has no check timeout`;
      commands++;
    } else if (chk.kind === 'human') {
      if (typeof chk.prompt !== 'string' || !chk.prompt.trim()) return `criterion ${k.id} asks the human nothing`;
    } else {
      return `criterion ${k.id} has an unknown check kind`;
    }
  }
  // Done is always an environmental check: a contract of human judgments alone cannot prove anything.
  if (commands === 0) return 'contract needs at least one command criterion';
  return null;
}

/** Stable hash of a contract. Acceptance, plans and proofs bind to it; any edit changes it. */
export function contractHash(c: AcceptanceContract): string {
  const norm = {
    goalId: c.goalId,
    statement: c.statement,
    criteria: c.criteria.map((k) => ({ id: k.id, statement: k.statement, check: k.check, requires: [...(k.requires ?? [])].sort() })),
    outOfScope: c.outOfScope,
    assumptions: c.assumptions,
    // Only a stated envelope is hashed: a contract without one keeps the hash it always had.
    ...(c.envelope !== undefined ? { envelope: canonicalEnvelope(c.envelope) } : {}),
  };
  return sha256(canonicalJson(norm as unknown as Json));
}

/** How a criterion was met: against the real capability, one Tecera provisioned, or a stand-in. */
export type Fidelity = 'real' | 'provisioned' | 'mocked';

const FIDELITY_RANK: Record<Fidelity, number> = { real: 0, provisioned: 1, mocked: 2 };

export function isFidelity(v: unknown): v is Fidelity {
  return v === 'real' || v === 'provisioned' || v === 'mocked';
}

/** The weakest fidelity in the list ('real' for an empty list). */
export function weakestFidelity(list: readonly Fidelity[]): Fidelity {
  return list.reduce<Fidelity>((w, f) => (FIDELITY_RANK[f] > FIDELITY_RANK[w] ? f : w), 'real');
}

export interface CriterionProof {
  criterionId: string;
  fidelity: Fidelity;
  via: 'command' | 'human';
  /** via 'command': the criterion's command, which exited 0 on `fingerprint`. */
  command?: string;
  exitCode?: 0;
  fingerprint?: string;
  /** via 'human': who judged it. */
  approver?: string;
  /** The verify evidence record (command) or the consumed approval (human) behind this proof. */
  evidenceKey: string;
  verifiedAt: number;
}

/**
 * Why `proofs` do not prove `contract` (null when they do): one proof per criterion, no strays, command
 * proofs ran the criterion's own command to exit 0. Shape only; the ledger decides whether the evidence exists.
 */
export function criteriaProofProblem(contract: AcceptanceContract, proofs: unknown): string | null {
  if (!Array.isArray(proofs)) return 'no criterion proofs';
  const byId = new Map<string, Record<string, unknown>>();
  for (const raw of proofs as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'criterion proof is not an object';
    const p = raw as Record<string, unknown>;
    if (typeof p.criterionId !== 'string') return 'criterion proof names no criterion';
    if (byId.has(p.criterionId)) return `criterion ${p.criterionId} is proven twice`;
    byId.set(p.criterionId, p);
  }
  for (const k of contract.criteria) {
    const p = byId.get(k.id);
    if (!p) return `criterion ${k.id} has no proof`;
    byId.delete(k.id);
    if (!isFidelity(p.fidelity)) return `criterion ${k.id}: proof records no fidelity`;
    if (typeof p.evidenceKey !== 'string' || !p.evidenceKey) return `criterion ${k.id}: proof names no evidence`;
    if (typeof p.verifiedAt !== 'number' || !Number.isFinite(p.verifiedAt)) return `criterion ${k.id}: proof has no verification time`;
    if (p.via !== k.check.kind) return `criterion ${k.id}: proven by ${JSON.stringify(p.via ?? null)}, the contract says ${k.check.kind}`;
    if (k.check.kind === 'command') {
      if (p.command !== k.check.command) return `criterion ${k.id}: proof ran another command than the criterion's`;
      if (p.exitCode !== 0) return `criterion ${k.id}: proof records exit ${JSON.stringify(p.exitCode ?? null)}, not 0`;
      if (typeof p.fingerprint !== 'string' || !p.fingerprint) return `criterion ${k.id}: proof names no candidate fingerprint`;
    } else if (typeof p.approver !== 'string' || !p.approver) {
      return `criterion ${k.id}: proof names no approver`;
    }
  }
  const stray = [...byId.keys()];
  if (stray.length) return `proof for unknown criterion ${stray[0]}`;
  return null;
}

// ── capabilities ────────────────────────────────────────────────────────────────────────────────────

export type CapabilityState = 'available' | 'provisioned' | 'mocked' | 'missing';

/** One row of the inventory: a capability a contract needs and what stands behind it in this run. */
export interface CapabilityRecord {
  id: string;
  kind: string;
  state: CapabilityState;
  /** The probe that established `available` (a command and its exit code), when one ran. */
  probe?: { command: string; exitCode: number };
  /** The provisioned resource or mock standing in for it. */
  resourceId?: string;
}

/** The fidelity a criterion can claim given the capabilities it requires. 'missing' cannot be proven at all. */
export function fidelityOf(states: readonly CapabilityState[]): Fidelity | null {
  if (states.includes('missing')) return null;
  return weakestFidelity(states.map((s) => (s === 'available' ? 'real' : s === 'provisioned' ? 'provisioned' : 'mocked')));
}

/** What the manifest lets Tecera create in its own space without asking. */
export interface ProvisioningAllowance {
  scope: 'none' | 'local';
  kinds: readonly string[];
  maxResources: number;
  ttlSec: number;
}

export type GapResolution = 'use' | 'provision' | 'mock' | 'ask';

/**
 * The gap ladder: use the real capability; else provision one inside the allowance; else mock it when the
 * connection allows a stand-in; else ask the requestor. Pure, so the planner, the validator and the
 * benchmark all agree on what should have happened.
 */
export function resolveGap(
  need: { kind: string; available: boolean; mockable: boolean },
  allowance: ProvisioningAllowance,
  provisionedSoFar: number,
): GapResolution {
  if (need.available) return 'use';
  if (allowance.scope === 'local' && allowance.kinds.includes(need.kind) && provisionedSoFar < allowance.maxResources) return 'provision';
  if (need.mockable) return 'mock';
  return 'ask';
}

// ── drafting and sign-off ───────────────────────────────────────────────────────────────────────────

/** A capability a drafted contract needs, named by the planner: which criteria rest on it and whether a stand-in may serve it. */
export interface CapabilityNeed {
  /** Capability id: a manifest `connections` key, or a new id the planner names for something undeclared. */
  id: string;
  kind: string;
  /** Ids of the criteria whose `requires` name it. */
  criteria: string[];
  /** A stand-in may serve it (the connection's `mockable`; true for an undeclared need unless the planner says otherwise). */
  mockable: boolean;
}

/** What the planner returns for a statement: the contract to sign off and the capabilities it needs. */
export interface ContractDraft {
  contract: AcceptanceContract;
  needs: CapabilityNeed[];
}

/** The approval action of a criteria sign-off. Same grant rules as every approval: a human, not the requester, one use, expiry. */
export const ACCEPT_CRITERIA_ACTION = 'accept_criteria';

/**
 * The action hash a criteria sign-off is requested under and consumed with:
 * sha256(canonicalJson({action: 'accept_criteria', goalId, runId, contractHash})). A grant accepts exactly
 * one contract of one goal in one run; any edit to the contract changes contractHash and needs a new grant.
 */
export function acceptCriteriaActionHash(a: { goalId: string; runId: string; contractHash: string }): string {
  return sha256(canonicalJson({ action: ACCEPT_CRITERIA_ACTION, goalId: a.goalId, runId: a.runId, contractHash: a.contractHash }));
}

/**
 * Trace of the sign-off approval events (approval.* require a goal, an intention and a step; sign-off
 * happens before any intention exists): intention `signoff:<goalId>`, step `accept_criteria`.
 */
export function signoffTrace(goalId: string): { goalId: string; intentionId: string; stepId: string } {
  return { goalId, intentionId: `signoff:${goalId}`, stepId: ACCEPT_CRITERIA_ACTION };
}

/** The approval action of a human criterion answer. Same grant rules: a human, not the requester, one use, expiry. */
export const ANSWER_CRITERION_ACTION = 'answer_criterion';

/**
 * The action hash a human criterion is asked under (one approval per criterion, at the PR hold):
 * sha256(canonicalJson({action: 'answer_criterion', goalId, runId, contractHash, criterionId, fingerprint})).
 * A grant answers 'yes' for exactly that criterion of that contract on that candidate; a denial is 'no'.
 * No other approval (the PR's, a sign-off) can stand in for it.
 */
export function answerCriterionActionHash(a: { goalId: string; runId: string; contractHash: string; criterionId: string; fingerprint: string }): string {
  return sha256(canonicalJson({ action: ANSWER_CRITERION_ACTION, goalId: a.goalId, runId: a.runId, contractHash: a.contractHash, criterionId: a.criterionId, fingerprint: a.fingerprint }));
}

/** A human criterion answered at the PR hold. `requestId` is the answer_criterion approval whose grant (yes) or denial (no) is the answer. */
export interface HumanCriterionAnswer {
  criterionId: string;
  approver: { kind: 'human'; id: string };
  verdict: 'yes' | 'no';
  requestId: string;
  answeredAt: number;
  note?: string;
}

/**
 * Evidence key a verify gate records one command criterion under:
 * `verify:<runId>:criterion:<criterionId>:<fingerprint>`. The record is kind 'gate.verify' with body
 * {criterionId, command, commandDigest (verifyCommandDigest), timeoutSec, exitCode, outcome, fingerprint, runId}.
 */
export function criterionEvidenceKey(runId: string, criterionId: string, fingerprint: string): string {
  return `verify:${runId}:criterion:${criterionId}:${fingerprint}`;
}

// ── provisioned resources ───────────────────────────────────────────────────────────────────────────

export type TransferState = 'pending' | 'transferred' | 'released';

/**
 * Something Tecera created to get the work done. It is a recorded debt: it carries its teardown command
 * and stays `pending` until a human takes it over (`transferred`) or it is torn down (`released`).
 */
export interface ProvisionedResource {
  id: string;
  capability: string;
  kind: string;
  provider: 'local';
  /** Where it lives (a path, a loopback URL); never a credential. */
  locator: string;
  teardown: string;
  createdAt: number;
  expiresAt: number;
  transfer: TransferState;
  /** The goal and run it was provisioned for (the registry fills them from the event when absent). */
  goalId?: string;
  runId?: string;
}

/**
 * Credential shapes a locator may never carry, anywhere in it (no anchoring, so a prefix, a missing scheme or
 * leading space does not hide one): userinfo (`//user@`, `user:pass@`), a secret-named `name=` pair, auth
 * schemes, canaries, token prefixes.
 */
const CREDENTIAL_SHAPES: ReadonlyArray<[RegExp, string]> = [
  [/\/\/[^/\s?#]*@/, 'carries userinfo'],
  [/[^\s/@:?#&;=]+:[^\s/@?#]*@/, 'carries userinfo'],
  [/(?:token|secret|password|passwd|pwd|pass|key|sig|signature|auth|credential|cookie|session)[a-z0-9_-]*\s*=/i, 'carries a secret-named parameter'],
  [/\b(?:bearer|basic)\s+[a-z0-9._~+/-]+=*/i, 'carries an authorization value'],
  [/TECERA_CANARY_/i, 'carries a canary'],
  [/(?:^|[^a-z0-9])(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abpr])[-_][a-z0-9_-]{8,}/i, 'carries a token'],
];

/** One round of percent-decoding; a malformed escape leaves only that escape undecoded. */
function decodeOnce(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
  }
}

/**
 * The value as written and every percent-decoded form of it, decoded again until it stops changing (a
 * credential may be encoded any number of times, or sit next to a malformed escape). Every round that
 * changes the value shortens it, so the fixed point is always reached.
 */
function decodedForms(value: string): string[] {
  const forms = [value];
  let cur = value;
  for (;;) {
    const next = decodeOnce(cur);
    if (next === cur || next.length >= cur.length) break;
    forms.push(next);
    cur = next;
  }
  return forms;
}

/** Why `value` (a locator or a teardown) carries a credential (null when it does not), in any encoding. */
export function credentialProblem(value: string, what: string, secrets?: (value: string) => boolean): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return `${what} carries control characters`;
  const forms = decodedForms(value);
  for (const form of forms) for (const [re, why] of CREDENTIAL_SHAPES) if (re.test(form)) return `${what} ${why}`;
  if (secrets && forms.some((f) => secrets(f))) return `${what} carries a known secret`;
  return null;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '[::1]']);

/** A local location: an absolute path (never `//`, a network path) or a URL whose host is loopback. */
function isLocalLocation(locator: string): boolean {
  if (/^\/(?!\/)/.test(locator)) return true;
  let u: URL;
  try {
    u = new URL(locator);
  } catch {
    return false;
  }
  if (u.protocol === 'file:') return u.hostname === '' || u.hostname === 'localhost';
  return LOOPBACK_HOSTS.has(u.hostname) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(u.hostname);
}

/**
 * Why `locator` is not a plain location (null when it is): a resource locator is an absolute path or a
 * loopback URL, never a credential nor a place outside this host. Control characters are refused; every
 * credential shape is checked in the literal and every percent-decoded form (decoded to a fixed point).
 * `secrets`, when given, are values that must not appear in any encoding (containsSecret).
 */
export function locatorProblem(locator: unknown, secrets?: (value: string) => boolean): string | null {
  if (typeof locator !== 'string' || !locator.trim()) return 'resource has no locator';
  const cred = credentialProblem(locator, 'resource locator', secrets);
  if (cred) return cred;
  if (!isLocalLocation(locator)) return 'resource locator is neither an absolute path nor a loopback URL';
  return null;
}

/**
 * Why `r` is not a recordable provisioned resource (null when it is): every field present, provider local,
 * a teardown command, an expiry after creation, a locator that is no credential, no known secret in the
 * locator or the teardown, transfer 'pending' at creation and, when an allowance is given, its scope, kind
 * and lifetime inside it.
 */
export function resourceProblem(r: unknown, allowance?: ProvisioningAllowance, secrets?: (value: string) => boolean): string | null {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'no resource';
  const o = r as Record<string, unknown>;
  for (const f of ['id', 'capability', 'kind'] as const) if (typeof o[f] !== 'string' || !o[f]) return `resource has no ${f}`;
  if (o.provider !== 'local') return `resource provider ${JSON.stringify(o.provider ?? null)} is not local`;
  if (typeof o.teardown !== 'string' || !o.teardown.trim()) return `resource ${String(o.id)} has no teardown`;
  if (typeof o.createdAt !== 'number' || !Number.isFinite(o.createdAt)) return `resource ${String(o.id)} has no creation time`;
  if (typeof o.expiresAt !== 'number' || !Number.isFinite(o.expiresAt) || o.expiresAt <= o.createdAt) return `resource ${String(o.id)} has no expiry after its creation`;
  if (o.transfer !== 'pending') return `resource ${String(o.id)} is recorded as ${JSON.stringify(o.transfer ?? null)}, not pending`;
  const loc = locatorProblem(o.locator, secrets);
  if (loc) return `resource ${String(o.id)}: ${loc}`;
  // The teardown is recorded and listed on the PR like the locator: no credential, no known secret, in any encoding.
  const tear = credentialProblem(o.teardown, 'its teardown', secrets);
  if (tear) return `resource ${String(o.id)}: ${tear}`;
  if (allowance) {
    if (allowance.scope !== 'local') return `provisioning scope is ${allowance.scope}: nothing may be provisioned`;
    if (!allowance.kinds.includes(o.kind as string)) return `resource kind ${String(o.kind)} is outside the allowance`;
    if (o.expiresAt - o.createdAt > allowance.ttlSec * 1000) return `resource ${String(o.id)} lives longer than the allowance (${allowance.ttlSec}s)`;
  }
  return null;
}

/** Probes a declared connection for real. Implemented by the runtime; never by a model. */
export interface CapabilityProbe {
  probe(id: string): Promise<CapabilityRecord>;
}

/** Creates, lists and tears down resources in Tecera's own space, inside the allowance. */
export interface Provisioner {
  kinds(): readonly string[];
  provision(need: { capability: string; kind: string; goalId: string }): Promise<ProvisionedResource>;
  release(resourceId: string): Promise<void>;
  list(): Promise<ProvisionedResource[]>;
}
