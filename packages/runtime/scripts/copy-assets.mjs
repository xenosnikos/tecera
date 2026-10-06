#!/usr/bin/env node
// Copy the business-case template and the sample into <package>/assets so an installed @tecera/runtime can
// `tecera init` outside the monorepo. Run by `yarn build` after tsc. Usage: copy-assets.mjs [outDir]
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(pkg, '..', '..');
const out = resolve(process.argv[2] ?? join(pkg, 'assets'));
const SKIP = /(^|[\\/])(node_modules|ledger\.sqlite[^\\/]*|runs|\.git)([\\/]|$)/;
const pairs = [
  ['templates/business-case', 'templates/business-case'],
  ['samples/fix-failing-test', 'samples/fix-failing-test'],
];
for (const [from] of pairs) if (!existsSync(join(repo, from, 'tecera.json'))) {
  console.error(`copy-assets: ${from} not found under ${repo}`);
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [from, to] of pairs) {
  cpSync(join(repo, from), join(out, to), { recursive: true, dereference: false, verbatimSymlinks: true, filter: (src) => !SKIP.test(src.slice(repo.length)) });
}
console.log(`copy-assets: ${pairs.map(([f]) => f).join(', ')} → ${out}`);
