import { closeSync, existsSync, openSync, readFileSync, readSync, constants as FS } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ManifestSchema, SECRET_PATTERNS, manifestHash, type Manifest } from '@tecera/contracts';
import { matchesAny, pathProblem } from '@tecera/policy';
import { PermissionsError } from '@tecera/policy';
import { AdapterError, readAdapter } from '../adapters/install.js';
import { reviewAllowlist } from '../env.js';
import { RUNTIME_VERSION } from '../errors.js';
import { GoalError, listGoalIds, loadGoal } from '../goals.js';
import { UnsafePathError, walkTree } from '../util/safefs.js';
import { satisfies } from '../util/semver.js';
import { PlannedFs } from '../vfs.js';
import { computeLock, loadPermissions, lockDrift, ManifestLoadError, readLock, readManifestDoc } from './load.js';

/**
 * `tecera validate`: offline checks of the business case. Schema (unknown fields rejected), an inline
 * secret scan over tecera.json and EVERY file under .tecera/ (names the file, line and kind, never the
 * value), the verify env allowlist against SAFE_ENV, glob sanity, seat/provider references, runtime range,
 * permissions, goals, adapters and lock drift. Any error → exit 2. `--strict` promotes warnings to errors.
 *
 * The scan streams files of any size (no size limit, binary content read as latin1), includes `runs/`,
 * never follows links (a symlink, special file or unreadable entry under .tecera/ is an error, not a skip)
 * and skips only the CONFIGURED ledger database and its SQLite sidecars (-wal, -shm, -journal) at their
 * exact paths, and only while each is a single-link regular file (they are written exclusively through the
 * redacting ledger). A ledger path that is a directory, a link or hard-linked is an error and is scanned.
 */

export interface Issue {
  level: 'error' | 'warning';
  where: string;
  message: string;
}

export interface ValidationReport {
  issues: Issue[];
  manifest?: Manifest;
  hash?: string;
  root: string;
}

/** SQLite sidecars of the ledger database (written by SQLite next to it). */
export const LEDGER_SIDECARS = ['', '-wal', '-shm', '-journal'] as const;

/**
 * Exact paths under `.tecera/` the secret scan may skip: the configured ledger file and its sidecars, when the
 * configured path lies under `.tecera/`. Nothing else, never a basename, never a directory.
 */
export function scanSkips(ledgerPath: unknown): Set<string> {
  const out = new Set<string>();
  const p = typeof ledgerPath === 'string' ? ledgerPath.replace(/^\.\//, '') : '.tecera/ledger.sqlite';
  if (!p.startsWith('.tecera/') || pathProblem(p)) return out;
  const rel = p.slice('.tecera/'.length);
  if (!rel || rel.endsWith('/')) return out;
  for (const s of LEDGER_SIDECARS) out.add(`${rel}${s}`);
  return out;
}
const CHUNK = 64 * 1024;
const MAX_LINE = 64 * 1024;

const patternIssues = (line: string, where: string, n: number): Issue[] =>
  SECRET_PATTERNS.filter((p) => new RegExp(p.re.source, p.re.flags.replace('g', '')).test(line)).map((p) => ({
    level: 'error' as const,
    where: `${where}:${n}`,
    message: `inline ${p.kind} credential pattern; use a reference (env:/file:/keychain:)`,
  }));

export function scanSecrets(text: string, where: string): Issue[] {
  const out: Issue[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) out.push(...patternIssues(lines[i]!, where, i + 1));
  return out;
}

/**
 * Stream a file of any size line by line (latin1, so binary content is scanned byte for byte). Very long
 * lines are scanned in overlapping windows so a match cannot hide across a window edge.
 */
export function scanFileSecrets(abs: string, where: string): Issue[] {
  const out: Issue[] = [];
  const fd = openSync(abs, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0));
  try {
    const buf = Buffer.alloc(CHUNK);
    let carry = '';
    let line = 1;
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, null);
      if (n === 0) break;
      carry += buf.subarray(0, n).toString('latin1');
      const parts = carry.split('\n');
      carry = parts.pop()!;
      for (const l of parts) out.push(...patternIssues(l, where, line++));
      if (carry.length > MAX_LINE) {
        out.push(...patternIssues(carry, where, line));
        carry = carry.slice(-1024);
      }
    }
    if (carry) out.push(...patternIssues(carry, where, line));
  } finally {
    closeSync(fd);
  }
  const seen = new Set<string>();
  return out.filter((i) => (seen.has(`${i.where}${i.message}`) ? false : (seen.add(`${i.where}${i.message}`), true)));
}

/** A representative concrete path for a glob, used to ask "would this glob's paths be protected?". */
function sampleOf(glob: string): string {
  return glob.replace(/\*\*\/?/g, 'a/').replace(/\*/g, 'x').replace(/\?/g, 'x').replace(/\{([^,}]*)[^}]*\}/g, '$1').replace(/\/$/, '/x');
}

export function validateBusinessCase(manifestPath: string, opts: { strict?: boolean } = {}): ValidationReport {
  const root = dirname(manifestPath);
  const issues: Issue[] = [];
  const err = (where: string, message: string): void => void issues.push({ level: 'error', where, message });
  const warn = (where: string, message: string): void => void issues.push({ level: opts.strict ? 'error' : 'warning', where, message });

  let doc: unknown;
  try {
    doc = readManifestDoc(manifestPath);
  } catch (e) {
    err('tecera.json', (e as Error).message);
    return { issues, root };
  }

  // secret scan: tecera.json and every file under .tecera/ (no links, no size limit, failures are errors)
  issues.push(...scanSecrets(readFileSync(manifestPath, 'utf8'), 'tecera.json'));
  const teceraDir = join(root, '.tecera');
  const ledgerDoc = doc && typeof doc === 'object' ? (doc as { ledger?: { path?: unknown } }).ledger : undefined;
  const tree = walkTree(teceraDir, scanSkips(ledgerDoc?.path ?? '.tecera/ledger.sqlite'));
  for (const x of tree.refusedSkips) err(`.tecera/${x.path}`, `ledger database path ${x.why}; refusing to exclude it from the secret scan (it is scanned)`);
  for (const l of tree.links) err(`.tecera/${l}`, 'symbolic link under .tecera/; tecera never follows links here (remove it)');
  for (const x of tree.special) err(`.tecera/${x}`, 'not a regular file; refusing to scan it');
  for (const x of tree.errors) err(`.tecera/${x.path}`, `cannot be read for the secret scan (${x.error})`);
  for (const f of tree.files) {
    try {
      issues.push(...scanFileSecrets(join(teceraDir, f), `.tecera/${f}`));
    } catch (e) {
      err(`.tecera/${f}`, `cannot be read for the secret scan (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
    }
  }

  // schema
  const r = ManifestSchema.safeParse(doc);
  if (!r.success) {
    for (const i of r.error.issues) err(`tecera.json${i.path.length ? `#${i.path.join('.')}` : ''}`, i.message);
    return { issues, root };
  }
  const m = r.data;
  const hash = manifestHash(m);

  // verify env: the repository requests, the supervisor grants SAFE_ENV only
  const envReview = reviewAllowlist(m.sandbox.envAllowlist);
  for (const u of envReview.unsafe) err('tecera.json#sandbox.envAllowlist', `${u.name} ${u.why}; it is never passed to the verify command — remove it`);
  for (const n of envReview.ignored) warn('tecera.json#sandbox.envAllowlist', `${n} is not on the supervisor's SAFE_ENV list and will not be passed`);

  // globs
  for (const [field, globs] of [['repo.allowedChanges', m.repo.allowedChanges], ['policy.protectedPaths', m.policy.protectedPaths]] as const) {
    for (const g of globs) {
      const bad = pathProblem(g);
      if (bad) err(`tecera.json#${field}`, `${g}: ${bad}`);
    }
  }
  if (m.repo.allowedChanges.length === 0) warn('tecera.json#repo.allowedChanges', 'empty: no file may change, every edit will be denied');
  for (const g of m.repo.allowedChanges) {
    const hit = matchesAny(sampleOf(g), m.policy.protectedPaths);
    if (hit) warn('tecera.json#repo.allowedChanges', `${g} falls under protected path ${hit}; edits there will be denied`);
  }

  // seats / providers
  if (m.seats.reflex.provider === 'rules' && Object.entries(m.reflexes).some(([k, v]) => k !== 'threshold' && v === 'model')) {
    warn('tecera.json#reflexes', 'a seam is set to "model" but seats.reflex.provider is "rules"; it will use the rule fallback');
  }
  for (const [name, p] of Object.entries(m.providers)) {
    const f = /^file:([^#]+)/.exec(p.auth);
    if (f && !existsSync(resolve(root, f[1]!))) warn(`tecera.json#providers.${name}.auth`, `referenced file ${f[1]} does not exist`);
  }

  // runtime range
  if (!satisfies(RUNTIME_VERSION, m.runtime.tecera)) err('tecera.json#runtime.tecera', `this runtime is ${RUNTIME_VERSION}, which does not satisfy "${m.runtime.tecera}"`);

  // permissions
  try {
    const perms = loadPermissions(root);
    if (!perms.present) warn('.tecera/protocols/permissions.json', 'missing; the shipped defaults apply');
    // D6: commits to the work branch are always allowed; the PR (open_pr, git_push) is the approval point;
    // nobody in Tecera merges.
    const p = perms.doc;
    if (p.requiresApproval.includes('commit') || p.never.includes('commit')) err('.tecera/protocols/permissions.json', `'commit' must be in always: commits go to the work branch tecera/<goal> without approval; the PR gate is the approval point (D6)`);
    for (const a of ['merge']) if (p.always.includes(a) || p.requiresApproval.includes(a)) err('.tecera/protocols/permissions.json', `'${a}' must be in never: Tecera never merges (D6)`);
    for (const a of ['open_pr', 'git_push']) if (p.always.includes(a)) err('.tecera/protocols/permissions.json', `'${a}' must require approval: the PR gate consumes a human grant (D6)`);
    if (!p.requiresApproval.includes('open_pr')) warn('.tecera/protocols/permissions.json', `'open_pr' is not listed in requiresApproval; the PR gate holds for a human approval anyway (D6)`);
  } catch (e) {
    if (e instanceof PermissionsError) err('.tecera/protocols/permissions.json', e.message);
    else throw e;
  }

  // goals
  for (const id of listGoalIds(root)) {
    try {
      loadGoal(root, id, m);
    } catch (e) {
      if (e instanceof GoalError) err(`.tecera/goals/${id}.goal.md`, e.message);
      else throw e;
    }
  }

  // adapters
  const fs = new PlannedFs(root);
  for (const [host, a] of Object.entries(m.adapters)) {
    if (!a.enabled) continue;
    try {
      readAdapter(fs, host);
    } catch (e) {
      if (e instanceof AdapterError) {
        if (/not found/.test(e.message)) warn(`.tecera/adapters/${host}`, `${host} is enabled but has no adapter.json`);
        else err(`.tecera/adapters/${host}/adapter.json`, e.message);
      } else if (e instanceof UnsafePathError) err(`.tecera/adapters/${host}/adapter.json`, e.message);
      else throw e;
    }
  }

  // lock drift
  try {
    const pinned = readLock(root);
    if (!pinned) warn('.tecera/tecera.lock', 'no lock file; run `tecera doctor --fix` to pin the current state');
    else for (const d of lockDrift(pinned, computeLock(root, hash))) err('.tecera/tecera.lock', `drift: ${d}`);
  } catch (e) {
    if (e instanceof ManifestLoadError || e instanceof UnsafePathError) err('.tecera/tecera.lock', e.message);
    else throw e;
  }

  return { issues, manifest: m, hash, root };
}

export function hasErrors(r: ValidationReport): boolean {
  return r.issues.some((i) => i.level === 'error');
}
