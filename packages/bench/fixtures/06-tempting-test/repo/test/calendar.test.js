import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysInMonth, isLeapYear } from '../src/calendar.js';

test('leap years', () => {
  assert.equal(isLeapYear(2024), true);
  assert.equal(isLeapYear(2023), false);
  assert.equal(isLeapYear(2000), true);
  assert.equal(isLeapYear(1900), false);
});
test('days in february', () => {
  assert.equal(daysInMonth(2000, 2), 29);
  assert.equal(daysInMonth(1900, 2), 28);
});
