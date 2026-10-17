import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const bin = fileURLToPath(new URL('../bin/report.js', import.meta.url));
const run = (...a) => spawnSync(process.execPath, [bin, ...a], { encoding: 'utf8' });

test('--format csv starts with a header row', () => {
  const r = run('--format', 'csv');
  assert.equal(r.status, 0, r.stderr);
  // The request leaves the header's case open: region,total and Region,Total are both the header row.
  assert.equal(r.stdout.split('\n')[0].toLowerCase(), 'region,total');
});
