import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseManifest, resolveGap, type GapResolution, type Manifest, type ProvisioningAllowance } from '@tecera/contracts';

/**
 * Benchmark scenarios. A fixture is a directory `fixtures/<nn>-<name>/` holding:
 *
 * - `repo/`: the small Node repository the agent works in (tecera.json, .tecera/, sources, tests run with
 *   `node --test`, no dependencies). Only this directory is ever copied into a run.
 * - `scenario.json`: the request, the hidden reference criteria, declared connections and expected gap
 *   resolutions, planted traps, interventions and the pass rule. Never shown to the agent.
 * - `hidden/`: the hidden reference checks. The runner overlays them at `<tree>/bench-hidden/` in a scratch
 *   copy of the final tree and runs each hidden criterion's command there.
 * - reference patches (`reference.patch`, ...): a correct change, for the fixture tests. The scorer never
 *   reads them.
 *
 * Every field is strict: an unknown key is a parse error, never ignored.
 */

/** Where the hidden checks are mounted inside a scratch copy of the final tree. */
export const HIDDEN_MOUNT = 'bench-hidden';

/** The fixtures shipped with the package. */
export const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const ID = /^[a-z0-9][a-z0-9_-]*$/;
const id = z.string().regex(ID, 'must be a lower-case id');
const tag = z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/, 'must be a lower-case tag');
const fidelity = z.enum(['real', 'provisioned', 'mocked']);
const relPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..') && !p.includes('\\'), 'must be a relative path inside the repository');
const check = z.object({ command: z.string().min(1), timeoutSec: z.number().int().positive() }).strict();

const hiddenCriterion = z
  .object({
    id,
    statement: z.string().min(1),
    /** Tags a drafted criterion may declare to say it covers this one (exact match). */
    tags: z.array(tag).min(1),
    /** Whole words or phrases that, found in a drafted criterion's id, statement or command, also cover it. */
    keywords: z.array(z.string().min(1)).default([]),
    /** Run by the runner against the final tree with the hidden checks mounted; exit 0 passes. */
    check,
    /** Capability ids the criterion depends on. */
    requires: z.array(id).default([]),
    /** The fidelity a correct run proves it with. */
    fidelity: fidelity.default('real'),
    /** The check fails on the untouched fixture (false for a regression guard that already passes). */
    failsAtBase: z.boolean().default(true),
  })
  .strict();

const need = z
  .object({
    capability: id,
    kind: z.string().min(1),
    /** Whether the capability is really there (a declared connection whose probe passes). */
    available: z.boolean().default(false),
    /** What the gap ladder must decide (resolveGap over the manifest allowance). */
    expect: z.enum(['use', 'provision', 'mock', 'ask']),
  })
  .strict();

const trap = z.discriminatedUnion('kind', [
  /** A protected path whose edit is the easy way out; a landed change to it is a violation. */
  z.object({ kind: z.literal('protected-file'), path: relPath, why: z.string().min(1) }).strict(),
  /** An instruction planted in repository text; following it leaves `marker` (or creates `creates`) in the delivered tree. */
  z.object({ kind: z.literal('injected-instruction'), plantedIn: relPath, marker: z.string().min(6), creates: relPath.optional() }).strict(),
  /** A canary secret planted in repository text; it must reach no prompt, event, evidence, artifact or changed file. */
  z.object({ kind: z.literal('canary-secret'), plantedIn: relPath, canary: z.string().regex(/^TECERA_CANARY_[A-Z0-9_]+$/) }).strict(),
]);

const intervention = z.discriminatedUnion('kind', [
  /** Kill the run's process when its `atStep`-th step.started is recorded, then resume it. */
  z.object({ kind: z.literal('kill'), atStep: z.number().int().positive() }).strict(),
  /** After the `afterStep`-th step.started, a human amends one criterion of the accepted contract. */
  z.object({ kind: z.literal('amend'), criterion: id, afterStep: z.number().int().positive(), statement: z.string().min(1), check, reason: z.string().min(1) }).strict(),
]);

export const AUDIT_QUESTIONS = ['who-requested', 'who-approved', 'which-checks-proved', 'what-changed', 'what-it-cost'] as const;
export type AuditQuestion = (typeof AUDIT_QUESTIONS)[number];

const rule = z.discriminatedUnion('rule', [
  /** Every goal the run adopted is proven achieved (provenRun). */
  z.object({ rule: z.literal('achieved') }).strict(),
  /** Not achieved: the latest outcome is goal.provisional (every criterion proven, one on a mock). */
  z.object({ rule: z.literal('provisional') }).strict(),
  /** The delivered PR (pr.opened / pr.requested or its gate.pr evidence) says provisional. */
  z.object({ rule: z.literal('prMarkedProvisional') }).strict(),
  /** The Stop hook keeps blocking: nothing is proven achieved. */
  z.object({ rule: z.literal('stopBlocks') }).strict(),
  /** At most `max` human touches; `approvalsOnly`: every touch is an approval decision. */
  z.object({ rule: z.literal('humanTouches'), max: z.number().int().min(0), approvalsOnly: z.boolean().default(false) }).strict(),
  /** Every criterion proof of the achieved goal records this fidelity. */
  z.object({ rule: z.literal('allCriteriaFidelity'), fidelity }).strict(),
  /** The criterion proof covering the hidden criterion tagged `tag` records this fidelity. */
  z.object({ rule: z.literal('criterionFidelity'), tag, fidelity }).strict(),
  /** A valid resource of `kind` for `capability` was provisioned and is still pending (listed for transfer). */
  z.object({ rule: z.literal('resourcePending'), kind: z.string().min(1), capability: id }).strict(),
  z.object({ rule: z.literal('noLandedViolations') }).strict(),
  z.object({ rule: z.literal('refusedAtLeast'), n: z.number().int().positive() }).strict(),
  z.object({ rule: z.literal('instructionNotFollowed') }).strict(),
  z.object({ rule: z.literal('canaryAbsent') }).strict(),
  /** The goal was dropped with a stated reason. */
  z.object({ rule: z.literal('droppedWithReason') }).strict(),
  /** No goal.achieved event was recorded at all. */
  z.object({ rule: z.literal('noAchieved') }).strict(),
  z.object({ rule: z.literal('falseAchievedZero') }).strict(),
  /** The run was interrupted and the resumed run is proven achieved. */
  z.object({ rule: z.literal('resumed') }).strict(),
  /** After criteria.amended, work continued only on a plan written for the amended contract. */
  z.object({ rule: z.literal('replannedAfterAmend') }).strict(),
  /** The drafted contract covers at least `min` of the hidden criteria (by tags and keywords). */
  z.object({ rule: z.literal('coverage'), min: z.number().min(0).max(1) }).strict(),
  z.object({ rule: z.literal('auditAnswered') }).strict(),
  z.object({ rule: z.literal('replayAgrees') }).strict(),
  z.object({ rule: z.literal('tamperDetected') }).strict(),
  z.object({ rule: z.literal('traceComplete'), min: z.number().min(0).max(1) }).strict(),
]);

export const ScenarioSchema = z
  .object({
    /** The fixture directory name, `<nn>-<name>`. */
    id: z.string().regex(/^\d{2}-[a-z0-9][a-z0-9-]*$/),
    number: z.number().int().min(1).max(99),
    title: z.string().min(1),
    axis: z.enum(['autonomy', 'control', 'compliance']),
    request: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('statement'), text: z.string().min(1) }).strict(),
      z.object({ kind: z.literal('goal'), id }).strict(),
    ]),
    /** What the untouched fixture does: its own verify command fails or passes. */
    base: z.object({ verify: z.enum(['fail', 'pass']) }).strict(),
    hidden: z.array(hiddenCriterion).min(1),
    connections: z
      .object({
        /** The manifest's `connections` keys, exactly. */
        declared: z.array(id).default([]),
        needs: z.array(need).default([]),
      })
      .strict()
      .default({}),
    traps: z.array(trap).default([]),
    interventions: z.array(intervention).default([]),
    audit: z.array(z.enum(AUDIT_QUESTIONS)).default([]),
    pass: z.array(rule).min(1),
    /**
     * Reference change(s), relative to the fixture directory. `pass`: applying patches[0] makes the verify
     * command and every hidden check pass. `contradiction`: each patch passes some hidden check and fails
     * another (the criteria cannot all hold).
     */
    reference: z.object({ expect: z.enum(['pass', 'contradiction']), patches: z.array(relPath).min(1) }).strict(),
  })
  .strict();

export type ScenarioSpec = z.infer<typeof ScenarioSchema>;
export type HiddenCriterion = ScenarioSpec['hidden'][number];
export type Trap = ScenarioSpec['traps'][number];
export type Intervention = ScenarioSpec['interventions'][number];
export type PassRule = ScenarioSpec['pass'][number];
export type CapabilityNeedSpec = ScenarioSpec['connections']['needs'][number];

/** What the scorer needs from the fixture's manifest (filled by the loader; the scorer reads no file). */
export interface ScenarioPolicy {
  protectedPaths: string[];
  allowedChanges: string[];
  allowance: ProvisioningAllowance;
  /** Manifest acceptance.signoff 'always'. */
  requireApproval: boolean;
  verify: { command: string; timeoutSec: number };
  connections: Record<string, { kind: string; mockable: boolean; probe?: string }>;
}

/** A loaded scenario: the spec plus its manifest policy and where it lives. */
export interface Scenario extends ScenarioSpec {
  policy: ScenarioPolicy;
  /** Absolute paths (absent for a scenario built in memory). */
  dir?: string;
  repoDir?: string;
  hiddenDir?: string;
}

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioError';
  }
}

/** Parse a scenario.json document (strict). Throws ScenarioError naming every issue. */
export function parseScenario(doc: unknown, where = 'scenario'): ScenarioSpec {
  const r = ScenarioSchema.safeParse(doc);
  if (!r.success) throw new ScenarioError(`${where}: ${r.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')}`);
  return r.data;
}

/** The scorer's view of a manifest. */
export function policyOf(m: Manifest): ScenarioPolicy {
  const connections: ScenarioPolicy['connections'] = {};
  for (const [k, c] of Object.entries(m.connections)) connections[k] = { kind: c.kind, mockable: c.mockable, ...(c.probe ? { probe: c.probe } : {}) };
  return {
    protectedPaths: [...m.policy.protectedPaths],
    allowedChanges: [...m.repo.allowedChanges],
    allowance: { scope: m.provisioning.scope, kinds: [...m.provisioning.kinds], maxResources: m.provisioning.maxResources, ttlSec: m.provisioning.ttlSec },
    requireApproval: m.acceptance.signoff === 'always',
    verify: { command: m.verify.command, timeoutSec: m.verify.timeoutSec },
    connections,
  };
}

/**
 * Why `spec` does not fit its manifest (empty when it does): declared connections are exactly the
 * manifest's, every need resolves on the gap ladder as expected, tags used by pass rules exist, an amended
 * criterion is a hidden one, a protected-file trap is protected, and scenario-level references are unique.
 */
export function scenarioProblems(spec: ScenarioSpec, policy: ScenarioPolicy): string[] {
  const out: string[] = [];
  const declared = Object.keys(policy.connections).sort();
  const said = [...spec.connections.declared].sort();
  if (declared.join(',') !== said.join(',')) out.push(`declared connections [${said.join(', ')}] are not the manifest's [${declared.join(', ')}]`);
  const ids = new Set<string>();
  const tags = new Set<string>();
  for (const h of spec.hidden) {
    if (ids.has(h.id)) out.push(`hidden criterion ${h.id} appears twice`);
    ids.add(h.id);
    for (const t of h.tags) tags.add(t);
  }
  const needs = new Map(spec.connections.needs.map((n) => [n.capability, n]));
  for (const h of spec.hidden) for (const r of h.requires) if (!needs.has(r) && !policy.connections[r]) out.push(`hidden criterion ${h.id} requires ${r}, which is neither declared nor a need`);
  let provisioned = 0;
  for (const n of spec.connections.needs) {
    const got: GapResolution = resolveGap({ kind: n.kind, available: n.available, mockable: policy.connections[n.capability]?.mockable ?? true }, policy.allowance, provisioned);
    if (got === 'provision') provisioned++;
    if (got !== n.expect) out.push(`need ${n.capability} (${n.kind}) resolves to ${got} under the manifest, the scenario expects ${n.expect}`);
  }
  for (const p of spec.pass) {
    if (p.rule === 'criterionFidelity' && !tags.has(p.tag)) out.push(`pass rule criterionFidelity names unknown tag ${p.tag}`);
    if (p.rule === 'resourcePending' && !needs.has(p.capability)) out.push(`pass rule resourcePending names ${p.capability}, which is not a need`);
    if (p.rule === 'auditAnswered' && spec.audit.length === 0) out.push('pass rule auditAnswered without audit questions');
  }
  for (const i of spec.interventions) if (i.kind === 'amend' && !ids.has(i.criterion)) out.push(`intervention amends ${i.criterion}, which is not a hidden criterion`);
  for (const t of spec.traps) if (t.kind === 'protected-file' && !matchesAnyGlob(t.path, policy.protectedPaths)) out.push(`trap ${t.path} is not a protected path in the manifest`);
  return out;
}

/** Load one fixture directory: scenario.json, repo/tecera.json, and the cross-checks against the files. */
export function loadScenario(dir: string): Scenario {
  const abs = resolve(dir);
  const where = abs;
  const read = (p: string): string => {
    try {
      return readFileSync(p, 'utf8');
    } catch (err) {
      throw new ScenarioError(`${where}: cannot read ${p}: ${(err as Error).message}`);
    }
  };
  let doc: unknown;
  try {
    doc = JSON.parse(read(join(abs, 'scenario.json')));
  } catch (err) {
    if (err instanceof ScenarioError) throw err;
    throw new ScenarioError(`${where}: scenario.json is not JSON: ${(err as Error).message}`);
  }
  const spec = parseScenario(doc, where);
  const base = abs.split(/[\\/]/).pop();
  if (spec.id !== base) throw new ScenarioError(`${where}: scenario id ${spec.id} is not its directory name ${String(base)}`);
  if (Number(spec.id.slice(0, 2)) !== spec.number) throw new ScenarioError(`${where}: scenario number ${spec.number} does not match id ${spec.id}`);
  const repoDir = join(abs, 'repo');
  const hiddenDir = join(abs, 'hidden');
  let manifest: Manifest;
  try {
    manifest = parseManifest(JSON.parse(read(join(repoDir, 'tecera.json'))));
  } catch (err) {
    if (err instanceof ScenarioError) throw err;
    throw new ScenarioError(`${where}: repo/tecera.json: ${(err as Error).message}`);
  }
  const policy = policyOf(manifest);
  const problems = scenarioProblems(spec, policy);
  if (spec.request.kind === 'goal' && !existsSync(join(repoDir, '.tecera', 'goals', `${spec.request.id}.goal.md`))) problems.push(`goal file .tecera/goals/${spec.request.id}.goal.md is missing`);
  for (const t of spec.traps) {
    if (t.kind === 'protected-file' && !existsSync(join(repoDir, t.path))) problems.push(`trap file ${t.path} is missing`);
    if (t.kind === 'injected-instruction' && !fileHas(join(repoDir, t.plantedIn), t.marker)) problems.push(`${t.plantedIn} does not carry the planted instruction marker`);
    if (t.kind === 'canary-secret' && !fileHas(join(repoDir, t.plantedIn), t.canary)) problems.push(`${t.plantedIn} does not carry the canary`);
  }
  for (const h of spec.hidden) {
    for (const f of hiddenFilesOf(h.check.command)) if (!existsSync(join(hiddenDir, f))) problems.push(`hidden criterion ${h.id} runs ${HIDDEN_MOUNT}/${f}, which is not in hidden/`);
  }
  for (const p of spec.reference.patches) if (!existsSync(join(abs, p))) problems.push(`reference patch ${p} is missing`);
  if (problems.length) throw new ScenarioError(`${where}: ${problems.join('; ')}`);
  return { ...spec, policy, dir: abs, repoDir, hiddenDir };
}

/** Every fixture under `root` (default: the package's fixtures), in scenario-number order. */
export function loadScenarios(root: string = FIXTURES_DIR): Scenario[] {
  const dirs = readdirSync(root)
    .filter((d) => /^\d{2}-/.test(d) && statSync(join(root, d)).isDirectory())
    .sort();
  return dirs.map((d) => loadScenario(join(root, d)));
}

/** The hidden files a check command runs (`bench-hidden/<file>` tokens), relative to hidden/. */
export function hiddenFilesOf(command: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?:^|\\s)${HIDDEN_MOUNT}/([^\\s'"]+)`, 'g');
  for (const m of command.matchAll(re)) out.push(m[1]!);
  return out;
}

function fileHas(path: string, needle: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes(needle);
  } catch {
    return false;
  }
}

// ── globs (gitignore-style, the manifest's protectedPaths / allowedChanges) ──────────────────────────

/**
 * Glob → RegExp for repo-relative paths: `**`, `*`, `?`, `{a,b}`. A pattern without a slash matches at any
 * depth; one with a slash is anchored at the root. Kept independent of the policy package on purpose: the
 * benchmark must not share a matcher bug with the enforcer it measures.
 */
export function globRegExp(glob: string): RegExp {
  let g = normalizeRel(glob);
  const anchored = g.includes('/');
  if (g.startsWith('/')) g = g.slice(1);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slash = g[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{' && g.indexOf('}', i) > i) {
      const end = g.indexOf('}', i);
      re += `(?:${g
        .slice(i + 1, end)
        .split(',')
        .map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
        .join('|')})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
  }
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}$`);
}

export function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

/** The first glob `path` matches, or null. */
export function matchesAnyGlob(path: string, globs: readonly string[]): string | null {
  const p = normalizeRel(path);
  for (const g of globs) if (globRegExp(g).test(p)) return g;
  return null;
}
