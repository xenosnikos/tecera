import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const bin = fileURLToPath(new URL('../bin/report.js', import.meta.url));
const run = (...a) => spawnSync(process.execPath, [bin, ...a], { encoding: 'utf8' });

test('the default text report is unchanged', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'North                120.50\nNorth, East           10.00\nRivers \"Delta\"         5.00\nSouth                 75.25\n');
});
