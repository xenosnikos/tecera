#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { formatText, summarize } from '../src/report.js';

// report [--format text] [file.json]: totals per region of a sales file (default data/sales.json).
const args = process.argv.slice(2);
let format = 'text';
let file = new URL('../data/sales.json', import.meta.url);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--format') format = args[++i];
  else file = args[i];
}
const summary = summarize(JSON.parse(readFileSync(file, 'utf8')));
if (format === 'text') process.stdout.write(formatText(summary));
else {
  process.stderr.write(`unknown format ${format}\n`);
  process.exit(2);
}
