import type { Json } from '@tecera/contracts';
import { AdapterError, checkAdapter, installAdapter } from '../adapters/install.js';
import type { RenderSource } from '../adapters/render.js';
import type { Command } from '../cli/context.js';
import { pad } from '../cli/io.js';
import { CliError, EXIT } from '../errors.js';
import { listGoalIds } from '../goals.js';
import { PlannedFs } from '../vfs.js';

/**
 * `tecera adapters install|upgrade|doctor <host> [--force] [--dry-run]`: render the host's files from
 * `.tecera/adapters/<host>/adapter.json`. install/upgrade write (upgrade implies --force for owned and
 * create-only files); doctor reports stale targets (exit 3). Errors in the adapter file or an unsafe
 * target (symlink, hard link) → exit 1. A security conflict (the user's settings keep tecera's deny list or
 * hooks out) is written as merged, reported, and exits 3: the host is not protected until it is resolved.
 */
export const adaptersCommand: Command = async (c) => {
  const [verb, host, ...rest] = c.args.positionals;
  if (!verb || !host || rest.length || !['install', 'upgrade', 'doctor'].includes(verb)) throw new CliError('usage: tecera adapters install|upgrade|doctor <host>', EXIT.usage);
  const rt = c.runtime();
  const fs = new PlannedFs(rt.root);
  const src: RenderSource = { manifest: rt.manifest, permissions: rt.permissions, read: (p) => fs.read(p), goals: listGoalIds(rt.root), redactor: rt.redactor };
  try {
    if (verb === 'doctor') {
      const rep = checkAdapter(fs, host, src);
      for (const r of rep) c.out.say(`${c.out.mark(r.ok ? 'ok' : 'note')} ${pad(r.target, 26)}${r.merge} · ${r.detail}`);
      c.out.set('targets', rep as unknown as Json);
      const stale = rep.filter((r) => !r.ok).length;
      const unprotected = rep.filter((r) => !r.ok && r.security).length;
      if (unprotected) c.out.say(`${unprotected} security target(s) do not carry tecera's deny list or hooks`);
      c.out.say(stale ? `${stale} stale → tecera adapters install ${host} → exit 3` : `${host} adapter current`);
      return stale ? EXIT.notReady : EXIT.ok;
    }
    const results = installAdapter(fs, host, src, { force: verb === 'upgrade' || !!c.args.bools.force });
    if (!c.args.bools['dry-run']) fs.apply();
    for (const r of results) {
      c.out.say(`${pad(r.status, 10)}${pad(r.target, 26)}${r.merge}`);
      for (const k of r.conflicts) c.out.info(`  conflict  ${k}`);
    }
    const written = results.filter((r) => r.status === 'written').map((r) => r.target);
    const security = results.flatMap((r) => r.securityConflicts.map((k) => `${r.target}: ${k}`));
    if (written.length && !c.args.bools['dry-run']) await rt.append('adapters.installed', { payload: { hosts: [host], files: written, manifestHash: rt.manifestHash, securityConflicts: security } });
    c.out.set('results', results as unknown as Json);
    if (security.length) {
      for (const k of security) c.out.error(`security conflict  ${k}`);
      c.out.error(`adapters ${verb} ${host}: tecera's deny list or hooks are not installed; fix the settings above → exit 3`);
      return EXIT.notReady;
    }
    return EXIT.ok;
  } catch (e) {
    if (e instanceof AdapterError) {
      c.out.error(`adapters ${verb} ${host}: ${e.message}`);
      return EXIT.error;
    }
    throw e;
  }
};
