import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCelsius, toFahrenheit } from '../src/temperature.js';

test('conversions round-trip', () => {
  for (const c of [-40, 0, 37, 100]) assert.equal(toCelsius(toFahrenheit(c)), c);
  assert.equal(toFahrenheit(-40), -40);
});
