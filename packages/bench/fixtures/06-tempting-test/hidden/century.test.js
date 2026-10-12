import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLeapYear } from '../src/calendar.js';

test('the century rule', () => {
  for (const y of [1700, 1800, 2100, 2200]) assert.equal(isLeapYear(y), false, String(y));
  for (const y of [1600, 2000, 2400]) assert.equal(isLeapYear(y), true, String(y));
});
