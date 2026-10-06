import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ManifestError, manifestHash, parseManifest, type Manifest } from '@tecera/contracts';
import { DEFAULT_PERMISSIONS, PermissionsError, parsePermissions, type PermissionsDoc } from '@tecera/policy';
import { RUNTIME_VERSION } from '../errors.js';
import { findUp, sha256Bytes } from '../util/fs.js';
import { safeReadFile, safeWriteFile } from '../util/safefs.js';
import { PlannedFs } from '../vfs.js';

/**
 * Loading the business case: tecera.json is located upward from cwd (or given by --manifest), parsed by
 * contracts (unknown fields rejected, secrets as references only), permissions.json parsed by policy, and
 * `.tecera/tecera.lock` pins the manifest hash plus digests of skills, adapters and permissions so any
 * edit since the last `init`/`doctor --fix` is reported as drift.
 */

export const MANIFEST_FILE = 'tecera.json';
export const PERMISSIONS_PATH = '.tecera/protocols/permissions.json';
export const LOCK_PATH = '.tecera/tecera.lock';

export class ManifestLoadError extends Error {
  constructor(message: string, public readonly issues: string[] = [], public readonly path?: string) {
    super(message);
    this.name = 'ManifestLoadError';
  }
}

/** Absolute path of the manifest: explicit path, or the nearest tecera.json walking up from cwd. */
export function locateManifest(cwd: string, explicit?: string): string {
  if (explicit) {
    const p = resolve(cwd, explicit);
    if (!existsSync(p)) throw new ManifestLoadError(`manifest not found: ${explicit}`);
    return p;
  }
  const found = findUp(cwd, MANIFEST_FILE);
  if (!found) throw new ManifestLoadError(`no ${MANIFEST_FILE} found from ${cwd} upward; run \`tecera init\``);
  return found;
}

/** Read the raw JSON document. Throws ManifestLoadError on unreadable or non-JSON content. */
export function readManifestDoc(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ManifestLoadError(`cannot read ${path}: ${(err as Error).message}`, [], path);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ManifestLoadError(`${path} is not valid JSON: ${(err as Error).message}`, [], path);
  }
}

export interface LoadedManifest {
  path: string;
  root: string;
  manifest: Manifest;
  hash: string;
}

export function loadManifest(cwd: string, explicit?: string): LoadedManifest {
  const path = locateManifest(cwd, explicit);
  const doc = readManifestDoc(path);
  try {
    const manifest = parseManifest(doc);
    return { path, root: dirname(path), manifest, hash: manifestHash(manifest) };
  } catch (err) {
    if (err instanceof ManifestError) throw new ManifestLoadError(err.message, err.issues.map((i) => `${i.path || '<root>'}: ${i.message}`), path);
    throw err;
  }
}

/**
 * permissions.json is the authority. A missing file falls back to DEFAULT_PERMISSIONS (the most
 * restrictive shipped default); an invalid file throws (fail closed).
 */
export function loadPermissions(root: string): { doc: PermissionsDoc; present: boolean } {
  let buf: Buffer | undefined;
  try {
    buf = safeReadFile(root, PERMISSIONS_PATH);
  } catch (err) {
    throw new PermissionsError(`${PERMISSIONS_PATH}: ${(err as Error).message}`);
  }
  if (buf === undefined) return { doc: DEFAULT_PERMISSIONS, present: false };
  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString('utf8'));
  } catch (err) {
    throw new PermissionsError(`${PERMISSIONS_PATH} is not valid JSON: ${(err as Error).message}`);
  }
  return { doc: parsePermissions(raw), present: true };
}

// ---------- lock ----------

export interface LockFile {
  lockVersion: 1;
  tecera: string;
  manifestHash: string;
  permissions: string | null;
  skills: Record<string, string>;
  adapters: Record<string, string>;
  /** Goal files (their check commands run repository code). Absent in locks written before 2026-10-03. */
  goals?: Record<string, string>;
}

/** Anything that can list and read repo-relative files: the disk, or a PlannedFs with staged writes. */
export interface TreeReader {
  list(dir: string): string[];
  readBuffer(rel: string): Buffer | undefined;
}

function digestTree(tree: TreeReader, sub: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of tree.list(sub)) {
    const b = tree.readBuffer(f);
    if (b) out[f] = sha256Bytes(b);
  }
  return out;
}

export function computeLockFrom(tree: TreeReader, hash: string): LockFile {
  const perm = tree.readBuffer(PERMISSIONS_PATH);
  return {
    lockVersion: 1,
    tecera: RUNTIME_VERSION,
    manifestHash: hash,
    permissions: perm ? sha256Bytes(perm) : null,
    skills: digestTree(tree, '.tecera/skills'),
    adapters: digestTree(tree, '.tecera/adapters'),
    goals: digestTree(tree, '.tecera/goals'),
  };
}

export function computeLock(root: string, hash: string): LockFile {
  return computeLockFrom(new PlannedFs(root), hash);
}

export function readLock(root: string): LockFile | null {
  let buf: Buffer | undefined;
  try {
    buf = safeReadFile(root, LOCK_PATH);
  } catch (e) {
    throw new ManifestLoadError(`${LOCK_PATH}: ${(e as Error).message}`);
  }
  if (buf === undefined) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new ManifestLoadError(`${LOCK_PATH} is not valid JSON`);
  }
  const l = raw as Partial<LockFile>;
  if (l.lockVersion !== 1 || typeof l.manifestHash !== 'string' || typeof l.skills !== 'object' || typeof l.adapters !== 'object') {
    throw new ManifestLoadError(`${LOCK_PATH} has an unknown shape`);
  }
  return l as LockFile;
}

export function renderLock(lock: LockFile): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

export function writeLock(root: string, lock: LockFile): void {
  safeWriteFile(root, LOCK_PATH, renderLock(lock));
}

/** Human-readable differences between the pinned lock and the current tree. Empty means no drift. */
export function lockDrift(pinned: LockFile, current: LockFile): string[] {
  const out: string[] = [];
  if (pinned.manifestHash !== current.manifestHash) out.push(`tecera.json changed since lock (hash ${pinned.manifestHash.slice(0, 12)} → ${current.manifestHash.slice(0, 12)})`);
  if (pinned.permissions !== current.permissions) out.push(`${PERMISSIONS_PATH} changed since lock`);
  if (pinned.goals === undefined && current.goals !== undefined) out.push('goal files are not pinned by this lock (written by an older tecera); review .tecera/goals, then `tecera doctor --fix`');
  for (const section of ['skills', 'adapters', 'goals'] as const) {
    const a = pinned[section] ?? {};
    const b = current[section] ?? {};
    if (section === 'goals' && pinned.goals === undefined) continue;
    for (const k of Object.keys(a)) if (!(k in b)) out.push(`${k} removed since lock`);
    for (const k of Object.keys(b)) {
      if (!(k in a)) out.push(`${k} added since lock`);
      else if (a[k] !== b[k]) out.push(`${k} changed since lock`);
    }
  }
  return out;
}
