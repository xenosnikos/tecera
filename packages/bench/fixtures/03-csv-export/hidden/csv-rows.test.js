import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const bin = fileURLToPath(new URL('../bin/report.js', import.meta.url));
const run = (...a) => spawnSync(process.execPath, [bin, ...a], { encoding: 'utf8' });

test('--format csv has one row per region with two decimals', () => {
  const r = run('--format', 'csv');
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 5);
  assert.ok(lines.includes('North,120.50'));
  assert.ok(lines.includes('South,75.25'));
});
