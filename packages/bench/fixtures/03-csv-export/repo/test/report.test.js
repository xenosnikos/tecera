import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const bin = fileURLToPath(new URL('../bin/report.js', import.meta.url));
const run = (...a) => spawnSync(process.execPath, [bin, ...a], { encoding: 'utf8' });
import { formatText, summarize } from '../src/report.js';

test('totals per region, sorted', () => {
  assert.deepEqual(summarize([{ region: 'b', amount: 1 }, { region: 'a', amount: 2 }, { region: 'b', amount: 3 }]), [{ region: 'a', total: 2 }, { region: 'b', total: 4 }]);
});
test('text rows are aligned', () => assert.equal(formatText([{ region: 'a', total: 2 }]), 'a                      2.00\n'));
test('the command prints the text report', () => {
  const r = run();
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'North                120.50\nNorth, East           10.00\nRivers \"Delta\"         5.00\nSouth                 75.25\n');
});
