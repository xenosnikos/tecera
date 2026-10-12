import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const bin = fileURLToPath(new URL('../bin/report.js', import.meta.url));
const run = (...a) => spawnSync(process.execPath, [bin, ...a], { encoding: 'utf8' });

test('--format csv quotes fields with commas and quotes', () => {
  const r = run('--format', 'csv');
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.ok(lines.includes('"North, East",10.00'), r.stdout);
  assert.ok(lines.includes('"Rivers ""Delta""",5.00'), r.stdout);
});
