import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Binding, CapabilityRecord, Json, MockToolDeclaration, ProvisionedResource, WorkerStepRequest } from '@tecera/contracts';
import { assertionsOf, dependencyNames, entryPointsOf, isTestPath, packageBins, resourceEnvName, spawnedByTests, testedApiOf, type RepoFacts } from '@tecera/planner';

/**
 * What a worker step is told about the world beyond the repository (D9, D10, D12), and what the drafting seat
 * is told about the repository itself. Everything here is the host's own reading: the inventory, the resource
 * registry and the files of the leased worktree; nothing a model said.
 *
 * - repositoryFacts: package names package.json lists and the API the repository's own tests import, with the
 *   parameters the tested modules declare for it and the interfaces their comments document, the exact values
 *   the tests assert, and the repository's commands (package.json `bin`, files under bin/, files a test
 *   spawns) with the modules they import (the planner's prompts and its import, call-shape, value and
 *   envelope screens). Bounded walk, never follows a symlink, skips node_modules / .git / .tecera; a file it
 *   cannot read is skipped.
 * - capabilityAccess: one entry per capability a step may reach: a stand-in (fidelity mocked, its tool name
 *   and how to call it) or a provisioned resource (fidelity provisioned, its kind, locator, the variable the
 *   criteria read it from, and the tool that reaches it when there is one). A locator is never a credential
 *   (resourceProblem refused any that is before it was recorded).
 * - withStandIns: the request with each stand-in's tool added to the plan's, the step's and the capability
 *   set's tools, so every worker step can call it whatever tools the plan listed. A stand-in is simulated and
 *   in-memory (the broker still admits it against the inventory); no other tool is ever added.
 */

/** Node built-ins the worker and the criteria may rely on (nothing else is installed unless package.json lists it). */
export const RUNTIME_BUILTINS = ['node:sqlite', 'node:test', 'node:assert', 'node:child_process', 'node:fs', 'node:path', 'node:os'] as const;

const SKIP_DIRS = new Set(['node_modules', '.git', '.tecera', 'dist', 'build', 'coverage']);
const MAX_FILES = 4000;
const MAX_TEST_FILES = 64;
const MAX_TEST_BYTES = 64 * 1024;
const SOURCE = /\.[cm]?[jt]sx?$/;

/** Package names and tested API of the repository at `dir` (empty facts when nothing can be read). */
export function repositoryFacts(dir: string): RepoFacts {
  let dependencies: string[] = [];
  let bins: string[] = [];
  try {
    const pkg = readFileSync(join(dir, 'package.json'), 'utf8');
    dependencies = dependencyNames(pkg);
    bins = packageBins(pkg);
  } catch {
    dependencies = [];
  }
  const tests: Array<{ path: string; text: string }> = [];
  const binDir: string[] = [];
  let seen = 0;
  const walk = (abs: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++seen > MAX_FILES || tests.length >= MAX_TEST_FILES) return;
      const p = join(abs, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = relative(dir, p).split(sep).join('/');
      if (/^bin\/[^/]+$/.test(rel) && binDir.length < 8) binDir.push(rel);
      if (!SOURCE.test(rel) || !isTestPath(rel)) continue;
      try {
        if (statSync(p).size > MAX_TEST_BYTES) continue;
        tests.push({ path: rel, text: readFileSync(p, 'utf8') });
      } catch {
        // unreadable: skipped
      }
    }
  };
  walk(dir);
  /** A repository file's text, or null: every directory on the way is a real directory and the file a regular file (no symlink is followed). */
  const readRepoFile = (rel: string): string | null => {
    if (rel.startsWith('..') || rel.startsWith('/') || rel.split('/').some((seg) => SKIP_DIRS.has(seg))) return null;
    try {
      const segs = rel.split('/');
      if (!segs.slice(0, -1).every((_, n) => lstatSync(join(dir, ...segs.slice(0, n + 1))).isDirectory())) return null;
      const st = lstatSync(join(dir, rel));
      return st.isFile() && st.size <= MAX_TEST_BYTES ? readFileSync(join(dir, rel), 'utf8') : null;
    } catch {
      return null;
    }
  };
  // The modules the tests import, read for the parameters their exported functions declare.
  const sources: Array<{ path: string; text: string }> = [];
  for (const t of testedApiOf(tests)) {
    if (sources.length >= MAX_TEST_FILES || !SOURCE.test(t.module)) continue;
    const text = readRepoFile(t.module);
    if (text !== null) sources.push({ path: t.module, text });
  }
  const entries: Array<{ path: string; text: string }> = [];
  for (const p of [...new Set([...bins, ...binDir, ...spawnedByTests(tests)])].sort()) {
    const text = entries.length < 8 ? readRepoFile(p) : null;
    // a command is a script: a JavaScript file, or an extensionless file with a node shebang
    if (text !== null && (SOURCE.test(p) || /^#!.*\bnode\b/.test(text))) entries.push({ path: p, text });
  }
  return { dependencies, testedApi: testedApiOf(tests, sources), assertions: assertionsOf(tests), entryPoints: entryPointsOf(entries) };
}

const MESSAGE = /^(mail|email|smtp|message|messaging|sms|chat|webhook|notification|queue)$/i;

/** How to use one stand-in, for the worker. */
function standInNote(d: MockToolDeclaration): string {
  const how = MESSAGE.test(d.kind)
    ? `a simulated message sink: \`await ${d.tool}.send({ to, subject, text })\` records the message and answers {id, accepted: true, simulated: true}; \`await ${d.tool}.outbox()\` lists what was recorded`
    : `a simulated in-memory store: \`${d.tool}.get/set/delete/list\` for keys, \`${d.tool}.insert/select/update/remove\` for rows`;
  return `${how}. Nothing is delivered or stored for real. \`${d.tool}\` exists only in this step's sandbox session, for your own exploration and checks: never call it from the repository's code, where it is not defined when the criteria run (a ReferenceError). The code under test keeps its own seam (an injected sender or store, e.g. the argument the existing function already takes) so the criteria and tests can inject a fake. A goal resting on it is provisional, never achieved.`;
}

/** How to use one provisioned resource, for the worker. */
function resourceNote(r: ProvisionedResource, tool: boolean): string {
  const env = resourceEnvName(r.capability);
  const reach = tool ? ` The tool \`${r.capability}\` reaches it from this step.` : '';
  switch (r.kind) {
    case 'sqlite':
      return `a SQLite database file Tecera created. The code opens it with the built-in node:sqlite (\`new DatabaseSync(path)\`); no other database package is installed. The criteria get its path in process.env.${env}: code that takes a path (an option or that variable) is exercised against this file.${reach}`;
    case 'tmpdir':
      return `a directory Tecera created for this work; the criteria get its path in process.env.${env}.${reach}`;
    case 'http-stub':
      // The criteria run without network (their own network namespace): the stub's loopback URL is out of
      // their reach, so it is not handed to them and a criterion that requires it counts as mocked.
      return `a local HTTP stub Tecera started on this host's loopback.${reach} The criteria run without network and cannot reach it (they get no URL): the code under test takes its HTTP client or base URL through its own seam so the criteria can inject a fake, and a criterion that requires this capability proves it only as mocked (the goal is then provisional, never achieved).`;
    case 'git-remote':
      return 'a bare git repository the PR delivery pushes the work branch to; a step never pushes to it itself.';
    default:
      return `a ${r.kind} resource Tecera created; the criteria get its locator in process.env.${env}.${reach}`;
  }
}

export interface CapabilityAccessInput {
  /** Stand-ins served to the step. */
  mocks: readonly MockToolDeclaration[];
  /** Usable pending resources of the run (usableResources of the registry). */
  resources: readonly ProvisionedResource[];
  /** Capability ids the step's plan or contract names (a resource for another capability is not listed). */
  wanted: ReadonlySet<string>;
  /** Capability ids served by a brokered resource tool. */
  tools: ReadonlySet<string>;
  /** The run's inventory (a provisioned row names the resource that backs it). */
  inventory: readonly CapabilityRecord[];
}

/** The `capabilityAccess` binding value (empty when the step reaches no provisioned or mocked capability). */
export function capabilityAccess(i: CapabilityAccessInput): Json[] {
  const out: Json[] = [];
  for (const d of i.mocks) out.push({ capability: d.capability, kind: d.kind, fidelity: 'mocked', toolName: d.tool, methods: [...d.methods], notes: standInNote(d) });
  for (const r of i.resources) {
    if (!i.wanted.has(r.capability) || i.mocks.some((d) => d.capability === r.capability)) continue;
    const rec = i.inventory.find((x) => x.id === r.capability);
    if (rec?.state !== 'provisioned' || rec.resourceId !== r.id) continue;
    const tool = i.tools.has(r.capability);
    out.push({ capability: r.capability, kind: r.kind, fidelity: 'provisioned', locator: r.locator, env: resourceEnvName(r.capability), ...(tool ? { toolName: r.capability } : {}), notes: resourceNote(r, tool) });
  }
  return out;
}

/** The `runtimeEnvironment` binding value: what the code may import. */
export function runtimeEnvironment(facts: RepoFacts): Json {
  return {
    node: `Node ${process.versions.node.split('.')[0]} (ES modules)`,
    builtins: [...RUNTIME_BUILTINS],
    dependencies: [...facts.dependencies],
    notes: facts.dependencies.length ? 'Only these packages and the Node built-ins are installed; nothing can be installed during the work.' : 'No package is installed (package.json lists none): use the Node built-ins only; nothing can be installed during the work.',
  };
}

/** A trusted binding of host-derived data. */
export function hostBinding(src: string, value: Json): Binding {
  return { kind: 'value', value, provenance: { src, trust: 'trusted' } };
}

/** `req` with every stand-in tool added to the plan's, the step's and the capability set's tools. */
export function withStandIns(req: WorkerStepRequest, names: readonly string[]): WorkerStepRequest {
  if (!names.length) return req;
  const add = (xs: readonly string[]) => [...new Set([...xs, ...names])];
  return {
    ...req,
    plan: { ...req.plan, permissions: { ...req.plan.permissions, tools: add(req.plan.permissions.tools) } },
    step: req.step.tools === undefined ? req.step : { ...req.step, tools: add(req.step.tools) },
    capabilities: { ...req.capabilities, tools: add(req.capabilities.tools) },
  };
}
