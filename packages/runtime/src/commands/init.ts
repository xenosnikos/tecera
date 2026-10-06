import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManifestError, manifestHash, parseManifest, type Json, type Manifest } from '@tecera/contracts';
import { parsePermissions, PermissionsError, DEFAULT_PERMISSIONS } from '@tecera/policy';
import { enabledHosts, installAdapter } from '../adapters/install.js';
import type { Command, CommandContext } from '../cli/context.js';
import { pad } from '../cli/io.js';
import { detect, type Detection } from '../detect.js';
import { CliError, EXIT, RUNTIME_VERSION } from '../errors.js';
import { computeLockFrom, LOCK_PATH, PERMISSIONS_PATH, renderLock } from '../manifest/load.js';
import { Runtime } from '../runtime.js';
import { RuntimeSecrets } from '../secrets.js';
import { walkFiles } from '../util/fs.js';
import { hex8 } from '../util/ids.js';
import { PlannedFs } from '../vfs.js';

/**
 * `tecera init [dir] [--sample] [--dry-run] [--interactive] [--profile p] [--writer provider/model]
 * [--reviewer provider/model]`: detect instead of asking, then stage every write in a PlannedFs — sample
 * copy, tecera.json from the template (kept if present), the .tecera/ template (existing files skipped),
 * adapter outputs (managed blocks, settings json-merge), .gitignore lines, tecera.lock — and apply them,
 * or with --dry-run print the plan and touch nothing. Finally the ledger is created with manifest.created.
 * Re-running is idempotent: unchanged content is not rewritten and events are not repeated.
 */

export const TEMPLATE_DIR = 'templates/business-case';
export const SAMPLE_DIR = 'samples/fix-failing-test';
const COPY_SKIP = new Set(['node_modules', 'ledger.sqlite', 'ledger.sqlite-wal', 'ledger.sqlite-shm', 'runs', '.git']);
export const GITIGNORE_LINES = ['.tecera/ledger.sqlite*', '.tecera/runs/'];

/**
 * Where `templates/` and `samples/` live. Installed: the package ships them in `<package>/assets/`
 * (copied there by the build, scripts/copy-assets.mjs). In the monorepo checkout: the nearest ancestor with
 * `templates/business-case/tecera.json`. `from` is this module's URL (injectable for tests).
 */
export function resolveAssetsRoot(explicit?: string, from: string = import.meta.url): string {
  if (explicit) return explicit;
  const here = dirname(fileURLToPath(from));
  for (const cand of [join(here, '..', '..', 'assets'), join(here, '..', 'assets')]) {
    if (existsSync(join(cand, TEMPLATE_DIR, 'tecera.json'))) return cand;
  }
  let dir = here;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, TEMPLATE_DIR, 'tecera.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new CliError(`cannot locate the tecera templates (${TEMPLATE_DIR}); reinstall @tecera/runtime`, EXIT.error);
}

function copyTree(fs: PlannedFs, srcDir: string, destPrefix: string, kind: string): { copied: number; skipped: number } {
  let copied = 0;
  let skipped = 0;
  for (const f of walkFiles(srcDir, COPY_SKIP)) {
    const dest = destPrefix ? `${destPrefix}/${f}` : f;
    if (fs.exists(dest)) {
      fs.skip(dest, kind, 'exists');
      skipped++;
      continue;
    }
    fs.write(dest, readFileSync(join(srcDir, f)), kind);
    copied++;
  }
  return { copied, skipped };
}

function seatFlag(v: string | undefined, flag: string): { provider: string; model: string } | null {
  if (v === undefined) return null;
  const m = /^([a-z0-9-]+)\/(.+)$/.exec(v);
  if (!m) throw new CliError(`--${flag} must be provider/model`, EXIT.usage);
  return { provider: m[1]!, model: m[2]! };
}

function buildManifest(c: CommandContext, assets: string, det: Detection): Record<string, unknown> {
  const doc = JSON.parse(readFileSync(join(assets, TEMPLATE_DIR, 'tecera.json'), 'utf8')) as Record<string, any>;
  doc.id = `bc_${hex8()}`;
  doc.name = det.name;
  doc.owner = det.owner;
  doc.repo.allowedChanges = ['src/**'];
  if (det.git.branch) doc.repo.base = det.git.branch;
  if (det.test.command) doc.verify.command = det.test.command;
  const profile = c.args.values.profile;
  if (profile !== undefined) {
    if (!['process', 'bwrap', 'docker'].includes(profile)) throw new CliError(`--profile must be process, bwrap or docker`, EXIT.usage);
    doc.sandbox.profile = profile;
    doc.sandbox.isolation = profile === 'process' ? 'node' : 'os';
  }
  const ensureProvider = (p: string): void => {
    if (!doc.providers[p]) doc.providers[p] = { auth: `env:${p.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY` };
  };
  const writer = seatFlag(c.args.values.writer, 'writer');
  if (writer) {
    ensureProvider(writer.provider);
    doc.seats.workers[0] = { ...doc.seats.workers[0], provider: writer.provider, model: writer.model };
  }
  const reviewer = seatFlag(c.args.values.reviewer, 'reviewer');
  if (reviewer) {
    ensureProvider(reviewer.provider);
    doc.seats.reviewer = { ...doc.seats.reviewer, provider: reviewer.provider, model: reviewer.model };
  }
  return doc;
}

function ensureGitignore(fs: PlannedFs): string[] {
  const cur = fs.read('.gitignore') ?? '';
  const have = new Set(cur.split('\n').map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length === 0) return [];
  const prefix = cur === '' ? '' : cur.endsWith('\n') ? cur : `${cur}\n`;
  fs.write('.gitignore', `${prefix}${have.has('# tecera') ? '' : '# tecera\n'}${missing.join('\n')}\n`, 'gitignore');
  return missing;
}

export const initCommand: Command = async (c) => {
  if (c.args.positionals.length > 1) throw new CliError('usage: tecera init [dir]', EXIT.usage);
  const target = resolve(c.opts.cwd, c.args.positionals[0] ?? '.');
  const dry = !!c.args.bools['dry-run'];
  const assets = resolveAssetsRoot(c.opts.assetsRoot);
  const env = c.opts.env;
  const fs = new PlannedFs(target);

  c.out.info(`tecera ${RUNTIME_VERSION} — init${dry ? ' (dry run: nothing is written)' : ''}`);
  if (c.args.bools.interactive) c.out.info('  note       --interactive accepted: the preferences wizard lands in Phase 2; defaults are written');

  if (c.args.bools.sample) {
    const r = copyTree(fs, join(assets, SAMPLE_DIR), '', 'sample');
    c.out.info(`  sample     fix-failing-test → ${r.copied} file(s)${r.skipped ? `, ${r.skipped} existing kept` : ''}`);
  }

  const det = detect(target, (p) => fs.read(p), (p) => fs.exists(p), env);
  c.out.info(
    `  repo       ${det.name}  ${det.git.repo ? `git · base ${det.git.branch ?? '(detached)'}@${det.git.head ?? '(no commits)'} · ${det.git.clean ? 'clean' : 'dirty'}` : 'not a git repository (continuing; commit gates need one)'}`,
  );
  c.out.info(`  tests      ${det.test.command ? `\`${det.test.command}\` (${det.test.source})` : `none detected (${det.test.source}); edit verify.command in tecera.json`}`);
  c.out.info(`  providers  ${Object.entries(det.keys).map(([k, v]) => `${k} ${v ? 'set' : 'missing'}`).join(' · ')}`);
  c.out.info(`  sandbox    ${Object.entries(det.sandbox).map(([k, v]) => `${k} ${v ? 'found' : 'not found'}`).join(' · ')} → profile "${c.args.values.profile ?? 'process'}"`);

  // manifest
  let manifest: Manifest;
  const existing = fs.read('tecera.json');
  try {
    if (existing !== undefined) {
      manifest = parseManifest(JSON.parse(existing));
      fs.skip('tecera.json', 'manifest', 'exists (kept)');
    } else {
      const doc = buildManifest(c, assets, det);
      manifest = parseManifest(doc);
      fs.write('tecera.json', `${JSON.stringify(doc, null, 2)}\n`, 'manifest');
    }
  } catch (e) {
    if (e instanceof ManifestError) {
      c.out.error(`init: ${e.message}`);
      c.out.set('issues', e.issues.map((i) => `${i.path}: ${i.message}`));
      return EXIT.invalid;
    }
    if (e instanceof SyntaxError) {
      c.out.error(`init: existing tecera.json is not valid JSON: ${e.message}`);
      return EXIT.invalid;
    }
    throw e;
  }
  const hash = manifestHash(manifest);

  // .tecera template
  const tpl = copyTree(fs, join(assets, TEMPLATE_DIR, '.tecera'), '.tecera', 'template');

  // permissions (staged or on disk)
  let permissions = DEFAULT_PERMISSIONS;
  const permText = fs.read(PERMISSIONS_PATH);
  if (permText !== undefined) {
    try {
      permissions = parsePermissions(JSON.parse(permText));
    } catch (e) {
      if (e instanceof PermissionsError || e instanceof SyntaxError) {
        c.out.error(`init: ${PERMISSIONS_PATH}: ${e.message}`);
        return EXIT.invalid;
      }
      throw e;
    }
  }

  // adapters
  const goals = fs.list('.tecera/goals').filter((f) => f.endsWith('.goal.md')).map((f) => f.slice('.tecera/goals/'.length, -'.goal.md'.length));
  const hosts = enabledHosts(fs, manifest.adapters);
  const adapterNotes: string[] = [];
  const securityNotes: string[] = [];
  // Redact rendered host files with the secrets this business case references (env is copied: init deletes nothing).
  const redactor = RuntimeSecrets.load(manifest, { ...env }, { cwd: target, deleteFromEnv: false }).redactor;
  for (const h of hosts) {
    for (const r of installAdapter(fs, h, { manifest, permissions, read: (p) => fs.read(p), goals, redactor })) {
      for (const k of r.conflicts) adapterNotes.push(`${r.target}: ${k}`);
      for (const k of r.securityConflicts) securityNotes.push(`${r.target}: ${k}`);
    }
  }

  const ignored = ensureGitignore(fs);

  if (!fs.exists(LOCK_PATH)) fs.write(LOCK_PATH, renderLock(computeLockFrom(fs, hash)), 'lock');
  else fs.skip(LOCK_PATH, 'lock', 'exists (kept; `tecera doctor --fix` re-pins)');

  const changes = fs.changes();
  c.out.set('ops', fs.ops as unknown as Json);
  c.out.set('dryRun', dry);
  c.out.set('manifestHash', hash);
  c.out.set('detection', det as unknown as Json);
  const ledgerRel = manifest.ledger.path;

  if (dry) {
    c.out.say(`would write ${changes.length} file(s):`);
    for (const o of fs.ops) c.out.say(`  ${pad(o.action, 7)}${pad(o.path, 40)}${o.kind}${o.note ? ` · ${o.note}` : ''}`);
    c.out.say(`  ${pad('ledger', 7)}${pad(ledgerRel, 40)}manifest.created sha256:${hash.slice(0, 12)}`);
    return EXIT.ok;
  }

  mkdirSync(target, { recursive: true });
  fs.apply();

  const describe = (p: string, label: string): string | null => {
    const o = changes.find((x) => x.path === p);
    return o ? `${p}${label}` : null;
  };
  const teceraCount = changes.filter((o) => o.path.startsWith('.tecera/')).length;
  const wrote = [
    describe('tecera.json', ''),
    teceraCount ? `.tecera/ (${teceraCount} file(s))` : null,
    describe('CLAUDE.md', ' [managed block]'),
    describe('AGENTS.md', ' [managed block]'),
    describe('.claude/settings.json', ' [merged]'),
    ignored.length ? `.gitignore [+${ignored.length}]` : null,
  ].filter(Boolean);
  c.out.info(`  wrote      ${wrote.length ? wrote.join('  ') : 'nothing (already initialised)'}`);
  if (tpl.skipped) c.out.info(`  kept       ${tpl.skipped} existing .tecera file(s)`);
  for (const n of adapterNotes) c.out.info(`  ${pad('conflict', 11)}${n}`);

  // ledger
  const rt = new Runtime({ cwd: target, env, now: c.opts.now, ids: c.opts.ids });
  try {
    const ledger = rt.ledger();
    let created = false;
    for await (const e of ledger.events({ kinds: ['manifest.created'] })) if ((e.payload as { manifestHash?: string }).manifestHash === hash) created = true;
    if (!created) await rt.append('manifest.created', { payload: { manifestHash: hash, id: manifest.id, name: manifest.name, owner: manifest.owner } });
    const adapterWrites = changes.filter((o) => o.kind.startsWith('adapter:')).map((o) => o.path);
    if (adapterWrites.length) await rt.append('adapters.installed', { payload: { hosts, files: adapterWrites, manifestHash: hash, securityConflicts: securityNotes } });
    let n = 0;
    for await (const _ of ledger.events()) n++;
    c.out.info(`  ledger     ${ledgerRel}  ${created ? 'exists' : 'manifest.created'} sha256:${hash.slice(0, 12)} · ${n} event(s)`);
  } finally {
    rt.close();
  }
  if (securityNotes.length) {
    for (const n of securityNotes) c.out.error(`security conflict  ${n}`);
    c.out.error("init: your host settings keep tecera's deny list or hooks out; fix them, then `tecera adapters install` → exit 3");
    return EXIT.notReady;
  }
  c.out.say(`Next: tecera doctor && tecera run ${goals[0] ?? '"<what should be true>"'}`);
  return EXIT.ok;
};
