import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCelsius, toFahrenheit } from '../src/temperature.js';

test('freezing and boiling', () => {
  assert.equal(toFahrenheit(0), 32);
  assert.equal(toFahrenheit(100), 212);
});
test('to celsius', () => assert.equal(toCelsius(212), 100));
