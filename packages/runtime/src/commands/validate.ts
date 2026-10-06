import type { Json } from '@tecera/contracts';
import type { Command } from '../cli/context.js';
import { EXIT } from '../errors.js';
import { locateManifest, ManifestLoadError } from '../manifest/load.js';
import { hasErrors, validateBusinessCase } from '../manifest/validate.js';

/** `tecera validate [--strict]`: offline business-case checks; exit 2 with the list of issues. */
export const validateCommand: Command = async (c) => {
  let path: string;
  try {
    path = locateManifest(c.opts.cwd, c.args.values.manifest);
  } catch (e) {
    if (e instanceof ManifestLoadError) {
      c.out.error(`validate: ${e.message}`);
      c.out.set('issues', [{ level: 'error', where: 'tecera.json', message: e.message }]);
      return EXIT.invalid;
    }
    throw e;
  }
  const r = validateBusinessCase(path, { strict: !!c.args.bools.strict });
  c.out.set('issues', r.issues as unknown as Json);
  if (r.hash) c.out.set('manifestHash', r.hash);
  const errors = r.issues.filter((i) => i.level === 'error');
  const warnings = r.issues.filter((i) => i.level === 'warning');
  for (const i of errors) c.out.say(`${c.out.mark('missing')} ${i.where}: ${i.message}`);
  for (const i of warnings) c.out.info(`${c.out.mark('note')} ${i.where}: ${i.message}`);
  if (hasErrors(r)) {
    c.out.say(`invalid: ${errors.length} error(s), ${warnings.length} warning(s) → exit 2`);
    return EXIT.invalid;
  }
  c.out.say(`${c.out.mark('ok')} tecera.json valid · hash ${r.hash!.slice(0, 12)} · ${warnings.length} warning(s)`);
  return EXIT.ok;
};
