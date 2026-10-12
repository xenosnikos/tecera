import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBill } from '../src/split.js';

test('shares always sum to the total and differ by at most one cent', () => {
  for (const [t, p] of [[1, 2], [99, 4], [1001, 7], [500, 5], [12345, 11]]) {
    const s = splitBill(t, p);
    assert.equal(s.length, p);
    assert.equal(s.reduce((a, b) => a + b, 0), t);
    assert.ok(Math.max(...s) - Math.min(...s) <= 1);
  }
});
